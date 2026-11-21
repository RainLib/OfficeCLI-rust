use crate::{
    validate_scene, validation::valid_id, Batch, CanvasError, Operation, Region, Scene, Selection,
    MAX_OPERATIONS, PROTOCOL,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub fn element_hash(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON values serialize"))
    )
}
pub fn scene_hash(value: &Scene) -> Result<String, CanvasError> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn fields(
    target: &mut Map<String, Value>,
    before: &Map<String, Value>,
    changes: &Map<String, Value>,
) -> Result<(), CanvasError> {
    if changes.is_empty()
        || before.len() != changes.len()
        || changes.keys().any(|k| !before.contains_key(k))
    {
        return Err(CanvasError::Invalid(
            "every changed field needs its prior value".into(),
        ));
    }
    for (key, expected) in before {
        if target.get(key).unwrap_or(&Value::Null) != expected {
            return Err(CanvasError::Conflict(format!(
                "field {key} changed; reread and replan"
            )));
        }
    }
    for (key, value) in changes {
        if value.is_null() {
            target.remove(key);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Pure all-or-nothing transaction. Stale document revisions may merge when
/// their exact object fields are unchanged. Scope is host-supplied, never model-supplied.
pub fn apply(
    scene: &Scene,
    batch: &Batch,
    selection: Option<&Selection>,
) -> Result<Scene, CanvasError> {
    apply_with_base(scene, batch, selection, scene)
}

pub fn apply_with_base(
    scene: &Scene,
    batch: &Batch,
    selection: Option<&Selection>,
    base: &Scene,
) -> Result<Scene, CanvasError> {
    apply_with_receipt(scene, batch, selection, base, false).map(|(scene, _)| scene)
}

pub fn apply_with_receipt(
    scene: &Scene,
    batch: &Batch,
    selection: Option<&Selection>,
    base: &Scene,
    record_rewrite: bool,
) -> Result<(Scene, Option<crate::spec::RewriteEffect>), CanvasError> {
    let mut effect = None;
    if batch.schema_version != PROTOCOL
        || !valid_id(&batch.patch_id)
        || !valid_id(&batch.document_id)
    {
        return Err(CanvasError::Invalid(
            "invalid protocol or batch identity".into(),
        ));
    }
    if batch.operations.is_empty() || batch.operations.len() > MAX_OPERATIONS {
        return Err(CanvasError::Limit(
            "batch must contain 1–2000 operations".into(),
        ));
    }
    if selection.is_some_and(|s| s.region.is_some_and(|r| !r.valid())) {
        return Err(CanvasError::Invalid("invalid selection region".into()));
    }
    if !batch.vacant_regions.is_empty() {
        if batch.vacant_regions.len() > 16 || batch.vacant_regions.iter().any(|r| !r.valid() || r.width <= 0.0 || r.height <= 0.0)
            || batch.operations.iter().any(|op| !matches!(op, Operation::Add { element } if Region::of(element).is_some_and(|b| batch.vacant_regions.iter().any(|r| r.contains(&b))))) {
            return Err(CanvasError::Invalid("append layout only permits additions inside its vacant regions".into()));
        }
        if scene
            .elements
            .iter()
            .filter(|e| e["isDeleted"] != true)
            .filter_map(Region::of)
            .any(|b| batch.vacant_regions.iter().any(|r| r.intersects(&b)))
        {
            return Err(CanvasError::Conflict(
                "append area changed; reread and find new empty space".into(),
            ));
        }
    }
    let mut next = scene.clone();
    let mut touched = HashSet::new();
    for op in &batch.operations {
        if let Some(id) = op.element_id() {
            if !matches!(
                op,
                Operation::SpecUpdate { .. } | Operation::SpecSplice { .. }
            ) && !touched.insert(id.to_string())
            {
                return Err(CanvasError::Invalid(
                    "one operation per element per batch".into(),
                ));
            }
            if let Some(scope) = selection {
                match op {
                    Operation::Add { element }
                        if scope.region.is_some_and(|r| {
                            Region::of(element).is_some_and(|b| r.contains(&b))
                        }) => {}
                    Operation::Add { .. } => {
                        return Err(CanvasError::Invalid(
                            "new object lies outside the authorized region".into(),
                        ))
                    }
                    _ if scope.element_ids.iter().any(|allowed| allowed == id) => {}
                    _ => {
                        return Err(CanvasError::Invalid(format!(
                            "object {id} is outside the authorized selection"
                        )))
                    }
                }
            }
        }
        let content_target = match op {
            Operation::SpecUpdate { id, .. } | Operation::SpecSplice { id, .. } => Some(id),
            Operation::Update { id, changes, .. }
                if changes.contains_key("text") || changes.contains_key("originalText") =>
            {
                Some(id)
            }
            _ => None,
        };
        if let Some(text) = content_target.and_then(|id| {
            next.elements
                .iter()
                .find(|el| el["id"] == *id && crate::spec::is_spec(el))
        }) {
            let root = &text["customData"]["officeBoard"]["root"];
            if text["isDeleted"] == true
                || text["locked"] == true
                || !next.elements.iter().any(|el| {
                    el["id"] == *root
                        && el["customData"]["officeBoard"]["kind"] == "spec"
                        && el["isDeleted"] != true
                        && el["locked"] != true
                })
            {
                return Err(CanvasError::Conflict(
                    "Spec paper or text is deleted or locked".into(),
                ));
            }
        }
        match op {
            Operation::Add { element } => {
                if !element.is_object() {
                    return Err(CanvasError::Invalid("element must be an object".into()));
                }
                if next.elements.iter().any(|e| e["id"] == element["id"]) {
                    return Err(CanvasError::Conflict("element ID already exists".into()));
                }
                let mut element = element.clone();
                element["version"] = Value::from(1);
                element["versionNonce"] = Value::from(u32::from_le_bytes(
                    Sha256::digest(batch.patch_id.as_bytes())[..4]
                        .try_into()
                        .unwrap(),
                ));
                next.elements.push(element);
            }
            Operation::Update {
                id,
                before,
                changes,
            } => {
                if changes.contains_key("id") || changes.contains_key("type") {
                    return Err(CanvasError::Invalid(
                        "element identity and type are immutable".into(),
                    ));
                }
                let element = next
                    .elements
                    .iter_mut()
                    .find(|e| e["id"] == *id)
                    .ok_or_else(|| {
                        CanvasError::Conflict(format!("element {id} no longer exists"))
                    })?;
                if element["locked"] == true {
                    // Humans may explicitly unlock. Agents cannot unlock a protected object.
                    if selection.is_some() || changes.get("locked") != Some(&Value::Bool(false)) {
                        return Err(CanvasError::Conflict(format!("element {id} is locked")));
                    }
                }
                if crate::spec::is_spec(element)
                    && changes.contains_key("customData")
                    && (changes["customData"].get("officeSpec")
                        != element["customData"].get("officeSpec")
                        || changes["customData"]["officeBoard"]
                            != element["customData"]["officeBoard"])
                {
                    return Err(CanvasError::Invalid(
                        "use a Spec transaction for collaborative content".into(),
                    ));
                }
                if crate::spec::is_spec(element)
                    && (changes.contains_key("text") || changes.contains_key("originalText"))
                {
                    let original = base
                        .elements
                        .iter()
                        .find(|e| e["id"] == *id)
                        .ok_or_else(|| CanvasError::Conflict("Spec base is missing".into()))?;
                    let previous = before
                        .get("originalText")
                        .or(before.get("text"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            CanvasError::Invalid("missing Spec text precondition".into())
                        })?;
                    let next = changes
                        .get("originalText")
                        .or(changes.get("text"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| CanvasError::Invalid("missing replacement text".into()))?;
                    crate::spec::replace_plain(element, original, previous, next)?;
                    let rest = |m: &Map<String, Value>| {
                        m.iter()
                            .filter(|(k, _)| {
                                !matches!(k.as_str(), "text" | "originalText" | "height")
                            })
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect::<Map<_, _>>()
                    };
                    let other = rest(changes);
                    let prior = rest(before);
                    if !other.is_empty() || !prior.is_empty() {
                        fields(element.as_object_mut().unwrap(), &prior, &other)?;
                    }
                } else {
                    fields(element.as_object_mut().unwrap(), before, changes)?;
                }
                element["version"] =
                    Value::from(element["version"].as_u64().unwrap_or(0).saturating_add(1));
                element["versionNonce"] = Value::from(u32::from_le_bytes(
                    Sha256::digest(batch.patch_id.as_bytes())[..4]
                        .try_into()
                        .unwrap(),
                ));
            }
            Operation::SpecUpdate { id, .. } | Operation::SpecSplice { id, .. } => {
                let el = next
                    .elements
                    .iter_mut()
                    .find(|el| el["id"] == *id && el["isDeleted"] != true && el["locked"] != true)
                    .ok_or_else(|| {
                        CanvasError::Conflict("Spec text is deleted or locked".into())
                    })?;
                match op {
                    Operation::SpecUpdate { update, .. } => crate::spec::merge(el, update)?,
                    Operation::SpecSplice {
                        block,
                        start,
                        end,
                        expected,
                        insert,
                        ..
                    } => {
                        let old = base
                            .elements
                            .iter()
                            .find(|e| e["id"] == *id && e["isDeleted"] != true)
                            .ok_or_else(|| {
                                CanvasError::Conflict(
                                    "Spec did not exist at the read revision".into(),
                                )
                            })?;
                        effect = crate::spec::splice_recorded(
                            el,
                            old,
                            crate::spec::Splice {
                                block: *block,
                                start: *start,
                                end: *end,
                                expected,
                                insert,
                            },
                            record_rewrite && batch.operations.len() == 1,
                        )?;
                    }
                    _ => unreachable!(),
                }
                el["version"] = Value::from(el["version"].as_u64().unwrap_or(0).saturating_add(1));
                el["versionNonce"] = Value::from(u32::from_le_bytes(
                    Sha256::digest(batch.patch_id.as_bytes())[..4]
                        .try_into()
                        .unwrap(),
                ));
            }
            Operation::Remove { id, expected_hash } => {
                let at = next
                    .elements
                    .iter()
                    .position(|e| e["id"] == *id)
                    .ok_or_else(|| {
                        CanvasError::Conflict(format!("element {id} no longer exists"))
                    })?;
                if next.elements[at]["locked"] == true
                    || element_hash(&next.elements[at]) != *expected_hash
                {
                    return Err(CanvasError::Conflict(format!(
                        "element {id} changed or is locked"
                    )));
                }
                next.elements.remove(at);
            }
            Operation::File { id, file } => {
                if next.files.get(id).is_some_and(|old| old != file) {
                    return Err(CanvasError::Conflict("image IDs are immutable".into()));
                }
                next.files.insert(id.clone(), file.clone());
            }
            Operation::Scene { before, changes } => {
                if selection.is_some()
                    || changes.keys().any(|k| {
                        !matches!(k.as_str(), "viewBackgroundColor" | "gridSize" | "gridStep")
                    })
                {
                    return Err(CanvasError::Invalid(
                        "scene properties are outside this operation's scope".into(),
                    ));
                }
                fields(&mut next.app_state, before, changes)?;
            }
        }
    }
    validate_scene(&next)?;
    Ok((next, effect))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn element(id: &str) -> Value {
        json!({"id":id,"type":"rectangle","x":0,"y":0,"width":100,"height":80,"strokeColor":"#000000"})
    }
    fn batch(operations: Value) -> Batch {
        serde_json::from_value(json!({"schemaVersion":PROTOCOL,"documentId":"board","patchId":"op-1","baseRevision":0,"operations":operations})).unwrap()
    }
    fn initial() -> Scene {
        Scene {
            elements: vec![element("one"), element("two")],
            ..Default::default()
        }
    }
    #[test]
    fn independent_fields_merge_but_same_field_conflicts_atomically() {
        let scene = initial();
        let moved = apply(
            &scene,
            &batch(json!([{"op":"element.update","id":"one","before":{"x":0},"changes":{"x":42}}])),
            None,
        )
        .unwrap();
        let colour = batch(
            json!([{"op":"element.update","id":"one","before":{"strokeColor":"#000000"},"changes":{"strokeColor":"#ff0000"}}]),
        );
        let merged = apply(&moved, &colour, None).unwrap();
        assert_eq!(merged.elements[0]["x"], 42);
        assert_eq!(merged.elements[0]["strokeColor"], "#ff0000");
        let failing = batch(
            json!([{"op":"element.update","id":"two","before":{"x":0},"changes":{"x":20}},{"op":"element.update","id":"one","before":{"x":0},"changes":{"x":10}}]),
        );
        assert!(matches!(
            apply(&merged, &failing, None),
            Err(CanvasError::Conflict(_))
        ));
        assert_eq!(merged.elements[1]["x"], 0);
    }
    #[test]
    fn model_cannot_edit_outside_selection_or_unlock_protected_objects() {
        let mut scene = initial();
        let scope = Selection {
            element_ids: vec!["one".into()],
            region: Some(Region {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 200.0,
            }),
        };
        let outside =
            batch(json!([{"op":"element.update","id":"two","before":{"x":0},"changes":{"x":10}}]));
        assert!(apply(&scene, &outside, Some(&scope)).is_err());
        scene.elements[0]["locked"] = json!(true);
        let unlock = batch(
            json!([{"op":"element.update","id":"one","before":{"locked":true},"changes":{"locked":false}}]),
        );
        assert!(apply(&scene, &unlock, Some(&scope)).is_err());
        assert!(apply(&scene, &unlock, None).is_ok());
    }
    #[test]
    fn free_drawing_and_bindings_roundtrip_without_flattening() {
        let scene:Scene = serde_json::from_value(json!({"type":"excalidraw","version":2,"elements":[{"id":"pen","type":"freedraw","x":-12,"y":2,"width":30,"height":40,"points":[[0,0],[5,9],[30,40]],"pressures":[0.2,0.4,0.9],"simulatePressure":false,"customData":{"source":"human"}}]})).unwrap();
        validate_scene(&scene).unwrap();
        let decoded: Scene = serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
        assert_eq!(decoded.elements, scene.elements);
    }

    #[test]
    fn malformed_native_additions_fail_without_panicking_or_mutating_the_scene() {
        let scene = initial();
        for value in [json!(42), json!(null), json!([]), json!({"id":"bad"})] {
            let invalid = batch(json!([
                {"op":"element.update","id":"one","before":{"x":0},"changes":{"x":20}},
                {"op":"element.add","element":value}
            ]));
            assert!(matches!(
                apply(&scene, &invalid, None),
                Err(CanvasError::Invalid(_))
            ));
            assert_eq!(scene.elements[0]["x"], 0);
        }
    }
}
