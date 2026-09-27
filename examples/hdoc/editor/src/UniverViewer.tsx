import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { BooleanNumber, createUniver, defaultTheme, LocaleType, RANGE_TYPE, type IWorkbookData } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { HcdUniverAdapter, type HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'
import { parseStyleCatalog } from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import { ServiceGridClient } from './ServiceGridClient.ts'
import { EditorHeader, EditorStatusbar, type EditorTab } from './EditorChrome.tsx'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'
import { api, type Session } from './api.ts'
import { ErrorToast } from './ErrorToast.tsx'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

type GridSelectionKind = 'cell' | 'row' | 'column' | 'all'

function selectionKind(sheet: ReturnType<HcdUniverAdapter['workbook']['getActiveSheet']>): GridSelectionKind {
  const range = sheet.getActiveRange()
  if (!range) return 'cell'
  const kind = range.getRange().rangeType
  if (kind === RANGE_TYPE.ROW) return 'row'
  if (kind === RANGE_TYPE.COLUMN) return 'column'
  if (kind === RANGE_TYPE.ALL) return 'all'
  const allRows = range.getRow() === 0 && range.getHeight() >= sheet.getMaxRows()
  const allColumns = range.getColumn() === 0 && range.getWidth() >= sheet.getMaxColumns()
  if (allRows && allColumns) return 'all'
  if (allColumns) return 'row'
  if (allRows) return 'column'
  return 'cell'
}

export function UniverViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [status, setStatus] = useState('正在加载工作簿')
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(session.scope === 'write')
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout('xlsx'))
  const [activeTab, setActiveTab] = useState<EditorTab>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState(false)
  const [columnBusy, setColumnBusy] = useState(false)
  const [rowInsertCount, setRowInsertCount] = useState('1')
  const [columnWidthBusy, setColumnWidthBusy] = useState(false)
  const [columnWidthChars, setColumnWidthChars] = useState('28')
  const [rowHeightBusy, setRowHeightBusy] = useState(false)
  const [rowHeightPoints, setRowHeightPoints] = useState('30')
  const [formulaAddress, setFormulaAddress] = useState('A1')
  const [formulaText, setFormulaText] = useState('')
  const [formulaDirty, setFormulaDirty] = useState(false)
  const [gridSelectionKind, setGridSelectionKind] = useState<GridSelectionKind>('cell')
  const formulaInput = useRef<HTMLInputElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<{ client: ServiceGridClient; adapter: HcdUniverAdapter } | null>(null)
  const syncing = useRef(false)
  const gridBusy = useRef(false)
  const collaboration = useFixedCollaboration(session, revision, next => setRemoteRevision(previous => Math.max(previous ?? 0, next)))
  useEffect(() => { saveLayout(layout, 'xlsx') }, [layout])
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  useEffect(() => {
    const current = runtime.current
    if (!current || remoteRevision === null || syncing.current || gridBusy.current) return
    if (remoteRevision <= current.client.manifest.revision) { setRemoteRevision(null); return }
    if (current.adapter.hasPendingPatch()) return
    syncing.current = true
    void current.adapter.refreshFromServer().then(refreshed => {
      if (!refreshed || runtime.current !== current) return
      setRevision(current.client.manifest.revision)
      setRemoteRevision(null)
      setError('')
    }).catch(cause => setError(`协作修订同步失败：${String(cause)}`)).finally(() => { syncing.current = false })
  }, [remoteRevision, revision, status])

  async function searchContent(query: string): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query })
    return (await api(session, `/search?${params}`)).json() as Promise<SearchResult>
  }

  async function navigateSearch(hit: SearchHit) {
    const current = runtime.current
    if (!current || !hit.sheetId) throw new Error('工作簿尚未加载完成')
    const descriptor = current.client.descriptors.find(item => item.sequence === hit.chunkSequence)
    if (!descriptor?.grid || descriptor.grid.sheetId !== hit.sheetId || descriptor.grid.rowStart === undefined || descriptor.grid.rowEnd === undefined) {
      throw new Error('搜索结果缺少单元格位置')
    }
    await current.adapter.loadRange(hit.sheetId, descriptor.grid.rowStart - 1, descriptor.grid.rowEnd - 1)
    if (!await current.adapter.focusNode(hit.nodeId)) throw new Error('单元格未能定位，请刷新工作簿')
  }

  useEffect(() => {
    let alive = true
    const client = new ServiceGridClient(session)
    let disposeUniver: (() => void) | undefined
    let removePatchListener: (() => void) | undefined
    const boot = async () => {
      await client.open()
      const styleCatalog = parseStyleCatalog(await client.readStyles())
      const sheets = client.sheets()
      if (!sheets.length || !host.current || !alive) throw new Error('工作簿没有可显示的工作表')
      const workbookData: Partial<IWorkbookData> = {
        id: client.manifest.documentId,
        name: `HCD revision ${client.manifest.revision}`,
        appVersion: '0.25.1', locale: LocaleType.ZH_CN, styles: styleCatalog,
        sheetOrder: sheets.map(sheet => sheet.sheetId),
        sheets: Object.fromEntries(sheets.map(sheet => {
          const descriptors = client.descriptors.filter(({ grid }) => grid?.sheetId === sheet.sheetId)
          const defaults = client.sheetDefaults(sheet.sheetId)
          return [sheet.sheetId, {
            id: sheet.sheetId, name: sheet.sheetName,
            hidden: sheet.sheetState === 'visible' ? BooleanNumber.FALSE : BooleanNumber.TRUE,
            rowCount: Math.min(1_048_576, Math.max(1_000, ...descriptors.map(({ grid }) => grid?.rowEnd ?? 1))),
            columnCount: Math.min(16_384, Math.max(26, ...descriptors.map(({ grid }) => grid?.columnEnd ?? 1))),
            defaultColumnWidth: defaults.columnWidth, defaultRowHeight: defaults.rowHeight,
            freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
            cellData: {}, rowData: {}, columnData: {}, mergeData: [],
            showGridlines: BooleanNumber.TRUE, rightToLeft: BooleanNumber.FALSE,
          }]
        })),
        custom: { hcdDocumentId: client.manifest.documentId,
          hcdRevision: client.manifest.revision, hcdRootHash: client.manifest.rootHash },
      }
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: zhCN }, theme: defaultTheme,
        presets: [UniverSheetsCorePreset({
          container: host.current,
          header: false, toolbar: false, formulaBar: true, contextMenu: false,
          footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: true,
            addSheetButtonConfig: { show: false } },
        }), UniverSheetsDrawingPreset()],
      })
      disposeUniver = () => univer.dispose()
      const workbook = univerAPI.createWorkbook(workbookData)
      const updateFormulaBar = () => {
        const sheet = workbook.getActiveSheet()
        const selection = sheet.getActiveRange()
        if (!selection || !alive) return
        setGridSelectionKind(selectionKind(sheet))
        const cell = sheet.getRange(selection.getRow(), selection.getColumn())
        setFormulaAddress(cell.getA1Notation())
        setFormulaText(String(cell.getFormulas?.()[0]?.[0] || (cell.getValue() ?? '')))
        setFormulaDirty(false)
      }
      univerAPI.addEvent(univerAPI.Event.SelectionChanged, updateFormulaBar)
      univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, updateFormulaBar)
      const adapter = new HcdUniverAdapter(client, univerAPI, workbook, editing ? 'editable' : 'readonly', message => {
        if (alive) setStatus(message)
      }, styleCatalog)
      let saveQueue = Promise.resolve()
      const onPatch = (event: Event) => {
        const detail = (event as CustomEvent<HcdPatchEventDetail>).detail
        if (!detail || detail.patch.documentId !== session.documentId) return
        saveQueue = saveQueue.catch(() => {}).then(async () => {
          const patch = { ...detail.patch, baseRevision: client.manifest.revision }
          try {
            if (alive) setStatus('保存中…')
            const response = await api(session, '/node-patch', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...patch, operations: patch.operations.map(({ type, ...operation }) => ({ op: type, ...operation })) }),
            })
            const result = await response.json() as { revision: number }
            const hashes: Record<string, string> = {}
            for (let index = 0; index < patch.operations.length; index += 1) {
              const operation = patch.operations[index]
              if (operation.type !== 'text.splice' && operation.type !== 'xlsx.formula.set'
                && operation.type !== 'xlsx.formula.to-value') continue
              const newText = operation.type === 'xlsx.formula.set' ? operation.formula
                : operation.type === 'xlsx.formula.to-value' ? operation.text
                : detail.changes.find(change => change.nodeId === operation.nodeId)?.newText
              if (newText === undefined) continue
              const bytes = new TextEncoder().encode(newText)
              const digest = await crypto.subtle.digest('SHA-256', bytes)
              hashes[operation.nodeId] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
            }
            adapter.acknowledgePatch(patch.patchId, result.revision, hashes)
            collaboration.announceRevision(result.revision)
            if (alive) { setRevision(result.revision); setError('') }
            try {
              await adapter.refreshChangedCells(detail.changes)
              updateFormulaBar()
              if (alive) setStatus(`revision ${result.revision} · 已保存`)
            } catch (cause) { if (alive) setError(`修订已保存，但索引刷新失败：${String(cause)}`) }
          } catch (cause) {
            adapter.rejectPatch(patch.patchId, '保存失败，已恢复单元格原值')
            if (alive) setError(`${String(cause)}。如其他人已更新，请重新打开文档。`)
          }
        })
      }
      window.addEventListener('hcd-patch', onPatch)
      removePatchListener = () => window.removeEventListener('hcd-patch', onPatch)
      await adapter.start()
      updateFormulaBar()
      runtime.current = { client, adapter }
      if (alive) { setRevision(client.manifest.revision); setStatus(`revision ${client.manifest.revision} · Canvas 按视口加载`) }
    }
    void boot().catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; runtime.current = null; removePatchListener?.(); disposeUniver?.(); client.dispose() }
  }, [session, editing, collaboration.announceRevision])

  async function mergeSelection() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || mergeBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if (!range || range.getHeight() * range.getWidth() < 2) {
        throw new Error('请先选中至少两个单元格')
      }
      const startRow = range.getRow()
      const startColumn = range.getColumn()
      const endRow = startRow + range.getHeight() - 1
      const endColumn = startColumn + range.getWidth() - 1
      const anchor = current.adapter.getNodeAt(sheet.getSheetId(), startRow, startColumn)
      if (anchor && !anchor.editable) throw new Error('合并区域左上角不可编辑')
      const anchorValue = sheet.getRange(startRow, startColumn).getValue()
      if (!anchor && anchorValue !== null && anchorValue !== undefined && String(anchorValue) !== '') {
        throw new Error('合并区域左上角仍有未保存的内容')
      }
      for (let row = startRow; row <= endRow; row += 1) {
        for (let column = startColumn; column <= endColumn; column += 1) {
          if (row === startRow && column === startColumn) continue
          const value = sheet.getRange(row, column).getValue()
          if (current.adapter.getNodeAt(sheet.getSheetId(), row, column)
            || (value !== null && value !== undefined && String(value) !== '')) {
            throw new Error('为避免丢失内容，合并区域中除左上角外的单元格必须为空')
          }
        }
      }
      setMergeBusy(true)
      setStatus('正在合并单元格…')
      const coordinates = { sheetId: sheet.getSheetId(),
        startRow: startRow + 1, startColumn: startColumn + 1,
        endRow: endRow + 1, endColumn: endColumn + 1 }
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: anchor ? 'hcd-patch/6' : 'hcd-patch/26', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [anchor
            ? { op: 'xlsx.merge', nodeId: anchor.nodeId, ...coordinates,
              precondition: { nodeHash: anchor.nodeHash } }
            : { op: 'xlsx.merge.blank', ...coordinates }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已合并 ${range.getA1Notation()}`)
    } catch (cause) {
      setError(`合并失败：${String(cause)}`)
    } finally {
      setMergeBusy(false)
    }
  }

  async function unmergeSelection() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || mergeBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const selected = sheet.getActiveRange()
      if (!selected) throw new Error('请先选中合并单元格')
      const row = selected.getRow()
      const column = selected.getColumn()
      const merged = sheet.getMergeData().find(range => row >= range.getRow()
        && row < range.getRow() + range.getHeight()
        && column >= range.getColumn() && column < range.getColumn() + range.getWidth())
      if (!merged) throw new Error('所选单元格没有合并')
      const anchor = current.adapter.getNodeAt(sheet.getSheetId(), merged.getRow(), merged.getColumn())
      if (!anchor?.editable) throw new Error('合并区域缺少可编辑的左上角单元格')
      setMergeBusy(true)
      setStatus('正在拆分单元格…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/11', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.unmerge', nodeId: anchor.nodeId, sheetId: sheet.getSheetId(),
            startRow: merged.getRow() + 1, startColumn: merged.getColumn() + 1,
            endRow: merged.getRow() + merged.getHeight(), endColumn: merged.getColumn() + merged.getWidth(),
            precondition: { nodeHash: anchor.nodeHash } }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已拆分 ${merged.getA1Notation()}`)
    } catch (cause) {
      setError(`拆分失败：${String(cause)}`)
    } finally { setMergeBusy(false) }
  }

  async function appendRow() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const sheetId = sheet.getSheetId()
      const count = Number(rowInsertCount)
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('插入行数必须是 1 到 100 的整数')
      const afterRow = Math.max(0, ...current.client.descriptors
        .filter(({ grid }) => grid?.kind === 'cells' && grid.sheetId === sheetId)
        .map(({ grid }) => grid?.rowEnd ?? 0))
      if (afterRow < 1 || afterRow + count > 1_048_576) {
        throw new Error('当前工作表没有可追加的行')
      }
      if (count > 1) {
        await applySelectedGridRange('row', 'insert', afterRow + 1, count)
        return
      }
      setRowBusy(true)
      setStatus('正在新增末尾行…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/8', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.row.append', sheetId, afterRow }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        setStatus(`revision ${saved.revision} · 已新增第 ${afterRow + 1} 行`)
      } catch (syncError) {
        setError(`第 ${afterRow + 1} 行已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`新增行失败：${String(cause)}`)
    } finally {
      setRowBusy(false)
    }
  }

  async function applySelectedGridRange(axis: 'row' | 'column', action: 'insert' | 'delete', startOverride?: number, countOverride?: number) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || gridBusy.current) return
    const sheet = current.adapter.workbook.getActiveSheet()
    const range = sheet.getActiveRange()
    if (!range) { setError('请先选中行或列'); return }
    const start = startOverride ?? (axis === 'row' ? range.getRow() : range.getColumn()) + 1
    const count = countOverride ?? (axis === 'row' ? range.getHeight() : range.getWidth())
    if (count < 2 || count > 100) { setError('一次请选择 2 到 100 行或列'); return }
    const label = axis === 'row' ? '行' : '列'
    if (action === 'delete' && !window.confirm(`删除选中的 ${count} ${label}及其内容？可从历史修订恢复。`)) return
    gridBusy.current = true
    if (axis === 'row') setRowBusy(true)
    else setColumnBusy(true)
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      setStatus(`正在${action === 'insert' ? '插入' : '删除'} ${count} ${label}…`)
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/25', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.grid.range', sheetId: sheet.getSheetId(), axis, action, start, count }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        // Insertion keeps the selected grid coordinate and viewport in place.
        // focusCell calls scrollToCell, which jumps a scrolled worksheet to the new range.
        if (action !== 'insert') {
          await current.adapter.focusCell(sheet.getSheetId(),
            axis === 'row' ? Math.max(0, start - 1) : range.getRow(),
            axis === 'column' ? Math.max(0, start - 1) : range.getColumn())
        }
        setStatus(`revision ${saved.revision} · 已${action === 'insert' ? '插入' : '删除'} ${count} ${label}`)
      } catch (syncError) {
        setError(`${count} ${label}已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`${action === 'insert' ? '插入' : '删除'} ${count} ${label}失败：${String(cause)}`)
    } finally {
      gridBusy.current = false
      if (axis === 'row') setRowBusy(false)
      else setColumnBusy(false)
    }
  }

  async function insertRowNearSelection(position: 'above' | 'below') {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if (!range) throw new Error('请先选中目标行中的单元格')
      const count = Number(rowInsertCount)
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('插入行数必须是 1 到 100 的整数')
      const beforeRow = range.getRow() + (position === 'below' ? range.getHeight() + 1 : 1)
      const sheetId = sheet.getSheetId()
      const lastRow = Math.max(0, ...current.client.descriptors
        .filter(({ grid }) => grid?.kind === 'cells' && grid.sheetId === sheetId)
        .map(({ grid }) => grid?.rowEnd ?? 0))
      if (beforeRow > lastRow + 1 || beforeRow + count - 1 > 1_048_576) {
        throw new Error('选中位置已在存储的最后一行之后；空白网格可直接编辑，需新增行请先选中最后一条已有行')
      }
      if (count > 1) {
        await applySelectedGridRange('row', 'insert', beforeRow, count)
        return
      }
      const append = beforeRow === lastRow + 1
      setRowBusy(true)
      setStatus(position === 'below' ? '正在下方插入行…' : '正在上方插入行…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: append ? 'hcd-patch/8' : 'hcd-patch/12', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [append ? { op: 'xlsx.row.append', sheetId, afterRow: lastRow }
            : { op: 'xlsx.row.insert', sheetId, beforeRow }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        setStatus(`revision ${saved.revision} · 已在第 ${position === 'below' ? beforeRow - 1 : beforeRow} 行${position === 'below' ? '后' : '前'}插入空行`)
      } catch (syncError) {
        setError(`第 ${beforeRow} 行已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`${position === 'below' ? '下方' : '上方'}插入行失败：${String(cause)}`)
    } finally { setRowBusy(false) }
  }

  async function insertColumnNearSelection(position: 'left' | 'right') {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy || columnBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if (!range) throw new Error('请先选中目标列中的单元格')
      const beforeColumn = range.getColumn() + (position === 'right' ? range.getWidth() + 1 : 1)
      if (range.getWidth() > 1) {
        await applySelectedGridRange('column', 'insert', beforeColumn)
        return
      }
      const sheetId = sheet.getSheetId()
      const lastColumn = Math.max(0, ...current.client.descriptors
        .filter(({ grid }) => grid?.kind === 'cells' && grid.sheetId === sheetId)
        .map(({ grid }) => grid?.columnEnd ?? 0))
      if (beforeColumn > lastColumn + 1 || beforeColumn > 16_384) {
        throw new Error('选中位置已在存储的最后一列之外；空白网格可直接编辑，需新增列请先选中最后一条已有列')
      }
      setColumnBusy(true)
      setStatus(position === 'right' ? '正在右侧插入列…' : '正在左侧插入列…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/13', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.column.insert', sheetId, beforeColumn }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        setStatus(`revision ${saved.revision} · 已在第 ${position === 'right' ? beforeColumn - 1 : beforeColumn} 列${position === 'right' ? '后' : '前'}插入空列`)
      } catch (syncError) {
        setError(`第 ${beforeColumn} 列已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`${position === 'right' ? '右侧' : '左侧'}插入列失败：${String(cause)}`)
    } finally { setColumnBusy(false) }
  }

  async function deleteSelectedColumn() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy || columnBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if ((range?.getWidth() ?? 0) > 1) {
        await applySelectedGridRange('column', 'delete')
        return
      }
      const column = (range?.getColumn() ?? -1) + 1
      if (!range || column < 1) throw new Error('请先选中要删除的列')
      if (!window.confirm(`删除第 ${column} 列及其中所有内容？可从历史修订恢复。`)) return
      setColumnBusy(true)
      setStatus('正在删除列…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/15', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.column.delete', sheetId: sheet.getSheetId(), column }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        await current.adapter.focusCell(sheet.getSheetId(), range.getRow(), Math.max(0, column - 2))
        setStatus(`revision ${saved.revision} · 已删除第 ${column} 列`)
      } catch (syncError) {
        setError(`第 ${column} 列已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`删除列失败：${String(cause)}`)
    } finally { setColumnBusy(false) }
  }

  async function deleteSelectedRow() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy || columnBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if ((range?.getHeight() ?? 0) > 1) {
        await applySelectedGridRange('row', 'delete')
        return
      }
      const row = (range?.getRow() ?? -1) + 1
      if (!range || row < 1) throw new Error('请先选中要删除的行')
      if (!window.confirm(`删除第 ${row} 行及其中所有内容？可从历史修订恢复。`)) return
      setRowBusy(true)
      setStatus('正在删除行…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/14', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.row.delete', sheetId: sheet.getSheetId(), row }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        await current.adapter.focusCell(sheet.getSheetId(), Math.max(0, row - 1), 0)
        setStatus(`revision ${saved.revision} · 已删除第 ${row} 行`)
      } catch (syncError) {
        setError(`第 ${row} 行已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`删除行失败：${String(cause)}`)
    } finally { setRowBusy(false) }
  }

  async function removeEmptyTailRow() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const sheetId = sheet.getSheetId()
      const row = Math.max(0, ...current.client.descriptors
        .filter(({ grid }) => grid?.kind === 'cells' && grid.sheetId === sheetId)
        .map(({ grid }) => grid?.rowEnd ?? 0))
      if (row < 2) throw new Error('当前工作表没有可撤销的末尾行')
      setRowBusy(true)
      setStatus('正在撤销末尾空行…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/10', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.row.remove-last', sheetId, row }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        await current.adapter.focusCell(sheetId, row - 2, 0)
        setStatus(`revision ${saved.revision} · 已撤销第 ${row} 行`)
      } catch (syncError) {
        setError(`第 ${row} 行已保存为 r${saved.revision} 的删除修订，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`撤销末尾空行失败：${String(cause)}`)
    } finally {
      setRowBusy(false)
    }
  }

  async function setSelectedColumnWidth() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || columnWidthBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if (!range) throw new Error('请先选中一个单元格或列')
      const column = range.getColumn() + 1
      const widthChars = Number(columnWidthChars)
      if (!Number.isFinite(widthChars) || widthChars < 1 || widthChars > 255) {
        throw new Error('列宽须在 1 到 255 之间')
      }
      setColumnWidthBusy(true)
      setStatus('正在保存列宽…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/9', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.column.width', sheetId: sheet.getSheetId(),
            column, widthChars: Math.round(widthChars * 100) / 100 }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        current.adapter.invalidateColumnWidths(sheet.getSheetId())
        await current.adapter.refreshFromServer()
        setStatus(`revision ${saved.revision} · 第 ${column} 列宽已设为 ${widthChars}`)
      } catch (syncError) {
        setError(`列宽已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`设置列宽失败：${String(cause)}`)
    } finally {
      setColumnWidthBusy(false)
    }
  }

  async function setSelectedRowHeight() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowHeightBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if (!range) throw new Error('请先选中一个单元格或行')
      const row = range.getRow() + 1
      const heightPoints = Number(rowHeightPoints)
      if (!Number.isFinite(heightPoints) || heightPoints < 1 || heightPoints > 409) {
        throw new Error('行高须在 1 到 409 磅之间')
      }
      setRowHeightBusy(true)
      setStatus('正在保存行高…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/18', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.row.height', sheetId: sheet.getSheetId(),
            row, heightPoints: Math.round(heightPoints * 100) / 100 }] }),
      })
      const saved = await response.json() as { revision: number }
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        current.adapter.invalidateRowHeights(sheet.getSheetId())
        await current.adapter.refreshFromServer()
        setStatus(`revision ${saved.revision} · 第 ${row} 行高已设为 ${heightPoints} 磅`)
      } catch (syncError) {
        setError(`行高已保存为 r${saved.revision}，视图同步失败：${String(syncError)}`)
      }
    } catch (cause) {
      setError(`设置行高失败：${String(cause)}`)
    } finally {
      setRowHeightBusy(false)
    }
  }

  function openGridContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLCanvasElement)
      || !event.target.id.startsWith('univer-sheet-main-canvas_')
      || !editing || session.scope !== 'write') return
    event.preventDefault()
    event.stopPropagation()
    const { clientX, clientY } = event
    // Univer updates the active range on right mouse down. Read it after that
    // event has finished so the menu acts on the cell under the pointer.
    requestAnimationFrame(() => setContextMenu({ x: clientX, y: clientY }))
  }

  function applyFormulaBarInput() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write') return
    if (!formulaDirty) return
    if (current.adapter.hasPendingPatch()) { setError('请等待当前单元格保存完成'); return }
    const sheet = current.adapter.workbook.getActiveSheet()
    const selection = sheet.getActiveRange()
    if (!selection) { setError('请先选择一个单元格'); return }
    try {
      current.adapter.applyCellInput(sheet.getSheetId(), selection.getRow(), selection.getColumn(), formulaText)
      setError('')
    } catch (cause) {
      setError(String(cause))
    }
  }

  const activeSheet = contextMenu && runtime.current?.adapter.workbook.getActiveSheet()
  const activeRange = activeSheet?.getActiveRange()
  const parsedRowInsertCount = Number(rowInsertCount)
  const validRowInsertCount = Number.isInteger(parsedRowInsertCount) && parsedRowInsertCount >= 1 && parsedRowInsertCount <= 100
  const contextSelectionKind = activeSheet ? selectionKind(activeSheet) : 'cell'
  const showRowContext = contextSelectionKind === 'cell' || contextSelectionKind === 'row'
  const showColumnContext = contextSelectionKind === 'cell' || contextSelectionKind === 'column'
  const selectedMerge = activeRange && activeSheet?.getMergeData().some(range =>
    activeRange.getRow() >= range.getRow()
    && activeRange.getRow() < range.getRow() + range.getHeight()
    && activeRange.getColumn() >= range.getColumn()
    && activeRange.getColumn() < range.getColumn() + range.getWidth())
  const gridActionDisabled = !editing || session.scope !== 'write' || mergeBusy || rowBusy || columnBusy
    || !!runtime.current?.adapter.hasPendingPatch()
  const contextActions: MenuAction[] = [
    ...(contextSelectionKind === 'cell' ? [{ label: '合并单元格', action: () => void mergeSelection(),
      disabled: gridActionDisabled || !activeRange || !!selectedMerge || activeRange.getHeight() * activeRange.getWidth() < 2 },
    { label: '拆分单元格', action: () => void unmergeSelection(), disabled: gridActionDisabled || !selectedMerge }] : []),
    ...(showRowContext ? [
      { label: `在上方插入 ${rowInsertCount || '…'} 行`, action: () => void insertRowNearSelection('above'), disabled: gridActionDisabled || !activeRange || !validRowInsertCount, separated: true },
      { label: `在下方插入 ${rowInsertCount || '…'} 行`, action: () => void insertRowNearSelection('below'), disabled: gridActionDisabled || !activeRange || !validRowInsertCount },
      { label: '删除选中行', action: () => void deleteSelectedRow(), disabled: gridActionDisabled || !activeRange },
    ] : []),
    ...(showColumnContext ? [
      { label: '在左侧插入列', action: () => void insertColumnNearSelection('left'), disabled: gridActionDisabled || !activeRange, separated: true },
      { label: '在右侧插入列', action: () => void insertColumnNearSelection('right'), disabled: gridActionDisabled || !activeRange },
      { label: '删除选中列', action: () => void deleteSelectedColumn(), disabled: gridActionDisabled || !activeRange },
    ] : []),
    ...(!showRowContext && !showColumnContext ? [{ label: '请选中行、列或单元格', action: () => {}, disabled: true }] : []),
  ]

  const headerStatus = error ? (error.includes('已保存为 r') ? '同步失败' : '保存失败') : status === '保存中…' ? '保存中' : revision === null ? '加载中' : editing ? '已保存' : '只读'
  return <div className={`workspace semantic-workspace univer-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''}`}>
    {layout.showHeader && <EditorHeader session={session} revision={revision} status={headerStatus} activeTab={activeTab}
      onTab={setActiveTab} onClose={onClose} onSettings={() => setSettingsOpen(previous => !previous)} onSearch={() => setSearchOpen(true)} settingsOpen={settingsOpen} presence={layout.showCollaborators ? collaboration.avatars : null} />}
    {!layout.showHeader && <button className="floating-settings" aria-label="界面设置" onClick={() => setSettingsOpen(true)}>⚙ 界面设置</button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} refreshKey={revision} />
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label="工作簿工具栏">
      {activeTab === 'home' && <><div className="tool-group"><button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void mergeSelection()}>合并单元格</button><button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void unmergeSelection()}>拆分单元格</button><label>列宽 <input aria-label="选中列宽度" type="number" min="1" max="255" step="0.5" value={columnWidthChars} disabled={!editing} onChange={event => setColumnWidthChars(event.target.value)} style={{ width: 68 }} /></label><button disabled={!editing || columnWidthBusy} onClick={() => void setSelectedColumnWidth()}>设置列宽</button><label>行高 <input aria-label="选中行高度" type="number" min="1" max="409" step="0.5" value={rowHeightPoints} disabled={!editing} onChange={event => setRowHeightPoints(event.target.value)} style={{ width: 68 }} /></label><button disabled={!editing || rowHeightBusy} onClick={() => void setSelectedRowHeight()}>设置行高</button></div><span className="ribbon-note">双击单元格或按 F2 编辑 · 右键显示操作菜单 · {status}</span></>}
      {activeTab === 'insert' && <><div className="tool-group">
        {gridSelectionKind !== 'column' && gridSelectionKind !== 'all' && <>
          <label className="xlsx-insert-count">插入行数 <input aria-label="插入行数" type="number" min="1" max="100" step="1" value={rowInsertCount} disabled={!editing || rowBusy} onChange={event => { setRowInsertCount(event.target.value); if (error.includes('插入行数必须')) setError('') }} /></label>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void insertRowNearSelection('above')}>在选中行前插入 {rowInsertCount || '…'} 行</button>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void insertRowNearSelection('below')}>在选中行后插入 {rowInsertCount || '…'} 行</button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void deleteSelectedRow()}>删除选中行</button>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void appendRow()}>在末尾新增 {rowInsertCount || '…'} 行</button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void removeEmptyTailRow()}>撤销末尾空行</button>
        </>}
        {gridSelectionKind !== 'row' && gridSelectionKind !== 'all' && <>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void insertColumnNearSelection('left')}>在选中列左侧插入</button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void insertColumnNearSelection('right')}>在选中列右侧插入</button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void deleteSelectedColumn()}>删除选中列</button>
        </>}
        {gridSelectionKind === 'cell' && <button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void mergeSelection()}>合并选中单元格</button>}
      </div><span className="ribbon-note">整行只显示行操作，整列只显示列操作；普通单元格可选择两种操作 · {status}</span></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={!editing} disabled={session.scope === 'read'} onChange={event => setEditing(!event.target.checked)} />只读模式</label><button onClick={() => setSettingsOpen(true)}>界面设置</button></>}
      {activeTab === 'revisions' && <span className="ribbon-note">当前修订 r{revision ?? '…'} · 每次单元格保存生成 HCD 修订</span>}
    </nav>}
    <form className="xlsx-formula-bar" aria-label="公式栏" onSubmit={event => { event.preventDefault(); applyFormulaBarInput() }}>
      <span className="xlsx-formula-address" aria-label="选中单元格">{formulaAddress}</span>
      <label htmlFor="xlsx-formula-expression">ƒx</label>
      <input id="xlsx-formula-expression" ref={formulaInput} aria-label="单元格内容或公式" value={formulaText}
        disabled={!editing} placeholder="输入文字、数字或 =SUM(A1:A10)"
        onChange={event => { setFormulaText(event.target.value); setFormulaDirty(true) }} />
      <select aria-label="插入常用函数" disabled={!editing} value="" onChange={event => {
        if (!event.target.value) return
        setFormulaText(`=${event.target.value}(`)
        setFormulaDirty(true)
        formulaInput.current?.focus()
      }}>
        <option value="">常用函数</option>
        {['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'IF'].map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <button type="submit" disabled={!editing}>应用内容</button>
    </form>
    <div className="univer-editor-area" onContextMenu={openGridContextMenu} onMouseDownCapture={() => setContextMenu(null)} onWheelCapture={() => setContextMenu(null)}><div ref={host} className="hcd-univer-host" />
      {settingsOpen && <aside className="workspace-sidebar" aria-label="界面设置"><section className="appearance-panel"><div className="panel-head"><h2>界面设置</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setSettingsOpen(false)}>×</button></div><label>显示顶部栏<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>显示操作栏<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>显示协作者<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><fieldset><legend>头部布局</legend><label><input type="radio" name="xlsx-header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />紧凑</label><label><input type="radio" name="xlsx-header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />标准</label></fieldset></section></aside>}
    </div>
    {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} actions={contextActions}
      count={showRowContext ? { label: '插入行数', value: rowInsertCount, onChange: value => { setRowInsertCount(value); if (error.includes('插入行数必须')) setError('') } } : undefined}
      onClose={() => setContextMenu(null)} />}
    <EditorStatusbar mode="工作簿视图" format="xlsx" revision={revision} readOnly={!editing} status={editing ? headerStatus : '已同步'} />
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
  </div>
}
