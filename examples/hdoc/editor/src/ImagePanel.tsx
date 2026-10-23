import { useEffect, useState, useSyncExternalStore } from 'react'
import { ImageDraftStore, validGeometry, sameGeometry, type PositionedImage } from './imageDrafts.ts'
import { saveEdits, refreshImageDrafts } from './saveEdits.ts'
import { TextDraftStore } from './textDrafts.ts'
import { api, type Session } from './api.ts'
import { useI18n } from './i18n.tsx'

export type ImageGeometry = { x: number; y: number; width: number; height: number; unit: 'emu' | 'pt' }
export type ImageNode = { nodeId: string; assetHash?: string | null; visualHash: string; label?: string; preview?: string; geometry?: ImageGeometry }

export function ImagePanel({ session, revision, disabled, onRevised, nodes, showEmpty = false, emptyMessage, selectedNodeId, onSelected, drafts, page, onSaveGeometry, saveGeometryLabel, showDrafts = true, prepareReplacement }: {
  session: Session
  prepareReplacement?: (image: PositionedImage, revision: number, page?: number) => { commit: (hash: string) => void; finish: () => void }
  revision: number | null
  disabled: boolean
  nodes?: ImageNode[]
  selectedNodeId?: string
  onSelected?: (nodeId: string) => void
  drafts: ImageDraftStore
  showDrafts?: boolean
  page?: number
  saveGeometryLabel?: string
  onSaveGeometry?: (nodeId: string) => Promise<void>
  showEmpty?: boolean
  emptyMessage?: string
  onRevised: (revision: number) => void
}) {
  const { t } = useI18n()
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [images, setImages] = useState<ImageNode[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{nodeId:string;assetHash:string;shared:boolean}|null>(null)

  useEffect(() => {
    if (nodes) { setImages(nodes); return }
    let live = true
    api(session, '/images').then(response => response.json()).then((page: { entries?: ImageNode[]; revision: number }) => {
      if (!live) return
      const entries = page.entries || []
      setImages(entries)
      drafts.reconcile(entries, page.revision)
      setSelected(current => current && entries.some(image => image.nodeId === current) ? current : entries[0]?.nodeId || '')
    }).catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session, revision, nodes, drafts])

  useEffect(() => { if (selectedNodeId) setSelected(selectedNodeId) }, [selectedNodeId])
  const visibleImages = nodes ?? images
  const visibleSelected = visibleImages.some(image => image.nodeId === selected) ? selected : visibleImages[0]?.nodeId || ''

  const selectedImage=visibleImages.find(image=>image.nodeId===visibleSelected)
  const selectedDraft=selectedImage?drafts.get(selectedImage.nodeId):undefined
  const selectedCurrent=selectedImage?.geometry?drafts.currentImage(selectedImage as PositionedImage,revision??0):selectedImage

  async function replace(file: File) {
    if (!visibleSelected || revision === null) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!extension || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) {
      setError(t('imageType'))
      return
    }
    setBusy(true)
    setError('')
    setNotice(null)
    let upload: ReturnType<NonNullable<typeof prepareReplacement>>|undefined
    try {
      if(!selectedImage?.geometry)throw new Error(t('imageGeometryInvalid'))
      upload=prepareReplacement?prepareReplacement(selectedImage as PositionedImage,revision,page):drafts.prepareReplacement(selectedImage as PositionedImage,revision,page)
      const staged = await (await api(session, `/staged-assets?extension=${extension}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      })).json() as { hash: string }
      upload.commit(staged.hash);setNotice({nodeId:visibleSelected,assetHash:staged.hash,shared:true})
    } catch (cause) { setError(String(cause)) }
    finally { upload?.finish();setBusy(false) }
  }

  if (!visibleImages.length && !error) return <>{showEmpty && <p className="presentation-empty-panel">{emptyMessage || t('noSlideImages')}</p>}{showDrafts && <ImageDraftList disabled={disabled} drafts={drafts} />}</>
  return <div className="image-panel">
    {showDrafts && <ImageDraftList disabled={disabled} drafts={drafts} onSelect={id => { setSelected(id); onSelected?.(id) }} />}
    <strong>{t('images')}</strong>
    <select aria-label={t('images')} value={visibleSelected} onChange={event => { setSelected(event.target.value); onSelected?.(event.target.value) }} disabled={busy}>
      {visibleImages.map((image, index) => <option key={image.nodeId} value={image.nodeId}>{t('imageNumber', { count: index + 1 })}{image.label ? ` · ${image.label}` : ''}</option>)}
    </select>
    {selectedDraft?.restoreSource ? <p role="status">{t('imageSourceRestorePending')}</p> : (selectedDraft?.assetHash??selectedCurrent?.assetHash) ? <ImageAssetPreview key={selectedDraft?.assetHash??selectedCurrent?.assetHash} session={session} assetHash={(selectedDraft?.assetHash??selectedCurrent?.assetHash)!} /> : selectedImage?.preview ? <img className="presentation-image-preview" src={selectedImage.preview} alt={t('images')} /> : null}
    <label className={disabled || busy ? 'disabled' : ''}>{busy ? t('replacingImage') : t('replaceImage')}
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={disabled || busy || !!selectedDraft?.collaborationConflict || revision === null} onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void replace(file)
      }} />
    </label>
    {visibleImages.find(image => image.nodeId === visibleSelected)?.geometry && <ImageGeometryPanel key={visibleSelected} session={session} image={visibleImages.find(image => image.nodeId === visibleSelected)!} revision={revision} disabled={disabled || busy} onRevised={onRevised} drafts={drafts} page={page} onSaveGeometry={onSaveGeometry} saveLabel={saveGeometryLabel} />}
    {notice?.nodeId===visibleSelected && (selectedDraft?.assetHash===notice.assetHash || selectedCurrent?.assetHash===notice.assetHash || !notice.shared) && <span role="status">{t(selectedDraft?.assetHash===notice.assetHash?'imageReplacementPending':'imageReplaced')}</span>}
    {error && <span className="export-error" title={error}>{error}</span>}
  </div>
}

function ImageGeometryPanel({ session, image, revision, disabled, onRevised, drafts, page, onSaveGeometry, saveLabel }: {
  session: Session; image: ImageNode; revision: number | null; disabled: boolean; onRevised: (revision: number) => void
  drafts: ImageDraftStore; page?: number; saveLabel?: string; onSaveGeometry?: (nodeId: string) => Promise<void>
}) {
  const { t,locale } = useI18n()
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [error, setError] = useState('')
  const [conflictCount,setConflictCount] = useState(20)
  const draft = drafts.get(image.nodeId)
  const current = drafts.currentImage(image as PositionedImage, revision ?? 0)
  const geometry = draft?.geometry ?? current.geometry
  const factor = geometry.unit === 'emu' ? 12700 : 1
  const busy = drafts.saving
  const valid = validGeometry(geometry)
  const compareGeometry=!!draft?.remote && (!draft.alternatives || draft.alternatives.some(choice=>!sameGeometry(choice.geometry,draft.geometry)))
  return <section className="image-geometry-panel"><strong>{t('positionAndSize')} · pt</strong><div>{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{t(key)}<input type="number" aria-label={t(key)} step="0.5" value={Number.isFinite(geometry[key]) ? Number((geometry[key] / factor).toFixed(2)) : ''} disabled={disabled || draft?.collaborationConflict} aria-invalid={!valid} onChange={event => {
    try { drafts.edit(current, revision ?? 0, { ...geometry, [key]: event.target.value === '' ? NaN : Number(event.target.value) * factor }, page, key); setError('') }
    catch { setError(t('imageCollaborationConflict')) }
  }} /></label>)}</div>
    {!valid && <p role="alert">{t('imageGeometryInvalid')}</p>}
    {draft?.remote && <div className="presentation-conflict" role="alert"><p>{t(draft.collaborationConflict?'imageCollaborationConflict':busy?'fixedSaveUnknown':'imageGeometryConflict')}</p>{!!draft.conflictingFields?.length&&<p>{t('imageConflictingFields',{fields:new Intl.ListFormat(locale,{style:'short',type:'conjunction'}).format(draft.conflictingFields.map(field=>t(field==='assetHash'?'imageResourceField':field)))})} {t('imageFieldChoicesHint')}</p>}{compareGeometry && <dl>{(['x', 'y', 'width', 'height'] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd>{Number((draft.remote!.image.geometry[key] / factor).toFixed(2))} pt</dd></div>)}</dl>}{!draft.alternatives && <><button disabled={disabled || busy} onClick={() => drafts.resolve(image.nodeId, false)}>{t('useRemoteText')}</button><button disabled={disabled || busy || draft.geometry.unit!==draft.remote.image.geometry.unit} onClick={() => drafts.resolve(image.nodeId, true)}>{t('keepLocalText')}</button></>}{draft.alternatives && <details><summary>{t('imageDraftAlternatives')} ({draft.alternatives.length})</summary>{draft.alternatives.slice(0,conflictCount).map((choice,index)=><div key={choice.intentId}>{choice.assetHash && <ImageCandidatePreview session={session} assetHash={choice.assetHash} />}{compareGeometry && <dl>{(['x','y','width','height'] as const).map(key=><div key={key}><dt>{t(key)}</dt><dd>{Number((choice.geometry[key]/factor).toFixed(2))} pt</dd></div>)}</dl>}<button type="button" disabled={disabled || busy} onClick={()=>drafts.resolveVariant(image.nodeId,choice.intentId)}>{t('useImageDraft',{count:index+1})}</button></div>)}{draft.alternatives.length>conflictCount && <button type="button" onClick={()=>setConflictCount(count=>count+20)}>{t('imageDraftAlternatives')}…</button>}</details>}</div>}
    <button disabled={disabled || busy || !draft || !valid || !!draft.remote || draft.deleted || revision === null} onClick={() => {
      if (revision === null) return
      setError('')
      void (onSaveGeometry ? onSaveGeometry(image.nodeId) : saveEdits(session, revision, new TextDraftStore(), drafts, image.nodeId).then(onRevised))
        .catch(cause => { setError(String(cause)); void refreshImageDrafts(session, drafts, onRevised).catch(() => {}) })
    }}>{busy ? t('saving') : saveLabel || t('applyPosition')}</button>{draft && <button disabled={disabled || busy} onClick={() => drafts.discard(image.nodeId)}>{t('discardDraftText')}</button>}{error && <p role="alert">{error}</p>}
  </section>
}

export function ImageDraftList({ drafts, onSelect, disabled = false }: { drafts: ImageDraftStore; disabled?: boolean; onSelect?: (nodeId: string, page?: number) => void }) {
  const { t } = useI18n()
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [error, setError] = useState('')
  if (!drafts.size) return null
  return <details className="inspector-object-list"><summary>{t('unsavedImageCount', { count: drafts.size })}</summary><div>{drafts.entries().map(([id, draft], index) => <div key={id}>
    <button type="button" disabled={!onSelect} onClick={() => onSelect?.(id, draft.page)}>{draft.base.label || t('imageNumber', { count: index + 1 })}</button>
    {draft.deleted && <p role="alert">{t('imageDraftDeleted')}</p>}
    <button type="button" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({geometry:draft.geometry,...(draft.restoreSource?{restoreSource:true}:draft.assetHash?{assetHash:draft.assetHash}:{})})).catch(cause => setError(String(cause))) }}>{t('copyDraftText')}</button>
    <button type="button" disabled={disabled || drafts.saving} onClick={() => drafts.discard(id)}>{t('discardDraftText')}</button>
  </div>)}</div>{error && <p role="alert">{error}</p>}</details>
}

function ImageAssetPreview({session,assetHash}:{session:Session;assetHash:string}) {
  const {t}=useI18n(),[url,setUrl]=useState(''),[error,setError]=useState('')
  useEffect(()=> {
    const controller=new AbortController();let live=true,objectUrl=''
    setUrl('');setError('')
    void (async()=> {
      // Known immutable resources need no staging descriptor. Uncommitted
      // candidates use the authenticated staging endpoint and never token URLs.
      let response=await fetch(`${session.apiUrl||'/v1/documents'}/${encodeURIComponent(session.documentId)}/assets/${assetHash}`,{headers:{Authorization:`Bearer ${session.token}`},signal:controller.signal})
      if(response.status===404)response=await api(session,`/staged-assets/${assetHash}`,{signal:controller.signal})
      if(!response.ok)throw new Error(`${response.status}`)
      const blob=await response.blob();if(!live)return
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)
    })().catch(cause=>{if(live && !controller.signal.aborted)setError(String(cause))})
    return ()=>{live=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[session,assetHash])
  return url?<img className="presentation-image-preview" src={url} alt={t('imagePreview')} />:error?<p role="alert">{t('imagePreviewFailed')}</p>:<p role="status">{t('imagePreviewLoading')}</p>
}
export function ImageCandidatePreview({session,assetHash}:{session:Session;assetHash:string}) {
  const {t}=useI18n(),[open,setOpen]=useState(false)
  return <div><button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{t('imagePreview')}</button>{open && <ImageAssetPreview session={session} assetHash={assetHash} />}</div>
}
