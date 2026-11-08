mod extension_portable;
pub use extension_portable::*;
mod custom_marks;
pub use custom_marks::*;
mod word_numeric_fields;
pub use word_numeric_fields::*;
mod bundle;
mod flow_layout;
pub use flow_layout::*;
mod flow_layout_edits;
pub use flow_layout_edits::*;
mod flow_story_link;
pub use flow_story_link::*;
mod grid_create;
pub use grid_create::{
    apply_checked_grid_cells, GridCellCreate, GridCreateRequest, XLSX_VIRTUAL_CELL_SOURCE,
};
mod error;
mod export_capabilities;
mod hash;
mod html;
mod patch;
mod pdf_layout;
mod pdf_text_layout;
pub use pdf_text_layout::{
    extract_pdf_text_layouts, PdfNodeTextLayout, PdfTextLayout, PdfTextRunLayout,
    PDF_TEXT_LAYOUT_ATTRIBUTE,
};
mod portable;
mod presentation;
mod references;
mod restore;
mod stats;
mod structure;
mod text_runs;
mod types;
mod typography;
mod validate;

pub use bundle::{Bundle, BundleWriter, INDEX_PAGE_SIZE};
pub use error::HcdError;
pub use export_capabilities::{
    export_feature_inventory, ExportFeatureInventory, ExportFeatureKind,
};
pub use hash::{
    hash_bytes, hash_file, hash_reader, node_bloom, node_bloom_might_contain, stable_node_id,
};
pub use html::{
    extract_html_image_nodes, extract_html_text_nodes, image_visual_hash, validate_css_text,
    HtmlImageNode,
};
pub use patch::{
    apply_patch, apply_patch_with_pdf_rasters, extract_image_page, extract_text_page,
    get_image_node, get_image_node_in_manifest, get_text_node, get_text_node_in_manifest,
    get_text_node_receipts_in_manifest, get_text_node_sources_in_manifest, TextNodeReceipt,
};
pub use pdf_layout::{apply_pdf_layout_upgrade, PdfLayoutChunk, PdfLayoutUpgrade};
pub use portable::{
    create_portable_snapshot, portable_bundle_hrefs, validate_portable_bundle, PortableSnapshot,
    MAX_PORTABLE_BYTES, MAX_PORTABLE_FILES, MAX_PORTABLE_FILE_BYTES,
};
pub use presentation::{
    manifest_at_revision, render_standalone_html, render_standalone_html_with_transform,
    HtmlPresentationOptions, HtmlPresentationReport, DEFAULT_HTML_PRESENTATION_MAX_BYTES,
};
pub use references::{
    content_references, document_reference_locations, document_references, projection_references,
    reference_events, InlineReference, ReferenceEvent, ReferenceEventContext, ReferenceLocation,
    ReferenceOccurrence, ReferenceScope, ReferenceSnapshot, ReferenceTarget,
};
pub use restore::restore_revision;
pub use stats::{bundle_stats, remove_orphan_objects, BundleStats, StorageCategory};
pub use structure::{
    append_comment, apply_coordinated_flow_story_link_transaction, apply_flow_layout_transaction,
    apply_flow_story_link_transaction, apply_flow_structure_patch, apply_prepared_story_unlink,
    apply_structure_patch, editor_projection, editor_projection_with_typography_styles,
    flow_layout_hash, flow_regions, prepare_story_content_copy, prepare_story_copy_at_revision,
    prepare_story_unlink_at_revision, preview_flow_story_link_transaction, project_editor,
    project_flow_regions, resolve_tracked_change, retain_replacement_sources,
    validate_flow_story_link_revision, validate_unlink_revision_content, word_region_index_page,
    BlockPrecondition, CommentNote, EditorBlockContent, EditorBlockKind, EditorBlockView,
    EditorInline, EditorProjection, FlowRegion, FlowRegionEdits, FlowRegionKind,
    FlowStructurePatchBatch, PreparedStoryUnlink, ReplacementSources, StoryCopyChoices,
    StructureOperation, StructurePatchBatch, TrackedChange, WordRegionIndex,
};
pub use text_runs::{
    extract_text_run_sizes, text_format_hashes, FontSizeRun, TextRunsPrecondition,
};
pub use types::*;
pub use typography::{resolve_typography, TextTypography, TypographyResolver};
pub use validate::validate_bundle;

pub const HCD_SCHEMA_VERSION: &str = "hcd/2";
pub const HCD_SCHEMA_VERSION_1: &str = "hcd/1";
pub const HCD_PATCH_SCHEMA_VERSION: &str = "hcd-patch/1";
pub const HCD_PATCH_SCHEMA_VERSION_2: &str = "hcd-patch/2";
pub const HCD_PATCH_SCHEMA_VERSION_3: &str = "hcd-patch/3";
pub const HCD_PATCH_SCHEMA_VERSION_4: &str = "hcd-patch/4";
pub const HCD_PATCH_SCHEMA_VERSION_5: &str = "hcd-patch/5";
pub const HCD_PATCH_SCHEMA_VERSION_6: &str = "hcd-patch/6";
pub const HCD_SCHEMA_JSON: &str = include_str!("../schemas/hcd-2.schema.json");
pub const HCD_SCHEMA_V1_JSON: &str = include_str!("../schemas/hcd-1.schema.json");
pub const HCD_PATCH_SCHEMA_JSON: &str = include_str!("../schemas/hcd-patch-1.schema.json");
pub const HCD_PATCH_SCHEMA_V2_JSON: &str = include_str!("../schemas/hcd-patch-2.schema.json");
pub const HCD_PATCH_SCHEMA_V3_JSON: &str = include_str!("../schemas/hcd-patch-3.schema.json");
pub const HCD_PATCH_SCHEMA_V4_JSON: &str = include_str!("../schemas/hcd-patch-4.schema.json");
pub const HCD_PATCH_SCHEMA_V5_JSON: &str = include_str!("../schemas/hcd-patch-5.schema.json");
pub const HCD_PATCH_SCHEMA_V6_JSON: &str = include_str!("../schemas/hcd-patch-6.schema.json");
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
        assert_eq!(hcd["$id"], "urn:officecli:hcd:2");
        assert_eq!(patch["$id"], "urn:officecli:hcd-patch:1");
        assert_eq!(patch_v2["$id"], "urn:officecli:hcd-patch:2");
        assert_eq!(patch_v3["$id"], "urn:officecli:hcd-patch:3");
        assert_eq!(patch_v4["$id"], "urn:officecli:hcd-patch:4");
        assert_eq!(patch_v5["$id"], "urn:officecli:hcd-patch:5");
        let patch_v6: serde_json::Value =
            serde_json::from_str(super::HCD_PATCH_SCHEMA_V6_JSON).unwrap();
        assert_eq!(patch_v6["$id"], "urn:officecli:hcd-patch:6");
    }

    #[test]
    fn frozen_types_reject_unknown_json_fields() {
        let source = r#"{"format":"docx","sha256":"00","sizeBytes":1,"sensitiveOriginal":"must-not-survive"}"#;
        assert!(serde_json::from_str::<super::SourceDescriptor>(source).is_err());

        let annotation = r#"{"annotationId":"a","nodeId":"n_00000000000000000000000000000000","start":0,"end":1,"kind":"mask","ignored":false,"originalText":"secret"}"#;
        assert!(serde_json::from_str::<super::Annotation>(annotation).is_err());
    }
}

mod extensions;
pub use extensions::{
    content_extensions, projection_extensions, ExtensionDisplay, ExtensionFallback, ExtensionNode,
};
