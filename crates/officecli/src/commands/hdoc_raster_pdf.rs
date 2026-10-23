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

/// Use the page rasters only when every visual edit is already represented in
/// them. Legacy image overlays, failed text repainting and presentation styles
/// must continue through the semantic exporter instead of disappearing.
pub(super) fn can_export(bundle: &Bundle, manifest: &HcdManifest) -> Result<bool, HandlerError> {
    let canonical_tag = Regex::new(r#"<[^>]+data-hcd-id="[^"]+"[^>]*>"#).map_err(error)?;
    let mut pages = 0usize;
    for index in 0..manifest.index_page_count {
        for descriptor in bundle
            .read_index_page(manifest, index)
            .map_err(error)?
            .chunks
        {
            let html = bundle.read_chunk_verified(&descriptor).map_err(error)?;
            if html.contains("data-hcd-patched=\"true\"")
                || html.contains("data-hcd-style-patched=\"true\"")
            {
                return Ok(false);
            }
            if canonical_tag.find_iter(&html).any(|tag| {
                let tag = tag.as_str();
                (tag.contains("data-hcd-image-asset-patched=\"true\"")
                    || tag.contains("data-hcd-image-geometry-patched=\"true\""))
                    && !tag.contains("data-hcd-image-composited=\"true\"")
            }) {
                return Ok(false);
            }
            if !descriptor.continuation {
                if !html.contains("class=\"hcd-pdf-page-raster\"") {
                    return Ok(false);
                }
                pages += 1;
            }
        }
    }
    Ok(pages > 0)
}

// Layout upgrades may reorder attributes and CSS declarations. Parse their
// values instead of coupling visual export to the importer's string template.
fn raster_page_metadata(html: &str) -> Result<Option<(f32, f32, String)>, HandlerError> {
    let mut reader = quick_xml::Reader::from_str(html);
    let mut dimensions = None;
    let mut raster = None;
    loop {
        let event = reader.read_event().map_err(error)?;
        let tag = match event {
            quick_xml::events::Event::Start(tag) | quick_xml::events::Event::Empty(tag) => tag,
            quick_xml::events::Event::Eof => break,
            _ => continue,
        };
        let mut attrs = HashMap::new();
        for attr in tag.attributes() {
            let attr = attr.map_err(error)?;
            attrs.insert(
                String::from_utf8(attr.key.as_ref().to_vec()).map_err(error)?,
                attr.decode_and_unescape_value(reader.decoder())
                    .map_err(error)?
                    .into_owned(),
            );
        }
        let has_class = |name: &str| {
            attrs
                .get("class")
                .is_some_and(|class| class.split_whitespace().any(|value| value == name))
        };
        if tag.name().as_ref() == b"section" && has_class("hcd-pdf-page") {
            let style = attrs
                .get("style")
                .ok_or_else(|| error("PDF raster page has no dimensions"))?;
            let point = |name: &str| -> Result<f32, HandlerError> {
                style
                    .split(';')
                    .filter_map(|part| part.split_once(':'))
                    .find(|(key, _)| key.trim() == name)
                    .and_then(|(_, value)| value.trim().strip_suffix("pt"))
                    .ok_or_else(|| error("PDF raster page has no dimensions"))?
                    .trim()
                    .parse()
                    .map_err(error)
            };
            dimensions = Some((point("width")?, point("height")?));
        }
        if tag.name().as_ref() == b"img" && has_class("hcd-pdf-page-raster") {
            let hash = attrs
                .get("src")
                .and_then(|value| value.strip_prefix("asset://sha256/"))
                .filter(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| error("invalid page raster asset reference"))?;
            raster = Some(hash.to_string());
        }
    }
    match raster {
        None => Ok(None),
        Some(hash) => {
            let (width, height) =
                dimensions.ok_or_else(|| error("PDF raster page has no dimensions"))?;
            Ok(Some((width, height, hash)))
        }
    }
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
            let Some((width, height, hash)) = raster_page_metadata(&html)? else {
                continue;
            };
            if !width.is_finite()
                || !height.is_finite()
                || width <= 0.0
                || height <= 0.0
                || width > 14_400.0
                || height > 14_400.0
            {
                return Err(error("PDF raster page dimensions exceed safe limits"));
            }
            let asset = assets
                .get(&hash)
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

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{NodePrecondition, PatchBatch, PatchOperation};

    #[test]
    fn upgraded_page_metadata_accepts_reordered_attributes_and_css() {
        let hash = "a".repeat(64);
        let html=format!("<section style=\"height:842pt;position:relative;width:595.3pt\" data-hcd-page=\"1\" class=\"hcd-pdf-page\"><img src=\"asset://sha256/{hash}\" alt=\"\" class=\"hcd-pdf-page-raster\"/></section>");
        assert_eq!(
            raster_page_metadata(&html).unwrap(),
            Some((595.3, 842., hash))
        );
    }

    #[test]
    fn edited_revision_exports_current_pixels_and_rejects_unpainted_text_overlay() {
        let temp = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hdoc/pdf-raster-quality.pdf");
        let root = temp.path().join("bundle");
        let mut options = hcd_formats::ImportOptions::new("raster-export-test");
        options.pdf_raster_mode = hcd_formats::PdfRasterMode::Lossless;
        hcd_formats::import_document(&source, &root, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let node = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|node| !node.text.is_empty())
            .unwrap();
        let mut patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "raster-export-test".into(),
            patch_id: "painted-text".into(),
            base_revision: 0,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![PatchOperation::TextSplice {
                node_id: node.node_id.clone(),
                start: 0,
                delete_count: node.text.chars().count(),
                insert_text: "Saved raster text".into(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        };
        let plan = hcd_formats::plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
        assert!(!plan.rasters.is_empty());
        let edited_page = plan.rasters[0].page;
        let expected = image::open(bundle.resolve_href(&plan.rasters[0].asset.href).unwrap())
            .unwrap()
            .to_rgb8()
            .into_raw();
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 0, plan).unwrap();
        let manifest = bundle.manifest().unwrap();
        assert!(can_export(&bundle, &manifest).unwrap());
        let output = temp.path().join("current.pdf");
        export(&bundle, &manifest, 1, &output).unwrap();
        let doc = Document::load(output).unwrap();
        let page = doc.get_pages()[&edited_page];
        let resources = doc
            .get_dictionary(page)
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        let image = resources
            .get(b"XObject")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Im0")
            .unwrap();
        let mut stream = doc
            .dereference(image)
            .unwrap()
            .1
            .as_stream()
            .unwrap()
            .clone();
        // lopdf deliberately rejects generic decompression for /Image streams;
        // this exporter writes plain Flate RGB, without image predictors.
        stream.dict.remove(b"Subtype");
        assert_eq!(stream.get_plain_content().unwrap(), expected);
        let latest = hcd_core::get_text_node(&bundle, &node.node_id).unwrap();
        patch.patch_id = "unpainted-text".into();
        patch.base_revision = 1;
        patch.operations = vec![PatchOperation::TextSplice {
            node_id: node.node_id,
            start: 0,
            delete_count: 1,
            insert_text: "X".into(),
            precondition: NodePrecondition {
                node_hash: latest.node.node_hash,
            },
        }];
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        assert!(!can_export(&bundle, &bundle.manifest().unwrap()).unwrap());
    }
}
