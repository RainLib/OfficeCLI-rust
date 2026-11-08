use super::{
    CssValue, FontFaceRule, MarginBox, MarginBoxPosition, MarginContentToken, PageContentReference,
    PageRule, PageSelector, PageTextStyle, SpecifiedColor, extract_url_path,
    model::{FontFaceSource, FontStretch, FootnoteAreaStyle, PageCounterControl, UnicodeRange},
    preprocess_media_queries,
};
use super::{PageBleed, PageOrientation, PrinterMarks};
use cssparser::{Parser, ParserInput};

/// Parse a CSS stylesheet and extract `@page` rules.
pub fn parse_page_rules(css: &str) -> Vec<PageRule> {
    let preprocessed = preprocess_media_queries(css);
    // `@footnote` is a page-context rule. In particular, do not silently
    // accept a stylesheet-level `@footnote`: doing so turns an invalid source
    // into a document-wide footnote style and makes reference engines that
    // reject it appear wrong.
    extract_page_rules(&preprocessed)
}

/// Parse a CSS stylesheet and extract `@font-face` rules.
///
/// Only local file paths are supported in `src: url(...)`. Remote URLs
/// (http/https) are rejected for security reasons.
pub fn parse_font_face_rules(css: &str) -> Vec<FontFaceRule> {
    let preprocessed = preprocess_media_queries(css);
    extract_font_face_rules(&preprocessed)
}

/// Extract @font-face rules from preprocessed CSS.
pub(crate) fn extract_font_face_rules(css: &str) -> Vec<FontFaceRule> {
    let mut rules = Vec::new();
    let mut remaining = css;

    while let Some(at_pos) = remaining.to_ascii_lowercase().find("@font-face") {
        let Some(after_at) = remaining.get(at_pos + 10..) else {
            break;
        };
        let Some(brace_pos) = after_at.find('{') else {
            break;
        };
        let Some(after_brace) = after_at.get(brace_pos + 1..) else {
            break;
        };
        let Some(close_pos) = after_brace.find('}') else {
            break;
        };
        let declarations = &after_brace[..close_pos];
        if let Some(rule) = parse_font_face_declarations(declarations) {
            rules.push(rule);
        }
        remaining = &after_brace[close_pos + 1..];
    }

    rules
}

/// Parse the declarations inside an @font-face block.
pub(crate) fn parse_font_face_declarations(decls: &str) -> Option<FontFaceRule> {
    let mut font_family: Option<String> = None;
    let mut sources: Vec<FontFaceSource> = Vec::new();
    let mut font_weight_bold = false;
    let mut font_style_italic = false;
    let mut font_stretch = FontStretch::default();
    let mut size_adjust = 1.0;
    let mut unicode_ranges = Vec::new();

    for declaration in decls.split(';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }

        if let Some((prop, val)) = declaration.split_once(':') {
            let prop = prop.trim().to_ascii_lowercase();
            let val = val.trim();

            match prop.as_str() {
                "font-family" => {
                    let name = val.trim_matches('"').trim_matches('\'').trim().to_string();
                    if !name.is_empty() {
                        font_family = Some(name);
                    }
                }
                "src" => {
                    sources = parse_font_face_sources(val);
                }
                "font-weight" => {
                    font_weight_bold = parse_font_face_weight(val);
                }
                "font-style" => {
                    font_style_italic = parse_font_face_style(val);
                }
                "font-stretch" | "font-width" => {
                    if let Some(stretch) = FontStretch::from_css(val) {
                        font_stretch = stretch;
                    }
                }
                "size-adjust" => {
                    size_adjust = parse_size_adjust_descriptor(val).unwrap_or(1.0);
                }
                "unicode-range" => {
                    unicode_ranges = parse_unicode_ranges(val);
                }
                _ => {}
            }
        }
    }

    match (font_family, !sources.is_empty()) {
        (Some(family), true) => Some(FontFaceRule {
            font_family: family,
            sources,
            font_weight_bold,
            font_style_italic,
            font_stretch,
            size_adjust,
            unicode_ranges,
        }),
        _ => None,
    }
}

fn parse_font_face_sources(raw: &str) -> Vec<FontFaceSource> {
    split_css_commas(raw)
        .into_iter()
        .filter_map(parse_font_face_source)
        .collect()
}

fn parse_font_face_source(raw: &str) -> Option<FontFaceSource> {
    let source = raw.trim();
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("local(") {
        let inner = source.get(6..source.rfind(')')?)?;
        let name = unquote_css_string(inner.trim());
        if name.is_empty() {
            None
        } else {
            Some(FontFaceSource::Local(name.to_string()))
        }
    } else {
        extract_url_path(source).map(FontFaceSource::Url)
    }
}

fn split_css_commas(raw: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut paren_depth = 0usize;

    for (index, ch) in raw.char_indices() {
        match ch {
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            '(' if quote.is_none() => paren_depth += 1,
            ')' if quote.is_none() => paren_depth = paren_depth.saturating_sub(1),
            ',' if quote.is_none() && paren_depth == 0 => {
                parts.push(raw[start..index].trim());
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }

    parts.push(raw[start..].trim());
    parts.retain(|part| !part.is_empty());
    parts
}

fn unquote_css_string(raw: &str) -> &str {
    raw.trim().trim_matches('"').trim_matches('\'').trim()
}

fn parse_font_face_weight(raw: &str) -> bool {
    let value = raw.trim().to_ascii_lowercase();
    if value.contains("bold") {
        return true;
    }
    value
        .split_whitespace()
        .filter_map(|part| part.parse::<u16>().ok())
        .max()
        .is_some_and(|weight| weight >= 600)
}

fn parse_font_face_style(raw: &str) -> bool {
    let value = raw.trim().to_ascii_lowercase();
    value.starts_with("italic") || value.starts_with("oblique")
}

fn parse_size_adjust_descriptor(raw: &str) -> Option<f32> {
    let value = raw.trim();
    if value.eq_ignore_ascii_case("normal") {
        return Some(1.0);
    }
    if let Some(percent) = value.strip_suffix('%') {
        return percent
            .trim()
            .parse::<f32>()
            .ok()
            .map(|v| (v / 100.0).max(0.0));
    }
    value.parse::<f32>().ok().map(|v| v.max(0.0))
}

fn parse_unicode_ranges(raw: &str) -> Vec<UnicodeRange> {
    split_css_commas(raw)
        .into_iter()
        .filter_map(parse_unicode_range)
        .collect()
}

fn parse_unicode_range(raw: &str) -> Option<UnicodeRange> {
    let value = raw.trim();
    let body = value
        .strip_prefix("U+")
        .or_else(|| value.strip_prefix("u+"))?;
    if let Some((start, end)) = body.split_once('-') {
        let start = u32::from_str_radix(start.trim(), 16).ok()?;
        let end = u32::from_str_radix(end.trim(), 16).ok()?;
        return (start <= end).then_some(UnicodeRange { start, end });
    }
    if body.contains('?') {
        let start = u32::from_str_radix(&body.replace('?', "0"), 16).ok()?;
        let end = u32::from_str_radix(&body.replace('?', "F"), 16).ok()?;
        return Some(UnicodeRange { start, end });
    }
    let codepoint = u32::from_str_radix(body.trim(), 16).ok()?;
    Some(UnicodeRange {
        start: codepoint,
        end: codepoint,
    })
}

/// Parse the comma-separated selector list between `@page` and `{`.
///
/// Each list item becomes an independent rule in source order, matching the
/// CSS cascade model. Invalid selectors are discarded at this parse boundary
/// instead of being weakened into a universal selector.
pub(crate) fn parse_page_selector_list(text: &str) -> Vec<PageSelector> {
    let text = text.trim();
    if text.is_empty() {
        return vec![PageSelector::universal()];
    }

    text.split(',')
        .map(parse_page_selector)
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

fn parse_page_selector(text: &str) -> Option<PageSelector> {
    let mut input = ParserInput::new(text.trim());
    let mut parser = Parser::new(&mut input);
    let name = parser
        .try_parse(|parser| parser.expect_ident_cloned())
        .ok()
        .map(|name| name.to_string());
    let mut selector = name.map_or_else(PageSelector::universal, PageSelector::named);

    while !parser.is_exhausted() {
        parser.expect_colon().ok()?;
        let pseudo = parser.expect_ident_cloned().ok()?;
        selector = match pseudo.to_ascii_lowercase().as_str() {
            "first" => selector.with_first(),
            "blank" => selector.with_blank(),
            "left" => selector.with_left(),
            "right" => selector.with_right(),
            _ => return None,
        };
    }
    Some(selector)
}

/// Extract @page rules from preprocessed CSS.
///
/// The `@page` block is captured with a brace-balanced scan so a nested
/// page-margin at-rule (e.g. `@top-center { … }`, CSS Paged Media 3 §5) does
/// NOT truncate the rule at its inner `}` and drop the trailing `size`/`margin`
/// declarations. The selector text between `@page` and `{` is classified into
/// the rule's [`PageRule::selector`].
pub(crate) fn extract_page_rules(css: &str) -> Vec<PageRule> {
    let mut page_rules = Vec::new();
    let mut remaining = css;

    while let Some(at_pos) = remaining.find("@page") {
        let Some(after_at) = remaining.get(at_pos + 5..) else {
            break;
        };
        let Some(brace_pos) = after_at.find('{') else {
            break;
        };
        // The selector is everything between `@page` and the opening brace.
        let selector_text = &after_at[..brace_pos];
        let Some(after_brace) = after_at.get(brace_pos + 1..) else {
            break;
        };
        // Brace-balanced scan: walk forward tracking nesting depth so the whole
        // @page block (including any nested margin-box at-rule) is captured and
        // we close on the MATCHING `}`, not the first one.
        let mut depth = 1usize;
        let mut close_pos = None;
        for (i, ch) in after_brace.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close_pos = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close_pos) = close_pos else {
            break;
        };
        let declarations = &after_brace[..close_pos];
        // Pull nested page-context rules out before `;`-splitting the ordinary
        // declarations. This preserves both page-margin boxes and the GCPM
        // footnote area without treating a top-level `@footnote` as valid CSS.
        let selectors = parse_page_selector_list(selector_text);
        let (mut margin_boxes, footnote_area, clean_decls) = split_page_at_rules(declarations);
        match parse_page_declarations(&clean_decls) {
            Some(mut rule) => {
                rule.footnote_area = footnote_area;
                for selector in selectors {
                    rule.selector = selector.clone();
                    for margin_box in &mut margin_boxes {
                        margin_box.selector = selector.clone();
                        margin_box.page_counter = rule.page_counter;
                    }
                    rule.margin_boxes.clone_from(&margin_boxes);
                    page_rules.push(rule.clone());
                }
            }
            None if !margin_boxes.is_empty() || footnote_area.is_some() => {
                for selector in selectors {
                    for margin_box in &mut margin_boxes {
                        margin_box.selector = selector.clone();
                    }
                    // A `@page` rule carrying only nested page-context rules
                    // must still be retained so generated content is not
                    // dropped.
                    page_rules.push(PageRule {
                        selector,
                        margin_boxes: margin_boxes.clone(),
                        footnote_area,
                        ..PageRule::default()
                    });
                }
            }
            None => {}
        }
        remaining = &after_brace[close_pos + 1..];
    }

    page_rules
}

fn parse_footnote_area_declarations(decls: &str) -> FootnoteAreaStyle {
    let mut style = FootnoteAreaStyle::default();
    for declaration in decls.split(';') {
        let Some((prop, val)) = declaration.split_once(':') else {
            continue;
        };
        let prop = prop.trim().to_ascii_lowercase();
        let val = val.trim();
        match prop.as_str() {
            "max-height" => {
                style.max_height = parse_nonnegative_page_length(val);
            }
            "padding" => {
                if let Some(padding) = parse_footnote_padding(val) {
                    style.padding = padding.into();
                }
            }
            "padding-top" => {
                if let Some(value) = parse_nonnegative_page_length(val) {
                    style.padding.top = Some(value);
                }
            }
            "padding-right" => {
                if let Some(value) = parse_nonnegative_page_length(val) {
                    style.padding.right = Some(value);
                }
            }
            "padding-bottom" => {
                if let Some(value) = parse_nonnegative_page_length(val) {
                    style.padding.bottom = Some(value);
                }
            }
            "padding-left" => {
                if let Some(value) = parse_nonnegative_page_length(val) {
                    style.padding.left = Some(value);
                }
            }
            "border-top" => {
                parse_footnote_border_top(val, &mut style);
            }
            "border-top-width" => {
                if let Some(width) = parse_nonnegative_page_length(val) {
                    style.separator.width = Some(width);
                }
            }
            "border-top-color" => {
                if let Some(CssValue::Color(color)) = super::parse_color(val) {
                    // The footnote area has no separately modelled `color`
                    // declaration yet, so its inherited/initial current color is
                    // the page-context initial black at this used-value boundary.
                    style.separator.color = Some(color.resolve(crate::types::Color::BLACK));
                }
            }
            _ => {}
        }
    }
    style
}

fn parse_nonnegative_page_length(value: &str) -> Option<f32> {
    parse_page_length(value).filter(|value| value.is_finite() && *value >= 0.0)
}

fn parse_footnote_padding(value: &str) -> Option<crate::types::EdgeSizes> {
    let values = value
        .split_whitespace()
        .map(parse_nonnegative_page_length)
        .collect::<Option<Vec<_>>>()?;
    match values.as_slice() {
        [all] => Some(crate::types::EdgeSizes::uniform(*all)),
        [vertical, horizontal] => Some(crate::types::EdgeSizes::axes(*horizontal, *vertical)),
        [top, horizontal, bottom] => Some(crate::types::EdgeSizes::new(
            *top,
            *horizontal,
            *bottom,
            *horizontal,
        )),
        [top, right, bottom, left] => {
            Some(crate::types::EdgeSizes::new(*top, *right, *bottom, *left))
        }
        _ => None,
    }
}

fn parse_footnote_border_top(value: &str, style: &mut FootnoteAreaStyle) {
    for token in value.split_whitespace() {
        if let Some(width) = parse_nonnegative_page_length(token) {
            style.separator.width = Some(width);
        } else if let Some(CssValue::Color(color)) = super::parse_color(token) {
            style.separator.color = Some(color.resolve(crate::types::Color::BLACK));
        }
    }
}

/// Split nested at-rules from an `@page` declaration block. The returned
/// declaration text has every recognized page-context rule removed and remains
/// safe to `;`-split.
pub(crate) fn split_page_at_rules(
    decls: &str,
) -> (Vec<MarginBox>, Option<FootnoteAreaStyle>, String) {
    let mut boxes = Vec::new();
    let mut footnote_area = None;
    let mut leftover = String::new();
    let mut i = 0;
    while i < decls.len() {
        let Some(at_rel) = decls[i..].find('@') else {
            leftover.push_str(&decls[i..]);
            break;
        };
        let at = i + at_rel;
        leftover.push_str(&decls[i..at]);
        let after_at = &decls[at + 1..];
        let Some(brace_rel) = after_at.find('{') else {
            // A stray `@` with no block — keep the remainder verbatim.
            leftover.push_str(&decls[at..]);
            break;
        };
        let name = after_at[..brace_rel].trim();
        let body_start = at + 1 + brace_rel + 1;
        let body_region = &decls[body_start..];
        // Brace-balanced scan for the matching close brace.
        let mut depth = 1usize;
        let mut close = None;
        for (j, ch) in body_region.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else {
            // Unbalanced — keep the remainder verbatim and stop.
            leftover.push_str(&decls[at..]);
            break;
        };
        if let Some(position) = MarginBoxPosition::from_at_name(name) {
            if let Some((content, color, background_color, text_style, width)) =
                extract_margin_box_decls(&body_region[..close])
            {
                boxes.push(MarginBox {
                    position,
                    selector: PageSelector::universal(),
                    page_counter: PageCounterControl::default(),
                    color,
                    background_color,
                    text_style,
                    width,
                    content,
                });
            }
        } else if name.eq_ignore_ascii_case("footnote") {
            let later = parse_footnote_area_declarations(&body_region[..close]);
            footnote_area
                .get_or_insert_with(FootnoteAreaStyle::default)
                .cascade(later);
        } else {
            // Keep unknown nested rules out of the normal declaration parser
            // only when we understand their complete balanced extent. They
            // remain source text rather than being silently misclassified as a
            // page declaration.
            leftover.push_str(&decls[at..body_start + close + 1]);
        }
        // Resume after the at-rule's matching `}` (drop it from `leftover`).
        i = body_start + close + 1;
    }
    (boxes, footnote_area, leftover)
}

type ParsedMarginBoxDecls = (
    Vec<MarginContentToken>,
    Option<crate::types::Color>,
    Option<crate::types::Color>,
    PageTextStyle,
    Option<f32>,
);

/// Keeps a decoded string paired with its source width so the surrounding
/// margin-content scanner never reinterprets escaped bytes.
struct ParsedCssString {
    value: String,
    consumed_bytes: usize,
}

impl ParsedCssString {
    fn parse(source: &str) -> Option<Self> {
        let mut input = ParserInput::new(source);
        let mut parser = Parser::new(&mut input);
        let value = parser.expect_string_cloned().ok()?.to_string();

        Some(Self {
            value,
            consumed_bytes: parser.position().byte_index(),
        })
    }
}

/// Find supported declarations inside a margin-box body and parse them.
fn extract_margin_box_decls(body: &str) -> Option<ParsedMarginBoxDecls> {
    let mut content = None;
    let mut specified_color: Option<SpecifiedColor> = None;
    let mut specified_background_color: Option<SpecifiedColor> = None;
    let mut width = None;
    for decl in body.split(';') {
        if let Some((prop, val)) = decl.split_once(':') {
            let prop = prop.trim();
            let val = val.trim();
            if prop.eq_ignore_ascii_case("content") {
                content = Some(parse_margin_box_content(val));
            } else if prop.eq_ignore_ascii_case("color") {
                if let Some(CssValue::Color(c)) = super::parse_color(val) {
                    specified_color = Some(c);
                }
            } else if prop.eq_ignore_ascii_case("background")
                || prop.eq_ignore_ascii_case("background-color")
            {
                if let Some(CssValue::Color(c)) = super::parse_color(val) {
                    specified_background_color = Some(c);
                }
            } else if prop.eq_ignore_ascii_case("width") {
                width = parse_nonnegative_page_length(val);
            }
        }
    }
    // Resolve after collecting all declarations: `background-color:
    // currentColor` observes the box's computed `color` regardless of source
    // order. `currentColor` on `color` itself inherits the page-context color;
    // until page-level `color` is modelled that explicit inherited value is the
    // CSS initial black.
    let inherited_color = crate::types::Color::BLACK;
    let color = specified_color.map(|color| color.resolve(inherited_color));
    let current_color = color.unwrap_or(inherited_color);
    let background_color = specified_background_color.map(|color| color.resolve(current_color));
    content.map(|content| {
        (
            content,
            color,
            background_color,
            PageTextStyle {
                declarations: super::parse_inline_style(body),
            },
            width,
        )
    })
}

/// Parse a margin-box `content` value (CSS Paged Media 3 §5.3) into a token
/// list of string literals and the `counter(page)` / `counter(pages)` page
/// counters, e.g. `"Page " counter(page) " of " counter(pages)`.
pub(crate) fn parse_margin_box_content(val: &str) -> Vec<MarginContentToken> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < val.len() {
        let rest = &val[i..];
        let Some(c) = rest.chars().next() else {
            break;
        };
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        if c == '"' || c == '\'' {
            let Some(string) = ParsedCssString::parse(rest) else {
                break;
            };
            tokens.push(MarginContentToken::Literal(string.value));
            i += string.consumed_bytes;
        } else if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case("counter(") {
            if let Some(end) = rest.find(')') {
                // The optional second arg is the counter style; only `decimal`
                // (the default) is supported, so the style is ignored.
                let name = rest[8..end]
                    .split(',')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                match name.as_str() {
                    "page" => tokens.push(MarginContentToken::PageNumber),
                    "pages" => tokens.push(MarginContentToken::PageCount),
                    _ => {}
                }
                i += end + 1;
            } else {
                break;
            }
        } else if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case("element(") {
            if let Some(end) = rest.find(')') {
                let mut parts = rest[8..end].split(',').map(str::trim);
                let name = parts.next().unwrap_or("");
                let policy = parts.next().filter(|s| !s.is_empty());
                if let Some(reference) = PageContentReference::parse(name, policy) {
                    tokens.push(MarginContentToken::Element(reference));
                }
                i += end + 1;
            } else {
                break;
            }
        } else if rest.len() >= 7 && rest[..7].eq_ignore_ascii_case("string(") {
            if let Some(end) = rest.find(')') {
                let mut parts = rest[7..end].split(',').map(str::trim);
                let name = parts.next().unwrap_or("");
                let policy = parts.next().filter(|s| !s.is_empty());
                if let Some(reference) = PageContentReference::parse(name, policy) {
                    tokens.push(MarginContentToken::NamedString(reference));
                }
                i += end + 1;
            } else {
                break;
            }
        } else {
            // Unsupported token (string()/attr()/identifier) — advance one char
            // to keep making progress.
            i += c.len_utf8();
        }
    }
    tokens
}

/// Parse the declarations inside an @page block.
pub(crate) fn parse_page_declarations(decls: &str) -> Option<PageRule> {
    let mut rule = PageRule::default();
    let mut has_any = false;
    let text_style = PageTextStyle {
        declarations: super::parse_inline_style(decls),
    };
    let declarations: Vec<(String, String)> = decls
        .split(';')
        .filter_map(|declaration| {
            let declaration = declaration.trim();
            if declaration.is_empty() {
                return None;
            }
            let (prop, val) = declaration.split_once(':')?;
            Some((
                prop.trim().to_ascii_lowercase(),
                val.trim().to_ascii_lowercase(),
            ))
        })
        .collect();

    for (prop, val) in &declarations {
        if prop == "size" {
            if let Some((w, h)) = parse_page_size(val) {
                rule.width = Some(w);
                rule.height = Some(h);
                has_any = true;
            }
        }
    }

    let page_margin_width_basis = rule.width;
    let page_margin_height_basis = rule.height;

    for (prop, val) in &declarations {
        match prop.as_str() {
            "size" => {}
            "margin" => {
                let parts: Vec<&str> = val.split_whitespace().collect();
                match parts.len() {
                    1 => {
                        if let (Some(tb), Some(lr)) = (
                            parse_page_margin_length(parts[0], page_margin_height_basis),
                            parse_page_margin_length(parts[0], page_margin_width_basis),
                        ) {
                            rule.margin_top = Some(tb);
                            rule.margin_right = Some(lr);
                            rule.margin_bottom = Some(tb);
                            rule.margin_left = Some(lr);
                            has_any = true;
                        }
                    }
                    2 => {
                        if let (Some(tb), Some(lr)) = (
                            parse_page_margin_length(parts[0], page_margin_height_basis),
                            parse_page_margin_length(parts[1], page_margin_width_basis),
                        ) {
                            rule.margin_top = Some(tb);
                            rule.margin_bottom = Some(tb);
                            rule.margin_right = Some(lr);
                            rule.margin_left = Some(lr);
                            has_any = true;
                        }
                    }
                    3 => {
                        if let (Some(t), Some(lr), Some(b)) = (
                            parse_page_margin_length(parts[0], page_margin_height_basis),
                            parse_page_margin_length(parts[1], page_margin_width_basis),
                            parse_page_margin_length(parts[2], page_margin_height_basis),
                        ) {
                            rule.margin_top = Some(t);
                            rule.margin_right = Some(lr);
                            rule.margin_bottom = Some(b);
                            rule.margin_left = Some(lr);
                            has_any = true;
                        }
                    }
                    4 => {
                        if let (Some(t), Some(r), Some(b), Some(l)) = (
                            parse_page_margin_length(parts[0], page_margin_height_basis),
                            parse_page_margin_length(parts[1], page_margin_width_basis),
                            parse_page_margin_length(parts[2], page_margin_height_basis),
                            parse_page_margin_length(parts[3], page_margin_width_basis),
                        ) {
                            rule.margin_top = Some(t);
                            rule.margin_right = Some(r);
                            rule.margin_bottom = Some(b);
                            rule.margin_left = Some(l);
                            has_any = true;
                        }
                    }
                    _ => {}
                }
            }
            "margin-top" => {
                if let Some(v) = parse_page_margin_length(val, page_margin_height_basis) {
                    rule.margin_top = Some(v);
                    has_any = true;
                }
            }
            "margin-right" => {
                if let Some(v) = parse_page_margin_length(val, page_margin_width_basis) {
                    rule.margin_right = Some(v);
                    has_any = true;
                }
            }
            "margin-bottom" => {
                if let Some(v) = parse_page_margin_length(val, page_margin_height_basis) {
                    rule.margin_bottom = Some(v);
                    has_any = true;
                }
            }
            "margin-left" => {
                if let Some(v) = parse_page_margin_length(val, page_margin_width_basis) {
                    rule.margin_left = Some(v);
                    has_any = true;
                }
            }
            // A `background`/`background-*` declaration on `@page` paints the
            // page bleed area (CSS Paged Media 3 §3.1). It is NOT parsed here
            // (the `;`-split + lowercasing above would corrupt data-URI
            // values); instead we flag its presence so the rule is retained,
            // and the value is parsed from `raw_declarations` by a CSS-aware
            // parser in the converter.
            p if p.starts_with("background") => {
                has_any = true;
            }
            "counter-reset" => {
                if let Some(value) = parse_page_counter_op(val, "page", 0) {
                    rule.page_counter.reset = Some(value);
                    has_any = true;
                }
            }
            "counter-increment" => {
                if let Some(value) = parse_page_counter_op(val, "page", 1) {
                    rule.page_counter.increment = Some(value);
                    has_any = true;
                }
            }
            "bleed" => {
                if let Some(bleed) = PageBleed::parse(val) {
                    rule.sheet.set_bleed(bleed);
                    has_any = true;
                }
            }
            "marks" => {
                if let Some(marks) = PrinterMarks::parse(val) {
                    rule.sheet.set_marks(marks);
                    has_any = true;
                }
            }
            "page-orientation" => {
                if let Some(orientation) = PageOrientation::parse(val) {
                    rule.sheet.set_orientation(orientation);
                    has_any = true;
                }
            }
            _ => {}
        }
    }

    if !text_style.is_empty() {
        rule.text_style = text_style;
        has_any = true;
    }

    if has_any {
        rule.raw_declarations = Some(decls.to_string());
        Some(rule)
    } else {
        None
    }
}

fn parse_page_counter_op(val: &str, name: &str, default: i32) -> Option<i32> {
    let mut parts = val.split_whitespace();
    let counter = parts.next()?.trim().to_ascii_lowercase();
    if counter != name {
        return None;
    }
    Some(
        parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default),
    )
}

/// Parse a page size value. Returns (width, height) in points.
pub(crate) fn parse_page_size(val: &str) -> Option<(f32, f32)> {
    let val = val.trim();
    match val {
        "a4" => return Some((595.28, 841.89)),
        "a3" => return Some((841.89, 1190.55)),
        "a5" => return Some((419.53, 595.28)),
        "letter" => return Some((612.0, 792.0)),
        "legal" => return Some((612.0, 1008.0)),
        "ledger" => return Some((792.0, 1224.0)),
        "b5" => return Some((498.9, 708.66)),
        "jis-b4" => return Some((728.50, 1031.81)),
        "jis-b5" => return Some((515.91, 728.50)),
        "portrait" => return parse_page_size("a4"),
        "landscape" => return parse_page_size("a4").map(|(width, height)| (height, width)),
        _ => {}
    }

    let parts: Vec<&str> = val.split_whitespace().collect();
    if parts.len() == 2 {
        if let (Some(w), Some(h)) = (parse_page_length(parts[0]), parse_page_length(parts[1])) {
            return Some((w, h));
        }
    }

    if parts.len() == 2 {
        let (size_name, orientation) = if matches!(parts[0], "portrait" | "landscape") {
            (parts[1], parts[0])
        } else {
            (parts[0], parts[1])
        };
        if let Some((w, h)) = parse_page_size(size_name) {
            return match orientation {
                "landscape" => Some((h, w)),
                _ => Some((w, h)),
            };
        }
    }

    None
}

/// Parse a length value for @page rules (supports mm, in, cm, pt, px).
pub(crate) fn parse_page_length(val: &str) -> Option<f32> {
    let val = val.trim();
    if let Some(n) = val.strip_suffix("mm") {
        n.trim().parse::<f32>().ok().map(|v| v * 2.83465)
    } else if let Some(n) = val.strip_suffix("cm") {
        n.trim().parse::<f32>().ok().map(|v| v * 28.3465)
    } else if let Some(n) = val.strip_suffix("in") {
        n.trim().parse::<f32>().ok().map(|v| v * 72.0)
    } else if let Some(n) = val.strip_suffix("pt") {
        n.trim().parse::<f32>().ok()
    } else if let Some(n) = val.strip_suffix("px") {
        n.trim().parse::<f32>().ok().map(|v| v * 0.75)
    } else {
        val.parse::<f32>().ok()
    }
}

fn parse_page_margin_length(val: &str, percentage_basis: Option<f32>) -> Option<f32> {
    let val = val.trim();
    if let Some(n) = val.strip_suffix('%') {
        return percentage_basis
            .zip(n.trim().parse::<f32>().ok())
            .map(|(basis, value)| basis * value / 100.0);
    }
    parse_page_length(val)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_page_size_accepts_bare_orientation_keywords() {
        assert_eq!(parse_page_size("portrait"), Some((595.28, 841.89)));
        assert_eq!(parse_page_size("landscape"), Some((841.89, 595.28)));
    }

    #[test]
    fn parse_page_size_named_formats() {
        assert!(parse_page_size("a4").is_some());
        assert!(parse_page_size("a3").is_some());
        assert!(parse_page_size("a5").is_some());
        assert!(parse_page_size("letter").is_some());
        assert!(parse_page_size("legal").is_some());
        assert!(parse_page_size("b5").is_some());
    }

    #[test]
    fn parse_page_size_custom_dimensions() {
        let (w, h) = parse_page_size("200mm 300mm").unwrap();
        assert!((w - 200.0 * 2.83465).abs() < 0.1);
        assert!((h - 300.0 * 2.83465).abs() < 0.1);
    }

    #[test]
    fn parse_page_size_named_with_landscape() {
        let (w, h) = parse_page_size("a4 landscape").unwrap();
        assert!(w > h); // landscape: width > height
    }

    #[test]
    fn parse_page_size_invalid() {
        assert!(parse_page_size("bogus").is_none());
        assert!(parse_page_size("").is_none());
    }

    #[test]
    fn parse_page_length_units() {
        assert!((parse_page_length("10mm").unwrap() - 28.3465).abs() < 0.01);
        assert!((parse_page_length("1cm").unwrap() - 28.3465).abs() < 0.01);
        assert!((parse_page_length("1in").unwrap() - 72.0).abs() < 0.01);
        assert!((parse_page_length("72pt").unwrap() - 72.0).abs() < 0.01);
        assert!((parse_page_length("96px").unwrap() - 72.0).abs() < 0.01);
        assert!((parse_page_length("100").unwrap() - 100.0).abs() < 0.01);
    }

    #[test]
    fn parse_page_length_invalid() {
        assert!(parse_page_length("abc").is_none());
    }

    #[test]
    fn parse_page_declarations_margin_1() {
        let rule = parse_page_declarations("margin: 72pt").unwrap();
        assert_eq!(rule.margin_top, Some(72.0));
        assert_eq!(rule.margin_right, Some(72.0));
        assert_eq!(rule.margin_bottom, Some(72.0));
        assert_eq!(rule.margin_left, Some(72.0));
    }

    #[test]
    fn parse_page_declarations_margin_2() {
        let rule = parse_page_declarations("margin: 36pt 72pt").unwrap();
        assert_eq!(rule.margin_top, Some(36.0));
        assert_eq!(rule.margin_bottom, Some(36.0));
        assert_eq!(rule.margin_right, Some(72.0));
        assert_eq!(rule.margin_left, Some(72.0));
    }

    #[test]
    fn parse_page_declarations_margin_3() {
        let rule = parse_page_declarations("margin: 10pt 20pt 30pt").unwrap();
        assert_eq!(rule.margin_top, Some(10.0));
        assert_eq!(rule.margin_right, Some(20.0));
        assert_eq!(rule.margin_bottom, Some(30.0));
        assert_eq!(rule.margin_left, Some(20.0));
    }

    #[test]
    fn parse_page_declarations_margin_4() {
        let rule = parse_page_declarations("margin: 10pt 20pt 30pt 40pt").unwrap();
        assert_eq!(rule.margin_top, Some(10.0));
        assert_eq!(rule.margin_right, Some(20.0));
        assert_eq!(rule.margin_bottom, Some(30.0));
        assert_eq!(rule.margin_left, Some(40.0));
    }

    #[test]
    fn parse_page_declarations_individual_margins() {
        let rule = parse_page_declarations(
            "margin-top: 10pt; margin-right: 20pt; margin-bottom: 30pt; margin-left: 40pt",
        )
        .unwrap();
        assert_eq!(rule.margin_top, Some(10.0));
        assert_eq!(rule.margin_right, Some(20.0));
        assert_eq!(rule.margin_bottom, Some(30.0));
        assert_eq!(rule.margin_left, Some(40.0));
    }

    #[test]
    fn parse_page_declarations_size() {
        let rule = parse_page_declarations("size: a4").unwrap();
        assert!(rule.width.is_some());
        assert!(rule.height.is_some());
    }

    #[test]
    fn parse_page_declarations_empty() {
        assert!(parse_page_declarations("").is_none());
        assert!(parse_page_declarations("  ;  ;  ").is_none());
    }

    #[test]
    fn parse_page_declarations_margin_percentage_uses_page_axes() {
        let rule = parse_page_declarations("size: 200px 160px; margin: 10%").unwrap();
        assert_eq!(rule.width, Some(150.0));
        assert_eq!(rule.height, Some(120.0));
        assert_eq!(rule.margin_top, Some(12.0));
        assert_eq!(rule.margin_right, Some(15.0));
        assert_eq!(rule.margin_bottom, Some(12.0));
        assert_eq!(rule.margin_left, Some(15.0));
    }

    #[test]
    fn parse_page_declarations_captures_background_raw() {
        // The @page background is retained verbatim (not lowercased/`;`-split) so
        // a CSS-aware parser can extract it later; the data-URI case survives.
        let rule = parse_page_declarations(
            "margin: 1cm; background-image: url(\"data:image/svg+xml,%3Csvg%3E\"); background-size: cover",
        )
        .unwrap();
        assert_eq!(rule.margin_top, Some(28.3465));
        let raw = rule.raw_declarations.expect("raw declarations retained");
        assert!(raw.contains("background-image"));
        assert!(raw.contains("%3Csvg"), "data-URI case preserved: {raw}");
    }

    #[test]
    fn parse_page_declarations_background_only_is_retained() {
        // An @page rule carrying ONLY a background (no size/margin) must still be
        // kept so the bleed-area background is not dropped.
        let rule =
            parse_page_declarations("background: #abc").expect("background-only @page retained");
        assert!(rule.width.is_none() && rule.margin_top.is_none());
        assert!(
            rule.raw_declarations
                .as_deref()
                .unwrap()
                .contains("background")
        );
    }

    #[test]
    fn extract_font_face_rules_basic() {
        let rules = extract_font_face_rules(
            r#"@font-face { font-family: "MyFont"; src: url("font.ttf"); }"#,
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].font_family, "MyFont");
        assert_eq!(
            rules[0].sources,
            vec![FontFaceSource::Url("font.ttf".into())]
        );
    }

    #[test]
    fn parse_font_face_descriptors() {
        let rule = parse_font_face_declarations(
            r#"
                font-family: Pick;
                src: local("Parity Serif"), url("fallback.ttf");
                font-weight: 700;
                font-style: italic;
                font-width: condensed;
                size-adjust: 150%;
                unicode-range: U+0041, U+0100-017F, U+4??;
            "#,
        )
        .unwrap();
        assert_eq!(rule.font_family, "Pick");
        assert_eq!(
            rule.sources,
            vec![
                FontFaceSource::Local("Parity Serif".into()),
                FontFaceSource::Url("fallback.ttf".into()),
            ]
        );
        assert!(rule.font_weight_bold);
        assert!(rule.font_style_italic);
        assert_eq!(rule.font_stretch, FontStretch::Condensed);
        assert!((rule.size_adjust - 1.5).abs() < f32::EPSILON);
        assert_eq!(
            rule.unicode_ranges,
            vec![
                UnicodeRange {
                    start: 0x41,
                    end: 0x41,
                },
                UnicodeRange {
                    start: 0x100,
                    end: 0x17f,
                },
                UnicodeRange {
                    start: 0x400,
                    end: 0x4ff,
                },
            ]
        );
    }

    #[test]
    fn extract_font_face_rules_multiple() {
        let css = r#"
            @font-face { font-family: "A"; src: url("a.ttf"); }
            @font-face { font-family: "B"; src: url("b.ttf"); }
        "#;
        assert_eq!(extract_font_face_rules(css).len(), 2);
    }

    #[test]
    fn parse_font_face_declarations_missing_family() {
        assert!(parse_font_face_declarations("src: url(\"f.ttf\")").is_none());
    }

    #[test]
    fn parse_font_face_declarations_missing_src() {
        assert!(parse_font_face_declarations("font-family: \"F\"").is_none());
    }

    #[test]
    fn extract_page_rules_basic() {
        let rules = extract_page_rules("@page { size: a4; margin: 1in }");
        assert_eq!(rules.len(), 1);
        assert!(rules[0].width.is_some());
        assert_eq!(rules[0].margin_top, Some(72.0));
    }

    #[test]
    fn extract_page_rules_malformed() {
        assert!(extract_page_rules("@page { bogus }").is_empty());
        assert!(extract_page_rules("@page no-brace").is_empty());
    }

    #[test]
    fn extract_page_rules_brace_balanced_keeps_trailing_decls() {
        // A nested page-margin at-rule must NOT truncate the @page block at its
        // inner `}` — the trailing `size`/`margin` declarations after the nested
        // block have to survive (the brace-balance fix).
        let rules = extract_page_rules(
            r#"@page { @top-center { content: "Title" }; size: a4; margin: 2cm }"#,
        );
        assert_eq!(rules.len(), 1, "the @page rule must be captured whole");
        assert!(
            rules[0].width.is_some(),
            "size after the nested margin box must not be dropped"
        );
        let m = 2.0 * 28.3465;
        assert!((rules[0].margin_top.unwrap() - m).abs() < 0.01);
        assert!((rules[0].margin_left.unwrap() - m).abs() < 0.01);
    }

    #[test]
    fn extract_page_rules_nested_block_does_not_leak_into_next_rule() {
        // Two @page rules with a nested margin box in the first: the second rule
        // must still be found (the scan resumes AFTER the first rule's matching
        // close brace, not its inner one).
        let rules = extract_page_rules(
            r#"@page :first { @bottom-right { content: "x" }; margin: 0 } @page { margin: 3cm }"#,
        );
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].selector, PageSelector::first());
        assert_eq!(rules[0].margin_top, Some(0.0));
        assert_eq!(rules[1].selector, PageSelector::universal());
        assert!((rules[1].margin_top.unwrap() - 3.0 * 28.3465).abs() < 0.01);
    }

    #[test]
    fn extract_page_rules_captures_selector() {
        let first = extract_page_rules("@page :first { margin: 0 }");
        assert_eq!(first[0].selector, PageSelector::first());

        let left = extract_page_rules("@page :left { margin-left: 2cm }");
        assert_eq!(left[0].selector, PageSelector::left());

        let right = extract_page_rules("@page :right { margin-right: 2cm }");
        assert_eq!(right[0].selector, PageSelector::right());

        let blank = extract_page_rules("@page :blank { margin: 1cm }");
        assert_eq!(blank[0].selector, PageSelector::blank());

        let named = extract_page_rules("@page cover { size: a4; margin: 1cm }");
        assert_eq!(named[0].selector, PageSelector::named("cover"));

        let named_left = extract_page_rules("@page chapter:left { margin-left: 2cm }");
        assert_eq!(
            named_left[0].selector,
            PageSelector::named("chapter").with_left()
        );

        let default = extract_page_rules("@page { margin: 1cm }");
        assert_eq!(default[0].selector, PageSelector::universal());
    }

    #[test]
    fn parse_page_selector_list_preserves_compounds_and_lists() {
        assert_eq!(
            parse_page_selector_list(""),
            vec![PageSelector::universal()]
        );
        assert_eq!(
            parse_page_selector_list(":first"),
            vec![PageSelector::first()]
        );
        assert_eq!(
            parse_page_selector_list(" :left "),
            vec![PageSelector::left()]
        );
        assert_eq!(
            parse_page_selector_list(":RIGHT"),
            vec![PageSelector::right()]
        );
        assert_eq!(
            parse_page_selector_list("cover"),
            vec![PageSelector::named("cover")]
        );
        assert_eq!(
            parse_page_selector_list("chapter:left:first"),
            vec![PageSelector::named("chapter").with_left().with_first()]
        );
        assert_eq!(
            parse_page_selector_list("title, chapter:right"),
            vec![
                PageSelector::named("title"),
                PageSelector::named("chapter").with_right()
            ]
        );
        assert_eq!(
            parse_page_selector_list(":left:left")[0].specificity(),
            (0, 0, 2)
        );
        assert!(parse_page_selector_list(":unknown").is_empty());
    }

    #[test]
    fn extract_page_rules_keeps_first_and_right_as_independent_cascade_inputs() {
        let rules = extract_page_rules(
            "@page{margin:0}@page :right{margin-left:40pt}@page :first{margin-top:20pt}",
        );
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].selector, PageSelector::universal());
        assert_eq!(rules[1].selector, PageSelector::right());
        assert_eq!(rules[2].selector, PageSelector::first());
    }

    #[test]
    fn extract_page_rules_parses_margin_box_counters() {
        let rules = extract_page_rules(
            r#"@page { @bottom-center { content: "Page " counter(page) " of " counter(pages) } }"#,
        );
        assert_eq!(rules.len(), 1, "a margin-box-only @page must be retained");
        assert_eq!(rules[0].margin_boxes.len(), 1);
        let mb = &rules[0].margin_boxes[0];
        assert_eq!(mb.position, MarginBoxPosition::BottomCenter);
        assert_eq!(
            mb.content,
            vec![
                MarginContentToken::Literal("Page ".to_string()),
                MarginContentToken::PageNumber,
                MarginContentToken::Literal(" of ".to_string()),
                MarginContentToken::PageCount,
            ]
        );
    }

    #[test]
    fn page_counter_controls_propagate_to_margin_boxes() {
        let rules = extract_page_rules(
            r#"@page { counter-reset: page 7; counter-increment: page 2; @top-center { content: counter(page) } }"#,
        );
        let counter = rules[0].margin_boxes[0].page_counter;
        assert_eq!(counter.reset, Some(7));
        assert_eq!(counter.increment, Some(2));
    }

    #[test]
    fn page_counter_operations_use_their_css_defaults() {
        assert_eq!(parse_page_counter_op("page", "page", 0), Some(0));
        assert_eq!(parse_page_counter_op("page", "page", 1), Some(1));
    }

    #[test]
    fn margin_box_current_color_resolves_after_color_cascade() {
        let rules = extract_page_rules(
            r#"@page { @top-center { content: "x"; background-color: currentColor; color: rgb(20 40 60) } }"#,
        );
        let margin_box = &rules[0].margin_boxes[0];
        let expected = crate::types::Color::rgb(20, 40, 60);
        assert_eq!(margin_box.color, Some(expected));
        assert_eq!(margin_box.background_color, Some(expected));
    }

    #[test]
    fn margin_box_width_uses_page_length_units_and_rejects_negative_values() {
        let rules = extract_page_rules(
            r#"@page { @top-center { content: "x"; width: 160px } @bottom-center { content: "x"; width: -1px } }"#,
        );
        assert_eq!(rules[0].margin_boxes[0].width, Some(120.0));
        assert_eq!(rules[0].margin_boxes[1].width, None);
    }

    #[test]
    fn footnote_border_current_color_resolves_without_a_sentinel() {
        let rules = parse_page_rules("@page { @footnote { border-top: 1pt solid currentColor } }");
        assert_eq!(
            rules[0].footnote_area.unwrap().separator.color,
            Some(crate::types::Color::BLACK)
        );
    }

    #[test]
    fn footnote_padding_shorthand_and_longhand_keep_physical_edges() {
        let rules = parse_page_rules(
            "@page { @footnote { padding: 1pt 2pt 3pt 4pt; padding-right: 5pt } }",
        );
        let padding = rules[0].footnote_area.unwrap().padding;
        assert_eq!(padding.top, Some(1.0));
        assert_eq!(padding.right, Some(5.0));
        assert_eq!(padding.bottom, Some(3.0));
        assert_eq!(padding.left, Some(4.0));
    }

    #[test]
    fn invalid_footnote_padding_shorthand_is_atomic() {
        let rules = parse_page_rules(
            "@page { @footnote { max-height: -1pt; padding: 1pt 2pt bogus 4pt; padding-left: 7pt } }",
        );
        let area = rules[0].footnote_area.unwrap();
        assert_eq!(area.max_height, None);
        assert_eq!(area.padding.top, None);
        assert_eq!(area.padding.right, None);
        assert_eq!(area.padding.bottom, None);
        assert_eq!(area.padding.left, Some(7.0));
    }

    #[test]
    fn later_footnote_rule_retains_omitted_declaration_state() {
        let rules = parse_page_rules(
            "@page {\
                 @footnote { padding: 1pt 2pt 3pt 4pt; border-top: 2pt solid red }\
                 @footnote { max-height: 20pt; padding-right: 9pt }\
             }",
        );
        let area = rules[0].footnote_area.unwrap();
        assert_eq!(area.padding.top, Some(1.0));
        assert_eq!(area.padding.right, Some(9.0));
        assert_eq!(area.padding.bottom, Some(3.0));
        assert_eq!(area.padding.left, Some(4.0));
        assert_eq!(area.separator.width, Some(2.0));
        assert_eq!(
            area.separator.color,
            Some(crate::types::Color::rgb(255, 0, 0))
        );
        assert_eq!(area.max_height, Some(20.0));
    }

    #[test]
    fn top_level_footnote_rule_is_not_a_page_context_rule() {
        assert!(parse_page_rules("@footnote { border-top: 2pt solid red }").is_empty());
    }

    #[test]
    fn extract_page_rules_margin_box_with_geometry() {
        // Margin boxes coexist with size/margin in the same @page block.
        let rules = extract_page_rules(
            r#"@page { size: a4; margin: 2cm; @top-left { content: "Title" }; @top-right { content: counter(page) } }"#,
        );
        assert_eq!(rules.len(), 1);
        assert!(rules[0].width.is_some(), "size must survive margin boxes");
        assert!((rules[0].margin_top.unwrap() - 2.0 * 28.3465).abs() < 0.01);
        assert_eq!(rules[0].margin_boxes.len(), 2);
        assert_eq!(
            rules[0].margin_boxes[0].position,
            MarginBoxPosition::TopLeft
        );
        assert_eq!(
            rules[0].margin_boxes[1].position,
            MarginBoxPosition::TopRight
        );
        assert_eq!(
            rules[0].margin_boxes[1].content,
            vec![MarginContentToken::PageNumber]
        );
    }

    #[test]
    fn parse_margin_box_content_decimal_style_ignored() {
        // `counter(page, decimal)` resolves like bare `counter(page)`.
        let toks = parse_margin_box_content(r##""#" counter(page, decimal)"##);
        assert_eq!(
            toks,
            vec![
                MarginContentToken::Literal("#".to_string()),
                MarginContentToken::PageNumber,
            ]
        );
    }

    #[test]
    fn parse_margin_box_content_single_quotes() {
        let toks = parse_margin_box_content(r#"'p.' counter(page)"#);
        assert_eq!(
            toks,
            vec![
                MarginContentToken::Literal("p.".to_string()),
                MarginContentToken::PageNumber,
            ]
        );
    }

    #[test]
    fn parse_margin_box_content_decodes_css_string_escapes() {
        // CSS Syntax 3 requires escaped code points to enter the string token's value.
        let tokens = parse_margin_box_content(r#""A \00B7  B \2022  \2014""#);

        assert_eq!(
            tokens,
            vec![MarginContentToken::Literal("A · B • —".to_string())]
        );
    }

    #[test]
    fn parse_margin_box_content_element_reference() {
        let toks = parse_margin_box_content("element(runhead)");
        assert_eq!(
            toks,
            vec![MarginContentToken::Element(PageContentReference::new(
                "runhead".to_string(),
                crate::parser::css::PageContentPolicy::First,
            ))]
        );
    }

    #[test]
    fn margin_box_position_band_and_align() {
        assert_eq!(
            MarginBoxPosition::BottomCenter.band(),
            Some(crate::parser::css::MarginBoxBand::Bottom)
        );
        assert_eq!(MarginBoxPosition::LeftMiddle.band(), None);
        assert_eq!(
            MarginBoxPosition::TopRight.align(),
            crate::parser::css::MarginBoxAlign::Right
        );
        assert_eq!(
            MarginBoxPosition::TopRightCorner.align(),
            crate::parser::css::MarginBoxAlign::Left
        );
        assert_eq!(
            MarginBoxPosition::TopLeftCorner.align(),
            crate::parser::css::MarginBoxAlign::Right
        );
        assert_eq!(
            MarginBoxPosition::RightMiddle.align(),
            crate::parser::css::MarginBoxAlign::Center
        );
    }

    #[test]
    fn parse_page_rules_integration() {
        let rules = parse_page_rules("body {} @page { size: letter; margin: 1in }");
        assert_eq!(rules.len(), 1);
    }

    #[test]
    fn parse_font_face_rules_integration() {
        let rules = parse_font_face_rules(r#"@font-face { font-family: "X"; src: url("x.ttf"); }"#);
        assert_eq!(rules.len(), 1);
    }
}
