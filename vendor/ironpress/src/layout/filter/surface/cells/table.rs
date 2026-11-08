//! Table-row sources for grouped CSS filters.

use crate::layout::cells::TableRowCells;
use crate::layout::elements::TableRow;
use crate::types::{Size, Vector};

use super::super::painter::{RootEffectHandling, SourcePainter};
use super::super::text::table_row_baseline_shifts;
use super::CellSourceFrame;

/// Resolve every originating table cell against the row's canonical tracks.
pub(crate) fn table_cell_source_frames(row: &TableRow) -> Vec<Option<CellSourceFrame>> {
    let height = row.content.cells.row_block_extent();
    row.cell_inline_frames()
        .into_iter()
        .map(|frame| {
            frame.map(|frame| {
                CellSourceFrame::new(
                    Size::new(frame.extent(), height),
                    Vector::new(frame.offset(), 0.0),
                )
            })
        })
        .collect()
}

impl SourcePainter<'_> {
    pub(in crate::layout::filter::surface) fn paint_table_row(
        &mut self,
        row: &TableRow,
    ) -> Option<()> {
        if row.formatting.is_collapsed() || row.content.cells.iter().any(|cell| cell.span.rows > 1)
        {
            return None;
        }
        let frames = table_cell_source_frames(row);
        let baseline_shifts = table_row_baseline_shifts(&row.content.cells, self.fonts);
        for (index, cell) in row.content.cells.iter().enumerate() {
            let Some(frame) = frames.get(index).copied().flatten() else {
                continue;
            };
            self.paint_cell_box(
                &cell.layout,
                frame.border_box_in(self.space.border_box.origin),
                cell.table.clips,
                cell.table.hide_if_empty,
                baseline_shifts.get(index).copied().unwrap_or_default(),
                RootEffectHandling::Paint,
            )?;
        }
        Some(())
    }
}
