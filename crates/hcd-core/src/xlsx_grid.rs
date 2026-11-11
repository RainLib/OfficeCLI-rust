//! Shapes an XLSX worksheet window shares between the importer and a patch.
//!
//! The importer turns a worksheet part into one `<section class="hcd-sheet">`
//! window per row range, and a patch that creates a worksheet has to add a
//! window that is indistinguishable from an imported one: the same window
//! identity, the same chunk identity, and the same attribute order the grid
//! viewer parses. Keeping these here means re-importing a workbook the patch
//! exported recovers the very same `sheetId` and `chunkId` instead of minting
//! a second identity for the same worksheet.

use crate::hash::stable_node_id;
use crate::html::escape_attribute;

/// Grid identity of one worksheet part.
pub fn sheet_grid_id(document_id: &str, sheet_part: &str) -> String {
    stable_node_id(&[document_id, sheet_part, "worksheet"]).replacen("n_", "s_", 1)
}

/// Chunk identity of one window inside a worksheet.
pub fn sheet_window_chunk_id(document_id: &str, sheet_part: &str, ordinal: usize) -> String {
    stable_node_id(&[
        document_id,
        sheet_part,
        "sheet-window",
        &ordinal.to_string(),
    ])
    .replacen("n_", "c_", 1)
}

/// One worksheet window: where it sits in the workbook, the row range it
/// covers, and the markup pieces the importer collected for it.
pub struct XlsxSheetSection<'a> {
    pub sheet_name: &'a str,
    pub sheet_index: usize,
    pub sheet_state: &'a str,
    /// First row of the window. A worksheet with no rows at all has none.
    pub row_start: Option<u64>,
    pub row_end: Option<u64>,
    /// `sheetFormatPr` defaults in the units the window markup spells them in.
    pub default_column_width: Option<f64>,
    pub default_row_height_points: Option<f64>,
    /// Frozen-pane and zoom attributes, written straight after the defaults.
    pub view_attributes: &'a str,
    /// `<col>` elements the worksheet declares.
    pub column_markup: &'a str,
}

impl XlsxSheetSection<'_> {
    /// Window section holding `body`, the rows already rendered as `<tr>`
    /// elements. An empty worksheet passes an empty body.
    pub fn html(&self, body: &str) -> String {
        let rows = match (self.row_start, self.row_end) {
            (Some(start), Some(end)) => {
                format!(" data-hcd-row-start=\"{start}\" data-hcd-row-end=\"{end}\"")
            }
            _ => String::new(),
        };
        let default_width = self
            .default_column_width
            .map(|width| format!(" data-hcd-default-column-width=\"{width:.2}\""))
            .unwrap_or_default();
        let default_height = self
            .default_row_height_points
            .map(|height| format!(" data-hcd-default-row-height-points=\"{height:.2}\""))
            .unwrap_or_default();
        format!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\"{}{}{}{}><table class=\"hcd-grid\"><colgroup>{}</colgroup><tbody>{}</tbody></table></section>",
            escape_attribute(self.sheet_name),
            self.sheet_index,
            self.sheet_state,
            rows,
            default_width,
            default_height,
            self.view_attributes,
            self.column_markup,
            body
        )
    }
}
