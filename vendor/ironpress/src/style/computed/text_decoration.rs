use std::ops::{BitOr, BitOrAssign};

use crate::types::Color;

/// The CSS line kinds painted by one text-decoration origin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TextDecorationLines {
    pub underline: bool,
    pub overline: bool,
    pub line_through: bool,
}

impl TextDecorationLines {
    pub const fn any(self) -> bool {
        self.underline || self.overline || self.line_through
    }
}

impl BitOr for TextDecorationLines {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self {
            underline: self.underline || rhs.underline,
            overline: self.overline || rhs.overline,
            line_through: self.line_through || rhs.line_through,
        }
    }
}

impl BitOrAssign for TextDecorationLines {
    fn bitor_assign(&mut self, rhs: Self) {
        *self = *self | rhs;
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TextDecorationStyle {
    #[default]
    Solid,
    Wavy,
}

/// CSS `text-decoration-skip-ink` behavior captured by a decoration origin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TextDecorationSkipInk {
    #[default]
    Auto,
    None,
    All,
}

impl TextDecorationSkipInk {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "auto" => Some(Self::Auto),
            "none" => Some(Self::None),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

/// Complete computed state for one text-decoration origin.
///
/// Keeping line selection, geometry, paint, and ink-skipping together prevents
/// layout and render backends from silently reconstructing incompatible
/// decoration state. `None` color retains CSS `currentColor` semantics.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextDecoration {
    pub lines: TextDecorationLines,
    pub style: TextDecorationStyle,
    pub skip_ink: TextDecorationSkipInk,
    pub thickness: Option<f32>,
    pub underline_offset: Option<f32>,
    pub color: Option<Color>,
}

impl TextDecoration {
    pub const fn is_empty(self) -> bool {
        !self.lines.any()
    }

    pub fn resolved_color(self, current_color: Color) -> Color {
        self.color.unwrap_or(current_color)
    }

    pub fn with_resolved_color(mut self, current_color: Color) -> Self {
        self.color = Some(self.resolved_color(current_color));
        self
    }
}

/// Computed text-decoration state with origin-preserving propagation.
///
/// The four `text-decoration` longhands are not inherited. Each element owns
/// `current`, while ancestor origins travel separately in `propagated` so a
/// descendant can add another independently styled line without overwriting
/// the ancestor's decoration. The inherited underline controls live on
/// `current` until that element originates a line, at which point they are
/// captured with that origin.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextDecorations {
    pub current: TextDecoration,
    propagated: Vec<TextDecoration>,
}

impl TextDecorations {
    pub fn for_descendant(
        parent: &Self,
        parent_color: Color,
        include_propagated_origins: bool,
    ) -> Self {
        let mut propagated = if include_propagated_origins {
            parent.propagated.clone()
        } else {
            Vec::new()
        };
        if !parent.current.is_empty() {
            propagated.push(parent.current.with_resolved_color(parent_color));
        }
        Self {
            current: TextDecoration {
                skip_ink: parent.current.skip_ink,
                underline_offset: parent.current.underline_offset,
                ..Default::default()
            },
            propagated,
        }
    }

    pub fn active(&self, current_color: Color) -> Vec<TextDecoration> {
        let mut active = self.propagated.clone();
        if !self.current.is_empty() {
            active.push(self.current.with_resolved_color(current_color));
        }
        active
    }

    pub fn clear_propagated(&mut self) {
        self.propagated.clear();
    }
}
