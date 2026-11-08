//! Paint fragments participating in a CSS stacking context.
//!
//! Layout is always traversed in source order. Paint fragments are collected
//! separately and sorted only when the nearest stacking context is complete.
//! This lets positioned descendants escape ordinary structural ancestors
//! without losing the geometry already resolved by the recursive renderer.

use crate::layout::elements::{LayoutElement, StackingLevel};

#[derive(Debug)]
pub(super) struct StackingPaintFragment {
    level: StackingLevel,
    content: String,
    clips: Vec<String>,
}

impl StackingPaintFragment {
    fn paint_into(self, output: &mut String, ambient_clips: &[String]) {
        let shared_clips = self
            .clips
            .iter()
            .zip(ambient_clips)
            .take_while(|(fragment, ambient)| fragment == ambient)
            .count();
        let additional_clips = &self.clips[shared_clips..];

        for clip in additional_clips {
            output.push_str(clip);
        }
        output.push_str(&self.content);
        for _ in additional_clips {
            output.push_str("Q\n");
        }
    }
}

/// Stable paint schedule for one CSS stacking context.
#[derive(Debug, Default)]
pub(super) struct StackingPaintPlan {
    fragments: Vec<StackingPaintFragment>,
}

impl StackingPaintPlan {
    pub(super) fn push(&mut self, fragment: StackingPaintFragment) {
        if !fragment.content.is_empty() {
            self.fragments.push(fragment);
        }
    }

    pub(super) fn extend(&mut self, fragments: impl IntoIterator<Item = StackingPaintFragment>) {
        self.fragments.extend(
            fragments
                .into_iter()
                .filter(|fragment| !fragment.content.is_empty()),
        );
    }

    pub(super) fn paint_into(mut self, output: &mut String, ambient_clips: &[String]) {
        self.fragments.sort_by_key(|fragment| fragment.level);
        for fragment in self.fragments {
            fragment.paint_into(output, ambient_clips);
        }
    }
}

/// State shared by recursive renderers while they seek their nearest stacking
/// context and preserve any overflow clips crossed on the way there.
#[derive(Debug, Default)]
pub(super) struct StackingTraversal {
    deferred: Vec<StackingPaintFragment>,
    clips: Vec<String>,
}

impl StackingTraversal {
    pub(super) fn fork(&self) -> Self {
        Self {
            deferred: Vec::new(),
            clips: self.clips.clone(),
        }
    }

    pub(super) fn fragment(&self, level: StackingLevel, content: String) -> StackingPaintFragment {
        StackingPaintFragment {
            level,
            content,
            clips: self.clips.clone(),
        }
    }

    pub(super) fn defer(&mut self, level: StackingLevel, content: String) {
        let fragment = self.fragment(level, content);
        if !fragment.content.is_empty() {
            self.deferred.push(fragment);
        }
    }

    pub(super) fn marker(&self) -> usize {
        self.deferred.len()
    }

    pub(super) fn take_since(&mut self, marker: usize) -> Vec<StackingPaintFragment> {
        self.deferred.split_off(marker.min(self.deferred.len()))
    }

    pub(super) fn restore(&mut self, fragments: impl IntoIterator<Item = StackingPaintFragment>) {
        self.deferred.extend(fragments);
    }

    pub(super) fn commit(
        &mut self,
        scope: StackingScope,
        output: &mut String,
        local_plan: &mut StackingPaintPlan,
        level: StackingLevel,
        content: String,
        descendants: Vec<StackingPaintFragment>,
    ) {
        if scope.is_local() {
            local_plan.push(self.fragment(level, content));
            local_plan.extend(descendants);
            return;
        }

        if level.is_in_flow() {
            output.push_str(&content);
        } else {
            self.defer(level, content);
        }
        self.restore(descendants);
    }

    pub(super) fn paint_plan(&self, plan: StackingPaintPlan, output: &mut String) {
        plan.paint_into(output, self.active_clips());
    }

    pub(super) fn push_clip(&mut self, command: String) {
        self.clips.push(command);
    }

    pub(super) fn pop_clip(&mut self) {
        self.clips.pop();
    }

    pub(super) fn active_clips(&self) -> &[String] {
        &self.clips
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum StackingScope {
    /// This box is a stacking context; resolve deferred descendants here.
    #[default]
    Local,
    /// This box is ordinary; non-in-flow descendants participate in the
    /// nearest ancestor stacking context.
    Ancestor,
}

impl StackingScope {
    pub(super) fn for_element(element: &dyn LayoutElement) -> Self {
        if crate::layout::engine::layout_element_establishes_stacking_context(element) {
            Self::Local
        } else {
            Self::Ancestor
        }
    }

    pub(super) const fn is_local(self) -> bool {
        matches!(self, Self::Local)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_is_stable_within_a_stacking_level() {
        let traversal = StackingTraversal::default();
        let mut plan = StackingPaintPlan::default();
        plan.push(traversal.fragment(StackingLevel::positive(2), "second\n".into()));
        plan.push(traversal.fragment(StackingLevel::negative(-1), "first\n".into()));
        plan.push(traversal.fragment(StackingLevel::positive(2), "third\n".into()));

        let mut output = String::new();
        plan.paint_into(&mut output, &[]);
        assert_eq!(output, "first\nsecond\nthird\n");
    }

    #[test]
    fn fragment_reapplies_only_clips_outside_the_ambient_scope() {
        let mut traversal = StackingTraversal::default();
        traversal.push_clip("q\nouter W n\n".into());
        traversal.push_clip("q\ninner W n\n".into());
        let fragment = traversal.fragment(StackingLevel::in_flow(), "paint\n".into());

        let mut output = String::new();
        fragment.paint_into(&mut output, &["q\nouter W n\n".into()]);
        assert_eq!(output, "q\ninner W n\npaint\nQ\n");
    }
}
