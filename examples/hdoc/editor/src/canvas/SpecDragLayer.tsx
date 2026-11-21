import { useEffect, useRef, useState } from 'react'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { nativeBundle, specAt, transferBoardDrop } from './specTransfers'
import type { CanvasElement, Operation } from './model'
import type { BoardPoint } from './boardObjects'

export function SpecDragLayer({
  api,
  writable,
  send,
  elements,
}: {
  elements: readonly CanvasElement[]
  api: ExcalidrawImperativeAPI
  writable: boolean
  send: (ops: Operation[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null),
    queue = useRef(send),
    canonical = useRef(elements)
  queue.current = send
  canonical.current = elements
  const [target, setTarget] = useState('')
  useEffect(() => {
    if (!writable) return
    let drag: { id: string; origin: BoardPoint; pointer: number } | null = null
    const surface = ref.current?.closest('.canvas-surface')
    const down = api.onPointerDown((tool, state, e) => {
      drag = null
      setTarget('')
      if (
        tool.type !== 'selection' ||
        e.button !== 0 ||
        state.resize.handleType
      )
        return
      const hit = state.hit.element
      if (hit && !hit.locked)
        drag = { id: hit.id, origin: { ...state.origin }, pointer: e.pointerId }
      else if (state.hit.hasHitCommonBoundingBoxOfSelectedElements) {
        const id = Object.keys(api.getAppState().selectedElementIds)[0]
        if (id) drag = { id, origin: { ...state.origin }, pointer: e.pointerId }
      }
    })
    const move = (event: Event) => {
      const e = event as PointerEvent
      if (!drag || !e.buttons || e.pointerId !== drag.pointer) return
      const app = api.getAppState(),
        point = viewportCoordsToSceneCoords(e, app)
      if (
        Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) *
          app.zoom.value <
        5
      )
        return
      const all = api.getSceneElements(),
        hit = all.find((el) => el.id === drag!.id)
      if (!hit) return
      const exclude = new Set([
        ...Object.keys(app.selectedElementIds),
        ...nativeBundle(all, hit).map((el) => el.id),
      ])
      setTarget(specAt(all, point, exclude)?.id || '')
    }
    const cancel = () => {
      drag = null
      setTarget('')
    }
    const up = api.onPointerUp((tool, state, e) => {
      const gesture = drag
      cancel()
      if (
        !gesture ||
        tool.type !== 'selection' ||
        state.resize.isResizing ||
        state.boxSelection.hasOccurred ||
        !state.drag.hasOccurred ||
        e.type === 'pointercancel'
      )
        return
      const app = api.getAppState(),
        point = viewportCoordsToSceneCoords(e, app)
      if (
        Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) *
          app.zoom.value <
        5
      )
        return
      const ids = Object.keys(app.selectedElementIds)
      transferBoardDrop(
        api,
        ids.length ? ids : [gesture.id],
        point,
        gesture.origin,
        (ops) => queue.current(ops),
        canonical.current,
      )
    })
    surface?.addEventListener('pointermove', move, true)
    surface?.addEventListener('pointercancel', cancel, true)
    return () => {
      down()
      up()
      surface?.removeEventListener('pointermove', move, true)
      surface?.removeEventListener('pointercancel', cancel, true)
    }
  }, [api, writable])
  const root = target && api.getSceneElements().find((el) => el.id === target),
    app = api.getAppState(),
    z = app.zoom.value
  return (
    <div ref={ref} className="spec-drag-layer">
      {root && (
        <div
          className="spec-drop-ring"
          style={{
            left: (root.x + app.scrollX) * z,
            top: (root.y + app.scrollY) * z,
            width: root.width * z,
            height: root.height * z,
          }}
        >
          <span>放入 Spec 文档</span>
        </div>
      )}
    </div>
  )
}
