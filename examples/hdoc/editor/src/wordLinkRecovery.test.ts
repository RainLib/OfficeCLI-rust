import {test} from 'node:test'
import assert from 'node:assert/strict'
import {submitPreparedWordLink,recoverCommittedWordLink,promoteRecoveredWordLink} from './wordLinkRecovery.ts'
import {wordLinkFixture} from './wordLinkTestFixture.ts'
import {wordLinkPendingHash} from './wordLinkProof.ts'

async function fixture(){
 const f=await wordLinkFixture();f.edit(1,'Retained draft');await f.saveDraft();await f.journal.prepareLink(f.pending,f.tip,()=>{})
 let head=1,submits=0,receipts=0,journalHash='',stopped=true,owned=true,allowed=true,drop=false,recordFailure=false,afterReceipt=()=>{}
 const options={journal:f.reopen(),protocol:'hcd-word-regions/2' as const,assertStopped:()=>{if(!stopped)throw Error('room active')},authorize:async()=>({...f.pending.actor,scope:allowed?'write' as const:'read' as const}),lease:{assert:()=>{if(!owned)throw Error('owner lost')},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{journalHash=hashes.at(-1)!;if(recordFailure&&hashes.length>=5){recordFailure=false;throw Error('record response lost')}}},request:async(route:string,init?:RequestInit)=>{
  if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'})
  if(route==='/revisions?limit=1')return Response.json({headRevision:head})
  if(route==='/revisions/1')return Response.json({revision:1,rootHash:f.base.rootHash})
  if(route==='/revisions/2')return Response.json(f.record)
  if(route==='/editor?revision=1')return Response.json(f.previous)
  const body=JSON.parse(String(init?.body));assert.equal(new Headers(init?.headers).get('x-hcd-word-link-version'),'1')
  assert.equal(body.prepared?.coordinatorId??body.coordinatorId,f.lineage)
  if(route==='/word/link-transactions'){submits++;assert.equal(head,1);head=2;if(drop)throw Error('commit response lost');return Response.json({revision:2})}
  assert.equal(route,'/word/link-receipt');assert.equal(body.pendingHash,wordLinkPendingHash(f.pending));receipts++;const proof=f.signHash(body.initialUpdateHash,journalHash);afterReceipt();return Response.json({...proof,projection:f.next})
 }}
 return{...f,options,get submits(){return submits},get receipts(){return receipts},head:(n:number)=>{head=n},drop:()=>{drop=true},failRecord:()=>{recordFailure=true},activate:()=>{stopped=false},lose:()=>{owned=false},deny:()=>{allowed=false},after:(fn:()=>void)=>{afterReceipt=fn}}
}

test('a successful commit with a lost response recovers the exact request without resubmission',async()=>{
 const f=await fixture();try{
  f.drop();await assert.rejects(submitPreparedWordLink(f.options),/response lost/);assert.equal(f.submits,1);assert.deepEqual((await f.reopen().load())?.capsule.pendingLink,f.pending)
  const recovered=await submitPreparedWordLink({...f.options,journal:f.reopen()});assert.equal(f.submits,1);assert.equal(recovered.capsule.base.revision,2);assert.equal(recovered.historical,false)
  const promoted=await promoteRecoveredWordLink({...f.options,journal:f.reopen()},f.pending);assert.equal(promoted.capsule.version,3);assert.equal(f.submits,1)
  assert.equal((await promoteRecoveredWordLink({...f.options,journal:f.reopen()},f.pending)).tip,promoted.tip)
 }finally{await f.close()}
})
test('owner registration lost after durable acknowledgement is retried without another receipt or commit',async()=>{
 const f=await fixture();try{
  f.failRecord();await assert.rejects(submitPreparedWordLink(f.options),/record response lost/);assert.equal((await f.reopen().load())?.capsule.version,5);assert.ok((await f.reopen().load())?.capsule.linkAcknowledgement)
  const receipts=f.receipts,result=await recoverCommittedWordLink({...f.options,journal:f.reopen()});assert.equal(result.capsule.base.revision,2);assert.equal(f.submits,1);assert.equal(f.receipts,receipts)
 }finally{await f.close()}
})
test('a historical native confirmation preserves the journal but cannot install a stale baseline',async()=>{
 const f=await fixture();try{
  f.head(3);const result=await submitPreparedWordLink(f.options);assert.equal(result.historical,true);assert.equal(result.headRevision,3);assert.equal(result.capsule.base.revision,2);assert.equal(f.submits,0)
  await assert.rejects(promoteRecoveredWordLink({...f.options,journal:f.reopen()},f.pending),/historical-review-required/);assert.ok((await f.reopen().load())?.capsule.linkAcknowledgement)
 }finally{await f.close()}
})
test('room, member and owner fences fail closed and preserve pending input',async()=>{
 for(const mode of ['room','member','owner']){const f=await fixture();try{
  if(mode==='room')f.activate();if(mode==='member')f.deny();if(mode==='owner')f.lose();await assert.rejects(submitPreparedWordLink(f.options));assert.equal(f.submits,0);assert.deepEqual((await f.reopen().load())?.capsule.pendingLink,f.pending)
 }finally{await f.close()}}
})
test('authority lost after native signing and concurrent head movement do not clear the prepared request',async()=>{
 for(const mode of ['authority','head']){const f=await fixture();try{
  f.head(2);f.after(()=>mode==='authority'?f.deny():f.head(3));await assert.rejects(recoverCommittedWordLink(f.options));assert.deepEqual((await f.reopen().load())?.capsule.pendingLink,f.pending)
 }finally{await f.close()}}
})
