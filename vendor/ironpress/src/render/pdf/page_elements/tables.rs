use super::*;
use crate::layout::elements::{GridRow, LayoutElement, TableRow};

fn paint_root_row(
    content: &mut String,
    element: &dyn LayoutElement,
    frame: PageElementFrame<'_>,
    ctx: &mut PageRenderContext<'_>,
) {
    let top = frame.page_size.height - frame.margin.top - frame.y_pos;
    let mut abs_origins = HashMap::new();
    render_rows(
        content,
        &[element],
        frame.margin.left,
        NestedRowsFlow::resolved(FlowPosition::new(top, top, 0.0)),
        true,
        &mut abs_origins,
        ctx,
    );
}

pub(in crate::render::pdf) fn render_table_row(
    content: &mut String,
    element: &TableRow,
    frame: PageElementFrame<'_>,
    ctx: &mut PageRenderContext<'_>,
) {
    paint_root_row(content, element, frame, ctx);
}

pub(in crate::render::pdf) fn render_grid_row(
    content: &mut String,
    element: &GridRow,
    frame: PageElementFrame<'_>,
    ctx: &mut PageRenderContext<'_>,
) {
    paint_root_row(content, element, frame, ctx);
}
