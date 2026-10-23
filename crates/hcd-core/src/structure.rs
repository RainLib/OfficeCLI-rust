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
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;

const MAX_BLOCKS: usize = 1_000_000;
const MAX_INLINE_BYTES: usize = 1024 * 1024;
const MAX_OPS: usize = 10_000;
const CHUNK_SOFT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorInline {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default)]
    pub code: bool,
    #[serde(default)]
    pub hard_break: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<crate::NodeBorder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typography: Option<crate::TextTypography>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub font_size_explicit: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorBlockKind {
    #[default]
    Paragraph,
    Heading,
    ListItem,
    Opaque,
    CodeBlock,
    Blockquote,
    BulletList,
    OrderedList,
    HorizontalRule,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorBlockContent {
    pub kind: EditorBlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub inlines: Vec<EditorInline>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<EditorBlockContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_start: Option<u32>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracked_changes: Vec<TrackedChange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<CommentNote>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackedChange {
    pub change_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub text: String,
    pub block_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommentNote {
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_hash: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructurePatchBatch {
    pub schema_version: String,
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub actor: BTreeMap<String, String>,
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
    /// Mapped image geometry can share the block transaction and its revision.
    #[serde(rename = "image.geometry")]
    ImageGeometry {
        node_id: String,
        geometry: crate::ImageGeometry,
        precondition: crate::VisualPrecondition,
    },
    /// Asset and optional geometry share the original visual precondition.
    #[serde(rename = "image.replace")]
    ImageReplace {
        node_id: String,
        asset_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        geometry: Option<crate::ImageGeometry>,
        precondition: crate::VisualPrecondition,
    },
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

impl StructureOperation {
    fn is_image(&self) -> bool {
        matches!(self, Self::ImageGeometry { .. } | Self::ImageReplace { .. })
    }
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
    editor_projection_with_typography_styles(bundle, revision, "")
}

pub fn editor_projection_with_typography_styles(
    bundle: &Bundle,
    revision: Option<u64>,
    typography_styles: &str,
) -> Result<EditorProjection, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, revision) = crate::manifest_at_revision(bundle, &head, revision)?;
    ensure_semantic_flow(&manifest)?;
    let blocks = load_blocks_with_typography_styles(bundle, &manifest, typography_styles)?;
    Ok(EditorProjection {
        document_id: manifest.document_id,
        revision,
        tracked_changes: tracked_changes(&blocks)?,
        comments: comment_notes(&blocks),
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
        root_hash: manifest.root_hash.clone(),
        annotation_root_hash: manifest.annotation_root_hash.clone(),
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href: bundle.asset_index_href_for_revision(revision - 1)?,
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        structural_change,
        layout_upgrade: false,
        author_id: None,
        author_name: None,
    })
}

fn load_blocks(bundle: &Bundle, manifest: &HcdManifest) -> Result<Vec<Block>, HcdError> {
    load_blocks_with_typography_styles(bundle, manifest, "")
}

fn load_blocks_with_typography_styles(
    bundle: &Bundle,
    manifest: &HcdManifest,
    typography_styles: &str,
) -> Result<Vec<Block>, HcdError> {
    let mut stylesheet = String::new();
    fs::File::open(bundle.resolve_href(&manifest.styles_href)?)?
        .take(MAX_CONTROL_PART_BYTES + 1)
        .read_to_string(&mut stylesheet)?;
    if stylesheet.len() as u64 > MAX_CONTROL_PART_BYTES {
        return Err(HcdError::ResourceLimit(
            "editor stylesheet exceeds control-part limit".into(),
        ));
    }
    stylesheet.push('\n');
    stylesheet.push_str(typography_styles);
    let typography = crate::typography::TypographyResolver::new(&stylesheet)?;
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
            let fonts = typography.resolve(&html)?;
            let partitions = crate::extract_text_run_sizes(&html)?;
            let explicit: HashSet<_> = crate::text_runs::spans(&html)?
                .into_iter()
                .filter(|(_, span)| span.font_size_explicit)
                .map(|(id, _)| id)
                .collect();
            fn assign(
                content: &mut EditorBlockContent,
                fonts: &HashMap<String, crate::TextTypography>,
                partitions: &HashMap<String, Vec<crate::FontSizeRun>>,
                explicit: &HashSet<String>,
            ) {
                for inline in &mut content.inlines {
                    inline.font_size_explicit = inline
                        .node_id
                        .as_ref()
                        .is_some_and(|id| explicit.contains(id));
                    inline.typography = inline
                        .node_id
                        .as_deref()
                        .and_then(|id| fonts.get(id))
                        .cloned();
                }
                for child in &mut content.children {
                    assign(child, fonts, partitions, explicit);
                }
                content.inlines = std::mem::take(&mut content.inlines)
                    .into_iter()
                    .flat_map(|inline| {
                        let Some(runs) = inline.node_id.as_ref().and_then(|id| partitions.get(id))
                        else {
                            return vec![inline];
                        };
                        let mut characters = inline.text.chars();
                        runs.iter()
                            .map(|run| {
                                let mut part = inline.clone();
                                part.text = characters.by_ref().take(run.chars).collect();
                                if let Some(size) = run.size_pt {
                                    part.typography.get_or_insert_default().size_pt = Some(size);
                                }
                                part.font_size_explicit = run.size_pt.is_some();
                                part
                            })
                            .collect()
                    })
                    .collect();
            }
            for block in &mut parsed {
                assign(&mut block.content, &fonts, &partitions, &explicit);
            }

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
    list_start: Option<u32>,
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
    let mut lists: Vec<(usize, bool, u32)> = Vec::new();
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
                if name == "ol" || name == "ul" {
                    let number = attribute(&start, &reader, "start")?
                        .map(|number| number.parse::<u32>())
                        .transpose()
                        .map_err(|_| HcdError::InvalidBundle("invalid ordered list start".into()))?
                        .unwrap_or(1);
                    lists.push((stack.len() + 1, name == "ol", number));
                }
                let list_start = if name == "li" {
                    lists.last_mut().and_then(|(_, ordered, next)| {
                        let number = *next;
                        *next = next.saturating_add(1);
                        (*ordered).then_some(number)
                    })
                } else {
                    None
                };
                if open.is_none() && is_block_tag(&name, &start, &reader)? {
                    open = Some(OpenBlock {
                        start: before,
                        depth: stack.len() + 1,
                        id: attribute(&start, &reader, "data-hcd-id")?,
                        ordered: lists.last().is_some_and(|(_, ordered, _)| *ordered),
                        list_start,
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
                        ordered: lists.last().is_some_and(|(_, ordered, _)| *ordered),
                        list_start: lists
                            .last()
                            .and_then(|(_, ordered, next)| ordered.then_some(*next)),
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
                if lists
                    .last()
                    .is_some_and(|(depth, _, _)| *depth == stack.len())
                {
                    lists.pop();
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
                    text_color: None,
                    background_color: None,
                    border: None,
                    ..Default::default()
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
                ..Default::default()
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
                    bold: mark.is_some_and(|value| value.bold),
                    italic: mark.is_some_and(|value| value.italic),
                    underline: mark.is_some_and(|value| value.underline),
                    strike: mark.is_some_and(|value| value.strike),
                    code: mark.is_some_and(|value| value.code),
                    hard_break: false,
                    link: mark.and_then(|value| value.link.clone()),
                    text_color: mark.and_then(|value| value.text_color.clone()),
                    background_color: mark.and_then(|value| value.background_color.clone()),
                    border: mark.and_then(|value| value.border.clone()),
                    typography: None,
                    font_size_explicit: false,
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
    let mut content = if raw
        .split('>')
        .next()
        .is_some_and(|tag| tag.contains("data-hcd-editor-kind="))
        || kind == EditorBlockKind::ListItem
            && (raw.contains("<ul") || raw.contains("<ol") || raw.contains("<p"))
    {
        parse_editor_tree(raw, &nodes, &marks)?
    } else {
        EditorBlockContent {
            kind,
            level,
            list_start: (kind == EditorBlockKind::ListItem)
                .then_some(open.list_start)
                .flatten(),
            inlines,
            ..Default::default()
        }
    };
    if kind == EditorBlockKind::ListItem {
        content.level = level;
        content.list_start = open.list_start.or(content.list_start);
    }
    let read_only = descriptor.region != "body"
        || matches!(content.kind, EditorBlockKind::Opaque)
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
        content,
        html: raw.to_string(),
        entries,
    })
}

fn parse_editor_tree(
    raw: &str,
    texts: &BTreeMap<String, String>,
    marks: &HashMap<String, Marks>,
) -> Result<EditorBlockContent, HcdError> {
    fn kind_of(node: roxmltree::Node<'_, '_>, infer: bool) -> Option<EditorBlockKind> {
        if let Some(kind) = node.attribute("data-hcd-editor-kind") {
            return serde_json::from_value(serde_json::Value::String(kind.into())).ok();
        }
        if !infer {
            return None;
        }
        Some(match node.tag_name().name() {
            "p" => EditorBlockKind::Paragraph,
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => EditorBlockKind::Heading,
            "li" => EditorBlockKind::ListItem,
            "ul" => EditorBlockKind::BulletList,
            "ol" => EditorBlockKind::OrderedList,
            "blockquote" => EditorBlockKind::Blockquote,
            "pre" => EditorBlockKind::CodeBlock,
            "hr" => EditorBlockKind::HorizontalRule,
            _ => return None,
        })
    }
    fn parse(
        node: roxmltree::Node<'_, '_>,
        texts: &BTreeMap<String, String>,
        marks: &HashMap<String, Marks>,
        depth: usize,
        infer: bool,
    ) -> Result<EditorBlockContent, HcdError> {
        if depth > 24 {
            return Err(HcdError::ResourceLimit("editor tree is too deep".into()));
        }
        let kind = kind_of(node, infer)
            .ok_or_else(|| HcdError::InvalidBundle("unknown editor block kind".into()))?;
        let mut content = EditorBlockContent {
            kind,
            level: node
                .attribute("data-hcd-editor-level")
                .map(str::parse)
                .transpose()
                .map_err(|_| HcdError::InvalidBundle("invalid editor level".into()))?,
            language: node.attribute("data-hcd-code-language").map(str::to_owned),
            list_start: node
                .attribute("data-hcd-list-start")
                .map(str::parse)
                .transpose()
                .map_err(|_| HcdError::InvalidBundle("invalid list start".into()))?,
            ..Default::default()
        };
        if infer {
            content.level = match kind {
                EditorBlockKind::Heading => node.tag_name().name()[1..].parse().ok(),
                EditorBlockKind::ListItem => Some(u8::from(
                    node.ancestors()
                        .skip(1)
                        .find(|parent| {
                            parent.is_element() && matches!(parent.tag_name().name(), "ul" | "ol")
                        })
                        .is_some_and(|parent| parent.tag_name().name() == "ol"),
                )),
                _ => None,
            };
            if kind == EditorBlockKind::OrderedList {
                content.list_start = Some(
                    node.attribute("start")
                        .unwrap_or("1")
                        .parse()
                        .map_err(|_| HcdError::InvalidBundle("invalid list start".into()))?,
                );
            }
        }
        for child in node
            .descendants()
            .skip(1)
            .filter(|child| child.is_element())
        {
            let owner = child
                .ancestors()
                .skip(1)
                .find(|parent| kind_of(*parent, infer).is_some());
            if owner != Some(node) {
                continue;
            }
            if kind_of(child, infer).is_some() {
                if matches!(
                    kind,
                    EditorBlockKind::ListItem | EditorBlockKind::Blockquote
                ) && !content.inlines.is_empty()
                {
                    content.children.push(EditorBlockContent {
                        inlines: std::mem::take(&mut content.inlines),
                        ..Default::default()
                    });
                }
                content
                    .children
                    .push(parse(child, texts, marks, depth + 1, infer)?);
            } else if infer && child.tag_name().name() == "br" {
                content.inlines.push(EditorInline {
                    text: "\n".into(),
                    hard_break: true,
                    ..Default::default()
                });
            } else if child.attribute("data-hcd-node-hash").is_some()
                && kind != EditorBlockKind::HorizontalRule
            {
                let id = child
                    .attribute("data-hcd-id")
                    .ok_or_else(|| HcdError::InvalidBundle("editor text has no ID".into()))?;
                let text = texts
                    .get(id)
                    .ok_or_else(|| HcdError::NodeNotFound(id.into()))?
                    .clone();
                let mark = marks.get(id);
                content.inlines.push(EditorInline {
                    text,
                    node_id: Some(id.into()),
                    bold: mark.is_some_and(|mark| mark.bold),
                    italic: mark.is_some_and(|mark| mark.italic),
                    underline: mark.is_some_and(|mark| mark.underline),
                    strike: mark.is_some_and(|mark| mark.strike),
                    code: mark.is_some_and(|mark| mark.code) && kind != EditorBlockKind::CodeBlock,
                    hard_break: child.attribute("data-hcd-hard-break") == Some("true"),
                    link: mark.and_then(|mark| mark.link.clone()),
                    text_color: mark.and_then(|mark| mark.text_color.clone()),
                    background_color: mark.and_then(|mark| mark.background_color.clone()),
                    border: mark.and_then(|mark| mark.border.clone()),
                    typography: None,
                    font_size_explicit: false,
                });
            }
        }
        if !content.children.is_empty() && !content.inlines.is_empty() {
            content.children.push(EditorBlockContent {
                inlines: std::mem::take(&mut content.inlines),
                ..Default::default()
            });
        }
        if kind == EditorBlockKind::ListItem
            && !content.children.is_empty()
            && content.children[0].kind != EditorBlockKind::Paragraph
        {
            content.children.insert(0, EditorBlockContent::default());
        }
        if kind == EditorBlockKind::ListItem
            && content.children.len() == 1
            && content.children[0].kind == EditorBlockKind::Paragraph
        {
            content.inlines = std::mem::take(&mut content.children[0].inlines);
            content.children.clear();
        }
        Ok(content)
    }
    let doc = roxmltree::Document::parse(raw)
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    let infer = doc
        .root_element()
        .attribute("data-hcd-editor-kind")
        .is_none();
    parse(doc.root_element(), texts, marks, 0, infer)
}

#[derive(Clone)]
struct Marks {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
    text_color: Option<String>,
    background_color: Option<String>,
    border: Option<crate::NodeBorder>,
}

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
                let inherited = stack.last().cloned().unwrap_or(Marks {
                    bold: false,
                    italic: false,
                    underline: false,
                    strike: false,
                    code: false,
                    link: None,
                    text_color: None,
                    background_color: None,
                    border: None,
                });
                let style = attribute(&start, &reader, "style")?
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let weight = style.split(';').find_map(|declaration| {
                    declaration
                        .trim()
                        .strip_prefix("font-weight:")
                        .map(str::trim)
                });
                let bold = inherited.bold
                    || name == "strong"
                    || weight.is_some_and(|value| {
                        value == "bold" || value.parse::<u16>().is_ok_and(|number| number >= 600)
                    });
                let italic =
                    inherited.italic || name == "em" || style.contains("font-style:italic");
                let link = if name == "a" {
                    attribute(&start, &reader, "href")?
                } else {
                    inherited.link.clone()
                };
                let text_color = css_hex_color(&style, "color").or(inherited.text_color.clone());
                let background_color = css_hex_color(&style, "background-color")
                    .or(inherited.background_color.clone());
                let border = css_border(&style);
                let current = Marks {
                    bold,
                    italic,
                    underline: inherited.underline || name == "u",
                    strike: inherited.strike
                        || name == "s"
                        || name == "del" && !raw.contains("data-hcd-revision"),
                    code: inherited.code || name == "code",
                    link,
                    text_color,
                    background_color,
                    border,
                };
                if let Some(id) = attribute(&start, &reader, "data-hcd-id")? {
                    if attribute(&start, &reader, "data-hcd-node-hash")?.is_some() {
                        marks.insert(id, current.clone());
                    }
                }
                if push {
                    stack.push(current);
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

fn validate_editor_color(name: &str, color: &str) -> Result<(), HcdError> {
    if color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(());
    }
    Err(HcdError::InvalidPatch(format!(
        "{name} must be a #RRGGBB color"
    )))
}

fn css_border(style: &str) -> Option<crate::NodeBorder> {
    let value = style.split(';').find_map(|declaration| {
        declaration
            .trim()
            .strip_prefix("border-top:")
            .map(str::trim)
    })?;
    let mut parts = value.split_whitespace();
    let width = parts.next()?.strip_suffix("pt")?.parse::<f32>().ok()?;
    let kind = match parts.next()? {
        "solid" => crate::NodeBorderStyle::Solid,
        "dashed" => crate::NodeBorderStyle::Dashed,
        "dotted" => crate::NodeBorderStyle::Dotted,
        "double" => crate::NodeBorderStyle::Double,
        _ => return None,
    };
    let color = css_hex_color(&format!("color:{};", parts.next()?), "color")?;
    (width.is_finite() && width > 0.0 && width <= 12.0).then_some(crate::NodeBorder {
        color,
        width_pt: width,
        style: kind,
    })
}

fn css_hex_color(style: &str, property: &str) -> Option<String> {
    let prefix = format!("{property}:");
    style.split(';').find_map(|declaration| {
        let value = declaration.trim().strip_prefix(&prefix)?.trim();
        (value.len() == 7
            && value.starts_with('#')
            && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
    })
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
        if attribute(start, reader, "data-hcd-editor-kind")?.is_some() {
            return Ok(true);
        }
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
    let original_hashes: HashMap<String, String> = blocks
        .iter()
        .flat_map(|block| {
            block
                .entries
                .iter()
                .map(|entry| (entry.node_id.clone(), entry.node_hash.clone()))
        })
        .collect();
    let mut dirty_nodes = HashSet::new();
    let mut dirty_parts = HashSet::new();
    let mut image_ids = HashSet::new();
    let mut asset_index = bundle.read_asset_index_for_revision(manifest.revision)?;
    let indexed_asset_count = asset_index.len();
    let mut assets: HashMap<String, crate::AssetDescriptor> = asset_index
        .iter()
        .map(|asset| (asset.hash.clone(), asset.clone()))
        .collect();
    let mut validated_assets = HashSet::new();
    for operation in &patch.operations {
        if let StructureOperation::ImageGeometry { node_id, .. }
        | StructureOperation::ImageReplace { node_id, .. } = operation
        {
            if !image_ids.insert(node_id.as_str()) {
                return Err(HcdError::InvalidPatch(
                    "duplicate image target in structure batch; combine replacement and geometry"
                        .into(),
                ));
            }
        }
        if let StructureOperation::ImageReplace { asset_hash, .. } = operation {
            crate::patch::validate_sha256("assetHash", asset_hash)?;
            if !validated_assets.insert(asset_hash) {
                continue;
            }
            let asset = match assets.get(asset_hash) {
                Some(asset) => asset.clone(),
                None => bundle.staged_asset(asset_hash)?,
            };
            crate::patch::validate_staged_asset(bundle, &asset, asset_hash)?;
            if !assets.contains_key(asset_hash) {
                asset_index.push(asset.clone());
                assets.insert(asset_hash.clone(), asset);
            }
        }
    }
    let context = OperationContext {
        manifest: &manifest,
        patch_id: &patch.patch_id,
        assets: &assets,
    };
    // Resolve block preconditions against the original block HTML. Images are
    // applied last, so a removed image aborts the entire batch instead of losing
    // an earlier image edit, and image changes cannot invalidate block hashes.
    for (operation_index, operation) in patch
        .operations
        .iter()
        .enumerate()
        .filter(|(_, operation)| !operation.is_image())
        .chain(
            patch
                .operations
                .iter()
                .enumerate()
                .filter(|(_, operation)| operation.is_image()),
        )
    {
        apply_operation(
            &mut blocks,
            operation,
            operation_index,
            &context,
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
    let asset_index_href = if asset_index.len() == indexed_asset_count {
        bundle.asset_index_href_for_revision(manifest.revision)?
    } else {
        asset_index.sort_by(|left, right| left.hash.cmp(&right.hash));
        bundle.write_json_object("assets/indexes", &asset_index)?.0
    };
    let root_hash = finalize_root_hash(bundle, hasher, &asset_index_href)?;
    let unchanged_ids = blocks
        .iter()
        .flat_map(|block| &block.entries)
        .filter(|entry| original_hashes.get(&entry.node_id) == Some(&entry.node_hash))
        .map(|entry| entry.node_id.clone())
        .collect();
    let (annotation_href, annotation_root_hash) =
        filter_annotations(bundle, &manifest, &unchanged_ids)?;
    manifest.revision = revision;
    manifest.root_hash = root_hash.clone();
    manifest.annotation_href = annotation_href;
    manifest.annotation_root_hash = annotation_root_hash.clone();
    manifest.index_root_href = index_root_href;
    manifest.index_page_count = descriptors.len().div_ceil(INDEX_PAGE_SIZE);
    manifest.chunk_count = descriptors.len();
    manifest.capabilities.structure_patch = true;
    let structural_change = patch
        .operations
        .iter()
        .any(|operation| !operation.is_image());
    if structural_change {
        manifest.warnings.push(FidelityWarning {
        code: "HCD_STRUCTURE_SEMANTIC_REBUILD".to_string(),
        message: "structural edits are canonical in HCD; DOCX export rebuilds semantics and may change physical pagination".to_string(),
        node_id: None,
        source_part: None,
    });
        if let Some(report) = &mut manifest.fidelity {
            report.level = crate::FidelityLevel::Semantic;
        }
    }
    if blocks.iter().any(|block| {
        block.content.inlines.iter().any(|inline| {
            inline.text_color.is_some()
                || inline.background_color.is_some()
                || inline.border.is_some()
        })
    }) {
        manifest.capabilities.style_patch = true;
    }
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch.patch_id,
        Some(patch_hash),
        structural_change,
    )?;
    let (author_id, author_name) = crate::revision_author(&patch.actor)?;
    record.author_id = author_id;
    record.author_name = author_name;
    record.root_hash = root_hash.clone();
    record.asset_index_href = asset_index_href;
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

pub fn resolve_tracked_change(
    bundle: &Bundle,
    expected_revision: u64,
    change_id: &str,
    accept: bool,
    patch_id: &str,
    actor: &BTreeMap<String, String>,
) -> Result<ApplyResult, HcdError> {
    validate_change_id(change_id)?;
    let payload = serde_json::json!({
        "op": "tracked.resolve",
        "changeId": change_id,
        "action": if accept { "accept" } else { "reject" },
        "patchId": patch_id,
    });
    rewrite_indexed_chunks(
        bundle,
        expected_revision,
        patch_id,
        &payload,
        actor,
        RewritePolicy { structural_change: true, warning: FidelityWarning {
            code: "TRACKED_CHANGE_SOURCE_EXPORT_REJECTED".to_string(),
            message: "accepting or rejecting a tracked change rewrites the HCD page; source-backed export cannot update the original revision markup and is rejected".to_string(),
            node_id: None,
            source_part: None,
        }, not_found: "tracked change was not found" },
        |_, html, map, dirty| resolve_change_in_chunk(html, map, dirty, change_id, accept),
    )
}

pub fn append_comment(
    bundle: &Bundle,
    expected_revision: u64,
    text: &str,
    patch_id: &str,
    actor: &BTreeMap<String, String>,
) -> Result<ApplyResult, HcdError> {
    let text = text.trim();
    if text.is_empty() || text.len() > 4_000 || text.chars().any(char::is_control) {
        return Err(HcdError::InvalidPatch(
            "comment text must be 1 to 4000 characters without control characters".to_string(),
        ));
    }
    let text = text.to_string();
    let payload = serde_json::json!({
        "op": "comment.append",
        "text": text,
        "patchId": patch_id,
    });
    let mut placed = false;
    rewrite_indexed_chunks(
        bundle,
        expected_revision,
        patch_id,
        &payload,
        actor,
        RewritePolicy { structural_change: true, warning: FidelityWarning {
            code: "COMMENT_REPLY_SEMANTIC".to_string(),
            message: "comment replies are stored in the imported comment region; source-backed export does not append Word comment parts".to_string(),
            node_id: None,
            source_part: None,
        }, not_found: "this document has no imported comment region to reply in" },
        |descriptor, html, map, dirty| {
            if placed || descriptor.region != "comment" {
                return Ok(false);
            }
            placed = true;
            append_comment_paragraph(html, map, dirty, &text, patch_id)
        },
    )
}

fn resolve_change_in_chunk(
    html: &mut String,
    map: &mut ChunkSourceMap,
    dirty: &mut RevisionDirty,
    change_id: &str,
    accept: bool,
) -> Result<bool, HcdError> {
    let marker = format!("data-hcd-revision-id=\"{}\"", escape_html(change_id));
    if !html.contains(&marker) {
        return Ok(false);
    }
    let mut changed = false;
    loop {
        let Some(span) = first_revision_span(html, &marker)? else {
            break;
        };
        let inner = html[span.open_end..span.close_start].to_string();
        let inner_nodes = extract_html_text_nodes(&inner).unwrap_or_default();
        let replacement = match (accept, span.kind.as_str()) {
            (true, "insert" | "moveTo") => {
                for node_id in inner_nodes.keys() {
                    dirty.nodes.insert(node_id.clone());
                }
                inner
            }
            (false, "insert" | "moveTo") => {
                for node_id in inner_nodes.keys() {
                    dirty.nodes.insert(node_id.clone());
                }
                String::new()
            }
            (true, "delete" | "moveFrom") => {
                if !inner_nodes.is_empty() {
                    return Err(HcdError::Unsupported(
                        "a deletion that contains canonical text cannot be accepted".to_string(),
                    ));
                }
                String::new()
            }
            (false, "delete" | "moveFrom") => {
                let restored = visible_text(&inner)?;
                let node_id = stable_node_id(&["restored", change_id, &span.start.to_string()]);
                let node_hash = hash_bytes(restored.as_bytes());
                let anchor = map.entries.first().cloned().ok_or_else(|| {
                    HcdError::Unsupported(
                        "rejected deletion needs a neighboring text node".to_string(),
                    )
                })?;
                map.entries.push(NodeMapEntry {
                    node_id: node_id.clone(),
                    node_hash: node_hash.clone(),
                    source: SourceAnchor {
                        part: anchor.source.part.clone(),
                        text_ordinal: anchor.source.text_ordinal.saturating_add(1).max(1),
                        paragraph_id: anchor.source.paragraph_id.clone(),
                        text_id: Some(format!("restored:{change_id}")),
                        node_kind: "restored-text".to_string(),
                        editable: true,
                    },
                });
                dirty.nodes.insert(node_id.clone());
                dirty.parts.insert(anchor.source.part);
                format!(
                    "<span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span>",
                    escape_html(&restored)
                )
            }
            _ => {
                return Err(HcdError::Unsupported(format!(
                    "unsupported tracked change kind {}",
                    span.kind
                )))
            }
        };
        html.replace_range(span.start..span.end, &replacement);
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    let canonical = extract_html_text_nodes(html)?;
    for entry in &map.entries {
        if !canonical.contains_key(&entry.node_id) {
            dirty.nodes.insert(entry.node_id.clone());
            dirty.parts.insert(entry.source.part.clone());
        }
    }
    map.entries
        .retain(|entry| canonical.contains_key(&entry.node_id));
    for entry in &mut map.entries {
        let text = canonical.get(&entry.node_id).ok_or_else(|| {
            HcdError::InvalidBundle(format!(
                "tracked change left node {} out of the source map",
                entry.node_id
            ))
        })?;
        entry.node_hash = hash_bytes(text.as_bytes());
        dirty.parts.insert(entry.source.part.clone());
    }
    if dirty.nodes.is_empty() {
        if let Some(entry) = map.entries.first() {
            dirty.nodes.insert(entry.node_id.clone());
            dirty.parts.insert(entry.source.part.clone());
        }
    }
    Ok(true)
}

fn append_comment_paragraph(
    html: &mut String,
    map: &mut ChunkSourceMap,
    dirty: &mut RevisionDirty,
    text: &str,
    patch_id: &str,
) -> Result<bool, HcdError> {
    let anchor = map.entries.last().cloned().ok_or_else(|| {
        HcdError::Unsupported("comment region has no text node to attach a reply".to_string())
    })?;
    let node_id = stable_node_id(&["comment", patch_id, &anchor.node_id]);
    let node_hash = hash_bytes(text.as_bytes());
    let paragraph = format!(
        "<p data-hcd-id=\"{node_id}\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\">{}</span></p>",
        escape_html(text)
    );
    if let Some(close) = html.rfind("</section>") {
        html.insert_str(close, &paragraph);
    } else {
        html.push_str(&paragraph);
    }
    map.entries.push(NodeMapEntry {
        node_id: node_id.clone(),
        node_hash,
        source: SourceAnchor {
            part: anchor.source.part.clone(),
            text_ordinal: anchor.source.text_ordinal.saturating_add(1).max(1),
            paragraph_id: Some(node_id.clone()),
            text_id: Some(format!("comment:{patch_id}")),
            node_kind: "comment-text".to_string(),
            editable: true,
        },
    });
    dirty.nodes.insert(node_id);
    dirty.parts.insert(anchor.source.part);
    Ok(true)
}

struct RevisionDirty {
    nodes: HashSet<String>,
    parts: HashSet<String>,
}

struct RewritePolicy<'a> {
    structural_change: bool,
    warning: FidelityWarning,
    not_found: &'a str,
}

fn rewrite_indexed_chunks(
    bundle: &Bundle,
    expected_revision: u64,
    patch_id: &str,
    payload: &serde_json::Value,
    actor: &BTreeMap<String, String>,
    policy: RewritePolicy<'_>,
    mut edit: impl FnMut(
        &ChunkDescriptor,
        &mut String,
        &mut ChunkSourceMap,
        &mut RevisionDirty,
    ) -> Result<bool, HcdError>,
) -> Result<ApplyResult, HcdError> {
    if patch_id.trim().is_empty() || patch_id.len() > 256 {
        return Err(HcdError::InvalidPatch(
            "patchId must be 1 to 256 bytes".to_string(),
        ));
    }
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(format!(
            "expected head {expected_revision}, actual {}",
            manifest.revision
        )));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit(
            "revision limit reached".to_string(),
        ));
    }
    let patch_hash = hash_bytes(&serde_json::to_vec(payload)?);
    if let Some(result) =
        crate::patch::find_idempotent_result(bundle, &manifest, patch_id, &patch_hash)?
    {
        return Ok(result);
    }
    let new_revision = manifest.revision + 1;
    let new_index_prefix = format!("indexes/rev-{new_revision:020}");
    let new_index_root = bundle.root().join(&new_index_prefix);
    let mut index_root_href = manifest.index_root_href.clone();
    if index_root_href.is_none() {
        fs::create_dir_all(&new_index_root)?;
    }
    let mut dirty = RevisionDirty {
        nodes: HashSet::new(),
        parts: HashSet::new(),
    };
    let mut dirty_chunks = HashSet::new();
    let mut root_hasher = Sha256::new();
    let mut matched = false;
    let mut unchanged_annotation_nodes = HashSet::new();
    for page_number in 0..manifest.index_page_count {
        let mut page = bundle.read_index_page(&manifest, page_number)?;
        let mut page_changed = false;
        for descriptor in &mut page.chunks {
            let mut html = bundle.read_chunk(descriptor)?;
            let mut source_map = bundle.read_map(descriptor)?;
            let original_hashes: HashMap<_, _> = source_map
                .entries
                .iter()
                .map(|entry| (entry.node_id.clone(), entry.node_hash.clone()))
                .collect();
            if edit(descriptor, &mut html, &mut source_map, &mut dirty)? {
                let canonical = extract_html_text_nodes(&html)?;
                if canonical.len() != source_map.entries.len()
                    || source_map.entries.iter().any(|entry| {
                        canonical
                            .get(&entry.node_id)
                            .is_none_or(|text| hash_bytes(text.as_bytes()) != entry.node_hash)
                    })
                {
                    return Err(HcdError::InvalidBundle(
                        "tracked-change HTML no longer matches its source map".to_string(),
                    ));
                }
                let (html_href, html_hash) = bundle.write_chunk_object(&html)?;
                let (map_href, map_hash) = bundle.write_json_object("maps", &source_map)?;
                descriptor.html_href = html_href;
                descriptor.html_hash = html_hash;
                descriptor.map_href = map_href;
                descriptor.map_hash = map_hash;
                descriptor.byte_length = html.len() as u64;
                descriptor.node_count = source_map.entries.len();
                descriptor.text_chars = canonical.values().map(|text| text.chars().count()).sum();
                descriptor.node_bloom = crate::node_bloom(
                    source_map
                        .entries
                        .iter()
                        .map(|entry| entry.node_id.as_str()),
                );
                descriptor.first_node_id = source_map
                    .entries
                    .first()
                    .map(|entry| entry.node_id.clone());
                descriptor.last_node_id =
                    source_map.entries.last().map(|entry| entry.node_id.clone());
                dirty_chunks.insert(descriptor.chunk_id.clone());
                page_changed = true;
                matched = true;
            }
            unchanged_annotation_nodes.extend(
                source_map
                    .entries
                    .iter()
                    .filter(|entry| original_hashes.get(&entry.node_id) == Some(&entry.node_hash))
                    .map(|entry| entry.node_id.clone()),
            );
            hash_descriptor(&mut root_hasher, descriptor);
        }
        if page_changed {
            page.revision = new_revision;
            if let Some(root) = &index_root_href {
                index_root_href = Some(bundle.replace_index_page(root, page_number, &page)?);
            } else {
                let path = new_index_root.join(format!(
                    "{page_number:06}.json{}",
                    manifest.storage_codec.suffix()
                ));
                crate::bundle::atomic_write_json_encoded(&path, &page)?;
            }
        }
    }
    if !matched || dirty.nodes.is_empty() || dirty.parts.is_empty() || dirty_chunks.is_empty() {
        return Err(HcdError::InvalidPatch(policy.not_found.to_string()));
    }
    let asset_index_href = bundle.asset_index_href_for_revision(manifest.revision)?;
    let root_hash = finalize_root_hash(bundle, root_hasher, &asset_index_href)?;
    let (annotation_href, annotation_root_hash) =
        filter_annotations(bundle, &manifest, &unchanged_annotation_nodes)?;
    manifest.annotation_href = annotation_href;
    manifest.annotation_root_hash = annotation_root_hash;
    manifest.revision = new_revision;
    manifest.root_hash = root_hash.clone();
    if index_root_href.is_some() {
        manifest.index_root_href = index_root_href;
    } else {
        manifest.index_prefix = new_index_prefix;
    }
    let mut record = revision_record(
        bundle,
        &manifest,
        new_revision,
        patch_id,
        Some(patch_hash),
        policy.structural_change,
    )?;
    let (author_id, author_name) = crate::revision_author(actor)?;
    record.author_id = author_id;
    record.author_name = author_name;
    record.root_hash = root_hash.clone();
    record.index_root_href = manifest.index_root_href.clone();
    record.index_prefix = manifest.index_prefix.clone();
    record.dirty_node_ids = sorted(dirty.nodes);
    record.dirty_chunk_ids = sorted(dirty_chunks);
    record.dirty_source_parts = sorted(dirty.parts);
    let result = ApplyResult {
        document_id: manifest.document_id.clone(),
        patch_id: patch_id.to_string(),
        base_revision: expected_revision,
        revision: new_revision,
        root_hash,
        annotation_root_hash: record.annotation_root_hash.clone(),
        dirty_node_ids: record.dirty_node_ids.clone(),
        dirty_chunk_ids: record.dirty_chunk_ids.clone(),
        dirty_source_parts: record.dirty_source_parts.clone(),
        warnings: vec![policy.warning],
        idempotent_replay: false,
    };
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(result)
}

fn tracked_changes(blocks: &[Block]) -> Result<Vec<TrackedChange>, HcdError> {
    let mut grouped = BTreeMap::<(String, String), TrackedChange>::new();
    for block in blocks {
        let marker_prefix = "data-hcd-revision-id=\"";
        let mut search = 0usize;
        while let Some(found) = block.html[search..].find(marker_prefix) {
            let id_start = search + found + marker_prefix.len();
            let id_end = block.html[id_start..]
                .find('"')
                .map(|offset| id_start + offset)
                .ok_or_else(|| {
                    HcdError::InvalidBundle("tracked change id is not quoted".to_string())
                })?;
            let change_id = block.html[id_start..id_end].to_string();
            let marker = format!("data-hcd-revision-id=\"{change_id}\"");
            let Some(span) = first_revision_span(&block.html[search..], &marker)? else {
                break;
            };
            let span = RevisionSpan {
                start: search + span.start,
                open_end: search + span.open_end,
                close_start: search + span.close_start,
                end: search + span.end,
                kind: span.kind,
            };
            let text = visible_text(&block.html[span.open_end..span.close_start])?;
            let key = (change_id.clone(), span.kind.clone());
            grouped
                .entry(key)
                .and_modify(|existing| {
                    if !existing.text.is_empty() && !text.is_empty() {
                        existing.text.push('\n');
                    }
                    existing.text.push_str(&text);
                })
                .or_insert(TrackedChange {
                    change_id,
                    kind: span.kind,
                    author: open_tag_attribute(
                        &block.html[span.start..span.open_end],
                        "data-hcd-revision-author",
                    ),
                    date: open_tag_attribute(
                        &block.html[span.start..span.open_end],
                        "data-hcd-revision-date",
                    ),
                    text,
                    block_id: block.id.clone(),
                });
            search = span.end;
        }
    }
    Ok(grouped.into_values().collect())
}

fn comment_notes(blocks: &[Block]) -> Vec<CommentNote> {
    blocks
        .iter()
        .filter(|block| block.region == "comment")
        .map(|block| {
            let node_id = block
                .content
                .inlines
                .iter()
                .find_map(|inline| inline.node_id.clone());
            let node_hash = node_id.as_ref().and_then(|id| {
                block
                    .entries
                    .iter()
                    .find(|entry| &entry.node_id == id)
                    .map(|entry| entry.node_hash.clone())
            });
            CommentNote {
                block_id: block.id.clone(),
                node_id,
                node_hash,
                text: block
                    .content
                    .inlines
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect::<Vec<_>>()
                    .join(""),
            }
        })
        .collect()
}

struct RevisionSpan {
    start: usize,
    open_end: usize,
    close_start: usize,
    end: usize,
    kind: String,
}

fn first_revision_span(html: &str, marker: &str) -> Result<Option<RevisionSpan>, HcdError> {
    let Some(found) = html.find(marker) else {
        return Ok(None);
    };
    let start = html[..found].rfind("<span").ok_or_else(|| {
        HcdError::InvalidBundle("tracked change marker is outside a span".to_string())
    })?;
    let open_end = html[start..]
        .find('>')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| HcdError::InvalidBundle("tracked change span is truncated".to_string()))?;
    if found >= open_end {
        return Err(HcdError::InvalidBundle(
            "tracked change id is not on the span tag".to_string(),
        ));
    }
    let open = &html[start..open_end];
    let kind = open_tag_attribute(open, "data-hcd-revision").unwrap_or_default();
    if open.ends_with("/>") {
        return Ok(Some(RevisionSpan {
            start,
            open_end,
            close_start: open_end,
            end: open_end,
            kind,
        }));
    }
    let (close_start, end) = matching_span_end(html, open_end)?;
    Ok(Some(RevisionSpan {
        start,
        open_end,
        close_start,
        end,
        kind,
    }))
}

fn matching_span_end(html: &str, from: usize) -> Result<(usize, usize), HcdError> {
    let bytes = html.as_bytes();
    let mut depth = 1usize;
    let mut index = from;
    while index < bytes.len() {
        if bytes[index] == b'<' {
            if html[index..].starts_with("</span") {
                let end = html[index..]
                    .find('>')
                    .map(|offset| index + offset + 1)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("tracked change span is unclosed".to_string())
                    })?;
                depth -= 1;
                if depth == 0 {
                    return Ok((index, end));
                }
                index = end;
                continue;
            }
            if html[index..].starts_with("<span") {
                let boundary = bytes.get(index + 5).copied().unwrap_or(b' ');
                if matches!(boundary, b' ' | b'>' | b'/') {
                    depth += 1;
                }
            }
        }
        index += 1;
    }
    Err(HcdError::InvalidBundle(
        "tracked change span is unclosed".to_string(),
    ))
}

fn open_tag_attribute(tag: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = start + tag[start..].find('"')?;
    Some(tag[start..end].to_string())
}

fn visible_text(fragment: &str) -> Result<String, HcdError> {
    let mut reader = Reader::from_str(fragment);
    reader.config_mut().check_end_names = false;
    let mut buffer = Vec::new();
    let mut text = String::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Text(value)) => {
                text.push_str(&value.unescape().unwrap_or_default());
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(HcdError::InvalidBundle(format!(
                    "tracked change text parse error: {error}"
                )))
            }
        }
        buffer.clear();
    }
    Ok(text)
}

fn validate_change_id(change_id: &str) -> Result<(), HcdError> {
    if (1..=64).contains(&change_id.len())
        && change_id.bytes().all(
            |byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.'),
        )
    {
        return Ok(());
    }
    Err(HcdError::InvalidPatch(
        "tracked change id must be 1 to 64 ASCII letters, digits, dot, _ or -".to_string(),
    ))
}

fn sorted(values: HashSet<String>) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values
}

struct OperationContext<'a> {
    manifest: &'a HcdManifest,
    patch_id: &'a str,
    assets: &'a HashMap<String, crate::AssetDescriptor>,
}

fn apply_image_operation(
    blocks: &mut [Block],
    node_id: &str,
    geometry: Option<&crate::ImageGeometry>,
    precondition: &crate::VisualPrecondition,
    asset: Option<&crate::AssetDescriptor>,
    dirty_nodes: &mut HashSet<String>,
    dirty_parts: &mut HashSet<String>,
) -> Result<(), HcdError> {
    if let Some(geometry) = geometry {
        crate::html::validate_image_geometry(geometry)?;
    }
    let block = blocks
        .iter_mut()
        .find(|block| block.entries.iter().any(|entry| entry.node_id == node_id))
        .ok_or_else(|| HcdError::NodeNotFound(node_id.into()))?;
    let entry = block
        .entries
        .iter()
        .find(|entry| entry.node_id == node_id)
        .unwrap();
    if entry.source.node_kind != "image" {
        return Err(HcdError::InvalidPatch(
            "image operation target is not an image".into(),
        ));
    }
    let images = crate::extract_html_image_nodes(&block.html)?;
    let current = images
        .get(node_id)
        .ok_or_else(|| HcdError::InvalidBundle("mapped image has no visual state".into()))?;
    if current.visual_hash != precondition.visual_hash {
        return Err(HcdError::PreconditionFailed(
            "image visual hash mismatch".into(),
        ));
    }
    if let Some(geometry) = geometry {
        if current
            .geometry
            .as_ref()
            .is_none_or(|original| original.unit != geometry.unit)
        {
            return Err(HcdError::InvalidPatch(
                "image geometry must keep the stored coordinate unit".into(),
            ));
        }
        crate::patch::replace_image_geometry(&mut block.html, node_id, geometry)?;
    }
    if let Some(asset) = asset {
        crate::patch::replace_image_asset(&mut block.html, node_id, asset)?;
    }
    let asset_hash = asset
        .map(|value| value.hash.as_str())
        .or(current.asset_hash.as_deref());
    crate::patch::set_element_attribute(
        &mut block.html,
        node_id,
        "data-hcd-visual-hash",
        &crate::image_visual_hash(asset_hash, geometry.or(current.geometry.as_ref())),
    )?;
    dirty_nodes.insert(node_id.into());
    dirty_parts.insert(entry.source.part.clone());
    Ok(())
}

fn apply_operation(
    blocks: &mut Vec<Block>,
    operation: &StructureOperation,
    operation_index: usize,
    context: &OperationContext<'_>,
    dirty_nodes: &mut HashSet<String>,
    dirty_parts: &mut HashSet<String>,
) -> Result<(), HcdError> {
    let manifest = context.manifest;
    let patch_id = context.patch_id;
    match operation {
        StructureOperation::ImageGeometry {
            node_id,
            geometry,
            precondition,
        } => {
            apply_image_operation(
                blocks,
                node_id,
                Some(geometry),
                precondition,
                None,
                dirty_nodes,
                dirty_parts,
            )?;
        }
        StructureOperation::ImageReplace {
            node_id,
            asset_hash,
            geometry,
            precondition,
        } => {
            let asset = context
                .assets
                .get(asset_hash)
                .ok_or_else(|| HcdError::InvalidPatch("image asset was not validated".into()))?;
            apply_image_operation(
                blocks,
                node_id,
                geometry.as_ref(),
                precondition,
                Some(asset),
                dirty_nodes,
                dirty_parts,
            )?;
        }
        StructureOperation::Insert {
            after_block_id,
            block,
        } => {
            validate_content(block)?;
            let insertion = insertion_index(blocks, after_block_id.as_deref())?;
            if blocks
                .get(insertion)
                .is_some_and(|next| next.region != "body")
            {
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
            if blocks
                .get(insertion)
                .is_some_and(|next| next.region != moved.region)
            {
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

fn validate_content(content: &EditorBlockContent) -> Result<(), HcdError> {
    let mut budget = (0usize, 0usize);
    validate_content_tree(content, 0, &mut budget)
}

fn validate_content_tree(
    content: &EditorBlockContent,
    depth: usize,
    budget: &mut (usize, usize),
) -> Result<(), HcdError> {
    budget.0 += 1 + content.inlines.len();
    if depth > 24 || budget.0 > 1000 {
        return Err(HcdError::ResourceLimit(
            "editor block tree exceeds depth/span limits".into(),
        ));
    }
    match content.kind {
        EditorBlockKind::Paragraph if content.level.is_none() => {}
        EditorBlockKind::Heading if content.level.is_some_and(|level| (1..=6).contains(&level)) => {
        }
        EditorBlockKind::ListItem if content.level.is_some_and(|level| level <= 1) => {}
        EditorBlockKind::CodeBlock
        | EditorBlockKind::Blockquote
        | EditorBlockKind::BulletList
        | EditorBlockKind::OrderedList
        | EditorBlockKind::HorizontalRule
            if content.level.is_none() => {}
        _ => {
            return Err(HcdError::InvalidPatch(
                "unsupported block kind/level".to_string(),
            ))
        }
    }
    if content.language.as_ref().is_some_and(|language| {
        content.kind != EditorBlockKind::CodeBlock
            || language.len() > 64
            || !language
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_+-#.".contains(&byte))
    }) {
        return Err(HcdError::InvalidPatch("invalid code language".into()));
    }
    if content.list_start.is_some_and(|start| {
        start == 0
            || start > 1_000_000
            || !matches!(
                content.kind,
                EditorBlockKind::ListItem | EditorBlockKind::OrderedList
            )
    }) {
        return Err(HcdError::InvalidPatch("invalid list start".into()));
    }
    let container = matches!(
        content.kind,
        EditorBlockKind::Blockquote | EditorBlockKind::BulletList | EditorBlockKind::OrderedList
    );
    if (container && (content.children.is_empty() || !content.inlines.is_empty()))
        || (!content.children.is_empty() && !container && content.kind != EditorBlockKind::ListItem)
        || (content.kind == EditorBlockKind::ListItem
            && !content.children.is_empty()
            && (!content.inlines.is_empty()
                || content.children[0].kind != EditorBlockKind::Paragraph))
        || (matches!(
            content.kind,
            EditorBlockKind::BulletList | EditorBlockKind::OrderedList
        ) && content
            .children
            .iter()
            .any(|child| child.kind != EditorBlockKind::ListItem))
        || (content.kind == EditorBlockKind::HorizontalRule && !content.inlines.is_empty())
    {
        return Err(HcdError::InvalidPatch(
            "invalid editor block children".into(),
        ));
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
        if inline.hard_break && (inline.text != "\n" || content.kind == EditorBlockKind::CodeBlock)
        {
            return Err(HcdError::InvalidPatch(
                "hard breaks must contain one newline outside code blocks".into(),
            ));
        }
        if inline
            .text
            .chars()
            .any(|ch| matches!(ch as u32, 0..=8 | 11..=12 | 14..=31 | 0xFFFE | 0xFFFF))
        {
            return Err(HcdError::InvalidPatch(
                "forbidden XML text character".into(),
            ));
        }
        if let Some(color) = &inline.text_color {
            validate_editor_color("textColor", color)?;
        }
        if let Some(color) = &inline.background_color {
            validate_editor_color("backgroundColor", color)?;
        }
        if let Some(border) = &inline.border {
            validate_editor_color("border.color", &border.color)?;
            if !border.width_pt.is_finite() || border.width_pt <= 0.0 || border.width_pt > 12.0 {
                return Err(HcdError::InvalidPatch(
                    "border.widthPt must be finite, greater than 0, and at most 12".to_string(),
                ));
            }
        }
        if let Some(typography) = &inline.typography {
            typography.validate()?;
        }
        if inline.font_size_explicit
            && !inline
                .typography
                .as_ref()
                .and_then(|font| font.size_pt)
                .is_some_and(|size| (1.0..=1638.0).contains(&size) && (size * 2.0).fract() == 0.0)
        {
            return Err(HcdError::InvalidPatch(
                "explicit size requires a half-point sizePt from 1 to 1638".into(),
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
    budget.1 += total;
    if budget.1 > MAX_INLINE_BYTES {
        return Err(HcdError::ResourceLimit(
            "block text exceeds 1 MiB".to_string(),
        ));
    }
    for child in &content.children {
        validate_content_tree(child, depth + 1, budget)?;
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
    let mut renderer = BlockRenderer {
        manifest,
        patch_id,
        operation_index,
        block_id: &block_id,
        part,
        first_node_id,
        html: String::new(),
        entries: Vec::new(),
    };
    let wrapper = (content.kind == EditorBlockKind::ListItem)
        .then_some(if content.level == Some(1) { "ol" } else { "ul" });
    if let Some(tag) = wrapper {
        renderer.html.push_str(&format!(
            "<{tag} start=\"{}\">",
            content.list_start.unwrap_or(1)
        ));
    }
    renderer.render(&content, true)?;
    if let Some(tag) = wrapper {
        renderer.html.push_str(&format!("</{tag}>"));
    }
    Ok(Block {
        id: block_id.clone(),
        region: "body".into(),
        read_only: false,
        content,
        html: renderer.html,
        entries: renderer.entries,
    })
}

struct BlockRenderer<'a> {
    manifest: &'a HcdManifest,
    patch_id: &'a str,
    operation_index: usize,
    block_id: &'a str,
    part: &'a str,
    first_node_id: Option<String>,
    html: String,
    entries: Vec<NodeMapEntry>,
}

impl BlockRenderer<'_> {
    fn render(&mut self, content: &EditorBlockContent, root: bool) -> Result<(), HcdError> {
        let tag = match content.kind {
            EditorBlockKind::Paragraph => "p".into(),
            EditorBlockKind::Heading => format!("h{}", content.level.unwrap_or(1)),
            EditorBlockKind::ListItem => "li".into(),
            EditorBlockKind::CodeBlock => "pre".into(),
            EditorBlockKind::Blockquote => "blockquote".into(),
            EditorBlockKind::BulletList => "ul".into(),
            EditorBlockKind::OrderedList => "ol".into(),
            EditorBlockKind::HorizontalRule => "div".into(),
            EditorBlockKind::Opaque => {
                return Err(HcdError::InvalidPatch(
                    "opaque content is not editable".into(),
                ))
            }
        };
        let kind = serde_json::to_value(content.kind)?
            .as_str()
            .unwrap_or_default()
            .to_owned();
        self.html
            .push_str(&format!("<{tag} data-hcd-editor-kind=\"{kind}\""));
        if root {
            self.html.push_str(&format!(
                " class=\"hcd-editor-block\" data-hcd-id=\"{}\"",
                escape_html(self.block_id)
            ));
        }
        if let Some(level) = content.level {
            self.html
                .push_str(&format!(" data-hcd-editor-level=\"{level}\""));
        }
        if let Some(language) = &content.language {
            self.html.push_str(&format!(
                " data-hcd-code-language=\"{}\"",
                escape_html(language)
            ));
        }
        if let Some(start) = content.list_start {
            self.html
                .push_str(&format!(" data-hcd-list-start=\"{start}\""));
        }
        if content.kind == EditorBlockKind::OrderedList {
            self.html
                .push_str(&format!(" start=\"{}\"", content.list_start.unwrap_or(1)));
        }
        self.html.push('>');
        if content.kind == EditorBlockKind::CodeBlock {
            self.html.push_str("<code>");
        }
        if content.kind == EditorBlockKind::HorizontalRule {
            self.html.push_str("<hr/>");
        }
        for inline in &content.inlines {
            self.inline(inline, false)?;
        }
        if content.inlines.is_empty() && content.children.is_empty() {
            self.inline(
                &EditorInline::default(),
                content.kind == EditorBlockKind::HorizontalRule,
            )?;
        }
        for child in &content.children {
            self.render(child, false)?;
        }
        if content.kind == EditorBlockKind::CodeBlock {
            self.html.push_str("</code>");
        }
        self.html.push_str(&format!("</{tag}>"));
        Ok(())
    }

    fn inline(&mut self, inline: &EditorInline, decoration: bool) -> Result<(), HcdError> {
        let index = self.entries.len();
        let node_id = if index == 0 {
            self.first_node_id.clone()
        } else {
            None
        }
        .unwrap_or_else(|| {
            stable_node_id(&[
                &self.manifest.document_id,
                self.patch_id,
                &self.operation_index.to_string(),
                &format!("text-{index}"),
            ])
        });
        let node_hash = hash_bytes(inline.text.as_bytes());
        if let Some(link) = &inline.link {
            self.html
                .push_str(&format!("<a href=\"{}\">", escape_html(link)));
        }
        let tags = [
            (inline.bold, "strong"),
            (inline.italic, "em"),
            (inline.underline, "u"),
            (inline.strike, "s"),
            (inline.code, "code"),
        ];
        for (enabled, tag) in tags {
            if enabled {
                self.html.push_str(&format!("<{tag}>"));
            }
        }
        let mut presentation = String::new();
        if let Some(color) = &inline.text_color {
            presentation.push_str(&format!("color:{};", color.to_ascii_lowercase()));
        }
        if let Some(color) = &inline.background_color {
            presentation.push_str(&format!("background-color:{};", color.to_ascii_lowercase()));
        }
        if let Some(border) = &inline.border {
            for side in ["top", "right", "bottom", "left"] {
                presentation.push_str(&format!(
                    "border-{side}:{}pt {} {};",
                    border.width_pt,
                    border.style.as_css(),
                    border.color.to_ascii_lowercase()
                ));
            }
        }
        if let Some(typography) = &inline.typography {
            presentation.push_str(&typography.css());
        }
        let patched = !presentation.is_empty();
        // A literal newline stays canonical text and renders as a line break.
        if inline.hard_break {
            presentation.push_str("white-space:pre-wrap;");
        }
        self.html.push_str(&format!(
            "<span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\""
        ));
        if patched {
            self.html.push_str(" data-hcd-style-patched=\"true\"");
        }
        if inline.font_size_explicit {
            self.html.push_str(" data-hcd-size-explicit=\"true\"");
        }
        if let Some(typography) = &inline.typography {
            for (attribute, value) in [
                ("data-hcd-font-latin", &typography.latin),
                ("data-hcd-font-east-asia", &typography.east_asia),
                ("data-hcd-font-bidi", &typography.bidi),
            ] {
                if let Some(value) = value {
                    self.html
                        .push_str(&format!(" {attribute}=\"{}\"", escape_html(value)));
                }
            }
        }
        if inline.hard_break {
            self.html.push_str(" data-hcd-hard-break=\"true\"");
        }
        if !presentation.is_empty() {
            self.html
                .push_str(&format!(" style=\"{}\"", escape_html(&presentation)));
        }
        self.html
            .push_str(&format!(">{}</span>", escape_html(&inline.text)));
        for (enabled, tag) in tags.into_iter().rev() {
            if enabled {
                self.html.push_str(&format!("</{tag}>"));
            }
        }
        if inline.link.is_some() {
            self.html.push_str("</a>");
        }
        self.entries.push(NodeMapEntry {
            node_id,
            node_hash,
            source: SourceAnchor {
                part: self.part.into(),
                text_ordinal: self.manifest.revision * 1_000_000
                    + self.operation_index as u64 * 1000
                    + index as u64
                    + 1,
                paragraph_id: Some(self.block_id.into()),
                text_id: Some(format!(
                    "editor:{}",
                    &hash_bytes(
                        format!("{}:{}:{index}", self.patch_id, self.operation_index).as_bytes()
                    )[..32]
                )),
                node_kind: if decoration {
                    "editor-decoration"
                } else if inline.hard_break {
                    "editor-hard-break"
                } else {
                    "editor-text"
                }
                .into(),
                editable: !inline.hard_break && !decoration,
            },
        });
        Ok(())
    }
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
    fn shortened_text_invalidates_old_annotations_and_accepts_post_patch_ranges() {
        let (_temp, bundle) = fixture();
        let node = crate::get_text_node(&bundle, &format!("n_{:032x}", 0))
            .unwrap()
            .node;
        let annotation = crate::Annotation {
            annotation_id: "review".into(),
            node_id: node.node_id.clone(),
            start: 7,
            end: 10,
            kind: "recognition".into(),
            rule_id: None,
            confidence: None,
            ignored: false,
        };
        let apply = |id: &str, revision, operations| {
            crate::apply_patch(
                &bundle,
                &crate::PatchBatch {
                    schema_version: crate::HCD_PATCH_SCHEMA_VERSION.into(),
                    document_id: "structure-fixture".into(),
                    patch_id: id.into(),
                    base_revision: revision,
                    actor: BTreeMap::new(),
                    operations,
                    metadata: BTreeMap::new(),
                },
                revision,
            )
            .unwrap()
        };
        apply(
            "annotate",
            0,
            vec![crate::PatchOperation::AnnotationUpsert {
                annotation: annotation.clone(),
            }],
        );
        let splice = crate::PatchOperation::TextSplice {
            node_id: node.node_id,
            start: 0,
            delete_count: node.text.chars().count(),
            insert_text: "😀".into(),
            precondition: crate::NodePrecondition {
                node_hash: node.node_hash,
            },
        };
        let result = apply(
            "shorten",
            1,
            vec![
                splice,
                crate::PatchOperation::AnnotationUpsert {
                    annotation: crate::Annotation {
                        start: 0,
                        end: 1,
                        ..annotation
                    },
                },
            ],
        );
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "ANNOTATIONS_INVALIDATED_BY_TEXT_EDIT"));
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
        let manifest = bundle.manifest().unwrap();
        let set: AnnotationSet = read_json_bounded(
            &bundle
                .resolve_href(&manifest.annotation_href.unwrap())
                .unwrap(),
            MAX_CONTROL_PART_BYTES,
            "annotations",
        )
        .unwrap();
        assert_eq!((set.annotations[0].start, set.annotations[0].end), (0, 1));
    }

    #[test]
    fn structural_text_replacement_does_not_keep_stale_annotation_ranges() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        let node = crate::get_text_node(&bundle, &format!("n_{:032x}", 0))
            .unwrap()
            .node;
        crate::apply_patch(
            &bundle,
            &crate::PatchBatch {
                schema_version: crate::HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "structure-fixture".into(),
                patch_id: "annotate-structure".into(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations: vec![crate::PatchOperation::AnnotationUpsert {
                    annotation: crate::Annotation {
                        annotation_id: "review".into(),
                        node_id: node.node_id,
                        start: 7,
                        end: 10,
                        kind: "recognition".into(),
                        rule_id: None,
                        confidence: None,
                        ignored: false,
                    },
                }],
                metadata: BTreeMap::new(),
            },
            1,
        )
        .unwrap();
        replace(&bundle, 2, 0, "x");
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
        assert!(bundle.manifest().unwrap().annotation_href.is_none());
    }

    #[test]
    fn rich_blocks_roundtrip_canonical_html_without_a_json_body_copy() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        let contents: Vec<EditorBlockContent> = serde_json::from_value(serde_json::json!([
            {"kind":"paragraph","inlines":[{"text":"中文😀","underline":true,"strike":true},{"text":"\n","hardBreak":true},{"text":"inline","code":true}]},
            {"kind":"code_block","language":"rust","inlines":[{"text":"let x = 1;\nprintln!(\"😀\");"}]},
            {"kind":"horizontal_rule","inlines":[]},
            {"kind":"blockquote","inlines":[],"children":[{"kind":"paragraph","inlines":[{"text":"quote"}]},{"kind":"paragraph","inlines":[{"text":"second"}]}]},
            {"kind":"list_item","level":1,"listStart":4,"inlines":[],"children":[
                {"kind":"paragraph","inlines":[{"text":"parent"}]},
                {"kind":"ordered_list","listStart":7,"inlines":[],"children":[{"kind":"list_item","level":0,"inlines":[{"text":"nested"}]}]}
            ]}
        ])).unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let operations = contents
            .iter()
            .enumerate()
            .map(|(index, content)| StructureOperation::Replace {
                block_id: projection.blocks[index].block_id.clone(),
                block: content.clone(),
                precondition: BlockPrecondition {
                    block_hash: projection.blocks[index].block_hash.clone(),
                },
            })
            .collect();
        apply_structure_patch(
            &bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: projection.document_id,
                patch_id: "rich-content".into(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations,
            },
            1,
        )
        .unwrap();
        let reopened = editor_projection(&bundle, None).unwrap();
        fn without_ids(mut content: EditorBlockContent) -> EditorBlockContent {
            for inline in &mut content.inlines {
                inline.node_id = None;
            }
            content.children = content.children.into_iter().map(without_ids).collect();
            content
        }
        assert_eq!(
            reopened.blocks[..contents.len()]
                .iter()
                .map(|block| without_ids(block.content.clone()))
                .collect::<Vec<_>>(),
            contents
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        let historical = editor_projection(&bundle, Some(1)).unwrap();
        assert_eq!(historical.blocks[0].content.inlines[0].text, "Paragraph 0");
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

    #[test]
    fn imported_nested_lists_keep_hierarchy_numbering_and_original_text_anchors() {
        let (_temp, bundle) = fixture();
        let manifest = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let mut map = bundle.read_map(descriptor).unwrap();
        map.entries.truncate(3);
        let span = |index: usize| {
            format!(
                "<span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">Paragraph {index}</span>",
                map.entries[index].node_id, map.entries[index].node_hash
            )
        };
        let html = format!(
            "<ol start=\"4\"><li>{}<ul><li>{}</li></ul></li><li><p>{}</p></li></ol>",
            span(0),
            span(1),
            span(2)
        );
        let blocks = scan_chunk(&html, &map, descriptor, &manifest.document_id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(!blocks[0].read_only);
        assert_eq!(blocks[0].content.list_start, Some(4));
        assert_eq!(blocks[1].content.list_start, Some(5));
        assert_eq!(blocks[1].content.inlines[0].text, "Paragraph 2");
        let children = &blocks[0].content.children;
        assert_eq!(children[0].kind, EditorBlockKind::Paragraph);
        assert_eq!(
            children[0].inlines[0].node_id,
            Some(map.entries[0].node_id.clone())
        );
        assert_eq!(children[1].kind, EditorBlockKind::BulletList);
        assert_eq!(children[1].children[0].level, Some(0));
        assert_eq!(
            children[1].children[0].inlines[0].node_id,
            Some(map.entries[1].node_id.clone())
        );
    }

    #[test]
    fn staged_upload_pins_survive_gc_without_inflating_revision_growth() {
        let (_temp, bundle) = fixture();
        let manifest = bundle.manifest().unwrap();
        let before = crate::bundle_stats(&bundle).unwrap();
        let bytes = b"shared replacement not committed to a revision";
        let staged = bundle
            .stage_asset_from_reader("png", &mut std::io::Cursor::new(bytes))
            .unwrap();
        let stats = crate::bundle_stats(&bundle).unwrap();
        assert!(!stats.orphan_hrefs.contains(&staged.href));
        assert_eq!(
            stats.latest_revision_added_bytes,
            before.latest_revision_added_bytes
        );
        assert!(
            stats.referenced_stored_bytes >= before.referenced_stored_bytes + staged.byte_length
        );
        let orphan = bundle
            .root()
            .join(format!("chunks/sha256/{}.html", "f".repeat(64)));
        fs::write(&orphan, b"interrupted unreferenced write").unwrap();
        crate::remove_orphan_objects(&bundle).unwrap();
        assert!(!orphan.exists());
        assert_eq!(
            fs::read(bundle.resolve_href(&staged.href).unwrap()).unwrap(),
            bytes
        );
        assert_eq!(bundle.staged_asset(&staged.hash).unwrap(), staged);
        assert_eq!(bundle.manifest().unwrap().root_hash, manifest.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, manifest.revision);
        // Unreadable pin metadata prevents destructive collection; it cannot
        // turn an uncertain draft resource into an orphan to delete.
        fs::write(&orphan, b"another unreferenced write").unwrap();
        fs::write(
            bundle
                .root()
                .join(format!("assets/staged/{}.json", staged.hash)),
            b"{}",
        )
        .unwrap();
        assert!(crate::remove_orphan_objects(&bundle).is_err());
        assert!(orphan.exists());
        assert!(bundle.resolve_href(&staged.href).unwrap().exists());
    }

    fn fixture() -> (tempfile::TempDir, Bundle) {
        fixture_with_styles("")
    }

    fn fixture_with_styles(styles: &str) -> (tempfile::TempDir, Bundle) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("document.hcd");
        let mut writer = BundleWriter::create_with_codec(&path, StorageCodec::Gzip).unwrap();
        writer.write_styles(styles).unwrap();
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
                actor: BTreeMap::new(),
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
                            text_color: None,
                            background_color: None,
                            border: None,
                            ..Default::default()
                        }],
                        ..Default::default()
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
    fn typography_survives_structure_reopen_without_mutating_history_or_neighbor() {
        let (_temp, bundle) =
            fixture_with_styles("p {font-family:\"O'Name\", serif;font-size:14pt}");
        project_editor(&bundle, 0).unwrap();
        let before = editor_projection(&bundle, None).unwrap();
        let original = &before.blocks[0];
        let font = original.content.inlines[0].typography.clone().unwrap();
        assert_eq!(font.size_pt, Some(14.0));
        let mut edited = original.content.clone();
        edited.inlines[0].text = "Changed 中文😀".into();
        edited.inlines[0].node_id = None;
        edited.inlines[0].typography.as_mut().unwrap().size_pt = Some(18.5);
        edited.inlines[0].font_size_explicit = true;
        edited.inlines[0].typography.as_mut().unwrap().east_asia = Some("宋体".into());
        apply_structure_patch(
            &bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: before.document_id,
                patch_id: "typography-checkpoint".into(),
                base_revision: 1,
                actor: BTreeMap::new(),
                operations: vec![StructureOperation::Replace {
                    block_id: original.block_id.clone(),
                    block: edited,
                    precondition: BlockPrecondition {
                        block_hash: original.block_hash.clone(),
                    },
                }],
            },
            1,
        )
        .unwrap();
        let reopened = editor_projection(&Bundle::open(bundle.root()).unwrap(), None).unwrap();
        assert!(reopened.blocks[0].content.inlines[0].font_size_explicit);
        assert_eq!(
            reopened.blocks[0].content.inlines[0]
                .typography
                .as_ref()
                .unwrap()
                .size_pt,
            Some(18.5)
        );
        assert_eq!(
            reopened.blocks[0].content.inlines[0]
                .typography
                .as_ref()
                .unwrap()
                .east_asia
                .as_deref(),
            Some("宋体")
        );
        assert_eq!(
            reopened.blocks[0].content.inlines[0]
                .typography
                .as_ref()
                .unwrap()
                .family,
            font.family
        );
        assert_eq!(reopened.blocks[1].content, before.blocks[1].content);
        assert_eq!(
            editor_projection(&bundle, Some(1)).unwrap().blocks[0].content,
            original.content
        );
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
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
            actor: BTreeMap::new(),
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
                        text_color: None,
                        background_color: None,
                        border: None,
                        ..Default::default()
                    }],
                    ..Default::default()
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
        let restored = crate::restore_revision(&bundle, 1, 2, None, None).unwrap();
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

    #[test]
    fn accepting_a_deletion_and_rejecting_an_insertion_rewrites_tracked_markup() {
        let (temp, bundle) = tracked_fixture();
        let projection = editor_projection(&bundle, None).unwrap();
        assert!(projection.tracked_changes.iter().any(|change| {
            change.change_id == "7" && change.kind == "insert" && change.text == "added"
        }));
        assert!(projection.tracked_changes.iter().any(|change| {
            change.change_id == "8" && change.kind == "delete" && change.text == "removed"
        }));
        assert_eq!(projection.comments[0].text, "批注");
        resolve_tracked_change(&bundle, 0, "8", true, "accept-delete", &BTreeMap::new()).unwrap();
        let html = chunk_html(&bundle, 0);
        assert!(!html.contains("removed"));
        assert!(!html.contains("data-hcd-revision-id=\"8\""));
        assert!(html.contains(">added<"));
        resolve_tracked_change(&bundle, 1, "7", false, "reject-insert", &BTreeMap::new()).unwrap();
        let html = chunk_html(&bundle, 0);
        assert!(!html.contains("added"));
        assert!(html.contains(">current<"));
        append_comment(&bundle, 2, "回复", "reply-1", &BTreeMap::new()).unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        assert!(projection.comments.iter().any(|note| note.text == "回复"));
        assert!(projection.tracked_changes.is_empty());
        let validation = crate::validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        drop(temp);
    }

    fn chunk_html(bundle: &Bundle, sequence: usize) -> String {
        let manifest = bundle.manifest().unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        bundle.read_chunk(&page.chunks[sequence]).unwrap()
    }

    fn tracked_fixture() -> (tempfile::TempDir, Bundle) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("document.hcd");
        let mut writer = BundleWriter::create_with_codec(&path, StorageCodec::Gzip).unwrap();
        writer.write_styles("").unwrap();
        let added_id = "n_00000000000000000000000000000001";
        let current_id = "n_00000000000000000000000000000002";
        let comment_id = "n_00000000000000000000000000000003";
        let added_hash = hash_bytes(b"added");
        let current_hash = hash_bytes(b"current");
        let comment_hash = hash_bytes("批注".as_bytes());
        let body = format!(
            "<p><span class=\"hcd-revision hcd-revision-insert\" data-hcd-revision=\"insert\" data-hcd-revision-id=\"7\" data-hcd-revision-author=\"Alice\"><span data-hcd-id=\"{added_id}\" data-hcd-node-hash=\"{added_hash}\">added</span></span><span class=\"hcd-revision hcd-revision-delete\" data-hcd-revision=\"delete\" data-hcd-revision-id=\"8\" data-hcd-revision-author=\"Bob\"><span class=\"hcd-revision-text\" data-hcd-editable=\"false\">removed</span></span><span data-hcd-id=\"{current_id}\" data-hcd-node-hash=\"{current_hash}\">current</span></p>"
        );
        let comment = format!(
            "<p data-hcd-id=\"{comment_id}\"><span data-hcd-id=\"{comment_id}\" data-hcd-node-hash=\"{comment_hash}\">批注</span></p>"
        );
        let anchor = |node_id: &str, node_hash: String, part: &str, ordinal: u64| NodeMapEntry {
            node_id: node_id.to_string(),
            node_hash,
            source: SourceAnchor {
                part: part.to_string(),
                text_ordinal: ordinal,
                paragraph_id: None,
                text_id: None,
                node_kind: "text".to_string(),
                editable: true,
            },
        };
        writer
            .write_chunk(
                "c_00000000000000000000000000000001".to_string(),
                "body".to_string(),
                body,
                ChunkSourceMap {
                    schema_version: HCD_SCHEMA_VERSION.to_string(),
                    chunk_id: "c_00000000000000000000000000000001".to_string(),
                    entries: vec![
                        anchor(added_id, added_hash, "word/document.xml", 1),
                        anchor(current_id, current_hash, "word/document.xml", 2),
                    ],
                },
                1,
                false,
            )
            .unwrap();
        writer
            .write_chunk(
                "c_00000000000000000000000000000002".to_string(),
                "comment".to_string(),
                comment,
                ChunkSourceMap {
                    schema_version: HCD_SCHEMA_VERSION.to_string(),
                    chunk_id: "c_00000000000000000000000000000002".to_string(),
                    entries: vec![anchor(comment_id, comment_hash, "word/comments.xml", 1)],
                },
                1,
                false,
            )
            .unwrap();
        writer
            .finish(HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                storage_codec: StorageCodec::Gzip,
                document_id: "tracked".to_string(),
                profile: "semantic-flow".to_string(),
                revision: 0,
                source: SourceDescriptor {
                    format: "docx".to_string(),
                    sha256: "0".repeat(64),
                    size_bytes: 32,
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
}
