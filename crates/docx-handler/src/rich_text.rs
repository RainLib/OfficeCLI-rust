//! Typed semantic text insertion. Keeps run formatting out of Markdown and
//! writes breaks/tabs as Word elements rather than whitespace inside w:t.
use crate::dom_types::{WordElementType as Kind, WordNode};
use handler_common::HandlerError;
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct RichFont {
    pub latin: Option<String>,
    pub east_asia: Option<String>,
    pub bidi: Option<String>,
    pub size_pt: Option<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichBorder {
    pub width_pt: f32,
    pub color: String,
    pub style: String,
}

#[derive(Clone, Debug, Default)]
pub struct RichRun {
    pub text: String,
    pub properties: HashMap<String, String>,
    pub font: RichFont,
    pub border: Option<RichBorder>,
    pub hyperlink: Option<String>,
    pub field: Option<RichFieldControl>,
}

/// Typed complex-field boundaries. Cached display runs remain ordinary text;
/// no instruction is evaluated by OfficeCLI. Boundaries may span paragraphs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RichFieldControl {
    Begin(String),
    End,
}

#[derive(Clone, Debug, Default)]
pub struct RichParagraph {
    pub properties: HashMap<String, String>,
    pub runs: Vec<RichRun>,
    pub list_ownership: Option<oxml::semantic_lists::ListParagraph>,
}

#[derive(Clone, Debug)]
pub enum RichBlock {
    Paragraph(RichParagraph),
    Table(Vec<Vec<RichParagraph>>),
    PageBreak,
}

pub(crate) fn build_blocks(
    blocks: &[RichBlock],
    hyperlink: &mut impl FnMut(&str) -> Result<String, HandlerError>,
) -> Result<Vec<WordNode>, HandlerError> {
    blocks
        .iter()
        .map(|block| match block {
            RichBlock::Paragraph(content) => paragraph(content, hyperlink),
            RichBlock::Table(rows) => {
                let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
                if rows.len().saturating_mul(columns) > 1_000_000 {
                    return Err(HandlerError::InvalidArgument(
                        "rich table exceeds cell limit".into(),
                    ));
                }
                let mut table = WordNode::new(Kind::Table);
                for row in rows {
                    let mut node = WordNode::new(Kind::TableRow);
                    for column in 0..columns {
                        let empty = RichParagraph::default();
                        node.children
                            .push(WordNode::new(Kind::TableCell).with_children(vec![paragraph(
                                row.get(column).unwrap_or(&empty),
                                hyperlink,
                            )?]));
                    }
                    table.children.push(node);
                }
                Ok(table)
            }
            RichBlock::PageBreak => {
                Ok(WordNode::new(Kind::Paragraph)
                    .with_children(vec![WordNode::new(Kind::Run).with_children(vec![
                        WordNode::new(Kind::Break).with_attribute("type", "page"),
                    ])]))
            }
        })
        .collect()
}

fn paragraph(
    content: &RichParagraph,
    hyperlink: &mut impl FnMut(&str) -> Result<String, HandlerError>,
) -> Result<WordNode, HandlerError> {
    let mut paragraph =
        WordNode::new(Kind::Paragraph).with_attribute("paraId", crate::helpers::generate_para_id());
    if let Some(ownership) = content.list_ownership {
        paragraph
            .namespace_declarations
            .insert("hcdl".into(), oxml::semantic_lists::NAMESPACE.into());
        paragraph.namespace_declarations.insert(
            "mc".into(),
            "http://schemas.openxmlformats.org/markup-compatibility/2006".into(),
        );
        paragraph
            .attributes
            .insert("hcdl:list".into(), ownership.to_string());
        paragraph
            .attributes
            .insert("mc:Ignorable".into(), "hcdl".into());
        paragraph
            .attributes
            .insert("mc:PreserveAttributes".into(), "hcdl:list".into());
    }
    if let Some(properties) = crate::helpers::build_paragraph_properties(&content.properties) {
        paragraph.children.push(properties);
    }
    if content.properties.values().any(|value| !xml_text(value)) {
        return Err(HandlerError::InvalidArgument(
            "invalid XML in rich paragraph properties".into(),
        ));
    }
    for run in &content.runs {
        if let Some(control) = &run.field {
            if !run.text.is_empty()
                || !run.properties.is_empty()
                || run.hyperlink.is_some()
                || run.border.is_some()
                || run.font.latin.is_some()
                || run.font.east_asia.is_some()
                || run.font.bidi.is_some()
                || run.font.size_pt.is_some()
            {
                return Err(HandlerError::InvalidArgument(
                    "field controls cannot carry text, style or hyperlinks".into(),
                ));
            }
            let field = |kind: &str| {
                WordNode::new(Kind::Run)
                    .with_children(vec![WordNode::new(Kind::Unknown("fldChar".into()))
                        .with_attribute("fldCharType", kind)])
            };
            match control {
                RichFieldControl::Begin(instruction) => {
                    if instruction.trim().is_empty()
                        || instruction.len() > 16384
                        || !xml_text(instruction)
                    {
                        return Err(HandlerError::InvalidArgument(
                            "invalid rich field instruction".into(),
                        ));
                    }
                    let mut begin = field("begin");
                    begin.children[0]
                        .attributes
                        .insert("dirty".into(), "true".into());
                    paragraph.children.push(begin);
                    let instruction_node = WordNode::new(Kind::Unknown("instrText".into()))
                        .with_attribute("xml:space", "preserve")
                        .with_text(instruction);
                    paragraph
                        .children
                        .push(WordNode::new(Kind::Run).with_children(vec![instruction_node]));
                    paragraph.children.push(field("separate"));
                }
                RichFieldControl::End => paragraph.children.push(field("end")),
            }
            continue;
        }
        if !xml_text(&run.text) || run.properties.values().any(|value| !xml_text(value)) {
            return Err(HandlerError::InvalidArgument(
                "invalid XML in rich text".into(),
            ));
        }
        let mut node = WordNode::new(Kind::Run);
        let mut properties = crate::helpers::build_run_properties(&run.properties)
            .unwrap_or_else(|| WordNode::new(Kind::RunProperties));
        if run.font.latin.is_some() || run.font.east_asia.is_some() || run.font.bidi.is_some() {
            properties
                .children
                .retain(|child| child.element_type != Kind::Unknown("rFonts".into()));
            let mut fonts = WordNode::new(Kind::Unknown("rFonts".into()));
            for (attribute, name) in [
                ("ascii", &run.font.latin),
                ("hAnsi", &run.font.latin),
                ("eastAsia", &run.font.east_asia),
                ("cs", &run.font.bidi),
            ] {
                if let Some(name) = name {
                    if name.trim().is_empty()
                        || name.len() > 256
                        || name.chars().any(char::is_control)
                    {
                        return Err(HandlerError::InvalidArgument(
                            "invalid rich font name".into(),
                        ));
                    }
                    fonts.attributes.insert(attribute.into(), name.clone());
                }
            }
            properties.children.push(fonts);
        }
        if let Some(size) = run.font.size_pt {
            if !size.is_finite() || !(1.0..=1638.0).contains(&size) {
                return Err(HandlerError::InvalidArgument(
                    "invalid rich font size".into(),
                ));
            }
            properties.children.retain(|child| !matches!(&child.element_type, Kind::Unknown(name) if name == "sz" || name == "szCs"));
            for tag in ["sz", "szCs"] {
                properties.children.push(
                    WordNode::new(Kind::Unknown(tag.into()))
                        .with_attribute("val", (size * 2.0).round().max(1.0).to_string()),
                );
            }
        }
        if let Some(border) = &run.border {
            let color = border.color.trim_start_matches('#');
            let style = match border.style.as_str() {
                "solid" => "single",
                "dashed" => "dashed",
                "dotted" => "dotted",
                "double" => "double",
                _ => {
                    return Err(HandlerError::InvalidArgument(
                        "invalid rich text border style".into(),
                    ))
                }
            };
            if !border.width_pt.is_finite()
                || border.width_pt <= 0.0
                || border.width_pt > 12.0
                || color.len() != 6
                || !color.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(HandlerError::InvalidArgument(
                    "invalid rich text border".into(),
                ));
            }
            properties.children.push(
                WordNode::new(Kind::Unknown("bdr".into()))
                    .with_attribute("val", style)
                    .with_attribute("sz", (border.width_pt * 8.0).round().max(1.0).to_string())
                    .with_attribute("color", color)
                    .with_attribute("space", "0"),
            );
        }
        if !properties.children.is_empty() {
            node.children.push(properties);
        }
        let mut start = 0;
        for (index, character) in run.text.char_indices() {
            if character == '\n' || character == '\t' {
                if index > start {
                    node.children.push(text(&run.text[start..index]));
                }
                node.children.push(WordNode::new(if character == '\n' {
                    Kind::Break
                } else {
                    Kind::Tab
                }));
                start = index + character.len_utf8();
            }
        }
        if start < run.text.len() {
            node.children.push(text(&run.text[start..]));
        }
        if let Some(target) = &run.hyperlink {
            if !xml_text(target) {
                return Err(HandlerError::InvalidArgument(
                    "invalid XML in rich hyperlink".into(),
                ));
            }
            let relationship = hyperlink(target)?;
            paragraph.children.push(
                WordNode::new(Kind::Hyperlink)
                    .with_attribute("r:id", relationship)
                    .with_children(vec![node]),
            );
        } else {
            paragraph.children.push(node);
        }
    }
    Ok(paragraph)
}

fn text(value: &str) -> WordNode {
    let mut text = WordNode::new(Kind::Text).with_text(value);
    text.preserve_space = true;
    text.attributes
        .insert("xml:space".into(), "preserve".into());
    text
}

fn xml_text(value: &str) -> bool {
    value.chars().all(|character| matches!(character, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}'))
}

#[cfg(test)]
mod field_tests {
    use super::*;
    #[test]
    fn typed_field_controls_keep_cache_runs_and_can_span_paragraphs() {
        let begin = RichRun {
            field: Some(RichFieldControl::Begin(" NUMPAGES \\* MERGEFORMAT ".into())),
            ..Default::default()
        };
        let cache = RichRun {
            text: "12".into(),
            properties: HashMap::from([("bold".into(), "true".into())]),
            ..Default::default()
        };
        let end = RichRun {
            field: Some(RichFieldControl::End),
            ..Default::default()
        };
        let blocks = build_blocks(
            &[
                RichBlock::Paragraph(RichParagraph {
                    runs: vec![begin, cache],
                    ..Default::default()
                }),
                RichBlock::Paragraph(RichParagraph {
                    runs: vec![end],
                    ..Default::default()
                }),
            ],
            &mut |_| panic!("field must not allocate a hyperlink"),
        )
        .unwrap();
        assert_eq!(
            blocks[0].children[0].children[0]
                .attributes
                .get("fldCharType")
                .map(String::as_str),
            Some("begin")
        );
        assert_eq!(
            blocks[0].children[0].children[0]
                .attributes
                .get("dirty")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            blocks[0].children[1].children[0].text_content.as_deref(),
            Some(" NUMPAGES \\* MERGEFORMAT ")
        );
        assert_eq!(
            blocks[0].children[2].children[0]
                .attributes
                .get("fldCharType")
                .map(String::as_str),
            Some("separate")
        );
        assert_eq!(
            blocks[0].children[3]
                .children
                .last()
                .unwrap()
                .text_content
                .as_deref(),
            Some("12")
        );
        assert_eq!(
            blocks[1].children[0].children[0]
                .attributes
                .get("fldCharType")
                .map(String::as_str),
            Some("end")
        );
    }
    #[test]
    fn rich_field_controls_refuse_invalid_instruction_and_mixed_payload() {
        for value in [
            "".to_string(),
            " ".into(),
            "PAGE\u{0}".into(),
            "x".repeat(16385),
        ] {
            let block = RichBlock::Paragraph(RichParagraph {
                runs: vec![RichRun {
                    field: Some(RichFieldControl::Begin(value)),
                    ..Default::default()
                }],
                ..Default::default()
            });
            assert!(build_blocks(&[block], &mut |_| panic!("no hyperlink expected")).is_err());
        }
        for run in [
            RichRun {
                text: "cannot hide this".into(),
                field: Some(RichFieldControl::End),
                ..Default::default()
            },
            RichRun {
                hyperlink: Some("https://example.com".into()),
                field: Some(RichFieldControl::Begin("PAGE".into())),
                ..Default::default()
            },
        ] {
            assert!(build_blocks(
                &[RichBlock::Paragraph(RichParagraph {
                    runs: vec![run],
                    ..Default::default()
                })],
                &mut |_| panic!("no hyperlink expected")
            )
            .is_err());
        }
    }
}
