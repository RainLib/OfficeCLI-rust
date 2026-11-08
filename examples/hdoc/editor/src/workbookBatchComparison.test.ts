import {test} from 'node:test'
import assert from 'node:assert/strict'
import {workbookBatchComparison} from './workbookBatchComparison.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',format:'xlsx',scope:'write',userId:'alice',token:'secret',apiUrl:'https://test/v1/documents'}
const source='a'.repeat(64),sheetId='s_'+'b'.repeat(32),root='c'.repeat(64),nodeId='n_'+'d'.repeat(32)
const cells=[{sheetId,row:2,column:1,text:'local'},{sheetId,row:2,column:2,text:'local2'}]
const result={documentId:'doc',revision:3,sourceSha256:source,rootHash:root,cells:[{sheetId,row:3,column:2,mapped:{nodeId,text:'peer',truncated:false,editable:true}},{sheetId,row:3,column:3,mapped:null}]}
test('comparison binds the document, version and every coordinate without treating unmapped as blank',async()=>{
 const old=globalThis.fetch
 try{
  globalThis.fetch=async()=>Response.json(result)
  const value=await workbookBatchComparison(session,source,3,cells,new AbortController().signal)
  assert.equal(value[0].mapped?.text,'peer');assert.equal(value[1].mapped,null)
  globalThis.fetch=async()=>Response.json({...result,revision:4})
  await assert.rejects(workbookBatchComparison(session,source,3,cells,new AbortController().signal),/invalid batch comparison/)
  globalThis.fetch=async()=>Response.json({...result,cells:[result.cells[1],result.cells[0]]})
  await assert.rejects(workbookBatchComparison(session,source,3,cells,new AbortController().signal),/invalid batch comparison/)
 }finally{globalThis.fetch=old}
})
