use super::{
    CssValue, MathUnitContext, SpecifiedColor, parse_border_spacing_component, parse_color,
    parse_length, parse_math_expression, parse_property_value, parse_var_function,
};

#[test]
fn border_spacing_component_preserves_calc_and_var_tokens() {
    let spacing = "calc(1rem + 2pt) var(--gap, 3pt)";
    assert!(matches!(
        parse_border_spacing_component(spacing, 0),
        Some(CssValue::Math(_))
    ));
    assert!(matches!(
        parse_border_spacing_component(spacing, 1),
        Some(CssValue::Var(_, _))
    ));
}

#[test]
fn border_spacing_component_rejects_more_than_two_values() {
    assert!(parse_border_spacing_component("5pt 10pt 15pt", 0).is_none());
    assert!(parse_border_spacing_component("5pt 10pt 15pt", 1).is_none());
}

#[test]
fn parse_length_units() {
    assert!(matches!(
        parse_length("0"),
        Some(CssValue::Length(value)) if value == 0.0
    ));
    assert!(matches!(
        parse_length("1"),
        Some(CssValue::Number(value)) if value == 1.0
    ));
    assert!(matches!(
        parse_length("10px"),
        Some(CssValue::Length(v)) if (v - 7.5).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("14pt"),
        Some(CssValue::Length(v)) if (v - 14.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("50%"),
        Some(CssValue::Percentage(v)) if (v - 50.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("2rem"),
        Some(CssValue::Rem(v)) if (v - 2.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("100vw"),
        Some(CssValue::Vw(v)) if (v - 100.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("50vh"),
        Some(CssValue::Vh(v)) if (v - 50.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("1.5em"),
        Some(CssValue::Em(v)) if (v - 1.5).abs() < 0.01
    ));
    // ex/ch preserve the raw coefficient for font-metric resolution downstream.
    assert!(matches!(
        parse_length("4ex"),
        Some(CssValue::Ex(v)) if (v - 4.0).abs() < 0.01
    ));
    assert!(matches!(
        parse_length("5ch"),
        Some(CssValue::Ch(v)) if (v - 5.0).abs() < 0.01
    ));
}

#[test]
fn border_radius_grammar_is_transactional() {
    for valid in ["0", "7px", "7px 8pt 9% 1rem", "7px 8px / 3px 4px"] {
        assert!(
            parse_property_value("border-radius", valid).is_some(),
            "valid shorthand was rejected: {valid}"
        );
    }
    for invalid in [
        "9",
        "7px nope",
        "1px 2px 3px 4px 5px",
        "1px / 2px / 3px",
        "1px /",
    ] {
        assert!(
            parse_property_value("border-radius", invalid).is_none(),
            "invalid shorthand survived: {invalid}"
        );
    }

    assert!(parse_property_value("border-top-left-radius", "2px 3px").is_some());
    for invalid in ["5", "2px 3px 4px", "2px / 3px", "2px nope"] {
        assert!(
            parse_property_value("border-top-left-radius", invalid).is_none(),
            "invalid longhand survived: {invalid}"
        );
    }
}

#[test]
fn parse_var_function_basic() {
    assert!(matches!(
        parse_var_function("var(--my-width)"),
        Some(CssValue::Var(name, None)) if name == "--my-width"
    ));
    assert!(matches!(
        parse_var_function("var(--text-color, red)"),
        Some(CssValue::Var(name, Some(fallback))) if name == "--text-color" && fallback == "red"
    ));
}

#[test]
fn parse_var_function_invalid_name() {
    assert!(parse_var_function("var(invalid)").is_none());
    assert!(parse_var_function("var(invalid, fallback)").is_none());
}

fn math_units() -> MathUnitContext {
    MathUnitContext::from_font_and_viewport(12.0, 15.0, 600.0, 800.0)
}

#[test]
fn parse_math_expression_preserves_affine_length_percentage_terms() {
    let Some(CssValue::Math(expression)) = parse_math_expression("calc(100% - 20pt)") else {
        panic!("expected typed length-percentage math");
    };
    assert_eq!(
        expression.affine(math_units()).map(|value| value.terms()),
        Some((-20.0, 100.0))
    );
}

#[test]
fn empty_and_dimensionally_invalid_math_are_rejected_transactionally() {
    for invalid in [
        "calc()",
        "calc(2px * 3px)",
        "calc(10px / 2px)",
        "calc(10px + 2)",
        "clamp(10px, 20px)",
        "clamp(10px)",
        "min()",
    ] {
        assert!(
            parse_math_expression(invalid).is_none(),
            "invalid math survived: {invalid}"
        );
    }
}

#[test]
fn comparison_math_resolves_nested_expressions_against_the_eventual_basis() {
    let Some(CssValue::Math(expression)) =
        parse_math_expression("clamp(120px, calc(50% - 4pt), 240px)")
    else {
        panic!("expected typed clamp expression");
    };
    assert_eq!(expression.resolve(math_units(), 300.0), Some(146.0));
    assert_eq!(expression.resolve(math_units(), 600.0), Some(180.0));
}

#[test]
fn parse_property_value_recognizes_typed_math() {
    assert!(matches!(
        parse_property_value("width", "clamp(120px, 50%, 240px)"),
        Some(CssValue::Math(_))
    ));
}

#[test]
fn math_with_a_variable_is_parsed_as_pending_substitution() {
    for source in [
        "calc(var(--width) * 2)",
        "CALC(VAR(--width) + 10px)",
        "clamp(10px, var(--width), 100px)",
    ] {
        assert!(
            matches!(
                parse_property_value("width", source),
                Some(CssValue::PendingMath(_))
            ),
            "pending math was dropped: {source}"
        );
    }
    assert!(parse_property_value("width", "calc(var(width) * 2)").is_none());
}

#[test]
fn pending_math_rejects_excessive_nesting() {
    let mut expression = "var(--width)".to_string();
    for _ in 0..129 {
        expression = format!("({expression})");
    }

    assert!(parse_property_value("width", &format!("calc({expression})")).is_none());
}

#[test]
fn typed_math_parser_handles_precedence_parentheses_and_nested_functions() {
    let cases = [
        ("calc(10pt + 5pt * 3)", 25.0),
        ("calc((10pt + 5pt) * 3)", 45.0),
        ("min(40pt, max(12pt, 30pt))", 30.0),
        ("calc((sqrt(16) + sin(pi / 2)) * 3pt)", 15.0),
        ("hypot(3pt, 4pt)", 5.0),
    ];
    for (source, expected) in cases {
        let Some(CssValue::Math(expression)) = parse_math_expression(source) else {
            panic!("typed math rejected {source}");
        };
        let actual = expression.resolve(math_units(), 400.0);
        assert_eq!(actual, Some(expected), "wrong used value for {source}");
    }
}

#[test]
fn parse_keyword_values_case_insensitively() {
    assert!(matches!(
        parse_property_value("width", "AUTO"),
        Some(CssValue::Keyword(value)) if value == "auto"
    ));
    assert!(matches!(
        parse_property_value("height", "Auto"),
        Some(CssValue::Keyword(value)) if value == "auto"
    ));
    assert!(matches!(
        parse_property_value("display", "BLOCK"),
        Some(CssValue::Keyword(value)) if value == "block"
    ));
    assert!(matches!(
        parse_property_value("width", "UNSET"),
        Some(CssValue::Keyword(value)) if value == "unset"
    ));
    assert!(matches!(
        parse_property_value("width", "revert"),
        Some(CssValue::Keyword(value)) if value == "revert"
    ));
    assert!(matches!(
        parse_property_value("width", "revert-layer"),
        Some(CssValue::Keyword(value)) if value == "revert-layer"
    ));
}

#[test]
fn footnote_formatting_keywords_reject_invalid_values() {
    for (property, valid, invalid) in [
        ("footnote-display", "inline", "sideways"),
        ("footnote-policy", "line", "paragraph"),
    ] {
        assert!(parse_property_value(property, valid).is_some());
        assert!(
            parse_property_value(property, invalid).is_none(),
            "invalid {property} keyword was accepted: {invalid}"
        );
    }
}

#[test]
fn parse_color_variants() {
    assert!(
        matches!(parse_color("red"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 255.0 && c.g == 0.0)
    );
    assert!(
        matches!(parse_color("#ff0000"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 255.0)
    );
    assert!(
        matches!(parse_color("#f00"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 255.0)
    );
    assert!(
        matches!(parse_color("rgb(10, 20, 30)"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 10.0 && c.g == 20.0 && c.b == 30.0)
    );
}

#[test]
fn parse_rgb_percentage_preserves_fractional_channels() {
    let Some(CssValue::Color(SpecifiedColor::Absolute(color))) = parse_color("rgb(80% 20% 10%)")
    else {
        panic!("percentage rgb() should parse");
    };
    assert_eq!(
        (color.r, color.g, color.b, color.a),
        (204.0, 51.0, 25.5, 255.0)
    );
}

#[test]
fn parse_modern_rgb_number_one_is_one_of_255() {
    let Some(CssValue::Color(SpecifiedColor::Absolute(color))) = parse_color("rgb(1 0 0)") else {
        panic!("modern numeric rgb() should parse");
    };
    assert_eq!((color.r, color.g, color.b), (1.0, 0.0, 0.0));
}

#[test]
fn parse_modern_and_legacy_rgb_alpha_remain_continuous_in_the_css_parser() {
    for source in ["rgb(239 68 68 / 0.05)", "rgba(239, 68, 68, 0.05)"] {
        let Some(CssValue::Color(SpecifiedColor::Absolute(color))) = parse_color(source) else {
            panic!("{source} should parse");
        };
        assert_eq!((color.r, color.g, color.b), (239.0, 68.0, 68.0));
        assert_eq!(color.a, 12.75, "{source} quantized alpha during parsing");
    }
}

#[test]
fn parse_hsl_and_hwb_preserve_continuous_channels_and_alpha() {
    let Some(CssValue::Color(SpecifiedColor::Absolute(hsl))) =
        parse_color("hsl(280 60% 45% / 0.5)")
    else {
        panic!("modern hsl() should parse");
    };
    let (r, g, b, alpha) = hsl.to_f32_rgba();
    assert!((r - 0.54).abs() < 1e-6);
    assert!((g - 0.18).abs() < 1e-6);
    assert!((b - 0.72).abs() < 1e-6);
    assert_eq!(alpha, 0.5);

    let Some(CssValue::Color(SpecifiedColor::Absolute(hwb))) = parse_color("hwb(30 0% 0% / 50%)")
    else {
        panic!("hwb() should parse");
    };
    assert_eq!(hwb.to_f32_rgba(), (1.0, 0.5, 0.0, 0.5));

    assert!(
        parse_color("hsl(280 0.6 0.45)").is_none(),
        "HSL saturation and lightness require percentages"
    );
    assert!(
        parse_color("hwb(30 0 0)").is_none(),
        "HWB whiteness and blackness require percentages"
    );
}

#[test]
fn parse_legacy_rgb_requires_a_single_channel_type_and_preserves_fractional_channels() {
    let Some(CssValue::Color(SpecifiedColor::Absolute(color))) = parse_color("rgb(10%, 20%, 30%)")
    else {
        panic!("legacy percentage rgb() should parse");
    };
    assert_eq!((color.r, color.g, color.b), (25.5, 51.0, 76.5));

    let Some(CssValue::Color(SpecifiedColor::Absolute(fractional))) =
        parse_color("rgb(1.5, 2.25, 3.75)")
    else {
        panic!("legacy fractional-number rgb() should parse");
    };
    assert_eq!(
        (fractional.r, fractional.g, fractional.b),
        (1.5, 2.25, 3.75)
    );
    assert!(parse_color("rgb(10%, 20, 30%)").is_none());
}

#[test]
fn parse_color_srgb_preserves_fractional_channels() {
    let Some(CssValue::Color(SpecifiedColor::Absolute(color))) =
        parse_color("color(srgb 0.1 0.2 0.3 / 0.125)")
    else {
        panic!("color(srgb) should parse");
    };
    assert_eq!(
        (color.r, color.g, color.b, color.a),
        (25.5, 51.0, 76.5, 31.875)
    );
}

#[test]
fn parse_color_named_keywords_are_case_insensitive() {
    assert!(
        matches!(parse_color("Blue"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.b == 255.0)
    );
    assert!(
        matches!(parse_color("NAVY"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.b == 128.0)
    );
    assert!(matches!(
        parse_color("Aqua"),
        Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.g == 255.0 && c.b == 255.0
    ));
    assert!(matches!(
        parse_color("fuchsia"),
        Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 255.0 && c.b == 255.0
    ));
    assert!(
        matches!(parse_color("Lime"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.g == 255.0)
    );
}

#[test]
fn parse_color_transparent_preserves_alpha() {
    assert!(
        matches!(parse_color("transparent"), Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.a == 0.0)
    );
}

#[test]
fn parse_color_invalid_inputs() {
    assert!(parse_color("nonexistentcolor").is_none());
    assert!(parse_color("#12345").is_none());
    assert!(parse_color("rgb(1,2)").is_none());
}

/// BUG P2-1: rgba() background-color must be parsed without losing alpha.
/// Previously `parse_color` did not handle `rgba(...)` at all, so such a
/// background color was dropped instead of retaining its RGB and alpha.
#[test]
fn parse_color_rgba_preserves_rgb_and_alpha() {
    // rgba(239, 68, 68, 0.05) should store the raw RGB values and alpha.
    let color = parse_color("rgba(239, 68, 68, 0.05)");
    assert!(
        color.is_some(),
        "rgba() should be parsed as a Color, not None"
    );
    if let Some(CssValue::Color(SpecifiedColor::Absolute(c))) = color {
        assert_eq!(c.r, 239.0, "r should be preserved as-is");
        assert_eq!(c.g, 68.0, "g should be preserved as-is");
        assert_eq!(c.b, 68.0, "b should be preserved as-is");
        // Keep 0.05 * 255 = 12.75 until a backend requests an 8-bit pixel.
        assert_eq!(c.a, 12.75, "alpha 0.05 was quantized during parsing");
    }
}

#[test]
fn parse_color_rgba_fully_opaque() {
    // rgba(0, 128, 255, 1.0) should yield the same colour as rgb(0, 128, 255).
    let c_rgba = parse_color("rgba(0, 128, 255, 1.0)");
    let c_rgb = parse_color("rgb(0, 128, 255)");
    match (c_rgba, c_rgb) {
        (
            Some(CssValue::Color(SpecifiedColor::Absolute(a))),
            Some(CssValue::Color(SpecifiedColor::Absolute(b))),
        ) => {
            assert_eq!(a.r, b.r);
            assert_eq!(a.g, b.g);
            assert_eq!(a.b, b.b);
        }
        _ => panic!("both rgba(,,,1.0) and rgb() should parse successfully"),
    }
}

#[test]
fn parse_color_rgba_fully_transparent() {
    // rgba(0, 0, 0, 0.0) should store RGB as-is with alpha = 0.
    let color = parse_color("rgba(0, 0, 0, 0.0)");
    if let Some(CssValue::Color(SpecifiedColor::Absolute(c))) = color {
        assert_eq!(c.r, 0.0);
        assert_eq!(c.g, 0.0);
        assert_eq!(c.b, 0.0);
        assert_eq!(c.a, 0.0, "alpha 0.0 should be stored as 0");
    } else {
        panic!("rgba(0,0,0,0) should parse to a Color");
    }
}

#[test]
fn line_height_bare_number_is_not_length() {
    // A bare number like `1.6` for line-height must be parsed as Number
    // (unitless multiplier), not Length. Previously this was parsed as
    // CssValue::Length(1.6) which caused line-height to be divided by
    // font-size, producing tiny line heights and text overlap.
    let val = parse_property_value("line-height", "1.6");
    assert!(
        matches!(val, Some(CssValue::Number(v)) if (v - 1.6).abs() < 0.001),
        "line-height: 1.6 should be Number(1.6), got {:?}",
        val
    );

    let val = parse_property_value("line-height", "1.8");
    assert!(matches!(val, Some(CssValue::Number(v)) if (v - 1.8).abs() < 0.001));

    let val = parse_property_value("line-height", "2");
    assert!(matches!(val, Some(CssValue::Number(v)) if (v - 2.0).abs() < 0.001));

    // Values with units should still be parsed as Length
    let val = parse_property_value("line-height", "18pt");
    assert!(matches!(val, Some(CssValue::Length(v)) if (v - 18.0).abs() < 0.001));

    let val = parse_property_value("line-height", "24px");
    assert!(matches!(val, Some(CssValue::Length(v)) if (v - 18.0).abs() < 0.001)); // 24 * 0.75

    // Relative units are preserved for computed-style resolution against the
    // element/root metrics.
    let val = parse_property_value("line-height", "1.5em");
    assert!(matches!(val, Some(CssValue::Keyword(ref k)) if k == "1.5em"));

    // "normal" should be Keyword
    let val = parse_property_value("line-height", "normal");
    assert!(matches!(val, Some(CssValue::Keyword(ref k)) if k == "normal"));
}
