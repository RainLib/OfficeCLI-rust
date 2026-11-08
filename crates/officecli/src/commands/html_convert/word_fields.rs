//! Numeric Word fields are retained as typed, zero-width run controls. This is
//! an opt-in canonical Word export path, never arbitrary HTML field execution.
use super::*;
use docx_handler::RichFieldControl;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(super) struct Event {
    pub offset: usize,
    pub control: RichFieldControl,
}
#[derive(Clone, Debug)]
pub(super) struct CellEvent {
    pub row: usize,
    pub column: usize,
    pub event: Event,
}
#[derive(Clone, Debug)]
pub(super) struct BlockEvent {
    pub block_index: usize,
    pub cell: Option<(usize, usize)>,
    pub event: Event,
}
pub(super) struct Plan {
    pub definitions: Arc<HashMap<String, String>>,
    pub static_fields: usize,
    pub numeric_atoms: usize,
}

pub(super) fn request_update_on_open(output: &Path) -> Result<(), HandlerError> {
    let fail = |error: oxml::PackageError| HandlerError::OperationFailed(error.to_string());
    let mut package = oxml::OxmlPackage::open(&output.to_string_lossy(), true).map_err(fail)?;
    let mut settings = if package.has_part("word/settings.xml") {
        package.read_part_xml("word/settings.xml").map_err(fail)?
    } else {
        let mut relationships = package
            .read_part_xml("word/_rels/document.xml.rels")
            .map_err(fail)?;
        let mut types = package.read_part_xml("[Content_Types].xml").map_err(fail)?;
        let relation = format!("rIdHcdFields{}", uuid::Uuid::new_v4().simple());
        word_regions::insert_before_root_end(&mut relationships,&format!("<Relationship Id=\"{relation}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings\" Target=\"settings.xml\"/>"))?;
        word_regions::insert_before_root_end(&mut types,"<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>")?;
        package
            .write_part_xml("word/_rels/document.xml.rels", &relationships)
            .map_err(fail)?;
        package
            .write_part_xml("[Content_Types].xml", &types)
            .map_err(fail)?;
        format!(
            "<w:settings xmlns:w=\"{}\"></w:settings>",
            hcd_core::WORD_MAIN_NS
        )
    };
    let document = roxmltree::Document::parse(&settings)
        .map_err(|error| HandlerError::ValidationError(error.to_string()))?;
    let mut ranges: Vec<_> = document
        .descendants()
        .filter(|node| node.has_tag_name((hcd_core::WORD_MAIN_NS, "updateFields")))
        .map(|node| node.range())
        .collect();
    ranges.sort_by_key(|range| range.start);
    for range in ranges.into_iter().rev() {
        settings.replace_range(range, "");
    }
    word_regions::insert_before_root_end(&mut settings, "<w:updateFields w:val=\"true\"/>")?;
    package
        .write_part_xml("word/settings.xml", &settings)
        .map_err(fail)?;
    package.save().map_err(fail)
}

fn numeric_instruction(value: &str) -> bool {
    let mut tokens = value.split_whitespace();
    if !tokens.next().is_some_and(|name| {
        matches!(
            name.to_ascii_uppercase().as_str(),
            "PAGE" | "NUMPAGES" | "SECTIONPAGES"
        )
    }) {
        return false;
    }
    while let Some(switch) = tokens.next() {
        if switch != "\\*" {
            return false;
        }
        let Some(format) = tokens.next() else {
            return false;
        };
        if !matches!(
            format.to_ascii_lowercase().as_str(),
            "arabic"
                | "alphabetic"
                | "roman"
                | "ordinal"
                | "cardtext"
                | "ordtext"
                | "dollartext"
                | "hex"
                | "mergeformat"
                | "caps"
                | "firstcap"
                | "upper"
                | "lower"
        ) {
            return false;
        }
    }
    true
}

/// Validate the original boundaries per source part, including fields spanning
/// body sections and chunk/paragraph boundaries. Other field kinds stay static.
pub(super) fn plan(
    layout: &hcd_core::FlowDocumentLayout,
    regions: &HashMap<String, String>,
) -> Result<Plan, HandlerError> {
    let mut stacks = HashMap::<String, Vec<String>>::new();
    let mut started = HashSet::new();
    let mut ended = HashSet::new();
    let mut definitions = HashMap::new();
    let mut total = 0;
    let mut numeric_atom_ids = HashSet::new();
    for region in hcd_core::flow_regions(layout) {
        let html = regions
            .get(&region.id)
            .ok_or_else(|| HandlerError::ValidationError("missing Word field region".into()))?;
        if !html.contains("data-hcd-word-field-") && !html.contains("data-hcd-extension=") {
            continue;
        }
        let wrapped = format!("<root>{html}</root>");
        let document = roxmltree::Document::parse(&wrapped)
            .map_err(|e| HandlerError::ValidationError(e.to_string()))?;
        let stack = stacks.entry(region.source_part.clone()).or_default();
        for node in document.descendants().filter(|node| node.is_element()) {
            if let Some(raw) = node.attribute("data-hcd-extension") {
                let atom: hcd_core::ExtensionNode = serde_json::from_str(raw)
                    .map_err(|error| HandlerError::ValidationError(error.to_string()))?;
                atom.validate()
                    .map_err(|error| HandlerError::ValidationError(error.to_string()))?;
                if hcd_core::read_word_numeric_field(&atom)
                    .map_err(|error| HandlerError::ValidationError(error.to_string()))?
                    .is_some()
                    && !numeric_atom_ids.insert(atom.instance_id)
                {
                    return Err(HandlerError::ValidationError(
                        "duplicate Word numeric field atom".into(),
                    ));
                }
            }
            if let Some(id) = node.attribute("data-hcd-word-field-start") {
                if !started.insert(id.to_string())
                    || node.tag_name().name() != "span"
                    || node.children().next().is_some()
                {
                    return Err(HandlerError::ValidationError(
                        "invalid Word field start during export".into(),
                    ));
                }
                stack.push(id.to_string());
            }
            if let Some(raw) = node.attribute("data-hcd-word-field-definition") {
                let value: hcd_core::FlowWordFieldDefinition = serde_json::from_str(raw)
                    .map_err(|e| HandlerError::ValidationError(e.to_string()))?;
                value
                    .validate()
                    .map_err(|e| HandlerError::ValidationError(e.to_string()))?;
                if node.tag_name().name() != "span"
                    || node.children().next().is_some()
                    || node.attribute("data-hcd-word-field-end") != Some(value.field_id.as_str())
                    || value.source_part != region.source_part
                    || stack.pop().as_deref() != Some(value.field_id.as_str())
                    || !ended.insert(value.field_id.clone())
                {
                    return Err(HandlerError::ValidationError(
                        "invalid Word field end during export".into(),
                    ));
                }
                total += 1;
                if numeric_instruction(&value.instruction) {
                    definitions.insert(value.field_id, value.instruction);
                }
            } else if node.has_attribute("data-hcd-word-field-end") {
                return Err(HandlerError::ValidationError(
                    "Word field end has no definition".into(),
                ));
            }
        }
    }
    if stacks.values().any(|stack| !stack.is_empty()) || started != ended {
        return Err(HandlerError::ValidationError(
            "unclosed Word field during export".into(),
        ));
    }
    Ok(Plan {
        static_fields: total - definitions.len(),
        definitions: Arc::new(definitions),
        numeric_atoms: numeric_atom_ids.len(),
    })
}

impl HtmlParser {
    pub(super) fn word_field_control(&mut self, tag: &Tag) -> Result<(), HandlerError> {
        let atom_start = tag.attributes.get("data-hcd-numeric-field-start");
        let atom_end = tag.attributes.get("data-hcd-numeric-field-end");
        let control = if self.numeric_field_atoms && (atom_start.is_some() || atom_end.is_some()) {
            if tag.name != "span" || atom_start.is_some() && atom_end.is_some() {
                return Err(HandlerError::ValidationError(
                    "invalid numeric field boundary".into(),
                ));
            }
            if let Some(id) = atom_start {
                if !id.strip_prefix("x_").is_some_and(|hex| {
                    hex.len() == 32
                        && hex
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                }) || self.numeric_field_seen.len() >= 100000
                    || !self.numeric_field_seen.insert(id.clone())
                    || self.numeric_field_stack.len() >= 32
                {
                    return Err(HandlerError::ValidationError(
                        "invalid or duplicate numeric field identity".into(),
                    ));
                }
                let field: hcd_core::WordNumericField =
                    serde_json::from_str(tag.attributes.get("data-hcd-numeric-field").ok_or_else(
                        || HandlerError::ValidationError("numeric field data missing".into()),
                    )?)
                    .map_err(|error| HandlerError::ValidationError(error.to_string()))?;
                self.numeric_field_stack.push(id.clone());
                Some(RichFieldControl::Begin(field.instruction()))
            } else {
                if tag.attributes.contains_key("data-hcd-numeric-field")
                    || self.numeric_field_stack.pop().as_ref() != atom_end
                {
                    return Err(HandlerError::ValidationError(
                        "unmatched numeric field boundary".into(),
                    ));
                }
                Some(RichFieldControl::End)
            }
        } else if let Some(instruction) =
            tag.attributes
                .get("data-hcd-word-field-start")
                .and_then(|id| {
                    self.field_definitions
                        .as_ref()
                        .and_then(|definitions| definitions.get(id))
                })
        {
            Some(RichFieldControl::Begin(instruction.clone()))
        } else if tag
            .attributes
            .get("data-hcd-word-field-end")
            .is_some_and(|id| {
                self.field_definitions
                    .as_ref()
                    .is_some_and(|definitions| definitions.contains_key(id))
            })
        {
            Some(RichFieldControl::End)
        } else {
            None
        };
        let Some(control) = control else {
            return Ok(());
        };
        if let Some(table) = &mut self.table {
            if let Some(cell) = &table.cell {
                table.cell_fields.push(Event {
                    offset: cell.len(),
                    control,
                });
                return Ok(());
            }
        }
        if self.pending.is_none() {
            self.append_active("", false)?;
        }
        let pending = self.pending.as_mut().expect("field paragraph initialized");
        pending.preserve_empty = true;
        pending.fields.push(Event {
            offset: pending.text.len(),
            control,
        });
        Ok(())
    }
}

pub(super) fn trim(mut event: Event, start: usize, end: usize) -> Event {
    event.offset = event.offset.clamp(start, end) - start;
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(n: u8) -> String {
        format!("n_{n:032x}")
    }
    fn definition(n: u8, instruction: &str) -> String {
        quick_xml::escape::escape(
            &serde_json::to_string(&hcd_core::FlowWordFieldDefinition {
                schema_version: hcd_core::FLOW_WORD_FIELD_SCHEMA.into(),
                field_id: id(n),
                source_part: "word/document.xml".into(),
                instruction: instruction.into(),
                simple: false,
            })
            .unwrap(),
        )
        .into_owned()
    }
    fn start(n: u8) -> String {
        format!("<span data-hcd-word-field-start=\"{}\"></span>", id(n))
    }
    fn end(n: u8, instruction: &str) -> String {
        format!(
            "<span data-hcd-word-field-end=\"{}\" data-hcd-word-field-definition=\"{}\"></span>",
            id(n),
            definition(n, instruction)
        )
    }
    fn layout() -> hcd_core::FlowDocumentLayout {
        serde_json::from_value(serde_json::json!({"schemaVersion":"hcd-flow-layout/2","evenAndOddHeaders":false,"sections":[{"id":id(1),"source":{"part":"word/document.xml"},"differentFirstPage":false,"page":{},"headers":{},"footers":{}},{"id":id(2),"source":{"part":"word/document.xml"},"differentFirstPage":false,"page":{},"headers":{},"footers":{}}],"stories":[]})).unwrap()
    }
    #[test]
    fn typed_numeric_adapter_drives_generic_docx_without_enabling_opaque_instructions() {
        let field = hcd_core::WordNumericField {
            kind: hcd_core::WordNumericFieldKind::Page,
            format: hcd_core::WordNumericFieldFormat::UpperRoman,
        };
        let atom = field.node(format!("x_{:032x}", 70));
        let source = format!(
            "<p>前<span data-hcd-extension=\"{}\">[PAGE]</span>后</p>",
            quick_xml::escape::escape(&serde_json::to_string(&atom).unwrap())
        );
        let adapted = hcd_core::adapt_extension_exports(&source, "docx").unwrap();
        let parsed = parse_html_with_parser(
            &adapted,
            HtmlParser {
                numeric_field_atoms: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(parsed.fields.len(), 2);
        assert_eq!(
            parsed.blocks,
            vec![HtmlBlock::Paragraph("前[PAGE]后".into())]
        );
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("field.html");
        let output = temp.path().join("field.docx");
        std::fs::write(&input,format!("<!DOCTYPE html><html><head><title>Numeric</title></head><body>{adapted}</body></html>")).unwrap();
        convert_html(&input, &output, "docx").unwrap();
        request_update_on_open(&output).unwrap();
        let package = oxml::OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        assert!(xml.contains("PAGE \\* ROMAN"));
        assert_eq!(xml.matches("fldCharType=\"begin\"").count(), 1);
        let settings = package.read_part_xml("word/settings.xml").unwrap();
        assert_eq!(settings.matches("<w:updateFields ").count(), 1);
        let static_html = hcd_core::adapt_extension_exports(&source, "html").unwrap();
        assert!(!static_html.contains("data-hcd-numeric-field-start"));
        assert!(parse_html(&adapted).unwrap().fields.is_empty());
        let opaque = format!("<p>{}9{}</p>", start(1), end(1, "DDE external file"));
        assert!(parse_html_with_parser(
            &opaque,
            HtmlParser {
                numeric_field_atoms: true,
                ..Default::default()
            }
        )
        .unwrap()
        .fields
        .is_empty());
    }
    #[test]
    fn typed_numeric_boundaries_refuse_wrong_ids_unclosed_and_arbitrary_instructions() {
        let start = |id: &str, raw: &str| {
            format!(
                "<span data-hcd-numeric-field-start=\"{id}\" data-hcd-numeric-field=\"{}\"></span>",
                quick_xml::escape::escape(raw)
            )
        };
        let end = |id: &str| format!("<span data-hcd-numeric-field-end=\"{id}\"></span>");
        let id = format!("x_{:032x}", 1);
        let good = r#"{"kind":"PAGE","format":"inherit"}"#;
        for source in [
            start(&id, good),
            end(&id),
            format!("{}{}", start(&id, good), end("wrong")),
            format!(
                "{}{}{}{}",
                start(&id, good),
                end(&id),
                start(&id, good),
                end(&id)
            ),
            format!(
                "{}{}",
                start(&id, r#"{"kind":"DDE","format":"inherit"}"#),
                end(&id)
            ),
            format!(
                "{}{}",
                start(
                    &id,
                    r#"{"kind":"PAGE","format":"inherit","instruction":"INCLUDETEXT x"}"#
                ),
                end(&id)
            ),
        ] {
            assert!(
                parse_html_with_parser(
                    &source,
                    HtmlParser {
                        numeric_field_atoms: true,
                        ..Default::default()
                    }
                )
                .is_err(),
                "{source}"
            );
        }
    }
    #[test]
    fn numeric_fields_accept_general_format_switches_without_admitting_other_instructions() {
        for value in [
            "PAGE",
            " numpages ",
            "SECTIONPAGES \\* roman",
            "PAGE \\* ROMAN \\* MERGEFORMAT",
        ] {
            assert!(numeric_instruction(value), "{value}");
        }
        for value in [
            "DDE file",
            "HYPERLINK url",
            "TOC \\o 1-3",
            "PAGE INCLUDETEXT file",
            "PAGE \\*",
            "PAGE \\* \"quoted value\"",
            "PAGE \\* UnknownFormat",
            "PAGE \\* CHARFORMAT",
        ] {
            assert!(!numeric_instruction(value), "{value}");
        }
    }
    #[test]
    fn plan_keeps_nested_numeric_fields_and_cross_section_boundaries_but_counts_static_fields() {
        let regions = HashMap::from([
            (
                id(1),
                format!("<p>{}{}8{}</p>", start(10), start(11), end(11, "PAGE")),
            ),
            (
                id(2),
                format!("<p>rest{}{}</p>", end(10, "CUSTOM opaque"), start(12))
                    + &format!("<p>{}</p>", end(12, "NUMPAGES \\* MERGEFORMAT")),
            ),
        ]);
        let plan = plan(&layout(), &regions).unwrap();
        assert_eq!(plan.static_fields, 1);
        assert_eq!(plan.definitions.len(), 2);
        assert_eq!(plan.definitions[&id(11)], "PAGE");
    }
    #[test]
    fn plan_refuses_unmatched_duplicate_and_wrong_part_boundaries() {
        for html in [
            start(10),
            end(10, "PAGE"),
            format!(
                "{}{}{}{}",
                start(10),
                start(10),
                end(10, "PAGE"),
                end(10, "PAGE")
            ),
            format!(
                "{}{}{}{}",
                start(10),
                start(11),
                end(10, "PAGE"),
                end(11, "PAGE")
            ),
            format!(
                "{}{}",
                start(10),
                end(10, "PAGE").replace("word/document.xml", "word/header1.xml")
            ),
        ] {
            assert!(plan(
                &layout(),
                &HashMap::from([(id(1), html), (id(2), String::new())])
            )
            .is_err());
        }
    }
    #[test]
    fn ordinary_html_never_enables_word_field_controls() {
        let source = format!("<p>{}4{}</p>", start(10), end(10, "PAGE"));
        let document = parse_html(&source).unwrap();
        assert!(document.fields.is_empty());
        assert_eq!(document.blocks, vec![HtmlBlock::Paragraph("4".into())]);
    }
    #[test]
    fn fragmented_tables_keep_field_controls_in_their_original_cells_after_trimming() {
        let table_id = id(40);
        let first = format!(
            r#"<table data-hcd-table-node-id="{table_id}" data-hcd-table-fragment="0" data-hcd-row-start="1" data-hcd-row-end="1" data-hcd-fragment-row-count="1" data-hcd-column-count="1"><tr><td>  {}前7{} </td></tr></table>"#,
            start(10),
            end(10, "PAGE")
        );
        let second = format!(
            r#"<table data-hcd-table-node-id="{table_id}" data-hcd-table-fragment="1" data-hcd-row-start="2" data-hcd-row-end="2" data-hcd-fragment-row-count="1" data-hcd-column-count="1" data-hcd-table-continuation="true" data-hcd-table-final="true" data-hcd-row-count="2"><tr><td> {}後12{}  </td></tr></table>"#,
            start(11),
            end(11, "NUMPAGES")
        );
        let document = parse_html_with_parser(
            &(first + &second),
            HtmlParser {
                field_definitions: Some(Arc::new(HashMap::from([
                    (id(10), "PAGE".into()),
                    (id(11), "NUMPAGES".into()),
                ]))),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            document
                .fields
                .iter()
                .map(|event| event.cell)
                .collect::<Vec<_>>(),
            vec![Some((0, 0)), Some((0, 0)), Some((1, 0)), Some((1, 0))]
        );
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cells.docx");
        rich::export_docx(&document, &path).unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let w = hcd_core::WORD_MAIN_NS;
        let cells = parsed
            .descendants()
            .filter(|node| node.has_tag_name((w, "tc")))
            .collect::<Vec<_>>();
        assert_eq!(cells.len(), 2);
        for (cell, (instruction, cached)) in
            cells.iter().zip([("PAGE", "前7"), ("NUMPAGES", "後12")])
        {
            assert_eq!(
                cell.descendants()
                    .find(|node| node.has_tag_name((w, "instrText")))
                    .unwrap()
                    .text(),
                Some(instruction)
            );
            let value: String = cell
                .descendants()
                .filter(|node| node.has_tag_name((w, "t")))
                .filter_map(|node| node.text())
                .collect();
            assert_eq!(value, cached);
        }
    }
    #[test]
    fn real_docx_serialization_keeps_zero_width_controls_table_positions_and_cached_format() {
        let definitions = Arc::new(HashMap::from([
            (id(10), "PAGE \\* ROMAN".into()),
            (id(11), "NUMPAGES".into()),
            (id(12), "SECTIONPAGES".into()),
        ]));
        let source = format!(
            "<p>前{}<b>Ⅷ</b>{}后</p><table><tr><td>A{}12{}B</td></tr></table><p>{}</p><p>{}</p>",
            start(10),
            end(10, "PAGE \\* ROMAN"),
            start(11),
            end(11, "NUMPAGES"),
            start(12),
            end(12, "SECTIONPAGES")
        );
        let document = parse_html_with_parser(
            &source,
            HtmlParser {
                field_definitions: Some(definitions),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(document.fields.len(), 6);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fields.docx");
        rich::export_docx(&document, &path).unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        let parsed = roxmltree::Document::parse(&xml).unwrap();
        let w = hcd_core::WORD_MAIN_NS;
        let controls: Vec<_> = parsed
            .descendants()
            .filter(|node| node.has_tag_name((w, "fldChar")))
            .map(|node| node.attribute((w, "fldCharType")).unwrap())
            .collect();
        assert_eq!(
            controls,
            vec![
                "begin", "separate", "end", "begin", "separate", "end", "begin", "separate", "end"
            ]
        );
        let instructions: Vec<_> = parsed
            .descendants()
            .filter(|node| node.has_tag_name((w, "instrText")))
            .map(|node| node.text().unwrap())
            .collect();
        assert_eq!(
            instructions,
            vec!["PAGE \\* ROMAN", "NUMPAGES", "SECTIONPAGES"]
        );
        let text: String = parsed
            .descendants()
            .filter(|node| node.has_tag_name((w, "t")))
            .filter_map(|node| node.text())
            .collect();
        assert_eq!(text, "前Ⅷ后A12B");
        let cached = parsed
            .descendants()
            .find(|node| node.has_tag_name((w, "t")) && node.text() == Some("Ⅷ"))
            .unwrap()
            .parent()
            .unwrap();
        assert!(cached.descendants().any(|node| node.has_tag_name((w, "b"))));
        assert_eq!(
            parsed
                .descendants()
                .filter(|node| node.has_tag_name((w, "tc")))
                .count(),
            1
        );
    }
}
