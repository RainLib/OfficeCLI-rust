import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {gzipSync,gunzipSync} from 'node:zlib'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,type WordRegionProjection} from './wordRegionStore.ts'
import {WordCheckpointJournal,wordSaveCapsule,type WordPendingCheckpoint} from './wordCheckpointJournal.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {recoverPreparedWordCheckpoint} from './wordCheckpointRecovery.ts'

const secret='word-unchanged-ancestor-test-secret-at-least-thirty-two-bytes',lineage='b'.repeat(32),api='http://qa.invalid/word'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'hcd-word-noop-ancestor-')),document=new Y.Doc(),schema=wordRegionSchema()
 const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayoutHash:'a'.repeat(64),flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{},footers:{}}],stories:[]},blocks:[{blockId:id(11),blockHash:'a'.repeat(64),flowRegionId:id(1),region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{nodeId:id(21),text:'Body'}]}}]}
 const journal=new WordCheckpointJournal(root,api,'doc',0,lineage,secret,true),model=new WordRegionStore(document,schema,'doc',projection.flowLayout,projection.flowLayoutHash);model.initialize(projection)
 const base={revision:1,rootHash:'c'.repeat(64),layoutHash:projection.flowLayoutHash,digest:hash(model.contents())}
 const make=(pending?:WordPendingCheckpoint,generation=1)=>wordSaveCapsule(journal.scope,model,base,pending?[{userId:'alice',displayName:'Alice',generation}]:[],pending,{observation:wordDraftObservation(model),references:[]},3)
 const genesis=await journal.initializeLayout(make(),()=>{}),capture=model.capture()
 const pending:WordPendingCheckpoint={capture,actors:[{userId:'alice',displayName:'Alice',generation:1}],initiator:{userId:'alice',displayName:'Alice'},request:{coordinatorVersion:6,coordinatorId:lineage,checkpointId:'d'.repeat(32),coordinatorDigest:hash(wordCheckpointContents(capture)),expectedRevision:1,layoutHash:base.layoutHash,typographyVersion:2,regions:capture.regions.map(region=>({...region,images:[]})),contributors:[{userId:'alice',displayName:'Alice'}]}}
 const submitted=await journal.save(make(pending),genesis)
 const receiptAt=(journalHash:string)=>{
  const requestHash=hash(JSON.stringify(pending.request)),unsigned=`hcdsave6:${lineage}:${pending.request.checkpointId}:${pending.request.coordinatorDigest}:${requestHash}`,patchId=unsigned+':'+createHmac('sha256',secret).update(`doc:0:1:${unsigned}`).digest('base64url')
  const value={schemaVersion:'hcd-word-checkpoint-unchanged/2',documentId:'doc',epoch:0,journalHash,requestHash,revision:1,rootHash:base.rootHash,patchId,signature:''}
  value.signature=createHmac('sha256',secret).update(`hcd-word-checkpoint-unchanged/2:doc:0:${journalHash}:${requestHash}:1:${base.rootHash}:${patchId}`).digest('base64url');return value
 }
 const before=model.region(id(1)),block=before[0];model.reconcile(id(1),before,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Late durable input 😀',block.node.firstChild?.marks))}])
 const latest=await journal.save(make(pending,2),submitted)
 return{root,document,model,journal,base,projection,pending,genesis,submitted,latest,receiptAt,close:async()=>{document.destroy();await rm(root,{recursive:true,force:true})}}
}

test('an original no-op receipt acknowledges its exact prepared ancestor and retains late durable input and attribution',async()=>{
 const f=await fixture()
 try{
  const receipt=f.receiptAt(f.submitted),ack=await f.journal.acknowledgeUnchanged(receipt,{revision:1,rootHash:f.base.rootHash},f.projection,f.latest,()=>{})
  assert.equal(ack.capsule.pending,undefined);assert.deepEqual(ack.capsule.base,f.base)
  assert.equal(ack.capsule.unchangedAcknowledgement?.journalHash,f.latest);assert.equal(ack.capsule.unchangedAcknowledgement?.requestJournalHash,f.submitted)
  assert.deepEqual(ack.capsule.actors,[{userId:'alice',displayName:'Alice',generation:2}])
  const reopened=new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true),saved=await reopened.load(),doc=new Y.Doc()
  try{assert.equal(saved!.hash,ack.tip);Y.applyUpdate(doc,Buffer.from(saved!.capsule.document,'base64'));assert.equal(new WordRegionStore(doc,wordRegionSchema(),'doc',f.projection.flowLayout,f.base.layoutHash).project(id(1)).textContent,'Late durable input 😀');assert.deepEqual(await reopened.checkpointRecoveryIdentity(f.pending.request.checkpointId),{initiator:f.pending.initiator,baseRevision:1,acknowledged:true,revision:1})}finally{doc.destroy()}
 }finally{await f.close()}
})

test('receipt-first recovery reads the original no-op result after the journal advances without resubmitting it',async()=>{
 const f=await fixture(),routes:string[]=[]
 try{
  const request=async(route:string)=>{routes.push(route);if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'});if(route==='/revisions?limit=1')return Response.json({headRevision:1});if(route==='/revisions/1')return Response.json({revision:1,rootHash:f.base.rootHash});if(route==='/word/checkpoint-receipt')return Response.json(f.receiptAt(f.submitted));if(route==='/editor?revision=1')return Response.json(f.projection);throw new Error(`Unexpected request: ${route}`)}
  const result=await recoverPreparedWordCheckpoint({journal:f.journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request,assertStopped:()=>{},receiptFirst:true})
  assert.equal(result.capsule.base.revision,1);assert.equal(result.capsule.pending,undefined);assert.equal(result.capsule.unchangedAcknowledgement?.requestJournalHash,f.submitted);assert.equal(routes.includes('/word/checkpoints'),false)
 }finally{await f.close()}
})

test('validly signed no-op receipts from an unprepared or foreign tip cannot clear the current request',async()=>{
 const f=await fixture()
 try{for(const journalHash of [f.genesis,'f'.repeat(64)]){await assert.rejects(f.journal.acknowledgeUnchanged(f.receiptAt(journalHash),{revision:1,rootHash:f.base.rootHash},f.projection,f.latest,()=>{}),/word-checkpoint-receipt-invalid/);assert.equal((await f.journal.load())!.hash,f.latest);assert.deepEqual((await f.journal.load())!.capsule.pending,f.pending)}}finally{await f.close()}
})

test('reopening rejects an ancestor claim that has a valid outer signature but no matching prepared ancestor',async()=>{
 const f=await fixture()
 try{
  await f.journal.acknowledgeUnchanged(f.receiptAt(f.submitted),{revision:1,rootHash:f.base.rootHash},f.projection,f.latest,()=>{})
  const path=join(f.journal.directory,`${f.latest}.next`),envelope=JSON.parse(gunzipSync(await readFile(path)).toString()),capsule=JSON.parse(envelope.payload)
  capsule.unchangedAcknowledgement.requestJournalHash=f.genesis;capsule.unchangedAcknowledgement.receipt=f.receiptAt(f.genesis)
  envelope.payload=JSON.stringify(capsule);envelope.signature=createHmac('sha256',secret).update(`${f.latest}\0${envelope.payload}`).digest('hex')
  await writeFile(path,gzipSync(Buffer.from(JSON.stringify(envelope))))
  await assert.rejects(new WordCheckpointJournal(f.root,api,'doc',0,lineage,secret,true).load(),/word-journal-invalid/)
 }finally{await f.close()}
})
