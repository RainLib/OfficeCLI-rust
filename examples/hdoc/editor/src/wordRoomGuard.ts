/** Server packet admission. It validates an incremental shadow before the
 * Hocuspocus connection may mutate the authoritative regional model. */
import * as Y from 'yjs'
import {WordRegionStore,wordRegionStoreField} from './wordRegionStore.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {imageIntents,imageReceiptMap,imageDraftMap} from './collaborativeImages.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {referenceEditField} from './referenceEdits.ts'
import {deletionReviewField} from './deletionReview.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import type {Node as PmNode} from '@tiptap/pm/model'
const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const protectedFields=[wordRegionStoreField,'hcdSchema',semanticBlockFields.metadata,textFlowFields.metadata,imageReceiptMap]
const allowed=new Set([...protectedFields,...Object.values(semanticBlockFields),...Object.values(textFlowFields),imageDraftMap,...Object.values(nodeEditFields),referenceEditField,deletionReviewField,inlineDeletionField])
export function wordRoomGuard(model:WordRegionStore,imageRegion:(id:string)=>string|undefined,baseline?:{block:(id:string)=>string|undefined;text:(id:string)=>string|undefined},protocol:typeof wordRegionalProtocol|typeof wordLayoutProtocol=wordRegionalProtocol){
 if(protocol!==wordRegionalProtocol&&protocol!==wordLayoutProtocol)throw new Error('word-room-protocol-unsupported')
 const document=model.document
 return new RoomProtocolGuard(document,protocol,shadow=>{
  if(shadow.store.pendingStructs||shadow.store.pendingDs)throw new Error('word-room-incomplete-update')
  for(const field of protectedFields)if(ordered(shadow.getMap(field).toJSON())!==ordered(document.getMap(field).toJSON()))throw new Error('word-room-protected-metadata')
  for(const[field,value]of shadow.share)if(!allowed.has(field)&&(value instanceof Y.Map?value.size:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length:1))throw new Error('word-room-unknown-data')
  const canonical=document.getMap(semanticBlockFields.canonical),proposed=shadow.getMap(semanticBlockFields.canonical)
  for(const[key,value]of canonical)if(proposed.get(key)!==value)throw new Error('word-room-canonical-source')
  for(const[key,value]of proposed)if(!canonical.has(key)&&value!==null&&!(typeof value==='string'&&/^tmp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)))throw new Error('word-room-canonical-source')
  const layout=model.layoutState(),candidate=new WordRegionStore(shadow,model.schema,model.documentId,layout.layout,layout.layoutHash),before=model.capture(),after=candidate.capture()
  const keys=new Map<string,string>(),sources=new Map<string,string>(),blocks=new Map<string,string>(),opaque=new Map<string,PmNode>()
  const collect=(node:PmNode,region:string)=>{if(typeof node.attrs.hcdStructureKey==='string')keys.set(node.attrs.hcdStructureKey,region);if(typeof node.attrs.hcdBlockId==='string'&&node.attrs.hcdBlockId.startsWith('n_'))blocks.set(node.attrs.hcdBlockId,region);if(typeof node.attrs.hcdSourceId==='string')sources.set(node.attrs.hcdSourceId,region);for(const mark of node.marks)if(mark.type.name==='hcdSource')sources.set(mark.attrs.nodeId,region)}
  for(const region of before.regions)for(const block of model.region(region.regionId)){keys.set(block.key,region.regionId);collect(block.node,region.regionId);block.node.descendants(node=>collect(node,region.regionId));if(block.node.type.name==='hcdOpaque')opaque.set(block.key,block.node)}
  const seen=new Set<string>()
  for(const region of after.regions){
   for(const block of candidate.region(region.regionId)){
    if(keys.has(block.key)&&keys.get(block.key)!==region.regionId)throw new Error('word-room-cross-region')
    const original=opaque.get(block.key);if(original&&!original.eq(block.node))throw new Error('word-room-readonly-changed');seen.add(block.key)
    // Only the same retained, hidden carrier may recover an ID from the
    // canonical baseline. A newly fabricated block cannot borrow it.
    const priorBlocks=new Set<string>(),priorTexts=new Set<string>()
    if(!keys.has(block.key)&&model.structure.contents.has(block.key)&&model.structure.visibility.get(block.key)!==true){
     // Some retained split carriers are intentionally incomplete until the
     // candidate update arrives. They grant no baseline authority by default.
     try{const prior=model.structure.content(block.key),remember=(node:PmNode)=>{if(typeof node.attrs.hcdBlockId==='string')priorBlocks.add(node.attrs.hcdBlockId);if(typeof node.attrs.hcdSourceId==='string')priorTexts.add(node.attrs.hcdSourceId);for(const mark of node.marks)if(mark.type.name==='hcdSource')priorTexts.add(mark.attrs.nodeId)};remember(prior);prior.descendants(remember)}catch{priorBlocks.clear();priorTexts.clear()}
    }
    const valid=(map:Map<string,string>,id:string,known:string|undefined,prior:Set<string>)=>map.has(id)?map.get(id)===region.regionId:prior.has(id)&&known===region.regionId
    const validate=(node:PmNode)=>{const key=node.attrs.hcdStructureKey,id=node.attrs.hcdBlockId,source=node.attrs.hcdSourceId;if(typeof key==='string'&&keys.has(key)&&keys.get(key)!==region.regionId)throw new Error('word-room-cross-region');if(typeof id==='string'&&id.startsWith('n_')&&!valid(blocks,id,baseline?.block(id),priorBlocks))throw new Error('word-room-foreign-source');if(typeof source==='string'&&!valid(sources,source,baseline?.text(source),priorTexts))throw new Error('word-room-foreign-source');for(const mark of node.marks)if(mark.type.name==='hcdSource'&&!valid(sources,mark.attrs.nodeId,baseline?.text(mark.attrs.nodeId),priorTexts))throw new Error('word-room-foreign-source')}
    validate(block.node);block.node.descendants(validate)
   }
  }
  for(const key of opaque.keys())if(!seen.has(key))throw new Error('word-room-readonly-changed')
  for(const draft of imageIntents(shadow))if(!imageRegion(draft.base.nodeId))throw new Error('word-room-image-source')
 })
}
