mod geometry;

pub(crate) use geometry::FilterSourceGeometry;

use crate::style::computed::{FilterOperation, NormalizedFilterRegion};
use crate::types::EdgeSizes;

use super::color_space::RasterFilterColorSpace;
use crate::render::raster_scale::RasterScale;
use geometry::RasterRegion;

/// Filtered pixels and their directional paint overflow around the source box.
pub(crate) struct FilteredSurface {
    pub(crate) pixels: image::RgbaImage,
    pub(crate) bounds: FilterSurfaceBounds,
}

/// Distinguishes the serialized raster allocation from finite effect support.
///
/// An explicit SVG region can be larger than the pixels a local operation
/// affects. Gaussian filters retain that complete allocation, while local
/// operations may serialize only their finite support without changing paint.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FilterSurfaceBounds {
    pub(crate) raster_overflow: EdgeSizes,
    pub(crate) effect_support: EdgeSizes,
}

struct PremultipliedFilteredSurface {
    pixels: crate::render::raster_pixels::PremultipliedRgba8,
    overflow: EdgeSizes,
}

/// Evaluate one ordered filter list over an already-composited source graphic.
///
/// Returning `None` for an unsupported SVG graph operation is deliberate: the
/// caller can retain the vector source and use its explicit fallback, while a
/// silent no-op would publish an incorrect filtered surface.
pub(crate) fn apply_operations_to_surface(
    source: &crate::render::raster_pixels::PremultipliedRgba8,
    geometry: FilterSourceGeometry,
    operations: &[FilterOperation],
    linear_rgb: bool,
    svg_region: Option<NormalizedFilterRegion>,
    filter_dpi: f32,
) -> Option<FilteredSurface> {
    let mut pixels = source.clone();
    let working_space = RasterFilterColorSpace::resolve(linear_rgb);
    working_space.enter_surface(&mut pixels);
    let mut overflow = EdgeSizes::ZERO;
    let mut color_run_start = None;
    for (operation_index, operation) in operations.iter().enumerate() {
        if is_color_operation(operation) {
            color_run_start.get_or_insert(operation_index);
            continue;
        }
        if let Some(start) = color_run_start.take() {
            apply_color_operations(&mut pixels, &operations[start..operation_index]);
        }
        match *operation {
            FilterOperation::BlendWithFlood {
                color,
                mode,
                region,
            } => {
                let filtered = blend_with_flood(
                    &pixels,
                    geometry,
                    overflow,
                    working_space.enter_color(color),
                    mode,
                    region,
                    filter_dpi,
                )?;
                pixels = filtered.pixels;
                overflow = filtered.overflow;
            }
            FilterOperation::Blur(radius) if radius > 0.0 => {
                let (filtered, amount) =
                    crate::render::blur::blur_premultiplied_buffer(&pixels, radius, filter_dpi)?;
                pixels = filtered;
                overflow += EdgeSizes::uniform(amount);
            }
            FilterOperation::DropShadow(shadow) => {
                let shadow = crate::style::computed::DropShadow {
                    color: working_space.enter_color(shadow.color),
                    ..shadow
                };
                let filtered =
                    crate::render::blur::drop_shadow_surface(&pixels, shadow, filter_dpi)?;
                pixels = filtered.pixels;
                overflow += filtered.overflow;
            }
            FilterOperation::Blur(_) => {}
            FilterOperation::Offset { .. } | FilterOperation::MorphologyDilate(_) => return None,
            _ => {}
        }
    }
    if let Some(start) = color_run_start {
        apply_color_operations(&mut pixels, &operations[start..]);
    }
    let effect_support = overflow;
    if let Some(region) = svg_region {
        let scale = RasterScale::at_dpi(filter_dpi);
        let region = RasterRegion::resolve(region, geometry, scale)?;
        let source_frame = RasterRegion::source_frame(&pixels, overflow, scale)?;
        pixels = region.extract(&pixels, source_frame)?;
        overflow = region.paint_overflow(geometry, scale);
    }
    working_space.leave_surface(&mut pixels);
    Some(FilteredSurface {
        pixels: pixels.into_straight(),
        bounds: FilterSurfaceBounds {
            raster_overflow: overflow,
            effect_support,
        },
    })
}

fn is_color_operation(operation: &FilterOperation) -> bool {
    matches!(
        operation,
        FilterOperation::Grayscale(_)
            | FilterOperation::Sepia(_)
            | FilterOperation::Invert(_)
            | FilterOperation::Brightness(_)
            | FilterOperation::Contrast(_)
            | FilterOperation::Saturate(_)
            | FilterOperation::HueRotate(_)
            | FilterOperation::Opacity(_)
            | FilterOperation::Matrix(_)
    )
}

fn blend_with_flood(
    source: &crate::render::raster_pixels::PremultipliedRgba8,
    geometry: FilterSourceGeometry,
    source_overflow: EdgeSizes,
    color: crate::types::Color,
    mode: crate::style::computed::BlendMode,
    region: NormalizedFilterRegion,
    filter_dpi: f32,
) -> Option<PremultipliedFilteredSurface> {
    let scale = RasterScale::at_dpi(filter_dpi);
    let raster_region = RasterRegion::resolve(region, geometry, scale)?;
    let (width, height) = raster_region.dimensions()?;
    let source_region = RasterRegion::source_frame(source, source_overflow, scale)?;
    let flood = image::Rgba(color.to_rgba8());
    let transparent = image::Rgba([0, 0, 0, 0]);
    let source = source.clone().into_straight();
    let mut output = image::RgbaImage::new(width, height);

    for (x, y, output_pixel) in output.enumerate_pixels_mut() {
        let global_x = raster_region.left.checked_add(i64::from(x))?;
        let global_y = raster_region.top.checked_add(i64::from(y))?;
        let local_x = global_x.checked_sub(source_region.left)?;
        let local_y = global_y.checked_sub(source_region.top)?;
        let source_pixel = u32::try_from(local_x)
            .ok()
            .zip(u32::try_from(local_y).ok())
            .filter(|(x, y)| *x < source.width() && *y < source.height())
            .map_or(transparent, |(x, y)| *source.get_pixel(x, y));
        *output_pixel = crate::render::blend::composite_pixel(source_pixel, flood, mode, false)?;
    }

    Some(PremultipliedFilteredSurface {
        pixels: crate::render::raster_pixels::PremultipliedRgba8::from_straight(&output),
        overflow: raster_region.paint_overflow(geometry, scale),
    })
}

/// Evaluate one uninterrupted colour-function run in floating point and
/// quantize only when the run returns to the raster surface. Quantizing between
/// functions compounds channel error and does not represent the conceptual
/// image pipeline defined by Filter Effects.
fn apply_color_operations(
    pixels: &mut crate::render::raster_pixels::PremultipliedRgba8,
    operations: &[FilterOperation],
) {
    pixels.map_straight(|color| super::apply_operations_to_color(color, operations, false));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::computed::{BlendMode, DropShadow, NormalizedFilterRegion};
    use crate::types::{Color, Rect, Size};

    fn source_geometry(size: Size) -> FilterSourceGeometry {
        FilterSourceGeometry::new(size, Rect::new(Default::default(), size))
            .expect("the test source has finite positive geometry")
    }

    fn region(x: f32, y: f32, width: f32, height: f32) -> NormalizedFilterRegion {
        NormalizedFilterRegion::new(x, y, width, height)
            .expect("the test filter region has finite positive geometry")
    }

    #[test]
    fn flood_blend_preserves_the_flood_only_region() {
        let source = crate::render::raster_pixels::PremultipliedRgba8::from_straight(
            &image::RgbaImage::from_pixel(10, 6, image::Rgba([213, 0, 0, 255])),
        );
        let flood = Color::rgb(21, 101, 192);
        let filtered = apply_operations_to_surface(
            &source,
            source_geometry(Size::new(10.0, 6.0)),
            &[FilterOperation::BlendWithFlood {
                color: flood,
                mode: BlendMode::Multiply,
                region: region(-0.2, -0.5, 1.4, 2.0),
            }],
            true,
            None,
            72.0,
        )
        .expect("a finite flood and source produce one blended surface");

        assert_eq!(filtered.pixels.dimensions(), (14, 12));
        for (actual, expected) in [
            (filtered.bounds.raster_overflow.top, 3.0),
            (filtered.bounds.raster_overflow.right, 2.0),
            (filtered.bounds.raster_overflow.bottom, 3.0),
            (filtered.bounds.raster_overflow.left, 2.0),
        ] {
            assert!((actual - expected).abs() < 0.000_01);
        }
        assert_eq!(filtered.pixels.get_pixel(0, 0).0, [22, 101, 192, 255]);
        assert_eq!(filtered.pixels.get_pixel(2, 3).0, [13, 0, 0, 255]);
    }

    #[test]
    fn ordered_drop_shadow_consumes_the_composited_source() {
        let source = crate::render::raster_pixels::PremultipliedRgba8::from_straight(
            &image::RgbaImage::from_pixel(450, 269, image::Rgba([20, 80, 160, 255])),
        );
        let filtered = apply_operations_to_surface(
            &source,
            source_geometry(Size::new(108.0, 64.5)),
            &[FilterOperation::DropShadow(DropShadow {
                dx: 1.5,
                dy: 0.75,
                blur: 0.0,
                color: Color::from_srgb(0.56, 0.64, 0.68, 1.0),
            })],
            false,
            None,
            300.0,
        )
        .expect("a finite painted source and shadow produce one surface");

        assert!(filtered.pixels.width() > source.width());
        assert!(filtered.pixels.height() > source.height());
        assert!(!filtered.bounds.raster_overflow.is_zero());
    }

    #[test]
    fn opacity_remains_in_filter_list_order() {
        let source = crate::render::raster_pixels::PremultipliedRgba8::from_straight(
            &image::RgbaImage::from_pixel(1, 1, image::Rgba([20, 80, 160, 255])),
        );
        let filtered = apply_operations_to_surface(
            &source,
            source_geometry(Size::new(0.75, 0.75)),
            &[FilterOperation::Opacity(0.25)],
            false,
            None,
            96.0,
        )
        .expect("opacity is a surface color operation");

        assert_eq!(filtered.pixels.get_pixel(0, 0)[3], 64);
    }

    #[test]
    fn consecutive_color_functions_quantize_only_at_the_surface_boundary() {
        let source = crate::render::raster_pixels::PremultipliedRgba8::from_straight(
            &image::RgbaImage::from_pixel(1, 1, image::Rgba([231, 245, 255, 255])),
        );
        let filtered = apply_operations_to_surface(
            &source,
            source_geometry(Size::new(0.75, 0.75)),
            &[
                FilterOperation::Grayscale(0.18),
                FilterOperation::Contrast(1.08),
            ],
            false,
            None,
            96.0,
        )
        .expect("finite colour functions produce a surface");

        assert_eq!(filtered.pixels.get_pixel(0, 0).0, [242, 254, 255, 255]);
    }

    #[test]
    fn explicit_svg_region_pads_and_hard_clips_the_output() {
        let source = crate::render::raster_pixels::PremultipliedRgba8::from_straight(
            &image::RgbaImage::from_pixel(10, 6, image::Rgba([213, 0, 0, 255])),
        );
        let filtered = apply_operations_to_surface(
            &source,
            source_geometry(Size::new(10.0, 6.0)),
            &[FilterOperation::Opacity(1.0)],
            false,
            Some(region(0.2, -0.5, 0.6, 2.0)),
            72.0,
        )
        .expect("a valid SVG region produces a finite clipped surface");

        assert_eq!(filtered.pixels.dimensions(), (6, 12));
        assert_eq!(filtered.pixels.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(filtered.pixels.get_pixel(0, 3).0, [213, 0, 0, 255]);
        assert_eq!(filtered.pixels.get_pixel(5, 8).0, [213, 0, 0, 255]);
        assert_eq!(filtered.pixels.get_pixel(5, 9).0, [0, 0, 0, 0]);
    }
}
