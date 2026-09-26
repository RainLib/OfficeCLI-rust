mod bundle;
mod error;
mod hash;
mod html;
mod patch;
mod presentation;
mod restore;
mod stats;
mod structure;
mod types;
mod validate;

pub use bundle::{Bundle, BundleWriter, INDEX_PAGE_SIZE};
pub use error::HcdError;
pub use hash::{
    hash_bytes, hash_file, hash_reader, node_bloom, node_bloom_might_contain, stable_node_id,
};
pub use html::{
    extract_html_image_nodes, extract_html_text_nodes, image_visual_hash, validate_css_text,
    HtmlImageNode,
};
pub use patch::{
    apply_patch, extract_image_page, extract_text_page, get_image_node, get_text_node,
};
pub use presentation::{
    manifest_at_revision, render_standalone_html, render_standalone_html_with_transform,
    HtmlPresentationOptions, HtmlPresentationReport, DEFAULT_HTML_PRESENTATION_MAX_BYTES,
};
pub use restore::restore_revision;
pub use stats::{bundle_stats, remove_orphan_objects, BundleStats, StorageCategory};
pub use structure::{
    apply_structure_patch, editor_projection, project_editor, BlockPrecondition,
    EditorBlockContent, EditorBlockKind, EditorBlockView, EditorInline, EditorProjection,
    StructureOperation, StructurePatchBatch,
};
pub use types::*;
pub use validate::validate_bundle;

pub const HCD_SCHEMA_VERSION: &str = "hcd/2";
pub const HCD_SCHEMA_VERSION_1: &str = "hcd/1";
pub const HCD_PATCH_SCHEMA_VERSION: &str = "hcd-patch/1";
pub const HCD_PATCH_SCHEMA_VERSION_2: &str = "hcd-patch/2";
pub const HCD_PATCH_SCHEMA_VERSION_3: &str = "hcd-patch/3";
pub const HCD_PATCH_SCHEMA_VERSION_4: &str = "hcd-patch/4";
pub const HCD_PATCH_SCHEMA_VERSION_5: &str = "hcd-patch/5";
pub const HCD_PATCH_SCHEMA_VERSION_6: &str = "hcd-patch/6";
pub const HCD_PATCH_SCHEMA_VERSION_7: &str = "hcd-patch/7";
pub const HCD_PATCH_SCHEMA_VERSION_8: &str = "hcd-patch/8";
pub const HCD_PATCH_SCHEMA_VERSION_9: &str = "hcd-patch/9";
pub const HCD_PATCH_SCHEMA_VERSION_10: &str = "hcd-patch/10";
pub const HCD_PATCH_SCHEMA_VERSION_11: &str = "hcd-patch/11";
pub const HCD_PATCH_SCHEMA_VERSION_12: &str = "hcd-patch/12";
pub const HCD_PATCH_SCHEMA_VERSION_13: &str = "hcd-patch/13";
pub const HCD_PATCH_SCHEMA_VERSION_14: &str = "hcd-patch/14";
pub const HCD_PATCH_SCHEMA_VERSION_15: &str = "hcd-patch/15";
pub const HCD_PATCH_SCHEMA_VERSION_16: &str = "hcd-patch/16";
pub const HCD_PATCH_SCHEMA_VERSION_17: &str = "hcd-patch/17";
pub const HCD_PATCH_SCHEMA_VERSION_18: &str = "hcd-patch/18";
pub const HCD_PATCH_SCHEMA_VERSION_19: &str = "hcd-patch/19";
pub const HCD_PATCH_SCHEMA_VERSION_20: &str = "hcd-patch/20";
pub const HCD_SCHEMA_JSON: &str = include_str!("../schemas/hcd-2.schema.json");
pub const HCD_SCHEMA_V1_JSON: &str = include_str!("../schemas/hcd-1.schema.json");
pub const HCD_PATCH_SCHEMA_JSON: &str = include_str!("../schemas/hcd-patch-1.schema.json");
pub const HCD_PATCH_SCHEMA_V2_JSON: &str = include_str!("../schemas/hcd-patch-2.schema.json");
pub const HCD_PATCH_SCHEMA_V3_JSON: &str = include_str!("../schemas/hcd-patch-3.schema.json");
pub const HCD_PATCH_SCHEMA_V4_JSON: &str = include_str!("../schemas/hcd-patch-4.schema.json");
pub const HCD_PATCH_SCHEMA_V5_JSON: &str = include_str!("../schemas/hcd-patch-5.schema.json");
pub const HCD_PATCH_SCHEMA_V6_JSON: &str = include_str!("../schemas/hcd-patch-6.schema.json");
pub const HCD_PATCH_SCHEMA_V7_JSON: &str = include_str!("../schemas/hcd-patch-7.schema.json");
pub const HCD_PATCH_SCHEMA_V8_JSON: &str = include_str!("../schemas/hcd-patch-8.schema.json");
pub const HCD_PATCH_SCHEMA_V9_JSON: &str = include_str!("../schemas/hcd-patch-9.schema.json");
pub const HCD_PATCH_SCHEMA_V10_JSON: &str = include_str!("../schemas/hcd-patch-10.schema.json");
pub const HCD_PATCH_SCHEMA_V11_JSON: &str = include_str!("../schemas/hcd-patch-11.schema.json");
pub const HCD_PATCH_SCHEMA_V12_JSON: &str = include_str!("../schemas/hcd-patch-12.schema.json");
pub const HCD_PATCH_SCHEMA_V13_JSON: &str = include_str!("../schemas/hcd-patch-13.schema.json");
pub const HCD_PATCH_SCHEMA_V14_JSON: &str = include_str!("../schemas/hcd-patch-14.schema.json");
pub const HCD_PATCH_SCHEMA_V15_JSON: &str = include_str!("../schemas/hcd-patch-15.schema.json");
pub const HCD_PATCH_SCHEMA_V16_JSON: &str = include_str!("../schemas/hcd-patch-16.schema.json");
pub const HCD_PATCH_SCHEMA_V17_JSON: &str = include_str!("../schemas/hcd-patch-17.schema.json");
pub const HCD_PATCH_SCHEMA_V18_JSON: &str = include_str!("../schemas/hcd-patch-18.schema.json");
pub const HCD_PATCH_SCHEMA_V19_JSON: &str = include_str!("../schemas/hcd-patch-19.schema.json");
pub const HCD_PATCH_SCHEMA_V20_JSON: &str = include_str!("../schemas/hcd-patch-20.schema.json");
pub const DEFAULT_CHUNK_SOFT_BYTES: usize = 512 * 1024;
pub const DEFAULT_CHUNK_BLOCKS: usize = 256;
pub const MAX_CHUNK_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CONTROL_PART_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PATCH_JSON_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_STAGED_ASSET_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_REVISION: u64 = 100_000;

#[cfg(test)]
mod schema_tests {
    #[test]
    fn frozen_json_schemas_are_valid_json_and_have_stable_ids() {
        let hcd: serde_json::Value = serde_json::from_str(super::HCD_SCHEMA_JSON).unwrap();
        let patch: serde_json::Value = serde_json::from_str(super::HCD_PATCH_SCHEMA_JSON).unwrap();
        let patch_v2: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V2_JSON).unwrap();
        let patch_v3: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V3_JSON).unwrap();
        let patch_v4: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V4_JSON).unwrap();
        let patch_v5: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V5_JSON).unwrap();
        let patch_v6: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V6_JSON).unwrap();
        let patch_v7: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V7_JSON).unwrap();
        let patch_v8: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V8_JSON).unwrap();
        let patch_v9: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V9_JSON).unwrap();
        let patch_v10: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V10_JSON).unwrap();
        let patch_v11: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V11_JSON).unwrap();
        let patch_v12: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V12_JSON).unwrap();
        let patch_v13: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V13_JSON).unwrap();
        let patch_v14: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V14_JSON).unwrap();
        let patch_v15: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V15_JSON).unwrap();
        let patch_v16: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V16_JSON).unwrap();
        let patch_v17: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V17_JSON).unwrap();
        let patch_v18: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V18_JSON).unwrap();
        let patch_v19: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V19_JSON).unwrap();
        let patch_v20: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V20_JSON).unwrap();
        assert_eq!(hcd["$id"], "urn:officecli:hcd:2");
        assert_eq!(patch["$id"], "urn:officecli:hcd-patch:1");
        assert_eq!(patch_v2["$id"], "urn:officecli:hcd-patch:2");
        assert_eq!(patch_v3["$id"], "urn:officecli:hcd-patch:3");
        assert_eq!(patch_v4["$id"], "urn:officecli:hcd-patch:4");
        assert_eq!(patch_v5["$id"], "urn:officecli:hcd-patch:5");
        assert_eq!(patch_v6["$id"], "urn:officecli:hcd-patch:6");
        assert_eq!(patch_v7["$id"], "urn:officecli:hcd-patch:7");
        assert_eq!(patch_v8["$id"], "urn:officecli:hcd-patch:8");
        assert_eq!(patch_v9["$id"], "urn:officecli:hcd-patch:9");
        assert_eq!(patch_v10["$id"], "urn:officecli:hcd-patch:10");
        assert_eq!(patch_v11["$id"], "urn:officecli:hcd-patch:11");
        assert_eq!(patch_v12["$id"], "urn:officecli:hcd-patch:12");
        assert_eq!(patch_v13["$id"], "urn:officecli:hcd-patch:13");
        assert_eq!(patch_v14["$id"], "urn:officecli:hcd-patch:14");
        assert_eq!(patch_v15["$id"], "urn:officecli:hcd-patch:15");
        assert_eq!(patch_v16["$id"], "urn:officecli:hcd-patch:16");
        assert_eq!(patch_v17["$id"], "urn:officecli:hcd-patch:17");
        assert_eq!(patch_v18["$id"], "urn:officecli:hcd-patch:18");
        assert_eq!(patch_v19["$id"], "urn:officecli:hcd-patch:19");
        assert_eq!(patch_v20["$id"], "urn:officecli:hcd-patch:20");
    }

    #[test]
    fn frozen_types_reject_unknown_json_fields() {
        let source = r#"{"format":"docx","sha256":"00","sizeBytes":1,"sensitiveOriginal":"must-not-survive"}"#;
        assert!(serde_json::from_str::<super::SourceDescriptor>(source).is_err());

        let annotation = r#"{"annotationId":"a","nodeId":"n_00000000000000000000000000000000","start":0,"end":1,"kind":"mask","ignored":false,"originalText":"secret"}"#;
        assert!(serde_json::from_str::<super::Annotation>(annotation).is_err());
    }
}
