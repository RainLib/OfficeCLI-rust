//! Bounded integer Gaussian approximation used by Skia's RGBA8 blur path.

/// A three-box Gaussian plan evaluated as one rolling pass.
///
/// Skia uses a wider final box when `window` is even. Keeping the buffer and
/// border geometry in the plan makes that centring rule part of the type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DiscreteGaussianPlan {
    window: u32,
    border: u32,
    third_buffer_len: u32,
    divider: ScaledDividerU32,
}

impl DiscreteGaussianPlan {
    pub(super) fn from_sigma(sigma_px: f32) -> Option<Self> {
        if !sigma_px.is_normal() || sigma_px < 2.0 {
            return None;
        }
        let width =
            (f64::from(sigma_px) * 3.0 * (2.0 * std::f64::consts::PI).sqrt() / 4.0 + 0.5).floor();
        if !(2.0..255.0).contains(&width) {
            return None;
        }
        let window = width as u32;
        let pass_len = window.checked_sub(1)?;
        let even = window % 2 == 0;
        let border = if even {
            window.checked_mul(3)?.checked_div(2)?.checked_sub(1)?
        } else {
            pass_len.checked_mul(3)?.checked_div(2)?
        };
        let window_squared = window.checked_mul(window)?;
        let divisor = window_squared.checked_mul(window)?.checked_add(if even {
            window_squared
        } else {
            0
        })?;
        Some(Self {
            window,
            border,
            third_buffer_len: pass_len + u32::from(even),
            divider: ScaledDividerU32::new(divisor)?,
        })
    }

    #[cfg(test)]
    pub(super) fn pass_widths(self) -> [u32; 3] {
        [
            self.window,
            self.window,
            self.third_buffer_len.saturating_add(1),
        ]
    }

    /// Farthest destination sample reached by the finite three-box kernel.
    ///
    /// This is a raster support radius, not a conservative CSS paint overflow.
    /// Callers rasterizing antialiased vector coverage must additionally retain
    /// the one-pixel source fringe.
    pub(super) const fn support_radius(self) -> u32 {
        self.border
    }

    fn pass_buffer_len(self) -> Option<usize> {
        usize::try_from(self.window.checked_sub(1)?).ok()
    }

    fn third_buffer_len(self) -> Option<usize> {
        usize::try_from(self.third_buffer_len).ok()
    }
}

/// Skia's reciprocal divider for a bounded `u32` Gaussian accumulator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScaledDividerU32 {
    factor: u32,
    half: u32,
}

impl ScaledDividerU32 {
    fn new(divisor: u32) -> Option<Self> {
        if divisor <= 1 {
            return None;
        }
        let factor = ((1.0 / f64::from(divisor)) * (1_u64 << 32) as f64).round();
        if !(1.0..=f64::from(u32::MAX)).contains(&factor) {
            return None;
        }
        Some(Self {
            factor: factor as u32,
            half: divisor.checked_add(1)?.checked_div(2)?,
        })
    }

    fn divide(self, numerator: u32) -> Option<u8> {
        let scaled = u64::from(numerator).checked_mul(u64::from(self.factor))? >> 32;
        u8::try_from(scaled).ok()
    }
}

/// Evaluate the combined three-box pass on both image axes.
pub(super) fn box_blur_axes(
    image: &image::RgbaImage,
    plan: DiscreteGaussianPlan,
) -> Option<image::RgbaImage> {
    let horizontal = box_blur_axis(image, plan, true)?;
    box_blur_axis(&horizontal, plan, false)
}

fn box_blur_axis(
    image: &image::RgbaImage,
    plan: DiscreteGaussianPlan,
    horizontal: bool,
) -> Option<image::RgbaImage> {
    let (width, height) = image.dimensions();
    let geometry = BlurAxisGeometry::new(width, height, horizontal)?;
    let mut output = vec![0; image.as_raw().len()];
    let mut pass = GaussianLinePass::new(plan)?;
    let border = usize::try_from(plan.border).ok()?;

    for line in 0..geometry.line_count {
        pass.reset();
        for source_index in 0..border {
            let leading = geometry.pixel_or_transparent(image.as_raw(), source_index, line)?;
            pass.advance(leading)?;
        }
        for destination_index in 0..geometry.line_length {
            let source_index = destination_index.checked_add(border)?;
            let leading = geometry.pixel_or_transparent(image.as_raw(), source_index, line)?;
            let blurred = pass.advance(leading)?;
            geometry.write_pixel(&mut output, destination_index, line, blurred)?;
        }
    }

    image::RgbaImage::from_raw(width, height, output)
}

type BlurPixel = [u32; 4];

struct GaussianLinePass {
    buffers: [Vec<BlurPixel>; 3],
    cursors: [usize; 3],
    sums: [BlurPixel; 3],
    divider: ScaledDividerU32,
}

impl GaussianLinePass {
    fn new(plan: DiscreteGaussianPlan) -> Option<Self> {
        let pass_len = plan.pass_buffer_len()?;
        let third_len = plan.third_buffer_len()?;
        let mut buffers = [Vec::new(), Vec::new(), Vec::new()];
        for (buffer, len) in buffers.iter_mut().zip([pass_len, pass_len, third_len]) {
            buffer.try_reserve_exact(len).ok()?;
            buffer.resize(len, [0; 4]);
        }
        Some(Self {
            buffers,
            cursors: [0; 3],
            sums: [[0; 4], [0; 4], [plan.divider.half; 4]],
            divider: plan.divider,
        })
    }

    fn reset(&mut self) {
        for buffer in &mut self.buffers {
            buffer.fill([0; 4]);
        }
        self.cursors = [0; 3];
        self.sums = [[0; 4], [0; 4], [self.divider.half; 4]];
    }

    fn advance(&mut self, leading: BlurPixel) -> Option<[u8; 4]> {
        for (channel, leading) in leading.into_iter().enumerate() {
            self.sums[0][channel] = self.sums[0][channel].checked_add(leading)?;
            self.sums[1][channel] = self.sums[1][channel].checked_add(self.sums[0][channel])?;
            self.sums[2][channel] = self.sums[2][channel].checked_add(self.sums[1][channel])?;
        }

        let mut blurred = [0; 4];
        for (channel, output) in blurred.iter_mut().enumerate() {
            *output = self.divider.divide(self.sums[2][channel])?;
        }

        let trailing2 = cycle_buffer(&mut self.buffers[2], &mut self.cursors[2], self.sums[1])?;
        let trailing1 = cycle_buffer(&mut self.buffers[1], &mut self.cursors[1], self.sums[0])?;
        let trailing0 = cycle_buffer(&mut self.buffers[0], &mut self.cursors[0], leading)?;
        for channel in 0..4 {
            self.sums[2][channel] = self.sums[2][channel].checked_sub(trailing2[channel])?;
            self.sums[1][channel] = self.sums[1][channel].checked_sub(trailing1[channel])?;
            self.sums[0][channel] = self.sums[0][channel].checked_sub(trailing0[channel])?;
        }
        Some(blurred)
    }
}

fn cycle_buffer(
    buffer: &mut [BlurPixel],
    cursor: &mut usize,
    replacement: BlurPixel,
) -> Option<BlurPixel> {
    let cell = buffer.get_mut(*cursor)?;
    let previous = *cell;
    *cell = replacement;
    *cursor = cursor.checked_add(1)?;
    if *cursor == buffer.len() {
        *cursor = 0;
    }
    Some(previous)
}

#[derive(Clone, Copy)]
struct BlurAxisGeometry {
    line_length: usize,
    line_count: usize,
    row_width: usize,
    horizontal: bool,
}

impl BlurAxisGeometry {
    fn new(width: u32, height: u32, horizontal: bool) -> Option<Self> {
        let row_width = usize::try_from(width).ok()?;
        let height = usize::try_from(height).ok()?;
        if row_width == 0 || height == 0 {
            return None;
        }
        let (line_length, line_count) = if horizontal {
            (row_width, height)
        } else {
            (height, row_width)
        };
        Some(Self {
            line_length,
            line_count,
            row_width,
            horizontal,
        })
    }

    fn pixel_or_transparent(self, pixels: &[u8], index: usize, line: usize) -> Option<BlurPixel> {
        if index >= self.line_length {
            return Some([0; 4]);
        }
        let offset = self.pixel_offset(index, line)?;
        let channels = pixels.get(offset..offset.checked_add(4)?)?;
        Some([
            u32::from(*channels.first()?),
            u32::from(*channels.get(1)?),
            u32::from(*channels.get(2)?),
            u32::from(*channels.get(3)?),
        ])
    }

    fn write_pixel(
        self,
        pixels: &mut [u8],
        index: usize,
        line: usize,
        value: [u8; 4],
    ) -> Option<()> {
        let offset = self.pixel_offset(index, line)?;
        pixels
            .get_mut(offset..offset.checked_add(4)?)?
            .copy_from_slice(&value);
        Some(())
    }

    fn pixel_offset(self, index: usize, line: usize) -> Option<usize> {
        let pixel = if self.horizontal {
            line.checked_mul(self.row_width)?.checked_add(index)?
        } else {
            index.checked_mul(self.row_width)?.checked_add(line)?
        };
        pixel.checked_mul(4)
    }
}
