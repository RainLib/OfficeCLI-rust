use super::*;
use crate::style::computed::ColorSource;
use crate::types::{Color, CornerRadii, CornerRadius};

fn rounded_box_pixels(radii: CornerRadii) -> Vec<u8> {
    let mut pixmap = resvg::tiny_skia::Pixmap::new(8, 8).expect("test raster dimensions");
    let mut path = resvg::tiny_skia::PathBuilder::new();
    append_rounded_box_path(&mut path, 1.0, 1.0, 6.0, 6.0, radii);
    let path = path.finish().expect("test rounded path");
    let mut paint = resvg::tiny_skia::Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    pixmap.fill_path(
        &path,
        &paint,
        resvg::tiny_skia::FillRule::Winding,
        resvg::tiny_skia::Transform::identity(),
        None,
    );
    pixmap.data().to_vec()
}

#[test]
fn positive_subpixel_corner_radius_is_not_squared_off() {
    assert_ne!(
        rounded_box_pixels(CornerRadii::circular(0.49)),
        rounded_box_pixels(CornerRadii::ZERO)
    );
}

#[test]
fn zero_radius_axis_makes_the_corner_square() {
    assert_eq!(
        rounded_box_pixels(CornerRadii::uniform(CornerRadius::new(2.0, 0.0))),
        rounded_box_pixels(CornerRadii::ZERO)
    );
}

#[test]
fn rounded_box_path_preserves_per_corner_ellipses() {
    let radii = CornerRadii::new(
        CornerRadius::new(1.0, 2.0),
        CornerRadius::new(2.0, 1.0),
        CornerRadius::new(3.0, 1.0),
        CornerRadius::new(1.0, 3.0),
    );
    assert_ne!(
        rounded_box_pixels(radii),
        rounded_box_pixels(CornerRadii::circular(1.0))
    );
}

#[test]
fn tinted_coverage_keeps_one_straight_color_at_every_alpha() {
    let mask = BlurredCoverageMask {
        coverage: image::GrayImage::from_raw(3, 1, vec![1, 127, 255])
            .expect("test mask dimensions"),
        raster_clip: None,
        overflow_pt: 0.0,
        filter_dpi: 96.0,
    };
    let raster = mask
        .tinted_raster((0.0, 105.0 / 255.0, 92.0 / 255.0, 1.0))
        .expect("colored coverage");
    let decoded = image::load_from_memory(&raster.asset.data)
        .expect("encoded mask raster")
        .to_rgba8();

    assert!(decoded.pixels().all(|pixel| pixel.0[..3] == [0, 105, 92]));
    assert_eq!(
        decoded.pixels().map(|pixel| pixel[3]).collect::<Vec<_>>(),
        [1, 127, 255]
    );
}

#[test]
fn inset_pdf_mask_keeps_source_and_device_blur_bounds_distinct() {
    let shadow = BoxShadow {
        offset_x: 0.0,
        offset_y: 0.0,
        blur: 13.5,
        spread: 12.0,
        color: Color::rgba8(1, 87, 155, 217),
        color_source: ColorSource::Absolute,
        inset: true,
    };
    let mask = blur_inset_shadow_mask(123.0, 63.0, CornerRadii::circular(18.0), &shadow, 300.0)
        .expect("finite inset shadow mask");

    assert_eq!(mask.coverage().dimensions(), (717, 467));
    assert!((mask.overflow_pt - 24.48).abs() < 0.000_1);
}
