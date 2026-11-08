//! Device-bounded placement of a materialized filter raster.

use crate::types::EdgeSizes;

/// Filter pixels together with their signed placement around the source box.
pub(super) struct FilterRasterFrame {
    pub(super) pixels: image::RgbaImage,
    pub(super) overflow: EdgeSizes,
}

impl FilterRasterFrame {
    pub(super) const fn new(pixels: image::RgbaImage, overflow: EdgeSizes) -> Self {
        Self { pixels, overflow }
    }

    /// Subset a filter allocation to semantic source paint bounds plus the
    /// operation's directional support.
    ///
    /// Skia's PDF path serializes the used special-image subset, not the full
    /// save-layer allocation. Authored bounds preserve deliberately transparent
    /// line boxes and finite filter support; scanning nonzero alpha would crop
    /// both and make placement depend on 8-bit rounding.
    pub(super) fn subset_to_paint_bounds(
        self,
        paint_bounds: Option<crate::types::Rect>,
        raster_overflow: EdgeSizes,
        effect_support: EdgeSizes,
        dpi: f32,
    ) -> Self {
        let Some(paint_bounds) = paint_bounds else {
            return self;
        };
        let scale = crate::render::raster_scale::RasterScale::at_dpi(dpi);
        let Some(subset) = DeviceSubset::resolve(
            paint_bounds,
            raster_overflow,
            effect_support,
            scale,
            self.pixels.dimensions(),
        ) else {
            return self;
        };
        self.crop_to(subset, scale)
    }

    /// Discard filter allocation which a following CSS mask cannot expose.
    ///
    /// All supported `mask-clip` geometry boxes are contained by the border
    /// box. The mask itself remains a post-filter PDF effect; this subset only
    /// removes provably unreachable samples and preserves their device phase.
    pub(super) fn subset_to_border_box(self, size: crate::types::Size, dpi: f32) -> Self {
        let scale = crate::render::raster_scale::RasterScale::at_dpi(dpi);
        let bounds = crate::types::Rect::from_xywh(
            self.overflow.left,
            self.overflow.top,
            size.width,
            size.height,
        );
        let Some(subset) = DeviceSubset::enclosing(bounds, scale, self.pixels.dimensions()) else {
            return self;
        };
        self.crop_to(subset, scale)
    }

    fn crop_to(
        mut self,
        subset: DeviceSubset,
        scale: crate::render::raster_scale::RasterScale,
    ) -> Self {
        let crop = subset.crop_edges(self.pixels.dimensions());
        if crop.is_empty() {
            return self;
        }
        let width = self.pixels.width().saturating_sub(crop.horizontal());
        let height = self.pixels.height().saturating_sub(crop.vertical());
        if width == 0 || height == 0 {
            return self;
        }
        self.pixels =
            image::imageops::crop_imm(&self.pixels, crop.left, crop.top, width, height).to_image();
        self.overflow -= crop.to_points(scale);
        self
    }
}

#[derive(Clone, Copy)]
struct DeviceSubset {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

impl DeviceSubset {
    fn resolve(
        paint_bounds: crate::types::Rect,
        raster_overflow: EdgeSizes,
        effect_support: EdgeSizes,
        scale: crate::render::raster_scale::RasterScale,
        dimensions: (u32, u32),
    ) -> Option<Self> {
        let left = paint_bounds.origin.x - effect_support.left + raster_overflow.left;
        let top = paint_bounds.origin.y - effect_support.top + raster_overflow.top;
        let right = paint_bounds.right() + effect_support.right + raster_overflow.left;
        let bottom = paint_bounds.bottom() + effect_support.bottom + raster_overflow.top;
        Self::enclosing(
            crate::types::Rect::from_xywh(left, top, right - left, bottom - top),
            scale,
            dimensions,
        )
    }

    fn enclosing(
        bounds: crate::types::Rect,
        scale: crate::render::raster_scale::RasterScale,
        dimensions: (u32, u32),
    ) -> Option<Self> {
        let floor = |points: f32, maximum: u32| {
            Some(scale.floor(points)?.clamp(0, i64::from(maximum)) as u32)
        };
        let ceil = |points: f32, maximum: u32| {
            Some(scale.ceil(points)?.clamp(0, i64::from(maximum)) as u32)
        };
        let subset = Self {
            left: floor(bounds.origin.x, dimensions.0)?,
            top: floor(bounds.origin.y, dimensions.1)?,
            right: ceil(bounds.right(), dimensions.0)?,
            bottom: ceil(bounds.bottom(), dimensions.1)?,
        };
        (subset.right > subset.left && subset.bottom > subset.top).then_some(subset)
    }

    fn crop_edges(self, dimensions: (u32, u32)) -> DeviceEdges {
        DeviceEdges::new(
            self.top,
            dimensions.0.saturating_sub(self.right),
            dimensions.1.saturating_sub(self.bottom),
            self.left,
        )
    }
}

#[derive(Clone, Copy)]
struct DeviceEdges {
    top: u32,
    right: u32,
    bottom: u32,
    left: u32,
}

impl DeviceEdges {
    const fn new(top: u32, right: u32, bottom: u32, left: u32) -> Self {
        Self {
            top,
            right,
            bottom,
            left,
        }
    }

    const fn horizontal(self) -> u32 {
        self.left.saturating_add(self.right)
    }

    const fn vertical(self) -> u32 {
        self.top.saturating_add(self.bottom)
    }

    const fn is_empty(self) -> bool {
        self.top == 0 && self.right == 0 && self.bottom == 0 && self.left == 0
    }

    fn to_points(self, scale: crate::render::raster_scale::RasterScale) -> EdgeSizes {
        EdgeSizes::new(
            scale.pixels_to_points(self.top as f32),
            scale.pixels_to_points(self.right as f32),
            scale.pixels_to_points(self.bottom as f32),
            scale.pixels_to_points(self.left as f32),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_source_is_subset_with_signed_border_box_placement() {
        let frame = FilterRasterFrame::new(image::RgbaImage::new(10, 8), EdgeSizes::ZERO)
            .subset_to_paint_bounds(
                Some(crate::types::Rect::from_xywh(2.0, 1.0, 6.0, 6.0)),
                EdgeSizes::ZERO,
                EdgeSizes::ZERO,
                72.0,
            );

        assert_eq!(frame.pixels.dimensions(), (6, 6));
        assert_eq!(frame.overflow, EdgeSizes::new(-1.0, -2.0, -1.0, -2.0));
    }

    #[test]
    fn local_effect_discards_transparent_svg_region_padding() {
        let region_overflow = EdgeSizes::new(3.0, 2.0, 3.0, 2.0);
        let frame = FilterRasterFrame::new(image::RgbaImage::new(14, 12), region_overflow)
            .subset_to_paint_bounds(
                Some(crate::types::Rect::from_xywh(0.0, 0.0, 10.0, 6.0)),
                region_overflow,
                EdgeSizes::ZERO,
                72.0,
            );

        assert_eq!(frame.pixels.dimensions(), (10, 6));
        assert_eq!(frame.overflow, EdgeSizes::ZERO);
    }

    #[test]
    fn post_filter_mask_bounds_the_raster_to_the_border_box() {
        let frame = FilterRasterFrame::new(
            image::RgbaImage::new(14, 12),
            EdgeSizes::new(3.0, 2.0, 3.0, 2.0),
        )
        .subset_to_border_box(crate::types::Size::new(10.0, 6.0), 72.0);

        assert_eq!(frame.pixels.dimensions(), (10, 6));
        assert_eq!(frame.overflow, EdgeSizes::ZERO);
    }
}
