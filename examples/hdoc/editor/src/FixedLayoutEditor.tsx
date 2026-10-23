import { useCallback, useEffect, useMemo, useRef, useState, useId, useSyncExternalStore, type RefObject } from 'react'
import { api, type Session } from './api.ts'
import { EditorIcon } from './EditorIcon.tsx'
import { ExportControl } from './ExportControl.tsx'
import { FlowCanvas } from './FlowCanvas.tsx'
import { FixedPresenceIndicator, useFixedPresence } from './FixedPresence.tsx'
import { PanelResizeHandle } from './PanelResizeHandle.tsx'
import { ImagePanel, ImageDraftList } from './ImagePanel.tsx'
import { createPageLoader, fitSlide, pageDocument, type PageGroup, type PageSize, type RenderedPage } from './fixedPages.ts'
import { LocaleSelect, useI18n, type MessageKey } from './i18n.tsx'
import { TextDraftStore } from './textDrafts.ts'
import { ImageDraftStore, validGeometry } from './imageDrafts.ts'
import type {FixedSaveController} from './fixedSaveController.ts'
import { refreshImageDrafts } from './saveEdits.ts'

type PageLoader = ReturnType<typeof createPageLoader>
type RibbonTab = 'home' | 'view' | 'export'

const pdfMessages: Partial<Record<MessageKey, MessageKey>> = {
  slideContent: 'pageContent', slideThumbnails: 'pageThumbnails', slidePosition: 'pagePosition',
  previousSlide: 'previousPage', nextSlide: 'nextPage', goToSlide: 'goToPage', loadingSlides: 'loadingPages',
  loadingSlide: 'loadingPage', slideCanvas: 'pageCanvas', selectSlideText: 'selectPageText', editSlideText: 'editPageText',
  slideText: 'pageText', slideTextHint: 'pdfDraftHint', noSlideText: 'noPageText', slideImages: 'pageImages',
  slideImagesHint: 'pageImagesHint', noSlideImages: 'noPageImages', fitSlide: 'fitPage',
  slideEditingHint: 'pdfEditingHint', slideNavigationHint: 'pageNavigationHint', slideExportHint: 'pageExportHint',
  draftPreview: 'pendingPageEdits',
}
const flowMessages: Partial<Record<MessageKey, MessageKey>> = {
  ...pdfMessages, slideThumbnails: 'textSections', slidePosition: 'textSectionPosition', previousSlide: 'previousSection', nextSlide: 'nextSection',
  goToSlide: 'goToSection', loadingSlide: 'loadingSection', loadingSlides: 'loadingSections', slideCanvas: 'textSectionCanvas',
  slideEditingHint: 'sectionEditingHint', slideTextHint: 'sectionTextHint', draftPreview: 'draftPreview',
}
function useFixedI18n(format: string) {
  const { locale, t: translate } = useI18n()
  const t = useCallback((key: MessageKey, values?: Record<string, string | number>) => translate((format === 'pdf' ? pdfMessages : format === 'pptx' ? {} : flowMessages)[key] ?? key, values), [translate, format])
  return { locale, t }
}

export function FixedLayoutEditor({ saveController, session, embedded, pages, stylesheet, revision, drafts, imageDrafts, updates, onFullEditor, indexComplete, indexTail, error, onError, onRevised, onClose }: {
  saveController:FixedSaveController;session: Session; embedded: boolean; pages: PageGroup[]; stylesheet: string; revision: number | null; drafts: TextDraftStore; imageDrafts: ImageDraftStore
  onFullEditor?: () => void; updates: import('./api.ts').RevisionConnectionStatus; indexComplete: boolean; indexTail: RefObject<HTMLDivElement | null>; error: string
  onError: (error: string) => void; onRevised: (revision: number) => void; onClose: () => void
}) {
  const { locale, t } = useFixedI18n(session.format)
  useSyncExternalStore(saveController.subscribe,saveController.snapshot)
  const history=saveController.history
  useSyncExternalStore(history.subscribe,history.snapshot)
  const generation = useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [historyReview,setHistoryReview]=useState<{direction:'undo'|'redo';version:number}|null>(null)
  const [tab, setTab] = useState<RibbonTab>('home')
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedImage, setSelectedImage] = useState('')
  const [selectedRun, setSelectedRun] = useState('')
  const [textWindowStart, setTextWindowStart] = useState(0)
  const [flowHeight, setFlowHeight] = useState(1123)
  const [textSearch, setTextSearch] = useState('')
  const [inspector, setInspector] = useState<'text' | 'images' | 'page'>('text')
  const [showSlides, setShowSlides] = useState(true)
  const [showInspector, setShowInspector] = useState(true)
  const [leftWidth, setLeftWidth] = useState(190)
  const [rightWidth, setRightWidth] = useState(270)
  const [focus, setFocus] = useState(false)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [data, setData] = useState<{ key: string; page: RenderedPage } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [layoutStatus, setLayoutStatus] = useState<{ revision: number; needsUpgrade: boolean } | null>(null)
  const [layoutBusy, setLayoutBusy] = useState(false)
  useSyncExternalStore(imageDrafts.subscribe, imageDrafts.snapshot)
  const geometryPending = imageDrafts.size > 0 || imageDrafts.saving
  const saving = useRef(false)
  useEffect(() => {
    if (session.format !== 'pdf') return
    let live = true
    api(session, '/pdf/layout').then(response => response.json()).then((status: { revision: number; needsUpgrade: boolean }) => { if (live) setLayoutStatus(status) }).catch(() => { if (live) setLayoutStatus(null) })
    return () => { live = false }
  }, [session, revision])

  const [status, setStatus] = useState<number | 'saving' | 'failed' | null>(null)
  const slides = useMemo(() => pages.filter(page => page.region !== 'note'), [pages])
  const active = slides.find(page => page.firstSequence === selected) ?? slides[0]
  const activeIndex = active ? slides.indexOf(active) : 0
  const pageKey = active ? active.sequences.join(',') : ''
  const loaded = data?.key === pageKey ? data.page : null
  const meaningfulRuns = loaded?.runs.filter(run => session.format === 'pptx' || run.text.trim().length > 0) ?? []
  const visibleRuns = textSearch ? meaningfulRuns.filter(run => `${run.text} ${drafts.get(run.nodeId)?.text ?? ''}`.toLocaleLowerCase(locale).includes(textSearch.toLocaleLowerCase(locale))) : meaningfulRuns
  const runStart = Math.min(textWindowStart, Math.max(0, visibleRuns.length - 40))
  const loading = !!active && (!loaded || loaded.revision !== revision)
  const collaboration = useFixedPresence(session, active && inspector !== 'page' ? { page: active.firstSequence, nodeId: inspector === 'images' ? selectedImage : selectedRun, kind: inspector === 'images' ? 'image' : 'text' } : null)
  const editable = session.scope === 'write'
  const loader = useMemo(() => createPageLoader(session, locale), [session, locale, retry])
  const fieldPrefix = useId()
  const workspace = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const draftPages = useRef(new Map<string, number>())
  const textFields = useRef(new Map<string, HTMLTextAreaElement>())
  const [viewport, setViewport] = useState<PageSize>({ width: 800, height: 500 })
  const flow = !['pdf', 'pptx'].includes(session.format)
  const size = loaded ? { ...loaded.size, height: flow ? flowHeight : loaded.size.height } : { width: 1280, height: 720 }
  const fit = flow ? Math.max(.1, Math.min(1, (viewport.width - 48) / size.width)) : fitSlide(size, viewport)
  const scale = zoom === 'fit' ? fit : zoom / 100
  const entries = drafts.entries()
  const imageEntries = imageDrafts.entries()
  const pendingCount = drafts.size + imageDrafts.size
  const conflicted = entries.some(([, draft]) => draft.remote || draft.stale) || imageEntries.some(([, draft]) => draft.remote || draft.deleted)
  const invalidGeometry = imageEntries.some(([, draft]) => !validGeometry(draft.geometry))
  const canSave = updates !== 'expired' && updates !== 'unavailable' && editable && (pendingCount > 0||saveController.pending) && !busy && !imageDrafts.uploading && (saveController.pending||(!imageDrafts.saving&&!conflicted&&!invalidGeometry)) && revision !== null
  const frame = useMemo(() => loaded ? pageDocument(loaded, stylesheet, locale,
    new Map(loaded.runs.map(run => [run.nodeId, drafts.get(run.nodeId)?.text ?? drafts.currentRun(run, loaded.revision).text]))) : '',
  [loaded, stylesheet, locale, drafts, generation])

  useEffect(() => {
    if (!active || revision === null || !stylesheet) return
    let live = true
    setLoadError('')
    void loader(active, revision).then(page => {
      if (!live) return
      for (const run of page.runs) draftPages.current.set(run.nodeId, active.firstSequence)
      drafts.reconcile(page.runs, revision)
      imageDrafts.reconcile(page.images, revision)
      setData({ key: pageKey, page })
      setSelectedImage(current => page.images.some(image => image.nodeId === current) ? current : page.images[0]?.nodeId || '')
      setSelectedRun(current => page.runs.some(run => run.nodeId === current) ? current : page.runs.find(run => session.format === 'pptx' || run.text.trim())?.nodeId ?? '')
    }).catch(cause => { if (live) setLoadError(String(cause)) })
    return () => { live = false }
  }, [loader, active, pageKey, revision, drafts, imageDrafts, stylesheet])

  useEffect(() => { setTextSearch(''); setTextWindowStart(0); canvas.current?.scrollTo({ top: 0, left: 0 }) }, [pageKey])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = workspace.current
    if (!element) return
    let compact: boolean | undefined
    const observer = new ResizeObserver(([entry]) => {
      // Background tabs/hidden hosts temporarily have no layout box. Preserve
      // the user's panes until an actual visible viewport can be measured.
      if (entry.contentRect.width < 1) return
      const next = entry.contentRect.width <= 760
      if (compact !== next && next) { setShowInspector(false); setShowSlides(entry.contentRect.width > 480) }
      compact = next
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const navigate = useCallback((direction: number) => {
    const next = slides[activeIndex + direction]
    if (next) { setSelected(next.firstSequence); setLoadError('') }
  }, [slides, activeIndex])

  const save = useCallback(async (onlyImage?: string) => {
    if (updates === 'expired' || updates === 'unavailable' || !editable || saving.current || revision === null) return
    saving.current = true
    setBusy(true)
    setStatus('saving')
    try {
      const next = await saveController.save(revision,onlyImage)
      onRevised(next)
      setStatus(next)
      onError('')
    } catch (cause) {
      setStatus('failed')
      onError(cause instanceof Error && (cause.message === 'draftsNotReady' || cause.message === 'imageUploadPending' || cause.message==='fixedSaveUnknown' || cause.message==='historyBusy') ? t(cause.message) : String(cause))
      void refreshImageDrafts(session, imageDrafts, onRevised).catch(() => {})
    } finally { saving.current = false; setBusy(false) }
  }, [session, drafts, imageDrafts,saveController, editable, revision, updates, onRevised, onError, t])

  const changeHistory = async (direction:'undo'|'redo') => {
    if(!editable||busy||layoutBusy||updates==='expired'||updates==='unavailable')return
    setBusy(true)
    try{
      const result=await history.step(direction)
      onRevised(result.revision);setStatus(null);onError('');setHistoryReview(null)
      if(result.page!==undefined)setSelected(result.page)
      if(result.type==='image'){setSelectedImage(result.nodeId);setInspector('images')}
      else {setSelectedRun(result.nodeId);setTextSearch('');setTextWindowStart(0);setInspector('text')}
      setShowInspector(true);setFocus(false)
    }catch(cause){const key=cause instanceof Error?cause.message:'';if(key==='historyConflict'||key==='historyDeleted')setHistoryReview({direction,version:history.snapshot()});onError(['historyBusy','historyConflict','historyChanged','historyDeleted','historyInvalid','historyEmpty'].includes(key)?t(key as MessageKey):String(cause))}
    finally{setBusy(false)}
  }
  const historyDisabled=!editable||busy||layoutBusy||updates==='expired'||updates==='unavailable'
  const selectRun = (nodeId: string) => {
    setSelectedRun(nodeId)
    setTextSearch('')
    const runIndex = meaningfulRuns.findIndex(run => run.nodeId === nodeId)
    setTextWindowStart(Math.max(0, Math.floor(runIndex / 40) * 40))
    setInspector('text')
    setShowInspector(true)
    setFocus(false)
    // Wait for a hidden inspector to mount before moving focus to its text field.
    requestAnimationFrame(() => textFields.current.get(nodeId)?.focus())
  }
  const upgradeLayout = async () => {
    if (revision === null || drafts.size || geometryPending || layoutBusy || busy || loading) return
    setLayoutBusy(true)
    onError('')
    try {
      const result = await (await api(session, '/pdf/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) })).json() as { revision: number }
      setLayoutStatus({ revision: result.revision, needsUpgrade: false })
      onRevised(result.revision)
    } catch (cause) { onError(String(cause)) }
    finally { setLayoutBusy(false) }
  }
  const openInspector = (kind: 'text' | 'images') => { setInspector(kind); setShowInspector(true); setFocus(false) }
  const jumpToConflict = () => {
    const imageConflict = imageDrafts.entries().find(([, draft]) => draft.remote || draft.deleted)
    if (imageConflict) {
      if (imageConflict[1].page !== undefined) setSelected(imageConflict[1].page)
      setSelectedImage(imageConflict[0]); openInspector('images'); return
    }
    const conflict = drafts.entries().find(([, draft]) => draft.remote || draft.stale)
    const sequence = conflict && (conflict[1].page??draftPages.current.get(conflict[0]))
    if (sequence !== undefined) setSelected(sequence)
    if (conflict) setSelectedRun(conflict[0])
    openInspector('text')
  }
  const total = `${slides.length}${indexComplete ? '' : '+'}`
  return <div ref={workspace} className={`workspace presentation-workspace ${embedded ? 'embedded' : ''} ${focus ? 'presentation-focus' : ''} ${session.format === 'pdf' ? 'pdf-workspace' : flow ? 'flow-workspace' : ''}`} onBlurCapture={()=>history.stopCapturing()} onKeyDownCapture={event=>{
    if(event.nativeEvent.isComposing||event.altKey||!(event.metaKey||event.ctrlKey))return
    if(event.target instanceof HTMLElement&&event.target.closest('input[type="search"]'))return
    const key=event.key.toLowerCase()
    if(key==='z'||key==='y'&&event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();if(!historyDisabled)void changeHistory(key==='y'||event.shiftKey?'redo':'undo')}
  }} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    if (event.key === 'Escape' && focus) setFocus(false)
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,[contenteditable]')) return
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); navigate(1) }
    if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); navigate(-1) }
  }}>
    <header className="presentation-header">
      <div className="presentation-document"><span className="presentation-file-icon">{session.format === 'pdf' ? 'PDF' : flow ? 'W' : 'P'}</span><div><h1 title={session.documentId}>{session.documentId}</h1><span className={`presentation-save-state ${pendingCount ? 'has-drafts' : ''}`} role="status">{imageDrafts.uploading ? t('imageUploadPending') : busy ? t('saving') : saveController.pending?t('fixedSaveUnknown'):pendingCount ? t('unsavedChangesCount', { count: pendingCount }) : t('saved')}{revision !== null && <small> · r{revision}</small>}</span></div></div>
      <div className="presentation-header-actions"><FixedPresenceIndicator peers={collaboration.peers} connected={collaboration.connected && updates === 'connected'} />{(updates === 'expired' || updates === 'unavailable') && <span role="status">{t(updates === 'expired' ? 'revisionSessionExpired' : 'revisionConnectionUnavailable')}</span>}{conflicted && <button className="presentation-conflict-link" onClick={jumpToConflict}>{t('reviewDraftConflict')}</button>}<LocaleSelect /><button className="presentation-icon-button" aria-label={t('close')} title={t('close')} onClick={() => { if (drafts.size || imageDrafts.size || saving.current || imageDrafts.saving || saveController.pending || history.busy) onError(t('saveDraftsFirst')); else onClose() }}><EditorIcon name="close" /></button></div>
    </header>
    <nav className="presentation-tabs" aria-label={t('editorFeatures')}>{(['home', 'view', 'export'] as const).map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{t(item)}</button>)}<span className="presentation-mode">{editable ? t('editable') : t('readOnly')}</span></nav>
    <div className="presentation-ribbon" aria-label={t('toolbar')}>
      <div className="presentation-tool-group presentation-file-actions"><button className="presentation-ribbon-tool" onClick={() => void save()} disabled={!canSave}><EditorIcon name="save" /><span>{busy ? t('saving') : saveController.pending?t('fixedRetrySave'):t('saveAllText')}</span></button><button className="presentation-ribbon-tool" aria-pressed={tab === 'export'} onClick={() => setTab('export')}><EditorIcon name="export" /><span>{t('export')}</span></button><span className="presentation-tool-caption">{t('document')}</span></div>
      <div className="presentation-tool-group"><button className="presentation-ribbon-tool" aria-label={t('undo')} title={t('undo')} disabled={historyDisabled||!history.canUndo} onClick={()=>void changeHistory('undo')}><EditorIcon name="undo"/><span>{t('undo')}</span></button><button className="presentation-ribbon-tool" aria-label={t('redo')} title={t('redo')} disabled={historyDisabled||!history.canRedo} onClick={()=>void changeHistory('redo')}><EditorIcon name="redo"/><span>{t('redo')}</span></button><span className="presentation-tool-caption">{t('editHistory')}</span></div>
      {historyReview&&history.snapshot()===historyReview.version&&<button className="presentation-history-skip" disabled={historyDisabled||history.snapshot()!==historyReview.version} title={t('historySkipHint')} onClick={()=>{try{history.skip(historyReview.direction,historyReview.version);setHistoryReview(null);onError('')}catch(cause){onError(cause instanceof Error&&cause.message==='historyChanged'?t('historyChanged'):String(cause))}}}>{t('historySkip')}</button>}
      {tab === 'home' && <>
        <div className="presentation-tool-group"><button className="presentation-ribbon-tool" onClick={() => openInspector('text')} aria-pressed={showInspector && inspector === 'text'}><EditorIcon name="text" /><span>{t('editSlideText')}</span></button><button className="presentation-ribbon-tool" onClick={() => openInspector('images')} aria-pressed={showInspector && inspector === 'images'}><EditorIcon name="image" /><span>{t('replaceImage')}</span></button><span className="presentation-tool-caption">{t('slideContent')}</span></div>
        <div className="presentation-tool-group"><button className="presentation-ribbon-tool" onClick={() => setZoom('fit')}><EditorIcon name="fit" /><span>{t('fitSlide')}</span></button><button className="presentation-ribbon-tool" onClick={() => setFocus(true)}><EditorIcon name="focus" /><span>{t('focusView')}</span></button><span className="presentation-tool-caption">{t('view')}</span></div>
        <p className="presentation-ribbon-hint">{t('slideEditingHint')}</p>
      </>}
      {tab === 'view' && <>
        {session.format === 'pdf' && layoutStatus?.needsUpgrade && <div className="presentation-tool-group"><button className="presentation-ribbon-tool" disabled={!editable || layoutBusy || busy || loading || drafts.size > 0 || geometryPending || layoutStatus.revision !== revision} title={drafts.size || geometryPending ? t('pdfLayoutDraftHint') : t('pdfLayoutUpgradeHint')} onClick={() => void upgradeLayout()}><EditorIcon name="fit" /><span>{layoutBusy ? t('pdfLayoutUpgrading') : t('pdfLayoutUpgrade')}</span></button><span className="presentation-tool-caption">{t('pageOptions')}</span></div>}

        {onFullEditor && <button className="presentation-full-editor" disabled={pendingCount > 0 || geometryPending || busy || saveController.pending} title={t('fullEditorHint')} onClick={onFullEditor}>{t('fullEditing')}</button>}
        <div className="presentation-tool-group"><button className="presentation-ribbon-tool" aria-pressed={showSlides} onClick={() => setShowSlides(value => !value)}><EditorIcon name="slides" /><span>{t('slideThumbnails')}</span></button><button className="presentation-ribbon-tool" aria-pressed={showInspector} onClick={() => setShowInspector(value => !value)}><EditorIcon name="panel" /><span>{t('properties')}</span></button><span className="presentation-tool-caption">{t('panels')}</span></div>
        <div className="presentation-tool-group"><button className="presentation-ribbon-tool" onClick={() => setZoom('fit')}><EditorIcon name="fit" /><span>{t('fitSlide')}</span></button><button className="presentation-ribbon-tool" onClick={() => setZoom(100)}><span className="presentation-zoom-icon">100%</span><span>{t('actualSize')}</span></button><button className="presentation-ribbon-tool" onClick={() => setFocus(true)}><EditorIcon name="focus" /><span>{t('focusView')}</span></button><span className="presentation-tool-caption">{t('zoom')}</span></div>
        <p className="presentation-ribbon-hint">{t('slideNavigationHint')}</p>
      </>}
      {tab === 'export' && <div className="presentation-export-options"><ExportControl session={session} revision={revision} beforeExport={async () => {
        if (drafts.size || imageDrafts.size || saving.current || imageDrafts.saving || saveController.pending || history.busy) throw new Error(t('saveDraftsFirst'))
        try{await saveController.flush()}catch{/* Backup failure is independently visible. */}
        if(drafts.size||imageDrafts.size||saveController.pending||history.busy)throw new Error(t('saveDraftsFirst'))
        return revision
      }} /><p>{t('slideExportHint')}</p></div>}
    </div>
    <div className={`presentation-body ${showSlides && !focus ? '' : 'slides-hidden'} ${showInspector && !focus ? '' : 'inspector-hidden'}`} style={{ gridTemplateColumns: `${showSlides && !focus ? `${leftWidth}px 5px ` : ''}minmax(0,1fr)${showInspector && !focus ? ` 5px ${rightWidth}px` : ''}` }}>
      <aside className="presentation-slides" aria-label={t('slideThumbnails')} hidden={!showSlides || focus}>
        <div className="presentation-panel-heading"><strong>{t('slideThumbnails')}</strong><span>{total}</span></div>
        <div className="presentation-slide-list">{slides.map((page, index) => flow ? <button key={page.firstSequence} className={`flow-section-button ${active?.firstSequence === page.firstSequence ? 'selected' : ''}`} aria-current={active?.firstSequence === page.firstSequence ? 'page' : undefined} onClick={() => setSelected(page.firstSequence)}>{t('goToSlide', { count: index + 1 })}{(entries.some(([id]) => (drafts.get(id)?.page??draftPages.current.get(id)) === page.firstSequence) || imageEntries.some(([, draft]) => draft.page === page.firstSequence)) && <span>•</span>}</button> : <PageThumbnail format={session.format} key={page.firstSequence} page={page} number={index + 1} revision={revision} loader={loader} stylesheet={stylesheet} dirty={entries.some(([id]) => (drafts.get(id)?.page??draftPages.current.get(id)) === page.firstSequence) || imageEntries.some(([, draft]) => draft.page === page.firstSequence)} selected={active?.firstSequence === page.firstSequence} onSelect={() => setSelected(page.firstSequence)} />)}<div ref={indexTail} className="load-tail" />{!indexComplete && <span className="presentation-index-loading">{t('loadingSlides')}</span>}</div>
      </aside>
      <PanelResizeHandle side="left" width={leftWidth} onResize={setLeftWidth} label={t('resizeNavigation')} hidden={!showSlides || focus} />
      <main className="presentation-center">
        <div className="presentation-canvas-bar"><div><button className="presentation-icon-button" aria-label={t('previousSlide')} disabled={activeIndex === 0} onClick={() => navigate(-1)}><EditorIcon name="left" /></button><span>{t('slidePosition', { current: active ? activeIndex + 1 : 0, total })}</span><button className="presentation-icon-button" aria-label={t('nextSlide')} disabled={activeIndex >= slides.length - 1} onClick={() => navigate(1)}><EditorIcon name="right" /></button></div><span>{loading ? t('loadingSlide') : drafts.size ? t('draftPreview') : t('slideCanvas')}</span></div>
        <div className="presentation-canvas" onClick={event => { const target = event.target as HTMLElement; if (target === event.currentTarget || target.classList.contains('presentation-stage') || target.classList.contains('presentation-stage-space')) { setInspector('page'); setShowInspector(true) } }} ref={canvas} tabIndex={0} aria-label={t('slideCanvas')} aria-busy={loading}>
          {loaded && <div className="presentation-stage-space" style={{ minWidth: Math.ceil(size.width * scale) + 48, minHeight: Math.ceil(size.height * scale) + 48 }}><div className="presentation-stage" style={{ width: size.width * scale, height: size.height * scale }}>
            {flow ? <FlowCanvas srcDoc={frame} width={size.width} height={size.height} scale={scale} selected={inspector === 'images' ? selectedImage : selectedRun} onHeight={setFlowHeight} onSelect={nodeId => { if (!nodeId) { setInspector('page'); setShowInspector(true) } else if (loaded.images.some(image => image.nodeId === nodeId)) { setSelectedImage(nodeId); openInspector('images') } else selectRun(nodeId) }} title={t('slideCanvas')} /> : <iframe sandbox="" title={t('slidePosition', { current: activeIndex + 1, total })} srcDoc={frame} referrerPolicy="no-referrer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }} />}
            <div className="presentation-hit-layer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>{loaded.objects.map((object, index) => <button key={index} className={`presentation-object-hit ${object.nodeIds.includes(object.kind === 'image' ? selectedImage : selectedRun) && showInspector && inspector === (object.kind === 'image' ? 'images' : 'text') && !focus ? 'selected' : ''}`} aria-label={t(object.kind === 'image' ? 'selectImageObject' : 'selectSlideText', { count: index + 1 })} title={object.label || t('pageTextRun', { count: index + 1 })} onClick={() => { if (object.kind === 'image') { setSelectedImage(object.nodeIds[0]); openInspector('images') } else selectRun(object.nodeIds[0]) }} style={{ left: object.x, top: object.y, width: object.width, height: Math.max(object.height, 12), transform: object.transform }} />)}</div>
            <div className="presentation-peer-layer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>{collaboration.others.filter(peer => peer.selection?.page === active.firstSequence).map(peer => {
              const object = loaded.objects.find(object => object.nodeIds.includes(peer.selection!.nodeId))
              return object ? <div key={peer.clientId} style={{ left: object.x, top: object.y, width: object.width, height: Math.max(object.height, 12), borderColor: peer.color }}><span style={{ background: peer.color }}>{peer.name}</span></div> : null
            })}</div>
          </div></div>}
          {!loaded && !loadError && <div className="presentation-empty">{t('loadingSlide')}</div>}
          {loadError && <div className="presentation-load-error" role="alert"><p>{loadError}</p><button onClick={() => setRetry(value => value + 1)}>{t('retry')}</button></div>}
        </div>
        {focus && <button className="presentation-exit-focus" onClick={() => setFocus(false)}><EditorIcon name="focus" />{t('exitFocus')}</button>}
      </main>
      <PanelResizeHandle side="right" width={rightWidth} onResize={setRightWidth} label={t('resizeProperties')} hidden={!showInspector || focus} />
      <aside className="presentation-inspector" hidden={!showInspector || focus} aria-label={t('properties')}>
        <div className="presentation-panel-heading"><strong>{t('properties')}</strong><button className="presentation-icon-button" onClick={() => setShowInspector(false)} aria-label={t('hidePanel')}><EditorIcon name="close" /></button></div>
        <div className="presentation-inspector-tabs"><button aria-pressed={inspector === 'text'} onClick={() => setInspector('text')}><EditorIcon name="text" />{t('textOptions')}</button><button aria-pressed={inspector === 'images'} onClick={() => setInspector('images')}><EditorIcon name="image" />{t('pictureOptions')}</button><button aria-pressed={inspector === 'page'} onClick={() => setInspector('page')}><EditorIcon name="panel" />{t('pageOptions')}</button></div>
        <div className="presentation-inspector-content">
          <ImageDraftList drafts={imageDrafts} onSelect={(id, page) => { if (page !== undefined) setSelected(page); setSelectedImage(id); openInspector('images') }} />
          {invalidGeometry && <p role="alert">{t('imageGeometryInvalid')}</p>}
          {loaded?.approximateText && <p className="presentation-preview-notice" role="status">{t('pdfApproximatePreview')}</p>}
          {entries.filter(([, draft]) => draft.stale).map(([id, draft]) => <div key={id} className="presentation-conflict" role="alert"><p>{t(draft.stale === 'deleted' ? 'draftObjectDeleted' : 'draftNeedsRefresh')}</p><blockquote>{draft.text}</blockquote><button onClick={() => { void navigator.clipboard.writeText(draft.text).catch(cause => onError(String(cause))) }}>{t('copyDraftText')}</button><button disabled={busy} onClick={() => drafts.discard(id)}>{t('discardDraftText')}</button></div>)}
          {inspector === 'text' && <>
            <div className="presentation-section-title"><strong>{t('selectedTextObject')}</strong><span>{t('objectCount', { count: meaningfulRuns.length })}</span></div>
            <details className="inspector-object-list"><summary>{t('browseTextObjects')}</summary>
              <input className="presentation-text-search" type="search" aria-label={t('filterPageText')} placeholder={t('filterPageText')} value={textSearch} onChange={event => { setTextSearch(event.target.value); setTextWindowStart(0) }} />
              <div>{visibleRuns.slice(runStart, runStart + 40).map((run, index) => <button key={run.nodeId} className={selectedRun === run.nodeId ? 'selected' : ''} onClick={() => selectRun(run.nodeId)}><span>{runStart + index + 1}</span><span>{(drafts.get(run.nodeId)?.text ?? run.text).trim() || t('emptyTextObject')}</span>{drafts.get(run.nodeId) && <i />}</button>)}</div>
              {visibleRuns.length > 40 && <div className="text-window-controls"><button disabled={runStart === 0} onClick={() => setTextWindowStart(Math.max(0, runStart - 40))}>{t('previousTextWindow')}</button><span>{t('textWindowRange', { from: runStart + 1, to: Math.min(visibleRuns.length, runStart + 40), total: visibleRuns.length })}</span><button disabled={runStart + 40 >= visibleRuns.length} onClick={() => setTextWindowStart(runStart + 40)}>{t('nextTextWindow')}</button></div>}
            </details>
            {loaded && meaningfulRuns.filter(run => run.nodeId === selectedRun).map(run => {
              const draft = drafts.get(run.nodeId)
              const current = drafts.currentRun(run, loaded.revision)
              const object = loaded.objects.find(object => object.nodeIds.includes(run.nodeId))
              return <div key={run.nodeId} className="selected-object-properties">
                <div className="selected-object-name"><EditorIcon name="text" /><strong>{session.format === 'pptx' && object?.label ? object.label : t('textObject')}</strong>{draft && <span className="presentation-draft-dot" title={t('editing')} />}</div>
                <section className="inspector-property-group"><h3>{t('textContent')}</h3><textarea id={`${fieldPrefix}-${run.nodeId}`} ref={element => { if (element) textFields.current.set(run.nodeId, element); else textFields.current.delete(run.nodeId) }} aria-label={t('selectedTextContent')} value={draft?.text ?? current.text} rows={Math.max(4, Math.min(10, (draft?.text ?? current.text).split('\n').length + 2))} readOnly={!editable} onChange={event => drafts.edit(run, loaded.revision, event.target.value,active?.firstSequence)} /><p>{editable ? t('slideTextHint') : t('readOnlyMode')}</p></section>

                {draft?.remote && !draft.stale && <div className="presentation-conflict" role="alert"><p>{t(saveController.pending?'fixedSaveUnknown':'textDraftConflict')}</p><blockquote>{draft.remote.text}</blockquote><button disabled={saveController.pending||!editable} onClick={() => drafts.resolve(draft.remote!, revision ?? loaded.revision, false)}>{t('useRemoteText')}</button><button disabled={saveController.pending||!editable} onClick={() => drafts.resolve(draft.remote!, revision ?? loaded.revision, true)}>{t('keepLocalText')}</button></div>}
                <details className="inspector-property-group source-text-style"><summary>{t('sourceTextStyle')}</summary><dl><dt>{t('fontFamily')}</dt><dd>{run.font?.family || t('inheritedStyle')}</dd><dt>{t('fontSize')}</dt><dd>{run.font?.sizePt ? `${Number(run.font.sizePt.toFixed(2))} pt` : t('inheritedStyle')}</dd><dt>{t('formatting')}</dt><dd>{[run.font?.bold && t('bold'), run.font?.italic && t('italic')].filter(Boolean).join(' · ') || t('standard')}</dd></dl></details>
              </div>
            })}
            {loaded && !meaningfulRuns.length && <p className="presentation-empty-panel">{t('noSlideText')}</p>}
          </>}
          {inspector === 'page' && <><div className="presentation-section-title"><strong>{t('pageOptions')}</strong></div><dl className="page-property-dimensions"><dt>{t('width')}</dt><dd>{Number((size.width * .75).toFixed(2))} pt</dd>{!flow && <><dt>{t('height')}</dt><dd>{Number((size.height * .75).toFixed(2))} pt</dd></>}</dl><section className="inspector-property-group"><h3>{t('appearance')}</h3><label className="inspector-option"><input type="checkbox" checked={showSlides} onChange={event => setShowSlides(event.target.checked)} />{t('slideThumbnails')}</label><button className="inspector-reset-layout" onClick={() => { setLeftWidth(190); setRightWidth(270); setShowSlides(true); setZoom('fit') }}>{t('resetLayout')}</button></section></>}
          {inspector === 'images' && <><div className="presentation-section-title"><strong>{t('slideImages')}</strong></div><p className="presentation-panel-help">{t('slideImagesHint')}</p>{loaded && <ImagePanel key={pageKey} session={session} revision={revision} disabled={!editable || loading} nodes={loaded.images} showDrafts={false} drafts={imageDrafts} page={active?.firstSequence} onSaveGeometry={async()=>save()} saveGeometryLabel={t('saveAllText')} selectedNodeId={selectedImage} onSelected={setSelectedImage} showEmpty emptyMessage={t('noSlideImages')} onRevised={onRevised} />}</>}
        </div>
      </aside>
    </div>
    <footer className="presentation-statusbar"><div><button className="presentation-icon-button" aria-label={t('slideThumbnails')} aria-pressed={showSlides && !focus} onClick={() => { setShowSlides(value => !value); setFocus(false) }}><EditorIcon name="slides" /></button><span>{t('slidePosition', { current: active ? activeIndex + 1 : 0, total })}</span><span className={pendingCount ? 'has-drafts' : ''} role="status">{saveController.pending&&!busy?t('fixedSaveUnknown'):pendingCount ? t('unsavedChangesCount', { count: pendingCount }) : typeof status === 'number' ? t('changesSavedAt', { revision: status }) : status === 'failed' ? t('saveFailed') : status === 'saving' ? t('saving') : t('saved')}</span></div><div className="presentation-zoom-controls"><button className="presentation-icon-button" aria-label={t('properties')} aria-pressed={showInspector && !focus} onClick={() => { setShowInspector(value => !value); setFocus(false) }}><EditorIcon name="panel" /></button><button className="presentation-fit-button" onClick={() => setZoom('fit')} aria-pressed={zoom === 'fit'} title={t('fitSlide')}><EditorIcon name="fit" /></button><input type="range" aria-label={t('zoom')} min="25" max="200" step="1" value={zoom === 'fit' ? Math.round(fit * 100) : zoom} onChange={event => setZoom(Number(event.target.value))} /><span className="presentation-zoom-value">{Math.round(scale * 100)}%</span><button className="presentation-icon-button" aria-label={t('focusView')} onClick={() => setFocus(value => !value)}><EditorIcon name="focus" /></button></div></footer>
    {error && <div className="presentation-error" role="alert"><span>{error}</span><button className="presentation-icon-button" onClick={() => onError('')} aria-label={t('close')}><EditorIcon name="close" /></button></div>}
  </div>
}

function PageThumbnail({ format, page, number, revision, loader, stylesheet, selected, dirty, onSelect }: {
  format: string; page: PageGroup; number: number; revision: number | null; loader: PageLoader; stylesheet: string; selected: boolean; dirty: boolean; onSelect: () => void
}) {
  const { locale, t } = useFixedI18n(format)
  const marker = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState<RenderedPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [width, setWidth] = useState(150)
  const sequences = page.sequences.join(',')
  useEffect(() => {
    const element = marker.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '200px' })
    const resize = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)))
    observer.observe(element)
    resize.observe(element)
    return () => { observer.disconnect(); resize.disconnect() }
  }, [])
  useEffect(() => {
    if (!visible || revision === null || !stylesheet) { setLoaded(null); return }
    let live = true
    setFailed(false)
    void loader(page, revision).then(value => { if (live) setLoaded(value) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [visible, revision, loader, page, sequences, stylesheet])
  const src = useMemo(() => loaded ? pageDocument(loaded, stylesheet, locale) : '', [loaded, stylesheet, locale])
  const scale = loaded ? width / loaded.size.width : 1
  return <button ref={marker} className={`presentation-thumbnail ${selected ? 'selected' : ''}`} aria-label={t('goToSlide', { count: number })} aria-current={selected ? 'page' : undefined} onClick={onSelect} onKeyDown={event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const sibling = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
    if (sibling instanceof HTMLButtonElement) { event.preventDefault(); sibling.focus(); sibling.click() }
  }}>
    <span className="presentation-thumbnail-number">{number}{dirty && <span className="presentation-thumbnail-draft" title={t('editing')}>•</span>}</span><span className="presentation-thumbnail-frame" style={{ height: loaded ? loaded.size.height * scale : width * 9 / 16 }}>{loaded ? <iframe aria-hidden="true" tabIndex={-1} sandbox="" srcDoc={src} title={t('goToSlide', { count: number })} referrerPolicy="no-referrer" style={{ width: loaded.size.width, height: loaded.size.height, transform: `scale(${scale})` }} /> : <span>{failed ? t('previewUnavailable') : '…'}</span>}</span>
  </button>
}
