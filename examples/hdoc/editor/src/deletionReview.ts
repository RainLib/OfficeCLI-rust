import {inlineContainerEditIndex,inlineContainerNodes} from './inlineContainerEdits.ts'
import type * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {extensionEditIndex} from './extensionEdits.ts'
import {extensionNodes,readExtensionNode} from './extensionNode.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {protectedBlock} from './commands/blocks.ts'
import {documentReferences,referenceEditIndex} from './referenceEdits.ts'
import {inlineDeletionReviews,inlineDeletionOwner,resolveInlineDeletionReview,validateInlineDeletionReceipts} from './inlineDeletionReview.ts'

/** A deletion hides a permanent subtree; it never destroys its text carrier.
 * The exact reviewed content is retained independently of canonical save IDs.
 * Later/offline edits therefore reopen review even after the deletion saved. */
export const deletionReviewField='hcd-semantic-deletions/1'
export type DeletionReceipt={version:1;id:string;snapshot:string}
export type DeletionReview={key:string;receipt:DeletionReceipt|null;snapshot:string;node:PmNode;inline?:boolean;restoreAtEnd?:boolean}
const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
function publicNode(node:PmNode):unknown{
 const attrs=Object.fromEntries(Object.entries(node.attrs).filter(([name])=>!name.startsWith('hcdSource')&&!['hcdBlockId','hcdStructureKey','hcdCanonicalKey'].includes(name)))
 const marks=node.marks.filter(mark=>mark.type.name!=='hcdSource').map(mark=>mark.toJSON())
 return{type:node.type.name,attrs,marks,...(node.isText?{text:node.text}:{content:node.content.content.map(publicNode)})}
}
export function deletionSnapshot(store:SemanticBlockStore,node:PmNode):string{
 const extensions=extensionNodes(node),references=documentReferences(node)
 if(node.attrs.extension?.instanceId)extensions.set(node.attrs.extension.instanceId,{value:node.attrs.extension,position:0,marks:'',content:''})
 const inline=store.flow.containers?inlineContainerNodes(node):new Map()
 const snapshot=stable({node:publicNode(node),nodes:[...extensionEditIndex(store.document),...(store.flow.containers?[...inlineContainerEditIndex(store.document)].filter(([id])=>inline.has(id)):[])].filter(([id])=>extensions.has(id)||inline.has(id)).map(([id,group])=>[id,group.ids,group.ready,Object.keys(group.conflicts).sort()]).sort(),references:[...referenceEditIndex(store.document)].filter(([id])=>references.has(id)).map(([id,group])=>[id,group.ids]).sort()})
 return snapshot
}
export function validateDeletionReceipts(document:Y.Doc){
 validateInlineDeletionReceipts(document)
 const map=document.getMap(deletionReviewField);if(map.size>2048)throw new Error('deletion-review-limit')
 for(const [key,raw]of map){const value=raw as DeletionReceipt
  if(typeof key!=='string'||key.length>128||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='id,snapshot,version'||value.version!==1||typeof value.id!=='string'||!/^d_[a-f0-9]{32}$/.test(value.id)||typeof value.snapshot!=='string'||new TextEncoder().encode(value.snapshot).length>1_048_576)throw new Error('deletion-review-schema')
  try{const parsed=JSON.parse(value.snapshot);if(!parsed||Object.keys(parsed).sort().join(',')!=='node,nodes,references'||!parsed.node||!Array.isArray(parsed.nodes)||!Array.isArray(parsed.references)||stable(parsed)!==value.snapshot)throw new Error()}catch{throw new Error('deletion-review-schema')}
 }
}
export function prepareDeletionReceipt(store:SemanticBlockStore,key:string,node:PmNode):DeletionReceipt{
 const map=store.document.getMap(deletionReviewField);if(!map.has(key)&&map.size>=2048)throw new Error('deletion-review-limit')
 const snapshot=deletionSnapshot(store,node);if(new TextEncoder().encode(snapshot).length>1_048_576)throw new Error('deletion-review-limit')
 return{version:1,id:`d_${crypto.randomUUID().replaceAll('-','')}`,snapshot}
}
export function prepareDeletionBatch(store:SemanticBlockStore,items:readonly {key:string;node:PmNode}[]){
 const map=store.document.getMap(deletionReviewField)
 if(map.size+new Set(items.filter(item=>!map.has(item.key)).map(item=>item.key)).size>2048)throw new Error('deletion-review-limit')
 return items.map(({key,node})=>({key,receipt:prepareDeletionReceipt(store,key,node)}))
}
/** Missing receipts from pre-feature rooms need explicit review, never a
 * guessed baseline that would bless already hidden offline content. */
export function deletionReviews(store:SemanticBlockStore):DeletionReview[]{
 if(!store.initialized)return[]
 validateDeletionReceipts(store.document)
 const reviews:DeletionReview[]=[],map=store.document.getMap<DeletionReceipt>(deletionReviewField)
 for(const [key,visible]of store.visibility){
  if(visible||key===store.metadata.get('emptyRoot')||store.flow.segments.has(key)&&store.flow.rootFor(key)!==key)continue
  let parent=store.placement.get(key)?.parent,covered=false;const visited=new Set([key])
  while(parent){if(visited.has(parent))throw new Error('deletion-review-schema');visited.add(parent);if(store.visibility.get(parent)===false){covered=true;break}parent=store.placement.get(parent)?.parent}
  if(covered)continue
  let node:PmNode
  try{node=store.content(key)}catch(error){if(error instanceof Error&&error.message==='missingBlock')continue;throw error}
  const receipt=map.get(key)??null,snapshot=deletionSnapshot(store,node)
  if(!receipt||receipt.snapshot!==snapshot)reviews.push({key,receipt,snapshot,node})
 }
 return [...reviews,...inlineDeletionReviews(store)]
}
/** A known child cannot grant authority through an unloaded outer codec. */
export function canConfirmDeletion(store:SemanticBlockStore,group:DeletionReview,registry:NodeExtensionRegistry,inline?:InlineContainerRegistry){
 try{
  if(protectedBlock(group.node,registry,inline))return false
  const key=group.inline?inlineDeletionOwner(store,group.key):group.key
  const visited=new Set<string>();let parent=key
  while(parent){if(visited.has(parent))return false;visited.add(parent);const node=store.content(parent);if(node.attrs.extension&&!registry.resolve(readExtensionNode(node.attrs.extension)))return false;parent=store.placement.get(parent)?.parent??null}
  return true
 }catch{return false}
}
/** A wrapper can have lent its canonical owner back to an unwrapped live
 * paragraph. Restoring only its late children must request an independent
 * native root instead of claiming that paragraph's existing identity. */
function restoredOwners(store:SemanticBlockStore,key:string,node:PmNode){
 if(store.placement.get(key)?.parent!==null)return[]
 const slots=(key:string,node:PmNode)=>['bulletList','orderedList'].includes(node.type.name)?store.childKeys(key):[key]
 const active=new Set(store.blocks().flatMap(block=>['bulletList','orderedList'].includes(block.node.type.name)?store.projectedChildren(block.key,block.node):[block]).map(block=>block.node.attrs.hcdCanonicalKey).filter((owner):owner is string=>typeof owner==='string'))
 const changes:Array<{key:string;owner:string}>=[]
 for(const slot of slots(key,node)){
  const owner=store.owners.get(slot)
  if(typeof owner==='string'&&!active.has(owner)){active.add(owner);continue}
  let fresh=slot,index=0;while(active.has(fresh))fresh=`restore_${slot}_${++index}`
  active.add(fresh);changes.push({key:slot,owner:fresh})
 }
 return changes
}
/** Compare both the reviewed receipt and complete current content at commit.
 * Restore wins over a concurrent keep-deleted decision: keep never re-hides. */
export function resolveDeletionReview(store:SemanticBlockStore,expected:Pick<DeletionReview,'key'|'receipt'|'snapshot'>,choice:'restore'|'delete'){
 if(expected.key.startsWith('inline:'))return resolveInlineDeletionReview(store,expected,choice)
 const current=deletionReviews(store).find(group=>group.key===expected.key)
 if(!current||stable(current.receipt)!==stable(expected.receipt)||current.snapshot!==expected.snapshot)throw new Error('deletion-review-changed')
 const receipt=choice==='delete'?prepareDeletionReceipt(store,current.key,current.node):undefined
 const owners=choice==='restore'?restoredOwners(store,current.key,current.node):[]
 store.document.transact(()=>{if(receipt)store.document.getMap(deletionReviewField).set(current.key,receipt);if(choice==='restore'){for(const change of owners){store.owners.set(change.key,change.owner);store.canonicalIds.set(change.owner,null)}store.visibility.set(current.key,true)}},store.origin)
}
