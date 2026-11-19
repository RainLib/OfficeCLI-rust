use super::{
    attribute, Block, EditorBlockContent, EditorBlockView, EditorInline, MAX_INLINE_BYTES,
};
use crate::{hash_bytes, HcdError};
use quick_xml::{events::Event, Reader};
use std::collections::HashSet;

pub(super) fn editable_ids(block: &Block) -> Vec<String> {
    if block.region != "body" || !block.html.contains("<table") {
        return Vec::new();
    }
    let eligible: HashSet<_> = block
        .entries
        .iter()
        .filter(|entry| {
            entry.source.part == "word/document.xml"
                && entry.source.editable
                && entry.source.node_kind == "text"
        })
        .map(|entry| entry.node_id.as_str())
        .collect();
    if eligible.is_empty() {
        return Vec::new();
    }
    let mut reader = Reader::from_str(&block.html);
    let mut cell_depth = 0usize;
    let mut ids = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                if matches!(start.name().as_ref(), b"td" | b"th") {
                    cell_depth += 1;
                }
                if cell_depth > 0 && start.name().as_ref() == b"span" {
                    if let Ok(Some(id)) = attribute(&start, &reader, "data-hcd-id") {
                        if eligible.contains(id.as_str()) {
                            ids.push(id);
                        }
                    }
                }
            }
            Ok(Event::End(end)) if matches!(end.name().as_ref(), b"td" | b"th") => {
                cell_depth = cell_depth.saturating_sub(1);
            }
            Ok(Event::Eof) => return ids,
            Err(_) => return Vec::new(),
            _ => {}
        }
    }
}

fn checked_changes<'a>(
    before: &EditorBlockContent,
    after: &'a EditorBlockContent,
    ids: &[String],
) -> Result<Vec<&'a EditorInline>, HcdError> {
    let invalid = || HcdError::InvalidPatch("Only mapped Word table text can be changed".into());
    if ids.is_empty()
        || after.kind != before.kind
        || after.level != before.level
        || after.alignment != before.alignment
        || after.inlines.len() != before.inlines.len()
    {
        return Err(invalid());
    }
    let allowed: HashSet<_> = ids.iter().map(String::as_str).collect();
    let mut bytes = 0usize;
    let mut edits = Vec::new();
    for (old, new) in before.inlines.iter().zip(&after.inlines) {
        bytes = bytes.saturating_add(new.text.len());
        if bytes > MAX_INLINE_BYTES {
            return Err(HcdError::ResourceLimit(
                "Word table text exceeds 1 MiB in the current block".into(),
            ));
        }
        if old.node_id != new.node_id
            || old.bold != new.bold
            || old.italic != new.italic
            || old.link != new.link
            || old.format != new.format
        {
            return Err(invalid());
        }
        if old.text == new.text {
            continue;
        }
        if !new
            .node_id
            .as_deref()
            .is_some_and(|id| allowed.contains(id))
            || new.text.contains(['\r', '\n', '\t'])
        {
            return Err(invalid());
        }
        edits.push(new);
    }
    Ok(edits)
}

pub(super) fn replace(
    original: &Block,
    replacement: &EditorBlockContent,
) -> Result<Block, HcdError> {
    let edits = checked_changes(&original.content, replacement, &editable_ids(original))?;
    let mut updated = original.clone();
    for inline in edits {
        let id = inline
            .node_id
            .as_deref()
            .expect("checked table source node ID");
        let hash = hash_bytes(inline.text.as_bytes());
        crate::patch::replace_node_text(&mut updated.html, id, &inline.text, &hash)?;
        let entry = updated
            .entries
            .iter_mut()
            .find(|entry| entry.node_id == id)
            .ok_or_else(|| HcdError::NodeNotFound(id.into()))?;
        entry.node_hash = hash;
    }
    updated.content = replacement.clone();
    Ok(updated)
}

/// Verify that both versions of a protected table differ only in mapped text.
pub fn word_table_text_changes<'a>(
    before: &EditorBlockView,
    after: &'a EditorBlockView,
) -> Result<Vec<&'a EditorInline>, HcdError> {
    let edits = checked_changes(
        &before.content,
        &after.content,
        &before.editable_text_node_ids,
    )?;
    let mut expected = before
        .read_only_html
        .clone()
        .ok_or_else(|| HcdError::InvalidBundle("Word table HTML is unavailable".into()))?;
    for inline in &edits {
        let id = inline
            .node_id
            .as_deref()
            .expect("checked table source node ID");
        crate::patch::replace_node_text(
            &mut expected,
            id,
            &inline.text,
            &hash_bytes(inline.text.as_bytes()),
        )?;
    }
    if after.read_only_html.as_deref() != Some(expected.as_str()) {
        return Err(HcdError::Unsupported(
            "Table layout or unsupported content changed".into(),
        ));
    }
    Ok(edits)
}
