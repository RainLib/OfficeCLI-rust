use super::*;
use crate::{Cell, CellRef, CellValueType, WorkbookModel, Worksheet};

fn workbook(sheets: &[(&str, &[(&str, &str)])]) -> WorkbookModel {
    WorkbookModel {
        sheets: sheets
            .iter()
            .enumerate()
            .map(|(index, (name, cells))| Worksheet {
                name: (*name).into(),
                index: index + 1,
                part_path: String::new(),
                rel_id: String::new(),
                cells: cells
                    .iter()
                    .map(|(address, source)| {
                        let r = CellRef::parse(address).unwrap();
                        let formula = source.strip_prefix('=');
                        let string = source.strip_prefix("text:");
                        (
                            (r.row, r.col),
                            Cell {
                                ref_str: (*address).into(),
                                row: r.row,
                                col: r.col,
                                value_type: if string.is_some() {
                                    CellValueType::InlineString
                                } else {
                                    CellValueType::Number
                                },
                                raw_value: Some(
                                    if formula.is_some() { "999" } else { source }.to_string(),
                                ),
                                formula: formula.map(String::from),
                                display_value: if formula.is_some() {
                                    "999"
                                } else {
                                    string.unwrap_or(source)
                                }
                                .into(),
                                style_index: None,
                                value_metadata_index: None,
                            },
                        )
                    })
                    .collect(),
                max_row: 20,
                max_col: 10,
            })
            .collect(),
        shared_strings: vec![],
        pivot_tables: vec![],
        tables: vec![],
    }
}

#[test]
fn excel_core_regressions_include_unicode_blank_strings_and_negative_digits() {
    let model = workbook(&[(
        "Sheet1",
        &[
            ("A1", "1"),
            ("A2", "2"),
            ("A4", "text:"),
            ("A5", "text:7"),
            ("A6", "text:中文"),
        ],
    )]);
    for (formula, expected) in [
        ("LEN(\"中文\")", 2.0),
        ("LEN(\"文😀\")", 2.0),
        ("COUNTBLANK(A1:A6)", 2.0),
        ("COUNTA(A1:A6)", 5.0),
        ("COUNT(A1:A6)", 2.0),
        ("SUM(A1:A6)", 3.0),
        ("COUNT(A5)", 0.0),
        ("COUNT(\"7\",TRUE)", 2.0),
        ("AVERAGE(A1:A6)", 1.5),
        ("ROUNDUP(-1.21,1)", -1.3),
        ("ROUNDDOWN(-1.21,1)", -1.2),
        ("ROUNDUP(-121,-1)", -130.0),
        ("ROUNDDOWN(-129,-1)", -120.0),
        ("ROUNDUP(1.1,2)", 1.1),
        ("ROUNDDOWN(0.29,2)", 0.29),
        ("ROUND(-1.25,1)", -1.3),
        ("LEN(\"中文\")>=2", 1.0),
        ("SUM ({1,2;3,4})", 10.0),
        ("LEN(\"中\")+SUM({1,2})", 4.0),
    ] {
        let actual = evaluate(formula, &model).unwrap();
        assert!(!actual.is_error(), "{formula}: {actual:?}");
        assert!(
            (actual.as_number() - expected).abs() < 1e-12,
            "{formula}: {actual:?}, expected {expected}"
        );
    }
}

#[test]
fn ranges_recompute_dependencies_and_follow_the_referenced_sheet() {
    // Imported caches are deliberately 999. A valid total cannot depend on
    // cell iteration order or on the first worksheet's values.
    let model = workbook(&[
        ("First", &[("A1", "100"), ("B1", "='销售'!B1")]),
        (
            "销售",
            &[
                ("A1", "3"),
                ("A2", "4"),
                ("B1", "=SUM(A1:A2)*2"),
                ("C1", "=SUM(B1:B1)+B1"),
            ],
        ),
    ]);
    assert_eq!(
        evaluate("SUM('销售'!B1:B1)", &model),
        Some(FormulaResult::Number(14.0))
    );
    assert_eq!(
        evaluate("销售!B1", &model),
        Some(FormulaResult::Number(14.0))
    );
    assert_eq!(
        evaluate_in_sheet("C1", &model, 1),
        Some(FormulaResult::Number(28.0))
    );
    assert_eq!(evaluate("B1", &model), Some(FormulaResult::Number(14.0)));
}

#[test]
fn errors_cycles_limits_and_malformed_formulas_do_not_report_successful_totals() {
    let model = workbook(&[(
        "Sheet1",
        &[("A1", "=A2"), ("A2", "=A1"), ("B1", "=UNKNOWN(1)")],
    )]);
    for formula in [
        "SUM(A1:A2)",
        "SUM(B1:B1)",
        "SUM(Missing!A1:A2)",
        "SUM(A1:A1048576)",
        "COUNTBLANK(A:A)",
        "SUM(1,2",
        "(1+2",
        "LEN(\"中文)",
        "ROUNDUP(#N/A,1)",
        "SUM(#DIV/0!,2)",
        "LEN()",
    ] {
        assert!(evaluate(formula, &model).unwrap().is_error(), "{formula}");
    }
    assert_eq!(
        evaluate("COUNTA(#N/A,\"\")", &model),
        Some(FormulaResult::Number(2.0))
    );
}

#[test]
fn verified_results_check_transitive_function_support_without_disabling_compatibility_previews() {
    let model = workbook(&[("Sheet1", &[("A1", "=IF(1,2,3)"), ("A2", "=LEN(\"中文\")")])]);
    assert_eq!(evaluate("A1", &model), Some(FormulaResult::Number(2.0)));
    assert_eq!(
        evaluate_checked_in_sheet("SUM(A1:A1)", &model, 0),
        Err("unsupported_function".into())
    );
    assert_eq!(
        evaluate_checked_in_sheet("A2*2", &model, 0),
        Ok(FormulaResult::Number(4.0))
    );
    assert_eq!(check_formula_support("_xlfn.RANK.EQ(1,A1:A2)"), Ok(()));
    for formula in ["ABS(\"abc\")", "ROUNDUP(\"abc\",1)", "ROUNDUP(1,1e999)"] {
        assert!(
            evaluate_checked_in_sheet(formula, &model, 0).is_err(),
            "{formula}"
        );
    }
}

#[test]
fn imported_literal_types_and_error_counting_are_distinct_from_display_text() {
    let mut model = workbook(&[(
        "Sheet1",
        &[
            ("A1", "1"),
            ("A2", "0"),
            ("A3", "text:"),
            ("A4", "text:"),
            ("A5", ""),
            ("A6", "text:#N/A"),
            ("A7", "#N/A"),
            ("A8", "text:12"),
            ("A9", "3"),
            ("B1", "=1/0"),
        ],
    )]);
    let cells = &mut model.sheets[0].cells;
    cells.get_mut(&(1, 1)).unwrap().value_type = CellValueType::Boolean;
    cells.get_mut(&(2, 1)).unwrap().value_type = CellValueType::Boolean;
    cells.get_mut(&(4, 1)).unwrap().value_type = CellValueType::SharedString;
    cells.get_mut(&(5, 1)).unwrap().raw_value = None;
    cells.get_mut(&(7, 1)).unwrap().value_type = CellValueType::Error;
    for (formula, expected) in [
        ("SUM(A1:A5)", "0"),
        ("COUNT(A1:A9)", "1"),
        ("COUNTA(A1:A9)", "8"),
        ("COUNTBLANK(A1:A9)", "3"),
        ("A1=TRUE", "TRUE"),
        ("A2=FALSE", "TRUE"),
        ("LEN(A6)", "4"),
        ("SUM(A8:A9)", "3"),
        ("COUNTA(B1:B1)", "1"),
        ("COUNT(B1:B1)", "0"),
        ("COUNTBLANK(B1:B1)", "0"),
        ("COUNTA(A5:A5)", "0"),
    ] {
        assert_eq!(
            evaluate_checked_in_sheet(formula, &model, 0).map(|result| result.as_string()),
            Ok(expected.into()),
            "{formula}"
        );
    }
    assert_eq!(
        evaluate_checked_in_sheet("SUM(A1:A9)", &model, 0),
        Err("#N/A".into())
    );
}
