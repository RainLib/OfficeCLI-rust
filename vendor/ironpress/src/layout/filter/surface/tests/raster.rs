//! Analytic raster coverage regressions for filter source painting.

use crate::style::computed::{BorderStyle, BoxShadow};
use crate::types::{Color, Point, Size};

use super::super::canvas::{PaintBounds, RasterCanvas, SurfaceRect};

#[test]
fn axis_aligned_source_paint_retains_fractional_pixel_coverage() {
    let mut pixels = crate::render::raster_pixels::PremultipliedRgba8::transparent(2, 1);
    let mut paint_bounds = PaintBounds::default();
    RasterCanvas {
        pixels: &mut pixels,
        pixels_per_point: 1.0,
        paint_bounds: &mut paint_bounds,
    }
    .fill(
        SurfaceRect::new(Point::new(0.25, 0.0), Size::new(0.5, 1.0)),
        Color::from_srgb(1.0, 0.0, 0.0, 1.0),
    );

    assert_eq!(pixels.get_pixel(0, 0)[3], 128);
    assert_eq!(pixels.get_pixel(1, 0)[3], 0);
}

#[test]
fn square_background_and_border_use_analytic_edge_coverage() {
    let mut pixels = crate::render::raster_pixels::PremultipliedRgba8::transparent(12, 4);
    let rect = SurfaceRect::from_xywh(0.21875, 0.0, 2.0, 1.0);
    let border =
        crate::layout::engine::LayoutBorder::uniform(crate::layout::engine::LayoutBorderSide {
            width: 0.5,
            color: Color::from_srgb(0.0, 0.0, 1.0, 1.0),
            style: BorderStyle::Solid,
        });
    let mut paint_bounds = PaintBounds::default();
    let mut canvas = RasterCanvas {
        pixels: &mut pixels,
        pixels_per_point: 4.0,
        paint_bounds: &mut paint_bounds,
    };
    canvas.fill(rect, Color::WHITE);
    canvas
        .paint_border(rect, &border, crate::types::CornerRadii::ZERO)
        .expect("a finite solid border paints");

    // The outer edge starts at device x=.875, so each layer contributes 1/8
    // coverage. Source-over of the two 8-bit coverages is 32 + 28 = 60.
    assert_eq!(pixels.get_pixel(0, 1)[3], 60);
}

#[test]
fn inset_shadow_ring_uses_the_padding_box_without_corner_overdraw() {
    let mut pixels = crate::render::raster_pixels::PremultipliedRgba8::transparent(10, 10);
    let mut paint_bounds = PaintBounds::default();
    RasterCanvas {
        pixels: &mut pixels,
        pixels_per_point: 1.0,
        paint_bounds: &mut paint_bounds,
    }
    .paint_inset_shadows(
        SurfaceRect::new(Point::ORIGIN, Size::new(10.0, 10.0)),
        &[BoxShadow {
            offset_x: 0.0,
            offset_y: 0.0,
            blur: 0.0,
            spread: 2.0,
            color: Color::from_srgb(1.0, 0.0, 0.0, 0.5),
            color_source: crate::style::computed::ColorSource::Absolute,
            inset: true,
        }],
        96.0,
    )
    .expect("a finite square inset shadow paints");

    assert!((127..=128).contains(&pixels.get_pixel(0, 0)[3]));
    assert_eq!(pixels.get_pixel(5, 5)[3], 0);
}
