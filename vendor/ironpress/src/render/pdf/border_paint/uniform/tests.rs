use super::*;

fn solid(width: f32, color: crate::types::Color) -> crate::layout::engine::LayoutBorderSide {
    crate::layout::engine::LayoutBorderSide {
        width,
        color,
        style: BorderStyle::Solid,
    }
}

fn double(width: f32, color: crate::types::Color) -> crate::layout::engine::LayoutBorderSide {
    crate::layout::engine::LayoutBorderSide {
        width,
        color,
        style: BorderStyle::Double,
    }
}

#[test]
fn square_uniform_border_uses_the_canonical_centerline_stroke() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(PdfRect::new(0.0, 0.0, 100.0, 50.0), CornerRadii::ZERO),
        solid(4.0, crate::types::Color::BLACK),
        PdfContentSpace::Points,
        &mut states,
        &mut counter,
    ));

    assert!(content.ends_with("S\n"));
    assert!(!content.contains("f*\n"));
}

#[test]
fn square_uniform_border_retains_page_css_serialization() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;
    let content_space =
        PdfContentSpace::page_css(PageContentTransform::print(PdfVector::new(150.0, 150.0)));

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(PdfRect::new(12.0, 12.0, 117.0, 123.0), CornerRadii::ZERO,),
        solid(0.75, crate::types::Color::BLACK),
        content_space,
        &mut states,
        &mut counter,
    ));

    assert!(content.starts_with("q\n"));
    assert!(content.contains("1 w\n"));
    assert!(content.ends_with("S\nQ\n"));
}

#[test]
fn circular_uniform_border_uses_the_canonical_centerline_stroke() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::circular(12.0),
        ),
        solid(4.0, crate::types::Color::BLACK),
        PdfContentSpace::Points,
        &mut states,
        &mut counter,
    ));

    assert!(content.ends_with("S\n"));
    assert!(!content.contains("f*\n"));
}

#[test]
fn elliptical_uniform_border_uses_the_css_border_ring() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::uniform(crate::types::CornerRadius::new(18.0, 9.0)),
        ),
        solid(4.0, crate::types::Color::BLACK),
        PdfContentSpace::Points,
        &mut states,
        &mut counter,
    ));

    assert!(content.ends_with("f*\n"));
    assert!(!content.contains("S\n"));
}

#[test]
fn circular_uniform_double_border_uses_two_centerline_strokes() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::circular(12.0),
        ),
        double(3.0, crate::types::Color::BLACK),
        PdfContentSpace::Points,
        &mut states,
        &mut counter,
    ));

    assert_eq!(content.lines().filter(|line| *line == "S").count(), 2);
    assert!(!content.contains("f*\n"));
}

#[test]
fn elliptical_uniform_double_border_keeps_exact_css_rings() {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_uniform_border(
        &mut content,
        RoundedRect::new(
            PdfRect::new(0.0, 0.0, 100.0, 50.0),
            CornerRadii::uniform(crate::types::CornerRadius::new(18.0, 9.0)),
        ),
        double(3.0, crate::types::Color::BLACK),
        PdfContentSpace::Points,
        &mut states,
        &mut counter,
    ));

    assert_eq!(content.lines().filter(|line| *line == "f*").count(), 2);
    assert!(!content.contains("S\n"));
}

#[test]
fn open_fragment_border_is_one_connected_full_span_fill() {
    let color = crate::types::Color::rgba8(87, 117, 144, 194);
    let border = PhysicalEdges::new(
        solid(1.5, color),
        solid(1.5, color),
        Default::default(),
        solid(1.5, color),
    );
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_open_square_solid_border(
        &mut content,
        PdfRect::new(11.25, 0.0, 94.5, 124.5),
        &border,
        CornerRadii::ZERO,
        &mut states,
        &mut counter,
    ));

    assert_eq!(content.lines().filter(|line| *line == "f").count(), 1);
    assert!(content.contains("104.25 0 1.5 124.5 re\n"));
    assert!(content.contains("11.25 0 1.5 124.5 re\n"));
    assert_eq!(states, vec![("GSbd0".to_string(), 194.0 / 255.0)]);
}

#[test]
fn opaque_open_fragment_border_matches_full_span_browser_decomposition() {
    let color = crate::types::Color::rgb(87, 117, 144);
    let border = PhysicalEdges::new(
        solid(1.5, color),
        solid(1.5, color),
        Default::default(),
        solid(1.5, color),
    );
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;

    assert!(paint_open_square_solid_border(
        &mut content,
        PdfRect::new(11.25, 0.0, 94.5, 124.5),
        &border,
        CornerRadii::ZERO,
        &mut states,
        &mut counter,
    ));

    assert_eq!(content.lines().filter(|line| *line == "f").count(), 3);
    assert!(content.contains("104.25 0 1.5 124.5 re\n"));
    assert!(content.contains("11.25 0 1.5 124.5 re\n"));
    assert!(states.is_empty());
}
