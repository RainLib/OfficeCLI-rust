use crate::common::attribute;
use hcd_core::{
    pptx_group::{group_opening, DrawingRect, DrawingTransform, GROUP_CAN_UNGROUP, GROUP_COMPLETE},
    stable_node_id, HcdError,
};
use quick_xml::events::BytesStart;

#[derive(Default)]
pub(super) struct GroupImport {
    stack: Vec<SourceGroup>,
}

#[derive(Default)]
struct SourceGroup {
    depth: usize,
    id: Option<u32>,
    name: String,
    off: Option<(i64, i64)>,
    ext: Option<(i64, i64)>,
    child_off: Option<(i64, i64)>,
    child_ext: Option<(i64, i64)>,
    rotation: i64,
    flip_h: bool,
    flip_v: bool,
    contains_opaque: bool,
    split: bool,
    open_at: Option<usize>,
}

impl SourceGroup {
    fn transform(&self) -> Option<DrawingTransform> {
        let (x, y) = self.off?;
        let (width, height) = self.ext?;
        let (child_x, child_y) = self.child_off.unwrap_or((x, y));
        let (child_width, child_height) = self.child_ext.unwrap_or((width, height));
        let dual_axis = |inner, outer| if inner == 0 { outer } else { inner };
        let transform = DrawingTransform {
            frame: DrawingRect {
                x,
                y,
                width,
                height,
            },
            children: Some(DrawingRect {
                x: child_x,
                y: child_y,
                width: dual_axis(child_width, width),
                height: dual_axis(child_height, height),
            }),
            rotation: self.rotation,
            flip_h: self.flip_h,
            flip_v: self.flip_v,
        };
        transform.valid().then_some(transform)
    }

    fn close(&mut self, html: &mut String) {
        let Some(offset) = self.open_at.take() else {
            return;
        };
        if self.split {
            clear_flag(html, offset, GROUP_COMPLETE);
        }
        if self.split || self.contains_opaque {
            clear_flag(html, offset, GROUP_CAN_UNGROUP);
        }
        html.push_str("</div>");
    }
}

impl GroupImport {
    pub(super) fn start(&mut self, element: &BytesStart<'_>, name: &str, depth: usize) {
        self.observe(element, name, depth);
        if name == "grpSp" {
            self.stack.push(SourceGroup {
                depth,
                ..Default::default()
            });
        }
    }

    pub(super) fn observe(&mut self, element: &BytesStart<'_>, name: &str, depth: usize) {
        let Some(group) = self.stack.last_mut() else {
            return;
        };
        let number = |name| attribute(element, name).and_then(|value| value.parse::<i64>().ok());
        let pair = |x, y| number(x).zip(number(y));
        match (depth.saturating_sub(group.depth), name) {
            (1, "sp" | "pic" | "grpSp" | "nvGrpSpPr" | "grpSpPr" | "extLst") => {}
            (1, _) => group.contains_opaque = true,
            (2, "cNvPr") => {
                group.id = attribute(element, "id")
                    .and_then(|value| value.parse().ok())
                    .filter(|id| *id != 0);
                group.name = attribute(element, "name")
                    .unwrap_or_default()
                    .chars()
                    .take(192)
                    .collect();
            }
            (2, "xfrm") => {
                group.rotation = number("rot").unwrap_or_default();
                (group.flip_h, group.flip_v) = flips(element);
            }
            (
                2,
                "solidFill" | "gradFill" | "blipFill" | "pattFill" | "effectLst" | "effectDag"
                | "scene3d",
            ) => group.contains_opaque = true,
            (3, "off") => group.off = pair("x", "y"),
            (3, "ext") => group.ext = pair("cx", "cy"),
            (3, "chOff") => group.child_off = pair("x", "y"),
            (3, "chExt") => group.child_ext = pair("cx", "cy"),
            _ => {}
        }
    }

    pub(super) fn end(&mut self, html: &mut String, depth: usize) {
        if self.stack.last().is_none_or(|group| group.depth != depth) {
            return;
        }
        if let Some(mut group) = self.stack.pop() {
            if group.open_at.is_none() && !group.split {
                self.opaque();
            }
            group.close(html);
        }
    }

    pub(super) fn opaque(&mut self) {
        if let Some(group) = self.stack.last_mut() {
            group.contains_opaque = true;
        }
    }

    pub(super) fn is_open(&self) -> bool {
        self.stack.iter().any(|group| group.open_at.is_some())
    }

    pub(super) fn pending_overhead(&self) -> usize {
        self.stack
            .iter()
            .map(|group| {
                if group.open_at.is_some() {
                    6
                } else {
                    1024 + group.name.len() * 6
                }
            })
            .sum()
    }

    pub(super) fn open(
        &mut self,
        html: &mut String,
        document_id: &str,
        part: &str,
    ) -> Result<(), HcdError> {
        for (depth, group) in self.stack.iter_mut().enumerate() {
            if group.open_at.is_some() {
                continue;
            }
            let (Some(id), Some(transform)) = (group.id, group.transform()) else {
                continue;
            };
            let node_id = stable_node_id(&[document_id, part, "native-group", &id.to_string()]);
            let mut opening = group_opening(
                &node_id,
                Some(id),
                &group.name,
                transform,
                !group.split,
                !group.contains_opaque && !group.split,
            )?;
            if depth > 0 {
                opening.insert_str(opening.len() - 1, " data-hcd-pptx-grouped=\"true\"");
            }
            group.open_at = Some(html.len());
            html.push_str(&opening);
        }
        Ok(())
    }

    pub(super) fn split(&mut self, html: &mut String) {
        for group in self.stack.iter_mut().rev() {
            if group.open_at.is_some() {
                group.split = true;
                group.close(html);
            }
        }
    }
}

fn clear_flag(html: &mut String, offset: usize, name: &str) {
    let marker = format!(" {name}=\"1\"");
    let Some(end) = html[offset..].find('>') else {
        return;
    };
    if let Some(start) = html[offset..offset + end].find(&marker) {
        let value = offset + start + marker.len() - 2;
        html.replace_range(value..value + 1, "0");
    }
}

pub(super) fn flips(element: &BytesStart<'_>) -> (bool, bool) {
    let flag =
        |name| attribute(element, name).is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    (flag("flipH"), flag("flipV"))
}
