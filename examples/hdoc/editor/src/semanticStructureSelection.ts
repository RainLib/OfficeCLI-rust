import type * as Y from 'yjs'
import {AllSelection,NodeSelection,Selection,TextSelection,type EditorState} from '@tiptap/pm/state'
import type {Node as PmNode} from '@tiptap/pm/model'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
export type StructureSelectionStore=Pick<SemanticBlockStore,'contents'|'inline'|'flow'>
export type StructurePoint={key:string;offset:number;relative?:ReturnType<typeof Y.relativePositionToJSON>;node?:{kind:'extension'|'mention';id:string}}
export function validStructureNodePoint(value:StructurePoint['node']){return !!value&&(value.kind==='extension'?/^x_[a-f0-9]{32}$/:value.kind==='mention'?/^m_[a-f0-9]{32}$/:null)?.test(value.id)===true}
export type StructureSelection={kind:'all'}|{kind:'node';anchor:StructurePoint}|{kind:'text';anchor:StructurePoint;head:StructurePoint}
function nodes(doc:PmNode){const result:Array<{node:PmNode;from:number;to:number}>=[];doc.descendants((node,from)=>{if(node.isBlock&&typeof node.attrs.hcdStructureKey==='string')result.push({node,from,to:from+node.nodeSize})});return result}
export function captureStructurePoint(store:StructureSelectionStore,doc:PmNode,position:number,assoc=0):StructurePoint|null{
 const candidates=nodes(doc),entry=candidates.find(entry=>entry.node.isTextblock&&position>entry.from&&position<entry.to)??candidates.find(entry=>position>=entry.from&&position<entry.to)??candidates.at(-1)
 if(!entry)return null
 const key=entry.node.attrs.hcdStructureKey,point:StructurePoint={key,offset:position-entry.from}
 if(!store.contents.has(key))return null
 if(store.inline.get(key)){
  const captured=store.flow.capture(key,Math.max(0,Math.min(entry.node.content.size,point.offset-1)),assoc)
  point.key=captured.carrier;point.relative=captured.relative
 }
 return point
}
export function resolveStructurePoint(store:StructureSelectionStore,doc:PmNode,point:StructurePoint):number|null{
 if(point.node){
  if(!validStructureNodePoint(point.node))return null
  const matches:number[]=[]
  doc.descendants((node,from)=>{if(point.node!.kind==='extension'?['hcdExtensionInline','hcdExtensionInlineContainer'].includes(node.type.name)&&node.attrs.extension?.instanceId===point.node!.id:node.type.name==='hcdMention'&&node.attrs.reference?.mentionId===point.node!.id)matches.push(from)})
  return matches.length===1?matches[0]:null
 }
 let key=point.key,offset=point.offset
 if(point.relative){
  const resolved=store.flow.resolve({carrier:point.key,relative:point.relative})
  if(!resolved)return null
  key=resolved.root;offset=resolved.offset+1
 }
 const entry=nodes(doc).find(entry=>entry.node.attrs.hcdStructureKey===key)
 if(!entry)return null
 return entry.from+Math.max(0,Math.min(entry.node.nodeSize-1,offset))
}
export function captureStructureSelection(store:StructureSelectionStore,state:EditorState):StructureSelection|null{
 const selection=state.selection
 if(selection instanceof AllSelection)return{kind:'all'}
 if(selection instanceof NodeSelection){
  const node=selection.node,key=node.attrs.hcdStructureKey
  if(typeof key==='string')return{kind:'node',anchor:{key,offset:0}}
  const identity=['hcdExtensionInline','hcdExtensionInlineContainer'].includes(node.type.name)?{kind:'extension' as const,id:node.attrs.extension?.instanceId}:node.type.name==='hcdMention'?{kind:'mention' as const,id:node.attrs.reference?.mentionId}:undefined
  const anchor=identity&&validStructureNodePoint(identity)?captureStructurePoint(store,state.doc,selection.from):null
  return anchor?{kind:'node',anchor:{key:anchor.key,offset:anchor.offset,node:identity}}:null
 }
 const anchor=captureStructurePoint(store,state.doc,selection.anchor),head=captureStructurePoint(store,state.doc,selection.head)
 return anchor&&head?{kind:'text',anchor,head}:null
}
export function restoreStructureSelection(store:StructureSelectionStore,doc:PmNode,bookmark:StructureSelection|null,fallback=0){
 try{
  if(bookmark?.kind==='all')return new AllSelection(doc)
  if(bookmark){
   const anchor=resolveStructurePoint(store,doc,bookmark.anchor)
   if(anchor!==null){
    if(bookmark.kind==='node'){const node=doc.nodeAt(anchor);if(node&&NodeSelection.isSelectable(node))return NodeSelection.create(doc,anchor)}
    else{const head=resolveStructurePoint(store,doc,bookmark.head);if(head!==null)return TextSelection.between(doc.resolve(anchor),doc.resolve(head))}
   }
  }
 }catch{/* Obsolete/invalid bookmarks never dispatch an invalid selection. */}
 return Selection.near(doc.resolve(Math.max(0,Math.min(doc.content.size,fallback))))
}
