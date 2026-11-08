use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) enum SideSelector {
    Physical(PhysicalSide),
    Logical(LogicalSide),
}

impl SideSelector {
    pub(super) const fn physical(self, mapping: FlowMapping) -> PhysicalSide {
        match self {
            Self::Physical(side) => side,
            Self::Logical(side) => mapping.side(side),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum SideTargets {
    AllPhysical,
    One(SideSelector),
    LogicalAxis(LogicalAxis),
}

#[derive(Debug, Clone, Copy)]
pub(super) enum SideComponent {
    All,
    Width,
    Style,
    Color,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct SideDeclaration {
    pub(super) targets: SideTargets,
    pub(super) component: SideComponent,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum RadiusTarget {
    AllPhysical,
    Physical(PhysicalCorner),
    Logical(LogicalCorner),
}

#[derive(Debug, Clone, Copy)]
pub(super) enum BorderDeclaration {
    Sides(SideDeclaration),
    Radius(RadiusTarget),
}

impl BorderDeclaration {
    pub(super) fn parse(property: &str) -> Option<Self> {
        let physical_side = |side| SideTargets::One(SideSelector::Physical(side));
        let logical_side = |side| SideTargets::One(SideSelector::Logical(side));
        let side = |targets, component| Self::Sides(SideDeclaration { targets, component });
        Some(match property {
            "border" => side(SideTargets::AllPhysical, SideComponent::All),
            "border-top" => side(physical_side(PhysicalSide::Top), SideComponent::All),
            "border-right" => side(physical_side(PhysicalSide::Right), SideComponent::All),
            "border-bottom" => side(physical_side(PhysicalSide::Bottom), SideComponent::All),
            "border-left" => side(physical_side(PhysicalSide::Left), SideComponent::All),
            "border-block-start" => side(logical_side(LogicalSide::BlockStart), SideComponent::All),
            "border-block-end" => side(logical_side(LogicalSide::BlockEnd), SideComponent::All),
            "border-inline-start" => {
                side(logical_side(LogicalSide::InlineStart), SideComponent::All)
            }
            "border-inline-end" => side(logical_side(LogicalSide::InlineEnd), SideComponent::All),
            "border-block" => side(
                SideTargets::LogicalAxis(LogicalAxis::Block),
                SideComponent::All,
            ),
            "border-inline" => side(
                SideTargets::LogicalAxis(LogicalAxis::Inline),
                SideComponent::All,
            ),

            "border-width" => side(SideTargets::AllPhysical, SideComponent::Width),
            "border-style" => side(SideTargets::AllPhysical, SideComponent::Style),
            "border-color" => side(SideTargets::AllPhysical, SideComponent::Color),
            "border-block-width" => side(
                SideTargets::LogicalAxis(LogicalAxis::Block),
                SideComponent::Width,
            ),
            "border-inline-width" => side(
                SideTargets::LogicalAxis(LogicalAxis::Inline),
                SideComponent::Width,
            ),
            "border-block-style" => side(
                SideTargets::LogicalAxis(LogicalAxis::Block),
                SideComponent::Style,
            ),
            "border-inline-style" => side(
                SideTargets::LogicalAxis(LogicalAxis::Inline),
                SideComponent::Style,
            ),
            "border-block-color" => side(
                SideTargets::LogicalAxis(LogicalAxis::Block),
                SideComponent::Color,
            ),
            "border-inline-color" => side(
                SideTargets::LogicalAxis(LogicalAxis::Inline),
                SideComponent::Color,
            ),

            "border-top-width" => side(physical_side(PhysicalSide::Top), SideComponent::Width),
            "border-right-width" => side(physical_side(PhysicalSide::Right), SideComponent::Width),
            "border-bottom-width" => {
                side(physical_side(PhysicalSide::Bottom), SideComponent::Width)
            }
            "border-left-width" => side(physical_side(PhysicalSide::Left), SideComponent::Width),
            "border-top-style" => side(physical_side(PhysicalSide::Top), SideComponent::Style),
            "border-right-style" => side(physical_side(PhysicalSide::Right), SideComponent::Style),
            "border-bottom-style" => {
                side(physical_side(PhysicalSide::Bottom), SideComponent::Style)
            }
            "border-left-style" => side(physical_side(PhysicalSide::Left), SideComponent::Style),
            "border-top-color" => side(physical_side(PhysicalSide::Top), SideComponent::Color),
            "border-right-color" => side(physical_side(PhysicalSide::Right), SideComponent::Color),
            "border-bottom-color" => {
                side(physical_side(PhysicalSide::Bottom), SideComponent::Color)
            }
            "border-left-color" => side(physical_side(PhysicalSide::Left), SideComponent::Color),

            "border-block-start-width" => {
                side(logical_side(LogicalSide::BlockStart), SideComponent::Width)
            }
            "border-block-end-width" => {
                side(logical_side(LogicalSide::BlockEnd), SideComponent::Width)
            }
            "border-inline-start-width" => {
                side(logical_side(LogicalSide::InlineStart), SideComponent::Width)
            }
            "border-inline-end-width" => {
                side(logical_side(LogicalSide::InlineEnd), SideComponent::Width)
            }
            "border-block-start-style" => {
                side(logical_side(LogicalSide::BlockStart), SideComponent::Style)
            }
            "border-block-end-style" => {
                side(logical_side(LogicalSide::BlockEnd), SideComponent::Style)
            }
            "border-inline-start-style" => {
                side(logical_side(LogicalSide::InlineStart), SideComponent::Style)
            }
            "border-inline-end-style" => {
                side(logical_side(LogicalSide::InlineEnd), SideComponent::Style)
            }
            "border-block-start-color" => {
                side(logical_side(LogicalSide::BlockStart), SideComponent::Color)
            }
            "border-block-end-color" => {
                side(logical_side(LogicalSide::BlockEnd), SideComponent::Color)
            }
            "border-inline-start-color" => {
                side(logical_side(LogicalSide::InlineStart), SideComponent::Color)
            }
            "border-inline-end-color" => {
                side(logical_side(LogicalSide::InlineEnd), SideComponent::Color)
            }

            "border-radius" => Self::Radius(RadiusTarget::AllPhysical),
            "border-top-left-radius" => {
                Self::Radius(RadiusTarget::Physical(PhysicalCorner::TopLeft))
            }
            "border-top-right-radius" => {
                Self::Radius(RadiusTarget::Physical(PhysicalCorner::TopRight))
            }
            "border-bottom-right-radius" => {
                Self::Radius(RadiusTarget::Physical(PhysicalCorner::BottomRight))
            }
            "border-bottom-left-radius" => {
                Self::Radius(RadiusTarget::Physical(PhysicalCorner::BottomLeft))
            }
            "border-start-start-radius" => {
                Self::Radius(RadiusTarget::Logical(LogicalCorner::StartStart))
            }
            "border-start-end-radius" => {
                Self::Radius(RadiusTarget::Logical(LogicalCorner::StartEnd))
            }
            "border-end-start-radius" => {
                Self::Radius(RadiusTarget::Logical(LogicalCorner::EndStart))
            }
            "border-end-end-radius" => Self::Radius(RadiusTarget::Logical(LogicalCorner::EndEnd)),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CssWide {
    Initial,
    Inherit,
}

impl CssWide {
    pub(super) fn from_value(value: &CssValue, style: &ComputedStyle) -> Option<Self> {
        let raw = resolved_raw_css_value(value, &style.custom_properties)?;
        match raw.trim().to_ascii_lowercase().as_str() {
            "inherit" => Some(Self::Inherit),
            "initial" | "unset" => Some(Self::Initial),
            _ => None,
        }
    }
}
