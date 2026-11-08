use super::*;

/// Default quality for automatic JPEG re-encoding of large opaque images.
///
/// This keeps the automatic size optimization visually lossless at normal
/// viewing distance. Callers who explicitly trade quality for size can choose
/// a lower value through `HtmlConverter::jpeg_quality` or `--jpeg-quality`.
pub(crate) const DEFAULT_JPEG_QUALITY: u8 = 95;

/// A reference to an XObject used on a page.
#[derive(Clone)]
pub(crate) struct ImageRef {
    pub name: String,
    pub obj_id: usize,
}

pub(super) struct SvgPageImageSink<'a> {
    pub(super) pdf_writer: &'a mut PdfWriter,
    pub(super) page_images: &'a mut Vec<ImageRef>,
}

impl SvgPageImageSink<'_> {
    pub(super) fn register_page_image(&mut self, obj_id: usize) -> String {
        let name = format!("Im{obj_id}");
        self.page_images.push(ImageRef {
            name: name.clone(),
            obj_id,
        });
        name
    }
}

impl crate::render::svg_to_pdf::SvgImageObjectSink for SvgPageImageSink<'_> {
    fn load_resource(
        &mut self,
        reference: &str,
    ) -> Option<crate::security::resources::LoadedResource> {
        self.pdf_writer.resources.load_document_resource(reference)
    }

    fn register_raster(
        &mut self,
        raw_image: &[u8],
        display_w_pt: f32,
        display_h_pt: f32,
    ) -> Option<String> {
        let asset = crate::layout::images::load_image_bytes(raw_image.to_vec())?;
        let obj_id = self.pdf_writer.add_decodable_source_image_object(
            &asset.data,
            asset.source_width,
            asset.source_height,
            asset.format,
            asset.png_metadata.as_ref(),
            display_w_pt,
            display_h_pt,
        )?;
        Some(self.register_page_image(obj_id))
    }
}

pub(super) struct DecodedPngImage {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) color_space: &'static str,
    pub(super) color_data: Vec<u8>,
    pub(super) alpha_data: Option<Vec<u8>>,
}

pub(super) fn decode_png_for_pdf(raw: &[u8]) -> Option<DecodedPngImage> {
    let mut decoder = png_decoder::Decoder::new(std::io::Cursor::new(raw));
    decoder.ignore_checksums(true);
    let mut reader = decoder.read_info().ok()?;
    let output_size = reader.output_buffer_size()?;
    let mut buffer = vec![0; output_size];
    let info = reader.next_frame(&mut buffer).ok()?;
    let pixels = buffer.get(..info.buffer_size())?;

    let mut color_data = Vec::new();
    let mut alpha_data = Vec::new();
    let mut has_alpha = false;
    let color_space = match info.color_type {
        png_decoder::ColorType::Rgba => {
            color_data.reserve((info.width * info.height * 3) as usize);
            alpha_data.reserve((info.width * info.height) as usize);
            for chunk in pixels.chunks_exact(4) {
                color_data.extend_from_slice(&chunk[..3]);
                alpha_data.push(chunk[3]);
            }
            has_alpha = true;
            "/DeviceRGB"
        }
        png_decoder::ColorType::Rgb => {
            color_data.extend_from_slice(pixels);
            "/DeviceRGB"
        }
        png_decoder::ColorType::Grayscale => {
            color_data.extend_from_slice(pixels);
            "/DeviceGray"
        }
        png_decoder::ColorType::GrayscaleAlpha => {
            color_data.reserve((info.width * info.height) as usize);
            alpha_data.reserve((info.width * info.height) as usize);
            for chunk in pixels.chunks_exact(2) {
                color_data.push(chunk[0]);
                alpha_data.push(chunk[1]);
            }
            has_alpha = true;
            "/DeviceGray"
        }
        _ => return None,
    };

    Some(DecodedPngImage {
        width: info.width,
        height: info.height,
        color_space,
        color_data,
        alpha_data: has_alpha.then_some(alpha_data),
    })
}

pub(super) fn flate_compress(data: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

pub(super) fn encode_rgb_as_jpeg(
    rgb: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Option<Vec<u8>> {
    use image::ImageEncoder;

    if rgb.len() != width.checked_mul(height)?.checked_mul(3)? as usize {
        return None;
    }
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(0, 100))
        .write_image(rgb, width, height, image::ExtendedColorType::Rgb8)
        .ok()?;
    Some(buf)
}

pub(super) fn encode_gray_as_jpeg(
    gray: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Option<Vec<u8>> {
    use image::ImageEncoder;

    if gray.len() != width.checked_mul(height)? as usize {
        return None;
    }
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(0, 100))
        .write_image(gray, width, height, image::ExtendedColorType::L8)
        .ok()?;
    Some(buf)
}

pub(super) fn try_decode_png_as_opaque_rgb(raw_png: &[u8]) -> Option<DecodedPngImage> {
    let decoded = decode_png_for_pdf(raw_png)?;
    if decoded.color_space != "/DeviceRGB" {
        return None;
    }
    if decoded.color_data.len()
        != decoded.width.checked_mul(decoded.height)?.checked_mul(3)? as usize
    {
        return None;
    }
    if decoded
        .alpha_data
        .as_ref()
        .is_some_and(|alpha| alpha.iter().any(|a| *a != 255))
    {
        return None;
    }
    Some(decoded)
}

pub(super) fn should_try_lossy_png_reencode(width: u32, height: u32, byte_len: usize) -> bool {
    const MIN_LOSSY_PNG_PIXELS: u64 = 16_384;
    const MIN_LOSSY_PNG_BYTES: usize = 16 * 1024;

    u64::from(width) * u64::from(height) >= MIN_LOSSY_PNG_PIXELS && byte_len >= MIN_LOSSY_PNG_BYTES
}

pub(super) struct ResizedImage {
    pub(super) data: Vec<u8>,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) format: ImageFormat,
    pub(super) png_metadata: Option<PngMetadata>,
}
