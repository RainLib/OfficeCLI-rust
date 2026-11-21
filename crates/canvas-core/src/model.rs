use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Native records are retained instead of reducing free drawings and bindings
/// to rectangles. UI state (selection, camera, collaborators) is never stored.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    #[serde(default = "source")]
    pub source: String,
    pub elements: Vec<Value>,
    #[serde(default)]
    pub app_state: Map<String, Value>,
    #[serde(default)]
    pub files: BTreeMap<String, Value>,
}

fn source() -> String {
    "OfficeCLI".into()
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            kind: "excalidraw".into(),
            version: 2,
            source: source(),
            elements: vec![],
            app_state: Map::from_iter([("viewBackgroundColor".into(), Value::from("#ffffff"))]),
            files: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= 200_000_000.0)
            && self.width >= 0.0
            && self.height >= 0.0
    }

    /// Axis-aligned bounds of the rotated native element, in scene coordinates.
    pub fn of(element: &Value) -> Option<Self> {
        let mut x = element["x"].as_f64()?;
        let mut y = element["y"].as_f64()?;
        let mut signed_w = element["width"].as_f64()?;
        let mut signed_h = element["height"].as_f64()?;
        if matches!(
            element["type"].as_str(),
            Some("arrow" | "line" | "freedraw")
        ) {
            if let Some(points) = element["points"].as_array().filter(|p| !p.is_empty()) {
                let mut min_x = f64::INFINITY;
                let mut min_y = f64::INFINITY;
                let mut max_x = f64::NEG_INFINITY;
                let mut max_y = f64::NEG_INFINITY;
                for point in points {
                    let px = point[0].as_f64()?;
                    let py = point[1].as_f64()?;
                    min_x = min_x.min(px);
                    min_y = min_y.min(py);
                    max_x = max_x.max(px);
                    max_y = max_y.max(py);
                }
                x += min_x;
                y += min_y;
                signed_w = max_x - min_x;
                signed_h = max_y - min_y;
            }
        }
        let w = signed_w.abs();
        let h = signed_h.abs();
        let angle = element["angle"].as_f64().unwrap_or(0.0);
        let width = w * angle.cos().abs() + h * angle.sin().abs();
        let height = h * angle.cos().abs() + w * angle.sin().abs();
        Some(Self {
            x: x + signed_w / 2.0 - width / 2.0,
            y: y + signed_h / 2.0 - height / 2.0,
            width,
            height,
        })
    }

    pub fn contains(&self, other: &Self) -> bool {
        other.x >= self.x
            && other.y >= self.y
            && other.x + other.width <= self.x + self.width
            && other.y + other.height <= self.y + self.height
    }

    pub fn intersects(&self, other: &Self) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }
}

/// Fixed at task start. Existing objects outside the selection can be read for
/// context but cannot be changed. New objects must fit inside the selected area.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub element_ids: Vec<String>,
    pub region: Option<Region>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub schema_version: String,
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    pub operations: Vec<Operation>,
    /// Rechecked against the latest scene at commit, including human changes
    /// after layout planning. Guarded batches may only add inside these regions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vacant_regions: Vec<Region>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "element.add")]
    Add { element: Value },
    #[serde(rename = "element.update")]
    Update {
        id: String,
        /// Exact prior values for every changed field; null means absent/null.
        /// A human moving an object can merge with AI changing its colour.
        before: Map<String, Value>,
        changes: Map<String, Value>,
    },
    /// Yjs v1 incremental update for a single native Spec text object.
    #[serde(rename = "spec.update")]
    SpecUpdate { id: String, update: String },
    /// A range in one paragraph of the batch's historical revision, in Unicode scalars.
    #[serde(rename = "spec.splice")]
    SpecSplice {
        id: String,
        block: usize,
        start: usize,
        end: usize,
        expected: String,
        insert: String,
    },
    #[serde(rename = "element.remove")]
    Remove {
        id: String,
        #[serde(rename = "expectedHash")]
        expected_hash: String,
    },
    #[serde(rename = "file.add")]
    File { id: String, file: Value },
    #[serde(rename = "scene.update")]
    Scene {
        before: Map<String, Value>,
        changes: Map<String, Value>,
    },
}

impl Operation {
    pub fn element_id(&self) -> Option<&str> {
        match self {
            Self::Add { element } => element["id"].as_str(),
            Self::Update { id, .. }
            | Self::SpecUpdate { id, .. }
            | Self::SpecSplice { id, .. }
            | Self::Remove { id, .. } => Some(id),
            _ => None,
        }
    }
}
