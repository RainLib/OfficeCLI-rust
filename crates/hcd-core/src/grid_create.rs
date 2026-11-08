//! Checked, atomic creation of mapped spreadsheet cells. The source-format
//! owner must check the original workbook while this function holds the lock.
use crate::bundle::{finalize_root_hash, hash_descriptor, now_epoch_ms, INDEX_PAGE_SIZE};
use crate::{
    hash_bytes, node_bloom, stable_node_id, ApplyResult, Bundle, ChunkDescriptor, ChunkSourceMap,
    GridChunkAddress, GridChunkKind, HcdError, HcdManifest, NodeMapEntry, RevisionRecord,
    SourceAnchor, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES, MAX_REVISION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const XLSX_VIRTUAL_CELL_SOURCE: &str = "hcd:xlsx-virtual-cell/1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridCellCreate {
    pub sheet_id: String,
    pub sheet_part: String,
    pub row: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridCreateRequest {
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    pub source_sha256: String,
    pub cells: Vec<GridCellCreate>,
    #[serde(default)]
    pub actor: BTreeMap<String, String>,
}

fn address(row: u32, mut column: u32) -> Option<String> {
    if !(1..=1_048_576).contains(&row) || !(1..=16_384).contains(&column) {
        return None;
    }
    let mut letters = Vec::new();
    while column > 0 {
        column -= 1;
        letters.push((b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    Some(format!(
        "{}{row}",
        letters.into_iter().rev().collect::<String>()
    ))
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The callback MUST authenticate the source identity and check every target
/// for protection, formulas, merges, and existing physical cells. It runs while
/// the bundle write lock is held. This internal primitive is not an endpoint;
/// the caller must separately authenticate the actor and retain its request.
pub fn apply_checked_grid_cells(
    bundle: &Bundle,
    request: &GridCreateRequest,
    mut check_source: impl FnMut(&Bundle, &HcdManifest, &GridCreateRequest) -> Result<(), HcdError>,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx"
        || manifest.profile != "grid"
        || request.document_id != manifest.document_id
    {
        return Err(HcdError::InvalidPatch("XLSX_GRID_SCOPE".into()));
    }
    if request.patch_id.trim().is_empty()
        || request.patch_id.len() > 256
        || request.patch_id.starts_with("restore-")
        || request.cells.is_empty()
        || request.cells.len() > 4000
    {
        return Err(HcdError::InvalidPatch("XLSX_GRID_REQUEST".into()));
    }
    let serialized = serde_json::to_vec(request)?;
    if serialized.len() > MAX_CHUNK_BYTES {
        return Err(HcdError::ResourceLimit(
            "XLSX grid request too large".into(),
        ));
    }
    let patch_hash = hash_bytes(&serialized);
    if let Some(result) =
        crate::patch::find_idempotent_result(bundle, &manifest, &request.patch_id, &patch_hash)?
    {
        return Ok(result);
    }
    if request.base_revision != manifest.revision || request.source_sha256 != manifest.source.sha256
    {
        return Err(HcdError::RevisionConflict("XLSX_GRID_HEAD_CHANGED".into()));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let mut ids = BTreeSet::new();
    let mut positions = BTreeSet::new();
    for cell in &request.cells {
        let a = address(cell.row, cell.column)
            .ok_or_else(|| HcdError::InvalidPatch("XLSX_GRID_ADDRESS".into()))?;
        if cell.text.chars().any(|c| !matches!(c as u32, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF)) { return Err(HcdError::InvalidPatch("XLSX_GRID_TEXT".into())); }
        if cell.sheet_id
            != stable_node_id(&[&manifest.document_id, &cell.sheet_part, "worksheet"])
                .replacen("n_", "s_", 1)
            || !positions.insert((cell.sheet_part.clone(), a.clone()))
            || !ids.insert(stable_node_id(&[
                &manifest.document_id,
                &cell.sheet_part,
                "cell",
                &a,
            ]))
        {
            return Err(HcdError::InvalidPatch(
                "XLSX_GRID_DUPLICATE_OR_IDENTITY".into(),
            ));
        }
    }
    let mut previous = Vec::new();
    let mut chunk_ids = HashSet::new();
    let mut sheet_meta = HashMap::<String, GridChunkAddress>::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            if !chunk_ids.insert(descriptor.chunk_id.clone()) {
                return Err(HcdError::InvalidBundle(
                    "duplicate grid chunk identity".into(),
                ));
            }
            if let Some(grid) = descriptor
                .grid
                .as_ref()
                .filter(|grid| grid.kind == GridChunkKind::Cells)
            {
                if let Some(old) = sheet_meta.get(&grid.sheet_id) {
                    if old.sheet_name != grid.sheet_name
                        || old.sheet_index != grid.sheet_index
                        || old.sheet_state != grid.sheet_state
                    {
                        return Err(HcdError::InvalidBundle(
                            "inconsistent worksheet grid metadata".into(),
                        ));
                    }
                } else {
                    sheet_meta.insert(grid.sheet_id.clone(), grid.clone());
                }
            }
            for entry in bundle.read_map_verified(&descriptor)?.entries {
                if ids.contains(&entry.node_id)
                    || entry.source.node_kind == "cell"
                        && entry.source.paragraph_id.as_ref().is_some_and(|a| {
                            positions.contains(&(entry.source.part.clone(), a.clone()))
                        })
                {
                    return Err(HcdError::RevisionConflict(
                        "XLSX_CELL_ALREADY_MAPPED".into(),
                    ));
                }
            }
            previous.push(descriptor);
        }
    }
    if previous.len() != manifest.chunk_count {
        return Err(HcdError::InvalidBundle("grid chunk count mismatch".into()));
    }
    for cell in &request.cells {
        if !sheet_meta.contains_key(&cell.sheet_id) {
            return Err(HcdError::InvalidPatch("XLSX_SHEET_NOT_FOUND".into()));
        }
    }
    check_source(bundle, &manifest, request)?;
    let revision = manifest.revision + 1;
    let mut descriptors = previous.clone();
    let mut dirty_nodes = Vec::new();
    let mut dirty_chunks = Vec::new();
    let mut dirty_parts = BTreeSet::new();
    for cell in &request.cells {
        let a = address(cell.row, cell.column).unwrap();
        let id = stable_node_id(&[&manifest.document_id, &cell.sheet_part, "cell", &a]);
        let chunk_id =
            stable_node_id(&[&manifest.document_id, &cell.sheet_part, "virtual-cell", &a])
                .replacen("n_", "c_", 1);
        if !chunk_ids.insert(chunk_id.clone()) {
            return Err(HcdError::InvalidBundle(
                "duplicate grid chunk identity".into(),
            ));
        }
        let hash = hash_bytes(cell.text.as_bytes());
        let mut grid = sheet_meta[&cell.sheet_id].clone();
        grid.row_start = Some(cell.row.into());
        grid.row_end = grid.row_start;
        grid.column_start = Some(cell.column);
        grid.column_end = grid.column_start;
        let html = format!("<section class=\"hcd-sheet\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\" data-hcd-row-start=\"{}\" data-hcd-row-end=\"{}\"><table class=\"hcd-grid\"><tbody><tr><td class=\"hcd-cell\" data-hcd-cell=\"{}\" data-hcd-column=\"{}\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span></td></tr></tbody></table></section>",escape(&grid.sheet_name),grid.sheet_index,grid.sheet_state,cell.row,cell.row,a,cell.column,id,hash,escape(&cell.text));
        if html.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit("XLSX grid chunk too large".into()));
        }
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.into(),
            chunk_id: chunk_id.clone(),
            entries: vec![NodeMapEntry {
                node_id: id.clone(),
                node_hash: hash,
                source: SourceAnchor {
                    part: cell.sheet_part.clone(),
                    text_ordinal: 1,
                    paragraph_id: Some(a),
                    text_id: Some(XLSX_VIRTUAL_CELL_SOURCE.into()),
                    node_kind: "cell".into(),
                    editable: true,
                },
            }],
        };
        let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
        let (map_href, map_hash) = bundle.write_json_object("maps", &map)?;
        descriptors.push(ChunkDescriptor {
            sequence: descriptors.len(),
            chunk_id: chunk_id.clone(),
            region: "sheet".into(),
            html_href,
            html_hash,
            map_href,
            map_hash,
            byte_length: html.len() as u64,
            block_count: 1,
            node_count: 1,
            text_chars: cell.text.chars().count(),
            node_bloom: node_bloom([id.as_str()]),
            first_node_id: Some(id.clone()),
            last_node_id: Some(id.clone()),
            continuation: false,
            grid: Some(grid),
        });
        dirty_nodes.push(id);
        dirty_chunks.push(chunk_id);
        dirty_parts.insert(cell.sheet_part.clone());
    }
    let root = bundle.rebuild_index(&manifest, revision, &descriptors, &previous)?;
    let asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let mut hasher = Sha256::new();
    for descriptor in &descriptors {
        hash_descriptor(&mut hasher, descriptor);
    }
    let root_hash = finalize_root_hash(bundle, hasher, &asset_index_href)?;
    let (author_id, author_name) = crate::revision_author(&request.actor)?;
    let dirty_parts: Vec<_> = dirty_parts.into_iter().collect();
    let record = RevisionRecord {
        schema_version: manifest.schema_version.clone(),
        document_id: manifest.document_id.clone(),
        revision,
        parent_revision: Some(manifest.revision),
        patch_id: Some(request.patch_id.clone()),
        patch_hash: Some(patch_hash),
        patch_base_revision: Some(request.base_revision),
        root_hash: root_hash.clone(),
        annotation_root_hash: manifest.annotation_root_hash.clone(),
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: root.clone(),
        index_page_count: Some(descriptors.len().div_ceil(INDEX_PAGE_SIZE)),
        chunk_count: Some(descriptors.len()),
        asset_index_href,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: dirty_nodes.clone(),
        dirty_chunk_ids: dirty_chunks.clone(),
        dirty_source_parts: dirty_parts.clone(),
        structural_change: false,
        layout_upgrade: false,
        word_layout_change: false,
        author_id,
        author_name,
        reference_authors: BTreeMap::new(),
    };
    // Source bytes live outside this lock. Recheck after preparing immutable
    // objects, before publishing any revision or manifest.
    check_source(bundle, &manifest, request)?;
    manifest.revision = revision;
    manifest.root_hash = root_hash.clone();
    manifest.index_root_href = root;
    manifest.index_page_count = descriptors.len().div_ceil(INDEX_PAGE_SIZE);
    manifest.chunk_count = descriptors.len();
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: request.patch_id.clone(),
        base_revision: request.base_revision,
        revision,
        root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: dirty_nodes,
        dirty_chunk_ids: dirty_chunks,
        dirty_source_parts: dirty_parts,
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}
