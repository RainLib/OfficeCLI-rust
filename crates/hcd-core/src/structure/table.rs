//! Bounded, server-owned table structure edits. Existing cell HTML and mapped
//! source runs are kept; clients supply an action, never replacement markup.
use super::*;

const MAX_ROWS: usize = 1000;
const MAX_COLUMNS: usize = 128;
const MAX_CELLS: usize = 10_000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableEditAction {
    InsertRow,
    DeleteRow,
    InsertColumn,
    DeleteColumn,
}

#[derive(Clone)]
struct Element {
    tag: String,
    open: String,
    close: String,
    attrs: BTreeMap<String, String>,
    children: Vec<Xml>,
}
#[derive(Clone)]
enum Xml {
    Element(Element),
    Raw(String),
}
impl Element {
    fn set(&mut self, name: &str, value: Option<String>) {
        if self.attrs.get(name) == value.as_ref() {
            return;
        }
        if let Some(value) = value {
            self.attrs.insert(name.into(), value);
        } else {
            self.attrs.remove(name);
        }
        self.open = format!(
            "<{}{}>",
            self.tag,
            self.attrs
                .iter()
                .map(|(key, value)| format!(" {key}=\"{}\"", escape_html(value)))
                .collect::<String>()
        );
        if self.close.is_empty() {
            self.close = format!("</{}>", self.tag);
        }
    }
    fn span(&self, name: &str) -> Result<usize, HcdError> {
        let value = self
            .attrs
            .get(name)
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|_| invalid("invalid merged cell span"))?
            .unwrap_or(1);
        if value == 0 || value > MAX_ROWS {
            return Err(invalid("merged cell span is out of bounds"));
        }
        Ok(value)
    }
    fn is_cell(&self) -> bool {
        matches!(self.tag.as_str(), "td" | "th")
    }
}
fn invalid(message: &str) -> HcdError {
    HcdError::InvalidPatch(message.into())
}
fn dimensions(rows: usize, columns: usize) -> Result<(), HcdError> {
    if rows == 0
        || columns == 0
        || rows > MAX_ROWS
        || columns > MAX_COLUMNS
        || rows.saturating_mul(columns) > MAX_CELLS
    {
        return Err(invalid(
            "table dimensions exceed 1000 rows, 128 columns or 10000 cells",
        ));
    }
    Ok(())
}
fn parse(html: &str) -> Result<Vec<Xml>, HcdError> {
    let mut reader = Reader::from_str(html);
    let mut root = Vec::new();
    let mut stack: Vec<Element> = vec![];
    let mut count = 0;
    loop {
        let from = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|_| invalid("invalid table HTML"))?;
        let to = reader.buffer_position() as usize;
        let node = match event {
            Event::Start(start) | Event::Empty(start) => {
                count += 1;
                if count > 100_000 || stack.len() > 128 {
                    return Err(invalid("table HTML complexity limit exceeded"));
                }
                let tag = tag_name(start.name().as_ref());
                let mut attrs = BTreeMap::new();
                for attr in start.attributes() {
                    let attr = attr.map_err(|_| invalid("invalid table attribute"))?;
                    attrs.insert(
                        tag_name(attr.key.as_ref()),
                        attr.decode_and_unescape_value(reader.decoder())
                            .map_err(|_| invalid("invalid table attribute"))?
                            .into_owned(),
                    );
                }
                let element = Element {
                    tag,
                    open: html[from..to].into(),
                    close: String::new(),
                    attrs,
                    children: vec![],
                };
                if html[from..to].ends_with("/>") {
                    Some(Xml::Element(element))
                } else {
                    stack.push(element);
                    None
                }
            }
            Event::End(_) => {
                let mut element = stack
                    .pop()
                    .ok_or_else(|| invalid("unbalanced table HTML"))?;
                element.close = html[from..to].into();
                Some(Xml::Element(element))
            }
            Event::Eof => break,
            _ => Some(Xml::Raw(html[from..to].into())),
        };
        if let Some(node) = node {
            if let Some(parent) = stack.last_mut() {
                parent.children.push(node)
            } else {
                root.push(node)
            }
        }
    }
    if !stack.is_empty() {
        return Err(invalid("unclosed table HTML"));
    }
    Ok(root)
}
fn render(nodes: &[Xml]) -> String {
    let mut out = String::new();
    for node in nodes {
        match node {
            Xml::Raw(raw) => out.push_str(raw),
            Xml::Element(element) => {
                out.push_str(&element.open);
                out.push_str(&render(&element.children));
                out.push_str(&element.close);
            }
        }
    }
    out
}
fn element_mut<'a>(nodes: &'a mut [Xml], path: &[usize]) -> &'a mut Element {
    let Xml::Element(element) = &mut nodes[path[0]] else {
        unreachable!("server-owned element path")
    };
    if path.len() == 1 {
        element
    } else {
        element_mut(&mut element.children, &path[1..])
    }
}
fn element<'a>(nodes: &'a [Xml], path: &[usize]) -> &'a Element {
    let Xml::Element(element) = &nodes[path[0]] else {
        unreachable!("server-owned element path")
    };
    if path.len() == 1 {
        element
    } else {
        self::element(&element.children, &path[1..])
    }
}
fn find_table(nodes: &[Xml], wanted: usize) -> Option<Vec<usize>> {
    fn visit(
        nodes: &[Xml],
        wanted: usize,
        count: &mut usize,
        path: &mut Vec<usize>,
    ) -> Option<Vec<usize>> {
        for (index, node) in nodes.iter().enumerate() {
            if let Xml::Element(element) = node {
                path.push(index);
                if element.tag == "table" {
                    if *count == wanted {
                        return Some(path.clone());
                    }
                    *count += 1;
                }
                if let Some(found) = visit(&element.children, wanted, count, path) {
                    return Some(found);
                }
                path.pop();
            }
        }
        None
    }
    visit(nodes, wanted, &mut 0, &mut vec![])
}
fn row_paths(table: &Element) -> Vec<Vec<usize>> {
    let mut rows = vec![];
    for (i, node) in table.children.iter().enumerate() {
        if let Xml::Element(element) = node {
            if element.tag == "tr" {
                rows.push(vec![i])
            } else if matches!(element.tag.as_str(), "tbody" | "thead" | "tfoot") {
                for (j, node) in element.children.iter().enumerate() {
                    if matches!(node,Xml::Element(e) if e.tag=="tr") {
                        rows.push(vec![i, j]);
                    }
                }
            }
        }
    }
    rows
}
#[derive(Clone)]
struct Cell {
    path: Vec<usize>,
    row: usize,
    column: usize,
    rows: usize,
    columns: usize,
}
struct Grid {
    rows: Vec<Vec<usize>>,
    cells: Vec<Cell>,
    width: usize,
}
fn grid(table: &Element) -> Result<Grid, HcdError> {
    let rows = row_paths(table);
    if rows.is_empty() || rows.len() > MAX_ROWS {
        return Err(invalid("table has no rows or is too large"));
    }
    let mut occupied = HashSet::new();
    let mut cells = vec![];
    let mut width = 0;
    for (r, path) in rows.iter().enumerate() {
        let row = element(&table.children, path);
        let mut c = 0;
        for (index, node) in row.children.iter().enumerate() {
            let Xml::Element(cell) = node else { continue };
            if !cell.is_cell() {
                continue;
            }
            while occupied.contains(&(r, c)) {
                c += 1;
            }
            let rs = cell.span("rowspan")?;
            let cs = cell.span("colspan")?;
            if r + rs > rows.len() || c + cs > MAX_COLUMNS {
                return Err(invalid("table merge exceeds its grid"));
            }
            for y in r..r + rs {
                for x in c..c + cs {
                    if !occupied.insert((y, x)) {
                        return Err(invalid("overlapping table merges"));
                    }
                }
            }
            let mut path = path.clone();
            path.push(index);
            cells.push(Cell {
                path,
                row: r,
                column: c,
                rows: rs,
                columns: cs,
            });
            c += cs;
            width = width.max(c);
        }
    }
    dimensions(rows.len(), width)?;
    if (0..rows.len()).any(|r| (0..width).any(|c| !occupied.contains(&(r, c)))) {
        return Err(invalid("table contains incomplete grid rows"));
    }
    Ok(Grid { rows, cells, width })
}
struct Builder<'a> {
    manifest: &'a HcdManifest,
    patch: &'a str,
    operation: usize,
    number: usize,
    entries: Vec<NodeMapEntry>,
}
impl Builder<'_> {
    fn cell(&mut self, template: Option<&Element>) -> Result<Xml, HcdError> {
        self.number += 1;
        let id = stable_node_id(&[
            &self.manifest.document_id,
            self.patch,
            &self.operation.to_string(),
            "table-text",
            &self.number.to_string(),
        ]);
        let paragraph = stable_node_id(&[&id, "paragraph"]);
        let hash = hash_bytes(b"");
        let mut attrs = template.map(|cell| cell.attrs.clone()).unwrap_or_else(|| {
            BTreeMap::from([(
                "style".into(),
                "border-top:1px solid #d5dbe5;border-right:1px solid #d5dbe5;border-bottom:1px solid #d5dbe5;border-left:1px solid #d5dbe5;padding-top:8px;padding-right:12px;padding-bottom:8px;padding-left:12px;vertical-align:top;min-width:48px"
                    .into(),
            )])
        });
        attrs.retain(|key, _| {
            !matches!(
                key.as_str(),
                "rowspan"
                    | "colspan"
                    | "data-hcd-id"
                    | "id"
                    | "data-hcd-v-merge"
                    | "data-hcd-editable"
            )
        });
        let tag = template.map(|cell| cell.tag.as_str()).unwrap_or("td");
        let html=format!("<{tag}{}><p class=\"hcd-paragraph hcd-empty-paragraph\" data-hcd-id=\"{paragraph}\" style=\"min-height:1em;margin:0\"><span data-hcd-id=\"{id}\" data-hcd-node-hash=\"{hash}\"></span></p></{tag}>",attrs.iter().map(|(key,value)|format!(" {key}=\"{}\"",escape_html(value))).collect::<String>());
        self.entries.push(NodeMapEntry {
            node_id: id.clone(),
            node_hash: hash,
            source: SourceAnchor {
                source_cell_ref: None,
                created_in_hcd: false,
                part: match self.manifest.source.format.as_str() {
                    "docx" => "word/document.xml",
                    "md" => "markdown/document",
                    _ => "html/document",
                }
                .into(),
                text_ordinal: self.manifest.revision * 1_000_000
                    + self.operation as u64 * 10_000
                    + self.number as u64,
                paragraph_id: Some(paragraph),
                text_id: Some(format!("editor:{}", &hash_bytes(id.as_bytes())[..32])),
                node_kind: "editor-text".into(),
                editable: true,
            },
        });
        Ok(parse(&html)?.remove(0))
    }
}
fn rebuild(original: &Block, html: String, added: Vec<NodeMapEntry>) -> Result<Block, HcdError> {
    let texts = extract_html_text_nodes(&html)?;
    let marks = extract_marks(&html)?;
    let mut updated = original.clone();
    updated.html = html;
    updated.entries.extend(added);
    updated
        .entries
        .retain(|entry| texts.contains_key(&entry.node_id));
    updated.content.inlines = updated
        .entries
        .iter()
        .filter_map(|entry| {
            texts.get(&entry.node_id).map(|text| {
                let mark = marks.get(&entry.node_id);
                EditorInline {
                    text: text.clone(),
                    node_id: Some(entry.node_id.clone()),
                    bold: mark.is_some_and(|mark| mark.0),
                    italic: mark.is_some_and(|mark| mark.1),
                    link: mark.and_then(|mark| mark.2.clone()),
                }
            })
        })
        .collect();
    Ok(updated)
}
pub(super) fn insert(
    manifest: &HcdManifest,
    patch: &str,
    operation: usize,
    rows: usize,
    columns: usize,
) -> Result<Block, HcdError> {
    dimensions(rows, columns)?;
    let id = stable_node_id(&[
        &manifest.document_id,
        patch,
        &operation.to_string(),
        "table",
    ]);
    let mut builder = Builder {
        manifest,
        patch,
        operation,
        number: 0,
        entries: vec![],
    };
    let mut html=format!("<table class=\"hcd-table hcd-editor-table\" data-hcd-id=\"{id}\" style=\"width:100%;table-layout:fixed;margin:12px 0\"><tbody>");
    for _ in 0..rows {
        html.push_str("<tr>");
        for _ in 0..columns {
            html.push_str(&render(&[builder.cell(None)?]));
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    let block = Block {
        id,
        region: "body".into(),
        read_only: true,
        content: EditorBlockContent {
            kind: EditorBlockKind::Opaque,
            level: None,
            font: None,
            inlines: vec![],
        },
        html: String::new(),
        entries: vec![],
    };
    rebuild(&block, html, builder.entries)
}
fn normalize(table: &mut Element) {
    // DOCX retains invisible vMerge continuation cells for source fidelity.
    // A structural semantic edit uses the already-materialized HTML rowspan.
    for path in row_paths(table) {
        let row = element_mut(&mut table.children, &path);
        row.children.retain(|node|!matches!(node,Xml::Element(cell) if cell.is_cell()&&cell.attrs.get("data-hcd-v-merge").is_some_and(|v|v=="continue")&&cell.attrs.get("style").is_some_and(|s|s.replace(' ',"").contains("display:none"))));
    }
}
fn row_children_mut<'a>(table: &'a mut Element, path: &[usize]) -> &'a mut Vec<Xml> {
    if path.len() == 1 {
        &mut table.children
    } else {
        &mut element_mut(&mut table.children, &path[..path.len() - 1]).children
    }
}
pub(super) fn ensure_table(block: &Block) -> Result<(), HcdError> {
    if block.region != "body"
        || !block.read_only
        || block.content.kind != EditorBlockKind::Opaque
        || find_table(&parse(&block.html)?, 0).is_none()
    {
        return Err(invalid("operation requires a canonical body table"));
    }
    Ok(())
}
pub(super) fn restore(
    bundle: &Bundle,
    blocks: &mut Vec<Block>,
    manifest: &HcdManifest,
    operation: &StructureOperation,
    dirty_nodes: &mut HashSet<String>,
    dirty_parts: &mut HashSet<String>,
) -> Result<(), HcdError> {
    let StructureOperation::TableRestore {
        block_id,
        source_revision,
        after_block_id,
        precondition,
    } = operation
    else {
        return Err(invalid("not a table restore"));
    };
    if manifest.source.format == "txt" {
        return Err(invalid("tables require a rich body"));
    }
    let existing = blocks.iter().position(|block| &block.id == block_id);
    match (existing, precondition.block_hash.as_ref()) {
        (Some(index), Some(hash)) => {
            ensure_table(&blocks[index])?;
            if &blocks[index].hash() != hash {
                return Err(HcdError::RevisionConflict(
                    "table changed since the recorded edit; cannot overwrite collaborator changes"
                        .into(),
                ));
            }
        }
        (None, None) => {}
        _ => {
            return Err(HcdError::RevisionConflict(
                "table presence changed since the recorded edit".into(),
            ))
        }
    }
    let (historical, _) = crate::manifest_at_revision(bundle, manifest, Some(*source_revision))?;
    let source = load_blocks(bundle, &historical)?
        .into_iter()
        .find(|block| &block.id == block_id)
        .ok_or_else(|| invalid("historical table was not found"))?;
    ensure_table(&source)?;
    if let Some(index) = existing {
        dirty_nodes.extend(
            blocks[index]
                .entries
                .iter()
                .map(|entry| entry.node_id.clone()),
        );
        dirty_parts.extend(
            blocks[index]
                .entries
                .iter()
                .map(|entry| entry.source.part.clone()),
        );
    }
    dirty_nodes.extend(source.entries.iter().map(|entry| entry.node_id.clone()));
    dirty_parts.extend(source.entries.iter().map(|entry| entry.source.part.clone()));
    if let Some(index) = existing {
        blocks[index] = source;
    } else {
        let index = insertion_index(blocks, after_block_id.as_deref())?;
        if !insertion_touches_region(blocks, index, "body") {
            return Err(invalid("cannot restore table outside body"));
        }
        blocks.insert(index, source);
    }
    Ok(())
}
pub(super) fn edit(
    original: &Block,
    manifest: &HcdManifest,
    patch: &str,
    operation: usize,
    table_index: usize,
    action: TableEditAction,
    index: usize,
) -> Result<Block, HcdError> {
    let mut nodes = parse(&original.html)?;
    let path =
        find_table(&nodes, table_index).ok_or_else(|| invalid("table index was not found"))?;
    let table = element_mut(&mut nodes, &path);
    if table
        .attrs
        .get("data-hcd-continuation")
        .is_some_and(|v| v == "true")
        || table
            .attrs
            .get("data-hcd-table-fragment")
            .is_some_and(|v| v != "0")
        || table
            .attrs
            .get("data-hcd-table-final")
            .is_some_and(|v| v != "true")
    {
        return Err(invalid(
            "fragmented tables must be consolidated before structural editing",
        ));
    }
    normalize(table);
    let before = grid(table)?;
    let mut builder = Builder {
        manifest,
        patch,
        operation,
        number: 0,
        entries: vec![],
    };
    match action {
        TableEditAction::InsertRow => {
            if index > before.rows.len() {
                return Err(invalid("row insertion index is out of bounds"));
            }
            dimensions(before.rows.len() + 1, before.width)?;
            for cell in &before.cells {
                if cell.row < index && cell.row + cell.rows > index {
                    element_mut(&mut table.children, &cell.path)
                        .set("rowspan", Some((cell.rows + 1).to_string()));
                }
            }
            let reference = index.min(before.rows.len() - 1);
            let mut new = element(&table.children, &before.rows[reference]).clone();
            new.children.clear();
            for name in ["data-hcd-repeat-header", "data-hcd-id", "id"] {
                new.set(name, None);
            }
            for c in 0..before.width {
                if before.cells.iter().any(|cell| {
                    cell.row < index
                        && cell.row + cell.rows > index
                        && cell.column <= c
                        && c < cell.column + cell.columns
                }) {
                    continue;
                }
                let template = before
                    .cells
                    .iter()
                    .find(|cell| {
                        cell.row <= reference
                            && reference < cell.row + cell.rows
                            && cell.column <= c
                            && c < cell.column + cell.columns
                    })
                    .map(|cell| element(&table.children, &cell.path));
                new.children.push(builder.cell(template)?);
            }
            let anchor = &before.rows[index.min(before.rows.len() - 1)];
            let at = anchor[anchor.len() - 1] + usize::from(index == before.rows.len());
            row_children_mut(table, anchor).insert(at, Xml::Element(new));
        }
        TableEditAction::DeleteRow => {
            if index >= before.rows.len() || before.rows.len() == 1 {
                return Err(invalid("cannot delete the last or an unknown row"));
            }
            for cell in &before.cells {
                if cell.row < index && cell.row + cell.rows > index {
                    element_mut(&mut table.children, &cell.path)
                        .set("rowspan", Some((cell.rows - 1).to_string()));
                }
            }
            if index + 1 < before.rows.len() {
                let mut next: Vec<(usize, Xml)> = before
                    .cells
                    .iter()
                    .filter(|cell| cell.row == index + 1)
                    .map(|cell| {
                        (
                            cell.column,
                            Xml::Element(element(&table.children, &cell.path).clone()),
                        )
                    })
                    .collect();
                for cell in before
                    .cells
                    .iter()
                    .filter(|cell| cell.row == index && cell.rows > 1)
                {
                    let mut moved = element(&table.children, &cell.path).clone();
                    moved.set("rowspan", Some((cell.rows - 1).to_string()));
                    next.push((cell.column, Xml::Element(moved)));
                }
                next.sort_by_key(|(col, _)| *col);
                element_mut(&mut table.children, &before.rows[index + 1]).children =
                    next.into_iter().map(|(_, node)| node).collect();
            }
            let path = &before.rows[index];
            row_children_mut(table, path).remove(path[path.len() - 1]);
        }
        TableEditAction::InsertColumn => {
            if index > before.width {
                return Err(invalid("column insertion index is out of bounds"));
            }
            dimensions(before.rows.len(), before.width + 1)?;
            for cell in &before.cells {
                if cell.column < index && cell.column + cell.columns > index {
                    element_mut(&mut table.children, &cell.path)
                        .set("colspan", Some((cell.columns + 1).to_string()));
                }
            }
            for (r, path) in before.rows.iter().enumerate() {
                if before.cells.iter().any(|cell| {
                    cell.row <= r
                        && r < cell.row + cell.rows
                        && cell.column < index
                        && index < cell.column + cell.columns
                }) {
                    continue;
                }
                let template = before
                    .cells
                    .iter()
                    .find(|cell| {
                        cell.row <= r
                            && r < cell.row + cell.rows
                            && cell.column <= index.min(before.width - 1)
                            && index.min(before.width - 1) < cell.column + cell.columns
                    })
                    .map(|cell| element(&table.children, &cell.path));
                let added = builder.cell(template)?;
                let at = before
                    .cells
                    .iter()
                    .find(|cell| cell.row == r && cell.column >= index)
                    .map(|cell| *cell.path.last().unwrap());
                let row = element_mut(&mut table.children, path);
                row.children.insert(at.unwrap_or(row.children.len()), added);
            }
            edit_columns(table, index, true)?;
        }
        TableEditAction::DeleteColumn => {
            if index >= before.width || before.width == 1 {
                return Err(invalid("cannot delete the last or an unknown column"));
            }
            for cell in before
                .cells
                .iter()
                .rev()
                .filter(|cell| cell.column <= index && index < cell.column + cell.columns)
            {
                if cell.columns > 1 {
                    element_mut(&mut table.children, &cell.path)
                        .set("colspan", Some((cell.columns - 1).to_string()));
                } else {
                    let parent =
                        element_mut(&mut table.children, &cell.path[..cell.path.len() - 1]);
                    parent.children.remove(*cell.path.last().unwrap());
                }
            }
            edit_columns(table, index, false)?;
        }
    }
    // Add a writable run only to genuinely empty cells. Never flatten visible
    // unmapped text, pictures, drawings or nested tables into an empty paragraph.
    for rowpath in row_paths(table) {
        let row = element_mut(&mut table.children, &rowpath);
        for node in &mut row.children {
            if let Xml::Element(cell) = node {
                if cell.is_cell()
                    && extract_html_text_nodes(&render(&cell.children))?.is_empty()
                    && empty_content(&cell.children)
                {
                    let Xml::Element(blank) = builder.cell(Some(cell))? else {
                        unreachable!()
                    };
                    if let Some(paragraph) = empty_paragraph(&mut cell.children) {
                        let Xml::Element(generated) = &blank.children[0] else {
                            unreachable!()
                        };
                        if !paragraph.attrs.contains_key("data-hcd-id") {
                            paragraph
                                .set("data-hcd-id", generated.attrs.get("data-hcd-id").cloned());
                        }
                        builder.entries.last_mut().unwrap().source.paragraph_id =
                            paragraph.attrs.get("data-hcd-id").cloned();
                        paragraph.children.extend(generated.children.clone());
                    } else {
                        cell.children.extend(blank.children);
                    }
                }
            }
        }
    }
    let after = grid(table)?;
    let row_band = table
        .attrs
        .get("data-hcd-row-band-size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    let column_band = table
        .attrs
        .get("data-hcd-column-band-size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    for (r, path) in after.rows.iter().enumerate() {
        let row = element_mut(&mut table.children, path);
        if row.attrs.contains_key("data-hcd-row-band") {
            row.set(
                "data-hcd-row-band",
                Some((1 + r / row_band % 2).to_string()),
            );
        }
        if row.attrs.contains_key("data-hcd-row-index") {
            row.set("data-hcd-row-index", Some(r.to_string()));
        }
    }
    for cell in &after.cells {
        let element = element_mut(&mut table.children, &cell.path);
        if element.attrs.contains_key("data-hcd-column-band") {
            element.set(
                "data-hcd-column-band",
                Some((1 + cell.column / column_band % 2).to_string()),
            );
        }
    }
    if table.attrs.contains_key("data-hcd-table-node-id") {
        for (key, value) in [
            ("data-hcd-row-start", 1),
            ("data-hcd-row-end", after.rows.len()),
            ("data-hcd-fragment-row-count", after.rows.len()),
            ("data-hcd-row-count", after.rows.len()),
            ("data-hcd-column-count", after.width),
        ] {
            table.set(key, Some(value.to_string()));
        }
    }
    rebuild(original, render(&nodes), builder.entries)
}
fn empty_content(nodes: &[Xml]) -> bool {
    nodes.iter().all(|node| match node {
        Xml::Raw(raw) => raw.trim().is_empty() || raw.trim().starts_with("<!--"),
        Xml::Element(element) => {
            !matches!(
                element.tag.as_str(),
                "table"
                    | "img"
                    | "svg"
                    | "math"
                    | "object"
                    | "video"
                    | "audio"
                    | "iframe"
                    | "canvas"
                    | "hr"
                    | "input"
            ) && empty_content(&element.children)
        }
    })
}
fn empty_paragraph(nodes: &mut [Xml]) -> Option<&mut Element> {
    for node in nodes {
        if let Xml::Element(element) = node {
            if matches!(element.tag.as_str(), "p" | "h1" | "h2" | "h3" | "li") {
                return Some(element);
            }
            if let Some(found) = empty_paragraph(&mut element.children) {
                return Some(found);
            }
        }
    }
    None
}
fn edit_columns(table: &mut Element, index: usize, insert: bool) -> Result<(), HcdError> {
    for node in &mut table.children {
        if let Xml::Element(group) = node {
            if group.tag != "colgroup" {
                continue;
            }
            let mut cols = vec![];
            for node in &group.children {
                if let Xml::Element(col) = node {
                    if col.tag == "col" {
                        let span = col.span("span")?;
                        for _ in 0..span {
                            let mut next = col.clone();
                            next.set("span", None);
                            cols.push(Xml::Element(next));
                        }
                    }
                }
            }
            if !cols.is_empty() {
                if insert {
                    let template = cols[index.min(cols.len() - 1)].clone();
                    cols.insert(index.min(cols.len()), template);
                } else if index < cols.len() {
                    cols.remove(index);
                }
                group.children = cols;
            }
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> HcdManifest {
        let (_temp, bundle) = super::super::tests::fixture();
        bundle.manifest().unwrap()
    }
    fn from_html(html: &str) -> Block {
        Block {
            id: "n_00000000000000000000000000000001".into(),
            region: "body".into(),
            read_only: true,
            content: EditorBlockContent {
                kind: EditorBlockKind::Opaque,
                level: None,
                font: None,
                inlines: vec![],
            },
            html: html.into(),
            entries: vec![],
        }
    }
    fn shape(block: &Block) -> (usize, usize, Vec<Cell>) {
        let nodes = parse(&block.html).unwrap();
        let path = find_table(&nodes, 0).unwrap();
        let grid = grid(element(&nodes, &path)).unwrap();
        (grid.rows.len(), grid.width, grid.cells)
    }
    #[test]
    fn row_edits_expand_crossing_merges_and_move_surviving_anchor() {
        let manifest = manifest();
        let original = from_html("<table><tbody><tr><td rowspan=\"2\"><p style=\"color:blue\">Anchor</p></td><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>");
        let added = edit(
            &original,
            &manifest,
            "row-add",
            0,
            0,
            TableEditAction::InsertRow,
            1,
        )
        .unwrap();
        assert_eq!((shape(&added).0, shape(&added).1), (4, 2));
        assert!(added.html.contains("rowspan=\"3\""));
        assert!(added.html.contains("<p style=\"color:blue\">Anchor</p>"));
        assert_eq!(added.entries.len(), 1);
        let removed = edit(
            &original,
            &manifest,
            "row-delete",
            0,
            0,
            TableEditAction::DeleteRow,
            0,
        )
        .unwrap();
        assert_eq!((shape(&removed).0, shape(&removed).1), (2, 2));
        assert!(removed.html.contains("<p style=\"color:blue\">Anchor</p>"));
        assert!(!removed.html.contains(">A<"));
        assert_eq!(shape(&removed).2[0].rows, 1);
    }
    #[test]
    fn column_edits_preserve_spans_colgroups_and_nested_table_targeting() {
        let manifest = manifest();
        let original = from_html("<table><colgroup><col span=\"2\" style=\"width:50pt\"/></colgroup><tbody><tr><td colspan=\"2\">Merged<table><tr><td>Nested</td></tr></table></td></tr><tr><td>A</td><td>B</td></tr></tbody></table>");
        let added = edit(
            &original,
            &manifest,
            "column-add",
            0,
            0,
            TableEditAction::InsertColumn,
            1,
        )
        .unwrap();
        assert_eq!((shape(&added).0, shape(&added).1), (2, 3));
        assert!(added.html.contains("colspan=\"3\""));
        assert_eq!(added.html.matches("<col style").count(), 3);
        let removed = edit(
            &added,
            &manifest,
            "column-delete",
            0,
            0,
            TableEditAction::DeleteColumn,
            0,
        )
        .unwrap();
        assert_eq!(shape(&removed).1, 2);
        assert!(removed.html.contains("colspan=\"2\""));
        let nested = edit(
            &original,
            &manifest,
            "nested",
            0,
            1,
            TableEditAction::InsertColumn,
            1,
        )
        .unwrap();
        assert_eq!(shape(&nested).1, 2);
        assert_eq!(
            nested.html.matches("<td").count(),
            original.html.matches("<td").count() + 1
        );
    }
    #[test]
    fn edits_keep_existing_source_runs_and_make_blank_cells_writable() {
        let manifest = manifest();
        let original = insert(&manifest, "initial", 0, 2, 2).unwrap();
        let added = edit(
            &original,
            &manifest,
            "added",
            0,
            0,
            TableEditAction::InsertRow,
            1,
        )
        .unwrap();
        for entry in &original.entries {
            let saved = added
                .entries
                .iter()
                .find(|next| next.node_id == entry.node_id)
                .unwrap();
            assert_eq!(
                serde_json::to_value(saved).unwrap(),
                serde_json::to_value(entry).unwrap()
            );
        }
        assert_eq!(table_text_node_ids(&added).len(), 6);
        let empty = from_html("<table><tr><td><p data-hcd-id=\"original\" style=\"text-align:right\"></p></td><td><img src=\"data:image/png;base64,AA==\"/></td><td>Unmapped text</td></tr></table>");
        let edited = edit(
            &empty,
            &manifest,
            "blank",
            0,
            0,
            TableEditAction::InsertRow,
            1,
        )
        .unwrap();
        assert!(edited
            .html
            .contains("<p data-hcd-id=\"original\" style=\"text-align:right\"><span"));
        assert!(edited
            .html
            .contains("<td><img src=\"data:image/png;base64,AA==\"/></td>"));
        assert!(edited.html.contains("<td>Unmapped text</td>"));
        assert_eq!(edited.entries.len(), 4);
    }
    #[test]
    fn bounded_table_edits_reject_last_dimension_fragments_and_bad_grids() {
        let manifest = manifest();
        let original = insert(&manifest, "single", 0, 1, 1).unwrap();
        for (action, index) in [
            (TableEditAction::DeleteRow, 0),
            (TableEditAction::DeleteColumn, 0),
            (TableEditAction::InsertRow, 2),
            (TableEditAction::InsertColumn, 2),
        ] {
            assert!(edit(&original, &manifest, "invalid", 0, 0, action, index).is_err());
        }
        assert!(insert(&manifest, "huge", 0, 1000, 128).is_err());
        let fragment =
            from_html("<table data-hcd-continuation=\"true\"><tr><td>A</td></tr></table>");
        assert!(edit(
            &fragment,
            &manifest,
            "fragment",
            0,
            0,
            TableEditAction::InsertRow,
            1
        )
        .is_err());
        let incomplete =
            from_html("<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>");
        assert!(edit(
            &incomplete,
            &manifest,
            "incomplete",
            0,
            0,
            TableEditAction::InsertRow,
            1
        )
        .is_err());
    }
}
