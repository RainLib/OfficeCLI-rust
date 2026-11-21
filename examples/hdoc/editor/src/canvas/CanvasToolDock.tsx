import { boardShape, shapes, extraShapes, outlines, type ShapeKind } from './boardShapes'
import { BoardTableCell } from './BoardTableCell'
import { addMindNode, isMindNode, mindOwner, mindFields } from './mindMap'
import { MindMapTools, MindNodeEditor } from './MindMapTools'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  CaptureUpdateAction,
  newElementWith,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type {
  ExcalidrawImperativeAPI,
  AppState,
} from '@excalidraw/excalidraw/types'
import {
  ArrowRight,
  Check,
  CornerUpRight,
  Link2,
  Minus,
  Spline,
} from 'lucide-react'
import { BoardToolGlyph, BrushGlyph, boardTools, type BoardTool, type Brush } from './BoardToolGlyph'
import { useDockPopover } from './useDockPopover'
import { neighborSpot, type NoteDirection } from './sceneGeometry'
import { StickyToolbar, type NoteFormat, paperColors } from './StickyToolbar'
import { BuiltinEditor, BuiltinLayer, builtinOf, mediaShelf, placeBoardMedia, type BuiltinDraft, type BoardMedia } from './BoardBuiltins'
import { SpecDragLayer } from './SpecDragLayer'
import { transferBoardDrop } from './specTransfers'
import { BoardPaperLayer } from './BoardPaperLayer'
import { BoardStickyEditor } from './BoardStickyEditor'
import { BoardSpecEditor } from './BoardSpecEditor'
import type { CanvasElement, Operation } from './model'
import { BoardBlockEditor, type BoardDraft } from './BoardBlockEditor'
import {
  boardTag,
  insertBoardShapes,
  insertBoardTable, saveSticky,connectNotes,
  insertTape,
  stickySize,
  type BoardPoint,
  type TapePattern,
} from './boardObjects'
import diagrams from '../../../../../crates/canvas-core/fixtures/diagrams.json'
import type { Composition } from './model'
import {
  BoardInsertMenu,
  dockStickerById,
  type BoardWidget,
} from './BoardInsertMenu'
import { insertWidget,openMeetingTimer } from './BoardWidgets'
import type { MaterialDetail } from './materialCatalog'
import { BoardCommands } from './BoardCommands'
import './board-tool-dock.css'

type Placement =
  | 'sticky'
  | 'table'
  | 'spec'
  | 'comment'
  | 'shape'
  | 'tape'
  | 'material'
  | 'widget' | 'code' | 'mind' | 'link' | 'media'
const drawingTools = [
  ['marker', '记号笔'], ['highlighter', '荧光笔'], ['tape', '和纸胶带'], ['eraser', '橡皮擦'],
] as const
const toolMenus = new Set<BoardTool>(['pen', 'sticky', 'shapes', 'table', 'actions', 'insert'])
const inks = [
  ['墨黑', '#29282b'],
  ['红色', '#d34452'],
  ['橙色', '#e09243'],
  ['黄色', '#e3bf3c'],
  ['绿色', '#40936b'],
  ['蓝色', '#548acd'],
  ['紫色', '#8357c6'],
  ['白色', '#ffffff'],
]
const papers = paperColors
type Props = {
  camera: { x: number; y: number; zoom: number }
  onEditSpec: (id: string | null) => void
  onEditMind: (id: string | null) => void
  elements: readonly CanvasElement[]
  copyAllowed:boolean
  epoch: number | undefined
  onSpecChange:(ops:Operation[])=>void
  flushSpec:()=>Promise<unknown>

  focused: boolean
  onFocus: () => void
  cursors: boolean
  onCursors: () => void
  paused: boolean
  onMotion: () => void
  storageKey: string | null
  onMaterial: (item: MaterialDetail, point?: BoardPoint) => Promise<void>
  editor: ExcalidrawImperativeAPI
  writable: boolean
  visible: boolean
  author: string
  personId?: string
  people: import('./BoardMentions').BoardPerson[]
  linkedComment?: { rootId: string; messageId: string }
  stamp: (onEngage: () => void) => ReactNode
  onToolChange: () => void
  onAsk?: () => void
  onRegion?: () => void
  onCompose?: () => void
  onResource?: () => void
  onCopyLink?: (id: string) => void
  onTemplate: (c: Composition) => Promise<void>
  onError: (e: unknown) => void
}
const typed = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input,textarea,select,[contenteditable=true],[role=textbox],[role=dialog],.workspace-panel,.board-block-editor',
  )
function placeShape(
  editor: ExcalidrawImperativeAPI,
  shape: ShapeKind,
  a: BoardPoint,
  b: BoardPoint,
  fill: string,
  drag: boolean,
) {
  const x = drag ? Math.min(a.x, b.x) : a.x,
    y = drag ? Math.min(a.y, b.y) : a.y,
    w = drag ? Math.max(8, Math.abs(a.x - b.x)) : 110,
    h = drag ? Math.max(8, Math.abs(a.y - b.y)) : 88
  const { id, shape: element } = boardShape(shape, { x, y, width: w, height: h }, {
    backgroundColor: fill, fillStyle: 'solid', strokeColor: '#56545b', strokeWidth: 1.5, roughness: 0,
  })
  insertBoardShapes(editor, [element], id)
  return id
}
export function CanvasToolDock(props: Props) {
  const { editor, writable, visible, author } = props,
    current = useRef(props)
  current.current = props
  const surface = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null)
  const [native, setNative] = useState<string>(
      editor.getAppState().activeTool.type,
    ),
    [menu, setMenu] = useState<BoardTool | null>(null)
  const [minimized, setMinimized] = useState(false)
  const popup = useDockPopover<HTMLDivElement>(menu, minimized)
  const popupId = useId()
  const enterFromKeyboard = useRef(false)
  const focusPopup = () => {
    const panel = popup.ref.current
    const control = panel?.querySelector<HTMLElement>('input:not([type="color"]), button[aria-pressed="true"]') ??
      panel?.querySelector<HTMLElement>('button:not(:disabled)')
    control?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (menu && enterFromKeyboard.current) {
      focusPopup()
      enterFromKeyboard.current = false
    }
  }, [menu])
  const [moreShapes, setMoreShapes] = useState(false)
  const [placing, setPlacing] = useState<Placement | null>(null),
    [draft, setDraft] = useState<BoardDraft | null>(null)
  const [builtinDraft,setBuiltinDraft]=useState<BuiltinDraft | null>(null)
  const media=useRef<BoardMedia|null>(null)
  const editingDraft = useRef(draft)
  editingDraft.current = draft
  const editingMind = builtinDraft?.kind === 'mind' ? builtinDraft.id ?? null : null
  useLayoutEffect(() => {
    props.onEditMind(editingMind)
    return () => props.onEditMind(null)
  }, [props.onEditMind, editingMind])
  const editingSpec = draft?.kind === 'spec' ? draft.id ?? null : null
  useLayoutEffect(() => {
    props.onEditSpec(editingSpec)
    return () => props.onEditSpec(null)
  }, [props.onEditSpec, editingSpec])
  const [brush, setBrush] = useState<Brush>('marker'),
    [brushInks, setBrushInks] = useState({ marker: inks[0][1], highlighter: '#e3bf3c', tape: '#6252d7', eraser: inks[0][1] }),
    [thick, setThick] = useState(false),
    [paper, setPaper] = useState(papers[0][1])
  const ink = brushInks[brush]
  const [pattern, setPattern] = useState<TapePattern>('checker'),
    [shape, setShape] = useState<ShapeKind>('rectangle'),
    [fill, setFill] = useState('#ffffff'),
    [table, setTable] = useState([3, 3])
  const material = useRef<MaterialDetail | null>(null),
    widget = useRef<BoardWidget>('timer')
  const [highlight, setHighlight] = useState<BoardPoint | null>(null)
  const [selection, setSelection] = useState({ id: '', x: 0, y: 0 }),
    [dragEnd, setDragEnd] = useState<BoardPoint | null>(null)
  const start = useRef<BoardPoint | null>(null),
    trayDrag = useRef<{
      id: BoardTool
      point: BoardPoint
      moved: boolean
    } | null>(null),
    suppressClick = useRef(false)
  const local = (x: number, y: number) =>
    viewportCoordsToSceneCoords(
      { clientX: x, clientY: y },
      editor.getAppState(),
    )
  function dismiss() {
    setMenu(null)
    setPlacing(null)
    setHighlight(null)
    setDragEnd(null)
    start.current = null
  }
  function activateNative(
    type: Parameters<typeof editor.setActiveTool>[0]['type'],
  ) {
    if (type === 'custom') return
    editor.setActiveTool({ type, locked: type === 'freedraw' })
    setNative(type)
  }
  function applyBrush(value: Brush, color = brushInks[value], heavy = thick) {
    setBrush(value)
    setPlacing(value === 'tape' ? 'tape' : null)
    if (value === 'tape') {
      activateNative('selection')
      return
    }
    activateNative(value === 'eraser' ? 'eraser' : 'freedraw')
    if (value !== 'eraser')
      editor.updateScene({
        appState: {
          selectedElementIds: {},
          currentItemStrokeColor: color,
          currentItemStrokeWidth:
            value === 'highlighter' ? (heavy ? 14 : 8) : heavy ? 4 : 1.5,
          currentItemOpacity: value === 'highlighter' ? 36 : 100,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
  }
  function connector(route: 'sharp' | 'round' | 'elbow' | 'line') {
    setMenu(null)
    setPlacing(null)
    activateNative(route === 'line' ? 'line' : 'arrow')
    editor.updateScene({
      appState: {
        currentItemArrowType: route === 'line' ? 'sharp' : route,
        currentItemStrokeColor: '#54525b',
        currentItemOpacity: 100,
        currentItemStrokeWidth: 1.5,
        currentItemStartArrowhead: null,
        currentItemEndArrowhead: route === 'line' ? null : 'arrow',
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }
  function arm(tool: Placement) {
    activateNative('selection')
    setPlacing(tool)
  }
  function choose(tool: BoardTool) {
    if (
      tool !== 'hand' &&
      tool !== 'select' &&
      tool !== 'stamp' &&
      tool !== 'insert' &&
      tool !== 'actions' &&
      !writable
    )
      return
    props.onToolChange()
    setBuiltinDraft(null)
    setDraft(null)
    setDragEnd(null)
    setHighlight(null)
    const toggle = menu === tool ? null : tool
    setMenu(null)
    setPlacing(null)
    setMoreShapes(false)
    if (
      tool === 'select' ||
      tool === 'hand' ||
      tool === 'text' ||
      tool === 'section'
    ) {
      activateNative(
        tool === 'select' ? 'selection' : tool === 'section' ? 'frame' : tool,
      )
      return
    }
    if (tool === 'pen') {
      applyBrush(brush)
      setMenu(toggle)
      return
    }
    if (tool === 'sticky') {
      arm('sticky')
      setMenu(toggle)
      return
    }
    if (tool === 'shapes') {
      arm('shape')
      setMenu(toggle)
      return
    }
    if (tool === 'table') {
      arm('table')
      setMenu(toggle)
      return
    }
    if (tool === 'spec' || tool === 'comment') {
      arm(tool)
      return
    }
    if (tool === 'actions' || tool === 'insert') {
      setMenu(toggle)
      return
    }
  }
  const palette = (
    values: string[][],
    selected: string,
    set: (v: string) => void,
  ) => (
    <div className="board-swatches" role="group" aria-label="颜色">
      {values.map(([name, c]) => (
        <button
          type="button"
          aria-label={name}
          key={c}
          aria-pressed={selected === c}
          style={{ background: c }}
          onClick={() => set(c)}
        >
          {selected === c && (
            <Check size={12} color={c === '#29282b' ? 'white' : '#302d34'} />
          )}
        </button>
      ))}
      <label className="board-custom-color" title="自定义颜色">
        <input
          type="color"
          aria-label="自定义颜色"
          value={selected}
          onChange={(event) => set(event.target.value)}
        />
      </label>
    </div>
  )
  const focusCanvas = () =>
    surface.current?.parentElement
      ?.querySelector<HTMLElement>('.excalidraw')
      ?.focus({ preventScroll: true })
  function land(id:string,point:BoardPoint) {
    transferBoardDrop(editor,[id],point,undefined,current.current.onSpecChange,current.current.elements)
  }
  function place(tool: Placement, a: BoardPoint, b: BoardPoint, drag: boolean) {
    if (tool === 'tape') {
      start.current = null
      setDragEnd(null)
      land(insertTape(editor, a, drag ? b : { x: a.x + 130, y: a.y }, pattern, ink),b)
      focusCanvas()
      return
    }
    dismiss()
    activateNative('selection')
    focusCanvas()
    if(tool==='code'||tool==='link'||tool==='mind'){
      const id=tool==='mind'?addMindNode(editor,b):undefined
      if(id)land(id,b)
      setBuiltinDraft({kind:tool,id,at:b});return
    }
    if(tool==='media'){if(media.current)land(placeBoardMedia(editor,media.current,b),b);return}
    if (tool === 'widget') {
      land(insertWidget(editor, widget.current, b),b)
      return
    }
    if (tool === 'material') {
      if (material.current)
        void current.current
          .onMaterial(material.current, b)
          .catch(current.current.onError)
      return
    }
    if (tool === 'shape') {
      land(placeShape(editor, shape, a, b, fill, drag),b)
      return
    }
    if (tool === 'sticky') {
      land(saveSticky(editor, b, '', paper, author, stickySize), b)
      return
    }
    if (tool === 'table') {
      land(insertBoardTable(editor, b, table[0], table[1])+'-0-0',b)
      return
    }
    setDraft(tool==='spec'?{kind:'spec',at:b,id:'spec-'+crypto.randomUUID(),creating:true}:{kind:tool,at:b})
  }
  function onTrayDown(e: ReactPointerEvent<HTMLButtonElement>, id: BoardTool) {
    if (
      e.button !== 0 ||
      !writable ||
      !['sticky', 'shapes', 'spec', 'table'].includes(id)
    )
      return
    trayDrag.current = {
      id,
      point: { x: e.clientX, y: e.clientY },
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onTrayMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = trayDrag.current
    if (!drag) return
    if (Math.hypot(e.clientX - drag.point.x, e.clientY - drag.point.y) > 7) {
      drag.moved = true
      setMenu(null)
      setHighlight({ x: e.clientX, y: e.clientY })
    }
  }
  function onTrayUp(e: ReactPointerEvent<HTMLButtonElement>) {
    const drag = trayDrag.current
    trayDrag.current = null
    setHighlight(null)
    if (!drag?.moved) return
    suppressClick.current = true
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (
      !surface.current?.parentElement?.contains(target) ||
      shell.current?.contains(target)
    )
      return
    const p = local(e.clientX, e.clientY)
    props.onToolChange()
    place(drag.id === 'shapes' ? 'shape' : (drag.id as Placement), p, p, false)
  }
  const cell = useRef('')
  const openObject = useRef<(id: string, point?: BoardPoint, focusMessage?: string) => void>(() => {})
  function openById(id: string, clientPoint?: BoardPoint, focusMessage?: string) {
    const all = editor.getSceneElements(),
      el = all.find((e) => e.id === id),
      tag = boardTag(el)
    const mind = mindOwner(all,el)
    if (mind && writable && !mind.locked) {
      const body = mindFields(all,mind).body
      const point = clientPoint && viewportCoordsToSceneCoords({clientX:clientPoint.x,clientY:clientPoint.y},editor.getAppState())
      const field = body && point && point.y >= body.y && point.y <= body.y + body.height ? 'body' : 'title'
      dismiss()
      setBuiltinDraft({id:mind.id,kind:'mind',at:mind,field,clientPoint})
      return
    }
    const built=builtinOf(el)
    if(el&&built&&writable&&!el.locked){dismiss();setBuiltinDraft({id:el.id,kind:built.kind,at:el});return}
    if (!el || !tag || !['spec', 'table', 'comment', 'sticky'].includes(tag.kind) || (tag.kind === 'sticky' && !writable)) return
    dismiss()
    setDraft({
      kind: tag.kind as BoardDraft['kind'],
      id: tag.kind === 'spec' ? tag.root : id,
      at: { x: el.x, y: el.y },
      clientPoint,
      focusMessage,
    })
  }
  openObject.current = openById
  useEffect(() => {
    const link = props.linkedComment
    if (link) openObject.current(link.rootId, undefined, link.messageId)
  }, [props.linkedComment])
  useEffect(() => {
    const el = surface.current?.closest<HTMLElement>('.canvas-surface')
    if (!el || !visible) return
    const hit = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLCanvasElement)) return
      const pos = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        editor.getAppState(),
      )
      return [...editor.getSceneElements()].reverse().find((e) => {
        const b = boardTag(e)
        return (
          (isMindNode(e) || builtinOf(e) || b && ['spec', 'table', 'comment', 'sticky'].includes(b.kind) && !b.part?.startsWith('reply')) &&
          pos.x >= e.x &&
          pos.y >= e.y &&
          pos.x <= e.x + e.width &&
          pos.y <= e.y + e.height
        )
      })
    }
    let tap: { id: string; x: number; y: number; pointer: number } | undefined
    const pointer = (event: PointerEvent) => {
      tap = undefined
      const app = editor.getAppState()
      if (!current.current.writable || event.button !== 0 || !event.isPrimary || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || app.activeTool.type !== 'selection') return
      const element = hit(event), kind = boardTag(element)?.kind
      cell.current = kind === 'table' ? element!.id : ''
      if (element && !element.locked && (kind === 'table' || kind === 'sticky'))
        tap = { id: element.id, x: event.clientX, y: event.clientY, pointer: event.pointerId }
    }
    const cancel = () => { tap = undefined }
    const move = (event: PointerEvent) => {
      if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 4) cancel()
    }
    const release = (event: PointerEvent) => {
      const start = tap
      cancel()
      if (start && event.pointerId === start.pointer && hit(event)?.id === start.id && Math.hypot(event.clientX-start.x,event.clientY-start.y) <= 4)
        openObject.current(start.id, {x:event.clientX, y:event.clientY})
    }
    const double = (event: MouseEvent) => {
      const e = hit(event),
        tag = boardTag(e)
      if(e && (isMindNode(e) || builtinOf(e))){event.preventDefault();event.stopImmediatePropagation();openObject.current(e.id,{x:event.clientX,y:event.clientY});return}
      if (!tag || !e) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openObject.current(tag.kind === 'spec' ? tag.root : e.id, { x: event.clientX, y: event.clientY })
    }
    el.addEventListener('pointerdown', pointer, true)
    el.addEventListener('pointermove', move, true)
    el.addEventListener('pointercancel', cancel, true)
    el.addEventListener('pointerup', release, true)
    el.addEventListener('dblclick', double, true)
    return () => {
      el.removeEventListener('pointerdown', pointer, true)
      el.removeEventListener('pointermove', move, true)
      el.removeEventListener('pointercancel', cancel, true)
      el.removeEventListener('pointerup', release, true)
      el.removeEventListener('dblclick', double, true)
    }
  }, [editor, visible])
  const observe = useCallback(
    (state: AppState) => {
      setNative((v) =>
        v === state.activeTool.type ? v : state.activeTool.type,
      )
      const ids = state.selectedElementIds
      if (!Object.keys(ids).length) {
        setSelection((old) => (old.id ? { id: '', x: 0, y: 0 } : old))
        return
      }
      const els = editor.getSceneElements(),
        e = els.find((el) => ids[el.id] && boardTag(el)),
        data = boardTag(e)
      const id =
        data?.kind === 'sticky' && Object.keys(ids).length === 1 || data?.kind === 'comment'
          ? e!.id
          : data?.kind === 'spec' ? data.root
          : data?.kind === 'table'
            ? ids[cell.current]
              ? cell.current
              : e!.id
            : ''
      const root = els.find((el) => el.id === id)
      const x = root ? (root.x + state.scrollX) * state.zoom.value : 0,
        y = root ? (root.y + state.scrollY) * state.zoom.value : 0
      setSelection((old) =>
        old.id === id && old.x === x && old.y === y ? old : { id, x, y },
      )
    },
    [editor],
  )
  useEffect(() => {
    observe(editor.getAppState())
    return editor.onChange((_, state) => observe(state))
  }, [editor, observe])
  function nextSticky(id: string, direction: NoteDirection = 'right', drop?:BoardPoint, edit=false) {
    const all = editor.getSceneElements(), source = all.find(el => el.id === id)
    if (!writable || !source || source.locked || boardTag(source)?.kind !== 'sticky') return false
    if (drop) {
      const target=[...all].reverse().find(el=>el.id!==id && !el.locked && ['rectangle','ellipse','diamond'].includes(el.type) &&
        !['spec','comment'].includes(boardTag(el)?.kind || '') && drop.x>=el.x && drop.x<=el.x+el.width && drop.y>=el.y && drop.y<=el.y+el.height)
      if (target) {connectNotes(editor,id,direction,target.id);return true}
    }
    const spot = neighborSpot(source, direction, all.filter(el =>
      el.id !== id && boardTag(el)?.kind === 'sticky' && el.type === 'rectangle'), edit)
    const {width,height}=spot, x=drop?drop.x-width/2:spot.x, y=drop?drop.y-height/2:spot.y
    const app = editor.getAppState(), z = app.zoom.value
    const sx = Math.min(Math.max(app.scrollX, 18/z-x), Math.max(18/z-x,(app.width-18)/z-x-width))
    const sy = Math.min(Math.max(app.scrollY, 48/z-y), Math.max(48/z-y,(app.height-80)/z-y-height))
    if (sx !== app.scrollX || sy !== app.scrollY)
      editor.updateScene({ appState: { scrollX: sx, scrollY: sy }, captureUpdate: CaptureUpdateAction.NEVER })
    dismiss()
    setPaper(source.backgroundColor)
    const tag=boardTag(source)
    const next=saveSticky(editor,{x,y},'',source.backgroundColor,author,height,undefined,width,tag?.noteFormat)
    if(drop)connectNotes(editor,id,direction,next)
    transferBoardDrop(editor,[next],{x:x+width/2,y:y+height/2},undefined,props.onSpecChange,props.elements)
    setDraft(edit ? {kind:'sticky',id:next,at:{x,y}} : null)
    if(!edit)focusCanvas()
    return true
  }
  const keyActions = useRef({ choose, applyBrush, connector, dismiss, nextSticky, openById })
  keyActions.current = { choose, applyBrush, connector, dismiss, nextSticky, openById }
  useEffect(() => {
    if (!visible) return
    const surfaceEl = surface.current?.closest('.canvas-surface')
    function keys(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      const closingPanel = key === 'escape' && e.target instanceof Element && shell.current?.contains(e.target)
        ? e.target.closest<HTMLElement>('.board-tool-popup') : null
      if (
        !surfaceEl?.checkVisibility() ||
        surfaceEl.closest('[inert]') ||
        e.isComposing ||
        e.altKey ||
        e.defaultPrevented ||
        (typed(e.target) && !closingPanel) ||
        editor.getAppState().editingTextElement
      )
        return
      if (
        e.target instanceof Element &&
        e.target.closest('.hcd-surface,.desk-ai') &&
        !surfaceEl.contains(e.target)
      )
        return
      if(key===String.fromCharCode(96)&&writable&&!editingDraft.current&&!e.ctrlKey&&!e.metaKey){e.preventDefault();e.stopImmediatePropagation();setMenu(null);arm('code');return}
      const selectedId = Object.keys(editor.getAppState().selectedElementIds)
      if (key === 'enter' && !editingDraft.current && writable && selectedId.length === 1 &&
        boardTag(editor.getSceneElements().find(el => el.id === selectedId[0]))?.kind === 'sticky') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (e.ctrlKey || e.metaKey) keyActions.current.nextSticky(selectedId[0])
        else keyActions.current.openById(selectedId[0])
        return
      }
      if (e.ctrlKey || e.metaKey) {
        if (key === 'k' && !e.shiftKey) {
          e.preventDefault()
          e.stopImmediatePropagation()
          keyActions.current.choose('actions')
        }
        return
      }
      if (key === 'escape') {
        if (closingPanel) {
          const trigger = shell.current?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(closingPanel.id)}"]`)
          e.preventDefault()
          e.stopImmediatePropagation()
          // Returning to selection can focus the native canvas during React's commit.
          requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
        }
        keyActions.current.dismiss()
        if (['freedraw', 'eraser'].includes(editor.getAppState().activeTool.type)) {
          editor.setActiveTool({ type: 'selection' })
        }
        return
      }
      const map: Record<string, BoardTool> = {
        v: 'select',
        h: 'hand',
        m: 'pen',
        s: e.shiftKey ? 'section' : 'sticky',
        t: 'text',
        c: 'comment',
        r: 'shapes',
        o: 'shapes',
        '+': 'insert',
        '=': 'insert',
      }
      const erase = e.shiftKey && (key === 'delete' || key === 'backspace')
      if (!(key in map) && !['x', 'l', 'w'].includes(key) && !erase) return
      if (!writable && !['v', 'h', '+', '='].includes(key)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (key === 'x' || key === 'l') {
        current.current.onToolChange()
        keyActions.current.dismiss()
        keyActions.current.connector(
          key === 'x' || e.shiftKey ? 'elbow' : 'sharp',
        )
        return
      }
      if (key === 'm' || key === 'w' || erase) {
        current.current.onToolChange()
        keyActions.current.dismiss()
        keyActions.current.applyBrush(
          erase ? 'eraser' : key === 'w' ? 'tape' : e.shiftKey ? 'highlighter' : 'marker',
        )
        setMenu('pen')
        return
      }
      if (key === 'r' || key === 'o')
        setShape(key === 'r' ? 'rectangle' : 'ellipse')
      keyActions.current.choose(map[key])
      if (key !== '+' && key !== '=') setMenu(null)
    }
    window.addEventListener('keydown', keys, true)
    return () => window.removeEventListener('keydown', keys, true)
  }, [editor, visible, writable])
  useEffect(() => {
    if (!menu) return
    function outside(e: PointerEvent) {
      const target = e.target
      if (!(target instanceof Element) || shell.current?.contains(target)) return
      const drawing = target instanceof HTMLCanvasElement || target.closest('.board-placement[data-tool="tape"]')
      if (menu === 'pen' && drawing && surface.current?.parentElement?.contains(target)) return
      setMenu(null)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [menu])
  useEffect(() => {
    const el = surface.current?.closest<HTMLElement>('.canvas-surface')
    if (!visible || !writable || !el) return
    const over = (event: DragEvent) => {
      if (
        event.dataTransfer?.types.includes('application/x-officecli-sticker')
      ) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const drop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData('application/x-officecli-sticker')
      if (!id || shell.current?.contains(event.target as Node)) return
      const item = dockStickerById(id)
      if (!item) return
      event.preventDefault()
      event.stopPropagation()
      setMenu(null)
      setPlacing(null)
      const point = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        editor.getAppState(),
      )
      void current.current
        .onMaterial(item, point)
        .catch(current.current.onError)
    }
    el.addEventListener('dragover', over, true)
    el.addEventListener('drop', drop, true)
    return () => {
      el.removeEventListener('dragover', over, true)
      el.removeEventListener('drop', drop, true)
    }
  }, [editor, visible, writable])
  const selected = selection.id
      ? editor.getSceneElements().find((el) => el.id === selection.id)
      : undefined,
    block = boardTag(selected)
  function editBlock(full = false) {
    if (
      !selected ||
      !block ||
      !['spec', 'table', 'comment', 'sticky'].includes(block.kind)
    )
      return
    dismiss()
    setDraft({
      kind: block.kind as BoardDraft['kind'],
      id: selected.id,
      at: { x: selected.x, y: selected.y },
      full,
    })
  }
  function styleSticky(patch: { color?: string; format?: NoteFormat }) {
    if (!selected || block?.kind !== 'sticky' || selected.locked || !writable) return
    editor.updateScene({ elements: editor.getSceneElementsIncludingDeleted().map(el => el.id !== selected.id ? el :
      newElementWith(el, { ...(patch.color && {backgroundColor:patch.color}), customData:{...el.customData,officeBoard:{
        ...boardTag(el), ...(patch.format && {noteFormat:patch.format}) }} })),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    if (patch.color) setPaper(patch.color)
  }
  function fitSpec() {
    if (!selected || !writable) return
    const parts = editor
      .getSceneElements()
      .filter((el) => boardTag(el)?.root === selected.id && el.type === 'text')
    const h = Math.max(
      110,
      ...parts.map(el => {
        const preview = boardTag(el)?.part === 'body' &&
          shell.current?.closest('.canvas-surface')?.querySelector<HTMLElement>(`[data-spec-root="${CSS.escape(selected.id)}"]`)
        return el.y + (preview ? Math.max(el.height, preview.scrollHeight) : el.height) - selected.y + 28
      }),
    )
    editor.updateScene({
      elements: editor
        .getSceneElementsIncludingDeleted()
        .map((el) =>
          el.id === selected.id ? newElementWith(el, { height: h }) : el,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
  }
  const active =
    placing === 'shape'
      ? 'shapes'
      : placing === 'tape'
        ? 'pen'
        : placing ||
          (
            {
              selection: 'select',
              hand: 'hand',
              freedraw: 'pen',
              eraser: 'pen',
              text: 'text',
              frame: 'section',
              arrow: 'shapes',
              line: 'shapes',
              rectangle: 'shapes',
              ellipse: 'shapes',
              diamond: 'shapes',
            } as Record<string, string>
          )[native]
  const openMaterials = () => {
    dismiss()
    editor.toggleSidebar({
      name: 'default',
      tab: 'office-materials',
      force: true,
    })
  }
  const tableRows = table[0],
    tableCols = table[1]
  return (
    <>
      <div className="board-dock-anchor" ref={surface} />
      <SpecDragLayer api={editor} elements={props.elements} writable={writable&&visible} send={props.onSpecChange}/>
      <BuiltinLayer api={editor} copyAllowed={props.copyAllowed} edit={setBuiltinDraft} writable={writable} showTools={visible&&!draft&&!placing&&!builtinDraft}/>
      <MindMapTools api={editor} edit={setBuiltinDraft} enabled={writable && visible && !draft && !placing && !builtinDraft && !menu && native==='selection'}/>
      {builtinDraft?.kind==='mind' && builtinDraft.id && writable && <MindNodeEditor key={builtinDraft.id} api={editor} id={builtinDraft.id} field={builtinDraft.field} clientPoint={builtinDraft.clientPoint} edit={setBuiltinDraft}
        close={focus=>{setBuiltinDraft(null);if(focus)focusCanvas()}}/>}
      {builtinDraft&&builtinDraft.kind!=='mind'&&writable&&<BuiltinEditor key={builtinDraft.id||builtinDraft.kind} api={editor} draft={builtinDraft} onCreate={land} close={()=>{setBuiltinDraft(null);focusCanvas()}}/>}
      <BoardPaperLayer peekComments={draft?.kind==='comment'} personId={props.personId} onPinDrop={(id,point,origin)=>transferBoardDrop(editor,[id],point,origin,props.onSpecChange,props.elements)} editor={editor} onNeighbor={nextSticky} selected={selection.id} editing={draft?.kind === 'sticky' ? draft.id : undefined}
        canPoint={visible && !placing && !draft && native === 'selection'} writable={writable}
        open={id => { editor.updateScene({appState:{selectedElementIds:{[id]:true}},captureUpdate:CaptureUpdateAction.NEVER}); openById(id) }}/>
      {placing && !draft && (
        <div
          className="board-placement"
          aria-label="画布放置区"
          data-tool={placing}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            start.current = local(e.clientX, e.clientY)
            e.currentTarget.setPointerCapture(e.pointerId)
            if (placing !== 'tape') setMenu(null)
          }}
          onPointerMove={(e) => {
            if (placing === 'sticky') setHighlight({ x: e.clientX, y: e.clientY })
            else if (start.current) setDragEnd(local(e.clientX, e.clientY))
          }}
          onPointerLeave={() => { if (placing === 'sticky') setHighlight(null) }}
          onPointerCancel={() => {
            setHighlight(null)
            start.current = null
            setDragEnd(null)
          }}
          onPointerUp={(e) => {
            if (!start.current) return
            const a = start.current,
              b = local(e.clientX, e.clientY)
            place(
              placing,
              a,
              b,
              Math.hypot(b.x - a.x, b.y - a.y) *
                editor.getAppState().zoom.value >
                4,
            )
          }}
        >
          {dragEnd &&
            start.current &&
            (() => {
              const s = editor.getAppState(),
                a = start.current,
                b = dragEnd,
                z = s.zoom.value
              return (
                <i
                  className="board-marquee"
                  style={{
                    left: (Math.min(a.x, b.x) + s.scrollX) * z,
                    top: (Math.min(a.y, b.y) + s.scrollY) * z,
                    width: Math.max(2, Math.abs(b.x - a.x) * z),
                    height: Math.max(2, Math.abs(b.y - a.y) * z),
                  }}
                />
              )
            })()}
        </div>
      )}
      {highlight && (placing === 'sticky' || trayDrag.current?.id === 'sticky') ?
        <div className="board-sticky-ghost" aria-hidden="true" style={{ left: highlight.x, top: highlight.y,
          width: stickySize, height: stickySize, background: paper, transform: `scale(${editor.getAppState().zoom.value})` }}/> : highlight && (
        <div
          className="board-tray-ghost"
          style={{ left: highlight.x - 15, top: highlight.y - 21 }}
        >
          <BoardToolGlyph
            tool={trayDrag.current?.id || 'sticky'}
            paper={paper}
          />
        </div>
      )}
      {draft?.kind==='spec' && draft.id && <BoardSpecEditor key={draft.id+':'+props.epoch} canvas={editor} camera={props.camera} id={draft.id} at={draft.at} clientPoint={draft.clientPoint} full={draft.full} creating={draft.creating} editable={writable} elements={props.elements} send={props.onSpecChange} flush={props.flushSpec} close={focus=>{if(editingDraft.current?.id===draft.id){setDraft(null);if(focus)focusCanvas()}}}/>}
      {draft?.kind === 'sticky' && writable && <BoardStickyEditor key={[draft.id,draft.at.x,draft.at.y].join(':')}
        draft={draft} editor={editor} author={author} people={props.people} paper={paper} onCreate={land} onNext={id=>nextSticky(id,'right',undefined,true)}
        onClose={() => { setDraft(null); focusCanvas() }}/>}
      {draft?.kind === 'table' && draft.id && writable && <BoardTableCell key={draft.id} id={draft.id} editor={editor} onCell={openById} onClose={()=>{setDraft(null);focusCanvas()}}/>}
      {draft?.kind === 'comment' && (
        <BoardBlockEditor
          key={[draft.kind, draft.id, draft.at.x, draft.at.y].join(':')}
          draft={draft}
          people={props.people} personId={props.personId} onCreate={land}
          editor={editor}
          author={author}
          writable={writable}
          onClose={() => {
            setDraft(null)
            focusCanvas()
          }}
        />
      )}
      {block?.kind === 'sticky' && selected && writable && !selected.locked && !draft && !placing &&
        <StickyToolbar key={selected.id} color={selected.backgroundColor} format={block.noteFormat||{}}
          x={Math.max(4,Math.min(selection.x+selected.width*editor.getAppState().zoom.value/2-195,editor.getAppState().width-396))}
          y={Math.max(4,selection.y-66)} onColor={color=>styleSticky({color})} onFormat={format=>styleSticky({format})}
          onEdit={()=>editBlock()} onNext={()=>nextSticky(selected.id)}/>}
      {block && block.kind!=='sticky' && block.kind!=='table' && selected && !draft && !placing && (
        <div
          className="board-object-bar"
          style={{
            left: Math.max(
              8,
              Math.min(selection.x, editor.getAppState().width - 188),
            ),
            top: Math.max(6, selection.y - 43),
          }}
        >
          {block.kind === 'spec' && (
            <>
              <button onClick={() => editBlock()}>编辑文档</button>
              {writable && <button onClick={fitSpec}>适应内容</button>}
              <button onClick={() => editBlock(true)}>全屏</button>
            </>
          )}
          {props.onCopyLink && (
            <button
              title="复制对象链接"
              aria-label="复制对象链接"
              onClick={() => props.onCopyLink?.(selected.id)}
            >
              <Link2 size={14} />
            </button>
          )}
          {block.kind === 'comment' && (
            <button onClick={() => editBlock()}>
              {block.resolved ? '已解决 · 查看评论' : '打开评论'}
            </button>
          )}
        </div>
      )}
      <div className="board-dock-shell" data-minimized={minimized} ref={shell}>
        {minimized && (
          <button
            className="board-restore-dock"
            onClick={() => setMinimized(false)}
          >
            显示工具栏
          </button>
        )}
        <div
          className="board-dock-strip"
          role="toolbar"
          aria-label="白板工具栏"
        >
          {boardTools.map((group, i) => (
            <div className="board-dock-group" key={i}>
              {group.map((t) =>
                t.id === 'stamp' ? (
                  <div
                    key={t.id}
                    onPointerDownCapture={() => {
                      dismiss()
                      setDraft(null)
                    }}
                  >
                    {props.stamp(() => {
                      dismiss()
                      setDraft(null)
                    })}
                  </div>
                ) : (
                  <button
                    type="button"
                    key={t.id}
                    className="board-tool"
                    data-tool={t.id}
                    aria-label={t.name}
                    title={t.name + (t.key ? ' (' + t.key + ')' : '')}
                    aria-keyshortcuts={
                      t.id === 'actions' ? 'Meta+K Control+K' : t.key
                    }
                    aria-pressed={menu === t.id || active === t.id}
                    aria-expanded={toolMenus.has(t.id) ? menu === t.id : undefined}
                    aria-controls={menu === t.id ? popupId : undefined}
                    disabled={
                      !writable &&
                      !['select', 'hand', 'insert', 'actions'].includes(t.id)
                    }
                    onPointerDown={(e) => onTrayDown(e, t.id)}
                    onKeyDown={e => {
                      if (e.key !== 'ArrowUp' || !toolMenus.has(t.id)) return
                      e.preventDefault()
                      if (menu === t.id) focusPopup()
                      else {
                        enterFromKeyboard.current = true
                        choose(t.id)
                      }
                    }}
                    onPointerMove={onTrayMove}
                    onPointerUp={onTrayUp}
                    onPointerCancel={() => {
                      trayDrag.current = null
                      setHighlight(null)
                    }}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false
                        return
                      }
                      choose(t.id)
                    }}
                  >
                    <BoardToolGlyph tool={t.id} paper={paper} ink={ink} brush={brush} />
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
        {popup.displayed && (
          <div
            key={popup.displayed}
            id={popupId}
            ref={popup.ref}
            className={'board-tool-popup board-popup-' + popup.displayed}
            data-dock-popover={popup.closing ? 'closing' : 'open'}
            inert={popup.closing}
            role="region"
            aria-label={
              boardTools.flat().find((t) => t.id === popup.displayed)?.name + '选项'
            }
          >
            {popup.displayed === 'pen' && (
              <>
                <div className="board-brush-rack" role="group" aria-label="笔型">
                  {drawingTools.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={label}
                      title={label}
                      aria-pressed={brush === id}
                      onClick={() => applyBrush(id)}
                    >
                      <span className="board-brush-well"><BrushGlyph brush={id} ink={brushInks[id]} /></span>
                    </button>
                  ))}
                </div>
                {brush === 'tape' ? (
                  <div className="board-patterns">
                    {(
                      [
                        ['checker', '棋盘格'],
                        ['grid', '方格'],
                        ['stripe', '条纹'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        aria-label={label}
                        title={label}
                        aria-pressed={pattern === id}
                        onClick={() => setPattern(id)}
                      >
                        <i data-pattern={id} />
                      </button>
                    ))}
                  </div>
                ) : (
                  brush !== 'eraser' && (
                    <div className="board-brush-weights" role="group" aria-label="笔画粗细">
                      {[false, true].map((v) => (
                        <button
                          key={String(v)}
                          aria-label={v ? '粗' : '细'}
                          title={v ? '粗' : '细'}
                          aria-pressed={thick === v}
                          onClick={() => {
                            setThick(v)
                            applyBrush(brush, ink, v)
                          }}
                        >
                          <i className={v ? 'weight-thick' : 'weight-thin'} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )
                )}
                {brush !== 'eraser' &&
                  palette(inks, ink, (c) => {
                    setBrushInks(colors => ({ ...colors, [brush]: c }))
                    applyBrush(brush, c)
                  })}
              </>
            )}
            {popup.displayed === 'sticky' && palette(papers, paper, setPaper)}
            {popup.displayed === 'shapes' && (
              <>
                {palette(papers, fill, setFill)}
                <div className="board-shape-grid">
                  {(
                    [
                      ['elbow', '折线连接', CornerUpRight],
                      ['round', '曲线连接', Spline],
                      ['sharp', '直线连接', ArrowRight],
                      ['line', '无箭头连接', Minus],
                    ] as const
                  ).map(([id, label, Icon]) => (
                    <button
                      key={id}
                      title={label}
                      aria-label={label}
                      onClick={() => connector(id)}
                    >
                      <Icon />
                    </button>
                  ))}
                </div>
                <div className="board-shape-grid">
                  {shapes.map(([id, label]) => (
                    <button
                      key={id}
                      title={label}
                      aria-label={label}
                      aria-pressed={shape === id}
                      onClick={() => {
                        setShape(id)
                        arm('shape')
                        setMenu(null)
                      }}
                    >
                      <i className={'board-shape-icon ' + id} />
                    </button>
                  ))}
                </div>
                <div className="board-choice-line">
                  <button
                    onClick={() => {
                      setMenu(null)
                      void props
                        .onTemplate(diagrams.mindmap as Composition)
                        .catch(props.onError)
                    }}
                  >
                    思维导图
                  </button>
                  <button
                    aria-expanded={moreShapes}
                    onClick={() => setMoreShapes(!moreShapes)}
                  >
                    更多形状
                  </button>
                </div>
                {moreShapes && (
                  <div className="board-shape-grid">
                    {extraShapes.map(([id, name]) => (
                      <button
                        key={id}
                        title={name}
                        aria-label={name}
                        onClick={() => {
                          setShape(id)
                          setMenu(null)
                          arm('shape')
                        }}
                      >
                        <svg viewBox="0 0 24 24">
                          <polygon
                            points={outlines[id]!.map(
                              ([x, y]) => 2 + x * 20 + ',' + (2 + y * 20),
                            ).join(' ')}
                            fill="none"
                            stroke="currentColor"
                          />
                        </svg>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {popup.displayed === 'table' && (
              <>
                <strong>
                  {tableRows} × {tableCols}
                </strong>
                <div className="board-table-picker">
                  {Array.from({ length: 36 }, (_, n) => {
                    const row = Math.floor(n / 6) + 1,
                      col = (n % 6) + 1
                    return (
                      <button
                        key={n}
                        aria-label={row + ' 行 ' + col + ' 列'}
                        data-on={row <= tableRows && col <= tableCols}
                        onPointerEnter={() => setTable([row, col])}
                        onFocus={() => setTable([row, col])}
                        onClick={() => {
                          setTable([row, col])
                          setMenu(null)
                          arm('table')
                        }}
                      />
                    )
                  })}
                </div>
              </>
            )}
            {popup.displayed === 'actions' && (
              <BoardCommands
                editor={editor}
                writable={writable}
                author={author}
                close={() => {
                  dismiss()
                  focusCanvas()
                }}
                minimized={minimized}
                toggleMin={() => setMinimized((v) => !v)}
                focused={props.focused}
                toggleFocus={props.onFocus}
                cursors={props.cursors}
                toggleCursors={props.onCursors}
                paused={props.paused}
                toggleMotion={props.onMotion}
                ask={props.onAsk}
                compose={props.onCompose}
                region={props.onRegion}
                undo={(redo) => {
                  const button =
                    surface.current?.parentElement?.querySelector<HTMLButtonElement>(
                      redo
                        ? '[data-testid="button-redo"]'
                        : '[data-testid="button-undo"]',
                    )
                  button?.click()
                }}
              />
            )}
            {popup.displayed === 'insert' && (
              <BoardInsertMenu
                writable={writable}
                storageKey={props.storageKey}
                close={() => setMenu(null)}
                openLibrary={openMaterials}
                onTemplate={props.onTemplate}
                onResource={props.onResource}
                more={id=>{if(id==='spec')choose('spec');else if(id==='timer'){dismiss();openMeetingTimer(editor)}else if(id!=='media')arm(id)}}
                media={mediaShelf(editor)} onMedia={item=>{media.current=item;setMenu(null);arm('media')}}
                onImage={() =>
                  editor.setActiveTool({
                    type: 'image',
                    insertOnCanvasDirectly: true,
                  })
                }
                onLibraryFile={(file) =>
                  editor.updateLibrary({
                    libraryItems: file,
                    merge: true,
                    prompt: false,
                    openLibraryMenu: true,
                  })
                }
                onMaterial={(item) => {
                  material.current = item
                  setMenu(null)
                  arm('material')
                }}
                onWidget={(value) => {
                  widget.current = value
                  setMenu(null)
                  arm('widget')
                }}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
