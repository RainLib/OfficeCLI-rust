//! Floating-point comparison helpers for independently accumulated layout lengths.
//!
//! These comparisons cover only the arithmetic error of a short sequence of
//! `f32` operations. They are not visual tolerances and must not absorb authored
//! subpoint geometry.

const ARITHMETIC_ULPS: f32 = 8.0;

fn tolerance(left: f32, right: f32) -> f32 {
    left.abs().max(right.abs()).max(1.0) * f32::EPSILON * ARITHMETIC_ULPS
}

pub(crate) fn exceeds_with_roundoff(needed: f32, available: f32) -> bool {
    if needed <= available {
        return false;
    }
    if needed.is_nan() || available.is_nan() {
        return false;
    }
    if !needed.is_finite() || !available.is_finite() {
        return true;
    }
    needed - available > tolerance(needed, available)
}

pub(crate) fn equal_with_roundoff(left: f32, right: f32) -> bool {
    if left == right {
        return true;
    }
    if !left.is_finite() || !right.is_finite() {
        return false;
    }
    (left - right).abs() <= tolerance(left, right)
}

pub(crate) fn is_positive_with_roundoff(value: f32) -> bool {
    exceeds_with_roundoff(value, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comparison_bound_keeps_authored_subpoint_lengths_visible() {
        let at = tolerance(100.0, 100.0);
        let below = f32::from_bits((100.0 + at).to_bits() - 1);
        let above = f32::from_bits((100.0 + at).to_bits() + 1);

        assert!(!exceeds_with_roundoff(below, 100.0));
        assert!(!exceeds_with_roundoff(100.0 + at, 100.0));
        assert!(exceeds_with_roundoff(above, 100.0));
        assert!(exceeds_with_roundoff(100.005, 100.0));
        assert!(!equal_with_roundoff(100.5, 100.0));
    }

    #[test]
    fn non_finite_values_do_not_collapse_into_false_equality() {
        assert!(!exceeds_with_roundoff(f32::INFINITY, f32::INFINITY));
        assert!(exceeds_with_roundoff(f32::INFINITY, 100.0));
        assert!(equal_with_roundoff(f32::INFINITY, f32::INFINITY));
        assert!(!equal_with_roundoff(f32::INFINITY, f32::NEG_INFINITY));
    }
}
