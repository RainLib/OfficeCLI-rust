//! Built-in inert inline atoms for user-created Word numeric fields. Existing
//! imported opaque fields keep their original representation and protection.
use crate::{
    ExtensionDisplay, ExtensionFallback, ExtensionNode, HcdError, NodeExportBlock, NodeExportRun,
    NodeExportSnapshot, NodeExportText, NODE_EXPORT_FORMATS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const WORD_NUMERIC_FIELD_TYPE: &str = "officecli.word.numeric_field";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WordNumericFieldKind {
    #[serde(rename = "PAGE")]
    Page,
    #[serde(rename = "NUMPAGES")]
    NumPages,
    #[serde(rename = "SECTIONPAGES")]
    SectionPages,
}
impl WordNumericFieldKind {
    pub fn instruction(self) -> &'static str {
        match self {
            Self::Page => "PAGE",
            Self::NumPages => "NUMPAGES",
            Self::SectionPages => "SECTIONPAGES",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordNumericFieldFormat {
    Inherit,
    Arabic,
    UpperRoman,
    LowerRoman,
    UpperLetter,
    LowerLetter,
}
impl WordNumericFieldFormat {
    fn switch(self) -> Option<&'static str> {
        match self {
            Self::Inherit => None,
            Self::Arabic => Some("Arabic"),
            Self::UpperRoman => Some("ROMAN"),
            Self::LowerRoman => Some("roman"),
            Self::UpperLetter => Some("ALPHABETIC"),
            Self::LowerLetter => Some("alphabetic"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordNumericField {
    pub kind: WordNumericFieldKind,
    pub format: WordNumericFieldFormat,
}
impl WordNumericField {
    pub fn instruction(self) -> String {
        let command = self.kind.instruction();
        match self.format.switch() {
            Some(format) => format!("{command} \\* {format}"),
            None => command.into(),
        }
    }
    /// A readable token, never an invented page count. Layout engines may
    /// render a local computed view without changing this canonical fallback.
    pub fn fallback(self) -> String {
        format!("[{}]", self.kind.instruction())
    }
    pub fn exports(self) -> BTreeMap<String, NodeExportSnapshot> {
        NODE_EXPORT_FORMATS
            .into_iter()
            .map(|format| {
                (
                    format.into(),
                    NodeExportSnapshot {
                        support: if format == "docx" {
                            "semantic"
                        } else {
                            "static"
                        }
                        .into(),
                        include_content: None,
                        blocks: vec![NodeExportBlock {
                            kind: "paragraph".into(),
                            level: None,
                            runs: vec![NodeExportRun::Text(NodeExportText {
                                text: self.fallback(),
                                bold: false,
                                italic: false,
                                underline: false,
                                strike: false,
                            })],
                        }],
                    },
                )
            })
            .collect()
    }
    pub fn node(self, instance_id: String) -> ExtensionNode {
        ExtensionNode {
            schema_version: "hcd.extension/2".into(),
            instance_id,
            node_type: WORD_NUMERIC_FIELD_TYPE.into(),
            version: 1,
            display: ExtensionDisplay::Inline,
            data: serde_json::to_value(self).expect("enum-only Word field data"),
            fallback: ExtensionFallback {
                text: self.fallback(),
            },
            resources: Vec::new(),
            content_model: None,
            exports: self.exports(),
        }
    }
}

/// Version 1 has an exact business contract. Unknown future versions remain
/// inert generic envelopes; they are never interpreted as executable codes.
pub fn read_word_numeric_field(node: &ExtensionNode) -> Result<Option<WordNumericField>, HcdError> {
    if node.node_type != WORD_NUMERIC_FIELD_TYPE || node.version != 1 {
        return Ok(None);
    }
    let data: WordNumericField = serde_json::from_value(node.data.clone())?;
    if node.schema_version != "hcd.extension/2"
        || node.display != ExtensionDisplay::Inline
        || node.content_model.is_some()
        || !node.resources.is_empty()
        || node.fallback.text != data.fallback()
        || node.exports != data.exports()
    {
        return Err(HcdError::InvalidPatch(
            "invalid built-in Word numeric field".into(),
        ));
    }
    Ok(Some(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_fields_have_bounded_instructions_and_explicit_static_fallbacks() {
        for kind in [
            WordNumericFieldKind::Page,
            WordNumericFieldKind::NumPages,
            WordNumericFieldKind::SectionPages,
        ] {
            for (format, suffix) in [
                (WordNumericFieldFormat::Inherit, ""),
                (WordNumericFieldFormat::Arabic, " \\* Arabic"),
                (WordNumericFieldFormat::UpperRoman, " \\* ROMAN"),
                (WordNumericFieldFormat::LowerRoman, " \\* roman"),
                (WordNumericFieldFormat::UpperLetter, " \\* ALPHABETIC"),
                (WordNumericFieldFormat::LowerLetter, " \\* alphabetic"),
            ] {
                let field = WordNumericField { kind, format };
                let node = field.node(format!("x_{:032x}", 1));
                node.validate().unwrap();
                assert_eq!(read_word_numeric_field(&node).unwrap(), Some(field));
                assert_eq!(
                    field.instruction(),
                    format!("{}{suffix}", kind.instruction())
                );
                assert_eq!(node.exports["docx"].support, "semantic");
                assert_eq!(node.exports["html"].support, "static");
                assert_eq!(node.fallback.text, format!("[{}]", kind.instruction()));
            }
        }
    }
    #[test]
    fn built_in_field_contract_refuses_spoofed_data_cache_and_export_claims() {
        let field = WordNumericField {
            kind: WordNumericFieldKind::Page,
            format: WordNumericFieldFormat::Inherit,
        };
        let original = field.node(format!("x_{:032x}", 2));
        for data in [
            serde_json::json!({"kind":"DDE","format":"inherit"}),
            serde_json::json!({"kind":"PAGE","format":"CHARFORMAT"}),
            serde_json::json!({"kind":"PAGE","format":"inherit","instruction":"INCLUDETEXT file"}),
        ] {
            let mut node = original.clone();
            node.data = data;
            assert!(node.validate().is_err());
        }
        let mut node = original.clone();
        node.fallback.text = "99".into();
        assert!(node.validate().is_err());
        let mut node = original.clone();
        node.display = ExtensionDisplay::Block;
        assert!(node.validate().is_err());
        let mut node = original.clone();
        node.exports.remove("txt");
        assert!(node.validate().is_err());
        let mut node = original.clone();
        node.exports.get_mut("docx").unwrap().support = "unsupported".into();
        assert!(node.validate().is_err());
        let mut node = original.clone();
        node.schema_version = "hcd.extension/1".into();
        assert!(node.validate().is_err());
    }
    #[test]
    fn unknown_future_field_version_stays_generic_and_inert() {
        let mut node = WordNumericField {
            kind: WordNumericFieldKind::Page,
            format: WordNumericFieldFormat::Inherit,
        }
        .node(format!("x_{:032x}", 3));
        node.version = 2;
        node.data = serde_json::json!({"future":"opaque"});
        node.validate().unwrap();
        assert_eq!(read_word_numeric_field(&node).unwrap(), None);
    }
}
