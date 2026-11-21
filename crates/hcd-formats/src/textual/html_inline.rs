//! Safe inline semantics for source-mapped HTML text. Wrappers are emitted per
//! text anchor, so malformed input and chunk/table boundaries cannot leave open
//! formatting tags, and source byte ranges remain those of the original text.
use super::{escape_attribute, HcdError, HtmlTag, HTML_SOURCE_MAX_DEPTH};

#[derive(Clone, Default)]
struct InlineState {
    bold: Option<bool>,
    italic: Option<bool>,
    link: Option<(String, String)>,
}

#[derive(Default)]
pub(super) struct HtmlInline {
    frames: Vec<(String, InlineState)>,
}

impl HtmlInline {
    pub(super) fn tag(&mut self, tag: &HtmlTag) -> Result<(), HcdError> {
        if tag.closing {
            if let Some(index) = self.frames.iter().rposition(|frame| frame.0 == tag.name) {
                self.frames.truncate(index);
            }
            return Ok(());
        }
        if tag.self_closing || super::is_void_html_element(&tag.name) {
            return Ok(());
        }
        close_implicit(&mut self.frames, &tag.name, |frame| &frame.0);
        let mut state = self
            .frames
            .last()
            .map(|frame| frame.1.clone())
            .unwrap_or_default();
        let parent_bold = state.bold;
        let parent_italic = state.italic;
        match tag.name.as_str() {
            // Heading defaults remain on the semantic block, rather than
            // becoming an artificial explicit mark on every title run.
            "b" | "strong" | "th" => state.bold = Some(true),
            "i" | "em" => state.italic = Some(true),
            _ => {}
        }
        let mut bold_important = false;
        let mut italic_important = false;
        if let Some(css) = tag.attributes.get("style") {
            for declaration in css.split(';') {
                let Some((property, raw)) = declaration.split_once(':') else {
                    continue;
                };
                let lower = raw.trim().to_ascii_lowercase();
                let (value, important) = lower
                    .strip_suffix("!important")
                    .map(|value| (value.trim(), true))
                    .unwrap_or((&lower, false));
                let property = property.trim().to_ascii_lowercase();
                let (slot, parent, priority) = match property.as_str() {
                    "font-weight" => (&mut state.bold, parent_bold, &mut bold_important),
                    "font-style" => (&mut state.italic, parent_italic, &mut italic_important),
                    _ => continue,
                };
                let parsed = match value {
                    "inherit" | "unset" => Some(parent),
                    "initial" | "normal" => Some(Some(false)),
                    "bold" if property == "font-weight" => Some(Some(true)),
                    "italic" | "oblique" if property == "font-style" => Some(Some(true)),
                    _ if property == "font-weight" => value
                        .parse::<u16>()
                        .ok()
                        .filter(|weight| (1..=1000).contains(weight))
                        .map(|weight| Some(weight >= 600)),
                    _ => None,
                };
                if let Some(parsed) = parsed {
                    if important || !*priority {
                        *slot = parsed;
                        *priority = important;
                    }
                }
            }
        }
        if tag.name == "a" {
            state.link = tag
                .attributes
                .get("href")
                .map(|value| value.trim())
                .filter(|value| value.len() <= 2048 && hcd_core::is_safe_hyperlink(value))
                .map(|value| {
                    let title = tag
                        .attributes
                        .get("title")
                        .filter(|title| title.len() <= 8192 && !title.chars().any(char::is_control))
                        .cloned()
                        .unwrap_or_default();
                    (value.to_string(), title)
                });
        }
        if self.frames.len() >= HTML_SOURCE_MAX_DEPTH {
            return Err(HcdError::ResourceLimit(format!(
                "HTML inline source exceeds nesting depth {HTML_SOURCE_MAX_DEPTH}"
            )));
        }
        self.frames.push((tag.name.clone(), state));
        Ok(())
    }

    pub(super) fn wrap(&self, text_node: String) -> String {
        let Some((_, state)) = self.frames.last() else {
            return text_node;
        };
        let mut open = String::new();
        let mut close = Vec::new();
        if let Some((href, title)) = &state.link {
            open.push_str(&format!("<a href=\"{}\"", escape_attribute(href)));
            if !title.is_empty() {
                open.push_str(&format!(" title=\"{}\"", escape_attribute(title)));
            }
            open.push('>');
            close.push("</a>");
        }
        // Each wrapper reflects the effective state, not the raw nesting. No
        // outer source <strong> can override a child's explicit normal reset.
        if state.bold == Some(true) {
            // UA strong uses `bolder`, which otherwise escalates a 700-weight
            // heading/table header to 900 merely by canonicalizing its runs.
            open.push_str("<strong style=\"font-weight:700\">");
            close.push("</strong>");
        }
        if state.italic == Some(true) {
            open.push_str("<em>");
            close.push("</em>");
        }
        let mut normal = String::new();
        if state.bold == Some(false) {
            normal.push_str("font-weight:normal;");
        }
        if state.italic == Some(false) {
            normal.push_str("font-style:normal;");
        }
        if !normal.is_empty() {
            open.push_str(&format!("<span style=\"{normal}\">"));
            close.push("</span>");
        }
        open.push_str(&text_node);
        for closing in close.into_iter().rev() {
            open.push_str(closing);
        }
        open
    }
}

/// The scanner and style stack must agree on optional HTML end tags. In
/// particular, an omitted </td> cannot leak a cell's styles into the next cell
/// or make an otherwise bounded long table exceed the nesting budget.
pub(super) fn close_implicit<T>(stack: &mut Vec<T>, new_tag: &str, name: impl Fn(&T) -> &str) {
    let (targets, barriers): (&[&str], &[&str]) = match new_tag {
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre" | "div" | "table" => {
            (&["p"], &["body", "td", "th", "table"])
        }
        "li" => (&["li"], &["ul", "ol"]),
        "tr" => (&["tr"], &["table"]),
        "td" | "th" => (&["td", "th"], &["tr", "table"]),
        _ => return,
    };
    for index in (0..stack.len()).rev() {
        let current = name(&stack[index]);
        if targets.contains(&current) {
            stack.truncate(index);
            break;
        }
        if barriers.contains(&current) {
            break;
        }
    }
}
