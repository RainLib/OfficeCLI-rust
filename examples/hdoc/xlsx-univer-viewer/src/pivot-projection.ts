import type { ICellData, IObjectMatrixPrimitiveType, IStyleData } from '@univerjs/presets'
import { BooleanNumber, CellValueType } from '@univerjs/presets'
import type { FWorksheet } from '@univerjs/preset-sheets-core'
import type { PivotCell, WorksheetPivot } from './hcd.ts'

const HEADER: IStyleData = { bg: { rgb: '#e4f0ed' }, cl: { rgb: '#265b50' }, bl: BooleanNumber.TRUE }
const TOTAL: IStyleData = { bg: { rgb: '#f2f6f5' }, cl: { rgb: '#265b50' }, bl: BooleanNumber.TRUE }
const BLANK: ICellData = { v: null, f: null, p: null, s: null }

function bodyCell(cell: PivotCell, style: IStyleData | null): ICellData {
  const empty = { ...BLANK, s: style }
  switch (cell.type) {
    case 'blank': return empty
    case 'number': return { ...empty, v: Number(cell.value), t: CellValueType.NUMBER }
    case 'boolean': return { ...empty, v: Number(cell.value), t: CellValueType.BOOLEAN }
    case 'text':
    case 'error': return { ...empty, v: cell.value, t: CellValueType.STRING }
  }
}

function writeCells(sheet: FWorksheet, values: IObjectMatrixPrimitiveType<ICellData>) {
  let firstRow = Infinity, firstColumn = Infinity, lastRow = -1, lastColumn = -1
  for (const [r, columns] of Object.entries(values)) {
    const row = Number(r)
    for (const c of Object.keys(columns)) {
      const column = Number(c)
      firstRow = Math.min(firstRow, row); lastRow = Math.max(lastRow, row)
      firstColumn = Math.min(firstColumn, column); lastColumn = Math.max(lastColumn, column)
    }
  }
  if (!Number.isFinite(firstRow)) return
  if (lastRow >= sheet.getMaxRows()) sheet.setRowCount(lastRow + 1)
  if (lastColumn >= sheet.getMaxColumns()) sheet.setColumnCount(lastColumn + 1)
  sheet.getRange(firstRow, firstColumn, lastRow - firstRow + 1, lastColumn - firstColumn + 1).setValues(values)
}

type Projection = { definitions: readonly WorksheetPivot[]; original: IObjectMatrixPrimitiveType<ICellData> }

export class PivotProjection {
  private readonly views = new Map<string, Projection>()

  isCurrent(sheetId: string, pivots: readonly WorksheetPivot[]) {
    return this.views.get(sheetId)?.definitions === pivots
  }

  restore(sheet: FWorksheet) {
    const previous = this.views.get(sheet.getSheetId())
    if (!previous) return
    this.views.delete(sheet.getSheetId())
    writeCells(sheet, previous.original)
  }

  paint(sheet: FWorksheet, pivots: readonly WorksheetPivot[]) {
    this.restore(sheet)
    const values: IObjectMatrixPrimitiveType<ICellData> = {}
    for (const pivot of pivots) {
      if (pivot.origin && (pivot.removed || pivot.snapshot)) {
        const { range } = pivot.origin
        if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 4096) continue
        for (let row = range.startRow - 1; row < range.endRow; row++) {
          for (let column = range.startColumn - 1; column < range.endColumn; column++) {
            (values[row] ??= {})[column] = BLANK
          }
        }
      }
      const report = pivot.snapshot?.report
      if (pivot.removed || !report) continue
      report.cells.forEach((cells, r) => {
        cells.forEach((cell, c) => {
          const row = pivot.config.anchorRow + r - 1
          const column = pivot.config.anchorColumn + c - 1
          const style = r < report.headerRows ? HEADER
            : r === report.cells.length - 1 && pivot.config.rows.length ? TOTAL : null
          ;(values[row] ??= {})[column] = bodyCell(cell, style)
        })
      })
    }
    const original: IObjectMatrixPrimitiveType<ICellData> = {}
    for (const [r, columns] of Object.entries(values)) {
      const row = Number(r)
      for (const c of Object.keys(columns)) {
        const column = Number(c)
        const cell = sheet.getRange(row, column).getCellData()
        ;(original[row] ??= {})[column] = cell ? structuredClone(cell) : BLANK
      }
    }
    this.views.set(sheet.getSheetId(), { definitions: pivots, original })
    writeCells(sheet, values)
  }
}
