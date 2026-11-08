//! Block child geometry shared by SourceGraphic paint paths.

use crate::layout::elements::LayoutNode;
use crate::style::computed::Position;
use crate::types::{Point, Rect};

use super::source::source_geometry_in_content;

/// Resolved border box of one child in a block formatting context.
#[derive(Clone, Copy)]
pub(crate) struct BlockChildFrame {
    pub(crate) border_box: Rect,
}

/// Coordinate spaces shared by every child of one block formatting context.
#[derive(Clone, Copy)]
pub(crate) struct BlockChildSpace {
    content_box: Rect,
    padding_box: Rect,
    absolute_containing_block: Option<Rect>,
}

impl BlockChildSpace {
    pub(crate) const fn new(
        content_box: Rect,
        padding_box: Rect,
        absolute_containing_block: Option<Rect>,
    ) -> Self {
        Self {
            content_box,
            padding_box,
            absolute_containing_block,
        }
    }
}

/// Resolve block children once for every SourceGraphic paint path. Sharing
/// this sequence prevents nested boxes from acquiring different device phases
/// based on which concrete parent type owns them.
pub(crate) fn block_child_frames(
    children: &[LayoutNode],
    space: BlockChildSpace,
) -> Option<Vec<BlockChildFrame>> {
    let mut frames = Vec::new();
    frames.try_reserve_exact(children.len()).ok()?;
    let mut cursor_y = space.content_box.origin.y;
    let mut previous_margin_end = 0.0;
    for child in children {
        if let Some(placed) = child.fragment_placement_owner() {
            let placement = placed.fragment_placement();
            let geometry =
                source_geometry_in_content(placed.fragment_source(), placement.size.width)?;
            frames.push(BlockChildFrame {
                border_box: Rect::new(
                    placement.resolve(space.content_box.origin, space.padding_box.origin),
                    geometry.size,
                ),
            });
            continue;
        }
        let geometry = source_geometry_in_content(child.as_ref(), space.content_box.size.width)?;
        let positioning = &geometry.positioning;
        let flow = geometry.flow;
        let (origin, advances_flow) = match positioning.scheme {
            Position::Absolute | Position::Fixed => {
                let containing_block = space.absolute_containing_block?;
                (
                    Point::new(
                        containing_block.origin.x + positioning.insets.left,
                        containing_block.origin.y + positioning.insets.top,
                    ),
                    false,
                )
            }
            Position::Static | Position::Relative | Position::Sticky => {
                cursor_y += collapsed_margin_start_extra(flow.margins.start, previous_margin_end);
                cursor_y += flow.internal.start;
                (
                    Point::new(
                        space.content_box.origin.x + positioning.insets.left,
                        cursor_y + positioning.insets.top,
                    ),
                    true,
                )
            }
        };
        frames.push(BlockChildFrame {
            border_box: Rect::new(origin, geometry.size),
        });
        if advances_flow {
            cursor_y +=
                geometry.size.height + flow.internal.end + flow.extra_end + flow.margins.end;
            previous_margin_end = flow.margins.end;
        }
    }
    Some(frames)
}

fn collapsed_margin_start_extra(start: f32, previous_end: f32) -> f32 {
    let collapsed = if start >= 0.0 && previous_end >= 0.0 {
        start.max(previous_end)
    } else if start < 0.0 && previous_end < 0.0 {
        start.min(previous_end)
    } else {
        start + previous_end
    };
    collapsed - previous_end
}
