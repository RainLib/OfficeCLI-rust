import {test} from 'node:test'
import assert from 'node:assert/strict'
import {awaitRecoveryPreparation,awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

test('cancelled local recovery preparation rejects without waiting for the late result',async()=>{
 let complete!:(value:ArrayBuffer)=>void,started=false,continued=false
 const pendingBytes=new Promise<ArrayBuffer>(resolve=>complete=resolve),controller=new AbortController()
 const work=(async()=>{await awaitRecoveryPreparation(()=>{started=true;return pendingBytes},controller.signal);controller.signal.throwIfAborted();continued=true})()
 await Promise.resolve();assert.equal(started,true);controller.abort(new Error('cancelled read'))
 await assert.rejects(work,/cancelled read/);complete(new ArrayBuffer(1));await Promise.resolve();assert.equal(continued,false)
})

test('cancelled response-header wait closes a late response and never starts an already cancelled read',async()=>{
 const controller=new AbortController();let deliver!:(response:Response)=>void,cancelled=false
 const request=new Promise<Response>(resolve=>{deliver=resolve}),pending=awaitRecoveryResponse(()=>request,controller.signal)
 await Promise.resolve();controller.abort(new Error('stop waiting'))
 await assert.rejects(pending,/stop waiting/)
 deliver(new Response(new ReadableStream({cancel(){cancelled=true}})))
 await new Promise<void>(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true)
 let started=false
 await assert.rejects(awaitRecoveryResponse(async()=>{started=true;return new Response()},controller.signal),/stop waiting/)
 assert.equal(started,false)
})

test('recovery response checks declared and streamed size before retaining more bytes',async()=>{
 const signal=new AbortController().signal
 assert.deepEqual(await readBoundedResponse(new Response(Uint8Array.of(1,2,3)),3,signal),Uint8Array.of(1,2,3))
 let cancelled=false
 const tooLarge=new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.of(1,2));c.enqueue(Uint8Array.of(3,4))},cancel(){cancelled=true}}))
 await assert.rejects(readBoundedResponse(tooLarge,3,signal),/semantic-recovery-limit/);assert.equal(cancelled,true)
 let headerCancelled=false
 const declared=new Response(new ReadableStream({cancel(){headerCancelled=true}}),{headers:{'content-length':'4'}})
 await assert.rejects(readBoundedResponse(declared,3,signal),/semantic-recovery-limit/);assert.equal(headerCancelled,true)
})

test('aborting a stalled recovery response cancels its stream',async()=>{
 let cancelled=false
 const controller=new AbortController(),response=new Response(new ReadableStream({cancel(){cancelled=true}}))
 const pending=readBoundedResponse(response,3,controller.signal);controller.abort(new Error('stop'))
 await assert.rejects(pending,/stop/);assert.equal(cancelled,true)
})

test('oversized responses fail even if transport cancellation never settles',async()=>{
 let cancelled=false
 const response=new Response(new ReadableStream({cancel(){cancelled=true;return new Promise<void>(()=>{})}}),{headers:{'content-length':'4'}})
 let timer:ReturnType<typeof setTimeout>|undefined
 try{
  const result=readBoundedResponse(response,3,new AbortController().signal)
  await assert.rejects(Promise.race([result,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup blocked')),500)})]),/semantic-recovery-limit/)
  assert.equal(cancelled,true)
 }finally{clearTimeout(timer)}
})
