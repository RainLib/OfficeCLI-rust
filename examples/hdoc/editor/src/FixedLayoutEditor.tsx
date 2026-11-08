import {wordBodyGroupFromIndex,wordPaperFormat} from './wordPaper.ts'
import {WordPageCanvas} from './WordPageCanvas.tsx'
import {WordPaperOverview} from './WordPaperOverview.tsx'
import {wordRegionSections} from './wordRegions.ts'
import {useWordLayout,WordRegionProperties,wordRegionLabel} from './WordRegionProperties.tsx'
import { useCallback, useEffect, useMemo, useRef, useState, useId, useSyncExternalStore, type RefObject } from 'react'
import { api, type Session } from './api.ts'
import {toggleInput,zoomInput,panelTarget} from './commands/workspace.ts'
import {CommandAction,CommandRibbon,CommandPalette,useCommands,commandMessage} from './commands/react.tsx'
import {commandKeyScope} from './commands/keymap.ts'
import { EditorIcon } from './EditorIcon.tsx'
import { ExportControl } from './ExportControl.tsx'
import { FlowCanvas } from './FlowCanvas.tsx'
import { FixedPresenceIndicator, FixedCollaborationPanel, useFixedPresence, type FixedPeer, type FixedSelection } from './FixedPresence.tsx'
import {useFixedActivity} from './useFixedActivity.ts'
import {fixedActivityKey} from './fixedActivity.ts'
import {fixedFollowCycle,type FixedViewport} from './fixedViewport.ts'
import { PanelResizeHandle } from './PanelResizeHandle.tsx'
import { ImagePanel, ImageDraftList } from './ImagePanel.tsx'
import { createPageLoader, fitSlide, pageDocument, type PageGroup, type PageSize, type RenderedPage } from './fixedPages.ts'
import { LocaleSelect, useI18n, type MessageKey } from './i18n.tsx'
import { TextDraftStore } from './textDrafts.ts'
import { ImageDraftStore, validGeometry } from './imageDrafts.ts'
import type {FixedSaveController} from './fixedSaveController.ts'
import { refreshImageDrafts } from './saveEdits.ts'
import {fixedDocumentHead,verifyFixedDownload} from './fixedExportGuard.ts'

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

export function FixedLayoutEditor({ sourceHash,accessState,saveController, imageTasks, session, embedded, pages, stylesheet, revision, drafts, imageDrafts, updates, onFullEditor, indexComplete, wordStoryGroups, wordStoriesReady, wordIndexFailed, onRetryWordIndex, canResolvePage, resolvePage, pageComplete, indexTail, wordIndex, nextWordGroup, loadWordIndex, error, onError, onBackupFailure, onRevised, onClose }: {
  sourceHash:string
  accessState:import('./liveAccess.ts').LiveAccessState;saveController:FixedSaveController;session: Session; embedded: boolean; pages: PageGroup[]; stylesheet: string; revision: number | null; drafts: TextDraftStore; imageDrafts: ImageDraftStore
  imageTasks:import('./fixedImageTasks.ts').FixedImageTasks|null
  canResolvePage:(sequence:number)=>boolean;resolvePage:(sequence:number,signal?:AbortSignal)=>Promise<PageGroup>;pageComplete:(sequence:number)=>boolean
  nextWordGroup:(sequence:number,region:string|undefined,signal?:AbortSignal)=>Promise<PageGroup|null>;loadWordIndex:()=>Promise<void>
  wordIndex:{groups:()=>PageGroup[];complete:()=>boolean;loadMore:(signal?:AbortSignal)=>Promise<void>}|null
  onFullEditor?: () => void; updates: import('./api.ts').RevisionConnectionStatus; indexComplete: boolean; wordStoryGroups:PageGroup[]|null; wordStoriesReady:boolean; wordIndexFailed:boolean; onRetryWordIndex:()=>void; indexTail: RefObject<HTMLDivElement | null>; error: string
  onError: (error: string) => void; onBackupFailure:()=>void; onRevised: (revision: number) => void; onClose: () => void
}) {
  const { locale, t } = useFixedI18n(session.format)
  const [wordPaperView,setWordPaperView]=useState(true)
  const paperMode=session.flowLayoutVersion===2&&wordPaperView
  const [paperOverview,setPaperOverview]=useState(false),paperButton=useRef<HTMLButtonElement|null>(null)
  const closePaperOverview=()=>{setPaperOverview(false);requestAnimationFrame(()=>paperButton.current?.focus())}
  useEffect(()=>{if(!paperMode)setPaperOverview(false)},[paperMode])
  useSyncExternalStore(saveController.subscribe,saveController.snapshot)
  const history=saveController.history
  useSyncExternalStore(history.subscribe,history.snapshot)
  const generation = useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const [historyReview,setHistoryReview]=useState<{direction:'undo'|'redo';version:number}|null>(null)
  const [tab, setTab] = useState<RibbonTab>('home')
  const [paletteOpen,setPaletteOpen]=useState(false)
  const [,setSelectionVersion]=useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedImage, setSelectedImage] = useState('')
  const [selectedRun, setSelectedRun] = useState('')
  const [textWindowStart, setTextWindowStart] = useState(0)
  const [flowHeight, setFlowHeight] = useState(1123)
  const [textSearch, setTextSearch] = useState('')
  const [inspector, setInspector] = useState<'text' | 'images' | 'page' | 'collaboration'>('text')
  const [following,setFollowing]=useState<number|null>(null)
  const [wordEditingRegion,setWordEditingRegion]=useState<'body'|'header'|'footer'>('body')
  const [wordPageNumber,setWordPageNumber]=useState(1)
  const [wordPageCount,setWordPageCount]=useState(1)
  const [wordPageTarget,setWordPageTarget]=useState<{sequence:number;page:number}|null>(null)
  const [wordTools,setWordTools]=useState<HTMLDivElement|null>(null)
  const [localViewport,setLocalViewport]=useState<FixedViewport|null>(null)
  const [presenceSelection,setPresenceSelection]=useState<FixedSelection|null>(null)
  const [locating,setLocating]=useState<FixedPeer|null>(null)
  const locateOperation=useRef(false),locationRequest=useRef<AbortController|null>(null)
  const [locationLoading,setLocationLoading]=useState<number|null>(null)
  const stopFollowing=()=>{locationRequest.current?.abort();locationRequest.current=null;setLocationLoading(null);setFollowing(null);setLocating(null)}
  const [showSlides, setShowSlides] = useState(session.flowLayoutVersion!==2)
  useEffect(()=>{if(paperMode)setShowSlides(false)},[paperMode])
  const [showInspector, setShowInspector] = useState(session.flowLayoutVersion!==2)
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
  const exportState=useRef({revision,accessState,updates,layoutBusy,mounted:true})
  exportState.current={revision,accessState,updates,layoutBusy,mounted:true}
  useEffect(()=>()=>{exportState.current.mounted=false},[])
  const exportBlocked=()=>!exportState.current.mounted||exportState.current.accessState==='revoked'||exportState.current.accessState==='unavailable'||exportState.current.updates==='expired'||drafts.size>0||imageDrafts.size>0||imageDrafts.uploading||imageDrafts.saving||saving.current||saveController.busy||saveController.pending||history.busy||exportState.current.layoutBusy||(session.scope==='write'&&(!imageTasks||imageTasks.pending))
  useEffect(() => {
    if (session.format !== 'pdf') return
    let live = true
    api(session, '/pdf/layout').then(response => response.json()).then((status: { revision: number; needsUpgrade: boolean }) => { if (live) setLayoutStatus(status) }).catch(() => { if (live) setLayoutStatus(null) })
    return () => { live = false }
  }, [session, revision])

  const [status, setStatus] = useState<number | 'saving' | 'failed' | null>(null)
  const slides = useMemo(() => pages.filter(page => page.region !== 'note' && (!paperMode || page.region==='body')), [pages,paperMode])
  const active = slides.find(page => page.firstSequence === selected) ?? slides[0]
  const presencePage=useRef({sequence:active?.firstSequence,page:wordPageNumber})
  useEffect(()=>{
    const next={sequence:active?.firstSequence,page:wordPageNumber},previous=presencePage.current
    presencePage.current=next
    if(previous.sequence!==next.sequence||previous.page!==next.page)setPresenceSelection(null)
  },[active?.firstSequence,wordPageNumber])
  const nextNavigation=useRef<AbortController|null>(null)
  const navigationContext=useRef({sequence:active?.firstSequence,revision,session});navigationContext.current={sequence:active?.firstSequence,revision,session}
  useEffect(()=>()=>{nextNavigation.current?.abort()},[session,revision])
  const activeIndex = active ? slides.indexOf(active) : 0
  const pageKey = active ? active.sequences.join(',') : ''
  const loaded = data?.key === pageKey ? data.page : null
  const meaningfulRuns = loaded?.runs.filter(run => session.flowLayoutVersion!==undefined || session.format === 'pptx' || session.format === 'pdf' || run.text.trim().length > 0) ?? []
  const visibleRuns = textSearch ? meaningfulRuns.filter(run => `${run.text} ${drafts.get(run.nodeId)?.text ?? ''}`.toLocaleLowerCase(locale).includes(textSearch.toLocaleLowerCase(locale))) : meaningfulRuns
  const runStart = Math.min(textWindowStart, Math.max(0, visibleRuns.length - 40))
  const loading = !!active && (!loaded || loaded.revision !== revision)
  const wordLayout=useWordLayout(session,revision)
  const [wordPreviewSection,setWordPreviewSection]=useState<number|null>(null)
  const wordUses=wordLayout.state&&typeof wordLayout.state==='object'&&loaded?.wordRegion?wordRegionSections(wordLayout.state.layout,loaded.wordRegion):[]
  const publishedSection=loaded?.wordRegion?.kind==='body'?wordUses[0]?.section:undefined
  const publishedViewport=useMemo(()=>{
    if(!localViewport)return null
    if(paperMode&&(!active||localViewport.page!==active.firstSequence||!loaded||loaded.revision!==revision))return null
    return {...localViewport,...(paperMode?{wordPage:wordPageNumber,pageNumber:wordPageNumber,...(publishedSection===undefined?{}:{wordSection:publishedSection})}:{}),...(following===null?{}:{following})}
  },[localViewport,following,wordPageNumber,paperMode,active?.firstSequence,loaded,revision,publishedSection])
  const collaboration = useFixedPresence(session,presenceSelection,accessState==='revoked',publishedViewport)
  const previewWordSection=wordUses.find(use=>use.section===wordPreviewSection)??wordUses[0]
  const wordPage=wordLayout.state&&typeof wordLayout.state==='object'&&previewWordSection?wordLayout.state.layout.sections[previewWordSection.section-1].page:undefined
  const activity=useFixedActivity(session,collaboration.others,revision,inspector==='collaboration'&&showInspector&&accessState!=='revoked')
  const followed=collaboration.others.find(peer=>peer.clientId===following&&peer.id!==collaboration.localId)
  const canLocate=(peer:FixedPeer)=>!!peer.viewport&&canResolvePage(peer.viewport.page)&&(peer.viewport.revision===undefined||peer.viewport.revision===revision)
  const locationContext=useRef({resolvePage,canLocate,revision,onError,t});locationContext.current={resolvePage,canLocate,revision,onError,t}
  const prepareLocation=async(peer:FixedPeer,once:boolean)=>{
    locationRequest.current?.abort();const request=new AbortController();locationRequest.current=request;setLocationLoading(peer.clientId)
    const context=locationContext.current
    try{
      if(!context.canLocate(peer))throw new Error('fixedLocationUnavailable')
      const target=once&&peer.selection?.nodeId?peer.selection.page:peer.viewport!.page
      let group=await context.resolvePage(target,request.signal)
      if(paperMode&&wordLayout.state&&typeof wordLayout.state==='object'){
        if(!wordIndex)throw new Error('fixedLocationUnavailable')
        if(group.region!=='body'&&peer.viewport?.page!==undefined)await context.resolvePage(peer.viewport.page,request.signal)
        group=await wordBodyGroupFromIndex(group,context.revision!,wordLayout.state.layout,wordIndex.groups,wordIndex.complete,wordIndex.loadMore,loader,peer.viewport?.page,request.signal)
      }
      if(group.region==='note')throw new Error('fixedLocationUnavailable')
      if(request.signal.aborted||locationRequest.current!==request||locationContext.current.revision!==context.revision)return
      locateOperation.current=once;setLocating({...peer,viewport:{...peer.viewport!,page:group.firstSequence}})
    }catch{if(!request.signal.aborted&&locationRequest.current===request){setFollowing(null);context.onError(context.t('fixedLocationUnavailable'))}}
    finally{if(locationRequest.current===request){locationRequest.current=null;setLocationLoading(null)}}
  }
  useEffect(()=>{stopFollowing();return()=>{locationRequest.current?.abort();locationRequest.current=null}},[session.documentId,session.token,revision])
  useEffect(()=>{
    if(inspector==='collaboration'||paperMode)return
    setPresenceSelection(active&&(inspector==='text'||inspector==='images')?{page:active.firstSequence,nodeId:inspector==='images'?selectedImage:selectedRun,kind:inspector==='images'?'image':'text'}:null)
  },[active?.firstSequence,inspector,selectedImage,selectedRun,paperMode])
  useEffect(()=>{
    if(following!==null&&(!collaboration.connected||!followed||collaboration.clientId===null||fixedFollowCycle(collaboration.peers,collaboration.clientId,following))){stopFollowing()}
  },[following,followed,collaboration.connected,collaboration.clientId,collaboration.peers])
  const followedPosition=JSON.stringify(followed?.viewport??null)
  useEffect(()=>{if(followed?.viewport)void prepareLocation(followed,false)},[following,followedPosition])
  const locatePeer=(peer:FixedPeer)=>{stopFollowing();if(canLocate(peer))void prepareLocation(peer,true)}
  const followPeer=(peer:FixedPeer)=>{if(canLocate(peer)&&collaboration.clientId!==null&&!fixedFollowCycle(collaboration.peers,collaboration.clientId,peer.clientId)){stopFollowing();setFollowing(peer.clientId)}}
  const editable = session.scope === 'write'&&accessState!=='revoked'&&accessState!=='read'
  const loader = useMemo(() => createPageLoader(session, locale), [session, locale, retry])
  const fieldPrefix = useId()
  const workspace = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const draftPages = useRef(new Map<string, number>())
  const textFields = useRef(new Map<string, HTMLTextAreaElement>())
  const [viewport, setViewport] = useState<PageSize>({ width: 800, height: 500 })
  const flow = !['pdf', 'pptx'].includes(session.format)
  const size = loaded ? { ...loaded.size,...(wordPage?.widthTwips?{width:wordPage.widthTwips/15}:{}), height: flow ? flowHeight : loaded.size.height } : { width: 1280, height: 720 }
  const wordFitWidth=wordLayout.state&&typeof wordLayout.state==='object'?Math.max(...wordLayout.state.layout.sections.map(section=>(section.page.widthTwips??11906)/15)):size.width
  const fit = flow ? Math.max(.1, Math.min(1, (viewport.width - 48) / (paperMode?wordFitWidth:size.width))) : fitSlide(size, viewport)
  const scale = zoom === 'fit' ? fit : zoom / 100
  useEffect(()=>{
    const element=canvas.current;if(!element||!active)return
    let timer:ReturnType<typeof setTimeout>|undefined,closed=false
    const publish=()=>{timer=undefined;if(closed)return;const value:FixedViewport={version:1,page:active.firstSequence,pageNumber:activeIndex+1,...(loaded?.revision!==undefined?{revision:loaded.revision}:revision!==null?{revision}:{}),x:Math.min(1,Math.max(0,element.scrollLeft/Math.max(1,element.scrollWidth-element.clientWidth))),y:Math.min(1,Math.max(0,element.scrollTop/Math.max(1,element.scrollHeight-element.clientHeight)))};setLocalViewport(previous=>JSON.stringify(previous)===JSON.stringify(value)?previous:value)}
    const schedule=()=>{if(!timer)timer=setTimeout(publish,150)}
    const observer=new ResizeObserver(schedule);observer.observe(element)
    element.addEventListener('scroll',schedule,{passive:true});schedule()
    return()=>{closed=true;clearTimeout(timer);observer.disconnect();element.removeEventListener('scroll',schedule)}
  },[active?.firstSequence,activeIndex,pageKey,loaded,scale,flowHeight,revision])
  useEffect(()=>{
    const target=locating?.viewport;if(!target)return
    if(!slides.some(page=>page.firstSequence===target.page))return
    if(active?.firstSequence!==target.page){setSelected(target.page);return}
    if(!loaded||loading)return
    const frame=requestAnimationFrame(()=>{const element=canvas.current;if(!element)return
      const object=locateOperation.current&&locating.selection?.page===target.page?loaded.objects.find(object=>object.nodeIds.includes(locating.selection!.nodeId)):undefined
      const stage=element.querySelector('.presentation-stage')
      if(object&&stage){const box=element.getBoundingClientRect(),position=stage.getBoundingClientRect();element.scrollTo({left:element.scrollLeft+position.left-box.left+(object.x+object.width/2)*scale-element.clientWidth/2,top:element.scrollTop+position.top-box.top+(object.y+object.height/2)*scale-element.clientHeight/2,behavior:'auto'})}
      else element.scrollTo({left:target.x*Math.max(0,element.scrollWidth-element.clientWidth),top:target.y*Math.max(0,element.scrollHeight-element.clientHeight),behavior:'auto'})})
    return()=>cancelAnimationFrame(frame)
  },[locating,active?.firstSequence,slides,loaded,loading,scale,viewport.width,viewport.height,flowHeight])
  const entries = drafts.entries()
  const imageEntries = imageDrafts.entries()
  const pendingCount = drafts.size + imageDrafts.size
  const conflicted = entries.some(([, draft]) => draft.remote || draft.stale) || imageEntries.some(([, draft]) => draft.remote || draft.deleted)
  const invalidGeometry = imageEntries.some(([, draft]) => !validGeometry(draft.geometry))
  const canSave = accessState!=='unavailable' && updates !== 'expired' && updates !== 'unavailable' && (editable||saveController.pending) && (pendingCount > 0||saveController.pending) && !busy && !imageDrafts.uploading && (session.scope!=='write'||!!imageTasks&&!imageTasks.pending) && (saveController.pending||(!imageDrafts.saving&&!conflicted&&!invalidGeometry)) && revision !== null
  const frame = useMemo(() => loaded ? pageDocument(loaded, stylesheet, locale,
    new Map(loaded.runs.map(run => [run.nodeId, drafts.get(run.nodeId)?.text ?? drafts.currentRun(run, loaded.revision).text]))) : '',
  [loaded, stylesheet, locale, drafts, generation])
  const pdfPreviewChanged=session.format==='pdf'&&!!loaded?.runs.some(run=>(drafts.get(run.nodeId)?.text??drafts.currentRun(run,loaded.revision).text)!==run.text)

  useEffect(() => {
    if (!active || revision === null || !stylesheet) return
    if(!pageComplete(active.firstSequence)){const controller=new AbortController();void resolvePage(active.firstSequence,controller.signal).catch(cause=>{if(!controller.signal.aborted)setLoadError(t('fixedLocationUnavailable'))});return()=>controller.abort()}
    let live = true
    setLoadError('')
    void loader(active, revision).then(page => {
      if (!live) return
      for (const run of page.runs) draftPages.current.set(run.nodeId, active.firstSequence)
      drafts.reconcile(page.runs, revision)
      imageDrafts.reconcile(page.images, revision)
      setData({ key: pageKey, page })
      setSelectedImage(current => page.images.some(image => image.nodeId === current) ? current : page.images[0]?.nodeId || '')
      setSelectedRun(current => page.runs.some(run => run.nodeId === current) ? current : page.runs.find(run => session.flowLayoutVersion!==undefined || session.format === 'pptx' || session.format === 'pdf' || run.text.trim())?.nodeId ?? '')
    }).catch(cause => { if (live) setLoadError(String(cause)) })
    return () => { live = false }
  }, [loader, active, pageKey, revision, drafts, imageDrafts, stylesheet,pageComplete,resolvePage])

  useEffect(() => { setTextSearch(''); setTextWindowStart(0); canvas.current?.scrollTo({ top: 0, left: 0 }) }, [pageKey])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {if(entry.contentRect.width>0&&entry.contentRect.height>0)setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })})
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
      if (compact !== next && next) {
        setShowInspector(false)
        // Word navigation is opt-in. A host resize must not open it again
        // after the reader has returned to the paper view.
        setShowSlides(session.flowLayoutVersion !== 2 && entry.contentRect.width > 480)
      }
      compact = next
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [session.flowLayoutVersion])

  const navigate = useCallback((direction: number) => {
    nextNavigation.current?.abort()
    const next = slides[activeIndex + direction]
    if (next) { setSelected(next.firstSequence); setLoadError('') }
    else if(direction>0&&session.flowLayoutVersion===2&&!indexComplete&&active){
      nextNavigation.current?.abort();const controller=new AbortController();nextNavigation.current=controller
      const start=active.firstSequence,sourceRevision=revision,sourceSession=session
      void nextWordGroup(start,paperMode?'body':undefined,controller.signal).then(group=>{if(group&&!controller.signal.aborted&&navigationContext.current.sequence===start&&navigationContext.current.revision===sourceRevision&&navigationContext.current.session===sourceSession){setSelected(group.firstSequence);if(paperMode)setWordPageTarget({sequence:group.firstSequence,page:1});setLoadError('')}}).catch(()=>{})
    }
  }, [slides, activeIndex,session,indexComplete,active,revision,nextWordGroup,paperMode])

  const save = useCallback(async (onlyImage?: string) => {
    if (accessState==='unavailable'||updates === 'expired' || updates === 'unavailable' || (!editable&&!saveController.pending) || saving.current || revision === null) return
    saving.current = true
    setBusy(true)
    setStatus('saving')
    try {
      if(session.scope==='write'&&!imageTasks)throw new Error('imageUploadPending')
      const next = session.scope==='write'?await imageTasks!.withClear(()=>saveController.save(revision,onlyImage,!editable)):await saveController.save(revision,onlyImage,!editable)
      onRevised(next)
      setStatus(next)
      onError('')
    } catch (cause) {
      setStatus('failed')
      onError(cause instanceof Error && (cause.message === 'draftsNotReady' || cause.message === 'imageUploadPending' || cause.message==='fixedSaveUnknown' || cause.message==='historyBusy' || cause.message==='accessRevoked') ? t(cause.message) : String(cause))
      void refreshImageDrafts(session, imageDrafts, onRevised).catch(() => {})
    } finally { saving.current = false; setBusy(false) }
  }, [session, drafts, imageDrafts,saveController,imageTasks, editable, revision, updates,accessState, onRevised, onError, t])

  const changeHistory = async (direction:'undo'|'redo') => {
    if(!editable||busy||layoutBusy||updates==='expired'||updates==='unavailable')return
    setBusy(true)
    try{
      const result=await history.step(direction)
      onRevised(result.revision);setStatus(null);onError('');setHistoryReview(null)
      if(paperMode){if(result.page!==undefined&&wordLayout.state&&typeof wordLayout.state==='object'){if(!wordIndex)throw new Error('fixedLocationUnavailable');const group=await resolvePage(result.page);const body=await wordBodyGroupFromIndex(group,result.revision,wordLayout.state.layout,wordIndex.groups,wordIndex.complete,wordIndex.loadMore,loader,active?.firstSequence);setSelected(body.firstSequence);if(group.region==='body'||group.region==='header'||group.region==='footer')setWordEditingRegion(group.region)}setPresenceSelection(result.page!==undefined?{page:result.page,nodeId:result.nodeId,kind:result.type==='image'?'image':'text'}:null);setStatus(null);return}
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
      const request=async()=>await (await api(session, '/pdf/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) })).json() as { revision: number }
      if(session.scope==='write'&&!imageTasks)throw new Error(t('imageUploadPending'))
      const result=session.scope==='write'?await imageTasks!.withClear(request):await request()
      setLayoutStatus({ revision: result.revision, needsUpgrade: false })
      onRevised(result.revision)
    } catch (cause) { onError(String(cause)) }
    finally { setLayoutBusy(false) }
  }
  const lastPaperBody=useRef<number|undefined>(undefined)
  useEffect(()=>{if(paperMode&&active?.region==='body')lastPaperBody.current=active.firstSequence},[paperMode,active?.firstSequence])
  const changeWordView=async()=>{
    if(paperMode){setWordPaperView(false);setShowInspector(true);setShowSlides(true);return}
    if(!active||revision===null||!wordLayout.state||typeof wordLayout.state!=='object')return
    try{if(!wordIndex)throw new Error('fixedLocationUnavailable');if(active.region!=='body'&&lastPaperBody.current!==undefined&&canResolvePage(lastPaperBody.current))await resolvePage(lastPaperBody.current);const body=await wordBodyGroupFromIndex(active,revision,wordLayout.state.layout,wordIndex.groups,wordIndex.complete,wordIndex.loadMore,loader,lastPaperBody.current);setSelected(body.firstSequence);if(body.firstSequence!==lastPaperBody.current)setWordPageNumber(1);if(['body','header','footer'].includes(active.region))setWordEditingRegion(active.region as 'body'|'header'|'footer');setWordPaperView(true);setShowInspector(false)}catch(cause){onError(String(cause))}
  }
  const openInspector = (kind: 'text' | 'images') => { setInspector(kind); setShowInspector(true); setFocus(false) }
  const jumpToConflict = () => {
    if(paperMode){setShowInspector(false);canvas.current?.scrollTo({top:0});return}
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
  const commands=useCommands(instanceId=>{
    const run=loaded?.runs.find(run=>run.nodeId===selectedRun),draft=run&&drafts.get(run.nodeId),field=textFields.current.get(selectedRun)
    const text=run?(draft?.text??drafts.currentRun(run,loaded!.revision).text):''
    const from=field?.selectionStart??text.length,to=field?.selectionEnd??from
    return{instanceId,documentId:session.documentId,format:session.format,profile:'fixed',locale,platform:/Mac|iPhone|iPad/.test(navigator.platform)?'mac':'other',ready:!!loaded&&!loading&&revision!==null,readOnly:!editable,historical:false,revision,
      selection:{kind:inspector==='text'&&run?'text':inspector==='images'&&selectedImage?'object':'none',empty:from===to,anchor:JSON.stringify([pageKey,inspector,selectedRun,selectedImage,from,to,generation,revision]),from,to,text:text.slice(from,to).slice(0,4096),nodeId:inspector==='images'?selectedImage:selectedRun,protected:!!(draft?.remote||draft?.stale),parentTypes:[]},
      capabilities:{text:!!run,blocks:false,images:true,customNodes:false,mentions:false,ai:false},
      actions:{
        'view.properties':{enabled:true,active:showInspector&&!focus&&inspector!=='collaboration'},
        'view.collaboration':{enabled:accessState!=='revoked',active:showInspector&&!focus&&inspector==='collaboration'},
        'view.navigation':{enabled:true,active:showSlides&&!focus},
        'view.fit':{enabled:true,active:zoom==='fit'},'view.actualSize':{enabled:true,active:zoom===100},
        'view.zoom.set':{enabled:true},'view.focus':{enabled:true,active:focus},'view.panel.close':{enabled:showInspector&&!focus},
        'file.save':{enabled:canSave},'file.export':{enabled:revision!==null,active:tab==='export'},'edit.undo':{enabled:!historyDisabled&&history.canUndo},'edit.redo':{enabled:!historyDisabled&&history.canRedo},'editor.palette':{enabled:true,active:paletteOpen},'text.insert':{enabled:!paperMode&&!!run&&inspector==='text'&&!loading&&!draft?.remote&&!draft?.stale}},
    }
  },(id,input,signal)=>{
    if(signal.aborted)return false
    if(id==='view.properties'||id==='view.collaboration'){
      const current=showInspector&&!focus?inspector:null,target=id==='view.collaboration'?'collaboration':inspector==='collaboration'?'text':inspector
      const next=panelTarget(input===undefined?undefined:toggleInput(id,input,false),current,target)
      if(next!==current){if(next===null)setShowInspector(false);else{setInspector(next);setShowInspector(true);setFocus(false)}}return true
    }
    if(id==='view.navigation'){const open=toggleInput(id,input,showSlides&&!focus);setShowSlides(open);if(open)setFocus(false);return true}
    if(id==='view.fit'){setZoom('fit');return true}
    if(id==='view.actualSize'){setZoom(100);return true}
    if(id==='view.zoom.set'){setZoom(zoomInput(input,'fixed'));return true}
    if(id==='view.focus'){setFocus(toggleInput(id,input,focus));return true}
    if(id==='view.panel.close'){setShowInspector(false);return true}
    if(id==='file.save')return save()
    if(id==='file.export'){setTab('export');return true}
    if(id==='edit.undo'||id==='edit.redo')return changeHistory(id==='edit.undo'?'undo':'redo')
    if(id==='editor.palette'){setPaletteOpen(value=>!value);return true}
    if(id==='text.insert'){
      stopFollowing()
      const text=(input as {text?:unknown})?.text,run=loaded?.runs.find(run=>run.nodeId===selectedRun)
      if(typeof text!=='string'||!text.length||text.length>1_000_000||!run||!loaded)throw new Error(t('commandUnavailable'))
      const field=textFields.current.get(selectedRun),current=drafts.get(run.nodeId)?.text??drafts.currentRun(run,loaded.revision).text
      const from=Math.min(field?.selectionStart??current.length,current.length),to=Math.min(field?.selectionEnd??from,current.length)
      const next=current.slice(0,from)+text+current.slice(to)
      history.stopCapturing()
      try{drafts.edit(run,loaded.revision,next,active?.firstSequence)}finally{history.stopCapturing()}
      requestAnimationFrame(()=>{if(field?.isConnected&&field.value===next){field.focus();field.setSelectionRange(from+text.length,from+text.length);setSelectionVersion(value=>value+1)}})
      return true
    }
    throw new Error(t('commandUnavailable'))
  },cause=>onError(commandMessage(cause)?t(commandMessage(cause)!):String(cause)))
  const total = `${slides.length}${indexComplete ? '' : '+'}`
  const setPaperCount=useCallback((count:number)=>{setWordPageCount(count)},[])
  const selectSection=(sequence:number)=>{nextNavigation.current?.abort();stopFollowing();setSelected(sequence);if(paperMode){setWordPageTarget({sequence,page:1});setWordPageNumber(1)}}
  const turnWordPage=(direction:number)=>{nextNavigation.current?.abort();stopFollowing();const next=wordPageNumber+direction;if(next>=1&&next<=wordPageCount){setWordPageTarget({sequence:active.firstSequence,page:next});return}const group=slides[activeIndex+direction];if(group){setSelected(group.firstSequence);setWordPageTarget({sequence:group.firstSequence,page:direction<0?-1:1})}else if(direction>0)navigate(direction)}
  const paperWidth=(wordPage?.widthTwips??11906)/15,paperHeight=(wordPage?.heightTwips??16838)/15
  const paperFormat=wordPaperFormat(paperWidth,paperHeight),paperOrientation=t(paperWidth>paperHeight?'wordLandscape':'wordPortrait'),paperNumber=new Intl.NumberFormat(locale,{maximumFractionDigits:1})
  const paperDescription=`${paperNumber.format(paperWidth*25.4/96)} × ${paperNumber.format(paperHeight*25.4/96)} mm · ${paperOrientation}`
  return <div ref={workspace} className={`workspace presentation-workspace ${embedded ? 'embedded' : ''} ${focus ? 'presentation-focus' : ''} ${session.format === 'pdf' ? 'pdf-workspace' : flow ? 'flow-workspace' : ''}`} onBlurCapture={()=>history.stopCapturing()} onPointerDownCapture={stopFollowing} onWheelCapture={stopFollowing} onTouchStartCapture={stopFollowing} onBeforeInputCapture={stopFollowing} onKeyDownCapture={event=>{
    stopFollowing()
    if(commands.registry.handleKey(event.nativeEvent,commandKeyScope(event.target))){event.preventDefault();event.stopPropagation()}
  }} onKeyDown={event => {
    if (event.key === 'Escape' && focus) commands.run('view.focus',{enabled:false})
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,[contenteditable]')) return
    if (event.key === 'ArrowDown' || event.key === 'PageDown') { event.preventDefault(); navigate(1) }
    if (event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); navigate(-1) }
  }}>
    {commands.error&&<div className="local-draft-warning" role="alert">{t('commandConfigurationError')}</div>}
    <header className="presentation-header">
      <div className="presentation-document"><span className="presentation-file-icon">{session.format === 'pdf' ? 'PDF' : flow ? 'W' : 'P'}</span><div><h1 title={session.documentId}>{session.documentId}</h1><span className={`presentation-save-state ${pendingCount ? 'has-drafts' : ''}`} role="status">{imageDrafts.uploading ? t('imageUploadPending') : busy ? t('saving') : saveController.pending?t('fixedSaveUnknown'):pendingCount ? t('unsavedChangesCount', { count: pendingCount }) : t('saved')}{revision !== null && <small> · r{revision}</small>}</span></div></div>
      <div className="presentation-header-actions"><FixedPresenceIndicator open={showInspector&&!focus&&inspector==='collaboration'} onOpen={()=>commands.run('view.collaboration')} inactive={accessState==='revoked'} peers={collaboration.peers} connected={collaboration.connected && updates === 'connected'} />{(updates === 'expired' || updates === 'unavailable') && <span role="status">{t(updates === 'expired' ? 'revisionSessionExpired' : 'revisionConnectionUnavailable')}</span>}{conflicted && !busy && <button className="presentation-conflict-link" onClick={jumpToConflict}>{t('reviewDraftConflict')}</button>}<LocaleSelect /><button className="presentation-icon-button" aria-label={t('close')} title={t('close')} onClick={() => { if(accessState==='revoked'){onClose();return}if (drafts.size || imageDrafts.size || saving.current || imageDrafts.saving || saveController.pending || history.busy) onError(t('saveDraftsFirst')); else onClose() }}><EditorIcon name="close" /></button></div>
    </header>
    <nav className="presentation-tabs" aria-label={t('editorFeatures')}>{(['home', 'view', 'export'] as const).map(item => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{t(item)}</button>)}<span className="presentation-mode">{editable ? t('editable') : t('readOnly')}</span></nav>
    <div className="presentation-ribbon" aria-label={t('toolbar')}>
      <div className="presentation-tool-group presentation-file-actions"><button className="presentation-ribbon-tool" onClick={() => commands.run('file.save')} disabled={!commands.registry.item('file.save')?.enabled}><EditorIcon name="save" /><span>{busy ? t('saving') : saveController.pending?t('fixedRetrySave'):t('saveAllText')}</span></button><button className="presentation-ribbon-tool" aria-pressed={tab === 'export'} onClick={() => commands.run('file.export')} disabled={!commands.registry.item('file.export')?.enabled}><EditorIcon name="export" /><span>{t('export')}</span></button><span className="presentation-tool-caption">{t('document')}</span></div>
      <div className="presentation-tool-group"><button className="presentation-ribbon-tool" aria-label={t('undo')} title={t('undo')} disabled={!commands.registry.item('edit.undo')?.enabled} onClick={()=>commands.run('edit.undo')}><EditorIcon name="undo"/><span>{t('undo')}</span></button><button className="presentation-ribbon-tool" aria-label={t('redo')} title={t('redo')} disabled={!commands.registry.item('edit.redo')?.enabled} onClick={()=>commands.run('edit.redo')}><EditorIcon name="redo"/><span>{t('redo')}</span></button><span className="presentation-tool-caption">{t('editHistory')}</span></div>
      <CommandRibbon registry={commands.registry} run={commands.run} tab={tab} customOnly workspaceViews/>
      {historyReview&&history.snapshot()===historyReview.version&&<button className="presentation-history-skip" disabled={historyDisabled||history.snapshot()!==historyReview.version} title={t('historySkipHint')} onClick={()=>{try{history.skip(historyReview.direction,historyReview.version);setHistoryReview(null);onError('')}catch(cause){onError(cause instanceof Error&&cause.message==='historyChanged'?t('historyChanged'):String(cause))}}}>{t('historySkip')}</button>}
      {paperMode&&<div className="presentation-tool-group" ref={setWordTools}/>}
      {tab === 'home' && <>
        <div className="presentation-tool-group">{session.flowLayoutVersion===2&&<button className="presentation-ribbon-tool" disabled={loading||busy} onClick={()=>void changeWordView()}>{t(paperMode?'wordRegionView':'wordPaperView')}</button>}<button className="presentation-ribbon-tool" onClick={() => {if(paperMode){setWordEditingRegion('body');setShowInspector(false)}else openInspector('text')}} aria-pressed={showInspector && inspector === 'text'}><EditorIcon name="text" /><span>{t('editSlideText')}</span></button><button className="presentation-ribbon-tool" onClick={() => {if(paperMode)setWordPaperView(false);openInspector('images')}} aria-pressed={showInspector && inspector === 'images'}><EditorIcon name="image" /><span>{t('replaceImage')}</span></button><span className="presentation-tool-caption">{t('slideContent')}</span></div>
        <div className="presentation-tool-group"><CommandAction registry={commands.registry} run={commands.run} id="view.fit" className="presentation-ribbon-tool"/><CommandAction registry={commands.registry} run={(id)=>commands.run(id,{enabled:true})} id="view.focus" className="presentation-ribbon-tool"/><span className="presentation-tool-caption">{t('view')}</span></div>
        {!paperMode&&<p className="presentation-ribbon-hint">{t(session.flowLayoutVersion?'wordRegionEditingHint':'slideEditingHint')}</p>}
      </>}
      {tab === 'view' && <>
        {session.format === 'pdf' && layoutStatus?.needsUpgrade && <div className="presentation-tool-group"><button className="presentation-ribbon-tool" disabled={!editable || layoutBusy || busy || loading || drafts.size > 0 || geometryPending || layoutStatus.revision !== revision} title={drafts.size || geometryPending ? t('pdfLayoutDraftHint') : t('pdfLayoutUpgradeHint')} onClick={() => void upgradeLayout()}><EditorIcon name="fit" /><span>{layoutBusy ? t('pdfLayoutUpgrading') : t('pdfLayoutUpgrade')}</span></button><span className="presentation-tool-caption">{t('pageOptions')}</span></div>}

        {onFullEditor && <button className="presentation-full-editor" disabled={pendingCount > 0 || geometryPending || busy || saveController.pending} title={t('fullEditorHint')} onClick={onFullEditor}>{t('fullEditing')}</button>}
        <p className="presentation-ribbon-hint">{t('slideNavigationHint')}</p>
      </>}
      {tab === 'export' && <div className="presentation-export-options"><ExportControl session={session} revision={revision} runExport={session.scope==='write'?async operation=>{if(!imageTasks)throw new Error('imageUploadPending');await imageTasks.withClear(operation)}:undefined} beforeExport={async () => {
        if (drafts.size || imageDrafts.size || saving.current || imageDrafts.saving || saveController.pending || history.busy) throw new Error(t('saveDraftsFirst'))
        try{await saveController.flush()}catch{onBackupFailure();throw new Error(t('localDraftUnavailable'))}
        if(drafts.size||imageDrafts.size||saveController.pending||history.busy)throw new Error(t('saveDraftsFirst'))
        return revision
      }} beforeDownload={async (at,signal)=>{
        try{await verifyFixedDownload(at,()=>exportState.current.revision,exportBlocked,()=>fixedDocumentHead(session,sourceHash,signal))}
        catch{throw new Error(t('fixedExportChanged'))}
      }} hint="slideExportHint" /></div>}
    </div>
    <div className={`presentation-body ${showSlides && !focus ? '' : 'slides-hidden'} ${showInspector && !focus ? '' : 'inspector-hidden'}`} style={{ gridTemplateColumns: `${showSlides && !focus ? `${leftWidth}px 5px ` : ''}minmax(0,1fr)${showInspector && !focus ? ` 5px ${rightWidth}px` : ''}` }}>
      <aside className="presentation-slides" aria-label={t(paperMode?'wordSections':'slideThumbnails')} hidden={!showSlides || focus}>
        <div className="presentation-panel-heading"><strong>{t(paperMode?'wordSections':'slideThumbnails')}</strong><span>{total}</span><button className="presentation-icon-button" aria-label={`${t('close')} ${t(paperMode?'wordSections':'slideThumbnails')}`} onClick={()=>commands.run('view.navigation',{enabled:false})}><EditorIcon name="close"/></button></div>
        <div className="presentation-slide-list">{slides.map((page, index) => flow ? <button key={page.firstSequence} className={`flow-section-button ${active?.firstSequence === page.firstSequence ? 'selected' : ''}`} aria-current={active?.firstSequence === page.firstSequence ? 'page' : undefined} onClick={() => selectSection(page.firstSequence)}>{paperMode?t('wordSection',{count:index+1}):session.flowLayoutVersion?`${wordRegionLabel(page.region,t)} · ${t('wordRegionChunk',{count:index+1})}`:t('goToSlide', { count: index + 1 })}{(entries.some(([id]) => (drafts.get(id)?.page??draftPages.current.get(id)) === page.firstSequence) || imageEntries.some(([, draft]) => draft.page === page.firstSequence)) && <span>•</span>}</button> : <PageThumbnail complete={pageComplete(page.firstSequence)} format={session.format} key={page.firstSequence} page={page} number={index + 1} revision={revision} loader={loader} stylesheet={stylesheet} dirty={entries.some(([id]) => (drafts.get(id)?.page??draftPages.current.get(id)) === page.firstSequence) || imageEntries.some(([, draft]) => draft.page === page.firstSequence)} selected={active?.firstSequence === page.firstSequence} onSelect={() => setSelected(page.firstSequence)} />)}<div ref={indexTail} className="load-tail" />{!indexComplete && (session.flowLayoutVersion===2?<button className="presentation-index-loading" onClick={()=>void loadWordIndex()}>{t('wordSectionsMore')}</button>:<span className="presentation-index-loading">{t('loadingSlides')}</span>)}</div>
      </aside>
      <PanelResizeHandle side="left" width={leftWidth} onResize={setLeftWidth} label={t('resizeNavigation')} hidden={!showSlides || focus} />
      <main className="presentation-center">
        {!paperMode&&<div className="presentation-canvas-bar"><div><button className="presentation-icon-button" aria-label={t('previousSlide')} disabled={activeIndex === 0} onClick={() => navigate(-1)}><EditorIcon name="left" /></button><span>{paperMode?t('wordSection',{count:activeIndex+1}):t('slidePosition', { current: active ? activeIndex + 1 : 0, total })}</span><button className="presentation-icon-button" aria-label={t('nextSlide')} disabled={activeIndex >= slides.length - 1} onClick={() => navigate(1)}><EditorIcon name="right" /></button></div><div className="fixed-follow-status" role="status"><span>{locationLoading!==null?t('fixedLocationLoading'):followed?t('followingCollaborator',{name:followed.name}):loading?t('loadingSlide'):drafts.size?t('draftPreview'):t('slideCanvas')}</span>{followed&&<button type="button" onClick={stopFollowing}>{t('stopFollowing')}</button>}</div></div>}
        <div className="presentation-canvas" onClick={event => { if(paperMode){stopFollowing();return} const target = event.target as HTMLElement; if (target === event.currentTarget || target.classList.contains('presentation-stage') || target.classList.contains('presentation-stage-space')) { setInspector('page'); setShowInspector(true) } }} ref={canvas} tabIndex={0} aria-label={t(paperMode?'wordPaperCanvas':'slideCanvas')} aria-busy={loading}>
          {loaded && paperMode && wordStoriesReady && wordLayout.state && typeof wordLayout.state==='object' ? <WordPageCanvas loaded={loaded} active={active} pages={wordStoryGroups?[...pages.filter(page=>page.region!=='header'&&page.region!=='footer'),...wordStoryGroups]:pages} loader={loader} layout={wordLayout.state.layout} stylesheet={stylesheet} drafts={drafts} scale={scale} editable={editable && !busy} peers={collaboration.others} onInteraction={stopFollowing} onSelection={setPresenceSelection} onUndoRedo={direction=>void changeHistory(direction)} onStopCapture={()=>history.stopCapturing()} location={locating?.selection??undefined} requestedPage={locating?.viewport?.wordPage??(wordPageTarget?.sequence===active.firstSequence?wordPageTarget.page:undefined)} onPage={setWordPageNumber} initialPage={wordPageNumber} editingRegion={wordEditingRegion} onEditingRegion={setWordEditingRegion} onSave={()=>void save()} tools={wordTools} onPageCount={setPaperCount} pending={!!saveController.pending} onImage={(page,id)=>{setWordPaperView(false);setShowSlides(true);setSelected(page);setSelectedImage(id);openInspector('images')}} /> : loaded && !paperMode ? <div className="presentation-stage-space" style={{ minWidth: Math.ceil(size.width * scale) + 48, minHeight: Math.ceil(size.height * scale) + 48 }}><div className="presentation-stage" style={{ width: size.width * scale, height: size.height * scale }}>
            {flow ? <FlowCanvas onInteraction={stopFollowing} peers={collaboration.others.filter(peer=>peer.selection?.page===active?.firstSequence&&(peer.viewport?.revision===undefined||peer.viewport.revision===revision)).map(peer=>({clientId:peer.clientId,name:peer.name,color:peer.color,nodeId:peer.selection!.nodeId}))} selectableIds={[...loaded.runs.map(run=>run.nodeId),...loaded.images.map(image=>image.nodeId)]} srcDoc={frame} width={size.width} height={size.height} scale={scale} selected={inspector === 'images' ? selectedImage : selectedRun} onHeight={setFlowHeight} onSelect={nodeId => { if (!nodeId) { setInspector('page'); setShowInspector(true) } else if (loaded.images.some(image => image.nodeId === nodeId)) { setSelectedImage(nodeId); openInspector('images') } else selectRun(nodeId) }} title={t('slideCanvas')} /> : <iframe sandbox="" title={t('slidePosition', { current: activeIndex + 1, total })} srcDoc={frame} referrerPolicy="no-referrer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }} />}
            <div className="presentation-hit-layer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>{loaded.objects.map((object, index) => <button key={index} className={`presentation-object-hit ${object.nodeIds.includes(object.kind === 'image' ? selectedImage : selectedRun) && showInspector && inspector === (object.kind === 'image' ? 'images' : 'text') && !focus ? 'selected' : ''}`} aria-label={t(object.kind === 'image' ? 'selectImageObject' : 'selectSlideText', { count: index + 1 })} title={object.label || t('pageTextRun', { count: index + 1 })} onClick={() => { if (object.kind === 'image') { setSelectedImage(object.nodeIds[0]); openInspector('images') } else selectRun(object.nodeIds[0]) }} style={{ left: object.x, top: object.y, width: object.width, height: Math.max(object.height, 12), transform: object.transform }} />)}</div>
            <div className="presentation-peer-layer" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>{collaboration.others.filter(peer => peer.selection?.page === active.firstSequence&&(peer.viewport?.revision===undefined||peer.viewport.revision===loaded.revision)).map(peer => {
              const object = loaded.objects.find(object => object.nodeIds.includes(peer.selection!.nodeId))
              return object ? <div key={peer.clientId} style={{ left: object.x, top: object.y, width: object.width, height: Math.max(object.height, 12), borderColor: peer.color, transform:object.transform }}><span style={{ background: peer.color }}>{peer.name}</span></div> : null
            })}</div>
          </div></div> : null}
          {loaded && paperMode && wordStoriesReady && (wordLayout.state==='loading'||wordLayout.state==='failed') && <div className="presentation-load-error" role="status">{t(wordLayout.state==='failed'?'wordLayoutUnavailable':'loadingSection')}{wordLayout.state==='failed'&&<button onClick={wordLayout.retry}>{t('retry')}</button>}</div>}
          {loaded && paperMode && !wordStoriesReady && <div className="presentation-load-error" role={wordIndexFailed?'alert':'status'}>{t(wordIndexFailed?'wordStoryIndexFailed':'loadingSections')}{wordIndexFailed&&<button onClick={onRetryWordIndex}>{t('retry')}</button>}</div>}
          {loaded && paperMode && wordStoriesReady && !indexComplete && wordIndexFailed && <div className="presentation-load-error" role="alert">{t('fixedLocationUnavailable')} <button onClick={onRetryWordIndex}>{t('retry')}</button></div>}
          {!loaded && !loadError && session.flowLayoutVersion===2 && wordIndexFailed ? <div className="presentation-load-error" role="alert">{t('fixedLocationUnavailable')} <button onClick={onRetryWordIndex}>{t('retry')}</button></div> : !loaded && !loadError && <div className="presentation-empty">{t('loadingSlide')}</div>}
          {loadError && <div className="presentation-load-error" role="alert"><p>{loadError}</p><button onClick={() => setRetry(value => value + 1)}>{t('retry')}</button></div>}
        </div>
        {focus && <button className="presentation-exit-focus" onClick={() => setFocus(false)}><EditorIcon name="focus" />{t('exitFocus')}</button>}
      </main>
      <PanelResizeHandle side="right" width={rightWidth} onResize={setRightWidth} label={t('resizeProperties')} hidden={!showInspector || focus} />
      <aside className="presentation-inspector" hidden={!showInspector || focus} aria-label={t(inspector==='collaboration'?'onlineCollaborators':'properties')}>
        {inspector==='collaboration'?<FixedCollaborationPanel loading={locationLoading} peers={collaboration.peers} localId={collaboration.localId} following={following} canLocate={canLocate} canFollow={peer=>canLocate(peer)&&collaboration.clientId!==null&&!fixedFollowCycle(collaboration.peers,collaboration.clientId,peer.clientId)} onLocate={locatePeer} onFollow={followPeer} onStop={stopFollowing} activityText={peer=>{const selection=peer.selection;if(!selection)return '';const remote=revision!==null?activity[fixedActivityKey(revision,selection.nodeId)]:undefined;const text=remote??(selection.page===active?.firstSequence&&loaded?.revision===revision?(selection.kind==='text'?loaded?.runs.find(run=>run.nodeId===selection.nodeId)?.text:loaded?.objects.find(object=>object.nodeIds.includes(selection.nodeId))?.label):'');return Array.from(text||t(selection.kind==='image'?'pictureOptions':'textOptions')).slice(0,64).join('')}} onClose={()=>setShowInspector(false)}/>:<>
        <div className="presentation-panel-heading"><strong>{t('properties')}</strong><button className="presentation-icon-button" onClick={() => setShowInspector(false)} aria-label={t('hidePanel')}><EditorIcon name="close" /></button></div>
        <div className="presentation-inspector-tabs"><button aria-pressed={inspector === 'text'} onClick={() => setInspector('text')}><EditorIcon name="text" />{t('textOptions')}</button><button aria-pressed={inspector === 'images'} onClick={() => setInspector('images')}><EditorIcon name="image" />{t('pictureOptions')}</button><button aria-pressed={inspector === 'page'} onClick={() => setInspector('page')}><EditorIcon name="panel" />{t('pageOptions')}</button></div>
        <div className="presentation-inspector-content">
          <ImageDraftList session={session} drafts={imageDrafts} onSelect={(id, page) => { if (page !== undefined) setSelected(page); setSelectedImage(id); openInspector('images') }} />
          {invalidGeometry && <p role="alert">{t('imageGeometryInvalid')}</p>}
          {(loaded?.approximateText || pdfPreviewChanged) && <p className="presentation-preview-notice" role="status">{t('pdfApproximatePreview')}</p>}
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
                <section className="inspector-property-group"><h3>{t('textContent')}</h3><textarea data-command-input="document" onSelect={()=>setSelectionVersion(value=>value+1)} id={`${fieldPrefix}-${run.nodeId}`} ref={element => { if (element) textFields.current.set(run.nodeId, element); else textFields.current.delete(run.nodeId) }} aria-label={t('selectedTextContent')} value={draft?.text ?? current.text} rows={Math.max(4, Math.min(10, (draft?.text ?? current.text).split('\n').length + 2))} readOnly={!editable} onChange={event => drafts.edit(run, loaded.revision, event.target.value,active?.firstSequence)} /><p>{editable ? t(session.flowLayoutVersion?'wordRegionEditingHint':'slideTextHint') : t('readOnlyMode')}</p></section>

                {draft?.remote && !draft.stale && <div className="presentation-conflict" role="alert"><p>{t(saveController.pending?'fixedSaveUnknown':'textDraftConflict')}</p><blockquote>{draft.remote.text}</blockquote><button disabled={saveController.pending||!editable} onClick={() => drafts.resolve(draft.remote!, revision ?? loaded.revision, false)}>{t('useRemoteText')}</button><button disabled={saveController.pending||!editable} onClick={() => drafts.resolve(draft.remote!, revision ?? loaded.revision, true)}>{t('keepLocalText')}</button></div>}
                <details className="inspector-property-group source-text-style"><summary>{t('sourceTextStyle')}</summary><dl><dt>{t('fontFamily')}</dt><dd>{run.font?.mixedFamily ? `${t('mixedStyles')} · ${run.font.families?.join(' / ')}` : run.font?.family || t('inheritedStyle')}</dd><dt>{t('fontSize')}</dt><dd>{run.font?.mixedSize ? t('mixedStyles') : run.font?.sizePt ? `${Number(run.font.sizePt.toFixed(2))} pt` : t('inheritedStyle')}</dd><dt>{t('formatting')}</dt><dd>{run.font?.mixedStyle ? t('mixedStyles') : [run.font?.bold && t('bold'), run.font?.italic && t('italic')].filter(Boolean).join(' · ') || t('standard')}</dd></dl></details>
              </div>
            })}
            {loaded && !meaningfulRuns.length && <p className="presentation-empty-panel">{t('noSlideText')}</p>}
          </>}
          {inspector === 'page' && <><div className="presentation-section-title"><strong>{t('pageOptions')}</strong></div>{session.flowLayoutVersion&&<WordRegionProperties state={wordLayout.state} onRetry={wordLayout.retry} previewSection={previewWordSection?.section} onPreviewSection={setWordPreviewSection} region={loaded?.wordRegion}/>}<dl className="page-property-dimensions"><dt>{t('width')}</dt><dd>{Number((size.width * .75).toFixed(2))} pt</dd>{!flow && <><dt>{t('height')}</dt><dd>{Number((size.height * .75).toFixed(2))} pt</dd></>}</dl><section className="inspector-property-group"><h3>{t('appearance')}</h3><label className="inspector-option"><input type="checkbox" checked={showSlides} onChange={event => commands.run('view.navigation',{enabled:event.target.checked})} />{t(paperMode?'wordSections':'slideThumbnails')}</label><button className="inspector-reset-layout" onClick={() => { setLeftWidth(190); setRightWidth(270); setShowSlides(!paperMode); if(paperMode)setShowInspector(false); setZoom('fit') }}>{t('resetLayout')}</button></section></>}
          {inspector === 'images' && <><div className="presentation-section-title"><strong>{t('slideImages')}</strong></div><p className="presentation-panel-help">{t('slideImagesHint')}</p>{loaded && <ImagePanel key={pageKey} session={session} revision={revision} disabled={!editable || loading} nodes={loaded.images} showDrafts={false} drafts={imageDrafts} page={active?.firstSequence} replacementPending={!!imageTasks?.choices.length} onReplace={async(file,image,version)=>{if(!imageTasks)throw new Error(t('localDraftUnavailable'));try{await imageTasks.choose(file,image,version,active?.firstSequence)}catch(cause){throw new Error(cause instanceof Error&&cause.message==='fixed-image-choice-target-changed'?t('wordUploadBaseChanged'):cause instanceof Error&&cause.message==='fixed-image-choice-not-recorded'?t('fixedImageChoiceNotRecorded'):t('wordUploadUnknown'))}}} onSaveGeometry={async()=>save()} saveGeometryLabel={t('saveAllText')} selectedNodeId={selectedImage} onSelected={setSelectedImage} showEmpty emptyMessage={t('noSlideImages')} onRevised={onRevised} />}</>}
        </div></>}
      </aside>
    </div>
    {paperOverview&&paperMode&&wordLayout.state&&typeof wordLayout.state==='object'&&<WordPaperOverview layout={wordLayout.state.layout} section={previewWordSection?previewWordSection.section-1:null} onClose={closePaperOverview}/>}
    <footer className="presentation-statusbar"><div><CommandAction registry={commands.registry} run={commands.run} id="view.navigation" className="presentation-icon-button" iconOnly/>{paperMode?<><select className="word-section-select" aria-label={t('wordSections')} value={active?.firstSequence??''} onChange={event=>{if(event.target.value==='more'){void loadWordIndex();return}selectSection(Number(event.target.value))}}>{slides.map((group,index)=><option value={group.firstSequence} key={group.firstSequence}>{t('wordSection',{count:index+1})}</option>)}{!indexComplete&&<option value="more">{t('wordSectionsMore')}</option>}</select><button className="presentation-icon-button" aria-label={t('previousPage')} disabled={!active||loading||activeIndex===0&&wordPageNumber===1} onClick={()=>turnWordPage(-1)}><EditorIcon name="left"/></button><span>{t('wordPaperPage',{current:wordPageNumber,total:wordPageCount})}</span><button className="presentation-icon-button" aria-label={t('nextPage')} disabled={!active||loading||indexComplete&&activeIndex===slides.length-1&&wordPageNumber>=wordPageCount} onClick={()=>turnWordPage(1)}><EditorIcon name="right"/></button><button ref={paperButton} type="button" className="word-paper-status" aria-haspopup="dialog" disabled={!wordLayout.state||typeof wordLayout.state!=='object'} onClick={()=>setPaperOverview(true)} title={`${paperDescription} · ${t('wordPaperOverview')}`}>{paperFormat??t('wordPaperSize')} · {paperOrientation}</button>{followed&&<button type="button" className="word-follow-status" onClick={stopFollowing}>{t('followingCollaborator',{name:followed.name})} · {t('stopFollowing')}</button>}</>:<span>{t('slidePosition',{current:active?activeIndex+1:0,total})}</span>}<span className={pendingCount ? 'has-drafts' : ''} role="status">{saveController.pending&&!busy?t('fixedSaveUnknown'):pendingCount ? t('unsavedChangesCount', { count: pendingCount }) : typeof status === 'number' && status === revision ? t('changesSavedAt', { revision: status }) : status === 'failed' ? t('saveFailed') : status === 'saving' ? t('saving') : t('saved')}</span></div><div className="presentation-zoom-controls"><CommandAction registry={commands.registry} run={commands.run} id="view.properties" className="presentation-icon-button" iconOnly/><CommandAction registry={commands.registry} run={commands.run} id="view.fit" className="presentation-fit-button" iconOnly/><input type="range" aria-label={t('zoom')} min="25" max="200" step="1" value={zoom === 'fit' ? Math.round(fit * 100) : zoom} onChange={event => commands.run('view.zoom.set',{percent:Number(event.target.value)})} /><span className="presentation-zoom-value">{Math.round(scale * 100)}%</span><CommandAction registry={commands.registry} run={commands.run} id="view.focus" className="presentation-icon-button" iconOnly/></div></footer>
    {error && <div className="presentation-error" role="alert"><span>{error}</span><button className="presentation-icon-button" onClick={() => onError('')} aria-label={t('close')}><EditorIcon name="close" /></button></div>}
    {paletteOpen&&<CommandPalette registry={commands.registry} run={commands.run} onClose={()=>setPaletteOpen(false)}/>}
  </div>
}

function PageThumbnail({ complete, format, page, number, revision, loader, stylesheet, selected, dirty, onSelect }: {
  complete:boolean;format: string; page: PageGroup; number: number; revision: number | null; loader: PageLoader; stylesheet: string; selected: boolean; dirty: boolean; onSelect: () => void
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
    if (!complete || !visible || revision === null || !stylesheet) { setLoaded(null); return }
    let live = true
    setFailed(false)
    void loader(page, revision).then(value => { if (live) setLoaded(value) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [complete,visible, revision, loader, page, sequences, stylesheet])
  const src = useMemo(() => loaded ? pageDocument(loaded, stylesheet, locale) : '', [loaded, stylesheet, locale])
  const frameHeight=width*(format==='pdf'?Math.SQRT2:9/16)
  const scale = loaded ? Math.min(width/loaded.size.width,frameHeight/loaded.size.height) : 1
  return <button ref={marker} className={`presentation-thumbnail ${selected ? 'selected' : ''}`} aria-label={t('goToSlide', { count: number })} aria-current={selected ? 'page' : undefined} onClick={onSelect} onKeyDown={event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const sibling = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
    if (sibling instanceof HTMLButtonElement) { event.preventDefault(); sibling.focus(); sibling.click() }
  }}>
    <span className="presentation-thumbnail-number">{number}{dirty && <span className="presentation-thumbnail-draft" title={t('editing')}>•</span>}</span><span className="presentation-thumbnail-frame" style={{ height: frameHeight }}>{loaded ? <iframe aria-hidden="true" tabIndex={-1} sandbox="" srcDoc={src} title={t('goToSlide', { count: number })} referrerPolicy="no-referrer" style={{ left:(width-loaded.size.width*scale)/2,top:(frameHeight-loaded.size.height*scale)/2,width: loaded.size.width, height: loaded.size.height, transform: `scale(${scale})` }} /> : <span>{failed ? t('previewUnavailable') : '…'}</span>}</span>
  </button>
}
