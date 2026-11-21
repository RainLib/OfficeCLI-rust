//! DrawingML group coordinates and stable targets shared by import, patches and export.
use crate::HcdError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

const EMU_PER_PX: f64 = 9525.0;
const MAX_COORDINATE: i64 = 1_000_000_000;
const FULL_TURN: i64 = 21_600_000;
pub const TRANSFORM_ATTRIBUTE: &str = "data-hcd-pptx-transform";
pub const EDITED_ATTRIBUTE: &str = "data-hcd-pptx-transform-edited";
pub const GROUP_CLASS: &str = "hcd-slide-group";
pub const GROUP_SOURCE: &str = "data-hcd-pptx-group-id";
pub const GROUP_COMPLETE: &str = "data-hcd-pptx-group-complete";
pub const GROUP_CAN_UNGROUP: &str = "data-hcd-pptx-can-ungroup";

pub fn group_opening(
    id: &str,
    native_id: Option<u32>,
    name: &str,
    transform: DrawingTransform,
    complete: bool,
    can_ungroup: bool,
) -> Result<String, HcdError> {
    let native = native_id
        .map(|id| format!(" {GROUP_SOURCE}=\"{id}\""))
        .unwrap_or_default();
    let name = crate::html::escape_attribute(name);
    let label = if name.is_empty() { "组合" } else { &name };
    Ok(format!("<div class=\"{GROUP_CLASS}\" data-hcd-id=\"{id}\"{native} data-hcd-shape-name=\"{label}\" {GROUP_COMPLETE}=\"{}\" {GROUP_CAN_UNGROUP}=\"{}\" {TRANSFORM_ATTRIBUTE}=\"{}\" style=\"{}\">", u8::from(complete), u8::from(can_ungroup), transform.encode()?, transform.group_css()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawingRect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl DrawingRect {
    pub fn valid(self) -> bool {
        (-MAX_COORDINATE..=MAX_COORDINATE).contains(&self.x)
            && (-MAX_COORDINATE..=MAX_COORDINATE).contains(&self.y)
            && (1..=MAX_COORDINATE).contains(&self.width)
            && (1..=MAX_COORDINATE).contains(&self.height)
    }

    pub fn enclosing(frames: impl IntoIterator<Item = Self>) -> Option<Self> {
        frames.into_iter().reduce(|left, right| {
            let x = left.x.min(right.x);
            let y = left.y.min(right.y);
            Self {
                x,
                y,
                width: (left.x + left.width).max(right.x + right.width) - x,
                height: (left.y + left.height).max(right.y + right.height) - y,
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawingTransform {
    pub frame: DrawingRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<DrawingRect>,
    #[serde(default)]
    pub rotation: i64,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
}

impl DrawingTransform {
    pub fn identity_group(frame: DrawingRect) -> Self {
        Self {
            children: Some(frame),
            ..Self::object(frame)
        }
    }

    pub fn object(frame: DrawingRect) -> Self {
        Self {
            frame,
            children: None,
            rotation: 0,
            flip_h: false,
            flip_v: false,
        }
    }

    pub fn valid(self) -> bool {
        self.frame.valid()
            && self.children.is_none_or(DrawingRect::valid)
            && (-FULL_TURN..=FULL_TURN).contains(&self.rotation)
    }

    pub fn encode(self) -> Result<String, HcdError> {
        if !self.valid() {
            return Err(HcdError::InvalidBundle(
                "invalid slide drawing transform".into(),
            ));
        }
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&self)?))
    }

    pub fn decode(encoded: &str) -> Result<Self, HcdError> {
        if encoded.len() > 1024 {
            return Err(HcdError::InvalidBundle(
                "slide drawing transform is too large".into(),
            ));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| HcdError::InvalidBundle("invalid slide drawing transform".into()))?;
        let transform: Self = serde_json::from_slice(&bytes)?;
        if !transform.valid() {
            return Err(HcdError::InvalidBundle(
                "invalid slide drawing transform".into(),
            ));
        }
        Ok(transform)
    }

    /// CSS maps the intact child coordinate space to the parent about the group center.
    pub fn group_css(self) -> String {
        let [a, b, c, d, tx, ty] = self.group_matrix();
        format!("position:absolute;left:0;top:0;transform-origin:top left;transform:matrix({a:.9},{b:.9},{c:.9},{d:.9},{:.8},{:.8})", tx / EMU_PER_PX, ty / EMU_PER_PX)
    }

    pub fn object_css(self) -> String {
        let [a, b, c, d] = self.orientation();
        format!("matrix({a:.9},{b:.9},{c:.9},{d:.9},0,0)")
    }

    pub fn bounds(self) -> DrawingRect {
        let [a, b, c, d] = self.orientation();
        let width =
            (a.abs() * self.frame.width as f64 + c.abs() * self.frame.height as f64).ceil() as i64;
        let height =
            (b.abs() * self.frame.width as f64 + d.abs() * self.frame.height as f64).ceil() as i64;
        DrawingRect {
            x: self.frame.x + (self.frame.width - width).div_euclid(2),
            y: self.frame.y + (self.frame.height - height).div_euclid(2),
            width,
            height,
        }
    }

    /// Lift a direct child out of its parent. A native single transform cannot encode shear.
    pub fn promoted(self, parent: Self) -> Result<Self, HcdError> {
        let [a, b, c, d, tx, ty] = parent.group_matrix();
        if [a, b, c, d] == [1.0, 0.0, 0.0, 1.0] {
            let mut promoted = self;
            promoted.frame.x += tx.round() as i64;
            promoted.frame.y += ty.round() as i64;
            return checked_promotion(promoted);
        }
        let [e, f, g, h] = self.orientation();
        let first = [a * e + c * f, b * e + d * f];
        let second = [a * g + c * h, b * g + d * h];
        let width_scale = first[0].hypot(first[1]);
        let height_scale = second[0].hypot(second[1]);
        let dot = first[0] * second[0] + first[1] * second[1];
        if dot.abs() > 1e-7 * width_scale * height_scale {
            return Err(HcdError::Unsupported(
                "this scaled and rotated group cannot be split without skewing its objects".into(),
            ));
        }
        let (cx, cy) = self.center();
        let width = (self.frame.width as f64 * width_scale).round() as i64;
        let height = (self.frame.height as f64 * height_scale).round() as i64;
        let determinant = first[0] * second[1] - first[1] * second[0];
        checked_promotion(Self {
            frame: DrawingRect {
                x: (a * cx + c * cy + tx - width as f64 / 2.0).round() as i64,
                y: (b * cx + d * cy + ty - height as f64 / 2.0).round() as i64,
                width,
                height,
            },
            rotation: (first[1].atan2(first[0]).to_degrees() * 60_000.0).round() as i64,
            flip_h: false,
            flip_v: determinant < 0.0,
            ..self
        })
    }

    fn center(self) -> (f64, f64) {
        (
            self.frame.x as f64 + self.frame.width as f64 / 2.0,
            self.frame.y as f64 + self.frame.height as f64 / 2.0,
        )
    }

    fn orientation(self) -> [f64; 4] {
        let (sin, cos) = (self.rotation.rem_euclid(FULL_TURN) as f64 / 60_000.0)
            .to_radians()
            .sin_cos();
        let h = if self.flip_h { -1.0 } else { 1.0 };
        let v = if self.flip_v { -1.0 } else { 1.0 };
        [h * cos, h * sin, -v * sin, v * cos]
    }

    fn group_matrix(self) -> [f64; 6] {
        let child = self.children.unwrap_or(self.frame);
        let sx = self.frame.width as f64 / child.width as f64;
        let sy = self.frame.height as f64 / child.height as f64;
        let [a, b, c, d] = self.orientation();
        let (a, b, c, d) = (a * sx, b * sx, c * sy, d * sy);
        let (x, y) = Self::object(child).center();
        let (cx, cy) = self.center();
        [a, b, c, d, cx - a * x - c * y, cy - b * x - d * y]
    }
}

fn checked_promotion(transform: DrawingTransform) -> Result<DrawingTransform, HcdError> {
    if !transform.valid() {
        return Err(HcdError::InvalidPatch(
            "ungrouped object exceeds DrawingML bounds".into(),
        ));
    }
    Ok(transform)
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ObjectLocator {
    Native(u32),
    Created(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum GroupEdit {
    Create {
        id: String,
        members: Vec<ObjectLocator>,
        transform: DrawingTransform,
    },
    Ungroup {
        group: ObjectLocator,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlideGroupEdit {
    pub slide_part: String,
    pub edit: GroupEdit,
}
