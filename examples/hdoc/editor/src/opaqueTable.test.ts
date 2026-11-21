import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './schema.ts'
import { migrateOpaqueRuns } from './migrateOpaqueRuns.ts'

const projection: Projection = { documentId: 'table', revision: 4, blocks: [{
  blockId: 'table-block', blockHash: 'hash', region: 'body', readOnly: true,
  content: { kind: 'opaque', inlines: [
    { nodeId: 'blue', text: 'ROW ', bold: true, italic: false },
    { nodeId: 'green', text: '00', italic: true, bold: false },
    { nodeId: 'empty', text: '', bold: false, italic: false },
  ] },
}] }
const snapshot = (doc: Y.Doc) => jsonToSnapshot(TiptapTransformer.fromYdoc(doc, 'default'))
const firstText = (doc: Y.Doc) => ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText

test('mapped table runs merge concurrent characters without losing formatting, source identity or empty runs', () => {
  const left = TiptapTransformer.toYdoc(projectionToJson(projection), 'default', schemaExtensions)
  const right = new Y.Doc(); Y.applyUpdate(right, Y.encodeStateAsUpdate(left))
  firstText(left).insert(0, 'LEFT ')
  firstText(right).insert(4, '中文🙂')
  const leftUpdate = Y.encodeStateAsUpdate(left), rightUpdate = Y.encodeStateAsUpdate(right)
  Y.applyUpdate(left, rightUpdate); Y.applyUpdate(right, leftUpdate)
  const expected = structuredClone(projection.blocks[0].content)
  expected.inlines[0].text = 'LEFT ROW 中文🙂'
  assert.deepEqual(snapshot(left), [{ blockId: 'table-block', content: expected }])
  assert.deepEqual(snapshot(right), snapshot(left))
})

test('old opaque rooms gain collaborative runs once and retain existing shared drafts', () => {
  const json = projectionToJson(projection)
  delete json.content![0].content
  json.content!.unshift({ type: 'paragraph', content: [{ type: 'text', text: 'UNSAVED HUMAN DRAFT' }] })
  const doc = TiptapTransformer.toYdoc(json, 'default', schemaExtensions)
  migrateOpaqueRuns(doc); migrateOpaqueRuns(doc)
  assert.equal(snapshot(doc)[0].content.inlines[0].text, 'UNSAVED HUMAN DRAFT')
  assert.deepEqual(snapshot(doc)[1], { blockId: 'table-block', content: projection.blocks[0].content })
  const block = doc.getXmlFragment('default').get(1) as Y.XmlElement
  assert.equal(block.length, 3)
  const text = (block.get(0) as Y.XmlElement).get(0) as Y.XmlText
  text.insert(0, 'EDIT ')
  migrateOpaqueRuns(doc)
  assert.equal(snapshot(doc)[1].content.inlines[0].text, 'EDIT ROW ')
  assert.equal(block.length, 3)
})
