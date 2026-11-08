//! Filter source regressions for formatting-context cells.

use std::collections::HashMap;

use crate::layout::cells::CellPaint;
use crate::layout::elements::{BoxModel, BoxPaint, IntoLayoutNode, LayoutSize, TextBlock};
use crate::layout::engine::FlexCell;
use crate::style::computed::BoxShadow;
use crate::types::{Color, EdgeSizes, Point, Size};

use super::{
    border_box_pixel, paint_flex_cell_source, paint_source_graphic, source_geometry, test_fonts,
    test_raster_space,
};

#[test]
fn table_filter_source_keeps_the_used_table_border_box_height() {
    let document = crate::parser::html::parse_html_with_styles(
        r#"<style>
            * { box-sizing:border-box; margin:0 }
            .table {
                display:table;
                font-family:ParitySans;
                width:126px;
                height:68px;
                padding:7px;
                border:2px solid;
                border-spacing:3px;
            }
            .cell { display:table-cell }
        </style>
        <div class="table"><div><span class="cell">Ag</span><span class="cell">Bb</span></div></div>"#,
    )
    .expect("valid table filter source fixture");
    let rules = document
        .stylesheets
        .iter()
        .flat_map(|stylesheet| crate::parser::css::parse_stylesheet(stylesheet))
        .collect::<Vec<_>>();
    let fonts = test_fonts();
    let pages = crate::layout::engine::layout_with_rules_and_fonts(
        &document.nodes,
        crate::PageSize::new(300.0, 180.0),
        crate::types::Margin::uniform(0.0),
        &rules,
        &fonts,
        None,
        0.0,
        Default::default(),
    );
    let table = pages[0].elements[0].1.as_ref();
    let geometry = source_geometry(table).expect("table principal source geometry");
    let source = paint_source_graphic(table, &fonts, 300.0, test_raster_space())
        .expect("painted table source");

    assert_eq!(geometry.size.height, 51.0);
    assert_eq!(
        source.paint_bounds,
        Some(crate::types::Rect::from_xywh(0.0, 0.0, 94.5, 51.0))
    );
}

#[test]
fn flex_cell_source_includes_outset_shadow_overflow() {
    let cell = FlexCell {
        width: 20.0,
        natural_height: 10.0,
        paint: CellPaint {
            box_paint: BoxPaint {
                background: crate::layout::elements::BackgroundPaint {
                    color: Some(Color::WHITE),
                    ..Default::default()
                },
                shadows: vec![outset_shadow()],
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_flex_cell_source(
        &cell,
        Size::new(cell.width, cell.natural_height),
        &HashMap::new(),
        72.0,
        test_raster_space(),
    )
    .expect("flex source with an outset shadow");

    assert_eq!(
        source.geometry.paint_overflow(),
        EdgeSizes::new(0.0, 4.0, 3.0, 0.0)
    );
    assert_eq!(source.pixels.dimensions(), (24, 13));
    let shadow = border_box_pixel(&source, Point::new(22.0, 11.0));
    assert!(shadow[0] > 120 && shadow[1] < 10 && shadow[2] < 10);
    assert!((127..=128).contains(&shadow[3]));
}

#[test]
fn flex_cell_filter_source_clips_background_to_rounded_border_box() {
    let cell = FlexCell {
        width: 20.0,
        natural_height: 10.0,
        paint: CellPaint {
            box_paint: BoxPaint {
                background: crate::layout::elements::BackgroundPaint {
                    color: Some(Color::WHITE),
                    ..Default::default()
                },
                border_radii: crate::types::CornerRadii::circular(4.0),
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_flex_cell_source(
        &cell,
        Size::new(cell.width, cell.natural_height),
        &HashMap::new(),
        72.0,
        test_raster_space(),
    )
    .expect("rounded flex source");

    assert_eq!(source.pixels.get_pixel(0, 0)[3], 0);
    assert_eq!(source.pixels.get_pixel(10, 5)[3], 255);
}

#[test]
fn flex_cell_source_includes_nested_principal_box_overflow() {
    let principal_box = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(10.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::WHITE),
                ..Default::default()
            },
            shadows: vec![outset_shadow()],
            ..Default::default()
        },
        ..Default::default()
    };
    let cell = FlexCell {
        width: 20.0,
        natural_height: 10.0,
        nested_elements: vec![principal_box.boxed()],
        ..Default::default()
    };

    let source = paint_flex_cell_source(
        &cell,
        Size::new(cell.width, cell.natural_height),
        &HashMap::new(),
        72.0,
        test_raster_space(),
    )
    .expect("complex flex source with principal-box overflow");

    assert_eq!(
        source.geometry.paint_overflow(),
        EdgeSizes::new(0.0, 4.0, 3.0, 0.0)
    );
    let shadow = border_box_pixel(&source, Point::new(22.0, 11.0));
    assert!(shadow[0] > 120 && shadow[1] < 10 && shadow[2] < 10);
}

fn outset_shadow() -> BoxShadow {
    BoxShadow {
        offset_x: 4.0,
        offset_y: 3.0,
        blur: 0.0,
        spread: 0.0,
        color: Color::from_srgb(1.0, 0.0, 0.0, 0.5),
        color_source: crate::style::computed::ColorSource::Absolute,
        inset: false,
    }
}
