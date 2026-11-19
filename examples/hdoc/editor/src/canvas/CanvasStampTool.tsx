import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StampPlacement } from './StampPlacement'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Stamp, X } from 'lucide-react'
import { ReactionGlyph } from './CanvasReactions.tsx'
import { StampPicker } from './StampPicker'
import { useDockPopover } from './useDockPopover'
import { reactionNames } from './materialCatalog.ts'
import type { CanvasEmote, ReactionKind } from './model.ts'

type Point = { x: number; y: number }
type Props = {
  editor: ExcalidrawImperativeAPI
  person: string
  camera: Point & { zoom: number }
  recentKey: string | null
  cancelSerial: number
  onEngage: () => void
  visible: boolean
  writable: boolean
  targets: string[]
  stamp: (kind: ReactionKind, point: Point, hit: string | null, size: number) => Promise<void>
  react: (kind: ReactionKind) => Promise<void>
  emote: (kind: ReactionKind, point: Point) => void
  onError: (error: unknown) => void
}
const ignoresShortcuts = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input, textarea, select, [contenteditable=true], [role=textbox], [role=dialog], .workspace-panel',
  )
export function CanvasStampTool(props: Props) {
  const { editor, visible, writable, targets } = props
  const [open, setOpen] = useState(false),
    [armed, setArmed] = useState(false)
  const [kind, setKind] = useState<ReactionKind>('thumbsUp')
  const [temporary, setTemporary] = useState(!writable)
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null)
  const wheel = useDockPopover<HTMLElement>(open ? 'stamp' : null)
  const shell = root.current?.closest('.board-dock-shell')
  const current = useRef(props)
  current.current = props
  function dismiss() {
    setOpen(false)
    setArmed(false)
  }
  useEffect(() => {
    setOpen(false)
    setArmed(false)
  }, [props.cancelSerial])
  function choose(next: ReactionKind) {
    setKind(next)
    setOpen(false)
    setArmed(true)
    editor.setActiveTool({ type: 'selection' })
    trigger.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!visible) {
      setOpen(false)
      setArmed(false)
      return
    }
    function keys(event: KeyboardEvent) {
      if (
        !root.current?.checkVisibility() ||
        !!root.current.closest('[inert]') ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        ignoresShortcuts(event.target) ||
        editor.getAppState().editingTextElement
      )
        return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.hcd-surface') &&
        !root.current?.closest('.canvas-workspace')?.contains(target)
      )
        return
      if (event.key.toLowerCase() === 'e' && !event.repeat) {
        event.preventDefault()
        event.stopImmediatePropagation()
        current.current.onEngage()
        setOpen(!open)
        setArmed(!open)
        editor.setActiveTool({ type: 'selection' })
      } else if ((open || armed) && event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        dismiss()
        trigger.current?.focus()
      } else if (
        armed &&
        !temporary &&
        event.key === 'Enter' &&
        current.current.targets.length
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void current.current.react(kind).catch(current.current.onError)
      }
    }
    window.addEventListener('keydown', keys, true)
    return () => window.removeEventListener('keydown', keys, true)
  }, [visible, editor, open, armed, kind, temporary])
  useEffect(() => {
    if (!open) return
    const panel = wheel.ref.current
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !panel?.contains(event.target) &&
        !root.current?.contains(event.target)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  const surface = root.current?.closest('.canvas-surface')
  return (
    <div className="canvas-stamp-tool" ref={root} data-armed={armed}>
      <button
        className="stamp-trigger"
        data-tool="stamp"
        ref={trigger}
        aria-label="盖章与即时表情"
        aria-expanded={open}
        aria-keyshortcuts="E"
        title="盖章与即时表情 (E)"
        aria-pressed={armed}
        onClick={() => {
          props.onEngage()
          setOpen(!open)
          setArmed(!open)
          editor.setActiveTool({ type: 'selection' })
        }}
      >
        {armed ? (
          <ReactionGlyph kind={kind} size={17} person={props.person} />
        ) : (
          <Stamp size={17} />
        )}{' '}
        <span>{armed ? reactionNames[kind] : '盖章'}</span>
      </button>
      {wheel.displayed &&
        shell &&
        createPortal(
          <section
            ref={wheel.ref}
            className="stamp-wheel"
            data-dock-popover={wheel.closing ? 'closing' : 'open'}
            inert={wheel.closing}
            aria-label="印章选择器"
          >
            <StampPicker
              selected={kind}
              person={props.person}
              recentKey={props.recentKey}
              writable={writable}
              temporary={temporary}
              setTemporary={setTemporary}
              choose={choose}
              close={() => {
                dismiss()
                trigger.current?.focus()
              }}
            />
          </section>,
          shell,
        )}
      {armed && visible && surface && createPortal(
        <StampPlacement key={kind} editor={editor} kind={kind} person={props.person} temporary={temporary || !writable}
          camera={props.camera} exit={dismiss} place={(at, hit, emote, size) => {
            if (emote) current.current.emote(kind, at)
            else void current.current.stamp(kind, at, hit, size).catch(current.current.onError)
          }} />, surface)}
      {armed && !open &&
        shell &&
        createPortal(
          <div className="stamp-instruction" role="status">
            <span>
              {temporary
                ? '点击画布发送即时表情'
                : targets.length
                  ? '点按盖章 · Enter 回应选区'
                  : '点按元素或空白处盖章'}
            </span>
            <button aria-label="退出盖章" onClick={dismiss}>
              <X size={12} />
            </button>
          </div>,
          shell,
        )}
    </div>
  )
}

function EmoteBurst({
  emote,
  camera,
  finish,
}: {
  emote: CanvasEmote
  camera: { x: number; y: number; zoom: number }
  finish: (id: string) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => finish(emote.id), 1450)
    return () => clearTimeout(timer)
  }, [emote.id, finish])
  return (
    <div
      className="canvas-emote-burst"
      data-emote={emote.kind}
      data-kind={emote.kind}
      aria-hidden="true"
      style={{
        left: (emote.x + camera.x) * camera.zoom,
        top: (emote.y + camera.y) * camera.zoom,
      }}
    >
      {[0, 1, 2].map((i) => (
        <i key={i}>
          <ReactionGlyph kind={emote.kind} size={21} />
        </i>
      ))}
    </div>
  )
}
export function CanvasEmotes({
  items,
  camera,
  finish,
}: {
  items: CanvasEmote[]
  camera: { x: number; y: number; zoom: number }
  finish: (id: string) => void
}) {
  return (
    <div className="canvas-emotes">
      {items.map((emote) => (
        <EmoteBurst
          key={emote.id}
          emote={emote}
          camera={camera}
          finish={finish}
        />
      ))}
    </div>
  )
}
