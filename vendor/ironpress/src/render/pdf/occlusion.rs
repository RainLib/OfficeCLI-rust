use super::*;
use crate::layout::elements::{Container, LayoutVisitor, TextBlock};

/// Safety inset (CSS px == PDF pt) the coverer must exceed the raster by on
/// every side before the raster is considered safely hidden.
pub(super) const OCCLUSION_SAFETY_MARGIN: f32 = 2.0;

/// If `element` is a top-level block whose painted output is a single
/// fully-opaque, square-cornered, untransformed, un-blended rectangle that
/// fills its entire border box, return that border-box rectangle in PDF page
/// coordinates. Anything that could leave a gap (transparency, border-radius,
/// opacity < 1, blend mode, transform, clip, non-border background-clip, a
/// gradient/SVG background that might not be opaque, `visibility:hidden`)
/// disqualifies it — when unsure we return `None` and never cull.
pub(super) fn opaque_block_coverer_rect(
    element: &dyn LayoutElement,
    y_pos: f32,
    page_size: PageSize,
    margin: Margin,
    available_width: f32,
) -> Option<PdfRect> {
    struct Coverer {
        y_pos: f32,
        page_size: PageSize,
        margin: Margin,
        available_width: f32,
        rect: Option<PdfRect>,
    }

    impl LayoutVisitor for Coverer {
        fn visit_text_block(&mut self, element: &TextBlock) {
            let Some(background) = element.paint.background.color else {
                return;
            };
            if !element.paint.visible
                || !background.is_opaque()
                || element.paint.group.effects.opacity < 1.0
                || element.paint.group.effects.mix_blend_mode
                    != crate::style::computed::BlendMode::Normal
                || element.paint.group.transform.value.is_some()
                || element.clipping.rect.is_some()
                || !element.paint.border_radii.is_zero()
                || element.paint.background.layers.clip != BackgroundClip::Border
                || element.paint.background.layers.has_image()
                || element.paint.background.layers.blur_radius > 0.0
            {
                return;
            }
            let width = element.box_model.size.resolve_width(self.available_width);
            let left = element.positioning.insets.left;
            let x = match element.positioning.scheme {
                Position::Absolute | Position::Fixed => element
                    .positioning
                    .containing_block
                    .map_or(self.margin.left + left, |containing_block| {
                        self.margin.left + containing_block.x + left
                    }),
                Position::Relative | Position::Sticky => self.margin.left + left,
                Position::Static => match element.flow.float {
                    Float::Right => self.margin.left + self.available_width - width,
                    _ => self.margin.left + left,
                },
            };
            let top = self.page_size.height - self.margin.top - self.y_pos;
            let padding_box_height = text_block_total_height(
                &element.lines,
                element.box_model.padding,
                element.box_model.size.height.used(),
                element.clipping.rect.is_some(),
            );
            self.rect = Some(PdfRect::from_top(
                x,
                top,
                width,
                padding_box_height + element.box_model.border.vertical_width(),
            ));
        }

        fn visit_container(&mut self, element: &Container) {
            let Some(background) = element.paint.background.color else {
                return;
            };
            if !element.paint.visible
                || !background.is_opaque()
                || element.paint.group.effects.opacity < 1.0
                || element.paint.group.effects.mix_blend_mode
                    != crate::style::computed::BlendMode::Normal
                || element.paint.group.transform.value.is_some()
                || element.paint.group.effects.masking.clip_path.is_some()
                || element.paint.group.effects.masking.image.is_some()
                || !element.paint.border_radii.is_zero()
                || element.paint.background.layers.clip != BackgroundClip::Border
                || element.paint.background.layers.has_image()
            {
                return;
            }
            let width = element.box_model.size.resolve_width(self.available_width);
            let x = match element.flow.float {
                Float::Right => self.margin.left + self.available_width - width,
                _ => self.margin.left + element.positioning.insets.left,
            };
            let top = self.page_size.height - self.margin.top - self.y_pos;
            let natural_height = element.box_model.padding.vertical()
                + collapsed_children_height(&element.children)
                + element.box_model.border.vertical_width();
            self.rect = Some(PdfRect::from_top(
                x,
                top,
                width,
                element.box_model.size.height.resolve(natural_height),
            ));
        }
    }

    let mut coverer = Coverer {
        y_pos,
        page_size,
        margin,
        available_width,
        rect: None,
    };
    element.accept(&mut coverer);
    coverer.rect
}

/// Collect `(rect, paint_index)` for every qualifying opaque rectangular
/// coverer on the page, in paint order. Higher index == painted later (on top).
pub(super) fn collect_opaque_coverers(
    page: &Page,
    page_size: PageSize,
    margin: Margin,
    available_width: f32,
) -> Vec<(PdfRect, usize)> {
    page.elements
        .iter()
        .enumerate()
        .filter_map(|(idx, (y_pos, element))| {
            if element.is_page_paint_continuation() {
                return None;
            }
            opaque_block_coverer_rect(element, *y_pos, page_size, margin, available_width)
                .map(|rect| (rect, idx))
        })
        .collect()
}

/// True when some opaque coverer painted strictly later than `elem_idx` fully
/// contains `raster` with the safety margin — i.e. the raster is guaranteed
/// invisible and can be skipped.
pub(super) fn raster_is_occluded(
    coverers: &[(PdfRect, usize)],
    raster: PdfRect,
    elem_idx: usize,
) -> bool {
    coverers.iter().any(|(rect, idx)| {
        *idx > elem_idx && rect.covers_with_margin(raster, OCCLUSION_SAFETY_MARGIN)
    })
}
