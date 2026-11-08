use super::*;
use crate::layout::elements::{LayoutNode, LayoutVisitor, TextBlock};
use crate::render::pdf_syntax::format_pdf_number;

#[derive(Debug, Clone, Copy)]
struct ProjectedPoint {
    x: f64,
    y: f64,
}

impl ProjectedPoint {
    const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn in_device_space(self, device: transforms::PdfDeviceSpace) -> Self {
        Self::new(
            f64::from((self.x * PageContentTransform::POINT_TO_DEVICE) as f32),
            f64::from(
                ((device.page_height() - self.y) * PageContentTransform::POINT_TO_DEVICE) as f32,
            ),
        )
    }

    fn quantized(self) -> Self {
        Self::new(f64::from(self.x as f32), f64::from(self.y as f32))
    }
}

fn uses_direct_device_projection(transform: &crate::style::computed::Transform) -> bool {
    let matrix = match transform {
        crate::style::computed::Transform::Matrix3d(matrix)
        | crate::style::computed::Transform::Project3d { matrix, .. } => matrix,
        _ => return false,
    };
    matrix[1] != 0.0 && matrix[4] != 0.0
}

pub(super) fn is_projected_transform(t: &crate::style::computed::Transform) -> bool {
    matches!(
        t,
        crate::style::computed::Transform::Matrix3d(_)
            | crate::style::computed::Transform::Project3d { .. }
    )
}

pub(super) fn projected_solid_children_are_empty(children: &[LayoutNode]) -> bool {
    children.iter().all(|child| {
        #[derive(Default)]
        struct EmptyText(bool);

        impl LayoutVisitor for EmptyText {
            fn visit_text_block(&mut self, element: &TextBlock) {
                self.0 = element.lines.is_empty()
                    && element.paint.background.color.is_none()
                    && !element.paint.background.layers.has_image()
                    && !element.box_model.border.has_any()
                    && element.paint.shadows.is_empty()
                    && element.paint.group.transform.value.is_none()
                    && element.paint.outline.width == 0.0;
            }
        }

        let mut empty = EmptyText::default();
        child.accept(&mut empty);
        empty.0
    })
}

fn project_transform_point(
    t: &crate::style::computed::Transform,
    origin: crate::style::computed::TransformOrigin,
    point: ProjectedPoint,
) -> ProjectedPoint {
    let (matrix, parent_perspective) = match *t {
        crate::style::computed::Transform::Matrix3d(m) => (m, None),
        crate::style::computed::Transform::Project3d {
            matrix,
            perspective,
            perspective_origin,
        } => (matrix, Some((perspective, perspective_origin))),
        _ => return point,
    };
    let lx = point.x - f64::from(origin.x_length);
    let ly = point.y - f64::from(origin.y_length);
    let lz = -f64::from(origin.z_length);
    let tx = matrix[0] * lx + matrix[4] * ly + matrix[8] * lz + matrix[12];
    let ty = matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13];
    let tz = matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14];
    let tw = matrix[3] * lx + matrix[7] * ly + matrix[11] * lz + matrix[15];
    let mut px = if tw != 0.0 { tx / tw } else { tx } + f64::from(origin.x_length);
    let mut py = if tw != 0.0 { ty / tw } else { ty } + f64::from(origin.y_length);
    let pz = if tw != 0.0 { tz / tw } else { tz } + f64::from(origin.z_length);
    if let Some((d, perspective_origin)) = parent_perspective {
        let denom = d - pz;
        if denom != 0.0 {
            let scale = d / denom;
            px = perspective_origin.x + (px - perspective_origin.x) * scale;
            py = perspective_origin.y + (py - perspective_origin.y) * scale;
        }
    }
    ProjectedPoint::new(px, py)
}

fn projected_quad(
    t: &crate::style::computed::Transform,
    origin: crate::style::computed::TransformOrigin,
    box_rect: PdfRect,
    inset: f32,
) -> [ProjectedPoint; 4] {
    let local = [
        ProjectedPoint::new(f64::from(inset), f64::from(inset)),
        ProjectedPoint::new(f64::from(box_rect.width - inset), f64::from(inset)),
        ProjectedPoint::new(
            f64::from(box_rect.width - inset),
            f64::from(box_rect.height - inset),
        ),
        ProjectedPoint::new(f64::from(inset), f64::from(box_rect.height - inset)),
    ];
    local.map(|point| {
        let projected = project_transform_point(t, origin, point);
        ProjectedPoint::new(
            f64::from(box_rect.left) + projected.x,
            f64::from(box_rect.top()) - projected.y,
        )
    })
}

fn projected_quad_path(points: [ProjectedPoint; 4]) -> String {
    let values = points.map(|point| {
        [
            format_pdf_number(point.x as f32),
            format_pdf_number(point.y as f32),
        ]
    });
    format!(
        "{} {} m\n{} {} l\n{} {} l\n{} {} l\n{} {} l\nh\n",
        values[0][0],
        values[0][1],
        values[1][0],
        values[1][1],
        values[2][0],
        values[2][1],
        values[3][0],
        values[3][1],
        values[0][0],
        values[0][1],
    )
}

pub(super) fn render_projected_solid_box(
    content: &mut String,
    page_content: PageContentTransform,
    box_transform: &crate::layout::elements::BoxTransform,
    geometry: PaintBoxGeometry,
    background_color: Option<crate::types::Color>,
    border: &crate::layout::engine::LayoutBorder,
) {
    let Some(t) = box_transform.value.as_ref() else {
        return;
    };
    let reference = geometry.transform_reference(box_transform);
    let local_pivot = reference.local_pivot();
    let origin = crate::style::computed::TransformOrigin {
        x_fraction: 0.0,
        x_length: local_pivot.x,
        y_fraction: 0.0,
        y_length: local_pivot.y,
        z_length: reference.z_origin(),
    };
    let box_rect = reference.border_box();
    let device = page_content
        .device_space()
        .filter(|_| uses_direct_device_projection(t));
    if let Some(device) = device {
        content.push_str("q\n");
        content.push_str(&device.enter_operator());
    }
    let path = |inset| {
        let points = projected_quad(t, origin, box_rect, inset);
        projected_quad_path(device.map_or_else(
            || points.map(ProjectedPoint::quantized),
            |device| points.map(|point| point.in_device_space(device)),
        ))
    };
    if let Some(color) = background_color {
        let (r, g, b) = color.to_f32_rgb();
        content.push_str(&PdfRgb::from((r, g, b)).fill_operator());
        content.push_str(&path(0.0));
        content.push_str("f\n");
    }
    let bw = border
        .top
        .width
        .max(border.right.width)
        .max(border.bottom.width)
        .max(border.left.width);
    if bw > 0.0 {
        let (r, g, b) = border.top.color.to_f32_rgb();
        content.push_str(&PdfRgb::from((r, g, b)).fill_operator());
        content.push_str(&path(0.0));
        content.push_str(&path(bw));
        content.push_str("f*\n");
    }
    if device.is_some() {
        content.push_str("Q\n");
    }
}
