import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useCanvasZoom } from './CanvasZoom.tsx'
import type { HcdUniverAdapter } from '../../xlsx-univer-viewer/src/adapter.ts'
import { AgentCanvasMarks, useAgentVisuals, type AgentMark } from './AgentActivityLayer.tsx'
import type { ServiceGridClient } from './ServiceGridClient.ts'
import type { Session } from './api.ts'

/** Native popups are persistent, invisible cell anchors. Updating an Agent's
 * phase, heartbeat or playback position must never rebuild the workbook UI. */
export function GridAgentOverlay({ session, host, runtime, revision }: {
  session: Session
  host: RefObject<HTMLDivElement | null>
  runtime: RefObject<{ client: ServiceGridClient; adapter: HcdUniverAdapter } | null>
  revision: number | null
}) {
  const visuals = useAgentVisuals()
  const { zoom: canvasZoom } = useCanvasZoom()
  const kick = useRef(() => {})
  useEffect(() => { kick.current() }, [visuals, revision, canvasZoom])
  const latest = useRef({ visuals, revision })
  latest.current = { visuals, revision }
  const [marks, setMarks] = useState<AgentMark[]>([])
  const active = visuals.length > 0
  useEffect(() => {
    if (!active) { setMarks(previous => previous.length ? [] : previous); return }
    const anchors = new Map<string, { popup: { dispose: () => void }; created: number }>()
    let geometry = '', tick = 0, settling = 0
    let boundApi: HcdUniverAdapter['univerAPI'] | undefined
    let subscriptions: Array<{ dispose: () => void }> = []
    const schedule = () => { if (!tick) tick = requestAnimationFrame(safelyRefresh) }
    kick.current = schedule
    const refresh = () => {
      const current = runtime.current, element = host.current
      const sheet = current?.adapter.workbook.getActiveSheet()
      const bounds = element?.parentElement?.getBoundingClientRect()
      const visible = !!element?.getClientRects().length
      if (current && boundApi !== current.adapter.univerAPI) {
        subscriptions.forEach(subscription => subscription.dispose())
        boundApi = current.adapter.univerAPI
        subscriptions = [boundApi.addEvent(boundApi.Event.CommandExecuted, schedule), boundApi.addEvent(boundApi.Event.ActiveSheetChanged, schedule), boundApi.addEvent(boundApi.Event.SheetZoomChanged, schedule)]
      }
      // Native anchors capture a pane's scroll transform. Rebind only when
      // geometry changes, driven by native commands rather than polling.
      const nextGeometry = JSON.stringify([sheet?.getSheetId(), sheet?.getScrollState(), sheet?.getZoom(), sheet?.getFreeze()])
      if (nextGeometry !== geometry) {
        geometry = nextGeometry
        for (const anchor of anchors.values()) anchor.popup.dispose()
        anchors.clear()
      }
      const needed = new Set<string>(), next: AgentMark[] = [], pending = new Set<string>()
      const addressed = latest.current.visuals.flatMap(visual => {
        const address = visual.target.nodeId ? current?.adapter.nodeAddress(visual.target.nodeId)
          : visual.target.sheetId && visual.target.row && visual.target.column ? { sheetId: visual.target.sheetId, row: visual.target.row - 1, column: visual.target.column - 1 } : undefined
        if (!current || !visible || !sheet || !address || address.sheetId !== sheet.getSheetId() || visual.agent.revision !== latest.current.revision) return []
        const key = `${visual.key}:${address.sheetId}:${address.row}:${address.column}`
        needed.add(key)
        if (!anchors.has(key)) {
          const popup = sheet.getRange(address.row, address.column).attachPopup({
            componentKey: () => <span data-agent-grid-anchor={key} data-agent-grid-document={session.documentId} aria-hidden="true" style={{ display: 'block', width: 1, height: 1, pointerEvents: 'none' }} />,
            direction: 'top-left', offset: [0, 0], hideOnInvisible: true, zIndex: 30,
          })
          if (popup) anchors.set(key, { popup, created: Date.now() })
        }
        return [{ key, visual, address }]
      })
      for (const [key, anchor] of anchors) if (!needed.has(key)) { anchor.popup.dispose(); anchors.delete(key) }
      const freeze = sheet?.getFreeze(), zoom = sheet?.getZoom() ?? 1
      let paneTop = bounds?.top ?? 0, paneLeft = bounds?.left ?? 0
      if (visible && bounds && sheet) try {
        const origin = sheet.getRange(0, 0).getCellRect()
        paneTop += origin.top * zoom; paneLeft += origin.left * zoom
        if (freeze && freeze.ySplit > 0 && freeze.startRow > 0) paneTop += (sheet.getRange(freeze.startRow - 1, 0).getCellRect().bottom - sheet.getRange(freeze.startRow - freeze.ySplit, 0).getCellRect().top) * zoom
        if (freeze && freeze.xSplit > 0 && freeze.startColumn > 0) paneLeft += (sheet.getRange(0, freeze.startColumn - 1).getCellRect().right - sheet.getRange(0, freeze.startColumn - freeze.xSplit).getCellRect().left) * zoom
      } catch { /* The skeleton may still be initializing. */ }
      if (visible && bounds && sheet) for (const { key, visual, address } of addressed) {
        const anchor = element?.ownerDocument.querySelector<HTMLElement>(`[data-agent-grid-document="${CSS.escape(session.documentId)}"][data-agent-grid-anchor="${CSS.escape(key)}"]`)
        if (!anchor?.getClientRects().length) {
          if (Date.now() - (anchors.get(key)?.created ?? 0) < 300) pending.add(visual.agent.agentId)
          continue
        }
        const box = anchor.getBoundingClientRect(), x = box.left, y = box.bottom
        if (x < bounds.left || x >= bounds.right || y < bounds.top + 20 || y >= bounds.bottom - 18) {
          if (Date.now() - (anchors.get(key)?.created ?? 0) < 300) pending.add(visual.agent.agentId)
          continue
        }
        const frozenRow = !!freeze && address.row >= freeze.startRow - freeze.ySplit && address.row < freeze.startRow
        const frozenColumn = !!freeze && address.column >= freeze.startColumn - freeze.xSplit && address.column < freeze.startColumn
        if (!frozenRow && y < paneTop - 1 || !frozenColumn && x < paneLeft - 1) continue
        const cell = sheet.getRange(address.row, address.column).getCellRect()
        next.push({ ...visual, target: { ...visual.target, row: address.row + 1, column: address.column + 1 }, x: x - bounds.left, y: y - bounds.top, width: Math.min(cell.width * zoom, bounds.right - x), height: Math.min(cell.height * zoom, bounds.bottom - y) })
      }
      setMarks(previous => {
        // Preserve the single pointer while a newly attached native anchor
        // settles; never tear it down between two consecutive target cells.
        next.push(...previous.filter(mark => mark.pointer && pending.has(mark.agent.agentId) && !next.some(item => item.pointer && item.agent.agentId === mark.agent.agentId)))
        return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      })
      if (pending.size && !settling) settling = window.setTimeout(() => { settling = 0; schedule() }, 300)
    }
    const safelyRefresh = () => { tick = 0; try { refresh() } catch { /* Native grid is initializing. */ } }
    const element = host.current
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[data-agent-canvas-layer]'))) schedule()
    })
    if (element) observer.observe(element.ownerDocument.body, { subtree: true, childList: true, attributes: true })
    const resize = new ResizeObserver(schedule)
    if (element) resize.observe(element)
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true)
    safelyRefresh()
    return () => { kick.current = () => {}; cancelAnimationFrame(tick); clearTimeout(settling); observer.disconnect(); resize.disconnect(); subscriptions.forEach(subscription => subscription.dispose()); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); for (const anchor of anchors.values()) anchor.popup.dispose() }
  }, [session.documentId, host, runtime, active])
  const element = host.current
  return element?.parentElement ? createPortal(<div data-agent-canvas-layer="true"><AgentCanvasMarks marks={marks} grid /></div>, element.parentElement) : null
}
