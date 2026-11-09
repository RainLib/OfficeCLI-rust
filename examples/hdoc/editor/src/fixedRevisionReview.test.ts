import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fixedChunkText,fixedRevisionRows,loadFixedRevisionSelection,type FixedChunkInfo} from './fixedRevisionReview.ts'
const chunk=(sequence:number,chunkId:string,htmlHash:string,mapHash:string,over:Partial<FixedChunkInfo>={}):FixedChunkInfo=>({sequence,chunkId,region:'body',continuation:false,htmlHash,mapHash,blockCount:1,textChars:10,...over})
test('fixed chunk text strips markup, comments, styles, and entities without a DOM',()=>{
 assert.equal(fixedChunkText('<div>你好 &amp; 😀<!--note--><style>p{color:red}</style><span>  换行 </span>&nbsp;&#65;</div>'),'你好 & 😀 换行 A')
 assert.equal(fixedChunkText('<script>var a="<b>";</script><p>纯文本 &lt;tag&gt;</p>'),'纯文本 <tag>')
 assert.equal(fixedChunkText(''),'')
})
test('descriptor pairing keeps receipts stable and separates visible from mapping changes',()=>{
 const rows=fixedRevisionRows([chunk(0,'k0','h1','m1'),chunk(1,'k1','hA','mA')],[chunk(0,'k0','h2','m1'),chunk(1,'k1','hA','mB')])
 assert.deepEqual(rows.map(row=>row.kind),['modified','same'])
 assert.equal(rows[0].formatChanged,true) // html moved with identical text size until the body says otherwise
 assert.equal(rows[0].moved,false)
 assert.equal(rows[1].formatChanged,true) // map-only changes stay a regenerated receipt
})
test('regenerated chunk identities pair through their stable page sequence',()=>{
 const rows=fixedRevisionRows([chunk(0,'old','h','m')],[chunk(0,'fresh','h','m')])
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'same');assert.equal(rows[0].moved,false)
})
test('insertions append, deletions interleave at their old position, and true swaps mark moved',()=>{
 const appended=fixedRevisionRows([chunk(0,'k0','h','m')],[chunk(0,'k0','h','m'),chunk(1,'k1','h','m')])
 assert.deepEqual(appended.map(row=>row.kind),['same','added']);assert.equal(appended.filter(row=>row.moved).length,0)
 const deleted=fixedRevisionRows([chunk(0,'k0','h','m'),chunk(1,'k1','h','m'),chunk(2,'k2','h','m')],[chunk(0,'k0','h','m'),chunk(1,'k2','h','m')])
 assert.deepEqual(deleted.map(row=>row.kind),['same','removed','same'])
 assert.equal(deleted[1].oldIndex,1);assert.equal(deleted[1].newIndex,undefined)
 const swapped=fixedRevisionRows([chunk(0,'kA','h','m'),chunk(1,'kB','h','m')],[chunk(0,'kB','h','m'),chunk(1,'kA','h','m')])
 assert.equal(swapped.length,2);assert.equal(swapped.filter(row=>row.moved).length,1)
})
test('the selection assembles descriptors, page rows, and bounded body text through the native routes',async()=>{
 const session={documentId:'doc',token:'t',scope:'read' as const,format:'pptx',apiUrl:'http://fixed.test'}
 const pages:Record<string,unknown>={
  'http://fixed.test/doc?revision=1':{revision:1,chunkCount:2,indexPageCount:1},
  'http://fixed.test/doc/index/0?revision=1':{revision:1,page:0,chunks:[chunk(0,'k0','h1','m1'),chunk(1,'k1','hA','mA')]},
  'http://fixed.test/doc/chunks/0?revision=1':{html:'<div><span>旧内容</span></div>'},
  'http://fixed.test/doc?revision=2':{revision:2,chunkCount:2,indexPageCount:1},
  'http://fixed.test/doc/index/0?revision=2':{revision:2,page:0,chunks:[chunk(0,'k0','h2','m1'),chunk(1,'k1','hA','mA')]},
  'http://fixed.test/doc/chunks/0?revision=2':{html:'<div><span>新内容</span></div>'},
 }
 const previous=globalThis.fetch
 globalThis.fetch=(async (input:RequestInfo|URL)=>{
  const key=String(input)
  if(!(key in pages))throw new Error(`unexpected request ${key}`)
  return new Response(JSON.stringify(pages[key]),{status:200,headers:{'content-type':'application/json'}})
 })as typeof fetch
 try{
  const selection=await loadFixedRevisionSelection(session,1,2,{author:'林',createdAt:1730000000000},new AbortController().signal)
  assert.equal(selection.target,1);assert.equal(selection.comparedWith,2)
  assert.equal(selection.author,'林');assert.equal(selection.createdAt,1730000000000)
  assert.deepEqual(selection.changes.map(row=>row.kind),['modified','same'])
  assert.equal(selection.changes[0].beforeText,'旧内容')
  assert.equal(selection.changes[0].afterText,'新内容')
  assert.equal(selection.changes[0].formatChanged,false)
  assert.equal(selection.changes[0].objectChanged,false)
 }
 finally{globalThis.fetch=previous}
})
