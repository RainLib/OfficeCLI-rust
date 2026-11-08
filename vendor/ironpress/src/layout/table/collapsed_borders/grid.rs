use super::conflict::collapsed_style_rank;
use super::model::GridEdgeAxis;
use crate::layout::elements::{
    CollapsedBorderEdge, CollapsedBorderJoint, CollapsedBorderJoints, CollapsedBorderLine,
    CollapsedTableBorders,
};
use crate::layout::engine::LayoutBorderSide;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct BorderPaintOrder {
    pub(super) row: usize,
    pub(super) column: usize,
    pub(super) cell: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct ResolvedGridEdge {
    pub(super) side: LayoutBorderSide,
    pub(super) paint_order: Option<BorderPaintOrder>,
}

impl ResolvedGridEdge {
    fn compare_for_paint(self, other: Self) -> EdgePaintComparison {
        match (self.side.paints(), other.side.paints()) {
            (false, false) => return EdgePaintComparison::Tie,
            (true, false) => return EdgePaintComparison::First,
            (false, true) => return EdgePaintComparison::Second,
            (true, true) => {}
        }
        match self
            .side
            .width
            .partial_cmp(&other.side.width)
            .unwrap_or(std::cmp::Ordering::Equal)
        {
            std::cmp::Ordering::Greater => EdgePaintComparison::First,
            std::cmp::Ordering::Less => EdgePaintComparison::Second,
            std::cmp::Ordering::Equal => {
                match collapsed_style_rank(self.side.style)
                    .cmp(&collapsed_style_rank(other.side.style))
                {
                    std::cmp::Ordering::Greater => EdgePaintComparison::First,
                    std::cmp::Ordering::Less => EdgePaintComparison::Second,
                    std::cmp::Ordering::Equal => match (self.paint_order, other.paint_order) {
                        (Some(first), Some(second)) if first < second => EdgePaintComparison::First,
                        (Some(first), Some(second)) if first > second => {
                            EdgePaintComparison::Second
                        }
                        _ => EdgePaintComparison::Tie,
                    },
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgePaintComparison {
    First,
    Second,
    Tie,
}

impl EdgePaintComparison {
    fn winner(self, first: ResolvedGridEdge, second: ResolvedGridEdge) -> ResolvedGridEdge {
        if self == Self::First { first } else { second }
    }
}

#[derive(Debug)]
pub(super) struct ResolvedBorderGrid {
    row_count: usize,
    column_count: usize,
    horizontal: Vec<ResolvedGridEdge>,
    vertical: Vec<ResolvedGridEdge>,
}

impl ResolvedBorderGrid {
    pub(super) fn new(row_count: usize, column_count: usize) -> Self {
        Self {
            row_count,
            column_count,
            horizontal: vec![
                ResolvedGridEdge::default();
                row_count.saturating_add(1).saturating_mul(column_count)
            ],
            vertical: vec![
                ResolvedGridEdge::default();
                row_count.saturating_mul(column_count.saturating_add(1))
            ],
        }
    }

    fn index(&self, axis: GridEdgeAxis, line: usize, track: usize) -> Option<usize> {
        match axis {
            GridEdgeAxis::Horizontal if line <= self.row_count && track < self.column_count => line
                .checked_mul(self.column_count)
                .and_then(|offset| offset.checked_add(track)),
            GridEdgeAxis::Vertical if line <= self.column_count && track < self.row_count => track
                .checked_mul(self.column_count.saturating_add(1))
                .and_then(|offset| offset.checked_add(line)),
            _ => None,
        }
    }

    fn get(&self, axis: GridEdgeAxis, line: usize, track: usize) -> ResolvedGridEdge {
        let Some(index) = self.index(axis, line, track) else {
            return ResolvedGridEdge::default();
        };
        match axis {
            GridEdgeAxis::Horizontal => self.horizontal.get(index).copied().unwrap_or_default(),
            GridEdgeAxis::Vertical => self.vertical.get(index).copied().unwrap_or_default(),
        }
    }

    pub(super) fn set(
        &mut self,
        axis: GridEdgeAxis,
        line: usize,
        track: usize,
        edge: ResolvedGridEdge,
    ) {
        let Some(index) = self.index(axis, line, track) else {
            return;
        };
        let slot = match axis {
            GridEdgeAxis::Horizontal => self.horizontal.get_mut(index),
            GridEdgeAxis::Vertical => self.vertical.get_mut(index),
        };
        if let Some(slot) = slot {
            *slot = edge;
        }
    }

    fn intersection(&self, row_line: usize, column_line: usize) -> GridIntersection {
        GridIntersection {
            before: column_line
                .checked_sub(1)
                .map(|column| self.get(GridEdgeAxis::Horizontal, row_line, column))
                .unwrap_or_default(),
            after: self.get(GridEdgeAxis::Horizontal, row_line, column_line),
            over: row_line
                .checked_sub(1)
                .map(|row| self.get(GridEdgeAxis::Vertical, column_line, row))
                .unwrap_or_default(),
            under: self.get(GridEdgeAxis::Vertical, column_line, row_line),
        }
    }

    fn edge_with_joints(
        &self,
        axis: GridEdgeAxis,
        line: usize,
        track: usize,
    ) -> CollapsedBorderEdge {
        let edge = self.get(axis, line, track);
        let (start, end) = match axis {
            GridEdgeAxis::Horizontal => (
                self.intersection(line, track)
                    .joint_for(axis, EdgeEndpoint::Start),
                self.intersection(line, track.saturating_add(1))
                    .joint_for(axis, EdgeEndpoint::End),
            ),
            GridEdgeAxis::Vertical => (
                self.intersection(track, line)
                    .joint_for(axis, EdgeEndpoint::Start),
                self.intersection(track.saturating_add(1), line)
                    .joint_for(axis, EdgeEndpoint::End),
            ),
        };
        CollapsedBorderEdge::new(edge.side, CollapsedBorderJoints { start, end })
    }

    pub(super) fn into_rows(self) -> Vec<CollapsedTableBorders> {
        (0..self.row_count)
            .map(|row| {
                let block_start = (0..self.column_count)
                    .map(|column| self.edge_with_joints(GridEdgeAxis::Horizontal, row, column))
                    .collect();
                let block_axis = (0..=self.column_count)
                    .map(|column_line| {
                        self.edge_with_joints(GridEdgeAxis::Vertical, column_line, row)
                    })
                    .collect();
                let block_end = if row.saturating_add(1) == self.row_count {
                    (0..self.column_count)
                        .map(|column| {
                            self.edge_with_joints(GridEdgeAxis::Horizontal, self.row_count, column)
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                CollapsedTableBorders::new(
                    CollapsedBorderLine::new(block_start),
                    CollapsedBorderLine::new(block_axis),
                    CollapsedBorderLine::new(block_end),
                )
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy)]
struct GridIntersection {
    before: ResolvedGridEdge,
    after: ResolvedGridEdge,
    over: ResolvedGridEdge,
    under: ResolvedGridEdge,
}

impl GridIntersection {
    fn joint_for(self, axis: GridEdgeAxis, endpoint: EdgeEndpoint) -> CollapsedBorderJoint {
        let inline_comparison = self.before.compare_for_paint(self.after);
        let block_comparison = self.over.compare_for_paint(self.under);
        let inline_winner = inline_comparison.winner(self.before, self.after);
        let block_winner = block_comparison.winner(self.over, self.under);
        let inline_vs_block = inline_winner.compare_for_paint(block_winner);
        let edge_owns_joint = match (axis, endpoint) {
            (GridEdgeAxis::Horizontal, EdgeEndpoint::Start) => {
                inline_vs_block != EdgePaintComparison::Second
                    && inline_comparison != EdgePaintComparison::First
            }
            (GridEdgeAxis::Horizontal, EdgeEndpoint::End) => {
                inline_vs_block != EdgePaintComparison::Second
                    && inline_comparison != EdgePaintComparison::Second
            }
            (GridEdgeAxis::Vertical, EdgeEndpoint::Start) => {
                inline_vs_block != EdgePaintComparison::First
                    && block_comparison != EdgePaintComparison::First
            }
            (GridEdgeAxis::Vertical, EdgeEndpoint::End) => {
                inline_vs_block != EdgePaintComparison::First
                    && block_comparison != EdgePaintComparison::Second
            }
        };
        let perpendicular_width = match axis {
            GridEdgeAxis::Horizontal => block_winner.side.width,
            GridEdgeAxis::Vertical => inline_winner.side.width,
        };
        CollapsedBorderJoint::resolve(perpendicular_width, edge_owns_joint)
    }
}

#[derive(Debug, Clone, Copy)]
enum EdgeEndpoint {
    Start,
    End,
}
