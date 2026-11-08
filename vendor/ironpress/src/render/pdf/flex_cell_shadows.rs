//! Shared shadow paint for flex items at every renderer depth.

use super::{
    FlexCell, FragmentPaintGeometry, PageRenderContext, render_box_shadows,
    render_box_shadows_inset,
};

/// The two shadow reference boxes owned by one flex item.
///
/// Top-level and nested flex renderers deliberately share this type so neither
/// paint path can omit a phase or derive different inset geometry.
pub(super) struct FlexCellShadows<'a> {
    shadows: &'a [crate::style::computed::BoxShadow],
    geometry: FragmentPaintGeometry,
    radii: crate::types::CornerRadii,
}

impl<'a> FlexCellShadows<'a> {
    pub(super) fn new(cell: &'a FlexCell, geometry: FragmentPaintGeometry) -> Self {
        Self {
            shadows: &cell.paint.shadows,
            geometry,
            radii: cell.paint.border_radii,
        }
    }

    pub(super) fn paint_outset(&self, content: &mut String, ctx: &mut PageRenderContext<'_>) {
        render_box_shadows(
            content,
            self.shadows,
            self.geometry,
            self.radii,
            ctx.page_ext_gstates,
            ctx.bg_alpha_counter,
            ctx.text.pdf_writer,
        );
    }

    pub(super) fn paint_inset(&self, content: &mut String, ctx: &mut PageRenderContext<'_>) {
        render_box_shadows_inset(
            content,
            self.shadows,
            self.geometry,
            self.radii,
            ctx.page_ext_gstates,
            ctx.bg_alpha_counter,
            ctx.text.pdf_writer,
        );
    }
}
