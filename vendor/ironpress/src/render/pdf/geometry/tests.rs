use super::*;
use crate::layout::elements::BoxTransform;
use crate::layout::engine::LayoutBorderSide;
use crate::style::computed::{
    BackgroundClip, BackgroundOrigin, BorderStyle, ShapeBox, TransformBox, TransformOrigin,
};
use crate::types::{Color, CornerRadii, CornerRadius, EdgeSizes, PhysicalEdges};
use crate::util::{RasterDimensions, RasterTile};

#[test]
fn pdf_rect_converts_top_coordinates_once() {
    let rect = PdfRect::from_top(10.0, 100.0, 30.0, 40.0);
    assert_eq!(rect, PdfRect::new(10.0, 60.0, 30.0, 40.0));
    assert_eq!(rect.right(), 40.0);
    assert_eq!(rect.top(), 100.0);
}

#[test]
fn pdf_rect_resolves_css_transform_origin_from_the_top_edge() {
    let rect = PdfRect::new(10.0, 20.0, 30.0, 40.0);
    assert_eq!(
        rect.css_transform_origin(TransformOrigin {
            x_fraction: 0.5,
            y_fraction: 1.0,
            ..Default::default()
        }),
        PdfPoint::new(25.0, 20.0)
    );
}

#[test]
fn pdf_rect_maps_top_down_raster_tiles_without_flipping_rows() {
    let rect = PdfRect::new(10.0, 20.0, 100.0, 100.0);
    let dimensions = RasterDimensions {
        width: 4,
        height: 4,
    };
    assert_eq!(
        rect.raster_tile(
            dimensions,
            RasterTile {
                x: 1,
                y: 0,
                width: 2,
                height: 2,
            },
        ),
        PdfRect::new(35.0, 70.0, 50.0, 50.0)
    );
    assert_eq!(
        rect.raster_tile(
            dimensions,
            RasterTile {
                x: 1,
                y: 2,
                width: 2,
                height: 2,
            },
        ),
        PdfRect::new(35.0, 20.0, 50.0, 50.0)
    );
}

#[test]
fn pdf_rect_insets_asymmetric_physical_edges() {
    let rect = PdfRect::from_top(10.0, 100.0, 30.0, 40.0).inset(EdgeSizes::new(1.0, 2.0, 3.0, 4.0));
    assert_eq!(rect, PdfRect::new(14.0, 63.0, 24.0, 36.0));
}

#[test]
fn oversized_insets_keep_the_authored_origin_shift() {
    let rect = PdfRect::new(10.0, 20.0, 3.0, 4.0).inset(EdgeSizes::new(8.0, 9.0, 7.0, 6.0));
    assert_eq!(rect, PdfRect::new(16.0, 27.0, 0.0, 0.0));
    assert!(rect.is_empty());
}

#[test]
fn rectangle_coverage_uses_all_four_derived_edges() {
    let outer = PdfRect::new(10.0, 20.0, 30.0, 40.0);
    let inner = PdfRect::new(12.0, 22.0, 26.0, 36.0);
    assert!(outer.covers_with_margin(inner, 2.0));
    assert!(!outer.covers_with_margin(inner, 2.001));
}

#[test]
fn rectangle_intersection_returns_only_shared_area() {
    let left = PdfRect::new(10.0, 20.0, 30.0, 40.0);
    let right = PdfRect::new(25.0, 5.0, 30.0, 30.0);
    assert_eq!(
        left.intersection(right),
        Some(PdfRect::new(25.0, 20.0, 15.0, 15.0))
    );
    assert_eq!(left.intersection(PdfRect::new(40.0, 20.0, 5.0, 5.0)), None);
}

#[test]
fn box_geometry_derives_every_box_from_one_border_box() {
    let border_box = PdfRect::new(10.0, 20.0, 100.0, 80.0);
    let border = EdgeSizes::new(1.0, 2.0, 3.0, 4.0);
    let padding = EdgeSizes::new(5.0, 6.0, 7.0, 8.0);
    let geometry = PaintBoxGeometry::new(border_box, border, padding);
    let layout = LayoutBoxGeometry::new(border_box, border, padding);
    assert_eq!(geometry.padding_box(), PdfRect::new(14.0, 23.0, 94.0, 76.0));
    assert_eq!(geometry.content_box(), PdfRect::new(22.0, 30.0, 80.0, 64.0));
    assert_eq!(geometry.shape_box(ShapeBox::Border), geometry.border_box);
    assert_eq!(
        geometry.shape_box(ShapeBox::Padding),
        geometry.padding_box()
    );
    assert_eq!(
        geometry.shape_box(ShapeBox::Content),
        geometry.content_box()
    );
    assert_eq!(
        layout.background_origin_box(BackgroundOrigin::Border),
        layout.border_box
    );
    assert_eq!(
        layout.background_origin_box(BackgroundOrigin::Padding),
        layout.padding_box()
    );
    assert_eq!(
        layout.background_origin_box(BackgroundOrigin::Content),
        layout.content_box()
    );
}

#[test]
fn box_paint_uses_distinct_intrinsic_and_generated_background_geometry() {
    let border = PhysicalEdges::uniform(LayoutBorderSide::solid(0.75, Color::BLACK));
    let layout = LayoutBoxGeometry::from_layout(
        PdfRect::from_top(4.125, 100.125, 108.75, 30.375),
        &border,
        EdgeSizes::new(3.75, 0.0, 0.0, 5.625),
        None,
    );
    let page = super::super::transforms::PageContentTransform::print(PdfVector::new(150.0, 150.0));
    let geometry = layout.for_paint(page, BoxPaintGrid::Page);
    let background = geometry.background(
        BackgroundOrigin::Padding,
        BackgroundClip::Border,
        CornerRadii::ZERO,
    );

    assert_eq!(
        geometry.painting().border_box,
        page.snap_layout_box(layout.border_box)
    );
    assert_eq!(
        background.positioning_area.intrinsic_image_box(),
        layout.background_origin_box(BackgroundOrigin::Padding)
    );
    assert_eq!(
        background.positioning_area.generated_image_box(),
        geometry.painting().padding_box()
    );
    assert_eq!(background.painting_box.rect, geometry.painting().border_box);
    assert_eq!(
        background.image_destination_box,
        geometry.painting().padding_box()
    );
    assert_ne!(
        background.positioning_area.intrinsic_image_box(),
        background.positioning_area.generated_image_box()
    );
    assert_eq!(
        background.positioning_area.generated_image_box().width,
        geometry.painting().padding_box().width
    );
}

#[test]
fn unobscured_background_still_snaps_generated_image_geometry() {
    let layout = LayoutBoxGeometry::new(
        PdfRect::from_top(4.125, 100.125, 108.75, 30.375),
        EdgeSizes::uniform(0.75),
        EdgeSizes::ZERO,
    );
    let page = super::super::transforms::PageContentTransform::print(PdfVector::new(150.0, 150.0));
    let geometry = layout.for_paint(page, BoxPaintGrid::Page);
    let background = geometry.background(
        BackgroundOrigin::Padding,
        BackgroundClip::Border,
        CornerRadii::ZERO,
    );

    assert_eq!(
        background.positioning_area.generated_image_box(),
        geometry.painting().padding_box()
    );
    assert_eq!(
        background.positioning_area.intrinsic_image_box(),
        layout.padding_box()
    );
    assert_eq!(
        background.image_destination_box,
        geometry.painting().border_box
    );
}

#[test]
fn rounded_background_retains_its_css_painting_box() {
    let border = PhysicalEdges::uniform(LayoutBorderSide::solid(6.0, Color::BLACK));
    let layout = LayoutBoxGeometry::from_layout(
        PdfRect::from_top(18.75, 95.25, 127.5, 75.0),
        &border,
        EdgeSizes::ZERO,
        None,
    );
    let page = super::super::transforms::PageContentTransform::print(PdfVector::new(168.0, 114.0));
    let geometry = layout.for_paint(page, BoxPaintGrid::Page);
    let background = geometry.background(
        BackgroundOrigin::Padding,
        BackgroundClip::Border,
        CornerRadii::circular(30.0),
    );

    assert_eq!(
        background.image_destination_box,
        background.painting_box.rect
    );
}

#[test]
fn content_box_transform_reference_retains_used_border_and_padding() {
    let geometry = PaintBoxGeometry::new(
        PdfRect::new(10.0, 20.0, 100.0, 80.0),
        EdgeSizes::new(1.0, 2.0, 3.0, 4.0),
        EdgeSizes::new(5.0, 6.0, 7.0, 8.0),
    );
    let top_left = geometry.transform_reference(&BoxTransform {
        origin: TransformOrigin {
            x_fraction: 0.0,
            y_fraction: 0.0,
            ..Default::default()
        },
        reference_box: TransformBox::Content,
        ..Default::default()
    });

    assert_eq!(top_left.size(), PdfVector::new(80.0, 64.0));
    assert_eq!(top_left.pivot(), PdfPoint::new(22.0, 94.0));
    assert_eq!(top_left.local_pivot(), PdfVector::new(12.0, 6.0));

    let center = geometry.transform_reference(&BoxTransform {
        reference_box: TransformBox::Content,
        ..Default::default()
    });
    assert_eq!(center.pivot(), PdfPoint::new(62.0, 62.0));
    assert_eq!(center.local_pivot(), PdfVector::new(52.0, 38.0));
}

#[test]
fn clip_rectangle_and_radii_share_the_same_asymmetric_inset() {
    let border = EdgeSizes::new(1.0, 2.0, 3.0, 4.0);
    let radii = CornerRadii::new(
        CornerRadius::new(10.0, 20.0),
        CornerRadius::new(30.0, 40.0),
        CornerRadius::new(50.0, 60.0),
        CornerRadius::new(70.0, 80.0),
    );
    let geometry = PaintBoxGeometry::new(
        PdfRect::new(10.0, 20.0, 100.0, 100.0),
        border,
        EdgeSizes::ZERO,
    );
    let clip = geometry.background_clip_box(BackgroundClip::Padding, radii);
    assert_eq!(clip.rect, geometry.padding_box());
    assert_eq!(clip.radii, radii.fit_to(100.0, 100.0).inset(border));
    assert_eq!(
        geometry
            .background_clip_box(BackgroundClip::Text, radii)
            .rect,
        geometry.border_box
    );
}

#[test]
fn border_box_background_uses_the_outer_border_shape() {
    let geometry = PaintBoxGeometry::new(
        PdfRect::new(10.0, 20.0, 100.0, 80.0),
        EdgeSizes::uniform(6.0),
        EdgeSizes::ZERO,
    );
    let radii = CornerRadii::uniform(CornerRadius::new(20.0, 12.0));

    assert_eq!(
        geometry.background_clip_box(BackgroundClip::Border, radii),
        geometry.rounded_border_box(radii)
    );
}

#[test]
fn semantic_layout_border_carries_bleed_avoidance_to_paint_geometry() {
    let border = PhysicalEdges::uniform(LayoutBorderSide {
        width: 6.0,
        color: Color::BLACK,
        style: BorderStyle::Double,
    });
    let layout = LayoutBoxGeometry::from_layout(
        PdfRect::new(10.0, 20.0, 100.0, 80.0),
        &border,
        EdgeSizes::ZERO,
        None,
    );
    let painting = layout
        .for_paint(
            super::super::transforms::PageContentTransform::default(),
            BoxPaintGrid::Page,
        )
        .painting();
    let radii = CornerRadii::circular(12.0);

    assert_eq!(
        painting.background_clip_box(BackgroundClip::Border, radii),
        painting
            .rounded_border_box(radii)
            .inset(EdgeSizes::uniform(1.0))
    );
}
