//! Backend-independent gradient sampling geometry.

use crate::style::computed::{LinearGradient, ResolvedGradientRamp};
use crate::types::{Color, Point, Size, Vector};

/// One linear-gradient tile with its resolved color ramp and projection line.
pub(crate) struct LinearGradientSampler {
    center: Point,
    direction: Vector,
    half_line: f32,
    ramp: ResolvedGradientRamp,
}

impl LinearGradientSampler {
    pub(crate) fn resolve(gradient: &LinearGradient, tile_size: Size) -> Option<Self> {
        if !tile_size.width.is_finite()
            || !tile_size.height.is_finite()
            || tile_size.width <= 0.0
            || tile_size.height <= 0.0
        {
            return None;
        }
        let (sin, cos) = sin_cos_degrees(gradient.angle);
        let direction = Vector::new(sin, -cos);
        let half_line =
            (tile_size.width * direction.x.abs() + tile_size.height * direction.y.abs()) / 2.0;
        if !half_line.is_finite() || half_line <= 0.0 {
            return None;
        }
        Some(Self {
            center: Point::new(tile_size.width / 2.0, tile_size.height / 2.0),
            direction,
            half_line,
            ramp: gradient.ramp.resolve(half_line * 2.0)?,
        })
    }

    pub(crate) fn sample(&self, point: Point) -> Color {
        let offset = point - self.center;
        let projection = offset.x * self.direction.x + offset.y * self.direction.y;
        let progress = (projection + self.half_line) / (2.0 * self.half_line);
        let (red, green, blue, alpha) = self.ramp.sample(progress);
        Color::from_srgb(red, green, blue, alpha)
    }
}

/// Exact direction components for the four semantic CSS cardinal angles;
/// arbitrary angles retain the platform trigonometric result.
pub(crate) fn sin_cos_degrees(angle: f32) -> (f32, f32) {
    match angle.rem_euclid(360.0) {
        0.0 => (0.0, 1.0),
        90.0 => (1.0, 0.0),
        180.0 => (0.0, -1.0),
        270.0 => (-1.0, 0.0),
        _ => angle.to_radians().sin_cos(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::{
        GradientColor, GradientColorProvenance, GradientPosition, GradientRamp, GradientStop,
    };

    #[test]
    fn horizontal_gradient_uses_top_down_css_coordinates() {
        let color = |color| GradientColor::new(color, GradientColorProvenance::LegacySrgb);
        let gradient = LinearGradient {
            angle: 90.0,
            ramp: GradientRamp {
                stops: vec![
                    GradientStop::new(color(Color::BLACK), Some(GradientPosition::default())),
                    GradientStop::new(color(Color::WHITE), Some(GradientPosition::fraction(1.0))),
                ],
                ..Default::default()
            },
            layer_box: Default::default(),
        };
        let sampler = LinearGradientSampler::resolve(&gradient, Size::new(100.0, 20.0))
            .expect("finite gradient sampler");

        assert!(sampler.sample(Point::new(1.0, 10.0)).r < 10.0);
        assert!(sampler.sample(Point::new(99.0, 10.0)).r > 245.0);
    }
}
