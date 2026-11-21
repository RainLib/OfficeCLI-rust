//! AI-selected paper, brush and sticker grammar. All decoration stays native,
//! bounded and exportable; motion metadata is interpreted only by the viewer.
use crate::{
    composition::{shape, vacant},
    Batch, CanvasError, Composition, Operation, Region, Scene, PROTOCOL,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

mod brushes;

static STICKERS: LazyLock<Value> = LazyLock::new(|| {
    let mut originals: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("../assets/stickers.json"))
            .expect("bundled sticker catalog");
    let packs: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("../assets/fluent-stickers.json"))
            .expect("bundled Fluent Emoji shapes");
    originals.extend(packs);
    Value::Object(originals)
});

macro_rules! choice {
    ($name:ident {$($variant:ident),*}) => {
        #[derive(Clone, Copy, Debug, Serialize, Deserialize)]
        #[serde(rename_all="camelCase")]
        pub enum $name {$($variant),*}
        impl $name {
            const ALL: &'static [Self] = &[$(Self::$variant),*];
        }
    };
}
choice!(VisualStyle { Journal, Studio });
choice!(Palette {
    Apricot,
    Meadow,
    Lavender,
    Ocean
});
choice!(Paper { Plain, Ruled, Dot });
choice!(Brush {
    Ink,
    Pencil,
    Marker,
    Watercolor,
    Fountain,
    Pastel
});
choice!(Motif {
    Flower,
    Mascot,
    Spark,
    Leaf,
    Heart,
    Tape,
    Book,
    Petals,
    Butterfly,
    PaperPlane,
    Firefly,
    PeelDot,
    MoonPal,
    StarPal,
    FluentOkHand,
    FluentClappingHands,
    FluentRaisingHands,
    FluentWavingHand,
    FluentEyes,
    FluentSparklingHeart,
    FluentPartyPopper,
    FluentTrophy,
    FluentLightBulb,
    FluentBrain,
    FluentThoughtBalloon,
    FluentPuzzlePiece,
    FluentMagnet,
    FluentArtistPalette,
    FluentPaintbrush,
    FluentCrystalBall,
    FluentRoundPushpin,
    FluentMemo,
    FluentSpiralCalendar,
    FluentHourglassNotDone,
    FluentCheckMarkButton,
    FluentBell,
    FluentHotBeverage,
    FluentBarChart,
    FluentMicroscope,
    FluentTelescope,
    FluentBooks,
    FluentGlobeShowingAsiaAustralia,
    FluentTestTube,
    FluentAtomSymbol,
    FluentAbacus,
    FluentMusicalNotes,
    FluentSeedling,
    FluentSunflower,
    FluentRainbow,
    FluentCloudWithRain,
    FluentSnowCappedMountain,
    FluentCactus,
    FluentFourLeafClover,
    FluentButterfly,
    FluentFox,
    FluentPenguin,
    FluentSpoutingWhale,
    FluentSloth,
    FluentCatFace,
    FluentPanda,
    FluentRocket,
    FluentCompass
});
choice!(Motion {
    None,
    Float,
    Wiggle,
    Twinkle,
    Auto
});
choice!(StickerPosition { Heading, Footer });
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sticker {
    pub motif: Motif,
    pub motion: Motion,
    pub position: StickerPosition,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualPlan {
    pub style: VisualStyle,
    pub palette: Palette,
    pub paper: Paper,
    pub brush: Brush,
    pub stickers: Vec<Sticker>,
}

pub(crate) fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{
        "style":{"type":"string","enum":VisualStyle::ALL},
        "palette":{"type":"string","enum":Palette::ALL},
        "paper":{"type":"string","enum":Paper::ALL},
        "brush":{"type":"string","enum":Brush::ALL,"description":"Choose the mark to suit the content. Watercolor layers translucent pigment, fountain tapers to a fine nib, pastel leaves a broken wax grain."},
        "stickers":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":false,"properties":{
            "motif":{"type":"string","enum":Motif::ALL,"description":"Use petals for a seasonal observation, butterfly for change or discovery, paperPlane for a journey or a next step. Choose according to meaning."},
            "motion":{"type":"string","enum":Motion::ALL,"description":"Auto plays the motif's own motion, including drifting loose petals, folding wings and a paper plane following its dashed trail. Use none for quiet static accents."},
            "position":{"type":"string","enum":StickerPosition::ALL}
        },"required":["motif","motion","position"]}}
    },"required":["style","palette","paper","brush","stickers"]})
}
fn color(token: &str, palette: Palette) -> &str {
    match token {
        "$accent" => match palette {
            Palette::Apricot => "#D48260",
            Palette::Meadow => "#789A7C",
            Palette::Lavender => "#A18AB7",
            Palette::Ocean => "#6C95AD",
        },
        "$paper" => "#FFFCF4",
        "$ink" => "#484439",
        "$pink" => "#E9A2A6",
        "$yellow" => "#F3CE76",
        "$green" => "#99B79C",
        "$blue" => "#A8C6D5",
        other => other,
    }
}
fn line(
    id: String,
    points: Value,
    position: (f64, f64),
    size: (f64, f64),
    ink: &str,
    stroke: f64,
    group: &str,
) -> Value {
    let mut e = shape(id, "line", position.0, position.1, size.0, size.1, group);
    e["points"] = points;
    e["strokeColor"] = json!(ink);
    e["strokeWidth"] = json!(stroke);
    e["backgroundColor"] = json!("transparent");
    e["roundness"] = Value::Null;
    normalize_line(&mut e);
    e
}

// Native editors normalize the first point to [0,0]. Do this before saving so
// dragging a sticker cannot accidentally apply that origin shift a second time.
fn normalize_line(e: &mut Value) {
    let points = e["points"].as_array().unwrap();
    let ox = points[0][0].as_f64().unwrap();
    let oy = points[0][1].as_f64().unwrap();
    let normalized: Vec<_> = points
        .iter()
        .map(|p| [p[0].as_f64().unwrap() - ox, p[1].as_f64().unwrap() - oy])
        .collect();
    let min_x = normalized
        .iter()
        .map(|p| p[0])
        .fold(f64::INFINITY, f64::min);
    let max_x = normalized
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = normalized
        .iter()
        .map(|p| p[1])
        .fold(f64::INFINITY, f64::min);
    let max_y = normalized
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    e["x"] = json!(e["x"].as_f64().unwrap() + ox);
    e["y"] = json!(e["y"].as_f64().unwrap() + oy);
    e["width"] = json!(max_x - min_x);
    e["height"] = json!(max_y - min_y);
    e["points"] = json!(normalized);
}

pub(crate) fn compose(
    scene: &Scene,
    document: &str,
    revision: u64,
    patch: &str,
    plan: &Composition,
    within: Option<Region>,
) -> Result<Batch, CanvasError> {
    let visual = plan.visual.as_ref().unwrap();
    if visual.stickers.len() > 4
        || visual
            .stickers
            .iter()
            .filter(|s| !matches!(s.motion, Motion::None))
            .count()
            > 2
    {
        return Err(CanvasError::Limit(
            "单个作品最多 4 张贴纸，其中动态贴纸最多 2 张".into(),
        ));
    }
    let mut plain = plan.clone();
    plain.visual = None;
    let measured = crate::compose(&Scene::default(), document, revision, patch, &plain, None)?;
    let source = measured.vacant_regions[0];
    let journal = matches!(visual.style, VisualStyle::Journal);
    let margin = if journal { 48.0 } else { 24.0 };
    let footer = if visual
        .stickers
        .iter()
        .any(|s| matches!(s.position, StickerPosition::Footer))
    {
        100.0
    } else {
        24.0
    };
    let top = if visual
        .stickers
        .iter()
        .any(|s| matches!(s.position, StickerPosition::Heading))
    {
        40.0
    } else {
        24.0
    };
    let width = (source.width + margin * 2.0).max(580.0);
    let height = source.height + margin * 2.0 + top + footer;
    let area = vacant(scene, width, height, within)?;
    let mut elements = vec![];
    if journal {
        let mut shadow = shape(
            format!("{patch}-paper-shadow"),
            "rectangle",
            area.x + 8.0,
            area.y + 10.0,
            width - 8.0,
            height - 10.0,
            patch,
        );
        shadow["backgroundColor"] = json!("#D9D2C5");
        shadow["strokeWidth"] = json!(0);
        shadow["opacity"] = json!(24);
        elements.push(shadow);
        let mut paper = shape(
            format!("{patch}-paper"),
            "rectangle",
            area.x,
            area.y,
            width - 8.0,
            height - 10.0,
            patch,
        );
        paper["backgroundColor"] = json!("#FFFCF4");
        paper["strokeColor"] = json!("#DED5C3");
        paper["customData"]["officeJournal"] = serde_json::to_value(visual)?;
        elements.push(paper);
        if matches!(visual.paper, Paper::Ruled) {
            for i in 0..((height - 80.0) / 32.0).floor().min(48.0) as usize {
                elements.push(line(
                    format!("{patch}-ruling-{i}"),
                    json!([[0, 0], [width - 68.0, 0]]),
                    (area.x + 30.0, area.y + 60.0 + i as f64 * 32.0),
                    (width - 68.0, 0.0),
                    "#E9E0CE",
                    0.6,
                    patch,
                ));
            }
        } else if matches!(visual.paper, Paper::Dot) {
            // Light dots only in the margins leave the content easy to scan.
            for i in 0..((height - 64.0) / 28.0).floor().min(42.0) as usize {
                for side in [0, 1] {
                    let mut dot = shape(
                        format!("{patch}-dot-{i}-{side}"),
                        "ellipse",
                        area.x + if side == 0 { 22.0 } else { width - 32.0 },
                        area.y + 32.0 + i as f64 * 28.0,
                        2.0,
                        2.0,
                        patch,
                    );
                    dot["backgroundColor"] = json!("#CEBEA6");
                    dot["strokeWidth"] = json!(0);
                    elements.push(dot);
                }
            }
        }
        elements.push(line(
            format!("{patch}-margin"),
            json!([[0, 0], [0, height - 70.0]]),
            (area.x + 34.0, area.y + 30.0),
            (0.0, height - 70.0),
            "#E8C1B0",
            0.8,
            patch,
        ));
    }
    let mut content = vec![];
    for op in measured.operations {
        if let Operation::Add { mut element } = op {
            element["x"] = json!(element["x"].as_f64().unwrap() + area.x + margin - source.x);
            element["y"] = json!(element["y"].as_f64().unwrap() + area.y + margin + top - source.y);
            if element["id"] == format!("{patch}-heading") {
                let brush = serde_json::to_value(visual.brush)?;
                element["customData"]["officeMaterial"] =
                    crate::materials::reference(brush.as_str().unwrap());
                element["customData"]["officeVisual"] = serde_json::to_value(visual)?;
                let r = Region::of(&element).unwrap();
                if let Some(art) = brushes::art(visual.brush) {
                    elements.extend(art.heading_marks(&mut element, visual, patch));
                } else if !matches!(visual.brush, Brush::Ink) {
                    let mut swash = line(
                        format!("{patch}-highlight"),
                        json!([
                            [0, 7],
                            [r.width.min(360.0) * 0.48, 0],
                            [r.width.min(360.0), 4]
                        ]),
                        (r.x - 4.0, r.y + r.height - 9.0),
                        (r.width.min(360.0), 7.0),
                        color("$accent", visual.palette),
                        if matches!(visual.brush, Brush::Marker) {
                            19.0
                        } else {
                            3.0
                        },
                        patch,
                    );
                    swash["opacity"] = json!(if matches!(visual.brush, Brush::Marker) {
                        28
                    } else {
                        70
                    });
                    swash["roughness"] = json!(1);
                    elements.push(swash);
                }
            }
            if journal
                && element["id"]
                    .as_str()
                    .is_some_and(|id| id.ends_with("-body"))
            {
                let original = element["backgroundColor"].as_str().unwrap_or("");
                element["backgroundColor"] = json!(if original == "#FFFFFF" {
                    "#FFFEFA"
                } else {
                    match (visual.palette, original == "#EDF0E6") {
                        (Palette::Apricot, true) => "#EFF3E5",
                        (Palette::Apricot, false) => "#F8E6D6",
                        (Palette::Meadow, true) => "#E7EEDC",
                        (Palette::Meadow, false) => "#F8EEDA",
                        (Palette::Lavender, true) => "#F0E8F4",
                        (Palette::Lavender, false) => "#F8E7DF",
                        (Palette::Ocean, true) => "#E5EFF2",
                        (Palette::Ocean, false) => "#F2EED9",
                    }
                });
                element["strokeColor"] = json!("#D4C9B6");
            }
            if !matches!(visual.brush, Brush::Ink)
                && matches!(
                    element["type"].as_str(),
                    Some("rectangle" | "diamond" | "ellipse")
                )
            {
                element["roughness"] = json!(match visual.brush {
                    Brush::Pencil | Brush::Pastel => 0.7,
                    Brush::Fountain | Brush::Ink => 0.0,
                    Brush::Marker | Brush::Watercolor => 0.3,
                });
            }
            content.push(element);
        }
    }
    elements.extend(content);
    let mut heading = 0;
    let mut bottom = 0;
    for (i, sticker) in visual.stickers.iter().enumerate() {
        let id = format!("{patch}-sticker-{i}");
        let x;
        let y;
        if matches!(sticker.position, StickerPosition::Heading) {
            x = area.x + width - 100.0 - heading as f64 * 82.0;
            y = area.y + 30.0;
            heading += 1;
        } else {
            x = area.x + width - 100.0 - bottom as f64 * 82.0;
            y = area.y + height - 92.0;
            bottom += 1;
        }
        elements.extend(sticker_shapes(&id, x, y, sticker, visual.palette)?);
    }
    let batch = Batch {
        schema_version: PROTOCOL.into(),
        document_id: document.into(),
        patch_id: patch.into(),
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

pub(crate) fn sticker_shapes(
    id: &str,
    x: f64,
    y: f64,
    sticker: &Sticker,
    palette: Palette,
) -> Result<Vec<Value>, CanvasError> {
    let mut elements = Vec::new();
    let mut anchor = shape(id.to_string(), "rectangle", x, y, 64.0, 64.0, id);
    anchor["strokeWidth"] = json!(0);
    anchor["strokeColor"] = json!("transparent");
    anchor["backgroundColor"] = json!("transparent");
    anchor["customData"]["officeSticker"] =
        json!({"version":1,"motif":sticker.motif,"motion":sticker.motion,"palette":palette});
    let motif = serde_json::to_value(sticker.motif)?;
    anchor["customData"]["officeMaterial"] = crate::materials::reference(motif.as_str().unwrap());
    elements.push(anchor);
    for (j, p) in STICKERS[motif.as_str().unwrap()]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut part = shape(
            format!("{id}-part-{j}"),
            p["type"].as_str().unwrap(),
            x + p["x"].as_f64().unwrap(),
            y + p["y"].as_f64().unwrap(),
            p["width"].as_f64().unwrap(),
            p["height"].as_f64().unwrap(),
            id,
        );
        part["backgroundColor"] =
            json!(color(p["fill"].as_str().unwrap(), palette).replace("none", "transparent"));
        part["strokeColor"] =
            json!(color(p["stroke"].as_str().unwrap(), palette).replace("none", "transparent"));
        part["strokeWidth"] = p["strokeWidth"].clone();
        if let Some(style) = p["strokeStyle"].as_str() {
            part["strokeStyle"] = json!(style);
        }
        part["angle"] = json!(p["angle"].as_f64().unwrap_or(0.0));
        if p["type"] == "line" {
            part["points"] = p["points"].clone();
            part["roundness"] = Value::Null;
            normalize_line(&mut part);
        }
        part["customData"]["officeStickerPart"] = json!({"anchor":id,"motion":sticker.motion});
        if let Some(layer) = p["layer"].as_str() {
            part["customData"]["officeStickerPart"]["layer"] = json!(layer);
        }
        elements.push(part);
    }
    Ok(elements)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_is_native_bounded_exportable_and_never_repositions_prior_content() {
        let mut plan:Composition=serde_json::from_value(json!({"title":"春天的阅读手账","layout":"grid","items":[{"title":"发现","body":"记录一句打动你的话。","kind":"note"}],"visual":{"style":"journal","palette":"apricot","paper":"dot","brush":"marker","stickers":[{"motif":"flower","motion":"float","position":"heading"},{"motif":"mascot","motion":"wiggle","position":"footer"}]}})).unwrap();
        let mut scene = Scene::default();
        scene
            .elements
            .push(json!({"id":"human","type":"rectangle","x":0,"y":0,"width":300,"height":200}));
        let batch = crate::compose(&scene, "board", 0, "journal", &plan, None).unwrap();
        let result = crate::apply(&scene, &batch, None).unwrap();
        assert_eq!(result.elements[0], scene.elements[0]);
        assert_eq!(
            result
                .elements
                .iter()
                .filter(|e| e["customData"]["officeSticker"].is_object())
                .count(),
            2
        );
        assert!(result.elements.iter().any(|e| e["id"] == "journal-paper"));
        assert!(result
            .elements
            .iter()
            .all(|e| e["type"] != "image" && e["type"] != "embeddable"));
        for line in result.elements.iter().filter(|e| e["type"] == "line") {
            assert_eq!(line["points"][0], json!([0.0, 0.0]));
        }
        let encoded = serde_json::to_vec(&batch).unwrap();
        let decoded: Batch = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), encoded);
        assert!(crate::compose(
            &scene,
            "board",
            0,
            "small",
            &plan,
            Some(Region {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0
            })
        )
        .is_err());
        let visual = plan.visual.as_mut().unwrap();
        visual.stickers.push(visual.stickers[0].clone());
        assert!(crate::compose(&scene, "board", 0, "too-many-motion", &plan, None).is_err());
    }
    #[test]
    fn every_sticker_and_palette_and_diagram_style_has_valid_native_geometry() {
        assert_eq!(Motif::ALL.len(), STICKERS.as_object().unwrap().len());
        for &palette in Palette::ALL {
            for &motif in Motif::ALL {
                let mut plan: Composition = serde_json::from_value(
                    serde_json::from_str::<Value>(include_str!("../fixtures/diagrams.json"))
                        .unwrap()["architecture"]
                        .clone(),
                )
                .unwrap();
                plan.visual = Some(VisualPlan {
                    style: VisualStyle::Journal,
                    palette,
                    paper: Paper::Ruled,
                    brush: Brush::Pencil,
                    stickers: vec![Sticker {
                        motif,
                        motion: Motion::Auto,
                        position: StickerPosition::Footer,
                    }],
                });
                let batch =
                    crate::compose(&Scene::default(), "board", 0, "all", &plan, None).unwrap();
                crate::apply(&Scene::default(), &batch, None).unwrap();
            }
        }
    }

    #[test]
    fn illustrated_brushes_scale_to_text_and_keep_editable_layers_inside_the_guard() {
        let brushes: Value = serde_json::from_str(include_str!("../assets/brushes.json")).unwrap();
        for name in brushes.as_object().unwrap().keys() {
            let plan: Composition = serde_json::from_value(json!({
                "title":"花", "layout":"grid", "items":[{"title":"观察","body":"花瓣变化","kind":"note"}],
                "visual":{"style":"journal","palette":"ocean","paper":"plain","brush":name,"stickers":[
                    {"motif":"butterfly","motion":"auto","position":"heading"},
                    {"motif":"paperPlane","motion":"auto","position":"footer"}]}
            })).unwrap();
            let batch = crate::compose(&Scene::default(), "board", 0, "art", &plan, None).unwrap();
            let scene = crate::apply(&Scene::default(), &batch, None).unwrap();
            let heading = scene
                .elements
                .iter()
                .find(|e| e["id"] == "art-heading")
                .unwrap();
            assert_eq!(&heading["customData"]["officeBrush"]["kind"], name);
            let marks: Vec<_> = scene
                .elements
                .iter()
                .filter(|e| e["groupIds"][0] == "art-highlight")
                .collect();
            assert_eq!(
                marks.len(),
                brushes[name]["marks"].as_array().unwrap().len()
            );
            for mark in marks {
                assert_eq!(mark["type"], "line");
                assert_eq!(mark["points"][0], json!([0.0, 0.0]));
                let r = Region::of(mark).unwrap();
                assert!(r.width <= 30.0 && r.width > 0.0);
                assert!(batch.vacant_regions[0].contains(&r));
            }
            for layer in ["wing-left", "wing-right", "trail", "plane"] {
                assert!(scene
                    .elements
                    .iter()
                    .any(|e| e["customData"]["officeStickerPart"]["layer"] == layer));
            }
            let saved: Scene =
                serde_json::from_slice(&serde_json::to_vec(&scene).unwrap()).unwrap();
            assert_eq!(saved.elements, scene.elements);
        }
    }
}
