//! Versioned Office presentation settings, kept with the annotation revision.
//! Body edits, history restore and publication share this exact immutable state.
use crate::{
    bundle::read_json_bounded, AnnotationSet, ApplyResult, Bundle, HcdError, HcdManifest,
    MAX_CONTROL_PART_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL: &str = "office-features/1";
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeFeatures {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub word_pages: BTreeMap<u32, WordPageLayout>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub toc_changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toc: Option<WordToc>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub footnotes: BTreeMap<String, WordFootnote>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sheet_print: BTreeMap<String, SheetPrintLayout>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slide_transitions: BTreeMap<String, SlideTransition>,
}
impl OfficeFeatures {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordPageLayout {
    pub width_twips: u32,
    pub height_twips: u32,
    pub top_twips: u32,
    pub right_twips: u32,
    pub bottom_twips: u32,
    pub left_twips: u32,
    pub header_twips: u32,
    pub footer_twips: u32,
    pub gutter_twips: u32,
}
impl Default for WordPageLayout {
    fn default() -> Self {
        Self {
            width_twips: 12240,
            height_twips: 15840,
            top_twips: 1440,
            right_twips: 1440,
            bottom_twips: 1440,
            left_twips: 1440,
            header_twips: 720,
            footer_twips: 720,
            gutter_twips: 0,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordToc {
    pub title: String,
    pub first_level: u8,
    pub last_level: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordAnchor {
    pub block_id: String,
    pub offset: usize,
    pub paragraph_hash: String,
    #[serde(default)]
    pub before: String,
    #[serde(default)]
    pub after: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordFootnote {
    pub text: Option<String>,
    pub anchor: Option<WordAnchor>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetPrintLayout {
    pub paper_size: u16,
    pub landscape: bool,
    pub scale: Option<u16>,
    pub fit_width: u16,
    pub fit_height: u16,
    pub left_inches: f64,
    pub right_inches: f64,
    pub top_inches: f64,
    pub bottom_inches: f64,
    pub header_inches: f64,
    pub footer_inches: f64,
    pub print_area: Option<String>,
    pub repeat_rows: Option<(u32, u32)>,
    pub repeat_columns: Option<(u16, u16)>,
    pub gridlines: bool,
    pub headings: bool,
    pub center_horizontal: bool,
    pub center_vertical: bool,
}
impl Default for SheetPrintLayout {
    fn default() -> Self {
        Self {
            paper_size: 9,
            landscape: false,
            scale: None,
            fit_width: 1,
            fit_height: 0,
            left_inches: 0.7,
            right_inches: 0.7,
            top_inches: 0.75,
            bottom_inches: 0.75,
            header_inches: 0.3,
            footer_inches: 0.3,
            print_area: None,
            repeat_rows: None,
            repeat_columns: None,
            gridlines: false,
            headings: false,
            center_horizontal: false,
            center_vertical: false,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    #[default]
    None,
    Fade,
    Push,
    Wipe,
    Cut,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionDirection {
    #[default]
    Left,
    Right,
    Up,
    Down,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlideTransition {
    pub kind: TransitionKind,
    pub direction: TransitionDirection,
    pub duration_ms: u32,
    pub advance_on_click: bool,
    pub advance_after_ms: Option<u32>,
}
impl Default for SlideTransition {
    fn default() -> Self {
        Self {
            kind: TransitionKind::None,
            direction: TransitionDirection::Left,
            duration_ms: 500,
            advance_on_click: true,
            advance_after_ms: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum OfficeAction {
    #[serde(rename = "word.pageLayout.set")]
    WordPage {
        sections: Vec<u32>,
        layout: WordPageLayout,
    },
    #[serde(rename = "word.toc.set")]
    WordToc { settings: Option<WordToc> },
    #[serde(rename = "word.footnote.set")]
    WordFootnote { id: String, note: WordFootnote },
    #[serde(rename = "xlsx.printLayout.set")]
    SheetPrint {
        sheet_id: String,
        layout: SheetPrintLayout,
    },
    #[serde(rename = "pptx.transition.set")]
    SlideTransition {
        chunk_ids: Vec<String>,
        transition: SlideTransition,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeEdit {
    pub protocol_version: String,
    pub base_revision: u64,
    pub patch_id: String,
    pub action: OfficeAction,
}
fn invalid(message: &str) -> HcdError {
    HcdError::InvalidPatch(message.into())
}
fn text(value: &str, max: usize) -> bool {
    value.len() <= max
        && value.chars().all(|c| {
            c == '\n' || c == '\t' || c == '\r' || c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}'
        })
}
pub fn cell(value: &str) -> Option<(u32, u32)> {
    let value = value.replace('$', "").to_ascii_uppercase();
    let at = value.bytes().position(|c| c.is_ascii_digit())?;
    if at == 0 || at > 3 || !value[..at].bytes().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let column = value[..at]
        .bytes()
        .fold(0u32, |n, c| n * 26 + u32::from(c - b'A' + 1));
    let row = value[at..].parse::<u32>().ok()?;
    (column <= 16384 && (1..=1_048_576).contains(&row)).then_some((row, column))
}
pub fn range(value: &str) -> Option<((u32, u32), (u32, u32))> {
    let parts: Vec<_> = value.split(':').collect();
    if parts.is_empty() || parts.len() > 2 {
        return None;
    }
    let first = cell(parts[0])?;
    let last = cell(parts.get(1).unwrap_or(&parts[0]))?;
    (first.0 <= last.0 && first.1 <= last.1).then_some((first, last))
}
pub fn validate(action: &OfficeAction, format: &str) -> Result<(), HcdError> {
    match action {
        OfficeAction::WordPage {
            sections,
            layout: p,
        } => {
            if format != "docx"
                || sections.is_empty()
                || sections.len() > 1024
                || sections.iter().any(|v| *v == 0 || *v > 1024)
                || !(1440..=31680).contains(&p.width_twips)
                || !(1440..=31680).contains(&p.height_twips)
                || [
                    p.top_twips,
                    p.right_twips,
                    p.bottom_twips,
                    p.left_twips,
                    p.header_twips,
                    p.footer_twips,
                    p.gutter_twips,
                ]
                .iter()
                .any(|v| *v > 16000)
                || u64::from(p.left_twips)
                    + u64::from(p.right_twips)
                    + u64::from(p.gutter_twips)
                    + 720
                    > u64::from(p.width_twips)
                || u64::from(p.top_twips) + u64::from(p.bottom_twips) + 720
                    > u64::from(p.height_twips)
            {
                return Err(invalid("Invalid Word section geometry or margins"));
            }
        }
        OfficeAction::WordToc { settings } => {
            if format != "docx"
                || settings.as_ref().is_some_and(|t| {
                    !text(&t.title, 512)
                        || t.first_level == 0
                        || t.first_level > t.last_level
                        || t.last_level > 9
                })
            {
                return Err(invalid("Invalid Word table of contents"));
            }
        }
        OfficeAction::WordFootnote { id, note } => {
            if format != "docx"
                || id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b":-_".contains(&c))
                || note
                    .text
                    .as_ref()
                    .is_some_and(|v| v.trim().is_empty() || !text(v, 16384))
                || note.anchor.as_ref().is_some_and(|a| {
                    a.block_id.len() > 256
                        || a.offset > 1_000_000
                        || a.paragraph_hash.len() != 64
                        || a.before.chars().count() > 32
                        || a.after.chars().count() > 32
                })
            {
                return Err(invalid("Invalid Word footnote or anchor"));
            }
        }
        OfficeAction::SheetPrint {
            sheet_id,
            layout: p,
        } => {
            let margins = [
                p.left_inches,
                p.right_inches,
                p.top_inches,
                p.bottom_inches,
                p.header_inches,
                p.footer_inches,
            ];
            if format != "xlsx"
                || sheet_id.is_empty()
                || sheet_id.len() > 256
                || ![1, 5, 8, 9, 11].contains(&p.paper_size)
                || p.scale.is_some_and(|s| !(10..=400).contains(&s))
                || p.fit_width > 100
                || p.fit_height > 100
                || margins
                    .iter()
                    .any(|v| !v.is_finite() || *v < 0. || *v > 10.)
                || p.print_area.as_ref().is_some_and(|v| range(v).is_none())
                || p.repeat_rows
                    .is_some_and(|(a, b)| a == 0 || a > b || b > 1_048_576)
                || p.repeat_columns
                    .is_some_and(|(a, b)| a == 0 || a > b || b > 16384)
            {
                return Err(invalid("Invalid worksheet print layout"));
            }
        }
        OfficeAction::SlideTransition {
            chunk_ids,
            transition: t,
        } => {
            if format != "pptx"
                || chunk_ids.is_empty()
                || chunk_ids.len() > 10000
                || chunk_ids.iter().any(|id| id.is_empty() || id.len() > 256)
                || !(50..=10000).contains(&t.duration_ms)
                || t.advance_after_ms
                    .is_some_and(|v| !(100..=3_600_000).contains(&v))
                || !t.advance_on_click && t.advance_after_ms.is_none()
            {
                return Err(invalid("Invalid slide transition"));
            }
        }
    }
    Ok(())
}
fn annotations(bundle: &Bundle, manifest: &HcdManifest) -> Result<AnnotationSet, HcdError> {
    if let Some(href) = &manifest.annotation_href {
        read_json_bounded(
            &bundle.resolve_href(href)?,
            MAX_CONTROL_PART_BYTES,
            "Office features",
        )
    } else {
        Ok(AnnotationSet {
            schema_version: manifest.schema_version.clone(),
            ..Default::default()
        })
    }
}
pub fn read(bundle: &Bundle, manifest: &HcdManifest) -> Result<OfficeFeatures, HcdError> {
    Ok(annotations(bundle, manifest)?.office_features)
}
pub fn edit(
    bundle: &Bundle,
    request: &OfficeEdit,
    preflight: impl FnOnce(&HcdManifest, &OfficeFeatures) -> Result<(), HcdError>,
) -> Result<ApplyResult, HcdError> {
    if request.protocol_version != PROTOCOL
        || request.patch_id.is_empty()
        || request.patch_id.len() > 128
    {
        return Err(invalid(
            "Unsupported Office feature protocol or patch identity",
        ));
    }
    let _lock = bundle.acquire_write_lock()?;
    let mut manifest = bundle.manifest()?;
    let hash = crate::hash_bytes(&serde_json::to_vec(request)?);
    if let Some(result) =
        crate::patch::find_idempotent_result(bundle, &manifest, &request.patch_id, &hash)?
    {
        return Ok(result);
    }
    if manifest.revision != request.base_revision {
        return Err(HcdError::RevisionConflict(format!(
            "Office edit expected r{}, found r{}",
            request.base_revision, manifest.revision
        )));
    }
    if manifest.revision >= crate::MAX_REVISION {
        return Err(HcdError::ResourceLimit("revision limit reached".into()));
    }
    validate(&request.action, &manifest.source.format)?;
    let mut set = annotations(bundle, &manifest)?;
    preflight(&manifest, &set.office_features)?;
    let state = &mut set.office_features;
    match &request.action {
        OfficeAction::WordPage { sections, layout } => {
            for section in sections {
                state.word_pages.insert(*section, layout.clone());
            }
        }
        OfficeAction::WordToc { settings } => {
            state.toc_changed = true;
            state.toc = settings.clone();
        }
        OfficeAction::WordFootnote { id, note } => {
            if !state.footnotes.contains_key(id) && state.footnotes.len() >= 2048 {
                return Err(HcdError::ResourceLimit("too many footnotes".into()));
            }
            let mut note = note.clone();
            if note.anchor.is_none() {
                note.anchor = state.footnotes.get(id).and_then(|n| n.anchor.clone());
            }
            state.footnotes.insert(id.clone(), note);
        }
        OfficeAction::SheetPrint { sheet_id, layout } => {
            state.sheet_print.insert(sheet_id.clone(), layout.clone());
        }
        OfficeAction::SlideTransition {
            chunk_ids,
            transition,
        } => {
            for id in chunk_ids {
                state
                    .slide_transitions
                    .insert(id.clone(), transition.clone());
            }
        }
    }
    let (href, hash) = bundle.write_json_object("annotations", &set)?;
    manifest.annotation_href = Some(href);
    manifest.annotation_root_hash = hash;
    let revision = manifest.revision + 1;
    let record = crate::structure::revision_record(
        bundle,
        &manifest,
        revision,
        &request.patch_id,
        Some(crate::hash_bytes(&serde_json::to_vec(request)?)),
        false,
    )?;
    manifest.revision = revision;
    bundle.write_revision(&record)?;
    bundle.write_manifest(&manifest)?;
    Ok(ApplyResult {
        document_id: manifest.document_id,
        patch_id: request.patch_id.clone(),
        base_revision: request.base_revision,
        revision,
        root_hash: manifest.root_hash,
        annotation_root_hash: manifest.annotation_root_hash,
        dirty_node_ids: vec![],
        dirty_chunk_ids: vec![],
        dirty_source_parts: vec![],
        warnings: vec![],
        idempotent_replay: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_and_numeric_limits_are_checked() {
        assert!(range("$A$1:XFD1048576").is_some());
        assert!(range("A0:B1").is_none());
        assert!(range("A1:XFE2").is_none());
        assert!(range("B2:A1").is_none());
        let layout = WordPageLayout {
            left_twips: 12000,
            ..Default::default()
        };
        assert!(validate(
            &OfficeAction::WordPage {
                sections: vec![1],
                layout
            },
            "docx"
        )
        .is_err());
        let layout = SheetPrintLayout {
            left_inches: f64::NAN,
            ..Default::default()
        };
        assert!(validate(
            &OfficeAction::SheetPrint {
                sheet_id: "one".into(),
                layout
            },
            "xlsx"
        )
        .is_err());
        assert!(validate(
            &OfficeAction::SlideTransition {
                chunk_ids: vec!["one".into()],
                transition: SlideTransition {
                    advance_on_click: false,
                    ..Default::default()
                }
            },
            "pptx"
        )
        .is_err());
    }
}
