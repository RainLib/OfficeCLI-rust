use super::items::MultiColItem;
use crate::layout::roundoff::exceeds_with_roundoff;

pub(super) fn balanced_buckets_height(items: &[MultiColItem], buckets: &[Vec<usize>]) -> f32 {
    buckets
        .iter()
        .map(|bucket| bucket.iter().map(|&idx| items[idx].height).sum::<f32>())
        .fold(0.0f32, f32::max)
}

pub(super) fn max_vertical_rl_item_height(items: &[MultiColItem]) -> f32 {
    items.iter().map(|item| item.height).fold(0.0f32, f32::max)
}

/// Assign items (by index, in document order) to `num_cols` columns so the
/// tallest column is as short as possible, breaking only at item boundaries
/// (an item is never split — honouring `break-inside: avoid`). This models CSS
/// `column-fill: balance`.
///
/// We binary-search the minimal feasible non-negative `f32` column height, down
/// to adjacent representable values, then greedily pack at that height. Returns
/// one bucket of item indices per column.
pub(super) fn balance_columns(heights: &[f32], num_cols: usize) -> Vec<Vec<usize>> {
    let n = heights.len();
    if num_cols <= 1 || n == 0 {
        return vec![(0..n).collect()];
    }

    // Greedily fill columns, starting a new column whenever adding the next
    // item would exceed `limit` (a non-empty column). Returns the number of
    // columns used, or None if it doesn't fit in `num_cols`.
    let fits = |limit: f32| -> Option<usize> {
        let mut cols_used = 1usize;
        let mut col_h = 0.0f32;
        for &h in heights {
            if col_h > 0.0 && exceeds_with_roundoff(col_h + h, limit) {
                cols_used += 1;
                col_h = 0.0;
                if cols_used > num_cols {
                    return None;
                }
            }
            col_h += h;
        }
        Some(cols_used)
    };

    // Candidate limits: each item height (a single item never splits, so the
    // limit must be at least the tallest item) and total/num_cols upward.
    let total: f32 = heights.iter().sum();
    let max_item = heights.iter().cloned().fold(0.0f32, f32::max);
    let lo = max_item.max(total / num_cols as f32);
    // Upper bound: the whole run in one column always fits.
    let hi = total.max(lo);
    let limit = if fits(lo).is_some() {
        lo
    } else if lo.is_finite() && hi.is_finite() {
        // Positive finite f32 bit patterns have the same ordering as their
        // numeric values. Keep `infeasible_bits` known-infeasible and
        // `feasible_bits` known-feasible until no representable value lies
        // between them. This is exact for the arithmetic used by `fits`; a
        // fixed sample grid can skip a real breakpoint by a visible amount.
        let mut infeasible_bits = lo.to_bits();
        let mut feasible_bits = hi.to_bits();
        while feasible_bits - infeasible_bits > 1 {
            let mid_bits = infeasible_bits + (feasible_bits - infeasible_bits) / 2;
            if fits(f32::from_bits(mid_bits)).is_some() {
                feasible_bits = mid_bits;
            } else {
                infeasible_bits = mid_bits;
            }
        }
        f32::from_bits(feasible_bits)
    } else {
        hi
    };

    // Pack at the chosen limit.
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); num_cols];
    let mut col = 0usize;
    let mut col_h = 0.0f32;
    for (idx, &h) in heights.iter().enumerate() {
        if col + 1 < num_cols && col_h > 0.0 && exceeds_with_roundoff(col_h + h, limit) {
            col += 1;
            col_h = 0.0;
        }
        buckets[col].push(idx);
        col_h += h;
    }
    buckets
}

/// Atomic `column-fill: auto` fallback (used when a run contains a non-slice-able
/// item, e.g. an image or table): fill each column with whole items in document
/// order up to `fill_h`, then move to the next column; the last column is left
/// short. A block whose addition would overflow the current non-empty column
/// instead starts the next one (never split). The slice-able common case is
/// handled by `fragment_columns`, which fragments the crossing block.
/// Overflow creates additional columns in the inline direction; the specified
/// count is the initial line size, not a clipping boundary.
pub(super) fn fill_columns(heights: &[f32], num_cols: usize, fill_h: f32) -> Vec<Vec<usize>> {
    let n = heights.len();
    if n == 0 || fill_h <= 0.0 {
        return vec![(0..n).collect()];
    }
    let mut buckets: Vec<Vec<usize>> = (0..num_cols.max(1)).map(|_| Vec::new()).collect();
    let mut col = 0usize;
    let mut col_h = 0.0f32;
    for (idx, &h) in heights.iter().enumerate() {
        if col_h > 0.0 && exceeds_with_roundoff(col_h + h, fill_h) {
            col += 1;
            col_h = 0.0;
            if col == buckets.len() {
                buckets.push(Vec::new());
            }
        }
        buckets[col].push(idx);
        col_h += h;
    }
    buckets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_overflow_extends_past_the_specified_column_count() {
        assert_eq!(
            fill_columns(&[60.0, 60.0, 60.0], 2, 100.0),
            vec![vec![0], vec![1], vec![2]]
        );
    }
}
