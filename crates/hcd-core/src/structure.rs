//! Bounded, server-owned semantic block edits for the HCD semantic-flow profile.
//! Existing blocks keep their canonical HTML and source-map entries byte for byte.
use crate::bundle::{
    finalize_root_hash, hash_descriptor, now_epoch_ms, read_json_bounded, INDEX_PAGE_SIZE,
};
use crate::{
    extract_html_font_nodes, extract_html_text_nodes, hash_bytes, node_bloom, stable_node_id,
    AnnotationSet, ApplyResult, Bundle, ChunkDescriptor, ChunkIndexPage, ChunkSourceMap,
    FidelityWarning, HcdError, HcdManifest, HtmlFontNode, NodeMapEntry, RevisionRecord,
    SourceAnchor, HCD_PATCH_SCHEMA_VERSION_4, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES,
    MAX_CONTROL_PART_BYTES, MAX_PATCH_JSON_BYTES, MAX_REVISION,
};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_BLOCKS: usize = 1_000_000;
const MAX_INLINE_BYTES: usize = 1024 * 1024;
const MAX_OPS: usize = 10_000;
const CHUNK_SOFT_BYTES: usize = 512 * 1024;
mod table;
pub use table::TableEditAction;

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
    #[serde(default, skip_serializing_if = "EditorTextFormat::is_empty")]
    pub format: EditorTextFormat,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorTextFormat {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_half_points: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl EditorTextFormat {
    pub fn is_empty(&self) -> bool {
        !self.underline
            && self.font.is_none()
            && self.size_half_points.is_none()
            && self.color.is_none()
    }

    fn from_css(&mut self, name: &str, value: &str) {
        match name {
            "font-family" => {
                let primary = value
                    .split(',')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .trim_matches(['\'', '"']);
                if valid_font(primary) {
                    self.font = Some(primary.to_owned());
                }
            }
            "font-size" => {
                if let Some(points) = value
                    .strip_suffix("pt")
                    .and_then(|value| value.trim().parse::<f64>().ok())
                {
                    let half_points = points * 2.0;
                    if (2.0..=512.0).contains(&half_points)
                        && (half_points.round() - half_points).abs() < 0.001
                    {
                        self.size_half_points = Some(half_points.round() as u16);
                    }
                }
            }
            "color" => {
                if let Some(color) = value.strip_prefix('#').filter(|value| valid_color(value)) {
                    self.color = Some(color.to_ascii_uppercase());
                }
            }
            "text-decoration" => {
                self.underline |= value
                    .split_ascii_whitespace()
                    .any(|token| token == "underline")
            }
            _ => {}
        }
    }

    fn css(&self) -> String {
        let mut css = String::new();
        if self.underline {
            css.push_str("text-decoration:underline;");
        }
        if let Some(font) = &self.font {
            css.push_str(&format!("font-family:'{font}';"));
        }
        if let Some(size) = self.size_half_points {
            css.push_str(&format!("font-size:{}pt;", f64::from(size) / 2.0));
        }
        if let Some(color) = &self.color {
            css.push_str(&format!("color:#{color};"));
        }
        css
    }
}

fn valid_font(font: &str) -> bool {
    !font.is_empty()
        && font.len() <= 128
        && font
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_'))
}

fn valid_color(color: &str) -> bool {
    color.len() == 6 && color.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorAlignment {
    Left,
    Center,
    Right,
    Justify,
}

impl EditorAlignment {
    fn from_css(style: &str) -> Option<Self> {
        css_declarations(style)
            .find_map(|(name, value)| (name == "text-align").then_some(value))
            .and_then(|value| match value {
                "left" => Some(Self::Left),
                "center" => Some(Self::Center),
                "right" => Some(Self::Right),
                "justify" => Some(Self::Justify),
                _ => None,
            })
    }

    pub fn css(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Center => "center",
            Self::Right => "right",
            Self::Justify => "justify",
        }
    }
}

fn css_declarations(style: &str) -> impl Iterator<Item = (&str, &str)> {
    style
        .split(';')
        .filter_map(|declaration| declaration.split_once(':'))
        .map(|(name, value)| (name.trim(), value.trim()))
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
    /// Faces pinned on the whole block, in the same three script slots a
    /// `text.font` patch uses. Rendering writes exactly the markers that patch
    /// writes, so the preview and both export paths treat a model face and a
    /// pinned run face alike. A block whose runs carry *different* faces cannot
    /// be expressed here — the projection marks it read-only instead of letting
    /// a save flatten or drop them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<crate::FontPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<EditorAlignment>,
    pub inlines: Vec<EditorInline>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorBlockView {
    pub block_id: String,
    pub block_hash: String,
    pub region: String,
    pub read_only: bool,
    /// Source-backed text edits are allowed inside these table runs. The block
    /// itself remains protected against replacement, removal and movement.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub editable_text_node_ids: Vec<String>,
    pub content: EditorBlockContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_html: Option<String>,
    /// Server-owned presentation, separate from editable semantic content.
    /// Clients must not send it back as a structure patch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_html: Option<String>,
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
    #[serde(rename = "table.insert")]
    TableInsert {
        after_block_id: Option<String>,
        rows: usize,
        columns: usize,
    },
    #[serde(rename = "table.edit")]
    TableEdit {
        block_id: String,
        #[serde(default)]
        table_index: usize,
        action: TableEditAction,
        index: usize,
        precondition: BlockPrecondition,
    },
    #[serde(rename = "table.cell.activate")]
    TableCellActivate {
        block_id: String,
        #[serde(default)]
        table_index: usize,
        row: usize,
        column: usize,
        precondition: BlockPrecondition,
    },
    #[serde(rename = "table.delete")]
    TableDelete {
        block_id: String,
        precondition: BlockPrecondition,
    },
    #[serde(rename = "table.restore")]
    TableRestore {
        block_id: String,
        source_revision: u64,
        after_block_id: Option<String>,
        precondition: TableRestorePrecondition,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableRestorePrecondition {
    pub block_hash: Option<String>,
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
            editable_text_node_ids: table_text_node_ids(self),
            content: self.content.clone(),
            read_only_html: self.read_only.then(|| self.html.clone()),
            presentation_html: (!self.read_only).then(|| self.html.clone()),
        }
    }
}

fn table_text_node_ids(block: &Block) -> Vec<String> {
    if block.region != "body" || !block.html.contains("<table") {
        return Vec::new();
    }
    let mut reader = Reader::from_str(&block.html);
    let mut depth = 0usize;
    let mut ids = HashSet::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                if start.name().as_ref() == b"table" {
                    depth += 1;
                }
                if depth > 0 {
                    if let Ok(Some(id)) = attribute(&start, &reader, "data-hcd-id") {
                        ids.insert(id);
                    }
                }
            }
            Ok(Event::End(end)) if end.name().as_ref() == b"table" => {
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) => break,
            Err(_) => return Vec::new(),
            _ => {}
        }
    }
    let editable: HashSet<&str> = block
        .entries
        .iter()
        .filter(|entry| entry.source.editable)
        .map(|entry| entry.node_id.as_str())
        .collect();
    block
        .content
        .inlines
        .iter()
        .filter_map(|inline| {
            inline
                .node_id
                .as_ref()
                .filter(|id| ids.contains(*id) && editable.contains(id.as_str()))
                .cloned()
        })
        .collect()
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
        theme_revision_id: manifest.theme_revision_id.clone(),
        root_hash: manifest.root_hash.clone(),
        annotation_root_hash: manifest.annotation_root_hash.clone(),
        index_prefix: manifest.index_prefix.clone(),
        index_root_href: manifest.index_root_href.clone(),
        index_page_count: Some(manifest.index_page_count),
        chunk_count: Some(manifest.chunk_count),
        asset_index_href: bundle.asset_index_href_for_revision(revision - 1)?,
        styles_href: manifest.styles_href.clone(),
        created_at_epoch_ms: now_epoch_ms(),
        dirty_node_ids: Vec::new(),
        removed_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: Vec::new(),
        dirty_grid_parts: Vec::new(),
        grid_filter_changed: false,
        grid_values_reordered: false,
        pdf_layout_changed: false,
        converted_formula_node_ids: Vec::new(),
        grid_row_insertions: Vec::new(),
        grid_row_deletions: Vec::new(),
        grid_column_insertions: Vec::new(),
        grid_column_deletions: Vec::new(),
        sheet_renames: Vec::new(),
        sheet_additions: Vec::new(),
        sheet_removals: Vec::new(),
        slide_additions: Vec::new(),
        slide_removals: Vec::new(),
        slide_reorders: Vec::new(),
        slide_copies: Vec::new(),
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
    alignment: Option<EditorAlignment>,
}

type SourceEntries<'a> = HashMap<&'a str, (usize, &'a NodeMapEntry)>;

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
    let mut entries = SourceEntries::with_capacity(map.entries.len());
    for (index, entry) in map.entries.iter().enumerate() {
        if entries
            .insert(entry.node_id.as_str(), (index, entry))
            .is_some()
        {
            return Err(HcdError::InvalidBundle(
                "duplicate editor source map node ID".to_string(),
            ));
        }
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
                        alignment: attribute(&start, &reader, "style")?
                            .as_deref()
                            .and_then(EditorAlignment::from_css),
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
                        alignment: attribute(&start, &reader, "style")?
                            .as_deref()
                            .and_then(EditorAlignment::from_css),
                        name,
                    };
                    blocks.push(block_from_raw(
                        &html[before..after],
                        &candidate,
                        &entries,
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
                        &entries,
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
                    format: Default::default(),
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
                alignment: None,
                kind: EditorBlockKind::Opaque,
                level: None,
                font: None,
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
    source_entries: &SourceEntries<'_>,
    descriptor: &ChunkDescriptor,
    document_id: &str,
) -> Result<Block, HcdError> {
    let nodes = extract_html_text_nodes(raw)?;
    let marks = extract_marks(raw)?;
    let rich_runs = crate::extract_docx_inline_runs(raw)?;
    // Each canonical node is parsed once. Searching the entire block's HTML
    // for every chunk-map entry makes large tables and repeated projections
    // quadratic in source size. Preserve map order without scanning unrelated
    // entries for every paragraph or table.
    let mut matches: Vec<_> = nodes
        .keys()
        .filter_map(|id| source_entries.get(id.as_str()))
        .collect();
    matches.sort_unstable_by_key(|(index, _)| index);
    let entries: Vec<NodeMapEntry> = matches.iter().map(|(_, entry)| (*entry).clone()).collect();
    let inlines: Vec<EditorInline> = entries
        .iter()
        .flat_map(|entry| {
            if let Some(runs) = rich_runs.get(&entry.node_id) {
                let link = marks.get(&entry.node_id).and_then(|marks| marks.2.clone());
                return runs
                    .iter()
                    .map(|run| EditorInline {
                        format: Default::default(),
                        text: run.text.clone(),
                        node_id: Some(entry.node_id.clone()),
                        bold: run.bold,
                        italic: run.italic,
                        link: link.clone(),
                    })
                    .collect::<Vec<_>>();
            }
            nodes
                .get(&entry.node_id)
                .map(|text| {
                    let mark = marks.get(&entry.node_id);
                    EditorInline {
                        text: text.clone(),
                        node_id: Some(entry.node_id.clone()),
                        bold: mark.is_some_and(|value| value.0),
                        italic: mark.is_some_and(|value| value.1),
                        link: mark.and_then(|value| value.2.clone()),
                        format: mark.map(|value| value.3.clone()).unwrap_or_default(),
                    }
                })
                .into_iter()
                .collect()
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
    let fonts = extract_html_font_nodes(raw)?;
    let (font, conflicting_faces) = match block_font(&fonts, &inlines) {
        BlockFont::Uniform(patch) => (Some(patch), false),
        BlockFont::Conflicting => (None, true),
        BlockFont::Absent => (None, false),
    };
    let read_only = descriptor.region != "body"
        || matches!(kind, EditorBlockKind::Opaque)
        || raw.contains("data-hcd-visual-hash=")
        || raw.contains("<table")
        // Runs pinned with different faces, or only some of the runs, are a shape
        // the block model cannot carry. Replacing such a block would spread one
        // face over the paragraph or drop the pins, so it stays read-only.
        || conflicting_faces;
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
            font,
            alignment: open.alignment,
            inlines,
        },
        html: raw.to_string(),
        entries,
    })
}

/// What the pinned faces inside one block mean for the block model.
enum BlockFont {
    /// No node in the block carries a pinned face.
    Absent,
    /// Every face in the block is the same and covers every text node, so the
    /// block model can hold it and a rewritten block keeps the same presentation.
    Uniform(crate::FontPatch),
    /// The block mixes faces, or carries one on only part of its text. The model
    /// has no run-level slot, so the block must not be rewritten.
    Conflicting,
}

fn block_font(fonts: &BTreeMap<String, HtmlFontNode>, inlines: &[EditorInline]) -> BlockFont {
    let mut shared: Option<crate::FontPatch> = None;
    for font in fonts.values() {
        let patch = crate::FontPatch {
            latin: font.latin.clone(),
            east_asia: font.east_asia.clone(),
            bidi: font.bidi.clone(),
        };
        match &shared {
            None => shared = Some(patch),
            Some(existing) if *existing == patch => {}
            Some(_) => return BlockFont::Conflicting,
        }
    }
    let Some(patch) = shared else {
        return BlockFont::Absent;
    };
    // One face on one run of a paragraph is a run pin, not a block font: writing
    // it into the model would put it on every run the next save regenerates.
    let uncovered = inlines.iter().any(|inline| {
        !inline.text.is_empty()
            && !inline
                .node_id
                .as_deref()
                .is_some_and(|node_id| fonts.contains_key(node_id))
    });
    if uncovered {
        return BlockFont::Conflicting;
    }
    BlockFont::Uniform(patch)
}

type Marks = (bool, bool, Option<String>, EditorTextFormat);

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
                let inherited = stack.last().cloned().unwrap_or_default();
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
                        let format = if let Some(style) =
                            attribute(&start, &reader, "data-hcd-typed-text")?
                        {
                            let mut format = EditorTextFormat::default();
                            for (name, value) in css_declarations(&style) {
                                format.from_css(name, value);
                            }
                            format
                        } else {
                            EditorTextFormat::default()
                        };
                        marks.insert(id, (bold, italic, link.clone(), format));
                    }
                }
                if push {
                    stack.push((bold, italic, link, EditorTextFormat::default()));
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
    let mut structural_change = false;
    for (operation_index, operation) in patch.operations.iter().enumerate() {
        if matches!(operation, StructureOperation::TableRestore { .. }) {
            table::restore(
                bundle,
                &mut blocks,
                &manifest,
                operation,
                &mut dirty_nodes,
                &mut dirty_parts,
            )?;
            structural_change = true;
            continue;
        }
        structural_change |= apply_operation(
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
    let root_hash = finalize_root_hash(bundle, hasher, &asset_index_href, &manifest.styles_href)?;
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
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch.patch_id,
        Some(patch_hash),
        structural_change,
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
) -> Result<bool, HcdError> {
    match operation {
        StructureOperation::TableInsert {
            after_block_id,
            rows,
            columns,
        } => {
            let insertion = insertion_index(blocks, after_block_id.as_deref())?;
            if !insertion_touches_region(blocks, insertion, "body")
                || manifest.source.format == "txt"
            {
                return Err(HcdError::Unsupported(
                    "tables require a rich document body".into(),
                ));
            }
            let generated = table::insert(manifest, patch_id, operation_index, *rows, *columns)?;
            dirty_nodes.extend(generated.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(
                generated
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
            blocks.insert(insertion, generated);
        }
        StructureOperation::TableEdit {
            block_id,
            table_index,
            action,
            index,
            precondition,
        } => {
            let position = block_index(blocks, block_id, precondition)?;
            if blocks[position].region != "body" || manifest.source.format == "txt" {
                return Err(HcdError::Unsupported(
                    "cannot edit a table outside a rich document body".into(),
                ));
            }
            let updated = table::edit(
                &blocks[position],
                manifest,
                patch_id,
                operation_index,
                *table_index,
                *action,
                *index,
            )?;
            dirty_nodes.extend(
                blocks[position]
                    .entries
                    .iter()
                    .chain(&updated.entries)
                    .map(|entry| entry.node_id.clone()),
            );
            dirty_parts.extend(
                updated
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
            blocks[position] = updated;
        }
        StructureOperation::TableCellActivate {
            block_id,
            table_index,
            row,
            column,
            precondition,
        } => {
            let position = block_index(blocks, block_id, precondition)?;
            if manifest.source.format != "docx" {
                return Err(HcdError::Unsupported(
                    "Empty table cell activation requires DOCX".into(),
                ));
            }
            let old = &blocks[position];
            let updated = table::activate_cell(
                old,
                manifest,
                patch_id,
                operation_index,
                *table_index,
                *row,
                *column,
            )?;
            for entry in updated.entries.iter().skip(old.entries.len()) {
                dirty_nodes.insert(entry.node_id.clone());
                dirty_parts.insert(entry.source.part.clone());
            }
            blocks[position] = updated;
        }
        StructureOperation::TableDelete {
            block_id,
            precondition,
        } => {
            let position = block_index(blocks, block_id, precondition)?;
            table::ensure_table(&blocks[position])?;
            let removed = blocks.remove(position);
            dirty_nodes.extend(removed.entries.iter().map(|entry| entry.node_id.clone()));
            dirty_parts.extend(
                removed
                    .entries
                    .iter()
                    .map(|entry| entry.source.part.clone()),
            );
        }
        StructureOperation::TableRestore { .. } => {
            unreachable!("historical table operations are resolved before apply_operation")
        }
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
            let index = block_index(blocks, block_id, precondition)?;
            if blocks[index].read_only {
                let preserved = replace_table_text(&blocks[index], block)?;
                for (before, after) in blocks[index].entries.iter().zip(&preserved.entries) {
                    if before.node_hash != after.node_hash {
                        dirty_nodes.insert(after.node_id.clone());
                        dirty_parts.insert(after.source.part.clone());
                    }
                }
                blocks[index] = preserved;
                return Ok(false);
            }
            validate_content(block)?;
            let old = &blocks[index];
            if let Some(preserved) = replace_text_preserving_presentation(old, block)? {
                for entry in &preserved.entries {
                    if old.html != preserved.html {
                        dirty_nodes.insert(entry.node_id.clone());
                        dirty_parts.insert(entry.source.part.clone());
                    }
                }
                blocks[index] = preserved;
                return Ok(false);
            }
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
    Ok(true)
}

/// A table stays an opaque layout block. Only the text of explicitly mapped,
/// editable runs may change; neither formatting nor source identity is supplied
/// by the client. This runs in the same atomic commit as other shared edits.
fn replace_table_text(
    original: &Block,
    replacement: &EditorBlockContent,
) -> Result<Block, HcdError> {
    let allowed: HashSet<String> = table_text_node_ids(original).into_iter().collect();
    if allowed.is_empty()
        || original.content.kind != replacement.kind
        || original.content.level != replacement.level
        || original.content.font != replacement.font
        || original.content.alignment != replacement.alignment
        || original.content.inlines.len() != replacement.inlines.len()
    {
        return Err(HcdError::InvalidPatch(
            "table structure is read-only".to_string(),
        ));
    }
    let mut bytes = 0usize;
    let mut updated = original.clone();
    for (before, after) in original.content.inlines.iter().zip(&replacement.inlines) {
        bytes = bytes
            .checked_add(after.text.len())
            .ok_or_else(|| HcdError::ResourceLimit("table text overflow".to_string()))?;
        if bytes > MAX_INLINE_BYTES {
            return Err(HcdError::ResourceLimit(
                "table text exceeds 1 MiB".to_string(),
            ));
        }
        if before.node_id != after.node_id
            || before.bold != after.bold
            || before.italic != after.italic
            || before.link != after.link
            || before.format != after.format
        {
            return Err(HcdError::InvalidPatch(
                "table run identity and formatting are read-only".to_string(),
            ));
        }
        if before.text == after.text {
            continue;
        }
        let id = before
            .node_id
            .as_ref()
            .filter(|id| allowed.contains(*id))
            .ok_or_else(|| HcdError::InvalidPatch("table run is read-only".to_string()))?;
        let hash = hash_bytes(after.text.as_bytes());
        crate::patch::replace_node_text(&mut updated.html, id, &after.text, &hash)?;
        let entry = updated
            .entries
            .iter_mut()
            .find(|entry| entry.node_id == *id)
            .ok_or_else(|| HcdError::NodeNotFound(id.clone()))?;
        entry.node_hash = hash;
    }
    updated.content = replacement.clone();
    Ok(updated)
}

/// A semantic editor coalesces adjacent runs with the same editable marks.
/// Text-only edits retain Word presentation and HTML source byte ranges.
/// DOCX bold/italic changes can use subruns inside the stable anchor; other
/// changes that the source writer cannot express use semantic reconstruction.
fn replace_text_preserving_presentation(
    original: &Block,
    replacement: &EditorBlockContent,
) -> Result<Option<Block>, HcdError> {
    let source_docx = original
        .entries
        .iter()
        .all(|entry| entry.source.part == "word/document.xml" && entry.source.node_kind == "text");
    let source_html = original
        .entries
        .iter()
        .all(|entry| entry.source.part == "html/document");
    if original.content.kind != replacement.kind
        || original.content.level != replacement.level
        || original.content.font != replacement.font
        || original.content.alignment != replacement.alignment
        || original.entries.is_empty()
        || original.entries.iter().any(|entry| !entry.source.editable)
        || original
            .content
            .inlines
            .iter()
            .chain(&replacement.inlines)
            .any(|inline| !inline.format.is_empty())
        || !(source_docx || source_html)
    {
        return Ok(None);
    }
    fn same_marks(left: &EditorInline, right: &EditorInline) -> bool {
        left.bold == right.bold && left.italic == right.italic && left.link == right.link
    }
    fn groups(inlines: &[EditorInline]) -> Vec<Vec<usize>> {
        let mut result: Vec<Vec<usize>> = Vec::new();
        for (index, inline) in inlines
            .iter()
            .enumerate()
            .filter(|(_, value)| !value.text.is_empty())
        {
            if let Some(group) = result.last_mut() {
                if same_marks(&inlines[group[0]], inline) {
                    group.push(index);
                    continue;
                }
            }
            result.push(vec![index]);
        }
        result
    }
    let old_groups = groups(&original.content.inlines);
    let new_groups = groups(&replacement.inlines);
    if original.html.contains("data-hcd-docx-inline=")
        || old_groups.len() != new_groups.len()
        || old_groups.is_empty()
        || old_groups.iter().zip(&new_groups).any(|(before, after)| {
            !same_marks(
                &original.content.inlines[before[0]],
                &replacement.inlines[after[0]],
            )
        })
    {
        // HTML source export can patch original text ranges, but cannot encode
        // changed marks into those ranges. Only DOCX has the rich-run writer.
        return if source_docx {
            replace_rich_text_preserving_presentation(original, replacement)
        } else {
            Ok(None)
        };
    }
    let mut updated = original.clone();
    for (before, after) in old_groups.iter().zip(&new_groups) {
        if !same_marks(
            &original.content.inlines[before[0]],
            &replacement.inlines[after[0]],
        ) {
            return Ok(None);
        }
        let old: Vec<char> = before
            .iter()
            .flat_map(|&i| original.content.inlines[i].text.chars())
            .collect();
        let new: Vec<char> = after
            .iter()
            .flat_map(|&i| replacement.inlines[i].text.chars())
            .collect();
        let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
        let suffix = old[prefix..]
            .iter()
            .rev()
            .zip(new[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let end = old.len() - suffix;
        let inserted: String = new[prefix..new.len() - suffix].iter().collect();
        let mut offset = 0;
        let mut placed = false;
        for &index in before {
            let inline = &mut updated.content.inlines[index];
            let Some(node_id) = &inline.node_id else {
                return Ok(None);
            };
            let Some(entry) = updated
                .entries
                .iter_mut()
                .find(|entry| entry.node_id == *node_id)
            else {
                return Ok(None);
            };
            let chars: Vec<char> = inline.text.chars().collect();
            let next = offset + chars.len();
            let mut text: String = chars[..prefix.saturating_sub(offset).min(chars.len())]
                .iter()
                .collect();
            if !placed && prefix <= next {
                text.push_str(&inserted);
                placed = true;
            }
            text.extend(chars[end.saturating_sub(offset).min(chars.len())..].iter());
            if text != inline.text {
                let hash = hash_bytes(text.as_bytes());
                crate::patch::replace_node_text(&mut updated.html, node_id, &text, &hash)?;
                entry.node_hash = hash;
                inline.text = text;
            }
            offset = next;
        }
    }
    Ok(Some(updated))
}

fn replace_rich_text_preserving_presentation(
    original: &Block,
    replacement: &EditorBlockContent,
) -> Result<Option<Block>, HcdError> {
    let Some(anchors) = crate::docx_inline::distribute_docx_inlines(
        &original.content.inlines,
        &replacement.inlines,
    ) else {
        return Ok(None);
    };
    let mut updated = original.clone();
    updated.content.inlines.clear();
    for (id, inlines) in anchors {
        let Some(entry) = updated.entries.iter_mut().find(|entry| entry.node_id == id) else {
            return Ok(None);
        };
        let text: String = inlines.iter().map(|inline| inline.text.as_str()).collect();
        let hash = hash_bytes(text.as_bytes());
        let runs: Vec<_> = inlines
            .iter()
            .map(|inline| crate::DocxInlineRun {
                text: inline.text.clone(),
                bold: inline.bold,
                italic: inline.italic,
            })
            .collect();
        crate::patch::replace_node_content(
            &mut updated.html,
            &id,
            &crate::docx_inline::render_docx_inline_runs(&runs),
            &hash,
        )?;
        entry.node_hash = hash;
        updated.content.inlines.extend(inlines);
    }
    Ok(Some(updated))
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
    // The block face goes through the same rules as a text.font patch, so a
    // checkpoint cannot smuggle in a family the patch layer would refuse.
    if let Some(font) = &content.font {
        crate::patch::validate_font_patch(font)?;
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
            if link.len() > 2048 || !crate::is_safe_hyperlink(link) {
                return Err(HcdError::InvalidPatch("unsafe inline link".to_string()));
            }
        }
        if inline
            .format
            .font
            .as_deref()
            .is_some_and(|value| !valid_font(value))
            || inline
                .format
                .color
                .as_deref()
                .is_some_and(|value| !valid_color(value))
            || inline
                .format
                .size_half_points
                .is_some_and(|value| !(2..=512).contains(&value))
        {
            return Err(HcdError::InvalidPatch("invalid inline formatting".into()));
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
    // A block face is written onto every text node the block generates, exactly as
    // a text.font patch would write it on each node: the whole block carries it,
    // the source-backed export rewrites every run of the paragraph, and the
    // semantic export remembers the face for the block it belongs to.
    let font_markers = match content.font.as_ref() {
        Some(font) => Some(crate::patch::font_presentation(font)?),
        None => None,
    };
    let mut html = String::new();
    if let Some(wrapper) = wrapper {
        html.push_str(&format!("<{wrapper} class=\"hcd-editor-list\">"));
    }
    let alignment = content
        .alignment
        .map(|value| format!(" style=\"text-align:{}\"", value.css()))
        .unwrap_or_default();
    html.push_str(&format!(
        "<{tag} class=\"hcd-editor-block\" data-hcd-id=\"{}\"{alignment}>",
        escape_html(&block_id)
    ));
    let mut entries = Vec::new();
    let inlines = if content.inlines.is_empty() {
        vec![EditorInline {
            format: Default::default(),
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
        let mut attributes =
            format!("data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\"");
        let typed_css = inline.format.css();
        if let Some(markers) = font_markers.as_ref() {
            if typed_css.is_empty() {
                attributes.push_str(&markers.attribute_text());
            } else {
                for (name, value) in &markers.attributes {
                    attributes.push_str(&format!(" {name}=\"{}\"", escape_html(value)));
                }
                attributes.push_str(&format!(
                    " style=\"{};{}\"",
                    escape_html(&markers.style_value()),
                    escape_html(&typed_css)
                ));
            }
        } else if !typed_css.is_empty() {
            attributes.push_str(&format!(" style=\"{}\"", escape_html(&typed_css)));
        }
        if !typed_css.is_empty() {
            attributes.push_str(&format!(
                " data-hcd-typed-text=\"{}\"",
                escape_html(&typed_css)
            ));
        }
        html.push_str(&format!(
            "<span {attributes}>{}</span>",
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
            pdf_layout: Vec::new(),
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
    fn editor_source_lookup_preserves_map_order_and_accepts_xml_attribute_quoting() {
        let map = hand_map(&["first", "second", "third"]);
        let html = format!(
            "<section><p>{}{}</p><p>{}</p></section>",
            hand_span(1, "second", ""),
            hand_span(0, "first", ""),
            hand_span(2, "third", "")
        );
        let double = scan_chunk(&html, &map, &hand_descriptor(), "document").unwrap();
        let single = scan_chunk(
            &html.replace('"', "'"),
            &map,
            &hand_descriptor(),
            "document",
        )
        .unwrap();
        assert_eq!(double.len(), 2);
        assert_eq!(double[0].entries, map.entries[..2]);
        assert_eq!(double[1].entries, map.entries[2..]);
        assert_eq!(double[0].content, single[0].content);
        assert_eq!(double[1].content, single[1].content);
    }

    #[test]
    fn editor_source_lookup_rejects_duplicate_map_identities() {
        let mut map = hand_map(&["first"]);
        map.entries.push(map.entries[0].clone());
        let html = format!("<section><p>{}</p></section>", hand_span(0, "first", ""));
        assert!(matches!(
            scan_chunk(&html, &map, &hand_descriptor(), "document"),
            Err(HcdError::InvalidBundle(message)) if message.contains("duplicate")
        ));
    }

    #[test]
    fn table_structure_batches_validate_and_reject_stale_or_partial_updates() {
        let (_temp, bundle) = fixture_format("html");
        let manifest = bundle.manifest().unwrap();
        project_editor(&bundle, manifest.revision).unwrap();
        let projection = editor_projection(&bundle, None).unwrap();
        let batch = StructurePatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
            document_id: projection.document_id.clone(),
            patch_id: "insert-table".into(),
            base_revision: projection.revision,
            operations: vec![StructureOperation::TableInsert {
                after_block_id: Some(projection.blocks[0].block_id.clone()),
                rows: 3,
                columns: 2,
            }],
        };
        let inserted = apply_structure_patch(&bundle, &batch, projection.revision).unwrap();
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{report:?}");
        let projection = editor_projection(&bundle, None).unwrap();
        let table = &projection.blocks[1];
        assert_eq!(table.editable_text_node_ids.len(), 6);
        assert!(
            bundle
                .revision(inserted.revision)
                .unwrap()
                .structural_change
        );
        let op = |action, index| StructureOperation::TableEdit {
            block_id: table.block_id.clone(),
            table_index: 0,
            action,
            index,
            precondition: BlockPrecondition {
                block_hash: table.block_hash.clone(),
            },
        };
        let mut patch = StructurePatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
            document_id: projection.document_id.clone(),
            patch_id: "atomic-table".into(),
            base_revision: projection.revision,
            operations: vec![
                op(TableEditAction::InsertRow, 1),
                op(TableEditAction::DeleteColumn, 99),
            ],
        };
        assert!(apply_structure_patch(&bundle, &patch, projection.revision).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, inserted.revision);
        patch.operations.truncate(1);
        let edited = apply_structure_patch(&bundle, &patch, projection.revision).unwrap();
        let report = crate::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{report:?}");
        assert_eq!(
            editor_projection(&bundle, None).unwrap().blocks[1]
                .editable_text_node_ids
                .len(),
            8
        );
        patch.patch_id = "stale-table".into();
        patch.base_revision = edited.revision;
        assert!(apply_structure_patch(&bundle, &patch, edited.revision).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, edited.revision);
        assert_eq!(
            editor_projection(&bundle, Some(inserted.revision))
                .unwrap()
                .blocks[1]
                .editable_text_node_ids
                .len(),
            6
        );
    }

    #[test]
    fn table_undo_restores_only_guarded_table_and_keeps_other_blocks() {
        let (_temp, bundle) = fixture_format("html");
        project_editor(&bundle, 0).unwrap();
        let first = editor_projection(&bundle, None).unwrap();
        let apply = |operations: Vec<StructureOperation>| {
            let head = bundle.manifest().unwrap().revision;
            apply_structure_patch(
                &bundle,
                &StructurePatchBatch {
                    schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                    document_id: first.document_id.clone(),
                    patch_id: format!("history-{head}"),
                    base_revision: head,
                    operations,
                },
                head,
            )
        };
        apply(vec![StructureOperation::TableInsert {
            after_block_id: Some(first.blocks[0].block_id.clone()),
            rows: 2,
            columns: 2,
        }])
        .unwrap();
        let inserted = editor_projection(&bundle, None).unwrap();
        let table = &inserted.blocks[1];
        apply(vec![StructureOperation::TableEdit {
            block_id: table.block_id.clone(),
            table_index: 0,
            action: TableEditAction::DeleteRow,
            index: 0,
            precondition: BlockPrecondition {
                block_hash: table.block_hash.clone(),
            },
        }])
        .unwrap();
        let deleted = editor_projection(&bundle, None).unwrap();
        replace(&bundle, deleted.revision, 2, "Peer paragraph remains");
        apply(vec![StructureOperation::TableRestore {
            block_id: table.block_id.clone(),
            source_revision: inserted.revision,
            after_block_id: None,
            precondition: TableRestorePrecondition {
                block_hash: Some(deleted.blocks[1].block_hash.clone()),
            },
        }])
        .unwrap();
        let restored = editor_projection(&bundle, None).unwrap();
        assert_eq!(restored.blocks[1].block_hash, table.block_hash);
        assert_eq!(
            restored.blocks[2].content.inlines[0].text,
            "Peer paragraph remains"
        );
        assert!(apply(vec![StructureOperation::TableRestore {
            block_id: table.block_id.clone(),
            source_revision: deleted.revision,
            after_block_id: None,
            precondition: TableRestorePrecondition {
                block_hash: Some(deleted.blocks[1].block_hash.clone())
            }
        }])
        .is_err());
        apply(vec![StructureOperation::TableDelete {
            block_id: table.block_id.clone(),
            precondition: BlockPrecondition {
                block_hash: table.block_hash.clone(),
            },
        }])
        .unwrap();
        apply(vec![StructureOperation::TableRestore {
            block_id: table.block_id.clone(),
            source_revision: inserted.revision,
            after_block_id: Some(first.blocks[0].block_id.clone()),
            precondition: TableRestorePrecondition { block_hash: None },
        }])
        .unwrap();
        assert_eq!(
            editor_projection(&bundle, None).unwrap().blocks[1].block_hash,
            table.block_hash
        );
        assert!(crate::validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn table_text_edits_preserve_layout_and_reject_changes_to_protected_runs() {
        let values = ["Outside", "甲😀", "", "Field"];
        let entries: Vec<_> = values
            .iter()
            .enumerate()
            .map(|(index, value)| NodeMapEntry {
                node_id: format!("n_{index:032x}"),
                node_hash: hash_bytes(value.as_bytes()),
                source: SourceAnchor {
                    source_cell_ref: None,
                    created_in_hcd: false,
                    part: "word/document.xml".into(),
                    text_ordinal: index as u64,
                    paragraph_id: Some(format!("P{index}")),
                    text_id: None,
                    node_kind: "text".into(),
                    editable: index != 3,
                },
            })
            .collect();
        let span = |index: usize| {
            format!("<span style=\"font-size:{}pt\" data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span>", 12 + index, entries[index].node_id, entries[index].node_hash, values[index])
        };
        let original = Block { id: "table".into(), region: "body".into(), read_only: true,
            content: EditorBlockContent {
alignment: None, kind: EditorBlockKind::Opaque, level: None, font: None,
                inlines: entries.iter().zip(values).map(|(entry, text)| EditorInline {
format: Default::default(),
                    text: text.into(), node_id: Some(entry.node_id.clone()), bold: false, italic: false, link: None,
                }).collect() },
            html: format!("<section><p>{}</p><table style=\"width:600px\"><tr><td colspan=\"2\"><p>{}{}</p><table><tr><td>{}</td></tr></table></td></tr></table></section>", span(0),span(1),span(2),span(3)),
            entries,
        };
        assert_eq!(
            table_text_node_ids(&original),
            vec![
                original.entries[1].node_id.clone(),
                original.entries[2].node_id.clone()
            ]
        );
        let mut desired = original.content.clone();
        desired.inlines[1].text = "甲中文🙂".into();
        desired.inlines[2].text = "Added".into();
        let edited = replace_table_text(&original, &desired).unwrap();
        let mut expected = original.html.clone();
        for index in [1, 2] {
            let text = &desired.inlines[index].text;
            expected = expected.replace(
                &original.entries[index].node_hash,
                &hash_bytes(text.as_bytes()),
            );
        }
        expected = expected
            .replace("甲😀", "甲中文🙂")
            .replace(&format!(">{}</span>", values[2]), ">Added</span>");
        // Apart from the two mapped texts/hashes, all markup is byte-identical.
        assert_eq!(edited.html, expected);
        for (before, after) in original.entries.iter().zip(&edited.entries) {
            assert_eq!(
                serde_json::to_value(&before.source).unwrap(),
                serde_json::to_value(&after.source).unwrap()
            );
        }
        for index in [0, 3] {
            let mut invalid = desired.clone();
            invalid.inlines[index].text = "Forbidden".into();
            assert!(replace_table_text(&original, &invalid).is_err());
        }
        let mut invalid = desired.clone();
        invalid.inlines[1].bold = true;
        assert!(replace_table_text(&original, &invalid).is_err());
        invalid = desired.clone();
        invalid.inlines.swap(1, 2);
        assert!(replace_table_text(&original, &invalid).is_err());
        invalid = desired;
        invalid.inlines.pop();
        assert!(replace_table_text(&original, &invalid).is_err());
        let mut header = original;
        header.region = "header".into();
        assert!(table_text_node_ids(&header).is_empty());
    }

    #[test]
    fn word_text_edits_keep_unicode_run_boundaries_styles_and_source_anchors() {
        let values = ["甲😀", "乙丙", "丁"];
        let mut original = Block {
            id: "word-paragraph".to_string(),
            region: "body".to_string(),
            read_only: false,
            content: EditorBlockContent {
                alignment: None,
                kind: EditorBlockKind::Paragraph,
                level: None,
                font: None,
                inlines: Vec::new(),
            },
            html: "<p style=\"text-align:center\">".to_string(),
            entries: Vec::new(),
        };
        for (index, value) in values.iter().enumerate() {
            let id = format!("n_{index:032x}");
            let hash = hash_bytes(value.as_bytes());
            original.html.push_str(&format!("<span style=\"font-size:{}pt\" data-hcd-id=\"{id}\" data-hcd-node-hash=\"{hash}\">{value}</span>", 12 + index * 2));
            original.content.inlines.push(EditorInline {
                format: Default::default(),
                text: value.to_string(),
                node_id: Some(id.clone()),
                bold: false,
                italic: false,
                link: None,
            });
            original.entries.push(NodeMapEntry {
                node_id: id,
                node_hash: hash,
                source: SourceAnchor {
                    source_cell_ref: None,
                    created_in_hcd: false,
                    part: "word/document.xml".to_string(),
                    text_ordinal: index as u64 + 1,
                    paragraph_id: Some("A1".to_string()),
                    text_id: None,
                    node_kind: "text".to_string(),
                    editable: true,
                },
            });
        }
        original.html.push_str("</p>");
        for (text, expected) in [
            ("甲修订丁", ["甲修订", "", "丁"]),
            ("甲😀追加乙丙丁", ["甲😀追加", "乙丙", "丁"]),
            ("前甲😀乙丙丁", ["前甲😀", "乙丙", "丁"]),
            ("甲😀乙丙丁后", ["甲😀", "乙丙", "丁后"]),
        ] {
            let mut replacement = original.content.clone();
            replacement.inlines.truncate(1);
            replacement.inlines[0].node_id = None;
            replacement.inlines[0].text = text.to_string();
            let updated = replace_text_preserving_presentation(&original, &replacement)
                .unwrap()
                .unwrap();
            assert_eq!(
                updated
                    .content
                    .inlines
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            for (index, (old, new)) in original.entries.iter().zip(&updated.entries).enumerate() {
                assert_eq!(
                    serde_json::to_value(&old.source).unwrap(),
                    serde_json::to_value(&new.source).unwrap()
                );
                assert_eq!(old.node_id, new.node_id);
                assert_eq!(new.node_hash, hash_bytes(expected[index].as_bytes()));
                assert!(updated
                    .html
                    .contains(&format!("font-size:{}pt", 12 + index * 2)));
            }
            assert!(updated.html.contains("text-align:center"));
            replacement.inlines[0].bold = true;
            let bold = replace_text_preserving_presentation(&original, &replacement)
                .unwrap()
                .unwrap();
            assert!(bold
                .content
                .inlines
                .iter()
                .filter(|inline| !inline.text.is_empty())
                .all(|inline| inline.bold));
            assert!(bold.html.contains("text-align:center"));
            assert_eq!(
                bold.content
                    .inlines
                    .iter()
                    .map(|inline| inline.text.as_str())
                    .collect::<String>(),
                text
            );
        }
    }

    #[test]
    fn body_insert_can_use_the_boundary_before_a_footer() {
        let block = |id: &str, region: &str| Block {
            id: id.to_string(),
            region: region.to_string(),
            read_only: region != "body",
            content: EditorBlockContent {
                alignment: None,
                kind: EditorBlockKind::Paragraph,
                level: None,
                font: None,
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
            pdf_layout: Vec::new(),
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

    pub(super) fn fixture() -> (tempfile::TempDir, Bundle) {
        fixture_format("txt")
    }
    fn fixture_format(format: &str) -> (tempfile::TempDir, Bundle) {
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
                    part: if format == "html" {
                        "html/document"
                    } else {
                        "text/document"
                    }
                    .to_string(),
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
                    format: format.to_string(),
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
                theme_revision_id: None,
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
                        alignment: None,
                        kind: EditorBlockKind::Paragraph,
                        level: None,
                        font: None,
                        inlines: vec![EditorInline {
                            format: Default::default(),
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
                    alignment: None,
                    kind: EditorBlockKind::Paragraph,
                    level: None,
                    font: None,
                    inlines: vec![EditorInline {
                        format: Default::default(),
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

    fn face(latin: Option<&str>, east_asia: Option<&str>, bidi: Option<&str>) -> crate::FontPatch {
        crate::FontPatch {
            latin: latin.map(str::to_string),
            east_asia: east_asia.map(str::to_string),
            bidi: bidi.map(str::to_string),
        }
    }

    fn paragraph(value: &str) -> EditorBlockContent {
        EditorBlockContent {
            alignment: None,
            kind: EditorBlockKind::Paragraph,
            level: None,
            font: None,
            inlines: vec![EditorInline {
                format: Default::default(),
                text: value.to_string(),
                node_id: None,
                bold: false,
                italic: false,
                link: None,
            }],
        }
    }

    fn replace_with_font(
        bundle: &Bundle,
        revision: u64,
        number: usize,
        content: EditorBlockContent,
    ) -> ApplyResult {
        let projection = editor_projection(bundle, Some(revision)).unwrap();
        let original = &projection.blocks[number];
        apply_structure_patch(
            bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
                document_id: projection.document_id,
                patch_id: format!("font-{number}-{revision}"),
                base_revision: revision,
                operations: vec![StructureOperation::Replace {
                    block_id: original.block_id.clone(),
                    block: content,
                    precondition: BlockPrecondition {
                        block_hash: original.block_hash.clone(),
                    },
                }],
            },
            revision,
        )
        .unwrap()
    }

    /// The head-revision chunk HTML that contains `needle`.
    fn chunk_html_at(bundle: &Bundle, needle: &str) -> String {
        let manifest = bundle.manifest().unwrap();
        for page_number in 0..manifest.index_page_count {
            let page = bundle.read_index_page(&manifest, page_number).unwrap();
            for descriptor in &page.chunks {
                let html = bundle.read_chunk(descriptor).unwrap();
                if html.contains(needle) {
                    return html;
                }
            }
        }
        panic!("no chunk at revision {} holds {needle}", manifest.revision);
    }

    /// A one-chunk map plus a block builder, for HTML the writers never produce.
    fn hand_map(values: &[&str]) -> ChunkSourceMap {
        ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: "c_00000000000000000000000000000000".to_string(),
            entries: values
                .iter()
                .enumerate()
                .map(|(index, value)| NodeMapEntry {
                    node_id: format!("n_{index:032x}"),
                    node_hash: hash_bytes(value.as_bytes()),
                    source: SourceAnchor {
                        source_cell_ref: None,
                        created_in_hcd: false,
                        part: "text/document".to_string(),
                        text_ordinal: index as u64,
                        paragraph_id: None,
                        text_id: None,
                        node_kind: "line".to_string(),
                        editable: true,
                    },
                })
                .collect(),
        }
    }

    fn hand_descriptor() -> ChunkDescriptor {
        ChunkDescriptor {
            sequence: 0,
            chunk_id: "c_00000000000000000000000000000000".to_string(),
            region: "body".to_string(),
            html_href: String::new(),
            html_hash: String::new(),
            map_href: String::new(),
            map_hash: String::new(),
            byte_length: 0,
            block_count: 1,
            node_count: 1,
            text_chars: 0,
            node_bloom: String::new(),
            first_node_id: None,
            last_node_id: None,
            continuation: false,
            grid: None,
            pdf_layout: Vec::new(),
        }
    }

    /// `<span>` with the node id `hand_map` gives index `index`, its hash, and
    /// any extra attributes.
    fn hand_span(index: usize, value: &str, extra: &str) -> String {
        format!(
            "<span data-hcd-id=\"n_{index:032x}\" data-hcd-node-hash=\"{}\"{extra}>{value}</span>",
            hash_bytes(value.as_bytes())
        )
    }

    /// The same span with a face pinned onto it, as `text.font` writes it.
    fn pinned_span(index: usize, value: &str, family: &str) -> String {
        hand_span(
            index,
            value,
            &format!(" data-hcd-font=\"{family}\" data-hcd-font-latin=\"{family}\" data-hcd-font-patched=\"true\""),
        )
    }

    #[test]
    fn a_block_font_renders_the_markers_a_text_font_patch_writes() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        let mut content = paragraph("Revenue in yen");
        content.font = Some(face(Some("Brand Serif"), Some("Brand Gothic"), None));
        content.inlines.push(EditorInline {
            format: Default::default(),
            text: " report".to_string(),
            node_id: None,
            bold: true,
            italic: false,
            link: None,
        });
        replace_with_font(&bundle, 1, 0, content);
        let html = chunk_html_at(&bundle, "Revenue in yen");
        // Every text node the block generates carries the face, the way a patch
        // writes it on a node: same attributes, same order, same inline style.
        for attribute in [
            "data-hcd-font=\"Brand Serif\"",
            "data-hcd-font-latin=\"Brand Serif\"",
            "data-hcd-font-east-asia=\"Brand Gothic\"",
            "data-hcd-font-patched=\"true\"",
            "style=\"font-family:'Brand Serif'\"",
        ] {
            assert_eq!(html.matches(attribute).count(), 2, "{attribute} in {html}");
        }
        assert!(
            !html.contains("data-hcd-style-patched"),
            "a font is not a style patch"
        );
        // And the projection reads it back as the block's own face, so the next
        // save cannot lose it.
        let block = editor_projection(&bundle, None)
            .unwrap()
            .blocks
            .into_iter()
            .find(|block| {
                block
                    .content
                    .inlines
                    .iter()
                    .any(|inline| inline.text == "Revenue in yen")
            })
            .expect("rewritten block");
        assert!(!block.read_only);
        assert_eq!(
            block.content.font,
            Some(face(Some("Brand Serif"), Some("Brand Gothic"), None))
        );
    }

    #[test]
    fn a_font_only_edit_makes_a_revision_and_an_unsafe_face_does_not() {
        let (_temp, bundle) = fixture();
        project_editor(&bundle, 0).unwrap();
        let mut content = paragraph("Paragraph 0");
        content.font = Some(face(None, None, Some("Brand Naskh")));
        let result = replace_with_font(&bundle, 1, 0, content);
        assert_eq!(result.revision, 2);
        // A bidi-only face still writes its own slot, and becomes the primary
        // face the inline style falls back to.
        let html = chunk_html_at(&bundle, "data-hcd-font-bidi=\"Brand Naskh\"");
        assert!(html.contains("data-hcd-font=\"Brand Naskh\""), "{html}");
        assert!(
            html.contains("style=\"font-family:'Brand Naskh'\""),
            "{html}"
        );
        assert!(!html.contains("data-hcd-font-latin"), "{html}");
        // The same text with no face is still a change, so it also lands: the
        // block model owns the face, and a client that stops sending one clears it.
        replace(&bundle, 2, 0, "Paragraph 0");
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        for rejected in [
            &face(Some("Evil;"), None, None),
            &face(Some(&"x".repeat(129)), None, None),
            &face(None, None, None),
        ] {
            let mut content = paragraph("Unsafe");
            content.font = Some(rejected.clone());
            let projection = editor_projection(&bundle, None).unwrap();
            let original = &projection.blocks[1];
            let patch = StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.to_string(),
                document_id: projection.document_id.clone(),
                patch_id: "rejected-face".to_string(),
                base_revision: 3,
                operations: vec![StructureOperation::Replace {
                    block_id: original.block_id.clone(),
                    block: content,
                    precondition: BlockPrecondition {
                        block_hash: original.block_hash.clone(),
                    },
                }],
            };
            assert!(
                matches!(
                    apply_structure_patch(&bundle, &patch, 3),
                    Err(HcdError::InvalidPatch(_))
                ),
                "{rejected:?} was accepted"
            );
        }
        assert_eq!(bundle.manifest().unwrap().revision, 3);
    }

    #[test]
    fn mixed_run_faces_are_read_as_read_only_instead_of_one_block_font() {
        let values = ["Left", "Right"];
        let map = hand_map(&values);
        let describe = |html: String| {
            scan_chunk(&html, &map, &hand_descriptor(), "faces-test").unwrap()[0].clone()
        };
        // One run pinned inside a two-run paragraph: the model has no slot for
        // that, and writing it as a block font would spread it to the other run.
        let block = describe(format!(
            "<p>{}{}</p>",
            pinned_span(0, "Left", "Brand Serif"),
            hand_span(1, "Right", "")
        ));
        assert!(block.read_only, "a partial pin must not be editable");
        assert_eq!(block.content.font, None);
        // Two runs with different faces: also not one block font.
        let block = describe(format!(
            "<p>{}{}</p>",
            pinned_span(0, "Left", "A Serif"),
            pinned_span(1, "Right", "B Serif")
        ));
        assert!(block.read_only);
        assert_eq!(block.content.font, None);
        // Both runs pinned to the same face is exactly what the block can carry.
        let block = describe(format!(
            "<p>{}{}</p>",
            pinned_span(0, "Left", "Brand Serif"),
            pinned_span(1, "Right", "Brand Serif")
        ));
        assert!(!block.read_only);
        assert_eq!(
            block.content.font,
            Some(face(Some("Brand Serif"), None, None))
        );
        // A face the source document already had carries no patch marker, so it
        // stays out of the model and the block stays editable.
        let block = describe(format!(
            "<p>{}{}</p>",
            hand_span(0, "Left", " data-hcd-font-latin=\"Body Serif\""),
            hand_span(1, "Right", "")
        ));
        assert!(!block.read_only);
        assert_eq!(block.content.font, None);
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
