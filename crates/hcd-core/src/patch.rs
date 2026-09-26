use crate::bundle::{
    finalize_root_hash, hash_descriptor, now_epoch_ms, read_json_bounded, Bundle, INDEX_PAGE_SIZE,
};
use crate::hash::{hash_bytes, node_bloom, node_bloom_might_contain, stable_node_id};
#[cfg(test)]
use crate::HCD_SCHEMA_VERSION;
use crate::{
    extract_html_image_nodes, extract_html_text_nodes, image_visual_hash, AnnotationSet,
    ApplyResult, AssetDescriptor, FidelityWarning, GridColumnDeletion, GridColumnInsertion,
    GridRowDeletion, GridRowInsertion, HcdError, ImageExtractEntry, ImageExtractPage,
    ImageGeometry, ImageGeometryUnit, ImageNodeLookup, ImageNodeState, NodeMapEntry,
    NodeStylePatch, PatchBatch, PatchOperation, RevisionRecord, SourceAnchor, TextExtractEntry,
    TextExtractPage, TextNodeLookup, HCD_PATCH_SCHEMA_VERSION, HCD_PATCH_SCHEMA_VERSION_10,
    HCD_PATCH_SCHEMA_VERSION_11, HCD_PATCH_SCHEMA_VERSION_12, HCD_PATCH_SCHEMA_VERSION_13,
    HCD_PATCH_SCHEMA_VERSION_14, HCD_PATCH_SCHEMA_VERSION_15, HCD_PATCH_SCHEMA_VERSION_2,
    HCD_PATCH_SCHEMA_VERSION_3, HCD_PATCH_SCHEMA_VERSION_5, HCD_PATCH_SCHEMA_VERSION_6,
    HCD_PATCH_SCHEMA_VERSION_7, HCD_PATCH_SCHEMA_VERSION_8, HCD_PATCH_SCHEMA_VERSION_9,
    MAX_CONTROL_PART_BYTES, MAX_PATCH_JSON_BYTES,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;

const MAX_PATCH_OPERATIONS: usize = 10_000;
const MAX_PATCH_INSERT_BYTES: usize = 2 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_ANNOTATION_KIND_BYTES: usize = 128;
const MAX_ACTOR_ENTRIES: usize = 64;
const MAX_METADATA_ENTRIES: usize = 128;
const MAX_ACTOR_BYTES: usize = 64 * 1024;
const MAX_METADATA_BYTES: usize = 256 * 1024;

#[derive(Clone)]
struct Splice {
    start: usize,
    delete_count: usize,
    insert_text: String,
    node_hash: String,
}

#[derive(Clone)]
struct StyleChange {
    style: NodeStylePatch,
    node_hash: String,
}

#[derive(Clone, Default)]
struct ImageChange {
    asset_hash: Option<String>,
    geometry: Option<ImageGeometry>,
    visual_hash: String,
}

#[derive(Clone)]
struct PdfTextInsertion {
    page: usize,
    node_id: String,
    x_pt: f32,
    y_pt: f32,
    width_pt: f32,
    height_pt: f32,
    font_size_pt: f32,
    text: String,
}

#[derive(Clone)]
struct XlsxMerge {
    sheet_id: String,
    start_row: u32,
    start_column: u32,
    end_row: u32,
    end_column: u32,
    node_hash: String,
}

#[derive(Clone)]
struct XlsxCellInsertion {
    sheet_id: String,
    row: u32,
    column: u32,
    text: String,
}

#[derive(Clone)]
struct XlsxRowAppend {
    sheet_id: String,
    after_row: u32,
}

#[derive(Clone)]
struct XlsxRowInsert {
    sheet_id: String,
    before_row: u32,
}

#[derive(Clone)]
struct XlsxRowDelete {
    sheet_id: String,
    row: u32,
}

#[derive(Clone)]
struct XlsxColumnInsert {
    sheet_id: String,
    before_column: u32,
}

#[derive(Clone)]
struct XlsxColumnDelete {
    sheet_id: String,
    column: u32,
}

#[derive(Clone)]
struct XlsxRowRemoval {
    sheet_id: String,
    row: u32,
}

#[derive(Clone)]
struct XlsxColumnWidth {
    sheet_id: String,
    column: u32,
    width_chars: f64,
}

pub fn apply_patch(
    bundle: &Bundle,
    patch: &PatchBatch,
    expected_revision: u64,
) -> Result<ApplyResult, HcdError> {
    let _write_guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.revision > crate::MAX_REVISION {
        return Err(HcdError::ResourceLimit(format!(
            "manifest revision {} exceeds the maximum {}",
            manifest.revision,
            crate::MAX_REVISION
        )));
    }
    validate_patch_identity(&manifest, patch)?;
    let patch_bytes = serde_json::to_vec(patch)?;
    if patch_bytes.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "serialized patch is {} bytes; maximum is {MAX_PATCH_JSON_BYTES}",
            patch_bytes.len()
        )));
    }
    let patch_hash = hash_bytes(&patch_bytes);
    if let Some(result) = find_idempotent_result(bundle, &manifest, &patch.patch_id, &patch_hash)? {
        return Ok(result);
    }
    validate_patch_header(&manifest, patch, expected_revision)?;
    if patch.base_revision < manifest.revision
        && patch.operations.iter().any(|operation| {
            matches!(
                operation,
                PatchOperation::PdfTextInsert { .. }
                    | PatchOperation::XlsxCellSet { .. }
                    | PatchOperation::XlsxRowAppend { .. }
                    | PatchOperation::XlsxRowRemoveLast { .. }
                    | PatchOperation::XlsxColumnWidth { .. }
                    | PatchOperation::XlsxRowInsert { .. }
                    | PatchOperation::XlsxRowDelete { .. }
                    | PatchOperation::XlsxColumnInsert { .. }
                    | PatchOperation::XlsxColumnDelete { .. }
                    | PatchOperation::XlsxUnmerge { .. }
            )
        })
    {
        return Err(HcdError::RevisionConflict(
            "node insertion requires the current head revision".to_string(),
        ));
    }

    let mut stale_content_nodes = HashSet::new();
    if patch.base_revision < manifest.revision {
        for revision in patch.base_revision + 1..=manifest.revision {
            let record = bundle.revision(revision)?;
            stale_content_nodes.extend(record.dirty_node_ids);
        }
        if let Some(node_id) = patch
            .operations
            .iter()
            .filter(|operation| operation.is_content_change())
            .filter_map(PatchOperation::node_id)
            .find(|node_id| stale_content_nodes.contains(*node_id))
        {
            return Err(HcdError::RevisionConflict(format!(
                "node {node_id} changed after base revision {}",
                patch.base_revision
            )));
        }
    }

    let splices = collect_splices(patch)?;
    let styles = collect_styles(patch)?;
    let images = collect_image_changes(patch)?;
    let pdf_insertions = collect_pdf_insertions(patch);
    let xlsx_merges = collect_xlsx_merges(patch);
    let xlsx_unmerges = collect_xlsx_unmerges(patch);
    let xlsx_cell_set = collect_xlsx_cell_set(patch);
    let shifted_grid = if xlsx_cell_set.is_some() {
        (1..=manifest.revision).try_fold(false, |found, revision| {
            let record = bundle.revision(revision)?;
            Ok::<_, HcdError>(
                found
                    || !record.grid_row_insertions.is_empty()
                    || !record.grid_row_deletions.is_empty()
                    || !record.grid_column_insertions.is_empty()
                    || !record.grid_column_deletions.is_empty(),
            )
        })?
    } else {
        false
    };
    let xlsx_row_append = collect_xlsx_row_append(patch);
    let xlsx_row_insert = collect_xlsx_row_insert(patch);
    let xlsx_row_delete = collect_xlsx_row_delete(patch);
    let xlsx_column_insert = collect_xlsx_column_insert(patch);
    let xlsx_column_delete = collect_xlsx_column_delete(patch);
    let xlsx_row_removal = collect_xlsx_row_removal(patch);
    let xlsx_column_width = collect_xlsx_column_width(patch);
    let xlsx_row_target = xlsx_row_append
        .as_ref()
        .map(|append| find_xlsx_row_tail(bundle, &manifest, append))
        .transpose()?;
    let xlsx_insert_target = xlsx_row_insert
        .as_ref()
        .map(|insert| find_xlsx_row_insert_target(bundle, &manifest, insert))
        .transpose()?;
    let xlsx_delete_target = xlsx_row_delete
        .as_ref()
        .map(|delete| find_xlsx_row_delete_target(bundle, &manifest, delete))
        .transpose()?;
    let xlsx_column_insert_part = xlsx_column_insert
        .as_ref()
        .map(|insert| find_xlsx_column_insert_part(bundle, &manifest, insert))
        .transpose()?;
    let xlsx_column_delete_part = xlsx_column_delete
        .as_ref()
        .map(|delete| find_xlsx_column_delete_part(bundle, &manifest, delete))
        .transpose()?;
    let xlsx_removal_target = xlsx_row_removal
        .as_ref()
        .map(|removal| find_xlsx_row_removal_target(bundle, &manifest, removal))
        .transpose()?;
    let xlsx_width_part = xlsx_column_width
        .as_ref()
        .map(|width| find_xlsx_sheet_part(bundle, &manifest, &width.sheet_id))
        .transpose()?;
    let annotation_node_ids: HashSet<String> = patch
        .operations
        .iter()
        .filter_map(|operation| match operation {
            PatchOperation::AnnotationUpsert { annotation } => Some(annotation.node_id.clone()),
            _ => None,
        })
        .collect();
    let target_node_ids: HashSet<String> = splices
        .keys()
        .cloned()
        .chain(styles.keys().cloned())
        .chain(images.keys().cloned())
        .chain(xlsx_merges.keys().cloned())
        .chain(xlsx_unmerges.keys().cloned())
        .chain(annotation_node_ids.iter().cloned())
        .collect();

    let new_revision = manifest.revision + 1;
    let new_index_prefix = format!("indexes/rev-{new_revision:020}");
    let new_index_root = bundle.root().join(&new_index_prefix);
    let content_changed = !splices.is_empty()
        || !styles.is_empty()
        || !images.is_empty()
        || !pdf_insertions.is_empty()
        || !xlsx_merges.is_empty()
        || !xlsx_unmerges.is_empty()
        || xlsx_cell_set.is_some()
        || xlsx_row_append.is_some()
        || xlsx_row_insert.is_some()
        || xlsx_row_delete.is_some()
        || xlsx_column_insert.is_some()
        || xlsx_column_delete.is_some()
        || xlsx_row_removal.is_some()
        || xlsx_column_width.is_some();
    let mut index_root_href = manifest.index_root_href.clone();
    if content_changed && index_root_href.is_none() {
        fs::create_dir_all(&new_index_root)?;
    }

    let mut found_nodes: HashMap<String, usize> = HashMap::new();
    let mut dirty_nodes = BTreeSet::new();
    let mut dirty_chunks = BTreeSet::new();
    let mut dirty_parts = BTreeSet::new();
    let mut dirty_grid_parts = BTreeSet::new();
    let mut inserted_xlsx_cell_node_id = None;
    let mut appended_xlsx_row = false;
    let mut inserted_xlsx_row = false;
    let mut deleted_xlsx_row = false;
    let mut removed_xlsx_node_ids = Vec::new();
    let mut inserted_xlsx_column = false;
    let mut deleted_xlsx_column = false;
    let mut removed_xlsx_column_node_ids = Vec::new();
    let mut removed_xlsx_row = false;
    let mut changed_xlsx_column = false;
    let mut root_hasher = Sha256::new();
    let current_asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let mut asset_index = bundle.read_asset_index_for_revision(manifest.revision)?;
    let mut asset_by_hash: HashMap<String, AssetDescriptor> = asset_index
        .iter()
        .map(|asset| (asset.hash.clone(), asset.clone()))
        .collect();
    for change in images.values() {
        let Some(hash) = change.asset_hash.as_deref() else {
            continue;
        };
        if asset_by_hash.contains_key(hash) {
            continue;
        }
        let staged = bundle.staged_asset(hash)?;
        validate_staged_asset(bundle, &staged, hash)?;
        asset_by_hash.insert(hash.to_string(), staged.clone());
        asset_index.push(staged);
    }
    asset_index.sort_by(|left, right| left.hash.cmp(&right.hash));
    asset_index.dedup_by(|left, right| left.hash == right.hash);
    let asset_index_href =
        if asset_index == bundle.read_asset_index_for_revision(manifest.revision)? {
            current_asset_index_href
        } else {
            bundle.write_json_object("assets/indexes", &asset_index)?.0
        };

    for page_number in 0..manifest.index_page_count {
        let mut page = bundle.read_index_page(&manifest, page_number)?;
        let mut page_changed = false;
        for descriptor in &mut page.chunks {
            let insertions = pdf_insertions.get(&descriptor.chunk_id);
            let append_here = xlsx_row_target.as_deref() == Some(descriptor.chunk_id.as_str());
            let row_insert_here = xlsx_insert_target
                .as_ref()
                .is_some_and(|(chunk_id, _)| chunk_id == &descriptor.chunk_id);
            let row_shift_here = xlsx_row_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == insert.sheet_id
                        && grid
                            .row_end
                            .is_some_and(|end| end >= u64::from(insert.before_row))
                })
            });
            let row_delete_here = xlsx_row_delete.as_ref().is_some_and(|delete| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == delete.sheet_id
                        && grid.row_end.is_some_and(|end| end >= u64::from(delete.row))
                })
            });
            let column_shift_here = xlsx_column_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == insert.sheet_id
                        && grid
                            .column_end
                            .is_some_and(|end| end >= insert.before_column)
                })
            });
            let column_delete_here = xlsx_column_delete.as_ref().is_some_and(|delete| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == delete.sheet_id
                        && grid.column_end.is_some_and(|end| end >= delete.column)
                })
            });
            let remove_here = xlsx_removal_target.as_deref() == Some(descriptor.chunk_id.as_str());
            let width_here = xlsx_column_width.as_ref().filter(|width| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == width.sheet_id
                })
            });
            let cell_insertion = xlsx_cell_set.as_ref().filter(|insertion| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == insertion.sheet_id
                        && grid
                            .row_start
                            .is_some_and(|start| u64::from(insertion.row) >= start)
                        && grid
                            .row_end
                            .is_some_and(|end| u64::from(insertion.row) <= end)
                })
            });
            let candidates: Vec<&String> = target_node_ids
                .iter()
                .filter(|node_id| node_bloom_might_contain(&descriptor.node_bloom, node_id))
                .collect();
            if candidates.is_empty()
                && insertions.is_none()
                && cell_insertion.is_none()
                && !append_here
                && !row_shift_here
                && !row_delete_here
                && !column_shift_here
                && !column_delete_here
                && !remove_here
                && width_here.is_none()
            {
                hash_descriptor(&mut root_hasher, descriptor);
                continue;
            }

            let mut source_map = bundle.read_map(descriptor)?;
            let mut html = bundle.read_chunk(descriptor)?;
            let mut html_nodes = extract_html_text_nodes(&html)?;
            let mut image_nodes = extract_html_image_nodes(&html)?;
            let mut chunk_changed = false;
            for entry in &mut source_map.entries {
                if !target_node_ids.contains(&entry.node_id) {
                    continue;
                }
                let current_text = html_nodes.get(&entry.node_id).ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "mapped node {} is missing from canonical HTML",
                        entry.node_id
                    ))
                })?;
                let actual_node_hash = hash_bytes(current_text.as_bytes());
                if actual_node_hash != entry.node_hash {
                    return Err(HcdError::InvalidBundle(format!(
                        "node {} HTML hash {} does not match source-map hash {}",
                        entry.node_id, actual_node_hash, entry.node_hash
                    )));
                }
                found_nodes.insert(entry.node_id.clone(), current_text.chars().count());
                if entry.source.node_kind == "image"
                    && (styles.contains_key(&entry.node_id) || splices.contains_key(&entry.node_id))
                {
                    return Err(HcdError::Unsupported(format!(
                        "image node {} accepts image.replace/image.geometry, not text or node.style operations",
                        entry.node_id
                    )));
                }
                if let Some(change) = images.get(&entry.node_id) {
                    if entry.source.node_kind != "image" {
                        return Err(HcdError::Unsupported(format!(
                            "node {} is not an image node",
                            entry.node_id
                        )));
                    }
                    let current = image_nodes.get(&entry.node_id).ok_or_else(|| {
                        HcdError::InvalidBundle(format!(
                            "mapped image node {} is missing visual state",
                            entry.node_id
                        ))
                    })?;
                    if current.visual_hash != change.visual_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "image node {} expected visual hash {}, actual {}",
                            entry.node_id, change.visual_hash, current.visual_hash
                        )));
                    }
                    let asset_hash = change
                        .asset_hash
                        .clone()
                        .or_else(|| current.asset_hash.clone());
                    let geometry = change.geometry.clone().or_else(|| current.geometry.clone());
                    if let Some(hash) = change.asset_hash.as_deref() {
                        let asset = asset_by_hash.get(hash).ok_or_else(|| {
                            HcdError::InvalidBundle(format!("asset {hash} is unavailable"))
                        })?;
                        replace_image_asset(&mut html, &entry.node_id, asset)?;
                    }
                    if let Some(geometry) = change.geometry.as_ref() {
                        replace_image_geometry(&mut html, &entry.node_id, geometry)?;
                    }
                    let new_visual_hash =
                        image_visual_hash(asset_hash.as_deref(), geometry.as_ref());
                    set_element_attribute(
                        &mut html,
                        &entry.node_id,
                        "data-hcd-visual-hash",
                        &new_visual_hash,
                    )?;
                    image_nodes.insert(
                        entry.node_id.clone(),
                        crate::HtmlImageNode {
                            visual_hash: new_visual_hash,
                            asset_hash,
                            geometry,
                        },
                    );
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                let style_change = styles.get(&entry.node_id);
                if let Some(change) = style_change {
                    if !entry.source.editable {
                        return Err(HcdError::Unsupported(format!(
                            "node {} is read-only",
                            entry.node_id
                        )));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "node {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                }
                if let Some(node_splices) = splices.get(&entry.node_id) {
                    if !entry.source.editable {
                        return Err(HcdError::Unsupported(format!(
                            "node {} is read-only",
                            entry.node_id
                        )));
                    }
                    for splice in node_splices {
                        if splice.node_hash != entry.node_hash {
                            return Err(HcdError::PreconditionFailed(format!(
                                "node {} expected hash {}, actual {}",
                                entry.node_id, splice.node_hash, entry.node_hash
                            )));
                        }
                    }
                    let replacement = splice_text(current_text, node_splices)?;
                    let replacement_hash = hash_bytes(replacement.as_bytes());
                    replace_node_text(&mut html, &entry.node_id, &replacement, &replacement_hash)?;
                    if manifest.source.format == "pdf" {
                        set_element_attribute(
                            &mut html,
                            &entry.node_id,
                            "data-hcd-patched",
                            "true",
                        )?;
                        set_element_attribute(
                            &mut html,
                            &entry.node_id,
                            "title",
                            "Edited PDF text; preview placement is approximate",
                        )?;
                    }
                    entry.node_hash = replacement_hash;
                    found_nodes.insert(entry.node_id.clone(), replacement.chars().count());
                    html_nodes.insert(entry.node_id.clone(), replacement);
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = style_change {
                    apply_node_style(&mut html, &entry.node_id, &change.style)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(merge) = xlsx_merges.get(&entry.node_id) {
                    if entry.source.node_kind != "cell"
                        || !entry.source.editable
                        || descriptor
                            .grid
                            .as_ref()
                            .is_none_or(|grid| grid.sheet_id != merge.sheet_id)
                    {
                        return Err(HcdError::Unsupported(format!(
                            "node {} is not an editable cell in sheet {}",
                            entry.node_id, merge.sheet_id
                        )));
                    }
                    if merge.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "cell {} expected hash {}, actual {}",
                            entry.node_id, merge.node_hash, entry.node_hash
                        )));
                    }
                    let anchor = format!(
                        "{}{}",
                        xlsx_column_name(merge.start_column),
                        merge.start_row
                    );
                    if entry.source.paragraph_id.as_deref() != Some(anchor.as_str()) {
                        return Err(HcdError::InvalidPatch(format!(
                            "node {} is not the merge anchor {anchor}",
                            entry.node_id
                        )));
                    }
                    let grid = descriptor.grid.as_ref().expect("validated above");
                    if grid.kind != crate::GridChunkKind::Cells
                        || grid
                            .row_start
                            .is_none_or(|row| u64::from(merge.start_row) < row)
                        || grid
                            .row_end
                            .is_none_or(|row| u64::from(merge.end_row) > row)
                    {
                        return Err(HcdError::Unsupported(
                            "XLSX merge must stay within one loaded cell window".to_string(),
                        ));
                    }
                    merge_xlsx_cells(&mut html, merge)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(unmerge) = xlsx_unmerges.get(&entry.node_id) {
                    if entry.source.node_kind != "cell"
                        || !entry.source.editable
                        || descriptor
                            .grid
                            .as_ref()
                            .is_none_or(|grid| grid.sheet_id != unmerge.sheet_id)
                    {
                        return Err(HcdError::Unsupported(
                            "XLSX unmerge requires an editable anchor cell".to_string(),
                        ));
                    }
                    if unmerge.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "cell {} expected hash {}, actual {}",
                            entry.node_id, unmerge.node_hash, entry.node_hash
                        )));
                    }
                    let anchor = format!(
                        "{}{}",
                        xlsx_column_name(unmerge.start_column),
                        unmerge.start_row
                    );
                    if entry.source.paragraph_id.as_deref() != Some(anchor.as_str()) {
                        return Err(HcdError::InvalidPatch(
                            "XLSX unmerge node is not the range anchor".to_string(),
                        ));
                    }
                    if descriptor.grid.as_ref().is_none_or(|grid| {
                        grid.kind != crate::GridChunkKind::Cells
                            || grid
                                .row_start
                                .is_none_or(|start| u64::from(unmerge.start_row) < start)
                            || grid
                                .row_end
                                .is_none_or(|end| u64::from(unmerge.end_row) > end)
                    }) {
                        return Err(HcdError::Unsupported(
                            "XLSX unmerge must stay within one loaded cell window".to_string(),
                        ));
                    }
                    // Original source merges may hide covered cell values. Only split a merge
                    // introduced after import, so source-backed export cannot reveal lost data.
                    let original = bundle.revision(0)?;
                    let mut initial = manifest.clone();
                    initial.index_prefix = original.index_prefix;
                    initial.index_root_href = original.index_root_href;
                    initial.index_page_count = original
                        .index_page_count
                        .unwrap_or(manifest.index_page_count);
                    let initial_page = bundle.read_index_page(&initial, page_number)?;
                    let initial_descriptor = initial_page
                        .chunks
                        .iter()
                        .find(|candidate| candidate.chunk_id == descriptor.chunk_id)
                        .ok_or_else(|| {
                            HcdError::InvalidBundle("original XLSX chunk is missing".to_string())
                        })?;
                    let initial_html = bundle.read_chunk(initial_descriptor)?;
                    if xlsx_cells(&initial_html)?.iter().any(|cell| {
                        cell.row == unmerge.start_row
                            && cell.column == unmerge.start_column
                            && cell.merged_range.is_some()
                    }) {
                        return Err(HcdError::Unsupported(
                            "splitting a source XLSX merge is not yet supported".to_string(),
                        ));
                    }
                    unmerge_xlsx_cells(&mut html, &initial_html, unmerge)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
            }

            if let Some(insertions) = insertions {
                for insertion in insertions {
                    insert_pdf_text(&mut html, &mut source_map, insertion)?;
                    html_nodes.insert(insertion.node_id.clone(), insertion.text.clone());
                    dirty_nodes.insert(insertion.node_id.clone());
                    dirty_parts.insert(format!("pdf/pages/{}", insertion.page));
                }
                descriptor.node_count += insertions.len();
                descriptor.block_count += insertions.len();
                descriptor.node_bloom = node_bloom(
                    source_map
                        .entries
                        .iter()
                        .map(|entry| entry.node_id.as_str()),
                );
                if descriptor.first_node_id.is_none() {
                    descriptor.first_node_id = source_map
                        .entries
                        .first()
                        .map(|entry| entry.node_id.clone());
                }
                descriptor.last_node_id =
                    source_map.entries.last().map(|entry| entry.node_id.clone());
                chunk_changed = true;
            }
            if let Some(insertion) = cell_insertion {
                if inserted_xlsx_cell_node_id.is_some() {
                    return Err(HcdError::InvalidBundle(
                        "XLSX row occurs in more than one cell window".to_string(),
                    ));
                }
                let (node_id, part) = insert_xlsx_cell(
                    &mut html,
                    &mut source_map,
                    &manifest.document_id,
                    insertion,
                    shifted_grid.then_some(manifest.revision),
                )?;
                html_nodes.insert(node_id.clone(), insertion.text.clone());
                descriptor.node_count += 1;
                descriptor.node_bloom = node_bloom(
                    source_map
                        .entries
                        .iter()
                        .map(|entry| entry.node_id.as_str()),
                );
                descriptor.first_node_id = source_map
                    .entries
                    .first()
                    .map(|entry| entry.node_id.clone());
                descriptor.last_node_id =
                    source_map.entries.last().map(|entry| entry.node_id.clone());
                if let Some(grid) = descriptor.grid.as_mut() {
                    grid.column_start = Some(
                        grid.column_start
                            .map_or(insertion.column, |start| start.min(insertion.column)),
                    );
                    grid.column_end = Some(
                        grid.column_end
                            .map_or(insertion.column, |end| end.max(insertion.column)),
                    );
                }
                dirty_nodes.insert(node_id.clone());
                dirty_parts.insert(part);
                inserted_xlsx_cell_node_id = Some(node_id);
                chunk_changed = true;
            }
            if append_here {
                let append = xlsx_row_append
                    .as_ref()
                    .expect("target requires row append");
                let part = source_map
                    .entries
                    .iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part.clone())
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX row append requires a mapped cell in the last window".to_string(),
                        )
                    })?;
                append_xlsx_row(&mut html, append.after_row)?;
                let grid = descriptor.grid.as_mut().expect("validated row target");
                grid.row_end = Some(u64::from(append.after_row) + 1);
                descriptor.block_count += 1;
                dirty_grid_parts.insert(part);
                appended_xlsx_row = true;
                chunk_changed = true;
            }
            if row_shift_here {
                let insert = xlsx_row_insert
                    .as_ref()
                    .expect("row shift requires insertion");
                shift_xlsx_row_window(
                    &mut html,
                    &mut source_map,
                    descriptor,
                    insert.before_row,
                    row_insert_here,
                )?;
                dirty_grid_parts.insert(
                    xlsx_insert_target
                        .as_ref()
                        .expect("resolved sheet part")
                        .1
                        .clone(),
                );
                if row_insert_here {
                    inserted_xlsx_row = true;
                }
                chunk_changed = true;
            }
            if row_delete_here {
                let delete = xlsx_row_delete.as_ref().expect("row deletion exists");
                let removed =
                    delete_xlsx_row_window(&mut html, &mut source_map, descriptor, delete.row)?;
                if xlsx_delete_target
                    .as_ref()
                    .is_some_and(|(_, chunk)| chunk == &descriptor.chunk_id)
                {
                    deleted_xlsx_row = true;
                    removed_xlsx_node_ids.extend(removed);
                }
                html_nodes = extract_html_text_nodes(&html)?;
                dirty_grid_parts.insert(
                    xlsx_delete_target
                        .as_ref()
                        .expect("resolved sheet part")
                        .0
                        .clone(),
                );
                chunk_changed = true;
            }
            if column_shift_here {
                let insert = xlsx_column_insert
                    .as_ref()
                    .expect("column shift requires insertion");
                shift_xlsx_column_window(
                    &mut html,
                    &mut source_map,
                    descriptor,
                    insert.before_column,
                )?;
                dirty_grid_parts.insert(
                    xlsx_column_insert_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                );
                inserted_xlsx_column = true;
                chunk_changed = true;
            }
            if column_delete_here {
                let delete = xlsx_column_delete.as_ref().expect("column deletion exists");
                removed_xlsx_column_node_ids.extend(delete_xlsx_column_window(
                    &mut html,
                    &mut source_map,
                    descriptor,
                    delete.column,
                )?);
                html_nodes = extract_html_text_nodes(&html)?;
                dirty_grid_parts.insert(
                    xlsx_column_delete_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                );
                deleted_xlsx_column = true;
                chunk_changed = true;
            }
            if remove_here {
                let removal = xlsx_row_removal
                    .as_ref()
                    .expect("target requires row removal");
                let part = source_map
                    .entries
                    .iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part.clone())
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX last window has no mapped source cell".to_string(),
                        )
                    })?;
                remove_empty_xlsx_tail_row(&mut html, removal.row)?;
                let grid = descriptor
                    .grid
                    .as_mut()
                    .expect("validated row removal target");
                grid.row_end = Some(u64::from(removal.row - 1));
                descriptor.block_count =
                    descriptor.block_count.checked_sub(1).ok_or_else(|| {
                        HcdError::InvalidBundle("XLSX row window has no blocks".to_string())
                    })?;
                dirty_grid_parts.insert(part);
                removed_xlsx_row = true;
                chunk_changed = true;
            }
            if let Some(width) = width_here {
                set_xlsx_column_width(&mut html, width.column, width.width_chars)?;
                let grid = descriptor
                    .grid
                    .as_mut()
                    .expect("validated column width target");
                grid.column_end = Some(grid.column_end.unwrap_or(0).max(width.column));
                dirty_grid_parts.insert(
                    xlsx_width_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                );
                changed_xlsx_column = true;
                chunk_changed = true;
            }

            if chunk_changed {
                page_changed = true;
                let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
                let (map_href, map_hash) = bundle.write_json_object("maps", &source_map)?;
                descriptor.html_href = html_href;
                descriptor.html_hash = html_hash;
                descriptor.map_href = map_href;
                descriptor.map_hash = map_hash;
                descriptor.byte_length = html.len() as u64;
                descriptor.text_chars = html_nodes.values().map(|text| text.chars().count()).sum();
                dirty_chunks.insert(descriptor.chunk_id.clone());
            }
            hash_descriptor(&mut root_hasher, descriptor);
        }

        if content_changed && (index_root_href.is_none() || page_changed) {
            page.revision = new_revision;
            if let Some(root) = &index_root_href {
                index_root_href = Some(bundle.replace_index_page(root, page_number, &page)?);
            } else {
                let new_path = new_index_root.join(format!(
                    "{page_number:06}.json{}",
                    manifest.storage_codec.suffix()
                ));
                crate::bundle::atomic_write_json_encoded(&new_path, &page)?;
            }
        }
    }

    for node_id in &target_node_ids {
        if !found_nodes.contains_key(node_id) {
            return Err(HcdError::NodeNotFound(node_id.clone()));
        }
    }
    for insertion in pdf_insertions.values().flatten() {
        if !dirty_nodes.contains(&insertion.node_id) {
            return Err(HcdError::NodeNotFound(format!(
                "PDF page {}",
                insertion.page
            )));
        }
    }
    if let Some(insertion) = &xlsx_cell_set {
        if inserted_xlsx_cell_node_id.is_none() {
            return Err(HcdError::Unsupported(format!(
                "XLSX cell {}{} is outside an existing HCD cell window",
                xlsx_column_name(insertion.column),
                insertion.row
            )));
        }
    }
    if xlsx_row_append.is_some() && !appended_xlsx_row {
        return Err(HcdError::InvalidBundle(
            "XLSX row append target disappeared".to_string(),
        ));
    }
    if xlsx_row_insert.is_some() && !inserted_xlsx_row {
        return Err(HcdError::InvalidBundle(
            "XLSX middle row target disappeared".to_string(),
        ));
    }
    if xlsx_row_delete.is_some() && !deleted_xlsx_row {
        return Err(HcdError::InvalidBundle(
            "XLSX row deletion target disappeared".to_string(),
        ));
    }
    if xlsx_column_insert.is_some() && !inserted_xlsx_column {
        return Err(HcdError::InvalidBundle(
            "XLSX middle column target disappeared".to_string(),
        ));
    }
    if xlsx_column_delete.is_some() && !deleted_xlsx_column {
        return Err(HcdError::InvalidBundle(
            "XLSX column deletion target disappeared".to_string(),
        ));
    }
    if xlsx_row_removal.is_some() && !removed_xlsx_row {
        return Err(HcdError::InvalidBundle(
            "XLSX row removal target disappeared".to_string(),
        ));
    }
    if xlsx_column_width.is_some() && !changed_xlsx_column {
        return Err(HcdError::InvalidBundle(
            "XLSX column width target disappeared".to_string(),
        ));
    }

    validate_annotation_ranges(patch, &found_nodes)?;
    let (annotation_href, annotation_root_hash) = apply_annotations(bundle, &manifest, patch)?;
    let root_hash = if content_changed {
        finalize_root_hash(bundle, root_hasher, &asset_index_href)?
    } else {
        manifest.root_hash.clone()
    };

    manifest.revision = new_revision;
    manifest.root_hash = root_hash.clone();
    manifest.annotation_root_hash = annotation_root_hash.clone();
    manifest.annotation_href = annotation_href;
    if content_changed {
        if index_root_href.is_some() {
            manifest.index_root_href = index_root_href;
        } else {
            manifest.index_prefix = new_index_prefix.clone();
        }
    }

    let result = ApplyResult {
        document_id: manifest.document_id.clone(),
        patch_id: patch.patch_id.clone(),
        base_revision: patch.base_revision,
        revision: new_revision,
        root_hash: root_hash.clone(),
        annotation_root_hash: annotation_root_hash.clone(),
        dirty_node_ids: dirty_nodes.iter().cloned().collect(),
        dirty_chunk_ids: dirty_chunks.iter().cloned().collect(),
        dirty_source_parts: dirty_parts.iter().cloned().collect(),
        warnings: styles
            .keys()
            .map(|node_id| FidelityWarning {
                code: "HCD_PRESENTATION_STYLE_ONLY".to_string(),
                message: "node.style changes canonical HCD/HTML presentation; current source-backed Office/PDF exporters reject revisions containing presentation styles instead of silently dropping them".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            })
            .chain(images.keys().map(|node_id| FidelityWarning {
                code: "HCD_IMAGE_PATCH_SEMANTIC_EXPORT".to_string(),
                message: "image changes are canonical in HCD and pure-Rust semantic exports; source-backed Office/PDF export rejects them before writing until format-specific media rewrites are implemented".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(splices.keys().filter(|_| manifest.source.format == "pdf").map(|node_id| FidelityWarning {
                code: "PDF_EDITED_TEXT_OVERLAY_APPROXIMATE".to_string(),
                message: "edited PDF text is painted over its original page raster for preview; source typography and background cannot be restored exactly".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(pdf_insertions.values().flatten().map(|insertion| FidelityWarning {
                code: "PDF_INSERTED_TEXT_OVERLAY".to_string(),
                message: "new PDF text is positioned over the original page raster; background and typography remain approximate".to_string(),
                node_id: Some(insertion.node_id.clone()),
                source_part: Some(format!("pdf/pages/{}", insertion.page)),
            }))
            .collect(),
        idempotent_replay: false,
    };
    let record = RevisionRecord {
        schema_version: manifest.schema_version.clone(),
        document_id: manifest.document_id.clone(),
        revision: new_revision,
        parent_revision: Some(new_revision - 1),
        patch_id: Some(patch.patch_id.clone()),
        patch_hash: Some(patch_hash),
        patch_base_revision: Some(patch.base_revision),
        author_id: None,
        author_name: None,
        root_hash,
        annotation_root_hash,
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: result.dirty_node_ids.clone(),
        dirty_chunk_ids: result.dirty_chunk_ids.clone(),
        dirty_source_parts: result.dirty_source_parts.clone(),
        dirty_grid_parts: dirty_grid_parts.into_iter().collect(),
        grid_row_insertions: xlsx_row_insert
            .as_ref()
            .map(|insert| GridRowInsertion {
                sheet_part: xlsx_insert_target
                    .as_ref()
                    .expect("resolved sheet part")
                    .1
                    .clone(),
                before_row: insert.before_row,
            })
            .into_iter()
            .collect(),
        grid_row_deletions: xlsx_row_delete
            .as_ref()
            .map(|delete| GridRowDeletion {
                sheet_part: xlsx_delete_target
                    .as_ref()
                    .expect("resolved sheet part")
                    .0
                    .clone(),
                row: delete.row,
                removed_node_ids: removed_xlsx_node_ids,
            })
            .into_iter()
            .collect(),
        grid_column_insertions: xlsx_column_insert
            .as_ref()
            .map(|insert| GridColumnInsertion {
                sheet_part: xlsx_column_insert_part
                    .as_ref()
                    .expect("resolved sheet part")
                    .clone(),
                before_column: insert.before_column,
            })
            .into_iter()
            .collect(),
        grid_column_deletions: xlsx_column_delete
            .as_ref()
            .map(|delete| GridColumnDeletion {
                sheet_part: xlsx_column_delete_part
                    .as_ref()
                    .expect("resolved sheet part")
                    .clone(),
                column: delete.column,
                removed_node_ids: removed_xlsx_column_node_ids,
            })
            .into_iter()
            .collect(),
        structural_change: false,
    };
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(result)
}

pub fn extract_text_page(
    bundle: &Bundle,
    cursor: Option<&str>,
    limit: usize,
) -> Result<TextExtractPage, HcdError> {
    let manifest = bundle.manifest()?;
    let limit = limit.clamp(1, 10_000);
    let (mut sequence, mut entry_offset) = parse_cursor(cursor)?;
    let mut entries = Vec::with_capacity(limit.min(1024));

    while sequence < manifest.chunk_count && entries.len() < limit {
        let page_number = sequence / INDEX_PAGE_SIZE;
        let descriptor_offset = sequence % INDEX_PAGE_SIZE;
        let page = bundle.read_index_page(&manifest, page_number)?;
        let descriptor = page.chunks.get(descriptor_offset).ok_or_else(|| {
            HcdError::InvalidBundle(format!("missing chunk descriptor at sequence {sequence}"))
        })?;
        let source_map = bundle.read_map(descriptor)?;
        let html = bundle.read_chunk(descriptor)?;
        let html_nodes = extract_html_text_nodes(&html)?;
        while entry_offset < source_map.entries.len() && entries.len() < limit {
            let entry = &source_map.entries[entry_offset];
            if entry.source.node_kind == "image" {
                entry_offset += 1;
                continue;
            }
            let text = html_nodes.get(&entry.node_id).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "mapped node {} is missing from canonical HTML",
                    entry.node_id
                ))
            })?;
            let actual_hash = hash_bytes(text.as_bytes());
            if actual_hash != entry.node_hash {
                return Err(HcdError::InvalidBundle(format!(
                    "node {} HTML hash {} does not match source-map hash {}",
                    entry.node_id, actual_hash, entry.node_hash
                )));
            }
            entries.push(TextExtractEntry {
                chunk_id: descriptor.chunk_id.clone(),
                node_id: entry.node_id.clone(),
                text: text.clone(),
                node_hash: entry.node_hash.clone(),
                source: entry.source.clone(),
            });
            entry_offset += 1;
        }
        if entry_offset >= source_map.entries.len() {
            sequence += 1;
            entry_offset = 0;
        }
    }

    let next_cursor =
        (sequence < manifest.chunk_count).then(|| format!("{sequence}:{entry_offset}"));
    Ok(TextExtractPage {
        document_id: manifest.document_id,
        revision: manifest.revision,
        entries,
        next_cursor,
    })
}

/// Resolve one editable-text IR node by its stable HCD node ID at the current
/// bundle revision. Chunk bloom filters and source maps are consulted before
/// materializing HTML, so lookup does not require a full-document text buffer.
pub fn get_text_node(bundle: &Bundle, node_id: &str) -> Result<TextNodeLookup, HcdError> {
    validate_node_id(node_id)?;
    let manifest = bundle.manifest()?;
    let mut found = None;

    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(&manifest, page_number)?;
        for descriptor in &page.chunks {
            if !node_bloom_might_contain(&descriptor.node_bloom, node_id) {
                continue;
            }
            let source_map = bundle.read_map(descriptor)?;
            let mut matches = source_map
                .entries
                .iter()
                .filter(|entry| entry.node_id == node_id);
            let Some(entry) = matches.next() else {
                continue;
            };
            if entry.source.node_kind == "image" {
                continue;
            }
            if matches.next().is_some() || found.is_some() {
                return Err(HcdError::InvalidBundle(format!(
                    "node ID {node_id} occurs in more than one source map"
                )));
            }
            let html = bundle.read_chunk(descriptor)?;
            let html_nodes = extract_html_text_nodes(&html)?;
            let text = html_nodes.get(node_id).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "mapped node {node_id} is missing from canonical HTML"
                ))
            })?;
            let actual_hash = hash_bytes(text.as_bytes());
            if actual_hash != entry.node_hash {
                return Err(HcdError::InvalidBundle(format!(
                    "node {node_id} HTML hash {actual_hash} does not match source-map hash {}",
                    entry.node_hash
                )));
            }
            found = Some(TextExtractEntry {
                chunk_id: descriptor.chunk_id.clone(),
                node_id: entry.node_id.clone(),
                text: text.clone(),
                node_hash: entry.node_hash.clone(),
                source: entry.source.clone(),
            });
        }
    }

    let node = found.ok_or_else(|| HcdError::NodeNotFound(node_id.to_string()))?;
    Ok(TextNodeLookup {
        document_id: manifest.document_id,
        revision: manifest.revision,
        node,
    })
}

pub fn get_image_node(bundle: &Bundle, node_id: &str) -> Result<ImageNodeLookup, HcdError> {
    validate_node_id(node_id)?;
    let manifest = bundle.manifest()?;
    let mut found = None;
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(&manifest, page_number)?;
        for descriptor in &page.chunks {
            if !node_bloom_might_contain(&descriptor.node_bloom, node_id) {
                continue;
            }
            let source_map = bundle.read_map(descriptor)?;
            let Some(entry) = source_map
                .entries
                .iter()
                .find(|entry| entry.node_id == node_id && entry.source.node_kind == "image")
            else {
                continue;
            };
            if found.is_some() {
                return Err(HcdError::InvalidBundle(format!(
                    "image node ID {node_id} occurs in more than one source map"
                )));
            }
            let html = bundle.read_chunk(descriptor)?;
            let images = extract_html_image_nodes(&html)?;
            let image = images.get(node_id).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "mapped image node {node_id} is missing from canonical HTML"
                ))
            })?;
            found = Some(ImageNodeLookup {
                document_id: manifest.document_id.clone(),
                revision: manifest.revision,
                chunk_id: descriptor.chunk_id.clone(),
                node: ImageNodeState {
                    node_id: node_id.to_string(),
                    visual_hash: image.visual_hash.clone(),
                    asset_hash: image.asset_hash.clone(),
                    geometry: image.geometry.clone(),
                    source: entry.source.clone(),
                },
            });
        }
    }
    found.ok_or_else(|| HcdError::NodeNotFound(node_id.to_string()))
}

pub fn extract_image_page(
    bundle: &Bundle,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ImageExtractPage, HcdError> {
    let manifest = bundle.manifest()?;
    let limit = limit.clamp(1, 10_000);
    let (mut sequence, mut entry_offset) = parse_cursor(cursor)?;
    let mut entries = Vec::with_capacity(limit.min(256));
    while sequence < manifest.chunk_count && entries.len() < limit {
        let page_number = sequence / INDEX_PAGE_SIZE;
        let descriptor_offset = sequence % INDEX_PAGE_SIZE;
        let page = bundle.read_index_page(&manifest, page_number)?;
        let descriptor = page.chunks.get(descriptor_offset).ok_or_else(|| {
            HcdError::InvalidBundle(format!("missing chunk descriptor at sequence {sequence}"))
        })?;
        let source_map = bundle.read_map(descriptor)?;
        let mut images = None;
        while entry_offset < source_map.entries.len() && entries.len() < limit {
            let entry = &source_map.entries[entry_offset];
            entry_offset += 1;
            if entry.source.node_kind != "image" {
                continue;
            }
            let images = match &images {
                Some(images) => images,
                None => images.insert(extract_html_image_nodes(&bundle.read_chunk(descriptor)?)?),
            };
            let image = images.get(&entry.node_id).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "mapped image node {} is missing from canonical HTML",
                    entry.node_id
                ))
            })?;
            entries.push(ImageExtractEntry {
                chunk_id: descriptor.chunk_id.clone(),
                node: ImageNodeState {
                    node_id: entry.node_id.clone(),
                    visual_hash: image.visual_hash.clone(),
                    asset_hash: image.asset_hash.clone(),
                    geometry: image.geometry.clone(),
                    source: entry.source.clone(),
                },
            });
        }
        if entry_offset >= source_map.entries.len() {
            sequence += 1;
            entry_offset = 0;
        }
    }
    let next_cursor =
        (sequence < manifest.chunk_count).then(|| format!("{sequence}:{entry_offset}"));
    Ok(ImageExtractPage {
        document_id: manifest.document_id,
        revision: manifest.revision,
        entries,
        next_cursor,
    })
}

fn validate_patch_header(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
    expected_revision: u64,
) -> Result<(), HcdError> {
    if manifest.revision >= crate::MAX_REVISION {
        return Err(HcdError::ResourceLimit(format!(
            "HCD revision limit {} has been reached; compact or archive the document before applying more patches",
            crate::MAX_REVISION
        )));
    }
    validate_patch_identity(manifest, patch)?;
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_revision}, actual {}",
            manifest.revision
        )));
    }
    if patch.base_revision > manifest.revision {
        return Err(HcdError::RevisionConflict(format!(
            "base revision {} is ahead of head {}",
            patch.base_revision, manifest.revision
        )));
    }
    Ok(())
}

fn validate_patch_identity(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(), HcdError> {
    if patch.schema_version != HCD_PATCH_SCHEMA_VERSION
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_2
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_6
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_7
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_8
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_9
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_10
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_11
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_12
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_13
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_14
        && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_15
    {
        return Err(HcdError::InvalidPatch(format!(
            "unsupported schema version {}",
            patch.schema_version
        )));
    }
    validate_identifier("documentId", &patch.document_id)?;
    if patch.document_id != manifest.document_id {
        return Err(HcdError::InvalidPatch(
            "documentId does not match the bundle manifest".to_string(),
        ));
    }
    if patch.patch_id.trim().is_empty() {
        return Err(HcdError::InvalidPatch("patchId is required".to_string()));
    }
    if patch.patch_id.len() > MAX_IDENTIFIER_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "patchId exceeds {MAX_IDENTIFIER_BYTES} bytes"
        )));
    }
    if patch.operations.is_empty() || patch.operations.len() > MAX_PATCH_OPERATIONS {
        return Err(HcdError::ResourceLimit(format!(
            "patch operation count must be between 1 and {MAX_PATCH_OPERATIONS}"
        )));
    }
    validate_string_map("actor", &patch.actor, MAX_ACTOR_ENTRIES, MAX_ACTOR_BYTES)?;
    validate_string_map(
        "metadata",
        &patch.metadata,
        MAX_METADATA_ENTRIES,
        MAX_METADATA_BYTES,
    )?;
    let mut inserted = 0usize;
    for operation in &patch.operations {
        match operation {
            PatchOperation::TextSplice {
                node_id,
                insert_text,
                precondition,
                ..
            } => {
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                if insert_text.len() > MAX_PATCH_INSERT_BYTES {
                    return Err(HcdError::ResourceLimit(format!(
                        "one text.splice inserts {} bytes; maximum is {MAX_PATCH_INSERT_BYTES}",
                        insert_text.len()
                    )));
                }
                inserted = inserted.checked_add(insert_text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::PdfTextInsert {
                page,
                x_pt,
                y_pt,
                width_pt,
                height_pt,
                font_size_pt,
                text,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                    || manifest.source.format != "pdf"
                {
                    return Err(HcdError::Unsupported(
                        "pdf.text.insert requires a PDF bundle and hcd-patch/5".to_string(),
                    ));
                }
                if *page == 0 || *page > manifest.chunk_count {
                    return Err(HcdError::InvalidPatch(
                        "PDF page is outside the document".to_string(),
                    ));
                }
                if !x_pt.is_finite()
                    || !y_pt.is_finite()
                    || !width_pt.is_finite()
                    || !height_pt.is_finite()
                    || !font_size_pt.is_finite()
                    || *x_pt < 0.0
                    || *y_pt < 0.0
                    || *width_pt <= 0.0
                    || *height_pt <= 0.0
                    || *x_pt > 14_400.0
                    || *y_pt > 14_400.0
                    || *width_pt > 14_400.0
                    || *height_pt > 14_400.0
                    || !(1.0..=256.0).contains(font_size_pt)
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF text box geometry is invalid".to_string(),
                    ));
                }
                if text.trim().is_empty()
                    || text.chars().count() > 10_000
                    || text.contains(['\r', '\n'])
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "PDF text box is empty or contains unsupported text".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxMerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_6
                        | HCD_PATCH_SCHEMA_VERSION_7
                        | HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.merge requires one operation on an XLSX bundle with hcd-patch/6"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(HcdError::InvalidPatch("invalid XLSX sheetId".to_string()));
                }
                validate_sha256("nodeHash", &precondition.node_hash)?;
                let rows = end_row.saturating_sub(*start_row).saturating_add(1);
                let columns = end_column.saturating_sub(*start_column).saturating_add(1);
                if *start_row == 0
                    || *start_column == 0
                    || *end_row > 1_048_576
                    || *end_column > 16_384
                    || *end_row < *start_row
                    || *end_column < *start_column
                    || rows.saturating_mul(columns) < 2
                    || rows.saturating_mul(columns) > 10_000
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX merge range must contain 2 to 10000 valid cells".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxCellSet {
                sheet_id,
                row,
                column,
                text,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_7
                        | HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.cell.set requires one operation on an XLSX bundle with hcd-patch/7"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                    || !(1..=16_384).contains(column)
                    || text.is_empty()
                    || text.chars().count() > 32_767
                    || text.chars().any(is_forbidden_xml_character)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX cell insertion has an invalid sheet, address, or text".to_string(),
                    ));
                }
                inserted = inserted.checked_add(text.len()).ok_or_else(|| {
                    HcdError::ResourceLimit("patch insert byte count overflowed".to_string())
                })?;
            }
            PatchOperation::XlsxUnmerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.unmerge requires one operation on an XLSX bundle with hcd-patch/11"
                            .to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || *start_row == 0
                    || *start_column == 0
                    || *end_row > 1_048_576
                    || *end_column > 16_384
                    || *end_row < *start_row
                    || *end_column < *start_column
                    || end_row
                        .saturating_sub(*start_row)
                        .saturating_add(1)
                        .saturating_mul(end_column.saturating_sub(*start_column).saturating_add(1))
                        < 2
                    || end_row
                        .saturating_sub(*start_row)
                        .saturating_add(1)
                        .saturating_mul(end_column.saturating_sub(*start_column).saturating_add(1))
                        > 10_000
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX unmerge range".to_string(),
                    ));
                }
                validate_sha256("nodeHash", &precondition.node_hash)?;
            }
            PatchOperation::XlsxRowAppend {
                sheet_id,
                after_row,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_8
                        | HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.row.append requires one operation on an XLSX bundle with hcd-patch/8"
                            .to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..1_048_576).contains(after_row)
                {
                    return Err(HcdError::InvalidPatch(
                        "XLSX row append has an invalid sheet or last row".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.row.insert requires one operation on an XLSX bundle with hcd-patch/12".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_575).contains(before_row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX middle row insertion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowDelete { sheet_id, row } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_14 | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.row.delete requires one operation on an XLSX bundle with hcd-patch/14".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=1_048_576).contains(row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX row deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxColumnInsert {
                sheet_id,
                before_column,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.column.insert requires one operation on an XLSX bundle with hcd-patch/13".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_383).contains(before_column)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX middle column insertion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxColumnDelete { sheet_id, column } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_15
                    || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported("xlsx.column.delete requires one operation on an XLSX bundle with hcd-patch/15".to_string()));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_384).contains(column)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX column deletion target".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxColumnWidth {
                sheet_id,
                column,
                width_chars,
            } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_9
                        | HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.column.width requires one operation on an XLSX bundle with hcd-patch/9".to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(1..=16_384).contains(column)
                    || !width_chars.is_finite()
                    || !(1.0..=255.0).contains(width_chars)
                    || ((width_chars * 100.0).round() - width_chars * 100.0).abs() > 1e-7
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX column width target or value".to_string(),
                    ));
                }
            }
            PatchOperation::XlsxRowRemoveLast { sheet_id, row } => {
                if !matches!(
                    patch.schema_version.as_str(),
                    HCD_PATCH_SCHEMA_VERSION_10
                        | HCD_PATCH_SCHEMA_VERSION_11
                        | HCD_PATCH_SCHEMA_VERSION_12
                        | HCD_PATCH_SCHEMA_VERSION_13
                        | HCD_PATCH_SCHEMA_VERSION_14
                        | HCD_PATCH_SCHEMA_VERSION_15
                ) || manifest.source.format != "xlsx"
                    || patch.operations.len() != 1
                {
                    return Err(HcdError::Unsupported(
                        "xlsx.row.remove-last requires one operation on an XLSX bundle with hcd-patch/10".to_string(),
                    ));
                }
                if sheet_id.len() != 34
                    || !sheet_id.starts_with("s_")
                    || !sheet_id[2..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || !(2..=1_048_576).contains(row)
                {
                    return Err(HcdError::InvalidPatch(
                        "invalid XLSX last row removal target".to_string(),
                    ));
                }
            }
            PatchOperation::NodeStyle {
                node_id,
                style,
                precondition,
            } => {
                if patch.schema_version == HCD_PATCH_SCHEMA_VERSION {
                    return Err(HcdError::InvalidPatch(
                        "node.style requires schemaVersion hcd-patch/2".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("nodeHash", &precondition.node_hash)?;
                validate_node_style(style)?;
            }
            PatchOperation::ImageReplace {
                node_id,
                asset_hash,
                precondition,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
                    && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                {
                    return Err(HcdError::InvalidPatch(
                        "image.replace requires schemaVersion hcd-patch/3".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("assetHash", asset_hash)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
            }
            PatchOperation::ImageGeometry {
                node_id,
                geometry,
                precondition,
            } => {
                if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_3
                    && patch.schema_version != HCD_PATCH_SCHEMA_VERSION_5
                {
                    return Err(HcdError::InvalidPatch(
                        "image.geometry requires schemaVersion hcd-patch/3".to_string(),
                    ));
                }
                validate_node_id(node_id)?;
                validate_sha256("visualHash", &precondition.visual_hash)?;
                crate::html::validate_image_geometry(geometry)?;
            }
            PatchOperation::AnnotationUpsert { annotation } => {
                validate_annotation(annotation)?;
            }
            PatchOperation::AnnotationRemove { annotation_id } => {
                validate_identifier("annotationId", annotation_id)?;
            }
        }
    }
    if inserted > MAX_PATCH_INSERT_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "patch inserts {inserted} bytes; maximum is {MAX_PATCH_INSERT_BYTES}"
        )));
    }
    Ok(())
}

fn validate_string_map(
    name: &str,
    values: &BTreeMap<String, String>,
    maximum_entries: usize,
    maximum_bytes: usize,
) -> Result<(), HcdError> {
    if values.len() > maximum_entries {
        return Err(HcdError::ResourceLimit(format!(
            "{name} contains {} entries; maximum is {maximum_entries}",
            values.len()
        )));
    }
    let mut bytes = 0usize;
    for (key, value) in values {
        if key.is_empty() || key.len() > MAX_IDENTIFIER_BYTES {
            return Err(HcdError::InvalidPatch(format!(
                "{name} key length must be between 1 and {MAX_IDENTIFIER_BYTES} bytes"
            )));
        }
        bytes = bytes
            .checked_add(key.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or_else(|| HcdError::ResourceLimit(format!("{name} byte count overflowed")))?;
    }
    if bytes > maximum_bytes {
        return Err(HcdError::ResourceLimit(format!(
            "{name} contains {bytes} bytes; maximum is {maximum_bytes}"
        )));
    }
    Ok(())
}

fn validate_annotation(annotation: &crate::Annotation) -> Result<(), HcdError> {
    validate_identifier("annotationId", &annotation.annotation_id)?;
    validate_node_id(&annotation.node_id)?;
    if annotation.kind.trim().is_empty() || annotation.kind.len() > MAX_ANNOTATION_KIND_BYTES {
        return Err(HcdError::InvalidPatch(format!(
            "annotation kind length must be between 1 and {MAX_ANNOTATION_KIND_BYTES} bytes"
        )));
    }
    if let Some(rule_id) = &annotation.rule_id {
        validate_identifier("ruleId", rule_id)?;
    }
    if annotation
        .confidence
        .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
    {
        return Err(HcdError::InvalidPatch(
            "annotation confidence must be finite and between 0 and 1".to_string(),
        ));
    }
    Ok(())
}

fn validate_identifier(name: &str, value: &str) -> Result<(), HcdError> {
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(HcdError::InvalidPatch(format!(
            "{name} length must be between 1 and {MAX_IDENTIFIER_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_node_id(value: &str) -> Result<(), HcdError> {
    if value.len() != 34
        || !value.starts_with("n_")
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(HcdError::InvalidPatch(format!(
            "nodeId {value:?} must match n_[0-9a-f]{{32}}"
        )));
    }
    Ok(())
}

fn validate_sha256(name: &str, value: &str) -> Result<(), HcdError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(HcdError::InvalidPatch(format!(
            "{name} must be a lowercase SHA-256 digest"
        )));
    }
    Ok(())
}

fn validate_node_style(style: &NodeStylePatch) -> Result<(), HcdError> {
    if style.text_color.is_none() && style.background_color.is_none() && style.border.is_none() {
        return Err(HcdError::InvalidPatch(
            "node.style must set textColor, backgroundColor, or border".to_string(),
        ));
    }
    if let Some(color) = &style.text_color {
        validate_hex_color("textColor", color)?;
    }
    if let Some(color) = &style.background_color {
        validate_hex_color("backgroundColor", color)?;
    }
    if let Some(border) = &style.border {
        validate_hex_color("border.color", &border.color)?;
        if !border.width_pt.is_finite() || !(0.0..=12.0).contains(&border.width_pt) {
            return Err(HcdError::InvalidPatch(
                "border.widthPt must be finite, greater than 0, and at most 12".to_string(),
            ));
        }
        if border.width_pt == 0.0 {
            return Err(HcdError::InvalidPatch(
                "border.widthPt must be greater than 0".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_hex_color(name: &str, color: &str) -> Result<(), HcdError> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(HcdError::InvalidPatch(format!(
            "{name} must be a #RRGGBB color"
        )));
    }
    Ok(())
}

fn collect_splices(patch: &PatchBatch) -> Result<BTreeMap<String, Vec<Splice>>, HcdError> {
    let mut grouped: BTreeMap<String, Vec<Splice>> = BTreeMap::new();
    for operation in &patch.operations {
        if let PatchOperation::TextSplice {
            node_id,
            start,
            delete_count,
            insert_text,
            precondition,
        } = operation
        {
            if insert_text.chars().any(is_forbidden_xml_character) {
                return Err(HcdError::InvalidPatch(format!(
                    "insertText for {node_id} contains an invalid XML character"
                )));
            }
            grouped.entry(node_id.clone()).or_default().push(Splice {
                start: *start,
                delete_count: *delete_count,
                insert_text: insert_text.clone(),
                node_hash: precondition.node_hash.clone(),
            });
        }
    }
    Ok(grouped)
}

fn collect_pdf_insertions(patch: &PatchBatch) -> HashMap<String, Vec<PdfTextInsertion>> {
    let mut grouped: HashMap<String, Vec<PdfTextInsertion>> = HashMap::new();
    for (index, operation) in patch.operations.iter().enumerate() {
        let PatchOperation::PdfTextInsert {
            page,
            x_pt,
            y_pt,
            width_pt,
            height_pt,
            font_size_pt,
            text,
        } = operation
        else {
            continue;
        };
        let part = format!("pdf/pages/{page}");
        let chunk_id =
            stable_node_id(&[&patch.document_id, &part, "page-chunk", "0"]).replacen("n_", "c_", 1);
        let node_id = stable_node_id(&[
            &patch.document_id,
            &patch.patch_id,
            &index.to_string(),
            "pdf-text-insert",
        ]);
        grouped.entry(chunk_id).or_default().push(PdfTextInsertion {
            page: *page,
            node_id,
            x_pt: *x_pt,
            y_pt: *y_pt,
            width_pt: *width_pt,
            height_pt: *height_pt,
            font_size_pt: *font_size_pt,
            text: text.clone(),
        });
    }
    grouped
}

fn collect_xlsx_merges(patch: &PatchBatch) -> HashMap<String, XlsxMerge> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxMerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxMerge {
                    sheet_id: sheet_id.clone(),
                    start_row: *start_row,
                    start_column: *start_column,
                    end_row: *end_row,
                    end_column: *end_column,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

fn collect_xlsx_unmerges(patch: &PatchBatch) -> HashMap<String, XlsxMerge> {
    patch
        .operations
        .iter()
        .filter_map(|operation| {
            let PatchOperation::XlsxUnmerge {
                node_id,
                sheet_id,
                start_row,
                start_column,
                end_row,
                end_column,
                precondition,
            } = operation
            else {
                return None;
            };
            Some((
                node_id.clone(),
                XlsxMerge {
                    sheet_id: sheet_id.clone(),
                    start_row: *start_row,
                    start_column: *start_column,
                    end_row: *end_row,
                    end_column: *end_column,
                    node_hash: precondition.node_hash.clone(),
                },
            ))
        })
        .collect()
}

fn collect_xlsx_cell_set(patch: &PatchBatch) -> Option<XlsxCellInsertion> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxCellSet {
            sheet_id,
            row,
            column,
            text,
        } = operation
        else {
            return None;
        };
        Some(XlsxCellInsertion {
            sheet_id: sheet_id.clone(),
            row: *row,
            column: *column,
            text: text.clone(),
        })
    })
}

fn collect_xlsx_row_append(patch: &PatchBatch) -> Option<XlsxRowAppend> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowAppend {
            sheet_id,
            after_row,
        } = operation
        else {
            return None;
        };
        Some(XlsxRowAppend {
            sheet_id: sheet_id.clone(),
            after_row: *after_row,
        })
    })
}

fn collect_xlsx_row_insert(patch: &PatchBatch) -> Option<XlsxRowInsert> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowInsert {
            sheet_id,
            before_row,
        } = operation
        else {
            return None;
        };
        Some(XlsxRowInsert {
            sheet_id: sheet_id.clone(),
            before_row: *before_row,
        })
    })
}

fn collect_xlsx_row_delete(patch: &PatchBatch) -> Option<XlsxRowDelete> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowDelete { sheet_id, row } = operation else {
            return None;
        };
        Some(XlsxRowDelete {
            sheet_id: sheet_id.clone(),
            row: *row,
        })
    })
}

fn collect_xlsx_column_insert(patch: &PatchBatch) -> Option<XlsxColumnInsert> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxColumnInsert {
            sheet_id,
            before_column,
        } = operation
        else {
            return None;
        };
        Some(XlsxColumnInsert {
            sheet_id: sheet_id.clone(),
            before_column: *before_column,
        })
    })
}

fn collect_xlsx_column_delete(patch: &PatchBatch) -> Option<XlsxColumnDelete> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxColumnDelete { sheet_id, column } = operation else {
            return None;
        };
        Some(XlsxColumnDelete {
            sheet_id: sheet_id.clone(),
            column: *column,
        })
    })
}

fn collect_xlsx_row_removal(patch: &PatchBatch) -> Option<XlsxRowRemoval> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxRowRemoveLast { sheet_id, row } = operation else {
            return None;
        };
        Some(XlsxRowRemoval {
            sheet_id: sheet_id.clone(),
            row: *row,
        })
    })
}

fn collect_xlsx_column_width(patch: &PatchBatch) -> Option<XlsxColumnWidth> {
    patch.operations.iter().find_map(|operation| {
        let PatchOperation::XlsxColumnWidth {
            sheet_id,
            column,
            width_chars,
        } = operation
        else {
            return None;
        };
        Some(XlsxColumnWidth {
            sheet_id: sheet_id.clone(),
            column: *column,
            width_chars: *width_chars,
        })
    })
}

fn find_xlsx_sheet_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    sheet_id: &str,
) -> Result<String, HcdError> {
    let mut found_sheet = false;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || grid.sheet_id != sheet_id {
                continue;
            }
            found_sheet = true;
            if let Some(part) = bundle
                .read_map(&descriptor)?
                .entries
                .iter()
                .find(|entry| entry.source.node_kind == "cell")
                .map(|entry| entry.source.part.clone())
            {
                return Ok(part);
            }
        }
    }
    Err(HcdError::Unsupported(if found_sheet {
        "XLSX column width requires a worksheet with a mapped cell".to_string()
    } else {
        "XLSX worksheet is not in the HCD grid".to_string()
    }))
}

fn hcd_column_tag(start: u32, end: u32, width: Option<f64>, hidden: bool, edited: bool) -> String {
    let mut tag = format!(
        "<col span=\"{}\" data-hcd-column-start=\"{start}\" data-hcd-column-end=\"{end}\"",
        end - start + 1
    );
    if let Some(width) = width {
        tag.push_str(&format!(" data-hcd-width=\"{width:.2}\""));
    }
    if edited {
        tag.push_str(" data-hcd-width-edited=\"true\"");
    }
    if hidden {
        tag.push_str(" data-hcd-hidden=\"true\" style=\"display:none\"");
    } else if let Some(width) = width {
        tag.push_str(&format!(" style=\"width:{:.2}px\"", width * 7.5));
    }
    tag.push_str("/>");
    tag
}

fn set_xlsx_column_width(html: &mut String, column: u32, width: f64) -> Result<(), HcdError> {
    let group_start = html.find("<colgroup>").ok_or_else(|| {
        HcdError::InvalidBundle("XLSX grid is missing its column group".to_string())
    })?;
    let group_end = html[group_start..]
        .find("</colgroup>")
        .map(|offset| group_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column group is not closed".to_string()))?;
    let mut cursor = group_start + "<colgroup>".len();
    let mut insert_at = group_end;
    while let Some(offset) = html[cursor..group_end].find("<col ") {
        let tag_start = cursor + offset;
        let tag_end = html[tag_start..group_end]
            .find("/>")
            .map(|offset| tag_start + offset + 2)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column tag is not closed".to_string()))?;
        let tag = &html[tag_start..tag_end];
        let start = xlsx_attribute(tag, "data-hcd-column-start")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column start is invalid".to_string()))?;
        let end = xlsx_attribute(tag, "data-hcd-column-end")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX column end is invalid".to_string()))?;
        if start == 0 || end < start || end > 16_384 {
            return Err(HcdError::InvalidBundle(
                "XLSX column range is invalid".to_string(),
            ));
        }
        if column < start {
            insert_at = tag_start;
            break;
        }
        if column <= end {
            let old_width =
                xlsx_attribute(tag, "data-hcd-width").and_then(|value| value.parse().ok());
            let hidden = xlsx_attribute(tag, "data-hcd-hidden") == Some("true");
            let mut replacement = String::new();
            if start < column {
                replacement.push_str(&hcd_column_tag(start, column - 1, old_width, hidden, false));
            }
            replacement.push_str(&hcd_column_tag(column, column, Some(width), hidden, true));
            if column < end {
                replacement.push_str(&hcd_column_tag(column + 1, end, old_width, hidden, false));
            }
            html.replace_range(tag_start..tag_end, &replacement);
            return Ok(());
        }
        cursor = tag_end;
    }
    html.insert_str(
        insert_at,
        &hcd_column_tag(column, column, Some(width), false, true),
    );
    Ok(())
}

fn find_xlsx_row_tail(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    append: &XlsxRowAppend,
) -> Result<String, HcdError> {
    let (last_row, tail) = last_xlsx_row(bundle, manifest, &append.sheet_id)?;
    if last_row != u64::from(append.after_row) {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX current last row is {last_row}, expected {}",
            append.after_row
        )));
    }
    Ok(tail)
}

fn find_xlsx_row_insert_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    insert: &XlsxRowInsert,
) -> Result<(String, String), HcdError> {
    let (last_row, _) = last_xlsx_row(bundle, manifest, &insert.sheet_id)?;
    if last_row >= 1_048_576 {
        return Err(HcdError::ResourceLimit(
            "XLSX row insertion exceeds the last worksheet row".to_string(),
        ));
    }
    if u64::from(insert.before_row) > last_row {
        return Err(HcdError::Unsupported(
            "use xlsx.row.append after the last row".to_string(),
        ));
    }
    let mut target = None;
    let mut part = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind == crate::GridChunkKind::Picture
                || grid.kind == crate::GridChunkKind::Chart
            {
                return Err(HcdError::Unsupported(
                    "middle row insertion cannot yet shift workbook drawings or charts".to_string(),
                ));
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if html.contains("data-hcd-formula=\"true\"") || html.contains("data-hcd-merge=\"") {
                return Err(HcdError::Unsupported(
                    "middle row insertion requires a workbook without formulas or merged cells"
                        .to_string(),
                ));
            }
            if grid.sheet_id != insert.sheet_id {
                continue;
            }
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
            if grid
                .row_start
                .is_some_and(|start| start <= u64::from(insert.before_row))
                && grid
                    .row_end
                    .is_some_and(|end| end >= u64::from(insert.before_row))
                && html.contains(&format!("<tr data-hcd-row=\"{}\"", insert.before_row))
                && target.replace(descriptor.chunk_id).is_some()
            {
                return Err(HcdError::InvalidBundle(
                    "duplicate XLSX row insertion target".to_string(),
                ));
            }
        }
    }
    let target = target.ok_or_else(|| {
        HcdError::Unsupported("insert before a materialized XLSX row".to_string())
    })?;
    let part = part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })?;
    Ok((target, part))
}

fn find_xlsx_row_delete_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    delete: &XlsxRowDelete,
) -> Result<(String, String), HcdError> {
    let mut target = None;
    let mut part = None;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if matches!(
                grid.kind,
                crate::GridChunkKind::Picture | crate::GridChunkKind::Chart
            ) {
                return Err(HcdError::Unsupported(
                    "row deletion cannot update drawings or charts".to_string(),
                ));
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if html.contains("data-hcd-formula=\"true\"") || html.contains("data-hcd-merge=\"") {
                return Err(HcdError::Unsupported(
                    "row deletion requires a workbook without formulas or merged cells".to_string(),
                ));
            }
            if grid.sheet_id != delete.sheet_id {
                continue;
            }
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
            if html.contains(&format!("<tr data-hcd-row=\"{}\"", delete.row))
                && target.replace(descriptor.chunk_id).is_some()
            {
                return Err(HcdError::InvalidBundle(
                    "duplicate XLSX row deletion target".to_string(),
                ));
            }
        }
    }
    Ok((
        part.ok_or_else(|| {
            HcdError::Unsupported("XLSX sheet has no mapped source cells".to_string())
        })?,
        target.ok_or_else(|| HcdError::Unsupported("delete an existing XLSX row".to_string()))?,
    ))
}

fn find_xlsx_column_insert_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    insert: &XlsxColumnInsert,
) -> Result<String, HcdError> {
    let mut part = None;
    let mut last_column = 0u32;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if matches!(
                grid.kind,
                crate::GridChunkKind::Picture | crate::GridChunkKind::Chart
            ) {
                return Err(HcdError::Unsupported(
                    "middle column insertion cannot yet shift workbook drawings or charts"
                        .to_string(),
                ));
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if html.contains("data-hcd-formula=\"true\"") || html.contains("data-hcd-merge=\"") {
                return Err(HcdError::Unsupported(
                    "middle column insertion requires a workbook without formulas or merged cells"
                        .to_string(),
                ));
            }
            if grid.sheet_id != insert.sheet_id {
                continue;
            }
            if html.contains("data-hcd-column-start=\"") {
                return Err(HcdError::Unsupported(
                    "middle column insertion cannot yet shift explicit column widths".to_string(),
                ));
            }
            last_column = last_column.max(grid.column_end.unwrap_or(0));
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
        }
    }
    if last_column >= 16_384 {
        return Err(HcdError::ResourceLimit(
            "XLSX column insertion exceeds the last worksheet column".to_string(),
        ));
    }
    if insert.before_column > last_column {
        return Err(HcdError::Unsupported(
            "insert before an existing XLSX column".to_string(),
        ));
    }
    part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })
}

fn find_xlsx_column_delete_part(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    delete: &XlsxColumnDelete,
) -> Result<String, HcdError> {
    let mut part = None;
    let mut last_column = 0u32;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if matches!(
                grid.kind,
                crate::GridChunkKind::Picture | crate::GridChunkKind::Chart
            ) {
                return Err(HcdError::Unsupported(
                    "column deletion cannot update drawings or charts".to_string(),
                ));
            }
            if grid.kind != crate::GridChunkKind::Cells {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if html.contains("data-hcd-formula=\"true\"") || html.contains("data-hcd-merge=\"") {
                return Err(HcdError::Unsupported(
                    "column deletion requires a workbook without formulas or merged cells"
                        .to_string(),
                ));
            }
            if grid.sheet_id != delete.sheet_id {
                continue;
            }
            if html.contains("data-hcd-column-start=\"") {
                return Err(HcdError::Unsupported(
                    "column deletion cannot yet shift explicit column widths".to_string(),
                ));
            }
            last_column = last_column.max(grid.column_end.unwrap_or(0));
            if part.is_none() {
                part = bundle
                    .read_map(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| entry.source.node_kind == "cell")
                    .map(|entry| entry.source.part);
            }
        }
    }
    if delete.column > last_column {
        return Err(HcdError::Unsupported(
            "delete an existing XLSX column".to_string(),
        ));
    }
    if part.is_none() {
        let (original, _) = crate::manifest_at_revision(bundle, manifest, Some(0))?;
        for page_number in 0..original.index_page_count {
            for descriptor in bundle.read_index_page(&original, page_number)?.chunks {
                if descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == delete.sheet_id
                }) {
                    part = bundle
                        .read_map(&descriptor)?
                        .entries
                        .into_iter()
                        .find(|entry| entry.source.node_kind == "cell")
                        .map(|entry| entry.source.part);
                    if part.is_some() {
                        break;
                    }
                }
            }
        }
    }
    part.ok_or_else(|| {
        HcdError::Unsupported("XLSX worksheet has no mapped source cells".to_string())
    })
}

fn find_xlsx_row_removal_target(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    removal: &XlsxRowRemoval,
) -> Result<String, HcdError> {
    let (last_row, tail) = last_xlsx_row(bundle, manifest, &removal.sheet_id)?;
    if last_row != u64::from(removal.row) {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX current last row is {last_row}, expected {}",
            removal.row
        )));
    }
    let (original, _) = crate::manifest_at_revision(bundle, manifest, Some(0))?;
    let (original_last_row, _) = last_xlsx_row(bundle, &original, &removal.sheet_id)?;
    if last_row <= original_last_row {
        return Err(HcdError::PreconditionFailed(
            "XLSX source rows cannot be removed with this operation".to_string(),
        ));
    }
    Ok(tail)
}

fn last_xlsx_row(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    sheet_id: &str,
) -> Result<(u64, String), HcdError> {
    let mut tail = None;
    let mut last_row = 0u64;
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != crate::GridChunkKind::Cells || grid.sheet_id != sheet_id {
                continue;
            }
            let Some(end) = grid.row_end else { continue };
            if end > last_row {
                last_row = end;
                tail = Some(descriptor.chunk_id);
            } else if end == last_row {
                return Err(HcdError::InvalidBundle(
                    "XLSX last row appears in multiple cell windows".to_string(),
                ));
            }
        }
    }
    tail.map(|tail| (last_row, tail)).ok_or_else(|| {
        HcdError::Unsupported(
            "XLSX row operation requires an existing nonempty worksheet".to_string(),
        )
    })
}

fn append_xlsx_row(html: &mut String, after_row: u32) -> Result<(), HcdError> {
    let old_end = format!(" data-hcd-row-end=\"{after_row}\"");
    let section_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet section is not closed".to_string()))?;
    let marker = html[..section_end].find(&old_end).ok_or_else(|| {
        HcdError::InvalidBundle("XLSX sheet row end disagrees with its descriptor".to_string())
    })?;
    let body_end = html
        .find("</tbody>")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no table body".to_string()))?;
    let last_row_start = html[..body_end]
        .rfind("<tr ")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no last row".to_string()))?;
    let last_tag_end = html[last_row_start..body_end]
        .find('>')
        .map(|offset| last_row_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle("XLSX last row tag is unclosed".to_string()))?;
    if !html[last_row_start..last_tag_end].contains(&format!(" data-hcd-row=\"{after_row}\""))
        || !html[last_tag_end..body_end].ends_with("</tr>")
    {
        return Err(HcdError::InvalidBundle(
            "XLSX last row does not match the append precondition".to_string(),
        ));
    }
    html.insert_str(
        body_end,
        &format!("<tr data-hcd-row=\"{}\"></tr>", after_row + 1),
    );
    html.replace_range(
        marker..marker + old_end.len(),
        &format!(" data-hcd-row-end=\"{}\"", after_row + 1),
    );
    Ok(())
}

fn shift_xlsx_row_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    before_row: u32,
    insert_here: bool,
) -> Result<(), HcdError> {
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX row window has no grid address".to_string())
    })?;
    let old_start = grid
        .row_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no start".to_string()))?;
    let old_end = grid
        .row_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no end".to_string()))?;
    let mut rows = BTreeSet::new();
    let cells = xlsx_cells(html)?;
    let mut cursor = 0usize;
    while let Some(offset) = html[cursor..].find("<tr data-hcd-row=\"") {
        let start = cursor + offset + "<tr data-hcd-row=\"".len();
        let end = html[start..]
            .find('"')
            .map(|offset| start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row label is unclosed".to_string()))?;
        let row: u32 = html[start..end]
            .parse()
            .map_err(|_| HcdError::InvalidBundle("XLSX row label is invalid".to_string()))?;
        if row >= before_row {
            rows.insert(row);
        }
        cursor = end + 1;
    }
    if insert_here && !rows.contains(&before_row) {
        return Err(HcdError::PreconditionFailed(
            "XLSX insertion row disappeared".to_string(),
        ));
    }
    for row in rows.into_iter().rev() {
        let next = row
            .checked_add(1)
            .filter(|next| *next <= 1_048_576)
            .ok_or_else(|| {
                HcdError::ResourceLimit("XLSX row exceeds the worksheet limit".to_string())
            })?;
        for cell in cells.iter().filter(|cell| cell.row == row) {
            let old = format!("{}{}", xlsx_column_name(cell.column), row);
            let new = format!("{}{}", xlsx_column_name(cell.column), next);
            *html = html.replace(
                &format!(" data-hcd-cell=\"{old}\""),
                &format!(" data-hcd-cell=\"{new}\""),
            );
        }
        *html = html.replace(
            &format!("<tr data-hcd-row=\"{row}\""),
            &format!("<tr data-hcd-row=\"{next}\""),
        );
    }
    for entry in &mut source_map.entries {
        if entry.source.node_kind != "cell" {
            continue;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            continue;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return Err(HcdError::InvalidBundle(
                "XLSX mapped cell has invalid address".to_string(),
            ));
        };
        if row < before_row {
            continue;
        }
        if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
            entry.source.source_cell_ref = Some(reference);
        }
        entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column), row + 1));
    }
    let new_start = if old_start >= u64::from(before_row) && !insert_here {
        old_start + 1
    } else {
        old_start
    };
    let new_end = old_end + 1;
    for (name, old, new) in [
        ("data-hcd-row-start", old_start, new_start),
        ("data-hcd-row-end", old_end, new_end),
    ] {
        let before = format!(" {name}=\"{old}\"");
        if !html.contains(&before) {
            return Err(HcdError::InvalidBundle(format!(
                "XLSX window is missing {name}"
            )));
        }
        *html = html.replacen(&before, &format!(" {name}=\"{new}\""), 1);
    }
    if insert_here {
        let marker = format!("<tr data-hcd-row=\"{}\"", before_row + 1);
        let position = html.find(&marker).ok_or_else(|| {
            HcdError::InvalidBundle("shifted XLSX insertion row is missing".to_string())
        })?;
        html.insert_str(
            position,
            &format!("<tr data-hcd-row=\"{before_row}\"></tr>"),
        );
        descriptor.block_count += 1;
    }
    grid.row_start = Some(new_start);
    grid.row_end = Some(new_end);
    Ok(())
}

fn delete_xlsx_row_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    deleted_row: u32,
) -> Result<Vec<String>, HcdError> {
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX row window has no grid address".to_string())
    })?;
    let old_start = grid
        .row_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no start".to_string()))?;
    let old_end = grid
        .row_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row window has no end".to_string()))?;
    let mut rebuilt = String::with_capacity(html.len());
    let mut cursor = 0;
    let mut removed_row = false;
    while let Some(offset) = html[cursor..].find("<tr data-hcd-row=\"") {
        let start = cursor + offset;
        rebuilt.push_str(&html[cursor..start]);
        let label_start = start + "<tr data-hcd-row=\"".len();
        let label_end = html[label_start..]
            .find('"')
            .map(|offset| label_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row label is unclosed".to_string()))?;
        let row: u32 = html[label_start..label_end]
            .parse()
            .map_err(|_| HcdError::InvalidBundle("XLSX row label is invalid".to_string()))?;
        let end = html[label_end..]
            .find("</tr>")
            .map(|offset| label_end + offset + 5)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row is unclosed".to_string()))?;
        if row == deleted_row {
            removed_row = true;
        } else if row > deleted_row {
            let mut fragment = html[start..end].replacen(
                &format!("data-hcd-row=\"{row}\""),
                &format!("data-hcd-row=\"{}\"", row - 1),
                1,
            );
            for cell in xlsx_cells(&fragment)? {
                let old = format!("{}{}", xlsx_column_name(cell.column), row);
                let new = format!("{}{}", xlsx_column_name(cell.column), row - 1);
                fragment = fragment.replace(
                    &format!("data-hcd-cell=\"{old}\""),
                    &format!("data-hcd-cell=\"{new}\""),
                );
            }
            rebuilt.push_str(&fragment);
        } else {
            rebuilt.push_str(&html[start..end]);
        }
        cursor = end;
    }
    rebuilt.push_str(&html[cursor..]);
    if old_start <= u64::from(deleted_row) && !removed_row {
        return Err(HcdError::InvalidBundle(
            "XLSX deletion row is missing".to_string(),
        ));
    }
    let mut removed = Vec::new();
    source_map.entries.retain_mut(|entry| {
        if entry.source.node_kind != "cell" {
            return true;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            return true;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return true;
        };
        if row == deleted_row {
            removed.push(entry.node_id.clone());
            return false;
        }
        if row > deleted_row {
            if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
                entry.source.source_cell_ref = Some(reference);
            }
            entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column), row - 1));
        }
        true
    });
    let (new_start, new_end) = if old_start == old_end && old_start == u64::from(deleted_row) {
        (None, None)
    } else {
        (
            Some(if old_start > u64::from(deleted_row) {
                old_start - 1
            } else {
                old_start
            }),
            Some(old_end - 1),
        )
    };
    for (name, old, new) in [
        ("data-hcd-row-start", old_start, new_start),
        ("data-hcd-row-end", old_end, new_end),
    ] {
        let before = format!(" {name}=\"{old}\"");
        if !rebuilt.contains(&before) {
            return Err(HcdError::InvalidBundle(format!(
                "XLSX window is missing {name}"
            )));
        }
        rebuilt = rebuilt.replacen(
            &before,
            &new.map_or_else(String::new, |value| format!(" {name}=\"{value}\"")),
            1,
        );
    }
    *html = rebuilt;
    grid.row_start = new_start;
    grid.row_end = new_end;
    descriptor.block_count = descriptor
        .block_count
        .saturating_sub(usize::from(removed_row))
        .max(1);
    descriptor.node_count = source_map.entries.len();
    descriptor.first_node_id = source_map
        .entries
        .first()
        .map(|entry| entry.node_id.clone());
    descriptor.last_node_id = source_map.entries.last().map(|entry| entry.node_id.clone());
    descriptor.node_bloom = node_bloom(
        source_map
            .entries
            .iter()
            .map(|entry| entry.node_id.as_str()),
    );
    Ok(removed)
}

fn shift_xlsx_column_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    before_column: u32,
) -> Result<(), HcdError> {
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX column window has no grid address".to_string())
    })?;
    let old_start = grid
        .column_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no start".to_string()))?;
    let old_end = grid
        .column_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no end".to_string()))?;
    let cells = xlsx_cells(html)?;
    let mut first_shifted_column = BTreeMap::new();
    for cell in cells.iter().filter(|cell| cell.column >= before_column) {
        first_shifted_column
            .entry(cell.row)
            .and_modify(|column: &mut u32| *column = (*column).min(cell.column))
            .or_insert(cell.column);
    }
    let mut rewritten = String::with_capacity(html.len() + first_shifted_column.len() * 80);
    let mut cursor = 0usize;
    for cell in cells.iter().filter(|cell| cell.column >= before_column) {
        if cell.start < cursor {
            return Err(HcdError::InvalidBundle(
                "XLSX cell spans overlap".to_string(),
            ));
        }
        rewritten.push_str(&html[cursor..cell.start]);
        let original = &html[cell.start..cell.end];
        let old_column = format!(" data-hcd-column=\"{}\"", cell.column);
        let new_column = format!(" data-hcd-column=\"{}\"", cell.column + 1);
        if !original.contains(&old_column) {
            return Err(HcdError::InvalidBundle(
                "XLSX cell column differs from its address".to_string(),
            ));
        }
        let mut updated = original.replacen(&old_column, &new_column, 1);
        let old_ref = format!(
            " data-hcd-cell=\"{}{}\"",
            xlsx_column_name(cell.column),
            cell.row
        );
        let new_ref = format!(
            " data-hcd-cell=\"{}{}\"",
            xlsx_column_name(cell.column + 1),
            cell.row
        );
        updated = updated.replacen(&old_ref, &new_ref, 1);
        if first_shifted_column.get(&cell.row) == Some(&cell.column) {
            rewritten.push_str(&format!(
                "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{before_column}\"></td>"
            ));
        }
        rewritten.push_str(&updated);
        cursor = cell.end;
    }
    rewritten.push_str(&html[cursor..]);
    *html = rewritten;
    for entry in &mut source_map.entries {
        if entry.source.node_kind != "cell" {
            continue;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            continue;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return Err(HcdError::InvalidBundle(
                "XLSX mapped cell has invalid address".to_string(),
            ));
        };
        if column < before_column {
            continue;
        }
        if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
            entry.source.source_cell_ref = Some(reference);
        }
        entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column + 1), row));
    }
    grid.column_start = Some(if old_start >= before_column {
        old_start + 1
    } else {
        old_start
    });
    grid.column_end = Some(old_end + 1);
    Ok(())
}

fn delete_xlsx_column_window(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    descriptor: &mut crate::ChunkDescriptor,
    deleted_column: u32,
) -> Result<Vec<String>, HcdError> {
    let grid = descriptor.grid.as_mut().ok_or_else(|| {
        HcdError::InvalidBundle("XLSX column window has no grid address".to_string())
    })?;
    let old_start = grid
        .column_start
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no start".to_string()))?;
    let old_end = grid
        .column_end
        .ok_or_else(|| HcdError::InvalidBundle("XLSX column window has no end".to_string()))?;
    if old_start > old_end || old_end < deleted_column {
        return Err(HcdError::InvalidBundle(
            "XLSX column window range is invalid".to_string(),
        ));
    }
    let mut rewritten = String::with_capacity(html.len());
    let mut cursor = 0usize;
    for cell in xlsx_cells(html)? {
        if cell.start < cursor {
            return Err(HcdError::InvalidBundle(
                "XLSX cell spans overlap".to_string(),
            ));
        }
        rewritten.push_str(&html[cursor..cell.start]);
        if cell.column < deleted_column {
            rewritten.push_str(&html[cell.start..cell.end]);
        } else if cell.column > deleted_column {
            let original = &html[cell.start..cell.end];
            let old_column = format!(" data-hcd-column=\"{}\"", cell.column);
            if !original.contains(&old_column) {
                return Err(HcdError::InvalidBundle(
                    "XLSX cell column differs from its address".to_string(),
                ));
            }
            let mut updated = original.replacen(
                &old_column,
                &format!(" data-hcd-column=\"{}\"", cell.column - 1),
                1,
            );
            let old_ref = format!(
                " data-hcd-cell=\"{}{}\"",
                xlsx_column_name(cell.column),
                cell.row
            );
            if original.contains(&old_ref) {
                updated = updated.replacen(
                    &old_ref,
                    &format!(
                        " data-hcd-cell=\"{}{}\"",
                        xlsx_column_name(cell.column - 1),
                        cell.row
                    ),
                    1,
                );
            }
            rewritten.push_str(&updated);
        }
        cursor = cell.end;
    }
    rewritten.push_str(&html[cursor..]);
    *html = rewritten;
    let mut removed = Vec::new();
    source_map.entries.retain_mut(|entry| {
        if entry.source.node_kind != "cell" {
            return true;
        }
        let Some(reference) = entry.source.paragraph_id.clone() else {
            return true;
        };
        let Some((row, column)) = xlsx_cell_coordinates(&reference) else {
            return true;
        };
        if column == deleted_column {
            removed.push(entry.node_id.clone());
            return false;
        }
        if column > deleted_column {
            if !entry.source.created_in_hcd && entry.source.source_cell_ref.is_none() {
                entry.source.source_cell_ref = Some(reference);
            }
            entry.source.paragraph_id = Some(format!("{}{}", xlsx_column_name(column - 1), row));
        }
        true
    });
    let remaining = xlsx_cells(html)?;
    grid.column_start = remaining.iter().map(|cell| cell.column).min();
    grid.column_end = remaining.iter().map(|cell| cell.column).max();
    descriptor.node_count = source_map.entries.len();
    descriptor.first_node_id = source_map
        .entries
        .first()
        .map(|entry| entry.node_id.clone());
    descriptor.last_node_id = source_map.entries.last().map(|entry| entry.node_id.clone());
    descriptor.node_bloom = node_bloom(
        source_map
            .entries
            .iter()
            .map(|entry| entry.node_id.as_str()),
    );
    Ok(removed)
}

fn remove_empty_xlsx_tail_row(html: &mut String, row: u32) -> Result<(), HcdError> {
    let old_end = format!(" data-hcd-row-end=\"{row}\"");
    let section_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet section is not closed".to_string()))?;
    let marker = html[..section_end].find(&old_end).ok_or_else(|| {
        HcdError::InvalidBundle("XLSX sheet row end disagrees with its descriptor".to_string())
    })?;
    let body_end = html
        .find("</tbody>")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no table body".to_string()))?;
    let last_row_start = html[..body_end]
        .rfind("<tr ")
        .ok_or_else(|| HcdError::InvalidBundle("XLSX sheet has no last row".to_string()))?;
    if html[last_row_start..body_end] != format!("<tr data-hcd-row=\"{row}\"></tr>") {
        return Err(HcdError::PreconditionFailed(
            "XLSX last row contains cells or formatting; only an empty appended row can be removed"
                .to_string(),
        ));
    }
    html.replace_range(last_row_start..body_end, "");
    html.replace_range(
        marker..marker + old_end.len(),
        &format!(" data-hcd-row-end=\"{}\"", row - 1),
    );
    Ok(())
}

#[derive(Clone)]
struct XlsxCellSpan {
    start: usize,
    end: usize,
    tag_end: usize,
    row: u32,
    column: u32,
    has_node: bool,
    merged_range: Option<(u32, u32, u32, u32)>,
}

fn xlsx_column_name(mut column: u32) -> String {
    let mut output = Vec::new();
    while column > 0 {
        column -= 1;
        output.push(b'A' + (column % 26) as u8);
        column /= 26;
    }
    output.reverse();
    String::from_utf8(output).expect("ASCII column name")
}

fn xlsx_cell_coordinates(reference: &str) -> Option<(u32, u32)> {
    let mut row = 0u32;
    let mut column = 0u32;
    let mut saw_row = false;
    for byte in reference.bytes() {
        if byte.is_ascii_uppercase() && !saw_row {
            column = column
                .checked_mul(26)?
                .checked_add(u32::from(byte - b'A' + 1))?;
        } else if byte.is_ascii_digit() && column > 0 {
            saw_row = true;
            row = row.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
        } else {
            return None;
        }
    }
    (saw_row && (1..=1_048_576).contains(&row) && (1..=16_384).contains(&column))
        .then_some((row, column))
}

fn xlsx_merge_coordinates(reference: &str) -> Option<(u32, u32, u32, u32)> {
    let (first, last) = reference.split_once(':')?;
    let (start_row, start_column) = xlsx_cell_coordinates(first)?;
    let (end_row, end_column) = xlsx_cell_coordinates(last)?;
    (start_row <= end_row && start_column <= end_column).then_some((
        start_row,
        start_column,
        end_row,
        end_column,
    ))
}

fn xlsx_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!(" {name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn xlsx_cells(html: &str) -> Result<Vec<XlsxCellSpan>, HcdError> {
    let mut result = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = html[cursor..].find("<tr ") {
        let row_start = cursor + relative;
        let tag_end = html[row_start..]
            .find('>')
            .map(|offset| row_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row tag is not closed".to_string()))?;
        let row = xlsx_attribute(&html[row_start..=tag_end], "data-hcd-row")
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row has no row number".to_string()))?;
        let row_end = html[tag_end + 1..]
            .find("</tr>")
            .map(|offset| tag_end + 1 + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX row is not closed".to_string()))?;
        let mut cell_cursor = tag_end + 1;
        while let Some(relative) = html[cell_cursor..row_end].find("<td ") {
            let start = cell_cursor + relative;
            let tag_end = html[start..row_end]
                .find('>')
                .map(|offset| start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX cell tag is not closed".to_string())
                })?;
            let end = html[tag_end + 1..row_end]
                .find("</td>")
                .map(|offset| tag_end + 1 + offset + "</td>".len())
                .ok_or_else(|| HcdError::InvalidBundle("XLSX cell is not closed".to_string()))?;
            let tag = &html[start..=tag_end];
            let column = xlsx_attribute(tag, "data-hcd-column")
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| HcdError::InvalidBundle("XLSX cell has no column".to_string()))?;
            let merged_range = xlsx_attribute(tag, "data-hcd-merge")
                .map(|value| {
                    xlsx_merge_coordinates(value).ok_or_else(|| {
                        HcdError::InvalidBundle(format!("invalid XLSX merge range {value}"))
                    })
                })
                .transpose()?;
            result.push(XlsxCellSpan {
                start,
                end,
                tag_end,
                row,
                column,
                has_node: html[start..end].contains("data-hcd-id=\""),
                merged_range,
            });
            cell_cursor = end;
        }
        cursor = row_end + "</tr>".len();
    }
    Ok(result)
}

fn insert_xlsx_cell(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    document_id: &str,
    insertion: &XlsxCellInsertion,
    grid_generation: Option<u64>,
) -> Result<(String, String), HcdError> {
    let cells = xlsx_cells(html)?;
    let cell = cells
        .iter()
        .find(|cell| cell.row == insertion.row && cell.column == insertion.column);
    if cells
        .iter()
        .filter_map(|cell| cell.merged_range)
        .any(|range| {
            range.0 <= insertion.row
                && range.2 >= insertion.row
                && range.1 <= insertion.column
                && range.3 >= insertion.column
        })
    {
        return Err(HcdError::PreconditionFailed(
            "XLSX cell is inside a merged range".to_string(),
        ));
    }
    if let Some(cell) = cell {
        if cell.has_node || !html[cell.tag_end + 1..cell.end - 5].trim().is_empty() {
            return Err(HcdError::PreconditionFailed(
                "XLSX cell is no longer empty".to_string(),
            ));
        }
    }
    let reference = format!("{}{}", xlsx_column_name(insertion.column), insertion.row);
    if source_map
        .entries
        .iter()
        .any(|entry| entry.source.paragraph_id.as_deref() == Some(reference.as_str()))
    {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX cell {reference} is already mapped"
        )));
    }
    let part = source_map
        .entries
        .first()
        .map(|entry| entry.source.part.clone())
        .ok_or_else(|| {
            HcdError::Unsupported(
                "XLSX blank cell creation requires a window with mapped cells".to_string(),
            )
        })?;
    let node_id = if let Some(generation) = grid_generation {
        stable_node_id(&[
            document_id,
            &part,
            "cell-created",
            &reference,
            &generation.to_string(),
        ])
    } else {
        stable_node_id(&[document_id, &part, "cell", &reference])
    };
    if source_map
        .entries
        .iter()
        .any(|entry| entry.node_id == node_id)
    {
        return Err(HcdError::PreconditionFailed(format!(
            "XLSX node {node_id} already exists"
        )));
    }
    let node_hash = hash_bytes(insertion.text.as_bytes());
    let replacement = format!(
        "<td class=\"hcd-cell\" data-hcd-cell=\"{reference}\" data-hcd-column=\"{}\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span></td>",
        insertion.column,
        escape_text(&insertion.text)
    );
    if let Some(cell) = cell {
        html.replace_range(cell.start..cell.end, &replacement);
    } else {
        let row_marker = format!("data-hcd-row=\"{}\"", insertion.row);
        let row_tag = html.find(&row_marker).ok_or_else(|| {
            HcdError::Unsupported("XLSX cell requires an existing HCD row".to_string())
        })?;
        let row_start = html[..row_tag].rfind("<tr ").ok_or_else(|| {
            HcdError::InvalidBundle("XLSX row opening tag is missing".to_string())
        })?;
        let row_end = html[row_tag..]
            .find("</tr>")
            .map(|offset| row_tag + offset)
            .ok_or_else(|| {
                HcdError::InvalidBundle("XLSX row closing tag is missing".to_string())
            })?;
        let last_column = cells
            .iter()
            .filter(|cell| cell.row == insertion.row)
            .map(|cell| {
                let tag = &html[cell.start..=cell.tag_end];
                let span = xlsx_attribute(tag, "colspan")
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(1);
                cell.column.saturating_add(span.saturating_sub(1))
            })
            .max()
            .unwrap_or(0);
        if insertion.column <= last_column || insertion.column - last_column > 256 {
            return Err(HcdError::Unsupported(
                "XLSX first edit outside the bounded row tail".to_string(),
            ));
        }
        if row_start > row_tag
            || cells
                .iter()
                .any(|cell| cell.row == insertion.row && cell.end > row_end)
        {
            return Err(HcdError::InvalidBundle(
                "XLSX row has invalid cell bounds".to_string(),
            ));
        }
        let mut appended = String::new();
        for column in last_column + 1..insertion.column {
            appended.push_str(&format!(
                "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{column}\"></td>"
            ));
        }
        appended.push_str(&replacement);
        html.insert_str(row_end, &appended);
    }
    let ordinal = source_map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("XLSX source ordinal overflow".to_string()))?;
    let position = source_map.entries.iter().position(|entry| {
        entry
            .source
            .paragraph_id
            .as_deref()
            .and_then(xlsx_cell_coordinates)
            .is_some_and(|(row, column)| (row, column) > (insertion.row, insertion.column))
    });
    source_map.entries.insert(
        position.unwrap_or(source_map.entries.len()),
        NodeMapEntry {
            node_id: node_id.clone(),
            node_hash,
            source: SourceAnchor {
                source_cell_ref: None,
                created_in_hcd: true,
                part: part.clone(),
                text_ordinal: ordinal,
                paragraph_id: Some(reference),
                text_id: None,
                node_kind: "cell".to_string(),
                editable: true,
            },
        },
    );
    Ok((node_id, part))
}

fn merge_xlsx_cells(html: &mut String, merge: &XlsxMerge) -> Result<(), HcdError> {
    let cells = xlsx_cells(html)?;
    let intersects = |range: (u32, u32, u32, u32)| {
        range.0 <= merge.end_row
            && range.2 >= merge.start_row
            && range.1 <= merge.end_column
            && range.3 >= merge.start_column
    };
    if cells
        .iter()
        .filter_map(|cell| cell.merged_range)
        .any(intersects)
    {
        return Err(HcdError::PreconditionFailed(
            "XLSX merge overlaps an existing merged range".to_string(),
        ));
    }
    let mut replacements = Vec::new();
    for row in merge.start_row..=merge.end_row {
        for column in merge.start_column..=merge.end_column {
            let cell = cells
                .iter()
                .find(|cell| cell.row == row && cell.column == column)
                .ok_or_else(|| {
                    HcdError::Unsupported(format!(
                        "XLSX merge requires the existing cell {}{row} in one HCD window",
                        xlsx_column_name(column)
                    ))
                })?;
            if row == merge.start_row && column == merge.start_column {
                if !cell.has_node {
                    return Err(HcdError::Unsupported(
                        "XLSX merge anchor must be an existing mapped cell".to_string(),
                    ));
                }
                let reference = format!(
                    "{}{}:{}{}",
                    xlsx_column_name(merge.start_column),
                    merge.start_row,
                    xlsx_column_name(merge.end_column),
                    merge.end_row
                );
                let mut replacement = html[cell.start..cell.end].to_string();
                replacement.insert_str(
                    cell.tag_end - cell.start,
                    &format!(
                        " data-hcd-merge=\"{reference}\" rowspan=\"{}\" colspan=\"{}\"",
                        merge.end_row - merge.start_row + 1,
                        merge.end_column - merge.start_column + 1
                    ),
                );
                replacements.push((cell.start, cell.end, replacement));
            } else {
                if cell.has_node || !html[cell.tag_end + 1..cell.end - 5].trim().is_empty() {
                    return Err(HcdError::Unsupported(format!(
                        "XLSX merge would discard the mapped or nonempty cell {}{row}",
                        xlsx_column_name(column)
                    )));
                }
                replacements.push((cell.start, cell.end, String::new()));
            }
        }
    }
    replacements.sort_unstable_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    for (start, end, replacement) in replacements {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}

fn unmerge_xlsx_cells(
    html: &mut String,
    initial_html: &str,
    merge: &XlsxMerge,
) -> Result<(), HcdError> {
    let cells = xlsx_cells(html)?;
    let original_cells = xlsx_cells(initial_html)?;
    let anchor = cells
        .iter()
        .find(|cell| {
            cell.row == merge.start_row && cell.column == merge.start_column && cell.has_node
        })
        .ok_or_else(|| HcdError::PreconditionFailed("XLSX merge anchor is missing".to_string()))?;
    let range = (
        merge.start_row,
        merge.start_column,
        merge.end_row,
        merge.end_column,
    );
    if anchor.merged_range != Some(range) {
        return Err(HcdError::PreconditionFailed(
            "XLSX anchor is not merged across the requested range".to_string(),
        ));
    }
    let count = (merge.end_row - merge.start_row + 1)
        .saturating_mul(merge.end_column - merge.start_column + 1);
    if count > 10_000 {
        return Err(HcdError::ResourceLimit(
            "XLSX unmerge exceeds 10000 cells".to_string(),
        ));
    }
    let reference = format!(
        "{}{}:{}{}",
        xlsx_column_name(merge.start_column),
        merge.start_row,
        xlsx_column_name(merge.end_column),
        merge.end_row
    );
    let mut restored_anchor = html[anchor.start..anchor.end].to_string();
    for attribute in [
        format!(" data-hcd-merge=\"{reference}\""),
        format!(" rowspan=\"{}\"", merge.end_row - merge.start_row + 1),
        format!(" colspan=\"{}\"", merge.end_column - merge.start_column + 1),
    ] {
        if !restored_anchor.contains(&attribute) {
            return Err(HcdError::InvalidBundle(
                "XLSX merge anchor has inconsistent span attributes".to_string(),
            ));
        }
        restored_anchor = restored_anchor.replacen(&attribute, "", 1);
    }
    let mut changes = vec![(anchor.start, anchor.end, restored_anchor, 0u32)];
    for row in merge.start_row..=merge.end_row {
        let marker = format!("<tr data-hcd-row=\"{row}\"");
        let row_start = html.find(&marker).ok_or_else(|| {
            HcdError::Unsupported(format!(
                "XLSX merged row {row} is not present in the HCD window"
            ))
        })?;
        let row_end = html[row_start..]
            .find("</tr>")
            .map(|offset| row_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle("XLSX merged row is not closed".to_string()))?;
        for column in merge.start_column..=merge.end_column {
            if row == merge.start_row && column == merge.start_column {
                continue;
            }
            if cells
                .iter()
                .any(|cell| cell.row == row && cell.column == column)
            {
                return Err(HcdError::PreconditionFailed(
                    "XLSX covered cell already exists".to_string(),
                ));
            }
            let insertion = cells
                .iter()
                .filter(|cell| cell.row == row && cell.column > column)
                .map(|cell| cell.start)
                .min()
                .unwrap_or(row_end);
            let empty = original_cells
                .iter()
                .find(|cell| cell.row == row && cell.column == column)
                .filter(|cell| {
                    !cell.has_node
                        && cell.merged_range.is_none()
                        && initial_html[cell.tag_end + 1..cell.end - 5]
                            .trim()
                            .is_empty()
                })
                .map(|cell| initial_html[cell.start..cell.end].to_string())
                .unwrap_or_else(|| {
                    format!("<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{column}\"></td>")
                });
            changes.push((insertion, insertion, empty, column));
        }
    }
    changes.sort_unstable_by(|left, right| right.0.cmp(&left.0).then_with(|| right.3.cmp(&left.3)));
    for (start, end, replacement, _) in changes {
        html.replace_range(start..end, &replacement);
    }
    Ok(())
}

fn pdf_page_dimensions(html: &str, page: usize) -> Result<(f32, f32), HcdError> {
    let tag_end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("PDF page tag is missing".to_string()))?;
    let tag = &html[..tag_end];
    if !tag.starts_with("<section class=\"hcd-pdf-page\"")
        || !tag.contains(&format!("data-hcd-page=\"{page}\""))
        || !tag.contains("data-hcd-continuation=\"false\"")
        || !tag.contains("data-hcd-source-raster=\"true\"")
    {
        return Err(HcdError::InvalidBundle(format!(
            "PDF page {page} has no primary raster chunk"
        )));
    }
    let style = tag
        .split_once("style=\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(value, _)| value)
        .ok_or_else(|| HcdError::InvalidBundle("PDF page style is missing".to_string()))?;
    let dimension = |name: &str| -> Result<f32, HcdError> {
        let value = style
            .split(';')
            .find_map(|property| property.trim().strip_prefix(name))
            .and_then(|value| value.strip_suffix("pt"))
            .ok_or_else(|| HcdError::InvalidBundle(format!("PDF page {name} is missing")))?;
        let parsed: f32 = value
            .parse()
            .map_err(|_| HcdError::InvalidBundle(format!("PDF page {name} is invalid")))?;
        if !parsed.is_finite() || parsed <= 0.0 || parsed > 14_400.0 {
            return Err(HcdError::InvalidBundle(format!(
                "PDF page {name} exceeds safe limits"
            )));
        }
        Ok(parsed)
    };
    Ok((dimension("width:")?, dimension("height:")?))
}

fn insert_pdf_text(
    html: &mut String,
    source_map: &mut crate::ChunkSourceMap,
    insertion: &PdfTextInsertion,
) -> Result<(), HcdError> {
    let (page_width, page_height) = pdf_page_dimensions(html, insertion.page)?;
    if insertion.x_pt + insertion.width_pt > page_width
        || insertion.y_pt + insertion.height_pt > page_height
    {
        return Err(HcdError::InvalidPatch(format!(
            "PDF text box is outside page {}",
            insertion.page
        )));
    }
    if source_map
        .entries
        .iter()
        .any(|entry| entry.node_id == insertion.node_id)
    {
        return Err(HcdError::InvalidPatch(
            "PDF text node ID already exists".to_string(),
        ));
    }
    let ordinal = source_map
        .entries
        .iter()
        .map(|entry| entry.source.text_ordinal)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HcdError::ResourceLimit("PDF text ordinal overflowed".to_string()))?;
    let source_path = format!("/page[{}]/hcd-text[{}]", insertion.page, insertion.node_id);
    let node_hash = hash_bytes(insertion.text.as_bytes());
    let top = page_height - insertion.y_pt - insertion.height_pt;
    let block = format!(
        "<p class=\"hcd-pdf-text\" data-hcd-text-node=\"{}\" data-hcd-source-path=\"{source_path}\" data-hcd-source-order=\"{ordinal}\" data-hcd-mapping=\"hcd-overlay\" data-hcd-bbox=\"{},{},{},{}\" data-hcd-x=\"{}\" data-hcd-y=\"{}\" data-hcd-width=\"{}\" data-hcd-height=\"{}\" style=\"position:absolute;left:{}pt;top:{top}pt;width:{}pt;height:{}pt;font-family:Arial, Helvetica, sans-serif;font-size:{}pt;font-weight:normal;font-style:normal;color:black;line-height:{}pt\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-patched=\"true\">{}</span></p>",
        insertion.node_id,
        insertion.x_pt, insertion.y_pt, insertion.width_pt, insertion.height_pt,
        insertion.x_pt, insertion.y_pt, insertion.width_pt, insertion.height_pt,
        insertion.x_pt, insertion.width_pt, insertion.height_pt,
        insertion.font_size_pt, insertion.font_size_pt,
        insertion.node_id, escape_text(&insertion.text),
    );
    let end = html
        .rfind("</section>")
        .ok_or_else(|| HcdError::InvalidBundle("PDF page closing tag is missing".to_string()))?;
    html.insert_str(end, &block);
    source_map.entries.push(NodeMapEntry {
        node_id: insertion.node_id.clone(),
        node_hash,
        source: SourceAnchor {
            source_cell_ref: None,
            created_in_hcd: false,
            part: format!("pdf/pages/{}", insertion.page),
            text_ordinal: ordinal,
            paragraph_id: Some(source_path),
            text_id: None,
            node_kind: "pdf-text".to_string(),
            editable: true,
        },
    });
    Ok(())
}

fn collect_styles(patch: &PatchBatch) -> Result<BTreeMap<String, StyleChange>, HcdError> {
    let mut styles = BTreeMap::new();
    for operation in &patch.operations {
        if let PatchOperation::NodeStyle {
            node_id,
            style,
            precondition,
        } = operation
        {
            if styles
                .insert(
                    node_id.clone(),
                    StyleChange {
                        style: style.clone(),
                        node_hash: precondition.node_hash.clone(),
                    },
                )
                .is_some()
            {
                return Err(HcdError::InvalidPatch(format!(
                    "patch contains more than one node.style for {node_id}"
                )));
            }
        }
    }
    Ok(styles)
}

fn collect_image_changes(patch: &PatchBatch) -> Result<BTreeMap<String, ImageChange>, HcdError> {
    let mut images: BTreeMap<String, ImageChange> = BTreeMap::new();
    for operation in &patch.operations {
        let (node_id, visual_hash) = match operation {
            PatchOperation::ImageReplace {
                node_id,
                precondition,
                ..
            }
            | PatchOperation::ImageGeometry {
                node_id,
                precondition,
                ..
            } => (node_id, &precondition.visual_hash),
            _ => continue,
        };
        let change = images
            .entry(node_id.clone())
            .or_insert_with(|| ImageChange {
                visual_hash: visual_hash.clone(),
                ..ImageChange::default()
            });
        if change.visual_hash != *visual_hash {
            return Err(HcdError::InvalidPatch(format!(
                "image operations for {node_id} use different visualHash preconditions"
            )));
        }
        match operation {
            PatchOperation::ImageReplace { asset_hash, .. } => {
                if change.asset_hash.replace(asset_hash.clone()).is_some() {
                    return Err(HcdError::InvalidPatch(format!(
                        "patch contains more than one image.replace for {node_id}"
                    )));
                }
            }
            PatchOperation::ImageGeometry { geometry, .. } => {
                if change.geometry.replace(geometry.clone()).is_some() {
                    return Err(HcdError::InvalidPatch(format!(
                        "patch contains more than one image.geometry for {node_id}"
                    )));
                }
            }
            _ => {}
        }
    }
    Ok(images)
}

fn splice_text(text: &str, splices: &[Splice]) -> Result<String, HcdError> {
    let mut ordered = splices.to_vec();
    ordered.sort_by_key(|splice| splice.start);
    let char_count = text.chars().count();
    let mut previous_end = 0usize;
    for splice in &ordered {
        let end = splice
            .start
            .checked_add(splice.delete_count)
            .ok_or_else(|| HcdError::InvalidPatch("splice range overflowed usize".to_string()))?;
        if end > char_count {
            return Err(HcdError::InvalidPatch(format!(
                "splice range {}..{} exceeds node length {}",
                splice.start, end, char_count
            )));
        }
        if splice.start < previous_end {
            return Err(HcdError::InvalidPatch(
                "overlapping text.splice operations on one node".to_string(),
            ));
        }
        previous_end = end;
    }

    let mut chars: Vec<char> = text.chars().collect();
    for splice in ordered.into_iter().rev() {
        chars.splice(
            splice.start..splice.start + splice.delete_count,
            splice.insert_text.chars(),
        );
    }
    Ok(chars.into_iter().collect())
}

fn replace_node_text(
    html: &mut String,
    node_id: &str,
    text: &str,
    node_hash: &str,
) -> Result<(), HcdError> {
    let needle = format!("data-hcd-id=\"{}\"", escape_attribute(node_id));
    let attribute = html
        .find(&needle)
        .ok_or_else(|| HcdError::InvalidBundle(format!("node {node_id} missing from HTML")))?;
    let content_start = html[attribute + needle.len()..]
        .find('>')
        .map(|offset| attribute + needle.len() + offset + 1)
        .ok_or_else(|| HcdError::InvalidBundle(format!("node {node_id} has no start tag end")))?;
    let content_end = html[content_start..]
        .find("</span>")
        .map(|offset| content_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle(format!("node {node_id} has no closing span")))?;
    html.replace_range(content_start..content_end, &escape_text(text));
    let tag_start = html[..attribute].rfind('<').unwrap_or(attribute);
    let tag_end = html[attribute..]
        .find('>')
        .map(|offset| attribute + offset)
        .ok_or_else(|| HcdError::InvalidBundle(format!("node {node_id} has no start tag")))?;
    let hash_marker = "data-hcd-node-hash=\"";
    let hash_start = html[tag_start..tag_end]
        .find(hash_marker)
        .map(|offset| tag_start + offset + hash_marker.len())
        .ok_or_else(|| {
            HcdError::InvalidBundle(format!("node {node_id} has no node hash attribute"))
        })?;
    let hash_end = html[hash_start..tag_end]
        .find('"')
        .map(|offset| hash_start + offset)
        .ok_or_else(|| HcdError::InvalidBundle(format!("node {node_id} has invalid node hash")))?;
    html.replace_range(hash_start..hash_end, node_hash);
    Ok(())
}

fn apply_node_style(
    html: &mut String,
    node_id: &str,
    style: &NodeStylePatch,
) -> Result<(), HcdError> {
    let canonical_marker = format!("data-hcd-id=\"{}\"", escape_attribute(node_id));
    let mut text_properties = BTreeMap::new();
    if let Some(color) = &style.text_color {
        text_properties.insert("color".to_string(), color.to_ascii_lowercase());
    }
    update_start_tag_style(html, &canonical_marker, &text_properties, true)?;

    let bbox_marker = format!("data-hcd-text-node=\"{}\"", escape_attribute(node_id));
    let has_pdf_bbox = html.contains(&bbox_marker);
    if let Some(color) = &style.background_color {
        let mut background = BTreeMap::new();
        background.insert("background-color".to_string(), color.to_ascii_lowercase());
        update_start_tag_style(
            html,
            if has_pdf_bbox {
                &bbox_marker
            } else {
                &canonical_marker
            },
            &background,
            true,
        )?;
    }

    if let Some(border) = &style.border {
        let value = format!(
            "{}pt {} {}",
            compact_css_number(border.width_pt),
            border.style.as_css(),
            border.color.to_ascii_lowercase()
        );
        let mut border_properties = BTreeMap::new();
        for side in ["top", "right", "bottom", "left"] {
            border_properties.insert(format!("border-{side}"), value.clone());
        }
        if has_pdf_bbox {
            update_start_tag_style(html, &bbox_marker, &border_properties, true)?;
        } else {
            update_start_tag_style(html, &canonical_marker, &border_properties, true)?;
        }
    }
    Ok(())
}

fn validate_staged_asset(
    bundle: &Bundle,
    asset: &AssetDescriptor,
    expected_hash: &str,
) -> Result<(), HcdError> {
    if asset.hash != expected_hash {
        return Err(HcdError::InvalidBundle(format!(
            "staged asset descriptor hash {} does not match {expected_hash}",
            asset.hash
        )));
    }
    let path = bundle.resolve_href(&asset.href)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() != asset.byte_length {
        return Err(HcdError::InvalidBundle(format!(
            "staged asset {expected_hash} expected {} bytes, found {}",
            asset.byte_length,
            metadata.len()
        )));
    }
    let actual = crate::hash_file(path)?;
    if actual != expected_hash {
        return Err(HcdError::InvalidBundle(format!(
            "staged asset {expected_hash} contains hash {actual}"
        )));
    }
    Ok(())
}

fn replace_image_asset(
    html: &mut String,
    node_id: &str,
    asset: &AssetDescriptor,
) -> Result<(), HcdError> {
    set_element_attribute(html, node_id, "data-hcd-asset-hash", &asset.hash)?;
    set_element_attribute(html, node_id, "data-hcd-image-asset-patched", "true")?;
    let (_, target_end) = element_start_tag_range(html, node_id)?;
    let target_tag = &html[..=target_end];
    let image_start = if target_tag[target_tag.rfind('<').unwrap_or(0)..].starts_with("<img") {
        target_tag.rfind('<').unwrap_or(0)
    } else {
        html[target_end + 1..]
            .find("<img")
            .map(|offset| target_end + 1 + offset)
            .ok_or_else(|| {
                HcdError::InvalidBundle(format!("image node {node_id} has no img child"))
            })?
    };
    let image_end = html[image_start..]
        .find('>')
        .map(|offset| image_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle(format!("image node {node_id} img is not closed"))
        })?;
    set_attribute_in_range(
        html,
        image_start,
        image_end,
        "src",
        &format!("asset://sha256/{}", asset.hash),
    )?;
    let image_end = html[image_start..]
        .find('>')
        .map(|offset| image_start + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle(format!("image node {node_id} img is not closed"))
        })?;
    set_attribute_in_range(
        html,
        image_start,
        image_end,
        "data-hcd-asset-href",
        &asset.href,
    )
}

fn replace_image_geometry(
    html: &mut String,
    node_id: &str,
    geometry: &ImageGeometry,
) -> Result<(), HcdError> {
    crate::html::validate_image_geometry(geometry)?;
    set_element_attribute(html, node_id, "data-hcd-image-geometry-patched", "true")?;
    for (name, value) in [
        ("data-hcd-x", canonical_f64(geometry.x)),
        ("data-hcd-y", canonical_f64(geometry.y)),
        ("data-hcd-width", canonical_f64(geometry.width)),
        ("data-hcd-height", canonical_f64(geometry.height)),
    ] {
        set_element_attribute(html, node_id, name, &value)?;
    }
    set_element_attribute(
        html,
        node_id,
        "data-hcd-geometry-unit",
        match geometry.unit {
            ImageGeometryUnit::Emu => "emu",
            ImageGeometryUnit::Pt => "pt",
        },
    )?;
    if geometry.unit == ImageGeometryUnit::Emu {
        for (name, value) in [
            ("data-hcd-x-emu", canonical_f64(geometry.x)),
            ("data-hcd-y-emu", canonical_f64(geometry.y)),
            ("data-hcd-width-emu", canonical_f64(geometry.width)),
            ("data-hcd-height-emu", canonical_f64(geometry.height)),
        ] {
            set_element_attribute(html, node_id, name, &value)?;
        }
    } else {
        set_element_attribute(
            html,
            node_id,
            "data-hcd-bbox",
            &format!(
                "{},{},{},{}",
                canonical_f64(geometry.x),
                canonical_f64(geometry.y),
                canonical_f64(geometry.width),
                canonical_f64(geometry.height)
            ),
        )?;
    }
    let scale = match geometry.unit {
        ImageGeometryUnit::Emu => 96.0 / 914_400.0,
        ImageGeometryUnit::Pt => 1.0,
    };
    let suffix = match geometry.unit {
        ImageGeometryUnit::Emu => "px",
        ImageGeometryUnit::Pt => "pt",
    };
    let mut properties = BTreeMap::new();
    properties.insert("position".to_string(), "absolute".to_string());
    properties.insert(
        "left".to_string(),
        format!("{}{suffix}", canonical_f64(geometry.x * scale)),
    );
    properties.insert(
        "top".to_string(),
        format!("{}{suffix}", canonical_f64(geometry.y * scale)),
    );
    properties.insert(
        "width".to_string(),
        format!("{}{suffix}", canonical_f64(geometry.width * scale)),
    );
    properties.insert(
        "height".to_string(),
        format!("{}{suffix}", canonical_f64(geometry.height * scale)),
    );
    let marker = format!("data-hcd-id=\"{}\"", escape_attribute(node_id));
    update_start_tag_style(html, &marker, &properties, false)
}

fn set_element_attribute(
    html: &mut String,
    node_id: &str,
    name: &str,
    value: &str,
) -> Result<(), HcdError> {
    let (start, end) = element_start_tag_range(html, node_id)?;
    set_attribute_in_range(html, start, end, name, value)
}

fn element_start_tag_range(html: &str, node_id: &str) -> Result<(usize, usize), HcdError> {
    let marker = format!("data-hcd-id=\"{}\"", escape_attribute(node_id));
    let offset = html
        .find(&marker)
        .ok_or_else(|| HcdError::InvalidBundle(format!("image node {node_id} is missing")))?;
    let start = html[..offset]
        .rfind('<')
        .ok_or_else(|| HcdError::InvalidBundle(format!("image node {node_id} has no start tag")))?;
    let end = html[offset..]
        .find('>')
        .map(|relative| offset + relative)
        .ok_or_else(|| HcdError::InvalidBundle(format!("image node {node_id} is not closed")))?;
    Ok((start, end))
}

fn set_attribute_in_range(
    html: &mut String,
    tag_start: usize,
    tag_end: usize,
    name: &str,
    value: &str,
) -> Result<(), HcdError> {
    let tag = &html[tag_start..=tag_end];
    let marker = format!(" {name}=\"");
    let escaped = escape_attribute(value);
    let mut replacement = tag.to_string();
    if let Some(start) = replacement.find(&marker) {
        let value_start = start + marker.len();
        let value_end = replacement[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
            .ok_or_else(|| HcdError::InvalidBundle(format!("attribute {name} is not closed")))?;
        replacement.replace_range(value_start..value_end, &escaped);
    } else {
        let insertion = replacement
            .rfind("/>")
            .unwrap_or_else(|| replacement.len().saturating_sub(1));
        replacement.insert_str(insertion, &format!(" {name}=\"{escaped}\""));
    }
    html.replace_range(tag_start..=tag_end, &replacement);
    Ok(())
}

fn canonical_f64(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    format!("{value:.6}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn update_start_tag_style(
    html: &mut String,
    marker: &str,
    updates: &BTreeMap<String, String>,
    mark_patched: bool,
) -> Result<(), HcdError> {
    let marker_offset = html.find(marker).ok_or_else(|| {
        HcdError::InvalidBundle(format!(
            "style target containing {marker} is missing from HTML"
        ))
    })?;
    let tag_start = html[..marker_offset].rfind('<').ok_or_else(|| {
        HcdError::InvalidBundle(format!("style target containing {marker} has no start tag"))
    })?;
    let tag_end = html[marker_offset..]
        .find('>')
        .map(|offset| marker_offset + offset)
        .ok_or_else(|| {
            HcdError::InvalidBundle(format!("style target containing {marker} is not closed"))
        })?;
    let tag = &html[tag_start..=tag_end];
    let mut declarations = BTreeMap::new();
    let style_marker = " style=\"";
    let style_range = tag.find(style_marker).map(|start| {
        let value_start = start + style_marker.len();
        let value_end = tag[value_start..]
            .find('"')
            .map(|offset| value_start + offset)
            .unwrap_or(value_start);
        (value_start, value_end)
    });
    if let Some((value_start, value_end)) = style_range {
        for declaration in tag[value_start..value_end].split(';') {
            let Some((property, value)) = declaration.split_once(':') else {
                continue;
            };
            declarations.insert(
                property.trim().to_ascii_lowercase(),
                value.trim().to_string(),
            );
        }
    }
    declarations.extend(updates.clone());
    let style_value = declarations
        .iter()
        .map(|(property, value)| format!("{property}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    crate::html::validate_inline_style(&style_value)?;

    let mut replacement = tag.to_string();
    if let Some((value_start, value_end)) = style_range {
        replacement.replace_range(value_start..value_end, &style_value);
    } else if !style_value.is_empty() {
        replacement.insert_str(replacement.len() - 1, &format!(" style=\"{style_value}\""));
    }
    if mark_patched && !replacement.contains(" data-hcd-style-patched=\"true\"") {
        replacement.insert_str(replacement.len() - 1, " data-hcd-style-patched=\"true\"");
    }
    html.replace_range(tag_start..=tag_end, &replacement);
    Ok(())
}

fn compact_css_number(value: f32) -> String {
    let formatted = format!("{value:.3}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn apply_annotations(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(Option<String>, String), HcdError> {
    let has_annotation_ops = patch.operations.iter().any(|operation| {
        matches!(
            operation,
            PatchOperation::AnnotationUpsert { .. } | PatchOperation::AnnotationRemove { .. }
        )
    });
    if !has_annotation_ops {
        return Ok((
            manifest.annotation_href.clone(),
            manifest.annotation_root_hash.clone(),
        ));
    }

    let mut set = if let Some(href) = &manifest.annotation_href {
        read_json_bounded(
            &bundle.resolve_href(href)?,
            MAX_CONTROL_PART_BYTES,
            "annotation set",
        )?
    } else {
        AnnotationSet {
            schema_version: manifest.schema_version.clone(),
            annotations: Vec::new(),
        }
    };
    for operation in &patch.operations {
        match operation {
            PatchOperation::AnnotationUpsert { annotation } => {
                if let Some(existing) = set
                    .annotations
                    .iter_mut()
                    .find(|existing| existing.annotation_id == annotation.annotation_id)
                {
                    *existing = annotation.clone();
                } else {
                    set.annotations.push(annotation.clone());
                }
            }
            PatchOperation::AnnotationRemove { annotation_id } => {
                set.annotations
                    .retain(|annotation| annotation.annotation_id != *annotation_id);
            }
            PatchOperation::TextSplice { .. }
            | PatchOperation::PdfTextInsert { .. }
            | PatchOperation::XlsxMerge { .. }
            | PatchOperation::XlsxUnmerge { .. }
            | PatchOperation::XlsxCellSet { .. }
            | PatchOperation::XlsxRowAppend { .. }
            | PatchOperation::XlsxRowInsert { .. }
            | PatchOperation::XlsxRowDelete { .. }
            | PatchOperation::XlsxColumnInsert { .. }
            | PatchOperation::XlsxColumnDelete { .. }
            | PatchOperation::XlsxRowRemoveLast { .. }
            | PatchOperation::XlsxColumnWidth { .. }
            | PatchOperation::NodeStyle { .. }
            | PatchOperation::ImageReplace { .. }
            | PatchOperation::ImageGeometry { .. } => {}
        }
    }
    set.annotations
        .sort_by(|left, right| left.annotation_id.cmp(&right.annotation_id));
    let encoded = serde_json::to_vec(&set)?;
    if encoded.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "annotation set is {} bytes; maximum is {MAX_CONTROL_PART_BYTES}",
            encoded.len()
        )));
    }
    let (href, hash) = bundle.write_json_object("annotations", &set)?;
    Ok((Some(href), hash))
}

fn validate_annotation_ranges(
    patch: &PatchBatch,
    found_nodes: &HashMap<String, usize>,
) -> Result<(), HcdError> {
    for operation in &patch.operations {
        if let PatchOperation::AnnotationUpsert { annotation } = operation {
            let length = found_nodes
                .get(&annotation.node_id)
                .ok_or_else(|| HcdError::NodeNotFound(annotation.node_id.clone()))?;
            if annotation.start > annotation.end || annotation.end > *length {
                return Err(HcdError::InvalidPatch(format!(
                    "annotation {} range {}..{} exceeds node length {}",
                    annotation.annotation_id, annotation.start, annotation.end, length
                )));
            }
        }
    }
    Ok(())
}

fn find_idempotent_result(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    patch_id: &str,
    patch_hash: &str,
) -> Result<Option<ApplyResult>, HcdError> {
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if record.patch_id.as_deref() == Some(patch_id) {
            if record.patch_hash.as_deref() != Some(patch_hash) {
                return Err(HcdError::InvalidPatch(format!(
                    "patchId {patch_id} was already used with a different payload"
                )));
            }
            return Ok(Some(ApplyResult {
                document_id: record.document_id,
                patch_id: patch_id.to_string(),
                base_revision: record.patch_base_revision.unwrap_or(0),
                revision: record.revision,
                root_hash: record.root_hash,
                annotation_root_hash: record.annotation_root_hash,
                dirty_node_ids: record.dirty_node_ids,
                dirty_chunk_ids: record.dirty_chunk_ids,
                dirty_source_parts: record.dirty_source_parts,
                warnings: Vec::new(),
                idempotent_replay: true,
            }));
        }
    }
    Ok(None)
}

fn parse_cursor(cursor: Option<&str>) -> Result<(usize, usize), HcdError> {
    let Some(cursor) = cursor else {
        return Ok((0, 0));
    };
    let (sequence, offset) = cursor
        .split_once(':')
        .ok_or_else(|| HcdError::InvalidPatch("invalid extract cursor".to_string()))?;
    Ok((
        sequence
            .parse()
            .map_err(|_| HcdError::InvalidPatch("invalid cursor sequence".to_string()))?,
        offset
            .parse()
            .map_err(|_| HcdError::InvalidPatch("invalid cursor offset".to_string()))?,
    ))
}

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attribute(text: &str) -> String {
    escape_text(text)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn is_forbidden_xml_character(ch: char) -> bool {
    matches!(ch as u32, 0x0..=0x8 | 0xB | 0xC | 0xE..=0x1F | 0xFFFE | 0xFFFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitting_merge_restores_empty_cell_style_and_column_order() {
        let original = concat!(
            "<table><tbody>",
            "<tr data-hcd-row=\"1\"><td class=\"hcd-cell\" data-hcd-column=\"1\"><span data-hcd-id=\"n_00000000000000000000000000000000\">A</span></td>",
            "<td class=\"hcd-cell hcd-xs-2\" data-hcd-column=\"2\"></td>",
            "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"3\"></td></tr>",
            "<tr data-hcd-row=\"2\"><td class=\"hcd-cell hcd-empty\" data-hcd-column=\"1\"></td>",
            "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"2\"></td></tr>",
            "</tbody></table>"
        );
        let merge = XlsxMerge {
            sheet_id: "unused".to_string(),
            start_row: 1,
            start_column: 1,
            end_row: 2,
            end_column: 2,
            node_hash: "unused".to_string(),
        };
        let mut html = original.to_string();
        merge_xlsx_cells(&mut html, &merge).unwrap();
        assert!(!html.contains("hcd-xs-2"));
        unmerge_xlsx_cells(&mut html, original, &merge).unwrap();
        assert_eq!(html, original);
    }

    #[test]
    fn unicode_scalar_splice_handles_emoji() {
        let result = splice_text(
            "甲😀乙",
            &[Splice {
                start: 1,
                delete_count: 1,
                insert_text: "**".to_string(),
                node_hash: "unused".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(result, "甲**乙");
    }

    #[test]
    fn overlapping_splices_are_rejected() {
        let error = splice_text(
            "abcdef",
            &[
                Splice {
                    start: 1,
                    delete_count: 3,
                    insert_text: "x".to_string(),
                    node_hash: "unused".to_string(),
                },
                Splice {
                    start: 2,
                    delete_count: 1,
                    insert_text: "y".to_string(),
                    node_hash: "unused".to_string(),
                },
            ],
        )
        .unwrap_err();
        assert!(error.to_string().contains("overlapping"));
    }

    #[test]
    fn generated_span_text_is_replaced_and_escaped() {
        let mut html = "<p><span data-hcd-id=\"n_1\" data-hcd-node-hash=\"oldhash\">old</span></p>"
            .to_string();
        replace_node_text(&mut html, "n_1", "a < b", "newhash").unwrap();
        assert_eq!(
            html,
            "<p><span data-hcd-id=\"n_1\" data-hcd-node-hash=\"newhash\">a &lt; b</span></p>"
        );
    }

    #[test]
    fn node_style_targets_text_and_pdf_bbox_without_changing_node_hash() {
        let node_id = "n_00000000000000000000000000000000";
        let mut html = format!(
            "<p class=\"hcd-pdf-text\" data-hcd-text-node=\"{node_id}\" style=\"position:absolute;left:10pt\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{}\">old</span></p>",
            "a".repeat(64)
        );
        apply_node_style(
            &mut html,
            node_id,
            &crate::NodeStylePatch {
                text_color: Some("#D70015".to_string()),
                background_color: Some("#FFF2A8".to_string()),
                border: Some(crate::NodeBorder {
                    color: "#0A84FF".to_string(),
                    width_pt: 2.0,
                    style: crate::NodeBorderStyle::Dashed,
                }),
            },
        )
        .unwrap();

        assert!(html.contains("color:#d70015"));
        assert!(html.contains("background-color:#fff2a8"));
        assert!(html.contains("border-top:2pt dashed #0a84ff"));
        assert!(html.contains("data-hcd-style-patched=\"true\""));
        assert!(html.contains(&format!("data-hcd-node-hash=\"{}\"", "a".repeat(64))));
        assert_eq!(extract_html_text_nodes(&html).unwrap()[node_id], "old");
    }

    #[test]
    fn node_style_validation_rejects_empty_and_unsafe_values() {
        let empty = crate::NodeStylePatch {
            text_color: None,
            background_color: None,
            border: None,
        };
        assert!(validate_node_style(&empty).is_err());

        let unsafe_color = crate::NodeStylePatch {
            text_color: Some("red;url(x)".to_string()),
            background_color: None,
            border: None,
        };
        assert!(validate_node_style(&unsafe_color).is_err());
    }

    #[test]
    fn patch_revisions_every_bounded_index_page() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle");
        let mut writer =
            crate::BundleWriter::create_with_codec(&bundle_path, crate::StorageCodec::Gzip)
                .unwrap();
        writer.write_styles("").unwrap();
        for index in 0..=crate::INDEX_PAGE_SIZE {
            let node_id = format!("n_{index:032x}");
            let chunk_id = format!("c_{index:032x}");
            let text = format!("value-{index}");
            let node_hash = hash_bytes(text.as_bytes());
            let html = format!(
                "<p><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{text}</span></p>"
            );
            writer
                .write_chunk(
                    chunk_id.clone(),
                    "body".to_string(),
                    html,
                    crate::ChunkSourceMap {
                        schema_version: HCD_SCHEMA_VERSION.to_string(),
                        chunk_id,
                        entries: vec![crate::NodeMapEntry {
                            node_id,
                            node_hash,
                            source: crate::SourceAnchor {
                                source_cell_ref: None,
                                created_in_hcd: false,
                                part: "text/document".to_string(),
                                text_ordinal: index as u64 + 1,
                                paragraph_id: None,
                                text_id: Some(format!("bytes:{index}:{}", index + 1)),
                                node_kind: "line".to_string(),
                                editable: true,
                            },
                        }],
                    },
                    1,
                    false,
                )
                .unwrap();
        }
        writer
            .finish(crate::HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                storage_codec: crate::StorageCodec::Gzip,
                document_id: "multi-index".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: crate::SourceDescriptor {
                    format: "txt".to_string(),
                    sha256: "0".repeat(64),
                    size_bytes: 1000,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                capabilities: crate::HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let original = bundle.manifest().unwrap();
        let original_second_page = original.index_root_href.clone().unwrap();
        let descriptor = bundle.read_index_page(&original, 0).unwrap().chunks[0].clone();
        assert!(bundle.read_chunk_verified(&descriptor).is_ok());
        assert!(bundle.read_map_verified(&descriptor).is_ok());
        let mut forged = descriptor.clone();
        forged.byte_length += 1;
        assert!(bundle.read_chunk_verified(&forged).is_err());
        forged = descriptor.clone();
        forged.html_hash = "f".repeat(64);
        assert!(bundle.read_chunk_verified(&forged).is_err());
        forged = descriptor;
        forged.map_hash = "f".repeat(64);
        assert!(bundle.read_map_verified(&forged).is_err());
        let first = get_text_node(&bundle, "n_00000000000000000000000000000000").unwrap();
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
                document_id: "multi-index".to_string(),
                patch_id: "multi-index-1".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextSplice {
                    node_id: first.node.node_id,
                    start: 0,
                    delete_count: first.node.text.chars().count(),
                    insert_text: "changed".to_string(),
                    precondition: crate::NodePrecondition {
                        node_hash: first.node.node_hash,
                    },
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.index_page_count, 2);
        assert_eq!(bundle.read_index_page(&manifest, 0).unwrap().revision, 1);
        assert_eq!(bundle.read_index_page(&manifest, 1).unwrap().revision, 0);
        assert_ne!(
            manifest.index_root_href.as_deref(),
            Some(original_second_page.as_str())
        );
        let (historical, _) = crate::manifest_at_revision(&bundle, &manifest, Some(0)).unwrap();
        assert_eq!(bundle.read_index_page(&historical, 0).unwrap().revision, 0);
        assert_eq!(bundle.read_index_page(&historical, 1).unwrap().revision, 0);
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        assert!(crate::bundle_stats(&bundle)
            .unwrap()
            .orphan_hrefs
            .is_empty());
        let orphan_href = format!("chunks/sha256/{}.html.gz", "f".repeat(64));
        std::fs::write(bundle_path.join(&orphan_href), b"interrupted write").unwrap();
        assert_eq!(
            crate::bundle_stats(&bundle).unwrap().orphan_hrefs,
            vec![orphan_href.clone()]
        );
        crate::remove_orphan_objects(&bundle).unwrap();
        assert!(!bundle_path.join(orphan_href).exists());
        assert!(bundle_path.join(original_second_page).exists());
        let mut rendered = Vec::new();
        crate::render_standalone_html(
            &bundle,
            &crate::HtmlPresentationOptions {
                revision: Some(1),
                ..crate::HtmlPresentationOptions::default()
            },
            &mut rendered,
        )
        .unwrap();
        assert!(String::from_utf8(rendered).unwrap().contains("changed"));
    }

    #[test]
    fn runtime_patch_validation_enforces_frozen_ids_hashes_and_annotations() {
        assert!(validate_node_id("n_00000000000000000000000000000000").is_ok());
        assert!(validate_node_id("n_NOT_HEX").is_err());
        assert!(validate_sha256("nodeHash", &"a".repeat(64)).is_ok());
        assert!(validate_sha256("nodeHash", &"A".repeat(64)).is_err());

        let mut annotation = crate::Annotation {
            annotation_id: "a-1".to_string(),
            node_id: "n_00000000000000000000000000000000".to_string(),
            start: 0,
            end: 1,
            kind: "mask".to_string(),
            rule_id: None,
            confidence: Some(0.5),
            ignored: false,
        };
        assert!(validate_annotation(&annotation).is_ok());
        annotation.confidence = Some(1.5);
        assert!(validate_annotation(&annotation).is_err());
        annotation.confidence = Some(0.5);
        annotation.annotation_id = "x".repeat(MAX_IDENTIFIER_BYTES + 1);
        assert!(validate_annotation(&annotation).is_err());
    }
}
