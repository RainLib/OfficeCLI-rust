use super::*;
use crate::layout::elements::{Container, Image, LayoutNode, LayoutVisitor, TextBlock};

/// Stateful position of the next normal-flow child in PDF coordinates.
///
/// `cursor_y` already includes the previous sibling's block-end margin;
/// retaining that margin separately lets the next block replace the summed
/// gap with the CSS-collapsed one. Every renderer, including table-row
/// formatting contexts, must return this state instead of silently breaking
/// the chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FlowPosition {
    pub(super) y: f32,
    pub(super) cursor_y: f32,
    pub(super) previous_margin_bottom: f32,
}

impl FlowPosition {
    pub(super) const fn new(y: f32, cursor_y: f32, previous_margin_bottom: f32) -> Self {
        Self {
            y,
            cursor_y,
            previous_margin_bottom,
        }
    }
}

/// Return the extra cursor shift after collapsing adjacent vertical margins.
pub(super) fn collapsed_margin_top_extra(margin_top: f32, prev_margin_bottom: f32) -> f32 {
    let collapsed = if margin_top >= 0.0 && prev_margin_bottom >= 0.0 {
        margin_top.max(prev_margin_bottom)
    } else if margin_top < 0.0 && prev_margin_bottom < 0.0 {
        margin_top.min(prev_margin_bottom)
    } else {
        margin_top + prev_margin_bottom
    };
    // `prev_margin_bottom` is already gone from the cursor; only apply the
    // excess of the collapsed gap over it.
    collapsed - prev_margin_bottom
}

/// Apply CSS `clear` to a flow cursor (PDF y, where down = smaller y). Pushes
/// the cursor down to the bottom of the relevant float(s) when it currently sits
/// above them, and breaks the margin-collapse chain (clearance is not a margin).
/// `left_bottom` / `right_bottom` are the lowest float bottoms per side in PDF y.
pub(super) fn clear_cursor(
    cursor_y: f32,
    clear: Clear,
    left_bottom: f32,
    right_bottom: f32,
    prev_margin_bottom: &mut f32,
) -> f32 {
    let clear_to = match clear {
        Clear::Left => left_bottom,
        Clear::Right => right_bottom,
        Clear::Both => left_bottom.min(right_bottom),
        Clear::None => return cursor_y,
    };
    if clear_to < cursor_y {
        *prev_margin_bottom = 0.0;
        clear_to
    } else {
        cursor_y
    }
}

/// How a child participates in adjacent-sibling vertical margin collapse,
/// mirroring the per-arm handling in `render_container_children`.
pub(super) enum CollapseRole {
    /// In-flow block: collapses with neighbours (margin-top, margin-bottom).
    Collapsing(f32, f32),
    /// Out of flow (absolute): contributes no height and leaves the running
    /// collapse state untouched (cursor `continue`s without resetting it).
    Skip,
    /// Non-collapsing in-flow content: consumes its own space and breaks the
    /// collapse chain for the next sibling.
    Barrier,
}

pub(super) fn collapse_role(element: &dyn LayoutElement) -> CollapseRole {
    if element.fragment_placement_owner().is_some() {
        return CollapseRole::Skip;
    }
    if element
        .positioning_owner()
        .is_some_and(|owner| owner.positioning().scheme.is_absolute())
    {
        return CollapseRole::Skip;
    }
    let Some(participant) = element.block_flow_participant() else {
        return CollapseRole::Barrier;
    };
    if !participant.is_in_flow_block() || !participant.collapses_outer_margins() {
        return CollapseRole::Barrier;
    }
    let margins = participant.margins();
    CollapseRole::Collapsing(margins.start, margins.end)
}

/// Sum of children heights with CSS adjacent-sibling vertical margin collapse
/// applied, mirroring the cursor advance in `render_container_children`.
///
/// `estimate_element_height` sums each child's full top+bottom margins; this
/// subtracts the collapse "savings" between consecutive in-flow siblings so a
/// container's painted height matches the collapsed flow.
/// Best-effort border-box width of a direct child, for deciding whether a scroll
/// container's content overflows horizontally. Returns `None` when the width is
/// not explicitly known (auto-width children shrink to fit and don't overflow).
pub(super) fn child_explicit_width(element: &dyn LayoutElement) -> Option<f32> {
    #[derive(Default)]
    struct Width(Option<f32>);

    impl LayoutVisitor for Width {
        fn visit_container(&mut self, element: &Container) {
            self.0 = element.box_model.size.width.fixed_value();
        }

        fn visit_text_block(&mut self, element: &TextBlock) {
            self.0 = element.box_model.size.width.fixed_value();
        }

        fn visit_image(&mut self, element: &Image) {
            self.0 = Some(element.geometry.size.width);
        }
    }

    let mut width = Width::default();
    element.accept(&mut width);
    width.0
}

/// The content overflow extent of a scroll container's children, as `(width,
/// height)` border-box points. Width is the widest direct child (explicit widths
/// only); height is the collapsed flow height. Used to size scrollbar thumbs and
/// to decide whether an `overflow: auto` axis actually overflows.
pub(super) fn children_overflow_extent(children: &[LayoutNode]) -> (f32, f32) {
    let w = children
        .iter()
        .filter_map(|child| child_explicit_width(child.as_ref()))
        .fold(0.0f32, f32::max);
    (w, collapsed_children_height(children))
}

pub(super) fn collapsed_children_height(children: &[LayoutNode]) -> f32 {
    // When any direct child floats, the auto content height excludes the floats
    // (they don't stretch the box) but includes any `clear` gap. Delegate to the
    // shared flow simulator so the painted box matches the measured height. The
    // plain (no-float) accumulation below is kept identical to avoid regressions.
    if children
        .iter()
        .any(|c| crate::layout::paginate::element_float(c) != Float::None)
    {
        return crate::layout::paginate::simulate_block_flow(children).height;
    }
    let mut total = 0.0f32;
    let mut prev_mb: Option<f32> = None;
    for child in children {
        total += crate::layout::engine::estimate_element_height(child);
        match collapse_role(child) {
            CollapseRole::Collapsing(mt, mb) => {
                if let Some(pmb) = prev_mb {
                    // Both margins are already in `total`; remove the overlap
                    // (their sum minus the collapsed gap).
                    let collapsed = if mt >= 0.0 && pmb >= 0.0 {
                        mt.max(pmb)
                    } else if mt < 0.0 && pmb < 0.0 {
                        mt.min(pmb)
                    } else {
                        mt + pmb
                    };
                    total -= pmb + mt - collapsed;
                }
                prev_mb = Some(mb);
            }
            // Absolute children don't break the chain; barriers do.
            CollapseRole::Skip => {}
            CollapseRole::Barrier => prev_mb = None,
        }
    }
    total
}

/// CSS stacking level for a direct container child.
pub(super) fn child_paint_order(
    element: &dyn LayoutElement,
) -> crate::layout::elements::StackingLevel {
    crate::layout::engine::layout_element_paint_order(element)
}

/// Recursively render a Container element and all its children.
///
/// `x` / `y` are the content-box origin (after padding).
/// `abs_pad_left` / `abs_pad_top` are the parent padding values so that
/// absolute-positioned children can be placed relative to the padding box.
/// Resolve the padding-box origin an absolute child must anchor to: the nearest
/// positioned ancestor recorded in `abs_origins` (keyed by the child's
/// containing-block depth), falling back to the immediate container's padding box
/// (`self_pad_origin`). This is what lets an absolute box skip static
/// intermediate ancestors and resolve against its real containing block.
pub(super) fn abs_child_anchor(
    cb: &Option<crate::layout::engine::ContainingBlock>,
    abs_origins: &HashMap<usize, PdfPoint>,
    self_pad_origin: PdfPoint,
) -> PdfPoint {
    cb.and_then(|c| abs_origins.get(&c.depth).copied())
        .unwrap_or(self_pad_origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::{IntoLayoutNode, TextBlock};
    use crate::layout::flow_metrics::{BlockFlowSpacing, BlockMargins};

    fn empty_block(margins: BlockMargins) -> LayoutNode {
        TextBlock {
            box_model: crate::layout::elements::BoxModel {
                margins,
                ..Default::default()
            },
            ..Default::default()
        }
        .boxed()
    }

    #[test]
    fn table_internal_spacing_stays_outside_sibling_margin_collapse() {
        let table = TableRow {
            flow: BlockFlowSpacing {
                margins: BlockMargins::new(4.0, 6.0),
                internal: BlockMargins::new(2.0, 3.0),
                ..Default::default()
            },
            ..Default::default()
        }
        .boxed();
        let children = vec![
            empty_block(BlockMargins::new(0.0, 10.0)),
            table,
            empty_block(BlockMargins::new(8.0, 0.0)),
        ];

        // Collapsed exterior gaps are max(10, 4) and max(6, 8). The
        // table's 2+3pt of internal spacing remains additive.
        assert_eq!(
            crate::layout::paginate::simulate_block_flow(&children).height,
            23.0
        );
        assert_eq!(collapsed_children_height(&children), 23.0);
    }
}
