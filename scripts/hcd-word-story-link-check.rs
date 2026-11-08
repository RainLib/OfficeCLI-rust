//! Verify a story-link transaction on a disposable HCD fixture only.
use hcd_core::{apply_flow_layout_transaction, apply_flow_story_link_transaction, flow_layout_hash, read_flow_document_layout, validate_bundle, Bundle, FlowLayoutEdits, FlowLayoutField, FlowLayoutFieldChange, FlowLayoutTransaction, FlowStoryKind, FlowStoryLinkRequest, FlowStoryLinkTransaction, FlowStoryVariant, FLOW_LAYOUT_EDITS_SCHEMA, FLOW_LAYOUT_TRANSACTION_SCHEMA, FLOW_STORY_LINK_TRANSACTION_SCHEMA};
use std::collections::BTreeMap;
fn main(){
 let bundle=Bundle::open(std::env::args().nth(1).unwrap()).unwrap();let before=bundle.manifest().unwrap();let layout=read_flow_document_layout(&bundle,&before).unwrap().unwrap();
 let direct=layout.sections[1].headers.even.clone().unwrap();
 let request=FlowStoryLinkTransaction{schema_version:FLOW_STORY_LINK_TRANSACTION_SCHEMA.into(),document_id:before.document_id.clone(),transaction_id:"a".repeat(32),expected_revision:before.revision,actor:BTreeMap::from([("userId".into(),"alice".into())]),link:FlowStoryLinkRequest{base_layout_hash:flow_layout_hash(&layout).unwrap(),section_id:layout.sections[1].id.clone(),kind:FlowStoryKind::Header,variant:FlowStoryVariant::Even,expected_direct_story_id:direct.clone()}};
 let result=apply_flow_story_link_transaction(&bundle,&request).unwrap();assert_eq!(result.revision,before.revision+1);assert!(!result.idempotent_replay);let after=bundle.manifest().unwrap();assert_eq!(after.capabilities.word_layout_edits,Some(2));let new=read_flow_document_layout(&bundle,&after).unwrap().unwrap();assert_eq!(new.sections[1].headers.even,None);assert_eq!(new.stories,layout.stories);assert!(validate_bundle(&bundle).unwrap().valid);
 let replay=apply_flow_story_link_transaction(&bundle,&request).unwrap();assert!(replay.idempotent_replay);assert_eq!(replay.revision,result.revision);
 let mut forged=request.clone();forged.link.expected_direct_story_id="n_00000000000000000000000000000000".into();assert!(apply_flow_story_link_transaction(&bundle,&forged).is_err());
 let mut stale=request.clone();stale.transaction_id="b".repeat(32);assert!(apply_flow_story_link_transaction(&bundle,&stale).is_err());
 let width=new.sections[0].page.width_twips.unwrap();
 let page=FlowLayoutTransaction{schema_version:FLOW_LAYOUT_TRANSACTION_SCHEMA.into(),document_id:before.document_id.clone(),transaction_id:"c".repeat(32),base_revision:result.revision,expected_revision:result.revision,actor:BTreeMap::from([("userId".into(),"alice".into())]),edits:FlowLayoutEdits{schema_version:FLOW_LAYOUT_EDITS_SCHEMA.into(),base_layout_hash:flow_layout_hash(&new).unwrap(),changes:vec![FlowLayoutFieldChange{section_id:Some(new.sections[0].id.clone()),field:FlowLayoutField::WidthTwips,expected:serde_json::json!(width),value:serde_json::json!(width+20)}]}};
 let later=apply_flow_layout_transaction(&bundle,&page).unwrap();assert_eq!(later.revision,result.revision+1);assert_eq!(bundle.manifest().unwrap().capabilities.word_layout_edits,Some(2));assert!(validate_bundle(&bundle).unwrap().valid);
 println!("{}",serde_json::json!({"revision":result.revision,"laterRevision":later.revision,"oldStory":direct,"replay":replay.idempotent_replay,"valid":true}));
}
