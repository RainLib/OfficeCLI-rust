//! Fragmentainer geometry and balancing for multi-column content.

use super::distribution::balance_columns;
use super::items::MultiColItem;
use crate::layout::elements::{
    Container, FragmentBreakQuery, FragmentBreakRule, FragmentPlacement, LayoutElement,
    LayoutVisitor, TextBlock,
};
use crate::layout::roundoff::{
    equal_with_roundoff, exceeds_with_roundoff, is_positive_with_roundoff,
};
use crate::types::{Point, Size, Vector};

pub(super) struct ColumnFragment {
    /// Index into the run of the source item this fragment belongs to.
    pub(super) item: usize,
    /// Border-box top of the fragment, relative to the column content top (px).
    pub(super) y: f32,
    /// Border-box height of this fragment (px).
    pub(super) height: f32,
    /// Offset from the source item's border-box top to this fragment's top.
    /// Text continuation must be projected through this offset rather than
    /// repainting the source's first line in every column.
    pub(super) source_top: f32,
    /// This fragment contains the item's top edge (first slice → keep top border).
    pub(super) is_first: bool,
    /// This fragment contains the item's bottom edge (last slice → keep bottom
    /// border + the item's trailing margin extends below it within the column).
    pub(super) is_last: bool,
}

impl ColumnFragment {
    pub(super) fn placement(&self, inline_offset: f32, inline_size: f32) -> BoxFragmentPlacement {
        BoxFragmentPlacement {
            origin: Point::new(inline_offset, self.y),
            size: Size::new(inline_size, self.height),
            source: SourceBlockRange::fragment(self.source_top, self.height, self.is_last),
            edges: FragmentEdges {
                block_start: self.is_first,
                block_end: self.is_last,
            },
        }
    }
}

/// The source-coordinate interval owned by one box fragment.
///
/// The final fragment has no upper bound: content overflowing a definite
/// principal box remains associated with its final fragment instead of
/// enlarging the box or being duplicated in every preceding fragment.
#[derive(Clone, Copy)]
pub(super) struct SourceBlockRange {
    pub(super) start: f32,
    pub(super) end: Option<f32>,
}

impl SourceBlockRange {
    const fn fragment(start: f32, block_size: f32, is_last: bool) -> Self {
        Self {
            start,
            end: if is_last {
                None
            } else {
                Some(start + block_size)
            },
        }
    }

    #[cfg(test)]
    pub(super) const fn continuation(start: f32) -> Self {
        Self { start, end: None }
    }

    #[cfg(test)]
    pub(super) const fn bounded(start: f32, end: f32) -> Self {
        Self {
            start,
            end: Some(end),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct FragmentEdges {
    pub(super) block_start: bool,
    pub(super) block_end: bool,
}

/// Physical placement and source ownership of one principal-box fragment.
/// This replaces parallel scalar arguments that were easy to transpose or
/// partially update when adding another fragmentation path.
#[derive(Clone, Copy)]
pub(super) struct BoxFragmentPlacement {
    pub(super) origin: Point,
    pub(super) size: Size,
    pub(super) source: SourceBlockRange,
    pub(super) edges: FragmentEdges,
}

impl BoxFragmentPlacement {
    pub(super) const fn whole(origin: Point, size: Size) -> Self {
        Self {
            origin,
            size,
            source: SourceBlockRange {
                start: 0.0,
                end: None,
            },
            edges: FragmentEdges {
                block_start: true,
                block_end: true,
            },
        }
    }

    pub(super) const fn is_whole(self) -> bool {
        self.edges.block_start && self.edges.block_end
    }

    pub(super) const fn physical(self) -> FragmentPlacement {
        FragmentPlacement::in_content_box(Vector::new(self.origin.x, self.origin.y), self.size)
    }
}

#[derive(Clone, Copy)]
enum OverflowColumns {
    Fixed,
    Extend,
}

/// Physical fragmentainer geometry for a multicol run.
#[derive(Clone, Copy)]
pub(super) struct ColumnFragmentation {
    column_count: usize,
    block_size: f32,
    overflow: OverflowColumns,
    balance_probe: bool,
}

impl ColumnFragmentation {
    pub(super) const fn fixed(column_count: usize, block_size: f32) -> Self {
        Self {
            column_count,
            block_size,
            overflow: OverflowColumns::Fixed,
            balance_probe: false,
        }
    }

    pub(super) const fn overflowing(column_count: usize, block_size: f32) -> Self {
        Self {
            column_count,
            block_size,
            overflow: OverflowColumns::Extend,
            balance_probe: false,
        }
    }

    pub(super) const fn balance_probe(column_count: usize, block_size: f32) -> Self {
        Self {
            column_count,
            block_size,
            overflow: OverflowColumns::Extend,
            balance_probe: true,
        }
    }

    const fn allows_overflow(self) -> bool {
        matches!(self.overflow, OverflowColumns::Extend)
    }
}

/// Fragments and used block sizes for one multicol run.
pub(super) struct FragmentedColumns {
    pub(super) columns: Vec<Vec<ColumnFragment>>,
    pub(super) used_block_sizes: Vec<f32>,
}

impl FragmentedColumns {
    fn content_column_count(&self) -> usize {
        self.columns
            .iter()
            .rposition(|column| !column.is_empty())
            .map_or(0, |index| index + 1)
    }
}

/// Find the shortest fragmentainer that holds a sliceable run in the requested
/// number of balanced columns, then materialize those fragments.
///
/// Feasibility is not monotonic in the candidate block size: making a column
/// slightly taller can admit another whole block and temporarily produce more
/// overflow. Grow from the lower bound to the exact used overflow boundary
/// reported by sequential placement instead of applying a binary search to a
/// non-monotonic predicate.
pub(super) fn balance_fragmented_columns(
    items: &[MultiColItem],
    indices: &[usize],
    column_count: usize,
) -> FragmentedColumns {
    if indices.is_empty() || column_count <= 1 {
        let block_size = indices
            .iter()
            .map(|&index| items[index].fragmentation_height)
            .sum();
        return fragment_columns(
            items,
            indices,
            ColumnFragmentation::fixed(column_count.max(1), block_size),
        );
    }

    // A run made entirely of unconstrained `break-inside: avoid` boxes has no
    // legal internal break to discover. CSS Multicol establishes the shortest
    // column block-size first, then fills those columns sequentially; solve
    // that atomic partition exactly instead of feeding it through the
    // descendant-fragment probe. Besides doing needless work, the probe's
    // overflowing columns do not expose the next atomic packing threshold, so
    // using their current used size can skip directly to the one-column upper
    // bound.
    if let Some(block_size) = atomic_balanced_block_size(items, indices, column_count) {
        return fragment_columns(
            items,
            indices,
            ColumnFragmentation::fixed(column_count, block_size),
        );
    }

    // Positive trailing margins may be discarded at a fragmentation break, so
    // only border-box content is a sound lower bound for the balanced height.
    let content_size: f32 = indices
        .iter()
        .map(|&index| {
            (items[index].fragmentation_height - items[index].margin_bottom.max(0.0)).max(0.0)
        })
        .sum();
    let minimum_fragment_size = indices
        .iter()
        .map(|&index| item_minimum_fragment_size(&items[index]))
        .fold(0.0f32, f32::max);
    let total_size: f32 = indices
        .iter()
        .map(|&index| items[index].fragmentation_height.max(0.0))
        .sum();
    if content_size <= 0.0 || !content_size.is_finite() || !total_size.is_finite() {
        return fragment_columns(
            items,
            indices,
            ColumnFragmentation::fixed(column_count, total_size.max(0.0)),
        );
    }

    let lower = (content_size / column_count as f32).max(minimum_fragment_size);
    let upper = total_size.max(lower);
    let mut block_size = lower;
    loop {
        let probe = fragment_columns(
            items,
            indices,
            ColumnFragmentation::balance_probe(column_count, block_size),
        );
        let used = probe
            .used_block_sizes
            .iter()
            .copied()
            .fold(0.0f32, f32::max);
        if probe.content_column_count() <= column_count && used <= block_size {
            break;
        }
        if block_size >= upper {
            // Forced breaks can require overflow columns at every block size.
            return fragment_columns(
                items,
                indices,
                ColumnFragmentation::overflowing(column_count, upper),
            );
        }
        block_size = if used > block_size {
            used.min(upper)
        } else {
            upper
        };
    }

    fragment_columns(
        items,
        indices,
        ColumnFragmentation::fixed(column_count, block_size),
    )
}

/// Resolve the shortest height for a run whose boxes must remain whole.
///
/// Sibling break controls need the full fragmentation solver, so this exact
/// atomic path is used only when `break-inside` is the run's sole constraint.
fn atomic_balanced_block_size(
    items: &[MultiColItem],
    indices: &[usize],
    column_count: usize,
) -> Option<f32> {
    let is_unconstrained_atomic_item = |item: &MultiColItem| {
        item.break_inside_avoid_column
            && !item.break_before_column
            && !item.break_after_column
            && !item.break_before_avoid_column
            && !item.break_after_avoid_column
    };
    if !indices
        .iter()
        .all(|&index| is_unconstrained_atomic_item(&items[index]))
    {
        return None;
    }

    let heights = indices
        .iter()
        .map(|&index| items[index].fragmentation_height.max(0.0))
        .collect::<Vec<_>>();
    let buckets = balance_columns(&heights, column_count);
    Some(
        buckets
            .iter()
            .map(|bucket| bucket.iter().map(|&position| heights[position]).sum())
            .fold(0.0f32, f32::max),
    )
}

/// Distribute items across a semantic column geometry, *fragmenting* a
/// block that crosses a column boundary (css-break-3 + css-multicol-1): the part
/// that fits stays at the bottom of column N, the remainder continues at the top
/// of column N+1. Each column is filled to its block size before the next starts.
///
/// A definite principal box fragments within its hard used extent; visible
/// descendant overflow stays associated with the final fragment. Auto and
/// minimum-sized boxes resolve against their natural descendant extent. The
/// trailing margin follows the principal box and is *truncated* if it would
/// cross the column bottom. Splitting follows `box-decoration-break: slice`:
/// the top slice keeps the top border, the bottom slice keeps the bottom border,
/// and cut edges keep neither.
///
pub(super) fn fragment_columns(
    items: &[MultiColItem],
    indices: &[usize],
    geometry: ColumnFragmentation,
) -> FragmentedColumns {
    let initial_cols = geometry.column_count.max(1);
    let mut cols: Vec<Vec<ColumnFragment>> = (0..initial_cols).map(|_| Vec::new()).collect();
    let mut used: Vec<f32> = vec![0.0; initial_cols];
    if geometry.column_count == 0 || geometry.block_size <= 0.0 {
        // Degenerate: pile everything into column 0 unfragmented.
        let mut y = 0.0f32;
        for &idx in indices {
            let h = (items[idx].fragmentation_height - items[idx].margin_bottom).max(0.0);
            cols[0].push(ColumnFragment {
                item: idx,
                y,
                height: h,
                source_top: 0.0,
                is_first: true,
                is_last: true,
            });
            y += items[idx].fragmentation_height;
        }
        used[0] = y;
        return FragmentedColumns {
            columns: cols,
            used_block_sizes: used,
        };
    }

    let mut col = 0usize;
    let mut y = 0.0f32; // border-box fill cursor within the current column
    let mut placed_in_current_col: Vec<usize> = Vec::new();

    let advance_column = |cols: &mut Vec<Vec<ColumnFragment>>,
                          used: &mut Vec<f32>,
                          col: &mut usize,
                          y: &mut f32,
                          placed_in_current_col: &mut Vec<usize>| {
        if *col + 1 < cols.len() {
            *col += 1;
        } else if geometry.allows_overflow() {
            cols.push(Vec::new());
            used.push(0.0);
            *col += 1;
        }
        *y = 0.0;
        placed_in_current_col.clear();
    };

    let mut groups = Vec::new();
    let mut group_start = 0usize;
    while group_start < indices.len() {
        let mut group_end = group_start + 1;
        while group_end < indices.len() {
            let prev = indices[group_end - 1];
            let next = indices[group_end];
            if items[prev].break_after_column || items[next].break_before_column {
                break;
            }
            if items[prev].break_after_avoid_column || items[next].break_before_avoid_column {
                group_end += 1;
            } else {
                break;
            }
        }
        groups.push(group_start..group_end);
        group_start = group_end;
    }

    for group in groups {
        let group_len = group.end - group.start;
        let group_height: f32 = group
            .clone()
            .map(|i| items[indices[i]].fragmentation_height)
            .sum();
        if group_len > 1
            && y > 0.0
            && exceeds_with_roundoff(y + group_height, geometry.block_size)
            && !exceeds_with_roundoff(group_height, geometry.block_size)
        {
            advance_column(
                &mut cols,
                &mut used,
                &mut col,
                &mut y,
                &mut placed_in_current_col,
            );
        }

        for group_pos in group {
            let idx = indices[group_pos];
            if items[idx].break_before_column && (y > 0.0 || !placed_in_current_col.is_empty()) {
                advance_column(
                    &mut cols,
                    &mut used,
                    &mut col,
                    &mut y,
                    &mut placed_in_current_col,
                );
            }

            place_fragmented_item(
                items,
                idx,
                &mut cols,
                &mut used,
                &mut col,
                &mut y,
                geometry,
                &mut placed_in_current_col,
            );

            if items[idx].break_after_column {
                advance_column(
                    &mut cols,
                    &mut used,
                    &mut col,
                    &mut y,
                    &mut placed_in_current_col,
                );
            }
        }
    }
    FragmentedColumns {
        columns: cols,
        used_block_sizes: used,
    }
}

#[allow(clippy::too_many_arguments)]
fn place_fragmented_item(
    items: &[MultiColItem],
    idx: usize,
    cols: &mut Vec<Vec<ColumnFragment>>,
    used: &mut Vec<f32>,
    col: &mut usize,
    y: &mut f32,
    geometry: ColumnFragmentation,
    placed_in_current_col: &mut Vec<usize>,
) {
    let advance_column = |cols: &mut Vec<Vec<ColumnFragment>>,
                          used: &mut Vec<f32>,
                          col: &mut usize,
                          y: &mut f32,
                          placed_in_current_col: &mut Vec<usize>| {
        if *col + 1 < cols.len() {
            *col += 1;
        } else if geometry.allows_overflow() {
            cols.push(Vec::new());
            used.push(0.0);
            *col += 1;
        }
        *y = 0.0;
        placed_in_current_col.clear();
    };

    let margin = items[idx].margin_bottom.max(0.0);
    let box_h = (items[idx].fragmentation_height - margin).max(0.0);
    let prefer_block_boundaries =
        geometry.balance_probe && !exceeds_with_roundoff(box_h, geometry.block_size);
    let balance_query = |query: FragmentBreakQuery| {
        if prefer_block_boundaries {
            query.block_boundaries_only()
        } else {
            query
        }
    };
    let space_before_break = geometry.block_size - *y;
    let minimum_fragment_size = item_minimum_fragment_size(&items[idx]);
    let normal_break_here = item_block_break(
        &items[idx],
        balance_query(FragmentBreakQuery::latest_before(
            0.0,
            space_before_break,
            FragmentBreakRule::Normal,
        )),
    );
    let normal_break_in_empty_column = item_block_break(
        &items[idx],
        balance_query(FragmentBreakQuery::latest_before(
            0.0,
            geometry.block_size,
            FragmentBreakRule::Normal,
        )),
    );
    let should_move_intact = *y > 0.0
        && exceeds_with_roundoff(*y + box_h, geometry.block_size)
        && ((items[idx].break_inside_avoid_column
            && !exceeds_with_roundoff(box_h, geometry.block_size))
            || (!geometry.balance_probe
                && normal_break_here.is_none()
                && (exceeds_with_roundoff(minimum_fragment_size, space_before_break)
                    || normal_break_in_empty_column.is_some())));
    if should_move_intact {
        advance_column(cols, used, col, y, placed_in_current_col);
    }
    let mut remaining = box_h;
    let mut source_top = 0.0;
    let mut first_slice = true;
    // Place the box, splitting across columns as needed.
    loop {
        let space = geometry.block_size - *y;
        // Start a new column when the current one is full and this is not the
        // last fixed column (or overflow columns are allowed).
        if !is_positive_with_roundoff(space)
            && (*col + 1 < cols.len() || geometry.allows_overflow())
        {
            advance_column(cols, used, col, y, placed_in_current_col);
            continue;
        }
        let space = geometry.block_size - *y;
        let fixed_last_col = !geometry.allows_overflow() && *col + 1 >= cols.len();
        let take = if fixed_last_col {
            remaining
        } else if exceeds_with_roundoff(remaining, space) {
            let limit = source_top + space.max(0.0);
            let normal_break = item_block_break(
                &items[idx],
                balance_query(FragmentBreakQuery::latest_before(
                    source_top,
                    limit,
                    FragmentBreakRule::Normal,
                )),
            );
            let normal_break_in_empty_column = item_block_break(
                &items[idx],
                balance_query(FragmentBreakQuery::latest_before(
                    source_top,
                    source_top + geometry.block_size,
                    FragmentBreakRule::Normal,
                )),
            );
            normal_break
                .or_else(|| {
                    if geometry.balance_probe {
                        return item_block_break(
                            &items[idx],
                            balance_query(FragmentBreakQuery::earliest_after(
                                source_top,
                                limit,
                                FragmentBreakRule::Normal,
                            )),
                        )
                        .or_else(|| {
                            item_block_break(
                                &items[idx],
                                balance_query(FragmentBreakQuery::earliest_after(
                                    source_top,
                                    limit,
                                    FragmentBreakRule::Emergency,
                                )),
                            )
                        });
                    }
                    if normal_break_in_empty_column.is_none() {
                        item_block_break(
                            &items[idx],
                            FragmentBreakQuery::latest_before(
                                source_top,
                                limit,
                                FragmentBreakRule::Emergency,
                            ),
                        )
                    } else {
                        None
                    }
                })
                .map(|break_offset| break_offset - source_top)
                .unwrap_or_else(|| {
                    if geometry.balance_probe
                        && !exceeds_with_roundoff(remaining, geometry.block_size)
                    {
                        remaining
                    } else {
                        remaining.min(space.max(0.0))
                    }
                })
        } else {
            // The shared comparison has already established that the whole
            // remainder fits modulo short-sequence arithmetic roundoff. Keep
            // it whole; taking the raw `min` here would manufacture a tiny
            // continuation fragment and advance the following content.
            remaining
        };
        let is_last_slice = equal_with_roundoff(remaining, take) || fixed_last_col;
        cols[*col].push(ColumnFragment {
            item: idx,
            y: *y,
            height: take,
            source_top,
            is_first: first_slice,
            is_last: is_last_slice,
        });
        *y += take;
        used[*col] = used[*col].max(*y);
        remaining -= take;
        source_top += take;
        first_slice = false;
        if !is_positive_with_roundoff(remaining) || fixed_last_col {
            break;
        }
        // Box continues in the next column.
        advance_column(cols, used, col, y, placed_in_current_col);
    }

    placed_in_current_col.push(idx);
    // Trailing margin follows the box: kept if it fits in the column, else
    // truncated at the fragmentation break (do not carry it to the next col).
    if margin > 0.0 {
        let fixed_last_col = !geometry.allows_overflow() && *col + 1 >= cols.len();
        if !exceeds_with_roundoff(*y + margin, geometry.block_size) || fixed_last_col {
            *y += margin;
            used[*col] = used[*col].max(*y);
        } else {
            // Margin adjoins the column break → truncated; next item starts a
            // fresh column at the top.
            advance_column(cols, used, col, y, placed_in_current_col);
        }
    }
}

fn item_block_break(item: &MultiColItem, query: FragmentBreakQuery) -> Option<f32> {
    let [element] = item.elements.as_slice() else {
        return None;
    };
    element
        .block_fragmentation_source()?
        .find_block_break(query)
}

/// Smallest block-size at which the item's next unbreakable visual unit fits.
/// Text breaks between lines, while an unsupported descendant layout remains
/// atomic. A break-inside avoidance request keeps the whole item together.
pub(super) fn item_minimum_fragment_size(item: &MultiColItem) -> f32 {
    if item.break_inside_avoid_column {
        return (item.fragmentation_height - item.margin_bottom.max(0.0)).max(0.0);
    }

    struct MinimumFragmentSize(f32);

    impl LayoutVisitor for MinimumFragmentSize {
        fn visit_text_block(&mut self, element: &TextBlock) {
            let line_size = element
                .lines
                .iter()
                .map(|line| line.height)
                .fold(0.0f32, f32::max);
            self.0 = element.box_model.border.top.width + element.box_model.padding.top + line_size;
        }

        fn visit_container(&mut self, element: &Container) {
            let child_size = element
                .children
                .iter()
                .map(|child| minimum_fragment_size(child.as_ref()))
                .fold(0.0f32, f32::max);
            self.0 =
                element.box_model.border.top.width + element.box_model.padding.top + child_size;
        }
    }

    fn minimum_fragment_size(element: &dyn LayoutElement) -> f32 {
        let mut minimum =
            MinimumFragmentSize(crate::layout::paginate::estimate_element_height(element).max(0.0));
        element.accept(&mut minimum);
        minimum.0
    }

    let [element] = item.elements.as_slice() else {
        return item.fragmentation_height.max(0.0);
    };
    minimum_fragment_size(element.as_ref())
}
