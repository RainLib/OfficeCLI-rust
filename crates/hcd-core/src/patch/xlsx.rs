//! Spreadsheet patch plans and format-specific validation.
use super::*;
mod cells;
mod grid;
mod sheets;
pub(super) use cells::*;
pub(super) use grid::*;
pub(super) use sheets::*;

#[derive(Clone)]
pub(super) struct XlsxMerge {
    pub(super) sheet_id: String,
    pub(super) start_row: u32,
    pub(super) start_column: u32,
    pub(super) end_row: u32,
    pub(super) end_column: u32,
    pub(super) node_hash: String,
}

#[derive(Clone)]
pub(super) struct XlsxCellInsertion {
    pub(super) sheet_id: String,
    pub(super) row: u32,
    pub(super) column: u32,
    pub(super) text: String,
    pub(super) formula: bool,
    pub(super) runs: Option<Vec<crate::XlsxInlineRun>>,
}

#[derive(Clone)]
pub(super) struct XlsxFormulaChange {
    pub(super) sheet_id: String,
    pub(super) replacement: XlsxFormulaReplacement,
    pub(super) node_hash: String,
}

#[derive(Clone)]
pub(super) enum XlsxFormulaReplacement {
    Formula(String),
    Value(String),
    Number(String),
    NumberUpdate(String),
}

#[derive(Clone)]
pub(super) struct XlsxRowAppend {
    pub(super) sheet_id: String,
    pub(super) after_row: u32,
}

#[derive(Clone)]
pub(super) struct XlsxRowInsert {
    pub(super) sheet_id: String,
    pub(super) before_row: u32,
    pub(super) count: u32,
}

#[derive(Clone)]
pub(super) struct XlsxRowDelete {
    pub(super) sheet_id: String,
    pub(super) row: u32,
    pub(super) count: u32,
}

#[derive(Clone)]
pub(super) struct XlsxColumnInsert {
    pub(super) sheet_id: String,
    pub(super) before_column: u32,
    pub(super) count: u32,
}

#[derive(Clone)]
pub(super) struct XlsxColumnDelete {
    pub(super) sheet_id: String,
    pub(super) column: u32,
    pub(super) count: u32,
}

#[derive(Clone)]
pub(super) struct XlsxRowRemoval {
    pub(super) sheet_id: String,
    pub(super) row: u32,
}

#[derive(Clone)]
pub(super) struct XlsxColumnWidth {
    pub(super) sheet_id: String,
    pub(super) column: u32,
    pub(super) width_chars: f64,
}

#[derive(Clone)]
pub(super) struct XlsxRowHeight {
    pub(super) sheet_id: String,
    pub(super) row: u32,
    pub(super) height_points: f64,
}

/// Pane split a patch asks one worksheet's windows to freeze: the count of rows
/// and columns that stay put while the rest of the sheet scrolls. `0`/`0` is not
/// a split at all but a request to release the one the worksheet carries.
#[derive(Clone)]
pub(super) struct XlsxSheetFreeze {
    pub(super) sheet_id: String,
    pub(super) rows: u32,
    pub(super) columns: u32,
}

/// One row or column a grid shift moved, seen from the frozen band of the
/// worksheet it belongs to: where the move lands decides whether the band grows
/// with it, narrows, or keeps the count it already named.
#[derive(Clone, Copy)]
pub(super) enum XlsxPaneBandShift {
    InsertRow(u32),
    DeleteRow(u32),
    InsertColumn(u32),
    DeleteColumn(u32),
}

/// The frozen band a grid shift moves through, and how many rows or columns that
/// shift asks for, so a band can be widened once per inserted row.
#[derive(Clone)]
pub(super) struct XlsxPaneBandMove {
    pub(super) sheet_id: String,
    pub(super) shift: XlsxPaneBandShift,
    pub(super) count: u32,
}

/// Worksheet a patch creates. HCD owns the tab's grid identity, the worksheet
/// part name the package will carry, and the tab position after every worksheet
/// the bundle already knows.
#[derive(Clone)]
pub(super) struct XlsxSheetAddTarget {
    pub(super) name: String,
    pub(super) sheet_id: String,
    pub(super) sheet_part: String,
    pub(super) sheet_index: usize,
}

#[derive(Clone)]
pub(super) struct XlsxSheetRenameTarget {
    pub(super) sheet_id: String,
    pub(super) old_name: String,
    pub(super) new_name: String,
    pub(super) sheet_part: String,
}

/// Worksheet a patch deletes: the tab the bundle already knows, its grid identity,
/// its place in the tab list, and the worksheet part the package will lose. HCD
/// drops every chunk that carried cells for this tab, so the index shrinks instead
/// of growing, and every tab behind the hole moves up one place because the place
/// a chunk records is how it reaches its worksheet part in the source workbook.
#[derive(Clone)]
pub(super) struct XlsxSheetRemovalTarget {
    pub(super) sheet_id: String,
    pub(super) name: String,
    pub(super) sheet_part: String,
    pub(super) sheet_index: usize,
}

#[derive(Clone)]
pub(super) struct XlsxFormatChange {
    pub(super) format: XlsxCellFormatPatch,
    pub(super) node_hash: String,
}

#[derive(Clone)]
pub(super) struct XlsxLayoutChange {
    pub(super) layout: XlsxCellLayoutPatch,
    pub(super) node_hash: String,
}

#[derive(Clone)]
pub(super) struct XlsxNumberFormatChange {
    pub(super) number_format: XlsxCellNumberFormatPatch,
    pub(super) node_hash: String,
}

/// The last row and the last column a frozen band can name: a pane has to leave a
/// scrolling corner, so one of each stays outside it.
pub(super) const XLSX_FROZEN_ROW_LIMIT: u32 = 1_048_575;
pub(super) const XLSX_FROZEN_COLUMN_LIMIT: u32 = 16_383;

#[derive(Clone, Copy)]
pub(super) enum XlsxVisualShift {
    InsertRow(u32),
    InsertColumn(u32),
    DeleteRow(u32),
    DeleteColumn(u32),
}

#[derive(Clone)]
pub(super) struct XlsxCellSpan {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) tag_end: usize,
    pub(super) row: u32,
    pub(super) column: u32,
    pub(super) has_node: bool,
    pub(super) merged_range: Option<(u32, u32, u32, u32)>,
}

#[derive(Clone, Copy)]
pub(super) enum XlsxMergeShift {
    InsertRow(u32),
    DeleteRow(u32),
    InsertColumn(u32),
    DeleteColumn(u32),
}

pub(super) fn validate_xlsx_schema(
    manifest: &crate::HcdManifest,
    patch: &PatchBatch,
) -> Result<(), HcdError> {
    if patch.schema_version == HCD_PATCH_SCHEMA_VERSION_19
        && (manifest.source.format != "xlsx"
            || !patch
                .operations
                .iter()
                .any(|operation| matches!(operation, PatchOperation::XlsxCellSet { .. }))
            || patch.operations.iter().any(|operation| {
                !matches!(
                    operation,
                    PatchOperation::XlsxCellSet { .. } | PatchOperation::TextSplice { .. }
                )
            }))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/19 accepts XLSX cell insertions and text splices only".to_string(),
        ));
    }
    if patch.schema_version == HCD_PATCH_SCHEMA_VERSION_20
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxFormulaSet { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/20 accepts one XLSX formula replacement only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_21
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxFormulaCreate { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/21 accepts one XLSX formula creation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_22 {
        if manifest.source.format != "xlsx"
            || !patch.operations.iter().any(|operation| {
                matches!(
                    operation,
                    PatchOperation::XlsxFormulaSet { .. }
                        | PatchOperation::XlsxFormulaCreate { .. }
                )
            })
            || patch.operations.iter().any(|operation| {
                !matches!(
                    operation,
                    PatchOperation::TextSplice { .. }
                        | PatchOperation::XlsxCellSet { .. }
                        | PatchOperation::XlsxFormulaSet { .. }
                        | PatchOperation::XlsxFormulaCreate { .. }
                )
            })
        {
            return Err(HcdError::Unsupported(
                "hcd-patch/22 accepts XLSX text, blank-cell, and formula changes only".to_string(),
            ));
        }
        let mut targets = HashSet::new();
        for operation in &patch.operations {
            if let Some(node_id) = operation.node_id() {
                if !targets.insert(node_id) {
                    return Err(HcdError::InvalidPatch(
                        "XLSX batch contains duplicate node targets".to_string(),
                    ));
                }
            }
        }
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_28
        || patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_29
    {
        if manifest.source.format != "xlsx"
            || !patch
                .operations
                .iter()
                .any(|operation| match patch.schema_version.as_str() {
                    crate::HCD_PATCH_SCHEMA_VERSION_28 => {
                        matches!(operation, PatchOperation::XlsxFormulaToValue { .. })
                    }
                    _ => matches!(
                        operation,
                        PatchOperation::XlsxFormulaToNumber { .. }
                            | PatchOperation::XlsxNumberSet { .. }
                    ),
                })
            || patch.operations.iter().any(|operation| {
                !matches!(
                    operation,
                    PatchOperation::TextSplice { .. }
                        | PatchOperation::XlsxCellSet { .. }
                        | PatchOperation::XlsxFormulaSet { .. }
                        | PatchOperation::XlsxFormulaCreate { .. }
                        | PatchOperation::XlsxFormulaToValue { .. }
                        | PatchOperation::XlsxFormulaToNumber { .. }
                        | PatchOperation::XlsxNumberSet { .. }
                )
            })
        {
            return Err(HcdError::Unsupported(
                "XLSX formula conversion batches accept formula conversion and cell edits only"
                    .to_string(),
            ));
        }
        let mut targets = HashSet::new();
        for operation in &patch.operations {
            if let Some(node_id) = operation.node_id() {
                if !targets.insert(node_id) {
                    return Err(HcdError::InvalidPatch(
                        "XLSX batch contains duplicate node targets".to_string(),
                    ));
                }
            }
        }
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_25
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxGridRange { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/25 accepts one XLSX grid range operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_26
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxMergeBlank { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/26 accepts one XLSX blank merge only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_50 {
        if manifest.source.format != "xlsx"
            || patch.operations.iter().any(|op| {
                !matches!(
                    op,
                    PatchOperation::TextSplice { .. }
                        | PatchOperation::XlsxCellSet { .. }
                        | PatchOperation::XlsxRichTextSet { .. }
                        | PatchOperation::XlsxRichTextCreate { .. }
                        | PatchOperation::XlsxFormulaSet { .. }
                        | PatchOperation::XlsxFormulaCreate { .. }
                        | PatchOperation::XlsxFormulaToValue { .. }
                        | PatchOperation::XlsxFormulaToNumber { .. }
                        | PatchOperation::XlsxNumberSet { .. }
                )
            })
        {
            return Err(HcdError::Unsupported(
                "hcd-patch/50 accepts XLSX cell content changes only".into(),
            ));
        }
        let mut targets = HashSet::new();
        for op in &patch.operations {
            if let Some(node) = op.node_id() {
                if !targets.insert(node) {
                    return Err(HcdError::InvalidPatch(
                        "XLSX content batch contains duplicate targets".into(),
                    ));
                }
            }
        }
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_49 {
        if manifest.source.format != "xlsx"
            || patch.operations.iter().any(|op| {
                !matches!(
                    op,
                    PatchOperation::XlsxRichTextSet { .. } | PatchOperation::TextSplice { .. }
                )
            })
        {
            return Err(HcdError::Unsupported(
                "hcd-patch/49 accepts XLSX rich-text updates only".into(),
            ));
        }
        let mut targets = HashSet::new();
        for op in &patch.operations {
            if !targets.insert(op.node_id()) {
                return Err(HcdError::InvalidPatch(
                    "XLSX rich-text batch contains duplicate targets".into(),
                ));
            }
        }
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_31
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxCellFormat { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/31 accepts one XLSX cell format operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_32
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxCellLayout { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/32 accepts one XLSX cell layout operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_33
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxCellNumberFormat { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/33 accepts one XLSX cell number format operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_34
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxSheetRename { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/34 accepts one XLSX worksheet rename operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_35
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxSheetAdd { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/35 accepts one XLSX worksheet addition operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_36
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxSheetDelete { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/36 accepts one XLSX worksheet deletion operation only".to_string(),
        ));
    }
    if patch.schema_version == crate::HCD_PATCH_SCHEMA_VERSION_45
        && (manifest.source.format != "xlsx"
            || patch.operations.len() != 1
            || !matches!(
                patch.operations.first(),
                Some(PatchOperation::XlsxSheetFreeze { .. })
            ))
    {
        return Err(HcdError::Unsupported(
            "hcd-patch/45 accepts one XLSX worksheet freeze operation only".to_string(),
        ));
    }
    Ok(())
}
