//! Rich strings inside a stable spreadsheet cell anchor. Offsets are Unicode
//! scalars, just like text.splice; the canvas converts them to UTF-16 indices.
use crate::HcdError;
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type XlsxRunProperties = BTreeMap<String, BTreeMap<String, String>>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct XlsxInlineRun {
    pub text: String,
    pub properties: XlsxRunProperties,
}

/// Spreadsheet font properties are data, never unvalidated source XML. Keeping
/// theme/indexed colours and font scheme also permits a source-backed native
/// export to preserve properties that the current HTML renderer approximates.
pub fn validate_xlsx_run_properties(properties: &XlsxRunProperties) -> Result<(), HcdError> {
    for (name, attributes) in properties {
        if !matches!(
            name.as_str(),
            "rFont"
                | "charset"
                | "family"
                | "b"
                | "i"
                | "strike"
                | "outline"
                | "shadow"
                | "condense"
                | "extend"
                | "color"
                | "sz"
                | "u"
                | "vertAlign"
                | "scheme"
        ) {
            return Err(HcdError::InvalidBundle(format!(
                "unsupported XLSX run property {name}"
            )));
        }
        for (key, value) in attributes {
            if !(key == "val"
                || name == "color"
                    && matches!(key.as_str(), "rgb" | "indexed" | "auto" | "theme" | "tint"))
                || value.len() > 256
                || value.chars().any(char::is_control)
            {
                return Err(HcdError::InvalidBundle(
                    "invalid XLSX run property value".into(),
                ));
            }
        }
        let val = attributes.get("val").map(String::as_str);
        let valid = match name.as_str() {
            "b" | "i" | "strike" | "outline" | "shadow" | "condense" | "extend" => {
                val.is_none_or(|v| matches!(v, "0" | "1" | "false" | "true" | "off" | "on"))
            }
            "sz" => val.is_some_and(|v| {
                v.parse::<f64>()
                    .is_ok_and(|v| v.is_finite() && v > 0.0 && v <= 409.0)
            }),
            "rFont" => val.is_some_and(|v| !v.is_empty()),
            "charset" => val.is_some_and(|v| v.parse::<u8>().is_ok()),
            "family" => val.is_some_and(|v| v.parse::<u8>().is_ok_and(|v| v <= 5)),
            "u" => val.is_none_or(|v| {
                matches!(
                    v,
                    "single" | "double" | "singleAccounting" | "doubleAccounting" | "none"
                )
            }),
            "vertAlign" => {
                val.is_some_and(|v| matches!(v, "baseline" | "superscript" | "subscript"))
            }
            "scheme" => val.is_some_and(|v| matches!(v, "major" | "minor" | "none")),
            "color" => {
                !attributes.contains_key("val")
                    && attributes.iter().all(|(key, val)| match key.as_str() {
                        "rgb" => {
                            matches!(val.len(), 6 | 8) && val.bytes().all(|b| b.is_ascii_hexdigit())
                        }
                        "indexed" => val.parse::<u8>().is_ok_and(|v| v <= 65),
                        "theme" => val.parse::<u8>().is_ok_and(|v| v <= 11),
                        "tint" => val
                            .parse::<f64>()
                            .is_ok_and(|v| v.is_finite() && (-1.0..=1.0).contains(&v)),
                        "auto" => matches!(val.as_str(), "0" | "1" | "true" | "false"),
                        _ => false,
                    })
            }
            _ => true,
        };
        if !valid {
            return Err(HcdError::InvalidBundle(format!(
                "invalid XLSX run property {name}"
            )));
        }
    }
    Ok(())
}

impl XlsxInlineRun {
    pub fn css(&self) -> String {
        let mut css = Vec::new();
        let value = |key: &str| self.properties.get(key).and_then(|p| p.get("val"));
        let enabled =
            |key: &str| !matches!(value(key).map(String::as_str), Some("0" | "false" | "off"));
        if self.properties.contains_key("b") {
            css.push(format!(
                "font-weight:{}",
                if enabled("b") { "700" } else { "400" }
            ));
        }
        if self.properties.contains_key("i") {
            css.push(format!(
                "font-style:{}",
                if enabled("i") { "italic" } else { "normal" }
            ));
        }
        if let Some(size) = value("sz")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && (1.0..=409.0).contains(v))
        {
            css.push(format!("font-size:{size}pt"));
        }
        if let Some(font) = value("rFont").filter(|v| {
            !v.is_empty()
                && v.chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        }) {
            css.push(format!("font-family:'{font}'"));
        }
        if let Some(rgb) = self
            .properties
            .get("color")
            .and_then(|p| p.get("rgb"))
            .filter(|v| matches!(v.len(), 6 | 8) && v.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            css.push(format!("color:#{}", &rgb[rgb.len() - 6..]));
        }
        let mut decorations = Vec::new();
        if self.properties.contains_key("u") && value("u").map(String::as_str) != Some("none") {
            decorations.push("underline");
        }
        if self.properties.contains_key("strike") && enabled("strike") {
            decorations.push("line-through");
        }
        if !decorations.is_empty()
            || self.properties.contains_key("u")
            || self.properties.contains_key("strike")
        {
            css.push(format!(
                "text-decoration:{}",
                if decorations.is_empty() {
                    "none".into()
                } else {
                    decorations.join(" ")
                }
            ));
        }
        if let Some(align) = value("vertAlign") {
            match align.as_str() {
                "superscript" => css.push("vertical-align:super".into()),
                "subscript" => css.push("vertical-align:sub".into()),
                "baseline" => css.push("vertical-align:baseline".into()),
                _ => {}
            }
        }
        css.join(";")
    }
}

pub fn render_xlsx_inline_runs(runs: &[XlsxInlineRun]) -> Result<String, HcdError> {
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let mut html = String::new();
    for run in runs {
        validate_xlsx_run_properties(&run.properties)?;
        let metadata = serde_json::to_string(&run.properties)?;
        html.push_str(&format!(
            "<span data-hcd-xlsx-run=\"{}\" style=\"{}\">{}</span>",
            escape(&metadata),
            escape(&run.css()),
            escape(&run.text)
        ));
    }
    Ok(html)
}

pub fn extract_xlsx_inline_runs(
    html: &str,
) -> Result<BTreeMap<String, Vec<XlsxInlineRun>>, HcdError> {
    if !html.contains("data-hcd-xlsx-run=") {
        return Ok(BTreeMap::new());
    }
    let mut reader = Reader::from_str(html);
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut anchor: Option<(String, usize)> = None;
    let mut active: Option<XlsxInlineRun> = None;
    let mut output: BTreeMap<String, Vec<XlsxInlineRun>> = BTreeMap::new();
    loop {
        match reader
            .read_event()
            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
        {
            Event::Start(start) => {
                if active.is_some() {
                    return Err(HcdError::InvalidBundle("nested XLSX run markup".into()));
                }
                depth += 1;
                let attrs: BTreeMap<String, String> = start
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
                        Ok((
                            String::from_utf8_lossy(a.key.as_ref()).into_owned(),
                            a.unescape_value()
                                .map_err(|e| HcdError::InvalidBundle(e.to_string()))?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_, HcdError>>()?;
                if attrs.contains_key("data-hcd-node-hash") {
                    anchor = attrs.get("data-hcd-id").map(|id| (id.clone(), depth));
                }
                if let Some(metadata) = attrs.get("data-hcd-xlsx-run") {
                    if start.name().as_ref() != b"span" || anchor.is_none() || metadata.len() > 8192
                    {
                        return Err(HcdError::InvalidBundle("invalid XLSX run marker".into()));
                    }
                    let properties = serde_json::from_str(metadata)?;
                    validate_xlsx_run_properties(&properties)?;
                    active = Some(XlsxInlineRun {
                        text: String::new(),
                        properties,
                    });
                }
            }
            Event::Text(text) => {
                if let Some(run) = &mut active {
                    run.text.push_str(
                        &text
                            .unescape()
                            .map_err(|e| HcdError::InvalidBundle(e.to_string()))?,
                    );
                }
            }
            Event::Empty(start) => {
                if active.is_some()
                    || start
                        .attributes()
                        .any(|a| a.is_ok_and(|a| a.key.as_ref() == b"data-hcd-xlsx-run"))
                {
                    return Err(HcdError::InvalidBundle(
                        "invalid empty or nested XLSX run".into(),
                    ));
                }
            }
            Event::End(_) => {
                if let Some(run) = active.take() {
                    let id = &anchor
                        .as_ref()
                        .ok_or_else(|| HcdError::InvalidBundle("XLSX run lost anchor".into()))?
                        .0;
                    output.entry(id.clone()).or_default().push(run);
                }
                if anchor.as_ref().is_some_and(|(_, d)| *d == depth) {
                    anchor = None;
                }
                depth = depth.saturating_sub(1);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if active.is_some() || depth != 0 {
        return Err(HcdError::InvalidBundle("unclosed XLSX run markup".into()));
    }
    let nodes = crate::extract_html_text_nodes(html)?;
    for (id, runs) in &output {
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        if nodes.get(id) != Some(&text) {
            return Err(HcdError::InvalidBundle(
                "XLSX runs do not match cell text".into(),
            ));
        }
    }
    Ok(output)
}

pub fn splice_xlsx_inline_runs(
    runs: &[XlsxInlineRun],
    start: usize,
    delete_count: usize,
    inserted: &str,
) -> Vec<XlsxInlineRun> {
    let end = start + delete_count;
    let mut offset = 0usize;
    let mut placed = false;
    let mut result: Vec<_> = runs
        .iter()
        .map(|run| {
            let chars: Vec<char> = run.text.chars().collect();
            let mut text: String = chars[..start.saturating_sub(offset).min(chars.len())]
                .iter()
                .collect();
            if !placed
                && (start < offset + chars.len()
                    || delete_count == 0 && start == offset + chars.len())
            {
                text.push_str(inserted);
                placed = true;
            }
            text.extend(chars[end.saturating_sub(offset).min(chars.len())..].iter());
            offset += chars.len();
            XlsxInlineRun {
                text,
                properties: run.properties.clone(),
            }
        })
        .collect();
    if result.iter().any(|run| !run.text.is_empty()) {
        result.retain(|run| !run.text.is_empty());
    } else {
        result.truncate(1);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_cell_scalar_splices_retain_independent_native_properties() {
        let runs = vec![
            XlsxInlineRun {
                text: "同名😀".into(),
                properties: BTreeMap::from([("b".into(), BTreeMap::new())]),
            },
            XlsxInlineRun {
                text: "同名😀".into(),
                properties: BTreeMap::from([
                    ("b".into(), BTreeMap::from([("val".into(), "0".into())])),
                    ("i".into(), BTreeMap::new()),
                ]),
            },
        ];
        let changed = splice_xlsx_inline_runs(&runs, 4, 1, "改");
        assert_eq!(changed[0].text, "同名😀");
        assert_eq!(changed[1].text, "同改😀");
        assert_eq!(changed[1].properties, runs[1].properties);
        let html = format!(
            "<p><span data-hcd-id=\"n_rich\" data-hcd-node-hash=\"hash\">{}</span></p>",
            render_xlsx_inline_runs(&changed).unwrap()
        );
        assert_eq!(extract_xlsx_inline_runs(&html).unwrap()["n_rich"], changed);
        assert!(html.contains("font-weight:400;font-style:italic"));
    }

    #[test]
    fn rich_cell_metadata_rejects_xml_injection_invalid_values_and_missing_text() {
        for properties in [
            BTreeMap::from([("formula".into(), BTreeMap::new())]),
            BTreeMap::from([(
                "b".into(),
                BTreeMap::from([("val".into(), "invalid".into())]),
            )]),
            BTreeMap::from([("sz".into(), BTreeMap::from([("val".into(), "NaN".into())]))]),
            BTreeMap::from([(
                "color".into(),
                BTreeMap::from([("rgb".into(), "<bad/>".into())]),
            )]),
        ] {
            assert!(validate_xlsx_run_properties(&properties).is_err());
        }
        let valid = render_xlsx_inline_runs(&[XlsxInlineRun {
            text: "safe".into(),
            properties: BTreeMap::new(),
        }])
        .unwrap();
        assert!(extract_xlsx_inline_runs(&format!("<p>{valid}</p>")).is_err());
        assert!(extract_xlsx_inline_runs(&format!(
            "<span data-hcd-id=\"n_rich\" data-hcd-node-hash=\"h\">missing{valid}</span>"
        ))
        .is_err());
        assert!(extract_xlsx_inline_runs(&format!(
            "<span data-hcd-id=\"n_rich\" data-hcd-node-hash=\"h\">{}</span>",
            valid.replace("safe", "<b>safe</b>")
        ))
        .is_err());
    }
}
