import {useEffect,useRef,useState} from 'react'
import type {Session} from './api.ts'
import {useI18n} from './i18n.tsx'
import {WordPageSetup} from './WordPageSetup.tsx'
import {inspectStoppedLayout,stoppedLayoutSubmit} from './wordStoppedLayoutClient.ts'
import type {StoppedLayoutAction} from './wordLayoutAttempt.ts'

type Snapshot=Awaited<ReturnType<typeof inspectStoppedLayout>>
/** Stop-room entry while the full layout-aware editor is unavailable. */
export function WordStoppedPageSetup({session,onStart,onSuccess,blocked=false,savedRevision}:{session:Session;blocked?:boolean;savedRevision?:number|null;onStart:(action:StoppedLayoutAction)=>Promise<void>;onSuccess:(id:string)=>Promise<void>}){
 const {t}=useI18n(),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[section,setSection]=useState(0),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[dialogController,setDialogController]=useState<AbortController|null>(null),active=useRef<AbortController|null>(null)
 useEffect(()=>{setSnapshot(null);setSection(0);setOpen(false);setBusy(false);setError(false);setDialogController(null);return()=>{active.current?.abort();active.current=null}},[session])
 useEffect(()=>{if(savedRevision!==undefined&&savedRevision!==null){active.current?.abort();active.current=null;setBusy(false);setSnapshot(null);setOpen(false);setError(false);setDialogController(null)}},[savedRevision])
 const wasBlocked=useRef(blocked)
 useEffect(()=>{if(wasBlocked.current&&!blocked){setSnapshot(null);setOpen(false);setError(false);setDialogController(null)}wasBlocked.current=blocked},[blocked])
 if(session.scope!=='write'||!session.userId)return null
 const inspect=async()=>{if(active.current)return;const controller=new AbortController();active.current=controller;setBusy(true);setError(false);try{const result=await inspectStoppedLayout(session,controller.signal);if(!controller.signal.aborted){setSnapshot(result);setSection(0)}}catch{if(!controller.signal.aborted)setError(true)}finally{if(active.current===controller){active.current=null;if(!controller.signal.aborted)setBusy(false)}}}
 const close=()=>{active.current?.abort();active.current=null;setOpen(false);setSnapshot(null);setDialogController(null)}
 return <section className="word-checkpoint-recovery" aria-label={t('wordStoppedPageTitle')}><h3>{t('wordStoppedPageTitle')}</h3><p>{t('wordStoppedPageHint')}</p><button type="button" disabled={busy||open||blocked} onClick={()=>void inspect()}>{t(busy?'wordCheckpointChecking':'wordStoppedPageInspect')}</button>
 {snapshot&&<><p>{t('wordStoppedPageRevision',{revision:snapshot.revision})}</p><label>{t('wordStoppedPageSection')}<select value={section} onChange={event=>setSection(Number(event.target.value))}>{snapshot.layout.sections.map((item,index)=><option key={item.id} value={index}>{t('wordSection',{count:index+1})}</option>)}</select></label><button type="button" disabled={busy||open||blocked} onClick={()=>{const controller=new AbortController();active.current=controller;setDialogController(controller);setOpen(true)}}>{t('wordPageSetupTitle')}</button></>}
 {error&&<p role="alert">{t('wordStoppedPageUnavailable')}</p>}
 {snapshot&&open&&dialogController&&<WordPageSetup layout={snapshot.layout} layoutHash={snapshot.layoutHash} revision={snapshot.revision} section={section} onClose={close} onSubmit={input=>{if(blocked)throw Error('word-topology-pending');return stoppedLayoutSubmit(session,snapshot,dialogController.signal,onStart,onSuccess)(input)}}/>}
 </section>
}
