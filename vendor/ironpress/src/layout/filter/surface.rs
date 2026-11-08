//! Raster `SourceGraphic` construction for CSS filters.

mod canvas;
mod cells;
mod clip;
mod dispatch;
mod geometry;
mod gradient;
mod group;
mod overflow;
mod painter;
mod source_borders;
mod source_graphic;
mod text;

pub(crate) use cells::{
    flex_cell_source_frames, grid_cell_source_frames, paint_flex_cell_source,
    paint_grid_cell_source, table_cell_source_frames,
};
pub(crate) use geometry::{
    BlockChildSpace, SourceGeometry, SourceGraphic, SourceRasterSpace, block_child_frames,
    source_geometry,
};
pub(crate) use source_graphic::paint_source_graphic;
pub(crate) use text::table_row_baseline_shifts;

#[cfg(test)]
mod tests;
