use super::*;

fn solid(width: f32, color: crate::types::Color) -> crate::layout::engine::LayoutBorderSide {
    crate::layout::engine::LayoutBorderSide {
        width,
        color,
        style: BorderStyle::Solid,
    }
}

fn paint_components(
    sides: PhysicalEdges<crate::layout::engine::LayoutBorderSide>,
) -> (String, Vec<(String, f32)>) {
    let mut content = String::new();
    let mut states = Vec::new();
    let mut counter = 0;
    let ring = BorderRingGeometry::new(
        PdfRect::new(0.0, 0.0, 100.0, 50.0),
        CornerRadii::ZERO,
        sides.widths(),
    );
    let sides = PhysicalEdges::new(&sides.top, &sides.right, &sides.bottom, &sides.left);
    paint_solid_side_components(&mut content, ring, sides, &mut states, &mut counter);
    (content, states)
}

fn fill_count(content: &str) -> usize {
    content.lines().filter(|line| *line == "f").count()
}

#[test]
fn disconnected_equal_colour_sides_remain_separate_components() {
    let red = crate::types::Color::rgb(255, 0, 0);
    let sides = PhysicalEdges::new(
        solid(4.0, red),
        Default::default(),
        solid(4.0, red),
        Default::default(),
    );

    let (content, _) = paint_components(sides);

    assert_eq!(fill_count(&content), 2);
}

#[test]
fn alternating_colours_form_four_components() {
    let red = crate::types::Color::rgb(255, 0, 0);
    let blue = crate::types::Color::rgb(0, 0, 255);
    let sides = PhysicalEdges::new(
        solid(4.0, red),
        solid(4.0, blue),
        solid(4.0, red),
        solid(4.0, blue),
    );

    let (content, _) = paint_components(sides);

    assert_eq!(fill_count(&content), 4);
}

#[test]
fn adjacent_translucent_sides_share_one_alpha_group() {
    let translucent = crate::types::Color::rgba8(255, 0, 0, 128);
    let sides = PhysicalEdges::new(
        solid(4.0, translucent),
        solid(4.0, translucent),
        Default::default(),
        Default::default(),
    );

    let (content, states) = paint_components(sides);

    assert_eq!(fill_count(&content), 1);
    assert_eq!(states, vec![("GSbd0".to_string(), 128.0 / 255.0)]);
}
