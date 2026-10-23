import {useEffect,useRef,useState,type ReactNode} from 'react'
import {api,type Session} from './api.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {FixedSaveController,type FixedDraftState} from './fixedSaveController.ts'
import {FixedDraftJournal,fixedDraftDatabase,serializeFixedDraft,type FixedDraftCopy} from './fixedDraftJournal.ts'
import {ImageCandidatePreview} from './ImagePanel.tsx'
import {useI18n} from './i18n.tsx'

export type FixedBinding={sourceHash:string;session:Session;texts:TextDraftStore;images:ImageDraftStore;controller:FixedSaveController;journal:FixedDraftJournal|null;copies:FixedDraftCopy[];unavailable:boolean}
export function downloadFixedDraft(session:Session,state:FixedDraftState,sourceHash:string){
  const url=URL.createObjectURL(new Blob([serializeFixedDraft(session,state,sourceHash)],{type:'application/json'}))
  const link=document.createElement('a');link.href=url;link.download=`${session.documentId}.hcd-draft`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000)
}
type Review={sourceHash:string;copies:FixedDraftCopy[];selected:FixedDraftCopy;server:string;select:(id:string)=>Promise<void>;restore:()=>Promise<void>;serverOnly:()=>Promise<void>}
const empty=():FixedDraftState=>({version:3,texts:[],images:[],attempt:null})

/** Load before any page loader or revision subscription can reconcile drafts.
 * Recovery always forks a new branch; other windows' records are never replaced. */
export function FixedDraftBootstrap({session,children}:{session:Session;children:(binding:FixedBinding)=>ReactNode}){
  const {t,locale}=useI18n(),generation=useRef(0)
  const [binding,setBinding]=useState<FixedBinding|null>(null),[review,setReview]=useState<Review|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0)
  const [without,setWithout]=useState<(()=>Promise<void>)|null>(null)
  const [canRestore,setCanRestore]=useState(false)
  useEffect(()=>{
    const abort=new AbortController()
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)])
    const current=++generation.current,journals=new Set<FixedDraftJournal>(),controllers=new Set<FixedSaveController>()
    const alive=()=>generation.current===current
    const open=async(name:string)=>{
      const journal=await FixedDraftJournal.open(name)
      if(!alive()){journal.close();throw new Error('Canceled')}
      journals.add(journal);return journal
    }
    setBinding(null);setReview(null);setError('');setWithout(null);setCanRestore(false)
    const start=async()=>{
      const [authResponse,manifestResponse]=await Promise.all([api(session,'/auth',{signal}),api(session,'',{signal})])
      const access=await authResponse.json() as {userId?:string;scope:string},manifest=await manifestResponse.json() as {source:{sha256:string};revision:number}
      if(!alive())return
      const effective:Session={...session,scope:access.scope==='write'?'write':'read',userId:access.userId}
      setCanRestore(effective.scope==='write')
      const launch=async(state:FixedDraftState,journal:FixedDraftJournal|null,copies:FixedDraftCopy[],unavailable=false)=>{
        if(!alive())return
        const texts=new TextDraftStore(),images=new ImageDraftStore()
        texts.restore(state.texts);images.restore(state.images)
        const controller=new FixedSaveController(effective,texts,images,journal,state.attempt);controllers.add(controller)
        await controller.connect()
        if(alive())setBinding({sourceHash:manifest.source.sha256,session:effective,texts,images,controller,journal,copies,unavailable})
      }
      setWithout(()=>()=>launch(empty(),null,[],true))
      if(!access.userId)throw new Error('Stable authenticated identity required for device backup')
      const name=await fixedDraftDatabase(session,access.userId,manifest.source.sha256,window.location.href)
      const journal=await open(name)
      const copies=await journal.copies(),pending=copies.filter(copy=>!copy.retained)
      if(!alive())return
      if(!pending.length){await launch(empty(),effective.scope==='write'?journal:null,copies);return}
      let selected=pending[0],server=''
      const preview=async()=>{
        const results=await Promise.allSettled(selected.state.texts.slice(0,12).map(async([id])=>{
          const node=await(await api(session,`/text/${encodeURIComponent(id)}?revision=${manifest.revision}`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)])})).json() as {text:string}
          return node.text
        }))
        server=results.map(result=>result.status==='fulfilled'?result.value:t('localDraftWaitingNetwork')).join('\n')
      }
      const display=()=>{
        if(!alive())return
        setReview({sourceHash:manifest.source.sha256,copies:pending,selected,server,
          select:async(id)=>{const copy=pending.find(value=>value.id===id);if(copy){selected=copy;await preview();display()}},
          restore:async()=>{
            if(effective.scope!=='write')return
            // Another live window may still own the reviewed branch. Refresh
            // the comparison if it changed; never silently restore new bytes.
            const latest=(await journal.copies()).find(copy=>copy.id===selected.id)
            if(!latest)throw new Error('Device copy changed')
            if(JSON.stringify(latest.state)!==JSON.stringify(selected.state)){selected=latest;await preview();display();throw new Error('Device copy changed')}
            const target=await open(name)
            await launch(latest.state,target,copies)
            await journal.retain(latest.id)
          },
          serverOnly:async()=>{
            const target=effective.scope==='write'?await open(name):null
            await launch(empty(),target,copies)
            if(target)for(const copy of pending)await journal.retain(copy.id)
          },
        })
      }
      await preview();display()
    }
    void start().catch(()=>{if(alive())setError('localDraftUnavailable')})
    return()=>{generation.current++;abort.abort();controllers.forEach(controller=>controller.dispose());journals.forEach(journal=>journal.close())}
  },[session.documentId,session.apiUrl,session.collabUrl,session.token,session.scope,retry])
  if(binding)return children(binding)
  const act=(work:()=>Promise<void>)=>{setBusy(true);setError('');void work().catch(()=>setError('localDraftRestoreFailed')).finally(()=>setBusy(false))}
  const assets=[...new Set(review?.selected.state.images.map(([,draft])=>draft.assetHash).filter((hash):hash is string=>!!hash))].slice(0,12)
  return <section className="local-draft-start" aria-label={t('localDraftRecovery')}>
    <h2>{t(review?'localDraftFound':'localDraftLoading')}</h2>
    {review&&<><p>{t('fixedDraftReviewHint')}</p><label>{t('localDraftCopies')}<select aria-label={t('localDraftCopies')} value={review.selected.id} disabled={busy} onChange={event=>act(()=>review.select(event.target.value))}>{review.copies.map(copy=><option key={copy.id} value={copy.id}>{new Date(copy.updatedAt).toLocaleString(locale)}</option>)}</select></label>
      <div className="local-draft-compare"><section><h3>{t('localDraftDevice')}</h3><p>{review.selected.state.texts.map(([,draft])=>draft.text).join('\n').slice(0,6000)}</p>{!!review.selected.state.images.length&&<p>{t('unsavedImageCount',{count:review.selected.state.images.length})}</p>}{review.selected.state.images.some(([,draft])=>draft.restoreSource)&&<p>{t('imageSourceRestorePending')}</p>}{review.selected.state.attempt&&<p>{t('fixedSaveUnknown')}</p>}{review.selected.state.uploadInterrupted&&<p>{t('fixedUploadInterrupted')}</p>}{assets.map(hash=><ImageCandidatePreview key={hash} session={session} assetHash={hash}/>)}</section><section><h3>{t('localDraftServer')}</h3><p>{review.server.slice(0,6000)}</p></section></div>
      <button disabled={busy||!canRestore} onClick={()=>act(review.restore)}>{t('localDraftRestore')}</button><button disabled={busy} onClick={()=>act(review.serverOnly)}>{t('localDraftKeepAndOpen')}</button><button disabled={busy} onClick={()=>downloadFixedDraft(session,review.selected.state,review.sourceHash)}>{t('downloadDraft')}</button>
    </>}
    {error&&<p role="alert">{t(error as 'localDraftUnavailable'|'localDraftRestoreFailed')}</p>}
    <button disabled={busy} onClick={()=>setRetry(value=>value+1)}>{t('localDraftRetry')}</button>
    {error&&!review&&without&&<button disabled={busy} onClick={()=>act(without)}>{t('localDraftContinueWithout')}</button>}
  </section>
}
