//! Versioned Word section/story metadata. The canonical asset graph includes
//! this object in body roots, history, restore and source-free archives.
use crate::{hash_bytes, Bundle, HcdError, HcdManifest};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Read;

pub const FLOW_LAYOUT_SCHEMA: &str = "hcd-flow-layout/1";
pub const FLOW_REGION_LAYOUT_SCHEMA: &str = "hcd-flow-layout/2";
pub const FLOW_REGION_LAYOUT_SOURCE_PART: &str = "word/_hcd/flow-layout-v2.json";
pub const FLOW_WORD_FIELD_SCHEMA: &str = "hcd-word-field/1";
pub const FLOW_LAYOUT_SOURCE_PART: &str = "word/_hcd/flow-layout-v1.json";
pub const MAX_FLOW_LAYOUT_BYTES: u64 = 4 * 1024 * 1024;
pub const WORD_MAIN_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub const WORD_STRICT_NS: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";

/// Opaque field codes are retained, never executed. Cached results use separate
/// canonical source nodes and stay read-only until a field-aware editor exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWordFieldDefinition {
    pub schema_version: String,
    pub field_id: String,
    pub source_part: String,
    pub instruction: String,
    pub simple: bool,
}
fn field_id(id: &str) -> bool {
    id.len() == 34
        && id.starts_with("n_")
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl FlowWordFieldDefinition {
    pub fn validate(&self) -> Result<(), HcdError> {
        if self.schema_version != FLOW_WORD_FIELD_SCHEMA
            || !field_id(&self.field_id)
            || !(self.source_part == "word/document.xml" || valid_story_part(&self.source_part))
            || self.instruction.len() > 16384
            || self
                .instruction
                .chars()
                .any(|c| c.is_control() && !['\r', '\n', '\t'].contains(&c))
        {
            return Err(HcdError::InvalidBundle(
                "invalid opaque Word field definition".into(),
            ));
        }
        Ok(())
    }
}

/// Validate a whole revision across chunk boundaries without retaining field
/// instruction bodies. IDs, source parts and nested cache paths must agree.
#[derive(Default)]
pub(crate) struct FlowFieldValidator {
    starts: BTreeMap<String, usize>,
    definitions: BTreeMap<String, String>,
    required: BTreeMap<String, String>,
}
impl FlowFieldValidator {
    pub(crate) fn scan(
        &mut self,
        html: &str,
        map: &crate::ChunkSourceMap,
        enabled: bool,
    ) -> Result<(), HcdError> {
        if !html.contains("data-hcd-word-field-") {
            return Ok(());
        }
        if !enabled {
            return Err(HcdError::InvalidBundle(
                "Word field metadata requires flow layout model 1".into(),
            ));
        }
        let sources: BTreeMap<_, _> = map
            .entries
            .iter()
            .map(|entry| (entry.node_id.as_str(), entry))
            .collect();
        let mut reader = quick_xml::Reader::from_str(html);
        let mut buffer = Vec::new();
        let mut marker_open = false;
        loop {
            let event = reader
                .read_event_into(&mut buffer)
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
            if marker_open {
                if !matches!(&event,quick_xml::events::Event::End(end) if end.name().as_ref()==b"span")
                {
                    return Err(HcdError::InvalidBundle(
                        "Word field markers must be empty".into(),
                    ));
                }
                marker_open = false;
                buffer.clear();
                continue;
            }
            let opening = matches!(&event, quick_xml::events::Event::Start(_));
            match event {
                quick_xml::events::Event::Start(element)
                | quick_xml::events::Event::Empty(element) => {
                    let mut attrs = BTreeMap::new();
                    for attribute in element.attributes() {
                        let attribute =
                            attribute.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                        attrs.insert(
                            String::from_utf8_lossy(attribute.key.as_ref()).into_owned(),
                            attribute
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                                .into_owned(),
                        );
                    }
                    let keys = attrs
                        .keys()
                        .filter(|key| key.starts_with("data-hcd-word-field-"))
                        .collect::<Vec<_>>();
                    if keys.is_empty() {
                        buffer.clear();
                        continue;
                    }
                    if element.name().as_ref() != b"span"
                        || keys.iter().any(|key| {
                            !matches!(
                                key.as_str(),
                                "data-hcd-word-field-start"
                                    | "data-hcd-word-field-end"
                                    | "data-hcd-word-field-definition"
                                    | "data-hcd-word-field-path"
                            )
                        })
                    {
                        return Err(HcdError::InvalidBundle("invalid Word field marker".into()));
                    }
                    if let Some(id) = attrs.get("data-hcd-word-field-start") {
                        if !field_id(id)
                            || keys.len() != 1
                            || attrs.contains_key("data-hcd-node-hash")
                            || attrs.contains_key("data-hcd-id")
                        {
                            return Err(HcdError::InvalidBundle("invalid Word field start".into()));
                        }
                        *self.starts.entry(id.clone()).or_default() += 1;
                        marker_open = opening;
                    }
                    if let Some(raw) = attrs.get("data-hcd-word-field-definition") {
                        if raw.len() > 65536
                            || keys.len() != 2
                            || attrs.contains_key("data-hcd-node-hash")
                            || attrs.contains_key("data-hcd-id")
                        {
                            return Err(HcdError::InvalidBundle(
                                "invalid Word field definition marker".into(),
                            ));
                        }
                        let value: FlowWordFieldDefinition = serde_json::from_str(raw)?;
                        marker_open = opening;
                        value.validate()?;
                        if attrs.get("data-hcd-word-field-end") != Some(&value.field_id)
                            || self
                                .definitions
                                .insert(value.field_id, value.source_part)
                                .is_some()
                        {
                            return Err(HcdError::InvalidBundle(
                                "duplicate/unmatched Word field definition".into(),
                            ));
                        }
                    } else if attrs.contains_key("data-hcd-word-field-end") {
                        return Err(HcdError::InvalidBundle(
                            "Word field end lacks definition".into(),
                        ));
                    }
                    if let Some(raw) = attrs.get("data-hcd-word-field-path") {
                        if raw.len() > 2048 || keys.len() != 1 {
                            return Err(HcdError::InvalidBundle(
                                "invalid Word field cache path".into(),
                            ));
                        }
                        let path: Vec<String> = serde_json::from_str(raw)?;
                        let unique: HashSet<_> = path.iter().collect();
                        if path.is_empty()
                            || path.len() > 32
                            || unique.len() != path.len()
                            || path.iter().any(|id| !field_id(id))
                        {
                            return Err(HcdError::InvalidBundle(
                                "invalid Word field cache path".into(),
                            ));
                        }
                        let source = attrs
                            .get("data-hcd-id")
                            .and_then(|id| sources.get(id.as_str()))
                            .ok_or_else(|| {
                                HcdError::InvalidBundle("Word field cache has no source".into())
                            })?;
                        if source.source.editable || !attrs.contains_key("data-hcd-node-hash") {
                            return Err(HcdError::InvalidBundle(
                                "Word field caches must be read-only source text".into(),
                            ));
                        }
                        for id in path {
                            if self
                                .required
                                .insert(id, source.source.part.clone())
                                .is_some_and(|part| part != source.source.part)
                            {
                                return Err(HcdError::InvalidBundle(
                                    "Word field spans different source parts".into(),
                                ));
                            }
                        }
                    }
                    if self.starts.len() > 100000
                        || self.definitions.len() > 100000
                        || self.required.len() > 100000
                    {
                        return Err(HcdError::ResourceLimit("Word field inventory limit".into()));
                    }
                }
                quick_xml::events::Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
        Ok(())
    }
    pub(crate) fn finish(self) -> Result<(), HcdError> {
        if self.starts.len() != self.definitions.len()
            || self
                .starts
                .iter()
                .any(|(id, count)| *count != 1 || !self.definitions.contains_key(id))
            || self
                .required
                .iter()
                .any(|(id, part)| self.definitions.get(id) != Some(part))
        {
            return Err(HcdError::InvalidBundle(
                "unmatched Word field identities".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowStoryKind {
    Header,
    Footer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowStoryVariant {
    Default,
    First,
    Even,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStoryBindings {
    /// Absence means link to the same variant in the preceding section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub even: Option<String>,
}
impl FlowStoryBindings {
    pub fn get(&self, variant: FlowStoryVariant) -> Option<&str> {
        match variant {
            FlowStoryVariant::Default => &self.default,
            FlowStoryVariant::First => &self.first,
            FlowStoryVariant::Even => &self.even,
        }
        .as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStory {
    pub id: String,
    pub kind: FlowStoryKind,
    pub source_part: String,
}

/// Only values explicitly present in the source are recorded. Missing values
/// are not silently replaced with a guessed paper size or previous section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowPageSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_twips: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_twips: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub margins_twips: BTreeMap<String, i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowSectionSource {
    pub part: String,
    /// One-based Word paragraph ordinal. None identifies the body's final sectPr.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph_ordinal: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph_id: Option<String>,
    /// Self-contained source XML, including in-scope namespaces. Unknown section
    /// properties and historical property snapshots survive offline packaging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_properties_xml: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowSection {
    pub id: String,
    /// Canonical end of this body section; the final section ends at body EOF.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical_end_block_id: Option<String>,
    pub source: FlowSectionSource,
    pub different_first_page: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub break_type: Option<String>,
    pub page: FlowPageSettings,
    pub headers: FlowStoryBindings,
    pub footers: FlowStoryBindings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowDocumentLayout {
    pub schema_version: String,
    pub even_and_odd_headers: bool,
    pub sections: Vec<FlowSection>,
    pub stories: Vec<FlowStory>,
}

impl FlowDocumentLayout {
    pub fn validate(&self) -> Result<(), HcdError> {
        let invalid = || HcdError::InvalidBundle("invalid Word section/story layout".into());
        let valid_id = |id: &str| {
            id.len() == 34
                && id.starts_with("n_")
                && id[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if ![FLOW_LAYOUT_SCHEMA, FLOW_REGION_LAYOUT_SCHEMA].contains(&self.schema_version.as_str())
            || self.sections.is_empty()
            || self.sections.len() > 4096
            || self.stories.len() > 8192
            || serde_json::to_vec(self)?.len() as u64 > MAX_FLOW_LAYOUT_BYTES
        {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut parts = HashSet::new();
        let mut stories = BTreeMap::new();
        for story in &self.stories {
            if !valid_id(&story.id)
                || !ids.insert(story.id.as_str())
                || !parts.insert(story.source_part.as_str())
                || !valid_story_part(&story.source_part)
            {
                return Err(invalid());
            }
            stories.insert(story.id.as_str(), story.kind);
        }
        let mut previous = 0;
        for (index, section) in self.sections.iter().enumerate() {
            if (self.schema_version == FLOW_LAYOUT_SCHEMA
                && section.canonical_end_block_id.is_some())
                || (self.schema_version == FLOW_REGION_LAYOUT_SCHEMA
                    && match &section.canonical_end_block_id {
                        Some(id) => index + 1 == self.sections.len() || !valid_id(id),
                        None => index + 1 < self.sections.len(),
                    })
                || !valid_id(&section.id)
                || !ids.insert(section.id.as_str())
                || section.source.part != "word/document.xml"
                || section.source.paragraph_id.as_ref().is_some_and(|id| {
                    id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)
                })
                || section.source.paragraph_id.is_some()
                    && section.source.paragraph_ordinal.is_none()
            {
                return Err(invalid());
            }
            match section.source.paragraph_ordinal {
                Some(at) if at > previous && at <= 3_000_000 => previous = at,
                None if index + 1 == self.sections.len() => {}
                _ => return Err(invalid()),
            }
            if index + 1 == self.sections.len() && section.source.paragraph_ordinal.is_some() {
                return Err(invalid());
            }
            if let Some(xml) = &section.source.original_properties_xml {
                if xml.len() > 1024 * 1024 || xml.contains("<!DOCTYPE") {
                    return Err(invalid());
                }
                let document = roxmltree::Document::parse(xml).map_err(|_| invalid())?;
                let root = document.root_element();
                if root.tag_name().name() != "sectPr"
                    || !matches!(
                        root.tag_name().namespace(),
                        Some(WORD_MAIN_NS | WORD_STRICT_NS)
                    )
                {
                    return Err(invalid());
                }
            }
            if section.break_type.as_ref().is_some_and(|value| {
                ![
                    "nextPage",
                    "continuous",
                    "evenPage",
                    "oddPage",
                    "nextColumn",
                ]
                .contains(&value.as_str())
            }) || section
                .page
                .width_twips
                .is_some_and(|n| !(1..=200_000).contains(&n))
                || section
                    .page
                    .height_twips
                    .is_some_and(|n| !(1..=200_000).contains(&n))
                || section
                    .page
                    .orientation
                    .as_ref()
                    .is_some_and(|v| !["portrait", "landscape"].contains(&v.as_str()))
                || section.page.margins_twips.iter().any(|(key, value)| {
                    ![
                        "top", "right", "bottom", "left", "header", "footer", "gutter",
                    ]
                    .contains(&key.as_str())
                        || !(-200_000..=200_000).contains(value)
                        || !["top", "bottom"].contains(&key.as_str()) && *value < 0
                })
                || section.page.number_start.is_some_and(|n| n > 2_147_483_647)
                || section.page.number_format.as_ref().is_some_and(|v| {
                    v.is_empty()
                        || v.len() > 64
                        || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                })
            {
                return Err(invalid());
            }
            for (bindings, kind) in [
                (&section.headers, FlowStoryKind::Header),
                (&section.footers, FlowStoryKind::Footer),
            ] {
                for variant in [
                    FlowStoryVariant::Default,
                    FlowStoryVariant::First,
                    FlowStoryVariant::Even,
                ] {
                    if let Some(id) = bindings.get(variant) {
                        if stories.get(id) != Some(&kind) {
                            return Err(invalid());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Resolve source inheritance without copying shared story content. An
    /// absent first/even story stays blank, rather than borrowing the default.
    pub fn story_for_page(
        &self,
        section: usize,
        kind: FlowStoryKind,
        first: bool,
        even: bool,
    ) -> Option<&FlowStory> {
        let current = self.sections.get(section)?;
        let variant = if first && current.different_first_page {
            FlowStoryVariant::First
        } else if even && self.even_and_odd_headers {
            FlowStoryVariant::Even
        } else {
            FlowStoryVariant::Default
        };
        let id = self.sections[..=section]
            .iter()
            .rev()
            .find_map(|section| match kind {
                FlowStoryKind::Header => section.headers.get(variant),
                FlowStoryKind::Footer => section.footers.get(variant),
            })?;
        self.stories
            .iter()
            .find(|story| story.id == id && story.kind == kind)
    }
}

fn valid_story_part(part: &str) -> bool {
    part.starts_with("word/")
        && part.ends_with(".xml")
        && part != "word/document.xml"
        && part.len() <= 1024
        && !part.contains(['\\', '\0', '?', '#', ':'])
        && !part.chars().any(char::is_control)
        && !part
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
}

pub fn read_flow_document_layout(
    bundle: &Bundle,
    manifest: &HcdManifest,
) -> Result<Option<FlowDocumentLayout>, HcdError> {
    if manifest
        .capabilities
        .flow_layout
        .is_some_and(|version| ![1, 2].contains(&version))
    {
        return Err(HcdError::Unsupported(
            "unknown Word section/story model".into(),
        ));
    }
    let records = bundle.read_asset_index_for_revision(manifest.revision)?;
    if records.iter().any(|a| {
        a.source_part.starts_with("word/_hcd/flow-layout-v")
            && ![FLOW_LAYOUT_SOURCE_PART, FLOW_REGION_LAYOUT_SOURCE_PART]
                .contains(&a.source_part.as_str())
    }) {
        return Err(HcdError::Unsupported(
            "unknown required Word layout asset".into(),
        ));
    }
    let mut found = records.iter().filter(|asset| {
        [FLOW_LAYOUT_SOURCE_PART, FLOW_REGION_LAYOUT_SOURCE_PART]
            .contains(&asset.source_part.as_str())
    });
    let Some(asset) = found.next() else {
        return if manifest.capabilities.flow_layout.is_some() {
            Err(HcdError::InvalidBundle(
                "required Word layout asset is missing".into(),
            ))
        } else {
            Ok(None)
        };
    };
    if !matches!(manifest.capabilities.flow_layout, Some(1 | 2))
        || asset.source_part
            != if manifest.capabilities.flow_layout == Some(2) {
                FLOW_REGION_LAYOUT_SOURCE_PART
            } else {
                FLOW_LAYOUT_SOURCE_PART
            }
        || found.next().is_some()
        || manifest.schema_version != crate::HCD_SCHEMA_VERSION
        || manifest.profile != "semantic-flow"
        || manifest.source.format != "docx"
        || asset.byte_length > MAX_FLOW_LAYOUT_BYTES
        || asset.hash.len() != 64
        || !asset
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || asset.href != format!("assets/sha256/{}.json", asset.hash)
    {
        return Err(HcdError::InvalidBundle(
            "invalid Word layout asset declaration".into(),
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(bundle.resolve_href(&asset.href)?)?
        .take(MAX_FLOW_LAYOUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != asset.byte_length
        || bytes.len() as u64 > MAX_FLOW_LAYOUT_BYTES
        || hash_bytes(&bytes) != asset.hash
    {
        return Err(HcdError::InvalidBundle(
            "Word layout asset hash or size mismatch".into(),
        ));
    }
    let layout: FlowDocumentLayout = serde_json::from_slice(&bytes)?;
    layout.validate()?;
    if layout.schema_version
        != if manifest.capabilities.flow_layout == Some(2) {
            FLOW_REGION_LAYOUT_SCHEMA
        } else {
            FLOW_LAYOUT_SCHEMA
        }
    {
        return Err(HcdError::InvalidBundle(
            "Word layout model declaration mismatch".into(),
        ));
    }
    Ok(Some(layout))
}

/// Historical manifests are reconstructed from their own immutable asset
/// graph, rather than inheriting today's layout model after an upgrade/restore.
pub(crate) fn restore_historical_flow_model(
    bundle: &Bundle,
    manifest: &mut HcdManifest,
) -> Result<(), HcdError> {
    let records = bundle.read_asset_index_for_revision(manifest.revision)?;
    let mut models = records
        .iter()
        .filter(|a| a.source_part.starts_with("word/_hcd/flow-layout-v"))
        .map(|a| match a.source_part.as_str() {
            FLOW_LAYOUT_SOURCE_PART => Ok(1),
            FLOW_REGION_LAYOUT_SOURCE_PART => Ok(2),
            _ => Err(HcdError::Unsupported(
                "unknown historical Word layout model".into(),
            )),
        });
    let model = models.next().transpose()?;
    if models.next().is_some() {
        return Err(HcdError::InvalidBundle(
            "multiple historical Word layout models".into(),
        ));
    }
    manifest.capabilities.flow_layout = model;
    if model.is_some() {
        manifest.capabilities.structure_patch = model == Some(2);
        read_flow_document_layout(bundle, manifest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(n: u8) -> String {
        format!("n_{n:032x}")
    }
    fn layout() -> FlowDocumentLayout {
        FlowDocumentLayout {
            schema_version: FLOW_LAYOUT_SCHEMA.into(),
            even_and_odd_headers: true,
            stories: vec![FlowStory {
                id: id(1),
                kind: FlowStoryKind::Header,
                source_part: "word/header1.xml".into(),
            }],
            sections: vec![FlowSection {
                id: id(2),
                canonical_end_block_id: None,
                source: FlowSectionSource {
                    part: "word/document.xml".into(),
                    paragraph_ordinal: None,
                    paragraph_id: None,
                    original_properties_xml: None,
                },
                different_first_page: true,
                break_type: None,
                page: FlowPageSettings::default(),
                headers: FlowStoryBindings {
                    default: Some(id(1)),
                    ..Default::default()
                },
                footers: FlowStoryBindings::default(),
            }],
        }
    }
    #[test]
    fn required_layout_marker_is_absent_on_legacy_documents_and_rejected_by_legacy_decoders() {
        // The pre-layout capability DTO used the same deny-unknown contract.
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct LegacyCapabilities {
            #[serde(rename = "textPatch")]
            _text_patch: bool,
            #[serde(rename = "annotations")]
            _known_annotations: bool,
            #[serde(rename = "structurePatch")]
            _structure_patch: bool,
            #[serde(rename = "stylePatch")]
            _style_patch: bool,
            #[serde(rename = "exactPagination")]
            _exact_pagination: bool,
            #[serde(default, rename = "customMarks")]
            _custom_marks: Option<u32>,
            #[serde(default, rename = "inlineReferences")]
            _inline_references: Option<u32>,
            #[serde(default, rename = "extensionNodes")]
            _extension_nodes: Option<u32>,
        }
        let mut capabilities = crate::HcdCapabilities::default();
        let old = serde_json::to_value(&capabilities).unwrap();
        assert!(old.get("flowLayout").is_none());
        assert!(serde_json::from_value::<LegacyCapabilities>(old).is_ok());
        capabilities.flow_layout = Some(1);
        let new = serde_json::to_value(&capabilities).unwrap();
        assert_eq!(new["flowLayout"], 1);
        assert!(serde_json::from_value::<LegacyCapabilities>(new.clone()).is_err());
        assert_eq!(
            serde_json::from_value::<crate::HcdCapabilities>(new)
                .unwrap()
                .flow_layout,
            Some(1)
        );
    }
    #[test]
    fn word_field_inventory_checks_model_sources_and_chunk_spanning_definitions() {
        let definition = FlowWordFieldDefinition {
            schema_version: FLOW_WORD_FIELD_SCHEMA.into(),
            field_id: id(8),
            source_part: "word/header1.xml".into(),
            instruction: " PAGE ".into(),
            simple: false,
        };
        let map = crate::ChunkSourceMap {
            schema_version: crate::HCD_SCHEMA_VERSION.into(),
            chunk_id: "fields".into(),
            entries: vec![crate::NodeMapEntry {
                node_id: id(9),
                node_hash: crate::hash_bytes(b"4"),
                source: crate::SourceAnchor {
                    part: "word/header1.xml".into(),
                    text_ordinal: 1,
                    paragraph_id: None,
                    text_id: None,
                    node_kind: "text".into(),
                    editable: false,
                },
            }],
        };
        let start = format!(
            "<p><span data-hcd-word-field-start=\"{}\"></span></p>",
            id(8)
        );
        let cache=format!("<p><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\" data-hcd-word-field-path='[\"{}\"]'>4</span></p>",id(9),crate::hash_bytes(b"4"),id(8));
        let end=format!("<p><span data-hcd-word-field-end=\"{}\" data-hcd-word-field-definition='{}'></span></p>",id(8),serde_json::to_string(&definition).unwrap());
        let mut validator = FlowFieldValidator::default();
        for html in [&start, &cache, &end] {
            validator.scan(html, &map, true).unwrap();
        }
        validator.finish().unwrap();
        assert!(FlowFieldValidator::default()
            .scan(&start, &map, false)
            .is_err());
        let mut missing = FlowFieldValidator::default();
        missing.scan(&start, &map, true).unwrap();
        missing.scan(&cache, &map, true).unwrap();
        assert!(missing.finish().is_err());
        let mut editable = map.clone();
        editable.entries[0].source.editable = true;
        assert!(FlowFieldValidator::default()
            .scan(&cache, &editable, true)
            .is_err());
        let mut wrong = map.clone();
        wrong.entries[0].source.part = "word/footer1.xml".into();
        let mut validator = FlowFieldValidator::default();
        for html in [&start, &cache, &end] {
            validator.scan(html, &wrong, true).unwrap();
        }
        assert!(validator.finish().is_err());
        let mut duplicate = FlowFieldValidator::default();
        for html in [&start, &start, &end] {
            duplicate.scan(html, &map, true).unwrap();
        }
        assert!(duplicate.finish().is_err());
        assert!(FlowFieldValidator::default()
            .scan(&start.replace("></span>", ">unexpected</span>"), &map, true)
            .is_err());
        assert!(FlowFieldValidator::default()
            .scan(
                &end.replace(FLOW_WORD_FIELD_SCHEMA, "hcd-word-field/99"),
                &map,
                true
            )
            .is_err());
        assert!(FlowFieldValidator::default()
            .scan(&cache.replace(&id(9), &id(7)), &map, true)
            .is_err());
    }
    #[test]
    fn first_and_even_variants_remain_blank_without_their_own_or_inherited_reference() {
        let mut value = layout();
        value.validate().unwrap();
        assert!(value
            .story_for_page(0, FlowStoryKind::Header, true, false)
            .is_none());
        assert!(value
            .story_for_page(0, FlowStoryKind::Header, false, true)
            .is_none());
        assert_eq!(
            value
                .story_for_page(0, FlowStoryKind::Header, false, false)
                .unwrap()
                .id,
            id(1)
        );
        value.sections[0].different_first_page = false;
        value.even_and_odd_headers = false;
        assert_eq!(
            value
                .story_for_page(0, FlowStoryKind::Header, true, true)
                .unwrap()
                .id,
            id(1)
        );
        assert!(value
            .story_for_page(1, FlowStoryKind::Header, false, false)
            .is_none());
    }
    #[test]
    fn invalid_identity_role_path_geometry_anchors_and_xml_are_rejected() {
        let base = layout();
        type Mutation = Box<dyn Fn(&mut FlowDocumentLayout)>;
        let mutations: Vec<Mutation> = vec![
            Box::new(|v| v.schema_version = "future/9".into()),
            Box::new(|v| v.stories[0].id = "bad".into()),
            Box::new(|v| v.sections[0].id = id(1)),
            Box::new(|v| v.stories[0].source_part = "word/../private.xml".into()),
            Box::new(|v| v.stories[0].source_part = "word/document.xml".into()),
            Box::new(|v| v.sections[0].footers.default = Some(id(1))),
            Box::new(|v| v.sections[0].page.width_twips = Some(0)),
            Box::new(|v| {
                v.sections[0].page.margins_twips.insert("header".into(), -1);
            }),
            Box::new(|v| v.sections[0].source.paragraph_ordinal = Some(1)),
            Box::new(|v| v.sections[0].source.original_properties_xml = Some("<sectPr/>".into())),
            Box::new(|v| {
                v.sections[0].source.original_properties_xml = Some(format!(
                    "<!DOCTYPE x [<!ENTITY a 'x'>]><w:sectPr xmlns:w='{WORD_MAIN_NS}'/>"
                ))
            }),
        ];
        for change in mutations {
            let mut value = base.clone();
            change(&mut value);
            assert!(value.validate().is_err(), "accepted {value:?}")
        }
        let mut unknown = serde_json::to_value(&base).unwrap();
        unknown["unrecognized"] = true.into();
        assert!(serde_json::from_value::<FlowDocumentLayout>(unknown).is_err());
        let mut unknown = serde_json::to_value(base).unwrap();
        unknown["sections"][0]["page"]["unknown"] = 1.into();
        assert!(serde_json::from_value::<FlowDocumentLayout>(unknown).is_err());
    }
}
