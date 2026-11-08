//! Block-axis measurement for concrete layout nodes.

use crate::layout::cells::TableRowCells;
use crate::layout::elements::{
    Container, FlexRow, GridRow, HorizontalRule, Image, LayoutElement, LayoutVisitor, MathBlock,
    ProgressBar, Svg, TableRow, TextBlock,
};
/// Measure one laid-out node's outer block-axis extent.
pub(crate) fn element_height(element: &dyn LayoutElement) -> f32 {
    if !element.contributes_to_normal_flow() {
        return 0.0;
    }

    #[derive(Default)]
    struct Height(f32);

    impl LayoutVisitor for Height {
        fn visit_text_block(&mut self, element: &TextBlock) {
            if element.positioning.scheme.is_absolute() {
                return;
            }
            let text_height = element.lines.iter().map(|line| line.height).sum::<f32>();
            let content_height = element.box_model.padding.vertical() + text_height;
            let used_height = if element.clipping.rect.is_some() {
                element.box_model.size.height.resolve(content_height)
            } else {
                element
                    .box_model
                    .size
                    .height
                    .used()
                    .map_or(content_height, |height| content_height.max(height))
            };
            self.0 = element.box_model.margins.total()
                + used_height
                + element.box_model.border.vertical_width();
        }

        fn visit_flex_row(&mut self, element: &FlexRow) {
            self.0 = element.box_model.margins.total()
                + element.box_model.padding.vertical()
                + element
                    .box_model
                    .size
                    .height
                    .resolve(element.content.row_height)
                + element.box_model.border.vertical_width();
        }

        fn visit_table_row(&mut self, element: &TableRow) {
            let row_height = element.content.cells.row_block_extent();
            self.0 = element.flow.outer_extent(row_height);
        }

        fn visit_grid_row(&mut self, element: &GridRow) {
            let row_height = element
                .content
                .cells
                .iter()
                .map(|cell| cell.layout.box_model.minimum_block_size)
                .fold(0.0, f32::max);
            self.0 = element.box_model.margins.total()
                + element.box_model.padding.vertical()
                + row_height;
        }

        fn visit_image(&mut self, element: &Image) {
            self.0 = element
                .geometry
                .flow
                .outer_extent(element.geometry.size.height);
        }

        fn visit_svg(&mut self, element: &Svg) {
            self.0 = element
                .geometry
                .flow
                .outer_extent(element.geometry.size.height);
        }

        fn visit_horizontal_rule(&mut self, element: &HorizontalRule) {
            self.0 = element.margins.total() + 1.0;
        }

        fn visit_progress_bar(&mut self, element: &ProgressBar) {
            self.0 = element.margins.total() + element.size.height;
        }

        fn visit_math_block(&mut self, element: &MathBlock) {
            self.0 = element.margins.total() + element.layout.height();
        }

        fn visit_container(&mut self, element: &Container) {
            if element.positioning.scheme.is_absolute() {
                return;
            }
            let natural_height = element.box_model.padding.vertical()
                + element.box_model.border.vertical_width()
                + super::simulate_block_flow(&element.children).height;
            let content_height = element.box_model.size.height.resolve(natural_height);
            self.0 = element.box_model.margins.total() + content_height;
        }
    }

    let mut height = Height::default();
    element.accept(&mut height);
    height.0
}
