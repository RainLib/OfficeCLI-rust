mod geometry;
mod native;
mod upgrade;
use geometry::Viewport;
pub use upgrade::{pdf_layout_needs_upgrade, upgrade_pdf_layout};

use crate::common::{
    base_manifest, checked_export_state, collect_dirty_nodes, emit_failed, emit_started,
    escape_attribute, escape_text, finish_import, source_identity, write_fidelity_report,
    ExportOptions, ImportOptions, PdfRasterMode,
};
use handler_common::DocumentHandler;
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{render as render_pdf_page, RenderSettings};
use hcd_core::{
    hash_bytes, stable_node_id, AssetDescriptor, Bundle, BundleWriter, ChunkSourceMap,
    FidelityLevel, FidelityReport, FidelityWarning, HcdError, HcdManifest, ImportEvent,
    NodeMapEntry, SourceAnchor, DEFAULT_CHUNK_BLOCKS, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES,
};
use image::ImageEncoder;
use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

const MAX_HCD_PDF_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_HCD_PDF_PAGES: usize = 100_000;
const MAX_HCD_PDF_PAGE_CONTENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_HCD_PDF_AUX_STREAM_BYTES: usize = 8 * 1024 * 1024;
const MAX_HCD_PDF_PAGE_IMAGE_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_HCD_PDF_STREAM_DICTIONARY_BYTES: usize = 256 * 1024;
const MAX_HCD_PDF_STRUCTURAL_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_HCD_PDF_STRUCTURAL_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_HCD_PDF_STRUCTURAL_STREAMS: usize = 100_000;
const MAX_HCD_PDF_XREF_ENTRIES: usize = 1_000_000;
const HCD_PDF_RASTER_SCALE: f32 = 96.0 / 72.0;
const MAX_HCD_PDF_RASTER_DIMENSION: u32 = 8_192;
const MAX_HCD_PDF_RASTER_PIXELS: u64 = 32 * 1024 * 1024;
const MAX_HCD_PDF_RASTER_PNG_BYTES: usize = 64 * 1024 * 1024;

fn sanitize_pdf_text(text: String) -> (String, usize) {
    let mut replaced = 0usize;
    let sanitized = text
        .chars()
        .map(|character| {
            if matches!(
                character as u32,
                0x0..=0x8 | 0xB | 0xC | 0xE..=0x1F | 0xFFFE | 0xFFFF
            ) {
                replaced += 1;
                ' '
            } else {
                character
            }
        })
        .collect();
    (sanitized, replaced)
}

struct PdfPageWriter<'a, F>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    document_id: &'a str,
    page: usize,
    writer: &'a mut BundleWriter,
    emit: &'a mut F,
    soft_bytes: usize,
    max_blocks: usize,
    page_width: f32,
    page_height: f32,
    viewport: Viewport,
    ordinal: usize,
    blocks: usize,
    html: String,
    entries: Vec<NodeMapEntry>,
    page_raster: Option<String>,
    source_raster: bool,
}

struct PdfRenderedText {
    index: usize,
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    style: String,
}

struct PdfRenderedImage {
    index: usize,
    href: Option<String>,
    hash: Option<String>,
    xobject_name: String,
    xobject_kind: pdf_handler::content_stream::PdfXObjectKind,
    transform: [f32; 6],
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl<'a, F> PdfPageWriter<'a, F>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    fn set_page_raster(&mut self, href: &str, hash: &str) {
        let loading = if self.page == 1 { "eager" } else { "lazy" };
        self.page_raster = Some(format!(
            "<img class=\"hcd-pdf-page-raster\" src=\"asset://sha256/{hash}\" data-hcd-asset-href=\"{}\" loading=\"{loading}\" decoding=\"async\" alt=\"\"/>",
            escape_attribute(href)
        ));
        self.source_raster = true;
    }

    fn push_image(&mut self, image: PdfRenderedImage) -> Result<(), HcdError> {
        let PdfRenderedImage {
            index,
            href,
            hash,
            xobject_name,
            xobject_kind,
            transform,
            x,
            y,
            width,
            height,
        } = image;
        let part = format!("pdf/pages/{}", self.page);
        let source_path = format!("/page[{}]/image[{index}]", self.page);
        let node_id = stable_node_id(&[
            self.document_id,
            &part,
            "xobject-placement",
            &index.to_string(),
        ]);
        let [left, top, view_width, view_height] =
            self.viewport
                .to_view([x as f64, y as f64, width as f64, height as f64]);
        let (left, top, view_width, view_height) = (
            left as f32,
            top as f32,
            view_width as f32,
            view_height as f32,
        );
        let kind = xobject_kind.as_str();
        // HTML attributes use f32's shortest decimal representation. Hash that
        // exact representation so a later patch parses the same geometry back.
        let html_number = |value: f32| -> Result<f64, HcdError> {
            value
                .to_string()
                .parse()
                .map_err(|_| HcdError::InvalidBundle("non-finite PDF image geometry".to_string()))
        };
        let geometry = hcd_core::ImageGeometry {
            x: html_number(left)?,
            y: html_number(top)?,
            width: html_number(view_width)?,
            height: html_number(view_height)?,
            unit: hcd_core::ImageGeometryUnit::Pt,
        };
        let node_hash = hash_bytes(b"");
        let visual_hash = hcd_core::image_visual_hash(hash.as_deref(), Some(&geometry));
        let common = format!(
            "class=\"hcd-pdf-image hcd-pdf-visual-node\" data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-visual-hash=\"{visual_hash}\"{} data-hcd-node-kind=\"pdf-{kind}\" data-hcd-editable=\"true\" data-hcd-source-path=\"{source_path}\" data-hcd-source-order=\"{index}\" data-hcd-xobject=\"{}\" data-hcd-mapping=\"source\" data-hcd-geometry=\"xobject-ctm\" data-hcd-x=\"{left}\" data-hcd-y=\"{top}\" data-hcd-width=\"{view_width}\" data-hcd-height=\"{view_height}\" data-hcd-geometry-unit=\"pt\" data-hcd-bbox=\"{left},{top},{view_width},{view_height}\" data-hcd-source-bbox=\"{x},{y},{width},{height}\" data-hcd-transform=\"{},{},{},{},{},{}\" style=\"position:absolute;left:{left}pt;top:{top}pt;width:{view_width}pt;height:{view_height}pt\"",
            hash.as_ref().map(|hash| format!(" data-hcd-asset-hash=\"{hash}\"")).unwrap_or_default(),
            escape_attribute(&xobject_name),
            transform[0],
            transform[1],
            transform[2],
            transform[3],
            transform[4],
            transform[5],
        );
        let block = match (href, hash) {
            (Some(href), Some(hash)) => format!(
                "<img {common} src=\"asset://sha256/{hash}\" data-hcd-asset-href=\"{}\" alt=\"\"/>",
                escape_attribute(&href)
            ),
            _ => format!("<div {common}></div>"),
        };
        if self.blocks > 0
            && (self.html.len() + block.len() > self.soft_bytes || self.blocks >= self.max_blocks)
        {
            self.flush()?;
        }
        self.html.push_str(&block);
        self.entries.push(NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                part,
                text_ordinal: index as u64,
                paragraph_id: Some(source_path),
                text_id: None,
                node_kind: "image".to_string(),
                editable: true,
            },
        });
        self.blocks += 1;
        Ok(())
    }

    fn push(&mut self, rendered: PdfRenderedText) -> Result<(), HcdError> {
        let PdfRenderedText {
            index,
            text,
            x,
            y,
            width,
            height,
            style,
        } = rendered;
        if text.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "NODE_TOO_LARGE: PDF page {} text block {} exceeds 2 MiB",
                self.page, index
            )));
        }
        let part = format!("pdf/pages/{}", self.page);
        let node_id = stable_node_id(&[self.document_id, &part, "text-block", &index.to_string()]);
        let node_hash = hash_bytes(text.as_bytes());
        let source_path = format!("/page[{}]/text[{index}]", self.page);
        let [left, top, view_width, view_height] =
            self.viewport
                .to_view([x as f64, y as f64, width as f64, height as f64]);
        let style = style
            .split(';')
            .filter(|declaration| {
                !matches!(
                    declaration.split(':').next(),
                    Some("left" | "top" | "width" | "height")
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        let style = format!(
            "{style};left:{left}pt;top:{top}pt;width:{view_width}pt;height:{view_height}pt"
        );
        let inner_style = self.viewport.text_transform(width, height);
        let block = format!(
            "<p class=\"hcd-pdf-text\" data-hcd-text-node=\"{node_id}\" data-hcd-source-path=\"{source_path}\" data-hcd-source-order=\"{index}\" data-hcd-mapping=\"source\" data-hcd-source-bbox=\"{x},{y},{width},{height}\" data-hcd-bbox=\"{left},{top},{view_width},{view_height}\" data-hcd-x=\"{left}\" data-hcd-y=\"{top}\" data-hcd-width=\"{view_width}\" data-hcd-height=\"{view_height}\" style=\"{style}\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\" style=\"{inner_style}\">{}</span></p>",
            escape_text(&text)
        );
        if self.blocks > 0
            && (self.html.len() + block.len() > self.soft_bytes || self.blocks >= self.max_blocks)
        {
            self.flush()?;
        }
        self.html.push_str(&block);
        self.entries.push(NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                part,
                text_ordinal: index as u64,
                paragraph_id: Some(source_path),
                text_id: None,
                node_kind: "pdf-text".to_string(),
                editable: true,
            },
        });
        self.blocks += 1;
        Ok(())
    }

    fn flush(&mut self) -> Result<(), HcdError> {
        if self.blocks == 0 && self.ordinal > 0 {
            return Ok(());
        }
        let part = format!("pdf/pages/{}", self.page);
        let chunk_id = stable_node_id(&[
            self.document_id,
            &part,
            "page-chunk",
            &self.ordinal.to_string(),
        ])
        .replacen("n_", "c_", 1);
        let mut content = String::new();
        if self.ordinal == 0 {
            if let Some(page_raster) = &self.page_raster {
                content.push_str(page_raster);
            }
        }
        if self.blocks == 0 && content.is_empty() {
            content.push_str("<div class=\"hcd-empty-page\"></div>");
        } else {
            content.push_str(&std::mem::take(&mut self.html));
        }
        let continuation_margin = if self.ordinal > 0 {
            format!(";margin-top:-{:.1}pt", self.page_height + 18.0)
        } else {
            String::new()
        };
        let html = format!(
            "<section class=\"hcd-pdf-page\" data-hcd-page=\"{}\" data-hcd-pdf-coordinates=\"viewport-v1\" data-hcd-page-rotation=\"{}\" data-hcd-continuation=\"{}\" data-hcd-source-raster=\"{}\" style=\"position:relative;width:{:.1}pt;height:{:.1}pt;overflow:hidden{continuation_margin}\">{content}</section>",
            self.page,
            self.viewport.rotation,
            self.ordinal > 0,
            self.source_raster,
            self.page_width,
            self.page_height,
        );
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: chunk_id.clone(),
            entries: std::mem::take(&mut self.entries),
        };
        let descriptor = self.writer.write_chunk(
            chunk_id,
            "page".to_string(),
            html,
            map,
            self.blocks.max(1),
            self.ordinal > 0,
        )?;
        (self.emit)(&ImportEvent::ChunkReady { descriptor })?;
        self.ordinal += 1;
        self.blocks = 0;
        Ok(())
    }
}

struct PageRaster {
    bytes: Vec<u8>,
    extension: &'static str,
    lossy: bool,
}

fn render_page_raster(
    pdf: &Pdf,
    page_index: usize,
    page_width: f32,
    page_height: f32,
    mode: PdfRasterMode,
    quality: u8,
) -> Result<PageRaster, String> {
    let width = (page_width * HCD_PDF_RASTER_SCALE).ceil().max(1.0) as u32;
    let height = (page_height * HCD_PDF_RASTER_SCALE).ceil().max(1.0) as u32;
    if width > MAX_HCD_PDF_RASTER_DIMENSION || height > MAX_HCD_PDF_RASTER_DIMENSION {
        return Err(format!(
            "raster dimensions {width}x{height} exceed {MAX_HCD_PDF_RASTER_DIMENSION}px"
        ));
    }
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_HCD_PDF_RASTER_PIXELS {
        return Err(format!(
            "raster dimensions {width}x{height} exceed the {MAX_HCD_PDF_RASTER_PIXELS}-pixel page limit"
        ));
    }
    let page = pdf
        .pages()
        .get(page_index)
        .ok_or_else(|| format!("Hayro page {} does not exist", page_index + 1))?;
    let settings = RenderSettings {
        x_scale: HCD_PDF_RASTER_SCALE,
        y_scale: HCD_PDF_RASTER_SCALE,
        width: Some(width as u16),
        height: Some(height as u16),
        bg_color: WHITE,
    };
    let pixmap = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        render_pdf_page(page, &InterpreterSettings::default(), &settings)
    }))
    .map_err(|_| format!("Hayro panicked while rendering page {}", page_index + 1))?;
    let rgb = if mode == PdfRasterMode::Lossless {
        Vec::new()
    } else {
        let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
        for pixel in pixmap.data_as_u8_slice().chunks_exact(4) {
            let alpha = u16::from(pixel[3]);
            for channel in &pixel[..3] {
                rgb.push((u16::from(*channel) + 255 - alpha).min(255) as u8);
            }
        }
        rgb
    };
    let jpeg = if mode == PdfRasterMode::Lossless {
        None
    } else {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|error| {
                format!("failed to encode page {} as JPEG: {error}", page_index + 1)
            })?;
        Some(bytes)
    };
    if mode == PdfRasterMode::Lossy {
        let bytes = jpeg.expect("lossy mode encoded JPEG");
        if bytes.len() > MAX_HCD_PDF_RASTER_PNG_BYTES {
            return Err(format!(
                "rendered JPEG page {} exceeds the 64 MiB asset limit",
                page_index + 1
            ));
        }
        return Ok(PageRaster {
            bytes,
            extension: "jpg",
            lossy: true,
        });
    }
    let png = pixmap
        .into_png()
        .map_err(|error| format!("failed to encode page {} as PNG: {error}", page_index + 1))?;
    if png.len() > MAX_HCD_PDF_RASTER_PNG_BYTES {
        return Err(format!(
            "rendered page {} is {} bytes; maximum is {MAX_HCD_PDF_RASTER_PNG_BYTES}",
            page_index + 1,
            png.len()
        ));
    }
    if let Some(jpeg) = jpeg {
        if jpeg.len() * 100 <= png.len() * 85 {
            let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
                .map_err(|error| format!("failed to verify JPEG page {}: {error}", page_index + 1))?
                .into_rgb8();
            let squared_error: u64 = rgb
                .iter()
                .zip(decoded.as_raw())
                .map(|(original, candidate)| {
                    let difference = i32::from(*original) - i32::from(*candidate);
                    (difference * difference) as u64
                })
                .sum();
            let mse = squared_error as f64 / rgb.len() as f64;
            let psnr = if mse == 0.0 {
                f64::INFINITY
            } else {
                10.0 * (65025.0 / mse).log10()
            };
            if psnr >= 35.0 {
                return Ok(PageRaster {
                    bytes: jpeg,
                    extension: "jpg",
                    lossy: true,
                });
            }
        }
    }
    Ok(PageRaster {
        bytes: png,
        extension: "png",
        lossy: false,
    })
}

pub(crate) fn import_pdf<F>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    mut emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let (source_hash, source_size) = source_identity(source, "pdf")?;
    if source_size > MAX_HCD_PDF_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "PDF source is {source_size} bytes; bounded HCD PDF import supports at most {MAX_HCD_PDF_SOURCE_BYTES} bytes"
        )));
    }
    emit_started(&mut emit, options, &source_hash)?;
    let result = import_pdf_inner(source, output, options, source_hash, source_size, &mut emit);
    if let Err(error) = &result {
        emit_failed(&mut emit, options, error);
    }
    result
}

fn import_pdf_inner<F>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    source_hash: String,
    source_size: u64,
    emit: &mut F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    preflight(source)?;
    let source_path = source
        .to_str()
        .ok_or_else(|| HcdError::InvalidBundle("PDF path is not UTF-8".to_string()))?;
    let reader = pdf_handler::reader::PdfReader::open(source_path)
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    if reader.page_count() > MAX_HCD_PDF_PAGES {
        return Err(HcdError::ResourceLimit(format!(
            "PDF contains {} pages; maximum is {MAX_HCD_PDF_PAGES}",
            reader.page_count()
        )));
    }
    let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
    writer.write_styles(
        ".hcd-pdf-page{display:block;padding:0;margin:0 auto 18pt;background:#fff;overflow:hidden;box-shadow:0 2px 12px #0003}.hcd-pdf-page[data-hcd-continuation=\"true\"]{background:transparent;box-shadow:none}.hcd-pdf-page-raster{position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0;pointer-events:none}.hcd-pdf-image{position:absolute;display:block;z-index:1}.hcd-pdf-visual-node{pointer-events:none;background:transparent}.hcd-pdf-text{position:absolute;min-width:max-content;white-space:nowrap;margin:0;line-height:1;z-index:2;cursor:text}.hcd-pdf-page[data-hcd-source-raster=\"true\"] .hcd-pdf-text{color:transparent!important;text-shadow:none!important}.hcd-pdf-page[data-hcd-source-raster=\"true\"] .hcd-pdf-text:has(span[data-hcd-patched=\"true\"]){background:#fff;z-index:3;outline:1px dashed #b45f06;outline-offset:1px}.hcd-pdf-page[data-hcd-source-raster=\"true\"] .hcd-pdf-text span[data-hcd-patched=\"true\"]{color:#111!important}body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-pdf-visual-node{pointer-events:auto;cursor:crosshair}body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-pdf-visual-node:hover{background:rgba(255,59,48,.10);outline:2px solid rgba(255,59,48,.95);outline-offset:-1px}body:not([data-hcd-text-hitboxes=\"off\"]) .hcd-pdf-text:hover{background:rgba(10,132,255,.12);outline:1px solid rgba(10,132,255,.8);outline-offset:0}.hcd-empty-page{position:absolute;inset:0}",
    )?;
    let raster_source = geometry::raster_bytes(&reader, source)?;
    let (raster_pdf, raster_initialization_error) = match Pdf::new(Arc::new(raster_source)) {
        Ok(pdf) => (Some(pdf), None),
        Err(error) => (
            None,
            Some(format!("Hayro could not open the PDF: {error:?}")),
        ),
    };
    let mut replaced_control_characters = 0usize;
    let mut rasterized_pages = 0usize;
    let mut lossy_pages = 0usize;
    let mut raster_fallbacks = Vec::new();
    let mut assets = BTreeMap::<String, AssetDescriptor>::new();
    for page in 1..=reader.page_count() {
        let (raw_page_width, raw_page_height, llx, lly) =
            pdf_handler::html_preview::page_dimensions(&reader, page);
        // The source page box is unrotated. Hayro applies /Rotate while rendering,
        // so its output dimensions must also drive the raster canvas and preview.
        let rendered_dimensions = raster_pdf
            .as_ref()
            .and_then(|pdf| pdf.pages().get(page - 1))
            .map(|page| page.render_dimensions());
        let mut parsed = reader
            .parse_page_text_blocks_bounded(
                page,
                MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                MAX_HCD_PDF_AUX_STREAM_BYTES,
            )
            .map_err(pdf_parse_error)?;
        let page_raster = raster_pdf.as_ref().and_then(|pdf| {
            match render_page_raster(
                pdf,
                page - 1,
                rendered_dimensions.map_or(raw_page_width, |size| size.0),
                rendered_dimensions.map_or(raw_page_height, |size| size.1),
                options.pdf_raster_mode,
                options.pdf_raster_quality,
            ) {
                Ok(png) => Some(png),
                Err(error) => {
                    raster_fallbacks.push(format!("page {page}: {error}"));
                    None
                }
            }
        });
        if page_raster.is_none() {
            if let Some(error) = &raster_initialization_error {
                if raster_fallbacks.is_empty() {
                    raster_fallbacks.push(error.clone());
                }
            }
            parsed = reader
                .parse_page_text_blocks_with_images_bounded(
                    page,
                    MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                    MAX_HCD_PDF_AUX_STREAM_BYTES,
                    MAX_HCD_PDF_PAGE_IMAGE_PAYLOAD_BYTES,
                )
                .map_err(pdf_parse_error)?;
        }
        let viewport = if let Some(page) = raster_pdf
            .as_ref()
            .and_then(|pdf| pdf.pages().get(page - 1))
        {
            Viewport::from_rendered(page)
        } else {
            let page_id = reader.document().get_pages()[&(page as u32)];
            Viewport::from_document(reader.document(), page_id)?
        };
        let (page_width, page_height) = viewport.dimensions();
        let mut rendered_images = Vec::with_capacity(parsed.image_blocks.len());
        for image in &parsed.image_blocks {
            let mut href = None;
            let mut hash = None;
            if page_raster.is_none() {
                if let Some(data_uri) = parsed.image_map.get(&image.xobject_name) {
                    let (extension, bytes) = decode_image_data_uri(data_uri)?;
                    let (asset_href, asset_hash, byte_length) =
                        writer.write_asset_from_reader(extension, &mut Cursor::new(bytes))?;
                    if !assets.contains_key(&asset_hash) {
                        emit(&ImportEvent::AssetReady {
                            hash: asset_hash.clone(),
                            href: asset_href.clone(),
                            byte_length,
                        })?;
                        assets.insert(
                            asset_hash.clone(),
                            AssetDescriptor {
                                source_part: format!(
                                    "pdf/pages/{page}/xobjects/{}",
                                    image.xobject_name
                                ),
                                hash: asset_hash.clone(),
                                href: asset_href.clone(),
                                byte_length,
                            },
                        );
                    }
                    href = Some(asset_href);
                    hash = Some(asset_hash);
                }
            }
            rendered_images.push(PdfRenderedImage {
                index: image.index,
                href,
                hash,
                xobject_name: image.xobject_name.clone(),
                xobject_kind: image.xobject_kind,
                transform: image.transform,
                x: image.bbox.x,
                y: image.bbox.y,
                width: image.bbox.width,
                height: image.bbox.height,
            });
        }
        let mut chunks = PdfPageWriter {
            document_id: &options.document_id,
            page,
            writer: &mut writer,
            emit,
            soft_bytes: options.chunk_soft_bytes.min(MAX_CHUNK_BYTES),
            max_blocks: options.chunk_blocks.clamp(1, DEFAULT_CHUNK_BLOCKS),
            page_width,
            page_height,
            viewport,
            ordinal: 0,
            blocks: 0,
            html: String::new(),
            entries: Vec::new(),
            page_raster: None,
            source_raster: false,
        };
        if let Some(raster) = page_raster {
            let (href, hash, byte_length) = chunks
                .writer
                .write_asset_from_reader(raster.extension, &mut Cursor::new(raster.bytes))?;
            if !assets.contains_key(&hash) {
                (chunks.emit)(&ImportEvent::AssetReady {
                    hash: hash.clone(),
                    href: href.clone(),
                    byte_length,
                })?;
                assets.insert(
                    hash.clone(),
                    AssetDescriptor {
                        source_part: format!("pdf/pages/{page}/composited-raster"),
                        hash: hash.clone(),
                        href: href.clone(),
                        byte_length,
                    },
                );
            }
            chunks.set_page_raster(&href, &hash);
            rasterized_pages += 1;
            lossy_pages += usize::from(raster.lossy);
        }
        for image in rendered_images {
            chunks.push_image(image)?;
        }
        for block in &parsed.text_blocks {
            let style = pdf_handler::html_preview::text_block_inline_style(
                &parsed,
                block,
                page_height,
                llx,
                lly,
            );
            let (text, replaced) = sanitize_pdf_text(block.text.clone());
            replaced_control_characters = replaced_control_characters.saturating_add(replaced);
            chunks.push(PdfRenderedText {
                index: block.index,
                text,
                x: block.bbox.x,
                y: block.bbox.y,
                width: block.bbox.width,
                height: block.bbox.height,
                style,
            })?;
        }
        chunks.flush()?;
    }
    std::fs::write(
        writer.root().join("assets/index.json"),
        serde_json::to_vec(&assets.into_values().collect::<Vec<_>>())?,
    )?;
    let mut manifest = base_manifest(options, "pdf", "fixed-layout", source_hash, source_size);
    manifest.warnings.push(FidelityWarning {
        code: "PDF_OBJECT_GRAPH_IN_MEMORY".to_string(),
        message: "PDF import retains lopdf's compressed object graph in memory. Before lopdf is called, /ObjStm and /XRef streams receive bounded structural preflight; page content and auxiliary font streams are then decoded with independent limits".to_string(),
        node_id: None,
        source_part: None,
    });
    if replaced_control_characters > 0 {
        manifest.warnings.push(FidelityWarning {
            code: "PDF_FORBIDDEN_CONTROL_REPLACED".to_string(),
            message: format!(
                "Replaced {replaced_control_characters} PDF text-layer control characters that XML document formats cannot represent with spaces"
            ),
            node_id: None,
            source_part: None,
        });
    }
    manifest.warnings.push(FidelityWarning {
        code: "PDF_SOURCE_VISUAL_LAYER_READ_ONLY".to_string(),
        message: format!("{rasterized_pages} of {} PDF pages were composited as a read-only 96-DPI visual layer; {lossy_pages} page(s) use lossy JPEG at quality {}; extractable nodeId text remains selectable/editable but is transparent in source-view mode, and scanned text requires OCR before text patching", reader.page_count(), options.pdf_raster_quality),
        node_id: None,
        source_part: None,
    });
    if !raster_fallbacks.is_empty() {
        manifest.warnings.push(FidelityWarning {
            code: "PDF_PAGE_RASTER_FALLBACK".to_string(),
            message: format!(
                "{} page-rendering fallback(s) used the older XObject/text composition path: {}",
                raster_fallbacks.len(),
                raster_fallbacks.join("; ")
            ),
            node_id: None,
            source_part: None,
        });
    }
    manifest.fidelity = Some(FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: FidelityLevel::Visual,
        preserved: vec![
            format!("page order and {rasterized_pages} fully composited source-page presentation raster(s) at CSS 96-DPI scale; {lossy_pages} lossy JPEG page(s)"),
            "extractable nodeId text and text block coordinates in a separate interaction layer"
                .to_string(),
            "the immutable source PDF as the export boundary".to_string(),
        ],
        flattened: vec![
            "PDF drawing operations, fonts, vector graphics, masks and shaping are flattened into read-only page PNG/JPEG assets; JPEG pages are visually lossy and the pure-Rust renderer remains best-effort for unsupported PDF features".to_string(),
        ],
        dropped: vec!["scanned text without an OCR layer".to_string()],
        warnings: manifest.warnings.clone(),
    });
    finish_import(writer, manifest, emit)
}

fn decode_image_data_uri(value: &str) -> Result<(&'static str, Vec<u8>), HcdError> {
    let (metadata, payload) = value.split_once(',').ok_or_else(|| {
        HcdError::InvalidBundle("PDF image data URI is missing a payload separator".to_string())
    })?;
    if !metadata.ends_with(";base64") {
        return Err(HcdError::Unsupported(
            "PDF image data URI is not Base64 encoded".to_string(),
        ));
    }
    let extension = match metadata
        .trim_start_matches("data:")
        .trim_end_matches(";base64")
    {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        other => {
            return Err(HcdError::Unsupported(format!(
                "PDF image MIME type {other} is not supported in HCD presentation"
            )))
        }
    };
    let bytes = decode_base64(payload).map_err(|()| {
        HcdError::InvalidBundle("PDF image contains invalid Base64 data".to_string())
    })?;
    if bytes.len() > MAX_HCD_PDF_PAGE_IMAGE_PAYLOAD_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "PDF image is {} bytes; per-page presentation asset limit is {}",
            bytes.len(),
            MAX_HCD_PDF_PAGE_IMAGE_PAYLOAD_BYTES
        )));
    }
    Ok((extension, bytes))
}

fn decode_base64(value: &str) -> Result<Vec<u8>, ()> {
    let mut bits = 0u32;
    let mut bit_count = 0u32;
    let mut output = Vec::with_capacity(value.len().saturating_mul(3) / 4);
    for character in value.chars().filter(|character| !character.is_whitespace()) {
        let decoded = match character {
            'A'..='Z' => character as u32 - 'A' as u32,
            'a'..='z' => character as u32 - 'a' as u32 + 26,
            '0'..='9' => character as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => return Err(()),
        };
        bits = (bits << 6) | decoded;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            output.push((bits >> bit_count) as u8);
        }
    }
    Ok(output)
}

fn pdf_parse_error(error: handler_common::HandlerError) -> HcdError {
    let message = error.to_string();
    if message.contains("resource limit exceeded") {
        HcdError::ResourceLimit(message)
    } else if message.contains("not supported by the bounded HCD PDF decoder")
        || message.contains("unsupported bounded-decoder filter")
    {
        HcdError::Unsupported(message)
    } else {
        HcdError::InvalidBundle(message)
    }
}

pub(crate) fn export_pdf(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    if target.exists() {
        return Err(HcdError::InvalidBundle(format!(
            "target already exists: {}",
            target.display()
        )));
    }
    let (manifest, _, dirty_parts, _) = checked_export_state(bundle, source, options)?;
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let temp = tempfile::Builder::new()
        .prefix(".officecli-hcd-pdf-")
        .suffix(".pdf")
        .tempfile_in(parent)?;
    native::write_candidate(bundle, source, temp.path(), options, &[])?;
    pdf_handler::reader::PdfReader::open(&temp.path().to_string_lossy())
        .map_err(|error| HcdError::InvalidBundle(format!("exported PDF is invalid: {error}")))?;
    temp.persist(target)
        .map_err(|error| HcdError::Io(error.error))?;

    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: if dirty_parts.is_empty() {
            FidelityLevel::Exact
        } else {
            FidelityLevel::Semantic
        },
        preserved: vec![
            "page tree, graphics and unedited PDF objects".to_string(),
            "text block position where supported by the source font/content stream".to_string(),
            "edited image/Form placements and replacement image transparency".to_string(),
        ],
        flattened: vec![
            "edited PDF text may use a fallback embedded font when the original subset lacks glyphs"
                .to_string(),
        ],
        dropped: vec!["HCD recognition annotations are not exported".to_string()],
        warnings: manifest.warnings,
    };
    write_fidelity_report(options, &report)?;
    Ok(report)
}

pub fn plan_pdf_page_rasters(
    bundle: &Bundle,
    source: &Path,
    operations: &[hcd_core::PatchOperation],
) -> Result<hcd_core::PdfRasterPlan, HcdError> {
    if bundle.manifest()?.source.format == "pdf"
        && operations.iter().any(|operation| {
            matches!(
                operation,
                hcd_core::PatchOperation::ImageGeometry { .. }
                    | hcd_core::PatchOperation::ImageReplace { .. }
            )
        })
    {
        return native::plan(bundle, source, operations);
    }
    if bundle.manifest()?.source.format == "pdf"
        && source.try_exists()?
        && operations
            .iter()
            .any(|operation| matches!(operation, hcd_core::PatchOperation::TextSplice { .. }))
    {
        return native::plan(bundle, source, operations);
    }
    let mut edits_by_node: BTreeMap<String, Vec<(usize, usize, String, String)>> = BTreeMap::new();
    for operation in operations {
        let hcd_core::PatchOperation::TextSplice {
            node_id,
            start,
            delete_count,
            insert_text,
            precondition,
        } = operation
        else {
            continue;
        };
        edits_by_node.entry(node_id.clone()).or_default().push((
            *start,
            *delete_count,
            insert_text.clone(),
            precondition.node_hash.clone(),
        ));
    }
    if edits_by_node.is_empty() {
        return Ok(hcd_core::PdfRasterPlan::default());
    }
    let manifest = bundle.manifest()?;
    if manifest.source.format != "pdf" {
        return Ok(hcd_core::PdfRasterPlan::default());
    }
    let mut by_page: BTreeMap<u32, Vec<(String, String)>> = BTreeMap::new();
    let mut skipped = Vec::new();
    for (node_id, splices) in edits_by_node {
        let lookup = match hcd_core::get_text_node(bundle, &node_id) {
            Ok(lookup) => lookup,
            Err(error) => {
                skipped.push(raster_skip(&node_id, error.to_string()));
                continue;
            }
        };
        let Some(address) = lookup
            .node
            .source
            .paragraph_id
            .as_deref()
            .and_then(pdf_text_address)
        else {
            skipped.push(raster_skip(
                &node_id,
                "PDF text node has no /page[n]/text[m] address".to_string(),
            ));
            continue;
        };
        let node_hash = hash_bytes(lookup.node.text.as_bytes());
        if node_hash != lookup.node.node_hash {
            return Err(HcdError::InvalidBundle(format!(
                "node {node_id} text hash does not match its source map"
            )));
        }
        if splices.iter().any(|splice| splice.3 != node_hash) {
            return Err(HcdError::PreconditionFailed(format!(
                "node {node_id} expected hash {}, actual {node_hash}",
                splices[0].3
            )));
        }
        let plain: Vec<(usize, usize, String)> = splices
            .iter()
            .map(|(start, delete_count, text, _)| (*start, *delete_count, text.clone()))
            .collect();
        let replacement = splice_chars(&lookup.node.text, &plain)?;
        by_page
            .entry(address.0)
            .or_default()
            .push((node_id, replacement));
    }
    let _ = source;
    if by_page.is_empty() {
        return Ok(hcd_core::PdfRasterPlan {
            rasters: Vec::new(),
            skipped,
        });
    }
    let mut rasters = Vec::new();
    for (page, edits) in by_page {
        match paint_page_raster(bundle, page, &edits) {
            Ok((asset, font_ids)) => rasters.push(hcd_core::PdfPageRaster {
                font_ids,
                page,
                asset,
                source_composited: false,
            }),
            Err(error) => skipped.push(raster_skip("", error.to_string())),
        }
    }
    Ok(hcd_core::PdfRasterPlan { rasters, skipped })
}

fn paint_page_raster(
    bundle: &Bundle,
    page: u32,
    edits: &[(String, String)],
) -> Result<(AssetDescriptor, Vec<String>), HcdError> {
    let manifest = bundle.manifest()?;
    let mut font_ids = std::collections::BTreeSet::new();
    let mut html_parts = Vec::new();
    for page_number in 0..manifest.index_page_count {
        let index = bundle.read_index_page(&manifest, page_number)?;
        for descriptor in &index.chunks {
            let html = bundle.read_chunk(descriptor)?;
            if html.contains(&format!("data-hcd-page=\"{page}\"")) {
                html_parts.push(html);
            }
        }
    }
    let html = html_parts.join("\n");
    font_ids.extend(raster_font_ids(&html)?);
    let href = raster_asset_href(&html).ok_or_else(|| {
        HcdError::InvalidBundle(format!("PDF page {page} has no page image to recompose"))
    })?;
    let bytes = std::fs::read(bundle.resolve_href(href)?)?;
    let mut image = image::load_from_memory(&bytes)
        .map_err(|error| HcdError::InvalidBundle(format!("PDF page {page} image: {error}")))?
        .to_rgba8();
    let (page_width, page_height) =
        page_size_pt(&html).unwrap_or((image.width() as f32, image.height() as f32));
    let scale_x = image.width() as f32 / page_width.max(1.0);
    let scale_y = image.height() as f32 / page_height.max(1.0);
    for (node_id, text) in edits {
        let (left, top, width, height) = text_box(&html, node_id).ok_or_else(|| {
            HcdError::Unsupported(format!(
                "PDF text node {node_id} has no rendered text rectangle"
            ))
        })?;
        let x = (left * scale_x).round() as i32;
        let y = (top * scale_y).round() as i32;
        let box_width = (width * scale_x).round().max(1.0) as i32;
        let box_height = (height * scale_y).round().max(1.0) as i32;
        fill_rect(
            &mut image,
            x,
            y,
            box_width,
            box_height,
            [255, 255, 255, 255],
        );
        let mask = pdf_handler::font_embedder::rasterize_bundled_text(
            text,
            (box_height as f32 * 0.8).max(8.0),
        )
        .map_err(|error| HcdError::Unsupported(error.to_string()))?;
        let paint_y = y + (box_height - mask.height as i32).max(0) / 2;
        if mask.width > box_width as usize
            || mask.height > box_height as usize
            || x < 0
            || paint_y < 0
            || x as u64 + mask.width as u64 > u64::from(image.width())
            || paint_y as u64 + mask.height as u64 > u64::from(image.height())
        {
            return Err(HcdError::Unsupported("PDF fallback text does not fit its page rectangle; use a source renderer or resize the text region".into()));
        }
        font_ids.extend(mask.fonts.iter().map(|font| font.id.clone()));
        blit_mask(&mut image, x, paint_y, &mask);
    }
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            HcdError::InvalidBundle(format!("failed to encode recomposed page: {error}"))
        })?;
    let mut asset = bundle.stage_asset_from_reader("png", &mut Cursor::new(encoded))?;
    asset.source_part = format!("pdf/pages/{page}/composited-raster");
    Ok((asset, font_ids.into_iter().collect()))
}

// A new source-free repaint starts from the previous page bitmap. Keep its
// known dependencies conservatively, even when some old pixels are covered.
fn raster_font_ids(html: &str) -> Result<std::collections::BTreeSet<String>, HcdError> {
    let mut reader = quick_xml::Reader::from_str(html);
    loop {
        let tag = match reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        {
            quick_xml::events::Event::Start(tag) | quick_xml::events::Event::Empty(tag)
                if tag.name().as_ref() == b"img" =>
            {
                tag
            }
            quick_xml::events::Event::Eof => return Ok(Default::default()),
            _ => continue,
        };
        let mut raster = false;
        let mut fonts = String::new();
        for attr in tag.attributes() {
            let attr = attr.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
            if attr.key.as_ref() == b"class" {
                raster = attr
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                    .split_whitespace()
                    .any(|class| class == "hcd-pdf-page-raster");
            } else if attr.key.as_ref() == b"data-hcd-raster-font-ids" {
                fonts = attr
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                    .into_owned();
            }
        }
        if raster {
            return Ok(fonts.split_whitespace().map(str::to_string).collect());
        }
    }
}

fn raster_asset_href(html: &str) -> Option<&str> {
    let class_at = html.find("class=\"hcd-pdf-page-raster\"")?;
    let tag_start = html[..class_at].rfind("<img")?;
    let tag_end = html[class_at..].find('>')? + class_at;
    let tag = &html[tag_start..=tag_end];
    let marker = "data-hcd-asset-href=\"";
    let start = tag.find(marker)? + marker.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn page_size_pt(html: &str) -> Option<(f32, f32)> {
    let style_at = html.find("class=\"hcd-pdf-page\"")?;
    let style_marker = "style=\"";
    let start = html[style_at..].find(style_marker)? + style_at + style_marker.len();
    let end = html[start..].find('"')? + start;
    let style = &html[start..end];
    let width = style_pt(style, "width")?;
    let height = style_pt(style, "height")?;
    Some((width, height))
}

fn style_pt(style: &str, name: &str) -> Option<f32> {
    let value = style.split(';').find_map(|declaration| {
        let (key, value) = declaration.split_once(':')?;
        (key.trim() == name).then_some(value.trim())
    })?;
    let number: f32 = value.strip_suffix("pt")?.trim().parse().ok()?;
    number.is_finite().then_some(number)
}

fn text_box(html: &str, node_id: &str) -> Option<(f32, f32, f32, f32)> {
    let anchor = format!("data-hcd-text-node=\"{node_id}\"");
    let at = html.find(&anchor)?;
    let start = html[..at].rfind("<p ")?;
    let end = at + html[at..].find('>')?;
    let tag = &html[start..end];
    let style_start = tag.find("style=\"")? + "style=\"".len();
    let style = &tag[style_start..];
    let style = &style[..style.find('"')?];
    // data-hcd-y retains PDF source coordinates (bottom origin). The inline
    // style is the actual cropped/rotated HTML preview rectangle (top origin).
    Some((
        style_pt(style, "left")?,
        style_pt(style, "top")?,
        style_pt(style, "width")?,
        style_pt(style, "height")?,
    ))
}

fn fill_rect(
    image: &mut image::RgbaImage,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    color: [u8; 4],
) {
    for row in y..y + height {
        for column in x..x + width {
            if let Some(pixel) = image.get_pixel_mut_checked(column as u32, row as u32) {
                *pixel = image::Rgba(color);
            }
        }
    }
}

fn blit_mask(
    image: &mut image::RgbaImage,
    x: i32,
    y: i32,
    mask: &pdf_handler::font_embedder::TextMask,
) {
    for row in 0..mask.height {
        for column in 0..mask.width {
            let alpha = mask.alpha[row * mask.width + column];
            if alpha == 0 {
                continue;
            }
            let px = x + column as i32;
            let py = y + row as i32;
            if let Some(pixel) = image.get_pixel_mut_checked(px as u32, py as u32) {
                *pixel = image::Rgba([0, 0, 0, 255]);
            }
        }
    }
}

fn raster_skip(node_id: &str, message: String) -> hcd_core::FidelityWarning {
    hcd_core::FidelityWarning {
        code: "PDF_PAGE_RECOMPOSITION_SKIPPED".to_string(),
        message,
        node_id: if node_id.is_empty() {
            None
        } else {
            Some(node_id.to_string())
        },
        source_part: None,
    }
}

fn pdf_text_address(path: &str) -> Option<(u32, usize)> {
    let rest = path.strip_prefix("/page[")?;
    let (page, rest) = rest.split_once("]/text[")?;
    let index = rest.strip_suffix(']')?;
    Some((page.parse().ok()?, index.parse().ok()?))
}

fn splice_chars(text: &str, splices: &[(usize, usize, String)]) -> Result<String, HcdError> {
    let mut ordered = splices.to_vec();
    ordered.sort_by_key(|splice| splice.0);
    let char_count = text.chars().count();
    let mut previous_end = 0usize;
    for (start, delete_count, _) in &ordered {
        let end = start
            .checked_add(*delete_count)
            .ok_or_else(|| HcdError::InvalidPatch("splice range overflowed usize".to_string()))?;
        if end > char_count || *start < previous_end {
            return Err(HcdError::InvalidPatch(format!(
                "splice range {start}..{end} is outside the PDF text node"
            )));
        }
        previous_end = end;
    }
    let mut chars: Vec<char> = text.chars().collect();
    for (start, delete_count, insert_text) in ordered.into_iter().rev() {
        chars.splice(start..start + delete_count, insert_text.chars());
    }
    Ok(chars.into_iter().collect())
}

fn page_number(part: &str) -> u64 {
    part.rsplit('/')
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn preflight(source: &Path) -> Result<(), HcdError> {
    pdf_handler::reader::preflight_structural_streams(
        source,
        pdf_handler::reader::PdfStructuralLimits {
            maximum_source_bytes: MAX_HCD_PDF_SOURCE_BYTES as usize,
            maximum_dictionary_bytes: MAX_HCD_PDF_STREAM_DICTIONARY_BYTES,
            maximum_encoded_stream_bytes: MAX_HCD_PDF_STRUCTURAL_STREAM_BYTES,
            maximum_decoded_stream_bytes: MAX_HCD_PDF_STRUCTURAL_STREAM_BYTES,
            maximum_total_decoded_bytes: MAX_HCD_PDF_STRUCTURAL_TOTAL_BYTES,
            maximum_structural_streams: MAX_HCD_PDF_STRUCTURAL_STREAMS,
            maximum_xref_entries: MAX_HCD_PDF_XREF_ENTRIES,
        },
    )
    .map_err(pdf_parse_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use lopdf::{dictionary, Document, Object, Stream};
    use std::fs;
    use std::io::Write as IoWrite;

    #[test]
    fn pdf_text_controls_are_sanitized_before_hcd_publication() {
        let (text, replaced) = sanitize_pdf_text("a\0b\u{b}c\td".to_string());
        assert_eq!(text, "a b c\td");
        assert_eq!(replaced, 2);
    }

    fn write_page_stream_bomb(path: &Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let mut content = Stream::new(
            dictionary! {},
            vec![b'x'; MAX_HCD_PDF_PAGE_CONTENT_BYTES + 1],
        );
        content.compress().unwrap();
        let content_id = document.add_object(content);
        let resources_id = document.add_object(dictionary! {});
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).unwrap();
    }

    pub(super) fn write_simple_visual_pdf(path: &Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            vec![128],
        ));
        let content_id = document.add_object(Stream::new(
            dictionary! {},
            b"0.1 0.6 0.9 rg 0 0 200 300 re f q 40 0 0 30 10 20.123456 cm /Im1 Do Q 0 0 0 rg BT /F1 12 Tf 20 250 Td (Hello HCD) Tj ET".to_vec(),
        ));
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
            "XObject" => dictionary! { "Im1" => image_id },
        });
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
            "CropBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).unwrap();
    }

    #[test]
    fn hcd_pdf_import_publishes_a_valid_lazy_page_raster() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("visual.pdf");
        let bundle_path = temp.path().join("bundle");
        write_simple_visual_pdf(&source);
        let manifest = import_pdf(
            &source,
            &bundle_path,
            &ImportOptions::new("pdf-page-raster"),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(manifest.chunk_count, 1);
        let bundle = Bundle::open(&bundle_path).unwrap();
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let styles = std::fs::read_to_string(bundle_path.join("styles.css")).unwrap();
        assert!(styles.contains("body:not([data-hcd-text-hitboxes=\"off\"]) .hcd-pdf-text:hover"));
        assert!(styles
            .contains("body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-pdf-visual-node:hover"));
        assert!(styles.contains(".hcd-pdf-visual-node{pointer-events:none"));
        assert!(styles.contains(".hcd-pdf-visual-node{pointer-events:auto"));
        assert!(styles.contains(".hcd-pdf-text{position:absolute;min-width:max-content"));
        let assets: Vec<AssetDescriptor> =
            serde_json::from_slice(&std::fs::read(bundle_path.join("assets/index.json")).unwrap())
                .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].source_part, "pdf/pages/1/composited-raster");
        let index = bundle.read_index_page(&manifest, 0).unwrap();
        let html = bundle.read_chunk(&index.chunks[0]).unwrap();
        assert!(html.contains("class=\"hcd-pdf-page-raster\""));
        assert!(html.contains("loading=\"eager\""));
        assert!(html.contains("data-hcd-source-raster=\"true\""));
        assert!(html.contains("data-hcd-text-node=\"n_"));
        assert!(html.contains("data-hcd-source-path=\"/page[1]/text[1]\""));
        assert!(html.contains("data-hcd-source-order=\"1\""));
        assert!(html.contains("data-hcd-mapping=\"source\""));
        assert!(html.contains("data-hcd-bbox=\""));
        assert!(html.contains("data-hcd-node-kind=\"pdf-image\""));
        assert!(html.contains("data-hcd-source-path=\"/page[1]/image[1]\""));
        assert!(html.contains("data-hcd-xobject=\"Im1\""));
        assert!(html.contains("data-hcd-transform=\"40,0,0,30,10,20.123"));
        assert!(html.contains("data-hcd-geometry=\"xobject-ctm\""));
        assert_eq!(hcd_core::extract_html_image_nodes(&html).unwrap().len(), 1);

        let source_map = bundle.read_map(&index.chunks[0]).unwrap();
        assert_eq!(source_map.entries.len(), 2);
        let text_entry = source_map
            .entries
            .iter()
            .find(|entry| entry.source.node_kind == "pdf-text")
            .expect("mapped PDF text node");
        assert_eq!(
            text_entry.source.paragraph_id.as_deref(),
            Some("/page[1]/text[1]")
        );
        assert!(text_entry.source.editable);
        let image_entry = source_map
            .entries
            .iter()
            .find(|entry| entry.source.node_kind == "image")
            .expect("mapped PDF image node");
        assert_eq!(
            image_entry.source.paragraph_id.as_deref(),
            Some("/page[1]/image[1]")
        );
        assert!(image_entry.source.editable);
    }

    #[test]
    fn pdf_repaint_uses_preview_coordinates_instead_of_pdf_source_y() {
        let html = r#"<p class="hcd-pdf-text" data-hcd-text-node="date" data-hcd-y="37.08" data-hcd-width="54" style="position:absolute;left:478pt;top:792.8pt;width:54pt;height:12pt;font-family:宋体"><span>2024/7/31</span></p>"#;
        assert_eq!(text_box(html, "date"), Some((478.0, 792.8, 54.0, 12.0)));
        assert_eq!(
            style_pt("border-width:10pt;width: -2.5pt", "width"),
            Some(-2.5)
        );
        assert_eq!(style_pt("width:NaNpt", "width"), None);
        assert_eq!(
            text_box("<p data-hcd-text-node=\"missing\">text</p>", "missing"),
            None
        );
    }

    #[test]
    fn edited_pdf_text_recomposites_the_page_raster() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("visual.pdf");
        let bundle_path = temp.path().join("bundle");
        write_simple_visual_pdf(&source);
        import_pdf(
            &source,
            &bundle_path,
            &ImportOptions::new("pdf-page-raster"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let manifest = bundle.manifest().unwrap();
        let index = bundle.read_index_page(&manifest, 0).unwrap();
        let html = bundle.read_chunk(&index.chunks[0]).unwrap();
        let previous_raster = html
            .split("class=\"hcd-pdf-page-raster\"")
            .nth(1)
            .and_then(|rest| rest.split("asset://sha256/").nth(1))
            .and_then(|rest| rest.split('"').next())
            .unwrap()
            .to_string();
        let source_map = bundle.read_map(&index.chunks[0]).unwrap();
        let text_entry = source_map
            .entries
            .iter()
            .find(|entry| entry.source.node_kind == "pdf-text")
            .unwrap();
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: manifest.document_id.clone(),
            patch_id: "pdf-text-recompose".to_string(),
            base_revision: 0,
            actor: std::collections::BTreeMap::from([(
                "userId".to_string(),
                "editor-1".to_string(),
            )]),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: text_entry.node_id.clone(),
                start: 6,
                delete_count: 3,
                insert_text: "PDF".to_string(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: text_entry.node_hash.clone(),
                },
            }],
            metadata: std::collections::BTreeMap::new(),
        };
        let plan =
            plan_pdf_page_rasters(&bundle, &temp.path().join("missing.pdf"), &patch.operations)
                .unwrap();
        assert_eq!(plan.rasters.len(), 1, "{:?}", plan.skipped);
        assert_ne!(plan.rasters[0].asset.hash, previous_raster);
        let original = image::open(
            bundle
                .resolve_href(raster_asset_href(&html).unwrap())
                .unwrap(),
        )
        .unwrap()
        .into_rgba8();
        let repainted = image::open(bundle.resolve_href(&plan.rasters[0].asset.href).unwrap())
            .unwrap()
            .into_rgba8();
        let (_, top, _, height) = text_box(&html, &text_entry.node_id).unwrap();
        let (_, page_height) = page_size_pt(&html).unwrap();
        let scale = original.height() as f32 / page_height;
        let first_row = (top * scale).round() as u32;
        let last_row = first_row + (height * scale).round() as u32;
        let mut changed = 0;
        for (x, y, pixel) in original.enumerate_pixels() {
            if pixel != repainted.get_pixel(x, y) {
                changed += 1;
                assert!(
                    (first_row..=last_row).contains(&y),
                    "text painted outside preview rectangle at row {y}"
                );
            }
        }
        assert!(changed > 0);
        let result = hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 0, plan).unwrap();
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "PDF_EDITED_TEXT_PAGE_RECOMPOSED"));
        let manifest = bundle.manifest().unwrap();
        let index = bundle.read_index_page(&manifest, 0).unwrap();
        let html = bundle.read_chunk(&index.chunks[0]).unwrap();
        assert!(html.contains(">Hello PDF<"));
        assert!(!html.contains("data-hcd-patched"));
        assert!(!html.contains(&format!("asset://sha256/{previous_raster}")));
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
    }

    #[test]
    fn source_free_repaint_preserves_mixed_text_and_refuses_partial_line_or_glyph_output() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("visual.pdf");
        write_simple_visual_pdf(&source);
        let path = temp.path().join("bundle");
        import_pdf(&source, &path, &ImportOptions::new("font-fallback"), |_| {
            Ok(())
        })
        .unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let original = hcd_core::extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0);
        let original_html = bundle
            .read_chunk(
                &bundle
                    .read_index_page(&bundle.manifest().unwrap(), 0)
                    .unwrap()
                    .chunks[0],
            )
            .unwrap();
        let make_patch =
            |text: &str, revision: u64, hash: String, count: usize| hcd_core::PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "font-fallback".into(),
                patch_id: format!("font-{revision}"),
                base_revision: revision,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![hcd_core::PatchOperation::TextSplice {
                    node_id: original.node_id.clone(),
                    start: 0,
                    delete_count: count,
                    insert_text: text.into(),
                    precondition: hcd_core::NodePrecondition { node_hash: hash },
                }],
            };
        let missing_source = temp.path().join("not-present.pdf");
        let patch = make_patch(
            "中文😀",
            0,
            original.node_hash.clone(),
            original.text.chars().count(),
        );
        let plan = plan_pdf_page_rasters(&bundle, &missing_source, &patch.operations).unwrap();
        assert_eq!(plan.rasters.len(), 1, "{:?}", plan.skipped);
        let fonts = plan.rasters[0].font_ids.clone();
        assert_eq!(fonts.len(), 2);
        if let Some(output) = std::env::var_os("OFFICECLI_TEST_FONT_PROOF") {
            let mask = pdf_handler::font_embedder::rasterize_bundled_text(
                "中文 English 😀 👨‍👩‍👧‍👦 👍🏽 🇨🇳",
                40.0,
            )
            .unwrap();
            let mut proof = image::RgbaImage::from_pixel(
                (mask.width + 32) as u32,
                (mask.height + 32) as u32,
                image::Rgba([255, 255, 255, 255]),
            );
            blit_mask(&mut proof, 16, 16, &mask);
            proof.save(output).unwrap();
        }
        let result = hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 0, plan).unwrap();
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "PDF_RASTER_FALLBACK_FONTS"));
        let index = bundle
            .read_index_page(&bundle.manifest().unwrap(), 0)
            .unwrap();
        let html = bundle.read_chunk(&index.chunks[0]).unwrap();
        for font in fonts {
            assert!(html.contains(&font));
        }
        assert_eq!(
            hcd_core::get_text_node(&bundle, &original.node_id)
                .unwrap()
                .node
                .text,
            "中文😀"
        );
        assert!(!html.contains("data-hcd-patched=\"true\""));
        let (historical, _) =
            hcd_core::manifest_at_revision(&bundle, &bundle.manifest().unwrap(), Some(0)).unwrap();
        assert_eq!(
            bundle
                .read_chunk(&bundle.read_index_page(&historical, 0).unwrap().chunks[0])
                .unwrap(),
            original_html
        );
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let current = hcd_core::get_text_node(&bundle, &original.node_id).unwrap();
        let next = make_patch("中", 1, current.node.node_hash.clone(), 3);
        let inherited = plan_pdf_page_rasters(&bundle, &missing_source, &next.operations).unwrap();
        assert_eq!(
            inherited.rasters[0].font_ids.len(),
            2,
            "retain known fonts of the reused background raster"
        );
        for text in ["A\nB", "A\r\nB", "əʊ", "\u{10FFFF}", &"W".repeat(4096)] {
            let patch = make_patch(text, 1, current.node.node_hash.clone(), 3);
            let plan = plan_pdf_page_rasters(&bundle, &missing_source, &patch.operations).unwrap();
            assert!(
                plan.rasters.is_empty(),
                "partial raster must not be published for {text:?}"
            );
            assert!(plan
                .skipped
                .iter()
                .any(|warning| warning.code == "PDF_PAGE_RECOMPOSITION_SKIPPED"));
            assert_eq!(bundle.manifest().unwrap().revision, 1);
        }
        // Canonical text is still saved in the explicit overlay path, including
        // everything after the newline; it must not be marked as recomposited.
        let patch = make_patch("A\nB", 1, current.node.node_hash, 3);
        let plan = plan_pdf_page_rasters(&bundle, &missing_source, &patch.operations).unwrap();
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 1, plan).unwrap();
        let html = bundle
            .read_chunk(
                &bundle
                    .read_index_page(&bundle.manifest().unwrap(), 0)
                    .unwrap()
                    .chunks[0],
            )
            .unwrap();
        assert!(html.contains("data-hcd-patched=\"true\""));
        assert_eq!(
            hcd_core::get_text_node(&bundle, &original.node_id)
                .unwrap()
                .node
                .text,
            "A\nB"
        );
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }

    pub(super) fn current_raster(bundle: &Bundle) -> image::RgbaImage {
        let manifest = bundle.manifest().unwrap();
        let index = bundle.read_index_page(&manifest, 0).unwrap();
        let html = bundle.read_chunk(&index.chunks[0]).unwrap();
        image::open(
            bundle
                .resolve_href(raster_asset_href(&html).unwrap())
                .unwrap(),
        )
        .unwrap()
        .to_rgba8()
    }

    pub(super) fn rendered_source(path: &Path) -> image::RgbaImage {
        let pdf = Pdf::new(Arc::new(fs::read(path).unwrap())).unwrap();
        let (w, h) = pdf.pages()[0].render_dimensions();
        let raster = render_page_raster(&pdf, 0, w, h, PdfRasterMode::Lossless, 100).unwrap();
        image::load_from_memory(&raster.bytes).unwrap().to_rgba8()
    }

    fn pixel_at(image: &image::RgbaImage, x: f32, top: f32) -> [u8; 4] {
        image
            .get_pixel(
                (x * HCD_PDF_RASTER_SCALE) as u32,
                (top * HCD_PDF_RASTER_SCALE) as u32,
            )
            .0
    }

    #[test]
    fn pdf_image_save_and_native_export_recover_background_and_replay_history() {
        use hcd_core::{
            ImageGeometry, ImageGeometryUnit, PatchBatch, PatchOperation, VisualPrecondition,
        };
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("visual.pdf");
        let bundle_path = temp.path().join("bundle");
        write_simple_visual_pdf(&source);
        let mut options = ImportOptions::new("native-image");
        options.chunk_blocks = 1; // page objects span multiple continuation chunks
        options.pdf_raster_mode = PdfRasterMode::Lossless;
        import_pdf(&source, &bundle_path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let original = current_raster(&bundle);
        let background = pixel_at(&original, 70., 230.);
        let image = hcd_core::extract_image_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0);
        let id = image.node.node_id;
        let geometry = ImageGeometry {
            x: 80.,
            y: 220.,
            width: 40.,
            height: 30.,
            unit: ImageGeometryUnit::Pt,
        };
        let mut patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "native-image".into(),
            patch_id: "move-picture".into(),
            base_revision: 0,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![PatchOperation::ImageGeometry {
                node_id: id.clone(),
                geometry,
                precondition: VisualPrecondition {
                    visual_hash: image.node.visual_hash,
                },
            }],
        };
        let text = hcd_core::extract_text_page(&bundle, None, 20)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| !entry.text.is_empty())
            .unwrap();
        patch.operations.push(PatchOperation::TextSplice {
            node_id: text.node_id,
            start: 0,
            delete_count: text.text.chars().count(),
            insert_text: "Saved native text".into(),
            precondition: hcd_core::NodePrecondition {
                node_hash: text.node_hash,
            },
        });
        let plan = plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
        assert!(plan.rasters[0].source_composited);
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 0, plan).unwrap();
        let moved = current_raster(&bundle);
        assert_eq!(
            pixel_at(&moved, 20., 270.),
            background,
            "old image must reveal the original blue background"
        );
        assert_ne!(pixel_at(&moved, 90., 230.), background);
        let manifest = bundle.manifest().unwrap();
        let chunks = bundle.read_index_page(&manifest, 0).unwrap().chunks;
        assert!(chunks.len() > 1);
        let image_html = bundle.read_chunk(&chunks[0]).unwrap();
        assert!(image_html.contains("data-hcd-image-composited=\"true\""));
        assert!(image_html.contains("display:none"));
        assert!(bundle
            .read_chunk(&chunks[1])
            .unwrap()
            .contains("data-hcd-patched=\"false\""));
        let output = temp.path().join("moved.pdf");
        export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
        let reader = pdf_handler::reader::PdfReader::open(&output.to_string_lossy()).unwrap();
        assert!(reader
            .extract_page_text(1)
            .unwrap()
            .contains("Saved native text"));
        assert_eq!(
            rendered_source(&output),
            moved,
            "native export and saved preview must use the same page composition"
        );
        // A replacement preserves transparency, rather than painting a white box.
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                &[0, 0, 0, 0, 0, 255, 0, 255],
                2,
                1,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let asset = bundle
            .stage_asset_from_reader("png", &mut Cursor::new(bytes))
            .unwrap();
        patch.patch_id = "replace-picture".into();
        patch.base_revision = 1;
        patch.operations = vec![PatchOperation::ImageReplace {
            node_id: id.clone(),
            asset_hash: asset.hash,
            precondition: VisualPrecondition {
                visual_hash: hcd_core::get_image_node(&bundle, &id)
                    .unwrap()
                    .node
                    .visual_hash,
            },
        }];
        let plan = plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 1, plan).unwrap();
        let replaced = current_raster(&bundle);
        assert_eq!(pixel_at(&replaced, 85., 230.), background);
        let green = pixel_at(&replaced, 115., 230.);
        assert!(
            green[1] > 240 && green[0] < 10 && green[2] < 10,
            "{green:?}"
        );
        let output = temp.path().join("replaced.pdf");
        export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
        assert_eq!(rendered_source(&output), replaced);
        let historical = temp.path().join("revision-one.pdf");
        export_pdf(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(1),
                fidelity_report: None,
            },
        )
        .unwrap();
        assert_eq!(rendered_source(&historical), moved);
        assert!(plan_pdf_page_rasters(
            &bundle,
            &temp.path().join("missing.pdf"),
            &patch.operations
        )
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        patch.patch_id = "missing-raster-plan".into();
        patch.base_revision = 2;
        patch.operations = vec![PatchOperation::ImageGeometry {
            node_id: id.clone(),
            geometry: ImageGeometry {
                x: 120.,
                y: 220.,
                width: 40.,
                height: 30.,
                unit: ImageGeometryUnit::Pt,
            },
            precondition: VisualPrecondition {
                visual_hash: hcd_core::get_image_node(&bundle, &id)
                    .unwrap()
                    .node
                    .visual_hash,
            },
        }];
        assert!(hcd_core::apply_patch(&bundle, &patch, 2).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{validation:?}");
    }

    #[test]
    fn rotated_cropped_pdf_hitboxes_image_save_and_text_export_agree() {
        use hcd_core::{
            ImageGeometry, ImageGeometryUnit, PatchBatch, PatchOperation, VisualPrecondition,
        };
        // Independent page-space / viewport goldens for a [5,10,195,290]
        // crop and the desired source rectangle [70,100,30,20].
        for (rotation, initial, desired, old_center, new_center) in [
            (
                0i64,
                [5., 239.876544, 40., 30.],
                [65., 170., 30., 20.],
                [25., 254.87654],
                [80., 180.],
            ),
            (
                90,
                [10.123456, 5., 30., 40.],
                [90., 65., 20., 30.],
                [25.123456, 25.],
                [100., 80.],
            ),
            (
                180,
                [145., 10.123456, 40., 30.],
                [95., 90., 30., 20.],
                [165., 25.123456],
                [110., 100.],
            ),
            (
                270,
                [239.876544, 145., 30., 40.],
                [170., 95., 20., 30.],
                [254.87654, 165.],
                [180., 110.],
            ),
            (
                -90,
                [239.876544, 145., 30., 40.],
                [170., 95., 20., 30.],
                [254.87654, 165.],
                [180., 110.],
            ),
            (
                450,
                [10.123456, 5., 30., 40.],
                [90., 65., 20., 30.],
                [25.123456, 25.],
                [100., 80.],
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("rotated.pdf");
            write_simple_visual_pdf(&source);
            let mut doc = Document::load(&source).unwrap();
            let page = doc.get_pages()[&1];
            let parent = doc
                .get_dictionary(page)
                .unwrap()
                .get(b"Parent")
                .unwrap()
                .as_reference()
                .unwrap();
            let page_dict = doc.get_dictionary_mut(page).unwrap();
            page_dict.remove(b"MediaBox");
            page_dict.remove(b"CropBox");
            let parent = doc.get_dictionary_mut(parent).unwrap();
            parent.set("MediaBox", vec![0.into(), 0.into(), 200.into(), 300.into()]);
            parent.set("CropBox", vec![5.into(), 10.into(), 195.into(), 290.into()]);
            parent.set("Rotate", rotation);
            doc.save(&source).unwrap();
            let root = temp.path().join("bundle");
            let mut options = ImportOptions::new("rotated-crop");
            options.chunk_blocks = 1;
            options.pdf_raster_mode = PdfRasterMode::Lossless;
            import_pdf(&source, &root, &options, |_| Ok(())).unwrap();
            let bundle = Bundle::open(&root).unwrap();
            let image = hcd_core::extract_image_page(&bundle, None, 10)
                .unwrap()
                .entries
                .remove(0)
                .node;
            let geometry = image.geometry.unwrap();
            for (actual, expected) in [geometry.x, geometry.y, geometry.width, geometry.height]
                .into_iter()
                .zip(initial)
            {
                assert!(
                    (actual - expected).abs() < 0.001,
                    "rotation {rotation}: {actual} != {expected}"
                );
            }
            let original = current_raster(&bundle);
            let original_image = pixel_at(&original, old_center[0], old_center[1]);
            let background = pixel_at(&original, new_center[0], new_center[1]);
            assert_ne!(original_image, background);
            let mut patch = PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_3.into(),
                document_id: "rotated-crop".into(),
                patch_id: "move-rotated-image".into(),
                base_revision: 0,
                actor: Default::default(),
                metadata: Default::default(),
                operations: vec![PatchOperation::ImageGeometry {
                    node_id: image.node_id,
                    geometry: ImageGeometry {
                        x: desired[0],
                        y: desired[1],
                        width: desired[2],
                        height: desired[3],
                        unit: ImageGeometryUnit::Pt,
                    },
                    precondition: VisualPrecondition {
                        visual_hash: image.visual_hash,
                    },
                }],
            };
            let plan = plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
            hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 0, plan).unwrap();
            let moved = current_raster(&bundle);
            assert_eq!(
                pixel_at(&moved, old_center[0], old_center[1]),
                background,
                "rotation {rotation}: original background"
            );
            assert_eq!(
                pixel_at(&moved, new_center[0], new_center[1]),
                original_image,
                "rotation {rotation}: new picture position"
            );
            let output = temp.path().join("moved.pdf");
            export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
            let reader = pdf_handler::reader::PdfReader::open(&output.to_string_lossy()).unwrap();
            let bbox = reader
                .parse_page_text_blocks_bounded(
                    1,
                    MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                    MAX_HCD_PDF_AUX_STREAM_BYTES,
                )
                .unwrap()
                .image_blocks
                .remove(0)
                .bbox;
            for (actual, expected) in [bbox.x, bbox.y, bbox.width, bbox.height]
                .into_iter()
                .zip([70., 100., 30., 20.])
            {
                assert!((actual - expected).abs() < 0.001, "{rotation}: {bbox:?}");
            }
            assert_eq!(rendered_source(&output), moved);
            let text = hcd_core::extract_text_page(&bundle, None, 20)
                .unwrap()
                .entries
                .into_iter()
                .find(|node| !node.text.is_empty())
                .unwrap();
            let manifest = bundle.manifest().unwrap();
            let chunks = bundle.read_index_page(&manifest, 0).unwrap().chunks;
            let html = bundle.read_chunk(&chunks[1]).unwrap();
            let (left, top, width, height) = text_box(&html, &text.node_id).unwrap();
            assert!(left >= 0. && top >= 0. && width > 0. && height > 0.);
            if rotation.rem_euclid(180) == 90 {
                assert!(height > width && html.contains("rotate("));
            }
            patch.patch_id = "save-rotated-text".into();
            patch.base_revision = 1;
            patch.operations = vec![PatchOperation::TextSplice {
                node_id: text.node_id,
                start: 0,
                delete_count: text.text.chars().count(),
                insert_text: "Rotated saved".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: text.node_hash,
                },
            }];
            let plan = plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
            assert!(plan.rasters[0].source_composited);
            hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 1, plan).unwrap();
            let output = temp.path().join("text.pdf");
            export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
            assert_eq!(rendered_source(&output), current_raster(&bundle));
            assert!(
                pdf_handler::reader::PdfReader::open(&output.to_string_lossy())
                    .unwrap()
                    .extract_page_text(1)
                    .unwrap()
                    .contains("Rotated saved")
            );
            let validation = hcd_core::validate_bundle(&bundle).unwrap();
            assert!(
                validation.valid,
                "rotation {rotation}: {:?}",
                validation.issues
            );
        }
    }

    #[test]
    fn legacy_unrotated_picture_position_save_overrides_original_source_bbox() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.pdf");
        write_simple_visual_pdf(&source);
        let root = temp.path().join("bundle");
        import_pdf(
            &source,
            &root,
            &ImportOptions::new("legacy-position"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let head = bundle.manifest().unwrap();
        let chunk = bundle.read_index_page(&head, 0).unwrap().chunks.remove(0);
        let html = bundle
            .read_chunk(&chunk)
            .unwrap()
            .replace(" data-hcd-pdf-coordinates=\"viewport-v1\"", "");
        let (href, hash) = bundle.write_chunk_object(&html).unwrap();
        hcd_core::apply_pdf_layout_upgrade(
            &bundle,
            hcd_core::PdfLayoutUpgrade {
                base_revision: 0,
                root_hash: head.root_hash,
                chunks: vec![hcd_core::PdfLayoutChunk {
                    chunk_id: chunk.chunk_id,
                    previous_html_hash: chunk.html_hash,
                    html_href: href,
                    html_hash: hash,
                }],
                assets: vec![],
            },
            Default::default(),
        )
        .unwrap();
        let image = hcd_core::extract_image_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_3.into(),
            document_id: "legacy-position".into(),
            patch_id: "move-legacy-picture".into(),
            base_revision: 1,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![hcd_core::PatchOperation::ImageGeometry {
                node_id: image.node_id,
                geometry: hcd_core::ImageGeometry {
                    x: 80.,
                    y: 220.,
                    width: 40.,
                    height: 30.,
                    unit: hcd_core::ImageGeometryUnit::Pt,
                },
                precondition: hcd_core::VisualPrecondition {
                    visual_hash: image.visual_hash,
                },
            }],
        };
        let plan = plan_pdf_page_rasters(&bundle, &source, &patch.operations).unwrap();
        hcd_core::apply_patch_with_pdf_rasters(&bundle, &patch, 1, plan).unwrap();
        let output = temp.path().join("moved.pdf");
        export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
        let reader = pdf_handler::reader::PdfReader::open(&output.to_string_lossy()).unwrap();
        let bbox = reader
            .parse_page_text_blocks_bounded(
                1,
                MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                MAX_HCD_PDF_AUX_STREAM_BYTES,
            )
            .unwrap()
            .image_blocks
            .remove(0)
            .bbox;
        assert!(
            (bbox.x - 80.).abs() < 0.001 && (bbox.y - 50.).abs() < 0.001,
            "{bbox:?}"
        );
        assert_eq!(rendered_source(&output), current_raster(&bundle));
    }

    #[test]
    fn pdf_raster_modes_keep_small_text_quality_gate() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hdoc/pdf-raster-quality.pdf");
        let temp = tempfile::tempdir().unwrap();
        let mut rasters = Vec::new();
        for (name, mode) in [
            ("lossless", PdfRasterMode::Lossless),
            ("auto", PdfRasterMode::Auto),
            ("lossy", PdfRasterMode::Lossy),
        ] {
            let output = temp.path().join(name);
            let mut options = ImportOptions::new(format!("pdf-raster-{name}"));
            options.pdf_raster_mode = mode;
            if mode == PdfRasterMode::Lossy {
                options.pdf_raster_quality = 70;
            }
            import_pdf(&source, &output, &options, |_| Ok(())).unwrap();
            let assets: Vec<AssetDescriptor> =
                serde_json::from_slice(&fs::read(output.join("assets/index.json")).unwrap())
                    .unwrap();
            assert_eq!(assets.len(), 1);
            rasters.push((
                assets[0].href.clone(),
                fs::read(output.join(&assets[0].href)).unwrap(),
            ));
        }
        assert!(rasters[0].0.ends_with(".png"));
        assert!(rasters[1].0.ends_with(".jpg"));
        assert!(rasters[2].0.ends_with(".jpg"));
        assert!(rasters[1].1.len() * 100 <= rasters[0].1.len() * 85);
        let original = image::load_from_memory(&rasters[0].1).unwrap().into_rgb8();
        let selected = image::load_from_memory(&rasters[1].1).unwrap().into_rgb8();
        let squared_error: u64 = original
            .as_raw()
            .iter()
            .zip(selected.as_raw())
            .map(|(a, b)| {
                let difference = i32::from(*a) - i32::from(*b);
                (difference * difference) as u64
            })
            .sum();
        let mse = squared_error as f64 / original.as_raw().len() as f64;
        let psnr = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (65025.0 / mse).log10()
        };
        assert!(psnr >= 35.0, "auto PSNR was {psnr:.2} dB");
    }

    fn compressed_repeated(byte: u8, decoded_size: usize) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        let block = vec![byte; 64 * 1024];
        let mut remaining = decoded_size;
        while remaining > 0 {
            let amount = remaining.min(block.len());
            encoder.write_all(&block[..amount]).unwrap();
            remaining -= amount;
        }
        encoder.finish().unwrap()
    }

    fn push_pdf_object(pdf: &mut Vec<u8>, offsets: &mut Vec<usize>, id: usize, body: &[u8]) {
        offsets.push(pdf.len());
        writeln!(pdf, "{id} 0 obj").unwrap();
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    }

    fn write_object_stream_bomb(path: &Path, decoded_size: usize) {
        let mut pdf = b"%PDF-1.7\n%\xFF\xFF\xFF\xFF\n".to_vec();
        let mut offsets = Vec::new();
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            1,
            b"<< /Type /Catalog /Pages 2 0 R >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            2,
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            3,
            b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources <<>> /MediaBox [0 0 612 792] >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            4,
            b"<< /Length 0 >>\nstream\n\nendstream",
        );
        let compressed = compressed_repeated(b'x', decoded_size);
        let mut stream = format!(
            "<< /Type /ObjStm /N 0 /First 0 /Filter /FlateDecode /Length {} >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        stream.extend_from_slice(&compressed);
        stream.extend_from_slice(b"\nendstream");
        push_pdf_object(&mut pdf, &mut offsets, 5, &stream);

        let xref = pdf.len();
        pdf.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets {
            writeln!(pdf, "{offset:010} 00000 n ").unwrap();
        }
        write!(
            pdf,
            "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
        )
        .unwrap();
        std::fs::write(path, pdf).unwrap();
    }

    fn write_xref_stream_bomb(path: &Path, decoded_size: usize) {
        let mut pdf = b"%PDF-1.7\n%\xFF\xFF\xFF\xFF\n".to_vec();
        let mut offsets = Vec::new();
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            1,
            b"<< /Type /Catalog /Pages 2 0 R >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            2,
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            3,
            b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources <<>> /MediaBox [0 0 612 792] >>",
        );
        push_pdf_object(
            &mut pdf,
            &mut offsets,
            4,
            b"<< /Length 0 >>\nstream\n\nendstream",
        );
        let xref_offset = pdf.len();
        let mut decoded = Vec::with_capacity(decoded_size);
        decoded.extend_from_slice(&[0, 0, 0, 0, 0, 0xff, 0xff]);
        for offset in offsets.iter().copied().chain(std::iter::once(xref_offset)) {
            decoded.push(1);
            decoded.extend_from_slice(&(offset as u32).to_be_bytes());
            decoded.extend_from_slice(&0u16.to_be_bytes());
        }
        decoded.resize(decoded_size, 0);
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(&decoded).unwrap();
        let compressed = encoder.finish().unwrap();
        write!(pdf, "5 0 obj\n<< /Type /XRef /Size 6 /Root 1 0 R /W [1 4 2] /Index [0 6] /Filter /FlateDecode /Length {} >>\nstream\n", compressed.len()).unwrap();
        pdf.extend_from_slice(&compressed);
        write!(pdf, "\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF").unwrap();
        std::fs::write(path, pdf).unwrap();
    }

    fn assert_structural_bomb_is_rejected(source: &Path, bundle: &Path, document_id: &str) {
        let mut events = Vec::new();
        let error = import_pdf(source, bundle, &ImportOptions::new(document_id), |event| {
            events.push(event.clone());
            Ok(())
        })
        .unwrap_err();
        assert!(matches!(error, HcdError::ResourceLimit(_)), "{error}");
        assert!(events
            .iter()
            .any(|event| matches!(event, ImportEvent::ImportStarted { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, ImportEvent::Failed { .. })));
        assert!(!bundle.exists());
    }

    #[test]
    fn hcd_import_rejects_a_compressed_page_stream_bomb_without_publishing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("bomb.pdf");
        let bundle = temp.path().join("bundle");
        write_page_stream_bomb(&source);
        let mut events = Vec::new();
        let error = import_pdf(&source, &bundle, &ImportOptions::new("pdf-bomb"), |event| {
            events.push(event.clone());
            Ok(())
        })
        .unwrap_err();
        assert!(matches!(error, HcdError::ResourceLimit(_)));
        assert!(events
            .iter()
            .any(|event| matches!(event, ImportEvent::ImportStarted { .. })));
        assert!(events
            .iter()
            .any(|event| matches!(event, ImportEvent::Failed { .. })));
        assert!(!bundle.exists());
    }

    #[test]
    fn hcd_import_rejects_an_object_stream_bomb_before_lopdf_without_publishing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("object-stream-bomb.pdf");
        let bundle = temp.path().join("bundle");
        write_object_stream_bomb(&source, MAX_HCD_PDF_STRUCTURAL_STREAM_BYTES + 1);
        assert_structural_bomb_is_rejected(&source, &bundle, "pdf-object-stream-bomb");
    }

    #[test]
    fn hcd_import_rejects_an_xref_stream_bomb_before_lopdf_without_publishing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("xref-stream-bomb.pdf");
        let bundle = temp.path().join("bundle");
        write_xref_stream_bomb(&source, MAX_HCD_PDF_STRUCTURAL_STREAM_BYTES + 1);
        assert_structural_bomb_is_rejected(&source, &bundle, "pdf-xref-stream-bomb");
    }
}
