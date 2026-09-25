//! Memory-bounded visual PDF reconstruction from HCD's final page rasters.
//! JPEG streams stay compressed in the PDF object graph; PNG pages are decoded
//! and compressed one at a time. This path deliberately reports VISUAL fidelity.
use handler_common::HandlerError;
use hcd_core::{hash_file, Bundle, HcdManifest};
use image::ImageDecoder;
use lopdf::{dictionary, Document, Object, Stream};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;

fn error(message: impl std::fmt::Display) -> HandlerError {
    HandlerError::OperationFailed(message.to_string())
}

struct EditedText {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    size: f32,
}

fn attribute<'a>(attributes: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!(" {name}=\"");
    let start = attributes.find(&needle)? + needle.len();
    let end = attributes[start..].find('"')? + start;
    Some(&attributes[start..end])
}

fn edited_text(html: &str, pattern: &Regex) -> Result<Vec<EditedText>, HandlerError> {
    let mut result = Vec::new();
    for capture in pattern.captures_iter(html) {
        let paragraph = &capture[1];
        if !capture[2].contains(" data-hcd-patched=\"true\"") {
            continue;
        }
        let number = |name: &str| -> Result<f32, HandlerError> {
            let value: f32 = attribute(paragraph, name)
                .ok_or_else(|| error(format!("edited PDF node lacks {name}")))?
                .parse()
                .map_err(error)?;
            if !value.is_finite() || value.abs() > 14_400.0 {
                return Err(error("edited PDF text geometry exceeds safe limits"));
            }
            Ok(value)
        };
        let style =
            attribute(paragraph, "style").ok_or_else(|| error("edited PDF text lacks style"))?;
        let size: f32 = style
            .split(';')
            .find_map(|property| property.trim().strip_prefix("font-size:"))
            .and_then(|value| value.strip_suffix("pt"))
            .ok_or_else(|| error("edited PDF text lacks point font size"))?
            .parse()
            .map_err(error)?;
        if !size.is_finite() || !(1.0..=256.0).contains(&size) {
            return Err(error("edited PDF font size exceeds safe limits"));
        }
        let text = quick_xml::escape::unescape(&capture[3])
            .map_err(error)?
            .replace(['\r', '\n'], " ");
        if text.chars().count() > 10_000 {
            return Err(error("edited PDF text exceeds 10,000 characters"));
        }
        result.push(EditedText {
            text,
            x: number("data-hcd-x")?,
            y: number("data-hcd-y")?,
            width: number("data-hcd-width")?,
            height: number("data-hcd-height")?,
            size,
        });
    }
    Ok(result)
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
    let patched_text =
        Regex::new(r#"(?s)<p class="hcd-pdf-text"([^>]*)><span ([^>]*)>(.*?)</span></p>"#)
            .map_err(error)?;
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let mut kids = Vec::new();
    let mut count = 0usize;
    let mut pending_text: Vec<(usize, Vec<EditedText>)> = Vec::new();
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
            let edits = edited_text(&html, &patched_text)?;
            let mut content = format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q\n");
            for edit in &edits {
                if edit.width <= 0.0
                    || edit.height <= 0.0
                    || edit.x < 0.0
                    || edit.y < 0.0
                    || edit.x >= width
                    || edit.y >= height
                {
                    return Err(error("edited PDF text box has invalid dimensions"));
                }
                let estimated_width: f32 = edit
                    .text
                    .chars()
                    .map(|character| {
                        if character.is_ascii() {
                            edit.size * 0.6
                        } else {
                            edit.size
                        }
                    })
                    .sum();
                let cover_width = edit.width.max(estimated_width).min(width - edit.x) + 2.0;
                content.push_str(&format!(
                    "q 1 1 1 rg {:.2} {:.2} {:.2} {:.2} re f Q\n",
                    (edit.x - 1.0).max(0.0),
                    (edit.y - 1.0).max(0.0),
                    cover_width,
                    edit.height + 2.0
                ));
            }
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
            // Add editable text after the source image and its white masks.
            // The embedded subset makes CJK edits independent of system fonts.
            if edits.iter().any(|edit| !edit.text.is_empty()) {
                // Page tree is completed below, so defer font registration.
                pending_text.push((count, edits));
            }
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
    for (page_number, edits) in pending_text {
        let characters: HashSet<char> = edits.iter().flat_map(|edit| edit.text.chars()).collect();
        let font = pdf_handler::font_embedder::ensure_cjk_font_for_chars(
            &mut document,
            page_number,
            &characters,
            Some("HCDEdit"),
            None,
            true,
        )?
        .ok_or_else(|| error("edited PDF text font was not embedded"))?;
        for edit in edits {
            if !edit.text.is_empty() {
                pdf_handler::modifier::add_text_block_with_ready_font(
                    &mut document,
                    page_number,
                    &edit.text,
                    edit.x,
                    edit.y + 1.0,
                    &font,
                    edit.size,
                )?;
            }
        }
    }
    let temporary = output.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    document.save(&temporary).map_err(error)?;
    std::fs::rename(&temporary, output).map_err(error)?;
    Ok(count)
}
