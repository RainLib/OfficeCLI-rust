import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, watchRevisions, type RevisionConnectionStatus, type Session } from './api.ts'
import {FixedDraftBootstrap,downloadFixedDraft,type FixedBinding} from './FixedDraftBootstrap.tsx'
import {useI18n} from './i18n.tsx'
import { groupPages, type Manifest, type Descriptor } from './fixedPages.ts'
import { FixedLayoutEditor } from './FixedLayoutEditor.tsx'
import { refreshImageDrafts,refreshTextDrafts } from './saveEdits.ts'

type FixedViewerProps={session:Session;onClose:()=>void;embedded:boolean;onFullEditor?:()=>void}
const emptySubscribe=()=>()=>{},idle=()=> 'idle' as const
export function FixedViewer(props:FixedViewerProps){
  return <FixedDraftBootstrap session={props.session}>{binding=><FixedViewerContent {...props} session={binding.session} binding={binding}/>}</FixedDraftBootstrap>
}
function FixedViewerContent({session,onClose,embedded,onFullEditor,binding}:{binding:FixedBinding}&FixedViewerProps){
  const {t,locale}=useI18n(),{texts:drafts,images:imageDrafts,controller,journal,copies,unavailable}=binding
  const backupState=useSyncExternalStore(journal?.subscribe??emptySubscribe,journal?.snapshot??idle)
  const [backupDisabled,setBackupDisabled]=useState(unavailable)
  useSyncExternalStore(controller.subscribe,controller.snapshot)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedIndexPages, setLoadedIndexPages] = useState(0)
  const [updates, setUpdates] = useState<RevisionConnectionStatus>('connecting')
  const [indexGeneration, setIndexGeneration] = useState(0)
  const [error, setError] = useState('')
  const [headRevision, setHeadRevision] = useState<number | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  useSyncExternalStore(imageDrafts.subscribe, imageDrafts.snapshot)
  const imageIds = imageDrafts.trackingIds.join(',')
  useSyncExternalStore(drafts.subscribe,drafts.snapshot)
  const textIds=drafts.entries().map(([id])=>id).sort().join(',')
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (drafts.size || imageDrafts.size || imageDrafts.saving || controller.pending || backupState==='writing') { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [drafts, imageDrafts,controller,backupState])
  const pages = useMemo(() => ['pptx', 'pdf'].includes(session.format) ? groupPages(descriptors) : descriptors.map(chunk => ({ firstSequence: chunk.sequence, region: chunk.region, sequences: [chunk.sequence] })), [descriptors, session.format])
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
    let live = true
    setManifest(null)
    setDescriptors([])
    setLoadedIndexPages(0)
    Promise.all([api(session, '').then(response => response.json()), api(session, '/styles').then(response => response.text())])
      .then(([info, css]) => { if (live) { setManifest(info as Manifest); setStyle(css) } })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session, indexGeneration])
  useEffect(() => {
    if (!manifest || loadedIndexPages >= manifest.indexPageCount) return
    let live = true
    const load = async () => {
      try {
        const index = await (await api(session, `/index/${loadedIndexPages}?revision=${manifest.revision}`)).json() as { chunks: Descriptor[] }
        if (live) { setDescriptors(previous => [...previous, ...index.chunks]); setLoadedIndexPages(loadedIndexPages + 1) }
      } catch (cause) { if (live) setError(String(cause)) }
    }
    // The first index must load even when a narrow layout hides thumbnails.
    if (loadedIndexPages === 0) { void load(); return () => { live = false } }
    const marker = tail.current
    if (!marker) return
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      observer.disconnect()
      void load()
    }, { rootMargin: '1600px' })
    observer.observe(marker)
    return () => { live = false; observer.disconnect() }
  }, [session, manifest, loadedIndexPages])
  return <div className={`fixed-workspace-shell ${embedded?'embedded':''}`}><FixedLayoutEditor saveController={controller} session={session} embedded={embedded} pages={pages} stylesheet={style}
    revision={revision} drafts={drafts} imageDrafts={imageDrafts} updates={updates} onFullEditor={onFullEditor} indexComplete={!!manifest && loadedIndexPages >= manifest.indexPageCount}
    indexTail={tail} error={error} onError={setError} onRevised={next => setHeadRevision(previous => Math.max(previous ?? 0, next))} onClose={()=>{void(async()=>{
      if(drafts.size||imageDrafts.size||imageDrafts.saving||controller.pending||controller.history.busy){setError(t('saveDraftsFirst'));return}
      try{await controller.flush()}catch{/* Server-confirmed content remains safe; backup warning is separate. */}
      if(drafts.size||imageDrafts.size||imageDrafts.saving||controller.pending||controller.history.busy){setError(t('saveDraftsFirst'));return}
      onClose()
    })()}} />
    {session.scope==='write'&&<div className={backupDisabled||backupState==='failed'?'local-draft-warning':'local-draft-status'} role={backupState==='failed'?'alert':'status'}>{t(backupDisabled||backupState==='failed'?'localDraftUnavailable':backupState==='writing'?'localDraftWriting':'localDraftStored')} <button onClick={()=>downloadFixedDraft(session,controller.state(),binding.sourceHash)}>{t('downloadDraft')}</button>{journal&&backupState==='failed'&&!backupDisabled&&<><button disabled={controller.busy} onClick={()=>{void journal.write(controller.state()).catch(()=>{})}}>{t('localDraftRetry')}</button><button disabled={controller.busy} onClick={()=>{controller.continueWithoutBackup();setBackupDisabled(true)}}>{t('localDraftContinueWithout')}</button></>}{!!copies.length&&<details><summary>{t('localDraftCopies')} ({copies.length})</summary>{copies.map(copy=><button key={copy.id} onClick={()=>downloadFixedDraft(session,copy.state,binding.sourceHash)}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t('downloadDraft')}</button>)}</details>}</div>}
  </div>
}
