//! Semantic AI diagrams compiled into editable native objects. No model-supplied
//! coordinates, executable markup, style overrides or external resources.
use crate::{
    composition::{field_height, label, optional_text, shape, vacant},
    Batch, CanvasError, Composition, Layout, Operation, Region, Scene, PROTOCOL,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Process,
    Decision,
    Terminal,
    Service,
    Database,
    Topic,
    Concept,
    Example,
    Question,
    Summary,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Arrow,
    Association,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramNode {
    pub id: String,
    #[serde(default, deserialize_with = "optional_text")]
    pub title: String,
    #[serde(default, deserialize_with = "optional_text")]
    pub body: String,
    pub kind: NodeKind,
    pub group: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramEdge {
    pub from: String,
    pub to: String,
    pub label: String,
    pub kind: EdgeKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagramGroup {
    pub id: String,
    pub title: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagram {
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
    pub groups: Vec<DiagramGroup>,
}

pub(crate) fn schema(strict: bool) -> Value {
    let fields = if strict {
        json!(["id", "title", "body", "kind", "group"])
    } else {
        json!(["id", "kind", "group"])
    };
    json!({"type":"object","additionalProperties":false,"properties":{
        "nodes":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","additionalProperties":false,"properties":{
            "id":{"type":"string","minLength":1,"maxLength":40},"title":{"type":["string","null"],"maxLength":80,"description":"Optional authored heading; use null when the content stands alone."},"body":{"type":["string","null"],"maxLength":360,"description":"Optional explanation; use null when the heading is enough."},
            "kind":{"type":"string","enum":["process","decision","terminal","service","database","topic","concept","example","question","summary"]},"group":{"type":["string","null"]}
        },"required":fields}},
        "edges":{"type":"array","maxItems":40,"items":{"type":"object","additionalProperties":false,"properties":{
            "from":{"type":"string"},"to":{"type":"string"},"label":{"type":"string","maxLength":28},"kind":{"type":"string","enum":["arrow","association"]}
        },"required":["from","to","label","kind"]}},
        "groups":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":40},"title":{"type":"string","minLength":1,"maxLength":60}},"required":["id","title"]}}
    },"required":["nodes","edges","groups"]})
}

pub(crate) fn validate(graph: &Diagram, layout: Layout) -> Result<(), CanvasError> {
    let invalid = |s: &str| CanvasError::Invalid(s.into());
    if graph.nodes.is_empty()
        || graph.nodes.len() > 24
        || graph.edges.len() > 40
        || graph.groups.len() > 8
    {
        return Err(invalid("图解需要 1–24 个节点、至多 40 条连线与 8 个分组"));
    }
    let id_ok = |s: &str| s.len() <= 40 && crate::validation::valid_id(s);
    let mut ids = HashSet::new();
    let mut groups = HashSet::new();
    for group in &graph.groups {
        if !id_ok(&group.id)
            || !groups.insert(group.id.as_str())
            || group.title.trim().is_empty()
            || group.title.chars().count() > 60
        {
            return Err(invalid("分组标识应唯一，标题需要 1–60 字"));
        }
    }
    for node in &graph.nodes {
        if !id_ok(&node.id)
            || !ids.insert(node.id.as_str())
            || node.title.chars().count() > 80
            || node.body.chars().count() > 360
            || node
                .group
                .as_ref()
                .is_some_and(|g| !groups.contains(g.as_str()))
        {
            return Err(invalid(
                "节点标识需唯一，标题最多 80 字、说明最多 360 字，并引用真实分组",
            ));
        }
    }
    let mut links = HashSet::new();
    for edge in &graph.edges {
        if !ids.contains(edge.from.as_str())
            || !ids.contains(edge.to.as_str())
            || !links.insert((&edge.from, &edge.to))
            || edge.label.chars().count() > 28
        {
            return Err(invalid("连线需引用真实节点，不得重复，说明最多 28 字"));
        }
    }
    if graph.groups.iter().any(|g| {
        !graph
            .nodes
            .iter()
            .any(|n| n.group.as_deref() == Some(&g.id))
    }) {
        return Err(invalid("分组不能留空"));
    }
    if matches!(layout, Layout::Mindmap) {
        if !graph.groups.is_empty() {
            return Err(invalid("头脑风暴使用中心主题与分支，不接受额外分组"));
        }
        let roots: Vec<_> = graph
            .nodes
            .iter()
            .filter(|n| !graph.edges.iter().any(|e| e.to == n.id))
            .collect();
        if roots.len() != 1
            || graph.edges.len() + 1 != graph.nodes.len()
            || graph
                .nodes
                .iter()
                .any(|n| graph.edges.iter().filter(|e| e.to == n.id).count() > 1)
        {
            return Err(invalid("头脑风暴需要一个中心主题，每个分支只有一个父节点"));
        }
        let mut reached = HashSet::from([roots[0].id.as_str()]);
        for _ in 0..graph.nodes.len() {
            for edge in &graph.edges {
                if reached.contains(edge.from.as_str()) {
                    reached.insert(edge.to.as_str());
                }
            }
        }
        if reached.len() != graph.nodes.len() {
            return Err(invalid("头脑风暴不能包含孤立节点或循环分支"));
        }
    }
    if matches!(layout, Layout::Flowchart) && !graph.groups.is_empty() {
        return Err(invalid("流程图通过连线表达步骤，分层分组请使用架构图"));
    }
    if matches!(layout, Layout::Lesson)
        && (!graph.nodes.iter().any(|n| n.kind == NodeKind::Concept)
            || !graph.nodes.iter().any(|n| n.kind == NodeKind::Example)
            || !graph.nodes.iter().any(|n| n.kind == NodeKind::Question))
    {
        return Err(invalid("课程讲解应包含概念讲解、示范例题和思考练习"));
    }
    Ok(())
}

fn content_height(node: &DiagramNode, layout: Layout, width: f64) -> f64 {
    let title = field_height(&node.title, width, 20.0);
    let body = field_height(&node.body, width, 16.0);
    let gap = if title > 0.0 && body > 0.0 { 12.0 } else { 0.0 };
    let badge = if kind_label(node.kind, layout).is_some() {
        26.0
    } else {
        0.0
    };
    badge + title + gap + body
}

pub(crate) fn dimensions(node: &DiagramNode, layout: Layout) -> Region {
    let diamond = node.kind == NodeKind::Decision;
    let width = if diamond { 360.0 } else { 280.0 };
    let inner = if diamond { 180.0 } else { 232.0 };
    let height = (content_height(node, layout, inner) + 44.0).max(64.0);
    Region {
        x: 0.0,
        y: 0.0,
        width,
        height: if diamond { height * 2.0 } else { height },
    }
}
fn colors(kind: NodeKind, branch: usize) -> (&'static str, &'static str) {
    match kind {
        NodeKind::Topic => ("#B75F42", "#FFFFFF"),
        NodeKind::Decision => ("#FFF2D9", "#705426"),
        NodeKind::Database => ("#E9EFF6", "#3F647F"),
        NodeKind::Example => ("#E9F0E7", "#4B6852"),
        NodeKind::Question => ("#F2EBF6", "#765D83"),
        _ => [
            ("#FFFFFF", "#B75F42"),
            ("#EDF2EA", "#59745F"),
            ("#EDF1F6", "#54728C"),
            ("#F3EDF4", "#886C8F"),
        ][branch % 4],
    }
}
fn kind_label(kind: NodeKind, layout: Layout) -> Option<&'static str> {
    if matches!(layout, Layout::Mindmap) {
        return None;
    }
    Some(match kind {
        NodeKind::Process => "步骤",
        NodeKind::Decision => "条件判断",
        NodeKind::Terminal => "起止",
        NodeKind::Service => "组件 / 服务",
        NodeKind::Database => "数据存储",
        NodeKind::Topic => "中心主题",
        NodeKind::Concept => return None,
        NodeKind::Example => "示范例题",
        NodeKind::Question => "思考练习",
        NodeKind::Summary => "归纳总结",
    })
}

pub(crate) fn compose(
    scene: &Scene,
    document: &str,
    revision: u64,
    patch_id: &str,
    plan: &Composition,
    within: Option<Region>,
) -> Result<Batch, CanvasError> {
    if !crate::validation::valid_id(patch_id)
        || patch_id.len() > 96
        || plan.title.trim().is_empty()
        || plan.title.chars().count() > 100
        || !plan.items.is_empty()
    {
        return Err(CanvasError::Invalid(
            "图解需要有效标题，使用 diagram 表达内容，items 应为空".into(),
        ));
    }
    let graph = plan
        .diagram
        .as_ref()
        .ok_or_else(|| CanvasError::Invalid("AI 尚未提供节点与连线内容".into()))?;
    validate(graph, plan.layout)?;
    let mut placement = crate::diagram_layout::place(graph, plan.layout)?;
    // Leave a real title band above the content even for long generated titles.
    let content_width = placement
        .boxes
        .iter()
        .map(|r| r.x + r.width)
        .fold(600.0, f64::max);
    let heading = label(
        format!("{patch_id}-heading"),
        &plan.title,
        (0.0, 0.0),
        content_width,
        28.0,
        "#252722",
        patch_id,
    );
    let top = heading["height"].as_f64().unwrap() + 64.0;
    for r in &mut placement.boxes {
        r.y += top;
    }
    for band in &mut placement.bands {
        band.region.y += top;
    }
    let index: HashMap<_, _> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), i))
        .collect();
    let mut elements = vec![heading];
    for (i, band) in placement.bands.iter().enumerate() {
        let r = band.region;
        let mut back = shape(
            format!("{patch_id}-band-{i}"),
            "rectangle",
            r.x,
            r.y,
            r.width,
            r.height,
            patch_id,
        );
        back["backgroundColor"] = json!(["#F4F2EC", "#F0F3EE", "#EFF2F6", "#F4EFF4"][i % 4]);
        back["strokeColor"] = json!("#DADCD4");
        back["customData"]["officeDiagram"] = json!({"id":patch_id,"title":plan.title,"layout":plan.layout,"section":i,"sectionTitle":band.title});
        elements.push(back);
        if band.title.trim().is_empty() {
            continue;
        }
        elements.push(label(
            format!("{patch_id}-band-{i}-title"),
            &format!("{:02}   {}", i + 1, band.title),
            (r.x + 24.0, r.y + 20.0),
            r.width - 48.0,
            18.0,
            "#61655C",
            patch_id,
        ));
    }
    // All connectors are behind node bodies. Their routes avoid unrelated nodes.
    let mut bindings: HashMap<usize, Vec<Value>> = HashMap::new();
    let mut label_obstacles = placement.boxes.clone();
    label_obstacles.extend(
        elements
            .iter()
            .filter(|e| e["type"] == "text")
            .filter_map(Region::of),
    );
    let mut edge_labels = vec![];
    for (i, edge) in graph.edges.iter().enumerate() {
        let from = index[edge.from.as_str()];
        let to = index[edge.to.as_str()];
        let route = crate::diagram_routing::route(&placement.boxes, from, to, i)?;
        let origin = route[0];
        let id = format!("{patch_id}-edge-{i}");
        let min_x = route.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let max_x = route.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let min_y = route.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let max_y = route.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        let mut arrow = shape(
            id.clone(),
            "arrow",
            origin.0,
            origin.1,
            max_x - min_x,
            max_y - min_y,
            patch_id,
        );
        arrow["points"] = json!(route
            .iter()
            .map(|p| [p.0 - origin.0, p.1 - origin.1])
            .collect::<Vec<_>>());
        arrow["groupIds"] = json!([]);
        arrow["startArrowhead"] = Value::Null;
        arrow["endArrowhead"] = if matches!(edge.kind, EdgeKind::Arrow) {
            json!("triangle")
        } else {
            Value::Null
        };
        arrow["strokeColor"] = json!(if matches!(plan.layout, Layout::Mindmap) {
            colors(graph.nodes[to].kind, placement.branches[to]).1
        } else if graph.nodes[from].kind == NodeKind::Decision {
            "#A77B40"
        } else {
            "#71877D"
        });
        arrow["backgroundColor"] = json!("transparent");
        arrow["roundness"] = json!({"type":2});
        // Native elbow arrows round only the corner (16 px), unlike a smooth
        // spline which overshoots orthogonal waypoints and can make loops.
        arrow["elbowed"] = json!(true);
        arrow["fixedSegments"] = json!([]);
        arrow["startIsSpecial"] = json!(false);
        arrow["endIsSpecial"] = json!(false);
        arrow["strokeWidth"] = json!(2);
        let fixed = |p: (f64, f64), r: Region| {
            [
                ((p.0 - r.x) / r.width).clamp(0.0, 1.0),
                ((p.1 - r.y) / r.height).clamp(0.0, 1.0),
            ]
        };
        arrow["startBinding"] = json!({"elementId":format!("{patch_id}-node-{from}"),"focus":0,"gap":8,"fixedPoint":fixed(origin, placement.boxes[from])});
        arrow["endBinding"] = json!({"elementId":format!("{patch_id}-node-{to}"),"focus":0,"gap":8,"fixedPoint":fixed(*route.last().unwrap(), placement.boxes[to])});
        arrow["customData"]["officeDiagram"] = json!({"id":patch_id,"layout":plan.layout,"from":edge.from,"to":edge.to,"label":edge.label});
        for n in [from, to] {
            bindings
                .entry(n)
                .or_default()
                .push(json!({"type":"arrow","id":id}));
        }
        if !edge.label.is_empty() {
            let p = crate::diagram_routing::label_position(
                &route,
                &label_obstacles,
                edge_labels.iter().filter_map(Region::of).collect(),
                &edge.label,
            )?;
            let mut text = label(
                format!("{id}-label"),
                &edge.label,
                (p.x, p.y),
                p.width,
                14.0,
                "#4E5A55",
                patch_id,
            );
            // Native bound text follows endpoint edits along with its connector.
            arrow["boundElements"] = json!([{"type":"text","id":text["id"]}]);
            text["containerId"] = json!(id);
            text["groupIds"] = json!([]);
            text["textAlign"] = json!("center");
            text["verticalAlign"] = json!("middle");
            edge_labels.push(text);
        }
        elements.push(arrow);
    }
    for (i, node) in graph.nodes.iter().enumerate() {
        let r = placement.boxes[i];
        let group = format!("{patch_id}-node-group-{i}");
        let (fill, accent) = colors(node.kind, placement.branches[i]);
        let mut body = shape(
            format!("{patch_id}-node-{i}"),
            if node.kind == NodeKind::Decision {
                "diamond"
            } else {
                "rectangle"
            },
            r.x,
            r.y,
            r.width,
            r.height,
            &group,
        );
        body["backgroundColor"] = json!(fill);
        body["strokeColor"] = json!(if node.kind == NodeKind::Topic {
            "#B75F42"
        } else {
            "#CACEC6"
        });
        body["boundElements"] = json!(bindings.remove(&i).unwrap_or_default());
        body["customData"]["officeDiagram"] = json!({"id":patch_id,"title":plan.title,"layout":plan.layout,"nodeId":node.id,"kind":node.kind,"group":node.group,"nodeTitle":node.title.trim()});
        if node.kind == NodeKind::Terminal {
            body["roundness"] = json!({"type":3,"value":32});
        }
        elements.push(body);
        let diamond = node.kind == NodeKind::Decision;
        let x = if diamond {
            r.x + r.width / 4.0
        } else {
            r.x + 24.0
        };
        let w = if diamond {
            r.width / 2.0
        } else {
            r.width - 48.0
        };
        let mut y = r.y + (r.height - content_height(node, plan.layout, w)) / 2.0;
        if let Some(badge) = kind_label(node.kind, plan.layout) {
            elements.push(label(
                format!("{patch_id}-badge-{i}"),
                badge,
                (x, y),
                w,
                11.0,
                accent,
                &group,
            ));
            y += 26.0;
        }
        if !node.title.trim().is_empty() {
            let mut title = label(
                format!("{patch_id}-title-{i}"),
                node.title.trim(),
                (x, y),
                w,
                20.0,
                if node.kind == NodeKind::Topic {
                    "#FFFFFF"
                } else {
                    "#252722"
                },
                &group,
            );
            y += title["height"].as_f64().unwrap() + 12.0;
            title["customData"]["officeNodeField"] = json!("title");
            elements.push(title);
        }
        if !node.body.trim().is_empty() {
            let mut description = label(
                format!("{patch_id}-text-{i}"),
                node.body.trim(),
                (x, y),
                w,
                16.0,
                if node.kind == NodeKind::Topic {
                    "#FFF4EC"
                } else {
                    "#61655C"
                },
                &group,
            );
            description["customData"]["officeNodeField"] = json!("body");
            elements.push(description);
        }
    }
    elements.extend(edge_labels);
    if matches!(plan.layout, Layout::Architecture | Layout::Lesson) {
        for (section, _) in placement.bands.iter().enumerate() {
            let group = format!("{patch_id}-section-{section}");
            for element in &mut elements {
                if element["id"] == format!("{patch_id}-band-{section}")
                    || element["id"] == format!("{patch_id}-band-{section}-title")
                {
                    element["groupIds"] = json!([group]);
                }
            }
            for (node, branch) in placement.branches.iter().enumerate() {
                if *branch != section {
                    continue;
                }
                let node_group = format!("{patch_id}-node-group-{node}");
                for element in &mut elements {
                    if element["groupIds"][0] == node_group {
                        element["groupIds"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!(group));
                    }
                }
            }
        }
    }
    let bounds: Vec<_> = elements.iter().filter_map(Region::of).collect();
    let x = bounds.iter().map(|r| r.x).fold(0.0, f64::min);
    let y = bounds.iter().map(|r| r.y).fold(0.0, f64::min);
    let width = bounds.iter().map(|r| r.x + r.width).fold(0.0, f64::max) - x + 64.0;
    let height = bounds.iter().map(|r| r.y + r.height).fold(0.0, f64::max) - y + 64.0;
    let area = vacant(scene, width, height, within)?;
    for element in &mut elements {
        element["x"] = json!(element["x"].as_f64().unwrap() + area.x - x + 32.0);
        element["y"] = json!(element["y"].as_f64().unwrap() + area.y - y + 32.0);
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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../fixtures/diagrams.json")).unwrap()
    }
    #[test]
    fn optional_card_fields_only_emit_user_text_and_keep_graph_bindings() {
        for layout in ["mindmap", "grid"] {
            let mut value = json!({"title":"讨论","layout":layout,"items":[]});
            let fields = [
                json!({"title":"概念讲解"}),
                json!({"body":"仅说明","title":null}),
                json!({"body":"  "}),
            ];
            if layout == "mindmap" {
                let mut nodes = vec![];
                for (i, mut node) in fields.into_iter().enumerate() {
                    node["id"] = json!(format!("n{i}"));
                    node["kind"] = json!(if i == 0 { "topic" } else { "concept" });
                    nodes.push(node);
                }
                value["diagram"] = json!({"nodes":nodes,"groups":[],"edges":[
                    {"from":"n0","to":"n1","kind":"association","label":""},
                    {"from":"n1","to":"n2","kind":"association","label":""}
                ]});
            } else {
                value["items"] = json!(fields);
            }
            let plan: Composition = serde_json::from_value(value).unwrap();
            let batch =
                crate::compose(&Scene::default(), "board", 0, "works", &plan, None).unwrap();
            let scene = crate::apply(&Scene::default(), &batch, None).unwrap();
            let text: Vec<_> = scene
                .elements
                .iter()
                .filter(|el| el["type"] == "text")
                .map(|el| el["originalText"].as_str().unwrap())
                .collect();
            assert_eq!(text, ["讨论", "概念讲解", "仅说明"]);
            if layout == "mindmap" {
                let card = scene
                    .elements
                    .iter()
                    .find(|el| el["id"] == "works-node-1")
                    .unwrap();
                let desc = scene
                    .elements
                    .iter()
                    .find(|el| el["id"] == "works-text-1")
                    .unwrap();
                assert_eq!(card["boundElements"].as_array().unwrap().len(), 2);
                assert!(
                    (desc["y"].as_f64().unwrap() + desc["height"].as_f64().unwrap() / 2.0
                        - card["y"].as_f64().unwrap()
                        - card["height"].as_f64().unwrap() / 2.0)
                        .abs()
                        < 0.01
                );
            }
        }
        let public = crate::composition_schema();
        let strict = crate::structured_composition_schema();
        let path = "/properties/diagram/anyOf/0/properties/nodes/items/required";
        assert!(!public
            .pointer(path)
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&json!("title")));
        assert!(strict
            .pointer(path)
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&json!("body")));
    }
    #[test]
    fn all_diagram_modes_render_real_nodes_edges_and_preserve_prior_content() {
        for (name, value) in fixtures().as_object().unwrap() {
            let plan: Composition = serde_json::from_value(value.clone()).unwrap();
            let mut scene = Scene::default();
            scene.elements.push(json!({"id":"human","type":"rectangle","x":-40,"y":-50,"width":240,"height":100,"locked":true,"customData":{"mine":true}}));
            let batch = crate::compose(&scene, "board", 1, name, &plan, None)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let result = crate::apply(&scene, &batch, None).unwrap();
            assert_eq!(scene.elements[0], result.elements[0]);
            assert_eq!(
                result
                    .elements
                    .iter()
                    .filter(|e| e["customData"]["officeDiagram"]["nodeId"].is_string())
                    .count(),
                plan.diagram.as_ref().unwrap().nodes.len()
            );
            assert_eq!(
                result
                    .elements
                    .iter()
                    .filter(|e| e["type"] == "arrow")
                    .count(),
                plan.diagram.as_ref().unwrap().edges.len()
            );
            assert!(batch.vacant_regions[0].x >= 280.0);
            let boxes: Vec<_> = result
                .elements
                .iter()
                .filter(|e| e["customData"]["officeDiagram"]["nodeId"].is_string())
                .map(|e| Region::of(e).unwrap())
                .collect();
            for (i, a) in boxes.iter().enumerate() {
                for b in boxes.iter().skip(i + 1) {
                    assert!(!a.intersects(b), "overlap in {name}");
                }
            }
            for edge in result.elements.iter().filter(|e| e["type"] == "arrow") {
                assert_eq!(edge["elbowed"], true);
                assert_eq!(edge["roughness"], 0);
                assert!(edge["startBinding"]["fixedPoint"].is_array());
                assert!(edge["endBinding"]["fixedPoint"].is_array());
            }
            let roundtrip: Batch =
                serde_json::from_slice(&serde_json::to_vec(&batch).unwrap()).unwrap();
            assert!(serde_json::to_vec(&roundtrip).unwrap() == serde_json::to_vec(&batch).unwrap());
        }
    }
    #[test]
    fn graph_ids_cycles_and_teaching_structure_are_validated_before_append() {
        let mut graph: Diagram =
            serde_json::from_value(fixtures()["mindmap"]["diagram"].clone()).unwrap();
        graph.edges.push(DiagramEdge {
            from: "root".into(),
            to: "missing".into(),
            label: String::new(),
            kind: EdgeKind::Association,
        });
        assert!(validate(&graph, Layout::Mindmap).is_err());
        graph.edges.pop();
        graph.edges[0].to = "root".into();
        assert!(validate(&graph, Layout::Mindmap).is_err());
        let mut lesson: Composition = serde_json::from_value(fixtures()["lesson"].clone()).unwrap();
        lesson
            .diagram
            .as_mut()
            .unwrap()
            .nodes
            .retain(|n| n.kind != NodeKind::Question);
        assert!(crate::compose(&Scene::default(), "board", 0, "lesson", &lesson, None).is_err());
        let mut bad = fixtures()["architecture"].clone();
        bad["diagram"]["nodes"][0]["x"] = json!(999);
        assert!(serde_json::from_value::<Composition>(bad).is_err());
    }
    #[test]
    fn feedback_edges_use_free_space_and_cannot_hide_outside_declared_bounds() {
        let mut plan: Composition =
            serde_json::from_value(fixtures()["flowchart"].clone()).unwrap();
        plan.diagram.as_mut().unwrap().edges.push(DiagramEdge {
            from: "no".into(),
            to: "check".into(),
            label: "再次提交".into(),
            kind: EdgeKind::Arrow,
        });
        let batch = crate::compose(&Scene::default(), "board", 0, "feedback", &plan, None).unwrap();
        let scene = crate::apply(&Scene::default(), &batch, None).unwrap();
        for edge in scene.elements.iter().filter(|e| e["type"] == "arrow") {
            let obstacles: Vec<_> = scene
                .elements
                .iter()
                .filter(|e| {
                    e["customData"]["officeDiagram"]["nodeId"].is_string()
                        && e["id"] != edge["startBinding"]["elementId"]
                        && e["id"] != edge["endBinding"]["elementId"]
                })
                .filter_map(Region::of)
                .collect();
            let points: Vec<_> = edge["points"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    (
                        edge["x"].as_f64().unwrap() + p[0].as_f64().unwrap(),
                        edge["y"].as_f64().unwrap() + p[1].as_f64().unwrap(),
                    )
                })
                .collect();
            for line in points.windows(2) {
                assert!(crate::diagram_routing::clear(line[0], line[1], &obstacles));
            }
        }
        let bounds=Region::of(&json!({"type":"arrow","x":10,"y":10,"width":1,"height":1,"points":[[0,0],[-900,300],[80,0]]})).unwrap();
        assert_eq!(bounds.x, -890.0);
        assert_eq!(bounds.width, 980.0);
    }
    #[test]
    fn mixed_diagram_teams_commit_together_and_respect_whitespace() {
        let plans: Vec<Composition> = fixtures()
            .as_object()
            .unwrap()
            .values()
            .map(|v| serde_json::from_value(v.clone()).unwrap())
            .collect();
        let batch =
            crate::compose_sections(&Scene::default(), "board", 0, "team", &plans, None).unwrap();
        assert!(crate::apply(&Scene::default(), &batch, None).is_ok());
        let mut changed = Scene::default();
        changed.elements.push(json!({"id":"human","type":"rectangle","x":batch.vacant_regions[0].x+1.0,"y":batch.vacant_regions[0].y+1.0,"width":20,"height":20}));
        assert!(matches!(
            crate::apply(&changed, &batch, None),
            Err(CanvasError::Conflict(_))
        ));
    }
}
