//! Shared vector approximation of CSS ellipses and rounded rectangles.
//!
//! PDF has no rational quadratic operator, while CSS corner curves are exact
//! elliptical conics. Chromium's Skia PDF backend subdivides each conic until
//! its quadratic approximation is within a fixed device-space tolerance. This
//! module keeps that geometry in one place so PDF paths and raster masks use
//! the same curve rather than competing whole-quadrant cubic approximations.

use crate::render::borders::CssRoundedRect;
use crate::types::{CornerRadius, Point, Rect, Vector};

/// Maximum geometric error accepted while replacing a conic with quadratics.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CurveTolerance(f32);

impl CurveTolerance {
    /// Skia's 1/16-device-pixel PDF tolerance at Ironpress's point scale.
    pub(crate) const PDF: Self = Self(0.015);
    /// Skia's conic tolerance when coordinates are already raster pixels.
    pub(crate) const RASTER_PIXEL: Self = Self(0.0625);
}

/// One quadratic Bézier segment with its explicit start point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct QuadraticBezier {
    pub(crate) start: Point,
    pub(crate) control: Point,
    pub(crate) end: Point,
}

/// Consumer of a closed path made from lines and quadratic curves.
pub(crate) trait CurveSink {
    fn move_to(&mut self, point: Point);
    fn line_to(&mut self, point: Point);
    fn quadratic_to(&mut self, curve: QuadraticBezier);
    fn close(&mut self);
}

/// Adapter from shared CSS curve geometry to tiny-skia paths.
///
/// Filter sources, masks, and shadows all use this sink so their raster paths
/// cannot drift into independent rounded-corner approximations.
pub(crate) struct TinySkiaCurveSink<'a>(&'a mut resvg::tiny_skia::PathBuilder);

impl<'a> TinySkiaCurveSink<'a> {
    pub(crate) const fn new(builder: &'a mut resvg::tiny_skia::PathBuilder) -> Self {
        Self(builder)
    }
}

impl CurveSink for TinySkiaCurveSink<'_> {
    fn move_to(&mut self, point: Point) {
        self.0.move_to(point.x, point.y);
    }

    fn line_to(&mut self, point: Point) {
        self.0.line_to(point.x, point.y);
    }

    fn quadratic_to(&mut self, curve: QuadraticBezier) {
        self.0
            .quad_to(curve.control.x, curve.control.y, curve.end.x, curve.end.y);
    }

    fn close(&mut self) {
        self.0.close();
    }
}

/// The vector path of one CSS rounded rectangle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RoundedRectPath {
    shape: CssRoundedRect,
}

impl RoundedRectPath {
    pub(crate) fn new(rect: Rect, radii: crate::types::CornerRadii) -> Self {
        Self {
            shape: CssRoundedRect::new(rect, radii),
        }
    }

    pub(crate) fn write_to(self, sink: &mut impl CurveSink, tolerance: CurveTolerance) {
        let rect = self.shape.rect;
        let radii = self.shape.radii;
        let left = rect.origin.x;
        let top = rect.origin.y;
        let right = rect.right();
        let bottom = rect.bottom();

        sink.move_to(Point::new(left + radii.top_left.x, top));
        let top_right = Point::new(right - radii.top_right.x, top);
        sink.line_to(top_right);
        corner_to(
            sink,
            top_right,
            Point::new(right, top),
            Point::new(right, top + radii.top_right.y),
            radii.top_right,
            tolerance,
        );
        let bottom_right = Point::new(right, bottom - radii.bottom_right.y);
        sink.line_to(bottom_right);
        corner_to(
            sink,
            bottom_right,
            Point::new(right, bottom),
            Point::new(right - radii.bottom_right.x, bottom),
            radii.bottom_right,
            tolerance,
        );
        let bottom_left = Point::new(left + radii.bottom_left.x, bottom);
        sink.line_to(bottom_left);
        corner_to(
            sink,
            bottom_left,
            Point::new(left, bottom),
            Point::new(left, bottom - radii.bottom_left.y),
            radii.bottom_left,
            tolerance,
        );
        let top_left = Point::new(left, top + radii.top_left.y);
        sink.line_to(top_left);
        corner_to(
            sink,
            top_left,
            Point::new(left, top),
            Point::new(left + radii.top_left.x, top),
            radii.top_left,
            tolerance,
        );
        sink.close();
    }
}

/// The vector path of an axis-aligned ellipse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct EllipsePath {
    center: Point,
    radii: Vector,
}

impl EllipsePath {
    pub(crate) fn new(center: Point, radii: Vector) -> Option<Self> {
        (center.x.is_finite()
            && center.y.is_finite()
            && radii.x.is_finite()
            && radii.y.is_finite()
            && radii.x > 0.0
            && radii.y > 0.0)
            .then_some(Self { center, radii })
    }

    pub(crate) fn write_to(self, sink: &mut impl CurveSink, tolerance: CurveTolerance) {
        let Point { x, y } = self.center;
        let Vector { x: rx, y: ry } = self.radii;
        let mut current = Point::new(x + rx, y);
        sink.move_to(current);
        for (control, end) in [
            (Point::new(x + rx, y + ry), Point::new(x, y + ry)),
            (Point::new(x - rx, y + ry), Point::new(x - rx, y)),
            (Point::new(x - rx, y - ry), Point::new(x, y - ry)),
            (Point::new(x + rx, y - ry), Point::new(x + rx, y)),
        ] {
            ConicArc::quarter(current, control, end).write_to(sink, tolerance);
            current = end;
        }
        sink.close();
    }
}

fn corner_to(
    sink: &mut impl CurveSink,
    start: Point,
    control: Point,
    end: Point,
    radius: CornerRadius,
    tolerance: CurveTolerance,
) {
    if radius.is_zero() {
        sink.line_to(end);
        return;
    }
    ConicArc::quarter(start, control, end).write_to(sink, tolerance);
}

#[derive(Clone, Copy)]
struct ConicArc {
    points: [Point; 3],
    weight: f32,
}

impl ConicArc {
    const QUARTER_WEIGHT: f32 = std::f32::consts::FRAC_1_SQRT_2;
    const MAX_SUBDIVISION_DEPTH: u8 = 5;

    fn quarter(start: Point, control: Point, end: Point) -> Self {
        Self {
            points: [start, control, end],
            weight: Self::QUARTER_WEIGHT,
        }
    }

    fn write_to(self, sink: &mut impl CurveSink, tolerance: CurveTolerance) {
        self.write_at_depth(sink, self.subdivision_depth(tolerance));
    }

    fn subdivision_depth(self, tolerance: CurveTolerance) -> u8 {
        let coefficient = (self.weight - 1.0) / (4.0 * (1.0 + self.weight));
        let second_difference = (self.points[0] - Point::ORIGIN)
            - (self.points[1] - Point::ORIGIN) * 2.0
            + (self.points[2] - Point::ORIGIN);
        let mut error = (second_difference * coefficient).length();
        let mut depth = 0;
        while depth < Self::MAX_SUBDIVISION_DEPTH && error > tolerance.0 {
            error *= 0.25;
            depth += 1;
        }
        depth
    }

    fn write_at_depth(self, sink: &mut impl CurveSink, depth: u8) {
        if depth == 0 {
            sink.quadratic_to(QuadraticBezier {
                start: self.points[0],
                control: self.points[1],
                end: self.points[2],
            });
            return;
        }

        let (first, second) = self.subdivide();
        first.write_at_depth(sink, depth - 1);
        second.write_at_depth(sink, depth - 1);
    }

    fn subdivide(self) -> (Self, Self) {
        let scale = 1.0 / (1.0 + self.weight);
        let first = (self.points[0] - Point::ORIGIN) * scale;
        let control = (self.points[1] - Point::ORIGIN) * (self.weight * scale);
        let last = (self.points[2] - Point::ORIGIN) * scale;
        let first_control = Point::ORIGIN + first + control;
        let midpoint = Point::ORIGIN + first * 0.5 + control + last * 0.5;
        let second_control = Point::ORIGIN + control + last;
        let weight = (0.5 + self.weight * 0.5).sqrt();

        (
            Self {
                points: [self.points[0], first_control, midpoint],
                weight,
            },
            Self {
                points: [midpoint, second_control, self.points[2]],
                weight,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CornerRadii, Size};

    #[derive(Default)]
    struct CountingSink {
        moves: usize,
        lines: usize,
        quadratics: usize,
        closes: usize,
    }

    impl CurveSink for CountingSink {
        fn move_to(&mut self, _: Point) {
            self.moves += 1;
        }

        fn line_to(&mut self, _: Point) {
            self.lines += 1;
        }

        fn quadratic_to(&mut self, _: QuadraticBezier) {
            self.quadratics += 1;
        }

        fn close(&mut self) {
            self.closes += 1;
        }
    }

    #[test]
    fn pdf_tolerance_subdivides_css_corners_by_geometric_error() {
        let mut sink = CountingSink::default();
        RoundedRectPath::new(
            Rect::new(Point::default(), Size::new(120.0, 60.0)),
            CornerRadii::circular(31.5),
        )
        .write_to(&mut sink, CurveTolerance::PDF);

        assert_eq!(sink.moves, 1);
        assert_eq!(sink.lines, 4);
        assert_eq!(sink.quadratics, 64);
        assert_eq!(sink.closes, 1);
    }

    #[test]
    fn square_corners_remain_lines() {
        let mut sink = CountingSink::default();
        RoundedRectPath::new(
            Rect::new(Point::default(), Size::new(120.0, 60.0)),
            CornerRadii::ZERO,
        )
        .write_to(&mut sink, CurveTolerance::PDF);

        assert_eq!(sink.quadratics, 0);
        assert_eq!(sink.lines, 8);
    }
}
