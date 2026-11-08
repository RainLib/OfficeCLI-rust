import * as Y from 'yjs'
import type {Schema} from '@tiptap/pm/model'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {inlineProtocol} from './collaborationProtocol.ts'
import {SemanticBlockStore,semanticBlockFields} from './semanticBlockStore.ts'
import {textFlowFields} from './semanticTextFlow.ts'
import {inlineContainerFields} from './semanticInlineContainers.ts'
import {inlineContainerEditFields} from './inlineContainerEdits.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {referenceEditField} from './referenceEdits.ts'
import {deletionReviewField} from './deletionReview.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import {imageDraftMap,imageReceiptMap} from './collaborativeImages.ts'
const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
const protectedFields=['hcdSchema','hcdSave',semanticBlockFields.metadata,textFlowFields.metadata,imageReceiptMap]
const allowed=new Set([...protectedFields,...Object.values(semanticBlockFields),...Object.values(textFlowFields),...Object.values(inlineContainerFields),...Object.values(inlineContainerEditFields),...Object.values(nodeEditFields),referenceEditField,deletionReviewField,inlineDeletionField,imageDraftMap])
const itemId=(type:Y.AbstractType<any>)=>type._item?`${type._item.id.client}:${type._item.id.clock}`:null
/** Preserve immutable definitions, independent body identity and coordinator
 * metadata while admitting text and causal property/visibility operations. */
export function inlineRoomGuard(document:Y.Doc,schema:Schema){
 const original=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
 return new RoomProtocolGuard(document,inlineProtocol,(shadow,changed)=>{
  if(shadow.store.pendingStructs||shadow.store.pendingDs)throw new Error('inline-room-incomplete-update')
  for(const field of protectedFields)if(ordered(shadow.getMap(field).toJSON())!==ordered(document.getMap(field).toJSON()))throw new Error('inline-room-protected-metadata')
  for(const[field,value]of shadow.share)if(!allowed.has(field)&&(value instanceof Y.Map?value.size:value instanceof Y.Array||value instanceof Y.Text||value instanceof Y.XmlFragment?value.length:1))throw new Error('inline-room-unknown-data')
  const candidate=new SemanticBlockStore(shadow,schema,undefined,{inlineContainers:true}),before=original.flow.containers!,after=candidate.flow.containers!
  if(after.definitions.size!==after.bodies.size||after.bodies.size>10000)throw new Error('inline-room-body-table')
  for(const[id,value]of before.definitions)if(ordered(after.definitions.get(id))!==ordered(value))throw new Error('inline-room-definition-replaced')
  for(const[id,body]of before.bodies){const next=after.bodies.get(id);if(!(next instanceof Y.XmlText)||itemId(body)!==itemId(next)||ordered(body.getAttributes())!==ordered(next.getAttributes()))throw new Error('inline-room-body-replaced')}
  for(const[id,body]of after.bodies){if(!(body instanceof Y.XmlText))throw new Error('inline-room-body-table');if(!before.bodies.has(id)&&body.getAttribute('hcdSourceId')!=null)throw new Error('inline-room-foreign-source');if(!changed||!before.bodies.has(id)||changed.has(body))after.readBody(id)}
  for(const[key,value]of original.canonicalIds)if(candidate.canonicalIds.get(key)!==value)throw new Error('inline-room-canonical-source')
  for(const[key,value]of candidate.canonicalIds)if(!original.canonicalIds.has(key)&&value!==null&&!(typeof value==='string'&&/^tmp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)))throw new Error('inline-room-canonical-source')
  const projected=candidate.project();projected.check()
  const opaque=new Map(original.blocks().filter(block=>block.node.type.name==='hcdOpaque').map(block=>[block.key,block.node]))
  for(const block of candidate.blocks())if(opaque.has(block.key)){if(!opaque.get(block.key)!.eq(block.node))throw new Error('inline-room-readonly-changed');opaque.delete(block.key)}
  if(opaque.size)throw new Error('inline-room-readonly-changed')
 })
}
