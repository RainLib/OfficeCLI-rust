//! Rebuild from the immutable source, replaying the selected HCD revision.
//! A disposable candidate keeps failed image rewrites out of the revision head.
use super::*;
use hcd_core::{extract_html_image_nodes, ImageGeometryUnit, PatchOperation};
use pdf_handler::image_edit::{rewrite_image_placements, ImagePlacementEdit, ReplacementImage};
use std::collections::{BTreeSet, HashSet};

fn error(message: impl ToString) -> HcdError {
    HcdError::Unsupported(message.to_string())
}

pub(super) fn image_address(path: &str) -> Option<(u32, usize)> {
    let (page, image) = path.strip_prefix("/page[")?.split_once("]/image[")?;
    Some((page.parse().ok()?, image.strip_suffix(']')?.parse().ok()?))
}

fn replacement(bundle: &Bundle, revision: u64, hash: &str) -> Result<ReplacementImage, HcdError> {
    let asset = bundle
        .read_asset_index_for_revision(revision)?
        .into_iter()
        .find(|asset| asset.hash == hash)
        .map(Ok)
        .unwrap_or_else(|| bundle.staged_asset(hash))?;
    if asset.byte_length > hcd_core::MAX_STAGED_ASSET_BYTES {
        return Err(error("replacement image exceeds asset limit"));
    }
    let path = bundle.resolve_href(&asset.href)?;
    if std::fs::metadata(&path)?.len() != asset.byte_length || hcd_core::hash_file(&path)? != hash {
        return Err(error(
            "replacement image payload does not match its immutable hash",
        ));
    }
    let bytes = std::fs::read(path)?;
    if bytes.len() as u64 != asset.byte_length || hash_bytes(&bytes) != hash {
        return Err(error("replacement image changed while reading its payload"));
    }
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(error)?;
    let (width, height) = reader.into_dimensions().map_err(error)?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > MAX_HCD_PDF_RASTER_PIXELS
    {
        return Err(error(
            "replacement image exceeds the 8192px/32M-pixel limit",
        ));
    }
    let rgba = image::load_from_memory(&bytes)
        .map_err(error)?
        .to_rgba8()
        .into_raw();
    Ok(ReplacementImage {
        width,
        height,
        rgba,
    })
}

fn copy_verified_source(source: &Path, target: &Path, expected: &str) -> Result<(), HcdError> {
    std::fs::copy(source, target)?;
    if std::fs::metadata(target)?.len() > MAX_HCD_PDF_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(
            "copied PDF exceeds the source size limit".into(),
        ));
    }
    let actual = hcd_core::hash_file(target)?;
    if actual != expected {
        return Err(HcdError::SourceMismatch(format!(
            "PDF source changed while copying; expected {expected}, actual {actual}"
        )));
    }
    Ok(())
}

pub(super) fn write_candidate(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
    options: &ExportOptions,
    operations: &[PatchOperation],
) -> Result<(HcdManifest, BTreeSet<u32>), HcdError> {
    // Historical exports can replay legacy coordinates; interactive edits
    // must first upgrade their hitboxes so UI and source positions agree.
    write_candidate_impl(
        bundle,
        source,
        target,
        options,
        operations,
        operations.is_empty(),
    )
}

pub(super) fn write_upgrade_candidate(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
) -> Result<HcdManifest, HcdError> {
    write_candidate_impl(bundle, source, target, &ExportOptions::default(), &[], true)
        .map(|(manifest, _)| manifest)
}

fn write_candidate_impl(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
    options: &ExportOptions,
    operations: &[PatchOperation],
    allow_legacy_rotated: bool,
) -> Result<(HcdManifest, BTreeSet<u32>), HcdError> {
    let (manifest, revision, parts, dirty) = checked_export_state(bundle, source, options)?;
    preflight(source)?;
    if dirty.is_empty() && operations.is_empty() {
        copy_verified_source(source, target, &manifest.source.sha256)?;
        return Ok((manifest, BTreeSet::new()));
    }
    let mut text: BTreeMap<String, hcd_core::TextExtractEntry> =
        collect_dirty_nodes(bundle, &manifest, &parts, &dirty)?
            .into_iter()
            .filter(|entry| entry.source.node_kind != "image")
            .map(|entry| (entry.node_id.clone(), entry))
            .collect();
    let mut splices: BTreeMap<String, Vec<(usize, usize, String)>> = BTreeMap::new();
    let mut pending_images: BTreeMap<String, Vec<&PatchOperation>> = BTreeMap::new();
    let mut pages = BTreeSet::new();
    for operation in operations {
        match operation {
            PatchOperation::TextSplice {
                node_id,
                start,
                delete_count,
                insert_text,
                precondition,
            } => {
                let lookup = hcd_core::get_text_node(bundle, node_id)?;
                if lookup.node.node_hash != precondition.node_hash {
                    return Err(HcdError::PreconditionFailed(format!(
                        "node {node_id} changed"
                    )));
                }
                let address = lookup
                    .node
                    .source
                    .paragraph_id
                    .as_deref()
                    .and_then(pdf_text_address)
                    .ok_or_else(|| error("PDF text node has no source address"))?;
                pages.insert(address.0);
                text.insert(
                    node_id.clone(),
                    hcd_core::TextExtractEntry {
                        chunk_id: lookup.node.chunk_id,
                        node_id: node_id.clone(),
                        text: lookup.node.text,
                        node_hash: lookup.node.node_hash,
                        source: lookup.node.source,
                    },
                );
                splices.entry(node_id.clone()).or_default().push((
                    *start,
                    *delete_count,
                    insert_text.clone(),
                ));
            }
            PatchOperation::ImageGeometry { node_id, .. }
            | PatchOperation::ImageReplace { node_id, .. }
            | PatchOperation::ImageRestoreSource { node_id, .. } => {
                if !pending_images.contains_key(node_id) {
                    let image = hcd_core::get_image_node(bundle, node_id)?;
                    let page = image
                        .node
                        .source
                        .paragraph_id
                        .as_deref()
                        .and_then(image_address)
                        .map(|(page, _)| page)
                        .ok_or_else(|| error("PDF image has no source page"))?;
                    pages.insert(page);
                }
                pending_images
                    .entry(node_id.clone())
                    .or_default()
                    .push(operation);
            }
            _ => {
                return Err(error(
                    "native PDF candidate accepts text and image operations only",
                ))
            }
        }
    }
    for (id, changes) in splices {
        let node = text
            .get_mut(&id)
            .ok_or_else(|| error("missing pending text node"))?;
        node.text = splice_chars(&node.text, &changes)?;
    }
    // The existing text setter handles source font encodings and fallback fonts.
    // Descending ordinals keep later text addresses stable during deletion.
    let mut text: Vec<_> = text.into_values().collect();
    text.sort_by_key(|entry| {
        std::cmp::Reverse((page_number(&entry.source.part), entry.source.text_ordinal))
    });
    copy_verified_source(source, target, &manifest.source.sha256)?;
    let mut marked_pages = pages.clone();
    marked_pages.extend(text.iter().filter_map(|node| {
        node.source
            .paragraph_id
            .as_deref()
            .and_then(pdf_text_address)
            .map(|(page, _)| page)
    }));
    if !text.is_empty() || !marked_pages.is_empty() {
        let handler =
            pdf_handler::PdfHandler::open(&target.to_string_lossy(), true).map_err(error)?;
        for page in marked_pages {
            handler
                .mark_source_text_groups(page as usize)
                .map_err(error)?;
        }
        for node in text {
            let path = node
                .source
                .paragraph_id
                .ok_or_else(|| error("PDF text node has no source path"))?;
            if !handler
                .set(&path, &HashMap::from([("text".to_string(), node.text)]))
                .map_err(error)?
                .is_empty()
            {
                return Err(error(
                    "PDF text replacement returned unsupported properties",
                ));
            }
        }
        handler.save().map_err(error)?;
    }
    let reader = pdf_handler::reader::PdfReader::open(&target.to_string_lossy()).map_err(error)?;
    let page_ids = reader.document().get_pages();
    let mut dimensions = BTreeMap::new();
    let mut edits: BTreeMap<u32, Vec<ImagePlacementEdit>> = BTreeMap::new();
    let mut found = HashSet::new();
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, index)?.chunks {
            let map = bundle.read_map(&descriptor)?;
            if !map.entries.iter().any(|entry| {
                entry.source.node_kind == "image"
                    && (dirty.contains(&entry.node_id)
                        || pending_images.contains_key(&entry.node_id))
            }) {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let images = extract_html_image_nodes(&html)?;
            for entry in map.entries.into_iter().filter(|entry| {
                entry.source.node_kind == "image"
                    && (dirty.contains(&entry.node_id)
                        || pending_images.contains_key(&entry.node_id))
            }) {
                let (page, index) = entry
                    .source
                    .paragraph_id
                    .as_deref()
                    .and_then(image_address)
                    .ok_or_else(|| error("PDF image has no source placement address"))?;
                let image = images
                    .get(&entry.node_id)
                    .ok_or_else(|| error("PDF image is missing from canonical HTML"))?;
                let mut geometry = image
                    .geometry
                    .clone()
                    .ok_or_else(|| error("PDF image has no geometry"))?;
                let mut asset = image.asset_hash.clone();
                let marker = format!("data-hcd-id=\"{}\"", entry.node_id);
                let at = html
                    .find(&marker)
                    .ok_or_else(|| error("PDF image tag is missing"))?;
                let start = html[..at]
                    .rfind('<')
                    .ok_or_else(|| error("PDF image start tag is missing"))?;
                let end = at
                    + html[at..]
                        .find('>')
                        .ok_or_else(|| error("PDF image start tag is unclosed"))?;
                let mut replaced =
                    html[start..end].contains("data-hcd-image-asset-patched=\"true\"");
                if let Some(changes) = pending_images.get(&entry.node_id) {
                    found.insert(entry.node_id.clone());
                    pages.insert(page);
                    for change in changes {
                        match change {
                            PatchOperation::ImageGeometry {
                                geometry: next,
                                precondition,
                                ..
                            } => {
                                if image.visual_hash != precondition.visual_hash {
                                    return Err(HcdError::PreconditionFailed(
                                        "PDF image changed".into(),
                                    ));
                                }
                                geometry = next.clone();
                            }
                            PatchOperation::ImageReplace {
                                asset_hash,
                                precondition,
                                ..
                            } => {
                                if image.visual_hash != precondition.visual_hash {
                                    return Err(HcdError::PreconditionFailed(
                                        "PDF image changed".into(),
                                    ));
                                }
                                asset = Some(asset_hash.clone());
                                replaced = true;
                            }
                            PatchOperation::ImageRestoreSource { precondition, .. } => {
                                if image.visual_hash != precondition.visual_hash {
                                    return Err(HcdError::PreconditionFailed(
                                        "PDF image changed".into(),
                                    ));
                                }
                                asset = None;
                                replaced = false;
                            }
                            _ => unreachable!(),
                        }
                    }
                }
                if geometry.unit != ImageGeometryUnit::Pt {
                    return Err(error("PDF image geometry must use points"));
                }
                let page_id = *page_ids
                    .get(&page)
                    .ok_or_else(|| error("missing PDF page"))?;
                let viewport = *dimensions
                    .entry(page)
                    .or_insert(Viewport::from_document(reader.document(), page_id)?);
                let mut rectangle = image_source_rectangle(
                    &reader,
                    page,
                    &html,
                    &geometry,
                    &entry.node_id,
                    viewport,
                    allow_legacy_rotated,
                )?;
                if pending_images.get(&entry.node_id).is_some_and(|changes| {
                    changes
                        .iter()
                        .any(|change| matches!(change, PatchOperation::ImageGeometry { .. }))
                }) {
                    rectangle = viewport.to_source([
                        geometry.x,
                        geometry.y,
                        geometry.width,
                        geometry.height,
                    ]);
                }
                edits.entry(page).or_default().push(ImagePlacementEdit {
                    index,
                    rectangle,
                    replacement: if replaced {
                        Some(replacement(
                            bundle,
                            revision,
                            asset
                                .as_deref()
                                .ok_or_else(|| error("replacement image has no asset"))?,
                        )?)
                    } else {
                        None
                    },
                });
            }
        }
    }
    if found.len() != pending_images.len() {
        return Err(error("pending PDF image was not found in the source map"));
    }
    let mut doc = reader.into_document();
    for (page, edits) in edits {
        rewrite_image_placements(&mut doc, page, &edits).map_err(error)?;
    }
    geometry::normalize_rotations(&mut doc)?;
    doc.save(target).map_err(error)?;
    Ok((manifest, pages))
}

pub(super) fn image_source_rectangle(
    reader: &pdf_handler::reader::PdfReader,
    page: u32,
    html: &str,
    image: &hcd_core::ImageGeometry,
    node_id: &str,
    viewport: Viewport,
    allow_legacy_rotated: bool,
) -> Result<[f64; 4], HcdError> {
    if html.contains(&format!(
        "data-hcd-pdf-coordinates=\"{}\"",
        geometry::COORDINATE_SYSTEM
    )) {
        return Ok(viewport.to_source([image.x, image.y, image.width, image.height]));
    }
    if viewport.rotation != 0 && !allow_legacy_rotated {
        return Err(error("this rotated PDF uses legacy editor coordinates; upgrade its layout before image edits"));
    }
    let marker = format!("data-hcd-id=\"{node_id}\"");
    let at = html
        .find(&marker)
        .ok_or_else(|| error("PDF image tag is missing"))?;
    let start = html[..at]
        .rfind('<')
        .ok_or_else(|| error("PDF image start tag is missing"))?;
    let end = at
        + html[at..]
            .find('>')
            .ok_or_else(|| error("PDF image tag is unclosed"))?;
    let tag = &html[start..end];
    // Explicit geometry edits are viewport positions chosen by the user,
    // even when the legacy importer initially seeded the wrong hitbox.
    if tag.contains("data-hcd-image-geometry-patched=\"true\"") {
        return Ok(viewport.to_source([image.x, image.y, image.width, image.height]));
    }
    // Unedited legacy hitboxes must recover the original source rectangle.
    if let Some(value) = tag
        .split("data-hcd-source-bbox=\"")
        .nth(1)
        .and_then(|value| value.split('"').next())
    {
        let values: Vec<f64> = value
            .split(',')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(error)?;
        if values.len() != 4
            || !values.iter().all(|v| v.is_finite())
            || values[2] <= 0.
            || values[3] <= 0.
        {
            return Err(error("PDF source image bbox is invalid"));
        }
        return Ok([values[0], values[1], values[2], values[3]]);
    }
    let (_, _, llx, lly) = pdf_handler::html_preview::page_dimensions(reader, page as usize);
    let (_, height) =
        page_size_pt(html).ok_or_else(|| error("PDF page has no preview dimensions"))?;
    Ok([
        image.x + llx as f64,
        height as f64 - image.y - image.height + lly as f64,
        image.width,
        image.height,
    ])
}

pub(super) fn plan(
    bundle: &Bundle,
    source: &Path,
    operations: &[PatchOperation],
) -> Result<hcd_core::PdfRasterPlan, HcdError> {
    let candidate = tempfile::Builder::new().suffix(".pdf").tempfile()?;
    let (manifest, pages) = write_candidate(
        bundle,
        source,
        candidate.path(),
        &ExportOptions::default(),
        operations,
    )?;
    if std::fs::metadata(candidate.path())?.len() > MAX_HCD_PDF_SOURCE_BYTES {
        return Err(error("candidate PDF exceeds source size limit"));
    }
    let text_layouts =
        super::native_layout::collect(bundle, &manifest, candidate.path(), &pages, operations)?;
    let pdf = Pdf::new(Arc::new(std::fs::read(candidate.path())?))
        .map_err(|e| error(format!("cannot render modified PDF: {e:?}")))?;
    let mut rasters = Vec::new();
    for page in pages {
        let (width, height) = pdf
            .pages()
            .get(page as usize - 1)
            .ok_or_else(|| error("missing candidate page"))?
            .render_dimensions();
        let raster = render_page_raster(
            &pdf,
            page as usize - 1,
            width,
            height,
            PdfRasterMode::Lossless,
            100,
        )
        .map_err(error)?;
        let mut asset = bundle.stage_asset_from_reader("png", &mut Cursor::new(raster.bytes))?;
        asset.source_part = format!("pdf/pages/{page}/source-composited-raster");
        rasters.push(hcd_core::PdfPageRaster {
            page,
            asset,
            source_composited: true,
            font_ids: vec![],
        });
    }
    Ok(hcd_core::PdfRasterPlan {
        rasters,
        skipped: vec![],
        text_layouts,
        base_root_hash: Some(manifest.root_hash),
    })
}
