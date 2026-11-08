import {wordPageValue} from './wordPageValues.ts'
import {createContext,useContext,useEffect,useId,useRef,useState,useSyncExternalStore,type ReactNode,type KeyboardEvent} from 'react'
import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {WordPageTransaction} from './wordPageTransaction.ts'
import {wordPageFieldLabels} from './WordPageSetup.tsx'
import {useI18n} from './i18n.tsx'
const Context=createContext<WordPageTransaction|null>(null)
const noop=(_listener:()=>void)=>()=>{},zero=()=>0
export function useWordPageTransaction(){const value=useContext(Context);useSyncExternalStore(value?.subscribe??noop,value?.snapshot??zero);return value}
export function WordPageTransactions({session,children,onRecovery,onFinished}:{session:Session;children:ReactNode;onRecovery:()=>void;onFinished:()=>void}){
 const [transaction,setTransaction]=useState<WordPageTransaction|null>(null),[problem,setProblem]=useState(false)
 const {t,locale}=useI18n()
 useEffect(()=>{
  setTransaction(null);setProblem(false)
  if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write'||!session.userId||!session.displayName)return
  let live=true,owned:WordPageTransaction|undefined
  void Promise.resolve().then(()=>WordPageTransaction.open(session,location.href,{legacy:window.sessionStorage})).then(value=>{owned=value;if(!live){value.dispose();return}setTransaction(value)}).catch(()=>{if(live)setProblem(true)})
  const focus=()=>{if(owned)void owned.refresh().catch(()=>{if(live)setProblem(true)})};window.addEventListener('focus',focus)
  return()=>{live=false;window.removeEventListener('focus',focus);owned?.dispose()}
 },[session])
 const active=transaction?.session===session?transaction:null
 return <Context.Provider value={active}>{problem&&<p className="word-region-error" role="alert">{t('wordPageDeviceUnavailable')}</p>}{children}{active&&<WordPageTransactionPanel transaction={active} onRecovery={onRecovery} onFinished={onFinished}/>}</Context.Provider>
}
function WordPageTransactionPanel({transaction,onRecovery,onFinished}:{transaction:WordPageTransaction;onRecovery:()=>void;onFinished:()=>void}){
 const {t,locale}=useI18n(),title=useId(),root=useRef<HTMLDivElement|null>(null),[page,setPage]=useState(0),[error,setError]=useState(''),[hidden,setHidden]=useState(false);useSyncExternalStore(transaction.subscribe,transaction.snapshot)
 const record=transaction.record,visible=transaction.phase!=='idle',done=transaction.phase==='installed'||transaction.phase==='cancelled',changes=record?.request.edits.changes??[],pages=Math.max(1,Math.ceil(changes.length/20)),current=Math.min(page,pages-1)
 useEffect(()=>{if(visible&&!hidden&&!root.current?.contains(document.activeElement))root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()},[visible,transaction.busy,hidden])
 useEffect(()=>{if(!visible)setHidden(false)},[visible])
 if(!visible)return null
 if(hidden)return <div className="word-page-request-banner" role="status"><span>{t('wordPageRequestKeep')}</span><button onClick={()=>setHidden(false)}>{t('wordPageRequestView')}</button></div>
 const invoke=(work:()=>Promise<void>)=>{setError('');void work().catch(()=>{})}
 const finish=()=>{setError('');void transaction.finish().then(()=>{if(transaction.phase==='idle')onFinished()}).catch(()=>setError('word-page-storage'))}
 const download=()=>{const raw=transaction.backup;if(raw===null)return;const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='word-page.hcd-word-page-request';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 const format=(field:string,value:string|number|boolean|null)=>wordPageValue(field,value,t,locale)
 const keyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
  event.stopPropagation();if(event.key==='Escape'){event.preventDefault();return}
  if(event.key!=='Tab')return
  const nodes=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')]
  if(!nodes.length)return
  const index=nodes.indexOf(document.activeElement as HTMLElement)
  if(event.shiftKey&&index<=0){event.preventDefault();nodes[nodes.length-1].focus()}else if(!event.shiftKey&&index===nodes.length-1){event.preventDefault();nodes[0].focus()}
 }
 return <div className="hcd-dialog-backdrop"><div ref={root} className="hcd-dialog word-page-transaction" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={keyDown}><h2 id={title}>{t('wordPageRequestTitle')}</h2>
 <p role={transaction.error||error?'alert':'status'}>{t(transaction.busy?'wordPageRequestWorking':transaction.phase==='installed'?'wordPageRequestInstalled':transaction.phase==='cancelled'?'wordPageRequestCancelled':record?.operation==='cancel'?'wordPageRequestCancelPending':'wordPageRequestPending',transaction.revision===undefined?undefined:{revision:transaction.revision})}</p>
 <p>{t('wordPageRequestCount',{count:transaction.pendingCount})}</p>
 {record&&<><p>{t('wordPageRequestBase',{revision:record.request.expectedRevision,count:changes.length})}</p><ul className="word-page-setup-changes">{changes.slice(current*20,current*20+20).map((change,i)=><li key={`${change.sectionId}:${change.field}:${i}`}><strong>{t('wordSection',{count:record.sections.find(s=>s.id===change.sectionId)?.number??1})} · {t(wordPageFieldLabels[change.field])}</strong><span>{format(change.field,change.expected)} → {format(change.field,change.value)}</span></li>)}</ul>{pages>1&&<nav><button disabled={transaction.busy||current===0} onClick={()=>setPage(current-1)}>{t('fixedRecoveryPrevious')}</button> {current+1} / {pages} <button disabled={transaction.busy||current+1===pages} onClick={()=>setPage(current+1)}>{t('fixedRecoveryNext')}</button></nav>}</>}
 {(transaction.error||error)&&<p role="alert">{t('wordPageRequestKeep')} <code>{error||transaction.error}</code></p>}
 <div className="hcd-dialog-actions"><button disabled={transaction.backup===null} onClick={download}>{t('wordPageRequestDownload')}</button>{!done&&<><button disabled={transaction.busy} onClick={()=>{setHidden(true);onRecovery()}}>{t('wordCheckpointTitle')}</button>{record&&<><button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.check())}>{t('wordPageRequestCheck')}</button><button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.retry())}>{t(record.operation==='cancel'?'wordPageRequestRetryCancel':'wordPageRequestRetry')}</button>{record.operation==='apply'&&<button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.cancel())}>{t('wordTopologyCancelUnprepared')}</button>}</>}</>}{done&&<button disabled={transaction.busy} onClick={finish}>{t('close')}</button>}</div>
 </div></div>
}
