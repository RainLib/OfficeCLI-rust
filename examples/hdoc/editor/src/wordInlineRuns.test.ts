import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distributeWordInlines } from './wordInlineRuns.ts'

test('Word additions and formatting changes retain source anchors across Unicode and repeated rich edits', () => {
  const original = [{ text: '甲😀标题', nodeId: 'blue-title', bold: true }, { text: '结尾', nodeId: 'green-end', italic: true }]
  const replacement = [{ text: '甲😀标题', bold: true }, { text: ' 普通追加' }, { text: '结尾', italic: true }]
  const plan = distributeWordInlines(original, replacement)!
  assert.deepEqual(plan.map(anchor => [anchor.nodeId, anchor.inlines.map(inline => inline.text).join('')]), [['blue-title', '甲😀标题 普通追加'], ['green-end', '结尾']])
  assert.equal(plan[0].inlines[0].bold, true)
  assert.equal(!!plan[0].inlines[1].bold, false)
  for (const text of ['', '改写😀', '甲😀标题结尾', '甲新增😀标题结尾', '甲😀标题结尾后']) {
    const result = distributeWordInlines(plan.flatMap(anchor => anchor.inlines), [{ text, bold: true }])!
    assert.equal(result.flatMap(anchor => anchor.inlines).map(inline => inline.text).join(''), text)
    assert.deepEqual(result.map(anchor => anchor.nodeId), ['blue-title', 'green-end'])
    assert.ok(result.flatMap(anchor => anchor.inlines).filter(inline => inline.text).every(inline => inline.bold))
  }
  assert.equal(distributeWordInlines(original, [{ text: '链接变更', link: 'https://example.org' }]), null)
  assert.equal(original[0].text, '甲😀标题')
})
