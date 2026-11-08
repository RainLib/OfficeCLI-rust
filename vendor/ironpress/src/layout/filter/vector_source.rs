//! Exact vector representations of narrowly constrained filter sources.
//!
//! This is an output optimization, not a relaxation of SourceGraphic
//! semantics. A concrete source opts in only when the PDF box primitives are
//! the complete filtered result. Every grouped or partially transparent source
//! remains on the offscreen compositor.

use crate::layout::elements::Container;
use crate::style::computed::{BackgroundClip, BlendMode, FilterOperation};

/// A layout source that can prove an exact vector representation for selected
/// filter lists.
pub(crate) trait ExactVectorFilterSource {
    fn supports_exact_vector_filter(&self, operations: &[FilterOperation]) -> bool;
}

impl ExactVectorFilterSource for Container {
    fn supports_exact_vector_filter(&self, operations: &[FilterOperation]) -> bool {
        let [FilterOperation::DropShadow(shadow)] = operations else {
            return false;
        };
        let Some(background) = self.paint.background.color else {
            return false;
        };

        shadow.blur == 0.0
            && background.to_f32_rgba().3 == 1.0
            && self.children.is_empty()
            && self.paint.visible
            && self.paint.background.layers.clip == BackgroundClip::Border
            && !self.paint.background.layers.has_image()
            && self.paint.background.layers.blur_radius == 0.0
            && self.paint.background.blend_mode == BlendMode::Normal
            && !self.box_model.border.has_visible()
            && self.paint.shadows.is_empty()
            && self.paint.outline.width == 0.0
            && self.paint.group.effects.opacity == 1.0
            && self.paint.group.effects.mix_blend_mode == BlendMode::Normal
            && self.paint.group.transform.value.is_none()
            && self.paint.group.effects.masking.clip_path.is_none()
            && self.paint.group.effects.masking.image.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::{BackgroundPaint, BoxPaint, IntoLayoutNode, TextBlock};
    use crate::style::computed::DropShadow;
    use crate::types::{Color, CornerRadii};

    fn drop_shadow() -> FilterOperation {
        FilterOperation::DropShadow(DropShadow {
            dx: 12.0,
            dy: 0.0,
            blur: 0.0,
            color: Color::from_srgb(0.1, 0.1, 0.1, 1.0),
        })
    }

    fn opaque_leaf() -> Container {
        Container {
            paint: BoxPaint {
                background: BackgroundPaint {
                    color: Some(Color::from_srgb(0.8, 0.1, 0.1, 1.0)),
                    ..Default::default()
                },
                border_radii: CornerRadii::circular(12.0),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn opaque_leaf_with_hard_drop_shadow_has_an_exact_vector_form() {
        assert!(opaque_leaf().supports_exact_vector_filter(&[drop_shadow()]));
    }

    #[test]
    fn descendants_and_ordered_filter_lists_require_source_graphic() {
        let mut with_child = opaque_leaf();
        with_child.children.push(TextBlock::default().boxed());
        assert!(!with_child.supports_exact_vector_filter(&[drop_shadow()]));

        assert!(
            !opaque_leaf()
                .supports_exact_vector_filter(&[FilterOperation::Grayscale(0.2), drop_shadow(),])
        );
    }
}
