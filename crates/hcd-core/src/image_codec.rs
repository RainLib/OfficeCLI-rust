use crate::HcdError;
use image::{DynamicImage, ImageDecoder, ImageFormat};
use std::io::Cursor;

pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Reject animation explicitly: static editing must never silently drop frames.
pub fn decode_raster(bytes: &[u8]) -> Result<(DynamicImage, &'static str), HcdError> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(HcdError::ResourceLimit("图片不得为空或超过 32 MiB".into()));
    }
    let format = image::guess_format(bytes).map_err(|e| HcdError::Unsupported(e.to_string()))?;
    let ext = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::WebP => "webp",
        _ => {
            return Err(HcdError::Unsupported(
                "支持静态 PNG、JPEG、WebP 图片".into(),
            ))
        }
    };
    if format == ImageFormat::WebP
        && image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(raster_error)?
            .has_animation()
    {
        return Err(HcdError::Unsupported(
            "动态 WebP 请先明确选择要编辑的帧".into(),
        ));
    }
    if format == ImageFormat::Png
        && image::codecs::png::PngDecoder::new(Cursor::new(bytes))
            .map_err(raster_error)?
            .is_apng()
            .map_err(raster_error)?
    {
        return Err(HcdError::Unsupported(
            "动态 PNG 请先明确选择要编辑的帧".into(),
        ));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(raster_error)?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 32_000_000 {
        return Err(HcdError::ResourceLimit("图片像素数不得超过 3200 万".into()));
    }
    let orientation = decoder.orientation().map_err(raster_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(raster_error)?;
    image.apply_orientation(orientation);
    Ok((image, ext))
}
fn raster_error(e: image::ImageError) -> HcdError {
    HcdError::Unsupported(format!("图片解码失败：{e}"))
}
pub fn png_bytes(image: &DynamicImage) -> Result<Vec<u8>, HcdError> {
    let mut data = Cursor::new(Vec::new());
    image
        .write_to(&mut data, ImageFormat::Png)
        .map_err(raster_error)?;
    Ok(data.into_inner())
}
