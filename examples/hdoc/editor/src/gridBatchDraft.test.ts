import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gridBatchDraft, gridCellAddress, parseGridBatch } from './gridBatchDraft.ts'
import type { HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'

const sheetId = `s_${'a'.repeat(32)}`
function intent(): HcdPatchEventDetail {
  return { patch: { schemaVersion: 'hcd-patch/50', documentId: 'batch-test', patchId: 'exact-intent', baseRevision: 5,
    actor: { name: 'human' }, metadata: { rootHash: 'original-root' }, operations: [
      { type: 'xlsx.richText.create', sheetId, row: 2, column: 2, runs: [{ text: '新😀', properties: { b: { val: '1' } } }] },
      { type: 'xlsx.formula.create', sheetId, row: 2, column: 3, formula: '=B1*2' },
    ] }, changes: [
      { sheetId, row: 1, column: 1, oldText: '', newText: '新😀' },
      { sheetId, row: 1, column: 2, oldText: '', newText: '=B1*2' },
    ] }
}
test('grid batch retains exact identity, native types, formatting and target independently of later edits', () => {
  const detail = intent(), draft = gridBatchDraft(detail, 7)
  detail.patch.patchId = 'other'; detail.patch.baseRevision = 99; detail.changes[0].newText = 'other'
  assert.equal(draft.patch.patchId, 'exact-intent')
  assert.equal(draft.patch.baseRevision, 5)
  assert.equal(draft.patch.operations[0].op, 'xlsx.richText.create')
  assert.equal(draft.collaborationEpoch, 7)
  assert.equal(draft.text, 'B2: 新😀\nC2: =B1*2')
  const restored = parseGridBatch({ documentId: 'batch-test', content: JSON.stringify(draft) })
  assert.deepEqual(restored, draft)
  assert.equal(gridCellAddress(1048575, 16383), 'XFD1048576')
})
test('grid batch refuses wrong document, invalid addresses, epoch, revision and unsupported operations', () => {
  const draft = gridBatchDraft(intent(), 0)
  for (const mutate of [
    (d: any) => { d.patch.documentId = 'other' },
    (d: any) => { d.collaborationEpoch = -1 },
    (d: any) => { d.patch.baseRevision = 1.5 },
    (d: any) => { d.changes[0].row = 1048576 },
    (d: any) => { d.changes[0].column = -1 },
    (d: any) => { d.changes[0].sheetId = 'untrusted-sheet' },
    (d: any) => { d.patch.operations[0].op = 'block.delete' },
    (d: any) => { d.patch.operations = [] },
    (d: any) => { d.changes = [] },
  ]) {
    const broken = structuredClone(draft); mutate(broken)
    assert.throws(() => parseGridBatch({ documentId: 'batch-test', content: JSON.stringify(broken) }), /无法安全恢复/)
  }
})
