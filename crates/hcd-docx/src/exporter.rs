use hcd_core::{
    extract_html_font_nodes, extract_html_text_nodes, hash_file, Bundle, FidelityLevel,
    FidelityReport, HcdError, HcdManifest, HtmlFontNode, NodeMapEntry, HCD_SCHEMA_VERSION,
    MAX_REVISION,
};
use oxml::{PackageError, StreamingOxmlArchive, StreamingOxmlRewriter};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    pub revision: Option<u64>,
    pub fidelity_report: Option<PathBuf>,
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
    let source = source.as_ref();
    let target = target.as_ref();
    let actual_source_hash = hash_file(source)?;
    if actual_source_hash != head.source.sha256 {
        return Err(HcdError::SourceMismatch(format!(
            "expected source {}, actual {actual_source_hash}",
            head.source.sha256
        )));
    }

    let revision_manifest = manifest_at_revision(&bundle, &head, revision)?;
    let (dirty_parts, dirty_node_ids) = dirty_state_through(&bundle, revision)?;
    reject_image_source_export(&bundle, &revision_manifest, &dirty_node_ids)?;
    let updates_by_part =
        collect_text_by_part(&bundle, &revision_manifest, &dirty_parts, &dirty_node_ids)?;
    let pinned_faces = updates_by_part
        .values()
        .flat_map(|updates| updates.values())
        .filter(|update| update.font.is_some())
        .count();

    let temp_dir = tempfile::tempdir()?;
    let mut replacement_paths = HashMap::new();
    if !updates_by_part.is_empty() {
        let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
        for (part, replacements) in &updates_by_part {
            if !archive.contains(part) {
                return Err(HcdError::InvalidBundle(format!(
                    "source part {part} referenced by HCD is missing"
                )));
            }
            let replacement_path = temp_dir.path().join(safe_temp_name(part));
            let output = std::fs::File::create(&replacement_path)?;
            archive
                .with_part(part, |reader| {
                    rewrite_text_part(reader, BufWriter::new(output), replacements)
                        .map_err(|error| PackageError::ReadPartError(error.to_string()))
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
        preserved: {
            let mut preserved = vec![
                "unmodified OOXML entries copied as raw compressed payloads".to_string(),
                "paragraph and run formatting".to_string(),
                "relationships, media, numbering, headers and footers".to_string(),
            ];
            if pinned_faces > 0 {
                preserved.push(format!(
                    "run fonts pinned by text.font on {pinned_faces} mapped node(s)"
                ));
            }
            preserved
        },
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

fn reject_image_source_export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_node_ids: &HashSet<String>,
) -> Result<(), HcdError> {
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

fn manifest_at_revision(
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
    manifest.annotation_href =
        (manifest.annotation_root_hash != hcd_core::hash_bytes(b"[]")).then(|| {
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

fn dirty_state_through(
    bundle: &Bundle,
    revision: u64,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    let mut dirty_parts = HashSet::new();
    let mut dirty_nodes = HashSet::new();
    for current in 1..=revision {
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

/// What a revision asks one mapped source text to become: new text, and the
/// script faces a `text.font` patch pinned onto the node when it was pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TextUpdate {
    text: String,
    font: Option<HtmlFontNode>,
}

fn collect_text_by_part(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty_parts: &HashSet<String>,
    dirty_node_ids: &HashSet<String>,
) -> Result<HashMap<String, BTreeMap<u64, TextUpdate>>, HcdError> {
    let mut output: HashMap<String, BTreeMap<u64, TextUpdate>> = HashMap::new();
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
            let html_fonts = extract_html_font_nodes(&html)?;
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
                let font = html_fonts.get(&entry.node_id).cloned();
                found.insert(entry.node_id.clone());
                insert_entry(&mut output, entry, text, font)?;
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

fn insert_entry(
    output: &mut HashMap<String, BTreeMap<u64, TextUpdate>>,
    entry: NodeMapEntry,
    text: &str,
    font: Option<HtmlFontNode>,
) -> Result<(), HcdError> {
    let update = TextUpdate {
        text: text.to_string(),
        font,
    };
    let part = output.entry(entry.source.part.clone()).or_default();
    if let Some(previous) = part.insert(entry.source.text_ordinal, update.clone()) {
        if previous != update {
            return Err(HcdError::InvalidBundle(format!(
                "source ordinal {} in {} maps to multiple values",
                entry.source.text_ordinal, entry.source.part
            )));
        }
    }
    Ok(())
}

/// The most XML events one run may hold before the rewriter stops instead of
/// growing its look-ahead buffer without bound.
const MAX_RUN_EVENTS: usize = 100_000;

/// Ordinal bookkeeping shared by the run-capturing path and the plain path.
struct RewriteState<'a> {
    ordinal: u64,
    updates: &'a BTreeMap<u64, TextUpdate>,
    seen: BTreeSet<u64>,
    pinned: BTreeSet<u64>,
}

/// One `w:r` held in memory until its first text element arrives: run properties
/// come *before* `w:t`, so a pinned face has to be written into properties the
/// stream had already passed.
struct RunCapture {
    events: Vec<Event<'static>>,
    depth: usize,
}

impl RunCapture {
    fn opened(start: Event<'static>) -> Self {
        Self {
            events: vec![start],
            depth: 1,
        }
    }

    /// Collects one event and returns the finished run once its first text
    /// element or its own close tag arrives.
    fn accept(&mut self, event: Event<'static>) -> Result<Option<Vec<Event<'static>>>, HcdError> {
        let finished = match &event {
            Event::Eof => {
                return Err(HcdError::InvalidBundle(
                    "source XML ends inside an unclosed run".to_string(),
                ))
            }
            Event::Start(start) => {
                self.depth += 1;
                local_name(start.name().as_ref()) == "t"
            }
            Event::Empty(empty) => local_name(empty.name().as_ref()) == "t",
            Event::End(end) => {
                self.depth -= 1;
                self.depth == 0 || local_name(end.name().as_ref()) == "t"
            }
            _ => false,
        };
        self.events.push(event);
        if !finished && self.events.len() <= MAX_RUN_EVENTS {
            return Ok(None);
        }
        Ok(Some(std::mem::take(&mut self.events)))
    }
}

fn rewrite_text_part(
    source: &mut dyn Read,
    output: impl Write,
    replacements: &BTreeMap<u64, TextUpdate>,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut state = RewriteState {
        ordinal: 0,
        updates: replacements,
        seen: BTreeSet::new(),
        pinned: BTreeSet::new(),
    };
    let mut replacing = false;
    let mut run: Option<RunCapture> = None;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("source XML parse error: {error}")))?;
        if let Some(mut capture) = run.take() {
            let finished = capture.accept(event.into_owned())?;
            if let Some(events) = finished {
                flush_run(&mut writer, events, &mut state, &mut replacing)?;
            } else {
                run = Some(capture);
            }
            buffer.clear();
            continue;
        }
        match event {
            Event::Start(ref start) if is_word_run(start.name().as_ref()) => {
                run = Some(RunCapture::opened(event.into_owned()));
            }
            Event::Start(ref start) if local_name(start.name().as_ref()) == "t" => {
                state.ordinal += 1;
                let ordinal = state.ordinal;
                if let Some(update) = replacements.get(&ordinal) {
                    let owned = start_with_space_preservation(start, &update.text);
                    writer.write_event(Event::Start(owned))?;
                    if !update.text.is_empty() {
                        writer.write_event(Event::Text(BytesText::new(&update.text)))?;
                    }
                    replacing = true;
                    state.seen.insert(ordinal);
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "t" => {
                state.ordinal += 1;
                let ordinal = state.ordinal;
                if let Some(update) = replacements.get(&ordinal) {
                    let owned = start_with_space_preservation(empty, &update.text);
                    writer.write_event(Event::Start(owned))?;
                    if !update.text.is_empty() {
                        writer.write_event(Event::Text(BytesText::new(&update.text)))?;
                    }
                    writer.write_event(Event::End(BytesEnd::new(String::from_utf8_lossy(
                        empty.name().as_ref(),
                    ))))?;
                    state.seen.insert(ordinal);
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
    if state.seen.len() != replacements.len() {
        let missing: Vec<u64> = replacements
            .keys()
            .filter(|ordinal| !state.seen.contains(ordinal))
            .copied()
            .collect();
        return Err(HcdError::InvalidBundle(format!(
            "source XML is missing mapped text ordinals {missing:?}"
        )));
    }
    let unwritten: Vec<u64> = replacements
        .iter()
        .filter(|(_, update)| update.font.is_some())
        .map(|(ordinal, _)| *ordinal)
        .filter(|ordinal| !state.pinned.contains(ordinal))
        .collect();
    if !unwritten.is_empty() {
        return Err(HcdError::Unsupported(format!(
            "text.font pins a face onto text ordinals {unwritten:?} that this DOCX source has no writable run for; omit --source to use the pure-Rust semantic export, which applies the face"
        )));
    }
    Ok(())
}

/// Writes one captured run out: the revision's text for its first mapped element,
/// plus the script faces the node was pinned to.
fn flush_run<W: Write>(
    writer: &mut Writer<W>,
    mut events: Vec<Event<'static>>,
    state: &mut RewriteState<'_>,
    replacing: &mut bool,
) -> Result<(), HcdError> {
    let prefix = match events.first() {
        Some(Event::Start(start)) => name_prefix(start.name().as_ref()).to_string(),
        _ => {
            return Err(HcdError::InvalidBundle(
                "captured source run has no start tag".to_string(),
            ))
        }
    };
    // A capture ends at the run's first text element or at its close tag, so only
    // the last event can be the element this revision changed.
    let self_closed = match events.last() {
        Some(Event::Start(start)) if local_name(start.name().as_ref()) == "t" => false,
        Some(Event::Empty(empty)) if local_name(empty.name().as_ref()) == "t" => true,
        _ => return write_events(writer, events),
    };
    state.ordinal += 1;
    let ordinal = state.ordinal;
    let Some(update) = state.updates.get(&ordinal).cloned() else {
        return write_events(writer, events);
    };
    state.seen.insert(ordinal);
    if let Some(font) = update.font.as_ref() {
        pin_run_fonts(&mut events, &prefix, font)?;
        state.pinned.insert(ordinal);
    }
    let TextUpdate { text, .. } = update;
    let (owned, name) = match events.last() {
        Some(Event::Start(start)) => (
            start_with_space_preservation(start, &text),
            String::from_utf8_lossy(start.name().as_ref()).into_owned(),
        ),
        Some(Event::Empty(empty)) => (
            start_with_space_preservation(empty, &text),
            String::from_utf8_lossy(empty.name().as_ref()).into_owned(),
        ),
        _ => {
            return Err(HcdError::InvalidBundle(
                "captured source run has no text element".to_string(),
            ))
        }
    };
    // The rewritten element is written after the rest of the run, so it never
    // has to outlive this call.
    events.pop();
    write_events(writer, events)?;
    writer.write_event(Event::Start(owned))?;
    if !text.is_empty() {
        writer.write_event(Event::Text(BytesText::new(&text)))?;
    }
    if self_closed {
        writer.write_event(Event::End(BytesEnd::new(name)))?;
    } else {
        // The element stays open, so its original content and close tag keep
        // arriving on the main stream.
        *replacing = true;
    }
    Ok(())
}

fn write_events<W: Write>(
    writer: &mut Writer<W>,
    events: Vec<Event<'static>>,
) -> Result<(), HcdError> {
    for event in events {
        writer.write_event(event)?;
    }
    Ok(())
}

/// Writes the pinned faces into the run's properties, creating `w:rPr` and
/// `w:rFonts` when the run has none. Word resolves a theme attribute before the
/// literal family of the same script, so a pinned slot drops its theme attribute
/// along with the family it replaces; slots the patch left alone are kept.
fn pin_run_fonts(
    events: &mut Vec<Event<'static>>,
    prefix: &str,
    font: &HtmlFontNode,
) -> Result<(), HcdError> {
    let properties = qualified(prefix, "rPr");
    let fonts = qualified(prefix, "rFonts");
    let mut found: Option<(usize, bool)> = None;
    let mut depth = 1usize;
    for (index, event) in events.iter().enumerate().skip(1) {
        match event {
            Event::Start(start) if depth == 1 && start.name().as_ref() == properties.as_bytes() => {
                found = Some((index, false));
                break;
            }
            Event::Empty(empty) if depth == 1 && empty.name().as_ref() == properties.as_bytes() => {
                found = Some((index, true));
                break;
            }
            Event::Start(_) => depth += 1,
            Event::End(_) => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            break;
        }
    }
    let pinned = Event::Start(pinned_fonts_start(None, fonts.clone(), prefix, font));
    let closing = Event::End(BytesEnd::new(fonts.clone()));
    let properties_end = Event::End(BytesEnd::new(properties.clone()));
    match found {
        Some((index, false)) => match direct_child(events, index, &fonts) {
            Some(child) => {
                let existing =
                    std::mem::replace(&mut events[child], Event::Text(BytesText::new("")));
                let self_closed = matches!(existing, Event::Empty(_));
                let merged = Event::Start(pinned_fonts_start(
                    Some(&existing),
                    fonts.clone(),
                    prefix,
                    font,
                ));
                let replacement = if self_closed {
                    vec![merged, closing]
                } else {
                    vec![merged]
                };
                events.splice(child..child + 1, replacement);
                Ok(())
            }
            None => {
                events.splice(index + 1..index + 1, vec![pinned, closing]);
                Ok(())
            }
        },
        Some((index, true)) => {
            events.splice(
                index..index + 1,
                vec![
                    Event::Start(BytesStart::new(properties)),
                    pinned,
                    closing,
                    properties_end,
                ],
            );
            Ok(())
        }
        None => {
            events.splice(
                1..1,
                vec![
                    Event::Start(BytesStart::new(properties)),
                    pinned,
                    closing,
                    properties_end,
                ],
            );
            Ok(())
        }
    }
}

/// The index of a parent element's direct child with this name, if it has one.
fn direct_child(events: &[Event<'static>], parent: usize, name: &str) -> Option<usize> {
    let mut depth = 1usize;
    for (index, event) in events.iter().enumerate().skip(parent + 1) {
        match event {
            Event::Start(start) if depth == 1 && start.name().as_ref() == name.as_bytes() => {
                return Some(index)
            }
            Event::Empty(empty) if depth == 1 && empty.name().as_ref() == name.as_bytes() => {
                return Some(index)
            }
            Event::Start(_) => depth += 1,
            Event::End(_) => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return None;
        }
    }
    None
}

/// The `w:rFonts` element a pinned face becomes, keeping the slots it did not name.
fn pinned_fonts_start(
    existing: Option<&Event<'static>>,
    name: String,
    prefix: &str,
    font: &HtmlFontNode,
) -> BytesStart<'static> {
    let mut start = BytesStart::new(name);
    let dropped = dropped_font_attributes(font);
    if let Some(Event::Start(existing) | Event::Empty(existing)) = existing {
        for attribute in existing.attributes().with_checks(false) {
            let Ok(attribute) = attribute else { continue };
            let Ok(key) = std::str::from_utf8(attribute.key.as_ref()) else {
                continue;
            };
            if dropped
                .iter()
                .any(|drop| local_name(key.as_bytes()) == *drop)
            {
                continue;
            }
            let Ok(value) = attribute.unescape_value() else {
                continue;
            };
            start.push_attribute((key, value.as_ref()));
        }
    }
    if let Some(latin) = font.latin.as_deref() {
        start.push_attribute((qualified(prefix, "ascii").as_str(), latin));
        start.push_attribute((qualified(prefix, "hAnsi").as_str(), latin));
    }
    if let Some(east_asia) = font.east_asia.as_deref() {
        start.push_attribute((qualified(prefix, "eastAsia").as_str(), east_asia));
    }
    if let Some(bidi) = font.bidi.as_deref() {
        start.push_attribute((qualified(prefix, "cs").as_str(), bidi));
    }
    start
}

/// Attributes a pinned slot supersedes, theme attributes included because Word
/// prefers them over a literal family.
fn dropped_font_attributes(font: &HtmlFontNode) -> Vec<&'static str> {
    let mut dropped = vec!["hint"];
    if font.latin.is_some() {
        dropped.extend(["ascii", "hAnsi", "asciiTheme", "hAnsiTheme"]);
    }
    if font.east_asia.is_some() {
        dropped.extend(["eastAsia", "eastAsiaTheme"]);
    }
    if font.bidi.is_some() {
        dropped.extend(["cs", "cstheme"]);
    }
    dropped
}

/// A Word run is `w:r`. Another prefix with the same local name (the mathematical
/// `m:r`, say) carries different run properties, so it keeps streaming untouched.
fn is_word_run(name: &[u8]) -> bool {
    local_name(name) == "r" && name_prefix(name) == "w"
}

fn name_prefix(name: &[u8]) -> &str {
    let raw = std::str::from_utf8(name).unwrap_or("");
    match raw.rfind(':') {
        Some(index) => &raw[..index],
        None => "",
    }
}

fn qualified(prefix: &str, local: &str) -> String {
    if prefix.is_empty() {
        local.to_string()
    } else {
        format!("{prefix}:{local}")
    }
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
    fn text_rewriter_uses_unicode_text_and_preserves_spaces() {
        let source =
            br#"<?xml version="1.0"?><w:p xmlns:w="x"><w:r><w:t>old</w:t><w:t/></w:r></w:p>"#;
        let replacements =
            BTreeMap::from([(1, update("甲😀乙", None)), (2, update(" padded ", None))]);
        let mut output = Vec::new();
        let mut input = source.as_slice();
        rewrite_text_part(&mut input, &mut output, &replacements).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(xml.contains("甲😀乙"));
        assert!(xml.contains("xml:space=\"preserve\""));
        assert!(xml.contains(" padded "));
    }

    #[test]
    fn a_pinned_face_replaces_the_run_fonts_and_keeps_the_rest() {
        let source = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsi="Calibri" w:eastAsia="宋体" w:hint="eastAsia"/><w:b/><w:sz w:val="22"/></w:rPr><w:t>old</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Other"/></w:rPr><w:t>untouched</w:t></w:r></w:p></w:body></w:document>"#;
        let replacements = BTreeMap::from([(
            1,
            update(
                "pinned",
                Some(HtmlFontNode {
                    latin: Some("Brand Serif".to_string()),
                    east_asia: Some("Brand Gothic".to_string()),
                    bidi: None,
                }),
            ),
        )]);
        let mut output = Vec::new();
        let mut input = source.as_bytes();
        rewrite_text_part(&mut input, &mut output, &replacements).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(xml.contains("w:ascii=\"Brand Serif\""), "{xml}");
        assert!(xml.contains("w:hAnsi=\"Brand Serif\""), "{xml}");
        assert!(xml.contains("w:eastAsia=\"Brand Gothic\""), "{xml}");
        // the pinned slots' theme attribute, old family, and script hint are gone
        assert!(!xml.contains("minorHAnsi"), "{xml}");
        assert!(!xml.contains("宋体"), "{xml}");
        assert!(!xml.contains("w:hint"), "{xml}");
        assert!(!xml.contains("cs="), "{xml}");
        // untouched properties of the same run survive, and so does the other run
        assert!(xml.contains("<w:b"), "{xml}");
        assert!(xml.contains("w:sz w:val=\"22\""), "{xml}");
        assert!(xml.contains(">pinned</w:t>"), "{xml}");
        assert!(xml.contains("w:ascii=\"Other\""), "{xml}");
        assert!(xml.contains(">untouched</w:t>"), "{xml}");
        assert_eq!(xml.matches("<w:rPr>").count(), 2, "{xml}");
        assert_eq!(xml.matches("<w:rFonts").count(), 2, "{xml}");
    }

    #[test]
    fn a_pinned_face_creates_run_properties_when_the_run_has_none() {
        let source = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>old</w:t></w:r></w:p></w:body></w:document>"#;
        let replacements = BTreeMap::from([(
            1,
            update(
                "old",
                Some(HtmlFontNode {
                    latin: None,
                    east_asia: None,
                    bidi: Some("Brand Naskh".to_string()),
                }),
            ),
        )]);
        let mut output = Vec::new();
        let mut input = source.as_bytes();
        rewrite_text_part(&mut input, &mut output, &replacements).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(
            xml.contains("<w:rPr><w:rFonts w:cs=\"Brand Naskh\"></w:rFonts></w:rPr><w:t>old</w:t>"),
            "{xml}"
        );
        assert!(xml.contains(">old</w:t>"), "{xml}");
    }

    #[test]
    fn a_self_closed_run_property_element_gains_the_pinned_fonts() {
        let source = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr/><w:t>old</w:t></w:r></w:p></w:body></w:document>"#;
        let replacements = BTreeMap::from([(
            1,
            update(
                "old",
                Some(HtmlFontNode {
                    latin: Some("Brand Serif".to_string()),
                    east_asia: None,
                    bidi: None,
                }),
            ),
        )]);
        let mut output = Vec::new();
        let mut input = source.as_bytes();
        rewrite_text_part(&mut input, &mut output, &replacements).unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(
            xml.contains(
                "<w:rPr><w:rFonts w:ascii=\"Brand Serif\" w:hAnsi=\"Brand Serif\"></w:rFonts></w:rPr>"
            ),
            "{xml}"
        );
    }

    #[test]
    fn a_pinned_face_outside_a_run_is_reported_not_dropped() {
        let source = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:t>old</w:t></w:p></w:body></w:document>"#;
        let replacements = BTreeMap::from([(
            1,
            update(
                "pinned",
                Some(HtmlFontNode {
                    latin: Some("Brand Serif".to_string()),
                    east_asia: None,
                    bidi: None,
                }),
            ),
        )]);
        let mut output = Vec::new();
        let mut input = source.as_bytes();
        let error = rewrite_text_part(&mut input, &mut output, &replacements)
            .expect_err("a face with no run to carry it must not be dropped silently");
        assert!(error.to_string().contains("no writable run"), "{error}");
        // the text itself still went through
        let xml = String::from_utf8(output).unwrap();
        assert!(xml.contains(">pinned</w:t>"), "{xml}");
    }

    #[test]
    fn an_unclosed_run_is_an_error_instead_of_a_truncated_part() {
        let source = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/>"#;
        let replacements = BTreeMap::from([(1, update("new", None))]);
        let mut output = Vec::new();
        let mut input = source.as_bytes();
        let error = rewrite_text_part(&mut input, &mut output, &replacements)
            .expect_err("a run left open at end of input is broken source XML");
        assert!(error.to_string().contains("unclosed run"), "{error}");
    }

    fn update(text: &str, font: Option<HtmlFontNode>) -> TextUpdate {
        TextUpdate {
            text: text.to_string(),
            font,
        }
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
        assert_eq!(replacements[part][&2].text, "changed");
        assert!(replacements[part][&2].font.is_none());
        assert!(!replacements[part].contains_key(&1));
    }

    #[test]
    fn a_pinned_dirty_node_is_collected_with_its_faces() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle");
        let mut writer = BundleWriter::create(&bundle_path).unwrap();
        writer.write_styles("").unwrap();
        let node_id = "n_00000000000000000000000000000001";
        let node_hash = hash_bytes(b"hello");
        let html = format!(
            "<p><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">hello</span></p>"
        );
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000001".to_string(),
            entries: vec![NodeMapEntry {
                node_id: node_id.to_string(),
                node_hash: node_hash.clone(),
                source: test_anchor("word/document.xml", 1),
            }],
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
        writer.finish(test_manifest()).unwrap();

        let bundle = Bundle::open(&bundle_path).unwrap();
        hcd_core::apply_patch(
            &bundle,
            &hcd_core::PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_37.to_string(),
                document_id: "test-document".to_string(),
                patch_id: "font-1".to_string(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![hcd_core::PatchOperation::TextFont {
                    node_id: node_id.to_string(),
                    font: hcd_core::FontPatch {
                        latin: Some("Demo Serif".to_string()),
                        east_asia: None,
                        bidi: None,
                    },
                    precondition: hcd_core::NodePrecondition { node_hash },
                }],
            },
            0,
        )
        .unwrap();

        let manifest = bundle.manifest().unwrap();
        let dirty_nodes = HashSet::from([node_id.to_string()]);
        let dirty_parts = HashSet::from(["word/document.xml".to_string()]);
        let collected =
            collect_text_by_part(&bundle, &manifest, &dirty_parts, &dirty_nodes).unwrap();
        let update = &collected["word/document.xml"][&1];
        assert_eq!(update.text, "hello");
        let font = update
            .font
            .as_ref()
            .expect("a pinned node carries its faces");
        assert_eq!(font.latin.as_deref(), Some("Demo Serif"));
        assert_eq!(font.east_asia, None);
        assert_eq!(font.bidi, None);
    }

    fn test_anchor(part: &str, ordinal: u64) -> SourceAnchor {
        SourceAnchor {
            source_cell_ref: None,
            created_in_hcd: false,
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
            theme_revision_id: None,
            capabilities: HcdCapabilities::default(),
            fidelity: None,
            state: "IMPORTING".to_string(),
            warnings: Vec::new(),
        }
    }
}
