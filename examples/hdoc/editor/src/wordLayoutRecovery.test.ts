import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {WordCheckpointJournal,wordSaveCapsule,wordLayoutRequestHash} from './wordCheckpointJournal.ts'
import {promoteRecoveredWordLayout,recoverCommittedWordLayout,submitPreparedWordLayout} from './wordLayoutRecovery.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
function projectionFixture():WordRegionProjection{
 const flowLayout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:11906},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header' as const,sourcePart:'word/header1.xml'}]}
 return{documentId:'regional',revision:1,flowLayout,flowLayoutHash:'a'.repeat(64),blocks:[1,2].map(n=>({flowRegionId:id(n),region:n===1?'body':'header',readOnly:false,blockId:id(n+10),blockHash:'a'.repeat(64),content:{kind:'paragraph',inlines:[{nodeId:id(n+20),text:'Text '+n}]}}))}
}

test('stopped owner recovers the committed request and replays only the journal tip after lost acknowledgement',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-layout-recovery-')),secret='layout-recovery-secret-at-least-32-bytes',lineage='e'.repeat(32),journal=new WordCheckpointJournal(root,'api','regional',0,lineage,secret,true),previous=projectionFixture(),next=structuredClone(previous),doc=new Y.Doc(),schema=wordRegionSchema()
 const model=new WordRegionStore(doc,schema,'regional',previous.flowLayout,previous.flowLayoutHash);model.initialize(previous)
 const base={revision:1,rootHash:'c'.repeat(64),layoutHash:previous.flowLayoutHash,digest:createHash('sha256').update(model.contents()).digest('hex')},actor={userId:'alice',displayName:'Alice',generation:1}
 const before=model.region(previous.flowLayout.stories[0].id),node=before[0].node;model.reconcile(previous.flowLayout.stories[0].id,before,[{key:before[0].key,node:node.type.createChecked(node.attrs,schema.text('Late header'))}])
 const capsule=wordSaveCapsule(journal.scope,model,base,[actor]);capsule.version=2;capsule.pendingLayout={actor,request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'regional',transactionId:'d'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:base.layoutHash,changes:[{sectionId:previous.flowLayout.sections[0].id,field:'widthTwips',expected:11906,value:12240}]}}}
 next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.sections[0].page.widthTwips=12240
 const transaction=capsule.pendingLayout.request,record={documentId:'regional',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-layout-${transaction.transactionId}`,patchHash:wordLayoutRequestHash(transaction),rootHash:'f'.repeat(64),wordLayoutChange:true}
 const tip=await journal.save(capsule,'none');let ownerTip='none',calls=0,lost=false,receiptCalls=0,stopped=true,denied=false
 const lease={assert:()=>{if(lost)throw Error('word-owner-lost')},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{calls++;ownerTip=hashes.at(-1)!;if(calls===2){lost=true;throw Error('lost owner record response')}}}
 const request=async(route:string)=>{
  if(route==='/auth')return Response.json({scope:denied?'read':'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/1'})
  if(route==='/revisions?limit=1')return Response.json({headRevision:2})
  if(route==='/editor?revision=1')return Response.json(previous)
  if(route==='/revisions/1')return Response.json({revision:1,rootHash:base.rootHash})
  if(route==='/revisions/2')return Response.json(record)
  if(route==='/word/layout-receipt'){receiptCalls++;const signature=createHmac('sha256',secret).update(`hcd-layout-receipt/1:regional:0:${lineage}:${tip}:1:2:${transaction.transactionId}:${record.patchHash}:${record.rootHash}`).digest('base64url');return Response.json({schemaVersion:'hcd-layout-receipt/1',documentId:'regional',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:transaction.transactionId,requestHash:record.patchHash,rootHash:record.rootHash,signature,projection:next})}
  throw Error('unexpected route '+route)
 }
 try{
  const options={journal,lease,request,assertStopped:()=>{if(!stopped)throw Error('room-active')}}
  denied=true;await assert.rejects(recoverCommittedWordLayout(options),/word-authority-changed/);assert.equal((await journal.load())!.hash,tip);assert.ok((await journal.load())!.capsule.pendingLayout);denied=false
  await assert.rejects(recoverCommittedWordLayout(options),/lost owner record response/);const saved=await journal.load();assert.ok(saved!.capsule.layoutAcknowledgement);assert.equal(ownerTip,saved!.hash);assert.equal(receiptCalls,1)
  lost=false;const reopened=new WordCheckpointJournal(root,'api','regional',0,lineage,secret,true),recovered=await recoverCommittedWordLayout({...options,journal:reopened});assert.equal(recovered.tip,saved!.hash);assert.equal(receiptCalls,1);assert.equal(ownerTip,recovered.tip)
  const copy=new Y.Doc();try{Y.applyUpdate(copy,Buffer.from(recovered.capsule.document,'base64'));const store=new WordRegionStore(copy,schema,'regional',next.flowLayout,next.flowLayoutHash);assert.equal(store.project(next.flowLayout.stories[0].id).textContent,'Late header')}finally{copy.destroy()}
  let promoteRecords=0,loseResponse=true,wrongHead=false
  const promoteLease={assert:()=>{},renew:async()=>{},recordJournal:async()=>{if(++promoteRecords===2&&loseResponse)throw Error('promotion record lost')}}
  const promoteRequest=async(route:string)=>route==='/auth'?Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'}):route==='/revisions?limit=1'?Response.json({headRevision:wrongHead?3:2}):request(route)
  const promoteOptions={journal:reopened,lease:promoteLease,request:promoteRequest,assertStopped:()=>{if(!stopped)throw Error('room-active')},protocol:'hcd-word-regions/2' as const}
  wrongHead=true;await assert.rejects(promoteRecoveredWordLayout(promoteOptions),/canonical-changed/);assert.equal((await reopened.load())!.hash,recovered.tip);wrongHead=false;promoteRecords=0
  await assert.rejects(promoteRecoveredWordLayout(promoteOptions),/promotion record lost/);const published=await reopened.load();assert.equal(published!.capsule.version,3);assert.notEqual(published!.hash,recovered.tip)
  loseResponse=false;let promoted=await promoteRecoveredWordLayout(promoteOptions);assert.equal(promoted.tip,published!.hash)
  const liveRequest=async(route:string)=>route==='/auth'?Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'}):route==='/editor?revision=2'?Response.json(next):route==='/revisions/2'?Response.json(record):promoteRequest(route)
  await assert.rejects(WordSaveCoordinator.open({journal:reopened,protocol:'hcd-word-regions/2',request:liveRequest}),/word-layout-coordinator-required/)
  const live=await WordSaveCoordinator.open({journal:reopened,protocol:'hcd-word-regions/2',request:liveRequest,experimentalLayoutDraftOnly:true,autoSave:true,idleMs:1})
  try{assert.match(live.model.project(next.flowLayout.stories[0].id).textContent,/Late header/);live.change({userId:'bob',displayName:'Bob',scope:'write'},()=>{const before=live.model.region(next.flowLayout.stories[0].id),node=before[0].node;live.model.reconcile(next.flowLayout.stories[0].id,before,[{key:before[0].key,node:node.type.createChecked(node.attrs,live.model.schema.text('New peer draft'))}])});await live.persist();await assert.rejects(live.save(),/word-layout-live-save-unavailable/);await new Promise(resolve=>setTimeout(resolve,15));const persisted=await reopened.load();assert.equal(persisted!.capsule.version,3);assert.equal(persisted!.capsule.observation,'0'.repeat(64));assert.equal(persisted!.capsule.actors.some(value=>value.userId==='bob'),false);assert.equal(persisted!.capsule.pending,undefined);promoted={tip:persisted!.hash,capsule:persisted!.capsule}}finally{live.dispose();live.model.document.destroy()}
  const second=structuredClone(capsule.pendingLayout!);second.request.transactionId='1'.repeat(32);second.request.baseRevision=2;second.request.expectedRevision=2;second.request.edits.baseLayoutHash=next.flowLayoutHash;second.request.edits.changes[0].expected=12240;second.request.edits.changes[0].value=13000
  const unsafe={...structuredClone(promoted.capsule),version:2 as const,pendingLayout:second};await assert.rejects(reopened.save(unsafe,promoted.tip),/word-layout-coordinator-required/)
  const prepared=await reopened.prepareLayout(second,promoted.tip,()=>{});assert.deepEqual(prepared.capsule.pendingLayout,second);assert.equal(prepared.capsule.document,promoted.capsule.document)
  const again=new WordCheckpointJournal(root,'api','regional',0,lineage,secret,true);assert.equal((await again.load())!.hash,prepared.tip)
  await assert.rejects(again.prepareLayout(second,prepared.tip,()=>{}),/pending-unresolved/)
  stopped=false;await assert.rejects(recoverCommittedWordLayout({...options,journal:reopened}),/room-active/)
 }finally{doc.destroy();await fs.rm(root,{recursive:true,force:true})}
})

test('prepared layout submission survives a lost response without replacing the durable request',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-layout-submit-')),secret='layout-submit-secret-at-least-32-bytes',lineage='e'.repeat(32),journal=new WordCheckpointJournal(root,'api','regional',0,lineage,secret,true),previous=projectionFixture(),next=structuredClone(previous),doc=new Y.Doc()
 try{
  const model=new WordRegionStore(doc,wordRegionSchema(),'regional',previous.flowLayout,previous.flowLayoutHash);model.initialize(previous)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:previous.flowLayoutHash,digest:createHash('sha256').update(model.contents()).digest('hex')},actor={userId:'alice',displayName:'Alice',generation:1},capsule=wordSaveCapsule(journal.scope,model,base,[actor]);capsule.version=2
  capsule.pendingLayout={actor,request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'regional',transactionId:'d'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:base.layoutHash,changes:[{sectionId:previous.flowLayout.sections[0].id,field:'widthTwips',expected:11906,value:12240}]}}}
  const transaction=capsule.pendingLayout.request,tip=await journal.save(capsule,'none'),record={documentId:'regional',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-layout-${transaction.transactionId}`,patchHash:wordLayoutRequestHash(transaction),rootHash:'f'.repeat(64),wordLayoutChange:true}
  next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.sections[0].page.widthTwips=12240
  let head=1,submissions=0,stopped=true,ownerTip='none',badBaseline=false,failBeforeCommit=false
  const lease={assert:()=>{},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{ownerTip=hashes.at(-1)!}}
  const request=async(route:string,init?:RequestInit)=>{
   if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'})
   if(route==='/revisions?limit=1')return Response.json({headRevision:head})
   if(route==='/word/layout-transactions'){submissions++;assert.equal(ownerTip,tip);assert.deepEqual(JSON.parse(String(init?.body)).transaction,transaction);if(failBeforeCommit)throw Error('connection lost before commit');head=2;throw Error('connection lost after commit')}
   if(route==='/editor?revision=1')return Response.json(previous)
   if(route==='/revisions/1')return Response.json({revision:1,rootHash:badBaseline?'0'.repeat(64):base.rootHash})
   if(route==='/revisions/2')return Response.json(record)
   if(route==='/word/layout-receipt'){const signature=createHmac('sha256',secret).update(`hcd-layout-receipt/1:regional:0:${lineage}:${tip}:1:2:${transaction.transactionId}:${record.patchHash}:${record.rootHash}`).digest('base64url');return Response.json({schemaVersion:'hcd-layout-receipt/1',documentId:'regional',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:transaction.transactionId,requestHash:record.patchHash,rootHash:record.rootHash,signature,projection:next})}
   throw Error('unexpected route '+route)
  }
  const options={journal,lease,request,protocol:'hcd-word-regions/2' as const,assertStopped:()=>{if(!stopped)throw Error('room-active')}}
  stopped=false;await assert.rejects(submitPreparedWordLayout(options),/room-active/);assert.equal(submissions,0);stopped=true
  await assert.rejects(submitPreparedWordLayout({...options,protocol:undefined}),/word-authority-changed/)
  badBaseline=true;await assert.rejects(submitPreparedWordLayout(options),/word-layout-baseline-invalid/);assert.equal(submissions,0);badBaseline=false
  head=3;await assert.rejects(submitPreparedWordLayout(options),/canonical-changed/);assert.equal(submissions,0);head=1
  await assert.rejects(submitPreparedWordLayout({...options,authorizeMember:async()=>{throw Error('access-revoked')}}),/access-revoked/);assert.equal(submissions,0);assert.equal((await journal.load())!.hash,tip)
  failBeforeCommit=true;await assert.rejects(submitPreparedWordLayout(options),/connection lost before commit/);assert.equal((await journal.load())!.hash,tip);failBeforeCommit=false
  await assert.rejects(submitPreparedWordLayout(options),/connection lost after commit/);assert.equal((await journal.load())!.hash,tip);assert.ok((await journal.load())!.capsule.pendingLayout)
  const reopened=new WordCheckpointJournal(root,'api','regional',0,lineage,secret,true),result=await submitPreparedWordLayout({...options,journal:reopened});assert.equal(submissions,2);assert.equal(result.capsule.base.revision,2);assert.ok(result.capsule.layoutAcknowledgement);assert.equal(ownerTip,result.tip)
 }finally{doc.destroy();await fs.rm(root,{recursive:true,force:true})}
})
