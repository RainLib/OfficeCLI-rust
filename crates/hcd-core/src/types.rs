use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDescriptor {
    pub format: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetDescriptor {
    pub source_part: String,
    pub hash: String,
    pub href: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HcdCapabilities {
    pub text_patch: bool,
    pub annotations: bool,
    pub structure_patch: bool,
    pub style_patch: bool,
    pub exact_pagination: bool,
}

impl Default for HcdCapabilities {
    fn default() -> Self {
        Self {
            text_patch: true,
            annotations: true,
            structure_patch: false,
            style_patch: false,
            exact_pagination: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HcdManifest {
    pub schema_version: String,
    #[serde(default)]
    pub storage_codec: StorageCodec,
    pub document_id: String,
    pub profile: String,
    pub revision: u64,
    pub source: SourceDescriptor,
    pub root_hash: String,
    pub annotation_root_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_href: Option<String>,
    pub index_prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_root_href: Option<String>,
    pub index_page_count: usize,
    pub chunk_count: usize,
    pub styles_href: String,
    pub capabilities: HcdCapabilities,
    /// Import-time fidelity contract for the canonical HTML representation.
    /// A source-backed export can still preserve opaque package parts exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fidelity: Option<FidelityReport>,
    pub state: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<FidelityWarning>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageCodec {
    #[default]
    None,
    Gzip,
}

impl StorageCodec {
    pub fn suffix(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Gzip => ".gz",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridChunkAddress {
    /// Stable HCD identity for a worksheet. It is derived from documentId and
    /// the OOXML worksheet part, rather than from the display name.
    pub sheet_id: String,
    pub sheet_name: String,
    pub sheet_index: usize,
    pub sheet_state: String,
    pub kind: GridChunkKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_end: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_end: Option<u32>,
    /// Worksheet default grid dimensions in EMU. Cell-window descriptors
    /// carry these values so a virtualized canvas can establish the same
    /// coordinate system before it downloads drawing chunks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_column_width_emu: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_row_height_emu: Option<u32>,
    /// OOXML worksheet part backing this sheet. Cell-window descriptors carry
    /// it so a sheet-scoped edit can still find its source part when the
    /// worksheet has no mapped cells at all, which is the case for an empty
    /// worksheet and for a worksheet a patch just created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_part: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GridChunkKind {
    Cells,
    Picture,
    Chart,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkDescriptor {
    pub sequence: usize,
    pub chunk_id: String,
    pub region: String,
    pub html_href: String,
    pub html_hash: String,
    pub map_href: String,
    pub map_hash: String,
    pub byte_length: u64,
    pub block_count: usize,
    pub node_count: usize,
    pub text_chars: usize,
    pub node_bloom: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_node_id: Option<String>,
    #[serde(default)]
    pub continuation: bool,
    /// Optional format-specific random-access address. Grid clients can select
    /// visible worksheet windows without downloading every HTML fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<GridChunkAddress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkIndexPage {
    pub schema_version: String,
    pub revision: u64,
    pub page: usize,
    pub chunks: Vec<ChunkDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceAnchor {
    pub part: String,
    pub text_ordinal: u64,
    /// Original OOXML cell address when a grid edit moves this node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cell_ref: Option<String>,
    /// True for a cell or slide text box materialized by an HCD patch.
    #[serde(default, skip_serializing_if = "is_false")]
    pub created_in_hcd: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_id: Option<String>,
    pub node_kind: String,
    #[serde(default)]
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMapEntry {
    pub node_id: String,
    pub node_hash: String,
    pub source: SourceAnchor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkSourceMap {
    pub schema_version: String,
    pub chunk_id: String,
    pub entries: Vec<NodeMapEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub annotation_id: String,
    pub node_id: String,
    pub start: usize,
    pub end: usize,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationSet {
    pub schema_version: String,
    pub annotations: Vec<Annotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchBatch {
    pub schema_version: String,
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    #[serde(default)]
    pub actor: BTreeMap<String, String>,
    pub operations: Vec<PatchOperation>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxShapeGeometry {
    pub x_emu: u64,
    pub y_emu: u64,
    pub width_emu: u64,
    pub height_emu: u64,
}

/// Direct DrawingML run formatting. Absent fields keep the run's current value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxRunFormat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Direct spreadsheet cell formatting. Absent fields keep the cell's current value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxCellFormatPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
}

/// Direct spreadsheet alignment and borders. Absent fields keep the cell's current value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxCellLayoutPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizontal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<String>,
}

/// Direct spreadsheet number format. The format code is an Excel format string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XlsxCellNumberFormatPatch {
    pub format_code: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfTextGeometry {
    pub x_pt: f32,
    pub y_pt: f32,
    pub width_pt: f32,
    pub height_pt: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfTextGeometryPrecondition {
    pub node_hash: String,
    pub geometry: PdfTextGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxShapePrecondition {
    pub node_hash: String,
    pub geometry: PptxShapeGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum PatchOperation {
    #[serde(rename = "text.splice", rename_all = "camelCase")]
    TextSplice {
        node_id: String,
        start: usize,
        delete_count: usize,
        insert_text: String,
        precondition: NodePrecondition,
    },
    /// Add a positioned editable text box to a raster-backed PDF page.
    /// The stable node ID is assigned from the patch ID and operation index.
    #[serde(rename = "pdf.text.insert", rename_all = "camelCase")]
    PdfTextInsert {
        page: usize,
        x_pt: f32,
        y_pt: f32,
        width_pt: f32,
        height_pt: f32,
        font_size_pt: f32,
        text: String,
    },
    /// Move or resize an HCD-created PDF text box on its original page.
    #[serde(rename = "pdf.text.geometry", rename_all = "camelCase")]
    PdfTextGeometry {
        node_id: String,
        geometry: PdfTextGeometry,
        precondition: PdfTextGeometryPrecondition,
    },
    /// Remove an HCD-created PDF text box from the current revision.
    #[serde(rename = "pdf.text.delete", rename_all = "camelCase")]
    PdfTextDelete {
        node_id: String,
        precondition: NodePrecondition,
    },
    /// Add an editable text shape at slide coordinates measured in EMU.
    #[serde(rename = "pptx.text.insert", rename_all = "camelCase")]
    PptxTextInsert {
        chunk_id: String,
        slide_part: String,
        x_emu: u64,
        y_emu: u64,
        width_emu: u64,
        height_emu: u64,
        font_size_pt: f32,
        text: String,
    },
    /// Move or resize one positioned slide text shape without changing its node ID.
    #[serde(rename = "pptx.shape.geometry", rename_all = "camelCase")]
    PptxShapeGeometry {
        node_id: String,
        geometry: PptxShapeGeometry,
        precondition: PptxShapePrecondition,
    },
    /// Remove one HCD-created slide text box from the current revision.
    #[serde(rename = "pptx.text.delete", rename_all = "camelCase")]
    PptxTextDelete {
        node_id: String,
        precondition: NodePrecondition,
    },
    /// Set direct bold, italic, underline, size, or color on one DrawingML run.
    #[serde(rename = "pptx.run.format", rename_all = "camelCase")]
    PptxRunFormat {
        node_id: String,
        format: PptxRunFormat,
        precondition: NodePrecondition,
    },
    /// Set direct font and solid fill formatting on one worksheet cell.
    #[serde(rename = "xlsx.cell.format", rename_all = "camelCase")]
    XlsxCellFormat {
        node_id: String,
        format: XlsxCellFormatPatch,
        precondition: NodePrecondition,
    },
    /// Set direct alignment, wrap, or borders on one worksheet cell.
    #[serde(rename = "xlsx.cell.layout", rename_all = "camelCase")]
    XlsxCellLayout {
        node_id: String,
        layout: XlsxCellLayoutPatch,
        precondition: NodePrecondition,
    },
    /// Set the Excel number format code on one worksheet cell.
    #[serde(rename = "xlsx.cell.numberFormat", rename_all = "camelCase")]
    XlsxCellNumberFormat {
        node_id: String,
        number_format: XlsxCellNumberFormatPatch,
        precondition: NodePrecondition,
    },
    /// Merge a rectangle of existing XLSX cells. Covered cells must be empty.
    /// Coordinates are 1-based worksheet row and column numbers.
    #[serde(rename = "xlsx.merge", rename_all = "camelCase")]
    XlsxMerge {
        node_id: String,
        sheet_id: String,
        start_row: u32,
        start_column: u32,
        end_row: u32,
        end_column: u32,
        precondition: NodePrecondition,
    },
    /// Merge a rectangle whose anchor and covered cells are all empty.
    #[serde(rename = "xlsx.merge.blank", rename_all = "camelCase")]
    XlsxMergeBlank {
        sheet_id: String,
        start_row: u32,
        start_column: u32,
        end_row: u32,
        end_column: u32,
    },
    /// Split a merge while retaining its anchor cell and text.
    #[serde(rename = "xlsx.unmerge", rename_all = "camelCase")]
    XlsxUnmerge {
        node_id: String,
        sheet_id: String,
        start_row: u32,
        start_column: u32,
        end_row: u32,
        end_column: u32,
        precondition: NodePrecondition,
    },
    /// Materialize a previously empty cell inside an existing HCD row window.
    /// The server assigns its stable node ID from document, sheet, and address.
    #[serde(rename = "xlsx.cell.set", rename_all = "camelCase")]
    XlsxCellSet {
        sheet_id: String,
        row: u32,
        column: u32,
        text: String,
    },
    /// Set a native formula in an existing editable literal or ordinary formula cell.
    #[serde(rename = "xlsx.formula.set", rename_all = "camelCase")]
    XlsxFormulaSet {
        node_id: String,
        sheet_id: String,
        formula: String,
        precondition: NodePrecondition,
    },
    /// Replace an editable formula with a literal value (including an empty value).
    #[serde(rename = "xlsx.formula.to-value", rename_all = "camelCase")]
    XlsxFormulaToValue {
        node_id: String,
        sheet_id: String,
        text: String,
        precondition: NodePrecondition,
    },
    /// Replace an editable formula with a native finite numeric value.
    #[serde(rename = "xlsx.formula.to-number", rename_all = "camelCase")]
    XlsxFormulaToNumber {
        node_id: String,
        sheet_id: String,
        value: String,
        precondition: NodePrecondition,
    },
    /// Update an editable XLSX numeric cell while keeping its native numeric type.
    #[serde(rename = "xlsx.number.set", rename_all = "camelCase")]
    XlsxNumberSet {
        node_id: String,
        sheet_id: String,
        value: String,
        precondition: NodePrecondition,
    },
    /// Create a native formula in an empty worksheet cell.
    #[serde(rename = "xlsx.formula.create", rename_all = "camelCase")]
    XlsxFormulaCreate {
        sheet_id: String,
        row: u32,
        column: u32,
        formula: String,
    },
    /// Materialize the next empty worksheet row without shifting existing cells.
    #[serde(rename = "xlsx.row.append", rename_all = "camelCase")]
    XlsxRowAppend { sheet_id: String, after_row: u32 },
    /// Insert a blank row before an existing row, shifting later rows down.
    #[serde(rename = "xlsx.row.insert", rename_all = "camelCase")]
    XlsxRowInsert { sheet_id: String, before_row: u32 },
    /// Delete an existing worksheet row and shift later rows up.
    #[serde(rename = "xlsx.row.delete", rename_all = "camelCase")]
    XlsxRowDelete { sheet_id: String, row: u32 },
    /// Insert a blank column before an existing column, shifting later cells right.
    #[serde(rename = "xlsx.column.insert", rename_all = "camelCase")]
    XlsxColumnInsert {
        sheet_id: String,
        before_column: u32,
    },
    /// Delete a worksheet column and shift later cells left.
    #[serde(rename = "xlsx.column.delete", rename_all = "camelCase")]
    XlsxColumnDelete { sheet_id: String, column: u32 },
    /// Apply a bounded selection of adjacent row/column shifts in one revision.
    #[serde(rename = "xlsx.grid.range", rename_all = "camelCase")]
    XlsxGridRange {
        sheet_id: String,
        axis: XlsxGridAxis,
        action: XlsxGridAction,
        start: u32,
        count: u32,
    },
    /// Remove an empty row appended after the source worksheet's final row.
    #[serde(rename = "xlsx.row.remove-last", rename_all = "camelCase")]
    XlsxRowRemoveLast { sheet_id: String, row: u32 },
    /// Set a worksheet column's visible width without moving cells.
    #[serde(rename = "xlsx.column.width", rename_all = "camelCase")]
    XlsxColumnWidth {
        sheet_id: String,
        column: u32,
        width_chars: f64,
    },
    /// Set one materialized worksheet row's height in points.
    #[serde(rename = "xlsx.row.height", rename_all = "camelCase")]
    XlsxRowHeight {
        sheet_id: String,
        row: u32,
        height_points: f64,
    },
    /// Rename a worksheet tab. Cell coordinates, values, and styles are
    /// untouched; formulas that reference the sheet follow the new name.
    #[serde(rename = "xlsx.sheet.rename", rename_all = "camelCase")]
    XlsxSheetRename { sheet_id: String, name: String },
    /// Add a worksheet tab after the last one. HCD mints the tab's grid
    /// identity, its worksheet part name, and one empty window for it, so the
    /// tab is editable straight away.
    #[serde(rename = "xlsx.sheet.add", rename_all = "camelCase")]
    XlsxSheetAdd { name: String },
    /// Delete a worksheet tab. Every chunk of that worksheet leaves the index,
    /// and a formula that named the tab breaks the way Excel breaks it: the
    /// reference collapses to `#REF!`. A workbook is never left without a
    /// visible worksheet.
    #[serde(rename = "xlsx.sheet.delete", rename_all = "camelCase")]
    XlsxSheetDelete { sheet_id: String },
    /// Append one blank slide after the last one. HCD mints the slide part the
    /// page will need in the package and one empty page chunk carrying it, so
    /// the new slide is there to type into with the normal text box right away.
    #[serde(rename = "pptx.slide.add", rename_all = "camelCase")]
    PptxSlideAdd {},
    /// Drop one slide page, named by the chunk that holds it. The page and every
    /// text node it carries leave the document, and a source-backed export loses
    /// the slide part with them. A presentation cannot drop its last slide.
    #[serde(rename = "pptx.slide.delete", rename_all = "camelCase")]
    PptxSlideDelete { chunk_id: String },
    /// Presentation-layer styling for one canonical editable text node.
    /// This changes HCD HTML and its root hash. Source-backed exporters must
    /// either support the style or reject the export before writing output.
    #[serde(rename = "node.style", rename_all = "camelCase")]
    NodeStyle {
        node_id: String,
        style: NodeStylePatch,
        precondition: NodePrecondition,
    },
    /// Replace the content-addressed payload displayed by one mapped image
    /// node. The asset must already be indexed or have been staged with the
    /// CLI before the patch is applied.
    #[serde(rename = "image.replace", rename_all = "camelCase")]
    ImageReplace {
        node_id: String,
        asset_hash: String,
        precondition: VisualPrecondition,
    },
    /// Replace the complete image rectangle in its declared coordinate unit.
    #[serde(rename = "image.geometry", rename_all = "camelCase")]
    ImageGeometry {
        node_id: String,
        geometry: ImageGeometry,
        precondition: VisualPrecondition,
    },
    #[serde(rename = "annotation.upsert", rename_all = "camelCase")]
    AnnotationUpsert { annotation: Annotation },
    #[serde(rename = "annotation.remove", rename_all = "camelCase")]
    AnnotationRemove { annotation_id: String },
}

impl PatchOperation {
    pub fn node_id(&self) -> Option<&str> {
        match self {
            Self::TextSplice { node_id, .. }
            | Self::NodeStyle { node_id, .. }
            | Self::ImageReplace { node_id, .. }
            | Self::ImageGeometry { node_id, .. }
            | Self::PptxShapeGeometry { node_id, .. }
            | Self::PptxTextDelete { node_id, .. }
            | Self::PptxRunFormat { node_id, .. }
            | Self::XlsxCellFormat { node_id, .. }
            | Self::XlsxCellLayout { node_id, .. }
            | Self::XlsxCellNumberFormat { node_id, .. }
            | Self::PdfTextGeometry { node_id, .. }
            | Self::PdfTextDelete { node_id, .. }
            | Self::XlsxMerge { node_id, .. }
            | Self::XlsxUnmerge { node_id, .. } => Some(node_id),
            Self::XlsxFormulaSet { node_id, .. }
            | Self::XlsxFormulaToValue { node_id, .. }
            | Self::XlsxFormulaToNumber { node_id, .. } => Some(node_id),
            Self::XlsxNumberSet { node_id, .. } => Some(node_id),
            Self::AnnotationUpsert { annotation } => Some(&annotation.node_id),
            Self::AnnotationRemove { .. }
            | Self::PdfTextInsert { .. }
            | Self::PptxTextInsert { .. }
            | Self::XlsxCellSet { .. }
            | Self::XlsxFormulaCreate { .. }
            | Self::XlsxRowAppend { .. }
            | Self::XlsxRowInsert { .. }
            | Self::XlsxRowDelete { .. }
            | Self::XlsxColumnInsert { .. }
            | Self::XlsxColumnDelete { .. }
            | Self::XlsxGridRange { .. }
            | Self::XlsxMergeBlank { .. }
            | Self::XlsxRowRemoveLast { .. }
            | Self::XlsxColumnWidth { .. }
            | Self::XlsxRowHeight { .. }
            | Self::XlsxSheetRename { .. }
            | Self::XlsxSheetAdd { .. }
            | Self::XlsxSheetDelete { .. }
            | Self::PptxSlideAdd {}
            | Self::PptxSlideDelete { .. } => None,
        }
    }

    pub fn is_content_change(&self) -> bool {
        matches!(
            self,
            Self::TextSplice { .. }
                | Self::PdfTextInsert { .. }
                | Self::PptxTextInsert { .. }
                | Self::PptxShapeGeometry { .. }
                | Self::PptxTextDelete { .. }
                | Self::PptxRunFormat { .. }
                | Self::XlsxCellFormat { .. }
                | Self::XlsxCellLayout { .. }
                | Self::XlsxCellNumberFormat { .. }
                | Self::PdfTextGeometry { .. }
                | Self::PdfTextDelete { .. }
                | Self::XlsxMerge { .. }
                | Self::XlsxUnmerge { .. }
                | Self::XlsxCellSet { .. }
                | Self::XlsxFormulaSet { .. }
                | Self::XlsxFormulaToValue { .. }
                | Self::XlsxFormulaToNumber { .. }
                | Self::XlsxNumberSet { .. }
                | Self::XlsxFormulaCreate { .. }
                | Self::XlsxRowAppend { .. }
                | Self::XlsxRowInsert { .. }
                | Self::XlsxRowDelete { .. }
                | Self::XlsxColumnInsert { .. }
                | Self::XlsxColumnDelete { .. }
                | Self::XlsxGridRange { .. }
                | Self::XlsxMergeBlank { .. }
                | Self::XlsxRowRemoveLast { .. }
                | Self::XlsxColumnWidth { .. }
                | Self::XlsxRowHeight { .. }
                | Self::XlsxSheetRename { .. }
                | Self::XlsxSheetAdd { .. }
                | Self::XlsxSheetDelete { .. }
                | Self::PptxSlideAdd { .. }
                | Self::PptxSlideDelete { .. }
                | Self::NodeStyle { .. }
                | Self::ImageReplace { .. }
                | Self::ImageGeometry { .. }
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum XlsxGridAxis {
    Row,
    Column,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum XlsxGridAction {
    Insert,
    Delete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageGeometryUnit {
    Emu,
    Pt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub unit: ImageGeometryUnit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualPrecondition {
    pub visual_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeStylePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<NodeBorder>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeBorder {
    pub color: String,
    pub width_pt: f32,
    pub style: NodeBorderStyle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeBorderStyle {
    Solid,
    Dashed,
    Dotted,
    Double,
}

impl NodeBorderStyle {
    pub fn as_css(self) -> &'static str {
        match self {
            Self::Solid => "solid",
            Self::Dashed => "dashed",
            Self::Dotted => "dotted",
            Self::Double => "double",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePrecondition {
    pub node_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyResult {
    pub document_id: String,
    pub patch_id: String,
    pub base_revision: u64,
    pub revision: u64,
    pub root_hash: String,
    pub annotation_root_hash: String,
    pub dirty_node_ids: Vec<String>,
    pub dirty_chunk_ids: Vec<String>,
    pub dirty_source_parts: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<FidelityWarning>,
    #[serde(default)]
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionRecord {
    pub schema_version: String,
    pub document_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_base_revision: Option<u64>,
    /// Identity that created this revision. Older revision records omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    pub root_hash: String,
    pub annotation_root_hash: String,
    pub index_prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_root_href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_page_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<usize>,
    /// Immutable asset index used by this revision. Older bundles omit this
    /// field and resolve to the original `assets/index.json`.
    #[serde(default = "default_asset_index_href")]
    pub asset_index_href: String,
    pub created_at_epoch_ms: u128,
    #[serde(default)]
    pub dirty_node_ids: Vec<String>,
    /// Nodes removed by this revision; source-backed export drops their prior edits.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_node_ids: Vec<String>,
    #[serde(default)]
    pub dirty_chunk_ids: Vec<String>,
    #[serde(default)]
    pub dirty_source_parts: Vec<String>,
    /// XLSX worksheets changed structurally without changing a mapped text node.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dirty_grid_parts: Vec<String>,
    /// Formula cells converted to literal values in this revision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub converted_formula_node_ids: Vec<String>,
    /// Sequential row insertions, expressed in the worksheet coordinates at each revision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grid_row_insertions: Vec<GridRowInsertion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grid_row_deletions: Vec<GridRowDeletion>,
    /// Sequential column insertions in worksheet coordinates at each revision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grid_column_insertions: Vec<GridColumnInsertion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grid_column_deletions: Vec<GridColumnDeletion>,
    /// Sequential worksheet tab renames in worksheet-part coordinates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sheet_renames: Vec<SheetRename>,
    /// Worksheets this revision created. Their part is not in the source
    /// workbook, so a source-backed export has to add it rather than rewrite it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sheet_additions: Vec<SheetAddition>,
    /// Worksheets this revision deleted. A source-backed export drops the part
    /// they carried and rewrites whatever named them in the same pass.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sheet_removals: Vec<SheetRemoval>,
    /// Slides this revision created. Their part is not in the source package,
    /// so a source-backed export has to add it rather than rewrite it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slide_additions: Vec<SlideAddition>,
    /// Slides this revision dropped, named by the part their page pointed at.
    /// The export takes that part, its relationship, its entry in the slide list,
    /// and its content-type override out of the package.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slide_removals: Vec<SlideRemoval>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub structural_change: bool,
}

/// Slide removed at one revision. Only the part travels: the page, its text
/// nodes, and their history are already recorded elsewhere in the revision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlideRemoval {
    pub slide_part: String,
}

/// Slide created at one revision, named by the part its page points at. The
/// page itself lives on the chunks, so a later edit of the slide is not copied
/// into this record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlideAddition {
    pub slide_part: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridRowInsertion {
    pub sheet_part: String,
    pub before_row: u32,
}

/// Worksheet tab rename recorded at one revision. Source-backed export replays
/// these in revision order, so a chain of renames lands on the final name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetRename {
    pub sheet_part: String,
    pub old_name: String,
    pub new_name: String,
}

/// Worksheet created at one revision, addressed by the part it needs in the
/// package and by the tab position it took. The display name lives on the
/// worksheet chunks, so a later rename is not copied into this record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetAddition {
    pub sheet_part: String,
    pub sheet_index: usize,
}

/// Worksheet deleted at one revision, named by the part its tab pointed at and
/// by the tab name references still carry. A worksheet HCD created and later
/// deleted has no part in the source workbook at all, so the export drops the
/// addition rather than removing anything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetRemoval {
    pub sheet_part: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridRowDeletion {
    pub sheet_part: String,
    pub row: u32,
    pub removed_node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridColumnInsertion {
    pub sheet_part: String,
    pub before_column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridColumnDeletion {
    pub sheet_part: String,
    pub column: u32,
    pub removed_node_ids: Vec<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_asset_index_href() -> String {
    "assets/index.json".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FidelityLevel {
    Exact,
    High,
    Semantic,
    Visual,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FidelityWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_part: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FidelityReport {
    pub schema_version: String,
    pub level: FidelityLevel,
    #[serde(default)]
    pub preserved: Vec<String>,
    #[serde(default)]
    pub flattened: Vec<String>,
    #[serde(default)]
    pub dropped: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<FidelityWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationReport {
    pub valid: bool,
    pub document_id: Option<String>,
    pub revision: Option<u64>,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextExtractEntry {
    pub chunk_id: String,
    pub node_id: String,
    pub text: String,
    pub node_hash: String,
    pub source: SourceAnchor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextNodeLookup {
    pub document_id: String,
    pub revision: u64,
    #[serde(flatten)]
    pub node: TextExtractEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageNodeState {
    pub node_id: String,
    pub visual_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry: Option<ImageGeometry>,
    pub source: SourceAnchor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageNodeLookup {
    pub document_id: String,
    pub revision: u64,
    pub chunk_id: String,
    #[serde(flatten)]
    pub node: ImageNodeState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageExtractEntry {
    pub chunk_id: String,
    #[serde(flatten)]
    pub node: ImageNodeState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageExtractPage {
    pub document_id: String,
    pub revision: u64,
    pub entries: Vec<ImageExtractEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextExtractPage {
    pub document_id: String,
    pub revision: u64,
    pub entries: Vec<TextExtractEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ImportEvent {
    ImportStarted {
        document_id: String,
        source_sha256: String,
    },
    ChunkReady {
        descriptor: ChunkDescriptor,
    },
    AssetReady {
        hash: String,
        href: String,
        byte_length: u64,
    },
    Completed {
        manifest: HcdManifest,
    },
    Failed {
        document_id: String,
        error: String,
    },
}
