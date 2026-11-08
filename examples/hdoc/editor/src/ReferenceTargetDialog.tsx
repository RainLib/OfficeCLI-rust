import {useEffect,useId,useRef,useState} from 'react'
import {api,type Session} from './api.ts'
import type {InlineReference} from './inlineReference.ts'
import {readMentionPage,type MentionCandidate} from './mentionSuggestion.ts'
import {useI18n} from './i18n.tsx'
export function ReferenceTargetDialog({session,reference,onApply,onClose}:{session:Session;reference:InlineReference;onApply:(candidate:MentionCandidate)=>Promise<unknown>;onClose:()=>void}){
 const {t}=useI18n(),id=useId(),root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),[query,setQuery]=useState(''),[page,setPage]=useState<string|null>(null),[retry,setRetry]=useState(0),[selected,setSelected]=useState(0),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const [result,setResult]=useState<{scope:string;items:MentionCandidate[];next:string|null}|null>(null),scope=JSON.stringify([session.documentId,session.token,session.apiUrl,query,page,retry]),scopeRef=useRef(scope);scopeRef.current=scope
 useEffect(()=>{const previous=document.activeElement;input.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()}},[])
 useEffect(()=>{
  const controller=new AbortController();let alive=true;setResult(null);setFailed(false);setSelected(0)
  const params=new URLSearchParams({kind:'person',q:query,limit:'20'});if(page)params.set('cursor',page)
  void api(session,`/mention-options?${params}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),cache:'no-store'}).then(response=>response.json()).then(readMentionPage).then(value=>{if(alive&&!controller.signal.aborted)setResult({scope,items:value.items,next:value.nextCursor})}).catch(()=>{if(alive&&!controller.signal.aborted)setFailed(true)})
  return()=>{alive=false;controller.abort()}
 },[scope])
 useEffect(()=>{root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'})},[selected,result])
 const items=result?.scope===scope?result.items:[],choose=async(candidate:MentionCandidate)=>{if(busy||scopeRef.current!==scope||!items.includes(candidate))return;const requestScope=scope;setBusy(true);setFailed(false);try{const applied=await onApply(candidate);if(!applied)throw new Error('reference-changed');if(scopeRef.current===requestScope)onClose()}catch{if(scopeRef.current===requestScope)setFailed(true)}finally{setBusy(false)}}
 return <div className="hcd-command-backdrop"><div ref={root} className="hcd-command-palette" role="dialog" aria-modal="true" aria-label={t('referenceRetarget')} onKeyDown={event=>{
  if(event.nativeEvent.isComposing||event.keyCode===229)return
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}
  else if((event.key==='ArrowDown'||event.key==='ArrowUp')&&event.target===input.current){event.preventDefault();setSelected(value=>(value+(event.key==='ArrowDown'?1:-1)+items.length)%Math.max(1,items.length))}
  else if(event.key==='Enter'&&event.target===input.current&&items[selected]){event.preventDefault();void choose(items[selected])}
  else if(event.key==='Tab'){const focusable=[...(root.current?.querySelectorAll<HTMLElement>('input,button:not([disabled])')??[])];if(focusable.length){event.preventDefault();const at=focusable.indexOf(document.activeElement as HTMLElement);focusable[(at+(event.shiftKey?-1:1)+focusable.length)%focusable.length].focus()}}
 }}><div className="panel-head"><h3>{t('referenceRetarget')}</h3><button type="button" aria-label={t('close')} onClick={onClose}>×</button></div><p>{t('referenceRetargetHint',{name:reference.snapshot.label})}</p><div className="hcd-command-search"><input ref={input} maxLength={80} role="combobox" aria-expanded="true" aria-controls={id} aria-activedescendant={items.length?`${id}-${selected}`:undefined} aria-label={t('referenceSearchPerson')} disabled={busy} value={query} onChange={event=>{setQuery(event.target.value);setPage(null)}}/></div><div id={id} role="listbox" className="hcd-command-results">{items.map((candidate,index)=><button key={candidate.id} id={`${id}-${index}`} type="button" role="option" aria-selected={index===selected} disabled={busy} onMouseDown={event=>event.preventDefault()} onMouseMove={()=>setSelected(index)} onClick={()=>void choose(candidate)}><span><strong>{candidate.label}</strong>{candidate.detail&&<small>{candidate.detail}</small>}</span></button>)}</div>{!result&&!failed&&<p role="status">{t('mentionLoading')}</p>}{result&&!items.length&&<p role="status">{t('mentionNoResults')}</p>}{failed&&<p role="alert">{t('referenceRetargetFailed')} <button type="button" disabled={busy} onClick={()=>setRetry(value=>value+1)}>{t('retry')}</button></p>}{result?.next&&<button type="button" disabled={busy} onClick={()=>setPage(result.next)}>{t('mentionMore')}</button>}</div></div>
}
