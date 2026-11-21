//! Built-in operations and discovery metadata come from the same registrations.
//! Native handlers, blank writers and HTML writers are independent capabilities.

use crate::create::{self, CreateOptions};
use crate::html::{self, HtmlExport};
use handler_common::{DocumentHandler, HandlerError};
use serde::Serialize;
use std::path::Path;

type OpenHandler = fn(&str, bool) -> Result<Box<dyn DocumentHandler>, HandlerError>;
type CreateDocument = fn(&str, &CreateOptions) -> Result<String, HandlerError>;
type HtmlWriter = fn(&mut HtmlExport<'_>) -> Result<usize, HandlerError>;

pub struct FormatRegistration {
    pub id: &'static str,
    pub extensions: &'static [&'static str],
    pub(crate) open: Option<OpenHandler>,
    pub(crate) create: Option<CreateDocument>,
    pub(crate) html_writer: Option<HtmlWriter>,
}

impl FormatRegistration {
    pub fn can_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn can_create(&self) -> bool {
        self.create.is_some()
    }

    /// Whether semantic HTML can be rebuilt as this format. This is separate
    /// from HCD source-backed export and does not promise exact round-tripping.
    pub fn can_convert_html(&self) -> bool {
        self.html_writer.is_some()
    }
}

const FORMATS: &[FormatRegistration] = &[
    FormatRegistration {
        id: "excalidraw",
        extensions: &["excalidraw"],
        open: None,
        create: Some(|path, _| {
            std::fs::write(path,b"{\"type\":\"excalidraw\",\"version\":2,\"source\":\"OfficeCLI\",\"elements\":[],\"appState\":{\"viewBackgroundColor\":\"#ffffff\"},\"files\":{}}")?;
            Ok(format!("Created canvas: {path}"))
        }),
        html_writer: None,
    },
    FormatRegistration {
        id: "docx",
        extensions: &["docx"],
        open: Some(open_word),
        create: Some(|path, options| {
            create::create_blank_docx_with_locale(path, options.minimal, options.locale.as_deref())
        }),
        html_writer: Some(html::write_docx),
    },
    FormatRegistration {
        id: "xlsx",
        extensions: &["xlsx"],
        open: Some(open_excel),
        create: Some(|path, options| {
            create::create_blank_xlsx_with_locale(path, options.locale.as_deref())
        }),
        html_writer: Some(html::write_xlsx),
    },
    FormatRegistration {
        id: "pptx",
        extensions: &["pptx"],
        open: Some(open_powerpoint),
        create: Some(|path, options| {
            create::create_blank_pptx_with_locale(path, options.locale.as_deref())
        }),
        html_writer: Some(html::write_pptx),
    },
    FormatRegistration {
        id: "pdf",
        extensions: &["pdf"],
        open: Some(|path, editable| Ok(Box::new(pdf_handler::PdfHandler::open(path, editable)?))),
        create: Some(|path, _| create::create_blank_pdf(path)),
        html_writer: Some(html::write_pdf),
    },
    FormatRegistration {
        id: "html",
        extensions: &["html", "htm"],
        open: None,
        create: None,
        html_writer: None,
    },
    FormatRegistration {
        id: "md",
        extensions: &["md", "markdown"],
        open: None,
        create: None,
        html_writer: Some(html::write_markdown),
    },
    FormatRegistration {
        id: "txt",
        extensions: &["txt"],
        open: None,
        create: None,
        html_writer: Some(html::write_text),
    },
    // Macro-enabled packages share a native handler, but blank creation and
    // HTML rebuild do not claim to produce or preserve a VBA project.
    FormatRegistration {
        id: "docm",
        extensions: &["docm"],
        open: Some(open_word),
        create: None,
        html_writer: None,
    },
    FormatRegistration {
        id: "xlsm",
        extensions: &["xlsm"],
        open: Some(open_excel),
        create: None,
        html_writer: None,
    },
    FormatRegistration {
        id: "pptm",
        extensions: &["pptm"],
        open: Some(open_powerpoint),
        create: None,
        html_writer: None,
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

pub fn format_for_path(path: &Path) -> Option<&'static FormatRegistration> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .and_then(format_for_extension)
}

/// Static implementation capabilities. Document-specific revision, source,
/// font and renderer restrictions must still be checked at execution time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatCapabilities {
    pub format: &'static str,
    pub extensions: Vec<&'static str>,
    pub native_open: bool,
    pub create: bool,
    pub html_conversion: bool,
    pub hcd_import: bool,
    pub source_backed_export: bool,
    pub raster_image: bool,
    pub delimited_grid_export: bool,
    pub canonical_html_export: bool,
    pub archive_export: bool,
}

pub fn capabilities() -> Vec<FormatCapabilities> {
    let mut result = Vec::new();
    for adapter in hcd_formats::registry::formats() {
        let native = format_for_extension(adapter.id);
        result.push(FormatCapabilities {
            format: adapter.id,
            extensions: adapter.extensions.to_vec(),
            native_open: native.is_some_and(FormatRegistration::can_open),
            create: native.is_some_and(FormatRegistration::can_create),
            html_conversion: native.is_some_and(FormatRegistration::can_convert_html),
            hcd_import: true,
            source_backed_export: !adapter.raster_image,
            raster_image: adapter.raster_image,
            delimited_grid_export: matches!(adapter.id, "csv" | "tsv"),
            canonical_html_export: adapter.id == "html",
            archive_export: false,
        });
    }
    for native in FORMATS {
        if result.iter().any(|format| format.format == native.id) {
            continue;
        }
        result.push(FormatCapabilities {
            format: native.id,
            extensions: native.extensions.to_vec(),
            native_open: native.can_open(),
            create: native.can_create(),
            html_conversion: native.can_convert_html(),
            hcd_import: false,
            source_backed_export: false,
            raster_image: false,
            delimited_grid_export: false,
            canonical_html_export: false,
            archive_export: false,
        });
    }
    result.push(FormatCapabilities {
        format: "hcd",
        extensions: vec!["hcd"],
        native_open: false,
        create: false,
        html_conversion: false,
        hcd_import: false,
        source_backed_export: false,
        raster_image: false,
        delimited_grid_export: false,
        canonical_html_export: false,
        archive_export: true,
    });
    result
}

/// The ordered target list for a normal HCD document. Capability discovery,
/// transport validation and MCP schemas must all use these registrations.
pub fn document_export_formats(is_spreadsheet: bool) -> Vec<&'static str> {
    capabilities()
        .into_iter()
        .filter(|format| {
            format.html_conversion
                || format.canonical_html_export
                || format.archive_export
                || (is_spreadsheet && format.delimited_grid_export)
        })
        .map(|format| format.format)
        .collect()
}

pub fn image_export_formats() -> Vec<&'static str> {
    capabilities()
        .into_iter()
        .filter(|format| format.raster_image || format.archive_export)
        .map(|format| format.format)
        .collect()
}

pub fn hcd_export_formats() -> Vec<&'static str> {
    capabilities()
        .into_iter()
        .filter(|format| {
            format.html_conversion
                || format.format == "excalidraw"
                || format.delimited_grid_export
                || format.canonical_html_export
                || format.raster_image
                || format.archive_export
        })
        .map(|format| format.format)
        .collect()
}

fn open_word(path: &str, editable: bool) -> Result<Box<dyn DocumentHandler>, HandlerError> {
    Ok(Box::new(docx_handler::WordHandler::open(path, editable)?))
}

fn open_excel(path: &str, editable: bool) -> Result<Box<dyn DocumentHandler>, HandlerError> {
    Ok(Box::new(xlsx_handler::ExcelHandler::open(path, editable)?))
}

fn open_powerpoint(path: &str, editable: bool) -> Result<Box<dyn DocumentHandler>, HandlerError> {
    Ok(Box::new(pptx_handler::PptxHandler::open(path, editable)?))
}
