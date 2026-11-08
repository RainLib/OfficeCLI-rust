use hcd_core::{flow_layout_hash, plan_flow_layout_edits, FlowDocumentLayout, FlowLayoutEdits};
use serde_json::{json, Value};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let projection: Value = serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    let plans: Value = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    let base: FlowDocumentLayout = serde_json::from_value(projection["flowLayout"].clone()).unwrap();
    assert_eq!(projection["flowLayoutHash"].as_str(), Some(flow_layout_hash(&base).unwrap().as_str()));
    for key in ["section", "document", "marginSection", "marginDocument", "pageSection", "pageDocument"] {
        let edits: FlowLayoutEdits = serde_json::from_value(plans[key]["intent"].clone()).unwrap();
        let expected: FlowDocumentLayout = serde_json::from_value(plans[key]["preview"].clone()).unwrap();
        assert_eq!(plan_flow_layout_edits(&base, &base, &edits).unwrap(), expected);
        let mut changed = base.clone();
        if key.starts_with("margin") {
            changed.sections[0].page.margins_twips.insert("top".into(), 1300);
        } else {
            changed.sections[0].page.width_twips = Some(13000);
        }
        assert!(plan_flow_layout_edits(&base, &changed, &edits).is_err());
    }
    println!("{}", json!({"sectionAndDocumentPlansMatch":true,"marginPlansMatch":true,"combinedPagePlansMatch":true,"sameFieldConflictRejected":true,"sections":base.sections.len(),"writes":false}));
}
