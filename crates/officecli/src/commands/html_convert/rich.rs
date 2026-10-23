use super::*;
use docx_handler::{RichBlock, RichBorder, RichFont, RichParagraph, RichRun};
use hcd_core::TextTypography;
use std::sync::Arc;

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct RunStyle {
    pub font: TextTypography,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    code: bool,
    color: Option<String>,
    background: Option<String>,
    border: Option<RichBorder>,
    pub preserve: bool,
}
#[derive(Clone, Debug)]
pub(super) struct StyleRange {
    pub start: usize,
    pub end: usize,
    pub style: Arc<RunStyle>,
}
#[derive(Clone, Debug)]
pub(super) struct BlockStyle {
    pub block_index: usize,
    pub range: StyleRange,
}
#[derive(Clone, Debug)]
pub(super) struct TableStyle {
    pub row: usize,
    pub column: usize,
    pub range: StyleRange,
}
#[derive(Clone, Debug)]
pub(super) struct TableBlockStyle {
    pub block_index: usize,
    pub style: TableStyle,
}

pub(super) fn record(
    ranges: &mut Vec<StyleRange>,
    start: usize,
    end: usize,
    style: &Arc<RunStyle>,
) {
    if start == end || **style == RunStyle::default() {
        return;
    }
    if let Some(last) = ranges
        .last_mut()
        .filter(|last| last.end == start && last.style == *style)
    {
        last.end = end;
    } else {
        ranges.push(StyleRange {
            start,
            end,
            style: style.clone(),
        });
    }
}

pub(super) fn trimmed_range(mut range: StyleRange, start: usize, end: usize) -> Option<StyleRange> {
    range.start = range.start.max(start);
    range.end = range.end.min(end);
    if range.end <= range.start {
        return None;
    }
    range.start -= start;
    range.end -= start;
    Some(range)
}

impl HtmlParser {
    pub(super) fn current_style(&self) -> Arc<RunStyle> {
        self.text_styles
            .last()
            .map(|(_, style)| style.clone())
            .unwrap_or_default()
    }
    pub(super) fn enter_style(&mut self, tag: &Tag) -> Result<(), HandlerError> {
        if self.text_styles.len() >= 128 {
            return Err(HandlerError::InvalidArgument(
                "HTML text style nesting exceeds 128".into(),
            ));
        }
        let parent = self.current_style();
        let mut style = (*parent).clone();
        match tag.name.as_str() {
            "strong" | "b" => style.bold = true,
            "em" | "i" => style.italic = true,
            "u" => style.underline = true,
            "s" | "del" | "strike" => style.strike = true,
            "code" => style.code = true,
            "pre" => style.preserve = true,
            _ => {}
        }
        let mut declarations = HashMap::new();
        for declaration in simplecss::DeclarationTokenizer::from(
            tag.attributes
                .get("style")
                .map(String::as_str)
                .unwrap_or(""),
        ) {
            if declarations
                .get(declaration.name)
                .is_none_or(|(important, _)| !important || declaration.important)
            {
                declarations.insert(declaration.name, (declaration.important, declaration.value));
            }
        }
        if matches!(
            tag.name.as_str(),
            "span" | "strong" | "em" | "b" | "i" | "u" | "s" | "code"
        ) {
            let common = declarations.get("border").or_else(|| {
                let top = declarations.get("border-top")?;
                ["border-right", "border-bottom", "border-left"]
                    .iter()
                    .all(|side| declarations.get(side) == Some(top))
                    .then_some(top)
            });
            if let Some((_, value)) = common {
                let parts: Vec<_> = value.split_whitespace().collect();
                if parts.len() == 3
                    && hex_color(parts[2])
                    && matches!(parts[1], "solid" | "dashed" | "dotted" | "double")
                {
                    if let Some(width_pt) = points(parts[0], 1.0).filter(|width| *width <= 12.0) {
                        style.border = Some(RichBorder {
                            width_pt,
                            style: parts[1].into(),
                            color: parts[2].into(),
                        });
                    }
                }
            }
        }
        for (name, (_, value)) in declarations {
            let value = value.trim();
            match name {
                "font-family" if !matches!(value, "inherit" | "unset") => {
                    style.font.family =
                        Some(if value == "initial" { "serif" } else { value }.into())
                }
                "font-size" => {
                    if let Some(size) = points(value, parent.font.size_pt.unwrap_or(12.0)) {
                        style.font.size_pt = Some(size);
                    } else if !matches!(value, "inherit" | "unset") {
                        self.document.warnings.insert("an unsupported inline font size was not reproduced by semantic text export".into());
                    }
                }
                "font-weight" if !matches!(value, "inherit" | "unset") => {
                    style.bold = value.eq_ignore_ascii_case("bold")
                        || value.parse::<u16>().is_ok_and(|weight| weight >= 600)
                }
                "font-style" if !matches!(value, "inherit" | "unset") => {
                    style.italic = matches!(value, "italic" | "oblique")
                }
                "text-decoration" | "text-decoration-line" => {
                    style.underline = value.contains("underline");
                    style.strike = value.contains("line-through");
                }
                "color" if hex_color(value) => style.color = Some(value.into()),
                "background-color" if hex_color(value) => style.background = Some(value.into()),
                "white-space" => {
                    style.preserve = matches!(value, "pre" | "pre-wrap" | "break-spaces")
                }
                _ => {}
            }
        }
        if let Some(json) = tag.attributes.get("data-hcd-export-typography") {
            style.font = serde_json::from_str(json).map_err(|error| {
                HandlerError::InvalidArgument(format!("export typography: {error}"))
            })?;
        }
        for (attribute, field) in [
            ("data-hcd-font-latin", &mut style.font.latin),
            ("data-hcd-font-east-asia", &mut style.font.east_asia),
            ("data-hcd-font-bidi", &mut style.font.bidi),
        ] {
            if let Some(value) = tag.attributes.get(attribute) {
                *field = Some(value.clone());
            }
        }
        style
            .font
            .validate()
            .map_err(|error| HandlerError::InvalidArgument(error.to_string()))?;
        if tag.attributes.contains_key("data-hcd-node-hash") {
            style.preserve = true;
        }
        let style = if style == *parent {
            parent
        } else {
            Arc::new(style)
        };
        self.text_styles.push((tag.name.clone(), style));
        Ok(())
    }
    pub(super) fn leave_style(&mut self, name: &str) {
        if let Some(position) = self.text_styles.iter().rposition(|(tag, _)| tag == name) {
            self.text_styles.truncate(position);
        }
    }
}

fn hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn points(value: &str, parent: f32) -> Option<f32> {
    let (number, scale) = if let Some(n) = value.strip_suffix("rem") {
        (n, 12.0)
    } else if let Some(n) = value.strip_suffix("em") {
        (n, parent)
    } else if let Some(n) = value.strip_suffix('%') {
        (n, parent / 100.0)
    } else if let Some(n) = value.strip_suffix("px") {
        (n, 0.75)
    } else if let Some(n) = value.strip_suffix("pt") {
        (n, 1.0)
    } else {
        return None;
    };
    number
        .trim()
        .parse::<f32>()
        .ok()
        .map(|size| size * scale)
        .filter(|size| size.is_finite() && *size > 0.0 && *size <= 4096.0)
}

fn first_family(stack: &str) -> String {
    let mut quote = None;
    let end = stack
        .char_indices()
        .find_map(|(offset, character)| {
            if let Some(current) = quote {
                if character == current {
                    quote = None;
                }
            } else if character == '\'' || character == '"' {
                quote = Some(character);
            } else if character == ',' {
                return Some(offset);
            }
            None
        })
        .unwrap_or(stack.len());
    let name = stack[..end].trim().trim_matches(['\'', '"']);
    match name {
        "serif" => "Times New Roman",
        "sans-serif" | "system-ui" | "-apple-system" => "Arial",
        "monospace" => "Consolas",
        _ => name,
    }
    .into()
}

fn rich_runs(
    text: &str,
    styles: &[&StyleRange],
    links: &[(usize, usize, &str)],
    code: bool,
    header: bool,
) -> Result<Vec<RichRun>, HandlerError> {
    let mut boundaries = BTreeSet::from([0, text.len()]);
    for range in styles {
        boundaries.extend([range.start, range.end]);
    }
    for (start, end, _) in links {
        boundaries.extend([*start, *end]);
    }
    let boundaries: Vec<_> = boundaries.into_iter().collect();
    if boundaries
        .iter()
        .any(|offset| *offset > text.len() || !text.is_char_boundary(*offset))
    {
        return Err(HandlerError::InvalidArgument(
            "semantic text style range does not align with UTF-8 text".into(),
        ));
    }
    let mut result = Vec::new();
    let mut style_index = 0;
    let mut link_index = 0;
    for pair in boundaries.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        while style_index < styles.len() && styles[style_index].end <= start {
            style_index += 1;
        }
        while link_index < links.len() && links[link_index].1 <= start {
            link_index += 1;
        }
        let default = RunStyle::default();
        let style = styles
            .get(style_index)
            .filter(|range| range.start <= start && end <= range.end)
            .map(|range| range.style.as_ref())
            .unwrap_or(&default);
        let mut properties = HashMap::new();
        for (name, enabled) in [
            ("bold", style.bold || header),
            ("italic", style.italic),
            ("strike", style.strike),
        ] {
            if enabled {
                properties.insert(name.into(), "true".into());
            }
        }
        if style.underline {
            properties.insert("underline".into(), "single".into());
        }
        if let Some(value) = &style.color {
            properties.insert("color".into(), value.clone());
        }
        if let Some(value) = &style.background {
            properties.insert("bgColor".into(), value.clone());
        }
        let primary = style
            .font
            .family
            .as_deref()
            .map(first_family)
            .or_else(|| (code || style.code).then(|| "Consolas".into()));
        result.push(RichRun {
            text: text[start..end].into(),
            properties,
            border: style.border.clone(),
            font: RichFont {
                latin: style.font.latin.clone().or_else(|| primary.clone()),
                east_asia: style.font.east_asia.clone().or_else(|| primary.clone()),
                bidi: style.font.bidi.clone().or(primary),
                size_pt: style.font.size_pt,
            },
            hyperlink: links
                .get(link_index)
                .filter(|(from, to, _)| *from <= start && end <= *to)
                .map(|(_, _, target)| target.to_string()),
        });
    }
    Ok(result)
}

pub(super) fn export_docx(document: &SemanticHtml, output: &Path) -> Result<usize, HandlerError> {
    let output = output.to_string_lossy();
    super::super::create::create_blank_docx(&output)?;
    let handler = WordHandler::open(&output, true)?;
    handler.remove("/body/p[1]")?;
    let mut styles = HashMap::<usize, Vec<&StyleRange>>::new();
    for item in &document.styles {
        styles
            .entry(item.block_index)
            .or_default()
            .push(&item.range);
    }
    let mut table_styles = HashMap::<(usize, usize, usize), Vec<&StyleRange>>::new();
    for item in &document.table_styles {
        let cell = &item.style;
        table_styles
            .entry((item.block_index, cell.row, cell.column))
            .or_default()
            .push(&cell.range);
    }
    let mut links = HashMap::<usize, Vec<(usize, usize, &str)>>::new();
    for item in &document.links {
        links
            .entry(item.block_index)
            .or_default()
            .push((item.start, item.end, &item.target));
    }
    let mut table_links = HashMap::<(usize, usize, usize), Vec<(usize, usize, &str)>>::new();
    for item in &document.table_links {
        table_links
            .entry((item.block_index, item.row, item.column))
            .or_default()
            .push((item.start, item.end, &item.target));
    }
    for links in links.values_mut().chain(table_links.values_mut()) {
        links.sort_by_key(|link| (link.0, link.1));
    }
    let mut pending = Vec::new();
    let mut embedded = 0;
    for (index, block) in document.blocks.iter().enumerate() {
        let empty = Vec::new();
        let block_styles = styles.get(&index).unwrap_or(&empty);
        let no_links = Vec::new();
        let block_links = links.get(&index).unwrap_or(&no_links);
        let mut paragraph = RichParagraph::default();
        let (text, code) = match block {
            HtmlBlock::Heading { level, text } => {
                paragraph
                    .properties
                    .insert("style".into(), format!("Heading{level}"));
                (text.as_str(), false)
            }
            HtmlBlock::Paragraph(text) => (text.as_str(), false),
            HtmlBlock::ListItem {
                ordered,
                ordinal,
                text,
            } => {
                paragraph.runs.push(RichRun {
                    text: if *ordered {
                        format!("{ordinal}. ")
                    } else {
                        "• ".into()
                    },
                    ..Default::default()
                });
                (text.as_str(), false)
            }
            HtmlBlock::Preformatted(text) => (text.as_str(), true),
            HtmlBlock::Quote(text) => {
                paragraph.properties.insert("style".into(), "Quote".into());
                (text.as_str(), false)
            }
            HtmlBlock::Rule => ("────────────────────", false),
            HtmlBlock::SectionBreak => {
                pending.push(RichBlock::PageBreak);
                continue;
            }
            HtmlBlock::Table(rows) => {
                let mut output_rows = Vec::new();
                for (row_index, row) in rows.iter().enumerate() {
                    let mut cells = Vec::new();
                    for (column, cell) in row.iter().enumerate() {
                        let key = (index, row_index, column);
                        cells.push(RichParagraph {
                            properties: HashMap::new(),
                            runs: rich_runs(
                                cell,
                                table_styles.get(&key).unwrap_or(&empty),
                                table_links.get(&key).unwrap_or(&no_links),
                                false,
                                row_index == 0,
                            )?,
                        });
                    }
                    output_rows.push(cells);
                }
                pending.push(RichBlock::Table(output_rows));
                continue;
            }
            HtmlBlock::Image {
                source,
                alt,
                geometry,
            } => {
                if let Some(asset) = resolved_image(document, source, ImageTarget::Office) {
                    handler.append_rich_blocks(&pending)?;
                    pending.clear();
                    let properties = HashMap::from([
                        ("src".into(), asset.path.to_string_lossy().into_owned()),
                        ("format".into(), asset.format.clone()),
                        ("alt".into(), alt.clone()),
                        ("width".into(), geometry.width().to_string()),
                        ("height".into(), geometry.height().to_string()),
                    ]);
                    handler.add("/body", "image", InsertPosition::Append, &properties, None)?;
                    embedded += 1;
                } else {
                    pending.push(RichBlock::Paragraph(RichParagraph {
                        runs: vec![RichRun {
                            text: format!("[Image: {alt}]"),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }));
                }
                continue;
            }
        };
        paragraph
            .runs
            .extend(rich_runs(text, block_styles, block_links, code, false)?);
        pending.push(RichBlock::Paragraph(paragraph));
    }
    handler.append_rich_blocks(&pending)?;
    handler.save()?;
    Ok(embedded)
}

#[cfg(test)]
mod tests {
    use super::*;
    const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    fn xml(document: &SemanticHtml) -> (String, String) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rich.docx");
        export_docx(document, &path).unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        (
            package.read_part_xml("word/document.xml").unwrap(),
            package
                .read_part_xml("word/_rels/document.xml.rels")
                .unwrap(),
        )
    }
    #[test]
    fn mixed_fonts_sizes_marks_links_and_canonical_spaces_reach_native_runs() {
        let document = parse_html(r##"<p><strong><span style="font-family:Arial;font-size:14pt;color:#123456" data-hcd-node-hash="x" data-hcd-font-east-asia="宋体"> A  中😀 </span></strong><a href="https://example.com/?a=1&amp;b=2"><em><span style="font-family:'Times New Roman';font-size:20.5pt;background-color:#ffff00" data-hcd-node-hash="y">linked</span></em></a><u><s>end</s></u></p><pre><span data-hcd-node-hash="z" style="font-size:11pt">line1
	line2</span></pre>"##).unwrap();
        let (xml, rels) = xml(&document);
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let run_for = |text| {
            parsed
                .descendants()
                .find(|node| {
                    node.has_tag_name((W, "r"))
                        && node
                            .descendants()
                            .any(|child| child.has_tag_name((W, "t")) && child.text() == Some(text))
                })
                .unwrap()
        };
        let first = run_for(" A  中😀 ");
        assert!(first.descendants().any(|node| node.has_tag_name((W, "b"))));
        let fonts = first
            .descendants()
            .find(|node| node.has_tag_name((W, "rFonts")))
            .unwrap();
        assert_eq!(fonts.attribute((W, "ascii")), Some("Arial"));
        assert_eq!(fonts.attribute((W, "eastAsia")), Some("宋体"));
        assert_eq!(
            first
                .descendants()
                .find(|node| node.has_tag_name((W, "sz")))
                .unwrap()
                .attribute((W, "val")),
            Some("28")
        );
        let linked = run_for("linked");
        assert_eq!(
            linked.parent_element().unwrap().tag_name().name(),
            "hyperlink"
        );
        assert!(linked.descendants().any(|node| node.has_tag_name((W, "i"))));
        assert_eq!(
            linked
                .descendants()
                .find(|node| node.has_tag_name((W, "sz")))
                .unwrap()
                .attribute((W, "val")),
            Some("41")
        );
        assert!(linked
            .descendants()
            .any(|node| node.has_tag_name((W, "shd"))
                && node.attribute((W, "fill")) == Some("ffff00")));
        let end = run_for("end");
        assert!(end.descendants().any(|node| node.has_tag_name((W, "u"))));
        assert!(end
            .descendants()
            .any(|node| node.has_tag_name((W, "strike"))));
        assert_eq!(
            parsed
                .descendants()
                .filter(|node| node.has_tag_name((W, "br")))
                .count(),
            1
        );
        assert_eq!(
            parsed
                .descendants()
                .filter(|node| node.has_tag_name((W, "tab")))
                .count(),
            1
        );
        let relationships = roxmltree::Document::parse(&rels).unwrap();
        assert!(relationships
            .descendants()
            .any(|node| node.attribute("Target") == Some("https://example.com/?a=1&b=2")));
    }
    #[test]
    fn table_style_offsets_survive_trim_fragment_reassembly_and_native_export() {
        let id = format!("n_{}", "1".repeat(32));
        let fragment = |ordinal, row, final_attributes: &str, text: &str, size| {
            format!(
                r#"<table data-hcd-table-node-id="{id}" data-hcd-table-fragment="{ordinal}" data-hcd-row-start="{row}" data-hcd-row-end="{row}" data-hcd-fragment-row-count="1" data-hcd-column-count="1" {final_attributes}><tr><td>  <a href="https://example.com/{row}"><span style="font-size:{size}pt">{text}</span></a> </td></tr></table>"#
            )
        };
        let html = fragment(0, 1, "", "First", 14)
            + &fragment(
                1,
                2,
                "data-hcd-table-continuation=\"true\" data-hcd-table-final=\"true\" data-hcd-row-count=\"2\"",
                "第二😀",
                23,
            );
        let document = parse_html(&html).unwrap();
        assert_eq!(document.blocks.len(), 1);
        let (xml, _) = xml(&document);
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let cells: Vec<_> = parsed
            .descendants()
            .filter(|node| node.has_tag_name((W, "tc")))
            .collect();
        assert_eq!(cells.len(), 2);
        assert_eq!(
            cells[1]
                .descendants()
                .find(|node| node.has_tag_name((W, "t")))
                .unwrap()
                .text(),
            Some("第二😀")
        );
        assert_eq!(
            cells[1]
                .descendants()
                .find(|node| node.has_tag_name((W, "sz")))
                .unwrap()
                .attribute((W, "val")),
            Some("46")
        );
        assert!(cells[1]
            .descendants()
            .any(|node| node.has_tag_name((W, "hyperlink"))));
    }
    #[test]
    fn native_rich_insertion_rejects_invalid_text_before_writing_package() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("invalid.docx");
        super::super::super::create::create_blank_docx(path.to_str().unwrap()).unwrap();
        let handler = WordHandler::open(path.to_str().unwrap(), true).unwrap();
        let blocks = [RichBlock::Paragraph(RichParagraph {
            runs: vec![RichRun {
                text: "bad\u{0}".into(),
                hyperlink: Some("https://example.com".into()),
                ..Default::default()
            }],
            ..Default::default()
        })];
        assert!(handler.append_rich_blocks(&blocks).is_err());
        for size in [0.5, 1638.5, f32::NAN] {
            let block = RichBlock::Paragraph(RichParagraph {
                runs: vec![RichRun {
                    text: "font limits".into(),
                    font: RichFont {
                        size_pt: Some(size),
                        ..Default::default()
                    },
                    ..Default::default()
                }],
                ..Default::default()
            });
            assert!(handler.append_rich_blocks(&[block]).is_err());
        }
        handler.save().unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        assert!(!package
            .read_part_xml("word/_rels/document.xml.rels")
            .unwrap()
            .contains("https://example.com"));
    }
}
