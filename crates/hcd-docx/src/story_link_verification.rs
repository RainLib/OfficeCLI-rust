//! Read-only verification for source-preserving story-link export.
//! The snapshots must be used for all subsequent package reads.
use crate::{
    import_docx, story_link_xml::plan_source_story_link_reference_from_base, ImportOptions,
    SourceStoryReferenceRemoval,
};
use hcd_core::{Bundle, HcdError, NodeMapEntry};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;

pub struct VerifiedSourceStoryLink {
    // Keep both immutable inputs alive until the caller finishes its work.
    pub source_directory: tempfile::TempDir,
    pub bundle_snapshot: hcd_core::PortableSnapshot,
    pub source_path: PathBuf,
    pub removals: Vec<SourceStoryReferenceRemoval>,
    pub section_count: usize,
}

/// Inputs remain fixed for subsequent review; this does not publish a new
/// revision or authorize a change to an active collaboration room.
pub struct PreparedSourceStoryUnlink {
    pub source_directory: tempfile::TempDir,
    pub bundle_snapshot: hcd_core::PortableSnapshot,
    pub source_path: PathBuf,
    pub prepared: hcd_core::PreparedStoryUnlink,
}

impl PreparedSourceStoryUnlink {
    /// Read-only preflight. A publishing transaction must repeat the checks
    /// while holding the document lock and its collaboration ownership fence.
    pub fn verify_current(&self, bundle: &Bundle) -> Result<(), HcdError> {
        self.prepared.verify_current(bundle)?;
        let snapshot = Bundle::open(self.bundle_snapshot.directory.path())?;
        let manifest = snapshot.manifest()?;
        let live = bundle.manifest()?;
        if manifest.document_id != live.document_id
            || manifest.source != live.source
            || live.revision != self.prepared.revision
            || live.root_hash != self.prepared.root_hash
            || manifest.revision != self.prepared.revision
            || manifest.root_hash != self.prepared.root_hash
        {
            return Err(HcdError::SourceMismatch(
                "captured Word bundle changed after preparation".into(),
            ));
        }
        let length = std::fs::metadata(&self.source_path)?.len();
        if length != manifest.source.size_bytes
            || length > MAX_SOURCE_BYTES
            || hcd_core::hash_file(&self.source_path)? != manifest.source.sha256
        {
            return Err(HcdError::SourceMismatch(
                "captured Word source changed after preparation".into(),
            ));
        }
        let story = self
            .prepared
            .layout
            .stories
            .last()
            .ok_or_else(|| unsupported("independent story missing"))?;
        let mut archive = oxml::StreamingOxmlArchive::open(&self.source_path)
            .map_err(|error| unsupported(&format!("invalid source DOCX: {error}")))?;
        verify_source_story_unlink_destination(&mut archive, story)
    }
}

pub fn prepare_source_story_unlink<F, G>(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
    request: &hcd_core::FlowStoryUnlinkRequest,
    story: &hcd_core::FlowStory,
    new_reference_id: F,
    copy_extension: G,
) -> Result<PreparedSourceStoryUnlink, HcdError>
where
    F: FnMut(&hcd_core::InlineReference) -> Result<String, HcdError>,
    G: FnMut(&hcd_core::ExtensionNode) -> Result<hcd_core::ExtensionNode, HcdError>,
{
    let snapshot = hcd_core::create_portable_snapshot(bundle, Some(revision))?;
    let frozen = Bundle::open(snapshot.directory.path())?;
    let head = frozen.manifest()?;
    let (manifest, _) = hcd_core::manifest_at_revision(&frozen, &head, Some(revision))?;
    if manifest.source.format != "docx" {
        return Err(unsupported("independent story requires a DOCX source"));
    }
    if manifest.source.size_bytes > MAX_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(
            "source DOCX exceeds byte limit".into(),
        ));
    }
    let source_directory = tempfile::tempdir()?;
    let source_path = source_directory.path().join("source.docx");
    let input = std::fs::File::open(source)?;
    let mut output = std::fs::File::create(&source_path)?;
    let copied = std::io::copy(&mut input.take(manifest.source.size_bytes + 1), &mut output)?;
    drop(output);
    if copied != manifest.source.size_bytes
        || hcd_core::hash_file(&source_path)? != manifest.source.sha256
    {
        return Err(HcdError::SourceMismatch(
            "source DOCX does not match the imported bytes".into(),
        ));
    }
    let mut archive = oxml::StreamingOxmlArchive::open(&source_path)
        .map_err(|error| unsupported(&format!("invalid source DOCX: {error}")))?;
    verify_source_story_unlink_destination(&mut archive, story)?;
    let styles = crate::source_typography_styles(&source_path, &manifest.source.sha256)?;
    let prepared = hcd_core::prepare_story_unlink_at_revision(
        &frozen,
        revision,
        request,
        story,
        &styles,
        new_reference_id,
        copy_extension,
    )?;
    Ok(PreparedSourceStoryUnlink {
        source_directory,
        bundle_snapshot: snapshot,
        source_path,
        prepared,
    })
}

pub struct StoryCopyReplay<'a> {
    pub choices: &'a hcd_core::StoryCopyChoices,
    pub expected_commitment: &'a str,
}

/// Reconstruct a previously reviewed candidate from the fixed DOCX and HCD
/// revision. The policy must independently approve each extension copy; the
/// saved choices and commitment are untrusted until authenticated by the caller.
pub fn replay_source_story_unlink<G>(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
    request: &hcd_core::FlowStoryUnlinkRequest,
    story: &hcd_core::FlowStory,
    replay: StoryCopyReplay<'_>,
    mut copy_extension: G,
) -> Result<PreparedSourceStoryUnlink, HcdError>
where
    G: FnMut(
        &hcd_core::ExtensionNode,
        &hcd_core::ExtensionNode,
    ) -> Result<hcd_core::ExtensionNode, HcdError>,
{
    let mut references = replay.choices.reference_ids.iter();
    let mut extensions = replay.choices.extensions.iter();
    let prepared = prepare_source_story_unlink(
        bundle,
        source,
        revision,
        request,
        story,
        |_| {
            references
                .next()
                .cloned()
                .ok_or_else(|| HcdError::InvalidPatch("missing story copy reference choice".into()))
        },
        |old| {
            let choice = extensions.next().ok_or_else(|| {
                HcdError::InvalidPatch("missing story copy extension choice".into())
            })?;
            let approved = copy_extension(old, choice)?;
            if &approved != choice {
                return Err(HcdError::PreconditionFailed(
                    "story copy extension policy changed".into(),
                ));
            }
            Ok(approved)
        },
    )?;
    if references.next().is_some() || extensions.next().is_some() {
        return Err(HcdError::InvalidPatch("unused story copy choices".into()));
    }
    if prepared.prepared.commitment()? != replay.expected_commitment {
        return Err(HcdError::PreconditionFailed(
            "Word story candidate commitment changed".into(),
        ));
    }
    Ok(prepared)
}

fn unsupported(message: &str) -> HcdError {
    HcdError::Unsupported(format!("source Word story link: {message}"))
}

/// Check a proposed independent story name against an already verified,
/// immutable source archive. The caller must authenticate the source snapshot
/// and separately fence the room and revision before publishing anything.
pub fn verify_source_story_unlink_destination(
    archive: &mut oxml::StreamingOxmlArchive,
    story: &hcd_core::FlowStory,
) -> Result<(), HcdError> {
    let name = story
        .source_part
        .strip_prefix("word/")
        .and_then(|value| value.strip_suffix(".xml"))
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 200
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
        .ok_or_else(|| unsupported("unsupported independent story part name"))?;
    let part = format!("word/{name}.xml");
    let rels = format!("word/_rels/{name}.xml.rels");
    fn decoded_name(name: &str) -> Option<String> {
        let bytes = name.as_bytes();
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' {
                let digits = bytes.get(index + 1..index + 3)?;
                let hex = std::str::from_utf8(digits).ok()?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            } else {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(decoded).ok()
    }
    if part.eq_ignore_ascii_case("word/document.xml")
        || archive.entries().iter().any(|entry| {
            entry.name.eq_ignore_ascii_case(&part)
                || entry.name.eq_ignore_ascii_case(&rels)
                || decoded_name(&entry.name).is_some_and(|name| {
                    name.eq_ignore_ascii_case(&part) || name.eq_ignore_ascii_case(&rels)
                })
        })
    {
        return Err(unsupported(
            "independent story part already exists in source",
        ));
    }
    // A dangling content-type override can also give a newly created part a
    // pre-existing meaning, even though neither the part nor a relationship
    // currently exists. Do not silently reuse that declaration.
    let content_types: Vec<_> = archive
        .entries()
        .iter()
        .filter(|entry| {
            !entry.is_dir
                && decoded_name(&entry.name)
                    .is_some_and(|name| name.eq_ignore_ascii_case("[Content_Types].xml"))
        })
        .map(|entry| entry.name.clone())
        .collect();
    if content_types.len() > 1 {
        return Err(unsupported("ambiguous content types part"));
    }
    if let Some(name) = content_types.first() {
        let bytes = archive
            .read_control_part(name, hcd_core::MAX_CONTROL_PART_BYTES)
            .map_err(|error| unsupported(&format!("invalid content types part: {error}")))?;
        if bytes
            .windows(9)
            .any(|value| value.eq_ignore_ascii_case(b"<!DOCTYPE"))
        {
            return Err(unsupported("content types DTD is unsupported"));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| unsupported("unsupported content types encoding"))?;
        let document = roxmltree::Document::parse(text)
            .map_err(|_| unsupported("invalid content types XML"))?;
        const CONTENT_NS: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
        if document.root_element().tag_name() != (CONTENT_NS, "Types").into() {
            return Err(unsupported("invalid content types root"));
        }
        for entry in document
            .root_element()
            .children()
            .filter(|node| node.is_element())
        {
            if entry.tag_name() == (CONTENT_NS, "Default").into() {
                continue;
            }
            if entry.tag_name() != (CONTENT_NS, "Override").into() {
                return Err(unsupported("invalid content types entry"));
            }
            let target = entry
                .attribute("PartName")
                .and_then(decoded_name)
                .and_then(|value| value.strip_prefix('/').map(str::to_owned))
                .filter(|value| {
                    !value.is_empty()
                        && !value.contains(['\\', '\0', '?', '#', ':'])
                        && value
                            .split('/')
                            .all(|segment| !matches!(segment, "" | "." | ".."))
                })
                .ok_or_else(|| unsupported("invalid content types part name"))?;
            if target.eq_ignore_ascii_case(&part) || target.eq_ignore_ascii_case(&rels) {
                return Err(unsupported(
                    "independent story part has an existing content type override",
                ));
            }
        }
    }
    // An existing relationship can target a missing part. Creating that part
    // would otherwise silently change the meaning of the old relationship.
    let mut relation_parts = Vec::new();
    for entry in archive.entries().iter().filter(|entry| !entry.is_dir) {
        let decoded = decoded_name(&entry.name)
            .ok_or_else(|| unsupported("invalid source package part name"))?;
        if decoded.to_ascii_lowercase().ends_with(".rels") {
            relation_parts.push((entry.name.clone(), decoded, entry.uncompressed_size));
        }
    }
    let mut total = 0u64;
    for (name, decoded, size) in relation_parts {
        total = total
            .checked_add(size)
            .ok_or_else(|| unsupported("relationship size overflow"))?;
        if total > 64 * 1024 * 1024 {
            return Err(HcdError::ResourceLimit(
                "source relationships exceed scan limit".into(),
            ));
        }
        let owner = if decoded == "_rels/.rels" {
            String::new()
        } else {
            let (directory, file) = decoded
                .rsplit_once("/_rels/")
                .ok_or_else(|| unsupported("unsupported relationship part path"))?;
            let file = file
                .strip_suffix(".rels")
                .filter(|value| !value.is_empty() && !value.contains('/'))
                .ok_or_else(|| unsupported("unsupported relationship part path"))?;
            format!("{directory}/{file}")
        };
        let bytes = archive
            .read_control_part(&name, hcd_core::MAX_CONTROL_PART_BYTES)
            .map_err(|error| unsupported(&format!("invalid relationship part: {error}")))?;
        if bytes
            .windows(9)
            .any(|value| value.eq_ignore_ascii_case(b"<!DOCTYPE"))
        {
            return Err(unsupported("relationship DTD is unsupported"));
        }
        let xml = std::str::from_utf8(&bytes)
            .map_err(|_| unsupported("unsupported relationship encoding"))?;
        let xml =
            roxmltree::Document::parse(xml).map_err(|_| unsupported("invalid relationship XML"))?;
        const REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
        if xml.root_element().tag_name() != (REL_NS, "Relationships").into() {
            return Err(unsupported("invalid relationship root"));
        }
        for relation in xml
            .root_element()
            .children()
            .filter(|node| node.is_element())
        {
            if relation.tag_name() != (REL_NS, "Relationship").into() {
                return Err(unsupported("invalid relationship entry"));
            }
            match relation.attribute("TargetMode") {
                Some("External") => continue,
                None | Some("Internal") => {}
                _ => return Err(unsupported("invalid relationship mode")),
            }
            let target = relation
                .attribute("Target")
                .ok_or_else(|| unsupported("relationship target missing"))?;
            let target = target.split(['?', '#']).next().unwrap_or("");
            let target = decoded_name(target)
                .filter(|target| !target.is_empty() && !target.contains(['\\', '\0', ':']))
                .ok_or_else(|| unsupported("invalid relationship target"))?;
            let resolved = crate::importer::resolve_relationship_target(&owner, &target)?;
            if resolved.eq_ignore_ascii_case(&part) || resolved.eq_ignore_ascii_case(&rels) {
                return Err(unsupported(
                    "independent story part is already referenced by source",
                ));
            }
        }
    }
    Ok(())
}

fn maps(bundle: &Bundle, revision: u64) -> Result<BTreeMap<String, NodeMapEntry>, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = hcd_core::manifest_at_revision(bundle, &head, Some(revision))?;
    let mut result = BTreeMap::new();
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, page)?.chunks {
            for entry in bundle.read_map_verified(&chunk)?.entries {
                if result.insert(entry.node_id.clone(), entry).is_some() {
                    return Err(unsupported("duplicate source node"));
                }
            }
        }
    }
    Ok(result)
}

fn assets(bundle: &Bundle, revision: u64) -> Result<Vec<hcd_core::AssetDescriptor>, HcdError> {
    let mut assets = bundle.read_asset_index_for_revision(revision)?;
    assets.retain(|a| {
        ![
            hcd_core::FLOW_LAYOUT_SOURCE_PART,
            hcd_core::FLOW_REGION_LAYOUT_SOURCE_PART,
        ]
        .contains(&a.source_part.as_str())
    });
    assets.sort_by(|a, b| a.source_part.cmp(&b.source_part).then(a.href.cmp(&b.href)));
    Ok(assets)
}

fn region_text_unsupported(message: &str) -> HcdError {
    HcdError::Unsupported(format!("source Word region text: {message}"))
}

/// Prove that the selected region revision can be reproduced using only
/// mapped text splices over a fresh projection of the exact source.  The
/// returned snapshots must be used by the caller for any subsequent export.
pub(crate) fn verify_source_region_text(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
) -> Result<(tempfile::TempDir, hcd_core::PortableSnapshot, PathBuf), HcdError> {
    if !(1..=4097).contains(&revision) {
        return Err(region_text_unsupported("unsupported text revision history"));
    }
    let snapshot = hcd_core::create_portable_snapshot(bundle, Some(revision))?;
    let frozen = Bundle::open(snapshot.directory.path())?;
    let head = frozen.manifest()?;
    let initial = frozen.revision(1)?;
    if head.source.format != "docx"
        || initial.patch_id.as_deref() != Some("flow-region-projection-0")
        || initial.patch_base_revision != Some(0)
        || !initial.structural_change
    {
        return Err(region_text_unsupported("missing initial region projection"));
    }
    if head.source.size_bytes > MAX_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(
            "source DOCX exceeds byte limit".into(),
        ));
    }
    let source_directory = tempfile::tempdir()?;
    let source_path = source_directory.path().join("source.docx");
    let input = std::fs::File::open(source)?;
    let mut output = std::fs::File::create(&source_path)?;
    let copied = std::io::copy(&mut input.take(head.source.size_bytes + 1), &mut output)?;
    drop(output);
    if copied != head.source.size_bytes || hcd_core::hash_file(&source_path)? != head.source.sha256
    {
        return Err(HcdError::SourceMismatch(
            "source DOCX does not match imported bytes".into(),
        ));
    }
    let imported_dir = tempfile::tempdir()?;
    let imported_path = imported_dir.path().join("imported.hcd");
    let mut options = ImportOptions::new(&head.document_id);
    options.flow_layout = true;
    import_docx(&source_path, &imported_path, &options, |_| Ok(()))?;
    let imported = Bundle::open(&imported_path)?;
    hcd_core::project_flow_regions(&imported, 0)?;
    let expected = imported.manifest()?;
    if expected.root_hash != initial.root_hash
        || expected.annotation_root_hash != initial.annotation_root_hash
        || std::fs::read(imported.resolve_href(&expected.styles_href)?)?
            != std::fs::read(frozen.resolve_href(&head.styles_href)?)?
    {
        return Err(region_text_unsupported(
            "initial projection differs from source",
        ));
    }
    for at in 2..=revision {
        let record = frozen.revision(at)?;
        if record.structural_change
            || record.word_layout_change
            || record.layout_upgrade
            || !record.patch_base_revision.is_some_and(|base| base < at)
            || record.dirty_node_ids.is_empty()
        {
            return Err(region_text_unsupported(
                "history contains non-text edits or an invalid base revision",
            ));
        }
        let (view, _) = hcd_core::manifest_at_revision(&frozen, &head, Some(at))?;
        let mut operations = Vec::new();
        for id in &record.dirty_node_ids {
            let before = hcd_core::get_text_node(&imported, id)?.node;
            let after = hcd_core::get_text_node_in_manifest(&frozen, id, &view)?.node;
            if before.source != after.source
                || before.source.node_kind != "text"
                || !before.source.editable
            {
                return Err(region_text_unsupported("text source anchor changed"));
            }
            operations.push(hcd_core::PatchOperation::TextSplice {
                node_id: id.clone(),
                start: 0,
                delete_count: before.text.chars().count(),
                insert_text: after.text,
                precondition: hcd_core::NodePrecondition {
                    node_hash: before.node_hash,
                },
            });
        }
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: head.document_id.clone(),
            patch_id: format!("source-text-proof-{at}"),
            base_revision: at - 1,
            actor: BTreeMap::new(),
            operations,
            metadata: BTreeMap::new(),
        };
        let replayed = hcd_core::apply_patch(&imported, &patch, at - 1)?;
        if replayed.root_hash != record.root_hash
            || replayed.annotation_root_hash != record.annotation_root_hash
        {
            return Err(region_text_unsupported(
                "text replay differs from saved revision",
            ));
        }
    }
    Ok((source_directory, snapshot, source_path))
}

/// Verify an import -> region projection -> consecutive link-only history.
/// This does not write an export or authorize a collaboration transaction.
pub fn verify_source_story_link(
    bundle: &Bundle,
    source: &Path,
    revision: u64,
) -> Result<VerifiedSourceStoryLink, HcdError> {
    if !(2..=4097).contains(&revision) {
        return Err(unsupported(
            "requires between 1 and 4096 links after initial projection",
        ));
    }
    let snapshot = hcd_core::create_portable_snapshot(bundle, Some(revision))?;
    let frozen = Bundle::open(snapshot.directory.path())?;
    let head = frozen.manifest()?;
    let projection_record = frozen.revision(1)?;
    if head.source.format != "docx"
        || head.capabilities.word_layout_edits != Some(2)
        || projection_record.patch_id.as_deref() != Some("flow-region-projection-0")
    {
        return Err(unsupported("unsupported revision history"));
    }
    for at in 2..=revision {
        let record = frozen.revision(at)?;
        if record.patch_base_revision != Some(at - 1)
            || !record.word_layout_change
            || !record
                .patch_id
                .as_deref()
                .is_some_and(|id| id.starts_with("word-story-link-"))
        {
            return Err(unsupported(
                "history includes an edit other than a story link",
            ));
        }
    }
    if head.source.size_bytes > MAX_SOURCE_BYTES {
        return Err(HcdError::ResourceLimit(
            "source DOCX exceeds byte limit".into(),
        ));
    }
    let source_directory = tempfile::tempdir()?;
    let source_path = source_directory.path().join("source.docx");
    let input = std::fs::File::open(source)?;
    let mut output = std::fs::File::create(&source_path)?;
    let copied = std::io::copy(&mut input.take(head.source.size_bytes + 1), &mut output)?;
    drop(output);
    if copied != head.source.size_bytes || hcd_core::hash_file(&source_path)? != head.source.sha256
    {
        return Err(HcdError::SourceMismatch(
            "source DOCX does not match the imported bytes".into(),
        ));
    }
    let imported_dir = tempfile::tempdir()?;
    let imported_path = imported_dir.path().join("imported.hcd");
    let mut options = ImportOptions::new(&head.document_id);
    options.flow_layout = true;
    import_docx(&source_path, &imported_path, &options, |_| Ok(()))?;
    let imported = Bundle::open(&imported_path)?;
    hcd_core::project_flow_regions(&imported, 0)?;
    hcd_core::validate_portable_bundle(&imported)?;
    let expected = hcd_core::editor_projection(&imported, Some(1))?;
    let before = hcd_core::editor_projection(&frozen, Some(1))?;
    let after = hcd_core::editor_projection(&frozen, Some(revision))?;
    if serde_json::to_value(&expected.blocks)? != serde_json::to_value(&before.blocks)?
        || serde_json::to_value(&before.blocks)? != serde_json::to_value(&after.blocks)?
        || expected.tracked_changes != before.tracked_changes
        || before.tracked_changes != after.tracked_changes
        || expected.comments != before.comments
        || before.comments != after.comments
        || maps(&imported, 1)? != maps(&frozen, 1)?
        || maps(&frozen, 1)? != maps(&frozen, revision)?
        || assets(&imported, 1)? != assets(&frozen, 1)?
        || assets(&frozen, 1)? != assets(&frozen, revision)?
        || std::fs::read(imported.resolve_href(&imported.manifest()?.styles_href)?)?
            != std::fs::read(frozen.resolve_href(&head.styles_href)?)?
        || imported.manifest()?.annotation_root_hash != head.annotation_root_hash
    {
        return Err(unsupported(
            "content, source mapping, style, annotations or resources differ",
        ));
    }
    let before_layout = before
        .flow_layout
        .ok_or_else(|| unsupported("missing original layout"))?;
    let mut archive =
        oxml::StreamingOxmlArchive::open(&source_path).map_err(|e| unsupported(&e.to_string()))?;
    let source_layout = crate::flow_layout::load_flow_layout(&mut archive, &head.document_id)?;
    let relationships = crate::flow_layout::relationships(&mut archive)?;
    let mut previous = before_layout.clone();
    let mut removals = Vec::new();
    for at in 2..=revision {
        let (view, _) = hcd_core::manifest_at_revision(&frozen, &head, Some(at))?;
        let next = hcd_core::read_flow_document_layout(&frozen, &view)?
            .ok_or_else(|| unsupported("missing target layout"))?;
        removals.push(plan_source_story_link_reference_from_base(
            &relationships,
            &source_layout,
            &before_layout,
            &previous,
            &next,
        )?);
        previous = next;
    }
    // The source may contain an opaque reference attribute or XML placement
    // that the importer can read but the lossless rewriter cannot safely edit.
    // Include the actual rewrite validation in preflight so the UI does not
    // advertise an export that will deterministically fail later.
    archive
        .with_part("word/document.xml", |reader| {
            crate::rewrite_story_link_references(
                reader,
                std::io::sink(),
                before_layout.sections.len(),
                &removals,
            )
            .map_err(|error| oxml::PackageError::ReadPartError(error.to_string()))
        })
        .map_err(|error| unsupported(&error.to_string()))?;
    Ok(VerifiedSourceStoryLink {
        source_directory,
        bundle_snapshot: snapshot,
        source_path,
        removals,
        section_count: before_layout.sections.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        FlowStoryKind, FlowStoryLinkRequest, FlowStoryLinkTransaction, FlowStoryVariant,
    };

    #[test]
    fn independent_story_name_rejects_source_and_orphan_relationship_collisions() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for name in [
            "word/Header7.xml",
            "word/_rels/footer9.xml.rels",
            "word/%68eader11.xml",
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(if name.ends_with(".rels") { br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"# } else { b"fixture" }).unwrap();
        }
        zip.finish().unwrap();
        let mut archive = oxml::StreamingOxmlArchive::open(path).unwrap();
        let mut story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 1),
            kind: FlowStoryKind::Header,
            source_part: "word/header10.xml".into(),
        };
        assert!(verify_source_story_unlink_destination(&mut archive, &story).is_ok());
        for path in [
            "word/header7.xml",
            "word/footer9.xml",
            "word/header11.xml",
            "word/document.xml",
            "word/nested/header.xml",
            "word/header%37.xml",
            "word/../header.xml",
        ] {
            story.source_part = path.into();
            assert!(
                verify_source_story_unlink_destination(&mut archive, &story).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn independent_story_rejects_dangling_internal_relationship_targets() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file(
            "word/_rels/document.xml%2Erels",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="one" Type="x" Target="%68eader25.xml"/><Relationship Id="two" Type="x" Target="https://example.invalid/header26.xml" TargetMode="External"/></Relationships>"#).unwrap();
        zip.finish().unwrap();
        let mut archive = oxml::StreamingOxmlArchive::open(path).unwrap();
        let mut story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 1),
            kind: FlowStoryKind::Header,
            source_part: "word/header25.xml".into(),
        };
        assert!(verify_source_story_unlink_destination(&mut archive, &story).is_err());
        story.source_part = "word/header26.xml".into();
        assert!(verify_source_story_unlink_destination(&mut archive, &story).is_ok());
    }

    #[test]
    fn independent_story_rejects_dangling_content_type_override_and_invalid_part_names() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 1),
            kind: FlowStoryKind::Header,
            source_part: "word/header25.xml".into(),
        };
        for (index, part_name, expected) in [
            (0, "/word/%68eader25.xml", false),
            (1, "/word/header26.xml", true),
            (2, "/word/header%ZZ.xml", false),
            (3, "/word/../word/header25.xml", false),
        ] {
            let path = temp.path().join(format!("source-{index}.docx"));
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            zip.start_file(
                "[Content_Types].xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            write!(zip, "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"{part_name}\" ContentType=\"application/xml\"/></Types>").unwrap();
            zip.finish().unwrap();
            let mut archive = oxml::StreamingOxmlArchive::open(path).unwrap();
            assert_eq!(
                verify_source_story_unlink_destination(&mut archive, &story).is_ok(),
                expected
            );
        }
        let path = temp.path().join("invalid-name.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file(
            "word/_rels/document%ZZ.xml.rels",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"ignored").unwrap();
        zip.finish().unwrap();
        let mut archive = oxml::StreamingOxmlArchive::open(path).unwrap();
        assert!(verify_source_story_unlink_destination(&mut archive, &story).is_err());
    }

    #[test]
    fn real_docx_story_copy_preparation_preserves_text_and_rejects_image_blocks() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("copy-source.hcd");
        let mut options = ImportOptions::new("story-copy-test");
        options.flow_layout = true;
        import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let styles =
            crate::source_typography_styles(&source, &bundle.manifest().unwrap().source.sha256)
                .unwrap();
        let projection =
            hcd_core::editor_projection_with_typography_styles(&bundle, Some(1), &styles).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let hash = projection.flow_layout_hash.as_ref().unwrap();
        // Creating a previously absent first-section variant must prepare a
        // blank canonical root without modifying the imported document.
        let section = &layout.sections[0];
        let (kind, variant) = [
            hcd_core::FlowStoryKind::Header,
            hcd_core::FlowStoryKind::Footer,
        ]
        .into_iter()
        .flat_map(|kind| {
            [
                hcd_core::FlowStoryVariant::Default,
                hcd_core::FlowStoryVariant::First,
                hcd_core::FlowStoryVariant::Even,
            ]
            .into_iter()
            .map(move |variant| (kind, variant))
        })
        .find(|(kind, variant)| match kind {
            hcd_core::FlowStoryKind::Header => section.headers.get(*variant).is_none(),
            hcd_core::FlowStoryKind::Footer => section.footers.get(*variant).is_none(),
        })
        .expect("fixture needs an absent first-section variant");
        let request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: hash.clone(),
            section_id: section.id.clone(),
            kind,
            variant,
            expected_inherited_story_id: None,
        };
        let mut destination = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999999),
            kind,
            source_part: "word/new-independent-story.xml".into(),
        };
        let prepare = |destination: &hcd_core::FlowStory| {
            hcd_core::prepare_story_unlink_at_revision(
                &bundle,
                1,
                &request,
                destination,
                &styles,
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected reference".into(),
                    ))
                },
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected extension".into(),
                    ))
                },
            )
        };
        let mut prepared = prepare(&destination).unwrap();
        prepared.verify_current(&bundle).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join(".hcd-write-lock"))
            .unwrap();
        lock.try_lock().unwrap();
        assert!(matches!(
            prepared.verify_current(&bundle),
            Err(hcd_core::HcdError::RevisionConflict(_))
        ));
        lock.unlock().unwrap();
        prepared.verify_current(&bundle).unwrap();
        prepared.content[0].kind = hcd_core::EditorBlockKind::HorizontalRule;
        assert!(prepared.verify_current(&bundle).is_err());
        prepared.content[0].kind = hcd_core::EditorBlockKind::Paragraph;
        prepared.verify_current(&bundle).unwrap();
        assert_eq!(prepared.revision, 1);
        assert_eq!(prepared.root_hash, bundle.manifest().unwrap().root_hash);
        assert_eq!(prepared.content.len(), 1);
        assert_eq!(prepared.content[0], hcd_core::EditorBlockContent::default());
        assert_eq!(prepared.blocks.len(), 1);
        assert_eq!(
            prepared.blocks[0].flow_region_id.as_deref(),
            Some(destination.id.as_str())
        );
        assert!(!prepared.blocks[0].read_only);
        hcd_core::validate_flow_story_unlink_transition(layout, &prepared.layout).unwrap();
        let source_copy = temp.path().join("source-copy.docx");
        std::fs::copy(&source, &source_copy).unwrap();
        let verified = prepare_source_story_unlink(
            &bundle,
            &source_copy,
            1,
            &request,
            &destination,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(verified.prepared.root_hash, prepared.root_hash);
        assert_eq!(verified.prepared.content, prepared.content);
        verified.verify_current(&bundle).unwrap();
        std::fs::write(&source_copy, b"replaced after capture").unwrap();
        assert_eq!(
            hcd_core::hash_file(&verified.source_path).unwrap(),
            bundle.manifest().unwrap().source.sha256
        );
        std::fs::write(&verified.source_path, b"captured source changed").unwrap();
        assert!(verified.verify_current(&bundle).is_err());
        assert!(prepare_source_story_unlink(
            &bundle,
            &source_copy,
            1,
            &request,
            &destination,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .is_err());
        let collision = hcd_core::FlowStory {
            source_part: "word/document.xml".into(),
            ..destination.clone()
        };
        assert!(prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &request,
            &collision,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        destination.id = projection.blocks[0].block_id.clone();
        assert!(prepare(&destination).is_err());
        let inherited = layout.sections[0].headers.first.clone().unwrap();
        assert!(layout.sections[1].headers.first.is_none());
        let inherited_request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: hash.clone(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: Some(inherited.clone()),
        };
        let copied_story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999998),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/new-copy.xml".into(),
        };
        let copied = hcd_core::prepare_story_unlink_at_revision(
            &bundle,
            1,
            &inherited_request,
            &copied_story,
            &styles,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(copied.impact.inherited_story_id, Some(inherited));
        assert_eq!(copied.content[0].inlines[0].text, "First header");
        assert_eq!(copied.content[0].inlines[0].node_id, None);
        assert_eq!(copied.blocks.len(), copied.content.len());
        assert!(copied
            .blocks
            .iter()
            .all(
                |block| block.flow_region_id.as_deref() == Some(copied_story.id.as_str())
                    && !block.read_only
            ));
        assert_ne!(
            copied.blocks[0].block_id,
            projection
                .blocks
                .iter()
                .find(|block| block.flow_region_id.as_deref()
                    == inherited_request.expected_inherited_story_id.as_deref())
                .unwrap()
                .block_id
        );
        hcd_core::validate_flow_story_unlink_transition(layout, &copied.layout).unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let mut copied = 0;
        let mut protected = 0;
        let mut annotated_target = None;
        for story in &layout.stories {
            let blocks: Vec<_> = projection
                .blocks
                .iter()
                .filter(|block| block.flow_region_id.as_deref() == Some(&story.id))
                .collect();
            if blocks.is_empty() {
                continue;
            }
            let result = hcd_core::prepare_story_copy_at_revision(
                &bundle,
                1,
                hash,
                &story.id,
                &styles,
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected reference".into(),
                    ))
                },
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected extension".into(),
                    ))
                },
            );
            if blocks.iter().any(|block| block.read_only) {
                assert!(result.is_err());
                protected += 1;
            } else {
                let result = result.unwrap();
                assert_eq!(result.len(), blocks.len());
                for (original, copy) in blocks.iter().zip(result.iter()) {
                    assert_eq!(
                        original
                            .content
                            .inlines
                            .iter()
                            .map(|inline| (&inline.text, &inline.typography))
                            .collect::<Vec<_>>(),
                        copy.inlines
                            .iter()
                            .map(|inline| (&inline.text, &inline.typography))
                            .collect::<Vec<_>>()
                    );
                    assert!(copy.inlines.iter().all(|inline| inline.node_id.is_none()));
                    if let Some(inline) = original
                        .content
                        .inlines
                        .iter()
                        .find(|inline| inline.node_id.is_some() && !inline.text.is_empty())
                    {
                        annotated_target =
                            Some((story.id.clone(), inline.node_id.clone().unwrap()));
                    }
                }
                copied += 1;
            }
        }
        assert!(copied > 0, "fixture should contain an editable story");
        assert!(protected > 0, "fixture should contain an image story");
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let (story, node_id) = annotated_target.expect("editable story text");
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: options.document_id.clone(),
            patch_id: "story-annotation".into(),
            base_revision: 1,
            actor: Default::default(),
            operations: vec![hcd_core::PatchOperation::AnnotationUpsert {
                annotation: hcd_core::Annotation {
                    annotation_id: "copy-annotation".into(),
                    node_id,
                    start: 0,
                    end: 1,
                    kind: "test".into(),
                    rule_id: None,
                    confidence: None,
                    ignored: false,
                },
            }],
            metadata: Default::default(),
        };
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        assert!(prepared.verify_current(&bundle).is_err());
        assert!(hcd_core::validate_unlink_revision_content(&bundle, 1, 2).is_err());
        assert!(hcd_core::validate_unlink_revision_content(&bundle, 0, 2).is_err());
        destination.id = format!("n_{:032x}", 999999);
        let blank_at_revision = |revision| {
            hcd_core::prepare_story_unlink_at_revision(
                &bundle,
                revision,
                &request,
                &destination,
                &styles,
                |_| unreachable!(),
                |_| unreachable!(),
            )
            .unwrap()
        };
        let same_base = blank_at_revision(1);
        let next_base = blank_at_revision(2);
        assert_eq!(prepared.blocks[0].block_id, same_base.blocks[0].block_id);
        assert_ne!(prepared.blocks[0].block_id, next_base.blocks[0].block_id);
        assert_eq!(next_base.revision, 2);
        let copy = |revision| {
            hcd_core::prepare_story_copy_at_revision(
                &bundle,
                revision,
                hash,
                &story,
                &styles,
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected reference".into(),
                    ))
                },
                |_| {
                    Err(hcd_core::HcdError::Unsupported(
                        "unexpected extension".into(),
                    ))
                },
            )
        };
        assert!(copy(2).is_err());
        assert!(copy(1).is_ok());
    }

    #[test]
    fn independent_story_preparation_verifies_saved_attachment_from_pinned_revision() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("resource-copy.hcd");
        let mut options = ImportOptions::new("story-resource-test");
        options.flow_layout = true;
        import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let styles =
            crate::source_typography_styles(&source, &bundle.manifest().unwrap().source.sha256)
                .unwrap();
        let projection =
            hcd_core::editor_projection_with_typography_styles(&bundle, Some(1), &styles).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let source_id = layout.sections[0].headers.first.clone().unwrap();
        let bytes = b"section attachment";
        let asset = bundle
            .stage_asset_from_reader("bin", &mut std::io::Cursor::new(bytes))
            .unwrap();
        let node: hcd_core::ExtensionNode = serde_json::from_value(serde_json::json!({
            "schemaVersion":"hcd.extension/2", "instanceId":format!("x_{:032x}", 1),
            "type":"example.attachment", "version":1, "display":"inline", "data":{},
            "fallback":{"text":"file"}, "resources":[{"key":"file", "hash":asset.hash,
            "byteLength":bytes.len(), "name":"file.bin", "mediaType":"application/octet-stream"}]
        }))
        .unwrap();
        let content = hcd_core::EditorBlockContent {
            inlines: vec![hcd_core::EditorInline {
                text: "file".into(),
                extension: Some(node),
                ..Default::default()
            }],
            ..Default::default()
        };
        let patch = hcd_core::FlowStructurePatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
            document_id: options.document_id.clone(),
            patch_id: "story-resource-insert".into(),
            base_revision: 1,
            layout_hash: projection.flow_layout_hash.unwrap(),
            actor: Default::default(),
            regions: vec![hcd_core::FlowRegionEdits {
                region_id: source_id.clone(),
                operations: vec![hcd_core::StructureOperation::Insert {
                    after_block_id: None,
                    block: content,
                }],
            }],
        };
        hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
        let saved =
            hcd_core::editor_projection_with_typography_styles(&bundle, Some(2), &styles).unwrap();
        let layout = saved.flow_layout.as_ref().unwrap();
        let request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: saved.flow_layout_hash.clone().unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: hcd_core::FlowStoryKind::Header,
            variant: hcd_core::FlowStoryVariant::First,
            expected_inherited_story_id: Some(source_id),
        };
        let destination = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999999),
            kind: hcd_core::FlowStoryKind::Header,
            source_part: "word/new-copy.xml".into(),
        };
        let copy = hcd_core::prepare_story_unlink_at_revision(
            &bundle,
            2,
            &request,
            &destination,
            &styles,
            |_| unreachable!(),
            |node| {
                let mut copy = node.clone();
                copy.instance_id = format!("x_{:032x}", 2);
                Ok(copy)
            },
        )
        .unwrap();
        let resources: Vec<_> = copy
            .content
            .iter()
            .flat_map(|block| hcd_core::content_extensions(block).unwrap())
            .flat_map(|node| node.resources)
            .collect();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].hash, asset.hash);
        assert_eq!(bundle.manifest().unwrap().revision, 2);
        copy.verify_current(&bundle).unwrap();
        let commitment = copy.commitment().unwrap();
        let choices: hcd_core::StoryCopyChoices =
            serde_json::from_slice(&serde_json::to_vec(&copy.copy_choices().unwrap()).unwrap())
                .unwrap();
        let policy = |old: &hcd_core::ExtensionNode, choice: &hcd_core::ExtensionNode| {
            let mut approved = old.clone();
            approved.instance_id = choice.instance_id.clone();
            Ok(approved)
        };
        let recovered = replay_source_story_unlink(
            &bundle,
            &source,
            2,
            &request,
            &destination,
            StoryCopyReplay {
                choices: &choices,
                expected_commitment: &commitment,
            },
            policy,
        )
        .unwrap();
        assert_eq!(recovered.prepared.commitment().unwrap(), commitment);
        recovered.verify_current(&bundle).unwrap();
        let mut changed = choices.clone();
        changed.extensions[0].fallback.text = "changed".into();
        assert!(replay_source_story_unlink(
            &bundle,
            &source,
            2,
            &request,
            &destination,
            StoryCopyReplay {
                choices: &changed,
                expected_commitment: &commitment
            },
            policy
        )
        .is_err());
        assert!(replay_source_story_unlink(
            &bundle,
            &source,
            2,
            &request,
            &destination,
            StoryCopyReplay {
                choices: &choices,
                expected_commitment: &"0".repeat(64)
            },
            policy
        )
        .is_err());
        let mut extra = choices.clone();
        extra.reference_ids.push("unexpected".into());
        assert!(replay_source_story_unlink(
            &bundle,
            &source,
            2,
            &request,
            &destination,
            StoryCopyReplay {
                choices: &extra,
                expected_commitment: &commitment
            },
            policy
        )
        .is_err());
        std::fs::write(
            bundle.resolve_href(&asset.href).unwrap(),
            vec![b'x'; bytes.len()],
        )
        .unwrap();
        assert!(copy.verify_current(&bundle).is_err());
        assert!(replay_source_story_unlink(
            &bundle,
            &source,
            2,
            &request,
            &destination,
            StoryCopyReplay {
                choices: &choices,
                expected_commitment: &commitment
            },
            policy
        )
        .is_err());
        assert!(hcd_core::prepare_story_unlink_at_revision(
            &bundle,
            2,
            &request,
            &destination,
            &styles,
            |_| unreachable!(),
            |node| {
                let mut copy = node.clone();
                copy.instance_id = format!("x_{:032x}", 2);
                Ok(copy)
            }
        )
        .is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 2);
    }

    #[test]
    fn native_independent_story_transaction_saves_and_replays() {
        let actor = BTreeMap::from([("displayName", "Alice 王"), ("userId", "alice")]);
        assert_eq!(
            hcd_core::hash_bytes(&serde_json::to_vec(&("b".repeat(64), actor)).unwrap()),
            "d7179dcf83ad1afe0ee3550d0f1c947858144159a512aa67861b76d525d2129e"
        );
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("unlink.hcd");
        let mut options = ImportOptions::new("native-unlink-test");
        options.flow_layout = true;
        import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let projection = hcd_core::editor_projection(&bundle, Some(1)).unwrap();
        let layout = projection.flow_layout.as_ref().unwrap();
        let inherited = layout.sections[0].headers.first.clone().unwrap();
        let request = hcd_core::FlowStoryUnlinkRequest {
            base_layout_hash: projection.flow_layout_hash.unwrap(),
            section_id: layout.sections[1].id.clone(),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::First,
            expected_inherited_story_id: Some(inherited),
        };
        let story = hcd_core::FlowStory {
            id: format!("n_{:032x}", 999997),
            kind: FlowStoryKind::Header,
            source_part: "word/independent-new.xml".into(),
        };
        let candidate = prepare_source_story_unlink(
            &bundle,
            &source,
            1,
            &request,
            &story,
            |_| unreachable!(),
            |_| unreachable!(),
        )
        .unwrap();
        candidate.verify_current(&bundle).unwrap();
        let commitment = candidate.prepared.commitment().unwrap();
        let transaction = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let saved = hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            transaction,
            &Default::default(),
        )
        .unwrap();
        assert_eq!(saved.revision, 2);
        assert!(!saved.idempotent_replay);
        let expected_hash = hcd_core::hash_bytes(
            &serde_json::to_vec(&(commitment, BTreeMap::<String, String>::new())).unwrap(),
        );
        assert_eq!(
            bundle.revision(2).unwrap().patch_hash.as_deref(),
            Some(expected_hash.as_str())
        );
        assert!(
            hcd_core::apply_prepared_story_unlink(
                &bundle,
                &candidate.prepared,
                transaction,
                &Default::default()
            )
            .unwrap()
            .idempotent_replay
        );
        let mut other_actor = BTreeMap::new();
        other_actor.insert("userId".into(), "other".into());
        assert!(hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            transaction,
            &other_actor
        )
        .is_err());
        assert!(hcd_core::apply_prepared_story_unlink(
            &bundle,
            &candidate.prepared,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &Default::default()
        )
        .is_err());
        hcd_core::validate_unlink_revision_content(&bundle, 1, 2).unwrap();
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        let updated = hcd_core::editor_projection(&bundle, Some(2)).unwrap();
        assert!(updated
            .blocks
            .iter()
            .any(
                |block| block.flow_region_id.as_deref() == Some(story.id.as_str())
                    && block
                        .content
                        .inlines
                        .iter()
                        .any(|inline| inline.text.contains("First header"))
            ));
        let output = temp.path().join("source-export.docx");
        assert!(
            crate::export_docx(&path, &source, &output, &crate::ExportOptions::default()).is_err()
        );
        assert!(!output.exists());
        hcd_core::restore_revision(&bundle, 1, 2, None, None).unwrap();
        let restored = hcd_core::editor_projection(&bundle, Some(3)).unwrap();
        assert!(!restored
            .flow_layout
            .unwrap()
            .stories
            .iter()
            .any(|item| item.id == story.id));
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
    }

    #[test]
    fn preflight_rejects_reference_attributes_that_cannot_be_preserved() {
        use std::io::Write;
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("opaque.docx");
        let mut input = zip::ZipArchive::new(std::fs::File::open(fixture).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "word/document.xml" {
                let xml = String::from_utf8(bytes).unwrap();
                let original = "<w:headerReference w:type=\"even\" r:id=\"he\"/>";
                assert_eq!(xml.matches(original).count(), 1);
                bytes = xml
                    .replace(
                        original,
                        "<w:headerReference w:type=\"even\" r:id=\"he\" custom=\"opaque\"/>",
                    )
                    .into_bytes();
            }
            output
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        let path = temp.path().join("doc.hcd");
        let mut options = ImportOptions::new("opaque-doc");
        options.flow_layout = true;
        import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let layout = hcd_core::editor_projection(&bundle, None)
            .unwrap()
            .flow_layout
            .unwrap();
        let transaction = FlowStoryLinkTransaction {
            schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
            document_id: options.document_id.clone(),
            transaction_id: "0123456789abcdef0123456789abcdef".into(),
            expected_revision: 1,
            actor: BTreeMap::new(),
            link: FlowStoryLinkRequest {
                base_layout_hash: hcd_core::flow_layout_hash(&layout).unwrap(),
                section_id: layout.sections[1].id.clone(),
                kind: FlowStoryKind::Header,
                variant: FlowStoryVariant::Even,
                expected_direct_story_id: layout.sections[1].headers.even.clone().unwrap(),
            },
        };
        hcd_core::apply_flow_story_link_transaction(&bundle, &transaction).unwrap();
        assert!(verify_source_story_link(&bundle, &source, 2).is_err());
        let target = temp.path().join("out.docx");
        assert!(
            crate::export_docx(&path, &source, &target, &crate::ExportOptions::default()).is_err()
        );
        assert!(!target.exists());
    }

    #[test]
    fn verifies_consecutive_links_history_and_rejects_other_changes() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-regions-2026-10-26/image-source.docx");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("original.hcd");
        let mut options = ImportOptions::new("story-link-verification");
        options.flow_layout = true;
        import_docx(&source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        let layout = hcd_core::editor_projection(&bundle, Some(1))
            .unwrap()
            .flow_layout
            .unwrap();
        let request = FlowStoryLinkTransaction {
            schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
            document_id: options.document_id.clone(),
            transaction_id: "0123456789abcdef0123456789abcdef".into(),
            expected_revision: 1,
            actor: BTreeMap::new(),
            link: FlowStoryLinkRequest {
                base_layout_hash: hcd_core::flow_layout_hash(&layout).unwrap(),
                section_id: layout.sections[1].id.clone(),
                kind: FlowStoryKind::Header,
                variant: FlowStoryVariant::Even,
                expected_direct_story_id: layout.sections[1].headers.even.clone().unwrap(),
            },
        };
        hcd_core::apply_flow_story_link_transaction(&bundle, &request).unwrap();
        let verified = verify_source_story_link(&bundle, &source, 2).unwrap();
        assert_eq!(verified.removals[0].relationship_id, "he");
        assert_eq!(verified.section_count, 2);
        assert_eq!(
            hcd_core::hash_file(&verified.source_path).unwrap(),
            bundle.manifest().unwrap().source.sha256
        );
        let exported = temp.path().join("linked.docx");
        let report =
            crate::export_docx(&path, &source, &exported, &crate::ExportOptions::default())
                .unwrap();
        assert_eq!(report.level, hcd_core::FidelityLevel::High);
        let mut source_zip = zip::ZipArchive::new(std::fs::File::open(&source).unwrap()).unwrap();
        let mut exported_zip =
            zip::ZipArchive::new(std::fs::File::open(&exported).unwrap()).unwrap();
        assert_eq!(source_zip.len(), exported_zip.len());
        for index in 0..source_zip.len() {
            let mut original = source_zip.by_index(index).unwrap();
            let name = original.name().to_owned();
            let mut result = exported_zip.by_name(&name).unwrap();
            let mut old = Vec::new();
            let mut new = Vec::new();
            original.read_to_end(&mut old).unwrap();
            result.read_to_end(&mut new).unwrap();
            if name == "word/document.xml" {
                assert_eq!(
                    String::from_utf8(new).unwrap(),
                    String::from_utf8(old).unwrap().replacen(
                        "<w:headerReference w:type=\"even\" r:id=\"he\"/>",
                        "",
                        1
                    )
                );
            } else {
                assert_eq!(new, old, "changed package part {name}");
            }
        }
        let reopened_path = temp.path().join("reimported.hcd");
        import_docx(&exported, &reopened_path, &options, |_| Ok(())).unwrap();
        let reopened = Bundle::open(&reopened_path).unwrap();
        let reopened_layout =
            hcd_core::read_flow_document_layout(&reopened, &reopened.manifest().unwrap())
                .unwrap()
                .unwrap();
        assert!(reopened_layout.sections[1].headers.even.is_none());
        assert_eq!(
            reopened_layout.sections[0].headers.even,
            layout.sections[0].headers.even
        );
        let existing = std::fs::read(&exported).unwrap();
        assert!(
            crate::export_docx(&path, &source, &exported, &crate::ExportOptions::default())
                .is_err()
        );
        assert_eq!(std::fs::read(&exported).unwrap(), existing);
        let second_layout = hcd_core::editor_projection(&bundle, None)
            .unwrap()
            .flow_layout
            .unwrap();
        let second = FlowStoryLinkTransaction {
            schema_version: hcd_core::FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),
            document_id: options.document_id.clone(),
            transaction_id: "1123456789abcdef0123456789abcdef".into(),
            expected_revision: 2,
            actor: BTreeMap::new(),
            link: FlowStoryLinkRequest {
                base_layout_hash: hcd_core::flow_layout_hash(&second_layout).unwrap(),
                section_id: second_layout.sections[1].id.clone(),
                kind: FlowStoryKind::Footer,
                variant: FlowStoryVariant::First,
                expected_direct_story_id: second_layout.sections[1].footers.first.clone().unwrap(),
            },
        };
        hcd_core::apply_flow_story_link_transaction(&bundle, &second).unwrap();
        let verified_two = verify_source_story_link(&bundle, &source, 3).unwrap();
        assert_eq!(
            verified_two
                .removals
                .iter()
                .map(|item| item.relationship_id.as_str())
                .collect::<Vec<_>>(),
            ["he", "ff"]
        );
        let twice = temp.path().join("twice.docx");
        crate::export_docx(&path, &source, &twice, &crate::ExportOptions::default()).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&twice).unwrap()).unwrap();
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(!xml.contains("r:id=\"he\""));
        assert!(!xml.contains("r:id=\"ff\""));
        let twice_reimported = temp.path().join("twice.hcd");
        import_docx(&twice, &twice_reimported, &options, |_| Ok(())).unwrap();
        let twice_bundle = Bundle::open(&twice_reimported).unwrap();
        let twice_layout =
            hcd_core::read_flow_document_layout(&twice_bundle, &twice_bundle.manifest().unwrap())
                .unwrap()
                .unwrap();
        assert!(twice_layout.sections[1].headers.even.is_none());
        assert!(twice_layout.sections[1].footers.first.is_none());
        let historical = temp.path().join("historical.docx");
        crate::export_docx(
            &path,
            &source,
            &historical,
            &crate::ExportOptions {
                revision: Some(2),
                fidelity_report: None,
            },
        )
        .unwrap();
        let mut historic_zip =
            zip::ZipArchive::new(std::fs::File::open(historical).unwrap()).unwrap();
        let mut historic_xml = String::new();
        historic_zip
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut historic_xml)
            .unwrap();
        assert!(!historic_xml.contains("r:id=\"he\""));
        assert!(historic_xml.contains("r:id=\"ff\""));
        // Restoring an older version is a different history operation, even if
        // a later link ends up with the same visible layout as r3.
        hcd_core::restore_revision(&bundle, 2, 3, None, None).unwrap();
        let mut after_restore = second.clone();
        after_restore.transaction_id = "2123456789abcdef0123456789abcdef".into();
        after_restore.expected_revision = 4;
        hcd_core::apply_flow_story_link_transaction(&bundle, &after_restore).unwrap();
        assert!(verify_source_story_link(&bundle, &source, 5).is_err());
        let mixed = temp.path().join("mixed.docx");
        assert!(
            crate::export_docx(&path, &source, &mixed, &crate::ExportOptions::default()).is_err()
        );
        assert!(!mixed.exists());
        let bad = temp.path().join("wrong.docx");
        std::fs::write(&bad, b"different source").unwrap();
        assert!(verify_source_story_link(&bundle, &bad, 3).is_err());
        assert!(verify_source_story_link(&bundle, &source, 1).is_err());
        // Styles are not included in the revision root, so compare them to
        // an independent import instead of trusting history alone.
        let styles = bundle
            .resolve_href(&bundle.manifest().unwrap().styles_href)
            .unwrap();
        std::fs::write(styles, "body { color: red; }").unwrap();
        assert!(verify_source_story_link(&bundle, &source, 3).is_err());
        let rejected = temp.path().join("rejected.docx");
        assert!(crate::export_docx(
            &path,
            &source,
            &rejected,
            &crate::ExportOptions {
                revision: Some(3),
                fidelity_report: None
            }
        )
        .is_err());
        assert!(!rejected.exists());
        // The successful candidate is isolated from later source edits.
        assert_eq!(
            hcd_core::hash_file(&verified.source_path).unwrap(),
            bundle.manifest().unwrap().source.sha256
        );
    }
}
