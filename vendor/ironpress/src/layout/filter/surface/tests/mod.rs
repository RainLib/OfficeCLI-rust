use std::collections::HashMap;

mod cells;
mod group;
mod raster;

use super::text::line_baseline_ascent;
use super::*;
use crate::layout::elements::{
    BoxModel, BoxPaint, ColumnRule, Container, IntoLayoutNode, LayoutSize, Positioning, TextBlock,
};
use crate::layout::engine::{FontSynthesisState, SyntheticFontWeight, TextLine, TextRun};
use crate::parser::ttf::TtfFont;
use crate::style::computed::{
    BorderStyle, BoxShadow, FontFamily, GradientColor, GradientColorProvenance, GradientPosition,
    GradientRamp, GradientStop, LinearGradient, Overflow, TextDecoration, TextDecorationLines,
    TextDecorationStyle,
};
use crate::types::{Color, EdgeSizes, Point, Size};

fn test_fonts() -> HashMap<String, TtfFont> {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity/fonts/ParitySans.ttf"),
    )
    .expect("ParitySans test font");
    let font = crate::parser::ttf::parse_ttf(bytes).expect("valid ParitySans TTF");
    HashMap::from([("paritysans".to_string(), font)])
}

fn test_raster_space() -> SourceRasterSpace {
    SourceRasterSpace::in_layer(Point::ORIGIN)
}

fn border_box_pixel(source: &SourceGraphic, point: Point) -> image::Rgba<u8> {
    let origin = source.geometry.border_origin();
    *source.pixels.get_pixel(
        (origin.x + point.x).round() as u32,
        (origin.y + point.y).round() as u32,
    )
}

fn filtered_text_alpha(weight: SyntheticFontWeight) -> u64 {
    let block = TextBlock {
        lines: vec![TextLine {
            runs: vec![TextRun {
                text: "Weight".to_string(),
                font_size: 48.0,
                bold: true,
                font_family: FontFamily::Custom("ParitySans".to_string()),
                font_synthesis: FontSynthesisState {
                    weight,
                    ..Default::default()
                },
                ..Default::default()
            }],
            height: 60.0,
            ..Default::default()
        }],
        box_model: BoxModel {
            size: LayoutSize::fixed(180.0, Some(60.0)),
            ..Default::default()
        },
        ..Default::default()
    };
    paint_source_graphic(&block, &test_fonts(), 300.0, test_raster_space())
        .expect("filter text source")
        .pixels
        .pixels()
        .map(|pixel| u64::from(pixel[3]))
        .sum()
}

#[test]
fn text_paint_uses_the_layout_resolved_baseline() {
    let line = TextLine {
        height: 60.0,
        baseline_ascent: Some(23.25),
        ..Default::default()
    };

    assert_eq!(line_baseline_ascent(&line, &HashMap::new()), 23.25);
}

#[test]
fn text_raster_uses_typed_synthetic_weight() {
    assert!(
        filtered_text_alpha(SyntheticFontWeight::Auto)
            > filtered_text_alpha(SyntheticFontWeight::Suppressed)
    );

    let mut fonts = test_fonts();
    fonts.get_mut("paritysans").expect("test font").is_bold = true;
    let run = TextRun {
        font_size: 48.0,
        bold: true,
        font_family: FontFamily::Custom("ParitySans".to_string()),
        font_synthesis: FontSynthesisState {
            weight: SyntheticFontWeight::Auto,
            ..Default::default()
        },
        ..Default::default()
    };
    assert_eq!(run.synthetic_bold_stroke_width(&fonts), None);
}

#[test]
fn positioned_column_rule_uses_the_parent_padding_box_once() {
    let rule = ColumnRule {
        placement: crate::layout::elements::FragmentPlacement::in_padding_box(
            crate::types::Vector::new(10.0, 0.0),
            Size::new(2.0, 10.0),
        ),
        height: 10.0,
        paint: crate::layout::engine::LayoutBorderSide {
            width: 2.0,
            color: Color::from_srgb(1.0, 0.0, 0.0, 1.0),
            style: BorderStyle::Solid,
            ..Default::default()
        },
        ..Default::default()
    };
    let root = Container {
        children: vec![rule.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(30.0, Some(20.0)),
            padding: EdgeSizes::new(0.0, 0.0, 0.0, 5.0),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("positioned column rule filter source");

    assert_eq!(
        border_box_pixel(&source, Point::new(10.0, 1.0)).0,
        [255, 0, 0, 255]
    );
    assert_eq!(border_box_pixel(&source, Point::new(15.0, 1.0))[3], 0);
}

#[test]
fn container_filter_source_clips_descendants_to_rounded_padding_box() {
    let child = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(20.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };
    let container = Container {
        children: vec![child.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(10.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            border_radii: crate::types::CornerRadii::circular(4.0),
            ..Default::default()
        },
        overflow: crate::layout::elements::OverflowBehavior {
            combined: Overflow::Hidden,
            x: Overflow::Hidden,
            y: Overflow::Hidden,
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&container, &HashMap::new(), 72.0, test_raster_space())
        .expect("overflow-clipped container filter source");

    assert_eq!(source.pixels.get_pixel(0, 0)[3], 0);
    assert_eq!(source.pixels.get_pixel(10, 5)[3], 255);
}

#[test]
fn source_graphic_composites_linear_gradient_with_the_box() {
    let stop = |color, position| {
        GradientStop::new(
            GradientColor::new(color, GradientColorProvenance::LegacySrgb),
            Some(GradientPosition::fraction(position)),
        )
    };
    let block = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(10.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                layers: crate::layout::helpers::BackgroundFields {
                    gradient: Some(LinearGradient {
                        angle: 90.0,
                        ramp: GradientRamp {
                            stops: vec![stop(Color::BLACK, 0.0), stop(Color::WHITE, 1.0)],
                            ..Default::default()
                        },
                        layer_box: Default::default(),
                    }),
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&block, &HashMap::new(), 72.0, test_raster_space())
        .expect("linear gradient is a supported composited source");

    assert!(border_box_pixel(&source, Point::new(1.0, 5.0))[0] < 32);
    assert!(border_box_pixel(&source, Point::new(18.0, 5.0))[0] > 223);
}

#[test]
fn absolute_descendant_skips_a_static_intermediate_containing_box() {
    let absolute = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(3.0, Some(3.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            ..Default::default()
        },
        positioning: Positioning::absolute_at(Point::new(20.0, 10.0)),
        ..Default::default()
    };
    let static_intermediate = Container {
        children: vec![absolute.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(30.0, Some(20.0)),
            padding: EdgeSizes::uniform(4.0),
            ..Default::default()
        },
        ..Default::default()
    };
    let root = Container {
        children: vec![static_intermediate.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(40.0, Some(30.0)),
            padding: EdgeSizes::uniform(5.0),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("positioned filter source paints");

    assert_eq!(border_box_pixel(&source, Point::new(20.0, 10.0))[0], 255);
    assert_eq!(border_box_pixel(&source, Point::new(25.0, 15.0))[3], 0);
}

#[test]
fn positioned_descendant_expands_the_source_allocation_past_the_border_box() {
    let child = TextBlock {
        box_model: BoxModel {
            size: LayoutSize::fixed(6.0, Some(5.0)),
            ..Default::default()
        },
        paint: BoxPaint {
            background: crate::layout::elements::BackgroundPaint {
                color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                ..Default::default()
            },
            ..Default::default()
        },
        positioning: Positioning::absolute_at(Point::new(-4.0, -3.0)),
        ..Default::default()
    };
    let root = Container {
        children: vec![child.boxed()],
        box_model: BoxModel {
            size: LayoutSize::fixed(20.0, Some(12.0)),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&root, &HashMap::new(), 72.0, test_raster_space())
        .expect("the positioned descendant expands its filter source");

    assert_eq!(
        source.geometry.paint_overflow(),
        EdgeSizes::new(3.0, 0.0, 0.0, 4.0)
    );
    assert_eq!(
        border_box_pixel(&source, Point::new(-3.0, -2.0)),
        image::Rgba([255, 0, 0, 255])
    );
}

#[test]
fn filtered_text_source_paints_shared_decoration_and_shadow_geometry() {
    let block = TextBlock {
        lines: vec![TextLine {
            runs: vec![TextRun {
                text: "Decorated".to_string(),
                font_size: 18.0,
                font_family: FontFamily::Custom("ParitySans".to_string()),
                decorations: vec![TextDecoration {
                    lines: TextDecorationLines {
                        underline: true,
                        ..Default::default()
                    },
                    color: Some(Color::from_srgb(1.0, 0.0, 0.0, 1.0)),
                    style: TextDecorationStyle::Solid,
                    thickness: Some(1.5),
                    underline_offset: Some(2.0),
                    ..Default::default()
                }],
                text_shadow: vec![BoxShadow {
                    offset_x: 2.0,
                    offset_y: 1.0,
                    blur: 0.0,
                    spread: 0.0,
                    color: Color::from_srgb(0.0, 0.0, 1.0, 1.0),
                    color_source: crate::style::computed::ColorSource::Absolute,
                    inset: false,
                }],
                ..Default::default()
            }],
            height: 24.0,
            ..Default::default()
        }],
        box_model: BoxModel {
            size: LayoutSize::fixed(120.0, Some(28.0)),
            ..Default::default()
        },
        ..Default::default()
    };

    let source = paint_source_graphic(&block, &test_fonts(), 72.0, test_raster_space())
        .expect("decorated filter text source paints");

    assert!(
        source
            .pixels
            .pixels()
            .any(|pixel| pixel[0] > 200 && pixel[1] < 40)
    );
    assert!(
        source
            .pixels
            .pixels()
            .any(|pixel| pixel[2] > 200 && pixel[0] < 40)
    );
}
