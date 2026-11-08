//! Grid-specific propagation of forced item breaks to row boundaries.

use super::{GridItemStyle, Placed};
use crate::layout::elements::{IntoLayoutNode, LayoutNode, PageBreak};
use crate::layout::engine::PageBreakSide;

/// Forced page breaks propagated from grid items to their owning grid row.
///
/// CSS Grid requires item breaks to participate at the row boundary rather
/// than becoming inert inside a cell's paint-only content. Keeping the two
/// sides together also makes precedence at a row boundary explicit.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct GridRowBreaks {
    before: Option<PageBreakSide>,
    after: Option<PageBreakSide>,
}

impl GridRowBreaks {
    pub(super) fn push_before(self, output: &mut Vec<LayoutNode>) {
        if let Some(side) = self.before {
            output.push(page_break(side));
        }
    }

    pub(super) fn push_after(self, output: &mut Vec<LayoutNode>) {
        if let Some(side) = self.after {
            output.push(page_break(side));
        }
    }
}

pub(super) fn forced_row_breaks(
    row: usize,
    placed: &[Placed],
    child_styles: &[GridItemStyle],
) -> GridRowBreaks {
    let mut breaks = GridRowBreaks::default();
    for item in placed.iter().filter(|item| item.row == row) {
        let style = &child_styles[item.idx];
        if style.break_before.forces_break() {
            breaks.before = Some(style.break_before.into());
        }
        if style.break_after.forces_break() {
            breaks.after = Some(style.break_after.into());
        }
    }
    breaks
}

fn page_break(side: PageBreakSide) -> LayoutNode {
    PageBreak {
        side,
        page_name: None,
    }
    .boxed()
}
