import assert from 'node:assert/strict'
import {test} from 'node:test'
import {LiveAccess} from './liveAccess.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'private',scope:'write',format:'pptx'}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
test('write revocation latches and a later grant cannot replay this editor',async()=>{
 const previous=globalThis.fetch
 let calls=0
 globalThis.fetch=async()=>{calls++;return Response.json({scope:'read',access:'revoked'})}
 const monitor=new LiveAccess(session)
 try{await monitor.refresh();assert.equal(monitor.snapshot(),'revoked');await monitor.refresh();assert.equal(calls,1)}finally{monitor.dispose();globalThis.fetch=previous}
})
test('temporary authority failure preserves local editing and can recover',async()=>{
 const previous=globalThis.fetch
 let status=503
 globalThis.fetch=async()=>status===503?new Response('',{status}):Response.json({scope:'write'})
 const monitor=new LiveAccess(session)
 try{await monitor.refresh();assert.equal(monitor.snapshot(),'unavailable');status=200;await monitor.refresh();assert.equal(monitor.snapshot(),'write')}finally{monitor.dispose();globalThis.fetch=previous}
})
test('effect restart ignores a stale request and retains active subscribers',async()=>{
 const previous=globalThis.fetch
 const pending:Array<(response:Response)=>void>=[]
 globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve))
 const monitor=new LiveAccess(session,60_000)
 let events=0;monitor.subscribe(()=>events++)
 try{
  const first=monitor.start();await tick();first();const second=monitor.start();await tick()
  assert.equal(pending.length,2)
  pending[0](Response.json({scope:'read',access:'revoked'}));await tick();assert.equal(monitor.snapshot(),'write')
  pending[1](new Response('',{status:403}));await tick();assert.equal(monitor.snapshot(),'revoked');assert.equal(events,1)
  first();assert.equal(monitor.snapshot(),'revoked');second()
 }finally{monitor.dispose();globalThis.fetch=previous}
})

test('revoked fixed-layout sessions resolve pending receipts without replaying a missing edit',async()=>{
 const {FixedSaveController}=await import('./fixedSaveController.ts')
 const {TextDraftStore}=await import('./textDrafts.ts')
 const {ImageDraftStore}=await import('./imageDrafts.ts')
 const {captureFixedEdits}=await import('./saveEdits.ts')
 const texts=new TextDraftStore(),images=new ImageDraftStore()
 texts.edit({nodeId:'text',text:'Original',nodeHash:'a'.repeat(64)},0,'Local draft',0)
 const attempt=captureFixedEdits(0,texts,images)!
 const previous=globalThis.fetch;const routes:string[]=[]
 globalThis.fetch=async(url)=>{routes.push(String(url));return Response.json({patchId:attempt.id,status:'missing'})}
 const controller=new FixedSaveController({...session,scope:'read'},texts,images,null,attempt)
 try{
  await assert.rejects(controller.save(0),/accessRevoked/)
  assert.equal(controller.pending,true);assert.equal(texts.get('text')?.text,'Local draft')
  assert.equal(routes.length,1);assert.ok(routes[0].endsWith('/edits/receipt'))
 }finally{controller.dispose();globalThis.fetch=previous}
})


test('a late successful or failed concurrent check cannot reopen a revoked editor',async()=>{
 const previous=globalThis.fetch
 try{for(const late of [Response.json({scope:'write'}),new Response('',{status:503})]){
  const pending:Array<(response:Response)=>void>=[];globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve))
  const monitor=new LiveAccess(session)
  try{const old=monitor.refresh(),current=monitor.refresh();await tick();assert.equal(pending.length,2)
   pending[1](new Response('',{status:403}));await current;assert.equal(monitor.snapshot(),'revoked')
   pending[0](late);await old;assert.equal(monitor.snapshot(),'revoked')
   await monitor.refresh();assert.equal(pending.length,2)
  }finally{monitor.dispose()}
 }}finally{globalThis.fetch=previous}
})

test('oversized or malformed authority responses do not grant access',async()=>{
 const previous=globalThis.fetch,monitor=new LiveAccess(session)
 try{for(const response of [new Response('{}',{headers:{'content-length':'65537'}}),Response.json({scope:'unknown'}),new Response(Uint8Array.of(255))]){
  globalThis.fetch=async()=>response;await monitor.refresh();assert.equal(monitor.snapshot(),'unavailable')
 }}finally{monitor.dispose();globalThis.fetch=previous}
})

test('disposing a stalled authority request stops waiting and discards its late response',async()=>{
 const previous=globalThis.fetch,monitor=new LiveAccess(session);let deliver!:(response:Response)=>void,cancelled=false
 globalThis.fetch=()=>new Promise(resolve=>{deliver=resolve})
 try{const pending=monitor.refresh();await tick();monitor.dispose();await pending
  deliver(new Response(new ReadableStream({cancel(){cancelled=true}})));await tick();assert.equal(cancelled,true);assert.equal(monitor.snapshot(),'write')
 }finally{monitor.dispose();globalThis.fetch=previous}
})
