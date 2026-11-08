use super::*;

mod background;
mod geometry;
mod strokes;

pub(super) use background::CollapsedCellBackgroundBoundary;
pub(super) use geometry::{CollapsedRowBorderGeometry, paint_resolved_collapsed_row_borders};
pub(super) use strokes::{paint_3d_border_line, paint_table_cell_border_line};
