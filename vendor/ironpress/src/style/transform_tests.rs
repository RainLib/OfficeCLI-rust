use super::computed::{ComputedStyle, TransformBox, TransformOrigin, compute_style};
use crate::parser::css::{CssValue, parse_inline_style};
use crate::parser::dom::HtmlTag;

#[test]
fn three_value_transform_origin_preserves_z_offset() {
    let declarations = parse_inline_style("transform-origin: 50% 50% 55px");
    assert!(
        matches!(
            declarations.get("transform-origin"),
            Some(CssValue::Keyword(value)) if value == "50% 50% 55px"
        ),
        "authored value was not preserved: {:?}",
        declarations.get("transform-origin")
    );
    let style = compute_style(
        HtmlTag::Div,
        Some("transform-origin: 50% 50% 55px"),
        &ComputedStyle::default(),
    );

    assert_eq!(
        style.transform_origin,
        TransformOrigin {
            x_fraction: 0.5,
            x_length: 0.0,
            y_fraction: 0.5,
            y_length: 0.0,
            z_length: 41.25,
        }
    );
}

#[test]
fn transform_origin_rejects_percentage_and_unitless_z_offsets() {
    for declaration in [
        "transform-origin: 50% 50% 25%",
        "transform-origin: 50% 50% 25",
    ] {
        let style = compute_style(HtmlTag::Div, Some(declaration), &ComputedStyle::default());
        assert_eq!(style.transform_origin, TransformOrigin::default());
    }
}

#[test]
fn invalid_transform_origin_does_not_replace_an_earlier_valid_value() {
    let style = compute_style(
        HtmlTag::Div,
        Some(
            "transform-origin: 25% 75% 10px; \
             transform-origin: 50% 50% 25%",
        ),
        &ComputedStyle::default(),
    );

    assert_eq!(
        style.transform_origin,
        TransformOrigin {
            x_fraction: 0.25,
            x_length: 0.0,
            y_fraction: 0.75,
            y_length: 0.0,
            z_length: 7.5,
        }
    );
}

#[test]
fn important_three_value_transform_origin_wins_the_cascade() {
    let style = compute_style(
        HtmlTag::Div,
        Some(
            "transform-origin: 25% 75% 10px !important; \
             transform-origin: left top",
        ),
        &ComputedStyle::default(),
    );

    assert_eq!(
        style.transform_origin,
        TransformOrigin {
            x_fraction: 0.25,
            x_length: 0.0,
            y_fraction: 0.75,
            y_length: 0.0,
            z_length: 7.5,
        }
    );
}

#[test]
fn transform_box_preserves_every_specified_reference_box() {
    for (keyword, expected) in [
        ("border-box", TransformBox::Border),
        ("content-box", TransformBox::Content),
        ("fill-box", TransformBox::Fill),
        ("stroke-box", TransformBox::Stroke),
        ("view-box", TransformBox::View),
    ] {
        let style = compute_style(
            HtmlTag::Div,
            Some(&format!("transform-box: {keyword}")),
            &ComputedStyle::default(),
        );
        assert_eq!(style.transform_box, expected);
    }
}

#[test]
fn invalid_transform_box_does_not_replace_an_earlier_valid_value() {
    let style = compute_style(
        HtmlTag::Div,
        Some("transform-box: content-box; transform-box: invalid-box"),
        &ComputedStyle::default(),
    );

    assert_eq!(style.transform_box, TransformBox::Content);
}
