/// Serialize one finite `f32` using PDF's integer/real grammar.
///
/// `Display` expands the exponent for `f32`, preserving adjacent/subnormal
/// values without emitting scientific notation, which PDF does not accept.
pub(crate) fn format_pdf_number(value: f32) -> String {
    if !value.is_finite() || value == 0.0 {
        "0".to_string()
    } else {
        value.to_string()
    }
}

/// Serialize a finite PDF scalar with a fixed decimal ceiling, trimming
/// insignificant zeroes. Invalid upstream geometry fails closed to zero so PDF
/// serialization never panics or emits `NaN`/infinity tokens.
pub(crate) fn format_pdf_number_fixed(value: f64, precision: usize) -> String {
    if !value.is_finite() || value == 0.0 {
        return "0".to_owned();
    }
    let mut number = format!("{value:.precision$}");
    if number.contains('.') {
        while number.ends_with('0') {
            number.pop();
        }
        if number.ends_with('.') {
            number.pop();
        }
    }
    number
}

#[cfg(test)]
mod tests {
    use super::{format_pdf_number, format_pdf_number_fixed};

    #[test]
    fn preserves_subthreshold_adjacent_and_extreme_f32_values() {
        assert_eq!(format_pdf_number(0.000_49), "0.00049");
        assert_eq!(format_pdf_number(-0.000_49), "-0.00049");
        assert_eq!(format_pdf_number(-0.0), "0");

        let lower = 0.000_49_f32;
        let upper = f32::from_bits(lower.to_bits() + 1);
        for value in [lower, upper, f32::from_bits(1), f32::MIN_POSITIVE, f32::MAX] {
            let text = format_pdf_number(value);
            assert!(
                text.bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'.')),
                "PDF number must not use exponent or non-number tokens: {text}"
            );
            assert_eq!(text.parse::<f32>().unwrap().to_bits(), value.to_bits());
        }
        assert_ne!(format_pdf_number(lower), format_pdf_number(upper));
    }

    #[test]
    fn nonfinite_values_fail_closed_without_panicking() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(format_pdf_number(value), "0");
        }
    }

    #[test]
    fn fixed_precision_trims_zeroes_and_rejects_nonfinite_values() {
        assert_eq!(format_pdf_number_fixed(1.25, 8), "1.25");
        assert_eq!(format_pdf_number_fixed(239.131_515_5, 5), "239.13152");
        assert_eq!(format_pdf_number_fixed(f64::NAN, 5), "0");
    }
}
