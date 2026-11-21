use super::*;
use crate::{
    GridChunkAddress, GridChunkKind, HcdManifest, PivotCell, PivotSnapshot, WorksheetChartRange,
    WorksheetPivot, WorksheetPivotConfig, XlsxGridAction, XlsxGridAxis,
};

const LAST_ROW: u32 = 1_048_576;
const LAST_COLUMN: u32 = 16_384;
const MAX_PIVOTS: usize = 12;
const MAX_RESULT_CELLS: usize = 4096;
const MAX_RESULT_BYTES: usize = 384 * 1024;

pub fn validate_worksheet_pivot(config: &WorksheetPivotConfig) -> Result<(), HcdError> {
    validate_identifier("sourceSheetId", &config.source_sheet_id)?;
    let range = config.source_range;
    let width = range.end_column.saturating_sub(range.start_column) + 1;
    let height = range.end_row.saturating_sub(range.start_row) + 1;
    let axes: BTreeSet<_> = config.rows.iter().chain(&config.columns).copied().collect();
    let measures: BTreeSet<_> = config.values.iter().collect();
    if config.name.trim().is_empty()
        || config.name.chars().count() > 120
        || config
            .name
            .chars()
            .any(|ch| ch.is_control() || is_forbidden_xml_character(ch))
        || range.start_row == 0
        || range.end_row <= range.start_row
        || range.end_row > LAST_ROW
        || range.start_column == 0
        || range.end_column < range.start_column
        || range.end_column > LAST_COLUMN
        || width > 64
        || u64::from(width) * u64::from(height) > 20_000
        || !(1..=LAST_ROW).contains(&config.anchor_row)
        || !(1..=LAST_COLUMN).contains(&config.anchor_column)
        || config.rows.len() > 8
        || config.columns.len() > 8
        || axes.len() != config.rows.len() + config.columns.len()
        || axes.iter().any(|field| *field >= width)
        || !(1..=8).contains(&config.values.len())
        || measures.len() != config.values.len()
        || config.values.iter().any(|value| value.field >= width)
    {
        return Err(HcdError::InvalidPatch(
            "pivot requires one header row and data (up to 64 fields and 20000 cells), distinct dimensions, and 1–8 aggregation fields".into(),
        ));
    }
    Ok(())
}

impl WorksheetChartRange {
    pub fn overlaps(self, other: Self) -> bool {
        self.start_row <= other.end_row
            && other.start_row <= self.end_row
            && self.start_column <= other.end_column
            && other.start_column <= self.end_column
    }
    pub fn contains_cell(self, row: u32, column: u32) -> bool {
        (self.start_row..=self.end_row).contains(&row)
            && (self.start_column..=self.end_column).contains(&column)
    }
}

pub fn pivot_output_range(pivot: &WorksheetPivot) -> Option<WorksheetChartRange> {
    if pivot.removed {
        return None;
    }
    if let Some(snapshot) = &pivot.snapshot {
        let width = u32::try_from(snapshot.report.cells.first()?.len()).ok()?;
        let height = u32::try_from(snapshot.report.cells.len()).ok()?;
        Some(WorksheetChartRange {
            start_row: pivot.config.anchor_row,
            start_column: pivot.config.anchor_column,
            end_row: pivot
                .config
                .anchor_row
                .checked_add(height.checked_sub(1)?)?,
            end_column: pivot
                .config
                .anchor_column
                .checked_add(width.checked_sub(1)?)?,
        })
    } else {
        pivot.origin.as_ref().map(|source| source.range)
    }
}

/// The report owns its current area and the original area that export clears.
fn protected_ranges(pivot: &WorksheetPivot) -> impl Iterator<Item = WorksheetChartRange> + '_ {
    pivot_output_range(pivot)
        .into_iter()
        .chain(pivot.origin.as_ref().map(|source| source.range))
}

fn validate_snapshot(
    snapshot: &PivotSnapshot,
    config: &WorksheetPivotConfig,
    revision: u64,
) -> Result<(), HcdError> {
    let report = &snapshot.report;
    let width = report.cells.first().map_or(0, Vec::len);
    let height = report.cells.len();
    if snapshot.source_revision != revision
        || &snapshot.source_config != config
        || width == 0
        || height == 0
        || width.saturating_mul(height) > MAX_RESULT_CELLS
        || report.header_rows as usize >= height
        || report.label_columns as usize >= width
        || config.anchor_row as usize + height - 1 > LAST_ROW as usize
        || config.anchor_column as usize + width - 1 > LAST_COLUMN as usize
        || report.cells.iter().any(|row| row.len() != width)
        || report.cells.iter().flatten().any(|cell| match cell {
            PivotCell::Text(value) | PivotCell::Error(value) => {
                value.chars().any(is_forbidden_xml_character)
            }
            PivotCell::Number(value) => !value.parse::<f64>().is_ok_and(f64::is_finite),
            _ => false,
        })
        || serde_json::to_vec(report)?.len() > MAX_RESULT_BYTES
    {
        return Err(HcdError::InvalidPatch(
            "pivot result is inconsistent or exceeds the worksheet or report limits".into(),
        ));
    }
    Ok(())
}

pub fn worksheet_pivots(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Vec<(GridChunkAddress, WorksheetPivot)>, HcdError> {
    let mut results = Vec::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            if let Some(mut grid) = descriptor.grid {
                let pivots = std::mem::take(&mut grid.pivots);
                results.extend(pivots.into_iter().map(|pivot| (grid.clone(), pivot)));
            }
        }
    }
    Ok(results)
}

type GridShift<'a> = (&'a str, XlsxGridAxis, XlsxGridAction, u32, u32);

fn grid_shift(operation: &PatchOperation) -> Option<GridShift<'_>> {
    use XlsxGridAction::{Delete, Insert};
    use XlsxGridAxis::{Column, Row};
    match operation {
        PatchOperation::XlsxRowInsert {
            sheet_id,
            before_row,
        } => Some((sheet_id, Row, Insert, *before_row, 1)),
        PatchOperation::XlsxRowDelete { sheet_id, row }
        | PatchOperation::XlsxRowRemoveLast { sheet_id, row } => {
            Some((sheet_id, Row, Delete, *row, 1))
        }
        PatchOperation::XlsxColumnInsert {
            sheet_id,
            before_column,
        } => Some((sheet_id, Column, Insert, *before_column, 1)),
        PatchOperation::XlsxColumnDelete { sheet_id, column } => {
            Some((sheet_id, Column, Delete, *column, 1))
        }
        PatchOperation::XlsxGridRange {
            sheet_id,
            axis,
            action,
            start,
            count,
        } => Some((sheet_id, *axis, *action, *start, *count)),
        _ => None,
    }
}

fn shift_bounds(
    range: &mut WorksheetChartRange,
    shift: GridShift<'_>,
    whole: bool,
) -> Result<(), HcdError> {
    let (_, axis, action, at, count) = shift;
    let (low, high, limit) = match axis {
        XlsxGridAxis::Row => (&mut range.start_row, &mut range.end_row, LAST_ROW),
        XlsxGridAxis::Column => (&mut range.start_column, &mut range.end_column, LAST_COLUMN),
    };
    let locked = || {
        HcdError::PreconditionFailed(
        "This row or column operation would split a PivotTable result or change its source fields. Move or reselect the PivotTable first.".into(),
    )
    };
    match action {
        XlsxGridAction::Insert if at <= *low => {
            if high.saturating_add(count) > limit {
                return Err(locked());
            }
            *low += count;
            *high += count;
        }
        XlsxGridAction::Insert if at <= *high => {
            if whole || axis == XlsxGridAxis::Column || high.saturating_add(count) > limit {
                return Err(locked());
            }
            *high += count;
        }
        XlsxGridAction::Delete if at.saturating_add(count - 1) < *low => {
            *low -= count;
            *high -= count;
        }
        XlsxGridAction::Delete if at <= *high => {
            if whole || axis == XlsxGridAxis::Column || at <= *low {
                return Err(locked());
            }
            *high -= (*high - at + 1).min(count);
        }
        _ => {}
    }
    Ok(())
}

fn apply_grid_shift(
    target: &str,
    pivot: &mut WorksheetPivot,
    shift: GridShift<'_>,
) -> Result<(), HcdError> {
    if target == shift.0 {
        if let Some(mut output) = pivot_output_range(pivot) {
            shift_bounds(&mut output, shift, true)?;
            pivot.config.anchor_row = output.start_row;
            pivot.config.anchor_column = output.start_column;
        }
        if let Some(origin) = &mut pivot.origin {
            let before = origin.range;
            shift_bounds(&mut origin.range, shift, true)?;
            // The source-native cache still names the original area. A source
            // pivot has to be refreshed before a structural change moves it.
            if before != origin.range && pivot.snapshot.is_none() && !pivot.removed {
                return Err(HcdError::PreconditionFailed(
                    "Refresh the imported PivotTable before moving its output".into(),
                ));
            }
        }
    }
    if !pivot.removed && pivot.config.source_sheet_id == shift.0 {
        let mut updated = pivot.config.source_range;
        shift_bounds(&mut updated, shift, false)?;
        if updated != pivot.config.source_range && pivot.snapshot.is_none() {
            return Err(HcdError::PreconditionFailed(
                "Refresh the imported PivotTable before changing its source range".into(),
            ));
        }
        pivot.config.source_range = updated;
        validate_worksheet_pivot(&pivot.config)?;
    }
    Ok(())
}

fn write_intersects(operation: &PatchOperation, sheet: &str, target: WorksheetChartRange) -> bool {
    let (sheet_id, area) = match operation {
        PatchOperation::XlsxCellSet {
            sheet_id,
            row,
            column,
            ..
        }
        | PatchOperation::XlsxFormulaCreate {
            sheet_id,
            row,
            column,
            ..
        }
        | PatchOperation::XlsxRichTextCreate {
            sheet_id,
            row,
            column,
            ..
        } => return sheet_id == sheet && target.contains_cell(*row, *column),
        PatchOperation::XlsxMerge {
            sheet_id,
            start_row,
            start_column,
            end_row,
            end_column,
            ..
        }
        | PatchOperation::XlsxMergeBlank {
            sheet_id,
            start_row,
            start_column,
            end_row,
            end_column,
        }
        | PatchOperation::XlsxUnmerge {
            sheet_id,
            start_row,
            start_column,
            end_row,
            end_column,
            ..
        } => (
            sheet_id,
            WorksheetChartRange {
                start_row: *start_row,
                start_column: *start_column,
                end_row: *end_row,
                end_column: *end_column,
            },
        ),
        _ => return false,
    };
    sheet_id == sheet && target.overlaps(area)
}

pub(super) fn resolve_pivot_changes(
    bundle: &Bundle,
    manifest: &HcdManifest,
    patch: &PatchBatch,
    snapshot: Option<PivotSnapshot>,
) -> Result<HashMap<String, Vec<WorksheetPivot>>, HcdError> {
    if manifest.source.format != "xlsx" {
        return Ok(HashMap::new());
    }
    let action = match patch.operations.as_slice() {
        [PatchOperation::XlsxPivotSet {
            sheet_id,
            pivot_id,
            config,
        }] => Some((sheet_id, pivot_id, config)),
        _ => None,
    };
    let shift = patch.operations.iter().find_map(grid_shift);
    let changed_nodes: HashSet<_> = patch
        .operations
        .iter()
        .filter(|op| op.is_content_change())
        .filter_map(PatchOperation::node_id)
        .collect();
    let mut pivot_grids = HashMap::new();
    let mut windows = Vec::new();
    let mut sheets = HashMap::new();
    let mut protected_sheets = HashSet::new();
    for page in 0..manifest.index_page_count {
        for mut descriptor in bundle.read_index_page(manifest, page)?.chunks {
            let Some(grid) = &mut descriptor.grid else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            if action.is_some() {
                sheets
                    .entry(grid.sheet_id.clone())
                    .or_insert_with(|| descriptor.chunk_id.clone());
            }
            if !grid.pivots.is_empty() {
                protected_sheets.insert(grid.sheet_id.clone());
                pivot_grids.insert(
                    descriptor.chunk_id.clone(),
                    (grid.sheet_id.clone(), std::mem::take(&mut grid.pivots)),
                );
            }
            if protected_sheets.contains(&grid.sheet_id)
                && changed_nodes
                    .iter()
                    .any(|id| node_bloom_might_contain(&descriptor.node_bloom, id))
            {
                windows.push(descriptor);
            }
        }
    }
    let mut changes = HashMap::new();
    if let Some((sheet, id, configuration)) = action {
        let chunk_id = sheets
            .get(sheet)
            .ok_or_else(|| HcdError::NodeNotFound(sheet.clone()))?;
        let mut set = pivot_grids
            .get(chunk_id)
            .map(|(_, entries)| entries.clone())
            .unwrap_or_default();
        let existing = set
            .iter()
            .position(|pivot| pivot.id == *id && !pivot.removed);
        if let Some(config) = configuration {
            if !sheets.contains_key(&config.source_sheet_id) {
                return Err(HcdError::NodeNotFound(config.source_sheet_id.clone()));
            }
            if pivot_grids.values().flat_map(|(_, set)| set).any(|pivot| {
                !pivot.removed
                    && pivot.id != *id
                    && pivot.config.name.eq_ignore_ascii_case(&config.name)
            }) {
                return Err(HcdError::PreconditionFailed(
                    "PivotTable names must be unique in the workbook".into(),
                ));
            }
            let snapshot = snapshot.ok_or_else(|| {
                HcdError::InvalidPatch("PivotTable requires a computed snapshot".into())
            })?;
            validate_snapshot(&snapshot, config, patch.base_revision)?;
            let origin = existing.and_then(|index| set[index].origin.clone());
            let new = WorksheetPivot {
                id: id.clone(),
                config: config.clone(),
                snapshot: Some(snapshot),
                origin,
                removed: false,
            };
            let area = pivot_output_range(&new).expect("validated pivot output");
            if sheet == &config.source_sheet_id && area.overlaps(config.source_range)
                || set
                    .iter()
                    .filter(|p| p.id != *id)
                    .flat_map(protected_ranges)
                    .any(|other| area.overlaps(other))
            {
                return Err(HcdError::PreconditionFailed(
                    "PivotTable output overlaps its data source or another report".into(),
                ));
            }
            if let Some(index) = existing {
                set[index] = new;
            } else {
                if set.len() >= MAX_PIVOTS {
                    return Err(HcdError::ResourceLimit(
                        "worksheet pivot count exceeds 12".into(),
                    ));
                }
                set.push(new);
            }
        } else {
            let index = existing.ok_or_else(|| HcdError::NodeNotFound(id.clone()))?;
            if set[index].origin.is_some() {
                set[index].removed = true;
                set[index].snapshot = None;
            } else {
                set.remove(index);
            }
        }
        changes.insert(chunk_id.clone(), set);
        return Ok(changes);
    }
    let protected = |sheet: &str, area: WorksheetChartRange| -> Result<(), HcdError> {
        let readonly = || {
            HcdError::PreconditionFailed(
                "Edit the PivotTable source or its fields instead of writing into its result"
                    .into(),
            )
        };
        if patch
            .operations
            .iter()
            .any(|operation| write_intersects(operation, sheet, area))
        {
            return Err(readonly());
        }
        for descriptor in &windows {
            let grid = descriptor.grid.as_ref().expect("cell grid");
            if grid.sheet_id != sheet
                || !grid
                    .row_start
                    .zip(grid.row_end)
                    .is_some_and(|(first, last)| {
                        first <= u64::from(area.end_row) && last >= u64::from(area.start_row)
                    })
            {
                continue;
            }
            let map = bundle.read_map(descriptor)?;
            if map.entries.iter().any(|entry| {
                changed_nodes.contains(entry.node_id.as_str())
                    && entry
                        .source
                        .paragraph_id
                        .as_deref()
                        .and_then(xlsx_cell_coordinates)
                        .is_some_and(|(row, col)| area.contains_cell(row, col))
            }) {
                return Err(readonly());
            }
        }
        Ok(())
    };
    for (chunk_id, (sheet, mut set)) in pivot_grids {
        for pivot in &set {
            if !pivot.removed && pivot.config.source_sheet_id != sheet
                && patch.operations.iter().any(|operation|
                    matches!(operation, PatchOperation::XlsxSheetDelete { sheet_id } if sheet_id == &pivot.config.source_sheet_id)
                )
            {
                return Err(HcdError::PreconditionFailed("This worksheet is the data source of a PivotTable".into()));
            }
            for area in protected_ranges(pivot) {
                protected(&sheet, area)?;
            }
        }
        if let Some(shift) = shift {
            let mut changed = false;
            for pivot in &mut set {
                let previous = (pivot.config.clone(), pivot.origin.clone());
                apply_grid_shift(&sheet, pivot, shift)?;
                changed |= pivot.config != previous.0 || pivot.origin != previous.1;
            }
            if changed {
                changes.insert(chunk_id, set);
            }
        }
    }
    Ok(changes)
}
