import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inspectWorkbookBlanks} from './workbookBlankInspection.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'http://test/v1/documents'}
const sheetId='s_'+'a'.repeat(32),nodeId='n_'+'b'.repeat(32),source='c'.repeat(64),root='d'.repeat(64)
const target={sheetId,row:2,column:2},cell={sheetId,row:3,column:3,address:'C3',sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet',sheetIndex:0,sheetState:'visible',nodeId}
test('blank inspection binds revision, source and coordinates to the returned identity',async()=>{
 const old=globalThis.fetch;let sent:unknown
 globalThis.fetch=async(_input,init)=>{sent=JSON.parse(String(init?.body));return Response.json({revision:4,rootHash:root,sourceSha256:source,cells:[cell]})}
 try{
  const result=await inspectWorkbookBlanks(session,4,source,[target],new AbortController().signal)
  assert.deepEqual(sent,{expectedRevision:4,sourceSha256:source,cells:[{sheetId,row:3,column:3}]})
  assert.equal(result.cells[0].row,2);assert.equal(result.cells[0].nodeId,nodeId);assert.equal(result.cells[0].sheetPart,cell.sheetPart)
  globalThis.fetch=async()=>Response.json({revision:5,rootHash:root,sourceSha256:source,cells:[cell]})
  await assert.rejects(inspectWorkbookBlanks(session,4,source,[target],new AbortController().signal),/invalid blank inspection result/)
  globalThis.fetch=async()=>Response.json({revision:4,rootHash:root,sourceSha256:source,cells:[{...cell,column:4}]})
  await assert.rejects(inspectWorkbookBlanks(session,4,source,[target],new AbortController().signal),/invalid blank inspection result/)
  await assert.rejects(inspectWorkbookBlanks(session,4,source,[target,target],new AbortController().signal),/invalid blank inspection/)
 }finally{globalThis.fetch=old}
})
test('blank inspection rejects oversized and aborted responses',async()=>{
 const old=globalThis.fetch,controller=new AbortController()
 try{
  globalThis.fetch=async()=>new Response('x'.repeat(4*1024*1024+1))
  await assert.rejects(inspectWorkbookBlanks(session,0,source,[target],controller.signal),/invalid blank inspection result/)
  controller.abort(new Error('cancelled'))
  await assert.rejects(inspectWorkbookBlanks(session,0,source,[target],controller.signal),/cancelled/)
 }finally{globalThis.fetch=old}
})
