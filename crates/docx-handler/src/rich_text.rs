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
}

#[derive(Clone, Debug, Default)]
pub struct RichParagraph {
    pub properties: HashMap<String, String>,
    pub runs: Vec<RichRun>,
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
    if let Some(properties) = crate::helpers::build_paragraph_properties(&content.properties) {
        paragraph.children.push(properties);
    }
    if content.properties.values().any(|value| !xml_text(value)) {
        return Err(HandlerError::InvalidArgument(
            "invalid XML in rich paragraph properties".into(),
        ));
    }
    for run in &content.runs {
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
