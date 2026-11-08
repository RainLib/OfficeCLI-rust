import {Plugin,PluginKey,type EditorState} from '@tiptap/pm/state'
import {editableInlineTextParent} from '../inlineEditingContext.ts'
export type SlashMatch={from:number;to:number;query:string;text:string}
export type SlashState={match:SlashMatch|null;dismissed:number|null;composing:boolean}
export const slashKey=new PluginKey<SlashState>('hcd-slash')
/** A whitespace boundary keeps URL paths, email addresses and ordinary slashes literal. */
export function findSlash(state:EditorState):SlashMatch|null{
 const {$from,empty}=state.selection
 if(!empty||!editableInlineTextParent(state)||$from.parent.type.spec.code)return null
 if($from.marks().some(mark=>mark.type.name==='code'||mark.type.name==='link'))return null
 const prefix=$from.parent.textBetween(0,$from.parentOffset,'\n','\ufffc')
 const match=/(?:^|\s)(\/([^\n/\ufffc]{0,80}))$/u.exec(prefix)
 if(!match)return null
 const text=match[1];return{from:$from.pos-text.length,to:$from.pos,query:match[2],text}
}
export function slashPlugin(){return new Plugin<SlashState>({
 key:slashKey,
 state:{init:(_,state)=>({match:findSlash(state),dismissed:null,composing:false}),apply:(tr,before,_,state)=>{
  const meta=tr.getMeta(slashKey) as {dismiss?:boolean;composing?:boolean}|undefined
  const composing=meta?.composing??before.composing,match=findSlash(state)
  const dismissed=meta?.dismiss?(match?.from??null):before.dismissed===null?null:tr.mapping.map(before.dismissed,1)
  return{match:composing||match?.from===dismissed?null:match,dismissed:match?.from===dismissed?dismissed:null,composing}
 }},
 props:{handleDOMEvents:{compositionstart:view=>{view.dispatch(view.state.tr.setMeta(slashKey,{composing:true}));return false}}},
 view:view=>{
  let timer:ReturnType<typeof setTimeout>|undefined,closed=false
  const end=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!closed)view.dispatch(view.state.tr.setMeta(slashKey,{composing:false}))},0)}
  view.dom.addEventListener('compositionend',end)
  return{destroy:()=>{closed=true;clearTimeout(timer);view.dom.removeEventListener('compositionend',end)}}
 },
})}
