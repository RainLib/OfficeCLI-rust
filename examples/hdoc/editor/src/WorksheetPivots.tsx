import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { GripVertical, Plus, RefreshCw, TableProperties, Trash2, X } from 'lucide-react'
import type {
  PivotAggregate, PivotCell, PivotMeasure, PivotReport, WorksheetPivot, WorksheetPivotConfig,
} from '../../xlsx-univer-viewer/src/hcd.ts'
import { api, type Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { columnName, formatRange, parseRange } from './resources/resourceReference.ts'
import './worksheet-pivots.css'

type SheetChoice = { sheetId: string; sheetName: string }
export type PivotEntry = { sheetId: string; pivot: WorksheetPivot }
type PivotDraft = Omit<WorksheetPivotConfig, 'sourceRange' | 'anchorRow' | 'anchorColumn'> & {
  id: string; sheetId: string; sourceRef: string; destination: string
}
type Area = 'rows' | 'columns' | 'values'
type FieldDrag = { field: number; from?: Area; index?: number }
type Preview = { fields: string[]; report: PivotReport }
type DraftRequest = { id: string; sheetId: string; config: WorksheetPivotConfig }

const layoutAreas: Record<Area, { title: string; add: string }> = {
  rows: { title: '行', add: '添加行字段' },
  columns: { title: '列', add: '添加列字段' },
  values: { title: '值', add: '添加汇总字段' },
}
const operations: Record<PivotAggregate, string> = {
  sum: '求和', count: '计数', average: '平均值', min: '最小值', max: '最大值',
}
const dragFormat = 'application/x-fold-pivot-field'

function rangeText(range: WorksheetPivotConfig['sourceRange']): string {
  return formatRange({ row: range.startRow - 1, column: range.startColumn - 1,
    endRow: range.endRow - 1, endColumn: range.endColumn - 1 })
}

function makeDraft(entry: PivotEntry | undefined, sheet: string, selection: string, name: string): PivotDraft {
  if (entry) {
    const { pivot } = entry
    return { ...pivot.config, id: pivot.id, sheetId: entry.sheetId, sourceRef: rangeText(pivot.config.sourceRange),
      destination: columnName(pivot.config.anchorColumn - 1) + pivot.config.anchorRow }
  }
  let destination = 'E1'
  try {
    const area = parseRange(selection, 20_000)
    destination = area.endColumn < 16_381
      ? columnName(area.endColumn + 2) + (area.row + 1)
      : columnName(area.column) + Math.min(1_048_576, area.endRow + 3)
  } catch { /* source range is editable */ }
  return { id: crypto.randomUUID().replaceAll('-', ''), sheetId: sheet, sourceSheetId: sheet,
    name, sourceRef: selection, destination, rows: [], columns: [], values: [] }
}

function requestFor(draft: PivotDraft): DraftRequest {
  const { id, sheetId, name, sourceSheetId, rows, columns, values } = draft
  const range = parseRange(draft.sourceRef.replaceAll('$', ''), 20_000)
  const anchor = parseRange(draft.destination.replaceAll('$', ''), 1)
  if (range.row === range.endRow || range.endColumn - range.column >= 64) {
    throw new Error('请选择有表头和数据的区域，最多 64 列。')
  }
  if (!name.trim()) throw new Error('请输入透视表名称。')
  return { id, sheetId, config: { name: name.trim(), sourceSheetId,
    sourceRange: { startRow: range.row + 1, endRow: range.endRow + 1,
      startColumn: range.column + 1, endColumn: range.endColumn + 1 },
    anchorRow: anchor.row + 1, anchorColumn: anchor.column + 1, rows, columns, values } }
}

function addField(draft: PivotDraft, area: Area, drag: FieldDrag, before?: number): PivotDraft {
  const rows = [...draft.rows], columns = [...draft.columns], values = [...draft.values]
  let measure: PivotMeasure = { field: drag.field, aggregate: 'sum' }
  if (drag.from === 'values' && drag.index !== undefined) {
    measure = values.splice(drag.index, 1)[0] ?? measure
  } else if ((drag.from === 'rows' || drag.from === 'columns') && drag.index !== undefined) {
    ;(drag.from === 'rows' ? rows : columns).splice(drag.index, 1)
  }
  const nextIndex = before !== undefined && drag.from === area && drag.index !== undefined && drag.index < before
    ? before - 1 : before
  if (area === 'values') {
    if (values.length >= 8) return draft
    if (values.some(item => item.field === measure.field && item.aggregate === measure.aggregate)) return draft
    values.splice(nextIndex ?? values.length, 0, measure)
  } else {
    // A dimension belongs to exactly one of the two axes.
    const cleanRows = rows.filter(field => field !== drag.field)
    const cleanColumns = columns.filter(field => field !== drag.field)
    const axis = area === 'rows' ? cleanRows : cleanColumns
    if (axis.length >= 8) return draft
    axis.splice(nextIndex ?? axis.length, 0, drag.field)
    return { ...draft, rows: cleanRows, columns: cleanColumns, values }
  }
  return { ...draft, rows, columns, values }
}

function cellText(cell: PivotCell): string {
  if (cell.type === 'blank') return ''
  if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  return cell.value
}

function ReportPreview({ report, label }: { report: PivotReport; label: string }) {
  return <div className="pivot-report-scroll" tabIndex={0} aria-label={label}>
    <table aria-label={label} style={{ minWidth: report.cells[0].length * 62 }}>
      <thead>{report.cells.slice(0, report.headerRows).map((row, r) =>
        <tr key={r}>{row.map((cell, c) => <th key={c} scope="col">{cellText(cell)}</th>)}</tr>)}</thead>
      <tbody>{report.cells.slice(report.headerRows).map((row, r) => <tr key={r}>{row.map((cell, c) => c < report.labelColumns
        ? <th key={c} scope="row">{cellText(cell)}</th>
        : <td key={c} className={cell.type === 'number' ? 'pivot-number' : undefined}>{cellText(cell)}</td>
      )}</tr>)}</tbody>
    </table>
  </div>
}

export function WorksheetPivotDialog({ session, revision, activeSheet, selection, sheets, entries, selected, editable, close, save }: {
  session: Session; revision: number; activeSheet: string; selection: string; sheets: SheetChoice[]
  entries: PivotEntry[]; selected?: PivotEntry; editable: boolean
  close: () => void
  save: (request: { sheetId: string; pivotId: string; config: WorksheetPivotConfig | null }, revision: number) => Promise<void>
}) {
  const { locale } = useI18n()
  const t = (source: string) => localizeSource(locale, source)
  const title = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const newName = () => {
    const taken = new Set(entries.map(entry => entry.pivot.config.name.toLowerCase()))
    let number = 1
    while (taken.has('pivottable' + number)) number++
    return 'PivotTable' + number
  }
  const [draft, setDraft] = useState(() => makeDraft(selected, activeSheet, selection, newName()))
  const [base, setBase] = useState(revision)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState<{ revision: number; sheetId: string; cells: Record<string, string> }>()
  const [fieldError, setFieldError] = useState('')
  const [result, setResult] = useState<{ fingerprint: string; revision: number; preview?: Preview; error?: string }>()
  const entry = entries.find(entry => entry.pivot.id === draft.id && entry.sheetId === draft.sheetId)
  const outdated = base !== revision
  const editableFields = editable && !busy && !outdated
  const set = (update: Partial<PivotDraft>) => setDraft(previous => ({ ...previous, ...update }))
  const request = useMemo(() => {
    try { return { value: requestFor(draft) } }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }, [draft])
  const key = request.value && draft.values.length ? JSON.stringify(request.value) : ''
  const activeResult = result?.fingerprint === key && result.revision === revision ? result : undefined
  const currentPreview = activeResult?.preview

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setFieldError('')
    void api(session, '/sheets/' + encodeURIComponent(draft.sourceSheetId), { signal: controller.signal })
      .then(response => response.json() as Promise<{ revision: number; sheetId: string;
        cells: Array<{ address: string; text: string; calculation?: { status: string; value: string | null } }> }>)
      .then(sheet => {
        if (!controller.signal.aborted && sheet.revision === revision) {
          setSource({ revision, sheetId: sheet.sheetId, cells: Object.fromEntries(sheet.cells
            .map(cell => [cell.address, cell.calculation?.value ?? cell.text])) })
        }
      }).catch(error => { if (!controller.signal.aborted) setFieldError(String(error)) })
    return () => controller.abort()
  }, [session, revision, draft.sourceSheetId])

  useEffect(() => {
    if (!key || outdated || !editable) return
    const controller = new AbortController()
    const task = window.setTimeout(() => {
      const { id, sheetId, config } = JSON.parse(key) as DraftRequest
      const query = new URLSearchParams({ revision: String(revision), pivotId: id, config: JSON.stringify(config) })
      void api(session, `/sheet-pivot-preview/${encodeURIComponent(sheetId)}?${query}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Preview>)
        .then(preview => { if (!controller.signal.aborted) setResult({ fingerprint: key, revision, preview }) })
        .catch(error => { if (!controller.signal.aborted) setResult({ fingerprint: key, revision, error: String(error) }) })
    }, 180)
    return () => { controller.abort(); window.clearTimeout(task) }
  }, [session, revision, key, outdated, editable])

  const fields = useMemo(() => {
    if (source?.sheetId !== draft.sourceSheetId || source.revision !== revision) return []
    try {
      const range = parseRange(draft.sourceRef.replaceAll('$', ''), 20_000)
      if (range.endColumn - range.column >= 64) return []
      return Array.from({ length: range.endColumn - range.column + 1 }, (_, offset) => {
        const column = columnName(range.column + offset)
        return { label: source.cells[column + (range.row + 1)]?.trim() || column, field: offset }
      })
    } catch { return [] }
  }, [source, revision, draft.sourceSheetId, draft.sourceRef])
  const fieldLabel = (field: number) => fields[field]?.label ?? String(field + 1)
  const selectEntry = (next?: PivotEntry) => {
    setDraft(makeDraft(next, activeSheet, selection, newName()))
    setBase(revision); setNotice(''); setResult(undefined)
  }
  const startDrag = (event: DragEvent, field: FieldDrag) => {
    event.dataTransfer.setData(dragFormat, JSON.stringify(field))
    event.dataTransfer.effectAllowed = field.from ? 'move' : 'copy'
  }
  const drop = (event: DragEvent, area: Area, before?: number) => {
    event.preventDefault(); event.stopPropagation()
    if (!editableFields) return
    try {
      const field = JSON.parse(event.dataTransfer.getData(dragFormat)) as FieldDrag
      if (fields.some(item => item.field === field.field)) setDraft(value => addField(value, area, field, before))
    } catch { /* ignore other drag types */ }
  }

  async function submit(event: FormEvent, remove = false) {
    event.preventDefault()
    if (!editableFields || !remove && (!request.value || !currentPreview)) return
    setBusy(true); setNotice('')
    try {
      await save({ sheetId: draft.sheetId, pivotId: draft.id, config: remove ? null : request.value!.config }, base)
      close()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  const unchanged = entry && request.value
    && JSON.stringify(requestFor(makeDraft(entry, activeSheet, selection, '')).config) === JSON.stringify(request.value.config)
  const report = currentPreview?.report ?? (outdated || !editable ? entry?.pivot.snapshot?.report : undefined)
  return <dialog ref={dialog} className="hcd-dialog worksheet-pivot-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header className="pivot-dialog-header">
      <h2 id={title}><TableProperties size={19} /><LocalText source="数据透视表" /></h2>
      <button type="button" aria-label={t('关闭')} onClick={close} disabled={busy}><X size={18} /></button>
    </header>
    <form onSubmit={submit}>
      <div className="pivot-report-picker">
        {entries.length > 0 && <label><LocalText source="透视表" />
          <select aria-label={t('选择透视表')} value={entry?.pivot.id ?? ''} onChange={event =>
            selectEntry(entries.find(item => item.pivot.id === event.target.value))} disabled={busy}>
            <option value="" disabled>{t('新建透视表')}</option>
            {entries.map(({ sheetId, pivot }) => <option key={pivot.id} value={pivot.id}>
              {pivot.config.name} · {sheets.find(sheet => sheet.sheetId === sheetId)?.sheetName}
            </option>)}
          </select></label>}
        {editable && <button type="button" onClick={() => selectEntry()} disabled={busy}><Plus size={15} /><LocalText source="新建透视表" /></button>}
      </div>
      {outdated && <div className="pivot-revision-note" role="status">
        <span><LocalText source="工作簿已更新，重新读取后可继续配置。" /></span>
        <button type="button" disabled={busy} onClick={() => { setBase(revision); setResult(undefined); setNotice('') }}><LocalText source="读取当前修订" /></button>
      </div>}
      <fieldset className="pivot-location" disabled={!editableFields}>
        <label><LocalText source="名称" /><input aria-label={t('透视表名称')} required maxLength={120} value={draft.name}
          onChange={event => set({ name: event.target.value })} /></label>
        <label><LocalText source="源工作表" /><select aria-label={t('源工作表')} value={draft.sourceSheetId}
          onChange={event => set({ sourceSheetId: event.target.value, rows: [], columns: [], values: [] })}>
          {sheets.map(sheet => <option key={sheet.sheetId} value={sheet.sheetId}>{sheet.sheetName}</option>)}</select></label>
        <label><LocalText source="源数据区域" /><input aria-label={t('源数据区域')} required value={draft.sourceRef}
          onChange={event => set({ sourceRef: event.target.value })} /></label>
        <label><LocalText source="结果工作表" /><select aria-label={t('结果工作表')} disabled={!!entry} value={draft.sheetId}
          onChange={event => set({ sheetId: event.target.value })}>
          {sheets.map(sheet => <option key={sheet.sheetId} value={sheet.sheetId}>{sheet.sheetName}</option>)}</select></label>
        <label><LocalText source="结果起点" /><input aria-label={t('结果起点')} required value={draft.destination}
          onChange={event => set({ destination: event.target.value })} /></label>
      </fieldset>
      <div className="pivot-layout">
        <section className="pivot-field-catalog" aria-label={t('源字段')}>
          <h3><LocalText source="源字段" /></h3>
          {fields.map(({ field, label }) => <div key={field} className="pivot-catalog-field" title={label}
            draggable={editableFields} onDragStart={event => startDrag(event, { field })}>
            <GripVertical size={15} aria-hidden="true" /><span>{label}</span>
          </div>)}
          {fieldError && <p role="alert">{fieldError}</p>}
        </section>
        <div className="pivot-field-areas">
          {(Object.entries(layoutAreas) as Array<[Area, (typeof layoutAreas)[Area]]>).map(([area, labels]) => {
            const members = area === 'values' ? draft.values : draft[area].map(field => ({ field, aggregate: undefined }))
            return <section key={area} className="pivot-field-area" aria-label={t(labels.title)}
              onDragOver={event => { if (editableFields && event.dataTransfer.types.includes(dragFormat)) event.preventDefault() }}
              onDrop={event => drop(event, area)}>
              <h3><LocalText source={labels.title} /></h3>
              {members.map(({ field, aggregate }, index) => <div key={`${field}:${aggregate ?? ''}`} className="pivot-assigned-field"
                draggable={editableFields} onDragStart={event => startDrag(event, { field, from: area, index })}
                onDrop={event => drop(event, area, index)}>
                <GripVertical size={14} aria-hidden="true" /><span title={fieldLabel(field)}>{fieldLabel(field)}</span>
                {area === 'values' && <select value={aggregate} disabled={!editableFields}
                  aria-label={`${fieldLabel(field)} ${t('汇总方式')}`} onChange={event => {
                    const aggregate = event.target.value as PivotAggregate
                    set({ values: draft.values.map((value, i) => i === index ? { ...value, aggregate } : value) })
                  }}>
                  {Object.entries(operations).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select>}
                <button type="button" aria-label={`${t('移除')} ${fieldLabel(field)}`} disabled={!editableFields}
                  onClick={() => setDraft(value => ({ ...value, [area]: value[area].filter((_, i) => i !== index) }))}><X size={14} /></button>
              </div>)}
              {editable && <select className="pivot-add-field" aria-label={t(labels.add)} value="" disabled={!editableFields || !fields.length}
                onChange={event => {
                  if (event.target.value !== '') setDraft(value => addField(value, area, { field: Number(event.target.value) }))
                }}>
                <option value="">{t(labels.add)}</option>
                {fields.map(({ field, label }) => <option key={field} value={field}>{label}</option>)}</select>}
            </section>
          })}
        </div>
        <section className="pivot-preview" aria-label={t('汇总预览')}>
          <h3><LocalText source="汇总预览" /></h3>
          {report ? <ReportPreview report={report} label={t('透视表汇总结果')} /> : activeResult?.error
            ? <p role="alert">{activeResult.error}</p>
            : request.error ? <p role="status">{request.error}</p>
            : <p role="status"><LocalText source={key && !outdated && editable ? '正在计算…' : '添加值字段以生成汇总。'} /></p>}
        </section>
      </div>
      {notice && <p role="alert">{notice}</p>}
      {editable && <footer className="hcd-dialog-actions">
        {entry && <button type="button" className="pivot-delete" disabled={!editableFields} onClick={event => void submit(event, true)}>
          <Trash2 size={15} /><LocalText source="删除透视表" />
        </button>}
        <button type="button" onClick={close} disabled={busy}><LocalText source="取消" /></button>
        <button type="submit" className="primary" disabled={!editableFields || !currentPreview}>
          {unchanged && <RefreshCw size={15} />}<LocalText source={busy ? '保存中…' : unchanged ? '刷新透视表' : '保存透视表'} />
        </button>
      </footer>}
    </form>
  </dialog>
}
