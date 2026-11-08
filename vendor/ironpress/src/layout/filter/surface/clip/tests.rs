use super::*;
use crate::layout::elements::{BoxModel, BoxReferenceGeometry};
use crate::style::computed::{LengthPercent, ShapeBox};
use crate::types::{EdgeSizes, Size};

fn reference_box() -> BoxModel {
    BoxModel {
        padding: EdgeSizes::uniform(2.0),
        ..Default::default()
    }
}

#[test]
fn polygon_resolves_once_and_masks_premultiplied_source() {
    let clip = ClipPath::Polygon {
        points: vec![
            (LengthPercent::percent(0.0), LengthPercent::percent(0.0)),
            (LengthPercent::percent(100.0), LengthPercent::percent(0.0)),
            (LengthPercent::percent(0.0), LengthPercent::percent(100.0)),
        ],
        even_odd: false,
        geometry_box: ShapeBox::Border,
    };
    let reference = reference_box();
    let clip = SourceClip::resolve(
        &clip,
        Rect::new(Point::ORIGIN, Size::new(20.0, 20.0)),
        &reference,
    )
    .expect("a parsed polygon is a raster clip");
    let mut pixels = PremultipliedRgba8::from_encoded(image::RgbaImage::from_pixel(
        20,
        20,
        image::Rgba([255, 0, 0, 255]),
    ));

    clip.apply(&mut pixels, 1.0)
        .expect("the finite clip mask fits the source");

    assert_eq!(pixels.get_pixel(2, 2), &image::Rgba([255, 0, 0, 255]));
    assert_eq!(pixels.get_pixel(18, 18), &image::Rgba([0, 0, 0, 0]));
}

#[test]
fn reference_geometry_resolves_padding_and_content_boxes() {
    let reference = reference_box();
    let border_box = Rect::new(Point::new(3.0, 5.0), Size::new(20.0, 16.0));

    assert_eq!(
        reference.shape_box(border_box, ShapeBox::Padding),
        border_box
    );
    assert_eq!(
        reference.shape_box(border_box, ShapeBox::Content),
        border_box.inset(EdgeSizes::uniform(2.0))
    );
}
