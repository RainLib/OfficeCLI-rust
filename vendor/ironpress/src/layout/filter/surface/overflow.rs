//! Conservative source-paint overflow discovery.

use crate::layout::elements::{
    BoxPaint, ColumnRule, Container, FlexRow, GridRow, Image, LayoutElement, LayoutVisitor,
    TextBlock, visit_layout_tree,
};
use crate::types::{EdgeSizes, Size};

use super::canvas::box_shadow_overflow;

pub(super) fn flex_cell_paint_overflow(
    cell: &crate::layout::engine::FlexCell,
    size: Size,
    filter_dpi: f32,
) -> Option<EdgeSizes> {
    if let Some(output) = &cell.paint.filter_output {
        return Some(output.raster_overflow);
    }
    let mut overflow = box_shadow_overflow(size, &cell.paint.shadows, filter_dpi)?;
    for child in &cell.nested_elements {
        overflow = overflow.max_each(source_paint_overflow(child.as_ref(), size, filter_dpi)?);
    }
    Some(overflow)
}

pub(super) fn source_paint_overflow(
    element: &dyn LayoutElement,
    size: Size,
    filter_dpi: f32,
) -> Option<EdgeSizes> {
    let mut overflow = PaintOverflow::new(size, filter_dpi);
    visit_layout_tree(element, &mut overflow);
    overflow.result
}

struct PaintOverflow {
    size: Size,
    filter_dpi: f32,
    result: Option<EdgeSizes>,
}

impl PaintOverflow {
    const fn new(size: Size, filter_dpi: f32) -> Self {
        Self {
            size,
            filter_dpi,
            result: Some(EdgeSizes::ZERO),
        }
    }

    fn merge(&mut self, overflow: Option<EdgeSizes>) {
        self.result = self
            .result
            .zip(overflow)
            .map(|(current, next)| current.max_each(next));
    }

    fn merge_box(&mut self, paint: &BoxPaint) {
        self.merge(box_shadow_overflow(
            self.size,
            &paint.shadows,
            self.filter_dpi,
        ));
    }
}

impl LayoutVisitor for PaintOverflow {
    fn visit_column_rule(&mut self, _element: &ColumnRule) {
        // Column rules do not paint outside their retained geometry.
    }

    fn visit_text_block(&mut self, element: &TextBlock) {
        self.merge_box(&element.paint);
        for run in element.lines.iter().flat_map(|line| &line.runs) {
            self.merge(box_shadow_overflow(
                self.size,
                &run.text_shadow,
                self.filter_dpi,
            ));
        }
    }

    fn visit_container(&mut self, element: &Container) {
        self.merge_box(&element.paint);
    }

    fn visit_flex_row(&mut self, element: &FlexRow) {
        self.merge_box(&element.paint);
        for cell in &element.content.cells {
            self.merge(box_shadow_overflow(
                self.size,
                &cell.paint.shadows,
                self.filter_dpi,
            ));
            if let Some(output) = &cell.paint.filter_output {
                self.merge(Some(output.raster_overflow));
            }
        }
    }

    fn visit_grid_row(&mut self, _element: &GridRow) {
        // Grid cell paint is bounded by its retained cell geometry.
    }

    fn visit_image(&mut self, element: &Image) {
        self.merge(Some(element.paint.raster_overflow));
    }
}
