import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordStaleRegionCatalog,inspectStaleWordDraft} from './wordStoppedDraftReview.ts'
import type {WordLayout} from './wordRegions.ts'
import {createHash,createHmac} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,type WordRegionProjection} from './wordRegionStore.ts'
import {WordCheckpointJournal,wordSaveCapsule,wordCheckpointRequestHash} from './wordCheckpointJournal.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {prepareStaleWordRebase} from './wordStaleRebase.ts'
import {prepareStoppedWordCheckpoint} from './wordStoppedCheckpoint.ts'

test('stale comparison identifies body and effective inherited header and footer sections',()=>{
 const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,sections:[
  {id:'body1',differentFirstPage:false,page:{},headers:{default:'header1',first:'header1'},footers:{default:'footer1'}},
  {id:'body2',differentFirstPage:false,page:{},headers:{},footers:{even:'footer2'}},
  {id:'body3',differentFirstPage:false,page:{},headers:{default:'header2',first:'header2'},footers:{default:'footer2'}},
 ],stories:[{id:'header1',kind:'header',sourcePart:'word/header1.xml'},{id:'header2',kind:'header',sourcePart:'word/header2.xml'},{id:'footer1',kind:'footer',sourcePart:'word/footer1.xml'},{id:'footer2',kind:'footer',sourcePart:'word/footer2.xml'}]}
 const regions=wordStaleRegionCatalog(layout)
 assert.deepEqual(regions.get('body2'),{kind:'body',sections:[2]})
 assert.deepEqual(regions.get('header1'),{kind:'header',sections:[1,2]})
 assert.deepEqual(regions.get('header2'),{kind:'header',sections:[3]})
 assert.deepEqual(regions.get('footer1'),{kind:'footer',sections:[1,2]})
 assert.deepEqual(regions.get('footer2'),{kind:'footer',sections:[2,3]})
})

test('signed historical checkpoint yields a staged disjoint candidate while retaining later author and draft',async()=>{
 for(const bound of [true,false]){
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),secret='word-stale-review-secret-at-least-thirty-two-bytes',lineage='b'.repeat(32),root=await fs.mkdtemp(join(tmpdir(),'word-stale-review-')),journal=new WordCheckpointJournal(root,'http://qa.invalid','doc',0,lineage,secret,true,true),doc=new Y.Doc(),schema=wordRegionSchema()
 const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayoutHash:hash('layout'),flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{},footers:{}}],stories:[]},blocks:[1,2].map(n=>({flowRegionId:id(1),blockId:id(n+10),blockHash:hash(`block-${n}`),region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:`Base ${n}`,nodeId:id(n+20)}]}}))}
 try{
  const model=new WordRegionStore(doc,schema,'doc',projection.flowLayout,projection.flowLayoutHash);model.initialize(projection);const base={revision:1,rootHash:hash('root1'),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},capture=model.capture(),guard=()=>{},actor={userId:'alice',displayName:'Alice',generation:2}
  let tip=await journal.initializeLayout(wordSaveCapsule(journal.scope,model,base,[],undefined,{observation:wordDraftObservation(model),references:[]},3),guard)
  const before=model.region(id(1)),first=before[0].node;model.reconcile(id(1),before,before.map((item,index)=>index?item:{key:item.key,node:first.type.createChecked(first.attrs,schema.text('Draft text',first.firstChild?.marks))}))
  const draft=wordSaveCapsule(journal.scope,model,base,[actor],undefined,{observation:bound?wordDraftObservation(model):'0'.repeat(64),references:[]},3);tip=await journal.save(draft,tip,guard)
  const capturedActor={...actor,generation:1},request={coordinatorVersion:6 as const,coordinatorId:lineage,checkpointId:'a'.repeat(32),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:1,layoutHash:base.layoutHash,typographyVersion:2 as const,regions:capture.regions.map(region=>({...region,images:[]})),contributors:[{userId:'alice',displayName:'Alice'}]}
  draft.pending={request,capture,actors:[capturedActor],images:[],initiator:{userId:'alice',displayName:'Alice'}};tip=await journal.save(draft,tip,guard)
  const unsigned=`hcdsave6:${lineage}:${request.checkpointId}:${request.coordinatorDigest}:${'d'.repeat(64)}`,patchId=unsigned+':'+createHmac('sha256',secret).update(`doc:0:1:${unsigned}`).digest('base64url'),requestHash=wordCheckpointRequestHash(request),message=`hcd-word-checkpoint-unchanged/2:doc:0:${tip}:${requestHash}:1:${base.rootHash}:${patchId}`,receipt={schemaVersion:'hcd-word-checkpoint-unchanged/2',documentId:'doc',epoch:0,journalHash:tip,requestHash,revision:1,rootHash:base.rootHash,patchId,signature:createHmac('sha256',secret).update(message).digest('base64url')}
  await journal.acknowledgeUnchanged(receipt,{revision:1,rootHash:base.rootHash},projection,tip,guard)
  const head=structuredClone(projection);head.revision=2;head.blocks[1].content.inlines[0].text='Peer text';const responses:Record<string,unknown>={'/revisions?limit=1':{headRevision:2},'/editor?revision=1':projection,'/editor?revision=2':head,'/revisions/1':{revision:1,rootHash:base.rootHash},'/revisions/2':{revision:2,rootHash:hash('root2')}}
  const requestNative=async(route:string)=>responses[route]?Response.json(responses[route]):new Response('',{status:404}),beforeReview=(await journal.load())!,review=await inspectStaleWordDraft(journal,requestNative,guard,0)
  assert.equal(review.proposalAvailable,bound);assert.equal(review.proposalProblem,bound?null:'authors');assert.equal(review.mergeSummary.status,'review');assert.equal(review.mergeSummary.draft,1);assert.equal(review.mergeSummary.current,1);if(bound)assert.ok(review.proposalRows.some(row=>row.after.includes('Draft text')));const after=(await journal.load())!;assert.equal(after.hash,beforeReview.hash);assert.equal(after.capsule.actors[0].generation,2)
  if(bound){const rebased=prepareStaleWordRebase(journal,after.capsule,projection,{revision:1,rootHash:base.rootHash},head,{revision:2,rootHash:hash('root2')}),rebasedDoc=new Y.Doc();try{Y.applyUpdate(rebasedDoc,Buffer.from(rebased.capsule.document,'base64'));const candidate=new WordRegionStore(rebasedDoc,schema,'doc',head.flowLayout,head.flowLayoutHash);assert.equal(candidate.project(id(1)).textContent,'Draft textPeer text');assert.equal(rebased.capsule.base.revision,2);assert.equal(rebased.capsule.base.rootHash,hash('root2'));assert.equal(rebased.capsule.actors[0].generation,2);assert.equal(rebased.capsule.observation,wordDraftObservation(candidate));assert.equal(rebased.capsule.unchangedAcknowledgement,undefined);assert.equal((await journal.load())!.hash,beforeReview.hash)}finally{rebasedDoc.destroy()}}
  else assert.throws(()=>prepareStaleWordRebase(journal,after.capsule,projection,{revision:1,rootHash:base.rootHash},head,{revision:2,rootHash:hash('root2')}),/contributors-unbound/)
  assert.throws(()=>prepareStaleWordRebase(journal,after.capsule,projection,{revision:1,rootHash:hash('forged')},head,{revision:2,rootHash:hash('root2')}),/baseline-invalid/)
  const changed=structuredClone(head);changed.blocks[0].content.inlines[0].text='Conflicting peer';responses['/editor?revision=2']=changed;const conflict=await inspectStaleWordDraft(journal,requestNative,guard,0);assert.equal(conflict.mergeSummary.status,'conflict');assert.equal(conflict.proposalAvailable,false);if(bound)assert.throws(()=>prepareStaleWordRebase(journal,after.capsule,projection,{revision:1,rootHash:base.rootHash},changed,{revision:2,rootHash:hash('root2')}),/word-stale-conflict/);assert.equal((await journal.load())!.hash,beforeReview.hash)
  if(bound){const actorId={userId:'alice',displayName:'Alice'},oldRecord={revision:1,rootHash:base.rootHash},newRecord={revision:2,rootHash:hash('root2')};await assert.rejects(journal.stageStaleRebase(projection,oldRecord,head,newRecord,beforeReview.hash,{userId:'bob',displayName:'Bob'},guard),/not-allowed/);assert.equal((await journal.load())!.hash,beforeReview.hash);const staged=await journal.stageStaleRebase(projection,oldRecord,head,newRecord,beforeReview.hash,actorId,guard);assert.equal(staged.idempotentReplay,false);assert.equal(staged.capsule.base.revision,2);assert.equal(staged.capsule.staleRebase?.checkpointId,request.checkpointId);assert.equal(staged.capsule.actors[0].generation,2)
   const reopened=new WordCheckpointJournal(root,'http://qa.invalid','doc',0,lineage,secret,true,true),loaded=(await reopened.load())!;assert.equal(loaded.hash,staged.tip);assert.equal(loaded.capsule.base.revision,2);const again=await reopened.stageStaleRebase(projection,oldRecord,head,newRecord,beforeReview.hash,actorId,guard);assert.equal(again.idempotentReplay,true);await assert.rejects(reopened.stageStaleRebase(projection,oldRecord,head,newRecord,beforeReview.hash,{userId:'bob',displayName:'Bob'},guard),/rebase-invalid/);const forged=structuredClone(loaded.capsule);forged.base.revision=3;await assert.rejects(reopened.save(forged,loaded.hash,guard));assert.equal((await reopened.load())!.hash,staged.tip)
   const later=structuredClone(head);later.revision=3;later.blocks[1].content.inlines[0].text='Peer advanced again';const laterRecord={revision:3,rootHash:hash('root3')},restaged=await reopened.stageStaleRebase(head,newRecord,later,laterRecord,staged.tip,actorId,guard);assert.equal(restaged.idempotentReplay,false);assert.equal(restaged.capsule.base.revision,3);const latestJournal=new WordCheckpointJournal(root,'http://qa.invalid','doc',0,lineage,secret,true,true),latest=(await latestJournal.load())!;assert.equal(latest.hash,restaged.tip);assert.equal((await latestJournal.checkpointRecoveryIdentity(request.checkpointId)).rebased,true)
   responses['/editor?revision=2']=head;responses['/editor?revision=3']=later;responses['/revisions/3']=laterRecord;responses['/revisions?limit=1']={headRevision:3};responses['/auth']={scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'};const lease={assert:guard,renew:async()=>{},recordJournal:async()=>{}},prepared=await prepareStoppedWordCheckpoint({journal:latestJournal,lease,request:requestNative,assertStopped:guard,initiator:actorId});assert.equal(prepared.prepared,true);const next=(await latestJournal.load())!;assert.equal(next.capsule.staleRebase,undefined);assert.equal(next.capsule.pending?.request.expectedRevision,3);assert.deepEqual(next.capsule.pending?.request.contributors,[actorId]);assert.equal(next.capsule.pending?.actors[0].generation,2)
  }
 }finally{doc.destroy();await fs.rm(root,{recursive:true,force:true})}
 }
})
