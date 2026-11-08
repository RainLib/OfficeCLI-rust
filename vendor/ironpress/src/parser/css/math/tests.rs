use super::*;

mod wpt_corpus;

// Cases are adapted to Ironpress's point-based used values from the WPT CSS
// Values suites at web-platform-tests/wpt@af38980d2fcd74af19a226f5f651051cc15940ed:
// calc-invalid-parsing.html, round-mod-rem-{computed,invalid}.html,
// signs-abs-{computed,invalid}.html, hypot-pow-sqrt-{computed,invalid}.html,
// exp-log-{compute,invalid}.html, and sin-cos-tan-{computed,invalid}.html.

pub(super) fn units() -> MathUnitContext {
    MathUnitContext::from_font_and_viewport(12.0, 15.0, 600.0, 800.0)
}

pub(super) fn assert_resolves(source: &str, basis: f32, expected: f32) {
    let actual = CssMathExpression::parse(source).and_then(|value| value.resolve(units(), basis));
    assert!(
        actual.is_some_and(|actual| (actual - expected).abs() < 0.001),
        "{source}: expected {expected}, got {actual:?}"
    );
}

pub(super) fn assert_number_resolves(source: &str, expected: f32) {
    assert_resolves(&format!("calc(({source}) * 1pt)"), 400.0, expected);
}

pub(super) fn assert_invalid(source: &str) {
    assert!(
        CssMathExpression::parse(source).is_none(),
        "invalid expression survived: {source}"
    );
}

#[test]
fn affine_math_preserves_precedence_parentheses_and_percentage() {
    let expression =
        CssMathExpression::parse("calc((25% - 10px) * 2)").expect("valid typed length math");
    assert_eq!(
        expression.affine(units()),
        Some(LengthPercent::from_terms(-15.0, 50.0))
    );
}

#[test]
fn arithmetic_and_nested_numeric_functions_match_wpt_used_values() {
    for (source, expected) in [
        ("calc(10pt + 5pt * 3)", 25.0),
        ("calc((10pt + 5pt) * 3)", 45.0),
        ("calc(100px * pow(2, pow(2, 2)))", 1200.0),
        ("calc(1px * pow(2, sqrt(100)))", 768.0),
        ("calc(100px * sqrt(100))", 750.0),
        ("calc((sqrt(16) + sin(pi / 2)) * 3px)", 11.25),
        ("calc((cos(0) + exp(0) + log(e)) * 4px)", 9.0),
        ("hypot(3pt, 4pt)", 5.0),
        ("hypot(3pt, 4pt, 12pt)", 13.0),
        ("calc(-2 * hypot(3pt, 4pt))", -10.0),
    ] {
        assert_resolves(source, 400.0, expected);
    }
}

#[test]
fn comparison_functions_use_the_eventual_percentage_basis() {
    for (source, basis, expected) in [
        ("min(100pt, 30%, 140pt)", 400.0, 100.0),
        ("max(100pt, 30%, 140pt)", 400.0, 140.0),
        ("clamp(90pt, 50%, 180pt)", 400.0, 180.0),
        // CSS Values gives the minimum precedence when the bounds are reversed.
        ("clamp(100pt, 50pt, 20pt)", 400.0, 100.0),
        (
            "clamp(20px, round(up, calc(12% + 1px), 5px), 80px)",
            400.0,
            48.75,
        ),
    ] {
        assert_resolves(source, basis, expected);
    }
}

#[test]
fn stepped_functions_cover_signs_ties_mixed_units_and_percentages() {
    for (source, basis, expected) in [
        ("round(nearest, 10px, 6px)", 0.0, 9.0),
        ("round(nearest, -25pt, 10pt)", 0.0, -20.0),
        ("round(up, -103pt, 10pt)", 0.0, -100.0),
        ("round(down, -103pt, 10pt)", 0.0, -110.0),
        ("round(to-zero, -105pt, 10pt)", 0.0, -100.0),
        ("mod(10px, 6px)", 0.0, 3.0),
        ("mod(-18px, 5px)", 0.0, 1.5),
        ("mod(18px, -5px)", 0.0, -1.5),
        ("rem(-18px, 5px)", 0.0, -2.25),
        ("rem(18px, -5px)", 0.0, 2.25),
        // WPT's containing block is 75px = 56.25pt.
        ("round(10%, 1px)", 56.25, 6.0),
        ("mod(10%, 5px)", 56.25, 1.875),
        ("rem(-18px, 100% / 15)", 56.25, -2.25),
    ] {
        assert_resolves(source, basis, expected);
    }
}

#[test]
fn abs_sign_and_relative_units_are_resolved_at_used_value_time() {
    for (source, basis, expected) in [
        ("abs(-17pt)", 400.0, 17.0),
        ("abs(-10%)", 400.0, 40.0),
        ("abs(10pt + 10%)", 400.0, 50.0),
        ("calc(sign(-17pt) * 8pt)", 400.0, -8.0),
        ("calc(sign(10%) * 100px)", 400.0, 75.0),
        ("calc(50px + 100px * sign(42px - 2em))", 400.0, 112.5),
        ("calc(50px + 100px * sign(30px - 2rem))", 400.0, -37.5),
    ] {
        assert_resolves(source, basis, expected);
    }
}

#[test]
fn all_supported_length_unit_families_parse_and_resolve() {
    for value in [
        "calc(1px + 1pt + 1pc + 1in + 1cm + 1mm + 1q)",
        "calc(1em + 1rem + 1ex + 1rex + 1ch + 1rch + 1cap + 1rcap)",
        "calc(1ic + 1ric + 1lh + 1rlh)",
        "calc(1vw + 1svw + 1lvw + 1dvw + 1vh + 1svh + 1lvh + 1dvh)",
        "calc(1vi + 1svi + 1lvi + 1dvi + 1vb + 1svb + 1lvb + 1dvb)",
        "calc(1vmin + 1svmin + 1lvmin + 1dvmin + 1vmax + 1svmax + 1lvmax + 1dvmax)",
    ] {
        assert!(
            CssMathExpression::parse(value)
                .and_then(|expression| expression.resolve(units(), 400.0))
                .is_some(),
            "failed to parse or resolve {value}"
        );
    }
}

#[test]
fn wpt_invalid_syntax_and_dimensional_combinations_are_rejected() {
    for value in [
        "calc()",
        "calc([])",
        "calc(7px * up)",
        "calc(10px + 2)",
        "calc(2px * 3px)",
        "calc(10px / 2px)",
        "round(nearest, 1px)",
        "round(nearest, 1px, 1px, 1px)",
        "mod(1px, 1)",
        "rem(1px, 1)",
        "hypot()",
        "hypot(2px, 3)",
        "hypot(1, 2)",
        "calc(1px * pow(1))",
        "calc(1px * pow(2px, 3px))",
        "calc(sqrt(100px) * 1px)",
        "pow(10px, 1)",
        "abs(1px, 2px)",
        "sign(1px, 2px)",
    ] {
        assert!(
            CssMathExpression::parse(value).is_none(),
            "invalid WPT-derived expression survived: {value}"
        );
    }
}

#[test]
fn non_finite_used_values_do_not_escape_into_layout() {
    for value in [
        "round(nearest, 10px, 0px)",
        "mod(10px, 0px)",
        "rem(10px, 0px)",
    ] {
        let parsed = CssMathExpression::parse(value).expect("typed expression remains parseable");
        assert_eq!(parsed.resolve(units(), 400.0), None, "{value}");
    }
}
