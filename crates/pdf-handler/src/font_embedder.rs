use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use handler_common::HandlerError;
use lopdf::{dictionary, Dictionary, Document as LopdfDocument, Object, ObjectId, Stream};
use ttf_parser::{Face, GlyphId};

/// Bundled CJK fallback font (Noto Sans SC, static Regular TTF).
///
/// Do not replace this with the upstream variable file directly: its default
/// instance is Thin, and print renderers that do not apply `wght` variations
/// will silently produce much lighter output than browser HTML.
const BUNDLED_NOTO: &[u8] = include_bytes!("../assets/NotoSansSC-Regular.ttf");

/// Bundled monochrome emoji fallback. Noto Emoji uses ordinary outline glyphs,
/// so the in-process PDF engine can subset/embed it without relying on a
/// platform color-font implementation.
const BUNDLED_NOTO_EMOJI: &[u8] = include_bytes!("../assets/NotoEmoji-Regular.ttf");

fn read_font_file(path: &Path) -> Result<Vec<u8>, HandlerError> {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(HandlerError::IoError)?;
    if file.metadata().map_err(HandlerError::IoError)?.len() > LIMIT {
        return Err(HandlerError::OperationFailed(
            "font file exceeds 64 MiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(HandlerError::IoError)?;
    if bytes.len() as u64 > LIMIT {
        return Err(HandlerError::OperationFailed(
            "font file exceeds 64 MiB".into(),
        ));
    }
    Ok(bytes)
}

/// Return the bundled Noto Sans SC bytes for another in-process renderer.
///
/// Keeping one canonical embedded font asset avoids platform-dependent CJK
/// output when OfficeCLI's HTML print backend builds a PDF directly.
pub fn bundled_noto_sans_sc() -> &'static [u8] {
    BUNDLED_NOTO
}

pub fn bundled_noto_emoji() -> &'static [u8] {
    BUNDLED_NOTO_EMOJI
}

/// Return whether the first face in a font file covers every requested character.
///
/// Semantic exporters use this to select one optional system font that covers
/// mixed CJK, Latin and phonetic text before asking the PDF writer to subset it.
pub fn font_file_covers_chars(
    path: &Path,
    chars_needed: &HashSet<char>,
) -> Result<bool, HandlerError> {
    Ok(font_file_missing_chars(path, chars_needed)?.is_empty())
}

/// Return the requested characters that the first face in a font file cannot render.
pub fn font_file_missing_chars(
    path: &Path,
    chars_needed: &HashSet<char>,
) -> Result<HashSet<char>, HandlerError> {
    let font_bytes = read_font_file(path)?;
    font_bytes_missing_chars(&font_bytes, chars_needed).map_err(|error| {
        HandlerError::OperationFailed(format!(
            "failed to parse font file '{}': {error}",
            path.display()
        ))
    })
}

/// Return characters not covered by the bundled CJK fallback font.
pub fn bundled_font_missing_chars(
    chars_needed: &HashSet<char>,
) -> Result<HashSet<char>, HandlerError> {
    font_bytes_missing_chars(BUNDLED_NOTO, chars_needed)
        .map_err(|error| HandlerError::OperationFailed(format!("bundled font: {error}")))
}

/// Rasterize one complete line with deterministic bundled font fallback.
/// Missing glyphs, line breaks and oversized masks are errors, never blanks.
pub fn rasterize_bundled_text(text: &str, pixel_size: f32) -> Result<TextMask, HandlerError> {
    use crate::fonts::{bundled_font_runs, BuiltinFont};
    let fail = |message: &str| HandlerError::OperationFailed(message.to_string());
    if !pixel_size.is_finite() || !(1.0..=256.0).contains(&pixel_size) {
        return Err(fail(
            "fallback font size must be finite and between 1 and 256 pixels",
        ));
    }
    let runs = bundled_font_runs(text)?;
    let faces = [
        Face::parse(BUNDLED_NOTO, 0),
        Face::parse(BUNDLED_NOTO_EMOJI, 0),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| fail("invalid bundled font"))?;
    let slot = |font: BuiltinFont| match font {
        BuiltinFont::SansSc => 0,
        BuiltinFont::Emoji => 1,
    };
    let mut positioned = Vec::new();
    let mut fonts = Vec::new();
    let (mut pen_x, mut pen_y) = (0f32, 0f32);
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (0f32, 0f32, 0f32, 0f32);
    for run in runs {
        let face = rustybuzz::Face::from_slice(run.font.bytes(), 0)
            .ok_or_else(|| fail("invalid bundled font"))?;
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(run.text);
        buffer.guess_segment_properties();
        if buffer.direction() != rustybuzz::Direction::LeftToRight {
            return Err(fail(
                "fallback painter requires a paragraph renderer for RTL or vertical layout",
            ));
        }
        let shaped = rustybuzz::shape(&face, &[], buffer);
        if positioned.len() + shaped.len() > 16_384 {
            return Err(fail("fallback glyph count exceeds limit"));
        }
        let scale = pixel_size / faces[slot(run.font)].units_per_em() as f32;
        if !fonts.contains(run.font.identity()) {
            fonts.push(run.font.identity().clone());
        }
        for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
            if info.glyph_id == 0 {
                return Err(fail("font shaping produced a missing glyph"));
            }
            let id = GlyphId(
                info.glyph_id
                    .try_into()
                    .map_err(|_| fail("invalid shaped glyph"))?,
            );
            let x = pen_x + position.x_offset as f32 * scale;
            let y = pen_y + position.y_offset as f32 * scale;
            if let Some(bbox) = faces[slot(run.font)].glyph_bounding_box(id) {
                min_x = min_x.min(x + bbox.x_min as f32 * scale);
                max_x = max_x.max(x + bbox.x_max as f32 * scale);
                min_y = min_y.min(y + bbox.y_min as f32 * scale);
                max_y = max_y.max(y + bbox.y_max as f32 * scale);
                positioned.push((slot(run.font), id, x, y, scale));
            } else {
                let character = run
                    .text
                    .get(info.cluster as usize..)
                    .and_then(|value| value.chars().next());
                if character.is_some_and(|c| !c.is_whitespace() && !matches!(c as u32, 0x200C..=0x200D | 0xFE00..=0xFE0F | 0xE0020..=0xE007F | 0xE0100..=0xE01EF)) {
                    return Err(fail("font shaping produced a visible character without an outline"));
                }
            }
            pen_x += position.x_advance as f32 * scale;
            pen_y += position.y_advance as f32 * scale;
            max_x = max_x.max(pen_x);
        }
    }
    let (min_x, max_y) = (min_x.floor(), max_y.ceil());
    let width = (max_x.ceil() - min_x).max(1.0) as usize;
    let height = (max_y - min_y.floor()).max(1.0) as usize;
    if width > 8192
        || height > 8192
        || width
            .checked_mul(height)
            .is_none_or(|pixels| pixels > 4 * 1024 * 1024)
    {
        return Err(fail("fallback mask exceeds the 8192-pixel/4M-pixel limit"));
    }
    let mut glyphs = Vec::new();
    let mut edge_count = 0usize;
    for (font, id, x, y, scale) in positioned {
        let mut recorder = OutlineRecorder::default();
        if faces[font].outline_glyph(id, &mut recorder).is_none() {
            return Err(fail("bundled font glyph has no supported outline"));
        }
        edge_count += recorder.edges.len();
        if edge_count.saturating_mul(height) > 32_000_000 {
            return Err(fail("fallback outline work exceeds limit"));
        }
        glyphs.push((x, y, scale, recorder.edges));
    }
    let mut alpha = vec![0u8; width * height];
    for (origin_x, origin_y, scale, edges) in glyphs {
        for row in 0..height {
            let y_font = (max_y - (row as f32 + 0.5) - origin_y) / scale;
            let mut hits = Vec::new();
            for (start, end) in &edges {
                if (start.1 > y_font) == (end.1 > y_font) || (end.1 - start.1).abs() < f32::EPSILON
                {
                    continue;
                }
                let t = (y_font - start.1) / (end.1 - start.1);
                hits.push(origin_x - min_x + (start.0 + t * (end.0 - start.0)) * scale);
            }
            hits.sort_by(|left, right| left.total_cmp(right));
            for pair in hits.chunks_exact(2) {
                let from = pair[0].floor().max(0.0) as usize;
                let to = pair[1].ceil().max(0.0) as usize;
                for column in from..to.min(width) {
                    alpha[row * width + column] = 255;
                }
            }
        }
    }
    Ok(TextMask {
        width,
        height,
        alpha,
        fonts,
    })
}

#[derive(Debug, Clone)]
pub struct TextMask {
    pub width: usize,
    pub height: usize,
    pub alpha: Vec<u8>,
    pub fonts: Vec<crate::fonts::FontIdentity>,
}

#[derive(Default)]
struct OutlineRecorder {
    pen: (f32, f32),
    start: (f32, f32),
    edges: Vec<((f32, f32), (f32, f32))>,
}

impl OutlineRecorder {
    fn edge_to(&mut self, x: f32, y: f32) {
        self.edges.push((self.pen, (x, y)));
        self.pen = (x, y);
    }
}

impl ttf_parser::OutlineBuilder for OutlineRecorder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.pen = (x, y);
        self.start = (x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.edge_to(x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x0, y0) = self.pen;
        for step in 1..=4 {
            let t = step as f32 / 4.0;
            let u = 1.0 - t;
            self.edge_to(
                u * u * x0 + 2.0 * u * t * x1 + t * t * x,
                u * u * y0 + 2.0 * u * t * y1 + t * t * y,
            );
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x0, y0) = self.pen;
        for step in 1..=6 {
            let t = step as f32 / 6.0;
            let u = 1.0 - t;
            self.edge_to(
                u * u * u * x0 + 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t * x,
                u * u * u * y0 + 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t * y,
            );
        }
    }

    fn close(&mut self) {
        let start = self.start;
        self.edge_to(start.0, start.1);
    }
}

/// Return characters absent from a parsed font's Unicode character map.
pub fn font_bytes_missing_chars(
    font_bytes: &[u8],
    chars_needed: &HashSet<char>,
) -> Result<HashSet<char>, String> {
    let face = Face::parse(font_bytes, 0).map_err(|error| format!("parse failed: {error:?}"))?;
    Ok(chars_needed
        .iter()
        .copied()
        .filter(|character| face.glyph_index(*character).is_none())
        .collect())
}

/// Ensure a CJK-capable font is embedded on the given page so the requested
/// characters can be rendered.
///
/// * If `user_font_file` is set (`--prop fontFile=...`), that TTF is embedded.
/// * Otherwise, characters that no existing page font can render trigger
///   embedding of the bundled NotoSansSC.
///
/// Returns the PDF resource name of the newly embedded font, or `None` if no
/// embedding was needed.
pub fn ensure_cjk_font_for_chars(
    doc: &mut LopdfDocument,
    page_num: usize,
    chars_needed: &HashSet<char>,
    preferred_name: Option<&str>,
    user_font_file: Option<&str>,
    force_embed: bool,
) -> Result<Option<String>, HandlerError> {
    let page_id = *doc
        .get_pages()
        .get(&(page_num as u32))
        .ok_or_else(|| HandlerError::PathNotFound(format!("page {}", page_num)))?;
    ensure_font_for_chars(
        doc,
        page_id,
        chars_needed,
        preferred_name,
        user_font_file,
        force_embed,
        FontUsage::Visible,
    )
}

/// Embed a font for a rendering-mode-3 text layer over an existing page image.
/// Unsupported visible glyphs use .notdef outlines, but retain distinct Unicode
/// CIDs. This font must never be selected for visible text rendering.
pub fn ensure_invisible_text_font(
    doc: &mut LopdfDocument,
    page_id: ObjectId,
    chars_needed: &HashSet<char>,
) -> Result<Option<String>, HandlerError> {
    ensure_font_for_chars(
        doc,
        page_id,
        chars_needed,
        Some("HCDText"),
        None,
        true,
        FontUsage::Invisible,
    )
}

#[derive(Clone, Copy)]
enum FontUsage {
    Visible,
    Emoji,
    Invisible,
}

/// Fill only gaps in the existing page fonts. Coverage is checked before
/// mutating resources, so an unsupported scalar cannot produce a partial edit.
pub fn ensure_text_fallback_fonts(
    doc: &mut LopdfDocument,
    page_num: usize,
    text: &str,
) -> Result<(), HandlerError> {
    let page_id = *doc
        .get_pages()
        .get(&(page_num as u32))
        .ok_or_else(|| HandlerError::PathNotFound(format!("page {page_num}")))?;
    let mut missing = Vec::new();
    crate::content_stream::pick_fonts_for_text(doc, page_id, None, text, &mut missing)?;
    if missing.is_empty() {
        return Ok(());
    }
    let sans = Face::parse(BUNDLED_NOTO, 0).map_err(|error| {
        HandlerError::OperationFailed(format!("invalid bundled font: {error:?}"))
    })?;
    let emoji = Face::parse(BUNDLED_NOTO_EMOJI, 0).map_err(|error| {
        HandlerError::OperationFailed(format!("invalid bundled emoji font: {error:?}"))
    })?;
    let mut sans_chars = HashSet::new();
    let mut emoji_chars = HashSet::new();
    for character in missing {
        if sans.glyph_index(character).is_some() {
            sans_chars.insert(character);
        } else if emoji.glyph_index(character).is_some() {
            emoji_chars.insert(character);
        } else {
            return Err(HandlerError::OperationFailed(format!(
                "no bundled PDF fallback glyph for U+{:04X}",
                character as u32
            )));
        }
    }
    for (characters, usage) in [
        (&sans_chars, FontUsage::Visible),
        (&emoji_chars, FontUsage::Emoji),
    ] {
        if !characters.is_empty() {
            ensure_font_for_chars(doc, page_id, characters, None, None, true, usage)?;
        }
    }
    Ok(())
}

fn ensure_font_for_chars(
    doc: &mut LopdfDocument,
    page_id: ObjectId,
    chars_needed: &HashSet<char>,
    preferred_name: Option<&str>,
    user_font_file: Option<&str>,
    force_embed: bool,
    usage: FontUsage,
) -> Result<Option<String>, HandlerError> {
    let invisible = matches!(usage, FontUsage::Invisible);
    let custom_bytes = user_font_file
        .map(|path| read_font_file(Path::new(path)))
        .transpose()?;
    let font_bytes = custom_bytes
        .as_deref()
        .unwrap_or(if matches!(usage, FontUsage::Emoji) {
            BUNDLED_NOTO_EMOJI
        } else {
            BUNDLED_NOTO
        });
    let identity = if custom_bytes.is_some() {
        crate::fonts::font_identity(font_bytes, 0)?
    } else {
        crate::fonts::bundled_font_catalog()[usize::from(matches!(usage, FontUsage::Emoji))].clone()
    };
    // A semantic export supplies the same complete character set for the first
    // text block on every page. Reuse an already embedded Type0 font object
    // instead of subsetting and embedding the same font once per page.
    if force_embed {
        if let Some(font_id) = find_embedded_font_covering_chars(
            doc,
            chars_needed,
            &identity.sha256,
            identity.face_index,
            invisible,
        ) {
            let page_font_name = choose_pdf_font_name(doc, page_id, preferred_name)?;
            register_font_on_page(doc, page_id, &page_font_name, font_id)?;
            return Ok(Some(page_font_name));
        }
    }

    // Determine which chars actually need embedding.
    let chars_to_embed: HashSet<char> = if user_font_file.is_some() || force_embed {
        chars_needed.clone()
    } else {
        let already_supported = collect_supported_chars(doc, page_id, chars_needed);
        chars_needed
            .iter()
            .copied()
            .filter(|ch| !already_supported.contains(ch))
            .collect()
    };

    if chars_to_embed.is_empty() {
        return Ok(None);
    }

    let face = Face::parse(font_bytes, 0)
        .map_err(|e| HandlerError::OperationFailed(format!("failed to parse font: {:?}", e)))?;

    let mut char_to_gid: Vec<(char, u16)> = Vec::new();
    let mut missing_in_font: Vec<char> = Vec::new();
    for &ch in &chars_to_embed {
        if let Some(GlyphId(gid)) = face.glyph_index(ch) {
            char_to_gid.push((ch, gid));
        } else if invisible {
            char_to_gid.push((ch, 0));
        } else {
            missing_in_font.push(ch);
        }
    }
    if char_to_gid.is_empty() {
        return Err(HandlerError::OperationFailed(format!(
            "font does not contain glyphs for: {}",
            missing_in_font.iter().collect::<String>()
        )));
    }

    let unique_gids: Vec<u16> = {
        let mut set: HashSet<u16> = HashSet::new();
        let mut out = Vec::new();
        for (_, g) in &char_to_gid {
            if set.insert(*g) {
                out.push(*g);
            }
        }
        out
    };

    let remapper = subsetter::GlyphRemapper::new_from_glyphs_sorted(&unique_gids);
    let subset_bytes = subsetter::subset(font_bytes, 0, &remapper)
        .map_err(|e| HandlerError::OperationFailed(format!("failed to subset font: {:?}", e)))?;

    let units_per_em = face.units_per_em() as f32;
    if units_per_em <= 0.0 {
        return Err(HandlerError::OperationFailed(
            "font has invalid units_per_em".into(),
        ));
    }
    let scale = 1000.0 / units_per_em;

    // CID represents a Unicode scalar, not a glyph. Several scalars can share
    // one outline; mapping that GID to their concatenation corrupts extraction.
    if char_to_gid.len() > u16::MAX as usize {
        return Err(HandlerError::OperationFailed(
            "font subset exceeds the 65535-character CID limit".into(),
        ));
    }
    char_to_gid.sort_by_key(|(character, _)| *character);
    let mut cid_to_unicode = BTreeMap::new();
    let mut cid_to_gid = vec![0u8, 0u8]; // CID 0 is .notdef.
    let mut widths = vec![0i64];
    for (index, (character, old_gid)) in char_to_gid.iter().enumerate() {
        let cid = (index + 1) as u16;
        let gid = remapper.get(*old_gid).ok_or_else(|| {
            HandlerError::OperationFailed("missing subset glyph remapping".into())
        })?;
        cid_to_unicode.insert(cid, *character);
        cid_to_gid.extend_from_slice(&gid.to_be_bytes());
        let width = face.glyph_hor_advance(GlyphId(*old_gid)).unwrap_or(0) as f32;
        widths.push((width * scale).round() as i64);
    }

    let bbox = face.global_bounding_box();
    let ascender = (face.ascender() as f32 * scale).round() as i64;
    let descender = (face.descender() as f32 * scale).round() as i64;
    let cap_height = face
        .capital_height()
        .map(|h| (h as f32 * scale).round() as i64)
        .unwrap_or(ascender);
    let italic_angle: f32 = face.italic_angle().unwrap_or(0.0);

    let pdf_font_name = choose_pdf_font_name(doc, page_id, preferred_name)?;
    if face.tables().glyf.is_none() {
        return Err(HandlerError::OperationFailed(
            "font embedding requires TrueType glyf outlines".into(),
        ));
    }
    let source_name = face
        .names()
        .into_iter()
        .filter(|name| name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|name| name.to_string())
        .unwrap_or_else(|| "OfficeCLIFont".into());
    let source_name: String = source_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(48)
        .collect();
    let postscript_name = format!(
        "{}+{}",
        subset_prefix(),
        if source_name.is_empty() {
            "OfficeCLIFont"
        } else {
            &source_name
        }
    );

    let length1 = subset_bytes.len() as i64;
    let mut fontfile_stream = Stream::new(
        dictionary! { "Length1" => Object::Integer(length1) },
        subset_bytes,
    );
    let _ = fontfile_stream.compress();
    let fontfile_id = doc.add_object(Object::Stream(fontfile_stream));

    let fd_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"FontDescriptor".to_vec()),
        "FontName" => Object::Name(postscript_name.clone().into_bytes()),
        "Flags" => Object::Integer(4),
        "FontBBox" => Object::Array(vec![
            Object::Integer((bbox.x_min as f32 * scale) as i64),
            Object::Integer((bbox.y_min as f32 * scale) as i64),
            Object::Integer((bbox.x_max as f32 * scale) as i64),
            Object::Integer((bbox.y_max as f32 * scale) as i64),
        ]),
        "ItalicAngle" => Object::Real(italic_angle),
        "Ascent" => Object::Integer(ascender),
        "Descent" => Object::Integer(descender),
        "CapHeight" => Object::Integer(cap_height),
        "StemV" => Object::Integer(80),
        "FontFile2" => Object::Reference(fontfile_id),
    });

    // W array: single contiguous run starting at CID 0.
    let inner: Vec<Object> = widths.iter().map(|&w| Object::Integer(w)).collect();
    let w_array = vec![Object::Integer(0), Object::Array(inner)];

    let mut cid_map_stream = Stream::new(Dictionary::new(), cid_to_gid);
    let _ = cid_map_stream.compress();
    let cid_map_id = doc.add_object(Object::Stream(cid_map_stream));
    let cidfont_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"CIDFontType2".to_vec()),
        "BaseFont" => Object::Name(postscript_name.clone().into_bytes()),
        "CIDSystemInfo" => Object::Dictionary(dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => Object::Integer(0),
        }),
        "FontDescriptor" => Object::Reference(fd_id),
        "CIDToGIDMap" => Object::Reference(cid_map_id),
        "W" => Object::Array(w_array),
    });

    let tounicode_bytes = build_tounicode_cmap(&cid_to_unicode);
    let mut tu_stream = Stream::new(Dictionary::new(), tounicode_bytes);
    let _ = tu_stream.compress();
    let tu_id = doc.add_object(Object::Stream(tu_stream));

    let type0_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"Type0".to_vec()),
        "BaseFont" => Object::Name(postscript_name.into_bytes()),
        "OfficeCLISourceFontSHA256" => Object::string_literal(identity.sha256),
        "OfficeCLISourceFontFaceIndex" => Object::Integer(i64::from(identity.face_index)),
        "OfficeCLICidMappingVersion" => Object::Integer(1),
        "OfficeCLIInvisibleTextFont" => Object::Boolean(invisible),
        "Encoding" => Object::Name(b"Identity-H".to_vec()),
        "DescendantFonts" => Object::Array(vec![Object::Reference(cidfont_id)]),
        "ToUnicode" => Object::Reference(tu_id),
    });

    register_font_on_page(doc, page_id, &pdf_font_name, type0_id)?;

    Ok(Some(pdf_font_name))
}

fn find_embedded_font_covering_chars(
    doc: &LopdfDocument,
    chars_needed: &HashSet<char>,
    source_hash: &str,
    face_index: u32,
    invisible: bool,
) -> Option<ObjectId> {
    doc.objects.iter().find_map(|(object_id, object)| {
        let dictionary = object.as_dict().ok()?;
        if is_invisible_text_font(dictionary) != invisible {
            return None;
        }
        if dictionary
            .get(b"OfficeCLICidMappingVersion")
            .ok()?
            .as_i64()
            .ok()?
            != 1
        {
            return None;
        }
        if dictionary
            .get(b"OfficeCLISourceFontSHA256")
            .ok()?
            .as_str()
            .ok()?
            != source_hash.as_bytes()
            || dictionary
                .get(b"OfficeCLISourceFontFaceIndex")
                .ok()?
                .as_i64()
                .ok()?
                != i64::from(face_index)
        {
            return None;
        }
        if dictionary
            .get(b"Subtype")
            .ok()
            .and_then(|value| value.as_name().ok())
            != Some(b"Type0".as_slice())
        {
            return None;
        }
        let to_unicode_id = dictionary.get(b"ToUnicode").ok()?.as_reference().ok()?;
        let stream = doc.get_object(to_unicode_id).ok()?.as_stream().ok()?;
        let bytes = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        let content = String::from_utf8_lossy(&bytes);
        let cmap = crate::content_stream::parse_to_unicode_cmap(&content);
        let covered: HashSet<char> = cmap
            .values()
            .filter_map(|value| crate::content_stream::single_unicode_scalar(value))
            .collect();
        chars_needed
            .iter()
            .all(|character| covered.contains(character))
            .then_some(*object_id)
    })
}

pub(crate) fn is_invisible_text_font(font: &Dictionary) -> bool {
    font.get(b"OfficeCLIInvisibleTextFont")
        .ok()
        .and_then(|value| value.as_bool().ok())
        .unwrap_or(false)
}

/// Inspect each page font and collect which of `chars_needed` it can already render.
fn collect_supported_chars(
    doc: &LopdfDocument,
    page_id: ObjectId,
    chars_needed: &HashSet<char>,
) -> HashSet<char> {
    let mut supported = HashSet::new();
    let Ok(fonts) = doc.get_page_fonts(page_id) else {
        return supported;
    };

    // Gather original text characters for each font
    let mut font_original_chars: HashMap<String, HashSet<char>> = HashMap::new();
    if let Ok(content_bytes) = doc.get_page_content(page_id) {
        if let Ok(parsed) =
            crate::content_stream::parse_page_content_stream(&content_bytes, page_id, doc)
        {
            for block in &parsed.text_blocks {
                if let Some(ref f_name) = block.style.font_name {
                    let set = font_original_chars.entry(f_name.clone()).or_default();
                    for ch in block.text.chars() {
                        set.insert(ch);
                    }
                }
            }
        }
    }

    for (name, font) in fonts {
        if is_invisible_text_font(font) {
            continue;
        }
        let font_name = String::from_utf8_lossy(&name).to_string();
        let is_subsetted = font
            .get(b"BaseFont")
            .ok()
            .and_then(|v| v.as_name_str().ok())
            .map(|s| s.contains('+'))
            .unwrap_or(false);

        // Try custom ToUnicode CMap first
        let mut custom_cmap: Option<HashMap<u32, String>> = None;
        if let Ok(to_unicode) = font.get(b"ToUnicode") {
            if let Ok(ref_id) = to_unicode.as_reference() {
                if let Ok(Object::Stream(stream)) = doc.get_object(ref_id) {
                    let bytes = stream
                        .decompressed_content()
                        .unwrap_or_else(|_| stream.content.clone());
                    let content = String::from_utf8_lossy(&bytes);
                    let cmap = crate::content_stream::parse_to_unicode_cmap(&content);
                    if !cmap.is_empty() {
                        custom_cmap = Some(cmap);
                    }
                }
            }
        }

        let orig_chars = font_original_chars.get(&font_name);

        for &ch in chars_needed {
            if supported.contains(&ch) {
                continue;
            }

            // 1. Check custom ToUnicode CMap
            if let Some(ref cmap) = custom_cmap {
                if cmap
                    .values()
                    .any(|value| crate::content_stream::single_unicode_scalar(value) == Some(ch))
                {
                    supported.insert(ch);
                }
                continue;
            }

            // 2. If subsetted, check if the character was originally used on the page by this font
            if is_subsetted {
                if let Some(set) = orig_chars {
                    if set.contains(&ch) {
                        supported.insert(ch);
                    }
                }
            } else {
                // 3. If not subsetted, check standard encoding
                if font.type_is(b"Font") {
                    if let Ok(encoding) = font.get_font_encoding(doc) {
                        if char_renders_via_encoding(&encoding, ch) {
                            supported.insert(ch);
                        }
                    }
                }
            }
        }
    }
    supported
}

fn char_renders_via_encoding(encoding: &lopdf::Encoding, ch: char) -> bool {
    if let lopdf::Encoding::UnicodeMapEncoding(cmap) = encoding {
        for cid in 0u16..=65535 {
            if let Some(uni) = cmap.get(cid) {
                if uni.len() == 1 && uni[0] as u32 == ch as u32 {
                    return true;
                }
                if !uni.is_empty() {
                    let s = String::from_utf16_lossy(&uni);
                    if s.chars().any(|c| c == ch) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
    let s = ch.to_string();
    let bytes = LopdfDocument::encode_text(encoding, &s);
    if bytes.is_empty() {
        return false;
    }
    encoding
        .bytes_to_string(&bytes)
        .map(|d| d == s)
        .unwrap_or(false)
}

/// Copy the nearest inherited resource dictionary without mutating its owner.
fn page_resources_copy(doc: &LopdfDocument, page_id: ObjectId) -> Result<Dictionary, HandlerError> {
    let mut current = page_id;
    let mut seen = HashSet::new();
    while seen.insert(current) {
        let page = doc.get_dictionary(current).map_err(|error| {
            HandlerError::OperationFailed(format!("invalid PDF page resources: {error}"))
        })?;
        if let Ok(value) = page.get(b"Resources") {
            let (_, value) = doc.dereference(value).map_err(|error| {
                HandlerError::OperationFailed(format!("invalid PDF resource reference: {error}"))
            })?;
            if !matches!(value, Object::Null) {
                return value.as_dict().cloned().map_err(|error| {
                    HandlerError::OperationFailed(format!("invalid PDF resources: {error}"))
                });
            }
        }
        match page.get(b"Parent") {
            Ok(parent) => {
                current = parent.as_reference().map_err(|error| {
                    HandlerError::OperationFailed(format!("invalid PDF resource parent: {error}"))
                })?
            }
            Err(_) => return Ok(Dictionary::new()),
        }
    }
    Err(HandlerError::OperationFailed(
        "cyclic PDF resource inheritance".into(),
    ))
}

fn font_resources_copy(
    doc: &LopdfDocument,
    resources: &Dictionary,
) -> Result<Dictionary, HandlerError> {
    let Ok(value) = resources.get(b"Font") else {
        return Ok(Dictionary::new());
    };
    let (_, value) = doc.dereference(value).map_err(|error| {
        HandlerError::OperationFailed(format!("invalid PDF Font resource reference: {error}"))
    })?;
    if matches!(value, Object::Null) {
        return Ok(Dictionary::new());
    }
    value.as_dict().cloned().map_err(|error| {
        HandlerError::OperationFailed(format!("invalid PDF Font resources: {error}"))
    })
}

/// Pick a page-local resource name, including names in indirect font maps.
fn choose_pdf_font_name(
    doc: &LopdfDocument,
    page_id: ObjectId,
    preferred: Option<&str>,
) -> Result<String, HandlerError> {
    let resources = page_resources_copy(doc, page_id)?;
    let existing: HashSet<String> = font_resources_copy(doc, &resources)?
        .iter()
        .map(|(name, _)| String::from_utf8_lossy(name).into_owned())
        .collect();
    if existing.len() > 4096 {
        return Err(HandlerError::OperationFailed(
            "PDF page exceeds 4096 font resources".into(),
        ));
    }

    if let Some(name) = preferred {
        if !existing.contains(name) {
            return Ok(name.to_string());
        }
    }

    for i in 1..=existing.len().saturating_add(1) {
        let candidate = format!("CJK{}", i);
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(HandlerError::OperationFailed(
        "no free PDF font resource name".into(),
    ))
}

/// PDF Subset Prefix — 6 uppercase ASCII letters preceding `+`.
fn subset_prefix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xC0FFEE);
    let mut out = [b'A'; 6];
    for slot in out.iter_mut() {
        *slot = b'A' + (seed % 26) as u8;
        seed /= 26;
        if seed == 0 {
            seed = 0xDEADBEEF;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Build a ToUnicode CMap mapping each character CID to exactly one scalar.
/// Standard Adobe Identity-UCS format.
fn build_tounicode_cmap(map: &BTreeMap<u16, char>) -> Vec<u8> {
    let entries: Vec<(u16, char)> = map
        .iter()
        .map(|(cid, character)| (*cid, *character))
        .collect();

    let mut s = String::new();
    s.push_str("/CIDInit /ProcSet findresource begin\n");
    s.push_str("12 dict begin\n");
    s.push_str("begincmap\n");
    s.push_str(
        "/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n",
    );
    s.push_str("/CMapName /Adobe-Identity-UCS def\n");
    s.push_str("/CMapType 2 def\n");
    s.push_str("1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");

    // Each chunk allows max 100 entries per beginbfchar.
    for chunk in entries.chunks(100) {
        s.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (cid, character) in chunk {
            let mut units = [0u16; 2];
            let hex_unicode = character
                .encode_utf16(&mut units)
                .iter()
                .map(|unit| format!("{unit:04X}"))
                .collect::<String>();
            s.push_str(&format!("<{:04X}> <{}>\n", cid, hex_unicode));
        }
        s.push_str("endbfchar\n");
    }

    s.push_str("endcmap\n");
    s.push_str("CMapName currentdict /CMap defineresource pop\n");
    s.push_str("end\nend\n");

    s.into_bytes()
}

/// Add the new font reference under `Resources/Font/<name>` on the page.
fn register_font_on_page(
    doc: &mut LopdfDocument,
    page_id: ObjectId,
    font_name: &str,
    font_obj_id: ObjectId,
) -> Result<(), HandlerError> {
    // Copy both levels: Resources and Font can independently be inherited or
    // shared indirect dictionaries. A font added to one page must not mutate
    // the dictionaries used by another page.
    let mut resources = page_resources_copy(doc, page_id)?;
    let mut fonts = font_resources_copy(doc, &resources)?;
    fonts.set(font_name.as_bytes(), font_obj_id);
    resources.set("Font", fonts);
    doc.get_dictionary_mut(page_id)
        .map_err(|error| HandlerError::OperationFailed(format!("missing PDF page: {error}")))?
        .set("Resources", resources);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_font_rasterizes_visible_latin_text() {
        let mask = rasterize_bundled_text("PDF", 18.0).unwrap();
        assert!(mask.alpha.iter().any(|pixel| *pixel > 0));
    }

    #[test]
    fn mixed_fallback_text_paints_emoji_and_tracks_both_font_identities() {
        let mixed = rasterize_bundled_text("中文A😀B", 32.0).unwrap();
        assert_eq!(mixed.fonts.len(), 2);
        assert!(mixed.fonts.iter().any(|font| font.family == "Noto Emoji"));
        let emoji = rasterize_bundled_text("😀", 32.0).unwrap();
        assert!(emoji.alpha.iter().filter(|pixel| **pixel > 0).count() > 100);
        let family = rasterize_bundled_text("👨‍👩‍👧‍👦", 32.0).unwrap();
        assert!(family.alpha.iter().any(|pixel| *pixel > 0));
        assert!(
            family.width < emoji.width * 2,
            "family emoji must be shaped as a cluster"
        );
        assert_eq!(family.fonts.len(), 1);
        let descenders = rasterize_bundled_text("gy", 32.0).unwrap();
        assert!(
            descenders.alpha[(descenders.height - 1) * descenders.width..]
                .iter()
                .any(|pixel| *pixel > 0)
        );
    }

    #[test]
    fn fallback_painter_refuses_to_drop_text_or_allocate_unbounded_masks() {
        for text in ["A\nB", "A\r\nB", "əʊ", "a\u{10FFFF}"] {
            assert!(rasterize_bundled_text(text, 18.0).is_err(), "{text:?}");
        }
        for size in [f32::NAN, f32::INFINITY, 0.0, -1.0, 257.0] {
            assert!(rasterize_bundled_text("text", size).is_err());
        }
        assert!(rasterize_bundled_text(&"W".repeat(4096), 256.0).is_err());
        assert_eq!(rasterize_bundled_text("", 18.0).unwrap().alpha, [0]);
    }

    fn empty_two_page_document() -> LopdfDocument {
        let mut doc = LopdfDocument::with_version("1.7");
        let pages = doc.new_object_id();
        let children: Vec<_> = (0..2).map(|_| Object::Reference(doc.add_object(dictionary! {
            "Type"=>"Page", "Parent"=>pages, "MediaBox"=>vec![0.into(),0.into(),200.into(),200.into()],
            "Resources"=>dictionary!{"Font"=>Dictionary::new()}
        }))).collect();
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {"Type"=>"Pages", "Count"=>2, "Kids"=>children}),
        );
        let catalog = doc.add_object(dictionary! {"Type"=>"Catalog", "Pages"=>pages});
        doc.trailer.set("Root", catalog);
        doc
    }

    #[test]
    fn fallback_registration_copies_indirect_and_inherited_resources_without_changing_peers() {
        for inherited in [false, true] {
            for indirect in [false, true] {
                let mut doc = empty_two_page_document();
                let first = doc.get_pages()[&1];
                let second = doc.get_pages()[&2];
                let parent = doc
                    .get_dictionary(first)
                    .unwrap()
                    .get(b"Parent")
                    .unwrap()
                    .as_reference()
                    .unwrap();
                let original = doc.add_object(dictionary! {"Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica", "Encoding"=>"WinAnsiEncoding"});
                let fonts = doc.add_object(dictionary! {"CJK1"=>original});
                let resources = dictionary! {"Font"=>fonts, "ProcSet"=>vec![Object::Name(b"PDF".to_vec()),Object::Name(b"Text".to_vec())]};
                let shared = doc.add_object(resources.clone());
                let value = if indirect {
                    Object::Reference(shared)
                } else {
                    Object::Dictionary(resources)
                };
                if inherited {
                    doc.get_dictionary_mut(parent)
                        .unwrap()
                        .set("Resources", value);
                    doc.get_dictionary_mut(first).unwrap().remove(b"Resources");
                    doc.get_dictionary_mut(second).unwrap().remove(b"Resources");
                } else {
                    doc.get_dictionary_mut(first)
                        .unwrap()
                        .set("Resources", value.clone());
                    doc.get_dictionary_mut(second)
                        .unwrap()
                        .set("Resources", value);
                }
                let before = format!(
                    "{:?}{:?}{:?}{:?}",
                    doc.get_object(fonts),
                    doc.get_object(shared),
                    doc.get_dictionary(second),
                    doc.get_dictionary(parent)
                );
                ensure_text_fallback_fonts(&mut doc, 1, "AB保存😀").unwrap();
                let after = format!(
                    "{:?}{:?}{:?}{:?}",
                    doc.get_object(fonts),
                    doc.get_object(shared),
                    doc.get_dictionary(second),
                    doc.get_dictionary(parent)
                );
                assert_eq!(before, after, "shared resources or another page changed");
                let resources = doc
                    .get_dictionary(first)
                    .unwrap()
                    .get(b"Resources")
                    .unwrap()
                    .as_dict()
                    .unwrap();
                assert!(resources.has(b"ProcSet"));
                let registered = resources.get(b"Font").unwrap().as_dict().unwrap();
                assert_eq!(
                    registered.get(b"CJK1").unwrap().as_reference().unwrap(),
                    original
                );
                assert!(registered.len() >= 3);
                let mut missing = Vec::new();
                crate::content_stream::pick_fonts_for_text(
                    &doc,
                    first,
                    Some("CJK1"),
                    "AB保存😀",
                    &mut missing,
                )
                .unwrap();
                assert!(missing.is_empty());
                let count = doc.objects.len();
                ensure_text_fallback_fonts(&mut doc, 1, "AB保存😀").unwrap();
                assert_eq!(
                    doc.objects.len(),
                    count,
                    "a covered edit should reuse its fonts"
                );
            }
        }
    }

    #[test]
    fn unsupported_fallback_glyph_does_not_partially_change_the_document() {
        let mut doc = empty_two_page_document();
        let before = format!("{:?}", doc.objects);
        assert!(ensure_text_fallback_fonts(&mut doc, 1, "保存\u{10ffff}")
            .unwrap_err()
            .to_string()
            .contains("U+10FFFF"));
        assert_eq!(format!("{:?}", doc.objects), before);
    }

    #[test]
    fn fallback_accepts_null_font_maps_but_rejects_invalid_resource_inheritance() {
        let mut doc = empty_two_page_document();
        let page = doc.get_pages()[&1];
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Resources", dictionary! {"Font"=>Object::Null});
        ensure_text_fallback_fonts(&mut doc, 1, "中").unwrap();
        assert!(!doc.get_page_fonts(page).unwrap().is_empty());
        doc.get_dictionary_mut(page).unwrap().remove(b"Resources");
        doc.get_dictionary_mut(page).unwrap().set("Parent", page);
        assert!(page_resources_copy(&doc, page)
            .unwrap_err()
            .to_string()
            .contains("cyclic"));
    }

    #[test]
    fn embedded_font_reuse_requires_the_requested_file_identity_and_character_coverage() {
        let mut doc = empty_two_page_document();
        let sans = Face::parse(BUNDLED_NOTO, 0).unwrap();
        let emoji = Face::parse(BUNDLED_NOTO_EMOJI, 0).unwrap();
        let character = ['©', '1', '0', ' ']
            .into_iter()
            .find(|c| sans.glyph_index(*c).is_some() && emoji.glyph_index(*c).is_some())
            .unwrap();
        let chars = HashSet::from([character]);
        ensure_cjk_font_for_chars(&mut doc, 1, &chars, Some("First"), None, true).unwrap();
        let sans_id = find_embedded_font_covering_chars(
            &doc,
            &chars,
            &crate::fonts::bundled_font_catalog()[0].sha256,
            0,
            false,
        )
        .unwrap();
        let before = doc.objects.len();
        ensure_cjk_font_for_chars(&mut doc, 2, &chars, Some("Same"), None, true).unwrap();
        assert_eq!(
            doc.objects.len(),
            before,
            "the same face should be reused across pages"
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("custom.ttf");
        std::fs::write(&path, BUNDLED_NOTO_EMOJI).unwrap();
        ensure_cjk_font_for_chars(&mut doc, 1, &chars, Some("Custom"), path.to_str(), true)
            .unwrap();
        let emoji_id = find_embedded_font_covering_chars(
            &doc,
            &chars,
            &crate::fonts::bundled_font_catalog()[1].sha256,
            0,
            false,
        )
        .unwrap();
        assert_ne!(
            sans_id, emoji_id,
            "coverage alone must not override the requested font"
        );
        let embedded = doc.get_object(emoji_id).unwrap().as_dict().unwrap();
        let name = embedded.get(b"BaseFont").unwrap().as_name_str().unwrap();
        assert!(
            name.contains("NotoEmoji"),
            "actual PostScript name should be retained: {name}"
        );
        let before = doc.objects.len();
        ensure_cjk_font_for_chars(&mut doc, 2, &chars, None, path.to_str(), true).unwrap();
        assert_eq!(doc.objects.len(), before);
        std::fs::write(&path, b"not a font").unwrap();
        assert!(ensure_cjk_font_for_chars(
            &mut doc,
            1,
            &chars,
            Some("Invalid"),
            path.to_str(),
            true
        )
        .is_err());
        assert_eq!(
            doc.objects.len(),
            before,
            "an invalid file must not use an unrelated cached font"
        );
        let font = std::fs::File::create(&path).unwrap();
        font.set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(font_file_covers_chars(&path, &chars).is_err());
    }

    fn attach_text(doc: &mut LopdfDocument, page_id: ObjectId, font: &str, operand: &str) {
        let stream = doc.add_object(Stream::new(
            Dictionary::new(),
            format!("BT /{font} 12 Tf 10 100 Td {operand} Tj ET").into_bytes(),
        ));
        doc.get_object_mut(page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Contents", stream);
    }

    #[test]
    fn invisible_fonts_preserve_unsupported_unicode_without_becoming_visible_fallbacks() {
        let mut doc = empty_two_page_document();
        let page = doc.get_pages()[&1];
        let text = "离线 A 😀\u{10ffff}";
        let chars = text.chars().collect();
        let name = ensure_invisible_text_font(&mut doc, page, &chars)
            .unwrap()
            .unwrap();
        let operand =
            crate::content_stream::encode_chunk_with_font(&doc, page, &name, text).unwrap();
        attach_text(&mut doc, page, &name, &operand);
        let parsed = crate::content_stream::parse_page_content_stream(
            &doc.get_page_content(page).unwrap(),
            page,
            &doc,
        )
        .unwrap();
        assert_eq!(
            parsed
                .text_blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<String>(),
            text
        );
        let mut missing = Vec::new();
        crate::content_stream::pick_fonts_for_text(&doc, page, Some(&name), "A", &mut missing)
            .unwrap();
        assert_eq!(
            missing,
            vec!['A'],
            "search-layer fonts must not be picked as visible fallbacks"
        );
        let hidden = find_embedded_font_covering_chars(
            &doc,
            &chars,
            &crate::fonts::bundled_font_catalog()[0].sha256,
            0,
            true,
        )
        .unwrap();
        let visible_chars = HashSet::from(['A']);
        ensure_cjk_font_for_chars(&mut doc, 2, &visible_chars, None, None, true).unwrap();
        let visible = find_embedded_font_covering_chars(
            &doc,
            &visible_chars,
            &crate::fonts::bundled_font_catalog()[0].sha256,
            0,
            false,
        )
        .unwrap();
        assert_ne!(
            hidden, visible,
            "invisible .notdef mappings must not be reused for visible text"
        );
    }

    #[test]
    fn unicode_aliases_of_one_glyph_have_distinct_cids_and_roundtrip_exactly() {
        let face = Face::parse(BUNDLED_NOTO, 0).unwrap();
        let mut seen = HashMap::new();
        let aliases = (0x20..=0xffff)
            .filter_map(char::from_u32)
            .filter(|c| !c.is_control())
            .find_map(|character| {
                let gid = face.glyph_index(character)?;
                if gid.0 == 0 {
                    return None;
                }
                seen.insert(gid.0, character)
                    .map(|previous| (previous, character))
            })
            .expect("bundled face contains Unicode aliases for an outline");
        let text = format!("A{}{}{}Z", aliases.0, aliases.1, aliases.0);
        let chars = text.chars().collect();
        let mut doc = empty_two_page_document();
        let name = ensure_cjk_font_for_chars(&mut doc, 1, &chars, Some("Aliases"), None, true)
            .unwrap()
            .unwrap();
        let font_id = find_embedded_font_covering_chars(
            &doc,
            &chars,
            &crate::fonts::bundled_font_catalog()[0].sha256,
            0,
            false,
        )
        .unwrap();
        let font = doc.get_dictionary(font_id).unwrap();
        let unicode = doc
            .get_object(font.get(b"ToUnicode").unwrap().as_reference().unwrap())
            .unwrap()
            .as_stream()
            .unwrap()
            .get_plain_content()
            .unwrap();
        let cmap =
            crate::content_stream::parse_to_unicode_cmap(std::str::from_utf8(&unicode).unwrap());
        assert!(cmap.values().all(|text| text.chars().count() == 1));
        let alias_cids: Vec<_> = [aliases.0, aliases.1]
            .into_iter()
            .map(|character| {
                *cmap
                    .iter()
                    .find(|(_, text)| **text == character.to_string())
                    .unwrap()
                    .0 as usize
            })
            .collect();
        assert_ne!(alias_cids[0], alias_cids[1]);
        let cid_font = doc
            .get_dictionary(
                font.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
                    .as_reference()
                    .unwrap(),
            )
            .unwrap();
        let map = doc
            .get_object(
                cid_font
                    .get(b"CIDToGIDMap")
                    .unwrap()
                    .as_reference()
                    .unwrap(),
            )
            .unwrap()
            .as_stream()
            .unwrap()
            .get_plain_content()
            .unwrap();
        assert_eq!(
            &map[alias_cids[0] * 2..alias_cids[0] * 2 + 2],
            &map[alias_cids[1] * 2..alias_cids[1] * 2 + 2]
        );
        let page_id = doc.get_pages()[&1];
        let operand =
            crate::content_stream::encode_chunk_with_font(&doc, page_id, &name, &text).unwrap();
        attach_text(&mut doc, page_id, &name, &operand);
        let parsed = crate::content_stream::parse_page_content_stream(
            &doc.get_page_content(page_id).unwrap(),
            page_id,
            &doc,
        )
        .unwrap();
        assert_eq!(
            parsed
                .text_blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<String>(),
            text
        );
    }

    #[test]
    fn a_legacy_ligature_mapping_cannot_encode_each_letter_and_uses_a_safe_fallback() {
        let mut doc = empty_two_page_document();
        let chars = HashSet::from(['f', 'i']);
        let original = ensure_cjk_font_for_chars(&mut doc, 1, &chars, Some("Original"), None, true)
            .unwrap()
            .unwrap();
        let font_id = find_embedded_font_covering_chars(
            &doc,
            &chars,
            &crate::fonts::bundled_font_catalog()[0].sha256,
            0,
            false,
        )
        .unwrap();
        let font = doc.get_dictionary(font_id).unwrap();
        let unicode_id = font.get(b"ToUnicode").unwrap().as_reference().unwrap();
        let cmap=b"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfchar\n<0001> <00660069>\nendbfchar\n";
        doc.objects.insert(
            unicode_id,
            Object::Stream(Stream::new(Dictionary::new(), cmap.to_vec())),
        );
        doc.get_object_mut(font_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .remove(b"OfficeCLICidMappingVersion");
        let page = doc.get_pages()[&1];
        attach_text(&mut doc, page, &original, "<0001>");
        assert!(crate::content_stream::encode_chunk_with_font(&doc, page, &original, "f").is_err());
        let fallback = ensure_cjk_font_for_chars(&mut doc, 1, &chars, None, None, false)
            .unwrap()
            .expect("individual letters require a different mapping");
        assert_ne!(original, fallback);
        crate::modifier::replace_text_at_path(&mut doc, 1, 1, "if", Some(&fallback)).unwrap();
        let parsed = crate::content_stream::parse_page_content_stream(
            &doc.get_page_content(page).unwrap(),
            page,
            &doc,
        )
        .unwrap();
        assert_eq!(
            parsed
                .text_blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<String>(),
            "if"
        );
    }

    #[test]
    fn a_simple_font_with_tounicode_saves_one_byte_codes_without_extra_nuls() {
        let mut doc = empty_two_page_document();
        let cmap=b"1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <0041>\nendbfchar\n";
        let unicode = doc.add_object(Stream::new(Dictionary::new(), cmap.to_vec()));
        let font=doc.add_object(dictionary! { "Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica", "Encoding"=>"WinAnsiEncoding", "ToUnicode"=>unicode });
        let page = doc.get_pages()[&1];
        doc.get_object_mut(page)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set(
                "Resources",
                dictionary! {"Font"=>dictionary!{"Simple"=>font}},
            );
        attach_text(&mut doc, page, "Simple", "<41>");
        assert_eq!(
            crate::content_stream::encode_chunk_with_font(&doc, page, "Simple", "AA").unwrap(),
            "<4141>"
        );
        crate::modifier::replace_text_at_path(&mut doc, 1, 1, "AA", Some("Simple")).unwrap();
        let parsed = crate::content_stream::parse_page_content_stream(
            &doc.get_page_content(page).unwrap(),
            page,
            &doc,
        )
        .unwrap();
        assert_eq!(
            parsed
                .text_blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<String>(),
            "AA"
        );
    }

    #[test]
    fn bundled_cjk_font_coverage_is_reported_exactly() {
        let font_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join("NotoSansSC-Regular.ttf");
        assert!(font_file_covers_chars(&font_path, &HashSet::from(['中', 'A'])).unwrap());
        assert!(!font_file_covers_chars(&font_path, &HashSet::from(['ə', 'ʊ'])).unwrap());
    }

    #[test]
    fn bundled_cjk_font_is_a_static_regular_face() {
        let face = Face::parse(BUNDLED_NOTO, 0).unwrap();
        assert!(!face.is_variable());
        assert_eq!(face.weight().to_number(), 400);
    }

    #[test]
    fn bundled_emoji_font_is_static_and_covers_grinning_face() {
        let face = Face::parse(BUNDLED_NOTO_EMOJI, 0).unwrap();
        assert!(!face.is_variable());
        assert_eq!(face.weight().to_number(), 400);
        assert!(face.glyph_index('😀').is_some());
    }
}
