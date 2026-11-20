import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { MagneticHandle } from './MagneticHandle'
import { noteDirections, type NoteDirection } from './sceneGeometry'
import type { BoardPoint } from './boardObjects'

export function BoardEdgeHandles({
  editor,
  box,
  note,
  act,
}: {
  editor: ExcalidrawImperativeAPI
  box: { id: string; left: number; top: number; width: number; height: number; angle: number }
  note: boolean
  act: (id: string, direction: NoteDirection, point?: BoardPoint) => void
}) {
  const gesture = useRef<{ x: number; y: number; direction: NoteDirection; id: string; armed: boolean; moved: boolean; end: BoardPoint; surface: DOMRect; button: HTMLButtonElement } | null>(null)
  const skip = useRef(false),
    [line, setLine] = useState<{ start: BoardPoint; end: BoardPoint } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const preview = () => {
    const g = gesture.current
    if (g?.armed && g.moved) setLine({
      start: {x:g.x-g.surface.left,y:g.y-g.surface.top}, end: {x:g.end.x-g.surface.left,y:g.end.y-g.surface.top},
    })
  }
  const clear = () => {
    clearTimeout(timer.current)
    if (gesture.current) delete gesture.current.button.dataset.armed
    gesture.current = null
    setLine(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <>
      {line && (
        <svg aria-hidden="true" className="board-connector-preview">
          <path d={`M ${line.start.x} ${line.start.y} L ${line.end.x} ${line.end.y}`} />
        </svg>
      )}
      <div
        role="group"
        aria-label={note ? '相邻便签' : '相邻图形'}
        className="board-note-neighbors"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          transform: `rotate(${box.angle}rad)`,
        }}
      >
        {(Object.keys(noteDirections) as NoteDirection[]).map((side) => {
          const label = '向' + noteDirections[side] + (note ? '新增便利贴' : '新增图形')
          return (
            <MagneticHandle
              key={side}
              className="mind-branch"
              data-side={side}
              aria-label={label}
              title={label + (note ? ' · 拖动可连接' : ' · 长按拖动连接')}
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return
                e.stopPropagation()
                skip.current = false
                const surface = e.currentTarget.closest('.canvas-surface')?.getBoundingClientRect()
                if (!surface) return
                const g = { x:e.clientX, y:e.clientY, id:box.id, direction:side, armed:note, moved:false,
                  end:{x:e.clientX,y:e.clientY}, surface, button:e.currentTarget }
                gesture.current = g
                if (!note) timer.current = setTimeout(() => {
                  g.armed = true
                  g.button.dataset.armed = 'true'
                  preview()
                }, 200)
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={e => {
                const g = gesture.current
                if (!g) return
                g.end = { x:e.clientX, y:e.clientY }
                if (Math.hypot(e.clientX-g.x,e.clientY-g.y) >= 6) g.moved = true
                preview()
              }}
              onKeyDown={e => { if (e.key === 'Escape' && gesture.current) {skip.current=true;clear()} }}
              onLostPointerCapture={() => { if (gesture.current) {skip.current=true;clear()} }}
              onPointerCancel={() => {
                skip.current = true
                clear()
              }}
              onPointerUp={(e) => {
                const g = gesture.current
                clear()
                if (!g || !g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return
                skip.current = true
                if (g.armed) act(g.id, g.direction, viewportCoordsToSceneCoords(e, editor.getAppState()))
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (skip.current) {
                  skip.current = false
                  return
                }
                act(box.id, side)
              }}
            >
              <Plus size={15} strokeWidth={2} />
            </MagneticHandle>
          )
        })}
      </div>
    </>
  )
}
