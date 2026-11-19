//! Reconcile canonical body structure into the immutable Word package. Existing
//! cells and paragraphs keep their original OOXML; only grid/merge geometry and
//! genuinely new content are generated. Running regions never pass through HTML.
use super::*;
use hcd_core::{EditorBlockKind, EditorBlockView};

#[derive(Clone)]
enum Xml {
    Element(Element),
    Raw(String),
}
#[derive(Clone)]
struct Element {
    name: String,
    open: String,
    close: String,
    attrs: BTreeMap<String, String>,
    children: Vec<Xml>,
    base: u64,
    count: u64,
}
impl Element {
    fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| {
            if let Xml::Element(e) = n {
                Some(e)
            } else {
                None
            }
        })
    }
    fn child(&self, name: &str) -> Option<&Element> {
        self.elements().find(|e| e.name == name)
    }
    fn descendant(&self, name: &str) -> Option<&Element> {
        if self.name == name {
            Some(self)
        } else {
            self.elements().find_map(|e| e.descendant(name))
        }
    }
    fn raw(&self) -> String {
        format!("{}{}{}", self.open, render(&self.children), self.close)
    }
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).map(String::as_str)
    }
    fn span(&self, key: &str) -> Result<usize, HcdError> {
        let span = self
            .attr(key)
            .unwrap_or("1")
            .parse::<usize>()
            .map_err(|_| bad("invalid cell span"))?;
        if !(1..=1000).contains(&span) {
            return Err(bad("cell span exceeds native export bounds"));
        }
        Ok(span)
    }
}
fn bad(message: &str) -> HcdError {
    HcdError::Unsupported(format!("high-fidelity DOCX: {message}"))
}
fn render(nodes: &[Xml]) -> String {
    nodes
        .iter()
        .map(|n| match n {
            Xml::Element(e) => e.raw(),
            Xml::Raw(s) => s.clone(),
        })
        .collect()
}
fn parse(source: &str) -> Result<Vec<Xml>, HcdError> {
    if source.len() > 64 * 1024 * 1024 {
        return Err(bad("XML exceeds 64 MiB"));
    }
    let mut reader = Reader::from_str(source);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<(Element, usize)> = vec![];
    let mut root = vec![];
    let mut ordinal = 0u64;
    let mut count = 0;
    loop {
        let from = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        let to = reader.buffer_position() as usize;
        let node = match event {
            Event::Start(start) | Event::Empty(start) => {
                count += 1;
                if count > 2_000_000 || stack.len() > 128 {
                    return Err(bad("XML complexity limit exceeded"));
                }
                let name = local_name(start.name().as_ref()).to_string();
                let base = ordinal;
                if name == "t" {
                    ordinal += 1;
                }
                let attrs = start
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                        Ok((
                            local_name(a.key.as_ref()).to_string(),
                            a.decode_and_unescape_value(reader.decoder())
                                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, HcdError>>()?;
                let e = Element {
                    name,
                    open: source[from..to].into(),
                    close: String::new(),
                    attrs,
                    children: vec![],
                    base,
                    count: ordinal - base,
                };
                if source[from..to].ends_with("/>") {
                    Some(Xml::Element(e))
                } else {
                    stack.push((e, from));
                    None
                }
            }
            Event::End(_) => {
                let (mut e, _) = stack.pop().ok_or_else(|| bad("unbalanced XML"))?;
                e.close = source[from..to].into();
                e.count = ordinal - e.base;
                Some(Xml::Element(e))
            }
            Event::Eof => break,
            _ => Some(Xml::Raw(source[from..to].into())),
        };
        if let Some(node) = node {
            if let Some((parent, _)) = stack.last_mut() {
                parent.children.push(node)
            } else {
                root.push(node)
            }
        }
    }
    if !stack.is_empty() {
        return Err(bad("unclosed XML"));
    }
    Ok(root)
}
fn rewritten(element: &Element, updates: &BTreeMap<u64, TextUpdate>) -> Result<String, HcdError> {
    if element.count == 0 {
        return Ok(element.raw());
    }
    let local: BTreeMap<_, _> = updates
        .range(element.base + 1..=element.base + element.count)
        .map(|(id, u)| (*id - element.base, u.clone()))
        .collect();
    let raw = element.raw();
    if local.is_empty() {
        return Ok(raw);
    }
    let mut output = vec![];
    rewrite_text_part(&mut raw.as_bytes(), &mut output, &local)?;
    String::from_utf8(output).map_err(|e| HcdError::InvalidBundle(e.to_string()))
}
pub(super) fn original_entries(bundle: &Bundle) -> Result<HashMap<String, NodeMapEntry>, HcdError> {
    let manifest = manifest_at_revision(bundle, &bundle.manifest()?, 0)?;
    let mut entries = HashMap::new();
    for n in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, n)?.chunks {
            for entry in bundle.read_map(&chunk)?.entries {
                entries.insert(entry.node_id.clone(), entry);
            }
        }
    }
    Ok(entries)
}
pub(super) fn live_dirty(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty: &HashSet<String>,
) -> Result<(HashSet<String>, HashSet<String>), HcdError> {
    let original = original_entries(bundle)?;
    let mut nodes = HashSet::new();
    let mut parts = HashSet::new();
    for n in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, n)?.chunks {
            for entry in bundle.read_map(&chunk)?.entries {
                if !dirty.contains(&entry.node_id) {
                    continue;
                }
                if entry.source.node_kind == "image" {
                    if original
                        .get(&entry.node_id)
                        .is_none_or(|old| old.node_hash != entry.node_hash)
                    {
                        return Err(bad(
                            "modified source images need an explicit native image rewrite",
                        ));
                    }
                    continue;
                }
                if original.contains_key(&entry.node_id) {
                    parts.insert(entry.source.part.clone());
                    nodes.insert(entry.node_id);
                }
            }
        }
    }
    Ok((parts, nodes))
}

pub(super) fn document(
    bundle: &Bundle,
    revision: u64,
    source: &str,
    updates: &BTreeMap<u64, TextUpdate>,
) -> Result<String, HcdError> {
    let tree = parse(source)?;
    let doc = tree
        .iter()
        .find_map(|n| {
            if let Xml::Element(e) = n {
                Some(e)
            } else {
                None
            }
        })
        .ok_or_else(|| bad("document root is missing"))?;
    let body = doc
        .child("body")
        .ok_or_else(|| bad("Word body is missing"))?;
    if doc.attr("w") != Some("http://schemas.openxmlformats.org/wordprocessingml/2006/main") {
        return Err(bad(
            "native Word namespace prefix cannot be reconciled safely",
        ));
    }
    let original = hcd_core::editor_projection(bundle, Some(0))?
        .blocks
        .into_iter()
        .filter(|b| b.region == "body")
        .collect::<Vec<_>>();
    let current = hcd_core::editor_projection(bundle, Some(revision))?
        .blocks
        .into_iter()
        .filter(|b| b.region == "body")
        .collect::<Vec<_>>();
    let alignments: HashMap<_, _> = original
        .iter()
        .map(|block| (&block.block_id, block.content.alignment))
        .collect();
    if current.iter().any(|block| {
        block
            .content
            .inlines
            .iter()
            .any(|inline| !inline.format.is_empty())
            || alignments.get(&block.block_id).copied().flatten() != block.content.alignment
    }) {
        return Err(bad(
            "This revision has typed Word formatting changes. Use the editable DOCX rebuild",
        ));
    }
    let native = body
        .elements()
        .filter(|e| matches!(e.name.as_str(), "p" | "tbl"))
        .collect::<Vec<_>>();
    if native.len() != original.len()
        || body
            .elements()
            .any(|e| !matches!(e.name.as_str(), "p" | "tbl" | "sectPr"))
    {
        return Err(bad(
            "body block mapping is ambiguous; export was stopped before changing the package",
        ));
    }
    let by_id: HashMap<_, _> = original
        .iter()
        .zip(&native)
        .map(|(b, e)| (b.block_id.as_str(), (b, *e)))
        .collect();
    fn body_width(section: Option<&Element>) -> u64 {
        let width = section
            .and_then(|s| s.child("pgSz"))
            .and_then(|s| s.attr("w"))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(12240);
        let margin = section.and_then(|s| s.child("pgMar"));
        let left = margin
            .and_then(|s| s.attr("left"))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1440);
        let right = margin
            .and_then(|s| s.attr("right"))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1440);
        width.saturating_sub(left + right).max(1)
    }
    let mut section_width = body_width(body.child("sectPr"));
    let mut widths = HashMap::new();
    for (block, element) in original.iter().zip(&native).rev() {
        let after = section_width;
        if let Some(section) = element.child("pPr").and_then(|p| p.child("sectPr")) {
            section_width = body_width(Some(section));
        }
        widths.insert(block.block_id.as_str(), (section_width, after));
    }
    let mut available_width = original
        .first()
        .and_then(|b| widths.get(b.block_id.as_str()))
        .map(|p| p.0)
        .unwrap_or(section_width);
    let entries = original_entries(bundle)?;
    let ordinals: HashMap<_, _> = entries
        .iter()
        .filter(|(_, e)| e.source.part == "word/document.xml")
        .map(|(id, e)| (id.as_str(), e.source.text_ordinal))
        .collect();
    let mut content = String::new();
    let mut previous: Option<&Element> = None;
    for block in &current {
        if let Some((old, element)) = by_id.get(block.block_id.as_str()) {
            if block.content.kind != old.content.kind || block.content.level != old.content.level {
                return Err(bad(
                    "changing an existing paragraph type needs a native paragraph-property rewrite",
                ));
            }
            if element.name == "tbl" && block.read_only_html != old.read_only_html {
                let html = html_element(block)?;
                content.push_str(&table(
                    &html,
                    Some(element),
                    Some(&html_element(old)?),
                    &ordinals,
                    updates,
                    available_width,
                )?);
            } else {
                content.push_str(&rewritten(element, updates)?);
            }
            previous = Some(element);
            available_width = widths[block.block_id.as_str()].1;
        } else if block.read_only
            && block
                .read_only_html
                .as_deref()
                .is_some_and(|s| s.starts_with("<table"))
        {
            content.push_str(&table(
                &html_element(block)?,
                None,
                None,
                &ordinals,
                updates,
                available_width,
            )?);
        } else if block.content.kind == EditorBlockKind::Paragraph {
            if block.content.inlines.iter().any(|i| i.link.is_some()) {
                return Err(bad("new hyperlinks require a native relationship rewrite"));
            }
            content.push_str(&paragraph_from_block(block, previous));
        } else {
            return Err(bad(
                "this new body block has no lossless native representation",
            ));
        }
    }
    if let Some(section) = body.child("sectPr") {
        content.push_str(&section.raw());
    }
    let new_body = format!("{}{}{}", body.open, content, body.close);
    let mut out = String::new();
    for n in &tree {
        match n {
            Xml::Raw(s) => out.push_str(s),
            Xml::Element(e) => {
                out.push_str(&e.open);
                for child in &e.children {
                    match child {
                        Xml::Element(e) if e.name == "body" => out.push_str(&new_body),
                        Xml::Element(e) => out.push_str(&e.raw()),
                        Xml::Raw(s) => out.push_str(s),
                    }
                }
                out.push_str(&e.close);
            }
        }
    }
    Ok(out)
}
fn html_element(block: &EditorBlockView) -> Result<Element, HcdError> {
    parse(
        block
            .read_only_html
            .as_deref()
            .ok_or_else(|| bad("table HTML is missing"))?,
    )?
    .into_iter()
    .find_map(|n| {
        if let Xml::Element(e) = n {
            Some(e)
        } else {
            None
        }
    })
    .ok_or_else(|| bad("table HTML is empty"))
}
fn escaped(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}
fn first_property(element: Option<&Element>, name: &str) -> String {
    element
        .and_then(|e| e.descendant(name))
        .map(Element::raw)
        .unwrap_or_default()
}
fn paragraph_from_block(block: &EditorBlockView, template: Option<&Element>) -> String {
    let ppr = template
        .and_then(|e| e.descendant("pPr"))
        .map(|pr| {
            format!(
                "<w:pPr>{}</w:pPr>",
                pr.elements()
                    .filter(|e| e.name != "sectPr")
                    .map(Element::raw)
                    .collect::<String>()
            )
        })
        .unwrap_or_default();
    let rpr = first_property(template, "rPr");
    let text = block
        .content
        .inlines
        .iter()
        .map(|i| {
            let mut props = rpr.clone();
            if i.bold || i.italic {
                let marks = format!(
                    "{}{}",
                    if i.bold { "<w:b/>" } else { "" },
                    if i.italic { "<w:i/>" } else { "" }
                );
                props = if props.is_empty() {
                    format!("<w:rPr>{marks}</w:rPr>")
                } else {
                    props.replace("</w:rPr>", &format!("{marks}</w:rPr>"))
                };
            }
            format!(
                "<w:r>{props}<w:t xml:space=\"preserve\">{}</w:t></w:r>",
                escaped(&i.text)
            )
        })
        .collect::<String>();
    format!("<w:p>{ppr}{text}</w:p>")
}
fn rows(table: &Element) -> Vec<&Element> {
    table
        .elements()
        .flat_map(|e| {
            if e.name == "tr" {
                vec![e]
            } else if matches!(e.name.as_str(), "tbody" | "thead" | "tfoot") {
                e.elements().filter(|c| c.name == "tr").collect()
            } else {
                vec![]
            }
        })
        .collect()
}
struct Cell<'a> {
    row: usize,
    column: usize,
    columns: usize,
    rows: usize,
    html: &'a Element,
    native: Option<&'a Element>,
    native_row: Option<&'a Element>,
}
fn table(
    html: &Element,
    native: Option<&Element>,
    original_html: Option<&Element>,
    ordinals: &HashMap<&str, u64>,
    updates: &BTreeMap<u64, TextUpdate>,
    available_width: u64,
) -> Result<String, HcdError> {
    if html.name != "table" {
        return Err(bad("body table mapping is ambiguous"));
    }
    if html.elements().any(|e| e.descendant("table").is_some()) {
        return Err(bad(
            "structural edits to nested tables require a native nested-table reconciliation",
        ));
    }
    let native_rows = native.map(rows).unwrap_or_default();
    let html_rows = rows(html);
    fn ids(e: &Element, out: &mut Vec<String>) {
        if let Some(id) = e.attr("data-hcd-id") {
            out.push(id.into());
        }
        for child in e.elements() {
            ids(child, out);
        }
    }
    let mut origins = HashMap::new();
    if let Some(old) = original_html {
        for (html_row, native_row) in rows(old).iter().zip(&native_rows) {
            for (html_cell, native_cell) in html_row
                .elements()
                .filter(|e| matches!(e.name.as_str(), "td" | "th"))
                .zip(native_row.elements().filter(|e| e.name == "tc"))
            {
                let mut keys = vec![];
                ids(html_cell, &mut keys);
                for id in keys {
                    origins.insert(id, (*native_row, native_cell));
                }
            }
        }
    }
    let mut cells = vec![];
    let mut occupied = HashSet::new();
    let mut width = 0;
    for (r, row) in html_rows.iter().enumerate() {
        let mut c = 0;
        for cell in row
            .elements()
            .filter(|e| matches!(e.name.as_str(), "td" | "th"))
        {
            if cell.attr("data-hcd-v-merge") == Some("continue")
                && cell
                    .attr("style")
                    .is_some_and(|s| s.replace(' ', "").contains("display:none"))
            {
                continue;
            }
            while occupied.contains(&(r, c)) {
                c += 1;
            }
            let columns = cell.span("colspan")?;
            let row_span = cell.span("rowspan")?;
            if r + row_span > html_rows.len() || c + columns > 128 || html_rows.len() > 1000 {
                return Err(bad("native table dimensions are out of bounds"));
            }
            let texts = hcd_core::extract_html_text_nodes(&cell.raw())?;
            let ordinal = texts
                .keys()
                .find_map(|id| ordinals.get(id.as_str()))
                .copied();
            let mut anchors = vec![];
            ids(cell, &mut anchors);
            let origin = anchors
                .iter()
                .find_map(|id| origins.get(id))
                .copied()
                .or_else(|| {
                    ordinal.and_then(|n| {
                        native_rows.iter().find_map(|row| {
                            row.elements()
                                .filter(|e| e.name == "tc")
                                .find(|e| e.base < n && n <= e.base + e.count)
                                .map(|cell| (*row, cell))
                        })
                    })
                });
            for y in r..r + row_span {
                for x in c..c + columns {
                    if !occupied.insert((y, x)) {
                        return Err(bad("overlapping merged table cells"));
                    }
                }
            }
            cells.push(Cell {
                row: r,
                column: c,
                columns,
                rows: row_span,
                html: cell,
                native: origin.map(|(_, c)| c),
                native_row: origin.map(|(r, _)| r),
            });
            c += columns;
            width = width.max(c);
        }
    }
    if width == 0 || cells.len() > 10000 {
        return Err(bad("native table is empty or exceeds the cell limit"));
    }
    let authored = html
        .child("colgroup")
        .map(|g| {
            g.elements()
                .filter(|e| e.name == "col")
                .map(|e| css_twips(e.attr("style").unwrap_or(""), "width"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let source_grid = native
        .and_then(|t| t.child("tblGrid"))
        .map(|g| {
            g.elements()
                .filter(|e| e.name == "gridCol")
                .map(|e| e.attr("w").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let total = source_grid.iter().sum::<u64>();
    let fallback = if total > 0 { total } else { available_width } / width as u64;
    let grid = (0..width)
        .map(|n| {
            authored
                .get(n)
                .and_then(|v| *v)
                .or_else(|| source_grid.get(n).copied())
                .filter(|v| *v > 0)
                .unwrap_or(fallback)
        })
        .collect::<Vec<_>>();
    let mut out = String::from("<w:tbl>");
    out.push_str(&first_property(native, "tblPr"));
    if native.is_none() {
        out.push_str("<w:tblPr><w:tblW w:w=\"5000\" w:type=\"pct\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders><w:tblLayout w:type=\"fixed\"/></w:tblPr>");
    }
    out.push_str("<w:tblGrid>");
    for w in &grid {
        out.push_str(&format!("<w:gridCol w:w=\"{w}\"/>"));
    }
    out.push_str("</w:tblGrid>");
    for (r, html_row) in html_rows.iter().enumerate() {
        out.push_str("<w:tr>");
        let template = cells
            .iter()
            .find(|c| c.row == r && c.native_row.is_some())
            .and_then(|c| c.native_row)
            .or_else(|| {
                native_rows
                    .get(r.min(native_rows.len().saturating_sub(1)))
                    .copied()
            });
        let mut props = String::new();
        if let Some(pr) = template.and_then(|r| r.child("trPr")) {
            for p in pr.elements().filter(|p| p.name != "tblHeader") {
                props.push_str(&p.raw());
            }
        }
        if html_row.attr("data-hcd-repeat-header") == Some("true") {
            props.push_str("<w:tblHeader/>");
        }
        if !props.is_empty() {
            out.push_str(&format!("<w:trPr>{props}</w:trPr>"));
        }
        let mut row_cells = cells
            .iter()
            .filter(|c| c.row <= r && r < c.row + c.rows)
            .collect::<Vec<_>>();
        row_cells.sort_by_key(|c| c.column);
        for cell in row_cells {
            let template = cell.native.or_else(|| {
                cells
                    .iter()
                    .filter(|c| c.native.is_some())
                    .min_by_key(|c| c.row.abs_diff(cell.row) * 128 + c.column.abs_diff(cell.column))
                    .and_then(|c| c.native)
            });
            out.push_str("<w:tc><w:tcPr>");
            if let Some(p) = template
                .and_then(|c| c.child("tcPr"))
                .and_then(|p| p.child("cnfStyle"))
            {
                out.push_str(&p.raw());
            }
            out.push_str(&format!(
                "<w:tcW w:w=\"{}\" w:type=\"dxa\"/>",
                grid[cell.column..cell.column + cell.columns]
                    .iter()
                    .sum::<u64>()
            ));
            if cell.columns > 1 {
                out.push_str(&format!("<w:gridSpan w:val=\"{}\"/>", cell.columns));
            }
            if cell.rows > 1 {
                out.push_str(if cell.row == r {
                    "<w:vMerge w:val=\"restart\"/>"
                } else {
                    "<w:vMerge/>"
                });
            }
            if let Some(pr) = template.and_then(|c| c.child("tcPr")) {
                for p in pr.elements().filter(|p| {
                    !matches!(
                        p.name.as_str(),
                        "tcW" | "gridSpan" | "hMerge" | "vMerge" | "cnfStyle"
                    )
                }) {
                    out.push_str(&p.raw());
                }
            }
            out.push_str("</w:tcPr>");
            if cell.row != r {
                out.push_str("<w:p/>");
            } else if let Some(source) = cell.native {
                let introduced_text = hcd_core::extract_html_text_nodes(&cell.html.raw())?
                    .iter()
                    .any(|(id, value)| !ordinals.contains_key(id.as_str()) && !value.is_empty());
                if introduced_text {
                    let body = source
                        .elements()
                        .filter(|element| element.name != "tcPr")
                        .collect::<Vec<_>>();
                    if !matches!(body.as_slice(), [paragraph] if paragraph.name == "p" && paragraph.elements().all(|element| element.name == "pPr"))
                    {
                        return Err(bad("The original cell contains content that cannot be replaced by newly entered text"));
                    }
                    out.push_str(&new_cell_text(cell.html, Some(source))?);
                } else {
                    for child in &source.children {
                        match child {
                            Xml::Element(e) if e.name != "tcPr" => {
                                out.push_str(&rewritten(e, updates)?)
                            }
                            Xml::Raw(s) => out.push_str(s),
                            _ => {}
                        }
                    }
                }
            } else {
                out.push_str(&new_cell_text(cell.html, template)?);
            }
            out.push_str("</w:tc>");
        }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl>");
    Ok(out)
}
fn css_twips(style: &str, key: &str) -> Option<u64> {
    let value = style
        .split(';')
        .filter_map(|s| s.split_once(':'))
        .find(|(k, _)| k.trim() == key)?
        .1
        .trim();
    let (number, scale) = if let Some(v) = value.strip_suffix("pt") {
        (v, 20.0)
    } else if let Some(v) = value.strip_suffix("px") {
        (v, 15.0)
    } else {
        return None;
    };
    let number = number.trim().parse::<f64>().ok()? * scale;
    (number.is_finite() && number > 0.0 && number < 2_000_000.0).then_some(number.round() as u64)
}
fn new_cell_text(html: &Element, template: Option<&Element>) -> Result<String, HcdError> {
    if html.descendant("a").is_some() {
        return Err(bad(
            "new cell hyperlinks require a native relationship rewrite",
        ));
    }
    let mut paragraphs = html
        .elements()
        .filter(|e| e.name == "p")
        .collect::<Vec<_>>();
    if paragraphs.is_empty() {
        paragraphs.push(html);
    }
    let mut result = String::new();
    for p in paragraphs {
        let texts = hcd_core::extract_html_text_nodes(&p.raw())?;
        let mut block = EditorBlockView {
            block_id: String::new(),
            block_hash: String::new(),
            region: "body".into(),
            read_only: false,
            editable_text_node_ids: vec![],
            content: hcd_core::EditorBlockContent {
                alignment: None,
                kind: EditorBlockKind::Paragraph,
                level: None,
                font: None,
                inlines: vec![],
            },
            read_only_html: None,
            presentation_html: None,
        };
        // DOM order, rather than hash-map key order, is the visible run order.
        fn visit(
            e: &Element,
            texts: &BTreeMap<String, String>,
            inlines: &mut Vec<hcd_core::EditorInline>,
        ) {
            if let Some(text) = e.attr("data-hcd-id").and_then(|id| texts.get(id)) {
                inlines.push(hcd_core::EditorInline {
                    format: Default::default(),
                    text: text.clone(),
                    node_id: None,
                    bold: false,
                    italic: false,
                    link: None,
                });
            } else {
                for c in e.elements() {
                    visit(c, texts, inlines);
                }
            }
        }
        visit(p, &texts, &mut block.content.inlines);
        result.push_str(&paragraph_from_block(&block, template));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        apply_structure_patch, editor_projection, project_editor, BlockPrecondition,
        StructureOperation, StructurePatchBatch, TableEditAction, HCD_PATCH_SCHEMA_VERSION_4,
    };
    fn edit(bundle: &Bundle, action: TableEditAction, index: usize) {
        let state = editor_projection(bundle, None).unwrap();
        let table = state
            .blocks
            .iter()
            .find(|b| {
                b.read_only_html
                    .as_deref()
                    .is_some_and(|h| h.starts_with("<table"))
            })
            .unwrap();
        apply_structure_patch(
            bundle,
            &StructurePatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION_4.into(),
                document_id: state.document_id,
                patch_id: format!("edit-{}", state.revision),
                base_revision: state.revision,
                operations: vec![StructureOperation::TableEdit {
                    block_id: table.block_id.clone(),
                    table_index: 0,
                    action,
                    index,
                    precondition: BlockPrecondition {
                        block_hash: table.block_hash.clone(),
                    },
                }],
            },
            state.revision,
        )
        .unwrap();
    }
    #[test]
    fn native_table_edits_keep_running_regions_source_parts_merges_and_new_text() {
        let temp = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hdoc/editor/e2e/fixtures/word-table-edit.docx");
        let root = temp.path().join("table.hcd");
        crate::import_docx(
            &source,
            &root,
            &crate::ImportOptions::new("native-table"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        project_editor(&bundle, 0).unwrap();
        for (action, index) in [
            (TableEditAction::InsertRow, 3),
            (TableEditAction::InsertColumn, 1),
            (TableEditAction::DeleteRow, 3),
            (TableEditAction::DeleteColumn, 1),
            (TableEditAction::InsertRow, 5),
        ] {
            edit(&bundle, action, index);
        }
        let state = editor_projection(&bundle, None).unwrap();
        let table = state
            .blocks
            .iter()
            .find(|b| b.read_only_html.is_some())
            .unwrap();
        let original = original_entries(&bundle).unwrap();
        let field = table
            .content
            .inlines
            .iter()
            .find(|i| {
                i.node_id
                    .as_ref()
                    .is_some_and(|id| !original.contains_key(id))
            })
            .unwrap();
        let id = field.node_id.clone().unwrap();
        let patch: hcd_core::PatchBatch=serde_json::from_value(serde_json::json!({"schemaVersion":"hcd-patch/1","documentId":"native-table","patchId":"new-cell-text","baseRevision":state.revision,"operations":[{"op":"text.splice","nodeId":id,"start":0,"deleteCount":0,"insertText":"新行 Unicode 🙂","precondition":{"nodeHash":hcd_core::hash_bytes(b"")}}]})).unwrap();
        hcd_core::apply_patch(&bundle, &patch, state.revision).unwrap();
        let output = temp.path().join("native.docx");
        validate_source_export(&bundle, &source, None).unwrap();
        let report = export_docx(&root, &source, &output, &ExportOptions::default()).unwrap();
        assert_eq!(report.level, FidelityLevel::High);
        let mut old = StreamingOxmlArchive::open(&source).unwrap();
        let mut new = StreamingOxmlArchive::open(&output).unwrap();
        let names = old
            .entries()
            .iter()
            .map(|e| e.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), new.entries().len());
        for name in &names {
            if name != "word/document.xml" {
                assert_eq!(
                    old.read_control_part(name, 64 * 1024 * 1024).unwrap(),
                    new.read_control_part(name, 64 * 1024 * 1024).unwrap(),
                    "source part {name} changed"
                );
            }
        }
        let bytes = new
            .read_control_part("word/document.xml", 64 * 1024 * 1024)
            .unwrap();
        let xml = String::from_utf8(bytes).unwrap();
        assert!(xml.contains("新行 Unicode 🙂"));
        assert!(xml.contains("<w:vMerge w:val=\"restart\"/>"));
        assert!(xml.contains("<w:vMerge/>"));
        let tree = parse(&xml).unwrap();
        let doc = tree
            .iter()
            .find_map(|n| {
                if let Xml::Element(e) = n {
                    Some(e)
                } else {
                    None
                }
            })
            .unwrap();
        let body = doc.child("body").unwrap();
        let table = body.child("tbl").unwrap();
        assert_eq!(rows(table).len(), 32);
        assert_eq!(table.child("tblGrid").unwrap().elements().count(), 2);
        let again = temp.path().join("roundtrip.hcd");
        crate::import_docx(
            &output,
            &again,
            &crate::ImportOptions::new("roundtrip"),
            |_| Ok(()),
        )
        .unwrap();
        let after = editor_projection(&Bundle::open(again).unwrap(), None).unwrap();
        let html = after
            .blocks
            .iter()
            .find_map(|b| b.read_only_html.as_ref())
            .unwrap();
        assert!(html.contains("新行 Unicode 🙂"));
        assert!(html.contains("rowspan=\"0000000002\""));
    }

    #[test]
    fn native_insert_delete_restore_tables_keep_section_widths_and_original_regions() {
        let temp = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hdoc/editor/e2e/fixtures/word-table-edit.docx");
        let root = temp.path().join("document.hcd");
        crate::import_docx(
            &source,
            &root,
            &crate::ImportOptions::new("native-insert"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&root).unwrap();
        project_editor(&bundle, 0).unwrap();
        let initial = editor_projection(&bundle, None).unwrap();
        let body = initial
            .blocks
            .iter()
            .filter(|b| b.region == "body")
            .collect::<Vec<_>>();
        let old_table = body
            .iter()
            .position(|b| {
                b.read_only_html
                    .as_deref()
                    .is_some_and(|h| h.starts_with("<table"))
            })
            .unwrap();
        let old_id = body[old_table].block_id.clone();
        let previous = body[old_table - 1].block_id.clone();
        let apply = |operation: serde_json::Value| {
            let state = editor_projection(&bundle, None).unwrap();
            let patch:StructurePatchBatch=serde_json::from_value(serde_json::json!({"schemaVersion":HCD_PATCH_SCHEMA_VERSION_4,"documentId":"native-insert","patchId":format!("table-op-{}",state.revision),"baseRevision":state.revision,"operations":[operation]})).unwrap();
            apply_structure_patch(&bundle, &patch, state.revision).unwrap();
        };
        apply(
            serde_json::json!({"op":"table.insert","afterBlockId":body[0].block_id,"rows":3,"columns":3}),
        );
        let state = editor_projection(&bundle, None).unwrap();
        let current = state.blocks.iter().find(|b| b.block_id == old_id).unwrap();
        apply(
            serde_json::json!({"op":"table.delete","blockId":old_id,"precondition":{"blockHash":current.block_hash}}),
        );
        let output = temp.path().join("deleted.docx");
        export_docx(&root, &source, &output, &ExportOptions::default()).unwrap();
        let mut archive = StreamingOxmlArchive::open(&output).unwrap();
        let xml = String::from_utf8(
            archive
                .read_control_part("word/document.xml", 64 * 1024 * 1024)
                .unwrap(),
        )
        .unwrap();
        let tree = parse(&xml).unwrap();
        let doc = tree
            .iter()
            .find_map(|n| {
                if let Xml::Element(e) = n {
                    Some(e)
                } else {
                    None
                }
            })
            .unwrap();
        let tables = doc
            .child("body")
            .unwrap()
            .elements()
            .filter(|e| e.name == "tbl")
            .collect::<Vec<_>>();
        assert_eq!(tables.len(), 1);
        assert_eq!(rows(tables[0]).len(), 3);
        let widths = tables[0]
            .child("tblGrid")
            .unwrap()
            .elements()
            .map(|e| e.attr("w").unwrap().parse::<u64>().unwrap())
            .sum::<u64>();
        assert_eq!(
            widths, 4800,
            "new table must fit the first section's 240pt content width"
        );
        apply(
            serde_json::json!({"op":"table.restore","blockId":old_id,"sourceRevision":initial.revision,"afterBlockId":previous,"precondition":{"blockHash":null}}),
        );
        let restored = temp.path().join("restored.docx");
        export_docx(&root, &source, &restored, &ExportOptions::default()).unwrap();
        let mut archive = StreamingOxmlArchive::open(restored).unwrap();
        let xml = String::from_utf8(
            archive
                .read_control_part("word/document.xml", 64 * 1024 * 1024)
                .unwrap(),
        )
        .unwrap();
        let tree = parse(&xml).unwrap();
        let doc = tree
            .iter()
            .find_map(|n| {
                if let Xml::Element(e) = n {
                    Some(e)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(
            doc.child("body")
                .unwrap()
                .elements()
                .filter(|e| e.name == "tbl")
                .count(),
            2
        );
    }
}
