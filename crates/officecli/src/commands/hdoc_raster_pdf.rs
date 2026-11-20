//! Memory-bounded visual PDF reconstruction from HCD's final page rasters.
//! JPEG streams stay compressed in the PDF object graph; PNG pages are decoded
//! and compressed one at a time. This path deliberately reports VISUAL fidelity.
use handler_common::HandlerError;
use hcd_core::{hash_file, Bundle, HcdManifest};
use image::ImageDecoder;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use pdf_handler::ocr_text::{append_ocr_text, OcrTextLine, OcrTextPage};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;

use super::hdoc::PdfPageRange;

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

struct PageOverlay {
    source_page: Option<u32>,
    position: usize,
    page_id: ObjectId,
    width: f32,
    height: f32,
    content_id: ObjectId,
    edits: Vec<EditedText>,
    source_ocr: Vec<OcrTextLine>,
}

pub(super) struct RasterPdfExport {
    pub pages: usize,
    pub ocr_pages: usize,
    pub edited_text: bool,
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
        if !capture[2].contains(" data-hcd-patched=\"true\"")
            || matches!(
                attribute(paragraph, "data-hcd-mapping"),
                Some("ocr" | "source-ocr")
            )
        {
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

fn source_ocr_text(
    html: &str,
    pattern: &Regex,
    page_height: f32,
) -> Result<Vec<OcrTextLine>, HandlerError> {
    let mut lines = Vec::new();
    if !html.contains(" data-hcd-mapping=\"source-ocr\"") {
        return Ok(lines);
    }
    for capture in pattern.captures_iter(html) {
        if attribute(&capture[1], "data-hcd-mapping") != Some("source-ocr") {
            continue;
        }
        let text = quick_xml::escape::unescape(&capture[3]).map_err(error)?;
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let Some(style) = attribute(&capture[1], "style") else {
            continue;
        };
        let points = |property: &str| {
            style
                .split(';')
                .find_map(|value| {
                    value
                        .trim()
                        .strip_prefix(property)?
                        .strip_suffix("pt")?
                        .parse::<f32>()
                        .ok()
                })
                .filter(|value| value.is_finite() && value.abs() <= 14_400.0)
        };
        let [Some(left), Some(top), Some(width), Some(height)] = [
            points("left:"),
            points("top:"),
            points("width:"),
            points("height:"),
        ] else {
            continue;
        };
        if !text.is_empty() && width > 0.0 && height > 0.0 {
            lines.push(OcrTextLine::from_display_box(
                text,
                [left, top, width, height],
                page_height,
            ));
        }
    }
    Ok(lines)
}

pub(super) fn export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    revision: u64,
    output: &Path,
    range: Option<PdfPageRange>,
) -> Result<RasterPdfExport, HandlerError> {
    let layout = hcd_core::pdf_page_layout(bundle, manifest).map_err(error)?;
    let selected_layout = match (layout.is_empty(), range) {
        (false, Some(range)) => layout
            .get(range.start - 1..range.end)
            .ok_or_else(|| error("requested PDF pages exceed the document"))?,
        _ => &layout,
    };
    let placements: HashMap<_, _> = selected_layout
        .iter()
        .enumerate()
        .filter_map(|(position, page)| {
            page.source_page
                .map(|source| (source, (position, page.rotation)))
        })
        .collect();
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
    let page_label = Regex::new(r#"^<section[^>]*data-hcd-page="([0-9]+)""#).map_err(error)?;
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let mut overlays: Vec<PageOverlay> = Vec::new();
    let mut source_page = 0u32;
    for page_number in 0..manifest.index_page_count {
        let page = bundle
            .read_index_page(manifest, page_number)
            .map_err(error)?;
        for descriptor in &page.chunks {
            if !descriptor.continuation {
                source_page += 1;
            }
            let (position, rotation) = if layout.is_empty() {
                let number = source_page as usize;
                if range.is_some_and(|range| !(range.start..=range.end).contains(&number)) {
                    continue;
                }
                (number, 0)
            } else {
                let Some(&placement) = placements.get(&source_page) else {
                    continue;
                };
                placement
            };
            let html = bundle.read_chunk_verified(descriptor).map_err(error)?;
            let recorded_page = page_label
                .captures(&html)
                .and_then(|labels| labels[1].parse().ok());
            if recorded_page != Some(source_page) {
                return Err(error(
                    "HCD PDF chunk has an inconsistent source page number",
                ));
            }
            let Some(caps) = raster.captures(&html) else {
                if let Some(overlay) = overlays
                    .last_mut()
                    .filter(|item| item.source_page == Some(source_page))
                {
                    overlay.edits.extend(edited_text(&html, &patched_text)?);
                    overlay.source_ocr.extend(source_ocr_text(
                        &html,
                        &patched_text,
                        overlay.height,
                    )?);
                }
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
            let content_id = document.add_object(Object::Stream(Stream::new(
                dictionary! {},
                format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q\n").into_bytes(),
            )));
            let page_id = document.new_object_id();
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![Object::Integer(0), Object::Integer(0), Object::Real(width), Object::Real(height)],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
                "Contents" => content_id,
            };
            if rotation != 0 {
                page.set("Rotate", i64::from(rotation));
            }
            document.set_object(page_id, Object::Dictionary(page));
            overlays.push(PageOverlay {
                source_page: Some(source_page),
                position,
                page_id,
                width,
                height,
                content_id,
                edits: edited_text(&html, &patched_text)?,
                source_ocr: source_ocr_text(&html, &patched_text, height)?,
            });
        }
    }
    for (position, placement) in selected_layout
        .iter()
        .enumerate()
        .filter(|(_, page)| page.source_page.is_none())
    {
        let (width, height) = (hcd_core::PDF_BLANK_WIDTH_PT, hcd_core::PDF_BLANK_HEIGHT_PT);
        let content_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Rotate" => i64::from(placement.rotation),
            "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
            "Resources" => dictionary! {}, "Contents" => content_id,
        });
        overlays.push(PageOverlay {
            source_page: None,
            position,
            page_id,
            width,
            height,
            content_id,
            edits: Vec::new(),
            source_ocr: Vec::new(),
        });
    }
    let count = overlays.len();
    if !selected_layout.is_empty() {
        overlays.sort_by_key(|page| page.position);
        if count != selected_layout.len()
            || overlays
                .iter()
                .zip(selected_layout)
                .any(|(overlay, placement)| overlay.source_page != placement.source_page)
        {
            return Err(error("a selected PDF page has no unique raster"));
        }
    } else if let Some(range) = range {
        if count != range.end - range.start + 1
            || overlays
                .iter()
                .zip(range.start..=range.end)
                .any(|(page, expected)| page.source_page != Some(expected as u32))
        {
            return Err(error(
                "requested PDF pages exceed the document or a selected page has no raster",
            ));
        }
    }
    if count == 0 {
        return Err(error("HCD PDF has no composited page rasters"));
    }
    let kids = overlays
        .iter()
        .map(|page| Object::Reference(page.page_id))
        .collect::<Vec<_>>();
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
    let edited_text = overlays.iter().any(|page| !page.edits.is_empty());
    let mut recognized: HashMap<_, _> = hcd_core::pdf_ocr::pdf_ocr_layers(bundle, manifest)
        .map_err(error)?
        .into_iter()
        .map(|page| (page.page, page.lines))
        .collect();
    let mut ocr_pages = Vec::new();
    for (
        index,
        PageOverlay {
            width,
            height,
            content_id,
            edits,
            source_page,
            source_ocr,
            ..
        },
    ) in overlays.into_iter().enumerate()
    {
        let page_number = index + 1;
        let mut lines = source_ocr;
        if let Some(layer) = source_page.and_then(|page| recognized.remove(&page)) {
            lines.extend(layer.into_iter().map(|line| {
                let bounds = line.bounds;
                OcrTextLine::from_display_box(
                    line.text,
                    [
                        bounds.left * width,
                        bounds.top * height,
                        (bounds.right - bounds.left) * width,
                        (bounds.bottom - bounds.top) * height,
                    ],
                    height,
                )
            }));
        }
        if !lines.is_empty() {
            // The page image already uses the original PDF's displayed orientation.
            // The new page's /Rotate applies to both the raster and the text.
            ocr_pages.push(OcrTextPage {
                page: page_number as u32,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                lines,
            });
        }
        if edits.is_empty() {
            continue;
        }
        let mut masks = String::new();
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
            masks.push_str(&format!(
                "q 1 1 1 rg {:.2} {:.2} {:.2} {:.2} re f Q\n",
                (edit.x - 1.0).max(0.0),
                (edit.y - 1.0).max(0.0),
                cover_width,
                edit.height + 2.0
            ));
        }
        let content = document
            .get_object_mut(content_id)
            .and_then(Object::as_stream_mut)
            .map_err(error)?;
        let mut bytes = std::mem::take(&mut content.content);
        bytes.extend_from_slice(masks.as_bytes());
        content.set_content(bytes);
        // Add text after the white masks, using a font subset for this output page.
        let characters: HashSet<char> = edits.iter().flat_map(|edit| edit.text.chars()).collect();
        if characters.is_empty() {
            continue;
        }
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
    append_ocr_text(&mut document, &ocr_pages)?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    document.save_to(temporary.as_file_mut()).map_err(error)?;
    temporary.as_file().sync_all()?;
    temporary.persist(output).map_err(error)?;
    Ok(RasterPdfExport {
        pages: count,
        ocr_pages: ocr_pages.len(),
        edited_text,
    })
}
