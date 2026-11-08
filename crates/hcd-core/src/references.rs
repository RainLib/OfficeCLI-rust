//! Offline reference payloads and rebuildable relationships. No account service
//! or notification transport is needed to read a saved document.
use crate::{
    editor_projection, hash_bytes, Bundle, EditorBlockContent, EditorProjection, HcdError,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceTarget {
    pub kind: String,
    pub id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceSnapshot {
    pub label: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InlineReference {
    #[serde(rename = "type")]
    pub node_type: String,
    pub version: u32,
    pub mention_id: String,
    pub target: ReferenceTarget,
    pub snapshot: ReferenceSnapshot,
}
impl InlineReference {
    pub fn validate(&self) -> Result<(), HcdError> {
        let id = self.mention_id.strip_prefix("m_").unwrap_or("");
        if self.node_type != "hcd.mention"
            || self.version != 1
            || id.len() != 32
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !self
                .target
                .kind
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            || self.target.kind.len() > 64
            || !self.target.kind.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
            || !valid_reference_text(&self.target.id, 256)
            || !valid_reference_text(&self.snapshot.label, 256)
        {
            return Err(HcdError::InvalidPatch(
                "invalid inline reference payload".into(),
            ));
        }
        Ok(())
    }
    pub fn text(&self) -> String {
        format!("@{}", self.snapshot.label)
    }
}
fn valid_reference_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceOccurrence {
    pub block_id: String,
    pub child_path: Vec<usize>,
    /// Indices of editable inline wrappers, separate from block child paths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inline_path: Vec<usize>,
    pub inline_index: usize,
    pub reference: InlineReference,
}
pub fn content_references(
    block_id: &str,
    content: &EditorBlockContent,
) -> Result<Vec<ReferenceOccurrence>, HcdError> {
    fn walk(
        block_id: &str,
        content: &EditorBlockContent,
        path: &mut Vec<usize>,
        inline_path: &mut Vec<usize>,
        result: &mut Vec<ReferenceOccurrence>,
        depth: usize,
    ) -> Result<(), HcdError> {
        if depth > 32 {
            return Err(HcdError::ResourceLimit(
                "reference nesting exceeds 32".into(),
            ));
        }
        for (inline_index, inline) in content.inlines.iter().enumerate() {
            if let Some(body) = &inline.content {
                inline_path.push(inline_index);
                walk(block_id, body, path, inline_path, result, depth + 1)?;
                inline_path.pop();
            }
            if let Some(reference) = &inline.reference {
                reference.validate()?;
                if content.kind == crate::EditorBlockKind::CodeBlock
                    || inline.text != reference.text()
                    || inline.hard_break
                    || inline.code
                    || inline.link.is_some()
                {
                    return Err(HcdError::InvalidPatch("reference fallback must match its snapshot and cannot be a link, code or hard break".into()));
                }
                if result.len() >= 10_000 {
                    return Err(HcdError::ResourceLimit(
                        "document reference limit exceeded".into(),
                    ));
                }
                result.push(ReferenceOccurrence {
                    block_id: block_id.into(),
                    child_path: path.clone(),
                    inline_path: inline_path.clone(),
                    inline_index,
                    reference: reference.clone(),
                });
            }
        }
        for (index, child) in content.children.iter().enumerate() {
            path.push(index);
            walk(block_id, child, path, inline_path, result, depth + 1)?;
            path.pop();
        }
        Ok(())
    }
    let mut result = Vec::new();
    walk(
        block_id,
        content,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut result,
        0,
    )?;
    Ok(result)
}
pub fn projection_references(
    projection: &EditorProjection,
) -> Result<Vec<ReferenceOccurrence>, HcdError> {
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    for block in &projection.blocks {
        for occurrence in content_references(&block.block_id, &block.content)? {
            if result.len() >= 10_000 {
                return Err(HcdError::ResourceLimit(
                    "document reference limit exceeded".into(),
                ));
            }
            if !ids.insert(occurrence.reference.mention_id.clone()) {
                return Err(HcdError::InvalidPatch(
                    "duplicate reference occurrence ID".into(),
                ));
            }
            result.push(occurrence);
        }
    }
    Ok(result)
}
pub fn document_references(
    bundle: &Bundle,
    revision: Option<u64>,
) -> Result<Vec<ReferenceOccurrence>, HcdError> {
    projection_references(&editor_projection(bundle, revision)?)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceLocation {
    pub chunk_sequence: usize,
    pub index_page: usize,
}
/// Optional immutable navigation index. Read verified chunks one at a time;
/// callers must never use this saved location as a live CRDT cursor.
pub fn document_reference_locations(
    bundle: &Bundle,
    revision: u64,
) -> Result<BTreeMap<String, ReferenceLocation>, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = crate::manifest_at_revision(bundle, &head, Some(revision))?;
    let mut locations = BTreeMap::new();
    for index_page in 0..manifest.index_page_count {
        let page = bundle.read_index_page(&manifest, index_page)?;
        for descriptor in &page.chunks {
            let html = bundle.read_chunk_verified(descriptor)?;
            if !html.contains("data-hcd-reference") {
                continue;
            }
            for reference in chunk_references(&html)? {
                if locations.len() >= 10000
                    || locations
                        .insert(
                            reference.mention_id,
                            ReferenceLocation {
                                chunk_sequence: descriptor.sequence,
                                index_page,
                            },
                        )
                        .is_some()
                {
                    return Err(HcdError::InvalidBundle(
                        "duplicate or excessive reference navigation identities".into(),
                    ));
                }
            }
        }
    }
    Ok(locations)
}
fn chunk_references(html: &str) -> Result<Vec<InlineReference>, HcdError> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(html);
    let mut buffer = Vec::new();
    let mut references = Vec::new();
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("invalid reference chunk: {error}")))?
        {
            Event::Start(element) | Event::Empty(element) => {
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|_| {
                        HcdError::InvalidBundle("invalid reference attributes".into())
                    })?;
                    if attribute.key.as_ref() != b"data-hcd-reference" {
                        continue;
                    }
                    if element.name().as_ref() != b"span" {
                        return Err(HcdError::InvalidBundle(
                            "reference must be an inline span".into(),
                        ));
                    }
                    let value = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|_| {
                            HcdError::InvalidBundle("invalid reference encoding".into())
                        })?;
                    if value.len() > 4096 || references.len() >= 10000 {
                        return Err(HcdError::ResourceLimit(
                            "reference navigation limit exceeded".into(),
                        ));
                    }
                    let reference: InlineReference = serde_json::from_str(&value)?;
                    reference.validate()?;
                    references.push(reference);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(references)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceEvent {
    pub schema_version: String,
    pub event_id: String,
    pub document_id: String,
    pub revision: u64,
    pub mention_id: String,
    pub kind: String,
    pub target: ReferenceTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_target: Option<ReferenceTarget>,
    pub scope: ReferenceScope,
    pub context: ReferenceEventContext,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceScope {
    pub kind: String,
    pub id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceEventContext {
    pub source: String,
    pub actor_id: Option<String>,
    pub occurred_at_epoch_ms: u128,
}
/// Derive only an adjacent committed transition. Replaying or rebuilding it
/// yields the same IDs; moves and label refreshes do not create events.
pub fn reference_events(
    document_id: &str,
    revision: u64,
    before: &[ReferenceOccurrence],
    after: &[ReferenceOccurrence],
    context: &ReferenceEventContext,
) -> Vec<ReferenceEvent> {
    let old: BTreeMap<_, _> = before
        .iter()
        .map(|v| (v.reference.mention_id.as_str(), &v.reference.target))
        .collect();
    let new: BTreeMap<_, _> = after
        .iter()
        .map(|v| (v.reference.mention_id.as_str(), &v.reference.target))
        .collect();
    let ids: std::collections::BTreeSet<_> = old.keys().chain(new.keys()).copied().collect();
    ids.into_iter()
        .filter_map(|id| {
            let (kind, target, previous) = match (old.get(id), new.get(id)) {
                (None, Some(target)) => ("reference.created", *target, None),
                (Some(target), None) => ("reference.removed", *target, None),
                (Some(previous), Some(target)) if previous != target => {
                    ("reference.retargeted", *target, Some((*previous).clone()))
                }
                _ => return None,
            };
            let event_id = hash_bytes(
                &serde_json::to_vec(&(
                    "hcd-reference-event/1",
                    document_id,
                    revision,
                    id,
                    kind,
                    target,
                    &previous,
                ))
                .expect("reference event is serializable"),
            );
            Some(ReferenceEvent {
                schema_version: "hcd-reference-event/1".into(),
                event_id,
                document_id: document_id.into(),
                revision,
                mention_id: id.into(),
                kind: kind.into(),
                target: target.clone(),
                previous_target: previous,
                scope: ReferenceScope {
                    kind: "document".into(),
                    id: document_id.into(),
                },
                context: context.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn occurrence(id: &str, target: &str) -> ReferenceOccurrence {
        ReferenceOccurrence {
            block_id: "block".into(),
            inline_path: Vec::new(),
            child_path: vec![0],
            inline_index: 1,
            reference: InlineReference {
                node_type: "hcd.mention".into(),
                version: 1,
                mention_id: format!("m_{id:0>32}"),
                target: ReferenceTarget {
                    kind: "person".into(),
                    id: target.into(),
                },
                snapshot: ReferenceSnapshot {
                    label: "Same Name".into(),
                },
            },
        }
    }
    #[test]
    fn reference_events_are_rebuildable_and_ignore_names_and_positions() {
        let a = occurrence("1", "alice");
        let b = occurrence("2", "alice");
        let context = ReferenceEventContext {
            source: "content".into(),
            actor_id: Some("writer".into()),
            occurred_at_epoch_ms: 1,
        };
        let created = reference_events("doc", 2, &[], &[a.clone(), b.clone()], &context);
        assert_eq!(created.len(), 2);
        assert_ne!(created[0].event_id, created[1].event_id);
        assert_eq!(
            created,
            reference_events("doc", 2, &[], &[a.clone(), b], &context)
        );
        let mut moved = a.clone();
        moved.block_id = "another block".into();
        moved.child_path = vec![2, 1];
        moved.reference.snapshot.label = "Renamed".into();
        assert!(reference_events(
            "doc",
            3,
            std::slice::from_ref(&a),
            std::slice::from_ref(&moved),
            &context
        )
        .is_empty());
        moved.reference.target.id = "bob".into();
        let retarget = reference_events("doc", 3, std::slice::from_ref(&a), &[moved], &context);
        assert_eq!(retarget[0].kind, "reference.retargeted");
        assert_eq!(retarget[0].previous_target.as_ref().unwrap().id, "alice");
        let removed = reference_events("doc", 4, std::slice::from_ref(&a), &[], &context);
        assert_eq!(removed[0].kind, "reference.removed");
        let readded = reference_events("doc", 5, &[], &[a], &context);
        assert_ne!(readded[0].event_id, created[0].event_id);
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;
    #[test]
    fn native_reference_locations_decode_escaped_unicode_payloads_and_reject_unknown_models() {
        let payload = serde_json::json!({"type":"hcd.mention","version":1,"mentionId":format!("m_{:032x}",1),"target":{"kind":"person","id":"org:甲"},"snapshot":{"label":"名&称"}});
        let attribute = payload
            .to_string()
            .replace('&', "&amp;")
            .replace('\"', "&quot;");
        let html = format!(
            "<article><p><span data-hcd-reference=\"{attribute}\">@名&amp;称</span></p></article>"
        );
        let values = chunk_references(&html).unwrap();
        assert_eq!(values[0].target.id, "org:甲");
        assert_eq!(values[0].snapshot.label, "名&称");
        assert!(
            chunk_references(&html.replace("&quot;version&quot;:1", "&quot;version&quot;:2"))
                .is_err()
        );
        assert!(
            chunk_references(&html.replace("<span ", "<div ").replace("</span>", "</div>"))
                .is_err()
        );
    }
}
