//! Replaced-image and expanded-raster painting.

use crate::layout::engine::RasterImageAsset;
use crate::layout::filter::FilterRasterOutput;
use crate::render::raster_pixels::DevicePixelPoint;
use crate::types::{EdgeSizes, Point, Size};

use super::geometry::DeviceClip;
use super::{RasterCanvas, SurfaceRect};

impl RasterCanvas<'_> {
    pub(in crate::layout::filter::surface) fn paint_image(
        &mut self,
        asset: &RasterImageAsset,
        content_box: SurfaceRect,
        sampling: crate::layout::elements::ImageSampling,
    ) -> Option<()> {
        let decoded = crate::layout::images::decode_asset_to_rgba(asset)?;
        let placement = crate::layout::images::compute_image_placement(
            content_box.size.width,
            content_box.size.height,
            decoded.width(),
            decoded.height(),
            sampling.replaced.object_fit,
            sampling.replaced.object_position,
        );
        let resized = crate::render::blur::rasterize_image_buffer(
            &decoded,
            placement.width,
            placement.height,
            sampling.rendering,
            self.pixels_per_point * 72.0,
        )?;
        let painted_box = SurfaceRect::new(
            Point::new(
                content_box.origin.x + placement.offset_x,
                content_box.origin.y + placement.offset_y,
            ),
            Size::new(placement.width, placement.height),
        );
        if let Some(clipped) = painted_box.intersection(content_box) {
            self.include_paint_bounds(clipped);
        }
        let destination = DevicePixelPoint::new(
            (painted_box.origin.x * self.pixels_per_point).round() as i32,
            (painted_box.origin.y * self.pixels_per_point).round() as i32,
        );
        let clip =
            DeviceClip::from_rect(content_box, self.pixels_per_point, self.pixels.dimensions());
        self.composite_image(&resized, destination, clip);
        Some(())
    }

    pub(in crate::layout::filter::surface) fn paint_filter_output(
        &mut self,
        output: &FilterRasterOutput,
        source_box: SurfaceRect,
    ) -> Option<()> {
        self.paint_expanded_raster(&output.asset, source_box, output.raster_overflow)
    }

    pub(in crate::layout::filter::surface) fn paint_expanded_raster(
        &mut self,
        asset: &RasterImageAsset,
        source_box: SurfaceRect,
        overflow: EdgeSizes,
    ) -> Option<()> {
        self.paint_image(
            asset,
            SurfaceRect::new(
                Point::new(
                    source_box.origin.x - overflow.left,
                    source_box.origin.y - overflow.top,
                ),
                Size::new(
                    source_box.size.width + overflow.horizontal(),
                    source_box.size.height + overflow.vertical(),
                ),
            ),
            crate::layout::elements::ImageSampling {
                replaced: crate::layout::engine::ReplacedContent {
                    object_fit: crate::style::computed::ObjectFit::Fill,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
    }

    pub(super) fn paint_asset_at(&mut self, asset: &RasterImageAsset, origin: Point) -> Option<()> {
        let decoded = crate::layout::images::decode_asset_to_rgba(asset)?;
        self.include_paint_bounds(SurfaceRect::new(
            origin,
            Size::new(
                decoded.width() as f32 / self.pixels_per_point,
                decoded.height() as f32 / self.pixels_per_point,
            ),
        ));
        let destination = DevicePixelPoint::new(
            (origin.x * self.pixels_per_point).round() as i32,
            (origin.y * self.pixels_per_point).round() as i32,
        );
        self.composite_image(
            &decoded,
            destination,
            DeviceClip::full(self.pixels.dimensions()),
        );
        Some(())
    }
}
