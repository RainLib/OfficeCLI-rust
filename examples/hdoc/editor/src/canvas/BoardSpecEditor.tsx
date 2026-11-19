import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import {
  Sparkles, GripVertical,
  Undo2,
  Bold,
  Check,
  Code2,
  Italic,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Quote,
  Strikethrough,
  Underline,
  X,
} from 'lucide-react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CaptureUpdateAction,convertToExcalidrawElements,viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import { specElements, type BoardPoint } from './boardObjects'
import {
  fromBase64,
  openSpec,
  specBlocks,
  specRecord,
  specRemote,
  specTag,
  toBase64,
} from './specRichText'
import type { CanvasElement, Operation } from './model'
import {
  peerKey,
  presenceExtension,
  SpecCollaboration,
} from './specCollaboration'
import { placeTitleCaret, SpecTitleField } from './SpecTitleField'
import { selectionCursor, sentenceAt, type SpecCursor } from './specCoordinates'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import { attachmentSlots, SpecObjects } from './SpecAttachments'
import { detachBundle, hitsSpecAttachment } from './specTransfers'
import { SpecPaperPart } from './SpecPreview'
import { usePaintStack } from './paintStack'
import type { DragEvent as ReactDragEvent } from 'react'
import './spec-editor.css'

type Props = {
  id: string
  at: BoardPoint
  full?: boolean
  creating?: boolean
  editable: boolean
  canvas: ExcalidrawImperativeAPI
  camera: { x: number; y: number; zoom: number }
  clientPoint?: BoardPoint
  elements: readonly CanvasElement[]
  send: (ops: Operation[]) => void
  flush: () => Promise<unknown>
  close: (focusCanvas: boolean) => void
}
export function BoardSpecEditor(p: Props) {
  const collaboration = useContext(SpecCollaboration)
  const [working, setWorking] = useState(false)
  const [exporting,setExporting]=useState(false)
  const transfer=useRef<{nonce:string;drop:(point:BoardPoint)=>void}|null>(null)
  const atomic=useRef<Operation[]|null>(null)
  const bodyActive = useRef(false),
    titleSelection = useRef<SpecCursor | null>(null)
  const titleEl = p.elements.find(
    (e) =>
      specTag(e)?.root === p.id && specTag(e)?.part === 'title' && !e.isDeleted,
  )
  const bodyEl = p.elements.find(
    (e) =>
      specTag(e)?.root === p.id && specTag(e)?.part === 'body' && !e.isDeleted,
  )
  const root = p.elements.find((e) => e.id === p.id && !e.isDeleted)
  // Empty sheets appear at their final size before the first keystroke.
  const [initialParts] = useState(() => root && titleEl && bodyEl ? [root, titleEl, bodyEl]
    : specElements(p.id, p.at, '', '') as unknown as CanvasElement[])
  const current = useRef(p)
  current.current = p
  const [docs] = useState(() => ({
    title: openSpec(titleEl),
    body: openSpec(bodyEl),
  }))
  const created = useRef(!!root || !p.creating),
    closing = useRef(false),
    wrap = useRef<HTMLElement>(null),
    titleInput = useRef<HTMLTextAreaElement>(null)
  const [full, setFull] = useState(!!p.full),
    [title, setTitle] = useState(() => specBlocks(docs.title)[0] || ''),
    [issue, setIssue] = useState('')
  const [, refresh] = useState(0)
  const titleId = titleEl?.id ?? p.id + '-title',
    bodyId = bodyEl?.id ?? p.id + '-body'
  const seenRoot = useRef(!p.creating)
  if (root) seenRoot.current = true
  const gone = seenRoot.current && (!root || !titleEl || !bodyEl)
  const canWrite = p.editable && !gone && !root?.locked && !bodyEl?.locked
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        undoRedo: false,
        trailingNode: false,
        heading: { levels: [2, 3] },
        hardBreak: false,
        horizontalRule: false,
        link: false,
      }),
      Collaboration.configure({ document: docs.body, field: 'spec' }),
      presenceExtension(docs.body, bodyId),
      attachmentSlots,
    ],
    [docs, bodyId],
  )
  const rich = useEditor(
    {
      extensions,
      editable: canWrite,
      editorProps: {
        attributes: {
          'aria-label': '文档正文',
          'aria-multiline': 'true',
          role: 'textbox',
          class: 'spec-prose',
        },
      },
      onSelectionUpdate: () => refresh((n) => n + 1),
      onTransaction: () => refresh((n) => n + 1),
    },
    [docs],
  )
  const report = collaboration?.report,
    active = collaboration?.active,
    peers = collaboration?.peers
  useEffect(() => {
    if (!rich || rich.isDestroyed || !peers) return
    rich.view.dispatch(
      rich.state.tr.setMeta(peerKey, peers).setMeta('addToHistory', false),
    )
  }, [rich, peers, specRecord(bodyEl)?.update])
  useEffect(() => {
    if (!rich || !report || !active || gone) return
    const send = () => {
      if (bodyActive.current)
        report({
          id: bodyId,
          cursor: selectionCursor(docs.body, bodyId, rich.state),
        })
    }
    const focus = () => {
      bodyActive.current = true
      send()
    }
    if (bodyActive.current) send()
    else report({ id: titleId, cursor: titleSelection.current })
    rich.on('focus', focus).on('selectionUpdate', send).on('update', send)
    return () => {
      rich.off('focus', focus).off('selectionUpdate', send).off('update', send)
      report(null)
    }
  }, [rich, report, active, gone, docs, bodyId, titleId])
  useEffect(() => {
    rich?.setEditable(canWrite, false)
  }, [rich, canWrite])
  useEffect(() => {
    function listen(doc: Y.Doc, id: string, isTitle: boolean) {
      const receive = (bytes: Uint8Array, origin: unknown) => {
        if (isTitle) setTitle(specBlocks(doc)[0] || '')
        if (origin === specRemote || !current.current.editable) return
        const operations: Operation[] = []
        if (!created.current) {
          created.current = true
          for (const el of initialParts)
            operations.push({
              op: 'element.add',
              element: { ...el, index: null },
            })
        }
        operations.push({ op: 'spec.update', id, update: toBase64(bytes) })
        if(atomic.current)atomic.current.push(...operations)
        else current.current.send(operations)
      }
      doc.on('update', receive)
      return () => doc.off('update', receive)
    }
    const a = listen(docs.title, titleId, true),
      b = listen(docs.body, bodyId, false)
    return () => {
      a()
      b()
    }
  }, [docs, titleId, bodyId, initialParts])
  const titleState = specRecord(titleEl)?.update,
    bodyState = specRecord(bodyEl)?.update
  useEffect(() => {
    if (titleState)
      Y.applyUpdate(docs.title, fromBase64(titleState), specRemote)
  }, [docs, titleState])
  useEffect(() => {
    if (bodyState) Y.applyUpdate(docs.body, fromBase64(bodyState), specRemote)
  }, [docs, bodyState])
  const opened = useRef(false)
  useLayoutEffect(() => {
    if (!rich || opened.current) return
    const frame = requestAnimationFrame(() => {
      if (rich.isDestroyed || !wrap.current) return
      opened.current = true
      const { canvas, clientPoint: point } = current.current
      canvas.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER })
      const input = titleInput.current
      if (!input) return
      const titleBox = input.getBoundingClientRect()
      if (!point || (point.y >= titleBox.top && point.y <= titleBox.bottom && point.x >= titleBox.left && point.x <= titleBox.right)) {
        input.focus({ preventScroll: true })
        if (point) placeTitleCaret(input, point)
      } else {
        const box = rich.view.dom.getBoundingClientRect()
        const hit = rich.view.posAtCoords({
          left: Math.max(box.left + 1, Math.min(point.x, box.right - 1)),
          top: Math.max(box.top + 1, Math.min(point.y, box.bottom - 1)),
        })
        if (hit) rich.commands.setTextSelection(hit.pos)
        rich.view.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [rich])
  async function finish(selectPaper = true) {
    if (closing.current) return
    closing.current = true
    try {
      if (created.current && p.editable) await current.current.flush()
      if (!wrap.current) return
      if (selectPaper && created.current && !gone)
        p.canvas.updateScene({
          appState: { selectedElementIds: { [p.id]: true } },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      current.current.close(selectPaper)
    } catch {
      // The canvas journal and its recovery controls own a failed save.
      // Leaving text mode keeps the same durable draft available there.
      if (wrap.current) current.current.close(selectPaper)
    }
  }
  const latestFinish = useRef(finish)
  latestFinish.current = finish
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (
        !wrap.current ||
        wrap.current.contains(e.target as Node) ||
        !wrap.current.closest('.canvas-surface')?.contains(e.target as Node)
      )
        return
      // Edits already live in the canvas connection's durable queue.
      void latestFinish.current(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  useEffect(() => {
    const host = wrap.current
    const canvas = host?.closest('.canvas-surface')?.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive')
    if (full || !host || !canvas) return
    const attachmentDown = (e: PointerEvent) => {
      if (e.button !== 0 || !(e.target instanceof Element)) return
      const part = e.target.closest<HTMLElement>('.spec-edit-part')?.dataset.part
      if (!part) return
      const { canvas: api, id } = current.current, app = api.getAppState()
      const point = viewportCoordsToSceneCoords(e, app)
      if (!hitsSpecAttachment(api.getSceneElements(), id, part === 'body' ? bodyId : titleId, point, app.zoom.value)) return
      e.preventDefault()
      e.stopPropagation()
      void latestFinish.current(false)
      canvas.dispatchEvent(new PointerEvent('pointerdown', e))
    }
    const wheel = (e: WheelEvent) => {
      const part = e.target instanceof Element && e.target.closest<HTMLElement>('.spec-edit-part')
      if (!part) return
      e.preventDefault()
      e.stopPropagation()
      // Read further inside a fixed-size sheet until this column reaches an
      // edge. Ordinary board pan and pinch-zoom use Excalidraw's own handler.
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const previous = part.scrollTop
        const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? part.clientHeight : 1 / current.current.camera.zoom
        part.scrollTop += e.deltaY * units
        if (part.scrollTop !== previous) return
      }
      canvas.dispatchEvent(new WheelEvent('wheel', e))
    }
    host.addEventListener('wheel', wheel, { passive: false })
    host.addEventListener('pointerdown', attachmentDown, true)
    return () => {
      host.removeEventListener('wheel', wheel)
      host.removeEventListener('pointerdown', attachmentDown, true)
    }
  }, [full, bodyId, titleId])
  function stopDrag(){transfer.current=null;setExporting(false)}
  function startDrag(e:ReactDragEvent,drop:(point:BoardPoint)=>void){
    const nonce=crypto.randomUUID()
    transfer.current={nonce,drop}
    e.dataTransfer.effectAllowed='move'
    e.dataTransfer.setData('application/x-officecli-spec-move',nonce)
    requestAnimationFrame(()=>{if(transfer.current?.nonce===nonce)setExporting(true)})
  }
  useEffect(()=>{
    const surface=wrap.current?.closest('.canvas-surface')
    if(!surface)return
    const over=(e:Event)=>{
      const ev=e as DragEvent
      if(transfer.current&&ev.dataTransfer?.types.includes('application/x-officecli-spec-move')){
        ev.preventDefault();ev.stopPropagation();ev.dataTransfer.dropEffect='move'
      }
    }
    const drop=(e:Event)=>{
      const ev=e as DragEvent,active=transfer.current
      if(!active||ev.dataTransfer?.getData('application/x-officecli-spec-move')!==active.nonce)return
      ev.preventDefault();ev.stopPropagation()
      const within=wrap.current?.contains(ev.target as Node)
      stopDrag()
      if(within||!current.current.editable)return
      try{active.drop(viewportCoordsToSceneCoords(ev,current.current.canvas.getAppState()));void latestFinish.current(false)}
      catch(e){setIssue(e instanceof Error?e.message:String(e))}
    }
    surface.addEventListener('dragover',over,true);surface.addEventListener('drop',drop,true)
    return()=>{surface.removeEventListener('dragover',over,true);surface.removeEventListener('drop',drop,true)}
  },[])
  function beginTextDrag(e:ReactDragEvent){
    if(!canWrite || !rich || !created.current){e.preventDefault();return}
    const {state}=rich, sel=state.selection
    const from=sel.empty?sel.$from.before(1):sel.from, to=sel.empty?sel.$from.after(1):sel.to
    const original=state.doc.cut(from,to),text=original.textBetween(0,original.content.size,'\n')
    if(!text){e.preventDefault();return}
    const frag=docs.body.getXmlFragment('spec'), sync=ySyncPluginKey.getState(state)
    const a=absolutePositionToRelativePosition(from,frag,sync.binding.mapping), b=absolutePositionToRelativePosition(to,frag,sync.binding.mapping)
    e.dataTransfer.setData('text/plain',text)
    startDrag(e,point=>{
      const currentBody=current.current.elements.find(el=>el.id===bodyId)
      if(currentBody?.locked||rich.isDestroyed)throw Error('文档已锁定。')
      const {state}=rich, mapping=ySyncPluginKey.getState(state).binding.mapping
      const x=relativePositionToAbsolutePosition(docs.body,frag,a,mapping),y=relativePositionToAbsolutePosition(docs.body,frag,b,mapping)
      if(x===null||y===null||!state.doc.cut(x,y).eq(original))throw Error('所选内容刚被另一位协作者修改，请重新拖动。')
      const excerpt=new Y.Doc()
      prosemirrorToYXmlFragment(original,excerpt.getXmlFragment('spec'))
      const update=toBase64(Y.encodeStateAsUpdate(excerpt));excerpt.destroy()
      const [record]=convertToExcalidrawElements([{type:'text',...point,text,fontFamily:2,fontSize:18,
        customData:{officeSpecExcerpt:{text,update}}}])
      const ops:Operation[]=[{op:'element.add',element:{...record,index:null} as unknown as CanvasElement}]
      atomic.current=ops
      try{rich.view.dispatch(state.tr.deleteRange(x,y))}finally{atomic.current=null}
      current.current.send(ops)
    })
  }
  function captureTextSelection() {
    if (!rich || rich.isDestroyed) return
    const { view } = rich
    const selection = view.dom.ownerDocument.getSelection()
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !view.dom.contains(selection.anchorNode) ||
      !view.dom.contains(selection.focusNode)
    )
      return
    // The browser moves the caret before ProseMirror receives selectionchange.
    // A quick toolbar click must format the visible selection, including on touch.
    const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset)
    const head = view.posAtDOM(selection.focusNode, selection.focusOffset)
    const target = TextSelection.between(
      view.state.doc.resolve(anchor),
      view.state.doc.resolve(head),
    )
    if (!view.state.selection.eq(target))
      view.dispatch(
        view.state.tr.setSelection(target).setMeta('addToHistory', false),
      )
  }
  const action = async (fn: () => Promise<void>) => {
    if (working) return
    setWorking(true)
    setIssue('')
    try {
      await fn()
    } catch (e) {
      setIssue(String(e))
    } finally {
      setWorking(false)
    }
  }
  const selected = bodyActive.current
    ? !!rich &&
      !rich.state.selection.empty &&
      rich.state.selection.$from.sameParent(rich.state.selection.$to)
    : !titleEl?.locked &&
      !!titleSelection.current &&
      !!sentenceAt(docs.title, titleSelection.current)
  const rewrites =
    collaboration?.receipts
      .filter((r) => r.id === bodyId || r.id === titleId)
      .slice()
      .reverse() || []
  const mode = rich?.isActive('heading', { level: 2 })
    ? 'h2'
    : rich?.isActive('heading', { level: 3 })
      ? 'h3'
      : rich?.isActive('codeBlock')
        ? 'code'
        : 'p'
  const stack = usePaintStack(p.canvas)
  const sheet = root ?? initialParts[0], app = p.canvas.getAppState()
  const liveSheet = stack.find(el => el.id === sheet.id) ?? sheet
  const paperLeft = (liveSheet.x + p.camera.x) * p.camera.zoom
  const paperTop = (liveSheet.y + p.camera.y) * p.camera.zoom
  const paperWidth = liveSheet.width * p.camera.zoom
  const paperHeight = liveSheet.height * p.camera.zoom
  const partProps = { paper: sheet, stack, camera: p.camera, editor: p.canvas, full, editing: true }
  const railWidth = Math.max(1, Math.min(app.width - 16, Math.max(600, paperWidth)))
  const railLeft = Math.max(8, Math.min(app.width - railWidth - 8, paperLeft + (paperWidth - railWidth) / 2))
  // Put the strip outside the sheet when there is room. On a zoomed-in
  // sheet it docks just above the canvas tools, leaving the first line free.
  const barStyle = full ? undefined : paperTop >= 54
    ? { top: Math.min(app.height - 108, paperTop - 48) }
    : paperTop + paperHeight < app.height - 115
      ? { top: Math.max(8, paperTop + paperHeight + 6) }
      : { bottom: 72 }
  const commands = rich
    ? [
        {
          name: '粗体',
          icon: Bold,
          on: rich.isActive('bold'),
          run: () => rich.chain().focus().toggleBold().run(),
        },
        {
          name: '斜体',
          icon: Italic,
          on: rich.isActive('italic'),
          run: () => rich.chain().focus().toggleItalic().run(),
        },
        {
          name: '下划线',
          icon: Underline,
          on: rich.isActive('underline'),
          run: () => rich.chain().focus().toggleUnderline().run(),
        },
        {
          name: '删除线',
          icon: Strikethrough,
          on: rich.isActive('strike'),
          run: () => rich.chain().focus().toggleStrike().run(),
        },
        {
          name: '行内代码',
          icon: Code2,
          on: rich.isActive('code'),
          run: () => rich.chain().focus().toggleCode().run(),
        },
        {
          name: '无序列表',
          icon: List,
          on: rich.isActive('bulletList'),
          run: () => rich.chain().focus().toggleBulletList().run(),
        },
        {
          name: '有序列表',
          icon: ListOrdered,
          on: rich.isActive('orderedList'),
          run: () => rich.chain().focus().toggleOrderedList().run(),
        },
        {
          name: '引用',
          icon: Quote,
          on: rich.isActive('blockquote'),
          run: () => rich.chain().focus().toggleBlockquote().run(),
        },
      ]
    : []
  return (
    <section
      className={full ? "board-block-editor board-block-spec" : "board-spec-inline board-block-spec"}
      role="form"
      aria-label="编辑 Spec 文档"
      data-full={full}
      data-spec-id={p.id}
      data-exporting={exporting}
      ref={wrap}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (full) setFull(false)
          else void finish()
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          e.stopPropagation()
          void finish()
        }
      }}
    >
      {!full && !root && !gone && <div className="spec-new-paper" aria-hidden="true"
        style={{ left: paperLeft, top: paperTop, width: paperWidth, height: paperHeight }} />}
      <div className="spec-edit-rail" style={full ? undefined : { ...barStyle, left: railLeft, width: railWidth }}>
        <div className="spec-edit-bar">
          <header>
            {full && <strong>Spec 文档</strong>}
            {canWrite&&created.current&&<button type="button" draggable aria-label="拖出段落或选区" title="拖到画布以移出当前段落或选区" onPointerDown={captureTextSelection} onDragStart={beginTextDrag} onDragEnd={stopDrag}><GripVertical size={16}/></button>}
            <button
              type="button"
              aria-label={full ? '返回画布' : '全屏编辑'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFull(!full)}
            >
              {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            {full && <button
              type="button"
              aria-label="关闭编辑"
              onClick={() => void finish()}
            >
              <X size={16} />
            </button>}
          </header>
          {canWrite && (
            <div
              className="spec-format-tools"
              role="toolbar"
              aria-label="正文格式"
              onPointerDownCapture={captureTextSelection}
            >
              <select
                aria-label="块样式"
                value={mode}
                onChange={(e) => {
                  captureTextSelection()
                  const v = e.target.value
                  if (v === 'code') rich?.chain().focus().setCodeBlock().run()
                  else if (v === 'p') rich?.chain().focus().setParagraph().run()
                  else
                    rich
                      ?.chain()
                      .focus()
                      .setHeading({ level: v === 'h2' ? 2 : 3 })
                      .run()
                }}
              >
                <option value="p">正文</option>
                <option value="h2">二级标题</option>
                <option value="h3">三级标题</option>
                <option value="code">代码块</option>
              </select>
              {commands.map((c) => (
                <button
                  type="button"
                  key={c.name}
                  aria-label={c.name}
                  title={c.name}
                  aria-pressed={c.on}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    captureTextSelection()
                    c.run()
                  }}
                >
                  <c.icon size={15} />
                </button>
              ))}
            </div>
          )}
          <footer>
            {canWrite && collaboration?.rewrite && (
              <button
                type="button"
                className="spec-ai-action"
                aria-label="让全局 AI 改写选句"
                disabled={!selected || working}
                onPointerDown={captureTextSelection}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  void action(async () => {
                    captureTextSelection()
                    const cursor =
                      bodyActive.current && rich
                        ? selectionCursor(docs.body, bodyId, rich.state)
                        : titleSelection.current
                    const span =
                      cursor &&
                      sentenceAt(
                        cursor.id === bodyId ? docs.body : docs.title,
                        cursor,
                      )
                    if (!span) throw Error('请在同一段正文中选中要改写的文字。')
                    await collaboration.rewrite!(span)
                  })
                }
              >
                <Sparkles size={14} />
                <span>改写选句</span>
              </button>
            )}
            {canWrite && rewrites.length > 0 && (
              <button
                type="button"
                disabled={working}
                aria-label="撤销这次 AI 改写"
                title={'只撤销 r' + rewrites[0].revision + ' 的 AI 改写'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void action(() => collaboration!.undo(rewrites[0]))}
              >
                <Undo2 size={14} />
                <span>撤销 AI 改写</span>
              </button>
            )}
            <button type="button" aria-label={p.editable ? '完成' : '关闭'} onClick={() => void finish()}>
              <Check size={14} />
              <span>{p.editable ? '完成' : '关闭'}</span>
            </button>
          </footer>
        </div>
        {(issue || gone) && <p className="spec-edit-error" role="alert">{issue || '此文档已被移除。'}</p>}
      </div>
      <div className="spec-writing" onPointerDownCapture={collaboration?.release} onKeyDownCapture={e=>{if(e.key!=='Tab' && !(e.ctrlKey||e.metaKey))collaboration?.release()}}>
        <SpecPaperPart {...partProps} element={titleEl ?? initialParts[1]}>
          <SpecTitleField
            doc={docs.title}
            id={titleId}
            input={titleInput}
            value={title}
            readOnly={!canWrite || !!titleEl?.locked}
            peers={peers || []}
            report={(cursor) => {
              const changed =
                bodyActive.current ||
                JSON.stringify(titleSelection.current) !== JSON.stringify(cursor)
              bodyActive.current = false
              titleSelection.current = cursor
              if (active) report?.({ id: titleId, cursor })
              if (changed) refresh((n) => n + 1)
            }}
            onEnter={() => rich?.commands.focus('start')}
          />
        </SpecPaperPart>
        <SpecPaperPart {...partProps} element={bodyEl ?? initialParts[2]}>
          <div onDragStart={e=>{if(!transfer.current && rich&&!rich.state.selection.empty&&canWrite)beginTextDrag(e)}} onDragEnd={stopDrag}><EditorContent editor={rich} /></div>
        </SpecPaperPart>
        {rich&&<SpecObjects id={p.id} body={docs.body} rich={rich} elements={full ? p.elements : []} api={p.canvas} canWrite={canWrite} end={stopDrag} start={(e,bundle)=>startDrag(e,point=>detachBundle(p.canvas,p.id,bundle,point))}/>}
      </div>
    </section>
  )
}
