use super::{
    set_attribute_in_range, stable_node_id, update_start_tag_style, xlsx_attribute, HcdError,
    PatchBatch, PatchOperation,
};
use crate::pptx_group::{
    group_opening, DrawingRect, DrawingTransform, GroupEdit, ObjectLocator, EDITED_ATTRIBUTE,
    GROUP_CAN_UNGROUP, GROUP_CLASS, GROUP_COMPLETE, GROUP_SOURCE, TRANSFORM_ATTRIBUTE,
};
use crate::{ChunkSourceMap, HcdManifest, ImageGeometry, ImageGeometryUnit, PptxShapeGeometry};
use quick_xml::{events::Event, Reader};
use std::{
    collections::{BTreeMap, HashSet},
    ops::Range,
};

pub(super) fn require_pptx_group_patch(
    manifest: &HcdManifest,
    patch: &PatchBatch,
    chunk_id: &str,
) -> Result<(), HcdError> {
    if manifest.source.format != "pptx"
        || patch.schema_version != crate::HCD_PATCH_SCHEMA_VERSION_64
        || patch.operations.len() != 1
    {
        return Err(HcdError::Unsupported(
            "slide groups require one PPTX operation with hcd-patch/64".into(),
        ));
    }
    super::validate_identifier("chunkId", chunk_id)
}

pub(super) fn apply_slide_group(
    html: &mut String,
    map: &mut ChunkSourceMap,
    patch: &PatchBatch,
) -> Result<GroupEdit, HcdError> {
    let scene_start = html.find('>').ok_or_else(invalid_scene)? + 1;
    let scene_end = html.rfind("</section>").ok_or_else(invalid_scene)?;
    let scene = html.get(scene_start..scene_end).ok_or_else(invalid_scene)?;
    let siblings = elements(scene)?;
    let (result, edit) = match &patch.operations[0] {
        PatchOperation::PptxGroupCreate { node_ids, .. } => {
            let selected: HashSet<_> = node_ids.iter().map(String::as_str).collect();
            let mut chosen = Vec::new();
            for sibling in &siblings {
                if object_id(sibling, map).is_some_and(|id| selected.contains(id)) {
                    chosen.push(sibling);
                }
            }
            if chosen.len() != selected.len() {
                return Err(HcdError::PreconditionFailed(
                    "all group members must still be on the same slide fragment".into(),
                ));
            }
            let mut members = Vec::with_capacity(chosen.len());
            let mut frames = Vec::with_capacity(chosen.len());
            for sibling in &chosen {
                if attribute(sibling.tag, GROUP_COMPLETE) == Some("0")
                    || attribute(sibling.tag, "data-hcd-pptx-grouped") == Some("true")
                    || attribute(sibling.tag, "data-hcd-pptx-placeholder") == Some("true")
                {
                    return Err(HcdError::Unsupported(
                        "select standalone shapes, pictures, text boxes, or whole groups".into(),
                    ));
                }
                let locator = locator(sibling, map).ok_or_else(unsupported_member)?;
                members.push(locator);
                frames.push(placement(sibling.tag)?.bounds());
            }
            let frame = DrawingRect::enclosing(frames)
                .filter(|frame| frame.valid())
                .ok_or_else(unsupported_member)?;
            let transform = DrawingTransform::identity_group(frame);
            let id = stable_node_id(&[&patch.document_id, &patch.patch_id, "slide-group"]);
            let mut grouped = group_opening(&id, None, "", transform, true, true)?;
            for member in &chosen {
                let mut tag = member.tag.to_string();
                set_attribute(&mut tag, "data-hcd-pptx-grouped", "true")?;
                grouped.push_str(&tag);
                grouped.push_str(member.body);
            }
            grouped.push_str("</div>");
            let mut result = scene.to_string();
            let highest = chosen.pop().ok_or_else(invalid_scene)?;
            result.replace_range(highest.range.clone(), &grouped);
            for sibling in chosen.into_iter().rev() {
                result.replace_range(sibling.range.clone(), "");
            }
            (
                result,
                GroupEdit::Create {
                    id,
                    members,
                    transform,
                },
            )
        }
        PatchOperation::PptxGroupUngroup { group_id, .. } => {
            let group = siblings
                .iter()
                .find(|element| attribute(element.tag, "data-hcd-id") == Some(group_id))
                .ok_or_else(|| HcdError::NodeNotFound(group_id.clone()))?;
            if !is_group(group.tag)
                || attribute(group.tag, GROUP_COMPLETE) != Some("1")
                || attribute(group.tag, GROUP_CAN_UNGROUP) != Some("1")
            {
                return Err(HcdError::Unsupported(
                    "this native group contains protected or unsupported objects".into(),
                ));
            }
            let locator = locator(group, map).ok_or_else(unsupported_member)?;
            enforce_timing(html, &locator)?;
            let frame = placement(group.tag)?;
            let inner = group
                .body
                .strip_suffix("</div>")
                .ok_or_else(invalid_scene)?;
            let members = elements(inner)?;
            if members.is_empty() {
                return Err(unsupported_member());
            }
            let mut promoted = inner.to_string();
            for member in members.iter().rev() {
                let member_locator = self::locator(member, map).ok_or_else(unsupported_member)?;
                let saved = placement(member.tag)?;
                let transform = saved.promoted(frame)?;
                let mut tag = member.tag.to_string();
                set_attribute(&mut tag, "data-hcd-pptx-grouped", "false")?;
                if transform != saved {
                    if !is_group(member.tag) {
                        if let ObjectLocator::Created(id) = &member_locator {
                            sync_authored_geometry(map, id, transform.frame)?;
                        }
                    }
                    write_placement(&mut tag, transform)?;
                }
                promoted.replace_range(
                    member.range.start..member.range.start + member.tag.len(),
                    &tag,
                );
            }
            let mut result = scene.to_string();
            result.replace_range(group.range.clone(), &promoted);
            (result, GroupEdit::Ungroup { group: locator })
        }
        _ => unreachable!("validated slide group operation"),
    };
    html.replace_range(scene_start..scene_end, &result);
    Ok(edit)
}

fn enforce_timing(html: &str, locator: &ObjectLocator) -> Result<(), HcdError> {
    let ObjectLocator::Native(id) = locator else {
        return Ok(());
    };
    let track = crate::pptx_animation::read_pptx_animation_track(html)?;
    let target = format!("s{id}");
    if track.locked || track.effects.iter().any(|effect| effect.target == target) {
        return Err(HcdError::Unsupported(
            "remove animations targeting the group before ungrouping".into(),
        ));
    }
    Ok(())
}

pub(super) fn move_group_object(
    tag: &mut String,
    before: PptxShapeGeometry,
    after: PptxShapeGeometry,
) -> Result<bool, HcdError> {
    if !is_group(tag) && attribute(tag, EDITED_ATTRIBUTE) != Some("true") {
        return Ok(false);
    }
    if attribute(tag, GROUP_COMPLETE) == Some("0") {
        return Err(HcdError::Unsupported(
            "the selected group spans multiple slide fragments".into(),
        ));
    }
    let mut transform = placement(tag)?;
    if transform.frame != from_geometry(before) {
        return Err(HcdError::PreconditionFailed(
            "PPTX drawing bounds changed".into(),
        ));
    }
    transform.frame = from_geometry(after);
    write_placement(tag, transform)?;
    Ok(true)
}

fn from_geometry(geometry: PptxShapeGeometry) -> DrawingRect {
    DrawingRect {
        x: geometry.x_emu as i64,
        y: geometry.y_emu as i64,
        width: geometry.width_emu as i64,
        height: geometry.height_emu as i64,
    }
}

// A generated text box is addressed by its mapped run, and the native add pass
// still reads its initial rectangle from that source path.
fn sync_authored_geometry(
    map: &mut ChunkSourceMap,
    id: &str,
    frame: DrawingRect,
) -> Result<(), HcdError> {
    let Some(entry) = map.entries.iter_mut().find(|entry| {
        entry.node_id == id && entry.source.created_in_hcd && entry.source.node_kind == "slide-text"
    }) else {
        return Ok(());
    };
    let font = entry
        .source
        .text_id
        .as_deref()
        .and_then(|value| value.rsplit_once(','))
        .map(|(_, size)| size)
        .filter(|size| {
            size.parse::<u64>()
                .is_ok_and(|size| (100..=25_600).contains(&size))
        })
        .ok_or_else(invalid_scene)?;
    if frame.x < 0 || frame.y < 0 {
        return Err(HcdError::Unsupported(
            "move the group onto the slide before ungrouping the new text box".into(),
        ));
    }
    entry.source.text_id = Some(format!(
        "hcd-pptx-box:{},{},{},{},{font}",
        frame.x, frame.y, frame.width, frame.height
    ));
    Ok(())
}

fn write_placement(tag: &mut String, transform: DrawingTransform) -> Result<(), HcdError> {
    set_attribute(tag, TRANSFORM_ATTRIBUTE, &transform.encode()?)?;
    set_attribute(tag, EDITED_ATTRIBUTE, "true")?;
    if transform.children.is_some() {
        return set_attribute(tag, "style", &transform.group_css());
    }
    let frame = transform.frame;
    let px = |value| format!("{:.6}px", value as f64 / 9525.0);
    let css = BTreeMap::from([
        ("left".into(), px(frame.x)),
        ("top".into(), px(frame.y)),
        ("width".into(), px(frame.width)),
        ("height".into(), px(frame.height)),
        ("transform".into(), transform.object_css()),
        ("transform-origin".into(), "center".into()),
    ]);
    update_start_tag_style(tag, TRANSFORM_ATTRIBUTE, &css, false)?;
    let picture = attribute(tag, "data-hcd-node-kind") == Some("image");
    for (axis, value) in [
        ("x", frame.x),
        ("y", frame.y),
        ("width", frame.width),
        ("height", frame.height),
    ] {
        set_attribute(tag, &format!("data-hcd-{axis}-emu"), &value.to_string())?;
        if picture {
            set_attribute(tag, &format!("data-hcd-{axis}"), &value.to_string())?;
        }
    }
    if picture {
        let geometry = ImageGeometry {
            x: frame.x as f64,
            y: frame.y as f64,
            width: frame.width as f64,
            height: frame.height as f64,
            unit: ImageGeometryUnit::Emu,
        };
        let hash = crate::image_visual_hash(attribute(tag, "data-hcd-asset-hash"), Some(&geometry));
        set_attribute(tag, "data-hcd-visual-hash", &hash)?;
    }
    Ok(())
}

fn set_attribute(tag: &mut String, name: &str, value: &str) -> Result<(), HcdError> {
    set_attribute_in_range(tag, 0, tag.len() - 1, name, value)
}

fn placement(tag: &str) -> Result<DrawingTransform, HcdError> {
    if let Some(transform) = attribute(tag, TRANSFORM_ATTRIBUTE) {
        return DrawingTransform::decode(transform);
    }
    let picture = attribute(tag, "data-hcd-node-kind") == Some("image");
    let number = |axis: &str| {
        attribute(tag, &format!("data-hcd-{axis}-emu"))
            .or_else(|| {
                picture
                    .then(|| attribute(tag, &format!("data-hcd-{axis}")))
                    .flatten()
            })
            .and_then(|value| value.parse().ok())
            .ok_or_else(unsupported_member)
    };
    let mut transform = DrawingTransform::object(DrawingRect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    });
    transform.rotation = attribute(tag, "data-hcd-rotation")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    transform.flip_h = attribute(tag, "data-hcd-pptx-flip-h") == Some("true");
    transform.flip_v = attribute(tag, "data-hcd-pptx-flip-v") == Some("true");
    if !transform.valid() {
        return Err(unsupported_member());
    }
    Ok(transform)
}

struct Element<'a> {
    range: Range<usize>,
    tag: &'a str,
    body: &'a str,
}

fn elements(html: &str) -> Result<Vec<Element<'_>>, HcdError> {
    let mut reader = Reader::from_str(html);
    let mut elements = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        let Ok(event) = reader.read_event() else {
            return Err(invalid_scene());
        };
        let tag_end = reader.buffer_position() as usize;
        match event {
            Event::Start(open) => {
                reader
                    .read_to_end(open.name())
                    .map_err(|_| invalid_scene())?;
            }
            Event::Empty(_) => {}
            Event::Eof => break,
            Event::Text(_) | Event::Comment(_) => continue,
            _ => return Err(invalid_scene()),
        }
        let end = reader.buffer_position() as usize;
        elements.push(Element {
            range: start..end,
            tag: &html[start..tag_end],
            body: &html[tag_end..end],
        });
    }
    Ok(elements)
}

fn is_group(tag: &str) -> bool {
    attribute(tag, "class") == Some(GROUP_CLASS)
}

fn locator(element: &Element<'_>, map: &ChunkSourceMap) -> Option<ObjectLocator> {
    let tag = element.tag;
    let source = [GROUP_SOURCE, "data-hcd-shape-id", "data-hcd-picture-id"]
        .iter()
        .find_map(|name| attribute(tag, name));
    if let Some(source) = source {
        return source
            .parse()
            .ok()
            .filter(|id| *id > 0)
            .map(ObjectLocator::Native);
    }
    if is_group(tag)
        || attribute(tag, "data-hcd-created-preset").is_some()
        || attribute(tag, "data-hcd-created-image") == Some("true")
        || attribute(tag, "class") == Some("hcd-slide-shape")
    {
        return object_id(element, map).map(|id| ObjectLocator::Created(id.to_string()));
    }
    None
}

fn object_id<'a>(element: &'a Element<'a>, map: &'a ChunkSourceMap) -> Option<&'a str> {
    attribute(element.tag, "data-hcd-id").or_else(|| {
        (attribute(element.tag, "class") == Some("hcd-slide-shape"))
            .then(|| {
                map.entries
                    .iter()
                    .find(|entry| {
                        entry.source.created_in_hcd
                            && entry.source.node_kind == "slide-text"
                            && element
                                .body
                                .contains(&format!("data-hcd-id=\"{}\"", entry.node_id))
                    })
                    .map(|entry| entry.node_id.as_str())
            })
            .flatten()
    })
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    xlsx_attribute(tag, name)
}
fn invalid_scene() -> HcdError {
    HcdError::InvalidBundle("invalid canonical slide drawing tree".into())
}
fn unsupported_member() -> HcdError {
    HcdError::Unsupported("slide group members need native drawing identities and bounds".into())
}
