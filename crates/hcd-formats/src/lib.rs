//! Streaming/source-backed HCD adapters for Office, PDF, HTML, Markdown and plain text.

mod canvas;
mod common;
pub mod images;
mod mermaid;
mod native_images;
mod office_features;
pub use office_features::{
    apply_office_features, edit_office_features, read_office_features, OfficeSnapshot,
};
mod pdf;
mod pptx;
pub mod registry;
mod textual;
mod theme_fonts;
pub mod worksheet_pivots;
pub mod worksheet_values;
mod xlsx;

use hcd_core::{HcdError, HcdManifest, ImportEvent};
use std::path::Path;

pub use common::{ExportOptions, ImportOptions, PdfRasterMode};
pub use hcd_docx::validate_picture_target as validate_docx_picture_target;
pub use hcd_docx::{edit_word_review, read_word_review, WordReviewEdit};
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

pub use pdf::render_pdf_raster;

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
    let groups = if manifest.source.format == "pptx" {
        pptx::groups::GroupExport::prepare(&opened, options.revision)?
    } else {
        pptx::groups::GroupExport::default()
    };
    let output = target.as_ref();
    let (version, _) = hcd_core::manifest_at_revision(&opened, &manifest, options.revision)?;
    let has_office_features = !hcd_core::office_features::read(&opened, &version)?.is_empty()
        || manifest.source.format == "docx" && office_features::has_managed_toc(source.as_ref())?;
    let staged = if groups.is_empty() && !has_office_features {
        None
    } else {
        if output.exists() {
            return Err(HcdError::InvalidBundle(format!(
                "target already exists: {}",
                output.display()
            )));
        }
        let dir = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir)?;
        Some(tempfile::tempdir_in(dir)?)
    };
    let staged_path = staged.as_ref().map(|scratch| {
        scratch
            .path()
            .join(format!("office.{}", manifest.source.format))
    });
    let target = staged_path.as_deref().unwrap_or(output);
    let mut initial_options = options.clone();
    if staged.is_some() {
        initial_options.fidelity_report = None;
    }
    let mut report = (format.export)(&opened, source.as_ref(), target, &initial_options)?;
    let images = native_images::apply(&opened, target, options.revision)?;
    let charts = if manifest.source.format == "xlsx" {
        xlsx::worksheet_charts::export(&opened, target, options.revision)?
    } else {
        0
    };
    let conditions = if manifest.source.format == "xlsx" {
        xlsx::worksheet_conditions::export(&opened, target, options.revision)?
    } else {
        0
    };
    let pivots = if manifest.source.format == "xlsx" {
        xlsx::worksheet_pivots::export(&opened, target, options.revision)?
    } else {
        0
    };
    let animations = if manifest.source.format == "pptx" {
        pptx::animations::export(&opened, target, options.revision)?
    } else {
        0
    };
    let group_slides = groups.write(target)?;
    apply_office_features(&opened, target, options.revision)?;
    if staged.is_some() {
        tempfile::TempPath::try_from_path(target)?
            .persist_noclobber(output)
            .map_err(|error| error.error)?;
    }
    if images != 0
        || charts != 0
        || conditions != 0
        || pivots != 0
        || animations != 0
        || staged.is_some()
    {
        if report.level == hcd_core::FidelityLevel::Exact {
            report.level = hcd_core::FidelityLevel::High;
        }
        if images > 0 {
            report.preserved.push(format!(
                "{images} HCD-created image assets embedded with explicit native dimensions"
            ));
        }
        if charts > 0 {
            report.preserved.push(format!(
                "{charts} worksheet chart changes written as native DrawingML linked to worksheet cells"
            ));
        }
        if conditions > 0 {
            report.preserved.push(format!(
                "{conditions} worksheet conditional-format changes stored as native rules and differential styles"
            ));
        }
        if pivots > 0 {
            report.preserved.push(format!(
                "{pivots} PivotTable changes exported with editable Excel definitions, typed cache records and materialized worksheet cells"
            ));
        }
        if animations > 0 {
            report.preserved.push(format!(
                "{animations} slide animation tracks written as native PresentationML timing"
            ));
        }
        if has_office_features {
            report.preserved.push("Versioned Office page layout, linked table of contents, footnotes, print settings and transitions materialized in native parts".into());
        }
        if group_slides > 0 {
            report.preserved.push(format!("{group_slides} slide drawing trees retain native editable groups and stable member IDs"));
        }
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
