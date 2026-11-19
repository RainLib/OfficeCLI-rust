import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { StickyToolbar, noteTextStyle, type NoteFormat } from './StickyToolbar'
import { Check } from 'lucide-react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { boardTag, saveSticky, stickyFont, stickyInset, stickyLabel, stickySize } from './boardObjects'
import type { BoardDraft } from './BoardBlockEditor'

export function BoardStickyEditor({ draft, editor, author, paper, onClose, onNext, onCreate }: {
  draft: BoardDraft; editor: ExcalidrawImperativeAPI; author: string; paper: string
  onCreate:(id:string,point:{x:number;y:number})=>void
  onClose: () => void; onNext: (id: string) => void
}) {
  const all = editor.getSceneElements(), root = all.find(el => el.id === draft.id)
  const label = draft.id ? stickyLabel(all, draft.id) : undefined
  const original = useRef(label?.originalText ?? '')
  const initialBody = original.current.trim() ? original.current : ''
  const [body, setBody] = useState(initialBody)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null), form = useRef<HTMLFormElement>(null)
  const closed = useRef(false)
  const app = editor.getAppState(), z = app.zoom.value
  const x = root?.x ?? draft.at.x, y = root?.y ?? draft.at.y
  const width = root?.width ?? draft.width ?? stickySize
  const minimum = root?.height ?? draft.height ?? stickySize
  const [height, setHeight] = useState(minimum)
  const tag = boardTag(root), by = tag?.author || author
  const [format,setFormat] = useState<NoteFormat>(() => tag?.noteFormat ?? draft.format ?? {})
  const [shade,setShade] = useState(root?.backgroundColor ?? paper)
  const [signed,setSigned] = useState(tag?.showAuthor ?? true)
  const fontSize = format.size ?? label?.fontSize ?? stickyFont
  const [, refresh] = useState(0)
  useEffect(() => {
    let previous = ''
    return editor.onChange((els, state) => {
      const el = els.find(item => item.id === draft.id)
      const key = [state.scrollX, state.scrollY, state.zoom.value, el?.versionNonce, !!el?.isDeleted].join('/')
      if (key !== previous) { previous = key; refresh(i => i + 1) }
    })
  }, [draft.id, editor])
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  useLayoutEffect(() => {
    const field = input.current
    if (!field) return
    field.style.height = '1px'
    const content = field.scrollHeight
    field.style.height = content + 'px'
    setHeight(Math.max(minimum, content + stickyInset * 2 + (tag?.showAuthor !== false ? 24 : 0)))
  }, [body, width, fontSize, minimum, tag?.showAuthor])
  function finish(next = false) {
    if (closed.current) return
    const current = editor.getSceneElements()
    const sheet = current.find(el => el.id === draft.id)
    if (draft.id && !sheet) { setError('这张便利贴已被移除。可以复制草稿，或按 Esc 离开。'); return }
    let id = draft.id
    const styling = shade !== (sheet?.backgroundColor ?? paper) || JSON.stringify(format)!==JSON.stringify(tag?.noteFormat ?? {}) || signed !== (tag?.showAuthor ?? true)
    if ((body !== initialBody || styling || (!id && draft.creating)) && (id || body.trim() || draft.creating)) {
      if (id && (stickyLabel(current, id)?.originalText ?? '') !== original.current) {
        setError('正文刚被协作者修改。请复制草稿后重新打开。')
        return
      }
      id = saveSticky(editor, { x: sheet?.x ?? draft.at.x, y: sheet?.y ?? draft.at.y }, body, shade, author, height, sheet, width, format, signed)
      if(!sheet)onCreate(id,draft.at)
    }
    closed.current = true
    if (next && id) onNext(id)
    else onClose()
  }
  const latest = useRef(finish)
  latest.current = finish
  useEffect(() => {
    function outside(e: globalThis.PointerEvent) {
      if (form.current?.contains(e.target as Node)) return
      latest.current()
      if (!closed.current) { e.preventDefault(); e.stopImmediatePropagation(); input.current?.focus() }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  return <form ref={form} aria-label="编辑便利贴" className="board-note-editor"
    style={{ left: (x + app.scrollX) * z, top: (y + app.scrollY) * z, width: width * z }}
    onSubmit={e => { e.preventDefault(); finish() }}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        if (error) { closed.current = true; onClose() } else finish()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation(); finish(true)
      }
    }}>
    <div className="board-note-face" style={{ width, height, padding: stickyInset, transform: `scale(${z}) translate(${width/2}px, ${height/2}px) rotate(${root?.angle ?? 0}rad) translate(${-width/2}px, ${-height/2}px)`,
      backgroundColor: shade }}>
      <textarea ref={input} aria-label="便利贴内容" rows={1} spellCheck={false} placeholder="输入内容，@ 提及协作者"
        style={{ ...noteTextStyle(format,fontSize), lineHeight: label?.lineHeight ?? 1.15 }}
        value={body} onChange={e => setBody(e.target.value)} />
      {signed && <span className="board-note-author">{by}</span>}
    </div>
    <StickyToolbar color={shade} format={format} signed={signed} onColor={setShade} onFormat={setFormat} onSigned={()=>setSigned(v=>!v)}
      x={Math.max(4-(x+app.scrollX)*z,Math.min(width*z/2-160,app.width-(x+app.scrollX)*z-336))} y={-67}/>
    <button type="submit" className="board-note-done" aria-label="完成" title="完成"><Check size={15}/></button>
    {error && <span className="board-note-error" role="alert">{error}</span>}
  </form>
}
