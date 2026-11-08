//! Background, border, clip, and column-rule painting.

use crate::layout::engine::LayoutBorder;
use crate::render::borders::CssRoundedRect;
use crate::types::{Color, CornerRadii, Point, Rect};

use super::compositing::{RasterCoverage, premultiplied_color};
use super::geometry::{CoverageSamples, DeviceRect, device_ceil, device_floor, interval_coverage};
use super::{RasterCanvas, SurfaceRect};
use crate::layout::filter::surface::source_borders::{RasterBorder, RasterColumnRule};

impl RasterCanvas<'_> {
    pub(in crate::layout::filter::surface) fn fill(&mut self, rect: SurfaceRect, color: Color) {
        self.fill_rgba(rect, color.to_f32_rgba());
    }

    pub(in crate::layout::filter::surface) fn fill_rounded(
        &mut self,
        shape: CssRoundedRect,
        color: Color,
    ) {
        self.paint_rounded(shape, |_| Some(color));
    }

    pub(in crate::layout::filter::surface) fn paint_rounded(
        &mut self,
        shape: CssRoundedRect,
        mut sample: impl FnMut(Point) -> Option<Color>,
    ) {
        let rect = shape.rect;
        if rect.size.width <= 0.0 || rect.size.height <= 0.0 {
            return;
        }
        self.include_paint_bounds(rect);
        let x0 = device_floor(rect.origin.x, self.pixels_per_point, self.pixels.width());
        let y0 = device_floor(rect.origin.y, self.pixels_per_point, self.pixels.height());
        let x1 = device_ceil(rect.right(), self.pixels_per_point, self.pixels.width());
        let y1 = device_ceil(rect.bottom(), self.pixels_per_point, self.pixels.height());
        for y in y0..y1 {
            for x in x0..x1 {
                let coverage = CoverageSamples::geometry(x, y, self.pixels_per_point, |point| {
                    shape.contains(point)
                });
                if coverage <= 0.0 {
                    continue;
                }
                let point = Point::new(
                    (x as f32 + 0.5) / self.pixels_per_point,
                    (y as f32 + 0.5) / self.pixels_per_point,
                );
                let Some(color) = sample(point) else {
                    continue;
                };
                self.composite_color(x, y, color, coverage);
            }
        }
    }

    /// Paint a multicolumn rule in the same top-down geometry used by the
    /// SourceGraphic surface.
    pub(in crate::layout::filter::surface) fn paint_column_rule(
        &mut self,
        origin: Point,
        height: f32,
        paint: crate::layout::engine::LayoutBorderSide,
    ) -> Option<()> {
        if paint.width <= 0.0 || height <= 0.0 || !paint.style.paints() {
            return Some(());
        }
        let rect = SurfaceRect::new(origin, crate::types::Size::new(paint.width, height));
        self.include_paint_bounds(rect);
        let rule = RasterColumnRule::new(rect, paint);
        self.paint_color_samples(rect, |point| rule.sample(point));
        Some(())
    }

    pub(in crate::layout::filter::surface) fn paint_border(
        &mut self,
        rect: SurfaceRect,
        border: &LayoutBorder,
        radii: CornerRadii,
    ) -> Option<()> {
        if !border.has_visible() {
            return Some(());
        }
        self.include_paint_bounds(rect);
        if radii.is_zero()
            && let Some(side) = border.uniform_paint_side()
            && side.style == crate::style::computed::BorderStyle::Solid
        {
            self.fill_ring(rect, rect.inset(border.widths()), side.color);
            return Some(());
        }
        let paint = RasterBorder::new(rect, border, radii);
        self.paint_color_samples(rect, |point| paint.sample(point));
        Some(())
    }

    /// Paint `outer - inner` once, retaining fractional device-pixel coverage
    /// at both edges. This is the square-corner form of an inset shadow.
    pub(super) fn fill_ring(&mut self, outer: SurfaceRect, inner: SurfaceRect, color: Color) {
        self.include_paint_bounds(outer);
        let Some(inner) = outer.intersection(inner) else {
            self.fill(outer, color);
            return;
        };
        let scale = self.pixels_per_point;
        let outer_device = DeviceRect::from_surface(outer, scale);
        let inner_device = DeviceRect::from_surface(inner, scale);
        let x0 = device_floor(outer.origin.x, scale, self.pixels.width());
        let y0 = device_floor(outer.origin.y, scale, self.pixels.height());
        let x1 = device_ceil(outer.right(), scale, self.pixels.width());
        let y1 = device_ceil(outer.bottom(), scale, self.pixels.height());
        let color = color.to_f32_rgba();
        for y in y0..y1 {
            for x in x0..x1 {
                let coverage = (outer_device.pixel_coverage(x, y)
                    - inner_device.pixel_coverage(x, y))
                .clamp(0.0, 1.0);
                if coverage <= 0.0 {
                    continue;
                }
                self.composite_premultiplied(
                    x,
                    y,
                    premultiplied_color(color, RasterCoverage::from_unit(coverage)),
                );
            }
        }
    }

    fn fill_rgba(&mut self, rect: SurfaceRect, color: (f32, f32, f32, f32)) {
        if rect.size.width <= 0.0 || rect.size.height <= 0.0 || color.3 <= 0.0 {
            return;
        }
        self.include_paint_bounds(rect);
        let device_left = rect.origin.x * self.pixels_per_point;
        let device_top = rect.origin.y * self.pixels_per_point;
        let device_right = rect.right() * self.pixels_per_point;
        let device_bottom = rect.bottom() * self.pixels_per_point;
        let x0 = device_floor(rect.origin.x, self.pixels_per_point, self.pixels.width());
        let y0 = device_floor(rect.origin.y, self.pixels_per_point, self.pixels.height());
        let x1 = device_ceil(rect.right(), self.pixels_per_point, self.pixels.width());
        let y1 = device_ceil(rect.bottom(), self.pixels_per_point, self.pixels.height());
        for y in y0..y1 {
            let coverage_y = interval_coverage(y, device_top, device_bottom);
            for x in x0..x1 {
                let coverage = coverage_y * interval_coverage(x, device_left, device_right);
                if coverage <= 0.0 {
                    continue;
                }
                self.composite_premultiplied(
                    x,
                    y,
                    premultiplied_color(color, RasterCoverage::from_unit(coverage)),
                );
            }
        }
    }

    /// Paint one complex shape from a shared subpixel color sampler.
    pub(in crate::layout::filter::surface) fn paint_color_samples(
        &mut self,
        bounds: Rect,
        mut sample: impl FnMut(Point) -> Option<Color>,
    ) {
        let x0 = device_floor(bounds.origin.x, self.pixels_per_point, self.pixels.width());
        let y0 = device_floor(bounds.origin.y, self.pixels_per_point, self.pixels.height());
        let x1 = device_ceil(bounds.right(), self.pixels_per_point, self.pixels.width());
        let y1 = device_ceil(bounds.bottom(), self.pixels_per_point, self.pixels.height());
        for y in y0..y1 {
            for x in x0..x1 {
                let Some(color) = CoverageSamples::colors(x, y, self.pixels_per_point, &mut sample)
                else {
                    continue;
                };
                self.composite_color(x, y, color, 1.0);
            }
        }
    }
}
