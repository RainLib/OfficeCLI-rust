mod pdf;
mod pptx;
mod validation;
mod xlsx;

use pdf::*;
use pptx::*;
use validation::validate_patch_identity;
use xlsx::*;

use crate::bundle::{
    finalize_root_hash, hash_descriptor, now_epoch_ms, read_json_bounded, Bundle, INDEX_PAGE_SIZE,
};
use crate::hash::{hash_bytes, node_bloom, node_bloom_might_contain, stable_node_id};
use crate::html::{escape_attribute, escape_text};
use crate::xlsx_grid::{sheet_grid_id, sheet_window_chunk_id, XlsxSheetSection};
#[cfg(test)]
use crate::HCD_SCHEMA_VERSION;
use crate::{drop_formula_sheet_references, rename_formula_sheet_references};
use crate::{
    extract_html_image_nodes, extract_html_text_nodes, image_visual_hash, AnnotationSet,
    ApplyResult, AssetDescriptor, FidelityWarning, GridColumnDeletion, GridColumnInsertion,
    GridRowDeletion, GridRowInsertion, HcdError, ImageExtractEntry, ImageExtractPage,
    ImageGeometry, ImageGeometryUnit, ImageNodeLookup, ImageNodeState, NodeMapEntry,
    NodeStylePatch, PatchBatch, PatchOperation, PdfTextGeometry, PptxRunFormat,
    PptxShapeAlignPatch, PptxShapeGeometry, RevisionRecord, SheetAddition, SheetRemoval,
    SheetRename, SlideAddition, SlideCopy, SlideRemoval, SlideReorder, SourceAnchor,
    TextExtractEntry, TextExtractPage, TextNodeLookup, XlsxCellFormatPatch, XlsxCellLayoutPatch,
    XlsxCellNumberFormatPatch, XlsxGridAction, XlsxGridAxis, HCD_PATCH_SCHEMA_VERSION,
    HCD_PATCH_SCHEMA_VERSION_10, HCD_PATCH_SCHEMA_VERSION_11, HCD_PATCH_SCHEMA_VERSION_12,
    HCD_PATCH_SCHEMA_VERSION_13, HCD_PATCH_SCHEMA_VERSION_14, HCD_PATCH_SCHEMA_VERSION_15,
    HCD_PATCH_SCHEMA_VERSION_16, HCD_PATCH_SCHEMA_VERSION_17, HCD_PATCH_SCHEMA_VERSION_18,
    HCD_PATCH_SCHEMA_VERSION_19, HCD_PATCH_SCHEMA_VERSION_2, HCD_PATCH_SCHEMA_VERSION_20,
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

/// What one `text.font` or `text.font.clear` operation asks for on a node.
/// `font: None` is the clear: drop the pin the patch wrote, which a pin can never
/// do by leaving slots out, because a pin requires at least one face.
#[derive(Clone)]
struct FontChange {
    font: Option<crate::FontPatch>,
    node_hash: String,
}

#[derive(Clone, Default)]
struct ImageChange {
    asset_hash: Option<String>,
    geometry: Option<ImageGeometry>,
    visual_hash: String,
}

/// What an index rebuild needs after a page or a tab leaves the document:
/// whether the target was there at all, how many chunks went with it, which
/// source part held the nodes it took away, and whether the survivors shift a
/// position because a tab list got one shorter. Slides carry no position in a
/// package list, so only a worksheet removal asks for the shift.
struct IndexRemoval {
    label: &'static str,
    target_found: bool,
    dropped_chunks: usize,
    source_part: String,
    node_ids: Vec<String>,
    shift_above: Option<usize>,
}

/// Lays the chunks the index ends up holding back over its pages: each one is
/// numbered from its place in the list, folded into a fresh root digest, and
/// written to the page that number puts it on, so the manifest counts the pages
/// the document now has. `shift_above` is the part only a deletion asks for — a
/// tab behind the hole finds its worksheet part one place nearer the front, and
/// a rebuild that merely moves chunks around passes `None`. Returns the digest
/// of the index as it was written, which is what the root hash is folded from.
fn rewrite_index_pages(
    bundle: &Bundle,
    manifest: &mut crate::HcdManifest,
    new_index_root: &std::path::Path,
    new_revision: u64,
    descriptors: Vec<crate::ChunkDescriptor>,
    shift_above: Option<usize>,
    index_root_href: &mut Option<String>,
) -> Result<Sha256, HcdError> {
    // The digest is folded over the list the index ends up holding, and the
    // pages are written from it: the sequence a descriptor carries is part of
    // that digest, so a rebuild changes the root hash without changing a chunk.
    let mut rebuilt: Vec<crate::ChunkIndexPage> = Vec::new();
    let mut rebuilt_hasher = Sha256::new();
    for (sequence, mut descriptor) in descriptors.into_iter().enumerate() {
        descriptor.sequence = sequence;
        if let (Some(sheet_index), Some(grid)) = (shift_above, descriptor.grid.as_mut()) {
            if grid.sheet_index > sheet_index {
                grid.sheet_index -= 1;
            }
        }
        hash_descriptor(&mut rebuilt_hasher, &descriptor);
        let page_number = sequence / INDEX_PAGE_SIZE;
        if rebuilt.len() <= page_number {
            rebuilt.push(crate::ChunkIndexPage {
                schema_version: manifest.schema_version.clone(),
                revision: new_revision,
                page: page_number,
                chunks: Vec::new(),
            });
        }
        rebuilt[page_number].chunks.push(descriptor);
    }
    if let Some(root) = index_root_href.as_ref() {
        *index_root_href = Some(bundle.replace_index_pages(root, &rebuilt)?);
    } else {
        for page in &rebuilt {
            crate::bundle::atomic_write_json_encoded(
                &new_index_root.join(format!(
                    "{:06}.json{}",
                    page.page,
                    manifest.storage_codec.suffix()
                )),
                page,
            )?;
        }
    }
    // The index tree keeps the shape it has, so a tail page a rebuild emptied is
    // simply no longer counted; the manifest walks the pages that still describe
    // the document.
    manifest.index_page_count = rebuilt.len();
    manifest.chunk_count = rebuilt.iter().map(|page| page.chunks.len()).sum();
    Ok(rebuilt_hasher)
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
        && (patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_22
            || patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_28
            || patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_29
            || patch.operations.iter().any(|operation| {
                matches!(
                    operation,
                    PatchOperation::ImageInsert { .. }
                        | PatchOperation::PdfTextInsert { .. }
                        | PatchOperation::PdfTextGeometry { .. }
                        | PatchOperation::PdfTextDelete { .. }
                        | PatchOperation::PptxTextInsert { .. }
                        | PatchOperation::PptxShapeGeometry { .. }
                        | PatchOperation::PptxTextDelete { .. }
                        | PatchOperation::PptxRunFormat { .. }
                        | PatchOperation::PptxShapeAlign { .. }
                        | PatchOperation::XlsxCellFormat { .. }
                        | PatchOperation::XlsxRichTextSet { .. }
                        | PatchOperation::XlsxRichTextCreate { .. }
                        | PatchOperation::XlsxCellLayout { .. }
                        | PatchOperation::XlsxCellNumberFormat { .. }
                        | PatchOperation::XlsxCellSet { .. }
                        | PatchOperation::XlsxFormulaSet { .. }
                        | PatchOperation::XlsxFormulaToValue { .. }
                        | PatchOperation::XlsxFormulaToNumber { .. }
                        | PatchOperation::XlsxNumberSet { .. }
                        | PatchOperation::XlsxFormulaCreate { .. }
                        | PatchOperation::XlsxRowAppend { .. }
                        | PatchOperation::XlsxRowRemoveLast { .. }
                        | PatchOperation::XlsxColumnWidth { .. }
                        | PatchOperation::XlsxRowHeight { .. }
                        | PatchOperation::XlsxSheetRename { .. }
                        | PatchOperation::XlsxSheetAdd { .. }
                        | PatchOperation::XlsxSheetDelete { .. }
                        | PatchOperation::XlsxSheetFreeze { .. }
                        | PatchOperation::PptxSlideAdd { .. }
                        | PatchOperation::PptxSlideDelete { .. }
                        | PatchOperation::PptxSlideReorder { .. }
                        | PatchOperation::XlsxRowInsert { .. }
                        | PatchOperation::XlsxRowDelete { .. }
                        | PatchOperation::XlsxColumnInsert { .. }
                        | PatchOperation::XlsxColumnDelete { .. }
                        | PatchOperation::XlsxGridRange { .. }
                        | PatchOperation::XlsxMergeBlank { .. }
                        | PatchOperation::XlsxUnmerge { .. }
                )
            }))
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
    let fonts = collect_fonts(patch)?;
    let images = collect_image_changes(patch)?;
    let image_insertions = crate::image_insert::collect(patch);
    let mut flow_image_tail = None;
    if !image_insertions.is_empty()
        && matches!(manifest.source.format.as_str(), "docx" | "md" | "html")
    {
        for page in (0..manifest.index_page_count).rev() {
            if let Some(chunk) = bundle
                .read_index_page(&manifest, page)?
                .chunks
                .into_iter()
                .rev()
                .find(|chunk| chunk.region == "body")
            {
                flow_image_tail = Some(chunk.chunk_id);
                break;
            }
        }
        if flow_image_tail.is_none() {
            return Err(HcdError::Unsupported(
                "Flow document has no body chunk for image insertion".into(),
            ));
        }
    }
    let mut inserted_images = 0;
    let pdf_insertions = collect_pdf_insertions(patch);
    let pdf_geometry = collect_pdf_geometry(patch);
    let pdf_deletions = collect_pdf_deletions(patch);
    let pptx_insertions = collect_pptx_insertions(patch);
    let pptx_geometry = collect_pptx_geometry(patch);
    let pptx_deletions = collect_pptx_deletions(patch);
    let pptx_formats = collect_pptx_formats(patch);
    let pptx_aligns = collect_pptx_aligns(patch);
    let xlsx_formats = collect_xlsx_formats(patch);
    let mut rich_converted_formula_ids = HashSet::new();
    let xlsx_rich: HashMap<_, _> = patch
        .operations
        .iter()
        .filter_map(|op| match op {
            PatchOperation::XlsxRichTextSet {
                node_id,
                runs,
                precondition,
            } => Some((node_id.clone(), (runs, precondition))),
            _ => None,
        })
        .collect();
    let xlsx_layouts = collect_xlsx_layouts(patch);
    let xlsx_number_formats = collect_xlsx_number_formats(patch);
    let xlsx_merges = collect_xlsx_merges(patch);
    let xlsx_blank_merge = collect_xlsx_blank_merge(patch);
    let xlsx_unmerges = collect_xlsx_unmerges(patch);
    let xlsx_cell_set = collect_xlsx_cell_set(patch)?;
    let xlsx_formula = collect_xlsx_formula_set(patch)?;
    let shifted_grid = if !xlsx_cell_set.is_empty() || xlsx_blank_merge.is_some() {
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
    let xlsx_row_height = collect_xlsx_row_height(patch);
    let xlsx_sheet_freeze = collect_xlsx_sheet_freeze(patch);
    // A frozen band names the rows and columns that stand inside it, so a shift
    // that moves one through the band moves the band with it the way Excel keeps a
    // freeze covering the window it was set on.
    let xlsx_pane_band = xlsx_pane_band_move(
        xlsx_row_insert.as_ref(),
        xlsx_row_delete.as_ref(),
        xlsx_column_insert.as_ref(),
        xlsx_column_delete.as_ref(),
    );
    let xlsx_row_target = xlsx_row_append
        .as_ref()
        .map(|append| find_xlsx_row_tail(bundle, &manifest, append))
        .transpose()?;
    // A formula typed into the first empty row is still a cell creation. Extend
    // the current tail window in the same revision so the edit does not require
    // a separate row-append patch (and a second round trip from the editor).
    let mut xlsx_cell_row_extensions = HashMap::new();
    for insertion in xlsx_cell_set.values() {
        let (last_row, tail) = last_xlsx_row(bundle, &manifest, &insertion.sheet_id)?;
        if u64::from(insertion.row) == last_row + 1 {
            xlsx_cell_row_extensions.insert(tail, insertion.row);
        }
    }
    let xlsx_blank_merge_target = xlsx_blank_merge
        .as_ref()
        .map(|merge| find_xlsx_blank_merge_target(bundle, &manifest, merge))
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
    let xlsx_height_part = xlsx_row_height
        .as_ref()
        .map(|height| find_xlsx_sheet_part(bundle, &manifest, &height.sheet_id))
        .transpose()?;
    let xlsx_freeze_part = xlsx_sheet_freeze
        .as_ref()
        .map(|freeze| {
            find_xlsx_sheet_part(bundle, &manifest, &freeze.sheet_id).map_err(|error| match error {
                HcdError::Unsupported(_) => HcdError::Unsupported(
                    "XLSX freeze panes require a worksheet window with a known source part"
                        .to_string(),
                ),
                other => other,
            })
        })
        .transpose()?;
    let xlsx_sheet_rename = collect_xlsx_sheet_rename(patch)
        .as_ref()
        .map(|rename| resolve_xlsx_sheet_rename(bundle, &manifest, rename))
        .transpose()?;
    let xlsx_sheet_add = collect_xlsx_sheet_add(patch)
        .as_ref()
        .map(|name| resolve_xlsx_sheet_add(bundle, &manifest, name))
        .transpose()?;
    let xlsx_sheet_removal = collect_xlsx_sheet_removal(patch)
        .as_ref()
        .map(|removal| resolve_xlsx_sheet_removal(bundle, &manifest, removal))
        .transpose()?;
    let pptx_slide_add = collect_pptx_slide_add(patch)
        .then(|| resolve_pptx_slide_add(bundle, &manifest))
        .transpose()?;
    let pptx_slide_removal = collect_pptx_slide_removal(patch)
        .as_ref()
        .map(|removal| resolve_pptx_slide_removal(bundle, &manifest, removal))
        .transpose()?;
    let pptx_slide_reorder = collect_pptx_slide_reorder(patch)
        .as_ref()
        .map(|moving| resolve_pptx_slide_reorder(bundle, &manifest, moving))
        .transpose()?;
    let pptx_slide_copy = collect_pptx_slide_copy(patch)
        .as_ref()
        .map(|copy| resolve_pptx_slide_copy(bundle, &manifest, copy))
        .transpose()?;
    if pptx_slide_removal.is_some() && pptx_slide_reorder.is_some() {
        return Err(HcdError::InvalidPatch(
            "one patch moves or removes a slide, not both".to_string(),
        ));
    }
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
        .chain(fonts.keys().cloned())
        .chain(images.keys().cloned())
        .chain(xlsx_merges.keys().cloned())
        .chain(xlsx_unmerges.keys().cloned())
        .chain(xlsx_formula.keys().cloned())
        .chain(pptx_geometry.keys().cloned())
        .chain(pptx_deletions.keys().cloned())
        .chain(pptx_formats.keys().cloned())
        .chain(pptx_aligns.keys().cloned())
        .chain(xlsx_formats.keys().cloned())
        .chain(xlsx_rich.keys().cloned())
        .chain(xlsx_layouts.keys().cloned())
        .chain(xlsx_number_formats.keys().cloned())
        .chain(pdf_geometry.keys().cloned())
        .chain(pdf_deletions.keys().cloned())
        .chain(annotation_node_ids.iter().cloned())
        .collect();

    let new_revision = manifest.revision + 1;
    let new_index_prefix = format!("indexes/rev-{new_revision:020}");
    let new_index_root = bundle.root().join(&new_index_prefix);
    let content_changed = !splices.is_empty()
        || !styles.is_empty()
        || !fonts.is_empty()
        || !images.is_empty()
        || !image_insertions.is_empty()
        || !pdf_insertions.is_empty()
        || !pdf_geometry.is_empty()
        || !pdf_deletions.is_empty()
        || !pptx_insertions.is_empty()
        || !pptx_geometry.is_empty()
        || !pptx_deletions.is_empty()
        || !pptx_formats.is_empty()
        || !pptx_aligns.is_empty()
        || !xlsx_formats.is_empty()
        || !xlsx_rich.is_empty()
        || !xlsx_layouts.is_empty()
        || !xlsx_number_formats.is_empty()
        || !xlsx_merges.is_empty()
        || xlsx_blank_merge.is_some()
        || !xlsx_unmerges.is_empty()
        || !xlsx_cell_set.is_empty()
        || !xlsx_formula.is_empty()
        || xlsx_row_append.is_some()
        || xlsx_row_insert.is_some()
        || xlsx_row_delete.is_some()
        || xlsx_column_insert.is_some()
        || xlsx_column_delete.is_some()
        || xlsx_row_removal.is_some()
        || xlsx_column_width.is_some()
        || xlsx_row_height.is_some()
        || xlsx_sheet_freeze.is_some()
        || xlsx_sheet_rename.is_some()
        || xlsx_sheet_add.is_some()
        || xlsx_sheet_removal.is_some()
        || pptx_slide_add.is_some()
        || pptx_slide_removal.is_some()
        // A move rewrites the index the deck's page order lives in, without
        // touching a single chunk. A copy rewrites it with one page more.
        || pptx_slide_reorder.is_some()
        || pptx_slide_copy.is_some();
    let mut index_root_href = manifest.index_root_href.clone();
    if content_changed && index_root_href.is_none() {
        fs::create_dir_all(&new_index_root)?;
    }

    let mut found_nodes: HashMap<String, usize> = HashMap::new();
    let mut dirty_nodes = BTreeSet::new();
    let mut removed_nodes = BTreeSet::new();
    let mut dirty_chunks = BTreeSet::new();
    let mut dirty_parts = BTreeSet::new();
    let mut dirty_grid_parts = BTreeSet::new();
    let mut inserted_xlsx_cells = HashSet::new();
    let mut created_xlsx_blank_merge = false;
    let mut appended_xlsx_row = false;
    let mut inserted_xlsx_row = false;
    let mut deleted_xlsx_row = false;
    let mut removed_xlsx_node_ids = Vec::new();
    let mut inserted_xlsx_column = false;
    let mut deleted_xlsx_column = false;
    let mut removed_xlsx_column_node_ids = Vec::new();
    let mut removed_xlsx_row = false;
    let mut changed_xlsx_column = false;
    let mut changed_xlsx_row_height = false;
    // A freeze rewrites the pane every window of one worksheet carries, so both
    // counters add up across those windows: how many this patch read, and how
    // many of them it actually rewrote.
    let mut froze_xlsx_sheet_windows = 0usize;
    let mut froze_xlsx_sheet_reads = 0usize;
    let mut renamed_xlsx_sheet = false;
    // A worksheet removal takes whole chunks out of the index, so the patch
    // collects the chunks that survive instead of editing a page in place: the
    // hole renumbers every chunk behind it, which rewrites every page after it.
    let mut removed_xlsx_sheet = false;
    let mut dropped_sheet_chunks = 0usize;
    let mut removed_sheet_node_ids: Vec<String> = Vec::new();
    let mut kept_index_descriptors: Vec<crate::ChunkDescriptor> = Vec::new();
    let mut added_sheet_chunk = xlsx_sheet_add
        .as_ref()
        .map(|addition| mint_xlsx_sheet_chunk(bundle, &manifest, addition))
        .transpose()?;
    let mut added_xlsx_sheet = false;
    // A new slide is one page chunk appended after the last one, so it takes the
    // same tail-of-index write a new worksheet tab takes.
    let mut added_slide_chunk = pptx_slide_add
        .as_ref()
        .map(|addition| mint_pptx_slide_chunk(bundle, &manifest, addition))
        .transpose()?;
    let mut added_pptx_slide = false;
    // A deleted slide is the same hole in the index a deleted tab makes, so it
    // collects its survivors the same way: the page leaves, its text nodes leave
    // with it, and every chunk behind it moves up one sequence.
    let mut removed_pptx_slide = false;
    let mut dropped_slide_chunks = 0usize;
    let mut removed_slide_node_ids: Vec<String> = Vec::new();
    let mut appended_index_page: Option<crate::ChunkIndexPage> = None;
    let mut root_hasher = Sha256::new();
    let current_asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let mut asset_index = bundle.read_asset_index_for_revision(manifest.revision)?;
    let mut asset_by_hash: HashMap<String, AssetDescriptor> = asset_index
        .iter()
        .map(|asset| (asset.hash.clone(), asset.clone()))
        .collect();
    for hash in images
        .values()
        .filter_map(|change| change.asset_hash.as_deref())
        .chain(
            image_insertions
                .values()
                .flatten()
                .map(|insertion| insertion.asset_hash.as_str()),
        )
    {
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
            let slide_insertions = pptx_insertions.get(&descriptor.chunk_id);
            let inserted_visuals = image_insertions.get(&descriptor.chunk_id);
            let append_here = xlsx_row_target.as_deref() == Some(descriptor.chunk_id.as_str());
            let cell_row_extension = xlsx_cell_row_extensions.get(&descriptor.chunk_id).copied();
            let blank_merge_here =
                xlsx_blank_merge_target.as_deref() == Some(descriptor.chunk_id.as_str());
            let row_insert_here = xlsx_insert_target
                .as_ref()
                .is_some_and(|(chunk_id, _)| chunk_id == &descriptor.chunk_id);
            let row_shift_here = xlsx_row_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == insert.sheet_id
                        && grid.row_end.is_some_and(|end| {
                            end.saturating_add(1) >= u64::from(insert.before_row)
                        })
                })
            });
            let row_formula_here = xlsx_row_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == insert.sheet_id
                })
            });
            let visual_row_insert_here = xlsx_row_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind != crate::GridChunkKind::Cells && grid.sheet_id == insert.sheet_id
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
                            .is_some_and(|end| end.saturating_add(1) >= insert.before_column)
                })
            });
            let column_formula_here = xlsx_column_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == insert.sheet_id
                })
            });
            let visual_column_insert_here = xlsx_column_insert.as_ref().is_some_and(|insert| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind != crate::GridChunkKind::Cells && grid.sheet_id == insert.sheet_id
                })
            });
            let column_delete_here = xlsx_column_delete.as_ref().is_some_and(|delete| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == delete.sheet_id
                        && grid.column_end.is_some_and(|end| end >= delete.column)
                })
            });
            let visual_row_delete_here = xlsx_row_delete.as_ref().is_some_and(|delete| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind != crate::GridChunkKind::Cells
                        && grid.sheet_id == delete.sheet_id
                        && grid.row_end.is_some_and(|end| end >= u64::from(delete.row))
                })
            });
            let visual_column_delete_here = xlsx_column_delete.as_ref().is_some_and(|delete| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind != crate::GridChunkKind::Cells
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
            let height_here = xlsx_row_height.as_ref().filter(|height| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells
                        && grid.sheet_id == height.sheet_id
                        && grid
                            .row_start
                            .is_some_and(|start| u64::from(height.row) >= start)
                        && grid.row_end.is_some_and(|end| u64::from(height.row) <= end)
                })
            });
            let freeze_here = xlsx_sheet_freeze.as_ref().filter(|freeze| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == freeze.sheet_id
                })
            });
            // Every window of a shifted sheet is asked about its band, not only
            // the windows whose own rows or columns moved: the band is the sheet's
            // split and the export refuses a sheet whose windows disagree.
            let pane_band_here = xlsx_pane_band.as_ref().filter(|band| {
                descriptor.grid.as_ref().is_some_and(|grid| {
                    grid.kind == crate::GridChunkKind::Cells && grid.sheet_id == band.sheet_id
                })
            });
            let rename_here = xlsx_sheet_rename.as_ref().is_some_and(|rename| {
                descriptor
                    .grid
                    .as_ref()
                    .is_some_and(|grid| grid.sheet_id == rename.sheet_id)
            });
            let delete_here = xlsx_sheet_removal.as_ref().is_some_and(|removal| {
                descriptor
                    .grid
                    .as_ref()
                    .is_some_and(|grid| grid.sheet_id == removal.sheet_id)
            });
            if delete_here {
                // Every chunk of the deleted tab leaves the index, and the cells
                // it mapped leave with it. The rebuild behind this loop puts the
                // chunks that survive back on pages and renumbers them.
                for entry in bundle.read_map(descriptor)?.entries {
                    removed_sheet_node_ids.push(entry.node_id);
                }
                dirty_chunks.insert(descriptor.chunk_id.clone());
                dropped_sheet_chunks += 1;
                removed_xlsx_sheet = true;
                continue;
            }
            // A page can reach across more than one chunk when a table on it is
            // split, so the chunks to drop were worked up front, from the part
            // each section names, instead of matching only the one chunk id.
            let delete_slide_here = pptx_slide_removal
                .as_ref()
                .is_some_and(|removal| removal.dropped_chunk_ids.contains(&descriptor.chunk_id));
            if delete_slide_here {
                for entry in bundle.read_map(descriptor)?.entries {
                    removed_slide_node_ids.push(entry.node_id);
                }
                dirty_chunks.insert(descriptor.chunk_id.clone());
                dropped_slide_chunks += 1;
                removed_pptx_slide = true;
                continue;
            }
            let cell_insertions: Vec<&XlsxCellInsertion> = descriptor
                .grid
                .as_ref()
                .filter(|grid| grid.kind == crate::GridChunkKind::Cells)
                .and_then(|grid| {
                    let extension = cell_row_extension.unwrap_or(0);
                    let end = grid.row_end.unwrap_or(0).max(u64::from(extension));
                    // A window without row bounds is an empty worksheet. It only
                    // takes part in a patch when that patch creates its first row.
                    if end == 0 {
                        return None;
                    }
                    Some((
                        grid.sheet_id.clone(),
                        u32::try_from(grid.row_start.unwrap_or(1)).ok()?,
                        u32::try_from(end).ok()?,
                    ))
                })
                .map(|(sheet_id, start, end)| {
                    xlsx_cell_set
                        .range((sheet_id.clone(), start, 0)..=(sheet_id, end, 16_384))
                        .map(|(_, insertion)| insertion)
                        .collect()
                })
                .unwrap_or_default();
            let candidates: Vec<&String> = target_node_ids
                .iter()
                .filter(|node_id| node_bloom_might_contain(&descriptor.node_bloom, node_id))
                .collect();
            if candidates.is_empty()
                && insertions.is_none()
                && cell_insertions.is_empty()
                && slide_insertions.is_none()
                && inserted_visuals.is_none()
                && !blank_merge_here
                && !append_here
                && !row_shift_here
                && !row_formula_here
                && !visual_row_insert_here
                && !row_delete_here
                && !column_shift_here
                && !column_delete_here
                && !visual_row_delete_here
                && !visual_column_delete_here
                && !remove_here
                && width_here.is_none()
                && height_here.is_none()
                && freeze_here.is_none()
                && pane_band_here.is_none()
                // A rename can touch a formula in any worksheet, so every chunk
                // is inspected for references to the old tab name.
                && xlsx_sheet_rename.is_none()
                // A removal rebuilds the whole index, so every surviving chunk
                // has to be collected, not just the ones this patch edits. A
                // move rebuilds it too, with nothing taken out of it, and a copy
                // rebuilds it with the copied page spliced in.
                && xlsx_sheet_removal.is_none()
                && pptx_slide_removal.is_none()
                && pptx_slide_reorder.is_none()
                && pptx_slide_copy.is_none()
            {
                hash_descriptor(&mut root_hasher, descriptor);
                continue;
            }

            let mut source_map = bundle.read_map(descriptor)?;
            let mut html = bundle.read_chunk(descriptor)?;
            let mut html_nodes = extract_html_text_nodes(&html)?;
            let mut image_nodes = extract_html_image_nodes(&html)?;
            let mut chunk_changed = false;
            let mut deleted_here = Vec::new();
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
                    && (styles.contains_key(&entry.node_id)
                        || fonts.contains_key(&entry.node_id)
                        || splices.contains_key(&entry.node_id))
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
                let font_change = fonts.get(&entry.node_id);
                if let Some(change) = font_change {
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
                    let mut rich = crate::extract_docx_inline_runs(&html)?;
                    let mut grid_rich = crate::extract_xlsx_inline_runs(&html)?;
                    if let Some(mut runs) = grid_rich.remove(&entry.node_id) {
                        let mut ordered = node_splices.clone();
                        ordered.sort_by_key(|splice| splice.start);
                        for splice in ordered.into_iter().rev() {
                            runs = crate::splice_xlsx_inline_runs(
                                &runs,
                                splice.start,
                                splice.delete_count,
                                &splice.insert_text,
                            );
                        }
                        replace_node_content(
                            &mut html,
                            &entry.node_id,
                            &crate::render_xlsx_inline_runs(&runs)?,
                            &replacement_hash,
                        )?;
                    } else if let Some(mut runs) = rich.remove(&entry.node_id) {
                        let mut ordered = node_splices.clone();
                        ordered.sort_by_key(|splice| splice.start);
                        for splice in ordered.into_iter().rev() {
                            runs = crate::docx_inline::splice_docx_inline_runs(
                                &runs,
                                splice.start,
                                splice.delete_count,
                                &splice.insert_text,
                            );
                        }
                        replace_node_content(
                            &mut html,
                            &entry.node_id,
                            &crate::docx_inline::render_docx_inline_runs(&runs),
                            &replacement_hash,
                        )?;
                    } else {
                        replace_node_text(
                            &mut html,
                            &entry.node_id,
                            &replacement,
                            &replacement_hash,
                        )?;
                    }
                    if manifest.source.format == "xlsx" && entry.source.node_kind == "cell" {
                        set_xlsx_raw_value(&mut html, &entry.node_id, "")?;
                    }
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
                if let Some(change) = xlsx_formula.get(&entry.node_id) {
                    if entry.source.node_kind != "cell"
                        || descriptor.grid.as_ref().is_none_or(|grid| {
                            grid.kind != crate::GridChunkKind::Cells
                                || grid.sheet_id != change.sheet_id
                        })
                    {
                        return Err(HcdError::Unsupported(
                            "XLSX formula target is not a mapped cell in the requested sheet"
                                .to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "formula cell {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    let replacement = match &change.replacement {
                        XlsxFormulaReplacement::Formula(formula) => {
                            set_xlsx_formula(
                                &mut html,
                                &entry.node_id,
                                formula,
                                entry.source.editable,
                            )?;
                            entry.source.editable = false;
                            formula
                        }
                        XlsxFormulaReplacement::Value(text) => {
                            set_xlsx_formula_value(&mut html, &entry.node_id)?;
                            entry.source.editable = true;
                            text
                        }
                        XlsxFormulaReplacement::Number(value) => {
                            set_xlsx_formula_value(&mut html, &entry.node_id)?;
                            set_xlsx_raw_value(&mut html, &entry.node_id, value)?;
                            entry.source.editable = true;
                            value
                        }
                        XlsxFormulaReplacement::NumberUpdate(value) => {
                            if !entry.source.editable {
                                return Err(HcdError::Unsupported(
                                    "XLSX numeric target is not editable".to_string(),
                                ));
                            }
                            set_xlsx_raw_value(&mut html, &entry.node_id, value)?;
                            value
                        }
                    };
                    let replacement_hash = hash_bytes(replacement.as_bytes());
                    replace_node_content(
                        &mut html,
                        &entry.node_id,
                        &escape_text(replacement),
                        &replacement_hash,
                    )?;
                    entry.node_hash = replacement_hash;
                    found_nodes.insert(entry.node_id.clone(), replacement.chars().count());
                    html_nodes.insert(entry.node_id.clone(), replacement.clone());
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
                if let Some(change) = font_change {
                    match change.font {
                        Some(ref font) => apply_node_font(&mut html, &entry.node_id, font)?,
                        None => clear_node_font(&mut html, &entry.node_id)?,
                    }
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = pptx_geometry.get(&entry.node_id) {
                    if entry.source.node_kind != "slide-text" || !entry.source.editable {
                        return Err(HcdError::Unsupported(
                            "PPTX geometry requires an editable slide text shape".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PPTX text node {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_pptx_shape_geometry(&mut html, entry, change)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = pptx_formats.get(&entry.node_id) {
                    if !matches!(
                        entry.source.node_kind.as_str(),
                        "slide-text" | "table-cell-text"
                    ) || !entry.source.editable
                    {
                        return Err(HcdError::Unsupported(
                            "PPTX run formatting requires editable slide or table text".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PPTX text node {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_pptx_run_format(&mut html, entry, &change.format)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = pptx_aligns.get(&entry.node_id) {
                    // Alignment is a shape's, not a run's: the request lands on a
                    // text node because that is what the editor selects, and the
                    // shape that holds it is what moves.
                    if entry.source.node_kind != "slide-text" || !entry.source.editable {
                        return Err(HcdError::Unsupported(
                            "PPTX shape alignment requires an editable slide text node".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PPTX text node {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_pptx_shape_align(&mut html, &entry.node_id, &change.align)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some((runs, precondition)) = xlsx_rich.get(&entry.node_id) {
                    if entry.source.node_kind != "cell" {
                        return Err(HcdError::Unsupported(
                            "XLSX rich text requires an editable string cell".into(),
                        ));
                    }
                    if precondition.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(
                            "XLSX rich text cell has changed".into(),
                        ));
                    }
                    let marker_at = html
                        .find(&format!("data-hcd-id=\"{}\"", entry.node_id))
                        .ok_or_else(|| HcdError::InvalidBundle("missing XLSX rich cell".into()))?;
                    let cell_start = html[..marker_at].rfind("<td ").ok_or_else(|| {
                        HcdError::InvalidBundle("missing XLSX rich cell container".into())
                    })?;
                    let cell_end = html[cell_start..]
                        .find('>')
                        .map(|i| cell_start + i)
                        .ok_or_else(|| HcdError::InvalidBundle("unclosed XLSX rich cell".into()))?;
                    let tag = &html[cell_start..=cell_end];
                    let formula = xlsx_attribute(tag, "data-hcd-formula") == Some("true");
                    if !entry.source.editable
                        && (!formula
                            || xlsx_attribute(tag, "data-hcd-formula-editable") != Some("true"))
                    {
                        return Err(HcdError::Unsupported(
                            "XLSX rich text target is read-only".into(),
                        ));
                    }
                    if patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_50
                        && (formula
                            || xlsx_attribute(tag, "data-hcd-value-type")
                                .is_some_and(|kind| kind != "string")
                            || xlsx_attribute(tag, "data-hcd-raw-value")
                                .is_some_and(|value| !value.is_empty()))
                    {
                        return Err(HcdError::Unsupported(
                            "Convert a numeric or formula cell to text before rich-text editing"
                                .into(),
                        ));
                    }
                    if formula {
                        set_xlsx_formula_value(&mut html, &entry.node_id)?;
                        rich_converted_formula_ids.insert(entry.node_id.clone());
                    }
                    let replacement: String = runs.iter().map(|run| run.text.as_str()).collect();
                    let replacement_hash = hash_bytes(replacement.as_bytes());
                    replace_node_content(
                        &mut html,
                        &entry.node_id,
                        &crate::render_xlsx_inline_runs(runs)?,
                        &replacement_hash,
                    )?;
                    set_xlsx_raw_value(&mut html, &entry.node_id, "")?;
                    entry.source.editable = true;
                    entry.node_hash = replacement_hash;
                    found_nodes.insert(entry.node_id.clone(), replacement.chars().count());
                    html_nodes.insert(entry.node_id.clone(), replacement);
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = xlsx_formats.get(&entry.node_id) {
                    if entry.source.node_kind != "cell" {
                        return Err(HcdError::Unsupported(
                            "XLSX cell formatting requires a worksheet cell".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "XLSX cell {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    let rich_changed =
                        update_xlsx_cell_format(&mut html, &entry.node_id, &change.format)?;
                    if rich_changed {
                        dirty_nodes.insert(entry.node_id.clone());
                        dirty_parts.insert(entry.source.part.clone());
                    }
                    dirty_grid_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = xlsx_layouts.get(&entry.node_id) {
                    if entry.source.node_kind != "cell" {
                        return Err(HcdError::Unsupported(
                            "XLSX cell layout requires a worksheet cell".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "XLSX cell {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_xlsx_cell_layout(&mut html, &entry.node_id, &change.layout)?;
                    dirty_grid_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = xlsx_number_formats.get(&entry.node_id) {
                    if entry.source.node_kind != "cell" {
                        return Err(HcdError::Unsupported(
                            "XLSX number format requires a worksheet cell".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "XLSX cell {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_xlsx_cell_number_format(
                        &mut html,
                        &entry.node_id,
                        &change.number_format,
                    )?;
                    dirty_grid_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(expected_hash) = pptx_deletions.get(&entry.node_id) {
                    if entry.source.node_kind != "slide-text"
                        || !entry.source.editable
                        || !entry.source.created_in_hcd
                    {
                        return Err(HcdError::Unsupported(
                            "PPTX deletion requires an HCD-created text box".to_string(),
                        ));
                    }
                    if expected_hash != &entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PPTX text node {} expected hash {}, actual {}",
                            entry.node_id, expected_hash, entry.node_hash
                        )));
                    }
                    delete_pptx_text(&mut html, entry)?;
                    html_nodes.remove(&entry.node_id);
                    deleted_here.push(entry.node_id.clone());
                    removed_nodes.insert(entry.node_id.clone());
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(change) = pdf_geometry.get(&entry.node_id) {
                    if entry.source.node_kind != "pdf-text"
                        || !entry.source.editable
                        || !entry
                            .source
                            .paragraph_id
                            .as_deref()
                            .is_some_and(|path| path.contains("/hcd-text["))
                    {
                        return Err(HcdError::Unsupported(
                            "PDF geometry requires an HCD-created text box".to_string(),
                        ));
                    }
                    if change.node_hash != entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PDF text node {} expected hash {}, actual {}",
                            entry.node_id, change.node_hash, entry.node_hash
                        )));
                    }
                    update_pdf_text_geometry(&mut html, entry, change)?;
                    dirty_nodes.insert(entry.node_id.clone());
                    dirty_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
                if let Some(expected_hash) = pdf_deletions.get(&entry.node_id) {
                    if entry.source.node_kind != "pdf-text" || !entry.source.editable {
                        return Err(HcdError::Unsupported(
                            "PDF deletion requires an HCD-created text box".to_string(),
                        ));
                    }
                    if expected_hash != &entry.node_hash {
                        return Err(HcdError::PreconditionFailed(format!(
                            "PDF text node {} expected hash {}, actual {}",
                            entry.node_id, expected_hash, entry.node_hash
                        )));
                    }
                    delete_pdf_text(&mut html, entry)?;
                    html_nodes.remove(&entry.node_id);
                    deleted_here.push(entry.node_id.clone());
                    removed_nodes.insert(entry.node_id.clone());
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
                    dirty_grid_parts.insert(entry.source.part.clone());
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
                    // The XLSX importer rejects values and formulas in covered cells. The
                    // original window still supplies empty cell markup when splitting a merge;
                    // source-backed export retains any source-only cell formatting.
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
                    unmerge_xlsx_cells(&mut html, &initial_html, unmerge)?;
                    dirty_grid_parts.insert(entry.source.part.clone());
                    chunk_changed = true;
                }
            }

            if !deleted_here.is_empty() {
                source_map
                    .entries
                    .retain(|entry| !deleted_here.contains(&entry.node_id));
                descriptor.node_count = source_map.entries.len();
                descriptor.block_count = descriptor
                    .block_count
                    .checked_sub(deleted_here.len())
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("fixed-page block count underflow".to_string())
                    })?;
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
            if let Some(insertions) = inserted_visuals {
                if flow_image_tail
                    .as_ref()
                    .is_some_and(|tail| tail != &descriptor.chunk_id)
                {
                    return Err(HcdError::Unsupported("Flow-document image insertion appends to the document body end; target the last chunk in the body region to preserve native export placement".into()));
                }
                for insertion in insertions {
                    let asset = &asset_by_hash[&insertion.asset_hash];
                    let node = crate::image_insert::insert(
                        &mut html,
                        &mut source_map,
                        descriptor,
                        &manifest.source.format,
                        insertion,
                        asset,
                    )?;
                    dirty_nodes.insert(node);
                    dirty_parts.insert(source_map.entries.last().unwrap().source.part.clone());
                    inserted_images += 1;
                }
                descriptor.node_count += insertions.len();
                descriptor.block_count += insertions.len();
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
                chunk_changed = true;
            }
            if let Some(insertions) = slide_insertions {
                for insertion in insertions {
                    insert_pptx_text(&mut html, &mut source_map, insertion)?;
                    html_nodes.insert(insertion.node_id.clone(), insertion.text.clone());
                    dirty_nodes.insert(insertion.node_id.clone());
                    dirty_parts.insert(insertion.slide_part.clone());
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
            if !cell_insertions.is_empty() {
                if let Some(new_row) = cell_row_extension {
                    let old_row = new_row - 1;
                    let part = xlsx_chunk_sheet_part(descriptor, &source_map)?;
                    append_xlsx_row(&mut html, old_row)?;
                    let first_row = {
                        let grid = descriptor.grid.as_mut().expect("validated cell window");
                        let first_row = grid.row_start.is_none();
                        grid.row_start = Some(grid.row_start.unwrap_or(u64::from(new_row)));
                        grid.row_end = Some(u64::from(new_row));
                        first_row
                    };
                    // An empty window is already one block: its first row opens
                    // it instead of adding another.
                    if !first_row {
                        descriptor.block_count += 1;
                    }
                    dirty_grid_parts.insert(part);
                }
                for insertion in cell_insertions {
                    if !inserted_xlsx_cells.insert((
                        insertion.sheet_id.clone(),
                        insertion.row,
                        insertion.column,
                    )) {
                        return Err(HcdError::InvalidBundle(
                            "XLSX cell occurs in more than one cell window".to_string(),
                        ));
                    }
                    let (node_id, part) = insert_xlsx_cell(
                        &mut html,
                        &mut source_map,
                        descriptor
                            .grid
                            .as_ref()
                            .and_then(|grid| grid.sheet_part.as_deref()),
                        &manifest.document_id,
                        insertion,
                        shifted_grid.then_some(manifest.revision),
                    )?;
                    html_nodes.insert(node_id.clone(), insertion.text.clone());
                    descriptor.node_count += 1;
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
                    dirty_nodes.insert(node_id);
                    dirty_parts.insert(part);
                }
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
                chunk_changed = true;
            }
            if blank_merge_here {
                let merge = xlsx_blank_merge.as_ref().expect("resolved blank merge");
                let insertion = XlsxCellInsertion {
                    sheet_id: merge.sheet_id.clone(),
                    row: merge.start_row,
                    column: merge.start_column,
                    text: String::new(),
                    formula: false,
                    runs: None,
                };
                let (node_id, part) = insert_xlsx_cell(
                    &mut html,
                    &mut source_map,
                    descriptor
                        .grid
                        .as_ref()
                        .and_then(|grid| grid.sheet_part.as_deref()),
                    &manifest.document_id,
                    &insertion,
                    shifted_grid.then_some(manifest.revision),
                )?;
                merge_xlsx_cells(&mut html, merge)?;
                html_nodes.insert(node_id.clone(), String::new());
                descriptor.node_count += 1;
                if let Some(grid) = descriptor.grid.as_mut() {
                    grid.column_start = Some(
                        grid.column_start
                            .map_or(merge.start_column, |start| start.min(merge.start_column)),
                    );
                    grid.column_end = Some(
                        grid.column_end
                            .map_or(merge.end_column, |end| end.max(merge.end_column)),
                    );
                }
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
                dirty_nodes.insert(node_id);
                dirty_parts.insert(part.clone());
                dirty_grid_parts.insert(part);
                created_xlsx_blank_merge = true;
                chunk_changed = true;
            }
            if append_here {
                let append = xlsx_row_append
                    .as_ref()
                    .expect("target requires row append");
                let part = xlsx_chunk_sheet_part(descriptor, &source_map)?;
                append_xlsx_row(&mut html, append.after_row)?;
                let first_row = {
                    let grid = descriptor.grid.as_mut().expect("validated row target");
                    let first_row = grid.row_start.is_none();
                    grid.row_start = Some(grid.row_start.unwrap_or(1));
                    grid.row_end = Some(u64::from(append.after_row) + 1);
                    first_row
                };
                if !first_row {
                    descriptor.block_count += 1;
                }
                dirty_grid_parts.insert(part);
                appended_xlsx_row = true;
                chunk_changed = true;
            }
            if row_shift_here {
                let insert = xlsx_row_insert
                    .as_ref()
                    .expect("row shift requires insertion");
                for _ in 0..insert.count {
                    shift_xlsx_row_window(
                        &mut html,
                        &mut source_map,
                        descriptor,
                        insert.before_row,
                        row_insert_here,
                    )?;
                }
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
            if row_formula_here {
                let insert = xlsx_row_insert.as_ref().expect("row insertion exists");
                let original_html = html.clone();
                for _ in 0..insert.count {
                    rewrite_xlsx_inserted_formula_references(
                        &mut html,
                        crate::FormulaInsertion::Row(insert.before_row),
                    )?;
                }
                chunk_changed |= html != original_html;
            }
            if visual_row_insert_here {
                let insert = xlsx_row_insert.as_ref().expect("row insertion exists");
                let original_html = html.clone();
                for _ in 0..insert.count {
                    shift_xlsx_visual_anchor(
                        &mut html,
                        descriptor,
                        XlsxVisualShift::InsertRow(insert.before_row),
                    )?;
                }
                chunk_changed |= html != original_html;
            }
            if row_delete_here {
                let delete = xlsx_row_delete.as_ref().expect("row deletion exists");
                for _ in 0..delete.count {
                    if descriptor
                        .grid
                        .as_ref()
                        .and_then(|grid| grid.row_end)
                        .is_none_or(|end| end < u64::from(delete.row))
                    {
                        break;
                    }
                    removed_xlsx_node_ids.extend(delete_xlsx_row_window(
                        &mut html,
                        &mut source_map,
                        descriptor,
                        delete.row,
                    )?);
                }
                if xlsx_delete_target
                    .as_ref()
                    .is_some_and(|(_, chunk)| chunk == &descriptor.chunk_id)
                {
                    deleted_xlsx_row = true;
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
                for _ in 0..insert.count {
                    shift_xlsx_column_window(
                        &mut html,
                        &mut source_map,
                        descriptor,
                        insert.before_column,
                    )?;
                }
                dirty_grid_parts.insert(
                    xlsx_column_insert_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                );
                inserted_xlsx_column = true;
                chunk_changed = true;
            }
            if column_formula_here {
                let insert = xlsx_column_insert
                    .as_ref()
                    .expect("column insertion exists");
                let original_html = html.clone();
                for _ in 0..insert.count {
                    rewrite_xlsx_inserted_formula_references(
                        &mut html,
                        crate::FormulaInsertion::Column(insert.before_column),
                    )?;
                    shift_xlsx_column_widths(&mut html, insert.before_column)?;
                }
                chunk_changed |= html != original_html;
            }
            if visual_column_insert_here {
                let insert = xlsx_column_insert
                    .as_ref()
                    .expect("column insertion exists");
                let original_html = html.clone();
                for _ in 0..insert.count {
                    shift_xlsx_visual_anchor(
                        &mut html,
                        descriptor,
                        XlsxVisualShift::InsertColumn(insert.before_column),
                    )?;
                }
                chunk_changed |= html != original_html;
            }
            if column_delete_here {
                let delete = xlsx_column_delete.as_ref().expect("column deletion exists");
                for _ in 0..delete.count {
                    if descriptor
                        .grid
                        .as_ref()
                        .and_then(|grid| grid.column_end)
                        .is_none_or(|end| end < delete.column)
                    {
                        break;
                    }
                    removed_xlsx_column_node_ids.extend(delete_xlsx_column_window(
                        &mut html,
                        &mut source_map,
                        descriptor,
                        delete.column,
                    )?);
                }
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
            if visual_row_delete_here {
                let delete = xlsx_row_delete
                    .as_ref()
                    .expect("visual row deletion exists");
                for _ in 0..delete.count {
                    shift_xlsx_visual_anchor(
                        &mut html,
                        descriptor,
                        XlsxVisualShift::DeleteRow(delete.row),
                    )?;
                }
                chunk_changed = true;
            }
            if visual_column_delete_here {
                let delete = xlsx_column_delete
                    .as_ref()
                    .expect("visual column deletion exists");
                for _ in 0..delete.count {
                    shift_xlsx_visual_anchor(
                        &mut html,
                        descriptor,
                        XlsxVisualShift::DeleteColumn(delete.column),
                    )?;
                }
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
            if let Some(height) = height_here {
                set_xlsx_row_height(&mut html, height.row, height.height_points)?;
                dirty_grid_parts.insert(
                    xlsx_height_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                );
                changed_xlsx_row_height = true;
                chunk_changed = true;
            }
            if let Some(freeze) = freeze_here {
                let (rewritten, read) =
                    freeze_xlsx_sheet_sections(&mut html, freeze.rows, freeze.columns)?;
                froze_xlsx_sheet_windows += rewritten;
                froze_xlsx_sheet_reads += read;
                if rewritten > 0 {
                    dirty_grid_parts.insert(
                        xlsx_freeze_part
                            .as_ref()
                            .expect("resolved sheet part")
                            .clone(),
                    );
                    chunk_changed = true;
                }
            }
            if let Some(band) = pane_band_here {
                // The band each window keeps follows the rows and columns the
                // history moved through it, once per moved row or column. The
                // worksheet part this sheet lives in is already marked for a
                // rebuild by the shift itself, so a window that only its band
                // changed needs no part of its own.
                let mut moved = false;
                for _ in 0..band.count {
                    moved |= shift_xlsx_pane_band(&mut html, band.shift)?;
                }
                chunk_changed |= moved;
            }
            if let Some(rename) = xlsx_sheet_rename.as_ref() {
                let mut sheet_changed_here = rename_here;
                if rename_here {
                    rename_xlsx_sheet_sections(&mut html, &rename.old_name, &rename.new_name)?;
                    let grid = descriptor
                        .grid
                        .as_mut()
                        .expect("validated worksheet rename target");
                    grid.sheet_name = rename.new_name.clone();
                    renamed_xlsx_sheet = true;
                }
                if rename_xlsx_formula_references(&mut html, &rename.old_name, &rename.new_name)? {
                    sheet_changed_here = true;
                }
                chunk_changed |= sheet_changed_here;
            }
            if let Some(removal) = xlsx_sheet_removal.as_ref() {
                // A kept tab whose formula named the deleted tab breaks in the
                // stored expression too, so the bundle view matches the workbook.
                if drop_xlsx_formula_references(&mut html, &removal.name)? {
                    chunk_changed = true;
                }
                // And a tab behind the hole moves up one place in the section it
                // stores, the same way its descriptor does below.
                if shift_xlsx_sheet_sections(&mut html, removal.sheet_index)? {
                    chunk_changed = true;
                }
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
            if xlsx_sheet_removal.is_some()
                || pptx_slide_removal.is_some()
                || pptx_slide_reorder.is_some()
                || pptx_slide_copy.is_some()
            {
                kept_index_descriptors.push(descriptor.clone());
            }
            hash_descriptor(&mut root_hasher, descriptor);
        }

        if page_number + 1 == manifest.index_page_count {
            if let Some(new_chunk) = added_sheet_chunk.take() {
                dirty_chunks.insert(new_chunk.chunk_id.clone());
                added_xlsx_sheet = true;
                if page.chunks.len() < INDEX_PAGE_SIZE {
                    page.chunks.push(new_chunk);
                    hash_descriptor(
                        &mut root_hasher,
                        page.chunks.last().expect("appended worksheet chunk"),
                    );
                    page_changed = true;
                } else {
                    // The last page is already full, so the new window starts a
                    // page of its own once this one has been rewritten. It is
                    // still a descriptor of the document, so the root digest
                    // covers it exactly where the page loop left off.
                    hash_descriptor(&mut root_hasher, &new_chunk);
                    appended_index_page = Some(crate::ChunkIndexPage {
                        schema_version: manifest.schema_version.clone(),
                        revision: new_revision,
                        page: page_number + 1,
                        chunks: vec![new_chunk],
                    });
                }
            } else if let Some(new_chunk) = added_slide_chunk.take() {
                // A new page lands where a new tab lands: at the end of the last
                // index page, or on a page of its own once that one is full.
                dirty_chunks.insert(new_chunk.chunk_id.clone());
                added_pptx_slide = true;
                if page.chunks.len() < INDEX_PAGE_SIZE {
                    page.chunks.push(new_chunk);
                    hash_descriptor(
                        &mut root_hasher,
                        page.chunks.last().expect("appended slide chunk"),
                    );
                    page_changed = true;
                } else {
                    hash_descriptor(&mut root_hasher, &new_chunk);
                    appended_index_page = Some(crate::ChunkIndexPage {
                        schema_version: manifest.schema_version.clone(),
                        revision: new_revision,
                        page: page_number + 1,
                        chunks: vec![new_chunk],
                    });
                }
            }
        }

        // A removal rewrites the index from the chunks it left behind, a move
        // rewrites it from the chunks it put in a different order, and a copy
        // rewrites it with the copied page spliced in, so pages are not written
        // here while their lists still hold the old shape.
        if xlsx_sheet_removal.is_none()
            && pptx_slide_removal.is_none()
            && pptx_slide_reorder.is_none()
            && pptx_slide_copy.is_none()
            && content_changed
            && (index_root_href.is_none() || page_changed)
        {
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
    for insertion in pptx_insertions.values().flatten() {
        if !dirty_nodes.contains(&insertion.node_id) {
            return Err(HcdError::NodeNotFound(format!(
                "PPTX slide chunk for {}",
                insertion.slide_part
            )));
        }
    }
    for insertion in xlsx_cell_set.values() {
        if !inserted_xlsx_cells.contains(&(
            insertion.sheet_id.clone(),
            insertion.row,
            insertion.column,
        )) {
            return Err(HcdError::Unsupported(format!(
                "XLSX cell {}{} is outside an existing HCD cell window",
                xlsx_column_name(insertion.column),
                insertion.row
            )));
        }
    }
    if !removed_xlsx_node_ids.is_empty() {
        let part = &xlsx_delete_target
            .as_ref()
            .expect("resolved row deletion")
            .0;
        dirty_parts.insert(part.clone());
        for node_id in &removed_xlsx_node_ids {
            dirty_nodes.insert(node_id.clone());
            removed_nodes.insert(node_id.clone());
        }
    }
    if !removed_xlsx_column_node_ids.is_empty() {
        dirty_parts.insert(
            xlsx_column_delete_part
                .as_ref()
                .expect("resolved column deletion")
                .clone(),
        );
        for node_id in &removed_xlsx_column_node_ids {
            dirty_nodes.insert(node_id.clone());
            removed_nodes.insert(node_id.clone());
        }
    }
    if xlsx_row_append.is_some() && !appended_xlsx_row {
        return Err(HcdError::InvalidBundle(
            "XLSX row append target disappeared".to_string(),
        ));
    }
    if xlsx_blank_merge.is_some() && !created_xlsx_blank_merge {
        return Err(HcdError::InvalidBundle(
            "XLSX blank merge target disappeared".to_string(),
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
    if xlsx_row_height.is_some() && !changed_xlsx_row_height {
        return Err(HcdError::InvalidBundle(
            "XLSX row height target disappeared".to_string(),
        ));
    }
    // A pane request that rewrites nothing is not a silent success: either there
    // was no freeze to release, or the worksheet already stands at that split.
    if let Some(freeze) = xlsx_sheet_freeze.as_ref() {
        if froze_xlsx_sheet_windows == 0 {
            if froze_xlsx_sheet_reads == 0 {
                return Err(HcdError::InvalidBundle(
                    "XLSX worksheet freeze target disappeared".to_string(),
                ));
            }
            if freeze.rows == 0 && freeze.columns == 0 {
                return Err(HcdError::Unsupported(
                    "XLSX worksheet has no frozen panes to release".to_string(),
                ));
            }
            return Err(HcdError::Unsupported(format!(
                "XLSX worksheet already freezes {} rows and {} columns",
                freeze.rows, freeze.columns
            )));
        }
    }
    if xlsx_sheet_add.is_some() && !added_xlsx_sheet {
        return Err(HcdError::InvalidBundle(
            "XLSX worksheet addition had nowhere to write its window".to_string(),
        ));
    }
    if let Some(appended) = appended_index_page.as_ref() {
        let page_number = appended.page;
        if let Some(root) = index_root_href.as_ref() {
            index_root_href = Some(bundle.append_index_page(root, page_number, appended)?);
        } else {
            crate::bundle::atomic_write_json_encoded(
                &new_index_root.join(format!(
                    "{page_number:06}.json{}",
                    manifest.storage_codec.suffix()
                )),
                appended,
            )?;
        }
        manifest.index_page_count += 1;
    }
    if pptx_slide_add.is_some() && !added_pptx_slide {
        return Err(HcdError::InvalidBundle(
            "PPTX slide addition had nowhere to write its page".to_string(),
        ));
    }
    if added_xlsx_sheet || added_pptx_slide {
        manifest.chunk_count += 1;
    }
    if xlsx_sheet_rename.is_some() && !renamed_xlsx_sheet {
        return Err(HcdError::InvalidBundle(
            "XLSX worksheet rename target disappeared".to_string(),
        ));
    }
    // A slide leaves the index the way a tab does, so one rebuild serves both and
    // reports the kind it is closing. A patch carries a single operation, so it
    // never asks for both at once; asking is refused rather than guessed at.
    let index_removal = match (
        xlsx_sheet_removal.as_ref().map(|removal| IndexRemoval {
            label: "XLSX worksheet",
            target_found: removed_xlsx_sheet,
            dropped_chunks: dropped_sheet_chunks,
            source_part: removal.sheet_part.clone(),
            node_ids: std::mem::take(&mut removed_sheet_node_ids),
            shift_above: Some(removal.sheet_index),
        }),
        pptx_slide_removal.as_ref().map(|removal| IndexRemoval {
            label: "PPTX slide",
            target_found: removed_pptx_slide,
            dropped_chunks: dropped_slide_chunks,
            source_part: removal.slide_part.clone(),
            node_ids: std::mem::take(&mut removed_slide_node_ids),
            shift_above: None,
        }),
    ) {
        (Some(sheet), None) => Some(sheet),
        (None, slide) => slide,
        (Some(_), Some(_)) => {
            return Err(HcdError::InvalidPatch(
                "one patch removes either a worksheet or a slide, not both".to_string(),
            ))
        }
    };
    if let Some(removal) = index_removal.as_ref() {
        if !removal.target_found {
            return Err(HcdError::InvalidBundle(format!(
                "{} deletion target disappeared",
                removal.label
            )));
        }
        if kept_index_descriptors.len() + removal.dropped_chunks != manifest.chunk_count {
            return Err(HcdError::InvalidBundle(format!(
                "index pages cover {} chunks, manifest says {}",
                kept_index_descriptors.len() + removal.dropped_chunks,
                manifest.chunk_count
            )));
        }
        // The tab is gone from the package as well as from the index, and its
        // cells are gone with it, so the revision records them as removed nodes.
        for node_id in &removal.node_ids {
            dirty_nodes.insert(node_id.clone());
            removed_nodes.insert(node_id.clone());
        }
        // Naming the source part belongs to that node set: a tab nobody typed into
        // leaves no cell behind, and a revision whose nodes changed must name the
        // parts that held them, so an empty tab keeps both sets empty.
        if !removal.node_ids.is_empty() {
            dirty_parts.insert(removal.source_part.clone());
        }
        // Chunks behind the hole move up one slot each, so every one of them is
        // renumbered and lands on a different page.
        root_hasher = rewrite_index_pages(
            bundle,
            &mut manifest,
            &new_index_root,
            new_revision,
            std::mem::take(&mut kept_index_descriptors),
            removal.shift_above,
            &mut index_root_href,
        )?;
    }

    // A move puts two pages in each other's place and rewrites nothing else: a
    // page says the same thing wherever it stands, so only the index — which is
    // where the deck's order lives — has to change. The two pages swap the runs
    // their chunks form, and every chunk is numbered again from the front the
    // way a deletion numbers the chunks that survive it.
    if let Some(moving) = pptx_slide_reorder.as_ref() {
        let swapped = swap_pptx_slide_pages(
            &kept_index_descriptors,
            &moving.moving_chunk_ids,
            &moving.passed_chunk_ids,
        )?;
        // Only the chunks that ended up somewhere else are dirty. Which ones
        // those are is a fact about the list this revision writes, so it is read
        // off the list rather than assumed from the two pages the patch named.
        for (position, descriptor) in swapped.iter().enumerate() {
            if position != descriptor.sequence {
                dirty_chunks.insert(descriptor.chunk_id.clone());
            }
        }
        if dirty_chunks.is_empty() {
            return Err(HcdError::InvalidBundle(
                "PPTX slide reorder moved no chunk".to_string(),
            ));
        }
        root_hasher = rewrite_index_pages(
            bundle,
            &mut manifest,
            &new_index_root,
            new_revision,
            swapped,
            None,
            &mut index_root_href,
        )?;
    }

    // A copy gives the deck one more page, standing right behind the page it came
    // from. The chunks it is made of are new objects carrying new ids: nothing
    // that already stands in the index is rewritten, so the copy is spliced into
    // the list the index keeps and every chunk is numbered again from the front
    // the way a move numbers the list it put in a different order.
    if let Some(copy) = pptx_slide_copy.as_ref() {
        let cloned = clone_pptx_slide_chunks(bundle, &manifest, copy, &kept_index_descriptors)?;
        let copied_count = cloned.len();
        let Some(last_of_page) = copy.page_chunk_ids.last() else {
            return Err(HcdError::InvalidBundle(
                "PPTX slide copy found a page with no chunks".to_string(),
            ));
        };
        let Some(at) = kept_index_descriptors
            .iter()
            .position(|descriptor| &descriptor.chunk_id == last_of_page)
        else {
            return Err(HcdError::InvalidBundle(
                "PPTX slide copy target disappeared from the index".to_string(),
            ));
        };
        for (offset, descriptor) in cloned.into_iter().enumerate() {
            dirty_chunks.insert(descriptor.chunk_id.clone());
            kept_index_descriptors.insert(at + 1 + offset, descriptor);
        }
        if kept_index_descriptors.len() != manifest.chunk_count + copied_count {
            return Err(HcdError::InvalidBundle(format!(
                "index pages cover {} chunks, manifest says {} with {} copied",
                kept_index_descriptors.len(),
                manifest.chunk_count + copied_count,
                copied_count,
            )));
        }
        root_hasher = rewrite_index_pages(
            bundle,
            &mut manifest,
            &new_index_root,
            new_revision,
            std::mem::take(&mut kept_index_descriptors),
            None,
            &mut index_root_href,
        )?;
    }

    if inserted_images != image_insertions.values().map(Vec::len).sum::<usize>() {
        return Err(HcdError::InvalidPatch(
            "image.insert target chunk was not found".into(),
        ));
    }
    validate_annotation_ranges(patch, &found_nodes)?;
    let (annotation_href, annotation_root_hash) =
        apply_annotations(bundle, &manifest, patch, &removed_nodes)?;
    let root_hash = if content_changed {
        finalize_root_hash(
            bundle,
            root_hasher,
            &asset_index_href,
            &manifest.styles_href,
        )?
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
            // A clear leaves nothing behind for a source-backed export to refuse,
            // so only the pins are reported.
            .chain(fonts.iter().filter_map(|(node_id, change)| {
                change.font.is_some().then_some(node_id)
            }).map(|node_id| FidelityWarning {
                code: "HCD_FONT_PATCH_SEMANTIC_EXPORT".to_string(),
                message: "text.font is canonical in HCD HTML and applied by the pure-Rust semantic export and preview; source-backed Office/PDF export rejects revisions carrying it instead of silently dropping the face".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
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
            .chain(xlsx_formula.keys().map(|node_id| FidelityWarning {
                code: "XLSX_FORMULA_RECALC_REQUIRED".to_string(),
                message: "HCD displays the edited formula expression; source-backed XLSX clears its cached value so Excel recalculates the result when opened".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(pdf_insertions.values().flatten().map(|insertion| FidelityWarning {
                code: "PDF_INSERTED_TEXT_OVERLAY".to_string(),
                message: "new PDF text is positioned over the original page raster; background and typography remain approximate".to_string(),
                node_id: Some(insertion.node_id.clone()),
                source_part: Some(format!("pdf/pages/{}", insertion.page)),
            }))
            .chain(pptx_insertions.values().flatten().map(|insertion| FidelityWarning {
                code: "PPTX_INSERTED_EDITABLE_TEXT_SHAPE".to_string(),
                message: "new slide text box is editable and exported as a native PowerPoint shape; font fallback may differ from the source theme".to_string(),
                node_id: Some(insertion.node_id.clone()),
                source_part: Some(insertion.slide_part.clone()),
            }))
            .chain(pptx_formats.keys().map(|node_id| FidelityWarning {
                code: "PPTX_DIRECT_RUN_FORMAT".to_string(),
                message: "slide run formatting writes direct bold, italic, underline, size, and sRGB color; theme colors, fonts, and spacing stay on the source run".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(pptx_aligns.keys().map(|node_id| FidelityWarning {
                code: "PPTX_DIRECT_SHAPE_ALIGN".to_string(),
                message: "slide shape alignment writes a:pPr@algn on every paragraph of the shape and a:bodyPr@anchor on its text body; indents, spacing, and autofit stay on the source shape".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(xlsx_formats.keys().map(|node_id| FidelityWarning {
                code: "XLSX_DIRECT_CELL_FORMAT".to_string(),
                message: "cell formatting clones the source style and writes direct bold, italic, underline, size, sRGB font color, and solid fill; borders and number formats stay on the source style".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(xlsx_layouts.keys().map(|node_id| FidelityWarning {
                code: "XLSX_DIRECT_CELL_LAYOUT".to_string(),
                message: "cell layout clones the source style and writes horizontal alignment, vertical alignment, wrap, and a thin or cleared border; number formats stay on the source style".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .chain(xlsx_sheet_add.iter().map(|addition| FidelityWarning {
                code: "XLSX_WORKSHEET_ADDED".to_string(),
                message: "new worksheet tab is blank in HCD; source-backed export writes it as a worksheet part the source workbook never had".to_string(),
                node_id: None,
                source_part: Some(addition.sheet_part.clone()),
            }))
            .chain(xlsx_sheet_removal.iter().map(|removal| FidelityWarning {
                code: "XLSX_WORKSHEET_REMOVED".to_string(),
                message: "worksheet tab is deleted: its cells leave the document, formulas that named it read #REF!, and source-backed export drops the worksheet part with the workbook entry that pointed at it".to_string(),
                node_id: None,
                source_part: Some(removal.sheet_part.clone()),
            }))
            .chain(pptx_slide_add.iter().map(|addition| FidelityWarning {
                code: "PPTX_SLIDE_ADDED".to_string(),
                message: "new slide is blank in HCD; source-backed export writes it as a slide part the source package never had, on the layout the last existing slide uses".to_string(),
                node_id: None,
                source_part: Some(addition.slide_part.clone()),
            }))
            .chain(pptx_slide_removal.iter().map(|removal| FidelityWarning {
                code: "PPTX_SLIDE_REMOVED".to_string(),
                message: "slide is deleted: its shapes and text leave the document, and source-backed export drops the slide part with the page entry, relationship and content type that pointed at it".to_string(),
                node_id: None,
                source_part: Some(removal.slide_part.clone()),
            }))
            .chain(pptx_slide_reorder.iter().map(|moving| FidelityWarning {
                code: "PPTX_SLIDE_MOVED".to_string(),
                message: "slide is moved: the order the index holds its pages in is what a source-backed export writes into the presentation's slide list, and the page's own content is untouched".to_string(),
                node_id: None,
                source_part: Some(moving.slide_part.clone()),
            }))
            .chain(pptx_slide_copy.iter().map(|copy| FidelityWarning {
                code: "PPTX_SLIDE_COPIED".to_string(),
                message: "slide is duplicated: the copy stands right behind the page it came from, holds the same content under ids of its own, and is written as a slide part the source package never had".to_string(),
                node_id: None,
                source_part: Some(copy.new_slide_part.clone()),
            }))
            .chain(xlsx_number_formats.keys().map(|node_id| FidelityWarning {
                code: "XLSX_DIRECT_CELL_NUMBER_FORMAT".to_string(),
                message: "cell number format clones the source style and writes a built-in or custom Excel format code".to_string(),
                node_id: Some(node_id.clone()),
                source_part: None,
            }))
            .collect(),
        idempotent_replay: false,
    };
    let record = RevisionRecord {
        canvas_rewrite: None,
        schema_version: manifest.schema_version.clone(),
        document_id: manifest.document_id.clone(),
        revision: new_revision,
        parent_revision: Some(new_revision - 1),
        patch_id: Some(patch.patch_id.clone()),
        patch_hash: Some(patch_hash),
        patch_base_revision: Some(patch.base_revision),
        author_id: None,
        author_name: None,
        theme_revision_id: manifest.theme_revision_id.clone(),
        root_hash,
        annotation_root_hash,
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href,
        styles_href: manifest.styles_href.clone(),
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: result.dirty_node_ids.clone(),
        removed_node_ids: removed_nodes.into_iter().collect(),
        dirty_chunk_ids: result.dirty_chunk_ids.clone(),
        dirty_source_parts: result.dirty_source_parts.clone(),
        dirty_grid_parts: dirty_grid_parts.into_iter().collect(),
        converted_formula_node_ids: patch
            .operations
            .iter()
            .filter_map(|operation| {
                if let PatchOperation::XlsxFormulaToValue { node_id, .. }
                | PatchOperation::XlsxFormulaToNumber { node_id, .. } = operation
                {
                    Some(node_id.clone())
                } else {
                    None
                }
            })
            .chain(rich_converted_formula_ids)
            .collect(),
        grid_row_insertions: xlsx_row_insert
            .as_ref()
            .into_iter()
            .flat_map(|insert| {
                (0..insert.count).map(|_| GridRowInsertion {
                    sheet_part: xlsx_insert_target
                        .as_ref()
                        .expect("resolved sheet part")
                        .1
                        .clone(),
                    before_row: insert.before_row,
                })
            })
            .collect(),
        grid_row_deletions: xlsx_row_delete
            .as_ref()
            .into_iter()
            .flat_map(|delete| {
                (0..delete.count).map(|index| GridRowDeletion {
                    sheet_part: xlsx_delete_target
                        .as_ref()
                        .expect("resolved sheet part")
                        .0
                        .clone(),
                    row: delete.row,
                    removed_node_ids: if index == 0 {
                        removed_xlsx_node_ids.clone()
                    } else {
                        Vec::new()
                    },
                })
            })
            .collect(),
        grid_column_insertions: xlsx_column_insert
            .as_ref()
            .into_iter()
            .flat_map(|insert| {
                (0..insert.count).map(|_| GridColumnInsertion {
                    sheet_part: xlsx_column_insert_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                    before_column: insert.before_column,
                })
            })
            .collect(),
        grid_column_deletions: xlsx_column_delete
            .as_ref()
            .into_iter()
            .flat_map(|delete| {
                (0..delete.count).map(|index| GridColumnDeletion {
                    sheet_part: xlsx_column_delete_part
                        .as_ref()
                        .expect("resolved sheet part")
                        .clone(),
                    column: delete.column,
                    removed_node_ids: if index == 0 {
                        removed_xlsx_column_node_ids.clone()
                    } else {
                        Vec::new()
                    },
                })
            })
            .collect(),
        sheet_renames: xlsx_sheet_rename
            .as_ref()
            .into_iter()
            .map(|rename| SheetRename {
                sheet_part: rename.sheet_part.clone(),
                old_name: rename.old_name.clone(),
                new_name: rename.new_name.clone(),
            })
            .collect(),
        sheet_additions: xlsx_sheet_add
            .as_ref()
            .into_iter()
            .map(|addition| SheetAddition {
                sheet_part: addition.sheet_part.clone(),
                sheet_index: addition.sheet_index,
            })
            .collect(),
        sheet_removals: xlsx_sheet_removal
            .as_ref()
            .into_iter()
            .map(|removal| SheetRemoval {
                sheet_part: removal.sheet_part.clone(),
                name: removal.name.clone(),
            })
            .collect(),
        slide_additions: pptx_slide_add
            .as_ref()
            .into_iter()
            .map(|addition| SlideAddition {
                slide_part: addition.slide_part.clone(),
            })
            .collect(),
        slide_removals: pptx_slide_removal
            .as_ref()
            .into_iter()
            .map(|removal| SlideRemoval {
                slide_part: removal.slide_part.clone(),
            })
            .collect(),
        slide_reorders: pptx_slide_reorder
            .as_ref()
            .into_iter()
            .map(|moving| SlideReorder {
                slide_part: moving.slide_part.clone(),
            })
            .collect(),
        slide_copies: pptx_slide_copy
            .as_ref()
            .into_iter()
            .map(|copy| SlideCopy {
                slide_part: copy.new_slide_part.clone(),
                source_slide_part: copy.slide_part.clone(),
            })
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
    let mut xlsx_runs = None;

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
            if manifest.source.format == "xlsx" && entry.source.node_kind == "cell" {
                xlsx_runs = crate::extract_xlsx_inline_runs(&html)?.remove(node_id);
            }
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
        xlsx_runs,
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

fn drop_tag_attribute(tag: &mut String, name: &str) -> Result<(), HcdError> {
    let marker = format!(" {name}=\"");
    let Some(start) = tag.find(&marker) else {
        return Ok(());
    };
    let value_start = start + marker.len();
    let value_end = tag[value_start..]
        .find('"')
        .ok_or_else(|| HcdError::InvalidBundle(format!("attribute {name} is not closed")))?;
    tag.replace_range(start..value_start + value_end + 1, "");
    Ok(())
}

/// One character of the lowercase hex a node id is made of.
fn is_node_id_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn unescape_attribute(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn set_tag_attribute(tag: &mut String, name: &str, value: &str) {
    let marker = format!(" {name}=\"");
    let escaped = escape_attribute(value);
    if let Some(start) = tag.find(&marker) {
        let value_start = start + marker.len();
        if let Some(end) = tag[value_start..].find('"') {
            tag.replace_range(value_start..value_start + end, &escaped);
            return;
        }
    }
    let insertion = tag.len().saturating_sub(1);
    tag.insert_str(insertion, &format!(" {name}=\"{escaped}\""));
}

fn matching_html_close(html: &str, open_end: usize, name: &str) -> Result<usize, HcdError> {
    let open_token = format!("<{name}");
    let close_token = format!("</{name}>");
    let mut depth = 1usize;
    let mut cursor = open_end + 1;
    while cursor < html.len() {
        let next_open = html[cursor..]
            .find(&open_token)
            .map(|offset| cursor + offset);
        let next_close = html[cursor..]
            .find(&close_token)
            .map(|offset| cursor + offset);
        match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                cursor = open + open_token.len();
            }
            (_, Some(close)) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(close);
                }
                cursor = close + close_token.len();
            }
            _ => break,
        }
    }
    Err(HcdError::InvalidBundle(
        "PPTX run element is not closed".to_string(),
    ))
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

fn collect_fonts(patch: &PatchBatch) -> Result<BTreeMap<String, FontChange>, HcdError> {
    let mut fonts = BTreeMap::new();
    for operation in &patch.operations {
        // One node gets one font outcome per patch: pinning and clearing the same
        // node in a single revision would leave the last write to decide.
        let (node_id, font, node_hash) = match operation {
            PatchOperation::TextFont {
                node_id,
                font,
                precondition,
            } => (node_id, Some(font.clone()), precondition.node_hash.clone()),
            PatchOperation::TextFontClear {
                node_id,
                precondition,
            } => (node_id, None, precondition.node_hash.clone()),
            _ => continue,
        };
        if fonts
            .insert(node_id.clone(), FontChange { font, node_hash })
            .is_some()
        {
            return Err(HcdError::InvalidPatch(format!(
                "patch contains more than one text.font operation for {node_id}"
            )));
        }
    }
    Ok(fonts)
}

/// A font family token written into an inline style or a `data-hcd-font*`
/// attribute. It must be non-empty, bounded, and free of the characters that
/// would break the surrounding HTML attribute or CSS declaration (quotes,
/// semicolons, colons, angle brackets, ampersands, and control characters), so a
/// malicious family name cannot inject markup or extra CSS.
fn safe_font_family(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    if trimmed.contains(['<', '>', '"', '\'', ';', ':', '&'])
        || trimmed.chars().any(|character| character.is_control())
    {
        return None;
    }
    Some(trimmed)
}

pub(crate) fn validate_font_patch(font: &crate::FontPatch) -> Result<(), HcdError> {
    let mut provided = 0;
    for (slot, value) in [
        ("latin", font.latin.as_deref()),
        ("eastAsia", font.east_asia.as_deref()),
        ("bidi", font.bidi.as_deref()),
    ] {
        let Some(value) = value else { continue };
        provided += 1;
        if safe_font_family(value).is_none() {
            return Err(HcdError::InvalidPatch(format!(
                "text.font {slot} family is empty, too long, or contains a forbidden character"
            )));
        }
    }
    if provided == 0 {
        return Err(HcdError::InvalidPatch(
            "text.font must set at least one of latin, eastAsia, or bidi".to_string(),
        ));
    }
    Ok(())
}

/// The presentation a pinned face writes onto an element: the inline CSS and the
/// `data-hcd-font*` attributes, in a fixed order.
///
/// `text.font` uses it to rewrite an existing node, and the editor block model
/// uses it when it renders a block that carries a face, so the two cannot drift
/// apart. The export paths read these attributes, so a face set in the model is
/// indistinguishable from one set by a patch.
pub(crate) struct FontPresentation {
    pub(crate) css: BTreeMap<String, String>,
    pub(crate) attributes: Vec<(&'static str, String)>,
}

pub(crate) fn font_presentation(font: &crate::FontPatch) -> Result<FontPresentation, HcdError> {
    // latin (falling back to eastAsia then bidi) is the primary face for the
    // node's inline style; every provided slot is also recorded in its
    // data-hcd-font* attribute so source and semantic round-trips can recover
    // script-specific faces.
    let primary = [
        font.latin.as_deref(),
        font.east_asia.as_deref(),
        font.bidi.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(safe_font_family);
    let Some(primary) = primary else {
        return Err(HcdError::InvalidPatch(
            "text.font has no usable family".to_string(),
        ));
    };

    let mut css = BTreeMap::new();
    css.insert("font-family".to_string(), format!("'{primary}'"));
    let mut attributes = vec![("data-hcd-font", primary.to_string())];
    if let Some(latin) = font.latin.as_deref().and_then(safe_font_family) {
        attributes.push(("data-hcd-font-latin", latin.to_string()));
    }
    if let Some(east_asia) = font.east_asia.as_deref().and_then(safe_font_family) {
        attributes.push(("data-hcd-font-east-asia", east_asia.to_string()));
    }
    if let Some(bidi) = font.bidi.as_deref().and_then(safe_font_family) {
        attributes.push(("data-hcd-font-bidi", bidi.to_string()));
    }
    attributes.push(("data-hcd-font-patched", "true".to_string()));
    let presentation = FontPresentation { css, attributes };
    // The check `update_start_tag_style` runs before it writes a style, so the
    // block renderer cannot write a declaration the patch layer would refuse.
    crate::html::validate_inline_style(&presentation.style_value())?;
    Ok(presentation)
}

impl FontPresentation {
    /// The inline `style` value this presentation writes, serialized exactly as
    /// `update_start_tag_style` would for an element with no other declarations,
    /// so a rendered block and a patched node carry the same CSS.
    fn style_value(&self) -> String {
        self.css
            .iter()
            .map(|(property, value)| format!("{property}:{value}"))
            .collect::<Vec<_>>()
            .join(";")
    }

    /// The attributes of this presentation as they would appear inside a fresh
    /// start tag: the style first, then each `data-hcd-font*`, in the order
    /// `apply_node_font` leaves them on a patched node, with the same escaping.
    /// The editor block renderer uses this so a block font and a pinned run font
    /// are written identically.
    pub(crate) fn attribute_text(&self) -> String {
        let mut text = String::new();
        if !self.css.is_empty() {
            text.push_str(&format!(" style=\"{}\"", self.style_value()));
        }
        for (name, value) in &self.attributes {
            text.push_str(&format!(" {name}=\"{}\"", escape_attribute(value)));
        }
        text
    }
}

fn apply_node_font(
    html: &mut String,
    node_id: &str,
    font: &crate::FontPatch,
) -> Result<(), HcdError> {
    let canonical_marker = format!("data-hcd-id=\"{}\"", escape_attribute(node_id));
    let presentation = font_presentation(font)?;
    // mark_patched is false so a font change is distinguishable from a
    // node.style presentation change (which sets data-hcd-style-patched).
    update_start_tag_style(html, &canonical_marker, &presentation.css, false)?;
    // set_element_attribute escapes internally and inserts the attribute when it
    // is absent, so re-applying the same font is idempotent.
    for (name, value) in presentation.attributes {
        set_element_attribute(html, node_id, name, &value)?;
    }
    Ok(())
}

/// Removes the pin a `text.font` operation wrote: the `font-family` declaration it
/// put in the style, the `data-hcd-font*` slots, and the `data-hcd-font-patched`
/// marker, so preview, read-back, and every export stop seeing a pin at all.
/// Declarations the node owned before the pin stay, except a `font-family` the
/// imported HTML carried and this pin replaced: the patch keeps no journal of the
/// value it overwrote, so clearing drops it too and the node falls back to the
/// style sheet or theme, which is what a clear is for. A node without the marker is
/// refused, which is what keeps a face that came from the source document (it
/// carries `data-hcd-font*` without the marker) out of reach.
fn clear_node_font(html: &mut String, node_id: &str) -> Result<(), HcdError> {
    let (start, end) = element_start_tag_range(html, node_id)?;
    let tag = &html[start..=end];
    if !tag.contains(" data-hcd-font-patched=\"true\"") {
        return Err(HcdError::InvalidPatch(format!(
            "node {node_id} carries no text.font pin to clear"
        )));
    }
    let mut replacement = tag.to_string();
    drop_style_property(&mut replacement, "font-family")?;
    for name in [
        "data-hcd-font",
        "data-hcd-font-latin",
        "data-hcd-font-east-asia",
        "data-hcd-font-bidi",
        "data-hcd-font-patched",
    ] {
        remove_attribute(&mut replacement, name);
    }
    html.replace_range(start..=end, &replacement);
    Ok(())
}

/// Drops one attribute from a start tag, leaving the tag itself alone.
fn remove_attribute(tag: &mut String, name: &str) {
    let marker = format!(" {name}=\"");
    let Some(start) = tag.find(&marker) else {
        return;
    };
    let value_start = start + marker.len();
    let Some(offset) = tag[value_start..].find('"') else {
        return;
    };
    tag.replace_range(start..value_start + offset + 1, "");
}

/// Drops one declaration from the tag's `style` attribute, taking the attribute
/// with it once nothing is left. The rest is rebuilt the way
/// `update_start_tag_style` writes it — sorted, lower-cased properties — so
/// clearing a font cannot restyle or reorder the declarations that stay.
fn drop_style_property(tag: &mut String, property: &str) -> Result<(), HcdError> {
    let marker = " style=\"";
    let Some(start) = tag.find(marker) else {
        return Ok(());
    };
    let value_start = start + marker.len();
    let Some(offset) = tag[value_start..].find('"') else {
        return Err(HcdError::InvalidBundle(
            "style attribute is not closed".to_string(),
        ));
    };
    let value_end = value_start + offset;
    let mut declarations = BTreeMap::new();
    for declaration in tag[value_start..value_end].split(';') {
        let Some((name, value)) = declaration.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if name == property {
            continue;
        }
        declarations.insert(name, value.trim().to_string());
    }
    let style_value = declarations
        .iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join(";");
    crate::html::validate_inline_style(&style_value)?;
    if style_value.is_empty() {
        tag.replace_range(start..value_end + 1, "");
    } else {
        tag.replace_range(value_start..value_end, &style_value);
    }
    Ok(())
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
            PatchOperation::ImageGeometry { geometry, .. }
                if change.geometry.replace(geometry.clone()).is_some() =>
            {
                return Err(HcdError::InvalidPatch(format!(
                    "patch contains more than one image.geometry for {node_id}"
                )));
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

pub(crate) fn replace_node_text(
    html: &mut String,
    node_id: &str,
    text: &str,
    node_hash: &str,
) -> Result<(), HcdError> {
    if let Some(runs) = crate::extract_xlsx_inline_runs(html)?.get(node_id) {
        let old: Vec<char> = runs.iter().flat_map(|r| r.text.chars()).collect();
        let new: Vec<char> = text.chars().collect();
        let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
        let suffix = old[prefix..]
            .iter()
            .rev()
            .zip(new[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let inserted: String = new[prefix..new.len() - suffix].iter().collect();
        let adjusted =
            crate::splice_xlsx_inline_runs(runs, prefix, old.len() - prefix - suffix, &inserted);
        return replace_node_content(
            html,
            node_id,
            &crate::render_xlsx_inline_runs(&adjusted)?,
            node_hash,
        );
    }
    let rich = crate::extract_docx_inline_runs(html)?;
    let content = if let Some(runs) = rich.get(node_id) {
        // A text-only splice inherits the adjoining mark, without discarding
        // earlier rich edits or leaving stale native export metadata behind.
        let old: String = runs.iter().map(|run| run.text.as_str()).collect();
        let a: Vec<char> = old.chars().collect();
        let b: Vec<char> = text.chars().collect();
        let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
        let suffix = a[prefix..]
            .iter()
            .rev()
            .zip(b[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let inserted: String = b[prefix..b.len() - suffix].iter().collect();
        let adjusted = crate::docx_inline::splice_docx_inline_runs(
            runs,
            prefix,
            a.len() - prefix - suffix,
            &inserted,
        );
        crate::docx_inline::render_docx_inline_runs(&adjusted)
    } else {
        escape_text(text)
    };
    replace_node_content(html, node_id, &content, node_hash)
}

pub(crate) fn replace_node_content(
    html: &mut String,
    node_id: &str,
    content: &str,
    node_hash: &str,
) -> Result<(), HcdError> {
    // Structural blocks can intentionally share their first text anchor's ID.
    // Select the element carrying a node hash, and match its actual end rather
    // than the first literal </span> or an attribute's quoted '>'.
    let (tag_start, content_start, content_end) = {
        let mut reader = quick_xml::Reader::from_str(html);
        reader.config_mut().check_end_names = true;
        let mut target = None;
        let mut depth = 0usize;
        loop {
            let before = reader.buffer_position() as usize;
            let event = reader.read_event().map_err(|error| {
                HcdError::InvalidBundle(format!("text anchor parse error: {error}"))
            })?;
            match event {
                quick_xml::events::Event::Start(start) => {
                    if target.is_some() {
                        depth += 1;
                        continue;
                    }
                    let mut matching_id = false;
                    let mut has_hash = false;
                    for attribute in start.attributes() {
                        let attribute = attribute
                            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                        if attribute.key.as_ref() == b"data-hcd-id" {
                            matching_id = attribute
                                .unescape_value()
                                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                                == node_id;
                        }
                        has_hash |= attribute.key.as_ref() == b"data-hcd-node-hash";
                    }
                    if matching_id && has_hash {
                        target = Some((before, reader.buffer_position() as usize));
                        depth = 1;
                    }
                }
                quick_xml::events::Event::End(_) if target.is_some() => {
                    depth -= 1;
                    if depth == 0 {
                        let (start, content) = target.expect("matched text anchor");
                        break (start, content, before);
                    }
                }
                quick_xml::events::Event::Eof => {
                    return Err(HcdError::InvalidBundle(format!(
                        "canonical text node {node_id} missing or unclosed"
                    )))
                }
                _ => {}
            }
        }
    };
    let tag_end = content_start - 1;
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
    html.replace_range(content_start..content_end, content);
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
    let (start, end) = element_start_tag_range(html, node_id)?;
    let flow = html[start..=end].contains("data-hcd-image-flow=\"true\"");
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
        // Absolute spreadsheet drawing anchors must follow edited geometry too.
        for (name, value) in [
            ("data-hcd-absolute-x-emu", geometry.x),
            ("data-hcd-absolute-y-emu", geometry.y),
            ("data-hcd-extent-width-emu", geometry.width),
            ("data-hcd-extent-height-emu", geometry.height),
        ] {
            set_element_attribute(html, node_id, name, &canonical_f64(value))?;
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
    properties.insert(
        "position".to_string(),
        if flow { "relative" } else { "absolute" }.to_string(),
    );
    if !flow {
        properties.insert(
            "left".to_string(),
            format!("{}{suffix}", canonical_f64(geometry.x * scale)),
        );
        properties.insert(
            "top".to_string(),
            format!("{}{suffix}", canonical_f64(geometry.y * scale)),
        );
    }
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
    removed_nodes: &BTreeSet<String>,
) -> Result<(Option<String>, String), HcdError> {
    let has_annotation_ops = patch.operations.iter().any(|operation| {
        matches!(
            operation,
            PatchOperation::AnnotationUpsert { .. } | PatchOperation::AnnotationRemove { .. }
        )
    });
    if !has_annotation_ops && (removed_nodes.is_empty() || manifest.annotation_href.is_none()) {
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
    let previous_count = set.annotations.len();
    set.annotations
        .retain(|annotation| !removed_nodes.contains(&annotation.node_id));
    if !has_annotation_ops && set.annotations.len() == previous_count {
        return Ok((
            manifest.annotation_href.clone(),
            manifest.annotation_root_hash.clone(),
        ));
    }
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
            | PatchOperation::TextFont { .. }
            | PatchOperation::TextFontClear { .. }
            | PatchOperation::PdfTextInsert { .. }
            | PatchOperation::PptxTextInsert { .. }
            | PatchOperation::PptxShapeGeometry { .. }
            | PatchOperation::PptxTextDelete { .. }
            | PatchOperation::PptxRunFormat { .. }
            | PatchOperation::PptxShapeAlign { .. }
            | PatchOperation::XlsxCellFormat { .. }
            | PatchOperation::XlsxRichTextSet { .. }
            | PatchOperation::XlsxRichTextCreate { .. }
            | PatchOperation::XlsxCellLayout { .. }
            | PatchOperation::XlsxCellNumberFormat { .. }
            | PatchOperation::PdfTextGeometry { .. }
            | PatchOperation::PdfTextDelete { .. }
            | PatchOperation::XlsxMerge { .. }
            | PatchOperation::XlsxUnmerge { .. }
            | PatchOperation::XlsxCellSet { .. }
            | PatchOperation::XlsxFormulaSet { .. }
            | PatchOperation::XlsxFormulaToValue { .. }
            | PatchOperation::XlsxFormulaToNumber { .. }
            | PatchOperation::XlsxNumberSet { .. }
            | PatchOperation::XlsxFormulaCreate { .. }
            | PatchOperation::XlsxRowAppend { .. }
            | PatchOperation::XlsxRowInsert { .. }
            | PatchOperation::XlsxRowDelete { .. }
            | PatchOperation::XlsxColumnInsert { .. }
            | PatchOperation::XlsxColumnDelete { .. }
            | PatchOperation::XlsxGridRange { .. }
            | PatchOperation::XlsxMergeBlank { .. }
            | PatchOperation::XlsxRowRemoveLast { .. }
            | PatchOperation::XlsxColumnWidth { .. }
            | PatchOperation::XlsxRowHeight { .. }
            | PatchOperation::XlsxSheetRename { .. }
            | PatchOperation::XlsxSheetAdd { .. }
            | PatchOperation::XlsxSheetDelete { .. }
            | PatchOperation::XlsxSheetFreeze { .. }
            | PatchOperation::PptxSlideAdd { .. }
            | PatchOperation::PptxSlideDelete { .. }
            | PatchOperation::PptxSlideReorder { .. }
            | PatchOperation::PptxSlideCopy { .. }
            | PatchOperation::NodeStyle { .. }
            | PatchOperation::ImageInsert { .. }
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

fn is_forbidden_xml_character(ch: char) -> bool {
    matches!(ch as u32, 0x0..=0x8 | 0xB | 0xC | 0xE..=0x1F | 0xFFFE | 0xFFFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_replacement_targets_the_hashed_anchor_and_preserves_structural_ids() {
        let id = "n_00000000000000000000000000000001";
        let old_hash = hash_bytes(b"old");
        let new_hash = hash_bytes("新😀".as_bytes());
        let before = format!("<p data-hcd-id=\"{id}\"><span title=\"a > b\" data-hcd-id=\"{id}\" data-hcd-node-hash=\"{old_hash}\"><span>old</span><em> content</em></span><i>untouched</i></p>");
        let mut html = before.clone();
        replace_node_content(&mut html, id, "新😀", &new_hash).unwrap();
        assert_eq!(
            html,
            before
                .replace("<span>old</span><em> content</em>", "新😀")
                .replace(&old_hash, &new_hash)
        );
        assert_eq!(extract_html_text_nodes(&html).unwrap()[id], "新😀");
        let missing = "n_00000000000000000000000000000002";
        let unchanged = html.clone();
        assert!(replace_node_content(&mut html, missing, "bad", &new_hash).is_err());
        assert_eq!(html, unchanged);
    }

    #[test]
    fn pdf_overlay_geometry_moves_and_resizes_without_changing_text_identity() {
        let node_id = "n_00000000000000000000000000000001";
        let mut html = "<section class=\"hcd-pdf-page\" data-hcd-page=\"1\" data-hcd-continuation=\"false\" data-hcd-source-raster=\"true\" style=\"width:612pt;height:792pt\"></section>".to_string();
        let mut source_map = crate::ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000001".to_string(),
            entries: vec![],
        };
        insert_pdf_text(
            &mut html,
            &mut source_map,
            &PdfTextInsertion {
                page: 1,
                x_pt: 20.0,
                y_pt: 700.0,
                width_pt: 180.0,
                height_pt: 18.0,
                font_size_pt: 12.0,
                text: "原文".to_string(),
                node_id: node_id.to_string(),
            },
        )
        .unwrap();
        let entry = &source_map.entries[0];
        let original_hash = entry.node_hash.clone();
        let before = PdfTextGeometry {
            x_pt: 20.0,
            y_pt: 700.0,
            width_pt: 180.0,
            height_pt: 18.0,
        };
        let after = PdfTextGeometry {
            x_pt: 44.25,
            y_pt: 660.5,
            width_pt: 220.5,
            height_pt: 32.0,
        };
        let change = PdfGeometryChange {
            geometry: after,
            expected: before,
            node_hash: original_hash.clone(),
        };
        update_pdf_text_geometry(&mut html, entry, &change).unwrap();
        assert!(html.contains("data-hcd-bbox=\"44.25,660.5,220.5,32\""));
        assert!(html.contains("left:44.25pt;top:99.5pt;width:220.5pt;height:32pt"));
        assert_eq!(extract_html_text_nodes(&html).unwrap()[node_id], "原文");
        assert_eq!(entry.node_hash, original_hash);
        assert!(matches!(
            update_pdf_text_geometry(&mut html, entry, &change),
            Err(HcdError::PreconditionFailed(_))
        ));

        let out_of_page = PdfGeometryChange {
            geometry: PdfTextGeometry {
                x_pt: 600.0,
                ..after
            },
            expected: after,
            node_hash: original_hash,
        };
        assert!(matches!(
            update_pdf_text_geometry(&mut html, entry, &out_of_page),
            Err(HcdError::InvalidPatch(_))
        ));
    }

    #[test]
    fn pdf_overlay_delete_removes_only_the_created_text_box() {
        let node_id = "n_00000000000000000000000000000001";
        let mut html = "<section class=\"hcd-pdf-page\" data-hcd-page=\"1\" data-hcd-continuation=\"false\" data-hcd-source-raster=\"true\" style=\"width:612pt;height:792pt\"><p class=\"hcd-pdf-text\" data-hcd-mapping=\"source\"><span data-hcd-id=\"n_00000000000000000000000000000002\">source</span></p></section>".to_string();
        let mut source_map = crate::ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000001".to_string(),
            entries: vec![],
        };
        insert_pdf_text(
            &mut html,
            &mut source_map,
            &PdfTextInsertion {
                page: 1,
                x_pt: 20.0,
                y_pt: 700.0,
                width_pt: 180.0,
                height_pt: 18.0,
                font_size_pt: 12.0,
                text: "delete me".to_string(),
                node_id: node_id.to_string(),
            },
        )
        .unwrap();
        delete_pdf_text(&mut html, &source_map.entries[0]).unwrap();
        assert!(!html.contains(node_id));
        assert!(html.contains("data-hcd-mapping=\"source\""));
        assert!(html.contains(">source</span>"));
        assert!(matches!(
            delete_pdf_text(&mut html, &source_map.entries[0]),
            Err(HcdError::InvalidBundle(_))
        ));
    }

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

    fn single_node_bundle(temp: &tempfile::TempDir) -> std::path::PathBuf {
        let bundle_path = temp.path().join("bundle");
        let mut writer = crate::BundleWriter::create(&bundle_path).unwrap();
        writer.write_styles("").unwrap();
        let node_id = "n_00000000000000000000000000000000".to_string();
        let chunk_id = "c_00000000000000000000000000000000".to_string();
        let text = "hello world".to_string();
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
                            text_ordinal: 1,
                            paragraph_id: None,
                            text_id: Some("bytes:0:11".to_string()),
                            node_kind: "line".to_string(),
                            editable: true,
                        },
                    }],
                },
                1,
                false,
            )
            .unwrap();
        writer
            .finish(crate::HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                storage_codec: crate::StorageCodec::None,
                document_id: "font-doc".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: crate::SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "0".repeat(64),
                    size_bytes: 10,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                theme_revision_id: None,
                capabilities: crate::HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        bundle_path
    }

    #[test]
    fn text_font_applies_inline_style_and_data_attributes_and_bumps_revision() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = single_node_bundle(&temp);
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let before = bundle.manifest().unwrap();
        let node = get_text_node(&bundle, "n_00000000000000000000000000000000").unwrap();
        let result = apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-1".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextFont {
                    node_id: node.node.node_id.clone(),
                    font: crate::FontPatch {
                        latin: Some("Demo Serif".to_string()),
                        east_asia: Some("Demo Sans".to_string()),
                        bidi: None,
                    },
                    precondition: crate::NodePrecondition {
                        node_hash: node.node.node_hash.clone(),
                    },
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        assert_eq!(result.revision, 1);
        let manifest = bundle.manifest().unwrap();
        assert_ne!(manifest.root_hash, before.root_hash);

        // the pinned HTML carries the inline face, the round-trip attributes, and
        // the font-patched marker, but not the node.style presentation marker.
        let descriptor = bundle.read_index_page(&manifest, 0).unwrap().chunks[0].clone();
        let html = bundle.read_chunk(&descriptor).unwrap();
        assert!(html.contains("font-family:'Demo Serif'"), "{html}");
        assert!(html.contains("data-hcd-font=\"Demo Serif\""), "{html}");
        assert!(
            html.contains("data-hcd-font-east-asia=\"Demo Sans\""),
            "{html}"
        );
        assert!(html.contains("data-hcd-font-patched=\"true\""), "{html}");
        assert!(!html.contains("data-hcd-style-patched"), "{html}");

        // the extracted text and its hash are untouched, so the precondition hash
        // still matches the node's text.
        let after = get_text_node(&bundle, "n_00000000000000000000000000000000").unwrap();
        assert_eq!(after.node.text, "hello world");
        assert_eq!(after.node.node_hash, hash_bytes(b"hello world"));
    }

    #[test]
    fn a_patched_node_writes_exactly_the_text_the_block_renderer_writes() {
        // The renderer in structure.rs builds a start tag from `attribute_text`, so
        // this is the check that the two ways of pinning a face cannot drift: the
        // tag apply_node_font leaves behind must be the tag attribute_text describes.
        let font = crate::FontPatch {
            latin: Some("Brand Serif".to_string()),
            east_asia: Some("等线".to_string()),
            bidi: None,
        };
        let node_id = "n_00000000000000000000000000000000";
        let mut html =
            format!("<p><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"h\">Text</span></p>");
        apply_node_font(&mut html, node_id, &font).unwrap();
        let expected = format!(
            "<span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"h\"{}>",
            font_presentation(&font).unwrap().attribute_text()
        );
        assert!(html.contains(&expected), "{html}\nexpected {expected}");
        assert!(
            expected.contains("style=\"font-family:'Brand Serif'\""),
            "{expected}"
        );
        assert!(
            expected.contains("data-hcd-font-east-asia=\"等线\""),
            "{expected}"
        );
    }

    #[test]
    fn text_font_requires_v37_and_rejects_empty_or_unsafe_families() {
        // rejected on a non-v37 schema version
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = single_node_bundle(&temp);
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let node = get_text_node(&bundle, "n_00000000000000000000000000000000").unwrap();
        let wrong_version = apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-bad".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextFont {
                    node_id: node.node.node_id.clone(),
                    font: crate::FontPatch {
                        latin: Some("Demo Serif".to_string()),
                        east_asia: None,
                        bidi: None,
                    },
                    precondition: crate::NodePrecondition {
                        node_hash: node.node.node_hash.clone(),
                    },
                }],
                metadata: BTreeMap::new(),
            },
            0,
        );
        assert!(wrong_version.is_err());

        // no slot provided
        assert!(validate_font_patch(&crate::FontPatch {
            latin: None,
            east_asia: None,
            bidi: None,
        })
        .is_err());
        // injection-laden family
        assert!(validate_font_patch(&crate::FontPatch {
            latin: Some("X';color:red;url(evil)".to_string()),
            east_asia: None,
            bidi: None,
        })
        .is_err());
    }

    /// Pin in one revision, clear in the next: the node ends up with the exact tag
    /// the import wrote, so preview, read-back, and every export stop seeing a pin.
    #[test]
    fn text_font_clear_gives_the_node_back_the_tag_the_import_wrote() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = single_node_bundle(&temp);
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let node_id = "n_00000000000000000000000000000000";
        let chunk_at = |bundle: &crate::Bundle| -> String {
            let manifest = bundle.manifest().unwrap();
            let descriptor = bundle.read_index_page(&manifest, 0).unwrap().chunks[0].clone();
            bundle.read_chunk(&descriptor).unwrap()
        };
        let imported = chunk_at(&bundle);
        let node = get_text_node(&bundle, node_id).unwrap();
        let pin = crate::PatchOperation::TextFont {
            node_id: node_id.to_string(),
            font: crate::FontPatch {
                latin: Some("Demo Serif".to_string()),
                east_asia: None,
                bidi: None,
            },
            precondition: crate::NodePrecondition {
                node_hash: node.node.node_hash.clone(),
            },
        };
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-pin".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![pin],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        let pinned = chunk_at(&bundle);
        assert!(
            pinned != imported && pinned.contains("data-hcd-font-patched"),
            "{pinned}"
        );

        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-clear".to_string(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextFontClear {
                    node_id: node_id.to_string(),
                    // The pin did not change the text, so the same hash still guards it.
                    precondition: crate::NodePrecondition {
                        node_hash: node.node.node_hash,
                    },
                }],
                metadata: BTreeMap::new(),
            },
            1,
        )
        .unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        assert_eq!(chunk_at(&bundle), imported);
    }

    /// A clear is not a no-op: a node that carries no pin is refused, so a revision
    /// cannot be spent erasing a face the document never pinned.
    #[test]
    fn text_font_clear_refuses_a_node_that_carries_no_pin() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = single_node_bundle(&temp);
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let node = get_text_node(&bundle, "n_00000000000000000000000000000000").unwrap();
        let rejected = apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-clear-none".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextFontClear {
                    node_id: node.node.node_id.clone(),
                    precondition: crate::NodePrecondition {
                        node_hash: node.node.node_hash.clone(),
                    },
                }],
                metadata: BTreeMap::new(),
            },
            0,
        );
        assert!(
            matches!(&rejected, Err(HcdError::InvalidPatch(message)) if message.contains("no text.font pin")),
            "{rejected:?}"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
    }

    /// A face that arrived with the source carries `data-hcd-font*` without the
    /// patch marker, and is left alone.
    #[test]
    fn clearing_a_font_leaves_a_source_face_alone() {
        let node_id = "n_00000000000000000000000000000000";
        let html = format!(
            "<p><span data-hcd-id=\"{node_id}\" data-hcd-font=\"Source Serif\">Text</span></p>"
        );
        let mut target = html.clone();
        assert!(matches!(
            clear_node_font(&mut target, node_id),
            Err(HcdError::InvalidPatch(_))
        ));
        assert_eq!(target, html);
    }

    /// Only the pin goes: the declarations the node already had stay, in the form
    /// the pin wrote them, and a `font-family` the import brought is not restored.
    #[test]
    fn clearing_a_font_keeps_the_rest_of_the_style() {
        let node_id = "n_00000000000000000000000000000000";
        let font = crate::FontPatch {
            latin: Some("Demo Serif".to_string()),
            east_asia: Some("Demo Sans".to_string()),
            bidi: None,
        };
        let mut html = format!(
            "<p><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"h\" style=\"color:#ff0000;font-family:'Imported Serif'\">Text</span></p>"
        );
        apply_node_font(&mut html, node_id, &font).unwrap();
        assert!(
            html.contains("style=\"color:#ff0000;font-family:'Demo Serif'\""),
            "{html}"
        );
        clear_node_font(&mut html, node_id).unwrap();
        assert!(html.contains("style=\"color:#ff0000\""), "{html}");
        assert!(!html.contains("font-family"), "{html}");
        assert!(!html.contains("data-hcd-font"), "{html}");
        assert!(html.contains("data-hcd-node-hash=\"h\""), "{html}");
        assert!(
            !html.contains("Imported Serif"),
            "the overwritten family is not restored, and is not left behind either"
        );
    }

    /// Pinning and clearing the same node in one batch would let the last write
    /// decide, so the batch is refused before anything is rewritten.
    #[test]
    fn one_patch_may_not_both_pin_and_clear_a_node() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = single_node_bundle(&temp);
        let bundle = crate::Bundle::open(&bundle_path).unwrap();
        let node_id = "n_00000000000000000000000000000000";
        let node = get_text_node(&bundle, node_id).unwrap();
        let precondition = crate::NodePrecondition {
            node_hash: node.node.node_hash.clone(),
        };
        let rejected = apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "font-doc".to_string(),
                patch_id: "font-both".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![
                    crate::PatchOperation::TextFont {
                        node_id: node_id.to_string(),
                        font: crate::FontPatch {
                            latin: Some("Demo Serif".to_string()),
                            east_asia: None,
                            bidi: None,
                        },
                        precondition: precondition.clone(),
                    },
                    crate::PatchOperation::TextFontClear {
                        node_id: node_id.to_string(),
                        precondition,
                    },
                ],
                metadata: BTreeMap::new(),
            },
            0,
        );
        assert!(
            matches!(&rejected, Err(HcdError::InvalidPatch(message)) if message.contains("more than one text.font operation")),
            "{rejected:?}"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 0);
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
                theme_revision_id: None,
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

    /// Write a deck of `slides` pages, one chunk each, the way the importer
    /// writes them: a slide section naming its part, carrying one text node.
    fn slide_deck(path: &std::path::Path, slides: usize) -> crate::Bundle {
        let parts: Vec<String> = (1..=slides)
            .map(|number| format!("ppt/slides/slide{number}.xml"))
            .collect();
        slide_deck_chunks(path, &parts)
    }

    /// The same deck written from the list of parts its chunks name, one chunk
    /// per entry. A part listed twice is one page spread over two chunks, which
    /// is how a slide whose table the importer had to split arrives.
    fn slide_deck_chunks(path: &std::path::Path, parts: &[String]) -> crate::Bundle {
        let mut writer =
            crate::BundleWriter::create_with_codec(path, crate::StorageCodec::Gzip).unwrap();
        writer.write_styles("").unwrap();
        for (index, part) in parts.iter().enumerate() {
            let node_id = format!("n_{index:032x}");
            let chunk_id = format!("c_{index:032x}");
            let text = format!("page-{index}");
            let node_hash = hash_bytes(text.as_bytes());
            let html = format!(
                "<section class=\"hcd-slide\" data-hcd-source-part=\"{part}\" data-hcd-width-emu=\"9144000\" data-hcd-height-emu=\"5143500\" style=\"position:relative;width:960.00px;height:540.00px\"><p class=\"hcd-slide-text\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{text}</span></p></section>"
            );
            writer
                .write_chunk(
                    chunk_id.clone(),
                    "slide".to_string(),
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
                                part: part.clone(),
                                text_ordinal: 1,
                                paragraph_id: None,
                                text_id: Some(format!("bytes:{index}:{}", index + 1)),
                                node_kind: "slide-text".to_string(),
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
                document_id: "deck".to_string(),
                profile: "slide-canvas".to_string(),
                revision: 0,
                source: crate::SourceDescriptor {
                    format: "pptx".to_string(),
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
                theme_revision_id: None,
                capabilities: crate::HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        crate::Bundle::open(path).unwrap()
    }

    fn delete_slide(bundle: &crate::Bundle, patch_id: &str, chunk_id: &str) -> crate::HcdError {
        apply_patch(
            bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_42.to_string(),
                document_id: "deck".to_string(),
                patch_id: patch_id.to_string(),
                base_revision: bundle.manifest().unwrap().revision,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideDelete {
                    chunk_id: chunk_id.to_string(),
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .expect_err("slide deletion was expected to be refused")
    }

    #[test]
    fn pptx_slide_deletion_drops_the_page_from_the_index_and_records_the_part() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 3);
        assert_eq!(bundle.manifest().unwrap().chunk_count, 3);
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_42.to_string(),
                document_id: "deck".to_string(),
                patch_id: "drop-middle".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideDelete {
                    chunk_id: "c_00000000000000000000000000000001".to_string(),
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.chunk_count, 2);
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        // The pages behind the hole move up one slot, so the deck still reads in
        // order and the last page is now the one that was third.
        assert_eq!(
            page.chunks
                .iter()
                .map(|descriptor| (descriptor.sequence, descriptor.chunk_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (0, "c_00000000000000000000000000000000"),
                (1, "c_00000000000000000000000000000002"),
            ]
        );
        let record = bundle.revision(1).unwrap();
        assert_eq!(
            record.slide_removals,
            vec![crate::SlideRemoval {
                slide_part: "ppt/slides/slide2.xml".to_string()
            }]
        );
        assert_eq!(
            record.dirty_node_ids,
            vec!["n_00000000000000000000000000000001".to_string()]
        );
        assert_eq!(
            record.removed_node_ids,
            vec!["n_00000000000000000000000000000001".to_string()]
        );
        assert_eq!(
            record.dirty_source_parts,
            vec!["ppt/slides/slide2.xml".to_string()]
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        let mut rendered = Vec::new();
        crate::render_standalone_html(
            &bundle,
            &crate::HtmlPresentationOptions::default(),
            &mut rendered,
        )
        .unwrap();
        let html = String::from_utf8(rendered).unwrap();
        assert!(!html.contains("page-1"));
        assert!(html.contains("page-0") && html.contains("page-2"));
    }

    #[test]
    fn pptx_slide_deletion_empties_the_last_index_page_it_leaves_behind() {
        let temp = tempfile::tempdir().unwrap();
        // One chunk past a full page, so the deck starts on two pages and the
        // removal is what pulls it back to one.
        let slides = crate::INDEX_PAGE_SIZE + 1;
        let bundle = slide_deck(&temp.path().join("bundle"), slides);
        let before = bundle.manifest().unwrap();
        assert_eq!(before.index_page_count, 2);
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_42.to_string(),
                document_id: "deck".to_string(),
                patch_id: "drop-first".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideDelete {
                    chunk_id: "c_00000000000000000000000000000000".to_string(),
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.chunk_count, crate::INDEX_PAGE_SIZE);
        assert_eq!(manifest.index_page_count, 1);
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        assert_eq!(page.revision, 1);
        assert_eq!(page.chunks[0].sequence, 0);
        assert_eq!(
            page.chunks[0].chunk_id,
            "c_00000000000000000000000000000001"
        );
        assert_eq!(
            bundle.revision(1).unwrap().slide_removals[0].slide_part,
            "ppt/slides/slide1.xml"
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
    }

    #[test]
    fn pptx_slide_deletion_refuses_to_empty_a_deck_or_name_a_page_it_cannot_find() {
        let temp = tempfile::tempdir().unwrap();
        // A deck of one is the deck a deletion cannot touch: PowerPoint does not
        // open a presentation with no slides.
        let only = slide_deck(&temp.path().join("one"), 1);
        assert!(matches!(
            delete_slide(&only, "drop-only", "c_00000000000000000000000000000000"),
            HcdError::InvalidPatch(_)
        ));
        assert_eq!(only.manifest().unwrap().revision, 0);

        let deck = slide_deck(&temp.path().join("three"), 3);
        // A chunk the index does not hold, and a chunk that is not a page.
        let error = delete_slide(&deck, "drop-unknown", "c_0000000000000000000000000000ffff");
        assert!(
            matches!(error, HcdError::Unsupported(_)),
            "unexpected: {error:?}"
        );
        assert_eq!(deck.manifest().unwrap().revision, 0);
    }

    #[test]
    fn an_added_slide_never_takes_a_part_name_the_deck_already_spent() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 3);
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_42.to_string(),
                document_id: "deck".to_string(),
                patch_id: "drop-last".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideDelete {
                    chunk_id: "c_00000000000000000000000000000002".to_string(),
                }],
                metadata: BTreeMap::new(),
            },
            0,
        )
        .unwrap();
        assert_eq!(
            bundle.revision(1).unwrap().slide_removals[0].slide_part,
            "ppt/slides/slide3.xml"
        );
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_41.to_string(),
                document_id: "deck".to_string(),
                patch_id: "add-after-drop".to_string(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideAdd {}],
                metadata: BTreeMap::new(),
            },
            1,
        )
        .unwrap();
        // The deck is back to three pages and the new one is named past the hole,
        // not into it: the export could not drop and write the same entry.
        let manifest = bundle.manifest().unwrap();
        assert_eq!(manifest.chunk_count, 3);
        let page = bundle
            .read_index_page(&manifest, manifest.index_page_count - 1)
            .unwrap();
        let added = page.chunks.last().unwrap();
        assert_eq!(added.region, "slide");
        assert_eq!(
            bundle.revision(2).unwrap().slide_additions[0].slide_part,
            "ppt/slides/slide4.xml"
        );
        assert!(bundle
            .read_chunk(added)
            .unwrap()
            .contains("ppt/slides/slide4.xml"));
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_deletion_needs_the_page_version_it_addresses() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 2);
        for (patch_id, schema_version, chunk_id) in [
            (
                "wrong-version",
                crate::HCD_PATCH_SCHEMA_VERSION_41,
                "c_0".to_string(),
            ),
            (
                "short-id",
                crate::HCD_PATCH_SCHEMA_VERSION_42,
                "c_0000000000000000000000000000000".to_string(),
            ),
            (
                "uppercase-id",
                crate::HCD_PATCH_SCHEMA_VERSION_42,
                "c_0000000000000000000000000000000A".to_string(),
            ),
            (
                "worksheet-chunk",
                crate::HCD_PATCH_SCHEMA_VERSION_42,
                "s_00000000000000000000000000000000".to_string(),
            ),
        ] {
            let error = apply_patch(
                &bundle,
                &crate::PatchBatch {
                    schema_version: schema_version.to_string(),
                    document_id: "deck".to_string(),
                    patch_id: patch_id.to_string(),
                    base_revision: bundle.manifest().unwrap().revision,
                    actor: BTreeMap::new(),
                    operations: vec![crate::PatchOperation::PptxSlideDelete {
                        chunk_id: chunk_id.to_string(),
                    }],
                    metadata: BTreeMap::new(),
                },
                0,
            )
            .expect_err("the patch was expected to be refused");
            assert!(
                matches!(error, HcdError::Unsupported(_) | HcdError::InvalidPatch(_)),
                "{patch_id}: unexpected {error:?}"
            );
        }
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(bundle.manifest().unwrap().chunk_count, 2);
    }

    /// The chunk id a deck written by `slide_deck` gives its `index + 1` page.
    fn slide_chunk(index: usize) -> String {
        format!("c_{index:032x}")
    }

    fn move_slide_patch(chunk_id: &str, direction: &str, base: u64) -> crate::PatchBatch {
        crate::PatchBatch {
            schema_version: crate::HCD_PATCH_SCHEMA_VERSION_43.to_string(),
            document_id: "deck".to_string(),
            patch_id: format!("move-{direction}-{base}"),
            base_revision: base,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![crate::PatchOperation::PptxSlideReorder {
                chunk_id: chunk_id.to_string(),
                direction: direction.to_string(),
                target_index: None,
            }],
        }
    }

    /// The chunks the index holds, in the order the deck shows them.
    fn index_chunk_order(bundle: &crate::Bundle) -> Vec<String> {
        let manifest = bundle.manifest().unwrap();
        (0..manifest.index_page_count)
            .flat_map(|page| bundle.read_index_page(&manifest, page).unwrap().chunks)
            .map(|descriptor| descriptor.chunk_id)
            .collect()
    }

    #[test]
    fn pptx_slide_reorder_swaps_two_pages_without_rewriting_a_chunk() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 3);
        let before = bundle.manifest().unwrap();
        let written: Vec<(String, String)> = bundle
            .read_index_page(&before, 0)
            .unwrap()
            .chunks
            .iter()
            .map(|descriptor| {
                (
                    descriptor.chunk_id.clone(),
                    bundle.read_chunk(descriptor).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            written
                .iter()
                .map(|(chunk_id, _)| chunk_id.clone())
                .collect::<Vec<_>>(),
            vec![slide_chunk(0), slide_chunk(1), slide_chunk(2)]
        );

        let result = apply_patch(&bundle, &move_slide_patch(&slide_chunk(1), "up", 0), 0).unwrap();
        assert_eq!(result.revision, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "PPTX_SLIDE_MOVED"));
        // Nothing was said differently. Only where the two pages stand changed,
        // so no node and no source part is dirty and the chunks that moved are
        // the only ones a reader has to look at again.
        assert!(result.dirty_node_ids.is_empty());
        assert!(result.dirty_source_parts.is_empty());
        assert_eq!(result.dirty_chunk_ids, vec![slide_chunk(0), slide_chunk(1)]);

        let head = bundle.manifest().unwrap();
        assert_eq!(head.chunk_count, before.chunk_count);
        assert_eq!(head.index_page_count, before.index_page_count);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(1), slide_chunk(0), slide_chunk(2)]
        );
        let page = bundle.read_index_page(&head, 0).unwrap();
        assert_eq!(page.revision, 1);
        assert_eq!(
            page.chunks
                .iter()
                .map(|descriptor| descriptor.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        // Each chunk still says exactly what it said before, byte for byte: the
        // pages swapped places, nothing was rewritten.
        for descriptor in page.chunks.iter() {
            let expected = written
                .iter()
                .find(|(chunk_id, _)| *chunk_id == descriptor.chunk_id)
                .unwrap();
            assert_eq!(
                bundle.read_chunk(descriptor).unwrap(),
                expected.1,
                "{}",
                descriptor.chunk_id
            );
        }

        let record = bundle.revision(1).unwrap();
        assert_eq!(
            record.slide_reorders,
            vec![crate::SlideReorder {
                slide_part: "ppt/slides/slide2.xml".to_string()
            }]
        );
        assert!(record.dirty_node_ids.is_empty());
        assert!(record.dirty_source_parts.is_empty());
        assert_eq!(record.dirty_chunk_ids.len(), 2);
        assert!(crate::validate_bundle(&bundle).unwrap().valid);

        // The deck a reader renders puts the moved page in front.
        let mut rendered = Vec::new();
        crate::render_standalone_html(
            &bundle,
            &crate::HtmlPresentationOptions::default(),
            &mut rendered,
        )
        .unwrap();
        let html = String::from_utf8(rendered).unwrap();
        assert!(
            html.find("page-1") < html.find("page-0"),
            "the moved page does not render first: {html}"
        );
    }

    #[test]
    fn pptx_slide_drag_reorders_nonadjacent_pages_in_one_revision() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 5);
        let drag = |source: usize, target: usize, base: u64| {
            let mut patch = move_slide_patch(&slide_chunk(source), "", base);
            patch.schema_version = crate::HCD_PATCH_SCHEMA_VERSION_48.to_string();
            patch.patch_id = format!("drag-{source}-{target}-{base}");
            patch.operations = vec![crate::PatchOperation::PptxSlideReorder {
                chunk_id: slide_chunk(source),
                direction: String::new(),
                target_index: Some(target),
            }];
            patch
        };
        assert_eq!(apply_patch(&bundle, &drag(0, 3, 0), 0).unwrap().revision, 1);
        assert_eq!(index_chunk_order(&bundle), [1, 2, 3, 0, 4].map(slide_chunk));
        assert_eq!(apply_patch(&bundle, &drag(4, 1, 1), 1).unwrap().revision, 2);
        assert_eq!(index_chunk_order(&bundle), [1, 4, 2, 3, 0].map(slide_chunk));
        for patch in [drag(0, 9, 2), drag(0, 4, 2), drag(0, 1, 0)] {
            assert!(apply_patch(&bundle, &patch, 2).is_err());
            assert_eq!(bundle.manifest().unwrap().revision, 2);
            assert_eq!(index_chunk_order(&bundle), [1, 4, 2, 3, 0].map(slide_chunk));
        }
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_reorder_moves_every_chunk_of_a_page_that_spans_two() {
        let temp = tempfile::tempdir().unwrap();
        // One page spread over two chunks, the way a slide whose table the
        // importer had to split arrives, with a one-chunk page behind it.
        let parts: Vec<String> = [
            "ppt/slides/slide1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let bundle = slide_deck_chunks(&temp.path().join("bundle"), &parts);
        let before = bundle.manifest().unwrap();

        apply_patch(&bundle, &move_slide_patch(&slide_chunk(2), "up", 0), 0).unwrap();
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(2), slide_chunk(0), slide_chunk(1)]
        );
        assert_eq!(bundle.revision(1).unwrap().dirty_chunk_ids.len(), 3);
        assert_eq!(
            bundle.revision(1).unwrap().slide_reorders[0].slide_part,
            "ppt/slides/slide2.xml"
        );

        // The two-chunk page comes back as a page, whichever of its chunks the
        // patch names: this one names the second, standing at the back.
        apply_patch(&bundle, &move_slide_patch(&slide_chunk(1), "up", 1), 1).unwrap();
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(0), slide_chunk(1), slide_chunk(2)]
        );
        let head = bundle.manifest().unwrap();
        assert_eq!(head.chunk_count, before.chunk_count);
        assert_eq!(head.index_page_count, before.index_page_count);
        assert_eq!(
            bundle.revision(2).unwrap().slide_reorders[0].slide_part,
            "ppt/slides/slide1.xml"
        );
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_reorder_refuses_a_page_with_no_neighbour() {
        let temp = tempfile::tempdir().unwrap();
        let solo = slide_deck(&temp.path().join("solo"), 1);
        let error = apply_patch(&solo, &move_slide_patch(&slide_chunk(0), "up", 0), 0)
            .expect_err("a deck of one page has nothing to swap with");
        assert!(error.to_string().contains("two slides"), "{error}");

        let bundle = slide_deck(&temp.path().join("deck"), 2);
        for (chunk_id, direction, expected) in [
            (slide_chunk(0), "up", "already the first page"),
            (slide_chunk(1), "down", "already the last page"),
        ] {
            let error = apply_patch(&bundle, &move_slide_patch(&chunk_id, direction, 0), 0)
                .expect_err("the page at this end has no neighbour");
            assert!(error.to_string().contains(expected), "{error}");
        }
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(0), slide_chunk(1)]
        );
    }

    #[test]
    fn pptx_slide_reorder_needs_the_page_direction_and_version_it_addresses() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 2);
        for (patch_id, schema_version, chunk_id, direction) in [
            (
                "old-version",
                crate::HCD_PATCH_SCHEMA_VERSION,
                slide_chunk(0),
                "up",
            ),
            (
                "wrong-version",
                crate::HCD_PATCH_SCHEMA_VERSION_42,
                slide_chunk(0),
                "up",
            ),
            (
                "sideways",
                crate::HCD_PATCH_SCHEMA_VERSION_43,
                slide_chunk(0),
                "left",
            ),
            (
                "short-id",
                crate::HCD_PATCH_SCHEMA_VERSION_43,
                "c_0".to_string(),
                "up",
            ),
            (
                "uppercase-id",
                crate::HCD_PATCH_SCHEMA_VERSION_43,
                "c_0000000000000000000000000000000A".to_string(),
                "up",
            ),
            (
                "other-chunk",
                crate::HCD_PATCH_SCHEMA_VERSION_43,
                "s_00000000000000000000000000000000".to_string(),
                "up",
            ),
        ] {
            let error = apply_patch(
                &bundle,
                &crate::PatchBatch {
                    schema_version: schema_version.to_string(),
                    document_id: "deck".to_string(),
                    patch_id: patch_id.to_string(),
                    base_revision: bundle.manifest().unwrap().revision,
                    actor: BTreeMap::new(),
                    metadata: BTreeMap::new(),
                    operations: vec![crate::PatchOperation::PptxSlideReorder {
                        chunk_id,
                        direction: direction.to_string(),
                        target_index: None,
                    }],
                },
                0,
            )
            .expect_err("the patch was expected to be refused");
            assert!(
                matches!(error, HcdError::Unsupported(_) | HcdError::InvalidPatch(_)),
                "{patch_id}: unexpected {error:?}"
            );
        }
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(0), slide_chunk(1)]
        );
    }

    /// The chunk id the importer would hand a page's chunk: the same formula a
    /// copy uses, so a test can name the chunk it expects without reading it back.
    fn copied_chunk_id(document_id: &str, part: &str, ordinal: usize) -> String {
        stable_node_id(&[document_id, part, "slide-chunk", &ordinal.to_string()])
            .replacen("n_", "c_", 1)
    }

    fn copy_slide_patch(chunk_id: &str, base: u64) -> crate::PatchBatch {
        crate::PatchBatch {
            schema_version: crate::HCD_PATCH_SCHEMA_VERSION_44.to_string(),
            document_id: "deck".to_string(),
            patch_id: format!("copy-{chunk_id}-{base}"),
            base_revision: base,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![crate::PatchOperation::PptxSlideCopy {
                chunk_id: chunk_id.to_string(),
            }],
        }
    }

    /// Every node id the index's slide chunks name, in index order.
    fn index_slide_node_ids(bundle: &crate::Bundle) -> Vec<String> {
        let manifest = bundle.manifest().unwrap();
        (0..manifest.index_page_count)
            .flat_map(|page| bundle.read_index_page(&manifest, page).unwrap().chunks)
            .filter(|descriptor| descriptor.region == "slide")
            .flat_map(|descriptor| {
                bundle
                    .read_map(&descriptor)
                    .unwrap()
                    .entries
                    .into_iter()
                    .map(|entry| entry.node_id)
            })
            .collect()
    }

    #[test]
    fn pptx_slide_copy_duplicates_a_page_right_behind_the_original() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 3);
        let before = bundle.manifest().unwrap();
        let original = bundle.read_index_page(&before, 0).unwrap().chunks[0].clone();
        let original_html = bundle.read_chunk(&original).unwrap();
        let new_part = "ppt/slides/slide4.xml".to_string();
        let copied = copied_chunk_id("deck", &new_part, 0);
        let copied_node =
            pptx_copied_node_id("deck", &new_part, original.first_node_id.as_ref().unwrap());

        let result = apply_patch(&bundle, &copy_slide_patch(&slide_chunk(0), 0), 0).unwrap();
        assert_eq!(result.revision, 1);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "PPTX_SLIDE_COPIED"));
        // The page it was copied from is untouched: the copy is what dirtied, and
        // it dirties no node and no source part, because nothing was said
        // differently — a new page simply stands there.
        assert!(result.dirty_node_ids.is_empty());
        assert!(result.dirty_source_parts.is_empty());
        assert_eq!(result.dirty_chunk_ids, vec![copied.clone()]);

        let head = bundle.manifest().unwrap();
        assert_eq!(head.chunk_count, before.chunk_count + 1);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![
                slide_chunk(0),
                copied.clone(),
                slide_chunk(1),
                slide_chunk(2)
            ]
        );

        let page = bundle.read_index_page(&head, 0).unwrap();
        let descriptor = page
            .chunks
            .iter()
            .find(|descriptor| descriptor.chunk_id == copied)
            .expect("the copy is in the index");
        assert_eq!(descriptor.region, "slide");
        assert!(!descriptor.continuation);
        assert_eq!(descriptor.node_count, 1);
        assert_eq!(
            descriptor.first_node_id.as_deref(),
            Some(copied_node.as_str())
        );
        assert_eq!(descriptor.block_count, original.block_count);
        assert_eq!(descriptor.text_chars, original.text_chars);
        assert_eq!(page.chunks.len(), head.chunk_count);

        // The copy says the same thing about a page of its own.
        let copied_html = bundle.read_chunk(descriptor).unwrap();
        assert!(copied_html.contains(&format!("data-hcd-source-part=\"{new_part}\"")));
        assert!(!copied_html.contains("ppt/slides/slide1.xml"));
        assert!(copied_html.contains(&copied_node));
        assert!(!copied_html.contains("n_00000000000000000000000000000000"));
        assert!(copied_html.contains(">page-0<"));
        assert_eq!(copied_html.len() as u64, descriptor.byte_length);
        let copied_map = bundle.read_map(descriptor).unwrap();
        assert_eq!(copied_map.chunk_id, copied);
        assert_eq!(copied_map.entries.len(), 1);
        assert_eq!(copied_map.entries[0].node_id, copied_node);
        assert_eq!(copied_map.entries[0].node_hash, hash_bytes(b"page-0"));
        assert_eq!(copied_map.entries[0].source.part, new_part);
        assert!(!copied_map.entries[0].source.created_in_hcd);
        assert_eq!(
            copied_map.entries[0].source.text_id.as_deref(),
            Some("bytes:0:1")
        );
        assert_eq!(bundle.read_chunk(&original).unwrap(), original_html);

        let record = bundle.revision(1).unwrap();
        assert_eq!(
            record.slide_copies,
            vec![crate::SlideCopy {
                slide_part: new_part.clone(),
                source_slide_part: "ppt/slides/slide1.xml".to_string(),
            }]
        );
        assert_eq!(record.chunk_count.unwrap(), head.chunk_count);
        assert!(crate::validate_bundle(&bundle).unwrap().valid);

        // A reader renders the page twice.
        let mut rendered = Vec::new();
        crate::render_standalone_html(
            &bundle,
            &crate::HtmlPresentationOptions::default(),
            &mut rendered,
        )
        .unwrap();
        let html = String::from_utf8(rendered).unwrap();
        assert_eq!(html.matches("page-0").count(), 2, "{html}");

        // Editing the copy reaches the copy and not the page it was made from:
        // the ids are the copy's own, and so is the part they name.
        let splice = crate::PatchBatch {
            schema_version: crate::HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "deck".to_string(),
            patch_id: "edit-the-copy".to_string(),
            base_revision: 1,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![crate::PatchOperation::TextSplice {
                node_id: copied_node.clone(),
                start: 0,
                delete_count: 6,
                insert_text: "second".to_string(),
                precondition: crate::NodePrecondition {
                    node_hash: hash_bytes(b"page-0"),
                },
            }],
        };
        let result = apply_patch(&bundle, &splice, 1).unwrap();
        assert_eq!(result.dirty_node_ids, vec![copied_node.clone()]);
        assert_eq!(result.dirty_source_parts, vec![new_part.clone()]);
        assert_eq!(bundle.read_chunk(&original).unwrap(), original_html);
        let head = bundle.manifest().unwrap();
        let descriptor = (0..head.index_page_count)
            .flat_map(|page| bundle.read_index_page(&head, page).unwrap().chunks)
            .find(|descriptor| descriptor.chunk_id == copied)
            .unwrap();
        let copied_html = bundle.read_chunk(&descriptor).unwrap();
        assert!(copied_html.contains(">second<"), "{copied_html}");
        assert!(copied_html.contains(&new_part));
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_copy_copies_every_chunk_of_a_page_that_spans_two() {
        let temp = tempfile::tempdir().unwrap();
        // One page spread over two chunks, the way a slide whose table the
        // importer had to split arrives, with a one-chunk page behind it.
        let parts: Vec<String> = [
            "ppt/slides/slide1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let bundle = slide_deck_chunks(&temp.path().join("bundle"), &parts);

        // Naming either chunk of the page copies the whole page.
        let result = apply_patch(&bundle, &copy_slide_patch(&slide_chunk(1), 0), 0).unwrap();
        assert_eq!(result.revision, 1);
        let new_part = "ppt/slides/slide3.xml";
        let first = copied_chunk_id("deck", new_part, 0);
        let second = copied_chunk_id("deck", new_part, 1);
        let mut expected = vec![first.clone(), second.clone()];
        expected.sort();
        assert_eq!(result.dirty_chunk_ids, expected);

        assert_eq!(
            index_chunk_order(&bundle),
            vec![
                slide_chunk(0),
                slide_chunk(1),
                first.clone(),
                second.clone(),
                slide_chunk(2)
            ]
        );
        let head = bundle.manifest().unwrap();
        assert_eq!(head.chunk_count, 5);
        let page = bundle.read_index_page(&head, 0).unwrap();
        let cloned_first = page
            .chunks
            .iter()
            .find(|descriptor| descriptor.chunk_id == first)
            .unwrap();
        let cloned_second = page
            .chunks
            .iter()
            .find(|descriptor| descriptor.chunk_id == second)
            .unwrap();
        // The run the copy reaches over is the run the page it came from spans.
        assert_eq!(cloned_first.continuation, page.chunks[0].continuation);
        assert_eq!(cloned_second.continuation, page.chunks[1].continuation);
        for descriptor in [cloned_first, cloned_second] {
            assert!(bundle
                .read_chunk(descriptor)
                .unwrap()
                .contains(&format!("data-hcd-source-part=\"{new_part}\"")));
        }
        assert_eq!(
            bundle.revision(1).unwrap().slide_copies[0].source_slide_part,
            "ppt/slides/slide1.xml"
        );
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_copy_twice_names_each_copy_by_its_own_part() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 2);
        apply_patch(&bundle, &copy_slide_patch(&slide_chunk(0), 0), 0).unwrap();
        let result = apply_patch(&bundle, &copy_slide_patch(&slide_chunk(0), 1), 1).unwrap();

        // The second copy stands right behind the page it was made from, ahead of
        // the copy made before it, and it is named by a part of its own — three
        // pages, no node id shared by any two of them.
        let first_copy = copied_chunk_id("deck", "ppt/slides/slide3.xml", 0);
        let second_copy = copied_chunk_id("deck", "ppt/slides/slide4.xml", 0);
        assert_eq!(result.dirty_chunk_ids, vec![second_copy.clone()]);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(0), second_copy, first_copy, slide_chunk(1)]
        );
        assert_eq!(bundle.manifest().unwrap().chunk_count, 4);
        // Two pages copied from one deck of two: four chunks, four node ids, and
        // no two of them the same.
        let ids = index_slide_node_ids(&bundle);
        assert_eq!(ids.len(), 4);
        let unique: HashSet<String> = ids.iter().cloned().collect();
        assert_eq!(unique.len(), 4, "{ids:?}");
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn pptx_slide_copy_refuses_a_page_hcd_created_or_hcd_rewrote() {
        let temp = tempfile::tempdir().unwrap();
        // A page HCD created has no page in the source package to copy from.
        let bundle = slide_deck(&temp.path().join("created"), 2);
        apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_41.to_string(),
                document_id: "deck".to_string(),
                patch_id: "add-one".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![crate::PatchOperation::PptxSlideAdd {}],
            },
            0,
        )
        .unwrap();
        let head = bundle.manifest().unwrap();
        let added = (0..head.index_page_count)
            .flat_map(|page| bundle.read_index_page(&head, page).unwrap().chunks)
            .find(|descriptor| {
                descriptor.region == "slide"
                    && bundle
                        .read_chunk(descriptor)
                        .unwrap()
                        .contains("ppt/slides/slide3.xml")
            })
            .expect("the created page is in the index");
        let error = apply_patch(&bundle, &copy_slide_patch(&added.chunk_id, 1), 1)
            .expect_err("a page the source package never had cannot be copied");
        assert!(error.to_string().contains("created in HCD"), "{error}");
        assert_eq!(bundle.manifest().unwrap().revision, 1);

        // A page HCD rewrote would be copied from the words the source package
        // still holds rather than the ones the bundle shows, so it waits.
        let other = slide_deck(&temp.path().join("rewrote"), 2);
        let node = get_text_node(&other, "n_00000000000000000000000000000000").unwrap();
        apply_patch(
            &other,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION.to_string(),
                document_id: "deck".to_string(),
                patch_id: "rewrite-page-0".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![crate::PatchOperation::TextSplice {
                    node_id: node.node.node_id.clone(),
                    start: 0,
                    delete_count: node.node.text.chars().count(),
                    insert_text: "changed".to_string(),
                    precondition: crate::NodePrecondition {
                        node_hash: node.node.node_hash.clone(),
                    },
                }],
            },
            0,
        )
        .unwrap();
        assert_eq!(
            other.revision(1).unwrap().dirty_source_parts,
            vec!["ppt/slides/slide1.xml".to_string()]
        );
        let error = apply_patch(&other, &copy_slide_patch(&slide_chunk(0), 1), 1)
            .expect_err("a rewritten page is not copied from the source package");
        assert!(error.to_string().contains("rewrote"), "{error}");
        // The page nobody typed into is still there to copy.
        apply_patch(&other, &copy_slide_patch(&slide_chunk(1), 1), 1).unwrap();
        assert_eq!(
            bundle.manifest().unwrap().chunk_count,
            3,
            "the refused copy left a chunk behind"
        );
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
        assert!(crate::validate_bundle(&other).unwrap().valid);
    }

    #[test]
    fn pptx_slide_copy_needs_the_page_and_the_version_it_addresses() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = slide_deck(&temp.path().join("bundle"), 2);
        for (patch_id, schema_version, chunk_id) in [
            (
                "old-version",
                crate::HCD_PATCH_SCHEMA_VERSION,
                slide_chunk(0),
            ),
            (
                "wrong-version",
                crate::HCD_PATCH_SCHEMA_VERSION_43,
                slide_chunk(0),
            ),
            (
                "short-id",
                crate::HCD_PATCH_SCHEMA_VERSION_44,
                "c_0".to_string(),
            ),
            (
                "uppercase-id",
                crate::HCD_PATCH_SCHEMA_VERSION_44,
                "c_0000000000000000000000000000000A".to_string(),
            ),
            (
                "other-chunk",
                crate::HCD_PATCH_SCHEMA_VERSION_44,
                "s_00000000000000000000000000000000".to_string(),
            ),
        ] {
            let error = apply_patch(
                &bundle,
                &crate::PatchBatch {
                    schema_version: schema_version.to_string(),
                    document_id: "deck".to_string(),
                    patch_id: patch_id.to_string(),
                    base_revision: bundle.manifest().unwrap().revision,
                    actor: BTreeMap::new(),
                    metadata: BTreeMap::new(),
                    operations: vec![crate::PatchOperation::PptxSlideCopy { chunk_id }],
                },
                0,
            )
            .expect_err("the patch was expected to be refused");
            assert!(
                matches!(error, HcdError::Unsupported(_) | HcdError::InvalidPatch(_)),
                "{patch_id}: unexpected {error:?}"
            );
        }

        // One operation per patch: a copy that also asks for another copy waits.
        let error = apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION_44.to_string(),
                document_id: "deck".to_string(),
                patch_id: "two-copies".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![
                    crate::PatchOperation::PptxSlideCopy {
                        chunk_id: slide_chunk(0),
                    },
                    crate::PatchOperation::PptxSlideCopy {
                        chunk_id: slide_chunk(1),
                    },
                ],
            },
            0,
        )
        .expect_err("a patch copies one page at a time");
        assert!(error.to_string().contains("one PPTX slide copy"), "{error}");

        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            index_chunk_order(&bundle),
            vec![slide_chunk(0), slide_chunk(1)]
        );
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

    #[test]
    fn freezing_a_worksheet_replaces_every_window_pane_and_reports_what_changed() {
        // Two windows of one worksheet, the first read straight out of a source
        // workbook that had been split by hand: state, absolute corner, and the
        // split written in twips, with no marker yet.
        let mut html = concat!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Overview\" data-hcd-row-start=\"1\" ",
            "data-hcd-pane-state=\"frozen-split\" data-hcd-pane-top-left-cell=\"$C$4\" ",
            "data-hcd-active-pane=\"bottom-right\" data-hcd-frozen-rows=\"1\" ",
            "data-hcd-split-x-twips=\"720\" data-hcd-split-y-twips=\"240\"></section>",
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Overview\" data-hcd-row-start=\"16\"></section>",
            "<section class=\"hcd-text\" data-hcd-node=\"n_00000000000000000000000000000001\"></section>",
        )
        .to_string();
        let (rewritten, windows) = freeze_xlsx_sheet_sections(&mut html, 2, 3).unwrap();
        assert_eq!(
            (rewritten, windows),
            (2, 2),
            "both windows of the sheet speak"
        );
        assert!(html.contains("data-hcd-pane-edited=\"true\""));
        assert!(html.contains("data-hcd-pane-state=\"frozen\""));
        assert!(html.contains("data-hcd-pane-top-left-cell=\"D3\""));
        assert!(html.contains("data-hcd-frozen-rows=\"2\""));
        assert!(html.contains("data-hcd-frozen-columns=\"3\""));
        assert!(html.contains("data-hcd-active-pane=\"bottom-right\""));
        // The split the source wrote by hand does not ride along behind a freeze,
        // and the sheet's own window attributes stay where they were.
        assert!(!html.contains("data-hcd-split-x-twips"));
        assert!(!html.contains("data-hcd-split-y-twips"));
        assert!(!html.contains("$C$4"));
        assert!(!html.contains("frozen-split"));
        assert!(html.contains("data-hcd-row-start=\"16\""));
        // A window of another chunk kind is left completely alone: the marker
        // lands on the two worksheet windows and nowhere else in the chunk.
        assert_eq!(html.matches("data-hcd-pane-edited=\"true\"").count(), 2);

        // Asking for the split the sheet already holds changes nothing, which is
        // what lets the patch refuse it instead of recording an empty revision.
        assert_eq!(freeze_xlsx_sheet_sections(&mut html, 2, 3).unwrap(), (0, 2));

        // Excel names only the side it splits, so a column-only freeze writes no
        // row count and the scrolling corner sits in the top right window.
        let mut column_only =
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Ledger\"></section>".to_string();
        assert_eq!(
            freeze_xlsx_sheet_sections(&mut column_only, 0, 1).unwrap(),
            (1, 1)
        );
        assert!(column_only.contains("data-hcd-pane-top-left-cell=\"B1\""));
        assert!(column_only.contains("data-hcd-active-pane=\"top-right\""));
        assert!(column_only.contains("data-hcd-frozen-columns=\"1\""));
        assert!(!column_only.contains("data-hcd-frozen-rows"));

        // Releasing takes the whole pane vocabulary with it but keeps the marker:
        // an export has to know this window spoke, not that it was never asked.
        let (released, windows) = freeze_xlsx_sheet_sections(&mut html, 0, 0).unwrap();
        assert_eq!((released, windows), (2, 2));
        assert!(html.contains("data-hcd-pane-edited=\"true\""));
        assert!(!html.contains("data-hcd-pane-state"));
        assert!(!html.contains("data-hcd-pane-top-left-cell"));
        assert!(!html.contains("data-hcd-active-pane"));
        assert!(!html.contains("data-hcd-frozen-"));
    }

    #[test]
    fn a_row_or_column_moved_through_a_frozen_band_moves_the_band_in_every_window() {
        // Two windows of one worksheet. The first carries a pane the history froze,
        // so its whole vocabulary is rebuilt from the moved counts; the second was
        // filled in from a source workbook that froze the sheet itself.
        let mut html = concat!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Overview\" data-hcd-row-start=\"1\" ",
            "data-hcd-pane-edited=\"true\" data-hcd-pane-state=\"frozen\" ",
            "data-hcd-pane-top-left-cell=\"B3\" data-hcd-active-pane=\"bottom-right\" ",
            "data-hcd-frozen-rows=\"2\" data-hcd-frozen-columns=\"1\"></section>",
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Overview\" data-hcd-row-start=\"21\" ",
            "data-hcd-pane-state=\"frozen\" data-hcd-pane-top-left-cell=\"A3\" ",
            "data-hcd-active-pane=\"bottom-left\" data-hcd-frozen-rows=\"2\"></section>",
            "<section class=\"hcd-text\" data-hcd-node=\"n_00000000000000000000000000000001\"></section>",
        )
        .to_string();

        // A row inserted at the top now stands inside the band, so the band holds
        // three frozen rows, in every window of the sheet and not only the one the
        // shift itself worked on.
        assert!(shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::InsertRow(1)).unwrap());
        assert_eq!(
            html.matches("data-hcd-frozen-rows=\"3\"").count(),
            2,
            "{html}"
        );
        // The window HCD wrote moves its corner along with the band, the way a
        // freeze writes it.
        assert!(html.contains("data-hcd-pane-top-left-cell=\"B4\""));
        assert!(html.contains("data-hcd-pane-state=\"frozen\""));
        assert!(html.contains("data-hcd-frozen-columns=\"1\""));
        // The window the importer filled in keeps the corner and the pane the
        // source workbook named: an export shifts that pane itself, so all this
        // window has to say is how wide the band became. It also keeps the absence
        // of a marker, which is what leaves the source part HCD's to copy.
        assert!(html.contains("data-hcd-pane-top-left-cell=\"A3\""));
        assert!(html.contains("data-hcd-active-pane=\"bottom-left\""));
        assert_eq!(html.matches("data-hcd-pane-edited=\"true\"").count(), 1);
        // A window of another chunk kind is not a worksheet window at all.
        assert_eq!(html.matches("data-hcd-sheet=").count(), 2);

        // Work below the band says nothing about it.
        assert!(!shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::InsertRow(9)).unwrap());
        // A column inserted inside the band widens that side, and the window HCD
        // wrote moves the corner it derives to the new column.
        assert!(shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::InsertColumn(1)).unwrap());
        assert_eq!(html.matches("data-hcd-frozen-columns=\"2\"").count(), 1);
        assert!(html.contains("data-hcd-pane-top-left-cell=\"C4\""));
        assert!(html.contains("data-hcd-active-pane=\"bottom-right\""));
        // A column deleted from inside the band narrows it back, and a row deleted
        // from inside it narrows the rows the same way.
        assert!(shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::DeleteColumn(2)).unwrap());
        assert!(shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::DeleteRow(2)).unwrap());
        assert_eq!(html.matches("data-hcd-frozen-rows=\"2\"").count(), 2);
        assert_eq!(html.matches("data-hcd-frozen-columns=\"1\"").count(), 1);

        // Deleting the last frozen row of a one-row band leaves no split at all:
        // the release vocabulary is what a patch that freezes nothing writes, so
        // the marker stays and the pane words go.
        let mut single = concat!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"Ledger\" ",
            "data-hcd-pane-edited=\"true\" data-hcd-pane-state=\"frozen\" ",
            "data-hcd-pane-top-left-cell=\"A2\" data-hcd-active-pane=\"bottom-left\" ",
            "data-hcd-frozen-rows=\"1\"></section>",
        )
        .to_string();
        assert!(shift_xlsx_pane_band(&mut single, XlsxPaneBandShift::DeleteRow(1)).unwrap());
        assert!(!single.contains("data-hcd-frozen-rows"), "{single}");
        assert!(!single.contains("data-hcd-pane-state"), "{single}");
        assert!(!single.contains("data-hcd-pane-top-left-cell"), "{single}");
        assert!(!single.contains("data-hcd-active-pane"), "{single}");
        assert!(single.contains("data-hcd-pane-edited=\"true\""), "{single}");
    }

    #[test]
    fn a_frozen_band_that_cannot_grow_past_its_sheet_is_refused_untouched() {
        let frozen_last_row = format!(
            "<section class=\"hcd-sheet\" data-hcd-frozen-rows=\"{XLSX_FROZEN_ROW_LIMIT}\"></section>"
        );
        let mut html = frozen_last_row.clone();
        let error = shift_xlsx_pane_band(&mut html, XlsxPaneBandShift::InsertRow(1)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("frozen band grows past the worksheet"),
            "{error}"
        );
        // A refusal leaves the window exactly as it arrived, so a chunk whose later
        // window could be moved is never half-written.
        assert_eq!(html, frozen_last_row);

        // The same bound on the other axis, and the count the export reads with:
        // past it a window names a band no worksheet can hold.
        let mut columns =
            "<section class=\"hcd-sheet\" data-hcd-frozen-columns=\"16383\"></section>".to_string();
        assert!(shift_xlsx_pane_band(&mut columns, XlsxPaneBandShift::InsertColumn(1)).is_err());
        // A count that is not a band — junk, or a number past what a sheet can
        // hold — is the workbook's own, and a shift applied here leaves it for the
        // export, which is the one that reads the pane the count came from.
        for unreadable in [
            "<section class=\"hcd-sheet\" data-hcd-frozen-rows=\"many\"></section>",
            "<section class=\"hcd-sheet\" data-hcd-frozen-rows=\"1048576\"></section>",
            "<section class=\"hcd-sheet\" data-hcd-frozen-rows=\"2\" \
             data-hcd-frozen-columns=\"max\"></section>",
        ] {
            let mut left_alone = unreadable.to_string();
            assert!(
                !shift_xlsx_pane_band(&mut left_alone, XlsxPaneBandShift::InsertRow(1)).unwrap(),
                "{left_alone}"
            );
            assert_eq!(left_alone, unreadable);
        }
        // A window that names no band has nothing to move.
        let mut split_only = "<section class=\"hcd-sheet\" data-hcd-pane-state=\"split\" \
                              data-hcd-split-y-twips=\"4400\"></section>"
            .to_string();
        assert!(!shift_xlsx_pane_band(&mut split_only, XlsxPaneBandShift::InsertRow(1)).unwrap());
    }

    fn pptx_align(horizontal: Option<&str>, vertical: Option<&str>) -> PptxShapeAlignPatch {
        PptxShapeAlignPatch {
            horizontal: horizontal.map(str::to_string),
            vertical: vertical.map(str::to_string),
        }
    }

    /// One slide with two text shapes: the first holds two paragraphs, the second
    /// carries the anchor the source workbook wrote for itself.
    fn two_shape_slide() -> String {
        concat!(
            "<section class=\"hcd-slide\" data-hcd-source-part=\"ppt/slides/slide1.xml\" ",
            "data-hcd-width-emu=\"9144000\" data-hcd-height-emu=\"6858000\">",
            "<div class=\"hcd-slide-shape\" data-hcd-id=\"n_9001\" data-hcd-shape-id=\"4\" ",
            "data-hcd-x-emu=\"914400\" data-hcd-y-emu=\"914400\" data-hcd-width-emu=\"1828800\" ",
            "data-hcd-height-emu=\"1828800\" style=\"position:absolute;left:9.60px;top:9.60px;",
            "width:19.20px;height:19.20px;overflow:hidden\">",
            "<p class=\"hcd-slide-text\"><span data-hcd-id=\"n_0001\" data-hcd-node-hash=\"a\">First",
            "</span></p>",
            "<p class=\"hcd-slide-text\" style=\"text-align:right\"><span data-hcd-id=\"n_0002\" ",
            "data-hcd-node-hash=\"b\">Second</span></p>",
            "</div>",
            "<div class=\"hcd-slide-shape\" data-hcd-id=\"n_9002\" data-hcd-shape-id=\"5\" ",
            "data-hcd-x-emu=\"914400\" data-hcd-y-emu=\"914400\" data-hcd-width-emu=\"1828800\" ",
            "data-hcd-height-emu=\"1828800\" style=\"position:absolute;left:9.60px;top:9.60px;",
            "width:19.20px;height:19.20px;overflow:hidden;display:flex;flex-direction:column;",
            "justify-content:flex-start\"><p class=\"hcd-slide-text\"><span data-hcd-id=\"n_0003\" ",
            "data-hcd-node-hash=\"c\">Other</span></p></div>",
            "</section>",
        )
        .to_string()
    }

    #[test]
    fn aligning_a_slide_text_shape_moves_every_paragraph_and_the_body_anchor() {
        // The request reaches the shape through one of its text nodes, but what it
        // restyles is the box: both paragraphs move to the middle and the shape's
        // own source anchor is replaced by the requested one.
        let mut html = two_shape_slide();
        update_pptx_shape_align(
            &mut html,
            "n_0002",
            &pptx_align(Some("center"), Some("center")),
        )
        .unwrap();
        assert_eq!(html.matches("data-hcd-align-edited=\"true\"").count(), 1);
        assert!(html.contains("data-hcd-horizontal=\"center\""));
        assert!(html.contains("data-hcd-vertical=\"center\""));
        assert_eq!(html.matches("text-align:center").count(), 2);
        assert!(!html.contains("text-align:right"));
        // The other shape keeps its own anchor and its paragraph keeps no alignment.
        assert_eq!(html.matches("justify-content:flex-start").count(), 1);
        assert_eq!(
            html.matches("<p class=\"hcd-slide-text\">").count(),
            1,
            "only the aligned shape's paragraphs speak"
        );
        let aligned_shape = html
            .split("<div class=\"hcd-slide-shape\" data-hcd-id=\"n_9002\"")
            .next()
            .expect("both shapes")
            .to_string();
        assert!(aligned_shape.contains("display:flex"));
        assert!(aligned_shape.contains("flex-direction:column"));
        assert!(aligned_shape.contains("justify-content:center"));

        // A second request naming one axis keeps the other where the shape left it.
        update_pptx_shape_align(&mut html, "n_0001", &pptx_align(Some("left"), None)).unwrap();
        assert!(html.contains("data-hcd-horizontal=\"left\""));
        assert!(html.contains("data-hcd-vertical=\"center\""));
        assert_eq!(html.matches("text-align:left").count(), 2);
        assert_eq!(html.matches("data-hcd-align-edited=\"true\"").count(), 1);

        // Asking for what the box already holds would record a revision that says
        // nothing, so the patch refuses it instead.
        let error = update_pptx_shape_align(&mut html, "n_0001", &pptx_align(Some("left"), None))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PPTX shape alignment is unchanged"),
            "{error}"
        );
        assert!(
            update_pptx_shape_align(&mut html, "n_0001", &pptx_align(None, Some("bottom"))).is_ok()
        );
        assert!(html.contains("data-hcd-horizontal=\"left\""));
        assert!(html.contains("justify-content:flex-end"));
    }

    #[test]
    fn a_shape_alignment_that_finds_no_box_or_reads_junk_is_refused() {
        // Distributed alignment writes the value the package names, even though
        // the page shows the same block as justified text.
        let mut html = two_shape_slide();
        update_pptx_shape_align(&mut html, "n_0001", &pptx_align(Some("distributed"), None))
            .unwrap();
        assert!(html.contains("data-hcd-horizontal=\"distributed\""));
        assert_eq!(html.matches("text-align:justify").count(), 2);

        // A shape whose stored value is not one this op can write is not guessed
        // at: the bundle is the problem, and saying so beats writing a third value.
        let mut junk = String::from(
            "<section class=\"hcd-slide\" data-hcd-source-part=\"ppt/slides/slide1.xml\"><div \
             class=\"hcd-slide-shape\" data-hcd-id=\"n_9001\" data-hcd-align-edited=\"true\" \
             data-hcd-horizontal=\"sideways\"><p class=\"hcd-slide-text\"><span \
             data-hcd-id=\"n_0001\">First</span></p></div></section>",
        );
        let error = update_pptx_shape_align(&mut junk, "n_0001", &pptx_align(None, Some("top")))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PPTX stored data-hcd-horizontal is invalid"),
            "{error}"
        );

        // Text that stands outside a positioned shape has no box to align.
        let mut loose = String::from(
            "<section class=\"hcd-slide\" data-hcd-source-part=\"ppt/slides/slide1.xml\"><p \
             class=\"hcd-slide-text\"><span data-hcd-id=\"n_0001\">First</span></p></section>",
        );
        let error =
            update_pptx_shape_align(&mut loose, "n_0001", &pptx_align(Some("center"), None))
                .unwrap_err();
        assert!(matches!(error, HcdError::Unsupported(_)), "{error:?}");
        assert!(
            error
                .to_string()
                .contains("PPTX text is not inside a positioned shape"),
            "{error}"
        );

        // The request itself has to name an axis, and only the axes it knows.
        assert!(validate_pptx_shape_align(&pptx_align(None, None)).is_err());
        let error = validate_pptx_shape_align(&pptx_align(Some("middle"), None)).unwrap_err();
        assert!(
            error.to_string().contains(
                "PPTX horizontal alignment must be left, center, right, justify, or distributed"
            ),
            "{error}"
        );
        let error = validate_pptx_shape_align(&pptx_align(None, Some("left"))).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("PPTX vertical alignment must be top, center, or bottom"),
            "{error}"
        );
    }
}
