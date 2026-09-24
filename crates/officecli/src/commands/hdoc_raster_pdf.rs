//! Memory-bounded visual PDF reconstruction from HCD's final page rasters.
//! JPEG streams stay compressed in the PDF object graph; PNG pages are decoded
//! and compressed one at a time. This path deliberately reports VISUAL fidelity.
use handler_common::HandlerError;
use hcd_core::{hash_file, Bundle, HcdManifest};
use image::ImageDecoder;
use lopdf::{dictionary, Document, Object, Stream};
use regex::Regex;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

fn error(message: impl std::fmt::Display) -> HandlerError {
    HandlerError::OperationFailed(message.to_string())
}

pub(super) fn export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    revision: u64,
    output: &Path,
) -> Result<usize, HandlerError> {
    let assets: HashMap<String, _> = bundle
        .read_asset_index_for_revision(revision)
        .map_err(error)?
        .into_iter()
        .map(|asset| (asset.hash.clone(), asset))
        .collect();
    let dimensions = Regex::new(r#"<section[^>]*class="hcd-pdf-page"[^>]*style="[^"]*width:([0-9.]+)pt;height:([0-9.]+)pt[^"]*""#)
        .map_err(error)?;
    let raster = Regex::new(
        r#"<img[^>]*class="hcd-pdf-page-raster"[^>]*src="asset://sha256/([0-9a-f]{64})""#,
    )
    .map_err(error)?;
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let mut kids = Vec::new();
    let mut count = 0usize;
    for page_number in 0..manifest.index_page_count {
        let page = bundle
            .read_index_page(manifest, page_number)
            .map_err(error)?;
        for descriptor in &page.chunks {
            let html = bundle.read_chunk_verified(descriptor).map_err(error)?;
            let Some(caps) = raster.captures(&html) else {
                continue;
            };
            let size = dimensions
                .captures(&html)
                .ok_or_else(|| error("PDF raster page has no dimensions"))?;
            let width: f32 = size[1].parse().map_err(error)?;
            let height: f32 = size[2].parse().map_err(error)?;
            if !width.is_finite()
                || !height.is_finite()
                || width <= 0.0
                || height <= 0.0
                || width > 14_400.0
                || height > 14_400.0
            {
                return Err(error("PDF raster page dimensions exceed safe limits"));
            }
            let hash = &caps[1];
            let asset = assets
                .get(hash)
                .ok_or_else(|| error(format!("missing page raster asset {hash}")))?;
            if asset.byte_length > 64 * 1024 * 1024 {
                return Err(error("page raster exceeds 64 MiB"));
            }
            let path = bundle.resolve_href(&asset.href).map_err(error)?;
            if hash_file(&path).map_err(error)? != hash {
                return Err(error("page raster hash mismatch"));
            }
            let bytes = std::fs::read(&path).map_err(error)?;
            if bytes.len() as u64 != asset.byte_length {
                return Err(error("page raster length mismatch"));
            }
            let image_stream = if bytes.starts_with(b"\xff\xd8") {
                let decoder =
                    image::codecs::jpeg::JpegDecoder::new(Cursor::new(&bytes)).map_err(error)?;
                let (pixels_width, pixels_height) = decoder.dimensions();
                let color_space = match decoder.color_type() {
                    image::ColorType::L8 => "DeviceGray",
                    image::ColorType::Rgb8 => "DeviceRGB",
                    other => return Err(error(format!("unsupported JPEG color type {other:?}"))),
                };
                Stream::new(
                    dictionary! {
                        "Type" => "XObject", "Subtype" => "Image",
                        "Width" => i64::from(pixels_width), "Height" => i64::from(pixels_height),
                        "ColorSpace" => color_space, "BitsPerComponent" => 8,
                        "Filter" => "DCTDecode",
                    },
                    bytes,
                )
            } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                let image = image::load_from_memory(&bytes).map_err(error)?.to_rgb8();
                let (pixels_width, pixels_height) = image.dimensions();
                let mut stream = Stream::new(
                    dictionary! {
                        "Type" => "XObject", "Subtype" => "Image",
                        "Width" => i64::from(pixels_width), "Height" => i64::from(pixels_height),
                        "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                    },
                    image.into_raw(),
                );
                stream.compress().map_err(error)?;
                stream
            } else {
                return Err(error("unsupported page raster encoding"));
            };
            let image_id = document.add_object(Object::Stream(image_stream));
            let content = format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q\n");
            let content_id = document.add_object(Object::Stream(Stream::new(
                dictionary! {},
                content.into_bytes(),
            )));
            let page_id = document.new_object_id();
            document.set_object(page_id, Object::Dictionary(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![Object::Integer(0), Object::Integer(0), Object::Real(width), Object::Real(height)],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
                "Contents" => content_id,
            }));
            kids.push(Object::Reference(page_id));
            count += 1;
        }
    }
    if count == 0 {
        return Err(error("HCD PDF has no composited page rasters"));
    }
    document.set_object(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => i64::try_from(count).map_err(error)?,
        }),
    );
    let catalog_id = document.new_object_id();
    document.set_object(
        catalog_id,
        Object::Dictionary(dictionary! { "Type" => "Catalog", "Pages" => pages_id }),
    );
    document.trailer.set("Root", Object::Reference(catalog_id));
    let temporary = output.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    document.save(&temporary).map_err(error)?;
    std::fs::rename(&temporary, output).map_err(error)?;
    Ok(count)
}
