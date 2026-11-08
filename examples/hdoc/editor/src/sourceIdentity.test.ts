import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { clearPastedBlockIds, jsonToSnapshot, projectionToJson, schemaExtensions, type Projection } from './schema.ts'
import { applyFontSize } from './fontSize.ts'
import { legacySnapshot, reconcileSourceIdentities, upgradeSourceIdentity } from './sourceIdentityMigration.ts'
import { checkpointContents } from './checkpointSnapshot.ts'
import { yBlocks } from './typographyMigration.ts'

const one = `n_${'1'.repeat(32)}`, two = `n_${'2'.repeat(32)}`
const projection = (): Projection => ({ documentId:'sources',revision:1,blocks:[{blockId:'p',blockHash:'hash',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[
  {nodeId:one,text:'ABCD',typography:{family:'Arial',sizePt:14}},
  {nodeId:two,text:'EFGH',typography:{family:'Arial',sizePt:14}},
]}}] })
const legacyDocument = (value: Projection) => {
  const snapshot = legacySnapshot(projectionToJson(value))
  const json = projectionToJson({...value,blocks:value.blocks.map((block,index)=>({...block,content:snapshot[index].content}))})
  const document = TiptapTransformer.toYdoc(json,'default',schemaExtensions)
  document.getMap('hcdSchema').set('typography',2)
  return document
}

test('mixed nested lists migrate source identities without a phantom bullet start attribute', () => {
  const canonical:Projection={documentId:'sources',revision:1,blocks:[{blockId:'mixed',blockHash:'hash',region:'body',readOnly:false,content:{kind:'list_item',level:1,listStart:4,inlines:[],children:[
    {kind:'paragraph',inlines:[{nodeId:one,text:'Parent'}]},
    {kind:'ordered_list',listStart:7,inlines:[],children:[{kind:'list_item',level:1,inlines:[],children:[
      {kind:'paragraph',inlines:[{nodeId:two,text:'Child'}]},
      {kind:'bullet_list',inlines:[],children:[{kind:'list_item',level:0,inlines:[{nodeId:`n_${'3'.repeat(32)}`,text:'Leaf'}]}]},
    ]}]},
  ]}}]}
  const expected=projectionToJson(canonical),document=TiptapTransformer.toYdoc(expected,'default',schemaExtensions)
  const before=checkpointContents(jsonToSnapshot(expected))
  try {
    upgradeSourceIdentity(document,canonical,true)
    assert.equal(checkpointContents(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))),before)
    assert.equal(document.getMap('hcdSchema').get('sourceIdentity'),1)
  } finally {document.destroy()}
})

test('identical adjacent source runs keep identities through partial size and text edits', () => {
  const editor = new Editor({element:null,extensions:schemaExtensions,content:projectionToJson(projection())})
  assert.equal(editor.state.doc.firstChild!.childCount,2)
  editor.commands.setTextSelection({from:3,to:7})
  assert.equal(applyFontSize(editor,'28.5'),'applied')
  let parts = jsonToSnapshot(editor.getJSON())[0].content.inlines
  assert.deepEqual(parts.map(part=>[part.text,part.nodeId,!!part.fontSizeExplicit]),[['AB',one,false],['CD',one,true],['EF',two,true],['GH',two,false]])
  editor.commands.setTextSelection({from:3,to:5})
  editor.view.dispatch(editor.state.tr.insertText('中文😀'))
  parts = jsonToSnapshot(editor.getJSON())[0].content.inlines
  assert.equal(parts.map(part=>part.text).join(''),'AB中文😀EFGH')
  assert.equal(parts.find(part=>part.text==='中文😀')?.nodeId,one)
  const document = TiptapTransformer.toYdoc(editor.getJSON(),'default',schemaExtensions)
  assert.deepEqual(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))[0].content.inlines,parts)
  editor.destroy(); document.destroy()
})

test('clipboard source IDs are removed and inline paste inherits only the insertion source', () => {
  const schema = getSchema(schemaExtensions)
  const paragraph = schema.nodeFromJSON(projectionToJson(projection()).content![0])
  const inline = new Slice(Fragment.from(paragraph),1,1)
  const clean = clearPastedBlockIds(inline)
  assert.equal(clean.content.firstChild!.attrs.hcdBlockId,null)
  assert.equal(clean.content.firstChild!.firstChild!.marks.some(mark=>mark.type.name==='hcdSource'),false)
  const targeted = clearPastedBlockIds(inline,two)
  targeted.content.firstChild!.forEach(node=>{assert.equal(node.marks.find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId,two);assert.equal(node.marks.find(mark=>mark.type.name==='textTypography')?.attrs.explicitSize,true)})
  const multi = clearPastedBlockIds(new Slice(Fragment.fromArray([paragraph,paragraph]),1,1),two)
  multi.content.forEach(node=>node.forEach(text=>assert.equal(text.marks.some(mark=>mark.type.name==='hcdSource'),false)))
})

test('legacy migration preserves pending sizes and the original CRDT text items', () => {
  const canonical = projection(), document = legacyDocument(canonical)
  const leaf = yBlocks(document)[0].get(0) as Y.XmlText
  leaf.format(2,4,{textTypography:{family:'Arial',sizePt:28.5}})
  upgradeSourceIdentity(document,canonical)
  assert.equal(yBlocks(document)[0].get(0),leaf)
  const parts = jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))[0].content.inlines
  assert.equal(parts.map(part=>part.text).join(''),'ABCDEFGH')
  assert.deepEqual(parts.filter(part=>part.typography?.sizePt===28.5).map(part=>[part.nodeId,part.fontSizeExplicit]),[[one,true],[two,true]])
  assert.equal(document.getMap('hcdSchema').get('sourceIdentity'),1)
  document.destroy()
})

test('a failed legacy migration is atomic and retains pending text for recovery', () => {
  const canonical = projection(), document = legacyDocument(canonical)
  const leaf = yBlocks(document)[0].get(0) as Y.XmlText
  leaf.insert(2,'pending 中文😀')
  const before = Y.encodeStateAsUpdate(document)
  assert.throws(()=>upgradeSourceIdentity(document,canonical),/retain draft/)
  assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  assert.equal(document.getMap('hcdSchema').get('sourceIdentity'),undefined)
  document.destroy()
})

test('pending text in a single uniform source node migrates without guessing offsets', () => {
  const canonical=projection();canonical.blocks[0].content.inlines=canonical.blocks[0].content.inlines.slice(0,1)
  const document=legacyDocument(canonical), leaf=yBlocks(document)[0].get(0) as Y.XmlText
  leaf.delete(0,leaf.length);leaf.insert(0,'new 中文😀',{textTypography:{family:'Arial',sizePt:14}})
  upgradeSourceIdentity(document,canonical)
  const parts=jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))[0].content.inlines
  assert.equal(parts.map(part=>part.text).join(''),'new 中文😀');assert.ok(parts.every(part=>part.nodeId===one))
  document.destroy()
})

test('many alternating source runs migrate without a quadratic font-range scan', () => {
  const canonical=projection()
  canonical.blocks[0].content.inlines=Array.from({length:1200},(_,index)=>({nodeId:`n_${index.toString(16).padStart(32,'0')}`,text:'甲',typography:{sizePt:index%2?20:14}}))
  const document=legacyDocument(canonical)
  upgradeSourceIdentity(document,canonical)
  const parts=jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))[0].content.inlines
  assert.equal(parts.length,1200)
  assert.equal(parts[1199].nodeId,canonical.blocks[0].content.inlines[1199].nodeId)
  document.destroy()
})

test('code typography keeps source marks and explicit size survives same-size reset', () => {
  const value = projection(); value.blocks[0].content.kind='code_block'
  const json: JSONContent = projectionToJson(value)
  getSchema(schemaExtensions).nodeFromJSON(json).check()
  const editor = new Editor({element:null,extensions:schemaExtensions,content:json})
  editor.commands.setTextSelection({from:1,to:3}); assert.equal(applyFontSize(editor,'14'),'applied')
  const inline = jsonToSnapshot(editor.getJSON())[0].content.inlines[0]
  assert.equal(inline.nodeId,one); assert.equal(inline.fontSizeExplicit,true)
  editor.destroy()
})

test('empty imported paragraphs retain their source and font for subsequent typing', () => {
  const value = projection(); value.blocks[0].content.inlines = [{nodeId:one,text:'',typography:{family:'Arial',sizePt:14}}]
  const editor = new Editor({element:null,extensions:schemaExtensions,content:projectionToJson(value)})
  editor.view.updateState(editor.state.reconfigure({plugins:editor.extensionManager.plugins}))
  editor.commands.setTextSelection(1); editor.view.dispatch(editor.state.tr.insertText('中文😀'))
  const inline = jsonToSnapshot(editor.getJSON())[0].content.inlines[0]
  assert.equal(inline.text,'中文😀'); assert.equal(inline.nodeId,one); assert.equal(inline.typography?.sizePt,14)
  assert.equal(inline.fontSizeExplicit,undefined)
  editor.destroy()
})

test('a new paragraph split at the end does not lend its previous paragraph source to pasted text',()=>{
  const editor=new Editor({element:null,extensions:schemaExtensions,content:projectionToJson(projection())})
  editor.view.updateState(editor.state.reconfigure({plugins:editor.extensionManager.plugins}))
  editor.commands.setTextSelection(editor.state.doc.content.size-1)
  assert.ok(editor.commands.splitBlock())
  editor.view.dispatch(editor.state.tr.insertText('Copied text'))
  const snapshot=jsonToSnapshot(editor.getJSON())
  assert.equal(snapshot.length,2)
  assert.equal(snapshot[1].content.inlines[0].text,'Copied text')
  assert.equal(snapshot[1].content.inlines[0].nodeId,undefined)
  assert.deepEqual(snapshot[0].content.inlines.map(inline=>inline.nodeId),[one,two])
  editor.destroy()
})

test('empty nested paragraphs use their own source rather than the parent first run', () => {
  const value=projection();value.blocks[0].content={kind:'blockquote',inlines:[],children:[{kind:'paragraph',inlines:[{text:'first',nodeId:one,typography:{sizePt:14}}]},{kind:'paragraph',inlines:[{text:'',nodeId:two,typography:{sizePt:20}}]}]}
  const editor=new Editor({element:null,extensions:schemaExtensions,content:projectionToJson(value)})
  editor.view.updateState(editor.state.reconfigure({plugins:editor.extensionManager.plugins}))
  let position=0;editor.state.doc.descendants((node,pos)=>{if(node.isTextblock&&node.content.size===0)position=pos+1})
  editor.commands.setTextSelection(position);editor.view.dispatch(editor.state.tr.insertText('second'))
  const inline=jsonToSnapshot(editor.getJSON())[0].content.children![1].inlines[0]
  assert.equal(inline.nodeId,two);assert.equal(inline.typography?.sizePt,20)
  editor.destroy()
})

test('canonical identity reconciliation retains late text and does not create a semantic edit', () => {
  const value = projection(), document = TiptapTransformer.toYdoc(projectionToJson(value),'default',schemaExtensions)
  const blocks = yBlocks(document), leaf = blocks[0].get(0) as Y.XmlText
  leaf.insert(2,'late')
  const before = checkpointContents(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default')))
  const canonical = structuredClone(value.blocks); canonical[0].blockId='new-p'; canonical[0].content.inlines[0].nodeId=`n_${'3'.repeat(32)}`; canonical[0].content.inlines[1].nodeId=`n_${'4'.repeat(32)}`
  reconcileSourceIdentities(document,blocks,canonical,'test')
  assert.equal(yBlocks(document)[0],blocks[0]); assert.equal(blocks[0].getAttribute('hcdBlockId'),'new-p')
  assert.equal(checkpointContents(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))),before)
  assert.equal(blocks[0].getAttribute('hcdSourceId'),canonical[0].content.inlines[0].nodeId)
  document.destroy()
})

test('legacy paragraph boundary edits are retained rather than guessed from concatenated text', () => {
  const value = projection(); value.blocks[0].content={kind:'blockquote',inlines:[],children:[{kind:'paragraph',inlines:[{text:'ABCD',nodeId:one}]},{kind:'paragraph',inlines:[{text:'EFGH',nodeId:two}]}]}
  const document = legacyDocument(value), quote=yBlocks(document)[0], second=quote.get(1) as Y.XmlElement
  document.transact(()=>{quote.delete(1,1); const first=quote.get(0) as Y.XmlElement; (first.get(0) as Y.XmlText).insert(4,'EFGH')})
  assert.ok(second instanceof Y.XmlElement)
  const before=Y.encodeStateAsUpdate(document)
  assert.throws(()=>upgradeSourceIdentity(document,value),/structure differs/)
  assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  document.destroy()
})
