import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCommonBounds, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { ExternalLink, FileOutput, RefreshCw, Sparkles } from 'lucide-react'
import { referenceFrom, sheetPresentations, type ResourceReference, type SheetPresentation } from '../resources/resourceReference'
import { usePaintStack } from './paintStack'

export function BoardHoverActions({
  editor,
  camera,
  enter,
  organize,
  present,
  selected,
  enabled,
}: {
  editor: ExcalidrawImperativeAPI
  camera: { x: number; y: number; zoom: number }
  selected?: string
  enabled: boolean
  enter: (ref: ResourceReference, ai?: boolean) => void
  organize?: (id: string) => void
  present?: (id: string, presentation: SheetPresentation) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(''),
    [focused, setFocused] = useState('')
  const scene = usePaintStack(editor)
  const [status, setStatus] = useState({ ready: false, ai: false, label: '' })
  const target = scene.find((el) => el.id === (hover || focused || selected))
  const reference = referenceFrom(target?.customData?.officeResource)
  const stamp = target?.customData?.officeStamp
  const cardRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setHover('')
    setFocused('')
  }, [selected, enabled])
  useLayoutEffect(() => {
    setHover('')
  }, [camera.x, camera.y, camera.zoom])
  useEffect(() => {
    const board = root.current?.closest<HTMLElement>('.canvas-surface')
    if (!board || !enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setHover(''), 160)
    }
    const move = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return
      if (e.target.closest('.board-hover-bar')) {
        clearTimeout(timer)
        return
      }
      setFocused('')
      if (e.buttons || editor.getAppState().activeTool.type !== 'selection') {
        clearTimeout(timer)
        setHover('')
        return
      }
      const card = e.target.closest<HTMLElement>('[data-resource-element]')
      if (card) {
        clearTimeout(timer)
        setHover(card.dataset.resourceElement || '')
        return
      }
      if (!(e.target instanceof HTMLCanvasElement)) {
        clear()
        return
      }
      const p = viewportCoordsToSceneCoords(e, editor.getAppState())
      const hit = [...editor.getSceneElements()]
        .reverse()
        .find(
          (el) =>
            el.opacity > 0 &&
            el.type !== 'freedraw' &&
            el.type !== 'line' &&
            el.type !== 'arrow' &&
            p.x >= el.x &&
            p.x <= el.x + el.width &&
            p.y >= el.y &&
            p.y <= el.y + el.height,
        )
      if (hit?.customData?.officeResource || hit?.customData?.officeStamp) {
        clearTimeout(timer)
        setHover(hit.id)
      } else clear()
    }
    board.addEventListener('pointermove', move, true)
    board.addEventListener('pointerleave', clear)
    return () => {
      clearTimeout(timer)
      board.removeEventListener('pointermove', move, true)
      board.removeEventListener('pointerleave', clear)
    }
  }, [editor, enabled])
  useLayoutEffect(() => {
    const board = root.current?.closest('.canvas-surface')
    if (!target?.customData?.officeResource || !board) return
    const selector = '[data-resource-element="' + CSS.escape(target.id) + '"]'
    const sync = () => {
      const card = board.querySelector<HTMLElement>(selector)
      cardRef.current = card
      const next = {
        ready: card?.dataset.ready === 'true',
        ai: card?.dataset.ai === 'true',
        label: card?.getAttribute('aria-label') || '',
      }
      setStatus((prev) =>
        prev.ready === next.ready && prev.ai === next.ai && prev.label === next.label ? prev : next,
      )
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(board, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-ready', 'data-ai', 'aria-label'],
    })
    return () => {
      observer.disconnect()
      cardRef.current = null
    }
  }, [target?.id, enabled])
  const app = editor.getAppState()
  const [x1, y1, x2, y2] = target ? getCommonBounds([target]) : [0, 0, 0, 0]
  const center = ((x1 + x2) / 2 + camera.x) * camera.zoom,
    top = (y1 + camera.y) * camera.zoom,
    bottom = (y2 + camera.y) * camera.zoom
  const stampName = typeof stamp?.author === 'string' ? stamp.author : ''
  const show =
    enabled &&
    app.activeTool.type === 'selection' &&
    target &&
    !app.selectedElementsAreBeingDragged &&
    !app.resizingElement &&
    x2 + camera.x >= 0 &&
    (x1 + camera.x) * camera.zoom <= app.width &&
    bottom >= 0 &&
    top <= app.height
  return (
    <div ref={root} className="board-hover-layer">
      {show && reference && (
        <div
          role="toolbar"
          aria-label="引用操作"
          className="board-hover-bar"
          data-owner={target.id}
          style={{
            left: Math.min(Math.max(92, center), app.width - 92),
            top: top >= 48 ? top - 6 : Math.max(48, Math.min(bottom + 48, app.height)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={() => setHover(target.id)}
          onFocus={() => setFocused(target.id)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setFocused('')
          }}
        >
          <button
            aria-label="进入引用源文件"
            title={status.label}
            disabled={!status.ready}
            onClick={() => enter(reference)}
          >
            <ExternalLink size={15} />
            源文件
          </button>
          {status.ai && (
            <button
              aria-label="AI 编辑源内容"
              title="AI 编辑源内容"
              disabled={!status.ready}
              onClick={() => enter(reference, true)}
            >
              <Sparkles size={15} />
            </button>
          )}
          <button
            aria-label="刷新资源预览"
            title="刷新资源预览"
            onClick={() => cardRef.current?.dispatchEvent(new Event('refresh-resource'))}
          >
            <RefreshCw size={14} />
          </button>
          {present && reference.anchor.kind === 'sheet-range' && <select className="resource-presentation" aria-label="引用呈现方式"
            value={reference.presentation || 'table'} onChange={event => present(target.id, event.target.value as SheetPresentation)}>
            {Object.entries(sheetPresentations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>}
          {organize && (
            <button aria-label="整理为文档" title="整理为文档" onClick={() => organize(target.id)}>
              <FileOutput size={15} />
            </button>
          )}
        </div>
      )}
      {show && hover === target.id && stampName && (
        <div
          role="tooltip"
          className="board-stamp-author"
          style={{ left: center, top: Math.max(32, top - 7) }}
        >
          {stampName}
        </div>
      )}
    </div>
  )
}
