use super::*;
use crate::docx_review::{restored_text_ordinal, TrackedChange, TrackedEdit, TrackedKind};
use std::ops::Range;

pub struct WordReviewAnchor {
    pub change: TrackedChange,
    pub block_id: String,
    pub start: usize,
    pub end: usize,
}

pub fn word_review_anchors(
    projection: &EditorProjection,
) -> Result<Vec<WordReviewAnchor>, HcdError> {
    let mut result = Vec::new();
    for block in projection
        .blocks
        .iter()
        .filter(|block| block.region == "body")
    {
        let Some(html) = block
            .presentation_html
            .as_deref()
            .or(block.read_only_html.as_deref())
        else {
            continue;
        };
        if !html.contains("data-hcd-revision-id=") {
            continue;
        }
        for span in read_spans(html)?.spans {
            if let SpanKind::Revision(change) = span.kind {
                let (start, end) = if block.read_only {
                    (0, 0)
                } else {
                    (span.start, span.end)
                };
                result.push(WordReviewAnchor {
                    change,
                    block_id: block.block_id.clone(),
                    start,
                    end,
                });
            }
        }
    }
    Ok(result)
}

pub(crate) fn apply_tracked_edit(
    bundle: &Bundle,
    manifest: &mut HcdManifest,
    edit: &TrackedEdit,
) -> Result<(Vec<String>, Vec<String>), HcdError> {
    let mut blocks = load_blocks(bundle, manifest)?;
    let block = blocks
        .iter_mut()
        .find(|block| block.region == "body" && block.id == edit.block_id)
        .ok_or_else(changed)?;
    let scan = read_spans(&block.html)?;
    let candidates: Vec<_> = scan
        .spans
        .iter()
        .filter(|span| span.kind == SpanKind::Revision(edit.decision.change))
        .collect();
    let [target] = candidates.as_slice() else {
        return Err(changed());
    };
    let inner = block.html[target.inner.clone()].to_string();
    let keep = edit.decision.accept == (edit.decision.change.kind == TrackedKind::Insert);
    let replacement = if keep && edit.decision.change.kind == TrackedKind::Delete {
        restore_text(block, inner, &manifest.document_id, edit, target.editable)?
    } else if keep {
        inner
    } else {
        String::new()
    };
    block.html.replace_range(target.outer.clone(), &replacement);
    let mut source: HashMap<_, _> = block
        .entries
        .drain(..)
        .map(|entry| (entry.node_id.clone(), entry))
        .collect();
    block.entries = read_spans(&block.html)?
        .ids
        .into_iter()
        .map(|id| {
            source.remove(&id).ok_or_else(|| {
                HcdError::InvalidBundle(format!("revision lost the source anchor for {id}"))
            })
        })
        .collect::<Result<_, _>>()?;
    let removed = sorted(source.into_keys().collect());

    let (descriptors, index, dirty_chunks) =
        write_blocks(bundle, manifest, manifest.revision + 1, &blocks)?;
    let mut hash = Sha256::new();
    for descriptor in &descriptors {
        hash_descriptor(&mut hash, descriptor);
    }
    let assets = bundle.asset_index_href_for_revision(manifest.revision)?;
    manifest.root_hash = finalize_root_hash(bundle, hash, &assets, &manifest.styles_href)?;
    manifest.chunk_count = descriptors.len();
    manifest.index_page_count = descriptors.len().div_ceil(INDEX_PAGE_SIZE);
    manifest.index_root_href = index;
    Ok((removed, dirty_chunks))
}

fn restore_text(
    block: &mut Block,
    mut inner: String,
    document_id: &str,
    edit: &TrackedEdit,
    editable: bool,
) -> Result<String, HcdError> {
    let scan = read_spans(&inner)?;
    let deleted: Vec<_> = scan
        .spans
        .iter()
        .filter(|span| span.kind == SpanKind::Deleted && !span.inner.is_empty())
        .collect();
    if deleted.len() != edit.deleted_text.len() || !scan.ids.is_empty() {
        return Err(changed());
    }
    let id = edit.decision.change.id;
    for (index, (span, text)) in deleted
        .into_iter()
        .zip(&edit.deleted_text)
        .enumerate()
        .rev()
    {
        let raw = &inner[span.inner.clone()];
        let plain = quick_xml::escape::unescape(raw).map_err(|_| changed())?;
        if *text != plain {
            return Err(changed());
        }
        let ordinal = restored_text_ordinal(id, index)?;
        let node_id = stable_node_id(&[
            document_id,
            "word/document.xml",
            "restored-text",
            &ordinal.to_string(),
        ]);
        let node_hash = hash_bytes(text.as_bytes());
        let html = format!(
            r#"<span data-hcd-id="{node_id}" data-hcd-node-hash="{node_hash}">{raw}</span>"#
        );
        inner.replace_range(span.outer.clone(), &html);
        block.entries.push(NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                part: "word/document.xml".into(),
                text_ordinal: ordinal,
                source_cell_ref: None,
                paragraph_id: None,
                text_id: None,
                created_in_hcd: false,
                node_kind: "text".into(),
                editable,
            },
        });
    }
    Ok(inner)
}

fn changed() -> HcdError {
    HcdError::PreconditionFailed("修订对应的正文已变化，请刷新审阅面板。".into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpanKind {
    Revision(TrackedChange),
    Deleted,
}

struct Span {
    kind: SpanKind,
    outer: Range<usize>,
    inner: Range<usize>,
    start: usize,
    end: usize,
    editable: bool,
}

#[derive(Default)]
struct Scanned {
    spans: Vec<Span>,
    ids: Vec<String>,
}

fn read_spans(html: &str) -> Result<Scanned, HcdError> {
    let mut reader = Reader::from_str(html);
    let mut result = Scanned::default();
    let mut stack = Vec::<Option<(SpanKind, usize, usize, usize, bool)>>::new();
    let mut depth = 0usize;
    let mut mapped = None;
    let mut scalar = 0;
    let mut hidden_cell = None;
    loop {
        let before = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let after = reader.buffer_position() as usize;
        match event {
            Event::Start(start) => {
                depth += 1;
                if hidden_cell.is_none()
                    && matches!(start.name().as_ref(), b"td" | b"th")
                    && attribute(&start, &reader, "data-hcd-v-merge")?.as_deref()
                        == Some("continue")
                {
                    hidden_cell = Some(depth);
                }
                if let Some(id) = mapped_id(&start, &reader)? {
                    result.ids.push(id);
                    mapped = Some(depth);
                }
                if start.name().as_ref() == b"span" {
                    stack.push(
                        span_kind(&start, &reader)?
                            .map(|kind| (kind, before, after, scalar, hidden_cell.is_none())),
                    );
                }
            }
            Event::Empty(start) => result.ids.extend(mapped_id(&start, &reader)?),
            Event::End(end) => {
                if end.name().as_ref() == b"span" {
                    if let Some((kind, open, inner, start, editable)) = stack.pop().flatten() {
                        result.spans.push(Span {
                            kind,
                            outer: open..after,
                            inner: inner..before,
                            start,
                            end: scalar,
                            editable,
                        });
                    }
                }
                if mapped == Some(depth) {
                    mapped = None;
                }
                if hidden_cell == Some(depth) {
                    hidden_cell = None;
                }
                depth = depth.saturating_sub(1);
            }
            Event::Text(text) if mapped.is_some() => {
                scalar += text
                    .unescape()
                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                    .chars()
                    .count();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    result.spans.sort_by_key(|span| span.outer.start);
    Ok(result)
}

fn mapped_id(start: &BytesStart<'_>, reader: &Reader<&[u8]>) -> Result<Option<String>, HcdError> {
    if attribute(start, reader, "data-hcd-node-hash")?.is_some() {
        return attribute(start, reader, "data-hcd-id");
    }
    Ok(None)
}

fn span_kind(start: &BytesStart<'_>, reader: &Reader<&[u8]>) -> Result<Option<SpanKind>, HcdError> {
    let kind = match attribute(start, reader, "data-hcd-revision")?.as_deref() {
        Some("insert") => Some(TrackedKind::Insert),
        Some("delete") => Some(TrackedKind::Delete),
        _ => None,
    };
    if let Some(kind) = kind {
        let id = attribute(start, reader, "data-hcd-revision-id")?.and_then(|id| id.parse().ok());
        return Ok(id.map(|id| SpanKind::Revision(TrackedChange { kind, id })));
    }
    Ok(
        (attribute(start, reader, "class")?.as_deref() == Some("hcd-revision-text"))
            .then_some(SpanKind::Deleted),
    )
}
