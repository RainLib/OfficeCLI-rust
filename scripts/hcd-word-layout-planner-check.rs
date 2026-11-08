use hcd_core::{
    flow_layout_hash, plan_flow_layout_edits, FlowDocumentLayout, FlowLayoutEdits, FlowLayoutField,
    FlowLayoutFieldChange, FLOW_LAYOUT_EDITS_SCHEMA,
};
use serde_json::{json, Value};
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let bytes = std::fs::read(path).unwrap();
    let projection: Value = serde_json::from_slice(&bytes).unwrap();
    let base: FlowDocumentLayout =
        serde_json::from_value(projection["flowLayout"].clone()).unwrap();
    let hash = flow_layout_hash(&base).unwrap();
    assert_eq!(projection["flowLayoutHash"].as_str(), Some(hash.as_str()));
    let width = base.sections[0].page.width_twips.unwrap();
    let mut peer = base.clone();
    let height = peer.sections[0].page.height_twips.unwrap() + 20;
    peer.sections[0].page.height_twips = Some(height);
    let request = FlowLayoutEdits {
        schema_version: FLOW_LAYOUT_EDITS_SCHEMA.into(),
        base_layout_hash: hash.clone(),
        changes: vec![FlowLayoutFieldChange {
            section_id: Some(base.sections[0].id.clone()),
            field: FlowLayoutField::WidthTwips,
            expected: json!(width),
            value: json!(width + 20),
        }],
    };
    let merged = plan_flow_layout_edits(&base, &peer, &request).unwrap();
    assert_eq!(merged.sections[0].page.width_twips, Some(width + 20));
    assert_eq!(merged.sections[0].page.height_twips, Some(height));
    peer.sections[0].page.width_twips = Some(width + 40);
    assert!(plan_flow_layout_edits(&base, &peer, &request).is_err());
    println!(
        "{}",
        json!({"revision":projection["revision"],"baseLayoutHash":hash,"sections":base.sections.len(),"disjointMerge":true,"sameFieldRejected":true,"writes":false})
    );
}
