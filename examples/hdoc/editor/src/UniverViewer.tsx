import { keepHistory } from './editHistory.ts'
import { LeftPanelShell } from './LeftPanelShell.tsx'
import { AppearanceSelect, useAppearance } from './Appearance.tsx'
import { DocumentPanelTools } from './DocumentPanelTools.tsx'
import { WorkspacePanel } from './WorkspacePanel.tsx'
import { WorkspaceDrawers } from './WorkspaceDrawers.tsx'
import { useDocumentViewState } from './DocumentViewState.tsx'
import { CanvasViewport, useCanvasZoom } from './CanvasZoom.tsx'
import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { EmbedSelection, EmbedCommittedRevision } from './embedSelection'
import type { HcdEmbedSelection } from './public'
import { BooleanNumber, createUniver, defaultTheme, LocaleType, RANGE_TYPE, type IWorkbookData, type ICellData } from '@univerjs/presets'
import { CellAlertManagerService, DeviceInputEventType, extractFormulaError, IEditorService, SetFormulaCalculationResultMutation, SetSelectionsOperation, UniverSheetsCorePreset,
  SetInlineFormatBoldCommand, SetInlineFormatItalicCommand, SetInlineFormatUnderlineCommand,
  SetInlineFormatFontSizeCommand, SetInlineFormatTextColorCommand } from '@univerjs/preset-sheets-core'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/presets/preset-sheets-conditional-formatting'
import { HcdUniverAdapter, type HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'
import { parseStyleCatalog } from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import { editedInlineRuns, inheritInlineRuns, validateInlineRuns, type XlsxInlineRun } from '../../xlsx-univer-viewer/src/rich-text.ts'
import { ServiceGridClient } from './ServiceGridClient.ts'
import { restoreGridTabView, trackGridTabView } from './gridTabState.ts'
import type { CalculationResult } from './capabilities.ts'
import { EditorHeader, EditorStatusbar, ContentToolbar, CollapseSidebarIcon } from './EditorChrome.tsx'
import { ContextMenu, type MenuAction } from './ContextMenu.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'
import { api, type Session } from './api.ts'
import { loadThemeCss } from './themeCss.ts'
import { ErrorToast } from './ErrorToast.tsx'
import { useAgentActivities, useAgentWorkspace, AgentPanel } from './AgentActivityLayer.tsx'
import { useEmbeddedSearchLocation, useEmbeddedWorkspace } from './EmbeddedWorkspace'
import { useResourceNavigation } from './resources/ResourceWorkspace.tsx'
import { GridAgentOverlay } from './GridAgentOverlay.tsx'
import { InputDraftRecovery, useInputDraft } from './useInputDraft.tsx'
import type { InputDraft } from './inputDraftJournal.ts'
import { gridBatchDraft, parseGridBatch, type GridBatchDraft } from './gridBatchDraft.ts'
import { GridDataTools, type GridAutoFilter, type GridDataSelection, type GridFilterCriterion, type GridFilterView, type GridSortDirection } from './GridDataTools.tsx'
import { WorksheetChartDialog, WorksheetChartLayer, useWorksheetCharts } from './WorksheetCharts.tsx'
import { WorksheetConditionDialog } from './WorksheetConditions.tsx'
import { WorksheetPivotDialog, type PivotEntry } from './WorksheetPivots.tsx'
import { syncWorksheetConditions } from './worksheetConditionPreview.ts'
import { installWorkbookFocusBoundary } from './workbookFocus.ts'
import { pivotContains, pivotRange, type WorksheetChartConfig, type WorksheetConditionConfig,
  type WorksheetPivotConfig } from '../../xlsx-univer-viewer/src/hcd.ts'
import { formatRange } from './resources/resourceReference.ts'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

function univerLocale(locale: string): LocaleType {
  if (locale === 'zh-CN') return LocaleType.ZH_CN
  if (locale === 'zh-TW') return LocaleType.ZH_TW
  if (locale === 'zh-HK') return LocaleType.ZH_HK
  return LocaleType.EN_US
}

async function loadUniverMessages(locale: string) {
  if (locale === 'zh-CN') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-CN'), import('@univerjs/preset-sheets-drawing/locales/zh-CN')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-TW') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-TW'), import('@univerjs/preset-sheets-drawing/locales/zh-TW')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-HK') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-HK'), import('@univerjs/preset-sheets-drawing/locales/zh-HK')])
    return { ...core.default, ...drawing.default }
  }
  const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/en-US'), import('@univerjs/preset-sheets-drawing/locales/en-US')])
  return { ...core.default, ...drawing.default }
}

type GridSelectionKind = 'cell' | 'row' | 'column' | 'all'
type WorksheetFeatureEdit =
  | { op: 'xlsx.chart.set'; sheetId: string; chartId: string; config: WorksheetChartConfig | null }
  | { op: 'xlsx.condition.set'; sheetId: string; conditionId: string; config: WorksheetConditionConfig | null }
  | { op: 'xlsx.pivot.set'; sheetId: string; pivotId: string; config: WorksheetPivotConfig | null }
type EditStep = { revision: number; label: string }
type EditHistory = { head: number | null; past: EditStep[]; future: EditStep[] }
type GridInput = { schemaVersion: 'hcd-grid-input/1'; baseRevision: number; sheetId: string; row: number; column: number;
  address: string; original: string; text: string; nodeId?: string; nodeHash?: string; richRuns?: XlsxInlineRun[] }
function parseGridInput(record: InputDraft): GridInput {
  const input = JSON.parse(record.content) as GridInput
  if (!input || input.schemaVersion !== 'hcd-grid-input/1' || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0
    || typeof input.sheetId !== 'string' || !input.sheetId || !Number.isSafeInteger(input.row) || input.row < 0 || input.row >= 1_048_576
    || !Number.isSafeInteger(input.column) || input.column < 0 || input.column >= 16_384 || typeof input.address !== 'string'
    || typeof input.original !== 'string' || typeof input.text !== 'string' || input.text.length > 100_000
    || (input.nodeId !== undefined && (typeof input.nodeId !== 'string' || typeof input.nodeHash !== 'string'))) throw new Error('这份单元格输入无法安全恢复，请下载草稿保留')
  if (input.richRuns !== undefined) {
    validateInlineRuns(input.richRuns, input.text)
    if (input.nodeId ? !input.nodeHash : input.original !== '' || input.nodeHash !== undefined) throw new Error('富文本草稿缺少原单元格位置')
  }
  return input
}

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
  const { theme: appearanceTheme } = useAppearance()
  const agents = useAgentActivities()
  const { panelOpen, setPanelOpen, requestTask } = useAgentWorkspace()
  const { focused, setFocused, activeTab, setActiveTab, rightPanel, setRightPanel } = useDocumentViewState()
  const { zoom, setZoom } = useCanvasZoom()
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const { locale } = useI18n()
  const [status, setStatus] = useState('正在加载工作簿')
  const [revision, setRevision] = useState<number | null>(null)
  const [exportSheetName, setActiveSheetName] = useState<string>()
  const [activeSheetId, setActiveSheetId] = useState<string>()
  const [history, setHistory] = useState<EditHistory>({ head: null, past: [], future: [] })
  const [historyBusy, setHistoryBusy] = useState(false)
  const [collaborationEpoch, setCollaborationEpoch] = useState(session.collaborationEpoch)
  const epochRef = useRef(collaborationEpoch)
  epochRef.current = collaborationEpoch
  const inputProtection = useInputDraft(session, collaborationEpoch)
  const protectionRef = useRef(inputProtection)
  protectionRef.current = inputProtection
  const gridInput = useRef<GridInput | null>(null)
  const gridBatch = useRef<GridBatchDraft | null>(null)
  const [batchInput, setBatchInput] = useState<GridBatchDraft | null>(null)
  const [batchReview, setBatchReview] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const batchBusyRef = useRef(false)
  const commitBatchRef = useRef<(draft: GridBatchDraft, review: boolean) => Promise<void>>(async () => {})
  const [restoringInput, setRestoringInput] = useState(false)
  const restoringRef = useRef(false)
  const [error, setError] = useState('')
  const [themeCss, setThemeCss] = useState('')
  const editing = session.scope === 'write'
  const hostWorkspace = useEmbeddedWorkspace()
  const reportSelection = useContext(EmbedSelection)
  const [hostRange, setHostRange] = useState<Extract<HcdEmbedSelection['target'],{kind:'sheet'}> | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout(session.documentId, session.integratedToolbar))
  const settingsOpen = rightPanel === 'settings'
  const setSettingsOpen = (value: boolean | ((open: boolean) => boolean)) => setRightPanel(previous => (typeof value === 'function' ? value(previous === 'settings') : value) ? 'settings' : null)
  function openSettings() { setFocused(false); setPanelOpen(false); setSettingsOpen(true) }
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null)
  const hostRevision = useContext(EmbedCommittedRevision)
  useEffect(() => {
    if (hostRevision !== undefined) setRemoteRevision(previous => Math.max(previous ?? 0, hostRevision))
  }, [hostRevision])

  const [searchOpen, setSearchOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [deletionPrompt, setDeletionPrompt] = useState<string | null>(null)
  const deletionResolver = useRef<((confirmed: boolean) => void) | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState(false)
  const [columnBusy, setColumnBusy] = useState(false)
  const [rowInsertCount, setRowInsertCount] = useState('1')
  const [columnWidthBusy, setColumnWidthBusy] = useState(false)
  const [columnWidthChars, setColumnWidthChars] = useState('28')
  const [rowHeightBusy, setRowHeightBusy] = useState(false)
  const [rowHeightPoints, setRowHeightPoints] = useState('30')
  const [formatBusy, setFormatBusy] = useState(false)
  const [cellFontSize, setCellFontSize] = useState('11')
  const [cellFontColor, setCellFontColor] = useState('#112233')
  const [cellFillColor, setCellFillColor] = useState('#fff2cc')
  const [cellNumberFormat, setCellNumberFormat] = useState('0.00')
  const [renameBusy, setRenameBusy] = useState(false)
  const [sheetNameDraft, setSheetNameDraft] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [sheetAddDraft, setSheetAddDraft] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [freezeBusy, setFreezeBusy] = useState(false)
  const [formulaAddress, setFormulaAddress] = useState('A1')
  const [formulaText, setFormulaText] = useState('')
  const [formulaDirty, setFormulaDirty] = useState(false)
  const [formulaCalculation, setFormulaCalculation] = useState<CalculationResult | null>(null)
  const [verifiedFunctions, setVerifiedFunctions] = useState<string[]>([])
  const calculationRequest = useRef(0)
  const [gridSelectionKind, setGridSelectionKind] = useState<GridSelectionKind>('cell')
  useEffect(() => {
    if (!reportSelection) return
    reportSelection(editing && !formulaDirty && !batchInput && hostRange && revision !== null && collaborationEpoch !== undefined
      ? {documentId:session.documentId, revision, collaborationEpoch, target:hostRange} : null)
    return () => reportSelection(null)
  }, [reportSelection,editing,formulaDirty,batchInput,hostRange,revision,collaborationEpoch,session.documentId])
  const [dataSelection, setDataSelection] = useState<GridDataSelection | null>(null)
  const [dataBusy, setDataBusy] = useState(false)
  const [gridFilter, setGridFilter] = useState<{ selection: GridDataSelection; matched: number; total: number } | null>(null)
  const [savedFilter, setSavedFilter] = useState<{ selection: GridDataSelection; view: GridFilterView } | null>(null)
  const [loadingSavedFilter, setLoadingSavedFilter] = useState(false)
  const formulaInput = useRef<HTMLInputElement>(null)
  const updateFormulaBarRef = useRef<() => void>(() => {})
  const host = useRef<HTMLDivElement>(null)
  const mousePointerUp = useRef(false)
  const mouseClickCount = useRef(0)
  const runtime = useRef<{ client: ServiceGridClient; adapter: HcdUniverAdapter } | null>(null)
  const chartsSupported = runtime.current?.client.worksheetChartsSupported === true
  const worksheetCharts = useWorksheetCharts(session, activeSheetId, revision, chartsSupported)
  const [chartDialog, setChartDialog] = useState<{ sheetId: string; chartId?: string; newChart?: boolean } | null>(null)
  const conditionsSupported = runtime.current?.client.worksheetConditionsSupported === true
  const [conditionSheet, setConditionSheet] = useState<string>()
  const [pivotDialog, setPivotDialog] = useState<{ sheetId: string; selection: string; selected?: PivotEntry }>()
  const pivotsSupported = runtime.current?.client.worksheetPivotsSupported === true
  const conditionRules = useMemo(() => {
    const current = runtime.current
    return current && activeSheetId && current.client.manifest.revision === revision
      ? current.client.worksheetConditions(activeSheetId) : undefined
  }, [activeSheetId, revision, session])
  useEffect(() => {
    const current = runtime.current
    if (current && conditionsSupported && activeSheetId && conditionRules) {
      syncWorksheetConditions(current.adapter, activeSheetId, conditionRules)
    }
  }, [conditionsSupported, activeSheetId, conditionRules])
  function changeGridInput(sheetId: string, row: number, column: number, text: string, document?: ICellData['p']) {
    const current = runtime.current
    if (!current || !editingRef.current || gridBatch.current) return
    const sheet = current.adapter.workbook.getSheetBySheetId(sheetId)
    if (!sheet) return
    const previous = gridInput.current
    if (previous && (previous.sheetId !== sheetId || previous.row !== row || previous.column !== column)) {
      setError('请先应用或取消当前未提交输入'); return
    }
    const cell = sheet.getRange(row, column), link = current.adapter.getNodeAt(sheetId, row, column)
    let richRuns: XlsxInlineRun[] | undefined
    try {
      if (document && (!link || link.editable || link.formulaEditable) && !text.startsWith('=')) {
        richRuns = editedInlineRuns(text, document, link ?? { text: '' }) ?? undefined
      } else if (!document && previous?.richRuns && !text.startsWith('=')) {
        richRuns = inheritInlineRuns(previous.richRuns, text)
      }
    } catch (cause) { setError(String(cause)); return }
    const input: GridInput = { ...(previous ?? { schemaVersion: 'hcd-grid-input/1', baseRevision: current.client.manifest.revision,
      sheetId, row, column, address: cell.getA1Notation(),
      original: link?.formula ?? link?.text ?? String(cell.getFormulas?.()[0]?.[0] || (cell.getValue() ?? '')),
      nodeId: link?.nodeId, nodeHash: link?.nodeHash }), text, richRuns }
    gridInput.current = text === input.original && !richRuns ? null : input
    protectionRef.current.write(gridInput.current)
    setFormulaText(text); setFormulaDirty(!!gridInput.current)
  }
  function changeFormulaInput(text: string) {
    const current = runtime.current
    if (!current || gridBatch.current || restoringRef.current) return
    const input = gridInput.current, sheet = current.adapter.workbook.getActiveSheet(), selection = sheet.getActiveRange()
    if (input) changeGridInput(input.sheetId, input.row, input.column, text)
    else if (selection) changeGridInput(sheet.getSheetId(), selection.getRow(), selection.getColumn(), text)
  }
  function cancelGridInput() {
    if (gridBatch.current) return
    if (runtime.current?.adapter.hasPendingPatch() || runtime.current?.adapter.workbook.isCellEditing()) {
      setError('请先结束单元格编辑或等待当前保存完成'); return
    }
    gridInput.current = null; protectionRef.current.write(null); setFormulaDirty(false)
    updateFormulaBarRef.current()
  }
  async function reviewGridBatch(input: GridBatchDraft) {
    const result = await (await api(session, '/node-patch-review', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(input.collaborationEpoch) },
      body: JSON.stringify(input.patch), signal: AbortSignal.timeout(15_000),
    })).json() as { protocolVersion: string; documentId: string; patchId: string; state: string; revision: number; appliedRevision?: number }
    if (result.protocolVersion !== 'hcd-node-patch-review/1' || result.documentId !== session.documentId || result.patchId !== input.patch.patchId
      || !Number.isSafeInteger(result.revision) || !['ready','applied'].includes(result.state)
      || result.state === 'ready' && result.revision !== input.patch.baseRevision
      || result.state === 'applied' && (result.appliedRevision !== input.patch.baseRevision + 1 || result.revision < result.appliedRevision)) {
      throw new Error('文档版本或提交回执不一致；草稿已保留，请下载核对')
    }
    return result
  }
  async function discardGridBatch() {
    const current = runtime.current
    if (!current || batchBusyRef.current || !gridBatch.current) return
    batchBusyRef.current = true; setBatchBusy(true)
    try {
      await current.adapter.refreshFromServer()
      if (runtime.current !== current) return
      gridBatch.current = null; setBatchInput(null); protectionRef.current.write(null)
      setRevision(current.client.manifest.revision); resetHistory(current.client.manifest.revision)
      updateFormulaBarRef.current(); setError(''); setStatus('已同步服务端内容')
    } catch (cause) { setError(`刷新失败，草稿仍保留：${String(cause)}`) }
    finally { batchBusyRef.current = false; if (runtime.current === current) { setBatchBusy(false); current.adapter.setInputBlocked(!!gridBatch.current) } }
  }
  function downloadGridBatch() {
    if (!gridBatch.current) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(gridBatch.current, null, 2)], {type:'application/json'}))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.documentId}-grid-draft.json`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
  async function restoreGridInput(record: InputDraft) {
    const current = runtime.current
    if (!current || !editingRef.current || gridInput.current || gridBatch.current || current.adapter.hasPendingPatch() || current.adapter.workbook.isCellEditing() || restoringRef.current) throw new Error('请先应用或取消当前输入并等待保存完成')
    restoringRef.current = true; setRestoringInput(true)
    current.adapter.setInputBlocked(true)
    try {
      if (JSON.parse(record.content)?.schemaVersion === 'hcd-grid-batch-input/1') {
        const input = parseGridBatch(record), receipt = await protectionRef.current.validate(record)
        if (input.collaborationEpoch !== record.epoch) throw new Error('草稿协同版本不一致，请下载核对')
        const reviewed = await reviewGridBatch(input)
        if (runtime.current !== current || !protectionRef.current.unchanged(receipt)) throw new Error('当前文档或输入已变化，请重新核对')
        if (reviewed.state === 'applied') {
          await current.adapter.refreshFromServer()
          if (runtime.current !== current || !protectionRef.current.unchanged(receipt)) throw new Error('当前文档或输入已变化，请重新核对')
          await protectionRef.current.dismiss(record)
          setRevision(current.client.manifest.revision); resetHistory(current.client.manifest.revision)
          setStatus(`已核对：这批输入已保存为 r${reviewed.appliedRevision}，没有再次提交`)
          updateFormulaBarRef.current()
        } else {
          await protectionRef.current.adopt(record)
          if (runtime.current !== current) return
          gridBatch.current = input; setBatchInput(input); setBatchReview(true); setError('')
        }
        return
      }
      const input = parseGridInput(record), receipt = await protectionRef.current.validate(record)
      const manifest = await (await api(session, '')).json() as { revision: number }
      if (manifest.revision !== input.baseRevision || manifest.revision !== current.client.manifest.revision) throw new Error('文档版本已变化；草稿已保留，请下载核对')
      await current.adapter.focusCell(input.sheetId, input.row, input.column)
      const link = current.adapter.getNodeAt(input.sheetId, input.row, input.column)
      if (link?.nodeId !== input.nodeId || link?.nodeHash !== input.nodeHash) throw new Error('目标单元格已变化；草稿已保留，请下载核对')
      if (runtime.current !== current || !protectionRef.current.unchanged(receipt)) throw new Error('当前文档或输入已变化，请重新核对')
      await protectionRef.current.adopt(record)
      if (runtime.current !== current) return
      gridInput.current = input; setFormulaText(input.text); setFormulaAddress(input.address); setFormulaDirty(true)
      formulaInput.current?.focus()
    } finally { restoringRef.current = false; setRestoringInput(false); current.adapter.setInputBlocked(!!gridBatch.current) }
  }
  const localeApi = useRef<Pick<ReturnType<typeof createUniver>['univerAPI'], 'loadLocales' | 'setLocale'> | null>(null)
  useEffect(() => {
    const sheet = runtime.current?.adapter.workbook.getActiveSheet()
    if (sheet && Math.abs(sheet.getZoom() - zoom) > 0.005) sheet.zoom(zoom)
  }, [zoom])
  const syncing = useRef(false)
  const gridBusy = useRef(false)
  const collaborationSession = useMemo(() => ({ ...session, collaborationEpoch }), [session, collaborationEpoch])
  const collaboration = useFixedCollaboration(collaborationSession, revision, next => setRemoteRevision(previous => Math.max(previous ?? 0, next)))
  const announceRevision = useRef(collaboration.announceRevision)
  announceRevision.current = collaboration.announceRevision
  function recordEdit(nextRevision: number, label: string) {
    setHistory(previous => ({ head: nextRevision,
      past: keepHistory([...(previous.head === nextRevision - 1 ? previous.past : []), { revision: nextRevision - 1, label }]),
      future: [] }))
  }
  function resetHistory(nextRevision: number) {
    setHistory({ head: nextRevision, past: [], future: [] })
  }
  const historyLocked = historyBusy || mergeBusy || rowBusy || columnBusy || columnWidthBusy || rowHeightBusy || renameBusy
    || addBusy || formatBusy || deleteBusy || freezeBusy || !!batchInput || batchBusy || dataBusy || status === '保存中…' || !!runtime.current?.adapter.hasPendingPatch()
  async function travelHistory(direction: 'undo' | 'redo') {
    const current = runtime.current
    const steps = direction === 'undo' ? history.past : history.future
    if (!current || !editing || session.scope !== 'write' || historyLocked || gridBusy.current || gridInput.current || gridBatch.current || restoringRef.current || !steps.length) return
    const target = steps[steps.length - 1]
    const head = current.client.manifest.revision
    if (history.head !== head) {
      resetHistory(head)
      setError('其他协作者已更新工作簿；已同步新修订，请重新操作')
      return
    }
    setHistoryBusy(true)
    setStatus(direction === 'undo' ? '正在撤销…' : '正在重做…')
    try {
      const response = await api(session, `/restore/${target.revision}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: head }),
      })
      const saved = await response.json() as { revision: number }
      setHistory(previous => direction === 'undo'
        ? { head: saved.revision, past: previous.past.slice(0, -1),
          future: keepHistory([...previous.future, { revision: head, label: target.label }]) }
        : { head: saved.revision, past: keepHistory([...previous.past, { revision: head, label: target.label }]),
          future: previous.future.slice(0, -1) })
      collaboration.announceRevision(saved.revision)
      setRemoteRevision(null)
      setError('')
      await current.adapter.refreshFromServer()
      // Derived rule previews read the refreshed client index. Publishing the
      // new revision before that await memoizes an empty rule set against the
      // old manifest and leaves undo/redo unpainted until a session renewal.
      setRevision(saved.revision)
      updateFormulaBarRef.current()
      const auth = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      setCollaborationEpoch(auth.collaborationEpoch)
      setStatus(`revision ${saved.revision} · 已${direction === 'undo' ? '撤销' : '重做'}：${target.label}`)
    } catch (cause) {
      setError(`${direction === 'undo' ? '撤销' : '重做'}失败：${String(cause)}`)
      try {
        if (await current.adapter.refreshFromServer()) {
          const actual = current.client.manifest.revision
          setRevision(actual)
          resetHistory(actual)
        }
      } catch { /* Keep the error visible until a later sync succeeds. */ }
    } finally { setHistoryBusy(false) }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!host.current?.getClientRects().length || host.current.closest(".document-tab-panel[hidden]")) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo')
        : key === 'y' && !event.shiftKey ? 'redo' : null
      if (!direction || !editing || !runtime.current) return
      event.preventDefault()
      void travelHistory(direction)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  useEffect(() => () => { deletionResolver.current?.(false); deletionResolver.current = null }, [])
  useEffect(() => { saveLayout(layout, session.documentId, session.integratedToolbar) }, [layout, session.documentId, session.integratedToolbar])
  useEffect(() => {
    let live = true
    loadThemeCss(session, null)
      .then(css => { if (live) setThemeCss(css) })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session])
  useEffect(() => { setGridFilter(null) }, [session, revision, editing])

  useEffect(() => {
    const current = runtime.current
    if (!current || session.format !== 'xlsx' || revision === null || !activeSheetId) return
    const controller = new AbortController()
    const query = new URLSearchParams({ sheetId: activeSheetId, revision: String(revision) })
    setLoadingSavedFilter(true)
    void api(session, `/grid-filter?${query}`, { signal: controller.signal })
      .then(response => response.json() as Promise<GridFilterView | null>)
      .then(view => {
        if (controller.signal.aborted || runtime.current !== current) return
        const sheet = current.adapter.workbook.getActiveSheet()
        if (sheet.getSheetId() !== activeSheetId) return
        if (!view) { setSavedFilter(null); return }
        const { startRow, endRow, startColumn, endColumn } = view.filter
        const address = sheet.getRange(startRow - 1, startColumn - 1, endRow - startRow + 1,
          endColumn - startColumn + 1).getA1Notation()
        current.adapter.applySavedFilter(activeSheetId, view.hiddenRows)
        setSavedFilter({ selection: { sheetId: activeSheetId, address, startRow, endRow, startColumn, endColumn }, view })
      })
      .catch(cause => { if (!controller.signal.aborted) setError(`读取已保存筛选失败：${String(cause)}`) })
      .finally(() => { if (!controller.signal.aborted) setLoadingSavedFilter(false) })
    return () => controller.abort()
  }, [session, revision, activeSheetId, editing])
  function confirmDeletion(message: string): Promise<boolean> {
    return new Promise(resolve => {
      if (deletionResolver.current) { resolve(false); return }
      deletionResolver.current = resolve
      setDeletionPrompt(message)
    })
  }
  function answerDeletion(confirmed: boolean) {
    const resolve = deletionResolver.current
    deletionResolver.current = null
    setDeletionPrompt(null)
    resolve?.(confirmed)
  }
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  useEffect(() => {
    const current = runtime.current
    if (!current || remoteRevision === null || syncing.current || gridBusy.current || historyBusy) return
    if (remoteRevision <= current.client.manifest.revision) { setRemoteRevision(null); return }
    if (current.adapter.hasPendingPatch() || gridInput.current || gridBatch.current || current.adapter.workbook.isCellEditing() || restoringRef.current) return
    syncing.current = true
    void current.adapter.refreshFromServer().then(async refreshed => {
      if (!refreshed || runtime.current !== current) return
      const auth = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      if (runtime.current !== current) return
      const actual = current.client.manifest.revision
      epochRef.current = auth.collaborationEpoch
      setCollaborationEpoch(auth.collaborationEpoch)
      setRevision(actual)
      updateFormulaBarRef.current()
      setHistory(previous => previous.head === actual ? previous : { head: actual, past: [], future: [] })
      setRemoteRevision(previous => previous !== null && previous > actual ? previous : null)
      setError('')
    }).catch(cause => setError(`协作修订同步失败：${String(cause)}`)).finally(() => { syncing.current = false })
  }, [remoteRevision, revision, status, historyBusy, session, formulaDirty, restoringInput, batchInput])

  useEffect(() => {
    const current = localeApi.current
    if (!current) return
    let active = true
    void loadUniverMessages(locale).then(messages => {
      if (!active || localeApi.current !== current) return
      const localeType = univerLocale(locale)
      current.loadLocales(localeType, messages)
      current.setLocale(localeType)
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [locale, revision])

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

  useEmbeddedSearchLocation(session, revision, !!runtime.current, async ({ hit }) => {
    if (gridInput.current || gridBatch.current || runtime.current?.adapter.workbook.isCellEditing()) {
      throw new Error('请先确认当前单元格中的输入，再打开搜索结果。')
    }
    await navigateSearch(hit)
  }, setError)

  useEffect(() => {
    let alive = true
    const client = new ServiceGridClient(session)
    setRevision(null)
    setSavedFilter(null)
    setLoadingSavedFilter(false)
    let disposeUniver: (() => void) | undefined
    let removePatchListener: (() => void) | undefined
    let stopTrackingView: (() => void) | undefined
    const boot = async () => {
      await client.open()
      const auth = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      if (!alive) return
      epochRef.current = auth.collaborationEpoch
      setCollaborationEpoch(auth.collaborationEpoch)
      const styleCatalog = parseStyleCatalog(await client.readStyles())
      const sheets = client.sheets()
      if (!sheets.length || !host.current || !alive) throw new Error('工作簿没有可显示的工作表')
      const localeType = univerLocale(locale)
      const localeMessages = await loadUniverMessages(locale)
      if (!alive || !host.current) return
      const workbookData: Partial<IWorkbookData> = {
        id: client.manifest.documentId,
        name: `HCD revision ${client.manifest.revision}`,
        appVersion: '0.25.1', locale: localeType, styles: styleCatalog,
        sheetOrder: sheets.map(sheet => sheet.sheetId),
        sheets: Object.fromEntries(sheets.map(sheet => {
          const descriptors = client.descriptors.filter(({ grid }) => grid?.sheetId === sheet.sheetId)
          const defaults = client.sheetDefaults(sheet.sheetId)
          const charts = descriptors.flatMap(({ grid }) => grid?.charts ?? []).filter(chart => !chart.removed)
          return [sheet.sheetId, {
            id: sheet.sheetId, name: sheet.sheetName,
            hidden: sheet.sheetState === 'visible' ? BooleanNumber.FALSE : BooleanNumber.TRUE,
            rowCount: Math.min(1_048_576, Math.max(1_000, ...descriptors.map(({ grid }) => grid?.rowEnd ?? 1), ...charts.map(chart => chart.config.anchorRow))),
            columnCount: Math.min(16_384, Math.max(26, ...descriptors.map(({ grid }) => grid?.columnEnd ?? 1), ...charts.map(chart => chart.config.anchorColumn))),
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
        locale: localeType, locales: { [localeType]: localeMessages }, theme: defaultTheme,
        presets: [UniverSheetsCorePreset({
          container: host.current,
          // Restored background workbooks must not focus their temporary cell
          // editor portal and clear the active document's DOM selection.
          disableAutoFocus: true,
          header: false, toolbar: false, formulaBar: true, contextMenu: false,
          footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: true,
            addSheetButtonConfig: { show: false } },
        }), UniverSheetsDrawingPreset(),
        ...(client.worksheetConditionsSupported ? [UniverSheetsConditionalFormattingPreset()] : [])],
      })
      const releaseFocusBoundary = installWorkbookFocusBoundary(univer.__getInjector().get(IEditorService), () => host.current)
      localeApi.current = univerAPI
      disposeUniver = () => { univer.dispose(); releaseFocusBoundary() }
      const workbook = univerAPI.createWorkbook(workbookData)
      workbook.getActiveSheet().zoom(zoomRef.current)
      univerAPI.addEvent(univerAPI.Event.SheetZoomChanged, () => setZoom(workbook.getActiveSheet().getZoom()))
      univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () => setZoom(workbook.getActiveSheet().getZoom()))
      const updateFormulaBar = () => {
        if (!alive) return
        const sheet = workbook.getActiveSheet()
        setActiveSheetName(sheet.getSheetName())
        setActiveSheetId(sheet.getSheetId())
        const selection = sheet.getActiveRange()
        if (!selection) return
        const kind = selectionKind(sheet)
        setGridSelectionKind(kind)
        setDataSelection(kind === 'cell' ? {
          sheetId: sheet.getSheetId(), address: selection.getA1Notation(),
          startRow: selection.getRow() + 1, endRow: selection.getRow() + selection.getHeight(),
          startColumn: selection.getColumn() + 1, endColumn: selection.getColumn() + selection.getWidth(),
        } : null)
        if (reportSelection) {
          const bounds=selection.getRange(), sheetId=sheet.getSheetId()
          const target={kind:'sheet' as const,sheetId,sheetIndex:client.sheets().findIndex(s=>s.sheetId===sheetId),
            top:bounds.startRow,left:bounds.startColumn,bottom:bounds.endRow,right:bounds.endColumn}
          const allowed=target.sheetIndex>=0 && (target.bottom-target.top+1)*(target.right-target.left+1)<=128
          setHostRange(previous => !allowed ? null : JSON.stringify(previous)===JSON.stringify(target) ? previous : target)
        }
        const cell = sheet.getRange(selection.getRow(), selection.getColumn())
        setFormulaAddress(cell.getA1Notation())
        // Continue tracking the real selection while keeping the draft's own
        // target visible separately. Calculation must not replace its text.
        if (gridInput.current || gridBatch.current) return
        setFormulaText(String(cell.getFormulas?.()[0]?.[0] || (cell.getValue()
          ?? runtime.current?.adapter.getNodeAt(sheet.getSheetId(), selection.getRow(), selection.getColumn())?.text ?? '')))
        setFormulaDirty(false)
        const request = ++calculationRequest.current
        const address = cell.getA1Notation()
        setFormulaCalculation(null)
        void client.readCalculation(sheet.getSheetId(), address).then(value => {
          if (!alive || request !== calculationRequest.current || runtime.current?.adapter.hasPendingPatch()) return
          setFormulaCalculation(value?.formula ? value.calculation : null)
        }).catch(() => {
          if (alive && request === calculationRequest.current && String(cell.getFormulas?.()[0]?.[0] ?? '').startsWith('=')) {
            setFormulaCalculation({ status: 'unavailable', value: null, error: 'calculation_unavailable' })
          }
        })
      }
      updateFormulaBarRef.current = updateFormulaBar
      // The UI selection observable may attach before/after the first render
      // depending on lazy boot. Follow the completed model operation instead.
      univerAPI.addEvent(univerAPI.Event.CommandExecuted, ({ id }) => {
        if (id === SetSelectionsOperation.id) queueMicrotask(updateFormulaBar)
        if (id === SetFormulaCalculationResultMutation.id) queueMicrotask(() => {
          if (!alive) return
          // Univer's error popup follows pointer movement. Recheck it after
          // both native and verified recalculations under a stationary pointer.
          const alerts = univer.__getInjector().get(CellAlertManagerService)
          for (const [key, { alert }] of alerts.currentAlert) {
            if (key !== 'SHEET_FORMULA_ALERT' || alert.location.unitId !== client.manifest.documentId) continue
            const cell = workbook.getSheetBySheetId(alert.location.subUnitId)
              ?.getRange(alert.location.row, alert.location.col).getCellData()
            if (!extractFormulaError(cell)) alerts.removeAlert(key)
          }
        })
      })
      let currentSheetId = workbook.getActiveSheet().getSheetId()
      univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, ({ activeSheet }) => {
        if (currentSheetId !== activeSheet.getSheetId()) {
          currentSheetId = activeSheet.getSheetId()
          runtime.current?.adapter.clearRowFilter()
          if (alive) { setGridFilter(null); setSavedFilter(null) }
        }
        updateFormulaBar()
      })
      const adapter = new HcdUniverAdapter(client, univerAPI, workbook, editingRef.current ? 'editable' : 'readonly', message => {
        if (alive) setStatus(message)
      }, styleCatalog, message => { if (alive) setError(message) })
      disposeUniver = () => { adapter.dispose(); univer.dispose(); releaseFocusBoundary() }
      univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, event => {
        // Univer counts canvas releases within 500 ms as a double click even
        // when the user clicked our external toolbar in between. For a mouse,
        // require the browser's mousedown click count to confirm a double click.
        // Touch double taps, typing, F2 and programmatic editing keep their
        // own entry points; this gate only covers the pointerup dispatch.
        if (mousePointerUp.current && event.eventType === DeviceInputEventType.Dblclick) { event.cancel = true; return }
        if (gridInput.current || gridBatch.current || restoringRef.current) { event.cancel = true; setError('请先应用或取消当前未提交输入') }
      })
      univerAPI.addEvent(univerAPI.Event.SheetEditChanging, event => {
        if (alive) changeGridInput(event.worksheet.getSheetId(), event.row, event.column, event.value.toPlainText(), event.value.getData())
      })
      univerAPI.addEvent(univerAPI.Event.BeforeSheetEditEnd, event => {
        if (!alive) return
        if (event.isConfirm) changeGridInput(event.worksheet.getSheetId(), event.row, event.column, event.value.toPlainText(), event.value.getData())
        else if (gridInput.current?.sheetId === event.worksheet.getSheetId() && gridInput.current.row === event.row && gridInput.current.column === event.column) {
          gridInput.current = null; protectionRef.current.write(null); setFormulaDirty(false)
          queueMicrotask(updateFormulaBar)
        }
      })
      commitBatchRef.current = async (draft, review) => {
        if (!alive || batchBusyRef.current || !editingRef.current || gridBatch.current !== draft) return
        batchBusyRef.current = true; setBatchBusy(true); adapter.setInputBlocked(true)
        const receipt = protectionRef.current.capture()
        try {
          // A request may commit even when its response never reaches this
          // browser. Preserve its exact identity before the first network write.
          await protectionRef.current.flush(receipt, draft)
          if (!alive || !protectionRef.current.unchanged(receipt)) return
          if (review) {
            const checked = await reviewGridBatch(draft)
            if (!alive || !protectionRef.current.unchanged(receipt)) return
            if (checked.state === 'applied') {
              await adapter.refreshFromServer()
              if (!alive) return
              protectionRef.current.acknowledge(receipt)
              gridBatch.current = null; setBatchInput(null)
              setRevision(client.manifest.revision); resetHistory(client.manifest.revision)
              updateFormulaBar()
              setStatus(`已核对：这批输入已保存为 r${checked.appliedRevision}，没有再次提交`); setError('')
              return
            }
          }
          setStatus('保存中…')
          const patch = draft.patch
          const response = await api(session, '/node-patch', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(draft.collaborationEpoch) },
            body: JSON.stringify(patch), signal: AbortSignal.timeout(20_000),
          })
          const result = await response.json() as { revision: number }
          if (!alive) return
          if (result.revision !== patch.baseRevision + 1) throw new Error('提交回执不一致，请核对后重试')
          const hashes: Record<string, string> = {}
          for (const operation of patch.operations) {
            if (operation.op !== 'text.splice' && operation.op !== 'xlsx.richText.set' && operation.op !== 'xlsx.formula.set'
              && operation.op !== 'xlsx.formula.to-value') continue
            const newText = operation.op === 'xlsx.formula.set' ? operation.formula
              : operation.op === 'xlsx.formula.to-value' ? operation.text
              : operation.op === 'xlsx.richText.set' ? operation.runs.map(run => run.text).join('')
              : draft.changes.find(change => change.nodeId === operation.nodeId)?.newText
            if (newText === undefined) continue
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(newText))
            hashes[operation.nodeId] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
          }
          if (!alive) return
          const optimistic = adapter.hasPendingPatch()
          adapter.acknowledgePatch(patch.patchId, result.revision, hashes)
          protectionRef.current.acknowledge(receipt)
          recordEdit(result.revision, '编辑单元格')
          announceRevision.current(result.revision)
          setRevision(result.revision); setError('')
          try {
            if (optimistic) await adapter.refreshChangedCells(draft.changes)
            else await adapter.refreshFromServer()
            if (alive) setStatus(`revision ${result.revision} · 已保存`)
          } catch (cause) { if (alive) setError(`修订已保存，但索引刷新失败：${String(cause)}`) }
          if (alive) { gridBatch.current = null; setBatchInput(null); updateFormulaBar() }
        } catch (cause) {
          if (alive) {
            adapter.rejectPatch(draft.patch.patchId, '保存未确认，输入已保留')
            setBatchReview(true)
            setError(`${String(cause)}。修改已保留，请核对后重试或下载草稿。`)
          }
        } finally {
          batchBusyRef.current = false
          if (alive) { setBatchBusy(false); adapter.setInputBlocked(!!gridBatch.current) }
        }
      }
      const onPatch = (event: Event) => {
        const detail = (event as CustomEvent<HcdPatchEventDetail>).detail
        if (!detail || detail.patch.documentId !== session.documentId) return
        if (gridBatch.current || restoringRef.current) {
          adapter.rejectPatch(detail.patch.patchId, '请先处理保留的单元格修改')
          setError('请先核对并提交或舍弃保留的单元格修改'); return
        }
        const draft = gridBatchDraft(detail, epochRef.current ?? 0)
        gridBatch.current = draft; setBatchInput(draft); setBatchReview(false); adapter.setInputBlocked(true)
        gridInput.current = null; setFormulaDirty(false)
        protectionRef.current.write(draft)
        void commitBatchRef.current(draft, false)
      }
      window.addEventListener('hcd-patch', onPatch)
      removePatchListener = () => window.removeEventListener('hcd-patch', onPatch)
      await adapter.start()
      await adapter.waitForRendered()
      if (!alive) return
      try { await restoreGridTabView(session, adapter, client.manifest.revision, auth.collaborationEpoch) }
      catch { /* An unavailable cached viewport must leave the workbook usable. */ }
      if (!alive) return
      stopTrackingView = trackGridTabView(session, adapter, univerAPI, () => {
        const epoch = epochRef.current
        return epoch === undefined ? null : { revision: client.manifest.revision, collaborationEpoch: epoch }
      })
      if (alive) setVerifiedFunctions(client.verifiedFunctions)
      updateFormulaBar()
      runtime.current = { client, adapter }
      if (alive) {
        setRevision(client.manifest.revision)
        setHistory(previous => previous.head === client.manifest.revision ? previous
          : { head: client.manifest.revision, past: [], future: [] })
        setStatus(`revision ${client.manifest.revision} · Canvas 按视口加载`)
      }
    }
    void boot().catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; runtime.current = null; localeApi.current = null; updateFormulaBarRef.current = () => {}; stopTrackingView?.(); removePatchListener?.(); disposeUniver?.(); client.dispose() }
  }, [session])

  async function saveWorksheetChart(chartId: string, config: WorksheetChartConfig | null) {
    const snapshot = worksheetCharts.snapshot
    if (!snapshot) throw new Error('图表正在同步，请稍后重试。')
    await saveWorksheetFeature({ op: 'xlsx.chart.set', sheetId: snapshot.sheetId, chartId, config }, snapshot.revision)
  }

  async function saveWorksheetFeature(operation: WorksheetFeatureEdit, baseRevision: number) {
    const current = runtime.current
    const isPivot = operation.op === 'xlsx.pivot.set'
    const feature = operation.op === 'xlsx.chart.set' ? '图表' : isPivot ? '透视表' : '条件格式'
    const schema = operation.op === 'xlsx.chart.set' ? 'hcd-patch/56' : isPivot ? 'hcd-patch/59' : 'hcd-patch/58'
    if (!current || !editing || current.client.manifest.revision !== baseRevision
      || (isPivot ? !current.adapter.workbook.getSheetBySheetId(operation.sheetId)
        : current.adapter.workbook.getActiveSheet().getSheetId() !== operation.sheetId)
      || gridBusy.current || syncing.current || historyLocked || current.adapter.hasPendingPatch()
      || gridInput.current || gridBatch.current || current.adapter.workbook.isCellEditing()) {
      throw new Error(`请等待工作簿同步，并确认当前单元格编辑后再操作${feature}。`)
    }
    gridBusy.current = true
    current.adapter.lockCellWrites(true)
    setDataBusy(true)
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: schema, documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision, operations: [operation] }),
      })
      const saved = await response.json() as { revision: number }
      if (runtime.current !== current) return
      recordEdit(saved.revision, `${operation.config ? '保存' : '移除'}${feature}`)
      collaboration.announceRevision(saved.revision)
      try {
        await current.adapter.refreshFromServer()
        if (runtime.current === current && isPivot && operation.config) {
          await current.adapter.focusCell(operation.sheetId, operation.config.anchorRow - 1, operation.config.anchorColumn - 1)
        }
        if (runtime.current === current) updateFormulaBarRef.current()
      } catch (cause) {
        setError(`${feature}已保存为 r${saved.revision}，视图同步失败：${String(cause)}`)
      } finally {
        setRevision(saved.revision)
        setStatus(`revision ${saved.revision}`)
      }
    } finally {
      current.adapter.lockCellWrites(false)
      gridBusy.current = false
      setDataBusy(false)
    }
  }

  function openPivot() {
    const current = runtime.current
    if (!current || !activeSheetId) return
    const active = current.adapter.workbook.getActiveSheet().getActiveRange()
    const pivot = current.client.worksheetPivots(activeSheetId).find(pivot =>
      active && pivotContains(pivotRange(pivot), active.getRow(), active.getColumn()))
    const selection = dataSelection?.sheetId === activeSheetId ? dataSelection : null
    let address = selection?.address ?? formulaAddress
    if (!selection || selection.startRow === selection.endRow) {
      const windows = current.client.descriptors.filter(({ grid }) => grid?.sheetId === activeSheetId && grid.kind === 'cells')
      const bottom = Math.max(2, ...windows.map(({ grid }) => grid?.rowEnd ?? 1))
      const right = Math.max(1, ...windows.map(({ grid }) => grid?.columnEnd ?? 1))
      if (bottom * right <= 20_000 && right <= 64) {
        address = formatRange({ row: 0, column: 0, endRow: bottom - 1, endColumn: right - 1 })
      }
    }
    setPivotDialog({ sheetId: activeSheetId, selection: address, selected: pivot ? { sheetId: activeSheetId, pivot } : undefined })
  }

  async function sortSelection(sortColumn: number, hasHeader: boolean, direction: GridSortDirection) {
    const current = runtime.current
    const selection = dataSelection
    if (!current || !selection || !editing || session.scope !== 'write' || gridFilter || savedFilter || loadingSavedFilter
      || historyLocked || gridBusy.current || syncing.current || current.adapter.hasPendingPatch()) return
    gridBusy.current = true
    current.adapter.lockCellWrites(true)
    setDataBusy(true)
    setStatus('正在排序…')
    setError('')
    try {
      const { address: _address, ...range } = selection
      const response = await api(session, '/grid-sort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...range, sortColumn, hasHeader, direction,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision }),
      })
      const saved = await response.json() as { revision: number; changed: boolean }
      if (runtime.current !== current) return
      if (!saved.changed) { setStatus('选区已按指定顺序排列'); return }
      recordEdit(saved.revision, '排序选区')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      try {
        await current.adapter.refreshFromServer()
        updateFormulaBarRef.current()
        setStatus(`revision ${saved.revision} · 选区已排序`)
      } catch (cause) {
        setError(`排序已保存为 r${saved.revision}，视图同步失败：${String(cause)}`)
      }
    } catch (cause) {
      if (runtime.current === current) {
        setError(`排序失败：${String(cause)}`)
        setStatus(`revision ${current.client.manifest.revision}`)
      }
    } finally {
      current.adapter.lockCellWrites(false)
      gridBusy.current = false
      setDataBusy(false)
    }
  }

  async function filterSelection(criteria: GridFilterCriterion[], hasHeader: boolean) {
    const current = runtime.current
    const selection = gridFilter?.selection ?? dataSelection
    if (!current || !selection || savedFilter || loadingSavedFilter || historyLocked || gridBusy.current || syncing.current || current.adapter.hasPendingPatch()) return
    gridBusy.current = true
    current.adapter.lockCellWrites(true)
    setDataBusy(true)
    try {
      const result = await current.adapter.filterRows(selection.sheetId,
        selection.startRow - 1 + Number(hasHeader), selection.endRow - 1,
        criteria.map(({ column, query }) => ({ column: column - 1, query })))
      if (runtime.current === current) {
        setGridFilter({ selection, ...result })
        setError('')
      }
    } catch (cause) {
      if (runtime.current === current) setError(`筛选失败：${String(cause)}`)
    } finally {
      current.adapter.lockCellWrites(false)
      gridBusy.current = false
      setDataBusy(false)
    }
  }

  async function saveGridFilter(selection: GridDataSelection, filter: GridAutoFilter | null) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || session.format !== 'xlsx'
      || historyLocked || gridBusy.current || loadingSavedFilter || syncing.current || current.adapter.hasPendingPatch()) return
    gridBusy.current = true
    current.adapter.lockCellWrites(true)
    setDataBusy(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/51', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.auto-filter.set', sheetId: selection.sheetId, filter }] }),
      })
      const saved = await response.json() as { revision: number }
      if (runtime.current !== current) return
      recordEdit(saved.revision, filter ? '保存筛选' : '移除已保存筛选')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      try {
        await current.adapter.refreshFromServer()
        const sheet = current.adapter.workbook.getActiveSheet()
        if (!filter && sheet.getSheetId() === selection.sheetId) {
          sheet.setActiveRange(sheet.getRange(selection.startRow - 1, selection.startColumn - 1,
            selection.endRow - selection.startRow + 1, selection.endColumn - selection.startColumn + 1))
        }
        updateFormulaBarRef.current()
      } catch (cause) {
        setError(`筛选已保存为 r${saved.revision}，视图同步失败：${String(cause)}`)
      }
    } catch (cause) {
      if (runtime.current === current) setError(`保存筛选失败：${String(cause)}`)
    } finally {
      current.adapter.lockCellWrites(false)
      gridBusy.current = false
      setDataBusy(false)
    }
  }

  function saveSelectedFilter([primary, ...additionalCriteria]: GridFilterCriterion[]) {
    const selection = savedFilter?.selection ?? gridFilter?.selection ?? dataSelection
    if (!selection || !primary) return
    const { startRow, endRow, startColumn, endColumn } = selection
    void saveGridFilter(selection, { startRow, endRow, startColumn, endColumn, ...primary,
      additionalCriteria: additionalCriteria.length ? additionalCriteria : undefined })
  }

  function clearGridFilter() {
    if (savedFilter) { void saveGridFilter(savedFilter.selection, null); return }
    const adapter = runtime.current?.adapter
    adapter?.clearRowFilter()
    const selection = gridFilter?.selection
    const sheet = adapter?.workbook.getActiveSheet()
    if (selection && sheet?.getSheetId() === selection.sheetId) {
      sheet.setActiveRange(sheet.getRange(selection.startRow - 1, selection.startColumn - 1,
        selection.endRow - selection.startRow + 1, selection.endColumn - selection.startColumn + 1))
    }
    setGridFilter(null)
  }

  async function mergeSelection() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || mergeBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '合并单元格')
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '拆分单元格')
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已拆分 ${merged.getA1Notation()}`)
    } catch (cause) {
      setError(`拆分失败：${String(cause)}`)
    } finally { setMergeBusy(false) }
  }

  function selectedCellLink() {
    const current = runtime.current
    const sheet = current?.adapter.workbook.getActiveSheet()
    const range = sheet?.getActiveRange()
    if (!current || !sheet || !range) return undefined
    return current.adapter.getNodeAt(sheet.getSheetId(), range.getRow(), range.getColumn())
  }

  async function saveCellFormat(format: { bold?: boolean; italic?: boolean; underline?: boolean; fontSizePt?: number; color?: string; fill?: string }) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || formatBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (current.adapter.workbook.isCellEditing()) {
        if (format.fill !== undefined) throw new Error('请先确认文字编辑，再设置单元格填充')
        const commands = [
          ...(format.bold !== undefined ? [{id: SetInlineFormatBoldCommand.id}] : []),
          ...(format.italic !== undefined ? [{id: SetInlineFormatItalicCommand.id}] : []),
          ...(format.underline !== undefined ? [{id: SetInlineFormatUnderlineCommand.id}] : []),
          ...(format.fontSizePt !== undefined ? [{id: SetInlineFormatFontSizeCommand.id, value: String(format.fontSizePt)}] : []),
          ...(format.color !== undefined ? [{id: SetInlineFormatTextColorCommand.id, value: format.color}] : []),
        ]
        for (const command of commands) {
          if (!await current.adapter.univerAPI.executeCommand(command.id, {value: 'value' in command ? command.value : undefined})) {
            throw new Error('请先在单元格内选中要修改的文字')
          }
        }
        const document = current.adapter.univerAPI.getActiveDocument()?.getSnapshot()
        const sheet = current.adapter.workbook.getActiveSheet(), range = sheet.getActiveRange()
        if (document && range) changeGridInput(sheet.getSheetId(), range.getRow(), range.getColumn(),
          current.adapter.univerAPI.newRichTextValue(document).toPlainText(), document)
        return
      }
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const link = selectedCellLink()
      if (!link) throw new Error('请先选中已有内容的单元格')
      setFormatBusy(true)
      setStatus('正在设置单元格格式…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/31', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.cell.format', nodeId: link.nodeId, format,
            precondition: { nodeHash: link.nodeHash } }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了格式修改')
      recordEdit(saved.revision, '设置单元格格式')
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已设置单元格格式`)
    } catch (cause) {
      setError(`设置格式失败：${String(cause)}`)
    } finally {
      setFormatBusy(false)
    }
  }

  async function saveCellLayout(layout: { horizontal?: 'left' | 'center' | 'right'; vertical?: 'top' | 'center' | 'bottom'; wrap?: boolean; border?: 'none' | 'thin' }) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || formatBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const link = selectedCellLink()
      if (!link) throw new Error('请先选中已有内容的单元格')
      setFormatBusy(true)
      setStatus('正在设置单元格对齐…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/32', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.cell.layout', nodeId: link.nodeId, layout,
            precondition: { nodeHash: link.nodeHash } }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了对齐修改')
      recordEdit(saved.revision, '设置单元格对齐')
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已设置单元格对齐`)
    } catch (cause) {
      setError(`设置对齐失败：${String(cause)}`)
    } finally {
      setFormatBusy(false)
    }
  }

  async function saveCellNumberFormat(formatCode: string) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || formatBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const link = selectedCellLink()
      if (!link) throw new Error('请先选中已有内容的单元格')
      const code = formatCode.trim()
      if (!code || code.length > 1024) throw new Error('数字格式必须是 1 到 1024 个字符')
      setFormatBusy(true)
      setStatus('正在设置数字格式…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/33', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.cell.numberFormat', nodeId: link.nodeId,
            numberFormat: { formatCode: code },
            precondition: { nodeHash: link.nodeHash } }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了数字格式')
      recordEdit(saved.revision, '设置数字格式')
      collaboration.announceRevision(saved.revision)
      await current.adapter.refreshFromServer()
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已设置数字格式`)
    } catch (cause) {
      setError(`设置数字格式失败：${String(cause)}`)
    } finally {
      setFormatBusy(false)
    }
  }

  function activeSheetName(): string {
    const current = runtime.current
    return current ? current.adapter.workbook.getActiveSheet().getSheetName() : ''
  }

  /** Excel's tab-name rule: 1 to 31 characters, none of the path and glob set. */
  function sheetNameProblem(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || [...trimmed].length > 31) return '工作表名必须是 1 到 31 个字符'
    if (/[/\\?*[\]:]/.test(trimmed) || trimmed.startsWith("'") || trimmed.endsWith("'")) {
      return '工作表名不能包含 / \\ ? * [ ] : 或以单引号开头结尾'
    }
    return ''
  }

  async function renameActiveSheet(name: string) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || renameBusy) return
    const sheetId = current.adapter.workbook.getActiveSheet().getSheetId()
    const trimmed = name.trim()
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const problem = sheetNameProblem(trimmed)
      if (problem) throw new Error(problem)
      if (trimmed === activeSheetName()) throw new Error('新名称必须与当前工作表名不同')
      setRenameBusy(true)
      setStatus('正在重命名工作表…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/34', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.sheet.rename', sheetId, name: trimmed }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了工作表重命名')
      await current.adapter.refreshFromServer()
      current.adapter.renameSheet(sheetId, trimmed)
      recordEdit(saved.revision, '重命名工作表')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setSheetNameDraft('')
      setError('')
      setStatus(`revision ${saved.revision} · 已重命名工作表 ${trimmed}`)
    } catch (cause) {
      setError(`重命名工作表失败：${String(cause)}`)
    } finally {
      setRenameBusy(false)
    }
  }

  async function addWorksheet(name: string) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || addBusy || renameBusy) return
    const trimmed = name.trim()
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const problem = sheetNameProblem(trimmed)
      if (problem) throw new Error(problem)
      // HCD compares tab names without regard to case, so the button checks the
      // same way instead of letting the server reject the patch.
      if (current.client.sheets().some(({ sheetName }) =>
        sheetName.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error('已存在同名工作表')
      }
      setAddBusy(true)
      setStatus('正在新增工作表…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/35', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.sheet.add', name: trimmed }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了工作表新增')
      await current.adapter.refreshFromServer()
      // HCD mints the tab's grid id, so the tab is found by name in the index
      // the reload just fetched, and only where Univer has no tab for it yet.
      const created = current.client.sheets().find(({ sheetId, sheetName }) =>
        sheetName === trimmed && !current.adapter.workbook.getSheetBySheetId(sheetId))
      if (!created) throw new Error('服务器已记录新增工作表，但索引里没有它')
      await current.adapter.addSheet(trimmed, created.sheetId)
      recordEdit(saved.revision, '新增工作表')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setSheetAddDraft('')
      setError('')
      setStatus(`revision ${saved.revision} · 已新增工作表 ${trimmed}`)
    } catch (cause) {
      setError(`新增工作表失败：${String(cause)}`)
    } finally {
      setAddBusy(false)
    }
  }

  async function deleteActiveSheet() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || deleteBusy) return
    const sheet = current.adapter.workbook.getActiveSheet()
    const sheetId = sheet.getSheetId()
    const name = sheet.getSheetName()
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      // What the bundle holds decides whether a tab may go, not the tabs on
      // screen: a hidden worksheet is still a tab, and a workbook left with no
      // visible tab is not a file Excel opens.
      const sheets = current.client.sheets()
      const visible = sheets.filter(({ sheetState }) => sheetState === 'visible')
      if (visible.length <= 1 && visible.some(({ sheetId: id }) => id === sheetId)) {
        throw new Error('工作簿必须保留一个可见工作表')
      }
      if (!sheets.some(({ sheetId: id }) => id === sheetId)) {
        throw new Error(`HCD 索引里没有工作表 ${name}`)
      }
      setDeleteBusy(true)
      setStatus('正在删除工作表…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/36', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.sheet.delete', sheetId }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了工作表删除')
      // The tab leaves the local workbook before the index reloads: the reload
      // fetches the windows of whichever sheet is active, and after a deletion
      // that has to be a sheet the document still has.
      current.adapter.removeSheet(sheetId)
      await current.adapter.refreshFromServer()
      recordEdit(saved.revision, '删除工作表')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      setStatus(`revision ${saved.revision} · 已删除工作表 ${name}`)
    } catch (cause) {
      setError(`删除工作表失败：${String(cause)}`)
    } finally {
      setDeleteBusy(false)
    }
  }

  /** The band the worksheet on screen holds still, as Univer sees it right now. */
  function currentFreeze(): { rows: number; columns: number } {
    const current = runtime.current
    if (!current) return { rows: 0, columns: 0 }
    const freeze = current.adapter.workbook.getActiveSheet().getFreeze()
    return { rows: freeze?.ySplit ?? 0, columns: freeze?.xSplit ?? 0 }
  }

  /**
   * Hold the first `rows` rows and the first `columns` columns of the worksheet
   * on screen still. Excel sets the split at the cell the cursor stands on, so
   * the pane button reads it from there, and `0`/`0` lets the band go again.
   */
  async function freezeActiveSheet(rows: number, columns: number) {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || freezeBusy) return
    const sheet = current.adapter.workbook.getActiveSheet()
    const name = sheet.getSheetName()
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      if (!Number.isInteger(rows) || rows < 0 || rows > 1_048_575) throw new Error('冻结行数须在 0 到 1048575 之间')
      if (!Number.isInteger(columns) || columns < 0 || columns > 16_383) throw new Error('冻结列数须在 0 到 16383 之间')
      setFreezeBusy(true)
      setStatus('正在设置冻结窗格…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/45', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.sheet.freeze', sheetId: sheet.getSheetId(), rows, columns }] }),
      })
      const saved = await response.json() as { revision?: number; message?: string }
      if (!response.ok || saved.revision === undefined) throw new Error(saved.message || '服务器拒绝了冻结窗格')
      // The band moves on screen before the chunks reload, so the sheet already
      // scrolls the way the saved file will once the reload lands. The reload
      // carries the same split: HCD writes it into every window of the sheet.
      if (rows > 0 || columns > 0) {
        sheet.setFreeze({ startRow: rows, startColumn: columns, xSplit: columns, ySplit: rows })
      } else {
        sheet.cancelFreeze()
      }
      await current.adapter.refreshFromServer()
      recordEdit(saved.revision, rows > 0 || columns > 0 ? '设置冻结窗格' : '取消冻结')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      setStatus(rows > 0 || columns > 0
        ? `revision ${saved.revision} · ${name} 已冻结前 ${rows} 行 ${columns} 列`
        : `revision ${saved.revision} · ${name} 已取消冻结`)
    } catch (cause) {
      setError(`设置冻结窗格失败：${String(cause)}`)
    } finally {
      setFreezeBusy(false)
    }
  }

  /** Freeze above and to the left of the cell the cursor stands on. */
  function freezeAtSelection() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || freezeBusy) return
    const range = current.adapter.workbook.getActiveSheet().getActiveRange()
    if (!range) { setError('请先选中要冻结区域右下方的单元格'); return }
    if (range.getRow() === 0 && range.getColumn() === 0) {
      setError('A1 的上方和左侧没有可冻结的行或列，请选中其他单元格')
      return
    }
    void freezeActiveSheet(range.getRow(), range.getColumn())
  }

  async function appendRow() {
    const current = runtime.current
    if (!current || !editing || session.scope !== 'write' || rowBusy) return
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '新增行')
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
    if (action === 'delete' && !await confirmDeletion(`删除选中的 ${count} ${label}及其内容？可从历史修订恢复。`)) return
    gridBusy.current = true
    if (axis === 'row') setRowBusy(true)
    else setColumnBusy(true)
    try {
      if (current.adapter.hasPendingPatch()) throw new Error('请等待当前单元格保存完成')
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      setStatus(`正在${action === 'insert' ? '插入' : '删除'} ${count} ${label}…`)
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/25', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.grid.range', sheetId: sheet.getSheetId(), axis, action, start, count }] }),
      })
      const saved = await response.json() as { revision: number }
      recordEdit(saved.revision, '插入或删除多行列')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
        // Keep the selected grid coordinate and viewport in place. focusCell
        // changes a row/column selection into a cell and scrolls the sheet.
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '插入行')
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '插入列')
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if ((range?.getWidth() ?? 0) > 1) {
        await applySelectedGridRange('column', 'delete')
        return
      }
      const column = (range?.getColumn() ?? -1) + 1
      if (!range || column < 1) throw new Error('请先选中要删除的列')
      if (!await confirmDeletion(`删除第 ${column} 列及其中所有内容？可从历史修订恢复。`)) return
      setColumnBusy(true)
      setStatus('正在删除列…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/15', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.column.delete', sheetId: sheet.getSheetId(), column }] }),
      })
      const saved = await response.json() as { revision: number }
      recordEdit(saved.revision, '删除列')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
      const sheet = current.adapter.workbook.getActiveSheet()
      const range = sheet.getActiveRange()
      if ((range?.getHeight() ?? 0) > 1) {
        await applySelectedGridRange('row', 'delete')
        return
      }
      const row = (range?.getRow() ?? -1) + 1
      if (!range || row < 1) throw new Error('请先选中要删除的行')
      if (!await confirmDeletion(`删除第 ${row} 行及其中所有内容？可从历史修订恢复。`)) return
      setRowBusy(true)
      setStatus('正在删除行…')
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/14', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: current.client.manifest.revision,
          operations: [{ op: 'xlsx.row.delete', sheetId: sheet.getSheetId(), row }] }),
      })
      const saved = await response.json() as { revision: number }
      recordEdit(saved.revision, '删除行')
      collaboration.announceRevision(saved.revision)
      setRevision(saved.revision)
      setError('')
      try {
        await current.adapter.refreshFromServer()
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '删除末尾空行')
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '设置列宽')
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
      if (gridInput.current || gridBatch.current || restoringRef.current) throw new Error('请先应用或取消当前未提交输入')
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
      recordEdit(saved.revision, '设置行高')
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
    if (!formulaDirty || gridBatch.current) return
    if (current.adapter.hasPendingPatch()) { setError('请等待当前单元格保存完成'); return }
    const input = gridInput.current
    if (!input || restoringRef.current) return
    if (current.adapter.workbook.isCellEditing()) { setError('请先结束单元格编辑'); return }
    if (input.baseRevision !== current.client.manifest.revision) { setError('文档版本已变化，请复制输入并核对最新单元格'); return }
    const link = current.adapter.getNodeAt(input.sheetId, input.row, input.column)
    if (link?.nodeId !== input.nodeId || link?.nodeHash !== input.nodeHash) { setError('目标单元格已变化，请复制输入并核对'); return }
    try {
      if (input.richRuns) current.adapter.applyRichCellInput(input.sheetId, input.row, input.column, input.richRuns)
      else current.adapter.applyCellInput(input.sheetId, input.row, input.column, input.text)
      setError('')
    } catch (cause) {
      setError(String(cause))
    }
  }

  const activeSheet = contextMenu && runtime.current?.adapter.workbook.getActiveSheet()
  const chartSheet = chartsSupported ? runtime.current?.adapter.workbook.getActiveSheet() : undefined
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
  const gridActionDisabled = !editing || session.scope !== 'write' || mergeBusy || rowBusy || columnBusy || formulaDirty || !!batchInput || restoringInput
    || !!runtime.current?.adapter.hasPendingPatch()
  const contextActions: MenuAction[] = [
    { label: '用 Agent 修改选区…', accent: true, disabled: gridActionDisabled || !activeRange, action: () => {
      setFocused(false)
      const currentRevision = runtime.current?.client.manifest.revision
      const epoch = epochRef.current
      const targetVersion = currentRevision === undefined || epoch === undefined ? undefined : { revision: currentRevision, collaborationEpoch: epoch }
      requestTask('请修改当前选区，保留其他单元格、公式与格式：', { sheetId: activeSheet?.getSheetId(), range: activeRange?.getA1Notation(), nodeId: selectedCellLink()?.nodeId, format: 'xlsx' }, { targetVersion })
    } },
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

  const headerStatus = error ? (error.includes('已保存为 r') ? '同步失败' : '保存失败') : status === '保存中…' ? '保存中' : revision === null ? '加载中' : formulaDirty || batchInput ? '编辑中' : editing ? '已保存' : '只读'
  const draftTargetLabel = gridInput.current ? `${runtime.current?.adapter.workbook.getSheetBySheetId(gridInput.current.sheetId)?.getSheetName() || localizeSource(locale, '工作表')}!${gridInput.current.address}` : ''
  const locatingResource = useResourceNavigation(session, revision !== null && !!runtime.current, async ({ ref, preview, ai }) => {
    const current = runtime.current, bounds = preview.bounds
    if (!current || ref.anchor.kind !== 'sheet-range' || !bounds) throw new Error('表格引用尚未就绪。')
    if (formulaDirty || gridBatch.current || current.adapter.workbook.isCellEditing() || current.adapter.hasPendingPatch()) throw new Error('请先保存当前单元格输入，再定位引用。')
    if (current.client.manifest.revision < preview.revision && await current.adapter.refreshFromServer()) {
      const head = current.client.manifest.revision
      setRevision(head)
      resetHistory(head)
    }
    if (runtime.current !== current || current.client.manifest.revision !== preview.revision) {
      throw new Error('源工作表在定位期间已更新，请再次打开引用。')
    }
    setFocused(false)
    await current.adapter.loadRange(ref.anchor.sheetId, bounds.row, bounds.endRow)
    const access = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
    if (runtime.current !== current || current.client.manifest.revision !== preview.revision) {
      throw new Error('源工作表在定位期间已更新，请再次打开引用。')
    }
    epochRef.current = access.collaborationEpoch
    setCollaborationEpoch(access.collaborationEpoch)
    await current.adapter.focusCell(ref.anchor.sheetId, bounds.row, bounds.column)
    const sheet = current.adapter.workbook.getSheetBySheetId(ref.anchor.sheetId)
    if (!sheet) throw new Error('引用的工作表已删除。')
    sheet.setActiveRange(sheet.getRange(bounds.row, bounds.column, bounds.endRow - bounds.row + 1, bounds.endColumn - bounds.column + 1))
    updateFormulaBarRef.current()
    if (ai && hostWorkspace) {
      const sheetId = ref.anchor.sheetId
      const target = { kind: 'sheet' as const, sheetId, sheetIndex: current.client.sheets().findIndex(s => s.sheetId === sheetId),
        top: bounds.row, left: bounds.column, bottom: bounds.endRow, right: bounds.endColumn }
      if (!hostWorkspace.ask || epochRef.current === undefined || current.client.manifest.revision !== preview.revision) throw new Error('请刷新并重新选择要编辑的区域。')
      if ((target.bottom - target.top + 1) * (target.right - target.left + 1) > 128) throw new Error('AI 每次可编辑最多 128 个单元格。')
      setHostRange(target)
      hostWorkspace.ask({documentId: session.documentId, revision: preview.revision, collaborationEpoch: epochRef.current, target})
      return
    }
    if (ai) requestTask(`请编辑白板引用的 ${preview.label} 区域，保留其他内容。`, { sheetId: ref.anchor.sheetId, range: preview.range || ref.anchor.range, format: 'xlsx', cells: (preview.cells || ref.anchor.cells).map(cell => ({ nodeId: cell.nodeId })) }, {
      targetVersion: epochRef.current === undefined ? undefined : { revision: preview.revision, collaborationEpoch: epochRef.current },
    })
  })
  const selectedGridCell = runtime.current?.adapter.workbook.getActiveSheet().getActiveRange()
  const isPivotSelection = Boolean(activeSheetId && selectedGridCell && runtime.current?.adapter.isPivotCell(
    activeSheetId, selectedGridCell.getRow(), selectedGridCell.getColumn(),
  ))
  const formulaDisabled = revision === null || !editing || restoringInput || !!batchInput || locatingResource || isPivotSelection
  const fileHeader = <EditorHeader activeSheetName={exportSheetName} session={session} revision={revision} status={headerStatus} onClose={onClose} onSearch={() => setSearchOpen(true)} focused={focused} onFocus={() => setFocused(value => !value)} presence={layout.showCollaborators ? collaboration.avatars : null} />
  return <div data-document-scope={session.scope} className={`workspace semantic-workspace univer-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline && !focused ? '' : 'outline-hidden'} ${(!panelOpen && !settingsOpen && activeTab !== 'revisions') || focused ? 'right-hidden' : ''} ${focused ? 'focus-mode' : ''}`}>
    {themeCss && <style>{themeCss}</style>}
    {deletionPrompt && <div className="hcd-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) answerDeletion(false) }}>
      <div className="hcd-dialog" role="dialog" aria-modal="true" aria-label={localizeSource(locale, "确认删除")} onKeyDown={event => { if (event.key === 'Escape') answerDeletion(false) }}>
        <h2><LocalText source={"确认删除"} /></h2><p>{localizeDynamic(locale, deletionPrompt)}</p>
        <div className="hcd-dialog-actions"><button autoFocus onClick={() => answerDeletion(false)}><LocalText source={"取消"} /></button><button className="primary" onClick={() => answerDeletion(true)}><LocalText source={"删除"} /></button></div>
      </div>
    </div>}
    {!session.integratedToolbar && layout.showHeader && fileHeader}
    {session.integratedToolbar && focused && <button className="integrated-exit-focus" onClick={() => setFocused(false)}><LocalText source="退出专注模式" /></button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} refreshKey={revision} />
    {chartSheet && chartDialog && chartDialog.sheetId === activeSheetId && <WorksheetChartDialog
      request={chartDialog} snapshot={worksheetCharts.snapshot} error={worksheetCharts.error} editable={editing}
      selection={dataSelection?.sheetId === activeSheetId ? dataSelection : null}
      size={{ rows: chartSheet.getMaxRows(), columns: chartSheet.getMaxColumns() }}
      onClose={() => setChartDialog(null)} onSave={saveWorksheetChart} />}
    {conditionsSupported && conditionSheet && conditionSheet === activeSheetId && revision !== null && <WorksheetConditionDialog
      key={conditionSheet} rules={conditionRules ?? []} revision={revision} editable={editing}
      selection={dataSelection?.sheetId === conditionSheet ? dataSelection.address : formulaAddress}
      onClose={() => setConditionSheet(undefined)}
      onSave={(conditionId, config, baseRevision) => saveWorksheetFeature({
        op: 'xlsx.condition.set', sheetId: conditionSheet, conditionId, config,
      }, baseRevision)} />}
    {pivotsSupported && pivotDialog && runtime.current && revision !== null && <WorksheetPivotDialog
      session={session} revision={revision} activeSheet={pivotDialog.sheetId} selection={pivotDialog.selection}
      selected={pivotDialog.selected} editable={editing} close={() => setPivotDialog(undefined)}
      sheets={runtime.current.client.sheets()} entries={runtime.current.client.sheets().flatMap(sheet =>
        (runtime.current?.client.worksheetPivots(sheet.sheetId) ?? []).filter(pivot => !pivot.removed)
          .map(pivot => ({ sheetId: sheet.sheetId, pivot })))}
      save={(request, baseRevision) => saveWorksheetFeature({ op: 'xlsx.pivot.set', ...request }, baseRevision)} />}
    <div className="layout editor-layout">
      {!session.integratedToolbar && <DocumentPanelTools session={session} leftOpen={layout.showOutline && !focused} focused={focused} onExitFocus={() => setFocused(false)} onToggleLeft={() => { setFocused(false); setLayoutOption('showOutline', !layout.showOutline || focused) }} />}
      <WorkspaceDrawers leftOpen={layout.showOutline && !focused} rightOpen={!focused && (panelOpen || rightPanel !== null)} onCloseLeft={() => setLayoutOption('showOutline', false)} onCloseRight={() => { setPanelOpen(false); setSettingsOpen(false); if (activeTab === 'revisions') setActiveTab('home') }} />
      <LeftPanelShell session={session} hidden={!layout.showOutline || focused} label="工作表" onClose={() => setLayoutOption('showOutline', false)} onSearch={() => setSearchOpen(true)} onWorkspace={onClose} onSettings={openSettings}><div className="panel-head"><h2><LocalText source="工作表" /></h2></div><nav>{runtime.current?.client.sheets().filter(sheet => sheet.sheetState === 'visible').map(sheet => <button key={sheet.sheetId} onClick={() => { const workbook = runtime.current?.adapter.workbook; const target = workbook?.getSheetBySheetId(sheet.sheetId); if (target) workbook?.setActiveSheet(target) }}>{sheet.sheetName}</button>)}</nav></LeftPanelShell>
      <section className="content-shell" aria-label={localizeSource(locale, '文档内容')}>
        {!focused && <ContentToolbar fileMenu={session.integratedToolbar ? fileHeader : undefined} onSearch={() => setSearchOpen(true)} activeTab={activeTab} onTab={tab => { setActiveTab(tab); if (session.integratedToolbar && !layout.showToolbar) setLayoutOption('showToolbar', true); if (tab === 'revisions') setRightPanel('revisions') }} expanded={layout.showToolbar} onToggle={() => setLayoutOption('showToolbar', !layout.showToolbar)} readOnly={!editing} format="xlsx" />}
    {layout.showToolbar && (editing || activeTab === 'data' || conditionsSupported && activeTab === 'format' || pivotsSupported && activeTab === 'insert' || session.integratedToolbar && activeTab === 'view') && !focused && <nav className="toolbar ribbon" aria-label={localizeSource(locale, "工作簿工具栏")}>
      {pivotsSupported && (activeTab === 'data' || activeTab === 'insert') && <div className="tool-group">
        <button type="button" disabled={!activeSheetId || revision === null} onClick={openPivot}><LocalText source="数据透视表" /></button>
      </div>}
      {conditionsSupported && activeTab === 'format' && <div className="tool-group">
        <button type="button" disabled={!activeSheetId || !conditionRules} onClick={() => setConditionSheet(activeSheetId)}>
          <LocalText source="条件格式" />
        </button>
      </div>}
      {activeTab === 'home' && <><div className="tool-group" onMouseDown={event => { if (runtime.current?.adapter.workbook.isCellEditing() && (event.target as Element).closest('button')) event.preventDefault() }}><button title={localizeSource(locale, "撤销上一步（⌘/Ctrl+Z）")} disabled={!editing || historyLocked || !history.past.length} onClick={() => void travelHistory('undo')}><LocalText source={"↶ 撤销"} /></button><button title={localizeSource(locale, "重做（⌘/Ctrl+Shift+Z 或 Ctrl+Y）")} disabled={!editing || historyLocked || !history.future.length} onClick={() => void travelHistory('redo')}><LocalText source={"↷ 重做"} /></button><button className={selectedCellLink()?.bold ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={!!selectedCellLink()?.bold} onClick={() => void saveCellFormat({ bold: !selectedCellLink()?.bold })}><LocalText source={"加粗"} /></button><button className={selectedCellLink()?.italic ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={!!selectedCellLink()?.italic} onClick={() => void saveCellFormat({ italic: !selectedCellLink()?.italic })}><LocalText source={"斜体"} /></button><button className={selectedCellLink()?.underline ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={!!selectedCellLink()?.underline} onClick={() => void saveCellFormat({ underline: !selectedCellLink()?.underline })}><LocalText source={"下划线"} /></button><label><LocalText source={"字号"} /><input aria-label={localizeSource(locale, "字号")} type="number" min="1" max="409" step="0.5" value={cellFontSize} disabled={!editing || formatBusy} onChange={event => setCellFontSize(event.target.value)} style={{ width: 68 }} /></label><button disabled={!editing || formatBusy || !Number.isFinite(Number(cellFontSize)) || Number(cellFontSize) < 1 || Number(cellFontSize) > 409} onClick={() => void saveCellFormat({ fontSizePt: Number(cellFontSize) })}><LocalText source={"应用字号"} /></button><label><LocalText source={"颜色"} /><input aria-label={localizeSource(locale, "文字颜色")} type="color" value={cellFontColor} disabled={!editing || formatBusy} onChange={event => setCellFontColor(event.target.value)} /></label><button disabled={!editing || formatBusy} onClick={() => void saveCellFormat({ color: cellFontColor })}><LocalText source={"应用颜色"} /></button></div></>}
      {activeTab === 'format' && <><div className="tool-group"><label><LocalText source={"填充"} /><input aria-label={localizeSource(locale, "填充")} type="color" value={cellFillColor} disabled={!editing || formatBusy} onChange={event => setCellFillColor(event.target.value)} /></label><button disabled={!editing || formatBusy} onClick={() => void saveCellFormat({ fill: cellFillColor })}><LocalText source={"应用填充"} /></button><button className={selectedCellLink()?.horizontal === 'left' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.horizontal === 'left'} onClick={() => void saveCellLayout({ horizontal: 'left' })}><LocalText source={"左对齐"} /></button><button className={selectedCellLink()?.horizontal === 'center' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.horizontal === 'center'} onClick={() => void saveCellLayout({ horizontal: 'center' })}><LocalText source={"居中"} /></button><button className={selectedCellLink()?.horizontal === 'right' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.horizontal === 'right'} onClick={() => void saveCellLayout({ horizontal: 'right' })}><LocalText source={"右对齐"} /></button><button className={selectedCellLink()?.vertical === 'top' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.vertical === 'top'} onClick={() => void saveCellLayout({ vertical: 'top' })}><LocalText source={"顶端对齐"} /></button><button className={selectedCellLink()?.vertical === 'center' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.vertical === 'center'} onClick={() => void saveCellLayout({ vertical: 'center' })}><LocalText source={"垂直居中"} /></button><button className={selectedCellLink()?.vertical === 'bottom' ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={selectedCellLink()?.vertical === 'bottom'} onClick={() => void saveCellLayout({ vertical: 'bottom' })}><LocalText source={"底端对齐"} /></button><button className={selectedCellLink()?.wrap ? 'primary' : ''} disabled={!editing || formatBusy} aria-pressed={!!selectedCellLink()?.wrap} onClick={() => void saveCellLayout({ wrap: !selectedCellLink()?.wrap })}><LocalText source={"自动换行"} /></button><button disabled={!editing || formatBusy} onClick={() => void saveCellLayout({ border: 'thin' })}><LocalText source={"所有框线"} /></button><button disabled={!editing || formatBusy} onClick={() => void saveCellLayout({ border: 'none' })}><LocalText source={"无框线"} /></button><label><LocalText source={"数字格式 "} /><select aria-label={localizeSource(locale, "数字格式")} value={cellNumberFormat} disabled={!editing || formatBusy} onChange={event => setCellNumberFormat(event.target.value)}><option value="General">{localizeSource(locale, "常规")}</option><option value="0.00">{localizeSource(locale, "数值")}</option><option value="#,##0.00">{localizeSource(locale, "会计数值")}</option><option value="0%">{localizeSource(locale, "百分比")}</option><option value="0.00E+00">{localizeSource(locale, "科学计数")}</option><option value="yyyy-mm-dd">{localizeSource(locale, "日期")}</option><option value="@">{localizeSource(locale, "文本")}</option></select></label><label><LocalText source={"格式代码 "} /><input aria-label={localizeSource(locale, "格式代码")} value={cellNumberFormat} disabled={!editing || formatBusy} maxLength={1024} onChange={event => setCellNumberFormat(event.target.value)} /></label><button disabled={!editing || formatBusy} onClick={() => void saveCellNumberFormat(cellNumberFormat)}><LocalText source={"应用数字格式"} /></button></div></>}
      {activeTab === 'sheet' && <><div className="tool-group"><label><LocalText source={"工作表名 "} /><input aria-label={localizeSource(locale, "工作表名")} value={sheetNameDraft} disabled={!editing || renameBusy} maxLength={31} onFocus={() => setSheetNameDraft(previous => previous || activeSheetName())} onChange={event => setSheetNameDraft(event.target.value)} style={{ width: 120 }} /></label><button title={localizeSource(locale, "重命名当前工作表，公式与内部链接会跟随新名称")} disabled={!editing || renameBusy || addBusy || formatBusy || !sheetNameDraft.trim()} onClick={() => void renameActiveSheet(sheetNameDraft)}><LocalText source={"重命名工作表"} /></button><label><LocalText source={"新增工作表名 "} /><input aria-label={localizeSource(locale, "新增工作表名")} value={sheetAddDraft} disabled={!editing || addBusy} maxLength={31} onChange={event => setSheetAddDraft(event.target.value)} style={{ width: 120 }} /></label><button title={localizeSource(locale, "在工作簿末尾新增一个空白工作表")} disabled={!editing || addBusy || renameBusy || formatBusy || !sheetAddDraft.trim()} onClick={() => void addWorksheet(sheetAddDraft)}><LocalText source={"新增工作表"} /></button><button title={localizeSource(locale, "删除当前工作表，它的单元格一并删除，引用它的公式变为 #REF!")} disabled={!editing || deleteBusy || addBusy || renameBusy || formatBusy} onClick={() => void deleteActiveSheet()}><LocalText source={"删除工作表"} /></button><button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void mergeSelection()}><LocalText source={"合并单元格"} /></button><button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void unmergeSelection()}><LocalText source={"拆分单元格"} /></button><label><LocalText source={"列宽 "} /><input aria-label={localizeSource(locale, "选中列宽度")} type="number" min="1" max="255" step="0.5" value={columnWidthChars} disabled={!editing} onChange={event => setColumnWidthChars(event.target.value)} style={{ width: 68 }} /></label><button disabled={!editing || columnWidthBusy} onClick={() => void setSelectedColumnWidth()}><LocalText source={"设置列宽"} /></button><label><LocalText source={"行高 "} /><input aria-label={localizeSource(locale, "选中行高度")} type="number" min="1" max="409" step="0.5" value={rowHeightPoints} disabled={!editing} onChange={event => setRowHeightPoints(event.target.value)} style={{ width: 68 }} /></label><button disabled={!editing || rowHeightBusy} onClick={() => void setSelectedRowHeight()}><LocalText source={"设置行高"} /></button><button title={localizeSource(locale, "冻结当前工作表的第一行，已经冻结的列保持不变")} className={currentFreeze().rows > 0 ? 'primary' : ''} aria-pressed={currentFreeze().rows > 0} disabled={!editing || freezeBusy || formatBusy || renameBusy || addBusy || deleteBusy} onClick={() => void freezeActiveSheet(1, currentFreeze().columns)}><LocalText source={"冻结首行"} /></button><button title={localizeSource(locale, "冻结当前工作表的第一列，已经冻结的行保持不变")} className={currentFreeze().columns > 0 ? 'primary' : ''} aria-pressed={currentFreeze().columns > 0} disabled={!editing || freezeBusy || formatBusy || renameBusy || addBusy || deleteBusy} onClick={() => void freezeActiveSheet(currentFreeze().rows, 1)}><LocalText source={"冻结首列"} /></button><button title={localizeSource(locale, "在选中单元格的上方和左侧冻结窗格")} disabled={!editing || freezeBusy || formatBusy || renameBusy || addBusy || deleteBusy} onClick={freezeAtSelection}><LocalText source={"冻结窗格"} /></button><button title={localizeSource(locale, "取消当前工作表的冻结窗格")} disabled={!editing || freezeBusy || formatBusy || renameBusy || addBusy || deleteBusy || !currentFreeze().rows && !currentFreeze().columns} onClick={() => void freezeActiveSheet(0, 0)}><LocalText source={"取消冻结"} /></button></div><span className="ribbon-note"><LocalText source={"双击单元格或按 F2 编辑 · 右键显示操作菜单 · "} />{localizeDynamic(locale, status)}</span></>}
      {activeTab === 'insert' && <><div className="tool-group">
        {chartsSupported && <button disabled={!activeSheetId} onClick={() => activeSheetId && setChartDialog({
          sheetId: activeSheetId, newChart: editing && !!worksheetCharts.snapshot && !worksheetCharts.snapshot.charts.length,
        })}><LocalText source="图表" /></button>}
        {hostWorkspace && <button disabled={!dataSelection} onClick={() => dataSelection && hostWorkspace.chooseBoard({sourceId: session.documentId,
          sheetId: dataSelection.sheetId, range: dataSelection.address})}>引用区域到白板</button>}
        {gridSelectionKind !== 'column' && gridSelectionKind !== 'all' && <>
          <label className="xlsx-insert-count"><LocalText source={"插入行数 "} /><input aria-label={localizeSource(locale, "插入行数")} type="number" min="1" max="100" step="1" value={rowInsertCount} disabled={!editing || rowBusy} onChange={event => { setRowInsertCount(event.target.value); if (error.includes('插入行数必须')) setError('') }} /></label>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void insertRowNearSelection('above')}><LocalText source={"在选中行前插入 "} />{rowInsertCount || '…'} <LocalText source={" 行"} /></button>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void insertRowNearSelection('below')}><LocalText source={"在选中行后插入 "} />{rowInsertCount || '…'} <LocalText source={" 行"} /></button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void deleteSelectedRow()}><LocalText source={"删除选中行"} /></button>
          <button disabled={!editing || rowBusy || columnBusy || !validRowInsertCount} onClick={() => void appendRow()}><LocalText source={"在末尾新增 "} />{rowInsertCount || '…'} <LocalText source={" 行"} /></button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void removeEmptyTailRow()}><LocalText source={"撤销末尾空行"} /></button>
        </>}
        {gridSelectionKind !== 'row' && gridSelectionKind !== 'all' && <>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void insertColumnNearSelection('left')}><LocalText source={"在选中列左侧插入"} /></button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void insertColumnNearSelection('right')}><LocalText source={"在选中列右侧插入"} /></button>
          <button disabled={!editing || rowBusy || columnBusy} onClick={() => void deleteSelectedColumn()}><LocalText source={"删除选中列"} /></button>
        </>}
        {gridSelectionKind === 'cell' && <button disabled={!editing || mergeBusy || rowBusy || columnBusy} onClick={() => void mergeSelection()}><LocalText source={"合并选中单元格"} /></button>}
      </div><span className="ribbon-note"><LocalText source={"整行只显示行操作，整列只显示列操作；普通单元格可选择两种操作 · "} />{localizeDynamic(locale, status)}</span></>}
      {activeTab === 'data' && <GridDataTools key={savedFilter ? JSON.stringify([savedFilter.selection.sheetId, savedFilter.view.filter]) : 'grid-data'}
        selection={savedFilter?.selection ?? gridFilter?.selection ?? dataSelection} busy={historyLocked || loadingSavedFilter} editing={editing}
        filter={savedFilter ? { matched: savedFilter.view.total - savedFilter.view.hiddenRows.length, total: savedFilter.view.total } : gridFilter}
        savedFilter={savedFilter?.view.filter} canSaveFilter={session.format === 'xlsx' && editing && session.scope === 'write'}
        onSort={(column, header, direction) => void sortSelection(column, header, direction)} onSaveFilter={saveSelectedFilter}
        onFilter={(criteria, header) => void filterSelection(criteria, header)} onClearFilter={clearGridFilter} />}
      {activeTab === 'view' && <>{session.integratedToolbar && <label className="mode"><input className="left-sidebar-toggle" type="checkbox" checked={layout.showOutline} onChange={e=>setLayoutOption('showOutline', e.target.checked)}/><LocalText source="工作表导航" /></label>}<button className="right-sidebar-toggle" aria-pressed={settingsOpen} onClick={() => settingsOpen ? setSettingsOpen(false) : openSettings()}><LocalText source={"界面设置"} /></button></>}
      {activeTab === 'revisions' && <><div className="tool-group"><button disabled={!editing || historyLocked || !history.past.length} onClick={() => void travelHistory('undo')}><LocalText source={"撤销 "} />{history.past.length} <LocalText source={" 步"} /></button><button disabled={!editing || historyLocked || !history.future.length} onClick={() => void travelHistory('redo')}><LocalText source={"重做 "} />{history.future.length} <LocalText source={" 步"} /></button></div><span className="ribbon-note"><LocalText source={"当前修订 r"} />{revision ?? '…'} · {localizeDynamic(locale, history.past.length ? `下一步可撤销：${history.past.at(-1)?.label}` : '当前会话无可撤销步骤')} <LocalText source={" · 协作者更新后将清空本地步骤"} /></span></>}
    </nav>}
    {!focused && <form className="xlsx-formula-bar" aria-label={localizeSource(locale, "公式栏")} onSubmit={event => { event.preventDefault(); applyFormulaBarInput() }}>
      <span className="xlsx-formula-address" aria-label={localizeSource(locale, "选中单元格")}>{formulaAddress}</span>
      {pivotsSupported && isPivotSelection && <button type="button" onClick={openPivot}>
        <LocalText source="配置透视表" />
      </button>}
      <label htmlFor={`xlsx-formula-expression-${session.documentId}`}>ƒx</label>
      <input id={`xlsx-formula-expression-${session.documentId}`} ref={formulaInput} aria-label={localizeSource(locale, "单元格内容或公式")} value={formulaText}
        disabled={formulaDisabled} maxLength={100_000} placeholder={localizeSource(locale, "输入文字、数字或 =SUM(A1:A10)")}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancelGridInput() } }}
        onChange={event => changeFormulaInput(event.target.value)} />
      {(formulaCalculation || formulaDirty && formulaText.startsWith('=')) && <output className="xlsx-calculation-status" aria-label={localizeSource(locale, "计算校验")}
        data-calculation-status={formulaDirty ? 'pending' : formulaCalculation?.status}
        title={formulaCalculation?.error === 'literal_type_metadata_missing'
          ? localizeSource(locale, '此工作簿由旧版导入，请重新导入原始 XLSX 后核验计算')
          : formulaCalculation?.error || ''}>
        {formulaDirty ? <LocalText source="保存后核算" /> : formulaCalculation?.status === 'calculated'
          ? <><LocalText source="已核验" /> · {formulaCalculation.value}</> : <LocalText source="计算暂不可用" />}
      </output>}
      <select aria-label={localizeSource(locale, "插入常用函数")} disabled={formulaDisabled} value="" onChange={event => {
        if (!event.target.value) return
        changeFormulaInput(`=${event.target.value}(`)
        formulaInput.current?.focus()
      }}>
        <option value=""><LocalText source={"常用函数"} /></option>
        {verifiedFunctions.map(name => name.replace('RANK_', 'RANK.')).map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <button type="submit" disabled={formulaDisabled}><LocalText source={"应用内容"} /></button>
      {formulaDirty && <><output className="xlsx-draft-target" aria-label="未应用输入位置" title={`${localizeSource(locale, '未应用输入')} · ${draftTargetLabel}`}>{draftTargetLabel}</output><button className="xlsx-input-cancel" type="button" aria-label={localizeSource(locale, '取消输入')} onClick={cancelGridInput}><LocalText source="取消输入" /></button></>}
    </form>}
    <InputDraftRecovery protection={inputProtection} disabled={!editing || restoringInput || formulaDirty || !!batchInput || !runtime.current || !!runtime.current?.adapter.hasPendingPatch()} onRestore={restoreGridInput} onError={setError} />
    {batchInput && batchReview && <details open className="epoch-draft-conflict" aria-label="待保存的单元格修改">
      <summary>{batchBusy ? '正在保存单元格修改' : '有一批单元格修改待核对'} · {batchInput.changes.length} 个单元格</summary>
      <p>修改已保留。核对后提交会先检查服务端回执；已保存的修改不会再次提交。</p>
      <textarea aria-label="待保存的单元格修改内容" readOnly value={batchInput.text} />
      <button disabled={!editing || batchBusy || restoringInput || inputProtection.status !== 'protected'} onClick={() => void commitBatchRef.current(batchInput, true)}>核对并提交</button>
      <button onClick={downloadGridBatch}>下载本地草稿</button>
      <button disabled={batchBusy || restoringInput} onClick={() => void discardGridBatch()}>舍弃本地修改</button>
    </details>}
    <CanvasViewport native className="univer-editor-area" onContextMenu={openGridContextMenu} onMouseDownCapture={() => setContextMenu(null)} onWheelCapture={() => setContextMenu(null)}><div ref={host} inert={locatingResource} className={`hcd-univer-host${appearanceTheme === 'dark' ? ' univer-dark' : ''}`}
      onMouseDownCapture={event => { mouseClickCount.current = event.detail }}
      onPointerUpCapture={event => { mousePointerUp.current = event.pointerType === 'mouse' && mouseClickCount.current < 2 }}
      onPointerUp={() => { mousePointerUp.current = false }}
      onPointerDownCapture={() => { mousePointerUp.current = false }}
      onPointerCancel={() => { mousePointerUp.current = false }} /></CanvasViewport>
    <GridAgentOverlay session={session} host={host} runtime={runtime} revision={revision} />
    <WorksheetChartLayer snapshot={worksheetCharts.preview} adapter={runtime} editable={editing}
      onEdit={chart => activeSheetId && setChartDialog({ sheetId: activeSheetId, chartId: chart.id })} />
      </section>
      <AgentPanel targetLabel={target => {
        const address = target.nodeId ? runtime.current?.adapter.nodeAddress(target.nodeId) : target.sheetId && target.row && target.column ? {row:target.row-1,column:target.column-1} : undefined
        let col='', n=(address?.column ?? -1)+1
        while(n>0) {col=String.fromCharCode(65+(n-1)%26)+col;n=Math.floor((n-1)/26)}
        return `${address ? `${col}${address.row+1} · ` : ''}${localizeSource(locale,target.label || '内容区域')}`
      }} beforeRun={async () => {
        if (formulaDirty || gridBatch.current || runtime.current?.adapter.workbook.isCellEditing() || runtime.current?.adapter.hasPendingPatch() || historyLocked || gridBusy.current) throw new Error('请先确认单元格或公式编辑，并等待保存完成。')
      }} onLocate={async agent => {
        const current = runtime.current
        if (!current) return false
        if (!agent.nodeId && agent.sheetId && agent.row && agent.column) {
          const sheet=current.adapter.workbook.getSheetBySheetId(agent.sheetId)
          if(!sheet) return false
          await current.adapter.scrollCell(agent.sheetId, Math.max(0,agent.row-5),Math.max(0,agent.column-3))
          return true
        }
        if (!agent.nodeId) return false
        const descriptor = current.client.descriptors.find(item => item.sequence === agent.chunkSequence)
        if (descriptor?.grid?.sheetId && descriptor.grid.rowStart !== undefined && descriptor.grid.rowEnd !== undefined) await current.adapter.loadRange(descriptor.grid.sheetId, descriptor.grid.rowStart - 1, descriptor.grid.rowEnd - 1)
        const address = current.adapter.nodeAddress(agent.nodeId)
        if (!address) return false
        const sheet = current.adapter.workbook.getSheetBySheetId(address.sheetId)
        if (!sheet) return false
        // Follow the Agent with the viewport; retain the person's active cell.
        // Leave context above the target when frozen rows occupy the top.
        await current.adapter.scrollCell(address.sheetId, Math.max(0,address.row-4),Math.max(0,address.column-2))
        return true
      }} />

      {settingsOpen && !panelOpen && !focused && <WorkspacePanel side="right" className="workspace-sidebar" aria-label={localizeSource(locale, "界面设置")}><section className="appearance-panel"><div className="panel-head"><h2><LocalText source={"界面设置"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setSettingsOpen(false)}><CollapseSidebarIcon /></button></div><LocaleSelect /><AppearanceSelect />{!session.integratedToolbar && <label><LocalText source={"显示顶部栏"} /><input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label>}<label><LocalText source={"显示操作栏"} /><input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label><LocalText source={"显示协作者"} /><input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><fieldset><legend><LocalText source={"头部布局"} /></legend><label><input type="radio" name="xlsx-header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} /><LocalText source={"紧凑"} /></label><label><input type="radio" name="xlsx-header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} /><LocalText source={"标准"} /></label></fieldset></section></WorkspacePanel>}
      {rightPanel === 'revisions' && !panelOpen && !focused && <WorkspacePanel side="right" className="workspace-sidebar xlsx-history-sidebar" aria-label={localizeSource(locale, "编辑步骤")}><div className="panel-head"><h2><LocalText source={"编辑步骤"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "关闭编辑步骤")} onClick={() => setRightPanel(null)}><CollapseSidebarIcon /></button></div><p><LocalText source={"本次打开期间保存的操作。每次撤销和重做都会生成新的 HCD 修订。"} /></p>
        {history.past.length ? <ol className="xlsx-edit-steps">{history.past.map((step, index) => <li key={`${index}-${step.revision}`}><span>{index + 1}</span><strong>{localizeDynamic(locale, step.label)}</strong><small><LocalText source={"保存前 r"} />{step.revision}</small></li>).reverse()}</ol> : <p><LocalText source={"暂无可撤销步骤"} /></p>}
        {history.future.length > 0 && <><h3><LocalText source={"可重做"} /></h3><ol className="xlsx-edit-steps">{history.future.slice().reverse().map((step, index) => <li key={`${index}-${step.revision}`}><span>↷</span><strong>{localizeDynamic(locale, step.label)}</strong></li>)}</ol></>}
      </WorkspacePanel>}
    </div>
    {contextMenu && <ContextMenu title="单元格与选区" x={contextMenu.x} y={contextMenu.y} actions={contextActions}
      count={showRowContext ? { label: '插入行数', value: rowInsertCount, onChange: value => { setRowInsertCount(value); if (error.includes('插入行数必须')) setError('') } } : undefined}
      onClose={() => setContextMenu(null)} />}
    <EditorStatusbar mode={localizeSource(locale, "工作簿视图")} format={session.format} revision={revision} readOnly={!editing} status={editing ? headerStatus : '已同步'} draftProtection={session.scope === 'write' ? inputProtection.status : undefined} />
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
  </div>
}
