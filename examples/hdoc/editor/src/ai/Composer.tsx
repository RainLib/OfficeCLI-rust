import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import type {Editor} from '@tiptap/core'
import type {SelectionBookmark} from '@tiptap/pm/state'
import {useI18n} from '../i18n.tsx'
import {aiActionLabel} from './react.tsx'
import type {AiAction,AiSnapshot} from './types.ts'
export type AiComposerEntry={id:string;bookmark:SelectionBookmark}
export function AiComposer({editor,entry,state,actions,available,canReplace,canInsert,onStart,onAccept,onCancel,onDismiss,onClose}:{editor:Editor;entry:AiComposerEntry;state:AiSnapshot;actions:readonly AiAction[];available:boolean;canReplace:boolean;canInsert:boolean;onStart:(action:string,instruction:string)=>void;onAccept:()=>void;onCancel:()=>void;onDismiss:()=>void;onClose:()=>void}){
 const {t,locale}=useI18n(),root=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),bookmark=useRef(entry.bookmark),close=useRef(onClose),didFocus=useRef(false);close.current=onClose
 const [geometry,setGeometry]=useState<{left:number;top:number;width:number;height:number}|null>(null),[instruction,setInstruction]=useState(state.instruction??''),[selected,setSelected]=useState(state.action??actions.find(action=>action.mode===(canReplace?'replace':'insert'))?.id??'')
 const busy=['requesting','streaming','applying'].includes(state.phase),action=actions.find(action=>action.id===selected),canStart=available&&!!action&&(action.mode==='replace'?canReplace:canInsert)
 useEffect(()=>{if(geometry&&!didFocus.current){didFocus.current=true;input.current?.focus()}},[!!geometry])
 useEffect(()=>{if(state.action)setSelected(state.action)},[state.action])
 useLayoutEffect(()=>{
  let raf=0,closed=false
  const position=()=>{raf=0;if(closed||editor.isDestroyed)return;try{const range=bookmark.current.resolve(editor.state.doc),box=editor.view.coordsAtPos(range.to),scroll=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect(),left=Math.max(8,scroll?.left??0),right=Math.min(innerWidth-8,scroll?.right??innerWidth-8),top=Math.max(8,scroll?.top??0),bottom=Math.min(innerHeight-8,scroll?.bottom??innerHeight-8),width=Math.min(440,right-left),height=Math.min(440,bottom-top-12),below=bottom-box.bottom-8,above=box.top-top-8,flip=below<220&&above>below;if(box.bottom<top||box.top>bottom||width<180||height<100){setGeometry(null);return}setGeometry({left:Math.max(left,Math.min(box.left,right-width)),top:flip?Math.max(top,box.top-Math.min(root.current?.scrollHeight??220,height,above)-8):Math.max(top,Math.min(box.bottom+8,bottom-Math.min(root.current?.scrollHeight??220,height,Math.max(180,below)))),width,height:Math.min(height,Math.max(180,flip?above:below))})}catch{setGeometry(null)}}
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(position)},transaction=({transaction}:{transaction:Editor['state']['tr']})=>{bookmark.current=bookmark.current.map(transaction.mapping);schedule()}
  editor.on('transaction',transaction);window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);const observer=new ResizeObserver(schedule);observer.observe(editor.view.dom);if(root.current)observer.observe(root.current);position()
  return()=>{closed=true;cancelAnimationFrame(raf);observer.disconnect();editor.off('transaction',transaction);window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[editor])
 useEffect(()=>{const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close.current()};window.addEventListener('pointerdown',outside,true);return()=>window.removeEventListener('pointerdown',outside,true)},[])
 const submit=()=>{if(canStart&&!busy&&action)onStart(action.id,instruction)}
 return <div ref={root} className="hcd-ai-composer" role="dialog" aria-label={t('aiAssistant')} style={geometry?{left:geometry.left,top:geometry.top,width:geometry.width,maxHeight:geometry.height}:{visibility:'hidden'}} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();editor.view.focus()}}}>
  <div className="hcd-ai-composer-head"><strong>✦ {t('aiAssistant')}</strong><span>{t('aiPrivateShort')}</span><button type="button" aria-label={t('close')} onClick={onClose}>×</button></div>
  <div className="hcd-ai-composer-prompt"><textarea ref={input} aria-label={t('aiInstruction')} placeholder={canReplace?t('aiSelectionPrompt'):t('aiEmptyPrompt')} rows={2} maxLength={2000} value={instruction} disabled={busy} onChange={event=>setInstruction(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit()}}}/><button type="button" disabled={!canStart||busy} onClick={submit} aria-label={t('aiGenerate')}>↑</button></div>
  <div className="hcd-ai-composer-presets" role="group" aria-label={t('aiAction')}>{actions.map(option=><button type="button" key={option.id} aria-pressed={selected===option.id} disabled={busy||!available||!(option.mode==='replace'?canReplace:canInsert)} onClick={()=>{setSelected(option.id);onStart(option.id,'')}}>{aiActionLabel(option,locale)}</button>)}</div>
  {!available&&<p role="status">{t('aiUnavailable')}</p>}{available&&!canStart&&!busy&&!state.requestId&&<p>{t('aiSelectHint')}</p>}
  {state.source&&<details><summary>{t('aiOriginal')}</summary><pre>{state.source}</pre></details>}
  {state.requestId&&<p className="hcd-ai-state" role="status" aria-live="polite">{t(`aiState_${state.phase}`)}</p>}{state.error&&<p role="alert">{t(`aiError_${state.error}`)}</p>}
  {state.output&&<div className="hcd-ai-suggestion" aria-label={t('aiSuggestion')}><pre>{state.output}</pre></div>}
  <div className="hcd-ai-composer-actions">{busy?<button type="button" onClick={onCancel}>{t('aiCancel')}</button>:state.requestId?<><button type="button" disabled={state.phase!=='ready'} onClick={onAccept}>{t(state.mode==='replace'?'aiReplaceSelection':'aiInsertHere')}</button><button type="button" disabled={!canStart} onClick={submit}>{t('aiTryAgain')}</button><button type="button" onClick={onDismiss}>{t('aiDismiss')}</button></>:<small>{t('aiPromptKeys')}</small>}</div>
 </div>
}
