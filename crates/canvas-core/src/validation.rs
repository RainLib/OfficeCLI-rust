use crate::{CanvasError, Scene, MAX_ELEMENTS, MAX_SCENE_BYTES};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b':' | b'.'))
}

pub fn validate_scene(scene: &Scene) -> Result<(), CanvasError> {
    if scene.kind != "excalidraw" || scene.version != 2 {
        return Err(CanvasError::Invalid(
            "expected Excalidraw scene version 2".into(),
        ));
    }
    if scene.elements.len() > MAX_ELEMENTS
        || scene.files.len() > 1024
        || serde_json::to_vec(scene)?.len() > MAX_SCENE_BYTES
    {
        return Err(CanvasError::Limit(
            "scene exceeds element, image or byte limit".into(),
        ));
    }
    let mut ids = HashSet::new();
    for element in &scene.elements {
        let id = element["id"].as_str().unwrap_or("");
        if !valid_id(id) || !ids.insert(id) || !element.is_object() {
            return Err(CanvasError::Invalid(
                "invalid or duplicate element ID".into(),
            ));
        }
        if !matches!(
            element["type"].as_str(),
            Some(
                "rectangle"
                    | "diamond"
                    | "ellipse"
                    | "line"
                    | "arrow"
                    | "freedraw"
                    | "text"
                    | "image"
                    | "frame"
                    | "magicframe"
                    | "embeddable"
            )
        ) {
            return Err(CanvasError::Invalid(format!(
                "unsupported element type: {id}"
            )));
        }
        for field in ["x", "y", "width", "height"] {
            if !element[field]
                .as_f64()
                .is_some_and(|v| v.is_finite() && v.abs() <= 100_000_000.0)
            {
                return Err(CanvasError::Invalid(format!("invalid {field}: {id}")));
            }
        }
        if let Some(link) = element["link"].as_str() {
            if !link.starts_with("https://")
                && !link.starts_with("http://")
                && !link.starts_with('#')
            {
                return Err(CanvasError::Invalid(
                    "element links must be HTTP(S) or fragments".into(),
                ));
            }
        }
        if element["locked"].as_bool().is_none() && !element["locked"].is_null() {
            return Err(CanvasError::Invalid("locked must be boolean".into()));
        }
        if let Some(file) = element["fileId"].as_str() {
            if !scene.files.contains_key(file) && element["isDeleted"] != true {
                return Err(CanvasError::Invalid(format!("missing image: {file}")));
            }
        }
        if let Some(points) = element["points"].as_array() {
            if points.len() > 100_000
                || points.iter().any(|p| {
                    p.as_array().is_none_or(|p| {
                        p.len() != 2
                            || p.iter().any(|v| {
                                v.as_f64()
                                    .is_none_or(|n| !n.is_finite() || n.abs() > 100_000_000.0)
                            })
                    })
                })
            {
                return Err(CanvasError::Limit(
                    "invalid or excessive free drawing points".into(),
                ));
            }
        }
        crate::spec::validate_stored(element)?;
        if serde_json::to_vec(element)?.len() > 2 * 1024 * 1024 {
            return Err(CanvasError::Limit("element exceeds 2 MiB".into()));
        }
    }
    for (id, file) in &scene.files {
        if !valid_id(id)
            || file["id"] != *id
            || !matches!(
                file["mimeType"].as_str(),
                Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
            )
        {
            return Err(CanvasError::Invalid("invalid canvas image metadata".into()));
        }
        // Storage may replace the data URL with a content-addressed asset hash.
        match file.get("dataURL") {
            Some(Value::String(data))
                if data.starts_with(&format!(
                    "data:{};base64,",
                    file["mimeType"].as_str().unwrap()
                )) && data.len() <= 16 * 1024 * 1024 => {}
            None if file["assetHash"]
                .as_str()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())) => {}
            _ => {
                return Err(CanvasError::Invalid(
                    "image must contain bounded inline data or an asset hash".into(),
                ))
            }
        }
    }
    Ok(())
}
