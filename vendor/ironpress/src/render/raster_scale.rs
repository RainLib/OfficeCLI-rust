//! One physical scale for point-space rasterization and device quantization.

const POINTS_PER_INCH: f64 = 72.0;
const CSS_PIXELS_PER_INCH: f64 = 96.0;
const DEVICE_EDGE_EPSILON: f64 = 0.001;

/// A configured raster resolution with exact point-to-device conversion.
///
/// Raster painters still consume an `f32` pixels-per-point factor, but integer
/// backing bounds are derived from DPI in `f64`. This keeps exact authored
/// coordinates such as 48pt at 300 DPI on their integral device boundary.
#[derive(Clone, Copy)]
pub(crate) struct RasterScale {
    dpi: f64,
}

impl RasterScale {
    pub(crate) fn at_dpi(dpi: f32) -> Self {
        Self {
            dpi: f64::from(crate::style::raster_quality::raster_dpi_at_least(dpi, 1.0)),
        }
    }

    pub(crate) fn pixels_per_point(self) -> f32 {
        (self.dpi / POINTS_PER_INCH) as f32
    }

    pub(crate) fn pixels_per_css_pixel(self) -> f32 {
        (self.dpi / CSS_PIXELS_PER_INCH) as f32
    }

    fn point_to_device(self, points: f32) -> Option<f64> {
        let value = f64::from(points) * self.dpi / POINTS_PER_INCH;
        value.is_finite().then_some(value)
    }

    pub(crate) fn floor(self, points: f32) -> Option<i64> {
        quantized_device_integer(self.point_to_device(points)?, f64::floor)
    }

    pub(crate) fn ceil(self, points: f32) -> Option<i64> {
        quantized_device_integer(self.point_to_device(points)?, f64::ceil)
    }

    pub(crate) fn round(self, points: f32) -> Option<i64> {
        quantized_device_integer(self.point_to_device(points)?, f64::round)
    }

    pub(crate) fn sample_count(self, extent: f32) -> Option<u32> {
        if !extent.is_finite() || extent <= 0.0 {
            return None;
        }
        u32::try_from(self.round(extent)?.max(1)).ok()
    }

    pub(crate) fn pixels_to_points(self, pixels: f32) -> f32 {
        (f64::from(pixels) * POINTS_PER_INCH / self.dpi) as f32
    }
}

fn bounded_device_integer(value: f64) -> Option<i64> {
    (value >= i64::MIN as f64 && value <= i64::MAX as f64).then_some(value as i64)
}

fn quantized_device_integer(value: f64, quantize: fn(f64) -> f64) -> Option<i64> {
    let integer = value.round();
    let stabilized = if (value - integer).abs() <= DEVICE_EDGE_EPSILON {
        integer
    } else {
        value
    };
    bounded_device_integer(quantize(stabilized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_point_coordinate_stays_on_its_device_boundary() {
        let scale = RasterScale::at_dpi(300.0);

        assert_eq!(scale.point_to_device(48.0), Some(200.0));
        assert_eq!(scale.pixels_per_css_pixel(), 3.125);
        assert_eq!(scale.floor(48.0), Some(200));
        assert_eq!(scale.ceil(48.0), Some(200));
        assert_eq!(scale.sample_count(48.0), Some(200));
    }

    #[test]
    fn enclosing_a_half_pixel_extent_does_not_gain_a_leading_pixel() {
        let scale = RasterScale::at_dpi(300.0);

        assert_eq!(scale.floor(48.0), Some(200));
        assert_eq!(scale.ceil(99.0), Some(413));
    }

    #[test]
    fn arithmetic_noise_at_an_integer_device_edge_is_stabilized() {
        let scale = RasterScale::at_dpi(72.0);

        assert_eq!(scale.floor(11.999_999), Some(12));
        assert_eq!(scale.ceil(12.000_001), Some(12));
        assert_eq!(scale.floor(11.99), Some(11));
        assert_eq!(scale.ceil(12.01), Some(13));
    }

    #[test]
    fn invalid_or_empty_extents_have_no_sample_count() {
        let scale = RasterScale::at_dpi(300.0);

        assert_eq!(scale.sample_count(0.0), None);
        assert_eq!(scale.sample_count(-1.0), None);
        assert_eq!(scale.sample_count(f32::NAN), None);
        assert_eq!(scale.sample_count(0.01), Some(1));
    }
}
