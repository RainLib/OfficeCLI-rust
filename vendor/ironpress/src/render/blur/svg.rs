//! Raster implementation of supported SVG turbulence/displacement filters.

use super::*;

pub(crate) struct SvgTurbulenceDisplacement {
    pub base_frequency_x: f64,
    pub base_frequency_y: f64,
    pub num_octaves: u32,
    pub seed: i32,
    /// feDisplacementMap scale in SVG user units (CSS px for these filters).
    pub scale: f32,
    pub x_channel: usize,
    pub y_channel: usize,
    /// Filter-region extent beyond the source graphic, in SVG user units.
    pub filter_region_overflow: EdgeSizes,
}

/// A rasterized SVG filter result with its directional paint extent.
pub(crate) struct SvgFilterRaster {
    pub asset: RasterImageAsset,
    pub raster_overflow: EdgeSizes,
}

pub(crate) fn turbulence_displacement_rect(
    width_pt: f32,
    height_pt: f32,
    color: crate::types::Color,
    spec: &SvgTurbulenceDisplacement,
    filter_dpi: f32,
) -> Option<SvgFilterRaster> {
    if width_pt <= 0.0 || height_pt <= 0.0 || color.a <= 0.0 {
        return None;
    }
    let scale = RasterScale::at_dpi(filter_dpi).pixels_per_css_pixel();
    let width_css = width_pt / PT_PER_PX;
    let height_css = height_pt / PT_PER_PX;
    let overflow = spec.filter_region_overflow;
    let canvas_w_css = width_css + overflow.horizontal();
    let canvas_h_css = height_css + overflow.vertical();
    let px_w = (canvas_w_css * scale).round().max(1.0) as u32;
    let px_h = (canvas_h_css * scale).round().max(1.0) as u32;
    let ox = (overflow.left * scale).round() as i32;
    let oy = (overflow.top * scale).round() as i32;
    let rect_w = (width_css * scale).round().max(1.0) as i32;
    let rect_h = (height_css * scale).round().max(1.0) as i32;

    let fill = image::Rgba(color.to_rgba8());
    let mut source = image::RgbaImage::new(px_w, px_h);
    for y in oy.max(0)..(oy + rect_h).min(px_h as i32) {
        for x in ox.max(0)..(ox + rect_w).min(px_w as i32) {
            source.put_pixel(x as u32, y as u32, fill);
        }
    }

    let noise = SvgTurbulence::new(spec.seed);
    let mut out = image::RgbaImage::new(px_w, px_h);
    let view_x = -f64::from(overflow.left);
    let view_y = -f64::from(overflow.top);
    let disp_scale = spec.scale * scale;
    for y in 0..px_h {
        for x in 0..px_w {
            let user_x = (x as f64 + 0.5) / scale as f64 + view_x;
            let user_y = (y as f64 + 0.5) / scale as f64 + view_y;
            let x_channel = noise.turbulence_channel(
                spec.x_channel,
                user_x,
                user_y,
                spec.base_frequency_x,
                spec.base_frequency_y,
                spec.num_octaves,
            );
            let y_channel = noise.turbulence_channel(
                spec.y_channel,
                user_x,
                user_y,
                spec.base_frequency_x,
                spec.base_frequency_y,
                spec.num_octaves,
            );
            let sx = x as i32 + ((x_channel as f32 / 255.0 - 0.5) * disp_scale).round() as i32;
            let sy = y as i32 + ((y_channel as f32 / 255.0 - 0.5) * disp_scale).round() as i32;
            if sx >= 0 && sy >= 0 && sx < px_w as i32 && sy < px_h as i32 {
                out.put_pixel(x, y, *source.get_pixel(sx as u32, sy as u32));
            }
        }
    }

    Some(SvgFilterRaster {
        asset: rgba_to_png_alpha_asset(out, filter_dpi)?,
        raster_overflow: overflow * PT_PER_PX,
    })
}

const SVG_RAND_M: i32 = 2147483647;
const SVG_RAND_A: i32 = 16807;
const SVG_RAND_Q: i32 = 127773;
const SVG_RAND_R: i32 = 2836;
const SVG_B_SIZE: usize = 0x100;
const SVG_B_SIZE_I32: i32 = 0x100;
const SVG_B_LEN: usize = SVG_B_SIZE + SVG_B_SIZE + 2;
const SVG_BM: i32 = 0xff;
const SVG_PERLIN_N: i32 = 0x1000;

struct SvgTurbulence {
    lattice: [usize; SVG_B_LEN],
    gradient: [[[f64; 2]; SVG_B_LEN]; 4],
}

impl SvgTurbulence {
    fn new(mut seed: i32) -> Self {
        let mut lattice = [0; SVG_B_LEN];
        let mut gradient = [[[0.0; 2]; SVG_B_LEN]; 4];
        if seed <= 0 {
            seed = -seed % (SVG_RAND_M - 1) + 1;
        }
        if seed > SVG_RAND_M - 1 {
            seed = SVG_RAND_M - 1;
        }
        for channel_gradient in &mut gradient {
            for i in 0..SVG_B_SIZE {
                lattice[i] = i;
                loop {
                    seed = svg_turbulence_random(seed);
                    let x = ((seed % (SVG_B_SIZE_I32 + SVG_B_SIZE_I32)) - SVG_B_SIZE_I32) as f64
                        / SVG_B_SIZE_I32 as f64;
                    seed = svg_turbulence_random(seed);
                    let y = ((seed % (SVG_B_SIZE_I32 + SVG_B_SIZE_I32)) - SVG_B_SIZE_I32) as f64
                        / SVG_B_SIZE_I32 as f64;
                    let length = (x * x + y * y).sqrt();
                    if length == 0.0 || length > 1.0 {
                        continue;
                    }
                    channel_gradient[i] = [x / length, y / length];
                    break;
                }
            }
        }
        for i in (1..SVG_B_SIZE).rev() {
            let k = lattice[i];
            seed = svg_turbulence_random(seed);
            let j = (seed % SVG_B_SIZE_I32) as usize;
            lattice[i] = lattice[j];
            lattice[j] = k;
        }
        for i in 0..SVG_B_SIZE + 2 {
            lattice[SVG_B_SIZE + i] = lattice[i];
            for channel_gradient in &mut gradient {
                channel_gradient[SVG_B_SIZE + i] = channel_gradient[i];
            }
        }
        Self { lattice, gradient }
    }

    fn turbulence_channel(
        &self,
        channel: usize,
        mut x: f64,
        mut y: f64,
        base_freq_x: f64,
        base_freq_y: f64,
        num_octaves: u32,
    ) -> u8 {
        x *= base_freq_x;
        y *= base_freq_y;
        let mut sum = 0.0;
        let mut ratio = 1.0;
        for _ in 0..num_octaves {
            sum += self.noise2(channel, x, y).abs() / ratio;
            x *= 2.0;
            y *= 2.0;
            ratio *= 2.0;
        }
        (sum * 255.0 + 0.5).clamp(0.0, 255.0) as u8
    }

    fn noise2(&self, channel: usize, x: f64, y: f64) -> f64 {
        let t = x + SVG_PERLIN_N as f64;
        let mut bx0 = t as i32;
        let mut bx1 = bx0 + 1;
        let rx0 = t - t as i64 as f64;
        let rx1 = rx0 - 1.0;
        let t = y + SVG_PERLIN_N as f64;
        let mut by0 = t as i32;
        let mut by1 = by0 + 1;
        let ry0 = t - t as i64 as f64;
        let ry1 = ry0 - 1.0;

        bx0 &= SVG_BM;
        bx1 &= SVG_BM;
        by0 &= SVG_BM;
        by1 &= SVG_BM;
        let i = self.lattice[bx0 as usize];
        let j = self.lattice[bx1 as usize];
        let b00 = self.lattice[i + by0 as usize];
        let b10 = self.lattice[j + by0 as usize];
        let b01 = self.lattice[i + by1 as usize];
        let b11 = self.lattice[j + by1 as usize];
        let sx = svg_s_curve(rx0);
        let sy = svg_s_curve(ry0);
        let q = &self.gradient[channel][b00];
        let u = rx0 * q[0] + ry0 * q[1];
        let q = &self.gradient[channel][b10];
        let v = rx1 * q[0] + ry0 * q[1];
        let a = svg_lerp(sx, u, v);
        let q = &self.gradient[channel][b01];
        let u = rx0 * q[0] + ry1 * q[1];
        let q = &self.gradient[channel][b11];
        let v = rx1 * q[0] + ry1 * q[1];
        let b = svg_lerp(sx, u, v);
        svg_lerp(sy, a, b)
    }
}

fn svg_turbulence_random(seed: i32) -> i32 {
    let mut result = SVG_RAND_A * (seed % SVG_RAND_Q) - SVG_RAND_R * (seed / SVG_RAND_Q);
    if result <= 0 {
        result += SVG_RAND_M;
    }
    result
}

fn svg_s_curve(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn svg_lerp(t: f64, a: f64, b: f64) -> f64 {
    a + t * (b - a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displacement_raster_preserves_directional_filter_region() {
        let raster = turbulence_displacement_rect(
            90.0 * PT_PER_PX,
            58.0 * PT_PER_PX,
            crate::types::Color::from_srgb(0.83, 0.0, 0.0, 1.0),
            &SvgTurbulenceDisplacement {
                base_frequency_x: 0.08,
                base_frequency_y: 0.08,
                num_octaves: 1,
                seed: 7,
                scale: 18.0,
                x_channel: 0,
                y_channel: 1,
                filter_region_overflow: EdgeSizes::new(11.6, 18.0, 11.6, 18.0),
            },
            300.0,
        )
        .expect("filter region produces a raster");

        assert_eq!(
            (raster.asset.source_width, raster.asset.source_height),
            (394, 254)
        );
        let expected_overflow = EdgeSizes::new(11.6, 18.0, 11.6, 18.0) * PT_PER_PX;
        assert_eq!(raster.raster_overflow, expected_overflow);
    }

    #[test]
    fn turbulence_uses_filter_effects_rejection_sampling() {
        let turbulence = SvgTurbulence::new(7);
        assert_eq!(&turbulence.lattice[..8], &[0, 78, 89, 7, 57, 173, 142, 40]);
        let [x, y] = turbulence.gradient[0][0];
        assert!((x - 0.809_942_121_543_021_1).abs() < 1e-15);
        assert!((y + 0.586_509_812_151_842_8).abs() < 1e-15);
    }
}
