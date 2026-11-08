//! Raster source construction for CSS box and text shadows.

use super::*;
use crate::render::curves::{CurveTolerance, RoundedRectPath, TinySkiaCurveSink};
use crate::types::{Rect, Size, Vector};

/// A blurred shape's coverage, independent of the color painted through it.
///
/// Chromium's PDF backend preserves this separation for box shadows: a
/// DeviceGray soft mask carries geometric coverage while the authored color
/// and alpha remain native graphics state. Keeping the same representation
/// prevents low-alpha RGBA8 unpremultiplication from inventing color shifts.
pub(crate) struct BlurredCoverageMask {
    coverage: image::GrayImage,
    raster_clip: Option<RoundedCoverageClip>,
    pub(crate) overflow_pt: f32,
    filter_dpi: f32,
}

impl BlurredCoverageMask {
    pub(crate) const fn coverage(&self) -> &image::GrayImage {
        &self.coverage
    }

    pub(crate) fn raster_dimensions(&self) -> crate::util::RasterDimensions {
        crate::util::RasterDimensions {
            width: self.coverage.width(),
            height: self.coverage.height(),
        }
    }

    pub(crate) fn pixel_density(&self) -> crate::layout::engine::RasterPixelDensity {
        crate::layout::engine::RasterPixelDensity::from_dpi(self.filter_dpi)
    }

    /// Physical size of the quantized mask backing image.
    ///
    /// This deliberately comes from the raster dimensions rather than the
    /// unquantized source rectangle. PDF placement must preserve one device
    /// pixel per mask sample; stretching the mask back over an authored
    /// quarter-pixel remainder changes every blur sample's phase.
    pub(crate) fn raster_size_pt(&self) -> Size {
        let pt_per_pixel = 72.0 / self.filter_dpi;
        Size::new(
            self.coverage.width() as f32 * pt_per_pixel,
            self.coverage.height() as f32 * pt_per_pixel,
        )
    }

    pub(crate) fn tinted_raster(&self, color: (f32, f32, f32, f32)) -> Option<BlurredRaster> {
        let (red, green, blue, alpha) = color;
        if alpha <= 0.0 {
            return None;
        }
        let color = [
            quantize_color(red),
            quantize_color(green),
            quantize_color(blue),
        ];
        let alpha = quantize_color(alpha);
        let clipped_coverage = match self.raster_clip {
            Some(clip) => Some(clip.apply(self.coverage.clone())?),
            None => None,
        };
        let coverage = clipped_coverage.as_ref().unwrap_or(&self.coverage);
        let rgba = image::RgbaImage::from_fn(coverage.width(), coverage.height(), |x, y| {
            let coverage = coverage.get_pixel(x, y)[0];
            image::Rgba([
                color[0],
                color[1],
                color[2],
                multiply_coverage(coverage, alpha),
            ])
        });
        Some(BlurredRaster {
            asset: rgba_to_png_alpha_asset(rgba, self.filter_dpi)?,
            overflow_pt: self.overflow_pt,
        })
    }
}

fn quantize_color(component: f32) -> u8 {
    (component.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn multiply_coverage(coverage: u8, alpha: u8) -> u8 {
    ((u16::from(coverage) * u16::from(alpha) + 127) / 255) as u8
}

/// The two distinct margins used by Skia's PDF mask-filter path.
///
/// Skia first bounds the unblurred device-space caster using the mask
/// filter's untransformed sigma. It then applies the CTM-aware blur and grows
/// that source mask by the discrete kernel's device-space support. Collapsing
/// these into one generous source rectangle makes inset rings too opaque.
#[derive(Clone, Copy)]
struct InsetMaskBounds {
    source_margin_px: u32,
    blur_support_px: u32,
}

impl InsetMaskBounds {
    fn for_shadow(shadow: &BoxShadow, blur: CoverageBlurKernel) -> Option<Self> {
        let authored_sigma_px = shadow.blur / PT_PER_PX / 2.0;
        let source_margin_px = CoverageBlurKernel::from_sigma(authored_sigma_px)?.support_px;
        Some(Self {
            source_margin_px,
            blur_support_px: blur.support_px,
        })
    }

    fn raster_padding_px(self) -> Option<u32> {
        self.source_margin_px.checked_add(self.blur_support_px)
    }

    fn source_bounds(self, box_rect: Rect) -> Rect {
        box_rect.outset(EdgeSizes::uniform(self.source_margin_px as f32))
    }
}

/// Rasterize and blur a rounded `box-shadow` coverage mask.
pub(crate) fn blur_shadow_mask(
    width_pt: f32,
    height_pt: f32,
    radii: CornerRadii,
    shadow: &BoxShadow,
    filter_dpi: f32,
) -> Option<BlurredCoverageMask> {
    if width_pt <= 0.0 || height_pt <= 0.0 || shadow.color.alpha() <= 0.0 {
        return None;
    }

    use resvg::tiny_skia;

    let s = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let sigma = (shadow.blur / PT_PER_PX) * s / 2.0;
    let kernel = CoverageBlurKernel::from_sigma(sigma)?;
    let pad = kernel.padding_px;
    let box_x = filter_raster_axis(width_pt, s)?;
    let box_y = filter_raster_axis(height_pt, s)?;
    let buf_w = padded_pixels(box_x.pixels, pad)?;
    let buf_h = padded_pixels(box_y.pixels, pad)?;

    let mut pixmap = tiny_skia::Pixmap::new(buf_w, buf_h)?;
    let ox = pad as f32;
    let oy = pad as f32;

    let mut paint = tiny_skia::Paint::default();
    paint.set_color(tiny_skia::Color::WHITE);
    paint.anti_alias = true;

    let radii_px = radii.fit_to(width_pt, height_pt) * (s / PT_PER_PX);
    if !radii_px.is_zero() {
        let mut path = tiny_skia::PathBuilder::new();
        append_rounded_box_path(&mut path, ox, oy, box_x.paint_px, box_y.paint_px, radii_px);
        if let Some(path) = path.finish() {
            pixmap.fill_path(
                &path,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            );
        }
    } else if let Some(rect) = tiny_skia::Rect::from_xywh(ox, oy, box_x.paint_px, box_y.paint_px) {
        pixmap.fill_rect(rect, &paint, tiny_skia::Transform::identity(), None);
    }

    let coverage = crate::render::raster_pixels::pixmap_to_alpha_mask(&pixmap);
    let coverage = blur_coverage(coverage, kernel)?;
    let overflow_pt = pad as f32 / s * PT_PER_PX;
    Some(BlurredCoverageMask {
        coverage,
        raster_clip: None,
        overflow_pt,
        filter_dpi,
    })
}

pub(crate) fn blur_inset_shadow_mask(
    width_pt: f32,
    height_pt: f32,
    radii: CornerRadii,
    shadow: &BoxShadow,
    filter_dpi: f32,
) -> Option<BlurredCoverageMask> {
    if width_pt <= 0.0 || height_pt <= 0.0 || shadow.color.alpha() <= 0.0 {
        return None;
    }

    use resvg::tiny_skia;

    let s = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let sigma = (shadow.blur / PT_PER_PX) * s / 2.0;
    let kernel = CoverageBlurKernel::from_sigma(sigma)?;
    let bounds = InsetMaskBounds::for_shadow(shadow, kernel)?;
    let pad = bounds.raster_padding_px()?;
    let box_x = filter_raster_axis(width_pt, s)?;
    let box_y = filter_raster_axis(height_pt, s)?;
    let buf_w = padded_pixels(box_x.pixels, pad)?;
    let buf_h = padded_pixels(box_y.pixels, pad)?;

    let mut pixmap = tiny_skia::Pixmap::new(buf_w, buf_h)?;
    let mut paint = tiny_skia::Paint::default();
    paint.set_color(tiny_skia::Color::WHITE);
    paint.anti_alias = true;

    let pt_to_px = s / PT_PER_PX;
    let spread_px = shadow.spread * pt_to_px;
    let offset = Vector::new(shadow.offset_x * pt_to_px, shadow.offset_y * pt_to_px);
    let box_rect = Rect::from_xywh(pad as f32, pad as f32, box_x.paint_px, box_y.paint_px);
    let source_bounds = bounds.source_bounds(box_rect);
    let caster_outset = shadow.blur * pt_to_px + (-shadow.spread).max(0.0) * pt_to_px;
    let caster = box_rect
        .outset(EdgeSizes::uniform(caster_outset))
        .union(
            box_rect
                .outset(EdgeSizes::uniform(caster_outset))
                .translate(offset),
        )
        .intersection(source_bounds)?;
    let hole = box_rect
        .translate(offset)
        .inset(EdgeSizes::uniform(spread_px));
    let mut path = tiny_skia::PathBuilder::new();
    RoundedRectPath::new(caster, CornerRadii::ZERO).write_to(
        &mut TinySkiaCurveSink::new(&mut path),
        CurveTolerance::RASTER_PIXEL,
    );
    if hole.size.width > 0.0 && hole.size.height > 0.0 {
        let hole_radii = radii.grow(-shadow.spread) * pt_to_px;
        RoundedRectPath::new(hole, hole_radii).write_to(
            &mut TinySkiaCurveSink::new(&mut path),
            CurveTolerance::RASTER_PIXEL,
        );
    }
    if let Some(path) = path.finish() {
        pixmap.fill_path(
            &path,
            &paint,
            tiny_skia::FillRule::EvenOdd,
            tiny_skia::Transform::identity(),
            None,
        );
    }

    let coverage = crate::render::raster_pixels::pixmap_to_alpha_mask(&pixmap);
    let coverage = blur_coverage(coverage, kernel)?;
    let overflow_pt = pad as f32 / s * PT_PER_PX;
    Some(BlurredCoverageMask {
        coverage,
        raster_clip: Some(RoundedCoverageClip {
            rect: box_rect,
            radii: radii * pt_to_px,
        }),
        overflow_pt,
        filter_dpi,
    })
}

fn blur_coverage(
    coverage: image::GrayImage,
    kernel: CoverageBlurKernel,
) -> Option<image::GrayImage> {
    let encoded = image::RgbaImage::from_fn(coverage.width(), coverage.height(), |x, y| {
        let value = coverage.get_pixel(x, y)[0];
        image::Rgba([value, value, value, value])
    });
    let blurred = kernel.blur(&encoded)?;
    Some(image::GrayImage::from_fn(
        blurred.width(),
        blurred.height(),
        |x, y| image::Luma([blurred.get_pixel(x, y)[3]]),
    ))
}

#[derive(Clone, Copy)]
struct RoundedCoverageClip {
    rect: Rect,
    radii: CornerRadii,
}

impl RoundedCoverageClip {
    fn apply(self, mut coverage: image::GrayImage) -> Option<image::GrayImage> {
        use resvg::tiny_skia;

        let mut mask = tiny_skia::Pixmap::new(coverage.width(), coverage.height())?;
        let mut path = tiny_skia::PathBuilder::new();
        RoundedRectPath::new(self.rect, self.radii).write_to(
            &mut TinySkiaCurveSink::new(&mut path),
            CurveTolerance::RASTER_PIXEL,
        );
        let path = path.finish()?;
        let mut paint = tiny_skia::Paint::default();
        paint.set_color(tiny_skia::Color::WHITE);
        paint.anti_alias = true;
        mask.fill_path(
            &path,
            &paint,
            tiny_skia::FillRule::Winding,
            tiny_skia::Transform::identity(),
            None,
        );
        for (index, pixel) in coverage.pixels_mut().enumerate() {
            let mask_alpha = u16::from(mask.pixels()[index].alpha());
            pixel[0] = multiply_coverage(pixel[0], mask_alpha as u8);
        }
        Some(coverage)
    }
}

fn append_rounded_box_path(
    path: &mut resvg::tiny_skia::PathBuilder,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radii: CornerRadii,
) {
    RoundedRectPath::new(Rect::from_xywh(x, y, width, height), radii).write_to(
        &mut TinySkiaCurveSink::new(path),
        CurveTolerance::RASTER_PIXEL,
    );
}

/// Blur a pre-rasterized straight-alpha glyph coverage mask and tint it.
pub(crate) fn blur_shadow_alpha_mask(
    mask: &image::GrayImage,
    blur_pt: f32,
    color: (f32, f32, f32, f32),
    filter_dpi: f32,
) -> Option<(BlurredRaster, u32)> {
    let (width, height) = mask.dimensions();
    let (red, green, blue, alpha) = color;
    if width == 0 || height == 0 || alpha <= 0.0 {
        return None;
    }

    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let sigma = (blur_pt / PT_PER_PX) * scale / 2.0;
    let kernel = CoverageBlurKernel::from_sigma(sigma)?;
    let padding = kernel.padding_px;
    let buffer_width = padded_pixels(width, padding)?;
    let buffer_height = padded_pixels(height, padding)?;
    let mut padded = image::GrayImage::new(buffer_width, buffer_height);
    let mut painted = false;
    for y in 0..height {
        for x in 0..width {
            let coverage = mask.get_pixel(x, y)[0];
            if coverage == 0 {
                continue;
            }
            painted = true;
            padded.put_pixel(x + padding, y + padding, image::Luma([coverage]));
        }
    }
    if !painted {
        return None;
    }
    let coverage = blur_coverage(padded, kernel)?;
    let overflow_pt = padding as f32 / scale * PT_PER_PX;
    let blurred = BlurredCoverageMask {
        coverage,
        raster_clip: None,
        overflow_pt,
        filter_dpi,
    }
    .tinted_raster((red, green, blue, alpha))?;
    Some((blurred, padding))
}

#[cfg(test)]
mod tests;
