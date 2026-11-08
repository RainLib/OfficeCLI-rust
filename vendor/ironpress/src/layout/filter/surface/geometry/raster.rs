//! Physical raster backing for one filter SourceGraphic.

use crate::types::{EdgeSizes, Point, Size};

use super::SourceGeometry;

/// Border-box origin in the filter layer's coordinate system.
///
/// This is deliberately not a page-layout position. A scale/translate layer
/// can retain page phase, while a layer decomposed from rotation or skew begins
/// in a transformed ancestor's local parameter coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SourceRasterSpace {
    border_origin: Point,
}

impl SourceRasterSpace {
    pub(crate) const fn in_layer(border_origin: Point) -> Self {
        Self { border_origin }
    }

    pub(crate) const fn border_origin(self) -> Point {
        self.border_origin
    }
}

/// Integral device bounds enclosing one authored point-space rectangle.
#[derive(Clone, Copy)]
struct DeviceRasterBounds {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

impl DeviceRasterBounds {
    fn enclosing(
        space: SourceRasterSpace,
        size: Size,
        authored_overflow: EdgeSizes,
        scale: crate::render::raster_scale::RasterScale,
    ) -> Option<Self> {
        let origin = space.border_origin();
        Some(Self {
            left: scale.floor(origin.x - authored_overflow.left)?,
            top: scale.floor(origin.y - authored_overflow.top)?,
            right: scale.ceil(origin.x + size.width + authored_overflow.right)?,
            bottom: scale.ceil(origin.y + size.height + authored_overflow.bottom)?,
        })
    }

    fn dimensions(self) -> Option<crate::util::RasterDimensions> {
        Some(crate::util::RasterDimensions {
            width: u32::try_from(self.right.checked_sub(self.left)?).ok()?,
            height: u32::try_from(self.bottom.checked_sub(self.top)?).ok()?,
        })
    }

    fn border_origin(
        self,
        space: SourceRasterSpace,
        scale: crate::render::raster_scale::RasterScale,
    ) -> Point {
        let origin = space.border_origin();
        Point::new(
            origin.x - scale.pixels_to_points(self.left as f32),
            origin.y - scale.pixels_to_points(self.top as f32),
        )
    }
}

/// Integer pixel bounds and local border-box position of one filter surface.
#[derive(Clone, Copy)]
struct RasterSurfaceFrame {
    dimensions: crate::util::RasterDimensions,
    border_origin: Point,
    paint_overflow: EdgeSizes,
}

impl RasterSurfaceFrame {
    fn resolve(
        size: Size,
        authored_overflow: EdgeSizes,
        dpi: f32,
        space: SourceRasterSpace,
    ) -> Option<Self> {
        let scale = crate::render::raster_scale::RasterScale::at_dpi(dpi);
        let bounds = DeviceRasterBounds::enclosing(space, size, authored_overflow, scale)?;
        let dimensions = bounds.dimensions()?;
        let border_origin = bounds.border_origin(space, scale);
        let surface_size = Size::new(
            scale.pixels_to_points(dimensions.width as f32),
            scale.pixels_to_points(dimensions.height as f32),
        );
        Some(Self {
            dimensions,
            border_origin,
            paint_overflow: EdgeSizes::new(
                border_origin.y,
                surface_size.width - border_origin.x - size.width,
                surface_size.height - border_origin.y - size.height,
                border_origin.x,
            ),
        })
    }
}

/// One completely painted, unfiltered `SourceGraphic`.
pub(crate) struct SourceGraphic {
    pub(crate) pixels: crate::render::raster_pixels::PremultipliedRgba8,
    pub(crate) geometry: SourceRasterGeometry,
    pub(crate) paint_bounds: Option<crate::types::Rect>,
}

/// Relationship between the layout border box and its offscreen paint surface.
///
/// Layout retains the unexpanded border box. The raster frame owns the
/// device-quantized origin and extent, so reinserting a filtered image never
/// changes normal flow or re-derives sampling phase from point-space floats.
pub(crate) struct SourceRasterGeometry {
    pub(crate) layout: SourceGeometry,
    surface: RasterSurfaceFrame,
}

impl SourceRasterGeometry {
    pub(in crate::layout::filter::surface) fn resolve(
        layout: SourceGeometry,
        authored_overflow: EdgeSizes,
        dpi: f32,
        space: SourceRasterSpace,
    ) -> Option<Self> {
        let surface = RasterSurfaceFrame::resolve(layout.size, authored_overflow, dpi, space)?;
        Some(Self { layout, surface })
    }

    pub(in crate::layout::filter::surface) fn dimensions(&self) -> crate::util::RasterDimensions {
        self.surface.dimensions
    }

    pub(crate) fn surface_size(&self) -> Size {
        Size::new(
            self.layout.size.width + self.surface.paint_overflow.horizontal(),
            self.layout.size.height + self.surface.paint_overflow.vertical(),
        )
    }

    pub(in crate::layout::filter::surface) fn border_origin(&self) -> Point {
        self.surface.border_origin
    }

    pub(crate) fn paint_overflow(&self) -> EdgeSizes {
        self.surface.paint_overflow
    }

    pub(in crate::layout::filter::surface) fn required_overflow_for(
        &self,
        paint_bounds: crate::types::Rect,
    ) -> EdgeSizes {
        let border_box = crate::types::Rect::new(self.surface.border_origin, self.layout.size);
        EdgeSizes::new(
            (border_box.origin.y - paint_bounds.origin.y).max(0.0),
            (paint_bounds.right() - border_box.right()).max(0.0),
            (paint_bounds.bottom() - border_box.bottom()).max(0.0),
            (border_box.origin.x - paint_bounds.origin.x).max(0.0),
        )
    }

    pub(crate) fn filter_geometry(&self) -> Option<crate::render::filter::FilterSourceGeometry> {
        crate::render::filter::FilterSourceGeometry::new(
            self.surface_size(),
            crate::types::Rect::new(self.surface.border_origin, self.layout.size),
        )
    }
}
