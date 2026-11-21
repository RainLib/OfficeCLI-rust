import type { HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'
import type { InputDraft } from './inputDraftJournal.ts'

type NativePatch = HcdPatchEventDetail['patch']
type NativeOperation = NativePatch['operations'][number]
export type GridWirePatch = Omit<NativePatch, 'operations'> & {
  operations: Array<NativeOperation extends infer O ? O extends { type: infer K } ? Omit<O, 'type'> & { op: K } : never : never>
}
export type GridBatchDraft = { schemaVersion: 'hcd-grid-batch-input/1'; collaborationEpoch: number; patch: GridWirePatch; changes: HcdPatchEventDetail['changes']; text: string }
const operations = new Set(['text.splice','xlsx.richText.set','xlsx.richText.create','xlsx.cell.set','xlsx.formula.set',
  'xlsx.formula.create','xlsx.formula.to-value','xlsx.formula.to-number','xlsx.number.set'])
export function gridCellAddress(row: number, column: number) {
  let label = ''
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label
  return `${label}${row + 1}`
}
export function gridBatchDraft(detail: HcdPatchEventDetail, collaborationEpoch: number): GridBatchDraft {
  return structuredClone({ schemaVersion: 'hcd-grid-batch-input/1', collaborationEpoch,
    patch: { ...detail.patch, operations: detail.patch.operations.map(({type,...operation}) => ({op:type,...operation})) },
    changes: detail.changes, text: detail.changes.map(c => `${gridCellAddress(c.row,c.column)}: ${c.newText}`).join('\n'),
  }) as GridBatchDraft
}
export function parseGridBatch(record: Pick<InputDraft, 'content' | 'documentId'>): GridBatchDraft {
  const input = JSON.parse(record.content) as GridBatchDraft
  const p = input?.patch
  if (input?.schemaVersion !== 'hcd-grid-batch-input/1' || !p || p.documentId !== record.documentId
    || !Number.isSafeInteger(input.collaborationEpoch) || input.collaborationEpoch < 0 || typeof input.text !== 'string'
    || !/^hcd-patch\/\d+$/.test(p.schemaVersion) || typeof p.patchId !== 'string' || !p.patchId || p.patchId.length > 256
    || !Number.isSafeInteger(p.baseRevision) || p.baseRevision < 0 || p.baseRevision > 100000
    || !p.actor || typeof p.actor !== 'object' || !p.metadata || typeof p.metadata !== 'object'
    || !Array.isArray(p.operations) || p.operations.length < 1 || p.operations.length > 10000
    || p.operations.some(op => !op || !operations.has(op.op))
    || !Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 10000
    || input.changes.some(c => !c || typeof c.sheetId !== 'string' || !/^s_[0-9a-f]{32}$/.test(c.sheetId)
      || !Number.isSafeInteger(c.row) || c.row < 0 || c.row >= 1048576
      || !Number.isSafeInteger(c.column) || c.column < 0 || c.column >= 16384
      || typeof c.newText !== 'string' || typeof c.oldText !== 'string')) throw new Error('这批单元格输入无法安全恢复，请下载草稿保留')
  return input
}
