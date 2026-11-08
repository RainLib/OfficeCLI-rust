use super::support::layout_pages;
use crate::layout::cells::GridPaintOrder;
use crate::layout::elements::{
    FlexRow, GridRow, LayoutVisitor, StackingLevel, StackingParticipant,
};
use crate::layout::engine::{layout_element_paint_order, visit_layout_tree};
use crate::style::computed::Position;

#[derive(Default)]
struct PaintedGridItems(Vec<(usize, StackingLevel)>);

impl LayoutVisitor for PaintedGridItems {
    fn visit_grid_row(&mut self, row: &GridRow) {
        self.0.extend(
            row.content
                .cells
                .iter()
                .filter(|cell| cell.layout.paint.background.color.is_some())
                .map(|cell| (cell.placement.column_start, cell.layout.stacking_level())),
        );
    }
}

#[test]
fn overlapping_grid_items_remain_independent_and_in_document_order() {
    let pages = layout_pages(
        r#"
        <style>
            .grid { display:grid; grid-template-columns:100px; grid-template-rows:80px; }
            .item { grid-area:1 / 1 / 2 / 2; }
            .first { background:red; z-index:2; }
            .second { background:green; z-index:1; }
        </style>
        <div class="grid">
            <div class="item first"></div>
            <div class="item second"></div>
        </div>
        "#,
    );
    let mut items = PaintedGridItems::default();
    for page in pages {
        for (_, element) in page.elements {
            visit_layout_tree(element.as_ref(), &mut items);
        }
    }
    assert_eq!(
        items.0,
        [
            (0, StackingLevel::positive(2)),
            (0, StackingLevel::positive(1)),
        ]
    );
}

#[derive(Default)]
struct GridItemPaintOrders(Vec<GridPaintOrder>);

impl LayoutVisitor for GridItemPaintOrders {
    fn visit_grid_row(&mut self, row: &GridRow) {
        self.0.extend(
            row.content
                .cells
                .iter()
                .filter(|cell| cell.layout.paint.background.color.is_some())
                .map(|cell| cell.placement.paint_order),
        );
    }
}

#[test]
fn grid_items_retain_order_modified_document_order_for_paint() {
    let pages = layout_pages(
        r#"
        <style>
            .grid { display:grid; grid-template:80px / 100px; }
            .item { grid-area:1 / 1; }
            .first { background:red; order:2; }
            .second { background:green; order:1; }
        </style>
        <div class="grid">
            <div class="item first"></div>
            <div class="item second"></div>
        </div>
        "#,
    );
    let mut orders = GridItemPaintOrders::default();
    for page in pages {
        for (_, element) in page.elements {
            visit_layout_tree(element.as_ref(), &mut orders);
        }
    }
    assert_eq!(
        orders.0,
        [GridPaintOrder::new(2, 0), GridPaintOrder::new(1, 1)]
    );
}

#[derive(Default)]
struct FlexItemOffsets(Vec<(f32, f32)>);

impl LayoutVisitor for FlexItemOffsets {
    fn visit_flex_row(&mut self, row: &FlexRow) {
        self.0.extend(
            row.content
                .cells
                .iter()
                .filter(|cell| cell.paint.background.color.is_some())
                .map(|cell| (cell.x_offset, cell.width)),
        );
    }
}

#[test]
fn flex_items_retain_adjacent_sibling_selector_context() {
    let pages = layout_pages(
        r#"
        <style>
            .flex { display:flex; width:120px; }
            .item { flex:0 0 50px; height:20px; }
            .item + .item { margin-left:-30px; }
            .first { background:red; }
            .second { background:green; }
        </style>
        <div class="flex">
            <div class="item first"></div>
            <div class="item second"></div>
        </div>
        "#,
    );
    let mut items = FlexItemOffsets::default();
    for page in pages {
        for (_, element) in page.elements {
            visit_layout_tree(element.as_ref(), &mut items);
        }
    }
    let [first, second] = items.0.as_slice() else {
        panic!("expected exactly two painted flex items");
    };
    assert!(second.0 < first.0 + first.1, "items should overlap");
}

#[test]
fn pagination_preserves_source_order_for_the_paint_planner() {
    let pages = layout_pages(
        r#"
        <div style="position:relative; z-index:2; width:20px; height:20px; background:red"></div>
        <div style="position:relative; z-index:1; width:20px; height:20px; background:green"></div>
        "#,
    );
    let levels: Vec<_> = pages[0]
        .elements
        .iter()
        .map(|(_, element)| layout_element_paint_order(element.as_ref()))
        .collect();
    assert_eq!(
        levels,
        [StackingLevel::positive(2), StackingLevel::positive(1)]
    );
}

#[test]
fn flex_and_grid_formatting_contexts_retain_authored_absolute_offsets() {
    let pages = layout_pages(
        r#"
        <style>
          * { margin:0; padding:0; box-sizing:border-box }
          .panel { position:absolute; top:16px; width:40px; height:40px }
          .a { left:16px }
          .b { left:80px }
          .c { left:144px }
          .d { left:208px }
          .flex { display:flex }
          .grid { display:grid; grid-template-columns:20px }
        </style>
        <div class="panel flex a"><span></span></div>
        <div class="panel flex b"><span></span></div>
        <div class="panel grid c"><span></span></div>
        <div class="panel grid d"><span></span></div>
        "#,
    );
    let offsets: Vec<_> = pages[0]
        .elements
        .iter()
        .filter_map(|(_, element)| element.positioning_owner())
        .filter(|owner| owner.positioning().scheme == Position::Absolute)
        .map(|owner| {
            (
                owner.positioning().insets.left,
                owner.positioning().insets.top,
            )
        })
        .collect();

    assert_eq!(
        offsets,
        [(12.0, 12.0), (60.0, 12.0), (108.0, 12.0), (156.0, 12.0)]
    );
}
