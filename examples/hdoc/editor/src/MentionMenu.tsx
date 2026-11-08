import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import type {Editor} from '@tiptap/core'
import {api,type Session} from './api.ts'
import {useI18n} from './i18n.tsx'
import {findMention,mentionKey,mentionPlugin,readMentionPage,type MentionCandidate,type MentionMatch} from './mentionSuggestion.ts'
type Results={scope:string;items:MentionCandidate[];cursor:string|null;loading:boolean;failed:boolean}
const empty:Results={scope:'',items:[],cursor:null,loading:false,failed:false}
/** Suggestions are private server results, never derived from online presence.
 * A query/identity change aborts and clears them before another result can insert. */
export function useMentionMenu(editor:Editor|null,session:Session,disabled:boolean,insert:(match:MentionMatch,candidate:MentionCandidate)=>Promise<unknown>){
 const {t}=useI18n(),id=useId(),root=useRef<HTMLDivElement>(null),sequence=useRef(0),controller=useRef<AbortController|null>(null)
 const [,refresh]=useState(0),[focused,setFocused]=useState(false),[results,setResults]=useState<Results>(empty),[selected,setSelected]=useState(0),[retry,setRetry]=useState(0),[position,setPosition]=useState<{left:number;top:number;height:number}|null>(null)
 const match=editor&&!editor.isDestroyed?mentionKey.getState(editor.state)?.match:null,active=!!match&&!disabled&&focused
 const scope=JSON.stringify([session.documentId,session.token,session.apiUrl,session.collaborationEpoch,match?.from,match?.query]),current=useRef({active,scope,match,disabled});current.current={active,scope,match,disabled}
 const visible=active&&results.scope===scope?results:empty,index=Math.max(0,Math.min(selected,visible.items.length-1))
 useEffect(()=>{if(!editor||editor.isDestroyed)return;editor.registerPlugin(mentionPlugin());const update=()=>refresh(n=>n+1),focus=()=>setFocused(true),blur=()=>setFocused(false);editor.on('transaction',update);editor.on('focus',focus);editor.on('blur',blur);setFocused(editor.isFocused);update();return()=>{editor.off('transaction',update);editor.off('focus',focus);editor.off('blur',blur);if(!editor.isDestroyed)editor.unregisterPlugin(mentionKey)}},[editor])
 const load=async(cursor:string|null,append:boolean,requestScope=scope)=>{
  controller.current?.abort();const abort=new AbortController();controller.current=abort;const seq=++sequence.current,expected=current.current.match
  if(!current.current.active||current.current.scope!==requestScope||!expected)return
  setResults(old=>({scope:requestScope,items:append&&old.scope===requestScope?old.items:[],cursor:null,loading:true,failed:false}))
  let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort()},15000)
  try{const query=new URLSearchParams({kind:'person',q:expected.query,limit:'20'});if(cursor)query.set('cursor',cursor)
   const page=readMentionPage(await(await api(session,`/mention-options?${query}`,{signal:abort.signal})).json())
   if(abort.signal.aborted||seq!==sequence.current||current.current.scope!==requestScope||!current.current.active)return
   setResults(old=>({scope:requestScope,items:append?[...old.items,...page.items.filter(item=>!old.items.some(old=>old.id===item.id))]:page.items,cursor:page.nextCursor,loading:false,failed:false}))
  }catch{if(seq===sequence.current&&current.current.scope===requestScope&&(!abort.signal.aborted||timedOut))setResults({scope:requestScope,items:[],cursor:null,loading:false,failed:true})}finally{clearTimeout(timeout)}
 }
 const loadRef=useRef(load);loadRef.current=load
 useEffect(()=>{
  setSelected(0);setResults(empty);if(!active){controller.current?.abort();return}
  const timer=setTimeout(()=>void loadRef.current(null,false,scope),150)
  return()=>{clearTimeout(timer);sequence.current++;controller.current?.abort()}
 },[active,scope,retry])
 useLayoutEffect(()=>{
  if(!active||!editor){setPosition(null);return}
  let frame=0,closed=false
  const update=()=>{frame=0;if(closed||editor.isDestroyed)return;const latest=mentionKey.getState(editor.state)?.match;if(!latest){setPosition(null);return}const caret=editor.view.coordsAtPos(latest.to),box=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect(),lower=Math.min(innerHeight,box?.bottom??innerHeight),upper=Math.max(0,box?.top??0)
   if(caret.bottom<upper||caret.top>lower){setPosition(null);return}const below=lower-caret.bottom-12,above=caret.top-upper-12,flip=below<200&&above>below,height=Math.min(340,flip?above:below)
   setPosition(height<60?null:{left:Math.max(8,Math.min(caret.left,innerWidth-Math.min(320,innerWidth-16)-8)),top:flip?Math.max(upper+6,caret.top-height-6):caret.bottom+6,height})}
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)},observer=new ResizeObserver(schedule);observer.observe(editor.view.dom);window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);update()
  return()=>{closed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[editor,active,match?.to,scope])
 useEffect(()=>{root.current?.querySelector(`[data-mention-option="${index}"]`)?.scrollIntoView({block:'nearest'})},[index,visible.items.length])
 useEffect(()=>{if(!editor||editor.isDestroyed)return;const element=editor.view.dom,keys=['aria-controls','aria-activedescendant','aria-expanded','aria-haspopup'] as const,old=keys.map(key=>element.getAttribute(key));if(active&&position){element.setAttribute('aria-controls',id);element.setAttribute('aria-expanded','true');element.setAttribute('aria-haspopup','listbox');if(visible.items.length)element.setAttribute('aria-activedescendant',`${id}-${index}`)}return()=>keys.forEach((key,i)=>old[i]===null?element.removeAttribute(key):element.setAttribute(key,old[i]!))},[editor,active,position,id,index,visible.items.length])
 const dismiss=()=>{sequence.current++;controller.current?.abort();if(editor&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta(mentionKey,{dismiss:true}))}
 const choose=(candidate:MentionCandidate)=>{
  const latest=editor&&!editor.isDestroyed?findMention(editor.state):null
  if(!latest||!current.current.active||results.scope!==current.current.scope||latest.text!==match?.text||latest.from!==match.from)return
  void insert(latest,candidate).then(result=>{if(result)dismiss()}).catch(()=>setResults({scope,items:[],cursor:null,loading:false,failed:true}))
 }
 const handleKey=(event:KeyboardEvent)=>{
  if(!active||!position||!editor||!(event.target instanceof Node)||!editor.view.dom.contains(event.target)||event.isComposing||event.keyCode===229||editor.view.composing||event.ctrlKey||event.metaKey||event.altKey||event.getModifierState('AltGraph'))return false
  if(event.key==='Escape'){dismiss();return true}if(['ArrowDown','ArrowUp'].includes(event.key)){setSelected((index+(event.key==='ArrowDown'?1:-1)+visible.items.length)%Math.max(1,visible.items.length));return true}if(event.key==='Enter'){if(visible.items[index])choose(visible.items[index]);return true}if(event.key==='Tab')dismiss();return false
 }
 const menu=active&&position?<div ref={root} className="hcd-mention-menu" style={{left:position.left,top:position.top,maxHeight:position.height}} onMouseDown={event=>event.preventDefault()}><div className="hcd-slash-caption">{t('mentionPeople')}</div><div id={id} role="listbox" aria-label={t('mentionPeople')} aria-busy={visible.loading}>{visible.items.map((candidate,i)=><button key={candidate.id} id={`${id}-${i}`} data-mention-option={i} type="button" role="option" aria-selected={index===i} tabIndex={-1} onMouseMove={()=>setSelected(i)} onClick={()=>choose(candidate)}><span className="hcd-mention-avatar" aria-hidden="true">{Array.from(candidate.label)[0]}</span><span><strong>{candidate.label}</strong><small>{candidate.detail||candidate.id}</small></span></button>)}</div>{(!visible.scope||visible.loading)&&<p role="status">{t('mentionLoading')}</p>}{visible.failed&&<p role="status">{t('mentionUnavailable')} <button type="button" onClick={()=>setRetry(n=>n+1)}>{t('retry')}</button></p>}{visible.scope&&!visible.loading&&!visible.failed&&!visible.items.length&&<p role="status">{t('mentionNoResults')}</p>}{visible.cursor&&<button className="hcd-mention-more" type="button" onClick={()=>void load(visible.cursor,true)}>{t('mentionMore')}</button>}<div className="hcd-slash-hint">{t('mentionKeyboardHint')}</div></div>:null
 return{menu,handleKey,active,dismiss}
}
