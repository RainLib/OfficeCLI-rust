//! Portable extension dependencies and export snapshots. No executable code or URLs.
use crate::HcdError;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeResource {
    pub key: String,
    pub hash: String,
    pub byte_length: u64,
    pub name: String,
    pub media_type: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeExportSnapshot {
    pub support: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_content: Option<bool>,
    pub blocks: Vec<NodeExportBlock>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeExportBlock {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub runs: Vec<NodeExportRun>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NodeExportRun {
    Text(NodeExportText),
    Image(NodeExportImage),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeExportText {
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strike: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeExportImage {
    pub resource: String,
    pub alt: String,
    pub width_pt: f64,
    pub height_pt: f64,
}
pub const NODE_EXPORT_FORMATS: [&str; 7] = ["docx", "xlsx", "pptx", "pdf", "html", "md", "txt"];
fn text(value: &str, limit: usize) -> bool {
    value.len() <= limit
        && !value
            .chars()
            .any(|c| matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 0xfffe | 0xffff))
}
fn invalid() -> HcdError {
    HcdError::InvalidPatch("invalid portable extension resource/export snapshot".into())
}
pub fn validate_node_portable(
    resources: &[NodeResource],
    exports: &BTreeMap<String, NodeExportSnapshot>,
    inline: bool,
    container: bool,
) -> Result<(), HcdError> {
    if resources.len() > 16 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for r in resources {
        if r.key.is_empty()
            || r.key.len() > 64
            || !r.key.as_bytes()[0].is_ascii_lowercase()
            || !r
                .key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || !seen.insert(&r.key)
            || r.hash.len() != 64
            || !r
                .hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || r.byte_length == 0
            || r.byte_length > 8 * 1024 * 1024
            || !text(&r.name, 256)
            || r.name.trim().is_empty()
            || r.name.contains(['\r', '\n', '\t', '/', '\\'])
            || r.media_type.len() > 128
            || r.media_type.split('/').count() != 2
            || !r.media_type.split('/').all(|p| {
                !p.is_empty()
                    && p.as_bytes()[0].is_ascii_alphanumeric()
                    && p.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b".+-".contains(&b)
                    })
            })
        {
            return Err(invalid());
        }
    }
    let (mut count, mut bytes) = (0, 0);
    for (format, snapshot) in exports {
        if !NODE_EXPORT_FORMATS.contains(&format.as_str())
            || !["semantic", "static", "unsupported"].contains(&snapshot.support.as_str())
            || snapshot.blocks.len() > 64
            || snapshot.support == "unsupported" && !snapshot.blocks.is_empty()
            || snapshot.support != "unsupported" && snapshot.blocks.is_empty() && !container
            || snapshot.include_content == Some(false)
            || !container && snapshot.include_content.is_some()
            || container
                && snapshot.support != "unsupported"
                && snapshot.include_content != Some(true)
            || inline
                && (snapshot.blocks.len() > 1
                    || snapshot
                        .blocks
                        .first()
                        .is_some_and(|b| b.kind != "paragraph"))
        {
            return Err(invalid());
        }
        for b in &snapshot.blocks {
            if !["paragraph", "heading", "bullet"].contains(&b.kind.as_str())
                || (b.kind == "heading" && !b.level.is_some_and(|n| (1..=6).contains(&n)))
                || (b.kind != "heading" && b.level.is_some())
                || b.runs.is_empty()
            {
                return Err(invalid());
            }
            for run in &b.runs {
                count += 1;
                if count > 256 {
                    return Err(invalid());
                }
                match run {
                    NodeExportRun::Text(t) => {
                        if !text(&t.text, 16384) {
                            return Err(invalid());
                        }
                        bytes += t.text.len();
                    }
                    NodeExportRun::Image(i) => {
                        if !text(&i.alt, 1024)
                            || ![i.width_pt, i.height_pt]
                                .iter()
                                .all(|v| v.is_finite() && *v > 0.0 && *v <= 2000.0)
                            || !resources.iter().any(|r| {
                                r.key == i.resource
                                    && ["image/png", "image/jpeg", "image/gif", "image/webp"]
                                        .contains(&r.media_type.as_str())
                            })
                        {
                            return Err(invalid());
                        }
                    }
                }
            }
        }
    }
    if bytes > 32768 {
        return Err(invalid());
    }
    Ok(())
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
/// Replace only inert extension presentations on an export copy. Canonical HTML
/// and callbacks never change/run; a missing adapter keeps readable content.
pub fn adapt_extension_exports(html: &str, format: &str) -> Result<String, HcdError> {
    if !NODE_EXPORT_FORMATS.contains(&format) {
        return Err(invalid());
    }
    if !html.contains("data-hcd-extension=") {
        return Ok(html.to_owned());
    }
    let wrapped = format!("<root>{html}</root>");
    let doc =
        roxmltree::Document::parse(&wrapped).map_err(|e| HcdError::InvalidBundle(e.to_string()))?;
    let mut edits = Vec::new();
    for element in doc.descendants().filter(|n| n.is_element()) {
        let Some(raw) = element.attribute("data-hcd-extension") else {
            continue;
        };
        let node: crate::ExtensionNode = serde_json::from_str(raw)?;
        node.validate()?;
        let snapshot = node.exports.get(format);
        let container = node.content_model.is_some();
        if snapshot.is_none() && !container {
            continue;
        }
        if snapshot.is_some_and(|s| s.support == "unsupported") {
            return Err(HcdError::Unsupported(format!(
                "{} v{} cannot export as {format}",
                node.node_type, node.version
            )));
        }
        let mut result = String::new();
        if snapshot.is_none() && container && node.display == crate::ExtensionDisplay::Block {
            result.push_str(&format!(
                "<p><strong>{}</strong></p>",
                escape(&node.fallback.text)
            ));
        }
        for block in snapshot.into_iter().flat_map(|s| &s.blocks) {
            let tag = if node.display == crate::ExtensionDisplay::Inline {
                "span".to_owned()
            } else {
                match block.kind.as_str() {
                    "heading" => format!("h{}", block.level.unwrap_or(1)),
                    "bullet" => "li".into(),
                    _ => "p".into(),
                }
            };
            if block.kind == "bullet" {
                result.push_str("<ul>");
            }
            let media = if node.display == crate::ExtensionDisplay::Inline
                && block
                    .runs
                    .iter()
                    .any(|r| matches!(r, NodeExportRun::Image(_)))
            {
                " class=\"hcd-extension-export-media\""
            } else {
                ""
            };
            result.push_str(&format!("<{tag}{media}>"));
            for run in &block.runs {
                match run {
                    NodeExportRun::Text(t) => {
                        let mut text = escape(&t.text).replace('\n', "<br/>");
                        for (enabled, tag) in [
                            (t.bold, "strong"),
                            (t.italic, "em"),
                            (t.underline, "u"),
                            (t.strike, "s"),
                        ] {
                            if enabled {
                                text = format!("<{tag}>{text}</{tag}>");
                            }
                        }
                        result.push_str(&text);
                    }
                    NodeExportRun::Image(i) => {
                        let r = node
                            .resources
                            .iter()
                            .find(|r| r.key == i.resource)
                            .ok_or_else(invalid)?;
                        if ["md", "txt"].contains(&format)
                            || format == "pdf"
                                && !["image/png", "image/jpeg"].contains(&r.media_type.as_str())
                        {
                            result.push_str(&format!(
                                "<span>{} ({})</span>",
                                escape(&i.alt),
                                escape(&r.name)
                            ));
                        } else {
                            result.push_str(&format!("<img src=\"asset://sha256/{}\" alt=\"{}\" style=\"width:{}pt;height:{}pt\"/>",r.hash,escape(&i.alt),i.width_pt,i.height_pt));
                        }
                    }
                }
            }
            result.push_str(&format!("</{tag}>"));
            if block.kind == "bullet" {
                result.push_str("</ul>");
            }
        }
        if container {
            let children: Vec<_> = element.children().collect();
            if let (Some(first), Some(last)) = (children.first(), children.last()) {
                result.push_str(&adapt_extension_exports(
                    &wrapped[first.range().start..last.range().end],
                    format,
                )?);
            }
        }
        // A typed built-in field has dynamic DOCX semantics. Never copy an
        // arbitrary instruction from business JSON or trust a snapshot as code.
        if format == "docx" {
            if let Some(field) = crate::read_word_numeric_field(&node)? {
                result = format!(
                    "<span data-hcd-numeric-field-start=\"{}\" data-hcd-numeric-field=\"{}\"></span>{result}<span data-hcd-numeric-field-end=\"{}\"></span>",
                    escape(&node.instance_id), escape(&serde_json::to_string(&field)?), escape(&node.instance_id)
                );
            }
        }
        if format == "html" {
            let tag = if node.display == crate::ExtensionDisplay::Inline {
                "span"
            } else {
                "div"
            };
            result = format!(
                "<{tag} data-hcd-extension=\"{}\">{result}</{tag}>",
                escape(raw)
            );
        }
        let range = element.range();
        edits.push((range.start - 6, range.end - 6, result));
    }
    edits.sort_by_key(|e| e.0);
    let mut result = String::new();
    let mut cursor = 0;
    for (start, end, value) in edits {
        if start < cursor {
            continue;
        }
        result.push_str(&html[cursor..start]);
        result.push_str(&value);
        cursor = end;
    }
    result.push_str(&html[cursor..]);
    Ok(result)
}

/// Verify image claims before a resource can become a canonical dependency.
pub fn validate_node_resource_asset(
    bundle: &crate::Bundle,
    resource: &NodeResource,
    asset: &crate::AssetDescriptor,
) -> Result<(), HcdError> {
    use std::io::Read;
    if resource.byte_length != asset.byte_length {
        return Err(invalid());
    }
    let mut file = std::fs::File::open(bundle.resolve_href(&asset.href)?)?;
    let mut prefix = [0u8; 16];
    let length = file.read(&mut prefix)?;
    let bytes = &prefix[..length];
    let valid = match resource.media_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => true,
    };
    if !valid {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node() -> crate::ExtensionNode {
        serde_json::from_value(serde_json::json!({"schemaVersion":"hcd.extension/2","instanceId":format!("x_{:032x}",1),"type":"example.card","version":1,"display":"block","data":{"private":"kept"},"fallback":{"text":"fallback"},"resources":[{"key":"photo","hash":"a".repeat(64),"byteLength":4,"name":"image.png","mediaType":"image/png"}],"exports":{"docx":{"support":"semantic","blocks":[{"kind":"paragraph","runs":[{"text":"Adapted <&","bold":true},{"resource":"photo","alt":"Photo","widthPt":32,"heightPt":24}]}]},"pdf":{"support":"unsupported","blocks":[]}}})).unwrap()
    }
    #[test]
    fn portable_snapshot_is_inert_bounded_and_format_specific() {
        let mut n = node();
        n.validate().unwrap();
        let raw = serde_json::to_string(&n).unwrap();
        let html = format!("<p data-hcd-extension=\"{}\">fallback</p>", escape(&raw));
        let output = adapt_extension_exports(&html, "docx").unwrap();
        assert!(output.contains("<strong>Adapted &lt;&amp;</strong>"));
        assert!(output.contains("asset://sha256/"));
        assert!(!output.contains("private"));
        assert!(adapt_extension_exports(&html, "pdf").is_err());
        assert_eq!(adapt_extension_exports(&html, "md").unwrap(), html);
        n.resources[0].hash = "../invalid".into();
        assert!(n.validate().is_err());
    }
    #[test]
    fn containers_cannot_replace_their_editable_children_with_a_stale_snapshot() {
        let mut n = node();
        n.content_model = Some("blocks".into());
        assert!(n.validate().is_err());
        n.exports.clear();
        n.validate().unwrap();
        n.schema_version = "hcd.extension/1".into();
        assert!(n.validate().is_err());
    }
    #[test]
    fn container_adapters_append_live_children_and_default_exports_keep_the_title() {
        let mut n = node();
        n.content_model = Some("blocks".into());
        n.resources.clear();
        n.exports.clear();
        let make = |n: &crate::ExtensionNode, body: &str| {
            format!(
                "<div data-hcd-extension=\"{}\"><p>{body}</p></div>",
                escape(&serde_json::to_string(n).unwrap())
            )
        };
        let html = make(&n, "Live body");
        let output = adapt_extension_exports(&html, "docx").unwrap();
        assert_eq!(output.matches("Live body").count(), 1);
        assert!(output.contains("<strong>fallback</strong>"));
        n.exports.insert("docx".into(),serde_json::from_value(serde_json::json!({"support":"semantic","includeContent":true,"blocks":[{"kind":"heading","level":2,"runs":[{"text":"Portable title"}]}]})).unwrap());
        n.validate().unwrap();
        let output = adapt_extension_exports(&make(&n, "Peer updated body"), "docx").unwrap();
        assert!(output.contains("Portable title"));
        assert_eq!(output.matches("Peer updated body").count(), 1);
        assert!(!output.contains("Live body"));
    }

    #[test]
    fn plain_text_targets_use_readable_resource_labels_instead_of_dangling_node_image_urls() {
        let mut n = node();
        n.exports.insert("md".into(), n.exports["docx"].clone());
        let html = format!(
            "<p data-hcd-extension=\"{}\">fallback</p>",
            escape(&serde_json::to_string(&n).unwrap())
        );
        let out = adapt_extension_exports(&html, "md").unwrap();
        assert!(out.contains("Photo (image.png)"));
        assert!(!out.contains("asset://"));
    }

    #[test]
    fn unsupported_pdf_rasters_keep_readable_resource_descriptions() {
        let mut n = node();
        n.resources[0].media_type = "image/gif".into();
        n.resources[0].name = "poster.gif".into();
        n.exports.insert("pdf".into(), n.exports["docx"].clone());
        let html = format!(
            "<p data-hcd-extension=\"{}\">fallback</p>",
            escape(&serde_json::to_string(&n).unwrap())
        );
        let out = adapt_extension_exports(&html, "pdf").unwrap();
        assert!(out.contains("Photo (poster.gif)"));
        assert!(!out.contains("<img"));
    }

    #[test]
    fn image_references_and_export_formats_fail_closed() {
        let mut n = node();
        if let NodeExportRun::Image(i) = &mut n.exports.get_mut("docx").unwrap().blocks[0].runs[1] {
            i.resource = "missing".into();
        }
        assert!(n.validate().is_err());
        let mut n = node();
        n.exports.insert("exe".into(), n.exports["docx"].clone());
        assert!(n.validate().is_err());
        let mut n = node();
        n.resources.push(n.resources[0].clone());
        assert!(n.validate().is_err());
    }
}
