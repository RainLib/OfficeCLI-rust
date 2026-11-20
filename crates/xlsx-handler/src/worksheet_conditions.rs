//! Native SpreadsheetML conditional rules and differential styles.
use quick_xml::{
    events::{BytesStart, Event},
    Reader, Writer,
};
use roxmltree::{Document, Node};
use std::collections::{BTreeSet, HashSet};
use std::io::{BufRead, Write};

const MAX_GROUP_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConditionColors {
    pub fill: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug)]
pub struct NativeCondition {
    pub reference: String,
    pub kind: String,
    pub operator: Option<String>,
    pub formulas: Vec<String>,
    pub colors: ConditionColors,
    pub stop_if_true: bool,
}

#[derive(Default)]
pub struct SheetConditions {
    pub last_priority: u32,
    pub namespace: String,
    /// Editable source rules, ordered by their native priority.
    pub rules: Vec<(u32, NativeCondition)>,
}

fn prefix(xml: &str, node: Node<'_, '_>) -> String {
    let offset = node.range().start + 1;
    let tag = xml[offset..]
        .split(|ch: char| ch.is_whitespace() || ch == '>' || ch == '/')
        .next()
        .unwrap_or_default();
    tag.rsplit_once(':')
        .map_or(String::new(), |(prefix, _)| format!("{prefix}:"))
}

fn escape(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}

fn main_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|child| is_main_child(node, *child, name))
}

fn is_main_child(parent: Node<'_, '_>, child: Node<'_, '_>, name: &str) -> bool {
    child.is_element()
        && child.tag_name().namespace() == parent.tag_name().namespace()
        && child.tag_name().name() == name
}

fn argb(node: Node<'_, '_>) -> Option<String> {
    if node.attributes().len() != 1 || node.children().any(|child| child.is_element()) {
        return None;
    }
    let color = node.attribute("rgb")?;
    if color.len() == 8 && color.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        Some(format!("#{}", &color[2..]))
    } else {
        None
    }
}

fn simple_colors(node: Node<'_, '_>) -> Option<ConditionColors> {
    let mut colors = ConditionColors::default();
    for style in node.children().filter(Node::is_element) {
        let mut children = style.children().filter(Node::is_element);
        let value = children.next()?;
        if children.next().is_some() || !style.attributes().is_empty() {
            return None;
        }
        match style.tag_name().name() {
            "font" if value.has_tag_name("color") && colors.color.is_none() => {
                colors.color = Some(argb(value)?);
            }
            "fill" if value.has_tag_name("patternFill") && colors.fill.is_none() => {
                if value.attributes().iter().any(|attribute| {
                    attribute.name() != "patternType" || attribute.value() != "solid"
                }) {
                    return None;
                }
                let foreground = main_child(value, "fgColor");
                let background = main_child(value, "bgColor");
                let plain = if value.attribute("patternType") == Some("solid") {
                    foreground.or(background)
                } else {
                    background.or(foreground)
                }?;
                if value.children().filter(Node::is_element).count() > 1 {
                    return None;
                }
                colors.fill = Some(argb(plain)?);
            }
            _ => return None,
        }
    }
    (colors.fill.is_some() || colors.color.is_some()).then_some(colors)
}

pub fn read_differential_colors(styles: &str) -> Result<Vec<Option<ConditionColors>>, String> {
    let doc = Document::parse(styles).map_err(|error| error.to_string())?;
    Ok(
        main_child(doc.root_element(), "dxfs").map_or_else(Vec::new, |container| {
            container
                .children()
                .filter(|child| is_main_child(container, *child, "dxf"))
                .map(simple_colors)
                .collect()
        }),
    )
}

fn next_event<'a, R: BufRead>(
    reader: &mut Reader<R>,
    buffer: &'a mut Vec<u8>,
) -> Result<Event<'a>, String> {
    buffer.clear();
    reader
        .read_event_into(buffer)
        .map_err(|error| error.to_string())
}

/// Preserve the worksheet stream. Only its direct conditionalFormatting
/// children are buffered, including any extension elements in those groups.
fn visit_groups<R: BufRead, W: Write>(
    source: R,
    output: Option<W>,
    additions: &str,
    mut inspect: impl FnMut(&str, &str) -> Result<Option<String>, String>,
) -> Result<(), String> {
    let mut source = Reader::from_reader(source);
    let mut writer = output.map(Writer::new);
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut root = String::new();
    let mut additions = Some(additions);
    loop {
        let mut event = next_event(&mut source, &mut buffer)?;
        if depth == 0 {
            if let Event::Start(start) | Event::Empty(start) = &event {
                let before = String::from_utf8_lossy(start.as_ref());
                root = format!("<{before}>");
                inspect(&root, "")?;
            }
        }
        if depth == 1
            && matches!(&event, Event::Start(start) if start.local_name().as_ref() == b"conditionalFormatting")
        {
            let start = event.into_owned();
            let mut group = Writer::new(Vec::new());
            group
                .write_event(start)
                .map_err(|error| error.to_string())?;
            let mut remaining = 1;
            while remaining != 0 {
                event = next_event(&mut source, &mut buffer)?;
                match event {
                    Event::Start(_) => remaining += 1,
                    Event::End(_) => remaining -= 1,
                    Event::Eof => return Err("worksheet ends inside conditionalFormatting".into()),
                    _ => {}
                }
                group
                    .write_event(event)
                    .map_err(|error| error.to_string())?;
                if group.get_ref().len() > MAX_GROUP_BYTES {
                    return Err("worksheet conditional formatting group exceeds 16 MiB".into());
                }
            }
            let xml = String::from_utf8(group.into_inner()).map_err(|error| error.to_string())?;
            let updated = inspect(&root, &xml)?;
            if let Some(writer) = &mut writer {
                writer
                    .get_mut()
                    .write_all(updated.as_deref().unwrap_or(&xml).as_bytes())
                    .map_err(|error| error.to_string())?;
            }
            continue;
        }
        let is_root_end = depth == 1 && matches!(event, Event::End(_));
        let after_conditions = depth == 1
            && match &event {
                Event::Start(start) | Event::Empty(start) => matches!(
                    start.local_name().as_ref(),
                    b"dataValidations"
                        | b"hyperlinks"
                        | b"printOptions"
                        | b"pageMargins"
                        | b"pageSetup"
                        | b"headerFooter"
                        | b"rowBreaks"
                        | b"colBreaks"
                        | b"customProperties"
                        | b"cellWatches"
                        | b"ignoredErrors"
                        | b"smartTags"
                        | b"drawing"
                        | b"legacyDrawing"
                        | b"legacyDrawingHF"
                        | b"picture"
                        | b"oleObjects"
                        | b"controls"
                        | b"webPublishItems"
                        | b"tableParts"
                        | b"pivotTableParts"
                        | b"extLst"
                ),
                _ => false,
            };
        if is_root_end || after_conditions {
            if let (Some(writer), Some(additions)) = (&mut writer, additions.take()) {
                // A source worksheet may use a prefix. Bind the default
                // namespace inside each generated fragment, independently.
                writer
                    .get_mut()
                    .write_all(additions.as_bytes())
                    .map_err(|error| error.to_string())?;
            }
        }
        match &event {
            Event::Eof => break,
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.checked_sub(1).ok_or("unbalanced worksheet")?,
            _ => {}
        }
        if let Some(writer) = &mut writer {
            writer
                .write_event(event)
                .map_err(|error| error.to_string())?;
        }
    }
    if depth != 0 || additions.is_some_and(|xml| !xml.is_empty()) {
        return Err("no worksheet location for conditional formatting".into());
    }
    Ok(())
}

fn group_xml(root: &str, group: &str) -> Result<String, String> {
    let name = root
        .get(1..)
        .unwrap_or_default()
        .split(|ch: char| ch.is_whitespace() || ch == '>')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or("missing worksheet root element")?;
    Ok(format!("{root}{group}</{name}>"))
}

pub fn read_sheet_conditions(
    input: impl BufRead,
    styles: &[Option<ConditionColors>],
) -> Result<SheetConditions, String> {
    let mut data = SheetConditions::default();
    let mut seen = HashSet::new();
    let mut duplicate = HashSet::new();
    visit_groups(input, None::<std::io::Sink>, "", |root, group| {
        let xml = group_xml(root, group)?;
        let doc = Document::parse(&xml).map_err(|error| error.to_string())?;
        if group.is_empty() {
            data.namespace = doc
                .root_element()
                .tag_name()
                .namespace()
                .unwrap_or_default()
                .to_owned();
            return Ok(None);
        }
        let Some(container) = main_child(doc.root_element(), "conditionalFormatting") else {
            return Ok(None);
        };
        let reference = container.attribute("sqref").unwrap_or_default();
        for rule in container
            .children()
            .filter(|rule| is_main_child(container, *rule, "cfRule"))
        {
            let Some(priority) = rule
                .attribute("priority")
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            data.last_priority = data.last_priority.max(priority);
            if !seen.insert(priority) {
                duplicate.insert(priority);
                continue;
            }
            let inline_style = main_child(rule, "dxf");
            let dxf_index = rule.attribute("dxfId");
            if priority == 0
                || reference.split_whitespace().count() != 1
                || container.attributes().len() != 1
                || inline_style.is_some() && dxf_index.is_some()
                || !rule.attributes().iter().all(|attribute| {
                    matches!(
                        attribute.name(),
                        "type" | "operator" | "priority" | "dxfId" | "stopIfTrue"
                    )
                })
                || rule.attribute("type") != Some("cellIs")
                || !rule.children().filter(Node::is_element).all(|child| {
                    is_main_child(rule, child, "formula") || Some(child) == inline_style
                })
            {
                continue;
            }
            // Previous CLI versions wrote the differential style within cfRule.
            // Accept the simple single-priority form so an edit can normalize it.
            let colors = if let Some(style) = inline_style {
                simple_colors(style)
            } else {
                dxf_index
                    .and_then(|value| value.parse::<usize>().ok())
                    .and_then(|index| styles.get(index))
                    .cloned()
                    .flatten()
            };
            let Some(colors) = colors else {
                continue;
            };
            if data.rules.len() >= 128 {
                continue;
            }
            data.rules.push((
                priority,
                NativeCondition {
                    reference: reference.trim().into(),
                    kind: "cellIs".into(),
                    operator: rule.attribute("operator").map(str::to_owned),
                    formulas: rule
                        .children()
                        .filter(|child| is_main_child(rule, *child, "formula"))
                        .map(|node| node.text().unwrap_or_default().trim().to_owned())
                        .collect(),
                    colors,
                    stop_if_true: matches!(rule.attribute("stopIfTrue"), Some("1" | "true")),
                },
            ));
        }
        Ok(None)
    })?;
    data.rules
        .retain(|(priority, _)| !duplicate.contains(priority));
    data.rules.sort_unstable_by_key(|(priority, _)| *priority);
    Ok(data)
}

/// Remove the named source rules and append their replacements using the
/// original priorities. An unrelated rule in the same group stays in place.
pub fn write_sheet_conditions(
    input: impl BufRead,
    output: impl Write,
    removed: &BTreeSet<u32>,
    additions: &str,
) -> Result<(), String> {
    visit_groups(input, Some(output), additions, |root, group| {
        if group.is_empty() || removed.is_empty() {
            return Ok(None);
        }
        let xml = group_xml(root, group)?;
        let doc = Document::parse(&xml).map_err(|error| error.to_string())?;
        let Some(container) = main_child(doc.root_element(), "conditionalFormatting") else {
            return Ok(None);
        };
        let nodes: Vec<_> = container.children().filter(Node::is_element).collect();
        let replacements: Vec<_> = nodes
            .iter()
            .filter(|node| {
                is_main_child(container, **node, "cfRule")
                    && node
                        .attribute("priority")
                        .and_then(|value| value.parse().ok())
                        .is_some_and(|priority| removed.contains(&priority))
            })
            .map(Node::range)
            .collect();
        if replacements.is_empty() {
            return Ok(None);
        }
        if replacements.len() == nodes.len() {
            return Ok(Some(String::new()));
        }
        let mut result = group.to_owned();
        for range in replacements.into_iter().rev() {
            result.replace_range(range.start - root.len()..range.end - root.len(), "");
        }
        Ok(Some(result))
    })
}

fn append_differential_style(
    styles: &mut String,
    colors: &ConditionColors,
) -> Result<usize, String> {
    let doc = Document::parse(styles).map_err(|error| error.to_string())?;
    let root = doc.root_element();
    if root.tag_name().name() != "styleSheet" {
        return Err("invalid XLSX styleSheet".into());
    }
    let (prefix, existing) = if let Some(dxfs) = main_child(root, "dxfs") {
        (prefix(styles, dxfs), Some(dxfs))
    } else {
        (prefix(styles, root), None)
    };
    let p = &prefix;
    let rgb = |value: &str| {
        let value = value.trim_start_matches('#');
        if value.as_bytes().iter().all(u8::is_ascii_hexdigit) && matches!(value.len(), 6 | 8) {
            Ok(if value.len() == 6 {
                format!("FF{value}")
            } else {
                value.to_owned()
            })
        } else {
            Err("conditional style colors must be RGB or ARGB")
        }
    };
    let mut dxf = format!("<{p}dxf>");
    if let Some(color) = &colors.color {
        let color = rgb(color)?;
        dxf.push_str(&format!(r#"<{p}font><{p}color rgb="{color}"/></{p}font>"#));
    }
    if let Some(fill) = &colors.fill {
        let fill = rgb(fill)?;
        dxf.push_str(&format!(
            r#"<{p}fill><{p}patternFill><{p}bgColor rgb="{fill}"/></{p}patternFill></{p}fill>"#
        ));
    }
    dxf.push_str(&format!("</{p}dxf>"));
    if let Some(dxfs) = existing {
        let count = dxfs
            .children()
            .filter(|child| is_main_child(dxfs, *child, "dxf"))
            .count();
        let range = dxfs.range();
        let original = &styles[range.clone()];
        let mut reader = Reader::from_str(original);
        let event = reader.read_event().map_err(|error| error.to_string())?;
        let source_tag = match &event {
            Event::Start(start) | Event::Empty(start) => start,
            _ => return Err("invalid differential style index".into()),
        };
        let mut tag = BytesStart::new(format!("{p}dxfs"));
        for attribute in source_tag.attributes() {
            let attribute = attribute.map_err(|error| error.to_string())?;
            if attribute.key.as_ref() != b"count" {
                tag.push_attribute(attribute);
            }
        }
        let total = count + 1;
        let total = total.to_string();
        tag.push_attribute(("count", total.as_str()));
        let mut writer = Writer::new(Vec::new());
        writer
            .write_event(Event::Start(tag))
            .map_err(|error| error.to_string())?;
        let tag = String::from_utf8(writer.into_inner()).map_err(|error| error.to_string())?;
        let updated = if matches!(event, Event::Empty(_)) {
            format!("{tag}{dxf}</{p}dxfs>")
        } else {
            let close = original
                .rfind("</")
                .ok_or("invalid differential style close tag")?;
            format!(
                "{tag}{}{dxf}{}",
                &original[reader.buffer_position() as usize..close],
                &original[close..]
            )
        };
        styles.replace_range(range, &updated);
        return Ok(count);
    }
    let position = root
        .children()
        .find(|child| {
            child.is_element()
                && matches!(child.tag_name().name(), "tableStyles" | "colors" | "extLst")
        })
        .map(|child| child.range().start)
        .or_else(|| {
            styles[root.range()]
                .rfind("</")
                .map(|offset| root.range().start + offset)
        })
        .ok_or("missing styleSheet close tag")?;
    styles.insert_str(position, &format!("<{p}dxfs count=\"1\">{dxf}</{p}dxfs>"));
    Ok(0)
}

pub fn create_condition_xml(
    styles: &mut String,
    kind: &NativeCondition,
    priority: u32,
    namespace: &str,
) -> Result<String, String> {
    let dxf = append_differential_style(styles, &kind.colors)?;
    let formula: String = kind
        .formulas
        .iter()
        .map(|value| format!("<formula>{}</formula>", escape(value)))
        .collect();
    let operator = kind.operator.as_ref().map_or(String::new(), |operator| {
        format!(r#" operator="{}""#, escape(operator))
    });
    let stop = if kind.stop_if_true {
        r#" stopIfTrue="1""#
    } else {
        ""
    };
    Ok(format!(
        r#"<conditionalFormatting xmlns="{}" sqref="{}"><cfRule type="{}"{operator} dxfId="{dxf}" priority="{priority}"{stop}>{formula}</cfRule></conditionalFormatting>"#,
        escape(namespace),
        escape(&kind.reference),
        escape(&kind.kind),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_one_native_rule_and_preserves_the_other_rule_and_style() {
        let ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        let other = r#"<s:cfRule type="colorScale" priority="3"><s:colorScale/></s:cfRule>"#;
        let source = format!(
            r#"<s:worksheet xmlns:s="{ns}"><s:sheetData/><s:conditionalFormatting sqref="B2:B5"><s:cfRule type="cellIs" priority="1" operator="equal" dxfId="0"><s:formula>24</s:formula></s:cfRule>{other}</s:conditionalFormatting><s:pageMargins left="1"/></s:worksheet>"#
        );
        let mut styles = format!(
            r#"<s:styleSheet xmlns:s="{ns}"><s:dxfs count="1"><s:dxf><s:fill><s:patternFill><s:bgColor rgb="FFF2C6CC"/></s:patternFill></s:fill></s:dxf></s:dxfs><s:tableStyles/></s:styleSheet>"#
        );
        let colors = read_differential_colors(&styles).unwrap();
        let parsed = read_sheet_conditions(source.as_bytes(), &colors).unwrap();
        assert_eq!(parsed.last_priority, 3);
        assert_eq!(parsed.rules.len(), 1);
        let (priority, mut rule) = parsed.rules.into_iter().next().unwrap();
        rule.reference = "B2:B6".into();
        rule.formulas = vec!["42".into()];
        rule.colors.fill = Some("#acd8bd".into());
        let addition =
            create_condition_xml(&mut styles, &rule, priority, &parsed.namespace).unwrap();
        let mut output = Vec::new();
        write_sheet_conditions(
            source.as_bytes(),
            &mut output,
            &BTreeSet::from([priority]),
            &addition,
        )
        .unwrap();
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains(other));
        assert!(output.find("B2:B6").unwrap() < output.find("<s:pageMargins").unwrap());
        let colors = read_differential_colors(&styles).unwrap();
        assert_eq!(colors[0].as_ref().unwrap().fill.as_deref(), Some("#F2C6CC"));
        let read = read_sheet_conditions(output.as_bytes(), &colors).unwrap();
        assert_eq!(read.rules.len(), 1);
        assert_eq!(read.rules[0].1.reference, "B2:B6");
        assert_eq!(read.rules[0].1.formulas, ["42"]);
        assert_eq!(read.rules[0].1.colors.fill.as_deref(), Some("#acd8bd"));
    }
}
