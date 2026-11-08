//! Shared retained geometry for flex, grid, and table cells.

use crate::layout::cells::CellBox;
use crate::layout::filter::paint_space::PageBoxAnchor;
use crate::types::{Point, Rect, Size, Vector};

use super::super::geometry::BlockChildSpace;

/// One cell border box relative to its formatting-context principal.
///
/// The concrete formatting context resolves the offset and size once. Source
/// painting and post-pagination filter materialization then consume the same
/// frame, including the device-space anchor of nested descendants.
#[derive(Clone, Copy)]
pub(crate) struct CellSourceFrame {
    pub(crate) size: Size,
    border_offset: Vector,
}

impl CellSourceFrame {
    pub(crate) const fn new(size: Size, border_offset: Vector) -> Self {
        Self {
            size,
            border_offset,
        }
    }

    pub(in crate::layout::filter) fn page_anchor_in(self, parent: PageBoxAnchor) -> PageBoxAnchor {
        parent.offset(self.border_offset)
    }

    pub(crate) fn border_box_in(self, parent_origin: Point) -> Rect {
        Rect::new(parent_origin + self.border_offset, self.size)
    }

    /// Block space occupied by nested children after the cell's inline text.
    pub(crate) fn nested_child_space(
        self,
        parent_origin: Point,
        cell: &CellBox,
        baseline_shift: f32,
    ) -> BlockChildSpace {
        let border_box = self.border_box_in(parent_origin);
        let padding_box = border_box.inset(cell.box_model.border.widths());
        let mut content_box = border_box.inset(cell.box_model.content_insets);
        let block_offset = cell.content_block_offset(self.size.height) + baseline_shift;
        let text_extent = cell
            .content
            .lines
            .iter()
            .map(|line| line.height)
            .sum::<f32>();
        let consumed = block_offset + text_extent;
        content_box.origin.y += consumed;
        content_box.size.height = (content_box.size.height - consumed).max(0.0);
        BlockChildSpace::new(content_box, padding_box, Some(padding_box))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::{BoxModel, IntoLayoutNode, LayoutSize, TextBlock};
    use crate::layout::engine::{LayoutBorder, LayoutBorderSide, TextLine};
    use crate::types::{Color, EdgeSizes};

    #[test]
    fn nested_child_frame_includes_cell_track_content_and_text_offsets() {
        let border = LayoutBorder::uniform(LayoutBorderSide {
            width: 2.0,
            color: Color::BLACK,
            ..Default::default()
        });
        let child = TextBlock {
            box_model: BoxModel {
                size: LayoutSize::fixed(10.0, Some(8.0)),
                ..Default::default()
            },
            ..Default::default()
        }
        .boxed();
        let cell = CellBox {
            content: crate::layout::cells::CellContent {
                lines: vec![TextLine {
                    height: 12.0,
                    ..Default::default()
                }],
                children: vec![child],
            },
            box_model: crate::layout::cells::CellBoxModel {
                content_insets: EdgeSizes::new(3.0, 4.0, 5.0, 6.0),
                border_insets: EdgeSizes::uniform(2.0),
                border,
                ..Default::default()
            },
            ..Default::default()
        };
        let frame = CellSourceFrame::new(Size::new(60.0, 40.0), Vector::new(10.0, 4.0));
        let children = super::super::super::geometry::block_child_frames(
            &cell.content.children,
            frame.nested_child_space(Point::new(100.0, 200.0), &cell, 3.0),
        )
        .expect("finite nested child frames");

        assert_eq!(
            children[0].border_box,
            Rect::from_xywh(116.0, 222.0, 10.0, 8.0)
        );
    }
}
