//! Searchable canonical text over final page pixels. Never paints replacement
//! glyphs, runs OCR, or reads live editor/awareness state.
use super::error;
use handler_common::HandlerError;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use quick_xml::events::Event;
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
pub(super) struct TextBox {
    text: String,
    rect: [f32; 4],
}
#[derive(Debug)]
pub(super) struct Fragment {
    pub page: u32,
    pub rotation: u16,
    pub width: f32,
    pub height: f32,
    texts: Vec<TextBox>,
    node_count: usize,
}

pub(super) fn parse(html: &str) -> Result<Fragment, HandlerError> {
    let mut values = hcd_core::extract_html_text_nodes(html).map_err(error)?;
    let mut layouts = hcd_core::extract_pdf_text_layouts(html).map_err(error)?;
    let mut reader = quick_xml::Reader::from_str(html);
    let mut page = None;
    let mut texts = Vec::new();
    let mut node_count = 0;
    loop {
        let tag = match reader.read_event().map_err(error)? {
            Event::Start(tag) | Event::Empty(tag) => tag,
            Event::Eof => break,
            _ => continue,
        };
        let attrs: HashMap<String, String> = tag
            .attributes()
            .map(|attr| {
                let attr = attr.map_err(error)?;
                Ok((
                    String::from_utf8(attr.key.as_ref().to_vec()).map_err(error)?,
                    attr.decode_and_unescape_value(reader.decoder())
                        .map_err(error)?
                        .into_owned(),
                ))
            })
            .collect::<Result<_, HandlerError>>()?;
        let has_class = |name| {
            attrs
                .get("class")
                .is_some_and(|value| value.split_whitespace().any(|class| class == name))
        };
        let style = attrs.get("style").map(String::as_str).unwrap_or("");
        let point = |name: &str| -> Result<f32, HandlerError> {
            let value = style
                .split(';')
                .filter_map(|part| part.split_once(':'))
                .find(|(key, _)| key.trim() == name)
                .and_then(|(_, value)| value.trim().strip_suffix("pt"))
                .ok_or_else(|| error(format!("PDF text layer has no {name} geometry")))?;
            let value: f32 = value.trim().parse().map_err(error)?;
            if !value.is_finite() || value.abs() > 57_600. {
                return Err(error("PDF text geometry exceeds safe limits"));
            }
            Ok(value)
        };
        if tag.name().as_ref() == b"section" && has_class("hcd-pdf-page") {
            if page.is_some() {
                return Err(error("multiple PDF pages in one chunk"));
            }
            let number: u32 = attrs
                .get("data-hcd-page")
                .ok_or_else(|| error("missing PDF page number"))?
                .parse()
                .map_err(error)?;
            let rotation: u16 = attrs
                .get("data-hcd-page-rotation")
                .map(String::as_str)
                .unwrap_or("0")
                .parse()
                .map_err(error)?;
            let (width, height) = (point("width")?, point("height")?);
            if number == 0 || ![0, 90, 180, 270].contains(&rotation) || width <= 0. || height <= 0.
            {
                return Err(error("invalid PDF page geometry"));
            }
            page = Some((number, rotation, width, height));
        }
        if tag.name().as_ref() == b"p" && has_class("hcd-pdf-text") {
            let id = attrs
                .get("data-hcd-text-node")
                .ok_or_else(|| error("missing PDF text identity"))?;
            let text = values
                .remove(id)
                .ok_or_else(|| error("missing or duplicated canonical PDF text"))?;
            if !text.trim().is_empty() {
                node_count += 1;
                if let Some(layout) = layouts.remove(id) {
                    let chars: Vec<_> = text.chars().collect();
                    let mut offset = 0;
                    for run in layout.runs {
                        let end = offset + run.chars;
                        texts.push(TextBox {
                            text: chars[offset..end].iter().collect(),
                            rect: run.rect.map(|value| value as f32),
                        });
                        offset = end;
                    }
                    continue;
                }
                let rect = [
                    point("left")?,
                    point("top")?,
                    point("width")?,
                    point("height")?,
                ];
                if rect[2] < 0. || rect[3] < 0. {
                    return Err(error("negative PDF text dimensions"));
                }
                texts.push(TextBox { text, rect });
            }
        }
    }
    if values.values().any(|text| !text.trim().is_empty()) {
        return Err(error("unpositioned canonical PDF text"));
    }
    let (page, rotation, width, height) = page.ok_or_else(|| error("missing PDF page geometry"))?;
    Ok(Fragment {
        page,
        rotation,
        width,
        height,
        texts,
        node_count,
    })
}

struct Font {
    name: String,
    id: ObjectId,
    widths: HashMap<char, f32>,
    ascent: f32,
    descent: f32,
}
#[derive(Default)]
pub(super) struct TextLayer {
    font: Option<Font>,
}
impl TextLayer {
    pub fn append(
        &mut self,
        doc: &mut Document,
        page: ObjectId,
        fragment: &Fragment,
    ) -> Result<usize, HandlerError> {
        let chars: HashSet<char> = fragment
            .texts
            .iter()
            .flat_map(|text| text.text.chars())
            .filter(|c| !c.is_control())
            .collect();
        if chars.is_empty() {
            return Ok(0);
        }
        if !self
            .font
            .as_ref()
            .is_some_and(|font| chars.iter().all(|c| font.widths.contains_key(c)))
        {
            let name = pdf_handler::font_embedder::ensure_invisible_text_font(doc, page, &chars)?
                .ok_or_else(|| error("missing PDF text font"))?;
            let resources = doc
                .get_dictionary(page)
                .map_err(error)?
                .get(b"Resources")
                .map_err(error)?
                .as_dict()
                .map_err(error)?;
            let id = resources
                .get(b"Font")
                .map_err(error)?
                .as_dict()
                .map_err(error)?
                .get(name.as_bytes())
                .map_err(error)?
                .as_reference()
                .map_err(error)?;
            let font = doc.get_dictionary(id).map_err(error)?;
            let cmap = doc
                .get_object(
                    font.get(b"ToUnicode")
                        .map_err(error)?
                        .as_reference()
                        .map_err(error)?,
                )
                .map_err(error)?
                .as_stream()
                .map_err(error)?
                .get_plain_content()
                .map_err(error)?;
            let cmap =
                pdf_handler::content_stream::parse_to_unicode_cmap(&String::from_utf8_lossy(&cmap));
            let descendant = font
                .get(b"DescendantFonts")
                .map_err(error)?
                .as_array()
                .map_err(error)?[0]
                .as_reference()
                .map_err(error)?;
            let descendant = doc.get_dictionary(descendant).map_err(error)?;
            let widths = descendant
                .get(b"W")
                .map_err(error)?
                .as_array()
                .map_err(error)?[1]
                .as_array()
                .map_err(error)?;
            let widths = cmap
                .into_iter()
                .map(|(cid, value)| {
                    let mut chars = value.chars();
                    let c = chars.next().ok_or_else(|| error("empty font mapping"))?;
                    if chars.next().is_some() {
                        return Err(error("ambiguous font mapping"));
                    }
                    Ok((
                        c,
                        widths
                            .get(cid as usize)
                            .ok_or_else(|| error("missing CID width"))?
                            .as_float()
                            .map_err(error)?,
                    ))
                })
                .collect::<Result<HashMap<_, _>, HandlerError>>()?;
            let descriptor = doc
                .get_dictionary(
                    descendant
                        .get(b"FontDescriptor")
                        .map_err(error)?
                        .as_reference()
                        .map_err(error)?,
                )
                .map_err(error)?;
            self.font = Some(Font {
                name,
                id,
                widths,
                ascent: descriptor
                    .get(b"Ascent")
                    .map_err(error)?
                    .as_float()
                    .map_err(error)?,
                descent: descriptor
                    .get(b"Descent")
                    .map_err(error)?
                    .as_float()
                    .map_err(error)?,
            });
        }
        let font = self.font.as_ref().expect("initialized text font");
        let resources = doc
            .get_dictionary_mut(page)
            .map_err(error)?
            .get_mut(b"Resources")
            .map_err(error)?
            .as_dict_mut()
            .map_err(error)?;
        if !resources.has(b"Font") {
            resources.set("Font", dictionary! {});
        }
        resources
            .get_mut(b"Font")
            .map_err(error)?
            .as_dict_mut()
            .map_err(error)?
            .set(font.name.as_bytes(), font.id);
        let mut content = String::from("q\nBT\n3 Tr\n");
        for text in &fragment.texts {
            let lines: Vec<_> = text.text.split('\n').collect();
            for (line_index, line) in lines.iter().enumerate() {
                let line: String = line.chars().filter(|c| !c.is_control()).collect();
                if line.trim().is_empty() {
                    continue;
                }
                let [x, y, w, h] = text.rect;
                let vertical = fragment.rotation == 90 || fragment.rotation == 270;
                let (length, thickness) = if vertical {
                    (h.max(0.1), w.max(0.1) / lines.len() as f32)
                } else {
                    (w.max(0.1), h.max(0.1) / lines.len() as f32)
                };
                let size = thickness * 1000. / (font.ascent - font.descent);
                let descender = -font.descent * size / 1000.;
                let natural = line.chars().map(|c| font.widths[&c]).sum::<f32>() * size / 1000.;
                // Zero-advance Unicode still belongs in extraction; a nominal
                // advance only supplies a bounded selection rectangle.
                let scale = length / natural.max(0.001) * 100.;
                let shift = line_index as f32 * thickness;
                let matrix = match fragment.rotation {
                    90 => [0., -1., 1., 0., x + descender + shift, fragment.height - y],
                    180 => [
                        -1.,
                        0.,
                        0.,
                        -1.,
                        x + w,
                        fragment.height - y - descender - shift,
                    ],
                    270 => [
                        0.,
                        1.,
                        -1.,
                        0.,
                        x + w - descender - shift,
                        fragment.height - y - h,
                    ],
                    _ => [
                        1.,
                        0.,
                        0.,
                        1.,
                        x,
                        fragment.height - y - thickness + descender - shift,
                    ],
                };
                let encoded = pdf_handler::content_stream::encode_chunk_with_font(
                    doc, page, &font.name, &line,
                )?;
                content.push_str(&format!(
                    "/{} {size} Tf {scale} Tz {} {} {} {} {} {} Tm {encoded} Tj\n",
                    font.name, matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]
                ));
            }
        }
        content.push_str("ET\nQ\n");
        let mut stream = Stream::new(dictionary! {}, content.into_bytes());
        stream.compress().map_err(error)?;
        let id = doc.add_object(stream);
        let page = doc.get_dictionary_mut(page).map_err(error)?;
        let previous = page.get(b"Contents").map_err(error)?.clone();
        let mut contents = match previous {
            Object::Array(contents) => contents,
            other => vec![other],
        };
        contents.push(Object::Reference(id));
        page.set("Contents", contents);
        Ok(fragment.node_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fragment(body: &str, rotation: &str) -> String {
        format!(
            r#"<section data-hcd-page="1" data-hcd-page-rotation="{rotation}" class="hcd-pdf-page" style="height:200pt;width:300pt">{body}</section>"#
        )
    }
    const TEXT: &str = r#"<p style="height:12pt;top:20pt;width:80pt;left:10pt" data-hcd-text-node="text" class="hcd-pdf-text"><span data-hcd-node-hash="hash" data-hcd-id="text">中&amp;A😀</span></p>"#;
    #[test]
    fn parses_only_canonical_positioned_text_and_refuses_silent_loss() {
        for rotation in ["0", "90", "180", "270"] {
            let parsed = parse(&fragment(TEXT, rotation)).unwrap();
            assert_eq!(parsed.texts[0].text, "中&A😀");
            assert_eq!(parsed.texts[0].rect, [10., 20., 80., 12.]);
        }
        assert!(parse(&fragment(&format!("{TEXT}{TEXT}"), "0")).is_err());
        assert!(parse(&fragment(
            r#"<span data-hcd-id="unplaced" data-hcd-node-hash="h">Do not drop</span>"#,
            "0"
        ))
        .is_err());
        for bad in [
            TEXT.replace("12pt", "NaNpt"),
            TEXT.replace("80pt", "-1pt"),
            TEXT.replace("20pt", "60000pt"),
        ] {
            assert!(parse(&fragment(&bad, "0")).is_err());
        }
        assert!(parse(&fragment(TEXT, "45")).is_err());
    }
    #[test]
    fn scan_only_page_has_no_fabricated_text_or_font() {
        let parsed = parse(&fragment("<img alt=\"Not OCR text\"/>", "0")).unwrap();
        let mut document = Document::with_version("1.5");
        let page = document.add_object(dictionary! {"Type"=>"Page"});
        assert_eq!(
            TextLayer::default()
                .append(&mut document, page, &parsed)
                .unwrap(),
            0
        );
        assert_eq!(document.objects.len(), 1);
    }
}
