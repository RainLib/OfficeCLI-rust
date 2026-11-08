use super::*;

impl std::str::FromStr for BorderStyle {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "solid" => Ok(Self::Solid),
            "dashed" => Ok(Self::Dashed),
            "dotted" => Ok(Self::Dotted),
            "double" => Ok(Self::Double),
            "groove" => Ok(Self::Groove),
            "ridge" => Ok(Self::Ridge),
            "inset" => Ok(Self::Inset),
            "outset" => Ok(Self::Outset),
            "hidden" => Ok(Self::Hidden),
            "none" => Ok(Self::None),
            _ => Err(()),
        }
    }
}

pub(super) fn apply_side_value(
    style: &mut ComputedStyle,
    declaration: SideDeclaration,
    value: &CssValue,
    mapping: FlowMapping,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) {
    match (declaration.targets, declaration.component) {
        (SideTargets::AllPhysical, SideComponent::All) => {
            if let Some(side) = parse_side(value, style, length_context, font_metrics) {
                style.border = PhysicalEdges::uniform(side);
            }
        }
        (SideTargets::AllPhysical, component) => {
            apply_physical_values(style, component, value, length_context, font_metrics)
        }
        (SideTargets::One(selector), SideComponent::All) => {
            if let Some(side) = parse_side(value, style, length_context, font_metrics) {
                *style.border.get_mut(selector.physical(mapping)) = side;
            }
        }
        (SideTargets::One(selector), component) => {
            if let Some(component_value) =
                parse_component(value, component, style, length_context, font_metrics)
            {
                set_component(
                    style.border.get_mut(selector.physical(mapping)),
                    component_value,
                );
            }
        }
        (SideTargets::LogicalAxis(axis), SideComponent::All) => {
            if let Some(side) = parse_side(value, style, length_context, font_metrics) {
                for logical in axis.sides() {
                    *style.border.get_mut(mapping.side(logical)) = side;
                }
            }
        }
        (SideTargets::LogicalAxis(axis), component) => {
            let Some(values) =
                parse_axis_components(value, component, style, length_context, font_metrics)
            else {
                return;
            };
            for (logical, value) in axis.sides().into_iter().zip(values) {
                set_component(style.border.get_mut(mapping.side(logical)), value);
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ComponentValue {
    Width(f32),
    Style(BorderStyle),
    Color(SpecifiedColor),
}

fn set_component(side: &mut BorderSide, value: ComponentValue) {
    match value {
        ComponentValue::Width(value) => side.specified_width = value,
        ComponentValue::Style(value) => side.style = value,
        ComponentValue::Color(value) => side.color = value,
    }
}

fn parse_side(
    value: &CssValue,
    style: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) -> Option<BorderSide> {
    let raw = resolved_raw_css_value(value, &style.custom_properties)?;
    let (without_function_color, function_color) = extract_border_function_color(&raw);
    let mut side = BorderSide::default();
    let mut color = function_color;
    for token in split_css_whitespace(&without_function_color) {
        if let Some(width) = parse_border_width_token(token, style, length_context, font_metrics) {
            side.specified_width = width;
        } else if let Some(border_style) = parse_border_style(token) {
            side.style = border_style;
        } else {
            let parsed_color = parse_border_color(token)?;
            color = Some(parsed_color);
        }
    }
    side.color = color.unwrap_or(SpecifiedColor::CurrentColor);
    Some(side)
}

pub(in crate::style::computed) fn parse_border_style(raw: &str) -> Option<BorderStyle> {
    raw.parse().ok()
}

fn parse_border_style_shorthand_values(raw: &str) -> Option<[BorderStyle; 4]> {
    let parts = split_css_whitespace(raw);
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let values = parts
        .into_iter()
        .map(parse_border_style)
        .collect::<Option<Vec<_>>>()?;
    expand_box_values(&values)
}

fn parse_component(
    value: &CssValue,
    component: SideComponent,
    style: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) -> Option<ComponentValue> {
    match component {
        SideComponent::Width => parse_single_width(value, style, length_context, font_metrics)
            .map(ComponentValue::Width),
        SideComponent::Style => resolved_raw_css_value(value, &style.custom_properties)
            .and_then(|raw| parse_border_style(&raw))
            .map(ComponentValue::Style),
        SideComponent::Color => {
            specified_color_from_value(value, &style.custom_properties).map(ComponentValue::Color)
        }
        SideComponent::All => None,
    }
}

fn parse_single_width(
    value: &CssValue,
    style: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) -> Option<f32> {
    if let Some(value) = resolve_css_length_for_style(value, style, length_context, font_metrics) {
        return (value >= 0.0).then_some(value);
    }
    let raw = resolved_raw_css_value(value, &style.custom_properties)?;
    parse_border_width_token(&raw, style, length_context, font_metrics)
}

fn parse_axis_components(
    value: &CssValue,
    component: SideComponent,
    style: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) -> Option<[ComponentValue; 2]> {
    if let Some(single) = parse_component(value, component, style, length_context, font_metrics) {
        return Some([single; 2]);
    }
    let raw = resolved_raw_css_value(value, &style.custom_properties)?;
    let parts = split_css_whitespace(&raw);
    let [start, end] = match parts.as_slice() {
        [both] => [*both, *both],
        [start, end] => [*start, *end],
        _ => return None,
    };
    let parse = |raw: &str| match component {
        SideComponent::Width => parse_border_width_token(raw, style, length_context, font_metrics)
            .map(ComponentValue::Width),
        SideComponent::Style => parse_border_style(raw).map(ComponentValue::Style),
        SideComponent::Color => parse_border_color(raw).map(ComponentValue::Color),
        SideComponent::All => None,
    };
    Some([parse(start)?, parse(end)?])
}

fn apply_physical_values(
    style: &mut ComputedStyle,
    component: SideComponent,
    value: &CssValue,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) {
    let values = match component {
        SideComponent::Width => parse_physical_widths(value, style, length_context, font_metrics)
            .map(|values| values.map(ComponentValue::Width)),
        SideComponent::Style => resolved_raw_css_value(value, &style.custom_properties)
            .and_then(|raw| parse_border_style_shorthand_values(&raw))
            .map(|values| PhysicalEdges::from_array(values.map(ComponentValue::Style))),
        SideComponent::Color => {
            if let Some(color) = specified_color_from_value(value, &style.custom_properties) {
                Some(PhysicalEdges::uniform(ComponentValue::Color(color)))
            } else {
                resolved_raw_css_value(value, &style.custom_properties)
                    .and_then(|raw| parse_border_color_shorthand_values(&raw))
                    .map(|values| PhysicalEdges::from_array(values.map(ComponentValue::Color)))
            }
        }
        SideComponent::All => None,
    };
    let Some(values) = values else {
        return;
    };
    for side in [
        PhysicalSide::Top,
        PhysicalSide::Right,
        PhysicalSide::Bottom,
        PhysicalSide::Left,
    ] {
        set_component(style.border.get_mut(side), *values.get(side));
    }
}

fn parse_physical_widths(
    value: &CssValue,
    style: &ComputedStyle,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) -> Option<EdgeSizes> {
    if let Some(width) = parse_single_width(value, style, length_context, font_metrics) {
        return Some(EdgeSizes::uniform(width));
    }
    let raw = resolved_raw_css_value(value, &style.custom_properties)?;
    parse_border_width_shorthand_values(&raw, style, length_context, font_metrics)
        .map(PhysicalEdges::from_array)
}

pub(super) fn apply_radius_value(
    style: &mut ComputedStyle,
    target: RadiusTarget,
    value: &CssValue,
    mapping: FlowMapping,
    length_context: crate::style::resolve::LengthResolutionContext,
    font_metrics: FontMetrics<'_>,
) {
    match target {
        RadiusTarget::AllPhysical => {
            if let Some(radii) =
                parse_border_radius_value(value, style, length_context, font_metrics)
            {
                style.border_radii = radii;
            }
        }
        RadiusTarget::Physical(corner) => {
            if let Some(radius) =
                parse_corner_radius_value(value, style, length_context, font_metrics)
            {
                style.border_radii.set(corner, radius);
            }
        }
        RadiusTarget::Logical(corner) => {
            if let Some(radius) =
                parse_corner_radius_value(value, style, length_context, font_metrics)
            {
                style.border_radii.set(mapping.corner(corner), radius);
            }
        }
    }
}
