import test from 'node:test'
import assert from 'node:assert/strict'
import {parseSemanticRecoveryFileAsync} from './semanticRecoveryArchive.ts'
import {recoveryDigest} from './recoveryDigest.ts'

const packet=new TextEncoder().encode(JSON.stringify({schemaVersion:'hcd-semantic-recovery/1',scope:{documentId:'book',epoch:0,model:'structure3',revision:1,rootHash:'a'.repeat(64)},canonical:{},state:{},resources:[],pendingFiles:[]}))
const parsed=()=>JSON.parse(new TextDecoder().decode(packet))

test('file parsing sends an immutable Blob handle and never reads whole JSON on the caller thread',async()=>{
 const previous=globalThis.Worker,hash=await recoveryDigest(packet);let terminated=false,reads=0
 const file=new Blob([packet]);file.arrayBuffer=async()=>{reads++;throw Error('UI read forbidden')}
 class Worker{
  onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null
  postMessage(request:{file:Blob},transfer?:unknown){assert.equal(request.file,file);assert.equal(transfer,undefined);queueMicrotask(()=>this.onmessage?.({data:{ok:true,value:parsed(),packetHash:hash}}))}
  terminate(){terminated=true}
 }
 try{globalThis.Worker=Worker as unknown as typeof globalThis.Worker;const result=await parseSemanticRecoveryFileAsync(file,new AbortController().signal);assert.equal(result.scope.documentId,'book');assert.equal(result.packetHash,hash);assert.equal(reads,0);assert.equal(terminated,true)}finally{globalThis.Worker=previous}
})

test('worker absence or transport failure retains exact package digest via the existing parser',async()=>{
 const previous=globalThis.Worker,hash=await recoveryDigest(packet)
 class Failed{onmessage=null;onmessageerror=null;onerror:(()=>void)|null=null;postMessage(){queueMicrotask(()=>this.onerror?.())}terminate(){}}
 try{for(const worker of [undefined,Failed]){globalThis.Worker=worker as unknown as typeof globalThis.Worker;const result=await parseSemanticRecoveryFileAsync(new Blob([packet]),new AbortController().signal);assert.equal(result.scope.documentId,'book');assert.equal(result.packetHash,hash)}}finally{globalThis.Worker=previous}
})

test('file cancellation terminates pending work, ignores late results and never falls back to a UI read',async()=>{
 const previous=globalThis.Worker;let terminated=false,reads=0,complete!:()=>void
 const file=new Blob([packet]);file.arrayBuffer=async()=>{reads++;return packet.slice().buffer}
 class Worker{
  onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null
  postMessage(){complete=()=>this.onmessage?.({data:{ok:true,value:parsed(),packetHash:'a'.repeat(64)}})}
  terminate(){terminated=true}
 }
 try{globalThis.Worker=Worker as unknown as typeof globalThis.Worker;const controller=new AbortController(),pending=parseSemanticRecoveryFileAsync(file,controller.signal);controller.abort(Error('cancel file'));await assert.rejects(pending,/cancel file/);complete();await Promise.resolve();assert.equal(terminated,true);assert.equal(reads,0)}finally{globalThis.Worker=previous}
})

test('malformed worker package hashes or envelopes are rejected without a fallback',async()=>{
 const previous=globalThis.Worker;let reads=0
 const file=new Blob([packet]);file.arrayBuffer=async()=>{reads++;throw Error('must not retry invalid data')}
 try{for(const response of [{ok:true,value:parsed()},{ok:true,value:parsed(),packetHash:'invalid'},{ok:true,value:{schemaVersion:'unknown'},packetHash:'a'.repeat(64)}]){
  class Worker{onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null;postMessage(){queueMicrotask(()=>this.onmessage?.({data:response}))}terminate(){}}
  globalThis.Worker=Worker as unknown as typeof globalThis.Worker;await assert.rejects(parseSemanticRecoveryFileAsync(file,new AbortController().signal),/semantic-recovery-invalid/)
 }assert.equal(reads,0)}finally{globalThis.Worker=previous}
})

test('a valid file packet hash never bypasses independent canonical digest checks',async()=>{
 const previous=globalThis.Worker;let verified=false
 class Worker{
  onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null
  postMessage(){const value=parsed();value.canonical={byteLength:1,sha256:'a'.repeat(64),bytes:Uint8Array.of(1)};queueMicrotask(()=>this.onmessage?.({data:{ok:true,value,packetHash:'b'.repeat(64)}}))}
  terminate(){}
 }
 try{globalThis.Worker=Worker as unknown as typeof globalThis.Worker;const result=await parseSemanticRecoveryFileAsync(new Blob([packet]),new AbortController().signal);await assert.rejects(result.open({scope:result.scope,schema:{} as never,verifyCanonical:async()=>{verified=true}}),/semantic-recovery-integrity/);assert.equal(verified,false)}finally{globalThis.Worker=previous}
})
