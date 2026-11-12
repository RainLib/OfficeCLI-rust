use hcd_core::{
    extract_html_text_nodes, hash_bytes, hash_file, node_bloom_might_contain, Bundle,
    FidelityReport, HcdError, HcdManifest, ImportEvent, SourceDescriptor, TextExtractEntry,
    DEFAULT_CHUNK_BLOCKS, DEFAULT_CHUNK_SOFT_BYTES, HCD_SCHEMA_VERSION, MAX_REVISION,
};
use oxml::{PackageError, StreamingOxmlArchive};
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};
use std::collections::{BTreeSet, HashMap, HashSet};
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

/// Read one attribute of a control-part element. A value the reader cannot
/// unescape is refused rather than skipped: an entry whose name cannot be read
/// is an entry the export cannot safely keep or drop, and guessing wrong there
/// leaves a package with a dangling reference.
pub(crate) fn checked_attribute(
    element: &BytesStart<'_>,
    wanted: &str,
) -> Result<Option<String>, HcdError> {
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute
            .map_err(|error| HcdError::InvalidBundle(format!("control part attribute: {error}")))?;
        if local_name(attribute.key.as_ref()) != wanted {
            continue;
        }
        let value = attribute
            .unescape_value()
            .map_err(|error| HcdError::InvalidBundle(format!("control part value: {error}")))?;
        return Ok(Some(value.to_string()));
    }
    Ok(None)
}

/// Copy a control list without the empty children whose attribute names an entry
/// this export removes: a sheet list loses its tab, a relationship list loses its
/// pointer, `[Content_Types].xml` loses its override, and a presentation loses the
/// `<p:sldId>` of a deleted slide. Everything else is written as the source had
/// it, so a package that drops one entry keeps the bytes it wrote for the rest.
/// Returns the new bytes and how many children were dropped.
pub(crate) fn drop_control_elements(
    source: &[u8],
    parent: &str,
    element: &str,
    attribute: &str,
    values: &BTreeSet<String>,
    part: &str,
) -> Result<(Vec<u8>, usize), HcdError> {
    let mut reader = Reader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut open_depth: Option<usize> = None;
    let mut depth = 0usize;
    let mut dropped = 0usize;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("{part} XML: {error}")))?;
        match event {
            Event::Start(ref element) => {
                if open_depth.is_none() && local_name(element.name().as_ref()) == parent {
                    open_depth = Some(depth);
                }
                depth += 1;
                writer.write_event(event.into_owned())?;
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if open_depth == Some(depth) {
                    open_depth = None;
                }
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref candidate)
                if open_depth.is_some() && local_name(candidate.name().as_ref()) == element =>
            {
                if checked_attribute(candidate, attribute)?
                    .is_some_and(|value| values.contains(&value))
                {
                    dropped += 1;
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Eof => break,
            other => writer.write_event(other.into_owned())?,
        }
        buffer.clear();
    }
    Ok((writer.into_inner(), dropped))
}

/// The value a control list child is named by, read the way the export's own
/// readers read it. A bare wanted name matches only an unprefixed attribute:
/// `<p:sldId>` carries both an `id` and an `r:id`, and a prefixless match would
/// pick whichever the package wrote first. A wanted name written with a prefix
/// matches any prefix, because a package is free to bind the relationship
/// namespace to a name of its own.
fn control_child_key(
    element: &BytesStart<'_>,
    wanted: &str,
    part: &str,
) -> Result<Option<String>, HcdError> {
    let prefixed = wanted.contains(':');
    let local = local_name(wanted.as_bytes());
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute
            .map_err(|error| HcdError::InvalidBundle(format!("{part} attribute: {error}")))?;
        let key = attribute.key.as_ref();
        let matches = if prefixed {
            key.contains(&b':') && local_name(key) == local
        } else {
            key == wanted.as_bytes()
        };
        if !matches {
            continue;
        }
        let value = attribute
            .unescape_value()
            .map_err(|error| HcdError::InvalidBundle(format!("{part} value: {error}")))?;
        return Ok(Some(value.into_owned()));
    }
    Ok(None)
}

/// Copy a control list with its children written in another order, keeping every
/// other byte of the part as the source had it: the presentation's
/// `<p:sldIdLst>` after a page moved through the deck.
///
/// `wanted` names the children by their `attribute`, in the order the export
/// wants. A child `wanted` does not name is left where the list put it, after the
/// ones it does name; a name `wanted` gives that no child carries is refused,
/// because the export would be asking for a page the package cannot address. Only
/// empty children move, so a list that opens one of its entries — and anything
/// else it opens — is refused rather than rebuilt with its content hoisted out.
///
/// Returns the new bytes and how many children ended somewhere other than where
/// they started. A caller that asked for an order the list already holds is given
/// `0` and writes nothing, which is what keeps a page moved and moved back
/// exporting byte-identically.
pub(crate) fn reorder_control_children(
    source: &[u8],
    parent: &str,
    element: &str,
    attribute: &str,
    wanted: &[String],
    part: &str,
) -> Result<(Vec<u8>, usize), HcdError> {
    for value in wanted {
        if wanted.iter().filter(|name| *name == value).count() > 1 {
            return Err(HcdError::InvalidBundle(format!(
                "{part} asks for {element} {value} more than once"
            )));
        }
    }
    let mut reader = Reader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut open_depth: Option<usize> = None;
    let mut depth = 0usize;
    let mut children: Vec<(Option<String>, Vec<u8>)> = Vec::new();
    let mut moved = 0usize;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("{part} XML: {error}")))?;
        match event {
            Event::Start(ref start) => {
                if open_depth.is_some() {
                    // Only empty entries move: an entry that opens carries content
                    // the helper would have to hoist out of the list to move it.
                    return Err(HcdError::Unsupported(format!(
                        "{part} opens an entry inside its {parent} list, which the export cannot carry along, so export without --source"
                    )));
                }
                if local_name(start.name().as_ref()) == parent {
                    open_depth = Some(depth);
                }
                depth += 1;
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref child)
                if open_depth.is_some() && local_name(child.name().as_ref()) == element =>
            {
                // The entry is written out once, into a buffer of its own, so the
                // list can hand it back in whatever order the deck now shows.
                let mut child_writer = Writer::new(Vec::new());
                child_writer.write_event(Event::Empty(child.clone()))?;
                let name = control_child_key(child, attribute, part)?;
                children.push((name, child_writer.into_inner()));
            }
            Event::End(_) => {
                depth = depth.saturating_sub(1);
                if open_depth == Some(depth) {
                    let order = child_order(&children, wanted, element, part)?;
                    for (position, index) in order.iter().enumerate() {
                        if *index != position {
                            moved += 1;
                        }
                        writer.get_mut().extend_from_slice(&children[*index].1);
                    }
                    open_depth = None;
                }
                writer.write_event(event.into_owned())?;
            }
            Event::Eof => break,
            other => writer.write_event(other.into_owned())?,
        }
        buffer.clear();
    }
    Ok((writer.into_inner(), moved))
}

/// Where each buffered child of a control list ends up: the ones `wanted` names
/// first, in the order it names them, then whatever it left alone in the order
/// the list already had. A name no child carries is refused.
fn child_order(
    children: &[(Option<String>, Vec<u8>)],
    wanted: &[String],
    element: &str,
    part: &str,
) -> Result<Vec<usize>, HcdError> {
    for value in wanted {
        if !children
            .iter()
            .any(|(name, _)| name.as_deref() == Some(value.as_str()))
        {
            return Err(HcdError::InvalidBundle(format!(
                "{part} holds no {element} named {value}"
            )));
        }
    }
    let rank = |name: &Option<String>| {
        wanted
            .iter()
            .position(|value| name.as_deref() == Some(value.as_str()))
            .unwrap_or(usize::MAX)
    };
    let mut order: Vec<usize> = (0..children.len()).collect();
    order.sort_by_key(|index| (rank(&children[*index].0), *index));
    Ok(order)
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

    /// A presentation's page list as a package writes one: the deck shows
    /// `slide2.xml` first although its relationships name `slide1.xml` first, and
    /// every entry carries both an id that does not depend on its position and the
    /// relationship that names its page.
    const TWO_PAGES: &str = concat!(
        r#"<?xml version="1.0"?>"#,
        r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
        r#"<p:sldSz cx="12192000" cy="6858000"/>"#,
        r#"<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>"#,
        r#"</p:presentation>"#,
    );

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn reorder(list: &str, wanted: &[&str]) -> Result<(String, usize), HcdError> {
        reorder_control_children(
            list.as_bytes(),
            "sldIdLst",
            "sldId",
            "r:id",
            &names(wanted),
            "ppt/presentation.xml",
        )
        .map(|(bytes, moved)| (String::from_utf8(bytes).unwrap(), moved))
    }

    #[test]
    fn a_reordered_list_trades_its_entries_and_keeps_every_other_byte() {
        let (rewritten, moved) = reorder(TWO_PAGES, &["rId1", "rId2"]).unwrap();
        assert_eq!(moved, 2);
        // The entries trade places with the ids they were written with, and the
        // slide size, the declarations and the two end tags stay as they were.
        assert_eq!(
            rewritten,
            TWO_PAGES.replace(
                "<p:sldId id=\"256\" r:id=\"rId2\"/><p:sldId id=\"257\" r:id=\"rId1\"/>",
                "<p:sldId id=\"257\" r:id=\"rId1\"/><p:sldId id=\"256\" r:id=\"rId2\"/>",
            )
        );
    }

    #[test]
    fn a_list_that_already_holds_the_wanted_order_reports_no_move() {
        let (rewritten, moved) = reorder(TWO_PAGES, &["rId2", "rId1"]).unwrap();
        assert_eq!(moved, 0);
        assert_eq!(rewritten, TWO_PAGES);
    }

    #[test]
    fn a_reorder_refuses_a_page_the_list_does_not_hold() {
        let error =
            reorder(TWO_PAGES, &["rId1", "rId9"]).expect_err("a page the deck has never had");
        assert!(
            error.to_string().contains("holds no sldId named rId9"),
            "{error}"
        );
    }

    #[test]
    fn a_reorder_refuses_a_name_it_asks_for_twice() {
        let error = reorder(TWO_PAGES, &["rId1", "rId1"])
            .expect_err("an order that names one page twice is no order");
        assert!(error.to_string().contains("more than once"), "{error}");
    }

    #[test]
    fn a_reorder_refuses_a_list_that_opens_one_of_its_entries() {
        // Content inside an entry cannot be carried along with the entry without
        // hoisting it out of the list, so the whole reorder is refused.
        let list = TWO_PAGES.replace(
            "<p:sldId id=\"256\" r:id=\"rId2\"/>",
            "<p:sldId id=\"256\" r:id=\"rId2\"><p:stuff/></p:sldId>",
        );
        let error = reorder(&list, &["rId1", "rId2"]).expect_err("an entry with content in it");
        assert!(
            error
                .to_string()
                .contains("opens an entry inside its sldIdLst list"),
            "{error}"
        );
    }

    #[test]
    fn an_entry_the_order_leaves_alone_stays_behind_the_named_ones() {
        // A section's nested list holds entries that name no relationship. Such an
        // entry is not something the deck's order can place, so it keeps the last
        // seat rather than jumping to the front.
        let list = TWO_PAGES.replace("</p:sldIdLst>", "<p:sldId id=\"258\"/></p:sldIdLst>");
        let (rewritten, moved) = reorder(&list, &["rId1", "rId2"]).unwrap();
        assert_eq!(moved, 2);
        assert_eq!(
            rewritten,
            list.replace(
                "<p:sldId id=\"256\" r:id=\"rId2\"/><p:sldId id=\"257\" r:id=\"rId1\"/><p:sldId id=\"258\"/>",
                "<p:sldId id=\"257\" r:id=\"rId1\"/><p:sldId id=\"256\" r:id=\"rId2\"/><p:sldId id=\"258\"/>",
            )
        );
    }

    #[test]
    fn a_prefixed_name_finds_the_relationship_whatever_prefix_the_package_used() {
        // The relationships namespace is bound by convention, not by rule: a
        // package may write the same attribute under a prefix of its own, and an
        // entry's bare `id` is its position-independent number, not its page.
        let list = concat!(
            r#"<?xml version="1.0"?>"#,
            r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
            r#"<p:sldSz cx="12192000" cy="6858000"/>"#,
            r#"<p:sldIdLst><p:sldId id="256" rel:id="rId2"/><p:sldId id="257" rel:id="rId1"/></p:sldIdLst>"#,
            r#"</p:presentation>"#,
        );
        let (rewritten, moved) = reorder(list, &["rId1", "rId2"]).unwrap();
        assert_eq!(moved, 2);
        assert_eq!(
            rewritten,
            list.replace(
                "<p:sldId id=\"256\" rel:id=\"rId2\"/><p:sldId id=\"257\" rel:id=\"rId1\"/>",
                "<p:sldId id=\"257\" rel:id=\"rId1\"/><p:sldId id=\"256\" rel:id=\"rId2\"/>",
            )
        );
    }

    #[test]
    fn a_bare_attribute_name_matches_only_an_unprefixed_attribute() {
        // `[Content_Types].xml` names its overrides with a bare `PartName`, and a
        // wanted name with no prefix must not pick up a prefixed attribute that
        // happens to share its local name.
        let types = concat!(
            r#"<?xml version="1.0"?>"#,
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
            r#"<Override PartName="/a.xml" ContentType="application/xml"/>"#,
            r#"<Override PartName="/b.xml" ContentType="application/xml"/>"#,
            r#"</Types>"#,
        );
        let (rewritten, moved) = reorder_control_children(
            types.as_bytes(),
            "Types",
            "Override",
            "PartName",
            &names(&["/b.xml", "/a.xml"]),
            "[Content_Types].xml",
        )
        .map(|(bytes, moved)| (String::from_utf8(bytes).unwrap(), moved))
        .unwrap();
        assert_eq!(moved, 2);
        assert_eq!(
            rewritten,
            types.replace(
                "<Override PartName=\"/a.xml\" ContentType=\"application/xml\"/><Override PartName=\"/b.xml\" ContentType=\"application/xml\"/>",
                "<Override PartName=\"/b.xml\" ContentType=\"application/xml\"/><Override PartName=\"/a.xml\" ContentType=\"application/xml\"/>",
            )
        );
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
