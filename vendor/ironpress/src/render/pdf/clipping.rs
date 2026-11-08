//! Paint-time clipping shared by recursive formatting contexts.

use super::stacking::StackingTraversal;

/// One PDF graphics-state clip mirrored into deferred stacking fragments.
///
/// Layout retains complete content. Every renderer enters this scope around
/// the content phase so glyph ink, nested blocks, and positioned descendants
/// are clipped by the same geometry even when stacking defers their paint.
pub(super) struct ContentClip {
    command: String,
}

impl ContentClip {
    pub(super) fn from_path(path: String) -> Self {
        Self {
            command: format!("q\n{path}W n\n"),
        }
    }

    pub(super) fn rounded_padding_box(
        geometry: super::PaintBoxGeometry,
        radii: crate::types::CornerRadii,
    ) -> Self {
        Self::from_path(geometry.rounded_padding_box(radii).path_or_rect())
    }

    pub(super) fn begin(&self, output: &mut String, stacking: &mut StackingTraversal) {
        output.push_str(&self.command);
        stacking.push_clip(self.command.clone());
    }

    pub(super) fn finish(&self, output: &mut String, stacking: &mut StackingTraversal) {
        stacking.pop_clip();
        output.push_str("Q\n");
    }
}
