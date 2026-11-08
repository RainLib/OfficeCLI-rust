import {test} from 'node:test'
import assert from 'node:assert/strict'
import {stageRecoveryResource,recoveryHash} from './semanticRecoveryTransfer.ts'
import {archiveNodeResource} from './api.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',format:'html',scope:'write',token:'owned',apiUrl:'https://owned.test/v1/documents'}
const bytes=new TextEncoder().encode('Verified recovery attachment 中文')
async function resource(){return{key:'file',hash:await recoveryHash(bytes),byteLength:bytes.length,name:'file.txt',mediaType:'text/plain'}}
test('repeated attachment recovery repins owned bytes without retransmitting the file',async()=>{
 const value=await resource(),old=globalThis.fetch;let pins=0,uploads=0
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/resources/reuse')){pins++;assert.deepEqual(JSON.parse(String(init?.body)),{hash:value.hash,extension:'bin',byteLength:value.byteLength});return Response.json({hash:value.hash,byteLength:value.byteLength})}uploads++;throw Error('unexpected upload')}
 try{for(let i=0;i<2;i++)await stageRecoveryResource(session,value,bytes,new AbortController().signal);assert.equal(pins,2);assert.equal(uploads,0)}finally{globalThis.fetch=old}
})
test('missing canonical bytes still stage a resource and validate the upload receipt',async()=>{
 const value=await resource(),old=globalThis.fetch;let posts=0
 globalThis.fetch=async(url,init)=>{if(String(url).includes('/assets/')||String(url).endsWith('/resources/reuse'))return new Response('missing',{status:404});posts++;assert.equal(init?.method,'POST');assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()),bytes);return Response.json({hash:value.hash,byteLength:value.byteLength})}
 try{await stageRecoveryResource(session,value,bytes,new AbortController().signal);assert.equal(posts,1)}finally{globalThis.fetch=old}
})
test('permission loss, corruption, abort and network failure do not bypass verification by uploading again',async()=>{
 const value=await resource(),old=globalThis.fetch
 try{
  for(const failure of [403,401,500,'corrupt','network'] as const){let uploads=0;globalThis.fetch=async(url)=>{if(!String(url).endsWith('/resources/reuse'))uploads++;if(failure==='network')throw Error('offline');return failure==='corrupt'?Response.json({hash:'f'.repeat(64),byteLength:value.byteLength}):new Response('denied',{status:failure})};await assert.rejects(stageRecoveryResource(session,value,bytes,new AbortController().signal));assert.equal(uploads,0)}
  let requests=0;globalThis.fetch=async()=>{requests++;throw Error('unexpected')};const abort=new AbortController();abort.abort();await assert.rejects(stageRecoveryResource(session,value,bytes,abort.signal));await assert.rejects(stageRecoveryResource(session,{...value,hash:'f'.repeat(64)},bytes,new AbortController().signal));assert.equal(requests,0)
 }finally{globalThis.fetch=old}
})

test('cancelling a delayed attachment read finishes promptly without a late archive request',async()=>{
 let release!:(value:ArrayBuffer)=>void,entered!:()=>void,requests=0
 const gate=new Promise<ArrayBuffer>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),old=globalThis.fetch
 class SlowBlob extends Blob {override arrayBuffer():Promise<ArrayBuffer>{entered();return gate}}
 const controller=new AbortController(),file=new SlowBlob([bytes],{type:'text/plain'})
 globalThis.fetch=async()=>{requests++;throw Error('unexpected request')}
 try{
  const work=archiveNodeResource(session,{file,name:'file.txt',key:'file',reuseExisting:true,signal:controller.signal})
  await started;controller.abort(new Error('cancelled while reading'))
  await assert.rejects(work,/cancelled while reading/)
  release(Uint8Array.from(bytes).buffer);await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(requests,0)
 }finally{release(Uint8Array.from(bytes).buffer);globalThis.fetch=old}
})
test('missing-resource fallback uploads the original snapshot if caller changes its buffer',async()=>{
 const source=Uint8Array.from(bytes),original=Uint8Array.from(source),value=await resource(),old=globalThis.fetch;let uploads=0
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/resources/reuse')){source.fill(0);return new Response('missing',{status:404})}uploads++;assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()),original);return Response.json({hash:value.hash,byteLength:value.byteLength})}
 try{await stageRecoveryResource(session,value,source,new AbortController().signal);assert.equal(uploads,1)}finally{globalThis.fetch=old}
})
test('stalled or oversized resource receipts stop without fallback upload',async()=>{
 const value=await resource(),old=globalThis.fetch;let cancelled=0,uploads=0,entered!:()=>void
 const started=new Promise<void>(resolve=>entered=resolve),controller=new AbortController()
 try{
  globalThis.fetch=async(url)=>{if(!String(url).endsWith('/resources/reuse'))uploads++;return new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('{'));entered()},cancel(){cancelled++}}))}
  const operation=stageRecoveryResource(session,value,bytes,controller.signal);await started;controller.abort(new Error('receipt cancelled'));await assert.rejects(operation,/receipt cancelled/);assert.equal(cancelled,1);assert.equal(uploads,0)
  globalThis.fetch=async(url)=>{if(!String(url).endsWith('/resources/reuse'))uploads++;return new Response('x'.repeat(64*1024+1))}
  await assert.rejects(stageRecoveryResource(session,value,bytes,new AbortController().signal),/nodeResourceIntegrity/);assert.equal(uploads,0)
 }finally{globalThis.fetch=old}
})
test('late response headers after cancellation are closed without upload',async()=>{
 const value=await resource(),old=globalThis.fetch,controller=new AbortController();let resolve!:(response:Response)=>void,entered!:()=>void,closed=0,requests=0
 const pending=new Promise<Response>(done=>resolve=done),started=new Promise<void>(done=>entered=done)
 globalThis.fetch=async()=>{requests++;entered();return pending}
 try{
  const operation=stageRecoveryResource(session,value,bytes,controller.signal);await started;controller.abort(new Error('request cancelled'));await assert.rejects(operation,/request cancelled/)
  resolve(new Response(new ReadableStream({cancel(){closed++}})));await new Promise(done=>setTimeout(done,0))
  assert.equal(requests,1);assert.equal(closed,1)
 }finally{globalThis.fetch=old}
})
