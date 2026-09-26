use crate::bundle::now_epoch_ms;
use crate::{
    hash_bytes, manifest_at_revision, ApplyResult, Bundle, HcdError, RevisionRecord, MAX_REVISION,
};

/// Append a new head that references the immutable objects of an older revision.
/// The older revision and every intermediate save point remain available.
pub fn restore_revision(
    bundle: &Bundle,
    target: u64,
    expected_head: u64,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut head = bundle.manifest()?;
    if head.revision != expected_head {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_head}, actual {}",
            head.revision
        )));
    }
    if target >= expected_head {
        return Err(HcdError::InvalidPatch(
            "restore target must precede the current head".to_string(),
        ));
    }
    if expected_head >= MAX_REVISION {
        return Err(HcdError::ResourceLimit(
            "revision limit reached".to_string(),
        ));
    }
    let target_record = bundle.revision(target)?;
    let (historical, _) = manifest_at_revision(bundle, &head, Some(target))?;
    let revision = expected_head + 1;
    let patch_id = format!("restore-{target}-{revision}");
    let patch_hash = hash_bytes(format!("restore:{target}:{expected_head}").as_bytes());
    let record = RevisionRecord {
        schema_version: head.schema_version.clone(),
        document_id: head.document_id.clone(),
        revision,
        parent_revision: Some(expected_head),
        patch_id: Some(patch_id.clone()),
        patch_hash: Some(patch_hash),
        patch_base_revision: Some(expected_head),
        author_id: None,
        author_name: None,
        root_hash: target_record.root_hash.clone(),
        annotation_root_hash: target_record.annotation_root_hash.clone(),
        index_prefix: target_record.index_prefix.clone(),
        index_root_href: target_record.index_root_href.clone(),
        index_page_count: Some(historical.index_page_count),
        chunk_count: Some(historical.chunk_count),
        asset_index_href: target_record.asset_index_href,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        dirty_grid_parts: Vec::new(),
        grid_row_insertions: Vec::new(),
        structural_change: true,
    };
    head.revision = revision;
    head.root_hash = record.root_hash.clone();
    head.annotation_root_hash = record.annotation_root_hash.clone();
    head.annotation_href = historical.annotation_href;
    head.index_prefix = record.index_prefix.clone();
    head.index_root_href = record.index_root_href.clone();
    head.index_page_count = historical.index_page_count;
    head.chunk_count = historical.chunk_count;
    bundle.write_revision(&record)?;
    bundle.write_manifest(&head)?;
    Ok(ApplyResult {
        document_id: head.document_id,
        patch_id,
        base_revision: expected_head,
        revision,
        root_hash: record.root_hash,
        annotation_root_hash: record.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        warnings: head.warnings,
        idempotent_replay: false,
    })
}
