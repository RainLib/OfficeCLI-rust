import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { TiptapTransformer } from '@hocuspocus/transformer'
import {applyFontSize,fontSizeValue,captureFontSizeTarget,applyFontSizeCommand} from './fontSize.ts'
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

test('font command draft tokens bind editor, document, selection and stored marks without rejecting metadata-only updates',()=>{
 const content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'ABCD'}]}]},a=new Editor({element:null,extensions:schemaExtensions,content}),b=new Editor({element:null,extensions:schemaExtensions,content})
 try{
  a.commands.setTextSelection({from:1,to:3});const target=captureFontSizeTarget(a),original=a.getJSON()
  assert.equal(applyFontSizeCommand(b,{sizePt:18,target}),'changed');assert.deepEqual(a.getJSON(),original)
  a.commands.setTextSelection({from:2,to:4});assert.equal(applyFontSizeCommand(a,{sizePt:18,target}),'changed')
  a.commands.setTextSelection({from:1,to:3});a.view.dispatch(a.state.tr.setMeta('view-only',true));assert.equal(applyFontSizeCommand(a,{sizePt:18,target}),'applied')
  const next=captureFontSizeTarget(a);a.view.dispatch(a.state.tr.insertText('peer',4));const before=a.getJSON();assert.equal(applyFontSizeCommand(a,{sizePt:24,target:next}),'changed');assert.deepEqual(a.getJSON(),before)
  a.commands.setTextSelection(1);const caret=captureFontSizeTarget(a);a.commands.setMark('bold');assert.equal(applyFontSizeCommand(a,{sizePt:20,target:caret}),'changed')
 }finally{a.destroy();b.destroy()}
})

test('font command validates external numeric inputs and never accepts a fabricated draft token',()=>{
 const editor=new Editor({element:null,extensions:schemaExtensions,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Text'}]}]}})
 try{
  editor.commands.setTextSelection({from:1,to:5});const before=editor.getJSON()
  for(const input of [undefined,[],{}, {sizePt:'18'},{sizePt:NaN},{sizePt:Infinity},{sizePt:0},{sizePt:12.25},{sizePt:1638.5},{sizePt:18,extra:true}]){assert.equal(applyFontSizeCommand(editor,input),'invalid');assert.deepEqual(editor.getJSON(),before)}
  for(const target of [{},null,'stale']){assert.equal(applyFontSizeCommand(editor,{sizePt:18,target}),'changed');assert.deepEqual(editor.getJSON(),before)}
  assert.equal(applyFontSizeCommand(editor,{sizePt:10.5}),'applied')
  editor.setEditable(false);assert.equal(applyFontSizeCommand(editor,{sizePt:24}),'readOnly')
 }finally{editor.destroy()}
})
