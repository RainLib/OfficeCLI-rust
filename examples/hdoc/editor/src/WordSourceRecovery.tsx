import {useEffect,useRef,useState} from 'react'
import {api,ApiError,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {useI18n,type MessageKey} from './i18n.tsx'

type Status='present'|'missing'|'invalid'|'unavailable'|'unknown'
async function readReceipt(response:Response,signal:AbortSignal):Promise<any>{
 const bytes=await readBoundedResponse(response,64*1024,signal,'word-source-response-limit')
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
}

/** Restore only the source whose identity is bound to this HCD document. */
export function WordSourceRecovery({session,canWrite,sourceRequired=false,revision=null}:{session:Session;canWrite:boolean;sourceRequired?:boolean;revision?:number|null}){
 const {t}=useI18n(),[status,setStatus]=useState<Status>('unknown'),[proof,setProof]=useState(false),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[message,setMessage]=useState<MessageKey|null>(null)
 const input=useRef<HTMLInputElement>(null),lifetime=useRef<AbortController|null>(null),checkEpoch=useRef(0),channel=useRef<BroadcastChannel|null>(null),recheck=useRef<(()=>void)|null>(null),refreshSource=useRef<(()=>void)|null>(null),upload=useRef<AbortController|null>(null)
 useEffect(()=>{
  if(session.format!=='docx')return
  const controller=new AbortController();lifetime.current=controller;setStatus('unknown');setProof(false);setMessage(null);setBusy(false);setChecking(false)
  let running=false,again=false,manual=false
  const check=(explicit=false)=>{
   manual||=explicit
   if(running){again=true;checkEpoch.current++;return}
   running=true;setChecking(true);setProof(false)
   const epoch=++checkEpoch.current,signal=AbortSignal.any([controller.signal,AbortSignal.timeout(60_000)])
   void (async()=>{try{const response=await awaitRecoveryResponse(()=>api(session,'/word/source',{signal}),signal),value=await readReceipt(response,signal);if(!['present','missing','invalid','unavailable'].includes(value?.status))throw Error('invalid source status');if(!controller.signal.aborted&&checkEpoch.current===epoch){setStatus(value.status);setProof(value.status==='missing'&&value.sourceFreeProtected===true);if(manual){setMessage(value.status==='missing'?'wordSourceStillMissing':null);if(value.status==='present')try{updates?.postMessage({documentId:session.documentId,apiUrl:session.apiUrl??'/v1/documents'})}catch{/* Other windows recheck on focus. */}manual=false}}}catch{if(!controller.signal.aborted&&checkEpoch.current===epoch){setStatus('unavailable');manual=false}}finally{running=false;if(again&&!controller.signal.aborted){again=false;check()}else if(!controller.signal.aborted)setChecking(false)}})()
  }
  let updates:BroadcastChannel|null=null
  try{updates=new BroadcastChannel('hcd-word-source/1');channel.current=updates;updates.onmessage=event=>{if(event.data?.documentId===session.documentId&&event.data?.apiUrl===(session.apiUrl??'/v1/documents'))check()}}catch{/* Focus still refreshes the source state. */}
  const refresh=()=>{if(document.visibilityState==='visible')check()}
  recheck.current=()=>check(true);refreshSource.current=()=>check();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);check()
  return()=>{controller.abort();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);updates?.close();if(channel.current===updates)channel.current=null;if(lifetime.current===controller){lifetime.current=null;recheck.current=null;refreshSource.current=null}}
 },[session])
 useEffect(()=>{if(sourceRequired||revision!==null)refreshSource.current?.()},[sourceRequired,revision])
 if(session.format!=='docx'||status==='present'||status==='unknown')return null
 const restore=async(file:File)=>{
  if(busy||upload.current||!canWrite||!lifetime.current)return
  const controller=lifetime.current
  const operation=new AbortController();upload.current=operation
  setBusy(true);setMessage(null)
  const signal=AbortSignal.any([controller.signal,operation.signal,AbortSignal.timeout(300_000)])
  try{
   if(!file.size||file.size>256*1024*1024)throw Error('invalid source size')
   const response=await awaitRecoveryResponse(()=>api(session,'/word/source',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal}),signal)
   const receipt=await readReceipt(response,signal)
   if(receipt?.sourceRestored!==true||!Number.isSafeInteger(receipt?.revision)||receipt.revision<0||typeof receipt.alreadyPresent!=='boolean')throw Error('invalid source receipt')
   signal.throwIfAborted();checkEpoch.current++;setStatus('present')
   try{channel.current?.postMessage({documentId:session.documentId,apiUrl:session.apiUrl??'/v1/documents'})}catch{/* Other windows recheck on focus. */}
  }catch(error){if(!controller.signal.aborted)setMessage(error instanceof ApiError&&error.code==='DOCX_SOURCE_CHANGED'?'wordSourceWrongFile':error instanceof ApiError&&error.code==='DOCX_SOURCE_CONFLICT'?'wordSourceConflict':'wordSourceRestoreFailed')}
  finally{if(upload.current===operation){upload.current=null;if(!controller.signal.aborted)setBusy(false)}}
 }
 return <aside className="hcd-word-source-warning" role="status"><span>{t(status==='missing'?(proof?'wordSourceProofAvailable':'wordSourceMissing'):status==='invalid'?'wordSourceInvalid':'wordSourceUnavailable')}</span>{canWrite&&status==='missing'&&<><button type="button" disabled={busy} onClick={()=>input.current?.click()}>{t(busy?'wordSourceRestoring':'wordSourceRestore')}</button><input ref={input} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void restore(file)}}/></>}{busy&&<button type="button" onClick={()=>upload.current?.abort(new Error('source-restore-wait-stopped'))}>{t('exportStopWaiting')}</button>}<button type="button" disabled={busy||checking} onClick={()=>recheck.current?.()}>{t(checking?'wordSourceChecking':'wordSourceCheck')}</button>{message&&<span role="alert">{t(message)}</span>}</aside>
}
