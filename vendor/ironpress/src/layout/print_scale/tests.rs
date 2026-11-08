use super::{PrintContentScale, assign_page_print_scales};
use crate::layout::elements::{
    InlineOffset, IntoLayoutNode, ProgressBar, TableCells, TableFormatting, TableInlineGeometry,
    TableRow,
};
use crate::layout::engine::Page;
use crate::style::computed::BorderCollapse;
use crate::types::{Color, Margin, PageSize, Size};

#[test]
fn shrinks_only_a_finite_normal_flow_overflow() {
    assert_eq!(
        PrintContentScale::from_flow_width(252.0, 255.0).factor(),
        84.0 / 85.0
    );
    assert!(PrintContentScale::from_flow_width(252.0, 252.0).is_identity());
    assert!(PrintContentScale::from_flow_width(252.0, f32::NAN).is_identity());
}

#[test]
fn selected_page_area_width_drives_print_fit() {
    let mut pages = vec![Page {
        elements: vec![(
            0.0,
            ProgressBar {
                fraction: 1.0,
                size: Size::new(184.0, 1.0),
                colors: crate::layout::elements::ProgressColors {
                    fill: Color::BLACK,
                    track: Color::WHITE,
                },
                ..ProgressBar::default()
            }
            .boxed(),
        )],
        geometry: Some(crate::layout::page_context::PageGeometry::new(
            PageSize::new(184.0, 120.0),
            Margin::new(0.0, 0.0, 0.0, 40.0),
        )),
        ..Page::default()
    }];

    assign_page_print_scales(
        &mut pages,
        PageSize::new(184.0, 120.0),
        Margin::uniform(0.0),
    );

    assert_eq!(pages[0].print_content_scale.factor(), 144.0 / 184.0);
}

#[test]
fn root_flow_start_is_measured_inside_the_physical_page_area() {
    let mut pages = vec![Page {
        elements: vec![(
            0.0,
            ProgressBar {
                fraction: 1.0,
                size: Size::new(150.0, 1.0),
                colors: crate::layout::elements::ProgressColors {
                    fill: Color::BLACK,
                    track: Color::WHITE,
                },
                ..ProgressBar::default()
            }
            .boxed(),
        )],
        geometry: Some(
            crate::layout::page_context::PageGeometry::new(
                PageSize::new(192.0, 200.0),
                Margin::new(16.0, 8.0, 8.0, 32.0),
            )
            .with_root_flow_insets(Margin::new(0.0, 8.0, 0.0, 8.0)),
        ),
        ..Page::default()
    }];

    assign_page_print_scales(
        &mut pages,
        PageSize::new(192.0, 200.0),
        Margin::uniform(0.0),
    );

    assert_eq!(pages[0].print_content_scale.factor(), 152.0 / 158.0);
}

#[test]
fn collapsed_table_spacing_does_not_trigger_print_fit_scaling() {
    let mut pages = vec![Page {
        elements: vec![(
            0.0,
            TableRow {
                content: TableCells {
                    column_widths: vec![120.0, 120.0],
                    ..TableCells::default()
                },
                formatting: TableFormatting {
                    border_collapse: BorderCollapse::Collapse,
                    border_spacing: 1.5,
                },
                inline: TableInlineGeometry::new(InlineOffset::ZERO, InlineOffset::ZERO)
                    .with_box_extent(240.0),
                ..TableRow::default()
            }
            .boxed(),
        )],
        ..Page::default()
    }];

    assign_page_print_scales(
        &mut pages,
        PageSize::new(240.0, 180.0),
        Margin::uniform(0.0),
    );

    assert!(pages[0].print_content_scale.is_identity());
}
