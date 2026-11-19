//! Streaming/source-backed HCD adapters for Office, PDF, HTML, Markdown and plain text.

mod common;
pub mod images;
mod mermaid;
mod native_images;
mod pdf;
mod pptx;
mod textual;
mod theme_fonts;
mod xlsx;

use hcd_core::{HcdError, HcdManifest, ImportEvent};
use std::path::Path;

pub use common::{ExportOptions, ImportOptions, PdfRasterMode};
pub use pdf::validate_pdf_source_export;
pub use theme_fonts::{
    apply_theme_fonts, pdf_body_face, pdf_text_forecast, PdfBodyFace, PdfFaceOptions,
    PdfForecastFace, PdfRetargetLine, PdfTextForecast, ThemeFontApplication,
};
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
        "png" | "jpg" | "jpeg" | "webp" => {
            images::import_image(source, output.as_ref(), options, emit)
        }
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
    let mut report = match manifest.source.format.as_str() {
        "docx" => hcd_docx::export_docx(
            bundle.as_ref(),
            source.as_ref(),
            target.as_ref(),
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
        "png" | "jpg" | "jpeg" | "webp" => images::export_image(&opened, target.as_ref(), options),
        "txt" => textual::export_text(&opened, source.as_ref(), target.as_ref(), options),
        format => Err(HcdError::Unsupported(format!(
            "HCD export does not support source format {format}"
        ))),
    }?;
    let images = native_images::apply(&opened, target.as_ref(), options.revision)?;
    if images > 0 {
        if report.level == hcd_core::FidelityLevel::Exact {
            report.level = hcd_core::FidelityLevel::High;
        }
        report.preserved.push(format!(
            "{images} HCD-created image assets embedded with explicit native dimensions"
        ));
        common::write_fidelity_report(options, &report)?;
    }
    Ok(report)
}

/// Apply only versioned HCD-created media to an already materialized native
/// artifact of the document's source format. Used after the visual PDF rebuild,
/// which intentionally draws the original page raster separately from new media.
pub fn append_created_images(
    bundle: &hcd_core::Bundle,
    target: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    native_images::apply(bundle, target, revision).map(|_| ())
}

/// Check source identity and known revision restrictions without writing output.
/// Format writers can still report additional constraints during materialization.
pub fn validate_source_export(
    bundle: &hcd_core::Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    use common::{checked_export_state, checked_export_state_with_restores, RunFontSupport};
    let options = ExportOptions {
        revision,
        ..Default::default()
    };
    match bundle.manifest()?.source.format.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => {
            images::image_content(bundle, revision)?;
        }
        "pdf" | "xlsx" => {
            checked_export_state_with_restores(bundle, source, &options, RunFontSupport::Rejects)?;
        }
        "pptx" => {
            checked_export_state_with_restores(bundle, source, &options, RunFontSupport::Rewrites)?;
        }
        "docx" => {
            hcd_docx::validate_source_export(bundle, source, revision)?;
        }
        "html" | "md" | "txt" => {
            checked_export_state(bundle, source, &options, RunFontSupport::Rejects)?;
        }
        format => {
            return Err(HcdError::Unsupported(format!(
                "source-backed export does not support {format}"
            )))
        }
    }
    Ok(())
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
