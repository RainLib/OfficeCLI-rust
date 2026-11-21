//! Chromium can alias a font glyph to a different Unicode character (notably
//! CJK radicals). Correct the searchable text against the measured DOM without
//! touching glyph codes, outlines, positioning, or any page drawing stream.
use super::error;
use handler_common::HandlerError;
use lopdf::{content::Content, Document, Object, ObjectId};
use std::collections::BTreeMap;
use std::fmt::Write;
use unicode_normalization::UnicodeNormalization;

struct Font {
    cmap: ObjectId,
    width: usize,
}
struct Mapping {
    width: usize,
    values: BTreeMap<u32, String>,
}
struct Glyph {
    cmap: ObjectId,
    code: u32,
    text: String,
}

fn glyphs(
    document: &Document,
    page: ObjectId,
    maps: &mut BTreeMap<ObjectId, Mapping>,
) -> Result<Vec<Glyph>, HandlerError> {
    let mut fonts = BTreeMap::new();
    for (name, dictionary) in document.get_page_fonts(page).map_err(error)? {
        let cmap = dictionary
            .get(b"ToUnicode")
            .and_then(Object::as_reference)
            .map_err(|_| {
                error("Word PDF font has no Unicode map; text fidelity cannot be verified")
            })?;
        let width = if dictionary
            .get(b"Subtype")
            .and_then(Object::as_name)
            .map_err(error)?
            == b"Type0"
        {
            2
        } else {
            1
        };
        if let std::collections::btree_map::Entry::Vacant(entry) = maps.entry(cmap) {
            let stream = document
                .get_object(cmap)
                .and_then(Object::as_stream)
                .map_err(error)?;
            let bytes = stream.get_plain_content().map_err(error)?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(error("Word PDF font map exceeds the audit budget"));
            }
            let values = pdf_handler::content_stream::parse_to_unicode_cmap(
                &String::from_utf8_lossy(&bytes),
            )
            .into_iter()
            .collect();
            entry.insert(Mapping { width, values });
        }
        fonts.insert(name, Font { cmap, width });
    }
    fn collect(
        objects: &[Object],
        font: &Font,
        mapping: &Mapping,
        output: &mut Vec<Glyph>,
    ) -> Result<(), HandlerError> {
        for object in objects {
            match object {
                Object::String(bytes, _) => {
                    if bytes.len() % font.width != 0 {
                        return Err(error("Word PDF glyph encoding is incomplete"));
                    }
                    for bytes in bytes.chunks_exact(font.width) {
                        let code = bytes
                            .iter()
                            .fold(0u32, |code, byte| code * 256 + u32::from(*byte));
                        let text = mapping.values.get(&code).ok_or_else(||error("Word PDF contains an unmapped glyph; text fidelity cannot be verified"))?;
                        output.push(Glyph {
                            cmap: font.cmap,
                            code,
                            text: text.clone(),
                        });
                    }
                }
                Object::Array(array) => collect(array, font, mapping, output)?,
                _ => {}
            }
        }
        Ok(())
    }
    let content =
        Content::decode(&document.get_page_content(page).map_err(error)?).map_err(error)?;
    let mut current = None;
    let mut stack = Vec::new();
    let mut output = Vec::new();
    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => stack.push(current),
            "Q" => {
                current = stack
                    .pop()
                    .ok_or_else(|| error("Word PDF graphics state is invalid"))?
            }
            "Tf" => {
                current = Some(
                    fonts
                        .get(
                            operation
                                .operands
                                .first()
                                .ok_or_else(|| error("Word PDF font operand is missing"))?
                                .as_name()
                                .map_err(error)?,
                        )
                        .ok_or_else(|| error("Word PDF references an unknown font"))?,
                )
            }
            "Tj" | "TJ" | "'" | "\"" => {
                let font = current.ok_or_else(|| error("Word PDF text has no font"))?;
                collect(&operation.operands, font, &maps[&font.cmap], &mut output)?;
            }
            _ => {}
        }
    }
    Ok(output)
}

fn compact(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '\u{ad}')
        .collect()
}

pub(super) fn reconcile(
    document: &mut Document,
    expected: &[String],
) -> Result<bool, HandlerError> {
    let pages = document.get_pages();
    if pages.len() != expected.len() {
        return Err(error("Word PDF text audit page count differs from preview"));
    }
    let mut maps = BTreeMap::new();
    let mut targets = BTreeMap::<(ObjectId, u32), String>::new();
    let mut changed = false;
    for ((number, page), text) in pages.iter().zip(expected) {
        let glyphs = glyphs(document, *page, &mut maps)?;
        let actual: String = glyphs.iter().map(|glyph| compact(&glyph.text)).collect();
        let expected = compact(text);
        let source: Vec<char> = expected.chars().collect();
        let decoded: Vec<char> = actual.chars().collect();
        // Equal lengths and strong agreement are essential: never re-label
        // missing, reordered, or unexpectedly shaped text as a successful PDF.
        if source.len() != decoded.len()
            || source
                .iter()
                .zip(&decoded)
                .filter(|(a, b)| a.to_string().nfkc().ne(b.to_string().nfkc()))
                .count()
                * 20
                > source.len().max(1)
        {
            return Err(error(format!("Word PDF text on page {number} differs from preview ({} source characters, {} PDF characters); export stopped to avoid issuing an incomplete document",source.len(),decoded.len())));
        }
        let mut cursor = 0;
        for glyph in glyphs {
            let target: String = glyph
                .text
                .chars()
                .map(|ch| {
                    if ch.is_whitespace() || ch == '\u{ad}' {
                        ch
                    } else {
                        let ch = source[cursor];
                        cursor += 1;
                        ch
                    }
                })
                .collect();
            let key = (glyph.cmap, glyph.code);
            if targets
                .get(&key)
                .is_some_and(|previous| previous != &target)
            {
                return Err(error(
                    "Word PDF uses an ambiguous glyph alias; text fidelity cannot be preserved",
                ));
            }
            changed |= target != glyph.text;
            targets.insert(key, target);
        }
    }
    if !changed {
        return Ok(false);
    }
    let mut dirty = std::collections::BTreeSet::new();
    for ((id, code), text) in targets {
        let mapping = maps.get_mut(&id).expect("audited map");
        if mapping.values.get(&code) != Some(&text) {
            mapping.values.insert(code, text);
            dirty.insert(id);
        }
    }
    for id in dirty {
        let mapping = &maps[&id];
        let max = if mapping.width == 1 { "FF" } else { "FFFF" };
        let min = if mapping.width == 1 { "00" } else { "0000" };
        let mut cmap = format!("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /OfficeCLI-Preview-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<{min}> <{max}>\nendcodespacerange\n");
        let entries: Vec<_> = mapping.values.iter().collect();
        for chunk in entries.chunks(100) {
            writeln!(cmap, "{} beginbfchar", chunk.len()).expect("write string");
            for (code, text) in chunk {
                write!(cmap, "<{code:0width$X}> <", width = mapping.width * 2)
                    .expect("write string");
                for unit in text.encode_utf16() {
                    write!(cmap, "{unit:04X}").expect("write string");
                }
                cmap.push_str(">\n");
            }
            cmap.push_str("endbfchar\n");
        }
        cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        let stream = document
            .get_object_mut(id)
            .and_then(Object::as_stream_mut)
            .map_err(error)?;
        stream.set_plain_content(cmap.into_bytes());
        stream.compress().map_err(error)?;
    }
    // Re-read the serialized CMaps through the independent existing PDF reader.
    for ((number, page), expected) in pages.iter().zip(expected) {
        let actual: String = glyphs(document, *page, &mut BTreeMap::new())?
            .into_iter()
            .map(|glyph| glyph.text)
            .collect();
        if compact(&actual) != compact(expected) {
            return Err(error(format!(
                "Word PDF text verification failed on page {number}"
            )));
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn fixture(text: &str) -> (Document, ObjectId, ObjectId) {
        let mut document = Document::with_version("1.7");
        let root = document.new_object_id();
        let cmap = document.add_object(Stream::new(dictionary!{},b"1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<01> <53C8>\n<02> <7532>\nendbfchar\n".to_vec()));
        let font =
            document.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type3","ToUnicode"=>cmap});
        let data = format!("BT /F1 12 Tf <{text}> Tj ET").into_bytes();
        let content = document.add_object(Stream::new(dictionary! {}, data));
        let page = document.add_object(dictionary!{"Type"=>"Page","Parent"=>root,"MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font}},"Contents"=>content});
        document.objects.insert(
            root,
            dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into(),
        );
        let catalog = document.add_object(dictionary! {"Type"=>"Catalog","Pages"=>root});
        document.trailer.set("Root", catalog);
        (document, cmap, content)
    }

    #[test]
    fn corrects_cjk_unicode_alias_without_changing_painted_glyphs() {
        let (mut document, cmap, content) = fixture(&format!("{}01", "02".repeat(20)));
        let before = document
            .get_object(content)
            .unwrap()
            .as_stream()
            .unwrap()
            .content
            .clone();
        assert!(reconcile(&mut document, &[format!("{}口", "甲".repeat(20))]).unwrap());
        assert_eq!(
            document
                .get_object(content)
                .unwrap()
                .as_stream()
                .unwrap()
                .content,
            before
        );
        let mapping = String::from_utf8(
            document
                .get_object(cmap)
                .unwrap()
                .as_stream()
                .unwrap()
                .get_plain_content()
                .unwrap(),
        )
        .unwrap();
        assert!(mapping.contains("<01> <53E3>"));
        assert!(!reconcile(&mut document, &[format!("{}口", "甲".repeat(20))]).unwrap());
    }

    #[test]
    fn restores_compatibility_radicals_even_when_they_dominate_a_page() {
        let (mut document, cmap, _) = fixture("01010101");
        document
            .get_object_mut(cmap)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .set_plain_content(b"1 beginbfchar\n<01> <2F08>\nendbfchar\n".to_vec());
        assert!(reconcile(&mut document, &["人人人人".into()]).unwrap());
    }

    #[test]
    fn refuses_missing_text_and_conflicting_aliases() {
        let (mut document, _, _) = fixture(&format!("{}0101", "02".repeat(40)));
        assert!(
            reconcile(&mut document, &[format!("{}口又", "甲".repeat(40))])
                .unwrap_err()
                .to_string()
                .contains("ambiguous")
        );
        assert!(reconcile(&mut document, &["missing text".into()]).is_err());
    }
}
