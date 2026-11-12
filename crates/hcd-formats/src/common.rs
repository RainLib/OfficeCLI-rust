use hcd_core::{
    extract_html_text_nodes, hash_bytes, hash_file, node_bloom_might_contain, Bundle,
    FidelityReport, HcdError, HcdManifest, ImportEvent, SourceDescriptor, TextExtractEntry,
    DEFAULT_CHUNK_BLOCKS, DEFAULT_CHUNK_SOFT_BYTES, HCD_SCHEMA_VERSION, MAX_REVISION,
};
use oxml::{PackageError, StreamingOxmlArchive};
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Bytes a package control part — content types, relationships, the workbook or
/// presentation list — may carry when an export reads it to grow it.
pub(crate) const MAX_CONTROL_BYTES: u64 = 16 * 1024 * 1024;

const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_ELEMENTS: usize = 3_000_000;
const MAX_XML_DEPTH: usize = 256;

#[derive(Default)]
pub(crate) struct XmlBudget {
    elements: usize,
    depth: usize,
}

impl XmlBudget {
    pub(crate) fn observe(&mut self, event: &Event<'_>, part: &str) -> Result<(), HcdError> {
        match event {
            Event::Start(_) => {
                self.elements = self.elements.saturating_add(1);
                self.depth = self.depth.saturating_add(1);
                self.check(part)?;
            }
            Event::Empty(_) => {
                self.elements = self.elements.saturating_add(1);
                self.check(part)?;
            }
            Event::End(_) => {
                self.depth = self.depth.checked_sub(1).ok_or_else(|| {
                    HcdError::InvalidBundle(format!("unbalanced XML depth in {part}"))
                })?;
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn finish(self, part: &str) -> Result<(), HcdError> {
        if self.depth != 0 {
            return Err(HcdError::InvalidBundle(format!(
                "unbalanced XML depth in {part}"
            )));
        }
        Ok(())
    }

    fn check(&self, part: &str) -> Result<(), HcdError> {
        if self.elements > MAX_XML_ELEMENTS {
            return Err(HcdError::ResourceLimit(format!(
                "{part} exceeds {MAX_XML_ELEMENTS} XML elements"
            )));
        }
        if self.depth > MAX_XML_DEPTH {
            return Err(HcdError::ResourceLimit(format!(
                "{part} exceeds the maximum XML depth {MAX_XML_DEPTH}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ImportOptions {
    pub document_id: String,
    pub chunk_soft_bytes: usize,
    pub chunk_blocks: usize,
    pub storage_codec: hcd_core::StorageCodec,
    pub pdf_raster_mode: PdfRasterMode,
    pub pdf_raster_quality: u8,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PdfRasterMode {
    #[default]
    Auto,
    Lossless,
    Lossy,
}

impl ImportOptions {
    pub fn new(document_id: impl Into<String>) -> Self {
        Self {
            document_id: document_id.into(),
            chunk_soft_bytes: DEFAULT_CHUNK_SOFT_BYTES,
            chunk_blocks: DEFAULT_CHUNK_BLOCKS,
            storage_codec: hcd_core::StorageCodec::Gzip,
            pdf_raster_mode: PdfRasterMode::Auto,
            pdf_raster_quality: 92,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    pub revision: Option<u64>,
    pub fidelity_report: Option<PathBuf>,
}

pub(crate) fn source_identity(
    source: &Path,
    expected_format: &str,
) -> Result<(String, u64), HcdError> {
    source_identity_with_extensions(source, &[expected_format])
}

pub(crate) fn source_identity_with_extensions(
    source: &Path,
    expected_extensions: &[&str],
) -> Result<(String, u64), HcdError> {
    let metadata = std::fs::metadata(source)?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "source {} is {} bytes; maximum is {MAX_SOURCE_BYTES}",
            source.display(),
            metadata.len()
        )));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !expected_extensions.contains(&extension.as_str()) {
        return Err(HcdError::Unsupported(format!(
            "expected {}, found .{extension}",
            expected_extensions
                .iter()
                .map(|value| format!(".{value}"))
                .collect::<Vec<_>>()
                .join(" or ")
        )));
    }
    Ok((hash_file(source)?, metadata.len()))
}

pub(crate) fn base_manifest(
    options: &ImportOptions,
    format: &str,
    profile: &str,
    source_hash: String,
    source_size: u64,
) -> HcdManifest {
    HcdManifest {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        storage_codec: options.storage_codec,
        document_id: options.document_id.clone(),
        profile: profile.to_string(),
        revision: 0,
        source: SourceDescriptor {
            format: format.to_string(),
            sha256: source_hash,
            size_bytes: source_size,
        },
        root_hash: String::new(),
        annotation_root_hash: String::new(),
        annotation_href: None,
        index_prefix: String::new(),
        index_root_href: None,
        index_page_count: 0,
        chunk_count: 0,
        styles_href: "styles.css".to_string(),
        capabilities: hcd_core::HcdCapabilities::default(),
        fidelity: None,
        state: "IMPORTING".to_string(),
        warnings: Vec::new(),
    }
}

pub(crate) fn emit_started<F>(
    emit: &mut F,
    options: &ImportOptions,
    source_hash: &str,
) -> Result<(), HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    if options.document_id.trim().is_empty() || options.document_id.len() > 256 {
        return Err(HcdError::InvalidBundle(
            "documentId must contain between 1 and 256 bytes".to_string(),
        ));
    }
    emit(&ImportEvent::ImportStarted {
        document_id: options.document_id.clone(),
        source_sha256: source_hash.to_string(),
    })
}

pub(crate) fn emit_failed<F>(emit: &mut F, options: &ImportOptions, error: &HcdError)
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let _ = emit(&ImportEvent::Failed {
        document_id: options.document_id.clone(),
        error: error.to_string(),
    });
}

pub(crate) fn finish_import<F>(
    writer: hcd_core::BundleWriter,
    manifest: HcdManifest,
    emit: &mut F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let manifest = writer.finish(manifest)?;
    let _ = emit(&ImportEvent::Completed {
        manifest: manifest.clone(),
    });
    Ok(manifest)
}

pub(crate) fn manifest_at_revision(
    bundle: &Bundle,
    head: &HcdManifest,
    revision: u64,
) -> Result<HcdManifest, HcdError> {
    if revision == head.revision {
        return Ok(head.clone());
    }
    let record = bundle.revision(revision)?;
    let mut manifest = head.clone();
    manifest.revision = revision;
    manifest.root_hash = record.root_hash;
    manifest.annotation_root_hash = record.annotation_root_hash;
    manifest.annotation_href = (manifest.annotation_root_hash != hash_bytes(b"[]")).then(|| {
        format!(
            "annotations/sha256/{}.json{}",
            manifest.annotation_root_hash,
            manifest.storage_codec.suffix()
        )
    });
    manifest.index_prefix = record.index_prefix;
    manifest.index_root_href = record.index_root_href;
    Ok(manifest)
}

pub(crate) fn dirty_state_through(
    bundle: &Bundle,
    revision: u64,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    dirty_state_for_revisions(bundle, revision, 1..=revision)
}

pub(crate) fn effective_source_revisions(
    bundle: &Bundle,
    revision: u64,
) -> Result<Vec<u64>, HcdError> {
    let mut current = revision;
    let mut revisions = Vec::new();
    while current > 0 {
        let record = bundle.revision(current)?;
        if record.structural_change {
            let suffix = format!("-{current}");
            let target = record
                .patch_id
                .as_deref()
                .and_then(|id| id.strip_prefix("restore-"))
                .and_then(|id| id.strip_suffix(&suffix))
                .and_then(|id| id.parse::<u64>().ok())
                .filter(|target| *target < current)
                .ok_or_else(|| {
                    HcdError::Unsupported(
                    "structural HCD revision requires source-free semantic export; omit --source"
                        .to_string(),
                )
                })?;
            current = target;
        } else {
            revisions.push(current);
            current -= 1;
        }
    }
    revisions.reverse();
    Ok(revisions)
}

pub(crate) fn dirty_state_for_revisions(
    bundle: &Bundle,
    revision: u64,
    revisions: impl IntoIterator<Item = u64>,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    let mut dirty_parts = HashSet::new();
    let mut dirty_nodes = HashSet::new();
    let mut removed_nodes = HashSet::new();
    for current in revisions {
        let record = bundle.revision(current)?;
        if record.structural_change {
            return Err(HcdError::Unsupported(
                "structural HCD revision requires source-free semantic export; omit --source"
                    .to_string(),
            ));
        }
        dirty_parts.extend(record.dirty_source_parts);
        dirty_nodes.extend(record.dirty_node_ids);
        for node_id in record.removed_node_ids {
            dirty_nodes.remove(&node_id);
            removed_nodes.insert(node_id);
        }
    }
    if !removed_nodes.is_empty() {
        let head = bundle.manifest()?;
        let manifest = manifest_at_revision(bundle, &head, revision)?;
        for page_number in 0..manifest.index_page_count {
            let page = bundle.read_index_page(&manifest, page_number)?;
            for descriptor in page.chunks {
                if !removed_nodes
                    .iter()
                    .any(|node_id| node_bloom_might_contain(&descriptor.node_bloom, node_id))
                {
                    continue;
                }
                if let Some(entry) = bundle
                    .read_map_verified(&descriptor)?
                    .entries
                    .into_iter()
                    .find(|entry| removed_nodes.contains(&entry.node_id))
                {
                    return Err(HcdError::InvalidBundle(format!(
                        "removed node {} is still present in the current source map",
                        entry.node_id
                    )));
                }
            }
        }
    }
    Ok((dirty_parts, dirty_nodes))
}

pub(crate) fn collect_dirty_nodes(
    bundle: &Bundle,
    manifest: &HcdManifest,
    parts: &HashSet<String>,
    node_ids: &HashSet<String>,
) -> Result<Vec<TextExtractEntry>, HcdError> {
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }
    if parts.is_empty() {
        return Err(HcdError::InvalidBundle(
            "revision has dirty node ids without dirty source parts".to_string(),
        ));
    }
    let mut output = Vec::new();
    let mut found = HashSet::with_capacity(node_ids.len());
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let source_map = bundle.read_map(&descriptor)?;
            if !source_map
                .entries
                .iter()
                .any(|entry| node_ids.contains(&entry.node_id))
            {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if hash_bytes(html.as_bytes()) != descriptor.html_hash {
                return Err(HcdError::InvalidBundle(format!(
                    "chunk {} hash mismatch",
                    descriptor.chunk_id
                )));
            }
            let html_nodes = extract_html_text_nodes(&html)?;
            for entry in source_map.entries {
                if !node_ids.contains(&entry.node_id) {
                    continue;
                }
                if !parts.contains(&entry.source.part) {
                    return Err(HcdError::InvalidBundle(format!(
                        "dirty node {} maps to source part {} that is absent from the revision dirty part set",
                        entry.node_id, entry.source.part
                    )));
                }
                let text = html_nodes.get(&entry.node_id).ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "mapped node {} is missing from canonical HTML",
                        entry.node_id
                    ))
                })?;
                let actual = hash_bytes(text.as_bytes());
                if actual != entry.node_hash {
                    return Err(HcdError::InvalidBundle(format!(
                        "node {} expected hash {}, actual {actual}",
                        entry.node_id, entry.node_hash
                    )));
                }
                found.insert(entry.node_id.clone());
                output.push(TextExtractEntry {
                    chunk_id: descriptor.chunk_id.clone(),
                    node_id: entry.node_id,
                    text: text.clone(),
                    node_hash: entry.node_hash,
                    source: entry.source,
                });
            }
        }
    }
    if found.len() != node_ids.len() {
        let mut missing: Vec<&str> = node_ids
            .iter()
            .filter(|node_id| !found.contains(*node_id))
            .map(String::as_str)
            .collect();
        missing.sort_unstable();
        return Err(HcdError::InvalidBundle(format!(
            "revision references dirty HCD nodes that are missing from its index: {missing:?}"
        )));
    }
    Ok(output)
}

pub(crate) fn checked_export_state(
    bundle: &Bundle,
    source: &Path,
    options: &ExportOptions,
) -> Result<(HcdManifest, u64, HashSet<String>, HashSet<String>), HcdError> {
    let head = bundle.manifest()?;
    if head.revision > MAX_REVISION {
        return Err(HcdError::ResourceLimit(format!(
            "manifest revision {} exceeds the maximum {MAX_REVISION}",
            head.revision
        )));
    }
    let revision = options.revision.unwrap_or(head.revision);
    if revision > head.revision {
        return Err(HcdError::RevisionConflict(format!(
            "requested revision {revision} is ahead of head {}",
            head.revision
        )));
    }
    let actual = hash_file(source)?;
    if actual != head.source.sha256 {
        return Err(HcdError::SourceMismatch(format!(
            "expected source {}, actual {actual}",
            head.source.sha256
        )));
    }
    let manifest = manifest_at_revision(bundle, &head, revision)?;
    let (dirty_parts, dirty_nodes) = dirty_state_through(bundle, revision)?;
    reject_presentation_style_source_export(bundle, &manifest, &dirty_nodes)?;
    reject_image_source_export(bundle, &manifest, &dirty_nodes)?;
    Ok((manifest, revision, dirty_parts, dirty_nodes))
}

pub(crate) type RestoredExportState = (HcdManifest, HashSet<String>, HashSet<String>, Vec<u64>);

pub(crate) fn checked_export_state_with_restores(
    bundle: &Bundle,
    source: &Path,
    options: &ExportOptions,
) -> Result<RestoredExportState, HcdError> {
    let head = bundle.manifest()?;
    if head.revision > MAX_REVISION {
        return Err(HcdError::ResourceLimit(format!(
            "manifest revision {} exceeds the maximum {MAX_REVISION}",
            head.revision
        )));
    }
    let revision = options.revision.unwrap_or(head.revision);
    if revision > head.revision {
        return Err(HcdError::RevisionConflict(format!(
            "requested revision {revision} is ahead of head {}",
            head.revision
        )));
    }
    let actual = hash_file(source)?;
    if actual != head.source.sha256 {
        return Err(HcdError::SourceMismatch(format!(
            "expected source {}, actual {actual}",
            head.source.sha256
        )));
    }
    let manifest = manifest_at_revision(bundle, &head, revision)?;
    let revisions = effective_source_revisions(bundle, revision)?;
    let (dirty_parts, dirty_nodes) =
        dirty_state_for_revisions(bundle, revision, revisions.iter().copied())?;
    reject_presentation_style_source_export(bundle, &manifest, &dirty_nodes)?;
    reject_image_source_export(bundle, &manifest, &dirty_nodes)?;
    Ok((manifest, dirty_parts, dirty_nodes, revisions))
}

fn reject_image_source_export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_nodes: &HashSet<String>,
) -> Result<(), HcdError> {
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let source_map = bundle.read_map(&descriptor)?;
            if let Some(entry) = source_map.entries.iter().find(|entry| {
                dirty_nodes.contains(&entry.node_id) && entry.source.node_kind == "image"
            }) {
                return Err(HcdError::Unsupported(format!(
                    "revision changes image node {}; source-backed {} image rewrite is not implemented and export was stopped before writing output; omit --source to use the pure-Rust semantic rebuild",
                    entry.node_id, manifest.source.format
                )));
            }
        }
    }
    Ok(())
}

fn reject_presentation_style_source_export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_nodes: &HashSet<String>,
) -> Result<(), HcdError> {
    if dirty_nodes.is_empty() {
        return Ok(());
    }
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let source_map = bundle.read_map(&descriptor)?;
            if !source_map
                .entries
                .iter()
                .any(|entry| dirty_nodes.contains(&entry.node_id))
            {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            if html.contains("data-hcd-style-patched=\"true\"") {
                return Err(HcdError::Unsupported(
                    "this revision contains node.style presentation changes; source-backed export cannot preserve those changes and was stopped before writing output"
                        .to_string(),
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn write_fidelity_report(
    options: &ExportOptions,
    report: &FidelityReport,
) -> Result<(), HcdError> {
    if let Some(path) = &options.fidelity_report {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let file = std::fs::File::create(path)?;
        serde_json::to_writer_pretty(file, report)?;
    }
    Ok(())
}

pub(crate) fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn escape_attribute(text: &str) -> String {
    escape_text(text)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(crate) fn attribute(element: &BytesStart<'_>, wanted: &str) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| local_name(attribute.key.as_ref()) == wanted)
        .and_then(|attribute| {
            attribute
                .unescape_value()
                .ok()
                .map(|value| value.into_owned())
        })
}

pub(crate) fn local_name(name: &[u8]) -> &str {
    let local = name
        .iter()
        .rposition(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name);
    std::str::from_utf8(local).unwrap_or("")
}

pub(crate) fn package_error(error: PackageError) -> HcdError {
    match error {
        PackageError::ResourceLimit(message) => HcdError::ResourceLimit(message),
        other => HcdError::InvalidBundle(other.to_string()),
    }
}

/// One empty child element to append inside a control part's container.
pub(crate) struct AddedElement {
    pub(crate) name: &'static str,
    pub(crate) attributes: Vec<(String, String)>,
}

/// The bytes a control part will carry in the export: the file the export has
/// already rewritten for it, or the source entry when nothing else touched it.
/// An added part and a rename both edit the list that holds it, so the second
/// rewrite has to start from the first one's result.
pub(crate) fn current_control_part(
    archive: &mut StreamingOxmlArchive,
    replacement_paths: &HashMap<String, PathBuf>,
    name: &str,
) -> Result<Vec<u8>, HcdError> {
    match replacement_paths.get(name) {
        Some(path) => Ok(std::fs::read(path)?),
        None => archive
            .read_control_part(name, MAX_CONTROL_BYTES)
            .map_err(package_error),
    }
}

/// Highest number an identity attribute carries in a control part, so a new
/// entry never reuses one the package already knows. A value such as `rId12`
/// counts by its trailing digits; a value without digits is ignored.
pub(crate) fn highest_control_id(
    source: &[u8],
    element: &str,
    wanted: &str,
) -> Result<u64, HcdError> {
    let mut reader = Reader::from_reader(source);
    let mut buffer = Vec::new();
    let mut highest = 0u64;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("control part XML: {error}")))?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == element =>
            {
                if let Some(value) = attribute(start, wanted) {
                    let digits =
                        value.trim_start_matches(|character: char| !character.is_ascii_digit());
                    if let Ok(number) = digits.parse::<u64>() {
                        highest = highest.max(number);
                    }
                }
            }
            Event::Eof => {
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(highest)
}

/// Appends empty child elements just before the end tag of `parent`, keeping
/// every other byte of the control part exactly as it was read.
///
/// An appended child is written the way the elements it joins are written. A
/// package may bind its main namespace to a prefix (`<x:sheets><x:sheet …/>`,
/// `<p:sldIdLst><p:sldId …/>`) instead of to the default namespace, and an
/// unprefixed element inside that list is not read at all: the application hides
/// the tab or shows a presentation it cannot repair.
pub(crate) fn append_control_children(
    source: &[u8],
    parent: &str,
    children: &[AddedElement],
    part: &str,
) -> Result<Vec<u8>, HcdError> {
    let mut reader = Reader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut appended = false;
    let mut parent_scope: Option<ControlScope> = None;
    let mut sibling_scope: Option<ControlScope> = None;
    let mut root_declarations: Option<Vec<(String, String)>> = None;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("{part} XML: {error}")))?;
        // The first element of the part is its root, and what the root declares
        // is already in scope for everything written below it.
        if root_declarations.is_none() {
            if let Event::Start(ref start) | Event::Empty(ref start) = event {
                root_declarations = Some(element_scope(start).1);
            }
        }
        match event {
            Event::End(ref end) if !appended && local_name(end.name().as_ref()) == parent => {
                appended = true;
                let scope = child_scope(
                    &parent_scope,
                    &sibling_scope,
                    root_declarations.as_deref().unwrap_or_default(),
                );
                write_control_children(&mut writer, children, &scope)?;
                writer.write_event(event.into_owned())?;
            }
            Event::Start(ref start)
                if !appended
                    && parent_scope.is_none()
                    && local_name(start.name().as_ref()) == parent =>
            {
                parent_scope = Some(element_scope(start));
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref element)
                if !appended
                    && parent_scope.is_none()
                    && local_name(element.name().as_ref()) == parent =>
            {
                // A list that closes itself still has to gain its children, so
                // it is opened, filled, and closed again in place. Its own
                // declarations already cover what is written inside it.
                appended = true;
                let prefix = element_scope(element).0;
                writer.write_event(Event::Start(element.clone()))?;
                write_control_children(&mut writer, children, &(prefix, Vec::new()))?;
                let name = String::from_utf8_lossy(element.name().as_ref()).into_owned();
                writer.write_event(Event::End(BytesEnd::new(name)))?;
            }
            Event::Start(ref start)
                if !appended && parent_scope.is_some() && sibling_scope.is_none() =>
            {
                sibling_scope = Some(element_scope(start));
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref element)
                if !appended && parent_scope.is_some() && sibling_scope.is_none() =>
            {
                sibling_scope = Some(element_scope(element));
                writer.write_event(event.into_owned())?;
            }
            Event::Eof => {
                break;
            }
            other => writer.write_event(other.into_owned())?,
        }
        buffer.clear();
    }
    if !appended {
        return Err(HcdError::InvalidBundle(format!(
            "{part} is missing its {parent} list"
        )));
    }
    Ok(writer.into_inner())
}

/// The prefix an element is written with and the namespace declarations it
/// carries, which is everything a child appended inside it needs to resolve.
type ControlScope = (Option<String>, Vec<(String, String)>);

fn element_scope(element: &BytesStart<'_>) -> ControlScope {
    let prefix = name_prefix(element.name().as_ref()).map(str::to_string);
    let declarations = element
        .attributes()
        .with_checks(false)
        .flatten()
        .filter(|attribute| {
            let key = attribute.key.as_ref();
            key == b"xmlns" || key.starts_with(b"xmlns:")
        })
        .filter_map(|attribute| {
            let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
            attribute
                .unescape_value()
                .ok()
                .map(|value| (key, value.into_owned()))
        })
        .collect();
    (prefix, declarations)
}

fn name_prefix(name: &[u8]) -> Option<&str> {
    let (prefix, _) = std::str::from_utf8(name).ok()?.split_once(':')?;
    (!prefix.is_empty()).then_some(prefix)
}

/// How an appended child has to be written: like the first element already in
/// the list, keeping only the declarations the list and the document root do not
/// already make for it.
fn child_scope(
    parent: &Option<ControlScope>,
    sibling: &Option<ControlScope>,
    root: &[(String, String)],
) -> ControlScope {
    match sibling {
        Some((prefix, declarations)) => (
            prefix.clone(),
            declarations
                .iter()
                .filter(|(key, _)| {
                    !root.iter().any(|(name, _)| name == key)
                        && !parent.as_ref().is_some_and(|(_, declared)| {
                            declared.iter().any(|(name, _)| name == key)
                        })
                })
                .cloned()
                .collect(),
        ),
        None => (
            parent.as_ref().and_then(|(prefix, _)| prefix.clone()),
            Vec::new(),
        ),
    }
}

fn write_control_children(
    writer: &mut Writer<Vec<u8>>,
    children: &[AddedElement],
    scope: &ControlScope,
) -> Result<(), HcdError> {
    for child in children {
        let name = match scope.0.as_deref() {
            Some(prefix) => format!("{prefix}:{}", child.name),
            None => child.name.to_string(),
        };
        let mut element = BytesStart::new(name);
        for (key, value) in &scope.1 {
            element.push_attribute((key.as_str(), value.as_str()));
        }
        for (key, value) in &child.attributes {
            element.push_attribute((key.as_str(), value.as_str()));
        }
        writer.write_event(Event::Empty(element))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        hash_bytes, BundleWriter, ChunkSourceMap, NodeMapEntry, SourceAnchor, HCD_SCHEMA_VERSION,
    };
    use quick_xml::events::BytesStart;

    #[test]
    fn an_appended_child_repeats_only_the_namespace_its_siblings_need() {
        let relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        let parent = Some((Some("x".to_string()), Vec::new()));
        let sibling = Some((
            Some("x".to_string()),
            vec![("xmlns:r".to_string(), relationships.to_string())],
        ));
        // A package whose root already binds `r` must not repeat the
        // declaration on the child it appends, so the child reads like the rest.
        let bound = child_scope(
            &parent,
            &sibling,
            &[("xmlns:r".to_string(), relationships.to_string())],
        );
        assert_eq!(bound.0.as_deref(), Some("x"));
        assert!(bound.1.is_empty(), "{bound:?}");
        // A package that binds `r` only on its list has to hand that binding to
        // the appended child, or the child's relationship id resolves to nothing.
        let copied = child_scope(&parent, &sibling, &[]);
        assert_eq!(
            copied,
            (
                Some("x".to_string()),
                vec![("xmlns:r".to_string(), relationships.to_string())]
            )
        );
    }

    #[test]
    fn xml_budget_rejects_excessive_depth() {
        let mut budget = XmlBudget::default();
        let start = Event::Start(BytesStart::new("nested"));
        for _ in 0..MAX_XML_DEPTH {
            budget.observe(&start, "test.xml").unwrap();
        }
        let error = budget.observe(&start, "test.xml").unwrap_err();
        assert!(error.to_string().contains("maximum XML depth"));
    }

    #[test]
    fn export_collection_materializes_only_dirty_nodes_not_the_whole_part() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle");
        let mut writer = BundleWriter::create(&bundle_path).unwrap();
        writer.write_styles("").unwrap();
        let first_id = "n_00000000000000000000000000000001";
        let second_id = "n_00000000000000000000000000000002";
        let first_hash = hash_bytes(b"unchanged");
        let second_hash = hash_bytes(b"changed");
        let html = format!(
            "<table><tr><td><span data-hcd-id=\"{first_id}\" data-hcd-node-hash=\"{first_hash}\">unchanged</span></td><td><span data-hcd-id=\"{second_id}\" data-hcd-node-hash=\"{second_hash}\">changed</span></td></tr></table>"
        );
        let part = "xl/worksheets/sheet1.xml";
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000001".to_string(),
            entries: vec![
                NodeMapEntry {
                    node_id: first_id.to_string(),
                    node_hash: first_hash,
                    source: test_anchor(part, 1, "A1"),
                },
                NodeMapEntry {
                    node_id: second_id.to_string(),
                    node_hash: second_hash,
                    source: test_anchor(part, 2, "B1"),
                },
            ],
        };
        writer
            .write_chunk(
                map.chunk_id.clone(),
                "sheet".to_string(),
                html,
                map,
                1,
                false,
            )
            .unwrap();
        let options = ImportOptions::new("test-document");
        let manifest = writer
            .finish(base_manifest(&options, "xlsx", "grid", "0".repeat(64), 1))
            .unwrap();
        let bundle = Bundle::open(bundle_path).unwrap();
        let parts = HashSet::from([part.to_string()]);
        let dirty = HashSet::from([second_id.to_string()]);

        let nodes = collect_dirty_nodes(&bundle, &manifest, &parts, &dirty).unwrap();

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_id, second_id);
        assert_eq!(nodes[0].text, "changed");
    }

    fn test_anchor(part: &str, ordinal: u64, cell: &str) -> SourceAnchor {
        SourceAnchor {
            source_cell_ref: None,
            created_in_hcd: false,
            part: part.to_string(),
            text_ordinal: ordinal,
            paragraph_id: Some(cell.to_string()),
            text_id: None,
            node_kind: "cell".to_string(),
            editable: true,
        }
    }
}
