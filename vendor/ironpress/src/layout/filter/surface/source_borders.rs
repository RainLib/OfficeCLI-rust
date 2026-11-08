use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
use crate::style::computed::BorderStyle;
use crate::types::{Color, CornerRadii, EdgeSizes, PhysicalEdges, PhysicalSide, Point, Rect};

use crate::render::borders::{BorderRing, CssRoundedRect, DoubleBorderMetrics, bevel_edge_color};

/// Resolved CSS border paint for an offscreen CSS filter `SourceGraphic`.
///
/// All styles use one exclusive side partition. A sample can therefore be
/// painted at most once even where adjacent translucent sides meet. Ordinary
/// PDF border output never enters this module and remains vector content.
pub(super) struct RasterBorder<'a> {
    border: &'a LayoutBorder,
    ring: BorderRing,
    outer_double: BorderRing,
    inner_double: BorderRing,
    outer_half: BorderRing,
    inner_half: BorderRing,
    pattern_path: BorderPatternPath,
}

impl<'a> RasterBorder<'a> {
    pub(super) fn new(border_box: Rect, border: &'a LayoutBorder, radii: CornerRadii) -> Self {
        let widths = border.widths();
        let double_rules = widths.map(|width| DoubleBorderMetrics::new(width).stripe_width());
        let half_widths = widths * 0.5;
        let ring = BorderRing::new(border_box, radii, widths);
        Self {
            border,
            ring,
            outer_double: BorderRing::between(border_box, radii, EdgeSizes::ZERO, double_rules),
            inner_double: BorderRing::between(border_box, radii, widths - double_rules, widths),
            outer_half: BorderRing::between(border_box, radii, EdgeSizes::ZERO, half_widths),
            inner_half: BorderRing::between(border_box, radii, half_widths, widths),
            pattern_path: BorderPatternPath::new(ring, widths),
        }
    }

    pub(crate) fn sample(&self, point: Point) -> Option<Color> {
        let side_name = self.ring.side_at(point)?;
        let side = self.border.get(side_name);
        if !side.paints() {
            return None;
        }
        match side.style {
            BorderStyle::Solid => Some(side.color),
            BorderStyle::Double => (self.outer_double.contains(point)
                || self.inner_double.contains(point))
            .then_some(side.color),
            BorderStyle::Groove | BorderStyle::Ridge => {
                let inner = if self.outer_half.contains(point) {
                    false
                } else if self.inner_half.contains(point) {
                    true
                } else {
                    return None;
                };
                Some(bevel_color(side, side_name, inner))
            }
            BorderStyle::Inset | BorderStyle::Outset => Some(bevel_color(side, side_name, false)),
            BorderStyle::Dashed | BorderStyle::Dotted => self
                .pattern_path
                .paints(point, side_name, side.width, side.style)
                .then_some(side.color),
            BorderStyle::None | BorderStyle::Hidden => None,
        }
    }
}

fn bevel_color(side: &LayoutBorderSide, side_name: PhysicalSide, inner: bool) -> Color {
    let (red, green, blue) =
        bevel_edge_color(side.style, side_name, inner, side.color.to_f32_rgb());
    Color::from_srgb(red, green, blue, side.color.alpha())
}

/// A vertical multicolumn rule using the CSS border-style paint vocabulary.
/// Keeping this beside the filter source border painter prevents filtered
/// multicolumn groups from silently falling back for patterned or 3D styles.
pub(super) struct RasterColumnRule {
    rect: Rect,
    paint: LayoutBorderSide,
}

impl RasterColumnRule {
    pub(super) const fn new(rect: Rect, paint: LayoutBorderSide) -> Self {
        Self { rect, paint }
    }

    pub(super) fn sample(&self, point: Point) -> Option<Color> {
        if !self.paint.paints()
            || point.x < self.rect.origin.x
            || point.x >= self.rect.right()
            || point.y < self.rect.origin.y
            || point.y >= self.rect.bottom()
        {
            return None;
        }
        let across = point.x - self.rect.origin.x;
        let along = point.y - self.rect.origin.y;
        let width = self.paint.width;
        match self.paint.style {
            BorderStyle::Solid => Some(self.paint.color),
            BorderStyle::Double => DoubleBorderMetrics::new(width)
                .paints(across)
                .then_some(self.paint.color),
            BorderStyle::Groove | BorderStyle::Ridge => Some(bevel_color(
                &self.paint,
                PhysicalSide::Left,
                across >= width * 0.5,
            )),
            BorderStyle::Inset | BorderStyle::Outset => {
                Some(bevel_color(&self.paint, PhysicalSide::Left, false))
            }
            BorderStyle::Dashed => {
                dashed_at(along, self.rect.size.height, width).then_some(self.paint.color)
            }
            BorderStyle::Dotted => {
                let radius = width * 0.5;
                let center = nearest_dot(along, self.rect.size.height, width);
                ((radius - across).hypot(along - center) <= radius).then_some(self.paint.color)
            }
            BorderStyle::None | BorderStyle::Hidden => None,
        }
    }
}

/// A device-independent polyline approximation of the used rounded border
/// centerline. CSS does not prescribe dash distribution, but does require the
/// pattern to follow the curve and encourages symmetric corners. Each side is
/// fitted independently between its two transition frontiers.
struct BorderPatternPath {
    segments: Vec<PatternSegment>,
    lengths: PhysicalEdges<f32>,
}

impl BorderPatternPath {
    fn new(ring: BorderRing, widths: EdgeSizes) -> Self {
        let shape = ring.outer.inset(widths * 0.5);
        let points = rounded_path_points(shape);
        let mut segments = Vec::with_capacity(points.len().saturating_sub(1));
        let mut lengths = EdgeSizes::ZERO;
        for points in points.windows(2) {
            let start = points[0];
            let end = points[1];
            let vector = end - start;
            let length = vector.x.hypot(vector.y);
            if length <= f32::EPSILON {
                continue;
            }
            let midpoint = Point::new((start.x + end.x) * 0.5, (start.y + end.y) * 0.5);
            let Some(side) = ring.side_at(midpoint) else {
                continue;
            };
            let offset = *lengths.get(side);
            *lengths.get_mut(side) += length;
            segments.push(PatternSegment {
                start,
                end,
                side,
                offset,
                length,
            });
        }
        Self { segments, lengths }
    }

    fn paints(&self, point: Point, side: PhysicalSide, width: f32, style: BorderStyle) -> bool {
        let Some(nearest) = self.nearest(point, side) else {
            return false;
        };
        let radius = width * 0.5;
        if nearest.distance > radius {
            return false;
        }
        let length = *self.lengths.get(side);
        match style {
            BorderStyle::Dashed => dashed_at(nearest.offset, length, width),
            BorderStyle::Dotted => {
                let center_offset = nearest_dot(nearest.offset, length, width);
                nearest.distance.hypot(nearest.offset - center_offset) <= radius
            }
            _ => false,
        }
    }

    fn nearest(&self, point: Point, side: PhysicalSide) -> Option<PathProjection> {
        self.segments
            .iter()
            .filter(|segment| segment.side == side)
            .map(|segment| segment.project(point))
            .min_by(|left, right| left.distance.total_cmp(&right.distance))
    }
}

#[derive(Clone, Copy)]
struct PatternSegment {
    start: Point,
    end: Point,
    side: PhysicalSide,
    offset: f32,
    length: f32,
}

impl PatternSegment {
    fn project(self, point: Point) -> PathProjection {
        let segment = self.end - self.start;
        let from_start = point - self.start;
        let denominator = segment.x * segment.x + segment.y * segment.y;
        let fraction = if denominator > 0.0 {
            ((from_start.x * segment.x + from_start.y * segment.y) / denominator).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let nearest = Point::new(
            self.start.x + segment.x * fraction,
            self.start.y + segment.y * fraction,
        );
        let distance = point - nearest;
        PathProjection {
            distance: distance.x.hypot(distance.y),
            offset: self.offset + self.length * fraction,
        }
    }
}

#[derive(Clone, Copy)]
struct PathProjection {
    distance: f32,
    offset: f32,
}

fn dashed_at(offset: f32, length: f32, width: f32) -> bool {
    if length <= 0.0 || width <= 0.0 {
        return false;
    }
    let dash = (width * 2.0).min(length);
    let count = (((length + width) / (dash + width)).round() as usize).max(1);
    if count == 1 {
        return offset <= dash;
    }
    let gap = ((length - count as f32 * dash) / (count - 1) as f32).max(0.0);
    let period = dash + gap;
    let index = (offset / period).floor().min((count - 1) as f32);
    offset - index * period <= dash
}

fn nearest_dot(offset: f32, length: f32, width: f32) -> f32 {
    if length <= 0.0 || width <= 0.0 {
        return 0.0;
    }
    let intervals = (length / (width * 2.0)).round().max(1.0);
    let step = length / intervals;
    (offset / step).round().clamp(0.0, intervals) * step
}

fn rounded_path_points(shape: CssRoundedRect) -> Vec<Point> {
    const ARC_STEPS: usize = 24;
    let rect = shape.rect;
    let radii = shape.radii;
    let mut points = Vec::with_capacity(4 * (ARC_STEPS + 1) + 1);
    points.push(Point::new(rect.origin.x + radii.top_left.x, rect.origin.y));
    points.push(Point::new(rect.right() - radii.top_right.x, rect.origin.y));
    append_arc(
        &mut points,
        Point::new(
            rect.right() - radii.top_right.x,
            rect.origin.y + radii.top_right.y,
        ),
        radii.top_right.x,
        radii.top_right.y,
        -std::f32::consts::FRAC_PI_2,
        0.0,
        ARC_STEPS,
    );
    points.push(Point::new(
        rect.right(),
        rect.bottom() - radii.bottom_right.y,
    ));
    append_arc(
        &mut points,
        Point::new(
            rect.right() - radii.bottom_right.x,
            rect.bottom() - radii.bottom_right.y,
        ),
        radii.bottom_right.x,
        radii.bottom_right.y,
        0.0,
        std::f32::consts::FRAC_PI_2,
        ARC_STEPS,
    );
    points.push(Point::new(
        rect.origin.x + radii.bottom_left.x,
        rect.bottom(),
    ));
    append_arc(
        &mut points,
        Point::new(
            rect.origin.x + radii.bottom_left.x,
            rect.bottom() - radii.bottom_left.y,
        ),
        radii.bottom_left.x,
        radii.bottom_left.y,
        std::f32::consts::FRAC_PI_2,
        std::f32::consts::PI,
        ARC_STEPS,
    );
    points.push(Point::new(rect.origin.x, rect.origin.y + radii.top_left.y));
    append_arc(
        &mut points,
        Point::new(
            rect.origin.x + radii.top_left.x,
            rect.origin.y + radii.top_left.y,
        ),
        radii.top_left.x,
        radii.top_left.y,
        std::f32::consts::PI,
        std::f32::consts::PI * 1.5,
        ARC_STEPS,
    );
    points
}

fn append_arc(
    points: &mut Vec<Point>,
    center: Point,
    radius_x: f32,
    radius_y: f32,
    start: f32,
    end: f32,
    steps: usize,
) {
    if radius_x <= 0.0 || radius_y <= 0.0 {
        points.push(Point::new(
            center.x + radius_x * end.cos(),
            center.y + radius_y * end.sin(),
        ));
        return;
    }
    for step in 1..=steps {
        let angle = start + (end - start) * step as f32 / steps as f32;
        points.push(Point::new(
            center.x + radius_x * angle.cos(),
            center.y + radius_y * angle.sin(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::LayoutBorderSide;
    use crate::types::{CornerRadius, PhysicalEdges, Size};

    fn side(style: BorderStyle, color: Color) -> LayoutBorderSide {
        LayoutBorderSide {
            width: 8.0,
            color,
            style,
        }
    }

    #[test]
    fn mixed_translucent_sides_have_one_owner_at_the_corner() {
        let border = PhysicalEdges::new(
            side(BorderStyle::Solid, Color::rgba8(255, 0, 0, 128)),
            side(BorderStyle::Solid, Color::rgba8(0, 0, 255, 128)),
            LayoutBorderSide::default(),
            LayoutBorderSide::default(),
        );
        let paint = RasterBorder::new(
            Rect::new(Point::ORIGIN, Size::new(40.0, 40.0)),
            &border,
            CornerRadii::uniform(CornerRadius::circular(12.0)),
        );
        let sample = paint.sample(Point::new(34.0, 6.0));
        assert!(
            matches!(sample, Some(color) if color == border.top.color || color == border.right.color)
        );
    }

    #[test]
    fn every_painting_style_resolves_without_a_fallback() {
        for style in [
            BorderStyle::Solid,
            BorderStyle::Dashed,
            BorderStyle::Dotted,
            BorderStyle::Double,
            BorderStyle::Groove,
            BorderStyle::Ridge,
            BorderStyle::Inset,
            BorderStyle::Outset,
        ] {
            let border = PhysicalEdges::uniform(side(style, Color::BLACK));
            let paint = RasterBorder::new(
                Rect::new(Point::ORIGIN, Size::new(40.0, 40.0)),
                &border,
                CornerRadii::uniform(CornerRadius::circular(8.0)),
            );
            let painted = (0..40).any(|x| paint.sample(Point::new(x as f32 + 0.5, 4.0)).is_some());
            assert!(painted, "{style:?} did not paint");
        }
    }

    #[test]
    fn double_border_keeps_the_middle_gap_clear() {
        let border = PhysicalEdges::uniform(side(BorderStyle::Double, Color::BLACK));
        let paint = RasterBorder::new(
            Rect::new(Point::ORIGIN, Size::new(40.0, 40.0)),
            &border,
            CornerRadii::ZERO,
        );
        assert!(paint.sample(Point::new(20.0, 1.0)).is_some());
        assert!(paint.sample(Point::new(20.0, 4.0)).is_none());
        assert!(paint.sample(Point::new(20.0, 7.0)).is_some());
    }
}
