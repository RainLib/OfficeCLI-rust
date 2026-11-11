import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadWorkbookRevisionSelection} from './workbookRevisionReview.ts'
const info=(sequence:number,chunkId:string,htmlHash:string,mapHash:string,over:Record<string,unknown>={})=>({sequence,chunkId,region:'sheet',continuation:false,htmlHash,mapHash,blockCount:1,textChars:4,...over})
// Mirrors the real grid chunk body (crates/hcd-formats/src/xlsx.rs): the
// drawing layer is its own section and embeds `src="asset://sha256/{hash}"`.
const sheetHtml=(text:string,asset?:string)=>`<section class="hcd-sheet" data-hcd-sheet="Sheet1"><table class="hcd-grid"><tbody><tr><td class="hcd-cell"><span>${text}</span></td></tr></tbody></table></section>${asset?`<section class="hcd-sheet-drawing-layer" data-hcd-sheet="Sheet1" data-hcd-sheet-index="0" data-hcd-sheet-state="visible"><div class="hcd-sheet-picture" style="left:0.00px;top:0.00px;width:100.00px;height:50.00px"><img src="asset://sha256/${asset}" data-hcd-asset-href="xl/media/image1.png" alt="picture"/></div></section>`:''}`
test('the workbook selection pairs sheet windows, extracts cell text, and flags image swaps',async()=>{
 const session={documentId:'doc',token:'t',scope:'read' as const,format:'xlsx',apiUrl:'http://grid.test'}
 const pages:Record<string,unknown>={
  'http://grid.test/doc?revision=1':{revision:1,chunkCount:2,indexPageCount:1},
  'http://grid.test/doc/index/0?revision=1':{revision:1,page:0,chunks:[info(0,'c-aa','h1','m1'),info(1,'c-bb','hA','mA')]},
  'http://grid.test/doc/chunks/0?revision=1':{descriptor:info(0,'c-aa','h1','m1'),html:sheetHtml('旧值','a'.repeat(64))},
  'http://grid.test/doc?revision=2':{revision:2,chunkCount:2,indexPageCount:1},
  'http://grid.test/doc/index/0?revision=2':{revision:2,page:0,chunks:[info(0,'c-aa','h2','m1'),info(1,'c-bb','hA','mB')]},
  'http://grid.test/doc/chunks/0?revision=2':{descriptor:info(0,'c-aa','h2','m1'),html:sheetHtml('新值','b'.repeat(64))},
 }
 const previous=globalThis.fetch
 globalThis.fetch=(async (input:RequestInfo|URL)=>{
  const key=String(input)
  if(!(key in pages))throw new Error(`unexpected request ${key}`)
  return new Response(JSON.stringify(pages[key]),{status:200,headers:{'content-type':'application/json'}})
 })as typeof fetch
 try{
  const selection=await loadWorkbookRevisionSelection(session,1,2,{author:'林',createdAt:1730000000000},new AbortController().signal)
  assert.equal(selection.target,1);assert.equal(selection.comparedWith,2)
  assert.equal(selection.author,'林');assert.equal(selection.createdAt,1730000000000)
  assert.deepEqual(selection.changes.map(row=>row.kind),['modified','same'])
  assert.equal(selection.changes[0].beforeText,'旧值')
  assert.equal(selection.changes[0].afterText,'新值')
  assert.equal(selection.changes[0].objectChanged,true)
  assert.equal(selection.changes[0].formatChanged,false)
  assert.equal(selection.changes[1].formatChanged,true) // map-only change stays a regenerated receipt
 }
 finally{globalThis.fetch=previous}
})
test('identical decoded cell text with different markup encoding is a formatting change',async()=>{
 const session={documentId:'doc',token:'t',scope:'read' as const,format:'xlsx',apiUrl:'http://grid.test'}
 const pages:Record<string,unknown>={
  'http://grid.test/doc?revision=1':{revision:1,chunkCount:1,indexPageCount:1},
  'http://grid.test/doc/index/0?revision=1':{revision:1,page:0,chunks:[info(0,'c-aa','h1','m1')]},
  'http://grid.test/doc/chunks/0?revision=1':{descriptor:info(0,'c-aa','h1','m1'),html:sheetHtml('同值')},
  'http://grid.test/doc?revision=2':{revision:2,chunkCount:1,indexPageCount:1},
  'http://grid.test/doc/index/0?revision=2':{revision:2,page:0,chunks:[info(0,'c-aa','h2','m1')]},
  'http://grid.test/doc/chunks/0?revision=2':{descriptor:info(0,'c-aa','h2','m1'),html:sheetHtml('同&#20540;')},
 }
 const previous=globalThis.fetch
 globalThis.fetch=(async (input:RequestInfo|URL)=>{
  const key=String(input)
  if(!(key in pages))throw new Error(`unexpected request ${key}`)
  return new Response(JSON.stringify(pages[key]),{status:200,headers:{'content-type':'application/json'}})
 })as typeof fetch
 try{
  const selection=await loadWorkbookRevisionSelection(session,1,2,{},new AbortController().signal)
  assert.deepEqual(selection.changes.map(row=>row.kind),['modified'])
  assert.equal(selection.changes[0].objectChanged,false)
  assert.equal(selection.changes[0].formatChanged,true) // the entity collapses to identical text, so only formatting moved
 }
 finally{globalThis.fetch=previous}
})
