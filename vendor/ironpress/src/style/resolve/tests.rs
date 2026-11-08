use super::*;
use crate::parser::css::SpecifiedColor;

fn resolve_css_length(source: &str, context: LengthResolutionContext) -> Option<f32> {
    let style = crate::parser::css::parse_inline_style(&format!("width: {source}"));
    resolve_length_value_in_context(style.get("width")?, context, &HashMap::new())
}

fn assert_css_length(source: &str, context: LengthResolutionContext, expected: f32) {
    let actual = resolve_css_length(source, context);
    assert!(
        actual.is_some_and(|actual| (actual - expected).abs() < 0.001),
        "{source}: expected {expected}, got {actual:?}"
    );
}

fn context(
    percentage_basis: f32,
    font_size: f32,
    root_font_size: f32,
    viewport_width: f32,
    viewport_height: f32,
) -> LengthResolutionContext {
    LengthResolutionContext::new(
        percentage_basis,
        MathUnitContext::from_font_and_viewport(
            font_size,
            root_font_size,
            viewport_width,
            viewport_height,
        ),
    )
}

#[test]
fn typed_math_resolves_arithmetic_precedence_and_parentheses() {
    let context = context(400.0, 20.0, 15.0, 600.0, 800.0);
    for (source, expected) in [
        ("calc(100% - 20pt)", 380.0),
        ("calc(50% + 10px)", 207.5),
        ("calc(10pt * 3)", 30.0),
        ("calc(100pt / 2)", 50.0),
        ("calc(10pt + 5pt * 3)", 25.0),
        ("calc((10pt + 5pt) * 3)", 45.0),
        ("calc(-2 * (4pt - 10pt))", 12.0),
    ] {
        assert_css_length(source, context, expected);
    }
}

#[test]
fn typed_math_resolves_absolute_font_and_viewport_unit_families() {
    let context = context(400.0, 20.0, 16.0, 600.0, 800.0);
    for (source, expected) in [
        ("calc(1in + 2.54cm + 25.4mm + 101.6q)", 288.0),
        ("calc(1pc + 12pt + 16px)", 36.0),
        ("calc(2em + 3rem + 1ex + 1ch)", 108.0),
        ("calc(50vw + 25vh)", 500.0),
        ("calc(10vmin + 10vmax)", 140.0),
        ("calc(10vi + 10vb)", 140.0),
        ("calc(1svw + 1lvw + 1dvw)", 18.0),
        ("calc(1svh + 1lvh + 1dvh)", 24.0),
    ] {
        assert_css_length(source, context, expected);
    }
}

#[test]
fn typed_math_resolves_comparison_stepped_and_sign_functions() {
    let context = context(400.0, 20.0, 16.0, 600.0, 800.0);
    for (source, expected) in [
        ("min(100pt, 30%, 140pt)", 100.0),
        ("max(100pt, 30%, 140pt)", 140.0),
        ("clamp(90pt, 50%, 180pt)", 180.0),
        ("clamp(100pt, 50pt, 20pt)", 100.0),
        ("round(nearest, 53pt, 10pt)", 50.0),
        ("round(up, 51pt, 10pt)", 60.0),
        ("round(down, 59pt, 10pt)", 50.0),
        ("round(to-zero, -59pt, 10pt)", -50.0),
        ("rem(23pt, 5pt)", 3.0),
        ("mod(-23pt, 5pt)", 2.0),
        ("abs(-17pt)", 17.0),
        ("calc(sign(-17pt) * 8pt)", -8.0),
        ("hypot(3pt, 4pt, 12pt)", 13.0),
    ] {
        assert_css_length(source, context, expected);
    }
}

#[test]
fn resolve_percentage_val() {
    let val = CssValue::Percentage(50.0);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        Some(200.0)
    );
}

#[test]
fn resolve_rem_val() {
    let val = CssValue::Rem(2.0);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        Some(24.0)
    );
}

#[test]
fn resolve_rem_val_with_custom_root_size() {
    let val = CssValue::Rem(2.0);
    let ctx = context(400.0, 12.0, 10.0, 595.28, 841.89);
    assert_eq!(
        resolve_length_value_in_context(&val, ctx, &HashMap::new()),
        Some(20.0)
    );
}

#[test]
fn resolve_vw_val() {
    let val = CssValue::Vw(100.0);
    let r = resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()).unwrap();
    assert!((r - 595.28).abs() < 0.01);
}

#[test]
fn resolve_vh_val() {
    let val = CssValue::Vh(100.0);
    let r = resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()).unwrap();
    assert!((r - 841.89).abs() < 0.01);
}

#[test]
fn resolve_vmin_val() {
    // css-values-4 §6.1.2.2: vmin = 1% of the SMALLER viewport axis (here width).
    let val = CssValue::Vmin(100.0);
    let r = resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()).unwrap();
    assert!((r - 595.28).abs() < 0.01);
}

#[test]
fn resolve_vmax_val() {
    // css-values-4 §6.1.2.2: vmax = 1% of the LARGER viewport axis (here height).
    let val = CssValue::Vmax(100.0);
    let r = resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()).unwrap();
    assert!((r - 841.89).abs() < 0.01);
}

#[test]
fn resolve_vmin_vmax_in_calc() {
    let context = context(400.0, 12.0, 12.0, 595.28, 841.89);
    let r = resolve_css_length("calc(50vmin + 10vmax)", context).unwrap();
    // 50% of 595.28 (smaller) + 10% of 841.89 (larger) = 297.64 + 84.189
    assert!((r - (297.64 + 84.189)).abs() < 0.05);
}

#[test]
fn clamp_uses_the_eventual_percentage_basis() {
    for (basis, percentage, expected) in [
        (450.0, 50.0, 180.0),
        (300.0, 50.0, 150.0),
        (300.0, 10.0, 90.0),
    ] {
        let context = context(basis, 12.0, 12.0, 595.28, 841.89);
        assert_css_length(
            &format!("clamp(120px, {percentage}%, 240px)"),
            context,
            expected,
        );
    }
}

#[test]
fn resolve_var_defined() {
    let mut props = HashMap::new();
    props.insert("--spacing".to_string(), "10pt".to_string());
    let val = CssValue::Var("--spacing".to_string(), None);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &props),
        Some(10.0)
    );
}

#[test]
fn resolve_var_fallback() {
    let val = CssValue::Var("--spacing".to_string(), Some("20pt".to_string()));
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        Some(20.0)
    );
}

#[test]
fn resolve_var_undefined_no_fallback() {
    let val = CssValue::Var("--spacing".to_string(), None);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        None
    );
}

#[test]
fn resolve_var_color_test() {
    let mut props = HashMap::new();
    props.insert("--text-color".to_string(), "red".to_string());
    let val = CssValue::Var("--text-color".to_string(), None);
    let Some(SpecifiedColor::Absolute(c)) = try_resolve_var_to_color(&val, &props) else {
        panic!("expected an absolute resolved color");
    };
    assert_eq!(c.r, 255.0);
    assert_eq!(c.g, 0.0);
}

#[test]
fn malformed_or_non_finite_math_never_produces_a_length() {
    let context = LengthResolutionContext::pdf_defaults(400.0);
    for source in [
        "calc()",
        "calc(10pt +)",
        "calc(100pt / 0)",
        "calc(10pt + 3)",
        "calc(2pt * 3pt)",
    ] {
        assert_eq!(
            resolve_css_length(source, context),
            None,
            "invalid or non-finite math resolved: {source}"
        );
    }
}

#[test]
fn unitless_nonzero_number_is_not_a_length() {
    let val = CssValue::Number(42.0);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        None
    );
}

#[test]
fn resolve_em_length_uses_the_font_size() {
    let val = CssValue::Em(3.5);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        Some(42.0)
    );
}

#[test]
fn resolve_length_value_keyword_returns_none() {
    let val = CssValue::Keyword("auto".to_string());
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &HashMap::new()),
        None
    );
}

#[test]
fn resolve_var_to_unparseable_length() {
    let mut props = HashMap::new();
    props.insert("--x".to_string(), "auto".to_string());
    let val = CssValue::Var("--x".to_string(), None);
    assert_eq!(
        resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &props),
        None
    );
}

#[test]
fn try_resolve_var_to_color_non_var_returns_none() {
    let val = CssValue::Keyword("red".to_string());
    assert!(try_resolve_var_to_color(&val, &HashMap::new()).is_none());
}

#[test]
fn try_resolve_var_to_color_non_color_value() {
    let mut props = HashMap::new();
    props.insert("--x".to_string(), "10pt".to_string());
    let val = CssValue::Var("--x".to_string(), None);
    assert!(try_resolve_var_to_color(&val, &props).is_none());
}

#[test]
fn try_resolve_var_to_keyword_defined() {
    let mut props = HashMap::new();
    props.insert("--display".to_string(), "flex".to_string());
    let val = CssValue::Var("--display".to_string(), None);
    assert_eq!(
        try_resolve_var_to_keyword(&val, &props),
        Some("flex".to_string())
    );
}

#[test]
fn try_resolve_var_to_keyword_with_fallback() {
    let val = CssValue::Var("--missing".to_string(), Some("block".to_string()));
    assert_eq!(
        try_resolve_var_to_keyword(&val, &HashMap::new()),
        Some("block".to_string())
    );
}

#[test]
fn try_resolve_var_to_keyword_resolves_nested_aliases() {
    let mut props = HashMap::new();
    props.insert("--mode".to_string(), "var(--layout)".to_string());
    props.insert("--layout".to_string(), "flex".to_string());
    let val = CssValue::Var("--mode".to_string(), None);

    assert_eq!(
        try_resolve_var_to_keyword(&val, &props),
        Some("flex".to_string())
    );
}

#[test]
fn try_resolve_var_to_color_resolves_nested_aliases() {
    let mut props = HashMap::new();
    props.insert("--accent".to_string(), "var(--brand)".to_string());
    props.insert("--brand".to_string(), "red".to_string());
    let val = CssValue::Var("--accent".to_string(), None);

    let Some(SpecifiedColor::Absolute(color)) = try_resolve_var_to_color(&val, &props) else {
        panic!("expected an absolute resolved color");
    };
    assert_eq!(color.r, 255.0);
    assert_eq!(color.g, 0.0);
    assert_eq!(color.b, 0.0);
}

#[test]
fn try_resolve_var_to_keyword_uses_outer_fallback_when_alias_breaks() {
    let mut props = HashMap::new();
    props.insert("--mode".to_string(), "var(--layout)".to_string());
    let val = CssValue::Var("--mode".to_string(), Some("flex".to_string()));

    assert_eq!(
        try_resolve_var_to_keyword(&val, &props),
        Some("flex".to_string())
    );
}

#[test]
fn try_resolve_var_to_keyword_uses_fallback_when_alias_cycle_is_detected() {
    let mut props = HashMap::new();
    props.insert("--mode".to_string(), "var(--layout)".to_string());
    props.insert("--layout".to_string(), "var(--mode)".to_string());
    let val = CssValue::Var("--mode".to_string(), Some("block".to_string()));

    assert_eq!(
        try_resolve_var_to_keyword(&val, &props),
        Some("block".to_string())
    );
}

#[test]
fn try_resolve_var_to_keyword_non_var_returns_none() {
    let val = CssValue::Keyword("block".to_string());
    assert!(try_resolve_var_to_keyword(&val, &HashMap::new()).is_none());
}

#[test]
fn try_resolve_var_to_keyword_undefined_no_fallback() {
    let val = CssValue::Var("--missing".to_string(), None);
    assert!(try_resolve_var_to_keyword(&val, &HashMap::new()).is_none());
}

#[test]
fn resolve_var_resolves_to_calc_value() {
    let mut props = HashMap::new();
    props.insert("--gap".to_string(), "calc(100% - 20pt)".to_string());
    let val = CssValue::Var("--gap".to_string(), None);
    // parent_width=400 => 100%=400, so calc(400-20) = 380
    let result = resolve_length_value(&val, 400.0, 12.0, 595.28, 841.89, &props);
    assert_eq!(result, Some(380.0));
}

#[test]
fn excessively_deep_variable_aliases_are_rejected() {
    let mut properties = HashMap::new();
    for index in 0..129 {
        properties.insert(format!("--v{index}"), format!("var(--v{})", index + 1));
    }
    properties.insert("--v129".to_string(), "10pt".to_string());

    assert_eq!(
        resolve_vars_in_value("calc(var(--v0) * 2)", &properties),
        None
    );

    let mut fallback = "10pt".to_string();
    for _ in 0..129 {
        fallback = format!("({fallback})");
    }
    assert_eq!(
        resolve_vars_in_value(&format!("var(--missing, {fallback})"), &HashMap::new()),
        None
    );
}

#[test]
fn try_resolve_to_length_uses_pdf_defaults() {
    let val = CssValue::Percentage(50.0);
    // parent_width_hint=200 => 50% of 200 = 100
    assert_eq!(
        try_resolve_to_length(&val, &HashMap::new(), 200.0),
        Some(100.0)
    );
}

#[test]
fn try_resolve_to_length_with_font_size_uses_custom_em() {
    let style = crate::parser::css::parse_inline_style("width: calc(2em + 1rem)");
    let val = style.get("width").expect("typed math width");
    // font_size=18, root_font_size=14 => 2*18 + 1*14 = 50
    let result =
        try_resolve_to_length_with_font_size(val, &HashMap::new(), 400.0, 18.0, 14.0).unwrap();
    assert!((result - 50.0).abs() < 0.01);
}

#[test]
fn pdf_defaults_context_has_correct_values() {
    let ctx = LengthResolutionContext::pdf_defaults(300.0);
    assert_eq!(ctx.percentage_basis, 300.0);
    assert_eq!(ctx.units.font.em, DEFAULT_FONT_SIZE);
    assert_eq!(ctx.units.font.rem, DEFAULT_FONT_SIZE);
    assert_eq!(ctx.units.viewport.width, DEFAULT_PAGE_WIDTH);
    assert_eq!(ctx.units.viewport.height, DEFAULT_PAGE_HEIGHT);
}

#[test]
fn pdf_with_font_sizes_context_has_correct_values() {
    let ctx = LengthResolutionContext::pdf_with_font_sizes(250.0, 20.0, 18.0);
    assert_eq!(ctx.percentage_basis, 250.0);
    assert_eq!(ctx.units.font.em, 20.0);
    assert_eq!(ctx.units.font.rem, 18.0);
}
