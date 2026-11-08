import {createContext,useContext,useEffect,useId,useRef,useState,useSyncExternalStore,type ReactNode,type KeyboardEvent} from 'react'
import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {WordLinkTransaction,type WordLinkReview} from './wordLinkTransaction.ts'
import {useI18n} from './i18n.tsx'
const Context=createContext<WordLinkTransaction|null>(null)
const noop=(_listener:()=>void)=>()=>{},zero=()=>0
export function useWordLinkTransaction(){const value=useContext(Context);useSyncExternalStore(value?.subscribe??noop,value?.snapshot??zero);return value}
export function WordLinkTransactions({session,children,onRecovery}:{session:Session;children:ReactNode;onRecovery:()=>void}){
 const [transaction,setTransaction]=useState<WordLinkTransaction|null>(null),[problem,setProblem]=useState(false)
 const {t}=useI18n()
 useEffect(()=>{
  setTransaction(null);setProblem(false)
  if(session.collaborationProtocol!==wordLayoutProtocol||session.scope!=='write')return
  let live=true,owned:WordLinkTransaction|undefined
  void WordLinkTransaction.open(session,location.href).then(value=>{owned=value;if(!live){value.dispose();return}setTransaction(value)}).catch(()=>{if(live)setProblem(true)})
  const focus=()=>{if(owned)void owned.refresh().catch(()=>{if(live)setProblem(true)})};window.addEventListener('focus',focus)
  return()=>{live=false;window.removeEventListener('focus',focus);owned?.dispose()}
 },[session])
 const active=transaction?.session===session?transaction:null
 return <Context.Provider value={active}>{problem&&<p className="word-region-error" role="alert">{t('wordLinkRequestStorage')}</p>}{children}{active&&<WordLinkRequestPanel transaction={active} onRecovery={onRecovery}/>}</Context.Provider>
}
function trap(event:KeyboardEvent<HTMLDivElement>){
 event.stopPropagation();if(event.key==='Escape'){event.preventDefault();return}if(event.key!=='Tab')return
 const nodes=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')];if(!nodes.length)return
 const index=nodes.indexOf(document.activeElement as HTMLElement)
 if(event.shiftKey&&index<=0){event.preventDefault();nodes.at(-1)!.focus()}else if(!event.shiftKey&&index===nodes.length-1){event.preventDefault();nodes[0].focus()}
}
function ReviewSummary({review}:{review:WordLinkReview}){
 const {t}=useI18n(),{summary,selection}=review,[expanded,setExpanded]=useState(false),[page,setPage]=useState(0),pages=Math.max(1,Math.ceil(summary.affectedSections/20)),current=Math.min(page,pages-1)
 return <>
  <p>{t('wordSection',{count:summary.section})} · {t(selection.kind==='header'?'headerRegion':'footerRegion')} · {t(selection.variant==='first'?'wordFirstPageVariant':selection.variant==='even'?'wordEvenPageVariant':'wordDefaultPages')}</p>
  <p>{t(summary.inheritedSection===null?'wordTopologyLinkNoSource':'wordTopologyLinkSource',summary.inheritedSection===null?undefined:{section:summary.inheritedSection})}</p>
  <p>{t(summary.contentChanges?'wordTopologyLinkContentChanges':'wordTopologyLinkContentSame')}</p><p>{t('wordLinkVisibleChanges',{count:summary.affectedSections})}</p>
  {summary.affectedSections>0&&<>
   <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{t('wordLinkAffectedDetails')}</button>
   {expanded&&<>
    <ul className="word-page-setup-changes">{summary.affectedSectionNumbers.slice(current*20,current*20+20).map(number=><li key={number}>{t('wordSection',{count:number})}</li>)}</ul>
    {pages>1&&<nav><button disabled={current===0} onClick={()=>setPage(current-1)}>{t('fixedRecoveryPrevious')}</button> {current+1} / {pages} <button disabled={current+1===pages} onClick={()=>setPage(current+1)}>{t('fixedRecoveryNext')}</button></nav>}
   </>}
  </>}
  <p>{t('wordTopologyLinkRetained')}</p><p>{t('wordPageRequestBase',{revision:review.revision,count:1})}</p>
 </>
}
function WordLinkRequestPanel({transaction,onRecovery}:{transaction:WordLinkTransaction;onRecovery:()=>void}){
 const {t}=useI18n(),title=useId(),root=useRef<HTMLDivElement|null>(null),[hidden,setHidden]=useState(false);useSyncExternalStore(transaction.subscribe,transaction.snapshot)
 const visible=transaction.phase!=='idle',done=transaction.phase==='installed'||transaction.phase==='cancelled',record=transaction.record
 useEffect(()=>{if(visible&&!hidden&&!root.current?.contains(document.activeElement))root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()},[visible,hidden,transaction.busy])
 useEffect(()=>{if(!visible)setHidden(false)},[visible])
 if(!visible)return null
 if(hidden)return <div className="word-page-request-banner" role="status"><span>{t('wordPageRequestKeep')}</span><button onClick={()=>setHidden(false)}>{t('wordLinkRequestView')}</button></div>
 const invoke=(work:()=>Promise<void>)=>void work().catch(()=>{})
 const download=()=>{const raw=transaction.backup;if(raw===null)return;const url=URL.createObjectURL(new Blob([raw],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='word-link.hcd-word-link-request';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 return <div className="hcd-dialog-backdrop"><div ref={root} className="hcd-dialog word-link-transaction" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={trap}><h2 id={title}>{t('wordLinkRequestTitle')}</h2><p role={transaction.error?'alert':'status'}>{t(transaction.busy?'wordLinkRequestWorking':transaction.phase==='installed'?'wordLinkRequestInstalled':transaction.phase==='cancelled'?'wordPageRequestCancelled':record?.operation==='cancel'?'wordPageRequestCancelPending':'wordPageRequestPending',transaction.revision===undefined?undefined:{revision:transaction.revision})}</p>{record&&<ReviewSummary review={record.review}/>}{transaction.error&&<p role="alert">{t(transaction.error==='word-story-source-draft-pending'?'wordStoppedStorySourceDraft':transaction.error==='word-link-review-changed'?'wordStoppedStoryStale':'wordPageRequestKeep')} <code>{transaction.error}</code></p>}<div className="hcd-dialog-actions"><button disabled={transaction.backup===null} onClick={download}>{t('wordLinkRequestDownload')}</button>{!done&&<><button disabled={transaction.busy} onClick={()=>{setHidden(true);onRecovery()}}>{t('wordCheckpointTitle')}</button>{record&&<><button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.check())}>{t('wordPageRequestCheck')}</button><button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.retry())}>{t(record.operation==='cancel'?'wordPageRequestRetryCancel':'wordPageRequestRetry')}</button>{record.operation==='apply'&&<button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.cancel())}>{t('wordTopologyCancelUnprepared')}</button>}</>}</>}{done&&<button disabled={transaction.busy} onClick={()=>invoke(()=>transaction.finish())}>{t('close')}</button>}</div></div></div>
}
export function WordLinkReviewDialog({review,busy,error,onCancel,onConfirm}:{review:WordLinkReview;busy:boolean;error:string;onCancel:()=>void;onConfirm:()=>void}){
 const {t}=useI18n(),title=useId(),cancel=useRef<HTMLButtonElement|null>(null)
 useEffect(()=>{cancel.current?.focus()},[])
 return <div className="hcd-dialog-backdrop" onMouseDown={event=>{if(!busy&&event.target===event.currentTarget)onCancel()}}><div className="hcd-dialog word-link-review" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();onCancel()}else trap(event)}}><h2 id={title}>{t('wordTopologyLink')}</h2><ReviewSummary review={review}/><p>{t('wordLinkConfirm')}</p><p>{t('wordLinkRequestHistory')}</p>{error&&<p role="alert">{t(error==='word-link-review-changed'?'wordStoppedStoryStale':'wordLinkRequestStorage')} <code>{error}</code></p>}<div className="hcd-dialog-actions"><button ref={cancel} disabled={busy} onClick={onCancel}>{t('cancel')}</button><button disabled={busy||!!error} onClick={onConfirm}>{t('wordTopologyLink')}</button></div></div></div>
}
