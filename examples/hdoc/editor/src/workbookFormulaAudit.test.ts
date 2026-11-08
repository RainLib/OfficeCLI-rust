import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ApiError,type Session} from './api.ts'
import {workbookFormulaAudit} from './workbookFormulaAudit.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'http://test/v1/documents'}
test('formula check and protection validate their revision and scoped receipts',async()=>{
 const old=globalThis.fetch;let request:{url:string;init?:RequestInit}|undefined
 globalThis.fetch=async(input,init)=>{request={url:String(input),init};return Response.json({revision:4,editableCellsChecked:3,sourceFreeEditsAuthorized:init?.method==='POST',...(init?.method==='POST'?{scope:'this-server'}:{})})}
 try{assert.deepEqual(await workbookFormulaAudit(session,4,false,new AbortController().signal),{revision:4,editableCellsChecked:3});assert.match(request!.url,/formula-audit\?revision=4$/)
  assert.deepEqual(await workbookFormulaAudit(session,4,true,new AbortController().signal),{revision:4,editableCellsChecked:3});assert.deepEqual(JSON.parse(String(request!.init!.body)),{expectedRevision:4})
  globalThis.fetch=async()=>Response.json({revision:4,editableCellsChecked:-1,sourceFreeEditsAuthorized:true,scope:'this-server'});await assert.rejects(workbookFormulaAudit(session,4,true,new AbortController().signal),/invalid audit result/)
  globalThis.fetch=async()=>Response.json({revision:5,editableCellsChecked:1,sourceFreeEditsAuthorized:false});await assert.rejects(workbookFormulaAudit(session,4,false,new AbortController().signal),/invalid audit result/)
 }finally{globalThis.fetch=old}
})
test('formula check rejects oversized and invalid responses while preserving server errors',async()=>{
 const old=globalThis.fetch
 try{globalThis.fetch=async()=>new Response('x'.repeat(65537));await assert.rejects(workbookFormulaAudit(session,0,false,new AbortController().signal),/invalid audit result/)
  globalThis.fetch=async()=>new Response(Uint8Array.of(255));await assert.rejects(workbookFormulaAudit(session,0,false,new AbortController().signal),/invalid audit result/)
  globalThis.fetch=async()=>Response.json({error:'XLSX_SOURCE_MISSING'},{status:404});await assert.rejects(workbookFormulaAudit(session,0,false,new AbortController().signal),error=>error instanceof ApiError&&error.code==='XLSX_SOURCE_MISSING')
 }finally{globalThis.fetch=old}
})
test('cancelling an ignored transport stops waiting for a protection response',async()=>{
 const old=globalThis.fetch,controller=new AbortController();let entered!:()=>void,release!:(value:Response)=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),late=new Promise<Response>(resolve=>{release=resolve})
 globalThis.fetch=async()=>{entered();return late}
 try{const work=workbookFormulaAudit(session,0,true,controller.signal);await started;controller.abort(new Error('cancelled'));await assert.rejects(work,/cancelled/);release(Response.json({revision:0,editableCellsChecked:0,sourceFreeEditsAuthorized:true,scope:'this-server'}))}finally{globalThis.fetch=old}
})
