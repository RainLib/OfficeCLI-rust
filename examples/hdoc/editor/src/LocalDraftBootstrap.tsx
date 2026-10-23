import {useEffect,useRef,useState,type ReactNode} from 'react'
import * as Y from 'yjs'
import {api,type Session} from './api.ts'
import {ImageCandidatePreview} from './ImagePanel.tsx'
import {imageIntents} from './collaborativeImages.ts'
import {useI18n} from './i18n.tsx'
import {LocalDraftJournal,draftIdentity,listDraftIdentities,forkDraftIdentity,cacheAddsChanges,restoreLocalDraft,localDraftPreview,type DraftIdentity} from './localDrafts.ts'

export type LocalDraftCopy={identity:DraftIdentity;updatedAt:number;archived:boolean}
export type LocalDraftBinding={document:Y.Doc;journal:LocalDraftJournal|null;copies:LocalDraftCopy[];unavailable:boolean;claim:()=>void}
export function downloadLocalDraft(session:Session,document:Y.Doc,epoch:number){
 const bytes=Y.encodeStateAsUpdate(document),chunks:string[]=[]
 for(let offset=0;offset<bytes.length;offset+=8192)chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+8192)))
 const backup={schemaVersion:'hcd-recovery/1',documentId:session.documentId,collaborationEpoch:epoch,crdt:btoa(chunks.join(''))}
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
export function LocalDraftBootstrap({session,userId,children,onEpochChange}:{session:Session;userId:string;onEpochChange?:(epoch:number)=>void;children:(binding:LocalDraftBinding)=>ReactNode}){
 const {t,locale}=useI18n(),generation=useRef(0)
 const [binding,setBinding]=useState<LocalDraftBinding|null>(null),[review,setReview]=useState<Review|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0)
 const [continueWithout,setContinueWithout]=useState<(()=>void)|null>(null)
 useEffect(()=>{
  const current=++generation.current,journals=new Set<LocalDraftJournal>(),documents=new Set<Y.Doc>(),claimed=new Set<Y.Doc>()
  setBinding(null);setReview(null);setError('');setContinueWithout(null)
  const alive=()=>generation.current===current
  const own=(doc:Y.Doc)=>{if(!alive())doc.destroy();else documents.add(doc);return doc}
  const open=async(identity:DraftIdentity)=>{const journal=await LocalDraftJournal.open(identity);if(!alive()){journal.close();throw new Error('Canceled')}journals.add(journal);return journal}
  const server=async()=>{
   const response=await api(session,'/collaboration/state',{headers:{'X-HCD-Collaboration-Epoch':String(session.collaborationEpoch??0)}})
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>8*1024*1024)throw new Error('Server state exceeds limit')
   const doc=own(new Y.Doc());Y.applyUpdate(doc,bytes,'hcd-local-server');return doc
  }
  const start=async()=>{
   const identity=await draftIdentity(session,userId,window.location.href)
   const identities=await listDraftIdentities(identity),copies:LocalDraftCopy[]=[]
   for(const item of identities){const journal=await open(item),meta=await journal.metadata();if(meta.updatedAt)copies.push({identity:item,...meta})}
   copies.sort((a,b)=>b.updatedAt-a.updatedAt||a.identity.name.localeCompare(b.identity.name))
   let canonical:Y.Doc|null=null
   try{canonical=await server()}catch{/* A missing first-room binary is normal; drafts still need review. */}
   const candidates:Array<{copy:LocalDraftCopy;doc:Y.Doc;journal:LocalDraftJournal}>=[]
   for(const copy of copies.filter(item=>item.identity.epoch===identity.epoch && !item.archived)){
    const journal=await open(copy.identity),doc=own(await journal.load())
    if(!doc.getXmlFragment('default').length && !doc.getMap('hcdImageDrafts').size)continue
    if(canonical && !cacheAddsChanges(doc,canonical)){if(session.scope==='write')await journal.archive();continue}
    candidates.push({copy,doc,journal})
   }
   const launch=async(doc:Y.Doc,journal:LocalDraftJournal|null,unavailable=false)=>{
    if(!alive())return
    if(journal)await journal.bind(doc)
    if(alive())setBinding({document:doc,journal,copies,unavailable,claim:()=>{claimed.add(doc)}})
   }
   const fresh=async(archive:boolean)=>{
    const access=await(await api(session,'/auth')).json() as {collaborationEpoch:number}
    if(access.collaborationEpoch!==identity.epoch){if(onEpochChange && alive()){onEpochChange(access.collaborationEpoch);return}throw new Error('Collaboration generation changed')}
    let doc:Y.Doc
    try{doc=await server()}catch{doc=own(new Y.Doc())}
    const target=identities.some(item=>item.name===identity.name)?forkDraftIdentity(identity):identity
    const journal=session.scope==='write'?await open(target):null
    await launch(doc,journal)
    if(archive && journal)for(const candidate of candidates)await candidate.journal.archive()
   }
   if(!candidates.length){await launch(canonical??own(new Y.Doc()),session.scope==='write'?await open(identities.length?forkDraftIdentity(identity):identity):null);return}
   let selected=candidates[0]
   const display=()=>{
    if(!alive())return
    const intents=imageIntents(selected.doc)
    setReview({copies:candidates.map(value=>value.copy),selected:selected.copy,local:localDraftPreview(selected.doc),localAssets:[...new Set(intents.map(value=>value.assetHash).filter((value):value is string=>!!value))].slice(0,20),imageCount:new Set(intents.map(value=>value.base.nodeId)).size,server:canonical?localDraftPreview(canonical):'',available:!!canonical,
     select:async(copy)=>{const candidate=candidates.find(value=>value.copy.identity.name===copy.identity.name);if(candidate){selected=candidate;display()}},
     restore:async()=>{
      if(session.scope!=='write')return
      const latest=await server(),restored=own(restoreLocalDraft(selected.doc,latest))
      await launch(restored,await open(selected.copy.identity))
     },
     serverOnly:()=>fresh(true),download:()=>downloadLocalDraft(session,selected.doc,selected.copy.identity.epoch)})
   }
   display()
  }
  void start().catch(()=>{
   if(!alive())return
   setError('localDraftUnavailable')
   setContinueWithout(()=>()=>{const doc=own(new Y.Doc());if(alive())setBinding({document:doc,journal:null,copies:[],unavailable:true,claim:()=>{claimed.add(doc)}})})
  })
  return()=>{generation.current++;for(const journal of journals)journal.close();for(const doc of documents)if(!claimed.has(doc))doc.destroy()}
 },[session.documentId,session.apiUrl,session.collabUrl,session.collaborationEpoch,session.scope,session.token,userId,retry])
 if(binding)return children(binding)
 const act=(work:()=>Promise<void>)=>{setBusy(true);setError('');void work().catch(()=>setError('localDraftRestoreFailed')).finally(()=>setBusy(false))}
 return <section className="local-draft-start" aria-label={t('localDraftRecovery')}>
  <h2>{t(review?'localDraftFound':'localDraftLoading')}</h2>
  {review && <><p>{t('localDraftReviewHint')}</p><label>{t('localDraftCopies')}<select aria-label={t('localDraftCopies')} disabled={busy} value={review.selected.identity.name} onChange={event=>{const copy=review.copies.find(value=>value.identity.name===event.target.value);if(copy)act(()=>review.select(copy))}}>{review.copies.map(copy=><option key={copy.identity.name} value={copy.identity.name}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t('localDraftCurrentCopy')}</option>)}</select></label>
   <div className="local-draft-compare"><section><h3>{t('localDraftDevice')}</h3><p>{review.local||t('emptyTextObject')}</p>{!!review.imageCount && <p>{t('unsavedImageCount',{count:review.imageCount})}</p>}{review.localAssets.map(assetHash=><ImageCandidatePreview key={assetHash} session={session} assetHash={assetHash} />)}</section><section><h3>{t('localDraftServer')}</h3><p>{review.available?review.server:t('localDraftWaitingNetwork')}</p></section></div>
   <button type="button" disabled={busy || !review.available || session.scope!=='write'} onClick={()=>act(review.restore)}>{t('localDraftRestore')}</button>
   <button type="button" disabled={busy} onClick={()=>act(review.serverOnly)}>{t('localDraftKeepAndOpen')}</button>
   <button type="button" disabled={busy} onClick={()=>review.download()}>{t('downloadDraft')}</button>
  </>}
  {error && <p role="alert">{t(error as 'localDraftUnavailable'|'localDraftRestoreFailed')}</p>}
  <button type="button" disabled={busy} onClick={()=>setRetry(value=>value+1)}>{t('localDraftRetry')}</button>
  {continueWithout && <button type="button" onClick={continueWithout}>{t('localDraftContinueWithout')}</button>}
 </section>
}
