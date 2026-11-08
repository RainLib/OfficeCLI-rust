import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captureLegacyRecovery,legacyRecoveryBackup} from './legacyRecoveryBackup.ts'
import {nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import * as Y from 'yjs'

test('legacy backup retains exact document and verified pending attachment bytes',async()=>{
 const state=Uint8Array.of(1,2,3),bytes=new TextEncoder().encode('attachment 😀'),hash=await nodeResourceHash(bytes)
 const file:WordNodeResourceDraft={version:1,id:'00000000-0000-4000-8000-000000000001',regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:bytes.length,name:'file.txt',mediaType:'text/plain'},bytes}
 const work=legacyRecoveryBackup('doc',2,state,[file]);state.fill(0);bytes.fill(0);file.resource.name='changed.txt'
 const backup=await work;assert.deepEqual(Uint8Array.from(Buffer.from(backup.crdt,'base64')),Uint8Array.of(1,2,3));assert.equal(backup.nodeResources![0].resource.name,'file.txt');assert.equal(await nodeResourceHash(Uint8Array.from(backup.nodeResources![0].bytes)),hash)
})
test('legacy backup refuses a corrupted or completed attachment rather than downloading a misleading copy',async()=>{
 const bytes=Uint8Array.of(1,2,3),hash=await nodeResourceHash(bytes),file:WordNodeResourceDraft={version:1,id:'00000000-0000-4000-8000-000000000001',regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:3,name:'file.bin',mediaType:'application/octet-stream'},bytes}
 await assert.rejects(legacyRecoveryBackup('doc',0,Uint8Array.of(1),[{...file,bytes:Uint8Array.of(3,2,1)}]),/integrity/)
 await assert.rejects(legacyRecoveryBackup('doc',0,Uint8Array.of(1),[{...file,phase:'linked'}]),/integrity/)
 const plain=await legacyRecoveryBackup('doc',0,Uint8Array.of(1),[]);assert.equal(plain.nodeResources,undefined)
})
test('capture retries if document or pending attachment changes during collection',async()=>{
 const doc=new Y.Doc(),data=Uint8Array.of(1,2,3),hash=await nodeResourceHash(data),file:WordNodeResourceDraft={version:1,id:'00000000-0000-4000-8000-000000000001',regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:3,name:'file.bin',mediaType:'application/octet-stream'},bytes:data}
 let reads=0
 try{doc.getText('body').insert(0,'before');const snapshot=await captureLegacyRecovery(doc,async()=>{reads++;if(reads===1)doc.getText('body').insert(6,' after');return reads===1?[]:[structuredClone(file)]},new AbortController().signal);assert.equal(reads,4);assert.equal(snapshot.files.length,1);const restored=new Y.Doc();try{Y.applyUpdate(restored,snapshot.state);assert.equal(restored.getText('body').toString(),'before after')}finally{restored.destroy()}}finally{doc.destroy()}
})
test('capture rejects continuously changing state and respects cancellation',async()=>{
 const doc=new Y.Doc(),controller=new AbortController();let reads=0
 try{await assert.rejects(captureLegacyRecovery(doc,async()=>{doc.getText('body').insert(0,'x');reads++;return []},controller.signal),/legacy-recovery-changed/);assert.equal(reads,6)
  controller.abort(Error('cancelled'));await assert.rejects(captureLegacyRecovery(doc,async()=>assert.fail('no read'),controller.signal),/cancelled/)
 }finally{doc.destroy()}
})
test('cancelled capture releases a stalled read and never starts another read',async()=>{
 const doc=new Y.Doc(),controller=new AbortController();let reads=0,release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 try{const work=captureLegacyRecovery(doc,async()=>{reads++;entered();await gate;return []},controller.signal);await started;controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(reads,1)}finally{release();doc.destroy()}
})
test('cancelling a stalled attachment hash does not produce a legacy backup',async()=>{
 const bytes=Uint8Array.of(1,2,3),hash=await nodeResourceHash(bytes),file:WordNodeResourceDraft={version:1,id:'00000000-0000-4000-8000-000000000001',regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:3,name:'file.bin',mediaType:'application/octet-stream'},bytes}
 const subtle=crypto.subtle,original=subtle.digest.bind(subtle),controller=new AbortController();let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{entered();await gate;return original(...args)}})
 try{const work=legacyRecoveryBackup('doc',0,Uint8Array.of(1),[file],controller.signal);await held;controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(file.bytes,bytes)}finally{release();delete (subtle as unknown as {digest?:unknown}).digest}
})
