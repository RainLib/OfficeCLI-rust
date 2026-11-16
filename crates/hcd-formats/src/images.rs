//! Standalone raster documents share the normal immutable assets and revisions.
use crate::common::{
    base_manifest, emit_started, finish_import, source_identity_with_extensions, ExportOptions,
    ImportOptions,
};
use hcd_core::{
    hash_bytes, stable_node_id, AssetDescriptor, Bundle, BundleWriter, ChunkSourceMap, HcdError,
    HcdManifest, ImportEvent, NodeMapEntry, SourceAnchor, HCD_SCHEMA_VERSION,
};
use image::{DynamicImage, ImageDecoder, ImageFormat};
use std::{io::Cursor, path::Path};

pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
pub fn is_image_format(format: &str) -> bool {
    matches!(format, "png" | "jpg" | "jpeg" | "webp")
}

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

pub(crate) fn import_image<F: FnMut(&ImportEvent) -> Result<(), HcdError>>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    mut emit: F,
) -> Result<HcdManifest, HcdError> {
    let (sha, size) = source_identity_with_extensions(source, &["png", "jpg", "jpeg", "webp"])?;
    let bytes = std::fs::read(source)?;
    let (image, ext) = decode_raster(&bytes)?;
    let source_ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if source_ext != ext && !(source_ext == "jpeg" && ext == "jpg") {
        return Err(HcdError::Unsupported("图片扩展名与实际编码不一致".into()));
    }
    emit_started(&mut emit, options, &sha)?;
    let mut manifest = base_manifest(options, ext, "fixed-layout", sha, size);
    manifest.capabilities.text_patch = false;
    manifest.capabilities.exact_pagination = true;
    let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
    writer.write_styles(".hcd-image-document{display:flex;justify-content:center}.hcd-image-document img{display:block;max-width:100%;height:auto}")?;
    // Normalize EXIF orientation once. Retain the unmodified source separately.
    let normalized = png_bytes(&image)?;
    if normalized.len() > MAX_IMAGE_BYTES {
        return Err(HcdError::ResourceLimit(
            "规范化图片超过 32 MiB，请缩小尺寸后导入".into(),
        ));
    }
    let (href, hash, byte_length) =
        writer.write_asset_from_reader("png", &mut normalized.as_slice())?;
    std::fs::write(
        writer.root().join("assets/index.json"),
        serde_json::to_vec(&vec![AssetDescriptor {
            source_part: "image/document".into(),
            hash: hash.clone(),
            href,
            byte_length,
        }])?,
    )?;
    let node_id = stable_node_id(&[&options.document_id, "image/document", "image"]);
    let node_hash = hash_bytes(b"");
    let geometry = hcd_core::ImageGeometry {
        x: 0.,
        y: 0.,
        width: f64::from(image.width()) * 0.75,
        height: f64::from(image.height()) * 0.75,
        unit: hcd_core::ImageGeometryUnit::Pt,
    };
    let visual = hcd_core::image_visual_hash(Some(&hash), Some(&geometry));
    let uri = format!("asset://sha256/{hash}");
    let html=format!("<div class=\"hcd-image-document\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-node-kind=\"image\" data-hcd-asset-hash=\"{hash}\" data-hcd-visual-hash=\"{visual}\" data-hcd-x=\"0\" data-hcd-y=\"0\" data-hcd-width=\"{}\" data-hcd-height=\"{}\" data-hcd-geometry-unit=\"pt\"><img src=\"{uri}\" data-hcd-asset-href=\"{uri}\" alt=\"图片\" /></span></div>",geometry.width,geometry.height);
    let chunk_id =
        stable_node_id(&[&options.document_id, "image/document", "chunk"]).replacen("n_", "c_", 1);
    let map = ChunkSourceMap {
        schema_version: HCD_SCHEMA_VERSION.into(),
        chunk_id: chunk_id.clone(),
        entries: vec![NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                part: "image/document".into(),
                text_ordinal: 1,
                paragraph_id: None,
                text_id: Some("image".into()),
                node_kind: "image".into(),
                editable: true,
                created_in_hcd: false,
                source_cell_ref: None,
            },
        }],
    };
    writer.write_chunk(chunk_id, "body".into(), html, map, 1, false)?;
    finish_import(writer, manifest, &mut emit)
}

/// Resolve through the selected revision, never through the mutable source file.
pub fn image_content(bundle: &Bundle, revision: Option<u64>) -> Result<Vec<u8>, HcdError> {
    let head = bundle.manifest()?;
    if !is_image_format(&head.source.format) {
        return Err(HcdError::Unsupported("不是独立图片文档".into()));
    }
    let (manifest, _) = hcd_core::manifest_at_revision(bundle, &head, revision)?;
    let page = bundle.read_index_page(&manifest, 0)?;
    let chunk = page
        .chunks
        .first()
        .ok_or_else(|| HcdError::InvalidBundle("缺少图片分块".into()))?;
    let nodes = hcd_core::extract_html_image_nodes(&bundle.read_chunk(chunk)?)?;
    let hash = nodes
        .values()
        .next()
        .and_then(|n| n.asset_hash.as_deref())
        .ok_or_else(|| HcdError::InvalidBundle("缺少图片资源".into()))?;
    let assets = bundle.read_asset_index_for_revision(manifest.revision)?;
    let asset = assets
        .iter()
        .find(|a| a.hash == hash)
        .ok_or_else(|| HcdError::InvalidBundle("图片资源未登记".into()))?;
    Ok(std::fs::read(bundle.resolve_href(&asset.href)?)?)
}

pub fn export_image(
    bundle: &Bundle,
    target: &Path,
    options: &ExportOptions,
) -> Result<hcd_core::FidelityReport, HcdError> {
    let bytes = image_content(bundle, options.revision)?;
    let (image, _) = decode_raster(&bytes)?;
    let ext = target
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let format = match ext.as_str() {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        _ => return Err(HcdError::Unsupported("图片导出支持 PNG、JPEG、WebP".into())),
    };
    let image = if format == ImageFormat::Jpeg {
        let mut rgba = image.to_rgba8();
        for p in rgba.pixels_mut() {
            let a = u32::from(p[3]);
            for c in 0..3 {
                p[c] = ((u32::from(p[c]) * a + 255 * (255 - a) + 127) / 255) as u8;
            }
            p[3] = 255;
        }
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
    } else {
        image
    };
    image
        .save_with_format(target, format)
        .map_err(raster_error)?;
    // Browser export also provides quality-controlled lossy WebP; the Rust encoder is lossless.
    let report = hcd_core::FidelityReport {
        schema_version: "hcd-fidelity/1".into(),
        level: hcd_core::FidelityLevel::High,
        preserved: vec!["Raster dimensions and current revision".into()],
        flattened: vec!["Export uses the selected raster encoder; WebP is lossless in CLI".into()],
        dropped: vec![],
        warnings: vec![],
    };
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raster_import_and_revision_export_are_real_images() {
        let dir = tempfile::tempdir().unwrap();
        let mut pixels = image::RgbaImage::new(24, 16);
        for (x, y, p) in pixels.enumerate_pixels_mut() {
            *p = image::Rgba([x as u8 * 8, y as u8 * 8, 100, if x < 8 { 0 } else { 255 }]);
        }
        let source = dir.path().join("source.png");
        DynamicImage::ImageRgba8(pixels).save(&source).unwrap();
        let out = dir.path().join("picture.hcd");
        import_image(&source, &out, &ImportOptions::new("picture"), |_| Ok(())).unwrap();
        let bundle = Bundle::open(&out).unwrap();
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        for ext in ["png", "jpg", "webp"] {
            let target = dir.path().join(format!("output.{ext}"));
            export_image(&bundle, &target, &ExportOptions::default()).unwrap();
            let (img, actual) = decode_raster(&std::fs::read(target).unwrap()).unwrap();
            assert_eq!(actual, ext);
            assert_eq!((img.width(), img.height()), (24, 16));
            if ext == "jpg" {
                assert!(img.to_rgb8().get_pixel(0, 0)[0] > 245);
            }
        }
        assert_eq!(
            decode_raster(&image_content(&bundle, Some(0)).unwrap())
                .unwrap()
                .0
                .width(),
            24
        );
    }
    #[test]
    fn reject_bad_payload_and_renamed_extension() {
        assert!(decode_raster(b"not an image").is_err());
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fake.jpg");
        std::fs::write(&source, png_bytes(&DynamicImage::new_rgba8(3, 2)).unwrap()).unwrap();
        assert!(import_image(
            &source,
            &dir.path().join("bad.hcd"),
            &ImportOptions::new("bad"),
            |_| Ok(())
        )
        .is_err());
    }
}
