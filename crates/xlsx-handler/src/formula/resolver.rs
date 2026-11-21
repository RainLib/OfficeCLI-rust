//! Cell resolution uses current expressions, never a formula's cached value.

use super::types::*;
use crate::dom_types::WorkbookModel;
use std::{
    cell::{Cell as Counter, RefCell},
    collections::HashSet,
    rc::Rc,
};

pub const MAX_RANGE_CELLS: usize = 20_000;
pub const MAX_CALCULATION_STEPS: usize = 200_000;
pub const MAX_CALCULATION_DEPTH: usize = 32;

pub struct WorkbookResolver<'a> {
    model: &'a WorkbookModel,
    sheet: usize,
    visiting: HashSet<(usize, String)>,
    budget: Rc<Counter<usize>>,
    failure: Rc<RefCell<Option<String>>>,
    verified_only: bool,
}

impl<'a> WorkbookResolver<'a> {
    pub fn new(model: &'a WorkbookModel) -> Self {
        Self::for_sheet(model, 0)
    }

    pub fn for_sheet(model: &'a WorkbookModel, sheet: usize) -> Self {
        Self {
            model,
            sheet,
            visiting: HashSet::new(),
            budget: Rc::new(Counter::new(MAX_CALCULATION_STEPS)),
            failure: Rc::new(RefCell::new(None)),
            verified_only: false,
        }
    }

    pub fn verified_for_sheet(model: &'a WorkbookModel, sheet: usize) -> Self {
        Self {
            verified_only: true,
            ..Self::for_sheet(model, sheet)
        }
    }

    pub fn find_sheet(&self, name: &str) -> Option<&crate::dom_types::Worksheet> {
        self.model
            .sheets
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(name))
    }

    fn fail(&self, error: &str) -> FormulaResult {
        *self.failure.borrow_mut() = Some(error.into());
        FormulaResult::Error(error.into())
    }

    fn reference<'b>(&self, reference: &'b str) -> Option<(usize, &'b str)> {
        if let Some((name, address)) = reference.rsplit_once('!') {
            let name = name.trim_matches('\'').replace("''", "'");
            self.model
                .sheets
                .iter()
                .position(|s| s.name.eq_ignore_ascii_case(&name))
                .map(|sheet| (sheet, address))
        } else {
            Some((self.sheet, reference))
        }
    }

    fn value(&self, sheet: usize, address: &str) -> FormulaResult {
        if self.budget.get() == 0 || self.visiting.len() >= MAX_CALCULATION_DEPTH {
            return self.fail("#NUM!");
        }
        self.budget.set(self.budget.get() - 1);
        let Some(ws) = self.model.sheets.get(sheet) else {
            return self.fail("#REF!");
        };
        let address = strip_dollar(address).to_ascii_uppercase();
        let Some(cell_ref) = crate::dom_types::CellRef::parse(&address)
            .filter(|r| r.col <= 16_384 && r.row <= 1_048_576 && r.to_string_ref() == address)
        else {
            return self.fail("#REF!");
        };
        let Some(cell) = ws.cells.get(&(cell_ref.row, cell_ref.col)) else {
            return FormulaResult::Blank;
        };
        if let Some(formula) = &cell.formula {
            if self.verified_only {
                if let Err(error) = super::check_formula_support(formula) {
                    return self.fail(&error);
                }
            }
            let key = (sheet, address);
            if self.visiting.contains(&key) {
                return self.fail("#REF!");
            }
            let mut visiting = self.visiting.clone();
            visiting.insert(key);
            super::evaluate_with_resolver(
                formula,
                &Self {
                    model: self.model,
                    sheet,
                    visiting,
                    budget: self.budget.clone(),
                    failure: self.failure.clone(),
                    verified_only: self.verified_only,
                },
            )
        } else {
            cell_value_to_formula_result(cell)
        }
    }
}

impl super::parser::CellResolver for WorkbookResolver<'_> {
    fn evaluation_failure(&self) -> Option<String> {
        self.failure.borrow().clone()
    }
    fn resolve_cell(&self, reference: &str) -> FormulaResult {
        self.value(self.sheet, reference)
    }

    fn resolve_sheet_cell(&self, reference: &str) -> FormulaResult {
        self.reference(reference)
            .map(|(sheet, address)| self.value(sheet, address))
            .unwrap_or_else(|| self.fail("#REF!"))
    }

    fn expand_range(&self, reference: &str) -> Vec<(String, FormulaResult)> {
        let invalid = |error: &str| vec![("A1".into(), self.fail(error))];
        let Some((sheet, range)) = self.reference(reference) else {
            return invalid("#REF!");
        };
        let Some((left, right)) = range.split_once(':') else {
            return invalid("#REF!");
        };
        let left = strip_dollar(left).to_ascii_uppercase();
        let right = strip_dollar(right).to_ascii_uppercase();
        // Whole rows/columns have their true Excel extent. Never silently
        // truncate to the used range: COUNTBLANK would otherwise lie.
        let (a, b) = if !left.is_empty()
            && !right.is_empty()
            && left.chars().all(|c| c.is_ascii_alphabetic())
            && right.chars().all(|c| c.is_ascii_alphabetic())
        {
            (format!("{left}1"), format!("{right}1048576"))
        } else if !left.is_empty()
            && !right.is_empty()
            && left.chars().all(|c| c.is_ascii_digit())
            && right.chars().all(|c| c.is_ascii_digit())
        {
            (format!("A{left}"), format!("XFD{right}"))
        } else {
            (left, right)
        };
        let (Some(a), Some(b)) = (
            crate::dom_types::CellRef::parse(&a),
            crate::dom_types::CellRef::parse(&b),
        ) else {
            return invalid("#REF!");
        };
        if a.col > 16384 || b.col > 16384 || a.row > 1048576 || b.row > 1048576 {
            return invalid("#REF!");
        }
        let count = (a.row.abs_diff(b.row) as u64 + 1) * (a.col.abs_diff(b.col) as u64 + 1);
        if count > MAX_RANGE_CELLS as u64 || count > self.budget.get() as u64 {
            return invalid("#NUM!");
        }
        let mut values = Vec::with_capacity(count as usize);
        for row in a.row.min(b.row)..=a.row.max(b.row) {
            for col in a.col.min(b.col)..=a.col.max(b.col) {
                let address = format!("{}{row}", index_to_col(col));
                values.push((address.clone(), self.value(sheet, &address)));
            }
        }
        values
    }
}

/// Interpret a native literal without guessing its type from display text.
/// HCD inspection uses this same conversion as the native workbook resolver.
pub fn evaluate_literal(value_type: &str, raw: Option<&str>, text: &str) -> FormulaResult {
    match value_type {
        "blank" => FormulaResult::Blank,
        "string" => FormulaResult::Str(text.to_string()),
        "boolean" => match raw.unwrap_or(text) {
            "1" | "true" | "TRUE" => FormulaResult::Bool(true),
            "0" | "false" | "FALSE" => FormulaResult::Bool(false),
            _ => FormulaResult::Error("#VALUE!".into()),
        },
        "error" => FormulaResult::Error(text.to_string()),
        "number" => match raw {
            None | Some("") if text.is_empty() => FormulaResult::Blank,
            _ => raw
                .unwrap_or(text)
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(FormulaResult::Number)
                .unwrap_or_else(|| FormulaResult::Error("#VALUE!".into())),
        },
        _ => FormulaResult::Error("#VALUE!".into()),
    }
}

/// Convert a Cell's native value to a FormulaResult.
fn cell_value_to_formula_result(cell: &crate::dom_types::Cell) -> FormulaResult {
    let value_type = match cell.value_type {
        crate::dom_types::CellValueType::Number => "number",
        crate::dom_types::CellValueType::SharedString
        | crate::dom_types::CellValueType::InlineString => "string",
        crate::dom_types::CellValueType::Boolean => "boolean",
        crate::dom_types::CellValueType::Error => "error",
    };
    evaluate_literal(value_type, cell.raw_value.as_deref(), &cell.display_value)
}
