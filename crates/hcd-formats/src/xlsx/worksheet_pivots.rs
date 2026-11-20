//! Reopen native worksheet PivotTables and export their workbook part graph.
use super::{resolve_part, workbook_info, SheetPart};
use crate::{
    common::{append_control_children, package_error, AddedElement, MAX_CONTROL_BYTES},
    native_images::{read, rels},
    worksheet_pivots::{calculate, parse_range, source_data},
    worksheet_values::{read_sheets, Sheet},
};
use hcd_core::{
    manifest_at_revision, pivot_output_range, sheet_grid_id, stable_node_id,
    validate_worksheet_pivot, worksheet_pivots, Bundle, HcdError, PivotAggregate, PivotMeasure,
    PivotOrigin, WorksheetChartRange, WorksheetPivot, WorksheetPivotConfig,
};
use oxml::{StreamingOxmlArchive, StreamingOxmlRewriter};
use roxmltree::{Document, Node};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

use super::pivot_cells::{rewrite, ReportCells};
use super::worksheet_pivot_xml::{serialize, REL_NS};

const WORKBOOK: &str = "xl/workbook.xml";
const TYPES: &str = "[Content_Types].xml";
const RELATIONSHIPS: &str =
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>";

fn parse(xml: &str) -> Result<Document<'_>, HcdError> {
    Document::parse(xml).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

fn child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

fn related(
    archive: &mut StreamingOxmlArchive,
    owner: &str,
    kind: &str,
) -> Result<Vec<(String, String)>, HcdError> {
    let part = rels(owner);
    if !archive.contains(&part) {
        return Ok(Vec::new());
    }
    let xml = read(archive, &HashMap::new(), &part, RELATIONSHIPS)?;
    let doc = parse(&xml)?;
    doc.root_element()
        .children()
        .filter(|node| {
            node.has_tag_name("Relationship")
                && node.attribute("TargetMode") != Some("External")
                && node
                    .attribute("Type")
                    .and_then(|value| value.rsplit('/').next())
                    == Some(kind)
        })
        .filter_map(|node| Some((node.attribute("Id")?, node.attribute("Target")?)))
        .map(|(id, target)| Ok((id.to_owned(), resolve_part(owner, target)?)))
        .collect()
}

fn aggregate(value: Option<&str>) -> Option<PivotAggregate> {
    match value.unwrap_or("sum") {
        "sum" => Some(PivotAggregate::Sum),
        "count" => Some(PivotAggregate::Count),
        "average" => Some(PivotAggregate::Average),
        "min" => Some(PivotAggregate::Min),
        "max" => Some(PivotAggregate::Max),
        _ => None,
    }
}

fn native_style(xml: &str) -> Result<Option<String>, HcdError> {
    let doc = parse(xml)?;
    Ok(
        child(doc.root_element(), "pivotTableStyleInfo").map(|style| {
            let mut attributes = String::new();
            for key in [
                "name",
                "showRowHeaders",
                "showColHeaders",
                "showRowStripes",
                "showColStripes",
                "showLastColumn",
            ] {
                if let Some(value) = style.attribute(key) {
                    attributes.push_str(&format!(" {key}=\"{}\"", super::escape_attribute(value)));
                }
            }
            format!("<pivotTableStyleInfo{attributes}/>")
        }),
    )
}

fn native_config(
    definition: &str,
    cache_definition: &str,
    sheets: &[SheetPart],
    document: &str,
) -> Option<(WorksheetPivotConfig, WorksheetChartRange)> {
    let table = Document::parse(definition).ok()?;
    let cache = Document::parse(cache_definition).ok()?;
    let table = table.root_element();
    let cache = cache.root_element();
    let unsupported_table = [
        "pageFields",
        "filters",
        "conditionalFormats",
        "chartFormats",
        "rowHierarchiesUsage",
        "colHierarchiesUsage",
        "pivotHierarchies",
    ];
    if unsupported_table
        .iter()
        .any(|tag| child(table, tag).is_some())
        || cache
            .descendants()
            .any(|node| node.has_tag_name("fieldGroup") || node.has_tag_name("calculatedItems"))
    {
        return None;
    }
    let source =
        child(cache, "cacheSource").filter(|node| node.attribute("type") == Some("worksheet"))?;
    let source = child(source, "worksheetSource")?;
    let name = source.attribute("sheet")?;
    let sheet = sheets
        .iter()
        .find(|sheet| sheet.name.eq_ignore_ascii_case(name))?;
    let source_range = parse_range(source.attribute("ref")?)?;
    let output = parse_range(child(table, "location")?.attribute("ref")?)?;
    if (output.end_row - output.start_row + 1)
        .saturating_mul(output.end_column - output.start_column + 1)
        > 4096
    {
        return None;
    }
    let axis = |tag| -> Option<Vec<u32>> {
        child(table, tag)
            .into_iter()
            .flat_map(|list| list.children())
            .filter(|field| field.has_tag_name("field"))
            .filter(|field| field.attribute("x") != Some("-2"))
            .map(|field| field.attribute("x")?.parse().ok())
            .collect()
    };
    let values = child(table, "dataFields")?
        .children()
        .filter(|node| node.has_tag_name("dataField"))
        .map(|node| {
            if node
                .attribute("showDataAs")
                .is_some_and(|value| value != "normal")
            {
                return None;
            }
            Some(PivotMeasure {
                field: node.attribute("fld")?.parse().ok()?,
                aggregate: aggregate(node.attribute("subtotal"))?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let config = WorksheetPivotConfig {
        name: table.attribute("name")?.into(),
        source_sheet_id: sheet_grid_id(document, &sheet.part),
        source_range,
        anchor_row: output.start_row,
        anchor_column: output.start_column,
        rows: axis("rowFields")?,
        columns: axis("colFields")?,
        values,
    };
    validate_worksheet_pivot(&config).ok()?;
    Some((config, output))
}

pub(super) fn import(
    archive: &mut StreamingOxmlArchive,
    sheets: &[SheetPart],
    document: &str,
) -> Result<HashMap<String, Vec<WorksheetPivot>>, HcdError> {
    let mut result = HashMap::new();
    if !archive
        .entries()
        .iter()
        .any(|entry| entry.name.starts_with("xl/pivotTables/"))
    {
        return Ok(result);
    }
    let parts = HashMap::new();
    let workbook = read(archive, &parts, WORKBOOK, "")?;
    let workbook = parse(&workbook)?;
    let caches: HashMap<_, _> = related(archive, WORKBOOK, "pivotCacheDefinition")?
        .into_iter()
        .collect();
    let cache_for_id: HashMap<_, _> = child(workbook.root_element(), "pivotCaches")
        .into_iter()
        .flat_map(|list| list.children())
        .filter(|node| node.has_tag_name("pivotCache"))
        .filter_map(|node| {
            Some((
                node.attribute("cacheId")?,
                caches.get(node.attribute((REL_NS, "id"))?)?,
            ))
        })
        .collect();
    for sheet in sheets {
        let mut pivots = Vec::new();
        for (_, part) in related(archive, &sheet.part, "pivotTable")? {
            if archive
                .entry(&part)
                .is_none_or(|entry| entry.uncompressed_size > MAX_CONTROL_BYTES)
                || pivots.len() == 12
            {
                continue;
            }
            let definition = read(archive, &parts, &part, "")?;
            let doc = parse(&definition)?;
            let cache_id = doc.root_element().attribute("cacheId").unwrap_or_default();
            let cache_path = related(archive, &part, "pivotCacheDefinition")?
                .into_iter()
                .next()
                .map(|(_, target)| target)
                .or_else(|| {
                    cache_for_id
                        .get(cache_id)
                        .map(|target| (***target).to_owned())
                });
            let Some(cache) = cache_path.filter(|part| {
                archive
                    .entry(part)
                    .is_some_and(|entry| entry.uncompressed_size <= MAX_CONTROL_BYTES)
            }) else {
                continue;
            };
            let cache = read(archive, &parts, &cache, "")?;
            if let Some((config, range)) = native_config(&definition, &cache, sheets, document) {
                let id = stable_node_id(&[document, "pivot", &part]);
                pivots.push(WorksheetPivot {
                    id: id.trim_start_matches("n_").into(),
                    config,
                    snapshot: None,
                    origin: Some(PivotOrigin { part, range }),
                    removed: false,
                });
            }
        }
        if !pivots.is_empty() {
            result.insert(sheet.part.clone(), pivots);
        }
    }
    Ok(result)
}

#[derive(Default)]
struct SheetOutput {
    cells: ReportCells,
    cleared: Vec<WorksheetChartRange>,
    ranges: Vec<WorksheetChartRange>,
    removed_ids: HashSet<String>,
}

fn add_relationship(
    archive: &mut StreamingOxmlArchive,
    changes: &mut HashMap<String, Vec<u8>>,
    owner: &str,
    id: &str,
    kind: &str,
    target: &str,
    replace: bool,
) -> Result<(), HcdError> {
    let part = rels(owner);
    let xml = if replace {
        RELATIONSHIPS.into()
    } else {
        read(archive, changes, &part, RELATIONSHIPS)?
    };
    if !replace
        && parse(&xml)?
            .root_element()
            .children()
            .any(|node| node.attribute("Id") == Some(id))
    {
        return Err(HcdError::InvalidBundle(
            "generated PivotTable relationship already exists".into(),
        ));
    }
    let result = append_control_children(
        xml.as_bytes(),
        "Relationships",
        &[AddedElement {
            name: "Relationship",
            attributes: vec![
                ("Id".into(), id.into()),
                ("Type".into(), format!("{REL_NS}/{kind}")),
                ("Target".into(), format!("/{target}")),
            ],
        }],
        &part,
    )?;
    changes.insert(part, result);
    Ok(())
}

fn add_cache(xml: &mut String, cache_id: u64, rel: &str) -> Result<(), HcdError> {
    let doc = parse(xml)?;
    let root = doc.root_element();
    if child(root, "pivotCaches").is_some() {
        let updated = append_control_children(
            xml.as_bytes(),
            "pivotCaches",
            &[AddedElement {
                name: "pivotCache",
                attributes: vec![
                    ("xmlns:r".into(), REL_NS.into()),
                    ("r:id".into(), rel.into()),
                    ("cacheId".into(), cache_id.to_string()),
                ],
            }],
            WORKBOOK,
        )?;
        *xml = String::from_utf8(updated)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    } else {
        let opening = &xml[root.range().start + 1..];
        let tag = opening
            .split(|ch: char| ch.is_whitespace() || ch == '>')
            .next()
            .unwrap_or("workbook");
        let p = tag
            .rsplit_once(':')
            .map_or("", |(prefix, _)| &tag[..prefix.len() + 1]);
        let end = root
            .children()
            .find(|node| {
                matches!(
                    node.tag_name().name(),
                    "smartTagPr"
                        | "smartTagTypes"
                        | "webPublishing"
                        | "fileRecoveryPr"
                        | "webPublishObjects"
                        | "extLst"
                )
            })
            .map(|node| node.range().start)
            .or_else(|| xml.rfind("</"))
            .ok_or_else(|| HcdError::InvalidBundle("invalid workbook close".into()))?;
        let entry = format!(
            r#"<{p}pivotCaches xmlns:r="{REL_NS}"><{p}pivotCache cacheId="{cache_id}" r:id="{rel}"/></{p}pivotCaches>"#
        );
        xml.insert_str(end, &entry);
    }
    Ok(())
}

fn type_entry(part: &str, name: &str) -> AddedElement {
    AddedElement {
        name: "Override",
        attributes: vec![
            ("PartName".into(), format!("/{part}")),
            (
                "ContentType".into(),
                format!("application/vnd.openxmlformats-officedocument.spreadsheetml.{name}+xml"),
            ),
        ],
    }
}

fn remove_relationships(xml: &mut String, ids: &HashSet<String>) -> Result<(), HcdError> {
    let doc = parse(xml)?;
    let events: Vec<_> = doc
        .root_element()
        .children()
        .filter(|node| {
            node.has_tag_name("Relationship")
                && node.attribute("Id").is_some_and(|key| ids.contains(key))
        })
        .map(|node| node.range())
        .collect();
    for range in events.into_iter().rev() {
        xml.replace_range(range, "");
    }
    Ok(())
}

fn remove_legacy_links(xml: &mut String, ids: &HashSet<String>) -> Result<(), HcdError> {
    let doc = parse(xml)?;
    let Some(list) = child(doc.root_element(), "pivotTableParts") else {
        return Ok(());
    };
    let children: Vec<_> = list
        .children()
        .filter(|node| node.has_tag_name("pivotTablePart"))
        .collect();
    let removed: Vec<_> = children
        .iter()
        .filter(|node| {
            node.attribute((REL_NS, "id"))
                .is_some_and(|id| ids.contains(id))
        })
        .map(|node| node.range())
        .collect();
    if !removed.is_empty() && removed.len() == children.len() {
        let range = list.range();
        xml.replace_range(range, "");
    } else if !removed.is_empty() {
        let count = children.len() - removed.len();
        let range = list.range();
        let mut replacement = xml[range.clone()].to_owned();
        for item in removed.into_iter().rev() {
            replacement.replace_range(item.start - range.start..item.end - range.start, "");
        }
        let opening = replacement.find('>').unwrap_or(0);
        if let Some(at) = replacement[..opening].find("count=\"") {
            let start = at + 7;
            if let Some(end) = replacement[start..opening].find('"') {
                replacement.replace_range(start..start + end, &count.to_string());
            }
        }
        xml.replace_range(range, &replacement);
    }
    Ok(())
}

pub(crate) fn export(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<usize, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = manifest_at_revision(bundle, &head, revision)?;
    let pivots: Vec<_> = worksheet_pivots(bundle, &manifest)?
        .into_iter()
        .filter(|(_, pivot)| pivot.removed || pivot.snapshot.is_some())
        .collect();
    if pivots.is_empty() {
        return Ok(0);
    }
    let count = pivots.len();
    let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
    let info = workbook_info(&mut archive)?;
    let names: HashMap<_, _> = info
        .sheets
        .iter()
        .map(|sheet| {
            (
                sheet_grid_id(&manifest.document_id, &sheet.part),
                &sheet.name,
            )
        })
        .collect();
    let mut changes = HashMap::new();
    let mut removed = HashSet::new();
    let mut types_to_add = Vec::new();
    let mut outputs: BTreeMap<String, SheetOutput> = BTreeMap::new();
    let mut workbook = read(&mut archive, &changes, WORKBOOK, "")?;
    let mut cache_id = parse(&workbook)?
        .descendants()
        .filter(|node| node.has_tag_name("pivotCache"))
        .filter_map(|node| node.attribute("cacheId")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let mut source_revision: Option<(u64, Vec<Sheet>)> = None;
    for (grid, pivot) in pivots {
        let sheet = grid
            .sheet_part
            .as_deref()
            .ok_or_else(|| HcdError::InvalidBundle("PivotTable result worksheet missing".into()))?;
        let target_report = outputs.entry(sheet.into()).or_default();
        if let Some(origin) = &pivot.origin {
            target_report.cleared.push(origin.range);
            if pivot.removed {
                let existing = related(&mut archive, sheet, "pivotTable")?
                    .into_iter()
                    .find(|(_, part)| part == &origin.part)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("missing native PivotTable relationship".into())
                    })?;
                target_report.removed_ids.insert(existing.0);
                removed.insert(origin.part.clone());
                let relationships = rels(&origin.part);
                if archive.contains(&relationships) {
                    removed.insert(relationships);
                }
                continue;
            }
        }
        let output = pivot_output_range(&pivot)
            .ok_or_else(|| HcdError::InvalidBundle("PivotTable output missing".into()))?;
        let snapshot = pivot
            .snapshot
            .ok_or_else(|| HcdError::InvalidBundle("PivotTable calculation missing".into()))?;
        if source_revision
            .as_ref()
            .is_none_or(|(revision, _)| *revision != snapshot.source_revision)
        {
            let (source, _) = manifest_at_revision(bundle, &head, Some(snapshot.source_revision))?;
            source_revision = Some((snapshot.source_revision, read_sheets(bundle, &source)?));
        }
        let (_, sheets) = source_revision.as_ref().expect("snapshot source loaded");
        let data = source_data(sheets, &snapshot.source_config)?;
        let calculated = calculate(&data, &snapshot.source_config)?;
        if calculated.report != snapshot.report {
            return Err(HcdError::InvalidBundle(
                "PivotTable snapshot differs from its recorded source".into(),
            ));
        }
        let source_name = names
            .get(&pivot.config.source_sheet_id)
            .ok_or_else(|| HcdError::NodeNotFound(pivot.config.source_sheet_id.clone()))?;
        cache_id = cache_id.checked_add(1).ok_or_else(|| {
            HcdError::ResourceLimit("PivotTable cache identifiers exhausted".into())
        })?;
        let original_style = if let Some(origin) = &pivot.origin {
            native_style(&read(&mut archive, &changes, &origin.part, "")?)?
        } else {
            None
        };
        let parts = serialize(
            &pivot.config,
            source_name,
            output,
            &data,
            &calculated,
            cache_id,
            original_style.as_deref(),
        );
        let report_id = format!("hcd-{}-{}", manifest.revision, pivot.id);
        let cache = format!("xl/pivotCache/{report_id}-definition.xml");
        let records = format!("xl/pivotCache/{report_id}-records.xml");
        let table = pivot
            .origin
            .as_ref()
            .map(|origin| origin.part.clone())
            .unwrap_or_else(|| format!("xl/pivotTables/{report_id}.xml"));
        if archive.contains(&cache)
            || archive.contains(&records)
            || pivot.origin.is_none() && archive.contains(&table)
        {
            return Err(HcdError::InvalidBundle(
                "generated PivotTable part already exists".into(),
            ));
        }
        let id = format!("rIdHcdCache{cache_id}");
        add_cache(&mut workbook, cache_id, &id)?;
        add_relationship(
            &mut archive,
            &mut changes,
            WORKBOOK,
            &id,
            "pivotCacheDefinition",
            &cache,
            false,
        )?;
        add_relationship(
            &mut archive,
            &mut changes,
            &cache,
            "rId1",
            "pivotCacheRecords",
            &records,
            false,
        )?;
        add_relationship(
            &mut archive,
            &mut changes,
            &table,
            "rId1",
            "pivotCacheDefinition",
            &cache,
            true,
        )?;
        if pivot.origin.is_none() {
            add_relationship(
                &mut archive,
                &mut changes,
                sheet,
                &format!("rIdHcdPivot{}", pivot.id),
                "pivotTable",
                &table,
                false,
            )?;
            types_to_add.push(type_entry(&table, "pivotTable"));
        }
        changes.insert(cache.clone(), parts.definition.into_bytes());
        changes.insert(records.clone(), parts.records.into_bytes());
        changes.insert(table, parts.table.into_bytes());
        types_to_add.extend([
            type_entry(&cache, "pivotCacheDefinition"),
            type_entry(&records, "pivotCacheRecords"),
        ]);
        target_report.ranges.push(output);
        for (row, cells) in snapshot.report.cells.into_iter().enumerate() {
            let target = target_report
                .cells
                .entry(output.start_row + row as u32)
                .or_default();
            target.extend(
                cells
                    .into_iter()
                    .enumerate()
                    .map(|(column, cell)| (output.start_column + column as u32, cell)),
            );
        }
    }
    changes.insert(WORKBOOK.into(), workbook.into_bytes());
    let mut types = read(&mut archive, &changes, TYPES, "")?;
    let type_doc = parse(&types)?;
    let remove_entries: Vec<_> = type_doc
        .root_element()
        .children()
        .filter(|node| {
            node.has_tag_name("Override")
                && node
                    .attribute("PartName")
                    .is_some_and(|part| removed.contains(part.trim_start_matches('/')))
        })
        .map(|node| node.range())
        .collect();
    for range in remove_entries.into_iter().rev() {
        types.replace_range(range, "");
    }
    changes.insert(
        TYPES.into(),
        append_control_children(types.as_bytes(), "Types", &types_to_add, TYPES)?,
    );
    for (sheet, output) in outputs {
        let mut xml = read(&mut archive, &changes, &sheet, "")?;
        if !output.removed_ids.is_empty() {
            let part = rels(&sheet);
            let mut relationships = read(&mut archive, &changes, &part, RELATIONSHIPS)?;
            remove_relationships(&mut relationships, &output.removed_ids)?;
            changes.insert(part, relationships.into_bytes());
            remove_legacy_links(&mut xml, &output.removed_ids)?;
        }
        let rebuilt = rewrite(&xml, output.cells, &output.cleared, &output.ranges)?;
        changes.insert(sheet, rebuilt.into_bytes());
    }
    let scratch = tempfile::tempdir()?;
    let mut replacement = HashMap::new();
    let mut additions = HashMap::new();
    for (index, (part, bytes)) in changes.into_iter().enumerate() {
        let path = scratch.path().join(format!("part-{index}"));
        std::fs::write(&path, bytes)?;
        if archive.contains(&part) {
            replacement.insert(part, path);
        } else {
            additions.insert(part, path);
        }
    }
    drop(archive);
    let output = scratch.path().join("native-pivot.xlsx");
    StreamingOxmlRewriter::rewrite_with_changes(
        target,
        &output,
        &replacement,
        &additions,
        &removed,
        WORKBOOK,
    )
    .map_err(package_error)?;
    std::fs::copy(output, target)?;
    Ok(count)
}
