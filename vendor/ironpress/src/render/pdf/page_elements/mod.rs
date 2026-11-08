use super::*;

mod container;
mod container_decoration;
mod flex;
mod media;
mod misc;
mod tables;
mod text;
mod text_lines;

pub(super) use container::render_container;
pub(super) use flex::render_flex_row;
pub(super) use media::{paint_image_box, paint_svg_box, render_image, render_svg};
pub(super) use misc::{paint_horizontal_rule, paint_math_block, paint_progress_bar};
pub(super) use tables::{render_grid_row, render_table_row};
pub(super) use text::render_text_block;

#[derive(Clone, Copy)]
pub(super) struct PageElementFrame<'a> {
    pub(super) occlusion_coverers: &'a [(PdfRect, usize)],
    pub(super) page_size: PageSize,
    pub(super) margin: Margin,
    pub(super) available_width: f32,
    pub(super) y_pos: f32,
    pub(super) element_index: usize,
    pub(super) page_index: usize,
}
