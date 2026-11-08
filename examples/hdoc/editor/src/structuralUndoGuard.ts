import {recoveryImportOrigin} from './recoveryImportOrigin.ts'
import {inlineContainerNodes,inlineContainerEditFields} from './inlineContainerEdits.ts'
import * as Y from 'yjs'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {extensionNodes} from './extensionNode.ts'
import {documentReferences,referenceEditField} from './referenceEdits.ts'
import {nodeEditFields} from './extensionEdits.ts'
import type {Node as PmNode} from '@tiptap/pm/model'
import {prepareUndoneCreations} from './historyDeletion.ts'
import {recoverConcurrentPlacements,placementRecoveryFilter,type PlacementRecovery} from './historyPlacementRecovery.ts'
import {prepareInlineHistoryDeletions,inlineHistoryDeletionFilter,inlineDeletionField} from './inlineDeletionReview.ts'
export type PrepareHistoryProjectionGuard=(before:PmNode)=>((after:PmNode)=>void)|undefined

type Range={from:number;to:number}
type Clocks=Map<number,Range[]>
type Item=Y.UndoManager['undoStack'][number]
type Policy={allowed:Clocks;unavailable?:boolean}
const policyKey=Symbol('hcd-structural-undo-policy')
function normalize(input:Clocks):Clocks{
 const result:Clocks=new Map()
 for(const [client,values]of input){const ranges:Range[]=[];for(const value of values.sort((a,b)=>a.from-b.from)){const last=ranges.at(-1);if(last&&value.from<=last.to)last.to=Math.max(last.to,value.to);else ranges.push({...value})}if(ranges.length)result.set(client,ranges)}
 return result
}
function minus(a:Clocks,b:Clocks):Clocks{
 const result:Clocks=new Map()
 for(const [client,ranges]of a){const removed=b.get(client)??[],remaining:Range[]=[];let index=0;for(const range of ranges){let from=range.from;while(index<removed.length&&removed[index].to<=from)index++;for(let at=index;at<removed.length&&removed[at].from<range.to;at++){if(removed[at].from>from)remaining.push({from,to:Math.min(range.to,removed[at].from)});from=Math.max(from,removed[at].to);if(from>=range.to)break}if(from<range.to)remaining.push({from,to:range.to})}if(remaining.length)result.set(client,remaining)}
 return result
}
function add(result:Clocks,client:number,from:number,to:number){if(to<=from)return;const ranges=result.get(client)??[];ranges.push({from,to});result.set(client,ranges)}
/** Read projected foreign identity ranges, not words or author display names.
 * Only public document content is compared; nothing is sent to a service. */
function visibleForeign(store:SemanticBlockStore,owner:number):Clocks{
 const result:Clocks=new Map();if(!store.initialized)return result
 const blocks=store.blocks(),doc=store.schema.topNodeType.createChecked(null,blocks.map(block=>block.node)),activeExtensions=extensionNodes(doc),activeReferences=documentReferences(doc),activeContainers=store.flow.containers?inlineContainerNodes(doc):new Map(),carriers=new Map<Y.XmlText,Range[]>()
 const range=(text:unknown,from:number,to:number)=>{if(!(text instanceof Y.XmlText))throw new Error('historyGuardUnavailable');const values=carriers.get(text)??[];if(to>from)values.push({from,to});carriers.set(text,values)}
 const walk=(key:string,node:typeof doc)=>{
  const allocation=store.contents.get(key)?._item;if(allocation&&allocation.id.client!==owner)add(result,allocation.id.client,allocation.id.clock,allocation.id.clock+1)
  // Visible block kind, placement and user attributes can be edited without
  // inserting any characters. Source/canonical receipts are not user content.
  const track=(item:Y.Item|undefined)=>{if(item&&item.id.client!==owner)add(result,item.id.client,item.id.clock,item.id.clock+1)}
  for(const map of [store.kinds,store.placement,store.visibility,store.inline])track(map._map.get(key))
  const attrs=store.attributes.get(key);if(attrs)for(const name of attrs.keys())if(!name.startsWith('hcdSource')&&!['hcdBlockId','hcdStructureKey','hcdCanonicalKey'].includes(name))track(attrs._map.get(name))
  if(node.isTextblock){for(const part of store.flow.parts(key))range(store.contents.get(part.carrier)?.get(0),part.from,part.to);if(store.flow.containers)node.descendants(child=>{if(child.type.name!=='hcdExtensionInlineContainer')return;const id=child.attrs.extension.instanceId,body=store.flow.containers!.bodies.get(id);if(!(body instanceof Y.XmlText))throw new Error('historyGuardUnavailable');range(body,0,body.length);track(store.flow.containers!.bodies._map.get(id));track(store.flow.containers!.definitions._map.get(id))})}
  else for(const child of store.projectedChildren(key,node))walk(child.key,child.node)
 }
 blocks.forEach(block=>walk(block.key,block.node))
 for(const [text,raw]of carriers){const ranges=normalize(new Map([[0,raw]])).get(0)??[];let offset=0,index=0;const formats=new Map<string,Y.Item>()
  for(let item=text._start;item;item=item.right){if(item.deleted)continue
   if(item.content instanceof Y.ContentFormat){if(item.content.key!=='hcdSource')formats.set(item.content.key,item);continue}
   if(!item.countable)continue
   const end=offset+item.length;while(index<ranges.length&&ranges[index].to<=offset)index++
   for(let at=index;at<ranges.length&&ranges[at].from<end;at++){const from=Math.max(offset,ranges[at].from),to=Math.min(end,ranges[at].to);if(to<=from)continue;if(item.id.client!==owner)add(result,item.id.client,item.id.clock+from-offset,item.id.clock+to-offset);for(const format of formats.values())if(format.id.client!==owner)add(result,format.id.client,format.id.clock,format.id.clock+1)}
   offset=end
  }
 }
 for(const [field,active]of [[nodeEditFields.intents,activeExtensions],[referenceEditField,activeReferences],[inlineContainerEditFields.intents,activeContainers]] as const){const map=store.document.getMap(field);for(const [key,raw]of map){const value=raw as {root?:{instanceId?:string;mentionId?:string}},id=field===referenceEditField?value.root?.mentionId:value.root?.instanceId,item=map._map.get(key);if(id&&active.has(id)&&item&&item.id.client!==owner)add(result,item.id.client,item.id.clock,item.id.clock+1)}}
 return normalize(result)
}
/** A file update carries allocation and editable mutations together. Match
 * normal structural creation: permanent carriers/initial data are not undone;
 * visibility and placement remain one user action with deletion review. */
function retainImportAllocations(store:SemanticBlockStore,item:Item,changed:Map<Y.AbstractType<any>,Y.YEvent<any>[]>){
 const added=new Set<string>()
 for(const event of changed.get(store.contents)??[])if(event instanceof Y.YMapEvent)for(const [key,value]of event.changes.keys)if(value.action==='add')added.add(key)
 if(!added.size)return
 const allocatedMaps=new Set<Y.AbstractType<any>>([store.contents,store.attributes,store.children]),initialMaps=new Set<Y.AbstractType<any>>([store.kinds,store.inline,store.owners])
 const permanent=(value:Y.Item)=>{
  if((allocatedMaps.has(value.parent as Y.AbstractType<any>)||initialMaps.has(value.parent as Y.AbstractType<any>))&&typeof value.parentSub==='string'&&added.has(value.parentSub))return true
  let parent=value.parent
  while(parent instanceof Y.AbstractType){const root=parent._item;if(!root)return false;if(allocatedMaps.has(root.parent as Y.AbstractType<any>)&&typeof root.parentSub==='string'&&added.has(root.parentSub))return true;parent=root.parent}
  return false
 }
 const original:Clocks=new Map(),excluded:Clocks=new Map()
 for(const [client,ranges]of item.insertions.clients){for(const range of ranges)add(original,client,range.clock,range.clock+range.len);for(const value of store.document.store.clients.get(client)??[])if(value instanceof Y.Item&&permanent(value))for(const range of ranges){const from=Math.max(value.id.clock,range.clock),to=Math.min(value.id.clock+value.length,range.clock+range.len);add(excluded,client,from,to)}}
 item.insertions.clients.clear();for(const [client,ranges]of minus(normalize(original),normalize(excluded)))item.insertions.clients.set(client,ranges.map(({from,to})=>({clock:from,len:to-from})))
}
function hasStructuralChange(store:SemanticBlockStore,changed:Map<Y.AbstractType<any>,Y.YEvent<any>[]>){
 if([store.order,store.placement,store.visibility,store.kinds,store.children,store.inline,store.flow.links,store.flow.order,store.document.getMap(inlineDeletionField)].some(type=>changed.has(type)))return true
 for(const events of changed.values())for(const event of events)if(event instanceof Y.YTextEvent&&(event.delta.some(part=>typeof part.insert==='object')||[...event.changes.added,...event.changes.deleted].some(item=>item.content instanceof Y.ContentEmbed)))return true
 return false
}
function deletesForeign(changed:Map<Y.AbstractType<any>,Y.YEvent<any>[]>,owner:number){const event=changed.values().next().value?.[0],transaction=event?.transaction;return !!transaction&&[...transaction.deleteSet.clients].some(([client,ranges])=>client!==owner&&ranges.length>0)}

/** Structural undo is previewed on an isolated gc:false replica. Ordinary
 * typing uses Yjs directly. Creation inverses retain permanent topology and
 * a shared deletion receipt for offline changes arriving after the inverse. */
export function protectStructuralUndo(manager:Y.UndoManager,store:SemanticBlockStore,replica:(document:Y.Doc)=>SemanticBlockStore,prepareProjectionGuard?:PrepareHistoryProjectionGuard){
 let replaying=false,closed=false
 const simulate=(item:Item,direction:'undo'|'redo',retainCreations=false,retention?:ReturnType<typeof prepareUndoneCreations>,retainedPlacements:PlacementRecovery[]=[])=>{
  const bytes=Y.encodeStateAsUpdate(store.document);if(bytes.length>64_000_000)throw new Error('historyGuardUnavailable')
  const document=new Y.Doc({gc:false});let trial:Y.UndoManager|undefined
  try{
   Y.applyUpdate(document,bytes)
   // Yjs updates do not serialize local redone links. Older history items can
   // still point through these links after a newer action was undone. Preserve
   // their exact item boundaries and links on the isolated replica as well.
   document.transact(transaction=>{for(const structs of store.document.store.clients.values())for(const original of structs)if(original instanceof Y.Item&&original.redone){const copied=Y.getItemCleanStart(transaction,original.id);if(!(copied instanceof Y.Item))throw new Error('historyGuardUnavailable');if(copied.length>original.length)Y.getItemCleanEnd(transaction,document.store,Y.createID(original.id.client,original.id.clock+original.length-1));copied.redone=Y.createID(original.redone.client,original.redone.clock)}})
   const copy=replica(document);trial=copy.undoManager(false);const transferred={insertions:structuredClone(item.insertions),deletions:structuredClone(item.deletions),meta:new Map()} as Item;(direction==='undo'?trial.undoStack:trial.redoStack).push(transferred);if(retention)trial.deleteFilter=placementRecoveryFilter(copy,retainedPlacements,retention.filterFor(copy,trial.deleteFilter));direction==='undo'?trial.undo():trial.redo();const placements=recoverConcurrentPlacements(store,copy,store.document.clientID);retention?.recapture(copy);return{foreign:visibleForeign(copy,store.document.clientID),projection:copy.project(),placements,deletions:retainCreations?prepareUndoneCreations(store,copy):undefined,inlineDeletions:retainCreations?prepareInlineHistoryDeletions(store,copy):[]}
  }finally{trial?.destroy();document.destroy()}
 }
 const record=(event:{stackItem:Item;type:'undo'|'redo';changedParentTypes:Map<Y.AbstractType<any>,Y.YEvent<any>[]>})=>{
  if(replaying||event.type!=='undo')return
  const previous=event.stackItem.meta.get(policyKey) as Policy|undefined,structural=hasStructuralChange(store,event.changedParentTypes),imported=[...event.changedParentTypes.values()].flat().some(value=>value.transaction.origin===recoveryImportOrigin)
  if(!structural&&!imported&&(!previous||!deletesForeign(event.changedParentTypes,store.document.clientID)))return
  if(imported)retainImportAllocations(store,event.stackItem,event.changedParentTypes)
  try{const now=visibleForeign(store,store.document.clientID),before=simulate(event.stackItem,'undo').foreign;const allowed=minus(before,now);if(imported)for(const [client,ranges]of minus(now,before))for(const range of ranges)add(allowed,client,range.from,range.to);event.stackItem.meta.set(policyKey,{allowed:normalize(allowed)} satisfies Policy)}catch{event.stackItem.meta.set(policyKey,{allowed:new Map(),unavailable:true} satisfies Policy)}
 }
 manager.on('stack-item-added',record);manager.on('stack-item-updated',record)
 const originalUndo=manager.undo.bind(manager),originalRedo=manager.redo.bind(manager),originalDestroy=manager.destroy.bind(manager)
 const step=(direction:'undo'|'redo')=>{
  const stack=direction==='undo'?manager.undoStack:manager.redoStack
  while(stack.length){const item=stack.at(-1)!,policy=item.meta.get(policyKey) as Policy|undefined
   let check:((after:PmNode)=>void)|undefined,deletions:ReturnType<typeof prepareUndoneCreations>,placements:PlacementRecovery[]=[],inlineDeletions:ReturnType<typeof prepareInlineHistoryDeletions>=[]
   try{check=prepareProjectionGuard?.(store.project())}catch{throw new Error('historyGuardUnavailable')}
   if(policy||check){if(policy?.unavailable)throw new Error('historyGuardUnavailable');let missing:Clocks;try{const trial=simulate(item,direction,true);check?.(trial.projection);deletions=trial.deletions;placements=trial.placements;inlineDeletions=trial.inlineDeletions;if(deletions){const retained=simulate(item,direction,false,deletions,placements);if(!retained.projection.eq(trial.projection))throw new Error('historyGuardUnavailable')}missing=policy?minus(minus(visibleForeign(store,store.document.clientID),trial.foreign),policy.allowed):new Map()}catch(error){if(error instanceof Error&&error.message==='historyExtensionUnavailable')throw error;throw new Error('historyGuardUnavailable',{cause:error})}if(missing.size)throw new Error('historyPeerChanges')}
   // Never let Yjs skip an invisible action into an unreviewed older one.
   const older=stack.splice(0,stack.length-1);let moved:Item|null
   const deleteFilter=manager.deleteFilter,filtered=inlineHistoryDeletionFilter(store,inlineDeletions,deletions?deletions.filterFor(store,deleteFilter):deleteFilter);if(placements.length)manager.deleteFilter=placementRecoveryFilter(store,placements,filtered);else manager.deleteFilter=filtered
   replaying=true;try{moved=direction==='undo'?originalUndo():originalRedo()}finally{manager.deleteFilter=deleteFilter;stack.unshift(...older);replaying=false}
   if(moved){if(policy)(direction==='undo'?manager.redoStack:manager.undoStack).at(-1)?.meta.set(policyKey,policy);return moved}
  }
  return null
 }
 manager.undo=()=>step('undo');manager.redo=()=>step('redo')
 manager.destroy=()=>{if(closed)return;closed=true;manager.off('stack-item-added',record);manager.off('stack-item-updated',record);originalDestroy()}
 return manager
}
