use crate::parser::png;

use crate::security::resources::ResourceLoader;

#[cfg(test)]
use super::loader::load_image_bytes;
#[cfg(test)]
use crate::layout::engine::RasterImageAsset;

/// Load image data from an inline source in tests.
#[cfg(test)]
pub(crate) fn load_image_data(src: &str) -> Option<RasterImageAsset> {
    let loaded = ResourceLoader::default().load_document_resource(src)?;
    load_image_bytes(loaded.bytes)
}

pub(crate) fn build_raster_background_tree(
    resources: &mut ResourceLoader,
    src: &str,
) -> Option<crate::parser::svg::SvgTree> {
    let image_src = crate::parser::css::extract_url_path(src).unwrap_or_else(|| src.to_string());
    let loaded = resources.load_document_resource(&image_src)?;
    let (width, height) = raster_image_dimensions(&loaded.bytes)?;

    Some(crate::parser::svg::SvgTree {
        width: width as f32,
        height: height as f32,
        width_attr: None,
        height_attr: None,
        preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::default(),
        view_box: None,
        defs: crate::parser::svg::SvgDefs::default(),
        children: vec![crate::parser::svg::SvgNode::Image {
            x: 0.0,
            y: 0.0,
            width: width as f32,
            height: height as f32,
            href: image_src,
            preserve_aspect_ratio: crate::parser::svg::SvgPreserveAspectRatio::None,
            style: crate::parser::svg::SvgStyle::default(),
        }],
        text_ctx: crate::parser::svg::SvgTextContext::default(),
        source_markup: None,
    })
}

pub(crate) fn raster_image_dimensions(raw: &[u8]) -> Option<(u32, u32)> {
    if png::is_png(raw) {
        let png_info = png::parse_png(raw)?;
        Some((png_info.width, png_info.height))
    } else {
        let image = image::load_from_memory(raw).ok()?;
        Some((image.width(), image.height()))
    }
}

pub(super) fn decode_image_for_blur(raw: &[u8]) -> Option<image::DynamicImage> {
    if png::is_png(raw) {
        decode_png_for_blur(raw)
    } else {
        image::load_from_memory(raw).ok()
    }
}

fn decode_png_for_blur(data: &[u8]) -> Option<image::DynamicImage> {
    use image::{DynamicImage, ImageBuffer};

    let mut decoder = png_decoder::Decoder::new(std::io::Cursor::new(data));
    decoder.ignore_checksums(true);
    let mut reader = decoder.read_info().ok()?;
    let output_size = reader.output_buffer_size()?;
    let mut buf = vec![0; output_size];
    let info = reader.next_frame(&mut buf).ok()?;
    let width = info.width;
    let height = info.height;
    let used = info.buffer_size();
    let buf = buf.get(..used)?.to_vec();

    match info.color_type {
        png_decoder::ColorType::Rgba => {
            let image = ImageBuffer::from_raw(width, height, buf)?;
            Some(DynamicImage::ImageRgba8(image))
        }
        png_decoder::ColorType::Rgb => {
            let image = ImageBuffer::from_raw(width, height, buf)?;
            Some(DynamicImage::ImageRgb8(image))
        }
        png_decoder::ColorType::Grayscale => {
            let image = ImageBuffer::from_raw(width, height, buf)?;
            Some(DynamicImage::ImageLuma8(image))
        }
        png_decoder::ColorType::GrayscaleAlpha => {
            let image = ImageBuffer::from_raw(width, height, buf)?;
            Some(DynamicImage::ImageLumaA8(image))
        }
        _ => image::load_from_memory(data).ok(),
    }
}

#[cfg(test)]
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(*chunk.first().unwrap_or(&0));
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;

        append_base64_char(&mut result, CHARS, ((triple >> 18) & 0x3F) as usize);
        append_base64_char(&mut result, CHARS, ((triple >> 12) & 0x3F) as usize);

        if chunk.len() > 1 {
            append_base64_char(&mut result, CHARS, ((triple >> 6) & 0x3F) as usize);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            append_base64_char(&mut result, CHARS, (triple & 0x3F) as usize);
        } else {
            result.push('=');
        }
    }

    result
}

#[cfg(test)]
fn append_base64_char(out: &mut String, table: &[u8], index: usize) {
    if let Some(&byte) = table.get(index) {
        out.push(char::from(byte));
    }
}
