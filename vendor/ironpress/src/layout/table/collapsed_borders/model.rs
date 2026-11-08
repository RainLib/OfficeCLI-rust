use super::conflict::{BorderCandidate, CollapsedBorderOrigin, harmonize_candidates};
use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
use crate::types::PhysicalSide;

/// Border declarations supplied by one row/column track and its containing
/// track group. Group sides that do not bound this track are already zeroed.
#[derive(Debug, Clone, Copy, Default)]
pub(in crate::layout::table) struct CollapsedBorderTrack {
    pub(in crate::layout::table) border: LayoutBorder,
    pub(in crate::layout::table) group_border: LayoutBorder,
}

impl CollapsedBorderTrack {
    pub(in crate::layout::table) fn row(
        border: LayoutBorder,
        group_border: Option<LayoutBorder>,
        index_in_group: usize,
        group_size: usize,
    ) -> Self {
        let mut group_border = group_border.unwrap_or_default();
        if index_in_group != 0 {
            group_border.top = LayoutBorderSide::default();
        }
        if index_in_group.saturating_add(1) < group_size {
            group_border.bottom = LayoutBorderSide::default();
        }
        Self {
            border,
            group_border,
        }
    }
}

/// All authored sources needed to resolve one collapsed table.
#[derive(Debug, Clone, Default)]
pub(in crate::layout::table) struct CollapsedBorderSources {
    pub(in crate::layout::table) table: LayoutBorder,
    pub(in crate::layout::table) rows: Vec<CollapsedBorderTrack>,
    pub(in crate::layout::table) columns: Vec<CollapsedBorderTrack>,
}

impl CollapsedBorderSources {
    pub(in crate::layout::table) fn new(
        table: LayoutBorder,
        columns: impl IntoIterator<Item = CollapsedBorderTrack>,
        direction_rtl: bool,
    ) -> Self {
        let mut columns = columns.into_iter().collect::<Vec<_>>();
        if direction_rtl {
            columns.reverse();
        }
        Self {
            table,
            rows: Vec::new(),
            columns,
        }
    }

    pub(in crate::layout::table) fn push_row(&mut self, row: CollapsedBorderTrack) {
        self.rows.push(row);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GridEdgeAxis {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CellId {
    pub(super) row: usize,
    pub(super) cell: usize,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CellPlacement {
    pub(super) id: CellId,
    pub(super) row_start: usize,
    pub(super) row_span: usize,
    pub(super) column_start: usize,
    pub(super) column_span: usize,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct GridBorderRun {
    pub(super) axis: GridEdgeAxis,
    pub(super) line: usize,
    pub(super) track_start: usize,
    pub(super) track_end: usize,
    pub(super) owner: Option<CellId>,
    pub(super) owner_side: PhysicalSide,
    pub(super) candidate: BorderCandidate,
}

impl GridBorderRun {
    pub(super) fn overlaps(self, other: Self) -> bool {
        self.axis == other.axis
            && self.line == other.line
            && self.track_start.max(other.track_start) < self.track_end.min(other.track_end)
    }

    pub(super) fn covers(self, track: usize) -> bool {
        self.track_start <= track && track < self.track_end
    }
}

pub(super) fn candidate_run(
    placement: CellPlacement,
    side: PhysicalSide,
    candidate: BorderCandidate,
) -> GridBorderRun {
    match side {
        PhysicalSide::Top => GridBorderRun {
            axis: GridEdgeAxis::Horizontal,
            line: placement.row_start,
            track_start: placement.column_start,
            track_end: placement.column_start + placement.column_span,
            owner: Some(placement.id),
            owner_side: side,
            candidate,
        },
        PhysicalSide::Right => GridBorderRun {
            axis: GridEdgeAxis::Vertical,
            line: placement.column_start + placement.column_span,
            track_start: placement.row_start,
            track_end: placement.row_start + placement.row_span,
            owner: Some(placement.id),
            owner_side: side,
            candidate,
        },
        PhysicalSide::Bottom => GridBorderRun {
            axis: GridEdgeAxis::Horizontal,
            line: placement.row_start + placement.row_span,
            track_start: placement.column_start,
            track_end: placement.column_start + placement.column_span,
            owner: Some(placement.id),
            owner_side: side,
            candidate,
        },
        PhysicalSide::Left => GridBorderRun {
            axis: GridEdgeAxis::Vertical,
            line: placement.column_start,
            track_start: placement.row_start,
            track_end: placement.row_start + placement.row_span,
            owner: Some(placement.id),
            owner_side: side,
            candidate,
        },
    }
}

fn harmonize_track_side(
    winner: BorderCandidate,
    track: CollapsedBorderTrack,
    side: PhysicalSide,
    track_origin: CollapsedBorderOrigin,
    group_origin: CollapsedBorderOrigin,
) -> BorderCandidate {
    harmonize_candidates([
        winner,
        BorderCandidate {
            side: *track.group_border.get(side),
            origin: group_origin,
        },
        BorderCandidate {
            side: *track.border.get(side),
            origin: track_origin,
        },
    ])
}

fn harmonize_track_range(
    mut winner: BorderCandidate,
    tracks: &[CollapsedBorderTrack],
    range: std::ops::Range<usize>,
    side: PhysicalSide,
    track_origin: CollapsedBorderOrigin,
    group_origin: CollapsedBorderOrigin,
    reverse: bool,
) -> BorderCandidate {
    if reverse {
        for index in range.rev() {
            if let Some(track) = tracks.get(index).copied() {
                winner = harmonize_track_side(winner, track, side, track_origin, group_origin);
            }
        }
    } else {
        for index in range {
            if let Some(track) = tracks.get(index).copied() {
                winner = harmonize_track_side(winner, track, side, track_origin, group_origin);
            }
        }
    }
    winner
}

pub(super) fn cell_side_candidate(
    cell_border: LayoutBorder,
    placement: CellPlacement,
    side: PhysicalSide,
    sources: &CollapsedBorderSources,
    direction_rtl: bool,
) -> BorderCandidate {
    let mut winner = BorderCandidate {
        side: *cell_border.get(side),
        origin: CollapsedBorderOrigin::Cell,
    };
    let row_end = placement.row_start.saturating_add(placement.row_span);
    let column_end = placement.column_start.saturating_add(placement.column_span);

    match side {
        PhysicalSide::Top => {
            if let Some(track) = sources.rows.get(placement.row_start).copied() {
                winner = harmonize_track_side(
                    winner,
                    track,
                    side,
                    CollapsedBorderOrigin::Row,
                    CollapsedBorderOrigin::RowGroup,
                );
            }
            if placement.row_start == 0 {
                winner = harmonize_track_range(
                    winner,
                    &sources.columns,
                    placement.column_start..column_end,
                    side,
                    CollapsedBorderOrigin::Column,
                    CollapsedBorderOrigin::ColumnGroup,
                    direction_rtl,
                );
            }
        }
        PhysicalSide::Bottom => {
            if let Some(track) = row_end
                .checked_sub(1)
                .and_then(|index| sources.rows.get(index))
                .copied()
            {
                winner = harmonize_track_side(
                    winner,
                    track,
                    side,
                    CollapsedBorderOrigin::Row,
                    CollapsedBorderOrigin::RowGroup,
                );
            }
            if row_end >= sources.rows.len() {
                winner = harmonize_track_range(
                    winner,
                    &sources.columns,
                    placement.column_start..column_end,
                    side,
                    CollapsedBorderOrigin::Column,
                    CollapsedBorderOrigin::ColumnGroup,
                    direction_rtl,
                );
            }
        }
        PhysicalSide::Left => {
            if let Some(track) = sources.columns.get(placement.column_start).copied() {
                winner = harmonize_track_side(
                    winner,
                    track,
                    side,
                    CollapsedBorderOrigin::Column,
                    CollapsedBorderOrigin::ColumnGroup,
                );
            }
            if placement.column_start == 0 {
                winner = harmonize_track_range(
                    winner,
                    &sources.rows,
                    placement.row_start..row_end,
                    side,
                    CollapsedBorderOrigin::Row,
                    CollapsedBorderOrigin::RowGroup,
                    false,
                );
            }
        }
        PhysicalSide::Right => {
            if let Some(track) = column_end
                .checked_sub(1)
                .and_then(|index| sources.columns.get(index))
                .copied()
            {
                winner = harmonize_track_side(
                    winner,
                    track,
                    side,
                    CollapsedBorderOrigin::Column,
                    CollapsedBorderOrigin::ColumnGroup,
                );
            }
            if column_end >= sources.columns.len() {
                winner = harmonize_track_range(
                    winner,
                    &sources.rows,
                    placement.row_start..row_end,
                    side,
                    CollapsedBorderOrigin::Row,
                    CollapsedBorderOrigin::RowGroup,
                    false,
                );
            }
        }
    }
    winner
}

pub(super) fn table_border_runs(
    border: LayoutBorder,
    row_count: usize,
    column_count: usize,
) -> [GridBorderRun; 4] {
    [
        GridBorderRun {
            axis: GridEdgeAxis::Horizontal,
            line: 0,
            track_start: 0,
            track_end: column_count,
            owner: None,
            owner_side: PhysicalSide::Top,
            candidate: BorderCandidate {
                side: border.top,
                origin: CollapsedBorderOrigin::Table,
            },
        },
        GridBorderRun {
            axis: GridEdgeAxis::Vertical,
            line: column_count,
            track_start: 0,
            track_end: row_count,
            owner: None,
            owner_side: PhysicalSide::Right,
            candidate: BorderCandidate {
                side: border.right,
                origin: CollapsedBorderOrigin::Table,
            },
        },
        GridBorderRun {
            axis: GridEdgeAxis::Horizontal,
            line: row_count,
            track_start: 0,
            track_end: column_count,
            owner: None,
            owner_side: PhysicalSide::Bottom,
            candidate: BorderCandidate {
                side: border.bottom,
                origin: CollapsedBorderOrigin::Table,
            },
        },
        GridBorderRun {
            axis: GridEdgeAxis::Vertical,
            line: 0,
            track_start: 0,
            track_end: row_count,
            owner: None,
            owner_side: PhysicalSide::Left,
            candidate: BorderCandidate {
                side: border.left,
                origin: CollapsedBorderOrigin::Table,
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::BorderStyle;

    fn solid(width: f32) -> LayoutBorderSide {
        LayoutBorderSide {
            width,
            style: BorderStyle::Solid,
            ..Default::default()
        }
    }

    #[test]
    fn rowspan_harmonizes_every_contiguous_row_origin() {
        let sources = CollapsedBorderSources {
            rows: vec![
                CollapsedBorderTrack {
                    border: LayoutBorder {
                        left: solid(2.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                CollapsedBorderTrack {
                    border: LayoutBorder {
                        left: solid(8.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ],
            columns: vec![CollapsedBorderTrack::default()],
            ..Default::default()
        };
        let placement = CellPlacement {
            id: CellId { row: 0, cell: 0 },
            row_start: 0,
            row_span: 2,
            column_start: 0,
            column_span: 1,
        };

        let candidate = cell_side_candidate(
            LayoutBorder::default(),
            placement,
            PhysicalSide::Left,
            &sources,
            false,
        );

        assert_eq!(candidate.side.width, 8.0);
        assert_eq!(candidate.origin, CollapsedBorderOrigin::Row);
    }

    #[test]
    fn colspan_harmonizes_every_contiguous_column_origin() {
        let sources = CollapsedBorderSources {
            rows: vec![CollapsedBorderTrack::default()],
            columns: vec![
                CollapsedBorderTrack {
                    border: LayoutBorder {
                        top: solid(2.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                CollapsedBorderTrack {
                    border: LayoutBorder {
                        top: solid(8.0),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let placement = CellPlacement {
            id: CellId { row: 0, cell: 0 },
            row_start: 0,
            row_span: 1,
            column_start: 0,
            column_span: 2,
        };

        let candidate = cell_side_candidate(
            LayoutBorder::default(),
            placement,
            PhysicalSide::Top,
            &sources,
            false,
        );

        assert_eq!(candidate.side.width, 8.0);
        assert_eq!(candidate.origin, CollapsedBorderOrigin::Column);
    }
}
