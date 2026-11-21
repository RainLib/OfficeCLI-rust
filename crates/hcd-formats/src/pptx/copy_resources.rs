//! Copy the slide-owned OPC parts behind a duplicated slide.
//!
//! Notes, charts and their embedded workbooks have separate identities in a
//! presentation. Sharing them between duplicated slides makes later native
//! edits affect both slides, and notes must point back to their own slide.
use super::*;
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct NoteSnapshot {
    changes: HashMap<String, NoteChanges>,
}

#[derive(Default)]
pub(super) struct NoteChanges {
    pub(super) source_hash: Option<String>,
    pub(super) text: BTreeMap<u64, String>,
    pub(super) insertions: Vec<InsertedPptxShape>,
    pub(super) runs: PptxRunEdits,
    pub(super) geometry: BTreeMap<u32, NativeShapeGeometry>,
    pub(super) alignments: BTreeMap<u32, PptxShapeAlignPatch>,
}

pub(super) struct SlideCopySource<'a> {
    pub part: &'a str,
    pub relationships: &'a [u8],
    pub notes: Option<&'a NoteSnapshot>,
    pub current_note: Option<&'a NoteChanges>,
}

impl NoteSnapshot {
    /// Reconstruct the note as it was when the page was copied, not as it is
    /// at export time. A copied page can outlive later note edits or deletion.
    pub(super) fn capture(bundle: &Bundle, source: &Path, revision: u64) -> Result<Self, HcdError> {
        let options = ExportOptions {
            revision: Some(revision),
            fidelity_report: None,
        };
        let (manifest, dirty_parts, dirty_nodes, _) =
            checked_export_state_with_restores(bundle, source, &options, RunFontSupport::Rewrites)?;
        let notes: HashSet<String> = dirty_parts
            .iter()
            .filter(|part| part.starts_with("ppt/notesSlides/"))
            .cloned()
            .collect();
        if notes.is_empty() {
            return Ok(Self::default());
        }
        let nodes: Vec<_> = collect_dirty_nodes(bundle, &manifest, &dirty_parts, &dirty_nodes)?
            .into_iter()
            .filter(|node| notes.contains(&node.source.part))
            .collect();
        let ids = nodes.iter().map(|node| node.node_id.clone()).collect();
        let fonts = collect_dirty_fonts(bundle, &manifest, &notes, &ids)?;
        let formats = collect_edited_run_formats(bundle, &manifest, &notes)?;
        let SlideObjectEdits {
            geometry,
            primitives,
            ..
        } = collect_edited_slide_objects(bundle, &manifest, &notes)?;
        let ShapeAlignRequests {
            native: alignments,
            created,
        } = collect_edited_shape_aligns(bundle, &manifest, &notes)?;
        if !primitives.is_empty() || !created.is_empty() {
            return Err(HcdError::Unsupported(
                "copying authored objects inside a speaker note is not supported".into(),
            ));
        }
        let mut changes: HashMap<String, NoteChanges> = HashMap::new();
        for node in nodes {
            if node.source.created_in_hcd {
                return Err(HcdError::Unsupported(
                    "copying authored text inside a speaker note is not supported".into(),
                ));
            }
            let note = changes.entry(node.source.part).or_default();
            note.text.insert(node.source.text_ordinal, node.text);
            if let Some(font) = fonts.get(&node.node_id) {
                note.runs
                    .fonts
                    .insert(node.source.text_ordinal, font.clone());
            }
            if let Some(format) = formats.get(&node.node_id) {
                note.runs
                    .formats
                    .insert(node.source.text_ordinal, format.clone());
            }
        }
        for (part, values) in geometry {
            changes.entry(part).or_default().geometry = values;
        }
        for (part, values) in alignments {
            changes.entry(part).or_default().alignments = values;
        }
        Ok(Self { changes })
    }
}

pub(super) struct CopyResources {
    used: HashSet<String>,
    next_names: HashMap<(String, String, String), u32>,
    uncompressed_bytes: u64,
    overrides: HashMap<String, String>,
    defaults: HashSet<String>,
    pub(super) type_children: Vec<AddedElement>,
    scratch: PathBuf,
    sequence: usize,
}

impl CopyResources {
    pub(super) fn new(
        archive: &mut StreamingOxmlArchive,
        scratch: &Path,
    ) -> Result<Self, HcdError> {
        let uncompressed_bytes = archive
            .entries()
            .iter()
            .map(|entry| entry.uncompressed_size)
            .sum();
        let used = archive
            .entries()
            .iter()
            .map(|entry| entry.name.clone())
            .collect();
        let types = archive
            .read_control_part("[Content_Types].xml", MAX_CONTROL_BYTES)
            .map_err(package_error)?;
        let mut reader = Reader::from_reader(types.as_slice());
        reader.config_mut().check_end_names = true;
        let mut overrides = HashMap::new();
        let mut defaults = HashSet::new();
        let mut buffer = Vec::new();
        loop {
            match reader
                .read_event_into(&mut buffer)
                .map_err(|error| HcdError::InvalidBundle(format!("content types XML: {error}")))?
            {
                Event::Start(ref element) | Event::Empty(ref element)
                    if local_name(element.name().as_ref()) == "Override" =>
                {
                    let name = checked_attribute(element, "PartName")?.ok_or_else(|| {
                        HcdError::InvalidBundle("content type override has no part name".into())
                    })?;
                    let content_type =
                        checked_attribute(element, "ContentType")?.ok_or_else(|| {
                            HcdError::InvalidBundle("content type override has no type".into())
                        })?;
                    overrides.insert(name.trim_start_matches('/').to_string(), content_type);
                }
                Event::Start(ref element) | Event::Empty(ref element)
                    if local_name(element.name().as_ref()) == "Default" =>
                {
                    if let Some(extension) = checked_attribute(element, "Extension")? {
                        defaults.insert(extension.to_ascii_lowercase());
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
        Ok(Self {
            used,
            next_names: HashMap::new(),
            uncompressed_bytes,
            overrides,
            defaults,
            type_children: Vec::new(),
            scratch: scratch.to_path_buf(),
            sequence: 0,
        })
    }

    fn reserve(&mut self, old: &str) -> Result<String, HcdError> {
        let (folder, file) = old.rsplit_once('/').unwrap_or(("", old));
        let (stem, extension) = file
            .rsplit_once('.')
            .ok_or_else(|| HcdError::InvalidBundle("copied part has no extension".into()))?;
        let prefix = stem.trim_end_matches(|c: char| c.is_ascii_digit());
        let prefix = if prefix.is_empty() { stem } else { prefix };
        let key = (
            folder.to_string(),
            prefix.to_string(),
            extension.to_string(),
        );
        let start = self.next_names.get(&key).copied().unwrap_or(1);
        for index in start..=1_000_000u32 {
            let name = if folder.is_empty() {
                format!("{prefix}{index}.{extension}")
            } else {
                format!("{folder}/{prefix}{index}.{extension}")
            };
            let rels = relationship_part(&name)?;
            if self.used.contains(&name) || self.used.contains(&rels) {
                continue;
            }
            self.used.insert(name.clone());
            self.used.insert(rels);
            self.next_names.insert(key, index.saturating_add(1));
            if let Some(content_type) = self.overrides.get(old) {
                self.type_children.push(AddedElement {
                    name: "Override",
                    attributes: vec![
                        ("PartName".into(), format!("/{name}")),
                        ("ContentType".into(), content_type.clone()),
                    ],
                });
            } else if !self.defaults.contains(&extension.to_ascii_lowercase()) {
                return Err(HcdError::InvalidBundle(format!(
                    "copied part {old} has no content type"
                )));
            }
            return Ok(name);
        }
        Err(HcdError::ResourceLimit(
            "no free PPTX part name for copied slide resources".into(),
        ))
    }

    fn path(&mut self) -> PathBuf {
        self.sequence += 1;
        self.scratch
            .join(format!("slide-resource-{}", self.sequence))
    }

    pub(super) fn copy_slide(
        &mut self,
        archive: &mut StreamingOxmlArchive,
        source: SlideCopySource<'_>,
        destination: &str,
        removed_parts: &BTreeSet<String>,
        additions: &mut HashMap<String, PathBuf>,
    ) -> Result<Vec<u8>, HcdError> {
        let SlideCopySource {
            part: original,
            relationships: root_rels,
            notes,
            current_note,
        } = source;
        let mut mapping = HashMap::from([(original.to_string(), destination.to_string())]);
        let mut pending = VecDeque::from([(
            original.to_string(),
            destination.to_string(),
            Some(root_rels.to_vec()),
        )]);
        let mut slide_rels = None;
        let mut applied_note = false;
        while let Some((old, new, root)) = pending.pop_front() {
            let rels_part = relationship_part(&old)?;
            let bytes = match root {
                Some(bytes) => bytes,
                None if archive.contains(&rels_part) => archive
                    .read_control_part(&rels_part, MAX_CONTROL_BYTES)
                    .map_err(package_error)?,
                None => continue,
            };
            let mut replacements = HashMap::new();
            let mut ids = HashSet::new();
            for relationship in read_pptx_relationships(&bytes, &old, &rels_part)? {
                if relationship.id.is_empty() || !ids.insert(relationship.id.clone()) {
                    return Err(HcdError::InvalidBundle(format!(
                        "{rels_part} has a missing or duplicate relationship id"
                    )));
                }
                let Some(target) = relationship.target else {
                    continue;
                };
                let renamed = if let Some(mapped) = mapping.get(&target) {
                    Some(mapped.clone())
                } else if owned_resource(&target, &relationship.kind) {
                    if !archive.contains(&target) {
                        return Err(HcdError::InvalidBundle(format!(
                            "copied slide resource {target} is missing"
                        )));
                    }
                    let size = archive
                        .entry(&target)
                        .expect("checked entry")
                        .uncompressed_size;
                    self.uncompressed_bytes = self
                        .uncompressed_bytes
                        .checked_add(size)
                        .filter(|size| *size <= oxml::package::MAX_UNCOMPRESSED_BYTES)
                        .ok_or_else(|| {
                            HcdError::ResourceLimit(
                                "copied PPTX resources exceed the package size limit".into(),
                            )
                        })?;
                    let mapped = self.reserve(&target)?;
                    let path = self.path();
                    let mut output = File::create(&path)?;
                    let note = if relationship.kind.ends_with("/notesSlide") {
                        applied_note = true;
                        if current_note
                            .and_then(|note| note.source_hash.as_deref())
                            .is_some_and(|hash| hash != hash_bytes(target.as_bytes()))
                        {
                            return Err(HcdError::InvalidBundle(
                                "copied notes do not belong to the source slide".into(),
                            ));
                        }
                        current_note
                            .or_else(|| notes.and_then(|snapshot| snapshot.changes.get(&target)))
                    } else {
                        None
                    };
                    archive
                        .with_part(&target, |input| {
                            if let Some(note) = note {
                                rewrite_text_part(
                                    input,
                                    &mut output,
                                    &note.text,
                                    &note.insertions,
                                    &note.geometry,
                                    &note.runs,
                                    &note.alignments,
                                )
                                .map_err(|error| PackageError::ReadPartError(error.to_string()))
                            } else {
                                std::io::copy(input, &mut output)
                                    .map(|_| ())
                                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
                            }
                        })
                        .map_err(package_error)?;
                    additions.insert(mapped.clone(), path);
                    mapping.insert(target.clone(), mapped.clone());
                    pending.push_back((target, mapped.clone(), None));
                    Some(mapped)
                } else if shared_resource(&target, &relationship.kind)
                    && !removed_parts.contains(&target)
                {
                    None
                } else {
                    return Err(HcdError::Unsupported(format!(
                        "PPTX slide copy cannot duplicate {original}: its relationship {} points at {target}, which cannot safely be copied", relationship.id
                    )));
                };
                if let Some(target) = renamed {
                    replacements.insert(relationship.id, relative_target(&new, &target)?);
                }
            }
            let rewritten = rewrite_targets(&bytes, &replacements, &rels_part)?;
            if old == original {
                slide_rels = Some(rewritten);
            } else {
                let destination_rels = relationship_part(&new)?;
                let path = self.path();
                std::fs::write(&path, rewritten)?;
                additions.insert(destination_rels, path);
            }
        }
        if current_note.is_some() && !applied_note {
            return Err(HcdError::InvalidBundle(
                "copied slide's editable notes have no native source relationship".into(),
            ));
        }
        slide_rels
            .ok_or_else(|| HcdError::InvalidBundle("missing copied slide relationships".into()))
    }
}

fn owned_resource(target: &str, kind: &str) -> bool {
    // OPC does not require charts or workbooks to live in their conventional
    // directories. Classify by relationship type, not by a path prefix.
    !target.ends_with(".rels")
        && !target.starts_with("_rels/")
        && !target.contains("/_rels/")
        && target != "[Content_Types].xml"
        && target != "ppt/presentation.xml"
        && matches!(
            kind.rsplit('/').next(),
            Some(
                "notesSlide"
                    | "chart"
                    | "chartEx"
                    | "chartStyle"
                    | "chartColorStyle"
                    | "chartUserShapes"
                    | "package"
                    | "oleObject"
            )
        )
}

fn shared_resource(target: &str, kind: &str) -> bool {
    [
        "ppt/slideLayouts/",
        "ppt/media/",
        "ppt/fonts/",
        "ppt/notesMasters/",
        "ppt/slideMasters/",
        "ppt/theme/",
    ]
    .iter()
    .any(|prefix| target.starts_with(prefix))
        || kind.ends_with("/slide") && slide_file_name(target).is_ok()
}

pub(super) fn relationship_part(owner: &str) -> Result<String, HcdError> {
    let (folder, file) = owner.rsplit_once('/').unwrap_or(("", owner));
    if file.is_empty() {
        return Err(HcdError::InvalidBundle("invalid relationship owner".into()));
    }
    Ok(if folder.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{folder}/_rels/{file}.rels")
    })
}

fn relative_target(owner: &str, target: &str) -> Result<String, HcdError> {
    let folder = owner.rsplit_once('/').map_or("", |(folder, _)| folder);
    let from: Vec<_> = if folder.is_empty() {
        Vec::new()
    } else {
        folder.split('/').collect()
    };
    let to: Vec<_> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut path = vec![".."; from.len() - common];
    path.extend_from_slice(&to[common..]);
    Ok(path.join("/"))
}

fn rewrite_targets(
    source: &[u8],
    replacements: &HashMap<String, String>,
    part: &str,
) -> Result<Vec<u8>, HcdError> {
    if replacements.is_empty() {
        return Ok(source.to_vec());
    }
    let mut reader = Reader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(Vec::new());
    let mut buffer = Vec::new();
    let mut changed = HashSet::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("{part} XML: {error}")))?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "Relationship" =>
            {
                let id = checked_attribute(element, "Id")?.unwrap_or_default();
                if let Some(target) = replacements.get(&id) {
                    let mut rewritten = element.to_owned();
                    rewritten.clear_attributes();
                    for attribute in element.attributes().with_checks(false) {
                        let attribute = attribute.map_err(|error| {
                            HcdError::InvalidBundle(format!("{part} attribute: {error}"))
                        })?;
                        if local_name(attribute.key.as_ref()) == "Target" {
                            let escaped = escape_attribute(target);
                            rewritten.push_attribute((attribute.key.as_ref(), escaped.as_bytes()));
                            changed.insert(id.clone());
                        } else {
                            rewritten
                                .push_attribute((attribute.key.as_ref(), attribute.value.as_ref()));
                        }
                    }
                    writer.write_event(if matches!(event, Event::Empty(_)) {
                        Event::Empty(rewritten)
                    } else {
                        Event::Start(rewritten)
                    })?;
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Eof => break,
            other => writer.write_event(other.into_owned())?,
        }
        buffer.clear();
    }
    if changed.len() != replacements.len() {
        return Err(HcdError::InvalidBundle(format!(
            "{part} is missing a copied relationship"
        )));
    }
    Ok(writer.into_inner())
}
