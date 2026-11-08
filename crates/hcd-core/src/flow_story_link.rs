//! Read-only impact planning for linking a Word story to the prior section.
//! This is not a revision transaction or authorization to discard live edits.
use crate::{
    flow_layout_hash, FlowDocumentLayout, FlowStoryBindings, FlowStoryKind, FlowStoryVariant,
    HcdError, FLOW_REGION_LAYOUT_SCHEMA,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FLOW_STORY_LINK_TRANSACTION_SCHEMA: &str = "hcd-word-story-link/1";

/// Distinct from the legacy link primitive: a receipt may never reinterpret
/// an older transaction as a coordinated live-room publication.
pub fn coordinated_flow_story_link_hash(
    request: &FlowStoryLinkTransaction,
) -> Result<String, HcdError> {
    Ok(crate::hash_bytes(&serde_json::to_vec(&(
        "hcd-word-coordinated-link/1",
        request,
    ))?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStoryLinkTransaction {
    pub schema_version: String,
    pub document_id: String,
    pub transaction_id: String,
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub actor: BTreeMap<String, String>,
    pub link: FlowStoryLinkRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStoryLinkRequest {
    pub base_layout_hash: String,
    pub section_id: String,
    pub kind: FlowStoryKind,
    pub variant: FlowStoryVariant,
    pub expected_direct_story_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStoryLinkImpact {
    pub section_id: String,
    pub before_story_id: String,
    pub after_story_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FlowStoryLinkPlan {
    pub layout: FlowDocumentLayout,
    pub displaced_story_id: String,
    pub inherited_story_id: Option<String>,
    pub affected: Vec<FlowStoryLinkImpact>,
}

/// A read-only observation captured under the bundle writer lock. It cannot
/// publish a revision and is not permission to replace an active room.
#[derive(Debug, Clone)]
pub struct FlowStoryLinkPreview {
    pub revision: u64,
    pub root_hash: String,
    pub base_layout_hash: String,
    pub candidate_layout_hash: String,
    pub plan: FlowStoryLinkPlan,
}

/// Preview an independent story without creating an identity or copying data.
/// The inherited source must subsequently be captured under the room fence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowStoryUnlinkRequest {
    pub base_layout_hash: String,
    pub section_id: String,
    pub kind: FlowStoryKind,
    pub variant: FlowStoryVariant,
    #[serde(deserialize_with = "required_optional_story")]
    pub expected_inherited_story_id: Option<String>,
}

fn required_optional_story<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStoryUnlinkPlan {
    pub inherited_story_id: Option<String>,
    pub affected_section_ids: Vec<String>,
}

/// Candidate only: the caller must also create fresh canonical content and
/// verify destination source-part ownership before publishing a transaction.
pub fn plan_flow_story_unlink_layout(
    layout: &FlowDocumentLayout,
    request: &FlowStoryUnlinkRequest,
    story: &crate::FlowStory,
) -> Result<(FlowStoryUnlinkPlan, FlowDocumentLayout), HcdError> {
    let plan = plan_flow_story_unlink(layout, request)?;
    if story.kind != request.kind
        || layout
            .stories
            .iter()
            .any(|existing| existing.id == story.id || existing.source_part == story.source_part)
        || layout.sections.iter().any(|section| section.id == story.id)
    {
        return Err(HcdError::InvalidPatch(
            "Word story identity or source part is not independent".into(),
        ));
    }
    let mut next = layout.clone();
    let section = next
        .sections
        .iter_mut()
        .find(|section| section.id == request.section_id)
        .ok_or_else(|| HcdError::InvalidPatch("Word story unlink section not found".into()))?;
    let target = match request.kind {
        FlowStoryKind::Header => &mut section.headers,
        FlowStoryKind::Footer => &mut section.footers,
    };
    match request.variant {
        FlowStoryVariant::Default => target.default = Some(story.id.clone()),
        FlowStoryVariant::First => target.first = Some(story.id.clone()),
        FlowStoryVariant::Even => target.even = Some(story.id.clone()),
    }
    next.stories.push(story.clone());
    next.validate()?;
    Ok((plan, next))
}

/// Reports the exact inherited story and following sections which would use a
/// new direct binding. No story, block, source identity, or revision is created.
pub fn plan_flow_story_unlink(
    layout: &FlowDocumentLayout,
    request: &FlowStoryUnlinkRequest,
) -> Result<FlowStoryUnlinkPlan, HcdError> {
    layout.validate()?;
    if layout.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || flow_layout_hash(layout)? != request.base_layout_hash
    {
        return Err(HcdError::PreconditionFailed(
            "Word story unlink layout changed".into(),
        ));
    }
    let index = layout
        .sections
        .iter()
        .position(|section| section.id == request.section_id)
        .ok_or_else(|| HcdError::InvalidPatch("Word story unlink section not found".into()))?;
    if bindings(&layout.sections[index], request.kind)
        .get(request.variant)
        .is_some()
    {
        return Err(HcdError::InvalidPatch(
            "Word story already has a direct binding".into(),
        ));
    }
    let inherited = layout.sections[..index]
        .iter()
        .rev()
        .find_map(|section| bindings(section, request.kind).get(request.variant))
        .map(str::to_owned);
    if inherited != request.expected_inherited_story_id {
        return Err(HcdError::PreconditionFailed(
            "Word inherited story changed".into(),
        ));
    }
    let affected_section_ids = layout.sections[index..]
        .iter()
        .enumerate()
        .take_while(|(offset, section)| {
            *offset == 0
                || bindings(section, request.kind)
                    .get(request.variant)
                    .is_none()
        })
        .map(|(_, section)| section.id.clone())
        .collect();
    Ok(FlowStoryUnlinkPlan {
        inherited_story_id: inherited,
        affected_section_ids,
    })
}

/// Reconstruct one independent-story binding from immutable layouts. This
/// checks topology only; a future transaction must separately validate the
/// new story's content, source identities, resources, and room fence.
pub fn validate_flow_story_unlink_transition(
    before: &FlowDocumentLayout,
    after: &FlowDocumentLayout,
) -> Result<FlowStoryUnlinkPlan, HcdError> {
    before.validate()?;
    after.validate()?;
    if before.sections.len() != after.sections.len()
        || after.stories.len() != before.stories.len() + 1
        || after.stories[..before.stories.len()] != before.stories
    {
        return Err(HcdError::InvalidPatch(
            "Word story unlink changed existing sections or stories".into(),
        ));
    }
    let story = after.stories.last().expect("one added story");
    let mut request = None;
    for (index, (old, new)) in before.sections.iter().zip(&after.sections).enumerate() {
        for kind in [FlowStoryKind::Header, FlowStoryKind::Footer] {
            for variant in [
                FlowStoryVariant::Default,
                FlowStoryVariant::First,
                FlowStoryVariant::Even,
            ] {
                let old_id = bindings(old, kind).get(variant);
                let new_id = bindings(new, kind).get(variant);
                if old_id == new_id {
                    continue;
                }
                if old_id.is_some() || new_id != Some(story.id.as_str()) || request.is_some() {
                    return Err(HcdError::InvalidPatch(
                        "Word story unlink must add one independent binding".into(),
                    ));
                }
                let inherited = before.sections[..index]
                    .iter()
                    .rev()
                    .find_map(|section| bindings(section, kind).get(variant))
                    .map(str::to_owned);
                request = Some(FlowStoryUnlinkRequest {
                    base_layout_hash: flow_layout_hash(before)?,
                    section_id: old.id.clone(),
                    kind,
                    variant,
                    expected_inherited_story_id: inherited,
                });
            }
        }
    }
    let request = request
        .ok_or_else(|| HcdError::InvalidPatch("Word story unlink did not add a binding".into()))?;
    let (plan, expected) = plan_flow_story_unlink_layout(before, &request, story)?;
    if &expected != after {
        return Err(HcdError::InvalidPatch(
            "Word story unlink changed unrelated layout".into(),
        ));
    }
    Ok(plan)
}

fn bindings(section: &crate::FlowSection, kind: FlowStoryKind) -> &FlowStoryBindings {
    match kind {
        FlowStoryKind::Header => &section.headers,
        FlowStoryKind::Footer => &section.footers,
    }
}

/// Construct an explicit preview against an exact layout. The caller must
/// separately capture and review story contents, concurrent edits, ownership,
/// revision CAS, and durable receipts before ever applying this proposal.
pub fn plan_flow_story_link(
    layout: &FlowDocumentLayout,
    request: &FlowStoryLinkRequest,
) -> Result<FlowStoryLinkPlan, HcdError> {
    layout.validate()?;
    if layout.schema_version != FLOW_REGION_LAYOUT_SCHEMA
        || flow_layout_hash(layout)? != request.base_layout_hash
    {
        return Err(HcdError::PreconditionFailed(
            "Word story link layout changed".into(),
        ));
    }
    let index = layout
        .sections
        .iter()
        .position(|section| section.id == request.section_id)
        .ok_or_else(|| HcdError::InvalidPatch("Word story link section not found".into()))?;
    if index == 0 {
        return Err(HcdError::InvalidPatch(
            "first section has no previous section".into(),
        ));
    }
    let direct = bindings(&layout.sections[index], request.kind)
        .get(request.variant)
        .ok_or_else(|| HcdError::InvalidPatch("Word story is already linked".into()))?;
    if direct != request.expected_direct_story_id {
        return Err(HcdError::PreconditionFailed(
            "Word story binding changed".into(),
        ));
    }
    let inherited = layout.sections[..index]
        .iter()
        .rev()
        .find_map(|section| bindings(section, request.kind).get(request.variant))
        .map(str::to_owned);
    let mut affected = Vec::new();
    for (offset, section) in layout.sections[index..].iter().enumerate() {
        if offset > 0
            && bindings(section, request.kind)
                .get(request.variant)
                .is_some()
        {
            break;
        }
        if inherited.as_deref() != Some(direct) {
            affected.push(FlowStoryLinkImpact {
                section_id: section.id.clone(),
                before_story_id: direct.to_string(),
                after_story_id: inherited.clone(),
            });
        }
    }
    let mut next = layout.clone();
    let target = match request.kind {
        FlowStoryKind::Header => &mut next.sections[index].headers,
        FlowStoryKind::Footer => &mut next.sections[index].footers,
    };
    match request.variant {
        FlowStoryVariant::Default => target.default = None,
        FlowStoryVariant::First => target.first = None,
        FlowStoryVariant::Even => target.even = None,
    }
    next.validate()?;
    Ok(FlowStoryLinkPlan {
        layout: next,
        displaced_story_id: direct.to_owned(),
        inherited_story_id: inherited,
        affected,
    })
}

/// Independently reconstruct a single link operation from two immutable
/// layouts. This is a building block for a future versioned history model;
/// it does not verify document content, authorization, or a transaction receipt.
pub fn validate_flow_story_link_transition(
    before: &FlowDocumentLayout,
    after: &FlowDocumentLayout,
) -> Result<FlowStoryLinkPlan, HcdError> {
    before.validate()?;
    after.validate()?;
    if before.sections.len() != after.sections.len() {
        return Err(HcdError::InvalidPatch(
            "Word story link changed section count".into(),
        ));
    }
    let mut request = None;
    for (old, new) in before.sections.iter().zip(&after.sections) {
        for kind in [FlowStoryKind::Header, FlowStoryKind::Footer] {
            for variant in [
                FlowStoryVariant::Default,
                FlowStoryVariant::First,
                FlowStoryVariant::Even,
            ] {
                let old_id = bindings(old, kind).get(variant);
                let new_id = bindings(new, kind).get(variant);
                if old_id == new_id {
                    continue;
                }
                let removed = old_id.filter(|_| new_id.is_none()).ok_or_else(|| {
                    HcdError::InvalidPatch("Word story link must remove a direct binding".into())
                })?;
                if request.is_some() {
                    return Err(HcdError::InvalidPatch(
                        "Word story link changed multiple bindings".into(),
                    ));
                }
                request = Some(FlowStoryLinkRequest {
                    base_layout_hash: flow_layout_hash(before)?,
                    section_id: old.id.clone(),
                    kind,
                    variant,
                    expected_direct_story_id: removed.to_string(),
                });
            }
        }
    }
    let request = request
        .ok_or_else(|| HcdError::InvalidPatch("Word story link did not change a binding".into()))?;
    let plan = plan_flow_story_link(before, &request)?;
    if &plan.layout != after {
        return Err(HcdError::InvalidPatch(
            "Word story link changed unrelated layout".into(),
        ));
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FlowPageSettings, FlowSection, FlowSectionSource, FlowStory};
    fn id(n: u8) -> String {
        format!("n_{n:032x}")
    }
    fn layout() -> FlowDocumentLayout {
        let sections = (0..4)
            .map(|i| FlowSection {
                id: id(i + 10),
                canonical_end_block_id: (i < 3).then(|| id(i + 30)),
                source: FlowSectionSource {
                    part: "word/document.xml".into(),
                    paragraph_ordinal: (i < 3).then_some(u64::from(i) + 1),
                    paragraph_id: None,
                    original_properties_xml: None,
                },
                different_first_page: false,
                break_type: None,
                page: FlowPageSettings::default(),
                headers: FlowStoryBindings {
                    default: match i {
                        0 => Some(id(1)),
                        1 => Some(id(2)),
                        3 => Some(id(3)),
                        _ => None,
                    },
                    ..Default::default()
                },
                footers: FlowStoryBindings::default(),
            })
            .collect();
        FlowDocumentLayout {
            schema_version: FLOW_REGION_LAYOUT_SCHEMA.into(),
            even_and_odd_headers: false,
            sections,
            stories: (1..=3)
                .map(|i| FlowStory {
                    id: id(i),
                    kind: FlowStoryKind::Header,
                    source_part: format!("word/header{i}.xml"),
                })
                .collect(),
        }
    }
    fn request(layout: &FlowDocumentLayout) -> FlowStoryLinkRequest {
        FlowStoryLinkRequest {
            base_layout_hash: flow_layout_hash(layout).unwrap(),
            section_id: id(11),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Default,
            expected_direct_story_id: id(2),
        }
    }
    #[test]
    fn links_only_requested_variant_and_reports_following_inheritors() {
        let before = layout();
        let plan = plan_flow_story_link(&before, &request(&before)).unwrap();
        assert_eq!(plan.displaced_story_id, id(2));
        assert_eq!(plan.inherited_story_id, Some(id(1)));
        assert_eq!(
            plan.affected
                .iter()
                .map(|item| item.section_id.clone())
                .collect::<Vec<_>>(),
            vec![id(11), id(12)]
        );
        assert_eq!(before.sections[1].headers.default, Some(id(2)));
        assert_eq!(plan.layout.sections[1].headers.default, None);
        assert_eq!(plan.layout.sections[3].headers.default, Some(id(3)));
        assert_eq!(plan.layout.stories, before.stories);
    }
    #[test]
    fn protects_against_stale_wrong_and_missing_preconditions() {
        let before = layout();
        let mut req = request(&before);
        req.expected_direct_story_id = id(3);
        assert!(plan_flow_story_link(&before, &req).is_err());
        req = request(&before);
        let mut changed = before.clone();
        changed.sections[0].headers.default = Some(id(3));
        assert!(plan_flow_story_link(&changed, &req).is_err());
        req.section_id = id(10);
        assert!(plan_flow_story_link(&before, &req).is_err());
        req = request(&before);
        req.variant = FlowStoryVariant::First;
        assert!(plan_flow_story_link(&before, &req).is_err());
        req = request(&before);
        req.kind = FlowStoryKind::Footer;
        assert!(plan_flow_story_link(&before, &req).is_err());
    }
    #[test]
    fn previous_missing_is_reported_as_blank_without_destroying_story() {
        let mut before = layout();
        before.sections[0].headers.default = None;
        let plan = plan_flow_story_link(&before, &request(&before)).unwrap();
        assert_eq!(plan.inherited_story_id, None);
        assert_eq!(plan.affected.len(), 2);
        assert!(plan
            .affected
            .iter()
            .all(|item| item.after_story_id.is_none()));
        assert_eq!(plan.layout.stories, before.stories);
    }

    #[test]
    fn first_page_binding_is_independent_even_when_not_currently_enabled() {
        let mut before = layout();
        before.sections[0].headers.first = Some(id(3));
        before.sections[1].headers.first = Some(id(2));
        let mut req = request(&before);
        req.variant = FlowStoryVariant::First;
        let plan = plan_flow_story_link(&before, &req).unwrap();
        assert_eq!(plan.inherited_story_id, Some(id(3)));
        assert_eq!(plan.layout.sections[1].headers.default, Some(id(2)));
        assert_eq!(plan.layout.sections[1].headers.first, None);
        assert_eq!(plan.affected.len(), 3);
        assert!(!plan.layout.sections[1].different_first_page);
    }

    #[test]
    fn transition_reconstructs_one_link_and_rejects_unrelated_mutations() {
        let before = layout();
        let planned = plan_flow_story_link(&before, &request(&before)).unwrap();
        let verified = validate_flow_story_link_transition(&before, &planned.layout).unwrap();
        assert_eq!(verified.displaced_story_id, id(2));
        assert_eq!(verified.affected.len(), 2);
        let mut modified = planned.layout.clone();
        modified.sections[1].page.width_twips = Some(12000);
        assert!(validate_flow_story_link_transition(&before, &modified).is_err());
        modified = planned.layout.clone();
        modified.sections[3].headers.default = None;
        assert!(validate_flow_story_link_transition(&before, &modified).is_err());
        modified = planned.layout.clone();
        modified.stories.retain(|story| story.id != id(2));
        assert!(validate_flow_story_link_transition(&before, &modified).is_err());
        assert!(validate_flow_story_link_transition(&before, &before).is_err());
    }

    #[test]
    fn unlink_preview_identifies_inherited_source_and_following_sections() {
        let before = layout();
        let request = FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(12),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Default,
            expected_inherited_story_id: Some(id(2)),
        };
        let plan = plan_flow_story_unlink(&before, &request).unwrap();
        assert_eq!(plan.inherited_story_id, Some(id(2)));
        assert_eq!(plan.affected_section_ids, vec![id(12)]);
        assert_eq!(before.sections[2].headers.default, None);
        let mut stale = request.clone();
        stale.expected_inherited_story_id = Some(id(1));
        assert!(plan_flow_story_unlink(&before, &stale).is_err());
        stale = request;
        stale.section_id = id(11);
        assert!(plan_flow_story_unlink(&before, &stale).is_err());
    }

    #[test]
    fn unlink_preview_treats_absent_variant_as_blank_and_checks_layout_hash() {
        let before = layout();
        let mut request = FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(10),
            kind: FlowStoryKind::Footer,
            variant: FlowStoryVariant::First,
            expected_inherited_story_id: None,
        };
        let plan = plan_flow_story_unlink(&before, &request).unwrap();
        assert_eq!(plan.inherited_story_id, None);
        assert_eq!(
            plan.affected_section_ids,
            vec![id(10), id(11), id(12), id(13)]
        );
        request.base_layout_hash = "0".repeat(64);
        assert!(plan_flow_story_unlink(&before, &request).is_err());
        let mut wire = serde_json::to_value(&request).unwrap();
        wire.as_object_mut()
            .unwrap()
            .remove("expectedInheritedStoryId");
        assert!(serde_json::from_value::<FlowStoryUnlinkRequest>(wire).is_err());
    }

    #[test]
    fn unlink_candidate_creates_only_independent_binding_and_rejects_collisions() {
        let before = layout();
        let request = FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(12),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Default,
            expected_inherited_story_id: Some(id(2)),
        };
        let story = FlowStory {
            id: id(50),
            kind: FlowStoryKind::Header,
            source_part: "word/header50.xml".into(),
        };
        let (plan, after) = plan_flow_story_unlink_layout(&before, &request, &story).unwrap();
        assert_eq!(plan.inherited_story_id, Some(id(2)));
        assert_eq!(after.sections[2].headers.default, Some(id(50)));
        assert_eq!(after.sections[1], before.sections[1]);
        assert_eq!(after.sections[3], before.sections[3]);
        assert_eq!(&after.stories[..before.stories.len()], &before.stories);
        assert_eq!(after.stories.last(), Some(&story));
        let mut invalid = story.clone();
        invalid.id = id(2);
        assert!(plan_flow_story_unlink_layout(&before, &request, &invalid).is_err());
        invalid = story.clone();
        invalid.id = id(10);
        assert!(plan_flow_story_unlink_layout(&before, &request, &invalid).is_err());
        invalid = story.clone();
        invalid.source_part = "word/header1.xml".into();
        assert!(plan_flow_story_unlink_layout(&before, &request, &invalid).is_err());
        invalid = story.clone();
        invalid.kind = FlowStoryKind::Footer;
        assert!(plan_flow_story_unlink_layout(&before, &request, &invalid).is_err());
        invalid = story;
        invalid.source_part = "word/../header.xml".into();
        assert!(plan_flow_story_unlink_layout(&before, &request, &invalid).is_err());
    }

    #[test]
    fn unlink_transition_reconstructs_inheritance_and_rejects_other_changes() {
        let before = layout();
        let request = FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(12),
            kind: FlowStoryKind::Header,
            variant: FlowStoryVariant::Default,
            expected_inherited_story_id: Some(id(2)),
        };
        let story = FlowStory {
            id: id(50),
            kind: FlowStoryKind::Header,
            source_part: "word/header50.xml".into(),
        };
        let (_, after) = plan_flow_story_unlink_layout(&before, &request, &story).unwrap();
        let verified = validate_flow_story_unlink_transition(&before, &after).unwrap();
        assert_eq!(verified.inherited_story_id, Some(id(2)));
        assert_eq!(verified.affected_section_ids, vec![id(12)]);
        let mut changed = after.clone();
        changed.sections[0].page.width_twips = Some(10000);
        assert!(validate_flow_story_unlink_transition(&before, &changed).is_err());
        changed = after.clone();
        changed.sections[3].headers.first = Some(id(50));
        assert!(validate_flow_story_unlink_transition(&before, &changed).is_err());
        changed = after.clone();
        changed.stories[0].source_part = "word/changed.xml".into();
        assert!(validate_flow_story_unlink_transition(&before, &changed).is_err());
        assert!(validate_flow_story_unlink_transition(&before, &before).is_err());
    }

    #[test]
    fn unlink_transition_accepts_blank_first_section_and_keeps_variants_separate() {
        let before = layout();
        let request = FlowStoryUnlinkRequest {
            base_layout_hash: flow_layout_hash(&before).unwrap(),
            section_id: id(10),
            kind: FlowStoryKind::Footer,
            variant: FlowStoryVariant::Even,
            expected_inherited_story_id: None,
        };
        let story = FlowStory {
            id: id(50),
            kind: FlowStoryKind::Footer,
            source_part: "word/footer50.xml".into(),
        };
        let (_, after) = plan_flow_story_unlink_layout(&before, &request, &story).unwrap();
        let verified = validate_flow_story_unlink_transition(&before, &after).unwrap();
        assert_eq!(verified.inherited_story_id, None);
        assert_eq!(
            verified.affected_section_ids,
            vec![id(10), id(11), id(12), id(13)]
        );
        assert_eq!(after.sections[0].footers.default, None);
    }
}
