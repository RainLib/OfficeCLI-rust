mod docx;
mod pdf;
mod pptx;
mod xlsx;

use crate::{registry, utf8_path};
use handler_common::HandlerError;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub(crate) use docx::{create_blank_docx, create_blank_docx_with_locale};
pub(crate) use pdf::create_blank_pdf;
pub(crate) use pptx::{create_blank_pptx, create_blank_pptx_with_locale};
pub(crate) use xlsx::{create_blank_xlsx, create_blank_xlsx_with_locale};

/// Host-independent creation settings. Locale is explicit; the library never
/// derives it from the process's LANG or LC_ALL variables.
#[derive(Debug, Clone, Default)]
pub struct CreateOptions {
    pub overwrite: bool,
    pub minimal: bool,
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSummary {
    pub path: PathBuf,
    pub format: &'static str,
    pub message: String,
}

/// Create a document using the registered writer for an explicit format or the
/// output extension. An explicit format supplies a missing file extension.
pub fn create_document(
    output: impl AsRef<Path>,
    format: Option<&str>,
    options: &CreateOptions,
) -> Result<CreateSummary, HandlerError> {
    let mut output = output.as_ref().to_path_buf();
    let extension = format
        .or_else(|| output.extension().and_then(|extension| extension.to_str()))
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if output.extension().is_none() && !extension.is_empty() {
        let mut filename = output.into_os_string();
        filename.push(".");
        filename.push(&extension);
        output = filename.into();
    }
    if output.exists() && !options.overwrite {
        return Err(HandlerError::InvalidArgument(format!(
            "file already exists: {}. Use --force to overwrite.",
            output.display()
        )));
    }
    let registration = registry::format_for_extension(&extension)
        .filter(|format| format.can_create())
        .ok_or_else(|| {
            HandlerError::UnsupportedMode(format!("create {extension} not supported"))
        })?;
    let message = registration.create.expect("creation was checked")(utf8_path(&output)?, options)?;
    Ok(CreateSummary {
        path: output,
        format: registration.id,
        message,
    })
}

fn locale_fonts(
    locale: Option<&str>,
) -> (
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
) {
    let Some(locale) = locale else {
        return (None, None, None);
    };
    let normalized = locale.replace('_', "-").to_ascii_lowercase();
    let language = normalized.split('-').next().unwrap_or_default();
    match normalized.as_str() {
        "zh-tw" | "zh-hk" | "zh-mo" | "zh-hant" => {
            (Some("Times New Roman"), Some("新細明體"), None)
        }
        "zh-cn" | "zh-sg" | "zh-hans" => (Some("Times New Roman"), Some("等线"), None),
        _ => match language {
            "zh" => (Some("Times New Roman"), Some("等线"), None),
            "ja" => (Some("Times New Roman"), Some("游明朝"), None),
            "ko" => (Some("Times New Roman"), Some("맑은 고딕"), None),
            "ar" => (Some("Times New Roman"), None, Some("Arabic Typesetting")),
            "he" => (Some("Times New Roman"), None, Some("Times New Roman")),
            "th" => (Some("Times New Roman"), None, Some("Tahoma")),
            "fa" => (Some("Times New Roman"), None, Some("B Nazanin")),
            "ur" => (
                Some("Times New Roman"),
                None,
                Some("Jameel Noori Nastaleeq"),
            ),
            "hi" => (Some("Times New Roman"), None, Some("Mangal")),
            "en" | "fr" | "de" | "es" | "it" | "pt" | "nl" | "ru" | "pl" => {
                (Some("Times New Roman"), None, None)
            }
            _ => (None, None, None),
        },
    }
}

fn locale_is_rtl(locale: &str) -> bool {
    matches!(
        locale
            .replace('_', "-")
            .to_ascii_lowercase()
            .split('-')
            .next(),
        Some(
            "ar" | "he"
                | "iw"
                | "yi"
                | "ji"
                | "ur"
                | "fa"
                | "ps"
                | "sd"
                | "ks"
                | "ug"
                | "ku"
                | "ckb"
                | "dv"
                | "syr"
                | "nqo"
        )
    )
}

fn default_theme_xml(locale: Option<&str>) -> String {
    let (_, east_asia, complex_script) = locale_fonts(locale);
    let east_asia = east_asia.unwrap_or("");
    let complex_script = complex_script.unwrap_or("");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="{}"/><a:cs typeface="{}"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="{}"/><a:cs typeface="{}"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#,
        east_asia, complex_script, east_asia, complex_script
    )
}
