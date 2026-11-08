use crate::common::{
    base_manifest, checked_export_state, collect_dirty_nodes, emit_failed, emit_started,
    escape_attribute, escape_text, finish_import, source_identity, write_fidelity_report,
    ExportOptions, ImportOptions, XmlBudget,
};
use hcd_core::{
    hash_bytes, stable_node_id, Bundle, BundleWriter, ChunkSourceMap, FidelityLevel,
    FidelityReport, FidelityWarning, GridChunkAddress, GridChunkKind, HcdError, HcdManifest,
    ImportEvent, NodeMapEntry, SourceAnchor, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES,
};
use oxml::{PackageError, StreamingOxmlArchive, StreamingOxmlRewriter};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use time::{Date, Duration, Month};

const MAX_CONTROL_BYTES: u64 = 16 * 1024 * 1024;
/// Reserved source-map marker for a cell created after the original import.
/// The source exporter still checks that the original cell is actually absent.
const VIRTUAL_CELL_SOURCE: &str = hcd_core::XLSX_VIRTUAL_CELL_SOURCE;
const ROWS_PER_WINDOW: usize = 128;
const MAX_MERGED_RANGES: usize = 1_000_000;
const MAX_FORMAT_CODE_BYTES: usize = 1_024;
const MAX_DRAWING_IMAGES: usize = 100_000;
const MAX_DRAWING_CHARTS: usize = 100_000;
const MAX_CHART_REFERENCE_POINTS: usize = 2_048;
const DEFAULT_COLUMN_WIDTH_EMU: i64 = 609_600;
const DEFAULT_ROW_HEIGHT_EMU: i64 = 190_500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetRecord {
    source_part: String,
    hash: String,
    href: String,
    byte_length: u64,
}

#[derive(Default)]
struct XlsxDrawingAnchor {
    kind: String,
    from_col: Option<u32>,
    from_row: Option<u32>,
    from_col_offset: Option<i64>,
    from_row_offset: Option<i64>,
    to_col: Option<u32>,
    to_row: Option<u32>,
    to_col_offset: Option<i64>,
    to_row_offset: Option<i64>,
    x: Option<i64>,
    y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    picture_id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    relationship_id: Option<String>,
}

struct XlsxDrawingPicture {
    sheet_name: String,
    sheet_part: String,
    drawing_part: String,
    ordinal: u64,
    anchor: XlsxDrawingAnchor,
    asset: AssetRecord,
}

struct XlsxDrawingChart {
    sheet_name: String,
    sheet_part: String,
    drawing_part: String,
    chart_part: String,
    ordinal: u64,
    anchor: XlsxDrawingAnchor,
}

#[derive(Clone, Copy)]
enum ChartSeriesField {
    Name,
    Categories,
    XValues,
    Values,
    BubbleSizes,
}

struct ChartRangeRequest {
    series_index: usize,
    field: ChartSeriesField,
    sheet_part: String,
    range: MergeRange,
    values: Vec<Option<String>>,
}

#[derive(Clone, Copy)]
enum DrawingMarker {
    From,
    To,
}

#[derive(Debug)]
struct SheetPart {
    name: String,
    part: String,
    index: usize,
    state: &'static str,
}

struct WorkbookInfo {
    sheets: Vec<SheetPart>,
    date_1904: bool,
}

#[derive(Default)]
struct CellBuilder {
    reference: String,
    value_type: String,
    style_index: Option<usize>,
    formula: bool,
    sheet_protected: bool,
    value: String,
    inline_text: String,
    capture: Capture,
}

#[derive(Default, PartialEq, Eq)]
enum Capture {
    #[default]
    None,
    Value,
    InlineText,
}

#[derive(Default)]
struct RenderedRow {
    number: u64,
    html: String,
    entries: Vec<NodeMapEntry>,
    merge_end_row: Option<u32>,
    cells: Vec<RenderedCell>,
    merge_anchors: Vec<MergeRange>,
    merge_covers: Vec<MergeRange>,
    first_column: Option<u32>,
    last_column: Option<u32>,
    optional_blank_columns: BTreeSet<u32>,
}

struct RenderedCell {
    column: u32,
    span: u32,
    html: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MergeRange {
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MergePosition {
    Anchor(MergeRange),
    Covered(MergeRange),
}

struct MergeCursor {
    ranges: Vec<MergeRange>,
    next_range: usize,
    current_row: Option<u32>,
    active_by_column: BTreeMap<u32, usize>,
    expirations: BinaryHeap<Reverse<(u32, usize)>>,
}

struct WorksheetScan {
    protected: bool,
    merged_ranges: MergeCursor,
    formula_ranges: MergeCursor,
    view: WorksheetViewMetadata,
}

#[derive(Clone, Default)]
struct WorksheetViewMetadata {
    workbook_view_id: Option<u32>,
    view: Option<&'static str>,
    top_left_cell: Option<String>,
    right_to_left: Option<bool>,
    show_grid_lines: Option<bool>,
    show_row_column_headers: Option<bool>,
    show_zeros: Option<bool>,
    show_formulas: Option<bool>,
    zoom_scale: Option<u16>,
    pane: Option<WorksheetPaneMetadata>,
}

#[derive(Clone)]
struct WorksheetPaneMetadata {
    state: &'static str,
    x_split: Option<f64>,
    y_split: Option<f64>,
    top_left_cell: Option<String>,
    active_pane: Option<&'static str>,
}

impl WorksheetViewMetadata {
    fn html_attributes(&self) -> String {
        let mut attributes = String::new();
        push_data_attribute(&mut attributes, "data-hcd-sheet-view", self.view);
        push_data_attribute(
            &mut attributes,
            "data-hcd-view-top-left-cell",
            self.top_left_cell.as_deref(),
        );
        push_data_bool(
            &mut attributes,
            "data-hcd-right-to-left",
            self.right_to_left,
        );
        push_data_bool(
            &mut attributes,
            "data-hcd-show-grid-lines",
            self.show_grid_lines,
        );
        push_data_bool(
            &mut attributes,
            "data-hcd-show-row-column-headers",
            self.show_row_column_headers,
        );
        push_data_bool(&mut attributes, "data-hcd-show-zeros", self.show_zeros);
        push_data_bool(
            &mut attributes,
            "data-hcd-show-formulas",
            self.show_formulas,
        );
        push_data_number(&mut attributes, "data-hcd-zoom-percent", self.zoom_scale);
        if self.right_to_left == Some(true) {
            attributes.push_str(" style=\"direction:rtl\"");
        }
        if let Some(pane) = &self.pane {
            push_data_attribute(&mut attributes, "data-hcd-pane-state", Some(pane.state));
            push_data_attribute(
                &mut attributes,
                "data-hcd-pane-top-left-cell",
                pane.top_left_cell.as_deref(),
            );
            push_data_attribute(&mut attributes, "data-hcd-active-pane", pane.active_pane);
            if matches!(pane.state, "frozen" | "frozen-split") {
                push_data_number(
                    &mut attributes,
                    "data-hcd-frozen-columns",
                    pane.x_split
                        .and_then(|value| frozen_split_count(value, 16_384)),
                );
                push_data_number(
                    &mut attributes,
                    "data-hcd-frozen-rows",
                    pane.y_split
                        .and_then(|value| frozen_split_count(value, 1_048_576)),
                );
            } else {
                push_data_decimal(&mut attributes, "data-hcd-split-x-twips", pane.x_split);
                push_data_decimal(&mut attributes, "data-hcd-split-y-twips", pane.y_split);
            }
        }
        attributes
    }
}

fn push_data_attribute(output: &mut String, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        output.push(' ');
        output.push_str(name);
        output.push_str("=\"");
        output.push_str(&escape_attribute(value));
        output.push('"');
    }
}

fn push_data_bool(output: &mut String, name: &str, value: Option<bool>) {
    push_data_attribute(
        output,
        name,
        value.map(|value| if value { "true" } else { "false" }),
    );
}

fn push_data_number<T: std::fmt::Display>(output: &mut String, name: &str, value: Option<T>) {
    if let Some(value) = value {
        let value = value.to_string();
        push_data_attribute(output, name, Some(&value));
    }
}

fn push_data_decimal(output: &mut String, name: &str, value: Option<f64>) {
    if let Some(value) = value {
        let value = format!("{value:.2}");
        push_data_attribute(output, name, Some(&value));
    }
}

impl MergeCursor {
    fn new(mut ranges: Vec<MergeRange>) -> Self {
        ranges.sort_unstable_by_key(|range| {
            (
                range.start_row,
                range.start_col,
                range.end_row,
                range.end_col,
            )
        });
        Self {
            ranges,
            next_range: 0,
            current_row: None,
            active_by_column: BTreeMap::new(),
            expirations: BinaryHeap::new(),
        }
    }

    fn begin_row(&mut self, row: u32) -> Result<(), HcdError> {
        if self.current_row.is_some_and(|current| row <= current) {
            return Err(HcdError::InvalidBundle(format!(
                "worksheet rows are duplicate or out of order: {row} follows {}",
                self.current_row.unwrap_or_default()
            )));
        }
        while let Some(Reverse((end_row, index))) = self.expirations.peek().copied() {
            if end_row >= row {
                break;
            }
            self.expirations.pop();
            let start_col = self.ranges[index].start_col;
            if self.active_by_column.get(&start_col) == Some(&index) {
                self.active_by_column.remove(&start_col);
            }
        }
        while let Some(range) = self.ranges.get(self.next_range).copied() {
            if range.start_row > row {
                break;
            }
            let index = self.next_range;
            self.next_range += 1;
            if range.end_row < row {
                continue;
            }
            if let Some((_, active_index)) =
                self.active_by_column.range(..=range.end_col).next_back()
            {
                let active = self.ranges[*active_index];
                if active.end_col >= range.start_col {
                    return Err(HcdError::InvalidBundle(format!(
                        "overlapping XLSX merged ranges {} and {}",
                        merge_reference(active),
                        merge_reference(range)
                    )));
                }
            }
            self.active_by_column.insert(range.start_col, index);
            self.expirations.push(Reverse((range.end_row, index)));
        }
        self.current_row = Some(row);
        Ok(())
    }

    fn classify(&self, row: u32, col: u32) -> Option<MergePosition> {
        if self.current_row != Some(row) {
            return None;
        }
        let (_, index) = self.active_by_column.range(..=col).next_back()?;
        let range = self.ranges[*index];
        if col > range.end_col {
            return None;
        }
        if row == range.start_row && col == range.start_col {
            Some(MergePosition::Anchor(range))
        } else {
            Some(MergePosition::Covered(range))
        }
    }

    fn current_row_anchors(&self) -> Vec<MergeRange> {
        let Some(row) = self.current_row else {
            return Vec::new();
        };
        self.active_by_column
            .values()
            .map(|index| self.ranges[*index])
            .filter(|range| range.start_row == row)
            .collect()
    }

    fn current_row_covers(&self) -> Vec<MergeRange> {
        let Some(row) = self.current_row else {
            return Vec::new();
        };
        self.active_by_column
            .values()
            .map(|index| self.ranges[*index])
            .filter(|range| range.start_row < row && row <= range.end_row)
            .collect()
    }
}

#[derive(Default)]
struct XlsxStyleCatalog {
    fonts: Vec<XlsxFont>,
    fills: Vec<XlsxFill>,
    borders: Vec<XlsxBorder>,
    cell_formats: Vec<XlsxCellFormat>,
    number_formats: HashMap<u32, String>,
}

#[derive(Default)]
struct XlsxFormatStats {
    formatted_cells: u64,
    approximate_cells: u64,
    skipped_blank_cells: u64,
}

struct FormattedCell {
    text: String,
    kind: &'static str,
    num_fmt_id: Option<u32>,
    approximate: bool,
}

#[derive(Default)]
struct XlsxFont {
    name: Option<String>,
    size_points: Option<f64>,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: Option<String>,
}

#[derive(Default)]
struct XlsxFill {
    solid: bool,
    color: Option<String>,
}

#[derive(Default)]
struct XlsxBorder {
    left: Option<XlsxBorderSide>,
    right: Option<XlsxBorderSide>,
    top: Option<XlsxBorderSide>,
    bottom: Option<XlsxBorderSide>,
}

#[derive(Default)]
struct XlsxBorderSide {
    style: String,
    color: Option<String>,
}

#[derive(Default)]
struct XlsxCellFormat {
    font_id: Option<usize>,
    fill_id: Option<usize>,
    border_id: Option<usize>,
    num_fmt_id: Option<u32>,
    horizontal: Option<String>,
    vertical: Option<String>,
    wrap_text: bool,
}

struct SheetChunkWriter<'a, F>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    document_id: &'a str,
    sheet_name: &'a str,
    sheet_index: usize,
    sheet_state: &'static str,
    part: &'a str,
    writer: &'a mut BundleWriter,
    emit: &'a mut F,
    soft_bytes: usize,
    max_rows: usize,
    ordinal: usize,
    rows: usize,
    first_row: Option<u64>,
    last_row: Option<u64>,
    first_column: Option<u32>,
    last_column: Option<u32>,
    html: String,
    entries: Vec<NodeMapEntry>,
    pending_rows: Vec<RenderedRow>,
    compacted_blank_cells: u64,
    column_markup: String,
    default_column_width: Option<f64>,
    default_row_height: Option<f64>,
    view_attributes: String,
    hold_until_row: Option<u32>,
}

impl<'a, F> SheetChunkWriter<'a, F>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    fn new(
        document_id: &'a str,
        sheet: &'a SheetPart,
        options: &ImportOptions,
        view: &WorksheetViewMetadata,
        writer: &'a mut BundleWriter,
        emit: &'a mut F,
    ) -> Self {
        Self {
            document_id,
            sheet_name: &sheet.name,
            sheet_index: sheet.index,
            sheet_state: sheet.state,
            part: &sheet.part,
            writer,
            emit,
            soft_bytes: options.chunk_soft_bytes.min(MAX_CHUNK_BYTES),
            max_rows: options.chunk_blocks.clamp(1, ROWS_PER_WINDOW),
            ordinal: 0,
            rows: 0,
            first_row: None,
            last_row: None,
            first_column: None,
            last_column: None,
            html: String::new(),
            entries: Vec::new(),
            pending_rows: Vec::new(),
            compacted_blank_cells: 0,
            column_markup: String::new(),
            default_column_width: None,
            default_row_height: None,
            view_attributes: view.html_attributes(),
            hold_until_row: None,
        }
    }

    fn push(&mut self, mut row: RenderedRow) -> Result<(), HcdError> {
        if self
            .hold_until_row
            .is_some_and(|end_row| row.number > u64::from(end_row))
        {
            self.hold_until_row = None;
        }
        let inside_merge_group = self
            .hold_until_row
            .is_some_and(|end_row| row.number <= u64::from(end_row));
        if self.rows > 0
            && !inside_merge_group
            && (self.html.len() + row.html.len() > self.soft_bytes || self.rows >= self.max_rows)
        {
            self.flush()?;
        }
        // Reserve the exact serialized wrapper size, including column markup.
        let reserve = self
            .wrap_rows(self.first_row.unwrap_or(row.number), row.number, "")
            .len();
        let budget = MAX_CHUNK_BYTES.saturating_sub(reserve);
        // A mapped empty cell needs space for later text edits. Leave modest
        // room where possible, but never reject otherwise valid existing data
        // merely because it cannot meet this optional headroom.
        const EDIT_HEADROOM: usize = 128 * 1024;
        let has_optional = !row.optional_blank_columns.is_empty()
            || self
                .pending_rows
                .iter()
                .any(|item| !item.optional_blank_columns.is_empty());
        let target = if has_optional {
            budget.saturating_sub(EDIT_HEADROOM)
        } else {
            budget
        };
        if self.html.len() + row.html.len() > target && has_optional {
            // Keep earlier rows and as many blank mappings as fit. Compact
            // later rows first, without splitting a vertical merge group.
            let excess = self.html.len() + row.html.len() - target;
            let row_budget = row.html.len().saturating_sub(excess);
            self.compacted_blank_cells += compact_worksheet_row(&mut row, row_budget)?;
            let mut total = self.html.len() + row.html.len();
            for previous in self.pending_rows.iter_mut().rev() {
                if total <= target {
                    break;
                }
                let before = previous.html.len();
                self.compacted_blank_cells +=
                    compact_worksheet_row(previous, before.saturating_sub(total - target))?;
                total = total - before + previous.html.len();
            }
            self.html.clear();
            self.entries.clear();
            for previous in &self.pending_rows {
                self.html.push_str(&previous.html);
                self.entries.extend(previous.entries.iter().cloned());
            }
        }
        if self.html.len() + row.html.len() > budget {
            return Err(HcdError::ResourceLimit(format!(
                "NODE_TOO_LARGE: XLSX merged row group ending at row {} in {} exceeds 2 MiB",
                self.hold_until_row
                    .unwrap_or_else(|| u32::try_from(row.number).unwrap_or(u32::MAX)),
                self.part
            )));
        }
        self.first_row.get_or_insert(row.number);
        self.last_row = Some(row.number);
        if let Some(first_column) = row.first_column {
            self.first_column = Some(
                self.first_column
                    .map_or(first_column, |current| current.min(first_column)),
            );
        }
        if let Some(last_column) = row.last_column {
            self.last_column = Some(
                self.last_column
                    .map_or(last_column, |current| current.max(last_column)),
            );
        }
        if let Some(end_row) = row.merge_end_row {
            self.hold_until_row = Some(self.hold_until_row.unwrap_or(0).max(end_row));
        }
        self.rows += 1;
        self.html.push_str(&row.html);
        self.entries.extend(row.entries.iter().cloned());
        self.pending_rows.push(row);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), HcdError> {
        if self.rows == 0 {
            return Ok(());
        }
        let first = self.first_row.unwrap_or(0);
        let last = self.last_row.unwrap_or(first);
        let chunk_id = stable_node_id(&[
            self.document_id,
            self.part,
            "sheet-window",
            &self.ordinal.to_string(),
        ])
        .replacen("n_", "c_", 1);
        let html = self.wrap_rows(first, last, &self.html);
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: chunk_id.clone(),
            entries: std::mem::take(&mut self.entries),
        };
        let descriptor = self.writer.write_grid_chunk(
            chunk_id,
            html,
            map,
            self.rows,
            self.ordinal > 0,
            GridChunkAddress {
                sheet_id: sheet_grid_id(self.document_id, self.part),
                sheet_name: self.sheet_name.to_string(),
                sheet_index: self.sheet_index,
                sheet_state: self.sheet_state.to_string(),
                kind: GridChunkKind::Cells,
                row_start: Some(first),
                row_end: Some(last),
                column_start: self.first_column,
                column_end: self.last_column,
                default_column_width_emu: Some(default_column_width_emu(self.default_column_width)),
                default_row_height_emu: Some(default_row_height_emu(self.default_row_height)),
            },
        )?;
        (self.emit)(&ImportEvent::ChunkReady { descriptor })?;
        self.ordinal += 1;
        self.rows = 0;
        self.first_row = None;
        self.last_row = None;
        self.first_column = None;
        self.last_column = None;
        self.hold_until_row = None;
        self.html.clear();
        self.pending_rows.clear();
        Ok(())
    }

    fn wrap_rows(&self, first: u64, last: u64, rows: &str) -> String {
        let default_width = self
            .default_column_width
            .map(|width| format!(" data-hcd-default-column-width=\"{width:.2}\""))
            .unwrap_or_default();
        let default_height = self
            .default_row_height
            .map(|height| format!(" data-hcd-default-row-height-points=\"{height:.2}\""))
            .unwrap_or_default();
        format!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\" data-hcd-row-start=\"{}\" data-hcd-row-end=\"{}\"{}{}{}><table class=\"hcd-grid\"><colgroup>{}</colgroup><tbody>{}</tbody></table></section>",
            escape_attribute(self.sheet_name),
            self.sheet_index,
            self.sheet_state,
            first,
            last,
            default_width,
            default_height,
            self.view_attributes,
            self.column_markup,
            rows
        )
    }

    fn finish(&mut self) -> Result<(), HcdError> {
        if self.rows > 0 {
            return self.flush();
        }
        if self.ordinal > 0 {
            return Ok(());
        }
        let chunk_id = stable_node_id(&[
            self.document_id,
            self.part,
            "sheet-window",
            &self.ordinal.to_string(),
        ])
        .replacen("n_", "c_", 1);
        let default_width = self
            .default_column_width
            .map(|width| format!(" data-hcd-default-column-width=\"{width:.2}\""))
            .unwrap_or_default();
        let default_height = self
            .default_row_height
            .map(|height| format!(" data-hcd-default-row-height-points=\"{height:.2}\""))
            .unwrap_or_default();
        let html = format!(
            "<section class=\"hcd-sheet\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\"{}{}{}><table class=\"hcd-grid\"><colgroup>{}</colgroup><tbody></tbody></table></section>",
            escape_attribute(self.sheet_name),
            self.sheet_index,
            self.sheet_state,
            default_width,
            default_height,
            self.view_attributes,
            self.column_markup
        );
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: chunk_id.clone(),
            entries: Vec::new(),
        };
        let descriptor = self.writer.write_grid_chunk(
            chunk_id,
            html,
            map,
            1,
            false,
            GridChunkAddress {
                sheet_id: sheet_grid_id(self.document_id, self.part),
                sheet_name: self.sheet_name.to_string(),
                sheet_index: self.sheet_index,
                sheet_state: self.sheet_state.to_string(),
                kind: GridChunkKind::Cells,
                row_start: None,
                row_end: None,
                column_start: None,
                column_end: None,
                default_column_width_emu: Some(default_column_width_emu(self.default_column_width)),
                default_row_height_emu: Some(default_row_height_emu(self.default_row_height)),
            },
        )?;
        (self.emit)(&ImportEvent::ChunkReady { descriptor })?;
        self.ordinal += 1;
        Ok(())
    }
}

struct SharedStringStore {
    values: File,
    offsets: File,
    count: u64,
}

impl SharedStringStore {
    fn empty(directory: &Path) -> Result<Self, HcdError> {
        Ok(Self {
            values: OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(directory.join("shared-values.bin"))?,
            offsets: OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(directory.join("shared-offsets.bin"))?,
            count: 0,
        })
    }

    fn build(archive: &mut StreamingOxmlArchive, directory: &Path) -> Result<Self, HcdError> {
        let mut store = Self::empty(directory)?;
        if !archive.contains("xl/sharedStrings.xml") {
            return Ok(store);
        }
        archive
            .with_part("xl/sharedStrings.xml", |source| {
                let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
                reader.config_mut().check_end_names = true;
                let mut buffer = Vec::with_capacity(64 * 1024);
                let mut current: Option<String> = None;
                let mut in_text = false;
                let mut budget = XmlBudget::default();
                loop {
                    let event = reader.read_event_into(&mut buffer).map_err(|error| {
                        PackageError::ReadPartError(format!("sharedStrings XML: {error}"))
                    })?;
                    budget
                        .observe(&event, "xl/sharedStrings.xml")
                        .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                    match event {
                        Event::Start(ref start) if local_name(start.name().as_ref()) == "si" => {
                            current = Some(String::new());
                        }
                        Event::Start(ref start) if local_name(start.name().as_ref()) == "t" => {
                            in_text = current.is_some();
                        }
                        Event::Text(text) if in_text => {
                            let decoded = text.unescape().map_err(|error| {
                                PackageError::ReadPartError(format!("shared string text: {error}"))
                            })?;
                            let value = current.as_mut().expect("in_text requires a string");
                            value.push_str(&decoded);
                            if value.len() > MAX_CHUNK_BYTES {
                                return Err(PackageError::ReadPartError(
                                    "NODE_TOO_LARGE: shared string exceeds 2 MiB".to_string(),
                                ));
                            }
                        }
                        Event::End(ref end) if local_name(end.name().as_ref()) == "t" => {
                            in_text = false;
                        }
                        Event::End(ref end) if local_name(end.name().as_ref()) == "si" => {
                            let value = current.take().unwrap_or_default();
                            store
                                .push(&value)
                                .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                        }
                        Event::Eof => {
                            budget
                                .finish("xl/sharedStrings.xml")
                                .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                            break;
                        }
                        _ => {}
                    }
                    buffer.clear();
                }
                Ok(())
            })
            .map_err(package_error)?;
        Ok(store)
    }

    fn push(&mut self, value: &str) -> Result<(), HcdError> {
        let offset = self.values.seek(SeekFrom::End(0))?;
        self.offsets.write_all(&offset.to_le_bytes())?;
        self.values.write_all(&(value.len() as u64).to_le_bytes())?;
        self.values.write_all(value.as_bytes())?;
        self.count += 1;
        Ok(())
    }

    fn get(&mut self, index: u64) -> Result<String, HcdError> {
        if index >= self.count {
            return Err(HcdError::InvalidBundle(format!(
                "shared string index {index} exceeds {} entries",
                self.count
            )));
        }
        self.offsets.seek(SeekFrom::Start(index * 8))?;
        let mut encoded = [0u8; 8];
        self.offsets.read_exact(&mut encoded)?;
        let offset = u64::from_le_bytes(encoded);
        self.values.seek(SeekFrom::Start(offset))?;
        self.values.read_exact(&mut encoded)?;
        let length = u64::from_le_bytes(encoded);
        if length > MAX_CHUNK_BYTES as u64 {
            return Err(HcdError::ResourceLimit(
                "NODE_TOO_LARGE: shared string exceeds 2 MiB".to_string(),
            ));
        }
        let mut bytes = vec![0u8; length as usize];
        self.values.read_exact(&mut bytes)?;
        String::from_utf8(bytes)
            .map_err(|error| HcdError::InvalidBundle(format!("shared string UTF-8: {error}")))
    }
}

fn render_xlsx_styles(
    archive: &mut StreamingOxmlArchive,
) -> Result<(String, XlsxStyleCatalog), HcdError> {
    let mut css = String::from(
        ".hcd-sheet{overflow:auto;background:#fff}.hcd-grid{border-collapse:separate;border-spacing:0;table-layout:fixed;background:#fff}.hcd-grid td{box-sizing:border-box;min-width:64px;height:20px;border:0;border-right:1px solid #ddd;border-bottom:1px solid #ddd;padding:.2em .35em;vertical-align:middle;white-space:nowrap}.hcd-grid .hcd-empty{background:#fff}.hcd-grid td>span{white-space:inherit}.hcd-sheet[data-hcd-show-grid-lines=\"false\"] .hcd-grid td{border-color:transparent}.hcd-sheet-drawing-layer{position:relative;overflow:auto;background:repeating-linear-gradient(0deg,#fff 0,#fff 19px,#eef1f5 20px),repeating-linear-gradient(90deg,transparent 0,transparent 63px,#eef1f5 64px)}.hcd-sheet-picture,.hcd-sheet-chart{position:absolute;box-sizing:border-box;overflow:hidden;background:#fff}.hcd-sheet-picture img,.hcd-sheet-chart img{display:block;width:100%;height:100%;object-fit:contain}body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-sheet-picture[data-hcd-id],body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-sheet-chart[data-hcd-id]{cursor:crosshair}body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-sheet-picture[data-hcd-id]:hover,body:not([data-hcd-image-hitboxes=\"off\"]) .hcd-sheet-chart[data-hcd-id]:hover{outline:2px solid rgba(255,59,48,.95);outline-offset:-1px}body:not([data-hcd-text-hitboxes=\"off\"]) [data-hcd-node-hash]:not([data-hcd-node-kind=\"image\"]):hover{background:rgba(10,132,255,.12);outline:1px solid rgba(10,132,255,.8)}",
    );
    if !archive.contains("xl/styles.xml") {
        return Ok((css, XlsxStyleCatalog::default()));
    }
    let xml = archive
        .read_control_part("xl/styles.xml", MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let catalog = parse_xlsx_styles(&xml)?;
    for (index, format) in catalog.cell_formats.iter().enumerate() {
        let declarations = xlsx_format_declarations(format, &catalog);
        if !declarations.is_empty() {
            css.push_str(&format!(".hcd-xs-{index}{{{}}}", declarations.join(";")));
        }
    }
    hcd_core::validate_css_text(&css)?;
    Ok((css, catalog))
}

fn parse_xlsx_styles(xml: &[u8]) -> Result<XlsxStyleCatalog, HcdError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut section: Option<(&'static str, usize)> = None;
    let mut catalog = XlsxStyleCatalog::default();
    let mut font: Option<XlsxFont> = None;
    let mut fill: Option<XlsxFill> = None;
    let mut border: Option<XlsxBorder> = None;
    let mut border_edge: Option<&'static str> = None;
    let mut cell_format: Option<XlsxCellFormat> = None;

    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("invalid xl/styles.xml: {error}")))?;
        match event {
            Event::Start(ref element) => {
                depth += 1;
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                match name {
                    "numFmts" | "fonts" | "fills" | "borders" | "cellXfs" => {
                        section = Some((
                            match name {
                                "numFmts" => "numFmts",
                                "fonts" => "fonts",
                                "fills" => "fills",
                                "borders" => "borders",
                                _ => "cellXfs",
                            },
                            depth,
                        ));
                    }
                    "numFmt" if section.is_some_and(|(name, _)| name == "numFmts") => {
                        capture_number_format(element, &mut catalog)?;
                    }
                    "font" if section.is_some_and(|(name, _)| name == "fonts") => {
                        font = Some(XlsxFont::default())
                    }
                    "fill" if section.is_some_and(|(name, _)| name == "fills") => {
                        fill = Some(XlsxFill::default())
                    }
                    "border" if section.is_some_and(|(name, _)| name == "borders") => {
                        border = Some(XlsxBorder::default())
                    }
                    "xf" if section.is_some_and(|(name, _)| name == "cellXfs") => {
                        cell_format = Some(parse_cell_format(element));
                    }
                    "left" | "right" | "top" | "bottom" if border.is_some() => {
                        border_edge = Some(match name {
                            "left" => "left",
                            "right" => "right",
                            "top" => "top",
                            _ => "bottom",
                        });
                        capture_border_side(element, border.as_mut(), border_edge);
                    }
                    _ => capture_xlsx_style_property(
                        element,
                        font.as_mut(),
                        fill.as_mut(),
                        border.as_mut(),
                        border_edge,
                        cell_format.as_mut(),
                    ),
                }
            }
            Event::Empty(ref element) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                if name == "numFmt" && section.is_some_and(|(name, _)| name == "numFmts") {
                    capture_number_format(element, &mut catalog)?;
                } else if name == "font" && section.is_some_and(|(name, _)| name == "fonts") {
                    catalog.fonts.push(XlsxFont::default());
                } else if name == "fill" && section.is_some_and(|(name, _)| name == "fills") {
                    catalog.fills.push(XlsxFill::default());
                } else if name == "border" && section.is_some_and(|(name, _)| name == "borders") {
                    catalog.borders.push(XlsxBorder::default());
                } else if name == "xf" && section.is_some_and(|(name, _)| name == "cellXfs") {
                    catalog.cell_formats.push(parse_cell_format(element));
                } else if matches!(name, "left" | "right" | "top" | "bottom") && border.is_some() {
                    let edge = Some(match name {
                        "left" => "left",
                        "right" => "right",
                        "top" => "top",
                        _ => "bottom",
                    });
                    capture_border_side(element, border.as_mut(), edge);
                } else {
                    capture_xlsx_style_property(
                        element,
                        font.as_mut(),
                        fill.as_mut(),
                        border.as_mut(),
                        border_edge,
                        cell_format.as_mut(),
                    );
                }
            }
            Event::End(ref element) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                match name {
                    "font" => {
                        if let Some(font) = font.take() {
                            catalog.fonts.push(font);
                        }
                    }
                    "fill" => {
                        if let Some(fill) = fill.take() {
                            catalog.fills.push(fill);
                        }
                    }
                    "border" => {
                        if let Some(border) = border.take() {
                            catalog.borders.push(border);
                        }
                    }
                    "xf" => {
                        if let Some(format) = cell_format.take() {
                            catalog.cell_formats.push(format);
                        }
                    }
                    "left" | "right" | "top" | "bottom" => border_edge = None,
                    _ => {}
                }
                if section.is_some_and(|(_, section_depth)| section_depth == depth) {
                    section = None;
                }
                depth = depth.checked_sub(1).ok_or_else(|| {
                    HcdError::InvalidBundle("unbalanced xl/styles.xml".to_string())
                })?;
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(catalog)
}

fn capture_number_format(
    element: &BytesStart<'_>,
    catalog: &mut XlsxStyleCatalog,
) -> Result<(), HcdError> {
    let Some(id) = attribute(element, "numFmtId").and_then(|value| value.parse::<u32>().ok())
    else {
        return Ok(());
    };
    let Some(code) = attribute(element, "formatCode") else {
        return Ok(());
    };
    if code.len() > MAX_FORMAT_CODE_BYTES {
        return Err(HcdError::ResourceLimit(format!(
            "XLSX number format {id} exceeds {MAX_FORMAT_CODE_BYTES} bytes"
        )));
    }
    catalog.number_formats.insert(id, code);
    Ok(())
}

fn parse_cell_format(element: &BytesStart<'_>) -> XlsxCellFormat {
    XlsxCellFormat {
        font_id: attribute(element, "fontId").and_then(|value| value.parse().ok()),
        fill_id: attribute(element, "fillId").and_then(|value| value.parse().ok()),
        border_id: attribute(element, "borderId").and_then(|value| value.parse().ok()),
        num_fmt_id: attribute(element, "numFmtId").and_then(|value| value.parse().ok()),
        ..Default::default()
    }
}

fn capture_xlsx_style_property(
    element: &BytesStart<'_>,
    font: Option<&mut XlsxFont>,
    fill: Option<&mut XlsxFill>,
    border: Option<&mut XlsxBorder>,
    border_edge: Option<&str>,
    cell_format: Option<&mut XlsxCellFormat>,
) {
    let qualified_name = element.name();
    let name = local_name(qualified_name.as_ref());
    if let Some(font) = font {
        match name {
            "name" => font.name = attribute(element, "val"),
            "sz" => font.size_points = attribute(element, "val").and_then(|v| v.parse().ok()),
            "b" => font.bold = xlsx_on_off(element),
            "i" => font.italic = xlsx_on_off(element),
            "u" => font.underline = xlsx_on_off(element),
            "strike" => font.strike = xlsx_on_off(element),
            "color" => font.color = xlsx_rgb(element),
            _ => {}
        }
    }
    if let Some(fill) = fill {
        match name {
            "patternFill" => {
                fill.solid = attribute(element, "patternType").as_deref() == Some("solid")
            }
            "fgColor" if fill.solid => fill.color = xlsx_rgb(element),
            _ => {}
        }
    }
    if name == "color" {
        if let (Some(border), Some(edge)) = (border, border_edge) {
            if let Some(side) = border_side_mut(border, edge) {
                side.color = xlsx_rgb(element);
            }
        }
    }
    if name == "alignment" {
        if let Some(format) = cell_format {
            format.horizontal = attribute(element, "horizontal");
            format.vertical = attribute(element, "vertical");
            format.wrap_text = attribute(element, "wrapText")
                .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
        }
    }
}

fn capture_border_side(
    element: &BytesStart<'_>,
    border: Option<&mut XlsxBorder>,
    edge: Option<&str>,
) {
    let (Some(border), Some(edge), Some(style)) = (border, edge, attribute(element, "style"))
    else {
        return;
    };
    *border_side_slot(border, edge) = Some(XlsxBorderSide { style, color: None });
}

fn border_side_slot<'a>(border: &'a mut XlsxBorder, edge: &str) -> &'a mut Option<XlsxBorderSide> {
    match edge {
        "left" => &mut border.left,
        "right" => &mut border.right,
        "top" => &mut border.top,
        _ => &mut border.bottom,
    }
}

fn border_side_mut<'a>(border: &'a mut XlsxBorder, edge: &str) -> Option<&'a mut XlsxBorderSide> {
    border_side_slot(border, edge).as_mut()
}

fn xlsx_format_declarations(format: &XlsxCellFormat, catalog: &XlsxStyleCatalog) -> Vec<String> {
    let mut css = Vec::new();
    if let Some(font) = format.font_id.and_then(|id| catalog.fonts.get(id)) {
        if let Some(name) = font.name.as_deref().and_then(safe_css_font) {
            css.push(format!("font-family:'{}'", name.replace('\'', "")));
        }
        if let Some(size) = font.size_points.filter(|size| (1.0..=409.0).contains(size)) {
            css.push(format!("font-size:{size:.1}pt"));
        }
        if font.bold {
            css.push("font-weight:700".to_string());
        }
        if font.italic {
            css.push("font-style:italic".to_string());
        }
        let mut decorations = Vec::new();
        if font.underline {
            decorations.push("underline");
        }
        if font.strike {
            decorations.push("line-through");
        }
        if !decorations.is_empty() {
            css.push(format!("text-decoration:{}", decorations.join(" ")));
        }
        if let Some(color) = &font.color {
            css.push(format!("color:#{color}"));
        }
    }
    if let Some(fill) = format.fill_id.and_then(|id| catalog.fills.get(id)) {
        if fill.solid {
            if let Some(color) = &fill.color {
                css.push(format!("background-color:#{color}"));
            }
        }
    }
    if let Some(border) = format.border_id.and_then(|id| catalog.borders.get(id)) {
        for (property, side) in [
            ("border-left", &border.left),
            ("border-right", &border.right),
            ("border-top", &border.top),
            ("border-bottom", &border.bottom),
        ] {
            if let Some(side) = side {
                let (width, line) = xlsx_border_css(&side.style);
                let color = side.color.as_deref().unwrap_or("000000");
                css.push(format!("{property}:{width}px {line} #{color}"));
            }
        }
    }
    if let Some(horizontal) = format.horizontal.as_deref().and_then(xlsx_horizontal) {
        css.push(format!("text-align:{horizontal}"));
    }
    if let Some(vertical) = format.vertical.as_deref().and_then(xlsx_vertical) {
        css.push(format!("vertical-align:{vertical}"));
    }
    if format.wrap_text {
        css.push("white-space:pre-wrap".to_string());
        css.push("overflow-wrap:anywhere".to_string());
    }
    if let Some(num_fmt_id) = format.num_fmt_id {
        css.push(format!("--hcd-num-fmt-id:{num_fmt_id}"));
    }
    css
}

fn format_xlsx_cell(
    raw: &str,
    style_index: Option<usize>,
    is_numeric: bool,
    catalog: &XlsxStyleCatalog,
    date_1904: bool,
) -> FormattedCell {
    let num_fmt_id = style_index
        .and_then(|index| catalog.cell_formats.get(index))
        .and_then(|format| format.num_fmt_id);
    let Some(id) = num_fmt_id else {
        return FormattedCell {
            text: raw.to_string(),
            kind: "general",
            num_fmt_id: None,
            approximate: false,
        };
    };
    if !is_numeric || id == 0 {
        return FormattedCell {
            text: raw.to_string(),
            kind: "general",
            num_fmt_id: Some(id),
            approximate: false,
        };
    }
    let Ok(value) = raw.parse::<f64>() else {
        return FormattedCell {
            text: raw.to_string(),
            kind: "general",
            num_fmt_id: Some(id),
            approximate: true,
        };
    };
    if !value.is_finite() {
        return FormattedCell {
            text: raw.to_string(),
            kind: "general",
            num_fmt_id: Some(id),
            approximate: true,
        };
    }
    let (code, built_in_approximate) = catalog
        .number_formats
        .get(&id)
        .map(|code| (code.as_str(), false))
        .or_else(|| built_in_number_format(id))
        .unwrap_or(("General", true));
    let (section, use_absolute, section_approximate) = select_number_format_section(code, value);
    let value = if use_absolute { value.abs() } else { value };
    let (has_date, has_time) = date_time_format_kind(id, section);
    if has_date || has_time {
        let text =
            format_excel_date_time(value, section, date_1904).unwrap_or_else(|| raw.to_string());
        return FormattedCell {
            text,
            kind: match (has_date, has_time) {
                (true, true) => "datetime",
                (true, false) => "date",
                _ => "time",
            },
            num_fmt_id: Some(id),
            approximate: built_in_approximate
                || section_approximate
                || contains_locale_directive(section),
        };
    }
    let (text, kind, formatter_approximate) = format_excel_number(value, section, raw);
    FormattedCell {
        text,
        kind,
        num_fmt_id: Some(id),
        approximate: built_in_approximate || section_approximate || formatter_approximate,
    }
}

fn built_in_number_format(id: u32) -> Option<(&'static str, bool)> {
    let format = match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        5 | 6 => r#"$#,##0;($#,##0)"#,
        7 | 8 => r#"$#,##0.00;($#,##0.00)"#,
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "m/d/yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        27..=36 | 50..=58 => "yyyy-mm-dd",
        37 | 38 => "#,##0;(#,##0)",
        39 | 40 => "#,##0.00;(#,##0.00)",
        41 | 42 => r#"$#,##0;($#,##0);$-"#,
        43 | 44 => r#"$#,##0.00;($#,##0.00);$-"#,
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    };
    Some((format, matches!(id, 27..=36 | 50..=58)))
}

fn split_number_format_sections(code: &str) -> Vec<&str> {
    let mut sections = Vec::new();
    let mut start = 0usize;
    let mut quoted = false;
    let mut bracket_depth = 0usize;
    let mut escaped = false;
    for (index, character) in code.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' if bracket_depth == 0 => quoted = !quoted,
            '[' if !quoted => bracket_depth += 1,
            ']' if !quoted => bracket_depth = bracket_depth.saturating_sub(1),
            ';' if !quoted && bracket_depth == 0 => {
                sections.push(&code[start..index]);
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    sections.push(&code[start..]);
    sections
}

fn select_number_format_section(code: &str, value: f64) -> (&str, bool, bool) {
    let sections = split_number_format_sections(code);
    let contains_conditions = sections
        .iter()
        .any(|section| section.contains("[>") || section.contains("[<") || section.contains("[="));
    if value < 0.0 && sections.get(1).is_some_and(|section| !section.is_empty()) {
        (sections[1], true, contains_conditions)
    } else if value == 0.0 && sections.get(2).is_some_and(|section| !section.is_empty()) {
        (sections[2], false, contains_conditions)
    } else {
        (
            sections.first().copied().unwrap_or("General"),
            false,
            contains_conditions,
        )
    }
}

fn contains_locale_directive(code: &str) -> bool {
    code.as_bytes().windows(2).any(|window| window == b"[$")
}

fn format_symbols(code: &str) -> String {
    let mut output = String::new();
    let mut chars = code.chars().peekable();
    let mut quoted = false;
    while let Some(character) = chars.next() {
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if character == '\\' {
            chars.next();
            continue;
        }
        if quoted {
            continue;
        }
        if character == '[' {
            let mut bracket = String::new();
            for nested in chars.by_ref() {
                if nested == ']' {
                    break;
                }
                bracket.push(nested);
            }
            if matches!(
                bracket.to_ascii_lowercase().as_str(),
                "h" | "hh" | "m" | "mm" | "s" | "ss"
            ) {
                output.push_str(&bracket.to_ascii_lowercase());
            }
            continue;
        }
        output.extend(character.to_lowercase());
    }
    output
}

fn date_time_format_kind(id: u32, code: &str) -> (bool, bool) {
    let built_in_date = matches!(id, 14..=17 | 22 | 27..=36 | 50..=58);
    let built_in_time = matches!(id, 18..=22 | 45..=47);
    let symbols = format_symbols(code);
    let has_time = built_in_time
        || symbols.contains('h')
        || symbols.contains('s')
        || symbols.contains("am/pm");
    let has_date = built_in_date
        || symbols.contains('y')
        || symbols.contains('d')
        || (symbols.contains('m') && !has_time);
    (has_date, has_time)
}

struct ExcelDateTimeParts {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    millisecond: u16,
    weekday_from_monday: Option<u8>,
    elapsed_seconds: i64,
}

fn excel_serial_date_time(value: f64, date_1904: bool) -> Option<ExcelDateTimeParts> {
    if !(0.0..=2_958_465.999_999).contains(&value) || !value.is_finite() {
        return None;
    }
    let mut serial_days = value.floor() as i64;
    let mut day_milliseconds = ((value - value.floor()) * 86_400_000.0).round() as i64;
    if day_milliseconds >= 86_400_000 {
        serial_days = serial_days.checked_add(1)?;
        day_milliseconds -= 86_400_000;
    }
    let elapsed_seconds = (value * 86_400.0).round() as i64;
    let (year, month, day, weekday_from_monday) = if !date_1904 && serial_days == 60 {
        (1900, 2, 29, None)
    } else {
        let (base, offset) = if date_1904 {
            (
                Date::from_calendar_date(1904, Month::January, 1).ok()?,
                serial_days,
            )
        } else {
            (
                Date::from_calendar_date(1899, Month::December, 31).ok()?,
                if serial_days > 60 {
                    serial_days - 1
                } else {
                    serial_days
                },
            )
        };
        let date = base.checked_add(Duration::days(offset))?;
        (
            date.year(),
            date.month() as u8,
            date.day(),
            Some(date.weekday().number_days_from_monday()),
        )
    };
    let total_seconds = day_milliseconds / 1_000;
    Some(ExcelDateTimeParts {
        year,
        month,
        day,
        hour: (total_seconds / 3_600) as u8,
        minute: ((total_seconds % 3_600) / 60) as u8,
        second: (total_seconds % 60) as u8,
        millisecond: (day_milliseconds % 1_000) as u16,
        weekday_from_monday,
        elapsed_seconds,
    })
}

fn format_excel_date_time(value: f64, code: &str, date_1904: bool) -> Option<String> {
    let parts = excel_serial_date_time(value, date_1904)?;
    let chars: Vec<char> = code.chars().collect();
    let symbols = format_symbols(code);
    let has_date = symbols.contains('y') || symbols.contains('d');
    let has_time = symbols.contains('h') || symbols.contains('s') || symbols.contains("am/pm");
    let twelve_hour = symbols.contains("am/pm");
    let mut output = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        if starts_with_ascii_case_insensitive(&chars, index, "AM/PM") {
            output.push_str(if parts.hour < 12 { "AM" } else { "PM" });
            index += 5;
            continue;
        }
        match chars[index] {
            '"' => {
                index += 1;
                while index < chars.len() && chars[index] != '"' {
                    output.push(chars[index]);
                    index += 1;
                }
                index += usize::from(index < chars.len());
            }
            '\\' => {
                index += 1;
                if let Some(character) = chars.get(index) {
                    output.push(*character);
                    index += 1;
                }
            }
            '_' => {
                output.push(' ');
                index = (index + 2).min(chars.len());
            }
            '*' => index = (index + 2).min(chars.len()),
            '[' => {
                let end = chars[index + 1..]
                    .iter()
                    .position(|character| *character == ']')
                    .map(|offset| index + 1 + offset)
                    .unwrap_or(chars.len());
                let directive: String = chars[index + 1..end].iter().collect();
                match directive.to_ascii_lowercase().as_str() {
                    "h" => output.push_str(&(parts.elapsed_seconds / 3_600).to_string()),
                    "hh" => output.push_str(&format!("{:02}", parts.elapsed_seconds / 3_600)),
                    "m" => output.push_str(&(parts.elapsed_seconds / 60).to_string()),
                    "mm" => output.push_str(&format!("{:02}", parts.elapsed_seconds / 60)),
                    "s" => output.push_str(&parts.elapsed_seconds.to_string()),
                    "ss" => output.push_str(&format!("{:02}", parts.elapsed_seconds)),
                    _ => {
                        if let Some(currency) = currency_from_directive(&directive) {
                            output.push_str(currency);
                        }
                    }
                }
                index = (end + 1).min(chars.len());
            }
            character if matches!(character.to_ascii_lowercase(), 'y' | 'm' | 'd' | 'h' | 's') => {
                let token = character.to_ascii_lowercase();
                let start = index;
                while index < chars.len() && chars[index].to_ascii_lowercase() == token {
                    index += 1;
                }
                let width = index - start;
                match token {
                    'y' if width == 2 => output.push_str(&format!("{:02}", parts.year % 100)),
                    'y' => output.push_str(&format!("{:04}", parts.year)),
                    'd' if width == 1 => output.push_str(&parts.day.to_string()),
                    'd' if width == 2 => output.push_str(&format!("{:02}", parts.day)),
                    'd' if width == 3 => {
                        output.push_str(weekday_name(parts.weekday_from_monday, false))
                    }
                    'd' => output.push_str(weekday_name(parts.weekday_from_monday, true)),
                    'm' if is_minute_token(&chars, start, index, has_date, has_time) => {
                        if width == 1 {
                            output.push_str(&parts.minute.to_string());
                        } else {
                            output.push_str(&format!("{:02}", parts.minute));
                        }
                    }
                    'm' if width == 1 => output.push_str(&parts.month.to_string()),
                    'm' if width == 2 => output.push_str(&format!("{:02}", parts.month)),
                    'm' if width == 3 => output.push_str(month_name(parts.month, false)),
                    'm' => output.push_str(month_name(parts.month, true)),
                    'h' => {
                        let hour = if twelve_hour {
                            let hour = parts.hour % 12;
                            if hour == 0 {
                                12
                            } else {
                                hour
                            }
                        } else {
                            parts.hour
                        };
                        if width == 1 {
                            output.push_str(&hour.to_string());
                        } else {
                            output.push_str(&format!("{hour:02}"));
                        }
                    }
                    's' if width == 1 => output.push_str(&parts.second.to_string()),
                    's' => output.push_str(&format!("{:02}", parts.second)),
                    _ => {}
                }
            }
            '0' if index > 0 && chars[index - 1] == '.' && has_time => {
                let start = index;
                while index < chars.len() && chars[index] == '0' {
                    index += 1;
                }
                let width = (index - start).min(3);
                let milliseconds = format!("{:03}", parts.millisecond);
                output.push_str(&milliseconds[..width]);
            }
            character => {
                output.push(character);
                index += 1;
            }
        }
    }
    Some(output.trim().to_string())
}

fn starts_with_ascii_case_insensitive(chars: &[char], start: usize, expected: &str) -> bool {
    let expected: Vec<char> = expected.chars().collect();
    chars
        .get(start..start + expected.len())
        .is_some_and(|actual| {
            actual
                .iter()
                .zip(expected.iter())
                .all(|(left, right)| left.eq_ignore_ascii_case(right))
        })
}

fn is_minute_token(
    chars: &[char],
    start: usize,
    end: usize,
    has_date: bool,
    has_time: bool,
) -> bool {
    if has_time && !has_date {
        return true;
    }
    let previous = chars[..start]
        .iter()
        .rev()
        .find(|character| !character.is_whitespace());
    let next = chars[end..]
        .iter()
        .find(|character| !character.is_whitespace());
    previous == Some(&':') || next == Some(&':')
}

fn month_name(month: u8, long: bool) -> &'static str {
    const SHORT: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const LONG: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let index = usize::from(month.saturating_sub(1)).min(11);
    if long {
        LONG[index]
    } else {
        SHORT[index]
    }
}

fn weekday_name(day: Option<u8>, long: bool) -> &'static str {
    const SHORT: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const LONG: [&str; 7] = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];
    let index = usize::from(day.unwrap_or(0)).min(6);
    if long {
        LONG[index]
    } else {
        SHORT[index]
    }
}

fn currency_from_directive(directive: &str) -> Option<&str> {
    let value = directive.strip_prefix('$')?;
    let symbol = value.split('-').next().unwrap_or("");
    (!symbol.is_empty()).then_some(symbol)
}

fn format_excel_number(value: f64, section: &str, raw: &str) -> (String, &'static str, bool) {
    if section.trim().eq_ignore_ascii_case("general") || section.trim() == "@" {
        return (raw.to_string(), "general", false);
    }
    let chars: Vec<char> = section.chars().collect();
    let Some((first_placeholder, last_placeholder)) = placeholder_bounds(&chars) else {
        let (literal, approximate) = decode_number_format_literal(&chars);
        return (literal.trim().to_string(), "literal", approximate);
    };
    let symbols = format_symbols(section);
    if symbols.contains('/') && symbols.contains('?') {
        return format_excel_fraction(value, section, &chars, first_placeholder, last_placeholder);
    }
    if symbols.contains("e+") || symbols.contains("e-") {
        return format_excel_scientific(value, section);
    }

    let percent_count = unquoted_character_count(section, '%');
    let mut numeric_value = value.abs() * 100f64.powi(percent_count as i32);
    let mut suffix_start = last_placeholder + 1;
    let mut scale_commas = 0usize;
    while chars.get(suffix_start) == Some(&',') {
        scale_commas += 1;
        suffix_start += 1;
    }
    numeric_value /= 1_000f64.powi(scale_commas as i32);

    let numeric_pattern = &chars[first_placeholder..=last_placeholder];
    let decimal_index = numeric_pattern
        .iter()
        .position(|character| *character == '.');
    let integer_pattern = &numeric_pattern[..decimal_index.unwrap_or(numeric_pattern.len())];
    let decimal_pattern = decimal_index
        .map(|index| &numeric_pattern[index + 1..])
        .unwrap_or(&[]);
    let mandatory_integer_digits = integer_pattern
        .iter()
        .filter(|character| **character == '0')
        .count();
    let minimum_decimals = decimal_pattern
        .iter()
        .filter(|character| **character == '0')
        .count();
    let maximum_decimals = decimal_pattern
        .iter()
        .filter(|character| matches!(**character, '0' | '#' | '?'))
        .count()
        .min(15);
    let grouping = integer_pattern.contains(&',');

    let rounded = format!("{numeric_value:.maximum_decimals$}");
    let (mut integer, mut decimals) = rounded
        .split_once('.')
        .map(|(integer, decimals)| (integer.to_string(), decimals.to_string()))
        .unwrap_or((rounded, String::new()));
    while decimals.len() > minimum_decimals && decimals.ends_with('0') {
        decimals.pop();
    }
    if mandatory_integer_digits == 0
        && integer == "0"
        && decimals.is_empty()
        && integer_pattern
            .iter()
            .all(|character| matches!(*character, '#' | '?' | ','))
    {
        integer.clear();
    } else if integer.len() < mandatory_integer_digits {
        integer = format!(
            "{}{}",
            "0".repeat(mandatory_integer_digits - integer.len()),
            integer
        );
    }
    if grouping && !integer.is_empty() {
        integer = group_decimal_digits(&integer);
    }
    let mut core = integer;
    if !decimals.is_empty() {
        core.push('.');
        core.push_str(&decimals);
    }

    let (prefix, prefix_approximate) = decode_number_format_literal(&chars[..first_placeholder]);
    let (suffix, suffix_approximate) = decode_number_format_literal(&chars[suffix_start..]);
    let contains_explicit_negative = prefix.contains('-')
        || suffix.contains('-')
        || (prefix.contains('(') && suffix.contains(')'));
    let sign = if value < 0.0 && !contains_explicit_negative {
        "-"
    } else {
        ""
    };
    let text = format!("{sign}{prefix}{core}{suffix}").trim().to_string();
    let kind = if percent_count > 0 || prefix.contains('%') || suffix.contains('%') {
        "percent"
    } else if contains_currency(&prefix) || contains_currency(&suffix) {
        "currency"
    } else {
        "number"
    };
    (
        text,
        kind,
        prefix_approximate || suffix_approximate || scale_commas > 0,
    )
}

fn placeholder_bounds(chars: &[char]) -> Option<(usize, usize)> {
    let mut quoted = false;
    let mut bracketed = false;
    let mut escaped = false;
    let mut first = None;
    let mut last = None;
    for (index, character) in chars.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' if !bracketed => quoted = !quoted,
            '[' if !quoted => bracketed = true,
            ']' if !quoted => bracketed = false,
            '0' | '#' | '?' if !quoted && !bracketed => {
                first.get_or_insert(index);
                last = Some(index);
            }
            _ => {}
        }
    }
    first.zip(last)
}

fn decode_number_format_literal(chars: &[char]) -> (String, bool) {
    let mut output = String::new();
    let mut approximate = false;
    let mut index = 0usize;
    while index < chars.len() {
        match chars[index] {
            '"' => {
                index += 1;
                while index < chars.len() && chars[index] != '"' {
                    output.push(chars[index]);
                    index += 1;
                }
                index += usize::from(index < chars.len());
            }
            '\\' => {
                index += 1;
                if let Some(character) = chars.get(index) {
                    output.push(*character);
                    index += 1;
                }
            }
            '_' => {
                output.push(' ');
                index = (index + 2).min(chars.len());
            }
            '*' => {
                approximate = true;
                index = (index + 2).min(chars.len());
            }
            '[' => {
                let end = chars[index + 1..]
                    .iter()
                    .position(|character| *character == ']')
                    .map(|offset| index + 1 + offset)
                    .unwrap_or(chars.len());
                let directive: String = chars[index + 1..end].iter().collect();
                if let Some(currency) = currency_from_directive(&directive) {
                    output.push_str(currency);
                } else {
                    approximate = true;
                }
                index = (end + 1).min(chars.len());
            }
            '0' | '#' | '?' | ',' | '.' => index += 1,
            character => {
                output.push(character);
                index += 1;
            }
        }
    }
    (output, approximate)
}

fn unquoted_character_count(code: &str, wanted: char) -> usize {
    let mut count = 0usize;
    let mut quoted = false;
    let mut bracketed = false;
    let mut escaped = false;
    for character in code.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' if !bracketed => quoted = !quoted,
            '[' if !quoted => bracketed = true,
            ']' if !quoted => bracketed = false,
            _ if character == wanted && !quoted && !bracketed => count += 1,
            _ => {}
        }
    }
    count
}

fn group_decimal_digits(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + value.len() / 3);
    for (index, character) in value.chars().enumerate() {
        if index > 0 && (value.len() - index).is_multiple_of(3) {
            output.push(',');
        }
        output.push(character);
    }
    output
}

fn contains_currency(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '$' | '€' | '£' | '¥' | '₩' | '₹' | '₽'))
}

fn format_excel_scientific(value: f64, section: &str) -> (String, &'static str, bool) {
    let lower = section.to_ascii_lowercase();
    let exponent_index = lower.find('e').unwrap_or(section.len());
    let mantissa = &section[..exponent_index];
    let decimals = mantissa
        .split_once('.')
        .map(|(_, fraction)| {
            fraction
                .chars()
                .filter(|character| matches!(character, '0' | '#' | '?'))
                .count()
        })
        .unwrap_or(0)
        .min(15);
    let exponent_digits = section[exponent_index.saturating_add(1)..]
        .chars()
        .filter(|character| *character == '0')
        .count()
        .max(1);
    let rendered = format!("{:.*E}", decimals, value);
    let (mantissa, exponent) = rendered.split_once('E').unwrap_or((&rendered, "0"));
    let exponent = exponent.parse::<i32>().unwrap_or(0);
    (
        format!(
            "{mantissa}E{}{:0width$}",
            if exponent < 0 { '-' } else { '+' },
            exponent.unsigned_abs(),
            width = exponent_digits
        ),
        "scientific",
        false,
    )
}

fn format_excel_fraction(
    value: f64,
    section: &str,
    chars: &[char],
    first_placeholder: usize,
    last_placeholder: usize,
) -> (String, &'static str, bool) {
    let slash = chars
        .iter()
        .position(|character| *character == '/')
        .unwrap_or(last_placeholder);
    let denominator_digits = chars[slash + 1..=last_placeholder]
        .iter()
        .filter(|character| matches!(**character, '0' | '#' | '?'))
        .count()
        .clamp(1, 3);
    let maximum_denominator = 10i64.pow(denominator_digits as u32) - 1;
    let absolute = value.abs();
    let whole = absolute.floor() as i64;
    let fraction = absolute - whole as f64;
    let mut best_numerator = 0i64;
    let mut best_denominator = 1i64;
    let mut best_error = f64::MAX;
    for denominator in 1..=maximum_denominator {
        let numerator = (fraction * denominator as f64).round() as i64;
        let error = (fraction - numerator as f64 / denominator as f64).abs();
        if error < best_error {
            best_error = error;
            best_numerator = numerator;
            best_denominator = denominator;
        }
    }
    let (prefix, prefix_approximate) = decode_number_format_literal(&chars[..first_placeholder]);
    let (suffix, suffix_approximate) = decode_number_format_literal(&chars[last_placeholder + 1..]);
    let sign = if value < 0.0 { "-" } else { "" };
    let core = if best_numerator == 0 {
        whole.to_string()
    } else if section[..section.find('/').unwrap_or(0)].contains(' ') {
        format!("{whole} {best_numerator}/{best_denominator}")
    } else {
        format!("{best_numerator}/{best_denominator}")
    };
    (
        format!("{sign}{prefix}{core}{suffix}").trim().to_string(),
        "fraction",
        prefix_approximate || suffix_approximate,
    )
}

fn xlsx_border_css(style: &str) -> (u8, &'static str) {
    match style {
        "medium" | "mediumDashed" | "mediumDashDot" | "mediumDashDotDot" => (2, "solid"),
        "thick" => (3, "solid"),
        "double" => (3, "double"),
        "dashed" | "dashDot" | "dashDotDot" | "slantDashDot" => (1, "dashed"),
        "dotted" | "hair" => (1, "dotted"),
        _ => (1, "solid"),
    }
}

fn xlsx_rgb(element: &BytesStart<'_>) -> Option<String> {
    let rgb = attribute(element, "rgb")?;
    let value = if rgb.len() == 8 { &rgb[2..] } else { &rgb };
    (value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn xlsx_on_off(element: &BytesStart<'_>) -> bool {
    !attribute(element, "val").is_some_and(|value| matches!(value.as_str(), "0" | "false"))
}

fn safe_css_font(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_alphanumeric() || " -_,.'".contains(character)))
    .then_some(value)
}

fn xlsx_horizontal(value: &str) -> Option<&'static str> {
    match value {
        "left" | "general" | "fill" => Some("left"),
        "center" | "centerContinuous" => Some("center"),
        "right" => Some("right"),
        "justify" | "distributed" => Some("justify"),
        _ => None,
    }
}

fn xlsx_vertical(value: &str) -> Option<&'static str> {
    match value {
        "top" => Some("top"),
        "center" => Some("middle"),
        "bottom" | "justify" | "distributed" => Some("bottom"),
        _ => None,
    }
}

fn snapshot_xlsx_source(
    source: &Path,
    expected: Option<(&str, u64)>,
) -> Result<(tempfile::TempDir, PathBuf, String, u64), HcdError> {
    let (source_hash, source_size) = source_identity(source, "xlsx")?;
    if expected.is_some_and(|(hash, size)| hash != source_hash || size != source_size) {
        return Err(HcdError::InvalidPatch("XLSX_SOURCE_CHANGED".into()));
    }
    let snapshot_dir = tempfile::tempdir()?;
    let snapshot = snapshot_dir.path().join("source.xlsx");
    let mut input = File::open(source)?.take(source_size + 1);
    let mut output_file = File::create(&snapshot)?;
    let copied = std::io::copy(&mut input, &mut output_file)?;
    drop(output_file);
    let (snapshot_hash, snapshot_size) = source_identity(&snapshot, "xlsx")?;
    if copied != source_size || snapshot_size != source_size || snapshot_hash != source_hash {
        return Err(HcdError::InvalidPatch("XLSX_SOURCE_CHANGED".into()));
    }
    Ok((snapshot_dir, snapshot, source_hash, source_size))
}

pub(crate) fn import_xlsx<F>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    mut emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    // A private copy makes the bytes hashed here the bytes parsed below.
    let (_snapshot_dir, snapshot, source_hash, source_size) = snapshot_xlsx_source(source, None)
        .map_err(|error| match error {
            HcdError::InvalidPatch(reason) if reason == "XLSX_SOURCE_CHANGED" => {
                HcdError::InvalidBundle("XLSX source changed during import".into())
            }
            other => other,
        })?;
    emit_started(&mut emit, options, &source_hash)?;
    let result = import_xlsx_inner(
        &snapshot,
        source,
        output,
        options,
        source_hash,
        source_size,
        &mut emit,
    );
    if let Err(error) = &result {
        emit_failed(&mut emit, options, error);
    }
    result
}

fn import_xlsx_inner<F>(
    snapshot: &Path,
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    source_hash: String,
    source_size: u64,
    emit: &mut F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let mut archive = StreamingOxmlArchive::open(snapshot).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let scratch = tempfile::tempdir()?;
    let mut shared_strings = SharedStringStore::build(&mut archive, scratch.path())?;
    let (rendered_styles, style_catalog) = render_xlsx_styles(&mut archive)?;
    let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
    writer.write_styles(&rendered_styles)?;
    let mut format_stats = XlsxFormatStats::default();
    let mut protected_sheet_count = 0usize;

    for sheet in &workbook.sheets {
        let WorksheetScan {
            mut merged_ranges,
            mut formula_ranges,
            view,
            protected,
        } = archive
            .with_part(&sheet.part, |source| {
                scan_worksheet_metadata(source, &sheet.part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if protected {
            protected_sheet_count += 1;
        }
        let mut chunks = SheetChunkWriter::new(
            &options.document_id,
            sheet,
            options,
            &view,
            &mut writer,
            emit,
        );
        archive
            .with_part(&sheet.part, |source| {
                parse_worksheet(
                    source,
                    &options.document_id,
                    sheet,
                    &mut shared_strings,
                    &mut merged_ranges,
                    &mut formula_ranges,
                    protected,
                    &style_catalog,
                    workbook.date_1904,
                    &mut format_stats,
                    &mut chunks,
                )
                .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        chunks.finish()?;
        format_stats.skipped_blank_cells = format_stats
            .skipped_blank_cells
            .saturating_add(chunks.compacted_blank_cells);
    }

    // Worksheet text is the progressive primary representation. Media is
    // content-addressed afterwards so a workbook with large drawings does not
    // delay every sheet chunk even though drawings remain read-only in hcd/1.
    let mut assets = import_assets(&mut archive, &writer, emit)?;
    let drawing_image_count = import_sheet_drawing_images(
        &mut archive,
        &workbook.sheets,
        &assets,
        &options.document_id,
        &mut writer,
        emit,
    )?;
    let (drawing_chart_count, chart_assets) = import_sheet_drawing_charts(
        &mut archive,
        &workbook.sheets,
        &mut shared_strings,
        &options.document_id,
        &mut writer,
        emit,
    )?;
    assets.extend(chart_assets);
    std::fs::write(
        writer.root().join("assets/index.json"),
        serde_json::to_vec(&assets)?,
    )?;

    // The archive is read progressively, after its source identity was
    // captured. Do not publish a manifest tying those results to a source
    // which was replaced or changed during import.
    let (final_hash, final_size) = source_identity(source, "xlsx")?;
    if final_hash != source_hash || final_size != source_size {
        return Err(HcdError::InvalidBundle(
            "XLSX source changed during import".into(),
        ));
    }

    let mut manifest = base_manifest(options, "xlsx", "grid", source_hash, source_size);
    manifest.warnings.push(FidelityWarning {
        code: "XLSX_ADVANCED_VISUALS_EXTERNAL".to_string(),
        message: "HCD materializes worksheet view/frozen-pane metadata, merged ranges, direct cell styles, row/column dimensions, common numeric display formats, worksheet pictures and bounded chart series from caches or worksheet references; conditional formatting, shapes and unsupported drawing types remain authoritative in the immutable source".to_string(),
        node_id: None,
        source_part: Some("xl/styles.xml".to_string()),
    });
    if protected_sheet_count > 0 {
        manifest.warnings.push(FidelityWarning {
            code: "XLSX_PROTECTED_SHEET_READ_ONLY".to_string(),
            message: format!("{protected_sheet_count} protected worksheets were imported read-only; unlocked cells are not yet distinguished"),
            node_id: None,
            source_part: None,
        });
    }
    if format_stats.approximate_cells > 0 {
        manifest.warnings.push(FidelityWarning {
            code: "XLSX_NUMFMT_PARTIAL".to_string(),
            message: format!(
                "{} cells use locale-dependent, conditional or advanced number-format tokens and were rendered best-effort",
                format_stats.approximate_cells
            ),
            node_id: None,
            source_part: Some("xl/styles.xml".to_string()),
        });
    }
    if format_stats.skipped_blank_cells > 0 {
        manifest.warnings.push(FidelityWarning {
            code: "XLSX_STORED_BLANK_MAPPING_LIMIT".to_string(),
            message: format!("{} stored blank cells were not made editable to keep worksheet fragments within size limits and leave room for edits; original cells remain in the source file", format_stats.skipped_blank_cells),
            node_id: None,
            source_part: None,
        });
    }
    manifest.fidelity = Some(FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: FidelityLevel::Semantic,
        preserved: vec![
            "worksheet order, cell addresses, stored values and formulas".to_string(),
            "direct cell fonts, fills, borders, alignment, row height and column width"
                .to_string(),
            "merged cell ranges as bounded HTML rowspans and colspans".to_string(),
            format!(
                "{drawing_image_count} worksheet pictures with stable visual node IDs and complete OOXML anchor metadata including cell markers, offsets and extents"
            ),
            format!(
                "{drawing_chart_count} worksheet charts rendered from cached series or bounded worksheet references with stable visual node IDs and complete OOXML anchor metadata including cell markers, offsets and extents"
            ),
            "worksheet view metadata including frozen/split panes, RTL, grid/header/zero/formula flags, zoom and initial visible cells"
                .to_string(),
            format!(
                "{} numeric cells rendered with common built-in or custom number/date/percent/currency formats, including the workbook 1900/1904 date system",
                format_stats.formatted_cells
            ),
            "opaque workbook parts and media in the immutable source".to_string(),
        ],
        flattened: vec![
            "locale-dependent, conditional and advanced number formats are best-effort; chart theme/effects, conditional formatting and shapes are not fully materialized; the static HTML fallback uses approximate drawing geometry while grid-canvas clients can reconstruct anchors from exact offsets and worksheet dimensions".to_string(),
            "showFormulas is preserved as view metadata, while HCD text continues to display cached cell values and formula expressions remain read-only"
                .to_string(),
        ],
        dropped: Vec::new(),
        warnings: manifest.warnings.clone(),
    });
    finish_import(writer, manifest, emit)
}

fn import_assets<F>(
    archive: &mut StreamingOxmlArchive,
    writer: &BundleWriter,
    emit: &mut F,
) -> Result<Vec<AssetRecord>, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let parts: Vec<String> = archive
        .entries()
        .iter()
        .filter(|entry| !entry.is_dir && entry.name.starts_with("xl/media/"))
        .map(|entry| entry.name.clone())
        .collect();
    let mut assets = Vec::new();
    for part in parts {
        let extension = Path::new(&part)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let (href, hash, byte_length) = archive
            .with_part(&part, |source| {
                writer
                    .write_asset_from_reader(extension, source)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        emit(&ImportEvent::AssetReady {
            hash: hash.clone(),
            href: href.clone(),
            byte_length,
        })?;
        assets.push(AssetRecord {
            source_part: part,
            hash,
            href,
            byte_length,
        });
    }
    Ok(assets)
}

fn import_sheet_drawing_images<F>(
    archive: &mut StreamingOxmlArchive,
    sheets: &[SheetPart],
    assets: &[AssetRecord],
    document_id: &str,
    writer: &mut BundleWriter,
    emit: &mut F,
) -> Result<usize, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let assets_by_part: HashMap<String, AssetRecord> = assets
        .iter()
        .map(|asset| (asset.source_part.clone(), asset.clone()))
        .collect();
    let mut pictures = Vec::new();
    for sheet in sheets {
        let mut drawing_parts = worksheet_drawing_parts(archive, &sheet.part)?;
        drawing_parts.sort();
        drawing_parts.dedup();
        for drawing_part in drawing_parts {
            let relationships =
                drawing_image_relationships(archive, &drawing_part, &assets_by_part)?;
            if relationships.is_empty() || !archive.contains(&drawing_part) {
                continue;
            }
            let remaining = MAX_DRAWING_IMAGES.saturating_sub(pictures.len());
            if remaining == 0 {
                return Err(HcdError::ResourceLimit(format!(
                    "XLSX exceeds {MAX_DRAWING_IMAGES} worksheet pictures"
                )));
            }
            let mut parsed = archive
                .with_part(&drawing_part, |source| {
                    parse_drawing_pictures(
                        source,
                        &sheet.name,
                        &sheet.part,
                        &drawing_part,
                        &relationships,
                        remaining,
                    )
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
                })
                .map_err(package_error)?;
            pictures.append(&mut parsed);
        }
    }

    let mut sheet_picture_counts = HashMap::<String, usize>::new();
    for picture in &pictures {
        let sheet = sheets
            .iter()
            .find(|sheet| sheet.part == picture.sheet_part)
            .ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "drawing {} references unknown worksheet {}",
                    picture.drawing_part, picture.sheet_part
                ))
            })?;
        let identity = picture
            .anchor
            .picture_id
            .clone()
            .unwrap_or_else(|| picture.ordinal.to_string());
        let node_id = stable_node_id(&[
            document_id,
            &picture.sheet_part,
            &picture.drawing_part,
            "picture",
            &identity,
        ]);
        let chunk_id = stable_node_id(&[
            document_id,
            &picture.drawing_part,
            "picture-chunk",
            &identity,
        ])
        .replacen("n_", "c_", 1);
        let (x, y, width, height) = drawing_geometry(&picture.anchor);
        let geometry = hcd_core::ImageGeometry {
            x: x as f64,
            y: y as f64,
            width: width as f64,
            height: height as f64,
            unit: hcd_core::ImageGeometryUnit::Emu,
        };
        let node_hash = hash_bytes(b"");
        let visual_hash = hcd_core::image_visual_hash(Some(&picture.asset.hash), Some(&geometry));
        let source_path = picture
            .anchor
            .picture_id
            .as_deref()
            .map(|id| format!("/picture[@id={}]", escape_attribute(id)))
            .unwrap_or_else(|| format!("/picture[{}]", picture.ordinal));
        let from_cell = drawing_cell(picture.anchor.from_col, picture.anchor.from_row);
        let to_cell = drawing_cell(picture.anchor.to_col, picture.anchor.to_row);
        let mut attributes = format!(
            " data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-visual-hash=\"{visual_hash}\" data-hcd-asset-hash=\"{}\" data-hcd-node-kind=\"image\" data-hcd-editable=\"true\" data-hcd-source-part=\"{}\" data-hcd-source-path=\"{source_path}\" data-hcd-drawing-part=\"{}\" data-hcd-anchor-kind=\"{}\" data-hcd-x=\"{x}\" data-hcd-y=\"{y}\" data-hcd-width=\"{width}\" data-hcd-height=\"{height}\" data-hcd-geometry-unit=\"emu\" data-hcd-x-emu=\"{x}\" data-hcd-y-emu=\"{y}\" data-hcd-width-emu=\"{width}\" data-hcd-height-emu=\"{height}\"",
            picture.asset.hash,
            escape_attribute(&picture.sheet_part),
            escape_attribute(&picture.drawing_part),
            escape_attribute(&picture.anchor.kind),
        );
        push_data_attribute(
            &mut attributes,
            "data-hcd-anchor-from",
            from_cell.as_deref(),
        );
        push_data_attribute(&mut attributes, "data-hcd-anchor-to", to_cell.as_deref());
        append_drawing_anchor_attributes(&mut attributes, &picture.anchor);
        push_data_attribute(
            &mut attributes,
            "data-hcd-picture-id",
            picture.anchor.picture_id.as_deref(),
        );
        push_data_attribute(
            &mut attributes,
            "data-hcd-picture-name",
            picture.anchor.name.as_deref(),
        );
        let alt = picture
            .anchor
            .description
            .as_deref()
            .or(picture.anchor.name.as_deref())
            .unwrap_or("");
        let canvas_width = x.saturating_add(width).max(DEFAULT_COLUMN_WIDTH_EMU);
        let canvas_height = y.saturating_add(height).max(DEFAULT_ROW_HEIGHT_EMU);
        let html = format!(
            "<section class=\"hcd-sheet-drawing-layer\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\" style=\"width:{:.2}px;height:{:.2}px\"><div class=\"hcd-sheet-picture\"{attributes} style=\"left:{:.2}px;top:{:.2}px;width:{:.2}px;height:{:.2}px\"><img src=\"asset://sha256/{}\" data-hcd-asset-href=\"{}\" alt=\"{}\"/></div></section>",
            escape_attribute(&picture.sheet_name),
            sheet.index,
            sheet.state,
            emu_to_px(canvas_width),
            emu_to_px(canvas_height),
            emu_to_px(x),
            emu_to_px(y),
            emu_to_px(width),
            emu_to_px(height),
            picture.asset.hash,
            escape_attribute(&picture.asset.href),
            escape_attribute(alt),
        );
        let count = sheet_picture_counts
            .entry(picture.sheet_part.clone())
            .or_default();
        let descriptor = writer.write_grid_chunk(
            chunk_id,
            html,
            ChunkSourceMap {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                chunk_id: stable_node_id(&[
                    document_id,
                    &picture.drawing_part,
                    "picture-chunk",
                    &identity,
                ])
                .replacen("n_", "c_", 1),
                entries: vec![NodeMapEntry {
                    node_id,
                    node_hash,
                    source: SourceAnchor {
                        part: picture.drawing_part.clone(),
                        text_ordinal: picture.ordinal,
                        paragraph_id: Some(source_path),
                        text_id: Some(picture.asset.source_part.clone()),
                        node_kind: "image".to_string(),
                        editable: true,
                    },
                }],
            },
            1,
            *count > 0,
            drawing_grid_address(document_id, sheet, &picture.anchor, GridChunkKind::Picture),
        )?;
        *count += 1;
        emit(&ImportEvent::ChunkReady { descriptor })?;
    }
    Ok(pictures.len())
}

fn import_sheet_drawing_charts<F>(
    archive: &mut StreamingOxmlArchive,
    sheets: &[SheetPart],
    shared_strings: &mut SharedStringStore,
    document_id: &str,
    writer: &mut BundleWriter,
    emit: &mut F,
) -> Result<(usize, Vec<AssetRecord>), HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let mut charts = Vec::new();
    for sheet in sheets {
        let mut drawing_parts = worksheet_drawing_parts(archive, &sheet.part)?;
        drawing_parts.sort();
        drawing_parts.dedup();
        for drawing_part in drawing_parts {
            let relationships = drawing_chart_relationships(archive, &drawing_part)?;
            if relationships.is_empty() || !archive.contains(&drawing_part) {
                continue;
            }
            let remaining = MAX_DRAWING_CHARTS.saturating_sub(charts.len());
            let mut parsed = archive
                .with_part(&drawing_part, |source| {
                    parse_drawing_charts(
                        source,
                        &sheet.name,
                        &sheet.part,
                        &drawing_part,
                        &relationships,
                        remaining,
                    )
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
                })
                .map_err(package_error)?;
            charts.append(&mut parsed);
        }
    }

    let mut chart_assets = Vec::new();
    let mut sheet_chart_counts = HashMap::<String, usize>::new();
    for chart in &charts {
        let sheet = sheets
            .iter()
            .find(|sheet| sheet.part == chart.sheet_part)
            .ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "drawing {} references unknown worksheet {}",
                    chart.drawing_part, chart.sheet_part
                ))
            })?;
        let chart_xml = archive
            .read_control_part(&chart.chart_part, MAX_CONTROL_BYTES)
            .map_err(package_error)?;
        let chart_xml = std::str::from_utf8(&chart_xml).map_err(|error| {
            HcdError::InvalidBundle(format!("chart {} is not UTF-8: {error}", chart.chart_part))
        })?;
        let mut preview = oxml::chart_preview::parse_chart_preview(chart_xml).map_err(|error| {
            HcdError::InvalidBundle(format!(
                "cannot render cached chart {}: {error}",
                chart.chart_part
            ))
        })?;
        hydrate_chart_preview(
            archive,
            sheets,
            &chart.sheet_name,
            shared_strings,
            &mut preview,
        )?;
        let svg = oxml::chart_preview::render_preview_svg(&preview);
        let (href, asset_hash, byte_length) =
            writer.write_asset_from_reader("svg", &mut Cursor::new(svg.as_bytes()))?;
        emit(&ImportEvent::AssetReady {
            hash: asset_hash.clone(),
            href: href.clone(),
            byte_length,
        })?;
        chart_assets.push(AssetRecord {
            source_part: chart.chart_part.clone(),
            hash: asset_hash.clone(),
            href: href.clone(),
            byte_length,
        });

        let identity = chart
            .anchor
            .picture_id
            .clone()
            .unwrap_or_else(|| chart.ordinal.to_string());
        let node_id = stable_node_id(&[
            document_id,
            &chart.sheet_part,
            &chart.drawing_part,
            "chart",
            &identity,
        ]);
        let chunk_id =
            stable_node_id(&[document_id, &chart.drawing_part, "chart-chunk", &identity])
                .replacen("n_", "c_", 1);
        // HCD node hashes cover editable/textual node content. The chart is a
        // read-only visual node whose element text is empty, while the source
        // chart hash is retained separately as a preflight/fidelity signal.
        let node_hash = hash_bytes(b"");
        let source_hash = hash_bytes(chart_xml.as_bytes());
        let (x, y, width, height) = drawing_geometry(&chart.anchor);
        let source_path = format!("/chart[{}]", chart.ordinal);
        let from_cell = drawing_cell(chart.anchor.from_col, chart.anchor.from_row);
        let to_cell = drawing_cell(chart.anchor.to_col, chart.anchor.to_row);
        let mut attributes = format!(
            " data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{node_hash}\" data-hcd-source-hash=\"{source_hash}\" data-hcd-node-kind=\"chart\" data-hcd-editable=\"false\" data-hcd-source-part=\"{}\" data-hcd-source-path=\"{source_path}\" data-hcd-drawing-part=\"{}\" data-hcd-chart-part=\"{}\" data-hcd-anchor-kind=\"{}\" data-hcd-x-emu=\"{x}\" data-hcd-y-emu=\"{y}\" data-hcd-width-emu=\"{width}\" data-hcd-height-emu=\"{height}\"",
            escape_attribute(&chart.chart_part),
            escape_attribute(&chart.drawing_part),
            escape_attribute(&chart.chart_part),
            escape_attribute(&chart.anchor.kind),
        );
        push_data_attribute(
            &mut attributes,
            "data-hcd-anchor-from",
            from_cell.as_deref(),
        );
        push_data_attribute(&mut attributes, "data-hcd-anchor-to", to_cell.as_deref());
        append_drawing_anchor_attributes(&mut attributes, &chart.anchor);
        push_data_attribute(
            &mut attributes,
            "data-hcd-chart-id",
            chart.anchor.picture_id.as_deref(),
        );
        push_data_attribute(
            &mut attributes,
            "data-hcd-chart-name",
            chart.anchor.name.as_deref(),
        );
        let alt = chart.anchor.name.as_deref().unwrap_or("Worksheet chart");
        let canvas_width = x.saturating_add(width).max(DEFAULT_COLUMN_WIDTH_EMU);
        let canvas_height = y.saturating_add(height).max(DEFAULT_ROW_HEIGHT_EMU);
        let html = format!(
            "<section class=\"hcd-sheet-drawing-layer\" data-hcd-sheet=\"{}\" data-hcd-sheet-index=\"{}\" data-hcd-sheet-state=\"{}\" style=\"width:{:.2}px;height:{:.2}px\"><div class=\"hcd-sheet-chart\"{attributes} style=\"left:{:.2}px;top:{:.2}px;width:{:.2}px;height:{:.2}px\"><img src=\"asset://sha256/{asset_hash}\" data-hcd-asset-href=\"{}\" alt=\"{}\"/></div></section>",
            escape_attribute(&chart.sheet_name),
            sheet.index,
            sheet.state,
            emu_to_px(canvas_width),
            emu_to_px(canvas_height),
            emu_to_px(x),
            emu_to_px(y),
            emu_to_px(width),
            emu_to_px(height),
            escape_attribute(&href),
            escape_attribute(alt),
        );
        let map = ChunkSourceMap {
            schema_version: HCD_SCHEMA_VERSION.to_string(),
            chunk_id: chunk_id.clone(),
            entries: vec![NodeMapEntry {
                node_id,
                node_hash,
                source: SourceAnchor {
                    part: chart.chart_part.clone(),
                    text_ordinal: chart.ordinal,
                    paragraph_id: Some(chart.drawing_part.clone()),
                    text_id: chart.anchor.picture_id.clone(),
                    node_kind: "chart".to_string(),
                    editable: false,
                },
            }],
        };
        let count = sheet_chart_counts
            .entry(chart.sheet_part.clone())
            .or_default();
        let descriptor = writer.write_grid_chunk(
            chunk_id,
            html,
            map,
            1,
            *count > 0,
            drawing_grid_address(document_id, sheet, &chart.anchor, GridChunkKind::Chart),
        )?;
        *count += 1;
        emit(&ImportEvent::ChunkReady { descriptor })?;
    }
    Ok((charts.len(), chart_assets))
}

fn hydrate_chart_preview(
    archive: &mut StreamingOxmlArchive,
    sheets: &[SheetPart],
    default_sheet_name: &str,
    shared_strings: &mut SharedStringStore,
    preview: &mut oxml::chart_preview::ChartPreview,
) -> Result<(), HcdError> {
    let mut requests = Vec::new();
    for (series_index, series) in preview.series.iter().enumerate() {
        if series.name.starts_with("Series ") {
            push_chart_range_request(
                &mut requests,
                sheets,
                default_sheet_name,
                series_index,
                ChartSeriesField::Name,
                series.name_formula.as_deref(),
            );
        }
        if series.categories.is_empty() {
            push_chart_range_request(
                &mut requests,
                sheets,
                default_sheet_name,
                series_index,
                ChartSeriesField::Categories,
                series.categories_formula.as_deref(),
            );
        }
        if series.x_values.is_empty() {
            push_chart_range_request(
                &mut requests,
                sheets,
                default_sheet_name,
                series_index,
                ChartSeriesField::XValues,
                series.x_values_formula.as_deref(),
            );
        }
        if series.values.is_empty() {
            push_chart_range_request(
                &mut requests,
                sheets,
                default_sheet_name,
                series_index,
                ChartSeriesField::Values,
                series.values_formula.as_deref(),
            );
        }
        if series.bubble_sizes.is_empty() {
            push_chart_range_request(
                &mut requests,
                sheets,
                default_sheet_name,
                series_index,
                ChartSeriesField::BubbleSizes,
                series.bubble_sizes_formula.as_deref(),
            );
        }
    }
    if requests.is_empty() {
        return Ok(());
    }

    let parts = requests
        .iter()
        .map(|request| request.sheet_part.clone())
        .collect::<BTreeSet<_>>();
    for part in parts {
        archive
            .with_part(&part, |source| {
                scan_chart_reference_cells(source, &part, shared_strings, &mut requests)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
    }

    for request in requests {
        let Some(series) = preview.series.get_mut(request.series_index) else {
            continue;
        };
        if !request.values.iter().any(Option::is_some) {
            continue;
        }
        let text_values = request
            .values
            .into_iter()
            .map(Option::unwrap_or_default)
            .collect::<Vec<_>>();
        match request.field {
            ChartSeriesField::Name => {
                if let Some(name) = text_values.into_iter().find(|value| !value.is_empty()) {
                    series.name = name;
                }
            }
            ChartSeriesField::Categories => series.categories = text_values,
            ChartSeriesField::XValues => {
                series.x_values = chart_numeric_values(text_values);
            }
            ChartSeriesField::Values => {
                series.values = chart_numeric_values(text_values);
            }
            ChartSeriesField::BubbleSizes => {
                series.bubble_sizes = chart_numeric_values(text_values);
            }
        }
    }
    Ok(())
}

fn push_chart_range_request(
    requests: &mut Vec<ChartRangeRequest>,
    sheets: &[SheetPart],
    default_sheet_name: &str,
    series_index: usize,
    field: ChartSeriesField,
    formula: Option<&str>,
) {
    let Some(formula) = formula else {
        return;
    };
    let Some((sheet_part, range)) =
        parse_chart_formula_reference(formula, sheets, default_sheet_name)
    else {
        return;
    };
    let rows = u64::from(range.end_row - range.start_row + 1);
    let columns = u64::from(range.end_col - range.start_col + 1);
    let Some(point_count) = rows.checked_mul(columns) else {
        return;
    };
    if point_count == 0 || point_count > MAX_CHART_REFERENCE_POINTS as u64 {
        return;
    }
    requests.push(ChartRangeRequest {
        series_index,
        field,
        sheet_part,
        range,
        values: vec![None; point_count as usize],
    });
}

fn parse_chart_formula_reference(
    formula: &str,
    sheets: &[SheetPart],
    default_sheet_name: &str,
) -> Option<(String, MergeRange)> {
    let formula = formula.trim().strip_prefix('=').unwrap_or(formula.trim());
    let (sheet_name, reference) = if let Some((sheet, reference)) = formula.rsplit_once('!') {
        let sheet = sheet.trim();
        if sheet.contains('[') || sheet.contains(']') {
            return None;
        }
        let decoded = if sheet.starts_with('\'') && sheet.ends_with('\'') && sheet.len() >= 2 {
            sheet[1..sheet.len() - 1].replace("''", "'")
        } else {
            sheet.to_string()
        };
        if decoded.contains(':') {
            return None;
        }
        (decoded, reference)
    } else {
        (default_sheet_name.to_string(), formula)
    };
    let sheet = sheets.iter().find(|sheet| sheet.name == sheet_name)?;
    let reference = reference.trim();
    let range = if reference.contains(':') {
        parse_merge_reference(reference)?
    } else {
        let (row, column) = cell_coordinates(reference)?;
        MergeRange {
            start_row: row,
            end_row: row,
            start_col: column,
            end_col: column,
        }
    };
    Some((sheet.part.clone(), range))
}

fn scan_chart_reference_cells(
    source: &mut dyn Read,
    worksheet_part: &str,
    shared_strings: &mut SharedStringStore,
    requests: &mut [ChartRangeRequest],
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut cell: Option<CellBuilder> = None;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("worksheet {worksheet_part} XML: {error}"))
        })?;
        budget.observe(&event, worksheet_part)?;
        match event {
            Event::Start(ref start) if local_name(start.name().as_ref()) == "c" => {
                cell = Some(CellBuilder {
                    reference: attribute(start, "r").unwrap_or_default(),
                    value_type: attribute(start, "t").unwrap_or_default(),
                    ..Default::default()
                });
            }
            Event::Empty(ref start) if local_name(start.name().as_ref()) == "c" => {
                let finished = CellBuilder {
                    reference: attribute(start, "r").unwrap_or_default(),
                    value_type: attribute(start, "t").unwrap_or_default(),
                    ..Default::default()
                };
                record_chart_reference_cell(worksheet_part, finished, shared_strings, requests)?;
            }
            Event::Start(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "v" =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::Value;
            }
            Event::Start(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "t" =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::InlineText;
            }
            Event::Text(text) if cell.is_some() => {
                let decoded = text.unescape().map_err(|error| {
                    HcdError::InvalidBundle(format!("worksheet chart text: {error}"))
                })?;
                let cell = cell.as_mut().expect("checked cell");
                match cell.capture {
                    Capture::Value => cell.value.push_str(&decoded),
                    Capture::InlineText => cell.inline_text.push_str(&decoded),
                    Capture::None => {}
                }
                if cell.value.len().max(cell.inline_text.len()) > MAX_CHUNK_BYTES {
                    return Err(HcdError::ResourceLimit(format!(
                        "NODE_TOO_LARGE: chart source cell {} exceeds 2 MiB",
                        cell.reference
                    )));
                }
            }
            Event::End(ref end)
                if cell.is_some() && matches!(local_name(end.name().as_ref()), "v" | "t") =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::None;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "c" => {
                record_chart_reference_cell(
                    worksheet_part,
                    cell.take().unwrap_or_default(),
                    shared_strings,
                    requests,
                )?;
            }
            Event::Eof => {
                budget.finish(worksheet_part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(())
}

fn record_chart_reference_cell(
    worksheet_part: &str,
    cell: CellBuilder,
    shared_strings: &mut SharedStringStore,
    requests: &mut [ChartRangeRequest],
) -> Result<(), HcdError> {
    let Some((row, column)) = cell_coordinates(&cell.reference) else {
        return Ok(());
    };
    if !requests.iter().any(|request| {
        request.sheet_part == worksheet_part
            && row >= request.range.start_row
            && row <= request.range.end_row
            && column >= request.range.start_col
            && column <= request.range.end_col
    }) {
        return Ok(());
    }
    let value = match cell.value_type.as_str() {
        "s" => shared_strings.get(cell.value.parse().map_err(|_| {
            HcdError::InvalidBundle(format!(
                "invalid shared string index in chart source cell {}",
                cell.reference
            ))
        })?)?,
        "inlineStr" => cell.inline_text,
        "b" => match cell.value.as_str() {
            "1" => "TRUE".to_string(),
            "0" => "FALSE".to_string(),
            _ => cell.value,
        },
        _ => cell.value,
    };
    for request in requests.iter_mut().filter(|request| {
        request.sheet_part == worksheet_part
            && row >= request.range.start_row
            && row <= request.range.end_row
            && column >= request.range.start_col
            && column <= request.range.end_col
    }) {
        let width = request.range.end_col - request.range.start_col + 1;
        let index = (row - request.range.start_row) * width + column - request.range.start_col;
        if let Some(slot) = request.values.get_mut(index as usize) {
            *slot = Some(value.clone());
        }
    }
    Ok(())
}

fn chart_numeric_values(values: Vec<String>) -> Vec<f64> {
    values
        .into_iter()
        .filter_map(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .take(MAX_CHART_REFERENCE_POINTS)
        .collect()
}

fn drawing_chart_relationships(
    archive: &mut StreamingOxmlArchive,
    drawing_part: &str,
) -> Result<HashMap<String, String>, HcdError> {
    let relationships_part = relationships_part_path(drawing_part)?;
    if !archive.contains(&relationships_part) {
        return Ok(HashMap::new());
    }
    let xml = archive
        .read_control_part(&relationships_part, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut output = HashMap::new();
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("drawing relationships XML: {error}"))
        })?;
        budget.observe(&event, &relationships_part)?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "Relationship" =>
            {
                let chart = attribute(element, "Type").is_some_and(|kind| {
                    let kind = kind.to_ascii_lowercase();
                    kind.ends_with("/chart") || kind.ends_with("/chartex")
                });
                let external = attribute(element, "TargetMode")
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
                if chart && !external {
                    if let (Some(id), Some(target)) =
                        (attribute(element, "Id"), attribute(element, "Target"))
                    {
                        output.insert(id, resolve_part(drawing_part, &target)?);
                    }
                }
            }
            Event::Eof => {
                budget.finish(&relationships_part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(output)
}

fn parse_drawing_charts(
    source: &mut dyn Read,
    sheet_name: &str,
    sheet_part: &str,
    drawing_part: &str,
    relationships: &HashMap<String, String>,
    maximum: usize,
) -> Result<Vec<XlsxDrawingChart>, HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut charts = Vec::new();
    let mut anchor: Option<XlsxDrawingAnchor> = None;
    let mut marker = None;
    let mut capture: Option<(&'static str, String)> = None;
    let mut in_chart = false;
    let mut ordinal = 0u64;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("drawing {drawing_part} XML: {error}"))
        })?;
        budget.observe(&event, drawing_part)?;
        match event {
            Event::Start(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        anchor = Some(XlsxDrawingAnchor {
                            kind: match name {
                                "twoCellAnchor" => "two-cell",
                                "oneCellAnchor" => "one-cell",
                                _ => "absolute",
                            }
                            .to_string(),
                            ..XlsxDrawingAnchor::default()
                        });
                    }
                    "from" if anchor.is_some() => marker = Some(DrawingMarker::From),
                    "to" if anchor.is_some() => marker = Some(DrawingMarker::To),
                    "col" | "row" | "colOff" | "rowOff" if marker.is_some() => {
                        capture = Some((
                            match name {
                                "col" => "col",
                                "row" => "row",
                                "colOff" => "colOff",
                                _ => "rowOff",
                            },
                            String::new(),
                        ));
                    }
                    "graphicFrame" if anchor.is_some() => in_chart = true,
                    "cNvPr" if in_chart => capture_picture_metadata(element, anchor.as_mut()),
                    "chart" if in_chart => {
                        if let Some(anchor) = anchor.as_mut() {
                            anchor.relationship_id = attribute(element, "id");
                        }
                    }
                    "pos" if anchor.is_some() => capture_anchor_position(element, anchor.as_mut()),
                    "ext" if anchor.is_some() => capture_anchor_extent(element, anchor.as_mut()),
                    _ => {}
                }
            }
            Event::Empty(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "cNvPr" if in_chart => capture_picture_metadata(element, anchor.as_mut()),
                    "chart" if in_chart => {
                        if let Some(anchor) = anchor.as_mut() {
                            anchor.relationship_id = attribute(element, "id");
                        }
                    }
                    "pos" if anchor.is_some() => capture_anchor_position(element, anchor.as_mut()),
                    "ext" if anchor.is_some() => capture_anchor_extent(element, anchor.as_mut()),
                    _ => {}
                }
            }
            Event::Text(ref text) => {
                if let Some((_, value)) = &mut capture {
                    let decoded = text.unescape().map_err(|error| {
                        HcdError::InvalidBundle(format!(
                            "drawing {drawing_part} anchor text: {error}"
                        ))
                    })?;
                    value.push_str(&decoded);
                }
            }
            Event::End(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "col" | "row" | "colOff" | "rowOff" => {
                        if let Some((field, value)) = capture.take() {
                            apply_anchor_marker(anchor.as_mut(), marker, field, &value);
                        }
                    }
                    "from" | "to" => marker = None,
                    "graphicFrame" => in_chart = false,
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        let finished = anchor.take().ok_or_else(|| {
                            HcdError::InvalidBundle(format!(
                                "drawing {drawing_part} closes an anchor without opening it"
                            ))
                        })?;
                        if let Some(chart_part) = finished
                            .relationship_id
                            .as_ref()
                            .and_then(|id| relationships.get(id))
                        {
                            if charts.len() >= maximum {
                                return Err(HcdError::ResourceLimit(format!(
                                    "XLSX exceeds {MAX_DRAWING_CHARTS} worksheet charts"
                                )));
                            }
                            ordinal += 1;
                            charts.push(XlsxDrawingChart {
                                sheet_name: sheet_name.to_string(),
                                sheet_part: sheet_part.to_string(),
                                drawing_part: drawing_part.to_string(),
                                chart_part: chart_part.clone(),
                                ordinal,
                                anchor: finished,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => {
                budget.finish(drawing_part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(charts)
}

fn worksheet_drawing_parts(
    archive: &mut StreamingOxmlArchive,
    worksheet_part: &str,
) -> Result<Vec<String>, HcdError> {
    let relationships_part = relationships_part_path(worksheet_part)?;
    if !archive.contains(&relationships_part) {
        return Ok(Vec::new());
    }
    let xml = archive
        .read_control_part(&relationships_part, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut parts = Vec::new();
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("worksheet relationships XML: {error}"))
        })?;
        budget.observe(&event, &relationships_part)?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "Relationship" =>
            {
                let drawing =
                    attribute(element, "Type").is_some_and(|kind| kind.ends_with("/drawing"));
                let external = attribute(element, "TargetMode")
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
                if drawing && !external {
                    if let Some(target) = attribute(element, "Target") {
                        parts.push(resolve_part(worksheet_part, &target)?);
                    }
                }
            }
            Event::Eof => {
                budget.finish(&relationships_part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(parts)
}

fn drawing_image_relationships(
    archive: &mut StreamingOxmlArchive,
    drawing_part: &str,
    assets: &HashMap<String, AssetRecord>,
) -> Result<HashMap<String, AssetRecord>, HcdError> {
    let relationships_part = relationships_part_path(drawing_part)?;
    if !archive.contains(&relationships_part) {
        return Ok(HashMap::new());
    }
    let xml = archive
        .read_control_part(&relationships_part, MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut reader = Reader::from_reader(xml.as_slice());
    let mut buffer = Vec::new();
    let mut output = HashMap::new();
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("drawing relationships XML: {error}"))
        })?;
        budget.observe(&event, &relationships_part)?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "Relationship" =>
            {
                let image = attribute(element, "Type").is_some_and(|kind| kind.ends_with("/image"));
                let external = attribute(element, "TargetMode")
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
                if image && !external {
                    if let (Some(id), Some(target)) =
                        (attribute(element, "Id"), attribute(element, "Target"))
                    {
                        let target = resolve_part(drawing_part, &target)?;
                        if let Some(asset) = assets.get(&target) {
                            output.insert(id, asset.clone());
                        }
                    }
                }
            }
            Event::Eof => {
                budget.finish(&relationships_part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(output)
}

fn parse_drawing_pictures(
    source: &mut dyn Read,
    sheet_name: &str,
    sheet_part: &str,
    drawing_part: &str,
    relationships: &HashMap<String, AssetRecord>,
    maximum: usize,
) -> Result<Vec<XlsxDrawingPicture>, HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut pictures = Vec::new();
    let mut anchor: Option<XlsxDrawingAnchor> = None;
    let mut marker = None;
    let mut capture: Option<(&'static str, String)> = None;
    let mut in_picture = false;
    let mut ordinal = 0u64;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("drawing {drawing_part} XML: {error}"))
        })?;
        budget.observe(&event, drawing_part)?;
        match event {
            Event::Start(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        if anchor.is_some() {
                            return Err(HcdError::InvalidBundle(format!(
                                "drawing {drawing_part} contains nested anchors"
                            )));
                        }
                        anchor = Some(XlsxDrawingAnchor {
                            kind: match name {
                                "twoCellAnchor" => "two-cell",
                                "oneCellAnchor" => "one-cell",
                                _ => "absolute",
                            }
                            .to_string(),
                            ..XlsxDrawingAnchor::default()
                        });
                    }
                    "from" if anchor.is_some() => marker = Some(DrawingMarker::From),
                    "to" if anchor.is_some() => marker = Some(DrawingMarker::To),
                    "col" | "row" | "colOff" | "rowOff" if marker.is_some() => {
                        capture = Some((
                            match name {
                                "col" => "col",
                                "row" => "row",
                                "colOff" => "colOff",
                                _ => "rowOff",
                            },
                            String::new(),
                        ));
                    }
                    "pic" if anchor.is_some() => in_picture = true,
                    "cNvPr" if in_picture => capture_picture_metadata(element, anchor.as_mut()),
                    "blip" if in_picture => capture_picture_blip(element, anchor.as_mut()),
                    "pos" if anchor.is_some() => capture_anchor_position(element, anchor.as_mut()),
                    "ext" if anchor.is_some() => capture_anchor_extent(element, anchor.as_mut()),
                    _ => {}
                }
            }
            Event::Empty(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "cNvPr" if in_picture => capture_picture_metadata(element, anchor.as_mut()),
                    "blip" if in_picture => capture_picture_blip(element, anchor.as_mut()),
                    "pos" if anchor.is_some() => capture_anchor_position(element, anchor.as_mut()),
                    "ext" if anchor.is_some() => capture_anchor_extent(element, anchor.as_mut()),
                    _ => {}
                }
            }
            Event::Text(ref text) => {
                if let Some((_, value)) = &mut capture {
                    let decoded = text.unescape().map_err(|error| {
                        HcdError::InvalidBundle(format!(
                            "drawing {drawing_part} anchor text: {error}"
                        ))
                    })?;
                    value.push_str(&decoded);
                    if value.len() > 64 {
                        return Err(HcdError::ResourceLimit(format!(
                            "drawing {drawing_part} anchor value exceeds 64 bytes"
                        )));
                    }
                }
            }
            Event::End(ref element) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                match name {
                    "col" | "row" | "colOff" | "rowOff" => {
                        if let Some((field, value)) = capture.take() {
                            apply_anchor_marker(anchor.as_mut(), marker, field, &value);
                        }
                    }
                    "from" | "to" => marker = None,
                    "pic" => in_picture = false,
                    "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {
                        let finished = anchor.take().ok_or_else(|| {
                            HcdError::InvalidBundle(format!(
                                "drawing {drawing_part} closes an anchor without opening it"
                            ))
                        })?;
                        if let Some(asset) = finished
                            .relationship_id
                            .as_ref()
                            .and_then(|id| relationships.get(id))
                        {
                            if pictures.len() >= maximum {
                                return Err(HcdError::ResourceLimit(format!(
                                    "XLSX exceeds {MAX_DRAWING_IMAGES} worksheet pictures"
                                )));
                            }
                            ordinal += 1;
                            pictures.push(XlsxDrawingPicture {
                                sheet_name: sheet_name.to_string(),
                                sheet_part: sheet_part.to_string(),
                                drawing_part: drawing_part.to_string(),
                                ordinal,
                                anchor: finished,
                                asset: asset.clone(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => {
                budget.finish(drawing_part)?;
                if anchor.is_some() || capture.is_some() || in_picture {
                    return Err(HcdError::InvalidBundle(format!(
                        "drawing {drawing_part} ends inside an anchor"
                    )));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(pictures)
}

fn capture_picture_metadata(element: &BytesStart<'_>, anchor: Option<&mut XlsxDrawingAnchor>) {
    let Some(anchor) = anchor else {
        return;
    };
    anchor.picture_id = attribute(element, "id");
    anchor.name = attribute(element, "name");
    anchor.description = attribute(element, "descr");
}

fn capture_picture_blip(element: &BytesStart<'_>, anchor: Option<&mut XlsxDrawingAnchor>) {
    if let Some(anchor) = anchor {
        anchor.relationship_id = attribute(element, "embed");
    }
}

fn capture_anchor_position(element: &BytesStart<'_>, anchor: Option<&mut XlsxDrawingAnchor>) {
    let Some(anchor) = anchor else {
        return;
    };
    anchor.x = bounded_drawing_i64(attribute(element, "x"));
    anchor.y = bounded_drawing_i64(attribute(element, "y"));
}

fn capture_anchor_extent(element: &BytesStart<'_>, anchor: Option<&mut XlsxDrawingAnchor>) {
    let Some(anchor) = anchor else {
        return;
    };
    if anchor.width.is_none() {
        anchor.width = bounded_drawing_i64(attribute(element, "cx")).filter(|value| *value > 0);
    }
    if anchor.height.is_none() {
        anchor.height = bounded_drawing_i64(attribute(element, "cy")).filter(|value| *value > 0);
    }
}

fn apply_anchor_marker(
    anchor: Option<&mut XlsxDrawingAnchor>,
    marker: Option<DrawingMarker>,
    field: &str,
    value: &str,
) {
    let Some(anchor) = anchor else {
        return;
    };
    let coordinate = value.trim().parse::<i64>().ok();
    match (marker, field) {
        (Some(DrawingMarker::From), "col") => {
            anchor.from_col = coordinate.and_then(|value| u32::try_from(value).ok())
        }
        (Some(DrawingMarker::From), "row") => {
            anchor.from_row = coordinate.and_then(|value| u32::try_from(value).ok())
        }
        (Some(DrawingMarker::From), "colOff") => {
            anchor.from_col_offset = coordinate.and_then(bounded_drawing_coordinate)
        }
        (Some(DrawingMarker::From), "rowOff") => {
            anchor.from_row_offset = coordinate.and_then(bounded_drawing_coordinate)
        }
        (Some(DrawingMarker::To), "col") => {
            anchor.to_col = coordinate.and_then(|value| u32::try_from(value).ok())
        }
        (Some(DrawingMarker::To), "row") => {
            anchor.to_row = coordinate.and_then(|value| u32::try_from(value).ok())
        }
        (Some(DrawingMarker::To), "colOff") => {
            anchor.to_col_offset = coordinate.and_then(bounded_drawing_coordinate)
        }
        (Some(DrawingMarker::To), "rowOff") => {
            anchor.to_row_offset = coordinate.and_then(bounded_drawing_coordinate)
        }
        _ => {}
    }
}

fn bounded_drawing_i64(value: Option<String>) -> Option<i64> {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .and_then(bounded_drawing_coordinate)
}

fn bounded_drawing_coordinate(value: i64) -> Option<i64> {
    (-100_000_000..=100_000_000)
        .contains(&value)
        .then_some(value)
}

fn append_drawing_anchor_attributes(output: &mut String, anchor: &XlsxDrawingAnchor) {
    push_data_number(
        output,
        "data-hcd-from-column-offset-emu",
        anchor.from_col_offset,
    );
    push_data_number(
        output,
        "data-hcd-from-row-offset-emu",
        anchor.from_row_offset,
    );
    push_data_number(
        output,
        "data-hcd-to-column-offset-emu",
        anchor.to_col_offset,
    );
    push_data_number(output, "data-hcd-to-row-offset-emu", anchor.to_row_offset);
    push_data_number(output, "data-hcd-absolute-x-emu", anchor.x);
    push_data_number(output, "data-hcd-absolute-y-emu", anchor.y);
    push_data_number(output, "data-hcd-extent-width-emu", anchor.width);
    push_data_number(output, "data-hcd-extent-height-emu", anchor.height);
}

fn default_column_width_emu(width: Option<f64>) -> u32 {
    width
        .map(|value| value * 7.5 * 9_525.0)
        .unwrap_or(DEFAULT_COLUMN_WIDTH_EMU as f64)
        .round()
        .clamp(1.0, 100_000_000.0) as u32
}

fn default_row_height_emu(height_points: Option<f64>) -> u32 {
    height_points
        .map(|value| value * 12_700.0)
        .unwrap_or(DEFAULT_ROW_HEIGHT_EMU as f64)
        .round()
        .clamp(1.0, 100_000_000.0) as u32
}

fn drawing_geometry(anchor: &XlsxDrawingAnchor) -> (i64, i64, i64, i64) {
    let from_x = anchor.x.unwrap_or_else(|| {
        i64::from(anchor.from_col.unwrap_or(0))
            .saturating_mul(DEFAULT_COLUMN_WIDTH_EMU)
            .saturating_add(anchor.from_col_offset.unwrap_or(0))
    });
    let from_y = anchor.y.unwrap_or_else(|| {
        i64::from(anchor.from_row.unwrap_or(0))
            .saturating_mul(DEFAULT_ROW_HEIGHT_EMU)
            .saturating_add(anchor.from_row_offset.unwrap_or(0))
    });
    let to_x = anchor.to_col.map(|column| {
        i64::from(column)
            .saturating_mul(DEFAULT_COLUMN_WIDTH_EMU)
            .saturating_add(anchor.to_col_offset.unwrap_or(0))
    });
    let to_y = anchor.to_row.map(|row| {
        i64::from(row)
            .saturating_mul(DEFAULT_ROW_HEIGHT_EMU)
            .saturating_add(anchor.to_row_offset.unwrap_or(0))
    });
    let width = anchor
        .width
        .or_else(|| to_x.map(|value| value.saturating_sub(from_x)))
        .unwrap_or(3_657_600)
        .clamp(1, 100_000_000);
    let height = anchor
        .height
        .or_else(|| to_y.map(|value| value.saturating_sub(from_y)))
        .unwrap_or(2_743_200)
        .clamp(1, 100_000_000);
    (
        from_x.clamp(0, 100_000_000),
        from_y.clamp(0, 100_000_000),
        width,
        height,
    )
}

fn drawing_cell(column: Option<u32>, row: Option<u32>) -> Option<String> {
    let column = column?.checked_add(1)?;
    let row = row?.checked_add(1)?;
    (column <= 16_384 && row <= 1_048_576).then(|| format!("{}{row}", column_name(column)))
}

fn relationships_part_path(source_part: &str) -> Result<String, HcdError> {
    let source = Path::new(source_part);
    let file_name = source
        .file_name()
        .ok_or_else(|| HcdError::InvalidBundle(format!("invalid OOXML part path {source_part}")))?;
    Ok(source
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("_rels")
        .join(format!("{}.rels", file_name.to_string_lossy()))
        .to_string_lossy()
        .replace('\\', "/"))
}

fn emu_to_px(value: i64) -> f64 {
    value.clamp(0, 100_000_000) as f64 * 96.0 / 914_400.0
}

fn scan_worksheet_metadata(source: &mut dyn Read, part: &str) -> Result<WorksheetScan, HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut ranges = Vec::new();
    let mut formula_ranges = Vec::new();
    let mut protected = false;
    let mut selected_view: Option<WorksheetViewMetadata> = None;
    let mut current_view: Option<WorksheetViewMetadata> = None;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("worksheet {part} XML: {error}")))?;
        budget.observe(&event, part)?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "sheetProtection" =>
            {
                protected |= !attribute(element, "sheet")
                    .is_some_and(|value| matches!(value.as_str(), "0" | "false"));
            }
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "f"
                    && matches!(
                        attribute(element, "t").as_deref(),
                        Some("array" | "dataTable")
                    ) =>
            {
                if formula_ranges.len() >= MAX_MERGED_RANGES {
                    return Err(HcdError::ResourceLimit(format!(
                        "worksheet {part} has too many formula ranges"
                    )));
                }
                let reference = attribute(element, "ref").ok_or_else(|| {
                    HcdError::InvalidBundle(format!("worksheet {part} formula range has no ref"))
                })?;
                let range = parse_merge_reference(&reference)
                    .or_else(|| {
                        cell_coordinates(&reference).map(|(row, col)| MergeRange {
                            start_row: row,
                            end_row: row,
                            start_col: col,
                            end_col: col,
                        })
                    })
                    .ok_or_else(|| {
                        HcdError::InvalidBundle(format!(
                            "worksheet {part} has invalid formula range {reference}"
                        ))
                    })?;
                formula_ranges.push(range);
            }
            Event::Start(ref element) if local_name(element.name().as_ref()) == "sheetView" => {
                if current_view.is_some() {
                    return Err(HcdError::InvalidBundle(format!(
                        "worksheet {part} contains nested sheetView elements"
                    )));
                }
                current_view = Some(parse_worksheet_view(element));
            }
            Event::Empty(ref element) if local_name(element.name().as_ref()) == "sheetView" => {
                select_worksheet_view(&mut selected_view, parse_worksheet_view(element));
            }
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "pane" && current_view.is_some() =>
            {
                let view = current_view.as_mut().expect("checked current sheet view");
                if view.pane.is_none() {
                    view.pane = parse_worksheet_pane(element);
                }
            }
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "mergeCell" =>
            {
                if ranges.len() >= MAX_MERGED_RANGES {
                    return Err(HcdError::ResourceLimit(format!(
                        "worksheet {part} exceeds {MAX_MERGED_RANGES} merged ranges"
                    )));
                }
                let reference = attribute(element, "ref").ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "worksheet {part} contains mergeCell without ref"
                    ))
                })?;
                ranges.push(parse_merge_reference(&reference).ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "worksheet {part} has invalid merged range {reference}"
                    ))
                })?);
            }
            Event::End(ref element) if local_name(element.name().as_ref()) == "sheetView" => {
                let view = current_view.take().ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "worksheet {part} closes sheetView without opening it"
                    ))
                })?;
                select_worksheet_view(&mut selected_view, view);
            }
            Event::Eof => {
                budget.finish(part)?;
                if current_view.is_some() {
                    return Err(HcdError::InvalidBundle(format!(
                        "worksheet {part} ends inside sheetView"
                    )));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(WorksheetScan {
        protected,
        merged_ranges: MergeCursor::new(ranges),
        formula_ranges: MergeCursor::new(formula_ranges),
        view: selected_view.unwrap_or_default(),
    })
}

fn parse_worksheet_view(element: &BytesStart<'_>) -> WorksheetViewMetadata {
    WorksheetViewMetadata {
        workbook_view_id: attribute(element, "workbookViewId")
            .and_then(|value| value.parse::<u32>().ok()),
        view: attribute(element, "view").and_then(|value| match value.as_str() {
            "normal" => Some("normal"),
            "pageBreakPreview" => Some("page-break-preview"),
            "pageLayout" => Some("page-layout"),
            _ => None,
        }),
        top_left_cell: attribute(element, "topLeftCell")
            .and_then(|value| canonical_cell_reference(&value)),
        right_to_left: boolean_attribute(element, "rightToLeft"),
        show_grid_lines: boolean_attribute(element, "showGridLines"),
        show_row_column_headers: boolean_attribute(element, "showRowColHeaders"),
        show_zeros: boolean_attribute(element, "showZeros"),
        show_formulas: boolean_attribute(element, "showFormulas"),
        zoom_scale: attribute(element, "zoomScale")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| (10..=400).contains(value)),
        pane: None,
    }
}

fn parse_worksheet_pane(element: &BytesStart<'_>) -> Option<WorksheetPaneMetadata> {
    let state = match attribute(element, "state").as_deref() {
        None | Some("split") => "split",
        Some("frozen") => "frozen",
        Some("frozenSplit") => "frozen-split",
        Some(_) => return None,
    };
    Some(WorksheetPaneMetadata {
        state,
        x_split: pane_split(element, "xSplit"),
        y_split: pane_split(element, "ySplit"),
        top_left_cell: attribute(element, "topLeftCell")
            .and_then(|value| canonical_cell_reference(&value)),
        active_pane: attribute(element, "activePane").and_then(|value| match value.as_str() {
            "topLeft" => Some("top-left"),
            "topRight" => Some("top-right"),
            "bottomLeft" => Some("bottom-left"),
            "bottomRight" => Some("bottom-right"),
            _ => None,
        }),
    })
}

fn select_worksheet_view(
    selected: &mut Option<WorksheetViewMetadata>,
    candidate: WorksheetViewMetadata,
) {
    let candidate_is_primary = candidate.workbook_view_id == Some(0);
    let current_is_primary = selected
        .as_ref()
        .is_some_and(|view| view.workbook_view_id == Some(0));
    if selected.is_none() || (candidate_is_primary && !current_is_primary) {
        *selected = Some(candidate);
    }
}

fn boolean_attribute(element: &BytesStart<'_>, name: &str) -> Option<bool> {
    attribute(element, name).and_then(|value| match value.as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    })
}

fn pane_split(element: &BytesStart<'_>, name: &str) -> Option<f64> {
    attribute(element, name)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && (0.0..=1_000_000_000.0).contains(value))
}

fn frozen_split_count(value: f64, maximum: u32) -> Option<u32> {
    (value.fract() == 0.0 && (0.0..=f64::from(maximum)).contains(&value)).then_some(value as u32)
}

fn canonical_cell_reference(reference: &str) -> Option<String> {
    let (row, column) = cell_coordinates(reference)?;
    Some(format!("{}{row}", column_name(column)))
}

fn parse_merge_reference(reference: &str) -> Option<MergeRange> {
    let (start, end) = reference.split_once(':')?;
    if end.contains(':') {
        return None;
    }
    let (start_row, start_col) = cell_coordinates(start)?;
    let (end_row, end_col) = cell_coordinates(end)?;
    (start_row <= end_row && start_col <= end_col).then_some(MergeRange {
        start_row,
        end_row,
        start_col,
        end_col,
    })
}

fn cell_coordinates(reference: &str) -> Option<(u32, u32)> {
    let mut column = 0u32;
    let mut row = 0u32;
    let mut saw_column = false;
    let mut saw_row = false;
    for character in reference.chars().filter(|character| *character != '$') {
        if character.is_ascii_alphabetic() && !saw_row {
            saw_column = true;
            let digit = character.to_ascii_uppercase() as u32 - 'A' as u32 + 1;
            column = column.checked_mul(26)?.checked_add(digit)?;
        } else if character.is_ascii_digit() && saw_column {
            saw_row = true;
            row = row.checked_mul(10)?.checked_add(character.to_digit(10)?)?;
        } else {
            return None;
        }
    }
    (saw_column && saw_row && (1..=16_384).contains(&column) && (1..=1_048_576).contains(&row))
        .then_some((row, column))
}

fn merge_reference(range: MergeRange) -> String {
    format!(
        "{}{}:{}{}",
        column_name(range.start_col),
        range.start_row,
        column_name(range.end_col),
        range.end_row
    )
}

fn column_name(mut column: u32) -> String {
    let mut output = Vec::new();
    while column > 0 {
        column -= 1;
        output.push((b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    output.iter().rev().collect()
}

fn sheet_grid_id(document_id: &str, sheet_part: &str) -> String {
    stable_node_id(&[document_id, sheet_part, "worksheet"]).replacen("n_", "s_", 1)
}

fn drawing_grid_address(
    document_id: &str,
    sheet: &SheetPart,
    anchor: &XlsxDrawingAnchor,
    kind: GridChunkKind,
) -> GridChunkAddress {
    GridChunkAddress {
        sheet_id: sheet_grid_id(document_id, &sheet.part),
        sheet_name: sheet.name.clone(),
        sheet_index: sheet.index,
        sheet_state: sheet.state.to_string(),
        kind,
        row_start: anchor.from_row.map(|value| u64::from(value) + 1),
        row_end: anchor.to_row.map(|value| u64::from(value) + 1),
        column_start: anchor.from_col.map(|value| value + 1),
        column_end: anchor.to_col.map(|value| value + 1),
        default_column_width_emu: None,
        default_row_height_emu: None,
    }
}

fn begin_worksheet_row(
    element: &BytesStart<'_>,
    sheet: &SheetPart,
    merged_ranges: &mut MergeCursor,
    last_row_number: &mut u32,
) -> Result<RenderedRow, HcdError> {
    let merge_row = match attribute(element, "r") {
        Some(value) => value
            .parse::<u32>()
            .ok()
            .filter(|value| (1..=1_048_576).contains(value))
            .ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "worksheet {} has invalid row number {value}",
                    sheet.part
                ))
            })?,
        None => last_row_number.checked_add(1).ok_or_else(|| {
            HcdError::InvalidBundle(format!("worksheet {} row number overflow", sheet.part))
        })?,
    };
    merged_ranges.begin_row(merge_row)?;
    *last_row_number = merge_row;

    let number = u64::from(merge_row);
    let height = attribute(element, "ht")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| (0.0..=409.0).contains(value));
    let hidden =
        attribute(element, "hidden").is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    let mut row_attributes = String::new();
    if hidden {
        row_attributes.push_str(" data-hcd-hidden=\"true\" style=\"display:none\"");
    } else if let Some(height) = height {
        row_attributes.push_str(&format!(
            " data-hcd-height-points=\"{height:.2}\" style=\"height:{height:.2}pt\""
        ));
    }

    Ok(RenderedRow {
        number,
        html: format!("<tr data-hcd-row=\"{number}\"{row_attributes}>"),
        entries: Vec::new(),
        merge_end_row: None,
        cells: Vec::new(),
        merge_anchors: merged_ranges.current_row_anchors(),
        merge_covers: merged_ranges.current_row_covers(),
        first_column: None,
        last_column: None,
        optional_blank_columns: BTreeSet::new(),
    })
}

fn merge_attributes(range: MergeRange) -> String {
    format!(
        " data-hcd-merge=\"{}\" rowspan=\"{}\" colspan=\"{}\"",
        merge_reference(range),
        range.end_row - range.start_row + 1,
        range.end_col - range.start_col + 1
    )
}

fn finish_worksheet_row(mut row: RenderedRow) -> Result<RenderedRow, HcdError> {
    for range in &row.merge_anchors {
        row.merge_end_row = Some(row.merge_end_row.unwrap_or(0).max(range.end_row));
        if !row.cells.iter().any(|cell| cell.column == range.start_col) {
            let reference = format!("{}{}", column_name(range.start_col), range.start_row);
            row.cells.push(RenderedCell {
                column: range.start_col,
                span: range.end_col - range.start_col + 1,
                html: format!(
                    "<td class=\"hcd-cell hcd-merge-empty\" data-hcd-cell=\"{reference}\" data-hcd-column=\"{}\" data-hcd-editable=\"false\"{}></td>",
                    range.start_col,
                    merge_attributes(*range)
                ),
            });
        }
    }
    row.cells.sort_unstable_by_key(|cell| cell.column);
    for pair in row.cells.windows(2) {
        if pair[0].column == pair[1].column {
            return Err(HcdError::InvalidBundle(format!(
                "worksheet row {} contains duplicate column {}",
                row.number, pair[0].column
            )));
        }
    }
    row.first_column = row.cells.first().map(|cell| cell.column);
    row.last_column = row
        .cells
        .iter()
        .map(|cell| cell.column.saturating_add(cell.span.max(1) - 1))
        .max();
    let mut logical_column = 1u32;
    for cell in &row.cells {
        while logical_column < cell.column {
            let covered = row
                .merge_covers
                .iter()
                .any(|range| range.start_col <= logical_column && logical_column <= range.end_col);
            if covered {
                logical_column += 1;
                continue;
            }
            row.html.push_str(&format!(
                "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"{logical_column}\"></td>"
            ));
            logical_column += 1;
        }
        row.html.push_str(&cell.html);
        logical_column = cell.column.saturating_add(cell.span.max(1));
    }
    row.html.push_str("</tr>");
    Ok(row)
}

fn compact_worksheet_row(row: &mut RenderedRow, budget: usize) -> Result<u64, HcdError> {
    if row.html.len() <= budget || row.optional_blank_columns.is_empty() {
        return Ok(0);
    }
    let count = row.optional_blank_columns.len();
    let columns: Vec<u32> = row.optional_blank_columns.iter().copied().collect();
    let prefix_end = row
        .html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("XLSX row has no start tag".into()))?
        + 1;
    // The row has already been rendered and sorted. Measure candidate suffix
    // removal without cloning its map or allocating a complete HTML string.
    let length = |remove: usize| {
        let cutoff = columns[count - remove];
        let mut size = prefix_end + "</tr>".len();
        let mut logical_column = 1u32;
        for cell in &row.cells {
            if cell.column >= cutoff && row.optional_blank_columns.contains(&cell.column) {
                continue;
            }
            while logical_column < cell.column {
                let covered = row.merge_covers.iter().any(|range| {
                    range.start_col <= logical_column && logical_column <= range.end_col
                });
                if !covered {
                    size += "<td class=\"hcd-cell hcd-empty\" data-hcd-column=\"".len()
                        + (logical_column.ilog10() as usize + 1)
                        + "\"></td>".len();
                }
                logical_column += 1;
            }
            size += cell.html.len();
            logical_column = cell.column.saturating_add(cell.span.max(1));
        }
        size
    };
    let mut low = 1usize;
    let mut high = count;
    // A fully compacted row can still exceed the requested group budget; in
    // that case return it and let the caller compact earlier rows as well.
    if length(count) <= budget {
        while low < high {
            let middle = low + (high - low) / 2;
            if length(middle) <= budget {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
    }
    let expected_length = length(high);
    let cutoff = columns[count - high];
    let removed: BTreeSet<u32> = columns[count - high..].iter().copied().collect();
    row.html.truncate(prefix_end);
    row.cells
        .retain(|cell| cell.column < cutoff || !removed.contains(&cell.column));
    row.entries.retain(|entry| {
        entry
            .source
            .paragraph_id
            .as_deref()
            .and_then(cell_coordinates)
            .is_none_or(|(_, column)| !removed.contains(&column))
    });
    row.optional_blank_columns
        .retain(|column| !removed.contains(column));
    *row = finish_worksheet_row(std::mem::take(row))?;
    debug_assert_eq!(row.html.len(), expected_length);
    Ok(high as u64)
}

#[allow(clippy::too_many_arguments)]
fn parse_worksheet<F>(
    source: &mut dyn Read,
    document_id: &str,
    sheet: &SheetPart,
    shared_strings: &mut SharedStringStore,
    merged_ranges: &mut MergeCursor,
    formula_ranges: &mut MergeCursor,
    sheet_protected: bool,
    styles: &XlsxStyleCatalog,
    date_1904: bool,
    format_stats: &mut XlsxFormatStats,
    chunks: &mut SheetChunkWriter<'_, F>,
) -> Result<(), HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut row: Option<RenderedRow> = None;
    let mut cell: Option<CellBuilder> = None;
    let mut cell_ordinal = 0u64;
    let mut last_row_number = 0u32;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("worksheet {} XML: {error}", sheet.part))
        })?;
        budget.observe(&event, &sheet.part)?;
        match event {
            Event::Start(ref start) if local_name(start.name().as_ref()) == "row" => {
                row = Some(begin_worksheet_row(
                    start,
                    sheet,
                    merged_ranges,
                    &mut last_row_number,
                )?);
                formula_ranges.begin_row(last_row_number)?;
            }
            Event::Empty(ref start) if local_name(start.name().as_ref()) == "row" => {
                let finished =
                    begin_worksheet_row(start, sheet, merged_ranges, &mut last_row_number)?;
                formula_ranges.begin_row(last_row_number)?;
                let finished = finish_worksheet_row(finished)?;
                chunks.push(finished)?;
            }
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "sheetFormatPr" =>
            {
                chunks.default_column_width = attribute(start, "defaultColWidth")
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| (0.0..=255.0).contains(value));
                chunks.default_row_height = attribute(start, "defaultRowHeight")
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| (0.0..=409.0).contains(value));
            }
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "col" =>
            {
                append_column_markup(&mut chunks.column_markup, start);
            }
            Event::Start(ref start) if local_name(start.name().as_ref()) == "c" => {
                cell = Some(CellBuilder {
                    reference: attribute(start, "r").unwrap_or_default(),
                    value_type: attribute(start, "t").unwrap_or_default(),
                    style_index: attribute(start, "s").and_then(|value| value.parse().ok()),
                    sheet_protected,
                    ..Default::default()
                });
            }
            Event::Empty(ref start) if local_name(start.name().as_ref()) == "c" => {
                let mut finished = CellBuilder {
                    reference: attribute(start, "r").unwrap_or_default(),
                    value_type: attribute(start, "t").unwrap_or_default(),
                    style_index: attribute(start, "s").and_then(|value| value.parse().ok()),
                    sheet_protected,
                    ..Default::default()
                };
                if let Some((row, column)) = cell_coordinates(&finished.reference) {
                    finished.formula |= formula_ranges.classify(row, column).is_some();
                }
                append_finished_cell_if_visible(
                    &mut row,
                    document_id,
                    sheet,
                    &mut cell_ordinal,
                    finished,
                    shared_strings,
                    merged_ranges,
                    styles,
                    date_1904,
                    format_stats,
                )?;
            }
            Event::Start(ref start) | Event::Empty(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "f" =>
            {
                cell.as_mut().expect("checked cell").formula = true;
            }
            Event::Start(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "v" =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::Value;
            }
            Event::Start(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "t" =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::InlineText;
            }
            Event::Text(text) if cell.is_some() => {
                let decoded = text
                    .unescape()
                    .map_err(|error| HcdError::InvalidBundle(format!("worksheet text: {error}")))?;
                let cell = cell.as_mut().expect("checked cell");
                match cell.capture {
                    Capture::Value => cell.value.push_str(&decoded),
                    Capture::InlineText => cell.inline_text.push_str(&decoded),
                    Capture::None => {}
                }
                if cell.value.len().max(cell.inline_text.len()) > MAX_CHUNK_BYTES {
                    return Err(HcdError::ResourceLimit(format!(
                        "NODE_TOO_LARGE: cell {} exceeds 2 MiB",
                        cell.reference
                    )));
                }
            }
            Event::End(ref end)
                if cell.is_some() && matches!(local_name(end.name().as_ref()), "v" | "t") =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::None;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "c" => {
                let mut finished = cell.take().unwrap_or_default();
                if let Some((row, column)) = cell_coordinates(&finished.reference) {
                    finished.formula |= formula_ranges.classify(row, column).is_some();
                }
                append_finished_cell_if_visible(
                    &mut row,
                    document_id,
                    sheet,
                    &mut cell_ordinal,
                    finished,
                    shared_strings,
                    merged_ranges,
                    styles,
                    date_1904,
                    format_stats,
                )?;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "row" => {
                if let Some(finished) = row.take() {
                    let finished = finish_worksheet_row(finished)?;
                    chunks.push(finished)?;
                }
            }
            Event::Eof => {
                budget.finish(&sheet.part)?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(())
}

fn append_column_markup(output: &mut String, element: &BytesStart<'_>) {
    let min = attribute(element, "min")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=16_384).contains(value))
        .unwrap_or(1);
    let max = attribute(element, "max")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (min..=16_384).contains(value))
        .unwrap_or(min);
    let span = max - min + 1;
    let width = attribute(element, "width")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| (0.0..=255.0).contains(value));
    let hidden =
        attribute(element, "hidden").is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    output.push_str(&format!(
        "<col span=\"{span}\" data-hcd-column-start=\"{min}\" data-hcd-column-end=\"{max}\""
    ));
    if let Some(width) = width {
        output.push_str(&format!(" data-hcd-width=\"{width:.2}\""));
    }
    if hidden {
        output.push_str(" data-hcd-hidden=\"true\" style=\"display:none\"");
    } else if let Some(width) = width {
        // Excel character width is approximated at 7.5 CSS pixels per unit.
        output.push_str(&format!(" style=\"width:{:.2}px\"", width * 7.5));
    }
    output.push_str("/>");
}

#[allow(clippy::too_many_arguments)]
fn append_finished_cell_if_visible(
    row: &mut Option<RenderedRow>,
    document_id: &str,
    sheet: &SheetPart,
    cell_ordinal: &mut u64,
    finished: CellBuilder,
    shared_strings: &mut SharedStringStore,
    merged_ranges: &MergeCursor,
    styles: &XlsxStyleCatalog,
    date_1904: bool,
    format_stats: &mut XlsxFormatStats,
) -> Result<(), HcdError> {
    let Some(row) = row else {
        return Err(HcdError::InvalidBundle(format!(
            "worksheet {} contains a cell outside a row",
            sheet.part
        )));
    };
    let has_content =
        !finished.value.is_empty() || !finished.inline_text.is_empty() || finished.formula;
    let is_merge_anchor = cell_coordinates(&finished.reference)
        .and_then(|(cell_row, cell_col)| merged_ranges.classify(cell_row, cell_col))
        .is_some_and(|position| matches!(position, MergePosition::Anchor(_)));
    // A physically present empty cell has a stable source address and can use
    // the same text splice and source-preserving export as other cells. Do not
    // materialize virtual gaps, or cells covered by a merged range.
    let stored_blank = !has_content
        && finished.value_type != "s"
        && cell_coordinates(&finished.reference).is_some_and(|(cell_row, cell_col)| {
            !matches!(
                merged_ranges.classify(cell_row, cell_col),
                Some(MergePosition::Covered(_))
            )
        });
    if !finished.reference.is_empty() && (has_content || is_merge_anchor || stored_blank) {
        if stored_blank && !is_merge_anchor {
            if let Some((_, column)) = cell_coordinates(&finished.reference) {
                row.optional_blank_columns.insert(column);
            }
        }
        *cell_ordinal += 1;
        append_cell(
            row,
            document_id,
            sheet,
            *cell_ordinal,
            finished,
            shared_strings,
            merged_ranges,
            styles,
            date_1904,
            format_stats,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_cell(
    row: &mut RenderedRow,
    document_id: &str,
    sheet: &SheetPart,
    ordinal: u64,
    cell: CellBuilder,
    shared_strings: &mut SharedStringStore,
    merged_ranges: &MergeCursor,
    styles: &XlsxStyleCatalog,
    date_1904: bool,
    format_stats: &mut XlsxFormatStats,
) -> Result<(), HcdError> {
    let is_numeric = matches!(cell.value_type.as_str(), "" | "n");
    let raw_text = match cell.value_type.as_str() {
        "s" => shared_strings.get(cell.value.parse().map_err(|_| {
            HcdError::InvalidBundle(format!("invalid shared string index in {}", cell.reference))
        })?)?,
        "inlineStr" => cell.inline_text,
        "b" => match cell.value.as_str() {
            "1" => "TRUE".to_string(),
            "0" => "FALSE".to_string(),
            _ => cell.value,
        },
        _ => cell.value,
    };
    let formatted = format_xlsx_cell(&raw_text, cell.style_index, is_numeric, styles, date_1904);
    if formatted.text != raw_text {
        format_stats.formatted_cells = format_stats.formatted_cells.saturating_add(1);
    }
    if formatted.approximate {
        format_stats.approximate_cells = format_stats.approximate_cells.saturating_add(1);
    }
    let (cell_row, cell_col) = cell_coordinates(&cell.reference).ok_or_else(|| {
        HcdError::InvalidBundle(format!("invalid XLSX cell reference {}", cell.reference))
    })?;
    if u64::from(cell_row) != row.number {
        return Err(HcdError::InvalidBundle(format!(
            "cell {} is nested in worksheet row {}",
            cell.reference, row.number
        )));
    }
    let merge_attributes = match merged_ranges.classify(cell_row, cell_col) {
        Some(MergePosition::Anchor(range)) => {
            row.merge_end_row = Some(row.merge_end_row.unwrap_or(0).max(range.end_row));
            merge_attributes(range)
        }
        Some(MergePosition::Covered(range)) => {
            return Err(HcdError::InvalidBundle(format!(
                "merged covered cell {} contains a value or formula inside {}",
                cell.reference,
                merge_reference(range)
            )))
        }
        None => String::new(),
    };
    let node_id = stable_node_id(&[document_id, &sheet.part, "cell", &cell.reference]);
    let node_hash = hash_bytes(formatted.text.as_bytes());
    let number_format_attributes = formatted
        .num_fmt_id
        .filter(|id| *id != 0)
        .map(|id| {
            format!(
                " data-hcd-num-fmt-id=\"{id}\" data-hcd-display-kind=\"{}\"",
                formatted.kind
            )
        })
        .unwrap_or_default();
    let column_span = match merged_ranges.classify(cell_row, cell_col) {
        Some(MergePosition::Anchor(range)) => range.end_col - range.start_col + 1,
        _ => 1,
    };
    row.cells.push(RenderedCell {
        column: cell_col,
        span: column_span,
        html: format!(
            "<td class=\"hcd-cell{}\" data-hcd-cell=\"{}\" data-hcd-column=\"{}\"{}{}{}{}><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span></td>",
            cell.style_index
                .map(|index| format!(" hcd-xs-{index}"))
                .unwrap_or_default(),
            escape_attribute(&cell.reference),
            cell_col,
            if cell.formula { " data-hcd-formula=\"true\"" } else { "" },
            cell.style_index
                .map(|index| format!(" data-hcd-style-index=\"{index}\""))
                .unwrap_or_default(),
            number_format_attributes,
            merge_attributes,
            node_id,
            node_hash,
            escape_text(&formatted.text)
        ),
    });
    row.entries.push(NodeMapEntry {
        node_id,
        node_hash,
        source: SourceAnchor {
            part: sheet.part.clone(),
            text_ordinal: ordinal,
            paragraph_id: Some(cell.reference),
            text_id: None,
            node_kind: "cell".to_string(),
            editable: !cell.formula && !cell.sheet_protected,
        },
    });
    Ok(())
}

fn workbook_info(archive: &mut StreamingOxmlArchive) -> Result<WorkbookInfo, HcdError> {
    for required in ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"] {
        if !archive.contains(required) {
            return Err(HcdError::InvalidBundle(format!(
                "XLSX is missing {required}"
            )));
        }
    }
    let relationships_xml = archive
        .read_control_part("xl/_rels/workbook.xml.rels", MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut relationships = HashMap::new();
    let mut reader = Reader::from_reader(relationships_xml.as_slice());
    let mut buffer = Vec::new();
    let mut budget = XmlBudget::default();
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("workbook relationships XML: {error}"))
        })?;
        budget.observe(&event, "xl/_rels/workbook.xml.rels")?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "Relationship" =>
            {
                if let (Some(id), Some(target)) =
                    (attribute(start, "Id"), attribute(start, "Target"))
                {
                    relationships.insert(id, resolve_part("xl/workbook.xml", &target)?);
                }
            }
            Event::Eof => {
                budget.finish("xl/_rels/workbook.xml.rels")?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    let workbook_xml = archive
        .read_control_part("xl/workbook.xml", MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut reader = Reader::from_reader(workbook_xml.as_slice());
    let mut sheets = Vec::new();
    let mut date_1904 = false;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("workbook XML: {error}")))?;
        budget.observe(&event, "xl/workbook.xml")?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "workbookPr" =>
            {
                date_1904 = attribute(start, "date1904")
                    .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
            }
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "sheet" =>
            {
                let name = attribute(start, "name").unwrap_or_else(|| "Sheet".to_string());
                let relationship_id = attribute(start, "id").ok_or_else(|| {
                    HcdError::InvalidBundle(format!("sheet {name} has no relationship id"))
                })?;
                let part = relationships
                    .get(&relationship_id)
                    .cloned()
                    .ok_or_else(|| {
                        HcdError::InvalidBundle(format!(
                            "sheet {name} relationship {relationship_id} is missing"
                        ))
                    })?;
                let index = sheets.len();
                let state = match attribute(start, "state").as_deref() {
                    Some("hidden") => "hidden",
                    Some("veryHidden") => "very-hidden",
                    _ => "visible",
                };
                sheets.push(SheetPart {
                    name,
                    part,
                    index,
                    state,
                });
            }
            Event::Eof => {
                budget.finish("xl/workbook.xml")?;
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(WorkbookInfo { sheets, date_1904 })
}

pub(crate) fn export_xlsx(
    bundle: &Bundle,
    source: &Path,
    target: &Path,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    let (manifest, _, dirty_parts, dirty_node_ids) = checked_export_state(bundle, source, options)?;
    let nodes = collect_dirty_nodes(bundle, &manifest, &dirty_parts, &dirty_node_ids)?;
    let mut replacements: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut insertions: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let worksheet_parts: HashSet<&str> = workbook
        .sheets
        .iter()
        .map(|sheet| sheet.part.as_str())
        .collect();
    for node in nodes {
        if node.source.node_kind != "cell" {
            continue;
        }
        let cell = node.source.paragraph_id.ok_or_else(|| {
            HcdError::InvalidBundle(format!("XLSX node {} has no cell locator", node.node_id))
        })?;
        let part = node.source.part;
        if !worksheet_parts.contains(part.as_str())
            || canonical_cell_reference(&cell).as_deref() != Some(cell.as_str())
        {
            return Err(HcdError::InvalidBundle(
                "invalid XLSX cell source mapping".into(),
            ));
        }
        let target = match node.source.text_id.as_deref() {
            Some(VIRTUAL_CELL_SOURCE) => {
                if node.node_id != stable_node_id(&[&manifest.document_id, &part, "cell", &cell]) {
                    return Err(HcdError::InvalidBundle(
                        "invalid XLSX virtual cell identity".into(),
                    ));
                }
                &mut insertions
            }
            _ => &mut replacements,
        };
        if target
            .entry(part)
            .or_default()
            .insert(cell, node.text)
            .is_some()
        {
            return Err(HcdError::InvalidBundle(
                "duplicate XLSX cell source mapping".into(),
            ));
        }
    }

    let scratch = tempfile::tempdir()?;
    let mut replacement_paths = HashMap::new();
    let parts: BTreeSet<_> = replacements
        .keys()
        .chain(insertions.keys())
        .cloned()
        .collect();
    for (index, part) in parts.iter().enumerate() {
        let values = replacements.get(part).cloned().unwrap_or_default();
        let added = insertions.get(part).cloned().unwrap_or_default();
        if added.keys().any(|key| values.contains_key(key)) {
            return Err(HcdError::InvalidBundle(
                "duplicate XLSX cell source mapping".into(),
            ));
        }
        let mut scan = archive
            .with_part(part, |input| {
                scan_worksheet_metadata(input, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if scan.protected {
            return Err(HcdError::InvalidPatch("XLSX_SHEET_PROTECTED".into()));
        }
        let targets: BTreeSet<_> = values.keys().chain(added.keys()).cloned().collect();
        reject_formula_range_targets(&mut scan.formula_ranges, targets.iter())?;
        reject_merged_covered_targets(&mut scan.merged_ranges, targets.iter())?;
        let path = scratch.path().join(format!("sheet-{index}.xml"));
        let output = File::create(&path)?;
        archive
            .with_part(part, |input| {
                let mut output = BufWriter::new(output);
                rewrite_worksheet(input, &mut output, &values)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                output
                    .flush()
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if added.is_empty() {
            replacement_paths.insert(part.clone(), path);
        } else {
            let inserted = scratch.path().join(format!("sheet-{index}-inserted.xml"));
            let mut input = File::open(&path)?;
            let mut output = BufWriter::new(File::create(&inserted)?);
            insert_virtual_worksheet_cells(&mut input, &mut output, &added)?;
            output.flush()?;
            replacement_paths.insert(part.clone(), inserted);
        }
    }
    let changed =
        StreamingOxmlRewriter::rewrite(source, target, &replacement_paths, "xl/workbook.xml")
            .map_err(package_error)?;
    let report = FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: if changed.is_empty() {
            FidelityLevel::Exact
        } else {
            FidelityLevel::High
        },
        preserved: vec![
            "unmodified OOXML entries copied as raw compressed payloads".to_string(),
            "cell style index, workbook structure, formulas and drawings".to_string(),
        ],
        flattened: vec![
            "edited cells are serialized as inline strings regardless of their original storage type"
                .to_string(),
        ],
        dropped: vec!["HCD recognition annotations are not exported".to_string()],
        warnings: manifest.warnings,
    };
    write_fidelity_report(options, &report)?;
    Ok(report)
}

fn reject_formula_range_targets<'a>(
    ranges: &mut MergeCursor,
    targets: impl Iterator<Item = &'a String>,
) -> Result<(), HcdError> {
    let mut cells = targets
        .map(|address| {
            cell_coordinates(address)
                .map(|(row, column)| (row, column, address))
                .ok_or_else(|| {
                    HcdError::InvalidBundle(format!("invalid XLSX cell reference {address}"))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    cells.sort_unstable();
    let mut current_row = None;
    for (row, column, address) in cells {
        if current_row != Some(row) {
            ranges.begin_row(row)?;
            current_row = Some(row);
        }
        if ranges.classify(row, column).is_some() {
            return Err(HcdError::InvalidPatch(format!(
                "XLSX_FORMULA_READ_ONLY: {address}"
            )));
        }
    }
    Ok(())
}

/// The anchor is the sole editable cell in a merged range. In particular,
/// old or forged source maps must not authorize changes to covered cells.
fn reject_merged_covered_targets<'a>(
    ranges: &mut MergeCursor,
    targets: impl Iterator<Item = &'a String>,
) -> Result<(), HcdError> {
    let mut cells = targets
        .map(|address| {
            cell_coordinates(address)
                .map(|(row, column)| (row, column, address))
                .ok_or_else(|| {
                    HcdError::InvalidBundle(format!("invalid XLSX cell reference {address}"))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    cells.sort_unstable();
    let mut current_row = None;
    for (row, column, address) in cells {
        if current_row != Some(row) {
            ranges.begin_row(row)?;
            current_row = Some(row);
        }
        if matches!(
            ranges.classify(row, column),
            Some(MergePosition::Covered(_))
        ) {
            return Err(HcdError::InvalidPatch(format!(
                "XLSX_MERGED_CELL_READ_ONLY: {address}"
            )));
        }
    }
    Ok(())
}

/// A read-only, revision-bound observation. It is not a reservation or
/// permission to write: a future insertion transaction must recheck it under
/// the document's normal lock and revision CAS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XlsxVirtualBlankInspection {
    pub document_id: String,
    pub revision: u64,
    pub root_hash: String,
    pub mapping_fingerprint: String,
    pub source_sha256: String,
    pub sheet_id: String,
    /// Source part and workbook position are derived from the same verified
    /// source snapshot as the safety checks, never from client input.
    pub sheet_part: String,
    pub sheet_name: String,
    /// Zero-based workbook sheet index, as used by GridChunkAddress.
    pub sheet_index: usize,
    pub sheet_state: String,
    pub address: String,
    /// One-based Excel coordinates, as used by GridChunkAddress.
    pub row: u32,
    pub column: u32,
    pub merged_anchor: bool,
    pub node_id: String,
}

/// The original file is external to the bundle and can change without a
/// revision event. Recheck it before returning an observation or publishing
/// a candidate, then reread the manifest after the potentially slow hash.
fn verify_virtual_blank_observation(
    bundle: &Bundle,
    source: &Path,
    expected: &HcdManifest,
    observed: &XlsxVirtualBlankInspection,
) -> Result<(), HcdError> {
    let (hash, size) = source_identity(source, "xlsx")?;
    let latest = bundle.manifest()?;
    if latest.revision != observed.revision
        || latest.root_hash != observed.root_hash
        || latest.source != expected.source
        || latest.source.sha256 != observed.source_sha256
        || hash != observed.source_sha256
        || size != latest.source.size_bytes
    {
        return Err(HcdError::RevisionConflict(
            "XLSX_CELL_INSPECTION_STALE".into(),
        ));
    }
    Ok(())
}

fn publish_virtual_candidate(
    bundle: &Bundle,
    source: &Path,
    expected: &HcdManifest,
    observed: &XlsxVirtualBlankInspection,
    candidate: &Path,
    target: &Path,
) -> Result<(), HcdError> {
    verify_virtual_blank_observation(bundle, source, expected, observed)?;
    // The temporary candidate and destination share a directory; a no-clobber
    // link avoids publishing a partial file or replacing an existing one.
    std::fs::hard_link(candidate, target)?;
    Ok(())
}

pub fn inspect_xlsx_virtual_blank(
    bundle: &Bundle,
    source: &Path,
    sheet_id: &str,
    address: &str,
) -> Result<XlsxVirtualBlankInspection, HcdError> {
    Ok(inspect_xlsx_virtual_blanks(bundle, source, &[(sheet_id, address)])?.remove(0))
}

/// Create an exact-base batch after rechecking the original workbook under the
/// HCD write lock. The host is responsible for authenticating the actor.
pub fn create_xlsx_virtual_cells(
    bundle: &Bundle,
    source: &Path,
    request: &hcd_core::GridCreateRequest,
) -> Result<hcd_core::ApplyResult, HcdError> {
    hcd_core::apply_checked_grid_cells(bundle, request, |bundle, manifest, request| {
        let addresses: Vec<String> = request
            .cells
            .iter()
            .map(|cell| format!("{}{}", column_name(cell.column), cell.row))
            .collect();
        let targets: Vec<_> = request
            .cells
            .iter()
            .zip(&addresses)
            .map(|(cell, address)| (cell.sheet_id.as_str(), address.as_str()))
            .collect();
        let observed = inspect_xlsx_virtual_blanks(bundle, source, &targets)?;
        if observed.iter().zip(&request.cells).any(|(item, cell)| {
            item.document_id != request.document_id
                || item.revision != manifest.revision
                || item.root_hash != manifest.root_hash
                || item.source_sha256 != request.source_sha256
                || item.sheet_part != cell.sheet_part
                || item.row != cell.row
                || item.column != cell.column
        }) {
            return Err(HcdError::RevisionConflict(
                "XLSX_CELL_INSPECTION_STALE".into(),
            ));
        }
        if observed.iter().any(|item| item.merged_anchor) {
            return Err(HcdError::Unsupported(
                "XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED".into(),
            ));
        }
        Ok(())
    })
}

/// Batch inspection reads the source snapshot and each affected worksheet
/// once. A single protected or existing target rejects the entire batch.
pub fn inspect_xlsx_virtual_blanks(
    bundle: &Bundle,
    source: &Path,
    targets: &[(&str, &str)],
) -> Result<Vec<XlsxVirtualBlankInspection>, HcdError> {
    if targets.is_empty() || targets.len() > 4000 {
        return Err(HcdError::InvalidPatch("XLSX_INSERT_COUNT".into()));
    }
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" {
        return Err(HcdError::InvalidBundle("expected an XLSX document".into()));
    }
    if !hcd_core::validate_bundle(bundle)?.valid {
        return Err(HcdError::InvalidBundle("invalid XLSX bundle".into()));
    }
    let mapping_fingerprint = xlsx_formula_mapping_fingerprint(bundle)?;
    let (_dir, snapshot, _, _) = snapshot_xlsx_source(
        source,
        Some((&manifest.source.sha256, manifest.source.size_bytes)),
    )?;
    let mut archive = StreamingOxmlArchive::open(&snapshot).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let mut sheets = HashMap::new();
    for sheet in &workbook.sheets {
        if sheets
            .insert(sheet_grid_id(&manifest.document_id, &sheet.part), sheet)
            .is_some()
        {
            return Err(HcdError::InvalidBundle(
                "duplicate XLSX sheet identity".into(),
            ));
        }
    }
    let mut by_part = BTreeMap::<String, BTreeSet<String>>::new();
    let mut results = Vec::with_capacity(targets.len());
    let mut ids = HashSet::new();
    for &(sheet_id, address) in targets {
        let address = canonical_cell_reference(address)
            .ok_or_else(|| HcdError::InvalidPatch("invalid XLSX cell address".into()))?;
        let sheet = sheets
            .get(sheet_id)
            .ok_or_else(|| HcdError::InvalidPatch("XLSX_SHEET_NOT_FOUND".into()))?;
        let (row, column) = cell_coordinates(&address)
            .ok_or_else(|| HcdError::InvalidPatch("invalid XLSX cell address".into()))?;
        if !by_part
            .entry(sheet.part.clone())
            .or_default()
            .insert(address.clone())
        {
            return Err(HcdError::InvalidPatch("XLSX_DUPLICATE_CELL".into()));
        }
        let node_id = stable_node_id(&[&manifest.document_id, &sheet.part, "cell", &address]);
        if !ids.insert(node_id.clone()) {
            return Err(HcdError::InvalidBundle(
                "duplicate XLSX node identity".into(),
            ));
        }
        results.push(XlsxVirtualBlankInspection {
            document_id: manifest.document_id.clone(),
            revision: manifest.revision,
            root_hash: manifest.root_hash.clone(),
            mapping_fingerprint: mapping_fingerprint.clone(),
            source_sha256: manifest.source.sha256.clone(),
            sheet_id: sheet_id.into(),
            sheet_part: sheet.part.clone(),
            sheet_name: sheet.name.clone(),
            sheet_index: sheet.index,
            sheet_state: sheet.state.to_string(),
            address,
            row,
            column,
            merged_anchor: false,
            node_id,
        });
    }
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, page)?.chunks {
            for entry in bundle.read_map_verified(&chunk)?.entries {
                if ids.contains(&entry.node_id)
                    || entry.source.node_kind == "cell"
                        && by_part.contains_key(&entry.source.part)
                        && entry
                            .source
                            .paragraph_id
                            .as_deref()
                            .and_then(canonical_cell_reference)
                            .as_deref()
                            .is_some_and(|address| by_part[&entry.source.part].contains(address))
                {
                    return Err(HcdError::InvalidPatch("XLSX_CELL_ALREADY_MAPPED".into()));
                }
            }
        }
    }
    for (part, addresses) in &by_part {
        let mut scan = archive
            .with_part(part, |input| {
                scan_worksheet_metadata(input, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if scan.protected {
            return Err(HcdError::InvalidPatch("XLSX_SHEET_PROTECTED".into()));
        }
        reject_formula_range_targets(&mut scan.formula_ranges, addresses.iter())?;
        let mut anchors = MergeCursor::new(scan.merged_ranges.ranges.clone());
        reject_merged_covered_targets(&mut scan.merged_ranges, addresses.iter())?;
        let mut ordered: Vec<_> = addresses
            .iter()
            .map(|address| {
                let (row, column) = cell_coordinates(address).expect("canonical address");
                (row, column, address)
            })
            .collect();
        ordered.sort_unstable();
        let mut current_row = None;
        let mut anchor_addresses = HashSet::new();
        for (row, column, address) in ordered {
            if current_row != Some(row) {
                anchors.begin_row(row)?;
                current_row = Some(row);
            }
            if matches!(
                anchors.classify(row, column),
                Some(MergePosition::Anchor(_))
            ) {
                anchor_addresses.insert(address.as_str());
            }
        }
        for item in &mut results {
            if item.sheet_part == *part && anchor_addresses.contains(item.address.as_str()) {
                item.merged_anchor = true;
            }
        }
        let mut present = false;
        archive
            .with_part(part, |input| {
                let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, input));
                reader.config_mut().check_end_names = true;
                let mut buffer = Vec::new();
                let mut budget = XmlBudget::default();
                loop {
                    let event = reader
                        .read_event_into(&mut buffer)
                        .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                    budget
                        .observe(&event, part)
                        .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                    if let Event::Start(ref tag) | Event::Empty(ref tag) = event {
                        if local_name(tag.name().as_ref()) == "c"
                            && attribute(tag, "r")
                                .and_then(|value| canonical_cell_reference(&value))
                                .is_some_and(|address| addresses.contains(&address))
                        {
                            present = true;
                        }
                    }
                    if matches!(event, Event::Eof) {
                        budget
                            .finish(part)
                            .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                        break;
                    }
                    buffer.clear();
                }
                Ok(())
            })
            .map_err(package_error)?;
        if present {
            return Err(HcdError::InvalidPatch("XLSX_CELL_ALREADY_PRESENT".into()));
        }
    }
    verify_virtual_blank_observation(bundle, source, &manifest, &results[0])?;
    Ok(results)
}

/// Produce a review-only workbook candidate containing a new virtual cell.
/// This never changes the HCD bundle or reserves the cell; callers must use a
/// future transactional creation protocol to save the edit collaboratively.
pub fn preview_xlsx_virtual_cell(
    bundle: &Bundle,
    source: &Path,
    sheet_id: &str,
    address: &str,
    text: &str,
    target: &Path,
) -> Result<XlsxVirtualBlankInspection, HcdError> {
    let request = XlsxVirtualCell {
        sheet_id: sheet_id.into(),
        address: address.into(),
        text: text.into(),
    };
    Ok(preview_xlsx_virtual_cells(bundle, source, &[request], target)?.remove(0))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XlsxVirtualCell {
    pub sheet_id: String,
    pub address: String,
    pub text: String,
}

/// Build an all-or-nothing, review-only candidate for multiple virtual cells.
pub fn preview_xlsx_virtual_cells(
    bundle: &Bundle,
    source: &Path,
    cells: &[XlsxVirtualCell],
    target: &Path,
) -> Result<Vec<XlsxVirtualBlankInspection>, HcdError> {
    if target.exists() {
        return Err(HcdError::InvalidBundle("target already exists".into()));
    }
    if cells.is_empty()
        || cells.len() > 4000
        || cells
            .iter()
            .try_fold(0usize, |total, cell| total.checked_add(cell.text.len()))
            .is_none_or(|total| total > MAX_CHUNK_BYTES)
    {
        return Err(HcdError::InvalidPatch("XLSX_INSERT_COUNT_OR_SIZE".into()));
    }
    let targets: Vec<_> = cells
        .iter()
        .map(|cell| (cell.sheet_id.as_str(), cell.address.as_str()))
        .collect();
    let observations = inspect_xlsx_virtual_blanks(bundle, source, &targets)?;
    let observed = &observations[0];
    let manifest = bundle.manifest()?;
    if manifest.revision != observed.revision || manifest.root_hash != observed.root_hash {
        return Err(HcdError::RevisionConflict(
            "XLSX_CELL_INSPECTION_STALE".into(),
        ));
    }
    let (_source_dir, source_snapshot, _, _) = snapshot_xlsx_source(
        source,
        Some((&manifest.source.sha256, manifest.source.size_bytes)),
    )?;
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let work = tempfile::tempdir_in(parent)?;
    let current = work.path().join("current.xlsx");
    export_xlsx(
        bundle,
        &source_snapshot,
        &current,
        &ExportOptions {
            revision: Some(observed.revision),
            fidelity_report: None,
        },
    )?;
    let mut archive = StreamingOxmlArchive::open(&current).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let mut sheets = HashMap::new();
    for sheet in &workbook.sheets {
        if sheets
            .insert(sheet_grid_id(&observed.document_id, &sheet.part), sheet)
            .is_some()
        {
            return Err(HcdError::InvalidBundle(
                "duplicate XLSX sheet identity".into(),
            ));
        }
    }
    let mut grouped = BTreeMap::<String, BTreeMap<String, String>>::new();
    for (cell, observation) in cells.iter().zip(&observations) {
        let sheet = sheets
            .get(&observation.sheet_id)
            .ok_or_else(|| HcdError::InvalidPatch("XLSX_SHEET_NOT_FOUND".into()))?;
        if sheet.part != observation.sheet_part
            || sheet.name != observation.sheet_name
            || sheet.index != observation.sheet_index
            || sheet.state != observation.sheet_state
        {
            return Err(HcdError::RevisionConflict(
                "XLSX_CELL_INSPECTION_STALE".into(),
            ));
        }
        grouped
            .entry(sheet.part.clone())
            .or_default()
            .insert(observation.address.clone(), cell.text.clone());
    }
    let mut replacements = HashMap::new();
    for (index, (part, insertions)) in grouped.iter().enumerate() {
        let mut scan = archive
            .with_part(part, |input| {
                scan_worksheet_metadata(input, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        reject_formula_range_targets(&mut scan.formula_ranges, insertions.keys())?;
        reject_merged_covered_targets(&mut scan.merged_ranges, insertions.keys())?;
        let replacement = work.path().join(format!("worksheet-{index}.xml"));
        archive
            .with_part(part, |input| {
                let file = File::create(&replacement)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                let mut output = BufWriter::new(file);
                insert_virtual_worksheet_cells(input, &mut output, insertions)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                output
                    .flush()
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        replacements.insert(part.clone(), replacement);
    }
    let candidate = work.path().join("candidate.xlsx");
    StreamingOxmlRewriter::rewrite(&current, &candidate, &replacements, "xl/workbook.xml")
        .map_err(package_error)?;
    publish_virtual_candidate(bundle, source, &manifest, observed, &candidate, target)?;
    Ok(observations)
}

/// Check a current XLSX text patch against the immutable source, including
/// formula ranges absent from old HCD source maps. This does not mutate the
/// bundle or source and should be followed by the normal revision CAS.
pub fn validate_xlsx_source_text_edits(
    bundle: &Bundle,
    source: &Path,
    operations: &[hcd_core::PatchOperation],
) -> Result<(), HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" {
        return Err(HcdError::InvalidBundle("expected an XLSX document".into()));
    }
    let mut targets: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut virtual_targets: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let ids: Vec<String> = operations
        .iter()
        .filter_map(|operation| match operation {
            hcd_core::PatchOperation::TextSplice { node_id, .. }
            | hcd_core::PatchOperation::TextRuns { node_id, .. } => Some(node_id.clone()),
            _ => None,
        })
        .collect();
    let nodes = hcd_core::get_text_node_sources_in_manifest(bundle, &ids, &manifest)?;
    for (node_id, node) in nodes {
        if node.node_kind != "cell" {
            return Err(HcdError::InvalidPatch(
                "XLSX text target is not a cell".into(),
            ));
        }
        let reference = node
            .paragraph_id
            .ok_or_else(|| HcdError::InvalidBundle("XLSX cell has no source reference".into()))?;
        let destination = if node.text_id.as_deref() == Some(VIRTUAL_CELL_SOURCE) {
            if canonical_cell_reference(&reference).as_deref() != Some(reference.as_str())
                || node_id
                    != stable_node_id(&[&manifest.document_id, &node.part, "cell", &reference])
            {
                return Err(HcdError::InvalidBundle(
                    "invalid XLSX virtual cell identity".into(),
                ));
            }
            &mut virtual_targets
        } else {
            &mut targets
        };
        destination
            .entry(node.part)
            .or_default()
            .insert(reference, String::new());
    }
    if targets.is_empty() && virtual_targets.is_empty() {
        return Ok(());
    }
    let (_snapshot_dir, snapshot, _, _) = snapshot_xlsx_source(
        source,
        Some((&manifest.source.sha256, manifest.source.size_bytes)),
    )?;
    check_xlsx_formula_targets(&snapshot, &targets)?;
    check_xlsx_virtual_targets(&snapshot, &virtual_targets)
}

fn check_xlsx_virtual_targets(
    snapshot: &Path,
    targets: &HashMap<String, BTreeMap<String, String>>,
) -> Result<(), HcdError> {
    if targets.is_empty() {
        return Ok(());
    }
    let mut archive = StreamingOxmlArchive::open(snapshot).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let parts: HashSet<&str> = workbook
        .sheets
        .iter()
        .map(|sheet| sheet.part.as_str())
        .collect();
    for (part, cells) in targets {
        if !parts.contains(part.as_str()) {
            return Err(HcdError::InvalidBundle(
                "invalid XLSX cell source mapping".into(),
            ));
        }
        let mut scan = archive
            .with_part(part, |input| {
                scan_worksheet_metadata(input, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if scan.protected {
            return Err(HcdError::InvalidPatch("XLSX_SHEET_PROTECTED".into()));
        }
        reject_formula_range_targets(&mut scan.formula_ranges, cells.keys())?;
        let mut anchors = MergeCursor::new(scan.merged_ranges.ranges.clone());
        reject_merged_covered_targets(&mut scan.merged_ranges, cells.keys())?;
        let mut coordinates: Vec<_> = cells
            .keys()
            .map(|address| {
                cell_coordinates(address).ok_or_else(|| {
                    HcdError::InvalidBundle("invalid XLSX virtual cell reference".into())
                })
            })
            .collect::<Result<_, _>>()?;
        coordinates.sort_unstable();
        let mut current_row = None;
        for (row, column) in coordinates {
            if current_row != Some(row) {
                anchors.begin_row(row)?;
                current_row = Some(row);
            }
            if matches!(
                anchors.classify(row, column),
                Some(MergePosition::Anchor(_))
            ) {
                return Err(HcdError::Unsupported(
                    "XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED".into(),
                ));
            }
        }
        archive
            .with_part(part, |input| {
                insert_virtual_worksheet_cells(input, std::io::sink(), cells)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
    }
    Ok(())
}

/// Apply an XLSX patch using the original workbook to guard text targets.
/// Previously committed requests may replay without the source; an outdated
/// request without a matching receipt is still rejected by the core CAS.
/// Direct calls to `hcd_core::apply_patch` do not provide this XLSX guard.
pub fn apply_xlsx_patch_with_source(
    bundle: &Bundle,
    patch: &hcd_core::PatchBatch,
    expected_revision: u64,
    source: Option<&Path>,
) -> Result<hcd_core::ApplyResult, HcdError> {
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" {
        return Err(HcdError::InvalidBundle("expected an XLSX document".into()));
    }
    if expected_revision == manifest.revision
        && patch.operations.iter().any(|operation| {
            matches!(
                operation,
                hcd_core::PatchOperation::TextSplice { .. }
                    | hcd_core::PatchOperation::TextRuns { .. }
            )
        })
    {
        let source = source.filter(|source| source.is_file()).ok_or_else(|| {
            HcdError::InvalidPatch(
                "XLSX_SOURCE_MISSING: provide the original workbook; no text edit was saved".into(),
            )
        })?;
        validate_xlsx_source_text_edits(bundle, source, &patch.operations)?;
    }
    hcd_core::apply_patch(bundle, patch, expected_revision)
}

fn check_xlsx_formula_targets(
    snapshot: &Path,
    targets: &HashMap<String, BTreeMap<String, String>>,
) -> Result<(), HcdError> {
    let mut archive = StreamingOxmlArchive::open(snapshot).map_err(package_error)?;
    for (part, cells) in targets {
        let mut scan = archive
            .with_part(part, |input| {
                scan_worksheet_metadata(input, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        if scan.protected {
            return Err(HcdError::InvalidPatch("XLSX_SHEET_PROTECTED".into()));
        }
        reject_formula_range_targets(&mut scan.formula_ranges, cells.keys())?;
        reject_merged_covered_targets(&mut scan.merged_ranges, cells.keys())?;
        let mut rejected = None;
        archive
            .with_part(part, |input| {
                match rewrite_worksheet(input, std::io::sink(), cells) {
                    Err(HcdError::InvalidPatch(reason)) if reason == "XLSX_FORMULA_READ_ONLY" => {
                        rejected = Some(reason);
                        Ok(())
                    }
                    result => {
                        result.map_err(|error| PackageError::ReadPartError(error.to_string()))
                    }
                }
            })
            .map_err(package_error)?;
        if let Some(reason) = rejected {
            return Err(HcdError::InvalidPatch(reason));
        }
    }
    Ok(())
}

/// Audit the current XLSX editable cell mappings against a verified source.
/// This is read-only: a successful audit is not a signed proof and does not
/// migrate an existing document or authorize later source-free writes.
pub fn audit_xlsx_editable_formula_map(bundle: &Bundle, source: &Path) -> Result<usize, HcdError> {
    const MAX_AUDIT_CELLS: usize = 1_000_000;
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" {
        return Err(HcdError::InvalidBundle("expected an XLSX document".into()));
    }
    let validation = hcd_core::validate_bundle(bundle)?;
    if !validation.valid {
        return Err(HcdError::InvalidBundle("invalid XLSX bundle".into()));
    }
    let mut targets: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut virtual_targets: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut identities = HashSet::new();
    let mut count = 0usize;
    for page in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(&manifest, page)?.chunks {
            for entry in bundle.read_map_verified(&descriptor)?.entries {
                if !entry.source.editable {
                    continue;
                }
                if entry.source.node_kind != "cell" {
                    return Err(HcdError::InvalidBundle(
                        "XLSX editable target is not a cell".into(),
                    ));
                }
                count += 1;
                if count > MAX_AUDIT_CELLS {
                    return Err(HcdError::ResourceLimit(
                        "XLSX editable map audit cell limit".into(),
                    ));
                }
                let reference = entry.source.paragraph_id.ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX cell has no source reference".into())
                })?;
                if !identities.insert((entry.source.part.clone(), reference.clone())) {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX editable cell reference".into(),
                    ));
                }
                let destination = if entry.source.text_id.as_deref() == Some(VIRTUAL_CELL_SOURCE) {
                    if canonical_cell_reference(&reference).as_deref() != Some(reference.as_str())
                        || entry.node_id
                            != stable_node_id(&[
                                &manifest.document_id,
                                &entry.source.part,
                                "cell",
                                &reference,
                            ])
                    {
                        return Err(HcdError::InvalidBundle(
                            "invalid XLSX virtual cell identity".into(),
                        ));
                    }
                    &mut virtual_targets
                } else {
                    &mut targets
                };
                if destination
                    .entry(entry.source.part)
                    .or_default()
                    .insert(reference, String::new())
                    .is_some()
                {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX editable cell reference".into(),
                    ));
                }
            }
        }
    }
    let (_snapshot_dir, snapshot, _, _) = snapshot_xlsx_source(
        source,
        Some((&manifest.source.sha256, manifest.source.size_bytes)),
    )?;
    check_xlsx_formula_targets(&snapshot, &targets)?;
    check_xlsx_virtual_targets(&snapshot, &virtual_targets)?;
    Ok(count)
}

/// Identity of a verified audit result. This is data for an attestation, not
/// an attestation itself: authenticity must come from a trusted signer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxFormulaMappingAudit {
    pub document_id: String,
    pub revision: u64,
    pub source: hcd_core::SourceDescriptor,
    pub mapping_fingerprint: String,
    pub editable_cells_checked: usize,
}

// Mirrors the viewer's td[data-hcd-cell] and first descendant data-hcd-id
// binding, while rejecting ambiguous HTML instead of guessing how a browser
// will repair it. Canonical fragments are well-formed XML-compatible HTML.
fn visible_xlsx_cell_bindings(html: &str) -> Result<Vec<(String, Option<String>)>, HcdError> {
    fn attr(element: &BytesStart<'_>, name: &[u8]) -> Result<Option<String>, HcdError> {
        let mut found = None;
        for value in element.attributes() {
            let value = value
                .map_err(|_| HcdError::InvalidBundle("invalid XLSX HTML attributes".into()))?;
            if value.key.as_ref() == name {
                if found.is_some() {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX HTML attribute".into(),
                    ));
                }
                found = Some(
                    value
                        .unescape_value()
                        .map_err(|_| {
                            HcdError::InvalidBundle("invalid XLSX HTML attribute value".into())
                        })?
                        .into_owned(),
                );
            }
        }
        Ok(found)
    }
    let mut reader = Reader::from_str(html);
    reader.config_mut().check_end_names = true;
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut roots = 0usize;
    let mut active: Option<(usize, Option<String>, Option<String>)> = None;
    let mut result = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|_| HcdError::InvalidBundle("invalid XLSX grid HTML".into()))?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                let empty = matches!(event, Event::Empty(_));
                if ![
                    b"section".as_slice(),
                    b"table",
                    b"colgroup",
                    b"col",
                    b"tbody",
                    b"tr",
                    b"td",
                    b"span",
                ]
                .contains(&element.name().as_ref())
                {
                    return Err(HcdError::InvalidBundle(
                        "unsupported XLSX grid HTML element".into(),
                    ));
                }
                let tag = element.name().as_ref().to_vec();
                let parent = stack.last().map(Vec::as_slice);
                let valid_parent = match tag.as_slice() {
                    b"section" => parent.is_none(),
                    b"table" => parent == Some(b"section"),
                    b"colgroup" | b"tbody" => parent == Some(b"table"),
                    b"col" => parent == Some(b"colgroup"),
                    b"tr" => parent == Some(b"tbody"),
                    b"td" => parent == Some(b"tr"),
                    b"span" => parent == Some(b"td"),
                    _ => false,
                };
                if !valid_parent {
                    return Err(HcdError::InvalidBundle(
                        "invalid XLSX grid HTML structure".into(),
                    ));
                }
                if parent.is_none() {
                    roots += 1;
                    if roots > 1 {
                        return Err(HcdError::InvalidBundle("multiple XLSX grid roots".into()));
                    }
                }
                // HTML names are case-insensitive; accepting XML-only spelling
                // would make this check disagree with the browser's DOM.
                for value in element.attributes() {
                    let value = value.map_err(|_| {
                        HcdError::InvalidBundle("invalid XLSX HTML attributes".into())
                    })?;
                    if value
                        .key
                        .as_ref()
                        .iter()
                        .any(|byte| byte.is_ascii_uppercase() || *byte == b':')
                    {
                        return Err(HcdError::InvalidBundle(
                            "unsupported XLSX HTML attribute name".into(),
                        ));
                    }
                }
                if !empty {
                    depth += 1;
                    stack.push(tag);
                }
                if depth > 256 {
                    return Err(HcdError::ResourceLimit("XLSX grid HTML depth".into()));
                }
                if element.name().as_ref() == b"td" {
                    if active.is_some() {
                        return Err(HcdError::InvalidBundle("nested XLSX cell".into()));
                    }
                    let position = attr(element, b"data-hcd-cell")?;
                    let id = attr(element, b"data-hcd-id")?;
                    if id.is_some() {
                        return Err(HcdError::InvalidBundle(
                            "XLSX cell ID must be a descendant".into(),
                        ));
                    }
                    if empty {
                        if let Some(position) = position {
                            result.push((position, None));
                        }
                    } else {
                        active = Some((depth, position, None));
                    }
                } else if let Some((_, _, id)) = active.as_mut() {
                    if let Some(value) = attr(element, b"data-hcd-id")? {
                        if id.replace(value).is_some() {
                            return Err(HcdError::InvalidBundle("ambiguous XLSX cell node".into()));
                        }
                    }
                }
            }
            Event::End(ref element) => {
                if element.name().as_ref() == b"td" {
                    let (start, position, id) = active
                        .take()
                        .ok_or_else(|| HcdError::InvalidBundle("unmatched XLSX cell".into()))?;
                    if start != depth {
                        return Err(HcdError::InvalidBundle("invalid XLSX cell nesting".into()));
                    }
                    if let Some(position) = position {
                        result.push((position, id));
                    } else if id.is_some() {
                        return Err(HcdError::InvalidBundle(
                            "XLSX node has no visible coordinate".into(),
                        ));
                    }
                }
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| HcdError::InvalidBundle("invalid XLSX HTML depth".into()))?;
                stack.pop();
            }
            Event::Text(ref value)
                if stack.last().map(Vec::as_slice) != Some(b"span")
                    && !value.as_ref().iter().all(u8::is_ascii_whitespace) =>
            {
                return Err(HcdError::InvalidBundle(
                    "unexpected text in XLSX grid structure".into(),
                ));
            }
            Event::CData(_) | Event::DocType(_) | Event::PI(_) => {
                return Err(HcdError::InvalidBundle(
                    "unsupported XLSX grid HTML content".into(),
                ))
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if active.is_some() || depth != 0 || roots != 1 {
        return Err(HcdError::InvalidBundle("unclosed XLSX grid HTML".into()));
    }
    Ok(result)
}

fn check_visible_xlsx_cells(
    html: &str,
    entries: &[NodeMapEntry],
    document_id: &str,
    sheet_id: &str,
    visible_positions: &mut BTreeSet<(String, String)>,
) -> Result<(), HcdError> {
    let entries_by_id: HashMap<_, _> = entries
        .iter()
        .map(|entry| (entry.node_id.as_str(), &entry.source))
        .collect();
    let mut visible_nodes = BTreeSet::new();
    for (reference, id) in visible_xlsx_cell_bindings(html)? {
        if visible_positions.len() >= 1_000_000 {
            return Err(HcdError::ResourceLimit(
                "XLSX visible cell audit limit".into(),
            ));
        }
        if reference.bytes().any(|byte| !byte.is_ascii_alphanumeric()) {
            return Err(HcdError::InvalidBundle(
                "invalid visible XLSX cell reference".into(),
            ));
        }
        let canonical = canonical_cell_reference(&reference)
            .ok_or_else(|| HcdError::InvalidBundle("invalid visible XLSX cell reference".into()))?;
        if !visible_positions.insert((sheet_id.to_owned(), canonical.clone())) {
            return Err(HcdError::InvalidBundle(
                "duplicate visible XLSX cell".into(),
            ));
        }
        if let Some(id) = id {
            let source = entries_by_id.get(id.as_str()).ok_or_else(|| {
                HcdError::InvalidBundle("visible XLSX cell has no source mapping".into())
            })?;
            if source.node_kind != "cell"
                || source.paragraph_id.as_deref() != Some(canonical.as_str())
                || sheet_grid_id(document_id, &source.part) != sheet_id
                || !visible_nodes.insert(id)
            {
                return Err(HcdError::InvalidBundle(
                    "visible XLSX cell does not match its source mapping".into(),
                ));
            }
        }
    }
    if entries
        .iter()
        .any(|entry| entry.source.node_kind == "cell" && !visible_nodes.contains(&entry.node_id))
    {
        return Err(HcdError::InvalidBundle(
            "mapped XLSX cell is not uniquely visible".into(),
        ));
    }
    Ok(())
}

/// Hash every node's source identity and its displayed grid window, including
/// read-only nodes. Text hashes are deliberately excluded so ordinary text
/// saves do not invalidate the mapping identity. Call on a pinned snapshot or
/// under a lock; a bare fingerprint is not proof of a source audit.
pub fn xlsx_formula_mapping_fingerprint(bundle: &Bundle) -> Result<String, HcdError> {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    const MAX_MAPPED_NODES: usize = 1_000_000;
    let manifest = bundle.manifest()?;
    if manifest.source.format != "xlsx" {
        return Err(HcdError::InvalidBundle("expected an XLSX document".into()));
    }
    let mut nodes = BTreeMap::new();
    let mut visible_positions = BTreeSet::new();
    for page in 0..manifest.index_page_count {
        for chunk in bundle.read_index_page(&manifest, page)?.chunks {
            let grid = chunk.grid.clone();
            let entries = bundle.read_map_verified(&chunk)?.entries;
            if let Some(address) = grid
                .as_ref()
                .filter(|grid| grid.kind == GridChunkKind::Cells)
            {
                let html = bundle.read_chunk_verified(&chunk)?;
                check_visible_xlsx_cells(
                    &html,
                    &entries,
                    &manifest.document_id,
                    &address.sheet_id,
                    &mut visible_positions,
                )?;
            } else if entries.iter().any(|entry| entry.source.node_kind == "cell") {
                return Err(HcdError::InvalidBundle(
                    "mapped XLSX cell has no grid window".into(),
                ));
            }
            for entry in entries {
                if nodes.len() >= MAX_MAPPED_NODES {
                    return Err(HcdError::ResourceLimit(
                        "XLSX mapping identity node limit".into(),
                    ));
                }
                if nodes
                    .insert(entry.node_id, (entry.source, grid.clone()))
                    .is_some()
                {
                    return Err(HcdError::InvalidBundle(
                        "duplicate XLSX mapping node ID".into(),
                    ));
                }
            }
        }
    }
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(
        &mut writer,
        &(
            "hcd-xlsx-formula-mapping/1",
            &manifest.document_id,
            &manifest.source,
            &nodes,
        ),
    )?;
    Ok(format!("{:x}", writer.0.finalize()))
}

/// Audit and fingerprint a single immutable HCD snapshot against an immutable
/// copy of the matching XLSX source. No proof is signed or persisted here.
pub fn audit_xlsx_formula_mapping_snapshot(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<XlsxFormulaMappingAudit, HcdError> {
    let snapshot = hcd_core::create_portable_snapshot(bundle, revision)?;
    let frozen = Bundle::open(snapshot.directory.path())?;
    let count = audit_xlsx_editable_formula_map(&frozen, source)?;
    let fingerprint = xlsx_formula_mapping_fingerprint(&frozen)?;
    Ok(XlsxFormulaMappingAudit {
        document_id: snapshot.manifest.document_id,
        revision: snapshot.manifest.revision,
        source: snapshot.manifest.source,
        mapping_fingerprint: fingerprint,
        editable_cells_checked: count,
    })
}

fn rewrite_worksheet(
    source: &mut dyn Read,
    output: impl Write,
    replacements: &BTreeMap<String, String>,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut skip_depth = 0usize;
    let mut seen = BTreeSet::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("worksheet export XML: {error}")))?;
        if skip_depth > 0 {
            // Older bundles may have misclassified a shared-formula follower
            // whose <f/> element is empty. Never replace any source formula,
            // even if a stale source map incorrectly marks the cell editable.
            if matches!(&event, Event::Start(start) | Event::Empty(start) if local_name(start.name().as_ref()) == "f")
            {
                return Err(HcdError::InvalidPatch("XLSX_FORMULA_READ_ONLY".to_string()));
            }
            match event {
                Event::Start(_) => skip_depth += 1,
                Event::End(_) => skip_depth -= 1,
                Event::Eof => {
                    return Err(HcdError::InvalidBundle(
                        "target cell ended at worksheet EOF".to_string(),
                    ))
                }
                _ => {}
            }
            buffer.clear();
            continue;
        }
        match event {
            Event::Start(ref start) if local_name(start.name().as_ref()) == "c" => {
                let reference = attribute(start, "r").unwrap_or_default();
                if let Some(text) = replacements.get(&reference) {
                    write_inline_cell(&mut writer, start, text)?;
                    seen.insert(reference);
                    skip_depth = 1;
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "c" => {
                let reference = attribute(empty, "r").unwrap_or_default();
                if let Some(text) = replacements.get(&reference) {
                    write_inline_cell(&mut writer, empty, text)?;
                    seen.insert(reference);
                } else {
                    writer.write_event(event.into_owned())?;
                }
            }
            Event::Eof => break,
            _ => writer.write_event(event.into_owned())?,
        }
        buffer.clear();
    }
    if seen.len() != replacements.len() {
        let missing: Vec<_> = replacements
            .keys()
            .filter(|cell| !seen.contains(*cell))
            .cloned()
            .collect();
        return Err(HcdError::InvalidBundle(format!(
            "worksheet is missing mapped cells {missing:?}"
        )));
    }
    Ok(())
}

/// Insert explicitly authorized, absent cells into sheetData. The caller must
/// validate the immutable source and reject protected formula/merge targets
/// before calling this function, and must write to a disposable candidate.
/// This is not yet wired to HCD export or an edit endpoint.
fn insert_virtual_worksheet_cells(
    source: &mut dyn Read,
    output: impl Write,
    insertions: &BTreeMap<String, String>,
) -> Result<(), HcdError> {
    if insertions.is_empty() || insertions.len() > 4000 {
        return Err(HcdError::InvalidPatch("XLSX_INSERT_COUNT".into()));
    }
    let mut pending = BTreeMap::<(u32, u32), (&str, &str)>::new();
    for (address, value) in insertions {
        let (row, col) = cell_coordinates(address)
            .filter(|_| canonical_cell_reference(address).as_deref() == Some(address.as_str()))
            .ok_or_else(|| HcdError::InvalidPatch("invalid XLSX cell address".into()))?;
        if value.len() > MAX_CHUNK_BYTES
            || value.chars().any(|c| !matches!(c as u32, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF))
            || pending.insert((row, col), (address, value)).is_some()
        {
            return Err(HcdError::InvalidPatch("XLSX_INSERT_INVALID".into()));
        }
    }
    let min_row = pending.keys().map(|(row, _)| *row).min().expect("nonempty");
    let max_row = pending.keys().map(|(row, _)| *row).max().expect("nonempty");
    let min_col = pending.keys().map(|(_, col)| *col).min().expect("nonempty");
    let max_col = pending.keys().map(|(_, col)| *col).max().expect("nonempty");
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::new();
    let mut budget = XmlBudget::default();
    let mut depth = 0usize;
    let mut sheet_depth = None;
    let mut current_row = None;
    let mut last_row = 0u32;
    let mut last_col = 0u32;
    let mut row_tail_started = false;
    let mut prefix = String::new();
    let mut saw_sheet_data = false;

    fn write_cell(
        writer: &mut Writer<impl Write>,
        prefix: &str,
        address: &str,
        value: &str,
    ) -> Result<(), HcdError> {
        let mut cell = BytesStart::new(format!("{prefix}c"));
        cell.push_attribute(("r", address));
        cell.push_attribute(("t", "inlineStr"));
        writer.write_event(Event::Start(cell))?;
        writer.write_event(Event::Start(BytesStart::new(format!("{prefix}is"))))?;
        let mut text = BytesStart::new(format!("{prefix}t"));
        if value.starts_with(char::is_whitespace) || value.ends_with(char::is_whitespace) {
            text.push_attribute(("xml:space", "preserve"));
        }
        writer.write_event(Event::Start(text))?;
        writer.write_event(Event::Text(quick_xml::events::BytesText::new(value)))?;
        writer.write_event(Event::End(quick_xml::events::BytesEnd::new(format!(
            "{prefix}t"
        ))))?;
        writer.write_event(Event::End(quick_xml::events::BytesEnd::new(format!(
            "{prefix}is"
        ))))?;
        writer.write_event(Event::End(quick_xml::events::BytesEnd::new(format!(
            "{prefix}c"
        ))))?;
        Ok(())
    }
    fn flush_cells(
        writer: &mut Writer<impl Write>,
        prefix: &str,
        pending: &mut BTreeMap<(u32, u32), (&str, &str)>,
        row: u32,
        before: u32,
    ) -> Result<(), HcdError> {
        let keys: Vec<_> = pending
            .range((row, 0)..(row, before))
            .map(|(key, _)| *key)
            .collect();
        for key in keys {
            let (address, value) = pending.remove(&key).expect("collected key");
            write_cell(writer, prefix, address, value)?;
        }
        Ok(())
    }
    fn flush_rows(
        writer: &mut Writer<impl Write>,
        prefix: &str,
        pending: &mut BTreeMap<(u32, u32), (&str, &str)>,
        before: u32,
    ) -> Result<(), HcdError> {
        while let Some((&(row, _), _)) = pending.first_key_value() {
            if row >= before {
                break;
            }
            let name = format!("{prefix}row");
            let mut tag = BytesStart::new(name.clone());
            let number = row.to_string();
            tag.push_attribute(("r", number.as_str()));
            writer.write_event(Event::Start(tag))?;
            flush_cells(writer, prefix, pending, row, u32::MAX)?;
            writer.write_event(Event::End(quick_xml::events::BytesEnd::new(name)))?;
        }
        Ok(())
    }
    fn row_without_spans(tag: &BytesStart<'_>) -> Result<BytesStart<'static>, HcdError> {
        let mut result = BytesStart::new(String::from_utf8_lossy(tag.name().as_ref()).to_string());
        for attr in tag.attributes() {
            let attr = attr.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
            if local_name(attr.key.as_ref()) == "spans" {
                continue;
            }
            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
            let value = attr
                .unescape_value()
                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                .into_owned();
            result.push_attribute((key.as_str(), value.as_str()));
        }
        Ok(result)
    }
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("worksheet insertion XML: {error}"))
        })?;
        budget.observe(&event, "worksheet")?;
        let local = match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                Some(local_name(tag.name().as_ref()).to_owned())
            }
            Event::End(tag) => Some(local_name(tag.name().as_ref()).to_owned()),
            _ => None,
        };
        match &event {
            Event::Start(tag) | Event::Empty(tag)
                if depth == 1 && local.as_deref() == Some("dimension") =>
            {
                let reference = attribute(tag, "ref").ok_or_else(|| {
                    HcdError::InvalidBundle("worksheet dimension has no reference".into())
                })?;
                let range = if let Some(range) = parse_merge_reference(&reference) {
                    range
                } else {
                    let (row, col) = cell_coordinates(&reference).ok_or_else(|| {
                        HcdError::InvalidBundle("invalid worksheet dimension".into())
                    })?;
                    MergeRange {
                        start_row: row,
                        end_row: row,
                        start_col: col,
                        end_col: col,
                    }
                };
                let reference = format!(
                    "{}{}:{}{}",
                    column_name(range.start_col.min(min_col)),
                    range.start_row.min(min_row),
                    column_name(range.end_col.max(max_col)),
                    range.end_row.max(max_row)
                );
                let name = String::from_utf8_lossy(tag.name().as_ref()).to_string();
                let mut updated = BytesStart::new(name);
                for attr in tag.attributes() {
                    let attr = attr.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                    if local_name(attr.key.as_ref()) == "ref" {
                        continue;
                    }
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let value = attr
                        .unescape_value()
                        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                        .into_owned();
                    updated.push_attribute((key.as_str(), value.as_str()));
                }
                updated.push_attribute(("ref", reference.as_str()));
                writer.write_event(if matches!(event, Event::Empty(_)) {
                    Event::Empty(updated)
                } else {
                    Event::Start(updated)
                })?;
            }
            Event::Start(tag) if local.as_deref() == Some("sheetData") && sheet_depth.is_none() => {
                if saw_sheet_data {
                    return Err(HcdError::InvalidBundle("duplicate sheetData".into()));
                }
                saw_sheet_data = true;
                sheet_depth = Some(depth + 1);
                let name = String::from_utf8_lossy(tag.name().as_ref()).to_string();
                prefix = name
                    .rsplit_once(':')
                    .map(|(part, _)| format!("{part}:"))
                    .unwrap_or_default();
                writer.write_event(event.clone().into_owned())?;
            }
            Event::Empty(tag) if local.as_deref() == Some("sheetData") && sheet_depth.is_none() => {
                if saw_sheet_data {
                    return Err(HcdError::InvalidBundle("duplicate sheetData".into()));
                }
                saw_sheet_data = true;
                let name = String::from_utf8_lossy(tag.name().as_ref()).to_string();
                prefix = name
                    .rsplit_once(':')
                    .map(|(part, _)| format!("{part}:"))
                    .unwrap_or_default();
                writer.write_event(Event::Start(tag.to_owned()))?;
                flush_rows(&mut writer, &prefix, &mut pending, u32::MAX)?;
                writer.write_event(Event::End(quick_xml::events::BytesEnd::new(name)))?;
            }
            Event::Start(tag) | Event::Empty(tag)
                if sheet_depth == Some(depth) && local.as_deref() == Some("row") =>
            {
                let row = attribute(tag, "r")
                    .and_then(|v| v.parse::<u32>().ok())
                    .filter(|row| *row > last_row && *row <= 1_048_576)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid or unordered worksheet row".into())
                    })?;
                flush_rows(&mut writer, &prefix, &mut pending, row)?;
                last_row = row;
                last_col = 0;
                row_tail_started = false;
                let touched = pending.range((row, 0)..=(row, u32::MAX)).next().is_some();
                if matches!(event, Event::Empty(_)) && touched {
                    let name = String::from_utf8_lossy(tag.name().as_ref()).to_string();
                    writer.write_event(Event::Start(row_without_spans(tag)?))?;
                    flush_cells(&mut writer, &prefix, &mut pending, row, u32::MAX)?;
                    writer.write_event(Event::End(quick_xml::events::BytesEnd::new(name)))?;
                } else {
                    if touched {
                        writer.write_event(Event::Start(row_without_spans(tag)?))?
                    } else {
                        writer.write_event(event.clone().into_owned())?
                    }
                    if matches!(event, Event::Start(_)) {
                        current_row = Some(row)
                    }
                }
            }
            Event::Start(tag) | Event::Empty(tag)
                if current_row.is_some()
                    && sheet_depth == Some(depth - 1)
                    && local.as_deref() == Some("c") =>
            {
                if row_tail_started {
                    return Err(HcdError::InvalidBundle("cell after row extension".into()));
                }
                let row = current_row.expect("checked row");
                let (cell_row, col) = attribute(tag, "r")
                    .and_then(|v| cell_coordinates(&v))
                    .filter(|(r, c)| *r == row && *c > last_col)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid or unordered worksheet cell".into())
                    })?;
                if pending.contains_key(&(cell_row, col)) {
                    return Err(HcdError::InvalidPatch("XLSX_CELL_ALREADY_PRESENT".into()));
                }
                flush_cells(&mut writer, &prefix, &mut pending, row, col)?;
                last_col = col;
                writer.write_event(event.clone().into_owned())?;
            }
            Event::Start(_) | Event::Empty(_)
                if current_row.is_some()
                    && sheet_depth == Some(depth - 1)
                    && local.as_deref() == Some("extLst") =>
            {
                row_tail_started = true;
                flush_cells(
                    &mut writer,
                    &prefix,
                    &mut pending,
                    current_row.expect("checked row"),
                    u32::MAX,
                )?;
                writer.write_event(event.clone().into_owned())?;
            }
            Event::End(_)
                if current_row.is_some()
                    && sheet_depth == Some(depth - 1)
                    && local.as_deref() == Some("row") =>
            {
                flush_cells(
                    &mut writer,
                    &prefix,
                    &mut pending,
                    current_row.take().expect("checked row"),
                    u32::MAX,
                )?;
                writer.write_event(event.clone().into_owned())?;
            }
            Event::End(_)
                if sheet_depth == Some(depth) && local.as_deref() == Some("sheetData") =>
            {
                flush_rows(&mut writer, &prefix, &mut pending, u32::MAX)?;
                sheet_depth = None;
                writer.write_event(event.clone().into_owned())?;
            }
            Event::Eof => {
                budget.finish("worksheet")?;
                break;
            }
            _ => writer.write_event(event.clone().into_owned())?,
        }
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| HcdError::InvalidBundle("invalid XML depth".into()))?
            }
            _ => {}
        }
        buffer.clear();
    }
    if !saw_sheet_data || !pending.is_empty() {
        return Err(HcdError::InvalidBundle(
            "worksheet has no writable sheetData".into(),
        ));
    }
    Ok(())
}

fn write_inline_cell(
    writer: &mut Writer<impl Write>,
    original: &BytesStart<'_>,
    text: &str,
) -> Result<(), HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).to_string();
    let mut start = BytesStart::new(name);
    let mut attributes = Vec::new();
    for attribute in original.attributes().with_checks(false).flatten() {
        let key = String::from_utf8_lossy(attribute.key.as_ref()).to_string();
        if local_name(attribute.key.as_ref()) != "t" {
            attributes.push((
                key,
                String::from_utf8_lossy(attribute.value.as_ref()).to_string(),
            ));
        }
    }
    for (key, value) in &attributes {
        start.push_attribute((key.as_str(), value.as_str()));
    }
    start.push_attribute(("t", "inlineStr"));
    writer.write_event(Event::Start(start))?;
    writer.write_event(Event::Start(BytesStart::new("is")))?;
    let mut text_start = BytesStart::new("t");
    if text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace) {
        text_start.push_attribute(("xml:space", "preserve"));
    }
    writer.write_event(Event::Start(text_start))?;
    if !text.is_empty() {
        writer.write_event(Event::Text(BytesText::new(text)))?;
    }
    writer.write_event(Event::End(BytesEnd::new("t")))?;
    writer.write_event(Event::End(BytesEnd::new("is")))?;
    writer.write_event(Event::End(BytesEnd::new(String::from_utf8_lossy(
        original.name().as_ref(),
    ))))?;
    Ok(())
}

fn resolve_part(source_part: &str, target: &str) -> Result<String, HcdError> {
    let base = Path::new(source_part)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let combined = if target.starts_with('/') {
        PathBuf::from(target.trim_start_matches('/'))
    } else {
        base.join(target)
    };
    let mut output = PathBuf::new();
    for component in combined.components() {
        match component {
            Component::Normal(value) => output.push(value),
            Component::ParentDir => {
                if !output.pop() {
                    return Err(HcdError::InvalidBundle(format!(
                        "relationship escapes package: {target}"
                    )));
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(HcdError::InvalidBundle(format!(
                    "unsafe relationship target: {target}"
                )))
            }
        }
    }
    Ok(output.to_string_lossy().replace('\\', "/"))
}

fn attribute(element: &BytesStart<'_>, wanted: &str) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| local_name(attribute.key.as_ref()) == wanted)
        .and_then(|attribute| {
            attribute
                .unescape_value()
                .ok()
                .map(|value| value.into_owned())
        })
}

fn local_name(name: &[u8]) -> &str {
    let local = name
        .iter()
        .rposition(|byte| *byte == b':')
        .map(|index| &name[index + 1..])
        .unwrap_or(name);
    std::str::from_utf8(local).unwrap_or("")
}

fn package_error(error: PackageError) -> HcdError {
    match error {
        PackageError::ResourceLimit(message) => HcdError::ResourceLimit(message),
        other => HcdError::InvalidBundle(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        extract_text_page, validate_bundle, NodePrecondition, PatchBatch, PatchOperation,
        HCD_PATCH_SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn checked_virtual_cells_commit_replay_edit_and_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        create_shared_string_fixture(&source);
        let path = temp.path().join("document.hcd");
        import_xlsx(&source, &path, &ImportOptions::new("grid-create"), |_| {
            Ok(())
        })
        .unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let initial = bundle.manifest().unwrap();
        let part = "xl/worksheets/sheet1.xml";
        let sheet_id = sheet_grid_id("grid-create", part);
        let request = hcd_core::GridCreateRequest {
            document_id: "grid-create".into(),
            patch_id: "create-1".into(),
            base_revision: 0,
            source_sha256: initial.source.sha256.clone(),
            actor: BTreeMap::new(),
            cells: vec![hcd_core::GridCellCreate {
                sheet_id: sheet_id.clone(),
                sheet_part: part.into(),
                row: 3,
                column: 12,
                text: "New 😀".into(),
            }],
        };
        let mut checks = 0;
        let rejected = hcd_core::apply_checked_grid_cells(&bundle, &request, |_, _, _| {
            checks += 1;
            if checks == 2 {
                Err(HcdError::RevisionConflict("source changed".into()))
            } else {
                Ok(())
            }
        });
        assert!(rejected.is_err());
        assert_eq!(checks, 2);
        assert_eq!(bundle.manifest().unwrap().root_hash, initial.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let mut mixed = request.clone();
        mixed.patch_id = "mixed".into();
        mixed.cells.push(hcd_core::GridCellCreate {
            sheet_id: sheet_id.clone(),
            sheet_part: part.into(),
            row: 1,
            column: 1,
            text: "overwrite".into(),
        });
        assert!(create_xlsx_virtual_cells(&bundle, &source, &mixed).is_err());
        assert_eq!(bundle.manifest().unwrap().root_hash, initial.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let mut merge_anchor = request.clone();
        merge_anchor.patch_id = "merged-anchor".into();
        merge_anchor.cells[0].row = 4;
        merge_anchor.cells[0].column = 4;
        assert!(create_xlsx_virtual_cells(&bundle, &source, &merge_anchor)
            .unwrap_err()
            .to_string()
            .contains("XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED"));
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let result = create_xlsx_virtual_cells(&bundle, &source, &request).unwrap();
        assert_eq!(result.revision, 1);
        let head = bundle.manifest().unwrap();
        let created = bundle
            .read_index_page(&head, head.index_page_count - 1)
            .unwrap()
            .chunks
            .last()
            .unwrap()
            .clone();
        assert!(!bundle
            .read_chunk(&created)
            .unwrap()
            .contains("data-hcd-row=\""));
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let audit = audit_xlsx_formula_mapping_snapshot(&bundle, &source, Some(1)).unwrap();
        assert_eq!(audit.revision, 1);
        assert!(audit.editable_cells_checked > 0);
        assert_eq!(
            audit.mapping_fingerprint,
            xlsx_formula_mapping_fingerprint(&bundle).unwrap()
        );
        let id = stable_node_id(&["grid-create", part, "cell", "L3"]);
        assert_eq!(
            hcd_core::get_text_node(&bundle, &id).unwrap().node.text,
            "New 😀"
        );
        assert!(
            create_xlsx_virtual_cells(&bundle, &source, &request)
                .unwrap()
                .idempotent_replay
        );
        let mut changed_request = request.clone();
        changed_request.cells[0].text = "different".into();
        assert!(create_xlsx_virtual_cells(&bundle, &source, &changed_request).is_err());
        let mut conflicting = request.clone();
        conflicting.patch_id = "other".into();
        assert!(create_xlsx_virtual_cells(&bundle, &source, &conflicting).is_err());
        conflicting.base_revision = 1;
        assert!(create_xlsx_virtual_cells(&bundle, &source, &conflicting).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let original_export = temp.path().join("r0.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &original_export,
            &ExportOptions {
                revision: Some(0),
                fidelity_report: None,
            },
        )
        .unwrap();
        assert!(!read_zip_entry(&original_export, part).contains("New 😀"));
        let export = temp.path().join("r1.xlsx");
        export_xlsx(&bundle, &source, &export, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&export, part).contains("New 😀"));
        let node = hcd_core::get_text_node(&bundle, &id).unwrap().node;
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "grid-create".into(),
            patch_id: "edit-2".into(),
            base_revision: 1,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: id,
                start: 0,
                delete_count: 0,
                insert_text: "Edited ".into(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        };
        apply_xlsx_patch_with_source(&bundle, &patch, 1, Some(&source)).unwrap();
        let export2 = temp.path().join("r2.xlsx");
        export_xlsx(&bundle, &source, &export2, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&export2, part).contains("Edited New 😀"));
        assert!(validate_bundle(&bundle).unwrap().valid);
        let mut second = request.clone();
        second.patch_id = "create-3".into();
        second.base_revision = 2;
        second.cells[0].column = 13;
        second.cells[0].text = "Second".into();
        assert_eq!(
            create_xlsx_virtual_cells(&bundle, &source, &second)
                .unwrap()
                .revision,
            3
        );
        let export3 = temp.path().join("r3.xlsx");
        export_xlsx(&bundle, &source, &export3, &ExportOptions::default()).unwrap();
        let output = read_zip_entry(&export3, part);
        assert!(output.contains("Edited New 😀") && output.contains("Second"));
        assert!(validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn checked_virtual_cell_competing_creations_do_not_both_commit() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        create_shared_string_fixture(&source);
        let path = temp.path().join("document.hcd");
        import_xlsx(&source, &path, &ImportOptions::new("grid-race"), |_| Ok(())).unwrap();
        let initial = Bundle::open(&path).unwrap().manifest().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut threads = Vec::new();
        for user in ["alice", "bob"] {
            let barrier = barrier.clone();
            let source = source.clone();
            let path = path.clone();
            let source_hash = initial.source.sha256.clone();
            threads.push(std::thread::spawn(move || {
                let bundle = Bundle::open(path).unwrap();
                let part = "xl/worksheets/sheet1.xml";
                let request = hcd_core::GridCreateRequest {
                    document_id: "grid-race".into(),
                    patch_id: user.into(),
                    base_revision: 0,
                    source_sha256: source_hash,
                    actor: BTreeMap::new(),
                    cells: vec![hcd_core::GridCellCreate {
                        sheet_id: sheet_grid_id("grid-race", part),
                        sheet_part: part.into(),
                        row: 3,
                        column: 12,
                        text: user.into(),
                    }],
                };
                barrier.wait();
                create_xlsx_virtual_cells(&bundle, &source, &request)
            }));
        }
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let bundle = Bundle::open(path).unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn marked_virtual_cells_export_with_existing_edits_and_reject_existing_source_cells() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        let source = temp.path().join("book.xlsx");
        create_shared_string_fixture(&original);
        let mut input = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                bytes = String::from_utf8(bytes).unwrap().replace(
                    "</row><row r=\"4\"/>",
                    "<c r=\"J3\"><f t=\"array\" ref=\"J3:K3\">1+2</f><v>3</v></c></row><row r=\"4\"/>",
                ).into_bytes();
            }
            output
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        let imported = temp.path().join("imported.hcd");
        import_xlsx(
            &source,
            &imported,
            &ImportOptions::new("virtual-export"),
            |_| Ok(()),
        )
        .unwrap();
        let initial = Bundle::open(&imported).unwrap().manifest().unwrap();
        let part = "xl/worksheets/sheet1.xml";

        for (address, should_succeed) in [("L3", true), ("A1", false), ("K3", false)] {
            let path = temp.path().join(format!("{address}.hcd"));
            let mut writer = hcd_core::BundleWriter::create(&path).unwrap();
            writer.write_styles("").unwrap();
            let node_id = stable_node_id(&["virtual-export", part, "cell", address]);
            let hash = hash_bytes(b"");
            let existing_id = stable_node_id(&["virtual-export", part, "cell", "C3"]);
            let existing_hash = hash_bytes(b"After merge");
            let id = "c_11111111111111111111111111111111".to_string();
            let html = format!("<section data-hcd-sheet=\"Shared\"><table><tr><td data-hcd-cell=\"C3\"><span data-hcd-id=\"{existing_id}\" data-hcd-node-hash=\"{existing_hash}\">After merge</span></td><td data-hcd-cell=\"{address}\"><span data-hcd-id=\"{node_id}\" data-hcd-node-hash=\"{hash}\"></span></td></tr></table></section>");
            let map = ChunkSourceMap {
                schema_version: HCD_SCHEMA_VERSION.to_string(),
                chunk_id: id.clone(),
                entries: vec![
                    NodeMapEntry {
                        node_id: existing_id.clone(),
                        node_hash: existing_hash.clone(),
                        source: SourceAnchor {
                            part: part.into(),
                            text_ordinal: 1,
                            paragraph_id: Some("C3".into()),
                            text_id: None,
                            node_kind: "cell".into(),
                            editable: true,
                        },
                    },
                    NodeMapEntry {
                        node_id: node_id.clone(),
                        node_hash: hash.clone(),
                        source: SourceAnchor {
                            part: part.into(),
                            text_ordinal: 0,
                            paragraph_id: Some(address.into()),
                            text_id: Some(VIRTUAL_CELL_SOURCE.into()),
                            node_kind: "cell".into(),
                            editable: true,
                        },
                    },
                ],
            };
            writer
                .write_chunk(id, "sheet".into(), html, map, 1, false)
                .unwrap();
            writer.finish(initial.clone()).unwrap();
            let bundle = Bundle::open(&path).unwrap();
            let patch = PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "virtual-export".into(),
                patch_id: "edit".into(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![
                    PatchOperation::TextSplice {
                        node_id,
                        start: 0,
                        delete_count: 0,
                        insert_text: "New 😀".into(),
                        precondition: NodePrecondition { node_hash: hash },
                    },
                    PatchOperation::TextSplice {
                        node_id: existing_id,
                        start: 0,
                        delete_count: 0,
                        insert_text: "Changed ".into(),
                        precondition: NodePrecondition {
                            node_hash: existing_hash,
                        },
                    },
                ],
            };
            if should_succeed {
                apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source)).unwrap();
            } else {
                assert!(apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source)).is_err());
                assert_eq!(bundle.manifest().unwrap().revision, 0);
                // Simulate an old or direct-core version to verify the export guard.
                hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
            }
            let target = temp.path().join(format!("{address}.xlsx"));
            let result = export_xlsx(&bundle, &source, &target, &ExportOptions::default());
            if should_succeed {
                result.unwrap();
                let xml = read_zip_entry(&target, part);
                assert!(xml.contains("New 😀"));
                assert!(xml.contains("Changed After merge"));
                assert!(xml.contains("<f t=\"array\" ref=\"J3:K3\">1+2</f><v>3</v>"));
                let reimport = temp.path().join("reimported.hcd");
                import_xlsx(&target, &reimport, &ImportOptions::new("roundtrip"), |_| {
                    Ok(())
                })
                .unwrap();
                let reopened = Bundle::open(reimport).unwrap();
                assert!(validate_bundle(&reopened).unwrap().valid);
                let nodes = extract_text_page(&reopened, None, 100).unwrap().entries;
                assert!(nodes
                    .iter()
                    .any(|entry| entry.source.paragraph_id.as_deref() == Some("L3")
                        && entry.text == "New 😀"));
                assert!(nodes
                    .iter()
                    .any(|entry| entry.source.paragraph_id.as_deref() == Some("C3")
                        && entry.text == "Changed After merge"));
            } else {
                assert!(result.is_err());
                assert!(!target.exists());
            }
        }
    }

    #[test]
    fn shared_string_store_supports_disk_backed_random_reads() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = SharedStringStore::empty(temp.path()).unwrap();
        store.push("first").unwrap();
        store.push("中间 😀").unwrap();
        store.push("last").unwrap();

        assert_eq!(store.get(2).unwrap(), "last");
        assert_eq!(store.get(0).unwrap(), "first");
        assert_eq!(store.get(1).unwrap(), "中间 😀");
    }

    #[test]
    fn chart_formula_references_resolve_quoted_sheets_and_enforce_bounds() {
        let sheets = vec![SheetPart {
            name: "Sales Data's".to_string(),
            part: "xl/worksheets/sheet7.xml".to_string(),
            index: 0,
            state: "visible",
        }];
        let (part, range) =
            parse_chart_formula_reference("'Sales Data''s'!$B$2:$C$4", &sheets, "Sales Data's")
                .unwrap();
        assert_eq!(part, "xl/worksheets/sheet7.xml");
        assert_eq!(range.start_row, 2);
        assert_eq!(range.end_row, 4);
        assert_eq!(range.start_col, 2);
        assert_eq!(range.end_col, 3);
        assert!(parse_chart_formula_reference(
            "'[1]Sales Data''s'!$B$2:$C$4",
            &sheets,
            "Sales Data's"
        )
        .is_none());

        let mut requests = Vec::new();
        push_chart_range_request(
            &mut requests,
            &sheets,
            "Sales Data's",
            0,
            ChartSeriesField::Values,
            Some("'Sales Data''s'!$A$1:$A$2048"),
        );
        assert_eq!(requests.len(), 1);
        push_chart_range_request(
            &mut requests,
            &sheets,
            "Sales Data's",
            0,
            ChartSeriesField::Values,
            Some("'Sales Data''s'!$A$1:$A$2049"),
        );
        assert_eq!(requests.len(), 1);
    }

    #[test]
    fn formats_common_excel_numbers_and_both_date_systems() {
        let mut catalog = XlsxStyleCatalog {
            cell_formats: vec![
                XlsxCellFormat {
                    num_fmt_id: Some(4),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(9),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(178),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(179),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(14),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(22),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(11),
                    ..Default::default()
                },
                XlsxCellFormat {
                    num_fmt_id: Some(12),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        catalog.number_formats.insert(178, r#"0.0"%""#.to_string());
        catalog
            .number_formats
            .insert(179, "\"$\"#,##0.00".to_string());

        let cases = [
            ("1234.5", 0, false, "1,234.50", "number"),
            ("0.256", 1, false, "26%", "percent"),
            ("92.34", 2, false, "92.3%", "percent"),
            ("1234.5", 3, false, "$1,234.50", "currency"),
            ("1", 4, false, "1/1/00", "date"),
            ("60", 4, false, "2/29/00", "date"),
            ("0", 4, true, "1/1/04", "date"),
            ("1.5", 5, false, "1/1/00 12:00", "datetime"),
            ("1234", 6, false, "1.23E+03", "scientific"),
            ("1.5", 7, false, "1 1/2", "fraction"),
        ];
        for (raw, style, date_1904, expected, kind) in cases {
            let formatted = format_xlsx_cell(raw, Some(style), true, &catalog, date_1904);
            assert_eq!(
                formatted.text, expected,
                "formatting {raw} with style {style}"
            );
            assert_eq!(formatted.kind, kind);
        }
    }

    #[test]
    fn rejects_oversized_custom_number_formats() {
        let format_code = "0".repeat(MAX_FORMAT_CODE_BYTES + 1);
        let styles = format!(
            r#"<styleSheet><numFmts><numFmt numFmtId="178" formatCode="{format_code}"/></numFmts></styleSheet>"#
        );
        let error = match parse_xlsx_styles(styles.as_bytes()) {
            Ok(_) => panic!("oversized format code was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("exceeds 1024 bytes"));
    }

    #[test]
    fn source_snapshot_keeps_verified_bytes_after_source_changes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        create_shared_string_fixture(&source);
        let original = std::fs::read(&source).unwrap();
        let expected_hash = hash_bytes(&original);
        let (_dir, snapshot, hash, size) =
            snapshot_xlsx_source(&source, Some((&expected_hash, original.len() as u64))).unwrap();
        std::fs::write(&source, b"changed source").unwrap();
        assert_eq!(hash, expected_hash);
        assert_eq!(size, original.len() as u64);
        assert_eq!(std::fs::read(snapshot).unwrap(), original);
        assert!(matches!(
            snapshot_xlsx_source(&source, Some((&expected_hash, size))),
            Err(HcdError::InvalidPatch(reason)) if reason == "XLSX_SOURCE_CHANGED"
        ));
    }

    #[test]
    fn import_reads_snapshot_while_source_is_temporarily_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("bundle");
        create_shared_string_fixture(&source);
        let original = std::fs::read(&source).unwrap();
        let mut chunks = 0;
        let mut options = ImportOptions::new("snapshot");
        options.chunk_blocks = 1;
        let manifest = import_xlsx(&source, &bundle_path, &options, |event| {
            if matches!(event, ImportEvent::ChunkReady { .. }) {
                chunks += 1;
                if chunks == 1 {
                    std::fs::write(&source, b"temporarily overwritten")?;
                } else if chunks == 3 {
                    std::fs::write(&source, &original)?;
                }
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(chunks, 3);
        assert_eq!(manifest.source.sha256, hash_bytes(&original));
        let bundle = Bundle::open(bundle_path).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let text = extract_text_page(&bundle, None, 10).unwrap();
        assert_eq!(text.entries[0].text, "Shared Value 😀");
        assert_eq!(text.entries.len(), 6);
    }

    #[test]
    fn import_does_not_publish_when_source_is_replaced_during_progress() {
        use std::io::Write;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let replacement = temp.path().join("replacement.xlsx");
        let bundle_path = temp.path().join("bundle");
        create_shared_string_fixture(&source);
        std::fs::copy(&source, &replacement).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&replacement)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        let mut replaced = false;
        let mut completed = false;
        let mut failed = false;
        let mut options = ImportOptions::new("source-change");
        options.chunk_blocks = 1;
        let result = import_xlsx(&source, &bundle_path, &options, |event| {
            match event {
                ImportEvent::ChunkReady { .. } if !replaced => {
                    std::fs::rename(&replacement, &source)?;
                    replaced = true;
                }
                ImportEvent::Completed { .. } => completed = true,
                ImportEvent::Failed { .. } => failed = true,
                _ => {}
            }
            Ok(())
        });
        assert!(replaced);
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("source changed during import"));
        assert!(failed);
        assert!(!completed);
        assert!(!bundle_path.join("manifest.json").exists());
    }

    #[test]
    fn imports_shared_strings_without_a_workbook_wide_string_table() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("shared.xlsx");
        let bundle_path = temp.path().join("bundle");
        let exported = temp.path().join("exported.xlsx");
        create_shared_string_fixture(&source);

        let mut event_names = Vec::new();
        let mut options = ImportOptions::new("shared-string-doc");
        options.chunk_blocks = 1;

        let manifest = import_xlsx(&source, &bundle_path, &options, |event| {
            event_names.push(match event {
                ImportEvent::ImportStarted { .. } => "started",
                ImportEvent::ChunkReady { .. } => "chunk",
                ImportEvent::AssetReady { .. } => "asset",
                ImportEvent::Completed { .. } => "completed",
                ImportEvent::Failed { .. } => "failed",
            });
            Ok(())
        })
        .unwrap();
        assert_eq!(manifest.profile, "grid");
        assert_eq!(manifest.chunk_count, 3);
        assert!(
            event_names.iter().position(|event| *event == "chunk")
                < event_names.iter().position(|event| *event == "asset")
        );
        let bundle = Bundle::open(&bundle_path).unwrap();
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let text = extract_text_page(&bundle, None, 10).unwrap();
        assert_eq!(text.entries.len(), 6);
        assert_eq!(text.entries[0].text, "Shared Value 😀");
        assert_eq!(text.entries[0].source.paragraph_id.as_deref(), Some("A1"));
        assert_eq!(text.entries[1].text, "After merge");
        assert_eq!(text.entries[2].text, "1,234.50");
        assert_eq!(text.entries[3].text, "26%");
        assert_eq!(text.entries[4].text, "1/1/00");
        assert_eq!(text.entries[5].text, "92.3%");
        let styles = std::fs::read_to_string(bundle_path.join("styles.css")).unwrap();
        assert!(styles.contains(".hcd-xs-1{"));
        assert!(styles.contains("font-weight:700"));
        assert!(styles.contains("background-color:#ffcc00"));
        assert!(styles.contains(
            ".hcd-sheet[data-hcd-show-grid-lines=\"false\"] .hcd-grid td{border-color:transparent}"
        ));
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        let first_grid = page.chunks[0].grid.as_ref().unwrap();
        assert_eq!(
            first_grid.sheet_id,
            sheet_grid_id("shared-string-doc", "xl/worksheets/sheet1.xml")
        );
        assert_eq!(first_grid.sheet_name, "Shared");
        assert_eq!(first_grid.sheet_index, 0);
        assert_eq!(first_grid.sheet_state, "visible");
        assert_eq!(first_grid.kind, GridChunkKind::Cells);
        assert_eq!(
            (first_grid.row_start, first_grid.row_end),
            (Some(1), Some(2))
        );
        assert_eq!(
            (first_grid.column_start, first_grid.column_end),
            (Some(1), Some(2))
        );
        for descriptor in &page.chunks {
            let view_html = bundle.read_chunk(descriptor).unwrap();
            assert!(view_html.contains("data-hcd-sheet-view=\"page-break-preview\""));
            assert!(view_html.contains("data-hcd-view-top-left-cell=\"B2\""));
            assert!(view_html.contains("data-hcd-right-to-left=\"true\""));
            assert!(view_html.contains("data-hcd-show-grid-lines=\"false\""));
            assert!(view_html.contains("data-hcd-show-row-column-headers=\"false\""));
            assert!(view_html.contains("data-hcd-show-zeros=\"false\""));
            assert!(view_html.contains("data-hcd-show-formulas=\"true\""));
            assert!(view_html.contains("data-hcd-zoom-percent=\"125\""));
            assert!(view_html.contains("style=\"direction:rtl\""));
            assert!(view_html.contains("data-hcd-pane-state=\"frozen\""));
            assert!(view_html.contains("data-hcd-frozen-columns=\"2\""));
            assert!(view_html.contains("data-hcd-frozen-rows=\"3\""));
            assert!(view_html.contains("data-hcd-pane-top-left-cell=\"C4\""));
            assert!(view_html.contains("data-hcd-active-pane=\"bottom-right\""));
        }
        let html = bundle.read_chunk(&page.chunks[0]).unwrap();
        assert!(html.contains("class=\"hcd-cell hcd-xs-1\""));
        assert!(html.contains("data-hcd-style-index=\"1\""));
        assert!(html.contains("data-hcd-height-points=\"24.00\""));
        assert!(html.contains("data-hcd-column-start=\"1\""));
        assert!(html.contains("style=\"width:150.00px\""));
        assert!(html.contains("data-hcd-merge=\"A1:B2\""));
        assert!(html.contains("rowspan=\"2\""));
        assert!(html.contains("colspan=\"2\""));
        assert!(html.contains("data-hcd-row=\"2\""));
        assert!(!html.contains("data-hcd-row=\"3\""));
        let next_html = bundle.read_chunk(&page.chunks[1]).unwrap();
        assert!(next_html.contains("data-hcd-sheet-index=\"0\""));
        assert!(next_html.contains("data-hcd-sheet-state=\"visible\""));
        assert!(next_html.contains("data-hcd-row=\"3\""));
        assert!(next_html.contains("data-hcd-cell=\"C3\""));
        assert!(next_html.contains("data-hcd-cell=\"D3\""));
        assert_eq!(next_html.matches("class=\"hcd-cell hcd-empty\"").count(), 2);
        assert!(next_html.contains("data-hcd-num-fmt-id=\"4\""));
        assert!(next_html.contains("data-hcd-display-kind=\"number\""));
        assert!(next_html.contains(">1,234.50</span>"));
        assert!(next_html.contains("data-hcd-display-kind=\"percent\""));
        assert!(next_html.contains(">26%</span>"));
        assert!(next_html.contains("data-hcd-display-kind=\"date\""));
        assert!(next_html.contains(">1/1/00</span>"));
        assert!(next_html.contains(">92.3%</span>"));
        let empty_merge_html = bundle.read_chunk(&page.chunks[2]).unwrap();
        assert!(empty_merge_html.contains("data-hcd-row=\"4\""));
        assert!(empty_merge_html.contains("class=\"hcd-cell hcd-merge-empty\""));
        assert!(empty_merge_html.contains("data-hcd-editable=\"false\""));
        assert!(empty_merge_html.contains("data-hcd-merge=\"D4:E5\""));

        let first_cell = &text.entries[0];
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "shared-string-doc".to_string(),
            patch_id: "mask-merged-anchor".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: first_cell.node_id.clone(),
                start: 0,
                delete_count: 6,
                insert_text: "Masked".to_string(),
                precondition: NodePrecondition {
                    node_hash: first_cell.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        let patched_manifest = bundle.manifest().unwrap();
        let patched_page = bundle.read_index_page(&patched_manifest, 0).unwrap();
        assert_eq!(patched_page.chunks[0].grid.as_ref(), Some(first_grid));
        let report = export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        assert_eq!(report.level, FidelityLevel::High);
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("Masked Value 😀"));
        assert!(worksheet.contains("mergeCell ref=\"A1:B2\""));
        assert!(worksheet.contains("s=\"1\""));
    }

    #[test]
    fn stored_blank_cells_can_be_edited_and_exported_without_materializing_gaps() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("blank.xlsx");
        let path = temp.path().join("bundle");
        let output = temp.path().join("output.xlsx");
        let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        let parts = [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"/><c r="B1" t="inlineStr"><is><t>existing</t></is></c><c r="D1"/></row></sheetData></worksheet>"#,
            ),
        ];
        for (name, value) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(value.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        import_xlsx(&source, &path, &ImportOptions::new("blank"), |_| Ok(())).unwrap();
        let bundle = Bundle::open(&path).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let entries = extract_text_page(&bundle, None, 20).unwrap().entries;
        let blank = entries
            .iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A1"))
            .unwrap();
        assert!(blank.source.editable);
        assert_eq!(blank.text, "");
        assert!(entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("D1")));
        assert!(!entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("C1")));
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "blank".into(),
            patch_id: "blank-edit".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: blank.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "空格 😀".into(),
                precondition: NodePrecondition {
                    node_hash: blank.node_hash.clone(),
                },
            }],
        };
        validate_xlsx_source_text_edits(&bundle, &source, &patch.operations).unwrap();
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        export_xlsx(&bundle, &source, &output, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&output, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("空格 😀"));
        assert!(xml.contains("<c r=\"D1\"/>"));
        assert!(!xml.contains("<c r=\"C1\""));
        assert!(xml.contains("existing"));

        // A legal, very wide row must not become unimportable solely because
        // thousands of optional blank nodes were newly materialized.
        let wide_source = temp.path().join("wide.xlsx");
        let wide_bundle = temp.path().join("wide-bundle");
        let mut wide = zip::ZipWriter::new(File::create(&wide_source).unwrap());
        let extra: String = (5..=16_384)
            .map(|column| format!("<c r=\"{}1\"/>", column_name(column)))
            .collect();
        for (name, value) in parts {
            wide.start_file(name, options).unwrap();
            let content = if name == "xl/worksheets/sheet1.xml" {
                value.replace("<c r=\"D1\"/>", &format!("<c r=\"D1\"/>{extra}"))
            } else {
                value.to_string()
            };
            wide.write_all(content.as_bytes()).unwrap();
        }
        wide.finish().unwrap();
        let manifest = import_xlsx(
            &wide_source,
            &wide_bundle,
            &ImportOptions::new("wide"),
            |_| Ok(()),
        )
        .unwrap();
        assert!(manifest
            .warnings
            .iter()
            .any(|warning| warning.code == "XLSX_STORED_BLANK_MAPPING_LIMIT"));
        let wide = Bundle::open(wide_bundle).unwrap();
        assert!(validate_bundle(&wide).unwrap().valid);
        let wide_entries = extract_text_page(&wide, None, 20).unwrap().entries;
        assert!(wide_entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("B1")));
        assert!(wide_entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("D1")));
        let retained = wide_entries
            .iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("D1"))
            .unwrap();
        let wide_patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "wide".into(),
            patch_id: "wide-blank-edit".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: retained.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "retained blank ".repeat(512),
                precondition: NodePrecondition {
                    node_hash: retained.node_hash.clone(),
                },
            }],
        };
        validate_xlsx_source_text_edits(&wide, &wide_source, &wide_patch.operations).unwrap();
        hcd_core::apply_patch(&wide, &wide_patch, 0).unwrap();
        let wide_output = temp.path().join("wide-output.xlsx");
        export_xlsx(&wide, &wide_source, &wide_output, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&wide_output, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("retained blank"));
        assert!(xml.contains("<c r=\"XFD1\"/>"));

        let protected_source = temp.path().join("protected.xlsx");
        let protected_bundle = temp.path().join("protected-bundle");
        let mut protected = zip::ZipWriter::new(File::create(&protected_source).unwrap());
        for (name, value) in parts {
            protected.start_file(name, options).unwrap();
            let content = if name == "xl/worksheets/sheet1.xml" {
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f t="array" ref="A1:B1">1</f><v>1</v></c><c r="B1"/><c r="C1"/><c r="D1"/></row></sheetData><mergeCells><mergeCell ref="C1:D1"/></mergeCells></worksheet>"#
            } else {
                value
            };
            protected.write_all(content.as_bytes()).unwrap();
        }
        protected.finish().unwrap();
        import_xlsx(
            &protected_source,
            &protected_bundle,
            &ImportOptions::new("protected"),
            |_| Ok(()),
        )
        .unwrap();
        let protected = Bundle::open(protected_bundle).unwrap();
        let entries = extract_text_page(&protected, None, 20).unwrap().entries;
        assert!(
            !entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some("B1"))
                .unwrap()
                .source
                .editable
        );
        assert!(
            entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some("C1"))
                .unwrap()
                .source
                .editable
        );
        assert!(!entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("D1")));

        let group_source = temp.path().join("group.xlsx");
        let group_bundle = temp.path().join("group-bundle");
        let row1: String = (2..=8_000)
            .map(|c| format!("<c r=\"{}1\"/>", column_name(c)))
            .collect();
        let row2: String = (2..=8_000)
            .map(|c| format!("<c r=\"{}2\"/>", column_name(c)))
            .collect();
        let sheet = format!(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>anchor</t></is></c>{row1}</row><row r="2">{row2}</row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>"#
        );
        let mut group = zip::ZipWriter::new(File::create(&group_source).unwrap());
        for (name, value) in parts {
            group.start_file(name, options).unwrap();
            group
                .write_all(if name == "xl/worksheets/sheet1.xml" {
                    sheet.as_bytes()
                } else {
                    value.as_bytes()
                })
                .unwrap();
        }
        group.finish().unwrap();
        let result = import_xlsx(
            &group_source,
            &group_bundle,
            &ImportOptions::new("group"),
            |_| Ok(()),
        )
        .unwrap();
        let warning = result
            .warnings
            .iter()
            .find(|warning| warning.code == "XLSX_STORED_BLANK_MAPPING_LIMIT")
            .unwrap();
        let skipped: usize = warning
            .message
            .split_whitespace()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(skipped > 0 && skipped < 15998);
        let group = Bundle::open(group_bundle).unwrap();
        assert!(validate_bundle(&group).unwrap().valid);
        let entries = extract_text_page(&group, None, 20).unwrap().entries;
        assert!(entries.len() > 1);
        assert_eq!(entries[0].text, "anchor");

        // Headroom is a preference for optional blank mappings, never a new
        // limit on existing content that already fits in a valid fragment.
        let large_source = temp.path().join("large-existing.xlsx");
        let large_bundle = temp.path().join("large-existing-bundle");
        let content = "z".repeat(2_000_000);
        let sheet = format!(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{content}</t></is></c><c r="B1"/></row></sheetData></worksheet>"#
        );
        let mut large = zip::ZipWriter::new(File::create(&large_source).unwrap());
        for (name, value) in parts {
            large.start_file(name, options).unwrap();
            large
                .write_all(if name == "xl/worksheets/sheet1.xml" {
                    sheet.as_bytes()
                } else {
                    value.as_bytes()
                })
                .unwrap();
        }
        large.finish().unwrap();
        let result = import_xlsx(
            &large_source,
            &large_bundle,
            &ImportOptions::new("large"),
            |_| Ok(()),
        )
        .unwrap();
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "XLSX_STORED_BLANK_MAPPING_LIMIT"));
        let large = Bundle::open(large_bundle).unwrap();
        let entries = extract_text_page(&large, None, 5).unwrap().entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text.len(), content.len());
    }

    #[test]
    fn editable_map_audit_rejects_legacy_formula_result_and_wrong_source() {
        let temp = tempfile::tempdir().unwrap();
        let ordinary = temp.path().join("ordinary.xlsx");
        let source = temp.path().join("formula.xlsx");
        let bundle_path = temp.path().join("bundle");
        create_shared_string_fixture(&ordinary);
        import_xlsx(
            &ordinary,
            &bundle_path,
            &ImportOptions::new("legacy"),
            |_| Ok(()),
        )
        .unwrap();

        // Reproduce an old map whose C3 was marked editable even though the
        // authoritative workbook contains an array-formula result there.
        let mut input = zip::ZipArchive::new(File::open(&ordinary).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                let xml = String::from_utf8(bytes).unwrap();
                bytes = xml.replace(
                    "<c r=\"C3\" t=\"inlineStr\">",
                    "<c r=\"B3\"><f t=\"array\" ref=\"B3:C3\">1</f><v>1</v></c><c r=\"C3\" t=\"inlineStr\">",
                ).into_bytes();
            }
            output
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        let source_bytes = std::fs::read(&source).unwrap();
        let path = bundle_path.join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["source"]["sha256"] = serde_json::json!(hash_bytes(&source_bytes));
        manifest["source"]["sizeBytes"] = serde_json::json!(source_bytes.len());
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        assert!(audit_xlsx_editable_formula_map(&bundle, &source)
            .unwrap_err()
            .to_string()
            .contains("XLSX_FORMULA_READ_ONLY"));
        assert!(audit_xlsx_editable_formula_map(&bundle, &ordinary)
            .unwrap_err()
            .to_string()
            .contains("XLSX_SOURCE_CHANGED"));
        assert!(audit_xlsx_formula_mapping_snapshot(&bundle, &source, None).is_err());
    }

    #[test]
    fn audited_mapping_identity_is_revision_pinned_and_ignores_text_values() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("book.xlsx");
        let path = temp.path().join("book.hcd");
        create_shared_string_fixture(&source);
        import_xlsx(&source, &path, &ImportOptions::new("mapping-proof"), |_| {
            Ok(())
        })
        .unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let audited = audit_xlsx_formula_mapping_snapshot(&bundle, &source, Some(0)).unwrap();
        assert_eq!(audited.revision, 0);
        assert!(audited.editable_cells_checked > 0);
        let node = hcd_core::extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|node| node.source.editable)
            .unwrap();
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "mapping-proof".into(),
            patch_id: "mapping-proof-edit".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: node.node_id,
                start: 0,
                delete_count: 0,
                insert_text: "changed ".into(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        let latest = audit_xlsx_formula_mapping_snapshot(&bundle, &source, None).unwrap();
        let old = audit_xlsx_formula_mapping_snapshot(&bundle, &source, Some(0)).unwrap();
        assert_eq!(latest.revision, 1);
        assert_eq!(audited.mapping_fingerprint, old.mapping_fingerprint);
        assert_eq!(audited.mapping_fingerprint, latest.mapping_fingerprint);
        assert_eq!(
            latest.mapping_fingerprint,
            xlsx_formula_mapping_fingerprint(&bundle).unwrap()
        );
        // A fingerprint cannot be transplanted to another document identity.
        let another_path = temp.path().join("another.hcd");
        import_xlsx(
            &source,
            &another_path,
            &ImportOptions::new("other-document"),
            |_| Ok(()),
        )
        .unwrap();
        let another = Bundle::open(another_path).unwrap();
        assert_ne!(
            audited.mapping_fingerprint,
            xlsx_formula_mapping_fingerprint(&another).unwrap()
        );
        std::fs::write(&source, b"wrong source").unwrap();
        assert!(audit_xlsx_formula_mapping_snapshot(&bundle, &source, None).is_err());
    }

    #[test]
    fn insert_virtual_cells_preserves_order_values_and_existing_formula() {
        let xml = br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C5"/><sheetData><row r="1" spans="1:3"><c r="A1" s="2"><v>1</v></c><c r="C1"><f>1+2</f><v>3</v></c></row><row r="3"/><row r="5"><c r="B5"><v>5</v></c></row></sheetData></worksheet>"#;
        let insertions = BTreeMap::from([
            ("B1".into(), "  中<& ".into()),
            ("A3".into(), "row".into()),
            ("C4".into(), "gap".into()),
            ("A6".into(), "tail".into()),
        ]);
        let mut output = Vec::new();
        insert_virtual_worksheet_cells(&mut &xml[..], &mut output, &insertions).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("ref=\"A1:C6\""));
        assert!(text.contains("xml:space=\"preserve\""));
        assert!(text.contains("中&lt;&amp;"));
        assert!(text.contains("<f>1+2</f><v>3</v>"));
        assert!(text.contains("r=\"A1\" s=\"2\""));
        assert!(!text.contains("spans=\"1:3\""));
        let mut reader = Reader::from_str(&text);
        let mut rows = Vec::new();
        let mut cells = Vec::new();
        loop {
            match reader.read_event().unwrap() {
                Event::Start(tag) | Event::Empty(tag)
                    if local_name(tag.name().as_ref()) == "row" =>
                {
                    rows.push(attribute(&tag, "r").unwrap())
                }
                Event::Start(tag) | Event::Empty(tag) if local_name(tag.name().as_ref()) == "c" => {
                    cells.push(attribute(&tag, "r").unwrap())
                }
                Event::Eof => break,
                _ => {}
            }
        }
        assert_eq!(rows, ["1", "3", "4", "5", "6"]);
        assert_eq!(cells, ["A1", "B1", "C1", "A3", "C4", "B5", "A6"]);
        let mut rejected = Vec::new();
        assert!(insert_virtual_worksheet_cells(
            &mut &xml[..],
            &mut rejected,
            &BTreeMap::from([("C1".into(), "bad".into())])
        )
        .is_err());
        assert!(insert_virtual_worksheet_cells(
            &mut &xml[..],
            &mut Vec::new(),
            &BTreeMap::from([("A2".into(), "bad\u{0000}".into())])
        )
        .is_err());
        for malformed in [
            "<worksheet><sheetData><row r=\"3\"/><row r=\"1\"/></sheetData></worksheet>",
            "<worksheet><sheetData><row r=\"1\"><c r=\"C1\"/><c r=\"A1\"/></row></sheetData></worksheet>",
            "<worksheet><sheetData><row r=\"1\"><extLst/><c r=\"A1\"/></row></sheetData></worksheet>",
        ] {
            assert!(insert_virtual_worksheet_cells(
                &mut malformed.as_bytes(),
                &mut Vec::new(),
                &BTreeMap::from([("Z8".into(), "new".into())]),
            )
            .is_err());
        }
        let prefix=br#"<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData/></x:worksheet>"#;
        let mut bytes = Vec::new();
        insert_virtual_worksheet_cells(
            &mut &prefix[..],
            &mut bytes,
            &BTreeMap::from([("A2".into(), "text".into())]),
        )
        .unwrap();
        let output = String::from_utf8(bytes).unwrap();
        assert!(output.contains("<x:row r=\"2\"><x:c r=\"A2\" t=\"inlineStr\"><x:is><x:t>text</x:t></x:is></x:c></x:row>"));
    }

    #[test]
    fn inserted_cells_reimport_from_an_actual_workbook() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        let candidate = temp.path().join("candidate.xlsx");
        create_shared_string_fixture(&original);
        let mut input = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&candidate).unwrap());
        let changes = BTreeMap::from([
            ("B3".to_string(), " inserted 😀 ".to_string()),
            ("C4".to_string(), "new row cell".to_string()),
            ("H6".to_string(), "new row".to_string()),
        ]);
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                data = String::from_utf8(data)
                    .unwrap()
                    .replace(
                        "</row><row r=\"4\"/>",
                        "<c r=\"J3\"><f>1+2</f><v>3</v></c></row><row r=\"4\"/>",
                    )
                    .into_bytes();
                let mut scan = scan_worksheet_metadata(&mut &data[..], &name).unwrap();
                reject_formula_range_targets(&mut scan.formula_ranges, changes.keys()).unwrap();
                reject_merged_covered_targets(&mut scan.merged_ranges, changes.keys()).unwrap();
                let mut modified = Vec::new();
                insert_virtual_worksheet_cells(&mut &data[..], &mut modified, &changes).unwrap();
                data = modified;
            }
            output
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            output.write_all(&data).unwrap();
        }
        output.finish().unwrap();
        if let Some(path) = std::env::var_os("HCD_XLSX_INSERT_FIXTURE") {
            std::fs::copy(&candidate, path).unwrap();
        }
        let bundle_path = temp.path().join("reimport");
        import_xlsx(
            &candidate,
            &bundle_path,
            &ImportOptions::new("candidate"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(bundle_path).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let entries = extract_text_page(&bundle, None, 100).unwrap().entries;
        for (address, value) in changes {
            let node = entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some(address.as_str()))
                .unwrap();
            assert_eq!(node.text, value);
            assert!(node.source.editable);
        }
        assert!(entries
            .iter()
            .any(|entry| entry.source.paragraph_id.as_deref() == Some("A1")
                && entry.text == "Shared Value 😀"));
        let xml = read_zip_entry(&candidate, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("mergeCell ref=\"A1:B2\""));
        assert!(xml.contains("mergeCell ref=\"D4:E5\""));
        assert!(xml.contains("<f>1+2</f><v>3</v>"));
    }

    #[test]
    fn virtual_blank_inspection_rejects_formula_merge_existing_and_changed_source() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        let source = temp.path().join("source.xlsx");
        let path = temp.path().join("bundle");
        create_shared_string_fixture(&original);
        let mut input = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
        let options = SimpleFileOptions::default();
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                bytes = String::from_utf8(bytes).unwrap().replace(
                    "</row><row r=\"4\"/>",
                    "<c r=\"J3\"><f t=\"array\" ref=\"J3:K3\">1+2</f><v>3</v></c></row><row r=\"4\"/>",
                ).replace("<row r=\"4\"/>", "<row r=\"4\"><c r=\"L4\" t=\"s\"/></row>").into_bytes();
            }
            output.start_file(name, options).unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        import_xlsx(&source, &path, &ImportOptions::new("blank-check"), |_| {
            Ok(())
        })
        .unwrap();
        let bundle = Bundle::open(&path).unwrap();
        let sheet = sheet_grid_id("blank-check", "xl/worksheets/sheet1.xml");
        let before = bundle.manifest().unwrap();
        let result = inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "$l$3").unwrap();
        assert_eq!(result.address, "L3");
        assert_eq!((result.row, result.column), (3, 12));
        assert_eq!(result.sheet_part, "xl/worksheets/sheet1.xml");
        assert_eq!(result.sheet_index, 0);
        assert_eq!(result.sheet_state, "visible");
        assert_eq!(result.revision, before.revision);
        assert_eq!(result.root_hash, before.root_hash);
        assert_eq!(
            result.node_id,
            stable_node_id(&["blank-check", "xl/worksheets/sheet1.xml", "cell", "L3"])
        );
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "K3")
            .unwrap_err()
            .to_string()
            .contains("XLSX_FORMULA_READ_ONLY"));
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "E5")
            .unwrap_err()
            .to_string()
            .contains("XLSX_MERGED_CELL_READ_ONLY"));
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "A1")
            .unwrap_err()
            .to_string()
            .contains("XLSX_CELL_ALREADY_MAPPED"));
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "L4")
            .unwrap_err()
            .to_string()
            .contains("XLSX_CELL_ALREADY_PRESENT"));
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, "other", "L3").is_err());
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "XFE1").is_err());
        assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
        let text_node = extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("C3"))
            .unwrap();
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
            document_id: "blank-check".into(),
            patch_id: "saved-existing-cell".into(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: text_node.node_id,
                start: 0,
                delete_count: 0,
                insert_text: "saved ".into(),
                precondition: NodePrecondition {
                    node_hash: text_node.node_hash,
                },
            }],
        };
        apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source)).unwrap();
        let saved = bundle.manifest().unwrap();
        let candidate = temp.path().join("preview.xlsx");
        let preview =
            preview_xlsx_virtual_cell(&bundle, &source, &sheet, "L3", "new 😀", &candidate)
                .unwrap();
        if let Some(path) = std::env::var_os("HCD_XLSX_VIRTUAL_PREVIEW") {
            std::fs::copy(&candidate, path).unwrap();
        }
        assert_eq!(preview.revision, 1);
        let xml = read_zip_entry(&candidate, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("saved After merge"));
        assert!(xml.contains("new 😀"));
        assert!(xml.contains("<f t=\"array\" ref=\"J3:K3\">1+2</f>"));
        assert_eq!(bundle.manifest().unwrap().root_hash, saved.root_hash);
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        let refused = temp.path().join("refused.xlsx");
        assert!(
            preview_xlsx_virtual_cell(&bundle, &source, &sheet, "K3", "unsafe", &refused).is_err()
        );
        assert!(!refused.exists());
        assert!(
            preview_xlsx_virtual_cell(&bundle, &source, &sheet, "L3", "overwrite", &candidate)
                .is_err()
        );
        let cell = |address: &str, text: &str| XlsxVirtualCell {
            sheet_id: sheet.clone(),
            address: address.into(),
            text: text.into(),
        };
        let batch = vec![
            cell("L3", "batch one"),
            cell("M3", "batch two"),
            cell("A6", "batch row"),
        ];
        let batch_path = temp.path().join("batch.xlsx");
        let reports = preview_xlsx_virtual_cells(&bundle, &source, &batch, &batch_path).unwrap();
        assert_eq!(reports.len(), 3);
        assert!(reports
            .iter()
            .all(|item| item.revision == 1 && item.root_hash == saved.root_hash));
        let output = read_zip_entry(&batch_path, "xl/worksheets/sheet1.xml");
        for text in [
            "saved After merge",
            "batch one",
            "batch two",
            "batch row",
            "<f t=\"array\" ref=\"J3:K3\">1+2</f>",
        ] {
            assert!(output.contains(text))
        }
        let failed = temp.path().join("batch-failed.xlsx");
        assert!(preview_xlsx_virtual_cells(
            &bundle,
            &source,
            &[cell("L3", "ok"), cell("K3", "unsafe")],
            &failed
        )
        .is_err());
        assert!(!failed.exists());
        assert!(preview_xlsx_virtual_cells(
            &bundle,
            &source,
            &[cell("L3", "one"), cell("$l$3", "two")],
            &failed
        )
        .is_err());
        assert!(!failed.exists());
        assert_eq!(bundle.manifest().unwrap().root_hash, saved.root_hash);
        let ready_candidate = temp.path().join("ready-candidate.xlsx");
        std::fs::write(&ready_candidate, b"candidate already built").unwrap();
        let publish_target = temp.path().join("stale-candidate.xlsx");
        let mut changed_source = std::fs::read(&source).unwrap();
        changed_source[0] ^= 1;
        std::fs::write(&source, changed_source).unwrap();
        assert!(publish_virtual_candidate(
            &bundle,
            &source,
            &saved,
            &reports[0],
            &ready_candidate,
            &publish_target
        )
        .unwrap_err()
        .to_string()
        .contains("XLSX_CELL_INSPECTION_STALE"));
        assert!(!publish_target.exists());
        assert!(inspect_xlsx_virtual_blank(&bundle, &source, &sheet, "L3").is_err());
    }

    #[test]
    fn virtual_cell_rejects_protected_worksheets_without_publishing_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        create_shared_string_fixture(&original);
        for (flag, expected_protected) in [(Some("1"), true), (None, true), (Some("0"), false)] {
            let suffix = flag.unwrap_or("default");
            let source = temp.path().join(format!("{suffix}.xlsx"));
            let path = temp.path().join(format!("bundle-{suffix}"));
            let target = temp.path().join(format!("candidate-{suffix}.xlsx"));
            let mut input = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
            let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
            for index in 0..input.len() {
                let mut entry = input.by_index(index).unwrap();
                let name = entry.name().to_owned();
                let mut data = Vec::new();
                entry.read_to_end(&mut data).unwrap();
                if name == "xl/worksheets/sheet1.xml" {
                    let attr = flag
                        .map(|value| format!(" sheet=\"{value}\""))
                        .unwrap_or_default();
                    data = String::from_utf8(data)
                        .unwrap()
                        .replace(
                            "</sheetData>",
                            &format!("</sheetData><sheetProtection{attr}/>"),
                        )
                        .into_bytes();
                }
                output
                    .start_file(name, SimpleFileOptions::default())
                    .unwrap();
                output.write_all(&data).unwrap();
            }
            output.finish().unwrap();
            let fresh_path = temp.path().join(format!("fresh-{suffix}"));
            import_xlsx(
                &source,
                &fresh_path,
                &ImportOptions::new("protected"),
                |_| Ok(()),
            )
            .unwrap();
            let fresh = Bundle::open(&fresh_path).unwrap();
            assert_eq!(
                fresh
                    .manifest()
                    .unwrap()
                    .warnings
                    .iter()
                    .any(|warning| warning.code == "XLSX_PROTECTED_SHEET_READ_ONLY"),
                expected_protected
            );
            let fresh_cells = extract_text_page(&fresh, None, 100).unwrap().entries;
            let cell = fresh_cells
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some("C3"))
                .unwrap();
            assert_eq!(cell.source.editable, !expected_protected);
            import_xlsx(&original, &path, &ImportOptions::new("protected"), |_| {
                Ok(())
            })
            .unwrap();
            let source_bytes = std::fs::read(&source).unwrap();
            let manifest_path = path.join("manifest.json");
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
            manifest["source"]["sha256"] = serde_json::json!(hash_bytes(&source_bytes));
            manifest["source"]["sizeBytes"] = serde_json::json!(source_bytes.len());
            std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            let bundle = Bundle::open(path).unwrap();
            let before = bundle.manifest().unwrap();
            let sheet = sheet_grid_id("protected", "xl/worksheets/sheet1.xml");
            let result =
                preview_xlsx_virtual_cell(&bundle, &source, &sheet, "B3", "candidate", &target);
            if expected_protected {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("XLSX_SHEET_PROTECTED"));
                assert!(!target.exists());
            } else {
                result.unwrap();
                assert!(target.exists());
            }
            assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
            let cell = extract_text_page(&bundle, None, 100)
                .unwrap()
                .entries
                .into_iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some("C3"))
                .unwrap();
            let patch = PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.into(),
                document_id: "protected".into(),
                patch_id: "protected-cell".into(),
                base_revision: 0,
                actor: BTreeMap::new(),
                metadata: BTreeMap::new(),
                operations: vec![PatchOperation::TextSplice {
                    node_id: cell.node_id,
                    start: 0,
                    delete_count: 0,
                    insert_text: "changed ".into(),
                    precondition: NodePrecondition {
                        node_hash: cell.node_hash,
                    },
                }],
            };
            let audit = audit_xlsx_editable_formula_map(&bundle, &source);
            let save = apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source));
            if expected_protected {
                assert!(audit
                    .unwrap_err()
                    .to_string()
                    .contains("XLSX_SHEET_PROTECTED"));
                assert!(save
                    .unwrap_err()
                    .to_string()
                    .contains("XLSX_SHEET_PROTECTED"));
                assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
                // A historical or direct-core edit must still be blocked at export.
                hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
                let exported = temp.path().join(format!("protected-export-{suffix}.xlsx"));
                assert!(
                    export_xlsx(&bundle, &source, &exported, &ExportOptions::default())
                        .unwrap_err()
                        .to_string()
                        .contains("XLSX_SHEET_PROTECTED")
                );
                assert!(!exported.exists());
            } else {
                audit.unwrap();
                save.unwrap();
            }
        }
    }

    #[test]
    fn virtual_cell_batch_preview_handles_multiple_sheets_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        let source = temp.path().join("two.xlsx");
        let path = temp.path().join("bundle");
        create_shared_string_fixture(&original);
        let mut input = zip::ZipArchive::new(File::open(&original).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
        for i in 0..input.len() {
            let mut entry = input.by_index(i).unwrap();
            let name = entry.name().to_owned();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            if name == "xl/workbook.xml" {
                data = String::from_utf8(data)
                    .unwrap()
                    .replace(
                        "</sheets>",
                        "<sheet name=\"Second\" sheetId=\"2\" r:id=\"rId4\"/></sheets>",
                    )
                    .into_bytes()
            } else if name == "xl/_rels/workbook.xml.rels" {
                data=String::from_utf8(data).unwrap().replace("</Relationships>","<Relationship Id=\"rId4\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>").into_bytes()
            } else if name == "[Content_Types].xml" {
                data=String::from_utf8(data).unwrap().replace("</Types>","<Override PartName=\"/xl/worksheets/sheet2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>").into_bytes()
            }
            output
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            output.write_all(&data).unwrap();
        }
        output
            .start_file("xl/worksheets/sheet2.xml", SimpleFileOptions::default())
            .unwrap();
        output.write_all(br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>2+3</f><v>5</v></c></row></sheetData></worksheet>"#).unwrap();
        output.finish().unwrap();
        import_xlsx(&source, &path, &ImportOptions::new("multi"), |_| Ok(())).unwrap();
        let bundle = Bundle::open(path).unwrap();
        let before = bundle.manifest().unwrap();
        let first = sheet_grid_id("multi", "xl/worksheets/sheet1.xml");
        let second = sheet_grid_id("multi", "xl/worksheets/sheet2.xml");
        let cells = vec![
            XlsxVirtualCell {
                sheet_id: first,
                address: "C4".into(),
                text: "first sheet".into(),
            },
            XlsxVirtualCell {
                sheet_id: second,
                address: "B1".into(),
                text: "second sheet".into(),
            },
        ];
        let target = temp.path().join("preview.xlsx");
        let results = preview_xlsx_virtual_cells(&bundle, &source, &cells, &target).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(
            (results[0].row, results[0].column, results[0].sheet_index),
            (4, 3, 0)
        );
        assert_eq!(
            (results[1].row, results[1].column, results[1].sheet_index),
            (1, 2, 1)
        );
        assert_eq!(results[1].sheet_name, "Second");
        assert_eq!(results[1].sheet_part, "xl/worksheets/sheet2.xml");
        assert_eq!(results[1].sheet_state, "visible");
        assert!(read_zip_entry(&target, "xl/worksheets/sheet1.xml").contains("first sheet"));
        let sheet = read_zip_entry(&target, "xl/worksheets/sheet2.xml");
        assert!(sheet.contains("second sheet") && sheet.contains("<f>2+3</f>"));
        let bad = temp.path().join("bad.xlsx");
        let mut unsafe_batch = cells.clone();
        unsafe_batch[1].address = "A1".into();
        assert!(preview_xlsx_virtual_cells(&bundle, &source, &unsafe_batch, &bad).is_err());
        assert!(!bad.exists());
        assert_eq!(bundle.manifest().unwrap().root_hash, before.root_hash);
        let import = temp.path().join("reimport");
        import_xlsx(&target, &import, &ImportOptions::new("candidate"), |_| {
            Ok(())
        })
        .unwrap();
        assert!(
            validate_bundle(&Bundle::open(import).unwrap())
                .unwrap()
                .valid
        );
        let request = hcd_core::GridCreateRequest {
            document_id: "multi".into(),
            patch_id: "create-multi".into(),
            base_revision: 0,
            source_sha256: before.source.sha256.clone(),
            actor: BTreeMap::new(),
            cells: results
                .iter()
                .zip(&cells)
                .map(|(result, cell)| hcd_core::GridCellCreate {
                    sheet_id: cell.sheet_id.clone(),
                    sheet_part: result.sheet_part.clone(),
                    row: result.row,
                    column: result.column,
                    text: cell.text.clone(),
                })
                .collect(),
        };
        create_xlsx_virtual_cells(&bundle, &source, &request).unwrap();
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(validate_bundle(&bundle).unwrap().valid);
        let committed = temp.path().join("committed.xlsx");
        export_xlsx(&bundle, &source, &committed, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&committed, "xl/worksheets/sheet1.xml").contains("first sheet"));
        let committed_second = read_zip_entry(&committed, "xl/worksheets/sheet2.xml");
        assert!(
            committed_second.contains("second sheet") && committed_second.contains("<f>2+3</f>")
        );
    }

    #[test]
    fn visible_grid_binding_must_match_the_mapped_cell_and_sheet() {
        let part = "xl/worksheets/sheet1.xml";
        let document_id = "grid-test";
        let sheet = sheet_grid_id(document_id, part);
        let entry = NodeMapEntry {
            node_id: "node1".into(),
            node_hash: "hash".into(),
            source: SourceAnchor {
                part: part.into(),
                text_ordinal: 1,
                paragraph_id: Some("A1".into()),
                text_id: None,
                node_kind: "cell".into(),
                editable: true,
            },
        };
        let check = |html: &str, sheet_id: &str| {
            check_visible_xlsx_cells(
                html,
                std::slice::from_ref(&entry),
                document_id,
                sheet_id,
                &mut BTreeSet::new(),
            )
        };
        let valid = r#"<section><table><tbody><tr><td data-hcd-cell="A1"><span data-hcd-id="node1">x</span></td></tr></tbody></table></section>"#;
        assert!(check(valid, &sheet).is_ok());
        assert!(check(&valid.replace("A1", "B1"), &sheet).is_err());
        assert!(check(valid, "another-sheet").is_err());
        assert!(check(&valid.replace("node1", "unknown"), &sheet).is_err());
        assert!(check(
            &valid.replace("</tr>", "<td data-hcd-cell=\"A1\"></td></tr>"),
            &sheet
        )
        .is_err());
        assert!(check(
            &valid.replace("</td>", "<span data-hcd-id=\"other\"></span></td>"),
            &sheet
        )
        .is_err());
        assert!(check(&valid.replace("data-hcd-cell", "DATA-HCD-CELL"), &sheet).is_err());
        assert!(check(
            &valid
                .replace("<span", "<script")
                .replace("</span>", "</script>"),
            &sheet
        )
        .is_err());
        assert!(check(
            &valid
                .replace("<tbody><tr>", "")
                .replace("</tr></tbody>", ""),
            &sheet
        )
        .is_err());
        let mut seen = BTreeSet::new();
        check_visible_xlsx_cells(
            valid,
            std::slice::from_ref(&entry),
            document_id,
            &sheet,
            &mut seen,
        )
        .unwrap();
        assert!(check_visible_xlsx_cells(
            valid,
            std::slice::from_ref(&entry),
            document_id,
            &sheet,
            &mut seen
        )
        .is_err());
    }

    #[test]
    fn self_closing_shared_formulas_are_read_only_and_survive_other_edits() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("original.xlsx");
        let source = temp.path().join("formula.xlsx");
        let bundle_path = temp.path().join("bundle");
        let exported = temp.path().join("exported.xlsx");
        create_shared_string_fixture(&original);
        let mut input = zip::ZipArchive::new(File::open(original).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(&source).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for index in 0..input.len() {
            let mut entry = input.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                let xml = String::from_utf8(bytes).unwrap();
                bytes = xml.replace(
                    "</row><row r=\"4\"/>",
                    "<c r=\"H3\"><f t=\"shared\" si=\"0\"/><v>17</v></c><c r=\"I3\"><f t=\"shared\" si=\"0\"/></c><c r=\"J3\"><f t=\"array\" ref=\"J3:K3\">1+2</f><v>3</v></c><c r=\"K3\"><v>4</v></c></row><row r=\"4\"/>",
                ).into_bytes();
            }
            output.start_file(name, options).unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("formula-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        assert!(audit_xlsx_editable_formula_map(&bundle, &source).unwrap() > 0);
        for address in ["H3", "I3", "J3", "K3"] {
            let targets = HashMap::from([(
                "xl/worksheets/sheet1.xml".to_string(),
                BTreeMap::from([(address.to_string(), String::new())]),
            )]);
            assert!(check_xlsx_formula_targets(&source, &targets)
                .unwrap_err()
                .to_string()
                .contains("XLSX_FORMULA_READ_ONLY"));
            assert!(check_xlsx_virtual_targets(&source, &targets).is_err());
        }
        let targets = HashMap::from([(
            "xl/worksheets/sheet1.xml".to_string(),
            BTreeMap::from([("D4".to_string(), String::new())]),
        )]);
        assert!(check_xlsx_virtual_targets(&source, &targets)
            .unwrap_err()
            .to_string()
            .contains("XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED"));
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        let mut entries = Vec::new();
        for chunk in &page.chunks {
            entries.extend(bundle.read_map(chunk).unwrap().entries);
        }
        for address in ["H3", "I3", "J3", "K3"] {
            let node = entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some(address))
                .unwrap();
            assert!(!node.source.editable, "{address} must remain a formula");
            let patch = PatchBatch {
                schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
                document_id: "formula-doc".to_string(),
                patch_id: format!("edit-{address}"),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::TextSplice {
                    node_id: node.node_id.clone(),
                    start: 0,
                    delete_count: 0,
                    insert_text: "x".to_string(),
                    precondition: NodePrecondition {
                        node_hash: node.node_hash.clone(),
                    },
                }],
                metadata: BTreeMap::new(),
            };
            assert!(apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source)).is_err());
            assert!(hcd_core::apply_patch(&bundle, &patch, 0).is_err());
        }
        let node = entries
            .iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("C3"))
            .unwrap();
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "formula-doc".to_string(),
            patch_id: "edit-neighbor".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::TextSplice {
                node_id: node.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "Changed ".to_string(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash.clone(),
                },
            }],
            metadata: BTreeMap::new(),
        };
        validate_xlsx_source_text_edits(&bundle, &source, &patch.operations).unwrap();
        let changed_source = temp.path().join("changed.xlsx");
        std::fs::copy(&source, &changed_source).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&changed_source)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        assert!(
            validate_xlsx_source_text_edits(&bundle, &changed_source, &patch.operations)
                .unwrap_err()
                .to_string()
                .contains("XLSX_SOURCE_CHANGED")
        );
        assert!(apply_xlsx_patch_with_source(&bundle, &patch, 0, None)
            .unwrap_err()
            .to_string()
            .contains("XLSX_SOURCE_MISSING"));
        assert!(
            apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&changed_source))
                .unwrap_err()
                .to_string()
                .contains("XLSX_SOURCE_CHANGED")
        );
        assert!(
            !apply_xlsx_patch_with_source(&bundle, &patch, 0, Some(&source))
                .unwrap()
                .idempotent_replay
        );
        assert!(
            apply_xlsx_patch_with_source(&bundle, &patch, 0, None)
                .unwrap()
                .idempotent_replay
        );
        let mut stale = patch.clone();
        stale.patch_id = "uncommitted-old".into();
        assert!(apply_xlsx_patch_with_source(&bundle, &stale, 0, None).is_err());
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let sheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("Changed After merge"));
        assert!(sheet.contains("<c r=\"H3\"><f t=\"shared\" si=\"0\"/><v>17</v></c>"));
        assert!(sheet.contains("<c r=\"I3\"><f t=\"shared\" si=\"0\"/></c>"));
        assert!(sheet.contains("<c r=\"K3\"><v>4</v></c>"));
        let mut replacements = BTreeMap::new();
        replacements.insert("H3".to_string(), "unsafe edit".to_string());
        let mut old_source = sheet.as_bytes();
        let error = rewrite_worksheet(&mut old_source, Vec::new(), &replacements).unwrap_err();
        assert!(error.to_string().contains("XLSX_FORMULA_READ_ONLY"));
        let mut scan_source = sheet.as_bytes();
        let mut scan = scan_worksheet_metadata(&mut scan_source, "sheet").unwrap();
        let mut array_target = BTreeMap::new();
        array_target.insert("K3".to_string(), "unsafe edit".to_string());
        assert!(
            reject_formula_range_targets(&mut scan.formula_ranges, array_target.keys())
                .unwrap_err()
                .to_string()
                .contains("XLSX_FORMULA_READ_ONLY: K3")
        );
    }

    #[test]
    fn merged_range_parser_rejects_invalid_and_overlapping_ranges() {
        assert_eq!(
            parse_merge_reference("$A$1:XFD1048576"),
            Some(MergeRange {
                start_row: 1,
                end_row: 1_048_576,
                start_col: 1,
                end_col: 16_384,
            })
        );
        assert!(parse_merge_reference("A0:B2").is_none());
        assert!(parse_merge_reference("A1:XFE2").is_none());
        assert!(parse_merge_reference("B2:A1").is_none());

        let mut cursor = MergeCursor::new(vec![
            parse_merge_reference("A1:B2").unwrap(),
            parse_merge_reference("B2:C3").unwrap(),
        ]);
        cursor.begin_row(1).unwrap();
        let error = cursor.begin_row(2).unwrap_err();
        assert!(error.to_string().contains("overlapping XLSX merged ranges"));
    }

    #[test]
    fn merged_covered_targets_are_rejected_but_anchors_remain_editable() {
        let source = br#"<worksheet><sheetData/><mergeCells><mergeCell ref="B2:C3"/><mergeCell ref="E1:F1"/></mergeCells></worksheet>"#;
        let mut input = &source[..];
        let mut scan = scan_worksheet_metadata(&mut input, "sheet").unwrap();
        let allowed = ["E1".to_string(), "B2".to_string(), "A3".to_string()];
        reject_merged_covered_targets(&mut scan.merged_ranges, allowed.iter()).unwrap();

        for address in ["C2", "B3", "C3", "F1"] {
            let mut input = &source[..];
            let mut scan = scan_worksheet_metadata(&mut input, "sheet").unwrap();
            let target = [address.to_string()];
            let error =
                reject_merged_covered_targets(&mut scan.merged_ranges, target.iter()).unwrap_err();
            assert!(error.to_string().contains("XLSX_MERGED_CELL_READ_ONLY"));
        }
    }

    #[test]
    fn source_target_check_enforces_merged_cell_boundary() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("merged.xlsx");
        let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
        zip.start_file(
            "xl/worksheets/sheet1.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"/></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>"#).unwrap();
        zip.finish().unwrap();
        let part = "xl/worksheets/sheet1.xml".to_string();
        let mut targets = HashMap::new();
        targets.insert(
            part.clone(),
            BTreeMap::from([("A1".to_string(), String::new())]),
        );
        check_xlsx_formula_targets(&source, &targets).unwrap();
        targets.insert(part, BTreeMap::from([("B1".to_string(), String::new())]));
        assert!(check_xlsx_formula_targets(&source, &targets)
            .unwrap_err()
            .to_string()
            .contains("XLSX_MERGED_CELL_READ_ONLY"));
    }

    #[test]
    fn formula_range_scanning_rejects_invalid_ranges_and_protects_table_results() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="B1"><f t="dataTable" ref="B1:C3"/><v>1</v></c></row></sheetData></worksheet>"#;
        let mut source = xml.as_bytes();
        let mut scan = scan_worksheet_metadata(&mut source, "sheet").unwrap();
        let mut targets = BTreeMap::new();
        targets.insert("A1".to_string(), String::new());
        targets.insert("C3".to_string(), String::new());
        assert!(
            reject_formula_range_targets(&mut scan.formula_ranges, targets.keys())
                .unwrap_err()
                .to_string()
                .contains("C3")
        );
        for formula in [r#"<f t="array"/>"#, r#"<f t="array" ref="A1:XFE2"/>"#] {
            let xml = format!("<worksheet><sheetData><row r=\"1\"><c r=\"A1\">{formula}</c></row></sheetData></worksheet>");
            assert!(scan_worksheet_metadata(&mut xml.as_bytes(), "sheet").is_err());
        }
    }

    #[test]
    fn sparse_rows_keep_cells_in_their_excel_columns() {
        let row = RenderedRow {
            number: 9,
            html: "<tr data-hcd-row=\"9\">".to_string(),
            cells: vec![
                RenderedCell {
                    column: 1,
                    span: 1,
                    html: "<td data-hcd-column=\"1\">A9</td>".to_string(),
                },
                RenderedCell {
                    column: 3,
                    span: 1,
                    html: "<td data-hcd-column=\"3\">C9</td>".to_string(),
                },
                RenderedCell {
                    column: 6,
                    span: 1,
                    html: "<td data-hcd-column=\"6\">F9</td>".to_string(),
                },
            ],
            ..Default::default()
        };
        let html = finish_worksheet_row(row).unwrap().html;
        let columns = [1, 2, 3, 4, 5, 6]
            .map(|column| html.find(&format!("data-hcd-column=\"{column}\"")))
            .map(Option::unwrap);
        assert!(columns.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(html.matches("class=\"hcd-cell hcd-empty\"").count(), 3);
    }

    #[test]
    fn partial_blank_compaction_measures_sparse_gaps_and_merge_covers() {
        let make = |column| RenderedCell {
            column,
            span: 1,
            html: format!("<td data-hcd-column=\"{column}\">{}</td>", "x".repeat(80)),
        };
        let mut row = finish_worksheet_row(RenderedRow {
            number: 1,
            html: "<tr data-hcd-row=\"1\">".into(),
            cells: vec![make(1), make(2), make(5), make(8), make(10)],
            merge_covers: vec![MergeRange {
                start_row: 0,
                end_row: 1,
                start_col: 3,
                end_col: 4,
            }],
            optional_blank_columns: [2, 5, 8].into_iter().collect(),
            ..Default::default()
        })
        .unwrap();
        let old_len = row.html.len();
        assert_eq!(compact_worksheet_row(&mut row, old_len - 1).unwrap(), 1);
        assert!(row.html.len() < old_len);
        assert_eq!(row.optional_blank_columns, [2, 5].into_iter().collect());
        assert!(row.html.contains("data-hcd-column=\"10\""));
        assert!(!row.html.contains("data-hcd-column=\"3\""));
    }

    #[test]
    fn vertical_merge_columns_do_not_gain_duplicate_empty_cells() {
        let row = RenderedRow {
            number: 2,
            html: "<tr data-hcd-row=\"2\">".to_string(),
            cells: vec![RenderedCell {
                column: 3,
                span: 1,
                html: "<td data-hcd-column=\"3\">C2</td>".to_string(),
            }],
            merge_covers: vec![MergeRange {
                start_row: 1,
                end_row: 2,
                start_col: 1,
                end_col: 2,
            }],
            ..Default::default()
        };
        let html = finish_worksheet_row(row).unwrap().html;
        assert!(!html.contains("hcd-empty"));
        assert!(html.contains("data-hcd-column=\"3\""));
    }

    #[test]
    fn worksheet_view_scan_preserves_split_positions_and_bounds_metadata() {
        let xml = r#"<worksheet><sheetViews><sheetView workbookViewId="0" view="pageLayout" topLeftCell="XFE1" rightToLeft="false" showGridLines="true" zoomScale="401"><pane xSplit="240.5" ySplit="480" topLeftCell="$D$5" activePane="topRight" state="split"/></sheetView></sheetViews><sheetData/></worksheet>"#;
        let mut source = xml.as_bytes();

        let scan = scan_worksheet_metadata(&mut source, "xl/worksheets/sheet.xml").unwrap();
        let attributes = scan.view.html_attributes();

        assert!(attributes.contains("data-hcd-sheet-view=\"page-layout\""));
        assert!(attributes.contains("data-hcd-right-to-left=\"false\""));
        assert!(attributes.contains("data-hcd-show-grid-lines=\"true\""));
        assert!(attributes.contains("data-hcd-pane-state=\"split\""));
        assert!(attributes.contains("data-hcd-split-x-twips=\"240.50\""));
        assert!(attributes.contains("data-hcd-split-y-twips=\"480.00\""));
        assert!(attributes.contains("data-hcd-pane-top-left-cell=\"D5\""));
        assert!(attributes.contains("data-hcd-active-pane=\"top-right\""));
        assert!(!attributes.contains("data-hcd-view-top-left-cell"));
        assert!(!attributes.contains("data-hcd-zoom-percent"));
        assert!(!attributes.contains("data-hcd-frozen-columns"));
        assert_eq!(frozen_split_count(2.0, 16_384), Some(2));
        assert_eq!(frozen_split_count(2.5, 16_384), None);
        assert_eq!(frozen_split_count(16_385.0, 16_384), None);
    }

    #[test]
    fn empty_sheet_chunk_repeats_view_and_default_grid_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle");
        let mut writer = BundleWriter::create(&bundle_path).unwrap();
        let options = ImportOptions::new("empty-sheet-doc");
        let view = WorksheetViewMetadata {
            workbook_view_id: Some(0),
            view: Some("normal"),
            show_grid_lines: Some(false),
            pane: Some(WorksheetPaneMetadata {
                state: "frozen",
                x_split: Some(2.0),
                y_split: Some(1.0),
                top_left_cell: Some("C2".to_string()),
                active_pane: Some("bottom-right"),
            }),
            ..Default::default()
        };
        let mut descriptors = Vec::new();
        let mut emit = |event: &ImportEvent| {
            if let ImportEvent::ChunkReady { descriptor } = event {
                descriptors.push(descriptor.clone());
            }
            Ok(())
        };

        {
            let sheet = SheetPart {
                name: "Empty".to_string(),
                part: "xl/worksheets/sheet1.xml".to_string(),
                index: 0,
                state: "visible",
            };
            let mut chunks = SheetChunkWriter::new(
                "empty-sheet-doc",
                &sheet,
                &options,
                &view,
                &mut writer,
                &mut emit,
            );
            chunks.default_column_width = Some(8.43);
            chunks.default_row_height = Some(15.0);
            chunks.finish().unwrap();
        }

        assert_eq!(descriptors.len(), 1);
        let html = std::fs::read_to_string(bundle_path.join(&descriptors[0].html_href)).unwrap();
        assert!(html.contains("data-hcd-sheet=\"Empty\""));
        assert!(html.contains("data-hcd-sheet-index=\"0\""));
        assert!(html.contains("data-hcd-sheet-state=\"visible\""));
        assert!(html.contains("data-hcd-default-column-width=\"8.43\""));
        assert!(html.contains("data-hcd-default-row-height-points=\"15.00\""));
        let grid = descriptors[0].grid.as_ref().unwrap();
        assert_eq!(grid.default_column_width_emu, Some(602_218));
        assert_eq!(grid.default_row_height_emu, Some(190_500));
        assert!(html.contains("data-hcd-sheet-view=\"normal\""));
        assert!(html.contains("data-hcd-show-grid-lines=\"false\""));
        assert!(html.contains("data-hcd-pane-state=\"frozen\""));
        assert!(html.contains("data-hcd-frozen-columns=\"2\""));
        assert!(html.contains("data-hcd-frozen-rows=\"1\""));
        assert!(html.contains("data-hcd-pane-top-left-cell=\"C2\""));
        assert!(html.contains("data-hcd-active-pane=\"bottom-right\""));
        assert!(html.contains("<tbody></tbody>"));
    }

    #[test]
    fn drawing_anchor_attributes_preserve_cell_offsets_and_extents() {
        let anchor = XlsxDrawingAnchor {
            kind: "two-cell".to_string(),
            from_col_offset: Some(95_250),
            from_row_offset: Some(190_500),
            to_col_offset: Some(285_750),
            to_row_offset: Some(381_000),
            x: Some(476_250),
            y: Some(571_500),
            width: Some(952_500),
            height: Some(1_905_000),
            ..Default::default()
        };
        let mut attributes = String::new();
        append_drawing_anchor_attributes(&mut attributes, &anchor);

        assert!(attributes.contains("data-hcd-from-column-offset-emu=\"95250\""));
        assert!(attributes.contains("data-hcd-from-row-offset-emu=\"190500\""));
        assert!(attributes.contains("data-hcd-to-column-offset-emu=\"285750\""));
        assert!(attributes.contains("data-hcd-to-row-offset-emu=\"381000\""));
        assert!(attributes.contains("data-hcd-absolute-x-emu=\"476250\""));
        assert!(attributes.contains("data-hcd-absolute-y-emu=\"571500\""));
        assert!(attributes.contains("data-hcd-extent-width-emu=\"952500\""));
        assert!(attributes.contains("data-hcd-extent-height-emu=\"1905000\""));
    }

    fn create_shared_string_fixture(path: &Path) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let parts = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Shared" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/styles.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="178" formatCode="0.0&quot;%&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color rgb="FF112233"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFCC00"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left><bottom style="double"><color rgb="FF112233"/></bottom></border></borders><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="4" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/><xf numFmtId="178" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><r><t>Shared </t></r><r><t>Value 😀</t></r></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="7" zoomScale="75"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView><sheetView workbookViewId="0" view="pageBreakPreview" topLeftCell="$B$2" rightToLeft="1" showGridLines="0" showRowColHeaders="0" showZeros="0" showFormulas="1" zoomScale="125"><pane xSplit="2" ySplit="3" topLeftCell="$C$4" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="8.43" defaultRowHeight="15"/><cols><col min="1" max="2" width="20" customWidth="1"/></cols><sheetData><row r="1" ht="24" customHeight="1"><c r="A1" t="s" s="1"><v>0</v></c></row><row r="2"/><row r="3"><c r="C3" t="inlineStr"><is><t>After merge</t></is></c><c r="D3" s="2"><v>1234.5</v></c><c r="E3" s="3"><v>0.256</v></c><c r="F3" s="4"><v>1</v></c><c r="G3" s="5"><v>92.34</v></c></row><row r="4"/><row r="5"/></sheetData><mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="D4:E5"/></mergeCells></worksheet>"#,
            ),
            ("xl/media/image1.png", "streamed-after-sheet-chunks"),
        ];
        for (name, contents) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn read_zip_entry(path: &Path, name: &str) -> String {
        let file = File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut output = String::new();
        entry.read_to_string(&mut output).unwrap();
        output
    }
}
