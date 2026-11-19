use super::{
    attribute, column_name, local_name, package_error, qualified_child_name, sheet_grid_id,
    workbook_info, WorkbookInfo,
};
use crate::common::XmlBudget;
use hcd_core::{
    hash_file, worksheet_filter, Bundle, GridAutoFilter, GridFilterView, HcdError, HcdManifest,
};
use oxml::{PackageError, StreamingOxmlArchive};
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

pub fn verify_xlsx_filter_source(
    source: &Path,
    manifest: &HcdManifest,
    sheet_id: &str,
    filter: &GridAutoFilter,
) -> Result<(), HcdError> {
    if manifest.source.format != "xlsx" || hash_file(source)? != manifest.source.sha256 {
        return Err(HcdError::SourceMismatch(
            "Saved AutoFilter requires the immutable source XLSX".into(),
        ));
    }
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let sheet = workbook
        .sheets
        .iter()
        .find(|sheet| sheet_grid_id(&manifest.document_id, &sheet.part) == sheet_id)
        .ok_or_else(|| {
            HcdError::InvalidPatch("AutoFilter worksheet does not exist in the source XLSX".into())
        })?;
    check_original_sheet(&mut archive, &sheet.part, &filter_reference(filter)).map(|_| ())
}

fn check_original_sheet(
    archive: &mut StreamingOxmlArchive,
    part: &str,
    reference: &str,
) -> Result<bool, HcdError> {
    let (conflicts, existing) = archive
        .with_part(part, |input| {
            let mut reader = Reader::from_reader(BufReader::new(input));
            let mut buffer = Vec::new();
            let mut budget = XmlBudget::default();
            let mut existing = false;
            let mut inside_filter = false;
            loop {
                let event = reader
                    .read_event_into(&mut buffer)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                budget
                    .observe(&event, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                match event {
                    Event::Start(ref tag) | Event::Empty(ref tag)
                        if local_name(tag.name().as_ref()) == "autoFilter" =>
                    {
                        if existing || attribute(tag, "ref").as_deref() != Some(reference) {
                            return Ok((true, existing));
                        }
                        existing = true;
                        inside_filter = matches!(event, Event::Start(_));
                    }
                    Event::End(ref tag)
                        if inside_filter && local_name(tag.name().as_ref()) == "autoFilter" =>
                    {
                        inside_filter = false
                    }
                    Event::Empty(ref tag)
                        if inside_filter && local_name(tag.name().as_ref()) == "extLst" => {}
                    Event::Text(ref text)
                        if inside_filter && text.as_ref().iter().all(u8::is_ascii_whitespace) => {}
                    _ if inside_filter => return Ok((true, existing)),
                    Event::Start(ref tag) | Event::Empty(ref tag)
                        if matches!(
                            local_name(tag.name().as_ref()),
                            "sortState" | "tableParts" | "sheetProtection" | "customSheetViews"
                        ) =>
                    {
                        return Ok((true, existing))
                    }
                    Event::Eof => {
                        budget
                            .finish(part)
                            .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                        return Ok((false, existing));
                    }
                    _ => {}
                }
                buffer.clear();
            }
        })
        .map_err(package_error)?;
    if conflicts {
        return Err(HcdError::Unsupported("Saved AutoFilter requires the same range as any inactive source filter, and a sheet without native criteria, tables, or protected/custom views".into()));
    }
    Ok(existing)
}

pub(super) fn write_saved_filters(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    archive: &mut StreamingOxmlArchive,
    scratch: &Path,
    replacements: &mut HashMap<String, PathBuf>,
) -> Result<(), HcdError> {
    let mut seen_sheets = BTreeSet::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page)?.chunks {
            let Some(grid) = descriptor.grid.filter(|grid| grid.auto_filter.is_some()) else {
                continue;
            };
            let sheet = workbook
                .sheets
                .get(grid.sheet_index)
                .filter(|sheet| sheet_grid_id(&manifest.document_id, &sheet.part) == grid.sheet_id)
                .ok_or_else(|| {
                    HcdError::InvalidBundle(
                        "Saved AutoFilter sheet does not match source XLSX".into(),
                    )
                })?;
            if !seen_sheets.insert(grid.sheet_index) {
                return Err(HcdError::InvalidBundle(
                    "Duplicate saved worksheet AutoFilter".into(),
                ));
            }
            let view = worksheet_filter(bundle, manifest, &grid.sheet_id)?
                .ok_or_else(|| HcdError::InvalidBundle("Missing saved AutoFilter".into()))?;
            let existing =
                check_original_sheet(archive, &sheet.part, &filter_reference(&view.filter))?;
            let output_path = scratch.join(format!("autofilter-{}.xml", grid.sheet_index));
            let output = BufWriter::new(File::create(&output_path)?);
            if let Some(path) = replacements.get(&sheet.part) {
                rewrite_filter(&mut File::open(path)?, output, &view, existing)?;
            } else {
                archive
                    .with_part(&sheet.part, |input| {
                        rewrite_filter(input, output, &view, existing)
                            .map_err(|error| PackageError::ReadPartError(error.to_string()))
                    })
                    .map_err(package_error)?;
            }
            replacements.insert(sheet.part.clone(), output_path);
        }
    }
    Ok(())
}

fn rewrite_filter(
    input: &mut dyn Read,
    output: impl Write,
    view: &GridFilterView,
    existing: bool,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::new(input));
    let mut writer = Writer::new(output);
    let mut buffer = Vec::new();
    let mut depth = 0u32;
    let mut in_data = false;
    let mut row = 0u32;
    let mut worksheet_name = None;
    let mut hidden: BTreeSet<_> = view.hidden_rows.iter().copied().collect();
    let mut filter_written = false;
    let mut data_seen = false;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("AutoFilter XML: {error}")))?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let name = tag.name();
                let kind = local_name(name.as_ref());
                if depth == 0 && kind == "worksheet" {
                    worksheet_name = Some(name.as_ref().to_vec());
                } else if depth == 1 && kind == "sheetData" {
                    in_data = matches!(event, Event::Start(_));
                    data_seen = !in_data;
                } else if existing && depth == 1 && kind == "autoFilter" {
                    let expanded = matches!(event, Event::Empty(_));
                    writer.write_event(Event::Start(tag.to_owned()))?;
                    write_filter_columns(&mut writer, name.as_ref(), &view.filter)?;
                    if expanded {
                        writer.write_event(Event::End(tag.to_end()))?;
                    } else {
                        depth += 1;
                    }
                    filter_written = true;
                    buffer.clear();
                    continue;
                } else if !existing
                    && depth == 1
                    && data_seen
                    && !filter_written
                    && !matches!(kind, "sheetCalcPr" | "protectedRanges" | "scenarios")
                {
                    write_filter_xml(
                        &mut writer,
                        worksheet_name.as_deref().unwrap_or(b"worksheet"),
                        view,
                    )?;
                    filter_written = true;
                }
                if in_data && depth == 2 && kind == "row" {
                    row = attribute(tag, "r")
                        .and_then(|value| value.parse::<u32>().ok())
                        .unwrap_or(row + 1);
                    if hidden.remove(&row) {
                        let (name, kind) = (
                            String::from_utf8_lossy(name.as_ref()).into_owned(),
                            matches!(event, Event::Start(_)),
                        );
                        let mut changed = BytesStart::new(name);
                        for attribute in tag.attributes() {
                            let attribute = attribute.map_err(|error| {
                                HcdError::InvalidBundle(format!(
                                    "AutoFilter row attribute: {error}"
                                ))
                            })?;
                            if local_name(attribute.key.as_ref()) != "hidden" {
                                changed.push_attribute(attribute);
                            }
                        }
                        changed.push_attribute(("hidden", "1"));
                        if kind {
                            depth += 1;
                        }
                        writer.write_event(if kind {
                            Event::Start(changed)
                        } else {
                            Event::Empty(changed)
                        })?;
                        buffer.clear();
                        continue;
                    }
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(ref tag) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| HcdError::InvalidBundle("Malformed worksheet nesting".into()))?;
                if depth == 1 && local_name(tag.name().as_ref()) == "sheetData" {
                    in_data = false;
                    data_seen = true;
                } else if !existing && depth == 0 && data_seen && !filter_written {
                    write_filter_xml(
                        &mut writer,
                        worksheet_name.as_deref().unwrap_or(b"worksheet"),
                        view,
                    )?;
                    filter_written = true;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        writer.write_event(event)?;
        buffer.clear();
    }
    if !filter_written || !hidden.is_empty() {
        return Err(HcdError::InvalidBundle(
            "AutoFilter range has missing native worksheet rows".into(),
        ));
    }
    writer.into_inner().flush()?;
    Ok(())
}

fn write_filter_xml(
    writer: &mut Writer<impl Write>,
    parent: &[u8],
    view: &GridFilterView,
) -> Result<(), HcdError> {
    let filter = &view.filter;
    let reference = filter_reference(filter);
    let filter_name = qualified_child_name(parent, "autoFilter");
    let mut root = BytesStart::new(filter_name.as_str());
    root.push_attribute(("ref", reference.as_str()));
    writer.write_event(Event::Start(root))?;
    write_filter_columns(writer, filter_name.as_bytes(), filter)?;
    writer.write_event(Event::End(BytesEnd::new(filter_name)))?;
    Ok(())
}

fn filter_reference(filter: &GridAutoFilter) -> String {
    format!(
        "{}{}:{}{}",
        column_name(filter.start_column),
        filter.start_row,
        column_name(filter.end_column),
        filter.end_row
    )
}

fn write_filter_columns(
    writer: &mut Writer<impl Write>,
    parent: &[u8],
    filter: &GridAutoFilter,
) -> Result<(), HcdError> {
    let column_name = qualified_child_name(parent, "filterColumn");
    let criteria_name = qualified_child_name(parent, "customFilters");
    let criterion_name = qualified_child_name(parent, "customFilter");
    let mut criteria: Vec<_> = filter.criteria().collect();
    criteria.sort_by_key(|(column, _)| *column);
    for (column, query) in criteria {
        let mut element = BytesStart::new(column_name.as_str());
        element.push_attribute(("colId", (column - filter.start_column).to_string().as_str()));
        writer.write_event(Event::Start(element))?;
        writer.write_event(Event::Start(BytesStart::new(criteria_name.as_str())))?;
        let mut criterion = BytesStart::new(criterion_name.as_str());
        criterion.push_attribute(("operator", "equal"));
        criterion.push_attribute(("val", GridAutoFilter::excel_pattern(query).as_str()));
        writer.write_event(Event::Empty(criterion))?;
        writer.write_event(Event::End(BytesEnd::new(criteria_name.as_str())))?;
        writer.write_event(Event::End(BytesEnd::new(column_name.as_str())))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_saved_grid_filter_keeps_manual_hiding_and_escapes_literal_criteria() {
        let xml = br#"<m:worksheet xmlns:m="urn:sheet"><m:sheetData><m:row r="2"/><m:row r="3" hidden="0"/><m:row r="4" hidden="1"/></m:sheetData><m:sheetCalcPr/><m:conditionalFormatting/></m:worksheet>"#;
        let view = GridFilterView {
            filter: GridAutoFilter {
                start_row: 2,
                end_row: 4,
                start_column: 3,
                end_column: 5,
                column: 4,
                query: "A&\"*?~".into(),
                additional_criteria: Vec::new(),
            },
            hidden_rows: vec![3],
            total: 1,
        };
        let mut output = Vec::new();
        rewrite_filter(&mut xml.as_slice(), &mut output, &view, false).unwrap();
        let output = String::from_utf8(output).unwrap();
        let xml = roxmltree::Document::parse(&output).unwrap();
        let children: Vec<_> = xml
            .root_element()
            .children()
            .filter(|node| node.is_element())
            .map(|node| node.tag_name().name())
            .collect();
        assert_eq!(
            children,
            [
                "sheetData",
                "sheetCalcPr",
                "autoFilter",
                "conditionalFormatting"
            ]
        );
        let filter = xml
            .descendants()
            .find(|node| node.has_tag_name(("urn:sheet", "autoFilter")))
            .unwrap();
        assert_eq!(filter.attribute("ref"), Some("C2:E4"));
        assert_eq!(
            filter.first_element_child().unwrap().attribute("colId"),
            Some("1")
        );
        let criteria = filter
            .descendants()
            .find(|node| node.has_tag_name("customFilter"))
            .unwrap();
        assert_eq!(criteria.attribute("val"), Some("*A&\"~*~?~~*"));
        let rows: Vec<_> = xml
            .descendants()
            .filter(|node| node.has_tag_name("row"))
            .map(|node| node.attribute("hidden"))
            .collect();
        assert_eq!(rows, [None, Some("1"), Some("1")]);
    }
}
