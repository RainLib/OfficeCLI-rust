use crate::{html::escape_attribute, HcdError};
use serde::{Deserialize, Serialize};

pub const MASTER_SIZE: u16 = 1;
pub const MASTER_BOLD: u16 = 2;
pub const MASTER_ITALIC: u16 = 4;
pub const MASTER_UNDERLINE: u16 = 8;
pub const MASTER_COLOR: u16 = 16;
pub const MASTER_LATIN: u16 = 32;
pub const MASTER_EAST_ASIA: u16 = 64;
pub const MASTER_BIDI: u16 = 128;
pub const MASTER_ALL: u16 = 255;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PptxMasterTextKind {
    Title,
    Body,
    Other,
}

impl PptxMasterTextKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Body => "body",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxMasterTextStyle {
    pub kind: PptxMasterTextKind,
    /// DrawingML list level, 1 through 9.
    pub level: u8,
    #[serde(default)]
    pub format: crate::PptxRunFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<crate::FontPatch>,
}

impl PptxMasterTextStyle {
    pub fn merge(&mut self, update: &Self) {
        macro_rules! merge { ($($field:ident),*) => { $(if update.format.$field.is_some() { self.format.$field.clone_from(&update.format.$field); })* } }
        merge!(bold, italic, underline, font_size_pt, color);
        if let Some(font) = &update.font {
            let current = self.font.get_or_insert(crate::FontPatch {
                latin: None,
                east_asia: None,
                bidi: None,
            });
            if font.latin.is_some() {
                current.latin.clone_from(&font.latin);
            }
            if font.east_asia.is_some() {
                current.east_asia.clone_from(&font.east_asia);
            }
            if font.bidi.is_some() {
                current.bidi.clone_from(&font.bidi);
            }
        }
    }
}

pub type PptxMasterTextStyles = std::collections::BTreeMap<String, Vec<PptxMasterTextStyle>>;

pub fn validate_master_text_style(style: &PptxMasterTextStyle) -> Result<(), HcdError> {
    let f = &style.format;
    if !(1..=9).contains(&style.level)
        || f.font_size_pt
            .is_some_and(|size| !size.is_finite() || !(1.0..=256.0).contains(&size))
        || f.color
            .as_deref()
            .is_some_and(|color| !valid_pptx_background(color))
        || f == &crate::PptxRunFormat::default() && style.font.is_none()
    {
        return Err(HcdError::InvalidPatch(
            "invalid or empty master text style".into(),
        ));
    }
    if let Some(font) = &style.font {
        crate::patch::validate_font_patch(font)?;
    }
    Ok(())
}

pub fn upsert_master_text(styles: &mut Vec<PptxMasterTextStyle>, update: &PptxMasterTextStyle) {
    if let Some(current) = styles
        .iter_mut()
        .find(|style| style.kind == update.kind && style.level == update.level)
    {
        current.merge(update);
    } else {
        styles.push(update.clone());
    }
}

const ATTRIBUTE: &str = "data-hcd-pptx-design";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PptxSlideDesign {
    pub layout_part: String,
    pub layout_name: String,
    pub master_part: String,
    pub master_name: String,
    pub master_color: Option<String>,
    pub layout_color: Option<String>,
    pub layout_background: bool,
    pub slide_background: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub master_text_styles: Vec<PptxMasterTextStyle>,
}

impl PptxSlideDesign {
    pub fn inherited_color(&self) -> Option<&str> {
        if self.slide_background {
            None
        } else if self.layout_background {
            self.layout_color.as_deref()
        } else {
            self.master_color.as_deref()
        }
    }
}

pub fn valid_pptx_background(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn valid_master_part(part: &str) -> bool {
    part.strip_prefix("ppt/slideMasters/")
        .and_then(|name| name.strip_suffix(".xml"))
        .is_some_and(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

pub fn read_pptx_design(html: &str) -> Result<Option<PptxSlideDesign>, HcdError> {
    let attribute = format!(" {ATTRIBUTE}=\"");
    let raw = html
        .split_once('>')
        .and_then(|(tag, _)| tag.split_once(&attribute))
        .and_then(|(_, tail)| tail.split_once('"'))
        .map(|(value, _)| value);
    raw.map(|raw| {
        let json = quick_xml::escape::unescape(raw)
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        let design: PptxSlideDesign = serde_json::from_str(&json)?;
        if !valid_master_part(&design.master_part)
            || design
                .master_color
                .as_deref()
                .is_some_and(|color| !valid_pptx_background(color))
            || design
                .layout_color
                .as_deref()
                .is_some_and(|color| !valid_pptx_background(color))
        {
            return Err(HcdError::InvalidBundle("invalid PPTX slide design".into()));
        }
        Ok(design)
    })
    .transpose()
}

pub fn pptx_design_attribute(design: &PptxSlideDesign) -> Result<String, HcdError> {
    Ok(format!(
        " {ATTRIBUTE}=\"{}\"",
        escape_attribute(&serde_json::to_string(design)?)
    ))
}

pub(crate) fn write_pptx_design(
    html: &mut String,
    design: &PptxSlideDesign,
) -> Result<(), HcdError> {
    let end = html
        .find('>')
        .ok_or_else(|| HcdError::InvalidBundle("slide section is incomplete".into()))?;
    let marker = format!(" {ATTRIBUTE}=\"");
    let mut tag = html[..end].to_string();
    if let Some(start) = tag.find(&marker) {
        let value = start + marker.len();
        let close = value
            + tag[value..].find('"').ok_or_else(|| {
                HcdError::InvalidBundle("slide design attribute is incomplete".into())
            })?;
        tag.replace_range(start..=close, "");
    }
    tag.push_str(&pptx_design_attribute(design)?);
    html.replace_range(..end, &tag);
    Ok(())
}
