import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editTextRuns, textRunOperations } from './textRunEdits.ts'

test('source runs keep their identities, untouched text and scalar offsets across mixed-script edits', () => {
  const runs = [
    { nodeId: 'bold-blue', nodeHash: 'a', text: 'ROW ' },
    { nodeId: 'italic-green', nodeHash: 'b', text: '🙂尾' },
  ]
  assert.deepEqual(editTextRuns(runs, 'ROW 中文🙂尾'), [
    { ...runs[0], text: 'ROW 中文' }, runs[1],
  ])
  assert.deepEqual(textRunOperations(runs, 'ROW 中文🙂尾'), [{
    op: 'text.splice', nodeId: 'bold-blue', start: 0, deleteCount: 4, insertText: 'ROW 中文', precondition: { nodeHash: 'a' },
  }])
  assert.deepEqual(textRunOperations(runs, 'ROW '), [{
    op: 'text.splice', nodeId: 'italic-green', start: 0, deleteCount: 2, insertText: '', precondition: { nodeHash: 'b' },
  }])
  for (const value of ['', '改写🙂尾', 'ROW 🙂新尾', 'ROW 🙂尾追加', '🙂', 'ROW \n🙂尾']) {
    assert.equal(editTextRuns(runs, value).map(run => run.text).join(''), value)
  }
  assert.equal(runs[1].text, '🙂尾')
  assert.deepEqual(textRunOperations(runs, 'ROW 🙂尾'), [])
})
