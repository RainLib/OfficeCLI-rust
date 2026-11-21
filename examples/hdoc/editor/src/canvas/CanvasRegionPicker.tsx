import { useRef, useState, type PointerEvent } from 'react'
import { selectedRegion } from './changes.ts'
import type { CanvasElement, Selection } from './model.ts'

/** Select scene coordinates independently of native object selection. This
 * also allows an AI task to create in an empty area of an infinite canvas. */
export function CanvasRegionPicker({ camera, elements, value, selecting, onChange, onFinish }: {
  camera: { x: number; y: number; zoom: number }
  elements: readonly CanvasElement[]
  value: Selection | null
  selecting: boolean
  onChange: (selection: Selection) => void
  onFinish: () => void
}) {
  const origin = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<Selection['region'] | null>(null)
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.x) / camera.zoom - camera.x, y: (event.clientY - box.y) / camera.zoom - camera.y }
  }
  const region = draft || value?.region
  return <div className="canvas-region-picker" data-selecting={selecting} aria-label={selecting ? '拖动框选 AI 创作区域' : undefined}
    onPointerDown={event => {
      if (!selecting) return
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      origin.current = point(event); setDraft(null)
    }}
    onPointerMove={event => {
      if (!origin.current) return
      const end = point(event), start = origin.current
      setDraft({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) })
    }}
    onPointerUp={event => {
      const start = origin.current
      origin.current = null
      if (!start) return
      const end = point(event), box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
      if (box.width * camera.zoom >= 5 && box.height * camera.zoom >= 5) {
        const elementIds = elements.filter(element => {
          const bounds = selectedRegion([element], [element.id])?.region
          return bounds && bounds.x >= box.x && bounds.y >= box.y && bounds.x + bounds.width <= box.x + box.width && bounds.y + bounds.height <= box.y + box.height
        }).map(element => element.id)
        onChange({ elementIds, region: box })
      }
      setDraft(null); onFinish()
    }}
    onPointerCancel={() => { origin.current = null; setDraft(null); onFinish() }}>
    {selecting && <span className="canvas-region-hint">拖动框选一片区域，也可以选择空白位置</span>}
    {region && <div className="canvas-region-boundary" style={{ left: (region.x + camera.x) * camera.zoom, top: (region.y + camera.y) * camera.zoom, width: region.width * camera.zoom, height: region.height * camera.zoom }} />}
  </div>
}
