//! Device geometry for an SVG filter surface and its object bounding box.

use crate::render::raster_pixels::PremultipliedRgba8;
use crate::render::raster_scale::RasterScale;
use crate::style::computed::NormalizedFilterRegion;
use crate::types::{EdgeSizes, Rect, Size};

/// Geometry needed to resolve normalized SVG filter coordinates.
///
/// The source surface may include authored paint overflow. `object_bounds`
/// therefore retains the border box independently instead of treating the
/// allocation itself as the object bounding box.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FilterSourceGeometry {
    surface_size: Size,
    object_bounds: Rect,
}

impl FilterSourceGeometry {
    pub(crate) fn new(surface_size: Size, object_bounds: Rect) -> Option<Self> {
        let values = [
            surface_size.width,
            surface_size.height,
            object_bounds.origin.x,
            object_bounds.origin.y,
            object_bounds.size.width,
            object_bounds.size.height,
        ];
        (values.into_iter().all(f32::is_finite)
            && surface_size.width > 0.0
            && surface_size.height > 0.0
            && object_bounds.size.width > 0.0
            && object_bounds.size.height > 0.0)
            .then_some(Self {
                surface_size,
                object_bounds,
            })
    }

    pub(super) const fn surface_size(self) -> Size {
        self.surface_size
    }

    fn resolve(self, region: NormalizedFilterRegion) -> Rect {
        let normalized = region.as_rect();
        Rect::from_xywh(
            self.object_bounds.origin.x + normalized.origin.x * self.object_bounds.size.width,
            self.object_bounds.origin.y + normalized.origin.y * self.object_bounds.size.height,
            normalized.size.width * self.object_bounds.size.width,
            normalized.size.height * self.object_bounds.size.height,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RasterRegion {
    pub(super) left: i64,
    pub(super) top: i64,
    right: i64,
    bottom: i64,
}

impl RasterRegion {
    pub(super) fn resolve(
        region: NormalizedFilterRegion,
        geometry: FilterSourceGeometry,
        scale: RasterScale,
    ) -> Option<Self> {
        let resolved = geometry.resolve(region);
        let bounds = Self {
            left: scale.floor(resolved.origin.x)?,
            top: scale.floor(resolved.origin.y)?,
            right: scale.ceil(resolved.right())?,
            bottom: scale.ceil(resolved.bottom())?,
        };
        (bounds.right > bounds.left && bounds.bottom > bounds.top).then_some(bounds)
    }

    pub(super) fn dimensions(self) -> Option<(u32, u32)> {
        Some((
            u32::try_from(self.right.checked_sub(self.left)?).ok()?,
            u32::try_from(self.bottom.checked_sub(self.top)?).ok()?,
        ))
    }

    pub(super) fn paint_overflow(
        self,
        geometry: FilterSourceGeometry,
        scale: RasterScale,
    ) -> EdgeSizes {
        let surface_size = geometry.surface_size();
        EdgeSizes::new(
            -scale.pixels_to_points(self.top as f32),
            scale.pixels_to_points(self.right as f32) - surface_size.width,
            scale.pixels_to_points(self.bottom as f32) - surface_size.height,
            -scale.pixels_to_points(self.left as f32),
        )
    }

    pub(super) fn source_frame(
        pixels: &PremultipliedRgba8,
        overflow: EdgeSizes,
        scale: RasterScale,
    ) -> Option<Self> {
        let left = scale.round(-overflow.left)?;
        let top = scale.round(-overflow.top)?;
        Some(Self {
            left,
            top,
            right: left.checked_add(i64::from(pixels.width()))?,
            bottom: top.checked_add(i64::from(pixels.height()))?,
        })
    }

    /// Copy the intersection of `source_region` into this region, leaving
    /// authored transparent space intact and discarding pixels outside the
    /// hard SVG filter clip.
    pub(super) fn extract(
        self,
        source: &PremultipliedRgba8,
        source_region: Self,
    ) -> Option<PremultipliedRgba8> {
        let (width, height) = self.dimensions()?;
        let mut output = PremultipliedRgba8::transparent(width, height);
        let Some(intersection) = self.intersection(source_region) else {
            return Some(output);
        };
        let (copy_width, copy_height) = intersection.dimensions()?;
        let source_x = u32::try_from(intersection.left.checked_sub(source_region.left)?).ok()?;
        let source_y = u32::try_from(intersection.top.checked_sub(source_region.top)?).ok()?;
        let target_x = u32::try_from(intersection.left.checked_sub(self.left)?).ok()?;
        let target_y = u32::try_from(intersection.top.checked_sub(self.top)?).ok()?;
        let source_right = source_x.checked_add(copy_width)?;
        let source_bottom = source_y.checked_add(copy_height)?;
        let target_right = target_x.checked_add(copy_width)?;
        let target_bottom = target_y.checked_add(copy_height)?;
        if source_right > source.width()
            || source_bottom > source.height()
            || target_right > output.width()
            || target_bottom > output.height()
        {
            return None;
        }
        for y in 0..copy_height {
            for x in 0..copy_width {
                let pixel = *source.get_pixel(source_x + x, source_y + y);
                output
                    .as_image_mut()
                    .put_pixel(target_x + x, target_y + y, pixel);
            }
        }
        Some(output)
    }

    fn intersection(self, other: Self) -> Option<Self> {
        let intersection = Self {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        };
        (intersection.right > intersection.left && intersection.bottom > intersection.top)
            .then_some(intersection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Point;

    #[test]
    fn normalized_region_resolves_against_the_object_not_its_surface() {
        let geometry = FilterSourceGeometry::new(
            Size::new(14.0, 10.0),
            Rect::new(Point::new(2.0, 2.0), Size::new(10.0, 6.0)),
        )
        .expect("the test geometry is finite and positive");
        let scale = RasterScale::at_dpi(225.0);
        let normalized = NormalizedFilterRegion::new(-0.2, -0.5, 1.4, 2.0)
            .expect("the normalized test region is valid");
        let region = RasterRegion::resolve(normalized, geometry, scale)
            .expect("the filter region has device bounds");

        assert_eq!(region.dimensions(), Some((44, 39)));
        let overflow = region.paint_overflow(geometry, scale);
        for (actual, expected) in [
            (overflow.top, 1.28),
            (overflow.right, 0.08),
            (overflow.bottom, 1.2),
            (overflow.left, 0.0),
        ] {
            assert!((actual - expected).abs() < 0.000_01);
        }
    }
}
