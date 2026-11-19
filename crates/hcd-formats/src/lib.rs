//! Streaming/source-backed HCD adapters for Office, PDF, HTML, Markdown and plain text.

mod common;
mod mermaid;
mod pdf;
mod pptx;
mod textual;
mod xlsx;

use hcd_core::{HcdError, HcdManifest, ImportEvent};
use std::path::Path;

pub use common::{ExportOptions, ImportOptions, PdfRasterMode};
pub use hcd_docx::validate_source_export as validate_docx_source_export;
pub use pdf::validate_pdf_source_export;
pub use xlsx::grid_filter::verify_xlsx_filter_source;

/// Expand presentation-only Markdown features without changing canonical HCD.
/// The transform is bounded to one chunk and safe to call after every revision.
pub fn enhance_presentation_fragment(html: &str) -> Result<String, HcdError> {
    mermaid::enhance_fragment(html)
}

pub fn import_document<F>(
    source: impl AsRef<Path>,
    output: impl AsRef<Path>,
    options: &ImportOptions,
    emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let source = source.as_ref();
    match extension(source)?.as_str() {
        "docx" => {
            let mut docx_options = hcd_docx::ImportOptions::new(&options.document_id);
            docx_options.chunk_soft_bytes = options.chunk_soft_bytes;
            docx_options.chunk_blocks = options.chunk_blocks;
            docx_options.storage_codec = options.storage_codec;
            hcd_docx::import_docx(source, output, &docx_options, emit)
        }
        "xlsx" => xlsx::import_xlsx(source, output.as_ref(), options, emit),
        "csv" => xlsx::delimited::import(source, output.as_ref(), options, "csv", emit),
        "tsv" => xlsx::delimited::import(source, output.as_ref(), options, "tsv", emit),
        "pptx" => pptx::import_pptx(source, output.as_ref(), options, emit),
        "pdf" => pdf::import_pdf(source, output.as_ref(), options, emit),
        "html" | "htm" => textual::import_html(source, output.as_ref(), options, emit),
        "md" | "markdown" => textual::import_markdown(source, output.as_ref(), options, emit),
        "txt" => textual::import_text(source, output.as_ref(), options, emit),
        extension => Err(HcdError::Unsupported(format!(
            "HCD import does not support .{extension}"
        ))),
    }
}

pub fn export_document(
    bundle: impl AsRef<Path>,
    source: impl AsRef<Path>,
    target: impl AsRef<Path>,
    options: &ExportOptions,
) -> Result<hcd_core::FidelityReport, HcdError> {
    let opened = hcd_core::Bundle::open(bundle.as_ref())?;
    let manifest = opened.manifest()?;
    match manifest.source.format.as_str() {
        "docx" => hcd_docx::export_docx(
            bundle,
            source,
            target,
            &hcd_docx::ExportOptions {
                revision: options.revision,
                fidelity_report: options.fidelity_report.clone(),
            },
        ),
        "xlsx" => xlsx::export_xlsx(&opened, source.as_ref(), target.as_ref(), options),
        format @ ("csv" | "tsv") => xlsx::delimited::export(
            &opened,
            Some(source.as_ref()),
            target.as_ref(),
            format,
            options,
            None,
        ),
        "pptx" => pptx::export_pptx(&opened, source.as_ref(), target.as_ref(), options),
        "pdf" => pdf::export_pdf(&opened, source.as_ref(), target.as_ref(), options),
        "html" => textual::export_html(&opened, source.as_ref(), target.as_ref(), options),
        "md" => textual::export_markdown(&opened, source.as_ref(), target.as_ref(), options),
        "txt" => textual::export_text(&opened, source.as_ref(), target.as_ref(), options),
        format => Err(HcdError::Unsupported(format!(
            "HCD export does not support source format {format}"
        ))),
    }
}

pub fn export_delimited_grid(
    bundle: &hcd_core::Bundle,
    source: Option<&Path>,
    target: &Path,
    format: &str,
    options: &ExportOptions,
    sheet_name: Option<&str>,
) -> Result<hcd_core::FidelityReport, HcdError> {
    xlsx::delimited::export(bundle, source, target, format, options, sheet_name)
}

pub fn export_pdf_pages(
    bundle: &hcd_core::Bundle,
    source: &Path,
    target: &Path,
    options: &ExportOptions,
    page_range: std::ops::RangeInclusive<usize>,
) -> Result<hcd_core::FidelityReport, HcdError> {
    if bundle.manifest()?.source.format != "pdf" {
        return Err(HcdError::Unsupported(
            "native page extraction requires a PDF bundle".to_string(),
        ));
    }
    pdf::export_pdf_revision(bundle, source, target, options, Some(page_range))
}

fn extension(path: &Path) -> Result<String, HcdError> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            HcdError::Unsupported(format!(
                "file has no supported extension: {}",
                path.display()
            ))
        })
}
