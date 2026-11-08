//! Geometry operations on resolved CSS affine transforms.

use crate::types::{Point, Rect};

use super::{CssAffineMatrix, CssVector};

impl CssAffineMatrix {
    /// Translate by one CSS-space displacement.
    pub const fn translation(offset: CssVector) -> Self {
        Self::new(CssVector::new(1.0, 0.0), CssVector::new(0.0, 1.0), offset)
    }

    /// Whether this matrix preserves the CSS axes without rotation or skew.
    pub const fn is_scale_translate(self) -> bool {
        self.x_axis.y == 0.0 && self.y_axis.x == 0.0
    }

    /// Conjugate this affine transform around one point in the CSS top-down
    /// coordinate system.
    pub fn around(self, pivot: Point) -> Self {
        let [a, b, c, d, e, f] = self.components();
        let px = f64::from(pivot.x);
        let py = f64::from(pivot.y);
        Self::from_components(
            a,
            b,
            c,
            d,
            px + e - a * px - c * py,
            py + f - b * px - d * py,
        )
    }

    /// Transform one point in the CSS top-down coordinate system.
    pub fn transform_point(self, point: Point) -> Point {
        let [a, b, c, d, e, f] = self.components();
        let x = f64::from(point.x);
        let y = f64::from(point.y);
        Point::new((a * x + c * y + e) as f32, (b * x + d * y + f) as f32)
    }

    /// Smallest axis-aligned rectangle enclosing a transformed rectangle.
    pub fn enclosing_rect(self, rect: Rect) -> Rect {
        let corners = [
            rect.origin,
            Point::new(rect.right(), rect.origin.y),
            Point::new(rect.origin.x, rect.bottom()),
            Point::new(rect.right(), rect.bottom()),
        ]
        .map(|point| self.transform_point(point));
        let left = corners
            .iter()
            .map(|point| point.x)
            .fold(f32::INFINITY, f32::min);
        let top = corners
            .iter()
            .map(|point| point.y)
            .fold(f32::INFINITY, f32::min);
        let right = corners
            .iter()
            .map(|point| point.x)
            .fold(f32::NEG_INFINITY, f32::max);
        let bottom = corners
            .iter()
            .map(|point| point.y)
            .fold(f32::NEG_INFINITY, f32::max);
        Rect::from_xywh(left, top, right - left, bottom - top)
    }
}

/// Matrix composition in visual application order: `parent * child` maps a
/// point through `child` first and then through `parent`.
impl std::ops::Mul for CssAffineMatrix {
    type Output = Self;

    fn mul(self, rhs: Self) -> Self::Output {
        let [a1, b1, c1, d1, e1, f1] = self.components();
        let [a2, b2, c2, d2, e2, f2] = rhs.components();
        Self::from_components(
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affine_composition_applies_child_before_parent() {
        let child = CssAffineMatrix::translation(CssVector::new(2.0, 3.0));
        let parent = CssAffineMatrix::from_components(2.0, 0.0, 0.0, 4.0, 0.0, 0.0);

        assert_eq!(
            (parent * child).transform_point(Point::new(5.0, 7.0)),
            Point::new(14.0, 40.0)
        );
    }

    #[test]
    fn scale_translate_classification_rejects_rotation_and_skew() {
        assert!(CssAffineMatrix::IDENTITY.is_scale_translate());
        assert!(CssAffineMatrix::translation(CssVector::new(2.0, 3.0)).is_scale_translate());
        assert!(
            !CssAffineMatrix::from_components(1.0, 0.1, 0.0, 1.0, 0.0, 0.0).is_scale_translate()
        );
    }
}
