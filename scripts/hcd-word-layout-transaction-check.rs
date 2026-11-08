//! Mutates only the caller-provided, disposable HCD copy.
use hcd_core::{
    apply_flow_layout_transaction, flow_layout_hash, manifest_at_revision,
    read_flow_document_layout, validate_bundle, Bundle, FlowLayoutEdits, FlowLayoutField,
    FlowLayoutFieldChange, FlowLayoutTransaction, HcdError, FLOW_LAYOUT_EDITS_SCHEMA,
    FLOW_LAYOUT_TRANSACTION_SCHEMA,
};
use serde_json::json;
use std::collections::BTreeMap;

fn main() {
    let bundle = Bundle::open(std::env::args().nth(1).unwrap()).unwrap();
    let initial = bundle.manifest().unwrap();
    assert_eq!(initial.revision, 4);
    let base = read_flow_document_layout(&bundle, &initial)
        .unwrap()
        .unwrap();
    let base_hash = flow_layout_hash(&base).unwrap();
    let width = base.sections[0].page.width_twips.unwrap();
    let height = base.sections[0].page.height_twips.unwrap();
    let change = |field, old, new| FlowLayoutFieldChange {
        section_id: Some(base.sections[0].id.clone()),
        field,
        expected: json!(old),
        value: json!(new),
    };
    let transaction = |id: &str, expected_revision, edit| FlowLayoutTransaction {
        schema_version: FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),
        document_id: initial.document_id.clone(),
        transaction_id: id.repeat(32),
        base_revision: 4,
        expected_revision,
        actor: BTreeMap::from([
            ("userId".into(), "alice".into()),
            ("displayName".into(), "Alice".into()),
        ]),
        edits: FlowLayoutEdits {
            schema_version: FLOW_LAYOUT_EDITS_SCHEMA.into(),
            base_layout_hash: base_hash.clone(),
            changes: vec![edit],
        },
    };
    let first = transaction(
        "a",
        4,
        change(FlowLayoutField::WidthTwips, width, width + 20),
    );
    let result = apply_flow_layout_transaction(&bundle, &first).unwrap();
    assert_eq!(result.revision, 5);
    assert!(!result.idempotent_replay);
    let second = transaction(
        "b",
        5,
        change(FlowLayoutField::HeightTwips, height, height + 20),
    );
    assert_eq!(
        apply_flow_layout_transaction(&bundle, &second)
            .unwrap()
            .revision,
        6
    );
    let replay = apply_flow_layout_transaction(&bundle, &first).unwrap();
    assert!(replay.idempotent_replay);
    assert_eq!(replay.revision, 5);
    assert_eq!(replay.root_hash, result.root_hash);
    let mut forged = first.clone();
    forged.edits.changes[0].value = json!(width + 30);
    assert!(matches!(
        apply_flow_layout_transaction(&bundle, &forged),
        Err(HcdError::InvalidPatch(_))
    ));
    let conflicting = transaction(
        "c",
        6,
        change(FlowLayoutField::WidthTwips, width, width + 40),
    );
    assert!(matches!(
        apply_flow_layout_transaction(&bundle, &conflicting),
        Err(HcdError::PreconditionFailed(_))
    ));
    let stale = transaction(
        "d",
        5,
        change(FlowLayoutField::HeightTwips, height, height + 40),
    );
    assert!(matches!(
        apply_flow_layout_transaction(&bundle, &stale),
        Err(HcdError::RevisionConflict(_))
    ));
    let head = bundle.manifest().unwrap();
    assert_eq!(head.revision, 6);
    assert_eq!(head.index_root_href, initial.index_root_href);
    assert_eq!(head.annotation_root_hash, initial.annotation_root_hash);
    for (revision, w, h) in [
        (4, width, height),
        (5, width + 20, height),
        (6, width + 20, height + 20),
    ] {
        let (manifest, _) = manifest_at_revision(&bundle, &head, Some(revision)).unwrap();
        let value = read_flow_document_layout(&bundle, &manifest)
            .unwrap()
            .unwrap();
        assert_eq!(value.sections[0].page.width_twips, Some(w));
        assert_eq!(value.sections[0].page.height_twips, Some(h));
        assert_eq!(value.sections[0].headers, base.sections[0].headers);
        assert_eq!(value.stories, base.stories);
    }
    let current = read_flow_document_layout(&bundle, &head).unwrap().unwrap();
    let page = &current.sections[0].page;
    let field = |field, expected, value| FlowLayoutFieldChange {
        section_id: Some(current.sections[0].id.clone()),
        field,
        expected,
        value,
    };
    let request = FlowLayoutTransaction {
        schema_version: FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),
        document_id: initial.document_id.clone(),
        transaction_id: "e".repeat(32),
        base_revision: 6,
        expected_revision: 6,
        actor: BTreeMap::from([("userId".into(), "alice".into()), ("displayName".into(), "Alice 王 😀".into())]),
        edits: FlowLayoutEdits {
            schema_version: FLOW_LAYOUT_EDITS_SCHEMA.into(),
            base_layout_hash: flow_layout_hash(&current).unwrap(),
            changes: vec![
                field(
                    FlowLayoutField::Orientation,
                    json!(page.orientation),
                    json!("landscape"),
                ),
                field(
                    FlowLayoutField::MarginTop,
                    json!(page.margins_twips.get("top")),
                    json!(1440),
                ),
                field(
                    FlowLayoutField::NumberStart,
                    json!(page.number_start),
                    json!(7),
                ),
                field(
                    FlowLayoutField::NumberFormat,
                    json!(page.number_format),
                    json!("upperRoman"),
                ),
                field(
                    FlowLayoutField::DifferentFirstPage,
                    json!(current.sections[0].different_first_page),
                    json!(!current.sections[0].different_first_page),
                ),
                FlowLayoutFieldChange {
                    section_id: None,
                    field: FlowLayoutField::EvenAndOddHeaders,
                    expected: json!(current.even_and_odd_headers),
                    value: json!(!current.even_and_odd_headers),
                },
            ],
        },
    };
    assert_eq!(
        apply_flow_layout_transaction(&bundle, &request)
            .unwrap()
            .revision,
        7
    );
    let final_layout = read_flow_document_layout(&bundle, &bundle.manifest().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        final_layout.sections[0].page.margins_twips.get("top"),
        Some(&1440)
    );
    assert_eq!(
        final_layout.sections[0].page.number_format.as_deref(),
        Some("upperRoman")
    );
    assert_eq!(final_layout.stories, current.stories);
    assert!(validate_bundle(&bundle).unwrap().valid);
    let revision_path = bundle.root().join("revisions/00000000000000000007.json");
    let original = std::fs::read(&revision_path).unwrap();
    let mut corrupt: serde_json::Value = serde_json::from_slice(&original).unwrap();
    corrupt["wordLayoutChange"] = json!(false);
    std::fs::write(&revision_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
    assert!(!validate_bundle(&bundle).unwrap().valid);
    std::fs::write(&revision_path, original).unwrap();
    let manifest_path = bundle.root().join("manifest.json");
    let original = std::fs::read(&manifest_path).unwrap();
    let mut corrupt: serde_json::Value = serde_json::from_slice(&original).unwrap();
    corrupt["capabilities"]["wordLayoutEdits"] = json!(2);
    std::fs::write(&manifest_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
    assert!(matches!(bundle.manifest(), Err(HcdError::Unsupported(_))));
    std::fs::write(&manifest_path, original).unwrap();
    assert!(validate_bundle(&bundle).unwrap().valid);
    println!(
        "{}",
        json!({"base":4,"head":7,"firstRequest":first,"firstRecord":bundle.revision(5).unwrap(),"finalRequest":request,"finalRecord":bundle.revision(7).unwrap(),"widthBefore":width,"heightBefore":height,"widthAfter":width+20,"heightAfter":height+20,"firstPageAfter":final_layout.sections[0].different_first_page,"oddEvenAfter":final_layout.even_and_odd_headers,"idempotentReplay":true,"differentPayloadRejected":true,"conflictRejected":true,"staleHeadRejected":true,"contentIndexUnchanged":true,"tamperedHistoryRejected":true,"unknownModelRejected":true})
    );
}
