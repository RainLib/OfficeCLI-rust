//! Register each source format's importer, writer and preflight together.
//! The facade and capability discovery use these same entries.

use crate::common::{checked_export_state, checked_export_state_with_restores, RunFontSupport};
use crate::{images, pdf, pptx, textual, xlsx, ExportOptions, ImportOptions};
use hcd_core::{Bundle, FidelityReport, HcdError, HcdManifest, ImportEvent};
use std::path::Path;

type EventSink<'a> = dyn FnMut(&ImportEvent) -> Result<(), HcdError> + 'a;
type Importer =
    fn(&Path, &Path, &ImportOptions, &mut EventSink<'_>) -> Result<HcdManifest, HcdError>;
type Exporter = fn(&Bundle, &Path, &Path, &ExportOptions) -> Result<FidelityReport, HcdError>;
type Preflight = fn(&Bundle, &Path, Option<u64>) -> Result<(), HcdError>;

pub struct FormatRegistration {
    pub id: &'static str,
    pub extensions: &'static [&'static str],
    pub raster_image: bool,
    pub(crate) import: Importer,
    pub(crate) export: Exporter,
    pub(crate) validate_export: Preflight,
}

const FORMATS: &[FormatRegistration] = &[
    FormatRegistration {
        id: "excalidraw",
        extensions: &["excalidraw"],
        raster_image: false,
        import: |source, output, options, emit| {
            crate::canvas::import(source, output, options, emit)
        },
        export: crate::canvas::export,
        validate_export: crate::canvas::preflight,
    },
    FormatRegistration {
        id: "docx",
        extensions: &["docx"],
        raster_image: false,
        import: |source, output, options, emit| {
            let mut docx_options = hcd_docx::ImportOptions::new(&options.document_id);
            docx_options.chunk_soft_bytes = options.chunk_soft_bytes;
            docx_options.chunk_blocks = options.chunk_blocks;
            docx_options.storage_codec = options.storage_codec;
            hcd_docx::import_docx(source, output, &docx_options, emit)
        },
        export: |bundle, source, target, options| {
            hcd_docx::export_docx(
                bundle.root(),
                source,
                target,
                &hcd_docx::ExportOptions {
                    revision: options.revision,
                    fidelity_report: options.fidelity_report.clone(),
                },
            )
        },
        validate_export: hcd_docx::validate_source_export,
    },
    FormatRegistration {
        id: "xlsx",
        extensions: &["xlsx"],
        raster_image: false,
        import: |source, output, options, emit| xlsx::import_xlsx(source, output, options, emit),
        export: xlsx::export_xlsx,
        validate_export: validate_restored_source,
    },
    FormatRegistration {
        id: "csv",
        extensions: &["csv"],
        raster_image: false,
        import: |source, output, options, emit| {
            xlsx::delimited::import(source, output, options, "csv", emit)
        },
        export: |bundle, source, target, options| {
            xlsx::delimited::export(bundle, Some(source), target, "csv", options, None)
        },
        validate_export: xlsx::delimited::validate_source,
    },
    FormatRegistration {
        id: "tsv",
        extensions: &["tsv"],
        raster_image: false,
        import: |source, output, options, emit| {
            xlsx::delimited::import(source, output, options, "tsv", emit)
        },
        export: |bundle, source, target, options| {
            xlsx::delimited::export(bundle, Some(source), target, "tsv", options, None)
        },
        validate_export: xlsx::delimited::validate_source,
    },
    FormatRegistration {
        id: "pptx",
        extensions: &["pptx"],
        raster_image: false,
        import: |source, output, options, emit| pptx::import_pptx(source, output, options, emit),
        export: pptx::export_pptx,
        validate_export: |bundle, source, revision| {
            checked_export_state_with_restores(
                bundle,
                source,
                &export_options(revision),
                RunFontSupport::Rewrites,
            )
            .map(|_| ())
        },
    },
    FormatRegistration {
        id: "pdf",
        extensions: &["pdf"],
        raster_image: false,
        import: |source, output, options, emit| pdf::import_pdf(source, output, options, emit),
        export: pdf::export_pdf,
        validate_export: validate_restored_source,
    },
    FormatRegistration {
        id: "html",
        extensions: &["html", "htm"],
        raster_image: false,
        import: |source, output, options, emit| textual::import_html(source, output, options, emit),
        export: textual::export_html,
        validate_export: validate_text_source,
    },
    FormatRegistration {
        id: "md",
        extensions: &["md", "markdown"],
        raster_image: false,
        import: |source, output, options, emit| {
            textual::import_markdown(source, output, options, emit)
        },
        export: textual::export_markdown,
        validate_export: validate_text_source,
    },
    FormatRegistration {
        id: "txt",
        extensions: &["txt"],
        raster_image: false,
        import: |source, output, options, emit| textual::import_text(source, output, options, emit),
        export: textual::export_text,
        validate_export: validate_text_source,
    },
    FormatRegistration {
        id: "png",
        extensions: &["png"],
        raster_image: true,
        import: import_image,
        export: export_image,
        validate_export: validate_image,
    },
    FormatRegistration {
        id: "jpeg",
        extensions: &["jpg", "jpeg"],
        raster_image: true,
        import: import_image,
        export: export_image,
        validate_export: validate_image,
    },
    FormatRegistration {
        id: "webp",
        extensions: &["webp"],
        raster_image: true,
        import: import_image,
        export: export_image,
        validate_export: validate_image,
    },
];

pub fn formats() -> &'static [FormatRegistration] {
    FORMATS
}

pub fn format_for_extension(extension: &str) -> Option<&'static FormatRegistration> {
    let extension = extension.trim_start_matches('.');
    FORMATS.iter().find(|format| {
        format
            .extensions
            .iter()
            .any(|registered| registered.eq_ignore_ascii_case(extension))
    })
}

fn export_options(revision: Option<u64>) -> ExportOptions {
    ExportOptions {
        revision,
        ..Default::default()
    }
}

fn validate_restored_source(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    checked_export_state_with_restores(
        bundle,
        source,
        &export_options(revision),
        RunFontSupport::Rejects,
    )
    .map(|_| ())
}

fn validate_text_source(
    bundle: &Bundle,
    source: &Path,
    revision: Option<u64>,
) -> Result<(), HcdError> {
    checked_export_state(
        bundle,
        source,
        &export_options(revision),
        RunFontSupport::Rejects,
    )
    .map(|_| ())
}

fn import_image(
    source: &Path,
    output: &Path,
    options: &ImportOptions,
    emit: &mut EventSink<'_>,
) -> Result<HcdManifest, HcdError> {
    images::import_image(source, output, options, emit)
}

fn export_image(
    bundle: &Bundle,
    _source: &Path,
    target: &Path,
    options: &ExportOptions,
) -> Result<FidelityReport, HcdError> {
    images::export_image(bundle, target, options)
}

fn validate_image(bundle: &Bundle, _source: &Path, revision: Option<u64>) -> Result<(), HcdError> {
    images::image_content(bundle, revision).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registrations_never_shadow_an_extension() {
        let mut extensions = HashSet::new();
        for format in formats() {
            for extension in format.extensions {
                assert!(
                    extensions.insert(extension),
                    "duplicate extension {extension}"
                );
            }
        }
    }

    #[test]
    fn facade_routes_text_aliases_and_delimited_grid_exports() {
        let temp = tempfile::tempdir().unwrap();
        for (extension, canonical, content) in [
            ("htm", "html", "<p>HTML source 中文</p>"),
            ("markdown", "md", "# Markdown source 中文\n"),
            ("txt", "txt", "Plain source 中文\n"),
            ("csv", "csv", "ID,城市\n001,上海\n"),
            ("tsv", "tsv", "ID\t城市\n001\t上海\n"),
        ] {
            let source = temp.path().join(format!("source.{extension}"));
            let output = temp.path().join(format!("restored.{extension}"));
            let bundle_path = temp.path().join(format!("{canonical}.hcd"));
            std::fs::write(&source, content).unwrap();
            let mut events = 0;
            let manifest = crate::import_document(
                &source,
                &bundle_path,
                &ImportOptions::new(canonical),
                |_| {
                    events += 1;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(manifest.source.format, canonical);
            assert!(events > 0);
            let bundle = Bundle::open(&bundle_path).unwrap();
            crate::validate_source_export(&bundle, &source, None).unwrap();
            crate::export_document(&bundle_path, &source, &output, &ExportOptions::default())
                .unwrap();
            assert_eq!(std::fs::read_to_string(output).unwrap(), content);
        }
    }
}
