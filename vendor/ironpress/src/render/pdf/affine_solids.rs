use super::transforms::PdfDeviceSpace;
use super::{
    BackgroundClip, BorderStyle, ImageRef, PaintBoxGeometry, PdfRect, PdfVector, PdfWriter,
};
use crate::layout::elements::{BoxTransform, Container, LayoutElement, LayoutNode, LayoutVisitor};
use crate::layout::engine::LayoutBorder;
use crate::render::pdf_syntax::format_pdf_number_fixed;
use crate::style::computed::{BlendMode, CssAffineMatrix, CssVector, Transform};

const POINTS_PER_CSS_PIXEL: f64 = 0.75;

#[derive(Debug, Clone, Copy)]
struct UniformSolidBorder {
    width: f64,
    color: crate::types::Color,
}

impl UniformSolidBorder {
    fn from_layout(border: &LayoutBorder) -> Option<Option<Self>> {
        if !border.has_visible() {
            return Some(None);
        }
        let first = border.top;
        let matches = |side: &crate::layout::engine::LayoutBorderSide| {
            side.paints()
                && side.style == BorderStyle::Solid
                && side.color.alpha() == 1.0
                && side.width == first.width
                && side.color == first.color
        };
        (first.style == BorderStyle::Solid
            && first.color.alpha() == 1.0
            && [&border.top, &border.right, &border.bottom, &border.left]
                .into_iter()
                .all(matches))
        .then_some(Some(Self {
            width: f64::from(first.width),
            color: first.color,
        }))
    }
}

#[derive(Debug, Clone, Copy)]
struct AffineSolidBox {
    rect: PdfRect,
    origin: PdfVector,
    transform_size: PdfVector,
    background: Option<crate::types::Color>,
    border: Option<UniformSolidBorder>,
}

impl AffineSolidBox {
    fn from_layout(
        rect: PdfRect,
        origin: PdfVector,
        transform_size: PdfVector,
        background: Option<crate::types::Color>,
        border: &LayoutBorder,
    ) -> Option<Self> {
        let background = match background {
            Some(color) if color.alpha() == 1.0 => Some(color),
            Some(_) => return None,
            None => None,
        };
        Some(Self {
            rect,
            origin,
            transform_size,
            background,
            border: UniformSolidBorder::from_layout(border)?,
        })
    }

    fn css_size(self) -> CssVector {
        CssVector::new(
            f64::from(self.rect.width) / POINTS_PER_CSS_PIXEL,
            f64::from(self.rect.height) / POINTS_PER_CSS_PIXEL,
        )
    }

    fn device_matrix(self, transform: &Transform, device: PdfDeviceSpace) -> CssAffineMatrix {
        let [a, b, c, d, e, f] = transform
            .to_css_matrix(CssVector::new(
                f64::from(self.transform_size.x),
                f64::from(self.transform_size.y),
            ))
            .components();
        let layout_origin = CssVector::new(
            f64::from(self.rect.left),
            device.page_height() - f64::from(self.rect.top()),
        );
        let origin = CssVector::new(f64::from(self.origin.x), f64::from(self.origin.y));
        let point_translation = CssVector::new(
            layout_origin.x + origin.x + e - a * origin.x - c * origin.y,
            layout_origin.y + origin.y + f - b * origin.x - d * origin.y,
        );
        let matrix = CssAffineMatrix::from_components(
            a * PdfDeviceSpace::CSS_TO_DEVICE,
            b * PdfDeviceSpace::CSS_TO_DEVICE,
            c * PdfDeviceSpace::CSS_TO_DEVICE,
            d * PdfDeviceSpace::CSS_TO_DEVICE,
            point_translation.x * super::PageContentTransform::POINT_TO_DEVICE,
            point_translation.y * super::PageContentTransform::POINT_TO_DEVICE,
        );
        match transform {
            // Blink retains semantic rotate operations until the final Skia
            // device matrix, whose six scalar slots are f32.
            Transform::Rotate(angle) if *angle < 0.0 => quantize_matrix(matrix),
            // Skew translation is resolved in layout-point storage before the
            // point->device stage, while its linear axes enter Skia directly.
            Transform::Skew(angles) => {
                let point_to_device = super::PageContentTransform::POINT_TO_DEVICE as f32;
                let quantized = quantize_matrix(matrix);
                let translation = CssVector::new(
                    if angles.x == 0.0 {
                        matrix.translation.x
                    } else {
                        f64::from((point_translation.x as f32) * point_to_device)
                    },
                    if angles.x == 0.0 && angles.y != 0.0 {
                        quantized.translation.y
                    } else {
                        matrix.translation.y
                    },
                );
                CssAffineMatrix::new(quantized.x_axis, quantized.y_axis, translation)
            }
            _ => matrix,
        }
    }

    fn push_paint(self, content: &mut String) {
        self.push_paint_at(content, CssVector::new(0.0, 0.0));
    }

    fn push_paint_at(self, content: &mut String, offset: CssVector) {
        let size = self.css_size();
        if let Some(color) = self.background {
            let (r, g, b) = color.to_f32_rgb();
            content.push_str(&format!(
                "{r} {g} {b} rg\n{} {} {} {} re\nf\n",
                offset.x, offset.y, size.x, size.y
            ));
        }
        if let Some(border) = self.border {
            let width = border.width / POINTS_PER_CSS_PIXEL;
            let inset = width / 2.0;
            let (r, g, b) = border.color.to_f32_rgb();
            content.push_str(&format!(
                "{r} {g} {b} RG\n{width} w\n{} {} {} {} re\nS\n",
                offset.x + inset,
                offset.y + inset,
                (size.x - width).max(0.0),
                (size.y - width).max(0.0),
            ));
        }
    }
}

fn quantize_matrix(matrix: CssAffineMatrix) -> CssAffineMatrix {
    let [a, b, c, d, e, f] = matrix.components().map(|value| f64::from(value as f32));
    CssAffineMatrix::from_components(a, b, c, d, e, f)
}

#[derive(Debug, Clone, Copy)]
struct LocalSolidBox {
    offset: CssVector,
    paint: AffineSolidBox,
}

impl LocalSolidBox {
    fn from_absolute_child(child: &dyn LayoutElement, parent: AffineSolidBox) -> Option<Self> {
        struct Query {
            parent: AffineSolidBox,
            result: Option<LocalSolidBox>,
        }

        impl LayoutVisitor for Query {
            fn visit_container(&mut self, element: &Container) {
                self.result = LocalSolidBox::from_container(element, self.parent);
            }
        }

        let mut query = Query {
            parent,
            result: None,
        };
        child.accept(&mut query);
        query.result
    }

    fn from_container(child: &Container, parent: AffineSolidBox) -> Option<Self> {
        let width = child.box_model.size.width.fixed_value()?;
        let height = child.box_model.size.height.used()?;
        if !child.children.is_empty()
            || !child.paint.visible
            || child.box_model.margins.start != 0.0
            || child.box_model.margins.end != 0.0
            || child.paint.group.effects.opacity != 1.0
            || child.paint.group.effects.mix_blend_mode != BlendMode::Normal
            || child.paint.background.blend_mode != BlendMode::Normal
            || !child.positioning.scheme.is_absolute()
            || child.paint.group.transform.value.is_some()
            || child.paint.group.effects.masking.clip_path.is_some()
            || child.paint.group.effects.masking.image.is_some()
            || child.overflow.combined.clips()
            || !child.paint.shadows.is_empty()
            || child.paint.background.layers.has_image()
            || child.paint.background.layers.blur_radius != 0.0
            || child.paint.background.layers.clip != BackgroundClip::Border
            || !child.paint.border_radii.is_zero()
            || child.paint.outline.width != 0.0
        {
            return None;
        }
        let offset_left = child.positioning.insets.left;
        let offset_top = child.positioning.insets.top;
        let offset = CssVector::new(
            (parent.border.map_or(0.0, |border| border.width) + f64::from(offset_left))
                / POINTS_PER_CSS_PIXEL,
            (parent.border.map_or(0.0, |border| border.width) + f64::from(offset_top))
                / POINTS_PER_CSS_PIXEL,
        );
        let paint = AffineSolidBox::from_layout(
            PdfRect::new(0.0, 0.0, width, height),
            PdfVector::new(0.0, 0.0),
            PdfVector::new(width, height),
            child.paint.background.color,
            &child.box_model.border,
        )?;
        let parent_size = parent.css_size();
        let size = paint.css_size();
        if offset.x < 0.0
            || offset.y < 0.0
            || offset.x + size.x > parent_size.x
            || offset.y + size.y > parent_size.y
        {
            return None;
        }
        Some(Self { offset, paint })
    }

    fn push_paint(self, content: &mut String) {
        self.paint.push_paint_at(content, self.offset);
    }
}

#[derive(Debug, Clone, Copy)]
struct DeviceFormPlacement {
    page_origin: CssVector,
    local_matrix: CssAffineMatrix,
    bounds: CssVector,
}

impl DeviceFormPlacement {
    fn for_axis_aligned(matrix: CssAffineMatrix, local_size: CssVector) -> Option<Self> {
        if matrix.x_axis.y != 0.0 || matrix.y_axis.x != 0.0 {
            return None;
        }
        let opposite = CssVector::new(
            matrix.translation.x + matrix.x_axis.x * local_size.x,
            matrix.translation.y + matrix.y_axis.y * local_size.y,
        );
        let minimum = CssVector::new(
            matrix.translation.x.min(opposite.x),
            matrix.translation.y.min(opposite.y),
        );
        let maximum = CssVector::new(
            matrix.translation.x.max(opposite.x),
            matrix.translation.y.max(opposite.y),
        );
        let page_origin = CssVector::new(minimum.x.floor(), minimum.y.floor());
        Some(Self {
            page_origin,
            local_matrix: CssAffineMatrix::new(
                matrix.x_axis,
                matrix.y_axis,
                CssVector::new(
                    matrix.translation.x - page_origin.x,
                    matrix.translation.y - page_origin.y,
                ),
            ),
            bounds: CssVector::new(
                (maximum.x - page_origin.x).ceil(),
                (maximum.y - page_origin.y).ceil(),
            ),
        })
    }

    fn push_form(
        self,
        content: &mut String,
        paint: AffineSolidBox,
        children: &[LocalSolidBox],
        device: PdfDeviceSpace,
        writer: &mut PdfWriter,
        page_images: &mut Vec<ImageRef>,
    ) {
        let mut stream = String::from("q\n");
        push_matrix(&mut stream, self.local_matrix);
        paint.push_paint(&mut stream);
        for child in children {
            child.push_paint(&mut stream);
        }
        stream.push_str("Q\n");
        let form = writer.add_transparency_group_form(
            stream,
            PdfRect::new(0.0, 0.0, self.bounds.x as f32, self.bounds.y as f32),
        );
        content.push_str("q\n");
        content.push_str(&device.enter_operator());
        content.push_str(&format!(
            "1 0 0 1 {} {} cm\n/{} Do\nQ\n",
            self.page_origin.x, self.page_origin.y, form.name
        ));
        page_images.push(form);
    }
}

fn push_matrix(content: &mut String, matrix: CssAffineMatrix) {
    let [a, b, c, d, e, f] = matrix.components();
    content.push_str(&format!("{a} {b} {c} {d} {e} {f} cm\n"));
}

fn push_skew_matrix(content: &mut String, matrix: CssAffineMatrix) {
    let [a, b, c, d, e, f] = matrix.components();
    let axes = [a, b, c, d].map(|value| format_pdf_number_fixed(value, 8));
    let translation = [e, f].map(|value| format_pdf_number_fixed(value, 5));
    content.push_str(&format!(
        "{} {} {} {} {} {} cm\n",
        axes[0], axes[1], axes[2], axes[3], translation[0], translation[1]
    ));
}

/// Paint a simple transformed solid in the same local-CSS -> print-device ->
/// page hierarchy used by browser PDFs. Returns `false` when the box paint is
/// not representable by this deliberately narrow path.
pub(super) fn render_affine_solid_box(
    content: &mut String,
    writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
    box_transform: &BoxTransform,
    geometry: PaintBoxGeometry,
    background: Option<crate::types::Color>,
    border: &LayoutBorder,
) -> bool {
    let Some(transform) = box_transform.value.as_ref() else {
        return false;
    };
    let Some(device) = writer.page_content_transform.device_space() else {
        return false;
    };
    let reference = geometry.transform_reference(box_transform);
    let Some(paint) = AffineSolidBox::from_layout(
        geometry.border_box,
        reference.local_pivot(),
        reference.size(),
        background,
        border,
    ) else {
        return false;
    };
    let matrix = paint.device_matrix(transform, device);
    if matches!(transform, Transform::Scale(_))
        && let Some(placement) = DeviceFormPlacement::for_axis_aligned(matrix, paint.css_size())
    {
        placement.push_form(content, paint, &[], device, writer, page_images);
        return true;
    }
    content.push_str("q\n");
    content.push_str(&device.enter_operator());
    if matches!(transform, Transform::Skew(_)) {
        // Skia writes affine axes and device translations at their distinct
        // scalar precisions. Preserve that PDF boundary instead of leaking
        // Rust's f64 debug-style decimal expansion into the content stream.
        push_skew_matrix(content, matrix);
    } else {
        push_matrix(content, matrix);
    }
    paint.push_paint(content);
    content.push_str("Q\n");
    true
}

/// Paint an axis-aligned transformed solid group as one device-space Form.
/// Only contained, absolutely positioned, effect-free solid child containers
/// are accepted; every other subtree stays on the general renderer.
pub(super) struct AffineSolidGroup<'a> {
    pub(super) transform: &'a BoxTransform,
    pub(super) geometry: PaintBoxGeometry,
    pub(super) background: Option<crate::types::Color>,
    pub(super) border: &'a LayoutBorder,
    pub(super) children: &'a [LayoutNode],
}

pub(super) fn render_affine_solid_group(
    content: &mut String,
    writer: &mut PdfWriter,
    page_images: &mut Vec<ImageRef>,
    group: AffineSolidGroup<'_>,
) -> bool {
    let Some(transform) = group.transform.value.as_ref() else {
        return false;
    };
    if !matches!(transform, Transform::Scale(_)) {
        return false;
    }
    let Some(device) = writer.page_content_transform.device_space() else {
        return false;
    };
    let reference = group.geometry.transform_reference(group.transform);
    let Some(paint) = AffineSolidBox::from_layout(
        group.geometry.border_box,
        reference.local_pivot(),
        reference.size(),
        group.background,
        group.border,
    ) else {
        return false;
    };
    let Some(placement) = DeviceFormPlacement::for_axis_aligned(
        paint.device_matrix(transform, device),
        paint.css_size(),
    ) else {
        return false;
    };
    let Some(children) = group
        .children
        .iter()
        .map(|child| LocalSolidBox::from_absolute_child(child, paint))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    if children.is_empty() {
        return false;
    }
    placement.push_form(content, paint, &children, device, writer, page_images);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::{LayoutBorder, LayoutBorderSide};
    use crate::style::computed::CssVector;
    use crate::types::Color;

    #[test]
    fn scale_is_staged_in_local_css_and_device_coordinates() {
        let mut content = String::new();
        let mut writer = PdfWriter::new();
        writer.page_content_transform =
            super::super::PageContentTransform::print(PdfVector::new(180.0, 258.0));
        let mut page_images = Vec::new();
        let box_transform = BoxTransform {
            value: Some(Transform::Scale(CssVector::splat(1.8))),
            ..Default::default()
        };
        assert!(render_affine_solid_box(
            &mut content,
            &mut writer,
            &mut page_images,
            &box_transform,
            PaintBoxGeometry::new(
                PdfRect::from_top(106.5, 151.5, 75.0, 45.0),
                crate::types::EdgeSizes::ZERO,
                crate::types::EdgeSizes::ZERO,
            ),
            Some(Color::from_srgb(0.0, 0.5, 0.0, 1.0)),
            &LayoutBorder::default(),
        ));
        assert!(content.contains("1 0 0 1 318 368 cm"));
        let form_stream = String::from_utf8(writer.binary_objects[&page_images[0].obj_id].clone())
            .expect("test form stream must be UTF-8");
        assert!(form_stream.contains("5.625 0 0 5.625 0.75 0.75 cm"));
        assert!(form_stream.contains("0 0 100 60 re"));
    }

    #[test]
    fn nonuniform_border_declines_the_fast_path() {
        let border = LayoutBorder {
            top: LayoutBorderSide {
                width: 1.0,
                style: BorderStyle::Solid,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut writer = PdfWriter::new();
        writer.page_content_transform =
            super::super::PageContentTransform::print(PdfVector::new(100.0, 100.0));
        let box_transform = BoxTransform {
            value: Some(Transform::Scale(CssVector::splat(2.0))),
            ..Default::default()
        };
        assert!(!render_affine_solid_box(
            &mut String::new(),
            &mut writer,
            &mut Vec::new(),
            &box_transform,
            PaintBoxGeometry::new(
                PdfRect::new(0.0, 0.0, 10.0, 10.0),
                crate::types::EdgeSizes::ZERO,
                crate::types::EdgeSizes::ZERO,
            ),
            None,
            &border,
        ));
    }
}
