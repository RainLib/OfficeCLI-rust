import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recoverPreparedWordCheckpoint} from './wordCheckpointRecovery.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'

test('a historical unchanged receipt is recorded without promoting the draft to the newer head',async()=>{
 const pending={request:{expectedRevision:2,checkpointId:'a'.repeat(32)}}
 const capsule={version:3,base:{revision:2,rootHash:'old'},pending}
 let acknowledged=0,recorded=0
 const journal={scope:{epoch:1},load:async()=>({capsule,hash:'tip'}),knownHashes:()=>['tip'],acknowledgeUnchanged:async(_receipt:unknown,_record:unknown,_projection:unknown,hash:string,guard:()=>void)=>{guard();assert.equal(hash,'tip');acknowledged++;return{capsule:{...capsule,pending:undefined},tip:'next'}}} as unknown as WordCheckpointJournal
 const lease={assert:()=>{},renew:async()=>{},recordJournal:async()=>{recorded++}}
 const request=async(route:string)=>{
  if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'})
  if(route==='/revisions?limit=1')return Response.json({headRevision:4})
  if(route==='/revisions/2')return Response.json({revision:2,rootHash:'old'})
  if(route==='/word/checkpoints')return Response.json({saved:true,saveMode:'word-regions-unchanged',revision:2,rootHash:'old',projection:{revision:2},unchangedReceipt:{}})
  throw Error(route)
 }
 const result=await recoverPreparedWordCheckpoint({journal,lease,request,assertStopped:()=>{}})
 assert.equal(result.headAdvanced,true);assert.equal(result.capsule.base.revision,2);assert.equal(acknowledged,1);assert.equal(recorded,2)
})

test('a rejected historical receipt cannot clear the prepared request',async()=>{
 const pending={request:{expectedRevision:2,checkpointId:'a'.repeat(32)}},capsule={version:3,base:{revision:2,rootHash:'old'},pending};let recorded=0
 const journal={scope:{epoch:1},load:async()=>({capsule,hash:'tip'}),knownHashes:()=>['tip'],acknowledgeUnchanged:async()=>{throw Error('word-checkpoint-receipt-invalid')}} as unknown as WordCheckpointJournal
 const lease={assert:()=>{},renew:async()=>{},recordJournal:async()=>{recorded++}}
 const request=async(route:string)=>{
  if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'})
  if(route==='/revisions?limit=1')return Response.json({headRevision:4})
  if(route==='/revisions/2')return Response.json({revision:2,rootHash:'old'})
  if(route==='/word/checkpoints')return Response.json({saved:true,saveMode:'word-regions-unchanged',revision:2,rootHash:'old',projection:{revision:2},unchangedReceipt:{}})
  throw Error(route)
 }
 await assert.rejects(recoverPreparedWordCheckpoint({journal,lease,request,assertStopped:()=>{}}),/word-checkpoint-receipt-invalid/);assert.equal(capsule.pending,pending);assert.equal(recorded,1)
})

test('receipt-first failures and unrecognized results retain the request without resubmission',async()=>{
 for(const status of [403,409,503,200]){
  const pending={request:{expectedRevision:2,checkpointId:'a'.repeat(32)}},capsule={version:3,base:{revision:2,rootHash:'old'},pending},routes:string[]=[]
  const journal={scope:{epoch:1},load:async()=>({capsule,hash:'tip'}),knownHashes:()=>['tip'],acknowledgeUnchanged:async()=>{throw Error('must not acknowledge')}} as unknown as WordCheckpointJournal
  const request=async(route:string)=>{routes.push(route);if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'});if(route==='/revisions?limit=1')return Response.json({headRevision:2});if(route==='/revisions/2')return Response.json({revision:2,rootHash:'old'});if(route==='/word/checkpoint-receipt')return Response.json({schemaVersion:'unsupported'},{status});throw Error('must not submit')}
  await assert.rejects(recoverPreparedWordCheckpoint({journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request,assertStopped:()=>{},receiptFirst:true}),status===200?/word-checkpoint-receipt-invalid/:new RegExp(`word-checkpoint-recovery:${status}`))
  assert.equal(capsule.pending,pending);assert.equal(routes.includes('/word/checkpoints'),false)
 }
})

test('an absent receipt permits only the original exact request and preserves the submission acknowledgement path',async()=>{
 const pending={request:{expectedRevision:2,checkpointId:'a'.repeat(32)}},capsule={version:3,base:{revision:2,rootHash:'old'},pending};let submitted=0,acknowledged=0
 const journal={scope:{epoch:1},load:async()=>({capsule,hash:'tip'}),knownHashes:()=>['tip'],acknowledgeUnchanged:async()=>{acknowledged++;return{capsule:{...capsule,pending:undefined},tip:'ack'}}} as unknown as WordCheckpointJournal
 const request=async(route:string,init?:RequestInit)=>{if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'});if(route==='/revisions?limit=1')return Response.json({headRevision:2});if(route==='/revisions/2')return Response.json({revision:2,rootHash:'old'});if(route==='/word/checkpoint-receipt')return new Response(null,{status:404});if(route==='/word/checkpoints'){submitted++;assert.equal(init?.body,JSON.stringify(pending.request));return Response.json({saved:true,saveMode:'word-regions-unchanged',revision:2,rootHash:'old',projection:{revision:2},unchangedReceipt:{}})}throw Error(route)}
 const result=await recoverPreparedWordCheckpoint({journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request,assertStopped:()=>{},receiptFirst:true})
 assert.equal(submitted,1);assert.equal(acknowledged,1);assert.equal(result.capsule.base.revision,2)
})
