import {wordRegionVersion} from './wordRegions.ts'
import { useEffect, useMemo, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import {DocumentLoading,DocumentProblemView} from './DocumentProblem.tsx'
import {classifyDocumentProblem,documentProblem,EditorDocumentError,type DocumentProblem} from './documentProblems.ts'
import {LiveAccess} from './liveAccess.ts'
import { api, ApiError, watchRevisions, type RevisionConnectionStatus, type Session } from './api.ts'
import {readBoundedResponse} from './boundedResponse.ts'
import {parseWordStoryIndex} from './wordStoryIndex.ts'
import {compatibleWordIndexReader} from './wordIndexCompat.ts'
import {FixedIndex} from './fixedIndex.ts'
import {FixedDraftBootstrap,downloadFixedDraft,type FixedBinding} from './FixedDraftBootstrap.tsx'
import {FixedDraftImport} from './FixedDraftImport.tsx'
import {FixedDraftDownload} from './FixedDraftDownload.tsx'
import {useI18n} from './i18n.tsx'
import { type Manifest, type PageGroup } from './fixedPages.ts'
import { FixedLayoutEditor } from './FixedLayoutEditor.tsx'
import { refreshImageDrafts,refreshTextDrafts } from './saveEdits.ts'
import {FixedImageTasks} from './fixedImageTasks.ts'
import {FixedImageTasksView} from './FixedImageTasksView.tsx'
import {FixedPortablePanel} from './FixedPortablePanel.tsx'
import {closeFixedIfSettled} from './fixedCloseGuard.ts'

type FixedViewerProps={session:Session;onClose:()=>void;allowClose?:boolean;embedded:boolean;onFullEditor?:()=>void}
const emptySubscribe=()=>()=>{},idle=()=> 'idle' as const,emptyIndex=()=>0
export function FixedViewer(props:FixedViewerProps){
  return <FixedDraftBootstrap session={props.session} onClose={props.allowClose===false?undefined:props.onClose}>{binding=><FixedViewerContent {...props} session={binding.session} binding={binding}/>}</FixedDraftBootstrap>
}
function FixedViewerContent({session,onClose,allowClose=true,embedded,onFullEditor,binding}:{binding:FixedBinding}&FixedViewerProps){
  const {t,locale}=useI18n(),{texts:drafts,images:imageDrafts,controller,journal,copies,unavailable}=binding
  const access=useMemo(()=>new LiveAccess(session),[session])
  const accessState=useSyncExternalStore(access.subscribe,access.snapshot)
  useEffect(()=>access.start(),[access])
  const [imageTasks,setImageTasks]=useState<FixedImageTasks|null>(null),[taskGeneration,setTaskGeneration]=useState(0)
  useEffect(()=>{
    const tasks=new FixedImageTasks(session,binding.sourceHash,imageDrafts,controller,()=>access.snapshot()==='write')
    setImageTasks(tasks);void tasks.start()
    return()=>{tasks.dispose()}
  },[session,binding.sourceHash,imageDrafts,controller,access,taskGeneration])
  useSyncExternalStore(imageTasks?.subscribe??emptySubscribe,imageTasks?.snapshot??emptyIndex)
  const backupState=useSyncExternalStore(journal?.subscribe??emptySubscribe,journal?.snapshot??idle)
  const [backupDisabled,setBackupDisabled]=useState(unavailable)
  const [backupFlushFailed,setBackupFlushFailed]=useState(false)
  const mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  useSyncExternalStore(controller.subscribe,controller.snapshot)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [index,setIndex]=useState<FixedIndex|null>(null)
  const indexRef=useRef(index);indexRef.current=index
  const [wordIndexFailed,setWordIndexFailed]=useState(false),[wordIndexRetry,setWordIndexRetry]=useState(0)
  const [storyIndex,setStoryIndex]=useState<{manifest:Manifest;groups:PageGroup[]|null}|null>(null)
  const [storyFailed,setStoryFailed]=useState(false)
  const indexVersion=useSyncExternalStore(index?.subscribe??emptySubscribe,index?.snapshot??emptyIndex)
  const [style, setStyle] = useState('')
  const [updates, setUpdates] = useState<RevisionConnectionStatus>('connecting')
  const [indexGeneration, setIndexGeneration] = useState(0)
  const [error, setError] = useState('')
  const [loadProblem,setLoadProblem]=useState<DocumentProblem|null>(null)
  const [headRevision, setHeadRevision] = useState<number | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  useSyncExternalStore(imageDrafts.subscribe, imageDrafts.snapshot)
  const imageIds = imageDrafts.trackingIds.join(',')
  useSyncExternalStore(drafts.subscribe,drafts.snapshot)
  const textIds=drafts.entries().map(([id])=>id).sort().join(',')
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (drafts.size || imageDrafts.size || imageDrafts.saving || controller.pending || controller.busy || controller.history.busy || backupState==='writing' || (backupState==='failed'||backupFlushFailed)&&!backupDisabled || session.scope==='write'&&(!imageTasks||imageTasks.pending)) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [drafts, imageDrafts,controller,backupState,backupFlushFailed,backupDisabled,imageTasks,session.scope])
  const pages = useMemo(() => index?.groups()??[], [index,indexVersion])
  const canResolvePage=useCallback((sequence:number)=>!!index&&index.manifest===manifest&&index.validSequence(sequence),[index,manifest])
  const resolvePage=useCallback((sequence:number,signal?:AbortSignal)=>{if(!index||index.manifest!==manifest)return Promise.reject(new Error('fixedLocationUnavailable'));return index.ensurePage(sequence,signal)},[index,manifest])
  const pageComplete=useCallback((sequence:number)=>!!index?.page(sequence),[index])
  const wordIndex=useMemo(()=>index&&index.manifest===manifest?{
    groups:()=>{if(indexRef.current!==index)throw new Error('fixedLocationUnavailable');return index.groups()},
    complete:()=>{if(indexRef.current!==index)throw new Error('fixedLocationUnavailable');return index.complete()},
    loadMore:async(signal?:AbortSignal)=>{if(indexRef.current!==index)throw new Error('fixedLocationUnavailable');await index.loadNextFor(signal)}
  }:null,[index,manifest])
  const nextWordGroup=useCallback(async(sequence:number,region:string|undefined,signal?:AbortSignal)=>{
    if(!index||index.manifest!==manifest)throw new Error('fixedLocationUnavailable')
    try{const group=await index.ensureNext(sequence,region,signal);if(indexRef.current===index)setWordIndexFailed(false);return group}
    catch(error){if(!signal?.aborted&&indexRef.current===index)setWordIndexFailed(true);throw error}
  },[index,manifest])
  const loadWordIndex=useCallback(async()=>{
    if(!index||index.manifest!==manifest)return
    try{await index.loadNext();if(indexRef.current===index)setWordIndexFailed(false)}catch{if(indexRef.current===index)setWordIndexFailed(true)}
  },[index,manifest])
  const indexedRevision = manifest?.revision
  const revision = headRevision === null && indexedRevision === undefined ? null : Math.max(headRevision ?? 0, indexedRevision ?? 0)
  const revisionRef = useRef(0)
  revisionRef.current = revision ?? 0

  useEffect(() => {
    if (!imageIds || revision === null) return
    const controller = new AbortController()
    void refreshImageDrafts(session, imageDrafts, next => setHeadRevision(previous => Math.max(previous ?? 0, next)), controller.signal)
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause)) })
    return () => controller.abort()
  }, [session, imageDrafts, imageIds, revision])

  useEffect(()=>{
    if(!textIds||revision===null)return
    const controller=new AbortController()
    void refreshTextDrafts(session,drafts,next=>setHeadRevision(previous=>Math.max(previous??0,next)),controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(String(cause))})
    return()=>controller.abort()
  },[session,drafts,textIds,revision])

  useEffect(() => {
    if (indexedRevision === undefined) return
    const controller = new AbortController()
    void watchRevisions(session, controller.signal, event => {
      if (event.revision >= revisionRef.current) {
        drafts.reconcile(event.nodes, event.revision)
        if (event.nodeHashes) drafts.reconcileHashes(event.nodeHashes, event.revision)
        setHeadRevision(previous => Math.max(previous ?? 0, event.revision))
        if (event.reset) setIndexGeneration(value => value + 1)
      }
    }, setUpdates, { afterRevision: indexedRevision, tracking: { snapshot: () => drafts.entries().map(([id]) => id), subscribe: drafts.subscribe } })
    return () => controller.abort()
  }, [session, drafts, indexedRevision])

  useEffect(() => {
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)])
    setLoadProblem(null)
    Promise.all([api(session, '',{signal}).then(response => response.json()), api(session, '/styles',{signal}).then(response => response.text())])
      .then(([info, css]) => {
        if(controller.signal.aborted)return
        if(!Number.isSafeInteger(info?.revision)||info.revision<0||!Number.isSafeInteger(info?.chunkCount)||info.chunkCount<0||!Number.isSafeInteger(info?.indexPageCount)||info.indexPageCount!==Math.ceil(info.chunkCount/128)||typeof info?.source?.format!=='string')throw new EditorDocumentError(documentProblem('HCD-DOC-3001','content'))
        if(wordRegionVersion(info)!==session.flowLayoutVersion){setManifest(null);throw new EditorDocumentError(documentProblem('HCD-DOC-1026','content'))}
        setManifest(info as Manifest);setStyle(css)
      })
      .catch(cause => { if (!controller.signal.aborted) setLoadProblem(classifyDocumentProblem(signal.aborted?signal.reason:cause,'content')) })
    return () => controller.abort()
  }, [session, indexGeneration])
  useEffect(()=>{
    if(!manifest){setIndex(null);return}
    try{const read=session.flowLayoutVersion===2?compatibleWordIndexReader(session,manifest):async(page:number,signal:AbortSignal)=>(await api(session,`/index/${page}?revision=${manifest.revision}`,{signal})).json();const current=new FixedIndex(manifest,read);setIndex(current);return()=>current.close()}catch{setIndex(null);setError(t('fixedLocationUnavailable'))}
  },[session,manifest])
  useEffect(()=>{
    if(!index||index.manifest!==manifest||session.flowLayoutVersion!==2||storyIndex?.manifest!==manifest||storyIndex.groups!==null)return
    const controller=new AbortController();setWordIndexFailed(false)
    void index.ensureComplete(controller.signal).catch(()=>{if(!controller.signal.aborted)setWordIndexFailed(true)})
    return()=>controller.abort()
  },[index,manifest,session.flowLayoutVersion,wordIndexRetry,storyIndex])
  useEffect(()=>{
    if(!manifest||session.flowLayoutVersion!==2)return
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45_000)])
    setStoryFailed(false)
    void(async()=>{
      try{
        const response=await api(session,`/word/story-index?revision=${manifest.revision}`,{signal})
        const bytes=await readBoundedResponse(response,8*1024*1024,signal,'wordStoryIndexInvalid')
        const groups=parseWordStoryIndex(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),manifest)
        if(!controller.signal.aborted)setStoryIndex({manifest,groups})
      }catch(error){
        if(controller.signal.aborted)return
        // Only older servers lacking this route use the complete legacy index.
        if(error instanceof ApiError&&error.status===404){setStoryIndex({manifest,groups:null});return}
        setStoryFailed(true)
      }
    })()
    return()=>controller.abort()
  },[session,manifest,wordIndexRetry])
  useEffect(()=>{
    if(!index||index.manifest!==manifest||index.complete())return
    if(session.flowLayoutVersion===2&&storyIndex?.manifest===manifest&&storyIndex.groups===null)return
    let live=true
    const load=()=>{void index.loadNext().catch(()=>{if(live){if(session.flowLayoutVersion===2)setWordIndexFailed(true);else setError(t('fixedLocationUnavailable'))}})}
    if(index.entries().length===0){load();return()=>{live=false}}
    const marker=tail.current;if(!marker)return
    const observer=new IntersectionObserver(entries=>{if(entries[0].isIntersecting){observer.disconnect();load()}},{rootMargin:'1600px'})
    observer.observe(marker);return()=>{live=false;observer.disconnect()}
  },[index,indexVersion,manifest,session.flowLayoutVersion,storyIndex])
  const safeClose=()=>{void(async()=>{
    const close=async()=>{
      const beforeAccess=access.snapshot(),wasRevoked=beforeAccess==='revoked'
      const beforeDrafts=drafts.snapshot(),beforeImages=imageDrafts.snapshot(),beforeController=controller.snapshot()
      if(wasRevoked){
        if(!journal||backupDisabled||controller.busy||imageDrafts.uploading){setError(t('localDraftUnavailable'));return}
      }
      const blocked=()=>!mounted.current||access.snapshot()!==beforeAccess||controller.busy||controller.history.busy||imageDrafts.uploading||(wasRevoked?(drafts.snapshot()!==beforeDrafts||imageDrafts.snapshot()!==beforeImages||controller.snapshot()!==beforeController):(!!drafts.size||!!imageDrafts.size||imageDrafts.saving||controller.pending))
      const result=await closeFixedIfSettled(blocked,()=>controller.flush(),onClose)
      if(result!=='closed'&&mounted.current){if(result==='flush-failed')setBackupFlushFailed(true);setError(t(result==='flush-failed'?'localDraftUnavailable':'saveDraftsFirst'))}
    }
    try{if(session.scope==='write'){if(!imageTasks)throw new Error('imageUploadPending');await imageTasks.withClear(close)}else await close()}
    catch{setError(t('imageUploadPending'))}
    })()}
  if(!manifest)return <>{loadProblem?<DocumentProblemView problem={loadProblem} documentId={session.documentId} onRetry={()=>setIndexGeneration(value=>value+1)} onClose={allowClose?safeClose:undefined} secondary={drafts.size||imageDrafts.size?{label:t('downloadDraft'),run:()=>downloadFixedDraft(session,controller.state(),binding.sourceHash)}:undefined}/>:<DocumentLoading documentId={session.documentId} onClose={allowClose?safeClose:undefined}/>}<FixedImageTasksView tasks={imageTasks} reopen={()=>setTaskGeneration(value=>value+1)}/>{error&&<p role="alert">{error}</p>}</>
  return <div className={`fixed-workspace-shell ${embedded?'embedded':''}`}><FixedLayoutEditor sourceHash={binding.sourceHash} accessState={accessState} saveController={controller} imageTasks={imageTasks} session={session} embedded={embedded} pages={pages} stylesheet={style}
    revision={revision} drafts={drafts} imageDrafts={imageDrafts} updates={updates} onBackupFailure={()=>setBackupFlushFailed(true)} onFullEditor={session.flowLayoutVersion||!onFullEditor?undefined:()=>{void(async()=>{try{if(session.scope==='write'){if(!imageTasks)throw new Error('imageUploadPending');await imageTasks.withClear(async()=>onFullEditor())}else onFullEditor()}catch{setError(t('imageUploadPending'))}})()}} indexComplete={!!index&&index.manifest===manifest&&index.complete()} wordStoryGroups={storyIndex?.manifest===manifest?storyIndex.groups:null} wordStoriesReady={storyIndex?.manifest===manifest&&!storyFailed&&(storyIndex.groups!==null||!!index&&index.manifest===manifest&&index.complete())} wordIndexFailed={wordIndexFailed||storyFailed} onRetryWordIndex={()=>{setWordIndexRetry(value=>value+1);void loadWordIndex()}} canResolvePage={canResolvePage} resolvePage={resolvePage} pageComplete={pageComplete}
    indexTail={tail} wordIndex={wordIndex} nextWordGroup={nextWordGroup} loadWordIndex={loadWordIndex} error={error} onError={setError} onRevised={next => setHeadRevision(previous => Math.max(previous ?? 0, next))} onClose={safeClose} />
    {loadProblem&&<DocumentProblemView compact problem={loadProblem} onRetry={()=>setIndexGeneration(value=>value+1)}/>}
    {accessState==='revoked'&&<p className="local-draft-warning" role="alert">{t('accessRevoked')}</p>}<FixedImageTasksView tasks={imageTasks} reopen={()=>setTaskGeneration(value=>value+1)}/>{session.scope==='write'&&<><FixedPortablePanel session={session} sourceHash={binding.sourceHash} save={controller} tasks={imageTasks}/><div className={backupDisabled||backupState==='failed'||backupFlushFailed?'local-draft-warning':'local-draft-status'} role={backupState==='failed'||backupFlushFailed?'alert':'status'}>{t(backupDisabled||backupState==='failed'||backupFlushFailed?'localDraftUnavailable':backupState==='writing'?'localDraftWriting':'localDraftStored')} <FixedDraftDownload download={()=>downloadFixedDraft(session,controller.state(),binding.sourceHash)}/>{binding.importBackup&&<FixedDraftImport importBackup={binding.importBackup} />}{journal&&(backupState==='failed'||backupFlushFailed)&&!backupDisabled&&<><button disabled={controller.busy} onClick={()=>{void journal.write(controller.state()).then(()=>{if(mounted.current){setBackupFlushFailed(false);setError('')}}).catch(()=>{})}}>{t('localDraftRetry')}</button><button disabled={controller.busy} onClick={()=>{controller.continueWithoutBackup();setBackupDisabled(true);setBackupFlushFailed(false)}}>{t('localDraftContinueWithout')}</button></>}{!!copies.length&&<details><summary>{t('localDraftCopies')} ({copies.length})</summary>{copies.map(copy=><button key={copy.id} onClick={()=>downloadFixedDraft(session,copy.state,binding.sourceHash)}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t('downloadDraft')}</button>)}</details>}</div></>}
  </div>
}
