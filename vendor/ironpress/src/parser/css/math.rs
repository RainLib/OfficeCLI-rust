//! Typed CSS `<length-percentage>` mathematics.
//!
//! `cssparser` owns CSS tokenization. This module owns the typed expression
//! tree and used-value evaluation because LightningCSS currently folds some
//! CSS Values Level 4 expressions incorrectly and rejects valid unresolved
//! products. The percentage basis remains deferred until layout.

mod ast;
mod evaluate;
mod parser;
#[cfg(test)]
mod tests;

use ast::MathExpression;
use cssparser::{Parser, ParserInput, Token};

type ParseResult<'i, T> = Result<T, cssparser::ParseError<'i, ()>>;
// CSS requires at least 32 levels; the shared larger ceiling bounds untrusted recursion.
const MAX_CALC_COMPLEXITY: usize = 128;

fn is_math_function(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "calc"
            | "min"
            | "max"
            | "clamp"
            | "round"
            | "rem"
            | "mod"
            | "sin"
            | "cos"
            | "tan"
            | "asin"
            | "acos"
            | "atan"
            | "atan2"
            | "pow"
            | "sqrt"
            | "hypot"
            | "log"
            | "exp"
            | "abs"
            | "sign"
    )
}

fn contains_pending_variable<'i, 't>(
    input: &mut Parser<'i, 't>,
    nesting: usize,
) -> ParseResult<'i, bool> {
    if nesting > MAX_CALC_COMPLEXITY {
        return Err(input.new_custom_error(()));
    }
    let mut found = false;
    while !input.is_exhausted() {
        let token = input.next()?.clone();
        match token {
            Token::Function(name) if name.eq_ignore_ascii_case("var") => {
                input.parse_nested_block(|arguments| {
                    let name = arguments.expect_ident_cloned()?;
                    if !name.starts_with("--") || name.as_ref() == "--" {
                        return Err(arguments.new_custom_error(()));
                    }
                    if !arguments.is_exhausted() {
                        arguments.expect_comma()?;
                        contains_pending_variable(arguments, nesting + 1)?;
                    }
                    Ok(())
                })?;
                found = true;
            }
            Token::Function(_)
            | Token::ParenthesisBlock
            | Token::SquareBracketBlock
            | Token::CurlyBracketBlock => {
                found |= input
                    .parse_nested_block(|nested| contains_pending_variable(nested, nesting + 1))?;
            }
            _ => {}
        }
    }
    Ok(found)
}

/// An affine `<length-percentage>` over its eventual percentage basis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LengthPercent {
    length: f32,
    percent: f32,
}

impl LengthPercent {
    pub const ZERO: Self = Self::length(0.0);

    pub const fn length(length: f32) -> Self {
        Self {
            length,
            percent: 0.0,
        }
    }

    pub const fn percent(percent: f32) -> Self {
        Self {
            length: 0.0,
            percent,
        }
    }

    pub const fn from_terms(length: f32, percent: f32) -> Self {
        Self { length, percent }
    }

    pub fn resolve(self, basis: f32) -> f32 {
        self.length + basis * self.percent / 100.0
    }

    pub const fn is_absolute(self) -> bool {
        self.percent == 0.0
    }

    pub const fn absolute_length(self) -> Option<f32> {
        if self.is_absolute() {
            Some(self.length)
        } else {
            None
        }
    }

    pub(crate) const fn terms(self) -> (f32, f32) {
        (self.length, self.percent)
    }
}

impl std::ops::Add for LengthPercent {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self::from_terms(self.length + rhs.length, self.percent + rhs.percent)
    }
}

impl std::ops::Sub for LengthPercent {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Self::from_terms(self.length - rhs.length, self.percent - rhs.percent)
    }
}

impl From<(f32, bool)> for LengthPercent {
    fn from((value, is_percent): (f32, bool)) -> Self {
        if is_percent {
            Self::percent(value)
        } else {
            Self::length(value)
        }
    }
}

/// Used values for current-element and root-element font-relative units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontRelativeLengths {
    pub em: f32,
    pub rem: f32,
    pub ex: f32,
    pub rex: f32,
    pub ch: f32,
    pub rch: f32,
    pub cap: f32,
    pub rcap: f32,
    pub ic: f32,
    pub ric: f32,
    pub lh: f32,
    pub rlh: f32,
}

impl FontRelativeLengths {
    /// CSS Values fallbacks when the font does not expose an optional metric.
    pub const fn from_font_sizes(em: f32, rem: f32) -> Self {
        Self {
            em,
            rem,
            ex: em * 0.5,
            rex: rem * 0.5,
            ch: em * 0.5,
            rch: rem * 0.5,
            cap: em,
            rcap: rem,
            ic: em,
            ric: rem,
            lh: em,
            rlh: rem,
        }
    }
}

/// Physical and logical axes of the paged viewport.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportLengths {
    pub width: f32,
    pub height: f32,
    pub inline: f32,
    pub block: f32,
}

impl ViewportLengths {
    pub const fn horizontal_writing_mode(width: f32, height: f32) -> Self {
        Self {
            width,
            height,
            inline: width,
            block: height,
        }
    }
}

/// All non-percentage information required to evaluate CSS length math.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MathUnitContext {
    pub font: FontRelativeLengths,
    pub viewport: ViewportLengths,
}

impl MathUnitContext {
    pub const fn from_font_and_viewport(
        font_size: f32,
        root_font_size: f32,
        viewport_width: f32,
        viewport_height: f32,
    ) -> Self {
        Self {
            font: FontRelativeLengths::from_font_sizes(font_size, root_font_size),
            viewport: ViewportLengths::horizontal_writing_mode(viewport_width, viewport_height),
        }
    }
}

/// One grammar-checked CSS math expression with length-percentage result type.
#[derive(Debug, Clone, PartialEq)]
pub struct CssMathExpression {
    source: String,
    expression: MathExpression,
}

/// A math expression whose grammar becomes knowable after `var()` substitution.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingMathExpression {
    source: String,
}

impl PendingMathExpression {
    pub fn parse(input: &str) -> Option<Self> {
        let source = input.trim();
        let mut parser_input = ParserInput::new(source);
        let mut parser = Parser::new(&mut parser_input);
        let contains_variable = parser
            .parse_entirely(|input| {
                let Token::Function(name) = input.next()?.clone() else {
                    return Err(input.new_custom_error(()));
                };
                if !is_math_function(&name) {
                    return Err(input.new_custom_error(()));
                }
                input.parse_nested_block(|nested| contains_pending_variable(nested, 1))
            })
            .ok()?;

        contains_variable.then(|| Self {
            source: source.to_string(),
        })
    }

    pub(crate) fn source(&self) -> &str {
        &self.source
    }
}

impl CssMathExpression {
    pub fn parse(input: &str) -> Option<Self> {
        let source = input.trim();
        let expression = parser::parse(source)?;
        expression.math_type()?.is_length().then(|| Self {
            source: source.to_string(),
            expression,
        })
    }

    pub fn resolve(&self, units: MathUnitContext, percentage_basis: f32) -> Option<f32> {
        evaluate::resolve(&self.expression, units, percentage_basis)
    }

    /// Resolve fixed units while retaining a linear percentage term.
    pub fn affine(&self, units: MathUnitContext) -> Option<LengthPercent> {
        evaluate::affine(&self.expression, units)
    }

    pub fn contains_percentage(&self) -> bool {
        self.expression.contains_percentage()
    }

    pub fn to_css_string(&self) -> Option<String> {
        Some(self.source.clone())
    }
}
