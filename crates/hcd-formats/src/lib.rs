//! Streaming/source-backed HCD adapters for Office, PDF, HTML, Markdown and plain text.

mod canvas;
mod common;
pub mod images;
mod mermaid;
mod native_images;
mod pdf;
mod pptx;
pub mod registry;
mod textual;
mod theme_fonts;
mod xlsx;

use hcd_core::{HcdError, HcdManifest, ImportEvent};
use std::path::Path;

pub use common::{ExportOptions, ImportOptions, PdfRasterMode};
pub use theme_fonts::{
    apply_theme_fonts, pdf_body_face, pdf_text_forecast, PdfBodyFace, PdfFaceOptions,
    PdfForecastFace, PdfRetargetLine, PdfTextForecast, ThemeFontApplication,
};

/// Expand presentation-only Markdown features without changing canonical HCD.
/// The transform is bounded to one chunk and safe to call after every revision.
pub fn enhance_presentation_fragment(html: &str) -> Result<String, HcdError> {
    mermaid::enhance_fragment(html)
}

pub fn import_document<F>(
    source: impl AsRef<Path>,
    output: impl AsRef<Path>,
    options: &ImportOptions,
    mut emit: F,
) -> Result<HcdManifest, HcdError>
where
    F: FnMut(&ImportEvent) -> Result<(), HcdError>,
{
    let source = source.as_ref();
    let extension = extension(source)?;
    let format = registry::format_for_extension(&extension).ok_or_else(|| {
        HcdError::Unsupported(format!("HCD import does not support .{extension}"))
    })?;
    (format.import)(source, output.as_ref(), options, &mut emit)
}

pub fn export_document(
    bundle: impl AsRef<Path>,
    source: impl AsRef<Path>,
    target: impl AsRef<Path>,
    options: &ExportOptions,
) -> Result<hcd_core::FidelityReport, HcdError> {
    let opened = hcd_core::Bundle::open(bundle.as_ref())?;
    let manifest = opened.manifest()?;
    let format = registry::format_for_extension(&manifest.source.format).ok_or_else(|| {
        HcdError::Unsupported(format!(
            "HCD export does not support source format {}",
            manifest.source.format
        ))
    })?;
    let mut report = (format.export)(&opened, source.as_ref(), target.as_ref(), options)?;
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
    let manifest = bundle.manifest()?;
    let format = registry::format_for_extension(&manifest.source.format).ok_or_else(|| {
        HcdError::Unsupported(format!(
            "source-backed export does not support {}",
            manifest.source.format
        ))
    })?;
    (format.validate_export)(bundle, source, revision)
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
