import type * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {deletionReviewField,prepareDeletionBatch,prepareDeletionReceipt} from './deletionReview.ts'

function visibleNodes(store:SemanticBlockStore){
 const result=new Map<string,PmNode>()
 const walk=(key:string,node:PmNode)=>{result.set(key,node);for(const child of store.projectedChildren(key,node))walk(child.key,child.node)}
 store.blocks().forEach(block=>walk(block.key,block.node));return result
}
/** Preserve the permanent topology of creations hidden by this inverse. Yjs
 * normally removes their first visibility/placement references, which makes
 * an offline child's later edits impossible to project or restore. The filter
 * runs INSIDE the real inverse transaction, so its receipt and false root
 * visibility form the same undo/redo item, not a separate user action. */
export function prepareUndoneCreations(store:SemanticBlockStore,after:SemanticBlockStore){
 const before=visibleNodes(store),next=visibleNodes(after),keys=new Set<string>()
 for(const [key]of before)if(!next.has(key)&&after.visibility.get(key)===undefined&&!(after.flow.segments.has(key)&&after.flow.rootFor(key)!==key))keys.add(key)
 if(!keys.size)return undefined
 const roots=[...keys].filter(key=>!keys.has(store.placement.get(key)?.parent??'')),rootSet=new Set(roots)
 const receipts=prepareDeletionBatch(store,roots.map(key=>({key,node:before.get(key)!})))
 return{recapture(after:SemanticBlockStore){
  for(const entry of receipts){let node:PmNode;try{node=after.content(entry.key)}catch(error){if(error instanceof Error&&error.message==='missingBlock')continue;throw error}entry.receipt={...entry.receipt,snapshot:prepareDeletionReceipt(after,entry.key,node).snapshot}}
 },filterFor(target:SemanticBlockStore,original:(item:Y.Item)=>boolean){
  const orders=new Set<Y.AbstractType<any>>([target.order,...target.children.values()])
  let installed=false
  return(item:Y.Item)=>{
   if(!original(item))return false
   const key=item.parentSub
   if(item.parent===target.visibility&&typeof key==='string'&&keys.has(key)){
    if(!rootSet.has(key))return false
    if(!installed){installed=true;for(const {key,receipt}of receipts)target.document.getMap(deletionReviewField).set(key,receipt)}
    if(target.visibility.get(key)!==false)target.visibility.set(key,false)
    // set(false) already deletes the old true Item; returning true still lets
    // Yjs count this inverse as performed and move exactly this history item.
    return true
   }
   if(item.parent===target.placement&&typeof key==='string'&&keys.has(key))return false
   // Order references are append-only anchors. A packed Item may also retain
   // inactive references for another key; active placement still selects one.
   if(orders.has(item.parent as Y.AbstractType<any>)&&item.content.getContent().some((entry:unknown)=>!!entry&&typeof entry==='object'&&'key'in entry&&typeof entry.key==='string'&&keys.has(entry.key)))return false
   return true
  }
 }}
}
