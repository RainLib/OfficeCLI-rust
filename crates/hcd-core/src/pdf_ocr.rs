use crate::{html::escape_text, Bundle, HcdError, HcdManifest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_OCR_PAGES_PER_PATCH: usize = 8;
pub const MAX_OCR_LINES_PER_PAGE: usize = 1_024;
pub const MAX_OCR_LINE_CHARS: usize = 1_024;
pub const OCR_NODE_KIND: &str = "pdf-ocr";
const OCR_PAGE_MARKER: &str = " data-hcd-ocr-layer=\"true\"";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOcrBounds {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl PdfOcrBounds {
    fn valid(self) -> bool {
        [self.left, self.top, self.right, self.bottom]
            .into_iter()
            .all(|value| (0.0..=1.0).contains(&value))
            && self.right - self.left >= 0.00001
            && self.bottom - self.top >= 0.00001
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOcrLine {
    pub text: String,
    pub bounds: PdfOcrBounds,
    pub confidence: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOcrPage {
    /// Physical page number in the immutable PDF. The HCD view may reorder it.
    pub page: u32,
    pub lines: Vec<PdfOcrLine>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOcrPageStatus {
    pub page: u32,
    pub sequence: usize,
    pub recognized: bool,
    pub has_source_text: bool,
}

pub fn valid_ocr_text(text: &str) -> bool {
    text.chars().count() <= MAX_OCR_LINE_CHARS
        && !text
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{fffe}' | '\u{ffff}'))
}

pub(crate) fn valid_source_anchor(anchor: &crate::SourceAnchor) -> bool {
    let Some(page) = anchor
        .part
        .strip_prefix("pdf/pages/")
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return false;
    };
    let order = anchor.text_ordinal;
    anchor.node_kind == OCR_NODE_KIND
        && (1..=100_000).contains(&page)
        && (1..=MAX_OCR_LINES_PER_PAGE as u64).contains(&order)
        && anchor.part == format!("pdf/pages/{page}")
        && anchor.paragraph_id.as_deref() == Some(format!("/page[{page}]/ocr[{order}]").as_str())
        && anchor.text_id.is_none()
        && anchor.editable
}

pub(crate) fn validate_ocr_pages(pages: &[PdfOcrPage]) -> Result<(), HcdError> {
    if pages.is_empty() || pages.len() > MAX_OCR_PAGES_PER_PATCH {
        return Err(HcdError::InvalidPatch(format!(
            "recognize up to {MAX_OCR_PAGES_PER_PATCH} PDF pages per patch"
        )));
    }
    let mut seen = BTreeSet::new();
    for page in pages {
        if !(1..=100_000).contains(&page.page) || !seen.insert(page.page) {
            return Err(HcdError::InvalidPatch(
                "invalid or repeated OCR page".into(),
            ));
        }
        if page.lines.is_empty() || page.lines.len() > MAX_OCR_LINES_PER_PAGE {
            return Err(HcdError::InvalidPatch(format!(
                "page {} must contain 1–{MAX_OCR_LINES_PER_PAGE} recognized lines",
                page.page
            )));
        }
        for line in &page.lines {
            if !valid_ocr_text(&line.text)
                || line.text.trim().is_empty()
                || !line.bounds.valid()
                || line.confidence > 100
            {
                return Err(HcdError::InvalidPatch(
                    "invalid OCR line or geometry".into(),
                ));
            }
        }
    }
    Ok(())
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    tag.split_once(&format!(" {name}=\""))
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(value, _)| value)
}

fn tag_number(tag: &str, name: &str) -> Option<u32> {
    attr(tag, name)?.parse().ok()
}

fn dimensions(html: &str) -> Result<(f32, f32), HcdError> {
    let opening = html.split_once('>').map(|(tag, _)| tag).unwrap_or_default();
    if !opening.starts_with("<section class=\"hcd-pdf-page\"") {
        return Err(HcdError::InvalidBundle("missing PDF page geometry".into()));
    }
    let style = attr(opening, "style").unwrap_or_default();
    let point =
        |name: &str| style_value(style, name).filter(|value| *value > 0.0 && *value <= 14_400.0);
    point("width:")
        .zip(point("height:"))
        .ok_or_else(|| HcdError::InvalidBundle("invalid PDF page geometry".into()))
}

fn style_value(style: &str, property: &str) -> Option<f32> {
    style
        .split(';')
        .find_map(|value| value.trim().strip_prefix(property))?
        .strip_suffix("pt")?
        .parse::<f32>()
        .ok()
        .filter(|value| value.is_finite())
}

fn has_ocr_layer(html: &str) -> bool {
    html.split_once('>')
        .is_some_and(|(tag, _)| tag.contains(OCR_PAGE_MARKER))
}

fn visible_pages(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Option<BTreeSet<u32>>, HcdError> {
    let layout = crate::pdf_page_layout(bundle, manifest)?;
    Ok((!layout.is_empty()).then(|| {
        layout
            .into_iter()
            .filter_map(|page| page.source_page)
            .collect()
    }))
}

pub fn pdf_ocr_page_status(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<PdfOcrPageStatus>, HcdError> {
    if manifest.source.format != "pdf" {
        return Err(HcdError::Unsupported(
            "OCR pages require a PDF document".into(),
        ));
    }
    let visible = visible_pages(bundle, manifest)?;
    let mut pages: Vec<PdfOcrPageStatus> = Vec::new();
    let mut source_page = 0;
    for index in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, index)?.chunks {
            if !chunk.continuation {
                source_page += 1;
            }
            if visible
                .as_ref()
                .is_some_and(|pages| !pages.contains(&source_page))
            {
                continue;
            }
            if !chunk.continuation {
                let html = bundle.read_chunk_verified(&chunk)?;
                pages.push(PdfOcrPageStatus {
                    page: source_page,
                    sequence: chunk.sequence,
                    recognized: has_ocr_layer(&html),
                    has_source_text: false,
                });
            }
            let Some(status) = pages.last_mut() else {
                continue;
            };
            if chunk.text_chars == 0 || status.has_source_text {
                continue;
            }
            let map = bundle.read_map_verified(&chunk)?;
            status.has_source_text = map.entries.iter().any(|entry| {
                matches!(
                    entry.source.node_kind.as_str(),
                    "pdf-text" | "pdf-source-ocr"
                ) && !entry.source.created_in_hcd
            });
        }
    }
    Ok(pages)
}

fn source_text_boxes(html: &str, page: (f32, f32)) -> impl Iterator<Item = PdfOcrBounds> + '_ {
    html.split("<p class=\"hcd-pdf-text\"")
        .skip(1)
        .filter_map(move |tail| {
            let (tag, _) = tail.split_once('>')?;
            if !matches!(attr(tag, "data-hcd-mapping"), Some("source" | "source-ocr")) {
                return None;
            }
            let style = attr(tag, "style")?;
            let left = style_value(style, "left:")?;
            let top = style_value(style, "top:")?;
            let width = style_value(style, "width:")?;
            let height = style_value(style, "height:")?;
            Some(PdfOcrBounds {
                left: left / page.0,
                top: top / page.1,
                right: (left + width) / page.0,
                bottom: (top + height) / page.1,
            })
        })
}

fn overlap(bounds: PdfOcrBounds, native: PdfOcrBounds) -> bool {
    let x = (bounds.right.min(native.right) - bounds.left.max(native.left)).max(0.0);
    let y = (bounds.bottom.min(native.bottom) - bounds.top.max(native.top)).max(0.0);
    x * y >= 0.62 * (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
}

pub(crate) fn prepare_ocr_pages(
    bundle: &Bundle,
    manifest: &HcdManifest,
    requests: &[PdfOcrPage],
) -> Result<BTreeMap<String, PdfOcrPage>, HcdError> {
    let visible = visible_pages(bundle, manifest)?;
    let mut wanted: BTreeMap<_, _> = requests
        .iter()
        .map(|page| (page.page, page.clone()))
        .collect();
    let mut result = BTreeMap::new();
    let mut current_page = 0u32;
    let mut chunk_id = String::new();
    let mut size = (0.0, 0.0);
    let mut active: Option<PdfOcrPage> = None;
    for index in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, index)?.chunks {
            if !chunk.continuation {
                if let Some(page) = active.take() {
                    if !page.lines.is_empty() {
                        result.insert(chunk_id.clone(), page);
                    }
                }
                if wanted.is_empty() {
                    break;
                }
                current_page += 1;
                active = wanted.remove(&current_page);
                if active.is_some() {
                    if visible
                        .as_ref()
                        .is_some_and(|pages| !pages.contains(&current_page))
                    {
                        return Err(HcdError::InvalidPatch(format!(
                            "PDF page {current_page} was removed"
                        )));
                    }
                    let html = bundle.read_chunk_verified(&chunk)?;
                    if has_ocr_layer(&html) {
                        return Err(HcdError::RevisionConflict(format!(
                            "PDF page {current_page} already has a recognized layer"
                        )));
                    }
                    size = dimensions(&html)?;
                    chunk_id = chunk.chunk_id.clone();
                }
            }
            if let Some(page) = active.as_mut().filter(|_| chunk.text_chars != 0) {
                let html = bundle.read_chunk_verified(&chunk)?;
                for native in source_text_boxes(&html, size) {
                    page.lines.retain(|line| !overlap(line.bounds, native));
                }
            }
        }
        if wanted.is_empty() && active.is_none() {
            break;
        }
    }
    if let Some(page) = active.filter(|page| !page.lines.is_empty()) {
        result.insert(chunk_id, page);
    }
    if !wanted.is_empty() {
        return Err(HcdError::InvalidPatch(
            "OCR targeted a missing PDF page".into(),
        ));
    }
    if result.is_empty() {
        return Err(HcdError::InvalidPatch(
            "no new scanned text was found outside existing PDF text".into(),
        ));
    }
    Ok(result)
}

pub(crate) fn write_ocr_page(
    html: &mut String,
    map: &mut crate::ChunkSourceMap,
    document_id: &str,
    page: &PdfOcrPage,
) -> Result<Vec<(String, String)>, HcdError> {
    let (width, height) = dimensions(html)?;
    let section = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("missing PDF page tag".into()))?;
    if tag_number(&html[..section], "data-hcd-page") != Some(page.page) {
        return Err(HcdError::InvalidBundle(
            "OCR layer does not match its physical page".into(),
        ));
    }
    let end = html
        .rfind("</section>")
        .ok_or_else(|| HcdError::InvalidBundle("missing PDF page end".into()))?;
    let part = format!("pdf/pages/{}", page.page);
    let mut rendered = String::new();
    let mut nodes = Vec::new();
    for (index, line) in page.lines.iter().enumerate() {
        let order = (index + 1).to_string();
        let node_id = crate::stable_node_id(&[document_id, &part, "ocr-line", &order]);
        let node_hash = crate::hash_bytes(line.text.as_bytes());
        let source_path = format!("/page[{}]/ocr[{order}]", page.page);
        let PdfOcrBounds {
            left,
            top,
            right,
            bottom,
        } = line.bounds;
        let (x, y, w, h) = (
            left * width,
            top * height,
            (right - left) * width,
            (bottom - top) * height,
        );
        rendered.push_str(&format!(
            "<p class=\"hcd-pdf-text\" data-hcd-text-node=\"{node_id}\" data-hcd-mapping=\"ocr\" data-hcd-ocr-bounds=\"{left},{top},{right},{bottom}\" data-hcd-ocr-confidence=\"{}\" style=\"position:absolute;left:{x:.3}pt;top:{y:.3}pt;width:{w:.3}pt;height:{h:.3}pt;font-size:{h:.3}pt\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span></p>",
            line.confidence, escape_text(&line.text)
        ));
        map.entries.push(crate::NodeMapEntry {
            node_id: node_id.clone(),
            node_hash,
            source: crate::SourceAnchor {
                part: part.clone(),
                text_ordinal: index as u64 + 1,
                paragraph_id: Some(source_path),
                text_id: None,
                node_kind: OCR_NODE_KIND.into(),
                editable: true,
                source_cell_ref: None,
                created_in_hcd: true,
            },
        });
        nodes.push((node_id, line.text.clone()));
    }
    html.insert_str(end, &rendered);
    html.insert_str(section, OCR_PAGE_MARKER);
    Ok(nodes)
}

pub fn pdf_ocr_layers(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<PdfOcrPage>, HcdError> {
    let mut pages = Vec::new();
    if manifest.revision == 0 {
        return Ok(pages);
    }
    for index in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, index)?.chunks {
            if chunk.continuation || chunk.node_count == 0 {
                continue;
            }
            let html = bundle.read_chunk_verified(&chunk)?;
            if !has_ocr_layer(&html) {
                continue;
            }
            let page = tag_number(
                html.split_once('>').map(|(tag, _)| tag).unwrap_or_default(),
                "data-hcd-page",
            )
            .ok_or_else(|| HcdError::InvalidBundle("recognized layer has no source page".into()))?;
            let text_nodes = crate::extract_html_text_nodes(&html)?;
            let map = bundle.read_map_verified(&chunk)?;
            let mut lines = Vec::new();
            for entry in map
                .entries
                .iter()
                .filter(|entry| entry.source.node_kind == OCR_NODE_KIND)
            {
                let Some(text) = text_nodes.get(&entry.node_id) else {
                    return Err(HcdError::InvalidBundle(
                        "missing recognized text node".into(),
                    ));
                };
                if text.trim().is_empty() {
                    continue;
                }
                let expected = format!(" data-hcd-text-node=\"{}\"", entry.node_id);
                let tag = html
                    .split_once(&expected)
                    .and_then(|(_, tail)| tail.split_once('>'))
                    .map(|(tag, _)| tag)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("missing recognized text bounds".into())
                    })?;
                let coords: Vec<f32> = attr(tag, "data-hcd-ocr-bounds")
                    .unwrap_or_default()
                    .split(',')
                    .filter_map(|value| value.parse().ok())
                    .collect();
                let [left, top, right, bottom] = coords.as_slice() else {
                    return Err(HcdError::InvalidBundle(
                        "invalid recognized text bounds".into(),
                    ));
                };
                let bounds = PdfOcrBounds {
                    left: *left,
                    top: *top,
                    right: *right,
                    bottom: *bottom,
                };
                if !bounds.valid() || !valid_ocr_text(text) {
                    return Err(HcdError::InvalidBundle(
                        "recognized text layer is outside bounds".into(),
                    ));
                }
                lines.push(PdfOcrLine {
                    text: text.clone(),
                    bounds,
                    confidence: tag_number(tag, "data-hcd-ocr-confidence")
                        .unwrap_or(0)
                        .min(100) as u8,
                });
            }
            if !lines.is_empty() {
                pages.push(PdfOcrPage { page, lines });
            }
        }
    }
    Ok(pages)
}
