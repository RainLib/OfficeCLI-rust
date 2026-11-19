import { api, type Session } from '../api.ts'
import type { Projection } from '../schema.ts'

export const RESOURCE_SCHEMA = 'officecli-resource/1'
export type CellAnchor = { nodeId: string; address: string }
export type ResourceReference = {
  schemaVersion: typeof RESOURCE_SCHEMA; documentId: string; service: string
  anchor: { kind: 'document'; blockId?: string } | { kind: 'sheet-range'; sheetId: string; range: string; cells: CellAnchor[] }
}
export type Bounds = { row: number; column: number; endRow: number; endColumn: number }
export type ResourcePreview = { title: string; label: string; revision: number; text?: string; rows?: string[][]; columns?: string[]; firstRow?: number; bounds?: Bounds; sheetId?: string; cells?: CellAnchor[] }
export type SheetView = { revision: number; sheetId: string; sheetName: string; cells: { nodeId: string; address: string; text: string; isFormula: boolean; calculation: { status: string; value?: string | number | boolean } }[] }

export function resourceService(session: Session) { return new URL(session.apiUrl || '/v1/documents', window.location.href).href.replace(/\/$/, '') }
export function columnName(column: number) {
  let name = '', n = column + 1
  while (n > 0) { name = String.fromCharCode(65 + (n - 1) % 26) + name; n = Math.floor((n - 1) / 26) }
  return name
}
export function parseRange(value: string): Bounds {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/.exec(value.trim().toUpperCase())
  if (!match) throw new Error('请输入有效区域，例如 B2:F7。')
  const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
  const row = Number(match[2]) - 1, column = col(match[1]), endRow = Number(match[4] || match[2]) - 1, endColumn = col(match[3] || match[1])
  if (endRow < row || endColumn < column || endRow >= 1_048_576 || endColumn >= 16_384 || (endRow - row + 1) * (endColumn - column + 1) > 200) throw new Error('请选择不超过 200 个单元格的有效矩形区域。')
  return { row, column, endRow, endColumn }
}
export function referenceFrom(value: unknown): ResourceReference | null {
  if (!value || typeof value !== 'object') return null
  const ref = value as ResourceReference
  if (ref.schemaVersion !== RESOURCE_SCHEMA || typeof ref.documentId !== 'string' || !/^[\w-]{1,128}$/.test(ref.documentId)
    || typeof ref.service !== 'string' || ref.service.length > 1024 || !/^https?:\/\//.test(ref.service) || !ref.anchor) return null
  if (ref.anchor.kind === 'document') return ref.anchor.blockId === undefined || typeof ref.anchor.blockId === 'string' && ref.anchor.blockId.length > 0 && ref.anchor.blockId.length <= 256 ? ref : null
  if (ref.anchor.kind !== 'sheet-range' || typeof ref.anchor.sheetId !== 'string' || !ref.anchor.sheetId || ref.anchor.sheetId.length > 256 || typeof ref.anchor.range !== 'string' || !Array.isArray(ref.anchor.cells) || !ref.anchor.cells.length || ref.anchor.cells.length > 200) return null
  try {
    const bounds = parseRange(ref.anchor.range)
    const ids = new Set<string>()
    for (const cell of ref.anchor.cells) {
      if (!cell || typeof cell.nodeId !== 'string' || !cell.nodeId || cell.nodeId.length > 256 || ids.has(cell.nodeId) || typeof cell.address !== 'string') return null
      ids.add(cell.nodeId)
      const at = parseRange(cell.address)
      if (at.row !== at.endRow || at.column !== at.endColumn || at.row < bounds.row || at.row > bounds.endRow || at.column < bounds.column || at.column > bounds.endColumn) return null
    }
    return ref
  } catch { return null }
}
export function findResourceSession(ref: ResourceReference, sessions: Session[], owner: Session) {
  return sessions.find(session => !session.hostIntegration && session.documentId === ref.documentId && resourceService(session) === ref.service
    && resourceService(session) === resourceService(owner) && !!session.userId && session.userId === owner.userId)
}
export async function sheetChoices(session: Session, signal?: AbortSignal) {
  const manifest = await (await api(session, '', { signal })).json() as { revision: number; indexPageCount: number }
  if (!Number.isSafeInteger(manifest.indexPageCount) || manifest.indexPageCount < 0 || manifest.indexPageCount > 10_000) throw new Error('工作簿索引不可用。')
  const sheets = new Map<string, { sheetId: string; sheetName: string }>()
  for (let start = 0; start < manifest.indexPageCount; start += 8) {
    const pages = await Promise.all(Array.from({ length: Math.min(8, manifest.indexPageCount - start) }, (_, i) => api(session, `/index/${start + i}`, { signal }).then(r => r.json()) as Promise<{ chunks: { grid?: { sheetId: string; sheetName: string } }[] }>))
    for (const page of pages) for (const chunk of page.chunks) if (chunk.grid && !sheets.has(chunk.grid.sheetId)) sheets.set(chunk.grid.sheetId, { sheetId: chunk.grid.sheetId, sheetName: chunk.grid.sheetName })
  }
  return { revision: manifest.revision, sheets: [...sheets.values()] }
}
export async function readSheet(session: Session, sheetId: string, signal?: AbortSignal): Promise<SheetView> {
  const index = await sheetChoices(session, signal), number = index.sheets.findIndex(sheet => sheet.sheetId === sheetId)
  if (number < 0) throw new Error('引用的工作表已删除，请重新选择。')
  const sheet = await (await api(session, `/sheets/${number}`, { signal })).json() as SheetView
  if (sheet.sheetId !== sheetId || sheet.revision !== index.revision) throw new Error('工作簿正在更新，请刷新预览。')
  return sheet
}
export function rangeAnchors(sheet: SheetView, range: string): CellAnchor[] {
  const bounds = parseRange(range)
  const cells = sheet.cells.filter(cell => {
    const at = parseRange(cell.address)
    return at.row >= bounds.row && at.row <= bounds.endRow && at.column >= bounds.column && at.column <= bounds.endColumn
  }).map(({ nodeId, address }) => ({ nodeId, address }))
  if (!cells.length) throw new Error('请至少选择包含一个有内容单元格的区域。')
  return cells
}
export function previewSheet(sheet: SheetView, anchor: Extract<ResourceReference['anchor'], { kind: 'sheet-range' }>, title: string): ResourcePreview {
  const bounds = parseRange(anchor.range), byId = new Map(sheet.cells.map(cell => [cell.nodeId, cell]))
  if (anchor.cells.some(cell => byId.get(cell.nodeId)?.address !== cell.address)) throw new Error('引用位置已变化或单元格已删除，请重新选择区域。')
  const cells = new Map(sheet.cells.map(cell => [cell.address, cell]))
  const rows = Array.from({ length: bounds.endRow - bounds.row + 1 }, (_, r) => Array.from({ length: bounds.endColumn - bounds.column + 1 }, (_, c) => {
    const cell = cells.get(`${columnName(bounds.column + c)}${bounds.row + r + 1}`)
    if (!cell) return ''
    return cell.isFormula ? cell.calculation?.status === 'calculated' ? String(cell.calculation.value ?? '') : '待核算' : String(cell.calculation?.value ?? cell.text ?? '')
  }))
  return { title, label: `${sheet.sheetName} · ${anchor.range}`, revision: sheet.revision, rows, columns: rows[0].map((_, c) => columnName(bounds.column + c)), firstRow: bounds.row + 1, bounds, sheetId: sheet.sheetId, cells: rangeAnchors(sheet, anchor.range) }
}
export async function readResource(session: Session, ref: ResourceReference, signal?: AbortSignal): Promise<ResourcePreview> {
  if (!referenceFrom(ref) || session.documentId !== ref.documentId || resourceService(session) !== ref.service) throw new Error('资源引用与当前授权不匹配。')
  if (ref.anchor.kind === 'sheet-range') return previewSheet(await readSheet(session, ref.anchor.sheetId, signal), ref.anchor, session.title || session.documentId)
  const data = await (await api(session, '/editor', { signal })).json() as Projection
  const blockId = ref.anchor.blockId, blocks = blockId ? data.blocks.filter(block => block.blockId === blockId) : data.blocks
  if (!blocks.length) throw new Error('引用的段落已删除或文档没有可预览内容。')
  return { title: session.title || session.documentId, label: blockId ? '引用段落' : '文档预览', revision: data.revision,
    text: blocks.slice(0, 12).map(block => block.content.inlines.map(inline => inline.text).join('')).join('\n').slice(0, 6000) }
}
