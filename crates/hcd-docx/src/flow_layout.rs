//! Opt-in import of section-to-story relationships. Document XML is streamed;
//! only bounded section properties, relationships and settings are retained.
use hcd_core::{
    stable_node_id, FlowDocumentLayout, FlowPageSettings, FlowSection, FlowSectionSource,
    FlowStory, FlowStoryBindings, FlowStoryKind, HcdError, FLOW_LAYOUT_SCHEMA,
    MAX_CONTROL_PART_BYTES, MAX_FLOW_LAYOUT_BYTES, WORD_MAIN_NS, WORD_STRICT_NS,
};
use oxml::{PackageError, StreamingOxmlArchive};
use quick_xml::{
    events::{BytesStart, Event},
    name::{PrefixDeclaration, ResolveResult},
    NsReader, Writer,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{BufRead, BufReader},
};
const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_REL_NS: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const PACKAGE_REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
fn bad(message: impl Into<String>) -> HcdError {
    HcdError::InvalidBundle(format!("Word layout: {}", message.into()))
}
fn word(ns: ResolveResult<'_>) -> bool {
    matches!(ns,ResolveResult::Bound(value) if value.as_ref()==WORD_MAIN_NS.as_bytes()||value.as_ref()==WORD_STRICT_NS.as_bytes())
}
fn attr<B: BufRead>(
    reader: &NsReader<B>,
    element: &BytesStart<'_>,
    name: &str,
    relationship: bool,
) -> Result<Option<String>, HcdError> {
    let mut found = None;
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|error| bad(error.to_string()))?;
        let (ns, local) = reader.resolve_attribute(attribute.key);
        let matches = if relationship {
            matches!(ns,ResolveResult::Bound(value) if value.as_ref()==REL_NS.as_bytes()||value.as_ref()==STRICT_REL_NS.as_bytes())
        } else {
            word(ns)
        };
        if matches && local.as_ref() == name.as_bytes() {
            if found.is_some() {
                return Err(bad("duplicate attribute"));
            }
            found = Some(
                attribute
                    .unescape_value()
                    .map_err(|e| bad(e.to_string()))?
                    .into_owned(),
            )
        }
    }
    Ok(found)
}
fn on_off(value: Option<String>) -> Result<bool, HcdError> {
    match value.as_deref() {
        None | Some("true" | "on" | "1") => Ok(true),
        Some("false" | "off" | "0") => Ok(false),
        _ => Err(bad("invalid on/off value")),
    }
}
fn number<T: std::str::FromStr>(value: Option<String>) -> Result<Option<T>, HcdError> {
    value
        .map(|v| v.parse().map_err(|_| bad("invalid numeric property")))
        .transpose()
}
fn xml_text(bytes: &[u8]) -> Result<&str, HcdError> {
    std::str::from_utf8(bytes).map_err(|_| bad("metadata must use UTF-8"))
}

pub(crate) fn relationships(
    archive: &mut StreamingOxmlArchive,
) -> Result<BTreeMap<String, (FlowStoryKind, String)>, HcdError> {
    let path = "word/_rels/document.xml.rels";
    if !archive.contains(path) {
        return Ok(BTreeMap::new());
    }
    let bytes = archive
        .read_control_part(path, MAX_CONTROL_PART_BYTES)
        .map_err(|e| bad(e.to_string()))?;
    if bytes.windows(9).any(|s| s == b"<!DOCTYPE") {
        return Err(bad("DTD is unsupported"));
    }
    let doc = roxmltree::Document::parse(xml_text(&bytes)?).map_err(|e| bad(e.to_string()))?;
    if doc.root_element().tag_name() != (PACKAGE_REL_NS, "Relationships").into() {
        return Err(bad("invalid relationship root"));
    }
    let mut result = BTreeMap::new();
    let mut ids = HashSet::new();
    for node in doc.root_element().children().filter(|n| n.is_element()) {
        if node.tag_name() != (PACKAGE_REL_NS, "Relationship").into() {
            return Err(bad("unexpected relationship element"));
        }
        let id = node
            .attribute("Id")
            .ok_or_else(|| bad("relationship lacks Id"))?;
        if id.is_empty() || id.len() > 256 || !ids.insert(id) {
            return Err(bad("duplicate/invalid relationship Id"));
        }
        let Some(kind) = node.attribute("Type").and_then(|value| {
            [REL_NS, STRICT_REL_NS].iter().find_map(|prefix| {
                match value.strip_prefix(&format!("{prefix}/")) {
                    Some("header") => Some(FlowStoryKind::Header),
                    Some("footer") => Some(FlowStoryKind::Footer),
                    _ => None,
                }
            })
        }) else {
            continue;
        };
        if node
            .attribute("TargetMode")
            .is_some_and(|v| v != "Internal")
        {
            return Err(bad("external header/footer relationship is unsupported"));
        }
        let target = node
            .attribute("Target")
            .ok_or_else(|| bad("relationship lacks Target"))?;
        let part = crate::importer::resolve_relationship_target("word/document.xml", target)?;
        if !archive.contains(&part) {
            return Err(bad("missing header/footer part"));
        }
        result.insert(id.to_string(), (kind, part));
    }
    Ok(result)
}
fn even_headers(archive: &mut StreamingOxmlArchive) -> Result<bool, HcdError> {
    if !archive.contains("word/settings.xml") {
        return Ok(false);
    }
    let bytes = archive
        .read_control_part("word/settings.xml", MAX_CONTROL_PART_BYTES)
        .map_err(|e| bad(e.to_string()))?;
    if bytes.windows(9).any(|s| s == b"<!DOCTYPE") {
        return Err(bad("DTD is unsupported"));
    }
    let doc = roxmltree::Document::parse(xml_text(&bytes)?).map_err(|e| bad(e.to_string()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "settings"
        || !matches!(
            root.tag_name().namespace(),
            Some(WORD_MAIN_NS | WORD_STRICT_NS)
        )
    {
        return Err(bad("invalid settings root"));
    }
    let mut values = root.children().filter(|n| {
        n.is_element()
            && n.tag_name().name() == "evenAndOddHeaders"
            && matches!(
                n.tag_name().namespace(),
                Some(WORD_MAIN_NS | WORD_STRICT_NS)
            )
    });
    let Some(node) = values.next() else {
        return Ok(false);
    };
    if values.next().is_some() {
        return Err(bad("duplicate even/odd setting"));
    }
    let value = node
        .attribute((node.tag_name().namespace().unwrap(), "val"))
        .map(str::to_string);
    on_off(value)
}
fn check_story_root(
    archive: &mut StreamingOxmlArchive,
    part: &str,
    kind: FlowStoryKind,
) -> Result<(), HcdError> {
    archive
        .with_part(part, |source| {
            let mut reader = NsReader::from_reader(BufReader::new(source));
            let mut buffer = Vec::new();
            loop {
                match reader
                    .read_event_into(&mut buffer)
                    .map_err(|e| PackageError::ReadPartError(e.to_string()))?
                {
                    Event::Start(element) | Event::Empty(element) => {
                        let (ns, local) = reader.resolve_element(element.name());
                        let expected = if kind == FlowStoryKind::Header {
                            b"hdr".as_slice()
                        } else {
                            b"ftr".as_slice()
                        };
                        if !word(ns) || local.as_ref() != expected {
                            return Err(PackageError::ReadPartError(
                                "invalid header/footer XML root".into(),
                            ));
                        }
                        return Ok(());
                    }
                    Event::DocType(_) | Event::Eof => {
                        return Err(PackageError::ReadPartError(
                            "missing/unsafe header/footer root".into(),
                        ))
                    }
                    _ => {}
                }
                buffer.clear();
            }
        })
        .map_err(|e| bad(e.to_string()))
}
struct SectionBuilder {
    section: FlowSection,
    depth: usize,
    xml: Writer<Vec<u8>>,
    seen: HashSet<String>,
}
fn section(
    document_id: &str,
    index: usize,
    paragraph: Option<(u64, Option<String>)>,
) -> FlowSection {
    FlowSection {
        canonical_end_block_id: None,
        id: stable_node_id(&[document_id, "flow-section", &index.to_string()]),
        source: FlowSectionSource {
            part: "word/document.xml".into(),
            paragraph_ordinal: paragraph.as_ref().map(|p| p.0),
            paragraph_id: paragraph.and_then(|p| p.1),
            original_properties_xml: None,
        },
        different_first_page: false,
        break_type: None,
        page: FlowPageSettings::default(),
        headers: FlowStoryBindings::default(),
        footers: FlowStoryBindings::default(),
    }
}
fn self_contained<B: BufRead>(
    reader: &NsReader<B>,
    element: &BytesStart<'_>,
) -> Result<BytesStart<'static>, HcdError> {
    let mut result = element.to_owned();
    let present: HashSet<Vec<u8>> = element
        .attributes()
        .map(|a| {
            a.map(|a| a.key.as_ref().to_vec())
                .map_err(|e| bad(e.to_string()))
        })
        .collect::<Result<_, _>>()?;
    for (prefix, namespace) in reader.prefixes() {
        let name = match prefix {
            PrefixDeclaration::Default => "xmlns".into(),
            PrefixDeclaration::Named(value) => format!("xmlns:{}", xml_text(value)?),
        };
        if !present.contains(name.as_bytes()) {
            result.push_attribute((name.as_str(), xml_text(namespace.as_ref())?))
        }
    }
    Ok(result)
}
fn property<B: BufRead>(
    reader: &NsReader<B>,
    element: &BytesStart<'_>,
    name: &str,
    builder: &mut SectionBuilder,
    rels: &BTreeMap<String, (FlowStoryKind, String)>,
    story_ids: &HashMap<String, String>,
) -> Result<(), HcdError> {
    let value = || attr(reader, element, "val", false);
    if ["headerReference", "footerReference"].contains(&name) {
        let variant = attr(reader, element, "type", false)?
            .ok_or_else(|| bad("story reference lacks type"))?;
        if !["default", "first", "even"].contains(&variant.as_str())
            || !builder.seen.insert(format!("{name}:{variant}"))
        {
            return Err(bad("duplicate/invalid story reference"));
        }
        let rid = attr(reader, element, "id", true)?
            .ok_or_else(|| bad("story reference lacks relationship"))?;
        let (kind, part) = rels
            .get(&rid)
            .ok_or_else(|| bad("unknown story relationship"))?;
        if (*kind == FlowStoryKind::Header) != (name == "headerReference") {
            return Err(bad("header/footer relationship type mismatch"));
        }
        let id = story_ids
            .get(part)
            .ok_or_else(|| bad("missing story identity"))?
            .clone();
        let bindings = if *kind == FlowStoryKind::Header {
            &mut builder.section.headers
        } else {
            &mut builder.section.footers
        };
        match variant.as_str() {
            "default" => bindings.default = Some(id),
            "first" => bindings.first = Some(id),
            "even" => bindings.even = Some(id),
            _ => unreachable!(),
        };
        return Ok(());
    }
    if !["titlePg", "type", "pgSz", "pgMar", "pgNumType"].contains(&name) {
        return Ok(());
    }
    if !builder.seen.insert(name.to_string()) {
        return Err(bad("duplicate section property"));
    }
    match name {
        "titlePg" => builder.section.different_first_page = on_off(value()?)?,
        "type" => builder.section.break_type = value()?,
        "pgSz" => {
            builder.section.page.width_twips = number(attr(reader, element, "w", false)?)?;
            builder.section.page.height_twips = number(attr(reader, element, "h", false)?)?;
            builder.section.page.orientation = attr(reader, element, "orient", false)?
        }
        "pgMar" => {
            for key in [
                "top", "right", "bottom", "left", "header", "footer", "gutter",
            ] {
                if let Some(value) = number::<i32>(attr(reader, element, key, false)?)? {
                    builder.section.page.margins_twips.insert(key.into(), value);
                }
            }
        }
        "pgNumType" => {
            builder.section.page.number_start = number(attr(reader, element, "start", false)?)?;
            builder.section.page.number_format = attr(reader, element, "fmt", false)?
        }
        _ => {}
    }
    Ok(())
}
fn stream_sections<B: BufRead>(
    source: B,
    document_id: &str,
    rels: &BTreeMap<String, (FlowStoryKind, String)>,
    story_ids: &HashMap<String, String>,
) -> Result<Vec<FlowSection>, HcdError> {
    let mut reader = NsReader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut path: Vec<String> = Vec::new();
    let mut sections = Vec::new();
    let mut current: Option<SectionBuilder> = None;
    let mut paragraph = None;
    let mut ordinal = 0;
    let mut events = 0;
    let mut final_seen = false;
    let mut seen_root = false;
    let mut seen_body = false;
    let mut section_bytes = 0usize;
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| bad(e.to_string()))?;
        match &event {
            Event::Start(element) | Event::Empty(element) => {
                events += 1;
                if events > 3_000_000 || path.len() >= 256 {
                    return Err(bad("document XML limit"));
                }
                let empty = matches!(event, Event::Empty(_));
                let (ns, local) = reader.resolve_element(element.name());
                let name = if word(ns) {
                    xml_text(local.as_ref())?.to_string()
                } else {
                    String::new()
                };
                if path.is_empty() {
                    if name != "document" || seen_root {
                        return Err(bad("invalid/repeated document root"));
                    }
                    seen_root = true;
                }
                if path == ["document"] && name == "body" {
                    if seen_body {
                        return Err(bad("duplicate document body"));
                    }
                    seen_body = true;
                }
                if final_seen && path == ["document", "body"] {
                    return Err(bad("content after final section properties"));
                }
                if name == "p"
                    && path.first().is_some_and(|n| n == "document")
                    && path.get(1).is_some_and(|n| n == "body")
                {
                    ordinal += 1;
                    if path == ["document", "body"] {
                        let mut para_id = None;
                        for attribute in element.attributes() {
                            let a = attribute.map_err(|e| bad(e.to_string()))?;
                            let (ns, local) = reader.resolve_attribute(a.key);
                            if matches!(ns,ResolveResult::Bound(value) if value.as_ref()==b"http://schemas.microsoft.com/office/word/2010/wordml")
                                && local.as_ref() == b"paraId"
                            {
                                if para_id.is_some() {
                                    return Err(bad("duplicate paragraph identity"));
                                }
                                para_id = Some(
                                    a.unescape_value()
                                        .map_err(|e| bad(e.to_string()))?
                                        .into_owned(),
                                );
                            }
                        }
                        paragraph = Some((ordinal, para_id));
                    }
                }
                let is_section = name == "sectPr"
                    && (path == ["document", "body"] || path == ["document", "body", "p", "pPr"]);
                if is_section {
                    if sections.len() >= 4096 || current.is_some() {
                        return Err(bad("section count/structure limit"));
                    }
                    let source = if path == ["document", "body"] {
                        final_seen = true;
                        None
                    } else {
                        Some(
                            paragraph
                                .clone()
                                .ok_or_else(|| bad("section outside paragraph"))?,
                        )
                    };
                    let mut xml = Writer::new(Vec::new());
                    let start = self_contained(&reader, element)?;
                    xml.write_event(if empty {
                        Event::Empty(start)
                    } else {
                        Event::Start(start)
                    })
                    .map_err(|e| bad(e.to_string()))?;
                    current = Some(SectionBuilder {
                        section: section(document_id, sections.len(), source),
                        depth: path.len() + 1,
                        xml,
                        seen: HashSet::new(),
                    });
                } else if let Some(builder) = current.as_mut() {
                    if path.len() == builder.depth && !name.is_empty() {
                        property(&reader, element, &name, builder, rels, story_ids)?
                    }
                    builder
                        .xml
                        .write_event(event.clone())
                        .map_err(|e| bad(e.to_string()))?;
                }
                if empty {
                    if is_section {
                        let mut builder = current.take().unwrap();
                        builder.section.source.original_properties_xml = Some(
                            String::from_utf8(builder.xml.into_inner())
                                .map_err(|_| bad("non-UTF8 section"))?,
                        );
                        section_bytes += builder
                            .section
                            .source
                            .original_properties_xml
                            .as_ref()
                            .unwrap()
                            .len();
                        if section_bytes as u64 > MAX_FLOW_LAYOUT_BYTES {
                            return Err(bad("layout byte limit"));
                        }
                        sections.push(builder.section)
                    }
                    if name == "p" && path == ["document", "body"] {
                        paragraph = None
                    }
                } else {
                    path.push(name)
                }
            }
            Event::End(_) => {
                if let Some(builder) = current.as_mut() {
                    builder
                        .xml
                        .write_event(event.clone())
                        .map_err(|e| bad(e.to_string()))?;
                    if path.len() == builder.depth {
                        let mut builder = current.take().unwrap();
                        builder.section.source.original_properties_xml = Some(
                            String::from_utf8(builder.xml.into_inner())
                                .map_err(|_| bad("non-UTF8 section"))?,
                        );
                        section_bytes += builder
                            .section
                            .source
                            .original_properties_xml
                            .as_ref()
                            .unwrap()
                            .len();
                        if section_bytes as u64 > MAX_FLOW_LAYOUT_BYTES {
                            return Err(bad("layout byte limit"));
                        }
                        sections.push(builder.section)
                    }
                }
                if path == ["document", "body", "p"] {
                    paragraph = None
                }
                path.pop()
                    .ok_or_else(|| bad("unexpected closing element"))?;
            }
            Event::DocType(_) => return Err(bad("DTD is unsupported")),
            Event::Eof => break,
            _ => {
                if let Some(builder) = current.as_mut() {
                    builder
                        .xml
                        .write_event(event.clone())
                        .map_err(|e| bad(e.to_string()))?
                }
            }
        }
        if current
            .as_ref()
            .is_some_and(|b| b.xml.get_ref().len() > 1024 * 1024)
        {
            return Err(bad("section XML byte limit"));
        }
        buffer.clear();
    }
    if !seen_root || !seen_body || !path.is_empty() || current.is_some() {
        return Err(bad("incomplete document"));
    }
    if !final_seen {
        sections.push(section(document_id, sections.len(), None))
    }
    Ok(sections)
}

pub(crate) fn load_flow_layout(
    archive: &mut StreamingOxmlArchive,
    document_id: &str,
) -> Result<FlowDocumentLayout, HcdError> {
    let rels = relationships(archive)?;
    let mut parts = BTreeMap::new();
    for (kind, part) in rels.values() {
        if parts
            .insert(part.clone(), *kind)
            .is_some_and(|old| old != *kind)
        {
            return Err(bad("story part has conflicting kinds"));
        }
    }
    for entry in archive.entries() {
        if entry.name.ends_with(".xml") {
            if entry.name.starts_with("word/header") {
                parts
                    .entry(entry.name.clone())
                    .or_insert(FlowStoryKind::Header);
            } else if entry.name.starts_with("word/footer") {
                parts
                    .entry(entry.name.clone())
                    .or_insert(FlowStoryKind::Footer);
            }
        }
    }
    let mut stories = Vec::new();
    let mut story_ids = HashMap::new();
    for (part, kind) in parts {
        check_story_root(archive, &part, kind)?;
        let id = stable_node_id(&[document_id, "flow-story", &part]);
        story_ids.insert(part.clone(), id.clone());
        stories.push(FlowStory {
            id,
            kind,
            source_part: part,
        })
    }
    let sections = archive
        .with_part("word/document.xml", |source| {
            stream_sections(BufReader::new(source), document_id, &rels, &story_ids)
                .map_err(|e| PackageError::ReadPartError(e.to_string()))
        })
        .map_err(|e| bad(e.to_string()))?;
    let layout = FlowDocumentLayout {
        schema_version: FLOW_LAYOUT_SCHEMA.into(),
        even_and_odd_headers: even_headers(archive)?,
        sections,
        stories,
    };
    layout.validate()?;
    if serde_json::to_vec(&layout)?.len() as u64 > MAX_FLOW_LAYOUT_BYTES {
        return Err(bad("layout byte limit"));
    }
    Ok(layout)
}

#[cfg(test)]
mod tests {
    mod regions;
    use super::*;
    use hcd_core::{Bundle, FlowStoryVariant};
    use std::io::Write;
    fn document(body: &str) -> String {
        format!(
            r#"<w:document xmlns:w="{WORD_MAIN_NS}" xmlns:r="{REL_NS}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>{body}</w:body></w:document>"#
        )
    }
    fn fixture(source: &std::path::Path, body: &str, rels: &str, settings: &str) {
        let file = std::fs::File::create(source).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let mut parts=vec![("[Content_Types].xml".to_string(),r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_string()),("_rels/.rels".to_string(),format!(r#"<Relationships xmlns="{PACKAGE_REL_NS}"><Relationship Id="root" Type="{REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>"#)),("word/document.xml".into(),document(body)),("word/_rels/document.xml.rels".into(),format!(r#"<Relationships xmlns="{PACKAGE_REL_NS}">{rels}</Relationships>"#)),("word/settings.xml".into(),format!(r#"<w:settings xmlns:w="{WORD_MAIN_NS}">{settings}</w:settings>"#))];
        for (part, root, text) in [
            ("word/header1.xml", "hdr", "Default header"),
            ("word/header2.xml", "hdr", "Even header"),
            ("word/header3.xml", "hdr", "Unused header"),
            ("word/parts/custom.xml", "hdr", "First header"),
            ("word/footer1.xml", "ftr", "Default footer"),
            ("word/footer2.xml", "ftr", ""),
        ] {
            parts.push((part.into(),format!(r#"<w:{root} xmlns:w="{WORD_MAIN_NS}"><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:{root}>"#)))
        }
        let types = &mut parts[0].1;
        let mut overrides = String::from(
            r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
        );
        for (part, kind) in [
            ("word/header1.xml", "header"),
            ("word/header2.xml", "header"),
            ("word/header3.xml", "header"),
            ("word/parts/custom.xml", "header"),
            ("word/footer1.xml", "footer"),
            ("word/footer2.xml", "footer"),
            ("word/settings.xml", "settings"),
        ] {
            overrides.push_str(&format!(r#"<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>"#))
        }
        *types = types.replace("</Types>", &format!("{overrides}</Types>"));
        for (name, xml) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(xml.as_bytes()).unwrap()
        }
        zip.finish().unwrap();
    }
    fn rels() -> String {
        [
            ("hd", "header", "header1.xml"),
            ("he", "header", "header2.xml"),
            ("hf", "header", "parts/custom.xml"),
            ("fd", "footer", "footer1.xml"),
            ("ff", "footer", "footer2.xml"),
        ]
        .iter()
        .map(|(id, kind, part)| {
            format!(r#"<Relationship Id="{id}" Type="{REL_NS}/{kind}" Target="{part}"/>"#)
        })
        .collect()
    }
    fn body() -> String {
        r#"<w:p w14:paraId="P1"><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="hd"/><w:headerReference w:type="first" r:id="hf"/><w:footerReference w:type="default" r:id="fd"/><w:titlePg/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="-120" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:num="2"/><w:sectPrChange w:id="1"><w:sectPr><w:pgSz w:w="1" w:h="1"/></w:sectPr></w:sectPrChange></w:sectPr></w:pPr><w:r><w:t>Body one</w:t></w:r></w:p><w:p><w:r><w:t>Body two</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="even" r:id="he"/><w:footerReference w:type="first" r:id="ff"/><w:titlePg w:val="1"/><w:type w:val="continuous"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgNumType w:start="4" w:fmt="decimal"/></w:sectPr>"#.into()
    }
    fn imported(
        source: &std::path::Path,
        output: &std::path::Path,
        enabled: bool,
    ) -> Result<hcd_core::HcdManifest, HcdError> {
        let mut options = crate::ImportOptions::new("layout-test");
        options.flow_layout = enabled;
        crate::import_docx(source, output, &options, |_| Ok(()))
    }
    #[test]
    fn sections_keep_distinct_story_variants_links_dimensions_and_original_properties() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "<w:evenAndOddHeaders/>");
        let mut archive = StreamingOxmlArchive::open(&source).unwrap();
        let layout = load_flow_layout(&mut archive, "layout-test").unwrap();
        assert_eq!(layout.sections.len(), 2);
        assert_eq!(layout.stories.len(), 6);
        assert!(layout.even_and_odd_headers);
        assert_eq!(layout.sections[0].source.paragraph_ordinal, Some(1));
        assert_eq!(
            layout.sections[0].source.paragraph_id.as_deref(),
            Some("P1")
        );
        assert_eq!(layout.sections[0].page.width_twips, Some(12240));
        assert_eq!(layout.sections[0].page.margins_twips["top"], -120);
        assert_eq!(layout.sections[1].page.number_start, Some(4));
        assert_eq!(
            layout.sections[1].page.orientation.as_deref(),
            Some("landscape")
        );
        assert_eq!(layout.sections[1].headers.default, None);
        let first = &layout.sections[0]
            .source
            .original_properties_xml
            .as_ref()
            .unwrap();
        assert!(first.contains("w:cols"));
        assert!(first.contains("sectPrChange"));
        assert!(roxmltree::Document::parse(first).is_ok());
        assert_eq!(
            layout
                .story_for_page(1, FlowStoryKind::Header, false, false)
                .unwrap()
                .source_part,
            "word/header1.xml"
        );
        assert_eq!(
            layout
                .story_for_page(1, FlowStoryKind::Header, true, false)
                .unwrap()
                .source_part,
            "word/parts/custom.xml"
        );
        assert_eq!(
            layout
                .story_for_page(1, FlowStoryKind::Header, false, true)
                .unwrap()
                .source_part,
            "word/header2.xml"
        );
        assert!(layout
            .story_for_page(0, FlowStoryKind::Footer, true, false)
            .is_none());
        assert_eq!(
            layout
                .story_for_page(1, FlowStoryKind::Footer, true, false)
                .unwrap()
                .source_part,
            "word/footer2.xml"
        );
        assert_eq!(
            layout.sections[1].headers.get(FlowStoryVariant::Default),
            None
        );
    }
    #[test]
    fn internal_import_indexes_layout_and_arbitrary_named_header_without_activating_default_import()
    {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "<w:evenAndOddHeaders/>");
        let target = tmp.path().join("layout.hcd");
        let manifest = imported(&source, &target, true).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        assert_eq!(manifest.capabilities.flow_layout, Some(1));
        let mut missing_model = manifest.clone();
        missing_model.capabilities.flow_layout = None;
        assert!(hcd_core::read_flow_document_layout(&bundle, &missing_model).is_err());
        let mut future_model = manifest.clone();
        future_model.capabilities.flow_layout = Some(2);
        assert!(hcd_core::read_flow_document_layout(&bundle, &future_model).is_err());
        let layout = hcd_core::read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        assert_eq!(layout.sections.len(), 2);
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        assert_eq!(projection.flow_layout, Some(layout.clone()));
        assert!(projection
            .blocks
            .iter()
            .any(|block| block.region == "header"
                && block
                    .content
                    .inlines
                    .iter()
                    .any(|inline| inline.text == "First header")));
        assert!(projection
            .blocks
            .iter()
            .filter(|b| b.region != "body")
            .all(|b| b.read_only));
        let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
        std::fs::remove_file(&source).unwrap();
        let reopened = Bundle::open(portable.directory.path()).unwrap();
        assert_eq!(
            hcd_core::read_flow_document_layout(&reopened, &reopened.manifest().unwrap()).unwrap(),
            Some(layout)
        );
        assert!(hcd_core::validate_bundle(&reopened).unwrap().valid);
        fixture(&source, &body(), &rels(), "");
        let plain = tmp.path().join("plain.hcd");
        let plain_manifest = imported(&source, &plain, false).unwrap();
        assert_eq!(plain_manifest.capabilities.flow_layout, None);
        let mut missing_data = plain_manifest.clone();
        missing_data.capabilities.flow_layout = Some(1);
        assert!(
            hcd_core::read_flow_document_layout(&Bundle::open(&plain).unwrap(), &missing_data)
                .is_err()
        );
        assert!(hcd_core::read_flow_document_layout(
            &Bundle::open(plain).unwrap(),
            &plain_manifest
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn implicit_final_section_and_disabled_first_even_stories_do_not_copy_or_guess_content() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(
            &source,
            "<w:p><w:r><w:t>Only body</w:t></w:r></w:p>",
            &rels(),
            "<w:evenAndOddHeaders w:val=\"false\"/>",
        );
        let mut archive = StreamingOxmlArchive::open(&source).unwrap();
        let layout = load_flow_layout(&mut archive, "layout-test").unwrap();
        assert_eq!(layout.sections.len(), 1);
        assert_eq!(layout.sections[0].page.width_twips, None);
        assert!(layout.sections[0].source.original_properties_xml.is_none());
        assert!(!layout.even_and_odd_headers);
        assert!(layout
            .story_for_page(0, FlowStoryKind::Header, true, true)
            .is_none());
    }
    #[test]
    fn wrong_missing_duplicate_external_relationships_and_invalid_properties_refuse() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        for (b, r, s) in [
            (
                body().replace("r:id=\"hd\"", "r:id=\"missing\""),
                rels(),
                String::new(),
            ),
            (
                body().replace("r:id=\"hd\"", "r:id=\"fd\""),
                rels(),
                String::new(),
            ),
            (body(), format!("{}{}", rels(), rels()), String::new()),
            (
                body(),
                rels().replace(
                    "Target=\"header1.xml\"",
                    "Target=\"https://private.invalid/doc.xml\" TargetMode=\"External\"",
                ),
                String::new(),
            ),
            (
                body().replace("w:w=\"12240\"", "w:w=\"0\""),
                rels(),
                String::new(),
            ),
            (
                body(),
                rels(),
                "<w:evenAndOddHeaders w:val=\"maybe\"/>".into(),
            ),
            (
                body().replace("<w:titlePg/>", "<w:titlePg/><w:titlePg/>"),
                rels(),
                String::new(),
            ),
        ] {
            fixture(&source, &b, &r, &s);
            let mut archive = StreamingOxmlArchive::open(&source).unwrap();
            assert!(
                load_flow_layout(&mut archive, "layout-test").is_err(),
                "accepted bad source {b}"
            );
        }
    }
    #[test]
    fn final_section_must_be_last_and_historical_properties_are_not_current_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, "<w:sectPr/><w:p/>", &rels(), "");
        let mut archive = StreamingOxmlArchive::open(&source).unwrap();
        assert!(load_flow_layout(&mut archive, "layout-test").is_err());
        fixture(&source,"<w:p><w:pPr><w:pPrChange><w:pPr><w:sectPr><w:pgSz w:w=\"1\" w:h=\"1\"/></w:sectPr></w:pPr></w:pPrChange></w:pPr></w:p><w:sectPr/>",&rels(),"");
        let mut archive = StreamingOxmlArchive::open(&source).unwrap();
        let layout = load_flow_layout(&mut archive, "layout-test").unwrap();
        assert_eq!(layout.sections.len(), 1);
        assert_eq!(layout.sections[0].page.width_twips, None);
    }
    #[test]
    fn canonical_regions_upgrade_and_rich_edits_keep_sections_stories_and_history() {
        use hcd_core::{
            BlockPrecondition, EditorBlockContent, EditorBlockKind, EditorInline, FlowRegionEdits,
            FlowStructurePatchBatch, StructureOperation,
        };
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "<w:evenAndOddHeaders/>");
        let target = tmp.path().join("layout.hcd");
        imported(&source, &target, true).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        let initial = hcd_core::editor_projection(&bundle, None).unwrap();
        let r0 = serde_json::to_value(&initial).unwrap();
        assert_eq!(
            hcd_core::project_flow_regions(&bundle, 0).unwrap().revision,
            1
        );
        let projected = hcd_core::editor_projection(&bundle, None).unwrap();
        let layout = projected.flow_layout.as_ref().unwrap();
        assert_eq!(layout.schema_version, hcd_core::FLOW_REGION_LAYOUT_SCHEMA);
        assert_eq!(bundle.manifest().unwrap().capabilities.flow_layout, Some(2));
        assert!(projected.blocks.iter().all(|b| b.flow_region_id.is_some()));
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{report:?}");
        assert_eq!(
            serde_json::to_value(hcd_core::editor_projection(&bundle, Some(0)).unwrap()).unwrap(),
            r0
        );
        let entries = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
        let mut groups = Vec::new();
        for (old, new) in [
            ("Body one", "Rich body"),
            ("Default header", "Rich header"),
            ("Default footer", "Rich footer"),
        ] {
            let node = entries.entries.iter().find(|e| e.text == old).unwrap();
            let block = projected
                .blocks
                .iter()
                .find(|b| {
                    b.content
                        .inlines
                        .iter()
                        .any(|i| i.node_id.as_ref() == Some(&node.node_id))
                })
                .unwrap();
            assert!(!block.read_only);
            groups.push(FlowRegionEdits {
                region_id: block.flow_region_id.clone().unwrap(),
                operations: vec![StructureOperation::Replace {
                    block_id: block.block_id.clone(),
                    block: EditorBlockContent {
                        kind: EditorBlockKind::Paragraph,
                        inlines: vec![EditorInline {
                            text: new.into(),
                            bold: true,
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                    precondition: BlockPrecondition {
                        block_hash: block.block_hash.clone(),
                    },
                }],
            });
        }
        let patch = FlowStructurePatchBatch {
            schema_version: "hcd-patch/6".into(),
            document_id: "layout-test".into(),
            patch_id: "joint-region-rich".into(),
            base_revision: 1,
            layout_hash: hcd_core::flow_layout_hash(layout).unwrap(),
            actor: BTreeMap::from([
                ("userId".into(), "alice".into()),
                ("displayName".into(), "Alice".into()),
            ]),
            regions: groups,
        };
        let result = hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
        assert_eq!(result.revision, 2);
        assert_eq!(
            bundle.revision(2).unwrap().author_id.as_deref(),
            Some("alice")
        );
        let after = hcd_core::editor_projection(&bundle, None).unwrap();
        for (text, part) in [
            ("Rich body", "word/document.xml"),
            ("Rich header", "word/header1.xml"),
            ("Rich footer", "word/footer1.xml"),
        ] {
            let nodes = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
            let entry = nodes.entries.iter().find(|e| e.text == text).unwrap();
            assert_eq!(entry.source.part, part);
            assert!(after.blocks.iter().any(|b| b
                .content
                .inlines
                .iter()
                .any(|i| i.text == text && i.bold)));
        }
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        assert_eq!(
            hcd_core::apply_flow_structure_patch(&bundle, &patch, 1)
                .unwrap()
                .revision,
            2
        );
        assert_eq!(
            serde_json::to_value(hcd_core::editor_projection(&bundle, Some(1)).unwrap()).unwrap(),
            serde_json::to_value(&projected).unwrap()
        );
        let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
        let reopened = Bundle::open(portable.directory.path()).unwrap();
        assert!(hcd_core::validate_bundle(&reopened).unwrap().valid);
        for revision in 0..=2 {
            assert_eq!(
                serde_json::to_value(hcd_core::editor_projection(&bundle, Some(revision)).unwrap())
                    .unwrap(),
                serde_json::to_value(
                    hcd_core::editor_projection(&reopened, Some(revision)).unwrap()
                )
                .unwrap()
            );
        }
        hcd_core::restore_revision(&bundle, 0, 2, Some("alice".into()), Some("Alice".into()))
            .unwrap();
        assert_eq!(bundle.manifest().unwrap().capabilities.flow_layout, Some(1));
        let late = hcd_core::apply_flow_structure_patch(&bundle, &patch, 1).unwrap();
        assert!(late.idempotent_replay);
        assert_eq!(late.revision, 2);
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        let restored = hcd_core::editor_projection(&bundle, None).unwrap();
        assert_eq!(restored.blocks.len(), initial.blocks.len());
        assert_eq!(
            serde_json::to_value(restored.flow_layout).unwrap(),
            serde_json::to_value(initial.flow_layout).unwrap()
        );
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let original_export = tmp.path().join("r0.docx");
        crate::export_docx(
            &target,
            &source,
            &original_export,
            &crate::ExportOptions {
                revision: Some(0),
                fidelity_report: None,
            },
        )
        .unwrap();
    }
    #[test]
    fn body_header_and_footer_text_commit_together_and_source_export_preserves_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "<w:evenAndOddHeaders/>");
        let target = tmp.path().join("layout.hcd");
        imported(&source, &target, true).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        let original_layout =
            hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
                .unwrap()
                .unwrap();
        let before = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
        let operations = [
            ("Body one", "Body edited"),
            ("Default header", "Header edited"),
            ("Default footer", "Footer edited"),
        ]
        .iter()
        .map(|(old, new)| {
            let entry = before.entries.iter().find(|e| e.text == *old).unwrap();
            hcd_core::PatchOperation::TextSplice {
                node_id: entry.node_id.clone(),
                start: 0,
                delete_count: old.chars().count(),
                insert_text: (*new).into(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: entry.node_hash.clone(),
                },
            }
        })
        .collect();
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "layout-test".into(),
            patch_id: "three-regions".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations,
            metadata: BTreeMap::new(),
        };
        let baseline = std::fs::read(target.join("manifest.json")).unwrap();
        let mut invalid = patch.clone();
        if let hcd_core::PatchOperation::TextSplice { precondition, .. } =
            &mut invalid.operations[1]
        {
            precondition.node_hash = "0".repeat(64)
        }
        assert!(hcd_core::apply_patch(&bundle, &invalid, 0).is_err());
        assert_eq!(
            std::fs::read(target.join("manifest.json")).unwrap(),
            baseline
        );
        assert_eq!(
            hcd_core::extract_text_page(&bundle, None, 1000)
                .unwrap()
                .entries
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            before
                .entries
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert_eq!(
            hcd_core::read_flow_document_layout(&bundle, &bundle.manifest().unwrap()).unwrap(),
            Some(original_layout.clone())
        );
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let saved = tmp.path().join("saved.docx");
        crate::export_docx(&target, &source, &saved, &crate::ExportOptions::default()).unwrap();
        let old = tmp.path().join("r0.docx");
        crate::export_docx(
            &target,
            &source,
            &old,
            &crate::ExportOptions {
                revision: Some(0),
                fidelity_report: None,
            },
        )
        .unwrap();
        let read_part = |path: &std::path::Path, part: &str| {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
            let mut value = String::new();
            std::io::Read::read_to_string(&mut zip.by_name(part).unwrap(), &mut value).unwrap();
            value
        };
        for part in [
            "word/_rels/document.xml.rels",
            "word/settings.xml",
            "[Content_Types].xml",
            "word/parts/custom.xml",
            "word/header2.xml",
            "word/header3.xml",
            "word/footer2.xml",
        ] {
            assert_eq!(read_part(&saved, part), read_part(&source, part));
        }
        let source_doc = read_part(&source, "word/document.xml");
        let saved_doc = read_part(&saved, "word/document.xml");
        let sections = |xml: &str| {
            let document = roxmltree::Document::parse(xml).unwrap();
            document
                .descendants()
                .filter(|node| node.tag_name().name() == "sectPr" && node.is_element())
                .map(|node| xml[node.range()].to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(sections(&source_doc), sections(&saved_doc));
        assert!(saved_doc.contains("Body edited"));
        assert!(read_part(&saved, "word/header1.xml").contains("Header edited"));
        assert!(read_part(&saved, "word/footer1.xml").contains("Footer edited"));
        assert_eq!(read_part(&old, "word/document.xml"), source_doc);
        let committed = std::fs::read(target.join("manifest.json")).unwrap();
        assert!(matches!(
            hcd_core::append_comment(
                &bundle,
                1,
                "Review",
                "flow-review-blocked",
                &BTreeMap::new()
            ),
            Err(HcdError::Unsupported(_))
        ));
        assert!(matches!(
            hcd_core::resolve_tracked_change(
                &bundle,
                1,
                "1",
                true,
                "flow-tracked-blocked",
                &BTreeMap::new()
            ),
            Err(HcdError::Unsupported(_))
        ));
        assert_eq!(
            std::fs::read(target.join("manifest.json")).unwrap(),
            committed
        );
        let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
        let reopened = Bundle::open(portable.directory.path()).unwrap();
        assert_eq!(
            hcd_core::read_flow_document_layout(&reopened, &reopened.manifest().unwrap()).unwrap(),
            Some(original_layout)
        );
        assert!(hcd_core::project_editor(&reopened, 1).is_err());
        if let Some(root) = std::env::var_os("HCD_FLOW_LAYOUT_EVIDENCE") {
            let root = std::path::PathBuf::from(root);
            std::fs::create_dir_all(&root).unwrap();
            for (name, path) in [
                ("source.docx", source.as_path()),
                ("saved.docx", saved.as_path()),
                ("r0.docx", old.as_path()),
            ] {
                std::fs::copy(path, root.join(name)).unwrap();
            }
            fn copy(from: &std::path::Path, to: &std::path::Path) {
                std::fs::create_dir_all(to).unwrap();
                for entry in std::fs::read_dir(from).unwrap() {
                    let entry = entry.unwrap();
                    if entry.file_type().unwrap().is_dir() {
                        copy(&entry.path(), &to.join(entry.file_name()))
                    } else {
                        std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
                    }
                }
            }
            copy(portable.directory.path(), &root.join("saved.hcd"));
            std::fs::write(
                root.join("projection-r1.json"),
                serde_json::to_vec_pretty(&hcd_core::editor_projection(&reopened, None).unwrap())
                    .unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn opaque_fields_survive_offline_and_cached_results_cannot_be_edited() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "");
        let field_xml = format!(
            r#"<w:hdr xmlns:w="{WORD_MAIN_NS}"><w:p><w:r><w:t>Editable header</w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple><w:fldSimple w:instr=" CUSTOM &quot;opaque&quot; "/><w:fldSimple w:instr=" HYPERLINK &quot;https://example.com&quot; "><w:r><w:t>Link label</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUM</w:instrText></w:r><w:r><w:instrText>PAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>10</w:t></w:r></w:p><w:p><w:r><w:t>pages</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"></w:fldChar></w:r><w:r><w:instrText>DATE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"></w:fldChar></w:r><w:r><w:t>Cached date</w:t></w:r><w:r><w:fldChar w:fldCharType="end"></w:fldChar></w:r></w:p></w:hdr>"#
        );
        let mut original = zip::ZipArchive::new(std::fs::File::open(&source).unwrap()).unwrap();
        let rewritten = tmp.path().join("fields.docx");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&rewritten).unwrap());
        for index in 0..original.len() {
            let mut part = original.by_index(index).unwrap();
            writer
                .start_file(part.name(), zip::write::SimpleFileOptions::default())
                .unwrap();
            if part.name() == "word/header1.xml" {
                writer.write_all(field_xml.as_bytes()).unwrap();
            } else {
                std::io::copy(&mut part, &mut writer).unwrap();
            }
        }
        writer.finish().unwrap();
        let target = tmp.path().join("fields.hcd");
        let mut options = crate::ImportOptions::new("layout-test");
        options.flow_layout = true;
        options.chunk_soft_bytes = 512;
        crate::import_docx(&rewritten, &target, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        let report = hcd_core::validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{report:?}");
        let page = hcd_core::extract_text_page(&bundle, None, 1000).unwrap();
        for text in ["4", "10", "pages", "Cached date"] {
            let entry = page
                .entries
                .iter()
                .find(|entry| entry.text == text)
                .unwrap();
            assert!(!entry.source.editable, "editable field cache: {text}");
            let patch = hcd_core::PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "layout-test".into(),
                patch_id: format!("forbidden-{}", entry.node_id),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![hcd_core::PatchOperation::TextSplice {
                    node_id: entry.node_id.clone(),
                    start: 0,
                    delete_count: 0,
                    insert_text: "bad".into(),
                    precondition: hcd_core::NodePrecondition {
                        node_hash: entry.node_hash.clone(),
                    },
                }],
            };
            assert!(hcd_core::apply_patch(&bundle, &patch, 0).is_err());
            assert_eq!(bundle.manifest().unwrap().revision, 0);
        }
        for text in ["Editable header", "Link label"] {
            assert!(
                page.entries
                    .iter()
                    .find(|entry| entry.text == text)
                    .unwrap()
                    .source
                    .editable
            );
        }
        let projection = hcd_core::editor_projection(&bundle, None).unwrap();
        assert!(projection
            .blocks
            .iter()
            .filter(|block| block.region == "header")
            .all(|block| block.read_only));
        let portable = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
        let reopened = Bundle::open(portable.directory.path()).unwrap();
        let manifest = reopened.manifest().unwrap();
        let mut html = String::new();
        for number in 0..manifest.index_page_count {
            for chunk in reopened.read_index_page(&manifest, number).unwrap().chunks {
                html.push_str(&reopened.read_chunk(&chunk).unwrap());
            }
        }
        for instruction in [" PAGE ", " NUMPAGES ", " CUSTOM ", "DATE", " HYPERLINK "] {
            assert!(html.contains(instruction), "missing {instruction}");
        }
        assert_eq!(html.matches("data-hcd-word-field-definition=").count(), 5);
        assert_eq!(html.matches("data-hcd-word-field-start=").count(), 5);
        assert!(hcd_core::validate_bundle(&reopened).unwrap().valid);
        let changes = [
            ("Body one", "Body field test"),
            ("Editable header", "Header field test"),
            ("Default footer", "Footer field test"),
            ("Link label", "Updated link"),
        ];
        let patch = hcd_core::PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "layout-test".into(),
            patch_id: "field-preserving-joint-edit".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: changes
                .iter()
                .map(|(old, new)| {
                    let entry = page
                        .entries
                        .iter()
                        .find(|entry| entry.text == *old)
                        .unwrap();
                    hcd_core::PatchOperation::TextSplice {
                        node_id: entry.node_id.clone(),
                        start: 0,
                        delete_count: old.chars().count(),
                        insert_text: (*new).into(),
                        precondition: hcd_core::NodePrecondition {
                            node_hash: entry.node_hash.clone(),
                        },
                    }
                })
                .collect(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        let exported = tmp.path().join("export.docx");
        crate::export_docx(
            &target,
            &rewritten,
            &exported,
            &crate::ExportOptions::default(),
        )
        .unwrap();
        let mut exported = zip::ZipArchive::new(std::fs::File::open(exported).unwrap()).unwrap();
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut exported.by_name("word/header1.xml").unwrap(), &mut xml)
            .unwrap();
        assert_eq!(
            xml,
            field_xml
                .replace("Editable header", "Header field test")
                .replace("Link label", "Updated link")
        );
        let portable_saved = hcd_core::create_portable_snapshot(&bundle, None).unwrap();
        let reopened_saved = Bundle::open(portable_saved.directory.path()).unwrap();
        assert!(hcd_core::validate_bundle(&reopened_saved).unwrap().valid);
        let saved_page = hcd_core::extract_text_page(&reopened_saved, None, 1000).unwrap();
        for text in ["4", "10", "pages", "Cached date"] {
            assert!(
                !saved_page
                    .entries
                    .iter()
                    .find(|entry| entry.text == text)
                    .unwrap()
                    .source
                    .editable
            );
        }
        std::fs::remove_file(rewritten).unwrap();
        assert!(hcd_core::validate_bundle(&reopened).unwrap().valid);
        assert!(hcd_core::validate_bundle(&reopened_saved).unwrap().valid);
    }
    #[test]
    fn layout_asset_bytes_and_future_schema_are_checked_before_projection() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source.docx");
        fixture(&source, &body(), &rels(), "");
        let target = tmp.path().join("layout.hcd");
        let manifest = imported(&source, &target, true).unwrap();
        let bundle = Bundle::open(&target).unwrap();
        let assets = bundle.read_asset_index().unwrap();
        let asset = assets
            .iter()
            .find(|a| a.source_part == hcd_core::FLOW_LAYOUT_SOURCE_PART)
            .unwrap();
        let path = bundle.resolve_href(&asset.href).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"changed").unwrap();
        assert!(hcd_core::read_flow_document_layout(&bundle, &manifest).is_err());
        assert!(hcd_core::editor_projection(&bundle, None).is_err());
        assert!(!hcd_core::validate_bundle(&bundle).unwrap().valid);
        let output = tmp.path().join("invalid.docx");
        assert!(
            crate::export_docx(&target, &source, &output, &crate::ExportOptions::default())
                .is_err()
        );
        assert!(!output.exists());
        std::fs::write(&path, &bytes).unwrap();
        assert!(hcd_core::validate_bundle(&bundle).unwrap().valid);
        for version in [None, Some(99)] {
            let mut invalid = manifest.clone();
            invalid.capabilities.flow_layout = version;
            std::fs::write(
                target.join("manifest.json"),
                serde_json::to_vec(&invalid).unwrap(),
            )
            .unwrap();
            assert!(crate::export_docx(
                &target,
                &source,
                &output,
                &crate::ExportOptions::default()
            )
            .is_err());
            assert!(!output.exists());
            std::fs::write(&output, b"owned-existing-output").unwrap();
            assert!(crate::export_docx(
                &target,
                &source,
                &output,
                &crate::ExportOptions::default()
            )
            .is_err());
            assert_eq!(std::fs::read(&output).unwrap(), b"owned-existing-output");
            std::fs::remove_file(&output).unwrap();
        }
        std::fs::write(
            target.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["schemaVersion"] = "future/9".into();
        let bytes = serde_json::to_vec(&value).unwrap();
        let hash = hcd_core::hash_bytes(&bytes);
        let href = format!("assets/sha256/{hash}.json");
        std::fs::write(target.join(&href), &bytes).unwrap();
        let mut updated = assets;
        let asset = updated
            .iter_mut()
            .find(|a| a.source_part == hcd_core::FLOW_LAYOUT_SOURCE_PART)
            .unwrap();
        asset.hash = hash;
        asset.href = href;
        asset.byte_length = bytes.len() as u64;
        std::fs::write(
            target.join("assets/index.json"),
            serde_json::to_vec(&updated).unwrap(),
        )
        .unwrap();
        assert!(hcd_core::read_flow_document_layout(&bundle, &manifest).is_err());
    }
    #[test]
    fn namespaced_historical_and_foreign_properties_do_not_override_current_geometry() {
        let xml=document("<w:p/><w:sectPr xmlns:x='urn:other'><x:pgSz w:w='1' w:h='1'/><w:pgSz w:w='12240' w:h='15840'/><w:sectPrChange><w:sectPr><w:pgSz w:w='2' w:h='2'/></w:sectPr></w:sectPrChange></w:sectPr>");
        let sections = stream_sections(
            std::io::Cursor::new(xml),
            "test",
            &BTreeMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].page.width_twips, Some(12240));
        assert!(sections[0]
            .source
            .original_properties_xml
            .as_ref()
            .unwrap()
            .contains("x:pgSz"));
        let xml = document(&"<w:p><w:pPr><w:sectPr/></w:pPr></w:p>".repeat(4097));
        assert!(stream_sections(
            std::io::Cursor::new(xml),
            "test",
            &BTreeMap::new(),
            &HashMap::new()
        )
        .is_err());
        let xml = document(&format!("<w:p>{}</w:p>", "<w:custom>".repeat(257)));
        assert!(stream_sections(
            std::io::Cursor::new(xml),
            "test",
            &BTreeMap::new(),
            &HashMap::new()
        )
        .is_err());
    }
}
