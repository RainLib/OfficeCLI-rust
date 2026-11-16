//! Revision-scoped worksheet inspection. Formula results are recalculated from
//! expressions and native literals, never from a formula's imported cache.
use super::*;
use quick_xml::{events::Event, Reader};
use std::cell::{Cell as Counter, RefCell};
use xlsx_handler::formula::{evaluate_with_resolver, CellResolver, FormulaResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cell {
    address: String,
    node_id: String,
    node_hash: String,
    text: String,
    text_editable: bool,
    number_editable: bool,
    number_value: Option<String>,
    value_type: String,
    formula: Option<String>,
    formula_editable: bool,
    #[serde(skip)]
    is_formula: bool,
    #[serde(skip)]
    raw: Option<String>,
}
struct Sheet {
    id: String,
    name: String,
    literal_types_complete: bool,
    cells: std::collections::BTreeMap<String, Cell>,
}
struct Calculation<'a> {
    sheets: &'a [Sheet],
    sheet: usize,
    stack: &'a RefCell<Vec<(usize, String)>>,
    budget: &'a Counter<usize>,
    error: &'a RefCell<Option<String>>,
}
impl Calculation<'_> {
    fn fail(&self, code: &str) -> FormulaResult {
        *self.error.borrow_mut() = Some(code.into());
        FormulaResult::Error(code.into())
    }
    fn value(&self, sheet: usize, address: &str) -> FormulaResult {
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

fn read_sheets(bundle: &Bundle) -> Result<Vec<Sheet>, ApiError> {
    let manifest = bundle.manifest().map_err(hcd_error)?;
    if manifest.source.format != "xlsx" {
        return Err(bad("sheet inspection requires XLSX"));
    }
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut bytes = 0usize;
    let mut count = 0;
    for page in 0..manifest.index_page_count {
        for chunk in bundle
            .read_index_page(&manifest, page)
            .map_err(hcd_error)?
            .chunks
        {
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
                });
                sheets.len() - 1
            };
            let html = bundle.read_chunk(&chunk).map_err(hcd_error)?;
            bytes += html.len();
            if bytes > 16 * 1024 * 1024 {
                return Err(bad("worksheet inspection exceeds 16 MiB; use chunks/nodes"));
            }
            let texts = hcd_core::extract_html_text_nodes(&html).map_err(hcd_error)?;
            let map = bundle.read_map(&chunk).map_err(hcd_error)?;
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
                                    .map_err(bad)?
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
                            .map_err(bad)?;
                        if let Some(node) = node {
                            if let Some(entry) = entries.get(node.as_str()) {
                                count += 1;
                                if count > 20_000 {
                                    return Err(bad("worksheet inspection exceeds 20000 cells; use chunks/nodes"));
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
                    Ok(Event::End(e)) if e.name().as_ref() == b"td" => attrs.clear(),
                    Ok(Event::Eof) => break,
                    Err(e) => return Err(bad(e)),
                    _ => {}
                }
            }
            sheets[sheet].literal_types_complete &= literal_types_complete;
        }
    }
    Ok(sheets)
}

/// A worksheet column is an independent edit region, even when several
/// columns share one rendering chunk. Formula nodes belong to regions too.
pub(super) struct ColumnRegion {
    pub key: String,
    pub label: String,
    pub content: Value,
    pub node_ids: Vec<String>,
}

pub(super) fn column_key(sheet: &str, column: usize) -> String {
    format!("sheet-column:{sheet}:{column}")
}

pub(super) fn columns(bundle: &Bundle) -> Result<Vec<ColumnRegion>, ApiError> {
    let mut regions = vec![];
    for (sheet_index, sheet) in read_sheets(bundle)?.into_iter().enumerate() {
        let mut columns: std::collections::BTreeMap<usize, Vec<Cell>> = Default::default();
        for cell in sheet.cells.into_values() {
            if let Some(address) = xlsx_handler::CellRef::parse(&cell.address) {
                columns.entry(address.col).or_default().push(cell);
            }
        }
        for (column, mut cells) in columns {
            if !cells.iter().any(|c| c.text_editable || c.formula_editable) {
                continue;
            }
            cells.sort_unstable_by_key(|c| xlsx_handler::CellRef::parse(&c.address).map(|r| r.row));
            let letter = xlsx_handler::formula::types::index_to_col(column);
            // Include headers and formulas rather than requiring a planner to
            // infer ownership from an HTML page or stale formula result.
            let headers: Vec<_> = cells
                .iter()
                .filter(|c| {
                    !c.is_formula
                        && c.raw.as_ref().is_none_or(|v| v.parse::<f64>().is_err())
                        && !c.text.trim().is_empty()
                })
                .take(4)
                .map(|c| c.text.as_str())
                .collect();
            regions.push(ColumnRegion {
                key: column_key(&sheet.id, column),
                label: format!("{} · {} ({letter})", sheet.name, headers.join(" / ")),
                node_ids: cells.iter().map(|c| c.node_id.clone()).collect(),
                content: json!({"sheetId":sheet.id,"sheetName":sheet.name,"sheetIndex":sheet_index,"column":column,"columnLetter":letter,"cells":cells}),
            });
        }
    }
    Ok(regions)
}

pub(super) fn inspect(bundle: &Bundle, selected: usize) -> Result<Value, ApiError> {
    let manifest = bundle.manifest().map_err(hcd_error)?;
    let sheets = read_sheets(bundle)?;
    let sheet = sheets
        .get(selected)
        .ok_or_else(|| bad("sheet index out of bounds"))?;
    let mut cells = Vec::new();
    let budget = Counter::new(200_000);
    let mut ordered_cells: Vec<_> = sheet.cells.values().collect();
    ordered_cells.sort_unstable_by_key(|cell| {
        xlsx_handler::CellRef::parse(&cell.address).map(|r| (r.row, r.col))
    });
    for cell in ordered_cells {
        let stack = RefCell::new(Vec::new());
        let error = RefCell::new(None);
        let calculation = Calculation {
            sheets: &sheets,
            sheet: selected,
            stack: &stack,
            budget: &budget,
            error: &error,
        };
        let result = calculation.value(selected, &cell.address);
        let mut value = serde_json::to_value(cell).map_err(internal)?;
        let failure = error.into_inner().or_else(|| match &result {
            FormulaResult::Error(code) => Some(code.clone()),
            _ => None,
        });
        value["calculation"] = json!({"status":if failure.is_some(){"unavailable"}else{"calculated"},"error":failure,"value":if failure.is_none(){Some(result.as_string())}else{None}});
        if failure.is_none() {
            value["calculation"]["valueType"] = json!(result.value_type());
        }
        cells.push(value);
    }
    Ok(
        json!({"documentId":manifest.document_id,"revision":manifest.revision,"sheetId":sheet.id,"sheetName":sheet.name,"sheetIndex":selected,"literalTypesComplete":sheet.literal_types_complete,"cells":cells,"calculationCapabilities":xlsx_handler::formula::calculation_capabilities(),"calculationPolicy":"Recomputed from current formulas and typed native literals; unsupported functions, references, limits or legacy imports without complete literal metadata return unavailable, never cached results. Reimport the original XLSX to upgrade literal metadata."}),
    )
}

pub(super) async fn read(
    State(state): State<ServerState>,
    Path((id, index)): Path<(String, usize)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || inspect(&bundle, index))
        .await
        .map_err(internal)?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn calculated(formulas: &[(&str, &str)], address: &str) -> (String, Option<String>) {
        let mut sheet = Sheet {
            id: "sheet".into(),
            name: "Scores".into(),
            literal_types_complete: true,
            cells: Default::default(),
        };
        for (address, text) in formulas {
            let formula = text.starts_with('=');
            sheet.cells.insert(
                (*address).into(),
                Cell {
                    address: (*address).into(),
                    node_id: String::new(),
                    node_hash: String::new(),
                    text: (*text).into(),
                    text_editable: !formula,
                    number_editable: !formula && text.parse::<f64>().is_ok(),
                    number_value: (!formula).then(|| (*text).into()),
                    value_type: if text.parse::<f64>().is_ok() {
                        "number"
                    } else {
                        "string"
                    }
                    .into(),
                    formula: formula.then(|| (*text).into()),
                    formula_editable: formula,
                    is_formula: formula,
                    raw: (!formula).then(|| (*text).into()),
                },
            );
        }
        let sheets = [sheet];
        let stack = RefCell::new(Vec::new());
        let budget = Counter::new(10000);
        let error = RefCell::new(None);
        let result = Calculation {
            sheets: &sheets,
            sheet: 0,
            stack: &stack,
            budget: &budget,
            error: &error,
        }
        .value(0, address);
        (result.as_string(), error.into_inner())
    }
    #[test]
    fn unicode_blank_counts_and_negative_rounding_share_the_native_contract() {
        for (formula, expected) in [
            ("=LEN(\"中文\")", "2"),
            ("=COUNTBLANK(A1:A3)", "1"),
            ("=COUNTA(A1:A3)", "2"),
            ("=ROUNDUP(-1.21,1)", "-1.3"),
            ("=ROUNDDOWN(-1.21,1)", "-1.2"),
            ("=_xlfn.ROUNDUP(-1.21,1)", "-1.3"),
        ] {
            let cells = [("A1", "1"), ("A2", "2"), ("B1", formula)];
            assert_eq!(
                calculated(&cells, "B1"),
                (expected.into(), None),
                "{formula}"
            );
        }
        assert!(
            calculated(&[("A1", "=IF(1,2,3)"), ("B1", "=SUM(A1:A1)")], "B1")
                .1
                .is_some()
        );
    }

    #[test]
    fn rank_doubling_and_sum_recalculate_dependencies_instead_of_caches() {
        let cells = [
            ("I4", "90"),
            ("I5", "80"),
            ("I6", "95"),
            ("K4", "=(RANK(I4,$I$4:$I$6))*2"),
            ("K5", "=(RANK(I5,$I$4:$I$6))*2"),
            ("K6", "=(RANK(I6,$I$4:$I$6))*2"),
            ("K7", "=SUM(K4:K6)"),
        ];
        assert_eq!(calculated(&cells, "K4"), ("4".into(), None));
        assert_eq!(calculated(&cells, "K7"), ("12".into(), None));
    }
    #[test]
    fn unsafe_calculations_cannot_silently_become_a_successful_sum() {
        for formula in ["=UNKNOWN(1)", "=A1", "=SUM(A1:A1048576)", "=Missing!A1"] {
            assert!(
                calculated(&[("A1", formula), ("B1", "=SUM(A1:A1)")], "B1")
                    .1
                    .is_some(),
                "{formula}"
            );
        }
        for (formula, expected) in [
            ("=COUNTA(A1:A1)", "1"),
            ("=COUNT(A1:A1)", "0"),
            ("=COUNTBLANK(A1:A1)", "0"),
        ] {
            assert_eq!(
                calculated(&[("A1", "=1/0"), ("B1", formula)], "B1"),
                (expected.into(), None),
                "{formula}"
            );
        }
    }
    #[test]
    fn rank_ties_and_ascending_order() {
        let cells = [
            ("A1", "10"),
            ("A2", "20"),
            ("A3", "20"),
            ("B1", "=RANK.AVG(A2,A1:A3)"),
            ("B2", "=RANK.EQ(A1,A1:A3,1)"),
        ];
        assert_eq!(calculated(&cells, "B1"), ("1.5".into(), None));
        assert_eq!(calculated(&cells, "B2"), ("1".into(), None));
    }

    #[test]
    fn legacy_imports_cannot_certify_missing_addresses_as_blank() {
        let sheets = [Sheet {
            id: "legacy".into(),
            name: "Old import".into(),
            literal_types_complete: false,
            cells: Default::default(),
        }];
        let stack = RefCell::new(Vec::new());
        let budget = Counter::new(100);
        let error = RefCell::new(None);
        let result = Calculation {
            sheets: &sheets,
            sheet: 0,
            stack: &stack,
            budget: &budget,
            error: &error,
        }
        .value(0, "A1");
        assert_eq!(
            result,
            FormulaResult::Error("literal_type_metadata_missing".into())
        );
        assert_eq!(
            error.into_inner().as_deref(),
            Some("literal_type_metadata_missing")
        );
    }
}
