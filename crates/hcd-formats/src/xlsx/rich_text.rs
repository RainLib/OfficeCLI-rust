use super::*;
use hcd_core::XlsxInlineRun;
use serde::Deserialize;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct RichString {
    pub text: String,
    pub runs: Vec<XlsxInlineRun>,
}

#[derive(Default)]
pub(super) struct RichStringBuilder {
    value: RichString,
    run: Option<XlsxInlineRun>,
    properties: bool,
    text: bool,
    phonetic: bool,
}

impl RichStringBuilder {
    pub fn observe(&mut self, event: &Event<'_>) -> Result<(), HcdError> {
        match event {
            Event::Start(start) | Event::Empty(start) => {
                let name = start.name();
                let name = local_name(name.as_ref());
                match name {
                    "rPh" => self.phonetic = matches!(event, Event::Start(_)),
                    "r" if !self.phonetic => self.run = Some(XlsxInlineRun::default()),
                    "rPr" => self.properties = matches!(event, Event::Start(_)),
                    "t" => self.text = !self.phonetic && matches!(event, Event::Start(_)),
                    _ if self.properties => {
                        let mut attrs = BTreeMap::new();
                        for attr in start.attributes() {
                            let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                            let key = std::str::from_utf8(attr.key.as_ref())
                                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                            if key == "xmlns" || key.starts_with("xmlns:") {
                                continue;
                            }
                            attrs.insert(
                                key.to_string(),
                                attr.unescape_value()
                                    .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                                    .into_owned(),
                            );
                        }
                        let run = self.run.as_mut().ok_or_else(|| {
                            HcdError::InvalidBundle("XLSX rPr outside rich run".into())
                        })?;
                        run.properties.insert(name.to_string(), attrs);
                        hcd_core::validate_xlsx_run_properties(&run.properties)?;
                    }
                    _ => {}
                }
            }
            Event::Text(text) if self.text => self.append(
                &text
                    .unescape()
                    .map_err(|e| HcdError::InvalidBundle(e.to_string()))?,
            )?,
            Event::CData(text) if self.text => self.append(
                std::str::from_utf8(text).map_err(|e| HcdError::InvalidBundle(e.to_string()))?,
            )?,
            Event::End(end) => match local_name(end.name().as_ref()) {
                "t" => self.text = false,
                "rPr" => self.properties = false,
                "rPh" => self.phonetic = false,
                "r" if !self.phonetic => {
                    if let Some(run) = self.run.take() {
                        self.value.runs.push(run);
                    }
                }
                _ => {}
            },
            _ => {}
        }
        Ok(())
    }

    fn append(&mut self, text: &str) -> Result<(), HcdError> {
        self.value.text.push_str(text);
        if self.value.text.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit(
                "NODE_TOO_LARGE: XLSX rich string exceeds 2 MiB".into(),
            ));
        }
        if let Some(run) = &mut self.run {
            run.text.push_str(text);
        }
        Ok(())
    }

    pub fn finish(self) -> Result<RichString, HcdError> {
        if self.run.is_some() || self.properties || self.text || self.phonetic {
            return Err(HcdError::InvalidBundle("unclosed XLSX rich string".into()));
        }
        if !self.value.runs.is_empty()
            && self
                .value
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>()
                != self.value.text
        {
            return Err(HcdError::InvalidBundle(
                "XLSX mixes plain and rich string content".into(),
            ));
        }
        Ok(self.value)
    }
}

pub(super) fn write_rich_cell(
    writer: &mut Writer<impl Write>,
    original: &BytesStart<'_>,
    runs: &[XlsxInlineRun],
) -> Result<(), HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut cell = BytesStart::new(&name);
    for attr in original.attributes() {
        let attr = attr.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
        if local_name(attr.key.as_ref()) != "t" {
            cell.push_attribute(attr);
        }
    }
    cell.push_attribute(("t", "inlineStr"));
    writer.write_event(Event::Start(cell))?;
    let is_name = qualified_child_name(original.name().as_ref(), "is");
    writer.write_event(Event::Start(BytesStart::new(&is_name)))?;
    for run in runs {
        hcd_core::validate_xlsx_run_properties(&run.properties)?;
        let r_name = qualified_child_name(original.name().as_ref(), "r");
        writer.write_event(Event::Start(BytesStart::new(&r_name)))?;
        if !run.properties.is_empty() {
            let props_name = qualified_child_name(original.name().as_ref(), "rPr");
            writer.write_event(Event::Start(BytesStart::new(&props_name)))?;
            // CT_RPrElt has a prescribed order. A map's alphabetical order is
            // not schema order, even when tolerant spreadsheet readers accept it.
            for key in [
                "rFont",
                "charset",
                "family",
                "b",
                "i",
                "strike",
                "outline",
                "shadow",
                "condense",
                "extend",
                "color",
                "sz",
                "u",
                "vertAlign",
                "scheme",
            ] {
                if let Some(attrs) = run.properties.get(key) {
                    let element_name = qualified_child_name(original.name().as_ref(), key);
                    let mut element = BytesStart::new(&element_name);
                    for (key, val) in attrs {
                        element.push_attribute((key.as_str(), val.as_str()));
                    }
                    writer.write_event(Event::Empty(element))?;
                }
            }
            writer.write_event(Event::End(BytesEnd::new(&props_name)))?;
        }
        let text_name = qualified_child_name(original.name().as_ref(), "t");
        let mut text = BytesStart::new(&text_name);
        text.push_attribute(("xml:space", "preserve"));
        writer.write_event(Event::Start(text))?;
        writer.write_event(Event::Text(BytesText::new(&run.text)))?;
        writer.write_event(Event::End(BytesEnd::new(&text_name)))?;
        writer.write_event(Event::End(BytesEnd::new(&r_name)))?;
    }
    writer.write_event(Event::End(BytesEnd::new(&is_name)))?;
    writer.write_event(Event::End(BytesEnd::new(&name)))?;
    Ok(())
}

#[derive(Default)]
pub(super) struct RichCellEdits {
    pub original: HashMap<String, BTreeMap<String, Vec<XlsxInlineRun>>>,
    pub created: HashMap<String, BTreeMap<String, Vec<XlsxInlineRun>>>,
}

pub(super) fn collect_rich_cells(
    bundle: &Bundle,
    manifest: &HcdManifest,
    dirty: &HashSet<String>,
) -> Result<RichCellEdits, HcdError> {
    let mut result = RichCellEdits::default();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            if !dirty
                .iter()
                .any(|id| node_bloom_might_contain(&descriptor.node_bloom, id))
            {
                continue;
            }
            let mut runs = hcd_core::extract_xlsx_inline_runs(&bundle.read_chunk(&descriptor)?)?;
            for entry in bundle.read_map(&descriptor)?.entries {
                if !dirty.contains(&entry.node_id) {
                    continue;
                }
                if let Some(runs) = runs.remove(&entry.node_id) {
                    let created = entry.source.created_in_hcd;
                    let reference = (if created {
                        entry.source.paragraph_id
                    } else {
                        entry.source.source_cell_ref.or(entry.source.paragraph_id)
                    })
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("rich XLSX cell has no address".into())
                    })?;
                    (if created {
                        &mut result.created
                    } else {
                        &mut result.original
                    })
                    .entry(entry.source.part)
                    .or_default()
                    .insert(reference, runs);
                }
            }
        }
    }
    Ok(result)
}
