import {useEffect,useState,useSyncExternalStore} from 'react'
import type {Session} from './api.ts'
import {WordDraftAttempts} from './wordDraftAttempt.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {useI18n} from './i18n.tsx'
const noop=(_listener:()=>void)=>()=>{},zero=()=>0
export function useWordDraftRequests(session:Session|undefined){
 const [journal,setJournal]=useState<WordDraftAttempts|null>(null),[failed,setFailed]=useState(false)
 useEffect(()=>{
  setJournal(null);setFailed(false)
  if(!session||session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol)return
  let live=true,owned:WordDraftAttempts|undefined
  void Promise.resolve().then(()=>WordDraftAttempts.open(session,location.href,{legacy:window.sessionStorage})).then(value=>{owned=value;if(!live){value.dispose();return}setJournal(value)}).catch(()=>{if(live)setFailed(true)})
  const focus=()=>{if(owned)void owned.refresh().catch(()=>{if(live)setFailed(true)})};window.addEventListener('focus',focus)
  return()=>{live=false;window.removeEventListener('focus',focus);owned?.dispose()}
 },[session])
 const current=journal?.session===session?journal:null
 useSyncExternalStore(current?.subscribe??noop,current?.snapshot??zero,zero)
 return{journal:current,failed,ready:!!current&&!failed&&current.phase!=='invalid'}
}
export function WordDraftRequestPanel({journal,failed}:{journal:WordDraftAttempts|null;failed:boolean}){
 const {t}=useI18n(),record=journal?.record
 if(!failed&&!journal?.backup)return null
 const download=()=>{const raw=journal?.backup;if(raw==null)return;const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='word-stopped.hcd-word-draft-request';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 return <section className="word-checkpoint-recovery" aria-label={t('wordDraftRequestTitle')}><h3>{t('wordDraftRequestTitle')}</h3>
  <p>{t(failed||journal?.phase==='invalid'?'wordDraftIdentityUnavailable':'wordDraftRequestRetained')}</p>
  {record&&<><p>{t('wordPageRequestCount',{count:journal!.pendingCount})}</p><code>{record.checkpointId}</code><ul>{record.actions.map((action,index)=><li key={index}>{t(action.kind==='save'?'wordDraftSave':action.kind==='resume'?'wordCheckpointConfirm':action.kind==='rebase-stale'?'wordStaleStageConfirm':action.kind==='cancel'?'wordTopologyCancelUnprepared':'wordDraftRequestLegacy')}{'baseRevision' in action?` · r${action.baseRevision}`:''}</li>)}</ul></>}
  <button type="button" disabled={!journal?.backup} onClick={download}>{t('wordDraftRequestDownload')}</button>
 </section>
}
