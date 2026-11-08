import {Fragment,type ResolvedPos} from '@tiptap/pm/model'
import {TextSelection,type EditorState} from '@tiptap/pm/state'
import type {Editor} from '@tiptap/core'
import {captureStructurePoint,resolveStructurePoint,type StructurePoint,type StructureSelectionStore} from '../semanticStructureSelection.ts'
import {api,ApiError,type Session} from '../api.ts'
import {AiError,aiText} from './core.ts'
import type {AiAdapter,AiMode} from './types.ts'
import {editableInlineTextParent} from '../inlineEditingContext.ts'
import {inlineContainerNodeName} from '../inlineContainerPayload.ts'
export type SemanticAiTarget={from:StructurePoint;to:StructurePoint;mode:AiMode;parent:string;kind:string;level:number|null;source:string;fingerprint:string;before:string;after:string}
export type SemanticAiStore=StructureSelectionStore&{readonly initialized:boolean}
const validParent=(state:EditorState)=>state.selection instanceof TextSelection&&editableInlineTextParent(state)
const parentIdentity=(point:ResolvedPos):string|undefined=>point.parent.type.name===inlineContainerNodeName?`extension:${point.parent.attrs.extension.instanceId}`:point.parent.attrs.hcdStructureKey
function fragment(state:EditorState,from:number,to:number){
 const content=state.doc.slice(from,to).content
 let valid=true;content.descendants(node=>{if(!node.isText&&node.type.name!=='hardBreak'||node.marks.some(mark=>['code','link'].includes(mark.type.name)))valid=false})
 if(!valid)return null
 return JSON.stringify(content.toJSON(),(key,value)=>key==='marks'&&Array.isArray(value)?value.filter(mark=>mark.type!=='hcdSource'):value)
}
function context(state:EditorState,from:number,to:number){
 const point=state.doc.resolve(from),start=point.start(),end=point.end()
 // Read only bounded windows; skip atom identity/fallback content.
 const read=(a:number,b:number)=>state.doc.textBetween(a,b,'\n',node=>node.type.name==='hardBreak'?'\n':'\ufffc')
 const left=read(Math.max(start,from-1200),from),right=read(to,Math.min(end,to+1200))
 const clean=(text:string)=>Array.from(text).filter(char=>aiText(char)).join('')
 return{before:clean(left),after:clean(right)}
}
/** List indentation and table navigation own Tab; the accept button still works. */
export function completionTabReserved(state:EditorState){
 for(let depth=state.selection.$from.depth;depth>0;depth--)if(['listItem','taskItem','tableCell','tableHeader'].includes(state.selection.$from.node(depth).type.name))return true
 return false
}
/** Cheap command availability; capture CRDT bookmarks only when a request starts. */
export function canAiSelection(state:EditorState,mode:AiMode){
 if(!validParent(state))return false
 const {from,to,$from,empty}=state.selection
 if(mode==='replace'&&empty||mode==='insert'&&!empty||to-from>8000||typeof parentIdentity($from)!=='string')return false
 if($from.marks().some(mark=>['code','link'].includes(mark.type.name)))return false
 return fragment(state,from,to)!==null
}
export function captureAiTarget(store:SemanticAiStore,state:EditorState,mode:AiMode):SemanticAiTarget|null{
 if(!canAiSelection(state,mode)||!store.initialized)return null
 const {from,to,$from,empty}=state.selection
 if(mode==='replace'&&empty||mode==='insert'&&!empty||to-from>8000)return null
 if($from.marks().some(mark=>['code','link'].includes(mark.type.name)))return null
 const source=state.doc.textBetween(from,to,'\n',node=>node.type.name==='hardBreak'?'\n':'\ufffc'),fingerprint=fragment(state,from,to)
 if(fingerprint===null||!aiText(source))return null
 const first=captureStructurePoint(store,state.doc,from,mode==='replace'?1:-1),last=captureStructurePoint(store,state.doc,to,-1),parent=parentIdentity($from)
 if(!first?.relative||!last?.relative||typeof parent!=='string')return null
 return{from:first,to:last,mode,parent,kind:$from.parent.type.name,level:$from.parent.attrs.level??null,source,fingerprint,...context(state,from,to)}
}
export function resolveAiTarget(store:SemanticAiStore,state:EditorState,target:SemanticAiTarget):{from:number;to:number}|null{
 try{
  const from=resolveStructurePoint(store,state.doc,target.from),to=resolveStructurePoint(store,state.doc,target.to)
  if(from===null||to===null||from>to)return null
  const first=state.doc.resolve(from),last=state.doc.resolve(to)
  if(!editableInlineTextParent(state,first,last)||parentIdentity(first)!==target.parent||first.parent.type.name!==target.kind||(first.parent.attrs.level??null)!==target.level||fragment(state,from,to)!==target.fingerprint)return null
  if(target.mode==='insert'){
   const now=context(state,from,to)
   // A peer typing at the empty insertion boundary must invalidate it.
   if(now.before.slice(-32)!==target.before.slice(-32)||now.after.slice(0,32)!==target.after.slice(0,32))return null
  }
  return{from,to}
 }catch{return null}
}
export function aiTextTransaction(state:EditorState,range:{from:number;to:number},text:string){
 if(!text.length||!aiText(text))throw new AiError('protocol')
 const marks=state.doc.resolve(range.from).marks().filter(mark=>!['link','code'].includes(mark.type.name))
 const nodes=text.split('\n').flatMap((line,index)=>[...(index?[state.schema.nodes.hardBreak.create()]:[]),...(line?[state.schema.text(line,marks)]:[])])
 const tr=state.tr.replaceWith(range.from,range.to,Fragment.fromArray(nodes))
 return tr.setSelection(TextSelection.create(tr.doc,range.from+nodes.reduce((length,node)=>length+node.nodeSize,0))).setMeta('hcd-ai-accepted',true)
}
export function createSemanticAiAdapter(options:{requireCaret?:boolean;session:Session;editor:()=>Editor|null;store:()=>SemanticAiStore|undefined;canWrite:()=>boolean;revision:()=>number|null;locale:()=>string;history:{stopCapturing:()=>void}}):AiAdapter<SemanticAiTarget>{
 const active=()=>{const editor=options.editor(),store=options.store();if(!editor||editor.isDestroyed||editor.view.composing||!editor.isEditable||!store||!options.canWrite())throw new AiError('denied');return{editor,store}}
 const authorize=async(_target:SemanticAiTarget,signal:AbortSignal)=>{
  active();const access=await(async()=>{try{return await(await api(options.session,'/auth',{signal})).json()}catch(error){if(error instanceof ApiError&&[401,403].includes(error.status))throw new AiError('denied');throw error}})() as {scope:string;userId?:string;collaborationEpoch:number;collaborationProtocol?:string}
  if(signal.aborted)throw new AiError('cancelled')
  if(access.scope!=='write'||access.userId!==options.session.userId||access.collaborationEpoch!==(options.session.collaborationEpoch??0)||access.collaborationProtocol!==options.session.collaborationProtocol)throw new AiError('denied')
  active()
 }
 return{
  prepare:async(mode,signal)=>{
   const {editor,store}=active(),target=captureAiTarget(store,editor.state,mode);if(!target)throw new AiError('invalid-target')
   await authorize(target,signal)
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(target.fingerprint)))).map(byte=>byte.toString(16).padStart(2,'0')).join('')
   return{target,context:{documentId:options.session.documentId,format:options.session.format,revision:options.revision(),locale:options.locale(),source:{text:target.source,digest},before:target.before,after:target.after}}
  },
  valid:target=>{try{const {editor,store}=active(),range=resolveAiTarget(store,editor.state,target);return !!range&&(!options.requireCaret||editor.state.selection.empty&&editor.state.selection.from===range.from&&range.from===range.to)}catch{return false}},
  authorize,
  commit:(target,text)=>{
   const {editor,store}=active(),range=resolveAiTarget(store,editor.state,target);if(!range||options.requireCaret&&(!editor.state.selection.empty||editor.state.selection.from!==range.from||range.from!==range.to))return false
   const tr=aiTextTransaction(editor.state,range,text);options.history.stopCapturing()
   // Tiptap emits transaction only if the root passed filterTransaction. Its
   // appended source/default repairs may legitimately differ from tr.doc.
   let applied=false;const accepted=({transaction}:{transaction:typeof tr})=>{if(transaction===tr)applied=true}
   editor.on('transaction',accepted)
   try{editor.view.dispatch(tr.scrollIntoView());return applied}finally{editor.off('transaction',accepted);options.history.stopCapturing()}
  },
  locate:target=>{try{const {editor,store}=active(),position=resolveStructurePoint(store,editor.state.doc,target.from);if(position===null)return false;const box=editor.view.coordsAtPos(position),scroll=editor.view.dom.closest('.document-scroll');if(scroll){scroll.dispatchEvent(new Event('hcd-user-navigation'));scroll.scrollTo({top:scroll.scrollTop+box.top-scroll.getBoundingClientRect().top-64,behavior:'auto'})}return true}catch{return false}},
 }
}
