use std::collections::HashMap;

use crate::layout::elements::{
    BoxModel, BoxTransform, FlexContent, FlexRow, IntoLayoutNode, LayoutSize, PaintGroup, TextBlock,
};
use crate::layout::engine::FlexCell;
use crate::layout::filter::FilterMatrixCapability;
use crate::layout::filter::paint_space::{InheritedFilterPaintSpace, PageBoxAnchor};
use crate::style::computed::{AlignItems, Transform, TransformBox, TransformOrigin};
use crate::types::{EdgeSizes, Point};

use super::child_frames::ChildPaintFrames;
use super::traversal::TraversalFrame;

#[test]
fn transformed_flex_cell_establishes_parameter_space_for_nested_filters() {
    let nested = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(10.0, Some(8.0)),
            ..Default::default()
        },
        ..Default::default()
    }
    .boxed();
    let mut cell = FlexCell {
        width: 40.0,
        natural_height: 40.0,
        padding: EdgeSizes::new(4.0, 0.0, 0.0, 3.0),
        nested_elements: vec![nested],
        ..Default::default()
    };
    cell.paint.group = PaintGroup {
        transform: BoxTransform {
            value: Some(Transform::Rotate(20.0)),
            origin: TransformOrigin {
                x_fraction: 0.0,
                y_fraction: 0.0,
                ..Default::default()
            },
            reference_box: TransformBox::Border,
            ..Default::default()
        },
        ..Default::default()
    };
    let flex = FlexRow {
        content: FlexContent {
            cells: vec![cell],
            row_height: 40.0,
            alignment: AlignItems::Stretch,
            ..Default::default()
        },
        box_model: BoxModel {
            size: LayoutSize::fixed(50.0, Some(40.0)),
            ..Default::default()
        },
        ..Default::default()
    };
    let root = TraversalFrame {
        anchor: PageBoxAnchor::at(Point::new(100.0, 200.0)),
        inherited_space: InheritedFilterPaintSpace::default(),
    };
    let flex_space = root.enter(&flex);
    let fallback = TraversalFrame {
        anchor: root.anchor,
        inherited_space: flex_space.descendant_space,
    };
    let mut children =
        ChildPaintFrames::resolve(&flex, flex_space, &HashMap::new()).into_iter(fallback);
    let child_frame = children.next();
    let child_space = child_frame.enter(flex.content.cells[0].nested_elements[0].as_ref());
    let raster_space = child_space
        .box_space
        .expect("the nested test block has source geometry")
        .source_raster_space(FilterMatrixCapability::ScaleTranslate);

    assert_eq!(raster_space.border_origin(), Point::new(3.0, 4.0));
}
