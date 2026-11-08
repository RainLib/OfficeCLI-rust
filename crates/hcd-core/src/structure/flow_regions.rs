//! Region-aware canonical structure. Content stays in HTML/source maps; the
//! versioned layout records only section boundaries and shared story identity.
use super::*;
use crate::{
    FlowDocumentLayout, FlowStoryKind, FLOW_REGION_LAYOUT_SCHEMA, FLOW_REGION_LAYOUT_SOURCE_PART,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowRegionKind {
    Body,
    Header,
    Footer,
}
impl FlowRegionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Header => "header",
            Self::Footer => "footer",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowRegion {
    pub id: String,
    pub kind: FlowRegionKind,
    pub source_part: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowRegionEdits {
    pub region_id: String,
    pub operations: Vec<StructureOperation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStructurePatchBatch {
    pub schema_version: String,
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    pub layout_hash: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub actor: BTreeMap<String, String>,
    pub regions: Vec<FlowRegionEdits>,
}
pub const FLOW_STRUCTURE_PATCH_SCHEMA: &str = crate::HCD_PATCH_SCHEMA_VERSION_6;
pub fn flow_layout_hash(layout: &FlowDocumentLayout) -> Result<String, HcdError> {
    Ok(hash_bytes(&serde_json::to_vec(layout)?))
}
pub fn flow_regions(layout: &FlowDocumentLayout) -> Vec<FlowRegion> {
    layout
        .sections
        .iter()
        .map(|s| FlowRegion {
            id: s.id.clone(),
            kind: FlowRegionKind::Body,
            source_part: "word/document.xml".into(),
        })
        .chain(layout.stories.iter().map(|s| FlowRegion {
            id: s.id.clone(),
            kind: match s.kind {
                FlowStoryKind::Header => FlowRegionKind::Header,
                FlowStoryKind::Footer => FlowRegionKind::Footer,
            },
            source_part: s.source_part.clone(),
        }))
        .collect()
}
fn invalid(message: &str) -> HcdError {
    HcdError::InvalidBundle(format!("Word region graph: {message}"))
}

pub(crate) fn reject_unscoped_metadata(html: &str) -> Result<(), HcdError> {
    if !html.contains("data-hcd-flow-region") {
        return Ok(());
    }
    let mut reader = Reader::from_str(html);
    loop {
        match reader.read_event().map_err(|e| invalid(&e.to_string()))? {
            Event::Start(start) | Event::Empty(start) => {
                if attribute(&start, &reader, "data-hcd-flow-region")?.is_some() {
                    return Err(invalid("region metadata requires layout model 2"));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(())
}

/// The wrapper carries identity even if a region has no mapped text. Inferring
/// a blank header from a neighboring story would silently target the wrong XML.
pub(super) fn chunk_region(
    html: &str,
    map: &ChunkSourceMap,
    descriptor: &ChunkDescriptor,
    catalog: Option<&HashMap<String, FlowRegion>>,
) -> Result<(Option<String>, Option<FlowRegion>), HcdError> {
    let mut reader = Reader::from_str(html);
    let mut buffer = Vec::new();
    let (part, id) = loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|e| invalid(&e.to_string()))?
        {
            Event::Start(start) => {
                if start.name().as_ref() != b"section" {
                    return Err(invalid("chunk must start with its section wrapper"));
                }
                break (
                    attribute(&start, &reader, "data-hcd-source-part")?,
                    attribute(&start, &reader, "data-hcd-flow-region")?,
                );
            }
            Event::Text(text)
                if text
                    .unescape()
                    .map_err(|e| invalid(&e.to_string()))?
                    .trim()
                    .is_empty() => {}
            _ => return Err(invalid("missing chunk wrapper")),
        }
        buffer.clear();
    };
    let scoped = catalog.is_some();
    if !scoped {
        if id.is_some() {
            return Err(invalid("canonical region needs layout model 2"));
        }
        let parts: HashSet<_> = map
            .entries
            .iter()
            .map(|entry| entry.source.part.as_str())
            .collect();
        return Ok((
            part.or_else(|| {
                (parts.len() == 1).then(|| (*parts.iter().next().unwrap()).to_string())
            }),
            None,
        ));
    }
    let catalog = catalog.unwrap();
    let scope = id
        .as_deref()
        .map(|id| {
            catalog
                .get(id)
                .cloned()
                .ok_or_else(|| invalid("unknown region identity"))
        })
        .transpose()?;
    if ["body", "header", "footer"].contains(&descriptor.region.as_str()) != scope.is_some() {
        return Err(invalid("missing or unexpected region identity"));
    }
    if let Some(scope) = &scope {
        if scope.kind.as_str() != descriptor.region
            || part.as_deref() != Some(&scope.source_part)
            || map
                .entries
                .iter()
                .any(|entry| entry.source.part != scope.source_part)
        {
            return Err(invalid("region role/source part mismatch"));
        }
    }
    // Scope declarations are allowed only on the chunk wrapper.
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|e| invalid(&e.to_string()))?
        {
            Event::Start(start) | Event::Empty(start)
                if attribute(&start, &reader, "data-hcd-flow-region")?.is_some() =>
            {
                return Err(invalid("nested region declaration"))
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok((part, scope))
}

pub(super) fn catalog(layout: &FlowDocumentLayout) -> HashMap<String, FlowRegion> {
    flow_regions(layout)
        .into_iter()
        .map(|scope| (scope.id.clone(), scope))
        .collect()
}

/// Derive verified header/footer identities for one fixed index page. Body
/// chunks stay unread; empty stories use their wrapper, not inferred text.
pub fn word_region_index_page(
    bundle: &Bundle,
    manifest: &HcdManifest,
    index: &ChunkIndexPage,
) -> Result<Vec<Option<String>>, HcdError> {
    WordRegionIndex::new(bundle, manifest)?.page(index)
}

/// Reuse one verified layout catalog when scanning multiple index pages.
/// Callers must obtain each page from the same fixed manifest used in `new`.
pub struct WordRegionIndex<'a> {
    bundle: &'a Bundle,
    regions: HashMap<String, FlowRegion>,
}
impl<'a> WordRegionIndex<'a> {
    pub fn new(bundle: &'a Bundle, manifest: &HcdManifest) -> Result<Self, HcdError> {
        if manifest.capabilities.flow_layout != Some(2) {
            return Err(HcdError::Unsupported(
                "Word region index requires layout model 2".into(),
            ));
        }
        let layout = crate::read_flow_document_layout(bundle, manifest)?
            .ok_or_else(|| invalid("missing layout"))?;
        Ok(Self {
            bundle,
            regions: catalog(&layout),
        })
    }
    pub fn page(&self, index: &ChunkIndexPage) -> Result<Vec<Option<String>>, HcdError> {
        self.page_regions(index, false)
    }
    /// Verify body identities too, for grouping a section split into chunks.
    pub fn page_all(&self, index: &ChunkIndexPage) -> Result<Vec<Option<String>>, HcdError> {
        self.page_regions(index, true)
    }
    fn page_regions(
        &self,
        index: &ChunkIndexPage,
        include_body: bool,
    ) -> Result<Vec<Option<String>>, HcdError> {
        index
            .chunks
            .iter()
            .map(|descriptor| {
                if !(["header", "footer"].contains(&descriptor.region.as_str())
                    || include_body && descriptor.region == "body")
                {
                    return Ok(None);
                }
                let html = self.bundle.read_chunk_verified(descriptor)?;
                let map = self.bundle.read_map_verified(descriptor)?;
                let (_, region) = chunk_region(&html, &map, descriptor, Some(&self.regions))?;
                Ok(region.map(|value| value.id))
            })
            .collect()
    }
}

pub(crate) struct FlowGraphValidator {
    catalog: HashMap<String, FlowRegion>,
    closed: HashSet<String>,
    current: Option<String>,
    last: HashMap<String, String>,
    body_order: Vec<String>,
    count: usize,
    block_ids: crate::validate::NodeIdTracker,
}
impl FlowGraphValidator {
    pub(crate) fn new(layout: &FlowDocumentLayout) -> Result<Self, HcdError> {
        Ok(Self {
            catalog: catalog(layout),
            closed: HashSet::new(),
            current: None,
            last: HashMap::new(),
            body_order: Vec::new(),
            count: 0,
            block_ids: crate::validate::NodeIdTracker::new()?,
        })
    }
    fn observe(&mut self, block: &Block) -> Result<(), HcdError> {
        self.count += 1;
        if self.count > MAX_BLOCKS {
            return Err(HcdError::ResourceLimit("Word region root limit".into()));
        }
        if root_identity(&block.html)?.as_deref() != Some(&block.id) {
            return Err(invalid("canonical root identity is missing or unstable"));
        }
        self.block_ids.push(
            crate::validate::decode_node_id(&block.id)
                .ok_or_else(|| invalid("invalid canonical block identity"))?,
        )?;
        if ["body", "header", "footer"].contains(&block.region.as_str()) != block.scope.is_some() {
            return Err(invalid("block is missing its canonical region"));
        }
        let next = block.scope.as_ref().map(|scope| scope.id.clone());
        if next != self.current {
            if let Some(id) = self.current.take() {
                self.closed.insert(id);
            }
            if next.as_ref().is_some_and(|id| self.closed.contains(id)) {
                return Err(invalid("noncontiguous region"));
            }
            if let Some(scope) = &block.scope {
                if scope.kind == FlowRegionKind::Body {
                    self.body_order.push(scope.id.clone());
                }
            }
            self.current = next;
        }
        if let Some(scope) = &block.scope {
            if self.catalog.get(&scope.id) != Some(scope)
                || scope.kind.as_str() != block.region
                || block.source_part.as_deref() != Some(scope.source_part.as_str())
                || block
                    .entries
                    .iter()
                    .any(|entry| entry.source.part != scope.source_part)
            {
                return Err(invalid("block has a foreign region/source"));
            }
            self.last.insert(scope.id.clone(), block.id.clone());
        }
        Ok(())
    }
    pub(crate) fn scan(
        &mut self,
        html: &str,
        map: &ChunkSourceMap,
        descriptor: &ChunkDescriptor,
        document_id: &str,
    ) -> Result<(), HcdError> {
        let (part, scope) = chunk_region(html, map, descriptor, Some(&self.catalog))?;
        for mut block in scan_chunk(html, map, descriptor, document_id)? {
            if block.html == html {
                return Err(invalid("canonical region needs a stable root"));
            }
            block.source_part = part.clone();
            block.scope = scope.clone();
            self.observe(&block)?;
        }
        Ok(())
    }
    pub(crate) fn finish(self, layout: &FlowDocumentLayout) -> Result<(), HcdError> {
        if self.block_ids.finish()?.is_some() {
            return Err(invalid("duplicate root block identity"));
        }
        if self.catalog.keys().any(|id| !self.last.contains_key(id))
            || self.body_order
                != layout
                    .sections
                    .iter()
                    .map(|s| s.id.clone())
                    .collect::<Vec<_>>()
        {
            return Err(invalid("missing region or body section order"));
        }
        for section in &layout.sections {
            if let Some(end) = &section.canonical_end_block_id {
                if self.last.get(&section.id) != Some(end) {
                    return Err(invalid("section boundary is not its final root block"));
                }
            }
        }
        Ok(())
    }
}
pub(super) fn validate_graph(
    layout: &FlowDocumentLayout,
    blocks: &[Block],
) -> Result<(), HcdError> {
    let mut state = FlowGraphValidator::new(layout)?;
    for block in blocks {
        state.observe(block)?;
    }
    state.finish(layout)
}

/// Validate a single independent-story transition against separately loaded
/// canonical roots. The new story is appended; every old root and source map
/// remains byte-for-byte identical. Resource and business-identity checks are
/// separate and must also be performed by a publishing transaction.
pub(super) fn validate_unlink_roots(
    before: &FlowDocumentLayout,
    after: &FlowDocumentLayout,
    old: &[Block],
    new: &[Block],
) -> Result<(), HcdError> {
    crate::validate_flow_story_unlink_transition(before, after)?;
    validate_graph(before, old)?;
    validate_graph(after, new)?;
    if new.len() <= old.len() {
        return Err(invalid("independent story has no new root"));
    }
    for (previous, current) in old.iter().zip(new) {
        if previous.scope != current.scope
            || previous.source_part != current.source_part
            || previous.id != current.id
            || previous.region != current.region
            || previous.read_only != current.read_only
            || previous.html != current.html
            || previous.entries != current.entries
        {
            return Err(invalid("independent story changed an existing root"));
        }
    }
    let story = after
        .stories
        .last()
        .ok_or_else(|| invalid("missing new story"))?;
    if new[old.len()..].iter().any(|block| {
        block
            .scope
            .as_ref()
            .is_none_or(|scope| scope.id != story.id)
    }) {
        return Err(invalid("independent story added a foreign root"));
    }
    let mut used: HashSet<&str> = old
        .iter()
        .flat_map(|block| {
            std::iter::once(block.id.as_str())
                .chain(block.entries.iter().map(|entry| entry.node_id.as_str()))
        })
        .collect();
    for block in &new[old.len()..] {
        if !used.insert(block.id.as_str()) {
            return Err(invalid("independent story root identity collision"));
        }
        let text = extract_html_text_nodes(&block.html)?;
        if text.len() != block.entries.len() {
            return Err(invalid("independent story text/source map mismatch"));
        }
        for entry in &block.entries {
            if !used.insert(entry.node_id.as_str()) {
                return Err(invalid("independent story text identity collision"));
            }
            if text
                .get(&entry.node_id)
                .is_none_or(|value| hash_bytes(value.as_bytes()) != entry.node_hash)
            {
                return Err(invalid("independent story text/source map mismatch"));
            }
        }
    }
    Ok(())
}

/// Compare two independently stored consecutive revisions. This is a
/// read-only verifier, not a transaction or proof of collaboration ownership.
pub fn validate_unlink_revision_content(
    bundle: &Bundle,
    previous_revision: u64,
    next_revision: u64,
) -> Result<(), HcdError> {
    if previous_revision.checked_add(1) != Some(next_revision) {
        return Err(invalid("independent story revisions must be consecutive"));
    }
    let head = bundle.manifest()?;
    let (previous, _) = crate::manifest_at_revision(bundle, &head, Some(previous_revision))?;
    let (next, _) = crate::manifest_at_revision(bundle, &head, Some(next_revision))?;
    if previous.annotation_root_hash != next.annotation_root_hash {
        return Err(invalid("independent story changed annotations"));
    }
    let old_layout = crate::read_flow_document_layout(bundle, &previous)?
        .ok_or_else(|| invalid("missing prior layout"))?;
    let new_layout = crate::read_flow_document_layout(bundle, &next)?
        .ok_or_else(|| invalid("missing new layout"))?;
    let old_blocks = load_blocks(bundle, &previous)?;
    let new_blocks = load_blocks(bundle, &next)?;
    validate_unlink_roots(&old_layout, &new_layout, &old_blocks, &new_blocks)?;
    let unrelated = |revision| -> Result<Vec<crate::AssetDescriptor>, HcdError> {
        let mut assets: Vec<_> = bundle
            .read_asset_index_for_revision(revision)?
            .into_iter()
            .filter(|asset| {
                ![
                    crate::FLOW_LAYOUT_SOURCE_PART,
                    FLOW_REGION_LAYOUT_SOURCE_PART,
                ]
                .contains(&asset.source_part.as_str())
            })
            .collect();
        assets.sort_by(|a, b| {
            (&a.source_part, &a.hash, &a.href, a.byte_length).cmp(&(
                &b.source_part,
                &b.hash,
                &b.href,
                b.byte_length,
            ))
        });
        Ok(assets)
    };
    if unrelated(previous_revision)? != unrelated(next_revision)? {
        return Err(invalid("independent story changed unrelated assets"));
    }
    Ok(())
}
pub(crate) fn validate_revision_regions(
    bundle: &Bundle,
    manifest: &HcdManifest,
    layout: &FlowDocumentLayout,
) -> Result<(), HcdError> {
    let mut state = FlowGraphValidator::new(layout)?;
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            state.scan(
                &bundle.read_chunk_verified(&descriptor)?,
                &bundle.read_map_verified(&descriptor)?,
                &descriptor,
                &manifest.document_id,
            )?;
        }
    }
    state.finish(layout)
}

fn root_identity(html: &str) -> Result<Option<String>, HcdError> {
    let mut reader = Reader::from_str(html);
    match reader.read_event().map_err(|e| invalid(&e.to_string()))? {
        Event::Start(start) | Event::Empty(start) => attribute(&start, &reader, "data-hcd-id"),
        _ => Err(invalid("missing root element")),
    }
}
fn materialize_identity(block: &mut Block, document_id: &str) -> Result<(), HcdError> {
    if block.entries.iter().any(|entry| entry.node_id == block.id) {
        block.id = stable_node_id(&[document_id, &block.id, "flow-root"]);
    }
    if root_identity(&block.html)?.as_deref() == Some(&block.id) {
        return Ok(());
    }
    let mut reader = Reader::from_str(&block.html);
    let event = reader.read_event().map_err(|e| invalid(&e.to_string()))?;
    let empty = matches!(event, Event::Empty(_));
    let start = match event {
        Event::Start(start) | Event::Empty(start) => start,
        _ => return Err(invalid("missing imported root")),
    };
    let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
    let mut updated = BytesStart::new(name);
    for attr in start.attributes() {
        let attr = attr.map_err(|e| invalid(&e.to_string()))?;
        if attr.key.as_ref() != b"data-hcd-id" {
            let key = String::from_utf8_lossy(attr.key.as_ref());
            let value = attr
                .decode_and_unescape_value(reader.decoder())
                .map_err(|e| invalid(&e.to_string()))?;
            updated.push_attribute((key.as_ref(), value.as_ref()));
        }
    }
    updated.push_attribute(("data-hcd-id", block.id.as_str()));
    let end = reader.buffer_position() as usize;
    let mut writer = quick_xml::Writer::new(Vec::new());
    writer
        .write_event(if empty {
            Event::Empty(updated)
        } else {
            Event::Start(updated)
        })
        .map_err(|e| invalid(&e.to_string()))?;
    let prefix = String::from_utf8(writer.into_inner()).map_err(|e| invalid(&e.to_string()))?;
    block.html.replace_range(..end, &prefix);
    Ok(())
}

fn source_ordinals(html: &str) -> Result<Vec<u64>, HcdError> {
    let mut reader = Reader::from_str(html);
    let mut result = Vec::new();
    let mut buffer = Vec::new();
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|e| invalid(&e.to_string()))?
        {
            Event::Start(start) | Event::Empty(start) => {
                if let Some(value) = attribute(&start, &reader, "data-hcd-word-body-paragraph")? {
                    result.push(
                        value
                            .parse()
                            .map_err(|_| invalid("invalid source paragraph ordinal"))?,
                    )
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(result)
}

/// Explicit upgrade only. Legacy public projection paths remain closed until
/// the signed collaboration protocol negotiates regional editing.
pub fn project_flow_regions(
    bundle: &Bundle,
    expected_revision: u64,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    let projection_id = format!("flow-region-projection-{expected_revision}");
    let projection_hash =
        hash_bytes(format!("flow-region-projection/2:{expected_revision}").as_bytes());
    if expected_revision < manifest.revision {
        let record = bundle.revision(expected_revision + 1)?;
        if record.patch_id.as_deref() == Some(projection_id.as_str())
            && record.patch_hash.as_deref() == Some(projection_hash.as_str())
            && record.structural_change
        {
            return Ok(ApplyResult {
                document_id: record.document_id,
                patch_id: projection_id,
                base_revision: expected_revision,
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
    if manifest.revision != expected_revision {
        return Err(HcdError::RevisionConflict(
            "Word region projection base changed".into(),
        ));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let mut layout = crate::read_flow_document_layout(bundle, &manifest)?
        .ok_or_else(|| HcdError::Unsupported("Word layout import required".into()))?;
    if layout.schema_version != crate::FLOW_LAYOUT_SCHEMA || manifest.capabilities.structure_patch {
        return Err(HcdError::Unsupported(
            "Word region projection requires an unprojected layout model 1".into(),
        ));
    }
    let mut blocks = load_blocks(bundle, &manifest)?;
    if blocks
        .iter()
        .any(|b| b.html.trim_start().starts_with("<section"))
    {
        return Err(HcdError::Unsupported(
            "opaque chunk needs a stable root before region projection".into(),
        ));
    }
    for block in &mut blocks {
        materialize_identity(block, &manifest.document_id)?;
    }
    let regions = flow_regions(&layout);
    let mut section = 0usize;
    for block in blocks.iter_mut().filter(|b| b.region == "body") {
        let ordinals = source_ordinals(&block.html)?;
        let scope = regions[section].clone();
        block.scope = Some(scope);
        block.source_part = Some("word/document.xml".into());
        if let Some(end) = layout.sections[section].source.paragraph_ordinal {
            if ordinals.contains(&end) {
                if ordinals.iter().any(|ordinal| *ordinal > end) {
                    return Err(HcdError::Unsupported(
                        "a compound block crosses a section boundary; split its root first".into(),
                    ));
                }
                layout.sections[section].canonical_end_block_id = Some(block.id.clone());
                section += 1;
            } else if ordinals.iter().any(|ordinal| *ordinal > end) {
                return Err(invalid("source section boundary was not found"));
            }
        }
    }
    if section + 1 != layout.sections.len() {
        return Err(HcdError::Unsupported(
            "source section boundaries need import paragraph identities".into(),
        ));
    }
    let by_part: HashMap<_, _> = regions
        .iter()
        .filter(|r| r.kind != FlowRegionKind::Body)
        .map(|r| (r.source_part.as_str(), r))
        .collect();
    for block in blocks
        .iter_mut()
        .filter(|b| ["header", "footer"].contains(&b.region.as_str()))
    {
        let scope = block
            .source_part
            .as_deref()
            .and_then(|p| by_part.get(p))
            .ok_or_else(|| {
                HcdError::Unsupported(
                    "story source identity is missing; reimport the original DOCX before upgrading"
                        .into(),
                )
            })?;
        if scope.kind.as_str() != block.region {
            return Err(invalid("imported story role mismatch"));
        }
        block.scope = Some((*scope).clone());
    }
    for block in &mut blocks {
        if block.scope.is_some() {
            block.read_only = intrinsic_read_only(&block.content, &block.html);
        }
    }
    // Word permits truly empty stories/sections. Seed a canonical editable
    // paragraph instead of borrowing another region's source or dropping it.
    for (seed_index, scope) in regions.iter().enumerate() {
        if !blocks.iter().any(|b| b.scope.as_ref() == Some(scope)) {
            let id = stable_node_id(&[&manifest.document_id, &scope.id, "empty-flow-region"]);
            let block = render_new_block_in_region(
                &manifest,
                &projection_id,
                seed_index,
                id,
                EditorBlockContent {
                    kind: EditorBlockKind::Paragraph,
                    inlines: vec![EditorInline::default()],
                    ..Default::default()
                },
                None,
                Some(scope),
            )?;
            if scope.kind == FlowRegionKind::Body {
                let at = blocks
                    .iter()
                    .position(|b| b.region != "body")
                    .unwrap_or(blocks.len());
                blocks.insert(at, block);
            } else {
                blocks.push(block);
            }
        }
    }
    layout.schema_version = FLOW_REGION_LAYOUT_SCHEMA.into();
    layout.validate()?;
    validate_graph(&layout, &blocks)?;
    let revision = manifest.revision + 1;
    let (descriptors, index_root, dirty_chunks) =
        write_blocks(bundle, &manifest, revision, &blocks)?;
    let mut assets = bundle.read_asset_index_for_revision(manifest.revision)?;
    let asset_href = write_layout_asset(bundle, &layout, &mut assets)?;
    let mut hasher = Sha256::new();
    for d in &descriptors {
        hash_descriptor(&mut hasher, d);
    }
    let root = finalize_root_hash(bundle, hasher, &asset_href)?;
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &projection_id,
        Some(projection_hash),
        true,
    )?;
    record.root_hash = root.clone();
    record.index_root_href = index_root.clone();
    record.index_page_count = Some(descriptors.len().div_ceil(INDEX_PAGE_SIZE));
    record.chunk_count = Some(descriptors.len());
    record.asset_index_href = asset_href;
    record.dirty_chunk_ids = dirty_chunks;
    record.dirty_source_parts = sorted(
        blocks
            .iter()
            .filter_map(|block| block.source_part.clone())
            .chain(regions.iter().map(|region| region.source_part.clone()))
            .collect(),
    );
    if record.dirty_chunk_ids.len() > 10000 || record.dirty_source_parts.len() > 10000 {
        return Err(HcdError::ResourceLimit(
            "Word region projection dirty-set limit".into(),
        ));
    }
    manifest.revision = revision;
    manifest.root_hash = root;
    manifest.index_root_href = index_root;
    manifest.index_page_count = record.index_page_count.unwrap();
    manifest.chunk_count = descriptors.len();
    manifest.capabilities.flow_layout = Some(2);
    manifest.capabilities.structure_patch = true;
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: projection_id,
        base_revision: expected_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: record.dirty_chunk_ids,
        dirty_source_parts: record.dirty_source_parts,
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}

pub(super) fn write_layout_asset(
    bundle: &Bundle,
    layout: &FlowDocumentLayout,
    assets: &mut Vec<crate::AssetDescriptor>,
) -> Result<String, HcdError> {
    let bytes = serde_json::to_vec(layout)?;
    let hash = hash_bytes(&bytes);
    let href = format!("assets/sha256/{hash}.json");
    crate::bundle::atomic_write(&bundle.resolve_href(&href)?, &bytes)?;
    assets.retain(|a| {
        ![
            crate::FLOW_LAYOUT_SOURCE_PART,
            FLOW_REGION_LAYOUT_SOURCE_PART,
        ]
        .contains(&a.source_part.as_str())
    });
    assets.push(crate::AssetDescriptor {
        source_part: FLOW_REGION_LAYOUT_SOURCE_PART.into(),
        href,
        hash,
        byte_length: bytes.len() as u64,
    });
    assets.sort_by(|a, b| a.hash.cmp(&b.hash));
    Ok(bundle.write_json_object("assets/indexes", assets)?.0)
}

fn reject_other_topology_identity(
    record: &RevisionRecord,
    transaction_id: &str,
    prefix: &str,
) -> Result<(), HcdError> {
    if ["word-layout-", "word-story-link-", "word-story-unlink-"]
        .iter()
        .filter(|candidate| **candidate != prefix)
        .any(|candidate| {
            record.patch_id.as_deref() == Some(format!("{candidate}{transaction_id}").as_str())
        })
    {
        return Err(HcdError::InvalidPatch(
            "Word topology identity already used".into(),
        ));
    }
    Ok(())
}

/// Commit only section fields into the versioned layout asset. This is a
/// native primitive, not an authorized collaboration endpoint: callers must
/// fence the live room, authenticate contributors and persist signed receipts.
pub fn apply_flow_layout_transaction(
    bundle: &Bundle,
    request: &crate::FlowLayoutTransaction,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    let encoded = serde_json::to_vec(request)?;
    if encoded.len() > crate::MAX_FLOW_LAYOUT_EDITS_BYTES {
        return Err(HcdError::ResourceLimit(
            "Word layout transaction exceeds 256 KiB".into(),
        ));
    }
    if request.schema_version != crate::FLOW_LAYOUT_TRANSACTION_SCHEMA
        || request.document_id != manifest.document_id
        || request.transaction_id.len() != 32
        || !request
            .transaction_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.base_revision > request.expected_revision
        || request
            .actor
            .keys()
            .any(|key| !["userId", "displayName"].contains(&key.as_str()))
    {
        return Err(HcdError::InvalidPatch(
            "invalid Word layout transaction envelope".into(),
        ));
    }
    let (author_id, author_name) = crate::revision_author(&request.actor)?;
    let patch_id = format!("word-layout-{}", request.transaction_id);
    let patch_hash = hash_bytes(&encoded);
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if record.patch_id.as_deref() == Some(&patch_id) {
            if record.patch_hash.as_deref() != Some(&patch_hash) {
                return Err(HcdError::InvalidPatch(
                    "transaction ID reused with different content".into(),
                ));
            }
            return Ok(ApplyResult {
                document_id: record.document_id,
                patch_id,
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
        reject_other_topology_identity(&record, &request.transaction_id, "word-layout-")?;
    }
    if manifest.revision != request.expected_revision {
        return Err(HcdError::RevisionConflict(
            "Word layout transaction head changed".into(),
        ));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let (base_manifest, _) =
        crate::manifest_at_revision(bundle, &manifest, Some(request.base_revision))?;
    let base = crate::read_flow_document_layout(bundle, &base_manifest)?
        .ok_or_else(|| HcdError::Unsupported("Word layout import required".into()))?;
    let current = crate::read_flow_document_layout(bundle, &manifest)?
        .ok_or_else(|| HcdError::Unsupported("Word layout import required".into()))?;
    let next = crate::plan_flow_layout_edits(&base, &current, &request.edits)?;
    let mut assets = bundle.read_asset_index_for_revision(manifest.revision)?;
    let asset_href = write_layout_asset(bundle, &next, &mut assets)?;
    let mut hasher = Sha256::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            hash_descriptor(&mut hasher, &descriptor);
        }
    }
    let root = finalize_root_hash(bundle, hasher, &asset_href)?;
    let revision = manifest.revision + 1;
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch_id,
        Some(patch_hash),
        true,
    )?;
    record.patch_base_revision = Some(request.base_revision);
    record.root_hash = root.clone();
    record.asset_index_href = asset_href;
    record.dirty_source_parts = vec!["word/document.xml".into()];
    record.word_layout_change = true;
    record.author_id = author_id;
    record.author_name = author_name;
    manifest.revision = revision;
    manifest.root_hash = root;
    manifest.capabilities.word_layout_edits =
        Some(manifest.capabilities.word_layout_edits.unwrap_or(1));
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id,
        base_revision: request.base_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: record.dirty_source_parts,
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}

/// Pin a read-only link candidate to one canonical revision. The private
/// bundle lock remains internal; callers receive no writer/commit capability.
pub fn preview_flow_story_link_transaction(
    bundle: &Bundle,
    request: &crate::FlowStoryLinkTransaction,
) -> Result<crate::FlowStoryLinkPreview, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    if request.schema_version != crate::FLOW_STORY_LINK_TRANSACTION_SCHEMA
        || request.document_id != manifest.document_id
        || request.transaction_id.len() != 32
        || !request
            .transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || request.actor.len() != 2
        || request
            .actor
            .keys()
            .any(|key| !["userId", "displayName"].contains(&key.as_str()))
        || serde_json::to_vec(request)?.len() > crate::MAX_FLOW_LAYOUT_EDITS_BYTES
    {
        return Err(HcdError::InvalidPatch(
            "invalid Word link preflight transaction".into(),
        ));
    }
    crate::revision_author(&request.actor)?;
    if manifest.source.format != "docx"
        || !matches!(manifest.capabilities.word_layout_edits, None | Some(1 | 3))
    {
        return Err(HcdError::Unsupported(
            "supported coordinated Word layout required".into(),
        ));
    }
    if manifest.revision != request.expected_revision || manifest.revision >= MAX_REVISION {
        return Err(HcdError::RevisionConflict(
            "Word link preflight head changed".into(),
        ));
    }
    let layout = crate::read_flow_document_layout(bundle, &manifest)?
        .ok_or_else(|| HcdError::Unsupported("Word layout import required".into()))?;
    let plan = crate::plan_flow_story_link(&layout, &request.link)?;
    Ok(crate::FlowStoryLinkPreview {
        revision: manifest.revision,
        root_hash: manifest.root_hash,
        base_layout_hash: crate::flow_layout_hash(&layout)?,
        candidate_layout_hash: crate::flow_layout_hash(&plan.layout)?,
        plan,
    })
}

/// Commit a reviewed link under an exact document revision. Callers must
/// independently fence the room and protect unsaved story edits; this native
/// primitive is not an authorized collaboration endpoint.
pub fn apply_flow_story_link_transaction(
    bundle: &Bundle,
    request: &crate::FlowStoryLinkTransaction,
) -> Result<ApplyResult, HcdError> {
    apply_story_link_transaction(bundle, request, false)
}

/// Native primitive for a fenced, durably prepared /2 owner. Publication
/// promotes the layout model to 3; it does not drain members or persist the
/// coordinator journal. Callers must complete those steps independently.
pub fn apply_coordinated_flow_story_link_transaction(
    bundle: &Bundle,
    request: &crate::FlowStoryLinkTransaction,
) -> Result<ApplyResult, HcdError> {
    apply_story_link_transaction(bundle, request, true)
}

fn apply_story_link_transaction(
    bundle: &Bundle,
    request: &crate::FlowStoryLinkTransaction,
    coordinated: bool,
) -> Result<ApplyResult, HcdError> {
    let _guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    if coordinated
        && (manifest.source.format != "docx"
            || !matches!(manifest.capabilities.word_layout_edits, None | Some(1 | 3))
            || request.actor.len() != 2)
    {
        return Err(HcdError::Unsupported(
            "supported coordinated Word link required".into(),
        ));
    }
    let encoded = serde_json::to_vec(request)?;
    if encoded.len() > crate::MAX_FLOW_LAYOUT_EDITS_BYTES
        || request.schema_version != crate::FLOW_STORY_LINK_TRANSACTION_SCHEMA
        || request.document_id != manifest.document_id
        || request.transaction_id.len() != 32
        || !request
            .transaction_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request
            .actor
            .keys()
            .any(|key| !["userId", "displayName"].contains(&key.as_str()))
    {
        return Err(HcdError::InvalidPatch(
            "invalid Word story link transaction".into(),
        ));
    }
    let (author_id, author_name) = crate::revision_author(&request.actor)?;
    let patch_id = format!("word-story-link-{}", request.transaction_id);
    let patch_hash = if coordinated {
        crate::coordinated_flow_story_link_hash(request)?
    } else {
        hash_bytes(&encoded)
    };
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if record.patch_id.as_deref() == Some(&patch_id) {
            if record.patch_hash.as_deref() != Some(&patch_hash) {
                return Err(HcdError::InvalidPatch(
                    "transaction ID reused with different content".into(),
                ));
            }
            return Ok(ApplyResult {
                document_id: record.document_id,
                patch_id,
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
        if coordinated {
            reject_other_topology_identity(&record, &request.transaction_id, "word-story-link-")?;
        }
    }
    if manifest.revision != request.expected_revision {
        return Err(HcdError::RevisionConflict(
            "Word story link transaction head changed".into(),
        ));
    }
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let current = crate::read_flow_document_layout(bundle, &manifest)?
        .ok_or_else(|| HcdError::Unsupported("Word layout import required".into()))?;
    let next = crate::plan_flow_story_link(&current, &request.link)?.layout;
    let mut assets = bundle.read_asset_index_for_revision(manifest.revision)?;
    let asset_href = write_layout_asset(bundle, &next, &mut assets)?;
    let mut hasher = Sha256::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            hash_descriptor(&mut hasher, &descriptor);
        }
    }
    let root = finalize_root_hash(bundle, hasher, &asset_href)?;
    let revision = manifest.revision + 1;
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch_id,
        Some(patch_hash),
        true,
    )?;
    record.patch_base_revision = Some(request.expected_revision);
    record.root_hash = root.clone();
    record.asset_index_href = asset_href;
    record.dirty_source_parts = vec!["word/document.xml".into()];
    record.word_layout_change = true;
    record.author_id = author_id;
    record.author_name = author_name;
    manifest.revision = revision;
    manifest.root_hash = root;
    manifest.capabilities.word_layout_edits = Some(if coordinated {
        3
    } else {
        manifest.capabilities.word_layout_edits.unwrap_or(0).max(2)
    });
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id,
        base_revision: request.expected_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: Vec::new(),
        dirty_source_parts: record.dirty_source_parts,
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}

/// Native-only primitive. The caller must fence all live room edits, verify
/// the source package destination, authenticate the actor and retain the
/// fence through publication. This is not a collaboration endpoint.
pub fn apply_prepared_story_unlink(
    bundle: &Bundle,
    candidate: &PreparedStoryUnlink,
    transaction_id: &str,
    actor: &BTreeMap<String, String>,
) -> Result<ApplyResult, HcdError> {
    let guard = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    ensure_semantic_flow(&manifest)?;
    if transaction_id.len() != 32
        || !transaction_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || actor
            .keys()
            .any(|key| !["userId", "displayName"].contains(&key.as_str()))
    {
        return Err(HcdError::InvalidPatch(
            "invalid Word story unlink transaction".into(),
        ));
    }
    let (author_id, author_name) = crate::revision_author(actor)?;
    let patch_id = format!("word-story-unlink-{transaction_id}");
    let patch_hash = hash_bytes(&serde_json::to_vec(&(candidate.commitment()?, actor))?);
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        if record.patch_id.as_deref() == Some(&patch_id) {
            if record.patch_hash.as_deref() != Some(&patch_hash) {
                return Err(HcdError::InvalidPatch(
                    "transaction ID reused with different content".into(),
                ));
            }
            return Ok(ApplyResult {
                document_id: record.document_id,
                patch_id,
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
        reject_other_topology_identity(&record, transaction_id, "word-story-unlink-")?;
    }
    candidate.validate_locked(bundle, &guard)?;
    if manifest.revision >= MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    let old_layout = crate::read_flow_document_layout(bundle, &manifest)?
        .ok_or_else(|| invalid("missing layout"))?;
    let story = candidate
        .layout
        .stories
        .last()
        .ok_or_else(|| invalid("missing new story"))?;
    let scope = flow_regions(&candidate.layout)
        .into_iter()
        .find(|scope| scope.id == story.id)
        .ok_or_else(|| invalid("missing story scope"))?;
    let mut blocks = load_blocks(bundle, &manifest)?;
    let old_count = blocks.len();
    let render_id = format!("word-story-unlink-{}-{}", story.id, candidate.revision);
    for (index, (content, view)) in candidate.content.iter().zip(&candidate.blocks).enumerate() {
        let block = render_new_block_in_region(
            &manifest,
            &render_id,
            index,
            view.block_id.clone(),
            content.clone(),
            None,
            Some(&scope),
        )?;
        if block.hash() != view.block_hash {
            return Err(HcdError::PreconditionFailed(
                "Word story candidate rendering changed".into(),
            ));
        }
        blocks.push(block);
    }
    if candidate.content.len() != candidate.blocks.len() {
        return Err(HcdError::InvalidPatch(
            "Word story candidate root count changed".into(),
        ));
    }
    validate_unlink_roots(
        &old_layout,
        &candidate.layout,
        &blocks[..old_count],
        &blocks,
    )?;
    let revision = manifest.revision + 1;
    let (descriptors, index_root, dirty_chunks) =
        write_blocks(bundle, &manifest, revision, &blocks)?;
    let mut assets = bundle.read_asset_index_for_revision(manifest.revision)?;
    let asset_href = write_layout_asset(bundle, &candidate.layout, &mut assets)?;
    let mut hasher = Sha256::new();
    for descriptor in &descriptors {
        hash_descriptor(&mut hasher, descriptor);
    }
    let root = finalize_root_hash(bundle, hasher, &asset_href)?;
    let mut record = revision_record(
        bundle,
        &manifest,
        revision,
        &patch_id,
        Some(patch_hash),
        true,
    )?;
    record.root_hash = root.clone();
    record.index_root_href = index_root.clone();
    record.index_page_count = Some(descriptors.len().div_ceil(INDEX_PAGE_SIZE));
    record.chunk_count = Some(descriptors.len());
    record.asset_index_href = asset_href;
    record.dirty_chunk_ids = dirty_chunks;
    record.dirty_source_parts = sorted(HashSet::from([
        "word/document.xml".into(),
        story.source_part.clone(),
    ]));
    record.author_id = author_id;
    record.author_name = author_name;
    if record.dirty_chunk_ids.len() > 10000 {
        return Err(HcdError::ResourceLimit("Word story dirty-set limit".into()));
    }
    manifest.revision = revision;
    manifest.root_hash = root;
    manifest.index_root_href = index_root;
    manifest.index_page_count = record.index_page_count.unwrap();
    manifest.chunk_count = descriptors.len();
    manifest.capabilities.word_layout_edits = Some(3);
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id,
        base_revision: candidate.revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: Vec::new(),
        dirty_chunk_ids: record.dirty_chunk_ids,
        dirty_source_parts: record.dirty_source_parts,
        warnings: Vec::new(),
        idempotent_replay: false,
    })
}

/// Validate the immutable history transition independently of the writer.
/// Verify just one immutable link transition, including untouched content
/// indexes and non-layout resources. This does not authorize publication.
pub fn validate_flow_story_link_revision(bundle: &Bundle, revision: u64) -> Result<(), HcdError> {
    let head = bundle.manifest()?;
    if revision == 0 || revision > head.revision {
        return Err(invalid("invalid link receipt revision"));
    }
    let record = bundle.revision(revision)?;
    let previous = bundle.revision(revision - 1)?;
    if !record.word_layout_change
        || !record.structural_change
        || record.layout_upgrade
        || !record.dirty_node_ids.is_empty()
        || !record.dirty_chunk_ids.is_empty()
        || record.dirty_source_parts != ["word/document.xml"]
        || !record
            .patch_id
            .as_deref()
            .is_some_and(|id| id.starts_with("word-story-link-"))
    {
        return Err(invalid("invalid link receipt transition"));
    }
    validate_word_layout_history(bundle, &head, &previous, &record)
}

pub(crate) fn validate_word_layout_history(
    bundle: &Bundle,
    head: &HcdManifest,
    previous: &RevisionRecord,
    record: &RevisionRecord,
) -> Result<(), HcdError> {
    let patch_id = record.patch_id.as_deref().unwrap_or("");
    let story_link = patch_id.starts_with("word-story-link-");
    let transaction_id = patch_id.strip_prefix(if story_link {
        "word-story-link-"
    } else {
        "word-layout-"
    });
    if transaction_id.is_none_or(|value| {
        value.len() != 32
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) || previous.index_prefix != record.index_prefix
        || previous.index_root_href != record.index_root_href
        || previous.index_page_count != record.index_page_count
        || previous.chunk_count != record.chunk_count
        || previous.annotation_root_hash != record.annotation_root_hash
        || previous.asset_index_href == record.asset_index_href
        || previous.root_hash == record.root_hash
    {
        return Err(invalid("invalid layout-only revision transition"));
    }
    let (old_manifest, _) = crate::manifest_at_revision(bundle, head, Some(previous.revision))?;
    let (new_manifest, _) = crate::manifest_at_revision(bundle, head, Some(record.revision))?;
    let old = crate::read_flow_document_layout(bundle, &old_manifest)?
        .ok_or_else(|| invalid("missing prior layout"))?;
    let new = crate::read_flow_document_layout(bundle, &new_manifest)?
        .ok_or_else(|| invalid("missing new layout"))?;
    if old.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || new.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || old.sections.len() != new.sections.len()
        || old == new
    {
        return Err(invalid("invalid layout-only model transition"));
    }
    if story_link {
        if !matches!(head.capabilities.word_layout_edits, Some(2 | 3))
            || record.patch_base_revision != Some(previous.revision)
        {
            return Err(invalid("story link requires layout history model 2"));
        }
        crate::validate_flow_story_link_transition(&old, &new)?;
    } else {
        let mut expected = old.clone();
        expected.even_and_odd_headers = new.even_and_odd_headers;
        for (before, after) in expected.sections.iter_mut().zip(&new.sections) {
            before.page = after.page.clone();
            before.different_first_page = after.different_first_page;
        }
        if expected != new {
            return Err(invalid(
                "layout-only revision changed section or story topology",
            ));
        }
    }
    let unrelated = |revision| -> Result<Vec<crate::AssetDescriptor>, HcdError> {
        let mut assets: Vec<_> = bundle
            .read_asset_index_for_revision(revision)?
            .into_iter()
            .filter(|asset| {
                ![
                    crate::FLOW_LAYOUT_SOURCE_PART,
                    FLOW_REGION_LAYOUT_SOURCE_PART,
                ]
                .contains(&asset.source_part.as_str())
            })
            .collect();
        // Index order is not part of an asset's identity. A layout write
        // canonicalizes its index, whereas an imported index need not have
        // been ordered the same way.
        assets.sort_by(|a, b| {
            (&a.source_part, &a.href, &a.hash, a.byte_length).cmp(&(
                &b.source_part,
                &b.href,
                &b.hash,
                b.byte_length,
            ))
        });
        Ok(assets)
    };
    if unrelated(previous.revision)? != unrelated(record.revision)? {
        return Err(invalid("layout-only revision changed other assets"));
    }
    Ok(())
}

pub fn apply_flow_structure_patch(
    bundle: &Bundle,
    patch: &FlowStructurePatchBatch,
    expected_revision: u64,
) -> Result<ApplyResult, HcdError> {
    let encoded = serde_json::to_vec(patch)?;
    if encoded.len() as u64 > MAX_PATCH_JSON_BYTES {
        return Err(HcdError::ResourceLimit(
            "Word region patch exceeds 8 MiB".into(),
        ));
    }
    if patch.schema_version != FLOW_STRUCTURE_PATCH_SCHEMA
        || patch.regions.is_empty()
        || patch.regions.len() > 12288
    {
        return Err(HcdError::InvalidPatch(
            "invalid hcd-patch/6 envelope".into(),
        ));
    }
    let flat = StructurePatchBatch {
        schema_version: patch.schema_version.clone(),
        document_id: patch.document_id.clone(),
        patch_id: patch.patch_id.clone(),
        base_revision: patch.base_revision,
        actor: patch.actor.clone(),
        operations: patch
            .regions
            .iter()
            .flat_map(|r| r.operations.clone())
            .collect(),
    };
    super::apply_structure_patch_inner(bundle, &flat, expected_revision, Some((patch, &encoded)))
}

pub(super) fn insertion_index(
    blocks: &[Block],
    after: Option<&str>,
    scope: &FlowRegion,
) -> Result<usize, HcdError> {
    match after {
        Some(id) => {
            let index = blocks
                .iter()
                .position(|b| b.id == id)
                .ok_or_else(|| HcdError::NodeNotFound(id.into()))?;
            if blocks[index].scope.as_ref() != Some(scope) {
                return Err(HcdError::InvalidPatch("foreign region anchor".into()));
            }
            Ok(index + 1)
        }
        None => blocks
            .iter()
            .position(|b| b.scope.as_ref() == Some(scope))
            .ok_or_else(|| invalid("region has no canonical root")),
    }
}
pub(super) fn operation_regions(
    patch: &FlowStructurePatchBatch,
    layout: &FlowDocumentLayout,
    blocks: &[Block],
) -> Result<Vec<FlowRegion>, HcdError> {
    if patch.layout_hash != flow_layout_hash(layout)? {
        return Err(HcdError::PreconditionFailed(
            "Word section/story layout changed".into(),
        ));
    }
    let regions = flow_regions(layout);
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    let sources: HashMap<_, _> = blocks
        .iter()
        .flat_map(|b| {
            b.entries
                .iter()
                .map(move |e| (e.node_id.as_str(), b.scope.as_ref()))
        })
        .collect();
    for group in &patch.regions {
        if !seen.insert(&group.region_id) || group.operations.is_empty() {
            return Err(HcdError::InvalidPatch(
                "duplicate/empty Word region group".into(),
            ));
        }
        let scope = regions
            .iter()
            .find(|r| r.id == group.region_id)
            .ok_or_else(|| HcdError::InvalidPatch("unknown Word region".into()))?;
        for operation in &group.operations {
            let target = match operation {
                StructureOperation::Delete { block_id, .. }
                | StructureOperation::Move { block_id, .. }
                | StructureOperation::Replace { block_id, .. } => Some(block_id.as_str()),
                _ => None,
            };
            if let Some(id) = target {
                let block = blocks
                    .iter()
                    .find(|b| b.id == id)
                    .ok_or_else(|| HcdError::NodeNotFound(id.into()))?;
                if block.scope.as_ref() != Some(scope) {
                    return Err(HcdError::InvalidPatch(
                        "block belongs to another Word region".into(),
                    ));
                }
            }
            if let StructureOperation::ImageGeometry { node_id, .. }
            | StructureOperation::ImageReplace { node_id, .. } = operation
            {
                if sources.get(node_id.as_str()).copied().flatten() != Some(scope) {
                    return Err(HcdError::InvalidPatch(
                        "image belongs to another Word region".into(),
                    ));
                }
            }
            if let StructureOperation::Insert { after_block_id, .. }
            | StructureOperation::Move { after_block_id, .. } = operation
            {
                if let Some(id) = after_block_id {
                    if let Some(anchor) = blocks.iter().find(|b| b.id == *id) {
                        if anchor.scope.as_ref() != Some(scope) {
                            return Err(HcdError::InvalidPatch(
                                "foreign Word region anchor".into(),
                            ));
                        }
                    }
                }
            }
            if let StructureOperation::Insert { block, .. }
            | StructureOperation::Replace { block, .. } = operation
            {
                for inline in content_inlines(block) {
                    if let Some(id) = &inline.node_id {
                        if sources.get(id.as_str()).copied().flatten() != Some(scope) {
                            return Err(HcdError::InvalidPatch(
                                "text source belongs to another Word region".into(),
                            ));
                        }
                    }
                }
            }
            output.push(scope.clone());
        }
    }
    Ok(output)
}
pub(super) fn update_boundaries(
    layout: &mut FlowDocumentLayout,
    blocks: &[Block],
) -> Result<(), HcdError> {
    let final_index = layout.sections.len() - 1;
    for (index, section) in layout.sections.iter_mut().enumerate() {
        section.canonical_end_block_id = if index == final_index {
            None
        } else {
            Some(
                blocks
                    .iter()
                    .rev()
                    .find(|b| b.scope.as_ref().is_some_and(|scope| scope.id == section.id))
                    .ok_or_else(|| {
                        HcdError::InvalidPatch(
                            "cannot remove the final block of a Word region".into(),
                        )
                    })?
                    .id
                    .clone(),
            )
        };
    }
    layout.validate()?;
    validate_graph(layout, blocks).map_err(|e| HcdError::InvalidPatch(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: u8) -> String {
        format!("n_{value:032x}")
    }
    fn layout() -> FlowDocumentLayout {
        FlowDocumentLayout {
            schema_version: FLOW_REGION_LAYOUT_SCHEMA.into(),
            even_and_odd_headers: false,
            sections: vec![crate::FlowSection {
                id: id(1),
                canonical_end_block_id: None,
                source: crate::FlowSectionSource {
                    part: "word/document.xml".into(),
                    paragraph_ordinal: None,
                    paragraph_id: None,
                    original_properties_xml: None,
                },
                different_first_page: false,
                break_type: None,
                page: Default::default(),
                headers: Default::default(),
                footers: Default::default(),
            }],
            stories: vec![crate::FlowStory {
                id: id(2),
                kind: FlowStoryKind::Header,
                source_part: "word/header1.xml".into(),
            }],
        }
    }
    fn chunk(scope: &FlowRegion, root: u8, node: u8) -> (String, ChunkSourceMap, ChunkDescriptor) {
        let chunk_id = format!("c_{root:032x}");
        let hash = hash_bytes(b"Text");
        let html=format!("<section data-hcd-region=\"{}\" data-hcd-flow-region=\"{}\" data-hcd-source-part=\"{}\"><p data-hcd-id=\"{}\" data-hcd-editor-kind=\"paragraph\"><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{hash}\">Text</span></p></section>",scope.kind.as_str(),scope.id,scope.source_part,id(root),id(node));
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.into(),
            chunk_id: chunk_id.clone(),
            entries: vec![NodeMapEntry {
                node_id: id(node),
                node_hash: hash,
                source: SourceAnchor {
                    part: scope.source_part.clone(),
                    text_ordinal: 1,
                    paragraph_id: None,
                    text_id: None,
                    node_kind: "editor-text".into(),
                    editable: true,
                },
            }],
        };
        let descriptor = ChunkDescriptor {
            sequence: 0,
            chunk_id,
            region: scope.kind.as_str().into(),
            html_href: String::new(),
            html_hash: hash_bytes(html.as_bytes()),
            map_href: String::new(),
            map_hash: String::new(),
            byte_length: html.len() as u64,
            block_count: 1,
            node_count: 1,
            text_chars: 4,
            node_bloom: String::new(),
            first_node_id: Some(id(node)),
            last_node_id: Some(id(node)),
            continuation: false,
            grid: None,
        };
        (html, map, descriptor)
    }
    #[test]
    fn independent_story_roots_preserve_existing_content_and_sources() {
        let before = layout();
        let story = crate::FlowStory {
            id: id(7),
            kind: FlowStoryKind::Footer,
            source_part: "word/footer-new.xml".into(),
        };
        let request = crate::FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(1),
            kind: FlowStoryKind::Footer,
            variant: crate::FlowStoryVariant::Default,
            expected_inherited_story_id: None,
        };
        let (_, after) = crate::plan_flow_story_unlink_layout(&before, &request, &story).unwrap();
        let scopes = flow_regions(&after);
        let make = |scope: &FlowRegion, root, node| {
            let (html, map, descriptor) = chunk(scope, root, node);
            let mut block = scan_chunk(&html, &map, &descriptor, "test")
                .unwrap()
                .remove(0);
            block.scope = Some(scope.clone());
            block.source_part = Some(scope.source_part.clone());
            block
        };
        let old = vec![make(&scopes[0], 3, 4), make(&scopes[1], 5, 6)];
        let mut new = old.clone();
        new.push(make(&scopes[2], 8, 9));
        validate_unlink_roots(&before, &after, &old, &new).unwrap();
        let mut changed = new.clone();
        changed[0].html = changed[0].html.replace("Text", "Changed");
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
        changed = new.clone();
        changed[1].entries[0].source.text_ordinal += 1;
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
        assert!(validate_unlink_roots(&before, &after, &old, &old).is_err());
        changed = new.clone();
        changed.push(make(&scopes[1], 10, 11));
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
        changed = new.clone();
        changed[2].html = changed[2].html.replace(&id(9), &id(4));
        changed[2].entries[0].node_id = id(4);
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
        changed = new.clone();
        changed[2].html = changed[2].html.replace(&id(8), &id(4));
        changed[2].id = id(4);
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
        changed = new.clone();
        changed[2].entries[0].node_hash = "0".repeat(64);
        assert!(validate_unlink_roots(&before, &after, &old, &changed).is_err());
    }
    #[test]
    fn independently_stored_revisions_verify_new_story_without_changing_old_roots() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("regional.hcd");
        let mut writer = crate::BundleWriter::create(&path).unwrap();
        writer.write_styles("").unwrap();
        let before = layout();
        let scopes = flow_regions(&before);
        for (scope, root, node) in [(&scopes[0], 3, 4), (&scopes[1], 5, 6)] {
            let (html, map, descriptor) = chunk(scope, root, node);
            writer
                .write_chunk(
                    descriptor.chunk_id,
                    scope.kind.as_str().into(),
                    html,
                    map,
                    1,
                    false,
                )
                .unwrap();
        }
        let bytes = serde_json::to_vec(&before).unwrap();
        let (href, hash, length) = writer
            .write_asset_from_reader("json", &mut bytes.as_slice())
            .unwrap();
        let asset = crate::AssetDescriptor {
            source_part: FLOW_REGION_LAYOUT_SOURCE_PART.into(),
            href,
            hash,
            byte_length: length,
        };
        let (resource_href, resource_hash, resource_length) = writer
            .write_asset_from_reader("bin", &mut b"kept attachment".as_slice())
            .unwrap();
        let resource = crate::AssetDescriptor {
            source_part: "word/media/attachment.bin".into(),
            href: resource_href,
            hash: resource_hash,
            byte_length: resource_length,
        };
        fs::write(
            writer.root().join("assets/index.json"),
            serde_json::to_vec(&vec![asset, resource]).unwrap(),
        )
        .unwrap();
        let mut capabilities = crate::HcdCapabilities::default();
        capabilities.flow_layout = Some(2);
        capabilities.structure_patch = true;
        writer
            .finish(HcdManifest {
                schema_version: HCD_SCHEMA_VERSION.into(),
                storage_codec: Default::default(),
                document_id: "stored-story-fixture".into(),
                profile: "semantic-flow".into(),
                revision: 0,
                source: crate::SourceDescriptor {
                    format: "docx".into(),
                    sha256: "0".repeat(64),
                    size_bytes: 0,
                },
                root_hash: String::new(),
                annotation_root_hash: String::new(),
                annotation_href: None,
                index_prefix: String::new(),
                index_root_href: None,
                index_page_count: 0,
                chunk_count: 0,
                styles_href: String::new(),
                capabilities,
                fidelity: None,
                state: "IMPORTING".into(),
                warnings: vec![],
            })
            .unwrap();
        let bundle = Bundle::open(path).unwrap();
        let mut manifest = bundle.manifest().unwrap();
        let story = crate::FlowStory {
            id: id(7),
            kind: FlowStoryKind::Footer,
            source_part: "word/footer-new.xml".into(),
        };
        let request = crate::FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(1),
            kind: FlowStoryKind::Footer,
            variant: crate::FlowStoryVariant::Default,
            expected_inherited_story_id: None,
        };
        let (_, after) = crate::plan_flow_story_unlink_layout(&before, &request, &story).unwrap();
        let mut blocks = load_blocks(&bundle, &manifest).unwrap();
        let scope = flow_regions(&after).pop().unwrap();
        let (html, map, descriptor) = chunk(&scope, 8, 9);
        let mut block = scan_chunk(&html, &map, &descriptor, &manifest.document_id)
            .unwrap()
            .remove(0);
        block.scope = Some(scope.clone());
        block.source_part = Some(scope.source_part);
        blocks.push(block);
        let (descriptors, index_root, dirty_chunks) =
            write_blocks(&bundle, &manifest, 1, &blocks).unwrap();
        let mut assets = bundle.read_asset_index_for_revision(0).unwrap();
        let asset_href = write_layout_asset(&bundle, &after, &mut assets).unwrap();
        let mut hasher = Sha256::new();
        for descriptor in &descriptors {
            hash_descriptor(&mut hasher, descriptor);
        }
        let root = finalize_root_hash(&bundle, hasher, &asset_href).unwrap();
        let mut record =
            revision_record(&bundle, &manifest, 1, "test-only-story", None, true).unwrap();
        record.root_hash = root.clone();
        record.index_root_href = index_root.clone();
        record.index_page_count = Some(descriptors.len().div_ceil(INDEX_PAGE_SIZE));
        record.chunk_count = Some(descriptors.len());
        record.asset_index_href = asset_href;
        record.dirty_chunk_ids = dirty_chunks;
        manifest.revision = 1;
        manifest.root_hash = root;
        manifest.index_root_href = index_root;
        manifest.index_page_count = record.index_page_count.unwrap();
        manifest.chunk_count = descriptors.len();
        bundle.write_revision(&record).unwrap();
        bundle.write_manifest(&manifest).unwrap();
        validate_unlink_revision_content(&bundle, 0, 1).unwrap();
        assert!(validate_unlink_revision_content(&bundle, 1, 0).is_err());
        let altered: Vec<_> = bundle
            .read_asset_index_for_revision(1)
            .unwrap()
            .into_iter()
            .filter(|asset| asset.source_part != "word/media/attachment.bin")
            .collect();
        let mut tampered = record.clone();
        tampered.asset_index_href = bundle
            .write_json_object("assets/indexes", &altered)
            .unwrap()
            .0;
        bundle.write_revision(&tampered).unwrap();
        assert!(validate_unlink_revision_content(&bundle, 0, 1).is_err());
    }
    #[test]
    fn graph_rejects_missing_foreign_nested_scopes_and_unstable_roots() {
        let layout = layout();
        let scopes = flow_regions(&layout);
        let (body, map, descriptor) = chunk(&scopes[0], 3, 4);
        let (header, hm, hd) = chunk(&scopes[1], 5, 6);
        let mut state = FlowGraphValidator::new(&layout).unwrap();
        state.scan(&body, &map, &descriptor, "test").unwrap();
        state.scan(&header, &hm, &hd, "test").unwrap();
        state.finish(&layout).unwrap();
        for bad in [
            body.replace(&format!("data-hcd-flow-region=\"{}\"", id(1)), ""),
            body.replace(
                &format!("data-hcd-flow-region=\"{}\"", id(1)),
                &format!("data-hcd-flow-region=\"{}\"", id(99)),
            ),
            body.replace("word/document.xml", "word/header1.xml"),
            body.replace(
                "</p>",
                &format!("<span data-hcd-flow-region=\"{}\"></span></p>", id(1)),
            ),
            body.replace(&format!("data-hcd-id=\"{}\"", id(3)), ""),
        ] {
            assert!(
                FlowGraphValidator::new(&layout)
                    .unwrap()
                    .scan(&bad, &map, &descriptor, "test")
                    .is_err(),
                "accepted {bad}"
            );
        }
        assert!(reject_unscoped_metadata(&body).is_err());
        assert!(
            reject_unscoped_metadata("<p>data-hcd-flow-region is a documented attribute</p>")
                .is_ok()
        );
    }
    #[test]
    fn duplicate_roots_and_region_reentry_are_detected_across_chunks() {
        let layout = layout();
        let scopes = flow_regions(&layout);
        let (body, map, descriptor) = chunk(&scopes[0], 3, 4);
        let (header, hm, hd) = chunk(&scopes[1], 3, 5);
        let mut state = FlowGraphValidator::new(&layout).unwrap();
        state.scan(&body, &map, &descriptor, "test").unwrap();
        state.scan(&header, &hm, &hd, "test").unwrap();
        assert!(state.finish(&layout).is_err());
        let (header, hm, hd) = chunk(&scopes[1], 5, 6);
        let (later, lm, ld) = chunk(&scopes[0], 7, 8);
        let mut state = FlowGraphValidator::new(&layout).unwrap();
        state.scan(&body, &map, &descriptor, "test").unwrap();
        state.scan(&header, &hm, &hd, "test").unwrap();
        assert!(state.scan(&later, &lm, &ld, "test").is_err());
    }
    #[test]
    fn section_end_must_resolve_to_its_actual_last_root() {
        let mut layout = layout();
        let mut final_section = layout.sections[0].clone();
        final_section.id = id(9);
        layout.sections[0].source.paragraph_ordinal = Some(1);
        layout.sections[0].canonical_end_block_id = Some(id(99));
        layout.sections.push(final_section);
        layout.validate().unwrap();
        let scopes = flow_regions(&layout);
        let mut state = FlowGraphValidator::new(&layout).unwrap();
        for (index, scope) in scopes.iter().enumerate() {
            let (html, map, descriptor) = chunk(scope, 10 + index as u8 * 2, 11 + index as u8 * 2);
            state.scan(&html, &map, &descriptor, "test").unwrap();
        }
        assert!(state.finish(&layout).is_err());
    }
    #[test]
    fn projection_materializes_a_root_without_reusing_or_changing_its_text_source() {
        let scope = flow_regions(&layout())[0].clone();
        let (_, map, _) = chunk(&scope, 3, 4);
        let hash = hash_bytes(b"Text");
        let mut block=Block{id:id(4),scope:Some(scope),source_part:Some("word/document.xml".into()),region:"body".into(),read_only:false,content:EditorBlockContent::default(),html:format!("<p title='a&quot;b &amp; 中'><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{hash}\">Text</span></p>",id(4)),entries:map.entries.clone()};
        materialize_identity(&mut block, "test").unwrap();
        assert_ne!(block.id, id(4));
        assert_eq!(
            root_identity(&block.html).unwrap().as_deref(),
            Some(block.id.as_str())
        );
        assert_eq!(block.entries, map.entries);
        assert_eq!(
            extract_html_text_nodes(&block.html)
                .unwrap()
                .get(&id(4))
                .map(String::as_str),
            Some("Text")
        );
        assert!(!block.html.contains("a&amp;quot;"));
        let mut reader = Reader::from_str(&block.html);
        if let Event::Start(start) = reader.read_event().unwrap() {
            assert_eq!(
                attribute(&start, &reader, "title").unwrap().as_deref(),
                Some("a\"b & 中")
            );
        } else {
            panic!("missing root")
        }
    }
}
