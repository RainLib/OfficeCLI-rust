//! Device-phase-aware glyph outline rasterization for filter surfaces.

use super::*;
use crate::render::raster_pixels::{DevicePixelPoint, DevicePixelVector};
use crate::types::{Point, Rect};

mod outlines;

/// Vertical portions of one laid-out line around its text baseline.
///
/// Filter painting advances by the exact layout metrics and quantizes only the
/// painted baseline. Keeping both portions together prevents a snapped paint
/// coordinate from leaking back into the line-flow cursor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RasterBaselineAdvance {
    before: f32,
    after: f32,
}

impl RasterBaselineAdvance {
    pub(crate) const fn new(before: f32, after: f32) -> Self {
        Self { before, after }
    }
}

/// Advances top-down raster text while preserving fractional layout flow.
///
/// The CSS-pixel grid is anchored at the filter root's border-box origin. That
/// origin may sit inside device-quantized paint-overflow padding, so snapping
/// directly around surface coordinate zero would shift glyphs whenever an
/// outset effect expands the SourceGraphic.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RasterBaselineCursor {
    flow_top: f32,
    css_pixel_grid_origin: f32,
}

impl RasterBaselineCursor {
    pub(crate) const fn new(flow_top: f32, css_pixel_grid_origin: f32) -> Self {
        Self {
            flow_top,
            css_pixel_grid_origin,
        }
    }

    pub(crate) fn next(&mut self, advance: RasterBaselineAdvance) -> f32 {
        let raw_baseline = self.flow_top + advance.before;
        self.flow_top = raw_baseline + advance.after;
        self.css_pixel_grid_origin
            + crate::fonts::round_to_css_pixel(raw_baseline - self.css_pixel_grid_origin)
    }
}

/// A rasterized text run's alpha coverage plus where the text origin (baseline,
/// left edge) sits inside the mask, in device pixels from the mask's top-left.
pub(crate) struct GlyphRaster {
    pub mask: image::GrayImage,
    pub placement: GlyphRasterPlacement,
    paint_bounds: GlyphPaintBounds,
}

impl GlyphRaster {
    /// Authored outline bounds at one baseline origin.
    ///
    /// The mask allocation has private antialiasing safety pixels around this
    /// rectangle. Keeping those pixels out of semantic paint bounds prevents
    /// allocation policy from changing a filtered layer's PDF placement.
    pub(crate) fn paint_bounds_at(
        &self,
        origin: GlyphBaselineOrigin,
        pixels_per_point: f32,
    ) -> Option<Rect> {
        self.paint_bounds.at(origin, pixels_per_point)
    }
}

/// Integer mask placement and the baseline vector inside the glyph mask.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GlyphRasterPlacement {
    pub(crate) mask_origin: DevicePixelPoint,
    pub(crate) baseline_in_mask: DevicePixelVector,
}

impl GlyphRasterPlacement {
    #[cfg(test)]
    fn resolve(
        origin: GlyphBaselineOrigin,
        pixels_per_point: f32,
        baseline_in_mask: DevicePixelVector,
    ) -> Option<Self> {
        let mut placement = Self {
            mask_origin: DevicePixelPoint::new(0, 0),
            baseline_in_mask,
        };
        placement.mask_origin = placement.mask_origin_at(origin, pixels_per_point)?;
        Some(placement)
    }

    /// Quantize one mask placement as a unit at the requested text origin.
    ///
    /// The glyph outline is rasterized once in its own local frame. Rounding
    /// the complete mask origin avoids inventing independent x/y path phase
    /// while still keeping every caller on the same placement rule.
    pub(crate) fn mask_origin_at(
        self,
        origin: GlyphBaselineOrigin,
        pixels_per_point: f32,
    ) -> Option<DevicePixelPoint> {
        let origin =
            outlines::FoundationGlyphPositioning::new(origin.in_device_pixels(pixels_per_point))?
                .origin();
        Some(DevicePixelPoint::new(
            rounded_device_coordinate(origin.x - self.baseline_in_mask.x)?,
            rounded_device_coordinate(origin.y - self.baseline_in_mask.y)?,
        ))
    }
}

/// The authored origin of a shaped run's baseline.
///
/// Constructors encode whether the owning surface uses CSS top-down or PDF
/// bottom-up coordinates. Rasterization therefore receives one unambiguous
/// top-down origin for its complete mask placement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct GlyphBaselineOrigin(Point);

impl GlyphBaselineOrigin {
    pub(crate) const fn top_down(inline: f32, baseline: f32) -> Self {
        Self(Point::new(inline, baseline))
    }

    pub(crate) const fn pdf(inline: f32, baseline: f32) -> Self {
        Self(Point::new(inline, -baseline))
    }

    fn in_device_pixels(self, pixels_per_point: f32) -> DevicePixelVector {
        DevicePixelVector::new(self.0.x * pixels_per_point, self.0.y * pixels_per_point)
    }
}

/// Device-space outline bounds relative to a run baseline.
///
/// These bounds describe authored glyph paint, including synthetic bold, but
/// exclude the raster allocation's private safety margin.
#[derive(Debug, Clone, Copy)]
struct GlyphPaintBounds(Rect);

impl GlyphPaintBounds {
    const fn from_outline(bounds: Rect) -> Self {
        Self(bounds)
    }

    fn at(self, origin: GlyphBaselineOrigin, pixels_per_point: f32) -> Option<Rect> {
        if !pixels_per_point.is_finite() || pixels_per_point <= 0.0 {
            return None;
        }
        let baseline =
            outlines::FoundationGlyphPositioning::new(origin.in_device_pixels(pixels_per_point))?
                .origin();
        let bounds = self.0;
        Some(Rect::from_xywh(
            (baseline.x + bounds.origin.x) / pixels_per_point,
            (baseline.y + bounds.origin.y) / pixels_per_point,
            bounds.size.width / pixels_per_point,
            bounds.size.height / pixels_per_point,
        ))
    }
}

/// Synthetic face effects applied while rasterizing one shaped glyph run.
///
/// Keeping these together prevents filter, shadow, and PDF raster paths from
/// independently dropping one part of the resolved font presentation.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct GlyphRasterStyle {
    pub(crate) embolden: f32,
    pub(crate) shear: f32,
}

/// Complete semantic input for one glyph-outline rasterization.
pub(crate) struct GlyphRasterRequest<'a> {
    pub(crate) font: &'a TtfFont,
    pub(crate) font_size: f32,
    pub(crate) glyphs: &'a [crate::text::ShapedGlyph],
    pub(crate) style: GlyphRasterStyle,
    pub(crate) origin: GlyphBaselineOrigin,
    pub(crate) dpi: f32,
}

fn rounded_device_coordinate(value: f32) -> Option<i32> {
    let rounded = f64::from(value).round();
    (rounded.is_finite() && rounded >= f64::from(i32::MIN) && rounded <= f64::from(i32::MAX))
        .then_some(rounded as i32)
}

fn floored_device_coordinate(value: f32) -> Option<i32> {
    let floored = f64::from(value).floor();
    (floored.is_finite() && floored >= f64::from(i32::MIN) && floored <= f64::from(i32::MAX))
        .then_some(floored as i32)
}

fn ceiled_device_coordinate(value: f32) -> Option<i32> {
    let ceiled = f64::from(value).ceil();
    (ceiled.is_finite() && ceiled >= f64::from(i32::MIN) && ceiled <= f64::from(i32::MAX))
        .then_some(ceiled as i32)
}

/// Integer backing bounds for a glyph outline at its actual device phase.
struct GlyphMaskFrame {
    origin: DevicePixelPoint,
    dimensions: crate::util::RasterDimensions,
    baseline_in_mask: DevicePixelVector,
}

impl GlyphMaskFrame {
    fn resolve(bounds: Rect, baseline: DevicePixelVector, margin: f32) -> Option<Self> {
        let left = floored_device_coordinate(baseline.x + bounds.origin.x - margin)?;
        let top = floored_device_coordinate(baseline.y + bounds.origin.y - margin)?;
        let right = ceiled_device_coordinate(baseline.x + bounds.right() + margin)?;
        let bottom = ceiled_device_coordinate(baseline.y + bounds.bottom() + margin)?;
        let width = u32::try_from(right.checked_sub(left)?).ok()?;
        let height = u32::try_from(bottom.checked_sub(top)?).ok()?;
        if width == 0 || height == 0 {
            return None;
        }
        Some(Self {
            origin: DevicePixelPoint::new(left, top),
            dimensions: crate::util::RasterDimensions { width, height },
            baseline_in_mask: DevicePixelVector::new(
                baseline.x - left as f32,
                baseline.y - top as f32,
            ),
        })
    }

    fn placement(&self) -> GlyphRasterPlacement {
        GlyphRasterPlacement {
            mask_origin: self.origin,
            baseline_in_mask: self.baseline_in_mask,
        }
    }
}

/// Rasterize a run's shaped glyph outlines into an 8-bit alpha coverage mask at
/// the requested filter resolution.
pub(crate) fn rasterize_run_alpha(request: GlyphRasterRequest<'_>) -> Option<GlyphRaster> {
    if request.font.units_per_em == 0 || request.font_size <= 0.0 || request.glyphs.is_empty() {
        return None;
    }

    // Font size and shaped point offsets are resolved in the same device space.
    let s = RasterScale::at_dpi(request.dpi).pixels_per_css_pixel();
    let pt_to_px = s / PT_PER_PX;
    let stroke_px = (request.style.embolden * pt_to_px).max(0.0);
    let positioning =
        outlines::FoundationGlyphPositioning::new(request.origin.in_device_pixels(pt_to_px))?;
    let outline = outlines::foundation_run_outline(
        request.font,
        request.font_size / PT_PER_PX * s,
        request.glyphs,
        pt_to_px,
        request.style.shear,
        positioning,
    )?
    .embolden(stroke_px)?;
    let bounds = outline.bounds();

    // Margin so the outline anti-aliasing isn't clipped at the buffer edge.
    let paint_bounds = GlyphPaintBounds::from_outline(bounds);
    let margin = 2.0;
    let frame = GlyphMaskFrame::resolve(bounds, positioning.origin(), margin)?;
    let mask = outline.rasterize(&frame)?;

    Some(GlyphRaster {
        mask,
        placement: frame.placement(),
        paint_bounds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_paint_snap_does_not_change_fractional_line_flow() {
        let mut cursor = RasterBaselineCursor::new(10.1, 2.2);
        let advance = RasterBaselineAdvance::new(12.13, 4.2);

        let first = cursor.next(advance);
        let second = cursor.next(advance);

        assert_eq!(
            first,
            2.2 + crate::fonts::round_to_css_pixel(10.1 + 12.13 - 2.2)
        );
        assert_eq!(
            second,
            2.2 + crate::fonts::round_to_css_pixel(10.1 + 12.13 + 4.2 + 12.13 - 2.2)
        );
        assert!((cursor.flow_top - (10.1 + 2.0 * (12.13 + 4.2))).abs() < 0.000_1);
    }

    #[test]
    fn glyph_mask_origin_is_quantized_once_as_a_complete_placement() {
        let placement = GlyphRasterPlacement::resolve(
            GlyphBaselineOrigin::top_down(13.75, 28.2),
            1.0,
            DevicePixelVector::new(2.4, 8.6),
        )
        .expect("finite test coordinates resolve");

        assert_eq!(placement.mask_origin, DevicePixelPoint::new(11, 19));
        assert_eq!(
            placement
                .mask_origin_at(GlyphBaselineOrigin::top_down(14.3, 29.0), 1.0)
                .expect("translated test origin resolves"),
            DevicePixelPoint::new(12, 20)
        );
    }
}
