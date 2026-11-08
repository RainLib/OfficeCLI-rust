//! Page-row construction for paginated multi-column formatting contexts.

use super::distribution::{balance_columns, balanced_buckets_height};
use super::flow::{ColumnFragmentation, fragment_columns};
use super::fragments::{
    make_band_container, make_column_container, make_fragment_box, make_rule_container,
};
use super::geometry::{column_has_content, column_rule_x, column_x};
use super::items::MultiColItem;
use crate::layout::elements::LayoutNode;
use crate::layout::roundoff::exceeds_with_roundoff;
use crate::style::computed::ComputedStyle;

/// Distribute `items` into a sequence of per-page column rows for a paginated
/// multicol (CSS Multicol §2). Each page-row is a fresh set of `num_cols` columns
/// filled sequentially to `col_fill_h` (the page's content-box height), and any
/// block that does not fit continues at the top of the next page-row — so content
/// flows column-by-column down a page, then onto the next page, instead of being
/// clipped.
///
/// Reuses [`fragment_columns`] with dynamically growing *virtual* columns,
/// then regroups every `num_cols` virtual columns into one page-row. Returns
/// `(column_children, used_content_height)` per page-row, in page order, with
/// trailing empty rows dropped. A single returned row means the content fits one
/// page (the caller then takes the unchanged single-page path).
#[allow(clippy::too_many_arguments)]
pub(super) fn build_paginated_column_rows(
    items: &[MultiColItem],
    num_cols: usize,
    col_width: f32,
    gap: f32,
    pad_left: f32,
    col_fill_h: f32,
    style: &ComputedStyle,
) -> Vec<(Vec<LayoutNode>, f32)> {
    let indices: Vec<usize> = (0..items.len()).collect();
    let fragmented = fragment_columns(
        items,
        &indices,
        ColumnFragmentation::overflowing(num_cols, col_fill_h),
    );
    let page_rows = fragmented.columns.len().div_ceil(num_cols);

    let rule_active = style.column_rule.used_width() > 0.0 && num_cols > 1;
    let mut rows: Vec<(Vec<LayoutNode>, f32)> = Vec::new();
    for page in 0..page_rows {
        let mut row_children: Vec<LayoutNode> = Vec::new();
        let mut row_max = 0.0f32;
        let mut has_content = false;
        for pc in 0..num_cols {
            let vc = page * num_cols + pc;
            if vc >= fragmented.columns.len() {
                break;
            }
            let frags = &fragmented.columns[vc];
            if frags.is_empty() {
                continue;
            }
            has_content = true;
            row_max = row_max.max(fragmented.used_block_sizes[vc]);
            let col_x = column_x(style, pad_left, col_width, gap, num_cols, pc);
            let mut kids: Vec<LayoutNode> = Vec::new();
            for fragment in frags {
                kids.push(make_fragment_box(
                    &items[fragment.item].elements[0],
                    fragment.placement(0.0, col_width),
                ));
            }
            row_children.push(make_column_container(
                kids,
                pc,
                col_x - pad_left + style.padding.left,
                style.padding.top,
                col_width,
                fragmented.used_block_sizes[vc],
            ));
        }
        if !has_content {
            continue;
        }
        if rule_active {
            let rule_width = style.column_rule.used_width();
            let rule_color = style.column_rule.color.resolve(style.color);
            for column in 0..num_cols - 1 {
                let left = page * num_cols + column;
                let right = left + 1;
                if fragmented.columns.get(left).is_none_or(Vec::is_empty)
                    || fragmented.columns.get(right).is_none_or(Vec::is_empty)
                {
                    continue;
                }
                let gap_center = column_rule_x(style, pad_left, col_width, gap, num_cols, column);
                row_children.push(make_rule_container(
                    column,
                    gap_center - rule_width / 2.0 - pad_left + style.padding.left,
                    style.padding.top,
                    rule_width,
                    row_max,
                    rule_color,
                    style.column_rule.style,
                ));
            }
        }
        rows.push((row_children, row_max));
    }
    rows
}

/// Page-aware balanced multicol fragmentation for `column-fill: balance-all`.
/// Each page row takes the largest document-order run that can be balanced into
/// the available column block-size, then the next page row re-balances the
/// remaining content.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_balanced_paginated_column_rows(
    items: &[MultiColItem],
    num_cols: usize,
    col_width: f32,
    gap: f32,
    pad_left: f32,
    col_fill_h: f32,
    style: &ComputedStyle,
) -> Vec<(Vec<LayoutNode>, f32)> {
    let mut rows: Vec<(Vec<LayoutNode>, f32)> = Vec::new();
    let mut start = 0usize;
    while start < items.len() {
        let mut best_end = start + 1;
        let mut best_buckets = vec![vec![0usize]];
        let mut best_height = items[start].height;

        for end in start + 1..=items.len() {
            let heights: Vec<f32> = items[start..end].iter().map(|item| item.height).collect();
            let buckets = balance_columns(&heights, num_cols);
            let row_height = balanced_buckets_height(&items[start..end], &buckets);
            if !exceeds_with_roundoff(row_height, col_fill_h) || end == start + 1 {
                best_end = end;
                best_buckets = buckets;
                best_height = row_height;
            } else {
                break;
            }
        }

        let mut row_children: Vec<LayoutNode> = Vec::new();
        if style.column_rule.used_width() > 0.0 && num_cols > 1 {
            let rule_width = style.column_rule.used_width();
            let rule_color = style.column_rule.color.resolve(style.color);
            for column in 0..num_cols - 1 {
                if !column_has_content(&best_buckets, column)
                    || !column_has_content(&best_buckets, column + 1)
                {
                    continue;
                }
                let gap_center = column_rule_x(style, pad_left, col_width, gap, num_cols, column);
                row_children.push(make_rule_container(
                    column,
                    gap_center - rule_width / 2.0 - pad_left + style.padding.left,
                    style.padding.top,
                    rule_width,
                    best_height,
                    rule_color,
                    style.column_rule.style,
                ));
            }
        }

        for (column, bucket) in best_buckets.iter().enumerate() {
            if bucket.is_empty() {
                continue;
            }
            let column_x = column_x(style, pad_left, col_width, gap, num_cols, column);
            let mut column_children: Vec<LayoutNode> = Vec::new();
            let mut column_height = 0.0f32;
            for &index in bucket {
                column_height += items[start + index].height;
                column_children.extend(items[start + index].elements.clone());
            }
            row_children.push(make_column_container(
                column_children,
                column,
                column_x - pad_left + style.padding.left,
                style.padding.top,
                col_width,
                column_height,
            ));
        }
        rows.push((row_children, best_height));
        start = best_end;
    }
    rows
}

/// Page-aware multicol fragmentation for flows that include `column-span: all`.
/// Consecutive non-span items are balanced into the remaining column space on the
/// current page row; a span-all item is placed as a full-width band at the current
/// block cursor. When the next segment would overflow, a new page row starts.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_paginated_column_rows_with_spans(
    items: &[MultiColItem],
    num_cols: usize,
    col_width: f32,
    gap: f32,
    pad_left: f32,
    col_fill_h: f32,
    inner_width: f32,
    style: &ComputedStyle,
) -> Vec<(Vec<LayoutNode>, f32)> {
    let mut rows: Vec<(Vec<LayoutNode>, f32)> = Vec::new();
    let mut row_children: Vec<LayoutNode> = Vec::new();
    let mut cursor = 0.0f32;

    let finish_row = |rows: &mut Vec<(Vec<LayoutNode>, f32)>,
                      row_children: &mut Vec<LayoutNode>,
                      cursor: &mut f32| {
        if row_children.is_empty() {
            *cursor = 0.0;
            return;
        }
        rows.push((std::mem::take(row_children), (*cursor).max(0.0)));
        *cursor = 0.0;
    };

    let add_rules = |row_children: &mut Vec<LayoutNode>, run_top: f32, run_height: f32| {
        if style.column_rule.used_width() <= 0.0 || num_cols <= 1 || run_height <= 0.0 {
            return;
        }
        let rule_width = style.column_rule.used_width();
        let rule_color = style.column_rule.color.resolve(style.color);
        for column in 0..num_cols - 1 {
            let gap_center = column_rule_x(style, pad_left, col_width, gap, num_cols, column);
            row_children.push(make_rule_container(
                column,
                gap_center - rule_width / 2.0 - pad_left + style.padding.left,
                style.padding.top + run_top,
                rule_width,
                run_height,
                rule_color,
                style.column_rule.style,
            ));
        }
    };

    let place_balanced_run = |row_children: &mut Vec<LayoutNode>,
                              run: &[MultiColItem],
                              top: f32,
                              truncate_all_trailing: bool|
     -> f32 {
        let heights: Vec<f32> = run.iter().map(|item| item.height).collect();
        let buckets = balance_columns(&heights, num_cols);
        let last_nonempty_column = buckets
            .iter()
            .rposition(|bucket| !bucket.is_empty())
            .unwrap_or(usize::MAX);
        let mut run_max_height = 0.0f32;
        for (column, bucket) in buckets.iter().enumerate() {
            if bucket.is_empty() {
                continue;
            }
            let column_x = column_x(style, pad_left, col_width, gap, num_cols, column);
            let mut column_children: Vec<LayoutNode> = Vec::new();
            let mut column_height = 0.0f32;
            for &index in bucket {
                column_height += run[index].height;
                column_children.extend(run[index].elements.clone());
            }
            let used_column_height = if truncate_all_trailing || column != last_nonempty_column {
                let trailing_margin = bucket.last().map_or(0.0, |&index| run[index].margin_bottom);
                (column_height - trailing_margin).max(0.0)
            } else {
                column_height
            };
            run_max_height = run_max_height.max(used_column_height);
            row_children.push(make_column_container(
                column_children,
                column,
                column_x - pad_left + style.padding.left,
                style.padding.top + top,
                col_width,
                column_height,
            ));
        }
        run_max_height
    };

    let mut item_index = 0usize;
    while item_index < items.len() {
        if items[item_index].span_all {
            let band_height = items[item_index].height;
            if cursor > 0.0 && exceeds_with_roundoff(cursor + band_height, col_fill_h) {
                finish_row(&mut rows, &mut row_children, &mut cursor);
            }
            row_children.push(make_band_container(
                items[item_index].elements.clone(),
                style.padding.left,
                style.padding.top + cursor,
                inner_width,
                band_height,
            ));
            cursor += band_height;
            item_index += 1;
            continue;
        }

        let run_start = item_index;
        while item_index < items.len() && !items[item_index].span_all {
            item_index += 1;
        }
        let run_end = item_index;
        let mut start = run_start;
        while start < run_end {
            if !exceeds_with_roundoff(col_fill_h, cursor) {
                finish_row(&mut rows, &mut row_children, &mut cursor);
            }
            let remaining = (col_fill_h - cursor).max(0.0);
            let mut best_end = start;
            let mut best_height = 0.0f32;
            for end in start + 1..=run_end {
                let heights: Vec<f32> = items[start..end].iter().map(|item| item.height).collect();
                let buckets = balance_columns(&heights, num_cols);
                let mut maximum_height = 0.0f32;
                let truncates_at_page_break = end < run_end;
                let last_nonempty_column = buckets
                    .iter()
                    .rposition(|bucket| !bucket.is_empty())
                    .unwrap_or(usize::MAX);
                for (column, bucket) in buckets.iter().enumerate() {
                    let mut column_height = bucket
                        .iter()
                        .map(|&index| items[start + index].height)
                        .sum::<f32>();
                    if (truncates_at_page_break || column != last_nonempty_column)
                        && let Some(&last_index) = bucket.last()
                    {
                        column_height =
                            (column_height - items[start + last_index].margin_bottom).max(0.0);
                    }
                    maximum_height = maximum_height.max(column_height);
                }
                if !exceeds_with_roundoff(maximum_height, remaining) || best_end == start {
                    best_end = end;
                    best_height = maximum_height;
                } else {
                    break;
                }
            }
            if best_end == start {
                if cursor > 0.0 {
                    finish_row(&mut rows, &mut row_children, &mut cursor);
                    continue;
                }
                best_end = start + 1;
            }
            let top = cursor;
            let placed_height = place_balanced_run(
                &mut row_children,
                &items[start..best_end],
                top,
                best_end < run_end,
            );
            let used_height = placed_height.max(best_height);
            add_rules(&mut row_children, top, used_height);
            cursor += used_height;
            start = best_end;
            if start < run_end {
                finish_row(&mut rows, &mut row_children, &mut cursor);
            }
        }
    }
    finish_row(&mut rows, &mut row_children, &mut cursor);
    rows
}
