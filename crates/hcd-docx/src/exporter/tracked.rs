//! Rewrite the exact inline revision wrappers in the original Word body. Normal
//! w:t edits are written first, so removing a run never shifts their anchors.

use super::{rewrite_text_part, TextUpdate};
use hcd_core::docx_review::{restored_text_ordinal, TrackedChange, TrackedDecision, TrackedKind};
use hcd_core::{word_review_anchors, EditorProjection, HcdError};
use roxmltree::{Document, Node};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedView {
    pub change: Option<TrackedChange>,
    pub kind: &'static str,
    pub author: Option<String>,
    pub date: Option<String>,
    pub text: String,
    pub location: Option<super::review::CommentLocation>,
}

pub(super) fn inspect(
    doc: &Document<'_>,
    projection: &EditorProjection,
) -> Result<Vec<TrackedView>, HcdError> {
    let anchors = word_review_anchors(projection)?;
    let mut by_change = HashMap::new();
    let mut duplicates = HashSet::new();
    for anchor in anchors {
        let change = anchor.change;
        if by_change.insert(change, anchor).is_some() {
            duplicates.insert(change);
        }
    }
    let index = index(doc);
    Ok(body(doc)
        .into_iter()
        .flat_map(|node| node.descendants())
        .filter_map(|node| {
            let kind = review_kind(node)?;
            let change = identity(node);
            let anchor = change
                .filter(|key| !duplicates.contains(key))
                .and_then(|key| by_change.get(&key));
            let can_decide = change.is_some_and(|key| {
                anchor.is_some()
                    && index.get(&key).is_some_and(|nodes| nodes.len() == 1)
                    && inline_runs(node, key.kind)
            });
            let text = node
                .descendants()
                .filter(|n| word(*n, "t") || word(*n, "delText"))
                .filter_map(|n| n.text())
                .flat_map(str::chars)
                .take(700)
                .collect();
            Some(TrackedView {
                change: change.filter(|_| can_decide),
                kind,
                author: node.attribute((W, "author")).map(str::to_owned),
                date: node.attribute((W, "date")).map(str::to_owned),
                text,
                location: anchor.map(|a| super::review::CommentLocation {
                    block_id: a.block_id.clone(),
                    start: a.start,
                    end: a.end,
                }),
            })
        })
        .collect())
}

pub(super) fn verify_action(xml: &str, decision: TrackedDecision) -> Result<Vec<String>, HcdError> {
    let doc = parse(xml)?;
    let index = index(&doc);
    let node = index
        .get(&decision.change)
        .and_then(|nodes| match nodes.as_slice() {
            [node] => Some(*node),
            _ => None,
        })
        .filter(|node| inline_runs(*node, decision.change.kind))
        .ok_or_else(changed)?;
    let deleted = if !decision.accept && decision.change.kind == TrackedKind::Delete {
        deleted_text_nodes(node)
            .filter_map(|node| node.text())
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    // Exercise the same byte-preserving rewriter used for native download.
    rewrite(xml, &[decision], &BTreeMap::new())?;
    Ok(deleted)
}

pub(super) fn rewrite(
    xml: &str,
    decisions: &[TrackedDecision],
    restored: &BTreeMap<u64, TextUpdate>,
) -> Result<String, HcdError> {
    let doc = parse(xml)?;
    let index = index(&doc);
    let mut patches = Vec::new();
    let mut consumed = 0;
    for decision in decisions {
        let Some(nodes) = index.get(&decision.change) else {
            // A later paragraph or table edit can remove the whole source block.
            continue;
        };
        let [node] = nodes.as_slice() else {
            return Err(changed());
        };
        if !inline_runs(*node, decision.change.kind) {
            return Err(changed());
        }
        let keep = decision.accept == (decision.change.kind == TrackedKind::Insert);
        let value = match (keep, decision.change.kind) {
            (false, _) => String::new(),
            (true, TrackedKind::Insert) => xml[inner(*node)?].to_string(),
            (true, TrackedKind::Delete) => {
                let (text, count) = restore(xml, *node, decision.change.id, restored)?;
                consumed += count;
                text
            }
        };
        patches.push((node.range(), value));
    }
    if consumed != restored.len() {
        return Err(HcdError::PreconditionFailed(
            "edited restored text has no matching Word run".into(),
        ));
    }
    splice(xml, 0..xml.len(), patches)
}

fn restore(
    xml: &str,
    node: Node<'_, '_>,
    id: i32,
    updates: &BTreeMap<u64, TextUpdate>,
) -> Result<(String, usize), HcdError> {
    let mut replacements = BTreeMap::new();
    let mut patches = Vec::new();
    let mut visible = 0;
    for (index, text) in deleted_text_nodes(node).enumerate() {
        if text.text().is_some_and(|text| !text.is_empty()) {
            let ordinal = restored_text_ordinal(id, visible)?;
            if let Some(edit) = updates.get(&ordinal) {
                replacements.insert(index as u64 + 1, edit.clone());
            }
            visible += 1;
        }
        let raw = &xml[text.range()];
        let mut value = raw.to_string();
        if let Some(close) = raw.rfind("</") {
            value.replace_range(deleted_local_name(raw, close + 2)?, "t");
        }
        value.replace_range(deleted_local_name(raw, 1)?, "t");
        patches.push((text.range(), value));
    }
    let content = splice(xml, inner(node)?, patches)?;
    if replacements.is_empty() {
        return Ok((content, 0));
    }
    let mut output = Vec::new();
    rewrite_text_part(&mut content.as_bytes(), &mut output, &replacements)?;
    let text =
        String::from_utf8(output).map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    Ok((text, replacements.len()))
}

fn deleted_local_name(element: &str, start: usize) -> Result<Range<usize>, HcdError> {
    let raw = &element[start..];
    let end = raw
        .find(|ch: char| ch.is_ascii_whitespace() || matches!(ch, '>' | '/'))
        .ok_or_else(changed)?;
    let name = &raw[..end];
    let local = name
        .rsplit(':')
        .next()
        .filter(|part| *part == "delText")
        .ok_or_else(changed)?;
    Ok(start + end - local.len()..start + end)
}

fn splice(
    xml: &str,
    region: Range<usize>,
    mut patches: Vec<(Range<usize>, String)>,
) -> Result<String, HcdError> {
    patches.sort_by_key(|(range, _)| range.start);
    let mut at = region.start;
    let mut output = String::with_capacity(region.len());
    for (range, replacement) in patches {
        if range.start < at || range.end > region.end {
            return Err(changed());
        }
        output.push_str(&xml[at..range.start]);
        output.push_str(&replacement);
        at = range.end;
    }
    output.push_str(&xml[at..region.end]);
    Ok(output)
}

fn inner(node: Node<'_, '_>) -> Result<Range<usize>, HcdError> {
    Ok(node.first_child().ok_or_else(changed)?.range().start
        ..node.last_child().ok_or_else(changed)?.range().end)
}

fn deleted_text_nodes<'a, 'b>(node: Node<'a, 'b>) -> impl Iterator<Item = Node<'a, 'b>> {
    node.descendants().filter(|node| word(*node, "delText"))
}

fn identity(node: Node<'_, '_>) -> Option<TrackedChange> {
    let kind = if word(node, "ins") {
        TrackedKind::Insert
    } else if word(node, "del") {
        TrackedKind::Delete
    } else {
        return None;
    };
    Some(TrackedChange {
        kind,
        id: node.attribute((W, "id"))?.parse().ok()?,
    })
}

fn body<'a, 'b>(doc: &'a Document<'b>) -> Option<Node<'a, 'b>> {
    doc.root_element()
        .children()
        .find(|node| word(*node, "body"))
}

fn index<'a, 'b>(doc: &'a Document<'b>) -> HashMap<TrackedChange, Vec<Node<'a, 'b>>> {
    let mut result: HashMap<_, Vec<_>> = HashMap::new();
    for node in body(doc).into_iter().flat_map(|node| node.descendants()) {
        if let Some(key) = identity(node) {
            result.entry(key).or_default().push(node);
        }
    }
    result
}

fn review_kind(node: Node<'_, '_>) -> Option<&'static str> {
    if node.tag_name().namespace() != Some(W) {
        return None;
    }
    Some(match node.tag_name().name() {
        "ins" | "del" if node.parent().is_some_and(|n| word(n, "trPr")) => "table",
        "ins" | "del" if node.parent().is_some_and(|n| word(n, "rPr")) => "paragraphMark",
        "ins" => "insert",
        "del" => "delete",
        "moveFrom" => "moveFrom",
        "moveTo" => "moveTo",
        "cellIns" | "cellDel" | "cellMerge" => "table",
        "pPrChange" | "rPrChange" | "tblPrChange" | "trPrChange" | "tcPrChange"
        | "tblGridChange" | "sectPrChange" => "format",
        _ => return None,
    })
}

fn inline_runs(node: Node<'_, '_>, kind: TrackedKind) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    if !word(parent, "p") && !word(parent, "hyperlink") {
        return false;
    }
    if parent
        .ancestors()
        .any(|n| review_kind(n).is_some() || word(n, "txbxContent"))
    {
        return false;
    }
    if node
        .namespaces()
        .iter()
        .any(|namespace| parent.lookup_namespace_uri(namespace.name()) != Some(namespace.uri()))
    {
        return false;
    }
    if node
        .attributes()
        .iter()
        .any(|attribute| !matches!(attribute.name(), "id" | "author" | "date" | "dateUtc"))
    {
        return false;
    }
    let name = if kind == TrackedKind::Insert {
        "t"
    } else {
        "delText"
    };
    let runs = node.children().filter(Node::is_element);
    runs.clone().count() > 0
        && runs.into_iter().all(|run| {
            word(run, "r")
                && run.children().filter(Node::is_element).all(|element| {
                    word(element, "rPr")
                        || word(element, name)
                        || word(element, "tab")
                        || word(element, "br")
                        || word(element, "cr")
                })
                && !run
                    .descendants()
                    .any(|element| review_kind(element).is_some())
        })
}

fn word(node: Node<'_, '_>, local: &str) -> bool {
    node.has_tag_name((W, local))
}

fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

fn changed() -> HcdError {
    HcdError::PreconditionFailed("这条原生 Word 修订已变化或无法独立处理。".into())
}
