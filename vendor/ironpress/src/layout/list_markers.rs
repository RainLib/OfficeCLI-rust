use crate::style::computed::{CounterStyle, CounterStyleSystem, ListStyleType, VerticalAlign};
use crate::types::{Color, CornerRadii, EdgeSizes};

use super::engine::{CenteredStroke, InlineBox, InlineBoxPaint};

/// The marker slot used by a built-in unordered-list bullet.
///
/// Chromium gives a standalone inside marker a wider inline slot than a marker
/// hanging in a list container. The painted bullet geometry itself is shared.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) enum BuiltInBulletSlot {
    #[default]
    List,
    StandaloneInside,
}

/// A predefined unordered-list marker whose appearance is supplied by the UA.
///
/// These are shapes rather than Unicode stand-ins. Keeping that distinction at
/// the list-marker boundary prevents font fallback, glyph metrics, or text
/// shaping from changing their paint.
#[derive(Debug, Clone, Copy)]
enum BuiltInBulletShape {
    Disc,
    Circle,
    Square,
}

impl BuiltInBulletShape {
    const CIRCLE_STROKE_WIDTH: f32 = crate::fonts::PT_PER_CSS_PX;

    fn from_style(style: &ListStyleType) -> Option<Self> {
        match style {
            ListStyleType::Disc => Some(Self::Disc),
            ListStyleType::Circle => Some(Self::Circle),
            ListStyleType::Square => Some(Self::Square),
            _ => None,
        }
    }

    fn paint(self, color: Color, size: f32) -> InlineBoxPaint {
        let border_radii = match self {
            Self::Disc | Self::Circle => CornerRadii::circular(size / 2.0),
            Self::Square => CornerRadii::default(),
        };
        InlineBoxPaint {
            background_color: matches!(self, Self::Disc | Self::Square).then_some(color),
            border_radii,
            centered_stroke: matches!(self, Self::Circle)
                .then(|| CenteredStroke::solid(Self::CIRCLE_STROKE_WIDTH, color)),
            ..InlineBoxPaint::default()
        }
    }
}

/// Geometry shared by Chromium's built-in list bullets.
///
/// Painted bounds, inline advance, and baseline position form one unit. Using
/// Unicode glyph advances would move the three predefined shapes to different
/// positions even though Chromium places them in the same marker slot.
#[derive(Debug, Clone, Copy)]
struct BuiltInBulletMetrics {
    size: f32,
    advance: f32,
    center_above_baseline: f32,
}

impl BuiltInBulletMetrics {
    fn from_font_size(font_size: f32, slot: BuiltInBulletSlot) -> Self {
        // Chromium quantizes built-in bullets to whole CSS pixels. At 22 CSS px
        // this yields a 7 CSS-px marker; at 30 CSS px it yields 9 CSS px.
        let size = ((font_size / crate::fonts::PT_PER_CSS_PX) * 0.32).floor()
            * crate::fonts::PT_PER_CSS_PX;
        let advance = match slot {
            // Measured from the locked Chromium oracle: a 20 CSS-px outside
            // marker slot at a 22 CSS-px font.
            BuiltInBulletSlot::List => font_size * (10.0 / 11.0),
            // A standalone `display: list-item; list-style-position: inside`
            // has no list padding to hang into, so Chromium gives its inline
            // marker a 40 CSS-px slot at a 30 CSS-px font.
            BuiltInBulletSlot::StandaloneInside => font_size * (4.0 / 3.0),
        };

        Self {
            size,
            advance,
            // The marker centre sits half a CSS pixel below its painted size
            // above the baseline in Chromium's PDF output.
            center_above_baseline: size - crate::fonts::PT_PER_CSS_PX / 2.0,
        }
    }
}

/// Build a predefined `disc`, `circle`, or `square` marker as an atomic box.
///
/// The returned border box owns the complete marker geometry and inline slot.
/// Author-provided marker strings stay on the textual path.
pub(crate) fn build_list_bullet_marker(
    list_style_type: &ListStyleType,
    font_size: f32,
    color: Color,
    slot: BuiltInBulletSlot,
) -> Option<InlineBox> {
    let shape = BuiltInBulletShape::from_style(list_style_type)?;
    let metrics = BuiltInBulletMetrics::from_font_size(font_size, slot);
    Some(InlineBox {
        width: metrics.size,
        height: metrics.size,
        margin_right: metrics.advance - metrics.size,
        paint: shape.paint(color, metrics.size),
        vertical_align: VerticalAlign::Baseline,
        baseline_ascent: Some(metrics.center_above_baseline + metrics.size / 2.0),
        padding: EdgeSizes::ZERO,
        ..InlineBox::default()
    })
}

pub(crate) fn format_list_marker(list_style_type: &ListStyleType, index: i32) -> String {
    match list_style_type {
        ListStyleType::Disc => "\u{2022} ".to_string(),
        ListStyleType::Circle => "\u{25E6} ".to_string(),
        ListStyleType::Square => "\u{25AA} ".to_string(),
        ListStyleType::Decimal => format!("{index}. "),
        ListStyleType::DecimalLeadingZero => {
            if index < 0 {
                format!("-{:02}. ", (index as i64).unsigned_abs())
            } else {
                format!("{index:02}. ")
            }
        }
        ListStyleType::LowerAlpha => format_positive_marker(index, to_alpha_lower),
        ListStyleType::UpperAlpha => format_positive_marker(index, to_alpha_upper),
        ListStyleType::LowerRoman => format_positive_marker(index, to_roman_lower),
        ListStyleType::UpperRoman => format_positive_marker(index, to_roman_upper),
        ListStyleType::CjkDecimal if index > 0 => {
            format!("{}、", to_cjk_decimal(index as usize))
        }
        ListStyleType::CjkDecimal => format!("{index}、"),
        ListStyleType::String(marker) => marker.clone(),
        ListStyleType::CounterStyle(style) => format_custom_counter(style, index, true),
        ListStyleType::Custom(_) => format!("{index}. "),
        ListStyleType::None => String::new(),
    }
}

fn format_positive_marker(index: i32, formatter: fn(usize) -> String) -> String {
    if index <= 0 {
        format!("{index}. ")
    } else {
        format!("{}. ", formatter(index as usize))
    }
}

pub(crate) fn to_alpha_lower(n: usize) -> String {
    if n == 0 {
        return "a".to_string();
    }
    let mut result = String::new();
    let mut val = n;
    while val > 0 {
        val -= 1;
        result.insert(0, (b'a' + (val % 26) as u8) as char);
        val /= 26;
    }
    result
}

pub(crate) fn to_alpha_upper(n: usize) -> String {
    to_alpha_lower(n).to_uppercase()
}

pub(crate) fn to_roman_lower(n: usize) -> String {
    let vals = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut result = String::new();
    let mut remaining = n;
    for &(value, numeral) in &vals {
        while remaining >= value {
            result.push_str(numeral);
            remaining -= value;
        }
    }
    if result.is_empty() {
        "0".to_string()
    } else {
        result
    }
}

pub(crate) fn to_roman_upper(n: usize) -> String {
    to_roman_lower(n).to_uppercase()
}

fn to_cjk_decimal(n: usize) -> String {
    const DIGITS: [&str; 10] = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if n == 0 {
        return DIGITS[0].to_string();
    }
    n.to_string()
        .chars()
        .filter_map(|ch| ch.to_digit(10).map(|d| DIGITS[d as usize]))
        .collect()
}

/// Format a counter value without the marker prefix or suffix.
pub(crate) fn format_counter_value(style: &ListStyleType, value: i32) -> String {
    // Roman/alpha styles are defined only for positive integers; other values
    // fall back to decimal according to CSS Counter Styles.
    if value <= 0 && !matches!(style, ListStyleType::CounterStyle(_)) {
        return value.to_string();
    }
    let n = value as usize;
    match style {
        ListStyleType::DecimalLeadingZero => format!("{n:02}"),
        ListStyleType::LowerAlpha => to_alpha_lower(n),
        ListStyleType::UpperAlpha => to_alpha_upper(n),
        ListStyleType::LowerRoman => to_roman_lower(n),
        ListStyleType::UpperRoman => to_roman_upper(n),
        ListStyleType::CjkDecimal => to_cjk_decimal(n),
        ListStyleType::CounterStyle(custom) => format_custom_counter(custom, value, false),
        _ => value.to_string(),
    }
}

fn format_custom_counter(style: &CounterStyle, value: i32, include_affixes: bool) -> String {
    let negative = value < 0;
    let abs_value = (value as i64).unsigned_abs() as usize;
    let mut representation = match style.system {
        CounterStyleSystem::Cyclic if !style.symbols.is_empty() => {
            let index = if abs_value == 0 {
                0
            } else {
                (abs_value - 1) % style.symbols.len()
            };
            style.symbols[index].clone()
        }
        CounterStyleSystem::Cyclic | CounterStyleSystem::ExtendsDecimal => abs_value.to_string(),
    };
    if let Some((width, pad_symbol)) = &style.pad {
        while representation.chars().count() < *width {
            representation.insert_str(0, pad_symbol);
        }
    }
    if negative {
        representation = format!("{}{}{}", style.negative.0, representation, style.negative.1);
    }
    if include_affixes {
        format!("{}{}{}", style.prefix, representation, style.suffix)
    } else {
        representation
    }
}
