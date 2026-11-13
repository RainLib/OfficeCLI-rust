use std::collections::{BTreeMap, HashMap, HashSet};
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
    let font_bytes = std::fs::read(path).map_err(|error| {
        HandlerError::OperationFailed(format!(
            "failed to read font file '{}': {error}",
            path.display()
        ))
    })?;
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

fn font_bytes_missing_chars(
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
    let pages = doc.get_pages();
    let page_id = *pages
        .get(&(page_num as u32))
        .ok_or_else(|| HandlerError::PathNotFound(format!("page {}", page_num)))?;

    // A semantic export supplies the same complete character set for the first
    // text block on every page. Reuse an already embedded Type0 font object
    // instead of subsetting and embedding the same font once per page.
    if force_embed {
        if let Some(preferred_name) = preferred_name {
            if let Some(font_id) = find_embedded_font_covering_chars(doc, chars_needed) {
                let page_font_name = choose_pdf_font_name(doc, page_id, Some(preferred_name));
                register_font_on_page(doc, page_id, &page_font_name, font_id)?;
                return Ok(Some(page_font_name));
            }
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

    let font_bytes: Vec<u8> = if let Some(path) = user_font_file {
        std::fs::read(Path::new(path)).map_err(|e| {
            HandlerError::OperationFailed(format!("failed to read font file '{}': {}", path, e))
        })?
    } else {
        BUNDLED_NOTO.to_vec()
    };

    let face = Face::parse(&font_bytes, 0)
        .map_err(|e| HandlerError::OperationFailed(format!("failed to parse font: {:?}", e)))?;

    let mut char_to_gid: Vec<(char, u16)> = Vec::new();
    let mut missing_in_font: Vec<char> = Vec::new();
    for &ch in &chars_to_embed {
        if let Some(GlyphId(gid)) = face.glyph_index(ch) {
            char_to_gid.push((ch, gid));
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
    let subset_bytes = subsetter::subset(&font_bytes, 0, &remapper)
        .map_err(|e| HandlerError::OperationFailed(format!("failed to subset font: {:?}", e)))?;

    let units_per_em = face.units_per_em() as f32;
    if units_per_em <= 0.0 {
        return Err(HandlerError::OperationFailed(
            "font has invalid units_per_em".into(),
        ));
    }
    let scale = 1000.0 / units_per_em;

    let mut new_gid_to_unicodes: HashMap<u16, Vec<char>> = HashMap::new();
    for (ch, old_gid) in &char_to_gid {
        if let Some(new_gid) = remapper.get(*old_gid) {
            new_gid_to_unicodes.entry(new_gid).or_default().push(*ch);
        }
    }

    // Old GIDs in new-order (new_gid 0 → first item, 1 → second, ...).
    let old_gids_in_new_order: Vec<u16> = remapper.remapped_gids().collect();
    let mut widths: Vec<i64> = Vec::with_capacity(old_gids_in_new_order.len());
    for old_gid in &old_gids_in_new_order {
        let w = face.glyph_hor_advance(GlyphId(*old_gid)).unwrap_or(0) as f32;
        widths.push((w * scale).round() as i64);
    }

    let bbox = face.global_bounding_box();
    let ascender = (face.ascender() as f32 * scale).round() as i64;
    let descender = (face.descender() as f32 * scale).round() as i64;
    let cap_height = face
        .capital_height()
        .map(|h| (h as f32 * scale).round() as i64)
        .unwrap_or(ascender);
    let italic_angle: f32 = face.italic_angle().unwrap_or(0.0);

    let pdf_font_name = choose_pdf_font_name(doc, page_id, preferred_name);
    let postscript_name = format!("{}+NotoSansSC", subset_prefix());

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
        "CIDToGIDMap" => Object::Name(b"Identity".to_vec()),
        "W" => Object::Array(w_array),
    });

    let tounicode_bytes = build_tounicode_cmap(&new_gid_to_unicodes);
    let mut tu_stream = Stream::new(Dictionary::new(), tounicode_bytes);
    let _ = tu_stream.compress();
    let tu_id = doc.add_object(Object::Stream(tu_stream));

    let type0_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"Type0".to_vec()),
        "BaseFont" => Object::Name(postscript_name.into_bytes()),
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
) -> Option<ObjectId> {
    doc.objects.iter().find_map(|(object_id, object)| {
        let dictionary = object.as_dict().ok()?;
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
        let covered: HashSet<char> = cmap.values().flat_map(|value| value.chars()).collect();
        chars_needed
            .iter()
            .all(|character| covered.contains(character))
            .then_some(*object_id)
    })
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
                if cmap.values().any(|s| s.contains(ch)) {
                    supported.insert(ch);
                    continue;
                }
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

/// Pick a unique PDF font name on the page (e.g. CJK1, CJK2).
/// Honors `preferred` if it isn't taken.
fn choose_pdf_font_name(doc: &LopdfDocument, page_id: ObjectId, preferred: Option<&str>) -> String {
    let existing: HashSet<String> = doc
        .get_page_fonts(page_id)
        .map(|fonts| {
            fonts
                .into_keys()
                .map(|n| String::from_utf8_lossy(&n).to_string())
                .collect()
        })
        .unwrap_or_default();

    if let Some(name) = preferred {
        if !existing.contains(name) {
            return name.to_string();
        }
    }

    for i in 1..1000 {
        let candidate = format!("CJK{}", i);
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    "CJK_FALLBACK".to_string()
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

/// Build a ToUnicode CMap stream body that maps each new CID to its Unicode code point(s).
/// Standard Adobe Identity-UCS format.
fn build_tounicode_cmap(map: &HashMap<u16, Vec<char>>) -> Vec<u8> {
    let mut entries: Vec<(u16, Vec<char>)> = map.iter().map(|(k, v)| (*k, v.clone())).collect();
    entries.sort_by_key(|(k, _)| *k);

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
        for (cid, chars) in chunk {
            let mut hex_unicode = String::new();
            for ch in chars {
                let cp = *ch as u32;
                if cp <= 0xFFFF {
                    hex_unicode.push_str(&format!("{:04X}", cp));
                } else {
                    // UTF-16 surrogate pair
                    let cp_adj = cp - 0x10000;
                    let hi = 0xD800 + (cp_adj >> 10);
                    let lo = 0xDC00 + (cp_adj & 0x3FF);
                    hex_unicode.push_str(&format!("{:04X}{:04X}", hi, lo));
                }
            }
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
    let resources_id = match doc.get_or_create_resources(page_id).map_err(|e| {
        HandlerError::OperationFailed(format!("failed to get/create page resources: {:?}", e))
    })? {
        Object::Reference(id) => Some(*id),
        _ => None,
    };

    // Some PDFs store /Resources and /Font as separate indirect dictionaries.
    // Resolve /Font before taking a mutable borrow of either resource object.
    let font_id = {
        let resources = if let Some(id) = resources_id {
            doc.get_object(id).map_err(|e| {
                HandlerError::OperationFailed(format!("resources obj missing: {:?}", e))
            })?
        } else {
            doc.get_or_create_resources(page_id).map_err(|e| {
                HandlerError::OperationFailed(format!(
                    "failed to get/create page resources: {:?}",
                    e
                ))
            })?
        };
        resources
            .as_dict()
            .map_err(|e| HandlerError::OperationFailed(format!("resources not a dict: {:?}", e)))?
            .get(b"Font")
            .ok()
            .and_then(|font| font.as_reference().ok())
    };
    if let Some(id) = font_id {
        let font = doc.get_object_mut(id).map_err(|e| {
            HandlerError::OperationFailed(format!("font resources obj missing: {:?}", e))
        })?;
        font.as_dict_mut()
            .map_err(|e| HandlerError::OperationFailed(format!("/Font not a dict: {:?}", e)))?
            .set(
                font_name.as_bytes().to_vec(),
                Object::Reference(font_obj_id),
            );
    } else if let Some(id) = resources_id {
        let resources = doc.get_object_mut(id).map_err(|e| {
            HandlerError::OperationFailed(format!("resources obj missing: {:?}", e))
        })?;
        ensure_font_in_resources(resources, font_name, font_obj_id)?;
    } else {
        let resources = doc.get_or_create_resources(page_id).map_err(|e| {
            HandlerError::OperationFailed(format!("failed to get/create page resources: {:?}", e))
        })?;
        ensure_font_in_resources(resources, font_name, font_obj_id)?;
    }

    Ok(())
}

fn ensure_font_in_resources(
    resources: &mut Object,
    font_name: &str,
    font_obj_id: ObjectId,
) -> Result<(), HandlerError> {
    let dict = resources
        .as_dict_mut()
        .map_err(|e| HandlerError::OperationFailed(format!("resources not a dict: {:?}", e)))?;
    if !dict.has(b"Font") {
        dict.set("Font", Dictionary::new());
    }
    let font_dict = dict
        .get_mut(b"Font")
        .and_then(Object::as_dict_mut)
        .map_err(|e| HandlerError::OperationFailed(format!("/Font not a dict: {:?}", e)))?;
    font_dict.set(
        font_name.as_bytes().to_vec(),
        Object::Reference(font_obj_id),
    );
    Ok(())
}

/// Embed a complete TrueType or OpenType face and register it on every page.
///
/// The face arrives ready to draw with: its real glyph advances go into `/W`
/// and a ToUnicode CMap built from its own character map goes on the Type0
/// font, so [crate::content_stream::pick_fonts_for_text] can encode text into
/// it by character instead of treating it as an unusable resource. The bytes
/// stay in the PDF and existing text operators keep their original fonts —
/// nothing here rewrites content that is already on the page. A face that is
/// not a parseable font returns an error and leaves the file untouched.
pub fn embed_font_file(path: &Path, resource_name: &str, bytes: &[u8]) -> Result<(), HandlerError> {
    let face = Face::parse(bytes, 0).map_err(|error| {
        HandlerError::OperationFailed(format!(
            "theme font is not a TrueType or OpenType font: {error:?}"
        ))
    })?;
    if resource_name.is_empty()
        || !resource_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(HandlerError::OperationFailed(
            "PDF font resource name must be ASCII alphanumeric".to_string(),
        ));
    }
    let mut document = LopdfDocument::load(path).map_err(|error| {
        HandlerError::OperationFailed(format!("failed to open PDF for font embedding: {error}"))
    })?;
    let font_id = add_complete_font(&mut document, resource_name, bytes, &face)?;
    for page_id in document.get_pages().values().copied() {
        register_font_on_page(&mut document, page_id, resource_name, font_id)?;
    }
    document.save(path).map_err(|error| {
        HandlerError::OperationFailed(format!("failed to save PDF after font embedding: {error}"))
    })?;
    Ok(())
}

fn add_complete_font(
    doc: &mut LopdfDocument,
    resource_name: &str,
    bytes: &[u8],
    face: &Face<'_>,
) -> Result<ObjectId, HandlerError> {
    let length1 = bytes.len() as i64;
    let glyf = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"glyf"))
        .is_some();
    let mut fontfile_stream = if glyf {
        Stream::new(
            dictionary! { "Length1" => Object::Integer(length1) },
            bytes.to_vec(),
        )
    } else {
        Stream::new(
            dictionary! {
                "Subtype" => Object::Name(b"OpenType".to_vec()),
                "Length1" => Object::Integer(length1)
            },
            bytes.to_vec(),
        )
    };
    let _ = fontfile_stream.compress();
    let fontfile_id = doc.add_object(Object::Stream(fontfile_stream));
    let units_per_em = face.units_per_em() as f32;
    let scale = if units_per_em > 0.0 {
        1000.0 / units_per_em
    } else {
        1.0
    };
    let bbox = face.global_bounding_box();
    let file_key = if glyf { "FontFile2" } else { "FontFile3" };
    let mut descriptor = dictionary! {
        "Type" => Object::Name(b"FontDescriptor".to_vec()),
        "FontName" => Object::Name(resource_name.as_bytes().to_vec()),
        "Flags" => Object::Integer(32),
        "FontBBox" => Object::Array(vec![
            Object::Integer((bbox.x_min as f32 * scale) as i64),
            Object::Integer((bbox.y_min as f32 * scale) as i64),
            Object::Integer((bbox.x_max as f32 * scale) as i64),
            Object::Integer((bbox.y_max as f32 * scale) as i64),
        ]),
        "ItalicAngle" => Object::Real(face.italic_angle().unwrap_or(0.0)),
        "Ascent" => Object::Integer((face.ascender() as f32 * scale).round() as i64),
        "Descent" => Object::Integer((face.descender() as f32 * scale).round() as i64),
        "CapHeight" => Object::Integer((face.ascender() as f32 * scale).round() as i64),
        "StemV" => Object::Integer(80),
    };
    descriptor.set(file_key, Object::Reference(fontfile_id));
    let descriptor_id = doc.add_object(descriptor);
    // Everything this face can draw, and the widths those glyphs advance by.
    // Without them the font is luggage: the PDF carries the bytes, but no text
    // can be pointed at it, and a viewer that tried would space every glyph
    // 1 em apart.
    let mapped = mapped_chars(face);
    let to_unicode_id = doc.add_object(Stream::new(
        dictionary! {},
        to_unicode_cmap(&mapped).into_bytes(),
    ));
    let cidfont_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(if glyf { b"CIDFontType2".to_vec() } else { b"CIDFontType0".to_vec() }),
        "BaseFont" => Object::Name(resource_name.as_bytes().to_vec()),
        "CIDSystemInfo" => Object::Dictionary(dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => Object::Integer(0),
        }),
        "FontDescriptor" => Object::Reference(descriptor_id),
        "CIDToGIDMap" => Object::Name(b"Identity".to_vec()),
        "W" => Object::Array(width_array(face, scale, &mapped)),
    });
    Ok(doc.add_object(dictionary! {
        "Type" => Object::Name(b"Font".to_vec()),
        "Subtype" => Object::Name(b"Type0".to_vec()),
        "BaseFont" => Object::Name(resource_name.as_bytes().to_vec()),
        "Encoding" => Object::Name(b"Identity-H".to_vec()),
        "DescendantFonts" => Object::Array(vec![Object::Reference(cidfont_id)]),
        "ToUnicode" => Object::Reference(to_unicode_id),
    }))
}

/// Every character this face draws, as `(character, glyph id)`, in character order.
///
/// Identity-H writes two-byte codes, so only the BMP is addressable: a
/// supplementary-plane character has no code to write here and is left out,
/// which makes it report as missing instead of being drawn as a blank box.
/// The glyph id doubles as the CID because the descendant font maps CIDs to
/// glyphs by identity.
/// The same mapping [face] would answer for "can this character be drawn, and
/// with which code", as a map a PDF writer can consult directly.
///
/// A font that has been subset loses this question's answer in general, so
/// callers use it only for faces they embedded whole.
pub(crate) fn face_bmp_char_to_cid(face: &Face<'_>) -> HashMap<char, u32> {
    mapped_chars(face)
        .into_iter()
        .map(|(character, gid)| (character, u32::from(gid)))
        .collect()
}

fn mapped_chars(face: &Face<'_>) -> Vec<(char, u16)> {
    (0..0x1_0000u32)
        .filter_map(char::from_u32)
        .filter_map(|character| {
            face.glyph_index(character)
                .filter(|gid| gid.0 != 0)
                .map(|gid| (character, gid.0))
        })
        .collect()
}

/// A ToUnicode CMap for [`mapped_chars`], so text drawn with this face can be
/// read back as characters.
///
/// One entry per glyph, not per character: a CMap answers a glyph with a single
/// string, and a face like Noto Sans SC maps both U+0020 and U+00A0 onto one
/// glyph. Naming the first character of each glyph keeps the map honest — a
/// non-breaking space extracts as a space, which is what it looks like — where
/// writing both would let the later entry silently replace the earlier one and
/// lose the first character for every reader.
///
/// Writing text into this face does not use this map; it uses the face's own
/// character map, which has room for every character. See
/// [crate::content_stream::face_char_to_cid].
///
/// Entries are chunked at 100 because that is the most a conforming reader has
/// to accept inside one `beginbfchar` block.
fn to_unicode_cmap(mapped: &[(char, u16)]) -> String {
    let mut per_glyph: Vec<(u16, char)> = Vec::with_capacity(mapped.len());
    let mut seen = HashSet::with_capacity(mapped.len());
    for (character, cid) in mapped {
        if seen.insert(*cid) {
            per_glyph.push((*cid, *character));
        }
    }
    per_glyph.sort_unstable();
    let mut cmap = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    for chunk in per_glyph.chunks(100) {
        cmap.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (cid, character) in chunk {
            cmap.push_str(&format!(
                "<{:04X}> <{:04X}>\n",
                *cid as u32, *character as u16
            ));
        }
        cmap.push_str("endbfchar\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    cmap
}

/// The `/W` array of the descendant CID font: the advance, in 1/1000 units, of
/// every glyph this face can draw.
///
/// Consecutive glyphs that advance by the same amount — most of a CJK face,
/// where ideographs share one width — collapse into a `first last width`
/// triple, and a consecutive run of different widths becomes one
/// `first [w1 w2 …]` group, so a 20 000-glyph face does not pay for 20 000
/// array entries. Glyphs nobody can name are not listed; the spec's default of
/// 1 em covers them.
fn width_array(face: &Face<'_>, scale: f32, mapped: &[(char, u16)]) -> Vec<Object> {
    // One advance per drawable glyph, in glyph-id order: `mapped` is in
    // character order, and several characters can share one glyph.
    let mut glyphs: BTreeMap<u16, i64> = BTreeMap::new();
    for (_, cid) in mapped {
        glyphs.entry(*cid).or_insert_with(|| {
            face.glyph_hor_advance(GlyphId(*cid))
                .map_or(1000.0, |advance| advance as f32 * scale)
                .round() as i64
        });
    }
    let advances: Vec<(u16, i64)> = glyphs.into_iter().collect();

    let mut widths = Vec::new();
    let mut index = 0usize;
    while index < advances.len() {
        let first = index;
        let mut end = index + 1;
        while end < advances.len()
            && u32::from(advances[end].0) == u32::from(advances[end - 1].0) + 1
            && advances[end].1 == advances[end - 1].1
        {
            end += 1;
        }
        if end - first > 1 {
            widths.push(Object::Integer(advances[first].0 as i64));
            widths.push(Object::Integer(advances[end - 1].0 as i64));
            widths.push(Object::Integer(advances[first].1));
        } else {
            widths.push(Object::Integer(advances[first].0 as i64));
            widths.push(Object::Array(
                advances[first..end]
                    .iter()
                    .map(|(_, width)| Object::Integer(*width))
                    .collect(),
            ));
        }
        index = end;
    }
    widths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registering_font_resolves_indirect_font_dictionary() {
        let mut document = LopdfDocument::with_version("1.5");
        let fonts = document.add_object(Dictionary::new());
        let resources = document.add_object(lopdf::dictionary! { "Font" => fonts });
        let page = document.add_object(lopdf::dictionary! {
            "Type" => "Page", "Resources" => resources,
        });
        let embedded = document.add_object(lopdf::dictionary! { "Type" => "Font" });
        register_font_on_page(&mut document, page, "HCDEdit", embedded).unwrap();
        let registered = document
            .get_object(fonts)
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"HCDEdit")
            .unwrap()
            .as_reference()
            .unwrap();
        assert_eq!(registered, embedded);
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

    /// One blank page, so an embedding test exercises the real file round trip.
    fn one_page_pdf(document: &mut LopdfDocument) {
        let pages_id = document.new_object_id();
        let page_id = document.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => Dictionary::new(),
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog = document.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog);
    }

    #[test]
    fn complete_font_bytes_are_registered_on_the_page() {
        let mut document = LopdfDocument::with_version("1.5");
        one_page_pdf(&mut document);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("page.pdf");
        document.save(&path).unwrap();
        embed_font_file(&path, "HcdEmoji", BUNDLED_NOTO_EMOJI).unwrap();
        let saved = LopdfDocument::load(&path).unwrap();
        let page = saved.get_pages()[&1];
        let (resources, _) = saved.get_page_resources(page).unwrap();
        let fonts = resources.unwrap().get(b"Font").unwrap().as_dict().unwrap();
        assert!(fonts.get(b"HcdEmoji").is_ok());
    }

    #[test]
    fn an_embedded_face_can_draw_the_text_it_claims() {
        use crate::content_stream::pick_fonts_for_text;

        let mut document = LopdfDocument::with_version("1.5");
        one_page_pdf(&mut document);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drawable.pdf");
        document.save(&path).unwrap();
        embed_font_file(&path, "HcdSans", BUNDLED_NOTO).unwrap();

        let saved = LopdfDocument::load(&path).unwrap();
        let page = saved.get_pages()[&1];

        // The character map is what makes the face addressable: without it the
        // text writer cannot name a single glyph and skips the font entirely.
        // U+00A0 shares its glyph with the space in this face, so only the
        // face's own character map can say it is drawable.
        let sample = "中文 \u{a0}Alpha";
        let mut missing = Vec::new();
        let segments =
            pick_fonts_for_text(&saved, page, Some("HcdSans"), sample, &mut missing).unwrap();
        assert!(
            missing.is_empty(),
            "face should cover its own text: {missing:?}"
        );
        assert_eq!(segments.len(), 1, "one face draws the whole run");
        assert_eq!(segments[0].font_name, "HcdSans");
        assert_eq!(
            segments[0].encoded_operand.len(),
            sample.chars().count() * 4 + 2,
            "Identity-H writes two bytes per character: {}",
            segments[0].encoded_operand
        );

        // The widths are the face's own, so text is not spaced one em per glyph.
        let type0 = saved
            .get_page_fonts(page)
            .unwrap()
            .into_iter()
            .find(|(name, _)| name == b"HcdSans")
            .expect("the face should be registered on the page")
            .1;
        let descendant = type0.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap();
        let cidfont = saved.get_object(descendant).unwrap().as_dict().unwrap();
        let widths = widths_from_w_array(cidfont.get(b"W").unwrap().as_array().unwrap());
        let face = Face::parse(BUNDLED_NOTO, 0).unwrap();
        let scale = 1000.0 / face.units_per_em() as f32;
        for character in ['A', 'i', '中'] {
            let gid = face.glyph_index(character).unwrap().0;
            let expected =
                (face.glyph_hor_advance(GlyphId(gid)).unwrap() as f32 * scale).round() as i64;
            assert_eq!(
                widths.get(&i64::from(gid)).copied(),
                Some(expected),
                "advance for {character:?} should come from the face"
            );
        }
        assert_ne!(widths[&i64::from(face.glyph_index('A').unwrap().0)], 1000);
    }

    #[test]
    fn the_cmap_gives_one_character_per_glyph() {
        // This face answers both U+0020 and U+00A0 with the same glyph, and a
        // CMap can reply to a glyph with only one string. Naming each glyph once
        // is what keeps the earlier entry from being overwritten: the space stays
        // extractable, and the non-breaking space extracts as the space it looks
        // like. Writing text is unaffected — the face itself still knows both.
        let face = Face::parse(BUNDLED_NOTO, 0).unwrap();
        let space = face.glyph_index(' ').unwrap().0;
        assert_eq!(space, face.glyph_index('\u{a0}').unwrap().0);

        let mapped = mapped_chars(&face);
        assert!(mapped.iter().any(|(ch, _)| *ch == '\u{a0}'));
        let cmap = to_unicode_cmap(&mapped);
        let parsed = crate::content_stream::parse_to_unicode_cmap(&cmap);
        assert_eq!(
            parsed.get(&u32::from(space)).map(String::as_str),
            Some(" "),
            "the first character of a shared glyph is the one a reader gets"
        );

        let distinct_glyphs = mapped
            .iter()
            .map(|(_, cid)| cid)
            .collect::<HashSet<_>>()
            .len();
        assert_eq!(parsed.len(), distinct_glyphs);
        assert!(cmap
            .lines()
            .filter_map(|line| line.strip_suffix(" beginbfchar"))
            .all(|count| count.parse::<usize>().unwrap() <= 100));
    }

    /// Both shapes of a `/W` array, flattened to glyph id -> width.
    fn widths_from_w_array(array: &[Object]) -> HashMap<i64, i64> {
        let mut widths = HashMap::new();
        let mut index = 0;
        while index < array.len() {
            let first = array[index].as_i64().unwrap();
            if let Ok(group) = array[index + 1].as_array() {
                for (offset, width) in group.iter().enumerate() {
                    widths.insert(first + offset as i64, width.as_i64().unwrap());
                }
                index += 2;
            } else {
                let last = array[index + 1].as_i64().unwrap();
                let width = array[index + 2].as_i64().unwrap();
                for cid in first..=last {
                    widths.insert(cid, width);
                }
                index += 3;
            }
        }
        widths
    }
}
