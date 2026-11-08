//! Inert custom text formatting; document text is never replaced by a fallback.
use crate::{
    EditorBlockContent, EditorBlockKind, ExtensionDisplay, ExtensionFallback, ExtensionNode,
    HcdError,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomTextMark {
    pub schema_version: String,
    #[serde(rename = "type")]
    pub mark_type: String,
    pub version: u32,
    pub data: serde_json::Value,
    pub fallback: CustomMarkFallback,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomMarkFallback {
    pub label: String,
    pub style: CustomMarkStyle,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomMarkStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
}
impl CustomTextMark {
    pub fn validate(&self) -> Result<(), HcdError> {
        if self.schema_version != "hcd.mark/1" || self.fallback.label.len() > 256 {
            return Err(HcdError::InvalidPatch(
                "unsupported custom text mark".into(),
            ));
        }
        ExtensionNode {
            schema_version: "hcd.extension/1".into(),
            instance_id: format!("x_{}", "0".repeat(32)),
            node_type: self.mark_type.clone(),
            version: self.version,
            display: ExtensionDisplay::Inline,
            data: self.data.clone(),
            fallback: ExtensionFallback {
                text: self.fallback.label.clone(),
            },
            resources: vec![],
            content_model: None,
            exports: Default::default(),
        }
        .validate()?;
        let s = &self.fallback.style;
        if [s.bold, s.italic, s.underline, s.strike].contains(&Some(false))
            || [&s.text_color, &s.background_color]
                .into_iter()
                .flatten()
                .any(|c| {
                    c.len() != 7
                        || !c.starts_with('#')
                        || !c[1..]
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
        {
            return Err(HcdError::InvalidPatch(
                "invalid custom text mark style".into(),
            ));
        }
        if serde_json::to_vec(self)?.len() > 65536 {
            return Err(HcdError::ResourceLimit(
                "custom text mark exceeds 64 KiB".into(),
            ));
        }
        Ok(())
    }
    pub fn css(&self) -> String {
        let s = &self.fallback.style;
        let mut css = String::new();
        if s.bold == Some(true) {
            css.push_str("font-weight:700;")
        }
        if s.italic == Some(true) {
            css.push_str("font-style:italic;")
        }
        if s.underline == Some(true) || s.strike == Some(true) {
            css.push_str("text-decoration:");
            if s.underline == Some(true) {
                css.push_str("underline ")
            };
            if s.strike == Some(true) {
                css.push_str("line-through ")
            };
            css.push(';')
        }
        if let Some(c) = &s.text_color {
            css.push_str(&format!("color:{c};"))
        }
        if let Some(c) = &s.background_color {
            css.push_str(&format!("background-color:{c};"))
        }
        css
    }
}
pub fn validate_custom_marks(marks: &[CustomTextMark]) -> Result<(), HcdError> {
    if marks.len() > 8 {
        return Err(HcdError::ResourceLimit("too many custom text marks".into()));
    }
    let mut types = HashSet::new();
    let mut previous: Option<&str> = None;
    for mark in marks {
        mark.validate()?;
        if !types.insert(&mark.mark_type)
            || previous.is_some_and(|old| old >= mark.mark_type.as_str())
        {
            return Err(HcdError::InvalidPatch(
                "custom text marks must have unique sorted types".into(),
            ));
        };
        previous = Some(&mark.mark_type)
    }
    Ok(())
}
pub fn content_custom_marks(content: &EditorBlockContent) -> Result<bool, HcdError> {
    let mut found = false;
    for inline in &content.inlines {
        if let Some(content) = &inline.content {
            found |= content_custom_marks(content)?;
        }
        validate_custom_marks(&inline.custom_marks)?;
        if !inline.custom_marks.is_empty() {
            if inline.extension.is_some()
                || inline.reference.is_some()
                || inline.hard_break
                || content.kind == EditorBlockKind::CodeBlock
            {
                return Err(HcdError::InvalidPatch(
                    "custom text marks require ordinary inline text".into(),
                ));
            };
            found = true
        }
    }
    for child in &content.children {
        found |= content_custom_marks(child)?
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mark() -> CustomTextMark {
        serde_json::from_value(serde_json::json!({"schemaVersion":"hcd.mark/1","type":"example.review","version":1,"data":{"future":{"ticket":"T-1"}},"fallback":{"label":"待复核","style":{"underline":true,"textColor":"#123abc"}}})).unwrap()
    }
    #[test]
    fn custom_mark_styles_and_json_limits_refuse_code_unknown_fields_duplicate_types_and_atoms() {
        let value = mark();
        value.validate().unwrap();
        assert!(value.css().contains("underline"));
        assert!(validate_custom_marks(&[value.clone(), value.clone()]).is_err());
        for (key, bad) in [
            ("schemaVersion", serde_json::json!("hcd.mark/2")),
            ("type", serde_json::json!("hcd.internal")),
            ("data", serde_json::json!({"constructor":{}})),
            ("extra", serde_json::json!(true)),
        ] {
            let mut json = serde_json::to_value(&value).unwrap();
            json[key] = bad;
            assert!(serde_json::from_value::<CustomTextMark>(json)
                .and_then(|v| v.validate().map_err(serde::de::Error::custom))
                .is_err())
        }
        let mut bad = value.clone();
        bad.fallback.style.bold = Some(false);
        assert!(bad.validate().is_err());
        bad = value.clone();
        bad.fallback.style.text_color = Some("#ABCDEF".into());
        assert!(bad.validate().is_err());
        let content = EditorBlockContent {
            kind: EditorBlockKind::CodeBlock,
            inlines: vec![crate::EditorInline {
                text: "code".into(),
                custom_marks: vec![value],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(content_custom_marks(&content).is_err());
    }
}
