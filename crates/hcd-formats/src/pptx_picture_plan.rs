//! Revision-bound candidate slide rewrites for source-backed PPTX pictures.
//! This is not an export; callers must still handle text edits and publication.
use crate::common::{dirty_state_through, manifest_at_revision};
use crate::{
    rewrite_checked_source_picture_geometry, rewrite_checked_source_picture_with_relationship,
    verify_source_picture_asset, SourcePictureGeometry,
};
use hcd_core::{
    extract_html_image_nodes, hash_file, Bundle, HcdError, HcdManifest, HtmlImageNode,
    ImageGeometryUnit, SourceAnchor,
};
use oxml::StreamingOxmlArchive;
use quick_xml::{
    events::{BytesStart, Event},
    Reader, Writer,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

#[derive(Default)]
pub struct PptxPicturePlan {
    pub parts: BTreeMap<String, Vec<u8>>,
    pub assets: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone)]
struct Snapshot {
    anchor: SourceAnchor,
    image: HtmlImageNode,
    picture_id: String,
    relationship_id: String,
}

/// Prepare candidate XML and media for image edits at an immutable revision.
/// The returned parts have not been published or combined with text edits.
pub fn prepare_pptx_source_picture_geometry(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
) -> Result<PptxPicturePlan, HcdError> {
    let head = bundle.manifest()?;
    if head.source.format != "pptx" {
        return Err(HcdError::Unsupported("source is not PPTX".into()));
    }
    if hash_file(source)? != head.source.sha256 {
        return Err(HcdError::SourceMismatch("PPTX source hash changed".into()));
    }
    let current = manifest_at_revision(bundle, &head, revision)?;
    let (parts, dirty) = dirty_state_through(bundle, revision)?;
    let edited = snapshots(bundle, &current, Some(&dirty))?;
    if edited.is_empty() {
        return Ok(PptxPicturePlan::default());
    }
    let baseline = manifest_at_revision(bundle, &head, 0)?;
    let ids: HashSet<String> = edited.keys().cloned().collect();
    if ids.len() > 1024 {
        return Err(HcdError::ResourceLimit(
            "too many edited PPTX pictures".into(),
        ));
    }
    let original = snapshots(bundle, &baseline, Some(&ids))?;
    let mut archive =
        StreamingOxmlArchive::open(source).map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
    let mut output = BTreeMap::new();
    let mut additions = BTreeMap::new();
    let asset_index = bundle.read_asset_index_for_revision(revision)?;
    let mut types = Vec::new();
    let mut bytes_total = 0usize;
    let mut asset_bytes_total = 0u64;
    for (node_id, edited) in edited {
        if !node_id.strip_prefix("n_").is_some_and(|s| {
            s.len() == 32
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(HcdError::InvalidBundle("invalid picture node ID".into()));
        }
        let original = original
            .get(&node_id)
            .ok_or_else(|| HcdError::SourceMismatch("original picture mapping missing".into()))?;
        if edited.anchor != original.anchor
            || edited.picture_id != original.picture_id
            || edited.relationship_id != original.relationship_id
            || !parts.contains(&edited.anchor.part)
        {
            return Err(HcdError::SourceMismatch(
                "picture source mapping changed".into(),
            ));
        }
        let hash = original
            .image
            .asset_hash
            .as_deref()
            .ok_or_else(|| HcdError::Unsupported("original picture asset missing".into()))?;
        let asset = original
            .anchor
            .text_id
            .as_deref()
            .ok_or_else(|| HcdError::Unsupported("picture source asset path missing".into()))?;
        verify_source_picture_asset(
            source,
            &original.anchor.part,
            &original.relationship_id,
            asset,
            hash,
        )?;
        let before = coordinates(original.image.geometry.as_ref())?;
        let after = coordinates(edited.image.geometry.as_ref())?;
        let xml = if let Some(xml) = output.remove(&original.anchor.part) {
            xml
        } else {
            let xml = archive
                .read_control_part(&original.anchor.part, 32 * 1024 * 1024)
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
            bytes_total = bytes_total
                .checked_add(xml.len())
                .ok_or_else(|| HcdError::ResourceLimit("PPTX slide size overflow".into()))?;
            if bytes_total > 128 * 1024 * 1024 {
                return Err(HcdError::ResourceLimit(
                    "edited PPTX slides exceed limit".into(),
                ));
            }
            xml
        };
        let rewritten = if edited.image.asset_hash.as_deref() != Some(hash) {
            let new_hash =
                edited.image.asset_hash.as_deref().ok_or_else(|| {
                    HcdError::Unsupported("replacement picture asset missing".into())
                })?;
            let descriptor = asset_index
                .iter()
                .find(|item| item.hash == new_hash)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("replacement absent from revision asset index".into())
                })?;
            if descriptor.byte_length == 0
                || descriptor.byte_length > hcd_core::MAX_STAGED_ASSET_BYTES
            {
                return Err(HcdError::ResourceLimit(
                    "replacement image size is invalid".into(),
                ));
            }
            let path = bundle.resolve_href(&descriptor.href)?;
            if std::fs::metadata(&path)?.len() != descriptor.byte_length
                || hash_file(&path)? != new_hash
            {
                return Err(HcdError::InvalidBundle(
                    "replacement image payload does not match revision".into(),
                ));
            }
            asset_bytes_total = asset_bytes_total.saturating_add(descriptor.byte_length);
            if asset_bytes_total > 128 * 1024 * 1024 {
                return Err(HcdError::ResourceLimit(
                    "replacement pictures exceed export limit".into(),
                ));
            }
            let mut data = Vec::with_capacity(descriptor.byte_length as usize);
            std::io::Read::read_to_end(
                &mut std::io::Read::take(
                    std::fs::File::open(path)?,
                    hcd_core::MAX_STAGED_ASSET_BYTES + 1,
                ),
                &mut data,
            )?;
            if data.len() as u64 != descriptor.byte_length
                || hcd_core::hash_bytes(&data) != new_hash
            {
                return Err(HcdError::InvalidBundle(
                    "replacement picture changed while reading".into(),
                ));
            }
            let (ext, content_type) = match image::guess_format(&data) {
                Ok(image::ImageFormat::Png) => ("png", "image/png"),
                Ok(image::ImageFormat::Jpeg) => ("jpg", "image/jpeg"),
                Ok(image::ImageFormat::Gif) => ("gif", "image/gif"),
                _ => {
                    return Err(HcdError::Unsupported(
                        "replacement image type is not supported for source PPTX".into(),
                    ))
                }
            };
            let dimensions = image::ImageReader::new(std::io::Cursor::new(&data))
                .with_guessed_format()
                .map_err(|e| HcdError::InvalidBundle(format!("replacement image: {e}")))?
                .into_dimensions()
                .map_err(|e| HcdError::InvalidBundle(format!("replacement image: {e}")))?;
            if dimensions.0 == 0
                || dimensions.1 == 0
                || dimensions.0 > 16384
                || dimensions.1 > 16384
                || u64::from(dimensions.0) * u64::from(dimensions.1) > 64_000_000
            {
                return Err(HcdError::ResourceLimit(
                    "replacement image dimensions exceed export limit".into(),
                ));
            }
            let mut decoder = image::ImageReader::new(std::io::Cursor::new(&data))
                .with_guessed_format()
                .map_err(|e| HcdError::InvalidBundle(format!("replacement image: {e}")))?;
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(16384);
            limits.max_image_height = Some(16384);
            limits.max_alloc = Some(512 * 1024 * 1024);
            decoder.limits(limits);
            decoder
                .decode()
                .map_err(|e| HcdError::InvalidBundle(format!("invalid replacement image: {e}")))?;
            let media = format!("ppt/media/hcd-{node_id}-{new_hash}.{ext}");
            if archive
                .entries()
                .iter()
                .any(|entry| entry.name.eq_ignore_ascii_case(&media))
                || additions.contains_key(&media)
            {
                return Err(HcdError::Unsupported(
                    "replacement media path already exists".into(),
                ));
            }
            additions.insert(media.clone(), data);
            types.push((format!("/{media}"), content_type.to_string()));
            let rel_id = format!("hcd_{node_id}");
            let rel_part = relationship_part(&original.anchor.part)?;
            let rels = if let Some(xml) = output.remove(&rel_part) {
                xml
            } else {
                archive
                    .read_control_part(&rel_part, 16 * 1024 * 1024)
                    .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
            };
            let rels = append_relationship(&rels, &rel_id, &format!("/{media}"))?;
            output.insert(rel_part, rels);
            rewrite_checked_source_picture_with_relationship(
                xml.as_slice(),
                &original.picture_id,
                &original.relationship_id,
                &rel_id,
                before,
                after,
            )?
        } else {
            rewrite_checked_source_picture_geometry(
                xml.as_slice(),
                &original.picture_id,
                &original.relationship_id,
                before,
                after,
            )?
        };
        output.insert(original.anchor.part.clone(), rewritten);
    }
    if !types.is_empty() {
        let content_types = archive
            .read_control_part("[Content_Types].xml", 16 * 1024 * 1024)
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        output.insert(
            "[Content_Types].xml".into(),
            append_content_types(&content_types, &types)?,
        );
    }
    Ok(PptxPicturePlan {
        parts: output,
        assets: additions,
    })
}

fn relationship_part(slide: &str) -> Result<String, HcdError> {
    let path = Path::new(slide);
    let file = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| HcdError::InvalidBundle("invalid slide part".into()))?;
    Ok(path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("_rels")
        .join(format!("{file}.rels"))
        .to_string_lossy()
        .replace('\\', "/"))
}

fn append_relationship(xml: &[u8], id: &str, target: &str) -> Result<Vec<u8>, HcdError> {
    let mut element = BytesStart::new("Relationship");
    element.push_attribute(("Id", id));
    element.push_attribute((
        "Type",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    ));
    element.push_attribute(("Target", target));
    append_entries(
        xml,
        "Relationships",
        "http://schemas.openxmlformats.org/package/2006/relationships",
        "Relationship",
        "Id",
        vec![(id.to_owned(), element.into_owned())],
    )
}

fn append_content_types(xml: &[u8], entries: &[(String, String)]) -> Result<Vec<u8>, HcdError> {
    let mut extra = Vec::new();
    for (part, kind) in entries {
        let mut element = BytesStart::new("Override");
        element.push_attribute(("PartName", part.as_str()));
        element.push_attribute(("ContentType", kind.as_str()));
        extra.push((part.clone(), element.into_owned()));
    }
    append_entries(
        xml,
        "Types",
        "http://schemas.openxmlformats.org/package/2006/content-types",
        "Override",
        "PartName",
        extra,
    )
}

fn append_entries(
    xml: &[u8],
    root: &str,
    namespace: &str,
    unique_child: &str,
    unique_attr: &str,
    entries: Vec<(String, BytesStart<'static>)>,
) -> Result<Vec<u8>, HcdError> {
    let mut requested = HashSet::new();
    for (key, _) in &entries {
        if !requested.insert(key.to_ascii_lowercase()) {
            return Err(HcdError::InvalidBundle(
                "duplicate added package relationship or part".into(),
            ));
        }
    }
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut count = 0usize;
    loop {
        count += 1;
        if count > 1_000_000 {
            return Err(HcdError::ResourceLimit(
                "package XML event limit exceeded".into(),
            ));
        }
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(format!("package XML: {e}")))?;
        match &event {
            Event::Start(node) if depth == 0 => {
                roots += 1;
                if roots != 1
                    || node.name().as_ref() != root.as_bytes()
                    || xml_attribute(node, b"xmlns")?.as_deref() != Some(namespace)
                {
                    return Err(HcdError::Unsupported(
                        "unsupported package XML namespace".into(),
                    ));
                }
                depth = 1;
            }
            Event::Empty(node) if depth == 1 => {
                if xml_attribute(node, b"xmlns")?.is_some() {
                    return Err(HcdError::Unsupported(
                        "package XML namespace rebinding".into(),
                    ));
                }
                let name = node.name();
                if name.as_ref() != unique_child.as_bytes()
                    && !(root == "Types" && name.as_ref() == b"Default")
                {
                    return Err(HcdError::Unsupported(
                        "unsupported package XML child".into(),
                    ));
                }
                if name.as_ref() == unique_child.as_bytes() {
                    let value = xml_attribute(node, unique_attr.as_bytes())?.ok_or_else(|| {
                        HcdError::InvalidBundle("package XML identity missing".into())
                    })?;
                    if requested.contains(&value.to_ascii_lowercase()) {
                        return Err(HcdError::Unsupported(
                            "package relationship or part already exists".into(),
                        ));
                    }
                }
            }
            Event::End(node) if depth == 1 && node.name().as_ref() == root.as_bytes() => {
                for (_, element) in &entries {
                    writer.write_event(Event::Empty(element.to_owned()))?;
                }
                depth = 0;
            }
            Event::Start(_) | Event::Empty(_) | Event::End(_) => {
                return Err(HcdError::Unsupported(
                    "unsupported package XML structure".into(),
                ))
            }
            Event::DocType(_) => return Err(HcdError::Unsupported("package XML DTD".into())),
            Event::Eof => {
                if depth != 0 || roots != 1 {
                    return Err(HcdError::InvalidBundle("incomplete package XML".into()));
                }
                break;
            }
            _ => {}
        }
        writer.write_event(event)?;
        buffer.clear();
    }
    Ok(writer.into_inner())
}

fn xml_attribute(node: &BytesStart<'_>, key: &[u8]) -> Result<Option<String>, HcdError> {
    let mut found = None;
    for attr in node.attributes().with_checks(true) {
        let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        if attr.key.as_ref() == key {
            found = Some(
                attr.unescape_value()
                    .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                    .into_owned(),
            );
        }
    }
    Ok(found)
}

fn coordinates(value: Option<&hcd_core::ImageGeometry>) -> Result<SourcePictureGeometry, HcdError> {
    let value = value.ok_or_else(|| HcdError::Unsupported("picture geometry missing".into()))?;
    if value.unit != ImageGeometryUnit::Emu {
        return Err(HcdError::Unsupported(
            "PPTX picture geometry must use EMU".into(),
        ));
    }
    let integer = |n: f64| -> Result<i64, HcdError> {
        if !n.is_finite() || n.abs() > 9_007_199_254_740_991.0 {
            return Err(HcdError::InvalidPatch(
                "PPTX picture coordinate out of range".into(),
            ));
        }
        Ok(n.round() as i64)
    };
    Ok(SourcePictureGeometry {
        x: integer(value.x)?,
        y: integer(value.y)?,
        width: integer(value.width)?,
        height: integer(value.height)?,
    })
}

fn snapshots(
    bundle: &Bundle,
    manifest: &HcdManifest,
    selected: Option<&HashSet<String>>,
) -> Result<HashMap<String, Snapshot>, HcdError> {
    let mut result = HashMap::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            let map = bundle.read_map(&descriptor)?;
            if !map.entries.iter().any(|e| {
                e.source.node_kind == "image" && selected.is_none_or(|ids| ids.contains(&e.node_id))
            }) {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let images = extract_html_image_nodes(&html)?;
            let metadata = image_metadata(&html)?;
            for entry in map.entries.into_iter().filter(|e| {
                e.source.node_kind == "image" && selected.is_none_or(|ids| ids.contains(&e.node_id))
            }) {
                let image = images
                    .get(&entry.node_id)
                    .ok_or_else(|| HcdError::InvalidBundle("mapped picture missing".into()))?
                    .clone();
                let (picture_id, relationship_id) =
                    metadata.get(&entry.node_id).cloned().ok_or_else(|| {
                        HcdError::Unsupported("picture source metadata missing".into())
                    })?;
                let expected_path = format!("/picture[@id={picture_id}]");
                if entry.source.paragraph_id.as_deref() != Some(expected_path.as_str()) {
                    return Err(HcdError::SourceMismatch(
                        "picture source path mismatch".into(),
                    ));
                }
                if result
                    .insert(
                        entry.node_id,
                        Snapshot {
                            anchor: entry.source,
                            image,
                            picture_id,
                            relationship_id,
                        },
                    )
                    .is_some()
                {
                    return Err(HcdError::InvalidBundle("duplicate picture mapping".into()));
                }
            }
        }
    }
    Ok(result)
}

fn image_metadata(html: &str) -> Result<HashMap<String, (String, String)>, HcdError> {
    let mut result = HashMap::new();
    let mut reader = Reader::from_str(html);
    let mut buf = Vec::new();
    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
        {
            Event::Start(node) | Event::Empty(node) => {
                let mut id = None;
                let mut picture = None;
                let mut relation = None;
                for attr in node.attributes().with_checks(true) {
                    let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                    let value = || {
                        attr.decode_and_unescape_value(reader.decoder())
                            .map(|v| v.into_owned())
                            .map_err(|e| HcdError::InvalidBundle(e.to_string()))
                    };
                    match attr.key.as_ref() {
                        b"data-hcd-id" => id = Some(value()?),
                        b"data-hcd-picture-id" => picture = Some(value()?),
                        b"data-hcd-image-relationship" => relation = Some(value()?),
                        _ => {}
                    }
                }
                if let (Some(id), Some(picture), Some(relation)) = (id, picture, relation) {
                    if result.insert(id, (picture, relation)).is_some() {
                        return Err(HcdError::InvalidBundle("duplicate picture metadata".into()));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(result)
}
