use crate::types::{CornerRadii, CornerRadius, EdgeSizes, PhysicalSide, Point, Rect, Vector};

/// One CSS rounded rectangle in top-down physical coordinates.
///
/// The outer radii are normalized once when the shape is constructed. Insets
/// derive their curves from that used outer shape, as required by CSS
/// Backgrounds and Borders 3 sections 4.2 and 4.5.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct CssRoundedRect {
    pub(crate) rect: Rect,
    pub(crate) radii: CornerRadii,
}

impl CssRoundedRect {
    pub(crate) fn new(rect: Rect, radii: CornerRadii) -> Self {
        Self {
            rect,
            radii: radii.fit_to(rect.size.width, rect.size.height),
        }
    }

    fn from_used(rect: Rect, radii: CornerRadii) -> Self {
        Self { rect, radii }
    }

    pub(crate) fn inset(self, edges: EdgeSizes) -> Self {
        Self::from_used(self.rect.inset(edges), self.radii.inset(edges))
    }

    pub(crate) fn contains(self, point: Point) -> bool {
        let left = self.rect.origin.x;
        let top = self.rect.origin.y;
        let right = self.rect.right();
        let bottom = self.rect.bottom();
        if point.x < left || point.x >= right || point.y < top || point.y >= bottom {
            return false;
        }

        let corner_contains = |center: Point, radius: CornerRadius| {
            if radius.is_zero() {
                return true;
            }
            let offset = point - center;
            (offset.x / radius.x).powi(2) + (offset.y / radius.y).powi(2) <= 1.0
        };
        if point.x < left + self.radii.top_left.x && point.y < top + self.radii.top_left.y {
            corner_contains(
                Point::new(left + self.radii.top_left.x, top + self.radii.top_left.y),
                self.radii.top_left,
            )
        } else if point.x > right - self.radii.top_right.x && point.y < top + self.radii.top_right.y
        {
            corner_contains(
                Point::new(right - self.radii.top_right.x, top + self.radii.top_right.y),
                self.radii.top_right,
            )
        } else if point.x > right - self.radii.bottom_right.x
            && point.y > bottom - self.radii.bottom_right.y
        {
            corner_contains(
                Point::new(
                    right - self.radii.bottom_right.x,
                    bottom - self.radii.bottom_right.y,
                ),
                self.radii.bottom_right,
            )
        } else if point.x < left + self.radii.bottom_left.x
            && point.y > bottom - self.radii.bottom_left.y
        {
            corner_contains(
                Point::new(
                    left + self.radii.bottom_left.x,
                    bottom - self.radii.bottom_left.y,
                ),
                self.radii.bottom_left,
            )
        } else {
            true
        }
    }
}

/// The CSS border ring plus an exclusive region for each physical side.
///
/// Adjacent regions share one frontier from the outer corner toward the inner
/// curve. No region overlaps another, so translucent or differently coloured
/// borders never repaint a corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BorderRing {
    pub(crate) outer: CssRoundedRect,
    pub(crate) inner: CssRoundedRect,
}

impl BorderRing {
    pub(crate) fn new(border_box: Rect, radii: CornerRadii, widths: EdgeSizes) -> Self {
        Self::between(border_box, radii, EdgeSizes::ZERO, widths)
    }

    pub(crate) fn between(
        border_box: Rect,
        radii: CornerRadii,
        outer_inset: EdgeSizes,
        inner_inset: EdgeSizes,
    ) -> Self {
        let border_shape = CssRoundedRect::new(border_box, radii);
        Self {
            outer: border_shape.inset(outer_inset),
            inner: border_shape.inset(inner_inset),
        }
    }

    pub(crate) fn contains(self, point: Point) -> bool {
        self.outer.contains(point) && !self.inner.contains(point)
    }

    pub(crate) fn side_region(self, side: PhysicalSide) -> BorderSideRegion {
        let outer = self.outer.rect;
        let inner = self.inner.rect;
        let outer_top_left = outer.origin;
        let outer_top_right = Point::new(outer.right(), outer.origin.y);
        let outer_bottom_right = Point::new(outer.right(), outer.bottom());
        let outer_bottom_left = Point::new(outer.origin.x, outer.bottom());
        let inner_top_left = corner_transition_point(
            outer_top_left,
            inner.origin,
            self.inner.radii.top_left,
            Point::new(inner.origin.x + self.inner.radii.top_left.x, inner.origin.y),
            Point::new(inner.origin.x, inner.origin.y + self.inner.radii.top_left.y),
        );
        let inner_top_right = corner_transition_point(
            outer_top_right,
            Point::new(inner.right(), inner.origin.y),
            self.inner.radii.top_right,
            Point::new(inner.right() - self.inner.radii.top_right.x, inner.origin.y),
            Point::new(inner.right(), inner.origin.y + self.inner.radii.top_right.y),
        );
        let inner_bottom_right = corner_transition_point(
            outer_bottom_right,
            Point::new(inner.right(), inner.bottom()),
            self.inner.radii.bottom_right,
            Point::new(
                inner.right() - self.inner.radii.bottom_right.x,
                inner.bottom(),
            ),
            Point::new(
                inner.right(),
                inner.bottom() - self.inner.radii.bottom_right.y,
            ),
        );
        let inner_bottom_left = corner_transition_point(
            outer_bottom_left,
            Point::new(inner.origin.x, inner.bottom()),
            self.inner.radii.bottom_left,
            Point::new(
                inner.origin.x + self.inner.radii.bottom_left.x,
                inner.bottom(),
            ),
            Point::new(
                inner.origin.x,
                inner.bottom() - self.inner.radii.bottom_left.y,
            ),
        );

        BorderSideRegion::new(match side {
            PhysicalSide::Top => [
                outer_top_left,
                outer_top_right,
                inner_top_right,
                inner_top_left,
            ],
            PhysicalSide::Right => [
                outer_top_right,
                outer_bottom_right,
                inner_bottom_right,
                inner_top_right,
            ],
            PhysicalSide::Bottom => [
                outer_bottom_right,
                outer_bottom_left,
                inner_bottom_left,
                inner_bottom_right,
            ],
            PhysicalSide::Left => [
                outer_bottom_left,
                outer_top_left,
                inner_top_left,
                inner_bottom_left,
            ],
        })
    }

    pub(crate) fn side_at(self, point: Point) -> Option<PhysicalSide> {
        if !self.contains(point) {
            return None;
        }
        [
            PhysicalSide::Top,
            PhysicalSide::Right,
            PhysicalSide::Bottom,
            PhysicalSide::Left,
        ]
        .into_iter()
        .find(|side| self.side_region(*side).contains(point))
    }
}

/// One side's exclusive transition region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BorderSideRegion {
    pub(crate) points: [Point; 4],
}

impl BorderSideRegion {
    const fn new(points: [Point; 4]) -> Self {
        Self { points }
    }

    pub(crate) fn contains(self, point: Point) -> bool {
        let mut sign = 0_i8;
        for index in 0..self.points.len() {
            let start = self.points[index];
            let end = self.points[(index + 1) % self.points.len()];
            let edge = end - start;
            let offset = point - start;
            let cross = edge.x * offset.y - edge.y * offset.x;
            if cross.abs() <= 1e-5 {
                continue;
            }
            let current = if cross > 0.0 { 1 } else { -1 };
            if sign != 0 && sign != current {
                return false;
            }
            sign = current;
        }
        true
    }
}

fn corner_transition_point(
    outer_corner: Point,
    inner_corner: Point,
    inner_radius: CornerRadius,
    first_tip: Point,
    second_tip: Point,
) -> Point {
    if inner_radius.is_zero() {
        return inner_corner;
    }
    line_intersection(outer_corner, inner_corner, first_tip, second_tip).unwrap_or(inner_corner)
}

fn line_intersection(
    first_start: Point,
    first_end: Point,
    second_start: Point,
    second_end: Point,
) -> Option<Point> {
    let first = first_end - first_start;
    let second = second_end - second_start;
    let denominator = cross(first, second);
    if denominator.abs() <= f32::EPSILON {
        return None;
    }
    let distance = cross(second_start - first_start, second) / denominator;
    let point = Point::new(
        first_start.x + first.x * distance,
        first_start.y + first.y * distance,
    );
    (point.x.is_finite() && point.y.is_finite()).then_some(point)
}

const fn cross(first: Vector, second: Vector) -> f32 {
    first.x * second.y - first.y * second.x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_regions_partition_square_corners_on_one_diagonal() {
        let ring = BorderRing::new(
            Rect::from_xywh(0.0, 0.0, 100.0, 50.0),
            CornerRadii::ZERO,
            EdgeSizes::new(10.0, 20.0, 15.0, 5.0),
        );
        let top = ring.side_region(PhysicalSide::Top);
        let right = ring.side_region(PhysicalSide::Right);
        assert_eq!(top.points[1], right.points[0]);
        assert_eq!(top.points[2], right.points[3]);
        assert_eq!(top.points[2], Point::new(80.0, 10.0));
        assert_eq!(ring.side_at(Point::new(90.0, 4.0)), Some(PhysicalSide::Top));
        assert_eq!(
            ring.side_at(Point::new(96.0, 10.0)),
            Some(PhysicalSide::Right)
        );
    }

    #[test]
    fn inset_curves_derive_from_the_once_fitted_outer_curve() {
        let radii = CornerRadii::new(
            CornerRadius::new(90.0, 30.0),
            CornerRadius::new(60.0, 20.0),
            CornerRadius::new(30.0, 10.0),
            CornerRadius::new(15.0, 5.0),
        );
        let widths = EdgeSizes::new(3.0, 5.0, 7.0, 11.0);
        let fitted = radii.fit_to(100.0, 60.0);
        let ring = BorderRing::new(Rect::from_xywh(2.0, 4.0, 100.0, 60.0), radii, widths);
        assert_eq!(ring.outer.radii, fitted);
        assert_eq!(ring.inner.radii, fitted.inset(widths));
    }

    #[test]
    fn zero_width_side_does_not_own_the_adjoining_corner() {
        let ring = BorderRing::new(
            Rect::from_xywh(0.0, 0.0, 100.0, 50.0),
            CornerRadii::ZERO,
            EdgeSizes::new(0.0, 10.0, 10.0, 10.0),
        );
        assert_eq!(
            ring.side_at(Point::new(99.0, 1.0)),
            Some(PhysicalSide::Right)
        );
        assert_eq!(ring.side_at(Point::new(1.0, 1.0)), Some(PhysicalSide::Left));
    }
}
