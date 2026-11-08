import {Mark} from '@tiptap/pm/model'
import {NodeSelection,Selection,type EditorState,type Transaction} from '@tiptap/pm/state'
import type {Editor} from '@tiptap/core'
import {canInsertExtension} from './extensionCommands.ts'
import {inlineContainerNodeName,readInlineContainerPayload,type InlineContainerPayload} from './inlineContainerPayload.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {stableExtension} from './extensionRegistry.ts'
import {authorizeInlineContainerMigration} from './inlineContainerPreservation.ts'
import {availableInlineAncestors} from './inlineEditingContext.ts'

export function selectedInlineContainer(state:EditorState){
 const {selection}=state
 if(!(selection instanceof NodeSelection)||selection.node.type.name!==inlineContainerNodeName)return null
 return{value:readInlineContainerPayload(selection.node.attrs.extension),position:selection.from,node:selection.node}
}
export function inlineContainerPmNode(schema:EditorState['schema'],payload:unknown){const value=readInlineContainerPayload(payload),type=schema.nodes[inlineContainerNodeName];if(!type)throw new Error('inline-save-model-not-negotiated');return type.createChecked({extension:value})}
export function insertInlineContainerTransaction(transaction:Transaction,payload:unknown){
 if(!canInsertExtension(transaction))return false
 const value=readInlineContainerPayload(payload),node=inlineContainerPmNode(transaction.doc.type.schema,value)
 transaction.replaceSelectionWith(node,false);let found=-1
 transaction.doc.descendants((child,pos)=>{if(child.type.name===inlineContainerNodeName&&child.attrs.extension.instanceId===value.instanceId)found=pos})
 if(found<0)return false
 transaction.setSelection(NodeSelection.create(transaction.doc,found));return true
}
/** Same command IDs as ordinary node properties, with a distinct insert model.
 * Commands only change the wrapper envelope; PM/the structure binding retain
 * the real independent body, causal properties and personal history. */
export function prepareInlineContainerTransaction(editor:Editor,registry:InlineContainerRegistry,id:string,input:unknown):{commit:()=>boolean;value?:InlineContainerPayload}|null{
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing||!editor.schema.nodes[inlineContainerNodeName])return null
 const before=editor.state,tr=before.tr;let value:InlineContainerPayload|undefined,required:InlineContainerPayload|undefined
 if(id==='node.insert'){
  const request=input as {model?:unknown;type?:unknown;data?:Record<string,unknown>;resources?:import('./extensionPortable.ts').NodeResource[]}
  if(request?.model!=='inline'||typeof request.type!=='string'||!canInsertExtension(before)||!availableInlineAncestors(before))return null
  value=registry.create(request.type,request.data,request.resources)
  if(!insertInlineContainerTransaction(tr,value))return null
 }else{
  const selected=selectedInlineContainer(before),request=input as {instanceId?:unknown;expected?:unknown;data?:Record<string,unknown>;resources?:import('./extensionPortable.ts').NodeResource[];after?:unknown}
  if(!selected||request?.instanceId!==selected.value.instanceId||stableExtension(request.expected)!==stableExtension(selected.value)||id!=='node.migrate'&&!registry.resolve(selected.value))throw new Error('extensionChanged')
  required=selected.value
  if(id==='node.update'){
   if(!request.data)throw new Error('nodeExtensionInvalidData');value=registry.update(selected.value,request.data)
  }else if(id==='node.resources'){
   if(!request.resources)throw new Error('nodeResourceInvalid');value=registry.updateResources(selected.value,request.resources)
  }else if(id==='node.migrate'){
   const preview=registry.previewMigration(selected.value)
   if(!preview||stableExtension(preview.after)!==stableExtension(request.after))throw new Error('extensionChanged')
   value=preview.after;authorizeInlineContainerMigration(tr,registry,selected.value,value)
  }else if(id==='node.delete'){
   tr.delete(selected.position,selected.position+selected.node.nodeSize);tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selected.position,tr.doc.content.size))))
  }else return null
  if(value){tr.setNodeMarkup(selected.position,undefined,{...selected.node.attrs,extension:value});tr.setSelection(NodeSelection.create(tr.doc,selected.position))}
 }
 tr.doc.check()
 return{value,commit:()=>{
  if(editor.isDestroyed||!editor.isEditable||editor.view.composing||editor.state.doc!==before.doc||!editor.state.selection.eq(before.selection)||!Mark.sameSet(editor.state.storedMarks??[],before.storedMarks??[]))return false
  if(value&&!registry.resolve(value)||required&&(id==='node.migrate'?stableExtension(registry.previewMigration(required)?.after)!==stableExtension(value):!registry.resolve(required)))return false
  editor.view.dispatch(tr.scrollIntoView());if(editor.state.doc===before.doc)return false;editor.view.focus();return true
 }}
}
