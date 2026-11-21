use super::*;
use crate::{
    GridChunkAddress, GridChunkKind, WorksheetCondition, WorksheetConditionConfig,
    WorksheetConditionOperator, XlsxGridAction, XlsxGridAxis,
};

const MAX_ROW: u32 = 1_048_576;
const MAX_COLUMN: u32 = 16_384;
const MAX_RULES: usize = 128;

pub fn validate_worksheet_condition(config: &WorksheetConditionConfig) -> Result<(), HcdError> {
    let range = config.range;
    let bounded = matches!(
        config.operator,
        WorksheetConditionOperator::Between | WorksheetConditionOperator::NotBetween
    );
    let rgb = |value: &String| {
        value.len() == 7
            && value.starts_with('#')
            && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    };
    if range.start_row == 0
        || range.start_row > range.end_row
        || range.end_row > MAX_ROW
        || range.start_column == 0
        || range.start_column > range.end_column
        || range.end_column > MAX_COLUMN
        || config.values.len() != if bounded { 2 } else { 1 }
        || config
            .values
            .iter()
            .any(|value| value.len() > 40 || !value.parse::<f64>().is_ok_and(f64::is_finite))
        || config.fill.is_none() && config.color.is_none()
        || config.fill.as_ref().is_some_and(|value| !rgb(value))
        || config.color.as_ref().is_some_and(|value| !rgb(value))
    {
        return Err(HcdError::InvalidPatch(
            "conditional formatting requires an A1 range, finite numeric threshold(s), and a fill or font RGB color".into(),
        ));
    }
    Ok(())
}

pub(super) type ConditionChange = (String, Vec<WorksheetCondition>);

pub(super) fn resolve_condition_change(
    bundle: &Bundle,
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<Option<ConditionChange>, HcdError> {
    let Some(PatchOperation::XlsxConditionSet {
        sheet_id,
        condition_id,
        config,
    }) = patch.operations.first()
    else {
        return Ok(None);
    };
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, index)?.chunks {
            let Some(grid) = descriptor
                .grid
                .filter(|grid| grid.kind == GridChunkKind::Cells && grid.sheet_id == *sheet_id)
            else {
                continue;
            };
            let mut rules = grid.conditions;
            let existing = rules.iter().position(|rule| rule.id == *condition_id);
            match (existing, config) {
                (Some(index), Some(config)) if !rules[index].removed => {
                    let rule = &mut rules[index];
                    if &rule.config == config {
                        return Err(HcdError::PreconditionFailed(
                            "conditional rule is unchanged".into(),
                        ));
                    }
                    rule.config = config.clone();
                    rule.edited = true;
                }
                (Some(index), None) if !rules[index].removed => {
                    if rules[index].source_priority.is_some() {
                        rules[index].removed = true;
                        rules[index].edited = true;
                    } else {
                        rules.remove(index);
                    }
                }
                (None, Some(config)) if rules.len() < MAX_RULES => {
                    rules.push(WorksheetCondition {
                        id: condition_id.clone(),
                        config: config.clone(),
                        source_priority: None,
                        edited: true,
                        removed: false,
                    });
                }
                (None, Some(_)) => {
                    return Err(HcdError::ResourceLimit(format!(
                        "a worksheet supports at most {MAX_RULES} managed conditional rules"
                    )))
                }
                _ => return Err(HcdError::NodeNotFound(condition_id.clone())),
            }
            return Ok(Some((descriptor.chunk_id, rules)));
        }
    }
    Err(HcdError::NodeNotFound(sheet_id.clone()))
}

fn shift_interval(
    low: u32,
    high: u32,
    limit: u32,
    action: XlsxGridAction,
    at: u32,
    count: u32,
) -> Option<(u32, u32)> {
    if action == XlsxGridAction::Insert {
        let start = low + if at <= low { count } else { 0 };
        let end = high + if at <= high { count } else { 0 };
        return (start <= limit).then_some((start, end.min(limit)));
    }
    let through = at + count - 1;
    if at > high {
        Some((low, high))
    } else if through < low {
        Some((low - count, high - count))
    } else {
        let start = low.min(at);
        let end = high - (through.min(high) - at + 1);
        (end >= start && (low < at || high > through)).then_some((start, end))
    }
}

pub(super) fn shift_conditions(grid: &mut GridChunkAddress, patch: &PatchBatch) -> bool {
    if grid.conditions.is_empty() {
        return false;
    }
    let Some((sheet, axis, action, at, count)) = patch.operations.iter().find_map(|op| {
        use XlsxGridAction::{Delete, Insert};
        use XlsxGridAxis::{Column, Row};
        match op {
            PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row,
            } => Some((sheet_id, Row, Insert, *before_row, 1)),
            PatchOperation::XlsxRowDelete { sheet_id, row }
            | PatchOperation::XlsxRowRemoveLast { sheet_id, row } => {
                Some((sheet_id, Row, Delete, *row, 1))
            }
            PatchOperation::XlsxColumnInsert {
                sheet_id,
                before_column,
            } => Some((sheet_id, Column, Insert, *before_column, 1)),
            PatchOperation::XlsxColumnDelete { sheet_id, column } => {
                Some((sheet_id, Column, Delete, *column, 1))
            }
            PatchOperation::XlsxGridRange {
                sheet_id,
                axis,
                action,
                start,
                count,
            } => Some((sheet_id, *axis, *action, *start, *count)),
            _ => None,
        }
    }) else {
        return false;
    };
    if *sheet != grid.sheet_id {
        return false;
    }
    let mut changed = false;
    for condition in grid.conditions.iter_mut().filter(|rule| !rule.removed) {
        let range = &mut condition.config.range;
        let (low, high, limit) = match axis {
            XlsxGridAxis::Row => (&mut range.start_row, &mut range.end_row, MAX_ROW),
            XlsxGridAxis::Column => (&mut range.start_column, &mut range.end_column, MAX_COLUMN),
        };
        match shift_interval(*low, *high, limit, action, at, count) {
            Some((start, end)) if (*low, *high) != (start, end) => {
                (*low, *high) = (start, end);
                condition.edited = true;
                changed = true;
            }
            None => {
                condition.removed = true;
                condition.edited = true;
                changed = true;
            }
            _ => {}
        }
    }
    grid.conditions
        .retain(|rule| rule.source_priority.is_some() || !rule.removed);
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_and_shrinks_condition_range_with_grid_edits() {
        use XlsxGridAction::{Delete, Insert};
        assert_eq!(shift_interval(5, 8, MAX_ROW, Insert, 3, 2), Some((7, 10)));
        assert_eq!(shift_interval(5, 8, MAX_ROW, Insert, 7, 2), Some((5, 10)));
        assert_eq!(shift_interval(5, 8, MAX_ROW, Delete, 4, 3), Some((4, 5)));
        assert_eq!(shift_interval(5, 8, MAX_ROW, Delete, 5, 4), None);
        assert_eq!(shift_interval(5, 8, MAX_ROW, Delete, 7, 4), Some((5, 6)));
    }
}
