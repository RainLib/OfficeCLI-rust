use super::*;
use crate::types::PhysicalEdges;

/// The canonical centerline for curved dashed and dotted borders, together
/// with the portion owned by each physical side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(in crate::render::pdf) struct BorderStrokeGeometry {
    pub(in crate::render::pdf) centerline: RoundedRect,
    pub(super) spans: PhysicalEdges<BorderPathSpan>,
    path_length: f32,
}

impl BorderStrokeGeometry {
    pub(in crate::render::pdf) fn new(
        border_box: PdfRect,
        radii: CornerRadii,
        widths: EdgeSizes,
    ) -> Self {
        let fitted_radii = radii.fit_to(border_box.width, border_box.height);
        let centerline = border_box.rounded(fitted_radii).inset(widths * 0.5);
        let metrics = RoundedPathMetrics::new(widths, centerline);
        Self {
            centerline,
            spans: metrics.spans(),
            path_length: metrics.perimeter,
        }
    }

    pub(in crate::render::pdf) fn path_length(self) -> f32 {
        self.path_length
    }
}

/// One side's start offset and length on a closed border centerline.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(in crate::render::pdf) struct BorderPathSpan {
    pub(in crate::render::pdf) offset: f32,
    pub(in crate::render::pdf) length: f32,
}

#[derive(Debug, Clone, Copy)]
struct RoundedPathMetrics {
    perimeter: f32,
    seams: CornerSeamOffsets,
}

impl RoundedPathMetrics {
    fn new(widths: EdgeSizes, centerline: RoundedRect) -> Self {
        let radii = centerline.radii;
        let top = (centerline.rect.width - radii.top_left.x - radii.top_right.x).max(0.0);
        let right = (centerline.rect.height - radii.top_right.y - radii.bottom_right.y).max(0.0);
        let bottom = (centerline.rect.width - radii.bottom_right.x - radii.bottom_left.x).max(0.0);
        let left = (centerline.rect.height - radii.bottom_left.y - radii.top_left.y).max(0.0);
        let top_right = CornerArc::new(
            radii.top_right,
            widths.right,
            widths.top,
            ArcOrientation::TopToRight,
        );
        let bottom_right = CornerArc::new(
            radii.bottom_right,
            widths.right,
            widths.bottom,
            ArcOrientation::RightToBottom,
        );
        let bottom_left = CornerArc::new(
            radii.bottom_left,
            widths.left,
            widths.bottom,
            ArcOrientation::BottomToLeft,
        );
        let top_left = CornerArc::new(
            radii.top_left,
            widths.left,
            widths.top,
            ArcOrientation::LeftToTop,
        );

        let top_right_offset = top + top_right.before_seam;
        let bottom_right_offset = top + top_right.length + right + bottom_right.before_seam;
        let bottom_left_offset =
            top + top_right.length + right + bottom_right.length + bottom + bottom_left.before_seam;
        let top_left_offset = top
            + top_right.length
            + right
            + bottom_right.length
            + bottom
            + bottom_left.length
            + left
            + top_left.before_seam;
        let perimeter = top
            + right
            + bottom
            + left
            + top_right.length
            + bottom_right.length
            + bottom_left.length
            + top_left.length;
        Self {
            perimeter,
            seams: CornerSeamOffsets {
                top_right: top_right_offset,
                bottom_right: bottom_right_offset,
                bottom_left: bottom_left_offset,
                top_left: top_left_offset,
            },
        }
    }

    fn spans(self) -> PhysicalEdges<BorderPathSpan> {
        PhysicalEdges::new(
            BorderPathSpan {
                offset: self.seams.top_left,
                length: self.perimeter - self.seams.top_left + self.seams.top_right,
            },
            BorderPathSpan {
                offset: self.seams.top_right,
                length: self.seams.bottom_right - self.seams.top_right,
            },
            BorderPathSpan {
                offset: self.seams.bottom_right,
                length: self.seams.bottom_left - self.seams.bottom_right,
            },
            BorderPathSpan {
                offset: self.seams.bottom_left,
                length: self.seams.top_left - self.seams.bottom_left,
            },
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct CornerSeamOffsets {
    top_right: f32,
    bottom_right: f32,
    bottom_left: f32,
    top_left: f32,
}

#[derive(Debug, Clone, Copy)]
struct CornerArc {
    length: f32,
    before_seam: f32,
}

impl CornerArc {
    fn new(
        radius: crate::types::CornerRadius,
        adjacent_x_width: f32,
        adjacent_y_width: f32,
        orientation: ArcOrientation,
    ) -> Self {
        if radius.is_zero() {
            return Self {
                length: 0.0,
                before_seam: 0.0,
            };
        }
        let seam =
            normalized_centerline_seam(radius, adjacent_x_width, adjacent_y_width, orientation);
        Self {
            length: ellipse_arc_length(radius, orientation, std::f32::consts::FRAC_PI_2),
            before_seam: ellipse_arc_length(radius, orientation, orientation.angle(seam)),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ArcOrientation {
    TopToRight,
    RightToBottom,
    BottomToLeft,
    LeftToTop,
}

impl ArcOrientation {
    fn signs(self) -> PdfVector {
        match self {
            Self::TopToRight => PdfVector::new(1.0, 1.0),
            Self::RightToBottom => PdfVector::new(1.0, -1.0),
            Self::BottomToLeft => PdfVector::new(-1.0, -1.0),
            Self::LeftToTop => PdfVector::new(-1.0, 1.0),
        }
    }

    fn angle(self, point: PdfVector) -> f32 {
        let angle = match self {
            Self::TopToRight => point.x.atan2(point.y),
            Self::RightToBottom => (-point.y).atan2(point.x),
            Self::BottomToLeft => (-point.x).atan2(-point.y),
            Self::LeftToTop => point.y.atan2(-point.x),
        };
        angle.clamp(0.0, std::f32::consts::FRAC_PI_2)
    }

    fn arc_speed(self, radius: crate::types::CornerRadius, angle: f32) -> f32 {
        let (x, y) = match self {
            Self::TopToRight | Self::BottomToLeft => {
                (radius.x * angle.cos(), radius.y * angle.sin())
            }
            Self::RightToBottom | Self::LeftToTop => {
                (radius.x * angle.sin(), radius.y * angle.cos())
            }
        };
        x.hypot(y)
    }
}

fn normalized_centerline_seam(
    radius: crate::types::CornerRadius,
    adjacent_x_width: f32,
    adjacent_y_width: f32,
    orientation: ArcOrientation,
) -> PdfVector {
    let signs = orientation.signs();
    let outer = PdfVector::new(
        signs.x * (radius.x + adjacent_x_width / 2.0),
        signs.y * (radius.y + adjacent_y_width / 2.0),
    );
    let direction = PdfVector::new(-signs.x * adjacent_x_width, -signs.y * adjacent_y_width);
    let a = (direction.x / radius.x).powi(2) + (direction.y / radius.y).powi(2);
    let b =
        2.0 * (outer.x * direction.x / radius.x.powi(2) + outer.y * direction.y / radius.y.powi(2));
    let c = (outer.x / radius.x).powi(2) + (outer.y / radius.y).powi(2) - 1.0;
    let discriminant = b * b - 4.0 * a * c;
    if a <= f32::EPSILON || discriminant < 0.0 {
        return signs;
    }
    let root = discriminant.sqrt();
    let distance = [(-b - root) / (2.0 * a), (-b + root) / (2.0 * a)]
        .into_iter()
        .filter(|distance| distance.is_finite() && *distance >= 0.0)
        .min_by(f32::total_cmp)
        .unwrap_or(0.0);
    PdfVector::new(
        (outer.x + distance * direction.x) / radius.x,
        (outer.y + distance * direction.y) / radius.y,
    )
}

fn ellipse_arc_length(
    radius: crate::types::CornerRadius,
    orientation: ArcOrientation,
    end_angle: f32,
) -> f32 {
    const STEPS: usize = 32;
    let end_angle = end_angle.clamp(0.0, std::f32::consts::FRAC_PI_2);
    if end_angle <= 0.0 {
        return 0.0;
    }
    let step = end_angle / STEPS as f32;
    let mut sum = orientation.arc_speed(radius, 0.0) + orientation.arc_speed(radius, end_angle);
    for index in 1..STEPS {
        let weight = if index % 2 == 0 { 2.0 } else { 4.0 };
        sum += weight * orientation.arc_speed(radius, index as f32 * step);
    }
    sum * step / 3.0
}
