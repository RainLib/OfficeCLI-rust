import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type HTMLAttributes, type ReactNode, type SetStateAction } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useI18n } from './i18n.tsx'
import { localizeSource } from './sourceLocale.tsx'

const clampZoom = (value: number) => Math.round(Math.max(0.25, Math.min(3, value)) * 100) / 100
const ZoomContext = createContext<{ zoom: number; setZoom: Dispatch<SetStateAction<number>> } | null>(null)

export function CanvasZoomProvider({ children }: { children: ReactNode }) {
  const [zoom, update] = useState(1)
  const setZoom = useCallback<Dispatch<SetStateAction<number>>>(value => update(previous => clampZoom(typeof value === 'function' ? value(previous) : value)), [])
  return <ZoomContext.Provider value={{ zoom, setZoom }}>{children}</ZoomContext.Provider>
}

export function useCanvasZoom() {
  const context = useContext(ZoomContext)
  if (!context) throw new Error('CanvasZoomProvider is required')
  return context
}

export function ZoomControls() {
  const { locale } = useI18n()
  const { zoom, setZoom } = useCanvasZoom()
  return <div className="canvas-zoom-controls" aria-label={localizeSource(locale, '文档缩放')} title={localizeSource(locale, 'Ctrl / ⌘ + 滚轮仅缩放文档画布')}>
    <button aria-label={localizeSource(locale, '缩小文档')} disabled={zoom <= 0.25} onClick={() => setZoom(value => value - 0.1)}><Minus size={13} /></button>
    <button className="canvas-zoom-value" aria-label={localizeSource(locale, '重置文档缩放')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
    <button aria-label={localizeSource(locale, '放大文档')} disabled={zoom >= 3} onClick={() => setZoom(value => value + 0.1)}><Plus size={13} /></button>
  </div>
}

/** Native, non-passive listeners also cover same-origin preview frames. Browser
 * zoom remains available outside the canvas; ordinary wheel events still scroll. */
export function CanvasViewport({ children, native = false, className = 'document-scroll', ...props }: HTMLAttributes<HTMLDivElement> & { native?: boolean }) {
  const { zoom, setZoom } = useCanvasZoom()
  const viewport = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const anchor = useRef<{ x: number; y: number; contentX: number; contentY: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const point = anchor.current, element = viewport.current, canvas = element?.firstElementChild
    if (!point || !element || !canvas) return
    const rect = canvas.getBoundingClientRect(), bounds = element.getBoundingClientRect()
    element.scrollLeft += rect.left - bounds.left + point.contentX * zoom - point.x
    element.scrollTop += rect.top - bounds.top + point.contentY * zoom - point.y
    anchor.current = null
  }, [zoom])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = new ResizeObserver(() => {
      if (element.clientWidth) setSize({ width: element.clientWidth, height: element.clientHeight })
    })
    resize.observe(element)
    let gestureStart = 1
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      if (!native && element.firstElementChild) {
        let x = event.clientX, y = event.clientY
        // Wheel coordinates inside a preview frame use the frame's viewport.
        const frame = event.view?.frameElement
        if (frame) {
          const rect = frame.getBoundingClientRect()
          const scale = rect.width / frame.clientWidth
          x = rect.left + x * scale; y = rect.top + y * scale
        }
        const rect = element.getBoundingClientRect(), canvas = element.firstElementChild.getBoundingClientRect()
        anchor.current = { x: x - rect.left, y: y - rect.top, contentX: (x - canvas.left) / zoomRef.current, contentY: (y - canvas.top) / zoomRef.current }
      }
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      setZoom(value => value * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.003))
    }
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !['+', '=', '-', '0'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      setZoom(value => event.key === '0' ? 1 : value + (event.key === '-' ? -0.1 : 0.1))
    }
    const gesture = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'gesturestart') gestureStart = zoomRef.current
      else setZoom(gestureStart * ((event as Event & { scale?: number }).scale || 1))
    }
    const bind = (target: EventTarget) => {
      target.addEventListener('wheel', wheel as EventListener, { capture: true, passive: false })
      target.addEventListener('keydown', key as EventListener, true)
      target.addEventListener('gesturestart', gesture, { capture: true, passive: false })
      target.addEventListener('gesturechange', gesture, { capture: true, passive: false })
      return () => {
        target.removeEventListener('wheel', wheel as EventListener, true)
        target.removeEventListener('keydown', key as EventListener, true)
        target.removeEventListener('gesturestart', gesture, true)
        target.removeEventListener('gesturechange', gesture, true)
      }
    }
    const release = bind(element)
    const frames = new Map<HTMLIFrameElement, () => void>()
    const attachFrames = () => {
      for (const [frame, cleanup] of frames) if (!element.contains(frame)) { cleanup(); frames.delete(frame) }
      for (const frame of element.querySelectorAll('iframe')) {
        if (frames.has(frame)) continue
        let unbind: (() => void) | undefined
        const load = () => {
          unbind?.()
          try { if (frame.contentDocument) unbind = bind(frame.contentDocument) } catch { /* Cross-origin frames have their own browser controls. */ }
        }
        frame.addEventListener('load', load)
        load()
        frames.set(frame, () => { frame.removeEventListener('load', load); unbind?.() })
      }
    }
    const observer = new MutationObserver(attachFrames)
    observer.observe(element, { childList: true, subtree: true })
    attachFrames()
    return () => { resize.disconnect(); observer.disconnect(); release(); frames.forEach(cleanup => cleanup()) }
  }, [setZoom, native])
  return <div {...props} ref={viewport} tabIndex={0} className={`${className} canvas-viewport`} data-canvas-zoom={zoom}>
    {native ? children : <div className="zoom-canvas" style={{ zoom, width: size.width || '100%', minHeight: size.height / zoom }}>{children}</div>}
  </div>
}
