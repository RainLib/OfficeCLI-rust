//! Bounded section metadata, read before the streaming body renderer. A sectPr
//! belongs to the paragraphs preceding it, not to the following section.
use super::*;

const MAX_SECTIONS: usize = 4096;

#[derive(Clone)]
pub(super) struct WordSection {
    pub end_paragraph: u64,
    pub layout: PageLayout,
    headers: [Option<String>; 3],
    footers: [Option<String>; 3],
    first_page: bool,
    even_pages: bool,
    break_kind: String,
    number_start: Option<u32>,
    grid_pitch: Option<u64>,
}

#[derive(Clone, Copy)]
pub(super) struct PageLayout {
    width: u64,
    height: u64,
    top: u64,
    right: u64,
    bottom: u64,
    left: u64,
    header: u64,
    footer: u64,
}

impl Default for WordSection {
    fn default() -> Self {
        Self {
            end_paragraph: u64::MAX,
            layout: PageLayout {
                width: 12240,
                height: 15840,
                top: 1440,
                right: 1440,
                bottom: 1440,
                left: 1440,
                header: 720,
                footer: 720,
            },
            headers: Default::default(),
            footers: Default::default(),
            first_page: false,
            even_pages: false,
            break_kind: "nextPage".into(),
            number_start: None,
            grid_pitch: None,
        }
    }
}

pub(super) fn part_key(part: &str) -> String {
    format!("wp_{}", &hcd_core::hash_bytes(part.as_bytes())[..16])
}

pub(super) fn section_at(sections: &[WordSection], ordinal: u64) -> Option<usize> {
    (!sections.is_empty()).then(|| {
        sections
            .partition_point(|section| section.end_paragraph < ordinal)
            .min(sections.len() - 1)
    })
}

impl WordSection {
    fn declarations(&self) -> String {
        let p = self.layout;
        let mut css = String::new();
        for (key, value) in [
            ("width", p.width),
            ("height", p.height),
            ("top", p.top),
            ("right", p.right),
            ("bottom", p.bottom),
            ("left", p.left),
            ("header-offset", p.header),
            ("footer-offset", p.footer),
        ] {
            css.push_str(&format!("--hcd-page-{key}:{:.2}pt;", value as f64 / 20.));
        }
        for (kind, refs) in [("header", &self.headers), ("footer", &self.footers)] {
            for (index, variant) in ["default", "first", "even"].iter().enumerate() {
                css.push_str(&format!(
                    "--hcd-page-{kind}-{variant}:{};",
                    refs[index]
                        .as_deref()
                        .map(part_key)
                        .unwrap_or_else(|| "none".into())
                ));
            }
        }
        css.push_str(&format!("--hcd-page-first:{};--hcd-page-even:{};--hcd-section-break:{};--hcd-page-number-start:{};", u8::from(self.first_page), u8::from(self.even_pages), self.break_kind, self.number_start.map(|n|n.to_string()).unwrap_or_else(||"auto".into())));
        css.push_str(&format!(
            "--hcd-grid-line-pitch:{:.2}pt;",
            self.grid_pitch.unwrap_or(0) as f64 / 20.
        ));
        css
    }
}

pub(super) fn stylesheet(sections: &[WordSection]) -> String {
    let Some(first) = sections.first() else {
        return String::new();
    };
    let p = first.layout;
    let mut css = format!("body[data-hcd-source-format=\"docx\"]{{width:{:.2}pt;max-width:{:.2}pt;min-width:0;min-height:{:.2}pt;padding:{:.2}pt {:.2}pt {:.2}pt {:.2}pt;{}}}",p.width as f64/20.,p.width as f64/20.,p.height as f64/20.,p.top as f64/20.,p.right as f64/20.,p.bottom as f64/20.,p.left as f64/20., first.declarations());
    for (index, section) in sections.iter().enumerate() {
        css.push_str(&format!(
            "[data-hcd-section=\"{index}\"]{{{}}}",
            section.declarations()
        ));
    }
    css
}

pub(super) fn load(archive: &mut StreamingOxmlArchive) -> Result<Vec<WordSection>, HcdError> {
    let mut relationships = HashMap::new();
    let rels = "word/_rels/document.xml.rels";
    if archive.contains(rels) {
        let bytes = archive
            .read_control_part(rels, MAX_CONTROL_PART_BYTES)
            .map_err(package_error)?;
        let mut reader = Reader::from_reader(bytes.as_slice());
        loop {
            match reader
                .read_event()
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
            {
                Event::Start(element) | Event::Empty(element)
                    if local_name(element.name().as_ref()) == "Relationship" =>
                {
                    if attribute_by_local_name(&element, "TargetMode")
                        .is_some_and(|s| s.eq_ignore_ascii_case("External"))
                    {
                        continue;
                    }
                    if let (Some(id), Some(target)) = (
                        attribute_by_local_name(&element, "Id"),
                        attribute_by_local_name(&element, "Target"),
                    ) {
                        let target = resolve_relationship_target("word/document.xml", &target)?;
                        if archive.contains(&target) {
                            relationships.insert(id, target);
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    let even_pages = if archive.contains("word/settings.xml") {
        let bytes = archive
            .read_control_part("word/settings.xml", MAX_CONTROL_PART_BYTES)
            .map_err(package_error)?;
        let mut reader = Reader::from_reader(bytes.as_slice());
        let mut even = false;
        loop {
            match reader
                .read_event()
                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
            {
                Event::Start(e) | Event::Empty(e)
                    if local_name(e.name().as_ref()) == "evenAndOddHeaders" =>
                {
                    even = on_off_value(attribute_by_local_name(&e, "val").as_deref())
                }
                Event::Eof => break,
                _ => {}
            }
        }
        even
    } else {
        false
    };
    archive
        .with_part("word/document.xml", |source| {
            parse(source, &relationships, even_pages)
                .map_err(|e| PackageError::ReadPartError(e.to_string()))
        })
        .map_err(package_error)
}

fn parse<R: Read>(
    source: R,
    relationships: &HashMap<String, String>,
    even_pages: bool,
) -> Result<Vec<WordSection>, HcdError> {
    let mut reader = Reader::from_reader(BufReader::new(source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    let mut path: Vec<String> = Vec::new();
    let mut section_depth = None;
    let mut ordinal = 0;
    let mut sections = Vec::new();
    let mut section = WordSection {
        even_pages,
        ..Default::default()
    };
    let mut elements = 0;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        let start = matches!(event, Event::Start(_));
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                elements += 1;
                if elements > MAX_XML_ELEMENTS || path.len() >= MAX_XML_DEPTH {
                    return Err(HcdError::ResourceLimit(
                        "Word section metadata exceeds XML safety limits".into(),
                    ));
                }
                let name = local_name(e.name().as_ref()).to_string();
                if name == "p" {
                    ordinal += 1;
                }
                if name == "sectPr"
                    && (path.iter().map(String::as_str).eq(["document", "body"])
                        || path
                            .iter()
                            .map(String::as_str)
                            .eq(["document", "body", "p", "pPr"]))
                {
                    section_depth = Some(path.len());
                }
                if section_depth.is_some_and(|depth| path.len() == depth + 1) {
                    capture(&mut section, e, relationships);
                }
                if start {
                    path.push(name);
                } else if name == "sectPr" && section_depth == Some(path.len()) {
                    finish(&mut sections, &mut section, ordinal)?;
                    section_depth = None;
                }
            }
            Event::End(_) => {
                path.pop();
                if section_depth == Some(path.len()) {
                    finish(&mut sections, &mut section, ordinal)?;
                    section_depth = None;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if sections.is_empty() || sections.last().is_some_and(|s| s.end_paragraph < ordinal) {
        finish(&mut sections, &mut section, ordinal)?;
    }
    Ok(sections)
}

fn finish(
    sections: &mut Vec<WordSection>,
    section: &mut WordSection,
    ordinal: u64,
) -> Result<(), HcdError> {
    if sections.len() >= MAX_SECTIONS {
        return Err(HcdError::ResourceLimit(
            "Word section limit exceeded".into(),
        ));
    }
    section.end_paragraph = ordinal;
    sections.push(section.clone());
    // Geometry and omitted header/footer references link to the previous
    // section. First-page behavior and page-number restarts do not inherit.
    section.first_page = false;
    section.number_start = None;
    section.break_kind = "nextPage".into();
    Ok(())
}

fn capture(section: &mut WordSection, e: &BytesStart<'_>, relationships: &HashMap<String, String>) {
    let value = attribute_by_local_name(e, "val");
    match local_name(e.name().as_ref()) {
        "pgSz" => {
            section.layout.width = dimension(e, "w", section.layout.width, false);
            section.layout.height = dimension(e, "h", section.layout.height, false);
        }
        "pgMar" => {
            let p = &mut section.layout;
            p.top = dimension(e, "top", p.top, true);
            p.right = dimension(e, "right", p.right, true);
            p.bottom = dimension(e, "bottom", p.bottom, true);
            p.left = dimension(e, "left", p.left, true);
            p.header = dimension(e, "header", p.header, true);
            p.footer = dimension(e, "footer", p.footer, true);
        }
        "docGrid" => {
            section.grid_pitch = attribute_by_local_name(e, "type")
                .filter(|kind| matches!(kind.as_str(), "lines" | "linesAndChars"))
                .and_then(|_| attribute_by_local_name(e, "linePitch"))
                .and_then(|pitch| pitch.parse::<u64>().ok())
                .filter(|pitch| (1..=200_000).contains(pitch));
        }
        "titlePg" => section.first_page = on_off_value(value.as_deref()),
        "type"
            if value.as_deref().is_some_and(|s| {
                matches!(
                    s,
                    "nextPage" | "continuous" | "oddPage" | "evenPage" | "nextColumn"
                )
            }) =>
        {
            section.break_kind = value.unwrap()
        }
        "pgNumType" => {
            section.number_start = attribute_by_local_name(e, "start")
                .and_then(|s| s.parse::<u32>().ok())
                .filter(|n| *n > 0 && *n <= 1_000_000)
        }
        "headerReference" | "footerReference" => {
            let refs = if local_name(e.name().as_ref()) == "headerReference" {
                &mut section.headers
            } else {
                &mut section.footers
            };
            let index = match attribute_by_local_name(e, "type").as_deref() {
                Some("first") => 1,
                Some("even") => 2,
                _ => 0,
            };
            if let Some(target) =
                attribute_by_local_name(e, "id").and_then(|id| relationships.get(&id))
            {
                refs[index] = Some(target.clone());
            }
        }
        _ => {}
    }
}

fn dimension(e: &BytesStart<'_>, name: &str, fallback: u64, zero: bool) -> u64 {
    attribute_by_local_name(e, name)
        .and_then(|s| s.parse().ok())
        .filter(|v| *v <= 200_000 && (zero || *v > 0))
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn section_line_grid_is_inherited_and_can_be_disabled() {
        let xml = r#"<w:document xmlns:w="w"><w:body>
        <w:p><w:pPr><w:sectPr><w:docGrid w:type="lines" w:linePitch="408"/></w:sectPr></w:pPr></w:p>
        <w:p><w:pPr><w:sectPr/></w:pPr></w:p>
        <w:sectPr><w:docGrid w:type="none" w:linePitch="408"/></w:sectPr>
        </w:body></w:document>"#;
        let sections = parse(xml.as_bytes(), &HashMap::new(), false).unwrap();
        assert_eq!(
            sections.iter().map(|s| s.grid_pitch).collect::<Vec<_>>(),
            vec![Some(408), Some(408), None]
        );
        let css = stylesheet(&sections);
        assert!(css.contains("--hcd-grid-line-pitch:20.40pt"));
        assert!(css.contains("--hcd-grid-line-pitch:0.00pt"));
        hcd_core::validate_css_text(&css).unwrap();
    }

    #[test]
    fn sections_apply_backwards_and_inherit_references_without_inheriting_restarts() {
        let xml = r#"<w:document xmlns:w="w" xmlns:r="r"><w:body><w:p/><w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="h"/><w:titlePg/><w:pgNumType w:start="3"/><w:pgSz w:w="12000" w:h="16000"/></w:sectPr></w:pPr></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="16000" w:h="12000"/><w:pgMar w:left="0"/></w:sectPr></w:body></w:document>"#;
        let sections = parse(
            xml.as_bytes(),
            &HashMap::from([("h".into(), "word/header1.xml".into())]),
            true,
        )
        .unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!(section_at(&sections, 2), Some(0));
        assert_eq!(section_at(&sections, 3), Some(1));
        assert_eq!(sections[0].layout.width, 12000);
        assert_eq!(sections[1].layout.width, 16000);
        assert_eq!(sections[1].layout.left, 0);
        assert_eq!(sections[1].headers, sections[0].headers);
        assert!(sections[0].first_page);
        assert!(!sections[1].first_page);
        assert_eq!(sections[0].number_start, Some(3));
        assert_eq!(sections[1].number_start, None);
        hcd_core::validate_css_text(&stylesheet(&sections)).unwrap();
    }
}
