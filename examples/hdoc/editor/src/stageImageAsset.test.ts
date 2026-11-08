import {test} from 'node:test'
import assert from 'node:assert/strict'
import {stageImageAsset,type Session} from './api.ts'

const session:Session={documentId:'doc',token:'test',scope:'write',format:'docx',apiUrl:'http://fixture'}
const hash='a'.repeat(64)

test('image staging retries only an explicit resource lock rejection with the same bytes',async()=>{
 const original=globalThis.fetch;let calls=0
 try{
  globalThis.fetch=async(_url,init)=>{calls++;assert.equal(await (init!.body as Blob).text(),'image');return calls===1?Response.json({error:'HCD_RESOURCE_BUSY'},{status:409}):Response.json({hash})}
  assert.deepEqual(await stageImageAsset(session,'png',new Blob(['image'])),{hash});assert.equal(calls,2)
  calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'OTHER_CONFLICT'},{status:409})}
  await assert.rejects(stageImageAsset(session,'png',new Blob(['image'])),/409/);assert.equal(calls,1)
 }finally{globalThis.fetch=original}
})

test('image staging ignores a successful response arriving after cancellation',async()=>{
 const original=globalThis.fetch,controller=new AbortController()
 try{
  globalThis.fetch=async()=>{controller.abort(new Error('cancelled'));return Response.json({hash})}
  await assert.rejects(stageImageAsset(session,'png',new Blob(['image']),controller.signal),/cancelled/)
 }finally{globalThis.fetch=original}
})

test('image staging stops waiting for uncooperative response headers and closes a late response',async()=>{
 const original=globalThis.fetch,controller=new AbortController();let deliver!:(response:Response)=>void,entered!:()=>void,cancelled=false,calls=0
 const started=new Promise<void>(resolve=>{entered=resolve})
 try{
  globalThis.fetch=async()=>{calls++;entered();return new Promise<Response>(resolve=>{deliver=resolve})}
  const pending=stageImageAsset(session,'png',new Blob(['image']),controller.signal);await started;controller.abort(new Error('stop headers'))
  await assert.rejects(pending,/stop headers/);deliver(new Response(new ReadableStream({cancel(){cancelled=true}})));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true);assert.equal(calls,1)
 }finally{globalThis.fetch=original}
})

test('image staging bounds and cancels a stalled receipt',async()=>{
 const original=globalThis.fetch,controller=new AbortController();let started!:()=>void,cancelled=false
 const entered=new Promise<void>(resolve=>{started=resolve})
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(){started()},cancel(){cancelled=true}}))
  const pending=stageImageAsset(session,'png',new Blob(['image']),controller.signal);await entered;controller.abort(new Error('stop receipt'));await assert.rejects(pending,/stop receipt/);assert.equal(cancelled,true)
  globalThis.fetch=async()=>new Response('x',{headers:{'content-length':String(65537)}});await assert.rejects(stageImageAsset(session,'png',new Blob(['image'])),/nodeResourceIntegrity/)
  globalThis.fetch=async()=>Response.json({hash:'invalid'});await assert.rejects(stageImageAsset(session,'png',new Blob(['image'])),/nodeResourceIntegrity/)
 }finally{globalThis.fetch=original}
})

test('a retry re-pins an image accepted before its response was lost',async()=>{
 const original=globalThis.fetch,controller=new AbortController();let staged=false,uploads=0,reuses=0,entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),body=new Blob(['image'])
 try{
  globalThis.fetch=async(input,init)=>{
   if(String(input).endsWith('/resources/reuse')){reuses++;const request=JSON.parse(init!.body as string);assert.deepEqual(request,{hash,extension:'png',byteLength:body.size});return staged?Response.json({hash,byteLength:body.size}):new Response('missing',{status:404})}
   uploads++;staged=true;entered();return new Promise<Response>(()=>{})
  }
  const first=stageImageAsset(session,'png',body,controller.signal,hash);await started;controller.abort(new Error('lost response'));await assert.rejects(first,/lost response/)
  assert.deepEqual(await stageImageAsset(session,'png',body,undefined,hash),{hash});assert.equal(uploads,1);assert.equal(reuses,2)
  globalThis.fetch=async()=>Response.json({hash,byteLength:body.size+1});await assert.rejects(stageImageAsset(session,'png',body,undefined,hash),/nodeResourceIntegrity/)
  globalThis.fetch=async()=>new Response('denied',{status:403});await assert.rejects(stageImageAsset(session,'png',body,undefined,hash),/403/)
 }finally{globalThis.fetch=original}
})
