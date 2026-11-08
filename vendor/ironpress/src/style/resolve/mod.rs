//! CSS value resolution for calc(), var(), and new unit types (%, em, rem, vw, vh).
use std::collections::{HashMap, HashSet};

use crate::parser::css::{CssValue, MathUnitContext};
use cssparser::{Parser, ParserInput, Token};

#[cfg(test)]
const DEFAULT_FONT_SIZE: f32 = 12.0;
#[cfg(test)]
const DEFAULT_PAGE_WIDTH: f32 = 595.28;
#[cfg(test)]
const DEFAULT_PAGE_HEIGHT: f32 = 841.89;
const MAX_VAR_COMPLEXITY: usize = 128;

#[derive(Debug, Clone, Copy)]
pub struct LengthResolutionContext {
    /// The containing-block dimension against which percentages resolve.
    pub percentage_basis: f32,
    /// Every non-percentage unit basis used by CSS math.
    pub units: MathUnitContext,
}

impl LengthResolutionContext {
    pub const fn new(percentage_basis: f32, units: MathUnitContext) -> Self {
        Self {
            percentage_basis,
            units,
        }
    }

    pub const fn with_percentage_basis(self, percentage_basis: f32) -> Self {
        Self {
            percentage_basis,
            ..self
        }
    }

    #[cfg(test)]
    pub const fn pdf_defaults(parent_width: f32) -> Self {
        Self::new(
            parent_width,
            MathUnitContext::from_font_and_viewport(
                DEFAULT_FONT_SIZE,
                DEFAULT_FONT_SIZE,
                DEFAULT_PAGE_WIDTH,
                DEFAULT_PAGE_HEIGHT,
            ),
        )
    }

    #[cfg(test)]
    pub const fn pdf_with_font_sizes(
        parent_width: f32,
        font_size: f32,
        root_font_size: f32,
    ) -> Self {
        Self::new(
            parent_width,
            MathUnitContext::from_font_and_viewport(
                font_size,
                root_font_size,
                DEFAULT_PAGE_WIDTH,
                DEFAULT_PAGE_HEIGHT,
            ),
        )
    }
}

impl From<&crate::layout::engine::LayoutContext> for LengthResolutionContext {
    fn from(ctx: &crate::layout::engine::LayoutContext) -> Self {
        Self {
            percentage_basis: ctx.parent.content_width,
            units: MathUnitContext::from_font_and_viewport(
                ctx.parent.font_size,
                ctx.root_font_size,
                ctx.viewport.width,
                ctx.viewport.height,
            ),
        }
    }
}

/// Resolve a CssValue to absolute length in points using a caller-provided
/// `font_size` basis for em units.
pub fn resolve_length_value_in_context(
    val: &CssValue,
    ctx: LengthResolutionContext,
    custom_properties: &HashMap<String, String>,
) -> Option<f32> {
    match val {
        CssValue::Length(v) => Some(*v),
        CssValue::Em(v) => Some(*v * ctx.units.font.em),
        CssValue::Number(v) if *v == 0.0 => Some(0.0),
        CssValue::Percentage(v) => Some(ctx.percentage_basis * v / 100.0),
        // ex/ch resolve against the element's own font metrics. The resolution
        // context does not carry the font, so use the css-values-4 fallbacks
        // (x-height ~= 0.5em, '0' advance ~= 0.5em). The `font-size` property —
        // where the metric matters most and the font *is* known — resolves these
        // with real metrics in `apply_style_map`.
        CssValue::Ex(v) => Some(*v * ctx.units.font.ex),
        CssValue::Ch(v) => Some(*v * ctx.units.font.ch),
        CssValue::Rem(v) => Some(*v * ctx.units.font.rem),
        CssValue::Vw(v) => Some(ctx.units.viewport.width * v / 100.0),
        CssValue::Vh(v) => Some(ctx.units.viewport.height * v / 100.0),
        CssValue::Vmin(v) => {
            Some(ctx.units.viewport.width.min(ctx.units.viewport.height) * v / 100.0)
        }
        CssValue::Vmax(v) => {
            Some(ctx.units.viewport.width.max(ctx.units.viewport.height) * v / 100.0)
        }
        CssValue::Math(expression) => expression.resolve(ctx.units, ctx.percentage_basis),
        CssValue::Var(name, fallback) => {
            let raw = resolve_var_to_string(name, fallback.as_deref(), custom_properties)?;
            let parsed = crate::parser::css::parse_inline_style(&format!("_x: {raw}"));
            parsed
                .get("_x")
                .and_then(|inner| resolve_length_value_in_context(inner, ctx, custom_properties))
        }
        _ => None,
    }
}

/// Resolve a CssValue to absolute length in points.
#[cfg(test)]
pub fn resolve_length_value(
    val: &CssValue,
    parent_width: f32,
    root_font_size: f32,
    page_width: f32,
    page_height: f32,
    custom_properties: &HashMap<String, String>,
) -> Option<f32> {
    resolve_length_value_in_context(
        val,
        LengthResolutionContext::new(
            parent_width,
            MathUnitContext::from_font_and_viewport(
                DEFAULT_FONT_SIZE,
                root_font_size,
                page_width,
                page_height,
            ),
        ),
        custom_properties,
    )
}

/// Try to resolve a CssValue to an absolute length using defaults.
#[cfg(test)]
pub fn try_resolve_to_length(
    val: &CssValue,
    custom_properties: &HashMap<String, String>,
    parent_width_hint: f32,
) -> Option<f32> {
    resolve_length_value_in_context(
        val,
        LengthResolutionContext::pdf_defaults(parent_width_hint),
        custom_properties,
    )
}

/// Try to resolve a CssValue to an absolute length using a caller-provided
/// `font_size` basis for em units.
pub fn try_resolve_to_length_in_context(
    val: &CssValue,
    custom_properties: &HashMap<String, String>,
    ctx: LengthResolutionContext,
) -> Option<f32> {
    resolve_length_value_in_context(val, ctx, custom_properties)
}

/// Try to resolve a CssValue to an absolute length using a caller-provided
/// `font_size` basis for em units.
#[cfg(test)]
pub fn try_resolve_to_length_with_font_size(
    val: &CssValue,
    custom_properties: &HashMap<String, String>,
    parent_width_hint: f32,
    font_size: f32,
    root_font_size: f32,
) -> Option<f32> {
    try_resolve_to_length_in_context(
        val,
        custom_properties,
        LengthResolutionContext::pdf_with_font_sizes(parent_width_hint, font_size, root_font_size),
    )
}

struct VarResolver<'a> {
    custom_properties: &'a HashMap<String, String>,
    visiting: HashSet<String>,
}

impl<'a> VarResolver<'a> {
    fn new(custom_properties: &'a HashMap<String, String>) -> Self {
        Self {
            custom_properties,
            visiting: HashSet::new(),
        }
    }

    fn resolve_var(&mut self, name: &str, fallback: Option<&str>) -> Option<String> {
        if self.visiting.contains(name) {
            return fallback.and_then(|value| self.resolve_raw(value));
        }
        if self.visiting.len() >= MAX_VAR_COMPLEXITY {
            return fallback.and_then(|value| self.resolve_raw(value));
        }

        let resolved = self
            .custom_properties
            .get(name)
            .map(String::as_str)
            .and_then(|raw| {
                self.visiting.insert(name.to_string());
                let result = self.resolve_raw(raw);
                self.visiting.remove(name);
                result
            });

        resolved.or_else(|| fallback.and_then(|value| self.resolve_raw(value)))
    }

    fn resolve_raw(&mut self, raw: &str) -> Option<String> {
        let mut input = ParserInput::new(raw);
        let mut parser = Parser::new(&mut input);
        let mut substitutions = Vec::new();
        parser
            .parse_entirely(|input| self.collect_substitutions(input, &mut substitutions, 0))
            .ok()?;
        if substitutions.is_empty() {
            return Some(raw.trim().to_string());
        }

        let mut output = String::with_capacity(raw.len());
        let mut copied_until = 0usize;
        for substitution in substitutions {
            output.push_str(raw.get(copied_until..substitution.start)?);
            // Custom properties substitute token streams. Spaces keep adjacent
            // source tokens from merging into a token that was never authored.
            output.push(' ');
            output.push_str(&substitution.value);
            output.push(' ');
            copied_until = substitution.end;
        }
        output.push_str(raw.get(copied_until..)?);
        Some(output.trim().to_string())
    }

    fn collect_substitutions<'i, 't>(
        &mut self,
        input: &mut Parser<'i, 't>,
        substitutions: &mut Vec<VariableSubstitution>,
        nesting: usize,
    ) -> Result<(), cssparser::ParseError<'i, ()>> {
        while !input.is_exhausted() {
            let start = input.position().byte_index();
            let token = input.next_including_whitespace_and_comments()?.clone();
            match token {
                Token::Function(name) if name.eq_ignore_ascii_case("var") => {
                    let value =
                        input.parse_nested_block(|arguments| self.resolve_arguments(arguments))?;
                    substitutions.push(VariableSubstitution {
                        start,
                        end: input.position().byte_index(),
                        value,
                    });
                }
                Token::Function(_)
                | Token::ParenthesisBlock
                | Token::SquareBracketBlock
                | Token::CurlyBracketBlock => {
                    if nesting >= MAX_VAR_COMPLEXITY {
                        return Err(input.new_custom_error(()));
                    }
                    input.parse_nested_block(|nested| {
                        self.collect_substitutions(nested, substitutions, nesting + 1)
                    })?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn resolve_arguments<'i, 't>(
        &mut self,
        arguments: &mut Parser<'i, 't>,
    ) -> Result<String, cssparser::ParseError<'i, ()>> {
        let name = arguments.expect_ident_cloned()?;
        if !name.starts_with("--") || name.as_ref() == "--" {
            return Err(arguments.new_custom_error(()));
        }
        let fallback = if arguments.is_exhausted() {
            None
        } else {
            arguments.expect_comma()?;
            let start = arguments.position();
            consume_component_values(arguments, 0)?;
            Some(arguments.slice_from(start).to_string())
        };
        self.resolve_var(&name, fallback.as_deref())
            .ok_or_else(|| arguments.new_custom_error(()))
    }
}

struct VariableSubstitution {
    start: usize,
    end: usize,
    value: String,
}

fn consume_component_values<'i, 't>(
    input: &mut Parser<'i, 't>,
    nesting: usize,
) -> Result<(), cssparser::ParseError<'i, ()>> {
    while !input.is_exhausted() {
        let token = input.next_including_whitespace_and_comments()?.clone();
        if matches!(
            token,
            Token::Function(_)
                | Token::ParenthesisBlock
                | Token::SquareBracketBlock
                | Token::CurlyBracketBlock
        ) {
            if nesting >= MAX_VAR_COMPLEXITY {
                return Err(input.new_custom_error(()));
            }
            input.parse_nested_block(|nested| consume_component_values(nested, nesting + 1))?;
        }
    }
    Ok(())
}

/// Resolve a var() name to its final value string, following nested aliases.
pub fn resolve_var_to_string(
    name: &str,
    fallback: Option<&str>,
    custom_properties: &HashMap<String, String>,
) -> Option<String> {
    VarResolver::new(custom_properties).resolve_var(name, fallback)
}

/// Substitute every custom-property reference in one pending property value.
pub(crate) fn resolve_vars_in_value(
    value: &str,
    custom_properties: &HashMap<String, String>,
) -> Option<String> {
    VarResolver::new(custom_properties).resolve_raw(value)
}

/// Try to resolve a CssValue::Var to a color.
pub fn try_resolve_var_to_color(
    val: &CssValue,
    custom_properties: &HashMap<String, String>,
) -> Option<crate::parser::css::SpecifiedColor> {
    if let CssValue::Var(name, fallback) = val {
        let raw = resolve_var_to_string(name, fallback.as_deref(), custom_properties)?;
        match crate::parser::css::parse_color(&raw) {
            Some(CssValue::Color(color)) => Some(color),
            _ => None,
        }
    } else {
        None
    }
}

/// Try to resolve a CssValue::Var to a keyword string.
pub fn try_resolve_var_to_keyword(
    val: &CssValue,
    custom_properties: &HashMap<String, String>,
) -> Option<String> {
    if let CssValue::Var(name, fallback) = val {
        resolve_var_to_string(name, fallback.as_deref(), custom_properties)
    } else {
        None
    }
}

#[cfg(test)]
mod tests;
