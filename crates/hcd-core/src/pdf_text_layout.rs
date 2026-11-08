//! Renderer-derived, revision-bound PDF text geometry. Text remains solely in
//! its canonical span; run partitions hold scalar counts and display metadata.
use crate::{extract_html_text_nodes, hash_bytes, HcdError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const PDF_TEXT_LAYOUT_ATTRIBUTE: &str = "data-hcd-pdf-text-layout";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfTextRunLayout {
    pub chars: usize,
    pub rect: [f64; 4],
    pub baseline: [f64; 2],
    pub size_pt: f64,
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfTextLayout {
    pub version: u32,
    pub text_hash: String,
    pub rect: [f64; 4],
    pub source_rect: [f64; 4],
    pub runs: Vec<PdfTextRunLayout>,
}
/// Internal typed plan only; clients cannot provide trusted renderer geometry.
#[derive(Debug, Clone)]
pub struct PdfNodeTextLayout {
    pub node_id: String,
    pub expected_hash: String,
    pub layout: PdfTextLayout,
}

impl PdfTextLayout {
    pub fn validate(&self, text: &str) -> Result<(), HcdError> {
        let rect = |rect: &[f64; 4]| {
            rect.iter()
                .all(|value| value.is_finite() && value.abs() <= 57_600.)
                && rect[2] >= 0.
                && rect[3] >= 0.
        };
        if self.version != 1
            || self.text_hash != hash_bytes(text.as_bytes())
            || !rect(&self.rect)
            || !rect(&self.source_rect)
            || self.runs.len() > 4096
        {
            return Err(HcdError::InvalidBundle(
                "invalid or stale PDF text layout".into(),
            ));
        }
        let mut count = 0usize;
        for run in &self.runs {
            if run.chars == 0
                || !rect(&run.rect)
                || !run
                    .baseline
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 57_600.)
                || !run.size_pt.is_finite()
                || run.size_pt <= 0.
                || run.size_pt > 14_400.
                || run.family.len() > 256
                || run.family.chars().any(char::is_control)
            {
                return Err(HcdError::InvalidBundle(
                    "invalid PDF text run geometry".into(),
                ));
            }
            count = count
                .checked_add(run.chars)
                .ok_or_else(|| HcdError::ResourceLimit("PDF text layout scalar overflow".into()))?;
        }
        if count != text.chars().count() {
            return Err(HcdError::InvalidBundle(
                "PDF text layout does not cover canonical text".into(),
            ));
        }
        if !self.runs.is_empty() {
            let left = self
                .runs
                .iter()
                .map(|run| run.rect[0])
                .fold(f64::INFINITY, f64::min);
            let top = self
                .runs
                .iter()
                .map(|run| run.rect[1])
                .fold(f64::INFINITY, f64::min);
            let right = self
                .runs
                .iter()
                .map(|run| run.rect[0] + run.rect[2])
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = self
                .runs
                .iter()
                .map(|run| run.rect[1] + run.rect[3])
                .fold(f64::NEG_INFINITY, f64::max);
            if self
                .rect
                .iter()
                .zip([left, top, right - left, bottom - top])
                .any(|(a, b)| (a - b).abs() > 0.001)
            {
                return Err(HcdError::InvalidBundle(
                    "PDF text frame does not match its runs".into(),
                ));
            }
        }
        Ok(())
    }
}

pub fn extract_pdf_text_layouts(html: &str) -> Result<HashMap<String, PdfTextLayout>, HcdError> {
    if !html.contains(PDF_TEXT_LAYOUT_ATTRIBUTE) {
        return Ok(HashMap::new());
    }
    let text = extract_html_text_nodes(html)?;
    let wrapped = format!("<hcd>{html}</hcd>");
    let document = roxmltree::Document::parse(&wrapped)
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
    let mut output = HashMap::new();
    for node in document
        .descendants()
        .filter(|node| node.has_attribute(PDF_TEXT_LAYOUT_ATTRIBUTE))
    {
        let id = node.attribute("data-hcd-text-node").ok_or_else(|| {
            HcdError::InvalidBundle("PDF layout has no canonical identity".into())
        })?;
        let layout: PdfTextLayout =
            serde_json::from_str(node.attribute(PDF_TEXT_LAYOUT_ATTRIBUTE).unwrap())?;
        layout.validate(
            text.get(id)
                .ok_or_else(|| HcdError::InvalidBundle("PDF layout text is missing".into()))?,
        )?;
        if output.insert(id.to_string(), layout).is_some() {
            return Err(HcdError::InvalidBundle("duplicate PDF text layout".into()));
        }
    }
    Ok(output)
}

pub(crate) fn update_pdf_text_layout(
    html: &str,
    id: &str,
    layout: Option<&PdfTextLayout>,
) -> Result<String, HcdError> {
    use quick_xml::{
        events::{BytesStart, Event},
        Reader, Writer,
    };
    let mut reader = Reader::from_str(html);
    let mut writer = Writer::new(Vec::with_capacity(html.len() + 1024));
    let mut found = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                let mut attrs: BTreeMap<String, String> = tag
                    .attributes()
                    .map(|attr| {
                        let attr =
                            attr.map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                        Ok((
                            String::from_utf8_lossy(attr.key.as_ref()).into_owned(),
                            attr.decode_and_unescape_value(reader.decoder())
                                .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, HcdError>>()?;
                if attrs
                    .get("data-hcd-text-node")
                    .is_some_and(|value| value == id)
                {
                    if found {
                        return Err(HcdError::InvalidBundle(
                            "duplicate PDF text identity".into(),
                        ));
                    }
                    found = true;
                    attrs.remove(PDF_TEXT_LAYOUT_ATTRIBUTE);
                    if let Some(layout) = layout {
                        attrs.insert(
                            PDF_TEXT_LAYOUT_ATTRIBUTE.into(),
                            serde_json::to_string(layout)?,
                        );
                        attrs.insert(
                            "data-hcd-source-bbox".into(),
                            layout.source_rect.map(|value| value.to_string()).join(","),
                        );
                        attrs.insert(
                            "data-hcd-bbox".into(),
                            layout.rect.map(|value| value.to_string()).join(","),
                        );
                        let mut style: BTreeMap<String, String> = attrs
                            .get("style")
                            .into_iter()
                            .flat_map(|value| value.split(';'))
                            .filter_map(|value| value.split_once(':'))
                            .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
                            .collect();
                        for ((property, attribute), value) in [
                            ("left", "data-hcd-x"),
                            ("top", "data-hcd-y"),
                            ("width", "data-hcd-width"),
                            ("height", "data-hcd-height"),
                        ]
                        .into_iter()
                        .zip(layout.rect)
                        {
                            attrs.insert(attribute.into(), value.to_string());
                            style.insert(property.into(), format!("{value}pt"));
                        }
                        if let Some(run) = layout.runs.first() {
                            style.insert("font-size".into(), format!("{}pt", run.size_pt));
                            style.insert(
                                "font-family".into(),
                                format!(
                                    "\"{}\",sans-serif",
                                    run.family.replace('\\', "\\\\").replace('"', "\\\"")
                                ),
                            );
                            style.insert(
                                "font-weight".into(),
                                if run.bold { "bold" } else { "normal" }.into(),
                            );
                            style.insert(
                                "font-style".into(),
                                if run.italic { "italic" } else { "normal" }.into(),
                            );
                        }
                        attrs.insert(
                            "style".into(),
                            style
                                .into_iter()
                                .map(|(key, value)| format!("{key}:{value}"))
                                .collect::<Vec<_>>()
                                .join(";"),
                        );
                        attrs.remove("data-hcd-pdf-layout-approximate");
                    } else {
                        attrs.insert("data-hcd-pdf-layout-approximate".into(), "true".into());
                    }
                    let name = String::from_utf8_lossy(tag.name().as_ref()).into_owned();
                    let mut updated = BytesStart::new(name);
                    for (key, value) in &attrs {
                        updated.push_attribute((key.as_str(), value.as_str()));
                    }
                    let event = if matches!(event, Event::Empty(_)) {
                        Event::Empty(updated)
                    } else {
                        Event::Start(updated)
                    };
                    writer.write_event(event).map_err(HcdError::Io)?;
                    continue;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        writer.write_event(event).map_err(HcdError::Io)?;
    }
    if !found && layout.is_some() {
        return Err(HcdError::InvalidBundle(
            "PDF layout target is missing".into(),
        ));
    }
    String::from_utf8(writer.into_inner())
        .map_err(|error| HcdError::InvalidBundle(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(text: &str) -> PdfTextLayout {
        PdfTextLayout {
            version: 1,
            text_hash: hash_bytes(text.as_bytes()),
            rect: [1., 2., 30., 14.],
            source_rect: [1., 50., 30., 14.],
            runs: vec![PdfTextRunLayout {
                chars: text.chars().count(),
                rect: [1., 2., 30., 14.],
                baseline: [1., 12.],
                size_pt: 14.,
                family: "Noto Sans SC".into(),
                bold: false,
                italic: false,
            }],
        }
    }
    #[test]
    fn derived_layout_roundtrips_without_duplicating_text_and_can_be_invalidated() {
        let text = "A&😀";
        let html=format!("<section><p class=\"hcd-pdf-text\" data-hcd-text-node=\"n\" style=\"left:0pt;top:0pt;width:20pt;height:14pt\"><span data-hcd-id=\"n\" data-hcd-node-hash=\"{}\">A&amp;😀</span></p></section>",hash_bytes(text.as_bytes()));
        let layout = sample(text);
        let updated = update_pdf_text_layout(&html, "n", Some(&layout)).unwrap();
        assert_eq!(extract_html_text_nodes(&updated).unwrap()["n"], text);
        assert_eq!(extract_pdf_text_layouts(&updated).unwrap()["n"], layout);
        assert!(!serde_json::to_string(&layout).unwrap().contains(text));
        let invalidated = update_pdf_text_layout(&updated, "n", None).unwrap();
        assert!(extract_pdf_text_layouts(&invalidated).unwrap().is_empty());
        assert!(invalidated.contains("data-hcd-pdf-layout-approximate=\"true\""));
    }
    #[test]
    fn stale_hash_partition_and_nonfinite_or_inconsistent_geometry_are_rejected() {
        let original = sample("😀中");
        original.validate("😀中").unwrap();
        assert!(original.validate("changed").is_err());
        let mut bad = original.clone();
        bad.runs[0].chars = 3;
        assert!(bad.validate("😀中").is_err());
        let mut bad = original.clone();
        bad.rect[0] = f64::NAN;
        assert!(bad.validate("😀中").is_err());
        let mut bad = original;
        bad.rect[2] = 31.;
        assert!(bad.validate("😀中").is_err());
    }
}
