use crate::{
    composition::vacant, journal::sticker_shapes, Batch, CanvasError, Motion, Operation, Region,
    Scene, Sticker, StickerPosition, PROTOCOL,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::LazyLock};

pub const CATALOG_VERSION: u8 = 3;
static ROWS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut rows: Vec<Value> = serde_json::from_str(include_str!("../assets/materials.json"))
        .expect("bundled material metadata");
    let packs: Vec<Value> = serde_json::from_str(include_str!("../assets/fluent-materials.json"))
        .expect("bundled Fluent Emoji metadata");
    rows.extend(packs);
    let emoji: Vec<(String, usize, String, String)> =
        serde_json::from_str(include_str!("../assets/unicode-emoji.json"))
            .expect("Unicode emoji metadata");
    for (glyph, group, chinese, english) in emoji {
        let id = format!(
            "emoji-{}",
            glyph
                .chars()
                .map(|c| format!("{:x}", c as u32))
                .collect::<Vec<_>>()
                .join("-")
        );
        let name = if chinese.is_empty() {
            &english
        } else {
            &chinese
        };
        rows.push(json!({"id":id,"category":"emoji","name":name,"summary":english,
            "tags":[EMOJI_GROUPS[group],english,glyph],"useWhen":"白板图例或就地表意。","avoidWhen":"代替文字说明",
            "palette":"lavender","fallback":"系统表情字形","usage":{"emoji":glyph}}));
    }
    rows
});
const EMOJI_GROUPS: [&str; 8] = [
    "表情与人物",
    "动物与自然",
    "食物与饮料",
    "活动",
    "旅行与地点",
    "物品",
    "符号",
    "旗帜",
];
static BY_ID: LazyLock<HashMap<&'static str, &'static Value>> = LazyLock::new(|| {
    ROWS.iter()
        .map(|r| (r["id"].as_str().unwrap(), r))
        .collect()
});
const CATEGORIES: [(&str, &str); 5] = [
    ("brush", "画笔"),
    ("sticker", "贴纸"),
    ("avatar", "头像"),
    ("reaction", "反馈"),
    ("emoji", "表情"),
];

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialQuery {
    pub category: Option<String>,
    pub q: Option<String>,
    pub id: Option<String>,
    pub page: Option<usize>,
}
pub fn material(id: &str) -> Option<&'static Value> {
    BY_ID.get(id).copied()
}

pub fn is_reaction(id: &str) -> bool {
    material(id).is_some_and(|row| matches!(row["category"].as_str(), Some("reaction" | "emoji")))
}

pub(crate) fn reference(id: &str) -> Value {
    let row = material(id).expect("native art has a material entry");
    json!({"id":id,"category":row["category"],"catalogVersion":CATALOG_VERSION})
}

fn rank(row: &Value, query: &str) -> usize {
    if query.is_empty() {
        return 1;
    }
    let words: Vec<_> = query.split_whitespace().collect();
    let matches = |label: &str| {
        let label = label.to_lowercase();
        usize::from(query.contains(&label) || words.iter().any(|word| label.contains(word)))
    };
    let tag_score: usize = row["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .map(matches)
        .sum();
    tag_score
        + 4 * matches(row["name"].as_str().unwrap())
        + 5 * matches(row["id"].as_str().unwrap())
}
pub fn browse_materials(query: &MaterialQuery) -> Result<Value, CanvasError> {
    let category = query.category.as_deref().unwrap_or("");
    let q = query.q.as_deref().unwrap_or("").trim();
    if q.chars().count() > 240
        || (!category.is_empty() && !CATEGORIES.iter().any(|(c, _)| *c == category))
    {
        return Err(CanvasError::Invalid("invalid material search".into()));
    }
    if let Some(id) = &query.id {
        let row = material(id).ok_or_else(|| CanvasError::Invalid("unknown material".into()))?;
        return Ok(json!({"version":CATALOG_VERSION,"level":"detail","material":row}));
    }
    if category.is_empty() && q.is_empty() {
        let categories: Vec<_> = CATEGORIES.iter().map(|(id,name)| json!({"id":id,"name":name,"count":ROWS.iter().filter(|row|row["category"] == *id).count()})).collect();
        return Ok(json!({"version":CATALOG_VERSION,"level":"overview","categories":categories}));
    }
    let q = q.to_lowercase();
    let mut found: Vec<_> = ROWS
        .iter()
        .filter(|r| category.is_empty() || r["category"] == category)
        .map(|r| (rank(r, &q), r))
        .filter(|(v, _)| *v > 0)
        .collect();
    found.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    let total = found.len();
    let page = query.page.unwrap_or_default();
    let items:Vec<_> = found.into_iter().skip(page.saturating_mul(96)).take(96).map(|(_,r)|json!({"id":r["id"],"category":r["category"],"name":r["name"],"summary":r["summary"]})).collect();
    Ok(
        json!({"version":CATALOG_VERSION,"level":"candidates","items":items,"total":total,"page":page,"pageSize":96}),
    )
}

// Structured drafts have a single forced output tool. Supply only the most
// relevant design candidates to those workers, without paths or raw geometry.
pub fn material_hints(task: &str) -> Value {
    let query: String = task.chars().take(240).collect();
    let mut hints = Vec::new();
    for category in ["brush", "sticker", "avatar"] {
        let response = browse_materials(&MaterialQuery {
            category: Some(category.into()),
            q: Some(query.clone()),
            id: None,
            page: None,
        })
        .unwrap();
        hints.extend(
            response["items"]
                .as_array()
                .unwrap()
                .iter()
                .take(2)
                .cloned(),
        );
    }
    json!(hints)
}

pub fn plan_material(
    scene: &Scene,
    document: &str,
    revision: u64,
    patch: &str,
    id: &str,
    within: Option<Region>,
) -> Result<Batch, CanvasError> {
    let row = material(id)
        .filter(|row| {
            matches!(
                row["category"].as_str(),
                Some("sticker" | "avatar" | "emoji")
            )
        })
        .ok_or_else(|| CanvasError::Invalid("选择一款贴纸、头像或表情".into()))?;
    if !crate::validation::valid_id(patch) || patch.len() > 96 {
        return Err(CanvasError::Invalid("invalid material patch ID".into()));
    }
    let area = vacant(scene, 80.0, 80.0, within)?;
    let elements = if let Some(glyph) = row["usage"]["emoji"].as_str() {
        let mut el = crate::composition::shape(
            format!("{patch}-emoji"),
            "text",
            area.x + 8.0,
            area.y + 8.0,
            64.0,
            64.0,
            patch,
        );
        el.as_object_mut().unwrap().extend(json!({"text":glyph,"originalText":glyph,"fontSize":48,
            "fontFamily":2,"lineHeight":1.25,"textAlign":"center","verticalAlign":"top","autoResize":false,
            "containerId":null,"roundness":null,"groupIds":[],"strokeColor":"#242428","backgroundColor":"transparent",
            "customData":{"officeMaterial":reference(id)}}).as_object().unwrap().clone());
        vec![el]
    } else {
        let sticker = Sticker {
            motif: serde_json::from_value(row["id"].clone())?,
            motion: Motion::Auto,
            position: StickerPosition::Heading,
        };
        sticker_shapes(
            &format!("{patch}-sticker"),
            area.x + 8.0,
            area.y + 8.0,
            &sticker,
            serde_json::from_value(row["palette"].clone())?,
        )?
    };
    let batch = Batch {
        schema_version: PROTOCOL.into(),
        document_id: document.into(),
        patch_id: patch.into(),
        base_revision: revision,
        vacant_regions: vec![area],
        operations: elements
            .into_iter()
            .map(|element| Operation::Add { element })
            .collect(),
    };
    crate::apply(scene, &batch, None)?;
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn discovery_limits_metadata_to_the_requested_level() {
        let overview = browse_materials(&MaterialQuery::default()).unwrap();
        assert_eq!(overview["level"], "overview");
        assert!(overview.get("items").is_none());
        let counts: Vec<_> = overview["categories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["count"].as_u64().unwrap())
            .collect();
        assert_eq!(counts, [6, 59, 3, 17, 3781]);
        let result = browse_materials(&MaterialQuery {
            q: Some("会闪".into()),
            ..Default::default()
        })
        .unwrap();
        let candidates = result["items"].as_array().unwrap();
        assert!(candidates.iter().any(|r| r["id"] == "firefly"));
        assert!(candidates.iter().all(|r| r.as_object().unwrap().len() == 4));
        let rockets = browse_materials(&MaterialQuery {
            category: Some("emoji".into()),
            q: Some("火箭".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(rockets["items"][0]["id"], "emoji-1f680");
        assert!(is_reaction("emoji-1f680") && !is_reaction("emoji-deadbeef"));
        let names: HashSet<_> = ROWS.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(names.len(), ROWS.len());
        for id in names {
            let result = browse_materials(&MaterialQuery {
                id: Some(id.into()),
                ..Default::default()
            })
            .unwrap();
            let row = &result["material"];
            assert!(
                row["usage"].is_object() && row["tags"].is_array() && row["useWhen"].is_string()
            );
            assert!(row.get("points").is_none());
        }
        assert!(material_hints(&"İ".repeat(240)).is_array());
        assert!(material_hints("自然手账，春日观察")
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["category"] != "reaction"));
    }

    #[test]
    fn every_art_material_appends_into_vacant_space_with_its_stable_reference() {
        let mut scene = Scene::default();
        for row in ROWS
            .iter()
            .filter(|r| r["category"] != "emoji" || r["id"] == "emoji-1f680")
        {
            let id = row["id"].as_str().unwrap();
            let result = plan_material(&scene, "board", 0, &format!("a-{id}"), id, None);
            if row["category"] == "brush" || row["category"] == "reaction" {
                assert!(result.is_err());
                continue;
            }
            let batch = result.unwrap();
            let next = crate::apply(&scene, &batch, None).unwrap();
            assert_eq!(
                &next.elements[..scene.elements.len()],
                scene.elements.as_slice()
            );
            let anchor = &next.elements[scene.elements.len()];
            assert_eq!(anchor["customData"]["officeMaterial"], reference(id));
            if row["category"] == "emoji" {
                assert_eq!(anchor["text"], "🚀");
                assert_eq!(anchor["type"], "text");
                assert!(!batch.vacant_regions.is_empty());
                continue;
            }
            assert_eq!(anchor["customData"]["officeSticker"]["motif"], id);
            for part in &next.elements[scene.elements.len() + 1..] {
                assert_eq!(
                    part["customData"]["officeStickerPart"]["anchor"],
                    anchor["id"]
                );
            }
            scene = next;
        }
    }
}
