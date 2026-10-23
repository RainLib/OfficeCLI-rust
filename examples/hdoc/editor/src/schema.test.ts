import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSchema, type JSONContent } from '@tiptap/core'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { jsonToSnapshot, projectionToJson, schemaExtensions } from './schema.ts'

function reopen(doc: JSONContent) {
  const saved = jsonToSnapshot(doc)
  const reopened = projectionToJson({ documentId: 'test', revision: 1, blocks: saved.map((block, index) => ({
    blockId: `block-${index}`, blockHash: 'hash', region: 'body', readOnly: false, content: block.content,
  })) })
  getSchema(schemaExtensions).nodeFromJSON(reopened).check()
  return { saved, reopened }
}

test('code, inline marks, hard breaks and rules survive save and reopen', () => {
  const doc: JSONContent = { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: '中文😀', marks: [{ type: 'strike' }, { type: 'underline' }] },
      { type: 'hardBreak' }, { type: 'text', text: 'const x', marks: [{ type: 'code' }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'rust' }, content: [{ type: 'text', text: 'let x = 1;\nprintln!("😀");' }] },
    { type: 'horizontalRule' },
  ] }
  const { saved, reopened } = reopen(doc)
  assert.equal(saved.length, 3)
  assert.equal(saved[0].content.inlines[1].hardBreak, true)
  assert.equal(saved[1].content.language, 'rust')
  assert.deepEqual(jsonToSnapshot(reopened).map(block => block.content), saved.map(block => block.content))
  const ydoc = TiptapTransformer.toYdoc(reopened, 'default', schemaExtensions)
  assert.deepEqual(jsonToSnapshot(TiptapTransformer.fromYdoc(ydoc, 'default')).map(block => block.content), saved.map(block => block.content))
  ydoc.destroy()
})

test('quoted paragraphs and nested ordered lists keep structure and numbering', () => {
  const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const doc: JSONContent = { type: 'doc', content: [
    { type: 'blockquote', content: [paragraph('quote'), paragraph('second paragraph')] },
    { type: 'orderedList', attrs: { start: 4 }, content: [
      { type: 'listItem', content: [paragraph('parent'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('child')] }] }] },
      { type: 'listItem', content: [paragraph('next')] },
    ] },
  ] }
  const { saved, reopened } = reopen(doc)
  assert.equal(saved[1].content.listStart, 4)
  assert.equal(saved[2].content.listStart, 5)
  assert.equal(saved[1].content.children?.[1].kind, 'bullet_list')
  assert.deepEqual(jsonToSnapshot(reopened).map(block => block.content), saved.map(block => block.content))
})

test('an unknown node fails explicitly instead of silently deleting content', () => {
  assert.throws(() => jsonToSnapshot({ type: 'doc', content: [{ type: 'unrecognized', content: [{ type: 'text', text: 'keep me' }] }] }), /Unsupported block/)
})
