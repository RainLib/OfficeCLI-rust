//! Semantic border-box geometry exposed by filter source owners.

use crate::layout::cells::TableRowCells;
use crate::layout::elements::{
    ColumnRule, Container, FlexRow, GridRow, Image, LayoutElement, LayoutVisitor, Positioning,
    TableRow, TextBlock,
};
use crate::layout::flow_metrics::BlockFlowSpacing;
use crate::types::Size;

/// Border-box geometry retained when a painted filter source becomes an image.
#[derive(Debug, Clone)]
pub(crate) struct SourceGeometry {
    pub(crate) size: Size,
    pub(crate) flow: BlockFlowSpacing,
    pub(crate) positioning: Positioning,
}

pub(crate) fn source_geometry(element: &dyn LayoutElement) -> Option<SourceGeometry> {
    struct Geometry(Option<SourceGeometry>);

    impl LayoutVisitor for Geometry {
        fn visit_column_rule(&mut self, element: &ColumnRule) {
            self.0 = Some(SourceGeometry {
                size: Size::new(element.paint.width, element.height),
                flow: BlockFlowSpacing::default(),
                positioning: Positioning::default(),
            });
        }

        fn visit_text_block(&mut self, element: &TextBlock) {
            self.0 = element
                .box_model
                .size
                .width
                .fixed_value()
                .map(|width| SourceGeometry {
                    size: Size::new(width, element.border_box_block_extent()),
                    flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                    positioning: element.positioning.clone(),
                });
        }

        fn visit_container(&mut self, element: &Container) {
            let height = container_source_height(element);
            self.0 = element
                .box_model
                .size
                .width
                .fixed_value()
                .map(|width| SourceGeometry {
                    size: Size::new(width, height),
                    flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                    positioning: element.positioning.clone(),
                });
        }

        fn visit_flex_row(&mut self, element: &FlexRow) {
            let height = element.box_model.padding.vertical()
                + element
                    .box_model
                    .size
                    .height
                    .resolve(element.content.row_height)
                + element.box_model.border.vertical_width();
            self.0 = element.box_model.size.width.fixed_value().map(|width| {
                let mut positioning = element.positioning.clone();
                positioning.insets.left += element.inline_offset.value();
                SourceGeometry {
                    size: Size::new(width, height),
                    flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                    positioning,
                }
            });
        }

        fn visit_grid_row(&mut self, element: &GridRow) {
            let width = element.content.column_widths.iter().sum::<f32>()
                + element.content.gap
                    * element.content.column_widths.len().saturating_sub(1) as f32
                + element.box_model.padding.horizontal()
                + element.box_model.border.horizontal_width();
            let height = element
                .content
                .cells
                .iter()
                .map(|cell| cell.layout.box_model.minimum_block_size)
                .fold(0.0_f32, f32::max)
                + element.box_model.padding.vertical()
                + element.box_model.border.vertical_width();
            self.0 = Some(SourceGeometry {
                size: Size::new(width, height),
                flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                positioning: Default::default(),
            });
        }

        fn visit_table_row(&mut self, element: &TableRow) {
            self.0 = Some(SourceGeometry {
                size: Size::new(
                    element.box_inline_extent(),
                    element.content.cells.row_block_extent(),
                ),
                flow: element.flow,
                positioning: Positioning::default(),
            });
        }

        fn visit_image(&mut self, element: &Image) {
            self.0 = Some(SourceGeometry {
                size: element.geometry.size,
                flow: BlockFlowSpacing::from_margins(element.geometry.flow.margins),
                positioning: element.positioning.clone(),
            });
        }
    }

    let mut geometry = Geometry(None);
    element.accept(&mut geometry);
    geometry.0
}

/// Resolve an auto-width block descendant against its known content box.
pub(super) fn source_geometry_in_content(
    element: &dyn LayoutElement,
    available_width: f32,
) -> Option<SourceGeometry> {
    if let Some(geometry) = source_geometry(element) {
        return Some(geometry);
    }

    struct AutoWidthGeometry {
        available_width: f32,
        geometry: Option<SourceGeometry>,
    }

    impl LayoutVisitor for AutoWidthGeometry {
        fn visit_text_block(&mut self, element: &TextBlock) {
            if !element.box_model.size.width.is_fill_available() {
                return;
            }
            self.geometry = Some(SourceGeometry {
                size: Size::new(self.available_width, element.border_box_block_extent()),
                flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                positioning: element.positioning.clone(),
            });
        }

        fn visit_container(&mut self, element: &Container) {
            if element.box_model.size.width.is_fill_available() {
                self.geometry = Some(SourceGeometry {
                    size: Size::new(self.available_width, container_source_height(element)),
                    flow: BlockFlowSpacing::from_margins(element.box_model.margins),
                    positioning: element.positioning.clone(),
                });
            }
        }
    }

    let mut geometry = AutoWidthGeometry {
        available_width,
        geometry: None,
    };
    element.accept(&mut geometry);
    geometry.geometry
}

fn container_source_height(element: &Container) -> f32 {
    let natural_height = element.box_model.padding.vertical()
        + element.box_model.border.vertical_width()
        + crate::layout::paginate::simulate_block_flow(&element.children).height;
    element.box_model.size.height.resolve(natural_height)
}
