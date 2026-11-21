import { RANGE_TYPE, type FUniver, type IRange } from '@univerjs/presets'
import { SetSelectionsOperation, type IScrollState } from '@univerjs/preset-sheets-core'
import type { HcdUniverAdapter } from '../../xlsx-univer-viewer/src/adapter.ts'
import type { Session } from './api.ts'
import { isIndex, readTabState, sameTargetVersion, tabStateKey, writeTabState, type TargetVersion } from './tabState.ts'

type GridTabView = { sheetId: string; version: TargetVersion; scroll: IScrollState; range: IRange | null; zoom: number }
const emptyScroll: IScrollState = { sheetViewStartRow: 0, sheetViewStartColumn: 0, offsetX: 0, offsetY: 0 }

export async function restoreGridTabView(session: Session, adapter: HcdUniverAdapter, revision: number, epoch: number) {
  const saved = readTabState<GridTabView>(tabStateKey(session, 'grid-view'))
  if (typeof saved?.sheetId !== 'string') return
  const sheet = adapter.workbook.getSheetBySheetId(saved.sheetId)
  if (!sheet || sheet.isSheetHidden()) return
  const rows = sheet.getMaxRows(), columns = sheet.getMaxColumns()
  const scroll = saved.scroll
  const position = isIndex(scroll?.sheetViewStartRow) && scroll.sheetViewStartRow < rows
    && isIndex(scroll.sheetViewStartColumn) && scroll.sheetViewStartColumn < columns
    && Number.isFinite(scroll.offsetX) && Number.isFinite(scroll.offsetY)
    ? { sheetViewStartRow: scroll.sheetViewStartRow, sheetViewStartColumn: scroll.sheetViewStartColumn, offsetX: scroll.offsetX, offsetY: scroll.offsetY } : emptyScroll
  const range = saved.range
  const selection = range && sameTargetVersion(saved.version, revision, epoch)
    && isIndex(range.startRow) && isIndex(range.endRow) && range.startRow <= range.endRow && range.endRow < rows
    && isIndex(range.startColumn) && isIndex(range.endColumn) && range.startColumn <= range.endColumn && range.endColumn < columns
    && (range.rangeType === undefined || [RANGE_TYPE.NORMAL, RANGE_TYPE.ROW, RANGE_TYPE.COLUMN, RANGE_TYPE.ALL].includes(range.rangeType))
    ? { startRow: range.startRow, startColumn: range.startColumn, endRow: range.endRow, endColumn: range.endColumn, rangeType: range.rangeType } : null
  const zoom = Number.isFinite(saved.zoom) && saved.zoom >= 0.25 && saved.zoom <= 3 ? saved.zoom : sheet.getZoom()
  await adapter.restoreViewport(sheet, position, selection, zoom)
}

export function trackGridTabView(session: Session, adapter: HcdUniverAdapter, univer: FUniver, version: () => TargetVersion | null) {
  const key = tabStateKey(session, 'grid-view')
  if (!key) return
  let active = true, last = ''
  const persist = () => {
    if (!active) return
    const targetVersion = version()
    if (!targetVersion) return
    const sheet = adapter.workbook.getActiveSheet()
    const value: GridTabView = { sheetId: sheet.getSheetId(), version: targetVersion, scroll: sheet.getScrollState(),
      range: sheet.getActiveRange()?.getRange() || null, zoom: sheet.getZoom() }
    const next = JSON.stringify(value)
    if (next !== last) { writeTabState(key, value); last = next }
  }
  const change = () => queueMicrotask(persist)
  const scroll = adapter.workbook.getActiveSheet().onScroll(change)
  const selection = univer.addEvent(univer.Event.CommandExecuted, ({ id }) => { if (id === SetSelectionsOperation.id) change() })
  const sheet = univer.addEvent(univer.Event.ActiveSheetChanged, change)
  const zoom = univer.addEvent(univer.Event.SheetZoomChanged, change)
  window.addEventListener('pagehide', persist)
  return () => {
    persist()
    active = false
    scroll.dispose(); selection.dispose(); sheet.dispose(); zoom.dispose()
    window.removeEventListener('pagehide', persist)
  }
}
