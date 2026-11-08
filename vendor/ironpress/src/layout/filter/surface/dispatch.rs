//! Layout-element visitor dispatch for the source painter.

use crate::layout::elements::{
    ColumnRule, Container, FlexRow, GridRow, Image, LayoutVisitor, MulticolContainer, TableRow,
    TextBlock,
};
use crate::render::borders::CssRoundedRect;

use super::painter::SourcePainter;
use super::text::flex_line_max_baseline;

impl LayoutVisitor for SourcePainter<'_> {
    fn visit_column_rule(&mut self, element: &ColumnRule) {
        self.result = self.canvas.paint_column_rule(
            self.space.border_box.origin,
            element.height,
            element.paint,
        );
    }

    fn visit_text_block(&mut self, element: &TextBlock) {
        self.result = (|| {
            if element.text.writing_mode != crate::style::computed::WritingMode::HorizontalTb {
                return None;
            }
            let area = self.paint_box(element)?;
            let paint_lines = |painter: &mut SourcePainter<'_>| {
                painter.paint_text_lines(
                    &element.lines,
                    area.content_box,
                    element.text.alignment,
                    element.text.indent,
                )
            };
            if element.clipping.rect.is_some() {
                let clip = CssRoundedRect::new(self.space.border_box, element.paint.border_radii)
                    .inset(element.box_model.border.widths());
                self.paint_clipped_descendants(clip, paint_lines)
            } else {
                paint_lines(self)
            }
        })();
    }

    fn visit_container(&mut self, element: &Container) {
        self.result = (|| {
            let area = self.paint_box(element)?;
            if element.overflow.combined.clips() {
                let clip = CssRoundedRect::new(self.space.border_box, element.paint.border_radii)
                    .inset(element.box_model.border.widths());
                self.paint_clipped_descendants(clip, |painter| {
                    painter.paint_container_children(&element.children, area)
                })
            } else {
                self.paint_container_children(&element.children, area)
            }
        })();
    }

    fn visit_multicol_container(&mut self, element: &MulticolContainer) {
        let inherited = self.space.establishes_containing_block;
        self.space.establishes_containing_block = true;
        self.visit_container(&element.principal);
        self.space.establishes_containing_block = inherited;
    }

    fn visit_flex_row(&mut self, element: &FlexRow) {
        self.result = (|| {
            let content = self.paint_box(element)?.content_box;
            let max_baseline = flex_line_max_baseline(
                &element.content.cells,
                element.content.alignment,
                self.fonts,
            );
            for cell in &element.content.cells {
                self.paint_flex_cell(cell, element, content, max_baseline)?;
            }
            Some(())
        })();
    }

    fn visit_grid_row(&mut self, element: &GridRow) {
        self.result = (|| {
            let border_box = self.space.border_box;
            self.canvas.paint_border(
                border_box,
                &element.box_model.border,
                crate::types::CornerRadii::ZERO,
            )?;
            let frames = super::cells::grid_cell_source_frames(element);
            for (cell, frame) in element.content.cells.iter().zip(frames) {
                self.paint_grid_cell(
                    cell,
                    frame.border_box_in(border_box.origin),
                    super::painter::RootEffectHandling::Paint,
                )?;
            }
            Some(())
        })();
    }

    fn visit_table_row(&mut self, element: &TableRow) {
        self.result = self.paint_table_row(element);
    }

    fn visit_image(&mut self, element: &Image) {
        self.result = (|| {
            if element.paint.filter_effect.is_some() {
                return None;
            }
            let rect = self.space.border_box;
            if !element.paint.raster_overflow.is_zero() {
                return self.canvas.paint_expanded_raster(
                    &element.source,
                    rect,
                    element.paint.raster_overflow,
                );
            }
            if let Some(background) = element.paint.background_color {
                self.canvas.fill(rect, background);
            }
            let content = rect.inset(element.geometry.border.widths());
            self.canvas
                .paint_image(&element.source, content, element.sampling)?;
            self.canvas.paint_border(
                rect,
                &element.geometry.border,
                crate::types::CornerRadii::ZERO,
            )
        })();
    }
}
