use super::{BoxModel, FragmentBreakQuery, FragmentBreakRule, FragmentBreakScope};
use crate::layout::engine::TextLine;
use crate::style::computed::BoxDecorationBreak;
use crate::types::EdgeSizes;

/// Author intent for unforced breaks inside a principal box.
///
/// CSS Fragmentation treats `avoid` as a normal-rule constraint, not as an
/// absolute prohibition: a box that fits a fresh fragmentainer stays intact,
/// while the emergency rule may still split an over-tall box to make progress.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum FragmentBreakAvoidance {
    #[default]
    Auto,
    Avoid,
}

impl FragmentBreakAvoidance {
    pub(crate) const fn from_style(style: &crate::style::computed::ComputedStyle) -> Self {
        if style.break_inside_avoid {
            Self::Avoid
        } else {
            Self::Auto
        }
    }

    pub(crate) const fn permits(self, rule: FragmentBreakRule) -> bool {
        matches!(self, Self::Auto) || matches!(rule, FragmentBreakRule::Emergency)
    }
}

/// Original edge geometry of the reference box shared by every fragment.
///
/// Individual fragments remove edges adjoining a break, while percentage
/// shapes and image positioning for `box-decoration-break: slice` resolve
/// against the reassembled box with its authored border and padding restored.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct FragmentReferenceEdges {
    border: EdgeSizes,
    padding: EdgeSizes,
}

impl FragmentReferenceEdges {
    pub(crate) fn from_box_model(box_model: &BoxModel) -> Self {
        Self {
            border: box_model.border.widths(),
            padding: box_model.padding,
        }
    }

    pub(crate) const fn border(self) -> EdgeSizes {
        self.border
    }

    pub(crate) const fn padding(self) -> EdgeSizes {
        self.padding
    }
}

/// Position of one fragment inside the composite reference box required by
/// CSS Break 3 for `box-decoration-break: slice`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BoxFragmentSlice {
    block_offset: f32,
    composite_block_size: f32,
    edges: FragmentReferenceEdges,
}

impl BoxFragmentSlice {
    pub(crate) fn split(
        first_block_size: f32,
        continuation_block_size: f32,
        box_model: &BoxModel,
    ) -> (Self, Self) {
        let composite_block_size = first_block_size + continuation_block_size;
        let edges = FragmentReferenceEdges::from_box_model(box_model);
        (
            Self {
                block_offset: 0.0,
                composite_block_size,
                edges,
            },
            Self {
                block_offset: first_block_size,
                composite_block_size,
                edges,
            },
        )
    }

    pub(crate) const fn block_offset(self) -> f32 {
        self.block_offset
    }

    pub(crate) const fn composite_block_size(self) -> f32 {
        self.composite_block_size
    }

    pub(crate) const fn edges(self) -> FragmentReferenceEdges {
        self.edges
    }

    const fn split_continuation(self, first_block_size: f32) -> (Self, Self) {
        (
            self,
            Self {
                block_offset: self.block_offset + first_block_size,
                ..self
            },
        )
    }
}

/// Fragmentation behavior common to decorated box fragments.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct BoxFragmentation {
    pub(crate) decoration: BoxDecorationBreak,
    pub(crate) inside: FragmentBreakAvoidance,
    pub(crate) content_role: super::PageContentRole,
    pub(crate) reference_slice: Option<BoxFragmentSlice>,
}

impl BoxFragmentation {
    pub(crate) const fn from_style(style: &crate::style::computed::ComputedStyle) -> Self {
        Self {
            decoration: style.box_decoration_break,
            inside: FragmentBreakAvoidance::from_style(style),
            content_role: super::PageContentRole::MainFlow,
            reference_slice: None,
        }
    }

    pub(crate) const fn with_decoration(mut self, decoration: BoxDecorationBreak) -> Self {
        self.decoration = decoration;
        self
    }

    pub(crate) const fn permits_split(self, rule: FragmentBreakRule) -> bool {
        self.inside.permits(rule)
    }

    pub(crate) fn split_reference_box(
        self,
        first_block_size: f32,
        continuation_block_size: f32,
        box_model: &BoxModel,
    ) -> Option<(BoxFragmentSlice, BoxFragmentSlice)> {
        (self.decoration == BoxDecorationBreak::Slice).then(|| {
            self.reference_slice.map_or_else(
                || BoxFragmentSlice::split(first_block_size, continuation_block_size, box_model),
                |slice| slice.split_continuation(first_block_size),
            )
        })
    }
}

/// CSS Fragmentation line constraints shared by every inline formatting
/// context, including ordinary text boxes and the parallel flows in cells.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LineFragmentation {
    orphans: u8,
    widows: u8,
}

impl LineFragmentation {
    pub(crate) const fn new(orphans: u8, widows: u8) -> Self {
        Self { orphans, widows }
    }

    pub(crate) const fn from_style(style: &crate::style::computed::ComputedStyle) -> Self {
        Self::new(style.orphans, style.widows)
    }

    /// Select the latest legal prefix no longer than the number of lines that
    /// geometrically fit. `None` means the formatting context must move intact
    /// rather than leave too few orphans or widows.
    pub(crate) fn split_index(
        self,
        line_count: usize,
        fitting: usize,
        rule: FragmentBreakRule,
    ) -> Option<usize> {
        if fitting == 0 || fitting >= line_count {
            return None;
        }
        let orphans = self.orphans.max(1) as usize;
        let widows = self.widows.max(1) as usize;
        let latest = fitting.min(line_count.saturating_sub(widows));
        if latest >= orphans {
            Some(latest)
        } else if rule == FragmentBreakRule::Emergency {
            Some(fitting)
        } else {
            None
        }
    }

    pub(crate) fn find_break(
        self,
        lines: &[TextLine],
        content_start: f32,
        query: FragmentBreakQuery,
    ) -> Option<f32> {
        if lines.len() < 2 || query.scope == FragmentBreakScope::BlockBoundaries {
            return None;
        }

        let mut offset = content_start;
        let mut consumed_lines = 0usize;
        for line in lines {
            offset += line.height;
            if !crate::layout::roundoff::exceeds_with_roundoff(offset, query.consumed) {
                consumed_lines += 1;
            } else {
                break;
            }
        }

        let orphans = self.orphans.max(1) as usize;
        let widows = self.widows.max(1) as usize;
        let mut latest = None;
        offset = content_start;
        for (index, line) in lines.iter().enumerate() {
            offset += line.height;
            let lines_before_break = index + 1;
            let lines_in_fragment = lines_before_break.saturating_sub(consumed_lines);
            let lines_after_break = lines.len() - lines_before_break;
            let honors_constraints = lines_in_fragment >= orphans && lines_after_break >= widows;
            if lines_after_break > 0 && query.permits(honors_constraints) {
                latest = query.select(latest, offset);
            }
        }
        latest
    }
}

impl Default for LineFragmentation {
    fn default() -> Self {
        Self::new(2, 2)
    }
}

/// Box and line fragmentation state owned by a text principal box.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TextFragmentation {
    pub(crate) box_fragmentation: BoxFragmentation,
    pub(crate) lines: LineFragmentation,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_constraints_cover_every_prefix_of_short_and_long_blocks() {
        let policy = LineFragmentation::new(2, 2);
        let expected = [None, None, Some(2), Some(3), Some(3)];

        for (fitting, expected) in expected.into_iter().enumerate() {
            assert_eq!(
                policy.split_index(5, fitting, FragmentBreakRule::Normal),
                expected,
                "fitting={fitting}"
            );
        }
    }

    #[test]
    fn blocks_shorter_than_either_constraint_stay_intact() {
        for policy in [LineFragmentation::new(4, 2), LineFragmentation::new(2, 4)] {
            for fitting in 0..3 {
                assert_eq!(
                    policy.split_index(3, fitting, FragmentBreakRule::Normal),
                    None
                );
            }
        }
    }

    #[test]
    fn emergency_rule_relaxes_line_constraints_only_to_make_progress() {
        let policy = LineFragmentation::new(4, 4);

        assert_eq!(
            policy.split_index(5, 1, FragmentBreakRule::Emergency),
            Some(1)
        );
        assert_eq!(policy.split_index(5, 0, FragmentBreakRule::Emergency), None);
        assert_eq!(policy.split_index(5, 5, FragmentBreakRule::Emergency), None);
    }
}
