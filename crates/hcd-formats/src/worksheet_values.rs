//! Verified spreadsheet values shared by the workbench and native chart export.
use hcd_core::{Bundle, HcdError, PivotCell, WorksheetChartRange};
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::cell::{Cell as Counter, RefCell};
use std::collections::HashMap;
use xlsx_handler::formula::{evaluate_with_resolver, CellResolver, FormulaResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub categories: Vec<String>,
    pub series: Vec<ChartDataSeries>,
    pub unavailable: usize,
}

#[derive(Serialize)]
pub struct ChartDataSeries {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

pub fn chart_data(
    sheets: &[Sheet],
    sheet_id: &str,
    chart: &hcd_core::WorksheetChart,
) -> Option<ChartData> {
    if chart.source_missing || chart.removed {
        return None;
    }
    let sheet = sheets.iter().position(|sheet| sheet.id == sheet_id)?;
    let range = chart.config.range;
    let budget = Counter::new(200_000);
    let stack = RefCell::new(Vec::new());
    let error = RefCell::new(None);
    let calculation = Calculation {
        sheets,
        sheet,
        stack: &stack,
        budget: &budget,
        error: &error,
    };
    let value = |row: u32, column: u32| {
        error.replace(None);
        let address = format!(
            "{}{row}",
            xlsx_handler::formula::types::index_to_col(column as usize)
        );
        let result = calculation.value(sheet, &address);
        if let Some(code) = error.borrow().clone() {
            FormulaResult::Error(code)
        } else {
            result
        }
    };
    // Labels use the cell's typed value, so numeric dates can keep their display
    // text while a formula label still reflects its verified result.
    let label = |row, column: u32| match value(row, column) {
        FormulaResult::Error(_) | FormulaResult::Blank => String::new(),
        result => {
            let address = format!(
                "{}{row}",
                xlsx_handler::formula::types::index_to_col(column as usize)
            );
            let text = sheets[sheet]
                .cells
                .get(&address)
                .filter(|cell| !cell.is_formula)
                .map_or_else(|| result.as_string(), |cell| cell.text.clone());
            text.chars().take(120).collect()
        }
    };
    let categories = (range.start_row + 1..=range.end_row)
        .map(|row| label(row, range.start_column))
        .collect();
    let mut unavailable = 0;
    let series = (range.start_column + 1..=range.end_column)
        .map(|column| {
            let name = label(range.start_row, column);
            let values = (range.start_row + 1..=range.end_row)
                .map(|row| match value(row, column) {
                    FormulaResult::Number(value) if value.is_finite() => Some(value),
                    FormulaResult::Blank => None,
                    _ => {
                        unavailable += 1;
                        None
                    }
                })
                .collect();
            ChartDataSeries { name, values }
        })
        .collect();
    Some(ChartData {
        categories,
        series,
        unavailable,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub address: String,
    pub node_id: String,
    pub node_hash: String,
    pub text: String,
    pub text_editable: bool,
    pub number_editable: bool,
    pub number_value: Option<String>,
    pub value_type: String,
    pub formula: Option<String>,
    pub formula_editable: bool,
    #[serde(skip)]
    pub is_formula: bool,
    #[serde(skip)]
    pub raw: Option<String>,
}
pub struct Sheet {
    pub id: String,
    pub name: String,
    pub literal_types_complete: bool,
    pub cells: std::collections::BTreeMap<String, Cell>,
    pub merges: Vec<WorksheetChartRange>,
}
pub struct Calculation<'a> {
    pub sheets: &'a [Sheet],
    pub sheet: usize,
    pub stack: &'a RefCell<Vec<(usize, String)>>,
    pub budget: &'a Counter<usize>,
    pub error: &'a RefCell<Option<String>>,
}
impl Calculation<'_> {
    fn fail(&self, code: &str) -> FormulaResult {
        *self.error.borrow_mut() = Some(code.into());
        FormulaResult::Error(code.into())
    }
    pub fn value(&self, sheet: usize, address: &str) -> FormulaResult {
        if self.budget.get() == 0 || self.stack.borrow().len() >= 32 {
            return self.fail("calculation_limit");
        }
        self.budget.set(self.budget.get() - 1);
        if !self.sheets[sheet].literal_types_complete {
            // Older imports dropped empty inline strings entirely. Even a
            // missing address cannot safely be treated as blank in those files.
            return self.fail("literal_type_metadata_missing");
        }
        let key = (sheet, address.replace('$', "").to_uppercase());
        let Some(cell) = self.sheets[sheet].cells.get(&key.1) else {
            return FormulaResult::Blank;
        };
        if cell.is_formula {
            let Some(formula) = &cell.formula else {
                return self.fail("unsupported_formula");
            };
            if self.stack.borrow().contains(&key) {
                return self.fail("circular_reference");
            }
            if let Err(error) = xlsx_handler::formula::check_formula_support(formula) {
                return self.fail(&error);
            }
            self.stack.borrow_mut().push(key);
            let result = evaluate_with_resolver(
                formula.trim_start_matches('='),
                &Calculation { sheet, ..*self },
            );
            self.stack.borrow_mut().pop();
            if matches!(&result, FormulaResult::Number(v) if !v.is_finite()) {
                return self.fail("#NUM!");
            }
            result
        } else {
            xlsx_handler::formula::evaluate_literal(
                &cell.value_type,
                cell.raw.as_deref().filter(|value| !value.is_empty()),
                &cell.text,
            )
        }
    }
    fn reference<'a>(&self, reference: &'a str) -> Option<(usize, &'a str)> {
        if let Some((name, address)) = reference.rsplit_once('!') {
            let name = name.trim_matches('\'').replace("''", "'");
            self.sheets
                .iter()
                .position(|s| s.name.eq_ignore_ascii_case(&name))
                .map(|i| (i, address))
        } else {
            Some((self.sheet, reference))
        }
    }
}
impl CellResolver for Calculation<'_> {
    fn evaluation_failure(&self) -> Option<String> {
        self.error.borrow().clone()
    }
    fn resolve_cell(&self, reference: &str) -> FormulaResult {
        self.value(self.sheet, reference)
    }
    fn resolve_sheet_cell(&self, reference: &str) -> FormulaResult {
        self.reference(reference)
            .map(|(s, a)| self.value(s, a))
            .unwrap_or_else(|| self.fail("#REF!"))
    }
    fn expand_range(&self, reference: &str) -> Vec<(String, FormulaResult)> {
        let invalid = || vec![(reference.into(), self.fail("unsupported_range"))];
        let Some((sheet, address)) = self.reference(reference) else {
            return invalid();
        };
        let Some((a, b)) = address.split_once(':') else {
            return invalid();
        };
        let a = a.replace('$', "");
        let b = b.replace('$', "");
        let (Some(a), Some(b)) = (
            xlsx_handler::CellRef::parse(&a),
            xlsx_handler::CellRef::parse(&b),
        ) else {
            return invalid();
        };
        let rows = a.row.abs_diff(b.row) as u64 + 1;
        let cols = a.col.abs_diff(b.col) as u64 + 1;
        if rows * cols > 20_000 || rows * cols > self.budget.get() as u64 {
            return invalid();
        }
        let mut values = Vec::new();
        for row in a.row.min(b.row)..=a.row.max(b.row) {
            for col in a.col.min(b.col)..=a.col.max(b.col) {
                let address = format!("{}{row}", xlsx_handler::formula::types::index_to_col(col));
                values.push((address.clone(), self.value(sheet, &address)));
            }
        }
        values
    }
}

pub fn read_sheets(
    bundle: &Bundle,
    manifest: &hcd_core::HcdManifest,
) -> Result<Vec<Sheet>, HcdError> {
    if !manifest.source.is_spreadsheet() {
        return Err(HcdError::Unsupported(
            "sheet inspection requires XLSX, CSV, or TSV".into(),
        ));
    }
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut pivots = Vec::new();
    let mut bytes = 0usize;
    let mut count = 0;
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(manifest, page)?.chunks {
            let Some(grid) = &chunk.grid else { continue };
            if grid.kind != hcd_core::GridChunkKind::Cells {
                continue;
            }
            let sheet = if let Some(i) = sheets.iter().position(|s| s.id == grid.sheet_id) {
                i
            } else {
                sheets.push(Sheet {
                    id: grid.sheet_id.clone(),
                    name: grid.sheet_name.clone(),
                    literal_types_complete: true,
                    cells: Default::default(),
                    merges: Vec::new(),
                });
                sheets.len() - 1
            };
            pivots.extend(grid.pivots.iter().cloned().map(|pivot| (sheet, pivot)));
            let html = bundle.read_chunk(&chunk)?;
            bytes += html.len();
            if bytes > 16 * 1024 * 1024 {
                return Err(HcdError::ResourceLimit(
                    "worksheet inspection exceeds 16 MiB; use chunks/nodes".into(),
                ));
            }
            let texts = hcd_core::extract_html_text_nodes(&html)?;
            let map = bundle.read_map(&chunk)?;
            let entries: HashMap<_, _> = map
                .entries
                .iter()
                .map(|entry| (entry.node_id.as_str(), entry))
                .collect();
            let mut reader = Reader::from_str(&html);
            reader.config_mut().check_end_names = false;
            let mut attrs = HashMap::new();
            let mut literal_types_complete = false;
            loop {
                match reader.read_event() {
                    Ok(Event::Start(e)) if e.name().as_ref() == b"table" => {
                        literal_types_complete |= e.attributes().flatten().any(|attribute| {
                            attribute.key.as_ref() == b"data-hcd-literal-types"
                                && attribute.value.as_ref() == b"1"
                        });
                    }
                    Ok(Event::Start(e)) if e.name().as_ref() == b"td" => {
                        attrs.clear();
                        for a in e.attributes().flatten() {
                            attrs.insert(
                                String::from_utf8_lossy(a.key.as_ref()).to_string(),
                                a.decode_and_unescape_value(reader.decoder())
                                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                                    .into_owned(),
                            );
                        }
                    }
                    Ok(Event::Start(e))
                        if e.name().as_ref() == b"span" && attrs.contains_key("data-hcd-cell") =>
                    {
                        let node = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.as_ref() == b"data-hcd-id")
                            .map(|a| a.unescape_value().map(|v| v.into_owned()))
                            .transpose()
                            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                        if let Some(node) = node {
                            if let Some(entry) = entries.get(node.as_str()) {
                                count += 1;
                                if count > 20_000 {
                                    return Err(HcdError::ResourceLimit("worksheet inspection exceeds 20000 cells; use chunks/nodes".into()));
                                }
                                let address = attrs["data-hcd-cell"].clone();
                                sheets[sheet].cells.insert(
                                    address.clone(),
                                    Cell {
                                        address,
                                        node_id: node.clone(),
                                        node_hash: entry.node_hash.clone(),
                                        text: texts.get(&node).cloned().unwrap_or_default(),
                                        text_editable: entry.source.editable,
                                        number_editable: entry.source.editable
                                            && attrs
                                                .get("data-hcd-formula")
                                                .is_none_or(|s| s != "true")
                                            && attrs.get("data-hcd-raw-value").is_some_and(
                                                |value| {
                                                    value.parse::<f64>().is_ok_and(f64::is_finite)
                                                },
                                            ),
                                        number_value: if attrs
                                            .get("data-hcd-formula")
                                            .is_some_and(|s| s == "true")
                                        {
                                            None
                                        } else {
                                            attrs
                                                .get("data-hcd-raw-value")
                                                .filter(|value| {
                                                    value.parse::<f64>().is_ok_and(f64::is_finite)
                                                })
                                                .cloned()
                                        },
                                        value_type: attrs
                                            .get("data-hcd-value-type")
                                            .cloned()
                                            .unwrap_or_else(|| {
                                                // Legacy values remain readable; the sheet
                                                // marker separately gates verified calculation.
                                                if attrs
                                                    .get("data-hcd-raw-value")
                                                    .is_some_and(|v| !v.is_empty())
                                                {
                                                    "number".into()
                                                } else {
                                                    "string".into()
                                                }
                                            }),
                                        formula: attrs.get("data-hcd-formula-expression").cloned(),
                                        formula_editable: attrs
                                            .get("data-hcd-formula-editable")
                                            .is_some_and(|s| s == "true"),
                                        is_formula: attrs
                                            .get("data-hcd-formula")
                                            .is_some_and(|s| s == "true"),
                                        raw: attrs.get("data-hcd-raw-value").cloned(),
                                    },
                                );
                            }
                        }
                    }
                    Ok(Event::End(e)) if e.name().as_ref() == b"td" => {
                        if let Some(range) = attrs
                            .get("data-hcd-merge")
                            .and_then(|value| crate::worksheet_pivots::parse_range(value))
                        {
                            sheets[sheet].merges.push(range);
                        }
                        attrs.clear();
                    }
                    Ok(Event::Eof) => break,
                    Err(e) => return Err(HcdError::InvalidBundle(e.to_string())),
                    _ => {}
                }
            }
            sheets[sheet].literal_types_complete &= literal_types_complete;
        }
    }
    for (index, pivot) in pivots {
        let sheet = &mut sheets[index];
        if let Some(origin) = &pivot.origin {
            if pivot.removed || pivot.snapshot.is_some() {
                sheet.cells.retain(|address, _| {
                    xlsx_handler::CellRef::parse(address).is_none_or(|cell| {
                        !origin.range.contains_cell(cell.row as u32, cell.col as u32)
                    })
                });
            } else {
                for cell in sheet.cells.values_mut() {
                    if xlsx_handler::CellRef::parse(&cell.address)
                        .is_some_and(|at| origin.range.contains_cell(at.row as u32, at.col as u32))
                    {
                        cell.text_editable = false;
                        cell.number_editable = false;
                        cell.formula_editable = false;
                    }
                }
            }
        }
        if pivot.removed {
            continue;
        }
        if let Some(snapshot) = &pivot.snapshot {
            for (row, cells) in snapshot.report.cells.iter().enumerate() {
                for (column, value) in cells.iter().enumerate() {
                    let (value_type, text, raw) = match value {
                        PivotCell::Blank => continue,
                        PivotCell::Text(text) => ("string", text.clone(), None),
                        PivotCell::Number(value) => ("number", value.clone(), Some(value.clone())),
                        PivotCell::Boolean(value) => (
                            "boolean",
                            if *value { "TRUE" } else { "FALSE" }.into(),
                            Some(if *value { "1" } else { "0" }.into()),
                        ),
                        PivotCell::Error(code) => ("error", code.clone(), Some(code.clone())),
                    };
                    let address = crate::worksheet_pivots::address(
                        pivot.config.anchor_row + row as u32,
                        pivot.config.anchor_column + column as u32,
                    );
                    let node_id = hcd_core::stable_node_id(&[
                        &manifest.document_id,
                        "pivot",
                        &pivot.id,
                        &address,
                    ]);
                    let node_hash = hcd_core::hash_bytes(text.as_bytes());
                    sheet.cells.insert(
                        address.clone(),
                        Cell {
                            address,
                            node_id,
                            node_hash,
                            text,
                            text_editable: false,
                            number_editable: false,
                            number_value: None,
                            value_type: value_type.into(),
                            formula: None,
                            formula_editable: false,
                            is_formula: false,
                            raw,
                        },
                    );
                }
            }
        }
    }
    Ok(sheets)
}
