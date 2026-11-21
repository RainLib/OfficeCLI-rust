use super::{cell_coordinates, column_name, resolve_part, SheetPart};
use crate::common::{append_control_children, package_error, AddedElement, MAX_CONTROL_BYTES};
use hcd_core::{
    manifest_at_revision, stable_node_id, validate_worksheet_condition, Bundle, HcdError,
    WorksheetChartRange, WorksheetCondition, WorksheetConditionConfig, WorksheetConditionOperator,
};
use oxml::{PackageError, StreamingOxmlArchive, StreamingOxmlRewriter};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::File,
    io::{BufReader, BufWriter, Write},
    path::Path,
};
use xlsx_handler::worksheet_conditions::{
    create_condition_xml, read_differential_colors, read_sheet_conditions, write_sheet_conditions,
    ConditionColors, NativeCondition,
};

const WORKBOOK: &str = "xl/workbook.xml";
const WORKBOOK_RELS: &str = "xl/_rels/workbook.xml.rels";
const CONTENT_TYPES: &str = "[Content_Types].xml";
const STYLES_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
const RELATIONSHIPS_NS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn initial_styles(namespace: &str) -> String {
    let namespace = super::escape_attribute(namespace);
    format!(
        r#"<styleSheet xmlns="{namespace}">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#
    )
}

fn styles_part(archive: &mut StreamingOxmlArchive) -> Result<Option<String>, HcdError> {
    let bytes = archive
        .read_control_part(WORKBOOK_RELS, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let xml = String::from_utf8_lossy(&bytes);
    let rels = roxmltree::Document::parse(&xml)
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    let target = rels
        .root_element()
        .children()
        .find(|node| {
            node.has_tag_name("Relationship")
                && node.attribute("TargetMode") != Some("External")
                && node
                    .attribute("Type")
                    .is_some_and(|value| value.ends_with("/styles"))
        })
        .and_then(|node| node.attribute("Target"));
    target
        .map(|target| resolve_part(WORKBOOK, target))
        .transpose()
}

fn control(archive: &mut StreamingOxmlArchive, part: &str) -> Result<String, HcdError> {
    let bytes = archive
        .read_control_part(part, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    String::from_utf8(bytes).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

pub(super) fn read_styles(
    archive: &mut StreamingOxmlArchive,
) -> Result<Vec<Option<ConditionColors>>, HcdError> {
    let Some(part) = styles_part(archive)?.filter(|part| archive.contains(part)) else {
        return Ok(Vec::new());
    };
    read_differential_colors(&control(archive, &part)?).map_err(HcdError::InvalidBundle)
}

fn parse_condition(native: NativeCondition) -> Option<WorksheetConditionConfig> {
    let operator = serde_json::from_value(serde_json::Value::String(native.operator?)).ok()?;
    let (first, last) = native
        .reference
        .split_once(':')
        .unwrap_or((&native.reference, &native.reference));
    let (start_row, start_column) = cell_coordinates(first)?;
    let (end_row, end_column) = cell_coordinates(last)?;
    let config = WorksheetConditionConfig {
        range: WorksheetChartRange {
            start_row,
            end_row,
            start_column,
            end_column,
        },
        operator,
        values: native.formulas,
        fill: native.colors.fill,
        color: native.colors.color,
        stop_if_true: native.stop_if_true,
    };
    validate_worksheet_condition(&config).ok()?;
    Some(config)
}

pub(super) fn import(
    archive: &mut StreamingOxmlArchive,
    sheet: &SheetPart,
    document_id: &str,
    styles: &[Option<ConditionColors>],
) -> Result<Vec<WorksheetCondition>, HcdError> {
    let data = archive
        .with_part(&sheet.part, |source| {
            read_sheet_conditions(BufReader::new(source), styles)
                .map_err(PackageError::ReadPartError)
        })
        .map_err(package_error)?;
    Ok(data
        .rules
        .into_iter()
        .filter_map(|(priority, native)| {
            let config = parse_condition(native)?;
            let id = stable_node_id(&[
                document_id,
                &sheet.part,
                "conditional-format",
                &priority.to_string(),
            ]);
            Some(WorksheetCondition {
                id: id.trim_start_matches("n_").into(),
                source_priority: Some(priority),
                config,
                edited: false,
                removed: false,
            })
        })
        .collect())
}

fn native_condition(config: WorksheetConditionConfig) -> NativeCondition {
    use WorksheetConditionOperator::*;
    let operator = match config.operator {
        GreaterThan => "greaterThan",
        GreaterThanOrEqual => "greaterThanOrEqual",
        LessThan => "lessThan",
        LessThanOrEqual => "lessThanOrEqual",
        Equal => "equal",
        NotEqual => "notEqual",
        Between => "between",
        NotBetween => "notBetween",
    };
    let range = config.range;
    let first = format!("{}{}", column_name(range.start_column), range.start_row);
    let last = format!("{}{}", column_name(range.end_column), range.end_row);
    NativeCondition {
        reference: if first == last {
            first
        } else {
            format!("{first}:{last}")
        },
        kind: "cellIs".into(),
        operator: Some(operator.into()),
        formulas: config.values,
        colors: ConditionColors {
            fill: config.fill,
            color: config.color,
        },
        stop_if_true: config.stop_if_true,
    }
}

pub(crate) fn export(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<usize, HcdError> {
    let (manifest, _) = manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    let mut sheets: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            if let Some(grid) = descriptor.grid {
                for rule in grid.conditions.into_iter().filter(|rule| rule.edited) {
                    let part = grid.sheet_part.as_ref().ok_or_else(|| {
                        HcdError::InvalidBundle("conditional rule has no source worksheet".into())
                    })?;
                    sheets.entry(part.clone()).or_default().push(rule);
                }
            }
        }
    }
    if sheets.is_empty() {
        return Ok(0);
    }
    let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
    let styles_relationship = styles_part(&mut archive)?;
    let styles_part = styles_relationship
        .clone()
        .unwrap_or_else(|| "xl/styles.xml".into());
    let mut styles = if archive.contains(&styles_part) {
        control(&mut archive, &styles_part)?
    } else {
        String::new()
    };
    let temp = tempfile::tempdir()?;
    let mut replacement_paths = HashMap::new();
    let mut added_paths = HashMap::new();
    let mut changes = 0;
    let mut installed_styles = false;
    for (index, (part, conditions)) in sheets.into_iter().enumerate() {
        let mut native = archive
            .with_part(&part, |source| {
                read_sheet_conditions(BufReader::new(source), &[])
                    .map_err(PackageError::ReadPartError)
            })
            .map_err(package_error)?;
        let mut removed = BTreeSet::new();
        let mut additions = String::new();
        for rule in conditions {
            if let Some(priority) = rule.source_priority {
                removed.insert(priority);
            }
            if !rule.removed {
                validate_worksheet_condition(&rule.config)?;
                if styles.is_empty() {
                    styles = initial_styles(&native.namespace);
                }
                let priority = if let Some(priority) = rule.source_priority {
                    priority
                } else {
                    native.last_priority =
                        native.last_priority.checked_add(1).ok_or_else(|| {
                            HcdError::ResourceLimit(
                                "worksheet conditional priority exhausted".into(),
                            )
                        })?;
                    native.last_priority
                };
                additions.push_str(
                    &create_condition_xml(
                        &mut styles,
                        &native_condition(rule.config),
                        priority,
                        &native.namespace,
                    )
                    .map_err(HcdError::InvalidBundle)?,
                );
                installed_styles = true;
            }
            changes += 1;
        }
        let path = temp.path().join(format!("sheet-{index}.xml"));
        let mut file = BufWriter::new(File::create(&path)?);
        archive
            .with_part(&part, |source| {
                write_sheet_conditions(BufReader::new(source), &mut file, &removed, &additions)
                    .map_err(PackageError::ReadPartError)
            })
            .map_err(package_error)?;
        file.flush()?;
        replacement_paths.insert(part, path);
    }
    if installed_styles {
        let path = temp.path().join("styles.xml");
        std::fs::write(&path, styles)?;
        if archive.contains(&styles_part) {
            replacement_paths.insert(styles_part.clone(), path);
        } else {
            added_paths.insert(styles_part.clone(), path);
        }
        if styles_relationship.is_none() {
            let rels = archive
                .read_control_part(WORKBOOK_RELS, MAX_CONTROL_BYTES)
                .map_err(package_error)?;
            let updated = append_control_children(
                &rels,
                "Relationships",
                &[AddedElement {
                    name: "Relationship",
                    attributes: vec![
                        ("Id".into(), "rIdHcdConditionalStyles".into()),
                        ("Type".into(), format!("{RELATIONSHIPS_NS}/styles")),
                        ("Target".into(), format!("/{styles_part}")),
                    ],
                }],
                WORKBOOK_RELS,
            )?;
            let path = temp.path().join("workbook.xml.rels");
            std::fs::write(&path, updated)?;
            replacement_paths.insert(WORKBOOK_RELS.into(), path);
        }
        let types = control(&mut archive, CONTENT_TYPES)?;
        let doc = roxmltree::Document::parse(&types)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let part_name = format!("/{styles_part}");
        if !doc.root_element().children().any(|node| {
            node.has_tag_name("Override") && node.attribute("PartName") == Some(&part_name)
        }) {
            let updated = append_control_children(
                types.as_bytes(),
                "Types",
                &[AddedElement {
                    name: "Override",
                    attributes: vec![
                        ("PartName".into(), part_name),
                        ("ContentType".into(), STYLES_CONTENT_TYPE.into()),
                    ],
                }],
                CONTENT_TYPES,
            )?;
            let path = temp.path().join("content-types.xml");
            std::fs::write(&path, updated)?;
            replacement_paths.insert(CONTENT_TYPES.into(), path);
        }
    }
    drop(archive);
    let output = temp.path().join("conditional-formats.xlsx");
    StreamingOxmlRewriter::rewrite_with_changes(
        target,
        &output,
        &replacement_paths,
        &added_paths,
        &HashSet::new(),
        WORKBOOK,
    )
    .map_err(package_error)?;
    std::fs::copy(output, target)?;
    Ok(changes)
}
