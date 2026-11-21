import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { boardTag, stickyLabel } from './boardObjects'

const pad = 6
const canonical = (text = '') => (text === ' ' || text === '\u00a0' ? '' : text)
function cellLines(value: string, width: number, fontSize: number) {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = fontSize + 'px Arial, sans-serif'
  return value.split('\n').flatMap((paragraph) => {
    const lines: string[] = []
    let line = ''
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > width) {
        lines.push(line)
        line = ''
      }
      line += char
    }
    return [...lines, line]
  })
}

function writeCell(
  api: ExcalidrawImperativeAPI,
  cell: ExcalidrawElement,
  label: ExcalidrawTextElement,
  value: string,
) {
  const all = api.getSceneElementsIncludingDeleted(),
    tag = boardTag(cell)!
  const width = Math.max(1, cell.width - pad * 2)
  const lines = cellLines(value, width, label.fontSize)
  const textHeight = lines.length * label.fontSize * label.lineHeight
  const height = Math.max(cell.height, Math.ceil(textHeight + pad * 2))
  const growth = height - cell.height
  const records = new Map<string, ExcalidrawElement>()
  const dx = -Math.sin(cell.angle),
    dy = Math.cos(cell.angle)
  for (const box of all) {
    const other = boardTag(box)
    if (box.isDeleted || other?.kind !== 'table' || other.root !== tag.root || other.row! < tag.row!)
      continue
    const edited = box.id === cell.id,
      sameRow = tag.row === other.row
    if (!edited && !growth) continue
    const movement = growth * (sameRow ? 0.5 : 1)
    const h = box.height + (sameRow ? growth : 0)
    const x = box.x + movement * dx,
      y = box.y + movement * dy - (h - box.height) / 2
    if (growth) records.set(box.id, newElementWith(box, { x, y, height: h }))
    const content = edited ? label : stickyLabel(all, box.id)
    if (!content) continue
    records.set(
      content.id,
      edited
        ? newElementWith(content, {
            x: x + pad,
            y: y + (h - textHeight) / 2,
            width,
            height: textHeight,
            autoResize: false,
            text: lines.join('\n') || ' ',
            originalText: value || ' ',
            textAlign: 'center',
            verticalAlign: 'middle',
          })
        : newElementWith(content, { x: content.x + movement * dx, y: content.y + movement * dy }),
    )
  }
  api.updateScene({
    elements: all.map((el) => records.get(el.id) || el),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

export function BoardTableCell({
  editor,
  id,
  onClose,
  onCell,
}: {
  editor: ExcalidrawImperativeAPI
  id: string
  onClose: () => void
  onCell: (id: string) => void
}) {
  const all = editor.getSceneElements(),
    cell = all.find((el) => el.id === id),
    label = stickyLabel(all, id)
  const original = useRef(canonical(label?.originalText)),
    field = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(original.current),
    [error, setError] = useState('')
  const finished = useRef(false),
    form = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true })
    field.current?.select()
  }, [])
  function commit() {
    if (finished.current) return true
    if (value !== original.current) {
      const scene = editor.getSceneElements()
      const target = scene.find((el) => el.id === id),
        text = stickyLabel(scene, id)
      if (!target || target.locked || !text || canonical(text.originalText) !== original.current) {
        setError('单元格已变更。可复制当前草稿，按 Esc 关闭。')
        return false
      }
      writeCell(editor, target, text, value)
    }
    finished.current = true
    onClose()
    return true
  }
  const save = useRef(commit)
  save.current = commit
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (form.current?.contains(e.target as Node)) return
      if (!save.current()) {
        e.preventDefault()
        e.stopImmediatePropagation()
        field.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  if (!cell)
    return (
      <div role="alert">
        单元格已移除。<button onClick={onClose}>关闭</button>
      </div>
    )
  const app = editor.getAppState(),
    z = app.zoom.value,
    font = label?.fontSize ?? 15,
    line = label?.lineHeight ?? 1.15
  const rows = cellLines(value, Math.max(1, cell.width - pad * 2), font)
  const h = Math.max(cell.height, rows.length * font * line + pad * 2)
  return (
    <div
      ref={form}
      role="group"
      aria-label="编辑单元格"
      className="board-table-cell"
      style={{
        left: (cell.x + app.scrollX) * z,
        top: (cell.y + app.scrollY) * z,
        width: cell.width,
        minHeight: h,
        background: cell.backgroundColor,
        transform: `scale(${z}) rotate(${cell.angle}rad)`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
        if (e.key === 'Escape') {
          e.preventDefault()
          finished.current = true
          onClose()
        } else if (e.key === 'Tab') {
          e.preventDefault()
          const cells = all
            .filter((el) => boardTag(el)?.root === boardTag(cell)?.root && el.type === 'rectangle')
            .sort(
              (a, b) => boardTag(a)!.row! - boardTag(b)!.row! || boardTag(a)!.col! - boardTag(b)!.col!,
            )
          const next = cells[cells.findIndex((el) => el.id === id) + (e.shiftKey ? -1 : 1)]
          if (commit() && next) onCell(next.id)
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
      }}
    >
      <textarea
        ref={field}
        aria-label="单元格内容"
        rows={1}
        spellCheck={false}
        value={value}
        style={{ fontSize: font, lineHeight: line, height: Math.ceil(rows.length * font * line) + 2 }}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && <small role="alert">{error}</small>}
    </div>
  )
}
