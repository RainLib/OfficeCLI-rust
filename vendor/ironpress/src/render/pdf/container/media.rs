use super::*;
use crate::layout::elements::{Image, Positioning, ReplacedGeometry, Svg};

struct ReplacedChildPlacement {
    paint_box: PdfRect,
    next_flow: FlowPosition,
}

fn place_replaced_child(
    geometry: &ReplacedGeometry,
    positioning: &Positioning,
    child_index: usize,
    flow: &ContainerFlowContext<'_>,
    position: FlowPosition,
    abs_origins: &HashMap<usize, PdfPoint>,
) -> ReplacedChildPlacement {
    if positioning.scheme.is_absolute() {
        let anchor = abs_child_anchor(
            &positioning.containing_block,
            abs_origins,
            flow.frame.padding_origin,
        );
        return ReplacedChildPlacement {
            paint_box: PdfRect::from_top(
                anchor.x + positioning.insets.left,
                anchor.y - positioning.insets.top,
                geometry.size.width,
                geometry.size.height,
            ),
            next_flow: position,
        };
    }

    let FlowPosition {
        mut y,
        mut cursor_y,
        previous_margin_bottom,
    } = position;
    let planned_flow_top = flow.flow_top_by_index.get(&child_index).copied();
    let flow_top = if let Some(top) = planned_flow_top {
        top
    } else {
        cursor_y -= collapsed_margin_top_extra(geometry.flow.margins.start, previous_margin_bottom);
        cursor_y
    };
    let used_origin = positioning.resolve_in_flow_origin(
        crate::types::Point::new(0.0, flow.container_top_y - flow_top),
        geometry.size,
        flow.frame.size,
    );
    let paint_box = PdfRect::from_top(
        flow.frame.content_origin.x + used_origin.x,
        flow.container_top_y - used_origin.y,
        geometry.size.width,
        geometry.size.height,
    );
    if planned_flow_top.is_none() {
        cursor_y -= geometry.size.height + geometry.flow.extra_end + geometry.flow.margins.end;
        y = cursor_y;
    }
    ReplacedChildPlacement {
        paint_box,
        next_flow: FlowPosition::new(y, cursor_y, geometry.flow.margins.end),
    }
}

pub(super) fn render_image_child(
    content: &mut String,
    child: &Image,
    child_index: usize,
    flow: &ContainerFlowContext<'_>,
    position: FlowPosition,
    abs_origins: &HashMap<usize, PdfPoint>,
    ctx: &mut PageRenderContext<'_>,
) -> FlowPosition {
    let placement = place_replaced_child(
        &child.geometry,
        &child.positioning,
        child_index,
        flow,
        position,
        abs_origins,
    );
    // Replaced content is atomic in its parent's in-flow contents phase. Its
    // own background, source, border, transform, mask, and opacity must stay in
    // one paint group; replaying it during the parent's decoration phase would
    // duplicate the complete image (and square any transparency).
    if flow.paint_phase.paints_contents() {
        paint_image_box(content, child, placement.paint_box, ctx);
    }
    placement.next_flow
}

pub(super) fn render_svg_child(
    content: &mut String,
    child: &Svg,
    child_index: usize,
    flow: &ContainerFlowContext<'_>,
    position: FlowPosition,
    abs_origins: &HashMap<usize, PdfPoint>,
    ctx: &mut PageRenderContext<'_>,
) -> FlowPosition {
    let placement = place_replaced_child(
        &child.geometry,
        &child.positioning,
        child_index,
        flow,
        position,
        abs_origins,
    );
    if flow.paint_phase.paints_contents() {
        paint_svg_box(content, child, placement.paint_box, ctx);
    }
    placement.next_flow
}
