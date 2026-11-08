use std::borrow::Cow;
use std::num::NonZeroU32;

use crate::layout::engine::{ImageFormat, PngMetadata, RasterImageAsset};
use crate::parser::png;
use crate::types::Rect;
use crate::util::RasterDimensions;

use super::source::decode_image_for_blur;

/// Decode a PNG that cannot use the lightweight pass-through path.
pub(super) fn decode_png_to_rgb_asset(raw: &[u8]) -> Option<RasterImageAsset> {
    let rgb = image::load_from_memory(raw).ok()?.to_rgb8();
    let (width, height) = (rgb.width(), rgb.height());
    let mut encoded = Vec::new();
    image::DynamicImage::ImageRgb8(rgb)
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .ok()?;
    let png_info = png::parse_png(&encoded)?;
    Some(RasterImageAsset::source(
        encoded,
        width,
        height,
        ImageFormat::Png,
        Some(PngMetadata {
            channels: png_info.channels,
            bit_depth: png_info.bit_depth,
        }),
    ))
}

/// A non-empty source-pixel rectangle proven to lie on whole pixel boundaries
/// inside its raster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RasterCrop {
    x: u32,
    y: u32,
    width: NonZeroU32,
    height: NonZeroU32,
}

impl RasterCrop {
    /// Parse layout geometry into an exact pixel crop. Fractional or
    /// out-of-bounds geometry is not silently rounded because doing so changes
    /// which authored pixels participate in image sampling.
    pub(crate) fn aligned(rect: Rect, source: RasterDimensions) -> Option<Self> {
        let aligned = |value: f32| {
            let rounded = value.round();
            (value.is_finite() && (value - rounded).abs() <= 1e-5 && rounded >= 0.0)
                .then_some(rounded as u32)
        };
        let x = aligned(rect.origin.x)?;
        let y = aligned(rect.origin.y)?;
        let width = NonZeroU32::new(aligned(rect.size.width)?)?;
        let height = NonZeroU32::new(aligned(rect.size.height)?)?;
        (x.checked_add(width.get())? <= source.width
            && y.checked_add(height.get())? <= source.height)
            .then_some(Self {
                x,
                y,
                width,
                height,
            })
    }
}

/// Return a self-contained asset holding only a prevalidated source-pixel crop.
pub(crate) fn crop_raster_asset(
    asset: &RasterImageAsset,
    crop: RasterCrop,
) -> Option<RasterImageAsset> {
    let rgba = decode_asset_to_rgba(asset)?;
    if (rgba.width(), rgba.height()) != (asset.source_width, asset.source_height) {
        return None;
    }
    let sub = image::imageops::crop_imm(&rgba, crop.x, crop.y, crop.width.get(), crop.height.get())
        .to_image();
    encode_rgba_subimage_as_asset(sub, asset.origin)
}

/// Return a complete PNG file for decoders from either a complete PNG asset or
/// the legacy raw-IDAT storage used by some older opaque PNG paths.
pub(crate) fn png_bytes_for_decoding<'a>(
    data: &'a [u8],
    width: u32,
    height: u32,
    png_metadata: Option<&PngMetadata>,
) -> Option<Cow<'a, [u8]>> {
    if png::is_png(data) {
        return Some(Cow::Borrowed(data));
    }
    let meta = png_metadata?;
    let color_type = match meta.channels {
        1 => 0,
        2 => 4,
        3 => 2,
        4 => 6,
        _ => return None,
    };
    Some(Cow::Owned(reconstruct_png(
        width,
        height,
        meta.bit_depth,
        color_type,
        data,
    )))
}

/// Decode a stored [`RasterImageAsset`] back to RGBA pixels regardless of its
/// storage format.
pub(crate) fn decode_asset_to_rgba(asset: &RasterImageAsset) -> Option<image::RgbaImage> {
    match asset.format {
        ImageFormat::Jpeg => Some(image::load_from_memory(&asset.data).ok()?.to_rgba8()),
        ImageFormat::PngAlpha => Some(decode_image_for_blur(&asset.data)?.to_rgba8()),
        ImageFormat::Png => {
            let png = png_bytes_for_decoding(
                &asset.data,
                asset.source_width,
                asset.source_height,
                asset.png_metadata.as_ref(),
            )?;
            Some(decode_image_for_blur(&png)?.to_rgba8())
        }
    }
}

/// Re-encode a cropped RGBA buffer into an embeddable asset: a lossless RGB PNG
/// when every pixel is opaque, or a full RGBA PNG (the alpha-preserving
/// `/SMask` embedding path) otherwise.
fn encode_rgba_subimage_as_asset(
    sub: image::RgbaImage,
    origin: crate::layout::engine::RasterImageOrigin,
) -> Option<RasterImageAsset> {
    let (w, h) = (sub.width(), sub.height());
    let opaque = sub.pixels().all(|p| p[3] == 255);
    if opaque {
        let mut rgb = image::RgbImage::new(w, h);
        for (dst, src) in rgb.pixels_mut().zip(sub.pixels()) {
            *dst = image::Rgb([src[0], src[1], src[2]]);
        }
        let mut encoded = Vec::new();
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .ok()?;
        let info = png::parse_png(&encoded)?;
        Some(RasterImageAsset::with_origin(
            encoded,
            w,
            h,
            ImageFormat::Png,
            Some(PngMetadata {
                channels: info.channels,
                bit_depth: info.bit_depth,
            }),
            origin,
        ))
    } else {
        let mut encoded = Vec::new();
        image::DynamicImage::ImageRgba8(sub)
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .ok()?;
        Some(RasterImageAsset::with_origin(
            encoded,
            w,
            h,
            ImageFormat::PngAlpha,
            None,
            origin,
        ))
    }
}

/// Wrap a raw IDAT (zlib) stream back into a minimal, valid PNG file (signature +
/// IHDR + IDAT + IEND, each with a correct CRC-32) so the standard image decoder
/// can read pixels from an opaque-PNG asset that only stored its IDAT.
fn reconstruct_png(width: u32, height: u32, bit_depth: u8, color_type: u8, idat: &[u8]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let crc_start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[crc_start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }
    let mut out = Vec::with_capacity(8 + 25 + idat.len() + 12);
    out.extend_from_slice(&png::PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(bit_depth);
    ihdr.push(color_type);
    ihdr.push(0); // compression method
    ihdr.push(0); // filter method
    ihdr.push(0); // interlace method
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", idat);
    chunk(&mut out, b"IEND", &[]);
    out
}
