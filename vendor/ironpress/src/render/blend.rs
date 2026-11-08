//! Shared separable blend-mode math for raster paint paths.
//!
//! CSS backgrounds and SVG filter primitives use the same compositing model.
//! Keeping the implementation here prevents those paths from drifting in
//! alpha handling or quantization.

use crate::style::computed::BlendMode;

/// Blend a straight-alpha source over a straight-alpha backdrop.
pub(crate) fn composite_pixel(
    source: image::Rgba<u8>,
    backdrop: image::Rgba<u8>,
    mode: BlendMode,
    linear_rgb: bool,
) -> Option<image::Rgba<u8>> {
    if !supports(mode) {
        return None;
    }
    if source[3] == u8::MAX && backdrop[3] == u8::MAX {
        let composite_channel = |source: u8, backdrop: u8| {
            if linear_rgb {
                let source = quantize(srgb_to_linear(f32::from(source) / 255.0));
                let backdrop = quantize(srgb_to_linear(f32::from(backdrop) / 255.0));
                let blended = composite_opaque_channel(source, backdrop, mode);
                quantize(linear_to_srgb(f32::from(blended) / 255.0))
            } else {
                composite_opaque_channel(source, backdrop, mode)
            }
        };
        return Some(image::Rgba([
            composite_channel(source[0], backdrop[0]),
            composite_channel(source[1], backdrop[1]),
            composite_channel(source[2], backdrop[2]),
            u8::MAX,
        ]));
    }

    let source_alpha = f32::from(source[3]) / 255.0;
    let backdrop_alpha = f32::from(backdrop[3]) / 255.0;
    let output_alpha = source_alpha + backdrop_alpha * (1.0 - source_alpha);
    if output_alpha <= 0.0 {
        return Some(image::Rgba([0, 0, 0, 0]));
    }

    let mut output = [0; 4];
    for channel in 0..3 {
        let mut source_channel = f32::from(source[channel]) / 255.0;
        let mut backdrop_channel = f32::from(backdrop[channel]) / 255.0;
        if linear_rgb {
            source_channel = srgb_to_linear(source_channel);
            backdrop_channel = srgb_to_linear(backdrop_channel);
        }
        let blended = blend_channel(mode, source_channel, backdrop_channel);
        let premultiplied = source_alpha * (1.0 - backdrop_alpha) * source_channel
            + source_alpha * backdrop_alpha * blended
            + (1.0 - source_alpha) * backdrop_alpha * backdrop_channel;
        let mut channel_value = premultiplied / output_alpha;
        if linear_rgb {
            channel_value = linear_to_srgb(channel_value);
        }
        output[channel] = quantize(channel_value);
    }
    output[3] = quantize(output_alpha);
    Some(image::Rgba(output))
}

pub(crate) fn supports(mode: BlendMode) -> bool {
    matches!(
        mode,
        BlendMode::Normal
            | BlendMode::Multiply
            | BlendMode::Screen
            | BlendMode::Overlay
            | BlendMode::Darken
            | BlendMode::Lighten
            | BlendMode::ColorDodge
            | BlendMode::ColorBurn
            | BlendMode::HardLight
            | BlendMode::SoftLight
            | BlendMode::Difference
            | BlendMode::Exclusion
    )
}

/// Opaque sRGB compositing follows the integer channel arithmetic emitted by
/// Chromium's PDF paint path. Floating-point rounding changes whole flat
/// regions by one channel value for multiply and screen.
fn composite_opaque_channel(source: u8, backdrop: u8, mode: BlendMode) -> u8 {
    let source = u16::from(source);
    let backdrop = u16::from(backdrop);
    let result = match mode {
        BlendMode::Normal => source,
        BlendMode::Multiply => source * backdrop / 255,
        BlendMode::Screen => 255 - (255 - source) * (255 - backdrop) / 255,
        _ => {
            return quantize(blend_channel(
                mode,
                source as f32 / 255.0,
                backdrop as f32 / 255.0,
            ));
        }
    };
    result as u8
}

fn blend_channel(mode: BlendMode, source: f32, backdrop: f32) -> f32 {
    match mode {
        BlendMode::Normal => source,
        BlendMode::Multiply => source * backdrop,
        BlendMode::Screen => source + backdrop - source * backdrop,
        BlendMode::Overlay => {
            if backdrop <= 0.5 {
                2.0 * source * backdrop
            } else {
                1.0 - 2.0 * (1.0 - source) * (1.0 - backdrop)
            }
        }
        BlendMode::Darken => source.min(backdrop),
        BlendMode::Lighten => source.max(backdrop),
        BlendMode::ColorDodge => {
            if source >= 1.0 {
                1.0
            } else {
                (backdrop / (1.0 - source)).min(1.0)
            }
        }
        BlendMode::ColorBurn => {
            if source <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - backdrop) / source).min(1.0)
            }
        }
        BlendMode::HardLight => {
            if source <= 0.5 {
                2.0 * source * backdrop
            } else {
                1.0 - 2.0 * (1.0 - source) * (1.0 - backdrop)
            }
        }
        BlendMode::SoftLight => {
            if source <= 0.5 {
                backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop)
            } else {
                let curve = if backdrop <= 0.25 {
                    ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop
                } else {
                    backdrop.sqrt()
                };
                backdrop + (2.0 * source - 1.0) * (curve - backdrop)
            }
        }
        BlendMode::Difference => (backdrop - source).abs(),
        BlendMode::Exclusion => backdrop + source - 2.0 * backdrop * source,
        _ => source,
    }
    .clamp(0.0, 1.0)
}

fn srgb_to_linear(component: f32) -> f32 {
    if component <= 0.04045 {
        component / 12.92
    } else {
        ((component + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(component: f32) -> f32 {
    if component <= 0.003_130_8 {
        12.92 * component
    } else {
        1.055 * component.powf(1.0 / 2.4) - 0.055
    }
}

fn quantize(value: f32) -> u8 {
    (value * 255.0).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_screen_then_multiply_matches_chromium_integer_channels() {
        let base = image::Rgba([253, 216, 53, 255]);
        let blue = image::Rgba([21, 101, 192, 255]);
        let red = image::Rgba([211, 47, 47, 255]);

        let screen = composite_pixel(blue, base, BlendMode::Screen, false).unwrap();
        assert_eq!(screen, image::Rgba([254, 232, 206, 255]));
        assert_eq!(
            composite_pixel(red, screen, BlendMode::Multiply, false),
            Some(image::Rgba([210, 42, 37, 255]))
        );
    }

    #[test]
    fn transparent_source_preserves_the_flood_backdrop() {
        let transparent = image::Rgba([0, 0, 0, 0]);
        let flood = image::Rgba([21, 101, 192, 255]);
        assert_eq!(
            composite_pixel(transparent, flood, BlendMode::Multiply, true),
            Some(flood)
        );
    }

    #[test]
    fn opaque_linear_multiply_uses_chromium_filter_surface_quantization() {
        let red = image::Rgba([213, 0, 0, 255]);
        let blue = image::Rgba([21, 101, 192, 255]);

        assert_eq!(
            composite_pixel(red, blue, BlendMode::Multiply, true),
            Some(image::Rgba([13, 0, 0, 255]))
        );
    }
}
