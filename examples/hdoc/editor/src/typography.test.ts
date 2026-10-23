import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './schema.ts'
import { typography, safeFontStack } from './typography.ts'
import { selectionTypography } from './selectionTypography.ts'
import { upgradeTypography } from './typographyMigration.ts'

const font = { family: "'Times New Roman', serif", sizePt: 14, latin: 'Times New Roman', eastAsia: '宋体', bidi: 'Arial' }
function projection(): Projection {
  return { documentId: 'font-test', revision: 1, blocks: [{ blockId: 'b1', blockHash: 'hash', region: 'body', readOnly: false,
    content: { kind: 'paragraph', inlines: [{ text: '中文😀A', typography: font }, { text: 'B', bold: true, typography: { family: 'Arial', sizePt: 20 } }] } }] }
}

test('typography remains distinct across code blocks, mixed runs and Yjs reloads', () => {
  const source = projection()
  source.blocks.push({ ...source.blocks[0], blockId: 'code', content: { kind: 'code_block', inlines: [{ text: 'let 字 = 1;', typography: font }] } })
  source.blocks.push({ ...source.blocks[0], blockId: 'inline-code', content: { kind: 'paragraph', inlines: [{ text: 'inline_code', code: true, typography: font }] } })
  const json = projectionToJson(source)
  getSchema(schemaExtensions).nodeFromJSON(json).check()
  const ydoc = TiptapTransformer.toYdoc(json, 'default', schemaExtensions)
  const reopened = new Y.Doc()
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc))
  const blocks = jsonToSnapshot(TiptapTransformer.fromYdoc(reopened, 'default'))
  assert.deepEqual(blocks[0].content.inlines.map(part => part.typography), [font, { family: 'Arial', sizePt: 20 }])
  assert.deepEqual(blocks[1].content.inlines[0].typography, font)
  assert.deepEqual(blocks[2].content.inlines[0].typography, font)
  assert.equal(blocks[2].content.inlines[0].code, true)
  ydoc.destroy(); reopened.destroy()
})

test('selected typography reports mixed values and cursor follows stored marks', () => {
  const schema = getSchema(schemaExtensions), doc = schema.nodeFromJSON(projectionToJson(projection()))
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, doc.content.size - 1) })
  assert.equal(selectionTypography(state).mixedFamily, true)
  assert.equal(selectionTypography(state).mixedSize, true)
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, 2)).setStoredMarks([schema.marks.textTypography.create({ sizePt: 11 })]))
  assert.equal(selectionTypography(state).sizePt, 11)
  assert.equal(selectionTypography(state).mixedSize, false)
})

test('legacy migration adds source marks without recreating CRDT text identities', () => {
  const source = projection(), legacy = structuredClone(source)
  legacy.blocks[0].content.inlines.forEach(part => delete part.typography)
  const ydoc = TiptapTransformer.toYdoc(projectionToJson(legacy), 'default', schemaExtensions)
  const offline = new Y.Doc()
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(ydoc))
  const offlineText = (offline.getXmlFragment('default').toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText
  offlineText.insert(0, 'Z')
  upgradeTypography(ydoc, source)
  assert.equal(ydoc.getMap('hcdSchema').get('typography'), 2)
  const blocks = jsonToSnapshot(TiptapTransformer.fromYdoc(ydoc, 'default'))
  assert.deepEqual(blocks[0].content.inlines.map(part => part.typography), source.blocks[0].content.inlines.map(part => part.typography))
  assert.equal(blocks[0].content.inlines[1].bold, true)
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(offline))
  const text = jsonToSnapshot(TiptapTransformer.fromYdoc(ydoc, 'default'))[0].content.inlines.map(part => part.text).join('')
  assert.equal(text, 'Z中文😀AB')
  ydoc.destroy(); offline.destroy()
})

test('ambiguous legacy text leaves original persisted state untouched', () => {
  const source = projection(), legacy = structuredClone(source)
  legacy.blocks[0].content.inlines[0].text = 'pending edit'
  legacy.blocks[0].content.inlines.forEach(part => delete part.typography)
  const ydoc = TiptapTransformer.toYdoc(projectionToJson(legacy), 'default', schemaExtensions)
  const before = Y.encodeStateAsUpdate(ydoc)
  assert.throws(() => upgradeTypography(ydoc, source), /retain state for recovery/)
  assert.deepEqual(Y.encodeStateAsUpdate(ydoc), before)
  ydoc.destroy()
})

test('font values reject CSS injection, malformed stacks and invalid sizes', () => {
  for (const value of ["Arial'B'", "'A'B", '.Foo', ',Arial', 'Arial,', 'Arial;color:red', 'url(x)']) assert.equal(safeFontStack(value), false, value)
  assert.equal(safeFontStack("\"O'Name\",'A,B',宋体,serif"), true)
  for (const value of [{ sizePt: Infinity }, { sizePt: '12' }, { family: 'Arial;color:red' }, { sizePt: 0 }, { nonsense: 1 }]) assert.throws(() => typography(value))
})


test('version 1 migration adds script slots without erasing pending size changes', () => {
  const source = projection(), old = structuredClone(source)
  old.blocks[0].content.inlines[0].typography = { family: font.family, sizePt: 28.5 }
  const ydoc = TiptapTransformer.toYdoc(projectionToJson(old), 'default', schemaExtensions)
  ydoc.getMap('hcdSchema').set('typography', 1)
  upgradeTypography(ydoc, source)
  const saved = jsonToSnapshot(TiptapTransformer.fromYdoc(ydoc, 'default'))
  assert.equal(saved[0].content.inlines[0].typography?.sizePt, 28.5)
  assert.equal(saved[0].content.inlines[0].typography?.eastAsia, '宋体')
  assert.equal(ydoc.getMap('hcdSchema').get('typography'), 2)
  ydoc.destroy()
})


test('legacy hard breaks keep offsets and text identities during script-font migration', () => {
  const source = projection()
  source.blocks[0].content.inlines.splice(1, 0, { text: '\n', hardBreak: true })
  const old = structuredClone(source)
  old.blocks[0].content.inlines.forEach(part => { if (part.typography) delete part.typography.eastAsia })
  const document = TiptapTransformer.toYdoc(projectionToJson(old), 'default', schemaExtensions)
  document.getMap('hcdSchema').set('typography', 1)
  upgradeTypography(document, source)
  const saved = jsonToSnapshot(TiptapTransformer.fromYdoc(document, 'default'))
  assert.equal(saved[0].content.inlines.map(part => part.text).join(''), '中文😀A\nB')
  assert.equal(saved[0].content.inlines[0].typography?.eastAsia, '宋体')
  assert.equal(saved[0].content.inlines[1].hardBreak, true)
  document.destroy()
})
