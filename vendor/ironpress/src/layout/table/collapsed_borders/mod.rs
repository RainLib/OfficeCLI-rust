use super::{query_table_row, update_table_row};
use crate::layout::elements::{LayoutNode, TableCells};
use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
use crate::types::PhysicalSide;

mod conflict;
mod grid;
mod model;

use conflict::{harmonize_candidates, resolved_side};
use grid::{BorderPaintOrder, ResolvedBorderGrid, ResolvedGridEdge};
use model::{
    CellId, CellPlacement, GridBorderRun, GridEdgeAxis, candidate_run, cell_side_candidate,
    table_border_runs,
};
pub(super) use model::{CollapsedBorderSources, CollapsedBorderTrack};

fn component_indices(runs: &[GridBorderRun], seed: usize, claimed: &mut [bool]) -> Vec<usize> {
    let Some(seed_run) = runs.get(seed).copied() else {
        return Vec::new();
    };
    let mut component = Vec::new();
    let mut pending = vec![seed];
    if let Some(value) = claimed.get_mut(seed) {
        *value = true;
    }
    while let Some(index) = pending.pop() {
        let Some(run) = runs.get(index).copied() else {
            continue;
        };
        component.push(index);
        for (candidate_index, candidate) in runs.iter().copied().enumerate() {
            if claimed.get(candidate_index).copied().unwrap_or(true)
                || candidate.axis != seed_run.axis
                || candidate.line != seed_run.line
                || !run.overlaps(candidate)
            {
                continue;
            }
            if let Some(value) = claimed.get_mut(candidate_index) {
                *value = true;
                pending.push(candidate_index);
            }
        }
    }
    component
}

fn placement_for(placements: &[CellPlacement], id: CellId) -> Option<CellPlacement> {
    placements
        .iter()
        .copied()
        .find(|placement| placement.id == id)
}

fn paint_order_for(
    run: GridBorderRun,
    placements: &[CellPlacement],
    direction_rtl: bool,
) -> Option<BorderPaintOrder> {
    let owner = run.owner?;
    let placement = placement_for(placements, owner)?;
    let column = if direction_rtl {
        usize::MAX - placement.column_start
    } else {
        placement.column_start
    };
    Some(BorderPaintOrder {
        row: placement.row_start,
        column,
        cell: owner.cell,
    })
}

fn component_order(
    run: GridBorderRun,
    placements: &[CellPlacement],
    direction_rtl: bool,
) -> BorderPaintOrder {
    paint_order_for(run, placements, direction_rtl).unwrap_or(BorderPaintOrder {
        row: usize::MAX,
        column: usize::MAX,
        cell: usize::MAX,
    })
}

fn preferred_paint_owner(
    runs: &[GridBorderRun],
    component: &[usize],
    axis: GridEdgeAxis,
    track: usize,
) -> Option<GridBorderRun> {
    let preferred_side = match axis {
        GridEdgeAxis::Horizontal => PhysicalSide::Top,
        GridEdgeAxis::Vertical => PhysicalSide::Left,
    };
    component
        .iter()
        .filter_map(|index| runs.get(*index).copied())
        .filter(|run| run.owner.is_some() && run.covers(track))
        .find(|run| run.owner_side == preferred_side)
        .or_else(|| {
            component
                .iter()
                .filter_map(|index| runs.get(*index).copied())
                .find(|run| run.owner.is_some() && run.covers(track))
        })
}

fn apply_component_geometry(
    cells: &mut [TableCells],
    runs: &[GridBorderRun],
    component: &[usize],
    side: LayoutBorderSide,
) {
    for run in component
        .iter()
        .filter_map(|index| runs.get(*index).copied())
    {
        let Some(owner) = run.owner else {
            continue;
        };
        let Some(cell) = cells
            .get_mut(owner.row)
            .and_then(|row| row.cells.get_mut(owner.cell))
        else {
            continue;
        };
        let used = cell.layout.box_model.border.get_mut(run.owner_side);
        if side.width > used.width {
            *used = side;
        }
    }
}

fn normalize_resolved_cell_geometry(cells: &mut [TableCells]) {
    for cell in cells.iter_mut().flat_map(|row| row.cells.iter_mut()) {
        if cell.span.rows == 0 {
            continue;
        }
        for side in [
            PhysicalSide::Top,
            PhysicalSide::Right,
            PhysicalSide::Bottom,
            PhysicalSide::Left,
        ] {
            let representative = *cell.layout.box_model.border.get(side);
            let old_inset = *cell.layout.box_model.border_insets.get(side);
            let new_inset = representative.width / 2.0;
            *cell.layout.box_model.border_insets.get_mut(side) = new_inset;
            *cell.layout.box_model.content_insets.get_mut(side) += new_inset - old_inset;
        }
    }
}

fn cell_placements(
    cells: &[TableCells],
    row_count: usize,
    column_count: usize,
) -> Vec<CellPlacement> {
    let mut placements = Vec::new();
    for (row_index, row) in cells.iter().enumerate() {
        let mut column_start = 0usize;
        for (cell_index, cell) in row.cells.iter().enumerate() {
            let column_span = cell.span.columns.max(1);
            if cell.span.rows > 0 {
                placements.push(CellPlacement {
                    id: CellId {
                        row: row_index,
                        cell: cell_index,
                    },
                    row_start: row_index,
                    row_span: cell.span.rows.min(row_count - row_index),
                    column_start,
                    column_span: column_span.min(column_count.saturating_sub(column_start)),
                });
            }
            column_start = column_start.saturating_add(column_span);
        }
    }
    placements
}

fn candidate_runs(
    cells: &[TableCells],
    placements: &[CellPlacement],
    sources: &CollapsedBorderSources,
    direction_rtl: bool,
    row_count: usize,
    column_count: usize,
) -> Vec<GridBorderRun> {
    let mut runs = Vec::new();
    for placement in placements.iter().copied() {
        let Some(cell) = cells
            .get(placement.id.row)
            .and_then(|row| row.cells.get(placement.id.cell))
        else {
            continue;
        };
        for side in [
            PhysicalSide::Top,
            PhysicalSide::Right,
            PhysicalSide::Bottom,
            PhysicalSide::Left,
        ] {
            runs.push(candidate_run(
                placement,
                side,
                cell_side_candidate(
                    cell.layout.box_model.border,
                    placement,
                    side,
                    sources,
                    direction_rtl,
                ),
            ));
        }
    }
    runs.extend(table_border_runs(sources.table, row_count, column_count));
    runs
}

fn resolve_grid(
    cells: &mut [TableCells],
    placements: &[CellPlacement],
    runs: &[GridBorderRun],
    direction_rtl: bool,
    row_count: usize,
    column_count: usize,
) -> ResolvedBorderGrid {
    let mut grid = ResolvedBorderGrid::new(row_count, column_count);
    for cell in cells.iter_mut().flat_map(|row| row.cells.iter_mut()) {
        if cell.span.rows > 0 {
            cell.layout.box_model.border = LayoutBorder::default();
        }
    }

    // Table-root runs participate in each covered outer section but do not
    // connect neighboring cell sections into one conflict component.
    let mut claimed = runs
        .iter()
        .map(|run| run.owner.is_none())
        .collect::<Vec<_>>();
    for seed in 0..runs.len() {
        if claimed.get(seed).copied().unwrap_or(true) {
            continue;
        }
        let mut component = component_indices(runs, seed, &mut claimed);
        component.sort_by_key(|index| {
            runs.get(*index)
                .copied()
                .map(|run| component_order(run, placements, direction_rtl))
                .unwrap_or(BorderPaintOrder {
                    row: usize::MAX,
                    column: usize::MAX,
                    cell: usize::MAX,
                })
        });
        let Some(first_run) = component
            .first()
            .and_then(|index| runs.get(*index))
            .copied()
        else {
            continue;
        };
        let passive_candidates = runs.iter().filter(|run| {
            run.owner.is_none()
                && run.axis == first_run.axis
                && run.line == first_run.line
                && component.iter().any(|index| {
                    runs.get(*index)
                        .is_some_and(|component_run| component_run.overlaps(**run))
                })
        });
        let winner = harmonize_candidates(
            component
                .iter()
                .filter_map(|index| runs.get(*index).map(|run| run.candidate))
                .chain(passive_candidates.map(|run| run.candidate)),
        );
        let side = resolved_side(winner);
        let track_start = component
            .iter()
            .filter_map(|index| runs.get(*index).map(|run| run.track_start))
            .min()
            .unwrap_or(0);
        let track_end = component
            .iter()
            .filter_map(|index| runs.get(*index).map(|run| run.track_end))
            .max()
            .unwrap_or(track_start);
        apply_component_geometry(cells, runs, &component, side);
        if !side.paints() {
            continue;
        }
        for track in track_start..track_end {
            if let Some(owner) = preferred_paint_owner(runs, &component, first_run.axis, track) {
                grid.set(
                    first_run.axis,
                    first_run.line,
                    track,
                    ResolvedGridEdge {
                        side,
                        paint_order: paint_order_for(owner, placements, direction_rtl),
                    },
                );
            }
        }
    }
    grid
}

fn outer_insets(cells: &[TableCells]) -> crate::types::EdgeSizes {
    let top = cells
        .first()
        .into_iter()
        .flat_map(|row| row.cells.iter())
        .filter(|cell| cell.span.rows != 0)
        .map(|cell| cell.layout.box_model.border.top.width / 2.0)
        .fold(0.0, f32::max);
    let bottom = cells
        .last()
        .into_iter()
        .flat_map(|row| row.cells.iter())
        .filter(|cell| cell.span.rows != 0)
        .map(|cell| cell.layout.box_model.border.bottom.width / 2.0)
        .fold(0.0, f32::max);
    let left = cells
        .iter()
        .filter_map(|row| row.cells.iter().find(|cell| cell.span.rows != 0))
        .map(|cell| cell.layout.box_model.border.left.width / 2.0)
        .fold(0.0, f32::max);
    let right = cells
        .iter()
        .filter_map(|row| row.cells.iter().rev().find(|cell| cell.span.rows != 0))
        .map(|cell| cell.layout.box_model.border.right.width / 2.0)
        .fold(0.0, f32::max);
    crate::types::EdgeSizes::new(top, right, bottom, left)
}

/// Resolve every shared table grid edge once, including rowspans and colspans.
///
/// The result remains a table-wide edge grid until joint ownership is known,
/// then each row receives the non-overlapping slice it paints on the table
/// backing. Cells retain only their used half-border insets for layout.
pub(super) fn resolve_collapsed_border_grid(
    rows: &mut [LayoutNode],
    sources: &CollapsedBorderSources,
    direction_rtl: bool,
) -> crate::types::EdgeSizes {
    let mut row_nodes = Vec::new();
    let mut cells = Vec::new();
    for (node_index, node) in rows.iter().enumerate() {
        if let Some(content) = query_table_row(node.as_ref(), |row| row.content.clone()) {
            row_nodes.push(node_index);
            cells.push(content);
        }
    }
    let row_count = cells.len();
    let column_count = cells
        .iter()
        .map(|row| row.column_widths.len())
        .max()
        .unwrap_or(0);
    if row_count == 0 || column_count == 0 {
        return crate::types::EdgeSizes::ZERO;
    }

    let placements = cell_placements(&cells, row_count, column_count);
    let runs = candidate_runs(
        &cells,
        &placements,
        sources,
        direction_rtl,
        row_count,
        column_count,
    );
    let grid = resolve_grid(
        &mut cells,
        &placements,
        &runs,
        direction_rtl,
        row_count,
        column_count,
    );
    normalize_resolved_cell_geometry(&mut cells);
    let outer_insets = outer_insets(&cells);

    for (logical_row, ((node_index, content), collapsed_borders)) in row_nodes
        .into_iter()
        .zip(cells)
        .zip(grid.into_rows())
        .enumerate()
    {
        if let Some(node) = rows.get_mut(node_index) {
            update_table_row(node.as_mut(), |row| {
                row.content = content;
                row.collapsed_borders = collapsed_borders;
                if logical_row == 0 {
                    row.flow.internal.start = outer_insets.top;
                }
            });
        }
    }
    outer_insets
}
