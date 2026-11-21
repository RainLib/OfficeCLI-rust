//! Revision-scoped worksheet inspection. Formula results are recalculated from
//! expressions and native literals, never from a formula's imported cache.
use super::*;
use hcd_core::WorksheetChartKind;
use hcd_formats::worksheet_values::{chart_data, read_sheets, Calculation, Cell, Sheet};
use oxml::chart_preview::{render_preview_svg, ChartPreview, ChartSeries};
use std::cell::{Cell as Counter, RefCell};
use xlsx_handler::formula::FormulaResult;

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
    let manifest = bundle.manifest().map_err(hcd_error)?;
    for (sheet_index, sheet) in read_sheets(bundle, &manifest)
        .map_err(hcd_error)?
        .into_iter()
        .enumerate()
    {
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

#[cfg(test)]
pub(super) fn inspect(bundle: &Bundle, selected: usize) -> Result<Value, ApiError> {
    let manifest = bundle.manifest().map_err(hcd_error)?;
    let sheets = read_sheets(bundle, &manifest).map_err(hcd_error)?;
    inspect_loaded(&manifest, &sheets, selected)
}

fn inspect_loaded(
    manifest: &hcd_core::HcdManifest,
    sheets: &[Sheet],
    selected: usize,
) -> Result<Value, ApiError> {
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
            sheets,
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
    Path((id, sheet)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || {
        let manifest = bundle.manifest().map_err(hcd_error)?;
        let sheets = read_sheets(&bundle, &manifest).map_err(hcd_error)?;
        let selected = sheet
            .parse::<usize>()
            .ok()
            .or_else(|| sheets.iter().position(|candidate| candidate.id == sheet))
            .ok_or_else(|| bad("worksheet not found"))?;
        inspect_loaded(&manifest, &sheets, selected)
    })
    .await
    .map_err(internal)?
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PivotQuery {
    revision: u64,
    pivot_id: String,
    config: String,
}

pub(super) async fn pivot_preview(
    State(state): State<ServerState>,
    Path((id, sheet)): Path<(String, String)>,
    Query(query): Query<PivotQuery>,
    headers: HeaderMap,
) -> Result<Json<hcd_formats::worksheet_pivots::PivotPreview>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    if query.config.len() > 8192 {
        return Err(bad("PivotTable request is too large"));
    }
    let config = serde_json::from_str(&query.config).map_err(bad)?;
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || {
        hcd_formats::worksheet_pivots::preview_current(
            &bundle,
            query.revision,
            &sheet,
            &query.pivot_id,
            &config,
        )
        .map(Json)
        .map_err(hcd_error)
    })
    .await
    .map_err(internal)?
}

pub(super) async fn charts(
    State(state): State<ServerState>,
    Path((id, sheet)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers, &id, false)?;
    let bundle = open(&state, &id)?;
    tokio::task::spawn_blocking(move || {
        let manifest = bundle.manifest().map_err(hcd_error)?;
        let charts: Vec<_> = hcd_core::worksheet_charts(&bundle, &manifest, Some(&sheet))
            .map_err(hcd_error)?
            .into_iter()
            .filter(|(_, chart)| !chart.removed)
            .collect();
        let (sheets, limited) = if charts.iter().any(|(_, chart)| !chart.source_missing) {
            match read_sheets(&bundle, &manifest) {
                Ok(sheets) => (sheets, false),
                Err(hcd_core::HcdError::ResourceLimit(_)) => (Vec::new(), true),
                Err(error) => return Err(hcd_error(error)),
            }
        } else {
            (Vec::new(), false)
        };
        let charts: Vec<_> = charts.into_iter().map(|(_, chart)| {
            let data = chart_data(&sheets, &sheet, &chart);
            let kind = match chart.config.kind {
                WorksheetChartKind::Column => "bar",
                WorksheetChartKind::Bar => "horizontalBar",
                WorksheetChartKind::Line => "line",
                WorksheetChartKind::Pie => "pie",
            };
            let series = data.as_ref().into_iter().flat_map(|data| {
                data.series.iter().enumerate().map(|(index, series)| ChartSeries {
                    name: if series.name.is_empty() { format!("Series {}", index + 1) } else { series.name.clone() },
                    name_formula: None,
                    categories: data.categories.clone(),
                    categories_formula: None,
                    x_values: Vec::new(),
                    x_values_formula: None,
                    values: series.values.iter().map(|value| value.unwrap_or(f64::NAN)).collect(),
                    values_formula: None,
                    bubble_sizes: Vec::new(),
                    bubble_sizes_formula: None,
                })
            }).collect();
            let svg = render_preview_svg(&ChartPreview {
                title: chart.config.title.clone(),
                chart_kinds: vec![kind.into()],
                series,
            });
            json!({"id":chart.id,"config":chart.config,"sourceMissing":chart.source_missing,"data":data,"svg":svg})
        }).collect();
        Ok(json!({"revision":manifest.revision,"calculationLimited":limited,"charts":charts}))
    }).await.map_err(internal)?.map(Json)
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
            merges: Vec::new(),
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
            merges: Vec::new(),
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
