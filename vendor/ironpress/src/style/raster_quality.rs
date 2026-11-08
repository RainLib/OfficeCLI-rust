//! Quality controls for raster fallbacks.
//!
//! A conversion owns one [`RasterQuality`] value. Style resolution receives that
//! value through its parent [`ComputedStyle`](crate::style::computed::ComputedStyle),
//! rather than consulting process or thread-local state.

use crate::util::RasterDimensions;

/// CSS defines 96 reference pixels per inch.
pub(crate) const CSS_REFERENCE_DPI: f32 = 96.0;
/// Default target resolution for embedded source images.
pub(crate) const DEFAULT_SOURCE_IMAGE_DPI: f32 = 300.0;
/// Default target resolution for render-time filter bitmaps.
///
/// This is the print-resolution baseline. Callers can lower it explicitly when
/// a smaller PDF is preferable and the resulting loss stays imperceptible.
pub(crate) const DEFAULT_FILTER_RASTER_DPI: f32 = 300.0;
/// Default target resolution for CSS mask coverage bitmaps.
///
/// High-contrast coverage edges are sensitive to resampling, so this starts at
/// the tested 300-DPI baseline. Callers can lower it explicitly when the
/// resulting difference remains imperceptible for their content.
pub(crate) const DEFAULT_MASK_RASTER_DPI: f32 = 300.0;
/// The default is the previous two-pixels-per-CSS-pixel quality expressed as a
/// physical resolution. It is the lowest tested baseline that keeps flattened
/// backgrounds within the visibility policy while avoiding needless image growth.
pub(crate) const DEFAULT_BACKGROUND_RASTER_DPI: f32 = 192.0;

/// Bounded JPEG quality used by renderer-owned smooth coverage masks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JpegCompression {
    quality: u8,
}

impl JpegCompression {
    /// Construct a JPEG policy from the conventional 0..=100 quality scale.
    pub const fn new(quality: u8) -> Self {
        Self {
            quality: if quality > 100 { 100 } else { quality },
        }
    }

    pub(crate) const fn quality(self) -> u8 {
        self.quality
    }
}

impl Default for JpegCompression {
    fn default() -> Self {
        // Chromium's Skia PDF backend uses this quantization for blurred
        // grayscale masks. Smooth low-frequency coverage remains visually
        // indistinguishable while compressing far better than lossless Flate.
        Self::new(50)
    }
}

/// Storage policy for renderer-owned smooth grayscale coverage.
///
/// This is distinct from source-image compression: callers can retain
/// lossless masks without changing authored PNG/JPEG handling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverageCompression {
    /// Preserve every generated coverage byte.
    Lossless,
    /// Use visually indistinguishable grayscale JPEG quantization.
    Jpeg(JpegCompression),
}

impl Default for CoverageCompression {
    fn default() -> Self {
        Self::Jpeg(JpegCompression::default())
    }
}

/// One conversion's raster-resolution contract. Grouping these related knobs
/// keeps PPI policy explicit instead of scattering independent scalar defaults
/// through the converter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RasterQuality {
    /// Target physical resolution for embedded source images.
    pub source_image_dpi: f32,
    /// Target physical resolution for render-time filter bitmaps.
    pub filter_dpi: f32,
    /// Target physical resolution for CSS mask coverage bitmaps.
    pub mask_dpi: f32,
    /// Target physical resolution for flattened synthetic backgrounds.
    pub background_dpi: f32,
    /// Compression for smooth renderer-owned blur coverage masks.
    pub blurred_coverage_compression: CoverageCompression,
}

impl Default for RasterQuality {
    fn default() -> Self {
        Self {
            source_image_dpi: DEFAULT_SOURCE_IMAGE_DPI,
            filter_dpi: DEFAULT_FILTER_RASTER_DPI,
            mask_dpi: DEFAULT_MASK_RASTER_DPI,
            background_dpi: DEFAULT_BACKGROUND_RASTER_DPI,
            blurred_coverage_compression: CoverageCompression::default(),
        }
    }
}

impl RasterQuality {
    pub(crate) fn normalized(self) -> Self {
        Self {
            source_image_dpi: raster_dpi_at_least(self.source_image_dpi, 72.0),
            filter_dpi: raster_dpi_at_least(self.filter_dpi, 1.0),
            mask_dpi: raster_dpi_at_least(self.mask_dpi, 72.0),
            background_dpi: raster_dpi_at_least(self.background_dpi, CSS_REFERENCE_DPI),
            blurred_coverage_compression: self.blurred_coverage_compression,
        }
    }
}

/// Reject non-finite resolution inputs and enforce a semantic lower bound.
pub(crate) fn raster_dpi_at_least(dpi: f32, minimum: f32) -> f32 {
    if dpi.is_finite() {
        dpi.max(minimum)
    } else {
        minimum
    }
}

fn raster_dimensions_at_dpi(
    width: f32,
    height: f32,
    dpi: f32,
    minimum_dpi: f32,
) -> Option<RasterDimensions> {
    let dpi = raster_dpi_at_least(dpi, minimum_dpi);
    RasterDimensions::scaled_points(width, height, dpi / CSS_REFERENCE_DPI)
}

/// Allocate a render-time filter bitmap from point extents at the requested
/// physical target resolution.
pub(crate) fn filter_raster_dimensions(
    width: f32,
    height: f32,
    dpi: f32,
) -> Option<RasterDimensions> {
    raster_dimensions_at_dpi(width, height, dpi, 1.0)
}

/// Allocate a CSS mask-coverage bitmap from point extents at the requested
/// physical target resolution.
pub(crate) fn mask_raster_dimensions(
    width: f32,
    height: f32,
    dpi: f32,
) -> Option<RasterDimensions> {
    let dpi = raster_dpi_at_least(dpi, 72.0);
    RasterDimensions::scaled_points_ceil(width, height, dpi / CSS_REFERENCE_DPI)
}

/// Allocate a flattened background bitmap from point extents at the requested
/// physical target resolution.
pub(crate) fn background_raster_dimensions(
    width: f32,
    height: f32,
    dpi: f32,
) -> Option<RasterDimensions> {
    raster_dimensions_at_dpi(width, height, dpi, CSS_REFERENCE_DPI)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLENDED_BACKGROUND: &str = r#"
        <style>
          @page { size: 224px 144px; margin: 0; }
          * { margin: 0; box-sizing: border-box; }
          .box {
            width: 220px;
            height: 140px;
            background-color: #fdd835;
            background-image:
              linear-gradient(to right, transparent 0 50%, #d32f2f 50% 100%),
              linear-gradient(to bottom, #1565c0 0 50%, transparent 50% 100%);
            background-blend-mode: multiply, screen;
          }
        </style>
        <div class="box"></div>
    "#;

    fn has_image_dimensions(pdf: &[u8], width: u32, height: u32) -> bool {
        let content = String::from_utf8_lossy(pdf);
        content.contains(&format!("/Subtype /Image /Width {width} /Height {height}"))
    }

    #[test]
    fn default_uses_the_tested_physical_background_baseline() {
        assert_eq!(
            background_raster_dimensions(72.0, 36.0, DEFAULT_BACKGROUND_RASTER_DPI),
            Some(RasterDimensions {
                width: 192,
                height: 96,
            })
        );
    }

    #[test]
    fn raster_quality_defaults_are_one_named_resolution_contract() {
        let quality = RasterQuality::default();
        assert_eq!(quality.source_image_dpi, DEFAULT_SOURCE_IMAGE_DPI);
        assert_eq!(quality.filter_dpi, DEFAULT_FILTER_RASTER_DPI);
        assert_eq!(quality.mask_dpi, DEFAULT_MASK_RASTER_DPI);
        assert_eq!(quality.background_dpi, DEFAULT_BACKGROUND_RASTER_DPI);
        assert_eq!(
            quality.blurred_coverage_compression,
            CoverageCompression::Jpeg(JpegCompression::new(50))
        );
    }

    #[test]
    fn non_finite_resolution_uses_the_semantic_minimum() {
        assert_eq!(raster_dpi_at_least(f32::NAN, 72.0), 72.0);
        assert_eq!(raster_dpi_at_least(f32::INFINITY, 96.0), 96.0);
        assert_eq!(raster_dpi_at_least(150.0, 96.0), 150.0);
    }

    #[test]
    fn dimensions_use_explicit_physical_dpi() {
        assert_eq!(
            background_raster_dimensions(72.0, 36.0, 300.0),
            Some(RasterDimensions {
                width: 300,
                height: 150,
            })
        );
    }

    #[test]
    fn mask_dimensions_use_coverage_preserving_rounding() {
        assert_eq!(
            mask_raster_dimensions(150.0, 150.0, DEFAULT_MASK_RASTER_DPI),
            Some(RasterDimensions {
                width: 625,
                height: 625,
            })
        );
        assert_eq!(
            mask_raster_dimensions(150.0, 150.0, 150.0),
            Some(RasterDimensions {
                width: 313,
                height: 313,
            })
        );
    }

    #[test]
    fn filters_share_one_configurable_physical_resolution_policy() {
        assert_eq!(
            filter_raster_dimensions(72.0, 36.0, DEFAULT_FILTER_RASTER_DPI),
            Some(RasterDimensions {
                width: 300,
                height: 150,
            })
        );
        assert_eq!(
            filter_raster_dimensions(72.0, 36.0, f32::NAN),
            Some(RasterDimensions {
                width: 1,
                height: 1,
            })
        );
    }

    #[test]
    fn converter_raster_quality_scales_flattened_background_images() {
        let at_css_dpi = crate::HtmlConverter::new()
            .raster_quality(RasterQuality {
                background_dpi: 96.0,
                ..RasterQuality::default()
            })
            .convert(BLENDED_BACKGROUND)
            .unwrap();
        let at_print_dpi = crate::HtmlConverter::new()
            .background_raster_dpi(300.0)
            .convert(BLENDED_BACKGROUND)
            .unwrap();

        assert!(has_image_dimensions(&at_css_dpi, 220, 140));
        assert!(has_image_dimensions(&at_print_dpi, 687, 437));
    }
}
