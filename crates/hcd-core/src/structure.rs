//! Bounded, server-owned semantic block edits for the HCD semantic-flow profile.
//! Existing blocks keep their canonical HTML and source-map entries byte for byte.
use crate::bundle::{
    finalize_root_hash, hash_descriptor, now_epoch_ms, read_json_bounded, INDEX_PAGE_SIZE,
};
use crate::{
    extract_html_text_nodes, hash_bytes, node_bloom, stable_node_id, AnnotationSet, ApplyResult,
    Bundle, ChunkDescriptor, ChunkIndexPage, ChunkSourceMap, FidelityWarning, HcdError,
    HcdManifest, NodeMapEntry, RevisionRecord, SourceAnchor, HCD_PATCH_SCHEMA_VERSION_4,
    HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES, MAX_CONTROL_PART_BYTES, MAX_PATCH_JSON_BYTES,
    MAX_REVISION,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_BLOCKS: usize = 1_000_000;
const MAX_INLINE_BYTES: usize = 1024 * 1024;
const MAX_OPS: usize = 10_000;
const CHUNK_SOFT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorInline {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorBlockKind {
    Paragraph,
    Heading,
    ListItem,
    Opaque,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorBlockContent {
    pub kind: EditorBlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub inlines: Vec<EditorInline>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorBlockView {
    pub block_id: String,
    pub block_hash: String,
    pub region: String,
    pub read_only: bool,
    pub content: EditorBlockContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_html: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorProjection {
    pub document_id: String,
    pub revision: u64,
    pub blocks: Vec<EditorBlockView>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructurePatchBatch {
    pub schema_version: String,
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    pub operations: Vec<StructureOperation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StructureOperation {
    #[serde(rename = "block.insert")]
    Insert {
        after_block_id: Option<String>,
        block: EditorBlockContent,
    },
    #[serde(rename = "block.delete")]
    Delete {
        block_id: String,
        precondition: BlockPrecondition,
    },
    #[serde(rename = "block.move")]
    Move {
        block_id: String,
        after_block_id: Option<String>,
        precondition: BlockPrecondition,
    },
    #[serde(rename = "block.replace")]
    Replace {
        block_id: String,
        block: EditorBlockContent,
        precondition: BlockPrecondition,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockPrecondition {
    pub block_hash: String,
}

#[derive(Clone)]
struct Block {
    id: String,
    region: String,
    read_only: bool,
    content: EditorBlockContent,
    html: String,
    entries: Vec<NodeMapEntry>,
}

impl Block {
    fn hash(&self) -> String {
        hash_bytes(self.html.as_bytes())
    }

    fn view(&self) -> EditorBlockView {
        EditorBlockView {
            block_id: self.id.clone(),
            block_hash: self.hash(),
            region: self.region.clone(),
            read_only: self.read_only,
            content: self.content.clone(),
            read_only_html: self.read_only.then(|| self.html.clone()),
        }
    }
}

pub fn editor_projection(
    bundle: &Bundle,
    revision: Option<u64>,
) -> Result<EditorProjection, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, revision) = crate::manifest_at_revision(bundle, &head, revision)?;
    ensure_semantic_flow(&manifest)?;
    let blocks = load_blocks(bundle, &manifest)?;
    Ok(EditorProjection {
        document_id: manifest.document_id,
        revision,
        blocks: blocks.iter().map(Block::view).collect(),
    })
}

/// Create an immutable revision marking the first editor projection. The
/// canonical body remains identical, so revision 0 remains a visual baseline.
pub fn project_editor(bundle: &Bundle, expected_revision: u64) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_revision}, actual {}",
            manifest.revision
        )));
    }
    if manifest.capabilities.structure_patch {
        return Err(HcdError::InvalidPatch(
            "editor projection already exists".to_string(),
        ));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit(
            "revision limit reached".to_string(),
        ));
    }
    let blocks = load_blocks(bundle, &manifest)?;
    if blocks.is_empty() {
        return Err(HcdError::Unsupported(
            "document has no editable blocks".to_string(),
        ));
    }
    let revision = manifest.revision + 1;
    let record = revision_record(
        bundle,
        &manifest,
        revision,
        "editor-projection",
        Some(hash_bytes(b"editor-projection")),
        false,
    )?;
    manifest.revision = revision;
    manifest.capabilities.structure_patch = true;
    manifest
        .warnings
        .retain(|warning| warning.code != "STYLE_AND_STRUCTURE_PATCH_UNSUPPORTED");
    if let Some(report) = &mut manifest.fidelity {
        report
            .warnings
            .retain(|warning| warning.code != "STYLE_AND_STRUCTURE_PATCH_UNSUPPORTED");
    }
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: "editor-projection".to_string(),
        base_revision: expected_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}

fn ensure_semantic_flow(manifest: &HcdManifest) -> Result<(), HcdError> {
    if manifest.schema_version != HCD_SCHEMA_VERSION
        || manifest.profile != "semantic-flow"
        || !matches!(
            manifest.source.format.as_str(),
            "docx" | "html" | "md" | "txt"
        )
    {
        return Err(HcdError::Unsupported(
            "structural editing requires an hcd/2 DOCX, HTML, Markdown or TXT semantic-flow bundle"
                .to_string(),
        ));
    }
    Ok(())
}

fn revision_record(
    bundle: &Bundle,
    manifest: &HcdManifest,
    revision: u64,
    patch_id: &str,
    patch_hash: Option<String>,
    structural_change: bool,
) -> Result<RevisionRecord, HcdError> {
    Ok(RevisionRecord {
        schema_version: manifest.schema_version.clone(),
        document_id: manifest.document_id.clone(),
        revision,
        parent_revision: Some(revision - 1),
        patch_id: Some(patch_id.to_string()),
        patch_hash,
        patch_base_revision: Some(revision - 1),
        author_id: None,
        author_name: None,
        root_hash: manifest.root_hash.clone(),
        annotation_root_hash: manifest.annotation_root_hash.clone(),
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href: bundle.asset_index_href_for_revision(revision - 1)?,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: Vec::new(),
        removed_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        dirty_grid_parts: Vec::new(),
        grid_row_insertions: Vec::new(),
        grid_row_deletions: Vec::new(),
        grid_column_insertions: Vec::new(),
        grid_column_deletions: Vec::new(),
        structural_change,
    })
}

fn load_blocks(bundle: &Bundle, manifest: &HcdManifest) -> Result<Vec<Block>, HcdError> {
    let mut blocks = Vec::new();
    let mut seen = HashSet::new();
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        if page.page != page_number || page.revision > manifest.revision {
            return Err(HcdError::InvalidBundle(format!(
                "invalid index page {page_number}"
            )));
        }
        for descriptor in &page.chunks {
            let html = bundle.read_chunk_verified(descriptor)?;
            let map = bundle.read_map_verified(descriptor)?;
            let mut parsed = scan_chunk(&html, &map, descriptor, &manifest.document_id)?;
            for block in &mut parsed {
                if !seen.insert(block.id.clone()) {
                    block.id = stable_node_id(&[
                        &manifest.document_id,
                        &descriptor.chunk_id,
                        &block.id,
                        "duplicate-block",
                    ]);
                    if !seen.insert(block.id.clone()) {
                        return Err(HcdError::InvalidBundle(
                            "duplicate editor block id".to_string(),
                        ));
                    }
                }
            }
            blocks.extend(parsed);
            if blocks.len() > MAX_BLOCKS {
                return Err(HcdError::ResourceLimit(format!(
                    "editor exceeds {MAX_BLOCKS} blocks"
                )));
            }
        }
    }
    Ok(blocks)
}

struct OpenBlock {
    start: usize,
    depth: usize,
    name: String,
    id: Option<String>,
    ordered: bool,
}

fn scan_chunk(
    html: &str,
    map: &ChunkSourceMap,
    descriptor: &ChunkDescriptor,
    document_id: &str,
) -> Result<Vec<Block>, HcdError> {
    if map.chunk_id != descriptor.chunk_id {
        return Err(HcdError::InvalidBundle(
            "chunk source map id mismatch".to_string(),
        ));
    }
    let mut reader = Reader::from_str(html);
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut open: Option<OpenBlock> = None;
    let mut blocks = Vec::new();
    loop {
        let before = reader.buffer_position() as usize;
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("editor HTML parse error: {error}"))
        })?;
        let after = reader.buffer_position() as usize;
        match event {
            Event::Start(start) => {
                let name = tag_name(start.name().as_ref());
                if open.is_none() && is_block_tag(&name, &start, &reader)? {
                    open = Some(OpenBlock {
                        start: before,
                        depth: stack.len() + 1,
                        id: attribute(&start, &reader, "data-hcd-id")?,
                        ordered: stack.iter().any(|tag| tag == "ol"),
                        name: name.clone(),
                    });
                }
                stack.push(name);
            }
            Event::Empty(start) => {
                let name = tag_name(start.name().as_ref());
                if open.is_none() && is_block_tag(&name, &start, &reader)? {
                    let candidate = OpenBlock {
                        start: before,
                        depth: stack.len() + 1,
                        id: attribute(&start, &reader, "data-hcd-id")?,
                        ordered: stack.iter().any(|tag| tag == "ol"),
                        name,
                    };
                    blocks.push(block_from_raw(
                        &html[before..after],
                        &candidate,
                        map,
                        descriptor,
                        document_id,
                    )?);
                }
            }
            Event::End(end) => {
                let name = tag_name(end.name().as_ref());
                if stack.last().is_none_or(|tag| tag != &name) {
                    return Err(HcdError::InvalidBundle(
                        "unbalanced editor HTML".to_string(),
                    ));
                }
                if open
                    .as_ref()
                    .is_some_and(|current| current.depth == stack.len())
                {
                    let candidate = open.take().expect("checked open block");
                    blocks.push(block_from_raw(
                        &html[candidate.start..after],
                        &candidate,
                        map,
                        descriptor,
                        document_id,
                    )?);
                }
                stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !stack.is_empty() || open.is_some() {
        return Err(HcdError::InvalidBundle(
            "unclosed editor HTML block".to_string(),
        ));
    }
    let covered: HashSet<&str> = blocks
        .iter()
        .flat_map(|block| block.entries.iter().map(|entry| entry.node_id.as_str()))
        .collect();
    if blocks.is_empty()
        || map
            .entries
            .iter()
            .any(|entry| !covered.contains(entry.node_id.as_str()))
    {
        let entries = map.entries.clone();
        let nodes = extract_html_text_nodes(html)?;
        let inlines = entries
            .iter()
            .filter_map(|entry| {
                nodes.get(&entry.node_id).cloned().map(|text| EditorInline {
                    text,
                    node_id: Some(entry.node_id.clone()),
                    bold: false,
                    italic: false,
                    link: None,
                })
            })
            .collect();
        return Ok(vec![Block {
            id: stable_node_id(&[document_id, &descriptor.chunk_id, "opaque"]),
            region: descriptor.region.clone(),
            read_only: true,
            content: EditorBlockContent {
                kind: EditorBlockKind::Opaque,
                level: None,
                inlines,
            },
            html: html.to_string(),
            entries,
        }]);
    }
    Ok(blocks)
}

fn block_from_raw(
    raw: &str,
    open: &OpenBlock,
    map: &ChunkSourceMap,
    descriptor: &ChunkDescriptor,
    document_id: &str,
) -> Result<Block, HcdError> {
    let nodes = extract_html_text_nodes(raw)?;
    let marks = extract_marks(raw)?;
    let entries: Vec<NodeMapEntry> = map
        .entries
        .iter()
        .filter(|entry| raw.contains(&format!("data-hcd-id=\"{}\"", entry.node_id)))
        .cloned()
        .collect();
    let inlines = entries
        .iter()
        .filter_map(|entry| {
            nodes.get(&entry.node_id).map(|text| {
                let mark = marks.get(&entry.node_id);
                EditorInline {
                    text: text.clone(),
                    node_id: Some(entry.node_id.clone()),
                    bold: mark.is_some_and(|value| value.0),
                    italic: mark.is_some_and(|value| value.1),
                    link: mark.and_then(|value| value.2.clone()),
                }
            })
        })
        .collect();
    let kind = match open.name.as_str() {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => EditorBlockKind::Heading,
        "li" => EditorBlockKind::ListItem,
        "p" => EditorBlockKind::Paragraph,
        _ => EditorBlockKind::Opaque,
    };
    let level = if matches!(kind, EditorBlockKind::Heading) {
        open.name.as_bytes().get(1).map(|byte| byte - b'0')
    } else if matches!(kind, EditorBlockKind::ListItem) {
        Some(if open.ordered { 1 } else { 0 })
    } else {
        None
    };
    let read_only = descriptor.region != "body"
        || matches!(kind, EditorBlockKind::Opaque)
        || raw.contains("data-hcd-visual-hash=")
        || raw.contains("<table");
    let fallback = stable_node_id(&[
        document_id,
        &descriptor.chunk_id,
        &open.start.to_string(),
        "block",
    ]);
    let id = open
        .id
        .clone()
        .or_else(|| entries.first().map(|entry| entry.node_id.clone()))
        .unwrap_or(fallback);
    Ok(Block {
        id,
        region: descriptor.region.clone(),
        read_only,
        content: EditorBlockContent {
            kind,
            level,
            inlines,
        },
        html: raw.to_string(),
        entries,
    })
}

type Marks = (bool, bool, Option<String>);

fn extract_marks(raw: &str) -> Result<HashMap<String, Marks>, HcdError> {
    let mut reader = Reader::from_str(raw);
    let mut buffer = Vec::new();
    let mut stack: Vec<Marks> = Vec::new();
    let mut marks = HashMap::new();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("editor mark parse error: {error}"))
        })?;
        let push = matches!(&event, Event::Start(_));
        match event {
            Event::Start(start) | Event::Empty(start) => {
                let name = tag_name(start.name().as_ref());
                let inherited = stack.last().cloned().unwrap_or((false, false, None));
                let style = attribute(&start, &reader, "style")?
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let weight = style.split(';').find_map(|declaration| {
                    declaration
                        .trim()
                        .strip_prefix("font-weight:")
                        .map(str::trim)
                });
                let bold = inherited.0
                    || name == "strong"
                    || weight.is_some_and(|value| {
                        value == "bold" || value.parse::<u16>().is_ok_and(|number| number >= 600)
                    });
                let italic = inherited.1 || name == "em" || style.contains("font-style:italic");
                let link = if name == "a" {
                    attribute(&start, &reader, "href")?
                } else {
                    inherited.2
                };
                if let Some(id) = attribute(&start, &reader, "data-hcd-id")? {
                    if attribute(&start, &reader, "data-hcd-node-hash")?.is_some() {
                        marks.insert(id, (bold, italic, link.clone()));
                    }
                }
                if push {
                    stack.push((bold, italic, link));
                }
            }
            Event::End(_) => {
                stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(marks)
}

fn tag_name(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_ascii_lowercase()
}

fn is_block_tag(
    name: &str,
    start: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
) -> Result<bool, HcdError> {
    if matches!(
        name,
        "p" | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "table"
            | "pre"
            | "blockquote"
            | "dl"
            | "figure"
            | "aside"
            | "details"
    ) {
        return Ok(true);
    }
    if name == "div" {
        return Ok(attribute(start, reader, "class")?.is_some_and(|value| {
            value
                .split_whitespace()
                .any(|class| class == "hcd-paragraph-group")
        }));
    }
    Ok(false)
}

fn attribute(
    start: &BytesStart<'_>,
    reader: &Reader<&[u8]>,
    key: &str,
) -> Result<Option<String>, HcdError> {
    for attribute in start.attributes().with_checks(true) {
        let attribute = attribute.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        if attribute.key.as_ref() == key.as_bytes() {
            return Ok(Some(
                attribute
                    .decode_and_unescape_value(reader.decoder())
                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}

pub fn apply_structure_patch(
    bundle: &Bundle,
    patch: &StructurePatchBatch,
    expected_revision: u64,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    let encoded = serde_json::to_vec(patch)?;
    if encoded.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(HcdError::ResourceLimit(
            "structure patch exceeds 8 MiB".to_string(),
        ));
    }
    let patch_hash = hash_bytes(&encoded);
    if patch.schema_version != HCD_PATCH_SCHEMA_VERSION_4
        || patch.document_id != manifest.document_id
        || patch.patch_id.is_empty()
        || patch.patch_id.len() > 256
        || patch.operations.is_empty()
        || patch.operations.len() > MAX_OPS
    {
        return Err(HcdError::InvalidPatch(
            "invalid hcd-patch/4 header".to_string(),
        ));
    }
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if record.patch_id.as_deref() == Some(&patch.patch_id) {
            if record.patch_hash.as_deref() != Some(&patch_hash) {
                return Err(HcdError::InvalidPatch(
                    "patchId reused with different content".to_string(),
                ));
            }
            return Ok(ApplyResult {
                document_id: record.document_id,
                patch_id: patch.patch_id.clone(),
                base_revision: record.patch_base_revision.unwrap_or(0),
                revision: record.revision,
                root_hash: record.root_hash,
                annotation_root_hash: record.annotation_root_hash,
                dirty_node_ids: record.dirty_node_ids,
                dirty_chunk_ids: record.dirty_chunk_ids,
                dirty_source_parts: record.dirty_source_parts,
                warnings: Vec::new(),
                idempotent_replay: true,
            });
        }
    }
    if !manifest.capabilities.structure_patch {
        return Err(HcdError::InvalidPatch(
            "run hdoc project-editor before hcd-patch/4".to_string(),
        ));
    }
    if manifest.revision != expected_revision || patch.base_revision != manifest.revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_revision}, patch base {}, actual {}",
            patch.base_revision, manifest.revision
        )));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit(
            "revision limit reached".to_string(),
        ));
    }
    let mut blocks = load_blocks(bundle, &manifest)?;
    let original_ids: HashSet<String> = blocks
        .iter()
        .flat_map(|block| block.entries.iter().map(|entry| entry.node_id.clone()))
        .collect();
    let mut dirty_nodes = HashSet::new();
    let mut dirty_parts = HashSet::new();
    for (operation_index, operation) in patch.operations.iter().enumerate() {
        apply_operation(
            &mut blocks,
            operation,
            operation_index,
            &manifest,
            &patch.patch_id,
            &mut dirty_nodes,
            &mut dirty_parts,
        )?;
    }
    if !blocks.iter().any(|block| block.region == "body") {
        return Err(HcdError::InvalidPatch(
            "cannot remove the final body block".to_string(),
        ));
    }
    if blocks.len() > MAX_BLOCKS {
        return Err(HcdError::ResourceLimit(
            "editor block limit reached".to_string(),
        ));
    }
    let remaining_ids: HashSet<String> = blocks
        .iter()
        .flat_map(|block| block.entries.iter().map(|entry| entry.node_id.clone()))
        .collect();
    for removed in original_ids.difference(&remaining_ids) {
        dirty_nodes.insert(removed.clone());
    }
    if remaining_ids.len()
        != blocks
            .iter()
            .map(|block| block.entries.len())
            .sum::<usize>()
    {
        return Err(HcdError::InvalidPatch(
            "duplicate canonical node ID".to_string(),
        ));
    }
    let revision = manifest.revision + 1;
    let (descriptors, index_root_href, dirty_chunks) =
        write_blocks(bundle, &manifest, revision, &blocks)?;
    let mut hasher = Sha256::new();
    for descriptor in &descriptors {
        hash_descriptor(&mut hasher, descriptor);
    }
    let asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let root_hash = finalize_root_hash(bundle, hasher, &asset_index_href)?;
    let (annotation_href, annotation_root_hash) =
        filter_annotations(bundle, &manifest, &remaining_ids)?;
    manifest.revision = revision;
    manifest.root_hash = root_hash.clone();
    manifest.annotation_href = annotation_href;
    manifest.annotation_root_hash = annotation_root_hash.clone();
    manifest.index_root_href = index_root_href;
    manifest.index_page_count = descriptors.len().div_ceil(INDEX_PAGE_SIZE);
    manifest.chunk_count = descriptors.len();
    manifest.capabilities.structure_patch = true;
    manifest.warnings.push(FidelityWarning {
        code: "HCD_STRUCTURE_SEMANTIC_REBUILD".to_string(),
        message: "structural edits are canonical in HCD; DOCX export rebuilds semantics and may change physical pagination".to_string(),
        node_id: None,
        source_part: None,
    });
    if let Some(report) = &mut manifest.fidelity {
        report.level = crate::FidelityLevel::Semantic;
    }
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch.patch_id,
        Some(patch_hash),
        true,
    )?;
    record.root_hash = root_hash.clone();
    record.annotation_root_hash = annotation_root_hash.clone();
    record.index_root_href = manifest.index_root_href.clone();
    record.index_page_count = Some(manifest.index_page_count);
    record.chunk_count = Some(manifest.chunk_count);
    record.dirty_node_ids = sorted(dirty_nodes);
    record.dirty_chunk_ids = dirty_chunks;
    record.dirty_source_parts = sorted(dirty_parts);
    let result = ApplyResult {
        document_id: manifest.document_id.clone(),
        patch_id: patch.patch_id.clone(),
        base_revision: patch.base_revision,
        revision,
        root_hash,
        annotation_root_hash,
        dirty_node_ids: record.dirty_node_ids.clone(),
        dirty_chunk_ids: record.dirty_chunk_ids.clone(),
        dirty_source_parts: record.dirty_source_parts.clone(),
        warnings: manifest.warnings.clone(),
        idempotent_replay: false,
    };
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(result)
}

fn sorted(values: HashSet<String>) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values
}

fn apply_operation(
    blocks: &mut Vec<Block>,
    operation: &StructureOperation,
    operation_index: usize,
    manifest: &HcdManifest,
    patch_id: &str,
    dirty_nodes: &mut HashSet<String>,
    dirty_parts: &mut HashSet<String>,
) -> Result<(), HcdError> {
    match operation {
        StructureOperation::Insert {
            after_block_id,
            block,
        } => {
            validate_content(block)?;
            let insertion = insertion_index(blocks, after_block_id.as_deref())?;
            if !insertion_touches_region(blocks, insertion, "body") {
                return Err(HcdError::Unsupported(
                    "cannot insert outside the body region".to_string(),
                ));
            }
            let id = stable_node_id(&[
                &manifest.document_id,
                patch_id,
                &operation_index.to_string(),
                "block",
            ]);
            if blocks.iter().any(|value| value.id == id) {
                return Err(HcdError::InvalidPatch(
                    "generated block ID collision".to_string(),
                ));
            }
            let generated =
                render_new_block(manifest, patch_id, operation_index, id, block.clone(), None)?;
            dirty_nodes.extend(generated.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(
                generated
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
            blocks.insert(insertion, generated);
        }
        StructureOperation::Delete {
            block_id,
            precondition,
        } => {
            let index = block_index(blocks, block_id, precondition)?;
            if blocks[index].read_only {
                return Err(HcdError::Unsupported(format!(
                    "block {block_id} is read-only"
                )));
            }
            let removed = blocks.remove(index);
            dirty_nodes.extend(removed.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(
                removed
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
        }
        StructureOperation::Move {
            block_id,
            after_block_id,
            precondition,
        } => {
            let index = block_index(blocks, block_id, precondition)?;
            if blocks[index].read_only || after_block_id.as_deref() == Some(block_id) {
                return Err(HcdError::Unsupported(
                    "invalid or read-only block move".to_string(),
                ));
            }
            let moved = blocks.remove(index);
            let insertion = insertion_index(blocks, after_block_id.as_deref())?;
            if !insertion_touches_region(blocks, insertion, &moved.region) {
                return Err(HcdError::Unsupported(
                    "cannot move between document regions".to_string(),
                ));
            }
            dirty_nodes.extend(moved.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(moved.entries.iter().map(|entry| entry.source.part.clone()));
            blocks.insert(insertion, moved);
        }
        StructureOperation::Replace {
            block_id,
            block,
            precondition,
        } => {
            validate_content(block)?;
            let index = block_index(blocks, block_id, precondition)?;
            if blocks[index].read_only {
                return Err(HcdError::Unsupported(format!(
                    "block {block_id} is read-only"
                )));
            }
            let old = &blocks[index];
            let first_node_id = old.entries.first().map(|entry| entry.node_id.clone());
            dirty_nodes.extend(old.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(old.entries.iter().map(|entry| entry.source.part.clone()));
            let generated = render_new_block(
                manifest,
                patch_id,
                operation_index,
                block_id.clone(),
                block.clone(),
                first_node_id,
            )?;
            dirty_nodes.extend(generated.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(
                generated
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
            blocks[index] = generated;
        }
    }
    Ok(())
}

fn block_index(
    blocks: &[Block],
    id: &str,
    precondition: &BlockPrecondition,
) -> Result<usize, HcdError> {
    let index = blocks
        .iter()
        .position(|block| block.id == id)
        .ok_or_else(|| HcdError::NodeNotFound(id.to_string()))?;
    if blocks[index].hash() != precondition.block_hash {
        return Err(HcdError::PreconditionFailed(format!(
            "block {id} hash mismatch"
        )));
    }
    Ok(index)
}

fn insertion_index(blocks: &[Block], after: Option<&str>) -> Result<usize, HcdError> {
    match after {
        None => Ok(blocks
            .iter()
            .position(|block| block.region == "body")
            .unwrap_or(blocks.len())),
        Some(id) => blocks
            .iter()
            .position(|block| block.id == id)
            .ok_or_else(|| HcdError::NodeNotFound(id.to_string()))
            .and_then(|index| {
                if blocks[index].region != "body" {
                    Err(HcdError::Unsupported(
                        "cannot use a non-body anchor".to_string(),
                    ))
                } else {
                    Ok(index + 1)
                }
            }),
    }
}

fn insertion_touches_region(blocks: &[Block], index: usize, region: &str) -> bool {
    blocks.is_empty()
        || blocks
            .get(index)
            .is_some_and(|block| block.region == region)
        || index
            .checked_sub(1)
            .and_then(|previous| blocks.get(previous))
            .is_some_and(|block| block.region == region)
}

fn validate_content(content: &EditorBlockContent) -> Result<(), HcdError> {
    match content.kind {
        EditorBlockKind::Paragraph if content.level.is_none() => {}
        EditorBlockKind::Heading if content.level.is_some_and(|level| (1..=6).contains(&level)) => {
        }
        EditorBlockKind::ListItem if content.level.is_some_and(|level| level <= 1) => {}
        _ => {
            return Err(HcdError::InvalidPatch(
                "unsupported block kind/level".to_string(),
            ))
        }
    }
    if content.inlines.len() > 1000 {
        return Err(HcdError::ResourceLimit("too many inline spans".to_string()));
    }
    let total = content.inlines.iter().try_fold(0usize, |total, inline| {
        let next = total
            .checked_add(inline.text.len())
            .ok_or_else(|| HcdError::ResourceLimit("inline text length overflow".to_string()))?;
        if inline.node_id.is_some() {
            return Err(HcdError::InvalidPatch(
                "client cannot assign canonical node IDs".to_string(),
            ));
        }
        if let Some(link) = &inline.link {
            if link.len() > 2048
                || !(link.starts_with("https://")
                    || link.starts_with("http://")
                    || link.starts_with("mailto:"))
            {
                return Err(HcdError::InvalidPatch("unsafe inline link".to_string()));
            }
        }
        Ok(next)
    })?;
    if total > MAX_INLINE_BYTES {
        return Err(HcdError::ResourceLimit(
            "block text exceeds 1 MiB".to_string(),
        ));
    }
    Ok(())
}

fn render_new_block(
    manifest: &HcdManifest,
    patch_id: &str,
    operation_index: usize,
    block_id: String,
    content: EditorBlockContent,
    first_node_id: Option<String>,
) -> Result<Block, HcdError> {
    let part = match manifest.source.format.as_str() {
        "docx" => "word/document.xml",
        "html" => "html/document",
        "md" => "markdown/document",
        "txt" => "text/document",
        _ => unreachable!("checked semantic-flow source format"),
    };
    let (tag, wrapper) = match content.kind {
        EditorBlockKind::Paragraph => ("p".to_string(), None),
        EditorBlockKind::Heading => (format!("h{}", content.level.unwrap_or(1)), None),
        EditorBlockKind::ListItem if content.level == Some(1) => ("li".to_string(), Some("ol")),
        EditorBlockKind::ListItem => ("li".to_string(), Some("ul")),
        EditorBlockKind::Opaque => {
            return Err(HcdError::InvalidPatch(
                "opaque content is not editable".to_string(),
            ))
        }
    };
    let mut html = String::new();
    if let Some(wrapper) = wrapper {
        html.push_str(&format!("<{wrapper} class=\"hcd-editor-list\">"));
    }
    html.push_str(&format!(
        "<{tag} class=\"hcd-editor-block\" data-hcd-id=\"{}\">",
        escape_html(&block_id)
    ));
    let mut entries = Vec::new();
    let inlines = if content.inlines.is_empty() {
        vec![EditorInline {
            text: String::new(),
            node_id: None,
            bold: false,
            italic: false,
            link: None,
        }]
    } else {
        content.inlines.clone()
    };
    for (inline_index, inline) in inlines.iter().enumerate() {
        let node_id = if inline_index == 0 {
            first_node_id.clone().unwrap_or_else(|| {
                stable_node_id(&[
                    &manifest.document_id,
                    patch_id,
                    &operation_index.to_string(),
                    "text-0",
                ])
            })
        } else {
            stable_node_id(&[
                &manifest.document_id,
                patch_id,
                &operation_index.to_string(),
                &format!("text-{inline_index}"),
            ])
        };
        let node_hash = hash_bytes(inline.text.as_bytes());
        if let Some(link) = &inline.link {
            html.push_str(&format!("<a href=\"{}\">", escape_html(link)));
        }
        if inline.bold {
            html.push_str("<strong>");
        }
        if inline.italic {
            html.push_str("<em>");
        }
        html.push_str(&format!(
            "<span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span>",
            escape_html(&inline.text)
        ));
        if inline.italic {
            html.push_str("</em>");
        }
        if inline.bold {
            html.push_str("</strong>");
        }
        if inline.link.is_some() {
            html.push_str("</a>");
        }
        entries.push(NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                source_cell_ref: None,
                created_in_hcd: false,
                part: part.to_string(),
                text_ordinal: manifest.revision * 1_000_000
                    + operation_index as u64 * 1000
                    + inline_index as u64
                    + 1,
                paragraph_id: Some(block_id.clone()),
                text_id: Some(format!(
                    "editor:{}",
                    &hash_bytes(format!("{patch_id}:{operation_index}:{inline_index}").as_bytes())
                        [..32]
                )),
                node_kind: "editor-text".to_string(),
                editable: true,
            },
        });
    }
    html.push_str(&format!("</{tag}>"));
    if let Some(wrapper) = wrapper {
        html.push_str(&format!("</{wrapper}>"));
    }
    Ok(Block {
        id: block_id,
        region: "body".to_string(),
        read_only: false,
        content,
        html,
        entries,
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexNode {
    first_page: usize,
    child_span: usize,
    children: Vec<String>,
}

type WrittenBlocks = (Vec<ChunkDescriptor>, Option<String>, Vec<String>);

fn write_blocks(
    bundle: &Bundle,
    manifest: &HcdManifest,
    revision: u64,
    blocks: &[Block],
) -> Result<WrittenBlocks, HcdError> {
    let mut previous = Vec::with_capacity(manifest.chunk_count);
    for page_number in 0..manifest.index_page_count {
        previous.extend(bundle.read_index_page(manifest, page_number)?.chunks);
    }
    if previous.len() != manifest.chunk_count {
        return Err(HcdError::InvalidBundle(
            "previous chunk count mismatch".to_string(),
        ));
    }
    let mut descriptors = Vec::new();
    let mut offset = 0;
    while offset < blocks.len() {
        let region = &blocks[offset].region;
        let mut end = offset;
        let mut bytes = 0usize;
        while end < blocks.len() && blocks[end].region == *region && end - offset < 256 {
            let next = bytes + blocks[end].html.len();
            if end > offset && next > CHUNK_SOFT_BYTES {
                break;
            }
            if next > MAX_CHUNK_BYTES.saturating_sub(1024) {
                return Err(HcdError::ResourceLimit(
                    "editor block exceeds HCD chunk limit".to_string(),
                ));
            }
            bytes = next;
            end += 1;
        }
        let sequence = descriptors.len();
        let chunk_id = stable_node_id(&[
            &manifest.document_id,
            &blocks[offset].id,
            &blocks[end - 1].id,
            region,
            "editor-chunk",
        ])
        .replacen("n_", "c_", 1);
        let mut html = format!(
            "<section class=\"hcd-chunk hcd-editor-chunk\" data-hcd-chunk-id=\"{chunk_id}\" data-hcd-region=\"{}\">",
            escape_html(region)
        );
        let mut entries = Vec::new();
        for block in &blocks[offset..end] {
            html.push_str(&block.html);
            entries.extend(block.entries.clone());
        }
        html.push_str("</section>");
        let canonical = extract_html_text_nodes(&html)?;
        if canonical.len() != entries.len()
            || entries.iter().any(|entry| {
                canonical
                    .get(&entry.node_id)
                    .is_none_or(|text| hash_bytes(text.as_bytes()) != entry.node_hash)
            })
        {
            return Err(HcdError::InvalidBundle(
                "editor HTML/source map mismatch".to_string(),
            ));
        }
        let source_map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: chunk_id.clone(),
            entries,
        };
        let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
        let (map_href, map_hash) = bundle.write_json_object("maps", &source_map)?;
        descriptors.push(ChunkDescriptor {
            sequence,
            chunk_id,
            region: region.clone(),
            html_href,
            html_hash,
            map_href,
            map_hash,
            byte_length: html.len() as u64,
            block_count: end - offset,
            node_count: source_map.entries.len(),
            text_chars: canonical.values().map(|text| text.chars().count()).sum(),
            node_bloom: node_bloom(
                source_map
                    .entries
                    .iter()
                    .map(|entry| entry.node_id.as_str()),
            ),
            first_node_id: source_map
                .entries
                .first()
                .map(|entry| entry.node_id.clone()),
            last_node_id: source_map.entries.last().map(|entry| entry.node_id.clone()),
            continuation: false,
            grid: None,
        });
        offset = end;
    }
    let dirty_chunks = descriptors
        .iter()
        .filter(|descriptor| {
            previous.get(descriptor.sequence).is_none_or(|old| {
                old.chunk_id != descriptor.chunk_id
                    || old.html_hash != descriptor.html_hash
                    || old.map_hash != descriptor.map_hash
            })
        })
        .map(|descriptor| descriptor.chunk_id.clone())
        .collect();
    let mut pages = Vec::new();
    for (page_number, chunk) in descriptors.chunks(INDEX_PAGE_SIZE).enumerate() {
        if chunk
            == previous
                .chunks(INDEX_PAGE_SIZE)
                .nth(page_number)
                .unwrap_or_default()
        {
            if let Some(root) = &manifest.index_root_href {
                pages.push(bundle.index_page_href(root, page_number)?);
                continue;
            }
        }
        let page = ChunkIndexPage {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            revision,
            page: page_number,
            chunks: chunk.to_vec(),
        };
        pages.push(bundle.write_json_object("indexes/pages", &page)?.0);
    }
    if pages.len() > 10_000 {
        return Err(HcdError::ResourceLimit(
            "index page limit exceeded".to_string(),
        ));
    }
    let mut children = pages;
    let mut child_span = 1usize;
    while !children.is_empty() {
        let mut parents = Vec::new();
        for (group, entries) in children.chunks(INDEX_PAGE_SIZE).enumerate() {
            let first_page = group * INDEX_PAGE_SIZE * child_span;
            let node = IndexNode {
                first_page,
                child_span,
                children: entries.to_vec(),
            };
            parents.push(bundle.write_json_object("indexes/nodes", &node)?.0);
        }
        if parents.len() == 1 {
            return Ok((descriptors, parents.pop(), dirty_chunks));
        }
        children = parents;
        child_span = child_span
            .checked_mul(INDEX_PAGE_SIZE)
            .ok_or_else(|| HcdError::ResourceLimit("index tree span overflow".to_string()))?;
    }
    Ok((descriptors, None, dirty_chunks))
}

fn filter_annotations(
    bundle: &Bundle,
    manifest: &HcdManifest,
    node_ids: &HashSet<String>,
) -> Result<(Option<String>, String), HcdError> {
    let Some(href) = &manifest.annotation_href else {
        return Ok((None, manifest.annotation_root_hash.clone()));
    };
    let mut set: AnnotationSet = read_json_bounded(
        &bundle.resolve_href(href)?,
        MAX_CONTROL_PART_BYTES,
        "annotations",
    )?;
    let before = set.annotations.len();
    set.annotations
        .retain(|annotation| node_ids.contains(&annotation.node_id));
    if set.annotations.len() == before {
        return Ok((Some(href.clone()), manifest.annotation_root_hash.clone()));
    }
    if set.annotations.is_empty() {
        return Ok((None, hash_bytes(b"[]")));
    }
    let (href, hash) = bundle.write_json_object("annotations", &set)?;
    Ok((Some(href), hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BundleWriter, HcdCapabilities, SourceDescriptor, StorageCodec};

    #[test]
    fn body_insert_can_use_the_boundary_before_a_footer() {
        let block = |id: &str, region: &str| Block {
            id: id.to_string(),
            region: region.to_string(),
            read_only: region != "body",
            content: EditorBlockContent {
                kind: EditorBlockKind::Paragraph,
                level: None,
                inlines: Vec::new(),
            },
            html: String::new(),
            entries: Vec::new(),
        };
        let blocks = vec![
            block("header", "header"),
            block("body", "body"),
            block("footer", "footer"),
        ];
        let insertion = insertion_index(&blocks, Some("body")).unwrap();
        assert_eq!(insertion, 2);
        assert!(insertion_touches_region(&blocks, insertion, "body"));
        assert!(!insertion_touches_region(&blocks, 0, "body"));
        assert!(!insertion_touches_region(&blocks, blocks.len(), "body"));
    }

    #[test]
    fn markdown_complex_blocks_do_not_hide_editable_paragraphs() {
        let values = ["Title", "Quoted", "Body", "Code", "Cell"];
        let entries: Vec<_> = values
            .iter()
            .enumerate()
            .map(|(index, value)| NodeMapEntry {
                node_id: format!("n_{index:032x}"),
                node_hash: hash_bytes(value.as_bytes()),
                source: SourceAnchor {
                    source_cell_ref: None,
                    created_in_hcd: false,
                    part: "markdown/document".to_string(),
                    text_ordinal: index as u64,
                    paragraph_id: None,
                    text_id: None,
                    node_kind: "text".to_string(),
                    editable: true,
                },
            })
            .collect();
        let span = |index: usize| {
            format!(
                "<span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span>",
                entries[index].node_id, entries[index].node_hash, values[index]
            )
        };
        let html = format!(
            "<section><h1>{}</h1><blockquote><p>{}</p></blockquote><p>{}</p><pre><code>{}</code></pre><table><tr><td>{}</td></tr></table></section>",
            span(0), span(1), span(2), span(3), span(4)
        );
        let chunk_id = "c_00000000000000000000000000000000".to_string();
        let descriptor = ChunkDescriptor {
            sequence: 0,
            chunk_id: chunk_id.clone(),
            region: "body".to_string(),
            html_href: String::new(),
            html_hash: hash_bytes(html.as_bytes()),
            map_href: String::new(),
            map_hash: String::new(),
            byte_length: html.len() as u64,
            block_count: 5,
            node_count: 5,
            text_chars: values.iter().map(|value| value.chars().count()).sum(),
            node_bloom: String::new(),
            first_node_id: None,
            last_node_id: None,
            continuation: false,
            grid: None,
        };
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id,
            entries,
        };
        let blocks = scan_chunk(&html, &map, &descriptor, "markdown-test").unwrap();
        assert_eq!(blocks.len(), 5);
        assert_eq!(blocks.iter().filter(|block| !block.read_only).count(), 2);
        assert_eq!(blocks[0].content.kind, EditorBlockKind::Heading);
        assert_eq!(blocks[2].content.kind, EditorBlockKind::Paragraph);
        assert!(blocks[1].read_only && blocks[3].read_only && blocks[4].read_only);
    }

    fn fixture() -> (tempfile::TempDir, Bundle) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("document.hcd");
        let mut writer = BundleWriter::create_with_codec(&path, StorageCodec::Gzip).unwrap();
        writer.write_styles("").unwrap();
        let mut html = String::new();
        let mut entries = Vec::new();
        let mut source_offset = 0usize;
        for number in 0..260 {
            let node_id = format!("n_{number:032x}");
            let value = format!("Paragraph {number}");
            let node_hash = hash_bytes(value.as_bytes());
            let source_end = source_offset + value.len();
            html.push_str(&format!("<p data-hcd-id=\"{node_id}\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{value}</span></p>"));
            entries.push(NodeMapEntry {
                node_id,
                node_hash,
                source: SourceAnchor {
                    source_cell_ref: None,
                    created_in_hcd: false,
                    part: "text/document".to_string(),
                    text_ordinal: number + 1,
                    paragraph_id: None,
                    text_id: Some(format!("bytes:{source_offset}:{source_end}")),
                    node_kind: "line".to_string(),
                    editable: true,
                },
            });
            source_offset = source_end;
        }
        writer
            .write_chunk(
                "c_00000000000000000000000000000000".to_string(),
                "body".to_string(),
                html,
                ChunkSourceMap {
                    schema_version: HCD_SCHEMA_VERSION.to_string(),
                    chunk_id: "c_00000000000000000000000000000000".to_string(),
                    entries,
                },
                260,
                false,
            )
            .unwrap();
        writer
            .finish(HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                storage_codec: StorageCodec::Gzip,
                document_id: "structure-fixture".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: SourceDescriptor {
                    format: "txt".to_string(),
                    sha256: "0".repeat(64),
                    size_bytes: source_offset as u64,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                capabilities: HcdCapabilities::default(),
                fidelity: None,
                state: "IMPORTING".to_string(),
                warnings: Vec::new(),
            })
            .unwrap();
        (temp, Bundle::open(path).unwrap())
    }

    fn replace(bundle: &Bundle, revision: u64, number: usize, value: &str) -> ApplyResult {
        let projection = editor_projection(bundle, Some(revision)).unwrap();
        let original = &projection.blocks[number];
        apply_structure_patch(
            bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
                document_id: projection.document_id,
                patch_id: format!("replace-{number}-{revision}"),
                base_revision: revision,
                operations: vec![StructureOperation::Replace {
                    block_id: original.block_id.clone(),
                    block: EditorBlockContent {
                        kind: EditorBlockKind::Paragraph,
                        level: None,
                        inlines: vec![EditorInline {
                            text: value.to_string(),
                            node_id: None,
                            bold: false,
                            italic: false,
                            link: None,
                        }],
                    },
                    precondition: BlockPrecondition {
                        block_hash: original.block_hash.clone(),
                    },
                }],
            },
            revision,
        )
        .unwrap()
    }

    #[test]
    fn structural_revisions_keep_history_and_reuse_untouched_chunk_objects() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        replace(&bundle, 1, 0, "First revision");
        let second = bundle.manifest().unwrap();
        assert_eq!(second.chunk_count, 2);
        let untouched = bundle.read_index_page(&second, 0).unwrap().chunks[1].clone();
        let third = replace(&bundle, 2, 1, "Second revision");
        assert_eq!(third.dirty_chunk_ids.len(), 1);
        let latest = bundle.manifest().unwrap();
        let reused = bundle.read_index_page(&latest, 0).unwrap().chunks[1].clone();
        assert_eq!(untouched.html_href, reused.html_href);
        assert_eq!(untouched.map_href, reused.map_href);
        assert_eq!(
            editor_projection(&bundle, Some(1)).unwrap().blocks[0]
                .content
                .inlines[0]
                .text,
            "Paragraph 0"
        );
        assert_eq!(
            editor_projection(&bundle, Some(2)).unwrap().blocks[0]
                .content
                .inlines[0]
                .text,
            "First revision"
        );
        assert_eq!(
            editor_projection(&bundle, Some(3)).unwrap().blocks[1]
                .content
                .inlines[0]
                .text,
            "Second revision"
        );
        let validation = crate::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
    }

    #[test]
    fn structural_patch_rejects_conflicts_and_unsafe_links() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let original = &projection.blocks[0];
        let patch = StructurePatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
            document_id: projection.document_id,
            patch_id: "conflict-test".to_string(),
            base_revision: 1,
            operations: vec![StructureOperation::Replace {
                block_id: original.block_id.clone(),
                block: EditorBlockContent {
                    kind: EditorBlockKind::Paragraph,
                    level: None,
                    inlines: vec![EditorInline {
                        text: "unsafe".to_string(),
                        node_id: None,
                        bold: false,
                        italic: false,
                        link: Some("javascript:alert(1)".to_string()),
                    }],
                },
                precondition: BlockPrecondition {
                    block_hash: original.block_hash.clone(),
                },
            }],
        };
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 0),
            Err(HcdError::RevisionConflict(_))
        ));
        assert!(matches!(
            apply_structure_patch(&bundle, &patch, 1),
            Err(HcdError::InvalidPatch(_))
        ));
        assert_eq!(bundle.manifest().unwrap().revision, 1);
    }

    #[test]
    fn restore_reuses_historical_index_and_passes_full_validation() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        replace(&bundle, 1, 0, "Edited text");
        let restored = crate::restore_revision(&bundle, 1, 2).unwrap();
        assert_eq!(restored.revision, 3);
        assert_eq!(
            bundle.revision(3).unwrap().index_root_href,
            bundle.revision(1).unwrap().index_root_href
        );
        assert_eq!(
            editor_projection(&bundle, Some(3)).unwrap().blocks[0]
                .content
                .inlines[0]
                .text,
            "Paragraph 0"
        );
        assert_eq!(
            editor_projection(&bundle, Some(2)).unwrap().blocks[0]
                .content
                .inlines[0]
                .text,
            "Edited text"
        );
        let validation = crate::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
    }
}
