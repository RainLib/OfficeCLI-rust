import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { applyFontSize, fontSizeValue } from './fontSize.ts'
import { jsonToSnapshot, projectionToJson, schemaExtensions } from './schema.ts'

test('size edits affect only the selected range and retain mixed font families through Yjs and reopen', () => {
  const source = projectionToJson({ documentId: 'font-size', revision: 1, blocks: [{ blockId: 'one', blockHash: 'hash', region: 'body', readOnly: false,
    content: { kind: 'paragraph', inlines: [{ text: 'ABCD', bold: true, typography: { family: 'Arial', eastAsia: '宋体', sizePt: 14 } }, { text: 'EFGH', italic: true, typography: { family: 'Times New Roman', eastAsia: '黑体', sizePt: 20 } }] } }] })
  const editor = new Editor({ element: null, extensions: schemaExtensions, content: source })
  editor.commands.setTextSelection({ from: 3, to: 7 })
  assert.equal(applyFontSize(editor, '24.5'), 'applied')
  const parts = jsonToSnapshot(editor.getJSON())[0].content.inlines
  assert.deepEqual(parts.map(part => [part.text, part.typography?.sizePt]), [['AB', 14], ['CD', 24.5], ['EF', 24.5], ['GH', 20]])
  assert.deepEqual(parts.map(part => part.typography?.eastAsia), ['宋体', '宋体', '黑体', '黑体'])
  assert.equal(parts[1].bold, true); assert.equal(parts[2].italic, true)
  const ydoc = TiptapTransformer.toYdoc(editor.getJSON(), 'default', schemaExtensions)
  const reopened = jsonToSnapshot(TiptapTransformer.fromYdoc(ydoc, 'default'))
  assert.deepEqual(reopened[0].content.inlines, parts)
  ydoc.destroy(); editor.destroy()
})

test('invalid sizes and read-only formatting do not change content; cursor size applies to subsequent text', () => {
  for (const value of ['', '0', '-1', '12.25', 'Infinity', 'NaN', '1638.5', '4096.5']) assert.equal(fontSizeValue(value), null)
  assert.equal(fontSizeValue('10.5'), 10.5)
  assert.equal(fontSizeValue('1638'), 1638)
  const editor = new Editor({ element: null, extensions: schemaExtensions, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AB' }] }] } })
  const before = editor.getJSON()
  assert.equal(applyFontSize(editor, '12.25'), 'invalid')
  editor.setEditable(false)
  assert.equal(applyFontSize(editor, '18'), 'readOnly')
  assert.deepEqual(editor.getJSON(), before)
  editor.setEditable(true); editor.commands.setTextSelection(2)
  assert.equal(applyFontSize(editor, '18'), 'applied')
  assert.equal(editor.state.storedMarks?.find(mark => mark.type.name === 'textTypography')?.attrs.sizePt, 18)
  editor.view.dispatch(editor.state.tr.insertText('X'))
  assert.deepEqual(jsonToSnapshot(editor.getJSON())[0].content.inlines.map(part => [part.text, part.typography?.sizePt]), [['A', undefined], ['X', 18], ['B', undefined]])
  editor.destroy()
})


test('font changes never split surrogate pairs, emoji sequences or combining characters', () => {
  const editor = new Editor({ element: null, extensions: schemaExtensions, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '👩‍💻é中文' }] }] } })
  const before = editor.getJSON()
  for (const range of [{ from: 2, to: 3 }, { from: 6, to: 7 }]) {
    editor.commands.setTextSelection(range)
    assert.equal(applyFontSize(editor, '18'), 'partialGrapheme')
    assert.deepEqual(editor.getJSON(), before)
  }
  editor.commands.setTextSelection({ from: 1, to: 6 })
  assert.equal(applyFontSize(editor, '18'), 'applied')
  assert.equal(jsonToSnapshot(editor.getJSON())[0].content.inlines[0].text, '👩‍💻')
  assert.equal(editor.state.doc.textContent, '👩‍💻é中文')
  editor.destroy()
})
