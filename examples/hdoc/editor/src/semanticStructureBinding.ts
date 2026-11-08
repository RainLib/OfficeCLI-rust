import {Plugin,PluginKey,type EditorState,type Transaction} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import type {Node as PmNode} from '@tiptap/pm/model'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {blockMoveMeta,blockDeleteMeta} from './commands/blocks.ts'
import {SemanticBlockStore,type ProposedSemanticBlock,type StableSemanticBlock,type SemanticReconcileOptions,type SemanticTextSplice,type SemanticTextEdits} from './semanticBlockStore.ts'
import {captureStructureSelection,restoreStructureSelection,type StructureSelection} from './semanticStructureSelection.ts'
import {inlineContainerNodeName} from './semanticInlineContainers.ts'
export type StructureBindingStore=Pick<SemanticBlockStore,'document'|'initialized'|'project'|'blocks'|'validateReconcile'|'reconcile'|'contents'|'inline'|'flow'>
export const structureRemoteMeta='hcd-structure-remote/1'
const normalizedMeta='hcd-structure-normalized/1'
export const structureBindingKey=new PluginKey('hcd-structure-binding/1')
/** ProseMirror's open-slice fitter can duplicate defining/isolating wrappers.
 * Projection is authoritative: a fitted document must equal it exactly. A
 * closed replacement changes only this view; shared CRDT carriers stay intact. */
export function structureProjectionTransaction(state:EditorState,next:PmNode){
 const start=state.doc.content.findDiffStart(next.content)
 if(start===null)return null
 const end=state.doc.content.findDiffEnd(next.content)!,overlap=start-Math.min(end.a,end.b)
 let tr:Transaction
 try{tr=state.tr.replace(start,overlap>0?end.a+overlap:end.a,next.slice(start,overlap>0?end.b+overlap:end.b))}catch{tr=state.tr.replaceWith(0,state.doc.content.size,next.content)}
 if(!tr.doc.eq(next))tr=state.tr.replaceWith(0,state.doc.content.size,next.content)
 if(!tr.doc.eq(next))throw new Error('invalidStructureProjection')
 return tr
}
/** A single closed, same-paragraph ReplaceStep has an exact character range.
 * Multiple replacements, structural edits and removals containing atoms retain
 * their existing reconciliation path rather than guessing a composite hint. */
export function structureTextSplices(transactions:readonly Transaction[]):SemanticTextSplice[]{
 let result:SemanticTextSplice|undefined
 for(const transaction of transactions)for(const [index,step]of transaction.steps.entries()){
  const value=step.toJSON()
  if(['addMark','removeMark','addNodeMark','removeNodeMark'].includes(value.stepType))continue
  if(value.stepType!=='replace'||result)return[]
  const doc=transaction.docs[index],from=doc.resolve(value.from),to=doc.resolve(value.to),slice=(step as import('@tiptap/pm/transform').ReplaceStep).slice
  if(!from.parent.isTextblock||from.parent!==to.parent||typeof from.parent.attrs.hcdStructureKey!=='string'||slice.openStart||slice.openEnd)return[]
  let supported=true
  from.parent.content.cut(from.parentOffset,to.parentOffset).forEach(node=>{if(!node.isText)supported=false})
  slice.content.forEach(node=>{if(!node.isInline||!node.isLeaf)supported=false})
  if(!supported)return[]
  result={key:from.parent.attrs.hcdStructureKey,from:from.parentOffset,to:to.parentOffset,insertedSize:slice.content.size}
 }
 return result?[result]:[]
}
/** Keep each eligible text-only step, including edits to separate paragraphs.
 * No partial hints are emitted if the transaction also changes structure. */
export function structureTextEdits(transactions:readonly Transaction[],inlineContainers=false):SemanticTextEdits[]{
 const grouped=new Map<string,{key:string;containerId?:string;edits:SemanticTextEdits['edits'][number][]}>()
 for(const transaction of transactions)for(const [index,step]of transaction.steps.entries()){
  const value=step.toJSON()
  if(['addMark','removeMark','addNodeMark','removeNodeMark'].includes(value.stepType))continue
  if(value.stepType!=='replace')return[]
  const doc=transaction.docs[index],from=doc.resolve(value.from),to=doc.resolve(value.to),slice=(step as import('@tiptap/pm/transform').ReplaceStep).slice
  const container=inlineContainers&&from.parent.type.name===inlineContainerNodeName
  if((!from.parent.isTextblock&&!container)||from.parent!==to.parent||slice.openStart||slice.openEnd)return[]
  let depth=from.depth;while(depth>0&&!from.node(depth).isTextblock)depth--
  const key=from.node(depth).attrs.hcdStructureKey,containerId=container?from.parent.attrs.extension?.instanceId:undefined
  if(typeof key!=='string'||container&&typeof containerId!=='string')return[]
  let supported=true
  from.parent.content.cut(from.parentOffset,to.parentOffset).forEach(node=>{if(!node.isText)supported=false});slice.content.forEach(node=>{if(!node.isText)supported=false})
  if(!supported)return[]
  // Each step's own PM parent includes expanded child bodies. Its permanent
  // carrier stores every child reference as one embed, even after earlier
  // steps in this transaction have grown a nested body.
  const offset=(position:number)=>{let stored=0;from.parent.forEach((child,at)=>{if(position>=at+child.nodeSize)stored+=child.isText?child.nodeSize:1;else if(position>at){if(!child.isText)throw new Error('invalidSemanticTextEdits');stored+=position-at}});return stored}
  const groupKey=JSON.stringify([key,containerId??null]),existing=grouped.get(groupKey),edit={from:inlineContainers?offset(from.parentOffset):from.parentOffset,to:inlineContainers?offset(to.parentOffset):to.parentOffset,insert:slice.content}
  if(existing)existing.edits.push(edit);else grouped.set(groupKey,{key,...(container?{containerId}:{}),edits:[edit]})
 }
 return[...grouped.values()]
}
type Options={canWrite:()=>boolean;canMaintain?:()=>boolean;onError:(error:unknown)=>void}
/** Opt-in binding for a negotiated structural room. It never initializes a
 * room or writes the legacy default fragment. */
export function semanticStructureBinding(store:StructureBindingStore,options:Options){
 let view:EditorView|null=null,writing=false,syncing=false,closed=false,projected=false,rendered:StableSemanticBlock[]=[],bookmark:StructureSelection|null=null
 const proposal=(doc:PmNode)=>{
  const known=new Set(rendered.map(block=>block.key)),seen=new Set<string>(),after:ProposedSemanticBlock[]=[]
  doc.forEach(node=>{const key=node.attrs.hcdStructureKey;const valid=typeof key==='string'&&known.has(key)&&!seen.has(key);if(valid)seen.add(key);after.push({...(valid?{key}:{}),node})})
  return after
 }
 const moveOptions=(transactions:readonly Transaction[]):SemanticReconcileOptions=>{
  const intent=transactions.map(tr=>tr.getMeta(blockMoveMeta)).find(Boolean) as {first:number;count:number;keys?:string[]}|undefined
  const deletion=transactions.map(tr=>tr.getMeta(blockDeleteMeta)).find(Boolean) as {first:number;count:number;keys?:string[]}|undefined
  const textSplit=transactions.some(tr=>tr.steps.some(step=>{const slice=step.toJSON().slice;return slice?.openStart>0&&slice?.openEnd>0}))
  const textJoin=transactions.some(tr=>tr.steps.some((step,index)=>{const json=step.toJSON(),doc=tr.docs[index];return json.stepType==='replace'&&json.from<json.to&&doc.resolve(json.from).parent.isTextblock&&doc.resolve(json.to).parent.isTextblock&&doc.resolve(json.from).start()!==doc.resolve(json.to).start()}))
  const textSplices=store.flow.containers?[]:structureTextSplices(transactions),textEdits=textSplices.length?[]:structureTextEdits(transactions,!!store.flow.containers)
  return{...(textSplices.length?{textSplices}:{}),...(textEdits.length?{textEdits}:{}),textSplit,textJoin,addToHistory:!transactions.every(tr=>tr.getMeta('addToHistory')===false),...(intent?{movedKeys:intent.keys??rendered.slice(intent.first,intent.first+intent.count).map(block=>block.key)}:{}),...(deletion?{deletedKeys:deletion.keys??rendered.slice(deletion.first,deletion.first+deletion.count).map(block=>block.key)}:{})}
 }
 const sync=()=>{
  if(closed||writing||!view||!store.initialized)return
  try{
   const next=store.project(),blocks=store.blocks(),state=view.state
   rendered=blocks
   let tr=structureProjectionTransaction(state,next)
   if(!tr){
    projected=true
    // A delete/reinsert batch may leave identical visible text while replacing
    // its characters. Remote bookmarks must still follow the original items.
    if(!bookmark)return
    const selection=restoreStructureSelection(store,state.doc,bookmark,state.selection.anchor)
    if(selection.eq(state.selection))return
    tr=state.tr.setSelection(selection)
   }else tr.setSelection(restoreStructureSelection(store,tr.doc,bookmark,tr.mapping.map(state.selection.anchor)))
   if(state.storedMarks&&tr.selection.empty)tr.setStoredMarks(state.storedMarks.filter(mark=>mark.type.name!=='hcdSource'&&tr.selection.$from.parent.type.allowsMarkType(mark.type)))
   tr.setMeta(structureRemoteMeta,true).setMeta(ySyncPluginKey,{isChangeOrigin:true}).setMeta('addToHistory',false)
   syncing=true;try{view.dispatch(tr)}finally{syncing=false}
   projected=true
   bookmark=captureStructureSelection(store,view.state)
  }catch(error){options.onError(error)}
 }
 return new Plugin({key:structureBindingKey,
  filterTransaction(tr){
   if(syncing||tr.getMeta(structureRemoteMeta)||tr.getMeta(normalizedMeta)||!tr.docChanged)return true
   // Tiptap may normalize its placeholder before the effect-owned initial
   // projection. That local placeholder must never allocate a shared root.
   if(!projected||!options.canWrite()||!store.initialized)return false
   try{store.validateReconcile(rendered,proposal(tr.doc),moveOptions([tr]));return true}catch(error){options.onError(error);return false}
  },
  appendTransaction(transactions,_before,state){
   // SourceIdentity repairs a revived (undo/redo) text run against the newest
   // canonical defaults. Persist that metadata as part of the remote projection;
   // skipping it leaves the view repaired while the server saves unbound text.
   if(syncing){
    if((options.canMaintain?.()??options.canWrite())&&transactions.some(tr=>tr.getMeta('hcd-source-defaults'))&&transactions.every(tr=>!tr.docChanged||tr.getMeta(structureRemoteMeta)||tr.getMeta('hcd-source-defaults')||tr.getMeta(normalizedMeta))){
     writing=true;try{rendered=store.reconcile(rendered,proposal(state.doc),{addToHistory:false})}catch(error){options.onError(error)}finally{writing=false}
    }
    return null
   }
   if(!transactions.some(tr=>tr.docChanged)||transactions.every(tr=>tr.getMeta(normalizedMeta)||tr.getMeta(structureRemoteMeta)))return null
   if(!projected||!store.initialized||!options.canWrite())return null
   try{
    writing=true;try{rendered=store.reconcile(rendered,proposal(state.doc),moveOptions(transactions))}finally{writing=false}
    const tr=state.tr,normalize=(original:PmNode,projected:PmNode,offset:number)=>{
     original.forEach((node,pos,index)=>{const actual=projected.child(index),attrs={...node.attrs};let changed=false;for(const name of ['hcdStructureKey','hcdCanonicalKey','hcdBlockId'])if(name in actual.attrs&&node.attrs[name]!==actual.attrs[name]){attrs[name]=actual.attrs[name];changed=true}if(changed)tr.setNodeMarkup(offset+pos,undefined,attrs);if(!node.isTextblock)normalize(node,actual,offset+pos+1)})
    };normalize(state.doc,store.project(),0)
    return tr.docChanged?tr.setMeta(normalizedMeta,true).setMeta('addToHistory',false):null
   }catch(error){options.onError(error);return null}
  },
  view(initial){
   view=initial;closed=false
   if(store.initialized&&view.state.doc.eq(store.project())){rendered=store.blocks();projected=true;bookmark=captureStructureSelection(store,view.state)}
   const updated=()=>sync()
   store.document.on('afterTransaction',updated)
   queueMicrotask(()=>{if(!closed)sync()})
   return{update(current:EditorView,_previous:EditorState){view=current;if(!writing&&!syncing&&store.initialized)bookmark=captureStructureSelection(store,current.state)},destroy(){closed=true;store.document.off('afterTransaction',updated);view=null;bookmark=null}}
  },
 })
}
