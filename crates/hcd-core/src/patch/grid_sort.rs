use super::{apply_patch, valid_xlsx_number, xlsx_attribute, xlsx_cells, MAX_PATCH_OPERATIONS};
use crate::{
    extract_html_text_nodes, hash_bytes, ApplyResult, Bundle, GridChunkKind, HcdError,
    NodePrecondition, PatchBatch, PatchOperation, HCD_PATCH_SCHEMA_VERSION,
    HCD_PATCH_SCHEMA_VERSION_29,
};
use serde::Deserialize;
use std::{cmp::Ordering, collections::HashMap};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridSortDirection {
    Ascending,
    Descending,
}

/// Coordinates are one-based. The first selected row is left in place when
/// `has_header` is true. Cell formats and coordinate-based references stay put.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSortRequest {
    pub patch_id: String,
    pub base_revision: u64,
    pub sheet_id: String,
    pub start_row: u32,
    pub end_row: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub sort_column: u32,
    pub has_header: bool,
    pub direction: GridSortDirection,
}

struct Cell<'a> {
    node_id: &'a str,
    node_hash: &'a str,
    text: &'a str,
    number: Option<&'a str>,
}

enum SortKey {
    Blank,
    Number(f64),
    Text(String),
}

impl SortKey {
    fn compare(&self, other: &Self, direction: GridSortDirection) -> Ordering {
        let order = match (self, other) {
            (Self::Blank, Self::Blank) => return Ordering::Equal,
            (Self::Blank, _) => return Ordering::Greater,
            (_, Self::Blank) => return Ordering::Less,
            (Self::Number(left), Self::Number(right)) => {
                left.partial_cmp(right).expect("validated finite numbers")
            }
            (Self::Text(left), Self::Text(right)) => left.cmp(right),
            (Self::Number(_), Self::Text(_)) => Ordering::Less,
            (Self::Text(_), Self::Number(_)) => Ordering::Greater,
        };
        match direction {
            GridSortDirection::Ascending => order,
            GridSortDirection::Descending => order.reverse(),
        }
    }
}

pub fn sort_grid(
    bundle: &Bundle,
    request: GridSortRequest,
) -> Result<Option<ApplyResult>, HcdError> {
    let first_data_row = request
        .start_row
        .saturating_add(u32::from(request.has_header));
    if request.start_row == 0
        || first_data_row >= request.end_row
        || request.end_row > 1_048_576
        || request.end_row - request.start_row >= 500
        || request.start_column == 0
        || request.end_column > 16_384
        || !(request.start_column..=request.end_column).contains(&request.sort_column)
    {
        return Err(HcdError::InvalidPatch(
            "Select a range of up to 500 rows with at least two data rows and a sort column".into(),
        ));
    }
    let width = (request.end_column - request.start_column + 1) as usize;
    let height = (request.end_row - first_data_row + 1) as usize;
    if width * height > MAX_PATCH_OPERATIONS {
        return Err(HcdError::ResourceLimit(
            "Sort range exceeds 10,000 cells".into(),
        ));
    }
    super::validate_identifier("patchId", &request.patch_id)?;
    let manifest = bundle.manifest()?;
    if !manifest.source.is_spreadsheet() {
        return Err(HcdError::Unsupported(
            "Sorting requires a spreadsheet".into(),
        ));
    }
    if manifest.revision != request.base_revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {}, actual {}",
            request.base_revision, manifest.revision
        )));
    }
    let selection = crate::WorksheetChartRange {
        start_row: first_data_row,
        end_row: request.end_row,
        start_column: request.start_column,
        end_column: request.end_column,
    };
    if crate::worksheet_pivots(bundle, &manifest)?
        .into_iter()
        .any(|(grid, pivot)| {
            grid.sheet_id == request.sheet_id
                && (crate::pivot_output_range(&pivot)
                    .is_some_and(|range| range.overlaps(selection))
                    || pivot
                        .origin
                        .is_some_and(|origin| origin.range.overlaps(selection)))
        })
    {
        return Err(HcdError::PreconditionFailed(
            "Sort the data source of the PivotTable instead of its result".into(),
        ));
    }
    let mut chunks = Vec::new();
    let mut bytes = 0;
    let mut found_sheet = false;
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            let Some(grid) = descriptor.grid.as_ref().filter(|grid| {
                grid.sheet_id == request.sheet_id && grid.kind == GridChunkKind::Cells
            }) else {
                continue;
            };
            found_sheet = true;
            if grid
                .row_start
                .is_some_and(|row| row <= u64::from(request.end_row))
                && grid
                    .row_end
                    .is_some_and(|row| row >= u64::from(first_data_row))
            {
                bytes += descriptor.byte_length;
                if bytes > 32 * 1024 * 1024 {
                    return Err(HcdError::ResourceLimit(
                        "Sort range spans too much worksheet data".into(),
                    ));
                }
                let html = bundle.read_chunk(&descriptor)?;
                let map = bundle.read_map(&descriptor)?;
                chunks.push((html, map));
            }
        }
    }
    if !found_sheet {
        return Err(HcdError::InvalidPatch(
            "Sort worksheet does not exist".into(),
        ));
    }
    let mut cells: Vec<Option<Cell<'_>>> = (0..width * height).map(|_| None).collect();
    let mut text_maps = Vec::with_capacity(chunks.len());
    for (html, _) in &chunks {
        text_maps.push(extract_html_text_nodes(html)?);
    }
    for ((html, map), texts) in chunks.iter().zip(&text_maps) {
        let source_nodes: HashMap<_, _> = map
            .entries
            .iter()
            .map(|entry| (entry.node_id.as_str(), entry))
            .collect();
        for span in xlsx_cells(html)? {
            if span
                .merged_range
                .is_some_and(|(row, column, end_row, end_column)| {
                    row <= request.end_row
                        && end_row >= first_data_row
                        && column <= request.end_column
                        && end_column >= request.start_column
                })
            {
                return Err(HcdError::Unsupported(
                    "Sort range intersects merged cells".into(),
                ));
            }
            if !(first_data_row..=request.end_row).contains(&span.row)
                || !(request.start_column..=request.end_column).contains(&span.column)
                || !span.has_node
            {
                continue;
            }
            let tag = &html[span.start..=span.tag_end];
            let body = &html[span.tag_end + 1..span.end];
            let node_id = xlsx_attribute(body, "data-hcd-id")
                .ok_or_else(|| HcdError::InvalidBundle("Sort cell has no mapped node ID".into()))?;
            let entry = source_nodes.get(node_id).ok_or_else(|| {
                HcdError::InvalidBundle("Sort cell is missing from its source map".into())
            })?;
            let text = texts
                .get(node_id)
                .ok_or_else(|| HcdError::InvalidBundle("Sort cell has no mapped text".into()))?;
            let number =
                xlsx_attribute(tag, "data-hcd-raw-value").filter(|value| !value.is_empty());
            if !entry.source.editable || xlsx_attribute(tag, "data-hcd-formula") == Some("true") {
                return Err(HcdError::Unsupported(
                    "Sort range contains a formula".into(),
                ));
            }
            if xlsx_attribute(tag, "data-hcd-sortable") == Some("false")
                || number.is_some_and(|value| !valid_xlsx_number(value))
            {
                return Err(HcdError::Unsupported(
                    "Sort range contains an unsupported cell type".into(),
                ));
            }
            if manifest.source.format == "xlsx"
                && !entry.source.created_in_hcd
                && number.is_none()
                && xlsx_attribute(tag, "data-hcd-sortable").is_none()
            {
                return Err(HcdError::Unsupported(
                    "Reimport this XLSX to sort its original text cells".into(),
                ));
            }
            if hash_bytes(text.as_bytes()) != entry.node_hash {
                return Err(HcdError::InvalidBundle(
                    "Sort cell text fails its source-map hash".into(),
                ));
            }
            let index = (span.row - first_data_row) as usize * width
                + (span.column - request.start_column) as usize;
            if cells[index]
                .replace(Cell {
                    node_id,
                    node_hash: &entry.node_hash,
                    text,
                    number,
                })
                .is_some()
            {
                return Err(HcdError::InvalidBundle(
                    "Sort range contains duplicate cells".into(),
                ));
            }
        }
    }
    let key_column = (request.sort_column - request.start_column) as usize;
    let rows: Vec<_> = cells.chunks_exact(width).collect();
    let mut order: Vec<_> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let key = match &row[key_column] {
                Some(cell) if cell.number.is_some() => SortKey::Number(
                    cell.number
                        .expect("number present")
                        .parse()
                        .expect("validated number"),
                ),
                Some(cell) if !cell.text.is_empty() => SortKey::Text(cell.text.to_lowercase()),
                _ => SortKey::Blank,
            };
            (index, key)
        })
        .collect();
    order.sort_by(|(_, left), (_, right)| left.compare(right, request.direction));

    let mut operations = Vec::new();
    let mut has_number = false;
    for (target, (source, _)) in rows.iter().zip(order) {
        for (destination, value) in target.iter().zip(rows[source]) {
            let (destination, value) = match (destination, value) {
                (Some(destination), Some(value)) => (destination, value),
                (None, None) => continue,
                _ => return Err(HcdError::Unsupported(
                    "Sort would move values into or out of empty cells. Select a complete data range".into(),
                )),
            };
            let precondition = NodePrecondition {
                node_hash: destination.node_hash.to_string(),
            };
            match value.number {
                Some(value) if destination.number != Some(value) => {
                    has_number = true;
                    operations.push(PatchOperation::XlsxNumberSet {
                        node_id: destination.node_id.into(),
                        sheet_id: request.sheet_id.clone(),
                        value: value.into(),
                        precondition,
                    });
                }
                None if destination.number.is_some() || destination.text != value.text => {
                    operations.push(PatchOperation::TextSplice {
                        node_id: destination.node_id.into(),
                        start: 0,
                        delete_count: destination.text.chars().count(),
                        insert_text: value.text.into(),
                        precondition,
                    });
                }
                _ => {}
            }
        }
    }
    if operations.is_empty() {
        return Ok(None);
    }
    let patch = PatchBatch {
        schema_version: if has_number {
            HCD_PATCH_SCHEMA_VERSION_29
        } else {
            HCD_PATCH_SCHEMA_VERSION
        }
        .into(),
        document_id: manifest.document_id,
        patch_id: request.patch_id,
        base_revision: request.base_revision,
        actor: Default::default(),
        operations,
        metadata: [("gridValuesReordered".into(), "true".into())].into(),
    };
    apply_patch(bundle, &patch, request.base_revision).map(Some)
}
