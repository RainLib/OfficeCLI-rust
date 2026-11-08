import {wordRegionVersion} from './wordRegions.ts'
import {useEffect,useRef,useState,type ReactNode} from 'react'
import {api,type Session} from './api.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore,type PositionedImage} from './imageDrafts.ts'
import type {ImageGeometry} from './ImagePanel.tsx'
import {FixedSaveController,type FixedDraftState} from './fixedSaveController.ts'
import {FixedDraftJournal,fixedDraftDatabase,serializeFixedDraft,parseFixedDraftBackup,fixedDraftBackupLimit,type FixedDraftCopy} from './fixedDraftJournal.ts'
import {ImageCandidatePreview} from './ImagePanel.tsx'
import {useI18n} from './i18n.tsx'
import {draftStorage} from './draftBootstrap.ts'
import {DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,documentProblem,EditorDocumentError,type DocumentProblem} from './documentProblems.ts'
import {restoreWorkbookInput,workbookInputDiverged,workbookInputLocation,workbookCellAddress} from './workbookInputBuffer.ts'
import {resolveWorkbookBlankInput,resolveWorkbookBlankRecovery} from './workbookBlankRecovery.ts'
import {fixedRecoveryHead,fixedRecoveryPreview,fixedRecoveryIds,fixedRecoveryImageIds,fixedRecoveryCount,fixedRecoveryPageSize} from './fixedRecoveryPreview.ts'
import {FixedDraftDownload} from './FixedDraftDownload.tsx'
import {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'
import {withWorkbookStartupRecovery} from './workbookStartupRecoveryGate.ts'
import {pendingWorkbookRecovery} from './workbookRecoveryPending.ts'

export type FixedBinding={sourceHash:string;session:Session;texts:TextDraftStore;images:ImageDraftStore;controller:FixedSaveController;journal:FixedDraftJournal|null;copies:FixedDraftCopy[];unavailable:boolean;importBackup?:(file:File,reopen?:boolean)=>Promise<boolean>}
export function downloadFixedDraft(session:Session,state:FixedDraftState,sourceHash:string){
  const url=URL.createObjectURL(new Blob([serializeFixedDraft(session,state,sourceHash)],{type:'application/json'}))
  const link=document.createElement('a');link.href=url;link.download=`${session.documentId}.hcd-draft`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000)
}
type Review={sourceHash:string;copies:FixedDraftCopy[];selected:FixedDraftCopy;nodes:Array<{id:string;text:string;deleted:boolean;editable:boolean|null}>;images:Array<{id:string;image:PositionedImage|null}>;offset:number;revision:number;previewReady:boolean;select:(id:string)=>Promise<void>;page:(offset:number)=>Promise<void>;restore:(deferBlank?:boolean)=>Promise<void>;serverOnly:()=>Promise<void>}
const empty=():FixedDraftState=>({version:3,texts:[],images:[],attempt:null})
function PreviewText({text}:{text:string}){const {t}=useI18n();return text.length<=6000?<p>{text}</p>:<><p>{text.slice(0,6000)}</p><details><summary>{t('fixedRecoveryShowFull')}</summary><p>{text}</p></details></>}
function RecoveryImage({geometry,assetHash,session}:{geometry:ImageGeometry;assetHash?:string|null;session:Session}){const {t}=useI18n(),factor=geometry.unit==='emu'?12700:1;return <><p>{t('positionAndSize')} · pt: {(['x','y','width','height'] as const).map(key=>`${t(key)} ${Number((geometry[key]/factor).toFixed(2))}`).join(' · ')}</p>{assetHash&&<ImageCandidatePreview session={session} assetHash={assetHash}/>}</>}

/** Load before any page loader or revision subscription can reconcile drafts.
 * Recovery always forks a new branch; other windows' records are never replaced. */
export function FixedDraftBootstrap({session,children,onClose}:{session:Session;onClose?:()=>void;children:(binding:FixedBinding)=>ReactNode}){
  const {t,locale}=useI18n(),generation=useRef(0)
  const [binding,setBinding]=useState<FixedBinding|null>(null),[review,setReview]=useState<Review|null>(null),[error,setError]=useState<DocumentProblem|null>(null),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0)
  const [without,setWithout]=useState<(()=>Promise<void>)|null>(null)
  const [canRestore,setCanRestore]=useState(false)
  useEffect(()=>{
    const abort=new AbortController()
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)])
    const current=++generation.current,journals=new Set<FixedDraftJournal>(),controllers=new Set<FixedSaveController>()
    const alive=()=>generation.current===current
    const open=async(name:string)=>{
      const journal=await draftStorage(()=>FixedDraftJournal.open(name))
      if(!alive()){journal.close();throw new Error('Canceled')}
      journals.add(journal);return journal
    }
    setBinding(null);setReview(null);setError(null);setWithout(null);setCanRestore(false);setBusy(false)
    const start=async()=>{
      const [authResponse,manifestResponse]=await Promise.all([api(session,'/auth',{signal}),api(session,'',{signal})])
      const access=await authResponse.json() as {userId?:string;scope:string},manifest=await manifestResponse.json() as {source:{sha256:string};revision:number}
      if(!alive())return
      if(!['read','write'].includes(access?.scope)||typeof manifest?.source?.sha256!=='string'||! /^[a-f0-9]{64}$/.test(manifest.source.sha256)||!Number.isSafeInteger(manifest.revision)||manifest.revision<0)throw new EditorDocumentError(documentProblem('HCD-DOC-3001','recovery'))
      const effective:Session={...session,flowLayoutVersion:wordRegionVersion(manifest),scope:access.scope==='write'?'write':'read',userId:access.userId}
      setCanRestore(effective.scope==='write')
      const launch=async(state:FixedDraftState,journal:FixedDraftJournal|null,copies:FixedDraftCopy[],unavailable=false)=>{
        if(!alive())return
        if((state.blankAttempt||state.blankInput)&&(effective.format!=='xlsx'||!journal))throw new Error('Invalid workbook recovery')
        if(state.workbookBuffer&&effective.format!=='xlsx')throw new Error('Invalid workbook recovery')
        if(effective.format==='xlsx'&&(state.images.length||state.attempt?.images.length||state.uploadInterrupted))throw new Error('Invalid workbook recovery')
        const texts=new TextDraftStore(),images=new ImageDraftStore()
        texts.restore(state.texts);images.restore(state.images)
        const controller=new FixedSaveController(effective,texts,images,journal,state.attempt);controllers.add(controller)
        // A confirmed comparison transfers the unfinished input into the same
        // guarded draft store. Pending attempts are already marked in flight.
        if(state.workbookBuffer){if(workbookInputDiverged(texts,state.workbookBuffer))controller.setWorkbookBuffer(state.workbookBuffer);else restoreWorkbookInput(texts,state.workbookBuffer)}
        if(state.blankAttempt||state.blankInput)await controller.writeWorkbookBlankState(state)
        await controller.connect()
        const importBackup=journal&&effective.scope==='write'?async(file:File,reopen=false)=>{
          if(!file.size||file.size>fixedDraftBackupLimit)throw new Error('Invalid fixed draft backup')
          const state=parseFixedDraftBackup(await file.text(),effective,manifest.source.sha256,window.location.href)
          if(!state.texts.length&&!state.images.length&&!state.attempt&&!state.workbookBuffer&&!state.uploadInterrupted&&!state.blankAttempt&&!state.blankInput)throw new Error('Empty fixed draft backup')
          await fixedRecoveryHead(effective,manifest.source.sha256,AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)]),true)
          const name=await fixedDraftDatabase(effective,effective.userId!,manifest.source.sha256,window.location.href),imported=await open(name)
          try{return await draftStorage(()=>imported.importBackupCopy(state,reopen,abort.signal))}finally{imported.close();journals.delete(imported)}
        }:undefined
        if(alive())setBinding({sourceHash:manifest.source.sha256,session:effective,texts,images,controller,journal,copies,unavailable,importBackup})
      }
      setWithout(()=>()=>launch(empty(),null,[],true))
      if(typeof access.userId!=='string'||!access.userId.trim())throw new EditorDocumentError(documentProblem('HCD-DOC-4003','recovery'))
      const name=await draftStorage(()=>fixedDraftDatabase(session,access.userId!,manifest.source.sha256,window.location.href))
      const journal=await open(name)
      const copies=await draftStorage(()=>journal.copies()),pending=copies.filter(copy=>!copy.retained)
      if(!alive())return
      if(!pending.length){await launch(empty(),effective.scope==='write'?journal:null,copies);return}
      let selected=pending[0],nodes:Review['nodes']=[],images:Review['images']=[],offset=0,reviewedRevision=manifest.revision,previewReady=false
      const preview=async()=>{
        try{
          const result=await fixedRecoveryPreview(effective,manifest.source.sha256,selected.state,AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)]),offset)
          reviewedRevision=result.revision;nodes=result.nodes;images=result.images;previewReady=true;if(alive())setError(null)
        }catch(cause){if(abort.signal.aborted)throw cause;previewReady=false;nodes=[];images=[];if(alive())setError(classifyDocumentProblem(cause,'recovery'))}
      }
      const display=()=>{
        if(!alive())return
        setReview({sourceHash:manifest.source.sha256,copies:pending,selected,nodes,images,offset,revision:reviewedRevision,previewReady,
          select:async(id)=>{const copy=pending.find(value=>value.id===id);if(copy){selected=copy;offset=0;await preview();display()}},
          page:async(next)=>{const previous=reviewedRevision;offset=next;await preview();display();if(previewReady&&reviewedRevision!==previous)throw new EditorDocumentError(documentProblem('HCD-DOC-1009','recovery'))},
          restore:async(deferBlank=false)=>{
            if(effective.scope!=='write'||!previewReady)return
            // Another live window may still own the reviewed branch. Refresh
            // the comparison if it changed; never silently restore new bytes.
            const currentCopies=await draftStorage(()=>journal.copies()),latest=currentCopies.find(copy=>copy.id===selected.id)
            if(!latest)throw new EditorDocumentError(documentProblem('HCD-DOC-1010','recovery'))
            if(latest.reviewGeneration!==selected.reviewGeneration||JSON.stringify(latest.state)!==JSON.stringify(selected.state)){selected=latest;offset=0;await preview();display();throw new EditorDocumentError(documentProblem('HCD-DOC-1010','recovery'))}
            if(deferBlank&&(!latest.state.blankInput||latest.state.blankAttempt||!nodes.some(node=>node.id===latest.state.blankInput!.cell.nodeId&&!node.deleted)))throw new EditorDocumentError(documentProblem('HCD-DOC-1010','recovery'))
            const redirect=async(copies:FixedDraftCopy[])=>{const existing=pendingWorkbookRecovery(latest.state,latest.id,copies);if(existing){const index=pending.findIndex(copy=>copy.id===existing.id);if(index<0)pending.unshift(existing);else pending[index]=existing;selected=existing;offset=0;await preview();display();throw new EditorDocumentError(documentProblem('HCD-DOC-1010','recovery'))}}
            await redirect(currentCopies)
            const head=await fixedRecoveryHead(effective,manifest.source.sha256,AbortSignal.any([abort.signal,AbortSignal.timeout(30_000)]),true)
            if(head!==reviewedRevision){await preview();display();if(previewReady)throw new EditorDocumentError(documentProblem('HCD-DOC-1009','recovery'));return}
            const target=await open(name)
            let recovered:FixedDraftState
            const recoverySignal=AbortSignal.any([abort.signal,AbortSignal.timeout(60_000)])
            try{
              const write=async(value:FixedDraftState)=>{recoverySignal.throwIfAborted();await draftStorage(()=>target.write(value));recoverySignal.throwIfAborted()}
              const resolveBlank=async()=>{
                recoverySignal.throwIfAborted()
                let result=await resolveWorkbookBlankRecovery(latest.state,effective,manifest.source.sha256,write,recoverySignal)
                if(result.blankInput){const current=await fixedRecoveryHead(effective,manifest.source.sha256,recoverySignal,true);result=await resolveWorkbookBlankInput(result,effective,manifest.source.sha256,current,write,recoverySignal)}
                return result
              }
              if(effective.format==='xlsx'&&(latest.state.blankAttempt||latest.state.blankInput)){
                // A batch in another window can otherwise commit while startup
                // recovery automatically creates a new single-cell request.
                // Transfer the single draft unchanged when batches exist so
                // the regular editor can reconcile them in a safe order.
                const batch=new WorkbookBlankBatchClient(effective,manifest.source.sha256,()=>true)
                const defer=async()=>{recoverySignal.throwIfAborted();await write(latest.state);recoverySignal.throwIfAborted();return structuredClone(latest.state)}
                recovered=await withWorkbookStartupRecovery({signal:recoverySignal,start:()=>batch.start(),ready:()=>alive()&&!batch.loading&&!batch.problem,hasLocks:typeof navigator.locks!=='undefined',locked:work=>batch.withPendingResolution(async hasPending=>{recoverySignal.throwIfAborted();await redirect(await draftStorage(()=>journal.copies()));recoverySignal.throwIfAborted();return work(hasPending||deferBlank)}),defer,recover:resolveBlank,dispose:()=>batch.dispose()})
              }else recovered=await resolveBlank()
            }catch(cause){
              // A timed-out request may have committed. On retry select the
              // write-ahead branch, preserving its exact request identity.
              if(!recoverySignal.aborted){const copy=(await draftStorage(()=>target.copies())).find(item=>item.id===target.branch)
               if(copy){const index=pending.findIndex(item=>item.id===copy.id);if(index>=0)pending[index]=copy;else pending.unshift(copy);selected=copy;offset=0;await preview();display()}}
              else if(alive())setRetry(value=>value+1) // Re-read any write-ahead branch before another attempt.
              throw cause
            }
            await launch(recovered,target,copies)
            await draftStorage(()=>journal.retain(latest.id,latest.state,latest.reviewGeneration))
          },
          serverOnly:async()=>{
            const target=effective.scope==='write'?await open(name):null
            await launch(empty(),target,copies)
            if(target)for(const copy of pending)await draftStorage(()=>journal.retain(copy.id,copy.state,copy.reviewGeneration))
          },
        })
      }
      await preview();display()
    }
    void start().catch(cause=>{if(alive())setError(classifyDocumentProblem(signal.aborted?signal.reason:cause,'recovery'))})
    return()=>{generation.current++;abort.abort();controllers.forEach(controller=>controller.dispose());journals.forEach(journal=>journal.close())}
  },[session.documentId,session.apiUrl,session.collabUrl,session.token,session.scope,retry])
  if(binding)return children(binding)
  const act=(work:()=>Promise<void>)=>{const current=generation.current;setBusy(true);setError(null);void work().catch(cause=>{if(current===generation.current)setError(classifyDocumentProblem(cause,'recovery'))}).finally(()=>{if(current===generation.current)setBusy(false)})}
  if(!review)return error?<DocumentProblemView problem={error} documentId={session.documentId} busy={busy} onClose={onClose} onRetry={()=>setRetry(value=>value+1)} secondary={without&&['HCD-DOC-4001','HCD-DOC-4003'].includes(error.code)?{label:t('localDraftContinueWithout'),run:()=>act(without)}:undefined}/>:<DocumentLoading documentId={session.documentId} onClose={onClose}/>
  const ids=fixedRecoveryIds(review.selected.state),imageIds=fixedRecoveryImageIds(review.selected.state),total=fixedRecoveryCount(review.selected.state),pageIds=ids.slice(review.offset,review.offset+fixedRecoveryPageSize),pageImages=imageIds.slice(review.offset,review.offset+fixedRecoveryPageSize)
  const blankOccupied=!!review.selected.state.blankInput&&!review.selected.state.blankAttempt&&review.nodes.some(node=>node.id===review.selected.state.blankInput?.cell.nodeId&&!node.deleted)
  return <section className="local-draft-start" aria-label={t('localDraftRecovery')}>
    <h2>{t(review?'localDraftFound':'localDraftLoading')}</h2>
    {review&&<><p>{t('fixedDraftReviewHint')}</p><label>{t('localDraftCopies')}<select aria-label={t('localDraftCopies')} value={review.selected.id} disabled={busy} onChange={event=>act(()=>review.select(event.target.value))}>{review.copies.map(copy=><option key={copy.id} value={copy.id}>{new Date(copy.updatedAt).toLocaleString(locale)}</option>)}</select></label>
      {total>0&&<nav aria-label={t('fixedRecoveryPages')}><span>{t('fixedRecoveryPageRange',{from:review.offset+1,to:Math.min(review.offset+fixedRecoveryPageSize,total),total})}</span> <button type="button" disabled={busy||review.offset===0} onClick={()=>act(()=>review.page(review.offset-fixedRecoveryPageSize))}>{t('fixedRecoveryPrevious')}</button> <button type="button" disabled={busy||review.offset+fixedRecoveryPageSize>=total} onClick={()=>act(()=>review.page(review.offset+fixedRecoveryPageSize))}>{t('fixedRecoveryNext')}</button>{ids.length>0&&imageIds.length>0&&<p>{t('fixedRecoveryMixedPages')}</p>}</nav>}
      <div className="local-draft-compare"><section><h3>{t('localDraftDevice')}</h3>{pageIds.map((id,index)=>{
        const draft=review.selected.state.texts.find(([key])=>key===id)?.[1],captured=review.selected.state.attempt?.texts.find(([key])=>key===id)?.[1],buffer=review.selected.state.workbookBuffer?.base.nodeId===id?review.selected.state.workbookBuffer:null,blank=review.selected.state.blankAttempt?.cells.find(cell=>cell.nodeId===id),blankInput=review.selected.state.blankInput?.cell.nodeId===id?review.selected.state.blankInput.cell:null
        return <section key={`text:${id}`}><strong>{t('fixedRecoveryObject',{number:review.offset+index+1})}</strong>{blankInput&&(!blank||blankInput.text!==blank.text)&&<><p>{t('workbookInputUnfinished')}</p><p>{t('workbookInputLocation',{location:`${blankInput.sheetName??blankInput.sheetId}!${workbookCellAddress(blankInput.row-1,blankInput.column-1)}`})}</p><PreviewText text={blankInput.text}/></>}{blank&&<><p>{t('fixedRecoveryPendingRequest')}</p><p>{t('workbookInputLocation',{location:`${blank.sheetName??blank.sheetId}!${workbookCellAddress(blank.row-1,blank.column-1)}`})}</p><PreviewText text={blank.text}/></>}{captured&&<><p>{t('fixedRecoveryPendingRequest')}</p><PreviewText text={captured.text}/></>}{draft&&<>{captured&&<p>{t('fixedRecoveryCurrentDraft')}</p>}<PreviewText text={draft.text}/></>}{buffer&&<><p>{t('workbookInputRecoveryHint')}</p><p>{t('workbookInputLocation',{location:workbookInputLocation(buffer)})}</p><p>{t('workbookInputInitial')}</p><PreviewText text={buffer.initial}/><p>{t('workbookInputUnfinished')}</p><PreviewText text={buffer.text}/></>}</section>
      })}{pageImages.map((id,index)=>{
        const draft=review.selected.state.images.find(([key])=>key===id)?.[1],captured=review.selected.state.attempt?.images.find(([key])=>key===id)?.[1],label=draft?.base.label??captured?.base.label
        return <section key={`image:${id}`}><strong>{t('imageNumber',{count:review.offset+index+1})}{label?` · ${label}`:''}</strong>{captured&&<><p>{t('fixedRecoveryPendingRequest')}</p>{captured.restoreSource&&<p>{t('imageSourceRestorePending')}</p>}<RecoveryImage geometry={captured.geometry} assetHash={captured.restoreSource?undefined:captured.assetHash??captured.base.assetHash} session={session}/></>}{draft&&<>{captured&&<p>{t('fixedRecoveryCurrentDraft')}</p>}{draft.restoreSource&&<p>{t('imageSourceRestorePending')}</p>}<RecoveryImage geometry={draft.geometry} assetHash={draft.restoreSource?undefined:draft.assetHash??draft.base.assetHash} session={session}/></>}</section>
      })}{(review.selected.state.attempt||review.selected.state.blankAttempt)&&<p>{t('fixedSaveUnknown')}</p>}{review.selected.state.blankAttempt&&<p>{t('workbookBlankRecoveryHint')}</p>}{review.selected.state.blankInput&&<p>{t('workbookBlankInputRecoveryHint')}</p>}{review.selected.state.uploadInterrupted&&<p>{t('fixedUploadInterrupted')}</p>}</section><section><h3>{t('localDraftServer')} · r{review.revision}</h3>{review.previewReady?<>{review.nodes.map((node,index)=><section key={`text:${node.id}`}><strong>{t('fixedRecoveryObject',{number:review.offset+index+1})}</strong><PreviewText text={node.deleted?t((review.selected.state.blankAttempt?.cells.some(cell=>cell.nodeId===node.id)||review.selected.state.blankInput?.cell.nodeId===node.id)?'workbookBlankRecoveryMissing':'draftObjectDeleted'):node.text}/>{session.format==='xlsx'&&!node.deleted&&node.editable!==true&&<p role="status">{t(node.editable===false?'workbookRecoveryProtected':'workbookRecoveryEditabilityUnknown')}</p>}</section>)}{review.images.map(({id,image},index)=><section key={`image:${id}`}><strong>{t('imageNumber',{count:review.offset+index+1})}{image?.label?` · ${image.label}`:''}</strong>{image?<RecoveryImage geometry={image.geometry} assetHash={image.assetHash} session={session}/>:<p>{t('draftObjectDeleted')}</p>}</section>)}</>:<p>{t('localDraftWaitingNetwork')}</p>}</section></div>
      {blankOccupied&&<p role="status">{t('workbookBlankRecoveryOccupied')}</p>}
      {blankOccupied&&<button type="button" disabled={busy||!canRestore||!review.previewReady} onClick={()=>act(()=>review.restore(true))}>{t('workbookBlankReviewInEditor')}</button>}
      <button disabled={busy||!canRestore||!review.previewReady||blankOccupied} onClick={()=>act(review.restore)}>{t('localDraftRestore')}</button><button disabled={busy} onClick={()=>act(review.serverOnly)}>{t('localDraftKeepAndOpen')}</button><FixedDraftDownload disabled={busy} download={()=>downloadFixedDraft(session,review.selected.state,review.sourceHash)}/>
    </>}
    {error&&<DocumentProblemView problem={error} compact busy={busy}/>}
    <button disabled={busy} onClick={()=>setRetry(value=>value+1)}>{t('localDraftRetry')}</button>
    {error&&!review&&without&&<button disabled={busy} onClick={()=>act(without)}>{t('localDraftContinueWithout')}</button>}
  </section>
}
