use super::*;

#[test]
fn object_fit_placement_clips_a_five_thousandth_point_overflow() {
    let placement = compute_image_placement(
        100.0,
        80.0,
        1,
        1,
        ObjectFit::Fill,
        ObjectPosition {
            x: ObjectPositionComponent::Length(0.005),
            y: ObjectPositionComponent::Length(0.0),
        },
    );

    assert_eq!(placement.width, 100.0);
    assert_eq!(placement.offset_x, 0.005);
    assert!(placement.offset_x + placement.width > 100.0);
    assert!(placement.clip);
}

#[test]
fn object_fit_placement_does_not_clip_an_exact_fit() {
    let placement = compute_image_placement(
        100.0,
        80.0,
        1,
        1,
        ObjectFit::Fill,
        ObjectPosition::default(),
    );

    assert_eq!(placement.offset_x, 0.0);
    assert_eq!(placement.offset_y, 0.0);
    assert_eq!(placement.offset_x + placement.width, 100.0);
    assert_eq!(placement.offset_y + placement.height, 80.0);
    assert!(!placement.clip);
}

#[test]
fn object_fit_placement_does_not_clip_a_subpoint_offset_inside_the_box() {
    let placement = compute_image_placement(
        100.0,
        80.0,
        100,
        80,
        ObjectFit::None,
        ObjectPosition {
            x: ObjectPositionComponent::Length(0.005),
            y: ObjectPositionComponent::Length(0.005),
        },
    );

    assert_eq!(placement.offset_x, 0.005);
    assert_eq!(placement.offset_y, 0.005);
    assert!(placement.offset_x + placement.width < 100.0);
    assert!(placement.offset_y + placement.height < 80.0);
    assert!(!placement.clip);
}
#[test]
fn automatic_replaced_size_scales_to_available_width() {
    // Image 200x100 in 150 available width => scale down to 150x75
    let (w, h) = ReplacedBoxSize::new(200.0, 100.0, true, true)
        .constrain(150.0, None, None)
        .dimensions();
    assert!((w - 150.0).abs() < 0.01);
    assert!((h - 75.0).abs() < 0.01);
}

#[test]
fn automatic_replaced_size_scales_to_max_width() {
    // Image 200x100, available 300, max_width 100 => scale to 100x50
    let (w, h) = ReplacedBoxSize::new(200.0, 100.0, true, true)
        .constrain(300.0, Some(100.0), None)
        .dimensions();
    assert!((w - 100.0).abs() < 0.01);
    assert!((h - 50.0).abs() < 0.01);
}

#[test]
fn automatic_replaced_size_scales_to_max_height() {
    // Image 200x100, max_height 40 => scale to 80x40
    let (w, h) = ReplacedBoxSize::new(200.0, 100.0, true, true)
        .constrain(500.0, None, Some(40.0))
        .dimensions();
    assert!((w - 80.0).abs() < 0.01);
    assert!((h - 40.0).abs() < 0.01);
}

#[test]
fn replaced_size_clamps_zero_dimensions() {
    // Zero width/height should return (0, 0)
    let (w, h) = ReplacedBoxSize::new(0.0, 100.0, true, true)
        .constrain(500.0, None, None)
        .dimensions();
    assert_eq!(w, 0.0);
    assert_eq!(h, 100.0);
}

#[test]
fn replaced_size_does_not_scale_when_unconstrained() {
    // Image fits within available width, no max constraints
    let (w, h) = ReplacedBoxSize::new(100.0, 50.0, true, true)
        .constrain(500.0, None, None)
        .dimensions();
    assert_eq!(w, 100.0);
    assert_eq!(h, 50.0);
}

#[test]
fn max_height_preserves_a_specified_width() {
    let (w, h) = ReplacedBoxSize::new(16.5, 91.666_67, false, true)
        .constrain(159.0, None, Some(88.5))
        .dimensions();

    assert_eq!(w, 16.5);
    assert_eq!(h, 88.5);
}
#[test]
fn parse_html_image_dimension_with_px_suffix() {
    assert_eq!(
        parse_html_image_dimension(Some(&"200px".to_string())),
        Some(150.0) // 200 * 0.75
    );
}

#[test]
fn parse_html_image_dimension_without_suffix() {
    assert_eq!(
        parse_html_image_dimension(Some(&"100".to_string())),
        Some(75.0) // 100 * 0.75
    );
}

#[test]
fn parse_html_image_dimension_none_input() {
    assert_eq!(parse_html_image_dimension(None), None);
}

#[test]
fn parse_html_image_dimension_invalid() {
    assert_eq!(parse_html_image_dimension(Some(&"abc".to_string())), None);
}
