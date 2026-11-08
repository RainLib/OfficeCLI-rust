import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WorkbookBlankSave,validateBlankCreateAttempt,type BlankCreateAttempt} from './workbookBlankSave.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'http://test/v1/documents'}
const source='a'.repeat(64),root='b'.repeat(64),nodeId='n_'+'c'.repeat(32)
const attempt:BlankCreateAttempt={documentId:'doc',patchId:'grid-attempt',baseRevision:4,sourceSha256:source,cells:[{sheetId:'s_'+'d'.repeat(32),sheetPart:'xl/worksheets/sheet1.xml',row:3,column:2,text:'中文😀',nodeId}]}
const committed={status:'committed',patchId:attempt.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:[nodeId]}
test('lost response retains the exact persisted attempt until its receipt resolves',async()=>{
 const old=globalThis.fetch,writes:Array<BlankCreateAttempt|null>=[],requests:Array<{url:string;body:string}>=[]
 const saver=new WorkbookBlankSave(session,source,{write:async value=>{writes.push(structuredClone(value))}})
 globalThis.fetch=async(input,init)=>{requests.push({url:String(input),body:String(init?.body)});throw Error('response lost')}
 try{
  await assert.rejects(saver.save(attempt,new AbortController().signal),/response lost/)
  assert.deepEqual(saver.pending,attempt);assert.deepEqual(writes,[attempt])
  await assert.rejects(saver.save({...attempt,patchId:'grid-other'},new AbortController().signal),/blank save pending/)
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),body:String(init?.body)});return Response.json(committed)}
  assert.deepEqual(await saver.save(attempt,new AbortController().signal),{revision:5,rootHash:root})
  assert.equal(saver.pending,null);assert.deepEqual(writes,[attempt,null]);assert.match(requests[1].url,/receipt$/);assert.equal(requests[0].body,requests[1].body)
  assert.doesNotMatch(requests[0].body,/secret|nodeId/)
 }finally{globalThis.fetch=old}
})
test('missing receipt retries only the same request; bad receipt keeps it pending',async()=>{
 const old=globalThis.fetch,requests:string[]=[]
 const saver=new WorkbookBlankSave(session,source,{write:async()=>{}},attempt)
 globalThis.fetch=async(input)=>{const url=String(input);requests.push(url);return Response.json(url.endsWith('/receipt')?{status:'missing',patchId:attempt.patchId}:{...committed,dirtyNodeIds:['n_'+'e'.repeat(32)]})}
 try{await assert.rejects(saver.save(attempt,new AbortController().signal),/invalid blank receipt/);assert.deepEqual(saver.pending,attempt);assert.equal(requests.length,2)}finally{globalThis.fetch=old}
})
test('a failed durable write prevents the network mutation and restored data is validated',async()=>{
 const old=globalThis.fetch;let sent=false;globalThis.fetch=async()=>{sent=true;return Response.json(committed)}
 try{
  const saver=new WorkbookBlankSave(session,source,{write:async()=>{throw Error('quota')}})
  await assert.rejects(saver.save(attempt,new AbortController().signal),/quota/);assert.equal(sent,false)
  assert.throws(()=>validateBlankCreateAttempt({...attempt,sourceSha256:'e'.repeat(64)},session,source),/invalid/)
  assert.throws(()=>validateBlankCreateAttempt({...attempt,cells:[attempt.cells[0],attempt.cells[0]]},session,source),/invalid/)
  assert.throws(()=>validateBlankCreateAttempt({...attempt,cells:[{...attempt.cells[0],text:'\ud800'}]},session,source),/invalid/)
 }finally{globalThis.fetch=old}
})
test('a committed request remains recoverable when clearing its device record fails',async()=>{
 const old=globalThis.fetch;let clears=0
 const saver=new WorkbookBlankSave(session,source,{write:async value=>{if(value===null&&clears++===0)throw Error('journal unavailable')}},attempt)
 globalThis.fetch=async()=>Response.json(committed)
 try{
  await assert.rejects(saver.save(attempt,new AbortController().signal),/journal unavailable/)
  assert.deepEqual(saver.pending,attempt)
  assert.deepEqual(await saver.save(attempt,new AbortController().signal),{revision:5,rootHash:root})
  assert.equal(saver.pending,null)
 }finally{globalThis.fetch=old}
})
