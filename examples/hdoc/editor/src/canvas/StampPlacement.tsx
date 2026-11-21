import { useEffect, useRef, useState } from 'react'
import { stampPng } from './stampArt'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { ReactionGlyph } from './CanvasReactions'
import type { ReactionKind } from './model'

type Point = { x: number; y: number }
const impressionSizes = [54, 72, 96, 128]
type Impression = Point & { id: number; kind: ReactionKind; person: string; size: number }
type Props = {
  editor: ExcalidrawImperativeAPI
  kind: ReactionKind
  person: string
  temporary: boolean
  camera: Point & { zoom: number }
  place: (at: Point, hit: string | null, emote: boolean, size: number) => void
  exit: () => void
}

export function StampPlacement({ editor, kind, person, temporary, camera, place, exit }: Props) {
  const layer = useRef<HTMLDivElement>(null),
    preview = useRef<HTMLDivElement>(null)
  const [imprints, setImprints] = useState<Impression[]>([])
  const nextId = useRef(0)
  const actions = useRef({ place, exit })
  actions.current = { place, exit }

  useEffect(() => {
    const surface = layer.current?.closest<HTMLElement>('.canvas-surface'),
      proof = preview.current
    if (!surface || !proof) return
    void stampPng(kind, person).catch(() => {})
    surface.dataset.stampPointer = 'ready'
    let last: { clientX: number; clientY: number } | undefined
    let released = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let press: {
      id: number
      x: number
      y: number
      hit: string | null
      at: Point
      cancelled: boolean
      stage: number
    } | null = null
    let space = false
    let growth: ReturnType<typeof setInterval> | undefined
    function endPress() {
      clearInterval(growth)
      delete proof!.dataset.pressed
      delete proof!.dataset.stage
      if (!space) surface!.dataset.stampPointer = 'ready'
    }
    function paper(target: EventTarget | null) {
      return (
        target instanceof Element &&
        surface!.contains(target) &&
        target.matches('canvas.excalidraw__canvas.interactive,.canvas-emote-placement')
      )
    }
    function reset() {
      press = null
      last = undefined
      proof!.hidden = true
      endPress()
    }
    function project() {
      if (proof!.hidden || !last) return
      const app = editor.getAppState()
      const at = press?.at ?? viewportCoordsToSceneCoords(last, app)
      const zoom = app.zoom.value
      proof!.style.transform =
        'translate3d(' + (at.x + app.scrollX) * zoom + 'px,' + (at.y + app.scrollY) * zoom + 'px,0)'
      proof!.style.setProperty('--stamp-diameter', impressionSizes[press?.stage ?? 0] * zoom + 'px')
    }
    function position(e: PointerEvent, over: boolean) {
      last = { clientX: e.clientX, clientY: e.clientY }
      proof!.hidden = !over || space || released || (e.pointerType === 'touch' && !press)
      project()
    }
    function down(e: PointerEvent) {
      if (!e.isPrimary || e.button !== 0 || space || !paper(e.target)) {
        reset()
        return
      }
      endPress()
      released = false
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        at: viewportCoordsToSceneCoords(e, editor.getAppState()),
        hit: null,
        cancelled: false,
        stage: 0,
      }
      position(e, true)
      surface!.dataset.stampPointer = 'pressed'
      proof!.dataset.pressed = 'true'
      proof!.dataset.stage = '1'
      const grow = () => {
        if (!press) return
        proof!.dataset.stage = String(press.stage + 1)
        project()
      }
      if (!temporary && !e.shiftKey) {
        grow()
        growth = setInterval(() => {
          if (!press || press.cancelled) {
            clearInterval(growth)
            return
          }
          press.stage++
          grow()
          if (press.stage === impressionSizes.length - 1) clearInterval(growth)
        }, 310)
      }
    }
    // Let the native engine pick the topmost painted object, including groups and bound text.
    const stopDown = editor.onPointerDown((_tool, state, e) => {
      if (press?.id === e.pointerId) press.hit = state.hit.element?.id ?? null
    })
    function move(e: PointerEvent) {
      if (press && e.pointerId !== press.id) return
      if (last && (last.clientX !== e.clientX || last.clientY !== e.clientY)) released = false
      position(e, paper(e.target))
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
        press.cancelled = true
        endPress()
      }
      if (press && e.buttons && !temporary) e.stopImmediatePropagation()
    }
    function up(e: PointerEvent) {
      if (!press || e.pointerId !== press.id) return
      const down = press
      press = null
      endPress()
      const over = paper(document.elementFromPoint(e.clientX, e.clientY))
      released = true
      position(e, over)
      if (
        !over ||
        e.button !== 0 ||
        down.cancelled ||
        space ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5
      )
        return
      const at = down.at,
        emote = temporary || e.shiftKey
      const size = impressionSizes[down.stage]
      if (!emote) {
        const id = ++nextId.current
        setImprints((old) => [...old, { ...at, id, kind, person, size }])
        const t = setTimeout(() => {
          timers.delete(t)
          setImprints((old) => old.filter((mark) => mark.id !== id))
        }, 420)
        timers.add(t)
      }
      actions.current.place(at, down.hit, emote, size)
    }
    function keys(e: KeyboardEvent) {
      if (e.code === 'Space') {
        space = e.type === 'keydown'
        if (space) {
          reset()
          delete surface!.dataset.stampPointer
        } else surface!.dataset.stampPointer = 'ready'
      }
    }
    const blur = () => {
      space = false
      reset()
    }
    const leave = () => {
      if (press) press.cancelled = true
      endPress()
      proof.hidden = true
    }
    const double = (e: MouseEvent) => {
      if (paper(e.target) && !space) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    const stopScroll = editor.onScrollChange(project)
    const stopChange = editor.onChange((_els, app) => {
      if (app.activeTool.type !== 'selection' && app.activeTool.type !== 'hand') actions.current.exit()
    })
    surface.addEventListener('pointerdown', down, true)
    surface.addEventListener('pointerleave', leave)
    surface.addEventListener('dblclick', double, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', reset, true)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', keys, true)
    window.addEventListener('keyup', keys, true)
    return () => {
      endPress()
      timers.forEach(clearTimeout)
      stopDown()
      stopChange()
      stopScroll()
      delete surface.dataset.stampPointer
      surface.removeEventListener('pointerdown', down, true)
      surface.removeEventListener('pointerleave', leave)
      surface.removeEventListener('dblclick', double, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', reset, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', keys, true)
      window.removeEventListener('keyup', keys, true)
    }
  }, [editor, kind, person, temporary])

  return (
    <>
      {temporary && <div className="canvas-emote-placement" aria-label="点按画布发送表情" />}
      <div className="stamp-feedback-layer" ref={layer} aria-hidden="true">
        <div className="board-stamp-preview" data-kind={kind} ref={preview} hidden>
          <span className="stamp-proof">
            <ReactionGlyph kind={kind} person={person} size="var(--stamp-diameter)" />
          </span>
        </div>
        {imprints.map((mark) => (
          <div
            className="board-stamp-impression"
            key={mark.id}
            data-kind={mark.kind}
            style={{ left: (mark.x + camera.x) * camera.zoom, top: (mark.y + camera.y) * camera.zoom }}
          >
            <span>
              <ReactionGlyph kind={mark.kind} person={mark.person} size={mark.size * camera.zoom} />
            </span>
            <svg
              className="stamp-release-lines"
              width={mark.size * camera.zoom + 32}
              height={mark.size * camera.zoom + 32}
              viewBox="0 0 100 100"
              fill="none"
            >
              {[0, 60, 120, 180, 240, 300].map((angle) => (
                <g key={angle} transform={`rotate(${angle} 50 50)`}>
                  <line
                    x1="50"
                    y1="22"
                    x2="50"
                    y2="15"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}
            </svg>
          </div>
        ))}
      </div>
    </>
  )
}
