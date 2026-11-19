import { useEffect, useRef, useState } from 'react'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardPoint } from './boardObjects'
import type { CanvasEvent } from './model'

export type CursorBubble = {
  agent?: boolean
  id: string
  client: string
  name: string
  text: string
  at: BoardPoint
  expires: number
}
type Props = {
  editor: ExcalidrawImperativeAPI
  visible: boolean
  camera: { x: number; y: number; zoom: number }
  bubbles: CursorBubble[]
  send: (chat: { id: string; text: string }, pointer: BoardPoint) => void
}
export function CanvasCursorChat({
  editor,
  visible,
  camera,
  bubbles,
  send,
}: Props) {
  const root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    pointer = useRef<BoardPoint>(undefined)
  const [writing, setWriting] = useState(false),
    [text, setText] = useState(''),
    [own, setOwn] = useState<CursorBubble | null>(null)
  const inChat = useRef(false),
    session = useRef(''),
    lastText = useRef(''),
    debounce = useRef<ReturnType<typeof setTimeout>>(undefined),
    expiry = useRef<ReturnType<typeof setTimeout>>(undefined),
    latest = useRef(send)
  latest.current = send
  const position = (v: BoardPoint) => ({
    left: (v.x + camera.x) * camera.zoom + 13,
    top: (v.y + camera.y) * camera.zoom + 17,
  })
  function finish(cancel = false) {
    if (!inChat.current) return
    inChat.current = false
    clearTimeout(debounce.current)
    clearTimeout(expiry.current)
    const v = cancel ? '' : lastText.current.trim(),
      at = pointer.current
    if (at) latest.current({ id: session.current, text: v }, at)
    setWriting(false)
    setOwn(
      v && at
        ? {
            id: session.current,
            client: 'self',
            name: '',
            text: v,
            at,
            expires: Date.now() + 4200,
          }
        : null,
    )
    if (v) expiry.current = setTimeout(() => setOwn(null), 4200)
    root.current?.parentElement
      ?.querySelector<HTMLElement>('.excalidraw')
      ?.focus({ preventScroll: true })
  }
  function edit(v: string) {
    v = Array.from(v).slice(0, 100).join('')
    setText(v)
    lastText.current = v
    clearTimeout(debounce.current)
    clearTimeout(expiry.current)
    debounce.current = setTimeout(() => {
      if (pointer.current)
        latest.current({ id: session.current, text: v }, pointer.current)
    }, 110)
    expiry.current = setTimeout(() => finish(false), 6000)
  }
  useEffect(() => {
    const surf = root.current?.parentElement
    if (!surf || !visible) return
    function move(e: PointerEvent) {
      if (!writing)
        pointer.current = viewportCoordsToSceneCoords(e, editor.getAppState())
    }
    function key(e: KeyboardEvent) {
      if (
        e.key !== '/' ||
        e.defaultPrevented ||
        e.isComposing ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        !surf?.checkVisibility() ||
        surf.closest('[inert]') ||
        editor.getAppState().editingTextElement
      )
        return
      if (
        e.target instanceof Element &&
        (e.target.closest(
          'input,textarea,[contenteditable=true],[role=dialog],.workspace-panel,.desk-ai',
        ) ||
          (e.target.closest('.hcd-surface') && !surf.contains(e.target)))
      )
        return
      e.preventDefault()
      e.stopImmediatePropagation()
      const s = editor.getAppState()
      pointer.current ??= {
        x: s.width / (2 * s.zoom.value) - s.scrollX,
        y: s.height / (2 * s.zoom.value) - s.scrollY,
      }
      inChat.current = true
      session.current = crypto.randomUUID()
      lastText.current = ''
      clearTimeout(expiry.current)
      setText('')
      setOwn(null)
      setWriting(true)
    }
    surf.addEventListener('pointermove', move)
    window.addEventListener('keydown', key, true)
    return () => {
      surf.removeEventListener('pointermove', move)
      window.removeEventListener('keydown', key, true)
    }
  }, [editor, visible, writing])
  useEffect(() => {
    if (writing) input.current?.focus({ preventScroll: true })
  }, [writing])
  useEffect(
    () => () => {
      clearTimeout(debounce.current)
      clearTimeout(expiry.current)
    },
    [],
  )
  return (
    <div className="board-cursor-chat" ref={root}>
      {[...bubbles, ...(own ? [own] : [])].map((b) => (
        <div
          key={b.client}
          className="board-chat-bubble"
          data-chat-client={b.client}
          data-agent={b.agent || undefined}
          style={position(b.at)}
        >
          {b.name && <b>{b.agent ? 'AI · ' : ''}{b.name}</b>}
          {b.text}
        </div>
      ))}
      {writing && pointer.current && (
        <input
          ref={input}
          aria-label="光标聊天"
          placeholder="说点什么…"
          maxLength={160}
          value={text}
          style={position(pointer.current)}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => finish(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              finish(e.key === 'Escape')
            }
          }}
        />
      )}
    </div>
  )
}
