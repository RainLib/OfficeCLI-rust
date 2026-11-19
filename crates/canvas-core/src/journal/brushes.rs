use super::{color, line, Brush, VisualPlan};
use crate::composition::text_advance;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mark {
    stroke: Option<String>,
    fill: Option<String>,
    #[serde(default)]
    stroke_width: f64,
    opacity: u8,
    points: Vec<[f64; 2]>,
}

#[derive(Deserialize)]
pub(super) struct BrushArt {
    color: String,
    marks: Vec<Mark>,
}

static BRUSHES: LazyLock<BTreeMap<String, BrushArt>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../assets/brushes.json")).expect("bundled brush catalog")
});

pub(super) fn art(brush: Brush) -> Option<&'static BrushArt> {
    let key = match brush {
        Brush::Watercolor => "watercolor",
        Brush::Fountain => "fountain",
        Brush::Pastel => "pastel",
        _ => return None,
    };
    Some(&BRUSHES[key])
}

impl BrushArt {
    pub(super) fn heading_marks(
        &self,
        heading: &mut Value,
        plan: &VisualPlan,
        patch: &str,
    ) -> Vec<Value> {
        let size = heading["fontSize"].as_f64().unwrap();
        let last_line = heading["text"]
            .as_str()
            .unwrap()
            .lines()
            .last()
            .unwrap_or("");
        let width = last_line
            .chars()
            .map(|ch| text_advance(ch, size))
            .sum::<f64>()
            .max(14.0)
            .min(heading["width"].as_f64().unwrap())
            .min(440.0);
        let x = heading["x"].as_f64().unwrap() - 2.0;
        let y = heading["y"].as_f64().unwrap() + heading["height"].as_f64().unwrap() - 11.0;
        heading["customData"]["officeBrush"] =
            json!({"kind":plan.brush,"color":color(&self.color, plan.palette)});
        let group = format!("{patch}-highlight");
        self.marks
            .iter()
            .enumerate()
            .map(|(i, mark)| {
                // Catalog x coordinates are percentages of the last printed line.
                // Vertical grain and nib width stay the same size on short headings.
                let points: Vec<_> = mark
                    .points
                    .iter()
                    .map(|[u, v]| [u * width / 100.0, *v])
                    .collect();
                let mut e = line(
                    format!("{group}-{i}"),
                    json!(points),
                    (x, y),
                    (width, 16.0),
                    color(
                        mark.stroke.as_deref().unwrap_or("transparent"),
                        plan.palette,
                    ),
                    mark.stroke_width,
                    &group,
                );
                e["backgroundColor"] = json!(color(
                    mark.fill.as_deref().unwrap_or("transparent"),
                    plan.palette
                ));
                e["opacity"] = json!(mark.opacity);
                e
            })
            .collect()
    }
}
