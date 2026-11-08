import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import type {Editor} from '@tiptap/core'
import {useI18n,type MessageKey} from '../i18n.tsx'
import {EditorIcon,isEditorIcon} from '../EditorIcon.tsx'
import type {CommandRegistry} from './registry.ts'
import type {SlashTarget} from './insertion.ts'
import {initialEnabledIndex,moveEnabledIndex} from './menuNavigation.ts'
import {slashKey,slashPlugin} from './slash.ts'

type Position={left:number;top:number;height:number}
/** No document content lives in React state; all trigger state is mapped by PM. */
export function useSlashMenu(editor:Editor|null,registry:CommandRegistry,insert:(id:string,target:SlashTarget,signal?:AbortSignal)=>Promise<boolean>,disabled:boolean){
 const {t}=useI18n(),id=useId(),root=useRef<HTMLDivElement>(null),pending=useRef(false),cancellation=useRef<AbortController|null>(null)
 const [,refresh]=useState(0),[selected,setSelected]=useState(0),[position,setPosition]=useState<Position|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[focused,setFocused]=useState(false)
 const match=editor&&!editor.isDestroyed?slashKey.getState(editor.state)?.match:null
 const active=!!match&&!disabled&&focused,items=active?registry.list('slash',match!.query):[],index=items[selected]?.enabled?selected:initialEnabledIndex(items)
 const current=useRef({active,match,items,index,busy});current.current={active,match,items,index,busy}
 useEffect(()=>{
  if(!editor||editor.isDestroyed)return
  editor.registerPlugin(slashPlugin())
  const update=()=>refresh(value=>value+1),focus=()=>setFocused(true),blur=()=>setFocused(false)
  editor.on('transaction',update);editor.on('focus',focus);editor.on('blur',blur);setFocused(editor.isFocused);update()
  return()=>{cancellation.current?.abort();editor.off('transaction',update);editor.off('focus',focus);editor.off('blur',blur);if(!editor.isDestroyed)editor.unregisterPlugin(slashKey)}
 },[editor])
 useEffect(()=>{setSelected(0);setFailed(false)},[match?.from,match?.query])
 useLayoutEffect(()=>{
  if(!active||!editor||!match){setPosition(null);return}
  let frame=0,closed=false
  const update=()=>{
   frame=0;if(closed||editor.isDestroyed)return
   const latest=slashKey.getState(editor.state)?.match;if(!latest){setPosition(null);return}
   const caret=editor.view.coordsAtPos(latest.to),scroll=editor.view.dom.closest('.document-scroll')?.getBoundingClientRect()
   const lower=Math.min(window.innerHeight,scroll?.bottom??window.innerHeight),upper=Math.max(0,scroll?.top??0)
   if(caret.bottom<upper||caret.top>lower){setPosition(null);return}
   const below=lower-caret.bottom-12,above=caret.top-upper-12,flip=below<220&&above>below,height=Math.min(340,(flip?above:below))
   if(height<60){setPosition(null);return}
   setPosition({left:Math.max(8,Math.min(caret.left,window.innerWidth-Math.min(320,window.innerWidth-16)-8)),top:flip?Math.max(upper+6,caret.top-height-6):caret.bottom+6,height})
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
  window.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule)
  const observer=new ResizeObserver(schedule);observer.observe(editor.view.dom);update()
  return()=>{closed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule)}
 },[editor,active,match?.from,match?.to,match?.query])
 useEffect(()=>{root.current?.querySelector(`[data-slash-option="${index}"]`)?.scrollIntoView({block:'nearest'})},[index,match?.query])
 useEffect(()=>{
  if(!editor||editor.isDestroyed)return
  const element=editor.view.dom,keys=['aria-controls','aria-activedescendant','aria-expanded','aria-haspopup'] as const,previous=keys.map(key=>element.getAttribute(key))
  if(active&&position){element.setAttribute('aria-controls',id);element.setAttribute('aria-expanded','true');element.setAttribute('aria-haspopup','listbox');if(index>=0)element.setAttribute('aria-activedescendant',`${id}-${index}`)}
  return()=>{keys.forEach((key,i)=>previous[i]===null?element.removeAttribute(key):element.setAttribute(key,previous[i]!))}
 },[editor,active,position,id,index,items.length])
 const dismiss=()=>{cancellation.current?.abort();if(editor&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta(slashKey,{dismiss:true}))}
 const choose=async(commandId:string)=>{
  if(!editor||editor.isDestroyed||pending.current)return
  const latest=slashKey.getState(editor.state)?.match,item=registry.list('slash',latest?.query??'').find(item=>item.id===commandId)
  if(!latest||!item?.enabled)return
  pending.current=true;const controller=new AbortController();cancellation.current=controller;setBusy(true);setFailed(false)
  try{const result=await insert(commandId,{...latest,anchor:registry.context().selection.anchor},controller.signal);if(result)dismiss();else if(!controller.signal.aborted)setFailed(true)}
  finally{pending.current=false;setBusy(false)}
 }
 const handleKey=(event:KeyboardEvent)=>{
  if(!current.current.active||!position||!editor||!(event.target instanceof Node)||!editor.view.dom.contains(event.target)||event.isComposing||event.keyCode===229||editor.view.composing||event.getModifierState('AltGraph')||event.ctrlKey||event.metaKey||event.altKey)return false
  if(event.key==='Escape'){dismiss();return true}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){setSelected(moveEnabledIndex(items,index,event.key==='ArrowDown'?1:-1));return true}
  if(event.key==='Enter'){if(items[index]?.enabled&&!busy)void choose(items[index].id);return true}
  if(event.key==='Tab')dismiss()
  return false
 }
 const groups:Array<{key:string;label:string;entries:Array<{item:typeof items[number];index:number}>}>=[]
 const labels:Record<string,MessageKey>={ai:'aiAssistant',style:'styles',paragraph:'paragraph',insert:'insert'}
 items.forEach((item,index)=>{if(groups.at(-1)?.key!==item.group)groups.push({key:item.group,label:item.groupLabel||t(labels[item.group]??'commandExtensions'),entries:[]});groups.at(-1)!.entries.push({item,index})})
 const menu=active&&position?<div ref={root} id={id} className="hcd-slash-menu" role="listbox" aria-label={t('slashInsert')} aria-busy={busy} style={{left:position.left,top:position.top,maxHeight:position.height}} onMouseDown={event=>event.preventDefault()}>
  <div className="hcd-slash-caption">{busy?t('slashRunning'):t('slashInsert')}</div>
  {groups.map((group,groupIndex)=><div role="group" aria-label={group.label} key={`${group.key}:${groupIndex}`}><div className="hcd-slash-group" aria-hidden="true">{group.label}</div>{group.entries.map(({item,index:i})=><button key={item.id} id={`${id}-${i}`} data-slash-option={i} data-command-id={item.id} type="button" role="option" aria-selected={index===i} aria-disabled={!item.enabled||busy} tabIndex={-1} onMouseMove={()=>setSelected(i)} onClick={()=>void choose(item.id)}>
   <span className="hcd-slash-icon" aria-hidden="true">{item.icon&&isEditorIcon(item.icon)?<EditorIcon name={item.icon}/>:item.icon??'+'}</span><span><strong>{item.label}</strong>{item.description&&<small>{item.description}</small>}</span>
  </button>)}</div>)}
  {failed&&<p role="status">{t('commandUnavailable')}</p>}
  {!items.length&&<p role="status">{t('commandNoResults')}</p>}<div className="hcd-slash-hint">{t('commandKeyboardHint')}</div>
 </div>:null
 return{menu,handleKey,dismiss,active}
}
