use super::*;

/// Parse-time validity for the independently cascaded border-image longhands.
///
/// Lightning supplies the typed grammar for ordinary declarations, but this
/// module also replays validated authored image sources to preserve gradient
/// syntax. Keeping the non-negative ranges here prevents that replay from
/// resurrecting a declaration the CSS grammar requires the cascade to ignore.
pub(super) fn border_image_longhand_is_valid(property: &str, value: &str) -> bool {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    if is_css_wide_keyword(&lower) {
        return true;
    }
    match property {
        "border-image-source" => border_image_words(value).is_some_and(
            |words| matches!(words.as_slice(), [word] if is_border_image_source(word)),
        ),
        "border-image-slice" => border_image_slice_is_valid(value),
        "border-image-width" => border_image_quad_is_valid(value, width_component_is_valid),
        "border-image-outset" => border_image_quad_is_valid(value, outset_component_is_valid),
        "border-image-repeat" => border_image_words(value).is_some_and(|words| {
            matches!(words.len(), 1 | 2)
                && words
                    .iter()
                    .all(|word| is_border_image_repeat_keyword(word))
        }),
        _ => false,
    }
}

fn border_image_slice_is_valid(value: &str) -> bool {
    let Some(words) = border_image_words(value) else {
        return false;
    };
    let mut fill = false;
    let mut count = 0usize;
    for word in words {
        if word.eq_ignore_ascii_case("fill") {
            if fill {
                return false;
            }
            fill = true;
        } else if nonnegative_number_or_percentage(&word) {
            count = count.saturating_add(1);
        } else {
            return false;
        }
    }
    matches!(count, 1..=4)
}

fn border_image_quad_is_valid(value: &str, component: impl Fn(&str) -> bool) -> bool {
    border_image_words(value).is_some_and(|words| {
        matches!(words.len(), 1..=4) && words.iter().all(|word| component(word))
    })
}

fn width_component_is_valid(value: &str) -> bool {
    value.eq_ignore_ascii_case("auto")
        || nonnegative_number(value)
        || parse_length(value).is_some_and(length_may_resolve_nonnegative)
}

fn outset_component_is_valid(value: &str) -> bool {
    nonnegative_number(value)
        || parse_length(value).is_some_and(|length| {
            !matches!(length, CssValue::Percentage(_)) && length_may_resolve_nonnegative(length)
        })
}

fn nonnegative_number_or_percentage(value: &str) -> bool {
    value
        .strip_suffix('%')
        .map_or_else(|| nonnegative_number(value), nonnegative_number)
}

fn nonnegative_number(value: &str) -> bool {
    value
        .parse::<f32>()
        .ok()
        .is_some_and(|number| number.is_finite() && number >= 0.0)
}

/// Functions and variables are range-checked after substitution/evaluation;
/// literal values can and must be rejected before they replace an earlier
/// declaration in the cascade.
fn length_may_resolve_nonnegative(value: CssValue) -> bool {
    match value {
        CssValue::Length(value)
        | CssValue::Em(value)
        | CssValue::Percentage(value)
        | CssValue::Ex(value)
        | CssValue::Ch(value)
        | CssValue::Rem(value)
        | CssValue::Vw(value)
        | CssValue::Vh(value)
        | CssValue::Vmin(value)
        | CssValue::Vmax(value) => value.is_finite() && value >= 0.0,
        CssValue::Math(_) | CssValue::PendingMath(_) | CssValue::Var(_, _) => true,
        CssValue::Keyword(value) => !value.trim_start().starts_with('-'),
        CssValue::Number(value) => value.is_finite() && value >= 0.0,
        CssValue::Color(_) | CssValue::BackgroundLayers(_) => false,
    }
}

fn border_image_words(value: &str) -> Option<Vec<String>> {
    tokenize_border_image(value)?
        .into_iter()
        .map(|token| match token {
            BorderImageToken::Word(word) => Some(word),
            BorderImageToken::Slash => None,
        })
        .collect()
}
