import {test} from 'node:test'
import assert from 'node:assert/strict'
import {restoreWorkbookSource} from './workbookSourceRestore.ts'
import {ApiError,type Session} from './api.ts'

const session:Session={documentId:'doc',token:'test',scope:'write',format:'xlsx',apiUrl:'http://fixture'}
const file=new Blob(['original workbook'])

test('source restore validates the bounded server receipt and preserves explicit errors',async()=>{
 const previous=globalThis.fetch
 try{
  globalThis.fetch=async(_url,init)=>{assert.equal(init?.body,file);return Response.json({sourceRestored:true,alreadyPresent:false,revision:4})}
  assert.deepEqual(await restoreWorkbookSource(session,file,new AbortController().signal),{revision:4,alreadyPresent:false})
  globalThis.fetch=async()=>Response.json({sourceRestored:true,alreadyPresent:true,revision:-1})
  await assert.rejects(restoreWorkbookSource(session,file,new AbortController().signal),/invalid source receipt/)
  globalThis.fetch=async()=>new Response('x',{headers:{'content-length':'65537'}})
  await assert.rejects(restoreWorkbookSource(session,file,new AbortController().signal),/invalid source receipt/)
  globalThis.fetch=async()=>Response.json({error:'XLSX_SOURCE_CHANGED'},{status:422})
  await assert.rejects(restoreWorkbookSource(session,file,new AbortController().signal),error=>error instanceof ApiError&&error.code==='XLSX_SOURCE_CHANGED')
 }finally{globalThis.fetch=previous}
})

test('lost source restore response stops waiting; retry sends the same file and accepts already present',async()=>{
 const previous=globalThis.fetch,controller=new AbortController();let started!:()=>void,deliver!:(response:Response)=>void,cancelled=false,calls=0
 const entered=new Promise<void>(resolve=>{started=resolve})
 try{
  globalThis.fetch=async(_url,init)=>{assert.equal(init?.body,file);calls++;if(calls===1){started();return new Promise<Response>(resolve=>{deliver=resolve})}return Response.json({sourceRestored:true,alreadyPresent:true,revision:0})}
  const pending=restoreWorkbookSource(session,file,controller.signal);await entered;controller.abort(new Error('stop waiting'));await assert.rejects(pending,/stop waiting/)
  deliver(new Response(new ReadableStream({cancel(){cancelled=true}})));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true)
  assert.deepEqual(await restoreWorkbookSource(session,file,new AbortController().signal),{revision:0,alreadyPresent:true});assert.equal(calls,2)
 }finally{globalThis.fetch=previous}
})
