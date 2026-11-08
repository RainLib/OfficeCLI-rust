import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {NodeResourceJournal} from './nodeResourceJournal.ts'
import {nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
const node:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:'x_'+'a'.repeat(32),type:'test.resource',version:1,display:'inline',data:{label:'Title'},fallback:{text:'Title'}}
async function choice():Promise<WordNodeResourceDraft>{const bytes=new Uint8Array([1,2,3]);return{version:1,id:crypto.randomUUID(),regionId:'body',expected:node,resource:{key:'file',name:'data.bin',mediaType:'application/octet-stream',byteLength:3,hash:await nodeResourceHash(bytes)},bytes,phase:'chosen'}}
const contexts=[{name:'semantic',open:()=>NodeResourceJournal.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-2-structure3-nodefiles1',new IDBFactory())},{name:'inline',open:()=>NodeResourceJournal.openInline('hcd-local-draft-v1-'+'b'.repeat(64)+'-2-inlinecontainers1-nodefiles1',new IDBFactory())}]
for(const context of contexts){
 test(context.name+' import rejects incoming bytes whose length matches but digest does not',async()=>{
  const journal=await context.open(),draft=await choice();try{await assert.rejects(journal.importNodeResources([{...draft,bytes:new Uint8Array([4,5,6])}]),/integrity/);assert.deepEqual(await journal.pendingNodeResources(),[])}finally{await journal.close()}
 })
 test(context.name+' repeated recovery cannot silently accept corrupt existing file bytes',async()=>{
  const journal=await context.open(),draft=await choice(),fresh=await choice(),corrupt={...draft,bytes:new Uint8Array([4,5,6])}
  try{await journal.putNodeResource(corrupt);await assert.rejects(journal.importNodeResources([fresh,draft]),/integrity/);assert.deepEqual(await journal.pendingNodeResources(),[corrupt])}finally{await journal.close()}
 })
 test(context.name+' valid imports deduplicate and terminal choices do not revive',async()=>{
  const journal=await context.open(),draft=await choice()
  try{assert.equal(await journal.importNodeResources([draft]),1);assert.equal(await journal.importNodeResources([draft]),0);await journal.finishNodeResource(draft.id,'cancelled');assert.equal(await journal.importNodeResources([draft]),0);assert.deepEqual(await journal.pendingNodeResources(),[])}finally{await journal.close()}
 })
}
test('import captures ordinary bytes and metadata before waiting for their digest',async()=>{
 const journal=await contexts[0].open(),draft=await choice(),shared=new Uint8Array(new SharedArrayBuffer(5));shared.set([9,1,2,3,8]);draft.bytes=shared.subarray(1,4);draft.expected=structuredClone(draft.expected)
 const expected=structuredClone({...draft,bytes:new Uint8Array([1,2,3])}),digest=crypto.subtle.digest.bind(crypto.subtle);let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 crypto.subtle.digest=async(...args)=>{const result=await digest(...args);entered();await wait;return result}
 try{const importing=journal.importNodeResources([draft]);await started;shared.fill(0);draft.resource.name='changed.bin';draft.expected.data.label='Changed';release();assert.equal(await importing,1);assert.deepEqual(await journal.pendingNodeResources(),[expected])}finally{release();crypto.subtle.digest=digest;await journal.close()}
})
test('a cancellation committed while import hashing waits wins over the recovered file',async()=>{
 const journal=await contexts[0].open(),draft=await choice();await journal.putNodeResource(draft)
 const digest=crypto.subtle.digest.bind(crypto.subtle);let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 crypto.subtle.digest=async(...args)=>{const result=await digest(...args);entered();await wait;return result}
 try{const importing=journal.importNodeResources([draft]);await started;await journal.finishNodeResource(draft.id,'cancelled');release();assert.equal(await importing,0);assert.deepEqual(await journal.pendingNodeResources(),[])}finally{release();crypto.subtle.digest=digest;await journal.close()}
})
