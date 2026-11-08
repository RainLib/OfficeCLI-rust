//! CSS `filter: drop-shadow()` source and shadow compositing.

use super::*;
use crate::render::raster_pixels::{DevicePixelPoint, PremultipliedRgba8};
use crate::types::PhysicalEdges;

/// One filtered surface plus the directional extent added around its input.
pub(crate) struct DropShadowRaster {
    pub(crate) pixels: PremultipliedRgba8,
    pub(crate) overflow: EdgeSizes,
}

/// Integral backing geometry for a drop-shadow filter result.
///
/// Skia maps the source and translated shadow bounds independently, then keeps
/// one transparent sample around the combined result. Directional insets
/// preserve that geometry; symmetric padding shifts the source phase and
/// compounds when filtered groups nest.
struct DropShadowFrame {
    insets: PhysicalEdges<u32>,
    source_origin: DevicePixelPoint,
    dimensions: crate::util::RasterDimensions,
    pixels_per_point: f32,
}

impl DropShadowFrame {
    fn resolve(
        source: &PremultipliedRgba8,
        kernel: Option<FilterBlurKernel>,
        offset: DeviceOffset,
        pixels_per_point: f32,
    ) -> Option<Self> {
        let movement = offset.directional_outsets()?;
        let blur = kernel.map_or(0, |kernel| kernel.padding_px);
        let filter_margin = blur.checked_add(1)?;
        let insets = PhysicalEdges::new(
            filter_margin.checked_add(movement.top)?,
            filter_margin.checked_add(movement.right)?,
            filter_margin.checked_add(movement.bottom)?,
            filter_margin.checked_add(movement.left)?,
        );
        let width = source
            .width()
            .checked_add(insets.left)?
            .checked_add(insets.right)?;
        let height = source
            .height()
            .checked_add(insets.top)?
            .checked_add(insets.bottom)?;
        Some(Self {
            insets,
            source_origin: DevicePixelPoint::new(
                i32::try_from(insets.left).ok()?,
                i32::try_from(insets.top).ok()?,
            ),
            dimensions: crate::util::RasterDimensions { width, height },
            pixels_per_point,
        })
    }

    fn overflow(&self) -> EdgeSizes {
        self.insets
            .map(|pixels| pixels as f32 / self.pixels_per_point)
    }
}

/// Apply one CSS drop shadow to an already-rasterized filter surface.
///
/// The source is already at `filter_dpi`; resizing it from its point extent
/// would discard the absolute device phase captured by SourceGraphic.
pub(crate) fn drop_shadow_surface(
    source: &PremultipliedRgba8,
    shadow: DropShadow,
    filter_dpi: f32,
) -> Option<DropShadowRaster> {
    if source.width() == 0
        || source.height() == 0
        || !shadow.blur.is_finite()
        || !shadow.dx.is_finite()
        || !shadow.dy.is_finite()
    {
        return None;
    }
    let pixels_per_point =
        crate::render::raster_scale::RasterScale::at_dpi(filter_dpi).pixels_per_point();
    let kernel = (shadow.blur > 0.0)
        .then(|| FilterBlurKernel::new(shadow.blur, filter_dpi))
        .flatten();
    let offset = DeviceOffset::from_points(shadow.dx, shadow.dy, pixels_per_point);
    let frame = DropShadowFrame::resolve(source, kernel, offset, pixels_per_point)?;
    let mut shadow_layer = paint_shadow_layer(source, &frame, offset, shadow.color)?;
    if let Some(kernel) = kernel {
        shadow_layer = PremultipliedRgba8::from_encoded(blur_css_filter_premultiplied(
            shadow_layer.as_image(),
            kernel,
        )?);
    }
    shadow_layer.composite_over(source, frame.source_origin)?;
    Some(DropShadowRaster {
        pixels: shadow_layer,
        overflow: frame.overflow(),
    })
}

/// A CSS filter offset converted to fractional device-pixel coordinates.
#[derive(Clone, Copy)]
struct DeviceOffset {
    x: f32,
    y: f32,
}

impl DeviceOffset {
    fn from_points(x: f32, y: f32, pixels_per_point: f32) -> Self {
        Self {
            x: x * pixels_per_point,
            y: y * pixels_per_point,
        }
    }

    fn directional_outsets(self) -> Option<PhysicalEdges<u32>> {
        Some(PhysicalEdges::new(
            nonnegative_pixel_ceil((-self.y).max(0.0))?,
            nonnegative_pixel_ceil(self.x.max(0.0))?,
            nonnegative_pixel_ceil(self.y.max(0.0))?,
            nonnegative_pixel_ceil((-self.x).max(0.0))?,
        ))
    }
}

fn paint_shadow_layer(
    source: &PremultipliedRgba8,
    frame: &DropShadowFrame,
    offset: DeviceOffset,
    color: crate::types::Color,
) -> Option<PremultipliedRgba8> {
    let width = frame.dimensions.width;
    let height = frame.dimensions.height;
    let pixel_count = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?;
    let mut coverage = Vec::new();
    coverage.try_reserve_exact(pixel_count).ok()?;
    coverage.resize(pixel_count, 0.0_f32);

    for (source_x, source_y, source_pixel) in source.as_image().enumerate_pixels() {
        let source_alpha = f32::from(source_pixel[3]) / 255.0;
        if source_alpha == 0.0 {
            continue;
        }
        let destination_x = source_x as f32 + frame.source_origin.x as f32 + offset.x;
        let destination_y = source_y as f32 + frame.source_origin.y as f32 + offset.y;
        deposit_bilinear(
            &mut coverage,
            frame.dimensions,
            destination_x,
            destination_y,
            source_alpha,
        )?;
    }

    let [red, green, blue, authored_alpha] = color.to_rgba8();
    let authored_alpha = f32::from(authored_alpha) / 255.0;
    let pixels = image::RgbaImage::from_fn(width, height, |x, y| {
        let index = y as usize * width as usize + x as usize;
        let alpha = coverage[index].clamp(0.0, 1.0) * authored_alpha;
        image::Rgba([
            premultiplied_component(red, alpha),
            premultiplied_component(green, alpha),
            premultiplied_component(blue, alpha),
            (alpha * 255.0).round() as u8,
        ])
    });
    Some(PremultipliedRgba8::from_encoded(pixels))
}

fn deposit_bilinear(
    coverage: &mut [f32],
    dimensions: crate::util::RasterDimensions,
    x: f32,
    y: f32,
    alpha: f32,
) -> Option<()> {
    let left = x.floor() as i64;
    let top = y.floor() as i64;
    let horizontal = x - left as f32;
    let vertical = y - top as f32;
    for (offset_y, vertical_weight) in [(0_i64, 1.0 - vertical), (1, vertical)] {
        for (offset_x, horizontal_weight) in [(0_i64, 1.0 - horizontal), (1, horizontal)] {
            let target_x = left.checked_add(offset_x)?;
            let target_y = top.checked_add(offset_y)?;
            let target_x = u32::try_from(target_x).ok();
            let target_y = u32::try_from(target_y).ok();
            let Some((target_x, target_y)) = target_x.zip(target_y) else {
                continue;
            };
            if target_x >= dimensions.width || target_y >= dimensions.height {
                continue;
            }
            let index = usize::try_from(target_y)
                .ok()?
                .checked_mul(usize::try_from(dimensions.width).ok()?)?
                .checked_add(usize::try_from(target_x).ok()?)?;
            let sample = coverage.get_mut(index)?;
            *sample += alpha * horizontal_weight * vertical_weight;
        }
    }
    Some(())
}

fn premultiplied_component(component: u8, alpha: f32) -> u8 {
    (f32::from(component) * alpha).round().clamp(0.0, 255.0) as u8
}
