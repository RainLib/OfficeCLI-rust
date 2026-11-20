use crate::{html::escape_attribute, HcdError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_PPTX_ANIMATIONS: usize = 100;
const TRACK: &str = "data-hcd-pptx-animations";
const EDITED: &str = "data-hcd-pptx-animation-edited";
const LOCKED: &str = "data-hcd-pptx-animation-locked";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PptxAnimationKind {
    Appear,
    FadeIn,
    FlyIn,
    Disappear,
    FadeOut,
}

impl PptxAnimationKind {
    pub fn is_exit(self) -> bool {
        matches!(self, Self::Disappear | Self::FadeOut)
    }

    pub fn is_instant(self) -> bool {
        matches!(self, Self::Appear | Self::Disappear)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PptxAnimationTrigger {
    OnClick,
    WithPrevious,
    AfterPrevious,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxAnimation {
    /// A native non-visual shape ID or a stable ID for an HCD-authored object.
    pub target: String,
    pub kind: PptxAnimationKind,
    pub trigger: PptxAnimationTrigger,
    pub duration_ms: u32,
    pub delay_ms: u32,
}

#[derive(Default)]
pub struct PptxAnimationTrack {
    pub effects: Vec<PptxAnimation>,
    pub edited: bool,
    pub locked: bool,
}

pub fn valid_authored_target(target: &str) -> bool {
    target
        .strip_prefix("n_")
        .is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub fn native_target_id(target: &str) -> Option<u32> {
    let id = target.strip_prefix('s')?.parse::<u32>().ok()?;
    (id > 0 && format!("s{id}") == target).then_some(id)
}

pub fn validate_pptx_animations(effects: &[PptxAnimation]) -> Result<(), HcdError> {
    if effects.len() > MAX_PPTX_ANIMATIONS {
        return Err(HcdError::ResourceLimit("too many slide animations".into()));
    }
    let mut visibility = HashMap::new();
    let mut end_in_step = HashMap::new();
    let mut previous = (0, 0);
    for effect in effects {
        if (native_target_id(&effect.target).is_none() && !valid_authored_target(&effect.target))
            || !(1..=60_000).contains(&effect.duration_ms)
            || effect.delay_ms > 60_000
            || effect.kind.is_instant() && effect.duration_ms != 1
        {
            return Err(HcdError::InvalidPatch("invalid slide animation".into()));
        }
        // Each object can enter and leave once. This gives playback an
        // unambiguous initial visibility and prevents competing transitions.
        if visibility
            .insert(effect.target.as_str(), effect.kind.is_exit())
            .is_some_and(|already_left| already_left || !effect.kind.is_exit())
        {
            return Err(HcdError::InvalidPatch(
                "a slide object can enter and then exit once".into(),
            ));
        }
        let base = match effect.trigger {
            PptxAnimationTrigger::OnClick => {
                end_in_step.clear();
                0
            }
            PptxAnimationTrigger::WithPrevious => previous.0,
            PptxAnimationTrigger::AfterPrevious => previous.1,
        };
        let start = base + effect.delay_ms;
        let end = start + effect.duration_ms;
        if end_in_step
            .insert(effect.target.as_str(), end)
            .is_some_and(|before| before > start)
        {
            return Err(HcdError::InvalidPatch(
                "effects on the same object cannot overlap".into(),
            ));
        }
        previous = (start, end);
    }
    Ok(())
}

pub fn read_pptx_animation_track(html: &str) -> Result<PptxAnimationTrack, HcdError> {
    let tag = html.split_once('>').map_or("", |(start, _)| start);
    let value = |name| {
        tag.split_once(&format!(" {name}=\""))
            .and_then(|(_, tail)| tail.split_once('"'))
            .map(|(value, _)| value)
    };
    let effects = if let Some(value) = value(TRACK) {
        let effects: Vec<PptxAnimation> = serde_json::from_str(&value.replace("&quot;", "\""))?;
        validate_pptx_animations(&effects)?;
        effects
    } else {
        Vec::new()
    };
    Ok(PptxAnimationTrack {
        effects,
        edited: value(EDITED) == Some("true"),
        locked: value(LOCKED) == Some("true"),
    })
}

pub fn pptx_animation_attributes(track: &PptxAnimationTrack) -> Result<String, HcdError> {
    if track.locked {
        return Ok(format!(" {LOCKED}=\"true\""));
    }
    let mut attributes = String::new();
    if track.edited || !track.effects.is_empty() {
        let effects = escape_attribute(&serde_json::to_string(&track.effects)?);
        attributes.push_str(&format!(" {TRACK}=\"{effects}\""));
    }
    if track.edited {
        attributes.push_str(&format!(" {EDITED}=\"true\""));
    }
    Ok(attributes)
}

pub(crate) fn write_pptx_animation_track(
    html: &mut String,
    track: &PptxAnimationTrack,
) -> Result<(), HcdError> {
    let end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("slide section is incomplete".into()))?;
    let mut tag = html[..end].to_string();
    for name in [TRACK, EDITED, LOCKED] {
        let pattern = format!(" {name}=\"");
        if let Some(start) = tag.find(&pattern) {
            let value = start + pattern.len();
            let close = value
                + tag[value..].find('"').ok_or_else(|| {
                    HcdError::InvalidBundle("slide animation attribute is incomplete".into())
                })?;
            tag.replace_range(start..=close, "");
        }
    }
    tag.push_str(&pptx_animation_attributes(track)?);
    html.replace_range(..end, &tag);
    Ok(())
}
