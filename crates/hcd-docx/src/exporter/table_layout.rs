use hcd_core::{stable_node_id, word_xml_children, HcdError, WordTableUpdate, WordXmlChild};
use quick_xml::{events::Event, Reader};
use std::collections::{BTreeMap, HashMap};

fn unsupported(message: &str) -> HcdError {
    HcdError::Unsupported(format!(
        "{message}. Use the editable DOCX rebuild for this revision"
    ))
}

pub(super) fn rewrite(
    xml: &str,
    document_id: &str,
    edits: &[(Option<u64>, WordTableUpdate)],
) -> Result<String, HcdError> {
    let document = word_xml_children(xml)?
        .into_iter()
        .find(|x| x.name == "document")
        .ok_or_else(|| unsupported("Word document root is missing"))?;
    let body = word_xml_children(document.content)?
        .into_iter()
        .find(|x| x.name == "body")
        .ok_or_else(|| unsupported("Word body is missing"))?;
    let body_start = document.start + document.opening.len() + body.start + body.opening.len();
    let tables: Vec<_> = word_xml_children(body.content)?
        .into_iter()
        .filter(|x| x.name == "tbl")
        .collect();
    let by_anchor: HashMap<_, _> = edits
        .iter()
        .filter_map(|(ordinal, plan)| ordinal.map(|ordinal| (ordinal, plan)))
        .collect();
    let by_id: HashMap<_, _> = edits
        .iter()
        .filter(|(ordinal, _)| ordinal.is_none())
        .map(|(_, plan)| (plan.block_id.as_str(), plan))
        .collect();
    let mut replacement = BTreeMap::new();
    let mut reader = Reader::from_str(xml);
    let mut ordinal = 0u64;
    let mut table_depth = 0usize;
    let mut table_ordinal = 0u64;
    loop {
        let start = reader.buffer_position() as usize;
        match reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        {
            Event::Start(tag) if tag.local_name().as_ref() == b"tbl" => {
                if table_depth == 0 && !by_id.is_empty() {
                    let table = tables
                        .iter()
                        .find(|table| body_start + table.start == start)
                        .ok_or_else(|| {
                            unsupported(
                                "An empty Word table has no unambiguous body-table position",
                            )
                        })?;
                    table_ordinal += 1;
                    let id = stable_node_id(&[
                        document_id,
                        "word/document.xml",
                        "table",
                        &table_ordinal.to_string(),
                    ]);
                    if let Some(plan) = by_id.get(id.as_str()) {
                        replacement
                            .insert(start, (start + table.raw.len(), render_table(table, plan)?));
                    }
                }
                table_depth += 1;
            }
            Event::End(tag) if tag.local_name().as_ref() == b"tbl" => {
                table_depth = table_depth.saturating_sub(1);
            }
            Event::Start(tag) | Event::Empty(tag) if tag.local_name().as_ref() == b"t" => {
                ordinal += 1;
                if let Some(plan) = by_anchor.get(&ordinal) {
                    let table = tables
                        .iter()
                        .find(|table| {
                            (body_start + table.start..body_start + table.start + table.raw.len())
                                .contains(&start)
                        })
                        .ok_or_else(|| {
                            unsupported("A changed Word table is not a direct body table")
                        })?;
                    let start = body_start + table.start;
                    if replacement
                        .insert(start, (start + table.raw.len(), render_table(table, plan)?))
                        .is_some()
                    {
                        return Err(unsupported(
                            "Multiple edits map to the same native Word table",
                        ));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if replacement.len() != edits.len() {
        return Err(unsupported(
            "A changed Word table could not be resolved in the source file",
        ));
    }
    let mut output = String::new();
    let mut offset = 0;
    for (start, (end, contents)) in replacement {
        output.push_str(&xml[offset..start]);
        output.push_str(&contents);
        offset = end;
    }
    output.push_str(&xml[offset..]);
    Ok(output)
}

fn render_table(table: &WordXmlChild<'_>, edit: &WordTableUpdate) -> Result<String, HcdError> {
    if !table.opening.starts_with("<w:tbl") {
        return Err(unsupported(
            "This Word table uses a different namespace prefix",
        ));
    }
    let mut reader = Reader::from_str(table.content);
    loop {
        match reader.read_event().map_err(|error| HcdError::InvalidBundle(error.to_string()))? {
            Event::Start(tag) | Event::Empty(tag) if matches!(
                tag.local_name().as_ref(),
                b"bookmarkStart" | b"bookmarkEnd" | b"commentRangeStart" | b"commentRangeEnd"
                | b"commentReference" | b"ins" | b"del" | b"moveFrom" | b"moveTo" | b"sdt"
                | b"permStart" | b"permEnd" | b"fldSimple" | b"fldChar" | b"instrText"
                | b"vMerge" | b"hMerge" | b"gridSpan" | b"tblPrChange" | b"trPrChange" | b"tcPrChange"
            ) => return Err(unsupported("This Word table contains merged cells, protected ranges, fields or tracked changes")),
            Event::Eof => break,
            _ => {}
        }
    }
    let parts = word_xml_children(table.content)?;
    if parts
        .iter()
        .any(|node| !matches!(node.name.as_str(), "tblPr" | "tblGrid" | "tr"))
    {
        return Err(unsupported(
            "The source table contains unsupported row wrappers",
        ));
    }
    let rows: Vec<_> = parts.iter().filter(|node| node.name == "tr").collect();
    let row_parts: Vec<_> = rows
        .iter()
        .map(|row| word_xml_children(row.content))
        .collect::<Result<_, _>>()?;
    if row_parts.iter().any(|row| {
        row.iter()
            .any(|node| !matches!(node.name.as_str(), "trPr" | "tblPrEx" | "tc"))
    }) {
        return Err(unsupported("The source table contains unsupported cells"));
    }
    let cells: Vec<Vec<_>> = row_parts
        .iter()
        .map(|row| row.iter().filter(|node| node.name == "tc").collect())
        .collect();
    if rows.len() != edit.original_rows
        || cells.iter().any(|row| row.len() != edit.original_columns)
    {
        return Err(unsupported(
            "The source table dimensions differ from the editor grid",
        ));
    }
    let mut output = String::from(table.opening);
    for part in parts.iter().filter(|part| part.name != "tr") {
        if part.name != "tblGrid" || part.content.is_empty() {
            output.push_str(part.raw);
            continue;
        }
        let columns = word_xml_children(part.content)?;
        if columns.len() != edit.original_columns
            || columns.iter().any(|column| column.name != "gridCol")
        {
            return Err(unsupported("The source table column grid is ambiguous"));
        }
        output.push_str(part.opening);
        for (index, source) in edit.layout.columns.iter().enumerate() {
            output.push_str(
                columns[source.unwrap_or_else(|| nearest(&edit.layout.columns, index))].raw,
            );
        }
        output.push_str(part.closing);
    }
    for (r, row) in edit.layout.rows.iter().enumerate() {
        output.push_str(row.map_or("<w:tr>", |index| rows[index].opening));
        if let Some(index) = row {
            for part in row_parts[*index].iter().filter(|node| node.name != "tc") {
                output.push_str(part.raw);
            }
        }
        for (c, column) in edit.layout.columns.iter().enumerate() {
            if let (Some(row), Some(column)) = (row, column) {
                let cell = cells[*row][*column];
                if let Some(text) = edit.filled_empty_cells.get(&(r, c)) {
                    output.push_str(&fill_empty_cell(cell, text)?);
                } else {
                    output.push_str(cell.raw);
                }
                continue;
            }
            let template = cells[row.unwrap_or_else(|| nearest(&edit.layout.rows, r))]
                [column.unwrap_or_else(|| nearest(&edit.layout.columns, c))];
            output.push_str("<w:tc>");
            if let Some(props) = word_xml_children(template.content)?
                .into_iter()
                .find(|child| child.name == "tcPr")
            {
                let size = word_xml_children(props.content)?
                    .into_iter()
                    .find(|size| size.name == "tcW");
                if let Some(size) = size {
                    output.push_str(&format!("<w:tcPr>{}</w:tcPr>", size.raw));
                }
            }
            let text = edit
                .new_cell_text
                .get(&(r, c))
                .ok_or_else(|| unsupported("New Word cell text is unavailable"))?;
            if text.is_empty() {
                output.push_str("<w:p/>");
            } else {
                output.push_str(&format!(
                    "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    quick_xml::escape::escape(text)
                ));
            }
            output.push_str("</w:tc>");
        }
        output.push_str(row.map_or("</w:tr>", |index| rows[index].closing));
    }
    output.push_str(table.closing);
    Ok(output)
}

fn fill_empty_cell(cell: &WordXmlChild<'_>, text: &str) -> Result<String, HcdError> {
    let children = word_xml_children(cell.content)?;
    let mut content = children.iter().filter(|child| child.name != "tcPr");
    let paragraph = content
        .next()
        .filter(|child| child.name == "p" && child.opening.starts_with("<w:p"));
    let Some(paragraph) = paragraph.filter(|_| content.next().is_none()) else {
        return Err(unsupported(
            "The original empty cell has a complex paragraph structure",
        ));
    };
    if word_xml_children(paragraph.content)?
        .iter()
        .any(|child| child.name != "pPr")
    {
        return Err(unsupported(
            "The original empty cell has protected or unsupported content",
        ));
    }
    let run = format!(
        "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        quick_xml::escape::escape(text)
    );
    let mut xml = cell.raw.to_string();
    let offset =
        cell.opening.len() + paragraph.start + paragraph.opening.len() + paragraph.content.len();
    if paragraph.closing.is_empty() {
        xml.replace_range(offset - 2..offset, &format!(">{run}</w:p>"));
    } else {
        xml.insert_str(offset, &run);
    }
    Ok(xml)
}

fn nearest(origins: &[Option<usize>], index: usize) -> usize {
    origins[..index]
        .iter()
        .rev()
        .flatten()
        .next()
        .or_else(|| origins[index + 1..].iter().flatten().next())
        .copied()
        .unwrap_or(0)
}
