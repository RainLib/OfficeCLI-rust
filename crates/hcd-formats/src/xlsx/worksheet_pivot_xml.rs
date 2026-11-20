use crate::worksheet_pivots::{measure_label, range_label, PivotCalculation, PivotData};
use hcd_core::{PivotAggregate, PivotCell, WorksheetChartRange, WorksheetPivotConfig};
use std::collections::BTreeMap;
use std::fmt::Write;

use super::escape_attribute as escape;

pub(super) const SHEET_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
pub(super) const REL_NS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

struct SharedItems<'a> {
    items: Vec<&'a PivotCell>,
    indexes: BTreeMap<&'a PivotCell, usize>,
}
impl<'a> SharedItems<'a> {
    fn insert(&mut self, cell: &'a PivotCell) -> usize {
        *self.indexes.entry(cell).or_insert_with(|| {
            let index = self.items.len();
            self.items.push(cell);
            index
        })
    }

    fn xml(&self) -> String {
        let mut strings = false;
        let mut numbers = false;
        let mut blanks = false;
        let mut integer = true;
        let mut non_number = false;
        let mut content = String::new();
        for value in &self.items {
            match value {
                PivotCell::Blank => {
                    blanks = true;
                    content.push_str("<m/>");
                }
                PivotCell::Text(value) => {
                    strings = true;
                    non_number = true;
                    let _ = write!(content, "<s v=\"{}\"/>", escape(value));
                }
                PivotCell::Number(value) => {
                    numbers = true;
                    integer &= value
                        .parse::<f64>()
                        .is_ok_and(|number| number.fract() == 0.0);
                    let _ = write!(content, "<n v=\"{value}\"/>");
                }
                PivotCell::Boolean(value) => {
                    non_number = true;
                    let _ = write!(content, "<b v=\"{}\"/>", u8::from(*value));
                }
                PivotCell::Error(value) => {
                    non_number = true;
                    let _ = write!(content, "<e v=\"{}\"/>", escape(value));
                }
            }
        }
        format!(
            r#"<sharedItems count="{}" containsString="{}" containsNumber="{}" containsInteger="{}" containsBlank="{}" containsMixedTypes="{}" containsSemiMixedTypes="{}">{content}</sharedItems>"#,
            self.items.len(),
            u8::from(strings),
            u8::from(numbers),
            u8::from(numbers && integer),
            u8::from(blanks),
            u8::from(numbers && non_number),
            u8::from(non_number || blanks),
        )
    }
}

pub(super) struct Parts {
    pub table: String,
    pub definition: String,
    pub records: String,
}

fn axis_fields(tag: &str, dimensions: &[u32], data_axis: bool) -> String {
    if dimensions.is_empty() && !data_axis {
        return String::new();
    }
    let mut fields: String = dimensions
        .iter()
        .map(|field| format!("<field x=\"{field}\"/>"))
        .collect();
    if data_axis {
        fields.push_str("<field x=\"-2\"/>");
    }
    format!(
        "<{tag} count=\"{}\">{fields}</{tag}>",
        dimensions.len() + usize::from(data_axis)
    )
}

fn axis_items(
    tag: &str,
    dimensions: &[u32],
    keys: &[Vec<PivotCell>],
    measures: usize,
    data_axis: bool,
    fields: &[SharedItems<'_>],
) -> String {
    let mut items = String::new();
    for key in keys {
        for measure in 0..measures {
            let _ = write!(items, "<i i=\"{measure}\">");
            for (field, value) in dimensions.iter().zip(key) {
                let index = fields[*field as usize].indexes[value];
                let _ = write!(items, "<x v=\"{index}\"/>");
            }
            if data_axis {
                let _ = write!(items, "<x v=\"{measure}\"/>");
            } else if dimensions.is_empty() {
                items.push_str("<x/>");
            }
            items.push_str("</i>");
        }
    }
    if !dimensions.is_empty() {
        for measure in 0..measures {
            let _ = write!(items, "<i t=\"grand\" i=\"{measure}\"><x/></i>");
        }
    }
    let count = (keys.len() + usize::from(!dimensions.is_empty())) * measures;
    format!("<{tag} count=\"{count}\">{items}</{tag}>")
}

pub(super) fn serialize(
    config: &WorksheetPivotConfig,
    source_name: &str,
    output: WorksheetChartRange,
    source: &PivotData,
    result: &PivotCalculation,
    cache_id: u64,
    original_style: Option<&str>,
) -> Parts {
    let mut items: Vec<_> = source
        .fields
        .iter()
        .map(|_| SharedItems {
            items: Vec::new(),
            indexes: BTreeMap::new(),
        })
        .collect();
    let mut records = String::new();
    for record in &source.records {
        records.push_str("<r>");
        for (cell, field) in record.iter().zip(&mut items) {
            let index = field.insert(cell);
            let _ = write!(records, "<x v=\"{index}\"/>");
        }
        records.push_str("</r>");
    }
    let fields: String = source
        .fields
        .iter()
        .zip(&items)
        .map(|(name, items)| {
            format!(
                "<cacheField name=\"{}\" numFmtId=\"0\">{}</cacheField>",
                escape(name),
                items.xml()
            )
        })
        .collect();
    let record_count = source.records.len();
    let field_count = items.len();
    let reference = range_label(config.source_range);
    let source_name = escape(source_name);
    let definition = format!(
        r#"<pivotCacheDefinition xmlns="{SHEET_NS}" xmlns:r="{REL_NS}" r:id="rId1" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" saveData="1" refreshOnLoad="0" enableRefresh="1" recordCount="{record_count}"><cacheSource type="worksheet"><worksheetSource ref="{reference}" sheet="{source_name}"/></cacheSource><cacheFields count="{field_count}">{fields}</cacheFields></pivotCacheDefinition>"#,
    );
    let records = format!(
        r#"<pivotCacheRecords xmlns="{SHEET_NS}" count="{record_count}">{records}</pivotCacheRecords>"#
    );
    let pivot_fields: String = items.iter().enumerate().map(|(index, field)| {
        let dim = index as u32;
        let axis = if config.rows.contains(&dim) { " axis=\"axisRow\"" }
            else if config.columns.contains(&dim) { " axis=\"axisCol\"" } else { "" };
        let data_field = if config.values.iter().any(|value| value.field == dim) { " dataField=\"1\"" } else { "" };
        if axis.is_empty() {
            return format!("<pivotField{data_field} showAll=\"0\"/>");
        }
        let count = field.items.len();
        let items: String = (0..count).map(|index| format!("<item x=\"{index}\"/>")).collect();
        format!("<pivotField{axis}{data_field} showAll=\"0\" defaultSubtotal=\"0\" outline=\"0\" compact=\"0\"><items count=\"{count}\">{items}</items></pivotField>")
    }).collect();
    let data_fields: String = config.values.iter().map(|measure| {
        let aggregate = match measure.aggregate {
            PivotAggregate::Sum => "sum",
            PivotAggregate::Count => "count",
            PivotAggregate::Average => "average",
            PivotAggregate::Min => "min",
            PivotAggregate::Max => "max",
        };
        let name = escape(&format!("{} of {}", measure_label(measure.aggregate), source.fields[measure.field as usize]));
        format!(r#"<dataField name="{name}" fld="{}" subtotal="{aggregate}" baseField="0" baseItem="0" numFmtId="0"/>"#, measure.field)
    }).collect();
    let measures = config.values.len();
    let rows = axis_fields("rowFields", &config.rows, false)
        + &axis_items("rowItems", &config.rows, &result.row_keys, 1, false, &items);
    let columns = axis_fields("colFields", &config.columns, measures > 1)
        + &axis_items(
            "colItems",
            &config.columns,
            &result.column_keys,
            measures,
            measures > 1,
            &items,
        );
    let location = range_label(output);
    let first_header = u32::from(!config.columns.is_empty());
    let data_row = result.report.header_rows;
    let data_col = result.report.label_columns;
    let name = escape(&config.name);
    let style = original_style.unwrap_or(r#"<pivotTableStyleInfo name="PivotStyleMedium9" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0"/>"#);
    let table = format!(
        r#"<pivotTableDefinition xmlns="{SHEET_NS}" name="{name}" cacheId="{cache_id}" dataCaption="Values" createdVersion="6" updatedVersion="6" minRefreshableVersion="3" compact="0" compactData="0" outline="0" outlineData="0" rowGrandTotals="1" colGrandTotals="1" rowHeaderCaption="Row Labels" colHeaderCaption="Column Labels" useAutoFormatting="1"><location ref="{location}" firstHeaderRow="{first_header}" firstDataRow="{data_row}" firstDataCol="{data_col}"/><pivotFields count="{field_count}">{pivot_fields}</pivotFields>{rows}{columns}<dataFields count="{measures}">{data_fields}</dataFields>{style}</pivotTableDefinition>"#,
    );
    Parts {
        table,
        definition,
        records,
    }
}
