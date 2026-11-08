import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {workbookBlankConflict} from './workbookBlankConflict.ts'
import type {Session} from './api.ts'
import type {WorkbookBlankInput} from './workbookBlankInput.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',format:'xlsx',token:'secret',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),nodeId='n_'+'b'.repeat(32),sheetId='s_'+'c'.repeat(32),text='Peer 😀',nodeHash=createHash('sha256').update(text).digest('hex')
const input:WorkbookBlankInput={documentId:'doc',baseRevision:0,sourceSha256:source,cell:{sheetId,nodeId,sheetPart:'xl/worksheets/sheet1.xml',row:3,column:2,text:'local'}}
const node={documentId:'doc',revision:1,nodeId,nodeHash,text,source:{nodeKind:'cell',part:input.cell.sheetPart,paragraphId:'B3',editable:true}}
test('blank conflict is pinned to a head and verifies source, coordinates and text hash',async()=>{
 const old=globalThis.fetch;let current:any=node
 globalThis.fetch=async url=>String(url).endsWith('/head')?Response.json({documentId:'doc',revision:1,sourceSha256:source}):Response.json(current)
 try{
  assert.deepEqual(await workbookBlankConflict(session,source,input,new AbortController().signal),{revision:1,run:{nodeId,nodeHash,text},editable:true})
  current={...node,text:'forged'};await assert.rejects(workbookBlankConflict(session,source,input,new AbortController().signal),/invalid blank conflict/)
  current={...node,source:{...node.source,paragraphId:'A1'}};await assert.rejects(workbookBlankConflict(session,source,input,new AbortController().signal),/invalid blank conflict/)
  current={...node,revision:2};await assert.rejects(workbookBlankConflict(session,source,input,new AbortController().signal),/invalid blank conflict/)
 }finally{globalThis.fetch=old}
})
