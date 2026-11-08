//! Hierarchical paint-group regressions.

use std::collections::HashMap;

use crate::layout::elements::{
    BoxModel, BoxPaint, BoxTransform, Container, IntoLayoutNode, LayoutSize, PaintGroup,
    Positioning, TextBlock,
};
use crate::style::computed::{
    ClipPath, CssVector, LengthPercent, PercentageAxes, ShapeBox, Transform, TransformBox,
    TransformOrigin,
};
use crate::types::{Color, Point};

use super::{border_box_pixel, paint_source_graphic, test_raster_space};

#[test]
fn transformed_descendant_is_part_of_the_ancestor_source_graphic() {
    let child = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(3.0, Some(8.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            group: PaintGroup {
                transform: BoxTransform {
                    value: Some(Transform::Rotate(90.0)),
                    origin: TransformOrigin {
                        x_fraction: 0.0,
                        y_fraction: 0.0,
                        ..Default::default()
                    },
                    reference_box: TransformBox::Border,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        positioning: Positioning::absolute_at(Point::new(1.0, 5.0)),
        ..Default::default()
    };
    let root = Container {
        children: vec![child.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(16.0)),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("ancestor source includes the transformed child");

    assert_eq!(source.geometry.paint_overflow().left, 7.0);
    assert_eq!(
        border_box_pixel(&source, Point::new(-6.0, 6.0)),
        image::Rgba([255, 0, 0, 255])
    );
    assert_eq!(border_box_pixel(&source, Point::new(2.0, 9.0))[3], 0);
}

#[test]
fn source_root_defers_its_transform_to_the_filtered_output_owner() {
    let root = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(6.0, Some(4.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            group: PaintGroup {
                transform: BoxTransform {
                    value: Some(Transform::Translate {
                        offset: CssVector::new(5.0, 0.0),
                        percentages: PercentageAxes::default(),
                    }),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("root source defers its post-filter transform");

    assert_eq!(
        border_box_pixel(&source, Point::new(1.0, 1.0)),
        image::Rgba([255, 0, 0, 255])
    );
    assert_eq!(
        source.geometry.paint_overflow(),
        crate::types::EdgeSizes::ZERO
    );
}

fn triangular_clip() -> ClipPath {
    ClipPath::Polygon {
        points: vec![
            (LengthPercent::percent(0.0), LengthPercent::percent(0.0)),
            (LengthPercent::percent(100.0), LengthPercent::percent(0.0)),
            (LengthPercent::percent(0.0), LengthPercent::percent(100.0)),
        ],
        even_odd: false,
        geometry_box: ShapeBox::Border,
    }
}

#[test]
fn clipped_descendant_contributes_its_clipped_group_to_ancestor_source() {
    let child = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(10.0, Some(10.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            group: PaintGroup {
                effects: crate::layout::elements::GroupEffects {
                    masking: crate::layout::elements::Masking {
                        clip_path: Some(triangular_clip()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };
    let root = Container {
        children: vec![child.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(16.0)),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("a clipped descendant remains paintable in its ancestor source");

    assert_eq!(
        border_box_pixel(&source, Point::new(1.0, 1.0)),
        image::Rgba([255, 0, 0, 255])
    );
    assert_eq!(border_box_pixel(&source, Point::new(9.0, 9.0))[3], 0);
}

#[test]
fn source_root_defers_its_clip_until_after_filter_evaluation() {
    let root = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(10.0, Some(10.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            group: PaintGroup {
                effects: crate::layout::elements::GroupEffects {
                    masking: crate::layout::elements::Masking {
                        clip_path: Some(triangular_clip()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("the root source defers post-filter clipping");

    assert_eq!(
        border_box_pixel(&source, Point::new(9.0, 9.0)),
        image::Rgba([255, 0, 0, 255])
    );
}
