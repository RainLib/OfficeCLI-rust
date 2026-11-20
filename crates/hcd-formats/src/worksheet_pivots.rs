//! Evaluate source-backed PivotTables against a specific workbook revision.
use crate::worksheet_values::{read_sheets, Calculation, Sheet};
use hcd_core::{
    manifest_at_revision, pivot_output_range, validate_worksheet_pivot, worksheet_pivots,
    ApplyResult, Bundle, HcdError, HcdManifest, PatchBatch, PatchOperation, PivotAggregate,
    PivotCell, PivotReport, PivotSnapshot, WorksheetChartRange, WorksheetPivot,
    WorksheetPivotConfig,
};
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashSet},
};
use xlsx_handler::formula::{types::index_to_col, FormulaResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotPreview {
    pub fields: Vec<String>,
    pub report: PivotReport,
}

pub(crate) struct PivotData {
    pub fields: Vec<String>,
    pub records: Vec<Vec<PivotCell>>,
}

pub(crate) struct PivotCalculation {
    pub report: PivotReport,
    pub row_keys: Vec<Vec<PivotCell>>,
    pub column_keys: Vec<Vec<PivotCell>>,
}

pub(crate) fn address(row: u32, column: u32) -> String {
    format!("{}{row}", index_to_col(column as usize))
}

pub(crate) fn range_label(range: WorksheetChartRange) -> String {
    format!(
        "{}:{}",
        address(range.start_row, range.start_column),
        address(range.end_row, range.end_column)
    )
}

pub(crate) fn parse_range(value: &str) -> Option<WorksheetChartRange> {
    let (first, last) = value.split_once(':').unwrap_or((value, value));
    let first = xlsx_handler::CellRef::parse(&first.replace('$', ""))?;
    let last = xlsx_handler::CellRef::parse(&last.replace('$', ""))?;
    (first.row > 0
        && first.row <= last.row
        && last.row <= 1_048_576
        && first.col > 0
        && first.col <= last.col
        && last.col <= 16_384)
        .then_some(WorksheetChartRange {
            start_row: first.row as u32,
            end_row: last.row as u32,
            start_column: first.col as u32,
            end_column: last.col as u32,
        })
}

fn scalar(value: FormulaResult) -> Option<PivotCell> {
    match value {
        FormulaResult::Blank => Some(PivotCell::Blank),
        FormulaResult::Str(value) => Some(PivotCell::Text(value)),
        FormulaResult::Number(value) if value.is_finite() => {
            Some(PivotCell::Number(if value == 0.0 {
                "0".into()
            } else {
                value.to_string()
            }))
        }
        FormulaResult::Bool(value) => Some(PivotCell::Boolean(value)),
        FormulaResult::Error(code) if code.starts_with('#') => Some(PivotCell::Error(code)),
        _ => None,
    }
}

fn label(cell: &PivotCell) -> String {
    match cell {
        PivotCell::Text(value) | PivotCell::Number(value) | PivotCell::Error(value) => {
            value.clone()
        }
        PivotCell::Boolean(true) => "TRUE".into(),
        PivotCell::Boolean(false) => "FALSE".into(),
        PivotCell::Blank => String::new(),
    }
}

pub(crate) fn source_data(
    sheets: &[Sheet],
    config: &WorksheetPivotConfig,
) -> Result<PivotData, HcdError> {
    let sheet = sheets
        .iter()
        .position(|sheet| sheet.id == config.source_sheet_id)
        .ok_or_else(|| HcdError::NodeNotFound(config.source_sheet_id.clone()))?;
    let budget = Cell::new(300_000);
    let stack = RefCell::new(Vec::new());
    let error = RefCell::new(None);
    let calculation = Calculation {
        sheets,
        sheet,
        stack: &stack,
        budget: &budget,
        error: &error,
    };
    let range = config.source_range;
    let mut records = Vec::new();
    for row in range.start_row..=range.end_row {
        let mut values = Vec::new();
        for column in range.start_column..=range.end_column {
            error.replace(None);
            let address = address(row, column);
            let value = calculation.value(sheet, &address);
            let failure = error.take();
            let cell = scalar(value).filter(|_| failure.is_none()).ok_or_else(|| {
                HcdError::PreconditionFailed(format!(
                    "Cannot calculate PivotTable source {}!{address} ({})",
                    sheets[sheet].name,
                    failure.as_deref().unwrap_or("expected a scalar value"),
                ))
            })?;
            if !matches!(cell, PivotCell::Blank)
                && label(&cell).chars().any(|ch| {
                    ch == '\u{fffe}'
                        || ch == '\u{ffff}'
                        || ch < ' ' && !matches!(ch, '\n' | '\r' | '\t')
                })
            {
                return Err(HcdError::PreconditionFailed(format!(
                    "Invalid control character in PivotTable source {address}"
                )));
            }
            values.push(cell);
        }
        records.push(values);
    }
    let header = records.remove(0);
    let fields: Vec<_> = header
        .iter()
        .map(|value| label(value).trim().to_owned())
        .collect();
    let mut unique = HashSet::new();
    if fields.iter().any(|field| {
        field.is_empty() || field.chars().count() > 255 || !unique.insert(field.to_lowercase())
    }) || header
        .iter()
        .any(|value| matches!(value, PivotCell::Error(_)))
    {
        return Err(HcdError::PreconditionFailed(
            "PivotTable source headers must be non-empty and unique".into(),
        ));
    }
    Ok(PivotData { fields, records })
}

#[derive(Default)]
struct Groups {
    keys: Vec<Vec<PivotCell>>,
    lookup: BTreeMap<Vec<PivotCell>, usize>,
}

impl Groups {
    fn collect(&mut self, record: &[PivotCell], dimensions: &[u32]) -> usize {
        let values: Vec<_> = dimensions
            .iter()
            .map(|field| record[*field as usize].clone())
            .collect();
        let folded = values
            .iter()
            .map(|value| match value {
                PivotCell::Text(value) => PivotCell::Text(value.to_lowercase()),
                value => value.clone(),
            })
            .collect();
        *self.lookup.entry(folded).or_insert_with(|| {
            let index = self.keys.len();
            self.keys.push(values);
            index
        })
    }
}

#[derive(Default, Clone)]
struct Summary<'a> {
    records: usize,
    present: usize,
    numeric: usize,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
    error: Option<&'a str>,
}

impl<'a> Summary<'a> {
    fn add(&mut self, value: &'a PivotCell) {
        self.records += 1;
        if value != &PivotCell::Blank {
            self.present += 1;
        }
        if let PivotCell::Number(number) = value {
            let number = number.parse::<f64>().expect("verified number");
            self.numeric += 1;
            self.sum += number;
            self.min = Some(self.min.map_or(number, |min| min.min(number)));
            self.max = Some(self.max.map_or(number, |max| max.max(number)));
        } else if let PivotCell::Error(code) = value {
            self.error.get_or_insert(code);
        }
    }

    fn value(&self, aggregate: PivotAggregate) -> PivotCell {
        if self.records == 0 {
            return PivotCell::Blank;
        }
        if aggregate == PivotAggregate::Count {
            return PivotCell::Number(self.present.to_string());
        }
        if let Some(error) = self.error {
            return PivotCell::Error(error.into());
        }
        let number = match aggregate {
            PivotAggregate::Sum => self.sum,
            PivotAggregate::Average if self.numeric == 0 => {
                return PivotCell::Error("#DIV/0!".into())
            }
            PivotAggregate::Average => self.sum / self.numeric as f64,
            PivotAggregate::Min => self.min.unwrap_or(0.0),
            PivotAggregate::Max => self.max.unwrap_or(0.0),
            PivotAggregate::Count => unreachable!(),
        };
        if number.is_finite() {
            PivotCell::Number(number.to_string())
        } else {
            PivotCell::Error("#NUM!".into())
        }
    }
}

pub(crate) fn measure_label(aggregate: PivotAggregate) -> &'static str {
    match aggregate {
        PivotAggregate::Sum => "Sum",
        PivotAggregate::Count => "Count",
        PivotAggregate::Average => "Average",
        PivotAggregate::Min => "Min",
        PivotAggregate::Max => "Max",
    }
}

pub(crate) fn calculate(
    data: &PivotData,
    config: &WorksheetPivotConfig,
) -> Result<PivotCalculation, HcdError> {
    let mut rows = Groups::default();
    let mut columns = Groups::default();
    let groups: Vec<_> = data
        .records
        .iter()
        .map(|record| {
            (
                rows.collect(record, &config.rows),
                columns.collect(record, &config.columns),
            )
        })
        .collect();
    let label_columns = config.rows.len().max(1);
    let header_rows = config.columns.len() + 1;
    let measures = config.values.len();
    let row_count = rows.keys.len() + usize::from(!config.rows.is_empty());
    let column_count = columns.keys.len() + usize::from(!config.columns.is_empty());
    let width = label_columns + column_count * measures;
    let height = row_count + header_rows;
    if width.saturating_mul(height) > 4096
        || config.anchor_column as usize + width - 1 > 16_384
        || config.anchor_row as usize + height - 1 > 1_048_576
    {
        return Err(HcdError::ResourceLimit(
            "PivotTable result exceeds 4096 cells or the worksheet bounds".into(),
        ));
    }
    let mut summaries = vec![Summary::default(); row_count * column_count * measures];
    let slot = |r, c, m| (r * column_count + c) * measures + m;
    for (record, (row, column)) in data.records.iter().zip(groups) {
        for (index, value) in config.values.iter().enumerate() {
            let value = &record[value.field as usize];
            summaries[slot(row, column, index)].add(value);
            if !config.rows.is_empty() {
                summaries[slot(row_count - 1, column, index)].add(value);
            }
            if !config.columns.is_empty() {
                summaries[slot(row, column_count - 1, index)].add(value);
                if !config.rows.is_empty() {
                    summaries[slot(row_count - 1, column_count - 1, index)].add(value);
                }
            }
        }
    }
    let total = || PivotCell::Text("Grand Total".into());
    let mut cells = vec![vec![PivotCell::Blank; width]; height];
    for (index, field) in config.columns.iter().enumerate() {
        cells[index][0] = PivotCell::Text(data.fields[*field as usize].clone());
        for (group, values) in columns.keys.iter().enumerate() {
            cells[index][label_columns + group * measures] = values[index].clone();
        }
    }
    if !config.columns.is_empty() {
        cells[0][label_columns + (column_count - 1) * measures] = total();
    }
    for (column, field) in config.rows.iter().enumerate() {
        cells[header_rows - 1][column] = PivotCell::Text(data.fields[*field as usize].clone());
    }
    for group in 0..column_count {
        for (index, value) in config.values.iter().enumerate() {
            cells[header_rows - 1][label_columns + group * measures + index] =
                PivotCell::Text(format!(
                    "{} of {}",
                    measure_label(value.aggregate),
                    data.fields[value.field as usize]
                ));
        }
    }
    for row in 0..row_count {
        let result = &mut cells[header_rows + row];
        if let Some(labels) = rows.keys.get(row).filter(|labels| !labels.is_empty()) {
            result[..labels.len()].clone_from_slice(labels);
        } else {
            result[0] = total();
        }
        for column in 0..column_count {
            for (index, value) in config.values.iter().enumerate() {
                result[label_columns + column * measures + index] =
                    summaries[slot(row, column, index)].value(value.aggregate);
            }
        }
    }
    let report = PivotReport {
        header_rows: header_rows as u32,
        label_columns: label_columns as u32,
        cells,
    };
    Ok(PivotCalculation {
        report,
        row_keys: rows.keys,
        column_keys: columns.keys,
    })
}

fn preview(
    bundle: &Bundle,
    manifest: &HcdManifest,
    target: &str,
    id: &str,
    config: &WorksheetPivotConfig,
) -> Result<PivotPreview, HcdError> {
    validate_worksheet_pivot(config)?;
    let sheets = read_sheets(bundle, manifest)?;
    let data = source_data(&sheets, config)?;
    let calculated = calculate(&data, config)?;
    let pivot = WorksheetPivot {
        id: id.into(),
        config: config.clone(),
        snapshot: Some(PivotSnapshot {
            source_revision: manifest.revision,
            source_config: config.clone(),
            report: calculated.report,
        }),
        origin: None,
        removed: false,
    };
    let area = pivot_output_range(&pivot).expect("bounded report");
    let existing = worksheet_pivots(bundle, manifest)?;
    let own = existing
        .iter()
        .find(|(grid, pivot)| grid.sheet_id == target && pivot.id == id);
    let owned_output = own.and_then(|(_, pivot)| pivot_output_range(pivot));
    let owned_origin = own
        .and_then(|(_, pivot)| pivot.origin.as_ref())
        .map(|origin| origin.range);
    let intersects_own = [owned_output, owned_origin]
        .into_iter()
        .flatten()
        .any(|old| old.overlaps(config.source_range));
    if target == config.source_sheet_id && (area.overlaps(config.source_range) || intersects_own) {
        return Err(HcdError::PreconditionFailed(
            "A PivotTable cannot include its own output in its data source".into(),
        ));
    }
    let sheet = sheets
        .iter()
        .find(|sheet| sheet.id == target)
        .ok_or_else(|| HcdError::NodeNotFound(target.into()))?;
    if sheet.merges.iter().any(|merge| merge.overlaps(area)) {
        return Err(HcdError::PreconditionFailed(
            "PivotTable output overlaps merged cells. Choose another destination.".into(),
        ));
    }
    if existing
        .iter()
        .filter(|(grid, pivot)| grid.sheet_id == target && pivot.id != id)
        .any(|(_, pivot)| {
            pivot_output_range(pivot).is_some_and(|other| other.overlaps(area))
                || pivot
                    .origin
                    .as_ref()
                    .is_some_and(|origin| origin.range.overlaps(area))
        })
    {
        return Err(HcdError::PreconditionFailed(
            "PivotTable output overlaps another PivotTable. Choose another destination.".into(),
        ));
    }
    for row in area.start_row..=area.end_row {
        for column in area.start_column..=area.end_column {
            if [owned_output, owned_origin]
                .into_iter()
                .flatten()
                .any(|old| old.contains_cell(row, column))
            {
                continue;
            }
            let address = address(row, column);
            if sheet
                .cells
                .get(&address)
                .is_some_and(|cell| cell.is_formula || cell.value_type != "blank")
            {
                return Err(HcdError::PreconditionFailed(format!(
                    "PivotTable output would overwrite {}!{address}. Choose an empty destination.",
                    sheet.name,
                )));
            }
        }
    }
    Ok(PivotPreview {
        fields: data.fields,
        report: pivot.snapshot.expect("computed").report,
    })
}

pub fn preview_current(
    bundle: &Bundle,
    revision: u64,
    target: &str,
    id: &str,
    config: &WorksheetPivotConfig,
) -> Result<PivotPreview, HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" || !hcd_core::valid_worksheet_chart_id(id) {
        return Err(HcdError::InvalidPatch(
            "expected an XLSX workbook and a valid pivot identifier".into(),
        ));
    }
    if manifest.revision != revision {
        return Err(HcdError::RevisionConflict(
            "Workbook changed before the PivotTable preview".into(),
        ));
    }
    preview(bundle, &manifest, target, id, config)
}

/// Both the HTTP editor and CLI use this path. A patch carries a definition;
/// only this resolver can supply its verified calculation to the core.
pub fn apply_workbook_patch(
    bundle: &Bundle,
    patch: &PatchBatch,
    expected: u64,
) -> Result<ApplyResult, HcdError> {
    let snapshot = match patch.operations.as_slice() {
        [PatchOperation::XlsxPivotSet {
            sheet_id,
            pivot_id,
            config: Some(config),
        }] => {
            let head = bundle.manifest()?;
            if head.source.format != "xlsx" || !hcd_core::valid_worksheet_chart_id(pivot_id) {
                return Err(HcdError::InvalidPatch(
                    "expected an XLSX workbook and a valid pivot identifier".into(),
                ));
            }
            let (manifest, _) = manifest_at_revision(bundle, &head, Some(patch.base_revision))?;
            let result = preview(bundle, &manifest, sheet_id, pivot_id, config)?;
            Some(PivotSnapshot {
                source_revision: manifest.revision,
                source_config: config.clone(),
                report: result.report,
            })
        }
        _ => None,
    };
    hcd_core::apply_patch_with_pivot(bundle, patch, expected, snapshot)
}
