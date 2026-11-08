use super::*;

mod declaration;
mod mapping;
mod values;

use declaration::*;
use mapping::*;
pub(in crate::style::computed) use values::parse_border_style;
use values::*;

pub(super) fn is_border_property(property: &str) -> bool {
    BorderDeclaration::parse(property).is_some()
}

pub(super) fn apply(
    style: &mut ComputedStyle,
    map: &StyleMap,
    parent: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) {
    let mapping = FlowMapping::from_style(style);
    let parent_mapping = FlowMapping::from_style(parent);
    for property in &map.declaration_order {
        let Some(declaration) = BorderDeclaration::parse(property) else {
            continue;
        };
        let Some(value) = map.get(property) else {
            continue;
        };
        if let Some(keyword) = CssWide::from_value(value, style) {
            apply_css_wide(style, parent, declaration, keyword, mapping, parent_mapping);
            continue;
        }
        match declaration {
            BorderDeclaration::Sides(declaration) => apply_side_value(
                style,
                declaration,
                value,
                mapping,
                length_context,
                font_metrics,
            ),
            BorderDeclaration::Radius(target) => {
                apply_radius_value(style, target, value, mapping, length_context, font_metrics)
            }
        }
    }
}

fn apply_css_wide(
    style: &mut ComputedStyle,
    parent: &ComputedStyle,
    declaration: BorderDeclaration,
    keyword: CssWide,
    mapping: FlowMapping,
    parent_mapping: FlowMapping,
) {
    match declaration {
        BorderDeclaration::Sides(declaration) => {
            declaration.targets.for_each(|selector| {
                let target = selector.physical(mapping);
                let source = match keyword {
                    CssWide::Initial => BorderSide::default(),
                    CssWide::Inherit => *parent.border.get(selector.physical(parent_mapping)),
                };
                let target = style.border.get_mut(target);
                copy_component(target, source, declaration.component);
            });
        }
        BorderDeclaration::Radius(target) => {
            target.for_each(mapping, |corner| {
                let value = match keyword {
                    CssWide::Initial => SpecifiedCornerRadius::default(),
                    CssWide::Inherit => {
                        let source = target.source_corner(corner, parent_mapping);
                        parent.border_radii.get(source)
                    }
                };
                style.border_radii.set(corner, value);
            });
        }
    }
}

impl SideTargets {
    fn for_each(self, mut visit: impl FnMut(SideSelector)) {
        match self {
            Self::AllPhysical => {
                for side in [
                    PhysicalSide::Top,
                    PhysicalSide::Right,
                    PhysicalSide::Bottom,
                    PhysicalSide::Left,
                ] {
                    visit(SideSelector::Physical(side));
                }
            }
            Self::One(side) => visit(side),
            Self::LogicalAxis(axis) => {
                for side in axis.sides() {
                    visit(SideSelector::Logical(side));
                }
            }
        }
    }
}

fn copy_component(target: &mut BorderSide, source: BorderSide, component: SideComponent) {
    match component {
        SideComponent::All => *target = source,
        SideComponent::Width => target.specified_width = source.specified_width,
        SideComponent::Style => target.style = source.style,
        SideComponent::Color => target.color = source.color,
    }
}

impl RadiusTarget {
    fn for_each(self, mapping: FlowMapping, mut visit: impl FnMut(PhysicalCorner)) {
        match self {
            Self::AllPhysical => {
                for corner in [
                    PhysicalCorner::TopLeft,
                    PhysicalCorner::TopRight,
                    PhysicalCorner::BottomRight,
                    PhysicalCorner::BottomLeft,
                ] {
                    visit(corner);
                }
            }
            Self::Physical(corner) => visit(corner),
            Self::Logical(corner) => visit(mapping.corner(corner)),
        }
    }

    const fn source_corner(
        self,
        target: PhysicalCorner,
        parent_mapping: FlowMapping,
    ) -> PhysicalCorner {
        match self {
            Self::AllPhysical | Self::Physical(_) => target,
            Self::Logical(logical) => parent_mapping.corner(logical),
        }
    }
}

impl SpecifiedCornerRadii {
    const fn get(self, corner: PhysicalCorner) -> SpecifiedCornerRadius {
        match corner {
            PhysicalCorner::TopLeft => self.top_left,
            PhysicalCorner::TopRight => self.top_right,
            PhysicalCorner::BottomRight => self.bottom_right,
            PhysicalCorner::BottomLeft => self.bottom_left,
        }
    }

    fn set(&mut self, corner: PhysicalCorner, value: SpecifiedCornerRadius) {
        match corner {
            PhysicalCorner::TopLeft => self.top_left = value,
            PhysicalCorner::TopRight => self.top_right = value,
            PhysicalCorner::BottomRight => self.bottom_right = value,
            PhysicalCorner::BottomLeft => self.bottom_left = value,
        }
    }
}
