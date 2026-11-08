use crate::layout::elements::LayoutElementTestExt;
use crate::layout::engine::{FlexCell, layout, layout_with_rules};
use crate::layout::roundoff::equal_with_roundoff;
use crate::parser::css::parse_stylesheet;
use crate::parser::html::{parse_html, parse_html_with_styles};
use crate::types::{Margin, PageSize};

fn top_level_flex_rows(html: &str) -> Vec<(f32, Vec<FlexCell>, f32)> {
    let parsed = parse_html_with_styles(html).expect("valid regression fixture");
    let rules = parsed
        .stylesheets
        .iter()
        .flat_map(|css| parse_stylesheet(css))
        .collect::<Vec<_>>();
    let pages = layout_with_rules(&parsed.nodes, PageSize::A4, Margin::default(), &rules);

    pages[0]
        .elements
        .iter()
        .filter_map(|(y, element)| {
            element.inspect_flex(|row| (*y, row.content.cells.clone(), row.content.row_height))
        })
        .collect()
}

#[test]
fn structured_flex_items_use_their_max_content_width() {
    let rows = top_level_flex_rows(
        r#"<!doctype html><html><head><style>
            * { box-sizing: border-box; }
            .bar { display: flex; justify-content: space-between; width: 520px; }
            .title { font-size: 26px; font-weight: bold; margin: 0; }
            .pill { display: flex; flex: 0 1 auto; padding: 0 8px; }
            .pill p { margin: 0; }
        </style></head><body>
            <div class="bar"><p class="title">Inventory aging</p>
                <div class="pill">Generated on Aug 10, 2026</div></div>
            <div class="bar"><p class="title">Inventory aging</p>
                <div class="pill"><p>Generated on Aug 10, 2026</p></div></div>
            <div class="bar"><p class="title">Inventory aging</p>
                <div class="pill"><span>Generated on Aug 10, 2026</span></div></div>
            <div class="bar"><p class="title">Inventory aging</p>
                <div class="pill" style="flex:0 0 auto"><p>Generated on Aug 10, 2026</p></div></div>
            <div class="bar"><p class="title">Inventory aging</p>
                <div class="pill" style="width:max-content"><p>Generated on Aug 10, 2026</p></div></div>
        </body></html>"#,
    );
    let widths = rows
        .iter()
        .filter(|(_, cells, _)| cells.len() == 2)
        .map(|(_, cells, _)| cells[1].width)
        .collect::<Vec<_>>();

    assert_eq!(widths.len(), 5, "one outer flex row per variant");
    let expected = widths[0];
    assert!(
        widths
            .iter()
            .all(|width| equal_with_roundoff(*width, expected)),
        "wrappers and intrinsic keywords must preserve max-content width: {widths:?}"
    );
}

#[test]
fn nested_flex_main_axis_sums_item_contributions_and_gap() {
    let rows = top_level_flex_rows(
        r#"<style>
            * { box-sizing: border-box; margin: 0; }
            .bar { display: flex; width: 520pt; }
            .pill { display: flex; gap: 10pt; padding: 0 8pt; }
            .first { width: 60pt; }
            .second { width: 70pt; }
        </style>
        <div class="bar"><div class="pill">
            <p class="first"></p><p class="second"></p>
        </div></div>"#,
    );

    assert_eq!(rows.len(), 1);
    assert!(
        equal_with_roundoff(rows[0].1[0].width, 156.0),
        "60 + 70 + 10 gap + 16 padding must set the flex base: {rows:?}"
    );
}

#[test]
fn structured_flex_basis_keeps_min_and_max_content_distinct() {
    let rows = top_level_flex_rows(
        r#"<style>
            * { box-sizing: border-box; margin: 0; }
            .bar { display: flex; width: 520pt; }
            .pill { display: flex; padding: 0 8pt; }
        </style>
        <div class="bar"><div class="pill" style="flex-basis:min-content;width:200pt">
            <p>Alpha Beta Gamma</p>
        </div></div>
        <div class="bar"><div class="pill" style="flex-basis:max-content;width:200pt">
            <p>Alpha Beta Gamma</p>
        </div></div>"#,
    );

    assert_eq!(rows.len(), 2);
    assert!(
        rows[0].1[0].width < rows[1].1[0].width,
        "min-content must wrap more narrowly than max-content: {rows:?}"
    );
    assert!(
        rows[1].1[0].width < 200.0,
        "a content basis must ignore the preferred width: {rows:?}"
    );
}

#[test]
fn structured_intrinsic_width_honors_descendant_selectors() {
    let rows = top_level_flex_rows(
        r#"<!doctype html><html><head><style>
            * { box-sizing: border-box; margin: 0; }
            .bar { display: flex; width: 520pt; }
            .bar .pill p { width: 140pt; }
            .pill { display: flex; padding: 0 8pt; }
        </style></head><body>
            <div class="bar"><div class="pill"><p></p></div></div>
        </body></html>"#,
    );

    assert_eq!(rows.len(), 1);
    assert!(
        equal_with_roundoff(rows[0].1[0].width, 156.0),
        "the descendant width must contribute with padding: {rows:?}"
    );
}

#[test]
fn nested_flex_content_expands_an_auto_height_row() {
    let rows = top_level_flex_rows(
        r#"<!doctype html><html><head><style>
            * { box-sizing: border-box; margin: 0; }
            .row { display: flex; min-height: 48px; width: 320px; }
            .cell { display: flex; padding: 8px 12px; width: 100%; }
            .stack { display: flex; flex-direction: column; }
            .stack b, .stack i { display: block; }
        </style></head><body>
            <div class="row"><div class="cell"><div class="stack">
                <b>Bowl Cleaner 1 L Bottle Long Name</b><i>SKU-12345</i>
            </div></div></div>
        </body></html>"#,
    );

    assert_eq!(
        rows.len(),
        1,
        "the outer row is the only top-level flex box"
    );
    assert!(
        rows[0].2 > 36.0,
        "wrapped nested content must grow beyond min-height: {rows:?}"
    );
}

#[test]
fn centered_flex_content_still_honors_min_height() {
    let rows = top_level_flex_rows(
        r#"<div style="display:flex;align-items:center;min-height:48px;width:320px">
            <div>Short</div>
        </div>"#,
    );

    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].2 >= 36.0,
        "cross-axis alignment must not discard min-height: {rows:?}"
    );
}

#[test]
fn empty_flex_container_keeps_its_flow_margin() {
    for spacer in [
        "display:flex",
        "display:flex;height:0",
        "display:block",
        "display:grid",
    ] {
        let nodes = parse_html(&format!(
            r#"<div style="height:22px">A</div>
                <div style="{spacer};margin-bottom:16px"></div>
                <div style="height:22px">B</div>"#,
        ))
        .expect("valid regression fixture");
        let pages = layout(&nodes, PageSize::A4, Margin::default());
        let positions = pages[0]
            .elements
            .iter()
            .filter_map(|(y, element)| {
                element.inspect_text(|block| {
                    let text = block
                        .lines
                        .iter()
                        .flat_map(|line| &line.runs)
                        .map(|run| run.text.as_str())
                        .collect::<String>();
                    (*y, text)
                })
            })
            .filter(|(_, text)| text == "A" || text == "B")
            .collect::<Vec<_>>();

        assert_eq!(positions.len(), 2);
        assert!(
            equal_with_roundoff(positions[1].0 - positions[0].0, 28.5),
            "22px height plus 16px margin must separate the bands for {spacer}: {positions:?}"
        );
    }
}

#[test]
fn intrinsic_constraints_measure_content_not_the_preferred_width() {
    let parsed = parse_html_with_styles(
        r#"<style>
            * { box-sizing: border-box; margin: 0; }
            .max { width: 200pt; max-width: min-content; }
            .min { width: 70pt; min-width: max-content; white-space: nowrap; }
        </style>
        <div class="max">alpha betabetabeta gamma</div>
        <div class="min">unbreakablewideword</div>"#,
    )
    .expect("valid regression fixture");
    let rules = parsed
        .stylesheets
        .iter()
        .flat_map(|css| parse_stylesheet(css))
        .collect::<Vec<_>>();
    let pages = layout_with_rules(&parsed.nodes, PageSize::A4, Margin::default(), &rules);
    let widths = pages[0]
        .elements
        .iter()
        .filter_map(|(_, element)| {
            element.inspect_text(|block| {
                (!block.lines.is_empty())
                    .then(|| block.box_model.size.width.fixed_value())
                    .flatten()
            })
        })
        .flatten()
        .collect::<Vec<_>>();

    assert_eq!(widths.len(), 2, "one principal box per constrained block");
    assert!(
        widths[0] < 200.0,
        "max-width:min-content must ignore width:200pt: {widths:?}"
    );
    assert!(
        widths[1] > 70.0,
        "min-width:max-content must ignore width:70pt: {widths:?}"
    );
}
