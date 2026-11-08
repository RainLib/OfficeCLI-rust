import {useEffect,useRef} from 'react'
import type {Editor} from '@tiptap/core'
import type {Transaction} from '@tiptap/pm/state'
import {findSlash} from '../commands/slash.ts'
import {findMention} from '../mentionSuggestion.ts'
import {canAiSelection,completionTabReserved} from './semantic.ts'
import {AiCompletionScheduler,completionKey,isCompletionInput,type AutocompletePolicy} from './autocomplete.ts'
import {aiGhostKey,aiGhostPlugin,type AiGhost} from './ghost.ts'
import type {AiSuggestionController} from './core.ts'
import type {SemanticAiTarget} from './semantic.ts'
import type {AiSnapshot} from './types.ts'
import {useI18n} from '../i18n.tsx'
export type AiAutocompleteService={eligible:()=>boolean;ready:()=>boolean;accept:(requestId:string)=>Promise<boolean>;dismiss:()=>void;handleKey:(event:KeyboardEvent)=>boolean}
export function useAiAutocomplete(options:{editor:Editor|null;controller:AiSuggestionController<SemanticAiTarget>|null;state:AiSnapshot;policy:AutocompletePolicy;enabled:boolean;blocked:boolean;online:boolean;onAccept:(requestId:string)=>void}):AiAutocompleteService{
 const {t}=useI18n(),latest=useRef({...options,t});latest.current={...options,t}
 const scheduler=useRef<AiCompletionScheduler|null>(null),paint=useRef<(()=>void)|null>(null),widget=useRef<HTMLElement|null>(null),composing=useRef(false),denied=useRef(false)
 const eligible=()=>{
  const {editor,controller,enabled,blocked,online,policy}=latest.current
  if(!editor||editor.isDestroyed||!controller||!policy.available||!enabled||blocked||!online||denied.current||!editor.isEditable||!editor.isFocused||editor.view.composing||composing.current||document.visibilityState==='hidden'||!document.hasFocus()||navigator.onLine===false)return false
  if(!canAiSelection(editor.state,'insert')||findSlash(editor.state)||findMention(editor.state))return false
  const {$from}=editor.state.selection,before=$from.parent.textBetween(Math.max(0,$from.parentOffset-1200),$from.parentOffset,'\n','\ufffc')
  return Array.from(before.replaceAll('\ufffc','').trim()).length>=policy.minPrefix
 }
 const ready=()=>eligible()&&latest.current.controller?.snapshot().phase==='ready'
 const visible=()=>{
  const node=widget.current,editor=latest.current.editor;if(!node?.isConnected||!editor||editor.isDestroyed)return false
  const style=getComputedStyle(node);if(style.visibility!=='visible'||style.display==='none'||Number(style.opacity)===0)return false
  const scroll=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect(),upper=Math.max(0,scroll?.top??0),lower=Math.min(innerHeight,scroll?.bottom??innerHeight),left=Math.max(0,scroll?.left??0),right=Math.min(innerWidth,scroll?.right??innerWidth)
  return [...node.getClientRects()].some(rect=>rect.width>0&&rect.height>0&&rect.bottom>upper&&rect.top<lower&&rect.right>left&&rect.left<right)
 }
 const dismiss=()=>{scheduler.current?.cancel();latest.current.controller?.dismiss()}
 const accept=async(requestId:string)=>{const controller=latest.current.controller;if(!controller||!ready()||!visible()||controller.snapshot().requestId!==requestId)return false;return controller.accept(requestId)}
 const handleKey=(event:KeyboardEvent)=>{
  const {editor,controller,blocked}=latest.current
  if(!editor||editor.isDestroyed||!(event.target instanceof Node)||!editor.view.dom.contains(event.target))return false
  if(!['Tab','Escape'].includes(event.key)||event.key==='Tab'&&(event.shiftKey||completionTabReserved(editor.state))){if(!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!editor.view.composing)dismiss();return false}
  const state=controller?.snapshot(),active=!!scheduler.current?.pending()||!!state&&['requesting','streaming','ready','applying'].includes(state.phase)
  const action=completionKey(event,{active,ready:ready(),applying:state?.phase==='applying',visible:event.key==='Tab'?visible():false,blocked:blocked||!eligible(),composing:composing.current||editor.view.composing})
  if(action==='accept'){latest.current.onAccept(state!.requestId!);return true}
  if(action==='wait')return true
  if(action==='dismiss'){dismiss();return true}
  if(!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!editor.view.composing)dismiss()
  return false
 }
 useEffect(()=>options.controller?.connect(),[options.controller])
 useEffect(()=>{denied.current=false;if(!options.enabled)dismiss()},[options.enabled,options.controller])
 useEffect(()=>{if(options.blocked||!options.online||!options.enabled){dismiss();}paint.current?.()},[options.blocked,options.online,options.enabled,options.controller])
 useEffect(()=>{
  const {editor,controller,policy}=options;if(!editor||!controller||editor.isDestroyed)return
  let requestContext:string|null=null
  let closed=false,compositionTimer:ReturnType<typeof setTimeout>|undefined,compositionInput=false
  const labels=()=>({accept:latest.current.t('aiAutoAccept'),dismiss:latest.current.t('aiAutoDismiss')})
  editor.registerPlugin(aiGhostPlugin({labels,accept:()=>{const id=controller.snapshot().requestId;if(id)latest.current.onAccept(id)},dismiss,mounted:node=>{widget.current=node},unmounted:node=>{if(widget.current===node)widget.current=null}}))
  const render=()=>{
   if(closed||editor.isDestroyed)return
   const state=controller.snapshot();if(state.error==='denied')denied.current=true
   const value:AiGhost|null=eligible()&&['streaming','ready','applying'].includes(state.phase)&&state.output?{requestId:state.requestId!,position:editor.state.selection.from,text:state.output,ready:state.phase==='ready',applying:state.phase==='applying'}:null
   if(JSON.stringify(aiGhostKey.getState(editor.state)??null)!==JSON.stringify(value))editor.view.dispatch(editor.state.tr.setMeta(aiGhostKey,value).setMeta('addToHistory',false))
  }
  paint.current=render
  const context=()=>{
   if(!eligible())return null
   const {$from}=editor.state.selection,before=$from.parent.textBetween(Math.max(0,$from.parentOffset-1200),$from.parentOffset,'\n','\ufffc'),after=$from.parent.textBetween($from.parentOffset,Math.min($from.parent.content.size,$from.parentOffset+64),'\n','\ufffc')
   return JSON.stringify([$from.parent.attrs.hcdStructureKey,$from.parentOffset,before,after])
  }
  const queue=new AiCompletionScheduler({delayMs:policy.delayMs,cooldownMs:policy.cooldownMs,context,cancel:()=>{controller.dismiss();render()},run:key=>{requestContext=key;void controller.start({id:'hcd.autocomplete',label:'Autocomplete',mode:'insert',instruction:latest.current.policy.instruction})}})
  scheduler.current=queue
  const update=({transaction}:{transaction:Transaction})=>{
   if(transaction.getMeta(aiGhostKey)!==undefined)return
   if(transaction.getMeta('hcd-ai-accepted')&&controller.snapshot().phase==='applying')return
   if(transaction.docChanged||transaction.selectionSet){
    if(controller.snapshot().phase==='requesting'&&requestContext!==null&&context()!==requestContext){queue.cancel();return}
    controller.invalidate();render()
   }
  }
  const before=()=>{queue.cancel()}
  const input=(event:Event)=>{
   if(!event.isTrusted)return
   const value=event as InputEvent
   if(value.isComposing||composing.current||editor.view.composing){compositionInput=true;return}
   clearTimeout(compositionTimer);compositionInput=false
   if(isCompletionInput(value.inputType))queue.activity();else queue.cancel()
  }
  const start=()=>{composing.current=true;compositionInput=false;clearTimeout(compositionTimer);queue.cancel()}
  const end=(event:Event)=>{
   composing.current=false;if(!event.isTrusted||!compositionInput)return
   let attempts=0
   const settle=()=>{if(closed)return;if(editor.view.composing&&attempts++<20){compositionTimer=setTimeout(settle,25);return}compositionInput=false;if(!editor.view.composing)queue.activity()}
   clearTimeout(compositionTimer);compositionTimer=setTimeout(settle,25)
  }
  const pointer=(event:Event)=>{if(!(event.target instanceof Element)||!event.target.closest('.hcd-ai-completion-controls'))queue.cancel()}
  const stop=()=>queue.cancel(),element=editor.view.dom
  element.addEventListener('beforeinput',before);element.addEventListener('input',input);element.addEventListener('compositionstart',start);element.addEventListener('compositionend',end);element.addEventListener('pointerdown',pointer)
  editor.on('transaction',update);editor.on('blur',stop);window.addEventListener('blur',stop);window.addEventListener('offline',stop);document.addEventListener('visibilitychange',stop)
  const unsubscribe=controller.subscribe(render);render()
  return()=>{closed=true;clearTimeout(compositionTimer);queue.cancel();unsubscribe();paint.current=null;scheduler.current=null;widget.current=null;composing.current=false;element.removeEventListener('beforeinput',before);element.removeEventListener('input',input);element.removeEventListener('compositionstart',start);element.removeEventListener('compositionend',end);element.removeEventListener('pointerdown',pointer);editor.off('transaction',update);editor.off('blur',stop);window.removeEventListener('blur',stop);window.removeEventListener('offline',stop);document.removeEventListener('visibilitychange',stop);if(!editor.isDestroyed)editor.unregisterPlugin(aiGhostKey)}
 },[options.editor,options.controller,options.policy.delayMs,options.policy.cooldownMs])
 return{eligible,ready,accept,dismiss,handleKey}
}
