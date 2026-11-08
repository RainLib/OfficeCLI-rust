//! Validated field-level planning for future coordinated Word layout edits.
//! This module does not publish a revision or alter a live collaboration room.
use crate::{flow_layout_hash, FlowDocumentLayout, HcdError, FLOW_REGION_LAYOUT_SCHEMA};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const FLOW_LAYOUT_EDITS_SCHEMA: &str = "hcd-word-layout-edits/1";
pub const MAX_FLOW_LAYOUT_EDITS_BYTES: usize = 256 * 1024;
pub const FLOW_LAYOUT_TRANSACTION_SCHEMA: &str = "hcd-word-layout-transaction/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowLayoutField {
    WidthTwips,
    HeightTwips,
    Orientation,
    MarginTop,
    MarginRight,
    MarginBottom,
    MarginLeft,
    MarginHeader,
    MarginFooter,
    MarginGutter,
    NumberStart,
    NumberFormat,
    DifferentFirstPage,
    EvenAndOddHeaders,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowLayoutFieldChange {
    /// Required for section fields; absent for the document-wide odd/even flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    pub field: FlowLayoutField,
    /// Null represents an absent optional value, never an implicit UI default.
    pub expected: Value,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowLayoutEdits {
    pub schema_version: String,
    pub base_layout_hash: String,
    pub changes: Vec<FlowLayoutFieldChange>,
}

/// A native transaction envelope. Authentication, room ownership and signed
/// coordinator receipts must be checked by the caller before using it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowLayoutTransaction {
    pub schema_version: String,
    pub document_id: String,
    pub transaction_id: String,
    pub base_revision: u64,
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub actor: BTreeMap<String, String>,
    pub edits: FlowLayoutEdits,
}

fn invalid(message: &str) -> HcdError {
    HcdError::InvalidPatch(format!("Word layout edit: {message}"))
}

fn margin(field: FlowLayoutField) -> Option<&'static str> {
    use FlowLayoutField::*;
    match field {
        MarginTop => Some("top"),
        MarginRight => Some("right"),
        MarginBottom => Some("bottom"),
        MarginLeft => Some("left"),
        MarginHeader => Some("header"),
        MarginFooter => Some("footer"),
        MarginGutter => Some("gutter"),
        _ => None,
    }
}

fn section<'a>(
    layout: &'a FlowDocumentLayout,
    id: &str,
) -> Result<&'a crate::FlowSection, HcdError> {
    layout
        .sections
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| invalid("unknown section"))
}

fn field_value(
    layout: &FlowDocumentLayout,
    change: &FlowLayoutFieldChange,
) -> Result<Value, HcdError> {
    use FlowLayoutField::*;
    if change.field == EvenAndOddHeaders {
        if change.section_id.is_some() {
            return Err(invalid("document field cannot name a section"));
        }
        return Ok(Value::Bool(layout.even_and_odd_headers));
    }
    let s = section(
        layout,
        change
            .section_id
            .as_deref()
            .ok_or_else(|| invalid("section field requires identity"))?,
    )?;
    let p = &s.page;
    if let Some(key) = margin(change.field) {
        return Ok(serde_json::to_value(p.margins_twips.get(key))?);
    }
    Ok(match change.field {
        WidthTwips => serde_json::to_value(p.width_twips)?,
        HeightTwips => serde_json::to_value(p.height_twips)?,
        Orientation => serde_json::to_value(&p.orientation)?,
        NumberStart => serde_json::to_value(p.number_start)?,
        NumberFormat => serde_json::to_value(&p.number_format)?,
        DifferentFirstPage => Value::Bool(s.different_first_page),
        _ => return Err(invalid("unsupported field")),
    })
}

fn assign(layout: &mut FlowDocumentLayout, change: &FlowLayoutFieldChange) -> Result<(), HcdError> {
    use FlowLayoutField::*;
    if change.field == EvenAndOddHeaders {
        layout.even_and_odd_headers = change
            .value
            .as_bool()
            .ok_or_else(|| invalid("expected boolean"))?;
        return Ok(());
    }
    let id = change
        .section_id
        .as_deref()
        .ok_or_else(|| invalid("section field requires identity"))?;
    let s = layout
        .sections
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| invalid("unknown section"))?;
    if let Some(key) = margin(change.field) {
        if change.value.is_null() {
            s.page.margins_twips.remove(key);
        } else {
            let value = change
                .value
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .ok_or_else(|| invalid("invalid margin"))?;
            s.page.margins_twips.insert(key.to_string(), value);
        }
        return Ok(());
    }
    let unsigned = || -> Result<Option<u32>, HcdError> {
        if change.value.is_null() {
            Ok(None)
        } else {
            change
                .value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .map(Some)
                .ok_or_else(|| invalid("invalid integer"))
        }
    };
    let string = || -> Result<Option<String>, HcdError> {
        if change.value.is_null() {
            Ok(None)
        } else {
            change
                .value
                .as_str()
                .map(|s| Some(s.to_string()))
                .ok_or_else(|| invalid("invalid string"))
        }
    };
    match change.field {
        WidthTwips => s.page.width_twips = unsigned()?,
        HeightTwips => s.page.height_twips = unsigned()?,
        Orientation => s.page.orientation = string()?,
        NumberStart => s.page.number_start = unsigned()?,
        NumberFormat => s.page.number_format = string()?,
        DifferentFirstPage => {
            s.different_first_page = change
                .value
                .as_bool()
                .ok_or_else(|| invalid("expected boolean"))?
        }
        _ => return Err(invalid("unsupported field")),
    }
    Ok(())
}

/// Plan atomically against an authenticated base and current layout. Stale
/// layouts may merge only unchanged target fields with identical topology.
/// The caller must still enforce revision CAS, identity, room ownership and
/// durable signed receipts before publishing this returned layout.
pub fn plan_flow_layout_edits(
    base: &FlowDocumentLayout,
    current: &FlowDocumentLayout,
    edits: &FlowLayoutEdits,
) -> Result<FlowDocumentLayout, HcdError> {
    base.validate()?;
    current.validate()?;
    if base.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || current.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || edits.schema_version != FLOW_LAYOUT_EDITS_SCHEMA
        || edits.base_layout_hash != flow_layout_hash(base)?
        || edits.changes.is_empty()
        || edits.changes.len() > 1024
    {
        return Err(invalid("invalid model, base or change count"));
    }
    if serde_json::to_vec(edits)?.len() > MAX_FLOW_LAYOUT_EDITS_BYTES {
        return Err(HcdError::ResourceLimit(
            "Word layout edit exceeds 256 KiB".into(),
        ));
    }
    // Canonical boundary IDs may change when body text is saved. Section
    // identity, source, story catalog and bindings must remain stable.
    if base.stories != current.stories
        || base.sections.len() != current.sections.len()
        || base.sections.iter().zip(&current.sections).any(|(a, b)| {
            a.id != b.id
                || a.source != b.source
                || a.break_type != b.break_type
                || a.headers != b.headers
                || a.footers != b.footers
        })
    {
        return Err(HcdError::PreconditionFailed(
            "Word section/story topology changed".into(),
        ));
    }
    let mut seen = HashSet::new();
    for change in &edits.changes {
        if change.expected == change.value {
            return Err(invalid("unchanged field"));
        }
        if !seen.insert((change.section_id.clone(), change.field)) {
            return Err(invalid("duplicate field"));
        }
        if field_value(base, change)? != change.expected {
            return Err(invalid("field precondition does not match base"));
        }
        if field_value(current, change)? != change.expected {
            return Err(HcdError::PreconditionFailed(
                "Word layout field changed".into(),
            ));
        }
    }
    let mut next = current.clone();
    for change in &edits.changes {
        assign(&mut next, change)?;
    }
    next.validate()
        .map_err(|_| invalid("invalid resulting layout"))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FlowPageSettings, FlowSection, FlowSectionSource, FlowStoryBindings};
    use serde_json::json;

    fn id(n: u8) -> String {
        format!("n_{n:032x}")
    }
    fn layout() -> FlowDocumentLayout {
        FlowDocumentLayout {
            schema_version: FLOW_REGION_LAYOUT_SCHEMA.into(),
            even_and_odd_headers: false,
            stories: vec![],
            sections: vec![FlowSection {
                id: id(1),
                canonical_end_block_id: None,
                source: FlowSectionSource {
                    part: "word/document.xml".into(),
                    paragraph_ordinal: None,
                    paragraph_id: None,
                    original_properties_xml: None,
                },
                different_first_page: false,
                break_type: None,
                page: FlowPageSettings {
                    width_twips: Some(12240),
                    height_twips: Some(15840),
                    ..Default::default()
                },
                headers: FlowStoryBindings::default(),
                footers: FlowStoryBindings::default(),
            }],
        }
    }
    fn change(field: FlowLayoutField, expected: Value, value: Value) -> FlowLayoutFieldChange {
        FlowLayoutFieldChange {
            section_id: Some(id(1)),
            field,
            expected,
            value,
        }
    }
    fn edits(base: &FlowDocumentLayout, changes: Vec<FlowLayoutFieldChange>) -> FlowLayoutEdits {
        FlowLayoutEdits {
            schema_version: FLOW_LAYOUT_EDITS_SCHEMA.into(),
            base_layout_hash: flow_layout_hash(base).unwrap(),
            changes,
        }
    }

    #[test]
    fn plans_multiple_fields_without_mutating_base_or_unrelated_settings() {
        let base = layout();
        let original = base.clone();
        let patch = edits(
            &base,
            vec![
                change(FlowLayoutField::WidthTwips, json!(12240), json!(11906)),
                change(FlowLayoutField::MarginTop, Value::Null, json!(1440)),
                change(FlowLayoutField::Orientation, Value::Null, json!("portrait")),
            ],
        );
        let next = plan_flow_layout_edits(&base, &base, &patch).unwrap();
        assert_eq!(base, original);
        assert_eq!(next.sections[0].page.width_twips, Some(11906));
        assert_eq!(next.sections[0].page.height_twips, Some(15840));
        assert_eq!(next.sections[0].page.margins_twips["top"], 1440);
        assert_eq!(
            next.sections[0].page.orientation.as_deref(),
            Some("portrait")
        );
    }

    #[test]
    fn disjoint_peer_changes_rebase_but_same_field_conflicts() {
        let base = layout();
        let mut current = base.clone();
        current.sections[0].page.height_twips = Some(16000);
        let patch = edits(
            &base,
            vec![change(
                FlowLayoutField::WidthTwips,
                json!(12240),
                json!(11906),
            )],
        );
        let merged = plan_flow_layout_edits(&base, &current, &patch).unwrap();
        assert_eq!(merged.sections[0].page.height_twips, Some(16000));
        assert_eq!(merged.sections[0].page.width_twips, Some(11906));
        current.sections[0].page.width_twips = Some(13000);
        assert!(matches!(
            plan_flow_layout_edits(&base, &current, &patch),
            Err(HcdError::PreconditionFailed(_))
        ));
        let before = current.clone();
        let mixed = edits(
            &base,
            vec![
                change(FlowLayoutField::MarginTop, Value::Null, json!(1000)),
                change(FlowLayoutField::WidthTwips, json!(12240), json!(11906)),
            ],
        );
        assert!(plan_flow_layout_edits(&base, &current, &mixed).is_err());
        assert_eq!(current, before);
    }

    #[test]
    fn missing_values_are_not_defaults_and_can_be_removed() {
        let base = layout();
        let wrong = edits(
            &base,
            vec![change(
                FlowLayoutField::MarginLeft,
                json!(1440),
                json!(2000),
            )],
        );
        assert!(plan_flow_layout_edits(&base, &base, &wrong).is_err());
        let patch = edits(
            &base,
            vec![change(
                FlowLayoutField::WidthTwips,
                json!(12240),
                Value::Null,
            )],
        );
        assert_eq!(
            plan_flow_layout_edits(&base, &base, &patch)
                .unwrap()
                .sections[0]
                .page
                .width_twips,
            None
        );
    }

    #[test]
    fn invalid_duplicates_values_and_forged_base_never_return_partial_layout() {
        let base = layout();
        let original = base.clone();
        for patch in [
            edits(
                &base,
                vec![change(FlowLayoutField::WidthTwips, json!(12240), json!(0))],
            ),
            edits(
                &base,
                vec![change(
                    FlowLayoutField::WidthTwips,
                    json!(12240),
                    json!(12240),
                )],
            ),
            edits(
                &base,
                vec![change(FlowLayoutField::MarginLeft, Value::Null, json!(-1))],
            ),
            edits(
                &base,
                vec![change(
                    FlowLayoutField::Orientation,
                    Value::Null,
                    json!("sideways"),
                )],
            ),
            edits(
                &base,
                vec![
                    change(FlowLayoutField::WidthTwips, json!(12240), json!(1)),
                    change(FlowLayoutField::WidthTwips, json!(12240), json!(2)),
                ],
            ),
            FlowLayoutEdits {
                base_layout_hash: "0".repeat(64),
                ..edits(
                    &base,
                    vec![change(FlowLayoutField::WidthTwips, json!(12240), json!(1))],
                )
            },
        ] {
            assert!(plan_flow_layout_edits(&base, &base, &patch).is_err());
            assert_eq!(base, original);
        }
    }

    #[test]
    fn topology_changes_are_fenced_but_body_boundary_receipts_may_advance() {
        let base = layout();
        let patch = edits(
            &base,
            vec![change(
                FlowLayoutField::WidthTwips,
                json!(12240),
                json!(11906),
            )],
        );
        let mut current = base.clone();
        current.sections[0].source.original_properties_xml = Some(
            "<w:sectPr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>"
                .into(),
        );
        assert!(matches!(
            plan_flow_layout_edits(&base, &current, &patch),
            Err(HcdError::PreconditionFailed(_))
        ));
        current = base.clone();
        current.sections[0].different_first_page = true;
        assert!(
            plan_flow_layout_edits(&base, &current, &patch)
                .unwrap()
                .sections[0]
                .different_first_page
        );
        let mut two = layout();
        let mut last = two.sections[0].clone();
        last.id = id(2);
        two.sections[0].source.paragraph_ordinal = Some(1);
        two.sections[0].canonical_end_block_id = Some(id(3));
        two.sections.push(last);
        let patch = edits(
            &two,
            vec![change(
                FlowLayoutField::WidthTwips,
                json!(12240),
                json!(11906),
            )],
        );
        let mut advanced = two.clone();
        advanced.sections[0].canonical_end_block_id = Some(id(4));
        assert_eq!(
            plan_flow_layout_edits(&two, &advanced, &patch)
                .unwrap()
                .sections[0]
                .canonical_end_block_id,
            Some(id(4))
        );
    }

    #[test]
    fn document_flags_are_scoped_and_unknown_fields_rejected() {
        let base = layout();
        let flag = FlowLayoutFieldChange {
            section_id: None,
            field: FlowLayoutField::EvenAndOddHeaders,
            expected: json!(false),
            value: json!(true),
        };
        assert!(
            plan_flow_layout_edits(&base, &base, &edits(&base, vec![flag.clone()]))
                .unwrap()
                .even_and_odd_headers
        );
        let mut wrong = flag;
        wrong.section_id = Some(id(1));
        assert!(plan_flow_layout_edits(&base, &base, &edits(&base, vec![wrong])).is_err());
        let mut json = serde_json::to_value(edits(
            &base,
            vec![change(
                FlowLayoutField::WidthTwips,
                json!(12240),
                json!(100),
            )],
        ))
        .unwrap();
        json["changes"][0]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<FlowLayoutEdits>(json).is_err());
        let mut missing = serde_json::to_value(edits(
            &base,
            vec![change(FlowLayoutField::MarginTop, Value::Null, json!(100))],
        ))
        .unwrap();
        missing["changes"][0]
            .as_object_mut()
            .unwrap()
            .remove("expected");
        assert!(serde_json::from_value::<FlowLayoutEdits>(missing).is_err());
    }

    #[test]
    fn oversized_intents_are_rejected_before_planning() {
        let base = layout();
        let patch = edits(
            &base,
            vec![change(
                FlowLayoutField::Orientation,
                Value::Null,
                json!("x".repeat(MAX_FLOW_LAYOUT_EDITS_BYTES)),
            )],
        );
        assert!(matches!(
            plan_flow_layout_edits(&base, &base, &patch),
            Err(HcdError::ResourceLimit(_))
        ));
    }
}
