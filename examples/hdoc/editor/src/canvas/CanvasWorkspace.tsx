import type { HcdEmbedSelection } from '../public'
import { transferBoardDrop } from './specTransfers'
import { carriedPositions, inPaintOrder } from './sceneGeometry'
import { mindFields } from './mindMap'
import { presentBoardPaper, presentDiagramCards } from './boardPaperView'
import { hasSpecPreview, SpecPreview } from './SpecPreview'
import { specTag } from './specRichText'
import { SpecCollaboration, type RewriteRef } from './specCollaboration'
import { specPeers, type SpecCursor, type SpecSentence } from './specCoordinates'
import { rewriteLog, savedSentence } from './specRewrite'
import { displayedStampFiles, prepareStampPaint, stampPng, type StampPaintCache } from './stampArt'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, MainMenu, CaptureUpdateAction, newElementWith, restoreElements, exportToBlob, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawProps, BinaryFiles, Collaborator } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { ArrowLeft, ArrowUpRight, Check, Download, FileImage, History, Maximize2, Minimize2, Link2, PanelRightClose, Plus, Save, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { type Session, api } from '../api.ts'
import { AppearanceSelect, useAppearance } from '../Appearance.tsx'
import { AgentPanel, useAgentWorkspace } from '../AgentActivityLayer.tsx'
import { useDocumentViewState } from '../DocumentViewState.tsx'
import { useWorkflowPreparation } from '../WorkflowWorkspace.tsx'
import { WorkspacePanel, WorkspacePanelControls } from '../WorkspacePanel.tsx'
import { HostPublicationControl, permits } from '../HostIntegration.tsx'
import { DocumentVisitorIdentity, ShareControl } from '../DocumentSharing.tsx'
import { EmbedSelection, EmbedSpecRewrite } from '../embedSelection'
import { CanvasCursorChat, type CursorBubble } from './CanvasCursorChat'
import { BoardWidgets } from './BoardWidgets'
import type { BoardPoint } from './boardObjects'
import { CanvasToolDock } from './CanvasToolDock'
import { CanvasConnection, type CanvasConnectionState } from './CanvasConnection.ts'
import { CanvasPresenceLayer } from './CanvasPresenceLayer.tsx'
import { CanvasRegionPicker } from './CanvasRegionPicker.tsx'
import { CanvasResources } from './CanvasResources.tsx'
import { CanvasDraftRecovery } from './CanvasDraftRecovery'
import { CanvasCreationNavigator } from './CanvasCreationNavigator.tsx'
import { CanvasComposePanel } from './CanvasComposePanel.tsx'
import { AgentCompanionMark } from '../AgentCompanionMark.tsx'
import { CanvasStickers, motionElements, selectedStickerId, stickerElements, StickerIllustration } from './CanvasStickers.tsx'
import { CanvasMaterialSidebar } from './CanvasMaterialLibrary.tsx'
import { handBrush, isAvatar, isBrush, isReaction, reactionKinds, type HandBrush, type MaterialDetail } from './materialCatalog.ts'
import { CanvasEmotes, CanvasStampTool } from './CanvasStampTool.tsx'
import { CanvasReactionTools, CanvasReactions, reactionTargets, useCanvasReactions } from './CanvasReactions.tsx'
import { changesFromUI, selectedRegion, same, snapshotElements } from './changes.ts'
import type { Batch, CanvasElement, CanvasEmote, CanvasEvent, CanvasFile, Composition, Operation, ReactionKind, Selection } from './model.ts'
import { ResourcePicker } from '../resources/ResourcePicker.tsx'
import { ResourceCard } from '../resources/ResourceCard.tsx'
import { useResourceWorkspace } from '../resources/ResourceWorkspace.tsx'
import { findResourceSession, referenceFrom, type ResourceReference } from '../resources/resourceReference.ts'
import { isIndex, readTabState, tabStateKey, workspaceIdentity, writeTabState } from '../tabState.ts'
import { useSelectionTransferWorkspace, useTransferNavigation } from '../SelectionTransferWorkspace.tsx'
import { decodeTransferLink, supportsTransfer } from '../selectionTransfer.ts'
import '@excalidraw/excalidraw/index.css'
import './canvas.css'

// The host serves these files locally in dev and in the packaged Workspace.
declare global { interface Window { EXCALIDRAW_ASSET_PATH: string } }
window.EXCALIDRAW_ASSET_PATH = '/canvas-assets/'
const nativeElements = (elements: readonly CanvasElement[], animated = false, editingMind?: string | null, stampCache?: StampPaintCache) => {
  const ordered = inPaintOrder(presentDiagramCards(elements))
  const view = animated ? motionElements(ordered).map(el => {
    const coldStamp = el.type === 'image' && (el.customData as {officeStamp?: unknown} | undefined)?.officeStamp &&
      typeof el.fileId === 'string' && stampCache?.get(el.fileId) !== 'ready'
    return hasSpecPreview(el) || coldStamp ? { ...el, opacity: 0 } : el
  }) : ordered
  const native = presentBoardPaper(restoreElements(view as unknown as ExcalidrawElement[], null), animated)
  const node = editingMind && native.find(el => el.id === editingMind)
  if (!node) return native
  const { title, body } = mindFields(native, node)
  return native.map(el => el === title || el === body ? { ...el, opacity: 0 } : el)
}
// The dots belong to the viewport. Export and remote clients keep the authored background.
const paperBackground = (color: unknown) => /^(#fff(?:fff)?|white)$/i.test(String(color || '#ffffff')) ? 'transparent' : String(color)
const screenApp = (app: Record<string, unknown>) => ({ ...app, viewBackgroundColor: paperBackground(app.viewBackgroundColor) })
type Camera = { x: number; y: number; zoom: number }
type CanvasTabView = { camera: Camera; epoch: number; selectedIds: string[]; box: Selection | null }

function readCanvasView(key: string | null) {
  const saved = readTabState<CanvasTabView>(key)
  const view = saved?.camera
  if (!saved || !view || ![view.x, view.y, view.zoom].every(Number.isFinite) || view.zoom <= 0 || view.zoom > 30
    || !isIndex(saved.epoch) || !Array.isArray(saved.selectedIds) || !saved.selectedIds.every(id => typeof id === 'string')) return null
  const box = saved.box?.region
  if (box && (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0
    || !Array.isArray(saved.box?.elementIds) || !saved.box.elementIds.every(id => typeof id === 'string'))) saved.box = null
  if (!box) saved.box = null
  return saved
}

const download = (blob: Blob, name: string) => {
  const href = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = href; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
}

export function CanvasWorkspace({ session, onClose }: { session: Session; onClose: () => void }) {
  const fill = session.canvasLayout === 'fill'
  const resourceWorkspace = useResourceWorkspace()
  const transfers = useSelectionTransferWorkspace()
  const [resourcePicker, setResourcePicker] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const sessionRef = useRef(session); sessionRef.current = session
  const { theme } = useAppearance()
  const [state, setState] = useState<CanvasConnectionState | null>(null)
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null)
  const stampCache = useMemo<StampPaintCache>(() => new Map(), [editor])
  const [stampPaint, setStampPaint] = useState(0)
  const [editingMind, setEditingMind] = useState<string | null>(null)
  const [editingSpec, setEditingSpec] = useState<string | null>(null)
  const nativeEditor = useRef(editor)
  nativeEditor.current = editor
  const connection = useRef<CanvasConnection | null>(null)
  const lastUI = useRef<CanvasElement[]>([]), updating = useRef(false)
  const lastApp = useRef<Record<string, unknown> | null>(null)
  const viewKey = tabStateKey(session, 'canvas-view')
  const identity = workspaceIdentity(session)
  const avatarKey = identity && JSON.stringify(['hcd-canvas-avatar', ...identity])
  const [avatar,setAvatar] = useState(() => {const saved=readTabState<{id:string}>(avatarKey);return isAvatar(saved?.id)?saved.id:null})
  const avatarRef = useRef(avatar); avatarRef.current = avatar
  useEffect(() => {
    if (!avatarKey) return
    const sync = () => { const value=readTabState<{id:string}>(avatarKey); const next=isAvatar(value?.id)?value.id:null; avatarRef.current=next;setAvatar(next) }
    sync()
    window.addEventListener('officecli:canvas-avatar',sync)
    const stored = (event:StorageEvent) => { if (event.key===avatarKey || event.key===null) sync() }
    window.addEventListener('storage',stored)
    return ()=>{window.removeEventListener('officecli:canvas-avatar',sync);window.removeEventListener('storage',stored)}
  },[avatarKey])
  const [showStyles,setShowStyles]=useState(false)
  const [toolRevision, bumpTool] = useState(0)
  const [bubbles,setBubbles] = useState<CursorBubble[]>([])
  useEffect(()=>{
    if(!bubbles.length)return
    const next=setTimeout(()=>setBubbles(items=>items.filter(b=>b.expires>Date.now())),Math.max(0,Math.min(...bubbles.map(b=>b.expires))-Date.now())+10)
    return()=>clearTimeout(next)
  },[bubbles])
  const workspaceRef=useRef<HTMLDivElement>(null)
  const [emotes, setEmotes] = useState<CanvasEmote[]>([])
  const addEmote = useCallback((emote: CanvasEmote) => {
    setEmotes(previous => previous.some(e => e.id === emote.id) ? previous : [...previous.slice(-7), emote])
  }, [])
  const removeEmote = useCallback((id: string) => setEmotes(previous => previous.filter(e => e.id !== id)), [])
  const [reactionTick,setReactionTick] = useState(0)
  const feedback = useCanvasReactions(session,state?.snapshot?.collaborationEpoch,!!state?.connected,reactionTick)
  const [savedView] = useState(() => readCanvasView(viewKey))
  const nativeView = useRef<CanvasTabView | null>(null)
  const saveView = useCallback((next: CanvasTabView) => {
    if (same(nativeView.current, next)) return
    nativeView.current = next
    writeTabState(viewKey, next)
  }, [viewKey])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [regionSelection, updateRegionSelection] = useState<Selection | null>(null)
  const setRegionSelection = (box: Selection | null) => {
    updateRegionSelection(box)
    if (nativeView.current) saveView({ ...nativeView.current, box })
  }
  const [selectingRegion, setSelectingRegion] = useState(false)
  const activeSelection = regionSelection || selection
  const reactionIds = useMemo(()=>reactionTargets(state?.scene?.elements || [],activeSelection?.elementIds || []),[state?.scene,activeSelection])
  const canEdit = session.scope==='write' && permits(session,'document.edit')
  const reportSelection = useContext(EmbedSelection), hostRewrite=useContext(EmbedSpecRewrite)
  const selectedIds = activeSelection?.elementIds
  const revision = state?.snapshot?.revision, epoch = state?.snapshot?.collaborationEpoch
  const [specFocus,setSpecFocus]=useState<{id:string;cursor:SpecCursor|null}|null>(null)
  const [pinnedSentence,setPinnedSentence]=useState<HcdEmbedSelection|null>(null)
  const releaseSentence=useCallback(()=>setPinnedSentence(null),[])
  const reportSpec=useCallback((value:typeof specFocus)=>{
    if (!value) setPinnedSentence(null)
    connection.current?.setSpecCursor(value?.cursor??null)
    setSpecFocus(old=>same(old,value)?old:value)
  },[])
  const [receipts,setReceipts]=useState<RewriteRef[]>([])
  useEffect(()=>{setReceipts(epoch===undefined?[]:rewriteLog(sessionRef.current,epoch))},[session.documentId,session.userId,epoch])
  const sentence=useMemo(()=>savedSentence(state?.snapshot,specFocus?.cursor),[state?.snapshot,specFocus])
  const specTarget = useMemo(() => {
    if (!selectedIds?.length || !state?.scene) return false
    const selected = new Set(selectedIds)
    const targets = state.scene.elements.filter(e => !e.isDeleted && selected.has(e.id))
    return targets.length === selected.size && targets.every(e => specTag(e)?.kind === 'spec')
  }, [selectedIds, state?.scene])
  useEffect(() => {
    if (!reportSelection) return
    if(canEdit && pinnedSentence?.documentId===session.documentId && pinnedSentence.collaborationEpoch===epoch){reportSelection(pinnedSentence);return}
    if (specFocus) {
      reportSelection(canEdit && sentence && revision!==undefined && epoch!==undefined ? {documentId:session.documentId, revision,collaborationEpoch:epoch,target:{kind:'spec',...sentence}}:null)
      return
    }
    reportSelection(canEdit && selectedIds?.length && revision !== undefined && epoch !== undefined
      ? { documentId: session.documentId, revision, collaborationEpoch: epoch, target: { kind: 'canvas', elementIds: selectedIds, ...(specTarget && {spec:true as const}) } }
      : null)
  }, [reportSelection, canEdit, selectedIds, specTarget, revision, epoch, session.documentId,specFocus,sentence,pinnedSentence])
  useEffect(() => () => reportSelection?.(null), [reportSelection, session.documentId])
  const { busy, panelOpen, setPanelOpen, requestTask, runTask } = useAgentWorkspace()
  const { focused, setFocused, rightPanel, setRightPanel, closeRightPanel, lastRightPanel, stickerMotionPaused, setStickerMotionPaused } = useDocumentViewState()
  const exportMenu = useRef<HTMLDetailsElement>(null)
  const [showCursors,setShowCursors]=useState(true)
  const panelControls = useRef<HTMLDivElement>(null)
  const [history, setHistory] = useState<Array<{ revision: number; authorName?: string }>>([])
  const [notice, setNotice] = useState(''), [peers, setPeers] = useState<Map<string, CanvasEvent>>(new Map())
  const [presentedTransferLink, setPresentedTransferLink] = useState('')
  const [camera, setCamera] = useState<Camera>(() => savedView?.camera || { x: 0, y: 0, zoom: 1 })
  const [following,setFollowing]=useState(''),followingId=useRef(''),ownCamera=useRef<Camera|null>(null),viewport=useRef<CanvasEvent['viewport']>(undefined)
  const peopleMenu=useRef<HTMLDetailsElement>(null)
  function follow(id:string){
    if(!editor)return
    if(peopleMenu.current)peopleMenu.current.open=false
    if(!followingId.current&&id){const a=editor.getAppState();ownCamera.current={x:a.scrollX,y:a.scrollY,zoom:a.zoom.value}}
    followingId.current=id;setFollowing(id)
    const home=ownCamera.current
    if(!id&&home){ownCamera.current=null;editor.updateScene({appState:{scrollX:home.x,scrollY:home.y,zoom:{value:home.zoom as AppState['zoom']['value']}},captureUpdate:CaptureUpdateAction.NEVER})}
  }
  useEffect(()=>{
    if(!following||!editor)return
    const who=peers.get(following),v=who?.viewport,a=editor.getAppState()
    if(!who){follow('');return}
    if(!v)return
    const scrollX=a.width/(2*v.zoom)-v.x,scrollY=a.height/(2*v.zoom)-v.y
    if(Math.abs(a.scrollX-scrollX)<.1&&Math.abs(a.scrollY-scrollY)<.1&&a.zoom.value===v.zoom)return
    editor.updateScene({appState:{scrollX,scrollY,zoom:{value:v.zoom as AppState['zoom']['value']}},captureUpdate:CaptureUpdateAction.NEVER})
  },[following,peers,editor])
  const [stickers, setStickers] = useState<CanvasElement[]>([])
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; region: Selection['region'] }>).detail
      if (detail.documentId !== session.documentId || !editor) return
      const region = detail.region
      const elements = editor.getSceneElements().filter(e => e.x >= region.x - 1 && e.y >= region.y - 1 && e.x + e.width <= region.x + region.width + 1 && e.y + e.height <= region.y + region.height + 1)
      if (elements.length) editor.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 300 })
    }
    window.addEventListener('officecli:canvas-locate', locate)
    return () => window.removeEventListener('officecli:canvas-locate', locate)
  }, [editor, session.documentId])
  const initialData = useRef<ExcalidrawProps['initialData']>(undefined)
  if (!initialData.current && state?.ready && state.scene) {
    const elements = nativeElements(state.scene.elements, true, null, stampCache)
    const selected = savedView?.epoch === state.snapshot?.collaborationEpoch
      ? elements.filter(element => !element.isDeleted && savedView?.selectedIds.includes(element.id)) : []
    const view = savedView && { scrollX: savedView.camera.x, scrollY: savedView.camera.y,
      zoom: { value: savedView.camera.zoom as AppState['zoom']['value'] },
      selectedElementIds: Object.fromEntries(selected.map(element => [element.id, true as const])) }
    initialData.current = {
      elements, appState: { ...screenApp(state.scene.appState), ...view }, files: displayedStampFiles(state.scene) as unknown as BinaryFiles,
      scrollToContent: !savedView,
    }
  }
  useTransferNavigation(session, state?.snapshot?.revision, !!editor && !!state?.ready, location => {
    if (!editor || location.kind !== 'canvas') return
    const ids = new Set(location.elementIds), elements = editor.getSceneElements().filter(element => ids.has(element.id) && !element.isDeleted)
    if (!elements.length) throw new Error('找不到需要定位的白板对象。')
    setFocused(false)
    setRegionSelection(null)
    setPresentedTransferLink(location.region ? '' : elements.find(element => element.link && decodeTransferLink(element.link))?.link || '')
    const selectedElementIds = location.region ? Object.fromEntries(elements.map(element => [element.id, true as const])) : {}
    editor.updateScene({ appState: { selectedElementIds }, captureUpdate: CaptureUpdateAction.NEVER })
    editor.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: false })
  })
  const visible = !resourceWorkspace || resourceWorkspace.activeDocument === session.documentId
  const openedLink=useRef('')
  const [copiedObject,setCopiedObject]=useState('')
  useEffect(()=>{if(!copiedObject)return;const timer=setTimeout(()=>setCopiedObject(''),2000);return()=>clearTimeout(timer)},[copiedObject])
  async function copyObjectLink(id:string){
    const current=new URL(location.href),href=new URL(current.pathname,current.origin)
    for(const key of ['workspaceFile','file','view','standalone','ai','locale']){
      const value=current.searchParams.get(key)
      if(value)href.searchParams.set(key,value)
    }
    const file=workspaceRef.current?.closest<HTMLElement>('.desk-editor[data-file-id]')?.dataset.fileId
    if(file)href.searchParams.set('file',file)
    if(!file&&!href.searchParams.has('file')&&!href.searchParams.has('workspaceFile'))href.searchParams.set('doc-id',session.documentId)
    href.searchParams.set('node-id',id)
    try{
      const client=connection.current
      if(!client)throw new Error('画布仍在连接。')
      await client.flush()
      if(connection.current!==client||!client.state.snapshot?.scene.elements.some(el=>el.id===id&&!el.isDeleted))throw new Error('此对象尚未保存或已被删除。')
      await navigator.clipboard.writeText(href.href);setCopiedObject(id)
    }catch(e){setNotice(String(e))}
  }
  useEffect(()=>{
    if(!visible||!editor||!state?.ready)return
    function showNode(){
      if(!editor)return
      const url=new URL(location.href),id=url.searchParams.get('node-id')
      const hostFile=workspaceRef.current?.closest<HTMLElement>('.desk-editor[data-file-id]')?.dataset.fileId
      const linkedDocument=url.searchParams.get('doc-id')
      if(!id||linkedDocument&&linkedDocument!==session.documentId||hostFile&&url.searchParams.get('file')!==hostFile){openedLink.current='';return}
      if(openedLink.current===id)return
      const all=editor.getSceneElements(),el=all.find(e=>e.id===id);if(!el)return
      openedLink.current=id
      const members=all.filter(e=>e.id===id||el.groupIds.some(group=>e.groupIds.includes(group)))
      const group=el.groupIds.at(-1)
      editor.updateScene({appState:{selectedElementIds:Object.fromEntries(members.map(e=>[e.id,true as const])),selectedGroupIds:group?{[group]:true}:{}},captureUpdate:CaptureUpdateAction.NEVER})
      editor.scrollToContent(members,{fitToViewport:true,viewportZoomFactor:.8,maxZoom:1,animate:false})
    }
    let frame=requestAnimationFrame(showNode)
    const unsubscribe=editor.onChange((_,app)=>{if(!openedLink.current&&!app.isLoading&&new URL(location.href).searchParams.has('node-id')){cancelAnimationFrame(frame);frame=requestAnimationFrame(showNode)}})
    window.addEventListener('popstate',showNode)
    return()=>{cancelAnimationFrame(frame);unsubscribe();window.removeEventListener('popstate',showNode)}
  },[editor,visible,state?.ready,session.documentId])
  useEffect(()=>{
    const el=workspaceRef.current?.querySelector<HTMLElement>('.canvas-surface')
    if(!editor||!el||!visible)return
    let previous:{width:number;height:number}|undefined,frame=0
    const observer=new ResizeObserver(([entry])=>{
      const {width,height}=entry.contentRect;if(width<40||height<40)return
      el.style.setProperty('--board-viewport-height', height + 'px')
      const old=previous;previous={width,height}
      if(!old&&width<600&&!savedView&&!new URL(location.href).searchParams.has('node-id')){
        cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>editor.scrollToContent(editor.getSceneElements(),{fitToViewport:true,maxZoom:1,viewportZoomFactor:.8,animate:false}))
      }else if(old&&(old.width<600)!==(width<600)&&!followingId.current){
        const a=editor.getAppState()
        cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>editor.updateScene({appState:{scrollX:a.scrollX+(width-old.width)/(2*a.zoom.value),scrollY:a.scrollY+(height-old.height)/(2*a.zoom.value)},captureUpdate:CaptureUpdateAction.NEVER}))
      }
    })
    observer.observe(el);return()=>{cancelAnimationFrame(frame);observer.disconnect()}
  },[editor,visible,savedView])
  useEffect(() => {
    if (!visible) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (focused) setFocused(false)
      else if (window.innerWidth <= 900 && (panelOpen || rightPanel)) {
        closeRightPanel()
        requestAnimationFrame(() => panelControls.current?.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus())
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [visible, focused, panelOpen, rightPanel, closeRightPanel, setFocused])
  useEffect(() => {
    const next = new CanvasConnection(() => sessionRef.current, setState, event => {
      if (event.emote) addEmote(event.emote)
      if(event.chat && event.clientId && event.pointer) {
        const {chat,clientId,pointer}=event
        setBubbles(items=>{
          const rest=items.filter(b=>b.client!==clientId)
          return chat.text?[...rest.slice(-15),{id:chat.id,client:clientId,agent:event.actorKind==='agent',name:event.name || '协作者',text:chat.text,at:pointer,expires:Date.now()+4200}]:rest
        })
      }
      if (event.type==='reactions') {setReactionTick(i=>i+1);return}
      if(event.type==='commit' && event.collaborationEpoch!==undefined) {
        if(event.rewriteOwner===sessionRef.current.userId && event.specCursor && event.revision) {setPinnedSentence(p=>p?.target.kind==='spec' && p.target.id===event.specCursor?.id ? null : p);setReceipts(rewriteLog(sessionRef.current,event.collaborationEpoch,{add:{id:event.specCursor.id,revision:event.revision}}))}
        if(event.undoRevision) setReceipts(rewriteLog(sessionRef.current,event.collaborationEpoch,{remove:event.undoRevision}))
      }
      const ai=event.actorKind==='agent'||event.actorId?.startsWith('agent-')
      if(event.type==='commit'&&!ai&&event.actorId===sessionRef.current.userId)return
      if(!event.clientId&&!event.actorId)return
      setPeers(previous=>{
        const next=new Map(previous)
        const placeholder=(ai?'agent:':'actor:')+event.actorId
        const existing=[...previous].find(([,peer])=>peer.actorId===event.actorId&&peer.actorKind!=='agent')
        const id=(event.clientId && (ai?'agent:':'')+event.clientId) || (!ai && existing?.[0]) || placeholder
        const old=next.get(id)||next.get(placeholder)
        if(event.clientId && !ai)next.delete(placeholder)
        const first=event.elements?.find(el=>!el.isDeleted)
        const point=event.type==='commit'&&first?{x:first.x,y:first.y}:event.pointer
        const freshCursor=event.specSeq!=null && event.specSeq>=(old?.specSeq??-1)
        next.set(id,{...event,actorId:event.actorId||old?.actorId, name:event.name||old?.name, actorKind:ai?'agent':'person',at:Date.now(),
          agentPhase:ai ? (event.type==='commit' ? 'writing' : event.specSeq!=null && !freshCursor ? old?.agentPhase : event.agentPhase??old?.agentPhase??'idle') : undefined,
          specSeq:freshCursor?event.specSeq:old?.specSeq,
          specCursor:freshCursor || (event.type==='commit' && event.specCursor) ? event.specCursor : old?.specCursor,viewport:event.viewport??old?.viewport,avatar:event.avatar===undefined?old?.avatar:event.avatar,pointer:point??old?.pointer,
          selectedIds:event.type==='commit'?event.elements?.map(el=>el.id):event.selectedIds})
        return next
      })
    })
    connection.current = next; void next.start()
    return () => { next.dispose(); connection.current = null }
  }, [session.documentId, session.apiUrl, session.userId, addEmote])
  useEffect(() => {
    const timer = setInterval(() => {
      setPeers(previous => new Map([...previous].filter(([, peer]) => Date.now() - (peer.at || 0) < 10_000)))
      connection.current?.sendPresence({ selectedIds: selection?.elementIds || [], avatar:avatarRef.current,viewport:followingId.current?undefined:viewport.current })
    }, 4000)
    return () => clearInterval(timer)
  }, [selection])
  useEffect(() => {
    if (!editor || !state?.scene) return
    const scene = connection.current?.optimistic() ?? state.scene
    const files = displayedStampFiles(scene)
    const elements = nativeElements(scene.elements, true, editingMind, stampCache)
    setStickers(stickerElements(elements as unknown as CanvasElement[], state.scene.elements))
    lastUI.current = snapshotElements(elements as unknown as CanvasElement[])
    const app = editor.getAppState()
    lastApp.current = { ...app, ...screenApp(state.scene.appState) }
    updating.current = true
    editor.updateScene({ elements, appState: { ...lastApp.current, scrollX: app.scrollX, scrollY: app.scrollY,
      zoom: app.zoom, selectedElementIds: app.selectedElementIds } as AppState, captureUpdate: CaptureUpdateAction.NEVER })
    // The native image cache discovers file IDs from the current scene on addFiles.
    editor.addFiles(Object.values(files) as unknown as BinaryFiles[keyof BinaryFiles][])
    updating.current = false
    prepareStampPaint(scene, files, stampCache, () => setStampPaint(v => v+1))
  }, [editor, state?.scene, editingMind, stampCache, stampPaint])
  useEffect(() => {
    if (!editor) return
    const collaborators = new Map<string, Collaborator>()
    if(showCursors) for (const [id, peer] of peers) collaborators.set(id, {
      username: peer.name || '协作者', pointer: peer.actorKind==='agent'?undefined:peer.pointer && { ...peer.pointer, tool: 'pointer' }, button: 'up',
      selectedElementIds: Object.fromEntries((peer.selectedIds || []).map(id => [id, true])),
      color: { background: peer.actorKind==='agent' ? '#ede9fe' : '#dbeafe', stroke: peer.actorKind==='agent' ? '#7c3aed' : '#2563eb' },
    })
    editor.updateScene({ collaborators: collaborators as never, captureUpdate: CaptureUpdateAction.NEVER })
  }, [editor, peers, showCursors])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (connection.current?.state.pending) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const onChange: NonNullable<ExcalidrawProps['onChange']> = useCallback((elements, appState, files) => {
    const client = connection.current, raw = client?.optimistic(), epoch = client?.state.snapshot?.collaborationEpoch
    if (!client || !raw || epoch === undefined || updating.current || appState.isLoading) return
    const carried = carriedPositions(lastUI.current, elements as unknown as CanvasElement[])
    const adjusted = carried.size ? elements.map(el => carried.has(el.id) ? newElementWith(el, carried.get(el.id)!) : el) : elements
    const next = adjusted as unknown as CanvasElement[]
    if (carried.size && nativeEditor.current) {
      updating.current = true
      try { nativeEditor.current.updateScene({ elements: adjusted, captureUpdate: CaptureUpdateAction.NEVER }) }
      finally { updating.current = false }
    }
    const motion = stickerElements(next, raw.elements)
    setStickers(previous => same(previous, motion) ? previous : motion)
    const camera = { x: appState.scrollX, y: appState.scrollY, zoom: appState.zoom.value }
    setCamera(previous => previous.x === camera.x && previous.y === camera.y && previous.zoom === camera.zoom ? previous : camera)
    const selectedIds = Object.keys(appState.selectedElementIds).filter(id => appState.selectedElementIds[id])
    const selected = selectedRegion(next, selectedIds)
    setSelection(previous => same(previous, selected) ? previous : selected)
    let box = nativeView.current?.box || null
    if (nativeView.current?.epoch !== epoch) {
      const savedBox = !nativeView.current && savedView?.epoch === epoch ? savedView.box : null
      box = savedBox && { ...savedBox, elementIds: savedBox.elementIds.filter(id => next.some(element => element.id === id && !element.isDeleted)) }
      updateRegionSelection(box)
    }
    const view={x:appState.width/(2*camera.zoom)-camera.x,y:appState.height/(2*camera.zoom)-camera.y,zoom:camera.zoom}
    if(!same(viewport.current,view)){viewport.current=view;if(!followingId.current)client.sendPresence({viewport:view,selectedIds,avatar:avatarRef.current})}
    saveView({ camera:followingId.current&&ownCamera.current?ownCamera.current:camera, epoch, selectedIds, box })
    if (sessionRef.current.scope === 'write' && permits(sessionRef.current, 'document.edit')) {
      const operations: Operation[] = changesFromUI(raw, lastUI.current, next)
      for (const [id, file] of Object.entries(files)) if (!raw.files[id]) operations.unshift({ op: 'file.add', id, file: file as unknown as CanvasFile })
      for (const key of ['viewBackgroundColor', 'gridSize'] as const) {
        if (key==='viewBackgroundColor' && appState[key]===paperBackground(raw.appState[key])) continue
        if (lastApp.current && !same(lastApp.current[key], appState[key])) operations.push({ op: 'scene.update', before: { [key]: raw.appState[key] ?? null }, changes: { [key]: appState[key] } })
      }
      client!.enqueue(operations)
    }
    lastUI.current = snapshotElements(next, lastUI.current)
    lastApp.current = { viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.gridSize }
  }, [savedView, saveView])
  const flush = async () => connection.current?.flush() ?? null
  const startDrawing = (brush:HandBrush) => {
    if(!editor || !canEdit) return
    setRegionSelection(null);setSelectingRegion(false)
    editor.setActiveTool({type:'freedraw'})
    editor.updateScene({appState:{selectedElementIds:{},currentItemStrokeColor:brush.color,currentItemStrokeWidth:brush.strokeWidth,currentItemOpacity:brush.opacity},captureUpdate:CaptureUpdateAction.NEVER})
  }
  const reactTo = async (ids:string[],kind:ReactionKind) => {
    await flush()
    await feedback.toggle(ids,kind)
  }
  const respondToSelection = (ids: string[], kind: ReactionKind) => {
    void reactTo(ids, kind).catch(cause => setNotice(String(cause)))
  }
  const stampSelection = async (kind: ReactionKind, ids = reactionIds) => {
    await flush()
    await feedback.toggle(ids, kind, true)
  }
  const stampAt = async (kind: ReactionKind, point: {x:number; y:number}, hit: string | null, size: number) => {
    const client = connection.current
    if (!client || !canEdit) return
    const all = client.optimistic()?.elements || []
    if (hit) {
      const element = all.find(element => element.id === hit)
      if (!element) throw new Error('元素已变化，请重新选择。')
      const group = Array.isArray(element.groupIds) && element.groupIds[0]
      const members = group ? all.filter(other => Array.isArray(other.groupIds) && other.groupIds[0] === group).map(other => other.id) : [hit]
      const ids = typeof element.containerId === 'string' ? [element.containerId] : reactionTargets(all, members)
      await stampSelection(kind,ids)
      return
    }
    const id='stamp-'+crypto.randomUUID()
    const dataURL=await stampPng(kind,session.displayName || session.userId)
    if (connection.current !== client || !canEdit) return
    const existing=Object.values(client.optimistic()?.files ?? {}).find(f=>f.mimeType==='image/png' && f.dataURL===dataURL)
    const fileId=existing?.id ?? crypto.randomUUID()
    const file:CanvasFile=existing ?? {id:fileId,mimeType:'image/png',dataURL,created:Date.now()}
    const records=convertToExcalidrawElements([{id,type:'image',fileId:fileId as BinaryFiles[keyof BinaryFiles]['id'],x:point.x-size/2,y:point.y-size/2,width:size,height:size,status:'saved',
      customData:{officeStamp:{kind},officeMaterial:{id:kind,category:kind.startsWith('emoji-')?'emoji':'reaction',catalogVersion:3}}}],{regenerateIds:false})
    client.enqueue([...(existing ? [] : [{op:'file.add' as const,id:fileId,file}]),...records.map(element=>({op:'element.add' as const,element:{...element,index:null} as unknown as CanvasElement}))])
    await client.flush()
  }
  const emoteAt = (kind: ReactionKind, point: {x:number; y:number}) => {
    const emote = {id:crypto.randomUUID(), kind, ...point}
    addEmote(emote)
    connection.current?.sendPresence({emote,avatar:avatarRef.current,pointer:point,selectedIds:selection?.elementIds || []})
  }
  const useMaterial = async (item:MaterialDetail,at?:BoardPoint) => {
    const client=connection.current
    if(!client || !editor || !canEdit) throw new Error('画布暂不可编辑。')
    if(item.category==='reaction' && isReaction(item.id)){await reactTo(reactionIds,item.id);return}
    if(isBrush(item.id)){
      editor.updateScene({appState:{openSidebar:null},captureUpdate:CaptureUpdateAction.NEVER})
      startDrawing(handBrush(item.id,item.palette));return
    }
    const expectedRevision=await client.flush()
    const planned=await (await api(sessionRef.current,'/canvas/materials/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      materialId:item.id,patchId:`material-${crypto.randomUUID()}`,expectedRevision,region:at?undefined:regionSelection?.region,
    })})).json() as { batch:Batch;collaborationEpoch:number }
    if(at){
      const records=planned.batch.operations.flatMap(op=>op.op==='element.add'?[op.element]:[])
      const anchor=records.find(el=>(el.customData as {officeMaterial?:unknown}|undefined)?.officeMaterial)
      if(!anchor)throw new Error('素材没有可放置的图形。')
      if(connection.current!==client||client.state.snapshot?.collaborationEpoch!==planned.collaborationEpoch)throw new Error('画布已切换，请重新放置。')
      const dx=at.x-anchor.x-anchor.width/2,dy=at.y-anchor.y-anchor.height/2
      const added=nativeElements(records.map(el=>({...el,x:el.x+dx,y:el.y+dy})))
      editor.updateScene({elements:[...editor.getSceneElementsIncludingDeleted(),...added],appState:{selectedElementIds:{[anchor.id]:true},openSidebar:null},captureUpdate:CaptureUpdateAction.IMMEDIATELY})
      transferBoardDrop(editor,[anchor.id],at,undefined,ops=>client.enqueue(ops),client.optimistic()?.elements||[])
      return
    }
    await client.append(planned.batch,planned.collaborationEpoch)
    const ids=new Set(planned.batch.operations.flatMap(op=>op.op==='element.add'?[op.element.id]:[]))
    const added=nativeElements(client.optimistic()?.elements.filter(e=>ids.has(e.id)) || [],true)
    setRegionSelection(null)
    editor.updateScene({appState:{openSidebar:null,selectedElementIds:Object.fromEntries(added.map(e=>[e.id,true as const]))},captureUpdate:CaptureUpdateAction.NEVER})
    editor.scrollToContent(added,{fitToViewport:true,maxZoom:1.4,animate:false})
  }
  useWorkflowPreparation(session, async () => {
    if (await flush() === null) throw new Error('请等待白板加载完成。')
  })
  const selectedReference = state?.scene?.elements.filter(element => !element.isDeleted && activeSelection?.elementIds.includes(element.id)).map(element => referenceFrom((element.customData as { officeResource?: unknown } | undefined)?.officeResource)).find(ref => !!ref)
  const editableReference = selectedReference && resourceWorkspace && findResourceSession(selectedReference, resourceWorkspace.sessions, session)?.scope === 'write'
  const stickerId = selectedStickerId(state?.scene?.elements || [], activeSelection?.elementIds)
  const selectedTransferLink = state?.scene?.elements.find(element => !element.isDeleted && activeSelection?.elementIds.includes(element.id)
    && typeof (element.customData as { officeTransfer?: unknown } | undefined)?.officeTransfer === 'string')
    ?.customData as { officeTransfer: string } | undefined
  const enterResource = async (reference: ResourceReference, ai = false) => {
    try { await flush(); await resourceWorkspace?.navigate(reference, sessionRef.current, ai) } catch (error) { setNotice(String(error)) }
  }
  const insertReference = async (reference: ResourceReference) => {
    if (!editor || !connection.current) throw new Error('画布尚未就绪。')
    await flush()
    const app = editor.getAppState(), id = `resource-${crypto.randomUUID()}`
    const elements = convertToExcalidrawElements([{ id, type: 'rectangle', x: -app.scrollX + app.width / app.zoom.value / 2 - 240,
      y: -app.scrollY + app.height / app.zoom.value / 2 - 170, width: 480, height: 340, link: `#officecli-resource:${id}`,
      strokeColor: 'transparent', backgroundColor: 'transparent', strokeWidth: 0, roundness: { type: 3 }, customData: { officeResource: reference } }]).map(element => ({ ...element, type: 'embeddable' as const }))
    connection.current.enqueue(elements.map(element => ({ op: 'element.add' as const, element: element as unknown as CanvasElement })))
    await flush()
    editor.updateScene({ elements: nativeElements(connection.current.optimistic()?.elements || [], true), appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.NEVER })
  }
  const ask = () => {
    setFocused(false)
    const snapshot = connection.current?.state.snapshot
    const targetVersion = snapshot ? { revision: snapshot.revision, collaborationEpoch: snapshot.collaborationEpoch } : undefined
    requestTask(activeSelection ? '整理选中的区域，保留其他区域。' : '在画布上整理我的想法。', activeSelection ? { canvas: activeSelection } : undefined, { targetVersion })
  }
  const organizeAsDocument = async () => {
    if (!activeSelection?.elementIds.length || !transfers) return
    try {
      await flush()
      const snapshot = connection.current?.state.snapshot
      if (!snapshot) throw new Error('画布尚未加载。')
      transfers.begin(sessionRef.current, { kind: 'canvas', revision: snapshot.revision, ...activeSelection }, snapshot.collaborationEpoch)
      setFocused(false)
      setPanelOpen(true)
    } catch (cause) { setNotice(String(cause)) }
  }
  const visitTransferSource = (link: string) => {
    if (transfers) void transfers.openSource(sessionRef.current, link).catch(cause => setNotice(String(cause)))
  }
  const appendComposition = async (composition: Composition) => {
    const client = connection.current
    if (!client || !editor) throw new Error('画布尚未就绪。')
    const revision = await client.flush()
    const planned = await (await api(sessionRef.current, '/canvas/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, patchId: `layout-${crypto.randomUUID()}`, composition, region: regionSelection?.region }) })).json() as { batch: Batch; collaborationEpoch: number }
    await client.append(planned.batch, planned.collaborationEpoch)
    const added = new Set(planned.batch.operations.flatMap(op => op.op === 'element.add' ? [op.element.id] : []))
    editor.scrollToContent(nativeElements(client.optimistic()?.elements.filter(element => added.has(element.id)) || []), { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 300 })
  }
  const askComposition = async (prompt: string, agentCount: number) => {
    setFocused(false)
    await runTask(prompt, {
      canvas: { elementIds: [], region: regionSelection?.region || { x: -100000000, y: -100000000, width: 200000000, height: 200000000 } },
      composition: { appendOnly: true, visualPlanning: true },
    }, agentCount, flush)
  }
  const exportScene = async (png: boolean) => {
    try {
      await flush()
      const scene = connection.current?.optimistic()
      if (!scene) return
      const name = (session.title || session.documentId).replace(/\.excalidraw$/i, '')
      const blob = png ? await exportToBlob({ elements: nativeElements(scene.elements), files: displayedStampFiles(scene) as unknown as BinaryFiles, appState: { ...editor?.getAppState(), viewBackgroundColor: String(scene.appState.viewBackgroundColor || '#ffffff'), exportBackground: true, exportWithDarkMode: false }, mimeType: 'image/png' }) : new Blob([JSON.stringify({...scene, elements:presentDiagramCards(scene.elements)}, null, 2)], { type: 'application/vnd.excalidraw+json' })
      download(blob, `${name}.${png ? 'png' : 'excalidraw'}`)
      if (exportMenu.current) exportMenu.current.open = false
    } catch (error) { setNotice(String(error)) }
  }
  const downloadSticker = async (id: string) => {
    try {
      const [, { exportSticker }] = await Promise.all([flush(), import('./stickerExport.tsx')])
      const file = exportSticker(connection.current?.optimistic()?.elements || [], id)
      download(file.blob, file.name)
      if (exportMenu.current) exportMenu.current.open = false
    } catch (error) { setNotice(String(error)) }
  }
  const openHistory = async () => {
    setFocused(false); setRightPanel('revisions')
    try {
      const result = await (await api(sessionRef.current, '/revisions')).json() as { revisions: Array<{ revision: number; authorName?: string }> }
      setHistory(result.revisions)
    } catch (error) { setNotice(String(error)) }
  }
  const restoreRevision = async (revision: number) => {
    try {
      const current = await flush()
      const epoch = connection.current?.state.snapshot?.collaborationEpoch
      await api(sessionRef.current, `/restore/${revision}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(epoch) }, body: JSON.stringify({ expectedRevision: current }) })
      await connection.current?.refresh(); closeRightPanel()
    } catch (error) { setNotice(String(error)) }
  }
  const aiAllowed = !session.hideNativeChat && permits(session, 'document.ai')
  const visibleSpecPeers=useMemo(()=>showCursors?specPeers(peers):[],[showCursors,peers])
  async function askSentence(selection:SpecSentence) {
    const client=connection.current
    if(!client)throw Error('白板仍在连接。')
    await client.flush()
    const snapshot=client.state.snapshot, saved=savedSentence(snapshot,selection)
    if(!snapshot || !saved || saved.expected!==selection.expected) throw Error('原句已经变化，请重新选择。')
    const version={revision:snapshot.revision,collaborationEpoch:snapshot.collaborationEpoch}
    if(session.hideNativeChat) {
      const target={documentId:session.documentId,...version,target:{kind:'spec' as const,...saved}}
      setPinnedSentence(target)
      reportSelection?.(target)
      try { await hostRewrite?.(target) } catch (error) { setPinnedSentence(null); throw error }
    } else {
      const el=snapshot.scene.elements.find(e=>e.id===saved.id)!
      setFocused(false)
      requestTask('请改写选中的这句话，使表达更清晰，保留原意。',{canvas:{elementIds:[el.id],region:{x:el.x,y:el.y,width:Math.max(1,el.width),height:Math.max(1,el.height)}},specSentence:{...saved,...version}}, {agentCount:1,targetVersion:version})
    }
  }
  async function undoSentence(ref:RewriteRef) {
    const client=connection.current
    if (!client || epoch===undefined) throw Error('白板仍在连接。')
    await client.flush()
    await api(session,'/canvas/spec-undo',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(epoch)},body:JSON.stringify(ref)})
    setReceipts(rewriteLog(session,epoch,{remove:ref.revision}))
    await client.refresh()
  }
  const agentsHere=[...peers.values()].filter(peer=>peer.actorKind==='agent').length
  const rightOpen = !focused && (panelOpen || rightPanel === 'revisions')
  const elementCount = useMemo(()=>{
    const objects=new Set<string>()
    for(const el of state?.scene?.elements||[]){
      if(el.isDeleted)continue
      const groups=el.groupIds
      const tag=(el.customData as {officeBoard?:{root:string}}|undefined)?.officeBoard
      objects.add(tag?.root || (Array.isArray(groups)&&groups.at(-1)) || el.containerId as string || el.id)
    }
    return objects.size
  },[state?.scene?.elements])
  const draftRecovery = !!state?.recovery.length && <CanvasDraftRecovery key={state.recovery[0].namespace} drafts={state.recovery} epoch={epoch} visible={visible} writable={canEdit} busy={state.pending}
      restore={async draft => { await connection.current?.recover(draft) }} />
  return <SpecCollaboration.Provider value={{peers:visibleSpecPeers,report:reportSpec,release:releaseSentence,active:visible,receipts,undo:undoSentence,rewrite:canEdit&&(aiAllowed || (session.hideNativeChat && !!hostRewrite))?askSentence:undefined}}><div ref={workspaceRef} className="workspace semantic-workspace canvas-workspace" data-format="excalidraw" data-layout={fill ? 'fill' : undefined} data-focus={focused} data-document-scope={session.scope} data-paused={stickerMotionPaused} data-canvas-document={session.documentId} data-canvas-revision={state?.snapshot?.revision}>
    <header className="editor-header canvas-header">
      {!fill && <div className="document-identity"><button className="icon-button back-library" aria-label="返回文档库" title="返回文档库" onClick={onClose}><ArrowLeft size={18} /></button><div className="document-title"><strong title={session.title || session.documentId}>{session.title || session.documentId}</strong><small>工作空间 / 自由画布 · r{state?.snapshot?.revision ?? '…'}</small></div><span className="status" role="status"><Check size={13} />{state?.status || '正在打开画布'}</span></div>}
      <div className="header-actions">{fill && draftRecovery}<details ref={peopleMenu} className="board-people"><summary aria-label="查看在线协作者"><span className="canvas-connection" data-connected={state?.connected} data-paused={stickerMotionPaused}>{avatar && <span className="canvas-self-avatar" data-avatar={avatar} aria-label="我的协作头像"><StickerIllustration motif={avatar} motion="auto"/></span>}{[...peers].filter(([,peer])=>isAvatar(peer.avatar)).slice(0,3).map(([id,peer])=><span key={id} className="canvas-self-avatar" title={peer.name || '协作者'} data-peer-avatar={peer.avatar}><StickerIllustration motif={peer.avatar!} motion="auto"/></span>)}<i />{state?.connected ? '实时协作已连接' : '正在连接协作'}<small>{peers.size + 1-agentsHere} 人{agentsHere>0 ? ' · '+agentsHere+' Agent' : ''}</small></span></summary><div className="board-people-list"><strong>在线协作者</strong><span>{session.displayName||session.userId||'我'} · 我</span>{[...peers].map(([id,peer])=><button key={id} disabled={!peer.viewport} aria-label={'跟随 '+peer.name} onClick={()=>follow(following===id?'':id)}>{peer.name||'协作者'}<small>{following===id?'返回我的视图':peer.actorKind==='agent'?'Agent':'跟随'}</small></button>)}</div></details><ShareControl /><AppearanceSelect />
        {resourceWorkspace && session.scope === 'write' && <button className="canvas-resource-insert" onClick={() => setResourcePicker(true)}><Plus size={16} />插入资源</button>}
        {session.scope === 'write' && permits(session, 'document.edit') && <button className="canvas-resource-insert" aria-label={session.hideNativeChat ? '画布排版' : 'AI 创作'} title={session.hideNativeChat ? '画布排版' : 'AI 创作'} disabled={!state?.ready || state.pending} onClick={() => setComposeOpen(true)}><Sparkles size={16} /><span>{session.hideNativeChat ? '画布排版' : 'AI 创作'}</span></button>}
        {session.scope === 'write' && <button className="icon-button canvas-save" aria-label="保存画布" title="保存画布" onClick={() => void flush().catch(error => setNotice(String(error)))}><Save size={17} /></button>}
        <HostPublicationControl session={session} revision={state?.snapshot?.revision ?? null} beforeSave={flush} />
        {aiAllowed && <button className="collaboration-trigger" aria-label="AI 协作" aria-pressed={panelOpen && !focused} onClick={() => { setFocused(false); setPanelOpen(!panelOpen || focused) }}><AgentCompanionMark size={20} state={busy ? 'active' : 'idle'} />协作</button>}
        <button className="icon-button focus-trigger" aria-label={focused ? '退出专注模式' : '专注模式'} title={focused ? '退出专注模式' : '专注模式'} aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
        {(permits(session, 'document.download') || permits(session, 'document.export')) && <details className="export-control canvas-export-control" ref={exportMenu}>
          <summary aria-label="导出画布"><ArrowUpRight size={16} />导出</summary>
          <div className="export-popover canvas-export-menu"><strong>导出画布</strong>
            {permits(session, 'document.download') && <button aria-label="画布文件" onClick={() => void exportScene(false)}><Download size={17} /><span>画布文件<small>保留对象，继续编辑</small></span></button>}
            {permits(session, 'document.export') && <button aria-label="PNG" onClick={() => void exportScene(true)}><FileImage size={17} /><span>PNG 图片<small>导出当前画布快照</small></span></button>}
            {permits(session, 'document.export') && stickerId && <button aria-label="导出所选贴纸 SVG" onClick={() => void downloadSticker(stickerId)}><FileImage size={17} /><span>所选贴纸 SVG<small>保留矢量与贴纸动效</small></span></button>}
          </div>
        </details>}
      </div>
    </header>
    {(state?.error || notice) && <div role="alert" className="canvas-notice"><span>{state?.error || notice}</span>{state?.pending && <><button onClick={() => void connection.current?.retry().catch(() => {})}>重试保存</button><button onClick={() => { const scene = connection.current?.optimistic(); if (scene) download(new Blob([JSON.stringify(scene)]), '画布草稿.excalidraw') }}>下载草稿</button><button onClick={() => void connection.current?.discard().catch(error => setNotice(String(error)))}>读取协作版本</button></>}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    <div className="layout editor-layout canvas-work-area">
      <main className="content-shell canvas-surface" aria-label="自由画布" data-inspecting={showStyles} data-paper={paperBackground(state?.scene?.appState.viewBackgroundColor)==='transparent'?'dots':undefined}
        style={{'--board-dot-step':Math.max(8,16*camera.zoom)+'px','--board-dot-x':camera.x*camera.zoom+'px','--board-dot-y':camera.y*camera.zoom+'px'} as React.CSSProperties}>
        {state?.scene && state.ready ? <Excalidraw excalidrawAPI={setEditor} initialData={initialData.current}
          onChange={onChange} theme={theme} langCode="zh-CN" name={session.title} isCollaborating viewModeEnabled={!canEdit} handleKeyboardGlobally={false}
          validateEmbeddable={link => link.startsWith('#officecli-resource:') ? true : undefined}
          renderEmbeddable={element => {
            const reference = referenceFrom(element.customData?.officeResource)
            if (reference) return <ResourceCard reference={reference} owner={session} />
            return element.customData?.officeResource || element.link?.startsWith('#officecli-resource:') ? <div className="resource-card">资源引用不可用</div> : null
          }}
          onLinkOpen={(element, event) => {
            const reference = referenceFrom(element.customData?.officeResource)
            if (reference) { event.preventDefault(); void enterResource(reference) }
            else if (element.link && decodeTransferLink(element.link)) { event.preventDefault(); visitTransferSource(element.link) }
            else if (!permits(sessionRef.current, 'document.copy')) event.preventDefault()
          }}
          renderTopRightUI={(mobile, app) => mobile && app.openSidebar ? null : (
            <CanvasCreationNavigator selectedIds={selectedIds} elements={state?.scene?.elements || []} motion={stickers.length ? { paused: stickerMotionPaused, toggle: () => setStickerMotionPaused(value => !value) } : undefined}
          onDraw={editor && canEdit ? startDrawing : undefined} onLocate={(id, section) => {
          if (!editor) return
          const all = editor.getSceneElements().filter(e => !e.isDeleted && e.id.startsWith(`${id}-`))
          const band = typeof section === 'number' ? all.find(e => e.customData?.officeDiagram && (e.customData.officeDiagram as { section?: number }).section === section) : undefined
          setPresentedTransferLink(all.find(element => element.link && decodeTransferLink(element.link))?.link || '')
          editor.scrollToContent(band ? [band] : all, { fitToViewport: true, viewportZoomFactor: 0.82, maxZoom: 1, animate: !matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 300 })
        }} />
          )}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false } }}
          onPointerUpdate={event => connection.current?.sendPresence({ pointer: event.pointer, viewport:followingId.current?undefined:viewport.current,avatar:avatarRef.current, selectedIds: selection?.elementIds || [], preview: event.button === 'down' && selection ? editor?.getSceneElements().filter(element => selection.elementIds.includes(element.id)) as unknown as CanvasElement[] : undefined })}
          onPointerUp={() => { queueMicrotask(() => { void flush().catch(() => {}) }) }}
        >
          <MainMenu>
            {fill && <MainMenu.Group><div className="canvas-file-summary">
              <strong>{session.title || session.documentId}</strong>
              <span role="status">{elementCount} 个对象 · r{state?.snapshot?.revision ?? '…'} · {state?.status || '正在连接'}</span>
              <DocumentVisitorIdentity />
            </div></MainMenu.Group>}
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
          <CanvasMaterialSidebar session={session} paused={stickerMotionPaused} canEdit={canEdit} selected={!!reactionIds.length && !!feedback.book}
          mine={reactionKinds.filter(k=>reactionIds.length && reactionIds.every(id=>feedback.book?.elements[id]?.[k]?.mine))}
          avatar={avatar} onAvatar={id=>{const next=isAvatar(id)?id:null;setAvatar(next);avatarRef.current=next;writeTabState(avatarKey,{id:next});window.dispatchEvent(new Event('officecli:canvas-avatar'));connection.current?.sendPresence({avatar:next,selectedIds:selection?.elementIds || []})}}
          onUse={useMaterial}/></Excalidraw> : <p className="embedded-loading">正在加载自由画布…</p>}
        <SpecPreview editor={editor} elements={state?.scene?.elements||[]} camera={camera} editing={editingSpec}/>
        {copiedObject&&<output className="board-follow" role="status">已复制对象链接</output>}
        {following&&<button className="board-follow" aria-label="停止跟随" onClick={()=>follow('')}>正在跟随 {peers.get(following)?.name}　×</button>}
        {editor&&<BoardWidgets scene={state?.scene?.elements||[]} editor={editor} camera={camera} editable={canEdit} feedback={feedback} onReact={respondToSelection}/>}
        {editor&&<CanvasCursorChat editor={editor} camera={camera} visible={visible} bubbles={bubbles} send={(chat,pointer)=>connection.current?.sendPresence({chat,pointer,avatar:avatarRef.current,selectedIds:selection?.elementIds||[]})}/>}
        <CanvasEmotes items={emotes} camera={camera} finish={removeEmote}/>
        {showCursors&&<CanvasPresenceLayer peers={peers} camera={camera} paused={stickerMotionPaused}/>}
        <CanvasReactions feedback={feedback} elements={state?.scene?.elements || []} camera={camera} editable={canEdit} onReact={respondToSelection}/>
        <CanvasStickers editor={editor} elements={stickers} camera={camera} paused={stickerMotionPaused} />

        {canEdit && permits(session,'document.ai') && <CanvasRegionPicker camera={camera} elements={state?.scene?.elements || []} value={regionSelection} selecting={selectingRegion} onChange={setRegionSelection} onFinish={() => setSelectingRegion(false)} />}
        {editor && <CanvasToolDock camera={camera} onEditSpec={setEditingSpec} onEditMind={setEditingMind} copyAllowed={permits(session,'document.copy')} elements={state?.scene?.elements||[]} epoch={epoch} onSpecChange={ops=>connection.current?.enqueue(ops)} flushSpec={flush} focused={focused} onFocus={()=>setFocused(v=>!v)} cursors={showCursors} onCursors={()=>setShowCursors(v=>!v)} paused={stickerMotionPaused} onMotion={()=>setStickerMotionPaused(v=>!v)} storageKey={identity&&JSON.stringify(['officecli-board-plugins',...identity])} onMaterial={useMaterial} editor={editor} writable={canEdit} visible={visible} author={session.displayName || session.userId || '协作者'}
          onToolChange={()=>{bumpTool(v=>v+1);setSelectingRegion(false)}}
          onAsk={canEdit && permits(session,'document.ai') ? (aiAllowed ? ask : () => {
            workspaceRef.current?.dispatchEvent(new CustomEvent('officecli:board-ai',{bubbles:true,detail:{documentId:session.documentId}}))
          }) : undefined}
          onRegion={canEdit && permits(session,'document.ai') ? ()=>{setRegionSelection(null);setSelectingRegion(true)} : undefined}
          onCompose={canEdit ? ()=>setComposeOpen(true) : undefined} onResource={canEdit&&resourceWorkspace?()=>setResourcePicker(true):undefined}
          onTemplate={appendComposition} onCopyLink={permits(session,'document.copy')?copyObjectLink:undefined} onError={e=>setNotice(String(e))}
          stamp={onEngage=><CanvasStampTool camera={camera} person={session.displayName||session.userId||'我'} recentKey={session.userId ? JSON.stringify(['officecli-recent-emoji',session.userId]):null} editor={editor} visible={visible} writable={canEdit} cancelSerial={toolRevision} onEngage={onEngage} targets={reactionIds} stamp={stampAt} react={stampSelection} emote={emoteAt} onError={cause=>setNotice(String(cause))}/>}
        />}
        {editor && (activeSelection || selectingRegion || presentedTransferLink) && <div className="canvas-selection-actions" style={activeSelection?.elementIds.length && editor.getAppState().width>720 ? {left:Math.max(0,Math.min((activeSelection.region.x+activeSelection.region.width/2+camera.x)*camera.zoom-120,editor.getAppState().width-345)),top:Math.max(56,Math.min((activeSelection.region.y+camera.y)*camera.zoom-51,editor.getAppState().height-121)),bottom:'auto',transform:'none'}:undefined}>
            {selection?.elementIds.length===1&&permits(session,'document.copy')&&<button aria-label="复制对象链接" className="canvas-region-action" title="复制对象链接" onClick={()=>copyObjectLink(selection.elementIds[0])}><Link2 size={14}/></button>}
            {canEdit&&!!selection?.elementIds.length&&<button className="canvas-region-action" title="对象样式" aria-label="对象样式" aria-pressed={showStyles} onClick={()=>setShowStyles(v=>!v)}><SlidersHorizontal size={15}/></button>}<span>{activeSelection ? (activeSelection.elementIds.length ? `已选中 ${activeSelection.elementIds.length} 个对象` : '已框选空白区域') : (canEdit ? '拖动画布 · 框选对象 · 自由绘制' : '拖动画布浏览')}</span>
            {canEdit && reactionIds.length > 0 && <CanvasReactionTools feedback={feedback} targets={reactionIds} onReact={respondToSelection} />}
            {canEdit && aiAllowed && <><button className="canvas-region-action" aria-pressed={selectingRegion} onClick={() => { if (regionSelection || selectingRegion) { setRegionSelection(null); setSelectingRegion(false) } else setSelectingRegion(true) }}>{regionSelection || selectingRegion ? '取消区域' : '框选区域'}</button>
            <button onClick={ask}><Sparkles size={15} />{activeSelection ? '让 AI 修改选区' : '与 AI 一起创作'}</button>
            {!!activeSelection?.elementIds.length && transfers && supportsTransfer(session) && <button className="canvas-region-action" onClick={() => void organizeAsDocument()}><Sparkles size={15} />整理为文档</button>}
            {transfers && (selectedTransferLink || !activeSelection && presentedTransferLink) && <button className="canvas-region-action" onClick={() => visitTransferSource(selectedTransferLink?.officeTransfer || presentedTransferLink)}>查看原文</button>}</>}
          </div>}
      </main>
      {selectedReference && resourceWorkspace && <div className="canvas-resource-actions"><button onClick={() => void enterResource(selectedReference)}>进入引用源文件</button>{editableReference && <button onClick={() => void enterResource(selectedReference, true)}><Sparkles size={14} />AI 编辑源内容</button>}</div>}
      {resourcePicker && <ResourcePicker owner={session} onInsert={insertReference} onClose={() => setResourcePicker(false)} />}
      {composeOpen && <CanvasComposePanel aiAllowed={aiAllowed} scoped={!!regionSelection} motionPaused={stickerMotionPaused} onAppend={appendComposition} onAsk={askComposition} onClose={() => setComposeOpen(false)} />}
      {aiAllowed && <AgentPanel beforeRun={flush} registerPreparation={false} resourcePanel={<CanvasResources scene={state?.scene || null} />} />}
      <WorkspacePanel side="right" hidden={rightPanel !== 'revisions' || focused} className="canvas-history" aria-label="画布历史版本">
        <div className="panel-head"><h2><History size={16} />历史版本</h2><button className="icon-button panel-close" aria-label="关闭历史" onClick={closeRightPanel}><PanelRightClose size={16} /></button></div><p>每次保存都保留独立修订。</p>
        {history.map(item => <div className="canvas-revision" key={item.revision}><span><strong>r{item.revision}</strong><small>{item.authorName || '导入'}</small></span>{session.scope === 'write' && permits(session, 'history.restore') && item.revision < (state?.snapshot?.revision || 0) && <button onClick={() => void restoreRevision(item.revision)}>恢复此版本</button>}</div>)}
      </WorkspacePanel>
      {(aiAllowed || permits(session, 'history.view')) && <div className="canvas-panel-controls" ref={panelControls}><WorkspacePanelControls side="right" open={rightOpen} onToggle={() => { setFocused(false); if (aiAllowed && lastRightPanel !== 'revisions') setPanelOpen(true); else void openHistory() }}>
        {aiAllowed && <button aria-label="协作" title="协作" aria-pressed={panelOpen && !focused} onClick={() => { setFocused(false); setPanelOpen(!panelOpen || focused) }}><AgentCompanionMark size={20} state={busy ? 'active' : 'idle'} /></button>}
        {permits(session, 'history.view') && <button aria-label="画布历史" title="画布历史" aria-pressed={rightPanel === 'revisions' && !focused} onClick={() => rightPanel === 'revisions' && !focused ? closeRightPanel() : void openHistory()}><History size={18} /></button>}
      </WorkspacePanelControls></div>}
    </div>
    {!fill && <footer className="editor-statusbar canvas-statusbar"><span><i className="status-dot" />自由画布 · {elementCount} 个对象</span><span>r{state?.snapshot?.revision ?? '…'} · {state?.status || '正在连接'}</span>{draftRecovery}<DocumentVisitorIdentity /><span className="canvas-keyboard-hint">空格拖动画布 · 滚轮缩放</span></footer>}
  </div></SpecCollaboration.Provider>
}
