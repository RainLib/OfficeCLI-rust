use super::{
    append_cell, column_name, finish_worksheet_row, CellBuilder, MergeCursor, RenderedRow,
    SharedStringStore, SheetChunkWriter, SheetPart, WorksheetViewMetadata, XlsxFormatStats,
    XlsxStyleCatalog,
};
use crate::common::{
    base_manifest, emit_failed, emit_started, finish_import, source_identity,
    write_fidelity_report, ExportOptions, ImportOptions,
};
use hcd_core::{
    manifest_at_revision, Bundle, BundleWriter, FidelityLevel, FidelityReport, FidelityWarning,
    GridChunkKind, HcdError, HcdManifest, ImportEvent, HCD_SCHEMA_VERSION, MAX_CHUNK_BYTES,
};
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

fn delimiter(format: &str) -> Result<u8, HcdError> {
    match format {
        "csv" => Ok(b','),
        "tsv" => Ok(b'\t'),
        _ => Err(HcdError::Unsupported(format!(
            "unsupported delimited format {format}"
        ))),
    }
}

pub(crate) fn import<F>(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    format: &str,
    mut emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let (hash, size) = source_identity(source, format)?;
    emit_started(&mut emit, options, &hash)?;
    let result = (|| {
        let mut manifest = base_manifest(options, format, "grid", hash, size);
        let mut writer = BundleWriter::create_with_codec(output, options.storage_codec)?;
        writer.write_styles(".hcd-cell { white-space: pre-wrap; }")?;
        let sheet = SheetPart {
            name: "Sheet1".to_string(),
            // Delimited files share the grid patch protocol and its sheet-part locators.
            part: "xl/worksheets/sheet1.xml".to_string(),
            index: 0,
            state: "visible",
        };
        let mut chunks = SheetChunkWriter::new(
            &options.document_id,
            &sheet,
            options,
            &WorksheetViewMetadata::default(),
            &mut writer,
            &mut emit,
        );
        let scratch = tempfile::tempdir()?;
        let mut shared_strings = SharedStringStore::empty(scratch.path())?;
        let merged_ranges = MergeCursor::new(Vec::new());
        let styles = XlsxStyleCatalog::default();
        let mut stats = XlsxFormatStats::default();
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(delimiter(format)?)
            .from_path(source)
            .map_err(delimited_error)?;
        let mut cell_ordinal = 0;
        for (index, record) in reader.records().enumerate() {
            let record = record.map_err(delimited_error)?;
            let number = index as u64 + 1;
            if number > 1_048_576
                || record.len() > 16_384
                || record.as_slice().len() > MAX_CHUNK_BYTES
            {
                return Err(HcdError::ResourceLimit(format!(
                    ".{format} row {number} exceeds grid limits"
                )));
            }
            let mut row = RenderedRow {
                number,
                html: format!("<tr data-hcd-row=\"{number}\">"),
                ..Default::default()
            };
            for (index, field) in record.iter().enumerate() {
                let reference = format!("{}{number}", column_name(index as u32 + 1));
                if field
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
                {
                    return Err(HcdError::InvalidBundle(format!(
                        "unsupported control character in .{format} cell {reference}"
                    )));
                }
                cell_ordinal += 1;
                append_cell(
                    &mut row,
                    &options.document_id,
                    &sheet,
                    cell_ordinal,
                    CellBuilder {
                        reference,
                        value_type: "inlineStr".to_string(),
                        inline_text: field.to_string(),
                        ..Default::default()
                    },
                    &mut shared_strings,
                    &merged_ranges,
                    &styles,
                    false,
                    &mut stats,
                )?;
            }
            let mut row = finish_worksheet_row(row)?;
            // Character references keep CR and CRLF inside quoted fields intact in HTML parsers.
            row.html = row.html.replace('\r', "&#13;");
            chunks.push(row)?;
        }
        chunks.finish()?;
        manifest.fidelity = Some(semantic_report(format));
        finish_import(writer, manifest, &mut emit)
    })();
    if let Err(error) = &result {
        emit_failed(&mut emit, options, error);
    }
    result
}

fn check_source(head: &HcdManifest, source: &Path, format: &str) -> Result<(), HcdError> {
    let (hash, size) = source_identity(source, format)?;
    if hash != head.source.sha256 || size != head.source.size_bytes || head.source.format != format
    {
        return Err(HcdError::SourceMismatch(format!(
            "immutable .{format} source does not match the manifest"
        )));
    }
    Ok(())
}

pub(crate) fn validate_source(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    let head = bundle.manifest()?;
    manifest_at_revision(bundle, &head, revision)?;
    check_source(&head, source, &head.source.format)
}

pub(crate) fn export(
    bundle: &Bundle,
    source: Option<&Path>,
    target: &Path,
    format: &str,
    options: &ExportOptions,
    sheet_name: Option<&str>,
) -> Result<FidelityReport, HcdError> {
    let delimiter = delimiter(format)?;
    let head = bundle.manifest()?;
    if head.profile != "grid" {
        return Err(HcdError::Unsupported(
            "CSV and TSV export require a spreadsheet".to_string(),
        ));
    }
    let (manifest, revision) = manifest_at_revision(bundle, &head, options.revision)?;
    if let Some(source) = source {
        check_source(&head, source, format)?;
    }
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    let report = if let Some(source) = source.filter(|_| revision == 0 && sheet_name.is_none()) {
        io::copy(&mut File::open(source)?, output.as_file_mut())?;
        FidelityReport {
            level: FidelityLevel::Exact,
            preserved: vec!["original delimited bytes".to_string()],
            flattened: Vec::new(),
            dropped: Vec::new(),
            warnings: Vec::new(),
            schema_version: HCD_SCHEMA_VERSION.to_string(),
        }
    } else {
        let bounded = BoundedWriter {
            output: output.as_file_mut(),
            remaining: 256 * 1024 * 1024,
        };
        let mut writer = csv::WriterBuilder::new()
            .flexible(true)
            .delimiter(delimiter)
            .from_writer(bounded);
        write_rows(bundle, &manifest, &mut writer, sheet_name)?;
        writer.flush()?;
        semantic_report(format)
    };
    output.as_file().sync_all()?;
    output.persist(target).map_err(|error| error.error)?;
    write_fidelity_report(options, &report)?;
    Ok(report)
}

fn write_rows(
    bundle: &Bundle,
    manifest: &HcdManifest,
    writer: &mut csv::Writer<impl Write>,
    sheet_name: Option<&str>,
) -> Result<(), HcdError> {
    let mut sheet = None;
    let mut next_row = 1;
    for index in 0..manifest.index_page_count {
        for descriptor in bundle.read_index_page(manifest, index)?.chunks {
            let Some(grid) = descriptor
                .grid
                .as_ref()
                .filter(|grid| grid.kind == GridChunkKind::Cells)
            else {
                continue;
            };
            if sheet_name.is_some_and(|name| name != grid.sheet_name) {
                continue;
            }
            let sheet_id = sheet.get_or_insert_with(|| grid.sheet_id.clone());
            if *sheet_id != grid.sheet_id {
                return Err(HcdError::Unsupported(
                    "CSV and TSV export of a multi-worksheet workbook requires --sheet".to_string(),
                ));
            }
            let html = bundle.read_chunk_verified(&descriptor)?;
            let document = roxmltree::Document::parse(&html).map_err(delimited_error)?;
            for row in document
                .descendants()
                .filter(|node| node.has_tag_name("tr"))
            {
                let number: u32 = row
                    .attribute("data-hcd-row")
                    .and_then(|value| value.parse().ok())
                    .filter(|number| (next_row..=1_048_576).contains(number))
                    .ok_or_else(|| {
                        HcdError::InvalidBundle("invalid delimited grid row address".to_string())
                    })?;
                for _ in next_row..number {
                    writer.write_record([""]).map_err(delimited_error)?;
                }
                next_row = number + 1;
                let mut fields = Vec::new();
                for cell in row.children().filter(|node| node.has_tag_name("td")) {
                    let column: usize = cell
                        .attribute("data-hcd-column")
                        .and_then(|value| value.parse().ok())
                        .filter(|column| (fields.len() + 1..=16_384).contains(column))
                        .ok_or_else(|| {
                            HcdError::InvalidBundle(
                                "invalid delimited grid column address".to_string(),
                            )
                        })?;
                    fields.resize(column - 1, "");
                    let value = cell
                        .attribute("data-hcd-formula-expression")
                        .or_else(|| {
                            cell.attribute("data-hcd-raw-value")
                                .filter(|value| !value.is_empty())
                        })
                        .or_else(|| {
                            cell.children()
                                .find(|node| node.attribute("data-hcd-node-hash").is_some())
                                .and_then(|node| node.text())
                        })
                        .unwrap_or_default();
                    fields.push(value);
                }
                if fields.is_empty() {
                    fields.push("");
                }
                writer.write_record(fields).map_err(delimited_error)?;
            }
        }
    }
    if sheet.is_none() {
        if let Some(name) = sheet_name {
            return Err(HcdError::Unsupported(format!(
                "worksheet {name:?} was not found in this revision"
            )));
        }
        return Err(HcdError::InvalidBundle("grid has no worksheet".to_string()));
    }
    Ok(())
}

fn semantic_report(format: &str) -> FidelityReport {
    FidelityReport {
        schema_version: HCD_SCHEMA_VERSION.to_string(),
        level: FidelityLevel::Semantic,
        preserved: vec!["single-worksheet cell addresses and UTF-8 field text".to_string()],
        flattened: vec!["available formula expressions are written as text fields; other formulas use stored values".to_string()],
        dropped: vec!["worksheet styles, merges, drawings and workbook metadata".to_string()],
        warnings: vec![FidelityWarning {
            code: "HCD_DELIMITED_NORMALIZED".to_string(),
            message: format!(".{format} uses UTF-8, normalized quoting and line endings; wholly blank physical lines in source data are skipped"),
            node_id: None, source_part: None,
        }],
    }
}

fn delimited_error(error: impl std::fmt::Display) -> HcdError {
    HcdError::InvalidBundle(format!("delimited grid: {error}"))
}

struct BoundedWriter<W> {
    output: W,
    remaining: usize,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::other("delimited export exceeds 256 MiB"));
        }
        let written = self.output.write(bytes)?;
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hcd_core::{
        apply_patch, extract_text_page, sort_grid, validate_bundle, GridSortDirection,
        GridSortRequest, NodePrecondition, PatchBatch, PatchOperation, HCD_PATCH_SCHEMA_VERSION,
    };

    #[test]
    fn grid_sort_preserves_delimited_text_and_explicit_blanks() {
        for (format, separator) in [("csv", ','), ("tsv", '\t')] {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join(format!("source.{format}"));
            let bundle_path = directory.path().join("source.hcd");
            let output = directory.path().join(format!("sorted.{format}"));
            std::fs::write(&source, format!(
                "Key{separator}ID\nBeta{separator}009\n{separator}003\nALPHA{separator}001\nalpha{separator}002\n"
            )).unwrap();
            let manifest = import(
                &source,
                &bundle_path,
                &ImportOptions::new("sorted-text"),
                format,
                |_| Ok(()),
            )
            .unwrap();
            let bundle = Bundle::open(bundle_path).unwrap();
            let sheet_id = bundle.read_index_page(&manifest, 0).unwrap().chunks[0]
                .grid
                .as_ref()
                .unwrap()
                .sheet_id
                .clone();
            let result = sort_grid(
                &bundle,
                GridSortRequest {
                    patch_id: "sort-by-text".into(),
                    base_revision: 0,
                    sheet_id,
                    start_row: 1,
                    end_row: 5,
                    start_column: 1,
                    end_column: 2,
                    sort_column: 1,
                    has_header: true,
                    direction: GridSortDirection::Ascending,
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(result.revision, 1);
            assert!(validate_bundle(&bundle).unwrap().valid);
            export(
                &bundle,
                None,
                &output,
                format,
                &ExportOptions::default(),
                None,
            )
            .unwrap();
            let sorted = std::fs::read_to_string(&output)
                .unwrap()
                .replace("\r\n", "\n");
            assert_eq!(sorted, format!(
                "Key{separator}ID\nALPHA{separator}001\nalpha{separator}002\nBeta{separator}009\n{separator}003\n"
            ));
        }
    }

    #[test]
    fn delimited_text_and_empty_fields_round_trip_after_grid_edit() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let bundle_path = directory.path().join("source.hcd");
        let output = directory.path().join("edited.tsv");
        std::fs::write(
            &source,
            "\u{feff}0017,\"a,b\",\"北京\r\n上海\",\r\n=1+1,\"\"\r\n",
        )
        .unwrap();
        let mut options = ImportOptions::new("delimited-test");
        options.chunk_blocks = 1;
        import(&source, &bundle_path, &options, "csv", |_| Ok(())).unwrap();
        let bundle = Bundle::open(bundle_path).unwrap();
        assert!(validate_bundle(&bundle).unwrap().valid);
        let node = extract_text_page(&bundle, None, 100)
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.text == "a,b")
            .unwrap();
        let patch = PatchBatch {
            schema_version: HCD_PATCH_SCHEMA_VERSION.to_string(),
            document_id: options.document_id,
            patch_id: "edit-delimited-cell".to_string(),
            base_revision: 0,
            actor: Default::default(),
            metadata: Default::default(),
            operations: vec![PatchOperation::TextSplice {
                node_id: node.node_id,
                start: 0,
                delete_count: 3,
                insert_text: "new\tvalue".to_string(),
                precondition: NodePrecondition {
                    node_hash: node.node_hash,
                },
            }],
        };
        assert_eq!(apply_patch(&bundle, &patch, 0).unwrap().revision, 1);
        assert!(validate_bundle(&bundle).unwrap().valid);
        export(
            &bundle,
            None,
            &output,
            "tsv",
            &ExportOptions::default(),
            None,
        )
        .unwrap();
        let records: Vec<_> = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(b'\t')
            .from_path(output)
            .unwrap()
            .records()
            .map(Result::unwrap)
            .collect();
        assert_eq!(records[0], vec!["0017", "new\tvalue", "北京\r\n上海", ""]);
        assert_eq!(records[1], vec!["=1+1", ""]);
    }
}
