//! Reproject old PDF HTML in a new revision, preserving canonical content.
use super::*;
use hcd_core::{
    extract_html_image_nodes, ImageGeometry, ImageGeometryUnit, PdfLayoutChunk, PdfLayoutUpgrade,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};
use std::collections::BTreeSet;

fn error(message: impl ToString) -> HcdError {
    HcdError::InvalidBundle(message.to_string())
}

fn page_attribute(html: &str) -> Result<u32, HcdError> {
    let mut reader = Reader::from_str(html);
    loop {
        match reader.read_event().map_err(error)? {
            Event::Start(tag) if tag.name().as_ref() == b"section" => {
                let attrs = attributes(&tag, &reader)?;
                return attrs
                    .get("data-hcd-page")
                    .and_then(|value| value.parse().ok())
                    .ok_or_else(|| error("PDF section has no page number"));
            }
            Event::Eof => return Err(error("PDF chunk has no section")),
            _ => {}
        }
    }
}

fn attributes(
    tag: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
) -> Result<BTreeMap<String, String>, HcdError> {
    tag.attributes()
        .map(|attr| {
            let attr = attr.map_err(error)?;
            Ok((
                String::from_utf8(attr.key.as_ref().to_vec()).map_err(error)?,
                attr.decode_and_unescape_value(reader.decoder())
                    .map_err(error)?
                    .into_owned(),
            ))
        })
        .collect()
}

fn tag_with_attributes(
    name: &[u8],
    attrs: &BTreeMap<String, String>,
) -> Result<BytesStart<'static>, HcdError> {
    let mut tag = BytesStart::new(String::from_utf8(name.to_vec()).map_err(error)?);
    for (key, value) in attrs {
        tag.push_attribute((key.as_str(), value.as_str()));
    }
    Ok(tag.into_owned())
}

fn style(attrs: &mut BTreeMap<String, String>, updates: &[(&str, String)]) {
    let mut properties: BTreeMap<String, String> = attrs
        .get("style")
        .into_iter()
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    properties.extend(
        updates
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone())),
    );
    attrs.insert(
        "style".into(),
        properties
            .into_iter()
            .map(|(key, value)| format!("{key}:{value}"))
            .collect::<Vec<_>>()
            .join(";"),
    );
}

#[derive(Clone)]
struct NodeLayout {
    source: [f64; 4],
    view: [f64; 4],
    image: bool,
}

fn rect_attrs(attrs: &mut BTreeMap<String, String>, rect: [f64; 4]) {
    for (key, value) in [
        "data-hcd-x",
        "data-hcd-y",
        "data-hcd-width",
        "data-hcd-height",
    ]
    .into_iter()
    .zip(rect)
    {
        attrs.insert(key.into(), value.to_string());
    }
    attrs.insert(
        "data-hcd-bbox".into(),
        rect.into_iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(","),
    );
    style(
        attrs,
        &[
            ("left", format!("{}pt", rect[0])),
            ("top", format!("{}pt", rect[1])),
            ("width", format!("{}pt", rect[2])),
            ("height", format!("{}pt", rect[3])),
        ],
    );
}

fn rewrite(
    html: &str,
    nodes: &BTreeMap<String, NodeLayout>,
    viewport: Viewport,
    asset: &AssetDescriptor,
    continuation: bool,
) -> Result<String, HcdError> {
    let images = extract_html_image_nodes(html)?;
    let has_raster = html.contains("class=\"hcd-pdf-page-raster\"");
    let mut reader = Reader::from_str(html);
    let mut writer = Writer::new(Vec::with_capacity(html.len() + 1024));
    loop {
        let event = reader.read_event().map_err(error)?;
        let (tag, empty) = match &event {
            Event::Start(tag) => (tag, false),
            Event::Empty(tag) => (tag, true),
            Event::Eof => break,
            _ => {
                writer.write_event(event).map_err(error)?;
                continue;
            }
        };
        let mut attrs = attributes(tag, &reader)?;
        let is_section = tag.name().as_ref() == b"section" && attrs.contains_key("data-hcd-page");
        if is_section {
            attrs.insert(
                "data-hcd-pdf-coordinates".into(),
                geometry::COORDINATE_SYSTEM.into(),
            );
            attrs.insert(
                "data-hcd-page-rotation".into(),
                viewport.rotation.to_string(),
            );
            attrs.insert("data-hcd-source-raster".into(), "true".into());
            let (width, height) = viewport.dimensions();
            style(
                &mut attrs,
                &[
                    ("width", format!("{width}pt")),
                    ("height", format!("{height}pt")),
                ],
            );
            if continuation {
                style(
                    &mut attrs,
                    &[("margin-top", format!("-{}pt", height + 18.))],
                );
            }
        }
        if attrs
            .get("class")
            .is_some_and(|value| value == "hcd-pdf-page-raster")
        {
            attrs.insert("src".into(), format!("asset://sha256/{}", asset.hash));
            attrs.insert("data-hcd-asset-href".into(), asset.href.clone());
        }
        if let Some(id) = attrs.get("data-hcd-text-node").cloned() {
            let node = nodes
                .get(&id)
                .ok_or_else(|| error("PDF text hitbox has no source anchor"))?;
            rect_attrs(&mut attrs, node.view);
            attrs.insert(
                "data-hcd-source-bbox".into(),
                node.source
                    .into_iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        if let Some(id) = attrs
            .get("data-hcd-id")
            .cloned()
            .filter(|_| attrs.contains_key("data-hcd-node-hash"))
        {
            let node = nodes
                .get(&id)
                .ok_or_else(|| error("PDF canonical node has no source anchor"))?;
            if node.image {
                let current = images
                    .get(&id)
                    .ok_or_else(|| error("PDF image has no visual state"))?;
                let view = if attrs
                    .get("data-hcd-image-geometry-patched")
                    .is_some_and(|value| value == "true")
                {
                    let geometry = current
                        .geometry
                        .as_ref()
                        .ok_or_else(|| error("PDF image has no geometry"))?;
                    [geometry.x, geometry.y, geometry.width, geometry.height]
                } else {
                    node.view
                };
                rect_attrs(&mut attrs, view);
                attrs.insert("data-hcd-geometry-unit".into(), "pt".into());
                attrs.insert("data-hcd-image-composited".into(), "true".into());
                style(&mut attrs, &[("display", "none".into())]);
                let [x, y, width, height] = view;
                attrs.insert(
                    "data-hcd-visual-hash".into(),
                    hcd_core::image_visual_hash(
                        current.asset_hash.as_deref(),
                        Some(&ImageGeometry {
                            x,
                            y,
                            width,
                            height,
                            unit: ImageGeometryUnit::Pt,
                        }),
                    ),
                );
            } else {
                let transform =
                    viewport.text_transform(node.source[2] as f32, node.source[3] as f32);
                let updates: Vec<_> = transform
                    .split(';')
                    .filter_map(|part| part.split_once(':'))
                    .map(|(key, value)| (key, value.to_string()))
                    .collect();
                style(&mut attrs, &updates);
                attrs.insert("data-hcd-patched".into(), "false".into());
            }
        }
        let tag = tag_with_attributes(tag.name().as_ref(), &attrs)?;
        writer
            .write_event(if empty {
                Event::Empty(tag)
            } else {
                Event::Start(tag)
            })
            .map_err(error)?;
        if is_section && !has_raster && !continuation {
            let mut raster = BytesStart::new("img");
            let src = format!("asset://sha256/{}", asset.hash);
            raster.push_attribute(("class", "hcd-pdf-page-raster"));
            raster.push_attribute(("src", src.as_str()));
            raster.push_attribute(("data-hcd-asset-href", asset.href.as_str()));
            raster.push_attribute(("alt", ""));
            writer.write_event(Event::Empty(raster)).map_err(error)?;
        }
    }
    let html = String::from_utf8(writer.into_inner()).map_err(error)?;
    if html.len() > MAX_CHUNK_BYTES {
        return Err(HcdError::ResourceLimit(
            "upgraded PDF chunk exceeds the chunk limit".into(),
        ));
    }
    Ok(html)
}

/// The first chunk suffices for the legacy bundles emitted by earlier imports.
/// The upgrader itself checks every chunk, including continuation fragments.
pub fn pdf_layout_needs_upgrade(bundle: &Bundle) -> Result<bool, HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "pdf" || manifest.chunk_count == 0 {
        return Ok(false);
    }
    let page = bundle.read_index_page(&manifest, 0)?;
    let first = page
        .chunks
        .first()
        .ok_or_else(|| error("missing first PDF chunk"))?;
    Ok(!bundle.read_chunk_verified(first)?.contains(&format!(
        "data-hcd-pdf-coordinates=\"{}\"",
        geometry::COORDINATE_SYSTEM
    )))
}

pub fn upgrade_pdf_layout(
    bundle: &Bundle,
    source: &Path,
    expected_revision: u64,
    actor: BTreeMap<String, String>,
) -> Result<Option<hcd_core::ApplyResult>, HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_revision}, actual {}",
            manifest.revision
        )));
    }
    if manifest.source.format != "pdf" || manifest.profile != "fixed-layout" {
        return Err(HcdError::Unsupported(
            "layout upgrade requires a fixed-layout PDF".into(),
        ));
    }
    let mut pages = BTreeSet::new();
    let mut page_chunks: BTreeMap<u32, Vec<hcd_core::ChunkDescriptor>> = BTreeMap::new();
    for index in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, index)?.chunks {
            let html = bundle.read_chunk_verified(&chunk)?;
            let page_number = page_attribute(&html)?;
            if !html.contains(&format!(
                "data-hcd-pdf-coordinates=\"{}\"",
                geometry::COORDINATE_SYSTEM
            )) {
                pages.insert(page_number);
            }
            page_chunks.entry(page_number).or_default().push(chunk);
        }
    }
    if pages.is_empty() {
        return Ok(None);
    }
    let candidate = tempfile::Builder::new().suffix(".pdf").tempfile()?;
    let rebuilt = native::write_upgrade_candidate(bundle, source, candidate.path())?;
    if rebuilt.revision != manifest.revision || rebuilt.root_hash != manifest.root_hash {
        return Err(HcdError::RevisionConflict(
            "PDF changed during layout planning".into(),
        ));
    }
    let reader = pdf_handler::reader::PdfReader::open(&source.to_string_lossy()).map_err(error)?;
    let candidate_reader =
        pdf_handler::reader::PdfReader::open(&candidate.path().to_string_lossy()).map_err(error)?;
    let rendered_bytes = geometry::raster_bytes(&candidate_reader, candidate.path())?;
    drop(candidate_reader);
    let pdf = Pdf::new(Arc::new(rendered_bytes))
        .map_err(|e| error(format!("cannot render upgraded PDF: {e:?}")))?;
    let page_ids = reader.document().get_pages();
    let mut upgrades = Vec::new();
    let mut assets = Vec::new();
    // One original parsed page, one rendered page and bounded HTML at a time.
    for page in pages {
        let page_id = *page_ids
            .get(&page)
            .ok_or_else(|| error("PDF source page is missing"))?;
        let viewport = Viewport::from_document(reader.document(), page_id)?;
        let parsed = reader
            .parse_page_text_blocks_bounded(
                page as usize,
                MAX_HCD_PDF_PAGE_CONTENT_BYTES,
                MAX_HCD_PDF_AUX_STREAM_BYTES,
            )
            .map_err(pdf_parse_error)?;
        let (width, height) = pdf
            .pages()
            .get(page as usize - 1)
            .ok_or_else(|| error("missing candidate PDF page"))?
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
        for chunk in page_chunks.remove(&page).unwrap_or_default() {
            let html = bundle.read_chunk_verified(&chunk)?;
            let map = bundle.read_map_verified(&chunk)?;
            let images = extract_html_image_nodes(&html)?;
            let mut nodes = BTreeMap::new();
            for entry in map.entries {
                let path = entry
                    .source
                    .paragraph_id
                    .as_deref()
                    .ok_or_else(|| error("PDF node has no source address"))?;
                let image = entry.source.node_kind == "image";
                let source = if image {
                    let (source_page, ordinal) = native::image_address(path)
                        .ok_or_else(|| error("PDF image address is invalid"))?;
                    if source_page != page
                        || !parsed
                            .image_blocks
                            .iter()
                            .any(|image| image.index == ordinal)
                    {
                        return Err(error(
                            "PDF image anchor is missing from the immutable source page",
                        ));
                    }
                    let geometry = images
                        .get(&entry.node_id)
                        .and_then(|image| image.geometry.as_ref())
                        .ok_or_else(|| error("PDF image has no geometry"))?;
                    // Keep explicit viewport edits, but recover unedited
                    // hitboxes from the original source coordinate frame.
                    native::image_source_rectangle(
                        &reader,
                        page,
                        &html,
                        geometry,
                        &entry.node_id,
                        viewport,
                        true,
                    )?
                } else {
                    let (source_page, ordinal) = pdf_text_address(path)
                        .ok_or_else(|| error("PDF text address is invalid"))?;
                    if source_page != page {
                        return Err(error("PDF node belongs to another source page"));
                    }
                    let block = parsed
                        .text_blocks
                        .iter()
                        .find(|block| block.index == ordinal)
                        .ok_or_else(|| {
                            error("PDF text anchor is missing from the immutable source")
                        })?;
                    [
                        block.bbox.x as f64,
                        block.bbox.y as f64,
                        block.bbox.width as f64,
                        block.bbox.height as f64,
                    ]
                };
                nodes.insert(
                    entry.node_id,
                    NodeLayout {
                        source,
                        view: viewport.to_view(source),
                        image,
                    },
                );
            }
            let html = rewrite(&html, &nodes, viewport, &asset, chunk.continuation)?;
            let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
            upgrades.push(PdfLayoutChunk {
                chunk_id: chunk.chunk_id,
                previous_html_hash: chunk.html_hash,
                html_href,
                html_hash,
            });
        }
        assets.push(asset);
    }
    if hcd_core::hash_file(source)? != manifest.source.sha256 {
        return Err(HcdError::SourceMismatch(
            "PDF source changed during layout planning".into(),
        ));
    }
    hcd_core::apply_pdf_layout_upgrade(
        bundle,
        PdfLayoutUpgrade {
            base_revision: manifest.revision,
            root_hash: manifest.root_hash,
            chunks: upgrades,
            assets,
        },
        actor,
    )
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        Annotation, AnnotationSet, PatchBatch, PatchOperation, PdfPageRaster, PdfRasterPlan,
        VisualPrecondition,
    };

    #[test]
    fn legacy_layout_upgrade_preserves_edits_annotations_history_and_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy.pdf");
        crate::pdf::tests::write_simple_visual_pdf(&source);
        let mut doc = lopdf::Document::load(&source).unwrap();
        let page = doc.get_pages()[&1];
        let page = doc.get_dictionary_mut(page).unwrap();
        page.set("CropBox", vec![5.into(), 10.into(), 195.into(), 290.into()]);
        page.set("Rotate", 90);
        doc.save(&source).unwrap();
        let root = temp.path().join("bundle");
        let mut options = ImportOptions::new("legacy-layout");
        options.pdf_raster_mode = PdfRasterMode::Lossless;
        import_pdf(&source, &root, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&root).unwrap();
        let head = bundle.manifest().unwrap();
        let chunk = bundle.read_index_page(&head, 0).unwrap().chunks.remove(0);
        let original = bundle.read_chunk(&chunk).unwrap();
        let raster_href = raster_asset_href(&original).unwrap();
        let raster = bundle
            .read_asset_index_for_revision(0)
            .unwrap()
            .into_iter()
            .find(|asset| asset.href == raster_href)
            .unwrap();
        let image = hcd_core::extract_image_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0)
            .node;
        let text = hcd_core::extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .remove(0);
        // Reproduce the old importer: rotated canvas dimensions, but unrotated
        // image rectangles and source-space text attributes. This is a fixture
        // snapshot, not an alternate production upgrade path.
        let old_geometry = ImageGeometry {
            x: 5.,
            y: 149.876544,
            width: 40.,
            height: 30.,
            unit: ImageGeometryUnit::Pt,
        };
        let old_hash = hcd_core::image_visual_hash(None, Some(&old_geometry));
        let source_reader =
            pdf_handler::reader::PdfReader::open(&source.to_string_lossy()).unwrap();
        let source_page = source_reader.document().get_pages()[&1];
        let viewport = Viewport::from_document(source_reader.document(), source_page).unwrap();
        let unedited = format!(
            "<div data-hcd-id=\"{}\" data-hcd-source-bbox=\"10,20.123456,40,30\"></div>",
            image.node_id
        );
        assert_eq!(
            native::image_source_rectangle(
                &source_reader,
                1,
                &unedited,
                &old_geometry,
                &image.node_id,
                viewport,
                true
            )
            .unwrap(),
            [10., 20.123456, 40., 30.]
        );
        let explicit = format!(
            "<div data-hcd-id=\"{}\" data-hcd-image-geometry-patched=\"true\"></div>",
            image.node_id
        );
        assert_eq!(
            native::image_source_rectangle(
                &source_reader,
                1,
                &explicit,
                &ImageGeometry {
                    x: 65.,
                    y: 80.,
                    width: 30.,
                    height: 20.,
                    unit: ImageGeometryUnit::Pt
                },
                &image.node_id,
                viewport,
                true
            )
            .unwrap(),
            [85., 75., 20., 30.]
        );

        let legacy = format!("<section class=\"hcd-pdf-page\" data-hcd-page=\"1\" data-hcd-source-raster=\"true\" style=\"position:relative;width:280pt;height:190pt\"><img class=\"hcd-pdf-page-raster\" src=\"asset://sha256/{}\" data-hcd-asset-href=\"{}\" alt=\"\"/><div class=\"hcd-pdf-image\" data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\" data-hcd-visual-hash=\"{old_hash}\" data-hcd-editable=\"true\" data-hcd-x=\"5\" data-hcd-y=\"149.876544\" data-hcd-width=\"40\" data-hcd-height=\"30\" data-hcd-geometry-unit=\"pt\" style=\"position:absolute;left:5pt;top:149.876544pt;width:40pt;height:30pt\"></div><p class=\"hcd-pdf-text\" data-hcd-text-node=\"{}\" style=\"position:absolute;left:15pt;top:-62pt;width:60pt;height:12pt;font-size:12pt\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span></p></section>",raster.hash,raster.href,image.node_id,hash_bytes(b""),text.node_id,text.node_id,text.node_hash,escape_text(&text.text));
        let (href, hash) = bundle.write_chunk_object(&legacy).unwrap();
        hcd_core::apply_pdf_layout_upgrade(
            &bundle,
            PdfLayoutUpgrade {
                base_revision: 0,
                root_hash: head.root_hash,
                chunks: vec![PdfLayoutChunk {
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
        assert!(pdf_layout_needs_upgrade(&bundle).unwrap());
        let mut patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "legacy-layout".into(),
            patch_id: "legacy-saved-text".into(),
            base_revision: 1,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![PatchOperation::TextSplice {
                node_id: text.node_id.clone(),
                start: 0,
                delete_count: text.text.chars().count(),
                insert_text: "Saved legacy 中文".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: text.node_hash,
                },
            }],
        };
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        // Reproduce the legacy image-save bug: geometry/resource saved while
        // the page raster still contains the original picture.
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0, 255, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let replacement = bundle
            .stage_asset_from_reader("png", &mut Cursor::new(png))
            .unwrap();
        patch.schema_version = hcd_core::HCD_PATCH_SCHEMA_VERSION_3.into();
        patch.patch_id = "legacy-saved-image".into();
        patch.base_revision = 2;
        patch.operations = vec![
            PatchOperation::ImageGeometry {
                node_id: image.node_id.clone(),
                geometry: ImageGeometry {
                    x: 65.,
                    y: 80.,
                    width: 30.,
                    height: 20.,
                    unit: ImageGeometryUnit::Pt,
                },
                precondition: VisualPrecondition {
                    visual_hash: old_hash.clone(),
                },
            },
            PatchOperation::ImageReplace {
                node_id: image.node_id.clone(),
                asset_hash: replacement.hash.clone(),
                precondition: VisualPrecondition {
                    visual_hash: old_hash,
                },
            },
        ];
        hcd_core::apply_patch_with_pdf_rasters(
            &bundle,
            &patch,
            2,
            PdfRasterPlan {
                rasters: vec![PdfPageRaster {
                    page: 1,
                    asset: raster,
                    source_composited: true,
                    font_ids: vec![],
                }],
                skipped: vec![],
            },
        )
        .unwrap();
        patch.schema_version = hcd_core::HCD_PATCH_SCHEMA_VERSION.into();
        patch.patch_id = "legacy-annotation".into();
        patch.base_revision = 3;
        patch.operations = vec![PatchOperation::AnnotationUpsert {
            annotation: Annotation {
                annotation_id: "preserved-note".into(),
                node_id: text.node_id.clone(),
                start: 0,
                end: 5,
                kind: "review".into(),
                rule_id: None,
                confidence: None,
                ignored: false,
            },
        }];
        hcd_core::apply_patch(&bundle, &patch, 3).unwrap();
        let before = bundle.manifest().unwrap();
        let annotations = before.annotation_root_hash.clone();
        let records: Vec<_> = (0..=4)
            .map(|revision| serde_json::to_vec(&bundle.revision(revision).unwrap()).unwrap())
            .collect();
        let map = bundle
            .read_map(&bundle.read_index_page(&before, 0).unwrap().chunks[0])
            .unwrap();
        let upgraded = upgrade_pdf_layout(
            &bundle,
            &source,
            4,
            BTreeMap::from([("userId".into(), "designer".into())]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(upgraded.revision, 5);
        assert!(!pdf_layout_needs_upgrade(&bundle).unwrap());
        assert_eq!(bundle.manifest().unwrap().annotation_root_hash, annotations);
        assert_eq!(
            hcd_core::get_text_node(&bundle, &text.node_id)
                .unwrap()
                .node
                .text,
            "Saved legacy 中文"
        );
        let upgraded_image = hcd_core::get_image_node(&bundle, &image.node_id)
            .unwrap()
            .node;
        assert_eq!(
            upgraded_image.asset_hash.as_deref(),
            Some(replacement.hash.as_str())
        );
        assert_eq!(
            upgraded_image.geometry.unwrap(),
            ImageGeometry {
                x: 65.,
                y: 80.,
                width: 30.,
                height: 20.,
                unit: ImageGeometryUnit::Pt
            }
        );
        let after = bundle.manifest().unwrap();
        let after_chunk = bundle.read_index_page(&after, 0).unwrap().chunks.remove(0);
        assert_eq!(
            serde_json::to_value(&map).unwrap(),
            serde_json::to_value(bundle.read_map(&after_chunk).unwrap()).unwrap()
        );
        let html = bundle.read_chunk(&after_chunk).unwrap();
        assert!(html.contains("rotate(90deg)") && !html.contains("data-hcd-patched=\"true\""));
        for (revision, old) in records.into_iter().enumerate() {
            assert_eq!(
                serde_json::to_vec(&bundle.revision(revision as u64).unwrap()).unwrap(),
                old
            );
        }
        let historical = hcd_core::manifest_at_revision(&bundle, &after, Some(4))
            .unwrap()
            .0;
        assert!(bundle
            .read_chunk(&bundle.read_index_page(&historical, 0).unwrap().chunks[0])
            .unwrap()
            .contains("top:-62pt"));
        assert!(upgrade_pdf_layout(&bundle, &source, 5, Default::default())
            .unwrap()
            .is_none());
        assert!(upgrade_pdf_layout(&bundle, &source, 4, Default::default()).is_err());
        let output = temp.path().join("upgraded.pdf");
        export_pdf(&bundle, &source, &output, &ExportOptions::default()).unwrap();
        assert_eq!(
            crate::pdf::tests::rendered_source(&output),
            crate::pdf::tests::current_raster(&bundle)
        );
        let historical_output = temp.path().join("legacy-revision-four.pdf");
        export_pdf(
            &bundle,
            &source,
            &historical_output,
            &ExportOptions {
                revision: Some(4),
                fidelity_report: None,
            },
        )
        .unwrap();
        assert_eq!(
            crate::pdf::tests::rendered_source(&historical_output),
            crate::pdf::tests::current_raster(&bundle)
        );
        let validation = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        // The old recognition annotation is still addressable after upgrading.
        let path = bundle
            .resolve_href(after.annotation_href.as_ref().unwrap())
            .unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut bytes = Vec::new();
        use std::io::Read;
        if path.extension().is_some_and(|extension| extension == "gz") {
            flate2::read::GzDecoder::new(file)
                .read_to_end(&mut bytes)
                .unwrap();
        } else {
            std::io::BufReader::new(file)
                .read_to_end(&mut bytes)
                .unwrap();
        }
        let set: AnnotationSet = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(set.annotations[0].annotation_id, "preserved-note");
        // A renderer plan cannot smuggle content changes or win a stale CAS.
        let bad_html = html.replace("Saved legacy 中文", "tampered content");
        let (href, hash) = bundle.write_chunk_object(&bad_html).unwrap();
        let bad = PdfLayoutUpgrade {
            base_revision: 5,
            root_hash: after.root_hash.clone(),
            chunks: vec![PdfLayoutChunk {
                chunk_id: after_chunk.chunk_id.clone(),
                previous_html_hash: after_chunk.html_hash.clone(),
                html_href: href,
                html_hash: hash,
            }],
            assets: vec![],
        };
        assert!(hcd_core::apply_pdf_layout_upgrade(&bundle, bad, Default::default()).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 5);
        let mut moved = ImageGeometry {
            x: 65.,
            y: 80.,
            width: 30.,
            height: 20.,
            unit: ImageGeometryUnit::Pt,
        };
        let old_visual = hcd_core::image_visual_hash(Some(&replacement.hash), Some(&moved));
        moved.x = 66.;
        let new_visual = hcd_core::image_visual_hash(Some(&replacement.hash), Some(&moved));
        let moved_html = html
            .replace("data-hcd-x=\"65\"", "data-hcd-x=\"66\"")
            .replace(&old_visual, &new_visual)
            .replace("left:65pt", "left:66pt");
        let (href, hash) = bundle.write_chunk_object(&moved_html).unwrap();
        let bad = PdfLayoutUpgrade {
            base_revision: 5,
            root_hash: after.root_hash.clone(),
            chunks: vec![PdfLayoutChunk {
                chunk_id: after_chunk.chunk_id.clone(),
                previous_html_hash: after_chunk.html_hash.clone(),
                html_href: href,
                html_hash: hash,
            }],
            assets: vec![],
        };
        let error =
            hcd_core::apply_pdf_layout_upgrade(&bundle, bad, Default::default()).unwrap_err();
        assert!(
            error.to_string().contains("saved picture position"),
            "{error}"
        );
        assert_eq!(bundle.manifest().unwrap().revision, 5);
        let stale = PdfLayoutUpgrade {
            base_revision: 5,
            root_hash: after.root_hash,
            chunks: vec![PdfLayoutChunk {
                chunk_id: after_chunk.chunk_id,
                previous_html_hash: after_chunk.html_hash.clone(),
                html_href: after_chunk.html_href,
                html_hash: after_chunk.html_hash,
            }],
            assets: vec![],
        };
        patch.patch_id = "concurrent-annotation".into();
        patch.base_revision = 5;
        hcd_core::apply_patch(&bundle, &patch, 5).unwrap();
        assert!(matches!(
            hcd_core::apply_pdf_layout_upgrade(&bundle, stale, Default::default()),
            Err(HcdError::RevisionConflict(_))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 6);
        // The offline verifier also rejects a forged layout flag on a real
        // text edit or image replacement, independently of commit-time checks.
        for revision in [2, 3] {
            let file = bundle
                .root()
                .join("revisions")
                .join(format!("{revision:020}.json"));
            let bytes = std::fs::read(&file).unwrap();
            let mut forged = bundle.revision(revision).unwrap();
            forged.layout_upgrade = true;
            forged.dirty_node_ids.clear();
            forged.dirty_source_parts.clear();
            std::fs::write(&file, serde_json::to_vec(&forged).unwrap()).unwrap();
            let result = hcd_core::validate_bundle(&bundle).unwrap();
            assert!(
                !result.valid
                    && result
                        .issues
                        .iter()
                        .any(|issue| issue.code == "REVISION_LAYOUT_CONTENT_CHANGED"),
                "{:?}",
                result.issues
            );
            std::fs::write(file, bytes).unwrap();
        }
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
    }
}
