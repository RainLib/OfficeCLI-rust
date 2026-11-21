import { useLayoutEffect, useRef, type RefObject } from 'react'
import type * as Y from 'yjs'
import { changeTitle, specRemote } from './specRichText'
import {
  resolveCursor,
  titleCursor,
  type SpecCursor,
  type SpecPeer,
} from './specCoordinates'
import { markersFor, projectRuns } from './specProjection'

export function placeTitleCaret(input: HTMLTextAreaElement, point: { x: number; y: number }) {
  const mirror = input.parentElement?.querySelector<HTMLElement>('.spec-title-ink')
  if (!mirror) return
  // Use browser text layout, including soft wraps, bidi text and canvas zoom.
  // The mirror is normally transparent to pointer events.
  input.style.pointerEvents = 'none'
  mirror.style.pointerEvents = 'auto'
  try {
    const doc = input.ownerDocument
    const caret = doc.caretPositionFromPoint?.(point.x, point.y)
    const range = caret ? null : doc.caretRangeFromPoint?.(point.x, point.y)
    const node = caret?.offsetNode ?? range?.startContainer
    if (!node || !mirror.contains(node)) return
    const before = doc.createRange()
    before.selectNodeContents(mirror)
    before.setEnd(node, caret?.offset ?? range!.startOffset)
    const offset = Math.min(input.value.length, before.toString().length)
    input.setSelectionRange(offset, offset)
  } finally {
    input.style.removeProperty('pointer-events')
    mirror.style.removeProperty('pointer-events')
  }
}

export function SpecTitleField({
  doc,
  id,
  input,
  value,
  readOnly,
  peers,
  report,
  onEnter,
}: {
  doc: Y.Doc
  id: string
  input: RefObject<HTMLTextAreaElement | null>
  value: string
  readOnly: boolean
  peers: SpecPeer[]
  report: (cursor: SpecCursor | null) => void
  onEnter: () => void
}) {
  const last = useRef<SpecCursor | null>(null),
    restore = useRef(false)
  const publish = () => {
    const el = input.current
    if (!el || el !== document.activeElement) return
    let a = el.selectionStart ?? 0,
      h = el.selectionEnd ?? 0
    if (el.selectionDirection === 'backward') [a, h] = [h, a]
    last.current = titleCursor(doc, id, a, h)
    report(last.current)
  }
  useLayoutEffect(() => {
    const changed = (_: Uint8Array, origin: unknown) => {
      if (origin === specRemote && input.current === document.activeElement)
        restore.current = true
    }
    doc.on('update', changed)
    return () => doc.off('update', changed)
  }, [doc, input])
  useLayoutEffect(() => {
    if (!restore.current) return
    restore.current = false
    const pos = last.current && resolveCursor(doc, last.current)
    if (pos && input.current === document.activeElement) {
      const a = pos.anchor.offset,
        h = pos.head.offset
      input.current?.setSelectionRange(
        Math.min(a, h),
        Math.max(a, h),
        a > h ? 'backward' : 'forward',
      )
    }
  }, [value, doc, input])
  const markers = markersFor(doc, id, peers)
  return (
    <div className="spec-title-field">
      <textarea
        rows={1}
        ref={input}
        aria-label="文档标题"
        placeholder="无标题文档"
        readOnly={readOnly}
        value={value}
        onFocus={publish}
        onSelect={publish}
        onKeyUp={publish}
        onPointerUp={publish}
        onChange={(e) => {
          changeTitle(doc, e.target.value.replace(/[\r\n]+/g, ' '))
          publish()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onEnter()
          }
        }}
      />
      <div className="spec-title-overlay" aria-hidden="true">
        <div className="spec-title-ink">{value ? projectRuns([{ insert: value }], 0, markers) : <>{projectRuns([], 0, markers)}{'\u200b'}</>}</div>
      </div>
    </div>
  )
}
