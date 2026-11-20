use super::{
    column_name, escape_attribute, escape_text, parse_xlsx_view_cell, resolve_part,
    XlsxDrawingChart,
};
use crate::common::{highest_control_id, package_error};
use crate::native_images::{insert, read, relationship, rels};
use crate::worksheet_values::{chart_data, read_sheets, ChartData};
use hcd_core::{
    Bundle, HcdError, WorksheetChart, WorksheetChartConfig, WorksheetChartKind, WorksheetChartRange,
};
use oxml::chart_preview::ChartPreview;
use oxml::{StreamingOxmlArchive, StreamingOxmlRewriter};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CHART_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const DRAWING_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const MAIN_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const SHEET_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const TYPES_NS: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const CHART_TYPE: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const DRAWING_TYPE: &str = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CHART_WIDTH: u32 = 4_572_000;
const CHART_HEIGHT: u32 = 2_667_000;

pub(super) fn chart_part(id: &str) -> String {
    format!("xl/charts/hcd-chart-{id}.xml")
}

fn rect(reference: &str, sheet: &str) -> Option<(u32, u32, u32)> {
    let (tab, address) = reference.rsplit_once('!')?;
    let name = tab.trim_matches('\'').replace("''", "'");
    if name != sheet {
        return None;
    }
    let (first, last) = address.split_once(':').unwrap_or((address, address));
    let (row, col, _, _) = parse_xlsx_view_cell(first)?;
    let (last_row, last_col, _, _) = parse_xlsx_view_cell(last)?;
    (col == last_col).then_some((row, last_row, col))
}

pub(super) fn imported_chart(
    drawing: &XlsxDrawingChart,
    xml: &str,
    preview: &ChartPreview,
) -> Option<WorksheetChart> {
    let id = drawing
        .chart_part
        .strip_prefix("xl/charts/hcd-chart-")?
        .strip_suffix(".xml")?;
    if !hcd_core::valid_worksheet_chart_id(id) || preview.chart_kinds.len() != 1 {
        return None;
    }
    let kind = match preview.chart_kinds[0].as_str() {
        "horizontalBar" => WorksheetChartKind::Bar,
        "bar" if xml.contains("barDir val=\"bar\"") => WorksheetChartKind::Bar,
        "bar" => WorksheetChartKind::Column,
        "line" => WorksheetChartKind::Line,
        "pie" => WorksheetChartKind::Pie,
        _ => return None,
    };
    let first = preview.series.first()?;
    let (data_row, end_row, start_column) =
        rect(first.categories_formula.as_deref()?, &drawing.sheet_name)?;
    let start_row = data_row.checked_sub(1)?;
    for (i, series) in preview.series.iter().enumerate() {
        let column = start_column + i as u32 + 1;
        if rect(series.categories_formula.as_deref()?, &drawing.sheet_name)?
            != (data_row, end_row, start_column)
            || rect(series.values_formula.as_deref()?, &drawing.sheet_name)?
                != (data_row, end_row, column)
            || rect(series.name_formula.as_deref()?, &drawing.sheet_name)?
                != (start_row, start_row, column)
        {
            return None;
        }
    }
    let config = WorksheetChartConfig {
        kind,
        title: preview.title.clone(),
        range: WorksheetChartRange {
            start_row,
            end_row,
            start_column,
            end_column: start_column + preview.series.len() as u32,
        },
        anchor_row: drawing.anchor.from_row? + 1,
        anchor_column: drawing.anchor.from_col? + 1,
    };
    hcd_core::validate_worksheet_chart(&config).ok()?;
    Some(WorksheetChart {
        id: id.into(),
        config,
        source_missing: false,
        imported: true,
        edited: false,
        removed: false,
    })
}

fn source_formula(sheet: &str, column: u32, start: u32, end: u32) -> String {
    let sheet = sheet.replace('\'', "''");
    let col = column_name(column);
    let reference = if start == end {
        format!("'{sheet}'!${col}${start}")
    } else {
        format!("'{sheet}'!${col}${start}:${col}${end}")
    };
    escape_text(&reference)
}

fn chart_xml(
    chart: &WorksheetChart,
    sheet: &str,
    data: Option<&ChartData>,
) -> Result<String, HcdError> {
    let config = &chart.config;
    let range = config.range;
    let title = escape_text(&config.title);
    let cat = source_formula(
        sheet,
        range.start_column,
        range.start_row + 1,
        range.end_row,
    );
    let mut series = String::new();
    for (index, column) in (range.start_column + 1..=range.end_column).enumerate() {
        let header = source_formula(sheet, column, range.start_row, range.start_row);
        let values = source_formula(sheet, column, range.start_row + 1, range.end_row);
        let (cat, values) = if chart.source_missing {
            ("#REF!", "#REF!")
        } else {
            (cat.as_str(), values.as_str())
        };
        series.push_str(&format!("<c:ser><c:idx val=\"{index}\"/><c:order val=\"{index}\"/><c:tx><c:strRef><c:f>{header}</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>{cat}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>{values}</c:f></c:numRef></c:val></c:ser>"));
    }
    let ids = "<c:axId val=\"10\"/><c:axId val=\"20\"/>";
    let horizontal = config.kind == WorksheetChartKind::Bar;
    let plot = match config.kind {
        WorksheetChartKind::Column | WorksheetChartKind::Bar => {
            let direction = if horizontal { "bar" } else { "col" };
            format!("<c:barChart><c:barDir val=\"{direction}\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>{series}{ids}</c:barChart>")
        }
        WorksheetChartKind::Line => format!("<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{series}<c:marker val=\"1\"/>{ids}</c:lineChart>"),
        WorksheetChartKind::Pie => format!("<c:pieChart><c:varyColors val=\"1\"/>{series}<c:firstSliceAng val=\"0\"/></c:pieChart>"),
    };
    let (cat_pos, val_pos) = if horizontal { ("l", "b") } else { ("b", "l") };
    let axes = if config.kind == WorksheetChartKind::Pie {
        String::new()
    } else {
        format!("<c:catAx><c:axId val=\"10\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:axPos val=\"{cat_pos}\"/><c:crossAx val=\"20\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/></c:catAx><c:valAx><c:axId val=\"20\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:axPos val=\"{val_pos}\"/><c:majorGridlines/><c:crossAx val=\"10\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/></c:valAx>")
    };
    let legend =
        if config.kind == WorksheetChartKind::Pie || range.end_column - range.start_column > 1 {
            "<c:legend><c:legendPos val=\"b\"/><c:overlay val=\"0\"/></c:legend>"
        } else {
            ""
        };
    let mut xml = format!("<c:chartSpace xmlns:c=\"{CHART_NS}\" xmlns:a=\"{MAIN_NS}\"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/></c:title><c:autoTitleDeleted val=\"0\"/><c:plotArea><c:layout/>{plot}{axes}</c:plotArea>{legend}<c:plotVisOnly val=\"0\"/><c:dispBlanksAs val=\"gap\"/></c:chart></c:chartSpace>");
    if let Some(data) = data {
        refresh_caches(&mut xml, data)?;
    }
    Ok(xml)
}

fn anchor_xml(chart: &WorksheetChart, rel: &str, id: u64) -> String {
    let row = chart.config.anchor_row - 1;
    let column = chart.config.anchor_column - 1;
    let name = escape_attribute(&chart.config.title);
    format!("<xdr:oneCellAnchor xmlns:xdr=\"{DRAWING_NS}\" xmlns:a=\"{MAIN_NS}\" xmlns:c=\"{CHART_NS}\" xmlns:r=\"{REL_NS}\"><xdr:from><xdr:col>{column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx=\"{CHART_WIDTH}\" cy=\"{CHART_HEIGHT}\"/><xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{id}\" name=\"{name}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm><a:graphic><a:graphicData uri=\"{CHART_NS}\"><c:chart r:id=\"{rel}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>")
}

fn parse_xml(xml: &str) -> Result<roxmltree::Document<'_>, HcdError> {
    roxmltree::Document::parse(xml).map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

fn cache(tag: &str, count: usize, values: impl Iterator<Item = (usize, String)>) -> String {
    let mut xml = format!("<c:{tag} xmlns:c=\"{CHART_NS}\">");
    if tag == "numCache" {
        xml.push_str("<c:formatCode>General</c:formatCode>");
    }
    xml.push_str(&format!("<c:ptCount val=\"{count}\"/>"));
    for (index, text) in values {
        xml.push_str(&format!(
            "<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>",
            escape_text(&text)
        ));
    }
    xml.push_str(&format!("</c:{tag}>"));
    xml
}

fn refresh_caches(xml: &mut String, data: &ChartData) -> Result<(), HcdError> {
    let parsed = parse_xml(xml)?;
    let mut edits = Vec::new();
    let series: Vec<_> = parsed
        .descendants()
        .filter(|node| node.has_tag_name((CHART_NS, "ser")))
        .collect();
    if series.len() != data.series.len() {
        return Err(HcdError::InvalidBundle(
            "chart series differ from the worksheet range".into(),
        ));
    }
    for (series, sample) in series.iter().zip(&data.series) {
        for (field, reference, tag, value) in [
            (
                "tx",
                "strRef",
                "strCache",
                cache("strCache", 1, [(0, sample.name.clone())].into_iter()),
            ),
            (
                "cat",
                "strRef",
                "strCache",
                cache(
                    "strCache",
                    data.categories.len(),
                    data.categories.iter().cloned().enumerate(),
                ),
            ),
            (
                "val",
                "numRef",
                "numCache",
                cache(
                    "numCache",
                    sample.values.len(),
                    sample
                        .values
                        .iter()
                        .enumerate()
                        .filter_map(|(i, value)| value.map(|value| (i, value.to_string()))),
                ),
            ),
        ] {
            let node = series
                .children()
                .find(|child| child.has_tag_name((CHART_NS, field)))
                .and_then(|child| {
                    child
                        .children()
                        .find(|child| child.has_tag_name((CHART_NS, reference)))
                })
                .ok_or_else(|| {
                    HcdError::InvalidBundle("chart is missing a native data reference".into())
                })?;
            let destination = match node
                .children()
                .find(|child| child.has_tag_name((CHART_NS, tag)))
            {
                Some(previous) => previous.range(),
                None => {
                    let range = node.range();
                    let end = xml[range.clone()].rfind("</").ok_or_else(|| {
                        HcdError::InvalidBundle("chart reference is incomplete".into())
                    })? + range.start;
                    end..end
                }
            };
            if xml[destination.clone()] != value {
                edits.push((destination, value));
            }
        }
    }
    edits.sort_unstable_by_key(|(range, _)| std::cmp::Reverse(range.start));
    for (range, value) in edits {
        xml.replace_range(range, &value);
    }
    Ok(())
}

fn link_target(owner: &str, xml: &str, id: &str) -> Result<String, HcdError> {
    let doc = parse_xml(xml)?;
    let target = doc
        .root_element()
        .children()
        .find(|node| {
            node.attribute("Id") == Some(id) && node.attribute("TargetMode") != Some("External")
        })
        .and_then(|node| node.attribute("Target"))
        .ok_or_else(|| HcdError::InvalidBundle("worksheet drawing relationship missing".into()))?;
    resolve_part(owner, target)
}

fn add_content_type(xml: &mut String, part: &str, kind: &str) -> Result<(), HcdError> {
    let name = escape_attribute(&format!("/{part}"));
    insert(
        xml,
        "</Types>",
        &format!("<Override xmlns=\"{TYPES_NS}\" PartName=\"{name}\" ContentType=\"{kind}\"/>"),
    )
}

fn drawing_for_sheet(
    archive: &mut StreamingOxmlArchive,
    changes: &mut HashMap<String, Vec<u8>>,
    types: &mut String,
    sheet: &str,
    allow_create: bool,
) -> Result<String, HcdError> {
    let mut xml = read(archive, changes, sheet, "")?;
    let doc = parse_xml(&xml)?;
    let root = doc.root_element();
    if let Some(drawing) = root
        .children()
        .find(|node| node.tag_name().name() == "drawing")
    {
        let id = drawing.attribute((REL_NS, "id")).ok_or_else(|| {
            HcdError::InvalidBundle("worksheet drawing has no relationship ID".into())
        })?;
        return link_target(sheet, &read(archive, changes, &rels(sheet), "")?, id);
    }
    if !allow_create {
        return Err(HcdError::InvalidBundle(
            "original chart drawing missing".into(),
        ));
    }
    let basename = sheet
        .rsplit('/')
        .next()
        .ok_or_else(|| HcdError::InvalidBundle("invalid sheet part".into()))?;
    let path = format!("xl/drawings/hcd-charts-{basename}");
    if archive.contains(&path) || changes.contains_key(&path) {
        return Err(HcdError::InvalidBundle(
            "worksheet chart drawing name already exists".into(),
        ));
    }
    let id = "rIdHcdWorksheetCharts";
    let element = format!("<drawing xmlns=\"{SHEET_NS}\" xmlns:r=\"{REL_NS}\" r:id=\"{id}\"/>");
    let following = root.children().find(|node| {
        matches!(
            node.tag_name().name(),
            "legacyDrawing"
                | "legacyDrawingHF"
                | "picture"
                | "oleObjects"
                | "controls"
                | "webPublishItems"
                | "tableParts"
                | "extLst"
        )
    });
    let at = following.map(|node| node.range().start);
    if let Some(at) = at {
        xml.insert_str(at, &element);
    } else {
        insert(&mut xml, "</worksheet>", &element)?;
    }
    changes.insert(sheet.into(), xml.into_bytes());
    relationship(archive, changes, sheet, id, "drawing", &format!("/{path}"))?;
    changes.insert(
        path.clone(),
        format!("<xdr:wsDr xmlns:xdr=\"{DRAWING_NS}\"></xdr:wsDr>").into_bytes(),
    );
    add_content_type(types, &path, DRAWING_TYPE)?;
    Ok(path)
}

struct ImportedChart<'a> {
    drawing: &'a str,
    xml: &'a mut String,
    part: &'a str,
    chart: &'a WorksheetChart,
}

fn update_imported(
    archive: &mut StreamingOxmlArchive,
    changes: &mut HashMap<String, Vec<u8>>,
    removals: &mut HashSet<String>,
    types: &mut String,
    imported: ImportedChart<'_>,
) -> Result<(), HcdError> {
    let ImportedChart {
        drawing,
        xml,
        part,
        chart,
    } = imported;
    let rels_part = rels(drawing);
    let mut relationships = read(archive, changes, &rels_part, "")?;
    let doc = parse_xml(&relationships)?;
    let mut link = None;
    for candidate in doc.root_element().children() {
        let Some(target) = candidate.attribute("Target") else {
            continue;
        };
        if candidate.attribute("TargetMode") != Some("External")
            && candidate
                .attribute("Type")
                .is_some_and(|kind| kind.ends_with("/chart"))
            && resolve_part(drawing, target)? == part
        {
            link = Some(candidate);
            break;
        }
    }
    let link =
        link.ok_or_else(|| HcdError::InvalidBundle("imported chart relationship missing".into()))?;
    let rel = link
        .attribute("Id")
        .ok_or_else(|| HcdError::InvalidBundle("chart relationship has no ID".into()))?;
    let tree = parse_xml(xml)?;
    let anchor = tree
        .root_element()
        .children()
        .find(|node| {
            node.descendants().any(|child| {
                child.has_tag_name((CHART_NS, "chart"))
                    && child.attribute((REL_NS, "id")) == Some(rel)
            })
        })
        .ok_or_else(|| HcdError::InvalidBundle("imported chart anchor missing".into()))?;
    let id = anchor
        .descendants()
        .find(|node| node.has_tag_name((DRAWING_NS, "cNvPr")))
        .and_then(|node| node.attribute("id"))
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| HcdError::InvalidBundle("imported chart object has no ID".into()))?;
    let range = anchor.range();
    if chart.removed {
        xml.replace_range(range, "");
        let link_range = link.range();
        relationships.replace_range(link_range, "");
        changes.insert(rels_part, relationships.into_bytes());
        let part_name = format!("/{part}");
        let content = parse_xml(types)?
            .root_element()
            .children()
            .find(|node| node.attribute("PartName") == Some(part_name.as_str()))
            .map(|node| node.range());
        if let Some(content) = content {
            types.replace_range(content, "");
        }
        removals.insert(part.into());
    } else {
        let anchor = anchor_xml(chart, &escape_attribute(rel), id);
        xml.replace_range(range, &anchor);
    }
    Ok(())
}

pub(crate) fn export(
    bundle: &Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<usize, HcdError> {
    let (manifest, _) = hcd_core::manifest_at_revision(bundle, &bundle.manifest()?, revision)?;
    let charts = hcd_core::worksheet_charts(bundle, &manifest, None)?;
    let changes: Vec<_> = charts
        .into_iter()
        .filter(|(_, chart)| !chart.imported || chart.edited || manifest.revision > 0)
        .collect();
    if changes.is_empty() {
        return Ok(0);
    }
    let values = match read_sheets(bundle, &manifest) {
        Ok(values) => values,
        Err(HcdError::ResourceLimit(_)) => Vec::new(),
        Err(error) => return Err(error),
    };
    let mut count = 0;
    let mut archive = StreamingOxmlArchive::open(target).map_err(package_error)?;
    let mut written = HashMap::new();
    let mut removals = HashSet::new();
    let mut types = read(&mut archive, &written, "[Content_Types].xml", "")?;
    for (grid, chart) in changes {
        let part = chart_part(&chart.id);
        let data = chart_data(&values, &grid.sheet_id, &chart);
        if chart.imported && !chart.edited {
            if let Some(data) = &data {
                let before = read(&mut archive, &written, &part, "")?;
                let mut after = before.clone();
                refresh_caches(&mut after, data)?;
                if after != before {
                    written.insert(part, after.into_bytes());
                    count += 1;
                }
            }
            continue;
        }
        let sheet = grid
            .sheet_part
            .ok_or_else(|| HcdError::InvalidBundle("chart has no source worksheet".into()))?;
        let drawing = drawing_for_sheet(
            &mut archive,
            &mut written,
            &mut types,
            &sheet,
            !chart.imported,
        )?;
        let mut xml = read(&mut archive, &written, &drawing, "")?;
        if chart.imported {
            update_imported(
                &mut archive,
                &mut written,
                &mut removals,
                &mut types,
                ImportedChart {
                    drawing: &drawing,
                    xml: &mut xml,
                    part: &part,
                    chart: &chart,
                },
            )?;
        } else {
            if archive.contains(&part) || written.contains_key(&part) {
                return Err(HcdError::InvalidBundle(
                    "managed chart name already exists".into(),
                ));
            }
            let rel = format!("rIdHcdChart{}", chart.id);
            let id = highest_control_id(xml.as_bytes(), "cNvPr", "id")?
                .checked_add(1)
                .ok_or_else(|| HcdError::ResourceLimit("worksheet drawing ID exhausted".into()))?;
            insert(&mut xml, "</xdr:wsDr>", &anchor_xml(&chart, &rel, id))?;
            relationship(
                &mut archive,
                &mut written,
                &drawing,
                &rel,
                "chart",
                &format!("/{part}"),
            )?;
            add_content_type(&mut types, &part, CHART_TYPE)?;
        }
        written.insert(drawing, xml.into_bytes());
        if !chart.removed {
            written.insert(
                part,
                chart_xml(&chart, &grid.sheet_name, data.as_ref())?.into_bytes(),
            );
        }
        count += 1;
    }
    if count == 0 {
        return Ok(0);
    }
    written.insert("[Content_Types].xml".into(), types.into_bytes());
    let temp = tempfile::tempdir()?;
    let mut replaced = HashMap::new();
    let mut added = HashMap::new();
    for (index, (part, bytes)) in written.into_iter().enumerate() {
        let path = temp.path().join(format!("part-{index}"));
        std::fs::write(&path, bytes)?;
        if archive.contains(&part) {
            replaced.insert(part, path);
        } else {
            added.insert(part, path);
        }
    }
    drop(archive);
    let output = temp.path().join("charts.xlsx");
    StreamingOxmlRewriter::rewrite_with_changes(
        target,
        &output,
        &replaced,
        &added,
        &removals,
        "xl/workbook.xml",
    )
    .map_err(package_error)?;
    std::fs::copy(output, target)?;
    Ok(count)
}
