import {Mark} from '@tiptap/pm/model'
import {NodeSelection,Selection,type EditorState,type Transaction} from '@tiptap/pm/state'
import type {Editor} from '@tiptap/core'
import {readExtensionNode,authorizeNodeMigration} from './extensionNode.ts'
import {stableExtension,type NodeExtensionRegistry} from './extensionRegistry.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {availableInlineAncestors,insideInlineContainer} from './inlineEditingContext.ts'
export function selectedExtension(state:EditorState){
 const {selection}=state
 if(!(selection instanceof NodeSelection)||!['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(selection.node.type.name))return null
 return{value:readExtensionNode(selection.node.attrs.extension),position:selection.from,node:selection.node}
}
export function canInsertExtension(state:Pick<EditorState,'selection'|'storedMarks'>){return state.selection.empty&&state.selection.$from.parent.inlineContent&&state.selection.$from.parent.type.name!=='codeBlock'&&![...(state.storedMarks??state.selection.$from.marks())].some(mark=>['code','link'].includes(mark.type.name))}
export function extensionPmNode(state:Pick<EditorState,'schema'>,value:ExtensionNodePayload){return state.schema.nodes[value.contentModel==='blocks'?'hcdExtensionContainer':value.display==='inline'?'hcdExtensionInline':'hcdExtensionBlock'].createChecked({extension:readExtensionNode(value),...(value.display==='block'&&value.contentModel!=='blocks'?{fallbackInline:{text:value.fallback.text,bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false}}:{})},value.contentModel==='blocks'?[state.schema.nodes.paragraph.createChecked()]:undefined)}
export function insertExtensionTransaction(tr:Transaction,value:ExtensionNodePayload){
 if(!canInsertExtension(tr))return false
 if(value.display==='block'&&insideInlineContainer(tr.selection.$from))return false
 const node=extensionPmNode({schema:tr.doc.type.schema},value)
 tr.replaceSelectionWith(node,false);let found=-1;tr.doc.descendants((n,pos)=>{if(n.attrs.extension?.instanceId===value.instanceId){found=pos;return false}})
 if(found<0)return false
 tr.setSelection(NodeSelection.create(tr.doc,found));return true
}
export function prepareNodeTransaction(editor:Editor,registry:NodeExtensionRegistry,id:string,input:unknown):{commit:()=>boolean;value?:ExtensionNodePayload}|null{
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing)return null
 const before=editor.state,tr=before.tr;let value:ExtensionNodePayload|undefined,required:ExtensionNodePayload|undefined
 if(id==='node.insert'){
  const request=input as {type?:unknown;data?:Record<string,unknown>;resources?:import('./extensionPortable.ts').NodeResource[]};if(typeof request?.type!=='string')return null
  if('model' in request||!availableInlineAncestors(before))return null
  value=registry.create(request.type,request.data,request.resources);if(!insertExtensionTransaction(tr,value))return null
 }else{
  const selected=selectedExtension(before),request=input as {instanceId?:unknown;expected?:unknown;data?:Record<string,unknown>;after?:unknown;resources?:import('./extensionPortable.ts').NodeResource[]}
  if(!selected||id!=='node.migrate'&&!registry.resolve(selected.value)||request?.instanceId!==selected.value.instanceId||stableExtension(request.expected)!==stableExtension(selected.value))throw new Error('extensionChanged')
  required=selected.value
  if(id==='node.migrate'){
   const preview=registry.previewMigration(selected.value)
   if(!preview||stableExtension(preview.after)!==stableExtension(request.after))throw new Error('extensionChanged')
   value=preview.after;authorizeNodeMigration(tr,registry,selected.value,value)
   const {nodeId:_receipt,...fallback}=selected.node.attrs.fallbackInline??{}
   tr.setNodeMarkup(selected.position,undefined,{...selected.node.attrs,extension:value,...(selected.value.display==='block'?{fallbackInline:{...fallback,text:value.fallback.text}}:{})});tr.setSelection(NodeSelection.create(tr.doc,selected.position))
  }else if(id==='node.resources'){
   if(!request.resources)throw new Error('nodeResourceInvalid');value=registry.updateResources(selected.value,request.resources);tr.setNodeMarkup(selected.position,undefined,{...selected.node.attrs,extension:value});tr.setSelection(NodeSelection.create(tr.doc,selected.position))
  }else if(id==='node.update'){
   if(!request.data)throw new Error('nodeExtensionInvalidData')
   value=registry.update(selected.value,request.data);const {nodeId:_receipt,...fallback}=selected.node.attrs.fallbackInline??{};tr.setNodeMarkup(selected.position,undefined,{...selected.node.attrs,extension:value,...(selected.value.display==='block'?{fallbackInline:{...fallback,text:value.fallback.text}}:{})});tr.setSelection(NodeSelection.create(tr.doc,selected.position))
  }else if(id==='node.delete'){
   tr.delete(selected.position,selected.position+selected.node.nodeSize);tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selected.position,tr.doc.content.size))))
  }else return null
 }
 tr.doc.check()
 return{value,commit:()=>{
  if(editor.isDestroyed||!editor.isEditable||editor.view.composing||editor.state.doc!==before.doc||!editor.state.selection.eq(before.selection)||!Mark.sameSet(editor.state.storedMarks??[],before.storedMarks??[]))return false
  // Registrations may be removed between a staged invocation and commit.
  if(value&&!registry.resolve(value)||required&&(id==='node.migrate'?stableExtension(registry.previewMigration(required)?.after)!==stableExtension(value):!registry.resolve(required)))return false
  editor.view.dispatch(tr.scrollIntoView());if(editor.state.doc===before.doc)return false;editor.view.focus();return true
 }}
}
