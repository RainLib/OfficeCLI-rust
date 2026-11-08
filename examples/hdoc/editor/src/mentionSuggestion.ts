import {Plugin,PluginKey,TextSelection,type EditorState} from '@tiptap/pm/state'
import type {Editor} from '@tiptap/core'
import {readInlineReference} from './inlineReference.ts'
import {editableInlineTextParent} from './inlineEditingContext.ts'
export type MentionMatch={from:number;to:number;text:string;query:string}
export type MentionCandidate={kind:'person';id:string;label:string;detail?:string|null}
export type MentionPage={schemaVersion:'hcd-mention-options/1';kind:'person';items:MentionCandidate[];nextCursor:string|null}
export function readMentionPage(value:unknown):MentionPage{
 const v=value as MentionPage
 if(!v||v.schemaVersion!=='hcd-mention-options/1'||v.kind!=='person'||!Array.isArray(v.items)||v.items.length>50||new Set(v.items.map(item=>item.id)).size!==v.items.length||v.nextCursor!==null&&(typeof v.nextCursor!=='string'||v.nextCursor.length>8192))throw new Error('mention-options-schema')
 for(const item of v.items){readInlineReference({type:'hcd.mention',version:1,mentionId:`m_${'0'.repeat(32)}`,target:{kind:item.kind,id:item.id},snapshot:{label:item.label}});if(item.kind!=='person'||item.detail!==null&&item.detail!==undefined&&(typeof item.detail!=='string'||new TextEncoder().encode(item.detail).length>256||/[\u0000-\u001f\u007f-\u009f]/u.test(item.detail)))throw new Error('mention-options-schema')}
 return structuredClone(v)
}
export const mentionKey=new PluginKey<{match:MentionMatch|null;dismissed:number|null;composing:boolean}>('hcd-person-mention')
export function canMentionAt(state:EditorState){const {$from}=state.selection;return state.selection instanceof TextSelection&&editableInlineTextParent(state)&&!$from.marks().some(mark=>['code','link'].includes(mark.type.name))}
/** Avoid email addresses and code while allowing names containing spaces. */
export function findMention(state:EditorState):MentionMatch|null{
 if(!state.selection.empty||!canMentionAt(state))return null
 const {$from}=state.selection,prefix=$from.parent.textBetween(0,$from.parentOffset,'\n','\ufffc'),match=/(?:^|[\s([（【{，。！？:：;；])(@([^\n@\ufffc]{0,80}))$/u.exec(prefix)
 if(!match)return null
 return{from:$from.pos-match[1].length,to:$from.pos,text:match[1],query:match[2]}
}
export function startMentionTransaction(state:EditorState){
 if(!canMentionAt(state))return null
 const {$from}=state.selection,prefix=$from.parent.textBetween(0,$from.parentOffset,'\n','\ufffc'),boundary=!prefix||/[\s([（【{，。！？:：;；]$/u.test(prefix)
 return state.tr.insertText(boundary?'@':' @').scrollIntoView()
}
export function mentionPlugin(){return new Plugin({key:mentionKey,state:{init:(_,state)=>({match:findMention(state),dismissed:null as number|null,composing:false}),apply:(tr,before,_,state)=>{
 const meta=tr.getMeta(mentionKey) as {dismiss?:boolean;composing?:boolean}|undefined,composing=meta?.composing??before.composing,match=findMention(state),dismissed=meta?.dismiss?(match?.from??null):before.dismissed===null?null:tr.mapping.map(before.dismissed,1)
 return{match:composing||match?.from===dismissed?null:match,dismissed:match?.from===dismissed?dismissed:null,composing}
}},props:{handleDOMEvents:{compositionstart:view=>{view.dispatch(view.state.tr.setMeta(mentionKey,{composing:true}));return false}}},view:view=>{
 let timer:ReturnType<typeof setTimeout>|undefined,closed=false
 const end=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!closed)view.dispatch(view.state.tr.setMeta(mentionKey,{composing:false}))},0)};view.dom.addEventListener('compositionend',end)
 return{destroy:()=>{closed=true;clearTimeout(timer);view.dom.removeEventListener('compositionend',end)}}
}})}
export function mentionTransaction(state:EditorState,expected:MentionMatch,candidate:MentionCandidate){
 const latest=findMention(state)
 if(!latest||latest.from!==expected.from||latest.to!==expected.to||latest.text!==expected.text)throw new Error('mention-selection-changed')
 const reference=readInlineReference({type:'hcd.mention',version:1,mentionId:`m_${crypto.randomUUID().replaceAll('-','')}`,target:{kind:candidate.kind,id:candidate.id},snapshot:{label:candidate.label}})
 if(candidate.kind!=='person')throw new Error('mention-options-schema')
 const node=state.schema.nodes.hcdMention.createChecked({reference},undefined,state.selection.$from.marks().filter(mark=>!['code','link','hcdSource'].includes(mark.type.name)))
 const tr=state.tr.replaceWith(latest.from,latest.to,node).insertText(' ',latest.from+1)
 // The replacement includes a space so subsequent typing remains outside the atom.
 return tr.setSelection(TextSelection.create(tr.doc,latest.from+2)).setMeta(mentionKey,{dismiss:true}).scrollIntoView()
}
export function insertMention(editor:Editor,expected:MentionMatch,candidate:MentionCandidate){if(editor.isDestroyed||!editor.isEditable)return false;editor.view.dispatch(mentionTransaction(editor.state,expected,candidate));editor.view.focus();return true}
