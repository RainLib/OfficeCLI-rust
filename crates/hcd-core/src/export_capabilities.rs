//! Bounded business-node inventory for an immutable revision. Reads verified
//! chunks one at a time; neither a full editor projection nor host code runs.
use crate::{Bundle, ExtensionDisplay, ExtensionNode, HcdError, InlineReference};
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFeatureKind {
    ExtensionInline,
    ExtensionBlock,
    Reference,
    CustomMark,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFeatureInventory {
    pub kind: ExportFeatureKind,
    pub count: usize,
    pub examples: Vec<String>,
    pub formats: BTreeMap<String, String>,
    pub resource_count: usize,
    pub resource_examples: Vec<String>,
}

#[derive(Default)]
struct Inventory {
    extensions: HashSet<String>,
    references: HashSet<String>,
    features: BTreeMap<ExportFeatureKind, ExportFeatureInventory>,
}
impl Inventory {
    fn add(&mut self, kind: ExportFeatureKind, id: String, label: String) -> Result<(), HcdError> {
        let ids = if kind == ExportFeatureKind::Reference {
            &mut self.references
        } else {
            &mut self.extensions
        };
        if ids.len() >= 10_000 || !ids.insert(id) {
            return Err(HcdError::InvalidBundle(
                "duplicate or excessive export feature identities".into(),
            ));
        }
        let feature = self
            .features
            .entry(kind)
            .or_insert_with(|| ExportFeatureInventory {
                kind,
                count: 0,
                examples: Vec::new(),
                formats: BTreeMap::new(),
                resource_count: 0,
                resource_examples: Vec::new(),
            });
        feature.count += 1;
        if feature.examples.len() < 3 {
            feature.examples.push(label.chars().take(160).collect());
        }
        Ok(())
    }
    fn scan(&mut self, html: &str) -> Result<(), HcdError> {
        if !html.contains("data-hcd-extension")
            && !html.contains("data-hcd-reference")
            && !html.contains("data-hcd-custom-marks")
        {
            return Ok(());
        }
        let mut reader = Reader::from_str(html);
        let mut buffer = Vec::new();
        loop {
            match reader.read_event_into(&mut buffer).map_err(|error| {
                HcdError::InvalidBundle(format!("invalid export feature HTML: {error}"))
            })? {
                Event::Start(element) | Event::Empty(element) => {
                    if let Some(raw) =
                        element
                            .try_get_attribute("data-hcd-custom-marks")
                            .map_err(|_| {
                                HcdError::InvalidBundle("invalid custom mark attribute".into())
                            })?
                    {
                        let value =
                            raw.decode_and_unescape_value(reader.decoder())
                                .map_err(|_| {
                                    HcdError::InvalidBundle("invalid custom mark encoding".into())
                                })?;
                        if value.len() > 8 * 65536 {
                            return Err(HcdError::ResourceLimit(
                                "custom mark payload exceeds export limit".into(),
                            ));
                        }
                        let marks: Vec<crate::CustomTextMark> = serde_json::from_str(&value)?;
                        crate::validate_custom_marks(&marks)?;
                        let id = element
                            .try_get_attribute("data-hcd-id")
                            .map_err(|_| {
                                HcdError::InvalidBundle("invalid custom mark text ID".into())
                            })?
                            .ok_or_else(|| {
                                HcdError::InvalidBundle("custom mark has no text ID".into())
                            })?
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|_| {
                                HcdError::InvalidBundle("invalid custom mark text ID".into())
                            })?
                            .into_owned();
                        for mark in marks {
                            self.add(
                                ExportFeatureKind::CustomMark,
                                format!("mark:{id}:{}", mark.mark_type),
                                mark.fallback.label,
                            )?;
                        }
                    }
                    for attribute in element.attributes() {
                        let attribute = attribute.map_err(|_| {
                            HcdError::InvalidBundle("invalid export feature attributes".into())
                        })?;
                        let key = attribute.key.as_ref();
                        if key != b"data-hcd-extension" && key != b"data-hcd-reference" {
                            continue;
                        }
                        let value = attribute
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|_| {
                                HcdError::InvalidBundle("invalid export feature encoding".into())
                            })?;
                        if value.len() > 65_536 {
                            return Err(HcdError::ResourceLimit(
                                "export feature exceeds payload limit".into(),
                            ));
                        }
                        if key == b"data-hcd-extension" {
                            let node: ExtensionNode = serde_json::from_str(&value)?;
                            node.validate()?;
                            let kind = if node.display == ExtensionDisplay::Inline {
                                ExportFeatureKind::ExtensionInline
                            } else {
                                ExportFeatureKind::ExtensionBlock
                            };
                            let mut supports: BTreeMap<_, _> = crate::NODE_EXPORT_FORMATS
                                .into_iter()
                                .map(|format| {
                                    (
                                        format.to_owned(),
                                        node.exports
                                            .get(format)
                                            .map(|s| {
                                                let images = s
                                                    .blocks
                                                    .iter()
                                                    .flat_map(|b| &b.runs)
                                                    .filter_map(|run| {
                                                        if let crate::NodeExportRun::Image(image) =
                                                            run
                                                        {
                                                            Some(image)
                                                        } else {
                                                            None
                                                        }
                                                    })
                                                    .collect::<Vec<_>>();
                                                let text_image_fallback = ["md", "txt"]
                                                    .contains(&format)
                                                    && !images.is_empty();
                                                let pdf_image_fallback = format == "pdf"
                                                    && images.iter().any(|image| {
                                                        node.resources.iter().any(|r| {
                                                            r.key == image.resource
                                                                && !["image/png", "image/jpeg"]
                                                                    .contains(
                                                                        &r.media_type.as_str(),
                                                                    )
                                                        })
                                                    });
                                                if s.support != "unsupported"
                                                    && (text_image_fallback || pdf_image_fallback)
                                                {
                                                    "static".into()
                                                } else {
                                                    s.support.clone()
                                                }
                                            })
                                            .unwrap_or_else(|| {
                                                if node.content_model.is_some() {
                                                    "semantic".into()
                                                } else {
                                                    "static".into()
                                                }
                                            }),
                                    )
                                })
                                .collect();
                            // These converters preserve readable inline body
                            // text but currently flatten its rich run styles.
                            // A host adapter cannot upgrade the live body path.
                            if node.envelope_version() == 3 {
                                for format in ["md", "pptx"] {
                                    if let Some(support) = supports.get_mut(format) {
                                        if support != "unsupported" {
                                            *support = "static".into();
                                        }
                                    }
                                }
                            }
                            let resource_count = node.resources.len();
                            let resource_names: Vec<_> =
                                node.resources.iter().map(|r| r.name.clone()).collect();
                            self.add(
                                if node.display == ExtensionDisplay::Inline {
                                    ExportFeatureKind::ExtensionInline
                                } else {
                                    ExportFeatureKind::ExtensionBlock
                                },
                                node.instance_id,
                                node.fallback.text,
                            )?;
                            let feature = self.features.get_mut(&kind).expect("inserted feature");
                            feature.resource_count += resource_count;
                            for name in resource_names {
                                if feature.resource_examples.len() < 3 {
                                    feature.resource_examples.push(name);
                                }
                            }
                            for (format, support) in supports {
                                let current = feature
                                    .formats
                                    .entry(format)
                                    .or_insert_with(|| support.clone());
                                if current == "unsupported" || support == "unsupported" {
                                    *current = "unsupported".into();
                                } else if current != "semantic" || support != "semantic" {
                                    *current = "static".into();
                                }
                            }
                        } else {
                            let reference: InlineReference = serde_json::from_str(&value)?;
                            reference.validate()?;
                            self.add(
                                ExportFeatureKind::Reference,
                                reference.mention_id,
                                format!("@{}", reference.snapshot.label),
                            )?;
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buffer.clear();
        }
        Ok(())
    }
}

pub fn export_feature_inventory(
    bundle: &Bundle,
    revision: u64,
) -> Result<Vec<ExportFeatureInventory>, HcdError> {
    let head = bundle.manifest()?;
    let (manifest, _) = crate::manifest_at_revision(bundle, &head, Some(revision))?;
    let mut inventory = Inventory::default();
    for number in 0..manifest.index_page_count {
        let page = bundle.read_index_page(&manifest, number)?;
        if page.page != number || page.revision > revision {
            return Err(HcdError::InvalidBundle(
                "invalid export feature index page".into(),
            ));
        }
        for chunk in page.chunks {
            inventory.scan(&bundle.read_chunk_verified(&chunk)?)?;
        }
    }
    Ok(inventory.features.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(index: u32, display: &str) -> String {
        let value = serde_json::json!({"schemaVersion":"hcd.extension/1","instanceId":format!("x_{index:032x}"),"type":"future.business","version":77,"display":display,"data":{"private":"not returned"},"fallback":{"text":format!("Readable {index}")}});
        format!(
            "<span data-hcd-extension=\"{}\">Readable</span>",
            value.to_string().replace('"', "&quot;")
        )
    }
    #[test]
    fn editable_inline_body_reports_static_targets_that_flatten_run_formatting() {
        let node = serde_json::json!({"schemaVersion":"hcd.extension/3","instanceId":format!("x_{:032x}",1),"type":"example.inline","version":77,"display":"inline","contentModel":"inline","data":{},"fallback":{"text":"Label"},"exports":{"md":{"support":"semantic","includeContent":true,"blocks":[]},"pptx":{"support":"semantic","includeContent":true,"blocks":[]}}});
        let mut inventory = Inventory::default();
        inventory
            .scan(&format!(
                "<span data-hcd-inline-container='true' data-hcd-extension='{}'>Body</span>",
                node.to_string().replace('"', "&quot;")
            ))
            .unwrap();
        let feature = inventory
            .features
            .get(&ExportFeatureKind::ExtensionInline)
            .unwrap();
        assert_eq!(
            feature.formats.get("md").map(String::as_str),
            Some("static")
        );
        assert_eq!(
            feature.formats.get("pptx").map(String::as_str),
            Some("static")
        );
        assert_eq!(
            feature.formats.get("docx").map(String::as_str),
            Some("semantic")
        );
    }

    #[test]
    fn inventory_keeps_counts_and_bounded_labels_without_exposing_business_data() {
        let mut inventory = Inventory::default();
        for index in 1..=5 {
            inventory.scan(&node(index, "inline")).unwrap();
        }
        inventory
            .scan(&node(6, "block").replace("data-hcd-extension=", "data-hcd-extension = "))
            .unwrap();
        let inline = &inventory.features[&ExportFeatureKind::ExtensionInline];
        assert_eq!(inline.count, 5);
        assert_eq!(inline.examples.len(), 3);
        assert_eq!(
            inventory.features[&ExportFeatureKind::ExtensionBlock].count,
            1
        );
        assert!(!serde_json::to_string(inline)
            .unwrap()
            .contains("not returned"));
        assert!(inventory.scan(&node(1, "inline")).is_err());
    }
    #[test]
    fn metadata_in_comments_or_text_is_not_counted_and_invalid_envelopes_fail() {
        let mut inventory = Inventory::default();
        inventory
            .scan(&format!(
                "<!--{}--><p>data-hcd-extension= ordinary text</p>",
                node(1, "inline")
            ))
            .unwrap();
        assert!(inventory.features.is_empty());
        assert!(inventory.scan("<p data-hcd-extension=\"{}\"/>").is_err());
        let reference = serde_json::json!({"type":"hcd.mention","version":1,"mentionId":format!("m_{:032x}",1),"target":{"kind":"person","id":"private-target"},"snapshot":{"label":"同名人员"}}).to_string().replace('"',"&quot;");
        inventory
            .scan(&format!("<span data-hcd-reference=\"{reference}\"/>"))
            .unwrap();
        assert_eq!(
            inventory.features[&ExportFeatureKind::Reference].examples,
            ["@同名人员"]
        );
        assert!(!serde_json::to_string(&inventory.features)
            .unwrap()
            .contains("private-target"));
    }
}
