//! CSS stacking levels shared by every layout and paint traversal.

use super::{BlockFlow, PaintGroup, PaintGroupOwner, Positioning, PositioningOwner};
use crate::style::computed::{Float, ZIndex};

/// Formatting-context participation that changes where `z-index` applies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum StackingRole {
    #[default]
    Ordinary,
    FlexItem,
    GridItem,
    PageBackdrop,
}

/// Authored stack index plus the layout role that gives it meaning.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Stacking {
    pub(crate) z_index: ZIndex,
    pub(crate) role: StackingRole,
}

impl Stacking {
    pub(crate) const fn from_style(style: &crate::style::computed::ComputedStyle) -> Self {
        Self {
            z_index: style.z_index,
            role: StackingRole::Ordinary,
        }
    }

    pub(crate) const fn with_role(mut self, role: StackingRole) -> Self {
        self.role = role;
        self
    }

    pub(crate) fn level(
        self,
        positioning: Option<&Positioning>,
        flow: Option<&BlockFlow>,
        group: &PaintGroup,
    ) -> StackingLevel {
        if self.role == StackingRole::PageBackdrop {
            return StackingLevel::page_backdrop(self.z_index.value());
        }

        let positioned = positioning.is_some_and(|positioning| positioning.scheme.is_positioned());
        let item_z_index_applies =
            matches!(self.role, StackingRole::FlexItem | StackingRole::GridItem)
                && !self.z_index.is_auto();
        let z_index_applies = positioned || item_z_index_applies;

        if z_index_applies && self.z_index.is_negative() {
            return StackingLevel::negative(self.z_index.value());
        }
        if z_index_applies && self.z_index.is_positive() {
            return StackingLevel::positive(self.z_index.value());
        }
        if positioned || item_z_index_applies || group.establishes_stacking_context() {
            return StackingLevel::positioned_zero();
        }
        if flow.is_some_and(|flow| flow.float != Float::None) {
            return StackingLevel::float();
        }
        StackingLevel::in_flow()
    }

    pub(crate) fn establishes_context(
        self,
        positioning: Option<&Positioning>,
        group: &PaintGroup,
    ) -> bool {
        let positioned_context = positioning.is_some_and(|positioning| {
            positioning.scheme.establishes_stacking_context()
                || positioning.scheme.is_positioned() && !self.z_index.is_auto()
        });
        let item_with_integer_z =
            matches!(self.role, StackingRole::FlexItem | StackingRole::GridItem)
                && !self.z_index.is_auto();
        positioned_context
            || item_with_integer_z
            || self.role == StackingRole::PageBackdrop
            || group.establishes_stacking_context()
    }
}

/// Shared stacking behavior for formatting-context items that are not layout
/// tree nodes themselves, such as flex, grid, and table cells.
pub(crate) trait StackingParticipant: PaintGroupOwner + PositioningOwner {
    fn stacking_level(&self) -> StackingLevel {
        let group = self.paint_group();
        group.stacking.level(Some(self.positioning()), None, group)
    }

    fn establishes_stacking_context(&self) -> bool {
        let group = self.paint_group();
        group
            .stacking
            .establishes_context(Some(self.positioning()), group)
    }
}

impl<T> StackingParticipant for T where T: PaintGroupOwner + PositioningOwner {}

/// Major CSS 2 painting-order phase within one stacking context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum StackingLayer {
    PageBackdrop,
    Negative,
    InFlowDecoration,
    InFlow,
    Float,
    InFlowContents,
    PositionedZero,
    Positive,
}

/// Stable-sort key for one box in its containing stacking context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct StackingLevel {
    layer: StackingLayer,
    z_index: i32,
}

impl StackingLevel {
    const fn new(layer: StackingLayer, z_index: i32) -> Self {
        Self { layer, z_index }
    }

    pub(crate) const fn page_backdrop(z_index: i32) -> Self {
        Self::new(StackingLayer::PageBackdrop, z_index)
    }

    pub(crate) const fn negative(z_index: i32) -> Self {
        Self::new(StackingLayer::Negative, z_index)
    }

    pub(crate) const fn in_flow() -> Self {
        Self::new(StackingLayer::InFlow, 0)
    }

    pub(crate) const fn in_flow_decoration() -> Self {
        Self::new(StackingLayer::InFlowDecoration, 0)
    }

    pub(crate) const fn in_flow_contents() -> Self {
        Self::new(StackingLayer::InFlowContents, 0)
    }

    pub(crate) const fn float() -> Self {
        Self::new(StackingLayer::Float, 0)
    }

    pub(crate) const fn positioned_zero() -> Self {
        Self::new(StackingLayer::PositionedZero, 0)
    }

    pub(crate) const fn positive(z_index: i32) -> Self {
        Self::new(StackingLayer::Positive, z_index)
    }

    pub(crate) const fn is_in_flow(self) -> bool {
        matches!(
            self.layer,
            StackingLayer::InFlowDecoration | StackingLayer::InFlow | StackingLayer::InFlowContents
        )
    }

    pub(crate) const fn with_in_flow_phase(self, decoration: bool, contents: bool) -> Self {
        if !matches!(self.layer, StackingLayer::InFlow) {
            return self;
        }
        if decoration && !contents {
            return Self::in_flow_decoration();
        }
        if contents && !decoration {
            return Self::in_flow_contents();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::elements::GroupEffects;
    use crate::layout::engine::StackingContext;
    use crate::style::computed::{Isolation, Position, Transform};

    fn group(stacking: Stacking) -> PaintGroup {
        PaintGroup {
            stacking,
            ..Default::default()
        }
    }

    #[test]
    fn ordinary_static_z_index_is_ignored() {
        let stacking = Stacking {
            z_index: ZIndex::integer(7),
            ..Default::default()
        };
        assert_eq!(
            stacking.level(Some(&Positioning::default()), None, &group(stacking)),
            StackingLevel::in_flow()
        );
    }

    #[test]
    fn static_flex_item_z_index_participates() {
        let stacking = Stacking {
            z_index: ZIndex::integer(-3),
            role: StackingRole::FlexItem,
        };
        assert_eq!(
            stacking.level(Some(&Positioning::default()), None, &group(stacking)),
            StackingLevel::negative(-3)
        );
    }

    #[test]
    fn positioned_auto_and_integer_zero_share_a_level_but_not_a_value() {
        let positioning = Positioning::default().with_scheme(Position::Relative);
        for z_index in [ZIndex::Auto, ZIndex::integer(0)] {
            let stacking = Stacking {
                z_index,
                ..Default::default()
            };
            assert_eq!(
                stacking.level(Some(&positioning), None, &group(stacking)),
                StackingLevel::positioned_zero()
            );
        }
        assert_ne!(ZIndex::Auto, ZIndex::integer(0));
    }

    #[test]
    fn fixed_and_sticky_auto_form_stacking_contexts() {
        for scheme in [Position::Fixed, Position::Sticky] {
            let positioning = Positioning::default().with_scheme(scheme);
            let stacking = Stacking::default();
            assert_eq!(
                stacking.level(Some(&positioning), None, &group(stacking)),
                StackingLevel::positioned_zero()
            );
            assert!(stacking.establishes_context(Some(&positioning), &group(stacking)));
        }
    }

    #[test]
    fn opacity_promotes_a_static_box_to_the_zero_stacking_layer() {
        let stacking = Stacking::default();
        let group = PaintGroup {
            stacking,
            effects: GroupEffects {
                opacity: 0.5,
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            stacking.level(Some(&Positioning::default()), None, &group),
            StackingLevel::positioned_zero()
        );
    }

    #[test]
    fn every_group_boundary_is_a_zero_level_stacking_context() {
        let groups = [
            PaintGroup {
                transform: super::super::BoxTransform {
                    value: Some(Transform::Rotate(0.0)),
                    ..Default::default()
                },
                ..Default::default()
            },
            PaintGroup {
                transform: super::super::BoxTransform {
                    perspective: Some(100.0),
                    ..Default::default()
                },
                ..Default::default()
            },
            PaintGroup {
                effects: GroupEffects {
                    isolation: Isolation::Isolate,
                    ..Default::default()
                },
                ..Default::default()
            },
            PaintGroup {
                effects: GroupEffects {
                    mix_blend_mode: crate::style::computed::BlendMode::Multiply,
                    ..Default::default()
                },
                ..Default::default()
            },
            PaintGroup {
                effects: GroupEffects {
                    stacking_context: StackingContext::Filter,
                    ..Default::default()
                },
                ..Default::default()
            },
            PaintGroup {
                effects: GroupEffects {
                    stacking_context: StackingContext::FilteredOutput,
                    ..Default::default()
                },
                ..Default::default()
            },
        ];

        for group in groups {
            assert!(group.establishes_stacking_context());
            assert_eq!(
                group.stacking.level(None, None, &group),
                StackingLevel::positioned_zero()
            );
        }
    }

    #[test]
    fn floats_have_their_own_phase_below_positioned_zero() {
        let stacking = Stacking::default();
        let flow = BlockFlow {
            float: Float::Left,
            ..Default::default()
        };
        assert!(
            stacking.level(None, Some(&flow), &group(stacking)) < StackingLevel::positioned_zero()
        );
    }
}
