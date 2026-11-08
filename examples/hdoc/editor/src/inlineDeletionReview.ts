import {Transform} from '@tiptap/pm/transform'
import {inlineContainerNodeName,readInlineContainerPayload} from './inlineContainerPayload.ts'
import type * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import type {TextFlowPoint} from './semanticTextFlow.ts'
import {deletionSnapshot,type DeletionReview} from './deletionReview.ts'
import {readExtensionNode} from './extensionNode.ts'
import {readInlineReference} from './inlineReference.ts'
import {extensionEditIndex,storageExtensionNode,projectExtensionEdits} from './extensionEdits.ts'
import {referenceEditIndex,storageReferenceNode,projectReferenceEdits} from './referenceEdits.ts'
import {validateSemanticNodeJson} from './semanticInlineContent.ts'

export const inlineDeletionField='hcd-semantic-inline-deletions/1'
type JsonNode={type:string;attrs:Record<string,unknown>;marks?:Array<{type:string;attrs?:Record<string,unknown>}>}
export type InlineDeletionReceipt={version:1|2;id:string;point:TextFlowPoint;neighbors:{left:string|null;right:string|null};node:JsonNode;snapshot:string}
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
function identity(node:{type:string;attrs:Record<string,unknown>}){
 if(node.type===inlineContainerNodeName)return `inline:node:${readInlineContainerPayload(node.attrs.extension).instanceId}`
 if(node.type==='hcdExtensionInline')return `inline:node:${readExtensionNode(node.attrs.extension).instanceId}`
 if(node.type==='hcdMention')return `inline:mention:${readInlineReference(node.attrs.reference).mentionId}`
 throw new Error('deletion-review-schema')
}
function atomIdentity(node:PmNode){return ['hcdExtensionInline','hcdMention',inlineContainerNodeName].includes(node.type.name)?identity({type:node.type.name,attrs:node.attrs}):null}
function activeIdentities(doc:PmNode){const ids=new Set<string>();doc.descendants(node=>{const id=atomIdentity(node);if(id){if(ids.has(id))throw new Error('deletion-review-schema');ids.add(id)}});return ids}
const wrap=(store:SemanticBlockStore,node:PmNode)=>store.schema.nodes.paragraph.createChecked(null,node)
function projected(store:SemanticBlockStore,record:InlineDeletionReceipt){
 let node:PmNode
 if(record.version===2){
  const payload=readInlineContainerPayload(record.node.attrs.extension),containers=store.flow.containers
  if(!containers||stable(containers.definitions.get(payload.instanceId)?.node.attrs.extension)!==stable(payload))throw new Error('deletion-review-schema')
  // A tombstone contains only the immutable identity/definition. Its body,
  // properties, source defaults and nested references are always read live.
  node=containers.readBody(payload.instanceId)
 }else{validateSemanticNodeJson(record.node,store.schema);node=store.schema.nodeFromJSON(record.node);node.check()}
 return projectReferenceEdits(projectExtensionEdits(node,extensionEditIndex(store.document)),referenceEditIndex(store.document))
}
function receipt(raw:unknown,key:string):InlineDeletionReceipt{
 const v=raw as InlineDeletionReceipt,id=(raw:unknown)=>!!raw&&typeof raw==='object'&&Object.keys(raw).sort().join(',')==='client,clock'&&['client','clock'].every(name=>Number.isSafeInteger((raw as Record<string,number>)[name])&&(raw as Record<string,number>)[name]>=0)
 if(!v||Object.keys(v).sort().join(',')!=='id,neighbors,node,point,snapshot,version'||![1,2].includes(v.version)||(v.version===2)!==(v.node?.type===inlineContainerNodeName)||!/^d_[a-f0-9]{32}$/.test(v.id)||!v.neighbors||Object.keys(v.neighbors).sort().join(',')!=='left,right'||Object.values(v.neighbors).some(value=>value!==null&&(typeof value!=='string'||!/^inline:(?:node:x_|mention:m_)[a-f0-9]{32}$/.test(value)||value===key))||!v.point||Object.keys(v.point).sort().join(',')!=='carrier,relative'||typeof v.point.carrier!=='string'||!v.point.carrier.length||v.point.carrier.length>128||!v.point.relative||typeof v.point.relative!=='object'||Array.isArray(v.point.relative)||Object.keys(v.point.relative).some(name=>!['type','tname','item','assoc'].includes(name))||(v.point.relative.type===undefined)===(v.point.relative.tname===undefined)||v.point.relative.type!==undefined&&!id(v.point.relative.type)||v.point.relative.item!==undefined&&!id(v.point.relative.item)||v.point.relative.tname!==undefined&&(typeof v.point.relative.tname!=='string'||!v.point.relative.tname.length||v.point.relative.tname.length>256)||v.point.relative.assoc!==undefined&&!Number.isSafeInteger(v.point.relative.assoc)||!v.node||Object.keys(v.node).some(name=>!['type','attrs','marks'].includes(name))||!v.node.attrs||Object.keys(v.node.attrs).join(',')!==(v.node.type==='hcdMention'?'reference':'extension')||identity(v.node)!==key||v.version===2&&v.node.marks!==undefined||v.node.marks!==undefined&&(!Array.isArray(v.node.marks)||v.node.marks.some(mark=>!mark||Object.keys(mark).some(name=>!['type','attrs'].includes(name))||typeof mark.type!=='string'||['hcdSource','code','link'].includes(mark.type)))||typeof v.snapshot!=='string'||new TextEncoder().encode(v.snapshot).length>1_048_576)throw new Error('deletion-review-schema')
 try{const parsed=JSON.parse(v.snapshot);if(!parsed||Object.keys(parsed).sort().join(',')!=='node,nodes,references'||!parsed.node||!Array.isArray(parsed.nodes)||!Array.isArray(parsed.references)||stable(parsed)!==v.snapshot)throw new Error()}catch{throw new Error('deletion-review-schema')}
 return v
}
export function validateInlineDeletionReceipts(document:Y.Doc){const map=document.getMap(inlineDeletionField);if(map.size>2048)throw new Error('deletion-review-limit');let bytes=0;for(const [key,raw]of map){receipt(raw,key);bytes+=JSON.stringify(raw).length;if(bytes>16_000_000)throw new Error('deletion-review-limit')}}
/** Only occurrences removed from retained text are recorded here. Whole hidden
 * subtrees keep their existing block receipt; moving the atom is not deletion. */
export function prepareInlineDeletions(store:SemanticBlockStore,next:PmNode,retained:(key:string)=>boolean){
 const active=activeIdentities(next),records:Array<{key:string;receipt:InlineDeletionReceipt}>=[],nodes=extensionEditIndex(store.document),references=referenceEditIndex(store.document)
 const text=(key:string,parent:PmNode,base=0)=>parent.forEach((child,offset,index)=>{
  const id=atomIdentity(child)
  if(id&&!active.has(id)){
   const container=child.type.name===inlineContainerNodeName
   if(container&&!store.flow.containers)throw new Error('deletion-review-schema')
   const {marks:_marks,...json}=child.toJSON(),marks=child.marks.filter(mark=>mark.type.name!=='hcdSource').map(mark=>mark.toJSON())
   const raw=container?{type:inlineContainerNodeName,attrs:{extension:store.flow.containers!.definitions.get(child.attrs.extension.instanceId)!.node.attrs.extension}}:storageReferenceNode(storageExtensionNode({...json,...(marks.length?{marks}:{})} as JsonNode,nodes),references) as JsonNode
   const snapshot=deletionSnapshot(store,wrap(store,child));if(new TextEncoder().encode(snapshot).length>1_048_576)throw new Error('deletion-review-limit')
   const record:InlineDeletionReceipt={version:container?2:1,id:`d_${crypto.randomUUID().replaceAll('-','')}`,point:store.flow.capture(key,base+offset,-1),neighbors:{left:index?atomIdentity(parent.child(index-1)):null,right:index+1<parent.childCount?atomIdentity(parent.child(index+1)):null},node:raw,snapshot}
   receipt(record,id);records.push({key:id,receipt:record});return
  }
  // Nested inline scopes need their own stable carrier coordinates. Removing
  // an outer wrapper records that subtree once rather than all descendants.
  if(store.flow.containers&&child.type.name===inlineContainerNodeName)text(key,child,base+offset+1)
 })
 const visit=(key:string,node:PmNode)=>{if(node.isTextblock){if(retained(key))text(key,node)}else for(const child of store.projectedChildren(key,node))visit(child.key,child.node)}
 store.blocks().forEach(block=>visit(block.key,block.node));const map=store.document.getMap(inlineDeletionField)
 if(map.size+new Set(records.filter(record=>!map.has(record.key)).map(record=>record.key)).size>2048||[...map.entries()].filter(([key])=>!records.some(record=>record.key===key)).reduce((sum,[,value])=>sum+JSON.stringify(value).length,0)+records.reduce((sum,record)=>sum+JSON.stringify(record.receipt).length,0)>16_000_000)throw new Error('deletion-review-limit')
 return records
}
export function prepareInlineHistoryDeletions(store:SemanticBlockStore,after:SemanticBlockStore){
 const visible=new Set<string>(),walk=(key:string,node:PmNode)=>{if(node.isTextblock)visible.add(key);else for(const child of after.projectedChildren(key,node))walk(child.key,child.node)};after.blocks().forEach(block=>walk(block.key,block.node))
 return prepareInlineDeletions(store,after.project(),key=>visible.has(key)).map(entry=>({...entry,receipt:{...entry.receipt,snapshot:deletionSnapshot(after,wrap(after,projected(after,entry.receipt)))}}))
}
/** Capture a tombstone in the same inverse, without keeping a deleted embed
 * visible or introducing a second user history action. */
export function inlineHistoryDeletionFilter(store:SemanticBlockStore,records:ReturnType<typeof prepareInlineDeletions>,original:(item:Y.Item)=>boolean){
 if(!records.length)return original
 const map=store.document.getMap(inlineDeletionField),keys=new Set(records.map(record=>record.key));let installed=false
 return(item:Y.Item)=>{if(!original(item))return false;if(!installed){installed=true;records.forEach(record=>map.set(record.key,record.receipt))}return !(item.parent===map&&typeof item.parentSub==='string'&&keys.has(item.parentSub))}
}
function location(store:SemanticBlockStore,record:InlineDeletionReceipt){
 let point:ReturnType<SemanticBlockStore['flow']['resolve']>;try{point=store.flow.resolve(record.point)}catch{return null}if(!point)return null;let found:PmNode|undefined
 const walk=(key:string,node:PmNode)=>{if(key===point.root)found=node;else for(const child of store.projectedChildren(key,node))walk(child.key,child.node)};store.blocks().forEach(block=>walk(block.key,block.node))
 if(!found?.isTextblock)return null
 let position:ReturnType<PmNode['resolve']>;try{position=found.resolve(point.offset)}catch{return null}
 const scope=position.parent,base=position.start(position.depth)
 if(!scope.inlineContent||scope!==found&&scope.type.name!==inlineContainerNodeName)return null
 const positions=new Map<string,{offset:number;size:number}>();scope.forEach((node,offset)=>{const id=atomIdentity(node);if(id)positions.set(id,{offset,size:node.nodeSize})})
 let ambiguous=false;const active=activeIdentities(store.project()),map=store.document.getMap(inlineDeletionField),neighbor=(direction:'left'|'right')=>{let key=record.neighbors[direction];const visited=new Set<string>();while(key){if(visited.has(key)){ambiguous=true;return}visited.add(key);const at=positions.get(key);if(at!==undefined)return at.offset+(direction==='left'?at.size:0);if(active.has(key))return;const raw=map.get(key);if(!raw)return;key=receipt(raw,key).neighbors[direction]}}
 const left=neighbor('left')??0,right=neighbor('right')??scope.content.size;if(ambiguous||left>right)return null
 const offset=base+Math.max(left,Math.min(point.offset-base,right))
 try{new Transform(found).insert(offset,projected(store,record)).doc.check();return{root:point.root,offset,node:found}}catch{return null}
}
/** A prior inline tombstone can be covered by a later whole-block deletion or
 * by a removed outer container which still contains it. Review the subtree once. */
function coveredIdentities(store:SemanticBlockStore,active:Set<string>){
 const covered=new Set<string>()
 for(const [key,visible]of store.visibility)if(!visible&&key!==store.metadata.get('emptyRoot')){let node:PmNode;try{node=store.content(key)}catch(error){if(error instanceof Error&&error.message==='missingBlock')continue;throw error}for(const id of activeIdentities(node))covered.add(id)}
 if(store.flow.containers)for(const [key,raw]of store.document.getMap(inlineDeletionField)){const record=receipt(raw,key);if(record.version!==2||active.has(key))continue;for(const id of activeIdentities(projected(store,record)))covered.add(id)}
 return covered
}

export function inlineDeletionReviews(store:SemanticBlockStore):DeletionReview[]{
 validateInlineDeletionReceipts(store.document);const active=activeIdentities(store.project()),covered=coveredIdentities(store,active),groups:DeletionReview[]=[]
 for(const [key,raw]of store.document.getMap(inlineDeletionField)){if(active.has(key)||covered.has(key))continue;const record=receipt(raw,key),node=wrap(store,projected(store,record)),snapshot=deletionSnapshot(store,node);if(snapshot!==record.snapshot)groups.push({key,receipt:{version:1,id:record.id,snapshot:record.snapshot},node,snapshot,inline:true,restoreAtEnd:!location(store,record)})}
 return groups
}
export function inlineDeletionOwner(store:SemanticBlockStore,key:string){const raw=store.document.getMap(inlineDeletionField).get(key);if(!raw)return null;const point=receipt(raw,key).point;try{return store.flow.resolve(point)?.root??point.carrier}catch{return point.carrier}}
/** Low-level operation. Product restores run on the owning coordinator so two
 * concurrent requests cannot insert the same occurrence twice. */
export function resolveInlineDeletionReview(store:SemanticBlockStore,expected:Pick<DeletionReview,'key'|'receipt'|'snapshot'>,choice:'restore'|'delete'){
 const raw=store.document.getMap(inlineDeletionField).get(expected.key);if(!raw)throw new Error('deletion-review-changed');const record=receipt(raw,expected.key)
 if(choice==='restore'&&record.id===expected.receipt?.id&&activeIdentities(store.project()).has(expected.key))return false
 const current=inlineDeletionReviews(store).find(group=>group.key===expected.key)
 if(!current||stable(current.receipt)!==stable(expected.receipt)||current.snapshot!==expected.snapshot)throw new Error('deletion-review-changed')
 if(choice==='delete'){if(new TextEncoder().encode(current.snapshot).length>1_048_576)throw new Error('deletion-review-limit');store.document.transact(()=>store.document.getMap(inlineDeletionField).set(expected.key,{...record,snapshot:current.snapshot}),store.origin);return true}
 const atom=projected(store,record),at=location(store,record)
 if(at)store.update(at.root,at.node,new Transform(at.node).insert(at.offset,atom).doc)
 else store.insert([wrap(store,atom)],null)
 return true
}
