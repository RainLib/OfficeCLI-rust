import {useEffect,useState} from 'react'
import {HocuspocusProvider} from '@hocuspocus/provider'
import {api,type Session} from './api.ts'
import {nodeEditCollaborationUrl,legacyProtocol,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'
import {confirmProtocolReady,negotiateSession,ProtocolClientError,protocolDelay} from './protocolClient.ts'
import {retainDocument} from './documentLifetime.ts'
import {downloadLocalDraft,type LocalDraftBinding} from './LocalDraftBootstrap.tsx'
import {DocumentProblemView} from './DocumentProblem.tsx'
import {draftStorage} from './draftBootstrap.ts'
import {classifyDocumentProblem,type DocumentProblem} from './documentProblems.ts'
import {useI18n,type MessageKey} from './i18n.tsx'
/** No editor or upload can start in this handoff surface. Cached changes are
 * reviewed first, synced to the old room and durably retained before upgrade. */
export function ProtocolUpgrade({session,binding,onReady,onClose}:{session:Session;binding:LocalDraftBinding;onReady:(value:CollaborationSession)=>void;onClose?:()=>void}){
 const {t}=useI18n(),[problem,setProblem]=useState<MessageKey|null>(null),[retry,setRetry]=useState(0),[failure,setFailure]=useState<DocumentProblem|null>(null)
 useEffect(()=>{
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)]);let provider:HocuspocusProvider|undefined
  binding.claim();const release=retainDocument(binding.document)
  const start=async()=>{
   const access=await(await api(session,'/auth',{signal})).json(),current=requireCollaborationSession({...access,collaborationProtocol:access.collaborationProtocol??legacyProtocol})
   if(signal.aborted)return
   const effective={...session,collabUrl:session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL||'ws://127.0.0.1:8768'}
   if(current.collaborationEpoch!==(session.collaborationEpoch??0)||current.collaborationProtocol!==session.collaborationProtocol){await draftStorage(async()=>{await binding.journal?.flush()});if(!signal.aborted)onReady(current);return}
   if(current.collaborationProtocol!==legacyProtocol){await draftStorage(async()=>{await binding.journal?.flush()});const result=await negotiateSession(effective,signal);if(!signal.aborted)onReady(result);return}
   provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl||import.meta.env.VITE_HCD_COLLAB_URL||'ws://127.0.0.1:8768'),name:`${session.documentId}:${session.collaborationEpoch??0}:typography2:save4`,document:binding.document,token:session.token})
   const deadline=Date.now()+30_000;let nextAuthorityCheck=Date.now()+1000
   while(!signal.aborted&&(!provider.isSynced||provider.hasUnsyncedChanges)){
    if(Date.now()>deadline)throw new DOMException('Connection deadline','TimeoutError')
    if(Date.now()>=nextAuthorityCheck){
     nextAuthorityCheck=Date.now()+2000
     const latest=requireCollaborationSession(await(await api(session,'/auth',{signal})).json())
     if(latest.collaborationEpoch!==current.collaborationEpoch||latest.collaborationProtocol!==current.collaborationProtocol){await draftStorage(async()=>{await binding.journal?.flush()});if(!signal.aborted)onReady(latest);return}
    }
    await protocolDelay(100,signal)
   }
   if(signal.aborted)return
   await draftStorage(async()=>{await binding.journal?.flush()});await confirmProtocolReady(provider,signal)
   const until=Date.now()+30_000
   while(!signal.aborted){
    try{const result=await negotiateSession(effective,signal);if(!signal.aborted)onReady(result);return}
    catch(error){if(signal.aborted)return;if(error instanceof ProtocolClientError&&['protocolWaiting','protocolPending'].includes(error.key)&&Date.now()<until){setProblem(error.key);await protocolDelay(1500,signal);continue}throw error}
   }
  }
  setProblem(null);setFailure(null);void start().catch(error=>{if(!controller.signal.aborted){setProblem(error instanceof ProtocolClientError?error.key:'protocolUnavailable');setFailure(classifyDocumentProblem(signal.aborted?signal.reason:error,'collaboration'))}})
  return()=>{controller.abort();provider?.destroy();release()}
 },[session,binding,onReady,retry])
 return <section className="local-draft-start" aria-label={t('protocolPreparing')}><h2>{t('protocolPreparing')}</h2><p role={problem?'alert':'status'}>{t(problem??'protocolPreparingHint')}</p>{failure&&<DocumentProblemView problem={failure} compact onRetry={()=>setRetry(value=>value+1)}/>}<button onClick={()=>downloadLocalDraft(session,binding.document,session.collaborationEpoch??0)}>{t('downloadDraft')}</button>{onClose&&<button onClick={()=>{void (async()=>{try{await draftStorage(async()=>{await binding.journal?.flush()});onClose()}catch(error){setFailure(classifyDocumentProblem(error,'recovery'))}})()}}>{t('close')}</button>}</section>
}
