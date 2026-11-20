//! Insert physically cached report cells without rewriting unrelated rows.
use super::escape_attribute;
use crate::worksheet_pivots::{address, parse_range, range_label};
use hcd_core::{HcdError, PivotCell, WorksheetChartRange};
use roxmltree::{Document, Node};
use std::{collections::BTreeMap, ops::Range};

pub(super) type ReportCells = BTreeMap<u32, BTreeMap<u32, PivotCell>>;
type Edit = (Range<usize>, String);

fn prefix<'a>(source: &'a str, node: Node<'_, '_>) -> &'a str {
    let tail = &source[node.range().start + 1..];
    let name = tail
        .split(|ch: char| ch.is_whitespace() || ch == '/' || ch == '>')
        .next()
        .unwrap_or_default();
    name.rsplit_once(':')
        .map_or("", |(prefix, _)| &name[..prefix.len() + 1])
}

fn close_at(source: &str, node: Node<'_, '_>) -> Option<usize> {
    source[node.range()]
        .rfind("</")
        .map(|offset| node.range().start + offset)
}

fn render_cell(p: &str, row: u32, column: u32, payload: &PivotCell, style: Option<&str>) -> String {
    let reference = address(row, column);
    let style = style.map_or(String::new(), |value| {
        format!(" s=\"{}\"", escape_attribute(value))
    });
    let (kind, value) = match payload {
        PivotCell::Blank => {
            return if style.is_empty() {
                String::new()
            } else {
                format!("<{p}c r=\"{reference}\"{style}/>")
            }
        }
        PivotCell::Text(text) => {
            let text = super::escape_text(text);
            return format!("<{p}c r=\"{reference}\"{style} t=\"inlineStr\"><{p}is><{p}t xml:space=\"preserve\">{text}</{p}t></{p}is></{p}c>");
        }
        PivotCell::Number(value) => ("n", value.clone()),
        PivotCell::Boolean(value) => ("b", if *value { "1".into() } else { "0".into() }),
        PivotCell::Error(value) => ("e", super::escape_text(value)),
    };
    format!("<{p}c r=\"{reference}\"{style} t=\"{kind}\"><{p}v>{value}</{p}v></{p}c>")
}

fn render_row(p: &str, row: u32, values: BTreeMap<u32, PivotCell>) -> String {
    let cells: String = values
        .into_iter()
        .map(|(column, value)| render_cell(p, row, column, &value, None))
        .collect();
    format!("<{p}row r=\"{row}\">{cells}</{p}row>")
}

fn update_row(
    source: &str,
    row: Node<'_, '_>,
    row_number: u32,
    mut values: BTreeMap<u32, PivotCell>,
    clears: &[WorksheetChartRange],
) -> Result<Vec<Edit>, HcdError> {
    let p = prefix(source, row);
    let mut edits = Vec::new();
    let mut children = row.children().filter(Node::is_element);
    let mut rest_at = None;
    let mut next_column = 1;
    for cell in children.by_ref() {
        if !cell.has_tag_name("c") {
            rest_at = Some(cell.range().start);
            break;
        }
        let column = cell
            .attribute("r")
            .and_then(parse_range)
            .map_or(next_column, |range| range.start_column);
        next_column = column.saturating_add(1);
        let start = cell.range().start;
        let mut before = String::new();
        while let Some((col, value)) = values.first_key_value().filter(|(col, _)| **col < column) {
            before.push_str(&render_cell(p, row_number, *col, value, None));
            values.pop_first();
        }
        let replacement = values.remove(&column).or_else(|| {
            clears
                .iter()
                .any(|range| range.contains_cell(row_number, column))
                .then_some(PivotCell::Blank)
        });
        if let Some(value) = replacement {
            before.push_str(&render_cell(
                prefix(source, cell),
                row_number,
                column,
                &value,
                cell.attribute("s"),
            ));
            edits.push((cell.range(), before));
        } else if !before.is_empty() {
            edits.push((start..start, before));
        }
    }
    if !values.is_empty() {
        let cells: String = values
            .into_iter()
            .map(|(column, value)| render_cell(p, row_number, column, &value, None))
            .collect();
        if let Some(at) = rest_at.or_else(|| close_at(source, row)) {
            edits.push((at..at, cells));
        } else {
            let at = row
                .range()
                .end
                .checked_sub(2)
                .ok_or_else(|| HcdError::InvalidBundle("invalid worksheet row".into()))?;
            edits.push((at..row.range().end, format!(">{cells}</{p}row>")));
        }
    }
    Ok(edits)
}

pub(super) fn rewrite(
    source: &str,
    mut values: ReportCells,
    clears: &[WorksheetChartRange],
    outputs: &[WorksheetChartRange],
) -> Result<String, HcdError> {
    let doc =
        Document::parse(source).map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    let root = doc.root_element();
    let sheet_data = root
        .children()
        .find(|node| node.has_tag_name("sheetData"))
        .ok_or_else(|| HcdError::InvalidBundle("worksheet sheetData is missing".into()))?;
    let p = prefix(source, sheet_data);
    let mut edits = Vec::new();
    let mut next_row = 1;
    for row in sheet_data
        .children()
        .filter(|node| node.has_tag_name("row"))
    {
        let number = row
            .attribute("r")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(next_row);
        next_row = number.saturating_add(1);
        let at = row.range().start;
        let mut before = String::new();
        while values
            .first_key_value()
            .is_some_and(|(first, _)| *first < number)
        {
            let (number, cells) = values.pop_first().expect("earlier report row");
            before.push_str(&render_row(p, number, cells));
        }
        if !before.is_empty() {
            edits.push((at..at, before));
        }
        let cells = values.remove(&number);
        if cells.is_some()
            || clears
                .iter()
                .any(|range| (range.start_row..=range.end_row).contains(&number))
        {
            edits.extend(update_row(
                source,
                row,
                number,
                cells.unwrap_or_default(),
                clears,
            )?);
        }
    }
    if !values.is_empty() {
        let rest: String = values
            .into_iter()
            .map(|(row, cells)| render_row(p, row, cells))
            .collect();
        if let Some(at) = close_at(source, sheet_data) {
            edits.push((at..at, rest));
        } else {
            let at = sheet_data.range().end - 2;
            edits.push((
                at..sheet_data.range().end,
                format!(">{rest}</{p}sheetData>"),
            ));
        }
    }
    if !outputs.is_empty() {
        if let Some(dimension) = root.children().find(|node| node.has_tag_name("dimension")) {
            if let Some(bounds) = dimension.attribute("ref").and_then(parse_range) {
                let bounds = outputs.iter().fold(bounds, |mut bounds, output| {
                    bounds.start_row = bounds.start_row.min(output.start_row);
                    bounds.end_row = bounds.end_row.max(output.end_row);
                    bounds.start_column = bounds.start_column.min(output.start_column);
                    bounds.end_column = bounds.end_column.max(output.end_column);
                    bounds
                });
                let p = prefix(source, dimension);
                edits.push((
                    dimension.range(),
                    format!("<{p}dimension ref=\"{}\"/>", range_label(bounds)),
                ));
            }
        }
    }
    let mut result = source.to_owned();
    edits.sort_by_key(|(range, _)| (range.start, range.end));
    for (range, value) in edits.into_iter().rev() {
        result.replace_range(range, &value);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshing_report_replaces_only_its_cells_and_keeps_physical_order() {
        let source = r#"<x:worksheet xmlns:x="urn:sheet"><x:dimension ref="A1:F4"/><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>keep</x:t></x:is></x:c><x:c r="C1" s="4"><x:v>3</x:v></x:c><x:c r="F1"><x:f>2*4</x:f><x:v>8</x:v></x:c></x:row><x:row r="4"><x:c r="F4"><x:v>11</x:v></x:c></x:row></x:sheetData></x:worksheet>"#;
        let new = ReportCells::from([
            (1, BTreeMap::from([(2, PivotCell::Text("1".into()))])),
            (2, BTreeMap::from([(2, PivotCell::Number("12".into()))])),
        ]);
        let old = parse_range("C1").unwrap();
        let output = parse_range("B1:B2").unwrap();
        let result = rewrite(source, new, &[old], &[output]).unwrap();
        assert!(result.contains(r#"<x:c r="B1" t="inlineStr"><x:is><x:t xml:space="preserve">1</x:t></x:is></x:c><x:c r="C1" s="4"/>"#));
        assert!(result.contains(
            r#"<x:row r="2"><x:c r="B2" t="n"><x:v>12</x:v></x:c></x:row><x:row r="4">"#
        ));
        assert!(result.contains(r#"<x:c r="F1"><x:f>2*4</x:f><x:v>8</x:v></x:c>"#));
        assert!(result.contains(r#"<x:c r="A1" t="inlineStr"><x:is><x:t>keep</x:t></x:is></x:c>"#));
    }
}
