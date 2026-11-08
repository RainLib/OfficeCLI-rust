import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {splitWordRecoveryUpdate,WordRecoveryChunkAssembly,wordRecoveryChunkBytes,wordRecoveryMaxBytes} from './wordRecoveryChunks.ts'

test('large Yjs recovery reassembles exactly before a single application',async()=>{
 const source=new Y.Doc(),target=new Y.Doc();try{
  source.getText('body').insert(0,'恢复😀'.repeat(150000));const update=Y.encodeStateAsUpdate(source),packet=await splitWordRecoveryUpdate(update),assembly=new WordRecoveryChunkAssembly(packet.manifest)
  assert.ok(update.length>1024*1024);for(let i=packet.chunks.length-1;i>=0;i--)assert.equal(assembly.add(i,packet.chunks[i]),true)
  const combined=await assembly.finish();assert.deepEqual(combined,update);let events=0;target.on('update',()=>events++);Y.applyUpdate(target,combined);assert.equal(events,1);assert.equal(target.getText('body').toString(),source.getText('body').toString())
 }finally{source.destroy();target.destroy()}
})
test('incomplete, corrupt, duplicate and malformed chunks do not produce an update',async()=>{
 const data=Uint8Array.from({length:wordRecoveryChunkBytes+7},(_,i)=>i%251),packet=await splitWordRecoveryUpdate(data),assembly=new WordRecoveryChunkAssembly(packet.manifest)
 assert.equal(assembly.add(0,packet.chunks[0]),true);assert.equal(assembly.add(0,packet.chunks[0]),false);const changed=packet.chunks[0].slice();changed[3]^=1;assert.throws(()=>assembly.add(0,changed),/conflict/);await assert.rejects(assembly.finish(),/incomplete/)
 assert.throws(()=>assembly.add(1,new Uint8Array(8)),/invalid/);const last=packet.chunks[1].slice();last[0]^=1;assembly.add(1,last);await assert.rejects(assembly.finish(),/integrity/)
 assert.throws(()=>new WordRecoveryChunkAssembly({...packet.manifest,chunks:99}),/invalid/);await assert.rejects(splitWordRecoveryUpdate(new Uint8Array(wordRecoveryMaxBytes+1)),/limit/)
})
test('caller mutation and cancellation during verification cannot publish data',async()=>{
 const source=Uint8Array.of(1,2,3),packet=await splitWordRecoveryUpdate(source),assembly=new WordRecoveryChunkAssembly(packet.manifest),piece=packet.chunks[0];assembly.add(0,piece);piece[0]=9;assert.deepEqual(await assembly.finish(),Uint8Array.of(1,2,3))
 const next=new WordRecoveryChunkAssembly(packet.manifest);next.add(0,Uint8Array.of(1,2,3));const original=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{reached=resolve})
 try{crypto.subtle.digest=async(...args)=>{reached();await gate;return original(...args)};const work=next.finish();await started;next.cancel();release();await assert.rejects(work,/closed/)}finally{release();crypto.subtle.digest=original}
})
