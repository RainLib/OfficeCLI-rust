import {legacyProtocol} from './collaborationProtocol.ts'
import {useEffect,useRef,useState,type ReactNode} from 'react'
import * as Y from 'yjs'
import type {Session} from './api.ts'
import {DraftBootstrapError,draftBootstrapProblem,draftStorage,readServerDraft,requireDraftAuthority,restoreDraftCandidate} from './draftBootstrap.ts'
import {ImageCandidatePreview} from './ImagePanel.tsx'
import {imageIntents} from './collaborativeImages.ts'
import {useI18n} from './i18n.tsx'
import {DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,type DocumentProblem} from './documentProblems.ts'
import {LocalDraftJournal,draftIdentity,listDraftIdentities,forkDraftIdentity,cacheAddsChanges,localDraftPreview,localDocumentProtocol,localDraftHasContent,createDraftDocument,localDraftBackup,type DraftIdentity} from './localDrafts.ts'

export type LocalDraftCopy={identity:DraftIdentity;updatedAt:number;archived:boolean}
export type LocalDraftBinding={document:Y.Doc;journal:LocalDraftJournal|null;copies:LocalDraftCopy[];unavailable:boolean;claim:()=>void}
export function downloadLocalDraft(session:Session,document:Y.Doc,epoch:number){
 const backup=localDraftBackup(session.documentId,document,epoch)
 const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'})),anchor=window.document.createElement('a')
 anchor.href=url;anchor.download=`${session.documentId}-device-e${epoch}.hcd-draft`;window.document.body.append(anchor);anchor.click();anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60000)
}
export async function downloadLocalCopy(session:Session,copy:LocalDraftCopy){
 const journal=await LocalDraftJournal.open(copy.identity)
 let document:Y.Doc|undefined
 try{document=await journal.load();downloadLocalDraft(session,document,copy.identity.epoch)}finally{document?.destroy();journal.close()}
}
type Review={copies:LocalDraftCopy[];selected:LocalDraftCopy;local:string;localAssets:string[];imageCount:number;server:string;available:boolean;select:(copy:LocalDraftCopy)=>Promise<void>;restore:()=>Promise<void>;serverOnly:()=>Promise<void>;download:()=>void}
/** No collaboration provider exists until disk loading/recovery selection is
 * complete. Old epochs remain downloadable and never join a new room. */
export function LocalDraftBootstrap({session,userId,children,onEpochChange,onClose}:{session:Session;userId:string;onClose?:()=>void;onEpochChange?:(epoch:number)=>void;children:(binding:LocalDraftBinding)=>ReactNode}){
 const {t,locale}=useI18n(),generation=useRef(0)
 const [binding,setBinding]=useState<LocalDraftBinding|null>(null),[review,setReview]=useState<Review|null>(null),[error,setError]=useState<DocumentProblem|null>(null),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0)
 const [continueWithout,setContinueWithout]=useState<(()=>Promise<void>)|null>(null)
 useEffect(()=>{
  const controller=new AbortController(),current=++generation.current,journals=new Set<LocalDraftJournal>(),documents=new Set<Y.Doc>(),claimed=new Set<Y.Doc>()
  setBinding(null);setReview(null);setError(null);setContinueWithout(null);setBusy(false)
  const alive=()=>generation.current===current
  const own=(doc:Y.Doc)=>{if(!alive()){doc.destroy();throw new DOMException('Canceled','AbortError')}documents.add(doc);return doc}
  const open=async(identity:DraftIdentity)=>{const journal=await draftStorage(()=>LocalDraftJournal.open(identity));if(!alive()){journal.close();throw new Error('Canceled')}journals.add(journal);return journal}
  const server=async()=>{const doc=await readServerDraft(session,AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)]));return doc?own(doc):null}
  const failed=(cause:unknown)=>{
   if(!alive())return
   const problem=draftBootstrapProblem(cause)
   setError(classifyDocumentProblem(cause,'recovery'));setContinueWithout(null)
   if(cause instanceof DraftBootstrapError&&cause.authority&&onEpochChange){onEpochChange(cause.authority.collaborationEpoch);return}
   if(problem==='localDraftUnavailable')setContinueWithout(()=>async()=>{
    await requireDraftAuthority(session,AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)]))
    const doc=await server()??own(createDraftDocument(session))
    if(alive())setBinding({document:doc,journal:null,copies:[],unavailable:true,claim:()=>{claimed.add(doc)}})
   })
  }
  const start=async()=>{
   const identity=await draftStorage(()=>draftIdentity(session,userId,window.location.href))
   const identities=await draftStorage(()=>listDraftIdentities(identity)),copies:LocalDraftCopy[]=[]
   for(const item of identities){const journal=await open(item),meta=await draftStorage(()=>journal.metadata());if(meta.updatedAt)copies.push({identity:item,...meta})}
   copies.sort((a,b)=>b.updatedAt-a.updatedAt||a.identity.name.localeCompare(b.identity.name))
   let canonical:Y.Doc|null=null,serverFailure:unknown
   try{canonical=await server()}catch(error){if(error instanceof DraftBootstrapError&&error.authority)throw error;serverFailure=error}
   const candidates:Array<{copy:LocalDraftCopy;doc:Y.Doc;journal:LocalDraftJournal}>=[]
   for(const copy of copies.filter(item=>item.identity.epoch===identity.epoch && (item.identity.protocol??legacyProtocol)===(session.collaborationProtocol??legacyProtocol) && !item.archived)){
    const journal=await open(copy.identity),doc=own(await draftStorage(()=>journal.load()))
    if(!localDraftHasContent(doc))continue
    if(localDocumentProtocol(doc)!==(session.collaborationProtocol??legacyProtocol))continue
    if(canonical && !cacheAddsChanges(doc,canonical)){if(session.scope==='write')await draftStorage(()=>journal.archive());continue}
    candidates.push({copy,doc,journal})
   }
   const launch=async(doc:Y.Doc,journal:LocalDraftJournal|null,unavailable=false)=>{
    if(!alive())return
    if(journal)await draftStorage(()=>journal.bind(doc))
    if(alive())setBinding({document:doc,journal,copies,unavailable,claim:()=>{claimed.add(doc)}})
   }
   const fresh=async(archive:boolean)=>{
    await requireDraftAuthority(session,AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)]))
    const doc=await server()??own(createDraftDocument(session))
    const target=identities.some(item=>item.name===identity.name)?forkDraftIdentity(identity):identity
    const journal=session.scope==='write'?await open(target):null
    await launch(doc,journal)
    if(archive && journal && alive())for(const candidate of candidates)await draftStorage(()=>candidate.journal.archive())
   }
   if(!candidates.length){if(serverFailure)throw serverFailure;await launch(canonical??own(createDraftDocument(session)),session.scope==='write'?await open(identities.length?forkDraftIdentity(identity):identity):null);return}
   let selected=candidates[0]
   const display=()=>{
    if(!alive())return
    const intents=imageIntents(selected.doc)
    setReview({copies:candidates.map(value=>value.copy),selected:selected.copy,local:localDraftPreview(selected.doc),localAssets:[...new Set(intents.map(value=>value.assetHash).filter((value):value is string=>!!value))].slice(0,20),imageCount:new Set(intents.map(value=>value.base.nodeId)).size,server:canonical?localDraftPreview(canonical):'',available:!!canonical,
     select:async(copy)=>{const candidate=candidates.find(value=>value.copy.identity.name===copy.identity.name);if(candidate){selected=candidate;display()}},
     restore:async()=>{
      if(session.scope!=='write')return
      const latest=await server();if(!latest)throw new DraftBootstrapError('localDraftServerUnavailable');const restored=own(restoreDraftCandidate(selected.doc,latest))
      await launch(restored,await open(selected.copy.identity))
     },
     serverOnly:()=>fresh(true),download:()=>downloadLocalDraft(session,selected.doc,selected.copy.identity.epoch)})
   }
   display();if(serverFailure)setError(classifyDocumentProblem(serverFailure,'recovery'))
  }
  void start().catch(failed)
  return()=>{controller.abort();generation.current++;for(const journal of journals)journal.close();for(const doc of documents)if(!claimed.has(doc))doc.destroy()}
 },[session.documentId,session.apiUrl,session.collabUrl,session.collaborationEpoch,session.collaborationProtocol,session.scope,session.token,userId,retry])
 if(binding)return children(binding)
 const act=(work:()=>Promise<void>)=>{const current=generation.current;setBusy(true);setError(null);void work().catch(cause=>{if(generation.current!==current)return;if(cause instanceof DraftBootstrapError&&cause.authority&&onEpochChange){onEpochChange(cause.authority.collaborationEpoch);return}setError(classifyDocumentProblem(cause,'recovery'))}).finally(()=>{if(generation.current===current)setBusy(false)})}
 if(!review)return error?<DocumentProblemView problem={error} documentId={session.documentId} onClose={onClose} busy={busy} onRetry={()=>setRetry(value=>value+1)} secondary={continueWithout?{label:t('localDraftContinueWithout'),run:()=>act(continueWithout)}:undefined}/>:<DocumentLoading documentId={session.documentId} onClose={onClose}/>
 return <section className="local-draft-start" aria-label={t('localDraftRecovery')}>
  <h2>{t(review?'localDraftFound':error?'localDraftOpeningFailed':'localDraftLoading')}</h2>
  {review && <><p>{t('localDraftReviewHint')}</p><label>{t('localDraftCopies')}<select aria-label={t('localDraftCopies')} disabled={busy} value={review.selected.identity.name} onChange={event=>{const copy=review.copies.find(value=>value.identity.name===event.target.value);if(copy)act(()=>review.select(copy))}}>{review.copies.map(copy=><option key={copy.identity.name} value={copy.identity.name}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t('localDraftCurrentCopy')}</option>)}</select></label>
   <div className="local-draft-compare"><section><h3>{t('localDraftDevice')}</h3><p>{review.local||t('emptyTextObject')}</p>{!!review.imageCount && <p>{t('unsavedImageCount',{count:review.imageCount})}</p>}{review.localAssets.map(assetHash=><ImageCandidatePreview key={assetHash} session={session} assetHash={assetHash} />)}</section><section><h3>{t('localDraftServer')}</h3><p>{review.available?review.server:t('localDraftWaitingNetwork')}</p></section></div>
   <button type="button" disabled={busy || !review.available || session.scope!=='write'} onClick={()=>act(review.restore)}>{t('localDraftRestore')}</button>
   <button type="button" disabled={busy} onClick={()=>act(review.serverOnly)}>{t('localDraftKeepAndOpen')}</button>
   <button type="button" disabled={busy} onClick={()=>review.download()}>{t('downloadDraft')}</button>
  </>}
  {error && <DocumentProblemView compact problem={error} busy={busy}/>}
  <button type="button" disabled={busy} onClick={()=>setRetry(value=>value+1)}>{t('localDraftRetry')}</button>
  {continueWithout && <button type="button" disabled={busy} onClick={()=>act(continueWithout)}>{t('localDraftContinueWithout')}</button>}
 </section>
}
