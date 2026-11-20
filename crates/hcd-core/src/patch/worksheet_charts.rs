use super::*;
use crate::{
    GridChunkAddress, GridChunkKind, HcdManifest, WorksheetChart, WorksheetChartConfig,
    WorksheetChartKind, XlsxGridAction, XlsxGridAxis,
};

const LAST_ROW: u32 = 1_048_576;
const LAST_COLUMN: u32 = 16_384;
const MAX_CHARTS_PER_SHEET: usize = 64;

pub fn valid_worksheet_chart_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
}

pub fn validate_worksheet_chart(config: &WorksheetChartConfig) -> Result<(), HcdError> {
    let range = config.range;
    if range.start_row == 0
        || range.end_row <= range.start_row
        || range.end_row > LAST_ROW
        || range.end_row - range.start_row > 200
        || range.start_column == 0
        || range.end_column <= range.start_column
        || range.end_column > LAST_COLUMN
        || range.end_column - range.start_column > 8
        || config.kind == WorksheetChartKind::Pie && range.end_column - range.start_column != 1
        || !(1..=LAST_ROW).contains(&config.anchor_row)
        || !(1..=LAST_COLUMN).contains(&config.anchor_column)
        || config.title.trim().is_empty()
        || config.title.chars().count() > 100
        || config
            .title
            .chars()
            .any(|ch| is_forbidden_xml_character(ch) || ch.is_control())
    {
        return Err(HcdError::InvalidPatch(
            "chart requires a title, a header row, 1–200 data rows, and categories plus 1–8 series; pie charts require one series".into(),
        ));
    }
    Ok(())
}

pub(super) struct ChartChange {
    pub chunk_id: String,
    pub charts: Vec<WorksheetChart>,
}

pub(super) fn resolve_chart_change(
    bundle: &Bundle,
    manifest: &HcdManifest,
    patch: &PatchBatch,
) -> Result<Option<ChartChange>, HcdError> {
    let Some(PatchOperation::XlsxChartSet {
        sheet_id,
        chart_id,
        config,
    }) = patch.operations.first()
    else {
        return Ok(None);
    };
    let mut first = None;
    let mut found = None;
    let mut count = 0;
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, index)?.chunks {
            let Some(grid) = descriptor.grid else {
                continue;
            };
            if grid.sheet_id == *sheet_id {
                count += grid.charts.iter().filter(|chart| !chart.removed).count();
                if let Some(position) = grid.charts.iter().position(|chart| chart.id == *chart_id) {
                    if found
                        .replace((descriptor.chunk_id.clone(), grid.charts.clone(), position))
                        .is_some()
                    {
                        return Err(HcdError::InvalidBundle(
                            "duplicate worksheet chart id".into(),
                        ));
                    }
                }
                if first.is_none() && grid.kind == GridChunkKind::Cells {
                    first = Some((descriptor.chunk_id, grid.charts));
                }
            } else if grid.charts.iter().any(|chart| chart.id == *chart_id) {
                return Err(HcdError::InvalidPatch(
                    "chart id belongs to a different worksheet".into(),
                ));
            }
        }
    }
    if let Some((chunk_id, mut charts, position)) = found {
        let chart = &mut charts[position];
        if chart.removed {
            return Err(HcdError::PreconditionFailed(
                "worksheet chart was removed".into(),
            ));
        }
        match config {
            Some(config) => {
                if &chart.config == config && !chart.source_missing {
                    return Err(HcdError::PreconditionFailed(
                        "worksheet chart is unchanged".into(),
                    ));
                }
                chart.config = config.clone();
                chart.source_missing = false;
                chart.edited = true;
            }
            None if chart.imported => {
                chart.removed = true;
                chart.edited = true;
            }
            None => {
                charts.remove(position);
            }
        }
        return Ok(Some(ChartChange { chunk_id, charts }));
    }
    let (chunk_id, mut charts) = first.ok_or_else(|| HcdError::NodeNotFound(sheet_id.clone()))?;
    let config = config
        .as_ref()
        .ok_or_else(|| HcdError::NodeNotFound(chart_id.clone()))?;
    if count >= MAX_CHARTS_PER_SHEET {
        return Err(HcdError::ResourceLimit(
            "worksheet chart count exceeds 64".into(),
        ));
    }
    charts.push(WorksheetChart {
        id: chart_id.clone(),
        config: config.clone(),
        source_missing: false,
        imported: false,
        edited: false,
        removed: false,
    });
    Ok(Some(ChartChange { chunk_id, charts }))
}

pub(super) fn shift_worksheet_charts(grid: &mut GridChunkAddress, patch: &PatchBatch) -> bool {
    if grid.charts.is_empty() {
        return false;
    }
    let Some((sheet, axis, action, at, count)) = patch.operations.iter().find_map(|op| {
        use XlsxGridAction::{Delete, Insert};
        use XlsxGridAxis::{Column, Row};
        match op {
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
    }) else {
        return false;
    };
    if *sheet != grid.sheet_id {
        return false;
    }
    let mut moved = false;
    for chart in grid.charts.iter_mut().filter(|chart| !chart.removed) {
        let previous = chart.config.clone();
        let previous_missing = chart.source_missing;
        let range = &mut chart.config.range;
        let (anchor, low, high, limit) = match axis {
            XlsxGridAxis::Row => (
                &mut chart.config.anchor_row,
                &mut range.start_row,
                &mut range.end_row,
                LAST_ROW,
            ),
            XlsxGridAxis::Column => (
                &mut chart.config.anchor_column,
                &mut range.start_column,
                &mut range.end_column,
                LAST_COLUMN,
            ),
        };
        if action == XlsxGridAction::Insert {
            if at <= *anchor {
                *anchor = anchor.saturating_add(count).min(limit);
            }
            if !chart.source_missing {
                if at <= *low {
                    *low += count;
                }
                if at <= *high {
                    *high += count;
                }
            }
        } else {
            let through = at + count - 1;
            if at <= *anchor {
                *anchor -= (*anchor - at).min(count);
            }
            if !chart.source_missing {
                if through < *low {
                    *low -= count;
                    *high -= count;
                } else if at <= *low {
                    chart.source_missing = true;
                } else if at <= *high {
                    *high -= (through.min(*high) - at) + 1;
                }
            }
        }
        if !chart.source_missing && validate_worksheet_chart(&chart.config).is_err() {
            chart.source_missing = true;
        }
        if chart.source_missing {
            chart.config.range = previous.range;
        }
        if previous != chart.config || previous_missing != chart.source_missing {
            chart.edited = true;
            moved = true;
        }
    }
    moved
}

/// Enumerate saved worksheet chart definitions at the supplied revision.
pub fn worksheet_charts(
    bundle: &Bundle,
    manifest: &HcdManifest,
    sheet_id: Option<&str>,
) -> Result<Vec<(GridChunkAddress, WorksheetChart)>, HcdError> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, index)?.chunks {
            let Some(mut grid) = descriptor.grid else {
                continue;
            };
            if sheet_id.is_some_and(|id| id != grid.sheet_id) {
                continue;
            }
            for chart in std::mem::take(&mut grid.charts) {
                if !valid_worksheet_chart_id(&chart.id) || !seen.insert(chart.id.clone()) {
                    return Err(HcdError::InvalidBundle(
                        "invalid or duplicate worksheet chart ID".into(),
                    ));
                }
                validate_worksheet_chart(&chart.config)?;
                result.push((grid.clone(), chart));
            }
        }
    }
    Ok(result)
}
