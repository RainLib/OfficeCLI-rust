//! Font-size partitions keep the original canonical text node and source anchor.
//! Text lives only in HTML; metadata holds Unicode-scalar counts and overrides.
use crate::{hash_bytes, HcdError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

const ATTRIBUTE: &str = "data-hcd-text-runs";
const MAX_RUNS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontSizeRun {
    pub chars: usize,
    /// Omitted means preserve the original source run's formatting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextRunsPrecondition {
    pub node_hash: String,
    pub format_hash: String,
}

pub(crate) struct TextSpan {
    pub font_size_explicit: bool,
    pub range: Range<usize>,
    pub html: String,
    pub runs: Option<Vec<FontSizeRun>>,
    open_end: usize,
    close_start: usize,
    owned_attributes: Vec<Range<usize>>,
    nested_source_markup: bool,
    name: String,
}

pub(crate) fn spans(html: &str) -> Result<HashMap<String, TextSpan>, HcdError> {
    let wrapped = format!("<hcd>{html}</hcd>");
    let document = roxmltree::Document::parse(&wrapped)
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    let mut output = HashMap::new();
    for node in document.descendants().filter(|node| {
        node.is_element()
            && node.tag_name().name() == "span"
            && node.has_attribute("data-hcd-node-hash")
    }) {
        let id = node
            .attribute("data-hcd-id")
            .ok_or_else(|| HcdError::InvalidBundle("canonical text has no ID".into()))?;
        let range = node.range();
        let raw = &wrapped[range.clone()];
        let runs = node
            .attribute(ATTRIBUTE)
            .map(serde_json::from_str)
            .transpose()?;
        // XML's parser supplies attribute ranges; unknown attributes, qualified
        // names, namespace declarations, and all original quote choices survive.
        let owned_attributes = node
            .attributes()
            .iter()
            .filter(|attribute| {
                attribute.namespace().is_none()
                    && [ATTRIBUTE, "data-hcd-node-hash"].contains(&attribute.name())
            })
            .map(|attribute| {
                attribute.range().start - range.start..attribute.value_range().end + 1 - range.start
            })
            .collect();
        let mut quote = None;
        let open_end = raw
            .char_indices()
            .find_map(|(index, character)| {
                if let Some(active) = quote {
                    if character == active {
                        quote = None;
                    }
                } else if character == '\'' || character == '"' {
                    quote = Some(character);
                } else if character == '>' {
                    return Some(index);
                }
                None
            })
            .ok_or_else(|| HcdError::InvalidBundle("text start tag is missing".into()))?;
        let close_start = raw.rfind("</").unwrap_or(open_end);
        let name = raw[1..]
            .split(|character: char| character.is_whitespace() || matches!(character, '/' | '>'))
            .next()
            .unwrap_or("span")
            .to_string();
        if output
            .insert(
                id.to_string(),
                TextSpan {
                    font_size_explicit: node.attribute("data-hcd-size-explicit") == Some("true"),
                    range: range.start - 5..range.end - 5,
                    html: raw.to_string(),
                    runs,
                    open_end,
                    close_start,
                    owned_attributes,
                    name,
                    nested_source_markup: node.descendants().skip(1).any(|child| {
                        child.is_element() && child.attribute("data-hcd-size-run") != Some("1")
                    }),
                },
            )
            .is_some()
        {
            return Err(HcdError::InvalidBundle(
                "duplicate canonical format node".into(),
            ));
        }
    }
    Ok(output)
}

pub(crate) fn validate_runs(runs: &[FontSizeRun], chars: usize) -> Result<(), HcdError> {
    let count = runs
        .iter()
        .try_fold(0usize, |total, run| total.checked_add(run.chars));
    if runs.len() > MAX_RUNS
        || count != Some(chars)
        || runs.iter().any(|run| {
            run.chars == 0
                || run.size_pt.is_some_and(|size| {
                    !size.is_finite()
                        || !(1.0..=1638.0).contains(&size)
                        || (size * 2.0).fract() != 0.0
                })
        })
    {
        return Err(HcdError::InvalidPatch("text runs must cover the text once, with positive lengths and half-point sizes from 1 to 1638".into()));
    }
    Ok(())
}

pub(crate) fn normalize(runs: &[FontSizeRun]) -> Vec<FontSizeRun> {
    let mut output: Vec<FontSizeRun> = Vec::new();
    for run in runs {
        if let Some(previous) = output
            .last_mut()
            .filter(|previous| previous.size_pt == run.size_pt)
        {
            previous.chars += run.chars;
        } else {
            output.push(run.clone());
        }
    }
    output
}

pub(crate) fn validate_text_runs(runs: &[FontSizeRun], text: &str) -> Result<(), HcdError> {
    validate_runs(runs, text.chars().count())?;
    let runs = normalize(runs);
    let mut cuts = runs
        .iter()
        .scan(0usize, |offset, run| {
            *offset += run.chars;
            Some(*offset)
        })
        .peekable();
    let mut offset = 0;
    for grapheme in text.graphemes(true) {
        offset += grapheme.chars().count();
        while cuts.peek().is_some_and(|cut| *cut <= offset) {
            if cuts.next() != Some(offset) {
                return Err(HcdError::InvalidPatch(
                    "font-size boundaries cannot split a grapheme cluster".into(),
                ));
            }
        }
    }
    Ok(())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn body(text: &str, runs: &[FontSizeRun]) -> String {
    let mut characters = text.chars();
    let mut output = String::new();
    for run in runs {
        let content: String = characters.by_ref().take(run.chars).collect();
        if let Some(size) = run.size_pt {
            output.push_str(&format!(
                "<span data-hcd-size-run=\"1\" style=\"font-size:{size}pt\">{}</span>",
                escape(&content)
            ));
        } else {
            output.push_str(&escape(&content));
        }
    }
    output
}

pub(crate) fn render(
    span: &TextSpan,
    text: &str,
    runs: &[FontSizeRun],
) -> Result<String, HcdError> {
    validate_text_runs(runs, text)?;
    if span.nested_source_markup {
        return Err(HcdError::Unsupported(
            "text.runs cannot flatten nested source markup".into(),
        ));
    }
    let runs = normalize(runs);
    let mut start = span.html[..span.open_end].trim_end_matches('/').to_string();
    for range in span.owned_attributes.iter().rev() {
        start.replace_range(range.clone(), "");
    }
    start.push_str(&format!(
        " data-hcd-node-hash=\"{}\"",
        hash_bytes(text.as_bytes())
    ));
    if runs.iter().any(|run| run.size_pt.is_some()) {
        start.push_str(&format!(
            " {ATTRIBUTE}=\"{}\"",
            escape(&serde_json::to_string(&runs)?)
        ));
    }
    Ok(format!("{start}>{}</{}>", body(text, &runs), span.name))
}

/// Validates persisted partitions against the sole HTML text body and its
/// visual wrappers before a projection or native exporter consumes them.
pub fn extract_text_run_sizes(html: &str) -> Result<HashMap<String, Vec<FontSizeRun>>, HcdError> {
    if !html.contains(ATTRIBUTE) && !html.contains("data-hcd-size-run") {
        return Ok(HashMap::new());
    }
    let texts = crate::extract_html_text_nodes(html)?;
    let mut output = HashMap::new();
    for (id, span) in spans(html)? {
        if let Some(runs) = &span.runs {
            let text = texts
                .get(&id)
                .ok_or_else(|| HcdError::InvalidBundle("formatted text is absent".into()))?;
            validate_text_runs(runs, text)
                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
            if span.nested_source_markup
                || span.html[span.open_end + 1..span.close_start] != body(text, runs)
            {
                return Err(HcdError::InvalidBundle(
                    "text run metadata and HTML formatting disagree".into(),
                ));
            }
            output.insert(id, runs.clone());
        } else if span.html.contains("data-hcd-size-run") {
            return Err(HcdError::InvalidBundle(
                "font-size wrappers have no canonical metadata".into(),
            ));
        }
    }
    Ok(output)
}

/// A format precondition includes existing partitions and canonical attributes;
/// unlike nodeHash it detects a format-only change with unchanged plaintext.
pub fn text_format_hashes(html: &str) -> Result<HashMap<String, String>, HcdError> {
    Ok(spans(html)?
        .into_iter()
        .map(|(id, span)| (id, hash_bytes(span.html.as_bytes())))
        .collect())
}

pub(crate) fn splice_runs(
    runs: &[FontSizeRun],
    edits: &[(usize, usize, usize)],
) -> Vec<FontSizeRun> {
    // Callers already bounded text and validated non-overlapping scalar edits.
    let mut sizes: Vec<Option<f32>> = runs
        .iter()
        .flat_map(|run| std::iter::repeat_n(run.size_pt, run.chars))
        .collect();
    let mut edits = edits.to_vec();
    edits.sort_by_key(|edit| edit.0);
    for (start, delete, insert) in edits.into_iter().rev() {
        let inherited = sizes.get(start).or_else(|| sizes.last()).copied().flatten();
        sizes.splice(
            start..start + delete,
            std::iter::repeat_n(inherited, insert),
        );
    }
    normalize(
        &sizes
            .into_iter()
            .map(|size_pt| FontSizeRun { chars: 1, size_pt })
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_size_spans_keep_all_unicode_text_and_original_attributes() {
        let text = "A中😀 B";
        let html = format!("<p class='named' style='text-indent:24pt'><span style='letter-spacing:2pt'><span data-hcd-id='run' title='a > b' xml:lang='zh-CN' data-hcd-node-hash='{}'>{text}</span></span></p>", hash_bytes(text.as_bytes()));
        let span = spans(&html).unwrap().remove("run").unwrap();
        let runs = vec![
            FontSizeRun {
                chars: 1,
                size_pt: None,
            },
            FontSizeRun {
                chars: 2,
                size_pt: Some(28.5),
            },
            FontSizeRun {
                chars: 2,
                size_pt: None,
            },
        ];
        let mut changed = html.clone();
        changed.replace_range(span.range.clone(), &render(&span, text, &runs).unwrap());
        assert_eq!(
            crate::extract_html_text_nodes(&changed).unwrap()["run"],
            text
        );
        assert!(changed.contains("class='named' style='text-indent:24pt'"));
        assert!(changed.contains("letter-spacing:2pt"));
        assert!(changed.contains("xml:lang='zh-CN'"));
        assert!(changed.contains("title='a > b'"));
        assert_eq!(extract_text_run_sizes(&changed).unwrap()["run"], runs);
        assert_ne!(
            text_format_hashes(&html).unwrap()["run"],
            text_format_hashes(&changed).unwrap()["run"]
        );
        let malformed = changed.replace("font-size:28.5pt", "font-size:12pt");
        assert!(extract_text_run_sizes(&malformed).is_err());
        let next = spans(&changed).unwrap().remove("run").unwrap();
        let reset = render(
            &next,
            text,
            &[FontSizeRun {
                chars: 5,
                size_pt: None,
            }],
        )
        .unwrap();
        assert!(!reset.contains(ATTRIBUTE));
        assert_eq!(crate::extract_html_text_nodes(&reset).unwrap()["run"], text);
    }

    #[test]
    fn splice_sizes_inherit_at_insertion_and_keep_untouched_partitions() {
        let runs = vec![
            FontSizeRun {
                chars: 2,
                size_pt: None,
            },
            FontSizeRun {
                chars: 2,
                size_pt: Some(28.5),
            },
            FontSizeRun {
                chars: 1,
                size_pt: None,
            },
        ];
        assert_eq!(
            splice_runs(&runs, &[(2, 1, 3)]),
            vec![
                FontSizeRun {
                    chars: 2,
                    size_pt: None
                },
                FontSizeRun {
                    chars: 4,
                    size_pt: Some(28.5)
                },
                FontSizeRun {
                    chars: 1,
                    size_pt: None
                }
            ]
        );
        assert!(validate_runs(
            &[FontSizeRun {
                chars: 1,
                size_pt: Some(12.25)
            }],
            1
        )
        .is_err());
        assert!(validate_runs(
            &[
                FontSizeRun {
                    chars: usize::MAX,
                    size_pt: None
                },
                FontSizeRun {
                    chars: 2,
                    size_pt: None
                }
            ],
            1
        )
        .is_err());
        for text in ["A\u{301}", "👩🏽‍💻"] {
            assert!(validate_text_runs(
                &[
                    FontSizeRun {
                        chars: 1,
                        size_pt: None
                    },
                    FontSizeRun {
                        chars: text.chars().count() - 1,
                        size_pt: Some(14.0)
                    }
                ],
                text
            )
            .is_err());
            assert!(validate_text_runs(
                &[FontSizeRun {
                    chars: text.chars().count(),
                    size_pt: Some(14.0)
                }],
                text
            )
            .is_ok());
        }
    }
}
