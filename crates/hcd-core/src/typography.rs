//! Authored typography survives editor projections and structural checkpoints.
//! Family values are requested CSS stacks, not resolved font-file identities.
use crate::HcdError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextTypography {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bidi: Option<String>,
}

impl TextTypography {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
    pub fn validate(&self) -> Result<(), HcdError> {
        if self
            .family
            .as_deref()
            .is_some_and(|value| !safe_family_stack(value))
            || [&self.latin, &self.east_asia, &self.bidi]
                .into_iter()
                .flatten()
                .any(|value| !safe_family_name(value))
        {
            return Err(HcdError::InvalidPatch(
                "invalid typography font family".into(),
            ));
        }
        if self
            .size_pt
            .is_some_and(|size| !size.is_finite() || size <= 0.0 || size > 4096.0)
        {
            return Err(HcdError::InvalidPatch(
                "typography sizePt must be finite, greater than 0 and at most 4096".into(),
            ));
        }
        Ok(())
    }
    pub(crate) fn css(&self) -> String {
        let mut css = String::new();
        if let Some(family) = &self.family {
            css.push_str(&format!("font-family:{family};"));
        }
        if let Some(size) = self.size_pt {
            css.push_str(&format!("font-size:{size}pt;"));
        }
        css
    }
}

fn safe_family_name(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || " -_,.'".contains(c))
}

pub(crate) fn safe_family_stack(value: &str) -> bool {
    if value.is_empty() || value.len() > 2048 {
        return false;
    }
    let mut quote = None;
    let mut start = 0;
    let mut families = Vec::new();
    for (index, character) in value.char_indices() {
        if let Some(current) = quote {
            if character == current {
                quote = None;
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character == ',' {
            families.push(&value[start..index]);
            start = index + 1;
        }
    }
    families.push(&value[start..]);
    quote.is_none()
        && families.len() <= 16
        && families.into_iter().all(|family| {
            let family = family.trim();
            if let Some(quote) = family.chars().next().filter(|c| matches!(c, '\'' | '"')) {
                family.len() >= 2 && family.ends_with(quote) && {
                    let name = &family[1..family.len() - 1];
                    !name.contains(quote) && safe_family_name(name)
                }
            } else {
                !family.is_empty()
                    && family.len() <= 256
                    && family.split_whitespace().all(|word| {
                        let mut chars = word.chars();
                        chars
                            .next()
                            .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '-')
                            && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '-')
                    })
            }
        })
}

#[derive(Clone, Copy)]
struct Element<'a, 'input>(roxmltree::Node<'a, 'input>);
impl simplecss::Element for Element<'_, '_> {
    fn parent_element(&self) -> Option<Self> {
        self.0.parent_element().map(Self)
    }
    fn prev_sibling_element(&self) -> Option<Self> {
        self.0
            .prev_siblings()
            .skip(1)
            .find(|node| node.is_element())
            .map(Self)
    }
    fn has_local_name(&self, name: &str) -> bool {
        self.0.tag_name().name() == name
    }
    fn attribute_matches(&self, name: &str, operator: simplecss::AttributeOperator<'_>) -> bool {
        self.0
            .attribute(name)
            .is_some_and(|value| operator.matches(value))
    }
    fn pseudo_class_matches(&self, class: simplecss::PseudoClass<'_>) -> bool {
        match class {
            simplecss::PseudoClass::FirstChild => self
                .0
                .prev_siblings()
                .skip(1)
                .all(|node| !node.is_element()),
            simplecss::PseudoClass::Link => {
                self.0.has_tag_name("a") && self.0.attribute("href").is_some()
            }
            simplecss::PseudoClass::Lang(language) => self
                .0
                .ancestors()
                .filter(|node| node.is_element())
                .find_map(|node| node.attribute("lang"))
                .is_some_and(|value| {
                    value == language
                        || value
                            .strip_prefix(language)
                            .is_some_and(|rest| rest.starts_with('-'))
                }),
            _ => false,
        }
    }
}

fn size_pt(value: &str, parent: Option<f32>, root: Option<f32>) -> Option<f32> {
    let (number, factor) = if let Some(number) = value.strip_suffix("rem") {
        (number, root.unwrap_or(12.0))
    } else if let Some(number) = value.strip_suffix("em") {
        (number, parent.unwrap_or(12.0))
    } else if let Some(number) = value.strip_suffix('%') {
        (number, parent.unwrap_or(12.0) / 100.0)
    } else if let Some(number) = value.strip_suffix("px") {
        (number, 0.75)
    } else if let Some(number) = value.strip_suffix("pt") {
        (number, 1.0)
    } else {
        return None;
    };
    number
        .trim()
        .parse::<f32>()
        .ok()
        .map(|size| size * factor)
        .filter(|size| size.is_finite() && *size > 0.0 && *size <= 4096.0)
}

fn typography_property(name: &str) -> bool {
    matches!(
        name,
        "font"
            | "font-family"
            | "font-size"
            | "-hcd-font-latin"
            | "-hcd-font-east-asia"
            | "-hcd-font-bidi"
    )
}

/// Resolve the bounded CSS 2.1 typography used by generated HCD. Work is capped
/// before a full editor can publish a lossy projection. This does not implement
/// arbitrary CSS layout, font availability, or variable font instance selection.
pub fn resolve_typography(
    html: &str,
    stylesheet: &str,
) -> Result<HashMap<String, TextTypography>, HcdError> {
    TypographyResolver::new(stylesheet)?.resolve(html)
}

pub struct TypographyResolver<'a> {
    sheet: simplecss::StyleSheet<'a>,
}
impl<'a> TypographyResolver<'a> {
    pub fn new(stylesheet: &'a str) -> Result<Self, HcdError> {
        if stylesheet.len() as u64 > crate::MAX_CONTROL_PART_BYTES {
            return Err(HcdError::ResourceLimit(
                "typography stylesheet exceeds control-part limit".into(),
            ));
        }
        let mut sheet = simplecss::StyleSheet::parse(stylesheet);
        sheet.rules.retain(|rule| {
            rule.declarations
                .iter()
                .any(|d| typography_property(d.name))
        });
        if sheet.rules.len() > 4096 {
            return Err(HcdError::ResourceLimit(
                "typography stylesheet exceeds 4096 font rules".into(),
            ));
        }
        Ok(Self { sheet })
    }
    /// Annotate a transient export fragment with resolved font requests. The
    /// canonical revision is untouched; no source text or element is rebuilt.
    pub fn annotate_export(&self, html: &str) -> Result<String, HcdError> {
        let fonts = self.resolve(html)?;
        let prefix = "<html><body>";
        let wrapped = format!("{prefix}{html}</body></html>");
        let document = roxmltree::Document::parse(&wrapped)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let mut insertions = Vec::new();
        for node in document.descendants().filter(|node| node.is_element()) {
            if node.attribute("data-hcd-export-typography").is_some() {
                return Err(HcdError::InvalidBundle(
                    "reserved export typography attribute in canonical HTML".into(),
                ));
            }
            if node.attribute("data-hcd-node-hash").is_none() {
                continue;
            }
            let Some(font) = node.attribute("data-hcd-id").and_then(|id| fonts.get(id)) else {
                continue;
            };
            let start = node.range().start - prefix.len();
            let mut quote = None;
            let end = html[start..]
                .char_indices()
                .find_map(|(offset, character)| {
                    if let Some(current) = quote {
                        if character == current {
                            quote = None;
                        }
                    } else if character == '\'' || character == '"' {
                        quote = Some(character);
                    } else if character == '>' {
                        return Some(start + offset);
                    }
                    None
                })
                .ok_or_else(|| HcdError::InvalidBundle("unterminated typography element".into()))?;
            let position = if html.as_bytes().get(end.wrapping_sub(1)) == Some(&b'/') {
                end - 1
            } else {
                end
            };
            let json = serde_json::to_string(font)?;
            let escaped = json
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            insertions.push((
                position,
                format!(" data-hcd-export-typography=\"{escaped}\""),
            ));
        }
        let mut output = String::with_capacity(
            html.len()
                + insertions
                    .iter()
                    .map(|(_, value)| value.len())
                    .sum::<usize>(),
        );
        let mut offset = 0;
        for (position, annotation) in insertions {
            output.push_str(&html[offset..position]);
            output.push_str(&annotation);
            offset = position;
        }
        output.push_str(&html[offset..]);
        Ok(output)
    }

    pub fn resolve(&self, html: &str) -> Result<HashMap<String, TextTypography>, HcdError> {
        let rules = &self.sheet.rules;
        let wrapped = format!("<html><body>{html}</body></html>");
        let document = roxmltree::Document::parse(&wrapped)
            .map_err(|error| HcdError::InvalidBundle(format!("typography HTML: {error}")))?;
        let mut needed = std::collections::HashSet::new();
        for node in document.descendants().filter(|node| {
            node.is_element()
                && node.attribute("data-hcd-node-hash").is_some()
                && node.attribute("data-hcd-node-kind") != Some("image")
        }) {
            let ancestors: Vec<_> = node.ancestors().take(130).collect();
            if ancestors.len() > 128 {
                return Err(HcdError::ResourceLimit(
                    "typography element nesting exceeds 128".into(),
                ));
            }
            needed.extend(
                ancestors
                    .into_iter()
                    .filter(|node| node.is_element())
                    .map(|node| node.range().start),
            );
        }
        let mut resolved = HashMap::new();
        let mut output = HashMap::new();
        let mut checks = 0usize;
        let mut root_size = None;
        for node in document
            .descendants()
            .filter(|node| node.is_element() && needed.contains(&node.range().start))
        {
            if node.ancestors().take(130).count() > 128 {
                return Err(HcdError::ResourceLimit(
                    "typography element nesting exceeds 128".into(),
                ));
            }
            let inherited: TextTypography = node
                .parent_element()
                .and_then(|parent| resolved.get(&parent.range().start))
                .cloned()
                .unwrap_or_default();
            let mut current = inherited.clone();
            type CascadeRank = (bool, bool, [u8; 3], usize);
            let mut properties: HashMap<&str, (CascadeRank, &str)> = HashMap::new();
            for (order, rule) in rules.iter().enumerate() {
                checks += 1;
                if checks > 2_000_000 {
                    return Err(HcdError::ResourceLimit(
                        "typography selector work exceeds limit".into(),
                    ));
                }
                if rule.selector.matches(&Element(node)) {
                    for declaration in &rule.declarations {
                        if !typography_property(declaration.name) {
                            continue;
                        }
                        let rank = (
                            declaration.important,
                            false,
                            rule.selector.specificity(),
                            order,
                        );
                        if properties
                            .get(declaration.name)
                            .is_none_or(|(old, _)| rank >= *old)
                        {
                            properties.insert(declaration.name, (rank, declaration.value));
                        }
                    }
                }
            }
            for (order, declaration) in
                simplecss::DeclarationTokenizer::from(node.attribute("style").unwrap_or(""))
                    .enumerate()
            {
                if !typography_property(declaration.name) {
                    continue;
                }
                let rank = (declaration.important, true, [0, 0, 0], order);
                if properties
                    .get(declaration.name)
                    .is_none_or(|(old, _)| rank >= *old)
                {
                    properties.insert(declaration.name, (rank, declaration.value));
                }
            }
            if properties.contains_key("font") {
                return Err(HcdError::Unsupported(
                    "font shorthand needs expansion before full editing".into(),
                ));
            }
            if let Some((_, value)) = properties.get("font-family") {
                current.family = match value.trim() {
                    "inherit" | "unset" => inherited.family.clone(),
                    "initial" => Some("serif".into()),
                    family if safe_family_stack(family) => Some(family.into()),
                    _ => {
                        return Err(HcdError::Unsupported(
                            "unsupported typography font-family".into(),
                        ))
                    }
                };
            }
            if let Some((_, value)) = properties.get("font-size") {
                current.size_pt = match value.trim() {
                    "inherit" | "unset" => inherited.size_pt,
                    "initial" => Some(12.0),
                    value => {
                        Some(size_pt(value, inherited.size_pt, root_size).ok_or_else(|| {
                            HcdError::Unsupported("unsupported typography font-size".into())
                        })?)
                    }
                };
            }
            if node.has_tag_name("html") {
                root_size = current.size_pt;
            }
            for (property, slot) in [
                ("-hcd-font-latin", &mut current.latin),
                ("-hcd-font-east-asia", &mut current.east_asia),
                ("-hcd-font-bidi", &mut current.bidi),
            ] {
                if let Some((_, value)) = properties.get(property) {
                    match value.trim() {
                        "inherit" | "unset" => {}
                        "initial" => *slot = None,
                        value => {
                            let name = serde_json::from_str::<String>(value)
                                .unwrap_or_else(|_| value.trim_matches('\'').to_string());
                            if !safe_family_name(&name) {
                                return Err(HcdError::Unsupported(
                                    "invalid script font metadata".into(),
                                ));
                            }
                            *slot = Some(name);
                        }
                    }
                }
            }
            for (attribute, slot) in [
                ("data-hcd-font-latin", &mut current.latin),
                ("data-hcd-font-east-asia", &mut current.east_asia),
                ("data-hcd-font-bidi", &mut current.bidi),
            ] {
                if let Some(value) = node.attribute(attribute) {
                    *slot = Some(value.into());
                }
            }
            current.validate()?;
            if node.attribute("data-hcd-node-hash").is_some() {
                if let Some(id) = node.attribute("data-hcd-id") {
                    if !current.is_empty() {
                        output.insert(id.to_string(), current.clone());
                    }
                }
            }
            resolved.insert(node.range().start, current);
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text(style: &str) -> String {
        format!("<p class=\"body\"><span data-hcd-id=\"run\" data-hcd-node-hash=\"hash\" style=\"{style}\">中文Text</span></p>")
    }
    #[test]
    fn stylesheet_language_font_slots_inherit_without_truncating_following_font_family() {
        let html = "<p><span data-hcd-id=\"run\" data-hcd-node-hash=\"hash\">中Text</span></p>";
        let resolved = resolve_typography(html, "p {-hcd-font-latin:\"Times New Roman\";-hcd-font-east-asia:\"宋体\";-hcd-font-bidi:\"Arial\";font-family:'Times New Roman','宋体',serif;font-size:14pt}").unwrap();
        assert_eq!(resolved["run"].latin.as_deref(), Some("Times New Roman"));
        assert_eq!(resolved["run"].east_asia.as_deref(), Some("宋体"));
        assert_eq!(resolved["run"].bidi.as_deref(), Some("Arial"));
        assert_eq!(
            resolved["run"].family.as_deref(),
            Some("'Times New Roman','宋体',serif")
        );
        assert_eq!(resolved["run"].size_pt, Some(14.0));
    }

    #[test]
    fn cascade_inheritance_relative_sizes_and_named_font_slots() {
        let html = "<div class=\"body\" data-hcd-font-east-asia=\"宋体\"><p><span data-hcd-id=\"run\" data-hcd-node-hash=\"hash\" style=\"font-size:150%\">字Text</span></p></div>";
        let fonts = resolve_typography(html, ".body {font-family:'Times New Roman', serif;font-size:16pt} .body > p {font-size:0.5em}").unwrap();
        assert_eq!(fonts["run"].size_pt, Some(12.0));
        assert_eq!(
            fonts["run"].family.as_deref(),
            Some("'Times New Roman', serif")
        );
        assert_eq!(fonts["run"].east_asia.as_deref(), Some("宋体"));
    }
    #[test]
    fn important_and_source_order_override_inline_and_specificity() {
        let html = text("font-size:12pt");
        assert_eq!(
            resolve_typography(
                &html,
                "p span {font-size:16px!important} span {font-size:20pt!important}"
            )
            .unwrap()["run"]
                .size_pt,
            Some(12.0)
        );
        assert_eq!(
            resolve_typography(
                &text("font-size:18pt!important"),
                "p span {font-size:20pt!important}"
            )
            .unwrap()["run"]
                .size_pt,
            Some(18.0)
        );
        assert_eq!(
            resolve_typography(&html, "span{font-size:8pt} span{font-size:20pt}").unwrap()["run"]
                .size_pt,
            Some(12.0)
        );
    }
    #[test]
    fn export_annotation_preserves_markup_text_and_inherited_multilingual_fonts() {
        let html = "<p class=\"body\"><strong><span title=\"a &gt; b\" data-hcd-id=\"n1\" data-hcd-node-hash=\"hash\" data-hcd-font-east-asia=\"宋体\"> A  中😀 &amp; B </span></strong></p>";
        let resolver =
            TypographyResolver::new(".body{font-family:\"O'Name\",serif;font-size:14pt}").unwrap();
        let annotated = resolver.annotate_export(html).unwrap();
        assert!(annotated.contains(" A  中😀 &amp; B "));
        assert!(annotated.contains("<strong>"));
        let parsed = roxmltree::Document::parse(&annotated).unwrap();
        let font: TextTypography = serde_json::from_str(
            parsed
                .descendants()
                .find_map(|node| node.attribute("data-hcd-export-typography"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(font.size_pt, Some(14.0));
        assert_eq!(font.east_asia.as_deref(), Some("宋体"));
        assert_eq!(font.family.as_deref(), Some("\"O'Name\",serif"));
        assert!(!html.contains("data-hcd-export-typography"));
        assert!(resolver.annotate_export(&annotated).is_err());
    }

    #[test]
    fn family_grammar_and_xml_escaping_do_not_allow_style_injection() {
        for family in [
            "'A,B', serif",
            "Times New Roman,宋体,sans-serif",
            "\"O'Name\",serif",
        ] {
            assert!(safe_family_stack(family), "{family}");
        }
        for family in [
            "Arial'B'",
            "'A'B",
            "'unterminated",
            ",Arial",
            "Arial,",
            "Arial;color:red",
            "url(x)",
            "\"<script>\"",
            "Arial\\41",
            ".Foo",
            "12font",
        ] {
            assert!(!safe_family_stack(family), "{family}");
        }
        assert!(resolve_typography(&text("font-family:Arial;color:red"), "").is_ok());
        assert!(TextTypography {
            size_pt: Some(f32::INFINITY),
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn unsupported_css_stops_projection_instead_of_erasing_typography() {
        assert!(resolve_typography(&text("font:italic 12pt serif"), "").is_err());
        assert!(resolve_typography(&text("font-size:calc(12pt + 1pt)"), "").is_err());
        // Decoration outside the text subtree must not make normal Word projection fail.
        assert!(resolve_typography(
            &format!("<i style=\"font-size:0\"></i>{}", text("font-size:12pt")),
            ""
        )
        .is_ok());
        let deep = format!(
            "{}{}{}",
            "<div>".repeat(130),
            text(""),
            "</div>".repeat(130)
        );
        assert!(matches!(
            resolve_typography(&deep, ""),
            Err(HcdError::ResourceLimit(_))
        ));
        assert!(matches!(
            TypographyResolver::new(&"span {font-size:12pt}".repeat(4097)),
            Err(HcdError::ResourceLimit(_))
        ));
    }
}
