use super::{assert_invalid, assert_number_resolves, assert_resolves};
use crate::parser::css::math::{
    CssMathExpression, FontRelativeLengths, MathUnitContext, ViewportLengths,
};

// Direct reductions of the authoritative WPT CSS Values corpus at
// web-platform-tests/wpt@af38980d2fcd74af19a226f5f651051cc15940ed.

#[test]
fn arithmetic_precedence_and_nested_functions_match_wpt() {
    for (source, expected) in [
        ("10 + 5 * 3", 25.0),
        ("(10 + 5) * 3", 45.0),
        ("pow(2, pow(2, 2))", 16.0),
        ("pow(2, sqrt(100))", 1024.0),
        ("sqrt(100)", 10.0),
        ("hypot(3, 4)", 5.0),
        ("hypot(3, 4, 12)", 13.0),
        ("-2 * hypot(3, 4)", -10.0),
        ("log(exp(1))", 1.0),
        ("log(exp(log(e)))", 1.0),
        ("log(10, 10)", 1.0),
        ("exp(0)", 1.0),
        ("log(e)", 1.0),
        ("e - exp(1)", 0.0),
        ("log((3 + 1) / 2, 2) + exp(0) * 2", 3.0),
        ("abs(0.1 + 0.2) + 0.05", 0.35),
        ("sign(0.1 + 0.2) - 0.05", 0.95),
        ("abs(0.1 + 0.2) * -2", -0.6),
        ("sign(1) + sign(1) - 0.05", 1.95),
    ] {
        assert_number_resolves(source, expected);
    }
}

#[test]
fn dimensional_products_and_quotients_match_typed_arithmetic_wpt() {
    // CSS Values 4 no longer restricts * and / to a unitless operand. Unit
    // exponents may be introduced temporarily as long as the final type is a
    // supported CSS numeric type. These are point-based adaptations of
    // typed_arithmetic.html and getComputedStyle-calc-mixed-units-003.html.
    for (source, basis, expected) in [
        ("calc(5px * 10lh / 1px)", 400.0, 600.0),
        ("calc(20% * .5em / 1px)", 400.0, 640.0),
        ("calc(4px * 4em / 1px)", 400.0, 192.0),
        ("calc(400px / 4lh * 1px)", 400.0, 4.6875),
        ("calc(20% / .5em * 1px)", 400.0, 10.0),
        ("calc(52px * 1px / 10%)", 400.0, 0.73125),
        ("calc(100px * 1px / 1px / 1)", 400.0, 75.0),
        ("calc(10% * 10% / 1px * 1deg / 1deg)", 400.0, 2133.3333),
        ("calc(1px * 2deg / 1deg)", 400.0, 1.5),
        ("calc(1px * 20s / 50ms)", 400.0, 300.0),
        ("calc(1px * 2kHz / 500Hz)", 400.0, 3.0),
        ("calc(1px * 192dpi / 2dppx)", 400.0, 0.75),
        ("calc(1px * 3fr / 1fr)", 400.0, 2.25),
    ] {
        assert_resolves(source, basis, expected);
    }

    let affine = CssMathExpression::parse("calc(20% * .5em / 1px)")
        .expect("typed arithmetic resolves to a length")
        .affine(super::units());
    assert_eq!(
        affine,
        Some(crate::parser::css::math::LengthPercent::percent(160.0))
    );

    for final_type_mismatch in [
        "calc(1px * 1px)",
        "calc(1px * 1deg / 1px)",
        "calc(1px * 1s / 1px)",
        "calc((1% * 1% * 1%) / 1px)",
    ] {
        assert_invalid(final_type_mismatch);
    }
}

#[test]
fn every_numeric_base_type_crosses_every_compatible_function_family() {
    // CSS Values 4 section 10.9 defines these seven numeric base dimensions.
    // Percentages use the length hint in this <length-percentage> evaluator.
    // Ratios cancel each result back to points so one public used-value path
    // can verify all otherwise non-length result categories.
    for unit in ["px", "%", "deg", "s", "Hz", "dpi", "fr"] {
        for (expression, expected) in [
            (format!("min(3{unit}, 5{unit})"), 3.0),
            (format!("max(3{unit}, 5{unit})"), 5.0),
            (format!("clamp(2{unit}, 3{unit}, 5{unit})"), 3.0),
            (format!("round(10{unit}, 6{unit})"), 12.0),
            (format!("mod(10{unit}, 6{unit})"), 4.0),
            (format!("rem(10{unit}, 6{unit})"), 4.0),
            (format!("abs(-3{unit})"), 3.0),
            (format!("hypot(3{unit}, 4{unit})"), 5.0),
        ] {
            assert_resolves(
                &format!("calc(({expression}) * 1pt / 1{unit})"),
                400.0,
                expected,
            );
        }

        assert_resolves(&format!("calc(sign(-1{unit}) * 1pt)"), 400.0, -1.0);
        assert_resolves(
            &format!("calc(atan2(1{unit}, 1{unit}) * 4pt / pi / 1rad)"),
            400.0,
            1.0,
        );
        assert_resolves(&format!("calc(40pt * 3{unit} / 1{unit})"), 400.0, 120.0);
    }
}

#[test]
fn incompatible_numeric_base_types_fail_as_a_cartesian_product() {
    let categories = ["px", "%", "deg", "s", "Hz", "dpi", "fr"];
    for (left_index, left) in categories.iter().enumerate() {
        for (right_index, right) in categories.iter().enumerate() {
            if left_index == right_index || matches!((*left, *right), ("px", "%") | ("%", "px")) {
                continue;
            }
            for expression in [
                format!("min(1{left}, 1{right})"),
                format!("max(1{left}, 1{right})"),
                format!("clamp(1{left}, 1{right}, 2{left})"),
                format!("round(1{left}, 1{right})"),
                format!("mod(1{left}, 1{right})"),
                format!("rem(1{left}, 1{right})"),
                format!("hypot(1{left}, 1{right})"),
                format!("atan2(1{left}, 1{right})"),
                format!("calc(1pt + 1{left} + 1{right})"),
            ] {
                assert_invalid(&expression);
            }
        }
    }
}

#[test]
fn number_only_and_trigonometric_function_type_boundaries_are_complete() {
    for dimension in ["1px", "1%", "1deg", "1s", "1Hz", "1dpi", "1fr"] {
        for function in ["pow", "log"] {
            assert_invalid(&format!("calc({function}({dimension}, 1) * 1pt)"));
            assert_invalid(&format!("calc({function}(1, {dimension}) * 1pt)"));
        }
        for function in ["sqrt", "exp", "asin", "acos", "atan"] {
            assert_invalid(&format!("calc({function}({dimension}) * 1pt)"));
        }
        if dimension != "1deg" {
            for function in ["sin", "cos", "tan"] {
                assert_invalid(&format!("calc({function}({dimension}) * 1pt)"));
            }
        }
    }

    for function in ["sin", "cos", "tan"] {
        assert!(CssMathExpression::parse(&format!("calc({function}(1deg) * 1pt)")).is_some());
        assert!(CssMathExpression::parse(&format!("calc({function}(1) * 1pt)")).is_some());
    }
}

#[test]
fn wpt_function_grammar_matrix_rejects_every_arity_and_separator_family() {
    let unary = [
        "abs", "sign", "sqrt", "exp", "sin", "cos", "tan", "asin", "acos", "atan",
    ];
    for function in unary {
        for arguments in [
            "", " ", ",", "1,", ",1", "1 +", "1 -", "1 *", "1 /", "1 2", "1, 2",
        ] {
            assert_invalid(&format!("calc(({function}({arguments})) * 1pt)"));
        }
    }

    for function in ["mod", "rem", "atan2", "pow"] {
        for arguments in [
            "", " ", ",", "1,", ",1", "1 +", "1 -", "1 *", "1 /", "1 2", "1, , 2", "1", "1, 2, 3",
        ] {
            assert_invalid(&format!("calc(({function}({arguments})) * 1pt)"));
        }
    }

    for function in ["min", "max", "hypot"] {
        for arguments in [
            "", " ", ",", "1,", ",1", "1 +", "1 -", "1 *", "1 /", "1 2", "1, , 2",
        ] {
            assert_invalid(&format!("calc(({function}({arguments})) * 1pt)"));
        }
    }

    for invalid_round in [
        "round()",
        "round( )",
        "round(,)",
        "round(1,)",
        "round(,1)",
        "round(1, nearest)",
        "round(1, 2, 3)",
        "round(sideways, 1, 2)",
    ] {
        assert_invalid(&format!("calc(({invalid_round}) * 1pt)"));
    }
}

#[test]
fn comparison_optional_bounds_and_default_round_interval_match_wpt() {
    for (source, basis, expected) in [
        ("clamp(none, 100px, 120px)", 400.0, 75.0),
        ("clamp(120px, 100px, none)", 400.0, 90.0),
        ("clamp(none, 100px, none)", 400.0, 75.0),
        ("clamp(120px, 100px, 80px)", 400.0, 90.0),
        ("calc(round(1.6) * 10px)", 400.0, 15.0),
        ("calc(round(-1.5) * 10px)", 400.0, -7.5),
    ] {
        assert_resolves(source, basis, expected);
    }
    assert_invalid("round(10px)");
    assert_invalid("clamp(none, none, none)");
}

#[test]
fn stepped_number_matrix_matches_wpt() {
    for (source, expected) in [
        ("round(100, 10)", 100.0),
        ("round(up, 101, 10)", 110.0),
        ("round(down, 106, 10)", 100.0),
        ("round(to-zero, 105, 10)", 100.0),
        ("round(to-zero, -105, 10)", -100.0),
        ("round(nearest, -105, 10)", -100.0),
        ("round(up, -103, 10)", -100.0),
        ("round(down, -103, 10)", -110.0),
        ("mod(18, 5)", 3.0),
        ("rem(18, 5)", 3.0),
        ("mod(-140, -90)", -50.0),
        ("mod(-18, 5)", 2.0),
        ("rem(-18, 5)", -3.0),
        ("mod(140, -90)", -40.0),
        ("rem(140, -90)", 50.0),
        ("mod(18, 5) * 2 + mod(17, 5)", 8.0),
        ("rem(mod(18, 5), mod(17, 5))", 1.0),
        ("mod(rem(1, 18) * -1, 5)", 4.0),
    ] {
        assert_number_resolves(source, expected);
    }

    for multiple in [0.0, 5.0, -5.0, 10.0, -10.0, 20.0, -20.0] {
        for strategy in ["up", "down", "nearest", "to-zero"] {
            assert_number_resolves(&format!("round({strategy}, {multiple}, 5)"), multiple);
        }
    }
}

#[test]
fn trig_inverse_trig_and_angle_units_match_wpt() {
    for (source, expected) in [
        ("cos(0)", 1.0),
        ("sin(0)", 0.0),
        ("tan(315deg)", -1.0),
        ("tan(405deg)", 1.0),
        ("sin(pi / 2 - pi / 2)", 0.0),
        ("cos(pi - 3.14159265358979323846)", 1.0),
        ("sin(30deg + 1.047197551rad)", 1.0),
        ("cos(30deg - 0.523598776rad)", 1.0),
        ("sin(100grad)", 1.0),
        ("tan(30deg + 0.261799388rad)", 1.0),
        ("sin(0.25turn)", 1.0),
        ("cos(sin(cos(pi) + 1))", 1.0),
        ("sin(tan(pi / 4) * pi / 2)", 1.0),
        ("sin(asin(0.5))", 0.5),
        ("cos(acos(0.5))", 0.5),
        ("tan(atan(1))", 1.0),
        ("tan(atan2(1px, 1px))", 1.0),
    ] {
        assert_number_resolves(source, expected);
    }
}

#[test]
fn every_supported_length_unit_has_a_checked_used_value() {
    for (unit, one_unit) in [
        ("px", 0.75),
        ("in", 72.0),
        ("cm", 72.0 / 2.54),
        ("mm", 72.0 / 25.4),
        ("q", 72.0 / 25.4 / 4.0),
        ("pt", 1.0),
        ("pc", 12.0),
        ("em", 12.0),
        ("rem", 15.0),
        ("ex", 6.0),
        ("rex", 7.5),
        ("ch", 6.0),
        ("rch", 7.5),
        ("cap", 12.0),
        ("rcap", 15.0),
        ("ic", 12.0),
        ("ric", 15.0),
        ("lh", 12.0),
        ("rlh", 15.0),
        ("vw", 6.0),
        ("svw", 6.0),
        ("lvw", 6.0),
        ("dvw", 6.0),
        ("vh", 8.0),
        ("svh", 8.0),
        ("lvh", 8.0),
        ("dvh", 8.0),
        ("vi", 6.0),
        ("svi", 6.0),
        ("lvi", 6.0),
        ("dvi", 6.0),
        ("vb", 8.0),
        ("svb", 8.0),
        ("lvb", 8.0),
        ("dvb", 8.0),
        ("vmin", 6.0),
        ("svmin", 6.0),
        ("lvmin", 6.0),
        ("dvmin", 6.0),
        ("vmax", 8.0),
        ("svmax", 8.0),
        ("lvmax", 8.0),
        ("dvmax", 8.0),
    ] {
        assert_resolves(&format!("calc(1{unit})"), 400.0, one_unit);
        assert_resolves(&format!("round(10{unit}, 6{unit})"), 400.0, one_unit * 12.0);
        assert_resolves(&format!("mod(10{unit}, 6{unit})"), 400.0, one_unit * 4.0);
        assert_resolves(&format!("rem(10{unit}, 6{unit})"), 400.0, one_unit * 4.0);
    }
}

#[test]
fn every_relative_unit_reads_its_own_context_field() {
    // Distinct primes make a swapped field impossible to hide behind the
    // fallback equalities (`ex == ch`, `lh == em`, and root equivalents).
    let units = MathUnitContext {
        font: FontRelativeLengths {
            em: 11.0,
            rem: 13.0,
            ex: 17.0,
            rex: 19.0,
            ch: 23.0,
            rch: 29.0,
            cap: 31.0,
            rcap: 37.0,
            ic: 41.0,
            ric: 43.0,
            lh: 47.0,
            rlh: 53.0,
        },
        viewport: ViewportLengths {
            width: 59.0,
            height: 61.0,
            inline: 67.0,
            block: 71.0,
        },
    };

    for (unit, expected) in [
        ("em", 11.0),
        ("rem", 13.0),
        ("ex", 17.0),
        ("rex", 19.0),
        ("ch", 23.0),
        ("rch", 29.0),
        ("cap", 31.0),
        ("rcap", 37.0),
        ("ic", 41.0),
        ("ric", 43.0),
        ("lh", 47.0),
        ("rlh", 53.0),
        ("vw", 0.59),
        ("vh", 0.61),
        ("vi", 0.67),
        ("vb", 0.71),
        ("vmin", 0.59),
        ("vmax", 0.61),
    ] {
        let actual = CssMathExpression::parse(&format!("calc(1{unit})"))
            .and_then(|expression| expression.resolve(units, 400.0));
        assert!(
            actual.is_some_and(|actual| (actual - expected).abs() < 0.001),
            "{unit}: expected {expected}, got {actual:?}"
        );
    }
}

#[test]
fn invalid_grammar_and_type_matrix_matches_wpt() {
    for source in [
        "calc()",
        "calc(1pt +)",
        "calc(1pt -)",
        "calc(1pt *)",
        "calc(1pt /)",
        "calc(1pt+ 2pt)",
        "calc(1pt +2pt)",
        "calc(+ 1pt)",
        "calc(- 1pt)",
        "calc(1pt 2pt)",
        "calc(1pt + 2)",
        "calc(1pt * 2pt)",
        "calc(1pt / 2pt)",
        "calc(1pt + 2deg)",
        "round()",
        "round(,)",
        "round(1pt,)",
        "round(, 1pt)",
        "round(nearest, 1pt)",
        "round(1pt, nearest)",
        "round(1pt, 2pt, 3pt)",
        "mod()",
        "mod(1pt)",
        "mod(1pt,)",
        "mod(, 1pt)",
        "mod(1pt, 2)",
        "rem()",
        "rem(1pt)",
        "rem(1pt, 2)",
        "min()",
        "min(1pt, 2deg)",
        "max(1pt, 2)",
        "clamp()",
        "clamp(1pt, 2pt)",
        "clamp(1pt, 2pt, 3pt, 4pt)",
        "clamp(none, none, none)",
        "clamp(1pt, none, 3pt)",
        "hypot()",
        "hypot(1pt, 2)",
        "pow(1)",
        "pow(1pt, 2)",
        "sqrt(1pt)",
        "log()",
        "log(1, 2, 3)",
        "exp(1pt)",
        "sin(1pt)",
        "asin(1pt)",
        "atan2(1pt, 1deg)",
        "abs(1pt, 2pt)",
        "sign(1pt, 2pt)",
    ] {
        assert_invalid(source);
    }
}

#[test]
fn parser_supports_spec_minimums_and_rejects_adversarial_complexity() {
    let thirty_two_terms = std::iter::repeat_n("1pt", 32)
        .collect::<Vec<_>>()
        .join(" + ");
    assert!(CssMathExpression::parse(&format!("calc({thirty_two_terms})")).is_some());

    let thirty_two_arguments = std::iter::repeat_n("1pt", 32)
        .collect::<Vec<_>>()
        .join(", ");
    assert!(CssMathExpression::parse(&format!("min({thirty_two_arguments})")).is_some());

    let mut nested = "1pt".to_string();
    for _ in 0..32 {
        nested = format!("calc({nested})");
    }
    assert!(CssMathExpression::parse(&nested).is_some());

    let too_many_terms = std::iter::repeat_n("1pt", 129)
        .collect::<Vec<_>>()
        .join(" + ");
    assert_invalid(&format!("calc({too_many_terms})"));

    let too_many_arguments = std::iter::repeat_n("1pt", 129)
        .collect::<Vec<_>>()
        .join(", ");
    assert_invalid(&format!("min({too_many_arguments})"));

    let mut too_deep = "1pt".to_string();
    for _ in 0..129 {
        too_deep = format!("calc({too_deep})");
    }
    assert_invalid(&too_deep);
}
