import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameCheckpointContents,checkpointContents,legacyCheckpointContents } from './checkpointSnapshot.ts'
import { currentExportOptions, docxSourceAllowed, readExportOptions } from './exportOptions.ts'
import type {Inline,InlineContainerContent} from './schema.ts'

function inlineBody(id:number,inlines:Inline[]):Inline{return{text:'',content:{kind:'extension',extension:{schemaVersion:'hcd.extension/3',instanceId:`x_${id.toString(16).padStart(32,'0')}`,type:'example.inline_field',version:77,display:'inline',contentModel:'inline',data:{nodeId:'business-id'},fallback:{text:'Field label'}},inlines}}}
const bodyBlocks=(inlines:Inline[])=>[{blockId:null,content:{kind:'paragraph' as const,inlines}}]

test('inline-body semantic acknowledgement ignores recursive source receipts while preserving business identities',()=>{
 const before=bodyBlocks([inlineBody(1,[{text:'Out',bold:true,nodeId:'old1'},{text:'er',bold:true,nodeId:'old2'},inlineBody(2,[{text:'Nested😀',nodeId:'old3'}])])]),after=structuredClone(before),original=structuredClone(before)
 const body=after[0].content.inlines[0].content!;body.inlines.splice(0,2,{text:'Outer',bold:true,nodeId:'new1'});body.inlines[1].content!.inlines[0].nodeId='new2'
 assert.equal(sameCheckpointContents(before,after),true);assert.notEqual(legacyCheckpointContents(before),legacyCheckpointContents(after));assert.deepEqual(before,original)
 body.extension.data.nodeId='another-business-id';assert.equal(sameCheckpointContents(before,after),false)
})

test('new body text, formatting or reference layout is never acknowledged by an older capture',()=>{
 const before=bodyBlocks([inlineBody(1,[{text:'Keep😀',bold:true},inlineBody(2,[{text:'Nested'}])])])
 for(const mutate of [(body:InlineContainerContent)=>{body.inlines[0].text+=' Peer'},(body:InlineContainerContent)=>{body.inlines[0].bold=false},(body:InlineContainerContent)=>{body.inlines[1].content!.extension.instanceId='x_'+'f'.repeat(32)}]){
  const after=structuredClone(before);mutate(after[0].content.inlines[0].content!);assert.equal(sameCheckpointContents(before,after),false)
 }
 const duplicated=structuredClone(before);duplicated[0].content.inlines.push(structuredClone(duplicated[0].content.inlines[0]));assert.notEqual(checkpointContents(before),checkpointContents(duplicated))
})

test('canonical empty body source carriers do not create visible content, while frozen v1 serialization stays exact',()=>{
 const before=bodyBlocks([inlineBody(1,[])]),after=bodyBlocks([inlineBody(1,[{text:'',nodeId:'mapped-empty',bold:false,typography:null}])])
 assert.equal(sameCheckpointContents(before,after),true);assert.notEqual(legacyCheckpointContents(before),legacyCheckpointContents(after))
 const flat=bodyBlocks([{text:'A',nodeId:'one'},{text:'B',nodeId:'two'}])
 assert.equal(legacyCheckpointContents(flat),'[{"inlines":[{"nodeId":"one","text":"A"},{"nodeId":"two","text":"B"}],"kind":"paragraph"}]')
})

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

test('same-revision source restore invalidates the previous export preflight',()=>{
  const unavailable=readExportOptions({revision:5,sourceAvailable:false,sourceEditsSupported:true},5)
  const available=readExportOptions({revision:5,sourceAvailable:true,sourceEditsSupported:true},5)
  const old={value:unavailable,refreshKey:0},restored={value:available,refreshKey:1}
  assert.equal(docxSourceAllowed(currentExportOptions(old,5,0)!),false)
  assert.equal(currentExportOptions(old,5,1),null)
  assert.equal(docxSourceAllowed(currentExportOptions(restored,5,1)!),true)
  assert.equal(currentExportOptions(restored,6,1),null)
})
