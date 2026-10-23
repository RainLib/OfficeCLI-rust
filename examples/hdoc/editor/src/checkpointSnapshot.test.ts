import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameCheckpointContents } from './checkpointSnapshot.ts'
import { docxSourceAllowed, readExportOptions } from './exportOptions.ts'

test('semantic save digest ignores internal source IDs but retains visible formats and break boundaries', () => {
  const block = (inlines: Array<{text: string; nodeId?: string; hardBreak?: boolean; typography?: {sizePt:number}}>) => [{ blockId:'p', content: { kind:'paragraph' as const, inlines } }]
  assert.equal(sameCheckpointContents(block([{text:'A中😀 B', typography:{sizePt:14}}, {text:'after', typography:{sizePt:14}}]), block([{text:'A中😀 Bafter', typography:{sizePt:14}}])), true)
  assert.equal(sameCheckpointContents(block([{text:'A',nodeId:'one'}, {text:'B',nodeId:'two'}]),block([{text:'AB',nodeId:'one'}])), true)
  assert.equal(sameCheckpointContents(block([{text:'A',typography:{sizePt:14}}, {text:'B',typography:{sizePt:28.5}}]),block([{text:'AB',typography:{sizePt:14}}])), false)
  assert.equal(sameCheckpointContents(block([{text:'A'}, {text:'\n',hardBreak:true}, {text:'B'}]),block([{text:'A\nB'}])), false)
})

test('late save acknowledgement cannot cover newer font or text edits', () => {
  const before = [{ blockId: null, content: { kind: 'paragraph' as const, inlines: [{ text: 'Keep 中文😀', typography: { sizePt: 20 } }] } }]
  assert.equal(sameCheckpointContents(before, structuredClone(before)), true)
  const newer = structuredClone(before); newer[0].content.inlines[0].typography.sizePt = 28.5
  assert.equal(sameCheckpointContents(before, newer), false)
  newer[0].content.inlines[0].typography.sizePt = 20; newer[0].content.inlines[0].text += 'newer'
  assert.equal(sameCheckpointContents(before, newer), false)
  assert.equal(sameCheckpointContents(before, []), false)
})

test('DOCX export uses source only when the saved revision supports it', () => {
  assert.equal(docxSourceAllowed(readExportOptions({ revision: 1, sourceAvailable: true, sourceEditsSupported: true }, 1)), true)
  assert.equal(docxSourceAllowed(readExportOptions({ revision: 2, sourceAvailable: true, sourceEditsSupported: false }, 2)), false)
  assert.equal(docxSourceAllowed(readExportOptions({ revision: 1, sourceAvailable: false, sourceEditsSupported: true }, 1)), false)
  assert.throws(() => readExportOptions({ revision: 1, sourceAvailable: true, sourceEditsSupported: true }, 2))
  assert.throws(() => readExportOptions({ revision: 1, sourceAvailable: 'yes', sourceEditsSupported: true }, 1))
})
