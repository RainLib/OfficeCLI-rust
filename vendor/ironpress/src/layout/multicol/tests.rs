use super::distribution::balance_columns;
use super::flow::{
    ColumnFragmentation, SourceBlockRange, balance_fragmented_columns, fragment_columns,
    item_minimum_fragment_size,
};
use super::fragments::{make_fragment_box, project_text_lines_into_fragment};
use super::items::{ChildMulticolInfo, ColumnBreakInfo, MultiColItem};
use super::*;
use crate::layout::elements::{
    Container, IntoLayoutNode, LayoutElement, LayoutElementTestExt, LayoutElementTestMutExt,
    LayoutVisitor, Table, TextBlock, visit_layout_tree,
};
use crate::layout::engine::{LayoutBorderSide, TextLine};
use crate::layout::paginate::estimate_element_height;
use crate::parser::css::parse_stylesheet;
use crate::parser::html::parse_html_with_styles;
use crate::style::computed::{BorderSide, BorderStyle, Position};

fn layout_test_document(
    html: &str,
    page_size: crate::PageSize,
) -> Vec<crate::layout::engine::Page> {
    let document = parse_html_with_styles(html).expect("valid multicol test document");
    let rules = document
        .stylesheets
        .iter()
        .flat_map(|css| parse_stylesheet(css))
        .collect::<Vec<_>>();
    crate::layout::engine::layout_with_rules(
        &document.nodes,
        page_size,
        crate::Margin::uniform(0.0),
        &rules,
    )
}

fn test_abs_container(width: f32, height: f32, origin: Point) -> LayoutNode {
    Container {
        box_model: BoxModel {
            size: LayoutSize::fixed(width, Some(height)),
            ..Default::default()
        },
        positioning: Positioning::absolute_at(origin),
        ..Default::default()
    }
    .boxed()
}

fn item(height: f32, span_all: bool) -> MultiColItem {
    MultiColItem {
        elements: Vec::new(),
        height,
        fragmentation_height: height,
        width: 0.0,
        margin_bottom: 0.0,
        span_all,
        break_before_column: false,
        break_after_column: false,
        break_before_avoid_column: false,
        break_after_avoid_column: false,
        break_inside_avoid_column: false,
    }
}

fn paragraph_item(line_count: usize) -> MultiColItem {
    let line_height = 16.5;
    let margin_end = 7.5;
    let mut text = TextBlock::plain(
        (0..line_count)
            .map(|_| TextLine {
                height: line_height,
                ..Default::default()
            })
            .collect(),
    );
    text.box_model.margins = BlockMargins::new(0.0, margin_end);
    MultiColItem {
        elements: vec![text.boxed()],
        margin_bottom: margin_end,
        ..item(line_count as f32 * line_height + margin_end, false)
    }
}

fn atomic_avoid_item(height: f32) -> MultiColItem {
    MultiColItem {
        elements: vec![test_abs_container(1.0, height, Point::default())],
        break_inside_avoid_column: true,
        ..item(height, false)
    }
}

fn atomic_avoid_item_with_margin(box_height: f32, margin_bottom: f32) -> MultiColItem {
    MultiColItem {
        elements: vec![test_abs_container(1.0, box_height, Point::default())],
        fragmentation_height: box_height + margin_bottom,
        margin_bottom,
        break_inside_avoid_column: true,
        ..item(box_height + margin_bottom, false)
    }
}

#[test]
fn multicol_splitting_uses_fragmentation_capability_not_principal_box_shape() {
    let container = MultiColItem {
        elements: vec![Container::default().boxed()],
        ..item(48.0, false)
    };
    let table = MultiColItem {
        elements: vec![Table::new(Container::default()).boxed()],
        ..item(48.0, false)
    };

    assert!(item_is_splittable(&container));
    assert!(!item_is_splittable(&table));
}

#[test]
fn paginated_span_rows_preserve_exact_layout_offsets() {
    let mut style = ComputedStyle::default();
    style.column_rule = BorderSide::solid(2.0, style.column_rule.color);
    let rows = build_paginated_column_rows_with_spans(
        &[item(10.0, false), item(20.0, true)],
        2,
        40.0,
        10.0,
        3.0,
        100.0,
        90.0,
        &style,
    );

    assert_eq!(rows.len(), 1);
    let offsets: Vec<f32> = rows[0]
        .0
        .iter()
        .map(|element| {
            element
                .fragment_placement_owner()
                .map(|owner| owner.fragment_placement().block_offset())
                .expect("expected retained multicol fragment")
        })
        .collect();
    assert_eq!(offsets, vec![0.0, 0.0, 10.0]);
}

#[test]
fn ordinary_near_rule_shaped_container_remains_ordinary() {
    let mut ordinary = test_abs_container(2.005, 20.0, Point::new(3.0, 4.0));
    ordinary
        .update_container(|container| {
            container.box_model.border.left = LayoutBorderSide {
                width: 2.0,
                style: BorderStyle::Double,
                ..Default::default()
            };
        })
        .expect("ordinary absolute box must remain a container");

    assert!(ordinary.inspect_container(|_| ()).is_some());
}

#[test]
fn column_rule_identity_survives_subpoint_paint_perturbation() {
    let mut rule = make_rule_container(
        0,
        3.0,
        4.0,
        2.0,
        20.0,
        crate::types::Color::rgb(255, 0, 0),
        BorderStyle::Double,
    );
    rule.update_column_rule(|rule| rule.paint.width += 0.005)
        .expect("column rule must have semantic layout identity");
    assert_eq!(
        rule.inspect_column_rule(|rule| rule.paint.width),
        Some(2.005)
    );
    assert_eq!(
        rule.inspect_column_rule(|rule| rule.paint.style),
        Some(BorderStyle::Double)
    );
}

#[test]
fn auto_columns_do_not_discard_a_subpoint_continuation() {
    let mut first = item(50.0, false);
    first.elements = vec![test_abs_container(1.0, 50.0, Point::default())];
    let mut second = item(50.01, false);
    second.elements = vec![test_abs_container(1.0, 50.01, Point::default())];
    let items = [first, second];
    let fragmented = fragment_columns(&items, &[0, 1], ColumnFragmentation::fixed(2, 100.0));

    assert_eq!(fragmented.columns[0].len(), 2);
    assert_eq!(fragmented.columns[1].len(), 1);
    assert!(fragmented.columns[1][0].height > 0.0);
    assert!(fragmented.used_block_sizes[1] > 0.0);
}

#[test]
fn continuation_tracks_its_source_offset() {
    let items = [item(30.0, false)];
    let fragmented = fragment_columns(&items, &[0], ColumnFragmentation::fixed(2, 20.0));

    assert_eq!(fragmented.columns[0][0].source_top, 0.0);
    assert_eq!(fragmented.columns[1][0].source_top, 20.0);
}

#[test]
fn balance_fragments_one_breakable_box_across_requested_columns() {
    let mut breakable = item(22.0, false);
    breakable.elements = vec![test_abs_container(1.0, 22.0, Point::default())];

    let fragmented = balance_fragmented_columns(&[breakable], &[0], 2);

    assert_eq!(fragmented.columns.len(), 2);
    assert_eq!(fragmented.columns[0].len(), 1);
    assert_eq!(fragmented.columns[1].len(), 1);
    assert_eq!(fragmented.used_block_sizes, vec![11.0, 11.0]);
    assert_eq!(fragmented.columns[1][0].source_top, 11.0);
}

#[test]
fn balance_keeps_atomic_avoid_boxes_in_shortest_columns() {
    let items: Vec<_> = (0..6)
        .map(|_| atomic_avoid_item_with_margin(52.5, 7.5))
        .collect();

    let fragmented = balance_fragmented_columns(&items, &[0, 1, 2, 3, 4, 5], 2);
    let item_indices = fragmented
        .columns
        .iter()
        .filter(|column| !column.is_empty())
        .map(|column| {
            column
                .iter()
                .map(|fragment| fragment.item)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    assert_eq!(item_indices, vec![vec![0, 1, 2], vec![3, 4, 5]]);
    assert_eq!(fragmented.used_block_sizes, vec![180.0, 180.0]);
}

#[test]
fn continuation_does_not_repaint_consumed_text_lines() {
    let mut lines = vec![TextLine {
        height: 20.0,
        ..Default::default()
    }];

    project_text_lines_into_fragment(&mut lines, 20.0, SourceBlockRange::continuation(12.0));

    // The first source line begins 8pt below the fragment edge, so preserve
    // that empty leading area before placing the unconsumed text line.
    assert_eq!(
        lines.iter().map(|line| line.height).collect::<Vec<_>>(),
        vec![8.0, 20.0]
    );
}

#[test]
fn continuation_line_boundary_has_single_owner() {
    let mut lines = vec![
        TextLine {
            height: 20.0,
            ..Default::default()
        },
        TextLine {
            height: 20.0,
            ..Default::default()
        },
    ];

    project_text_lines_into_fragment(&mut lines, 0.0, SourceBlockRange::continuation(20.0));

    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].height, 20.0);
}

#[test]
fn bounded_text_fragment_does_not_steal_the_continuation_line() {
    let mut lines = vec![
        TextLine {
            height: 20.0,
            ..Default::default()
        },
        TextLine {
            height: 20.0,
            ..Default::default()
        },
    ];

    project_text_lines_into_fragment(&mut lines, 0.0, SourceBlockRange::bounded(0.0, 20.0));

    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].height, 20.0);
}

#[test]
fn definite_container_fragments_at_descendant_boundary_without_growing() {
    let text = |height| {
        TextBlock::plain(vec![TextLine {
            height,
            ..Default::default()
        }])
        .boxed()
    };
    let mut inner = Container::default();
    inner.box_model.size.height = BlockSize::definite(36.0);
    inner.box_model.padding = crate::types::EdgeSizes::axes(0.0, 3.75);
    inner.box_model.border.top.width = 1.5;
    inner.box_model.border.bottom.width = 1.5;
    inner.children = vec![text(14.4), text(16.5), text(14.4)];

    assert_eq!(
        inner.block_fragmentation_source().and_then(|source| {
            source.find_block_break(crate::layout::elements::FragmentBreakQuery::earliest_after(
                0.0,
                19.5,
                crate::layout::elements::FragmentBreakRule::Normal,
            ))
        }),
        Some(19.65)
    );
    assert_eq!(
        inner.block_fragmentation_source().and_then(|source| {
            source.find_block_break(crate::layout::elements::FragmentBreakQuery::latest_before(
                0.0,
                36.15 - 16.5,
                crate::layout::elements::FragmentBreakRule::Normal,
            ))
        }),
        Some(19.65)
    );

    let inner = MultiColItem::from_layout(
        vec![inner.boxed()],
        ChildMulticolInfo {
            span_all: false,
            definite_outer_height: Some(36.0),
            definite_outer_width: Some(43.5),
            breaks: ColumnBreakInfo::default(),
        },
    );
    let items = [item(16.5, false), inner];
    assert_eq!(item_minimum_fragment_size(&items[1]), 21.75);
    let probe = fragment_columns(&items, &[0, 1], ColumnFragmentation::balance_probe(2, 36.0));
    assert!(probe.used_block_sizes[0] > 36.0);
    let exact = fragment_columns(&items, &[0, 1], ColumnFragmentation::fixed(2, 36.15));
    assert_eq!(exact.columns[0].len(), 2);
    let fragmented = balance_fragmented_columns(&items, &[0, 1], 2);
    let fragments = fragmented
        .columns
        .iter()
        .map(|column| {
            column
                .iter()
                .map(|fragment| (fragment.item, fragment.source_top, fragment.height))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    assert_eq!(
        fragments,
        vec![
            vec![(0, 0.0, 16.5), (1, 0.0, 19.65)],
            vec![(1, 19.65, 16.35)],
        ]
    );
}

#[test]
fn sliced_container_projects_owned_children_and_preserves_inline_size() {
    let child = || {
        TextBlock::plain(vec![TextLine {
            height: 20.0,
            ..Default::default()
        }])
        .boxed()
    };
    let mut source = Container::default();
    source.box_model.size = LayoutSize {
        width: crate::layout::elements::InlineSize::fixed(43.5),
        height: BlockSize::definite(40.0),
    };
    source.children = vec![child(), child()];

    let first = make_fragment_box(
        &source,
        super::flow::ColumnFragment {
            item: 0,
            y: 3.0,
            height: 20.0,
            source_top: 0.0,
            is_first: true,
            is_last: false,
        }
        .placement(2.0, 10.0),
    );
    assert_eq!(
        first.inspect_container(|container| {
            (
                container.children.len(),
                container.box_model.size.width.fixed_value(),
                container.positioning.scheme,
            )
        }),
        Some((1, Some(43.5), Position::Static))
    );
    assert_eq!(
        first
            .fragment_placement_owner()
            .map(|owner| owner.fragment_placement()),
        Some(crate::layout::elements::FragmentPlacement::in_content_box(
            crate::types::Vector::new(2.0, 3.0),
            crate::types::Size::new(10.0, 20.0),
        ))
    );

    let continuation = make_fragment_box(
        &source,
        super::flow::ColumnFragment {
            item: 0,
            y: 0.0,
            height: 20.0,
            source_top: 20.0,
            is_first: false,
            is_last: true,
        }
        .placement(0.0, 10.0),
    );
    assert_eq!(
        continuation.inspect_container(|container| container.children.len()),
        Some(1)
    );
}

#[test]
fn balanced_paragraphs_do_not_emit_empty_continuation_fragments() {
    let items = [
        paragraph_item(3),
        paragraph_item(4),
        paragraph_item(3),
        paragraph_item(3),
    ];

    let probe = fragment_columns(
        &items,
        &[0, 1, 2, 3],
        ColumnFragmentation::balance_probe(2, 130.5),
    );
    assert_eq!(
        probe
            .columns
            .iter()
            .map(|column| {
                column
                    .iter()
                    .map(|fragment| (fragment.item, fragment.source_top, fragment.height))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
        vec![
            vec![(0, 0.0, 49.5), (1, 0.0, 66.0)],
            vec![(2, 0.0, 49.5), (3, 0.0, 49.5)],
        ]
    );
    assert_eq!(probe.used_block_sizes, vec![130.5, 114.0]);
    let fragmented = balance_fragmented_columns(&items, &[0, 1, 2, 3], 2);
    let fragments = fragmented
        .columns
        .iter()
        .map(|column| {
            column
                .iter()
                .map(|fragment| {
                    (
                        fragment.item,
                        fragment.source_top,
                        fragment.height,
                        fragment.is_first,
                        fragment.is_last,
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    assert_eq!(
        fragments,
        vec![
            vec![(0, 0.0, 49.5, true, true), (1, 0.0, 66.0, true, true),],
            vec![(2, 0.0, 49.5, true, true), (3, 0.0, 49.5, true, true),],
        ]
    );
}

#[test]
fn balanced_pages_do_not_absorb_visible_overflow() {
    let style = ComputedStyle::default();
    let rows = build_paginated_column_rows_with_spans(
        &[item(50.0, false), item(50.5, false)],
        1,
        100.0,
        0.0,
        0.0,
        100.0,
        100.0,
        &style,
    );

    assert_eq!(rows.len(), 2);
}

#[test]
fn paginated_auto_columns_grow_from_actual_atomic_placement() {
    let items: Vec<_> = (0..20).map(|_| atomic_avoid_item(51.0)).collect();
    let rows =
        build_paginated_column_rows(&items, 2, 40.0, 0.0, 0.0, 100.0, &ComputedStyle::default());

    assert_eq!(rows.len(), 10);
    let mut placed = 0;
    for (columns, row_used) in rows {
        assert_eq!(row_used, 51.0);
        assert_eq!(columns.len(), 2);
        for column in columns {
            let (column_used, child_count) = column
                .inspect_container(|container| {
                    (
                        container.box_model.size.height.used(),
                        container.children.len(),
                    )
                })
                .and_then(|(height, child_count)| height.map(|height| (height, child_count)))
                .expect("expected a definite-height column container");
            assert!(column_used <= 100.0);
            placed += child_count;
        }
    }
    assert_eq!(placed, 20);
}

#[test]
fn empty_flow_anchor_has_exactly_zero_flow_height() {
    let anchor = empty_flow_anchor();
    assert_eq!(estimate_element_height(&anchor), 0.0);
    assert_eq!(
        anchor.inspect_container(|container| {
            (
                container.paint.visible,
                container.positioning.scheme,
                container.box_model.size,
            )
        }),
        Some((
            false,
            Position::Static,
            crate::layout::elements::LayoutSize::fixed(0.0, Some(0.0)),
        ))
    );
}

#[test]
fn balanced_column_fragments_do_not_multiply_the_wrapper_flow_height() {
    let pages = layout_test_document(
        r#"
        <style>
          @page { size: 600px 176px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .columns {
            column-count: 3;
            column-gap: 24px;
            column-fill: balance;
            width: 480px;
            margin: 20px;
            border: 2px solid;
            padding: 8px;
          }
          .block { height: 48px; margin-bottom: 8px; }
        </style>
        <div class="columns">
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
        </div>
        "#,
        crate::PageSize::new(600.0, 176.0),
    );

    assert_eq!(pages.len(), 1);
}

#[test]
fn paginated_auto_columns_retain_each_fragmentainer_row() {
    let pages = layout_test_document(
        r#"
        <style>
          @page { size: 384px 152px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .columns {
            column-count: 2;
            column-gap: 40px;
            column-fill: auto;
          }
          .block { height: 50px; border: 2px solid; }
        </style>
        <div class="columns">
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
          <div class="block"></div><div class="block"></div>
        </div>
        "#,
        crate::PageSize::new(384.0, 152.0),
    );

    assert_eq!(pages.len(), 2);
}

#[test]
fn multicol_retains_absolute_inline_descendant_and_its_containing_block() {
    let pages = layout_test_document(
        r#"
        <style>
          @page { size: 220px 120px; margin: 0; }
          * { box-sizing: border-box; margin: 0; }
          .columns {
            position: relative;
            column-count: 2;
            column-gap: 7px;
            width: 126px;
            height: 68px;
            padding: 7px;
            border: 2px solid black;
          }
          .own { height: 22px; }
          .own > span:last-child {
            position: absolute;
            right: 4px;
            bottom: 4px;
          }
        </style>
        <div class="columns"><div class="own"><span>Ag</span><span>Bb</span></div></div>
        "#,
        crate::PageSize::new(220.0, 120.0),
    );

    #[derive(Default)]
    struct PositionedBb(Option<crate::layout::elements::Positioning>);

    impl LayoutVisitor for PositionedBb {
        fn visit_text_block(&mut self, element: &TextBlock) {
            let text = element
                .lines
                .iter()
                .flat_map(|line| &line.runs)
                .map(|run| run.text.as_str())
                .collect::<String>();
            if text == "Bb" {
                self.0 = Some(element.positioning.clone());
            }
        }
    }

    let mut positioned = PositionedBb::default();
    for (_, element) in &pages[0].elements {
        visit_layout_tree(element.as_ref(), &mut positioned);
    }
    let positioning = positioned
        .0
        .expect("absolute inline descendant must remain a distinct layout box");
    assert_eq!(positioning.scheme, Position::Absolute);
    let containing_block = positioning
        .containing_block
        .expect("absolute inline descendant must retain the multicol containing block");
    assert_eq!(containing_block.width, 122.0 * crate::fonts::PT_PER_CSS_PX);
    assert_eq!(containing_block.height, 64.0 * crate::fonts::PT_PER_CSS_PX);
}

#[test]
fn balancing_search_does_not_skip_an_exact_breakpoint() {
    // The former 257-point sample grid chose a limit above 1400.52 and
    // incorrectly kept item 5 in the second column, making it 1407.26pt.
    // The true minimum follows the exact contiguous-item breakpoint.
    let heights = [
        362.37, 407.46, 438.81, 906.81, 493.71, 6.74, 58.45, 677.37, 374.74, 918.12, 210.30,
    ];

    assert_eq!(
        balance_columns(&heights, 4),
        vec![vec![0, 1, 2], vec![3, 4], vec![5, 6, 7, 8], vec![9, 10]]
    );
}
