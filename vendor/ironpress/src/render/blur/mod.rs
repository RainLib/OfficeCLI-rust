//! CSS `filter: blur()` and `filter: drop-shadow()` raster compositing.
//!
//! ironpress paints boxes and replaced images as vector content. The CSS
//! `filter` property (css-filter-effects-1 §2) instead operates on the
//! *rasterized* output of the element: a gaussian blur (or drop-shadow) is
//! applied to the painted pixels and feathers *outside* the element's border
//! box. We rasterize the element's paint into a pixel buffer
//! padded with transparency, blur it with the same discrete three-box
//! approximation used by Chromium's Skia path at practical filter sizes, and
//! embed the result as a PDF image XObject positioned so the padded buffer
//! feathers beyond the original box.
//!
//! Per css-filter-effects-1 §4.1, `blur(<length>)` uses a gaussian with
//! `stdDeviation` equal to that length. `filter_dpi` controls only the sampling
//! resolution of the embedded bitmap; PDF placement remains in authored points.

use crate::layout::engine::{ImageFormat, LayoutBorder, RasterImageAsset};
use crate::parser::ttf::TtfFont;
use crate::render::raster_scale::RasterScale;
use crate::style::computed::{BoxShadow, DropShadow, ImageRendering};
use crate::types::{CornerRadii, EdgeSizes};

mod box_shadows;
mod boxes;
mod discrete;
mod drop_shadow;
mod glyphs;
mod images;
mod surface;
mod svg;

pub(crate) use box_shadows::{
    BlurredCoverageMask, blur_inset_shadow_mask, blur_shadow_alpha_mask, blur_shadow_mask,
};
pub(crate) use boxes::blur_box;
use discrete::{DiscreteGaussianPlan, box_blur_axes};
pub(crate) use drop_shadow::drop_shadow_surface;
pub(crate) use glyphs::{
    GlyphBaselineOrigin, GlyphRaster, GlyphRasterRequest, GlyphRasterStyle, RasterBaselineAdvance,
    RasterBaselineCursor, rasterize_run_alpha,
};
pub(crate) use images::{pixelated_image_at_css_size, rasterize_image_buffer};
pub(crate) use surface::{blur_painted_buffer, blur_premultiplied_buffer};
pub(crate) use svg::{SvgTurbulenceDisplacement, turbulence_displacement_rect};

/// Points per CSS pixel (1px = 0.75pt). `blur_radius` is stored in points.
const PT_PER_PX: f32 = 0.75;
/// Maximum device-pixel shortfall treated as arithmetic noise at a half-pixel
/// raster boundary.
const FILTER_RASTER_HALF_PIXEL_TOLERANCE: f64 = 0.01;

/// One authored filter extent represented both by the backing-pixel bound and
/// the unquantized paint extent within that bound.
#[derive(Clone, Copy)]
struct FilterRasterAxis {
    pixels: u32,
    paint_px: f32,
}

/// Quantize a positive authored point length for a filter backing image.
///
/// CSS dimensions commonly land exactly on half a device pixel (for example,
/// 140 CSS px at 300 DPI). Layout's `f32` arithmetic can represent that as a
/// less than one hundredth of a device pixel below the half and round it down. Resolve
/// only that floating-point tie noise so the raster's coverage has the same
/// authored dimensions as its vector placement.
fn filter_raster_axis(points: f32, scale: f32) -> Option<FilterRasterAxis> {
    let pixels = f64::from(points) / f64::from(PT_PER_PX) * f64::from(scale);
    Some(FilterRasterAxis {
        pixels: quantize_filter_raster_pixels(pixels)?,
        paint_px: pixels as f32,
    })
}

fn quantize_filter_raster_pixels(pixels: f64) -> Option<u32> {
    if !pixels.is_finite() || pixels <= 0.0 {
        return None;
    }
    let rounded = (pixels + 0.5 + FILTER_RASTER_HALF_PIXEL_TOLERANCE).floor();
    (rounded <= f64::from(u32::MAX)).then_some(rounded as u32)
}

fn filter_raster_pixels(points: f32, scale: f32) -> Option<u32> {
    Some(filter_raster_axis(points, scale)?.pixels)
}

/// A blurred raster ready for embedding plus the overflow it adds outside the
/// element's border box (in points, applied symmetrically on every side).
pub(crate) struct BlurredRaster {
    pub asset: RasterImageAsset,
    /// Extra paint extent beyond each border-box edge, in points.
    pub overflow_pt: f32,
}

/// Device-quantized paint overflow of a blurred CSS box shadow.
///
/// Box-shadow uses half the authored blur radius as its gaussian sigma. Keep
/// this calculation beside the shadow rasterizer so source-graphic allocation
/// and actual shadow painting cannot disagree about the required padding.
pub(crate) fn box_shadow_blur_overflow(blur_radius_pt: f32, filter_dpi: f32) -> Option<f32> {
    if blur_radius_pt <= 0.0 {
        return Some(0.0);
    }
    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let sigma = (blur_radius_pt / PT_PER_PX) * scale / 2.0;
    let padding = pad_pixels(sigma)?;
    Some(padding as f32 / scale * PT_PER_PX)
}

/// Number of padding pixels to add on each side so a gaussian with the given
/// sigma can feather without clipping (3σ captures ~99.7% of the kernel).
fn pad_pixels(sigma: f32) -> Option<u32> {
    if !sigma.is_finite() || sigma < 0.0 {
        return None;
    }
    let pixels = (f64::from(sigma) * 3.0).ceil().max(1.0);
    (pixels <= f64::from(u32::MAX)).then_some(pixels as u32)
}

/// A blur kernel and the exact backing-image support needed for antialiased
/// coverage masks.
///
/// CSS layout overflow remains conservative at three sigma. The embedded mask
/// itself instead uses the finite support of the selected discrete kernel plus
/// one source-coverage pixel for vector antialiasing. Keeping those quantities
/// distinct avoids scaling a larger transparent bitmap into the same PDF
/// placement and thereby changing the mask's sampling phase.
#[derive(Clone, Copy)]
struct CoverageBlurKernel {
    support_px: u32,
    padding_px: u32,
    sampling: FilterBlurSampling,
}

impl CoverageBlurKernel {
    fn from_sigma(sigma_px: f32) -> Option<Self> {
        if !sigma_px.is_normal() || sigma_px <= 0.0 {
            return None;
        }
        let sampling = match DiscreteGaussianPlan::from_sigma(sigma_px) {
            Some(plan) => FilterBlurSampling::ThreeBox(plan),
            None => FilterBlurSampling::SmallGaussian { sigma_px },
        };
        let support_px = match sampling {
            FilterBlurSampling::ThreeBox(plan) => plan.support_radius(),
            FilterBlurSampling::SmallGaussian { sigma_px } => pad_pixels(sigma_px)?,
        };
        let padding_px = support_px.checked_add(1)?;
        Some(Self {
            support_px,
            padding_px,
            sampling,
        })
    }

    fn blur(self, premultiplied: &image::RgbaImage) -> Option<image::RgbaImage> {
        match self.sampling {
            FilterBlurSampling::SmallGaussian { sigma_px } => {
                Some(image::imageops::blur(premultiplied, sigma_px))
            }
            FilterBlurSampling::ThreeBox(plan) => box_blur_axes(premultiplied, plan),
        }
    }
}

fn padded_pixels(content_pixels: u32, padding_pixels: u32) -> Option<u32> {
    content_pixels.checked_add(padding_pixels.checked_mul(2)?)
}

fn nonnegative_pixel_ceil(value: f32) -> Option<u32> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let pixels = f64::from(value).ceil();
    (pixels <= f64::from(u32::MAX)).then_some(pixels as u32)
}

/// The sampling method used for one CSS filter blur.
#[derive(Clone, Copy, Debug)]
enum FilterBlurSampling {
    SmallGaussian { sigma_px: f32 },
    ThreeBox(DiscreteGaussianPlan),
}

/// A CSS filter blur expressed in the pixels of its raster backing image.
#[derive(Clone, Copy)]
pub(crate) struct FilterBlurKernel {
    pub padding_px: u32,
    sampling: FilterBlurSampling,
}

impl FilterBlurKernel {
    pub(crate) fn new(blur_radius_pt: f32, filter_dpi: f32) -> Option<Self> {
        let nominal_sigma =
            blur_radius_pt / PT_PER_PX * RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
        if !nominal_sigma.is_normal() || nominal_sigma <= 0.0 {
            return None;
        }
        let sampling = DiscreteGaussianPlan::from_sigma(nominal_sigma)
            .map(FilterBlurSampling::ThreeBox)
            .unwrap_or(FilterBlurSampling::SmallGaussian {
                sigma_px: nominal_sigma,
            });
        Some(Self {
            padding_px: pad_pixels(nominal_sigma)?,
            sampling,
        })
    }
}

/// Blur a CSS filter buffer with its discrete sampling plan.
pub(crate) fn blur_css_filter(
    img: &image::RgbaImage,
    kernel: FilterBlurKernel,
) -> Option<image::RgbaImage> {
    let premultiplied = crate::render::raster_pixels::premultiply_rgba8(img);
    let blurred = blur_css_filter_premultiplied(&premultiplied, kernel)?;
    Some(crate::render::raster_pixels::unpremultiply_rgba8(&blurred))
}

/// Blur an already-premultiplied CSS filter buffer and preserve that encoding.
///
/// Vector paint sources from tiny-skia are premultiplied already. Keeping them
/// that way avoids throwing away low-alpha colour precision before filtering.
fn blur_css_filter_premultiplied(
    premultiplied: &image::RgbaImage,
    kernel: FilterBlurKernel,
) -> Option<image::RgbaImage> {
    match kernel.sampling {
        FilterBlurSampling::SmallGaussian { sigma_px } => {
            Some(image::imageops::blur(premultiplied, sigma_px))
        }
        FilterBlurSampling::ThreeBox(plan) => box_blur_axes(premultiplied, plan),
    }
}

/// Encode a (possibly padded) RGBA buffer as a full PNG file and wrap it in a
/// `PngAlpha` asset, whose embedding path decodes colour + soft-mask so the
/// transparent feathered border survives into the PDF.
pub(crate) fn rgba_to_png_alpha_asset(
    img: image::RgbaImage,
    filter_dpi: f32,
) -> Option<RasterImageAsset> {
    let (width, height) = (img.width(), img.height());
    let mut encoded = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .ok()?;
    Some(RasterImageAsset::rendered(
        encoded,
        width,
        height,
        ImageFormat::PngAlpha,
        None,
        filter_dpi,
    ))
}

/// Convert an `f32` 0..1 RGBA to a tiny-skia non-premultiplied `Color`.
fn color8(r: f32, g: f32, b: f32, a: f32) -> resvg::tiny_skia::Color {
    resvg::tiny_skia::Color::from_rgba(
        r.clamp(0.0, 1.0),
        g.clamp(0.0, 1.0),
        b.clamp(0.0, 1.0),
        a.clamp(0.0, 1.0),
    )
    .unwrap_or(resvg::tiny_skia::Color::TRANSPARENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixelated_css_scaling_keeps_a_natural_size_image_unmodified() {
        let source = image::RgbaImage::from_raw(2, 1, vec![0, 0, 0, 255, 255, 255, 255, 255])
            .expect("test image dimensions are valid");

        let scaled = pixelated_image_at_css_size(&source, 2.0 * PT_PER_PX, PT_PER_PX)
            .expect("positive CSS image size should rasterize");

        assert_eq!(scaled, source);
    }

    #[test]
    fn pixelated_css_scaling_smooths_only_after_the_integer_stage() {
        let source = image::RgbaImage::from_raw(2, 1, vec![0, 0, 0, 255, 255, 255, 255, 255])
            .expect("test image dimensions are valid");

        let scaled = pixelated_image_at_css_size(&source, 5.0 * PT_PER_PX, PT_PER_PX)
            .expect("positive CSS image size should rasterize");

        assert_eq!(scaled.dimensions(), (5, 1));
        assert_eq!(scaled.get_pixel(0, 0)[0], 0);
        assert_eq!(scaled.get_pixel(4, 0)[0], 255);
        assert!(
            (0..255).contains(&scaled.get_pixel(2, 0)[0]),
            "the non-integer remainder should be smoothly resampled"
        );
    }

    #[test]
    fn pixelated_css_scaling_preserves_an_integral_alpha_boundary() {
        let source = image::RgbaImage::from_fn(64, 64, |x, y| {
            if (4..60).contains(&x) && (4..60).contains(&y) {
                image::Rgba([220, 40, 40, 255])
            } else {
                image::Rgba([220, 40, 40, 0])
            }
        });

        let scaled = pixelated_image_at_css_size(&source, 160.0 * PT_PER_PX, 160.0 * PT_PER_PX)
            .expect("positive CSS image size should rasterize");
        let alpha_bounds = scaled
            .enumerate_pixels()
            .filter_map(|(x, y, pixel)| (pixel[3] != 0).then_some((x, y)))
            .fold(
                None::<(u32, u32, u32, u32)>,
                |bounds, (x, y)| match bounds {
                    Some((left, top, right, bottom)) => {
                        Some((left.min(x), top.min(y), right.max(x), bottom.max(y)))
                    }
                    None => Some((x, y, x, y)),
                },
            );

        assert_eq!(alpha_bounds, Some((10, 10, 149, 149)));
    }

    #[test]
    fn filter_raster_pixel_rounding_ignores_half_pixel_float_noise() {
        assert_eq!(filter_raster_pixels(105.0, 3.125), Some(438));
        assert_eq!(filter_raster_pixels(104.999_99, 3.125), Some(438));
        assert_eq!(filter_raster_pixels(104.997, 3.125), Some(437));
    }

    #[test]
    fn filter_raster_axis_keeps_fractional_paint_extent_inside_rounded_backing() {
        let axis = filter_raster_axis(135.0, 3.125).expect("finite positive extent");
        assert_eq!(axis.pixels, 563);
        assert_eq!(axis.paint_px, 562.5);
    }

    #[test]
    fn blur_buffer_dimensions_reject_overflow() {
        assert_eq!(padded_pixels(u32::MAX, 1), None);
        assert_eq!(pad_pixels(f32::INFINITY), None);
        assert_eq!(nonnegative_pixel_ceil(f32::NAN), None);
    }

    #[test]
    fn css_filter_kernel_keeps_authored_overflow_and_selects_three_boxes() {
        let kernel = FilterBlurKernel::new(4.5, 300.0).unwrap();
        assert_eq!(kernel.padding_px, 57); // 3 × 6 CSS px × 300 / 96.
        let FilterBlurSampling::ThreeBox(plan) = kernel.sampling else {
            panic!("broad CSS blur should use the bounded integer plan");
        };
        assert_eq!(plan.pass_widths(), [35, 35, 35]);
    }

    #[test]
    fn css_filter_kernel_rejects_non_finite_input() {
        assert!(FilterBlurKernel::new(f32::INFINITY, 300.0).is_none());
        assert!(FilterBlurKernel::new(4.5, f32::NAN).is_some());
    }

    #[test]
    fn broad_antialiased_mask_uses_finite_kernel_support_plus_source_fringe() {
        let kernel =
            CoverageBlurKernel::from_sigma(28.125).expect("finite broad sigma has a kernel");
        let FilterBlurSampling::ThreeBox(plan) = kernel.sampling else {
            panic!("broad mask blur should use the bounded integer plan");
        };

        assert_eq!(plan.pass_widths(), [53, 53, 53]);
        assert_eq!(plan.support_radius(), 78);
        assert_eq!(kernel.padding_px, 79);
    }

    #[test]
    fn discrete_gaussian_matches_chromium_pdf_alpha_profile() {
        let plan = DiscreteGaussianPlan::from_sigma(15.625).expect("finite sigma has a plan");
        assert_eq!(plan.pass_widths(), [29, 29, 29]);

        let mut source = image::RgbaImage::new(594, 594);
        for y in 47..547 {
            for x in 47..547 {
                source.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
            }
        }
        let blurred =
            box_blur_axes(&source, plan).expect("valid image and plan produce a blurred image");
        let expected = [
            (10, 1),
            (15, 3),
            (20, 9),
            (25, 19),
            (30, 34),
            (35, 57),
            (40, 86),
            (45, 118),
            (46, 124),
            (47, 131),
            (48, 137),
            (50, 150),
        ];
        for (x, alpha) in expected {
            assert_eq!(blurred.get_pixel(x, 300)[3], alpha, "x={x}");
        }
    }
}
