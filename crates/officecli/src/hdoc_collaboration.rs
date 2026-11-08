//! Durable collaboration format identity. An epoch is published only after its
//! new state exists; legacy numeric epoch files remain readable.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum Protocol {
    #[default]
    #[serde(rename = "hcd-default/1")]
    Default1,
    #[serde(rename = "hcd-semantic-blocks/3")]
    Structure3,
    #[serde(rename = "hcd-semantic-inline/1")]
    Inline1,
    #[serde(rename = "hcd-word-regions/1")]
    WordRegions1,
    /// Reserved for layout-aware coordinated rooms. No migration or browser
    /// admission is implied merely by recognizing this protocol.
    #[serde(rename = "hcd-word-regions/2")]
    WordRegions2,
}
impl Protocol {
    pub fn name(self) -> &'static str {
        match self {
            Self::Default1 => "hcd-default/1",
            Self::Structure3 => "hcd-semantic-blocks/3",
            Self::Inline1 => "hcd-semantic-inline/1",
            Self::WordRegions1 => "hcd-word-regions/1",
            Self::WordRegions2 => "hcd-word-regions/2",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationReceipt {
    pub id: String,
    pub from_epoch: u64,
    pub source_hash: String,
    pub base_revision: u64,
    pub state_hash: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub epoch: u64,
    pub protocol: Protocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_edits: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<MigrationReceipt>,
}
impl Metadata {
    pub fn decode(value: &str) -> Result<Self, serde_json::Error> {
        if let Ok(epoch) = value.trim().parse::<u64>() {
            return Ok(Self {
                epoch,
                ..Self::default()
            });
        }
        let result: Self = serde_json::from_str(value)?;
        if result
            .node_edits
            .is_some_and(|version| !matches!(version, 1..=7))
        {
            return Err(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported collaboration node edit model",
            )));
        }
        if let Some(receipt) = &result.migration {
            let hex = |value: &str, size| {
                value.len() == size
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            };
            if !matches!(result.protocol, Protocol::Structure3 | Protocol::Inline1)
                || result.protocol == Protocol::Inline1 && receipt.source_hash != "none"
                || receipt.from_epoch.checked_add(1) != Some(result.epoch)
                || !hex(&receipt.id, 32)
                || !hex(&receipt.state_hash, 64)
                || receipt.source_hash != "none" && !hex(&receipt.source_hash, 64)
            {
                return Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid collaboration migration receipt",
                )));
            }
        }
        if result.protocol == Protocol::Inline1 && result.node_edits != Some(7) {
            return Err(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "inline collaboration requires node edits 7",
            )));
        }
        Ok(result)
    }
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        if self.protocol == Protocol::Default1
            && self.migration.is_none()
            && self.node_edits.is_none()
        {
            return Ok(self.epoch.to_string());
        }
        serde_json::to_string(self)
    }
    pub fn reset(&self) -> Option<Self> {
        Some(Self {
            epoch: self.epoch.checked_add(1)?,
            protocol: self.protocol,
            node_edits: self.node_edits,
            migration: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_identity_requires_wire_seven_and_an_empty_source_receipt() {
        let metadata = Metadata {
            epoch: 1,
            protocol: Protocol::Inline1,
            node_edits: Some(7),
            migration: Some(MigrationReceipt {
                id: "a".repeat(32),
                from_epoch: 0,
                source_hash: "none".into(),
                base_revision: 8,
                state_hash: "b".repeat(64),
            }),
        };
        assert_eq!(
            Metadata::decode(&metadata.encode().unwrap()).unwrap(),
            metadata
        );
        let reset = metadata.reset().unwrap();
        assert_eq!(reset.protocol, Protocol::Inline1);
        assert_eq!(reset.node_edits, Some(7));
        assert!(reset.migration.is_none());
        let mut invalid = metadata.clone();
        invalid.node_edits = None;
        assert!(Metadata::decode(&invalid.encode().unwrap()).is_err());
        invalid = metadata.clone();
        invalid.migration.as_mut().unwrap().source_hash = "c".repeat(64);
        assert!(Metadata::decode(&invalid.encode().unwrap()).is_err());
    }
    #[test]
    fn numeric_epochs_keep_the_legacy_format_and_unknown_protocols_fail_closed() {
        let metadata = Metadata::decode("12\n").unwrap();
        assert_eq!(metadata.epoch, 12);
        assert_eq!(metadata.protocol, Protocol::Default1);
        assert_eq!(metadata.reset().unwrap().encode().unwrap(), "13");
        assert!(Metadata::decode(r#"{"epoch":2,"protocol":"future/9"}"#).is_err());
    }
    #[test]
    fn node_edit_model_is_sticky_and_unknown_models_fail_closed() {
        let metadata = Metadata {
            node_edits: Some(1),
            ..Metadata::default()
        };
        let encoded = metadata.encode().unwrap();
        assert!(encoded.starts_with('{'));
        assert_eq!(Metadata::decode(&encoded).unwrap(), metadata);
        assert_eq!(metadata.reset().unwrap().node_edits, Some(1));
        assert!(
            Metadata::decode(r#"{"epoch":0,"protocol":"hcd-default/1","nodeEdits":8}"#).is_err()
        );
        let marks = Metadata {
            node_edits: Some(7),
            ..Metadata::default()
        };
        assert_eq!(
            Metadata::decode(&marks.encode().unwrap())
                .unwrap()
                .reset()
                .unwrap()
                .node_edits,
            Some(7)
        );
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct OldMetadata {
            #[allow(dead_code)]
            epoch: u64,
            #[allow(dead_code)]
            protocol: Protocol,
        }
        assert!(serde_json::from_str::<OldMetadata>(&encoded).is_err());
    }

    #[test]
    fn regional_room_identity_is_explicit_and_survives_an_epoch_reset() {
        let metadata = Metadata {
            epoch: 4,
            protocol: Protocol::WordRegions1,
            node_edits: Some(7),
            migration: None,
        };
        assert_eq!(
            Metadata::decode(&metadata.encode().unwrap()).unwrap(),
            metadata
        );
        assert_eq!(metadata.reset().unwrap().protocol, Protocol::WordRegions1);
        assert_eq!(metadata.reset().unwrap().epoch, 5);
        let layout = Metadata::decode(r#"{"epoch":4,"protocol":"hcd-word-regions/2"}"#).unwrap();
        assert_eq!(layout.protocol, Protocol::WordRegions2);
        assert_eq!(layout.reset().unwrap().protocol, Protocol::WordRegions2);
        assert!(Metadata::decode(r#"{"epoch":4,"protocol":"hcd-word-regions/3"}"#).is_err());
    }

    #[test]
    fn structural_reset_preserves_protocol_but_does_not_replay_an_old_migration() {
        let metadata = Metadata {
            epoch: 3,
            protocol: Protocol::Structure3,
            node_edits: None,
            migration: Some(MigrationReceipt {
                id: "a".repeat(32),
                from_epoch: 2,
                source_hash: "none".into(),
                base_revision: 7,
                state_hash: "b".repeat(64),
            }),
        };
        assert_eq!(
            Metadata::decode(&metadata.encode().unwrap()).unwrap(),
            metadata
        );
        assert_eq!(
            metadata.reset().unwrap(),
            Metadata {
                epoch: 4,
                protocol: Protocol::Structure3,
                node_edits: None,
                migration: None
            }
        );
    }
}
