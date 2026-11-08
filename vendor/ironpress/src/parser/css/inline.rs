use super::{
    BackgroundLayerSource, CssValue, StyleMap,
    imports::extract_svg_data_uri,
    is_css_wide_keyword,
    lightning::parse_inline_style_with_lightning,
    parse_length,
    values::{
        border_spacing_value_count, parse_border_spacing_shorthand, parse_property_value,
        parse_var_function,
    },
};

mod border_images;

use border_images::*;

/// Parse an inline CSS style string (e.g. "color: red; font-size: 14px").
pub fn parse_inline_style(style: &str) -> StyleMap {
    parse_inline_style_with_lightning(style).unwrap_or_default()
}

pub(super) fn apply_declaration(map: &mut StyleMap, raw_prop: &str, val: &str, is_important: bool) {
    if raw_prop.starts_with("--") {
        map.set_with_importance(raw_prop, CssValue::Keyword(val.to_string()), is_important);
        return;
    }

    let mut prop = raw_prop.to_ascii_lowercase();
    // Vendor-prefixed CSS Masking aliases (`-webkit-mask*`) are treated as the
    // equivalent unprefixed properties (css-masking-1; widely used in the wild).
    if prop == "-webkit-background-clip" {
        prop = "background-clip".to_string();
    } else if prop == "-webkit-text-fill-color" {
        prop = "color".to_string();
    } else if prop == "font-width" {
        // CSS Fonts 4 makes `font-stretch` a legacy alias of `font-width`.
        // Keep one canonical longhand so source order and !important cascade
        // exactly as they do for a single property.
        prop = "font-stretch".to_string();
    } else if let Some(unprefixed) = prop.strip_prefix("-webkit-mask") {
        prop = format!("mask{unprefixed}");
        // A vendor declaration is not the standard property. Retain it as a
        // compatibility fallback only when this declaration block did not
        // author the corresponding unprefixed property; otherwise a later
        // `-webkit-mask-*` must not replace the Paged CSS semantics.
        if map.get(&prop).is_some() {
            return;
        }
    }
    let prop = prop;
    if (prop == "margin" || prop == "padding") && !prop.contains('-') {
        expand_box_shorthand(map, &prop, val, is_important);
        return;
    }

    if (prop == "margin-left"
        || prop == "margin-right"
        || prop == "margin-top"
        || prop == "margin-bottom")
        && val == "auto"
    {
        map.set_with_importance(&prop, CssValue::Keyword("auto".to_string()), is_important);
        return;
    }

    if prop == "background" {
        let trimmed = val.trim();
        let lower = trimmed.to_ascii_lowercase();
        if is_css_wide_keyword(&lower) {
            apply_background_css_wide_keyword(map, &lower, is_important);
            return;
        }

        // A bare `background: var(--x)` can't be classified at parse time
        // (custom properties resolve in the cascade). Defer it as a
        // background-color Var so computed-time var resolution handles it.
        if let Some(var_val) = parse_var_function(trimmed) {
            map.set_with_importance("background-color", var_val, is_important);
            return;
        }

        let mut parsed = StyleMap::new();
        if parse_background_shorthand(trimmed, &mut parsed, is_important) {
            map.merge(&parsed);
            return;
        }
    }

    if prop == "background-image" && apply_background_image_value(map, val.trim(), is_important) {
        return;
    }

    if prop == "background-position-x" || prop == "background-position-y" {
        apply_background_position_axis(map, &prop, val.trim(), is_important);
        return;
    }

    if prop == "border-spacing" {
        if let Some((horizontal, vertical)) = parse_border_spacing_shorthand(val) {
            if let Some(count) = border_spacing_value_count(val) {
                map.set_with_importance(
                    "border-spacing-value-count",
                    CssValue::Number(count as f32),
                    is_important,
                );
            }
            map.set_with_importance("border-spacing", horizontal.clone(), is_important);
            map.set_with_importance("border-spacing-horizontal", horizontal, is_important);
            map.set_with_importance("border-spacing-vertical", vertical, is_important);
            return;
        }
    }

    if prop == "border-image" {
        if let Some((source, slices, widths, outsets, repeats)) = split_border_image_shorthand(val)
        {
            map.set_with_importance(
                "border-image-source",
                CssValue::Keyword(source),
                is_important,
            );
            map.set_with_importance(
                "border-image-slice",
                CssValue::Keyword(slices),
                is_important,
            );
            map.set_with_importance(
                "border-image-width",
                CssValue::Keyword(widths),
                is_important,
            );
            map.set_with_importance(
                "border-image-outset",
                CssValue::Keyword(outsets),
                is_important,
            );
            map.set_with_importance(
                "border-image-repeat",
                CssValue::Keyword(repeats),
                is_important,
            );
        }
        return;
    }

    if matches!(
        prop.as_str(),
        "border-image-source"
            | "border-image-slice"
            | "border-image-width"
            | "border-image-outset"
            | "border-image-repeat"
    ) {
        if !border_image_longhand_is_valid(&prop, val) {
            return;
        }
        map.set_with_importance(
            &prop,
            CssValue::Keyword(val.trim().to_string()),
            is_important,
        );
        return;
    }

    // CSS Backgrounds 3 makes `border-image` a reset-only subproperty of the
    // `border` shorthand. Expanding that reset here preserves declaration
    // order and `!important` in the same winner map as explicit border-image
    // longhands.
    if prop == "border"
        && let Some(css_value) = parse_property_value(&prop, val)
    {
        map.set_with_importance(&prop, css_value, is_important);
        for (property, initial) in [
            ("border-image-source", "none"),
            ("border-image-slice", "100%"),
            ("border-image-width", "1"),
            ("border-image-outset", "0"),
            ("border-image-repeat", "stretch"),
        ] {
            map.set_with_importance(
                property,
                CssValue::Keyword(initial.to_string()),
                is_important,
            );
        }
        return;
    }

    if let Some(css_value) = parse_property_value(&prop, val) {
        map.set_with_importance(&prop, css_value, is_important);
    }
}

/// Split `border-image` into its independent longhands before
/// cascading. Shorthand expansion is necessary because each longhand has its
/// own cascade slot and the shorthand resets omitted components to their
/// initial values.
pub(super) fn split_border_image_shorthand(
    value: &str,
) -> Option<(String, String, String, String, String)> {
    let mut source = None;
    let mut repeats = Vec::new();
    let mut geometry = vec![Vec::new()];
    for token in tokenize_border_image(value)? {
        match token {
            BorderImageToken::Slash => {
                if geometry.last().is_none_or(Vec::is_empty) || geometry.len() == 3 {
                    return None;
                }
                geometry.push(Vec::new());
            }
            BorderImageToken::Word(word) if is_border_image_source(&word) => {
                if source.replace(word).is_some() {
                    return None;
                }
            }
            BorderImageToken::Word(word) if is_border_image_repeat_keyword(&word) => {
                repeats.push(word);
                if repeats.len() > 2 {
                    return None;
                }
            }
            BorderImageToken::Word(word) => geometry.last_mut()?.push(word),
        }
    }
    if geometry.last().is_none_or(Vec::is_empty) && geometry.len() > 1 {
        return None;
    }
    let component = |index: usize, fallback: &str| {
        geometry
            .get(index)
            .filter(|values| !values.is_empty())
            .map(|values| values.join(" "))
            .unwrap_or_else(|| fallback.to_string())
    };
    let components = (
        source.unwrap_or_else(|| "none".to_string()),
        component(0, "100%"),
        component(1, "1"),
        component(2, "0"),
        if repeats.is_empty() {
            "stretch".to_string()
        } else {
            repeats.join(" ")
        },
    );
    let valid = [
        ("border-image-source", components.0.as_str()),
        ("border-image-slice", components.1.as_str()),
        ("border-image-width", components.2.as_str()),
        ("border-image-outset", components.3.as_str()),
        ("border-image-repeat", components.4.as_str()),
    ]
    .into_iter()
    .all(|(property, value)| border_image_longhand_is_valid(property, value));
    valid.then_some(components)
}

enum BorderImageToken {
    Word(String),
    Slash,
}

fn tokenize_border_image(value: &str) -> Option<Vec<BorderImageToken>> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut depth = 0_u32;
    let mut quote = None;
    let mut escaped = false;
    let flush = |word: &mut String, tokens: &mut Vec<BorderImageToken>| {
        if !word.is_empty() {
            tokens.push(BorderImageToken::Word(std::mem::take(word)));
        }
    };
    for ch in value.trim().chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if quote.is_some() && ch == '\\' {
            word.push(ch);
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            word.push(ch);
            if ch == delimiter {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                word.push(ch);
            }
            '(' => {
                depth = depth.checked_add(1)?;
                word.push(ch);
            }
            ')' => {
                depth = depth.checked_sub(1)?;
                word.push(ch);
            }
            '/' if depth == 0 => {
                flush(&mut word, &mut tokens);
                tokens.push(BorderImageToken::Slash);
            }
            ch if depth == 0 && ch.is_whitespace() => flush(&mut word, &mut tokens),
            _ => word.push(ch),
        }
    }
    if depth != 0 || quote.is_some() || escaped {
        return None;
    }
    flush(&mut word, &mut tokens);
    (!tokens.is_empty()).then_some(tokens)
}

fn is_border_image_source(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower == "none"
        || [
            "url(",
            "linear-gradient(",
            "repeating-linear-gradient(",
            "radial-gradient(",
            "repeating-radial-gradient(",
            "conic-gradient(",
            "repeating-conic-gradient(",
            "image-set(",
            "-webkit-image-set(",
            "cross-fade(",
            "element(",
            "var(",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn is_border_image_repeat_keyword(value: &str) -> bool {
    ["stretch", "repeat", "round", "space"]
        .iter()
        .any(|keyword| value.eq_ignore_ascii_case(keyword))
}

fn apply_background_css_wide_keyword(map: &mut StyleMap, keyword: &str, is_important: bool) {
    // CSS shorthands participate in the cascade as their longhands. Keeping a
    // synthetic `background` winner would allow lower-priority longhands to
    // survive beside it, so expand CSS-wide keywords at the declaration edge.
    for key in [
        "background-color",
        "background-image",
        "background-size",
        "background-repeat",
        "background-position",
        "background-origin",
        "background-clip",
        "background-attachment",
    ] {
        map.set_with_importance(key, CssValue::Keyword(keyword.to_string()), is_important);
    }
}

/// Split a comma-separated CSS value into its top-level parts, ignoring commas
/// that appear inside parentheses (e.g. `linear-gradient(a, b)`) or quotes
/// (e.g. a `url("data:...,...")` data URI). Used to separate comma-separated
/// `background-image` layers so each layer is parsed independently.
fn split_top_level_commas(val: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0u32;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escaped = false;

    for ch in val.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if (in_single_quote || in_double_quote) && ch == '\\' {
            current.push(ch);
            escaped = true;
            continue;
        }

        match ch {
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
                current.push(ch);
            }
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
                current.push(ch);
            }
            '(' if !in_single_quote && !in_double_quote => {
                paren_depth += 1;
                current.push(ch);
            }
            ')' if !in_single_quote && !in_double_quote && paren_depth > 0 => {
                paren_depth -= 1;
                current.push(ch);
            }
            ',' if paren_depth == 0 && !in_single_quote && !in_double_quote => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
}

/// Apply a `background-image` value, supporting multiple comma-separated layers.
///
/// The ordered list is one typed property value. Internal raster/gradient/SVG
/// implementation details must not become independent cascade properties: one
/// later `background-image` declaration replaces the whole earlier list.
///
/// Returns `true` if at least one layer was recognised and applied.
fn apply_background_image_value(map: &mut StyleMap, value: &str, is_important: bool) -> bool {
    let raw_layers = split_top_level_commas(value);
    let mut sources = Vec::with_capacity(raw_layers.len());
    for layer in raw_layers {
        let Some(source) = parse_background_image_source(&layer) else {
            return false;
        };
        sources.push(source);
    }
    if sources.is_empty() {
        return false;
    }
    map.set_with_importance(
        "background-image",
        CssValue::BackgroundLayers(sources),
        is_important,
    );
    true
}

fn parse_background_image_source(value: &str) -> Option<BackgroundLayerSource> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();

    if lower.starts_with("linear-gradient(") || lower.starts_with("repeating-linear-gradient(") {
        return Some(BackgroundLayerSource::Linear(trimmed.to_string()));
    }

    if lower.starts_with("radial-gradient(") || lower.starts_with("repeating-radial-gradient(") {
        return Some(BackgroundLayerSource::Radial(trimmed.to_string()));
    }

    if lower.starts_with("conic-gradient(") || lower.starts_with("repeating-conic-gradient(") {
        return Some(BackgroundLayerSource::Conic(trimmed.to_string()));
    }

    if lower == "none" {
        return Some(BackgroundLayerSource::None);
    }

    if let Some(svg_text) = extract_svg_data_uri(trimmed) {
        return Some(BackgroundLayerSource::Svg(svg_text));
    }

    // A non-SVG `url(...)` is a raster image layer. Preserve the full `url(...)`
    // token (rather than just the path) so the raster builder can resolve it.
    if let Some(url) = extract_image_set_url(trimmed) {
        return Some(BackgroundLayerSource::Raster(url));
    }

    if lower.starts_with("url(") {
        return Some(BackgroundLayerSource::Raster(trimmed.to_string()));
    }

    None
}

fn extract_image_set_url(value: &str) -> Option<String> {
    let lower = value.trim().to_ascii_lowercase();
    let inner = lower
        .strip_prefix("image-set(")
        .or_else(|| lower.strip_prefix("-webkit-image-set("))?;
    if !inner.ends_with(')') {
        return None;
    }
    let raw_inner = &value.trim()[value.trim().find('(')? + 1..value.trim().len() - 1];
    split_top_level_commas(raw_inner)
        .into_iter()
        .find_map(|candidate| {
            let token = candidate.trim();
            token.find("url(").and_then(|start| {
                let tail = &token[start..];
                let end = tail.find(')')?;
                Some(tail[..=end].to_string())
            })
        })
}

fn apply_background_shorthand_defaults(map: &mut StyleMap, is_important: bool) {
    map.set_with_importance(
        "background-color",
        CssValue::Keyword("initial".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-image",
        CssValue::BackgroundLayers(vec![BackgroundLayerSource::None]),
        is_important,
    );
    map.set_with_importance(
        "background-size",
        CssValue::Keyword("auto".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-repeat",
        CssValue::Keyword("repeat".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-position",
        CssValue::Keyword("0% 0%".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-origin",
        CssValue::Keyword("padding-box".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-clip",
        CssValue::Keyword("border-box".to_string()),
        is_important,
    );
    map.set_with_importance(
        "background-attachment",
        CssValue::Keyword("scroll".to_string()),
        is_important,
    );
}

fn ensure_background_shorthand_defaults(
    map: &mut StyleMap,
    defaults_applied: &mut bool,
    is_important: bool,
) {
    if !*defaults_applied {
        apply_background_shorthand_defaults(map, is_important);
        *defaults_applied = true;
    }
}

#[derive(Default)]
struct BackgroundLayerParts {
    image: Option<String>,
    size: Option<String>,
    repeat: Option<String>,
    position: Option<String>,
    origin: Option<String>,
    clip: Option<String>,
    attachment: Option<String>,
    color: Option<CssValue>,
    recognized: bool,
}

impl BackgroundLayerParts {
    fn has_any(&self) -> bool {
        self.recognized || self.color.is_some()
    }
}

fn parse_background_layer(val: &str, allow_color: bool) -> BackgroundLayerParts {
    const ORIGIN_KEYWORDS: [&str; 3] = ["padding-box", "border-box", "content-box"];
    const REPEAT_KEYWORDS: [&str; 6] = [
        "no-repeat",
        "repeat",
        "repeat-x",
        "repeat-y",
        "space",
        "round",
    ];
    const ATTACHMENT_KEYWORDS: [&str; 3] = ["scroll", "fixed", "local"];
    const POSITION_KEYWORDS: [&str; 5] = ["center", "top", "bottom", "left", "right"];

    let mut layer = BackgroundLayerParts::default();
    let mut found_image = false;
    let mut found_repeat = false;
    let mut found_origin = false;
    let mut found_clip = false;
    let mut found_size = false;
    let mut found_color = false;
    let mut position_parts = Vec::new();
    let tokens = tokenize_background_value(val);
    let mut index = 0usize;

    while let Some(token) = tokens.get(index) {
        let lower = token.trim().to_ascii_lowercase();

        if !found_image
            && (lower.starts_with("linear-gradient(")
                || lower.starts_with("repeating-linear-gradient(")
                || lower.starts_with("radial-gradient(")
                || lower.starts_with("repeating-radial-gradient(")
                || lower.starts_with("conic-gradient(")
                || lower.starts_with("repeating-conic-gradient(")
                || lower.starts_with("url(")
                || lower.starts_with("image-set(")
                || lower.starts_with("-webkit-image-set(")
                || lower == "none")
        {
            layer.image = Some(token.trim().to_string());
            layer.recognized = true;
            found_image = true;
            index += 1;
            continue;
        }

        // In the `background` shorthand the box value sets `background-origin`
        // then `background-clip` (css-backgrounds-3 §3.10). The first box token
        // is the origin AND the clip; a second box token overrides the clip.
        if ORIGIN_KEYWORDS.contains(&lower.as_str()) && (!found_origin || !found_clip) {
            if !found_origin {
                layer.origin = Some(lower.clone());
                found_origin = true;
                // A lone box value also sets the clip; `found_clip` stays false
                // so a later box token can still override it below.
                layer.clip = Some(lower);
            } else {
                layer.clip = Some(lower);
                found_clip = true;
            }
            layer.recognized = true;
            index += 1;
            continue;
        }

        if !found_repeat && REPEAT_KEYWORDS.contains(&lower.as_str()) {
            let mut repeat = lower;
            if matches!(repeat.as_str(), "repeat" | "space" | "round" | "no-repeat")
                && let Some(next_token) = tokens.get(index + 1)
            {
                let next = next_token.trim().to_ascii_lowercase();
                if matches!(next.as_str(), "repeat" | "space" | "round" | "no-repeat") {
                    repeat.push(' ');
                    repeat.push_str(&next);
                    index += 1;
                }
            }
            layer.repeat = Some(repeat);
            layer.recognized = true;
            found_repeat = true;
            index += 1;
            continue;
        }

        if ATTACHMENT_KEYWORDS.contains(&lower.as_str()) {
            layer.attachment = Some(lower);
            layer.recognized = true;
            index += 1;
            continue;
        }

        if lower == "/" {
            index += 1;
            if !found_size {
                if let Some(size_token) = tokens.get(index) {
                    let mut size = size_token.trim().to_string();
                    if let Some(next_token) = tokens.get(index + 1) {
                        let next = next_token.trim().to_ascii_lowercase();
                        if is_background_size_continuation(
                            &next,
                            &ORIGIN_KEYWORDS,
                            &REPEAT_KEYWORDS,
                            &POSITION_KEYWORDS,
                        ) {
                            size.push(' ');
                            size.push_str(next_token.trim());
                            index += 1;
                        }
                    }
                    layer.size = Some(size);
                    layer.recognized = true;
                    found_size = true;
                }
            }
            index += 1;
            continue;
        }

        if POSITION_KEYWORDS.contains(&lower.as_str()) || is_background_position_length(token) {
            position_parts.push(token.trim().to_string());
            index += 1;
            continue;
        }

        if allow_color && !found_color {
            if let Some(color_value) = super::values::parse_color(token) {
                layer.color = Some(color_value);
                found_color = true;
                index += 1;
                continue;
            }
        }

        index += 1;
    }

    if !position_parts.is_empty() {
        layer.position = Some(position_parts.join(" "));
        layer.recognized = true;
    }

    layer
}

fn parse_background_shorthand(val: &str, map: &mut StyleMap, is_important: bool) -> bool {
    let layer_values = split_top_level_commas(val);
    let mut layers = Vec::with_capacity(layer_values.len());
    for (index, layer_value) in layer_values.iter().enumerate() {
        layers.push(parse_background_layer(
            layer_value,
            index + 1 == layer_values.len(),
        ));
    }

    if layers.iter().all(|layer| !layer.has_any()) {
        return false;
    }

    let mut defaults_applied = false;
    ensure_background_shorthand_defaults(map, &mut defaults_applied, is_important);

    let image_list = layers
        .iter()
        .map(|layer| layer.image.as_deref().unwrap_or("none"))
        .collect::<Vec<_>>()
        .join(", ");
    let _ = apply_background_image_value(map, &image_list, is_important);

    let size_list = layers
        .iter()
        .map(|layer| layer.size.as_deref().unwrap_or("auto"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-size",
        CssValue::Keyword(size_list),
        is_important,
    );

    let repeat_list = layers
        .iter()
        .map(|layer| layer.repeat.as_deref().unwrap_or("repeat"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-repeat",
        CssValue::Keyword(repeat_list),
        is_important,
    );

    let position_list = layers
        .iter()
        .map(|layer| layer.position.as_deref().unwrap_or("0% 0%"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-position",
        CssValue::Keyword(position_list),
        is_important,
    );

    let origin_list = layers
        .iter()
        .map(|layer| layer.origin.as_deref().unwrap_or("padding-box"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-origin",
        CssValue::Keyword(origin_list),
        is_important,
    );

    let clip_list = layers
        .iter()
        .map(|layer| layer.clip.as_deref().unwrap_or("border-box"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-clip",
        CssValue::Keyword(clip_list),
        is_important,
    );

    let attachment_list = layers
        .iter()
        .map(|layer| layer.attachment.as_deref().unwrap_or("scroll"))
        .collect::<Vec<_>>()
        .join(", ");
    map.set_with_importance(
        "background-attachment",
        CssValue::Keyword(attachment_list),
        is_important,
    );

    if let Some(color_value) = layers.last().and_then(|layer| layer.color.clone()) {
        map.set_with_importance("background-color", color_value, is_important);
    }

    true
}

fn is_background_size_continuation(
    token: &str,
    origin_keywords: &[&str],
    repeat_keywords: &[&str],
    position_keywords: &[&str],
) -> bool {
    !origin_keywords.contains(&token)
        && !repeat_keywords.contains(&token)
        && !position_keywords.contains(&token)
        && token != "/"
        && !token.starts_with("url(")
        && !token.starts_with('#')
        && super::values::parse_color(token).is_none()
}

fn is_background_position_length(token: &str) -> bool {
    matches!(
        parse_length(token),
        Some(
            CssValue::Length(_)
                | CssValue::Percentage(_)
                | CssValue::Math(_)
                | CssValue::PendingMath(_)
                | CssValue::Var(_, _),
        )
    )
}

fn apply_background_position_axis(map: &mut StyleMap, prop: &str, value: &str, is_important: bool) {
    let axis_values: Vec<String> = split_top_level_commas(value)
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect();
    if axis_values.is_empty() {
        return;
    }

    let existing_positions = map
        .get("background-position")
        .and_then(|value| match value {
            CssValue::Keyword(position) => Some(
                split_top_level_commas(position)
                    .into_iter()
                    .map(|part| part.trim().to_string())
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .filter(|positions| !positions.is_empty())
        .unwrap_or_else(|| vec!["0% 0%".to_string()]);

    let layer_count = axis_values.len().max(existing_positions.len());
    let mut positions = Vec::with_capacity(layer_count);
    for index in 0..layer_count {
        let (mut x, mut y) =
            split_background_position_axes(&existing_positions[index % existing_positions.len()]);
        let axis = axis_values[index % axis_values.len()].clone();
        if prop == "background-position-x" {
            x = axis;
        } else {
            y = axis;
        }
        positions.push(format!("{x} {y}"));
    }

    map.set_with_importance(
        "background-position",
        CssValue::Keyword(positions.join(", ")),
        is_important,
    );
}

fn split_background_position_axes(position: &str) -> (String, String) {
    let tokens = tokenize_background_value(position);
    match tokens.as_slice() {
        [] => ("0%".to_string(), "0%".to_string()),
        [token] => {
            let lower = token.to_ascii_lowercase();
            if matches!(lower.as_str(), "top" | "bottom") {
                ("center".to_string(), token.trim().to_string())
            } else if lower == "center" {
                ("center".to_string(), "center".to_string())
            } else {
                (token.trim().to_string(), "center".to_string())
            }
        }
        [first, second] => {
            let first_lower = first.to_ascii_lowercase();
            let second_lower = second.to_ascii_lowercase();
            if matches!(first_lower.as_str(), "top" | "bottom")
                || matches!(second_lower.as_str(), "left" | "right")
            {
                (second.trim().to_string(), first.trim().to_string())
            } else {
                (first.trim().to_string(), second.trim().to_string())
            }
        }
        _ => {
            let split_at = tokens.len() / 2;
            (tokens[..split_at].join(" "), tokens[split_at..].join(" "))
        }
    }
}

fn tokenize_background_value(val: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0u32;
    let mut in_single_quote = false;
    let mut in_double_quote = false;

    for ch in val.chars() {
        match ch {
            '\'' if !in_double_quote && paren_depth > 0 => {
                in_single_quote = !in_single_quote;
                current.push(ch);
            }
            '"' if !in_single_quote && paren_depth > 0 => {
                in_double_quote = !in_double_quote;
                current.push(ch);
            }
            '(' if !in_single_quote && !in_double_quote => {
                paren_depth += 1;
                current.push(ch);
            }
            ')' if !in_single_quote && !in_double_quote && paren_depth > 0 => {
                paren_depth -= 1;
                current.push(ch);
            }
            ' ' | '\t' if paren_depth == 0 && !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '/' if paren_depth == 0 && !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push("/".to_string());
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn expand_box_shorthand(map: &mut StyleMap, prop: &str, val: &str, is_important: bool) {
    let keyword = val.trim().to_ascii_lowercase();
    if is_css_wide_keyword(&keyword) {
        for side in ["top", "right", "bottom", "left"] {
            map.set_with_importance(
                &format!("{prop}-{side}"),
                CssValue::Keyword(keyword.clone()),
                is_important,
            );
        }
        return;
    }

    let parts: Vec<&str> = val.split_whitespace().collect();
    if parts.len() > 1 {
        let (top, right, bottom, left) = match parts.as_slice() {
            [top, right] => (*top, *right, *top, *right),
            [top, right, bottom] => (*top, *right, *bottom, *right),
            [top, right, bottom, left] => (*top, *right, *bottom, *left),
            _ => return,
        };
        for (side, token) in [
            ("top", top),
            ("right", right),
            ("bottom", bottom),
            ("left", left),
        ] {
            let key = format!("{prop}-{side}");
            if token == "auto" {
                map.set_with_importance(&key, CssValue::Keyword("auto".to_string()), is_important);
            } else if let Some(length) = parse_length(token) {
                map.set_with_importance(&key, length, is_important);
            }
        }
        return;
    }

    if val.trim() == "auto" {
        for side in ["top", "right", "bottom", "left"] {
            map.set_with_importance(
                &format!("{prop}-{side}"),
                CssValue::Keyword("auto".to_string()),
                is_important,
            );
        }
        return;
    }

    // Single-value shorthand: applies to all four sides. Use `parse_length`,
    // which preserves percentages (`padding: 10%`), calc(), var(), and relative
    // units — `parse_property_value` only surfaced absolute lengths, silently
    // dropping percentage padding/margin (CSS 2.1 § 8.4: % resolves against the
    // containing block WIDTH on every side, including vertical).
    if let Some(value) = parse_length(val) {
        for side in ["top", "right", "bottom", "left"] {
            map.set_with_importance(&format!("{prop}-{side}"), value.clone(), is_important);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_declaration, parse_inline_style, split_border_image_shorthand, split_top_level_commas,
    };
    use crate::parser::css::{BackgroundLayerSource, CssValue, SpecifiedColor, StyleMap};

    #[test]
    fn inline_relative_length_preserves_em_units() {
        assert!(matches!(
            parse_inline_style("width: 10em").get("width"),
            Some(CssValue::Em(value)) if (*value - 10.0).abs() < 0.01
        ));
    }

    #[test]
    fn parse_basic_inline_styles() {
        let style = parse_inline_style("font-size: 16px; color: red; text-align: center");
        assert!(
            matches!(style.get("font-size"), Some(CssValue::Length(v)) if (*v - 12.0).abs() < 0.1)
        );
        assert!(matches!(
            style.get("color"),
            Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.r == 255.0
        ));
        assert!(
            matches!(style.get("text-align"), Some(CssValue::Keyword(value)) if value == "center")
        );
    }

    #[test]
    fn parse_margin_and_padding_shorthand() {
        let margin = parse_inline_style("margin: 10px");
        assert!(margin.get("margin-top").is_some());
        assert!(margin.get("margin-right").is_some());
        assert!(margin.get("margin-bottom").is_some());
        assert!(margin.get("margin-left").is_some());

        let padding = parse_inline_style("padding: 8px");
        assert!(padding.get("padding-top").is_some());
        assert!(padding.get("padding-right").is_some());
        assert!(padding.get("padding-bottom").is_some());
        assert!(padding.get("padding-left").is_some());
    }

    #[test]
    fn box_shorthand_css_wide_keyword_expands_to_longhands() {
        let padding = parse_inline_style("padding: inherit");
        for side in ["top", "right", "bottom", "left"] {
            assert!(matches!(
                padding.get(&format!("padding-{side}")),
                Some(CssValue::Keyword(value)) if value == "inherit"
            ));
        }
        assert!(padding.get("padding").is_none());
    }

    #[test]
    fn parse_font_keywords() {
        let style = parse_inline_style(
            "font-weight: bold; font-style: italic; font-family: 'Times New Roman', serif",
        );
        assert!(
            matches!(style.get("font-weight"), Some(CssValue::Keyword(value)) if value == "bold")
        );
        assert!(
            matches!(style.get("font-style"), Some(CssValue::Keyword(value)) if value == "italic")
        );
        assert!(matches!(
            style.get("font-family"),
            Some(CssValue::Keyword(value)) if value == "Times New Roman, serif"
        ));
    }

    #[test]
    fn parse_border_and_outline_properties() {
        let style = parse_inline_style(
            "border: 1px solid black; border-top: 1pt solid red; border-width: 2pt; outline-color: blue",
        );
        assert!(
            matches!(style.get("border"), Some(CssValue::Keyword(value)) if value == "1px solid #000")
        );
        assert!(
            matches!(style.get("border-top"), Some(CssValue::Keyword(value)) if value == "1pt solid red")
        );
        assert!(
            matches!(style.get("border-width"), Some(CssValue::Length(v)) if (*v - 2.0).abs() < 0.1)
        );
        assert!(matches!(
            style.get("outline-color"),
            Some(CssValue::Color(SpecifiedColor::Absolute(c))) if c.b == 255.0
        ));
    }

    #[test]
    fn parse_layout_keywords_and_lengths() {
        let style = parse_inline_style(
            "display: none; position: absolute; width: auto; height: 50vh; gap: 10px; border-spacing: 12pt 24pt",
        );
        assert!(matches!(style.get("display"), Some(CssValue::Keyword(value)) if value == "none"));
        assert!(
            matches!(style.get("position"), Some(CssValue::Keyword(value)) if value == "absolute")
        );
        assert!(matches!(style.get("width"), Some(CssValue::Keyword(value)) if value == "auto"));
        assert!(matches!(style.get("height"), Some(CssValue::Vh(v)) if (*v - 50.0).abs() < 0.01));
        assert!(matches!(style.get("gap"), Some(CssValue::Length(v)) if (*v - 7.5).abs() < 0.01));
        assert!(
            matches!(style.get("border-spacing"), Some(CssValue::Length(v)) if (*v - 12.0).abs() < 0.01)
        );
        assert!(
            matches!(style.get("border-spacing-horizontal"), Some(CssValue::Length(v)) if (*v - 12.0).abs() < 0.01)
        );
        assert!(
            matches!(style.get("border-spacing-vertical"), Some(CssValue::Length(v)) if (*v - 24.0).abs() < 0.01)
        );
    }

    #[test]
    fn parse_border_spacing_rejects_invalid_second_component() {
        let style = parse_inline_style("border-spacing: 10pt foo");
        assert!(style.get("border-spacing").is_none());
        assert!(style.get("border-spacing-horizontal").is_none());
        assert!(style.get("border-spacing-vertical").is_none());
    }

    #[test]
    fn parse_background_gradients() {
        let linear = parse_inline_style("background-image: linear-gradient(red, blue)");
        let radial = parse_inline_style("background: radial-gradient(circle, white, black)");
        assert!(matches!(
            linear.get("background-image"),
            Some(CssValue::BackgroundLayers(layers))
                if matches!(layers.as_slice(), [BackgroundLayerSource::Linear(_)])
        ));
        assert!(matches!(
            radial.get("background-image"),
            Some(CssValue::BackgroundLayers(layers))
                if matches!(layers.as_slice(), [BackgroundLayerSource::Radial(_)])
        ));
    }

    #[test]
    fn parse_calc_and_var_values() {
        let style = parse_inline_style("width: calc(100% - 20pt); color: var(--text-color, red)");
        assert!(matches!(style.get("width"), Some(CssValue::Math(_))));
        assert!(matches!(
            style.get("color"),
            Some(CssValue::Var(name, Some(fallback))) if name == "--text-color" && fallback == "red"
        ));
    }

    #[test]
    fn parse_important_keeps_stronger_value() {
        let style = parse_inline_style("width: 40% !important; width: 10%");
        assert!(
            matches!(style.get("width"), Some(CssValue::Percentage(v)) if (*v - 40.0).abs() < 0.01)
        );
    }

    #[test]
    fn invalid_later_declaration_is_discarded_without_replacing_valid_value() {
        enum Expected<'a> {
            Keyword(&'a str),
            Number(f32),
            Length(f32),
        }

        fn assert_expected(map: &StyleMap, property: &str, expected: &Expected<'_>) {
            match (map.get(property), expected) {
                (Some(CssValue::Keyword(actual)), Expected::Keyword(expected)) => {
                    assert_eq!(actual, expected, "unexpected value for {property}");
                }
                (Some(CssValue::Number(actual)), Expected::Number(expected)) => {
                    assert!(
                        (*actual - *expected).abs() < f32::EPSILON,
                        "unexpected value for {property}: {actual}"
                    );
                }
                (Some(CssValue::Length(actual)), Expected::Length(expected)) => {
                    assert!(
                        (*actual - *expected).abs() < f32::EPSILON,
                        "unexpected value for {property}: {actual}"
                    );
                }
                (actual, _) => panic!("unexpected parsed value for {property}: {actual:?}"),
            }
        }

        let cases = [
            (
                "justify-content",
                "center",
                "definitely-invalid",
                Expected::Keyword("center"),
            ),
            (
                "align-items",
                "center",
                "definitely-invalid",
                Expected::Keyword("center"),
            ),
            (
                "overflow",
                "hidden",
                "definitely-invalid",
                Expected::Keyword("hidden"),
            ),
            ("flex-grow", "2", "-1", Expected::Number(2.0)),
            (
                "filter",
                "blur(4px)",
                "blur(-1px)",
                Expected::Keyword("blur(4px)"),
            ),
            ("column-count", "3", "2.5", Expected::Number(3.0)),
            (
                "background-repeat",
                "no-repeat",
                "definitely-invalid",
                Expected::Keyword("no-repeat"),
            ),
            ("border-radius", "7px", "9", Expected::Length(5.25)),
            ("border-top-left-radius", "8px", "11", Expected::Length(6.0)),
            (
                "column-rule-style",
                "dashed",
                "zigzag",
                Expected::Keyword("dashed"),
            ),
            ("column-rule-width", "4px", "-2px", Expected::Length(3.0)),
            (
                "column-rule",
                "4px double red",
                "2px dashed red extra",
                Expected::Keyword("4px double red"),
            ),
        ];

        for (property, valid, invalid, expected) in cases {
            let declarations = format!("{property}: {valid}; {property}: {invalid}");

            let inline = parse_inline_style(&declarations);
            assert_expected(&inline, property, &expected);
            assert!(
                parse_inline_style(&format!("{property}: {invalid}"))
                    .get(property)
                    .is_none(),
                "invalid inline declaration was retained for {property}"
            );

            let rules =
                crate::parser::css::parse_stylesheet(&format!(".target {{ {declarations} }}"));
            assert_eq!(rules.len(), 1, "stylesheet rule was lost for {property}");
            assert_expected(&rules[0].declarations, property, &expected);
        }

        // GCPM's `string-set` is intentionally supported by ironpress but is
        // not a typed property in this lightningcss release. Unknown-property
        // ingestion must remain available without reopening the known-property
        // `Unparsed` loophole above.
        let ironpress_only = "string-set: chapter content()";
        let inline = parse_inline_style(ironpress_only);
        assert!(matches!(
            inline.get("string-set"),
            Some(CssValue::Keyword(value)) if value == "chapter content()"
        ));
        let rules =
            crate::parser::css::parse_stylesheet(&format!(".target {{ {ironpress_only} }}"));
        assert!(matches!(
            rules[0].declarations.get("string-set"),
            Some(CssValue::Keyword(value)) if value == "chapter content()"
        ));
    }

    #[test]
    fn invalid_source_spelling_is_rejected_before_lightning_normalization() {
        let cases = [
            ("transform", "translate(40px, 0)", "translate(40, 0)"),
            ("transform", "rotate(45deg)", "rotate(45)"),
            (
                "box-shadow",
                "22px 0 0 #c62828",
                "22px 0 0 #c62828, 12 0 #1565c0",
            ),
            ("filter", "blur(8px)", "blur(8)"),
            ("background-size", "42px", "42"),
            ("background-position", "5px", "5"),
        ];

        for (property, valid, invalid) in cases {
            let valid_inline = parse_inline_style(&format!("{property}: {valid}"));
            let expected = format!("{:?}", valid_inline.get(property));
            assert_ne!(
                expected, "None",
                "valid declaration was lost for {property}"
            );

            let combined =
                parse_inline_style(&format!("{property}: {valid}; {property}: {invalid}"));
            assert_eq!(
                format!("{:?}", combined.get(property)),
                expected,
                "invalid inline source replaced {property}"
            );
            assert!(
                parse_inline_style(&format!("{property}: {invalid}"))
                    .get(property)
                    .is_none(),
                "invalid inline source survived for {property}"
            );

            let rules = crate::parser::css::parse_stylesheet(&format!(
                ".target {{ {property}: {valid}; {property}: {invalid} }}"
            ));
            assert_eq!(
                rules.len(),
                1,
                "valid stylesheet rule was lost for {property}"
            );
            assert_eq!(
                format!("{:?}", rules[0].declarations.get(property)),
                expected,
                "invalid stylesheet source replaced {property}"
            );
        }
    }

    #[test]
    fn invalid_border_image_longhands_do_not_replace_prior_valid_declarations() {
        for (property, valid, invalid) in [
            (
                "border-image-source",
                "linear-gradient(red, blue)",
                "paint(red)",
            ),
            ("border-image-slice", "17 fill", "-2"),
            ("border-image-width", "3", "-1"),
            ("border-image-outset", "2", "-1px"),
            ("border-image-repeat", "round space", "round sideways"),
        ] {
            let valid_map = parse_inline_style(&format!("{property}: {valid}"));
            let expected = format!("{:?}", valid_map.get(property));
            assert_ne!(
                expected, "None",
                "valid declaration was lost for {property}"
            );

            let combined =
                parse_inline_style(&format!("{property}: {valid}; {property}: {invalid}"));
            assert_eq!(
                format!("{:?}", combined.get(property)),
                expected,
                "invalid declaration replaced {property}",
            );
            assert!(
                parse_inline_style(&format!("{property}: {invalid}"))
                    .get(property)
                    .is_none(),
                "invalid declaration survived for {property}",
            );
        }
    }

    #[test]
    fn parse_custom_properties_and_content_keywords() {
        let style =
            parse_inline_style("--accent: blue; content: \"hello\"; counter-reset: section 0");
        assert!(matches!(style.get("--accent"), Some(CssValue::Keyword(value)) if value == "blue"));
        assert!(
            matches!(style.get("content"), Some(CssValue::Keyword(value)) if value == "\"hello\"")
        );
        assert!(
            matches!(style.get("counter-reset"), Some(CssValue::Keyword(value)) if value == "section 0")
        );
    }

    #[test]
    fn parse_list_and_text_properties() {
        let style = parse_inline_style(
            "list-style: circle inside; list-style-type: square; list-style-position: outside; text-transform: uppercase; white-space: pre-wrap",
        );
        assert!(style.get("list-style").is_some());
        assert!(style.get("list-style-type").is_some());
        assert!(style.get("list-style-position").is_some());
        assert!(
            matches!(style.get("text-transform"), Some(CssValue::Keyword(value)) if value == "uppercase")
        );
        assert!(
            matches!(style.get("white-space"), Some(CssValue::Keyword(value)) if value == "pre-wrap")
        );
    }

    #[test]
    fn parse_content_string_with_semicolon() {
        let style = parse_inline_style("content: \"a; b\"; color: red");
        assert!(
            matches!(style.get("content"), Some(CssValue::Keyword(value)) if value == "\"a; b\"")
        );
        assert!(matches!(
            style.get("color"),
            Some(CssValue::Color(SpecifiedColor::Absolute(color))) if color.r == 255.0
        ));
    }

    #[test]
    fn parse_empty_style_is_empty() {
        let style = parse_inline_style("");
        assert!(style.properties.is_empty());
    }

    #[test]
    fn style_map_merge_preserves_importance() {
        let mut base = StyleMap::new();
        base.set("font-size", CssValue::Length(12.0));

        let mut overlay = StyleMap::new();
        overlay.set_with_importance("font-size", CssValue::Length(16.0), true);
        overlay.set("color", CssValue::Keyword("red".into()));

        base.merge(&overlay);
        assert!(
            matches!(base.get("font-size"), Some(CssValue::Length(v)) if (*v - 16.0).abs() < 0.01)
        );
        assert!(base.get("color").is_some());
    }

    #[test]
    fn inline_custom_property() {
        let map = parse_inline_style("--my-color: red");
        assert!(matches!(
            map.get("--my-color"),
            Some(CssValue::Keyword(v)) if v == "red"
        ));
    }

    #[test]
    fn inline_margin_auto() {
        let map = parse_inline_style("margin: auto");
        assert!(matches!(
            map.get("margin-left"),
            Some(CssValue::Keyword(v)) if v == "auto"
        ));
        assert!(matches!(
            map.get("margin-right"),
            Some(CssValue::Keyword(v)) if v == "auto"
        ));
    }

    #[test]
    fn inline_margin_individual_auto() {
        let map = parse_inline_style("margin-left: auto; margin-right: auto");
        assert!(matches!(
            map.get("margin-left"),
            Some(CssValue::Keyword(v)) if v == "auto"
        ));
    }

    #[test]
    fn inline_border_spacing() {
        let map = parse_inline_style("border-spacing: 5pt 10pt");
        assert!(map.get("border-spacing-horizontal").is_some());
        assert!(map.get("border-spacing-vertical").is_some());
    }

    #[test]
    fn inline_box_shorthand_3_values() {
        // 3-value margin: top right bottom (left = right)
        let map = parse_inline_style("margin: 10pt 20pt 30pt");
        assert!(map.get("margin-top").is_some());
        assert!(map.get("margin-right").is_some());
        assert!(map.get("margin-bottom").is_some());
        assert!(map.get("margin-left").is_some());
    }

    #[test]
    fn inline_important_flag() {
        let map = parse_inline_style("color: red !important");
        assert!(map.get("color").is_some());
    }

    #[test]
    fn inline_empty_string() {
        let map = parse_inline_style("");
        assert!(map.properties.is_empty());
    }

    #[test]
    fn inline_malformed_no_colon() {
        let map = parse_inline_style("not-a-declaration");
        assert!(map.properties.is_empty());
    }

    #[test]
    fn inline_background_image_svg_data_uri_plain() {
        // SVG data URI via background-image property — exercises apply_background_image_value
        // percent-encoded path
        let svg = "%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
        let style = parse_inline_style(&format!(
            "background-image: url(\"data:image/svg+xml,{svg}\")"
        ));
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [BackgroundLayerSource::Svg(_)])
            ),
            "expected a typed SVG background-image source"
        );
    }

    #[test]
    fn inline_background_shorthand_svg_data_uri() {
        // SVG data URI via background shorthand — exercises apply_background_image_value inside
        // parse_background_shorthand
        let svg_b64 = base64_svg();
        let style = parse_inline_style(&format!(
            "background: url(\"data:image/svg+xml;base64,{svg_b64}\")"
        ));
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [BackgroundLayerSource::Svg(_)])
            ),
            "expected a typed SVG source from the background shorthand"
        );
    }

    #[test]
    fn split_top_level_commas_respects_parens_and_quotes() {
        let parts = split_top_level_commas(
            "url(\"data:image/png;base64,AAA\"), linear-gradient(to bottom, #fff, #000)",
        );
        assert_eq!(parts.len(), 2, "got: {parts:?}");
        assert!(parts[0].contains("url("));
        assert!(parts[1].trim().starts_with("linear-gradient("));
    }

    #[test]
    fn inline_background_image_layers_url_and_gradient() {
        // A comma-separated `background-image` remains one ordered, atomic
        // cascade value even though the renderer derives per-kind paint fields.
        // Use apply_declaration directly so the data-URI `;` is not split by
        // the legacy declaration tokenizer.
        let mut style = StyleMap::new();
        apply_declaration(
            &mut style,
            "background-image",
            "url(\"data:image/png;base64,iVBORw0KGgo=\"), \
             linear-gradient(to bottom, #ffd600, #00bcd4)",
            false,
        );
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [
                        BackgroundLayerSource::Raster(_),
                        BackgroundLayerSource::Linear(_)
                    ])
            ),
            "expected one ordered raster/gradient value: {:?}",
            style.get("background-image")
        );
    }

    #[test]
    fn inline_background_image_same_slot_keeps_top_layer() {
        let mut style = StyleMap::new();
        apply_declaration(
            &mut style,
            "background-image",
            "url(top.png), url(bottom.png)",
            false,
        );
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [
                        BackgroundLayerSource::Raster(top),
                        BackgroundLayerSource::Raster(bottom)
                    ] if top == "url(top.png)" && bottom == "url(bottom.png)")
            ),
            "the atomic value should preserve both CSS layers in order"
        );
    }

    #[test]
    fn inline_background_image_single_layer_unchanged() {
        // A single gradient is represented by the canonical property too.
        let mut style = StyleMap::new();
        apply_declaration(
            &mut style,
            "background-image",
            "linear-gradient(to right, red, blue)",
            false,
        );
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [BackgroundLayerSource::Linear(value)]
                        if value.starts_with("linear-gradient("))
            ),
            "single gradient should remain an atomic background-image value"
        );
    }

    #[test]
    fn standard_mask_longhands_override_later_webkit_fallbacks() {
        let style = parse_inline_style(
            "mask-image: radial-gradient(circle, #000, transparent); \
             mask-composite: subtract; \
             -webkit-mask-image: linear-gradient(#000, transparent); \
             -webkit-mask-composite: source-out",
        );
        assert!(matches!(
            style.get("mask-image"),
            Some(CssValue::Keyword(value)) if value.starts_with("radial-gradient(")
        ));
        assert!(matches!(
            style.get("mask-composite"),
            Some(CssValue::Keyword(value)) if value == "subtract"
        ));
    }

    #[test]
    fn inline_background_shorthand_expands_layer_lists_and_final_color() {
        let mut style = StyleMap::new();
        apply_declaration(
            &mut style,
            "background",
            "url(top.png) left top / 10px 20px no-repeat content-box, \
             linear-gradient(red, blue) right bottom / 30px 40px repeat padding-box border-box #fdd835",
            false,
        );
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [
                        BackgroundLayerSource::Raster(_),
                        BackgroundLayerSource::Linear(_)
                    ])
            ),
            "the image value should preserve layer order"
        );
        assert!(
            matches!(style.get("background-position"), Some(CssValue::Keyword(v)) if v == "left top, right bottom"),
            "background-position list should match layers: {:?}",
            style.get("background-position")
        );
        assert!(
            matches!(style.get("background-size"), Some(CssValue::Keyword(v)) if v == "10px 20px, 30px 40px"),
            "background-size list should match layers: {:?}",
            style.get("background-size")
        );
        assert!(
            matches!(style.get("background-origin"), Some(CssValue::Keyword(v)) if v == "content-box, padding-box"),
            "background-origin list should match layers: {:?}",
            style.get("background-origin")
        );
        assert!(
            matches!(style.get("background-clip"), Some(CssValue::Keyword(v)) if v == "content-box, border-box"),
            "background-clip list should match layers: {:?}",
            style.get("background-clip")
        );
        assert!(
            matches!(style.get("background-color"), Some(CssValue::Color(SpecifiedColor::Absolute(color))) if color.r == 0xfd as f32 && color.g == 0xd8 as f32 && color.b == 0x35 as f32),
            "final-layer background-color should survive"
        );
    }

    #[test]
    fn inline_background_position_xy_longhands_compose_position() {
        let mut style = StyleMap::new();
        apply_declaration(&mut style, "background-position-x", "80px", false);
        apply_declaration(&mut style, "background-position-y", "30px", false);
        assert!(
            matches!(style.get("background-position"), Some(CssValue::Keyword(v)) if v == "80px 30px"),
            "x/y longhands should compose background-position: {:?}",
            style.get("background-position")
        );
    }

    #[test]
    fn inline_filter_blur_is_keyword() {
        let style = parse_inline_style("filter: blur(4px)");
        assert!(
            matches!(style.get("filter"), Some(CssValue::Keyword(v)) if v == "blur(4px)"),
            "filter value should be stored as keyword"
        );
    }

    #[test]
    fn inline_overflow_wrap_property() {
        let style = parse_inline_style("overflow-wrap: break-word");
        assert!(
            matches!(style.get("overflow-wrap"), Some(CssValue::Keyword(v)) if v == "break-word"),
            "overflow-wrap should be stored as keyword"
        );
    }

    #[test]
    fn inline_table_layout_property() {
        let style = parse_inline_style("table-layout: fixed");
        assert!(
            matches!(style.get("table-layout"), Some(CssValue::Keyword(v)) if v == "fixed"),
            "table-layout should be stored as keyword"
        );
    }

    #[test]
    fn inline_background_shorthand_size_two_tokens() {
        // background with position/size using two-token size "100% auto" — exercises
        // is_background_size_continuation picking up the second size token
        let style = parse_inline_style("background: center / 100% auto no-repeat");
        assert!(
            matches!(style.get("background-size"), Some(CssValue::Keyword(v)) if v.contains("100%")),
            "two-token background-size should be captured: {:?}",
            style.get("background-size")
        );
    }

    #[test]
    fn inline_box_shorthand_auto_single_value() {
        // "margin: auto" single-value auto path in expand_box_shorthand
        let map = parse_inline_style("margin: auto");
        for side in ["top", "right", "bottom", "left"] {
            assert!(
                matches!(map.get(&format!("margin-{side}")), Some(CssValue::Keyword(v)) if v == "auto"),
                "margin-{side} should be auto"
            );
        }
    }

    #[test]
    fn inline_box_shorthand_4_values_with_auto() {
        // 4-value padding where one token is "auto" — exercises the auto branch inside the
        // multi-value loop in expand_box_shorthand
        let map = parse_inline_style("padding: 10pt auto 5pt 0pt");
        assert!(
            matches!(map.get("padding-right"), Some(CssValue::Keyword(v)) if v == "auto"),
            "padding-right should be auto"
        );
        assert!(map.get("padding-top").is_some());
        assert!(map.get("padding-bottom").is_some());
        assert!(map.get("padding-left").is_some());
    }

    #[test]
    fn inline_background_shorthand_css_wide_keyword() {
        // A shorthand never becomes a synthetic cascade property.
        let style = parse_inline_style("background: inherit");
        assert!(style.get("background").is_none());
        for longhand in [
            "background-color",
            "background-image",
            "background-size",
            "background-repeat",
            "background-position",
            "background-origin",
            "background-clip",
            "background-attachment",
        ] {
            assert!(
                matches!(style.get(longhand), Some(CssValue::Keyword(v)) if v == "inherit"),
                "{longhand} should inherit"
            );
        }
    }

    #[test]
    fn background_shorthand_respects_longhand_importance() {
        let earlier_important =
            parse_inline_style("background-size: cover !important; background: initial");
        assert!(matches!(
            earlier_important.get("background-size"),
            Some(CssValue::Keyword(value)) if value == "cover"
        ));
        assert!(earlier_important.is_important("background-size"));

        let later_important =
            parse_inline_style("background-size: cover; background: initial !important");
        assert!(matches!(
            later_important.get("background-size"),
            Some(CssValue::Keyword(value)) if value == "initial"
        ));
        assert!(later_important.is_important("background-size"));
    }

    #[test]
    fn background_shorthand_does_not_reset_border_image() {
        let style =
            parse_inline_style("border-image: linear-gradient(red, blue) 1; background: none");
        assert!(style.get("border-image-source").is_some());
    }

    #[test]
    fn border_shorthand_resets_border_image_in_source_order() {
        let reset =
            parse_inline_style("border-image: linear-gradient(red, blue) 1; border: solid red");
        assert!(matches!(
            reset.get("border-image-source"),
            Some(CssValue::Keyword(value)) if value == "none"
        ));

        let restored =
            parse_inline_style("border: solid red; border-image: linear-gradient(red, blue) 1");
        assert!(matches!(
            restored.get("border-image-source"),
            Some(CssValue::Keyword(value)) if value == "linear-gradient(red, blue)"
        ));
    }

    #[test]
    fn border_image_shorthand_expands_to_cascading_longhands() {
        let style = parse_inline_style(
            "border-image-width: 3 !important; border-image: linear-gradient(red, blue) 1",
        );
        assert!(matches!(
            style.get("border-image-source"),
            Some(CssValue::Keyword(value)) if value == "linear-gradient(red, blue)"
        ));
        assert!(matches!(
            style.get("border-image-slice"),
            Some(CssValue::Keyword(value)) if value == "1"
        ));
        assert!(matches!(
            style.get("border-image-width"),
            Some(CssValue::Keyword(value)) if value == "3"
        ));
        assert!(matches!(
            style.get("border-image-outset"),
            Some(CssValue::Keyword(value)) if value == "0"
        ));
        assert!(matches!(
            style.get("border-image-repeat"),
            Some(CssValue::Keyword(value)) if value == "stretch"
        ));
        assert!(style.is_important("border-image-width"));
    }

    #[test]
    fn border_image_shorthand_preserves_a_second_slash_outset() {
        let style = parse_inline_style("border-image: linear-gradient(red, blue) 1 / 1 / 2");
        assert!(
            matches!(
                style.get("border-image-outset"),
                Some(CssValue::Keyword(value)) if value == "2"
            ),
            "{style:?}"
        );
    }

    #[test]
    fn border_image_shorthand_separates_its_two_axis_repeat_suffix() {
        let style =
            parse_inline_style("border-image: linear-gradient(red, blue) 1 / 1 / 2 repeat stretch");
        assert!(matches!(
            style.get("border-image-repeat"),
            Some(CssValue::Keyword(value)) if value == "repeat stretch"
        ));
    }

    #[test]
    fn border_image_shorthand_defaults_omitted_components() {
        let style = parse_inline_style("border-image: linear-gradient(red, blue)");
        assert!(matches!(
            style.get("border-image-slice"),
            Some(CssValue::Keyword(value)) if value == "100%"
        ));
        assert!(matches!(
            style.get("border-image-width"),
            Some(CssValue::Keyword(value)) if value == "1"
        ));
        assert!(matches!(
            style.get("border-image-outset"),
            Some(CssValue::Keyword(value)) if value == "0"
        ));
    }

    #[test]
    fn border_image_shorthand_accepts_components_in_grammar_order_independently() {
        let (source, slices, widths, outsets, repeats) = split_border_image_shorthand(
            "round 12 fill / 2 / 3 url('data:image/png;base64,AAAA') stretch",
        )
        .expect("valid order-independent border-image shorthand");

        assert_eq!(source, "url('data:image/png;base64,AAAA')");
        assert_eq!(slices, "12 fill");
        assert_eq!(widths, "2");
        assert_eq!(outsets, "3");
        assert_eq!(repeats, "round stretch");
    }

    #[test]
    fn border_image_shorthand_can_reset_an_omitted_source_to_none() {
        let (source, slices, widths, outsets, repeats) =
            split_border_image_shorthand("15 / 2 repeat").expect("valid source-less shorthand");

        assert_eq!(source, "none");
        assert_eq!(slices, "15");
        assert_eq!(widths, "2");
        assert_eq!(outsets, "0");
        assert_eq!(repeats, "repeat");
    }

    #[test]
    fn inline_background_image_none() {
        // background-image: none — exercises the "none" branch in apply_background_image_value
        let style = parse_inline_style("background-image: none");
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [BackgroundLayerSource::None])
            ),
            "background-image: none should be stored"
        );
    }

    #[test]
    fn inline_background_image_url() {
        // background-image: url(...) — exercises the url( fallback in parse_background_shorthand
        let style = parse_inline_style("background: url(hero.png) no-repeat center");
        assert!(
            matches!(
                style.get("background-image"),
                Some(CssValue::BackgroundLayers(layers))
                    if matches!(layers.as_slice(), [BackgroundLayerSource::Raster(v)]
                        if v.starts_with("url("))
            ),
            "url() background image should be stored"
        );
        assert!(
            matches!(style.get("background-repeat"), Some(CssValue::Keyword(v)) if v == "no-repeat"),
        );
    }

    /// Minimal base64-encoded SVG used in tests.
    fn base64_svg() -> String {
        use std::fmt::Write;
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>";
        // simple base64 encoding without external crate dependency
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in svg.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            let _ = write!(out, "{}", TABLE[((n >> 18) & 63) as usize] as char);
            let _ = write!(out, "{}", TABLE[((n >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                let _ = write!(out, "{}", TABLE[((n >> 6) & 63) as usize] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                let _ = write!(out, "{}", TABLE[(n & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
        out
    }
}
