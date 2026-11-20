import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChartNoAxesColumnIncreasing, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { HcdUniverAdapter } from '../../xlsx-univer-viewer/src/adapter.ts'
import type { WorksheetChartConfig } from '../../xlsx-univer-viewer/src/hcd.ts'
import { api, type Session } from './api.ts'
import type { GridDataSelection } from './GridDataTools.tsx'
import { columnName, formatRange, parseRange } from './resources/resourceReference.ts'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { useI18n } from './i18n.tsx'
import './worksheet-charts.css'

export type WorksheetChart = {
  id: string
  config: WorksheetChartConfig
  sourceMissing: boolean
  data: { unavailable: number; categories: string[]; series: { name: string; values: (number | null)[] }[] } | null
  svg: string
}
type ChartSnapshot = { sheetId: string; revision: number; charts: WorksheetChart[]; calculationLimited: boolean }
type ChartRequest = { chartId?: string; newChart?: boolean }
type Size = { rows: number; columns: number }

const chartTypes = { column: '柱状图', bar: '条形图', line: '折线图', pie: '饼图' } as const

export function useWorksheetCharts(session: Session, sheetId: string | undefined, revision: number | null, supported: boolean) {
  const [result, setResult] = useState<ChartSnapshot>()
  const [failure, setFailure] = useState<{ sheetId: string; revision: number; message: string }>()
  useEffect(() => {
    if (!supported || !sheetId || revision === null) return
    const pending = new AbortController()
    void api(session, `/sheet-charts/${encodeURIComponent(sheetId)}`, { signal: pending.signal })
      .then(response => response.json() as Promise<Omit<ChartSnapshot, 'sheetId'>>)
      .then(value => {
        if (!pending.signal.aborted && value.revision === revision) {
          setResult({ ...value, sheetId })
          setFailure(undefined)
        }
      }).catch(error => {
        if (!pending.signal.aborted) setFailure({ sheetId, revision, message: String(error) })
      })
    return () => pending.abort()
  }, [session, sheetId, revision, supported])
  return {
    preview: result?.sheetId === sheetId ? result : undefined,
    snapshot: result?.sheetId === sheetId && result?.revision === revision ? result : undefined,
    error: failure?.sheetId === sheetId && failure?.revision === revision ? failure?.message : undefined,
  }
}

function imageSource(svg: string) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function WorksheetChartLayer({ snapshot, adapter, editable, onEdit }: {
  snapshot?: ChartSnapshot
  adapter: RefObject<{ adapter: HcdUniverAdapter } | null>
  editable: boolean
  onEdit: (chart: WorksheetChart) => void
}) {
  return snapshot?.charts.map(chart => <ChartPreview key={chart.id} chart={chart} adapter={adapter}
    sheetId={snapshot.sheetId} editable={editable} onEdit={onEdit} />)
}

function ChartPreview({ chart, sheetId, adapter, editable, onEdit }: {
  chart: WorksheetChart
  sheetId: string
  adapter: RefObject<{ adapter: HcdUniverAdapter } | null>
  editable: boolean
  onEdit: (chart: WorksheetChart) => void
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const { anchorRow, anchorColumn, title } = chart.config
  useLayoutEffect(() => {
    const sheet = adapter.current?.adapter.workbook.getActiveSheet()
    if (!sheet || sheetId !== sheet.getSheetId()) return
    // The floating view follows the grid without mutating workbook drawings.
    const layer = sheet.addFloatDomToRange(sheet.getRange(anchorRow - 1, anchorColumn - 1), {
      allowTransform: false,
      componentKey: () => <div ref={setTarget} className="worksheet-chart-anchor" />,
    }, { width: 480, height: 280 })
    return () => { layer?.dispose() }
  }, [sheetId, anchorRow, anchorColumn, adapter])
  return target ? createPortal(<div className="worksheet-chart-preview" data-chart-id={chart.id}
    onDoubleClick={editable ? event => { event.stopPropagation(); onEdit(chart) } : undefined}>
    <img src={imageSource(chart.svg)} alt={title} draggable={false} />
  </div>, target) : null
}

type ChartDraft = { id: string; title: string; kind: WorksheetChartConfig['kind']; range: string; anchor: string }

function newChart(selection: GridDataSelection | null, size: Size): ChartDraft {
  const outside = selection && selection.endColumn + 2 <= size.columns
  const row = selection ? outside ? selection.startRow : Math.min(size.rows, selection.endRow + 2) : 1
  const column = selection && outside ? selection.endColumn + 1 : 0
  return {
    id: crypto.randomUUID().replaceAll('-', ''), title: '', kind: 'column',
    range: selection?.address ?? '', anchor: `${columnName(column)}${row}`,
  }
}

function editChart({ id, config: { kind, title, range, anchorColumn, anchorRow } }: WorksheetChart): ChartDraft {
  const { startRow, startColumn, endRow, endColumn } = range
  return { id, kind, title, range: formatRange({
    row: startRow - 1, column: startColumn - 1, endRow: endRow - 1, endColumn: endColumn - 1,
  }), anchor: `${columnName(anchorColumn - 1)}${anchorRow}` }
}

export function WorksheetChartDialog({ request, snapshot, selection, size, editable, error, onClose, onSave }: {
  request: ChartRequest
  snapshot?: ChartSnapshot
  selection: GridDataSelection | null
  size: Size
  editable: boolean
  error?: string
  onClose: () => void
  onSave: (chartId: string, config: WorksheetChartConfig | null) => Promise<void>
}) {
  const { locale } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState<ChartDraft | null>(() => {
    const chart = snapshot?.charts.find(item => item.id === request.chartId)
    return chart ? editChart(chart) : request.newChart ? newChart(selection, size) : null
  })
  const current = snapshot?.charts.find(chart => chart.id === draft?.id)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [draftRevision, setDraftRevision] = useState(snapshot?.revision)
  useEffect(() => { dialog.current?.showModal() }, [])

  function patchDraft(change: Partial<ChartDraft>) {
    if (draft) setDraft({ ...draft, ...change })
  }

  async function save(event: FormEvent, remove = false) {
    event.preventDefault()
    if (!snapshot || !draft || !editable || busy) return
    setFailure('')
    try {
      if (snapshot.revision !== draftRevision) throw new Error('图表所在的工作簿已更新，请重新选择图表后编辑。')
      let config: WorksheetChartConfig | null = null
      if (!remove) {
        const { row, column, endRow, endColumn } = parseRange(draft.range, 201 * 9)
        const series = endColumn - column
        if (endRow <= row || endRow - row > 200 || series < 1 || series > 8 || draft.kind === 'pie' && series !== 1) {
          throw new Error('请选择包含表头、分类列和数据的区域。最多 200 行数据和 8 个系列，饼图只支持一个系列。')
        }
        const anchor = parseRange(draft.anchor, 1)
        if (anchor.row >= size.rows || anchor.column >= size.columns) throw new Error('请选择工作表显示范围内的放置单元格。')
        config = { kind: draft.kind, title: draft.title.trim(),
          range: { startRow: row + 1, startColumn: column + 1, endRow: endRow + 1, endColumn: endColumn + 1 },
          anchorRow: anchor.row + 1, anchorColumn: anchor.column + 1 }
        if (!config.title) throw new Error('请输入图表标题。')
      }
      setBusy(true)
      await onSave(draft.id, config)
      onClose()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <dialog ref={dialog} className="hcd-dialog worksheet-chart-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><h2 id={titleId}><LocalText source="工作表图表" /></h2>
      <button type="button" className="icon-btn" aria-label={localizeSource(locale, '关闭')} onClick={onClose} disabled={busy}><X size={18} /></button>
    </header>
    {!!snapshot?.charts.length && <div className="worksheet-chart-list" aria-label={localizeSource(locale, '工作表图表')}>
      {snapshot.charts.map(chart => <button type="button" key={chart.id} aria-pressed={chart.id === draft?.id}
        disabled={busy} onClick={() => { setDraft(editChart(chart)); setDraftRevision(snapshot.revision); setFailure('') }}>
        <ChartNoAxesColumnIncreasing size={16} /><span>{chart.config.title}</span><Pencil size={14} />
      </button>)}
    </div>}
    {error && <p role="alert">{error}</p>}
    {snapshot?.calculationLimited && <p role="status"><LocalText source="工作簿超过当前计算容量，导出的图表仍引用源单元格。" /></p>}
    {current && <div className="worksheet-chart-sample">
      <img src={imageSource(current.svg)} alt={current.config.title} />
      {current.sourceMissing && <p role="status"><LocalText source="原数据范围已改变，请重新选择范围。" /></p>}
      {!!current.data?.unavailable && <p role="status"><LocalText source="部分单元格没有可核算的数字，图表保留空缺。" /></p>}
    </div>}
    {draft ? <form onSubmit={save}>
      <div className="worksheet-chart-fields">
        <label className="worksheet-chart-name"><LocalText source="图表标题" /><input required maxLength={100} value={draft.title}
          disabled={busy || !editable} onChange={event => patchDraft({ title: event.target.value })} /></label>
        <label><LocalText source="图表类型" /><select aria-label={localizeSource(locale, '图表类型')} value={draft.kind} disabled={busy || !editable}
          onChange={event => patchDraft({ kind: event.target.value as WorksheetChartConfig['kind'] })}>
          {Object.entries(chartTypes).map(([value, label]) => <option key={value} value={value}>{localizeSource(locale, label)}</option>)}
        </select></label>
        <label><LocalText source="数据范围" /><input required placeholder="A1:C8" value={draft.range}
          disabled={busy || !editable} onChange={event => patchDraft({ range: event.target.value })} /></label>
        <label><LocalText source="放置位置" /><input required placeholder="E1" value={draft.anchor}
          disabled={busy || !editable} onChange={event => patchDraft({ anchor: event.target.value })} /></label>
      </div>
      {editable && <p className="worksheet-chart-help"><LocalText source="首行为系列名称，首列为分类。" /></p>}
      {failure && <p role="alert">{failure}</p>}
      {editable && <footer className="hcd-dialog-actions">
        {current && <button type="button" className="worksheet-chart-remove" disabled={busy || !snapshot} onClick={event => void save(event, true)}>
          <Trash2 size={15} /><LocalText source="移除图表" /></button>}
        <button type="button" disabled={busy} onClick={onClose}><LocalText source="取消" /></button>
        <button className="primary" type="submit" disabled={busy || !snapshot}><LocalText source={busy ? '保存中…' : current ? '保存图表' : '插入图表'} /></button>
      </footer>}
    </form> : null}
    {editable && (current || !draft) && <button type="button" className="worksheet-chart-add" disabled={busy || !snapshot}
      onClick={() => { setDraft(newChart(selection, size)); setDraftRevision(snapshot?.revision); setFailure('') }}><Plus size={16} /><LocalText source="新建图表" /></button>}
    {!draft && !snapshot && !error && <p role="status"><LocalText source="正在读取图表…" /></p>}
  </dialog>
}
