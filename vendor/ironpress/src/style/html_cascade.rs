use std::collections::HashMap;

use crate::parser::css::{CssValue, SelectorContext, StyleMap};
use crate::parser::dom::HtmlTag;
use crate::types::Color;

const CSS_PIXEL_IN_POINTS: f32 = 0.75;

/// Browser-compatible base colour for legacy inset/outset table borders.
const LEGACY_TABLE_BORDER_COLOR: Color = Color {
    r: 238.0,
    g: 238.0,
    b: 238.0,
    a: 255.0,
};

/// HTML-defined additions to the CSS cascade for one element.
///
/// Contextual UA rules precede every author declaration. Presentational hints
/// participate at author origin with zero specificity, before stylesheet and
/// inline declarations.
#[derive(Debug, Default)]
pub(crate) struct HtmlCascadeLayers {
    pub(crate) ua: StyleMap,
    pub(crate) presentational_hints: StyleMap,
}

#[derive(Debug, Clone, Copy)]
struct LegacyTableBorder {
    width: f32,
    enables_ua_border: bool,
}

fn parse_non_negative_integer(source: &str) -> Option<u32> {
    let mut bytes = source
        .bytes()
        .skip_while(|byte| byte.is_ascii_whitespace())
        .peekable();
    if bytes.peek() == Some(&b'+') {
        bytes.next();
    }
    if !bytes.peek().is_some_and(u8::is_ascii_digit) {
        return None;
    }

    let mut value = 0_u32;
    while let Some(digit) = bytes.next_if(u8::is_ascii_digit) {
        value = value
            .saturating_mul(10)
            .saturating_add(u32::from(digit - b'0'));
    }
    Some(value)
}

fn pixel_length_attribute(attributes: &HashMap<String, String>, name: &str) -> Option<f32> {
    parse_non_negative_integer(attributes.get(name)?)
        .map(|pixels| pixels as f32 * CSS_PIXEL_IN_POINTS)
}

fn legacy_table_border(attributes: &HashMap<String, String>) -> Option<LegacyTableBorder> {
    let source = attributes.get("border")?;
    let parsed = parse_non_negative_integer(source);
    let pixels = parsed.unwrap_or(1);
    Some(LegacyTableBorder {
        width: pixels as f32 * CSS_PIXEL_IN_POINTS,
        enables_ua_border: parsed.is_none_or(|value| value != 0),
    })
}

fn set_physical_edges(style: &mut StyleMap, property: &str, value: CssValue) {
    for side in ["top", "right", "bottom", "left"] {
        style.set(&format!("border-{side}-{property}"), value.clone());
    }
}

fn set_legacy_border_ua(style: &mut StyleMap, border_style: &str, width: Option<f32>) {
    if let Some(width) = width {
        set_physical_edges(style, "width", CssValue::Length(width));
    }
    set_physical_edges(style, "style", CssValue::Keyword(border_style.to_string()));
    set_physical_edges(
        style,
        "color",
        CssValue::Color(LEGACY_TABLE_BORDER_COLOR.into()),
    );
}

fn nearest_table_attributes<'a>(
    selector_context: &'a SelectorContext<'a>,
) -> Option<&'a HashMap<String, String>> {
    selector_context
        .ancestors
        .iter()
        .rev()
        .find(|ancestor| ancestor.element.tag == HtmlTag::Table)
        .map(|ancestor| &ancestor.element.attributes)
}

/// Build the HTML UA and presentational-hint layers that depend on attributes
/// or ancestry and therefore cannot live in the tag-only default stylesheet.
pub(crate) fn html_cascade_layers(
    tag: HtmlTag,
    attributes: &HashMap<String, String>,
    selector_context: &SelectorContext<'_>,
) -> HtmlCascadeLayers {
    let mut layers = HtmlCascadeLayers::default();

    if tag == HtmlTag::Table {
        if let Some(border) = legacy_table_border(attributes) {
            set_physical_edges(
                &mut layers.presentational_hints,
                "width",
                CssValue::Length(border.width),
            );
            if border.enables_ua_border {
                set_legacy_border_ua(&mut layers.ua, "outset", None);
            }
        }
        if let Some(spacing) = pixel_length_attribute(attributes, "cellspacing") {
            layers
                .presentational_hints
                .set("border-spacing", CssValue::Length(spacing));
        }
    }

    if matches!(tag, HtmlTag::Td | HtmlTag::Th)
        && let Some(table_attributes) = nearest_table_attributes(selector_context)
    {
        if let Some(padding) = pixel_length_attribute(table_attributes, "cellpadding") {
            for side in ["top", "right", "bottom", "left"] {
                layers
                    .presentational_hints
                    .set(&format!("padding-{side}"), CssValue::Length(padding));
            }
        }
        if legacy_table_border(table_attributes).is_some_and(|border| border.enables_ua_border) {
            set_legacy_border_ua(&mut layers.ua, "inset", Some(CSS_PIXEL_IN_POINTS));
        }
    }

    layers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_integer_parser_accepts_the_standard_prefix_and_rejects_sign_errors() {
        assert_eq!(parse_non_negative_integer("  +14px"), Some(14));
        assert_eq!(parse_non_negative_integer("-1"), None);
        assert_eq!(parse_non_negative_integer("px"), None);
    }

    #[test]
    fn invalid_table_border_uses_the_html_default_pixel() {
        let attributes = HashMap::from([("border".to_string(), "invalid".to_string())]);
        assert_eq!(
            legacy_table_border(&attributes).map(|border| border.width),
            Some(CSS_PIXEL_IN_POINTS)
        );
    }
}
