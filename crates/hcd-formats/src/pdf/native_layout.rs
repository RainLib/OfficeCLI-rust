//! Associate candidate font segments with original, stable HCD text identities.
use super::*;
use hcd_core::{PatchOperation, PdfNodeTextLayout, PdfTextLayout, PdfTextRunLayout};
use std::collections::{BTreeMap, BTreeSet};

fn pdf_page(part: &str) -> Option<u32> {
    part.strip_prefix("pdf/pages/")?.parse().ok()
}
fn error(value: impl ToString) -> HcdError {
    HcdError::InvalidBundle(value.to_string())
}
fn union(rects: impl Iterator<Item = [f64; 4]>) -> [f64; 4] {
    let mut result: Option<[f64; 4]> = None;
    for [x, y, w, h] in rects {
        result = Some(match result {
            None => [x, y, w, h],
            Some([a, b, c, d]) => {
                let left = a.min(x);
                let top = b.min(y);
                [
                    left,
                    top,
                    (a + c).max(x + w) - left,
                    (b + d).max(y + h) - top,
                ]
            }
        });
    }
    result.unwrap_or([0.; 4])
}
// An empty rendered text group has no glyph bounds. Retain the previous
// canonical position so the user can still find and edit the same node.
fn prior_rectangles(html: &str) -> Result<BTreeMap<String, ([f64; 4], [f64; 4])>, HcdError> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(html);
    let mut result = BTreeMap::new();
    loop {
        match reader.read_event().map_err(error)? {
            Event::Start(tag) | Event::Empty(tag) => {
                if tag.name().as_ref() != b"p" {
                    continue;
                }
                let mut id = None;
                let mut view = None;
                let mut source = None;
                for attr in tag.attributes() {
                    let attr = attr.map_err(error)?;
                    let value = attr
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(error)?;
                    match attr.key.as_ref() {
                        b"data-hcd-text-node" => id = Some(value.into_owned()),
                        b"data-hcd-bbox" | b"data-hcd-source-bbox" => {
                            let values = value
                                .split(',')
                                .map(str::parse::<f64>)
                                .collect::<Result<Vec<_>, _>>()
                                .map_err(error)?;
                            let rect: [f64; 4] = values
                                .try_into()
                                .map_err(|_| error("invalid PDF text rectangle"))?;
                            if attr.key.as_ref() == b"data-hcd-bbox" {
                                view = Some(rect)
                            } else {
                                source = Some(rect)
                            }
                        }
                        _ => {}
                    }
                }
                if let (Some(id), Some(view), Some(source)) = (id, view, source) {
                    let pair = (view, source);
                    if result.insert(id, pair).is_some() {
                        return Err(error("duplicate PDF text identity"));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(result)
}
fn family(name: Option<&str>) -> (String, bool, bool) {
    let name = name.unwrap_or("Inherited");
    let clean = name.split_once('+').map(|(_, name)| name).unwrap_or(name);
    let lower = clean.to_lowercase();
    let label = if lower.contains("notosanssc") {
        "Noto Sans SC"
    } else if lower.contains("notoemoji") {
        "Noto Emoji"
    } else {
        clean
    };
    (
        label.to_string(),
        lower.contains("bold") || lower.contains("heavy") || lower.contains("black"),
        lower.contains("italic") || lower.contains("oblique"),
    )
}
pub(super) fn collect(
    bundle: &Bundle,
    manifest: &HcdManifest,
    candidate: &Path,
    pages: &BTreeSet<u32>,
    operations: &[PatchOperation],
) -> Result<Vec<PdfNodeTextLayout>, HcdError> {
    let reader =
        pdf_handler::reader::PdfReader::open(&candidate.to_string_lossy()).map_err(error)?;
    let page_ids = reader.document().get_pages();
    let mut splices: BTreeMap<String, Vec<(usize, usize, String)>> = BTreeMap::new();
    for operation in operations {
        if let PatchOperation::TextSplice {
            node_id,
            start,
            delete_count,
            insert_text,
            ..
        } = operation
        {
            splices.entry(node_id.clone()).or_default().push((
                *start,
                *delete_count,
                insert_text.clone(),
            ));
        }
    }
    let mut nodes: BTreeMap<u32, Vec<(String, String, String, u64, Option<([f64; 4], [f64; 4])>)>> =
        BTreeMap::new();
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, index)?.chunks {
            let map = bundle.read_map_verified(&descriptor)?;
            if !map.entries.iter().any(|entry| {
                entry.source.node_kind == "pdf-text"
                    && pdf_page(&entry.source.part).is_some_and(|page| pages.contains(&page))
            }) {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let mut text = hcd_core::extract_html_text_nodes(&html)?;
            let rectangles = prior_rectangles(&html)?;
            for entry in map
                .entries
                .into_iter()
                .filter(|entry| entry.source.node_kind == "pdf-text")
            {
                let Some(page) = pdf_page(&entry.source.part).filter(|page| pages.contains(page))
                else {
                    continue;
                };
                let value = text
                    .remove(&entry.node_id)
                    .ok_or_else(|| error("PDF layout canonical text missing"))?;
                if hash_bytes(value.as_bytes()) != entry.node_hash {
                    return Err(error("PDF layout canonical precondition mismatch"));
                }
                let value = if let Some(changes) = splices.get(&entry.node_id) {
                    splice_chars(&value, changes)?
                } else {
                    value
                };
                let previous = rectangles.get(&entry.node_id).copied();
                nodes.entry(page).or_default().push((
                    entry.node_id,
                    entry.node_hash,
                    value,
                    entry.source.text_ordinal,
                    previous,
                ));
            }
        }
    }
    let mut output = Vec::new();
    for (page, nodes) in nodes {
        let page_id = *page_ids
            .get(&page)
            .ok_or_else(|| error("candidate page missing"))?;
        let viewport = Viewport::from_document(reader.document(), page_id)?;
        let parsed = reader
            .parse_page_text_blocks_bounded(
                page as usize,
                MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                MAX_HCD_PDF_AUX_STREAM_BYTES,
            )
            .map_err(error)?;
        let mut groups: BTreeMap<usize, Vec<&pdf_handler::content_stream::PdfTextBlock>> =
            BTreeMap::new();
        for block in &parsed.text_blocks {
            if let Some(group) = block.source_group {
                groups.entry(group).or_default().push(block);
            }
        }
        for (node_id, expected_hash, text, ordinal, previous) in nodes {
            let segments = groups.get(&(ordinal as usize)).cloned().unwrap_or_default();
            let actual = segments
                .iter()
                .map(|block| sanitize_pdf_text(block.text.clone()).0)
                .collect::<String>();
            if actual != text {
                return Err(error(format!(
                    "candidate PDF text identity mismatch for {node_id}"
                )));
            }
            let mut runs = Vec::new();
            let mut source_rects = Vec::new();
            for block in segments {
                let value = sanitize_pdf_text(block.text.clone()).0;
                if value.is_empty() {
                    continue;
                }
                let bbox = &block.bbox;
                let source = [
                    bbox.x as f64,
                    bbox.y as f64,
                    bbox.width as f64,
                    bbox.height as f64,
                ];
                source_rects.push(source);
                let baseline =
                    viewport.to_view([block.baseline[0] as f64, block.baseline[1] as f64, 0., 0.]);
                let (family, bold, italic) = family(
                    block
                        .style
                        .font_name
                        .as_ref()
                        .and_then(|name| parsed.font_map.get(name))
                        .and_then(|font| font.base_font.as_deref()),
                );
                runs.push(PdfTextRunLayout {
                    chars: value.chars().count(),
                    rect: viewport.to_view(source),
                    baseline: [baseline[0], baseline[1]],
                    size_pt: block.style.font_size.unwrap_or(12.) as f64,
                    family,
                    bold,
                    italic,
                });
            }
            let (rect, source_rect) = if text.is_empty() {
                previous.ok_or_else(|| error("empty PDF text has no previous position"))?
            } else {
                (
                    union(runs.iter().map(|run| run.rect)),
                    union(source_rects.into_iter()),
                )
            };
            let layout = PdfTextLayout {
                version: 1,
                text_hash: hash_bytes(text.as_bytes()),
                rect,
                source_rect,
                runs,
            };
            layout.validate(&text)?;
            output.push(PdfNodeTextLayout {
                node_id,
                expected_hash,
                layout,
            });
        }
    }
    Ok(output)
}
