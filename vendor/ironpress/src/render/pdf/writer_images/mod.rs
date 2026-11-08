use super::*;

mod cache;
mod scale;
mod streams;

pub(super) use cache::LayoutImageCacheKey;
use scale::CssRasterScale;

#[derive(Clone, Copy)]
pub(super) enum PdfImageInterpolation {
    Default,
    Smooth,
    Crisp,
}

impl PdfImageInterpolation {
    pub(super) fn for_css_image_rendering(
        image_rendering: crate::style::computed::ImageRendering,
    ) -> Self {
        if image_rendering.preserves_source_edges() {
            Self::Crisp
        } else if image_rendering.requests_smooth_pdf_interpolation() {
            Self::Smooth
        } else {
            Self::Default
        }
    }

    const fn pdf_dictionary_entry(self) -> &'static str {
        match self {
            Self::Default => "",
            Self::Smooth => " /Interpolate true",
            Self::Crisp => " /Interpolate false",
        }
    }

    const fn preserves_source_edges(self) -> bool {
        matches!(self, Self::Crisp)
    }
}

impl PdfWriter {
    /// Embed a layout image at its display size.
    ///
    /// Document source images participate in the configurable source-image
    /// downscaling policy. Renderer-owned rasters keep their native dimensions:
    /// their pixels were deliberately generated at a filter or background DPI.
    pub(crate) fn add_layout_image_object(
        &mut self,
        image: &crate::layout::engine::RasterImageAsset,
        display_w_pt: f32,
        display_h_pt: f32,
        image_rendering: crate::style::computed::ImageRendering,
    ) -> usize {
        let cache_key =
            LayoutImageCacheKey::new(image, display_w_pt, display_h_pt, image_rendering);
        if let Some(object_id) = self.layout_image_objects.get(&cache_key) {
            return *object_id;
        }
        let interpolation = PdfImageInterpolation::for_css_image_rendering(image_rendering);
        let object_id = if image.origin.preserves_native_resolution() {
            self.add_image_object_with_interpolation(
                &image.data,
                image.source_width,
                image.source_height,
                image.format,
                image.png_metadata.as_ref(),
                interpolation,
            )
        } else if image_rendering.is_pixelated() {
            self.add_pixelated_source_image_object(
                &image.data,
                image.source_width,
                image.source_height,
                display_w_pt,
                display_h_pt,
            )
            .unwrap_or_else(|| {
                self.add_image_object_with_interpolation(
                    &image.data,
                    image.source_width,
                    image.source_height,
                    image.format,
                    image.png_metadata.as_ref(),
                    interpolation,
                )
            })
        } else {
            self.add_source_image_object_with_interpolation(
                &image.data,
                image.source_width,
                image.source_height,
                image.format,
                image.png_metadata.as_ref(),
                display_w_pt,
                display_h_pt,
                interpolation,
            )
        };
        self.layout_image_objects.insert(cache_key, object_id);
        object_id
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_source_image_object(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
        display_w_pt: f32,
        display_h_pt: f32,
    ) -> usize {
        self.add_source_image_object_with_interpolation(
            data,
            width,
            height,
            format,
            png_metadata,
            display_w_pt,
            display_h_pt,
            PdfImageInterpolation::Default,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn add_source_image_object_with_interpolation(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
        display_w_pt: f32,
        display_h_pt: f32,
        interpolation: PdfImageInterpolation,
    ) -> usize {
        if let Some(resized) = self.maybe_resize_image(
            data,
            width,
            height,
            format,
            png_metadata,
            display_w_pt,
            display_h_pt,
        ) {
            self.add_image_object_with_interpolation(
                &resized.data,
                resized.width,
                resized.height,
                resized.format,
                resized.png_metadata.as_ref(),
                interpolation,
            )
        } else {
            self.add_image_object_with_interpolation(
                data,
                width,
                height,
                format,
                png_metadata,
                interpolation,
            )
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_pixelated_source_image_object(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        display_w_pt: f32,
        display_h_pt: f32,
    ) -> Option<usize> {
        if width == 0 || height == 0 || display_w_pt <= 0.0 || display_h_pt <= 0.0 {
            return None;
        }
        let scale = CssRasterScale::parse(width, height, display_w_pt, display_h_pt)?;
        if scale.is_integral_multiple() {
            return None;
        }
        let raster = crate::render::blur::pixelated_image_at_css_size(
            &image::load_from_memory(data).ok()?.to_rgba8(),
            display_w_pt,
            display_h_pt,
        )?;
        if (raster.width(), raster.height()) == (width, height) {
            return None;
        }
        let width = raster.width();
        let height = raster.height();
        let opaque = raster.pixels().all(|pixel| pixel[3] == 255);
        let mut data = Vec::new();
        let (format, png_metadata) = if opaque {
            image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(raster).to_rgb8())
                .write_to(
                    &mut std::io::Cursor::new(&mut data),
                    image::ImageFormat::Png,
                )
                .ok()?;
            let png_metadata = crate::parser::png::parse_png(&data).map(|info| PngMetadata {
                channels: info.channels,
                bit_depth: info.bit_depth,
            });
            (ImageFormat::Png, png_metadata)
        } else {
            image::DynamicImage::ImageRgba8(raster)
                .write_to(
                    &mut std::io::Cursor::new(&mut data),
                    image::ImageFormat::Png,
                )
                .ok()?;
            let png_metadata = crate::parser::png::parse_png(&data).map(|info| PngMetadata {
                channels: info.channels,
                bit_depth: info.bit_depth,
            });
            (ImageFormat::PngAlpha, png_metadata)
        };
        Some(self.add_image_object_with_interpolation(
            &data,
            width,
            height,
            format,
            png_metadata.as_ref(),
            PdfImageInterpolation::Crisp,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_decodable_source_image_object(
        &mut self,
        data: &[u8],
        width: u32,
        height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
        display_w_pt: f32,
        display_h_pt: f32,
    ) -> Option<usize> {
        if matches!(format, ImageFormat::Png | ImageFormat::PngAlpha)
            && decode_png_for_pdf(data).is_none()
        {
            return None;
        }
        Some(self.add_source_image_object(
            data,
            width,
            height,
            format,
            png_metadata,
            display_w_pt,
            display_h_pt,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn maybe_resize_image(
        &self,
        data: &[u8],
        source_width: u32,
        source_height: u32,
        format: ImageFormat,
        png_metadata: Option<&PngMetadata>,
        display_w_pt: f32,
        display_h_pt: f32,
    ) -> Option<ResizedImage> {
        if !self.opts.auto_resize_images
            || source_width == 0
            || source_height == 0
            || display_w_pt <= 0.0
            || display_h_pt <= 0.0
        {
            return None;
        }

        let scale = crate::render::raster_scale::RasterScale::at_dpi(
            self.opts.raster_quality.source_image_dpi,
        );
        let target_w = scale.sample_count(display_w_pt)?;
        let target_h = scale.sample_count(display_h_pt)?;
        let scale = ((target_w as f32 / source_width as f32)
            .min(target_h as f32 / source_height as f32))
        .min(1.0);
        if scale >= 1.0 {
            return None;
        }
        let new_w = ((source_width as f32 * scale).round().max(1.0) as u32).min(source_width);
        let new_h = ((source_height as f32 * scale).round().max(1.0) as u32).min(source_height);
        if new_w >= source_width && new_h >= source_height {
            return None;
        }

        match format {
            ImageFormat::Jpeg => {
                let decoded = image::load_from_memory(data).ok()?.to_rgb8();
                let resized = image::imageops::resize(
                    &decoded,
                    new_w,
                    new_h,
                    image::imageops::FilterType::Lanczos3,
                );
                let encoded =
                    encode_rgb_as_jpeg(resized.as_raw(), new_w, new_h, self.opts.jpeg_quality)?;
                Some(ResizedImage {
                    data: encoded,
                    width: new_w,
                    height: new_h,
                    format: ImageFormat::Jpeg,
                    png_metadata: None,
                })
            }
            ImageFormat::Png | ImageFormat::PngAlpha => {
                let png = crate::layout::images::png_bytes_for_decoding(
                    data,
                    source_width,
                    source_height,
                    png_metadata,
                )?;
                let decoded = image::load_from_memory(&png).ok()?;
                let has_alpha = matches!(
                    decoded.color(),
                    image::ColorType::La8
                        | image::ColorType::La16
                        | image::ColorType::Rgba8
                        | image::ColorType::Rgba16
                        | image::ColorType::Rgba32F
                );
                let mut encoded = Vec::new();
                let output_format = if has_alpha {
                    let rgba = decoded.to_rgba8();
                    let resized = image::imageops::resize(
                        &rgba,
                        new_w,
                        new_h,
                        image::imageops::FilterType::Lanczos3,
                    );
                    image::DynamicImage::ImageRgba8(resized)
                        .write_to(
                            &mut std::io::Cursor::new(&mut encoded),
                            image::ImageFormat::Png,
                        )
                        .ok()?;
                    ImageFormat::PngAlpha
                } else {
                    let rgb = decoded.to_rgb8();
                    let resized = image::imageops::resize(
                        &rgb,
                        new_w,
                        new_h,
                        image::imageops::FilterType::Lanczos3,
                    );
                    image::DynamicImage::ImageRgb8(resized)
                        .write_to(
                            &mut std::io::Cursor::new(&mut encoded),
                            image::ImageFormat::Png,
                        )
                        .ok()?;
                    ImageFormat::Png
                };
                let png_metadata =
                    crate::parser::png::parse_png(&encoded).map(|info| PngMetadata {
                        channels: info.channels,
                        bit_depth: info.bit_depth,
                    });
                Some(ResizedImage {
                    data: encoded,
                    width: new_w,
                    height: new_h,
                    format: output_format,
                    png_metadata,
                })
            }
        }
    }
}
