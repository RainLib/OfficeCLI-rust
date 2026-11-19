//! Deterministic OfficeCLI visual grammar. Models provide content, never layout
//! coordinates. A plan only adds editable native shapes and guards its whitespace.
use crate::{Batch, CanvasError, Operation, Region, Scene, PROTOCOL};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layout {
    #[default]
    Grid,
    Flow,
    Timeline,
    Flowchart,
    Architecture,
    Mindmap,
    Lesson,
}
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    #[default]
    Card,
    Bubble,
    Note,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    #[serde(default, deserialize_with = "optional_text")]
    pub title: String,
    #[serde(default, deserialize_with = "optional_text")]
    pub body: String,
    #[serde(default)]
    pub kind: ItemKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composition {
    pub title: String,
    #[serde(default)]
    pub layout: Layout,
    pub items: Vec<Item>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagram: Option<crate::Diagram>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual: Option<crate::VisualPlan>,
}

pub(crate) fn optional_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

pub fn composition_schema() -> Value {
    schema(false)
}

/// Strict tool calls carry absent text as null. Public clients may omit the field.
pub fn structured_composition_schema() -> Value {
    schema(true)
}

fn schema(strict: bool) -> Value {
    let item_fields = if strict {
        json!(["title", "body", "kind"])
    } else {
        json!(["kind"])
    };
    json!({"type":"object","additionalProperties":false,"properties":{
        "title":{"type":"string","minLength":1,"maxLength":100},
        "layout":{"type":"string","enum":["grid","flow","timeline","flowchart","architecture","mindmap","lesson"]},
        "diagram":{"anyOf":[crate::diagram::schema(strict),{"type":"null"}]},
        "visual":{"anyOf":[crate::journal::schema(),{"type":"null"}]},
        "items":{"type":"array","minItems":0,"maxItems":12,"items":{"type":"object","additionalProperties":false,
            "properties":{"title":{"type":["string","null"],"maxLength":100},"body":{"type":["string","null"],"maxLength":600},"kind":{"type":"string","enum":["card","bubble","note"]}},"required":item_fields}}
    },"required":["title","layout","items","diagram","visual"]})
}

// Conservative native-font measurement: CJK/emoji take a full em; ASCII widths
// deliberately leave spare room. Text is wrapped explicitly, never clipped.
pub(crate) fn text_advance(ch: char, size: f64) -> f64 {
    size * if ch.is_ascii() {
        if "MW@#%".contains(ch) {
            0.95
        } else {
            0.62
        }
    } else {
        1.05
    }
}
pub(crate) fn wrapped(value: &str, width: f64, size: f64) -> String {
    let advance = |ch| text_advance(ch, size);
    let closing = |ch: char| "，。！？；：、）】》〉」』％,.!?;:)]}".contains(ch);
    let opening = |ch: char| "（【《〈「『([{".contains(ch);
    let mut out = String::new();
    let mut used = 0.0;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\n' {
            out.push(ch);
            used = 0.0;
            continue;
        }
        if used == 0.0 && ch.is_whitespace() {
            continue;
        }
        let mut token = vec![ch];
        if opening(ch) {
            if let Some(next) = chars.next_if(|c| *c != '\n') {
                token.push(next);
            }
        }
        if ch.is_ascii_alphanumeric() {
            while let Some(next) = chars.next_if(|c| c.is_ascii_alphanumeric()) {
                token.push(next);
            }
        }
        while let Some(next) = chars.next_if(|c| closing(*c)) {
            token.push(next);
        }
        let length = token.iter().map(|c| advance(*c)).sum::<f64>();
        if used > 0.0 && used + length > width {
            out.push('\n');
            used = 0.0;
        }
        for ch in token {
            let length = advance(ch);
            if used > 0.0 && used + length > width {
                out.push('\n');
                used = 0.0;
            }
            out.push(ch);
            used += length;
        }
    }
    out
}
pub(crate) fn text_height(text: &str, size: f64) -> f64 {
    text.lines().count().max(1) as f64 * size * 1.4
}

pub(crate) fn field_height(value: &str, width: f64, size: f64) -> f64 {
    if value.trim().is_empty() {
        0.0
    } else {
        text_height(&wrapped(value.trim(), width, size), size)
    }
}

pub(crate) fn shape(id: String, kind: &str, x: f64, y: f64, w: f64, h: f64, group: &str) -> Value {
    json!({"id":id,"type":kind,"x":x,"y":y,"width":w,"height":h,"angle":0,"strokeColor":"#CACEC6",
        "backgroundColor":"#FFFFFF","fillStyle":"solid","strokeWidth":1,"strokeStyle":"solid","roughness":0,"opacity":100,
        "groupIds":[group],"frameId":null,"roundness":{"type":3},"seed":1,"version":1,"versionNonce":1,
        "isDeleted":false,"boundElements":null,"updated":0,"link":null,"locked":false,
        "customData":{"officeComposition":{"group":group,"role":kind}}})
}
pub(crate) fn label(
    id: String,
    value: &str,
    position: (f64, f64),
    width: f64,
    size: f64,
    color: &str,
    group: &str,
) -> Value {
    let text = wrapped(value, width, size);
    let mut result = shape(
        id,
        "text",
        position.0,
        position.1,
        width,
        text_height(&text, size),
        group,
    );
    let properties = json!({"text":text,"originalText":text,"fontSize":size,"fontFamily":2,"lineHeight":1.4,
        "textAlign":"left","verticalAlign":"top","autoResize":false,"containerId":null,"roundness":null,
        "strokeColor":color,"backgroundColor":"transparent"});
    result
        .as_object_mut()
        .unwrap()
        .extend(properties.as_object().unwrap().clone());
    result
}

pub(crate) fn vacant(
    scene: &Scene,
    width: f64,
    height: f64,
    within: Option<Region>,
) -> Result<Region, CanvasError> {
    let occupied: Vec<_> = scene
        .elements
        .iter()
        .filter(|e| e["isDeleted"] != true)
        .filter_map(Region::of)
        .collect();
    let clear = |r: &Region| !occupied.iter().any(|o| r.intersects(o));
    if let Some(area) = within {
        if !area.valid() || width > area.width || height > area.height {
            return Err(CanvasError::Limit(
                "所选区域放不下这些内容，请减少卡片或扩大空白区域".into(),
            ));
        }
        let mut ys = vec![area.y];
        ys.extend(
            occupied
                .iter()
                .map(|o| o.y + o.height + 40.0)
                .filter(|y| *y >= area.y),
        );
        let mut xs = vec![area.x];
        xs.extend(
            occupied
                .iter()
                .map(|o| o.x + o.width + 40.0)
                .filter(|x| *x >= area.x),
        );
        ys.sort_by(f64::total_cmp);
        xs.sort_by(f64::total_cmp);
        // Bound work for dense boards. Falling back to a clear error preserves all content.
        for y in ys.into_iter().take(128) {
            for &x in xs.iter().take(128) {
                let r = Region {
                    x,
                    y,
                    width,
                    height,
                };
                if area.contains(&r) && clear(&r) {
                    return Ok(r);
                }
            }
        }
        return Err(CanvasError::Conflict(
            "所选区域没有足够空位，已有布局保持不变".into(),
        ));
    }
    let x = occupied
        .iter()
        .map(|o| o.x + o.width)
        .reduce(f64::max)
        .map(|x| x + 80.0)
        .unwrap_or(0.0);
    let y = occupied.iter().map(|o| o.y).reduce(f64::min).unwrap_or(0.0);
    let region = Region {
        x,
        y,
        width,
        height,
    };
    if !region.valid() || x + width > 100_000_000.0 || y + height > 100_000_000.0 {
        return Err(CanvasError::Limit(
            "画布坐标范围不足，请选择另一处空白区域".into(),
        ));
    }
    Ok(region)
}

pub fn compose(
    scene: &Scene,
    document: &str,
    revision: u64,
    patch_id: &str,
    plan: &Composition,
    within: Option<Region>,
) -> Result<Batch, CanvasError> {
    if plan.visual.is_some() {
        return crate::journal::compose(scene, document, revision, patch_id, plan, within);
    }
    if matches!(
        plan.layout,
        Layout::Flowchart | Layout::Architecture | Layout::Mindmap | Layout::Lesson
    ) {
        return crate::diagram::compose(scene, document, revision, patch_id, plan, within);
    }
    if plan.diagram.is_some() {
        return Err(CanvasError::Invalid(
            "图解内容需要使用流程图、架构图、头脑风暴或课程讲解布局".into(),
        ));
    }
    if !crate::validation::valid_id(patch_id)
        || patch_id.len() > 96
        || plan.title.trim().is_empty()
        || plan.title.chars().count() > 100
        || plan.items.is_empty()
        || plan.items.len() > 12
        || plan
            .items
            .iter()
            .any(|i| i.title.chars().count() > 100 || i.body.chars().count() > 600)
    {
        return Err(CanvasError::Invalid(
            "需要 1–12 张卡片；标题最多 100 字，说明最多 600 字".into(),
        ));
    }
    let columns = match plan.layout {
        Layout::Timeline => 1,
        Layout::Flow => plan.items.len(),
        Layout::Grid => plan.items.len().min(3),
        _ => unreachable!("diagram layouts handled above"),
    };
    let card_w = if matches!(plan.layout, Layout::Timeline) {
        580.0
    } else {
        300.0
    };
    let gap = 32.0;
    let padding = 28.0;
    let heights: Vec<_> = plan
        .items
        .iter()
        .map(|i| {
            let title = field_height(&i.title, card_w - 48.0, 20.0);
            let body = field_height(&i.body, card_w - 48.0, 16.0);
            if title > 0.0 && body > 0.0 {
                (title + body + 90.0).max(168.0)
            } else {
                (title + body + 64.0).max(72.0)
            }
        })
        .collect();
    let row_heights: Vec<f64> = heights
        .chunks(columns)
        .map(|r| r.iter().copied().fold(0.0, f64::max))
        .collect();
    let title_h = text_height(
        &wrapped(&plan.title, columns as f64 * (card_w + gap) - gap, 28.0),
        28.0,
    );
    let width = padding * 2.0 + columns as f64 * card_w + (columns - 1) as f64 * gap;
    let height = padding * 2.0
        + title_h
        + 32.0
        + row_heights.iter().sum::<f64>()
        + (row_heights.len() - 1) as f64 * gap;
    let area = vacant(scene, width, height, within)?;
    let mut elements = vec![label(
        format!("{patch_id}-heading"),
        &plan.title,
        (area.x + padding, area.y + padding),
        width - padding * 2.0,
        28.0,
        "#252722",
        patch_id,
    )];
    let mut row_y = area.y + padding + title_h + 32.0;
    for (index, item) in plan.items.iter().enumerate() {
        let row = index / columns;
        let col = index % columns;
        if col == 0 && row > 0 {
            row_y += row_heights[row - 1] + gap;
        }
        let x = area.x + padding + col as f64 * (card_w + gap);
        let y = row_y;
        let h = row_heights[row] - 18.0;
        let group = format!("{patch_id}-item-{index}");
        let fill = match item.kind {
            ItemKind::Bubble => "#F7E9E1",
            ItemKind::Note => "#EDF0E6",
            ItemKind::Card => "#FFFFFF",
        };
        let mut card = shape(
            format!("{group}-body"),
            "rectangle",
            x,
            y,
            card_w,
            h,
            &group,
        );
        card["backgroundColor"] = json!(fill);
        elements.push(card);
        let mut accent = shape(
            format!("{group}-accent"),
            "rectangle",
            x + 24.0,
            y + 20.0,
            28.0,
            4.0,
            &group,
        );
        accent["backgroundColor"] = json!("#B75F42");
        accent["strokeColor"] = json!("#B75F42");
        accent["strokeWidth"] = json!(0);
        elements.push(accent);
        let mut body_y = y + 38.0;
        if !item.title.trim().is_empty() {
            let title = label(
                format!("{group}-title"),
                item.title.trim(),
                (x + 24.0, body_y),
                card_w - 48.0,
                20.0,
                "#252722",
                &group,
            );
            body_y += title["height"].as_f64().unwrap() + 12.0;
            elements.push(title);
        }
        if !item.body.trim().is_empty() {
            elements.push(label(
                format!("{group}-text"),
                item.body.trim(),
                (x + 24.0, body_y),
                card_w - 48.0,
                16.0,
                "#61655C",
                &group,
            ));
        }
        if matches!(item.kind, ItemKind::Bubble) {
            let mut tail = shape(
                format!("{group}-tail"),
                "line",
                x + 30.0,
                y + h - 1.0,
                24.0,
                17.0,
                &group,
            );
            tail["points"] = json!([[0, 0], [24, 0], [4, 17], [0, 0]]);
            tail["backgroundColor"] = json!(fill);
            tail["strokeColor"] = json!(fill);
            tail["strokeWidth"] = json!(0);
            tail["roundness"] = Value::Null;
            tail["startArrowhead"] = Value::Null;
            tail["endArrowhead"] = Value::Null;
            elements.push(tail);
        }
        if matches!(plan.layout, Layout::Flow) && col + 1 < columns && index + 1 < plan.items.len()
        {
            let mut arrow = shape(
                format!("{group}-connector"),
                "arrow",
                x + card_w + 6.0,
                y + h / 2.0,
                gap - 12.0,
                0.0,
                patch_id,
            );
            arrow["points"] = json!([[0, 0], [gap - 12.0, 0]]);
            arrow["endArrowhead"] = json!("arrow");
            arrow["startArrowhead"] = Value::Null;
            arrow["backgroundColor"] = json!("transparent");
            arrow["strokeColor"] = json!("#B75F42");
            arrow["roundness"] = Value::Null;
            elements.push(arrow);
        }
        if matches!(plan.layout, Layout::Timeline) && index + 1 < plan.items.len() {
            let mut line = shape(
                format!("{group}-connector"),
                "arrow",
                x + card_w / 2.0,
                y + h + 20.0,
                0.0,
                gap - 6.0,
                patch_id,
            );
            line["points"] = json!([[0, 0], [0, gap - 6.0]]);
            line["backgroundColor"] = json!("transparent");
            line["strokeColor"] = json!("#B75F42");
            line["roundness"] = Value::Null;
            line["startArrowhead"] = Value::Null;
            line["endArrowhead"] = Value::Null;
            elements.push(line);
        }
    }
    // Native endpoint bindings keep connectors attached when a card is moved.
    for index in 0..plan.items.len().saturating_sub(1) {
        let connector = format!("{patch_id}-item-{index}-connector");
        let from = format!("{patch_id}-item-{index}-body");
        let to = format!("{patch_id}-item-{}-body", index + 1);
        if let Some(arrow) = elements.iter_mut().find(|e| e["id"] == connector) {
            let timeline = matches!(plan.layout, Layout::Timeline);
            arrow["startBinding"] =
                json!({"elementId":from,"focus":0,"gap":if timeline {20}else{6}});
            arrow["endBinding"] = json!({"elementId":to,"focus":0,"gap":if timeline {4}else{6}});
            arrow["groupIds"] = json!([]);
            for card in elements
                .iter_mut()
                .filter(|e| e["id"] == from || e["id"] == to)
            {
                if !card["boundElements"].is_array() {
                    card["boundElements"] = json!([]);
                }
                card["boundElements"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"arrow","id":connector}));
            }
        }
    }
    let batch = Batch {
        schema_version: PROTOCOL.into(),
        document_id: document.into(),
        patch_id: patch_id.into(),
        base_revision: revision,
        operations: elements
            .into_iter()
            .map(|element| Operation::Add { element })
            .collect(),
        vacant_regions: vec![area],
    };
    crate::apply(scene, &batch, None)?;
    Ok(batch)
}

/// Partition a team append into aligned, non-overlapping sections. All sections
/// are committed together; no worker can move another worker's or a human's data.
pub fn compose_sections(
    scene: &Scene,
    document: &str,
    revision: u64,
    patch_id: &str,
    plans: &[Composition],
    within: Option<Region>,
) -> Result<Batch, CanvasError> {
    if plans.is_empty() || plans.len() > 8 {
        return Err(CanvasError::Limit("团队需要 1–8 个分区".into()));
    }
    let measured: Vec<_> = plans
        .iter()
        .enumerate()
        .map(|(i, p)| {
            compose(
                &Scene::default(),
                document,
                revision,
                &format!("{patch_id}-{i}"),
                p,
                None,
            )
            .map(|b| b.vacant_regions[0])
        })
        .collect::<Result<_, _>>()?;
    let columns = plans.len().min(2);
    let gap = 64.0;
    let column_width = (0..columns)
        .map(|c| {
            measured
                .iter()
                .skip(c)
                .step_by(columns)
                .map(|r| r.width)
                .fold(0.0, f64::max)
        })
        .collect::<Vec<_>>();
    let rows = measured
        .chunks(columns)
        .map(|r| r.iter().map(|r| r.height).fold(0.0, f64::max))
        .collect::<Vec<_>>();
    let area = vacant(
        scene,
        column_width.iter().sum::<f64>() + (columns - 1) as f64 * gap,
        rows.iter().sum::<f64>() + (rows.len() - 1) as f64 * gap,
        within,
    )?;
    let mut virtual_scene = scene.clone();
    let mut operations = vec![];
    for (i, plan) in plans.iter().enumerate() {
        let col = i % columns;
        let row = i / columns;
        let slot = Region {
            x: area.x + column_width[..col].iter().sum::<f64>() + col as f64 * gap,
            y: area.y + rows[..row].iter().sum::<f64>() + row as f64 * gap,
            width: measured[i].width,
            height: measured[i].height,
        };
        let batch = compose(
            &virtual_scene,
            document,
            revision,
            &format!("{patch_id}-{i}"),
            plan,
            Some(slot),
        )?;
        virtual_scene = crate::apply(&virtual_scene, &batch, None)?;
        operations.extend(batch.operations);
    }
    Ok(Batch {
        schema_version: PROTOCOL.into(),
        document_id: document.into(),
        patch_id: patch_id.into(),
        base_revision: revision,
        operations,
        vacant_regions: vec![area],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_geometry_and_receipts_survive_json_roundtrips() {
        let batch = compose_sections(
            &Scene::default(),
            "board",
            0,
            "durable",
            &[plan(), plan()],
            None,
        )
        .unwrap();
        let bytes = serde_json::to_vec(&batch).unwrap();
        let read: Batch = serde_json::from_slice(&bytes).unwrap();
        assert!(
            serde_json::to_vec(&read).unwrap() == bytes,
            "saved append receipt must retain the exact batch hash"
        );
        let scene = crate::apply(&Scene::default(), &batch, None).unwrap();
        let persisted: Scene =
            serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
        for (expected, actual) in scene.elements.iter().zip(&persisted.elements) {
            for (key, value) in expected.as_object().unwrap() {
                assert_eq!(
                    value, &actual[key],
                    "native geometry field {key} changed after persistence"
                );
            }
        }
    }
    fn plan() -> Composition {
        Composition {
            title: "工作空间路线图".into(),
            diagram: None,
            visual: None,
            layout: Layout::Grid,
            items: (0..5)
                .map(|i| Item {
                    title: format!("阶段 {i}"),
                    body: "保留已有布局，同时处理中文换行与长标题。".repeat(7),
                    kind: ItemKind::Bubble,
                })
                .collect(),
        }
    }
    #[test]
    fn appends_without_changing_any_existing_record_and_keeps_text_inside_cards() {
        let mut scene = Scene::default();
        scene.elements.push(json!({"id":"human","type":"rectangle","x":-50,"y":0,"width":400,"height":300,"locked":true,"customData":{"mine":42}}));
        let batch = compose(&scene, "board", 2, "composition", &plan(), None).unwrap();
        let next = crate::apply(&scene, &batch, None).unwrap();
        assert_eq!(next.elements[0], scene.elements[0]);
        assert!(batch.vacant_regions[0].x >= 430.0);
        for text in next
            .elements
            .iter()
            .filter(|e| e["type"] == "text" && e["id"].as_str().unwrap().ends_with("-text"))
        {
            let group = text["groupIds"][0].as_str().unwrap();
            let card = next
                .elements
                .iter()
                .find(|e| e["id"] == format!("{group}-body"))
                .unwrap();
            assert!(Region::of(card)
                .unwrap()
                .contains(&Region::of(text).unwrap()));
        }
    }
    #[test]
    fn human_entering_planned_whitespace_rejects_whole_append() {
        let mut scene = Scene::default();
        let batch = compose(&scene, "board", 0, "composition", &plan(), None).unwrap();
        scene
            .elements
            .push(json!({"id":"new-human","type":"ellipse","x":50,"y":50,"width":30,"height":30}));
        assert!(matches!(
            crate::apply(&scene, &batch, None),
            Err(CanvasError::Conflict(_))
        ));
        assert_eq!(scene.elements.len(), 1);
    }
    #[test]
    fn team_sections_do_not_overlap_and_keep_native_connector_bindings() {
        let scene = Scene::default();
        let mut flow = plan();
        flow.layout = Layout::Flow;
        let batch =
            compose_sections(&scene, "board", 0, "team", &[flow, plan(), plan()], None).unwrap();
        let result = crate::apply(&scene, &batch, None).unwrap();
        let mut sections = vec![];
        for i in 0..3 {
            let prefix = format!("team-{i}-");
            let bounds: Vec<_> = result
                .elements
                .iter()
                .filter(|e| e["id"].as_str().unwrap().starts_with(&prefix))
                .filter_map(Region::of)
                .collect();
            let x = bounds.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
            let y = bounds.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
            sections.push(Region {
                x,
                y,
                width: bounds.iter().map(|b| b.x + b.width).fold(x, f64::max) - x,
                height: bounds.iter().map(|b| b.y + b.height).fold(y, f64::max) - y,
            });
        }
        for i in 0..3 {
            for j in i + 1..3 {
                assert!(!sections[i].intersects(&sections[j]));
            }
        }
        let arrows: Vec<_> = result
            .elements
            .iter()
            .filter(|e| e["type"] == "arrow")
            .collect();
        assert_eq!(arrows.len(), 4);
        for arrow in arrows {
            for endpoint in ["startBinding", "endBinding"] {
                let card = result
                    .elements
                    .iter()
                    .find(|e| e["id"] == arrow[endpoint]["elementId"])
                    .unwrap();
                assert!(card["boundElements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b["id"] == arrow["id"]));
            }
        }
    }
    #[test]
    fn vacant_guard_cannot_be_used_to_change_an_existing_element() {
        let scene = Scene::default();
        let mut batch = compose(&scene, "board", 0, "guard", &plan(), None).unwrap();
        batch.operations.push(Operation::Update {
            id: "old".into(),
            before: serde_json::Map::new(),
            changes: serde_json::Map::new(),
        });
        assert!(matches!(
            crate::apply(&scene, &batch, None),
            Err(CanvasError::Invalid(_))
        ));
    }
    #[test]
    fn layouts_are_bounded_and_do_not_squeeze_into_occupied_or_tiny_scopes() {
        for layout in [Layout::Grid, Layout::Flow, Layout::Timeline] {
            let mut p = plan();
            p.layout = layout;
            assert!(compose(&Scene::default(), "board", 0, "layout", &p, None).is_ok());
        }
        assert!(compose(
            &Scene::default(),
            "board",
            0,
            "small",
            &plan(),
            Some(Region {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0
            })
        )
        .is_err());
    }
}
