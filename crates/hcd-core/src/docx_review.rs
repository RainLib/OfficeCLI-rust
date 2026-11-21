//! Native Word review metadata is versioned with the annotation object.
//! Ordinary body edits retain it, and history and restore pick the same
//! immutable review state as the corresponding text revision.

use crate::bundle::read_json_bounded;
use crate::{AnnotationSet, ApplyResult, Bundle, HcdError, HcdManifest, MAX_CONTROL_PART_BYTES};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxReview {
    pub comments: Vec<AddedComment>,
    pub resolved: BTreeMap<i32, bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<TrackedDecision>,
}

impl DocxReview {
    pub fn is_empty(&self) -> bool {
        self.comments.is_empty() && self.resolved.is_empty() && self.decisions.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackedKind {
    Insert,
    Delete,
}

impl TrackedKind {
    pub fn html_value(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackedChange {
    pub id: i32,
    pub kind: TrackedKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackedDecision {
    pub change: TrackedChange,
    pub accept: bool,
}

pub struct TrackedEdit {
    pub decision: TrackedDecision,
    pub block_id: String,
    pub deleted_text: Vec<String>,
}

// These ordinals identify original w:delText elements independently of the
// w:t ordinal stream. They remain exact integers in JSON and stable when a
// past decision, regular edit or table move changes native paragraph order.
pub const RESTORED_TEXT_BASE: u64 = 1 << 48;

pub fn restored_text_ordinal(id: i32, offset: usize) -> Result<u64, HcdError> {
    let offset = u16::try_from(offset)
        .map_err(|_| HcdError::ResourceLimit("too many restored Word text runs".into()))?;
    Ok(RESTORED_TEXT_BASE + (u64::from(id as u32) << 16) + u64::from(offset))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddedComment {
    pub id: i32,
    pub author: String,
    pub date: String,
    pub text: String,
    pub attachment: CommentAttachment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommentAttachment {
    Range {
        block_id: String,
        start: usize,
        quote: String,
        paragraph_hash: String,
    },
    Reply {
        parent_id: i32,
    },
}

fn annotation_set(bundle: &Bundle, manifest: &HcdManifest) -> Result<AnnotationSet, HcdError> {
    if let Some(href) = &manifest.annotation_href {
        return read_json_bounded(
            &bundle.resolve_href(href)?,
            MAX_CONTROL_PART_BYTES,
            "annotations",
        );
    }
    Ok(AnnotationSet {
        schema_version: manifest.schema_version.clone(),
        ..Default::default()
    })
}

pub fn read(bundle: &Bundle, manifest: &HcdManifest) -> Result<DocxReview, HcdError> {
    Ok(annotation_set(bundle, manifest)?.docx_review)
}

/// Commit review metadata and any affected body blocks under the same lock.
pub fn edit(
    bundle: &Bundle,
    expected_revision: u64,
    patch_id: &str,
    patch_hash: &str,
    preflight: impl FnOnce(&HcdManifest, &mut DocxReview) -> Result<Option<TrackedEdit>, HcdError>,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.schema_version != crate::HCD_SCHEMA_VERSION || manifest.source.format != "docx" {
        return Err(HcdError::Unsupported(
            "review requires a Word document".into(),
        ));
    }
    if let Some(result) =
        crate::patch::find_idempotent_result(bundle, &manifest, patch_id, patch_hash)?
    {
        return Ok(result);
    }
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(format!(
            "review expected r{expected_revision}, found r{}",
            manifest.revision
        )));
    }
    if manifest.revision >= crate::MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let mut annotations = annotation_set(bundle, &manifest)?;
    let (removed, dirty_chunks) = if let Some(edit) =
        preflight(&manifest, &mut annotations.docx_review)?
    {
        let (removed, chunks) = crate::structure::apply_tracked_edit(bundle, &mut manifest, &edit)?;
        annotations
            .annotations
            .retain(|note| !removed.contains(&note.node_id));
        annotations.docx_review.decisions.push(edit.decision);
        (removed, chunks)
    } else {
        (Vec::new(), Vec::new())
    };
    let (href, hash) = bundle.write_json_object("annotations", &annotations)?;
    let revision = manifest.revision + 1;
    manifest.annotation_href = Some(href);
    manifest.annotation_root_hash = hash;
    let mut record = crate::structure::revision_record(
        bundle,
        &manifest,
        revision,
        patch_id,
        Some(patch_hash.to_string()),
        false,
    )?;
    record.removed_node_ids = removed;
    record.dirty_chunk_ids = dirty_chunks.clone();
    manifest.revision = revision;
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: patch_id.to_string(),
        base_revision: expected_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: dirty_chunks,
        dirty_source_parts: Vec::new(),
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}
