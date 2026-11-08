import {insertExtensionTransaction} from '../extensionCommands.ts'
import {insertInlineContainerTransaction} from '../inlineContainerCommands.ts'
import {readExtensionNode} from '../extensionNode.ts'
import {CommandManager,isActive,type Editor} from '@tiptap/core'
import type {SlashTarget} from './insertion.ts'
import {Mark} from '@tiptap/pm/model'
import {findSlash} from './slash.ts'
import {insideInlineContainer} from '../inlineEditingContext.ts'
/** Build without dispatch: even a failed Tiptap chain must not remove the trigger. */
export function prepareSlashTransaction(editor:Editor,id:string,input:unknown,target:SlashTarget):(()=>boolean)|null{
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing)return null
 const before=editor.state,match=findSlash(before)
 if(!match||match.from!==target.from||match.to!==target.to||match.text!==target.text)return null
 if(insideInlineContainer(before.selection.$from)&&!['ai.compose','node.insert','text.insert'].includes(id))return null
 const tr=before.tr.delete(target.from,target.to),chain=new CommandManager({editor,state:before}).createChain(tr).setTextSelection(target.from)
 let ok=false
 if(id==='ai.compose')ok=chain.command(()=>true).run();else if(id==='node.insert'){try{const value=(input as {extension?:{schemaVersion?:unknown}})?.extension;ok=value?.schemaVersion==='hcd.extension/3'?insertInlineContainerTransaction(tr,value):insertExtensionTransaction(tr,readExtensionNode(value))}catch{return null}}else if(id==='text.insert'){
  const text=(input as {text?:unknown})?.text
  if(typeof text!=='string'||!text.length||text.length>1_000_000)return null
  const content=text.replaceAll('\r\n','\n').split('\n').flatMap((line,index)=>[...(index?[{type:'hardBreak'}]:[]),...(line?[{type:'text',text:line}]:[])])
  ok=chain.insertContent(content).run()
 }else if(id==='block.paragraph')ok=chain.command(({state,commands})=>state.selection.$from.parent.type.name==='paragraph'||commands.setParagraph()).run()
 else if(id==='block.heading')ok=chain.command(({state,commands})=>state.selection.$from.parent.type.name==='heading'&&state.selection.$from.parent.attrs.level===2||commands.setHeading({level:2})).run()
 else if(id==='block.bulletList'||id==='block.orderedList'){if(tr.selection.$from.parent.type.name==='heading')chain.setParagraph();ok=chain.command(({state,commands})=>isActive(state,id==='block.bulletList'?'bulletList':'orderedList')||(id==='block.bulletList'?commands.toggleBulletList():commands.toggleOrderedList())).run()}
 else if(id==='block.quote')ok=chain.command(({state,commands})=>isActive(state,'blockquote')||commands.toggleBlockquote()).run()
 else if(id==='block.code')ok=chain.setCodeBlock().run()
 else if(id==='block.divider')ok=chain.setHorizontalRule().run()
 if(!ok)return null
 return()=>{
  if(editor.isDestroyed||!editor.isEditable||editor.view.composing||!findSlash(editor.state)||editor.state.doc!==before.doc||!editor.state.selection.eq(before.selection)||!Mark.sameSet(editor.state.storedMarks??[],before.storedMarks??[]))return false
  editor.view.dispatch(tr.scrollIntoView());if(editor.state.doc===before.doc)return false;editor.view.focus();return true
 }
}
