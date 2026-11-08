//! Versioned, inert extension envelopes. Native storage never runs host code.
use crate::{EditorBlockContent, EditorBlockKind, EditorProjection, HcdError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// Inert feature discovery for archive/model validation, never a substring
/// interpretation of business JSON, comments or visible text.
pub(crate) fn html_has_inline_containers(html: &str) -> Result<bool, HcdError> {
    if !html.contains("hcd.extension/3") {
        return Ok(false);
    }
    let mut reader = quick_xml::Reader::from_str(html);
    loop {
        match reader
            .read_event()
            .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
        {
            quick_xml::events::Event::Start(element) | quick_xml::events::Event::Empty(element) => {
                if let Some(attribute) = element
                    .try_get_attribute("data-hcd-extension")
                    .map_err(|error| HcdError::InvalidBundle(error.to_string()))?
                {
                    let raw = attribute
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|error| HcdError::InvalidBundle(error.to_string()))?;
                    let node: ExtensionNode = serde_json::from_str(&raw)?;
                    node.validate()?;
                    if node.envelope_version() == 3 {
                        return Ok(true);
                    }
                }
            }
            quick_xml::events::Event::Eof => return Ok(false),
            _ => (),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionDisplay {
    Inline,
    Block,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionNode {
    pub schema_version: String,
    pub instance_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub version: u32,
    pub display: ExtensionDisplay,
    pub data: Value,
    pub fallback: ExtensionFallback,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<crate::NodeResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_model: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub exports: std::collections::BTreeMap<String, crate::NodeExportSnapshot>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionFallback {
    pub text: String,
}
impl ExtensionNode {
    pub fn envelope_version(&self) -> u32 {
        match self.schema_version.as_str() {
            "hcd.extension/3" => 3,
            "hcd.extension/2" => 2,
            _ => 1,
        }
    }
    pub fn validate(&self) -> Result<(), HcdError> {
        let id = self.instance_id.strip_prefix("x_").unwrap_or("");
        let valid_part = |part: &str| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_lowercase()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        };
        if !["hcd.extension/1", "hcd.extension/2", "hcd.extension/3"]
            .contains(&self.schema_version.as_str())
            || id.len() != 32
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.version == 0
            || self.node_type.len() > 128
            || !self.node_type.contains('.')
            || !self.node_type.split('.').all(valid_part)
            || self.node_type.starts_with("hcd.")
            || !self.data.is_object()
            || self.fallback.text.trim().is_empty()
            || self.fallback.text.len() > 16384
            || self
                .fallback
                .text
                .chars()
                .any(|c| matches!(c as u32,0..=8|11..=12|14..=31|0xFFFE|0xFFFF))
            || self.display == ExtensionDisplay::Inline
                && self.fallback.text.contains(['\n', '\r', '\t'])
        {
            return Err(HcdError::InvalidPatch(
                "invalid extension envelope or readable fallback".into(),
            ));
        }
        if self.schema_version == "hcd.extension/1"
            && (!self.resources.is_empty()
                || self.content_model.is_some()
                || !self.exports.is_empty())
            || if self.schema_version == "hcd.extension/3" {
                self.content_model.as_deref() != Some("inline")
                    || self.display != ExtensionDisplay::Inline
            } else {
                self.content_model
                    .as_ref()
                    .is_some_and(|m| m != "blocks" || self.display != ExtensionDisplay::Block)
            }
        {
            return Err(HcdError::InvalidPatch(
                "invalid extension portable model".into(),
            ));
        }
        crate::validate_node_portable(
            &self.resources,
            &self.exports,
            self.display == ExtensionDisplay::Inline,
            self.content_model.is_some(),
        )?;
        crate::read_word_numeric_field(self)?;
        let mut remaining = 1024;
        validate_data(&self.data, 0, &mut remaining)?;
        if serde_json::to_vec(self)?.len() > 65536 {
            return Err(HcdError::ResourceLimit(
                "extension envelope exceeds 64 KiB".into(),
            ));
        }
        Ok(())
    }
}
fn validate_data(value: &Value, depth: usize, remaining: &mut usize) -> Result<(), HcdError> {
    if depth > 16 || *remaining == 0 {
        return Err(HcdError::ResourceLimit(
            "extension data exceeds depth/value limits".into(),
        ));
    }
    *remaining -= 1;
    match value {
        Value::Number(n)
            if n.as_f64()
                .is_none_or(|n| !n.is_finite() || n.abs() > 9007199254740991.0) =>
        {
            return Err(HcdError::InvalidPatch(
                "extension number exceeds interoperable JSON range".into(),
            ))
        }
        Value::String(s) if s.chars().any(|c| matches!(c as u32, 0xFFFE | 0xFFFF)) => {
            return Err(HcdError::InvalidPatch(
                "extension data contains an invalid XML scalar".into(),
            ))
        }
        Value::Object(items) => {
            for (key, value) in items {
                if matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                    || key.len() > 256
                    || key
                        .chars()
                        .any(|c| c.is_control() || matches!(c as u32, 0xFFFE | 0xFFFF))
                {
                    return Err(HcdError::InvalidPatch("invalid extension data key".into()));
                }
                validate_data(value, depth + 1, remaining)?
            }
        }
        Value::Array(items) => {
            for value in items {
                validate_data(value, depth + 1, remaining)?
            }
        }
        _ => {}
    }
    Ok(())
}
/// Clone envelopes without interpreting an unavailable business schema.
pub fn content_extensions(content: &EditorBlockContent) -> Result<Vec<ExtensionNode>, HcdError> {
    fn visit(
        content: &EditorBlockContent,
        depth: usize,
        items: &mut Vec<ExtensionNode>,
        inline_container: bool,
    ) -> Result<(), HcdError> {
        if depth > 24 || items.len() > 10000 {
            return Err(HcdError::ResourceLimit(
                "extension tree exceeds limits".into(),
            ));
        }
        if let Some(node) = &content.extension {
            node.validate()?;
            if node.display
                != if inline_container {
                    ExtensionDisplay::Inline
                } else {
                    ExtensionDisplay::Block
                }
                || content.kind != EditorBlockKind::Extension
                || if inline_container {
                    node.content_model.as_deref() != Some("inline") || !content.children.is_empty()
                } else if node.content_model.as_deref() == Some("blocks") {
                    content.children.is_empty() || !content.inlines.is_empty()
                } else {
                    !content.children.is_empty()
                        || content.inlines.len() != 1
                        || content.inlines[0].text != node.fallback.text
                        || content.inlines[0].extension.is_some()
                        || content.inlines[0].reference.is_some()
                }
            {
                return Err(HcdError::InvalidPatch(
                    "block extension fallback does not match its envelope".into(),
                ));
            }
            items.push(node.clone());
        } else if content.kind == EditorBlockKind::Extension {
            return Err(HcdError::InvalidPatch(
                "extension block has no envelope".into(),
            ));
        }
        for inline in &content.inlines {
            if let Some(body) = &inline.content {
                visit(body, depth + 1, items, true)?;
            }
            if let Some(node) = &inline.extension {
                node.validate()?;
                if node.display != ExtensionDisplay::Inline
                    || node.content_model.is_some()
                    || inline.text != node.fallback.text
                    || inline.reference.is_some()
                    || inline.hard_break
                    || inline.code
                    || inline.link.is_some()
                    || content.kind == EditorBlockKind::CodeBlock
                {
                    return Err(HcdError::InvalidPatch(
                        "inline extension fallback/marks are incompatible".into(),
                    ));
                }
                items.push(node.clone())
            }
        }
        for child in &content.children {
            visit(child, depth + 1, items, false)?
        }
        Ok(())
    }
    let mut result = Vec::new();
    visit(content, 0, &mut result, false)?;
    Ok(result)
}
pub fn projection_extensions(
    projection: &EditorProjection,
) -> Result<Vec<ExtensionNode>, HcdError> {
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    for block in &projection.blocks {
        for node in content_extensions(&block.content)? {
            if result.len() >= 10000 || !ids.insert(node.instance_id.clone()) {
                return Err(HcdError::InvalidPatch(
                    "duplicate or excessive extension identities".into(),
                ));
            }
            result.push(node)
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editable_inline_container_keeps_body_outside_business_data() {
        let block: EditorBlockContent = serde_json::from_value(serde_json::json!({
            "kind":"paragraph", "inlines":[
                {"text":"Before "},
                {"text":"", "content":{"kind":"extension", "extension":{
                    "schemaVersion":"hcd.extension/3", "instanceId":format!("x_{:032x}",27),
                    "type":"example.editable", "version":77, "display":"inline",
                    "contentModel":"inline", "data":{"project":"P-27"},
                    "fallback":{"text":"Editable field"}
                }, "inlines":[{"text":"Shared 中😀", "bold":true}]}},
                {"text":" after"}
            ]
        }))
        .unwrap();
        let nodes = content_extensions(&block).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].data, serde_json::json!({"project":"P-27"}));
        assert_eq!(nodes[0].content_model.as_deref(), Some("inline"));
    }

    #[test]
    fn extension_envelope_is_bounded_and_does_not_require_the_business_codec() {
        let mut node:ExtensionNode=serde_json::from_value(serde_json::json!({"schemaVersion":"hcd.extension/1","instanceId":format!("x_{:032x}",1),"type":"unknown.business","version":999,"display":"inline","data":{"future":[1,true,null,"💬"]},"fallback":{"text":"Readable fallback"}})).unwrap();
        node.validate().unwrap();
        node.data = serde_json::json!({"__proto__":{"polluted":true}});
        assert!(node.validate().is_err());
        node.data = serde_json::json!({"id":9007199254740992_u64});
        assert!(node.validate().is_err());
        node.data = serde_json::json!({"text":"x".repeat(65536)});
        assert!(node.validate().is_err());
        node.data = serde_json::json!({});
        node.fallback.text = "A\nB".into();
        assert!(node.validate().is_err());
        node.display = ExtensionDisplay::Block;
        node.validate().unwrap();
        node.schema_version = "hcd.extension/2".into();
        node.validate().unwrap();
        node.schema_version = "hcd.extension/3".into();
        assert!(node.validate().is_err());
    }
}
