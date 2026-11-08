use crate::layout::elements::{GridRow, LayoutVisitor, TextBlock};
use crate::layout::engine::visit_layout_tree;
use crate::style::computed::Position;
use crate::types::{Margin, PageSize};

use super::support::{layout_pages_at, layout_pages_at_with_fonts};

#[derive(Debug, Default)]
struct PositionedGridEvidence {
    cell_depths: Vec<usize>,
    absolute_text: Vec<(
        String,
        crate::types::EdgeSizes,
        crate::layout::engine::ContainingBlock,
    )>,
}

impl LayoutVisitor for PositionedGridEvidence {
    fn visit_grid_row(&mut self, row: &GridRow) {
        self.cell_depths.extend(
            row.content
                .cells
                .iter()
                .map(|cell| cell.layout.positioning.containing_block_depth)
                .filter(|depth| *depth > 0),
        );
    }

    fn visit_text_block(&mut self, block: &TextBlock) {
        if block.positioning.scheme != Position::Absolute {
            return;
        }
        let Some(containing_block) = block.positioning.containing_block else {
            return;
        };
        self.absolute_text.push((
            block
                .lines
                .iter()
                .flat_map(|line| &line.runs)
                .map(|run| run.text.as_str())
                .collect(),
            block.positioning.insets,
            containing_block,
        ));
    }
}

fn positioned_grid_evidence(markup: &str) -> PositionedGridEvidence {
    let mut evidence = PositionedGridEvidence::default();
    for page in layout_pages_at(markup, PageSize::new(300.0, 180.0)) {
        for (_, element) in page.elements {
            visit_layout_tree(element.as_ref(), &mut evidence);
        }
    }
    evidence
}

#[test]
fn static_grid_item_forwards_the_positioned_grid_containing_block() {
    let evidence = positioned_grid_evidence(
        r#"
        <style>
          * { box-sizing:border-box; margin:0 }
          .grid { display:grid; position:relative; width:120px; height:60px;
                  padding:7px; border:2px solid black }
          .abs { position:absolute; right:4px; bottom:5px; width:10px; height:8px }
        </style>
        <div class="grid"><div><span>Ag</span><span class="abs">Bb</span></div></div>
        "#,
    );

    let (_, insets, containing_block) = evidence
        .absolute_text
        .iter()
        .find(|(text, _, _)| text == "Bb")
        .expect("absolute grid descendant");
    assert_eq!(containing_block.depth, 1, "{evidence:#?}");
    assert!(
        (containing_block.width - 87.0).abs() < 0.01,
        "{evidence:#?}"
    );
    assert!(
        (containing_block.height - 42.0).abs() < 0.01,
        "{evidence:#?}"
    );
    assert!(insets.left > 70.0 && insets.top > 25.0, "{evidence:#?}");
}

#[test]
fn positioned_grid_item_replaces_its_ancestor_containing_block() {
    let evidence = positioned_grid_evidence(
        r#"
        <style>
          * { box-sizing:border-box; margin:0 }
          .grid { display:grid; position:relative; width:160px; height:90px }
          .item { position:relative; width:60px; height:40px;
                  padding:5px; border:2px solid black }
          .abs { position:absolute; right:4px; bottom:5px; width:10px; height:8px }
        </style>
        <div class="grid"><div class="item"><div><span>A</span><span class="abs">B</span></div></div></div>
        "#,
    );

    let (_, insets, containing_block) = evidence
        .absolute_text
        .iter()
        .find(|(text, _, _)| text == "B")
        .expect("absolute descendant of positioned grid item");
    assert_eq!(evidence.cell_depths, [2], "{evidence:#?}");
    assert_eq!(containing_block.depth, 2, "{evidence:#?}");
    assert!(
        (containing_block.width - 42.0).abs() < 0.01,
        "{evidence:#?}"
    );
    assert!(
        (containing_block.height - 27.0).abs() < 0.01,
        "{evidence:#?}"
    );
    assert!(insets.left > 25.0 && insets.top > 10.0, "{evidence:#?}");
}

#[derive(Debug, Default)]
struct GridRows {
    line_heights: Vec<Vec<Vec<f32>>>,
    minimum_heights: Vec<Vec<f32>>,
}

impl LayoutVisitor for GridRows {
    fn visit_grid_row(&mut self, row: &GridRow) {
        self.line_heights.push(
            row.content
                .cells
                .iter()
                .map(|cell| {
                    cell.layout
                        .content
                        .lines
                        .iter()
                        .map(|line| line.height)
                        .collect()
                })
                .collect(),
        );
        self.minimum_heights.push(
            row.content
                .cells
                .iter()
                .map(|cell| cell.layout.box_model.minimum_block_size)
                .collect(),
        );
    }
}

#[test]
fn display_contents_text_contributes_full_line_boxes_to_auto_rows() {
    let markup = r#"
        <style>
          * { box-sizing:border-box; margin:0 }
          body { font:16px/1.25 ParitySans }
          .grid { display:grid; grid-template-columns:160px 300px; gap:8px }
          .row { display:contents }
          .label,.value { padding:8px; border:3px solid black }
        </style>
        <div class="grid">
          <div class="row"><div class="label">ONE</div><div class="value">single line</div></div>
          <div class="row"><div class="label">TWO</div><div class="value">line one<br>line two<br>line three</div></div>
          <div class="row"><div class="label">THREE<br>label<br>is<br>tallest</div><div class="value">short</div></div>
        </div>
    "#;
    let pages = layout_pages_at(markup, PageSize::new(600.0, 500.0));
    let mut rows = GridRows::default();
    for page in &pages {
        for (_, element) in &page.elements {
            visit_layout_tree(element.as_ref(), &mut rows);
        }
    }

    assert_eq!(pages.len(), 1, "auto rows must not spuriously paginate");
    assert_eq!(rows.minimum_heights.len(), 3, "{rows:#?}");
    assert!(
        rows.line_heights[0]
            .iter()
            .flatten()
            .all(|height| *height >= 15.0)
    );
    assert!(rows.minimum_heights[0].iter().all(|height| *height >= 27.0));
    assert!(rows.minimum_heights[1].iter().all(|height| *height >= 57.0));
    assert!(rows.minimum_heights[2].iter().all(|height| *height >= 72.0));
}

#[derive(Debug, Default)]
struct GridLineRuns {
    lines: Vec<Vec<String>>,
    row_start_margins: Vec<f32>,
}

impl LayoutVisitor for GridLineRuns {
    fn visit_grid_row(&mut self, row: &GridRow) {
        self.row_start_margins.push(row.box_model.margins.start);
        self.lines.extend(row.content.cells.iter().flat_map(|cell| {
            cell.layout.content.lines.iter().map(|line| {
                line.runs
                    .iter()
                    .map(|run| run.text.clone())
                    .collect::<Vec<_>>()
            })
        }));
    }
}

#[test]
fn fragmented_display_contents_keeps_unspaced_url_runs_adjacent() {
    let font = crate::parser::ttf::parse_ttf(
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/parity/fonts/ParitySans.ttf"),
        )
        .expect("ParitySans fixture font"),
    )
    .expect("valid ParitySans fixture font");
    let fonts = std::collections::HashMap::from([("paritysans".to_string(), font)]);
    let markup = include_str!(
        "../../../tests/parity/cases/grid/grid-display-contents-fragmentation-text-survival.html"
    );
    let pages = layout_pages_at_with_fonts(
        markup,
        PageSize::new(468.0, 270.0),
        Margin::uniform(18.0),
        &fonts,
    );

    let mut page_lines = Vec::new();
    for (page_index, page) in pages.iter().enumerate() {
        let mut lines = GridLineRuns::default();
        for (_, element) in &page.elements {
            visit_layout_tree(element.as_ref(), &mut lines);
        }
        assert_eq!(
            lines.row_start_margins.first().copied(),
            Some(0.0),
            "grid gutters are suppressed before the first track in fragmentainer {}; margins: {:?}",
            page_index + 1,
            lines.row_start_margins,
        );
        page_lines.push(lines.lines);
    }
    assert!(
        page_lines[0]
            .iter()
            .any(|runs| runs.concat() == "MATERIALS-LABEL-"),
        "UAX #14 and CSS Text hyphen opportunities must preserve exact-fit text: {page_lines:#?}"
    );
    let all_text = page_lines
        .iter()
        .flatten()
        .flatten()
        .map(String::as_str)
        .collect::<String>();

    assert_eq!(
        pages.len(),
        3,
        "orphans/widows must keep the one-line row fragment off page one: {page_lines:#?}"
    );
    assert!(
        all_text
            .contains("https://example.invalid/very/long/verification/path/FINAL-VERIFICATION-END"),
        "fragmentation must not synthesize whitespace inside the URL: {page_lines:#?}"
    );
}

#[test]
fn fragmented_grid_balances_incoming_rows_and_preserves_the_minimum_height_tail() {
    let font = crate::parser::ttf::parse_ttf(
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/parity/fonts/ParitySans.ttf"),
        )
        .expect("ParitySans fixture font"),
    )
    .expect("valid ParitySans fixture font");
    let fonts = std::collections::HashMap::from([("paritysans".to_string(), font)]);
    let markup = include_str!(
        "../../../tests/parity/cases/interactions/interactions-grid-fragmentation-svg-background-single-owner.html"
    );
    let pages = layout_pages_at_with_fonts(
        markup,
        PageSize::new(468.0, 270.0),
        Margin::uniform(18.0),
        &fonts,
    );
    let row_counts = pages
        .iter()
        .map(|page| {
            let mut rows = GridRows::default();
            for (_, element) in &page.elements {
                visit_layout_tree(element.as_ref(), &mut rows);
            }
            rows.minimum_heights.len()
        })
        .collect::<Vec<_>>();

    assert_eq!(row_counts, [2, 3, 1]);
}
