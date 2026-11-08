use hcd_core::{
    extract_html_text_nodes, hash_file, Bundle, FidelityLevel, FidelityReport, HcdError,
    HcdManifest, NodeMapEntry, HCD_SCHEMA_VERSION, MAX_REVISION,
};
use oxml::{PackageError, StreamingOxmlArchive, StreamingOxmlRewriter};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    pub revision: Option<u64>,
    pub fidelity_report: Option<PathBuf>,
}

/// Checks whether this revision's edits need semantic rebuilding. This is an
/// eligibility check; export still verifies the immutable source and package.
pub fn requires_semantic_rebuild(bundle: &Bundle, revision: u64) -> Result<bool, HcdError> {
    let head = bundle.manifest()?;
    if revision > head.revision || revision > MAX_REVISION {
        return Err(HcdError::RevisionConflict(
            "export revision is ahead of head".into(),
        ));
    }
    let check = || {
        let manifest = manifest_at_revision(bundle, &head, revision)?;
        let (_, nodes) = dirty_state_through(bundle, revision)?;
        reject_image_source_export(bundle, &manifest, &nodes)?;
        reject_presentation_style_source_export(bundle, &manifest, &nodes)
    };
    match check() {
        Ok(()) => Ok(false),
        Err(HcdError::Unsupported(_)) => Ok(true),
        Err(error) => Err(error),
    }
}

pub fn export_docx(
    bundle_path: impl AsRef<Path>,
    source: impl AsRef<Path>,
    target: impl AsRef<Path>,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    let bundle = Bundle::open(bundle_path)?;
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
    let (_source_snapshot, source_copy) =
        snapshot_docx_source(source.as_ref(), &head.source.sha256, head.source.size_bytes)?;
    let source = source_copy.as_path();
    let target = target.as_ref();

    let revision_manifest = manifest_at_revision(&bundle, &head, revision)?;
    // Even source-backed export must understand required layout metadata. A
    // future model may change section relationships without dirty text nodes.
    hcd_core::read_flow_document_layout(&bundle, &revision_manifest)?;
    if (2..=4097).contains(&revision)
        && revision_manifest.capabilities.word_layout_edits == Some(2)
        && bundle
            .revision(revision)?
            .patch_id
            .as_deref()
            .is_some_and(|id| id.starts_with("word-story-link-"))
    {
        return export_verified_story_link(&bundle, source, target, revision, options);
    }
    let verified = if revision_manifest.capabilities.flow_layout.is_some()
        && requires_semantic_rebuild(&bundle, revision)?
    {
        Some(crate::story_link_verification::verify_source_region_text(
            &bundle, source, revision,
        )?)
    } else {
        None
    };
    let frozen = verified
        .as_ref()
        .map(|(_, snapshot, _)| Bundle::open(snapshot.directory.path()))
        .transpose()?;
    let bundle = frozen.as_ref().unwrap_or(&bundle);
    let source = verified
        .as_ref()
        .map(|(_, _, path)| path.as_path())
        .unwrap_or(source);
    let revision_manifest = manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    let (dirty_parts, dirty_node_ids) =
        dirty_state_from(bundle, revision, if verified.is_some() { 2 } else { 1 })?;
    reject_image_source_export(bundle, &revision_manifest, &dirty_node_ids)?;
    reject_presentation_style_source_export(bundle, &revision_manifest, &dirty_node_ids)?;
    let text_by_part =
        collect_text_by_part(bundle, &revision_manifest, &dirty_parts, &dirty_node_ids)?;
    let sizes_by_part = collect_sizes_by_part(bundle, &revision_manifest, &dirty_node_ids)?;

    // Historical semantic imports may have marked cached field results as
    // editable. Re-derive the source policy before writing any such text
    // back into the original package, regardless of the old map's claims.
    if revision_manifest.capabilities.flow_layout.is_none() && !text_by_part.is_empty() {
        verify_original_text_policy(source, &head.source.sha256, &text_by_part)?;
    }

    let temp_dir = tempfile::tempdir()?;
    let mut replacement_paths = HashMap::new();
    if !text_by_part.is_empty() {
        let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
        for (part, replacements) in &text_by_part {
            if !archive.contains(part) {
                return Err(HcdError::InvalidBundle(format!(
                    "source part {part} referenced by HCD is missing"
                )));
            }
            let replacement_path = temp_dir.path().join(safe_temp_name(part));
            let output = std::fs::File::create(&replacement_path)?;
            archive
                .with_part(part, |reader| {
                    let result = if let Some(sizes) = sizes_by_part.get(part) {
                        crate::source_runs::rewrite_formatted_part(
                            reader,
                            BufWriter::new(output),
                            replacements,
                            sizes,
                        )
                    } else {
                        rewrite_text_part(reader, BufWriter::new(output), replacements)
                    };
                    result.map_err(|error| PackageError::ReadPartError(error.to_string()))
                })
                .map_err(package_error)?;
            replacement_paths.insert(part.clone(), replacement_path);
        }
    }

    let changed =
        StreamingOxmlRewriter::rewrite(source, target, &replacement_paths, "word/document.xml")
            .map_err(package_error)?;

    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: if changed.is_empty() {
            FidelityLevel::Exact
        } else {
            FidelityLevel::High
        },
        preserved: vec![
            "unmodified OOXML entries copied as raw compressed payloads".to_string(),
            "paragraph and run formatting".to_string(),
            "relationships, media, numbering, headers and footers".to_string(),
        ],
        flattened: Vec::new(),
        dropped: vec!["HCD recognition annotations are not exported to DOCX".to_string()],
        warnings: head.warnings.clone(),
    };
    if let Some(path) = &options.fidelity_report {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let file = std::fs::File::create(path)?;
        serde_json::to_writer_pretty(file, &report)?;
    }
    Ok(report)
}

fn verify_original_text_policy(
    source: &Path,
    expected_hash: &str,
    replacements: &HashMap<String, BTreeMap<u64, String>>,
) -> Result<(), HcdError> {
    let size = std::fs::metadata(source)?.len();
    let readonly = source_read_only_policy(source, expected_hash, size)?;
    for (part, ordinal) in readonly.iter() {
        if replacements
            .get(part)
            .is_some_and(|items| items.contains_key(ordinal))
        {
            return Err(HcdError::Unsupported(format!(
                "DOCX_SOURCE_TEXT_READ_ONLY: {part} ordinal {ordinal}"
            )));
        }
    }
    Ok(())
}

/// Identify mapped text which an older semantic import incorrectly marked
/// editable. The source is copied and authenticated before it is parsed, so
/// a concurrent replacement of the source path cannot change the proof.
pub fn legacy_read_only_nodes(bundle: &Bundle, source: &Path) -> Result<HashSet<String>, HcdError> {
    let head = bundle.manifest()?;
    if head.source.format != "docx" || head.capabilities.flow_layout.is_some() {
        return Ok(HashSet::new());
    }
    let readonly = source_read_only_policy(source, &head.source.sha256, head.source.size_bytes)?;
    let mut legacy = HashSet::new();
    for page in 0..head.index_page_count {
        for descriptor in bundle.read_index_page(&head, page)?.chunks {
            for entry in bundle.read_map_verified(&descriptor)?.entries {
                if entry.source.node_kind == "text"
                    && entry.source.editable
                    && readonly.contains(&(entry.source.part, entry.source.text_ordinal))
                {
                    legacy.insert(entry.node_id);
                }
            }
        }
    }
    Ok(legacy)
}

type SourcePolicy = HashSet<(String, u64)>;
type SourcePolicyCache = HashMap<String, (Arc<SourcePolicy>, usize)>;
static SOURCE_POLICY_CACHE: OnceLock<Mutex<SourcePolicyCache>> = OnceLock::new();

fn snapshot_docx_source(
    source: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<(tempfile::TempDir, PathBuf), HcdError> {
    if expected_size > 256 * 1024 * 1024 {
        return Err(HcdError::ResourceLimit(
            "DOCX source exceeds the import limit".into(),
        ));
    }
    let temporary = tempfile::tempdir()?;
    let source_copy = temporary.path().join("source.docx");
    let input = std::fs::File::open(source)?;
    let mut output = std::fs::File::create(&source_copy)?;
    let copied = std::io::copy(
        &mut input.take(expected_size.saturating_add(1)),
        &mut output,
    )?;
    drop(output);
    if copied != expected_size || hash_file(&source_copy)? != expected_hash {
        return Err(HcdError::SourceMismatch(
            "DOCX source changed during policy check".into(),
        ));
    }
    Ok((temporary, source_copy))
}

fn source_read_only_policy(
    source: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<Arc<SourcePolicy>, HcdError> {
    if expected_size > 256 * 1024 * 1024 {
        return Err(HcdError::ResourceLimit(
            "DOCX source exceeds the import limit".into(),
        ));
    }
    // The cached policy only describes authenticated source bytes. Every hit
    // still verifies the source path; an old cache entry cannot authorize a
    // changed or missing file.
    if std::fs::metadata(source)?.len() != expected_size || hash_file(source)? != expected_hash {
        return Err(HcdError::SourceMismatch(
            "DOCX source changed during policy check".into(),
        ));
    }
    let cache = SOURCE_POLICY_CACHE.get_or_init(Default::default);
    if let Some(policy) = cache
        .lock()
        .map_err(|_| HcdError::InvalidBundle("DOCX policy cache unavailable".into()))?
        .get(expected_hash)
        .map(|entry| Arc::clone(&entry.0))
    {
        return Ok(policy);
    }
    let (temporary, source_copy) = snapshot_docx_source(source, expected_hash, expected_size)?;
    let imported_path = temporary.path().join("source.hcd");
    let imported = crate::import_docx(
        &source_copy,
        &imported_path,
        &crate::ImportOptions::new("source-policy-check"),
        |_| Ok(()),
    )?;
    let source_bundle = Bundle::open(imported_path)?;
    let mut readonly = HashSet::new();
    for page in 0..imported.index_page_count {
        for descriptor in source_bundle.read_index_page(&imported, page)?.chunks {
            for entry in source_bundle.read_map_verified(&descriptor)?.entries {
                if entry.source.node_kind == "text" && !entry.source.editable {
                    readonly.insert((entry.source.part, entry.source.text_ordinal));
                }
            }
        }
    }
    let readonly = Arc::new(readonly);
    // Bound both entry count and estimated allocations. Large policies remain
    // valid but are recomputed instead of consuming unbounded process memory.
    let weight = readonly.iter().fold(0usize, |sum, (part, _)| {
        sum.saturating_add(part.len().saturating_add(96))
    });
    if weight <= 2 * 1024 * 1024 {
        let mut guard = cache
            .lock()
            .map_err(|_| HcdError::InvalidBundle("DOCX policy cache unavailable".into()))?;
        if guard.len() >= 8
            || guard
                .values()
                .map(|entry| entry.1)
                .sum::<usize>()
                .saturating_add(weight)
                > 8 * 1024 * 1024
        {
            guard.clear();
        }
        guard.insert(expected_hash.to_string(), (Arc::clone(&readonly), weight));
    }
    Ok(readonly)
}

fn export_verified_story_link(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
    revision: u64,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    let verified = crate::verify_source_story_link(bundle, source, revision)?;
    let snapshot = Bundle::open(verified.bundle_snapshot.directory.path())?;
    let head = snapshot.manifest()?;
    let stage = tempfile::tempdir()?;
    let replacement = stage.path().join("document.xml");
    let mut archive = StreamingOxmlArchive::open(&verified.source_path).map_err(package_error)?;
    archive
        .with_part("word/document.xml", |reader| {
            let mut output = BufWriter::new(std::fs::File::create(&replacement)?);
            crate::rewrite_story_link_references(
                reader,
                &mut output,
                verified.section_count,
                &verified.removals,
            )
            .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
            output.flush()?;
            Ok(())
        })
        .map_err(package_error)?;
    let replacements = HashMap::from([("word/document.xml".to_string(), replacement)]);
    StreamingOxmlRewriter::rewrite(
        &verified.source_path,
        target,
        &replacements,
        "word/document.xml",
    )
    .map_err(package_error)?;
    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: FidelityLevel::High,
        preserved: vec![
            "unmodified OOXML entries copied as raw compressed payloads".into(),
            "paragraph and run formatting, relationships, media, numbering and stories".into(),
            "selected section story reference linked to the preceding section".into(),
        ],
        flattened: Vec::new(),
        dropped: vec!["HCD recognition annotations are not exported to DOCX".into()],
        warnings: head.warnings,
    };
    if let Some(path) = &options.fidelity_report {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        serde_json::to_writer_pretty(std::fs::File::create(path)?, &report)?;
    }
    Ok(report)
}

fn reject_image_source_export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_node_ids: &HashSet<String>,
) -> Result<(), HcdError> {
    if dirty_node_ids.is_empty() {
        return Ok(());
    }
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let source_map = bundle.read_map(&descriptor)?;
            if let Some(entry) = source_map.entries.iter().find(|entry| {
                dirty_node_ids.contains(&entry.node_id) && entry.source.node_kind == "image"
            }) {
                return Err(HcdError::Unsupported(format!(
                    "revision changes image node {}; source-backed DOCX image rewrite is not implemented and export was stopped before writing output; omit --source to use the pure-Rust semantic rebuild",
                    entry.node_id
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
                    "this revision contains node.style presentation changes; source-backed DOCX export cannot preserve those changes and was stopped before writing output"
                        .to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn manifest_at_revision(
    bundle: &Bundle,
    head: &HcdManifest,
    revision: u64,
) -> Result<HcdManifest, HcdError> {
    hcd_core::manifest_at_revision(bundle, head, Some(revision)).map(|(manifest, _)| manifest)
}

fn dirty_state_through(
    bundle: &Bundle,
    revision: u64,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    dirty_state_from(bundle, revision, 1)
}

fn dirty_state_from(
    bundle: &Bundle,
    revision: u64,
    start: u64,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    let mut dirty_parts = HashSet::new();
    let mut dirty_nodes = HashSet::new();
    for current in start..=revision {
        let record = bundle.revision(current)?;
        if record.structural_change {
            return Err(HcdError::Unsupported(
                "structural HCD revision requires source-free semantic DOCX rebuild; omit --source"
                    .to_string(),
            ));
        }
        dirty_parts.extend(record.dirty_source_parts);
        dirty_nodes.extend(record.dirty_node_ids);
    }
    Ok((dirty_parts, dirty_nodes))
}

fn collect_text_by_part(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_parts: &HashSet<String>,
    dirty_node_ids: &HashSet<String>,
) -> Result<HashMap<String, BTreeMap<u64, String>>, HcdError> {
    let mut output: HashMap<String, BTreeMap<u64, String>> = HashMap::new();
    if dirty_parts.is_empty() && dirty_node_ids.is_empty() {
        return Ok(output);
    }
    if dirty_parts.is_empty() || dirty_node_ids.is_empty() {
        return Err(HcdError::InvalidBundle(
            "revision dirty source parts and dirty node ids must either both be empty or both be present"
                .to_string(),
        ));
    }
    let mut found = HashSet::with_capacity(dirty_node_ids.len());
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let source_map = bundle.read_map(&descriptor)?;
            if !source_map
                .entries
                .iter()
                .any(|entry| dirty_node_ids.contains(&entry.node_id))
            {
                continue;
            }
            let html = bundle.read_chunk(&descriptor)?;
            let html_nodes = extract_html_text_nodes(&html)?;
            for entry in source_map.entries {
                if !dirty_node_ids.contains(&entry.node_id) {
                    continue;
                }
                if !dirty_parts.contains(&entry.source.part) {
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
                let actual_hash = hcd_core::hash_bytes(text.as_bytes());
                if actual_hash != entry.node_hash {
                    return Err(HcdError::InvalidBundle(format!(
                        "node {} HTML hash {} does not match source-map hash {}",
                        entry.node_id, actual_hash, entry.node_hash
                    )));
                }
                found.insert(entry.node_id.clone());
                insert_entry(&mut output, entry, text)?;
            }
        }
    }
    if found.len() != dirty_node_ids.len() {
        let mut missing: Vec<&str> = dirty_node_ids
            .iter()
            .filter(|node_id| !found.contains(*node_id))
            .map(String::as_str)
            .collect();
        missing.sort_unstable();
        return Err(HcdError::InvalidBundle(format!(
            "revision references dirty HCD nodes that are missing from its index: {missing:?}"
        )));
    }
    for part in dirty_parts {
        if !output.contains_key(part) {
            return Err(HcdError::InvalidBundle(format!(
                "dirty source part {part} has no HCD text map"
            )));
        }
    }
    Ok(output)
}

fn collect_sizes_by_part(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_nodes: &HashSet<String>,
) -> Result<HashMap<String, BTreeMap<u64, Vec<hcd_core::FontSizeRun>>>, HcdError> {
    let mut output: HashMap<String, BTreeMap<u64, Vec<hcd_core::FontSizeRun>>> = HashMap::new();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let map = bundle.read_map_verified(&descriptor)?;
            if !map
                .entries
                .iter()
                .any(|entry| dirty_nodes.contains(&entry.node_id))
            {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let sizes = hcd_core::extract_text_run_sizes(&html)?;
            for entry in map
                .entries
                .iter()
                .filter(|entry| dirty_nodes.contains(&entry.node_id))
            {
                if let Some(runs) = sizes.get(&entry.node_id) {
                    let previous = output
                        .entry(entry.source.part.clone())
                        .or_default()
                        .insert(entry.source.text_ordinal, runs.clone());
                    if previous.as_ref().is_some_and(|previous| previous != runs) {
                        return Err(HcdError::InvalidBundle(
                            "source ordinal maps to conflicting font sizes".into(),
                        ));
                    }
                }
            }
        }
    }
    Ok(output)
}

fn insert_entry(
    output: &mut HashMap<String, BTreeMap<u64, String>>,
    entry: NodeMapEntry,
    text: &str,
) -> Result<(), HcdError> {
    let part = output.entry(entry.source.part.clone()).or_default();
    if let Some(previous) = part.insert(entry.source.text_ordinal, text.to_string()) {
        if previous != text {
            return Err(HcdError::InvalidBundle(format!(
                "source ordinal {} in {} maps to multiple values",
                entry.source.text_ordinal, entry.source.part
            )));
        }
    }
    Ok(())
}

fn rewrite_text_part(
    source: &mut dyn Read,
    output: impl Write,
    replacements: &BTreeMap<u64, String>,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut ordinal = 0u64;
    let mut replacing = false;
    let mut seen = BTreeSet::new();

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("source XML parse error: {error}")))?;
        match event {
            Event::Start(ref start) if local_name(start.name().as_ref()) == "t" => {
                ordinal += 1;
                if let Some(text) = replacements.get(&ordinal) {
                    let owned = start_with_space_preservation(start, text);
                    writer.write_event(Event::Start(owned))?;
                    if !text.is_empty() {
                        writer.write_event(Event::Text(BytesText::new(text)))?;
                    }
                    replacing = true;
                    seen.insert(ordinal);
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "t" => {
                ordinal += 1;
                if let Some(text) = replacements.get(&ordinal) {
                    let owned = start_with_space_preservation(empty, text);
                    writer.write_event(Event::Start(owned))?;
                    if !text.is_empty() {
                        writer.write_event(Event::Text(BytesText::new(text)))?;
                    }
                    writer.write_event(Event::End(BytesEnd::new(String::from_utf8_lossy(
                        empty.name().as_ref(),
                    ))))?;
                    seen.insert(ordinal);
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Text(_) | Event::CData(_) if replacing => {}
            Event::End(ref end) if local_name(end.name().as_ref()) == "t" && replacing => {
                writer.write_event(event.into_owned())?;
                replacing = false;
            }
            Event::Eof => break,
            _ => writer.write_event(event.into_owned())?,
        }
        buffer.clear();
    }
    if seen.len() != replacements.len() {
        let missing: Vec<u64> = replacements
            .keys()
            .filter(|ordinal| !seen.contains(ordinal))
            .copied()
            .collect();
        return Err(HcdError::InvalidBundle(format!(
            "source XML is missing mapped text ordinals {missing:?}"
        )));
    }
    Ok(())
}

fn start_with_space_preservation(start: &BytesStart<'_>, text: &str) -> BytesStart<'static> {
    let mut owned = start.to_owned();
    let preserve = text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace);
    let has_space = start
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .any(|attribute| attribute.key.as_ref() == b"xml:space");
    if preserve && !has_space {
        owned.push_attribute(("xml:space", "preserve"));
    }
    owned
}

fn local_name(name: &[u8]) -> &str {
    let local = name
        .iter()
        .rposition(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name);
    std::str::from_utf8(local).unwrap_or("")
}

fn safe_temp_name(part: &str) -> String {
    part.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn package_error(error: PackageError) -> HcdError {
    match error {
        PackageError::ResourceLimit(message) => HcdError::ResourceLimit(message),
        other => HcdError::InvalidBundle(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        hash_bytes, BundleWriter, ChunkSourceMap, HcdCapabilities, NodeMapEntry, SourceAnchor,
        SourceDescriptor,
    };

    #[test]
    fn original_source_policy_rejects_legacy_field_replacements() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Normal</w:t></w:r></w:p><w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:body></w:document>"#,
            ),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let source_hash = hash_file(&source).unwrap();
        let part = "word/document.xml".to_string();
        let safe = HashMap::from([(part.clone(), BTreeMap::from([(1, "Changed".into())]))]);
        let field = HashMap::from([(part, BTreeMap::from([(2, "Changed".into())]))]);
        verify_original_text_policy(&source, &source_hash, &safe).unwrap();
        assert!(
            matches!(verify_original_text_policy(&source, &source_hash, &field),
            Err(HcdError::Unsupported(message)) if message.contains("DOCX_SOURCE_TEXT_READ_ONLY"))
        );
        assert!(matches!(
            verify_original_text_policy(&source, &"0".repeat(64), &safe),
            Err(HcdError::SourceMismatch(_))
        ));
        let path = temp.path().join("legacy.hcd");
        let mut writer = BundleWriter::create(&path).unwrap();
        writer.write_styles("").unwrap();
        let normal = "n_00000000000000000000000000000001";
        let cached = "n_00000000000000000000000000000002";
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.into(),
            chunk_id: "c_00000000000000000000000000000001".into(),
            entries: vec![
                NodeMapEntry {
                    node_id: normal.into(),
                    node_hash: hash_bytes(b"Normal"),
                    source: test_anchor("word/document.xml", 1),
                },
                NodeMapEntry {
                    node_id: cached.into(),
                    node_hash: hash_bytes(b"1"),
                    source: test_anchor("word/document.xml", 2),
                },
            ],
        };
        let normal_hash = hash_bytes(b"Normal");
        let cached_hash = hash_bytes(b"1");
        writer.write_chunk(map.chunk_id.clone(), "body".into(), format!("<p><span data-hcd-id=\"{normal}\" data-hcd-node-hash=\"{normal_hash}\">Normal</span><span data-hcd-id=\"{cached}\" data-hcd-node-hash=\"{cached_hash}\">1</span></p>"), map, 1, false).unwrap();
        let mut manifest = test_manifest();
        manifest.source.sha256 = source_hash.clone();
        manifest.source.size_bytes = std::fs::metadata(&source).unwrap().len();
        writer.finish(manifest).unwrap();
        let bundle = Bundle::open(path).unwrap();
        let size = std::fs::metadata(&source).unwrap().len();
        let first_policy = source_read_only_policy(&source, &source_hash, size).unwrap();
        let second_policy = source_read_only_policy(&source, &source_hash, size).unwrap();
        assert_eq!(first_policy, second_policy);
        assert_eq!(
            legacy_read_only_nodes(&bundle, &source).unwrap(),
            HashSet::from([cached.to_string()])
        );
        let (_snapshot_dir, snapshot) = snapshot_docx_source(&source, &source_hash, size).unwrap();
        let mut changed = std::fs::read(&source).unwrap();
        changed[0] ^= 1;
        std::fs::write(&source, changed).unwrap();
        assert_eq!(hash_file(&snapshot).unwrap(), source_hash);
        assert!(matches!(
            source_read_only_policy(&source, &source_hash, size),
            Err(HcdError::SourceMismatch(_))
        ));
        assert!(matches!(
            legacy_read_only_nodes(&bundle, &source),
            Err(HcdError::SourceMismatch(_))
        ));
    }

    #[test]
    fn text_rewriter_uses_unicode_text_and_preserves_spaces() {
        let source =
            br#"<?xml version="1.0"?><w:p xmlns:w="x"><w:r><w:t>old</w:t><w:t/></w:r></w:p>"#;
        let replacements = BTreeMap::from([(1, "甲😀乙".to_string()), (2, " padded ".to_string())]);
        let mut output = Vec::new();
        let mut input = source.as_slice();
        rewrite_text_part(&mut input, &mut output, &replacements).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(xml.contains("甲😀乙"));
        assert!(xml.contains("xml:space=\"preserve\""));
        assert!(xml.contains(" padded "));
    }

    #[test]
    fn export_collection_keeps_only_changed_nodes_from_a_dirty_part() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle");
        let mut writer = BundleWriter::create(&bundle_path).unwrap();
        writer.write_styles("").unwrap();
        let first_id = "n_00000000000000000000000000000001";
        let second_id = "n_00000000000000000000000000000002";
        let first_hash = hash_bytes(b"unchanged");
        let second_hash = hash_bytes(b"changed");
        let html = format!(
            "<p><span data-hcd-id=\"{first_id}\" data-hcd-node-hash=\"{first_hash}\">unchanged</span><span data-hcd-id=\"{second_id}\" data-hcd-node-hash=\"{second_hash}\">changed</span></p>"
        );
        let part = "word/document.xml";
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000001".to_string(),
            entries: vec![
                NodeMapEntry {
                    node_id: first_id.to_string(),
                    node_hash: first_hash,
                    source: test_anchor(part, 1),
                },
                NodeMapEntry {
                    node_id: second_id.to_string(),
                    node_hash: second_hash,
                    source: test_anchor(part, 2),
                },
            ],
        };
        writer
            .write_chunk(
                map.chunk_id.clone(),
                "body".to_string(),
                html,
                map,
                1,
                false,
            )
            .unwrap();
        let manifest = writer.finish(test_manifest()).unwrap();
        let bundle = Bundle::open(bundle_path).unwrap();
        let dirty_parts = HashSet::from([part.to_string()]);
        let dirty_nodes = HashSet::from([second_id.to_string()]);

        let replacements =
            collect_text_by_part(&bundle, &manifest, &dirty_parts, &dirty_nodes).unwrap();

        assert_eq!(replacements[part].len(), 1);
        assert_eq!(replacements[part][&2], "changed");
        assert!(!replacements[part].contains_key(&1));
    }

    fn test_anchor(part: &str, ordinal: u64) -> SourceAnchor {
        SourceAnchor {
            part: part.to_string(),
            text_ordinal: ordinal,
            paragraph_id: None,
            text_id: None,
            node_kind: "text".to_string(),
            editable: true,
        }
    }

    fn test_manifest() -> HcdManifest {
        HcdManifest {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            storage_codec: hcd_core::StorageCodec::None,
            document_id: "test-document".to_string(),
            profile: "semantic-flow".to_string(),
            revision: 0,
            source: SourceDescriptor {
                format: "docx".to_string(),
                sha256: "0".repeat(64),
                size_bytes: 1,
            },
            root_hash: String::new(),
            annotation_root_hash: String::new(),
            annotation_href: None,
            index_prefix: String::new(),
            index_root_href: None,
            index_page_count: 0,
            chunk_count: 0,
            styles_href: "styles.css".to_string(),
            capabilities: HcdCapabilities::default(),
            fidelity: None,
            state: "IMPORTING".to_string(),
            warnings: Vec::new(),
        }
    }
}
