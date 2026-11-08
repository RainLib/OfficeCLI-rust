//! Source-free Word rebuilding. Each story owns its relationships; body section
//! boundaries are generated privately and removed before atomic publication.
use super::*;
use hcd_core::{Bundle, FlowDocumentLayout, FlowSection, FlowStoryKind, HcdManifest};
use oxml::OxmlPackage;

const W: &str = hcd_core::WORD_MAIN_NS;
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn invalid(message: impl Into<String>) -> HandlerError {
    HandlerError::ValidationError(message.into())
}
fn escape(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}
fn package_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::OperationFailed(error.to_string())
}

/// Export every canonical body and story once, with explicit region labels.
/// TXT cannot represent page variants or portable images/attachments.
pub(crate) fn export_text(
    bundle: &Bundle,
    manifest: &HcdManifest,
    layout: &FlowDocumentLayout,
    output: &Path,
) -> Result<HtmlConversionSummary, HandlerError> {
    if layout.schema_version != hcd_core::FLOW_REGION_LAYOUT_SCHEMA {
        return Err(HandlerError::UnsupportedMode(
            "Word text export requires region projection".into(),
        ));
    }
    let mut regions: HashMap<_, String> = hcd_core::flow_regions(layout)
        .into_iter()
        .map(|region| (region.id, String::new()))
        .collect();
    let mut total = 0usize;
    let mut gathered = 0usize;
    for index in 0..manifest.index_page_count {
        for chunk in bundle
            .read_index_page(manifest, index)
            .map_err(package_error)?
            .chunks
        {
            let html = bundle.read_chunk_verified(&chunk).map_err(package_error)?;
            total = total
                .checked_add(html.len())
                .ok_or_else(|| invalid("Word export size overflow"))?;
            if total as u64 > MAX_HTML_BYTES {
                return Err(invalid(
                    "Word region export exceeds the 64 MiB semantic input limit",
                ));
            }
            let wrapped = format!("<root>{html}</root>");
            let document = roxmltree::Document::parse(&wrapped).map_err(package_error)?;
            for region in document
                .descendants()
                .filter(|node| node.attribute("data-hcd-flow-region").is_some())
            {
                let id = region.attribute("data-hcd-flow-region").unwrap();
                let target = regions
                    .get_mut(id)
                    .ok_or_else(|| invalid("unknown Word export region"))?;
                for child in region.children() {
                    let fragment = &wrapped[child.range()];
                    gathered = gathered
                        .checked_add(fragment.len())
                        .ok_or_else(|| invalid("Word export size overflow"))?;
                    if gathered as u64 > MAX_HTML_BYTES {
                        return Err(invalid(
                            "Word region export exceeds the 64 MiB semantic input limit",
                        ));
                    }
                    target.push_str(fragment);
                }
            }
        }
    }
    let mut html = String::from("<!doctype html><html><body>");
    let mut append = |label: String, region: &str| -> Result<(), HandlerError> {
        let adapted = hcd_core::adapt_extension_exports(region, "txt").map_err(package_error)?;
        let size = html
            .len()
            .checked_add(label.len())
            .and_then(|n| n.checked_add(adapted.len()))
            .ok_or_else(|| invalid("Word export size overflow"))?;
        if size as u64 > MAX_HTML_BYTES {
            return Err(invalid(
                "adapted Word export exceeds the 64 MiB semantic input limit",
            ));
        }
        html.push_str(&label);
        html.push_str(&adapted);
        Ok(())
    };
    for (index, section) in layout.sections.iter().enumerate() {
        append(
            format!("<h2>Section {}</h2>", index + 1),
            &regions[&section.id],
        )?;
    }
    for (index, story) in layout.stories.iter().enumerate() {
        let kind = match story.kind {
            FlowStoryKind::Header => "Header",
            FlowStoryKind::Footer => "Footer",
        };
        append(
            format!("<h2>{kind} {}</h2>", index + 1),
            &regions[&story.id],
        )?;
    }
    html.push_str("</body></html>");
    if html.len() as u64 > MAX_HTML_BYTES {
        return Err(invalid(
            "adapted Word export exceeds the 64 MiB semantic input limit",
        ));
    }
    let mut document = parse_html(&normalize_canonical_lists(&html))?;
    for block in &mut document.blocks {
        if let HtmlBlock::Image { source, .. } = block {
            source.clear();
        }
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let temporary = temporary_output_path(parent, "txt");
    if let Err(error) = export_textual(&document, &temporary, false) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    publish_output(&temporary, output)?;
    Ok(HtmlConversionSummary {
        engine: "rust-html-text",
        fidelity: "semantic",
        block_count: document.blocks.len(),
        image_count: document
            .blocks
            .iter()
            .filter(|block| matches!(block, HtmlBlock::Image { .. }))
            .count(),
        embedded_image_count: 0,
        warnings: document.warnings.into_iter().collect(),
    })
}

pub(crate) fn export(
    bundle: &Bundle,
    manifest: &HcdManifest,
    layout: &FlowDocumentLayout,
    output: &Path,
    mut assets: HashMap<String, SemanticAsset>,
    typography: &hcd_core::TypographyResolver,
) -> Result<HtmlConversionSummary, HandlerError> {
    if layout.schema_version != hcd_core::FLOW_REGION_LAYOUT_SCHEMA {
        return Err(HandlerError::UnsupportedMode(
            "Source-free Word export requires region projection. Run hdoc project-editor --word-regions first, or export with the original --source DOCX".into(),
        ));
    }
    let mut regions: HashMap<_, String> = hcd_core::flow_regions(layout)
        .into_iter()
        .map(|region| (region.id, String::new()))
        .collect();
    let mut total = 0usize;
    for index in 0..manifest.index_page_count {
        for chunk in bundle
            .read_index_page(manifest, index)
            .map_err(package_error)?
            .chunks
        {
            let html = bundle.read_chunk_verified(&chunk).map_err(package_error)?;
            total = total
                .checked_add(html.len())
                .ok_or_else(|| invalid("Word export size overflow"))?;
            if total as u64 > MAX_HTML_BYTES {
                return Err(invalid(
                    "Word region export exceeds the 64 MiB semantic input limit",
                ));
            }
            let wrapped = format!("<root>{html}</root>");
            let document = roxmltree::Document::parse(&wrapped).map_err(package_error)?;
            for region in document
                .descendants()
                .filter(|node| node.attribute("data-hcd-flow-region").is_some())
            {
                let id = region.attribute("data-hcd-flow-region").unwrap();
                let target = regions
                    .get_mut(id)
                    .ok_or_else(|| invalid("unknown Word export region"))?;
                for child in region.children() {
                    target.push_str(&wrapped[child.range()]);
                }
            }
        }
    }
    let field_plan = word_fields::plan(layout, &regions)?;
    let mut emitted_fields = 0;
    let mut documents = HashMap::new();
    let mut warnings = BTreeSet::new();
    let mut block_count = 0;
    let mut image_count = 0;
    let mut adapted_bytes = 0usize;
    for (id, html) in regions {
        let adapted = hcd_core::adapt_extension_exports(&html, "docx").map_err(package_error)?;
        let annotated = typography
            .annotate_export(&adapted)
            .map_err(package_error)?;
        adapted_bytes = adapted_bytes.saturating_add(annotated.len());
        if adapted_bytes as u64 > MAX_HTML_BYTES {
            return Err(invalid(
                "adapted Word export exceeds the 64 MiB semantic input limit",
            ));
        }
        let mut document = parse_html_with_parser(
            &normalize_canonical_lists(&annotated),
            HtmlParser {
                field_definitions: Some(field_plan.definitions.clone()),
                numeric_field_atoms: true,
                ..Default::default()
            },
        )?;
        emitted_fields += document.fields.len();
        if document.blocks.is_empty() {
            document.blocks.push(HtmlBlock::Paragraph(String::new()));
        }
        if document.blocks.iter().any(|block| matches!(block, HtmlBlock::Image {geometry, ..} if geometry.x_emu.unwrap_or(0) != 0 || geometry.y_emu.unwrap_or(0) != 0)) {
            warnings.insert("Floating image positions were converted to inline images; saved image dimensions are retained".into());
        }
        block_count += document.blocks.len();
        image_count += document
            .blocks
            .iter()
            .filter(|block| matches!(block, HtmlBlock::Image { .. }))
            .count();
        warnings.extend(document.warnings.iter().cloned());
        documents.insert(id, document);
    }
    if emitted_fields != (field_plan.definitions.len() + field_plan.numeric_atoms) * 2 {
        return Err(invalid(
            "Word field boundaries changed during export adaptation",
        ));
    }
    if !field_plan.definitions.is_empty() || field_plan.numeric_atoms > 0 {
        warnings.insert("PAGE, NUMPAGES and SECTIONPAGES fields retain their supported instructions and cached results for target applications to update; OfficeCLI does not paginate or recalculate them".into());
    }
    if field_plan.static_fields > 0 {
        warnings.insert("Other Word fields retain their saved readable result as static text; their instructions remain in the native HCD archive".into());
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let temporary = temporary_output_path(parent, "docx");
    let result = (|| {
        super::super::create::create_blank_docx(&temporary.to_string_lossy())?;
        let bindings = prepare_stories(&temporary, layout)?;
        let handler = WordHandler::open(&temporary.to_string_lossy(), true)?;
        handler.remove("/body/p[1]")?;
        let mut embedded = 0;
        let marker_prefix = format!("Hcd{}", uuid::Uuid::new_v4().simple());
        let mut markers = Vec::new();
        for (index, section) in layout.sections.iter().enumerate() {
            embedded += append_region(
                documents.get_mut(&section.id).unwrap(),
                &handler,
                "/body",
                &mut assets,
            )?;
            if index + 1 < layout.sections.len() {
                // Native bookmark nodes, never visible sentinel text.
                let name = format!("{}{index}", &marker_prefix[..30]);
                handler.add(
                    "/body",
                    "bookmark",
                    InsertPosition::Append,
                    &HashMap::from([("name".into(), name.clone())]),
                    None,
                )?;
                markers.push(name);
            }
        }
        for story in &layout.stories {
            embedded += append_region(
                documents.get_mut(&story.id).unwrap(),
                &handler,
                &bindings[&story.id].1,
                &mut assets,
            )?;
        }
        handler.save()?;
        assemble_sections(&temporary, layout, &bindings, &markers, &mut warnings)?;
        if !field_plan.definitions.is_empty() || field_plan.numeric_atoms > 0 {
            word_fields::request_update_on_open(&temporary)?;
        }
        validate_output(&temporary, "docx")?;
        Ok(embedded)
    })();
    let embedded_image_count = match result {
        Ok(count) => count,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
    };
    publish_output(&temporary, output)?;
    if embedded_image_count < image_count {
        warnings.insert(format!("{} images were represented by readable alt text because no trusted compatible asset was available", image_count - embedded_image_count));
    }
    warnings.insert("Word regions and section settings were rebuilt semantically; source pagination, opaque parts and unsupported CSS are not reproduced".into());
    Ok(HtmlConversionSummary {
        engine: "rust-word-regions",
        fidelity: "semantic",
        block_count,
        image_count,
        embedded_image_count,
        warnings: warnings.into_iter().collect(),
    })
}

fn append_region(
    document: &mut SemanticHtml,
    handler: &WordHandler,
    parent: &str,
    assets: &mut HashMap<String, SemanticAsset>,
) -> Result<usize, HandlerError> {
    // One verified asset catalog for the whole export, not a copy per story.
    std::mem::swap(&mut document.assets, assets);
    let result = rich::append_docx(document, handler, parent);
    std::mem::swap(&mut document.assets, assets);
    result
}

// story -> (document relationship ID, stable L2 story path)
type Bindings = HashMap<String, (String, String)>;
fn prepare_stories(path: &Path, layout: &FlowDocumentLayout) -> Result<Bindings, HandlerError> {
    let mut package = OxmlPackage::open(&path.to_string_lossy(), true).map_err(package_error)?;
    let mut relationships = package
        .read_part_xml("word/_rels/document.xml.rels")
        .map_err(package_error)?;
    let mut content_types = package
        .read_part_xml("[Content_Types].xml")
        .map_err(package_error)?;
    if !package.has_part("word/settings.xml") {
        package
            .write_part_xml(
                "word/settings.xml",
                &format!("<w:settings xmlns:w=\"{W}\"></w:settings>"),
            )
            .map_err(package_error)?;
        insert_before_root_end(&mut relationships, &format!("<Relationship Id=\"rIdHcdSettings\" Type=\"{R}/settings\" Target=\"settings.xml\"/>"))?;
        insert_before_root_end(&mut content_types, "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>")?;
    }
    let mut bindings = HashMap::new();
    let mut counts = [0usize; 2];
    for (index, story) in layout.stories.iter().enumerate() {
        let (kind, root, slot) = match story.kind {
            FlowStoryKind::Header => ("header", "hdr", 0),
            FlowStoryKind::Footer => ("footer", "ftr", 1),
        };
        counts[slot] += 1;
        let number = counts[slot];
        let relation = format!("rIdHcdStory{index:05}");
        let part = format!("word/{kind}{number}.xml");
        package
            .write_part_xml(
                &part,
                &format!("<w:{root} xmlns:w=\"{W}\" xmlns:r=\"{R}\"></w:{root}>"),
            )
            .map_err(package_error)?;
        insert_before_root_end(&mut relationships, &format!("<Relationship Id=\"{relation}\" Type=\"{R}/{kind}\" Target=\"{kind}{number}.xml\"/>"))?;
        insert_before_root_end(&mut content_types, &format!("<Override PartName=\"/{part}\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml\"/>"))?;
        bindings.insert(story.id.clone(), (relation, format!("/{kind}[{number}]")));
    }
    package
        .write_part_xml("word/_rels/document.xml.rels", &relationships)
        .map_err(package_error)?;
    package
        .write_part_xml("[Content_Types].xml", &content_types)
        .map_err(package_error)?;
    package.save().map_err(package_error)?;
    Ok(bindings)
}
pub(super) fn insert_before_root_end(xml: &mut String, addition: &str) -> Result<(), HandlerError> {
    let document = roxmltree::Document::parse(xml).map_err(package_error)?;
    let root = document.root_element();
    let range = root.range();
    let source = &xml[range.clone()];
    if source.trim_end().ends_with("/>") {
        let name = source[1..]
            .split(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
            .next()
            .ok_or_else(|| invalid("invalid XML root"))?;
        let rebuilt = format!(
            "{}>{addition}</{name}>",
            source.trim_end().trim_end_matches("/>")
        );
        xml.replace_range(range, &rebuilt);
        return Ok(());
    }
    let offset = range.start
        + source
            .rfind("</")
            .ok_or_else(|| invalid("missing XML root end"))?;
    xml.insert_str(offset, addition);
    Ok(())
}
fn section_properties(
    section: &FlowSection,
    bindings: &Bindings,
    warnings: &mut BTreeSet<String>,
) -> Result<String, HandlerError> {
    let mut xml = format!("<w:sectPr xmlns:w=\"{W}\" xmlns:r=\"{R}\"");
    let original = section
        .source
        .original_properties_xml
        .as_deref()
        .map(roxmltree::Document::parse)
        .transpose()
        .map_err(package_error)?;
    if let Some(document) = &original {
        for ns in document.root_element().namespaces() {
            if matches!(ns.name(), Some("w" | "r" | "xml")) {
                continue;
            }
            let namespace = if ns.uri() == hcd_core::WORD_STRICT_NS {
                W
            } else {
                ns.uri()
            };
            xml.push_str(&format!(
                " xmlns{}=\"{}\"",
                ns.name().map(|n| format!(":{n}")).unwrap_or_default(),
                escape(namespace)
            ));
        }
    }
    xml.push('>');
    for (kind, stories) in [("header", &section.headers), ("footer", &section.footers)] {
        for (variant, id) in [
            ("default", &stories.default),
            ("first", &stories.first),
            ("even", &stories.even),
        ] {
            if let Some(id) = id {
                let relation = &bindings
                    .get(id)
                    .ok_or_else(|| invalid("missing story binding"))?
                    .0;
                xml.push_str(&format!(
                    "<w:{kind}Reference w:type=\"{variant}\" r:id=\"{relation}\"/>"
                ));
            }
        }
    }
    // Preserve inert section properties (columns, grid, borders, direction, etc.).
    // Relationship-bearing and historical property snapshots cannot point back
    // into a missing immutable source package.
    let mut retained = Vec::new();
    if let Some(document) = &original {
        for node in document
            .root_element()
            .children()
            .filter(|n| n.is_element())
        {
            if !matches!(
                node.tag_name().namespace(),
                Some(hcd_core::WORD_MAIN_NS | hcd_core::WORD_STRICT_NS)
            ) {
                warnings.insert("Unsupported foreign section properties were omitted; the native HCD archive retains them".into());
                continue;
            }
            if matches!(
                node.tag_name().name(),
                "headerReference"
                    | "footerReference"
                    | "type"
                    | "pgSz"
                    | "pgMar"
                    | "pgNumType"
                    | "titlePg"
            ) {
                continue;
            }
            if node.tag_name().name() == "sectPrChange"
                || node.descendants().flat_map(|n| n.attributes()).any(|a| {
                    a.namespace()
                        .is_some_and(|ns| ns.contains("/relationships"))
                })
            {
                warnings.insert("Source section property history and relationship-bearing opaque properties were omitted; the native HCD archive retains them".into());
                continue;
            }
            retained.push((
                node.tag_name().name().to_string(),
                document.input_text()[node.range()].replace(hcd_core::WORD_STRICT_NS, W),
            ));
        }
    }
    if let Some(kind) = &section.break_type {
        xml.push_str(&format!("<w:type w:val=\"{}\"/>", escape(kind)));
    }
    let page = &section.page;
    if page.width_twips.is_some() || page.height_twips.is_some() || page.orientation.is_some() {
        xml.push_str("<w:pgSz");
        for (key, value) in [
            ("w", page.width_twips.map(|n| n.to_string())),
            ("h", page.height_twips.map(|n| n.to_string())),
            ("orient", page.orientation.clone()),
        ] {
            if let Some(value) = value {
                xml.push_str(&format!(" w:{key}=\"{}\"", escape(&value)));
            }
        }
        xml.push_str("/>");
    }
    if !page.margins_twips.is_empty() {
        xml.push_str("<w:pgMar");
        for (key, value) in &page.margins_twips {
            xml.push_str(&format!(" w:{key}=\"{value}\""));
        }
        xml.push_str("/>");
    }
    if page.number_start.is_some() || page.number_format.is_some() {
        xml.push_str("<w:pgNumType");
        if let Some(start) = page.number_start {
            xml.push_str(&format!(" w:start=\"{start}\""));
        }
        if let Some(format) = &page.number_format {
            xml.push_str(&format!(" w:fmt=\"{}\"", escape(format)));
        }
        xml.push_str("/>");
    }
    for (_, property) in &retained {
        xml.push_str(property);
    }
    if section.different_first_page {
        xml.push_str("<w:titlePg/>");
    }
    xml.push_str("</w:sectPr>");
    // CT_SectPr has a defined order, independent of the source prefix.
    const ORDER: &[&str] = &[
        "headerReference",
        "footerReference",
        "footnotePr",
        "endnotePr",
        "type",
        "pgSz",
        "pgMar",
        "paperSrc",
        "pgBorders",
        "lnNumType",
        "pgNumType",
        "cols",
        "formProt",
        "vAlign",
        "noEndnote",
        "titlePg",
        "textDirection",
        "bidi",
        "rtlGutter",
        "docGrid",
    ];
    let parsed = roxmltree::Document::parse(&xml).map_err(package_error)?;
    let root = parsed.root_element();
    let mut children: Vec<_> = root.children().filter(|n| n.is_element()).collect();
    children.sort_by_key(|n| {
        ORDER
            .iter()
            .position(|name| *name == n.tag_name().name())
            .unwrap_or(ORDER.len())
    });
    let opening = xml.find('>').unwrap() + 1;
    let mut ordered = xml[..opening].to_string();
    for child in children {
        ordered.push_str(&xml[child.range()]);
    }
    ordered.push_str("</w:sectPr>");
    xml = ordered;
    roxmltree::Document::parse(&xml).map_err(package_error)?;
    Ok(xml)
}
fn assemble_sections(
    path: &Path,
    layout: &FlowDocumentLayout,
    bindings: &Bindings,
    markers: &[String],
    warnings: &mut BTreeSet<String>,
) -> Result<(), HandlerError> {
    let mut package = OxmlPackage::open(&path.to_string_lossy(), true).map_err(package_error)?;
    let source = package
        .read_part_xml("word/document.xml")
        .map_err(package_error)?;
    let document = roxmltree::Document::parse(&source).map_err(package_error)?;
    let body = document
        .root_element()
        .children()
        .find(|n| n.has_tag_name((W, "body")))
        .ok_or_else(|| invalid("missing Word body"))?;
    let mut output = String::new();
    let mut segment = Vec::new();
    let mut section = 0;
    let mut skip_end = None;
    for node in body.children().filter(|n| n.is_element()) {
        if node.has_tag_name((W, "sectPr")) {
            continue;
        }
        if node.has_tag_name((W, "bookmarkStart"))
            && markers
                .get(section)
                .is_some_and(|name| node.attribute((W, "name")) == Some(name))
        {
            skip_end = node.attribute((W, "id")).map(ToOwned::to_owned);
            let properties = section_properties(&layout.sections[section], bindings, warnings)?;
            append_segment(&source, &mut output, &segment, &properties, warnings);
            segment.clear();
            section += 1;
        } else if node.has_tag_name((W, "bookmarkEnd"))
            && skip_end
                .as_deref()
                .is_some_and(|id| node.attribute((W, "id")) == Some(id))
        {
            skip_end = None;
        } else {
            segment.push(node);
        }
    }
    if section != markers.len() || skip_end.is_some() {
        return Err(invalid("generated Word section boundary was lost"));
    }
    for node in segment {
        output.push_str(&source[node.range()]);
    }
    output.push_str(&section_properties(
        layout.sections.last().unwrap(),
        bindings,
        warnings,
    )?);
    let start = source[body.range()]
        .find('>')
        .ok_or_else(|| invalid("invalid body start"))?
        + body.range().start
        + 1;
    let end = body.range().start
        + source[body.range()]
            .rfind("</")
            .ok_or_else(|| invalid("invalid body end"))?;
    let mut rebuilt = source.clone();
    rebuilt.replace_range(start..end, &output);
    roxmltree::Document::parse(&rebuilt).map_err(package_error)?;
    package
        .write_part_xml("word/document.xml", &rebuilt)
        .map_err(package_error)?;
    let mut settings = package
        .read_part_xml("word/settings.xml")
        .map_err(package_error)?;
    let parsed = roxmltree::Document::parse(&settings).map_err(package_error)?;
    let ranges: Vec<_> = parsed
        .root_element()
        .children()
        .filter(|n| n.has_tag_name((W, "evenAndOddHeaders")))
        .map(|n| n.range())
        .collect();
    for range in ranges.into_iter().rev() {
        settings.replace_range(range, "");
    }
    if layout.even_and_odd_headers {
        insert_before_root_end(&mut settings, "<w:evenAndOddHeaders/>")?;
    }
    package
        .write_part_xml("word/settings.xml", &settings)
        .map_err(package_error)?;
    package.save().map_err(package_error)
}
fn append_segment(
    source: &str,
    output: &mut String,
    segment: &[roxmltree::Node<'_, '_>],
    properties: &str,
    warnings: &mut BTreeSet<String>,
) {
    let last = segment.last().filter(|node| node.has_tag_name((W, "p")));
    for node in segment
        .iter()
        .take(segment.len() - usize::from(last.is_some()))
    {
        output.push_str(&source[node.range()]);
    }
    if let Some(node) = last {
        let mut paragraph = source[node.range()].to_string();
        if let Some(ppr) = node.children().find(|n| n.has_tag_name((W, "pPr"))) {
            let offset = ppr.range().start - node.range().start;
            let raw = &source[ppr.range()];
            if raw.ends_with("/>") {
                paragraph.replace_range(
                    offset..offset + raw.len(),
                    &format!("<w:pPr>{properties}</w:pPr>"),
                );
            } else {
                paragraph.insert_str(offset + raw.rfind("</").unwrap(), properties);
            }
        } else if paragraph.ends_with("/>") {
            paragraph = format!("<w:p><w:pPr>{properties}</w:pPr></w:p>");
        } else {
            paragraph.insert_str(
                paragraph.find('>').unwrap() + 1,
                &format!("<w:pPr>{properties}</w:pPr>"),
            );
        }
        output.push_str(&paragraph);
    } else {
        output.push_str(&format!("<w:p><w:pPr>{properties}</w:pPr></w:p>"));
        warnings.insert("A section ending in a table or other non-paragraph block uses an empty Word section carrier paragraph".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Bundle) {
        let temp = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-layout-2026-10-26/source.docx");
        let path = temp.path().join("document.hcd");
        let mut options = hcd_docx::ImportOptions::new("word-export");
        options.flow_layout = true;
        hcd_docx::import_docx(source, &path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        (temp, bundle)
    }
    #[test]
    fn inserted_numeric_atoms_save_export_restore_and_reimport_without_requiring_a_source() {
        use hcd_core::{
            EditorBlockContent, EditorInline, FlowRegionEdits, FlowStructurePatchBatch,
            StructureOperation, WordNumericField, WordNumericFieldFormat as Format,
            WordNumericFieldKind as Kind,
        };
        let (temp, bundle) = fixture();
        let base = hcd_core::editor_projection(&bundle, None).unwrap();
        let body = base
            .blocks
            .iter()
            .find(|block| block.region == "body" && !block.read_only)
            .unwrap();
        let make = |id, kind, format| {
            let node = WordNumericField { kind, format }.node(format!("x_{id:032x}"));
            EditorInline {
                text: node.fallback.text.clone(),
                extension: Some(node),
                ..Default::default()
            }
        };
        let content = EditorBlockContent {
            inlines: vec![
                EditorInline {
                    text: "页 ".into(),
                    ..Default::default()
                },
                make(71, Kind::Page, Format::UpperRoman),
                EditorInline {
                    text: " / ".into(),
                    ..Default::default()
                },
                make(72, Kind::NumPages, Format::Inherit),
                EditorInline {
                    text: " 本节 ".into(),
                    ..Default::default()
                },
                make(73, Kind::SectionPages, Format::Arabic),
            ],
            ..Default::default()
        };
        let patch = FlowStructurePatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_6.into(),
            document_id: base.document_id.clone(),
            patch_id: "insert-numeric-fields".into(),
            base_revision: 1,
            layout_hash: base.flow_layout_hash.clone().unwrap(),
            actor: Default::default(),
            regions: vec![FlowRegionEdits {
                region_id: body.flow_region_id.clone().unwrap(),
                operations: vec![StructureOperation::Insert {
                    after_block_id: Some(body.block_id.clone()),
                    block: content.clone(),
                }],
            }],
        };
        hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let current = hcd_core::editor_projection(&bundle, None).unwrap();
        let atoms = hcd_core::projection_extensions(&current).unwrap();
        assert_eq!(atoms.len(), 3);
        assert_eq!(
            hcd_core::projection_extensions(
                &hcd_core::editor_projection(&bundle, Some(1)).unwrap()
            )
            .unwrap()
            .len(),
            0
        );
        let output = temp.path().join("inserted.docx");
        let manifest = bundle.manifest().unwrap();
        let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        let summary = export(
            &bundle,
            &manifest,
            &layout,
            &output,
            HashMap::new(),
            &hcd_core::TypographyResolver::new("").unwrap(),
        )
        .unwrap();
        assert!(summary
            .warnings
            .iter()
            .any(|value| value.contains("PAGE, NUMPAGES")));
        let package = OxmlPackage::open(output.to_str().unwrap(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        let document = roxmltree::Document::parse(&xml).unwrap();
        let instructions: Vec<_> = document
            .descendants()
            .filter(|node| node.tag_name().name() == "instrText")
            .map(|node| node.text().unwrap())
            .collect();
        assert_eq!(
            instructions,
            vec!["PAGE \\* ROMAN", "NUMPAGES", "SECTIONPAGES \\* Arabic"]
        );
        assert!(
            xml.contains("[PAGE]") && xml.contains("[NUMPAGES]") && xml.contains("[SECTIONPAGES]")
        );
        let imported = temp.path().join("returned.hcd");
        let mut options = hcd_docx::ImportOptions::new("returned-fields");
        options.flow_layout = true;
        hcd_docx::import_docx(&output, &imported, &options, |_| Ok(())).unwrap();
        let returned = Bundle::open(imported).unwrap();
        assert!(hcd_core::validate_bundle(&returned).unwrap().valid);
        let returned_projection = hcd_core::editor_projection(&returned, None).unwrap();
        let html = returned_projection
            .blocks
            .iter()
            .filter_map(|block| block.read_only_html.as_deref())
            .collect::<String>();
        assert_eq!(html.matches("data-hcd-word-field-definition=").count(), 3);
        assert!(hcd_core::editor_projection(&returned, None)
            .unwrap()
            .blocks
            .iter()
            .any(|block| block.read_only
                && block
                    .content
                    .inlines
                    .iter()
                    .any(|inline| inline.text == "[PAGE]")));
        let inserted = current
            .blocks
            .iter()
            .find(|block| {
                block.content == content
                    || block
                        .content
                        .inlines
                        .iter()
                        .any(|inline| inline.extension.is_some())
            })
            .unwrap();
        let target = inserted
            .content
            .inlines
            .iter()
            .find(|inline| inline.extension.is_some())
            .unwrap();
        let splice = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: base.document_id.clone(),
            patch_id: "cannot-flatten-field".into(),
            metadata: Default::default(),
            base_revision: 2,
            actor: Default::default(),
            operations: vec![hcd_core::PatchOperation::TextSplice {
                node_id: target.node_id.clone().unwrap(),
                start: 0,
                delete_count: 1,
                insert_text: "0".into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: hcd_core::hash_bytes(target.text.as_bytes()),
                },
            }],
        };
        assert!(hcd_core::apply_patch(&bundle, &splice, 2).is_err());
        hcd_core::restore_revision(&bundle, 1, 2, None, None).unwrap();
        assert!(hcd_core::projection_extensions(
            &hcd_core::editor_projection(&bundle, None).unwrap()
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            hcd_core::projection_extensions(
                &hcd_core::editor_projection(&bundle, Some(2)).unwrap()
            )
            .unwrap(),
            atoms
        );
        assert_eq!(bundle.manifest().unwrap().revision, 3);
    }
    #[test]
    fn numeric_fields_survive_full_regional_export_and_reimport_without_changing_head() {
        let temp = tempfile::tempdir().unwrap();
        let original = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/assets/hcd-flow-layout-2026-10-26/source.docx");
        let source = temp.path().join("fields.docx");
        std::fs::copy(original, &source).unwrap();
        let mut package = OxmlPackage::open(source.to_str().unwrap(), true).unwrap();
        let body = package.read_part_xml("word/document.xml").unwrap();
        let prefix = r#"<w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE \* ROMAN "><w:r><w:rPr><w:b/></w:rPr><w:t>VII</w:t></w:r></w:fldSimple></w:p>"#;
        package
            .write_part_xml(
                "word/document.xml",
                &body.replacen("<w:body>", &format!("<w:body>{prefix}"), 1),
            )
            .unwrap();
        let header = package.read_part_xml("word/header1.xml").unwrap();
        let fields = r#"<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t> total pages</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:fldSimple w:instr="SECTIONPAGES"><w:r><w:t>3</w:t></w:r></w:fldSimple></w:p></w:tc></w:tr></w:tbl><w:p><w:fldSimple w:instr="DATE"><w:r><w:t>Saved date</w:t></w:r></w:fldSimple><w:fldSimple w:instr="PAGE"/></w:p>"#;
        package
            .write_part_xml(
                "word/header1.xml",
                &header.replace("</w:hdr>", &format!("{fields}</w:hdr>")),
            )
            .unwrap();
        package.save().unwrap();
        drop(package);
        let target = temp.path().join("fields.hcd");
        let mut options = hcd_docx::ImportOptions::new("field-export");
        options.flow_layout = true;
        options.chunk_soft_bytes = 128;
        hcd_docx::import_docx(&source, &target, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        hcd_core::project_flow_regions(&bundle, 0).unwrap();
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let manifest = bundle.manifest().unwrap();
        let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        let output = temp.path().join("export.docx");
        let summary = export(
            &bundle,
            &manifest,
            &layout,
            &output,
            HashMap::new(),
            &hcd_core::TypographyResolver::new("").unwrap(),
        )
        .unwrap();
        assert_eq!(bundle.manifest().unwrap().root_hash, manifest.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(summary
            .warnings
            .iter()
            .any(|value| value.contains("PAGE, NUMPAGES")));
        assert!(summary
            .warnings
            .iter()
            .any(|value| value.contains("Other Word fields")));
        let package = OxmlPackage::open(output.to_str().unwrap(), false).unwrap();
        let mut codes = Vec::new();
        let mut starts = 0;
        let mut ends = 0;
        let mut cache = String::new();
        for part in package
            .list_parts()
            .into_iter()
            .filter(|part| part.starts_with("word/") && part.ends_with(".xml"))
        {
            let xml = package.read_part_xml(part).unwrap();
            let parsed = roxmltree::Document::parse(&xml).unwrap();
            for node in parsed.descendants() {
                if node.has_tag_name((W, "instrText")) {
                    codes.push(node.text().unwrap_or("").trim().to_string());
                }
                if node.has_tag_name((W, "fldChar")) {
                    starts += usize::from(node.attribute((W, "fldCharType")) == Some("begin"));
                    ends += usize::from(node.attribute((W, "fldCharType")) == Some("end"));
                }
                if node.has_tag_name((W, "t")) {
                    cache.push_str(node.text().unwrap_or(""));
                }
            }
        }
        codes.sort();
        assert_eq!(
            codes,
            vec!["NUMPAGES", "PAGE", r"PAGE \* ROMAN", "SECTIONPAGES"]
        );
        assert_eq!((starts, ends), (4, 4));
        assert!(cache.contains("Saved date"));
        assert!(cache.contains("VII"));
        assert!(cache.contains("12"));
        let settings = package.read_part_xml("word/settings.xml").unwrap();
        assert_eq!(
            roxmltree::Document::parse(&settings)
                .unwrap()
                .descendants()
                .filter(|node| node.has_tag_name((W, "updateFields"))
                    && node.attribute((W, "val")) == Some("true"))
                .count(),
            1
        );
        let imported = temp.path().join("reimport.hcd");
        hcd_docx::import_docx(&output, &imported, &options, |_| Ok(())).unwrap();
        let imported = Bundle::open(imported).unwrap();
        assert!(hcd_core::validate_bundle(&imported).unwrap().valid);
        let manifest = imported.manifest().unwrap();
        let mut html = String::new();
        for index in 0..manifest.index_page_count {
            for chunk in imported.read_index_page(&manifest, index).unwrap().chunks {
                html.push_str(&imported.read_chunk_verified(&chunk).unwrap());
            }
        }
        assert_eq!(html.matches("data-hcd-word-field-definition=").count(), 4);
        assert!(html.contains("NUMPAGES"));
        assert!(html.contains("SECTIONPAGES"));
        assert!(!html.contains("&quot;instruction&quot;:&quot;DATE"));
    }
    #[test]
    fn rebuilds_sections_and_independent_stories_without_mutating_bundle() {
        let (temp, bundle) = fixture();
        let manifest = bundle.manifest().unwrap();
        let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        let output = temp.path().join("export.docx");
        let typography = hcd_core::TypographyResolver::new("").unwrap();
        let summary = export(
            &bundle,
            &manifest,
            &layout,
            &output,
            HashMap::new(),
            &typography,
        )
        .unwrap();
        assert_eq!(bundle.manifest().unwrap().root_hash, manifest.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(summary.block_count > 0);
        let package = OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        let xml = package.read_part_xml("word/document.xml").unwrap();
        let document = roxmltree::Document::parse(&xml).unwrap();
        let sections: Vec<_> = document
            .descendants()
            .filter(|n| n.has_tag_name((W, "sectPr")))
            .collect();
        assert_eq!(sections.len(), layout.sections.len());
        assert!(!xml.contains("bookmarkStart"));
        for (actual, expected) in sections.iter().zip(&layout.sections) {
            if let Some(width) = expected.page.width_twips {
                assert_eq!(
                    actual
                        .children()
                        .find(|n| n.has_tag_name((W, "pgSz")))
                        .unwrap()
                        .attribute((W, "w")),
                    Some(width.to_string().as_str())
                );
            }
            assert_eq!(
                actual.children().any(|n| n.has_tag_name((W, "titlePg"))),
                expected.different_first_page
            );
        }
        let imported = temp.path().join("roundtrip.hcd");
        let mut options = hcd_docx::ImportOptions::new("roundtrip");
        options.flow_layout = true;
        hcd_docx::import_docx(&output, &imported, &options, |_| Ok(())).unwrap();
        let imported = Bundle::open(imported).unwrap();
        let reimported =
            hcd_core::read_flow_document_layout(&imported, &imported.manifest().unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(reimported.stories.len(), layout.stories.len());
        assert_eq!(reimported.even_and_odd_headers, layout.even_and_odd_headers);
        for (a, b) in reimported.sections.iter().zip(&layout.sections) {
            assert_eq!(a.page, b.page);
            assert_eq!(a.break_type, b.break_type);
            assert_eq!(a.headers.default.is_some(), b.headers.default.is_some());
            assert_eq!(a.headers.first.is_some(), b.headers.first.is_some());
            assert_eq!(a.headers.even.is_some(), b.headers.even.is_some());
            assert_eq!(a.footers.default.is_some(), b.footers.default.is_some());
        }
        let text = |bundle: &Bundle| {
            hcd_core::extract_text_page(bundle, None, 1000)
                .unwrap()
                .entries
                .into_iter()
                .map(|e| e.text)
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
        };
        assert_eq!(text(&imported), text(&bundle));
    }
    #[test]
    fn rich_stories_use_local_links_and_keep_body_separate() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("stories.docx");
        super::super::super::create::create_blank_docx(&output.to_string_lossy()).unwrap();
        let (_fixture_temp, bundle) = fixture();
        let layout = hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
            .unwrap()
            .unwrap();
        prepare_stories(&output, &layout).unwrap();
        let handler = WordHandler::open(&output.to_string_lossy(), true).unwrap();
        let paragraph = |text: &str, target: &str| docx_handler::RichParagraph {
            runs: vec![docx_handler::RichRun {
                text: text.into(),
                hyperlink: Some(target.into()),
                properties: HashMap::from([("bold".into(), "true".into())]),
                ..Default::default()
            }],
            ..Default::default()
        };
        handler
            .append_rich_blocks(&[docx_handler::RichBlock::Paragraph(paragraph(
                "Body",
                "https://example.com/body",
            ))])
            .unwrap();
        handler
            .append_rich_blocks_to(
                "/header[1]",
                &[
                    docx_handler::RichBlock::Paragraph(paragraph(
                        "Header",
                        "https://example.com/header",
                    )),
                    docx_handler::RichBlock::Table(vec![vec![paragraph(
                        "Cell",
                        "https://example.com/cell",
                    )]]),
                ],
            )
            .unwrap();
        handler
            .append_rich_blocks_to(
                "/footer[1]",
                &[docx_handler::RichBlock::Paragraph(paragraph(
                    "Footer",
                    "https://example.com/footer",
                ))],
            )
            .unwrap();
        assert!(handler
            .append_rich_blocks_to("/header[1]/p[1]", &[])
            .is_err());
        handler.save().unwrap();
        let package = OxmlPackage::open(&output.to_string_lossy(), false).unwrap();
        for (part, text, target) in [
            ("word/document.xml", "Body", "body"),
            ("word/header1.xml", "Header", "header"),
            ("word/footer1.xml", "Footer", "footer"),
        ] {
            let xml = package.read_part_xml(part).unwrap();
            let document = roxmltree::Document::parse(&xml).unwrap();
            assert!(document.descendants().any(|n| n.text() == Some(text)));
            let relationships = package.part_rels(part).unwrap();
            for link in document
                .descendants()
                .filter(|n| n.has_tag_name((W, "hyperlink")))
            {
                let rel = relationships
                    .get(link.attribute((R, "id")).unwrap())
                    .unwrap();
                assert!(
                    rel.target.ends_with(target)
                        || part.contains("header") && rel.target.ends_with("cell")
                );
            }
        }
        let before = handler
            .raw("/header[1]", handler_common::RawOptions::default())
            .unwrap();
        let rejected =
            docx_handler::RichBlock::Paragraph(paragraph("Invalid", "javascript:alert(1)"));
        assert!(handler
            .append_rich_blocks_to("/header[1]", &[rejected])
            .is_err());
        assert_eq!(
            handler
                .raw("/header[1]", handler_common::RawOptions::default())
                .unwrap(),
            before
        );
    }
    #[test]
    fn section_properties_keep_namespace_order_and_drop_stale_relationships() {
        let (_temp, bundle) = fixture();
        let layout = hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
            .unwrap()
            .unwrap();
        let mut section = layout.sections[0].clone();
        section.headers = Default::default();
        section.footers = Default::default();
        section.different_first_page = true;
        section.source.original_properties_xml = Some(format!(
            r#"<q:sectPr xmlns:q="{}" xmlns:rel="{}"><q:footnotePr><q:numFmt q:val="decimal"/></q:footnotePr><q:pgBorders><q:top q:val="single"/></q:pgBorders><q:cols q:num="2"/><q:docGrid q:linePitch="312"/><q:printerSettings rel:id="rIdMissing"/><q:sectPrChange q:id="12"><q:sectPr/></q:sectPrChange></q:sectPr>"#,
            hcd_core::WORD_STRICT_NS,
            R
        ));
        let mut warnings = BTreeSet::new();
        let xml = section_properties(&section, &HashMap::new(), &mut warnings).unwrap();
        let doc = roxmltree::Document::parse(&xml).unwrap();
        let names = doc
            .root_element()
            .children()
            .filter(|n| n.is_element())
            .map(|n| {
                assert_eq!(n.tag_name().namespace(), Some(W));
                n.tag_name().name()
            })
            .collect::<Vec<_>>();
        assert!(
            names.iter().position(|n| *n == "footnotePr") < names.iter().position(|n| *n == "pgSz")
        );
        assert!(
            names.iter().position(|n| *n == "titlePg") < names.iter().position(|n| *n == "docGrid")
        );
        assert!(!xml.contains("rIdMissing") && !xml.contains("sectPrChange"));
        assert!(!warnings.is_empty());
    }
    #[test]
    fn temporary_generation_failure_preserves_existing_output() {
        let (temp, bundle) = fixture();
        let manifest = bundle.manifest().unwrap();
        let mut layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        // A bad binding fails during OPC generation, after the temporary file
        // exists, without replacing the caller's existing destination.
        layout.sections[0].headers.default = Some("missing-story".into());
        let output = temp.path().join("keep.docx");
        std::fs::write(&output, b"Existing destination").unwrap();
        assert!(export(
            &bundle,
            &manifest,
            &layout,
            &output,
            HashMap::new(),
            &hcd_core::TypographyResolver::new("").unwrap()
        )
        .is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"Existing destination");
        assert!(!std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e
                .file_name()
                .to_string_lossy()
                .starts_with(".officecli-html-")));
    }
}
