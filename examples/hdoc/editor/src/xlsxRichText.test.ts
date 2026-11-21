import { test } from 'node:test'
import assert from 'node:assert/strict'
import { documentFromInlineRuns, editedInlineRuns, inheritInlineRuns, validateInlineRuns } from '../../xlsx-univer-viewer/src/rich-text.ts'
import type { XlsxInlineRun } from '../../xlsx-univer-viewer/src/rich-text.ts'
import type { ICellData } from '@univerjs/presets'

test('XLSX selection formatting preserves native theme and scheme across emoji boundaries', () => {
  const text = '甲😀乙', properties = { color: { theme: '4', tint: '0.25' }, scheme: { val: 'minor' } }
  const original: Parameters<typeof editedInlineRuns>[2] = { text, inlineRuns: [{ text, properties }],
    richText: { id: 'source', documentStyle: {}, body: { dataStream: `${text}\r\n`, textRuns: [{ st: 0, ed: 4, ts: { bl: 0 } }] } } }
  const next: ICellData['p'] = { id: 'edited', documentStyle: {}, body: { dataStream: `${text}\r\n`, textRuns: [
    { st: 0, ed: 1, ts: { bl: 0 } }, { st: 1, ed: 3, ts: { bl: 1, va: 3 } }, { st: 3, ed: 4, ts: { bl: 0 } },
  ] } }
  assert.deepEqual(editedInlineRuns(text, next, original), [
    { text: '甲', properties }, { text: '😀', properties: { ...properties, b: { val: '1' }, vertAlign: { val: 'superscript' } } },
    { text: '乙', properties },
  ])
  assert.equal(editedInlineRuns(text, original.richText, original), null)
  assert.equal(original.inlineRuns![0].properties, properties)
  assert.equal('b' in properties, false)
})

test('XLSX text replacement and partial format keep unrelated native properties', () => {
  const original: Parameters<typeof editedInlineRuns>[2] = { text: 'abc😀', inlineRuns: [
    { text: 'ab', properties: { charset: { val: '134' }, b: { val: '1' } } },
    { text: 'c😀', properties: { i: { val: '1' }, u: { val: 'double' } } },
  ], richText: { id: 'before', documentStyle: {}, body: { dataStream: 'abc😀\r\n', textRuns: [
    { st: 0, ed: 2, ts: { bl: 1 } }, { st: 2, ed: 5, ts: { it: 1, ul: { s: 1 } } },
  ] } } }
  const doc: ICellData['p'] = { id: 'after', documentStyle: {}, body: { dataStream: 'ab新😀\r\n', textRuns: [
    { st: 0, ed: 2, ts: { bl: 1 } }, { st: 2, ed: 3, ts: { it: 1, ul: { s: 1 }, cl: { rgb: '#228844' } } },
    { st: 3, ed: 5, ts: { it: 1, ul: { s: 1 } } },
  ] } }
  assert.deepEqual(editedInlineRuns('ab新😀', doc, original), [
    original.inlineRuns![0], { text: '新', properties: { i: { val: '1' }, u: { val: 'double' }, color: { rgb: 'FF228844' } } },
    { text: '😀', properties: original.inlineRuns![1].properties },
  ])
})

test('XLSX rich input rejects split scalars and hidden objects and ignores stale formula-bar documents', () => {
  const original = { text: '😀x' }
  assert.throws(() => editedInlineRuns('😀x', { id: 'bad', documentStyle: {}, body: {
    dataStream: '😀x\r\n', textRuns: [{ st: 1, ed: 2, ts: { bl: 1 } }],
  } }, original), /Unicode/)
  assert.throws(() => editedInlineRuns('😀x', { id: 'embed', documentStyle: {}, body: {
    dataStream: '😀x\r\n', customRanges: [{ startIndex: 0, endIndex: 2, rangeId: 'link', rangeType: 1 }],
  } }, original), /嵌入对象/)
  assert.equal(editedInlineRuns('new', { id: 'stale', documentStyle: {}, body: { dataStream: '😀x\r\n' } }, original), null)
  assert.throws(() => editedInlineRuns('new', { id: 'wrong', documentStyle: {}, body: { dataStream: 'other\r\n' } }, original), /不一致/)
})

test('XLSX rich draft reconstruction keeps multiline offsets and native metadata', () => {
  const source: XlsxInlineRun[] = [{text:'甲😀\n',properties:{color:{theme:'4'},scheme:{val:'minor'}}},
    {text:'乙',properties:{i:{val:'1'}}}]
  const moved=inheritInlineRuns(source,'甲😀\n新增乙')
  validateInlineRuns(moved,'甲😀\n新增乙')
  const doc=documentFromInlineRuns(moved,'draft')
  assert.equal(doc.body!.dataStream,'甲😀\r新增乙\r\n')
  assert.deepEqual(doc.body!.paragraphs!.map(p=>p.startIndex),[3,7])
  assert.equal(editedInlineRuns('甲😀\n新增乙',doc,{text:'甲😀\n新增乙',inlineRuns:moved,richText:doc}),null)
  assert.throws(()=>validateInlineRuns(moved,'different'),/不一致/)
  assert.equal(moved[0].properties.color.theme,'4')
})

test('XLSX HTML clipboard RGB values save opaque colours without silently accepting transparency', () => {
  const doc = (rgb: string): ICellData['p'] => ({id:'clipboard',documentStyle:{},body:{dataStream:'新😀\r\n',
    textRuns:[{st:0,ed:3,ts:{bl:1,cl:{rgb}}}]}})
  for (const rgb of ['rgb(34, 136, 68)','rgba(34, 136, 68, 1)','#284','rgb(34 136 68 / 100%)']) {
    assert.deepEqual(editedInlineRuns('新😀',doc(rgb),{text:''}),[{text:'新😀',properties:{b:{val:'1'},color:{rgb:'FF228844'}}}])
  }
  assert.throws(()=>editedInlineRuns('新😀',doc('rgba(34,136,68,0.5)'),{text:''}),/不透明/)
  assert.throws(()=>editedInlineRuns('新😀',doc('rgb(999,0,0)'),{text:''}),/不透明/)
})
