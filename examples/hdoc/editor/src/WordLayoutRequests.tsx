import {wordPageValue} from './wordPageValues.ts'
import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {Session} from './api.ts'
import {WordLayoutAttempts} from './wordLayoutAttempt.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {useI18n} from './i18n.tsx'
import {wordPageFieldLabels} from './WordPageSetup.tsx'
const noop=(_listener:()=>void)=>()=>{},zero=()=>0
export function useWordLayoutRequests(session:Session|undefined){
 const [journal,setJournal]=useState<WordLayoutAttempts|null>(null),[failed,setFailed]=useState(false)
 useEffect(()=>{
  setJournal(null);setFailed(false)
  if(!session||session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol)return
  let live=true,owned:WordLayoutAttempts|undefined
  void Promise.resolve().then(()=>WordLayoutAttempts.open(session,location.href,{legacy:window.sessionStorage})).then(value=>{owned=value;if(!live){value.dispose();return}setJournal(value)}).catch(()=>{if(live)setFailed(true)})
  const focus=()=>{if(owned)void owned.refresh().catch(()=>{if(live)setFailed(true)})};window.addEventListener('focus',focus)
  return()=>{live=false;window.removeEventListener('focus',focus);owned?.dispose()}
 },[session])
 const current=journal?.session===session?journal:null
 useSyncExternalStore(current?.subscribe??noop,current?.snapshot??zero,zero)
 return{journal:current,failed,ready:!!current&&!failed&&current.phase!=='invalid'}
}
export function WordLayoutRequestPanel({journal,failed,blocked,onResolved}:{journal:WordLayoutAttempts|null;failed:boolean;blocked:boolean;onResolved:()=>void}){
 const {t,locale}=useI18n(),[confirm,setConfirm]=useState<string|null>(null),[error,setError]=useState(false),[done,setDone]=useState<number|'cancelled'|null>(null),generation=useRef(0),raw=journal?.backup,record=journal?.record,action=record?.actions.at(-1),original=record?.actions.find(item=>item.kind==='layout'||item.kind==='story')
 useEffect(()=>{setConfirm(null);setError(false);if(raw)setDone(null)},[raw])
 useEffect(()=>()=>{generation.current++},[journal])
 if(!failed&&!raw&&done===null)return null
 const download=()=>{if(!raw)return;const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='word-stopped.hcd-word-topology-request';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 const retry=async()=>{if(!journal||!confirm||blocked||journal.busy)return;const current=generation.current;setError(false);try{await journal.retry(confirm);if(current===generation.current){setConfirm(null);setDone(journal.revision??'cancelled');onResolved()}}catch{if(current===generation.current)setError(true)}}
 const format=(field:string,value:string|number|boolean|null)=>wordPageValue(field,value,t,locale)
 return <section className="word-checkpoint-recovery" aria-label={t('wordLayoutRequestTitle')}><h3>{t('wordLayoutRequestTitle')}</h3>{!raw&&done!==null?<p role="status">{done==='cancelled'?t('wordTopologyNotPrepared'):t('wordTopologyConfirmed',{base:done-1,revision:done})}</p>:<p>{t(failed||journal?.phase==='invalid'?'wordDraftIdentityUnavailable':'wordDraftRequestRetained')}</p>}
  {record&&<><p>{t('wordPageRequestCount',{count:journal!.pendingCount})}</p><code>{record.transactionId}</code><ul>{record.actions.map((item,index)=><li key={index}>{t(item.kind==='layout'?'wordTopologyLayout':item.kind==='story'?'wordTopologyStory':item.kind==='resume'?'wordTopologyConfirm':item.kind==='cancel'?'wordTopologyCancelUnprepared':'wordDraftRequestLegacy')}{item.kind==='layout'?` · r${item.body.revision}`:'baseRevision'in item?` · r${item.baseRevision}`:''}</li>)}</ul>
   {original?.kind==='layout'&&<ul>{original.body.edits.changes.slice(0,20).map((change,index)=><li key={index}>{t('wordSection',{count:original.sections.find(s=>s.id===change.sectionId)!.number})} · {t(wordPageFieldLabels[change.field])}：{format(change.field,change.expected)} → {format(change.field,change.value)}</li>)}</ul>}
   {original?.kind==='story'&&<p>{t('wordSection',{count:original.section})} · {t(original.body.kind==='header'?'headerRegion':'footerRegion')} · {t(original.body.variant==='first'?'wordFirstPageVariant':original.body.variant==='even'?'wordEvenPageVariant':'wordDefaultPages')}</p>}
  </>}
  {raw&&<button type="button" onClick={download}>{t('wordLayoutRequestDownload')}</button>}
  {action&&action.kind!=='legacy'&&<>{!confirm?<button type="button" disabled={blocked||journal?.busy} onClick={()=>setConfirm(raw!)}>{t(action.kind==='cancel'?'wordLayoutRequestRetryCancel':'wordLayoutRequestRetry')}</button>:<div><p>{t('wordLayoutRequestConfirm')}</p><button type="button" disabled={blocked||journal?.busy||confirm!==raw} onClick={()=>void retry()}>{t(action.kind==='cancel'?'wordLayoutRequestRetryCancel':'wordLayoutRequestRetry')}</button><button type="button" disabled={journal?.busy} onClick={()=>setConfirm(null)}>{t('cancel')}</button></div>}</>}
  {error&&<p role="alert">{t('wordLayoutRequestUnknown')}</p>}
 </section>
}
