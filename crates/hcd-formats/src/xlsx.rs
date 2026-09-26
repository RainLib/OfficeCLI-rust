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
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use time::{Date, Duration, Month};

const MAX_CONTROL_BYTES: u64 = 16 * 1024 * 1024;
const ROWS_PER_WINDOW: usize = 128;
const MAX_MERGED_RANGES: usize = 1_000_000;
const MAX_FORMAT_CODE_BYTES: usize = 1_024;
const MAX_SHARED_FORMULA_MEMBERS: usize = 100_000;
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
    formula_expression: String,
    formula_editable: bool,
    shared_formula_index: Option<u32>,
    value: String,
    inline_text: String,
    capture: Capture,
}

#[derive(Default, PartialEq, Eq)]
enum Capture {
    #[default]
    None,
    Value,
    Formula,
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
    merged_ranges: MergeCursor,
    view: WorksheetViewMetadata,
    shared_formulas: HashMap<u32, Option<SharedFormulaGroup>>,
}

#[derive(Clone)]
struct SharedFormulaGroup {
    range: MergeRange,
    formula: String,
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
            column_markup: String::new(),
            default_column_width: None,
            default_row_height: None,
            view_attributes: view.html_attributes(),
            hold_until_row: None,
        }
    }

    fn push(&mut self, row: RenderedRow) -> Result<(), HcdError> {
        if row.html.len() > MAX_CHUNK_BYTES {
            return Err(HcdError::ResourceLimit(format!(
                "NODE_TOO_LARGE: XLSX row {} in {} is {} bytes",
                row.number,
                self.part,
                row.html.len()
            )));
        }
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
        if self.html.len() + row.html.len() > MAX_CHUNK_BYTES {
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
        self.entries.extend(row.entries);
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
        let default_width = self
            .default_column_width
            .map(|width| format!(" data-hcd-default-column-width=\"{width:.2}\""))
            .unwrap_or_default();
        let default_height = self
            .default_row_height
            .map(|height| format!(" data-hcd-default-row-height-points=\"{height:.2}\""))
            .unwrap_or_default();
        let html = format!(
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
            self.html
        );
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
        Ok(())
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

pub(crate) fn import_xlsx<F>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    mut emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let (source_hash, source_size) = source_identity(source, "xlsx")?;
    emit_started(&mut emit, options, &source_hash)?;
    let result = import_xlsx_inner(source, output, options, source_hash, source_size, &mut emit);
    if let Err(error) = &result {
        emit_failed(&mut emit, options, error);
    }
    result
}

fn import_xlsx_inner<F>(
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
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let scratch = tempfile::tempdir()?;
    let mut shared_strings = SharedStringStore::build(&mut archive, scratch.path())?;
    let (rendered_styles, style_catalog) = render_xlsx_styles(&mut archive)?;
    let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
    writer.write_styles(&rendered_styles)?;
    let mut format_stats = XlsxFormatStats::default();

    for sheet in &workbook.sheets {
        let WorksheetScan {
            mut merged_ranges,
            view,
            shared_formulas,
        } = archive
            .with_part(&sheet.part, |source| {
                scan_worksheet_metadata(source, &sheet.part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
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
                    &shared_formulas,
                    &style_catalog,
                    workbook.date_1904,
                    &mut format_stats,
                    &mut chunks,
                )
                .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        chunks.finish()?;
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

    let mut manifest = base_manifest(options, "xlsx", "grid", source_hash, source_size);
    manifest.warnings.push(FidelityWarning {
        code: "XLSX_ADVANCED_VISUALS_EXTERNAL".to_string(),
        message: "HCD materializes worksheet view/frozen-pane metadata, merged ranges, direct cell styles, row/column dimensions, common numeric display formats, worksheet pictures and bounded chart series from caches or worksheet references; conditional formatting, shapes and unsupported drawing types remain authoritative in the immutable source".to_string(),
        node_id: None,
        source_part: Some("xl/styles.xml".to_string()),
    });
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
            "showFormulas is preserved as view metadata; ordinary formulas and bounded shared groups with safely translatable A1 references can be edited, while unsupported shared and array formulas remain read-only"
                .to_string(),
        ],
        dropped: Vec::new(),
        warnings: manifest.warnings.clone(),
    });
    finish_import(writer, manifest, emit)
}

fn expand_shared_formula_replacements(
    archive: &mut StreamingOxmlArchive,
    replacements: &mut HashMap<String, BTreeMap<String, String>>,
    converted_cells: &HashMap<String, BTreeSet<String>>,
) -> Result<usize, HcdError> {
    let mut expanded_groups = 0usize;
    for part in converted_cells.keys() {
        replacements.entry(part.clone()).or_default();
    }
    for (part, formulas) in replacements {
        let converted = converted_cells.get(part);
        let scan = archive
            .with_part(part, |source| {
                scan_worksheet_metadata(source, part)
                    .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        for group in scan.shared_formulas.values().flatten() {
            let edited_member =
                formulas
                    .keys()
                    .chain(converted.into_iter().flatten())
                    .any(|reference| {
                        cell_coordinates(reference).is_some_and(|(row, column)| {
                            (group.range.start_row..=group.range.end_row).contains(&row)
                                && (group.range.start_col..=group.range.end_col).contains(&column)
                        })
                    });
            if !edited_member {
                continue;
            }
            expanded_groups += 1;
            for row in group.range.start_row..=group.range.end_row {
                for column in group.range.start_col..=group.range.end_col {
                    let reference = format!("{}{row}", column_name(column));
                    if converted.is_some_and(|cells| cells.contains(&reference)) {
                        continue;
                    }
                    let expression = translate_shared_formula(
                        &group.formula,
                        i64::from(row - group.range.start_row),
                        i64::from(column - group.range.start_col),
                    )
                    .ok_or_else(|| {
                        HcdError::Unsupported(format!(
                            "shared formula group in {part} cannot be expanded safely"
                        ))
                    })?;
                    formulas.entry(reference).or_insert(expression);
                }
            }
        }
    }
    Ok(expanded_groups)
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
                        source_cell_ref: None,
                        created_in_hcd: false,
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
                    source_cell_ref: None,
                    created_in_hcd: false,
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
                    Capture::Formula => {}
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
    let mut selected_view: Option<WorksheetViewMetadata> = None;
    let mut current_view: Option<WorksheetViewMetadata> = None;
    let mut current_cell: Option<String> = None;
    let mut pending_shared: Option<(u32, MergeRange, String)> = None;
    let mut shared_formulas: HashMap<u32, Option<SharedFormulaGroup>> = HashMap::new();
    let mut shared_members: HashMap<u32, BTreeSet<(u32, u32)>> = HashMap::new();
    let mut shared_member_count = 0usize;
    let mut shared_members_complete = true;
    let mut budget = XmlBudget::default();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("worksheet {part} XML: {error}")))?;
        budget.observe(&event, part)?;
        match event {
            Event::Start(ref element) if local_name(element.name().as_ref()) == "c" => {
                current_cell = attribute(element, "r");
            }
            Event::Start(ref element)
                if local_name(element.name().as_ref()) == "f"
                    && current_cell.is_some()
                    && attribute(element, "t").as_deref() == Some("shared") =>
            {
                if let (Some(index), Some(cell)) = (
                    attribute(element, "si").and_then(|value| value.parse::<u32>().ok()),
                    current_cell.as_deref().and_then(cell_coordinates),
                ) {
                    if shared_member_count < MAX_SHARED_FORMULA_MEMBERS {
                        if shared_members.entry(index).or_default().insert(cell) {
                            shared_member_count += 1;
                        }
                    } else {
                        shared_members_complete = false;
                    }
                }
                if let (Some(index), Some(range), Some(cell)) = (
                    attribute(element, "si").and_then(|value| value.parse::<u32>().ok()),
                    attribute(element, "ref").and_then(|value| parse_merge_reference(&value)),
                    current_cell.as_deref().and_then(cell_coordinates),
                ) {
                    let area = u64::from(range.end_row - range.start_row + 1)
                        * u64::from(range.end_col - range.start_col + 1);
                    if cell == (range.start_row, range.start_col)
                        && area <= 4096
                        && shared_formulas.len() < 4096
                    {
                        pending_shared = Some((index, range, String::new()));
                    }
                }
            }
            Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "f"
                    && current_cell.is_some()
                    && attribute(element, "t").as_deref() == Some("shared") =>
            {
                if let (Some(index), Some(cell)) = (
                    attribute(element, "si").and_then(|value| value.parse::<u32>().ok()),
                    current_cell.as_deref().and_then(cell_coordinates),
                ) {
                    if shared_member_count < MAX_SHARED_FORMULA_MEMBERS {
                        if shared_members.entry(index).or_default().insert(cell) {
                            shared_member_count += 1;
                        }
                    } else {
                        shared_members_complete = false;
                    }
                }
            }
            Event::Text(ref text) if pending_shared.is_some() => {
                let decoded = text.unescape().map_err(|error| {
                    HcdError::InvalidBundle(format!("worksheet {part} shared formula: {error}"))
                })?;
                let (_, _, formula) = pending_shared.as_mut().expect("checked formula");
                formula.push_str(&decoded);
                if formula.len() > 8191 {
                    pending_shared = None;
                }
            }
            Event::End(ref element) if local_name(element.name().as_ref()) == "f" => {
                if let Some((index, range, formula)) = pending_shared.take() {
                    if !formula.is_empty() {
                        if let std::collections::hash_map::Entry::Vacant(slot) =
                            shared_formulas.entry(index)
                        {
                            slot.insert(Some(SharedFormulaGroup { range, formula }));
                        } else {
                            shared_formulas.insert(index, None);
                        }
                    }
                }
            }
            Event::End(ref element) if local_name(element.name().as_ref()) == "c" => {
                current_cell = None;
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
    for group in shared_formulas.values_mut() {
        if group.as_ref().is_some_and(|item| {
            translate_shared_formula(&item.formula, 0, 0).is_none()
                || translate_shared_formula(
                    &item.formula,
                    i64::from(item.range.end_row - item.range.start_row),
                    i64::from(item.range.end_col - item.range.start_col),
                )
                .is_none()
        }) {
            *group = None;
        }
    }
    for (index, group) in &mut shared_formulas {
        if let Some(item) = group {
            let expected = usize::try_from(
                u64::from(item.range.end_row - item.range.start_row + 1)
                    * u64::from(item.range.end_col - item.range.start_col + 1),
            )
            .unwrap_or(usize::MAX);
            let complete = shared_members_complete
                && shared_members.get(index).is_some_and(|members| {
                    members.len() == expected
                        && members.iter().all(|(row, column)| {
                            (item.range.start_row..=item.range.end_row).contains(row)
                                && (item.range.start_col..=item.range.end_col).contains(column)
                        })
                });
            if !complete {
                *group = None;
            }
        }
    }
    Ok(WorksheetScan {
        merged_ranges: MergeCursor::new(ranges),
        view: selected_view.unwrap_or_default(),
        shared_formulas,
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
    for cell in row.cells.drain(..) {
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

#[allow(clippy::too_many_arguments)]
fn parse_worksheet<F>(
    source: &mut dyn Read,
    document_id: &str,
    sheet: &SheetPart,
    shared_strings: &mut SharedStringStore,
    merged_ranges: &mut MergeCursor,
    shared_formulas: &HashMap<u32, Option<SharedFormulaGroup>>,
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
            }
            Event::Empty(ref start) if local_name(start.name().as_ref()) == "row" => {
                let finished =
                    begin_worksheet_row(start, sheet, merged_ranges, &mut last_row_number)?;
                chunks.push(finish_worksheet_row(finished)?)?;
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
                    ..Default::default()
                });
            }
            Event::Empty(ref start) if local_name(start.name().as_ref()) == "c" => {
                let finished = CellBuilder {
                    reference: attribute(start, "r").unwrap_or_default(),
                    value_type: attribute(start, "t").unwrap_or_default(),
                    style_index: attribute(start, "s").and_then(|value| value.parse().ok()),
                    ..Default::default()
                };
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
            Event::Start(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "f" =>
            {
                let current = cell.as_mut().expect("checked cell");
                current.formula = true;
                if attribute(start, "t").as_deref() == Some("shared") {
                    current.shared_formula_index =
                        attribute(start, "si").and_then(|value| value.parse::<u32>().ok());
                }
                current.formula_editable = attribute(start, "t")
                    .is_none_or(|kind| kind == "normal")
                    && attribute(start, "si").is_none()
                    && attribute(start, "ref").is_none();
                current.capture = Capture::Formula;
            }
            Event::Empty(ref start)
                if cell.is_some() && local_name(start.name().as_ref()) == "f" =>
            {
                let current = cell.as_mut().expect("checked cell");
                current.formula = true;
                if attribute(start, "t").as_deref() == Some("shared") {
                    current.shared_formula_index =
                        attribute(start, "si").and_then(|value| value.parse::<u32>().ok());
                }
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
                    Capture::Formula => cell.formula_expression.push_str(&decoded),
                    Capture::InlineText => cell.inline_text.push_str(&decoded),
                    Capture::None => {}
                }
                if cell
                    .value
                    .len()
                    .max(cell.inline_text.len())
                    .max(cell.formula_expression.len())
                    > MAX_CHUNK_BYTES
                {
                    return Err(HcdError::ResourceLimit(format!(
                        "NODE_TOO_LARGE: cell {} exceeds 2 MiB",
                        cell.reference
                    )));
                }
            }
            Event::End(ref end)
                if cell.is_some() && matches!(local_name(end.name().as_ref()), "v" | "t" | "f") =>
            {
                cell.as_mut().expect("checked cell").capture = Capture::None;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "c" => {
                let mut finished = cell.take().unwrap_or_default();
                prepare_shared_formula_cell(&mut finished, shared_formulas);
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
                    chunks.push(finish_worksheet_row(finished)?)?;
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

fn prepare_shared_formula_cell(
    cell: &mut CellBuilder,
    groups: &HashMap<u32, Option<SharedFormulaGroup>>,
) {
    let Some(group) = cell
        .shared_formula_index
        .and_then(|index| groups.get(&index))
        .and_then(Option::as_ref)
    else {
        return;
    };
    let Some((row, column)) = cell_coordinates(&cell.reference) else {
        return;
    };
    if row < group.range.start_row
        || row > group.range.end_row
        || column < group.range.start_col
        || column > group.range.end_col
    {
        return;
    }
    let delta_row = i64::from(row) - i64::from(group.range.start_row);
    let delta_column = i64::from(column) - i64::from(group.range.start_col);
    if let Some(expression) = translate_shared_formula(&group.formula, delta_row, delta_column) {
        cell.formula_expression = expression;
        cell.formula_editable = true;
    }
}

/// Expand only ordinary A1 references. Unsupported syntax leaves the group read-only.
fn translate_shared_formula(formula: &str, row_delta: i64, column_delta: i64) -> Option<String> {
    if formula.is_empty()
        || formula.len() > 8191
        || !formula.is_ascii()
        || formula
            .bytes()
            .any(|byte| matches!(byte, b'!' | b'[' | b']' | b'\'' | b'#' | b'@' | b';'))
    {
        return None;
    }
    let bytes = formula.as_bytes();
    let mut output = String::with_capacity(formula.len());
    let mut offset = 0usize;
    let mut quoted = false;
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte == b'"' {
            if quoted && bytes.get(offset + 1) == Some(&b'"') {
                output.push_str("\"\"");
                offset += 2;
                continue;
            }
            quoted = !quoted;
            output.push('"');
            offset += 1;
            continue;
        }
        if !quoted && (byte == b'$' || byte.is_ascii_alphabetic()) {
            let boundary = offset == 0
                || !matches!(bytes[offset - 1],
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.');
            if boundary {
                if let Some((end, translated)) =
                    translate_a1_reference(bytes, offset, row_delta, column_delta)?
                {
                    output.push_str(&translated);
                    offset = end;
                    continue;
                }
            }
        }
        output.push(byte as char);
        offset += 1;
    }
    (!quoted && output.len() <= 8191).then_some(output)
}

fn translate_a1_reference(
    bytes: &[u8],
    start: usize,
    row_delta: i64,
    column_delta: i64,
) -> Option<Option<(usize, String)>> {
    let mut cursor = start;
    let absolute_column = bytes.get(cursor) == Some(&b'$');
    if absolute_column {
        cursor += 1;
    }
    let column_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_alphabetic) && cursor - column_start < 3 {
        cursor += 1;
    }
    if cursor == column_start || bytes.get(cursor).is_some_and(u8::is_ascii_alphabetic) {
        return Some(None);
    }
    let absolute_row = bytes.get(cursor) == Some(&b'$');
    if absolute_row {
        cursor += 1;
    }
    let row_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) && cursor - row_start < 7 {
        cursor += 1;
    }
    if cursor == row_start || bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        return Some(None);
    }
    if bytes.get(cursor).is_some_and(|byte| {
        byte.is_ascii_alphabetic() || byte.is_ascii_digit() || matches!(*byte, b'_' | b'.' | b'(')
    }) {
        return Some(None);
    }
    let reference = std::str::from_utf8(&bytes[start..cursor]).ok()?;
    let (row, column) = match cell_coordinates(reference) {
        Some(position) => position,
        None => return Some(None),
    };
    let next_row = i64::from(row) + if absolute_row { 0 } else { row_delta };
    let next_column = i64::from(column) + if absolute_column { 0 } else { column_delta };
    if !(1..=1_048_576).contains(&next_row) || !(1..=16_384).contains(&next_column) {
        return None;
    }
    let translated = format!(
        "{}{}{}{}",
        if absolute_column { "$" } else { "" },
        column_name(next_column as u32),
        if absolute_row { "$" } else { "" },
        next_row
    );
    Some(Some((cursor, translated)))
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
    if !finished.reference.is_empty() && (has_content || is_merge_anchor) {
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
    let raw_numeric_attribute = if is_numeric && raw_text.parse::<f64>().is_ok_and(f64::is_finite) {
        format!(" data-hcd-raw-value=\"{}\"", escape_attribute(&raw_text))
    } else {
        String::new()
    };
    let number_pattern_attribute = if !raw_numeric_attribute.is_empty() {
        formatted
            .num_fmt_id
            .and_then(|id| {
                styles
                    .number_formats
                    .get(&id)
                    .map(String::as_str)
                    .or_else(|| built_in_number_format(id).map(|(pattern, _)| pattern))
            })
            .filter(|pattern| pattern.len() <= MAX_FORMAT_CODE_BYTES)
            .map(|pattern| {
                format!(
                    " data-hcd-num-fmt-pattern=\"{}\"",
                    escape_attribute(pattern)
                )
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let column_span = match merged_ranges.classify(cell_row, cell_col) {
        Some(MergePosition::Anchor(range)) => range.end_col - range.start_col + 1,
        _ => 1,
    };
    let formula_attributes = if cell.formula
        && cell.formula_editable
        && !cell.formula_expression.is_empty()
        && cell.formula_expression.len() <= 8191
    {
        format!(
            " data-hcd-formula-editable=\"true\" data-hcd-formula-expression=\"{}\"",
            escape_attribute(&format!("={}", cell.formula_expression))
        )
    } else {
        String::new()
    };
    row.cells.push(RenderedCell {
        column: cell_col,
        span: column_span,
        html: format!(
            "<td class=\"hcd-cell{}\" data-hcd-cell=\"{}\" data-hcd-column=\"{}\"{}{}{}{}{}{}{}><span data-hcd-id=\"{}\" data-hcd-node-hash=\"{}\">{}</span></td>",
            cell.style_index
                .map(|index| format!(" hcd-xs-{index}"))
                .unwrap_or_default(),
            escape_attribute(&cell.reference),
            cell_col,
            if cell.formula { " data-hcd-formula=\"true\"" } else { "" },
            formula_attributes,
            cell.style_index
                .map(|index| format!(" data-hcd-style-index=\"{index}\""))
                .unwrap_or_default(),
            number_format_attributes,
            raw_numeric_attribute,
            number_pattern_attribute,
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
            source_cell_ref: None,
            created_in_hcd: false,
            part: sheet.part.clone(),
            text_ordinal: ordinal,
            paragraph_id: Some(cell.reference),
            text_id: None,
            node_kind: "cell".to_string(),
            editable: !cell.formula,
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
    let mut dirty_node_ids = dirty_node_ids;
    let mut deleted_nodes = std::collections::HashSet::new();
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        for deletion in record.grid_row_deletions {
            deleted_nodes.extend(deletion.removed_node_ids);
        }
        for deletion in record.grid_column_deletions {
            deleted_nodes.extend(deletion.removed_node_ids);
        }
    }
    dirty_node_ids.retain(|id| !deleted_nodes.contains(id));
    let nodes = if dirty_node_ids.is_empty() {
        Vec::new()
    } else {
        collect_dirty_nodes(bundle, &manifest, &dirty_parts, &dirty_node_ids)?
    };
    let mut replacements: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut formula_replacements: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut created_cells: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut created_formulas: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut formula_converted_to_value = false;
    let mut converted_formula_node_ids = BTreeSet::new();
    let mut converted_formula_cells: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut row_insertions: HashMap<String, Vec<RowShift>> = HashMap::new();
    let mut column_shifts: HashMap<String, Vec<ColumnShift>> = HashMap::new();
    for revision in 1..=manifest.revision {
        let record = bundle.revision(revision)?;
        formula_converted_to_value |= !record.converted_formula_node_ids.is_empty();
        converted_formula_node_ids.extend(record.converted_formula_node_ids);
        for shift in record.grid_row_insertions {
            row_insertions
                .entry(shift.sheet_part)
                .or_default()
                .push(RowShift::Insert(shift.before_row));
        }
        for shift in record.grid_row_deletions {
            row_insertions
                .entry(shift.sheet_part)
                .or_default()
                .push(RowShift::Delete(shift.row));
        }
        for shift in record.grid_column_insertions {
            column_shifts
                .entry(shift.sheet_part)
                .or_default()
                .push(ColumnShift::Insert(shift.before_column));
        }
        for shift in record.grid_column_deletions {
            column_shifts
                .entry(shift.sheet_part)
                .or_default()
                .push(ColumnShift::Delete(shift.column));
        }
        for part in record.dirty_grid_parts {
            replacements.entry(part).or_default();
        }
    }
    for node in nodes {
        if node.source.node_kind != "cell" {
            continue;
        }
        let cell = node.source.paragraph_id.ok_or_else(|| {
            HcdError::InvalidBundle(format!("XLSX node {} has no cell locator", node.node_id))
        })?;
        if !node.source.editable {
            let formula = node
                .text
                .strip_prefix('=')
                .filter(|formula| !formula.is_empty())
                .ok_or_else(|| {
                    HcdError::InvalidBundle(format!(
                        "edited XLSX formula node {} has no formula expression",
                        node.node_id
                    ))
                })?;
            if node.source.created_in_hcd {
                created_formulas
                    .entry(node.source.part.clone())
                    .or_default()
                    .insert(cell, formula.to_string());
            } else {
                formula_replacements
                    .entry(node.source.part.clone())
                    .or_default()
                    .insert(
                        node.source.source_cell_ref.unwrap_or(cell),
                        formula.to_string(),
                    );
            }
            replacements.entry(node.source.part).or_default();
            continue;
        }
        if node.source.created_in_hcd {
            created_cells
                .entry(node.source.part.clone())
                .or_default()
                .insert(cell, node.text);
            replacements.entry(node.source.part).or_default();
        } else {
            let original_cell = node.source.source_cell_ref.unwrap_or(cell);
            if converted_formula_node_ids.contains(&node.node_id) {
                converted_formula_cells
                    .entry(node.source.part.clone())
                    .or_default()
                    .insert(original_cell.clone());
            }
            replacements
                .entry(node.source.part)
                .or_default()
                .insert(original_cell, node.text);
        }
    }

    let scratch = tempfile::tempdir()?;
    let mut replacement_paths = HashMap::new();
    let mut archive = StreamingOxmlArchive::open(source).map_err(package_error)?;
    let workbook = workbook_info(&mut archive)?;
    let expanded_shared_groups = expand_shared_formula_replacements(
        &mut archive,
        &mut formula_replacements,
        &converted_formula_cells,
    )?;
    let chart_caches_may_be_stale = (!formula_replacements.is_empty()
        || !created_formulas.is_empty()
        || formula_converted_to_value)
        && archive
            .entries()
            .iter()
            .any(|entry| !entry.is_dir && entry.name.starts_with("xl/charts/"));
    if !row_insertions.is_empty() || !column_shifts.is_empty() {
        verify_grid_shift_source(&mut archive, &workbook, &row_insertions, &column_shifts)?;
    }
    let merge_ranges = collect_canonical_merge_ranges(bundle, &manifest, &workbook, &replacements)?;
    let canonical_rows = collect_canonical_sheet_rows(bundle, &manifest, &workbook, &replacements)?;
    let canonical_last_columns =
        collect_canonical_sheet_last_columns(bundle, &manifest, &workbook, &replacements)?;
    let column_widths =
        collect_canonical_column_widths(bundle, &manifest, &workbook, &replacements)?;
    let row_heights = collect_canonical_row_heights(bundle, &manifest, &workbook, &replacements)?;
    for (part, values) in &replacements {
        let path = scratch.path().join(safe_temp_name(part));
        let output = File::create(&path)?;
        let merges = merge_ranges.get(part).ok_or_else(|| {
            HcdError::InvalidBundle(format!(
                "XLSX sheet {part} is missing from the source workbook"
            ))
        })?;
        let rows = canonical_rows.get(part).ok_or_else(|| {
            HcdError::InvalidBundle(format!("XLSX sheet {part} has no canonical row map"))
        })?;
        let widths = column_widths.get(part).ok_or_else(|| {
            HcdError::InvalidBundle(format!("XLSX sheet {part} has no canonical column map"))
        })?;
        let heights = row_heights.get(part).ok_or_else(|| {
            HcdError::InvalidBundle(format!("XLSX sheet {part} has no canonical row heights"))
        })?;
        let inserted = created_cells.get(part).cloned().unwrap_or_default();
        let inserted_formulas = created_formulas.get(part).cloned().unwrap_or_default();
        let formulas = formula_replacements.get(part).cloned().unwrap_or_default();
        let shifts = row_insertions.get(part).cloned().unwrap_or_default();
        let column_shifts = column_shifts.get(part).cloned().unwrap_or_default();
        let last_column = canonical_last_columns.get(part).copied().unwrap_or(0);
        archive
            .with_part(part, |input| {
                rewrite_worksheet(
                    input,
                    BufWriter::new(output),
                    values,
                    &formulas,
                    &inserted,
                    &inserted_formulas,
                    merges,
                    rows,
                    widths,
                    heights,
                    &shifts,
                    &column_shifts,
                    last_column,
                )
                .map_err(|error| PackageError::ReadPartError(error.to_string()))
            })
            .map_err(package_error)?;
        replacement_paths.insert(part.clone(), path);
    }
    if !formula_replacements.is_empty()
        || !created_formulas.is_empty()
        || formula_converted_to_value
    {
        let path = scratch.path().join("workbook-recalculate.xml");
        let source_workbook = archive
            .read_control_part("xl/workbook.xml", MAX_CONTROL_BYTES)
            .map_err(package_error)?;
        rewrite_workbook_recalculation(&source_workbook, File::create(&path)?)?;
        replacement_paths.insert("xl/workbook.xml".to_string(), path);
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
            if row_insertions.is_empty() && column_shifts.is_empty() {
                "cell style index, workbook structure, formulas and drawings".to_string()
            } else {
                "cell style index, workbook structure and original cell identities".to_string()
            },
        ],
        flattened: {
            let mut items = vec![
                "edited nonformula cells are serialized as inline strings regardless of their original storage type"
                    .to_string(),
            ];
            if row_insertions
                .values()
                .flatten()
                .any(|shift| matches!(shift, RowShift::Insert(_)))
            {
                items.push("inserted worksheet rows have no inherited row formatting".to_string());
            }
            if column_shifts
                .values()
                .flatten()
                .any(|shift| matches!(shift, ColumnShift::Insert(_)))
            {
                items.push("inserted worksheet columns use default column formatting".to_string());
            }
            if expanded_shared_groups > 0 {
                items.push(format!("{expanded_shared_groups} edited shared-formula groups were expanded into independent native formulas"));
            }
            items
        },
        dropped: vec!["HCD recognition annotations are not exported".to_string()],
        warnings: {
            let mut warnings = manifest.warnings;
            if !formula_replacements.is_empty() {
                warnings.push(FidelityWarning {
                    code: "XLSX_FORMULA_RECALC_REQUIRED".to_string(),
                    message: "Edited formula caches were cleared; recalculate the workbook in Excel or another compatible spreadsheet application".to_string(),
                    node_id: None,
                    source_part: Some("xl/workbook.xml".to_string()),
                });
            }
            if formula_converted_to_value {
                warnings.push(FidelityWarning {
                    code: "XLSX_FORMULA_TO_VALUE_RECALC_REQUIRED".to_string(),
                    message: "Formula cells were replaced with literal values; dependent formula and chart caches may remain stale until the workbook is recalculated".to_string(),
                    node_id: None,
                    source_part: Some("xl/workbook.xml".to_string()),
                });
            }
            if chart_caches_may_be_stale {
                warnings.push(FidelityWarning {
                    code: "XLSX_CHART_CACHE_RECALC_REQUIRED".to_string(),
                    message: "HCD chart preview and copied chart caches may still show values from the source workbook until a spreadsheet application recalculates them".to_string(),
                    node_id: None,
                    source_part: Some("xl/charts".to_string()),
                });
            }
            warnings
        },
    };
    write_fidelity_report(options, &report)?;
    Ok(report)
}

fn collect_canonical_column_widths(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    replacements: &HashMap<String, BTreeMap<String, String>>,
) -> Result<HashMap<String, BTreeMap<u32, f64>>, HcdError> {
    let mut widths: HashMap<String, BTreeMap<u32, f64>> = replacements
        .keys()
        .map(|part| (part.clone(), BTreeMap::new()))
        .collect();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            let sheet = workbook.sheets.get(grid.sheet_index).ok_or_else(|| {
                HcdError::InvalidBundle("XLSX HCD sheet index is missing".to_string())
            })?;
            let Some(sheet_widths) = widths.get_mut(&sheet.part) else {
                continue;
            };
            let html = bundle.read_chunk(&descriptor)?;
            let mut cursor = 0usize;
            while let Some(offset) = html[cursor..].find("<col ") {
                let start = cursor + offset;
                let end = html[start..]
                    .find("/>")
                    .map(|offset| start + offset + 2)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("XLSX HCD column tag is not closed".to_string())
                    })?;
                let tag = &html[start..end];
                cursor = end;
                if !tag.contains(" data-hcd-width-edited=\"true\"") {
                    continue;
                }
                let first = hcd_column_attribute(tag, "data-hcd-column-start")
                    .and_then(|value| value.parse::<u32>().ok());
                let last = hcd_column_attribute(tag, "data-hcd-column-end")
                    .and_then(|value| value.parse::<u32>().ok());
                let width = hcd_column_attribute(tag, "data-hcd-width")
                    .and_then(|value| value.parse::<f64>().ok());
                let (Some(column), Some(end_column), Some(width)) = (first, last, width) else {
                    return Err(HcdError::InvalidBundle(
                        "XLSX HCD edited column width is incomplete".to_string(),
                    ));
                };
                if column != end_column
                    || !(1..=16_384).contains(&column)
                    || !width.is_finite()
                    || !(1.0..=255.0).contains(&width)
                {
                    return Err(HcdError::InvalidBundle(
                        "XLSX HCD edited column width is invalid".to_string(),
                    ));
                }
                if let Some(previous) = sheet_widths.insert(column, width) {
                    if previous != width {
                        return Err(HcdError::InvalidBundle(
                            "XLSX HCD column width differs between windows".to_string(),
                        ));
                    }
                }
            }
        }
    }
    Ok(widths)
}

fn collect_canonical_row_heights(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    replacements: &HashMap<String, BTreeMap<String, String>>,
) -> Result<HashMap<String, BTreeMap<u32, f64>>, HcdError> {
    let mut heights: HashMap<String, BTreeMap<u32, f64>> = replacements
        .keys()
        .map(|part| (part.clone(), BTreeMap::new()))
        .collect();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            let sheet = workbook.sheets.get(grid.sheet_index).ok_or_else(|| {
                HcdError::InvalidBundle("XLSX HCD sheet index is missing".to_string())
            })?;
            let Some(sheet_heights) = heights.get_mut(&sheet.part) else {
                continue;
            };
            let html = bundle.read_chunk(&descriptor)?;
            let mut cursor = 0;
            while let Some(relative) = html[cursor..].find("<tr data-hcd-row=\"") {
                let start = cursor + relative;
                let end = html[start..]
                    .find('>')
                    .map(|offset| start + offset)
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("XLSX HCD row tag is not closed".to_string())
                    })?;
                let tag = &html[start..=end];
                cursor = end + 1;
                if hcd_column_attribute(tag, "data-hcd-height-edited") != Some("true") {
                    continue;
                }
                let row = hcd_column_attribute(tag, "data-hcd-row")
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|row| (1..=1_048_576).contains(row))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("XLSX HCD edited row number is invalid".to_string())
                    })?;
                let height = hcd_column_attribute(tag, "data-hcd-height-points")
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|height| height.is_finite() && (1.0..=409.0).contains(height))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("XLSX HCD edited row height is invalid".to_string())
                    })?;
                if sheet_heights.insert(row, height).is_some() {
                    return Err(HcdError::InvalidBundle(
                        "XLSX HCD edited row is duplicated".to_string(),
                    ));
                }
            }
        }
    }
    Ok(heights)
}

fn hcd_column_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!(" {name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

fn collect_canonical_sheet_rows(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    replacements: &HashMap<String, BTreeMap<String, String>>,
) -> Result<HashMap<String, BTreeSet<u32>>, HcdError> {
    let mut rows: HashMap<String, BTreeSet<u32>> = replacements
        .keys()
        .map(|part| (part.clone(), BTreeSet::new()))
        .collect();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            let sheet = workbook.sheets.get(grid.sheet_index).ok_or_else(|| {
                HcdError::InvalidBundle("XLSX HCD sheet index is missing".to_string())
            })?;
            let Some(sheet_rows) = rows.get_mut(&sheet.part) else {
                continue;
            };
            let html = bundle.read_chunk(&descriptor)?;
            let mut remaining = html.as_str();
            const MARKER: &str = " data-hcd-row=\"";
            while let Some(offset) = remaining.find(MARKER) {
                remaining = &remaining[offset + MARKER.len()..];
                let end = remaining.find('"').ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX HCD row number is unclosed".to_string())
                })?;
                let row: u32 = remaining[..end].parse().map_err(|_| {
                    HcdError::InvalidBundle("XLSX HCD row number is invalid".to_string())
                })?;
                if !(1..=1_048_576).contains(&row) || !sheet_rows.insert(row) {
                    return Err(HcdError::InvalidBundle(
                        "XLSX HCD row is invalid or duplicated".to_string(),
                    ));
                }
                remaining = &remaining[end + 1..];
            }
        }
    }
    Ok(rows)
}

fn collect_canonical_sheet_last_columns(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    replacements: &HashMap<String, BTreeMap<String, String>>,
) -> Result<HashMap<String, u32>, HcdError> {
    let mut columns: HashMap<String, u32> =
        replacements.keys().map(|part| (part.clone(), 0)).collect();
    for page_number in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, page_number)?.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            let sheet = workbook.sheets.get(grid.sheet_index).ok_or_else(|| {
                HcdError::InvalidBundle("XLSX HCD sheet index is missing".to_string())
            })?;
            if let Some(last) = columns.get_mut(&sheet.part) {
                *last = (*last).max(grid.column_end.unwrap_or(0));
            }
        }
    }
    Ok(columns)
}

fn collect_canonical_merge_ranges(
    bundle: &Bundle,
    manifest: &HcdManifest,
    workbook: &WorkbookInfo,
    replacements: &HashMap<String, BTreeMap<String, String>>,
) -> Result<HashMap<String, BTreeSet<String>>, HcdError> {
    let mut ranges: HashMap<String, BTreeSet<String>> = replacements
        .keys()
        .map(|part| (part.clone(), BTreeSet::new()))
        .collect();
    for page_number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(manifest, page_number)?;
        for descriptor in page.chunks {
            let Some(grid) = descriptor.grid.as_ref() else {
                continue;
            };
            if grid.kind != GridChunkKind::Cells {
                continue;
            }
            let sheet = workbook.sheets.get(grid.sheet_index).ok_or_else(|| {
                HcdError::InvalidBundle(format!(
                    "HCD worksheet index {} is missing from the source workbook",
                    grid.sheet_index
                ))
            })?;
            let Some(sheet_ranges) = ranges.get_mut(&sheet.part) else {
                continue;
            };
            let html = bundle.read_chunk(&descriptor)?;
            let mut remaining = html.as_str();
            const MARKER: &str = " data-hcd-merge=\"";
            while let Some(offset) = remaining.find(MARKER) {
                remaining = &remaining[offset + MARKER.len()..];
                let end = remaining.find('"').ok_or_else(|| {
                    HcdError::InvalidBundle("XLSX merge attribute is not closed".to_string())
                })?;
                let reference = &remaining[..end];
                if parse_merge_reference(reference).is_none() {
                    return Err(HcdError::InvalidBundle(format!(
                        "invalid HCD XLSX merge reference {reference}"
                    )));
                }
                if !sheet_ranges.insert(reference.to_string()) {
                    return Err(HcdError::InvalidBundle(format!(
                        "duplicate HCD XLSX merge reference {reference}"
                    )));
                }
                if sheet_ranges.len() > MAX_MERGED_RANGES {
                    return Err(HcdError::ResourceLimit(format!(
                        "XLSX worksheet exceeds {MAX_MERGED_RANGES} merged ranges"
                    )));
                }
                remaining = &remaining[end + 1..];
            }
        }
    }
    Ok(ranges)
}

fn write_merge_cells(
    writer: &mut Writer<impl Write>,
    qualified_name: &[u8],
    merges: &BTreeSet<String>,
) -> Result<(), HcdError> {
    if merges.is_empty() {
        return Ok(());
    }
    let name = String::from_utf8_lossy(qualified_name).to_string();
    let child_name = name.replacen("mergeCells", "mergeCell", 1);
    let mut start = BytesStart::new(name.as_str());
    let count = merges.len().to_string();
    start.push_attribute(("count", count.as_str()));
    writer.write_event(Event::Start(start))?;
    for reference in merges {
        let mut cell = BytesStart::new(child_name.as_str());
        cell.push_attribute(("ref", reference.as_str()));
        writer.write_event(Event::Empty(cell))?;
    }
    writer.write_event(Event::End(BytesEnd::new(name.as_str())))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn rewrite_worksheet(
    source: &mut dyn Read,
    output: impl Write,
    replacements: &BTreeMap<String, String>,
    formulas: &BTreeMap<String, String>,
    created_cells: &BTreeMap<String, String>,
    created_formulas: &BTreeMap<String, String>,
    merges: &BTreeSet<String>,
    canonical_rows: &BTreeSet<u32>,
    column_widths: &BTreeMap<u32, f64>,
    row_heights: &BTreeMap<u32, f64>,
    row_insertions: &[RowShift],
    column_shifts: &[ColumnShift],
    hcd_last_column: u32,
) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(BufReader::with_capacity(64 * 1024, source));
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::with_capacity(64 * 1024);
    let mut skip_depth = 0usize;
    let mut seen_original = BTreeSet::new();
    let mut seen_formulas = BTreeSet::new();
    let mut seen_created = BTreeSet::new();
    let mut replacement_rows: BTreeMap<u32, BTreeMap<u32, (String, String, bool)>> =
        BTreeMap::new();
    for (reference, text) in created_cells {
        let (row, column) = cell_coordinates(reference).ok_or_else(|| {
            HcdError::InvalidBundle(format!("invalid XLSX cell locator {reference}"))
        })?;
        if replacement_rows
            .entry(row)
            .or_default()
            .insert(column, (reference.clone(), text.clone(), false))
            .is_some()
        {
            return Err(HcdError::InvalidBundle(format!(
                "duplicate XLSX cell locator {reference}"
            )));
        }
    }
    for (reference, formula) in created_formulas {
        let (row, column) = cell_coordinates(reference).ok_or_else(|| {
            HcdError::InvalidBundle(format!("invalid XLSX formula locator {reference}"))
        })?;
        if replacement_rows
            .entry(row)
            .or_default()
            .insert(column, (reference.clone(), formula.clone(), true))
            .is_some()
        {
            return Err(HcdError::InvalidBundle(format!(
                "duplicate XLSX cell locator {reference}"
            )));
        }
    }
    let mut row_pending = BTreeMap::new();
    let mut active_row = None;
    let mut last_row = 0u32;
    let mut last_source_row = 0u32;
    let mut row_cell_name = String::from("c");
    let mut row_name = String::from("row");
    let mut merge_written = false;
    let mut sheet_data_seen = false;
    let mut pending_widths = column_widths.clone();
    let mut column_group_seen = false;
    let mut column_group_open = false;
    let mut last_source_column = 0u32;
    let canonical_last_row = canonical_rows.last().copied().unwrap_or(0);
    let canonical_last_column = replacements
        .keys()
        .filter_map(|reference| cell_coordinates(reference).map(|(_, column)| column))
        .chain(
            created_cells
                .keys()
                .filter_map(|reference| cell_coordinates(reference).map(|(_, column)| column)),
        )
        .chain(
            created_formulas
                .keys()
                .filter_map(|reference| cell_coordinates(reference).map(|(_, column)| column)),
        )
        .chain(column_widths.keys().copied())
        .max()
        .unwrap_or(0)
        .max(hcd_last_column);
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| HcdError::InvalidBundle(format!("worksheet export XML: {error}")))?;
        if skip_depth > 0 {
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
            Event::Start(ref start)
                if local_name(start.name().as_ref()) == "cols" && !column_widths.is_empty() =>
            {
                column_group_seen = true;
                column_group_open = true;
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref empty)
                if local_name(empty.name().as_ref()) == "cols" && !column_widths.is_empty() =>
            {
                column_group_seen = true;
                let name = String::from_utf8_lossy(empty.name().as_ref()).into_owned();
                let col_name = qualified_child_name(empty.name().as_ref(), "col");
                writer.write_event(Event::Start(empty.to_owned()))?;
                write_new_worksheet_columns(&mut writer, &col_name, &mut pending_widths)?;
                writer.write_event(Event::End(BytesEnd::new(name)))?;
            }
            Event::Empty(ref empty)
                if local_name(empty.name().as_ref()) == "col" && column_group_open =>
            {
                let min = attribute(empty, "min")
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|value| (1..=16_384).contains(value))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid XLSX source column min".to_string())
                    })?;
                let max = attribute(empty, "max")
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|value| (min..=16_384).contains(value))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid XLSX source column max".to_string())
                    })?;
                if min <= last_source_column {
                    return Err(HcdError::InvalidBundle(
                        "overlapping XLSX source column ranges cannot be resized".to_string(),
                    ));
                }
                last_source_column = max;
                let name = String::from_utf8_lossy(empty.name().as_ref()).into_owned();
                let before: Vec<u32> = pending_widths
                    .range(..min)
                    .map(|(&column, _)| column)
                    .collect();
                for column in before {
                    let width = pending_widths.remove(&column).expect("pending column");
                    write_new_worksheet_column(&mut writer, &name, column, width)?;
                }
                let edits: Vec<(u32, f64)> = pending_widths
                    .range(min..=max)
                    .map(|(&column, &width)| (column, width))
                    .collect();
                if edits.is_empty() {
                    writer.write_event(event.into_owned())?;
                } else {
                    let mut cursor = min;
                    for (column, width) in edits {
                        if cursor < column {
                            write_source_column_segment(
                                &mut writer,
                                empty,
                                cursor,
                                column - 1,
                                None,
                            )?;
                        }
                        write_source_column_segment(
                            &mut writer,
                            empty,
                            column,
                            column,
                            Some(width),
                        )?;
                        pending_widths.remove(&column);
                        cursor = column + 1;
                    }
                    if cursor <= max {
                        write_source_column_segment(&mut writer, empty, cursor, max, None)?;
                    }
                }
            }
            Event::Start(ref start)
                if local_name(start.name().as_ref()) == "col" && column_group_open =>
            {
                return Err(HcdError::InvalidBundle(
                    "nonempty XLSX source column cannot be resized".to_string(),
                ));
            }
            Event::End(ref end)
                if local_name(end.name().as_ref()) == "cols" && column_group_open =>
            {
                let col_name = qualified_child_name(end.name().as_ref(), "col");
                write_new_worksheet_columns(&mut writer, &col_name, &mut pending_widths)?;
                column_group_open = false;
                writer.write_event(event.into_owned())?;
            }
            Event::Start(ref start)
                if local_name(start.name().as_ref()) == "sheetData"
                    && !column_group_seen
                    && !column_widths.is_empty() =>
            {
                let cols_name = qualified_child_name(start.name().as_ref(), "cols");
                let col_name = qualified_child_name(start.name().as_ref(), "col");
                writer.write_event(Event::Start(BytesStart::new(cols_name.as_str())))?;
                write_new_worksheet_columns(&mut writer, &col_name, &mut pending_widths)?;
                writer.write_event(Event::End(BytesEnd::new(cols_name.as_str())))?;
                column_group_seen = true;
                writer.write_event(event.into_owned())?;
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "dimension" => {
                writer.write_event(Event::Empty(expand_worksheet_dimension(
                    empty,
                    canonical_last_row,
                    canonical_last_column,
                    row_insertions
                        .iter()
                        .any(|shift| matches!(shift, RowShift::Delete(_))),
                    column_shifts
                        .iter()
                        .any(|shift| matches!(shift, ColumnShift::Delete(_))),
                )?))?;
            }
            Event::Start(ref start)
                if (!row_insertions.is_empty() || !column_shifts.is_empty())
                    && matches!(local_name(start.name().as_ref()), "sheetView" | "selection") =>
            {
                writer.write_event(Event::Start(rewrite_xlsx_view_attributes(
                    start,
                    row_insertions,
                    column_shifts,
                )?))?;
            }
            Event::Empty(ref empty)
                if (!row_insertions.is_empty() || !column_shifts.is_empty())
                    && matches!(local_name(empty.name().as_ref()), "sheetView" | "selection") =>
            {
                writer.write_event(Event::Empty(rewrite_xlsx_view_attributes(
                    empty,
                    row_insertions,
                    column_shifts,
                )?))?;
            }
            Event::Start(ref start) if local_name(start.name().as_ref()) == "mergeCells" => {
                if !merge_written {
                    write_merge_cells(&mut writer, start.name().as_ref(), merges)?;
                    merge_written = true;
                }
                skip_depth = 1;
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "mergeCells" => {
                if !merge_written {
                    write_merge_cells(&mut writer, empty.name().as_ref(), merges)?;
                    merge_written = true;
                }
            }
            Event::Start(ref start) if local_name(start.name().as_ref()) == "row" => {
                row_name = String::from_utf8_lossy(start.name().as_ref()).to_string();
                let source_row = attribute(start, "r")
                    .and_then(|value| value.parse::<u32>().ok())
                    .or_else(|| last_source_row.checked_add(1))
                    .filter(|row| (1..=1_048_576).contains(row))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid XLSX row number".to_string())
                    })?;
                let row = shifted_xlsx_row(source_row, row_insertions)?;
                if row == 0 {
                    last_source_row = source_row;
                    skip_depth = 1;
                    buffer.clear();
                    continue;
                }
                row_cell_name = qualified_child_name(start.name().as_ref(), "c");
                write_missing_xlsx_rows(
                    &mut writer,
                    canonical_rows,
                    &mut replacement_rows,
                    last_row,
                    row,
                    &row_name,
                    &row_cell_name,
                    row_heights,
                    &mut seen_created,
                )?;
                last_source_row = source_row;
                last_row = row;
                active_row = Some(row);
                row_pending = replacement_rows.remove(&row).unwrap_or_default();
                writer.write_event(Event::Start(rewrite_xlsx_row_attributes(
                    start,
                    row,
                    row_heights.get(&row).copied(),
                )?))?;
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "row" => {
                row_name = String::from_utf8_lossy(empty.name().as_ref()).to_string();
                let source_row = attribute(empty, "r")
                    .and_then(|value| value.parse::<u32>().ok())
                    .or_else(|| last_source_row.checked_add(1))
                    .filter(|row| (1..=1_048_576).contains(row))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid XLSX row number".to_string())
                    })?;
                let row = shifted_xlsx_row(source_row, row_insertions)?;
                if row == 0 {
                    last_source_row = source_row;
                    buffer.clear();
                    continue;
                }
                row_cell_name = qualified_child_name(empty.name().as_ref(), "c");
                write_missing_xlsx_rows(
                    &mut writer,
                    canonical_rows,
                    &mut replacement_rows,
                    last_row,
                    row,
                    &row_name,
                    &row_cell_name,
                    row_heights,
                    &mut seen_created,
                )?;
                last_source_row = source_row;
                last_row = row;
                let mut pending = replacement_rows.remove(&row).unwrap_or_default();
                if pending.is_empty() {
                    writer.write_event(Event::Empty(rewrite_xlsx_row_attributes(
                        empty,
                        row,
                        row_heights.get(&row).copied(),
                    )?))?;
                } else {
                    let name = String::from_utf8_lossy(empty.name().as_ref()).to_string();
                    writer.write_event(Event::Start(rewrite_xlsx_row_attributes(
                        empty,
                        row,
                        row_heights.get(&row).copied(),
                    )?))?;
                    flush_new_xlsx_cells(
                        &mut writer,
                        &mut pending,
                        None,
                        &row_cell_name,
                        &mut seen_created,
                    )?;
                    writer.write_event(Event::End(BytesEnd::new(name)))?;
                }
            }
            Event::Start(ref start) if local_name(start.name().as_ref()) == "c" => {
                let reference = attribute(start, "r").unwrap_or_default();
                if let Some((_, column)) = cell_coordinates(&reference) {
                    if shifted_xlsx_column(column, column_shifts)? == 0 {
                        skip_depth = 1;
                        buffer.clear();
                        continue;
                    }
                }
                let shifted_reference =
                    shifted_xlsx_cell_reference(&reference, row_insertions, column_shifts)?;
                let mut created_here = None;
                if let Some((row, column)) = cell_coordinates(&reference) {
                    if active_row == Some(shifted_xlsx_row(row, row_insertions)?) {
                        let current_column = shifted_xlsx_column(column, column_shifts)?;
                        flush_new_xlsx_cells(
                            &mut writer,
                            &mut row_pending,
                            Some(current_column),
                            &row_cell_name,
                            &mut seen_created,
                        )?;
                        created_here = row_pending.remove(&current_column);
                    }
                }
                let shifted = rewrite_xlsx_address_attribute(start, &shifted_reference)?;
                if let Some((created_ref, text, is_formula)) = created_here {
                    if replacements.contains_key(&reference) {
                        return Err(HcdError::InvalidBundle(format!(
                            "XLSX cell {reference} is both created and replaced"
                        )));
                    }
                    if is_formula {
                        write_formula_cell(&mut writer, &shifted, &text)?;
                    } else {
                        write_inline_cell(&mut writer, &shifted, &text)?;
                    }
                    seen_created.insert(created_ref);
                    skip_depth = 1;
                } else if let Some(formula) = formulas.get(&reference) {
                    write_formula_cell(&mut writer, &shifted, formula)?;
                    seen_formulas.insert(reference);
                    skip_depth = 1;
                } else if let Some(text) = replacements.get(&reference) {
                    write_inline_cell(&mut writer, &shifted, text)?;
                    seen_original.insert(reference);
                    skip_depth = 1;
                } else {
                    writer.write_event(Event::Start(shifted))?;
                }
            }
            Event::Empty(ref empty) if local_name(empty.name().as_ref()) == "c" => {
                let reference = attribute(empty, "r").unwrap_or_default();
                if let Some((_, column)) = cell_coordinates(&reference) {
                    if shifted_xlsx_column(column, column_shifts)? == 0 {
                        buffer.clear();
                        continue;
                    }
                }
                let shifted_reference =
                    shifted_xlsx_cell_reference(&reference, row_insertions, column_shifts)?;
                let mut created_here = None;
                if let Some((row, column)) = cell_coordinates(&reference) {
                    if active_row == Some(shifted_xlsx_row(row, row_insertions)?) {
                        let current_column = shifted_xlsx_column(column, column_shifts)?;
                        flush_new_xlsx_cells(
                            &mut writer,
                            &mut row_pending,
                            Some(current_column),
                            &row_cell_name,
                            &mut seen_created,
                        )?;
                        created_here = row_pending.remove(&current_column);
                    }
                }
                let shifted = rewrite_xlsx_address_attribute(empty, &shifted_reference)?;
                if let Some((created_ref, text, is_formula)) = created_here {
                    if replacements.contains_key(&reference) {
                        return Err(HcdError::InvalidBundle(format!(
                            "XLSX cell {reference} is both created and replaced"
                        )));
                    }
                    if is_formula {
                        write_formula_cell(&mut writer, &shifted, &text)?;
                    } else {
                        write_inline_cell(&mut writer, &shifted, &text)?;
                    }
                    seen_created.insert(created_ref);
                } else if let Some(formula) = formulas.get(&reference) {
                    write_formula_cell(&mut writer, &shifted, formula)?;
                    seen_formulas.insert(reference);
                } else if let Some(text) = replacements.get(&reference) {
                    write_inline_cell(&mut writer, &shifted, text)?;
                    seen_original.insert(reference);
                } else {
                    writer.write_event(Event::Empty(shifted))?;
                }
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "row" => {
                flush_new_xlsx_cells(
                    &mut writer,
                    &mut row_pending,
                    None,
                    &row_cell_name,
                    &mut seen_created,
                )?;
                active_row = None;
                writer.write_event(event.into_owned())?;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "sheetData" => {
                sheet_data_seen = true;
                write_missing_xlsx_rows(
                    &mut writer,
                    canonical_rows,
                    &mut replacement_rows,
                    last_row,
                    1_048_577,
                    &row_name,
                    &row_cell_name,
                    row_heights,
                    &mut seen_created,
                )?;
                let name = end.name().as_ref().to_vec();
                writer.write_event(event.into_owned())?;
                if !merge_written {
                    let qualified = String::from_utf8_lossy(&name);
                    let prefix = qualified.split_once(':').map(|(prefix, _)| prefix);
                    let merge_name = prefix.map_or_else(
                        || "mergeCells".to_string(),
                        |prefix| format!("{prefix}:mergeCells"),
                    );
                    write_merge_cells(&mut writer, merge_name.as_bytes(), merges)?;
                    merge_written = true;
                }
            }
            Event::Eof => break,
            _ => writer.write_event(event.into_owned())?,
        }
        buffer.clear();
    }
    if !sheet_data_seen {
        return Err(HcdError::InvalidBundle(
            "XLSX worksheet is missing sheetData".to_string(),
        ));
    }
    if seen_original.len() != replacements.len()
        || seen_created.len() != created_cells.len() + created_formulas.len()
        || seen_formulas.len() != formulas.len()
    {
        let missing: Vec<_> = replacements
            .keys()
            .filter(|cell| !seen_original.contains(*cell))
            .chain(
                created_cells
                    .keys()
                    .filter(|cell| !seen_created.contains(*cell)),
            )
            .chain(
                created_formulas
                    .keys()
                    .filter(|cell| !seen_created.contains(*cell)),
            )
            .chain(
                formulas
                    .keys()
                    .filter(|cell| !seen_formulas.contains(*cell)),
            )
            .cloned()
            .collect();
        return Err(HcdError::InvalidBundle(format!(
            "worksheet is missing mapped cells {missing:?}"
        )));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum RowShift {
    Insert(u32),
    Delete(u32),
}

fn shifted_xlsx_row(mut row: u32, shifts: &[RowShift]) -> Result<u32, HcdError> {
    for shift in shifts {
        match *shift {
            RowShift::Insert(before) if row >= before => {
                row = row
                    .checked_add(1)
                    .filter(|row| *row <= 1_048_576)
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX row insertion exceeds the worksheet limit".to_string(),
                        )
                    })?;
            }
            RowShift::Delete(at) if row == at => return Ok(0),
            RowShift::Delete(at) if row > at => row -= 1,
            _ => {}
        }
    }
    Ok(row)
}

fn verify_grid_shift_source(
    archive: &mut StreamingOxmlArchive,
    workbook: &WorkbookInfo,
    row_insertions: &HashMap<String, Vec<RowShift>>,
    column_shifts: &HashMap<String, Vec<ColumnShift>>,
) -> Result<(), HcdError> {
    for entry in archive.entries() {
        let name = entry.name.as_str();
        if name.starts_with("xl/charts/")
            || name.starts_with("xl/drawings/")
            || name.starts_with("xl/tables/")
            || name.starts_with("xl/pivot")
            || name.starts_with("xl/externalLinks/")
            || name == "xl/calcChain.xml"
        {
            return Err(HcdError::Unsupported(format!(
                "XLSX grid shift cannot update {name}"
            )));
        }
    }
    let workbook_xml = archive
        .read_control_part("xl/workbook.xml", MAX_CONTROL_BYTES)
        .map_err(package_error)?;
    let mut workbook_reader = Reader::from_reader(workbook_xml.as_slice());
    let mut workbook_buffer = Vec::new();
    loop {
        let event = workbook_reader
            .read_event_into(&mut workbook_buffer)
            .map_err(|error| {
                HcdError::InvalidBundle(format!("invalid XLSX workbook XML: {error}"))
            })?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element)
                if local_name(element.name().as_ref()) == "definedName" =>
            {
                return Err(HcdError::Unsupported(
                    "XLSX grid shift cannot update defined names".to_string(),
                ));
            }
            Event::Eof => break,
            _ => {}
        }
        workbook_buffer.clear();
    }
    for sheet in &workbook.sheets {
        let target =
            row_insertions.contains_key(&sheet.part) || column_shifts.contains_key(&sheet.part);
        archive
            .with_part(&sheet.part, |source| {
                let mut reader = Reader::from_reader(BufReader::new(source));
                reader.config_mut().check_end_names = true;
                let mut buffer = Vec::new();
                loop {
                    let event = reader.read_event_into(&mut buffer).map_err(|error| {
                        PackageError::ReadPartError(format!("{}: {error}", sheet.part))
                    })?;
                    match event {
                        Event::Start(ref element) | Event::Empty(ref element) => {
                            let name = element.name();
                            let tag = local_name(name.as_ref());
                            if matches!(
                                tag,
                                "f" | "formula"
                                    | "conditionalFormatting"
                                    | "dataValidation"
                                    | "dataValidations"
                                    | "autoFilter"
                                    | "tableParts"
                                    | "hyperlinks"
                                    | "drawing"
                                    | "legacyDrawing"
                                    | "extLst"
                            ) {
                                return Err(PackageError::ReadPartError(format!(
                                    "grid shift cannot update worksheet element {tag}"
                                )));
                            }
                            if target
                                && !matches!(
                                    tag,
                                    "worksheet"
                                        | "sheetPr"
                                        | "outlinePr"
                                        | "pageSetUpPr"
                                        | "dimension"
                                        | "sheetViews"
                                        | "sheetView"
                                        | "selection"
                                        | "sheetFormatPr"
                                        | "cols"
                                        | "col"
                                        | "sheetData"
                                        | "row"
                                        | "c"
                                        | "v"
                                        | "is"
                                        | "t"
                                        | "mergeCells"
                                        | "mergeCell"
                                        | "pageMargins"
                                        | "pageSetup"
                                        | "printOptions"
                                )
                            {
                                return Err(PackageError::ReadPartError(format!(
                                    "grid shift cannot update worksheet element {tag}"
                                )));
                            }
                            if column_shifts.contains_key(&sheet.part)
                                && matches!(tag, "cols" | "col")
                            {
                                return Err(PackageError::ReadPartError(
                                    "column shift cannot update explicit source column widths"
                                        .to_string(),
                                ));
                            }
                            if target && matches!(tag, "sheetView" | "selection") {
                                rewrite_xlsx_view_attributes(
                                    element,
                                    row_insertions
                                        .get(&sheet.part)
                                        .map(Vec::as_slice)
                                        .unwrap_or(&[]),
                                    column_shifts
                                        .get(&sheet.part)
                                        .map(Vec::as_slice)
                                        .unwrap_or(&[]),
                                )
                                .map_err(|error| PackageError::ReadPartError(error.to_string()))?;
                            }
                            if target && tag == "c" && attribute(element, "r").is_none() {
                                return Err(PackageError::ReadPartError(
                                    "grid insertion requires explicit cell references".to_string(),
                                ));
                            }
                        }
                        Event::Eof => break,
                        _ => {}
                    }
                    buffer.clear();
                }
                Ok(())
            })
            .map_err(|error| HcdError::Unsupported(error.to_string()))?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ColumnShift {
    Insert(u32),
    Delete(u32),
}

fn shifted_xlsx_column(mut column: u32, shifts: &[ColumnShift]) -> Result<u32, HcdError> {
    for shift in shifts {
        match *shift {
            ColumnShift::Insert(before) if column >= before => {
                column = column
                    .checked_add(1)
                    .filter(|column| *column <= 16_384)
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX column insertion exceeds the worksheet limit".to_string(),
                        )
                    })?;
            }
            ColumnShift::Delete(at) if column == at => return Ok(0),
            ColumnShift::Delete(at) if column > at => column -= 1,
            _ => {}
        }
    }
    Ok(column)
}

fn shifted_xlsx_cell_reference(
    reference: &str,
    row_insertions: &[RowShift],
    column_shifts: &[ColumnShift],
) -> Result<String, HcdError> {
    if row_insertions.is_empty() && column_shifts.is_empty() {
        return Ok(reference.to_string());
    }
    let (row, column) = cell_coordinates(reference).ok_or_else(|| {
        HcdError::Unsupported(format!(
            "XLSX grid shift requires an explicit cell address: {reference}"
        ))
    })?;
    Ok(format!(
        "{}{}",
        column_name(shifted_xlsx_column(column, column_shifts)?),
        shifted_xlsx_row(row, row_insertions)?
    ))
}

fn parse_xlsx_view_cell(reference: &str) -> Option<(u32, u32, bool, bool)> {
    let (column_absolute, rest) = reference
        .strip_prefix('$')
        .map_or((false, reference), |rest| (true, rest));
    let letters = rest
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_alphabetic())
        .count();
    if letters == 0 {
        return None;
    }
    let (column, rest) = rest.split_at(letters);
    let (row_absolute, row) = rest
        .strip_prefix('$')
        .map_or((false, rest), |row| (true, row));
    if row.is_empty() || !row.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let (row, column) = cell_coordinates(&format!("{column}{row}"))?;
    Some((row, column, column_absolute, row_absolute))
}

fn shifted_xlsx_view_cell(
    reference: &str,
    row_shifts: &[RowShift],
    column_shifts: &[ColumnShift],
) -> Result<String, HcdError> {
    let (mut row, mut column, column_absolute, row_absolute) = parse_xlsx_view_cell(reference)
        .ok_or_else(|| {
            HcdError::Unsupported(format!("unsupported XLSX view reference {reference}"))
        })?;
    for shift in row_shifts {
        match *shift {
            RowShift::Insert(before) if row >= before => {
                row = row
                    .checked_add(1)
                    .filter(|row| *row <= 1_048_576)
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX view row exceeds the worksheet limit".to_string(),
                        )
                    })?;
            }
            RowShift::Delete(at) if row > at => row -= 1,
            // The selected row was removed. Its successor now occupies the same address.
            RowShift::Delete(_) => {}
            _ => {}
        }
    }
    for shift in column_shifts {
        match *shift {
            ColumnShift::Insert(before) if column >= before => {
                column = column
                    .checked_add(1)
                    .filter(|column| *column <= 16_384)
                    .ok_or_else(|| {
                        HcdError::Unsupported(
                            "XLSX view column exceeds the worksheet limit".to_string(),
                        )
                    })?;
            }
            ColumnShift::Delete(at) if column > at => column -= 1,
            // The selected column was removed. Its successor now occupies the same address.
            ColumnShift::Delete(_) => {}
            _ => {}
        }
    }
    Ok(format!(
        "{}{}{}{}",
        if column_absolute { "$" } else { "" },
        column_name(column),
        if row_absolute { "$" } else { "" },
        row
    ))
}

fn shifted_xlsx_view_reference(
    value: &str,
    field: &str,
    row_shifts: &[RowShift],
    column_shifts: &[ColumnShift],
) -> Result<String, HcdError> {
    let mut rewritten = Vec::new();
    for token in value.split_whitespace() {
        let next = if field == "sqref" {
            if let Some((first, last)) = token.split_once(':') {
                format!(
                    "{}:{}",
                    shifted_xlsx_view_cell(first, row_shifts, column_shifts)?,
                    shifted_xlsx_view_cell(last, row_shifts, column_shifts)?
                )
            } else {
                shifted_xlsx_view_cell(token, row_shifts, column_shifts)?
            }
        } else {
            shifted_xlsx_view_cell(token, row_shifts, column_shifts)?
        };
        rewritten.push(next);
    }
    if rewritten.is_empty() || (field != "sqref" && rewritten.len() != 1) {
        return Err(HcdError::Unsupported(format!(
            "unsupported XLSX {field} view reference {value}"
        )));
    }
    Ok(rewritten.join(" "))
}

fn rewrite_xlsx_view_attributes(
    original: &BytesStart<'_>,
    row_shifts: &[RowShift],
    column_shifts: &[ColumnShift],
) -> Result<BytesStart<'static>, HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut rewritten = BytesStart::new(name);
    for attr in original.attributes().with_checks(false) {
        let attr = attr.map_err(|error| {
            HcdError::InvalidBundle(format!("invalid XLSX view attribute: {error}"))
        })?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let field = local_name(attr.key.as_ref());
        if matches!(field, "topLeftCell" | "activeCell" | "sqref") {
            let value = attr.unescape_value().map_err(|error| {
                HcdError::InvalidBundle(format!("invalid XLSX {field} attribute: {error}"))
            })?;
            let shifted = shifted_xlsx_view_reference(&value, field, row_shifts, column_shifts)?;
            rewritten.push_attribute((key.as_str(), shifted.as_str()));
        } else {
            let value = String::from_utf8_lossy(attr.value.as_ref()).into_owned();
            rewritten.push_attribute((key.as_str(), value.as_str()));
        }
    }
    Ok(rewritten)
}

fn rewrite_xlsx_address_attribute(
    original: &BytesStart<'_>,
    reference: &str,
) -> Result<BytesStart<'static>, HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut rewritten = BytesStart::new(name);
    let mut found = false;
    for attr in original.attributes().with_checks(false) {
        let attr = attr
            .map_err(|error| HcdError::InvalidBundle(format!("invalid XLSX attribute: {error}")))?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        if local_name(attr.key.as_ref()) == "r" {
            rewritten.push_attribute((key.as_str(), reference));
            found = true;
        } else {
            let value = String::from_utf8_lossy(attr.value.as_ref()).into_owned();
            rewritten.push_attribute((key.as_str(), value.as_str()));
        }
    }
    if !found {
        rewritten.push_attribute(("r", reference));
    }
    Ok(rewritten)
}

fn rewrite_xlsx_row_attributes(
    original: &BytesStart<'_>,
    row: u32,
    height: Option<f64>,
) -> Result<BytesStart<'static>, HcdError> {
    let shifted = rewrite_xlsx_address_attribute(original, &row.to_string())?;
    let Some(height) = height else {
        return Ok(shifted);
    };
    let name = String::from_utf8_lossy(shifted.name().as_ref()).into_owned();
    let mut rewritten = BytesStart::new(name);
    let value = format!("{height:.2}");
    let mut has_height = false;
    let mut has_custom_height = false;
    for attr in shifted.attributes().with_checks(false) {
        let attr = attr.map_err(|error| {
            HcdError::InvalidBundle(format!("invalid XLSX row attribute: {error}"))
        })?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        match local_name(attr.key.as_ref()) {
            "ht" => {
                rewritten.push_attribute((key.as_str(), value.as_str()));
                has_height = true;
            }
            "customHeight" => {
                rewritten.push_attribute((key.as_str(), "1"));
                has_custom_height = true;
            }
            _ => rewritten.push_attribute((key.as_bytes(), attr.value.as_ref())),
        }
    }
    if !has_height {
        rewritten.push_attribute(("ht", value.as_str()));
    }
    if !has_custom_height {
        rewritten.push_attribute(("customHeight", "1"));
    }
    Ok(rewritten)
}

#[allow(clippy::too_many_arguments)]
fn write_missing_xlsx_rows(
    writer: &mut Writer<impl Write>,
    canonical_rows: &BTreeSet<u32>,
    replacement_rows: &mut BTreeMap<u32, BTreeMap<u32, (String, String, bool)>>,
    last_row: u32,
    before_row: u32,
    row_name: &str,
    cell_name: &str,
    row_heights: &BTreeMap<u32, f64>,
    seen: &mut BTreeSet<String>,
) -> Result<(), HcdError> {
    for &row in canonical_rows.range((last_row.saturating_add(1))..before_row) {
        let mut pending = replacement_rows.remove(&row).unwrap_or_default();
        let mut element = BytesStart::new(row_name);
        let value = row.to_string();
        element.push_attribute(("r", value.as_str()));
        if let Some(height) = row_heights.get(&row) {
            let height = format!("{height:.2}");
            element.push_attribute(("ht", height.as_str()));
            element.push_attribute(("customHeight", "1"));
        }
        if pending.is_empty() {
            writer.write_event(Event::Empty(element))?;
        } else {
            writer.write_event(Event::Start(element))?;
            flush_new_xlsx_cells(writer, &mut pending, None, cell_name, seen)?;
            writer.write_event(Event::End(BytesEnd::new(row_name)))?;
        }
    }
    Ok(())
}

fn expand_worksheet_dimension(
    original: &BytesStart<'_>,
    canonical_last_row: u32,
    canonical_last_column: u32,
    shrink_rows: bool,
    shrink_columns: bool,
) -> Result<BytesStart<'static>, HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut expanded = BytesStart::new(name);
    for attribute in original.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| {
            HcdError::InvalidBundle(format!(
                "invalid XLSX worksheet dimension attribute: {error}"
            ))
        })?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let mut value = attribute
            .unescape_value()
            .map_err(|error| {
                HcdError::InvalidBundle(format!("invalid XLSX worksheet dimension: {error}"))
            })?
            .into_owned();
        if local_name(attribute.key.as_ref()) == "ref" && (shrink_rows || shrink_columns) {
            value = if canonical_last_row == 0 || canonical_last_column == 0 {
                "A1".to_string()
            } else {
                format!(
                    "A1:{}{}",
                    column_name(canonical_last_column),
                    canonical_last_row
                )
            };
        } else if local_name(attribute.key.as_ref()) == "ref"
            && (canonical_last_row > 0 || canonical_last_column > 0)
        {
            let (first, last) = value.split_once(':').unwrap_or((&value, &value));
            if let (Some((first_row, first_column)), Some((last_row, last_column))) =
                (cell_coordinates(first), cell_coordinates(last))
            {
                if shrink_rows
                    || canonical_last_row > last_row
                    || canonical_last_column > last_column
                {
                    value = format!(
                        "{}{}:{}{}",
                        column_name(first_column),
                        first_row,
                        column_name(last_column.max(canonical_last_column)),
                        if shrink_rows {
                            canonical_last_row.max(1)
                        } else {
                            last_row.max(canonical_last_row)
                        }
                    );
                }
            }
        }
        expanded.push_attribute((key.as_str(), value.as_str()));
    }
    Ok(expanded.into_owned())
}

fn write_new_worksheet_column(
    writer: &mut Writer<impl Write>,
    name: &str,
    column: u32,
    width: f64,
) -> Result<(), HcdError> {
    let mut element = BytesStart::new(name);
    let address = column.to_string();
    let width = format!("{width:.2}");
    element.push_attribute(("min", address.as_str()));
    element.push_attribute(("max", address.as_str()));
    element.push_attribute(("width", width.as_str()));
    element.push_attribute(("customWidth", "1"));
    writer.write_event(Event::Empty(element))?;
    Ok(())
}

fn write_new_worksheet_columns(
    writer: &mut Writer<impl Write>,
    name: &str,
    pending: &mut BTreeMap<u32, f64>,
) -> Result<(), HcdError> {
    for (column, width) in std::mem::take(pending) {
        write_new_worksheet_column(writer, name, column, width)?;
    }
    Ok(())
}

fn write_source_column_segment(
    writer: &mut Writer<impl Write>,
    original: &BytesStart<'_>,
    min: u32,
    max: u32,
    edited_width: Option<f64>,
) -> Result<(), HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).into_owned();
    let mut element = BytesStart::new(name);
    let mut saw_width = false;
    let mut saw_custom_width = false;
    for attribute in original.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| {
            HcdError::InvalidBundle(format!("invalid XLSX source column attribute: {error}"))
        })?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let value = attribute
            .unescape_value()
            .map_err(|error| {
                HcdError::InvalidBundle(format!("invalid XLSX source column value: {error}"))
            })?
            .into_owned();
        let value = match local_name(attribute.key.as_ref()) {
            "min" => min.to_string(),
            "max" => max.to_string(),
            "width" if edited_width.is_some() => {
                saw_width = true;
                format!("{:.2}", edited_width.expect("checked"))
            }
            "customWidth" if edited_width.is_some() => {
                saw_custom_width = true;
                "1".to_string()
            }
            "bestFit" if edited_width.is_some() => "0".to_string(),
            _ => value,
        };
        element.push_attribute((key.as_str(), value.as_str()));
    }
    if let Some(width) = edited_width {
        if !saw_width {
            element.push_attribute(("width", format!("{width:.2}").as_str()));
        }
        if !saw_custom_width {
            element.push_attribute(("customWidth", "1"));
        }
    }
    writer.write_event(Event::Empty(element))?;
    Ok(())
}

fn qualified_child_name(parent: &[u8], child: &str) -> String {
    let parent = String::from_utf8_lossy(parent);
    parent.split_once(':').map_or_else(
        || child.to_string(),
        |(prefix, _)| format!("{prefix}:{child}"),
    )
}

fn flush_new_xlsx_cells(
    writer: &mut Writer<impl Write>,
    pending: &mut BTreeMap<u32, (String, String, bool)>,
    before_column: Option<u32>,
    cell_name: &str,
    seen: &mut BTreeSet<String>,
) -> Result<(), HcdError> {
    while let Some((&column, _)) = pending.first_key_value() {
        if before_column.is_some_and(|before| column >= before) {
            break;
        }
        let (_, (reference, text, is_formula)) = pending.pop_first().expect("first key exists");
        let mut cell = BytesStart::new(cell_name);
        cell.push_attribute(("r", reference.as_str()));
        if is_formula {
            write_formula_cell(writer, &cell, &text)?;
        } else {
            write_inline_cell(writer, &cell, &text)?;
        }
        seen.insert(reference);
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
    let is_name = qualified_child_name(original.name().as_ref(), "is");
    let text_name = qualified_child_name(original.name().as_ref(), "t");
    writer.write_event(Event::Start(BytesStart::new(is_name.as_str())))?;
    let mut text_start = BytesStart::new(text_name.as_str());
    if text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace) {
        text_start.push_attribute(("xml:space", "preserve"));
    }
    writer.write_event(Event::Start(text_start))?;
    if !text.is_empty() {
        writer.write_event(Event::Text(BytesText::new(text)))?;
    }
    writer.write_event(Event::End(BytesEnd::new(text_name.as_str())))?;
    writer.write_event(Event::End(BytesEnd::new(is_name.as_str())))?;
    writer.write_event(Event::End(BytesEnd::new(String::from_utf8_lossy(
        original.name().as_ref(),
    ))))?;
    Ok(())
}

fn write_formula_cell(
    writer: &mut Writer<impl Write>,
    original: &BytesStart<'_>,
    formula: &str,
) -> Result<(), HcdError> {
    let name = String::from_utf8_lossy(original.name().as_ref()).to_string();
    let mut start = BytesStart::new(name.as_str());
    for attribute in original.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| {
            HcdError::InvalidBundle(format!("invalid XLSX cell attribute: {error}"))
        })?;
        if local_name(attribute.key.as_ref()) != "t" {
            start.push_attribute(attribute);
        }
    }
    writer.write_event(Event::Start(start))?;
    let formula_name = qualified_child_name(original.name().as_ref(), "f");
    writer.write_event(Event::Start(BytesStart::new(formula_name.as_str())))?;
    writer.write_event(Event::Text(BytesText::new(formula)))?;
    writer.write_event(Event::End(BytesEnd::new(formula_name.as_str())))?;
    let value_name = qualified_child_name(original.name().as_ref(), "v");
    writer.write_event(Event::Empty(BytesStart::new(value_name.as_str())))?;
    writer.write_event(Event::End(BytesEnd::new(name.as_str())))?;
    Ok(())
}

fn rewrite_workbook_recalculation(source: &[u8], output: impl Write) -> Result<(), HcdError> {
    let mut reader = Reader::from_reader(source);
    reader.config_mut().check_end_names = true;
    let mut writer = Writer::new(output);
    let mut buffer = Vec::new();
    let mut saw_calc = false;
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(|error| {
            HcdError::InvalidBundle(format!("invalid XLSX workbook XML: {error}"))
        })?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start)
                if local_name(start.name().as_ref()) == "calcPr" =>
            {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                let mut updated = BytesStart::new(name);
                for attribute in start.attributes().with_checks(false) {
                    let attribute = attribute.map_err(|error| {
                        HcdError::InvalidBundle(format!(
                            "invalid workbook calcPr attribute: {error}"
                        ))
                    })?;
                    if !matches!(
                        local_name(attribute.key.as_ref()),
                        "calcMode" | "fullCalcOnLoad" | "forceFullCalc"
                    ) {
                        updated.push_attribute(attribute);
                    }
                }
                updated.push_attribute(("calcMode", "auto"));
                updated.push_attribute(("fullCalcOnLoad", "1"));
                updated.push_attribute(("forceFullCalc", "1"));
                if matches!(event, Event::Start(_)) {
                    writer.write_event(Event::Start(updated))?;
                } else {
                    writer.write_event(Event::Empty(updated))?;
                }
                saw_calc = true;
            }
            Event::End(ref end) if local_name(end.name().as_ref()) == "workbook" => {
                if !saw_calc {
                    let name = qualified_child_name(end.name().as_ref(), "calcPr");
                    let mut calc = BytesStart::new(name);
                    calc.push_attribute(("calcMode", "auto"));
                    calc.push_attribute(("fullCalcOnLoad", "1"));
                    calc.push_attribute(("forceFullCalc", "1"));
                    writer.write_event(Event::Empty(calc))?;
                }
                writer.write_event(event.into_owned())?;
            }
            Event::Eof => break,
            _ => writer.write_event(event.into_owned())?,
        }
        buffer.clear();
    }
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

fn safe_temp_name(part: &str) -> String {
    part.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
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
        HCD_PATCH_SCHEMA_VERSION, HCD_PATCH_SCHEMA_VERSION_6,
    };
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn shared_formula_projection_shifts_only_relative_a1_references() {
        assert_eq!(
            translate_shared_formula("SUM($A1:B$2)+\"A1\"+LOG10(C3)", 1, 2).as_deref(),
            Some("SUM($A2:D$2)+\"A1\"+LOG10(E4)")
        );
        assert_eq!(translate_shared_formula("A1", -1, 0), None);
        assert_eq!(translate_shared_formula("Sheet2!A1", 1, 0), None);
        assert_eq!(translate_shared_formula("Table1[Amount]", 1, 0), None);
    }

    #[test]
    fn incomplete_shared_formula_group_remains_read_only() {
        let source = br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="D1"><f t="shared" ref="D1:D2" si="0">A1+1</f><v>3</v></c></row></sheetData></worksheet>"#;
        let scan =
            scan_worksheet_metadata(&mut source.as_slice(), "xl/worksheets/sheet1.xml").unwrap();
        assert!(scan.shared_formulas.get(&0).is_some_and(Option::is_none));
    }

    #[test]
    fn edits_one_shared_formula_member_and_expands_its_source_group() {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/showcase/budget-tracker.xlsx");
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("budget.hcd");
        let exported = temp.path().join("edited.xlsx");
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("shared-formula-budget"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        let overview = page
            .chunks
            .iter()
            .find(|chunk| {
                chunk.grid.as_ref().is_some_and(|grid| {
                    grid.sheet_name == "Overview" && grid.kind == GridChunkKind::Cells
                })
            })
            .unwrap();
        let html = bundle.read_chunk(overview).unwrap();
        assert!(html.contains("data-hcd-cell=\"G8\" data-hcd-column=\"7\" data-hcd-formula=\"true\" data-hcd-formula-editable=\"true\" data-hcd-formula-expression=\"=SUM(C8:F8)\""));
        assert!(html.contains("data-hcd-cell=\"G9\" data-hcd-column=\"7\" data-hcd-formula=\"true\" data-hcd-formula-editable=\"true\" data-hcd-formula-expression=\"=SUM(C9:F9)\""));
        assert!(html.contains("data-hcd-raw-value=\"375000\""));
        assert!(html.contains("data-hcd-num-fmt-pattern=\"&quot;$&quot;#,##0\""));
        let node = bundle
            .read_map(overview)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("G9"))
            .unwrap();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_20.to_string(),
            document_id: "shared-formula-budget".to_string(),
            patch_id: "edit-g9".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxFormulaSet {
                node_id: node.node_id,
                sheet_id: overview.grid.as_ref().unwrap().sheet_id.clone(),
                formula: "=SUM(C9:E9)".to_string(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let report = export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        assert!(report
            .flattened
            .iter()
            .any(|item| item.contains("shared-formula groups")));
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.code == "XLSX_CHART_CACHE_RECALC_REQUIRED"));
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("<f>SUM(C8:F8)</f><v/>"));
        assert!(worksheet.contains("<f>SUM(C9:E9)</f><v/>"));
        assert!(worksheet.contains("<f>SUM(C10:F10)</f><v/>"));
        assert!(!worksheet.contains("ref=\"G8:G14\""));
        assert!(worksheet.contains("ref=\"H8:H15\""));
        let history = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &history,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&history, "xl/worksheets/sheet1.xml").contains("ref=\"G8:G14\""));
    }

    #[test]
    fn ordinary_formula_edit_preserves_native_formula_and_recalculates() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("formulas.xlsx");
        let bundle_path = temp.path().join("formulas.hcd");
        let exported = temp.path().join("edited.xlsx");
        create_formula_edit_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("formula-edit-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        let descriptor = &page.chunks[0];
        let html = bundle.read_chunk(descriptor).unwrap();
        assert!(html.contains("data-hcd-formula-expression=\"=SUM(A1:B1)\""));
        assert!(html.contains("data-hcd-formula-editable=\"true\""));
        assert!(!html.contains("data-hcd-cell=\"D1\" data-hcd-column=\"4\" data-hcd-formula=\"true\" data-hcd-formula-editable"));
        let map = bundle.read_map(descriptor).unwrap();
        let node = map
            .entries
            .iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("C1"))
            .unwrap();
        assert!(!node.source.editable);
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let shared = map
            .entries
            .iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("D1"))
            .unwrap();
        let shared_patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_20.to_string(),
            document_id: "formula-edit-doc".to_string(),
            patch_id: "reject-shared".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxFormulaSet {
                node_id: shared.node_id.clone(),
                sheet_id: sheet_id.clone(),
                formula: "=A1+2".to_string(),
                precondition: NodePrecondition {
                    node_hash: shared.node_hash.clone(),
                },
            }],
        };
        assert!(hcd_core::apply_patch(&bundle, &shared_patch, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_20.to_string(),
            document_id: "formula-edit-doc".to_string(),
            patch_id: "edit-c1".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxFormulaSet {
                node_id: node.node_id.clone(),
                sheet_id: sheet_id.clone(),
                formula: "=SUM(A1:B1)+1".to_string(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash.clone(),
                },
            }],
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let head = bundle.manifest().unwrap();
        let edited = bundle
            .read_chunk(&bundle.read_index_page(&head, 0).unwrap().chunks[0])
            .unwrap();
        assert!(edited.contains("data-hcd-formula-expression=\"=SUM(A1:B1)+1\""));
        assert!(edited.contains("data-hcd-formula-edited=\"true\""));
        let report = export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.code == "XLSX_FORMULA_RECALC_REQUIRED"));
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("<f>SUM(A1:B1)+1</f><v/>"));
        assert!(worksheet.contains("<f t=\"shared\" si=\"0\">A1+1</f>"));
        let workbook = read_zip_entry(&exported, "xl/workbook.xml");
        assert!(workbook.contains("fullCalcOnLoad=\"1\""));
        assert!(workbook.contains("forceFullCalc=\"1\""));
        let history = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &history,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&history, "xl/worksheets/sheet1.xml")
            .contains("<f>SUM(A1:B1)</f><v>5</v>"));
        let stale = PatchBatch {
            patch_id: "stale-edit".to_string(),
            base_revision: 1,
            ..patch
        };
        assert!(hcd_core::apply_patch(&bundle, &stale, 1).is_err());
    }

    #[test]
    fn converts_real_shared_formulas_to_literal_values_and_keeps_history() {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/showcase/budget-tracker.xlsx");
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("budget.hcd");
        let exported = temp.path().join("literal.xlsx");
        let historical = temp.path().join("original.xlsx");
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("formula-to-value-budget"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = bundle
            .read_index_page(&manifest, 0)
            .unwrap()
            .chunks
            .into_iter()
            .find(|chunk| {
                chunk.grid.as_ref().is_some_and(|grid| {
                    grid.sheet_name == "Overview" && grid.kind == GridChunkKind::Cells
                })
            })
            .unwrap();
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let map = bundle.read_map(&descriptor).unwrap();
        let cell = |address| {
            map.entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some(address))
                .unwrap()
        };
        let g8 = cell("G8");
        let g9 = cell("G9");
        let operation = |entry: &NodeMapEntry, value: &str| PatchOperation::XlsxFormulaToValue {
            node_id: entry.node_id.clone(),
            sheet_id: sheet_id.clone(),
            text: value.to_string(),
            precondition: NodePrecondition {
                node_hash: entry.node_hash.clone(),
            },
        };
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_28.to_string(),
            document_id: manifest.document_id.clone(),
            patch_id: "convert-two-formulas".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![operation(g8, "Manual total"), operation(g9, "")],
        };
        let duplicate = PatchBatch {
            patch_id: "duplicate-target".to_string(),
            operations: vec![operation(g8, "one"), operation(g8, "two")],
            ..patch.clone()
        };
        assert!(hcd_core::apply_patch(&bundle, &duplicate, 0).is_err());
        let wrong_hash = PatchBatch {
            patch_id: "wrong-hash".to_string(),
            operations: vec![PatchOperation::XlsxFormulaToValue {
                node_id: g8.node_id.clone(),
                sheet_id: sheet_id.clone(),
                text: "wrong".to_string(),
                precondition: NodePrecondition {
                    node_hash: "0".repeat(64),
                },
            }],
            ..patch.clone()
        };
        assert!(hcd_core::apply_patch(&bundle, &wrong_hash, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let head = bundle.manifest().unwrap();
        let updated = bundle
            .read_index_page(&head, 0)
            .unwrap()
            .chunks
            .into_iter()
            .find(|chunk| chunk.chunk_id == descriptor.chunk_id)
            .unwrap();
        let new_map = bundle.read_map(&updated).unwrap();
        for original in [g8, g9] {
            let current = new_map
                .entries
                .iter()
                .find(|entry| entry.node_id == original.node_id)
                .unwrap();
            assert!(current.source.editable);
            assert_eq!(current.source.paragraph_id, original.source.paragraph_id);
        }
        let html = bundle.read_chunk(&updated).unwrap();
        assert!(
            html.contains("data-hcd-cell=\"G8\" data-hcd-column=\"7\" data-hcd-formula=\"false\"")
        );
        assert!(
            html.contains("data-hcd-cell=\"G9\" data-hcd-column=\"7\" data-hcd-formula=\"false\"")
        );
        let report = export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.code == "XLSX_FORMULA_TO_VALUE_RECALC_REQUIRED"));
        assert!(report
            .flattened
            .iter()
            .any(|item| item.contains("shared-formula groups")));
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        for (address, value) in [("G8", "Manual total"), ("G9", "")] {
            let cell = xml
                .split(&format!("<c r=\"{address}\""))
                .nth(1)
                .unwrap()
                .split("</c>")
                .next()
                .unwrap();
            assert!(!cell.contains("<f"));
            assert!(cell.contains(&format!("<t>{value}</t>")));
        }
        assert!(!xml.contains("ref=\"G8:G14\""));
        assert!(xml.contains("<f>SUM(C10:F10)</f><v/>"));
        assert!(read_zip_entry(&exported, "xl/workbook.xml").contains("fullCalcOnLoad=\"1\""));
        export_xlsx(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&historical, "xl/worksheets/sheet1.xml").contains("ref=\"G8:G14\""));
    }

    #[test]
    fn creates_formula_in_blank_row_tail_and_exports_native_formula() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("formulas.xlsx");
        let bundle_path = temp.path().join("formulas.hcd");
        let exported = temp.path().join("created.xlsx");
        create_formula_edit_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("formula-create-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_21.to_string(),
            document_id: "formula-create-doc".to_string(),
            patch_id: "create-e1".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxFormulaCreate {
                sheet_id: sheet_id.clone(),
                row: 1,
                column: 5,
                formula: "=IF(A1>0,\"yes\",\"no\")".to_string(),
            }],
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let latest = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&latest, 0).unwrap().chunks[0];
        let html = bundle.read_chunk(descriptor).unwrap();
        assert!(
            html.contains("data-hcd-cell=\"E1\" data-hcd-column=\"5\" data-hcd-formula=\"true\"")
        );
        assert!(html.contains(
            "data-hcd-formula-expression=\"=IF(A1&gt;0,&quot;yes&quot;,&quot;no&quot;)\""
        ));
        let node = bundle
            .read_map(descriptor)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("E1"))
            .unwrap();
        assert!(node.source.created_in_hcd);
        assert!(!node.source.editable);
        assert!(hcd_core::apply_patch(
            &bundle,
            &PatchBatch {
                patch_id: "duplicate-e1".to_string(),
                base_revision: 1,
                ..patch.clone()
            },
            1
        )
        .is_err());
        let edit = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_20.to_string(),
            patch_id: "edit-e1".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxFormulaSet {
                node_id: node.node_id,
                sheet_id,
                formula: "=A1*B1".to_string(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
            ..patch
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &edit, 1).unwrap().revision,
            2
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("<c r=\"E1\"><f>A1*B1</f><v/></c>"));
        assert!(read_zip_entry(&exported, "xl/workbook.xml").contains("fullCalcOnLoad=\"1\""));
        let original = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &original,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(!read_zip_entry(&original, "xl/worksheets/sheet1.xml").contains("r=\"E1\""));

        let latest = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&latest, 0).unwrap().chunks[0];
        let created = bundle
            .read_map(descriptor)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("E1"))
            .unwrap();
        let convert = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_28.to_string(),
            document_id: "formula-create-doc".to_string(),
            patch_id: "convert-e1".to_string(),
            base_revision: 2,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxFormulaToValue {
                node_id: created.node_id,
                sheet_id: descriptor.grid.as_ref().unwrap().sheet_id.clone(),
                text: "Reviewed".to_string(),
                precondition: NodePrecondition {
                    node_hash: created.node_hash,
                },
            }],
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &convert, 2)
                .unwrap()
                .revision,
            3
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let literal = temp.path().join("literal.xlsx");
        export_xlsx(&bundle, &source, &literal, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&literal, "xl/worksheets/sheet1.xml")
            .contains("<c r=\"E1\" t=\"inlineStr\"><is><t>Reviewed</t></is></c>"));
        let prior = temp.path().join("prior-formula.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &prior,
            &ExportOptions {
                revision: Some(2),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&prior, "xl/worksheets/sheet1.xml")
            .contains("<c r=\"E1\"><f>A1*B1</f><v/></c>"));
    }

    #[test]
    fn pastes_mixed_formula_range_atomically_and_preserves_history() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../assets/showcase/product-catalog.xlsx");
        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("product.hcd");
        let exported = temp.path().join("range.xlsx");
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("formula-range-product"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = bundle
            .read_index_page(&manifest, 0)
            .unwrap()
            .chunks
            .into_iter()
            .find(|chunk| {
                chunk.grid.as_ref().is_some_and(|grid| {
                    grid.sheet_name == "Laptops" && grid.kind == GridChunkKind::Cells
                })
            })
            .unwrap();
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let map = bundle.read_map(&descriptor).unwrap();
        let cell = |reference: &str| {
            map.entries
                .iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some(reference))
                .unwrap()
        };
        let name = cell("B4");
        let price = cell("E4");
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_22.to_string(),
            document_id: "formula-range-product".to_string(),
            patch_id: "paste-formulas".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![
                PatchOperation::TextSplice {
                    node_id: name.node_id.clone(),
                    start: 0,
                    delete_count: "Pro 14 Base".chars().count(),
                    insert_text: "Pro 14 Edited".to_string(),
                    precondition: NodePrecondition {
                        node_hash: name.node_hash.clone(),
                    },
                },
                PatchOperation::XlsxFormulaSet {
                    node_id: price.node_id.clone(),
                    sheet_id: sheet_id.clone(),
                    formula: "=D4*0.8".to_string(),
                    precondition: NodePrecondition {
                        node_hash: price.node_hash.clone(),
                    },
                },
                PatchOperation::XlsxFormulaCreate {
                    sheet_id: sheet_id.clone(),
                    row: 4,
                    column: 8,
                    formula: "=D4*2".to_string(),
                },
                PatchOperation::XlsxFormulaCreate {
                    sheet_id: sheet_id.clone(),
                    row: 4,
                    column: 9,
                    formula: "=H4+1".to_string(),
                },
            ],
        };
        let duplicate = PatchBatch {
            patch_id: "duplicate-formula".to_string(),
            operations: vec![patch.operations[1].clone(), patch.operations[1].clone()],
            ..patch.clone()
        };
        assert!(hcd_core::apply_patch(&bundle, &duplicate, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let bad_hash = PatchBatch {
            patch_id: "wrong-hash".to_string(),
            operations: vec![
                PatchOperation::XlsxFormulaSet {
                    node_id: price.node_id.clone(),
                    sheet_id: sheet_id.clone(),
                    formula: "=D4*0.7".to_string(),
                    precondition: NodePrecondition {
                        node_hash: "0".repeat(64),
                    },
                },
                patch.operations[2].clone(),
            ],
            ..patch.clone()
        };
        assert!(hcd_core::apply_patch(&bundle, &bad_hash, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let latest = bundle.manifest().unwrap();
        let latest_descriptor = bundle
            .read_index_page(&latest, 0)
            .unwrap()
            .chunks
            .into_iter()
            .find(|chunk| {
                chunk.grid.as_ref().is_some_and(|grid| {
                    grid.sheet_name == "Laptops" && grid.kind == GridChunkKind::Cells
                })
            })
            .unwrap();
        let html = bundle.read_chunk(&latest_descriptor).unwrap();
        assert!(html.contains("data-hcd-formula-expression=\"=D4*0.8\""));
        assert!(html.contains("data-hcd-formula-expression=\"=D4*2\""));
        assert!(html.contains("data-hcd-formula-expression=\"=H4+1\""));
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("Pro 14 Edited"));
        assert!(xml.contains("<x:f>D4*0.8</x:f><x:v/>"));
        assert!(xml.contains("<x:f>D4*2</x:f><x:v/>"));
        assert!(xml.contains("<x:f>H4+1</x:f><x:v/>"));
        let history = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &history,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        let old_xml = read_zip_entry(&history, "xl/worksheets/sheet1.xml");
        assert!(old_xml.contains("Pro 14 Base"));
        assert!(old_xml.contains("D4*0.85"));
        assert!(!old_xml.contains("r=\"H4\""));
        assert!(hcd_core::apply_patch(
            &bundle,
            &PatchBatch {
                patch_id: "stale-range".to_string(),
                ..patch
            },
            1
        )
        .is_err());
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
    fn merges_blank_anchor_and_unmerges_with_source_backed_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("blank-merge.hcd");
        let merged_export = temp.path().join("merged.xlsx");
        let edited_export = temp.path().join("edited.xlsx");
        let split_export = temp.path().join("split.xlsx");
        create_plain_rows_fixture(&source, 4);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("blank-merge-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let first = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = first.grid.as_ref().unwrap().sheet_id.clone();
        let merge = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_26.to_string(),
            document_id: "blank-merge-doc".to_string(),
            patch_id: "merge-empty-b2-c3".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxMergeBlank {
                sheet_id: sheet_id.clone(),
                start_row: 2,
                start_column: 2,
                end_row: 3,
                end_column: 3,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &merge, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let head = bundle.manifest().unwrap();
        let merged = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        assert!(bundle
            .read_chunk(merged)
            .unwrap()
            .contains("data-hcd-merge=\"B2:C3\""));
        let anchor = bundle
            .read_map(merged)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("B2"))
            .unwrap();
        assert!(anchor.source.created_in_hcd);
        export_xlsx(&bundle, &source, &merged_export, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&merged_export, "xl/worksheets/sheet1.xml")
            .contains("mergeCell ref=\"B2:C3\""));

        let fill = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.to_string(),
            patch_id: "fill-blank-anchor".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::TextSplice {
                node_id: anchor.node_id.clone(),
                start: 0,
                delete_count: 0,
                insert_text: "Merged note".to_string(),
                precondition: hcd_core::NodePrecondition {
                    node_hash: anchor.node_hash,
                },
            }],
            ..merge.clone()
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &fill, 1).unwrap().revision,
            2
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &edited_export, &ExportOptions::default()).unwrap();
        let edited_xml = read_zip_entry(&edited_export, "xl/worksheets/sheet1.xml");
        assert!(edited_xml.contains("<c r=\"B2\""));
        assert!(edited_xml.contains("<t>Merged note</t>"));
        let head = bundle.manifest().unwrap();
        let edited = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        let edited_anchor = bundle
            .read_map(edited)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("B2"))
            .unwrap();

        let unmerge = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_11.to_string(),
            patch_id: "split-empty-b2-c3".to_string(),
            base_revision: 2,
            operations: vec![PatchOperation::XlsxUnmerge {
                node_id: edited_anchor.node_id,
                sheet_id,
                start_row: 2,
                start_column: 2,
                end_row: 3,
                end_column: 3,
                precondition: hcd_core::NodePrecondition {
                    node_hash: edited_anchor.node_hash,
                },
            }],
            ..merge
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &unmerge, 2)
                .unwrap()
                .revision,
            3
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &split_export, &ExportOptions::default()).unwrap();
        assert!(!read_zip_entry(&split_export, "xl/worksheets/sheet1.xml")
            .contains("mergeCell ref=\"B2:C3\""));
    }

    #[test]
    fn merges_sparse_blank_cells_beyond_the_rendered_row_tail() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("sparse-merge.hcd");
        let exported = temp.path().join("exported.xlsx");
        create_plain_rows_fixture(&source, 4);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("sparse-merge-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let first = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = first.grid.as_ref().unwrap().sheet_id.clone();
        assert!(!bundle
            .read_chunk(first)
            .unwrap()
            .contains("data-hcd-column=\"5\""));
        let merge = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_26.to_string(),
            document_id: "sparse-merge-doc".to_string(),
            patch_id: "merge-sparse-e2-f3".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxMergeBlank {
                sheet_id,
                start_row: 2,
                start_column: 5,
                end_row: 3,
                end_column: 6,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &merge, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let head = bundle.manifest().unwrap();
        let chunk = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        assert!(bundle
            .read_chunk(chunk)
            .unwrap()
            .contains("data-hcd-merge=\"E2:F3\""));
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&exported, "xl/worksheets/sheet1.xml")
            .contains("mergeCell ref=\"E2:F3\""));
    }

    #[test]
    fn blank_merge_rejects_nonempty_and_overlapping_cells_without_advancing_head() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("blank-merge.hcd");
        create_plain_rows_fixture(&source, 4);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("blank-merge-guard"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let merge = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_26.to_string(),
            document_id: "blank-merge-guard".to_string(),
            patch_id: "blank-merge-b2-c3".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxMergeBlank {
                sheet_id,
                start_row: 2,
                start_column: 2,
                end_row: 3,
                end_column: 3,
            }],
            metadata: BTreeMap::new(),
        };
        let mut destructive = merge.clone();
        destructive.patch_id = "blank-merge-b2-d2".to_string();
        if let PatchOperation::XlsxMergeBlank {
            end_row,
            end_column,
            ..
        } = &mut destructive.operations[0]
        {
            *end_row = 2;
            *end_column = 4;
        }
        assert!(hcd_core::apply_patch(&bundle, &destructive, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &merge, 0).unwrap().revision,
            1
        );
        let mut overlapping = merge;
        overlapping.patch_id = "blank-merge-overlap".to_string();
        overlapping.base_revision = 1;
        assert!(hcd_core::apply_patch(&bundle, &overlapping, 1).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 1);
        assert!(validate_bundle(&bundle).unwrap().valid);
    }

    #[test]
    fn merges_empty_xlsx_cells_in_hcd_and_source_backed_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("merge.xlsx");
        let bundle_path = temp.path().join("merge.hcd");
        let exported = temp.path().join("merged.xlsx");
        create_merge_edit_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("merge-edit-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let anchor = extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A1"))
            .unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_6.to_string(),
            document_id: "merge-edit-doc".to_string(),
            patch_id: "merge-a1-b2".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxMerge {
                node_id: anchor.node_id,
                sheet_id,
                start_row: 1,
                start_column: 1,
                end_row: 2,
                end_column: 2,
                precondition: NodePrecondition {
                    node_hash: anchor.node_hash,
                },
            }],
            metadata: BTreeMap::new(),
        };
        let mut destructive = patch.clone();
        destructive.patch_id = "merge-a1-d1".to_string();
        if let PatchOperation::XlsxMerge {
            end_row,
            end_column,
            ..
        } = &mut destructive.operations[0]
        {
            *end_row = 1;
            *end_column = 4;
        }
        assert!(hcd_core::apply_patch(&bundle, &destructive, 0)
            .unwrap_err()
            .to_string()
            .contains("would discard"));
        assert_eq!(bundle.manifest().unwrap().revision, 0);
        let result = hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert_eq!(result.revision, 1);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 1).unwrap().revision,
            1
        );
        assert_eq!(bundle.revision(0).unwrap().revision, 0);
        let mut overlapping = patch.clone();
        overlapping.patch_id = "merge-a1-c1".to_string();
        overlapping.base_revision = 1;
        if let PatchOperation::XlsxMerge {
            end_row,
            end_column,
            ..
        } = &mut overlapping.operations[0]
        {
            *end_row = 1;
            *end_column = 3;
        }
        assert!(hcd_core::apply_patch(&bundle, &overlapping, 1)
            .unwrap_err()
            .to_string()
            .contains("overlaps"));
        let head = bundle.manifest().unwrap();
        let page = bundle.read_index_page(&head, 0).unwrap();
        let html = bundle.read_chunk(&page.chunks[0]).unwrap();
        assert!(html.contains("data-hcd-merge=\"A1:B2\""));
        assert!(html.contains("rowspan=\"2\" colspan=\"2\""));
        assert!(!html.contains("data-hcd-column=\"2\""));
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("mergeCell ref=\"A1:B2\""));
        assert!(worksheet.contains("Anchor"));
        assert!(worksheet.contains("Other"));
    }

    #[test]
    fn unmerges_hcd_created_cells_and_exports_without_merge() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("bundle.hcd");
        let merged_export = temp.path().join("merged.xlsx");
        let split_export = temp.path().join("split.xlsx");
        create_merge_edit_fixture(&source);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("unmerge-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let anchor = extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A1"))
            .unwrap();
        let sheet_id = bundle.read_index_page(&imported, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let merge = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION_6.to_string(),
            document_id: "unmerge-doc".to_string(),
            patch_id: "merge-a1-b2".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxMerge {
                node_id: anchor.node_id.clone(),
                sheet_id: sheet_id.clone(),
                start_row: 1,
                start_column: 1,
                end_row: 2,
                end_column: 2,
                precondition: NodePrecondition {
                    node_hash: anchor.node_hash.clone(),
                },
            }],
        };
        hcd_core::apply_patch(&bundle, &merge, 0).unwrap();
        export_xlsx(&bundle, &source, &merged_export, &ExportOptions::default()).unwrap();
        assert!(read_zip_entry(&merged_export, "xl/worksheets/sheet1.xml")
            .contains("mergeCell ref=\"A1:B2\""));
        let split = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_11.to_string(),
            document_id: "unmerge-doc".to_string(),
            patch_id: "split-a1-b2".to_string(),
            base_revision: 1,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxUnmerge {
                node_id: anchor.node_id.clone(),
                sheet_id,
                start_row: 1,
                start_column: 1,
                end_row: 2,
                end_column: 2,
                precondition: NodePrecondition {
                    node_hash: anchor.node_hash,
                },
            }],
        };
        let mut stale = split.clone();
        stale.patch_id = "stale-split-a1-b2".to_string();
        stale.base_revision = 0;
        assert!(hcd_core::apply_patch(&bundle, &stale, 1)
            .unwrap_err()
            .to_string()
            .contains("current head revision"));
        let result = hcd_core::apply_patch(&bundle, &split, 1).unwrap();
        assert_eq!(result.revision, 2);
        let head = bundle.manifest().unwrap();
        let html = bundle
            .read_chunk(&bundle.read_index_page(&head, 0).unwrap().chunks[0])
            .unwrap();
        assert!(!html.contains("data-hcd-merge=\"A1:B2\""));
        assert_eq!(html.matches("data-hcd-column=\"2\"").count(), 2);
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        export_xlsx(&bundle, &source, &split_export, &ExportOptions::default()).unwrap();
        let worksheet = read_zip_entry(&split_export, "xl/worksheets/sheet1.xml");
        assert!(!worksheet.contains("mergeCell ref=\"A1:B2\""));
        assert!(worksheet.contains("Anchor"));
        assert_eq!(bundle.revision(1).unwrap().revision, 1);
    }

    #[test]
    fn splits_source_merge_and_exports_preserving_other_merges_and_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("original-merge.xlsx");
        let bundle_path = temp.path().join("original-merge.hcd");
        let exported = temp.path().join("split-source.xlsx");
        create_shared_string_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("original-merge-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let anchor = extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A1"))
            .unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let split = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_11.to_string(),
            document_id: "original-merge-doc".to_string(),
            patch_id: "split-source".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxUnmerge {
                node_id: anchor.node_id,
                sheet_id,
                start_row: 1,
                start_column: 1,
                end_row: 2,
                end_column: 2,
                precondition: NodePrecondition {
                    node_hash: anchor.node_hash,
                },
            }],
        };
        let result = hcd_core::apply_patch(&bundle, &split, 0).unwrap();
        assert_eq!(result.revision, 1);
        assert!(result.dirty_node_ids.is_empty());
        let old_html = bundle
            .read_chunk(&bundle.read_index_page(&manifest, 0).unwrap().chunks[0])
            .unwrap();
        assert!(old_html.contains("data-hcd-merge=\"A1:B2\""));
        let head = bundle.manifest().unwrap();
        let new_html = bundle
            .read_chunk(&bundle.read_index_page(&head, 0).unwrap().chunks[0])
            .unwrap();
        assert!(!new_html.contains("data-hcd-merge=\"A1:B2\""));
        assert!(new_html.contains("data-hcd-merge=\"D4:E5\""));
        assert!(new_html.contains("data-hcd-column=\"2\""));
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!worksheet.contains("mergeCell ref=\"A1:B2\""));
        assert!(worksheet.contains("mergeCell ref=\"D4:E5\""));
        assert!(worksheet.contains("<c r=\"A1\" t=\"s\" s=\"1\"><v>0</v></c>"));
        assert!(worksheet.contains("<c r=\"B1\" s=\"2\"/>"));
    }

    #[test]
    fn first_edit_of_sparse_cell_creates_stable_node_and_source_cell() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sparse.xlsx");
        let bundle_path = temp.path().join("sparse.hcd");
        let exported = temp.path().join("edited.xlsx");
        create_merge_edit_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("sparse-cell-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_7.to_string(),
            document_id: "sparse-cell-doc".to_string(),
            patch_id: "add-b1".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id: sheet_id.clone(),
                row: 1,
                column: 2,
                text: "Added & safe".to_string(),
            }],
            metadata: BTreeMap::new(),
        };
        let mut occupied = patch.clone();
        occupied.patch_id = "overwrite-d1".to_string();
        if let PatchOperation::XlsxCellSet { column, .. } = &mut occupied.operations[0] {
            *column = 4;
        }
        assert!(hcd_core::apply_patch(&bundle, &occupied, 0).is_err());
        let result = hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert_eq!(result.revision, 1);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 1).unwrap().revision,
            1
        );
        let mut stale = patch.clone();
        stale.patch_id = "add-c1-stale".to_string();
        if let PatchOperation::XlsxCellSet { column, .. } = &mut stale.operations[0] {
            *column = 3;
        }
        assert!(hcd_core::apply_patch(&bundle, &stale, 1)
            .unwrap_err()
            .to_string()
            .contains("current head"));
        let inserted = extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("B1"))
            .unwrap();
        assert_eq!(inserted.text, "Added & safe");
        assert_eq!(result.dirty_node_ids, vec![inserted.node_id.clone()]);
        assert!(validate_bundle(&bundle).unwrap().valid);
        let historical =
            hcd_core::manifest_at_revision(&bundle, &bundle.manifest().unwrap(), Some(0))
                .unwrap()
                .0;
        let old_html = bundle
            .read_chunk(&bundle.read_index_page(&historical, 0).unwrap().chunks[0])
            .unwrap();
        assert!(!old_html.contains(&inserted.node_id));
        let update = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.to_string(),
            patch_id: "edit-b1".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::TextSplice {
                node_id: inserted.node_id.clone(),
                start: 0,
                delete_count: inserted.text.chars().count(),
                insert_text: "Updated".to_string(),
                precondition: NodePrecondition {
                    node_hash: inserted.node_hash,
                },
            }],
            ..patch.clone()
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &update, 1).unwrap().revision,
            2
        );
        let tail = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_7.to_string(),
            patch_id: "add-g1-tail".to_string(),
            base_revision: 2,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id,
                row: 1,
                column: 7,
                text: "Tail".to_string(),
            }],
            ..patch
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &tail, 2).unwrap().revision,
            3
        );
        let head = bundle.manifest().unwrap();
        let html = bundle
            .read_chunk(&bundle.read_index_page(&head, 0).unwrap().chunks[0])
            .unwrap();
        assert!(html.contains("data-hcd-column=\"5\"></td>"));
        assert!(html.contains("data-hcd-column=\"6\"></td>"));
        assert!(html.contains("data-hcd-cell=\"G1\""));
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let worksheet = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains("r=\"B1\" t=\"inlineStr\""));
        assert!(worksheet.contains("<t>Updated</t>"));
        assert!(worksheet.contains("r=\"G1\" t=\"inlineStr\""));
        assert!(worksheet.contains("<t>Tail</t>"));
        assert!(worksheet.contains("Other"));
    }

    #[test]
    fn range_paste_creates_cells_across_windows_and_edits_existing_cell_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("rows.xlsx");
        let bundle_path = temp.path().join("rows.hcd");
        let exported = temp.path().join("pasted.xlsx");
        create_plain_rows_fixture(&source, 130);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("range-paste-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        assert!(page.chunks.len() >= 2);
        let sheet_id = page.chunks[0].grid.as_ref().unwrap().sheet_id.clone();
        let existing = extract_text_page(&bundle, None, 10)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A2"))
            .unwrap();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_19.to_string(),
            document_id: "range-paste-doc".to_string(),
            patch_id: "paste-three-blanks-and-edit".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            metadata: BTreeMap::new(),
            operations: vec![
                PatchOperation::XlsxCellSet {
                    sheet_id: sheet_id.clone(),
                    row: 1,
                    column: 2,
                    text: "B1".to_string(),
                },
                PatchOperation::XlsxCellSet {
                    sheet_id: sheet_id.clone(),
                    row: 129,
                    column: 2,
                    text: "B129".to_string(),
                },
                PatchOperation::XlsxCellSet {
                    sheet_id: sheet_id.clone(),
                    row: 130,
                    column: 3,
                    text: "C130".to_string(),
                },
                PatchOperation::TextSplice {
                    node_id: existing.node_id.clone(),
                    start: 0,
                    delete_count: existing.text.chars().count(),
                    insert_text: "Changed".to_string(),
                    precondition: NodePrecondition {
                        node_hash: existing.node_hash.clone(),
                    },
                },
            ],
        };
        let mut duplicate = patch.clone();
        duplicate.patch_id = "duplicate-target".to_string();
        duplicate.operations.push(duplicate.operations[0].clone());
        assert!(hcd_core::apply_patch(&bundle, &duplicate, 0)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
        let mut occupied = patch.clone();
        occupied.patch_id = "occupied-target".to_string();
        if let PatchOperation::XlsxCellSet { column, .. } = &mut occupied.operations[0] {
            *column = 1;
        }
        assert!(hcd_core::apply_patch(&bundle, &occupied, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);

        let result = hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert_eq!(result.revision, 1);
        assert_eq!(result.dirty_node_ids.len(), 4);
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 1).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        assert_eq!(bundle.revision(0).unwrap().revision, 0);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        for (cell, text) in [("B1", "B1"), ("B129", "B129"), ("C130", "C130")] {
            assert!(
                xml.contains(&format!("<c r=\"{cell}\" t=\"inlineStr\">")),
                "{cell}: {xml}"
            );
            assert!(xml.contains(&format!("<t>{text}</t>")), "{cell}: {xml}");
        }
        assert!(xml.contains("<t>Changed</t>"));
        let mut stale = patch.clone();
        stale.patch_id = "stale-paste".to_string();
        assert!(hcd_core::apply_patch(&bundle, &stale, 1)
            .unwrap_err()
            .to_string()
            .contains("current head"));
    }

    #[test]
    fn appended_xlsx_row_is_editable_and_survives_source_backed_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("rows.xlsx");
        let bundle_path = temp.path().join("rows.hcd");
        let empty_export = temp.path().join("empty-row.xlsx");
        let filled_export = temp.path().join("filled-row.xlsx");
        create_merge_edit_fixture(&source);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("row-append-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&imported, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let append = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_8.to_string(),
            document_id: "row-append-doc".to_string(),
            patch_id: "append-row-3".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowAppend {
                sheet_id: sheet_id.clone(),
                after_row: 2,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &append, 0).unwrap().revision,
            1
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &append, 1).unwrap().revision,
            1
        );
        let mut stale = append.clone();
        stale.patch_id = "stale-row".to_string();
        assert!(hcd_core::apply_patch(&bundle, &stale, 1).is_err());
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let revision = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&revision, 0).unwrap().chunks[0];
        assert_eq!(descriptor.grid.as_ref().unwrap().row_end, Some(3));
        assert!(bundle
            .read_chunk(descriptor)
            .unwrap()
            .contains("<tr data-hcd-row=\"3\"></tr>"));
        let historical = hcd_core::manifest_at_revision(&bundle, &revision, Some(0))
            .unwrap()
            .0;
        assert_eq!(
            bundle.read_index_page(&historical, 0).unwrap().chunks[0]
                .grid
                .as_ref()
                .unwrap()
                .row_end,
            Some(2)
        );
        export_xlsx(&bundle, &source, &empty_export, &ExportOptions::default()).unwrap();
        assert!(
            read_zip_entry(&empty_export, "xl/worksheets/sheet1.xml").contains("<row r=\"3\"/>")
        );

        let fill_sheet_id = sheet_id.clone();
        let fill = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_8.to_string(),
            patch_id: "fill-new-row".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id,
                row: 3,
                column: 1,
                text: "New row".to_string(),
            }],
            ..append
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &fill, 1).unwrap().revision,
            2
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &filled_export, &ExportOptions::default()).unwrap();
        let worksheet = read_zip_entry(&filled_export, "xl/worksheets/sheet1.xml");
        assert!(worksheet.contains(
            "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>New row</t></is></c></row>"
        ));
        assert!(worksheet.contains("<dimension ref=\"A1:D3\"/>"));
        assert!(worksheet.contains("<t>Below</t>"));

        let historical_export = temp.path().join("historical-row.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &historical_export,
            &ExportOptions {
                revision: Some(1),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        let historical_sheet = read_zip_entry(&historical_export, "xl/worksheets/sheet1.xml");
        assert!(historical_sheet.contains("<row r=\"3\"/>"));
        assert!(historical_sheet.contains("<dimension ref=\"A1:D3\"/>"));
        assert!(!historical_sheet.contains("New row"));

        let wide_cell = PatchBatch {
            patch_id: "fill-new-row-wide-cell".to_string(),
            base_revision: 2,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id: fill_sheet_id,
                row: 3,
                column: 5,
                text: "Wide cell".to_string(),
            }],
            ..fill
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &wide_cell, 2)
                .unwrap()
                .revision,
            3
        );
        let wide_export = temp.path().join("wide-row.xlsx");
        export_xlsx(&bundle, &source, &wide_export, &ExportOptions::default()).unwrap();
        let wide_sheet = read_zip_entry(&wide_export, "xl/worksheets/sheet1.xml");
        assert!(wide_sheet.contains("<dimension ref=\"A1:E3\"/>"));
        assert!(wide_sheet.contains("<c r=\"E3\" t=\"inlineStr\"><is><t>Wide cell</t></is></c>"));
    }

    #[test]
    fn selected_grid_ranges_commit_once_and_export_all_four_shifts() {
        use hcd_core::{XlsxGridAction, XlsxGridAxis};

        let cases = [
            (XlsxGridAxis::Row, XlsxGridAction::Insert, 2, "A4", "Row 2"),
            (XlsxGridAxis::Row, XlsxGridAction::Delete, 2, "A2", "Row 4"),
            (
                XlsxGridAxis::Column,
                XlsxGridAction::Insert,
                2,
                "F2",
                "Right 2",
            ),
            (
                XlsxGridAxis::Column,
                XlsxGridAction::Delete,
                2,
                "B2",
                "Right 2",
            ),
        ];
        for (axis, action, start, expected_cell, expected_text) in cases {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source.xlsx");
            let bundle_path = temp.path().join("range.hcd");
            let exported = temp.path().join("export.xlsx");
            let historical = temp.path().join("historical.xlsx");
            create_plain_rows_fixture(&source, 6);
            let manifest = import_xlsx(
                &source,
                &bundle_path,
                &ImportOptions::new("range-doc"),
                |_| Ok(()),
            )
            .unwrap();
            let bundle = Bundle::open(&bundle_path).unwrap();
            let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
            let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
            let original_node = bundle
                .read_map(descriptor)
                .unwrap()
                .entries
                .into_iter()
                .find(|entry| entry.source.paragraph_id.as_deref() == Some("A4"))
                .unwrap()
                .node_id;
            let patch = PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_25.to_string(),
                document_id: "range-doc".to_string(),
                patch_id: format!("range-{axis:?}-{action:?}"),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::XlsxGridRange {
                    sheet_id,
                    axis,
                    action,
                    start,
                    count: 2,
                }],
                metadata: BTreeMap::new(),
            };
            assert_eq!(
                hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
                1
            );
            assert!(validate_bundle(&bundle).unwrap().valid);
            let record = bundle.revision(1).unwrap();
            let recorded = match (axis, action) {
                (XlsxGridAxis::Row, XlsxGridAction::Insert) => record.grid_row_insertions.len(),
                (XlsxGridAxis::Row, XlsxGridAction::Delete) => record.grid_row_deletions.len(),
                (XlsxGridAxis::Column, XlsxGridAction::Insert) => {
                    record.grid_column_insertions.len()
                }
                (XlsxGridAxis::Column, XlsxGridAction::Delete) => {
                    record.grid_column_deletions.len()
                }
            };
            assert_eq!(recorded, 2);
            let head = bundle.manifest().unwrap();
            let new_descriptor = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
            let current_ids: Vec<_> = bundle
                .read_map(new_descriptor)
                .unwrap()
                .entries
                .into_iter()
                .map(|entry| entry.node_id)
                .collect();
            if action == XlsxGridAction::Insert || axis == XlsxGridAxis::Column {
                assert!(current_ids.contains(&original_node));
            }
            export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
            let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
            assert!(xml.contains(&format!("<c r=\"{expected_cell}\"")), "{xml}");
            assert!(xml.contains(&format!("<t>{expected_text}</t>")), "{xml}");
            export_xlsx(
                &bundle,
                &source,
                &historical,
                &ExportOptions {
                    revision: Some(0),
                    ..ExportOptions::default()
                },
            )
            .unwrap();
            assert_eq!(
                read_zip_entry(&historical, "xl/worksheets/sheet1.xml"),
                read_zip_entry(&source, "xl/worksheets/sheet1.xml")
            );
        }
    }

    #[test]
    fn selected_row_range_crosses_chunk_boundary() {
        use hcd_core::{XlsxGridAction, XlsxGridAxis};

        for action in [XlsxGridAction::Insert, XlsxGridAction::Delete] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source.xlsx");
            let bundle_path = temp.path().join("range.hcd");
            let exported = temp.path().join("export.xlsx");
            create_plain_rows_fixture(&source, 130);
            let manifest = import_xlsx(
                &source,
                &bundle_path,
                &ImportOptions::new("range-boundary"),
                |_| Ok(()),
            )
            .unwrap();
            let bundle = Bundle::open(&bundle_path).unwrap();
            let page = bundle.read_index_page(&manifest, 0).unwrap();
            assert!(page.chunks.len() > 1);
            let first = &page.chunks[0];
            let boundary = first.grid.as_ref().unwrap().row_end.unwrap() as u32;
            let sheet_id = first.grid.as_ref().unwrap().sheet_id.clone();
            let patch = PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_25.to_string(),
                document_id: "range-boundary".to_string(),
                patch_id: format!("boundary-{action:?}"),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::XlsxGridRange {
                    sheet_id,
                    axis: XlsxGridAxis::Row,
                    action,
                    start: boundary,
                    count: 2,
                }],
                metadata: BTreeMap::new(),
            };
            assert_eq!(
                hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
                1
            );
            assert!(validate_bundle(&bundle).unwrap().valid);
            export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
            let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
            let expected = match action {
                XlsxGridAction::Insert => {
                    format!("<row r=\"{}\"><c r=\"A{}\"", boundary + 2, boundary + 2)
                }
                XlsxGridAction::Delete => format!("<row r=\"{boundary}\"><c r=\"A{boundary}\""),
            };
            assert!(xml.contains(&expected), "{xml}");
        }
    }

    #[test]
    fn selected_grid_range_rejection_preserves_head() {
        use hcd_core::{XlsxGridAction, XlsxGridAxis};

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("range.hcd");
        create_grid_shift_merge_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("range-reject"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        for (start, count) in [(2, 101), (3, 2)] {
            let patch = PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_25.to_string(),
                document_id: "range-reject".to_string(),
                patch_id: format!("range-reject-{start}-{count}"),
                base_revision: 0,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::XlsxGridRange {
                    sheet_id: sheet_id.clone(),
                    axis: XlsxGridAxis::Row,
                    action: XlsxGridAction::Delete,
                    start,
                    count,
                }],
                metadata: BTreeMap::new(),
            };
            assert!(hcd_core::apply_patch(&bundle, &patch, 0).is_err());
            assert_eq!(bundle.manifest().unwrap().revision, 0);
            assert!(validate_bundle(&bundle).unwrap().valid);
        }
    }

    #[test]
    fn selected_row_delete_removes_annotations_for_deleted_cells() {
        use hcd_core::{Annotation, XlsxGridAction, XlsxGridAxis};

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("range.hcd");
        create_plain_rows_fixture(&source, 5);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("range-annotation"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let node_id = bundle
            .read_map(descriptor)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A2"))
            .unwrap()
            .node_id;
        let annotate = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: "range-annotation".to_string(),
            patch_id: "annotate-row".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::AnnotationUpsert {
                annotation: Annotation {
                    annotation_id: "row-note".to_string(),
                    node_id: node_id.clone(),
                    start: 0,
                    end: 3,
                    kind: "review".to_string(),
                    rule_id: None,
                    confidence: None,
                    ignored: false,
                },
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &annotate, 0)
                .unwrap()
                .revision,
            1
        );
        let delete = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_25.to_string(),
            patch_id: "delete-annotated-rows".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxGridRange {
                sheet_id,
                axis: XlsxGridAxis::Row,
                action: XlsxGridAction::Delete,
                start: 2,
                count: 2,
            }],
            ..annotate
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &delete, 1).unwrap().revision,
            2
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let record = bundle.revision(2).unwrap();
        assert!(record.removed_node_ids.contains(&node_id));
        assert!(record.dirty_node_ids.contains(&node_id));
    }

    #[test]
    fn selected_grid_range_can_delete_every_materialized_row() {
        use hcd_core::{XlsxGridAction, XlsxGridAxis};

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("range.hcd");
        let exported = temp.path().join("empty.xlsx");
        create_plain_rows_fixture(&source, 2);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("range-empty"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&manifest, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_25.to_string(),
            document_id: "range-empty".to_string(),
            patch_id: "delete-both-rows".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxGridRange {
                sheet_id,
                axis: XlsxGridAxis::Row,
                action: XlsxGridAction::Delete,
                start: 1,
                count: 2,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("<row r="), "{xml}");
    }

    #[test]
    fn middle_row_insertion_preserves_node_ids_history_and_exported_addresses() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("rows.hcd");
        let exported = temp.path().join("edited.xlsx");
        let original_export = temp.path().join("original.xlsx");
        create_merge_edit_fixture(&source);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("middle-row-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let initial = &bundle.read_index_page(&imported, 0).unwrap().chunks[0];
        let sheet_id = initial.grid.as_ref().unwrap().sheet_id.clone();
        let original_d2 = bundle
            .read_map(initial)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("D2"))
            .unwrap();
        let insert = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_12.to_string(),
            document_id: "middle-row-doc".to_string(),
            patch_id: "insert-row-2".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id: sheet_id.clone(),
                before_row: 2,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &insert, 0).unwrap().revision,
            1
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &insert, 1).unwrap().revision,
            1
        );
        let mut stale = insert.clone();
        stale.patch_id = "stale-insert".to_string();
        assert!(hcd_core::apply_patch(&bundle, &stale, 1).is_err());
        let head = bundle.manifest().unwrap();
        let shifted = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        let shifted_map = bundle.read_map(shifted).unwrap();
        let d3 = shifted_map
            .entries
            .iter()
            .find(|entry| entry.node_id == original_d2.node_id)
            .unwrap();
        assert_eq!(d3.source.paragraph_id.as_deref(), Some("D3"));
        assert_eq!(d3.source.source_cell_ref.as_deref(), Some("D2"));
        let html = bundle.read_chunk(shifted).unwrap();
        assert!(html.contains("<tr data-hcd-row=\"2\"></tr>"));
        assert!(html.contains("data-hcd-cell=\"D3\""));
        assert!(validate_bundle(&bundle).unwrap().valid);
        let fill = PatchBatch {
            patch_id: "fill-inserted-row".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id: sheet_id.clone(),
                row: 2,
                column: 1,
                text: "Inserted".to_string(),
            }],
            ..insert.clone()
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &fill, 1).unwrap().revision,
            2
        );
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains(
                "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>Inserted</t></is></c></row>"
            ),
            "{xml}"
        );
        assert!(xml.contains("<row r=\"3\"><c r=\"D3\""), "{xml}");
        assert!(xml.contains("<dimension ref=\"A1:D3\"/>"), "{xml}");
        export_xlsx(
            &bundle,
            &source,
            &original_export,
            &ExportOptions {
                revision: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        let historical = read_zip_entry(&original_export, "xl/worksheets/sheet1.xml");
        assert!(historical.contains("<row r=\"2\"><c r=\"D2\""));
        assert!(!historical.contains("Inserted"));

        let second = PatchBatch {
            patch_id: "insert-row-2-again".to_string(),
            base_revision: 2,
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row: 2,
            }],
            ..insert
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &second, 2).unwrap().revision,
            3
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let twice = temp.path().join("twice.xlsx");
        export_xlsx(&bundle, &source, &twice, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&twice, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("<row r=\"2\"/>"), "{xml}");
        assert!(
            xml.contains(
                "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>Inserted</t></is></c></row>"
            ),
            "{xml}"
        );
        assert!(xml.contains("<row r=\"4\"><c r=\"D4\""), "{xml}");
    }

    #[test]
    fn grid_shifts_keep_untouched_merges_in_hcd_and_source_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("merged-source.xlsx");
        create_grid_shift_merge_fixture(&source);
        let bundle_path = temp.path().join("merged-grid.hcd");
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("merged-grid-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let initial = &bundle.read_index_page(&imported, 0).unwrap().chunks[0];
        let sheet_id = initial.grid.as_ref().unwrap().sheet_id.clone();
        let anchor_id = bundle
            .read_map(initial)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("A2"))
            .unwrap()
            .node_id;
        let operations = [
            (
                PatchOperation::XlsxRowInsert {
                    sheet_id: sheet_id.clone(),
                    before_row: 2,
                },
                "A3:B4",
                "A3",
            ),
            (
                PatchOperation::XlsxRowDelete {
                    sheet_id: sheet_id.clone(),
                    row: 1,
                },
                "A2:B3",
                "A2",
            ),
            (
                PatchOperation::XlsxColumnInsert {
                    sheet_id: sheet_id.clone(),
                    before_column: 1,
                },
                "B2:C3",
                "B2",
            ),
            (
                PatchOperation::XlsxColumnDelete {
                    sheet_id: sheet_id.clone(),
                    column: 1,
                },
                "A2:B3",
                "A2",
            ),
        ];
        let schemas = [
            hcd_core::HCD_PATCH_SCHEMA_VERSION_12,
            hcd_core::HCD_PATCH_SCHEMA_VERSION_14,
            hcd_core::HCD_PATCH_SCHEMA_VERSION_13,
            hcd_core::HCD_PATCH_SCHEMA_VERSION_15,
        ];
        let views = [
            ("A1", "A1:B3"),
            ("A1", "A1:B2"),
            ("B1", "B1:C2"),
            ("A1", "A1:B2"),
        ];
        for (index, (operation, expected_merge, expected_anchor)) in
            operations.into_iter().enumerate()
        {
            let revision = index as u64;
            let patch = PatchBatch {
                schema_version: schemas[index].to_string(),
                document_id: "merged-grid-doc".to_string(),
                patch_id: format!("merge-shift-{index}"),
                base_revision: revision,
                actor: BTreeMap::new(),
                operations: vec![operation],
                metadata: BTreeMap::new(),
            };
            assert_eq!(
                hcd_core::apply_patch(&bundle, &patch, revision)
                    .unwrap()
                    .revision,
                revision + 1
            );
            assert!(validate_bundle(&bundle).unwrap().valid);
            let head = bundle.manifest().unwrap();
            let descriptor = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
            assert!(bundle
                .read_chunk(descriptor)
                .unwrap()
                .contains(&format!("data-hcd-merge=\"{expected_merge}\"")));
            let anchor = bundle
                .read_map(descriptor)
                .unwrap()
                .entries
                .into_iter()
                .find(|entry| entry.node_id == anchor_id)
                .unwrap();
            assert_eq!(anchor.source.paragraph_id.as_deref(), Some(expected_anchor));
            let exported = temp.path().join(format!("shift-{index}.xlsx"));
            export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
            let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
            assert!(
                xml.contains(&format!("mergeCell ref=\"{expected_merge}\"")),
                "{xml}"
            );
            let (selected, range) = views[index];
            assert!(
                xml.contains(&format!("topLeftCell=\"{selected}\"")),
                "{xml}"
            );
            assert!(
                xml.contains(&format!("activeCell=\"{selected}\" sqref=\"{range}\"")),
                "{xml}"
            );
        }
        let historical = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&historical, "xl/worksheets/sheet1.xml")
            .contains("mergeCell ref=\"A2:B3\""));

        let crossing = [
            (
                hcd_core::HCD_PATCH_SCHEMA_VERSION_12,
                PatchOperation::XlsxRowInsert {
                    sheet_id: sheet_id.clone(),
                    before_row: 3,
                },
            ),
            (
                hcd_core::HCD_PATCH_SCHEMA_VERSION_14,
                PatchOperation::XlsxRowDelete {
                    sheet_id: sheet_id.clone(),
                    row: 2,
                },
            ),
            (
                hcd_core::HCD_PATCH_SCHEMA_VERSION_13,
                PatchOperation::XlsxColumnInsert {
                    sheet_id: sheet_id.clone(),
                    before_column: 2,
                },
            ),
            (
                hcd_core::HCD_PATCH_SCHEMA_VERSION_15,
                PatchOperation::XlsxColumnDelete {
                    sheet_id,
                    column: 1,
                },
            ),
        ];
        for (index, (schema, operation)) in crossing.into_iter().enumerate() {
            let patch = PatchBatch {
                schema_version: schema.to_string(),
                document_id: "merged-grid-doc".to_string(),
                patch_id: format!("split-merge-{index}"),
                base_revision: 4,
                actor: BTreeMap::new(),
                operations: vec![operation],
                metadata: BTreeMap::new(),
            };
            assert!(matches!(
                hcd_core::apply_patch(&bundle, &patch, 4),
                Err(hcd_core::HcdError::Unsupported(_))
            ));
        }
        assert_eq!(bundle.manifest().unwrap().revision, 4);
    }

    #[test]
    fn grid_view_refs_shift_absolute_and_rectangular_selections() {
        let rows = [RowShift::Insert(2), RowShift::Delete(1)];
        let columns = [ColumnShift::Insert(2)];
        assert_eq!(
            shifted_xlsx_view_reference("$B$2:$C$4 D5", "sqref", &rows, &columns).unwrap(),
            "$C$2:$D$4 E5"
        );
        assert_eq!(
            shifted_xlsx_view_reference("$A$1", "activeCell", &rows, &columns).unwrap(),
            "$A$1"
        );
        assert!(shifted_xlsx_view_reference("A1:B2", "activeCell", &rows, &columns).is_err());
        assert!(shifted_xlsx_view_reference("A:B", "sqref", &rows, &columns).is_err());
        assert!(shifted_xlsx_view_reference(
            "XFD1048576",
            "activeCell",
            &[RowShift::Insert(1)],
            &[]
        )
        .is_err());
    }

    #[test]
    fn middle_row_insertion_shifts_across_chunk_windows() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("long.xlsx");
        let bundle_path = temp.path().join("long.hcd");
        let exported = temp.path().join("shifted.xlsx");
        create_plain_rows_fixture(&source, 130);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("long-row-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let page = bundle.read_index_page(&manifest, 0).unwrap();
        assert!(page.chunks.len() >= 2);
        let sheet_id = page.chunks[0].grid.as_ref().unwrap().sheet_id.clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_12.to_string(),
            document_id: "long-row-doc".to_string(),
            patch_id: "cross-window-insert".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row: 128,
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("<row r=\"128\"/>"));
        assert!(xml.contains("<c r=\"A129\" t=\"inlineStr\"><is><t>Row 128</t>"));
        assert!(xml.contains("<c r=\"A131\" t=\"inlineStr\"><is><t>Row 130</t>"));
    }

    #[test]
    fn middle_row_deletion_shifts_windows_and_preserves_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("long.xlsx");
        let bundle_path = temp.path().join("long.hcd");
        create_plain_rows_fixture(&source, 130);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("delete-row-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_14.to_string(),
            document_id: "delete-row-doc".to_string(),
            patch_id: "delete-middle-row".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowDelete { sheet_id, row: 128 }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(
            hcd_core::apply_patch(&bundle, &patch, 1)
                .unwrap()
                .idempotent_replay
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("deleted.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("Row 128</t>"), "{xml}");
        assert!(
            xml.contains("<c r=\"A128\" t=\"inlineStr\"><is><t>Row 129</t>"),
            "{xml}"
        );
        assert!(
            xml.contains("<c r=\"A129\" t=\"inlineStr\"><is><t>Row 130</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:D129\"/>"), "{xml}");
        let historical = temp.path().join("original.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&historical, "xl/worksheets/sheet1.xml")
            .contains("<c r=\"A128\" t=\"inlineStr\"><is><t>Row 128</t>"));
    }

    #[test]
    fn deleting_only_worksheet_row_keeps_empty_grid_window() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("one.xlsx");
        let bundle_path = temp.path().join("one.hcd");
        create_plain_rows_fixture(&source, 1);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("one-row-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_14.to_string(),
            document_id: "one-row-doc".to_string(),
            patch_id: "delete-only-row".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowDelete { sheet_id, row: 1 }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("empty.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("<row "), "{xml}");
    }

    #[test]
    fn deleting_previously_inserted_and_filled_row_clears_dirty_node() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("source.hcd");
        create_plain_rows_fixture(&source, 2);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("insert-delete-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let mut patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_14.to_string(),
            document_id: "insert-delete-doc".to_string(),
            patch_id: "insert-row".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id: sheet_id.clone(),
                before_row: 2,
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        patch.patch_id = "fill-row".to_string();
        patch.base_revision = 1;
        patch.operations = vec![PatchOperation::XlsxCellSet {
            sheet_id: sheet_id.clone(),
            row: 2,
            column: 1,
            text: "Temporary".to_string(),
        }];
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        patch.patch_id = "delete-row".to_string();
        patch.base_revision = 2;
        patch.operations = vec![PatchOperation::XlsxRowDelete { sheet_id, row: 2 }];
        hcd_core::apply_patch(&bundle, &patch, 2).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("result.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("Temporary"), "{xml}");
        assert!(
            xml.contains("<c r=\"A2\" t=\"inlineStr\"><is><t>Row 2</t>"),
            "{xml}"
        );
        assert!(!xml.contains("<row r=\"3\""), "{xml}");
    }

    #[test]
    fn middle_column_insertion_preserves_ids_history_and_exported_addresses() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("columns.hcd");
        let exported = temp.path().join("edited.xlsx");
        create_plain_rows_fixture(&source, 2);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("middle-column-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let descriptor = &bundle.read_index_page(&imported, 0).unwrap().chunks[0];
        let sheet_id = descriptor.grid.as_ref().unwrap().sheet_id.clone();
        let original_d2 = bundle
            .read_map(descriptor)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.source.paragraph_id.as_deref() == Some("D2"))
            .unwrap();
        let insert = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_13.to_string(),
            document_id: "middle-column-doc".to_string(),
            patch_id: "insert-column-d".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnInsert {
                sheet_id: sheet_id.clone(),
                before_column: 4,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &insert, 0).unwrap().revision,
            1
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &insert, 1).unwrap().revision,
            1
        );
        let mut stale = insert.clone();
        stale.patch_id = "stale-column".to_string();
        assert!(hcd_core::apply_patch(&bundle, &stale, 1).is_err());
        let head = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        let map = bundle.read_map(descriptor).unwrap();
        let e2 = map
            .entries
            .iter()
            .find(|entry| entry.node_id == original_d2.node_id)
            .unwrap();
        assert_eq!(e2.source.paragraph_id.as_deref(), Some("E2"));
        assert_eq!(e2.source.source_cell_ref.as_deref(), Some("D2"));
        assert!(bundle
            .read_chunk(descriptor)
            .unwrap()
            .contains("data-hcd-cell=\"E2\""));
        assert!(validate_bundle(&bundle).unwrap().valid);
        let fill = PatchBatch {
            patch_id: "fill-inserted-column".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id: sheet_id.clone(),
                row: 2,
                column: 4,
                text: "New column".to_string(),
            }],
            ..insert
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &fill, 1).unwrap().revision,
            2
        );
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains("<c r=\"D2\" t=\"inlineStr\"><is><t>New column</t>"),
            "{xml}"
        );
        assert!(
            xml.contains("<c r=\"E2\" t=\"inlineStr\"><is><t>Right 2</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:E2\"/>"), "{xml}");
        let history = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &history,
            &ExportOptions {
                revision: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&history, "xl/worksheets/sheet1.xml").contains("<c r=\"D2\""));

        let second = PatchBatch {
            patch_id: "insert-column-b-next".to_string(),
            base_revision: 2,
            operations: vec![PatchOperation::XlsxColumnInsert {
                sheet_id: sheet_id.clone(),
                before_column: 2,
            }],
            ..fill.clone()
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &second, 2).unwrap().revision,
            3
        );
        let third = PatchBatch {
            patch_id: "insert-row-two-after-columns".to_string(),
            base_revision: 3,
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id,
                before_row: 2,
            }],
            ..second
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &third, 3).unwrap().revision,
            4
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let combined = temp.path().join("combined.xlsx");
        export_xlsx(&bundle, &source, &combined, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&combined, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains("<c r=\"E3\" t=\"inlineStr\"><is><t>New column</t>"),
            "{xml}"
        );
        assert!(
            xml.contains("<c r=\"F3\" t=\"inlineStr\"><is><t>Right 2</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:F3\"/>"), "{xml}");
    }

    #[test]
    fn middle_column_insertion_shifts_all_row_windows() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("long.xlsx");
        let bundle_path = temp.path().join("long.hcd");
        let exported = temp.path().join("shifted.xlsx");
        create_plain_rows_fixture(&source, 130);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("long-column-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let first = bundle.read_index_page(&imported, 0).unwrap();
        assert!(first.chunks.len() >= 2);
        let sheet_id = first.chunks[0].grid.as_ref().unwrap().sheet_id.clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_13.to_string(),
            document_id: "long-column-doc".to_string(),
            patch_id: "cross-window-column".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnInsert {
                sheet_id,
                before_column: 4,
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("<c r=\"E1\" t=\"inlineStr\"><is><t>Right 1</t>"));
        assert!(xml.contains("<c r=\"E130\" t=\"inlineStr\"><is><t>Right 130</t>"));
        assert!(xml.contains("<dimension ref=\"A1:E130\"/>"));
    }

    #[test]
    fn middle_column_deletion_shifts_all_windows_and_preserves_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("long.xlsx");
        let bundle_path = temp.path().join("long.hcd");
        create_plain_rows_fixture(&source, 130);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("delete-column-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_15.to_string(),
            document_id: "delete-column-doc".to_string(),
            patch_id: "delete-column-d".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnDelete {
                sheet_id,
                column: 4,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &patch, 0).unwrap().revision,
            1
        );
        assert!(
            hcd_core::apply_patch(&bundle, &patch, 1)
                .unwrap()
                .idempotent_replay
        );
        let mut stale = patch.clone();
        stale.patch_id = "stale-delete-column".to_string();
        assert!(hcd_core::apply_patch(&bundle, &stale, 1).is_err());
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("deleted.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("Right 1</t>"), "{xml}");
        assert!(!xml.contains("Right 130</t>"), "{xml}");
        assert!(
            xml.contains("<c r=\"A130\" t=\"inlineStr\"><is><t>Row 130</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:C130\"/>"));
        let historical = temp.path().join("history.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&historical, "xl/worksheets/sheet1.xml").contains("Right 130</t>"));
    }

    #[test]
    fn deleting_implicit_blank_column_moves_source_cells_left() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sparse.xlsx");
        let bundle_path = temp.path().join("sparse.hcd");
        create_plain_rows_fixture(&source, 2);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("sparse-delete-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_15.to_string(),
            document_id: "sparse-delete-doc".to_string(),
            patch_id: "delete-empty-b".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnDelete {
                sheet_id,
                column: 2,
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("shifted.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains("<c r=\"C1\" t=\"inlineStr\"><is><t>Right 1</t>"),
            "{xml}"
        );
        assert!(
            xml.contains("<c r=\"C2\" t=\"inlineStr\"><is><t>Right 2</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:C2\"/>"), "{xml}");
    }

    #[test]
    fn deleting_filled_inserted_column_clears_dirty_node() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("source.hcd");
        create_plain_rows_fixture(&source, 2);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("insert-delete-column-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let mut patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_15.to_string(),
            document_id: "insert-delete-column-doc".to_string(),
            patch_id: "insert-column-b".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnInsert {
                sheet_id: sheet_id.clone(),
                before_column: 2,
            }],
            metadata: BTreeMap::new(),
        };
        hcd_core::apply_patch(&bundle, &patch, 0).unwrap();
        patch.patch_id = "fill-column-b".to_string();
        patch.base_revision = 1;
        patch.operations = vec![PatchOperation::XlsxCellSet {
            sheet_id: sheet_id.clone(),
            row: 1,
            column: 2,
            text: "Temporary".to_string(),
        }];
        hcd_core::apply_patch(&bundle, &patch, 1).unwrap();
        patch.patch_id = "delete-column-b".to_string();
        patch.base_revision = 2;
        patch.operations = vec![PatchOperation::XlsxColumnDelete {
            sheet_id,
            column: 2,
        }];
        hcd_core::apply_patch(&bundle, &patch, 2).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("result.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("Temporary"), "{xml}");
        assert!(
            xml.contains("<c r=\"D2\" t=\"inlineStr\"><is><t>Right 2</t>"),
            "{xml}"
        );
        assert!(xml.contains("<dimension ref=\"A1:D2\"/>"), "{xml}");
    }

    #[test]
    fn deleting_all_columns_keeps_empty_rows_and_valid_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.xlsx");
        let bundle_path = temp.path().join("source.hcd");
        create_plain_rows_fixture(&source, 2);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("all-columns-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        for revision in 0..4 {
            let patch = PatchBatch {
                schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_15.to_string(),
                document_id: "all-columns-doc".to_string(),
                patch_id: format!("delete-first-column-{revision}"),
                base_revision: revision,
                actor: BTreeMap::new(),
                operations: vec![PatchOperation::XlsxColumnDelete {
                    sheet_id: sheet_id.clone(),
                    column: 1,
                }],
                metadata: BTreeMap::new(),
            };
            hcd_core::apply_patch(&bundle, &patch, revision).unwrap();
        }
        assert!(validate_bundle(&bundle).unwrap().valid);
        let exported = temp.path().join("empty.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains("<c "), "{xml}");
        assert!(xml.contains("<row r=\"2\""), "{xml}");
        assert!(xml.contains("<dimension ref=\"A1\"/>"), "{xml}");
    }

    #[test]
    fn middle_column_insertion_rejects_explicit_source_widths() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("widths.xlsx");
        let bundle_path = temp.path().join("widths.hcd");
        create_merge_edit_fixture(&source);
        let manifest = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("widths-column-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_13.to_string(),
            document_id: "widths-column-doc".to_string(),
            patch_id: "reject-source-widths".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnInsert {
                sheet_id,
                before_column: 4,
            }],
            metadata: BTreeMap::new(),
        };
        assert!(hcd_core::apply_patch(&bundle, &patch, 0).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 0);
    }

    #[test]
    fn xlsx_column_width_splits_source_span_and_preserves_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("widths.xlsx");
        let bundle_path = temp.path().join("widths.hcd");
        create_merge_edit_fixture(&source);
        let mut options = ImportOptions::new("column-width-doc");
        options.chunk_blocks = 1;
        let imported = import_xlsx(&source, &bundle_path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let original_page = bundle.read_index_page(&imported, 0).unwrap();
        assert_eq!(original_page.chunks.len(), 2);
        let sheet_id = original_page.chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let width_patch = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_9.to_string(),
            document_id: "column-width-doc".to_string(),
            patch_id: "width-b".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxColumnWidth {
                sheet_id: sheet_id.clone(),
                column: 2,
                width_chars: 30.5,
            }],
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &width_patch, 0)
                .unwrap()
                .revision,
            1
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &width_patch, 1)
                .unwrap()
                .revision,
            1
        );
        let validation = validate_bundle(&bundle).unwrap();
        assert!(validation.valid, "{:?}", validation.issues);
        let descriptor = &bundle
            .read_index_page(&bundle.manifest().unwrap(), 0)
            .unwrap()
            .chunks[0];
        let html = bundle.read_chunk(descriptor).unwrap();
        assert!(html.contains("data-hcd-column-start=\"2\" data-hcd-column-end=\"2\" data-hcd-width=\"30.50\" data-hcd-width-edited=\"true\""));
        let second_descriptor = &bundle
            .read_index_page(&bundle.manifest().unwrap(), 0)
            .unwrap()
            .chunks[1];
        assert!(bundle
            .read_chunk(second_descriptor)
            .unwrap()
            .contains("data-hcd-width-edited=\"true\""));
        let first_export = temp.path().join("first-width.xlsx");
        export_xlsx(&bundle, &source, &first_export, &ExportOptions::default()).unwrap();
        let sheet = read_zip_entry(&first_export, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<col min=\"1\" max=\"1\" width=\"12\""));
        assert!(sheet.contains("<col min=\"2\" max=\"2\" width=\"30.50\""));
        assert!(sheet.contains("<col min=\"3\" max=\"4\" width=\"12\""));

        let history = temp.path().join("original-width.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &history,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        let original = read_zip_entry(&history, "xl/worksheets/sheet1.xml");
        assert!(original.contains("<col min=\"1\" max=\"4\" width=\"12\""));
        assert!(!original.contains("width=\"30.50\""));

        let second_patch = PatchBatch {
            patch_id: "width-f".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxColumnWidth {
                sheet_id,
                column: 6,
                width_chars: 17.0,
            }],
            ..width_patch
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &second_patch, 1)
                .unwrap()
                .revision,
            2
        );
        assert!(validate_bundle(&bundle).unwrap().valid);
        let second_export = temp.path().join("second-width.xlsx");
        export_xlsx(&bundle, &source, &second_export, &ExportOptions::default()).unwrap();
        let second_sheet = read_zip_entry(&second_export, "xl/worksheets/sheet1.xml");
        assert!(
            second_sheet.contains("<col min=\"6\" max=\"6\" width=\"17.00\" customWidth=\"1\"/>")
        );
        assert!(second_sheet.contains("<dimension ref=\"A1:F2\"/>"));
    }

    #[test]
    fn xlsx_row_height_exports_existing_and_inserted_rows_with_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("rows.xlsx");
        let bundle_path = temp.path().join("rows.hcd");
        create_plain_rows_fixture(&source, 3);
        let mut options = ImportOptions::new("row-height-doc");
        options.chunk_blocks = 1;
        let imported = import_xlsx(&source, &bundle_path, &options, |_| Ok(())).unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&imported, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let patch = |id: &str, revision: u64, operation| PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_18.to_string(),
            document_id: "row-height-doc".to_string(),
            patch_id: id.to_string(),
            base_revision: revision,
            actor: BTreeMap::new(),
            operations: vec![operation],
            metadata: BTreeMap::new(),
        };
        let first = patch(
            "height-existing",
            0,
            PatchOperation::XlsxRowHeight {
                sheet_id: sheet_id.clone(),
                row: 1,
                height_points: 30.5,
            },
        );
        hcd_core::apply_patch(&bundle, &first, 0).unwrap();
        assert_eq!(
            hcd_core::apply_patch(&bundle, &first, 1).unwrap().revision,
            1
        );
        let insert = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_12.to_string(),
            operations: vec![PatchOperation::XlsxRowInsert {
                sheet_id: sheet_id.clone(),
                before_row: 1,
            }],
            ..patch(
                "insert-middle",
                1,
                PatchOperation::XlsxRowHeight {
                    sheet_id: sheet_id.clone(),
                    row: 1,
                    height_points: 30.5,
                },
            )
        };
        hcd_core::apply_patch(&bundle, &insert, 1).unwrap();
        let second = patch(
            "height-inserted",
            2,
            PatchOperation::XlsxRowHeight {
                sheet_id: sheet_id.clone(),
                row: 1,
                height_points: 44.0,
            },
        );
        hcd_core::apply_patch(&bundle, &second, 2).unwrap();
        let stale = patch(
            "stale-height",
            2,
            PatchOperation::XlsxRowHeight {
                sheet_id,
                row: 1,
                height_points: 52.0,
            },
        );
        assert!(hcd_core::apply_patch(&bundle, &stale, 3).is_err());
        assert_eq!(bundle.manifest().unwrap().revision, 3);
        assert!(validate_bundle(&bundle).unwrap().valid);

        let exported = temp.path().join("edited.xlsx");
        export_xlsx(&bundle, &source, &exported, &ExportOptions::default()).unwrap();
        let xml = read_zip_entry(&exported, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains("<row r=\"1\" ht=\"44.00\" customHeight=\"1\"/>"),
            "{xml}"
        );
        assert!(
            xml.contains("<row r=\"2\" ht=\"30.50\" customHeight=\"1\">"),
            "{xml}"
        );
        assert!(xml.contains("<row r=\"3\"><c r=\"A3\""), "{xml}");
        let historical = temp.path().join("original.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &historical,
            &ExportOptions {
                revision: Some(0),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        let old = read_zip_entry(&historical, "xl/worksheets/sheet1.xml");
        assert!(!old.contains("customHeight"));
        assert!(!old.contains("<row r=\"4\""));
    }

    #[test]
    fn removes_only_empty_appended_xlsx_tail_row() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("tail.xlsx");
        let bundle_path = temp.path().join("tail.hcd");
        create_merge_edit_fixture(&source);
        let imported = import_xlsx(
            &source,
            &bundle_path,
            &ImportOptions::new("tail-removal-doc"),
            |_| Ok(()),
        )
        .unwrap();
        let bundle = Bundle::open(&bundle_path).unwrap();
        let sheet_id = bundle.read_index_page(&imported, 0).unwrap().chunks[0]
            .grid
            .as_ref()
            .unwrap()
            .sheet_id
            .clone();
        let remove = PatchBatch {
            schema_version: hcd_core::HCD_PATCH_SCHEMA_VERSION_10.to_string(),
            document_id: "tail-removal-doc".to_string(),
            patch_id: "remove-source-row".to_string(),
            base_revision: 0,
            actor: BTreeMap::new(),
            operations: vec![PatchOperation::XlsxRowRemoveLast {
                sheet_id: sheet_id.clone(),
                row: 2,
            }],
            metadata: BTreeMap::new(),
        };
        assert!(hcd_core::apply_patch(&bundle, &remove, 0).is_err());
        let append = PatchBatch {
            patch_id: "append-empty-tail".to_string(),
            operations: vec![PatchOperation::XlsxRowAppend {
                sheet_id: sheet_id.clone(),
                after_row: 2,
            }],
            ..remove.clone()
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &append, 0).unwrap().revision,
            1
        );
        let remove = PatchBatch {
            patch_id: "remove-empty-tail".to_string(),
            base_revision: 1,
            operations: vec![PatchOperation::XlsxRowRemoveLast {
                sheet_id: sheet_id.clone(),
                row: 3,
            }],
            ..remove
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &remove, 1).unwrap().revision,
            2
        );
        assert_eq!(
            hcd_core::apply_patch(&bundle, &remove, 2).unwrap().revision,
            2
        );
        let report = validate_bundle(&bundle).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        let head = bundle.manifest().unwrap();
        let descriptor = &bundle.read_index_page(&head, 0).unwrap().chunks[0];
        assert_eq!(descriptor.grid.as_ref().unwrap().row_end, Some(2));
        assert!(!bundle
            .read_chunk(descriptor)
            .unwrap()
            .contains("data-hcd-row=\"3\""));
        let head_export = temp.path().join("without-tail.xlsx");
        export_xlsx(&bundle, &source, &head_export, &ExportOptions::default()).unwrap();
        assert!(!read_zip_entry(&head_export, "xl/worksheets/sheet1.xml").contains("<row r=\"3\""));
        let old_export = temp.path().join("with-tail.xlsx");
        export_xlsx(
            &bundle,
            &source,
            &old_export,
            &ExportOptions {
                revision: Some(1),
                ..ExportOptions::default()
            },
        )
        .unwrap();
        assert!(read_zip_entry(&old_export, "xl/worksheets/sheet1.xml").contains("<row r=\"3\"/>"));

        let refill = PatchBatch {
            patch_id: "append-for-filled-check".to_string(),
            base_revision: 2,
            ..append
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &refill, 2).unwrap().revision,
            3
        );
        let fill_sheet_id = sheet_id.clone();
        let fill = PatchBatch {
            patch_id: "fill-tail".to_string(),
            base_revision: 3,
            operations: vec![PatchOperation::XlsxCellSet {
                sheet_id,
                row: 3,
                column: 1,
                text: "Keep me".to_string(),
            }],
            ..refill
        };
        assert_eq!(
            hcd_core::apply_patch(&bundle, &fill, 3).unwrap().revision,
            4
        );
        let reject_filled = PatchBatch {
            patch_id: "reject-filled-tail".to_string(),
            base_revision: 4,
            operations: vec![PatchOperation::XlsxRowRemoveLast {
                sheet_id: fill_sheet_id,
                row: 3,
            }],
            ..fill
        };
        assert!(hcd_core::apply_patch(&bundle, &reject_filled, 4).is_err());
    }

    #[test]
    fn worksheet_rewrite_preserves_prefixed_styled_cells_and_empty_rows() {
        let source = br#"<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Original</x:t></x:is></x:c><x:c r="B1" s="3"/><x:c r="D1" t="inlineStr"><x:is><x:t>Right</x:t></x:is></x:c><x:c r="E1" s="4"/></x:row><x:row r="2"/></x:sheetData></x:worksheet>"#;
        let replacements = BTreeMap::new();
        let created = BTreeMap::from([
            ("B1".to_string(), "Styled".to_string()),
            ("C1".to_string(), "Inserted".to_string()),
            ("A2".to_string(), "New row value".to_string()),
        ]);
        let mut output = Vec::new();
        rewrite_worksheet(
            &mut source.as_slice(),
            &mut output,
            &replacements,
            &BTreeMap::new(),
            &created,
            &BTreeMap::from([("E1".to_string(), "A1+1".to_string())]),
            &BTreeSet::new(),
            &BTreeSet::from([1, 2]),
            &BTreeMap::from([(2, 24.0)]),
            &BTreeMap::new(),
            &[],
            &[],
            5,
        )
        .unwrap();
        let xml = String::from_utf8(output).unwrap();
        assert!(xml.contains("<x:cols><x:col min=\"2\" max=\"2\" width=\"24.00\" customWidth=\"1\"/></x:cols><x:sheetData>"));
        assert!(xml.contains(
            "<x:c r=\"B1\" s=\"3\" t=\"inlineStr\"><x:is><x:t>Styled</x:t></x:is></x:c>"
        ));
        assert!(
            xml.contains("<x:c r=\"C1\" t=\"inlineStr\"><x:is><x:t>Inserted</x:t></x:is></x:c>")
        );
        assert!(xml.contains("<x:row r=\"2\"><x:c r=\"A2\" t=\"inlineStr\"><x:is><x:t>New row value</x:t></x:is></x:c></x:row>"));
        assert!(xml.contains("<x:c r=\"E1\" s=\"4\"><x:f>A1+1</x:f><x:v/></x:c>"));
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
                r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="7" zoomScale="75"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView><sheetView workbookViewId="0" view="pageBreakPreview" topLeftCell="$B$2" rightToLeft="1" showGridLines="0" showRowColHeaders="0" showZeros="0" showFormulas="1" zoomScale="125"><pane xSplit="2" ySplit="3" topLeftCell="$C$4" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="8.43" defaultRowHeight="15"/><cols><col min="1" max="2" width="20" customWidth="1"/></cols><sheetData><row r="1" ht="24" customHeight="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" s="2"/></row><row r="2"/><row r="3"><c r="C3" t="inlineStr"><is><t>After merge</t></is></c><c r="D3" s="2"><v>1234.5</v></c><c r="E3" s="3"><v>0.256</v></c><c r="F3" s="4"><v>1</v></c><c r="G3" s="5"><v>92.34</v></c></row><row r="4"/><row r="5"/></sheetData><mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="D4:E5"/></mergeCells></worksheet>"#,
            ),
            ("xl/media/image1.png", "streamed-after-sheet-chunks"),
        ];
        for (name, contents) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn create_plain_rows_fixture(path: &Path, count: u32) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let parts = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Long" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
        ];
        for (name, contents) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
        write!(zip, "<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:D{count}\"/><sheetData>").unwrap();
        for row in 1..=count {
            write!(zip, "<row r=\"{row}\"><c r=\"A{row}\" t=\"inlineStr\"><is><t>Row {row}</t></is></c><c r=\"D{row}\" t=\"inlineStr\"><is><t>Right {row}</t></is></c></row>").unwrap();
        }
        zip.write_all(b"</sheetData></worksheet>").unwrap();
        zip.finish().unwrap();
    }

    fn create_grid_shift_merge_fixture(path: &Path) {
        let plain = path.with_extension("plain.xlsx");
        create_plain_rows_fixture(&plain, 4);
        let mut source = zip::ZipArchive::new(File::open(&plain).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for index in 0..source.len() {
            let mut entry = source.by_index(index).unwrap();
            let name = entry.name().to_string();
            output.start_file(&name, options).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                output.write_all(br#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D4"/><sheetViews><sheetView workbookViewId="0" topLeftCell="A1"><selection activeCell="A1" sqref="A1:B2"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Anchor</t></is></c></row><row r="3"><c r="D3" t="inlineStr"><is><t>Other</t></is></c></row><row r="4"><c r="D4" t="inlineStr"><is><t>Tail</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A2:B3"/></mergeCells></worksheet>"#).unwrap();
            } else {
                std::io::copy(&mut entry, &mut output).unwrap();
            }
        }
        output.finish().unwrap();
    }

    fn create_formula_edit_fixture(path: &Path) {
        let plain = path.with_extension("plain.xlsx");
        create_plain_rows_fixture(&plain, 1);
        let mut source = zip::ZipArchive::new(File::open(&plain).unwrap()).unwrap();
        let mut output = zip::ZipWriter::new(File::create(path).unwrap());
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for index in 0..source.len() {
            let mut entry = source.by_index(index).unwrap();
            let name = entry.name().to_string();
            output.start_file(&name, options).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                output.write_all(br#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D1"/><sheetData><row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f>SUM(A1:B1)</f><v>5</v></c><c r="D1"><f t="shared" si="0">A1+1</f><v>3</v></c></row></sheetData></worksheet>"#).unwrap();
            } else {
                std::io::copy(&mut entry, &mut output).unwrap();
            }
        }
        output.finish().unwrap();
    }

    fn create_merge_edit_fixture(path: &Path) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let parts = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Merge" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D2"/><cols><col min="1" max="4" width="12" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Anchor</t></is></c><c r="D1" t="inlineStr"><is><t>Other</t></is></c></row><row r="2"><c r="D2" t="inlineStr"><is><t>Below</t></is></c></row></sheetData></worksheet>"#,
            ),
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
