use super::{
    attribute, Block, EditorBlockContent, EditorBlockKind, EditorBlockView, EditorInline,
    EditorTextFormat,
};
use crate::{
    extract_html_text_nodes, hash_bytes, stable_node_id, HcdError, HcdManifest, NodeMapEntry,
    SourceAnchor,
};
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_ROWS: usize = 256;
const MAX_COLUMNS: usize = 64;
const LAYOUT_ATTRIBUTE: &str = "data-hcd-word-table-layout";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WordTableAction {
    InsertRow,
    DeleteRow,
    InsertColumn,
    DeleteColumn,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WordTableLayout {
    pub rows: Vec<Option<usize>>,
    pub columns: Vec<Option<usize>>,
}

pub struct WordTableUpdate {
    pub anchor: Option<String>,
    pub block_id: String,
    pub original_rows: usize,
    pub original_columns: usize,
    pub layout: WordTableLayout,
    pub new_cell_text: HashMap<(usize, usize), String>,
    pub filled_empty_cells: HashMap<(usize, usize), String>,
}

/// A direct XML child and its original byte range. Raw slices retain markup
/// outside the part of a table that was explicitly edited.
pub struct WordXmlChild<'a> {
    pub name: String,
    pub raw: &'a str,
    pub opening: &'a str,
    pub content: &'a str,
    pub closing: &'a str,
    pub start: usize,
}

pub fn word_xml_children(fragment: &str) -> Result<Vec<WordXmlChild<'_>>, HcdError> {
    let mut reader = Reader::from_str(fragment);
    let mut result = Vec::new();
    let mut depth = 0usize;
    let mut name = String::new();
    let mut element_start = 0usize;
    let mut opening_end = 0usize;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let end = reader.buffer_position() as usize;
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    name = String::from_utf8_lossy(tag.local_name().as_ref()).into_owned();
                    element_start = start;
                    opening_end = end;
                }
                depth += 1;
            }
            Event::Empty(tag) if depth == 0 => result.push(WordXmlChild {
                name: String::from_utf8_lossy(tag.local_name().as_ref()).into_owned(),
                raw: &fragment[start..end],
                opening: &fragment[start..end],
                content: "",
                closing: "",
                start,
            }),
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("Unbalanced table markup"))?;
                if depth == 0 {
                    result.push(WordXmlChild {
                        name: std::mem::take(&mut name),
                        raw: &fragment[element_start..end],
                        opening: &fragment[element_start..opening_end],
                        content: &fragment[opening_end..start],
                        closing: &fragment[start..end],
                        start: element_start,
                    });
                }
            }
            Event::Eof if depth == 0 => return Ok(result),
            Event::Eof => return Err(invalid("Unclosed table markup")),
            _ => {}
        }
    }
}

fn invalid(message: &str) -> HcdError {
    HcdError::Unsupported(message.into())
}

struct HtmlTable<'a> {
    root: WordXmlChild<'a>,
    rows: Vec<WordXmlChild<'a>>,
    cells: Vec<Vec<WordXmlChild<'a>>>,
    cols: Vec<WordXmlChild<'a>>,
    layout: Option<WordTableLayout>,
}

fn parse(html: &str) -> Result<HtmlTable<'_>, HcdError> {
    let mut roots = word_xml_children(html)?;
    if roots.len() != 1
        || roots[0].name != "table"
        || html.matches("<table").count() != 1
        || html.contains("data-hcd-continuation=\"true\"")
        || html.contains("rowspan=")
        || html.contains("colspan=")
        || html.contains("data-hcd-v-merge")
    {
        return Err(invalid(
            "Row and column edits require one rectangular, unmerged Word table",
        ));
    }
    let root = roots.remove(0);
    let mut reader = Reader::from_str(root.opening);
    let Event::Start(tag) = reader
        .read_event()
        .map_err(|_| invalid("Invalid Word table opening"))?
    else {
        return Err(invalid("Invalid Word table opening"));
    };
    let layout = attribute(&tag, &reader, LAYOUT_ATTRIBUTE)?
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    let children = word_xml_children(root.content)?;
    if children
        .iter()
        .any(|node| !matches!(node.name.as_str(), "tbody" | "colgroup"))
    {
        return Err(invalid("Unsupported Word table layout"));
    }
    let body = children
        .iter()
        .find(|node| node.name == "tbody")
        .ok_or_else(|| invalid("Word table has no body"))?;
    let rows = word_xml_children(body.content)?;
    if rows.is_empty() || rows.len() > MAX_ROWS || rows.iter().any(|row| row.name != "tr") {
        return Err(invalid("Word table row count or structure is unsupported"));
    }
    let cells: Vec<_> = rows
        .iter()
        .map(|row| word_xml_children(row.content))
        .collect::<Result<_, _>>()?;
    let width = cells[0].len();
    if width == 0
        || width > MAX_COLUMNS
        || cells.iter().any(|row| {
            row.len() != width
                || row
                    .iter()
                    .any(|cell| !matches!(cell.name.as_str(), "td" | "th"))
        })
    {
        return Err(invalid("Word table columns must form a rectangular grid"));
    }
    let cols = children
        .iter()
        .find(|node| node.name == "colgroup")
        .map(|node| word_xml_children(node.content))
        .transpose()?
        .unwrap_or_default();
    if !cols.is_empty()
        && (cols.len() != width
            || cols
                .iter()
                .any(|col| col.name != "col" || col.opening.contains("span=")))
    {
        return Err(invalid("Word table column widths are ambiguous"));
    }
    Ok(HtmlTable {
        root,
        rows,
        cells,
        cols,
        layout,
    })
}

pub(super) fn can_edit(block: &Block) -> bool {
    block.region == "body"
        && block.entries.iter().all(|entry| {
            entry.source.node_kind == "text" && entry.source.part == "word/document.xml"
        })
        && (block.entries.is_empty() || block.entries.iter().any(|entry| entry.source.editable))
        && parse(&block.html).is_ok()
}

fn blank_paragraph_offset(cell: &WordXmlChild<'_>) -> Option<usize> {
    let children = word_xml_children(cell.content).ok()?;
    let [paragraph] = children.as_slice() else {
        return None;
    };
    (paragraph.name == "p"
        && paragraph.closing == "</p>"
        && paragraph.content.is_empty()
        && paragraph.opening.contains(" hcd-empty-paragraph"))
    .then_some(cell.opening.len() + paragraph.start + paragraph.opening.len())
}

pub(super) fn empty_cells(block: &Block) -> Vec<[usize; 2]> {
    let Ok(table) = parse(&block.html) else {
        return Vec::new();
    };
    table
        .cells
        .iter()
        .enumerate()
        .flat_map(|(row, cells)| {
            cells.iter().enumerate().filter_map(move |(column, cell)| {
                blank_paragraph_offset(cell).map(|_| [row, column])
            })
        })
        .collect()
}

struct CellAnchors<'a> {
    manifest: &'a HcdManifest,
    patch_id: &'a str,
    operation: usize,
    count: u64,
}

impl<'a> CellAnchors<'a> {
    fn new(manifest: &'a HcdManifest, patch_id: &'a str, operation: usize) -> Self {
        Self {
            manifest,
            patch_id,
            operation,
            count: 0,
        }
    }

    fn add(&mut self, block: &mut Block) -> String {
        self.count += 1;
        let id = stable_node_id(&[
            &self.manifest.document_id,
            self.patch_id,
            &self.operation.to_string(),
            &self.count.to_string(),
            "word-table",
        ]);
        let hash = hash_bytes(b"");
        let html = cell_span(&id, "");
        block.entries.push(NodeMapEntry {
            node_id: id.clone(),
            node_hash: hash,
            source: SourceAnchor {
                part: "word/document.xml".into(),
                created_in_hcd: true,
                text_ordinal: (self.manifest.revision + 1) * 1_000_000_000
                    + self.operation as u64 * 100_000
                    + self.count,
                source_cell_ref: None,
                paragraph_id: None,
                text_id: None,
                node_kind: "text".into(),
                editable: true,
            },
        });
        block.content.inlines.push(EditorInline {
            text: String::new(),
            node_id: Some(id),
            bold: false,
            italic: false,
            link: None,
            format: EditorTextFormat::default(),
        });
        html
    }
}

fn cell_span(id: &str, text: &str) -> String {
    format!(
        "<span data-hcd-id=\"{id}\" data-hcd-node-hash=\"{}\">{}</span>",
        hash_bytes(text.as_bytes()),
        crate::patch::escape_text(text)
    )
}

pub(super) fn insert(
    manifest: &HcdManifest,
    patch_id: &str,
    operation: usize,
    rows: usize,
    columns: usize,
) -> Result<Block, HcdError> {
    if !(1..=MAX_ROWS).contains(&rows)
        || !(1..=MAX_COLUMNS).contains(&columns)
        || rows * columns > 1024
    {
        return Err(invalid(
            "A new Word table must have 1–256 rows, 1–64 columns, and at most 1024 cells",
        ));
    }
    let id = stable_node_id(&[
        &manifest.document_id,
        patch_id,
        &operation.to_string(),
        "new-word-table",
    ]);
    let mut block = Block {
        html: String::new(),
        id: id.clone(),
        region: "body".into(),
        read_only: true,
        format_edited: false,
        entries: Vec::new(),
        content: EditorBlockContent {
            kind: EditorBlockKind::Opaque,
            level: None,
            alignment: None,
            inlines: Vec::new(),
        },
    };
    let mut html = format!(
        "<table class=\"hcd-table\" data-hcd-id=\"{id}\" style=\"width:100%;table-layout:fixed\"><tbody>"
    );
    let mut anchors = CellAnchors::new(manifest, patch_id, operation);
    for _ in 0..rows {
        html.push_str("<tr>");
        for _ in 0..columns {
            append_cell(&mut html, &anchors.add(&mut block));
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    block.html = html;
    Ok(block)
}

fn append_cell(html: &mut String, span: &str) {
    html.push_str("<td><p class=\"hcd-paragraph\">");
    html.push_str(span);
    html.push_str("</p></td>");
}

pub(super) fn activate_cell(
    original: &Block,
    manifest: &HcdManifest,
    patch_id: &str,
    operation: usize,
    row: usize,
    column: usize,
) -> Result<Block, HcdError> {
    let table = parse(&original.html)?;
    let cell = table
        .cells
        .get(row)
        .and_then(|cells| cells.get(column))
        .ok_or_else(|| invalid("Word table cell is out of bounds"))?;
    let offset = blank_paragraph_offset(cell)
        .ok_or_else(|| invalid("Word table cell is not an empty paragraph"))?;
    let offset = cell.raw.as_ptr() as usize - original.html.as_ptr() as usize + offset;
    let mut updated = original.clone();
    let span = CellAnchors::new(manifest, patch_id, operation).add(&mut updated);
    updated.html.insert_str(offset, &span);
    if table.layout.is_none() {
        let layout = WordTableLayout {
            rows: (0..table.rows.len()).map(Some).collect(),
            columns: (0..table.cells[0].len()).map(Some).collect(),
        };
        updated
            .html
            .insert_str(table.root.opening.len() - 1, &layout_attribute(&layout)?);
    }
    Ok(updated)
}

fn layout_attribute(layout: &WordTableLayout) -> Result<String, HcdError> {
    Ok(format!(
        " {LAYOUT_ATTRIBUTE}=\"{}\"",
        super::escape_html(&serde_json::to_string(layout)?)
    ))
}

pub(super) fn edit(
    original: &Block,
    manifest: &HcdManifest,
    patch_id: &str,
    operation: usize,
    action: WordTableAction,
    index: usize,
) -> Result<Block, HcdError> {
    let table = parse(&original.html)?;
    let height = table.rows.len();
    let width = table.cells[0].len();
    let mut layout = table.layout.unwrap_or_else(|| WordTableLayout {
        rows: (0..height).map(Some).collect(),
        columns: (0..width).map(Some).collect(),
    });
    if layout.rows.len() != height || layout.columns.len() != width {
        return Err(invalid("Word table origin dimensions are inconsistent"));
    }
    let mut rows: Vec<_> = (0..height).map(Some).collect();
    let mut columns: Vec<_> = (0..width).map(Some).collect();
    let (order, origins, insert, limit) = match action {
        WordTableAction::InsertRow => (&mut rows, &mut layout.rows, true, MAX_ROWS),
        WordTableAction::DeleteRow => (&mut rows, &mut layout.rows, false, MAX_ROWS),
        WordTableAction::InsertColumn => (&mut columns, &mut layout.columns, true, MAX_COLUMNS),
        WordTableAction::DeleteColumn => (&mut columns, &mut layout.columns, false, MAX_COLUMNS),
    };
    if insert {
        if index > order.len() || order.len() == limit {
            return Err(invalid("Word table insertion is outside its size limits"));
        }
        order.insert(index, None);
        origins.insert(index, None);
    } else {
        if index >= order.len() || order.len() == 1 {
            return Err(invalid(
                "A Word table must retain at least one row and column",
            ));
        }
        order.remove(index);
        origins.remove(index);
    }
    let mut opening = table.root.opening.to_owned();
    if let Some(start) = opening.find(&format!(" {LAYOUT_ATTRIBUTE}=\"")) {
        let value = start + LAYOUT_ATTRIBUTE.len() + 3;
        let end = opening[value..]
            .find('"')
            .ok_or_else(|| invalid("Invalid Word table layout attribute"))?
            + value
            + 1;
        opening.replace_range(start..end, "");
    }
    opening.insert_str(opening.len() - 1, &layout_attribute(&layout)?);
    let mut html = opening;
    if !table.cols.is_empty() {
        html.push_str("<colgroup>");
        for (index, source) in columns.iter().enumerate() {
            html.push_str(
                table.cols[source.unwrap_or_else(|| index.saturating_sub(1).min(width - 1))].raw,
            );
        }
        html.push_str("</colgroup>");
    }
    let mut updated = original.clone();
    let mut anchors = CellAnchors::new(manifest, patch_id, operation);
    html.push_str("<tbody>");
    for row in &rows {
        html.push_str(row.map_or("<tr>", |r| table.rows[r].opening));
        for column in &columns {
            if let (Some(row), Some(column)) = (row, column) {
                html.push_str(table.cells[*row][*column].raw);
            } else {
                append_cell(&mut html, &anchors.add(&mut updated));
            }
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    let texts = extract_html_text_nodes(&html)?;
    updated
        .entries
        .retain(|entry| texts.contains_key(&entry.node_id));
    updated.content.inlines.retain(|inline| {
        inline
            .node_id
            .as_ref()
            .is_some_and(|id| texts.contains_key(id))
    });
    updated.html = html;
    Ok(updated)
}

pub fn word_table_layout_update(
    before: &EditorBlockView,
    after: &EditorBlockView,
) -> Result<Option<WordTableUpdate>, HcdError> {
    let Some(after_html) = after
        .read_only_html
        .as_deref()
        .filter(|html| html.contains(LAYOUT_ATTRIBUTE))
    else {
        return Ok(None);
    };
    let original = parse(
        before
            .read_only_html
            .as_deref()
            .ok_or_else(|| invalid("Original Word table is missing"))?,
    )?;
    let edited = parse(after_html)?;
    let layout = edited
        .layout
        .ok_or_else(|| invalid("Word table layout mapping is missing"))?;
    let old_rows = original.rows.len();
    let old_cols = original.cells[0].len();
    let valid_origins = |values: &[Option<usize>], length: usize| {
        let mut previous = None;
        values.iter().flatten().all(|value| {
            let valid = *value < length && previous.is_none_or(|last| last < *value);
            previous = Some(*value);
            valid
        })
    };
    if layout.rows.len() != edited.rows.len()
        || layout.columns.len() != edited.cells[0].len()
        || !valid_origins(&layout.rows, old_rows)
        || !valid_origins(&layout.columns, old_cols)
    {
        return Err(invalid("Word table edit has an invalid source mapping"));
    }
    let source_ids: HashSet<_> = before
        .content
        .inlines
        .iter()
        .filter_map(|inline| inline.node_id.as_deref())
        .collect();
    let eligible: HashSet<_> = before
        .editable_text_node_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut new_cell_text = HashMap::new();
    let mut filled_empty_cells = HashMap::new();
    for (r, row) in edited.cells.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let texts = extract_html_text_nodes(cell.raw)?;
            if let (Some(old_row), Some(old_col)) = (layout.rows[r], layout.columns[c]) {
                let old_cell = &original.cells[old_row][old_col];
                let old_texts = extract_html_text_nodes(old_cell.raw)?;
                if old_texts.is_empty() && texts.len() == 1 {
                    let (id, text) = texts.iter().next().expect("one edited text node");
                    let offset = blank_paragraph_offset(old_cell).ok_or_else(|| {
                        invalid("Only empty cell paragraphs may receive a new text run")
                    })?;
                    let mut expected = old_cell.raw.to_owned();
                    expected.insert_str(offset, &cell_span(id, text));
                    if source_ids.contains(id.as_str())
                        || text.contains(['\r', '\n', '\t'])
                        || expected != cell.raw
                    {
                        return Err(invalid(
                            "An empty Word table cell may only receive plain text",
                        ));
                    }
                    if !text.is_empty() {
                        filled_empty_cells.insert((r, c), text.clone());
                    }
                    continue;
                }
                if old_texts.len() != texts.len() {
                    return Err(invalid("The Word table edit changed existing cell anchors"));
                }
                let mut expected = old_cell.raw.to_string();
                for (id, text) in texts {
                    let previous = old_texts.get(&id).ok_or_else(|| {
                        invalid("The Word table edit moved an existing cell anchor")
                    })?;
                    if previous != &text {
                        if !eligible.contains(id.as_str()) {
                            return Err(invalid("The Word table edit changed protected cell text"));
                        }
                        crate::patch::replace_node_text(
                            &mut expected,
                            &id,
                            &text,
                            &hash_bytes(text.as_bytes()),
                        )?;
                    }
                }
                if expected != cell.raw {
                    return Err(invalid("The Word table edit changed existing cell markup"));
                }
            } else {
                let mut values = texts.into_iter();
                let (id, text) = values
                    .next()
                    .ok_or_else(|| invalid("New Word table cell has no text anchor"))?;
                if source_ids.contains(id.as_str())
                    || values.next().is_some()
                    || text.contains(['\r', '\n', '\t'])
                {
                    return Err(invalid("New Word table cells support plain text only"));
                }
                new_cell_text.insert((r, c), text);
            }
        }
    }
    Ok(Some(WordTableUpdate {
        anchor: before.editable_text_node_ids.first().cloned(),
        block_id: before.block_id.clone(),
        original_rows: old_rows,
        original_columns: old_cols,
        layout,
        new_cell_text,
        filled_empty_cells,
    }))
}
