use crate::common::package_error;
use hcd_core::{
    manifest_at_revision,
    pptx_animation::{
        native_target_id, read_pptx_animation_track, valid_authored_target,
        validate_pptx_animations, PptxAnimation, PptxAnimationKind as Kind, PptxAnimationTrack,
        PptxAnimationTrigger as Trigger,
    },
    Bundle, HcdError,
};
use oxml::{StreamingOxmlArchive, StreamingOxmlRewriter};
use roxmltree::Node;
use std::{collections::HashMap, fmt::Write, path::Path};

const PRESENTATION_NS: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CREATION_NS: &str = "http://schemas.microsoft.com/office/drawing/2014/main";
const CREATION_EXTENSION: &str = "{FF2B5FE4-FFF2-40B4-BE49-E238E27FC236}";
const MAX_SLIDE_XML: u64 = 32 * 1024 * 1024;
type XmlNode<'a, 'input> = Node<'a, 'input>;

fn creation_guid(node_id: &str) -> Option<String> {
    if !valid_authored_target(node_id) {
        return None;
    }
    let hex = node_id[2..].to_ascii_uppercase();
    Some(format!(
        "{{{}-{}-{}-{}-{}}}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// Keep human-readable object names and expose a stable identity for the
/// timing writer after the native shape and media passes assign their IDs.
pub(crate) fn creation_id_xml(node_id: &str) -> String {
    creation_guid(node_id).map_or_else(String::new, |guid| {
        format!(r#"<a:extLst xmlns:a="{DRAWING_NS}"><a:ext uri="{CREATION_EXTENSION}"><a16:creationId xmlns:a16="{CREATION_NS}" id="{guid}"/></a:ext></a:extLst>"#)
    })
}

fn child<'a, 'input>(node: XmlNode<'a, 'input>, name: &str) -> Option<XmlNode<'a, 'input>> {
    node.children()
        .find(|child| child.has_tag_name((PRESENTATION_NS, name)))
}

fn parse_track(timing: Node<'_, '_>) -> Option<Vec<PptxAnimation>> {
    let sequence = timing.descendants().find(|node| {
        node.has_tag_name((PRESENTATION_NS, "cTn")) && node.attribute("nodeType") == Some("mainSeq")
    })?;
    let mut effects = Vec::new();
    for group in child(sequence, "childTnLst")?
        .children()
        .filter(Node::is_element)
    {
        let mut previous_start = 0u32;
        let mut previous_end = 0u32;
        for phase in child(child(group, "cTn")?, "childTnLst")?
            .children()
            .filter(Node::is_element)
        {
            if effects.len() >= hcd_core::pptx_animation::MAX_PPTX_ANIMATIONS {
                return None;
            }
            let phase = child(phase, "cTn")?;
            let start = child(child(phase, "stCondLst")?, "cond")?
                .attribute("delay")?
                .parse::<u32>()
                .ok()?;
            let effect = child(child(child(phase, "childTnLst")?, "par")?, "cTn")?;
            let trigger = match effect.attribute("nodeType")? {
                "clickEffect" => Trigger::OnClick,
                "withEffect" => Trigger::WithPrevious,
                "afterEffect" => Trigger::AfterPrevious,
                _ => return None,
            };
            let kind = match (
                effect.attribute("presetClass")?,
                effect.attribute("presetID")?,
            ) {
                ("entr", "1") => Kind::Appear,
                ("entr", "2") => Kind::FlyIn,
                ("entr", "10") => Kind::FadeIn,
                ("exit", "1") => Kind::Disappear,
                ("exit", "10") => Kind::FadeOut,
                _ => return None,
            };
            let behaviors = child(effect, "childTnLst")?;
            let target = behaviors
                .descendants()
                .find(|node| node.has_tag_name((PRESENTATION_NS, "spTgt")))?
                .attribute("spid")?;
            let duration_ms = effect.attribute("dur")?.parse().ok()?;
            let base = match trigger {
                Trigger::OnClick => 0,
                Trigger::WithPrevious => previous_start,
                Trigger::AfterPrevious => previous_end,
            };
            effects.push(PptxAnimation {
                target: format!("s{target}"),
                kind,
                trigger,
                duration_ms,
                delay_ms: start.checked_sub(base)?,
            });
            previous_start = start;
            previous_end = start.checked_add(duration_ms)?;
        }
    }
    validate_pptx_animations(&effects).ok()?;
    Some(effects)
}

fn equivalent_tree(left: Node<'_, '_>, right: Node<'_, '_>) -> bool {
    if left.is_text() || right.is_text() {
        return left.text() == right.text();
    }
    if left.tag_name() != right.tag_name() {
        return false;
    }
    // The generated track has no time-node ID references. Consumers may
    // renumber its IDs without changing the behavior of the sequence.
    let attr = |node| node != "id" || left.tag_name().name() != "cTn";
    if left
        .attributes()
        .iter()
        .filter(|item| attr(item.name()))
        .count()
        != right
            .attributes()
            .iter()
            .filter(|item| attr(item.name()))
            .count()
        || left
            .attributes()
            .iter()
            .filter(|item| attr(item.name()))
            .any(|item| {
                !right.attributes().iter().any(|other| {
                    item.name() == other.name()
                        && item.namespace() == other.namespace()
                        && item.value() == other.value()
                })
            })
    {
        return false;
    }
    fn visible(node: &Node<'_, '_>) -> bool {
        node.is_element()
            || node
                .text()
                .is_some_and(|text| node.is_text() && !text.trim().is_empty())
    }
    let mut trailing = right.children().filter(visible);
    left.children().filter(visible).all(|node| {
        trailing
            .next()
            .is_some_and(|other| equivalent_tree(node, other))
    }) && trailing.next().is_none()
}

fn import_timing(timing: Node<'_, '_>) -> Option<Vec<PptxAnimation>> {
    let effects = parse_track(timing)?;
    let native: Vec<_> = effects
        .iter()
        .map(|effect| native_target_id(&effect.target).map(|id| (id, effect)))
        .collect::<Option<_>>()?;
    let regenerated = timing_xml(&native);
    let rebuilt = roxmltree::Document::parse(&regenerated).ok()?;
    equivalent_tree(timing, rebuilt.root_element()).then_some(effects)
}

pub(super) fn read_slide(
    archive: &mut StreamingOxmlArchive,
    part: &str,
) -> Result<PptxAnimationTrack, HcdError> {
    if archive
        .entry(part)
        .is_some_and(|entry| entry.uncompressed_size > MAX_SLIDE_XML)
    {
        return Ok(PptxAnimationTrack {
            locked: true,
            ..Default::default()
        });
    }
    let xml = archive
        .read_control_part(part, MAX_SLIDE_XML)
        .map_err(package_error)?;
    let Ok(xml) = std::str::from_utf8(&xml) else {
        return Ok(PptxAnimationTrack {
            locked: true,
            ..Default::default()
        });
    };
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Ok(PptxAnimationTrack {
            locked: true,
            ..Default::default()
        });
    };
    let root = doc.root_element();
    let Some(timing) = root.children().find(|node| node.has_tag_name("timing")) else {
        return Ok(PptxAnimationTrack::default());
    };
    Ok(match import_timing(timing) {
        Some(effects) => PptxAnimationTrack {
            effects,
            ..Default::default()
        },
        None => PptxAnimationTrack {
            locked: true,
            ..Default::default()
        },
    })
}

fn timing_xml(track: &[(u32, &PptxAnimation)]) -> String {
    let mut xml = format!(
        r#"<p:timing xmlns:p="{PRESENTATION_NS}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>"#
    );
    let mut next_id = 3u32;
    let mut group_open = false;
    let mut previous_start = 0;
    let mut previous_end = 0;
    for &(shape_id, effect) in track {
        if !group_open || effect.trigger == Trigger::OnClick {
            if group_open {
                xml.push_str("</p:childTnLst></p:cTn></p:par>");
            }
            let delay = if effect.trigger == Trigger::OnClick {
                "indefinite"
            } else {
                "0"
            };
            write!(xml, r#"<p:par><p:cTn id="{next_id}" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst><p:childTnLst>"#).unwrap();
            next_id += 1;
            group_open = true;
            previous_start = 0;
            previous_end = 0;
        }
        let (node_type, base) = match effect.trigger {
            Trigger::OnClick => ("clickEffect", 0),
            Trigger::WithPrevious => ("withEffect", previous_start),
            Trigger::AfterPrevious => ("afterEffect", previous_end),
        };
        let start = base + effect.delay_ms;
        let duration = effect.duration_ms;
        previous_start = start;
        previous_end = start + duration;
        let class = if effect.kind.is_exit() {
            "exit"
        } else {
            "entr"
        };
        let (preset, subtype) = match effect.kind {
            Kind::Appear | Kind::Disappear => (1, 0),
            Kind::FlyIn => (2, 8),
            Kind::FadeIn | Kind::FadeOut => (10, 0),
        };
        let effect_id = next_id + 1;
        write!(xml, r#"<p:par><p:cTn id="{next_id}" fill="hold"><p:stCondLst><p:cond delay="{start}"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="{effect_id}" dur="{duration}" presetID="{preset}" presetClass="{class}" presetSubtype="{subtype}" fill="hold" grpId="0" nodeType="{node_type}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>"#).unwrap();
        next_id += 2;
        if !effect.kind.is_exit() || effect.kind.is_instant() {
            write_visibility(&mut xml, next_id, shape_id, effect.kind.is_exit(), 0);
            next_id += 1;
        }
        match effect.kind {
            Kind::FadeIn | Kind::FadeOut => {
                let direction = if effect.kind.is_exit() { "out" } else { "in" };
                write!(xml, r#"<p:animEffect transition="{direction}" filter="fade"><p:cBhvr><p:cTn id="{next_id}" dur="{duration}" fill="hold"/><p:tgtEl><p:spTgt spid="{shape_id}"/></p:tgtEl></p:cBhvr></p:animEffect>"#).unwrap();
                next_id += 1;
                if effect.kind.is_exit() {
                    write_visibility(&mut xml, next_id, shape_id, true, duration - 1);
                    next_id += 1;
                }
            }
            Kind::FlyIn => {
                write!(xml, r##"<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="{next_id}" dur="{duration}" fill="hold"/><p:tgtEl><p:spTgt spid="{shape_id}"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="-#ppt_w/2"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>"##).unwrap();
                next_id += 1;
            }
            Kind::Appear | Kind::Disappear => {}
        }
        xml.push_str("</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>");
    }
    if group_open {
        xml.push_str("</p:childTnLst></p:cTn></p:par>");
    }
    xml.push_str(r#"</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#);
    xml
}

fn write_visibility(xml: &mut String, id: u32, shape_id: u32, hide: bool, delay: u32) {
    let value = if hide { "hidden" } else { "visible" };
    write!(xml, r#"<p:set><p:cBhvr><p:cTn id="{id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{shape_id}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="{value}"/></p:to></p:set>"#).unwrap();
}

fn write_track(xml: &mut String, effects: &[PptxAnimation]) -> Result<bool, HcdError> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|cause| HcdError::InvalidBundle(cause.to_string()))?;
    let root = doc.root_element();
    let timing = root.children().find(|node| node.has_tag_name("timing"));
    if timing.is_some_and(|node| import_timing(node).is_none()) {
        return Err(HcdError::Unsupported(
            "This source slide already has unsupported native animations. Reimport to inspect the existing track.".into(),
        ));
    }
    let mut ids = HashMap::new();
    let mut native_ids = std::collections::HashSet::new();
    for node in root
        .descendants()
        .filter(|item| item.has_tag_name((PRESENTATION_NS, "cNvPr")))
    {
        if let Some(id) = node
            .attribute("id")
            .and_then(|value| value.parse::<u32>().ok())
        {
            native_ids.insert(id);
            for creation in node
                .descendants()
                .filter(|item| item.has_tag_name((CREATION_NS, "creationId")))
            {
                if let Some(guid) = creation.attribute("id") {
                    ids.insert(guid, id);
                }
            }
        }
    }
    let native = effects
        .iter()
        .map(|effect| {
            let id = native_target_id(&effect.target)
                .filter(|id| native_ids.contains(id))
                .or_else(|| {
                    creation_guid(&effect.target).and_then(|guid| ids.get(guid.as_str()).copied())
                })
                .ok_or_else(|| {
                    HcdError::InvalidBundle("animation object missing from the native slide".into())
                })?;
            Ok((id, effect))
        })
        .collect::<Result<Vec<_>, HcdError>>()?;
    let range = if let Some(timing) = timing {
        timing.range()
    } else if native.is_empty() {
        return Ok(false);
    } else {
        let offset = child(root, "extLst")
            .map(|node| node.range().start)
            .or_else(|| xml[..root.range().end].rfind("</"))
            .ok_or_else(|| HcdError::InvalidBundle("native slide has no closing tag".into()))?;
        offset..offset
    };
    let replacement = if native.is_empty() {
        String::new()
    } else {
        timing_xml(&native)
    };
    xml.replace_range(range, &replacement);
    Ok(true)
}

pub(crate) fn export(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<usize, HcdError> {
    let (manifest, _) = manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    if manifest.revision == 0 {
        return Ok(0);
    }
    let mut tracks = Vec::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            if descriptor.region != "slide" || descriptor.continuation {
                continue;
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let track = read_pptx_animation_track(&html)?;
            if track.edited {
                let part = html
                    .split_once(" data-hcd-source-part=\"")
                    .and_then(|(_, rest)| rest.split_once('"'))
                    .map(|(part, _)| part)
                    .ok_or_else(|| HcdError::InvalidBundle("slide part is missing".into()))?;
                tracks.push((part.to_owned(), track.effects));
            }
        }
    }
    if tracks.is_empty() {
        return Ok(0);
    }
    let temp = tempfile::tempdir()?;
    let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
    let mut replacements = HashMap::new();
    for (index, (part, effects)) in tracks.into_iter().enumerate() {
        let bytes = archive
            .read_control_part(&part, MAX_SLIDE_XML)
            .map_err(package_error)?;
        let mut xml =
            String::from_utf8(bytes).map_err(|cause| HcdError::InvalidBundle(cause.to_string()))?;
        if write_track(&mut xml, &effects)? {
            let path = temp.path().join(format!("slide-{index}.xml"));
            std::fs::write(&path, xml)?;
            replacements.insert(part, path);
        }
    }
    if replacements.is_empty() {
        return Ok(0);
    }
    drop(archive);
    let output = temp.path().join("animations.pptx");
    StreamingOxmlRewriter::rewrite_with_additions(
        target,
        &output,
        &replacements,
        &HashMap::new(),
        "ppt/presentation.xml",
    )
    .map_err(package_error)?;
    std::fs::copy(output, target)?;
    Ok(replacements.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_round_trips_click_groups_and_rejects_native_triggers_it_would_drop() {
        let first = PptxAnimation {
            target: "s2".into(),
            kind: Kind::FadeIn,
            trigger: Trigger::OnClick,
            delay_ms: 90,
            duration_ms: 420,
        };
        let second = PptxAnimation {
            target: "s3".into(),
            kind: Kind::FlyIn,
            trigger: Trigger::AfterPrevious,
            delay_ms: 75,
            duration_ms: 500,
        };
        let third = PptxAnimation {
            target: "s2".into(),
            kind: Kind::FadeOut,
            trigger: Trigger::OnClick,
            delay_ms: 40,
            duration_ms: 300,
        };
        let xml = timing_xml(&[(2, &first), (3, &second), (2, &third)]);
        let doc = roxmltree::Document::parse(&xml).unwrap();
        assert_eq!(
            import_timing(doc.root_element()),
            Some(vec![first, second, third])
        );
        let custom = xml.replace("evt=\"onNext\"", "evt=\"onClick\"");
        let altered = roxmltree::Document::parse(&custom).unwrap();
        assert_eq!(import_timing(altered.root_element()), None);
        let mut original = format!(r#"<p:sld xmlns:p="{PRESENTATION_NS}">{custom}</p:sld>"#);
        let saved = original.clone();
        assert!(matches!(
            write_track(&mut original, &[]),
            Err(HcdError::Unsupported(_))
        ));
        assert_eq!(original, saved);
    }
}
