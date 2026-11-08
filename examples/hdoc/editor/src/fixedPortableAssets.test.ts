import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Session} from './api.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
import {fixedImageExtension,readFixedPortableAsset,repinFixedPortableAsset,stageFixedPortableAsset} from './fixedPortableAssets.ts'
const session:Session={documentId:'doc',token:'test',scope:'write',format:'pptx'}
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]),signal=()=>new AbortController().signal

test('capture falls back only on a missing staged asset and verifies content and limits',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png);let calls=0
 try{globalThis.fetch=async(_input,init)=>{assert.equal(init?.cache,'no-store');return ++calls===1?new Response('',{status:404}):new Response(png)};assert.deepEqual(await readFixedPortableAsset(session,hash,signal()),png);assert.equal(calls,2)
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]));await assert.rejects(readFixedPortableAsset(session,hash,signal()),/integrity/)
  globalThis.fetch=async()=>new Response(png,{headers:{'content-length':String(9*1024*1024)}});await assert.rejects(readFixedPortableAsset(session,hash,signal()),/limit/)
  calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:403})};await assert.rejects(readFixedPortableAsset(session,hash,signal()),/403/);assert.equal(calls,1)
 }finally{globalThis.fetch=old}
})
test('restore checks magic, hash and server receipt without submitting an edit',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png);let calls=0
 try{globalThis.fetch=async(input,init)=>{calls++;assert.match(String(input),/staged-assets\?extension=png$/);assert.equal(init?.method,'POST');return Response.json({hash,byteLength:png.length})};await stageFixedPortableAsset(session,hash,png,signal());assert.equal(calls,1)
  globalThis.fetch=async()=>Response.json({hash:'f'.repeat(64),byteLength:png.length});await assert.rejects(stageFixedPortableAsset(session,hash,png,signal()),/integrity/)
  await assert.rejects(stageFixedPortableAsset(session,hash,new Uint8Array([1]),signal()),/integrity/);assert.throws(()=>fixedImageExtension(new Uint8Array([1,2,3])),/type/)
 }finally{globalThis.fetch=old}
})
test('an aborted resource stream does not finish capture',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),controller=new AbortController();let reached!:()=>void;const started=new Promise<void>(resolve=>reached=resolve)
 try{globalThis.fetch=async()=>new Response(new ReadableStream({pull(){reached()},cancel(){}}));const pending=readFixedPortableAsset(session,hash,controller.signal);await started;controller.abort(new Error('cancelled'));await assert.rejects(pending,/cancelled/)}finally{globalThis.fetch=old}
})
test('fixed backup stops waiting for response headers when the transport ignores cancellation',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),controller=new AbortController();let calls=0,started!:()=>void
 const reached=new Promise<void>(resolve=>{started=resolve})
 try{globalThis.fetch=async()=>{calls++;started();return new Promise<Response>(()=>{})};const pending=readFixedPortableAsset(session,hash,controller.signal);await reached;controller.abort(new Error('cancel headers'));await assert.rejects(pending,/cancel headers/);assert.equal(calls,1)}finally{globalThis.fetch=old}
})
test('fixed portable asset capture stops a stalled response at its deadline',async context=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),deadline=new AbortController();let cancelled=false,started!:()=>void
 const reached=new Promise<void>(resolve=>{started=resolve})
 context.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,45_000);return deadline.signal})
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(){started()},cancel(){cancelled=true}}))
  const pending=readFixedPortableAsset(session,hash,signal());await reached;deadline.abort(new Error('backup deadline'))
  await assert.rejects(pending,/backup deadline/);assert.equal(cancelled,true)
 }finally{globalThis.fetch=old}
})
test('fixed recovery rejects an oversized response while cancellation is stalled',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png);let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;return new Promise<void>(()=>{})}}),{headers:{'content-length':String(9*1024*1024)}})
  await assert.rejects(Promise.race([readFixedPortableAsset(session,hash,signal()),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup blocked')),500)})]),/fixed-portable-limit/)
  assert.equal(cancelled,true)
  globalThis.fetch=async()=>new Response(png,{headers:{'content-length':String(png.length+1)}})
  await assert.rejects(readFixedPortableAsset(session,hash,signal()),/fixed-portable-resource/)
 }finally{clearTimeout(timer);globalThis.fetch=old}
})
test('recovery re-pins existing bytes, falls back only for 404, and refuses untrusted receipts',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),calls:string[]=[]
 try{
  globalThis.fetch=async(input,init)=>{calls.push(String(input));assert.equal(init?.method,'POST');return Response.json({hash,byteLength:png.length})}
  await repinFixedPortableAsset(session,hash,png,signal());assert.equal(calls.length,1);assert.match(calls[0],/resources\/reuse$/)
  calls.length=0;globalThis.fetch=async(input)=>{calls.push(String(input));return calls.length===1?new Response('',{status:404}):Response.json({hash,byteLength:png.length})}
  await repinFixedPortableAsset(session,hash,png,signal());assert.equal(calls.length,2);assert.match(calls[1],/staged-assets\?extension=png$/)
  calls.length=0;globalThis.fetch=async(input)=>{calls.push(String(input));return new Response('',{status:403})};await assert.rejects(repinFixedPortableAsset(session,hash,png,signal()),/403/);assert.equal(calls.length,1)
  globalThis.fetch=async()=>Response.json({hash:'f'.repeat(64),byteLength:png.length});await assert.rejects(repinFixedPortableAsset(session,hash,png,signal()),/integrity/)
  await assert.rejects(repinFixedPortableAsset(session,hash,new Uint8Array([1]),signal()),/integrity/)
 }finally{globalThis.fetch=old}
})
test('only a definite resource lock conflict retries, and cancellation stops the retry',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png);let attempts=0
 try{
  globalThis.fetch=async()=>++attempts===1?Response.json({error:'HCD_RESOURCE_BUSY'},{status:409}):Response.json({hash,byteLength:png.length})
  await repinFixedPortableAsset(session,hash,png,signal());assert.equal(attempts,2)
  attempts=0;globalThis.fetch=async()=>{attempts++;return Response.json({error:'OTHER_CONFLICT'},{status:409})};await assert.rejects(repinFixedPortableAsset(session,hash,png,signal()),/409/);assert.equal(attempts,1)
  attempts=0;const controller=new AbortController();globalThis.fetch=async()=>{attempts++;controller.abort(new Error('stop'));return Response.json({error:'HCD_RESOURCE_BUSY'},{status:409})};await assert.rejects(repinFixedPortableAsset(session,hash,png,controller.signal),/stop/);assert.equal(attempts,1)
 }finally{globalThis.fetch=old}
})
test('cancelled staging stops waiting for an uncooperative transport and closes its late response',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),controller=new AbortController();let started!:()=>void,deliver!:(response:Response)=>void,cancelled=false,calls=0
 const reached=new Promise<void>(resolve=>{started=resolve})
 try{
  globalThis.fetch=async()=>{calls++;started();return new Promise<Response>(resolve=>{deliver=resolve})}
  const work=stageFixedPortableAsset(session,hash,png,controller.signal);await reached;controller.abort(new Error('stop staging'));await assert.rejects(work,/stop staging/)
  deliver(new Response(new ReadableStream({cancel(){cancelled=true}})));await new Promise<void>(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true);assert.equal(calls,1)
 }finally{globalThis.fetch=old}
})
test('staging enforces its own deadline even without caller cancellation',async context=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),deadline=new AbortController();let started!:()=>void
 const reached=new Promise<void>(resolve=>{started=resolve})
 context.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,45_000);return deadline.signal})
 try{globalThis.fetch=async()=>{started();return new Promise<Response>(()=>{})};const work=stageFixedPortableAsset(session,hash,png,signal());await reached;deadline.abort(new Error('stage deadline'));await assert.rejects(work,/stage deadline/)}finally{globalThis.fetch=old}
})
test('re-pin receipt is bounded and cancellation during receipt does not trigger upload fallback',async()=>{
 const old=globalThis.fetch,hash=await fixedImageHash(png),controller=new AbortController();let started!:()=>void,cancelled=false,calls=0
 const reached=new Promise<void>(resolve=>{started=resolve})
 try{
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({pull(){started()},cancel(){cancelled=true}}))}
  const work=repinFixedPortableAsset(session,hash,png,controller.signal);await reached;controller.abort(new Error('stop receipt'));await assert.rejects(work,/stop receipt/);assert.equal(cancelled,true);assert.equal(calls,1)
  globalThis.fetch=async()=>new Response('{}',{headers:{'content-length':String(65537)}})
  await assert.rejects(repinFixedPortableAsset(session,hash,png,signal()),/fixed-portable-integrity/)
 }finally{globalThis.fetch=old}
})
