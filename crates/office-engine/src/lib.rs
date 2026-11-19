//! Reusable document operations shared by command-line and service adapters.
//!
//! Creation takes explicit options. The caller owns environment defaults, CLI
//! argument parsing, resident sessions and external plugin discovery.

mod create;
mod hcd_html;
mod html;
pub mod registry;

pub use create::{create_document, CreateOptions, CreateSummary};
pub use hcd_html::render_hcd_html;
pub use html::{convert_html, convert_html_with_assets, HtmlConversionSummary, SemanticAsset};

use handler_common::{DocumentHandler, HandlerError};
use std::path::Path;

/// Open an in-process native handler. Plugin and resident dispatch belong to
/// the host, so an unregistered extension is returned as `None`.
pub fn try_open_document(
    path: impl AsRef<Path>,
    editable: bool,
) -> Result<Option<Box<dyn DocumentHandler>>, HandlerError> {
    let path = path.as_ref();
    let Some(open) = registry::format_for_path(path).and_then(|format| format.open) else {
        return Ok(None);
    };
    open(utf8_path(path)?, editable).map(Some)
}

/// Open a built-in format without starting a CLI process or resident session.
pub fn open_document(
    path: impl AsRef<Path>,
    editable: bool,
) -> Result<Box<dyn DocumentHandler>, HandlerError> {
    let path = path.as_ref();
    try_open_document(path, editable)?
        .ok_or_else(|| HandlerError::OpenError(format!("unsupported format: {}", path.display())))
}

fn utf8_path(path: &Path) -> Result<&str, HandlerError> {
    path.to_str().ok_or_else(|| {
        HandlerError::InvalidArgument("document path must be valid UTF-8".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use handler_common::ViewOptions;

    #[test]
    fn standalone_creation_opens_native_documents_and_protects_existing_files() {
        let temp = tempfile::tempdir().unwrap();
        for format in registry::formats()
            .iter()
            .filter(|format| format.can_create() && format.can_open())
        {
            let requested = temp.path().join(format.id);
            let created =
                create_document(&requested, Some(format.id), &CreateOptions::default()).unwrap();
            assert_eq!(created.path, requested.with_extension(format.id));
            let handler = open_document(&created.path, false).unwrap();
            assert!(handler.validate().unwrap().is_empty(), "{}", format.id);
            let original = std::fs::read(&created.path).unwrap();
            assert!(create_document(&created.path, None, &CreateOptions::default()).is_err());
            assert_eq!(std::fs::read(&created.path).unwrap(), original);
        }
    }

    #[test]
    fn library_conversion_preserves_content_without_a_cli_process() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("source.html");
        std::fs::write(&input, "<h1>Library conversion</h1><p>中文 &amp; text</p>").unwrap();
        for target in ["docx", "xlsx", "pptx"] {
            let output = temp.path().join(format!("converted.{target}"));
            let summary = convert_html(&input, &output, target).unwrap();
            assert_eq!(summary.engine, "rust-html-semantic");
            let handler = open_document(output, false).unwrap();
            let text = handler.view_as_text(ViewOptions::default()).unwrap();
            assert!(text.contains("Library conversion"), "{target}: {text}");
            assert!(text.contains("中文 & text"), "{target}: {text}");
        }
    }

    #[test]
    fn creation_uses_explicit_locale_and_minimal_options() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rtl.docx");
        create_document(
            &path,
            None,
            &CreateOptions {
                locale: Some("ar-SA".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        assert!(package
            .read_part_xml("word/document.xml")
            .unwrap()
            .contains("<w:bidi/>"));
        assert!(package
            .read_part_xml("word/styles.xml")
            .unwrap()
            .contains("Arabic Typesetting"));

        create_document(
            &path,
            None,
            &CreateOptions {
                overwrite: true,
                minimal: true,
                ..Default::default()
            },
        )
        .unwrap();
        let package = oxml::OxmlPackage::open(path.to_str().unwrap(), false).unwrap();
        assert!(package.read_part_xml("word/styles.xml").is_err());
    }
}
