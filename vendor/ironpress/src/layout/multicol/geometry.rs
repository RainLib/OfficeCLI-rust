use crate::style::computed::{ComputedStyle, WritingMode};

/// Resolve the used number of columns and per-column width from the
/// `column-count` / `column-width` properties and the inner content width.
pub(super) fn resolve_columns(style: &ComputedStyle, inner_width: f32, gap: f32) -> (usize, f32) {
    let count = style.column_count;
    let width = style.column_width.filter(|w| *w > 0.0);

    let n = match (count, width) {
        (Some(c), Some(w)) => {
            // Use at most `c` columns, but no more than fit at the ideal width.
            let fit = ((inner_width + gap) / (w + gap)).floor() as i32;
            (c as i32).min(fit.max(1)).max(1) as usize
        }
        (Some(c), None) => (c.max(1)) as usize,
        (None, Some(w)) => {
            let fit = ((inner_width + gap) / (w + gap)).floor() as i32;
            fit.max(1) as usize
        }
        (None, None) => 1,
    };
    // Equal columns filling the inner width: colW = (inner - (n-1)*gap) / n.
    let col_width = ((inner_width - (n.saturating_sub(1)) as f32 * gap) / n as f32).max(0.0);
    (n, col_width)
}

/// Physical x offset of a document-order column. Columns are ordered in the
/// multicol container's inline base direction; for horizontal RTL that means
/// document column 0 is the rightmost physical column.
pub(super) fn column_x(
    style: &ComputedStyle,
    pad_left: f32,
    col_width: f32,
    gap: f32,
    num_cols: usize,
    col: usize,
) -> f32 {
    let visual_col = match style.writing_mode {
        WritingMode::HorizontalTb if style.direction_rtl => {
            num_cols.saturating_sub(1) as isize - col as isize
        }
        _ => col as isize,
    };
    pad_left + visual_col as f32 * (col_width + gap)
}

/// Center x of the column rule between adjacent document-order columns.
pub(super) fn column_rule_x(
    style: &ComputedStyle,
    pad_left: f32,
    col_width: f32,
    gap: f32,
    num_cols: usize,
    left_doc_col: usize,
) -> f32 {
    let a = column_x(style, pad_left, col_width, gap, num_cols, left_doc_col);
    let b = column_x(style, pad_left, col_width, gap, num_cols, left_doc_col + 1);
    let (left, right) = if a <= b { (a, b) } else { (b, a) };
    (left + col_width + right) / 2.0
}

pub(super) fn column_has_content(buckets: &[Vec<usize>], col: usize) -> bool {
    buckets.get(col).is_some_and(|b| !b.is_empty())
}
