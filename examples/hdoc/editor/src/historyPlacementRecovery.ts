import * as Y from 'yjs'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
type Placement=NonNullable<ReturnType<SemanticBlockStore['placement']['get']>>
export type PlacementRecovery={key:string;value:Placement}
/** A map undo can remove a winning local placement without reviving the
 * concurrent foreign value (its map content may already be GC'd). Permanent
 * order anchors still prove the exact foreign position. Do not guess when
 * split/boundary metadata was GC'd; the normal history guard then rejects. */
export function recoverConcurrentPlacements(before:SemanticBlockStore,after:SemanticBlockStore,owner:number):PlacementRecovery[]{
 const missing=new Set([...after.visibility].filter(([key,visible])=>visible&&!after.placement.has(key)).map(([key])=>key));if(!missing.size)return[]
 const anchors=new Map<string,{key:string;parent:string|null;reference:string;simple:boolean}>();let work=0
 for(const [parent,sequence]of [[null,after.order],...after.children] as Array<[string|null,Y.Array<{key:string;reference:string}>]>){
  const values=sequence.toArray(),simple=values.every(entry=>!after.flow.segments.get(entry.key)?.boundary)
  for(let item=sequence._start;item;item=item.right){if(item.deleted||!item.countable)continue;item.content.getContent().forEach((entry:unknown,index:number)=>{if(++work>1_000_000)throw new Error('historyGuardUnavailable');if(entry&&typeof entry==='object'&&'key'in entry&&'reference'in entry&&typeof entry.key==='string'&&typeof entry.reference==='string'&&missing.has(entry.key))anchors.set(`${item.id.client}:${item.id.clock+index}`,{key:entry.key,parent,reference:entry.reference,simple})})}
 }
 const repairs:PlacementRecovery[]=[]
 for(const key of missing){
  for(let item=before.placement._map.get(key)?.left;item;item=item.left){
   if(item.id.client===owner)continue
   const stored=item.content.getContent()[0] as Placement|undefined,anchor=anchors.get(`${item.id.client}:${item.id.clock-1}`)
   let value:Placement|undefined
   if(stored&&typeof stored.reference==='string'&&(stored.parent===null||typeof stored.parent==='string')){
    const sequence=stored.parent===null?after.order:after.children.get(stored.parent);if(sequence?.toArray().some(entry=>entry.key===key&&entry.reference===stored.reference))value=structuredClone(stored)
   }else if(anchor?.key===key&&anchor.simple)value={parent:anchor.parent,reference:anchor.reference}
   if(value&&(value.parent===null||after.visibility.get(value.parent)===true&&!after.inline.get(value.parent))){repairs.push({key,value});break}
  }
 }
 if(repairs.length)after.document.transact(()=>repairs.forEach(repair=>after.placement.set(repair.key,repair.value)),recoverConcurrentPlacements)
 return repairs
}
export function placementRecoveryFilter(store:SemanticBlockStore,repairs:readonly PlacementRecovery[],original:(item:Y.Item)=>boolean){
 const pending=new Map(repairs.map(repair=>[repair.key,repair.value]))
 return(item:Y.Item)=>{const allowed=original(item);if(allowed&&item.parent===store.placement&&typeof item.parentSub==='string'){const value=pending.get(item.parentSub);if(value){pending.delete(item.parentSub);store.placement.set(item.parentSub,value)}}return allowed}
}
