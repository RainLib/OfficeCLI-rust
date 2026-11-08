//! Device-space canvas for CSS filter SourceGraphic painting.

use crate::render::raster_pixels::PremultipliedRgba8;
use crate::types::Rect;

mod compositing;
mod geometry;
mod images;
mod shadows;
mod shapes;

pub(in crate::layout::filter::surface) use geometry::PaintBounds;
pub(super) use shadows::box_shadow_overflow;

/// Filter painting uses the same semantic rectangle as layout and border
/// geometry. Keep the local name only as a visibility alias for the sibling
/// surface modules.
pub(super) type SurfaceRect = Rect;

pub(super) struct RasterCanvas<'a> {
    pub(super) pixels: &'a mut PremultipliedRgba8,
    pub(super) pixels_per_point: f32,
    pub(super) paint_bounds: &'a mut PaintBounds,
}

impl RasterCanvas<'_> {
    pub(super) fn include_paint_bounds(&mut self, rect: Rect) {
        self.paint_bounds.include(rect);
    }
}
