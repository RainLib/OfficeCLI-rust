import { useRef, useState } from 'react'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'

export type GridDataSelection = {
  sheetId: string
  address: string
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

export type GridSortDirection = 'ascending' | 'descending'

export type GridFilterCriterion = { column: number; query: string }

export type GridAutoFilter = Omit<GridDataSelection, 'sheetId' | 'address'> & GridFilterCriterion & {
  additionalCriteria?: GridFilterCriterion[]
}

export type GridFilterView = { filter: GridAutoFilter; hiddenRows: number[]; total: number }

function columnName(column: number): string {
  let name = ''
  while (column > 0) {
    column -= 1
    name = String.fromCharCode(65 + column % 26) + name
    column = Math.floor(column / 26)
  }
  return name
}

type Props = {
  selection: GridDataSelection | null
  busy: boolean
  editing: boolean
  filter: { matched: number; total: number } | null
  savedFilter?: GridAutoFilter
  canSaveFilter: boolean
  onSort: (column: number, hasHeader: boolean, direction: GridSortDirection) => void
  onFilter: (criteria: GridFilterCriterion[], hasHeader: boolean) => void
  onClearFilter: () => void
  onSaveFilter: (criteria: GridFilterCriterion[]) => void
}

export function GridDataTools({ selection, busy, editing, filter, savedFilter, canSaveFilter, onSort, onFilter, onClearFilter, onSaveFilter }: Props) {
  const { locale } = useI18n()
  const [columnOffset, setColumnOffset] = useState(savedFilter ? savedFilter.column - savedFilter.startColumn : 0)
  const [hasHeader, setHasHeader] = useState(true)
  const [query, setQuery] = useState(savedFilter?.query ?? '')
  const [additional, setAdditional] = useState(() => (savedFilter?.additionalCriteria ?? [])
    .map((criterion, id) => ({ ...criterion, id })))
  const nextConditionId = useRef(additional.length)
  const startColumn = selection?.startColumn ?? 1
  const rowCount = selection ? selection.endRow - selection.startRow + 1 : 0
  const columnCount = selection ? selection.endColumn - selection.startColumn + 1 : 0
  const dataRows = rowCount - Number(hasHeader)
  const column = startColumn + Math.min(columnOffset, Math.max(0, columnCount - 1))
  const validRange = rowCount > 0 && rowCount <= 500 && columnCount <= 100
  const columns = validRange ? Array.from({ length: columnCount }, (_, index) => startColumn + index) : []
  const criteria = [{ column, query: query.trim() }, ...additional.map(item => ({ column: item.column, query: item.query.trim() }))]
  const selectedColumns = new Set(criteria.map(criterion => criterion.column))
  const nextColumn = columns.find(candidate => !selectedColumns.has(candidate))
  const filterReadOnly = !!savedFilter && !canSaveFilter
  const validColumns = selectedColumns.size === criteria.length && criteria.every(item => columns.includes(item.column))
  const sortDisabled = busy || !editing || !validRange || dataRows < 2 || dataRows * columnCount > 10_000 || !!filter
  const filterDisabled = busy || !validRange || dataRows < 1 || !validColumns || criteria.some(item => !item.query)
  const savedCriteria = savedFilter ? [savedFilter, ...(savedFilter.additionalCriteria ?? [])] : []
  const sameFilter = savedCriteria.length === criteria.length && criteria.every((item, index) =>
    item.column === savedCriteria[index].column && item.query === savedCriteria[index].query)
  const saveFilterDisabled = filterDisabled || !hasHeader || sameFilter

  function addCondition() {
    if (nextColumn === undefined) return
    const id = nextConditionId.current++
    setAdditional(previous => [...previous, { id, column: nextColumn, query: '' }])
  }

  function updateCondition(id: number, update: Partial<GridFilterCriterion>) {
    setAdditional(previous => previous.map(item => item.id === id ? { ...item, ...update } : item))
  }

  function removeFirstCondition() {
    const [first, ...rest] = additional
    if (!first || !columns.includes(first.column)) return
    setColumnOffset(first.column - startColumn)
    setQuery(first.query)
    setAdditional(rest)
  }

  return <>
    <div className="tool-group xlsx-data-tools">
      <span className="xlsx-data-address" aria-label={localizeSource(locale, '数据选区')}>{selection?.address ?? '—'}</span>
      <label><LocalText source="依据列" /> <select value={column} disabled={busy || !validRange || filterReadOnly}
        onChange={event => setColumnOffset(Number(event.target.value) - startColumn)}>
        {columns.map(item => <option key={item} value={item} disabled={item !== column && selectedColumns.has(item)}>{columnName(item)}</option>)}
      </select></label>
      <label className="mode"><input type="checkbox" checked={hasHeader} disabled={busy || !!savedFilter}
        onChange={event => setHasHeader(event.target.checked)} /><LocalText source="首行为表头" /></label>
      <button disabled={sortDisabled} onClick={() => onSort(column, hasHeader, 'ascending')}><LocalText source="升序" /></button>
      <button disabled={sortDisabled} onClick={() => onSort(column, hasHeader, 'descending')}><LocalText source="降序" /></button>
    </div>
    <form className="tool-group xlsx-data-tools xlsx-filter-tools" onSubmit={event => {
      event.preventDefault()
      if (filterDisabled) return
      if (savedFilter && canSaveFilter && !saveFilterDisabled) onSaveFilter(criteria)
      else if (!savedFilter) onFilter(criteria, hasHeader)
    }}>
      <div className="xlsx-filter-controls">
        <input className="xlsx-filter-query" aria-label={localizeSource(locale, '筛选关键词')} maxLength={256} value={query}
          placeholder={localizeSource(locale, '包含关键词')} disabled={busy || filterReadOnly} onChange={event => setQuery(event.target.value)} />
        {!filterReadOnly && additional.length > 0 && <button type="button" disabled={busy || !columns.includes(additional[0].column)}
          aria-label={localizeSource(locale, '移除首个条件')} title={localizeSource(locale, '移除首个条件')} onClick={removeFirstCondition}>×</button>}
        {!filterReadOnly && <button type="button" disabled={busy || dataRows < 1 || nextColumn === undefined}
          onClick={addCondition}><LocalText source="添加条件" /></button>}
        {!savedFilter && <button type="submit" disabled={filterDisabled}><LocalText source="筛选视图" /></button>}
        {canSaveFilter && <button type="button" disabled={saveFilterDisabled}
          onClick={() => onSaveFilter(criteria)}><LocalText source="保存筛选到 XLSX" /></button>}
        {filter && (!savedFilter || canSaveFilter) && <button type="button" disabled={busy} onClick={onClearFilter}>
          <LocalText source={savedFilter ? '移除已保存筛选' : '清除筛选'} /></button>}
      </div>
      {additional.length > 0 && <div className="xlsx-filter-conditions" aria-label={localizeSource(locale, '附加筛选条件')}>
        {additional.map((item, index) => <div key={item.id} className="xlsx-filter-controls">
          <span><LocalText source="且" /></span>
          <select aria-label={`${localizeSource(locale, '筛选列')} ${index + 2}`} value={columns.includes(item.column) ? item.column : ''}
            disabled={busy || !validRange || filterReadOnly} onChange={event => updateCondition(item.id, { column: Number(event.target.value) })}>
            {!columns.includes(item.column) && <option value="" disabled>—</option>}
            {columns.map(candidate => <option key={candidate} value={candidate}
              disabled={candidate !== item.column && selectedColumns.has(candidate)}>{columnName(candidate)}</option>)}
          </select>
          <input className="xlsx-filter-query" aria-label={`${localizeSource(locale, '筛选关键词')} ${index + 2}`} maxLength={256}
            placeholder={localizeSource(locale, '包含关键词')} value={item.query} disabled={busy || filterReadOnly}
            onChange={event => updateCondition(item.id, { query: event.target.value })} />
          {!filterReadOnly && <button type="button" disabled={busy} onClick={() => setAdditional(previous => previous.filter(other => other.id !== item.id))}>
            <LocalText source="移除条件" /></button>}
        </div>)}
      </div>}
    </form>
    <span className="ribbon-note" role="status">{filter ? <>{savedFilter && <LocalText source="已保存筛选 · " />}{filter.matched}/{filter.total} <LocalText source="行匹配" /></>
      : <LocalText source={!validRange ? '请选择最多 500 行、100 列的矩形区域' : !validColumns ? '每个条件必须选择选区内的不同列' : additional.length > 0 ? '仅显示满足全部条件的行' : canSaveFilter ? '保存筛选需要表头和文本列' : '排序保存到文件 · 筛选只作用于当前视图'} />}</span>
  </>
}
