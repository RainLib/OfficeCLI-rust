import * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import {projectionToJson,type Block,type BlockContent,type Inline} from './schema.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {reconcileSourceIdentities} from './sourceIdentityMigration.ts'
import {captureSourceLeaf,sourceLeafActions,type SourceLeafBinding} from './semanticSourceBindings.ts'
export type StructureRootTarget={kind:'structure-root';key:string;owner:string;blockId:string|null;texts:string[];sourceIds:string[];bindings?:SourceLeafBinding[]}
export type SemanticSourceTarget=Y.XmlElement|StructureRootTarget
const inlineParts=(inlines:Inline[]):Inline[]=>inlines.flatMap(part=>[part,...(part.content?inlineParts(part.content.inlines):[])])
const parts=(content:BlockContent):BlockContent['inlines']=>[...inlineParts(content.inlines),...(content.children??[]).flatMap(parts)]
function textKeys(store:SemanticBlockStore,key:string,node:PmNode,seen=new Set<string>()):string[]{
 if(seen.has(key))throw new Error('invalidStructure');seen.add(key)
 if(node.isTextblock)return[key]
 return store.projectedChildren(key,node).flatMap(child=>textKeys(store,child.key,child.node,seen))
}
function target(store:SemanticBlockStore,key:string,node:PmNode):StructureRootTarget{
 const texts=textKeys(store,key,node),sourceIds=new Set<string>()
 for(const key of texts){const id=store.attributes.get(key)?.get('hcdSourceId');if(typeof id==='string')sourceIds.add(id);for(const carrier of new Set(store.flow.parts(key).map(part=>part.carrier))){const text=store.contents.get(carrier)?.get(0);if(!(text instanceof Y.XmlText))throw new Error('invalidStructure');for(const delta of text.toDelta()){const source=delta.attributes?.hcdSource as {nodeId?:string}|undefined;if(source?.nodeId)sourceIds.add(source.nodeId)}}}
 if(store.flow.containers)node.descendants(child=>{if(child.type.name!=='hcdExtensionInlineContainer')return;const text=store.flow.containers!.bodies.get(child.attrs.extension.instanceId);if(!(text instanceof Y.XmlText))throw new Error('invalidStructure');const id=text.getAttribute('hcdSourceId');if(typeof id==='string')sourceIds.add(id);for(const delta of text.toDelta()){const source=delta.attributes?.hcdSource as {nodeId?:string}|undefined;if(source?.nodeId)sourceIds.add(source.nodeId)}})
 const owner=node.attrs.hcdCanonicalKey;if(typeof owner!=='string')throw new Error('invalidCanonicalOwner');const blockId=node.attrs.hcdBlockId;return{kind:'structure-root',key,owner,blockId:typeof blockId==='string'?blockId:null,texts,sourceIds:[...sourceIds],bindings:texts.map(key=>captureSourceLeaf(store,key,store.content(key)))}
}
export function structureSourceTargets(store:SemanticBlockStore):SemanticSourceTarget[]{
 const result:StructureRootTarget[]=[]
 for(const {key,node} of store.blocks()){
  if(node.type.name==='bulletList'||node.type.name==='orderedList')for(const child of store.projectedChildren(key,node))result.push(target(store,child.key,child.node))
  else result.push(target(store,key,node))
 }
 return result
}
function expectedNode(block:Block,inlineContainers=false){let node=projectionToJson({documentId:'receipt',revision:0,blocks:[block]},inlineContainers?{inlineContainers:true}:{}).content?.[0];if(node?.type==='bulletList'||node?.type==='orderedList')node=node.content?.[0];return node}
/** Capture both the canonical owner and permanent text carriers. Wrapping and
 * unwrapping may transfer ownership while the canonical request is in flight. */
export function prepareStructureSources(store:SemanticBlockStore,captured:readonly SemanticSourceTarget[],canonical:readonly Block[]){
 if(captured.length!==canonical.length)throw new Error('Captured block recovery differs')
 const actions:Array<()=>void>=[],bindings:Array<()=>void>=[],allowed=new Set(canonical.flatMap(block=>parts(block.content).map(part=>part.nodeId)).filter(Boolean)),obsolete=new Set<string>(),xml:Y.XmlElement[]=[],xmlBlocks:Block[]=[]
 const committedOwners=new Set(captured.filter((entry):entry is StructureRootTarget=>!(entry instanceof Y.XmlElement)).map(entry=>entry.owner))
 // An owner absorbed into a quote/list is no longer a native root. Its stable
 // token survives, but a later lift must request a new native root ID rather
 // than submit an ID retired by this checkpoint. New provisional owners are
 // left alone when they were inserted after capture.
 for(const [owner,id] of store.canonicalIds)if(!committedOwners.has(owner)&&typeof id==='string'&&!id.startsWith('tmp_'))actions.push(()=>store.canonicalIds.set(owner,null))
 const defaults=(key:string,attrs:Record<string,unknown>|undefined)=>{const actual=store.attributes.get(key);if(!actual||!attrs)return;for(const name of ['hcdSourceId','hcdSourceTypography','hcdSourceSizeExplicit'])if(Object.hasOwn(attrs,name))actions.push(()=>actual.set(name,attrs[name]))}
 captured.forEach((entry,index)=>{
  if(entry instanceof Y.XmlElement){xml.push(entry);xmlBlocks.push(canonical[index]);return}
  const block=canonical[index],expected=expectedNode(block,!!store.flow.containers)
  for(const id of entry.sourceIds)if(!allowed.has(id))obsolete.add(id)
  actions.push(()=>store.canonicalIds.set(entry.owner,block.blockId))
  if(expected&&store.kinds.get(entry.key)===expected.type)defaults(entry.key,expected.attrs)
  const leaves:Array<NonNullable<typeof expected>>=[]
  const walk=(node:NonNullable<typeof expected>)=>{if(['paragraph','heading','codeBlock'].includes(node.type??''))leaves.push(node);else node.content?.forEach(walk)}
  if(expected)walk(expected)
  if(leaves.length===entry.texts.length)entry.texts.forEach((key,index)=>{defaults(key,leaves[index].attrs);bindings.push(...sourceLeafActions(store,key,store.schema.nodeFromJSON(leaves[index]),entry.bindings?.[index]))})
 })
 // Inline bodies can be removed before capture and still receive offline
 // edits afterwards. Their old IDs are absent from entry.sourceIds, but the
 // authoritative complete canonical response has retired them all the same.
 // New/late characters keep semantic formats; only obsolete source bindings
 // are cleared. IDs still present anywhere in this canonical response survive.
 const retired=(id:string)=>obsolete.has(id)||!!store.flow.containers&&!allowed.has(id)
 for(const [key,fragment] of store.contents){
  const attrs=store.attributes.get(key),id=attrs?.get('hcdSourceId')
  if(typeof id==='string'&&retired(id))actions.push(()=>{if(attrs?.get('hcdSourceId')===id)attrs.set('hcdSourceId',null)})
  if(!store.inline.get(key))continue
  const text=fragment.get(0);if(!(text instanceof Y.XmlText))throw new Error('invalidStructure');let offset=0
  for(const delta of text.toDelta()){
   const length=typeof delta.insert==='string'?delta.insert.length:1,start=offset,source=delta.attributes?.hcdSource as {nodeId?:string}|undefined
   if(source?.nodeId&&retired(source.nodeId))actions.push(()=>text.format(start,length,{hcdSource:null}));offset+=length
  }
 }
 if(store.flow.containers)for(const text of store.flow.containers.bodies.values()){
  const id=text.getAttribute('hcdSourceId');if(typeof id==='string'&&retired(id))actions.push(()=>{if(text.getAttribute('hcdSourceId')===id)text.setAttribute('hcdSourceId',null)})
  let offset=0
  for(const delta of text.toDelta()){const length=typeof delta.insert==='string'?delta.insert.length:1,start=offset,source=delta.attributes?.hcdSource as {nodeId?:string}|undefined;if(source?.nodeId&&retired(source.nodeId))actions.push(()=>text.format(start,length,{hcdSource:null}));offset+=length}
 }
 return (origin:unknown)=>{actions.forEach(action=>action());bindings.forEach(action=>action());if(xml.length)reconcileSourceIdentities(store.document,xml,xmlBlocks,origin,xml)}
}
export function reconcileStructureSources(store:SemanticBlockStore,captured:readonly SemanticSourceTarget[],canonical:readonly Block[],origin:unknown){
 const apply=prepareStructureSources(store,captured,canonical)
 store.document.transact(transaction=>{transaction.meta.set('addToHistory',false);apply(origin)},origin)
}
