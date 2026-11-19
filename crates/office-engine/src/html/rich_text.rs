//! Inline semantics shared by source-free Office and Markdown exports.
//! Offsets refer to normalized UTF-8 bytes in one explicit block/cell, never
//! to a text lookup: equal paragraphs can carry completely different styles.
use super::*;
use docx_handler::AddBatchItem;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct InlineStyle {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InlineSpan {
    pub start: usize,
    pub end: usize,
    pub style: InlineStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum InlineKey {
    Block(usize),
    Cell(usize, usize, usize),
}

pub(super) fn tag_style(
    parent: InlineStyle,
    tag: &Tag,
    warnings: &mut BTreeSet<String>,
) -> InlineStyle {
    let mut style = parent;
    match tag.name.as_str() {
        "b" | "strong" | "th" => style.bold = Some(true),
        "i" | "em" => style.italic = Some(true),
        _ => {}
    }
    let mut bold_important = false;
    let mut italic_important = false;
    if let Some(css) = tag.attributes.get("style") {
        for declaration in css.split(';').filter(|value| !value.trim().is_empty()) {
            let Some((property, raw)) = declaration.split_once(':') else {
                warnings.insert("inline CSS was ignored".to_string());
                continue;
            };
            let value = raw.trim().to_ascii_lowercase();
            let (value, important) = value
                .strip_suffix("!important")
                .map(|value| (value.trim(), true))
                .unwrap_or((&value, false));
            let property = property.trim().to_ascii_lowercase();
            let (slot, inherited, priority) = match property.as_str() {
                "font-weight" => (&mut style.bold, parent.bold, &mut bold_important),
                "font-style" => (&mut style.italic, parent.italic, &mut italic_important),
                _ => {
                    warnings.insert("inline CSS was ignored".to_string());
                    continue;
                }
            };
            let parsed = match value {
                "inherit" | "unset" => Some(inherited),
                "normal" | "initial" => Some(Some(false)),
                "bold" if property == "font-weight" => Some(Some(true)),
                "italic" | "oblique" if property == "font-style" => Some(Some(true)),
                _ if property == "font-weight" => value
                    .parse::<u16>()
                    .ok()
                    .filter(|weight| (1..=1000).contains(weight))
                    .map(|weight| Some(weight >= 600)),
                _ => None,
            };
            match parsed {
                Some(parsed) if important || !*priority => {
                    *slot = parsed;
                    *priority = important;
                }
                Some(_) => {}
                None => {
                    warnings.insert("inline CSS was ignored".to_string());
                }
            }
        }
    }
    style
}

pub(super) fn append(
    text: &mut String,
    spans: &mut Vec<InlineSpan>,
    value: &str,
    preserve: bool,
    style: InlineStyle,
) -> Result<(), HandlerError> {
    let start = text.len();
    append_normalized(text, value, preserve);
    if text.len() > MAX_BLOCK_BYTES {
        return Err(HandlerError::InvalidArgument(format!(
            "HTML text node exceeds {MAX_BLOCK_BYTES} bytes"
        )));
    }
    ensure_text_limit(&text[start..])?;
    if text.len() == start || style == InlineStyle::default() {
        return Ok(());
    }
    if let Some(last) = spans.last_mut() {
        if last.end == start && last.style == style {
            last.end = text.len();
            return Ok(());
        }
    }
    if spans.len() >= 65_536 {
        return Err(HandlerError::InvalidArgument(
            "HTML text exceeds 65,536 inline style spans".to_string(),
        ));
    }
    spans.push(InlineSpan {
        start,
        end: text.len(),
        style,
    });
    Ok(())
}

pub(super) fn trim_spans(spans: Vec<InlineSpan>, start: usize, end: usize) -> Vec<InlineSpan> {
    clip_spans(&spans, start, end)
}

fn clip_spans(spans: &[InlineSpan], start: usize, end: usize) -> Vec<InlineSpan> {
    let first = spans.partition_point(|span| span.end <= start);
    spans[first..]
        .iter()
        .take_while(|span| span.start < end)
        .filter_map(|span| {
            let left = span.start.max(start);
            let right = span.end.min(end);
            (right > left).then_some(InlineSpan {
                start: left.saturating_sub(start),
                end: right.saturating_sub(start),
                style: span.style,
            })
        })
        .collect()
}

pub(super) fn store_table_styles(
    document: &mut SemanticHtml,
    block: usize,
    cells: HashMap<(usize, usize), Vec<InlineSpan>>,
) {
    document.inline_styles.extend(
        cells
            .into_iter()
            .map(|((row, column), spans)| (InlineKey::Cell(block, row, column), spans)),
    );
}

pub(super) fn styles(document: &SemanticHtml, key: InlineKey) -> &[InlineSpan] {
    document
        .inline_styles
        .get(&key)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn links(document: &SemanticHtml, key: InlineKey) -> Vec<(usize, usize, &str)> {
    let mut links = match key {
        InlineKey::Block(index) => document
            .links
            .iter()
            .filter(|link| link.block_index == index)
            .map(|link| (link.start, link.end, link.target.as_str()))
            .collect::<Vec<_>>(),
        InlineKey::Cell(index, row, column) => document
            .table_links
            .iter()
            .filter(|link| (link.block_index, link.row, link.column) == (index, row, column))
            .map(|link| (link.start, link.end, link.target.as_str()))
            .collect::<Vec<_>>(),
    };
    links.sort_by_key(|&(start, end, _)| (start, end));
    links
}

#[derive(Debug)]
pub(super) struct Piece<'a> {
    pub text: &'a str,
    pub style: InlineStyle,
    pub target: Option<&'a str>,
}

pub(super) fn pieces<'a>(
    text: &'a str,
    styles: &[InlineSpan],
    links: &[(usize, usize, &'a str)],
) -> Vec<Piece<'a>> {
    let valid = |start: usize, end: usize| {
        start < end
            && end <= text.len()
            && text.is_char_boundary(start)
            && text.is_char_boundary(end)
    };
    let mut boundaries = vec![0, text.len()];
    for span in styles.iter().filter(|span| valid(span.start, span.end)) {
        boundaries.extend([span.start, span.end]);
    }
    for &(start, end, _) in links.iter().filter(|&&(start, end, _)| valid(start, end)) {
        boundaries.extend([start, end]);
    }
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut style_cursor = 0;
    let mut link_cursor = 0;
    boundaries
        .windows(2)
        .map(|window| {
            let (start, end) = (window[0], window[1]);
            while style_cursor < styles.len() && styles[style_cursor].end <= start {
                style_cursor += 1;
            }
            while link_cursor < links.len() && links[link_cursor].1 <= start {
                link_cursor += 1;
            }
            let style = styles
                .get(style_cursor)
                .filter(|span| {
                    valid(span.start, span.end) && span.start <= start && span.end >= end
                })
                .map(|span| span.style)
                .unwrap_or_default();
            let target = links
                .get(link_cursor)
                .filter(|&&(left, right, _)| valid(left, right) && left <= start && right >= end)
                .map(|&(_, _, target)| target);
            Piece {
                text: &text[start..end],
                style,
                target,
            }
        })
        .collect()
}

fn properties(style: InlineStyle) -> HashMap<String, String> {
    let mut properties = HashMap::new();
    if let Some(value) = style.bold {
        properties.insert("bold".to_string(), value.to_string());
    }
    if let Some(value) = style.italic {
        properties.insert("italic".to_string(), value.to_string());
    }
    properties
}

struct DocxWriter<'a> {
    handler: &'a WordHandler,
    pending: Vec<AddBatchItem>,
    paragraph: usize,
    table: usize,
}

impl DocxWriter<'_> {
    fn add(&mut self, parent: &str, kind: &str, properties: HashMap<String, String>) {
        self.pending.push(AddBatchItem {
            parent: parent.to_string(),
            element_type: kind.to_string(),
            position: InsertPosition::Append,
            properties,
            wrap: None,
        });
    }

    fn flush(&mut self) -> Result<(), HandlerError> {
        if !self.pending.is_empty() {
            for result in self.handler.add_batch(&self.pending)? {
                result.map_err(HandlerError::OperationFailed)?;
            }
            self.pending.clear();
        }
        Ok(())
    }

    fn paragraph(&mut self, properties: HashMap<String, String>) -> String {
        self.paragraph += 1;
        self.add("/body", "paragraph", properties);
        format!("/body/p[{}]", self.paragraph)
    }

    fn text(
        &mut self,
        parent: &str,
        text: &str,
        document: &SemanticHtml,
        key: InlineKey,
        code: bool,
    ) -> Result<(), HandlerError> {
        for piece in pieces(text, styles(document, key), &links(document, key)) {
            for (index, line) in piece.text.split('\n').enumerate() {
                if index > 0 {
                    self.add(parent, "break", HashMap::new());
                }
                for (tab, value) in line.split('\t').enumerate() {
                    if tab > 0 {
                        self.add(parent, "tab", HashMap::new());
                    }
                    if value.is_empty() {
                        continue;
                    }
                    let mut properties = properties(piece.style);
                    properties.insert("text".to_string(), value.to_string());
                    if code {
                        properties.insert("font".to_string(), "Consolas".to_string());
                    }
                    if let Some(target) = piece.target {
                        // Hyperlinks require a package relationship, which the
                        // generic DOM-only batch API does not register.
                        self.flush()?;
                        properties.insert("url".to_string(), target.to_string());
                        self.handler.add(
                            parent,
                            "hyperlink",
                            InsertPosition::Append,
                            &properties,
                            None,
                        )?;
                    } else {
                        self.add(parent, "run", properties);
                    }
                }
            }
        }
        Ok(())
    }
}

pub(super) fn export_docx(document: &SemanticHtml, package: &Path) -> Result<usize, HandlerError> {
    let output = package.to_string_lossy();
    super::super::create::create_blank_docx(&output)?;
    let handler = WordHandler::open(&output, true)?;
    handler.remove("/body/p[1]")?;
    let mut writer = DocxWriter {
        handler: &handler,
        pending: Vec::new(),
        paragraph: 0,
        table: 0,
    };
    let mut embedded = 0;
    for (index, block) in document.blocks.iter().enumerate() {
        if let Some(content) = document
            .word_block_ids
            .get(&index)
            .and_then(|id| document.word_formats.get(id))
        {
            writer.flush()?;
            append_typed_word_block(&handler, block, content)?;
            writer.paragraph += 1;
            continue;
        }
        if let HtmlBlock::Image {
            source,
            alt,
            geometry,
        } = block
        {
            if let Some(asset) = resolved_image(document, source, ImageTarget::Office) {
                // A standalone final paragraph keeps images outside table
                // cells. Give it an empty run so the part-aware image writer
                // can append before its closing tag (rather than <w:p/>).
                writer.paragraph(HashMap::from([("text".to_string(), String::new())]));
                writer.flush()?;
                let properties = HashMap::from([
                    ("src".to_string(), asset.path.to_string_lossy().into_owned()),
                    ("format".to_string(), asset.format.clone()),
                    ("alt".to_string(), alt.clone()),
                    ("width".to_string(), geometry.width().to_string()),
                    ("height".to_string(), geometry.height().to_string()),
                ]);
                handler.add("/body", "image", InsertPosition::Append, &properties, None)?;
                embedded += 1;
                continue;
            }
        }
        if let HtmlBlock::Table(rows) = block {
            let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
            if rows.is_empty() || columns == 0 {
                continue;
            }
            writer.table += 1;
            writer.add(
                "/body",
                "table",
                HashMap::from([
                    ("rows".to_string(), rows.len().to_string()),
                    ("cols".to_string(), columns.to_string()),
                ]),
            );
            for (row_index, row) in rows.iter().enumerate() {
                for (column, text) in row.iter().enumerate() {
                    let parent = format!(
                        "/body/tbl[{}]/tr[{}]/tc[{}]/p[1]",
                        writer.table,
                        row_index + 1,
                        column + 1
                    );
                    writer.text(
                        &parent,
                        text,
                        document,
                        InlineKey::Cell(index, row_index, column),
                        false,
                    )?;
                }
            }
            continue;
        }
        if matches!(block, HtmlBlock::SectionBreak) {
            continue;
        }
        let mut properties = HashMap::new();
        if let HtmlBlock::Heading { level, .. } = block {
            properties.insert("style".to_string(), format!("Heading{level}"));
        }
        let parent = writer.paragraph(properties);
        let text = match block {
            HtmlBlock::Heading { text, .. }
            | HtmlBlock::Paragraph(text)
            | HtmlBlock::Preformatted(text)
            | HtmlBlock::Quote(text)
            | HtmlBlock::ListItem { text, .. } => text.clone(),
            other => block_lines(other).join("\n"),
        };
        if let HtmlBlock::ListItem {
            ordered, ordinal, ..
        } = block
        {
            writer.add(
                &parent,
                "run",
                HashMap::from([(
                    "text".to_string(),
                    if *ordered {
                        format!("{ordinal}. ")
                    } else {
                        "• ".to_string()
                    },
                )]),
            );
        }
        writer.text(
            &parent,
            &text,
            document,
            InlineKey::Block(index),
            matches!(block, HtmlBlock::Preformatted(_)),
        )?;
    }
    writer.flush()?;
    handler.save()?;
    Ok(embedded)
}

pub(super) fn block_line_styles(document: &SemanticHtml, index: usize) -> Vec<Vec<InlineSpan>> {
    let block = &document.blocks[index];
    let spans = styles(document, InlineKey::Block(index));
    match block {
        HtmlBlock::Heading { text, .. }
        | HtmlBlock::Paragraph(text)
        | HtmlBlock::Preformatted(text)
        | HtmlBlock::Quote(text) => {
            let mut offset = 0;
            text.lines()
                .map(|line| {
                    let result = clip_spans(spans, offset, offset + line.len());
                    offset += line.len()
                        + if text.as_bytes().get(offset + line.len()) == Some(&b'\r') {
                            2
                        } else {
                            1
                        };
                    result
                })
                .collect()
        }
        HtmlBlock::ListItem {
            ordered, ordinal, ..
        } => {
            let prefix = if *ordered {
                format!("{ordinal}. ").len()
            } else {
                "• ".len()
            };
            vec![spans
                .iter()
                .map(|span| InlineSpan {
                    start: span.start + prefix,
                    end: span.end + prefix,
                    style: span.style,
                })
                .collect()]
        }
        other => block_lines(other).iter().map(|_| Vec::new()).collect(),
    }
}

fn xml_text(text: &str) -> Result<String, HandlerError> {
    let preserve = text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace);
    Ok(format!(
        "<t{}>{}</t>",
        if preserve {
            " xml:space=\"preserve\""
        } else {
            ""
        },
        escape_xml_text(text)?.replace('\r', "&#13;")
    ))
}

pub(super) fn xlsx_runs(text: &str, spans: &[InlineSpan]) -> Result<String, HandlerError> {
    if spans.is_empty() {
        return xml_text(text);
    }
    let mut output = String::new();
    for piece in pieces(text, spans, &[]) {
        output.push_str("<r><rPr>");
        if let Some(value) = piece.style.bold {
            output.push_str(&format!("<b val=\"{}\"/>", u8::from(value)));
        }
        if let Some(value) = piece.style.italic {
            output.push_str(&format!("<i val=\"{}\"/>", u8::from(value)));
        }
        output.push_str("</rPr>");
        output.push_str(&xml_text(piece.text)?);
        output.push_str("</r>");
    }
    Ok(output)
}

fn pptx_paragraph(text: &str, spans: &[InlineSpan]) -> Result<String, HandlerError> {
    let mut output = String::from("<a:p>");
    for piece in pieces(text, spans, &[]) {
        let mut attributes = String::from(" lang=\"en-US\" dirty=\"0\"");
        if let Some(value) = piece.style.bold {
            attributes.push_str(&format!(" b=\"{}\"", u8::from(value)));
        }
        if let Some(value) = piece.style.italic {
            attributes.push_str(&format!(" i=\"{}\"", u8::from(value)));
        }
        for (index, line) in piece.text.split('\n').enumerate() {
            if index > 0 {
                output.push_str("<a:br/>");
            }
            if !line.is_empty() {
                output.push_str(&format!(
                    "<a:r><a:rPr{attributes}/><a:t>{}</a:t></a:r>",
                    escape_xml_text(line)?
                ));
            }
        }
    }
    output.push_str("</a:p>");
    Ok(output)
}

/// Only the semantic writer's own generated slides reach this pass. L2 can
/// create the shape/table but cannot express independently styled native runs.
/// Row windows and line ordinals supply the mapping before font pinning.
pub(super) fn pin_pptx_inline(
    path: &Path,
    document: &SemanticHtml,
    slides: &[SemanticSlide],
) -> Result<(), HandlerError> {
    if document.inline_styles.is_empty() {
        return Ok(());
    }
    let mut package = oxml::OxmlPackage::open(&path.to_string_lossy(), true)
        .map_err(|error| HandlerError::OpenError(error.to_string()))?;
    for (index, slide) in slides.iter().enumerate() {
        let mut paragraphs = Vec::new();
        if let Some(window) = slide.table {
            let Some(HtmlBlock::Table(rows)) = document.blocks.get(window.block_index) else {
                continue;
            };
            let header = window.include_header.then_some(0);
            for row in header.into_iter().chain(window.row_start..window.row_end) {
                for column in window.column_start..window.column_end {
                    let text = rows
                        .get(row)
                        .and_then(|row| row.get(column))
                        .map(String::as_str)
                        .unwrap_or("");
                    paragraphs.push(pptx_paragraph(
                        text,
                        styles(document, InlineKey::Cell(window.block_index, row, column)),
                    )?);
                }
            }
        } else if slide.line_styles.iter().any(|spans| !spans.is_empty()) {
            for (line, spans) in slide.lines.iter().zip(&slide.line_styles) {
                paragraphs.push(pptx_paragraph(line, spans)?);
            }
        } else {
            continue;
        }
        let part = format!("ppt/slides/slide{}.xml", index + 1);
        let xml = package
            .read_part_xml(&part)
            .map_err(|error| HandlerError::OpenError(error.to_string()))?;
        let mut replacements = Vec::new();
        if slide.table.is_some() {
            let mut cursor = 0;
            for paragraph in paragraphs {
                let found = ElementScan::find(&xml, cursor, "a:p").ok_or_else(|| {
                    HandlerError::OperationFailed(
                        "generated PPTX table has fewer paragraphs than source cells".to_string(),
                    )
                })?;
                replacements.push((found.open..found.end, paragraph));
                cursor = found.end;
            }
            if ElementScan::find(&xml, cursor, "a:p").is_some() {
                return Err(HandlerError::OperationFailed(
                    "generated PPTX table has unexpected paragraphs".to_string(),
                ));
            }
        } else {
            let found = ElementScan::find(&xml, 0, "a:p").ok_or_else(|| {
                HandlerError::OperationFailed(
                    "generated PPTX content paragraph is missing".to_string(),
                )
            })?;
            if element_text(found.content(), "a:t") != slide.lines.join("\n") {
                return Err(HandlerError::OperationFailed(
                    "generated PPTX content does not match its source lines".to_string(),
                ));
            }
            replacements.push((found.open..found.end, paragraphs.join("")));
        }
        let mut updated = xml;
        for (range, value) in replacements.into_iter().rev() {
            updated.replace_range(range, &value);
        }
        package
            .write_part_xml(&part, &updated)
            .map_err(|error| HandlerError::SaveError(error.to_string()))?;
    }
    package
        .save()
        .map_err(|error| HandlerError::SaveError(error.to_string()))?;
    Ok(())
}

pub(super) fn markdown(
    text: &str,
    document: &SemanticHtml,
    key: InlineKey,
    plain: impl FnOnce() -> String,
) -> String {
    let spans = styles(document, key);
    if spans.is_empty() {
        return plain();
    }
    // Inline HTML is valid Markdown and avoids delimiter ambiguity at adjacent
    // bold/italic boundaries, spaces, literal asterisks and explicit normal.
    let mut output = String::new();
    let piece_links = links(document, key);
    let mut active_target = None;
    for piece in pieces(text, spans, &piece_links) {
        if active_target != piece.target {
            if let Some(target) = active_target {
                output.push_str(&format!("]({target})"));
            }
            if piece.target.is_some() {
                output.push('[');
            }
            active_target = piece.target;
        }
        let mut content = String::new();
        for character in piece.text.chars() {
            if "\\`*_{}[]<>#+-.!".contains(character) {
                content.push('\\');
            }
            if character == '\n' {
                content.push_str("<br/>");
            } else {
                content.push(character);
            }
        }
        let mut css = String::new();
        if piece.style.bold == Some(false) {
            css.push_str("font-weight:normal;");
        }
        if piece.style.italic == Some(false) {
            css.push_str("font-style:normal;");
        }
        if !css.is_empty() {
            content = format!("<span style=\"{css}\">{content}</span>");
        }
        if piece.style.italic == Some(true) {
            content = format!("<em>{content}</em>");
        }
        if piece.style.bold == Some(true) {
            content = format!("<strong>{content}</strong>");
        }
        output.push_str(&content);
    }
    if let Some(target) = active_target {
        output.push_str(&format!("]({target})"));
    }
    output
}

fn append_typed_word_block(
    handler: &WordHandler,
    block: &HtmlBlock,
    content: &hcd_core::EditorBlockContent,
) -> Result<(), HandlerError> {
    let mut paragraph = HashMap::new();
    if let Some(alignment) = content.alignment {
        let alignment = if alignment == hcd_core::EditorAlignment::Justify {
            "both"
        } else {
            alignment.css()
        };
        paragraph.insert("alignment".into(), alignment.into());
    }
    if let HtmlBlock::Heading { level, .. } = block {
        paragraph.insert("style".into(), format!("Heading{level}"));
    }
    let path = handler.add(
        "/body",
        "paragraph",
        InsertPosition::Append,
        &paragraph,
        None,
    )?;
    if let HtmlBlock::ListItem {
        ordered, ordinal, ..
    } = block
    {
        let prefix = if *ordered {
            format!("{ordinal}. ")
        } else {
            "• ".to_string()
        };
        handler.add(
            &path,
            "run",
            InsertPosition::Append,
            &HashMap::from([("text".into(), prefix)]),
            None,
        )?;
    }
    for inline in &content.inlines {
        if inline.text.is_empty() {
            continue;
        }
        let mut properties = HashMap::from([("text".into(), inline.text.clone())]);
        if inline.bold {
            properties.insert("bold".into(), "true".into());
        }
        if inline.italic {
            properties.insert("italic".into(), "true".into());
        }
        if inline.format.underline {
            properties.insert("underline".into(), "single".into());
        }
        if let Some(font) = &inline.format.font {
            properties.insert("font".into(), font.clone());
            properties.insert("font.eastAsia".into(), font.clone());
        }
        if let Some(size) = inline.format.size_half_points {
            properties.insert("size".into(), (f32::from(size) / 2.0).to_string());
        }
        if let Some(color) = &inline.format.color {
            properties.insert("color".into(), color.clone());
        }
        let kind = if let Some(link) = inline.link.as_ref().filter(|link| safe_link(link)) {
            properties.insert("url".into(), link.clone());
            "hyperlink"
        } else {
            "run"
        };
        handler.add(&path, kind, InsertPosition::Append, &properties, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIXED: &str = r#"<h2><em data-hcd-docx-inline="10" style="font-weight:bold;font-style:normal">同名😀</em><em data-hcd-docx-inline="01" style="font-weight:normal;font-style:italic"> tail</em><span style="font-weight:normal;font-style:normal"> plain</span></h2><p><i>同名😀</i> tail plain</p>"#;

    fn native_runs(xml: &str, prefix: &str) -> Vec<(String, Option<bool>, Option<bool>)> {
        let (run, text) = (format!("{prefix}r"), format!("{prefix}t"));
        let mut result = Vec::new();
        let mut cursor = 0;
        while let Some(found) = ElementScan::find(xml, cursor, &run) {
            cursor = found.end;
            let value = element_text(found.content(), &text);
            let flag = |name: &str| {
                if prefix == "a:" {
                    let props = ElementScan::find(found.content(), 0, "a:rPr")?;
                    parse_tag(props.tag().trim_matches(['<', '>']))?
                        .attributes
                        .get(name)
                        .map(|value| value != "0" && value != "false")
                } else {
                    let name = format!("{prefix}{name}");
                    let flag = ElementScan::find(found.content(), 0, &name)?;
                    let tag = parse_tag(flag.tag().trim_matches(['<', '>']))?;
                    let value = tag.attributes.get(&format!("{prefix}val"));
                    Some(!value.is_some_and(|value| value == "0" || value == "false"))
                }
            };
            result.push((value, flag("b"), flag("i")));
        }
        result
    }

    fn imported_html(path: &Path, root: &Path) -> String {
        hcd_formats::import_document(
            path,
            root,
            &hcd_formats::ImportOptions::new("inline-test"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = hcd_core::Bundle::open(root).unwrap();
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{report:?}");
        let manifest = bundle.manifest().unwrap();
        (0..manifest.index_page_count)
            .flat_map(|page| bundle.read_index_page(&manifest, page).unwrap().chunks)
            .map(|chunk| bundle.read_chunk_verified(&chunk).unwrap())
            .collect()
    }

    #[test]
    fn native_exports_keep_mixed_unicode_styles_without_matching_equal_text() {
        let document = parse_html(MIXED).unwrap();
        let root = tempfile::tempdir().unwrap();
        let expected = vec![
            ("同名😀".to_string(), Some(true), Some(false)),
            (" tail".to_string(), Some(false), Some(true)),
            (" plain".to_string(), Some(false), Some(false)),
            ("同名😀".to_string(), None, Some(true)),
            (" tail plain".to_string(), None, None),
        ];
        for (format, part, prefix) in [
            ("docx", "word/document.xml", "w:"),
            ("xlsx", "xl/worksheets/sheet1.xml", ""),
            ("pptx", "ppt/slides/slide1.xml", "a:"),
        ] {
            let output = root.path().join(format!("mixed.{format}"));
            let mut pinning = SemanticFontPinning::default();
            match format {
                "docx" => super::super::export_docx(&document, &output, &mut pinning).unwrap(),
                "xlsx" => export_xlsx(&document, &output).unwrap(),
                _ => export_pptx(&document, &output, &mut pinning).unwrap(),
            };
            validate_output(&output, format).unwrap();
            let package = oxml::OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
            let xml = package.read_part_xml(part).unwrap();
            assert_eq!(native_runs(&xml, prefix), expected, "{format}: {xml}");
            let html = imported_html(&output, &root.path().join(format!("{format}.hcd")));
            let texts = hcd_core::extract_html_text_nodes(&html).unwrap();
            assert_eq!(
                texts
                    .values()
                    .filter(|value| value.contains("同名😀"))
                    .count(),
                2,
                "{format}: {texts:?}"
            );
        }
    }

    #[test]
    fn docx_literal_text_breaks_and_link_relationships_survive_native_roundtrip() {
        let document = parse_html(&r#"<p># literal **stars** | 😀<br>next <a href="https://example.com/?a=1&amp;b=2"><strong>中文</strong><i> link</i></a> tail</p><pre>A\tB
C &lt;D&gt;</pre><table><tr><td>plain</td><td><a href="https://example.com/cell"><b>格😀</b> tail</a></td></tr></table>"#.replace("\\t", "\t")).unwrap();
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("links.docx");
        super::export_docx(&document, &output).unwrap();
        validate_output(&output, "docx").unwrap();
        let handler = WordHandler::open(&output.to_string_lossy(), false).unwrap();
        let text = handler
            .view_as_text(handler_common::ViewOptions::default())
            .unwrap();
        assert!(text.contains("# literal **stars** | 😀"), "{text}");
        assert!(text.contains("中文 link tail"), "{text}");
        assert!(text.contains("格😀 tail"), "{text}");
        assert!(!text.contains("](https"), "{text}");
        let package = oxml::OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        assert!(xml.contains("<w:br"), "{xml}");
        assert!(xml.contains("<w:tab"), "{xml}");
        let rels = package
            .read_part_xml("word/_rels/document.xml.rels")
            .unwrap();
        assert!(rels.contains("https://example.com/?a=1&amp;b=2"), "{rels}");
        assert!(rels.contains("https://example.com/cell"), "{rels}");
        let mut cursor = 0;
        while let Some(link) = ElementScan::find(&xml, cursor, "w:hyperlink") {
            cursor = link.end;
            let tag = parse_tag(link.tag().trim_matches(['<', '>'])).unwrap();
            let id = &tag.attributes["r:id"];
            assert!(rels.contains(&format!("Id=\"{id}\"")), "{xml}\n{rels}");
        }
        imported_html(&output, &root.path().join("links.hcd"));
    }

    #[test]
    fn markdown_mixed_styles_reimport_as_rendered_text_and_balanced_safe_tags() {
        let root = tempfile::tempdir().unwrap();
        let mut document = parse_html(&format!("{MIXED}<p><b>line</b><br>break</p>")).unwrap();
        document.links.push(SemanticLink {
            block_index: 0,
            start: 0,
            end: "同名😀 tail".len(),
            target: "https://example.com".to_string(),
        });
        let output = root.path().join("mixed.md");
        export_textual(&document, &output, true).unwrap();
        let html = imported_html(&output, &root.path().join("markdown.hcd"));
        assert!(!html.contains("hcd-markdown-raw-html"), "{html}");
        let roundtrip = parse_html(&html).unwrap();
        assert_eq!(roundtrip.blocks, document.blocks);
        for index in 0..2 {
            assert_eq!(
                pieces(
                    "同名😀 tail plain",
                    styles(&roundtrip, InlineKey::Block(index)),
                    &[]
                )
                .iter()
                .map(|piece| (piece.text, piece.style))
                .collect::<Vec<_>>(),
                pieces(
                    "同名😀 tail plain",
                    styles(&document, InlineKey::Block(index)),
                    &[]
                )
                .iter()
                .map(|piece| (piece.text, piece.style))
                .collect::<Vec<_>>()
            );
        }
        let unsafe_md = root.path().join("unbalanced.md");
        std::fs::write(&unsafe_md, "</span> <strong onclick=\"bad()\">raw</strong> <span style=\"font-weight:normal;\">one\n\nSecond\n").unwrap();
        let html = imported_html(&unsafe_md, &root.path().join("unbalanced.hcd"));
        assert!(html.contains("&lt;/span&gt;"), "{html}");
        assert!(!html.contains("<strong onclick"), "{html}");
        assert!(html.contains("</span></p><p"), "{html}");
    }

    #[test]
    fn table_fragments_and_sparse_cells_keep_trimmed_styles_and_links() {
        let html = r#"<table data-hcd-table-node-id="n_0123456789abcdef0123456789abcdef" data-hcd-table-fragment="0" data-hcd-row-start="1" data-hcd-row-end="1" data-hcd-fragment-row-count="1" data-hcd-column-count="1"><tr><td> <b>同文😀</b> </td></tr></table><table data-hcd-table-node-id="n_0123456789abcdef0123456789abcdef" data-hcd-table-fragment="1" data-hcd-row-start="2" data-hcd-row-end="2" data-hcd-fragment-row-count="1" data-hcd-column-count="1" data-hcd-table-continuation="true" data-hcd-table-final="true" data-hcd-row-count="2"><tr><td><i>同文😀</i></td></tr></table><table class="hcd-grid"><tr data-hcd-row="3"><td data-hcd-column="4">  <a href="https://example.com"><b>同文😀</b></a>  </td></tr></table>"#;
        let document = parse_html(html).unwrap();
        let text = "同文😀";
        assert_eq!(
            pieces(text, styles(&document, InlineKey::Cell(0, 0, 0)), &[])[0]
                .style
                .bold,
            Some(true)
        );
        assert_eq!(
            pieces(text, styles(&document, InlineKey::Cell(0, 1, 0)), &[])[0]
                .style
                .italic,
            Some(true)
        );
        assert_eq!(
            pieces(text, styles(&document, InlineKey::Cell(1, 2, 3)), &[])[0]
                .style
                .bold,
            Some(true)
        );
        assert_eq!(
            links(&document, InlineKey::Cell(1, 2, 3)),
            vec![(0, text.len(), "https://example.com")]
        );
        let root = tempfile::tempdir().unwrap();
        let xlsx = root.path().join("sparse.xlsx");
        export_xlsx(&document, &xlsx).unwrap();
        let handler = ExcelHandler::open(&xlsx.to_string_lossy(), false).unwrap();
        assert_eq!(
            handler.get("/Sheet1/D5", 0).unwrap().text.as_deref(),
            Some(text)
        );
        let mut pinning = SemanticFontPinning::default();
        let docx = root.path().join("tables.docx");
        super::super::export_docx(&document, &docx, &mut pinning).unwrap();
        imported_html(&docx, &root.path().join("tables.hcd"));
    }

    #[test]
    fn pptx_windowed_tables_apply_styles_by_source_cell_and_repeat_the_header() {
        let mut source = String::from("<table>");
        for row in 0..20 {
            source.push_str("<tr>");
            for column in 0..13 {
                source.push_str(if row == 0 {
                    "<th>同文😀</th>"
                } else if row == 19 && column == 12 {
                    "<td><i>同文😀</i></td>"
                } else {
                    "<td>同文😀</td>"
                });
            }
            source.push_str("</tr>");
        }
        source.push_str("</table>");
        let document = parse_html(&source).unwrap();
        let slides = semantic_slides(&document);
        assert_eq!(slides.len(), 4);
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("window.pptx");
        export_pptx(&document, &output, &mut SemanticFontPinning::default()).unwrap();
        let package = oxml::OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        for (index, slide) in slides.iter().enumerate() {
            let window = slide.table.unwrap();
            let xml = package
                .read_part_xml(&format!("ppt/slides/slide{}.xml", index + 1))
                .unwrap();
            let native = native_runs(&xml, "a:");
            let columns = window.column_end - window.column_start;
            for (cell, (_, bold, italic)) in native.iter().enumerate() {
                assert_eq!(
                    *bold,
                    (cell < columns).then_some(true),
                    "slide {index} cell {cell}"
                );
                let source_row = if cell < columns {
                    0
                } else {
                    window.row_start + cell / columns - 1
                };
                let source_column = window.column_start + cell % columns;
                assert_eq!(
                    *italic,
                    (source_row == 19 && source_column == 12).then_some(true),
                    "slide {index} cell {cell}"
                );
            }
        }
        imported_html(&output, &root.path().join("window.hcd"));
    }
    #[test]
    fn docx_images_remain_standalone_between_rich_paragraphs_and_tables() {
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("pixel.png");
        image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 128, 255, 255]))
            .save(&image)
            .unwrap();
        let mut document = parse_html(r#"<img src="asset://pixel"/><p><b>first</b></p><table><tr><td>cell</td></tr></table><img src="asset://pixel"/><p><i>last</i></p><img src="asset://pixel"/>"#).unwrap();
        document.assets.insert(
            "asset://pixel".to_string(),
            SemanticAsset {
                path: image,
                format: "png".to_string(),
            },
        );
        let output = root.path().join("images.docx");
        assert_eq!(super::export_docx(&document, &output).unwrap(), 3);
        validate_output(&output, "docx").unwrap();
        let package = oxml::OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        let table = ElementScan::find(&xml, 0, "w:tbl").unwrap();
        assert!(!table.content().contains("<w:drawing"), "{xml}");
        let mut cursor = 0;
        let mut order = Vec::new();
        while let Some(paragraph) = ElementScan::find(&xml, cursor, "w:p") {
            cursor = paragraph.end;
            order.push(if paragraph.content().contains("<w:drawing") {
                "IMAGE".to_string()
            } else {
                element_text(paragraph.content(), "w:t")
            });
        }
        assert_eq!(order, ["IMAGE", "first", "cell", "IMAGE", "last", "IMAGE"]);
        imported_html(&output, &root.path().join("images.hcd"));
    }

    #[test]
    fn inherited_normal_and_important_css_are_scoped_and_bounded() {
        let document = parse_html(r#"<div style="font-weight:700!important;font-weight:normal;font-style:italic"><p>外 <b style="font-weight:normal;font-style:initial">内😀</b> 尾</p></div><p>正常</p>"#).unwrap();
        let first = &document.blocks[0];
        assert_eq!(first, &HtmlBlock::Paragraph("外 内😀 尾".to_string()));
        let runs = pieces("外 内😀 尾", styles(&document, InlineKey::Block(0)), &[]);
        assert_eq!(
            runs[0].style,
            InlineStyle {
                bold: Some(true),
                italic: Some(true)
            }
        );
        assert_eq!(
            runs[1].style,
            InlineStyle {
                bold: Some(false),
                italic: Some(false)
            }
        );
        assert_eq!(runs[2].style, runs[0].style);
        assert!(styles(&document, InlineKey::Block(1)).is_empty());
        let overdeep = format!("{}x{}", "<b>".repeat(513), "</b>".repeat(513));
        assert!(parse_html(&overdeep).is_err());
        let overfragmented = format!("<p>{}</p>", "<b>x</b><i>y</i>".repeat(32_769));
        assert!(parse_html(&overfragmented).is_err());
    }
}
