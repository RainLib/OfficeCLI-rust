import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {gzipSync,gunzipSync} from 'node:zlib'
import * as Y from 'yjs'
import {WordCheckpointJournal,wordSaveCapsule,validateWordSaveCapsule,wordLayoutRequestHash,matchesWordLayoutRecord,wordStoryRequestHash,wordStoryPendingHash,matchesWordStoryRecord,type WordStoryReceiptRequest,type WordPendingStory,type WordPendingCheckpoint,type WordLayoutPending} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,type WordRegionProjection} from './wordRegionStore.ts'
import {recoverCommittedWordStory,submitPreparedWordStory} from './wordStoryRecovery.ts'
const secret='word-private-journal-test-secret-over-thirty-two-bytes',lineage='b'.repeat(32),api='http://qa.invalid/v1/documents/doc'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const schema=wordRegionSchema(),layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header' as const,sourcePart:'word/header1.xml'}]}
const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayout:layout,flowLayoutHash:'a'.repeat(64),blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(n+10),blockHash:'a'.repeat(64),region:n===1?'body':'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Body':'Header',nodeId:id(n+20)}]}}))}
const people=[{userId:'alice',displayName:'Alice',generation:1}]
test('story receipt binds the native candidate, actor, revision, journal and initial Yjs bytes',()=>{
 const request:WordStoryReceiptRequest={documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:'a'.repeat(64),candidateHash:'b'.repeat(64),actor:{userId:'alice',displayName:'Alice 王'}}
 const pending:WordPendingStory={request,actor:{userId:'alice',displayName:'Alice 王',generation:1},intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
 assert.equal(wordStoryRequestHash(request),'d7179dcf83ad1afe0ee3550d0f1c947858144159a512aa67861b76d525d2129e')
 const record={documentId:'doc',authorId:'alice',authorName:'Alice 王',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${request.transactionId}`,patchHash:wordStoryRequestHash(request),rootHash:'c'.repeat(64),structuralChange:true}
 const journalHash='d'.repeat(64),initial=new Uint8Array([1,2,3]),journal=new WordCheckpointJournal('/tmp/unused',api,'doc',0,lineage,secret,true)
 const receipt={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash,expectedRevision:1,revision:2,transactionId:request.transactionId,requestHash:record.patchHash,pendingHash:wordStoryPendingHash(pending),rootHash:record.rootHash,layoutHash:'f'.repeat(64),initialUpdateHash:hash(initial),signature:''}
 const message=JSON.stringify(['hcd-word-story-receipt/1',hash(api),'doc',0,lineage,journalHash,1,2,request.transactionId,record.patchHash,receipt.pendingHash,record.rootHash,request.baseLayoutHash,receipt.layoutHash,receipt.initialUpdateHash]);receipt.signature=createHmac('sha256',secret).update(message).digest('base64url')
 assert.equal(matchesWordStoryRecord(record,request),true);assert.equal(journal.verifyStoryReceipt(record,pending,receipt,journalHash,initial),true)
 for(const mutate of [(value:WordStoryReceiptRequest)=>{value.candidateHash='0'.repeat(64)},(value:WordStoryReceiptRequest)=>{value.actor.displayName='other'},(value:WordStoryReceiptRequest)=>{value.baseLayoutHash='0'.repeat(64)},(value:WordStoryReceiptRequest)=>{value.expectedRevision=2}]){const changed=structuredClone(pending);mutate(changed.request);assert.equal(journal.verifyStoryReceipt(record,changed,receipt,journalHash,initial),false)}
 for(const mutate of [(value:typeof receipt)=>{value.epoch=1},(value:typeof receipt)=>{value.layoutHash='0'.repeat(64)},(value:typeof receipt)=>{value.journalHash='0'.repeat(64)},(value:typeof receipt)=>{value.signature='x'.repeat(43)}]){const changed=structuredClone(receipt);mutate(changed);assert.equal(journal.verifyStoryReceipt(record,pending,changed,journalHash,initial),false)}
 assert.equal(journal.verifyStoryReceipt(record,pending,receipt,journalHash,new Uint8Array([1,2,4])),false)
 const changedPending=structuredClone(pending);changedPending.blocks[0].content.inlines[0].text='substituted';assert.equal(journal.verifyStoryReceipt(record,changedPending,receipt,journalHash,initial),false)
 assert.equal(journal.verifyStoryReceipt(record,pending,{...receipt,signature:'王'.repeat(43)},journalHash,initial),false)
 assert.equal(new WordCheckpointJournal('/tmp/unused',api+'other','doc',0,lineage,secret,true).verifyStoryReceipt(record,pending,receipt,journalHash,initial),false)
})
test('layout revision matching binds request fields, actor, document, revision and native root',()=>{
 const request:WordLayoutPending['request']={schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'e'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice 王'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:'a'.repeat(64),changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:12240},{field:'evenAndOddHeaders',expected:false,value:true}]}}
 const record={documentId:'doc',authorId:'alice',authorName:'Alice 王',revision:2,patchBaseRevision:1,patchId:'word-layout-'+request.transactionId,patchHash:wordLayoutRequestHash(request),rootHash:'c'.repeat(64),wordLayoutChange:true}
 assert.equal(matchesWordLayoutRecord(record,request),true)
 for(const mutate of [(r:any)=>{r.actor.displayName='Bob'},(r:any)=>{r.edits.changes[0].value=12000},(r:any)=>{r.edits.changes.reverse()},(r:any)=>{r.edits.baseLayoutHash='b'.repeat(64)},(r:any)=>{r.transactionId='f'.repeat(32)}]){const altered=structuredClone(request);mutate(altered);assert.equal(matchesWordLayoutRecord(record,altered),false)}
 for(const mutate of [(r:any)=>{r.revision=3},(r:any)=>{r.patchBaseRevision=0},(r:any)=>{r.documentId='other'},(r:any)=>{r.wordLayoutChange=false},(r:any)=>{r.rootHash='bad'}]){const altered=structuredClone(record);mutate(altered);assert.equal(matchesWordLayoutRecord(altered,request),false)}
 const journalHash='f'.repeat(64),journal=new WordCheckpointJournal('/tmp/unused',api,'doc',0,lineage,secret,true),receipt={schemaVersion:'hcd-layout-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash,expectedRevision:1,revision:2,transactionId:request.transactionId,requestHash:record.patchHash,rootHash:record.rootHash,signature:''}
 const message=`hcd-layout-receipt/1:doc:0:${lineage}:${journalHash}:1:2:${request.transactionId}:${record.patchHash}:${record.rootHash}`;receipt.signature=createHmac('sha256',secret).update(message).digest('base64url')
 assert.equal(journal.verifyLayoutReceipt(record,request,receipt,journalHash),true)
 for(const mutate of [(r:any)=>{r.signature='x'.repeat(43)},(r:any)=>{r.epoch=1},(r:any)=>{r.journalHash='a'.repeat(64)},(r:any)=>{r.rootHash='b'.repeat(64)},(r:any)=>{r.coordinatorId='a'.repeat(32)}]){const altered=structuredClone(receipt);mutate(altered);assert.equal(journal.verifyLayoutReceipt(record,request,altered,journalHash),false)}
 assert.equal(journal.verifyLayoutReceipt(record,request,receipt,'a'.repeat(64)),false)
})
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-journal-')),document=new Y.Doc(),model=new WordRegionStore(document,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
 const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},journal=new WordCheckpointJournal(root,api,'doc',0,lineage,secret)
 const edit=(text:string)=>{const before=model.region(id(2)),node=before[0].node;model.reconcile(id(2),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,schema.text(text,node.firstChild?.marks))}])}
 edit('Captured header 😀');const capture=model.capture(),pending:WordPendingCheckpoint={capture,actors:people,request:{coordinatorVersion:5,coordinatorId:lineage,checkpointId:'d'.repeat(32),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:1,layoutHash:base.layoutHash,typographyVersion:2,extensionVersion:1,regions:capture.regions.map(region=>({...region,images:[]})),contributors:people.map(({userId,displayName})=>({userId,displayName}))}}
 return{root,document,model,journal,pending,base,edit,capsule:()=>wordSaveCapsule(journal.scope,model,base,[{...people[0],generation:2}],pending),close:async()=>{document.destroy();await fs.rm(root,{recursive:true,force:true})}}
}
test('a cancelled journal load cannot publish a stale chain after a later durable write',async()=>{
 const f=await fixture();try{
  const first=await f.journal.save(f.capsule(),'none'),internals=f.journal as any,read=internals.read.bind(f.journal)
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve});let delayed=false
  internals.read=async(previous:string)=>{const result=await read(previous);if(!delayed){delayed=true;started();await wait}return result}
  const controller=new AbortController(),loading=f.journal.load(controller.signal);await entered
  f.edit('Later durable text');const later=f.capsule(),second=await f.journal.save(later,first)
  controller.abort(new Error('cancel old read'));release();await assert.rejects(loading,/cancel old read/)
  assert.deepEqual(f.journal.knownHashes(),['none',first,second]);assert.equal(f.journal.snapshotRecorded(later),true)
  internals.read=read;assert.equal((await f.journal.load())?.hash,second)
 }finally{await f.close()}
})
test('a stale journal load cannot replace a later durable write even without cancellation',async()=>{
 const f=await fixture();try{
  const first=await f.journal.save(f.capsule(),'none'),internals=f.journal as any,read=internals.read.bind(f.journal)
  let release!:()=>void,started!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve});let delayed=false
  internals.read=async(previous:string)=>{const result=await read(previous);if(!delayed){delayed=true;started();await wait}return result}
  const loading=f.journal.load();await entered;f.edit('Newer durable text');const later=f.capsule(),second=await f.journal.save(later,first)
  release();await assert.rejects(loading,/word-journal-changed/);assert.deepEqual(f.journal.knownHashes(),['none',first,second]);assert.equal(f.journal.snapshotRecorded(later),true)
 }finally{await f.close()}
})
test('prepared story submission keeps exact request after lost response and recovers the committed result',async()=>{
 const f=await fixture();try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),start=await journal.save(wordSaveCapsule(journal.scope,f.model,f.base,people),'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},copyChoices:{referenceIds:[],extensions:[]},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  const prepared=await journal.prepareStory(pending,start,()=>{}),next=structuredClone(projection);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push(pending.story);next.flowLayout.sections[0].footers.default=pending.story.id;next.blocks.push(...pending.blocks)
  const record={documentId:'doc',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${pending.request.transactionId}`,patchHash:wordStoryRequestHash(pending.request),rootHash:'d'.repeat(64),structuralChange:true}
  let head=1,ownerTip='none',submissions=0
  const lease={assert:()=>{},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{ownerTip=hashes.at(-1)!}}
  const request=async(route:string,init?:RequestInit)=>{
   if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'})
   if(route==='/revisions?limit=1')return Response.json({headRevision:head})
   if(route==='/revisions/1')return Response.json({revision:1,rootHash:f.base.rootHash})
   if(route==='/revisions/2')return Response.json(record)
   if(route==='/editor?revision=1')return Response.json(projection)
   if(route==='/word/story-transactions'){submissions++;assert.equal(ownerTip,prepared.tip);const sent=JSON.parse(String(init?.body));assert.deepEqual(sent.copyChoices,pending.copyChoices);assert.equal(sent.intent.baseLayoutHash,pending.request.baseLayoutHash);head=2;throw Error('response lost after commit')}
   if(route==='/word/story-receipt'){const sent=JSON.parse(String(init?.body));const receipt={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:prepared.tip,expectedRevision:1,revision:2,transactionId:pending.request.transactionId,requestHash:record.patchHash,pendingHash:sent.pendingHash,rootHash:record.rootHash,layoutHash:next.flowLayoutHash,initialUpdateHash:sent.initialUpdateHash,signature:''};const message=JSON.stringify(['hcd-word-story-receipt/1',journal.scope.apiHash,'doc',0,lineage,prepared.tip,1,2,pending.request.transactionId,record.patchHash,receipt.pendingHash,record.rootHash,pending.request.baseLayoutHash,receipt.layoutHash,receipt.initialUpdateHash]);receipt.signature=createHmac('sha256',secret).update(message).digest('base64url');return Response.json({...receipt,projection:next})}
   throw Error('unexpected route '+route)
  }
  const options={journal,lease,request,protocol:'hcd-word-regions/2' as const,assertStopped:()=>{}}
  await assert.rejects(submitPreparedWordStory(options),/response lost after commit/);assert.deepEqual((await journal.load())!.capsule.pendingStory,pending)
  const restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),saved=await submitPreparedWordStory({...options,journal:restarted});assert.equal(submissions,1);assert.ok(saved.capsule.storyAcknowledgement);assert.equal(saved.capsule.base.revision,2);assert.equal(ownerTip,saved.tip)
 }finally{await f.close()}
})
test('stopped owner recovers a committed story and preserves draft after a lost owner response',async()=>{
 const f=await fixture();try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),initial=wordSaveCapsule(journal.scope,f.model,f.base,people),tip=await journal.save(initial,'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  const prepared=await journal.prepareStory(pending,tip,()=>{});f.edit('Late header input');const late=structuredClone(prepared.capsule);late.document=Buffer.from(Y.encodeStateAsUpdate(f.document)).toString('base64');const pendingTip=await journal.save(late,prepared.tip)
  const next=structuredClone(projection);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push(pending.story);next.flowLayout.sections[0].footers.default=pending.story.id;next.blocks.push(...pending.blocks)
  const record={documentId:'doc',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${pending.request.transactionId}`,patchHash:wordStoryRequestHash(pending.request),rootHash:'d'.repeat(64),structuralChange:true}
  let ownerTip='none',records=0,lost=false,denied=false,receiptCount=0,stopped=true
  const lease={assert:()=>{if(lost)throw Error('owner-lost')},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{ownerTip=hashes.at(-1)!;if(++records===2){lost=true;throw Error('lost owner response')}}}
  const request=async(route:string,init?:RequestInit)=>{
   if(route==='/auth')return Response.json({scope:denied?'read':'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/1'})
   if(route==='/revisions?limit=1')return Response.json({headRevision:2})
   if(route==='/editor?revision=1')return Response.json(projection)
   if(route==='/revisions/1')return Response.json({revision:1,rootHash:f.base.rootHash})
   if(route==='/revisions/2')return Response.json(record)
   if(route==='/word/story-receipt'){
    receiptCount++;const sent=JSON.parse(String(init?.body));assert.equal(ownerTip,pendingTip);assert.equal(sent.pendingHash,wordStoryPendingHash(pending))
    const receipt={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:pendingTip,expectedRevision:1,revision:2,transactionId:pending.request.transactionId,requestHash:record.patchHash,pendingHash:sent.pendingHash,rootHash:record.rootHash,layoutHash:next.flowLayoutHash,initialUpdateHash:sent.initialUpdateHash,signature:''}
    const message=JSON.stringify(['hcd-word-story-receipt/1',journal.scope.apiHash,'doc',0,lineage,pendingTip,1,2,pending.request.transactionId,record.patchHash,receipt.pendingHash,record.rootHash,pending.request.baseLayoutHash,receipt.layoutHash,receipt.initialUpdateHash]);receipt.signature=createHmac('sha256',secret).update(message).digest('base64url')
    return Response.json({...receipt,projection:next})
   }
   throw Error('unexpected route '+route)
  }
  const options={journal,lease,request,protocol:'hcd-word-regions/1' as const,assertStopped:()=>{if(!stopped)throw Error('room-active')}}
  denied=true;await assert.rejects(recoverCommittedWordStory(options),/word-authority-changed/);assert.equal((await journal.load())!.hash,pendingTip);denied=false
  await assert.rejects(recoverCommittedWordStory(options),/lost owner response/);const saved=await journal.load();assert.ok(saved!.capsule.storyAcknowledgement);assert.equal(receiptCount,2)
  lost=false;const reopened=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),result=await recoverCommittedWordStory({...options,journal:reopened});assert.equal(result.tip,saved!.hash);assert.equal(ownerTip,result.tip);assert.equal(receiptCount,2)
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(result.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'doc',next.flowLayout,next.flowLayoutHash);assert.equal(model.project(id(2)).textContent,'Late header input');assert.equal(model.project(id(3)).textContent,'New footer')}finally{restored.destroy()}
  stopped=false;await assert.rejects(recoverCommittedWordStory({...options,journal:reopened}),/room-active/)
 }finally{await f.close()}
})
test('pending independent story survives restart with the exact request and later draft input',async()=>{
 const f=await fixture();try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),initial=wordSaveCapsule(journal.scope,f.model,f.base,people),tip=await journal.save(initial,'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  pending.copyChoices={referenceIds:['mention-copy'],extensions:[{instanceId:'extension-copy',data:{name:'attachment'}}]}
  const changedChoice=structuredClone(pending);changedChoice.copyChoices!.referenceIds[0]='another';assert.notEqual(wordStoryPendingHash(pending),wordStoryPendingHash(changedChoice))
  const collision=structuredClone(pending);collision.story.sourcePart='word/header1.xml';await assert.rejects(journal.prepareStory(collision,tip,()=>{}),/word-journal-invalid/)
  const invalid=structuredClone(pending);invalid.intent.expectedInheritedStoryId=id(2);await assert.rejects(journal.prepareStory(invalid,tip,()=>{}),/word-journal-invalid/)
  const prepared=await journal.prepareStory(pending,tip,()=>{});f.edit('Late header while outcome unknown 😀')
  const late=structuredClone(prepared.capsule);late.document=Buffer.from(Y.encodeStateAsUpdate(f.document)).toString('base64');const lateTip=await journal.save(late,prepared.tip)
  const altered=structuredClone(late);altered.pendingStory!.request.transactionId='c'.repeat(32);await assert.rejects(journal.save(altered,lateTip),/word-story-pending-unresolved/)
  const alteredChoices=structuredClone(late);alteredChoices.pendingStory!.copyChoices!.referenceIds[0]='other';await assert.rejects(journal.save(alteredChoices,lateTip),/word-story-pending-unresolved/)
  const cleared=structuredClone(late);delete cleared.pendingStory;await assert.rejects(journal.save(cleared,lateTip),/word-journal-invalid/)
  const restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),loaded=await restarted.load();assert.equal(loaded!.hash,lateTip);assert.deepEqual(loaded!.capsule.pendingStory,pending)
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(loaded!.capsule.document,'base64'));assert.equal(new WordRegionStore(restored,schema,'doc',layout,projection.flowLayoutHash).project(id(2)).textContent,'Late header while outcome unknown 😀')}finally{restored.destroy()}
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true).load(),/word-journal-invalid/)
 }finally{await f.close()}
})
for(const lostAfterPublication of [false,true])test(`authenticated story acknowledgement survives restart and retains late draft input; lostAfterPublication=${lostAfterPublication}`,async()=>{
 const f=await fixture(),initialDoc=new Y.Doc();try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),initial=wordSaveCapsule(journal.scope,f.model,f.base,people),tip=await journal.save(initial,'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  const prepared=await journal.prepareStory(pending,tip,()=>{}),next=structuredClone(projection);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push(pending.story);next.flowLayout.sections[0].footers.default=pending.story.id;next.blocks.push(...pending.blocks)
  Y.applyUpdate(initialDoc,Y.encodeStateAsUpdate(f.document));const coordinator=new WordRegionStore(initialDoc,schema,'doc',layout,projection.flowLayoutHash);coordinator.acceptStoryReceipt(projection,next,pending.intent,pending.blocks);const initialUpdate=Y.encodeStateAsUpdate(initialDoc)
  f.edit('Late input after native commit 😀');const late=structuredClone(prepared.capsule);late.document=Buffer.from(Y.encodeStateAsUpdate(f.document)).toString('base64');const lateTip=await journal.save(late,prepared.tip)
  const request=pending.request,record={documentId:'doc',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${request.transactionId}`,patchHash:wordStoryRequestHash(request),rootHash:'d'.repeat(64),structuralChange:true}
  const receipt={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:lateTip,expectedRevision:1,revision:2,transactionId:request.transactionId,requestHash:record.patchHash,pendingHash:wordStoryPendingHash(pending),rootHash:record.rootHash,layoutHash:next.flowLayoutHash,initialUpdateHash:hash(initialUpdate),signature:''}
  const message=JSON.stringify(['hcd-word-story-receipt/1',hash(api),'doc',0,lineage,lateTip,1,2,request.transactionId,record.patchHash,receipt.pendingHash,record.rootHash,request.baseLayoutHash,receipt.layoutHash,receipt.initialUpdateHash]);receipt.signature=createHmac('sha256',secret).update(message).digest('base64url')
  const baseRecord={revision:1,rootHash:f.base.rootHash}
  await assert.rejects(journal.acknowledgeStory(record,{...receipt,signature:'x'.repeat(43)},baseRecord,projection,next,initialUpdate,lateTip,()=>{}),/word-story-receipt-invalid/)
  await assert.rejects(journal.acknowledgeStory(record,receipt,baseRecord,projection,next,initialUpdate,lateTip,()=>{throw Error('lease-lost')}),/lease-lost/)
  assert.deepEqual((await journal.load())!.capsule.pendingStory,pending)
  let acknowledgementTip:string
  if(lostAfterPublication){let checks=0;await assert.rejects(journal.acknowledgeStory(record,receipt,baseRecord,projection,next,initialUpdate,lateTip,()=>{if(++checks===4)throw Error('lease-lost')}),/word-journal-published-fence-lost/);const recovered=await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true).load();acknowledgementTip=recovered!.hash;assert.equal(recovered!.capsule.pendingStory,undefined)}
  else{const acknowledged=await journal.acknowledgeStory(record,receipt,baseRecord,projection,next,initialUpdate,lateTip,()=>{});acknowledgementTip=acknowledged.tip;assert.equal(acknowledged.capsule.pendingStory,undefined);assert.equal(acknowledged.capsule.base.revision,2)}
  const restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),loaded=await restarted.load();assert.equal(loaded!.hash,acknowledgementTip);assert.deepEqual(loaded!.capsule.storyAcknowledgement?.pending,pending)
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(loaded!.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'doc',next.flowLayout,next.flowLayoutHash);assert.equal(model.project(id(2)).textContent,'Late input after native commit 😀');assert.equal(model.project(id(3)).textContent,'New footer')}finally{restored.destroy()}
  const promoted=await restarted.promoteStoryAcknowledgement(acknowledgementTip,()=>{});assert.equal(promoted.capsule.version,3);assert.equal(promoted.capsule.storyAcknowledgement,undefined)
  const resumed=new Y.Doc();try{Y.applyUpdate(resumed,Buffer.from(promoted.capsule.document,'base64'));const model=new WordRegionStore(resumed,schema,'doc',next.flowLayout,next.flowLayoutHash),old=model.region(id(3)),node=old[0].node;model.reconcile(id(3),old,[{key:old[0].key,node:node.type.createChecked(node.attrs,schema.text('Continued footer'))}]);const draft=structuredClone(promoted.capsule);draft.document=Buffer.from(Y.encodeStateAsUpdate(resumed)).toString('base64');const draftTip=await restarted.save(draft,promoted.tip);const reloaded=await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true).load();assert.equal(reloaded!.hash,draftTip);const again=new Y.Doc();try{Y.applyUpdate(again,Buffer.from(reloaded!.capsule.document,'base64'));assert.equal(new WordRegionStore(again,schema,'doc',next.flowLayout,next.flowLayoutHash).project(id(3)).textContent,'Continued footer')}finally{again.destroy()}}finally{resumed.destroy()}
  const path=join(journal.directory,`${lateTip}.next`),original=await fs.readFile(path),outer=JSON.parse(gunzipSync(original).toString('utf8')),changed=JSON.parse(outer.payload);changed.storyAcknowledgement.pending.blocks[0].content.inlines[0].text='substituted';outer.payload=JSON.stringify(changed);outer.signature=createHmac('sha256',secret).update(`${lateTip}\0${outer.payload}`).digest('hex');await fs.writeFile(path,gzipSync(Buffer.from(JSON.stringify(outer))))
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true).load(),/word-journal-invalid/);await fs.writeFile(path,original)
  const foreign=new Y.Doc();try{new WordRegionStore(foreign,schema,'doc',next.flowLayout,next.flowLayoutHash).initialize(next);const forged=JSON.parse(gunzipSync(original).toString('utf8')),payload=JSON.parse(forged.payload);payload.document=Buffer.from(Y.encodeStateAsUpdate(foreign)).toString('base64');forged.payload=JSON.stringify(payload);forged.signature=createHmac('sha256',secret).update(`${lateTip}\0${forged.payload}`).digest('hex');await fs.writeFile(path,gzipSync(Buffer.from(JSON.stringify(forged))));await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true).load(),/word-journal-invalid/)}finally{foreign.destroy();await fs.writeFile(path,original)}
 }finally{initialDoc.destroy();await f.close()}
})
test('ordinary journal saves cannot silently publish a new story topology over a durable draft',async()=>{
 const f=await fixture();try{
  const initial=wordSaveCapsule(f.journal.scope,f.model,f.base,people),tip=await f.journal.save(initial,'none'),next=structuredClone(projection)
  next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(3),kind:'footer',sourcePart:'word/footer1.xml'});next.flowLayout.sections[0].footers.default=id(3)
  next.blocks.push({flowRegionId:id(3),blockId:id(13),blockHash:'a'.repeat(64),region:'footer',readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}})
  const intent={sectionId:id(1),kind:'footer' as const,variant:'default' as const,expectedInheritedStoryId:null},expected=structuredClone(next.blocks.slice(-1))
  f.model.acceptStoryReceipt(projection,next,intent,expected)
  const changed=wordSaveCapsule(f.journal.scope,f.model,{revision:2,rootHash:'d'.repeat(64),layoutHash:next.flowLayoutHash,digest:hash(f.model.contents())},people)
  await assert.rejects(f.journal.save(changed,tip),/word-story-coordinator-required/)
  const recovered=await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load();assert.equal(recovered!.hash,tip)
  const old=new Y.Doc();try{Y.applyUpdate(old,Buffer.from(recovered!.capsule.document,'base64'));const restored=new WordRegionStore(old,schema,'doc',layout,projection.flowLayoutHash);assert.equal(restored.project(id(2)).textContent,'Captured header 😀')}finally{old.destroy()}
  assert.equal(f.model.project(id(3)).textContent,'New footer')
  const payload=JSON.stringify(changed),signature=createHmac('sha256',secret).update(`${tip}\0${payload}`).digest('hex')
  await fs.writeFile(join(f.journal.directory,`${tip}.next`),gzipSync(Buffer.from(JSON.stringify({version:1,previous:tip,payload,signature}))))
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load(),/word-journal-invalid/)
 }finally{await f.close()}
})
test('a restart loads the same prepared request, bindings, authors and later unaccepted Yjs edits',async()=>{
 const f=await fixture();try{
  assert.equal(await f.journal.load(),undefined);const first=await f.journal.save(f.capsule(),'none');f.edit('Late header input 😀');const second=await f.journal.save(f.capsule(),first)
  const restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret),loaded=await restarted.load();assert.equal(loaded!.hash,second);assert.deepEqual(restarted.knownHashes(),['none',first,second]);const copy=restarted.knownHashes();copy.pop();assert.equal(restarted.knownHashes().length,3);assert.deepEqual(loaded!.capsule.pending,f.pending)
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(loaded!.capsule.document,'base64'));const model=new WordRegionStore(restored,schema,'doc',layout,projection.flowLayoutHash);assert.equal(model.project(id(2)).textContent,'Late header input 😀');assert.equal(loaded!.capsule.actors[0].generation,2);assert.equal(loaded!.capsule.pending!.actors[0].generation,1)}finally{restored.destroy()}
  if(process.platform!=='win32'){assert.equal((await fs.stat(join(f.journal.directory,'none.next'))).mode&0o777,0o600);assert.equal((await fs.stat(f.journal.directory)).mode&0o777,0o700)}
 }finally{await f.close()}
})
test('opt-in layout preparation retains exact request and late regional input while old readers reject it',async()=>{
 const f=await fixture();try{
  const capsule=f.capsule();capsule.version=2;delete capsule.pending;capsule.pendingLayout={actor:people[0],request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'e'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:f.base.layoutHash,changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:12240}]}}}
  assert.throws(()=>validateWordSaveCapsule(capsule,f.journal.scope),/word-journal-invalid/)
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true),first=await journal.save(capsule,'none');f.edit('Late header after layout preparation 😀')
  const later=wordSaveCapsule(journal.scope,f.model,f.base,[{...people[0],generation:2}]);later.version=2;later.pendingLayout=structuredClone(capsule.pendingLayout)
  const tip=await journal.save(later,first),restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true),loaded=await restarted.load()
  assert.equal(loaded!.hash,tip);assert.deepEqual(loaded!.capsule.pendingLayout,capsule.pendingLayout)
  const replaced=structuredClone(later);replaced.pendingLayout!.request.transactionId='f'.repeat(32)
  await assert.rejects(restarted.save(replaced,tip),/word-layout-pending-unresolved/)
  const cleared=structuredClone(later);cleared.version=1;delete cleared.pendingLayout
  await assert.rejects(restarted.save(cleared,tip),/word-layout-pending-unresolved/);assert.equal((await restarted.load())!.hash,tip)
  const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(loaded!.capsule.document,'base64'));const model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);assert.equal(model.project(id(2)).textContent,'Late header after layout preparation 😀')}finally{doc.destroy()}
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load(),/word-journal-invalid/)
  const {WordSaveCoordinator}=await import('./wordSaveCoordinator.ts'),{WordRecoveryReview}=await import('./wordRecoveryReview.ts')
  let requests=0;await assert.rejects(WordSaveCoordinator.open({journal:restarted,protocol:'hcd-word-regions/1',request:async()=>{requests++;throw Error('unexpected request')}}),/word-layout-coordinator-required/);assert.equal(requests,0)
  await assert.rejects(new WordRecoveryReview({journal:restarted,native:async()=>{throw Error('unexpected native read')}}).list(),/word-layout-coordinator-required/)
  for(const mutate of [(c:any)=>{c.pendingLayout.request.expectedRevision=2},(c:any)=>{c.pendingLayout.request.edits.baseLayoutHash='f'.repeat(64)},(c:any)=>{c.pendingLayout.request.edits.changes[0].sectionId=id(2)},(c:any)=>{c.pendingLayout.request.edits.changes[0].value=-1},(c:any)=>{c.pendingLayout.request.actor.userId='bob'},(c:any)=>{c.pendingLayout.request.edits.changes.push(c.pendingLayout.request.edits.changes[0])},(c:any)=>{c.pending=f.pending}]){const invalid=structuredClone(later);mutate(invalid);assert.throws(()=>validateWordSaveCapsule(invalid,journal.scope,true))}
 }finally{await f.close()}
})
test('offline layout acknowledgement validates signature, exact layout and canonical body before advancing the durable draft',async()=>{
 const f=await fixture();try{
  const capsule=f.capsule();capsule.version=2;delete capsule.pending;capsule.pendingLayout={actor:people[0],request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'e'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:f.base.layoutHash,changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:12240}]}}}
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true),tip=await journal.save(capsule,'none'),request=capsule.pendingLayout.request
  const record={documentId:'doc',authorId:'alice',authorName:'Alice',revision:2,patchBaseRevision:1,patchId:'word-layout-'+request.transactionId,patchHash:wordLayoutRequestHash(request),rootHash:'f'.repeat(64),wordLayoutChange:true}
  const receipt={schemaVersion:'hcd-layout-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:request.transactionId,requestHash:record.patchHash,rootHash:record.rootHash,signature:''}
  receipt.signature=createHmac('sha256',secret).update(`hcd-layout-receipt/1:doc:0:${lineage}:${tip}:1:2:${request.transactionId}:${record.patchHash}:${record.rootHash}`).digest('base64url')
  const next=structuredClone(projection);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.sections[0].page.widthTwips=12240
  const invalid=structuredClone(next);invalid.flowLayout.sections[0].page.heightTwips=9000
  const altered=structuredClone(next);altered.blocks[0].content.inlines[0].text='not the committed body'
  await assert.rejects(journal.acknowledgeLayout(record,{...receipt,signature:'x'.repeat(43)},projection,next,tip,()=>{}),/word-layout-receipt-invalid/)
  await assert.rejects(journal.acknowledgeLayout(record,receipt,projection,invalid,tip,()=>{}),/wordRegionLayoutChanged/)
  await assert.rejects(journal.acknowledgeLayout(record,receipt,projection,altered,tip,()=>{}),/word-layout-content-changed/)
  let guards=0;await assert.rejects(journal.acknowledgeLayout(record,receipt,projection,next,tip,()=>{if(++guards===2)throw Error('lease-lost')}),/lease-lost/)
  assert.equal((await journal.load())!.hash,tip);assert.ok((await journal.load())!.capsule.pendingLayout)
  const saved=await journal.acknowledgeLayout(record,receipt,projection,next,tip,()=>{});assert.equal(saved.capsule.version,2);assert.equal(saved.capsule.base.revision,2);assert.equal(saved.capsule.pendingLayout,undefined);assert.deepEqual(saved.capsule.layoutAcknowledgement?.receipt,receipt)
  const restarted=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true),loaded=await restarted.load();assert.equal(loaded!.hash,saved.tip);assert.equal(loaded!.capsule.base.layoutHash,next.flowLayoutHash)
  assert.deepEqual(loaded!.capsule.layoutAcknowledgement?.request,request);const forged=structuredClone(loaded!.capsule);(forged.layoutAcknowledgement!.receipt as any).signature='x'.repeat(43);await assert.rejects(restarted.archiveSnapshot(forged,'word-owner-lost'),/word-journal-invalid/)
  const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(loaded!.capsule.document,'base64'));const model=new WordRegionStore(doc,schema,'doc',next.flowLayout,next.flowLayoutHash);assert.equal(model.project(id(2)).textContent,'Captured header 😀')}finally{doc.destroy()}
  await assert.rejects(restarted.acknowledgeLayout(record,receipt,projection,next,tip,()=>{}),/word-layout-pending-unresolved/)
  const forgedPromotion=structuredClone(loaded!.capsule);forgedPromotion.version=3;delete forgedPromotion.layoutAcknowledgement;forgedPromotion.actors=[]
  await assert.rejects(restarted.save(forgedPromotion,saved.tip),/word-layout-coordinator-required/)
  const promoted=await restarted.promoteLayoutAcknowledgement(saved.tip,()=>{});assert.equal(promoted.capsule.version,3);assert.equal(promoted.capsule.document,loaded!.capsule.document)
  const changedIdleBase=structuredClone(promoted.capsule);changedIdleBase.base.rootHash='d'.repeat(64);await assert.rejects(restarted.save(changedIdleBase,promoted.tip),/word-checkpoint-baseline-changed/)
  const working=new Y.Doc();try{
   Y.applyUpdate(working,Buffer.from(promoted.capsule.document,'base64'));const model=new WordRegionStore(working,schema,'doc',next.flowLayout,next.flowLayoutHash),capture=model.capture(),pending:WordPendingCheckpoint={capture,actors:people,request:{coordinatorVersion:6,coordinatorId:lineage,checkpointId:'d'.repeat(32),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:2,layoutHash:next.flowLayoutHash,typographyVersion:2,regions:capture.regions.map(region=>({...region,images:[]})),contributors:people.map(({userId,displayName})=>({userId,displayName}))}}
   const capsule=structuredClone(promoted.capsule);capsule.pending=pending;const prepared=await restarted.save(capsule,promoted.tip)
   const unsigned=`hcdsave6:${lineage}:${pending.request.checkpointId}:${pending.request.coordinatorDigest}:${'a'.repeat(64)}`,signature=createHmac('sha256',secret).update(`doc:0:2:${unsigned}`).digest('base64url'),checkpointRecord={revision:3,patchBaseRevision:2,rootHash:'c'.repeat(64),patchId:`${unsigned}:${signature}`}
   assert.equal(restarted.verifyCheckpointRecord(checkpointRecord,pending.request),true);assert.equal(restarted.verifyCheckpointRecord({...checkpointRecord,patchId:checkpointRecord.patchId.replace('hcdsave6','hcdsave5')},pending.request),false)
   const before=model.region(id(2)),node=before[0].node;model.reconcile(id(2),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,schema.text('Late v2 checkpoint input'))}]);capsule.document=Buffer.from(Y.encodeStateAsUpdate(working)).toString('base64');const late=await restarted.save(capsule,prepared)
   const changed=structuredClone(capsule);changed.pending!.request.checkpointId='e'.repeat(32);await assert.rejects(restarted.save(changed,late),/word-checkpoint-pending-unresolved/)
   const changedBase=structuredClone(capsule);changedBase.base.rootHash='d'.repeat(64);await assert.rejects(restarted.save(changedBase,late),/word-checkpoint-pending-unresolved/)
   const cleared=structuredClone(capsule);delete cleared.pending;await assert.rejects(restarted.save(cleared,late),/word-checkpoint-pending-unresolved/)
   const downgraded=structuredClone(capsule);downgraded.version=1;downgraded.pending!.request.coordinatorVersion=5;await assert.rejects(restarted.save(downgraded,late),/word-layout-coordinator-required/)
   const recovered=await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true).load();assert.deepEqual(recovered!.capsule.pending,pending);const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(recovered!.capsule.document,'base64'));assert.equal(new WordRegionStore(restored,schema,'doc',next.flowLayout,next.flowLayoutHash).project(id(2)).textContent,'Late v2 checkpoint input')}finally{restored.destroy()}await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load(),/word-journal-invalid/)
  }finally{working.destroy()}
  const promotionPath=join(journal.directory,`${saved.tip}.next`),originalPromotion=await fs.readFile(promotionPath),invalidPromotion=JSON.parse(gunzipSync(originalPromotion).toString('utf8')),modifiedPromotion=JSON.parse(invalidPromotion.payload);modifiedPromotion.actors=[];invalidPromotion.payload=JSON.stringify(modifiedPromotion);invalidPromotion.signature=createHmac('sha256',secret).update(`${saved.tip}\0${invalidPromotion.payload}`).digest('hex');await fs.writeFile(promotionPath,gzipSync(Buffer.from(JSON.stringify(invalidPromotion))))
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true).load(),/word-journal-invalid/);await fs.writeFile(promotionPath,originalPromotion)
  // Even a separately valid HMAC for a different journal tip must not be
  // grafted onto this chain; every acknowledgement names its actual parent.
  const wrong='a'.repeat(64),bad=structuredClone(loaded!.capsule),proof=bad.layoutAcknowledgement!,wrongReceipt=proof.receipt as typeof receipt
  proof.journalHash=wrong;wrongReceipt.journalHash=wrong;wrongReceipt.signature=createHmac('sha256',secret).update(`hcd-layout-receipt/1:doc:0:${lineage}:${wrong}:1:2:${request.transactionId}:${record.patchHash}:${record.rootHash}`).digest('base64url')
  const path=join(journal.directory,`${tip}.next`),outer=JSON.parse(gunzipSync(await fs.readFile(path)).toString('utf8'));outer.payload=JSON.stringify(bad);outer.signature=createHmac('sha256',secret).update(`${tip}\0${outer.payload}`).digest('hex');await fs.writeFile(path,gzipSync(Buffer.from(JSON.stringify(outer))))
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true).load(),/word-journal-invalid/)
 }finally{await f.close()}
})
test('two journal owners cannot replace the same parent or silently fork its prepared request',async()=>{
 const f=await fixture();try{
  const other=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret);await Promise.all([f.journal.load(),other.load()]);const result=await Promise.allSettled([f.journal.save(f.capsule(),'none'),other.save(f.capsule(),'none')]);assert.equal(result.filter(value=>value.status==='fulfilled').length,1);assert.match(String((result.find(value=>value.status==='rejected') as PromiseRejectedResult).reason),/word-journal-changed/)
  const before=await fs.readFile(join(f.journal.directory,'none.next')),latest=await f.journal.load();await assert.rejects(f.journal.save(f.capsule(),'none'),/word-journal-changed/);assert.deepEqual(await fs.readFile(join(f.journal.directory,'none.next')),before);assert.equal((await f.journal.load())!.hash,latest!.hash)
 }finally{await f.close()}
})
test('API/document/epoch/lineage scopes and signing secrets cannot adopt another recovery chain',async()=>{
 const f=await fixture();try{
  await f.journal.save(f.capsule(),'none');for(const [url,doc,epoch,branch]of [[api+'other','doc',0,lineage],[api,'other',0,lineage],[api,'doc',1,lineage],[api,'doc',0,'e'.repeat(32)]] as const){const other=new WordCheckpointJournal(f.root,url,doc,epoch,branch,secret);await fs.mkdir(other.directory,{recursive:true});await fs.copyFile(join(f.journal.directory,'none.next'),join(other.directory,'none.next'));await assert.rejects(other.load(),/word-journal-invalid/)}
  const wrong=new WordCheckpointJournal(f.root,api,'doc',0,lineage,'a-different-long-secret-with-more-than-thirty-two-bytes');await assert.rejects(wrong.load(),/word-journal-invalid/)
 }finally{await f.close()}
})
test('tampering, malformed pending source bindings, missing actors and unsupported models fail without publishing',async()=>{
 const f=await fixture();try{
  for(const change of [(c:any)=>{c.pending.request.coordinatorVersion=4},(c:any)=>{c.pending.request.regions.pop()},(c:any)=>{c.pending.request.coordinatorDigest='f'.repeat(64)},(c:any)=>{c.pending.capture.sources[0].bindings[0].pieces[0].offset=20},(c:any)=>{c.pending.actors=[];c.pending.request.contributors=[]},(c:any)=>{c.actors[0].generation=0},(c:any)=>{c.document='not base64'},(c:any)=>{c.document=Buffer.from('invalid Yjs').toString('base64')},(c:any)=>{c.base.layoutHash='f'.repeat(64)}]){
   const capsule=f.capsule();change(capsule);assert.throws(()=>validateWordSaveCapsule(capsule,f.journal.scope));await assert.rejects(f.journal.save(capsule,'none'));assert.equal(await f.journal.load(),undefined)
  }
 }finally{await f.close()}
})
test('orphan temporary files are ignored, while a corrupt linked record cannot be mistaken for an older saved state',async()=>{
 const f=await fixture();try{
  const tip=await f.journal.save(f.capsule(),'none');await fs.writeFile(join(f.journal.directory,'orphan.tmp'),'incomplete');assert.equal((await f.journal.load())!.hash,tip)
  await fs.writeFile(join(f.journal.directory,tip+'.next'),'incomplete');await assert.rejects(f.journal.load());assert.equal((await fs.readFile(join(f.journal.directory,tip+'.next'),'utf8')),'incomplete')
 }finally{await f.close()}
})
test('symlink files and oversized records are rejected without modifying their target',async()=>{
 const f=await fixture();try{
  const tip=await f.journal.save(f.capsule(),'none'),target=join(f.root,'outside'),next=join(f.journal.directory,tip+'.next');await fs.writeFile(target,'keep')
  if(process.platform!=='win32'){await fs.symlink(target,next);await assert.rejects(f.journal.load());assert.equal(await fs.readFile(target,'utf8'),'keep');await fs.unlink(next)}
  const fd=await fs.open(next,'w');await fd.truncate(16*1024*1024+1);await fd.close();await assert.rejects(f.journal.load(),/word-journal-invalid/)
 }finally{await f.close()}
})

test('regional image captures bind region, exact payload and unique acknowledged intent IDs in the private journal',async()=>{
 const f=await fixture();try{
  const nodeId=id(90),intentId='11111111-1111-4111-8111-111111111111',base={nodeId,visualHash:'a'.repeat(64),assetHash:'b'.repeat(64),geometry:{unit:'emu' as const,x:0,y:0,width:100,height:50}},change={nodeId,geometry:{...base.geometry,width:180},assetHash:'e'.repeat(64),precondition:{visualHash:base.visualHash}}
  f.pending.images=[{intentId,intentIds:[intentId],clientId:1,base,change,regionId:id(2)}];f.pending.request.regions[1].images=[structuredClone(change)]
  const capsule=f.capsule();assert.equal(validateWordSaveCapsule(capsule,f.journal.scope).pending!.images!.length,1)
  for(const mutate of [(c:any)=>{delete c.pending.images},(c:any)=>{c.pending.images[0].regionId=id(1)},(c:any)=>{c.pending.images[0].change.geometry.width=999},(c:any)=>{c.pending.images[0].intentIds=[]},(c:any)=>{c.pending.images[0].intentIds.push(intentId)},(c:any)=>{c.pending.images[0].base.visualHash='f'.repeat(64)},(c:any)=>{c.pending.request.regions[0].images=c.pending.request.regions[1].images}]){const invalid=structuredClone(capsule);mutate(invalid);assert.throws(()=>validateWordSaveCapsule(invalid,f.journal.scope))}
  await f.journal.save(capsule,'none');assert.deepEqual((await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load())!.capsule.pending!.images,f.pending.images)
 }finally{await f.close()}
})

test('upload reservations validate private identity, size, region, source capture and lifecycle without storing file bytes or tokens',async()=>{
 const f=await fixture();try{
  const capsule=f.capsule(),upload={id:'11111111-1111-4111-8111-111111111111',nodeId:id(90),regionId:id(2),revision:1,clientId:1,actor:{userId:'bob',displayName:'Bob'},extension:'png' as const,assetHash:'f'.repeat(64),byteLength:72,seen:[],phase:'reserved' as const};capsule.uploads=[upload]
  validateWordSaveCapsule(capsule,f.journal.scope)
  for(const change of [(c:any)=>{c.uploads[0].phase='done'},(c:any)=>{c.uploads[0].phase='applied'},(c:any)=>{c.uploads[0].byteLength=8*1024*1024+1},(c:any)=>{c.uploads[0].regionId=id(999)},(c:any)=>{c.uploads[0].revision=2},(c:any)=>{c.uploads[0].actor.token='forbidden'},(c:any)=>{c.uploads[0].bytes='not allowed'},(c:any)=>{c.uploads.push(c.uploads[0])}]){const invalid=structuredClone(capsule);change(invalid);assert.throws(()=>validateWordSaveCapsule(invalid,f.journal.scope))}
  await f.journal.save(capsule,'none');const reopened=(await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load())!.capsule;assert.deepEqual(reopened.uploads,[upload]);assert.equal(JSON.stringify(reopened.uploads).includes('token'),false)
 }finally{await f.close()}
})

test('owner-loss archives preserve a signed capsule without advancing the active chain and reject tampering',async()=>{
 const f=await fixture();try{const tip=await f.journal.save(f.capsule(),'none'),id=await f.journal.archiveSnapshot(f.capsule(),'word-owner-lost');assert.equal((await f.journal.load())!.hash,tip);assert.deepEqual((await f.journal.recoverySnapshots())[0].capsule,f.capsule());const path=join(f.journal.directory,`recovery-${id}.gz`);const bytes=await fs.readFile(path);bytes[Math.floor(bytes.length/2)]^=1;await fs.writeFile(path,bytes);await assert.rejects(f.journal.recoverySnapshots());assert.equal((await f.journal.load())!.hash,tip)}finally{await f.close()}
})
test('the ownership fence is checked again immediately before linking a prepared record',async()=>{
 const f=await fixture();try{const tip=await f.journal.save(f.capsule(),'none');let checks=0;await assert.rejects(f.journal.save(f.capsule(),tip,()=>{if(++checks===2)throw new Error('word-owner-lost')}),/word-owner-lost/);assert.equal(checks,2);assert.equal((await f.journal.load())!.hash,tip)}finally{await f.close()}
})
test('a fence lost during journal publication reports a committed record and requires reloading it',async()=>{
 const f=await fixture();try{
  const previous=await f.journal.save(f.capsule(),'none');f.edit('input retained after fence loss');const later=f.capsule();let checks=0
  await assert.rejects(f.journal.save(later,previous,()=>{if(++checks===3)throw new Error('word-owner-lost')}),/word-journal-published-fence-lost/)
  const reopened=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret),saved=await reopened.load();assert.ok(saved);assert.notEqual(saved.hash,previous);assert.deepEqual(saved.capsule.pending,later.pending)
  const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(saved.capsule.document,'base64'));assert.equal(new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash).project(id(2)).textContent,'input retained after fence loss')}finally{doc.destroy()}
  await assert.rejects(f.journal.save(later,previous),/word-journal-changed/)
 }finally{await f.close()}
})


test('a story operator need not be a text draft author on a clean document',async()=>{
 const f=await fixture();try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),initial=wordSaveCapsule(journal.scope,f.model,f.base,[]),tip=await journal.save(initial,'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  const wrong=structuredClone(pending);wrong.request.actor.userId='other';await assert.rejects(journal.prepareStory(wrong,tip,()=>{}),/word-journal-invalid/)
  const prepared=await journal.prepareStory(pending,tip,()=>{});assert.deepEqual(prepared.capsule.actors,[]);assert.deepEqual(prepared.capsule.pendingStory,pending)
  const reopened=await new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true).load();assert.deepEqual(reopened!.capsule.actors,[]);assert.deepEqual(reopened!.capsule.pendingStory,pending)
 }finally{await f.close()}
})
test('layout genesis is explicit, clean, durable and refused by old readers',async()=>{
 const f=await fixture(),doc=new Y.Doc()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},observation=(await import('./wordDraftObservation.ts')).wordDraftObservation(model),capsule=wordSaveCapsule(journal.scope,model,base,[],undefined,{observation,references:[]},3)
  await assert.rejects(journal.save(capsule,'none'),/word-layout-coordinator-required/)
  await assert.rejects(journal.initializeLayout({...capsule,actors:people},()=>{}),/word-layout-coordinator-required/)
  const tip=await journal.initializeLayout(capsule,()=>{});assert.equal((await journal.load())?.hash,tip)
  await assert.rejects(journal.initializeLayout(capsule,()=>{}),/word-journal-changed/)
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret).load(),/word-journal-invalid/)
 }finally{doc.destroy();await f.close()}
})
test('fresh stopped layout refuses to initialize over an archived recovery copy',async()=>{
 const f=await fixture()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true)
  await journal.archiveSnapshot(f.capsule(),'word-owner-lost')
  let calls=0
  const {inspectStoppedWordLayout}=await import('./wordStoppedLayout.ts')
  await assert.rejects(inspectStoppedWordLayout({journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request:async()=>{calls++;throw Error('unexpected request')},assertStopped:()=>{},authorizeMember:async()=>{}}),/word-owner-recovery-required/)
  assert.equal(calls,0);assert.equal(await journal.load(),undefined)
 }finally{await f.close()}
})
test('a clean stopped baseline survives a lost initial owner-record response',async()=>{
 const f=await fixture()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true)
  let calls=0,records=0
  const request=async(route:string)=>{calls++;if(route==='/revisions?limit=1')return Response.json({headRevision:1});if(route==='/revisions/1')return Response.json({revision:1,rootHash:'c'.repeat(64)});if(route==='/editor?revision=1')return Response.json(projection);if(route==='/word/layout?revision=1')return Response.json({revision:1,layoutHash:projection.flowLayoutHash,layout});throw Error('unexpected request '+route)}
  const lease={assert:()=>{},renew:async()=>{},recordJournal:async()=>{records++;if(records===1)throw Error('lost owner response')}}
  const {inspectStoppedWordLayout}=await import('./wordStoppedLayout.ts'),options={journal,lease,request,assertStopped:()=>{},authorizeMember:async()=>{}}
  await assert.rejects(inspectStoppedWordLayout(options),/lost owner response/);assert.equal((await journal.load())?.capsule.version,3)
  const resumed=await inspectStoppedWordLayout(options);assert.equal(resumed.revision,1);assert.equal(records,2);assert.ok(calls>0)
 }finally{await f.close()}
})
test('unprepared topology cancellation survives restart and rejects tampering',async()=>{
 const f=await fixture(),doc=new Y.Doc()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},observation=(await import('./wordDraftObservation.ts')).wordDraftObservation(model),capsule=wordSaveCapsule(journal.scope,model,base,[],undefined,{observation,references:[]},3),id='5'.repeat(32)
  await journal.initializeLayout(capsule,()=>{});await journal.abandonUnpreparedTopology(id,()=>{});await journal.abandonUnpreparedTopology(id,()=>{})
  const reopened=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true);assert.equal(await reopened.topologyAbandoned(id),true);assert.equal(await reopened.topologyAbandoned('6'.repeat(32)),false)
  await assert.rejects(journal.prepareStory({request:{transactionId:id}} as any,journal.knownHashes().at(-1)!,()=>{}),/word-topology-cancelled/);await assert.rejects(journal.prepareLayout({request:{transactionId:id}} as any,journal.knownHashes().at(-1)!,()=>{}),/word-topology-cancelled/)
  const path=join(journal.directory,`cancelled-${id}.json`);await fs.writeFile(path,'{"payload":"tampered","signature":"'+('0'.repeat(64))+'"}');await assert.rejects(reopened.topologyAbandoned(id),/word-journal-invalid/)
 }finally{doc.destroy();await f.close()}
})
test('unprepared topology cancellation refuses an already prepared request',async()=>{
 const f=await fixture()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),start=await journal.save(wordSaveCapsule(journal.scope,f.model,f.base,people),'none')
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:f.base.layoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice'}},actor:people[0],intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:id(3),kind:'footer',sourcePart:'word/footer-new.xml'},copyChoices:{referenceIds:[],extensions:[]},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:'a'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{text:'New footer',nodeId:id(23)}]}}]}
  await journal.prepareStory(pending,start,()=>{});await assert.rejects(journal.abandonUnpreparedTopology(pending.request.transactionId,()=>{}),/word-topology-pending-unresolved/);assert.equal(await journal.topologyAbandoned(pending.request.transactionId),false)
 }finally{await f.close()}
})
test('unprepared checkpoint sealing survives restart and rejects tampering',async()=>{
 const f=await fixture(),doc=new Y.Doc()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},observation=(await import('./wordDraftObservation.ts')).wordDraftObservation(model),capsule=wordSaveCapsule(journal.scope,model,base,[],undefined,{observation,references:[]},3),checkpoint='7'.repeat(32)
  await journal.initializeLayout(capsule,()=>{});await journal.abandonUnpreparedCheckpoint(checkpoint,()=>{});await journal.abandonUnpreparedCheckpoint(checkpoint,()=>{})
  const reopened=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true);assert.equal(await reopened.checkpointAbandoned(checkpoint),true);assert.equal(await reopened.checkpointAbandoned('8'.repeat(32)),false)
  let calls=0;const {prepareStoppedWordCheckpoint}=await import('./wordStoppedCheckpoint.ts');await assert.rejects(prepareStoppedWordCheckpoint({journal:reopened,checkpointId:checkpoint,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request:async()=>{calls++;return Response.json({})},assertStopped:()=>{}}),/word-checkpoint-cancelled/);assert.equal(calls,0)
  const path=join(journal.directory,`cancelled-checkpoint-${checkpoint}.json`);await fs.writeFile(path,'{"payload":"tampered","signature":"'+('0'.repeat(64))+'"}');await assert.rejects(reopened.checkpointAbandoned(checkpoint),/word-journal-invalid/)
 }finally{doc.destroy();await f.close()}
})
test('copying inherited story requires its text and formatting to be saved, not unrelated body edits',async()=>{
 const f=await fixture(),doc=new Y.Doc()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},observe=(await import('./wordDraftObservation.ts')).wordDraftObservation,make=()=>wordSaveCapsule(journal.scope,model,base,[],undefined,{observation:observe(model),references:[]},3)
  let tip=await journal.initializeLayout(make(),()=>{});const body=model.region(id(1)),bodyNode=body[0].node;model.reconcile(id(1),body,[{key:body[0].key,node:bodyNode.type.createChecked(bodyNode.attrs,schema.text('Unrelated body draft',bodyNode.firstChild?.marks))}]);tip=await journal.save(make(),tip)
  const {requireSavedStorySource}=await import('./wordStoryDraftGuard.ts'),request=async()=>Response.json(projection);await requireSavedStorySource(journal,request,()=>{},id(2),tip)
  const header=model.region(id(2)),node=header[0].node,marks=[...(node.firstChild?.marks??[]),schema.marks.bold.create()];model.reconcile(id(2),header,[{key:header[0].key,node:node.type.createChecked(node.attrs,schema.text(node.textContent,marks))}]);tip=await journal.save(make(),tip)
  await assert.rejects(requireSavedStorySource(journal,request,()=>{},id(2),tip),/word-story-source-draft-pending/)
 }finally{doc.destroy();await f.close()}
})
test('copying inherited story waits for its pending upload but not an upload in the body',async()=>{
 const f=await fixture(),doc=new Y.Doc()
 try{
  const journal=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true,true),model=new WordRegionStore(doc,schema,'doc',layout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())},observe=(await import('./wordDraftObservation.ts')).wordDraftObservation,make=()=>wordSaveCapsule(journal.scope,model,base,[],undefined,{observation:observe(model),references:[]},3)
  const upload={id:'11111111-1111-4111-8111-111111111111',nodeId:id(90),regionId:id(1),revision:1,clientId:1,actor:{userId:'bob',displayName:'Bob'},extension:'png' as const,assetHash:'f'.repeat(64),byteLength:72,seen:[],base:{nodeId:id(90),visualHash:'a'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},phase:'reserved' as const}
  let tip=await journal.initializeLayout(make(),()=>{});const capsule=make();capsule.uploads=[upload];tip=await journal.save(capsule,tip)
  const {requireSavedStorySource}=await import('./wordStoryDraftGuard.ts'),request=async()=>Response.json(projection)
  await requireSavedStorySource(journal,request,()=>{},id(2),tip)
  for(const phase of ['reserved','staged','interrupted'] as const){const changed=make();changed.uploads=[{...upload,regionId:id(2),phase}];tip=await journal.save(changed,tip);await assert.rejects(requireSavedStorySource(journal,request,()=>{},id(2),tip),/word-story-source-draft-pending/)}
 }finally{doc.destroy();await f.close()}
})
