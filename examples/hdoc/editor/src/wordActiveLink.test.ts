import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WordActiveLink,readActiveLinkPending} from './wordActiveLink.ts'
import type {WordActiveTopologyContext} from './wordActiveTopology.ts'
import {wordLinkFixture} from './wordLinkTestFixture.ts'
test('link parsing pins the authenticated member and canonicalizes reordered HTTP keys',async()=>{
 const f=await wordLinkFixture();try{
  const member={...f.pending.actor,scope:'write' as const},pending=readActiveLinkPending(f.pending,'doc',member),reordered=JSON.parse(JSON.stringify(f.pending,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v))
  assert.equal(JSON.stringify(readActiveLinkPending(reordered,'doc',member)),JSON.stringify(pending))
  assert.throws(()=>readActiveLinkPending(f.pending,'other',member),/invalid/)
  assert.throws(()=>readActiveLinkPending(f.pending,'doc',{...member,scope:'read'}),/unauthorized/)
  assert.throws(()=>readActiveLinkPending({...f.pending,actor:{...f.pending.actor,generation:2}},'doc',member),/invalid/)
 }finally{await f.close()}
})
test('link retries resume installation with their exact review and retain an independent status schema',async()=>{
 const f=await wordLinkFixture();try{
  const active=new WordActiveLink(),member={...f.pending.actor,scope:'write' as const},pending={...f.pending,activeReviewHash:'a'.repeat(64)},calls:string[]=[];let held=false,attempts=0
  const context:WordActiveTopologyContext={held:()=>held,prepare:async()=>{calls.push('prepare')},transition:async()=>{held=true;calls.push('native')},promote:async()=>{calls.push('promote')},retire:async()=>{calls.push('retire')},isRetired:()=>calls.includes('retire'),install:async()=>{if(++attempts===1)throw Error('install-unknown');held=false},activate:()=>{calls.push('activate')},release:()=>{calls.push('release')}}
  await assert.rejects(active.run(pending,async()=>member,()=>context,1),/install-unknown/)
  assert.equal(active.status('doc',1,pending.request.transactionId).schemaVersion,'hcd-word-active-link-status/1')
  await assert.rejects(active.run({...pending,activeReviewHash:'b'.repeat(64)},async()=>member,()=>context,1),/request-changed/)
  const result=await active.run(pending,async()=>member,()=>context,1);assert.equal(result.revision,2);assert.deepEqual(await active.run(pending,async()=>member,()=>context,1),result)
  assert.equal(calls.filter(v=>v==='native').length,1);assert.equal(calls.filter(v=>v==='prepare').length,1)
  await assert.rejects(active.cancel(pending,async()=>member,async()=>{},1),/already-installed/)
  await assert.rejects(active.run(pending,async()=>({...member,scope:'read'}),()=>context,1),/unauthorized/)
  assert.equal(active.status('doc',2,pending.request.transactionId).status,'recovery-required')
 }finally{await f.close()}
})
