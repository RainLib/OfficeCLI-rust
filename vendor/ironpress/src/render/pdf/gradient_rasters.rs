use super::patterns::{LayerTilePattern, PdfTilingPattern, paint_page_tiling_pattern};
use super::*;

/// A page-sized renderer raster carried by a PDF tiling pattern.
///
/// Skia's PDF backend places fallback rasters in default page space and keeps
/// a small non-painting guard between cells. Keeping that placement explicit
/// avoids resampling the bitmap through the page content transform.
#[derive(Debug, Clone, Copy)]
struct PageGradientRasterPattern {
    pdf: PdfTilingPattern,
    image_box: PdfRect,
}

impl PageGradientRasterPattern {
    const CELL_GUARD: f32 = 2.0;
    /// One inward `f32` step for each of the source-to-pattern and
    /// pattern-to-page mappings.
    ///
    /// Renderer raster surfaces are half-open, but a PDF image cell whose
    /// lower edge lands exactly on the corresponding device boundary can make
    /// the consumer select the neighbouring source row. Applying the same
    /// predecessor rounding at both retained geometry stages preserves the
    /// half-open interval without introducing an authored-scale offset.
    const HALF_OPEN_STAGE_SCALE: f32 = f32::from_bits(1.0_f32.to_bits() - 1);

    fn half_open_vertical_transform(mut transform: PdfMatrix) -> PdfMatrix {
        transform.y_axis =
            transform.y_axis * Self::HALF_OPEN_STAGE_SCALE * Self::HALF_OPEN_STAGE_SCALE;
        transform.translation.y = Self::predecessor_toward_zero(transform.translation.y);
        transform
    }

    fn predecessor_toward_zero(value: f32) -> f32 {
        if value == 0.0 || !value.is_finite() {
            return value;
        }
        value
            .to_bits()
            .checked_sub(1)
            .map(f32::from_bits)
            .unwrap_or(value)
    }

    fn resolve(
        dimensions: RasterDimensions,
        page: PdfRect,
        paint_box: PdfRect,
        page_content: PageContentTransform,
    ) -> Option<Self> {
        let source_size = PdfVector::new(dimensions.width as f32, dimensions.height as f32);
        let source_scale =
            PdfVector::new(page.width / source_size.x, -(page.height / source_size.y));
        let placement = PdfPaintSpace::new(PdfMatrix::IDENTITY, page_content, page)
            .raster_cell_to_default(PdfPoint::new(page.left, page.top()), source_scale)?;
        let transform = placement.pattern_transform;
        let pattern_origin = transform
            .inverse()?
            .transform_point(placement.placed.translation);
        let transform = Self::half_open_vertical_transform(transform);
        let image_box = PdfRect::new(
            pattern_origin.x,
            pattern_origin.y,
            source_size.x,
            source_size.y,
        );
        Some(Self {
            pdf: PdfTilingPattern {
                bbox: image_box,
                paint_box,
                step: source_size + PdfVector::new(Self::CELL_GUARD, Self::CELL_GUARD),
                transform,
            },
            image_box,
        })
    }

    fn image_stream(self, name: &str) -> String {
        format!(
            "q\n{width} 0 0 -{height} {left} {top} cm\n/{name} Do\nQ\n",
            width = self.image_box.width,
            height = self.image_box.height,
            left = self.image_box.left,
            top = self.image_box.top(),
        )
    }

    fn paint(self, content: &mut String, name: &str, page_content: PageContentTransform) -> bool {
        if page_content.is_identity() {
            return false;
        }
        paint_page_tiling_pattern(content, name, self.pdf.paint_box);
        true
    }
}

/// Deterministic stratified samples covering one renderer-raster pixel.
///
/// A single 128-point permutation covers every 1/128 stratum on both axes
/// without expanding to a 128×128 grid. The half-pixel shader offset matches
/// Skia's pixel-center convention while tile selection remains in edge-based
/// raster coordinates.
#[derive(Debug, Clone, Copy)]
struct RasterPixelFootprint {
    origin: PdfPoint,
}

impl RasterPixelFootprint {
    const SAMPLE_COUNT: u32 = 128;
    const Y_PERMUTATION: u32 = 73;

    const fn new(origin: PdfPoint) -> Self {
        Self { origin }
    }

    fn samples(self) -> impl Iterator<Item = PdfPoint> {
        (0..Self::SAMPLE_COUNT).map(move |index| {
            let x = (index as f32 + 0.5) / Self::SAMPLE_COUNT as f32;
            let y_index = (index * Self::Y_PERMUTATION) % Self::SAMPLE_COUNT;
            let y = (y_index as f32 + 0.5) / Self::SAMPLE_COUNT as f32;
            PdfPoint::new(self.origin.x + x, self.origin.y + y)
        })
    }
}

pub(super) fn render_distributed_linear_gradient_raster(
    content: &mut String,
    gradient: &LinearGradient,
    pattern: LayerTilePattern,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) -> bool {
    let paint_box = pattern.paint_box();
    let Some(page) = pdf_writer.page_content_transform.page_bounds() else {
        return false;
    };
    let Some(dimensions) = RasterDimensions::from_point_scales(page.width, page.height, 1.0, 1.0)
    else {
        return false;
    };
    if dimensions.width > MAX_RASTER_TILE_EDGE || dimensions.height > MAX_RASTER_TILE_EDGE {
        return false;
    }
    let tile = pattern.tile_size();
    let Some(sampler) = crate::render::gradient_sampling::LinearGradientSampler::resolve(
        gradient,
        crate::types::Size::new(tile.x, tile.y),
    ) else {
        return false;
    };
    let image = image::RgbaImage::from_fn(dimensions.width, dimensions.height, |px, py| {
        let pixel = RasterPixelFootprint::new(PdfPoint::new(
            page.left + px as f32 - paint_box.left,
            paint_box.top() - (page.top() - py as f32),
        ));
        rgba_to_pixel(ResolvedGradientRamp::average_samples(pixel.samples().map(
            |tile_point| {
                pattern
                    .sample_shader_lattice(tile_point)
                    .map_or((0.0, 0.0, 0.0, 0.0), |sample| {
                        sampler
                            .sample(crate::types::Point::new(sample.x - 0.5, sample.y - 0.5))
                            .to_f32_rgba()
                    })
            },
        )))
    });
    let Some(pattern) = PageGradientRasterPattern::resolve(
        dimensions,
        page,
        paint_box,
        pdf_writer.page_content_transform,
    ) else {
        return false;
    };
    let Some(obj_id) =
        pdf_writer.add_raw_rgba_image_object(image.as_raw(), image.width(), image.height())
    else {
        return false;
    };
    let image = ImageRef {
        name: format!("Im{obj_id}"),
        obj_id,
    };
    let Some(pattern_name) =
        pdf_writer.add_page_tiling_pattern(pattern.image_stream(&image.name), pattern.pdf)
    else {
        return false;
    };
    if !pattern.paint(content, &pattern_name, pdf_writer.page_content_transform) {
        return false;
    }
    page_images.push(image);
    true
}

#[cfg(test)]
mod tests {
    use super::{PageGradientRasterPattern, RasterPixelFootprint};
    use crate::render::pdf::geometry::{PdfMatrix, PdfPoint, PdfVector};

    #[test]
    fn raster_pixel_footprint_covers_each_axis_stratum_once() {
        let samples = RasterPixelFootprint::new(PdfPoint::new(7.0, 11.0))
            .samples()
            .collect::<Vec<_>>();
        assert_eq!(samples.len(), RasterPixelFootprint::SAMPLE_COUNT as usize);

        let mut x_strata = samples
            .iter()
            .map(|point| ((point.x - 7.0) * RasterPixelFootprint::SAMPLE_COUNT as f32) as u32)
            .collect::<Vec<_>>();
        let mut y_strata = samples
            .iter()
            .map(|point| ((point.y - 11.0) * RasterPixelFootprint::SAMPLE_COUNT as f32) as u32)
            .collect::<Vec<_>>();
        x_strata.sort_unstable();
        y_strata.sort_unstable();
        assert_eq!(
            x_strata,
            (0..RasterPixelFootprint::SAMPLE_COUNT).collect::<Vec<_>>()
        );
        assert_eq!(
            y_strata,
            (0..RasterPixelFootprint::SAMPLE_COUNT).collect::<Vec<_>>()
        );
    }

    #[test]
    fn page_raster_pattern_uses_a_half_open_vertical_extent() {
        let transform = PageGradientRasterPattern::half_open_vertical_transform(PdfMatrix::new(
            PdfVector::new(1.0, 0.0),
            PdfVector::new(0.0, -1.0),
            PdfPoint::new(0.0, 72.0),
        ));

        assert_eq!(transform.y_axis.y.to_bits(), (-1.0_f32).to_bits() - 2);
        assert_eq!(transform.translation.y.to_bits(), 72.0_f32.to_bits() - 1);
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_linear_gradient_tile_raster(
    content: &mut String,
    gradient: &LinearGradient,
    rect: PdfRect,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    let PdfRect { width, height, .. } = rect;
    let Some(dimensions) =
        gradient_raster_dimensions(width, height, pdf_writer.opts.raster_quality.filter_dpi)
    else {
        return;
    };
    let Some(sampler) = crate::render::gradient_sampling::LinearGradientSampler::resolve(
        gradient,
        crate::types::Size::new(width, height),
    ) else {
        return;
    };
    draw_tiled_gradient_raster(
        content,
        pdf_writer,
        page_images,
        dimensions,
        rect,
        |px, py| {
            let fx = (px as f32 + 0.5) * width / dimensions.width as f32;
            let fy = (py as f32 + 0.5) * height / dimensions.height as f32;
            image::Rgba(sampler.sample(crate::types::Point::new(fx, fy)).to_rgba8())
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_radial_gradient_tile_raster(
    content: &mut String,
    gradient: &RadialGradient,
    rect: PdfRect,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    let PdfRect { width, height, .. } = rect;
    let Some(dimensions) =
        gradient_raster_dimensions(width, height, pdf_writer.opts.raster_quality.filter_dpi)
    else {
        return;
    };
    let Some(geometry) = RadialGradientGeometry::resolve(gradient, PdfVector::new(width, height))
    else {
        return;
    };
    let Some(ramp) = gradient.ramp.resolve(geometry.stop_basis()) else {
        return;
    };
    let center = geometry.point_center();
    let radii = geometry.point_radii();
    draw_tiled_gradient_raster(
        content,
        pdf_writer,
        page_images,
        dimensions,
        rect,
        |px, py| {
            let fx = (px as f32 + 0.5) * width / dimensions.width as f32;
            let fy = (py as f32 + 0.5) * height / dimensions.height as f32;
            let nx = (fx - center.x) / radii.x;
            let ny = (fy - center.y) / radii.y;
            let t = (nx * nx + ny * ny).sqrt();
            rgba_to_pixel(ramp.sample(t))
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_conic_gradient_tile_raster(
    content: &mut String,
    gradient: &ConicGradient,
    rect: PdfRect,
    pdf_writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
) {
    let PdfRect { width, height, .. } = rect;
    let Some(dimensions) =
        gradient_raster_dimensions(width, height, pdf_writer.opts.raster_quality.filter_dpi)
    else {
        return;
    };
    let cx = gradient.center.x.resolve(width);
    let cy = gradient.center.y.resolve(height);
    let from = gradient.from_angle.to_radians();
    let Some(ramp) = gradient.ramp.resolve(1.0) else {
        return;
    };
    draw_tiled_gradient_raster(
        content,
        pdf_writer,
        page_images,
        dimensions,
        rect,
        |px, py| {
            rgba_to_pixel(ResolvedGradientRamp::average_samples(
                [
                    (0.25_f32, 0.25_f32),
                    (0.75, 0.25),
                    (0.25, 0.75),
                    (0.75, 0.75),
                ]
                .map(|(ox, oy)| {
                    let fx = (px as f32 + ox) * width / dimensions.width as f32;
                    let fy = (py as f32 + oy) * height / dimensions.height as f32;
                    let dx = fx - cx;
                    let dy = fy - cy;
                    let angle = (dx.atan2(-dy) - from).rem_euclid(std::f32::consts::TAU);
                    let t = angle / std::f32::consts::TAU;
                    ramp.sample(t)
                }),
            ))
        },
    );
}
