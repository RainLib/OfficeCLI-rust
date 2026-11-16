//! Formula evaluator module for xlsx documents.
//!
//! Supports 80+ Excel-compatible functions including math, logical, text,
//! lookup, date/time, statistical, conditional, financial, and trig functions.

mod capabilities;
mod functions;
mod modern;
mod parser;
#[cfg(test)]
mod regression;
mod resolver;
pub mod tokenizer;
pub mod types;

pub use capabilities::{
    calculation_capabilities, check_formula_support, normalized_function, CALCULATION_CONTRACT,
    VERIFIED_FUNCTIONS,
};
pub use modern::{is_dynamic_array_formula, qualify_for_ooxml, unqualify_for_readback};
pub use parser::CellResolver;
pub use resolver::{evaluate_literal, WorkbookResolver};
pub use types::{format_number, FormulaResult};

/// Evaluate a formula string (without leading '=') against a workbook model.
/// Returns None if the formula cannot be evaluated.
pub fn evaluate(formula: &str, model: &crate::dom_types::WorkbookModel) -> Option<FormulaResult> {
    evaluate_in_sheet(formula, model, 0)
}

pub fn evaluate_in_sheet(
    formula: &str,
    model: &crate::dom_types::WorkbookModel,
    sheet: usize,
) -> Option<FormulaResult> {
    let resolver = WorkbookResolver::for_sheet(model, sheet);
    Some(evaluate_with_resolver(formula, &resolver))
}

/// Verified recalculation used by structured CLI output and shared capability
/// clients. The check also applies transitively to referenced formula cells.
pub fn evaluate_checked_in_sheet(
    formula: &str,
    model: &crate::dom_types::WorkbookModel,
    sheet: usize,
) -> Result<FormulaResult, String> {
    check_formula_support(formula)?;
    let resolver = WorkbookResolver::verified_for_sheet(model, sheet);
    match evaluate_with_resolver(formula, &resolver) {
        FormulaResult::Error(error) => Err(error),
        result => Ok(result),
    }
}

/// Evaluate a formula string with a specific resolver.
pub fn evaluate_with_resolver(formula: &str, resolver: &dyn CellResolver) -> FormulaResult {
    let result = match parser::FormulaParser::new(formula, resolver) {
        Ok(mut p) => p
            .evaluate()
            .unwrap_or(FormulaResult::Error("#VALUE!".to_string())),
        Err(_) => FormulaResult::Error("#NAME?".to_string()),
    };
    if let Some(error) = resolver.evaluation_failure() {
        return FormulaResult::Error(error);
    }
    match result {
        FormulaResult::Number(number) if !number.is_finite() => {
            FormulaResult::Error("#NUM!".into())
        }
        result => result,
    }
}

/// Evaluate a formula while retaining any dynamic-array matrix result.
pub fn evaluate_spill(
    formula: &str,
    model: &crate::dom_types::WorkbookModel,
) -> Option<FormulaResult> {
    evaluate_spill_in_sheet(formula, model, 0)
}

pub fn evaluate_spill_in_sheet(
    formula: &str,
    model: &crate::dom_types::WorkbookModel,
    sheet: usize,
) -> Option<FormulaResult> {
    let resolver = WorkbookResolver::for_sheet(model, sheet);
    parser::FormulaParser::new(formula, &resolver)
        .ok()?
        .evaluate_spill()
}
