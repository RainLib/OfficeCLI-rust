//! Creates only a disposable native fixture for sidecar recovery verification.
use std::{collections::BTreeMap,path::Path};
use hcd_core::{Bundle,FlowStory,FlowStoryKind,FlowStoryVariant,FlowStoryUnlinkRequest};
fn main(){
 let args:Vec<String>=std::env::args().collect();let source=Path::new(&args[1]);let path=Path::new(&args[2]);
 let mut options=hcd_docx::ImportOptions::new("doc");options.flow_layout=true;
 hcd_docx::import_docx(source,path,&options,|_|Ok(())).unwrap();let bundle=Bundle::open(path).unwrap();hcd_core::project_flow_regions(&bundle,0).unwrap();
 if args.get(3).is_some_and(|value|value=="multi") {
  let projection=hcd_core::editor_projection(&bundle,Some(1)).unwrap();let source_story=projection.flow_layout.as_ref().unwrap().sections[0].headers.first.as_ref().unwrap();
  let inline=projection.blocks.iter().filter(|block|block.flow_region_id.as_ref()==Some(source_story)).flat_map(|block|block.content.inlines.iter()).find(|inline|inline.node_id.is_some()&&inline.text.chars().count()>2).unwrap();
  let id=inline.node_id.clone().unwrap();let node=hcd_core::get_text_node(&bundle,&id).unwrap();let length=node.node.text.chars().count();
  let patch=hcd_core::PatchBatch{schema_version:hcd_core::HCD_PATCH_SCHEMA_VERSION_5.into(),document_id:"doc".into(),patch_id:"multi-size".into(),base_revision:1,actor:Default::default(),operations:vec![hcd_core::PatchOperation::TextRuns{node_id:id,text:node.node.text.clone(),runs:vec![hcd_core::FontSizeRun{chars:2,size_pt:Some(12.0)},hcd_core::FontSizeRun{chars:length-2,size_pt:Some(18.0)}],precondition:hcd_core::TextRunsPrecondition{node_hash:node.node.node_hash,format_hash:node.format_hash.unwrap()}}],metadata:Default::default()};
  hcd_core::apply_patch(&bundle,&patch,1).unwrap();
 }
 let revision=bundle.manifest().unwrap().revision;let previous=hcd_core::editor_projection(&bundle,Some(revision)).unwrap();let layout=previous.flow_layout.as_ref().unwrap();
 let intent=FlowStoryUnlinkRequest{base_layout_hash:previous.flow_layout_hash.clone().unwrap(),section_id:layout.sections[1].id.clone(),kind:FlowStoryKind::Header,variant:FlowStoryVariant::First,expected_inherited_story_id:layout.sections[0].headers.first.clone()};
 let story=FlowStory{id:format!("n_{:032x}",999991),kind:FlowStoryKind::Header,source_part:"word/real-recovery.xml".into()};
 let candidate=hcd_docx::prepare_source_story_unlink(&bundle,source,revision,&intent,&story,|_|unreachable!(),|_|unreachable!()).unwrap();
 let commitment=candidate.prepared.commitment().unwrap();let blocks=candidate.prepared.blocks.clone();let base=bundle.revision(revision).unwrap();
 let actor=BTreeMap::from([("userId".into(),"alice".into()),("displayName".into(),"Alice".into())]);let transaction="e".repeat(32);
 let choices=candidate.prepared.copy_choices().unwrap();
 let prepared=args.get(3).is_some_and(|value|value=="prepared");
 let (next,final_revision)=if prepared{(None,revision)}else{let result=hcd_core::apply_prepared_story_unlink(&bundle,&candidate.prepared,&transaction,&actor).unwrap();(Some(hcd_core::editor_projection(&bundle,Some(result.revision)).unwrap()),result.revision)};
 let value=serde_json::json!({"multi":args.get(3).is_some_and(|value|value=="multi"),"previous":previous,"next":next,"baseRoot":base.root_hash,"pending":{"request":{"documentId":"doc","transactionId":transaction,"expectedRevision":revision,"baseLayoutHash":intent.base_layout_hash,"candidateHash":commitment,"actor":actor},"actor":{"userId":"alice","displayName":"Alice","generation":1},"intent":{"sectionId":intent.section_id,"kind":"header","variant":"first","expectedInheritedStoryId":intent.expected_inherited_story_id},"story":story,"blocks":blocks,"copyChoices":choices},"revision":final_revision});
 println!("{}",value);
}
