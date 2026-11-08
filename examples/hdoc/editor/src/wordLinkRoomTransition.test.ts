import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {WordRegionStore} from './wordRegionStore.ts'
import {wordLinkFixture,linkId} from './wordLinkTestFixture.ts'
import {readActiveLinkPending} from './wordActiveLink.ts'
import {previewActiveWordLink} from './wordActiveLinkPreview.ts'
import {transitionWordLink,promoteHeldWordLink} from './wordLinkRoomTransition.ts'
import {RoomMigrationGate,MigrationUncertain} from './roomMigrationGate.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'

async function fixture(){
 const f=await wordLinkFixture(),gate=new RoomMigrationGate();let held=false,sealed=false,head=1,submits=0,journalHash='',drop=false,ready=true,allowed=true,afterPreflight=()=>{}
 const room={model:f.model,uploads:{snapshot:()=>[]},state:()=>({revision:1}),ownsJournal:(j:unknown)=>j===f.journal,isLayoutAwareLive:()=>true,assertAcceptingPackets:()=>{if(held)throw Error('held')},isTopologyHeld:()=>held,assertTopologyHeld:()=>{assert.equal(held,true)},drain:async()=>{await f.saveDraft()},holdForTopology:()=>{held=true},sealTopologyHold:()=>{assert.equal(held,true);sealed=true},releaseTopologyHold:()=>{assert.equal(sealed,false);held=false}} as unknown as WordSaveCoordinator
 const request=async(route:string,init?:RequestInit)=>{
  if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'})
  if(route==='/revisions?limit=1')return Response.json({headRevision:head})
  if(route==='/revisions/1')return Response.json({revision:1,rootHash:f.base.rootHash})
  if(route==='/revisions/2')return Response.json(f.record)
  if(route==='/editor?revision=1')return Response.json(f.previous)
  const body=JSON.parse(String(init?.body))
  if(route==='/word/link-preflight'){
   afterPreflight()
   return Response.json({schemaVersion:'hcd-word-link-preflight/1',documentId:'doc',transactionId:f.pending.request.transactionId,revision:1,rootHash:f.base.rootHash,baseLayoutHash:f.previous.flowLayoutHash,candidateLayoutHash:f.next.flowLayoutHash,reviewHash:f.pending.reviewHash,retainedStoryId:linkId(5),inheritedStoryId:linkId(4),affected:[2,3].map(n=>({sectionId:linkId(n),beforeStoryId:linkId(5),afterStoryId:linkId(4)}))})
  }
  if(route==='/word/link-transactions'){submits++;head=2;if(drop)throw Error('native success response lost');return Response.json({revision:2})}
  assert.equal(route,'/word/link-receipt');return Response.json({...f.signHash(body.initialUpdateHash,journalHash),projection:f.next})
 }
 const member=async()=>({...f.pending.actor,scope:allowed?'write' as const:'read' as const}),selection={sectionId:linkId(2),kind:'header' as const,variant:'default' as const,transactionId:f.pending.request.transactionId}
 const reviewed=await previewActiveWordLink({room,journal:f.journal,selection,actor:f.pending.request.actor,assertOwnership:()=>{},authorize:member,request}),pending=readActiveLinkPending(reviewed.pending,'doc',await member())
 const options={gate,room,journal:f.journal,pending,reviewHash:reviewed.reviewHash,protocol:'hcd-word-regions/2' as const,request,lease:{assert:()=>{},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{journalHash=hashes.at(-1)!}},authorize:member,assertClientsReady:()=>{if(!ready)throw Error('client busy')}}
 return{...f,gate,room,options,get submits(){return submits},get held(){return held},get sealed(){return sealed},drop:()=>{drop=true},deny:()=>{allowed=false},busy:()=>{ready=false},after:(fn:()=>void)=>{afterPreflight=fn}}
}
test('active link preserves body drafts and the old model through signed preparation and exact held promotion',async()=>{
 const f=await fixture();try{
  f.edit(1,'Unrelated body draft');const before=Y.encodeStateAsUpdate(f.document)
  const result=await transitionWordLink(f.options);assert.equal(result.capsule.version,5);assert.equal(f.held,true);assert.equal(f.sealed,true);assert.equal(f.submits,1)
  assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(f.model.layoutState().layout.sections[1].headers.default,linkId(5));assert.throws(()=>f.gate.enter('doc'),/transition/)
  const promoted=await promoteHeldWordLink({...f.options,assertStopped:()=>f.room.assertTopologyHeld()});assert.equal(promoted.capsule.version,3)
  const copy=new Y.Doc();try{Y.applyUpdate(copy,Buffer.from(promoted.capsule.document,'base64'));assert.equal(new WordRegionStore(copy,f.model.schema,'doc',f.next.flowLayout,f.next.flowLayoutHash).project(linkId(1)).textContent,'Unrelated body draft')}finally{copy.destroy()}
  await assert.rejects(promoteHeldWordLink({...f.options,pending:{...f.options.pending,reviewHash:'0'.repeat(64)},assertStopped:()=>{}}),/transition/)
  assert.equal(f.gate.heldIdentity('doc','word-story-link',JSON.stringify(f.options.pending)),true)
 }finally{await f.close()}
})
test('lost native success retains the held original and retries without a duplicate commit',async()=>{
 const f=await fixture();try{
  f.drop();await assert.rejects(transitionWordLink(f.options),MigrationUncertain);assert.equal(f.submits,1);assert.equal(f.gate.blocked('doc'),true);assert.ok((await f.journal.load())?.capsule.pendingLink)
  const recovered=await transitionWordLink(f.options);assert.equal(f.submits,1);assert.ok(recovered.capsule.linkAcknowledgement)
  await promoteHeldWordLink({...f.options,assertStopped:()=>f.room.assertTopologyHeld()})
 }finally{await f.close()}
})
test('stale reviews, affected drafts, late source changes, authority loss and unready peers do not seal',async()=>{
 for(const mode of ['review','candidate','draft','late','member','peer']){const f=await fixture();try{
  if(mode==='review')f.options.reviewHash='0'.repeat(64)
  if(mode==='candidate')f.options.pending.candidateLayoutHash='0'.repeat(64)
  if(mode==='draft')f.edit(5,'Keep header draft')
  if(mode==='late')f.after(()=>f.edit(4,'Keep inherited late draft'))
  if(mode==='member')f.deny();if(mode==='peer')f.busy()
  await assert.rejects(transitionWordLink(f.options));assert.equal(f.submits,0);assert.equal(f.sealed,false);assert.equal(f.held,false);assert.equal(f.gate.blocked('doc'),false);assert.equal((await f.journal.load())?.capsule.version,3)
 }finally{await f.close()}}
})
