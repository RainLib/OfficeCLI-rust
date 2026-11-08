import test from 'node:test'
import assert from 'node:assert/strict'
import {parseSemanticRecoveryArchiveAsync} from './semanticRecoveryArchive.ts'

const packet=new TextEncoder().encode(JSON.stringify({schemaVersion:'hcd-semantic-recovery/1',scope:{documentId:'book',epoch:0,model:'structure3',revision:1,rootHash:'a'.repeat(64)},canonical:{},state:{},resources:[],pendingFiles:[]}))

test('worker parsing uses an independent transferred copy and validates its result',async()=>{
 const previous=globalThis.Worker;let terminated=false
 class FakeWorker{
  onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null
  postMessage(buffer:ArrayBuffer){const transferred=structuredClone(buffer,{transfer:[buffer]});queueMicrotask(()=>this.onmessage?.({data:{ok:true,value:JSON.parse(new TextDecoder().decode(transferred))}}))}
  terminate(){terminated=true}
 }
 try{globalThis.Worker=FakeWorker as unknown as typeof Worker;const input=Uint8Array.from(packet),result=await parseSemanticRecoveryArchiveAsync(input,new AbortController().signal);assert.equal(result.scope.documentId,'book');assert.deepEqual(input,packet);assert.equal(terminated,true)}finally{globalThis.Worker=previous}
})

test('aborting a stalled parse terminates the worker without publishing a result',async()=>{
 const previous=globalThis.Worker;let terminated=false
 class FakeWorker{onmessage=null;onerror=null;onmessageerror=null;postMessage(){}terminate(){terminated=true}}
 try{globalThis.Worker=FakeWorker as unknown as typeof Worker;const controller=new AbortController(),promise=parseSemanticRecoveryArchiveAsync(packet,controller.signal);controller.abort(new Error('cancelled'));await assert.rejects(promise,/cancelled/);assert.equal(terminated,true)}finally{globalThis.Worker=previous}
})

test('worker startup failures fall back while invalid parsed data stays rejected',async()=>{
 const previous=globalThis.Worker
 class FailedWorker{onmessage=null;onmessageerror=null;onerror:(()=>void)|null=null;postMessage(){queueMicrotask(()=>this.onerror?.())}terminate(){}}
 class TransferFailedWorker{onmessage=null;onmessageerror=null;onerror=null;postMessage(){throw Error('transfer unavailable')}terminate(){}}
 class InvalidWorker{onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null;postMessage(){queueMicrotask(()=>this.onmessage?.({data:{ok:true,value:{schemaVersion:'bad'}}}))}terminate(){}}
 try{for(const worker of [FailedWorker,TransferFailedWorker]){globalThis.Worker=worker as unknown as typeof Worker;assert.equal((await parseSemanticRecoveryArchiveAsync(packet,new AbortController().signal)).scope.documentId,'book')}globalThis.Worker=InvalidWorker as unknown as typeof Worker;await assert.rejects(parseSemanticRecoveryArchiveAsync(packet,new AbortController().signal),/semantic-recovery-invalid/)}finally{globalThis.Worker=previous}
})

test('transferred bytes still require an independent digest before verification',async()=>{
 const previous=globalThis.Worker;let verified=false
 class FakeWorker{onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null;postMessage(buffer:ArrayBuffer){const value=JSON.parse(new TextDecoder().decode(buffer));value.canonical={byteLength:1,sha256:'a'.repeat(64),bytes:Uint8Array.of(1)};queueMicrotask(()=>this.onmessage?.({data:{ok:true,value}}))}terminate(){}}
 try{globalThis.Worker=FakeWorker as unknown as typeof Worker;const parsed=await parseSemanticRecoveryArchiveAsync(packet,new AbortController().signal);await assert.rejects(parsed.open({scope:parsed.scope,schema:{} as never,verifyCanonical:async()=>{verified=true}}),/semantic-recovery-integrity/);assert.equal(verified,false)}finally{globalThis.Worker=previous}
})
