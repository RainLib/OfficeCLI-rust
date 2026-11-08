//! Lossless conversions between straight-alpha image buffers and tiny-skia's
//! premultiplied paint surfaces.

use resvg::tiny_skia;

/// An RGBA8 surface whose colour channels are already multiplied by alpha.
///
/// CSS filter primitives consume premultiplied SourceGraphic samples. Keeping
/// that encoding in the type prevents an operation from accidentally treating
/// edge coverage as an independent straight-alpha colour.
#[derive(Clone)]
pub(crate) struct PremultipliedRgba8 {
    pixels: image::RgbaImage,
}

/// Device-space compositor state for one already-isolated CSS paint group.
///
/// The authored affine matrix is converted to raster samples exactly once at
/// construction. Linear terms are unitless; only translation scales with the
/// configured physical pixel density.
#[derive(Clone, Copy)]
pub(crate) struct RasterGroupCompositing {
    transform: tiny_skia::Transform,
    opacity: f32,
    blend_mode: tiny_skia::BlendMode,
}

impl RasterGroupCompositing {
    pub(crate) fn from_css(
        transform: crate::style::computed::CssAffineMatrix,
        opacity: f32,
        blend_mode: crate::style::computed::BlendMode,
        pixels_per_point: f32,
    ) -> Self {
        let [a, b, c, d, e, f] = transform.components();
        Self {
            transform: tiny_skia::Transform::from_row(
                a as f32,
                b as f32,
                c as f32,
                d as f32,
                (e * f64::from(pixels_per_point)) as f32,
                (f * f64::from(pixels_per_point)) as f32,
            ),
            opacity: opacity.clamp(0.0, 1.0),
            blend_mode: tiny_skia_blend_mode(blend_mode),
        }
    }
}

impl PremultipliedRgba8 {
    pub(crate) fn transparent(width: u32, height: u32) -> Self {
        Self {
            pixels: image::RgbaImage::new(width, height),
        }
    }

    pub(crate) fn from_straight(image: &image::RgbaImage) -> Self {
        let mut pixels = image.clone();
        for pixel in pixels.pixels_mut() {
            let alpha = pixel[3];
            for channel in &mut pixel.0[..3] {
                *channel = premultiply_channel(*channel, alpha);
            }
        }
        Self { pixels }
    }

    pub(crate) fn from_encoded(pixels: image::RgbaImage) -> Self {
        Self { pixels }
    }

    pub(crate) const fn as_image(&self) -> &image::RgbaImage {
        &self.pixels
    }

    pub(crate) fn as_image_mut(&mut self) -> &mut image::RgbaImage {
        &mut self.pixels
    }

    pub(crate) fn dimensions(&self) -> (u32, u32) {
        self.pixels.dimensions()
    }

    pub(crate) fn width(&self) -> u32 {
        self.pixels.width()
    }

    pub(crate) fn height(&self) -> u32 {
        self.pixels.height()
    }

    pub(crate) fn get_pixel(&self, x: u32, y: u32) -> &image::Rgba<u8> {
        self.pixels.get_pixel(x, y)
    }

    #[cfg(test)]
    pub(crate) fn pixels(&self) -> impl Iterator<Item = &image::Rgba<u8>> {
        self.pixels.pixels()
    }

    pub(crate) fn into_straight(mut self) -> image::RgbaImage {
        for pixel in self.pixels.pixels_mut() {
            let alpha = pixel[3];
            for channel in &mut pixel.0[..3] {
                *channel = unpremultiply_channel(*channel, alpha);
            }
        }
        self.pixels
    }

    /// Transform straight colour values while retaining a premultiplied
    /// physical surface between filter primitives.
    pub(crate) fn map_straight(
        &mut self,
        mut map: impl FnMut((f32, f32, f32, f32)) -> (f32, f32, f32, f32),
    ) {
        for pixel in self.pixels.pixels_mut() {
            let alpha = f32::from(pixel[3]) / 255.0;
            let straight = if alpha > 0.0 {
                (
                    f32::from(pixel[0]) / 255.0 / alpha,
                    f32::from(pixel[1]) / 255.0 / alpha,
                    f32::from(pixel[2]) / 255.0 / alpha,
                    alpha,
                )
            } else {
                (0.0, 0.0, 0.0, 0.0)
            };
            let (red, green, blue, alpha) = map(straight);
            let alpha = alpha.clamp(0.0, 1.0);
            let quantize = |component: f32| {
                (component.clamp(0.0, 1.0) * alpha * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8
            };
            *pixel = image::Rgba([
                quantize(red),
                quantize(green),
                quantize(blue),
                (alpha * 255.0).round().clamp(0.0, 255.0) as u8,
            ]);
        }
    }

    /// Composite another premultiplied surface over this one at an integer
    /// device-space origin.
    pub(crate) fn composite_over(&mut self, source: &Self, origin: DevicePixelPoint) -> Option<()> {
        let target_width = i64::from(self.width());
        let target_height = i64::from(self.height());
        for (source_x, source_y, source_pixel) in source.pixels.enumerate_pixels() {
            let target_x = i64::from(origin.x).checked_add(i64::from(source_x))?;
            let target_y = i64::from(origin.y).checked_add(i64::from(source_y))?;
            if target_x < 0 || target_y < 0 || target_x >= target_width || target_y >= target_height
            {
                continue;
            }
            let target = self
                .pixels
                .get_pixel_mut(u32::try_from(target_x).ok()?, u32::try_from(target_y).ok()?);
            *target = premultiplied_source_over(*source_pixel, *target);
        }
        Some(())
    }

    /// Composite a same-coordinate isolated group through one CSS affine
    /// transform. Both surfaces remain premultiplied throughout the operation.
    pub(crate) fn composite_group(
        &mut self,
        source: &Self,
        compositing: RasterGroupCompositing,
    ) -> Option<()> {
        let source = tiny_skia::PixmapRef::from_bytes(
            source.pixels.as_raw(),
            source.width(),
            source.height(),
        )?;
        let width = self.width();
        let height = self.height();
        let mut target = tiny_skia::PixmapMut::from_bytes(self.pixels.as_mut(), width, height)?;
        target.draw_pixmap(
            0,
            0,
            source,
            &tiny_skia::PixmapPaint {
                opacity: compositing.opacity,
                blend_mode: compositing.blend_mode,
                quality: tiny_skia::FilterQuality::Bilinear,
            },
            compositing.transform,
            None,
        );
        Some(())
    }
}

fn tiny_skia_blend_mode(mode: crate::style::computed::BlendMode) -> tiny_skia::BlendMode {
    use crate::style::computed::BlendMode;
    match mode {
        BlendMode::Normal | BlendMode::BackgroundList { .. } => tiny_skia::BlendMode::SourceOver,
        BlendMode::Multiply => tiny_skia::BlendMode::Multiply,
        BlendMode::Screen => tiny_skia::BlendMode::Screen,
        BlendMode::Overlay => tiny_skia::BlendMode::Overlay,
        BlendMode::Darken => tiny_skia::BlendMode::Darken,
        BlendMode::Lighten => tiny_skia::BlendMode::Lighten,
        BlendMode::ColorDodge => tiny_skia::BlendMode::ColorDodge,
        BlendMode::ColorBurn => tiny_skia::BlendMode::ColorBurn,
        BlendMode::HardLight => tiny_skia::BlendMode::HardLight,
        BlendMode::SoftLight => tiny_skia::BlendMode::SoftLight,
        BlendMode::Difference => tiny_skia::BlendMode::Difference,
        BlendMode::Exclusion => tiny_skia::BlendMode::Exclusion,
        BlendMode::Hue => tiny_skia::BlendMode::Hue,
        BlendMode::Saturation => tiny_skia::BlendMode::Saturation,
        BlendMode::Color => tiny_skia::BlendMode::Color,
        BlendMode::Luminosity => tiny_skia::BlendMode::Luminosity,
    }
}

fn premultiplied_source_over(
    source: image::Rgba<u8>,
    destination: image::Rgba<u8>,
) -> image::Rgba<u8> {
    let inverse_source_alpha = u16::from(u8::MAX - source[3]);
    image::Rgba(std::array::from_fn(|channel| {
        let retained = (u16::from(destination[channel]) * inverse_source_alpha + 127) / 255;
        u16::from(source[channel])
            .saturating_add(retained)
            .min(u16::from(u8::MAX)) as u8
    }))
}

/// One integer sample location in a physical raster surface.
///
/// Keeping this distinct from authored [`crate::types::Point`] coordinates
/// prevents point-space positions from being rounded independently at call
/// sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DevicePixelPoint {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

impl DevicePixelPoint {
    pub(crate) const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

/// A fractional vector measured in physical raster samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DevicePixelVector {
    pub(crate) x: f32,
    pub(crate) y: f32,
}

impl DevicePixelVector {
    pub(crate) const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

pub(crate) fn rgba_to_pixmap(image: &image::RgbaImage) -> Option<tiny_skia::Pixmap> {
    let mut pixmap = tiny_skia::Pixmap::new(image.width(), image.height())?;
    for (destination, source) in pixmap.pixels_mut().iter_mut().zip(image.pixels()) {
        *destination =
            tiny_skia::ColorU8::from_rgba(source[0], source[1], source[2], source[3]).premultiply();
    }
    Some(pixmap)
}

/// Convert a tiny-skia premultiplied surface into straight-alpha RGBA.
pub(crate) fn pixmap_to_rgba(pixmap: &tiny_skia::Pixmap) -> image::RgbaImage {
    image::RgbaImage::from_fn(pixmap.width(), pixmap.height(), |x, y| {
        let index = y as usize * pixmap.width() as usize + x as usize;
        let color = pixmap.pixels()[index].demultiply();
        image::Rgba([color.red(), color.green(), color.blue(), color.alpha()])
    })
}

/// Retain tiny-skia's premultiplication for consumers which explicitly expect
/// a premultiplied filter input.
pub(crate) fn pixmap_to_premultiplied_rgba(pixmap: &tiny_skia::Pixmap) -> image::RgbaImage {
    image::RgbaImage::from_fn(pixmap.width(), pixmap.height(), |x, y| {
        let index = y as usize * pixmap.width() as usize + x as usize;
        let color = pixmap.pixels()[index];
        image::Rgba([color.red(), color.green(), color.blue(), color.alpha()])
    })
}

/// Extract coverage without introducing meaningless RGB channels.
pub(crate) fn pixmap_to_alpha_mask(pixmap: &tiny_skia::Pixmap) -> image::GrayImage {
    image::GrayImage::from_fn(pixmap.width(), pixmap.height(), |x, y| {
        let index = y as usize * pixmap.width() as usize + x as usize;
        image::Luma([pixmap.pixels()[index].alpha()])
    })
}

/// Convert straight-alpha RGBA bytes to the premultiplied representation used
/// by Chromium's Skia raster pipeline.
///
/// Skia rounds `component * alpha / 255` to the nearest byte. Keeping that
/// quantization here is important for filters: a later unpremultiplication can
/// magnify a one-byte truncation at low alpha into a visible channel error.
pub(crate) fn premultiply_rgba8(image: &image::RgbaImage) -> image::RgbaImage {
    PremultipliedRgba8::from_straight(image).pixels
}

/// Convert premultiplied RGBA bytes back to straight alpha with the nearest-
/// even quantization used when Chromium exports an RGBA8 surface to PDF.
pub(crate) fn unpremultiply_rgba8(image: &image::RgbaImage) -> image::RgbaImage {
    let mut unpremultiplied = image.clone();
    for pixel in unpremultiplied.pixels_mut() {
        let alpha = pixel[3];
        for channel in &mut pixel.0[..3] {
            *channel = unpremultiply_channel(*channel, alpha);
        }
    }
    unpremultiplied
}

fn premultiply_channel(component: u8, alpha: u8) -> u8 {
    let product = u32::from(component) * u32::from(alpha) + 128;
    ((product + (product >> 8)) >> 8) as u8
}

fn unpremultiply_channel(component: u8, alpha: u8) -> u8 {
    if alpha == 0 {
        return 0;
    }
    let denominator = u32::from(alpha);
    let numerator = u32::from(component) * 255;
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    let doubled_remainder = remainder * 2;
    let round_up =
        doubled_remainder > denominator || (doubled_remainder == denominator && quotient % 2 == 1);
    (quotient + u32::from(round_up)).min(255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplication_rounds_every_byte_pair_to_nearest() {
        for alpha in 0..=u8::MAX {
            for component in 0..=u8::MAX {
                let expected = (f32::from(component) * f32::from(alpha) / 255.0).round() as u8;
                assert_eq!(premultiply_channel(component, alpha), expected);
            }
        }
    }

    #[test]
    fn unpremultiplication_uses_nearest_even_ties() {
        assert_eq!(unpremultiply_channel(0, 0), 0);
        assert_eq!(unpremultiply_channel(1, 3), 85);
        assert_eq!(unpremultiply_channel(2, 9), 57);
        assert_eq!(unpremultiply_channel(5, 9), 142);
        assert_eq!(unpremultiply_channel(4, 19), 54);
        assert_eq!(unpremultiply_channel(2, 204), 2);
        assert_eq!(unpremultiply_channel(11, 22), 128);
    }
}
