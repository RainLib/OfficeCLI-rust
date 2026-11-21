//! Searchable text painted with PDF text rendering mode 3. The original
//! streams and resources remain available, including raster images and forms.
use handler_common::HandlerError;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
};

const FONT_NAME: &str = "GlyphLessFont";
const FONT_PROGRAM: &[u8] = include_bytes!("../assets/GlyphLessFont.ttf");

pub struct OcrTextLine {
    pub text: String,
    pub x: f32,
    pub baseline: f32,
    pub width: f32,
    pub height: f32,
}

impl OcrTextLine {
    /// Convert a top-left page box in points to the PDF baseline.
    pub fn from_display_box(text: String, bounds: [f32; 4], page_height: f32) -> Self {
        let [x, top, width, height] = bounds;
        Self {
            text,
            x,
            baseline: page_height - top - 0.8 * height,
            width,
            height,
        }
    }
}

pub struct OcrTextPage {
    pub page: u32,
    /// Display coordinates with an upward Y axis to the source page user space.
    pub transform: [f64; 6],
    pub lines: Vec<OcrTextLine>,
}

fn pdf_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::OperationFailed(error.to_string())
}

pub fn append_ocr_text(doc: &mut Document, pages: &[OcrTextPage]) -> Result<(), HandlerError> {
    let chars: BTreeSet<_> = pages
        .iter()
        .flat_map(|page| &page.lines)
        .flat_map(|line| line.text.chars())
        .collect();
    if chars.is_empty() {
        return Ok(());
    }
    if chars.len() >= usize::from(u16::MAX) {
        return Err(HandlerError::InvalidArgument(
            "too many distinct characters in PDF OCR layer".into(),
        ));
    }
    let codes: BTreeMap<_, _> = chars
        .into_iter()
        .enumerate()
        .map(|(index, character)| (character, (index + 1) as u16))
        .collect();
    let font = create_ocr_font(doc, &codes);
    let ids = doc.get_pages();
    for page in pages {
        let id = *ids
            .get(&page.page)
            .ok_or_else(|| HandlerError::PathNotFound(format!("page {}", page.page)))?;
        let resource = register_ocr_font(doc, id, font)?;
        let [a, b, c, d, e, f] = page.transform;
        if !page.transform.iter().all(|value| value.is_finite()) {
            return Err(HandlerError::InvalidArgument(
                "invalid OCR page transform".into(),
            ));
        }
        let mut layer = format!("Q\nq\n{a:.8} {b:.8} {c:.8} {d:.8} {e:.8} {f:.8} cm\n");
        for line in &page.lines {
            if line.text.is_empty() {
                continue;
            }
            let OcrTextLine {
                x,
                baseline,
                width,
                height,
                ..
            } = *line;
            if ![x, baseline, width, height]
                .iter()
                .all(|value| value.is_finite())
                || width <= 0.0
                || height <= 0.0
            {
                return Err(HandlerError::InvalidArgument(
                    "invalid OCR text bounds".into(),
                ));
            }
            let advance = line.text.chars().count() as f32 * height * 0.5;
            let scaling = width / advance * 100.0;
            write!(layer, "BT\n/{resource} {height:.6} Tf\n3 Tr\n0 Tc\n0 Tw\n0 Ts\n{scaling:.6} Tz\n1 0 0 1 {x:.6} {baseline:.6} Tm\n<").unwrap();
            for character in line.text.chars() {
                write!(layer, "{:04X}", codes[&character]).unwrap();
            }
            layer.push_str("> Tj\nET\n");
        }
        layer.push_str("Q\n");
        // Surround the source stream sequence so a source clipping path or
        // transformation cannot displace the invisible text.
        let mut contents = doc.get_page_contents(id);
        let save = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
        contents.insert(0, save);
        let layer = doc.add_object(Stream::new(Dictionary::new(), layer.into_bytes()));
        contents.push(layer);
        doc.get_dictionary_mut(id).map_err(pdf_error)?.set(
            "Contents",
            Object::Array(contents.into_iter().map(Object::Reference).collect()),
        );
    }
    Ok(())
}

fn create_ocr_font(doc: &mut Document, codes: &BTreeMap<char, u16>) -> ObjectId {
    let program = doc.add_object(Stream::new(
        dictionary! { "Length1" => FONT_PROGRAM.len() as i64 },
        FONT_PROGRAM.to_vec(),
    ));
    let mut glyph_map = vec![0u8; (codes.len() + 1) * 2];
    for entry in glyph_map[2..].as_chunks_mut::<2>().0 {
        entry[1] = 1;
    }
    let glyph_map =
        doc.add_object(Stream::new(Dictionary::new(), glyph_map).with_compression(true));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => Object::Name(FONT_NAME.as_bytes().to_vec()),
        "Flags" => 5,
        "FontBBox" => vec![0.into(), (-200).into(), 500.into(), 800.into()],
        "ItalicAngle" => 0,
        "Ascent" => 800,
        "Descent" => -200,
        "CapHeight" => 800,
        "StemV" => 80,
        "FontFile2" => program,
    });
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => Object::Name(FONT_NAME.as_bytes().to_vec()),
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "CIDToGIDMap" => glyph_map,
        "DW" => 500,
    });
    let unicode = doc.add_object(Stream::new(Dictionary::new(), to_unicode_cmap(codes)));
    doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => Object::Name(FONT_NAME.as_bytes().to_vec()),
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(descendant)],
        "ToUnicode" => unicode,
    })
}

fn to_unicode_cmap(codes: &BTreeMap<char, u16>) -> Vec<u8> {
    let mut cmap = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /OfficeCLI-OCR-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    let entries: Vec<_> = codes.iter().collect();
    for group in entries.chunks(100) {
        writeln!(cmap, "{} beginbfchar", group.len()).unwrap();
        for (&character, &code) in group.iter().copied() {
            let mut buffer = [0; 2];
            write!(cmap, "<{code:04X}> <").unwrap();
            for unit in character.encode_utf16(&mut buffer) {
                write!(cmap, "{unit:04X}").unwrap();
            }
            cmap.push_str(">\n");
        }
        cmap.push_str("endbfchar\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    cmap.into_bytes()
}

fn register_ocr_font(
    doc: &mut Document,
    page: ObjectId,
    font: ObjectId,
) -> Result<String, HandlerError> {
    let mut resources = Dictionary::new();
    let mut cursor = page;
    let mut seen = BTreeSet::new();
    while seen.insert(cursor) {
        let node = doc.get_dictionary(cursor).map_err(pdf_error)?;
        if let Ok(dict) = node.get_deref(b"Resources", doc) {
            resources = dict.as_dict().map_err(pdf_error)?.clone();
            break;
        }
        let Ok(parent) = node.get(b"Parent").and_then(Object::as_reference) else {
            break;
        };
        cursor = parent;
    }
    let mut fonts = resources
        .get_deref(b"Font", doc)
        .ok()
        .and_then(|object| object.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let mut suffix = 0;
    let name = loop {
        let name = format!("OfficeCLI_OCR{suffix}");
        if !fonts.has(name.as_bytes()) {
            break name;
        }
        suffix += 1;
    };
    fonts.set(name.as_bytes().to_vec(), Object::Reference(font));
    resources.set("Font", fonts);
    doc.get_dictionary_mut(page)
        .map_err(pdf_error)?
        .set("Resources", resources);
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_adds_invisible_unicode_without_replacing_source_content_or_shared_resources() {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let source = b"0.2 0.4 0.6 rg 0 0 288 360 re f\n";
        let original = doc.add_object(Stream::new(Dictionary::new(), source.to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => original,
        });
        let inherited =
            doc.add_object(dictionary! { "ProcSet" => vec![Object::Name(b"PDF".to_vec())] });
        doc.set_object(pages, dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 288.into(), 360.into()], "Resources" => inherited,
        });
        let root = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", root);

        let text = "Release 识别 𠀀";
        let line =
            OcrTextLine::from_display_box(text.to_string(), [28.0, 36.0, 204.0, 20.0], 360.0);
        append_ocr_text(
            &mut doc,
            &[OcrTextPage {
                page: 1,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                lines: vec![line],
            }],
        )
        .unwrap();

        assert_eq!(doc.get_page_contents(page)[1], original);
        assert_eq!(
            doc.get_object(original)
                .unwrap()
                .as_stream()
                .unwrap()
                .content,
            source
        );
        assert!(!doc.get_dictionary(inherited).unwrap().has(b"Font"));
        let page_content = doc.get_page_content(page).unwrap();
        assert!(std::str::from_utf8(&page_content)
            .unwrap()
            .contains("\n3 Tr\n"));
        assert_eq!(doc.extract_text(&[1]).unwrap().trim(), text);
    }
}
