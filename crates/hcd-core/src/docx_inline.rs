//! Server-owned rich text inside one stable Word text anchor. Subruns do not
//! create source identities: the original w:t ordinal remains the export key.
use crate::{EditorInline, HcdError};
use quick_xml::{events::Event, Reader};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocxInlineRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

pub fn extract_docx_inline_runs(
    html: &str,
) -> Result<BTreeMap<String, Vec<DocxInlineRun>>, HcdError> {
    if !html.contains("data-hcd-docx-inline=") {
        return Ok(BTreeMap::new());
    }
    let mut reader = Reader::from_str(html);
    reader.config_mut().check_end_names = true;
    let mut current: Option<String> = None;
    let mut active: Option<DocxInlineRun> = None;
    let mut runs: BTreeMap<String, Vec<DocxInlineRun>> = BTreeMap::new();
    loop {
        match reader
            .read_event()
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
        {
            Event::Start(start) => {
                if active.is_some() {
                    return Err(HcdError::InvalidBundle(
                        "nested Word inline content is forbidden".into(),
                    ));
                }
                let attrs: BTreeMap<String, String> = start
                    .attributes()
                    .map(|attr| {
                        let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                        Ok((
                            String::from_utf8_lossy(attr.key.as_ref()).into_owned(),
                            attr.unescape_value()
                                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, HcdError>>()?;
                if attrs.contains_key("data-hcd-node-hash") {
                    current = attrs.get("data-hcd-id").cloned();
                }
                if let Some(marks) = attrs.get("data-hcd-docx-inline") {
                    if start.name().as_ref() != b"em"
                        || current.is_none()
                        || active.is_some()
                        || !matches!(marks.as_str(), "00" | "01" | "10" | "11")
                    {
                        return Err(HcdError::InvalidBundle("invalid Word inline marker".into()));
                    }
                    active = Some(DocxInlineRun {
                        text: String::new(),
                        bold: marks.starts_with('1'),
                        italic: marks.ends_with('1'),
                    });
                }
            }
            Event::Text(text) => {
                if let Some(run) = &mut active {
                    run.text.push_str(
                        &text
                            .unescape()
                            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?,
                    );
                }
            }
            Event::Empty(start) => {
                if start
                    .attributes()
                    .any(|attr| attr.is_ok_and(|attr| attr.key.as_ref() == b"data-hcd-docx-inline"))
                {
                    return Err(HcdError::InvalidBundle(
                        "Word inline markers must have explicit content boundaries".into(),
                    ));
                }
                if active.is_some() {
                    return Err(HcdError::InvalidBundle(
                        "nested Word inline content is forbidden".into(),
                    ));
                }
            }
            Event::End(end) if end.name().as_ref() == b"em" && active.is_some() => {
                let run = active.take().expect("checked active");
                let id = current.clone().ok_or_else(|| {
                    HcdError::InvalidBundle("Word inline marker lost its anchor".into())
                })?;
                runs.entry(id).or_default().push(run);
            }
            Event::End(end) if end.name().as_ref() == b"span" => current = None,
            Event::Eof => break,
            _ => {}
        }
    }
    if active.is_some() {
        return Err(HcdError::InvalidBundle(
            "unclosed Word inline content".into(),
        ));
    }
    let nodes = crate::extract_html_text_nodes(html)?;
    for (id, runs) in &runs {
        let text: String = runs.iter().map(|run| run.text.as_str()).collect();
        if nodes.get(id) != Some(&text) {
            return Err(HcdError::InvalidBundle(
                "Word inline text does not match its source anchor".into(),
            ));
        }
    }
    Ok(runs)
}

pub(crate) fn render_docx_inline_runs(runs: &[DocxInlineRun]) -> String {
    runs.iter()
        .map(|run| {
            format!(
                "<em data-hcd-docx-inline=\"{}{}\" style=\"font-weight:{};font-style:{}\">{}</em>",
                u8::from(run.bold),
                u8::from(run.italic),
                if run.bold { "bold" } else { "normal" },
                if run.italic { "italic" } else { "normal" },
                run.text
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            )
        })
        .collect()
}

pub(crate) fn splice_docx_inline_runs(
    runs: &[DocxInlineRun],
    start: usize,
    delete_count: usize,
    inserted: &str,
) -> Vec<DocxInlineRun> {
    let end = start + delete_count;
    let mut offset = 0usize;
    let mut placed = false;
    runs.iter()
        .map(|run| {
            let chars: Vec<char> = run.text.chars().collect();
            let mut text: String = chars[..start.saturating_sub(offset).min(chars.len())]
                .iter()
                .collect();
            if !placed && start <= offset + chars.len() {
                text.push_str(inserted);
                placed = true;
            }
            text.extend(chars[end.saturating_sub(offset).min(chars.len())..].iter());
            offset += chars.len();
            DocxInlineRun {
                text,
                bold: run.bold,
                italic: run.italic,
            }
        })
        .collect()
}

/// Scalar offsets assign unchanged prefixes/suffixes to their source anchor.
/// Insertions use the adjoining source run. Editable marks come from the new
/// content, while size, colour, language, spacing and paragraph layout stay on
/// the original wrappers. Link changes still require a structural rewrite.
pub(crate) fn distribute_docx_inlines(
    original: &[EditorInline],
    replacement: &[EditorInline],
) -> Option<Vec<(String, Vec<EditorInline>)>> {
    let mut anchors: Vec<(String, String, Option<String>)> = Vec::new();
    for inline in original {
        let id = inline.node_id.as_ref()?;
        if let Some(last) = anchors.last_mut().filter(|last| last.0 == *id) {
            if last.2 != inline.link {
                return None;
            }
            last.1.push_str(&inline.text);
        } else {
            if anchors.iter().any(|anchor| anchor.0 == *id) {
                return None;
            }
            anchors.push((id.clone(), inline.text.clone(), inline.link.clone()));
        }
    }
    if anchors.is_empty() {
        return None;
    }
    let old: Vec<char> = anchors.iter().flat_map(|a| a.1.chars()).collect();
    let new: Vec<char> = replacement.iter().flat_map(|a| a.text.chars()).collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let mut lengths = Vec::new();
    let mut offset = 0usize;
    let mut placed = false;
    for (_, text, _) in &anchors {
        let count = text.chars().count();
        let mut length = prefix.saturating_sub(offset).min(count);
        if !placed && prefix <= offset + count {
            length += new.len() - prefix - suffix;
            placed = true;
        }
        length += count - (old.len() - suffix).saturating_sub(offset).min(count);
        lengths.push(length);
        offset += count;
    }
    let mut result = Vec::new();
    let mut input = replacement.iter();
    let mut next = input.next();
    let mut chars = next.map(|run| run.text.chars()).into_iter().flatten();
    // Walk by spans rather than allocating one marks object per character.
    for ((id, _, link), length) in anchors.into_iter().zip(lengths) {
        let mut remaining = length;
        let mut inlines = Vec::new();
        while remaining > 0 {
            let run = next?;
            let text: String = chars.by_ref().take(remaining).collect();
            if text.is_empty() {
                next = input.next();
                chars = next.map(|run| run.text.chars()).into_iter().flatten();
                continue;
            }
            if run.link != link {
                return None;
            }
            remaining -= text.chars().count();
            inlines.push(EditorInline {
                format: Default::default(),
                text,
                node_id: Some(id.clone()),
                bold: run.bold,
                italic: run.italic,
                link: link.clone(),
            });
        }
        if inlines.is_empty() {
            let before = original
                .iter()
                .find(|run| run.node_id.as_ref() == Some(&id))?;
            inlines.push(EditorInline {
                format: Default::default(),
                text: String::new(),
                node_id: Some(id.clone()),
                bold: before.bold,
                italic: before.italic,
                link,
            });
        }
        result.push((id, inlines));
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_text_splices_use_explicit_scalar_ranges_even_when_characters_repeat() {
        let runs = vec![
            DocxInlineRun {
                text: "甲😀甲".into(),
                bold: true,
                italic: false,
            },
            DocxInlineRun {
                text: "甲甲".into(),
                bold: false,
                italic: true,
            },
        ];
        let edited = splice_docx_inline_runs(&runs, 3, 0, "甲");
        assert_eq!(edited[0].text, "甲😀甲甲");
        assert_eq!(edited[1], runs[1]);
        assert!(edited[0].bold);
        let edited = splice_docx_inline_runs(&edited, 1, 4, "改");
        assert_eq!(edited[0].text, "甲改");
        assert_eq!(edited[1].text, "甲");
        assert!(edited[1].italic);
    }

    #[test]
    fn rich_text_markers_must_account_for_every_character_without_nested_markup() {
        let runs = [DocxInlineRun {
            text: "中文😀<&".into(),
            bold: false,
            italic: true,
        }];
        let html = format!(
            "<p><span data-hcd-id=\"n_test\" data-hcd-node-hash=\"hash\">{}</span></p>",
            render_docx_inline_runs(&runs)
        );
        assert_eq!(extract_docx_inline_runs(&html).unwrap()["n_test"], runs);
        for broken in [
            html.replace("</span>", "lost</span>"),
            html.replace("中文", "<em>中文</em>"),
            html.replace("=\"01\"", "=\"bad\""),
            html.replace("</em>", ""),
        ] {
            assert!(extract_docx_inline_runs(&broken).is_err(), "{broken}");
        }
    }
}
