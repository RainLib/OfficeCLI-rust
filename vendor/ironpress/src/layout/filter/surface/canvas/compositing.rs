//! Premultiplied-alpha compositing for the filter canvas.

use crate::render::borders::CssRoundedRect;
use crate::render::raster_pixels::{DevicePixelPoint, PremultipliedRgba8};
use crate::types::Color;

use super::RasterCanvas;
use super::geometry::{CoverageSamples, DeviceClip};

impl RasterCanvas<'_> {
    /// Composite an isolated descendant group through a CSS rounded clip.
    pub(in crate::layout::filter::surface) fn composite_clipped_group(
        &mut self,
        source: &PremultipliedRgba8,
        clip: CssRoundedRect,
    ) {
        let width = source.width().min(self.pixels.width());
        let height = source.height().min(self.pixels.height());
        for y in 0..height {
            for x in 0..width {
                let source_pixel = *source.get_pixel(x, y);
                if source_pixel[3] == 0 {
                    continue;
                }
                let coverage = CoverageSamples::geometry(x, y, self.pixels_per_point, |point| {
                    clip.contains(point)
                });
                if coverage <= 0.0 {
                    continue;
                }
                let clipped = RasterCoverage::from_unit(coverage).scale(source_pixel);
                self.composite_premultiplied(x, y, clipped);
            }
        }
    }

    pub(in crate::layout::filter::surface) fn composite_mask(
        &mut self,
        mask: &image::GrayImage,
        destination: DevicePixelPoint,
        color: Color,
    ) {
        let [red, green, blue, color_alpha] = color.to_rgba8();
        if color_alpha == 0 {
            return;
        }
        for y in 0..mask.height() {
            for x in 0..mask.width() {
                let mask_alpha = mask.get_pixel(x, y)[0];
                if mask_alpha == 0 || color_alpha == 0 {
                    continue;
                }
                let target_x = destination.x + x as i32;
                let target_y = destination.y + y as i32;
                if target_x < 0
                    || target_y < 0
                    || target_x >= self.pixels.width() as i32
                    || target_y >= self.pixels.height() as i32
                {
                    continue;
                }
                let source = RasterCoverage::from_byte(mask_alpha).scale(
                    premultiply_straight_pixel(image::Rgba([red, green, blue, color_alpha])),
                );
                self.composite_premultiplied(target_x as u32, target_y as u32, source);
            }
        }
    }

    pub(super) fn composite_image(
        &mut self,
        source: &image::RgbaImage,
        destination: DevicePixelPoint,
        clip: DeviceClip,
    ) {
        for y in 0..source.height() {
            for x in 0..source.width() {
                let target_x = destination.x + x as i32;
                let target_y = destination.y + y as i32;
                if !clip.contains(target_x, target_y) {
                    continue;
                }
                let source_pixel = *source.get_pixel(x, y);
                if source_pixel[3] == 0 {
                    continue;
                }
                self.composite_premultiplied(
                    target_x as u32,
                    target_y as u32,
                    premultiply_straight_pixel(source_pixel),
                );
            }
        }
    }

    pub(super) fn composite_color(&mut self, x: u32, y: u32, color: Color, coverage: f32) {
        self.composite_premultiplied(
            x,
            y,
            premultiplied_color(color.to_f32_rgba(), RasterCoverage::from_unit(coverage)),
        );
    }

    pub(super) fn composite_premultiplied(&mut self, x: u32, y: u32, source: image::Rgba<u8>) {
        let destination = *self.pixels.get_pixel(x, y);
        self.pixels
            .as_image_mut()
            .put_pixel(x, y, premultiplied_source_over(source, destination));
    }
}

/// One 8-bit antialiasing coverage sample.
///
/// Skia's scan converter accumulates on a 0..256 scale and clamps the complete
/// value to 255. Thus 3/4 coverage is 192, not `round(0.75 * 255) == 191`.
#[derive(Clone, Copy)]
pub(super) struct RasterCoverage(u8);

impl RasterCoverage {
    pub(super) fn from_unit(value: f32) -> Self {
        Self((value.clamp(0.0, 1.0) * 256.0).round().clamp(0.0, 255.0) as u8)
    }

    pub(super) const fn from_byte(value: u8) -> Self {
        Self(value)
    }

    pub(super) fn scale(self, pixel: image::Rgba<u8>) -> image::Rgba<u8> {
        let scale = u16::from(self.0) + 1;
        image::Rgba(
            pixel
                .0
                .map(|channel| ((u16::from(channel) * scale) >> 8) as u8),
        )
    }
}

pub(super) fn premultiplied_color(
    color: (f32, f32, f32, f32),
    coverage: RasterCoverage,
) -> image::Rgba<u8> {
    coverage.scale(premultiply_straight_pixel(image::Rgba([
        (color.0 * 255.0).round().clamp(0.0, 255.0) as u8,
        (color.1 * 255.0).round().clamp(0.0, 255.0) as u8,
        (color.2 * 255.0).round().clamp(0.0, 255.0) as u8,
        (color.3 * 255.0).round().clamp(0.0, 255.0) as u8,
    ])))
}

fn premultiply_straight_pixel(pixel: image::Rgba<u8>) -> image::Rgba<u8> {
    let alpha = u32::from(pixel[3]);
    let premultiply = |channel: u8| {
        let product = u32::from(channel) * alpha + 128;
        ((product + (product >> 8)) >> 8) as u8
    };
    image::Rgba([
        premultiply(pixel[0]),
        premultiply(pixel[1]),
        premultiply(pixel[2]),
        pixel[3],
    ])
}

fn premultiplied_source_over(
    source: image::Rgba<u8>,
    destination: image::Rgba<u8>,
) -> image::Rgba<u8> {
    let destination_scale = u16::from(u8::MAX - source[3]) + 1;
    image::Rgba(std::array::from_fn(|channel| {
        source[channel]
            .saturating_add(((u16::from(destination[channel]) * destination_scale) >> 8) as u8)
    }))
}
