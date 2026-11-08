import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import * as Y from 'yjs'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordRoomBinding} from './wordRoomBinding.ts'
import {WordCheckpointJournal,wordStoryRequestHash,wordStoryPendingHash,wordLayoutRequestHash,type WordPendingStory,type WordLayoutPending} from './wordCheckpointJournal.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {transitionWordStory} from './wordStoryRoomTransition.ts'
import {transitionWordLayout} from './wordLayoutRoomTransition.ts'
import {promoteHeldWordLayout} from './wordLayoutRecovery.ts'
import {promoteRecoveredWordStory} from './wordStoryRecovery.ts'
import {installLayoutDraftRoom} from './wordLayoutRoomInstall.ts'
import {prepareStoppedWordCheckpoint} from './wordStoppedCheckpoint.ts'
import {saveStoppedWordDraft} from './wordStoppedSave.ts'
import {saveLayoutDraftRoom} from './wordLayoutRoomSave.ts'
import {WordRegionStore,type WordRegionProjection} from './wordRegionStore.ts'
import {imageDraftMap,CollaborativeImageDraftStore,imageIntents} from './collaborativeImages.ts'
import type {PositionedImage} from './imageDrafts.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
const secret='word-owner-unit-test-secret-more-than-thirty-two-bytes',lineage='b'.repeat(32),apiUrl='http://qa.invalid/word'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const sourceImage=():PositionedImage=>({nodeId:id(90),visualHash:hash('image-1'),assetHash:hash('asset-1'),geometry:{unit:'emu',x:0,y:0,width:100,height:50}})
const initial=():WordRegionProjection=>({documentId:'doc',revision:1,flowLayoutHash:hash('layout-1'),flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(n+10),blockHash:hash('block'),region:n===1?'body':'header',readOnly:false,...(n===2?{readOnlyHtml:`<p><img data-hcd-id="${id(90)}" /></p>`}:{}),content:{kind:'paragraph',inlines:[{text:n===1?'Body':'Header',nodeId:id(n+20)}]}}))})
class FakeApi{
 protocol='hcd-default/1';journalHash='none';receiptReads=0;receiptStatus:number|undefined
 head=initial();projections=new Map([[1,initial()]]);records=new Map<number,any>([[1,{revision:1,rootHash:hash('root-1')}]])
 posted:any[]=[];saved=new Map<string,any>();images=new Map([[1,sourceImage()]]);active=0;maxActive=0;drop=false;denied=false;epoch=0;hold:(()=>Promise<void>)|undefined;badReceipt=false;badImageReceipt=false;rejectStatus:number|undefined;normalizeFallback=false
 staged=new Map<string,Uint8Array>();uploadPosts=0;uploadGate:((hash:string)=>Promise<void>)|undefined;afterStage:(()=>void)|undefined;deniedActors=new Set<string>();dropUpload=false
 request=async(route:string,init?:RequestInit):Promise<Response>=>{
  if(route==='/auth')return Response.json({scope:this.denied?'read':'write',collaborationEpoch:this.epoch,collaborationProtocol:this.protocol})
  if(route==='/revisions?limit=1')return Response.json({headRevision:this.head.revision})
  if(route.startsWith('/editor?revision='))return Response.json(this.projections.get(Number(route.split('=').at(-1))))
  if(route.startsWith('/revisions/'))return Response.json(this.records.get(Number(route.split('/').at(-1))))
  if(route.startsWith('/images/')){const revision=Number(route.split('=').at(-1)),image=this.images.get(revision);return Response.json({revision,image:route.includes(id(90))?{...image,...(this.badImageReceipt?{assetHash:hash('forged-image')}:{})}:null})}
  if(route.startsWith('/staged-assets?')){this.uploadPosts++;const bytes=Uint8Array.from(init!.body as Uint8Array),assetHash=createHash('sha256').update(bytes).digest('hex');await this.uploadGate?.(assetHash);this.staged.set(assetHash,bytes);this.afterStage?.();if(this.dropUpload){this.dropUpload=false;throw new Error('upload-response-lost')}return Response.json({hash:assetHash})}
  if(route.startsWith('/staged-assets/')){const bytes=this.staged.get(route.split('/').at(-1)!);return bytes?new Response(new Uint8Array(bytes).buffer):new Response('',{status:404})}
  if(route==='/word/checkpoint-receipt'){
   this.receiptReads++;if(this.receiptStatus)return new Response(null,{status:this.receiptStatus})
   const request=JSON.parse(String(init!.body)),key=JSON.stringify(request),saved=this.saved.get(key);if(!saved)return new Response(null,{status:404})
   if(saved.saveMode==='word-regions-unchanged')return Response.json(saved.unchangedReceipt)
   const record=this.records.get(saved.revision),requestHash=hash(key),receipt={schemaVersion:'hcd-word-checkpoint-receipt/1',documentId:'doc',epoch:this.epoch,journalHash:this.journalHash,requestHash,revision:saved.revision,rootHash:record.rootHash,patchId:record.patchId,signature:''}
   receipt.signature=createHmac('sha256',secret).update(`hcd-word-checkpoint-receipt/1:doc:${this.epoch}:${receipt.journalHash}:${requestHash}:${receipt.revision}:${receipt.rootHash}:${receipt.patchId}`).digest('base64url');return Response.json(receipt)
  }
  assert.equal(route,'/word/checkpoints');const request=JSON.parse(String(init!.body)),key=JSON.stringify(request);this.posted.push(request);this.active++;this.maxActive=Math.max(this.active,this.maxActive)
  try{
   if(this.hold)await this.hold()
   if(this.denied)return new Response('',{status:403});if(this.rejectStatus)return new Response('',{status:this.rejectStatus})
   const previous=this.saved.get(key);if(previous)return Response.json({...previous,idempotentReplay:true})
   if(request.expectedRevision!==this.head.revision)return new Response('',{status:409})
   const next=structuredClone(this.head);next.revision++;next.flowLayoutHash=hash('layout-'+next.revision)
   next.blocks=request.regions.flatMap((region:any)=>region.blocks.map((block:any,index:number)=>({...block,blockId:block.blockId?.startsWith('n_')?block.blockId:id(200+index),blockHash:hash('block-'+next.revision),flowRegionId:region.regionId,region:region.regionId===id(1)?'body':'header',readOnly:false,...(region.regionId===id(2)?{readOnlyHtml:`<img data-hcd-id="${id(90)}" />`}:{}),content:structuredClone(block.content)})))
   if(this.normalizeFallback)for(const block of next.blocks)if(block.content.kind==='extension'&&block.content.extension?.contentModel!=='blocks')block.content.inlines=block.content.inlines.map(part=>({bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false,...part}))
   const image=structuredClone(this.images.get(this.head.revision)!);for(const region of request.regions)for(const change of region.images){assert.equal(region.regionId,id(2));assert.equal(change.precondition.visualHash,image.visualHash);image.geometry=change.geometry;if(change.assetHash)image.assetHash=change.assetHash;image.visualHash=hash('image-'+next.revision)}this.images.set(next.revision,image)
   for(const [index,block]of next.blocks.entries())block.content.inlines.forEach((part,span)=>part.nodeId=id(300+index*10+span))
   const unsigned=`hcdsave${request.coordinatorVersion}:${request.coordinatorId}:${request.checkpointId}:${request.coordinatorDigest}:${hash(key)}`,mac=createHmac('sha256',secret).update(`doc:0:${request.expectedRevision}:${unsigned}`).digest('base64url')
   const record={revision:next.revision,rootHash:hash('root-'+next.revision),patchBaseRevision:request.expectedRevision,patchId:unsigned+':'+(this.badReceipt?'x'.repeat(mac.length):mac)}
   this.head=next;this.projections.set(next.revision,next);this.records.set(next.revision,record)
   const reply={saved:true,revision:next.revision,rootHash:record.rootHash,projection:next,saveMode:'word-regions'};this.saved.set(key,reply)
   if(this.drop){this.drop=false;throw new Error('network-lost-after-commit')}
   return Response.json(reply)
  }finally{this.active--}
 }
}
async function fixture(options:{autoSave?:boolean;idleMs?:number;uploadTimeoutMs?:number;maintainOwnership?:()=>Promise<void>;broadcast?:(state:import('./wordSaveCoordinator.ts').WordSaveStatus)=>void;layoutAwareLive?:boolean}={}){
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-owner-')),api=new FakeApi()
 if(options.layoutAwareLive)api.protocol='hcd-word-regions/2'
 const journal=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret,!!options.layoutAwareLive)
 const ownership=options.layoutAwareLive?{assertOwnership:()=>{},maintainOwnership:async()=>{},recordDurable:async(tip:string)=>{api.journalHash=tip}}:{}
 const settings={journal,protocol:api.protocol,request:api.request,uploadRequest:(_actor:unknown,route:string,init?:RequestInit)=>api.request(route,init),uploadActorAuthorized:async(actor:{userId:string})=>!api.deniedActors.has(actor.userId),...ownership,...options}
 const owner=await WordSaveCoordinator.open(settings)
 return{root,api,journal,owner,settings,close:async()=>{owner.dispose();owner.model.document.destroy();await fs.rm(root,{recursive:true,force:true})}}
}
const alice={userId:'alice',displayName:'Alice 王',scope:'write' as const},bob={userId:'bob',displayName:'Bob 李',scope:'write' as const}
function edit(owner:WordSaveCoordinator,region:number,text:string,actor=alice){owner.change(actor,()=>{const before=owner.model.region(id(region)),node=before[0].node;owner.model.reconcile(id(region),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,owner.model.schema.text(text,node.firstChild?.marks))}])})}
function gate(){let release!:()=>void,arrive!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{arrive=resolve});return{release,entered,hold:async()=>{arrive();await wait}}}
test('layout live owner jointly saves while late text and image edits remain durable and continue in the same room',async()=>{
 const f=await fixture({layoutAwareLive:true}),waiting=gate();let reopened:WordSaveCoordinator|undefined
 try{
  assert.equal(f.owner.isLayoutAwareLive(),true);assert.equal((await f.journal.load())!.capsule.version,3)
  edit(f.owner,1,'Captured body');edit(f.owner,2,'Captured header')
  f.owner.change(alice,()=>new CollaborativeImageDraftStore(f.owner.model.document).edit(sourceImage(),1,{...sourceImage().geometry,width:120}))
  f.api.hold=waiting.hold;const saving=f.owner.save();await waiting.entered
  edit(f.owner,1,'Bob typed during submission',bob)
  f.owner.change(alice,()=>new CollaborativeImageDraftStore(f.owner.model.document).edit(sourceImage(),1,{...sourceImage().geometry,width:140}))
  await f.owner.persist();const durable=(await f.journal.load())!.capsule
  assert.equal(durable.pending!.request.coordinatorVersion,6);assert.ok(durable.actors.some(actor=>actor.userId==='bob'));assert.equal(f.api.head.revision,1)
  f.api.hold=undefined;waiting.release();assert.equal((await saving).status,'editing');assert.equal(f.api.head.revision,2)
  assert.equal(f.owner.model.project(id(1)).textContent,'Bob typed during submission');assert.equal(imageIntents(f.owner.model.document)[0].geometry.width,140)
  assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.head.revision,3);assert.equal(f.api.posted.length,2);assert.equal(f.api.maxActive,1)
  assert.deepEqual(f.api.posted[1].contributors.map((actor:any)=>actor.userId),['alice','bob'])
  f.owner.dispose();reopened=await WordSaveCoordinator.open(f.settings);assert.equal(reopened.state().status,'saved');edit(reopened,2,'Header after restart');assert.equal((await reopened.save()).revision,4)
 }finally{waiting.release();reopened?.dispose();reopened?.model.document.destroy();await f.close()}
})
test('layout live owner recovers a lost response after restart by receipt without resubmitting and retains later actors',async()=>{
 const f=await fixture({layoutAwareLive:true});let reopened:WordSaveCoordinator|undefined
 try{
  edit(f.owner,1,'Before lost response');f.api.drop=true;await assert.rejects(f.owner.save(),/network-lost-after-commit/)
  const sent=structuredClone((await f.journal.load())!.capsule.pending!.request);edit(f.owner,1,'Bob after unknown outcome',bob);await f.owner.persist()
  f.owner.dispose();reopened=await WordSaveCoordinator.open(f.settings)
  assert.equal((await reopened.save()).status,'editing');assert.equal(f.api.posted.length,1);assert.deepEqual(f.api.posted[0],sent);assert.equal(reopened.model.project(id(1)).textContent,'Bob after unknown outcome')
  assert.equal((await reopened.save()).status,'saved');assert.equal(f.api.head.revision,3);assert.deepEqual(f.api.posted[1].contributors.map((actor:any)=>actor.userId),['bob'])
 }finally{reopened?.dispose();reopened?.model.document.destroy();await f.close()}
})
test('layout live receipt lookup failure retains the exact pending capture and retries without a new identity',async()=>{
 const f=await fixture({layoutAwareLive:true})
 try{
  edit(f.owner,1,'Lookup must preserve this');f.api.receiptStatus=503;await assert.rejects(f.owner.save(),/word-layout-request:503/)
  const pending=(await f.journal.load())!.capsule.pending!;assert.equal(f.api.posted.length,0)
  f.api.receiptStatus=undefined;assert.equal((await f.owner.save()).status,'saved');assert.deepEqual(f.api.posted[0],pending.request);assert.equal(f.api.posted.length,1)
 }finally{await f.close()}
})
test('disposing a layout live owner stops a transport that ignores abort and retains its prepared request',async()=>{
 const f=await fixture({layoutAwareLive:true}),waiting=gate();let reopened:WordSaveCoordinator|undefined,finish!:(response:Response)=>void
 try{
  f.owner.dispose();reopened=await WordSaveCoordinator.open({...f.settings,request:async(route,init)=>{if(route==='/word/checkpoint-receipt')return new Promise<Response>(resolve=>{finish=resolve;void waiting.hold()});return f.api.request(route,init)}})
  edit(reopened,1,'Stalled transport');const saving=reopened.save();await waiting.entered;reopened.dispose();await assert.rejects(saving,/word-owner-closed/)
  const pending=(await f.journal.load())!.capsule.pending!;assert.equal(pending.request.coordinatorVersion,6);assert.equal(f.api.posted.length,0);finish(new Response(null,{status:404}))
 }finally{waiting.release();reopened?.dispose();reopened?.model.document.destroy();await f.close()}
})
test('layout live mode requires an explicit matching protocol and all ownership callbacks',async()=>{
 const f=await fixture({layoutAwareLive:true})
 try{
  await assert.rejects(WordSaveCoordinator.open({...f.settings,protocol:'hcd-word-regions/1'}),/word-layout-coordinator-required/)
  await assert.rejects(WordSaveCoordinator.open({...f.settings,assertOwnership:undefined}),/word-layout-owner-required/)
  await assert.rejects(WordSaveCoordinator.open({...f.settings,experimentalLayoutDraftOnly:true}),/word-layout-coordinator-required/)
 }finally{await f.close()}
})
test('layout live owner confirms an unchanged receipt from its original journal and then saves the later draft',async()=>{
 const f=await fixture({layoutAwareLive:true}),lateDoc=new Y.Doc();let reopened:WordSaveCoordinator|undefined
 try{
  const initial=(await f.journal.load())!,capture=f.owner.model.capture(),actors=[{...alice,generation:1}],request={coordinatorVersion:6 as const,coordinatorId:lineage,checkpointId:'9'.repeat(32),coordinatorDigest:hash(f.owner.model.contents()),expectedRevision:1,layoutHash:capture.layoutHash,typographyVersion:2 as const,regions:capture.regions.map(region=>({...region,images:[]})),contributors:[{userId:alice.userId,displayName:alice.displayName}]}
  const capsule=structuredClone(initial.capsule);capsule.actors=actors;capsule.pending={capture,actors,request,initiator:{userId:alice.userId,displayName:alice.displayName}}
  const submitted=await f.journal.save(capsule,initial.hash),key=JSON.stringify(request),unsigned=`hcdsave6:${lineage}:${request.checkpointId}:${request.coordinatorDigest}:${hash(key)}`,patchId=unsigned+':'+createHmac('sha256',secret).update(`doc:0:1:${unsigned}`).digest('base64url'),rootHash=f.api.records.get(1).rootHash
  const receipt={schemaVersion:'hcd-word-checkpoint-unchanged/2',documentId:'doc',epoch:0,journalHash:submitted,requestHash:hash(key),revision:1,rootHash,patchId,signature:''};receipt.signature=createHmac('sha256',secret).update(`hcd-word-checkpoint-unchanged/2:doc:0:${submitted}:${receipt.requestHash}:1:${rootHash}:${patchId}`).digest('base64url')
  f.api.saved.set(key,{saved:true,saveMode:'word-regions-unchanged',revision:1,rootHash,projection:f.api.head,unchangedReceipt:receipt});f.owner.dispose()
  Y.applyUpdate(lateDoc,Buffer.from(capsule.document,'base64'));const model=new WordRegionStore(lateDoc,f.owner.model.schema,'doc',f.api.head.flowLayout,f.api.head.flowLayoutHash),before=model.region(id(1)),block=before[0];model.reconcile(id(1),before,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,model.schema.text('Late input after no-op',block.node.firstChild?.marks))}])
  capsule.document=Buffer.from(Y.encodeStateAsUpdate(lateDoc)).toString('base64');capsule.observation=wordDraftObservation(model);capsule.actors=[{...alice,generation:2}];await f.journal.save(capsule,submitted)
  reopened=await WordSaveCoordinator.open(f.settings);assert.equal((await reopened.save()).status,'editing');assert.equal(f.api.posted.length,0);assert.equal(reopened.model.project(id(1)).textContent,'Late input after no-op')
  assert.equal((await reopened.save()).status,'saved');assert.equal(f.api.posted.length,1);assert.equal(f.api.head.revision,2)
 }finally{reopened?.dispose();reopened?.model.document.destroy();lateDoc.destroy();await f.close()}
})
test('layout live acknowledgement publication failure freezes the old owner and archives newer unrecorded input',async()=>{
 const f=await fixture({layoutAwareLive:true});let reopened:WordSaveCoordinator|undefined,failed=false
 try{
  f.owner.dispose();reopened=await WordSaveCoordinator.open({...f.settings,recordDurable:async(tip,hashes)=>{
   const current=await f.journal.load()
   if(!failed&&f.api.head.revision===2&&!current!.capsule.pending){failed=true;edit(reopened!,1,'Very late input before owner-record failure',bob);throw Error('ack-owner-record-lost')}
   await f.settings.recordDurable!(tip)
  }})
  edit(reopened,1,'Captured before owner-record failure');await assert.rejects(reopened.save(),/ack-owner-record-lost/)
  assert.equal((await f.journal.load())!.capsule.base.revision,2);assert.throws(()=>reopened!.assertAcceptingPackets(),/word-owner-lost/)
  const copies=await f.journal.recoverySnapshots(),saved=copies.find(copy=>copy.reason==='word-owner-layout-ack');assert.ok(saved);const doc=new Y.Doc()
  try{Y.applyUpdate(doc,Buffer.from(saved.capsule.document,'base64'));assert.match(new WordRegionStore(doc,reopened.model.schema,'doc',f.api.projections.get(1)!.flowLayout,f.api.projections.get(1)!.flowLayoutHash).project(id(1)).textContent,/Very late input/)}finally{doc.destroy()}
  await assert.rejects(WordSaveCoordinator.open(f.settings),/word-owner-recovery-required/);assert.equal(f.api.posted.length,1)
 }finally{reopened?.dispose();reopened?.model.document.destroy();await f.close()}
})
test('layout live forged receipts retain the exact capture and do not start another native submission',async()=>{
 const f=await fixture({layoutAwareLive:true})
 try{
  edit(f.owner,1,'Keep original source bindings');const sources=f.owner.model.capture().sources;f.api.badReceipt=true
  await assert.rejects(f.owner.save(),/word-checkpoint-receipt-invalid/);assert.deepEqual(f.owner.model.capture().sources,sources)
  const pending=(await f.journal.load())!.capsule.pending!;assert.equal(f.owner.state().problem,'word-checkpoint-receipt-invalid')
  assert.equal((await f.owner.save()).status,'failed');assert.equal(f.api.posted.length,1);assert.deepEqual((await f.journal.load())!.capsule.pending,pending)
 }finally{await f.close()}
})
test('owned bootstrap and receipt validation cooperate with lease renewal between model phases',async()=>{
 let renewals=0;const f=await fixture({maintainOwnership:async()=>{renewals++;await new Promise<void>(resolve=>setImmediate(resolve))}})
 try{assert.equal(renewals,4);assert.equal(f.api.posted.length,0);edit(f.owner,1,'Saved with cooperative renewal');const before=renewals;assert.equal((await f.owner.save()).status,'saved');assert.ok(renewals>=before+4);assert.equal(f.api.posted.length,1)}finally{await f.close()}
})
test('bootstrap renewal loss cannot publish a journal or a partially opened owner',async()=>{
 for(const failAt of [2,4]){
  const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-bootstrap-loss-')),api=new FakeApi(),journal=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret);let live=true,calls=0
  try{await assert.rejects(WordSaveCoordinator.open({journal,protocol:'hcd-default/1',request:api.request,assertOwnership:()=>{if(!live)throw Error('word-owner-lost')},maintainOwnership:async()=>{if(++calls===failAt){live=false;throw Error('renewal failed')}}}),/word-owner-lost/);assert.equal(await journal.load(),undefined);assert.equal(api.posted.length,0)}finally{await fs.rm(root,{recursive:true,force:true})}
 }
})
test('renewal loss after native commit preserves the exact pending receipt and does not rebind sources',async()=>{
 const f=await fixture();let owner:WordSaveCoordinator|undefined,live=true
 try{
  f.owner.dispose();owner=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request,assertOwnership:()=>{if(!live)throw Error('word-owner-lost')},maintainOwnership:async()=>{if(f.api.head.revision>1){live=false;throw Error('renewal failed')}}})
  edit(owner,1,'Native committed before lease loss');const sources=owner.model.capture().sources
  await assert.rejects(owner.save(),/word-owner-lost/);assert.equal(f.api.head.revision,2);assert.equal(owner.state().revision,1);assert.deepEqual(owner.model.capture().sources,sources);const pending=(await f.journal.load())!.capsule.pending!;assert.deepEqual(pending.request,f.api.posted[0]);assert.equal(owner.state().status,'conflict')
 }finally{owner?.dispose();owner?.model.document.destroy();await f.close()}
})
test('equal visible business metadata cannot launder an unauthored update through later legal text',async()=>{
 const f=await fixture();try{
  f.owner.model.document.getMap(nodeEditFields.materialized).set('x_'+'a'.repeat(32),{ids:[],value:{schemaVersion:'hcd.extension/1',instanceId:'x_'+'a'.repeat(32),type:'qa.test',version:1,display:'inline',data:{},fallback:{text:'retained metadata'}}})
  edit(f.owner,1,'Later authenticated body');assert.equal(f.owner.state().problem,'contributors-unbound');await assert.rejects(f.owner.save(),/contributors-unbound/);assert.equal(f.api.posted.length,0)
 }finally{await f.close()}
})
test('an older prepared block atom accepts only native false defaults and keeps its canonical baseline after reopen',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{
  f.api.normalizeFallback=true;const value={schemaVersion:'hcd.extension/1',instanceId:'x_'+'b'.repeat(32),type:'example.card',version:1,display:'block',data:{title:'Keep'},fallback:{text:'Keep'}}
  f.owner.change(alice,()=>{const before=f.owner.model.region(id(1));f.owner.model.reconcile(id(1),before,[...before,{node:f.owner.model.schema.nodes.hcdExtensionBlock.createChecked({extension:value})}])})
  const request=await f.owner.save();assert.equal(request.status,'saved');assert.equal(f.owner.model.project(id(1)).lastChild!.attrs.fallbackInline.bold,false);assert.equal(f.api.head.revision,2)
  await f.owner.persist();f.owner.dispose();resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal(resumed.state().status,'saved');assert.equal((await resumed.save()).revision,2);assert.equal(f.api.posted.length,1)
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('one owner serializes saves, preserves late input and acknowledges only captured actor generations',async()=>{
 const f=await fixture();try{
  edit(f.owner,1,'Alice body');edit(f.owner,2,'Bob header',bob);const pending=gate();f.api.hold=pending.hold;const first=f.owner.save();await pending.entered;edit(f.owner,1,'Alice typed during save');const second=f.owner.save();f.api.hold=undefined;pending.release()
  const firstResult=await first;assert.equal(firstResult.status,'editing');assert.equal(firstResult.pending,true);assert.equal((await second).status,'saved');assert.equal(f.api.maxActive,1);assert.equal(f.api.head.revision,3)
  assert.deepEqual(f.api.posted[0].contributors.map((person:any)=>person.userId),['alice','bob']);assert.deepEqual(f.api.posted[1].contributors.map((person:any)=>person.userId),['alice']);assert.match(f.owner.model.project(id(1)).textContent,/during save/);assert.equal((await f.journal.load())!.capsule.pending,undefined)
 }finally{await f.close()}
})
test('a lost response replays the same durable request after reconstruction instead of creating a new save ID',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{
  edit(f.owner,2,'Captured');f.api.drop=true;await assert.rejects(f.owner.save(),/network-lost/);assert.equal(f.owner.state().status,'failed');edit(f.owner,2,'Late surviving input');await f.owner.persist()
  const pending=(await f.journal.load())!.capsule.pending!;f.owner.dispose();f.owner.model.document.destroy()
  resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal((await resumed.save()).status,'editing');assert.equal(f.api.posted[1].checkpointId,pending.request.checkpointId);assert.deepEqual(f.api.posted[1],f.api.posted[0]);assert.equal(f.api.head.revision,2)
  assert.match(resumed.model.project(id(2)).textContent,/Late surviving/);assert.equal((await resumed.save()).status,'saved');assert.equal(f.api.head.revision,3)
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('journal failure before submission cannot write native content or report saved',async()=>{
 const f=await fixture();const original=f.journal.save.bind(f.journal)
 try{edit(f.owner,1,'Held in memory');f.journal.save=async()=>{throw new Error('disk-full')};await assert.rejects(f.owner.save(),/disk-full/);assert.equal(f.api.posted.length,0);assert.equal(f.owner.state().status,'failed');assert.equal(f.owner.state().pending,true);f.journal.save=original;assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.head.revision,2)}finally{f.journal.save=original;await f.close()}
})
test('journal failure after native commit retries durability without publishing another revision',async()=>{
 const f=await fixture();const original=f.journal.save.bind(f.journal);let writes=0,failed=true
 try{edit(f.owner,1,'Native already committed');f.journal.save=async(...args)=>{writes++;if(writes>=2&&failed)throw new Error('ack-backup-failed');return original(...args)};await assert.rejects(f.owner.save(),/ack-backup/);assert.equal(f.api.head.revision,2);assert.equal(f.owner.state().status,'failed');assert.ok((await f.journal.load())!.capsule.pending);failed=false;assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.posted.length,1);assert.equal((await f.journal.load())!.capsule.base.revision,2)}finally{f.journal.save=original;await f.close()}
})
test('external head changes and revoked authority retain drafts without rebasing over another editor',async()=>{
 for(const condition of ['head','scope','epoch']){const f=await fixture();try{edit(f.owner,1,'Retained local');if(condition==='head')f.api.head={...f.api.head,revision:2};if(condition==='scope')f.api.denied=true;if(condition==='epoch')f.api.epoch=1;await assert.rejects(f.owner.save(),/canonical-changed|word-authority-changed/);assert.equal(f.owner.state().status,'conflict');assert.equal(f.api.posted.length,0);assert.match(f.owner.model.project(id(1)).textContent,/Retained/);assert.ok((await f.journal.load())!.capsule.document)}finally{await f.close()}}
})
test('unattributed shared updates cannot borrow the next authenticated actor, including after a restart',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{const before=f.owner.model.region(id(1)),node=before[0].node;f.owner.model.reconcile(id(1),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,f.owner.model.schema.text('Untrusted update'))}]);edit(f.owner,2,'Later authenticated input');await assert.rejects(f.owner.save(),/contributors-unbound/);assert.equal(f.api.posted.length,0);await f.owner.persist();f.owner.dispose();resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});await assert.rejects(resumed.save(),/contributors-unbound/);assert.equal(f.api.posted.length,0)}finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('a forged signed receipt cannot acknowledge the prepared snapshot',async()=>{
 const f=await fixture();try{edit(f.owner,1,'Keep pending');f.api.badReceipt=true;await assert.rejects(f.owner.save(),/word-receipt-invalid/);assert.equal(f.owner.state().status,'failed');assert.ok((await f.journal.load())!.capsule.pending);assert.equal(f.owner.state().revision,1)}finally{await f.close()}
})
test('automatic and manual saves share the same queue',async()=>{
 const f=await fixture({autoSave:true,idleMs:5});try{const pending=gate();f.api.hold=pending.hold;edit(f.owner,1,'Autosave');await Promise.race([pending.entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('autosave not scheduled')),2000))]);const manual=f.owner.save();f.api.hold=undefined;pending.release();assert.equal((await manual).status,'saved');assert.equal(f.api.maxActive,1);assert.equal(f.api.posted.length,1)}finally{await f.close()}
})
test('people mentions keep their authenticated occurrence author across an unknown-outcome restart',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{const reference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'bob'},snapshot:{label:'Bob'}}
  f.owner.change(alice,()=>{const before=f.owner.model.region(id(1)),node=before[0].node;f.owner.model.reconcile(id(1),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,[...node.content.content,f.owner.model.schema.nodes.hcdMention.createChecked({reference})])}])});f.api.drop=true;await assert.rejects(f.owner.save(),/network-lost/);assert.deepEqual(f.api.posted[0].referenceAuthors,[{mentionId:reference.mentionId,userId:'alice'}]);f.owner.dispose()
  resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal((await resumed.save()).status,'saved');assert.deepEqual(f.api.posted[1].referenceAuthors,f.api.posted[0].referenceAuthors)
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('malformed image coordination is visible and cannot be silently omitted from a text save',async()=>{
 const f=await fixture();try{f.owner.model.document.getMap(imageDraftMap).set('pending',{assetHash:'a'.repeat(64)});assert.equal(f.owner.state().problem,'word-model-invalid');await f.owner.save();assert.equal(f.api.posted.length,0);assert.equal(f.owner.state().pending,true)}finally{await f.close()}
})

test('a clean journal from an older canonical head opens in conflict instead of claiming saved',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{f.owner.dispose();f.api.head={...f.api.head,revision:2};resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal(resumed.state().status,'conflict');assert.equal(resumed.state().problem,'canonical-changed');assert.equal(f.api.posted.length,0);assert.equal(resumed.state().revision,1)}finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('authority lost while a request is in flight cannot acknowledge or replace its retained draft',async()=>{
 const f=await fixture();try{edit(f.owner,1,'Retain after revocation');const pending=gate();f.api.hold=pending.hold;const saving=f.owner.save();await pending.entered;f.api.denied=true;pending.release();await assert.rejects(saving,/word-authority-changed/);assert.equal(f.owner.state().status,'conflict');assert.equal(f.owner.state().revision,1);assert.ok((await f.journal.load())!.capsule.pending);assert.match(f.owner.model.project(id(1)).textContent,/Retain/)}finally{await f.close()}
})
test('draining prevents new mutations/saves and does not leave an autosave timer behind',async()=>{
 const f=await fixture({autoSave:true,idleMs:10});try{edit(f.owner,1,'Prepare to unload');const pending=gate();f.api.hold=pending.hold;const saving=f.owner.save();await pending.entered;const drained=f.owner.drain();assert.throws(()=>edit(f.owner,2,'too late'),/word-change-unavailable/);await assert.rejects(f.owner.save(),/word-owner-draining/);pending.release();await saving;await drained;assert.equal(f.api.posted.length,1);assert.equal((await f.journal.load())!.capsule.pending,undefined)}finally{await f.close()}
})
test('topology hold stops packets, writes, saves and persistence until explicitly released',async()=>{
 const f=await fixture({autoSave:true,idleMs:10});try{
  edit(f.owner,1,'preserved draft');await f.owner.drain();const before=(await f.journal.load())!.hash;f.owner.holdForTopology()
  assert.throws(()=>f.owner.assertAcceptingPackets(),/word-owner-lost/);assert.throws(()=>edit(f.owner,1,'must not enter'),/word-change-unavailable/)
  await assert.rejects(f.owner.save(),/word-owner-draining/);await assert.rejects(f.owner.persist(),/word-topology-room-held/)
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.api.posted.length,0);assert.equal((await f.journal.load())!.hash,before)
  f.owner.releaseTopologyHold();edit(f.owner,1,'allowed after safe release');assert.match(f.owner.model.project(id(1)).textContent,/allowed/)
 }finally{await f.close()}
})
test('topology transition waits for admitted packets and safely releases on authorization refusal',async()=>{
 const f=await fixture(),gate=new RoomMigrationGate();try{
  const packet=gate.enter('doc'),pending:any={request:{},actor:{},intent:{},story:{},blocks:[]};let authorized=false
  const work=transitionWordStory({gate,room:f.owner,journal:f.journal,pending,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},authorize:async()=>{authorized=true;throw Error('access-revoked')},request:f.api.request,protocol:'hcd-word-regions/2'})
  await Promise.resolve();assert.equal(authorized,false);assert.throws(()=>gate.enter('doc'),/protocol-transition/);packet()
  await assert.rejects(work,/access-revoked/);assert.equal(authorized,true);assert.equal(gate.blocked('doc'),false);assert.equal(f.owner.isTopologyHeld(),false);edit(f.owner,1,'still editable')
 }finally{await f.close()}
})
test('layout transition releases the room when authorization fails before preparation',async()=>{
 const f=await fixture(),g=new RoomMigrationGate();try{
  const packet=g.enter('doc');let authorized=false
  const work=transitionWordLayout({gate:g,room:f.owner,journal:f.journal,pending:{} as WordLayoutPending,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},authorize:async()=>{authorized=true;throw Error('access-revoked')},request:f.api.request,protocol:'hcd-word-regions/2'})
  await Promise.resolve();assert.equal(authorized,false);assert.throws(()=>g.enter('doc'));packet();await assert.rejects(work,/access-revoked/)
  assert.equal(g.blocked('doc'),false);assert.equal(f.owner.isTopologyHeld(),false);edit(f.owner,1,'still editable')
 }finally{await f.close()}
})
test('stopped checkpoint does not skip an unfinished image upload',async()=>{
 let requests=0;const journal={load:async()=>({hash:'a'.repeat(64),capsule:{version:3,uploads:[{phase:'interrupted'}]}})} as unknown as WordCheckpointJournal
 await assert.rejects(prepareStoppedWordCheckpoint({journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},request:async()=>{requests++;return Response.json({})},assertStopped:()=>{}}),/word-upload-interrupted/);assert.equal(requests,0)
})
test('a topology preparation outcome that may be published keeps the old room fenced',async()=>{
 const f=await fixture(),gate=new RoomMigrationGate();try{
  f.journal.prepareStory=async()=>{throw Error('journal-fsync-outcome-unknown')}

  const pending:any={request:{transactionId:'e'.repeat(32),actor:{userId:'alice',displayName:'Alice'}},actor:{userId:'alice',displayName:'Alice',generation:1},intent:{},story:{},blocks:[]}
  await assert.rejects(transitionWordStory({gate,room:f.owner,journal:f.journal,pending,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},authorize:async()=>({userId:'alice',displayName:'Alice',scope:'write' as const}),request:f.api.request,protocol:'hcd-word-regions/2'}),/outcome-unknown/)
  assert.equal(gate.blocked('doc'),true);assert.equal(f.owner.isTopologyHeld(),true);assert.throws(()=>gate.enter('doc'));assert.throws(()=>edit(f.owner,1,'must not enter'));assert.throws(()=>f.owner.releaseTopologyHold(),/word-topology-room-sealed/)
  await assert.rejects(f.owner.save(),/word-owner-draining/)
 }finally{await f.close()}
})
test('unexpected direct shared document edits invalidate a held topology snapshot',async()=>{
 const f=await fixture();try{await f.owner.drain();f.owner.holdForTopology();f.owner.model.document.getMap('unknown').set('late','content');assert.throws(()=>f.owner.assertTopologyHeld(),/word-topology-room-changed/);assert.throws(()=>f.owner.releaseTopologyHold(),/word-topology-room-changed/);assert.throws(()=>f.owner.assertAcceptingPackets())}finally{await f.close()}
})
test('unexpected document mutation during authorization cannot reopen a held room',async()=>{
 const f=await fixture(),gate=new RoomMigrationGate();try{
  const pending:any={request:{actor:{userId:'alice',displayName:'Alice'}},actor:{userId:'alice',displayName:'Alice',generation:1},intent:{},story:{},blocks:[]}
  await assert.rejects(transitionWordStory({gate,room:f.owner,journal:f.journal,pending,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},authorize:async()=>{f.owner.model.document.getMap('unknown').set('late','data');return {userId:'alice',displayName:'Alice',scope:'write' as const}},request:f.api.request,protocol:'hcd-word-regions/2'}),/outcome-unknown/)
  assert.equal(gate.blocked('doc'),true);assert.throws(()=>gate.enter('doc'));assert.equal(f.owner.isTopologyHeld(),true)
 }finally{await f.close()}
})
test('a stopped live owner retains its fence through a lost story response and successful reconciliation',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-topology-')),api=new FakeApi(),journal=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret,true,true),gate=new RoomMigrationGate();let owner:WordSaveCoordinator|undefined
 try{
  let tip='none',submissions=0;const lease={assert:()=>{},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{tip=hashes.at(-1)!}}
  const base=initial(),next=structuredClone(base);next.revision=2;next.flowLayoutHash=hash('layout-2');next.flowLayout.stories.push({id:id(3),kind:'footer',sourcePart:'word/new-footer.xml'});next.flowLayout.sections[0].footers.default=id(3)
  const pending:WordPendingStory={request:{documentId:'doc',transactionId:'e'.repeat(32),expectedRevision:1,baseLayoutHash:base.flowLayoutHash,candidateHash:'f'.repeat(64),actor:{userId:'alice',displayName:'Alice 王'}},actor:{userId:'alice',displayName:'Alice 王',generation:1},intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:next.flowLayout.stories.at(-1)!,copyChoices:{referenceIds:[],extensions:[]},blocks:[{flowRegionId:id(3),region:'footer',blockId:id(13),blockHash:hash('block-new'),readOnly:false,content:{kind:'paragraph',inlines:[{nodeId:id(23),text:'New footer'}]}}]};next.blocks.push(...pending.blocks)
  const record={documentId:'doc',authorId:'alice',authorName:'Alice 王',revision:2,patchBaseRevision:1,patchId:`word-story-unlink-${pending.request.transactionId}`,patchHash:wordStoryRequestHash(pending.request),rootHash:hash('root-2'),structuralChange:true}
  const request=async(route:string,init?:RequestInit):Promise<Response>=>{
   if(route==='/auth')return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'})
   if(route==='/word/story-transactions'){submissions++;api.head=next;api.projections.set(2,next);api.records.set(2,record);throw Error('lost response')}
   if(route==='/word/story-receipt'){const sent=JSON.parse(String(init?.body)),proof={schemaVersion:'hcd-word-story-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:pending.request.transactionId,requestHash:record.patchHash,pendingHash:wordStoryPendingHash(pending),rootHash:record.rootHash,layoutHash:next.flowLayoutHash,initialUpdateHash:sent.initialUpdateHash,signature:''};proof.signature=createHmac('sha256',secret).update(JSON.stringify(['hcd-word-story-receipt/1',journal.scope.apiHash,'doc',0,lineage,tip,1,2,pending.request.transactionId,record.patchHash,proof.pendingHash,record.rootHash,pending.request.baseLayoutHash,proof.layoutHash,proof.initialUpdateHash])).digest('base64url');return Response.json({...proof,projection:next})}
   return api.request(route,init)
  }
  owner=await WordSaveCoordinator.open({journal,protocol:'hcd-word-regions/2',request,assertOwnership:lease.assert,maintainOwnership:lease.renew,recordDurable:(_hash,ancestors)=>lease.recordJournal(ancestors)});edit(owner,1,'local draft preserved')
  let authorizations=0;const options={gate,room:owner,journal,lease,pending,authorize:async(candidate:Readonly<WordPendingStory>)=>{assert.equal(candidate.actor.userId,'alice');assert.equal(candidate.request.actor.userId,'alice');authorizations++;candidate.request.actor.userId='mallory';return {userId:'alice',displayName:'Alice 王',scope:'write' as const}},request,protocol:'hcd-word-regions/2' as const},packet=gate.enter('doc'),first=transitionWordStory(options)
  await Promise.resolve();assert.throws(()=>gate.enter('doc'));const competing=structuredClone(pending);competing.intent.sectionId=id(2);await assert.rejects(transitionWordStory({...options,pending:competing}),/protocol-transition/);await assert.rejects(transitionWordStory(options),/protocol-transition/);packet();await assert.rejects(first,/outcome-unknown/);assert.equal(submissions,1);assert.ok((await journal.load())!.capsule.pendingStory);assert.equal(gate.blocked('doc'),true);assert.throws(()=>owner!.releaseTopologyHold())
  const heldTip=(await journal.load())!.hash;await assert.rejects(transitionWordStory({...options,authorize:async()=>({userId:'bob',displayName:'Bob',scope:'write' as const})}),/outcome-unknown/);assert.equal(gate.blocked('doc'),true);assert.equal((await journal.load())!.hash,heldTip)
  let receipts=0,revoked=false
  await assert.rejects(transitionWordStory({...options,authorize:async()=>({userId:'alice',displayName:'Alice 王',scope:revoked?'read' as const:'write' as const}),request:async(route,init)=>{const response=await request(route,init);if(route==='/word/story-receipt'&&++receipts===2)revoked=true;return response}}),/outcome-unknown/)
  assert.equal(receipts,2);assert.equal((await journal.load())!.hash,heldTip);assert.ok((await journal.load())!.capsule.pendingStory);assert.equal(submissions,1)
  const result=await transitionWordStory(options);assert.equal(authorizations,4);assert.equal(result.capsule.storyAcknowledgement!.pending.request.actor.userId,'alice');assert.equal(submissions,1);assert.equal(gate.blocked('doc'),true);assert.ok(result.capsule.storyAcknowledgement);assert.throws(()=>edit(owner!,1,'old room still closed'))
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(result.capsule.document,'base64'));const model=new WordRegionStore(restored,owner.model.schema,'doc',next.flowLayout,next.flowLayoutHash);assert.match(model.project(id(1)).textContent,/local draft preserved/);assert.equal(model.project(id(3)).textContent,'New footer')}finally{restored.destroy()}
  const stopped=()=>{if(!gate.blocked('doc'))throw Error('room-active');owner!.assertTopologyHeld()},member={userId:'alice',displayName:'Alice 王',scope:'write' as const},promotion={gate,journal,lease,request,protocol:'hcd-word-regions/2' as const,assertStopped:stopped,pending,authorize:async()=>member}
  const other=structuredClone(pending);other.request.transactionId='a'.repeat(32)
  await assert.rejects(promoteRecoveredWordStory({...promotion,pending:other}),/room-protocol-transition/)
  await assert.rejects(promoteRecoveredWordStory({...promotion,authorize:async()=>({...member,userId:'bob'})}),/word-topology-actor-unauthorized/);assert.equal((await journal.load())!.capsule.version,4)
  let release!:()=>void,arrived!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>arrived=resolve)
  let records=0;const lostRecordLease={...lease,recordJournal:async(hashes:readonly string[])=>{await lease.recordJournal(hashes);if(++records===2)throw Error('owner-record-response-lost')}}
  const firstPromotion=promoteRecoveredWordStory({...promotion,lease:lostRecordLease,authorize:async()=>{arrived();await blocked;return member}});await entered
  await assert.rejects(promoteRecoveredWordStory(promotion),/room-protocol-transition/)
  await assert.rejects(installLayoutDraftRoom({gate,operation:'word-story-unlink',pending,authorize:async()=>member,previous:owner,journal,lease,request,create:async()=>{throw Error('unexpected create')},install:async()=>{},assertInstalled:()=>{},uninstall:async()=>{},assertUninstalled:()=>{}}),/word-layout-room-active/)
  release();await assert.rejects(firstPromotion,/owner-record-response-lost/);const published=(await journal.load())!;assert.equal(published.capsule.version,3);assert.equal(gate.blocked('doc'),true)
  await assert.rejects(promoteRecoveredWordStory({...promotion,authorize:async()=>({...member,userId:'bob'})}),/word-topology-actor-unauthorized/);const promoted=await promoteRecoveredWordStory(promotion);assert.equal(promoted.tip,published.hash);assert.equal(gate.blocked('doc'),true)
  let installed:WordSaveCoordinator|undefined
  const install={gate,operation:'word-story-unlink' as const,pending,authorize:async()=>member,previous:owner,journal,lease,request,create:()=>WordSaveCoordinator.open({journal,protocol:'hcd-word-regions/2',request,experimentalLayoutDraftOnly:true}),install:async(candidate:WordSaveCoordinator)=>{installed=candidate},assertInstalled:(candidate:WordSaveCoordinator)=>{if(installed!==candidate)throw Error('not installed')},uninstall:async(candidate:WordSaveCoordinator)=>{if(installed===candidate)installed=undefined},assertUninstalled:(candidate:WordSaveCoordinator)=>{if(installed===candidate)throw Error('still installed')}}
  await assert.rejects(installLayoutDraftRoom({...install,pending:other}),/word-layout-room-active/)
  await assert.rejects(installLayoutDraftRoom({...install,authorize:async()=>({...member,userId:'bob'})}),/word-topology-actor-unauthorized/)
  const newOwner=await installLayoutDraftRoom(install);try{assert.equal(gate.blocked('doc'),false);assert.equal(newOwner.model.project(id(3)).textContent,'New footer');assert.match(newOwner.model.project(id(1)).textContent,/local draft preserved/);await assert.rejects(newOwner.save(),/word-layout-live-save-unavailable/)}finally{newOwner.dispose();newOwner.model.document.destroy()}
 }finally{owner?.dispose();owner?.model.document.destroy();await fs.rm(root,{recursive:true,force:true})}
})

test('a live layout transition drains admitted edits and fences the room across a lost response',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-layout-room-')),api=new FakeApi(),journal=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret,true),gate=new RoomMigrationGate();let owner:WordSaveCoordinator|undefined
 try{
  let tip='none',submissions=0,denied=false;const lease={assert:()=>{},renew:async()=>{},recordJournal:async(hashes:readonly string[])=>{tip=hashes.at(-1)!}}
  const base=initial(),next=structuredClone(base);next.revision=2;next.flowLayoutHash=hash('layout-2');next.flowLayout.sections[0].page.widthTwips=12240
  const actor={userId:'alice',displayName:'Alice 王',generation:1},pending:WordLayoutPending={actor,request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'e'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:actor.userId,displayName:actor.displayName},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:base.flowLayoutHash,changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:12240}]}}}
  const record={documentId:'doc',authorId:actor.userId,authorName:actor.displayName,revision:2,patchBaseRevision:1,patchId:`word-layout-${pending.request.transactionId}`,patchHash:wordLayoutRequestHash(pending.request),rootHash:hash('root-2'),wordLayoutChange:true}
  const request=async(route:string,init?:RequestInit):Promise<Response>=>{
   if(route==='/auth')return Response.json({scope:denied?'read':'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'})
   if(route==='/word/layout-preflight')return Response.json({revision:1,rootHash:api.records.get(1)!.rootHash,baseLayoutHash:base.flowLayoutHash,layout:next.flowLayout})
   if(route==='/word/layout-transactions'){submissions++;api.head=next;api.projections.set(2,next);api.records.set(2,record);api.images.set(2,sourceImage());throw Error('lost response')}
   if(route==='/word/layout-receipt'){const signature=createHmac('sha256',secret).update(`hcd-layout-receipt/1:doc:0:${lineage}:${tip}:1:2:${pending.request.transactionId}:${record.patchHash}:${record.rootHash}`).digest('base64url');return Response.json({schemaVersion:'hcd-layout-receipt/1',documentId:'doc',epoch:0,coordinatorId:lineage,journalHash:tip,expectedRevision:1,revision:2,transactionId:pending.request.transactionId,requestHash:record.patchHash,rootHash:record.rootHash,signature,projection:next})}
   return api.request(route,init)
  }
  owner=await WordSaveCoordinator.open({journal,protocol:'hcd-word-regions/2',request,assertOwnership:lease.assert,maintainOwnership:lease.renew,recordDurable:(_hash,ancestors)=>lease.recordJournal(ancestors)});edit(owner,1,'draft before layout')
  const rejected={gate,room:owner,journal,lease,pending,authorize:async()=>({userId:actor.userId,displayName:actor.displayName,scope:'write' as const}),request:async(route:string,init?:RequestInit)=>route==='/word/layout-preflight'?new Response('invalid',{status:400}):request(route,init),protocol:'hcd-word-regions/2' as const}
  await assert.rejects(transitionWordLayout(rejected),/word-layout-preflight:400/);assert.equal(gate.blocked('doc'),false);assert.equal(owner.isTopologyHeld(),false);assert.equal((await journal.load())!.capsule.pendingLayout,undefined);assert.equal(submissions,0)
  const forged={...rejected,request:async(route:string,init?:RequestInit)=>route==='/word/layout-preflight'?Response.json({revision:1,rootHash:api.records.get(1)!.rootHash,baseLayoutHash:base.flowLayoutHash,layout:base.flowLayout}):request(route,init)}
  await assert.rejects(transitionWordLayout(forged),/word-layout-preflight-invalid/);assert.equal(gate.blocked('doc'),false);assert.equal((await journal.load())!.capsule.pendingLayout,undefined)
  let authorizations=0;const options={gate,room:owner,journal,lease,pending,authorize:async(candidate:Readonly<WordLayoutPending>)=>{assert.equal(candidate.actor.userId,'alice');if(!authorizations++){candidate.request.edits.changes[0].value=15000;pending.request.edits.changes[0].value=16000}return {userId:'alice',displayName:'Alice 王',scope:'write' as const}},request,protocol:'hcd-word-regions/2' as const},packet=gate.enter('doc'),first=transitionWordLayout(options)
  await Promise.resolve();assert.throws(()=>gate.enter('doc'));const competing=structuredClone(pending);competing.request.edits.changes[0].value=13000;await assert.rejects(transitionWordLayout({...options,pending:competing}),/protocol-transition/);await assert.rejects(transitionWordLayout(options),/protocol-transition/);edit(owner,2,'admitted header edit',bob);owner.change(bob,()=>new CollaborativeImageDraftStore(owner!.model.document).edit(sourceImage(),1,{...sourceImage().geometry,width:120},undefined,'width'));packet();await assert.rejects(first,/outcome-unknown/)
  assert.equal(submissions,1);assert.equal(gate.blocked('doc'),true);assert.equal((await journal.load())!.capsule.pendingLayout!.request.edits.changes[0].value,12240);pending.request.edits.changes[0].value=12240;assert.throws(()=>owner!.releaseTopologyHold())
  const heldTip=(await journal.load())!.hash;await assert.rejects(transitionWordLayout({...options,authorize:async()=>({userId:'bob',displayName:'Bob',scope:'write' as const})}),/outcome-unknown/);assert.equal(gate.blocked('doc'),true);assert.equal((await journal.load())!.hash,heldTip)
  let revoked=false
  await assert.rejects(transitionWordLayout({...options,authorize:async()=>({userId:'alice',displayName:'Alice 王',scope:revoked?'read' as const:'write' as const}),request:async(route,init)=>{const response=await request(route,init);if(route==='/word/layout-receipt')revoked=true;return response}}),/outcome-unknown/)
  assert.equal((await journal.load())!.hash,heldTip);assert.ok((await journal.load())!.capsule.pendingLayout);assert.equal(submissions,1)
  const result=await transitionWordLayout(options);assert.equal(submissions,1);assert.ok(result.capsule.layoutAcknowledgement);assert.equal(gate.blocked('doc'),true);assert.throws(()=>edit(owner!,1,'old room closed'))
  const restored=new Y.Doc();try{Y.applyUpdate(restored,Buffer.from(result.capsule.document,'base64'));const model=new WordRegionStore(restored,owner.model.schema,'doc',next.flowLayout,next.flowLayoutHash);assert.equal(model.project(id(1)).textContent,'draft before layout');assert.equal(model.project(id(2)).textContent,'admitted header edit')}finally{restored.destroy()}
  const stopped=()=>{if(!gate.blocked('doc'))throw Error('room-active');owner!.assertTopologyHeld()},promote={gate,journal,lease,request,pending,protocol:'hcd-word-regions/2' as const,assertStopped:stopped,authorize:async()=>({userId:'alice',displayName:'Alice 王',scope:'write' as const})}
  const badPending=structuredClone(pending);badPending.request.transactionId='0'.repeat(32)
  await assert.rejects(promoteHeldWordLayout({...promote,pending:badPending}),/room-protocol-transition/)
  await assert.rejects(promoteHeldWordLayout({...promote,authorize:async()=>({userId:'bob',displayName:'Bob',scope:'write' as const})}),/word-topology-actor-unauthorized/)
  let revokeDuringPromotion=false
  await assert.rejects(promoteHeldWordLayout({...promote,authorize:async()=>({userId:'alice',displayName:'Alice 王',scope:revokeDuringPromotion?'read' as const:'write' as const}),request:async(route,init)=>{const response=await request(route,init);if(route==='/auth')revokeDuringPromotion=true;return response}}),/word-topology-actor-unauthorized/)
  assert.equal((await journal.load())!.capsule.version,2);assert.equal(gate.blocked('doc'),true)
  let memberChecks=0
  await assert.rejects(promoteHeldWordLayout({...promote,authorize:async()=>({userId:'alice',displayName:'Alice 王',scope:++memberChecks>=3?'read' as const:'write' as const})}),/word-topology-actor-unauthorized/)
  const promotedTip=(await journal.load())!;assert.equal(promotedTip.capsule.version,3);assert.equal(gate.blocked('doc'),true)
  let promoted=await promoteHeldWordLayout(promote);assert.equal(promoted.tip,promotedTip.hash)
  const secondOwner=await WordSaveCoordinator.open({journal,protocol:'hcd-word-regions/2',request,experimentalLayoutDraftOnly:true})
  try{
   const g=new RoomMigrationGate(),saveActor={userId:'alice',displayName:'Alice 王'},member={...saveActor,scope:'write' as const},saveOptions={gate:g,room:secondOwner,journal,lease,request,actor:saveActor,authorize:async():Promise<typeof member>=>{throw Error('access-revoked')}}
   let releaseAuth!:()=>void,enteredAuth!:()=>void;const waiting=new Promise<void>(resolve=>{releaseAuth=resolve}),entered=new Promise<void>(resolve=>{enteredAuth=resolve})
   const firstSave=saveLayoutDraftRoom({...saveOptions,authorize:async()=>{enteredAuth();await waiting;throw Error('access-revoked')}})
   await entered;let competingAuthorizations=0
   await assert.rejects(saveLayoutDraftRoom({...saveOptions,authorize:async()=>{competingAuthorizations++;return member}}),/room-protocol-transition/)
   assert.equal(competingAuthorizations,0);releaseAuth();await assert.rejects(firstSave,/access-revoked/);assert.equal(g.blocked('doc'),false);assert.equal(secondOwner.isTopologyHeld(),false)
   for(const invalid of [{...member,scope:'read' as const},{...member,userId:'bob'},{...member,displayName:'Other'}]){await assert.rejects(saveLayoutDraftRoom({...saveOptions,authorize:async()=>invalid}),/word-topology-actor-unauthorized/);assert.equal(g.blocked('doc'),false)}
   await assert.rejects(saveLayoutDraftRoom(saveOptions),/access-revoked/);assert.equal(g.blocked('doc'),false);assert.equal(secondOwner.isTopologyHeld(),false)
   await assert.rejects(saveLayoutDraftRoom({...saveOptions,authorize:async()=>member,request:async()=>new Response('',{status:503})}),/migration-outcome-unknown/);assert.equal(g.blocked('doc'),true);assert.throws(()=>secondOwner.releaseTopologyHold());assert.equal((await journal.load())!.capsule.pending,undefined)
   await assert.rejects(saveLayoutDraftRoom({...saveOptions,actor:{userId:'bob',displayName:'Bob'},authorize:async()=>({userId:'bob',displayName:'Bob',scope:'write'})}),/room-protocol-transition/);assert.equal(g.blocked('doc'),true)
  }finally{secondOwner.dispose();secondOwner.model.document.destroy()}
  {const latest=(await journal.load())!;promoted={tip:latest.hash,capsule:latest.capsule}}
  await assert.rejects(prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:()=>{throw Error('room-active')}}),/room-active/);assert.equal((await journal.load())!.hash,promoted.tip)
  denied=true;await assert.rejects(prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:stopped}),/word-authority-changed/);denied=false;assert.equal((await journal.load())!.hash,promoted.tip)
  api.head={...next,revision:3};await assert.rejects(prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:stopped}),/canonical-changed/);api.head=next;assert.equal((await journal.load())!.hash,promoted.tip)
  const initiator={userId:'alice',displayName:'Alice 王'},checkpointId='9'.repeat(32);await assert.rejects(prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:stopped,initiator,checkpointId:'invalid'}),/word-checkpoint-id-invalid/);const prepared=await prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:stopped,initiator,checkpointId});assert.equal(prepared.prepared,true);const saved=(await journal.load())!.capsule;assert.equal(saved.pending!.request.checkpointId,checkpointId);assert.equal(saved.pending!.request.coordinatorVersion,6);assert.deepEqual(saved.pending!.initiator,initiator);assert.equal(saved.pending!.images![0].change.geometry.width,120);assert.equal(saved.pending!.images![0].regionId,id(2));assert.deepEqual(saved.pending!.actors.map(actor=>actor.userId).sort(),['alice','bob']);await assert.rejects(prepareStoppedWordCheckpoint({journal,lease,request,assertStopped:stopped}),/pending-unresolved/)
  const reopened=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret,true);let calls=0
  await reopened.load();assert.equal(await reopened.checkpointUsed(checkpointId,stopped),true);assert.equal(await reopened.checkpointUsed('8'.repeat(32),stopped),false)
  await assert.rejects(reopened.abandonUnpreparedCheckpoint(checkpointId,stopped),/word-checkpoint-pending-unresolved/)
  await assert.rejects(saveStoppedWordDraft({journal:reopened,lease,assertStopped:stopped,initiator,checkpointId:'8'.repeat(32),request:async()=>{calls++;throw Error('unexpected request')}}),/word-checkpoint-id-mismatch/)
  await assert.rejects(saveStoppedWordDraft({journal:reopened,lease,assertStopped:stopped,initiator:{userId:'bob',displayName:'Bob'},request:async()=>{calls++;throw Error('unexpected request')}}),/word-checkpoint-initiator-mismatch/)
  assert.equal(calls,0);assert.equal((await reopened.load())!.hash,prepared.tip);assert.deepEqual((await reopened.load())!.capsule.pending!.initiator,initiator)
  let checkpointCalls=0,reauthChecks=0
  await assert.rejects(saveStoppedWordDraft({journal:reopened,lease,assertStopped:stopped,initiator,authorizeMember:async()=>{reauthChecks++;throw Error('member-revoked')},request:async(route,init)=>{if(route==='/word/checkpoints')checkpointCalls++;return request(route,init)}}),/member-revoked/)
  assert.equal(reauthChecks,1);assert.equal(checkpointCalls,0);assert.equal((await reopened.load())!.hash,prepared.tip)
 }finally{owner?.dispose();owner?.model.document.destroy();await fs.rm(root,{recursive:true,force:true})}
})

test('disposing an in-flight owner leaves the original prepared request and emits no late room status',async()=>{
 const states:unknown[]=[],f=await fixture({broadcast:state=>states.push(state)})
 try{edit(f.owner,1,'Unknown after close');const pending=gate();f.api.hold=pending.hold;const saving=f.owner.save();await pending.entered;f.owner.dispose();const before=states.length;pending.release();await assert.rejects(saving,/word-owner-closed/);assert.equal(states.length,before);assert.equal(f.owner.state().revision,1);assert.ok((await f.journal.load())!.capsule.pending);assert.equal(f.api.head.revision,2)}finally{await f.close()}
})
test('non-text conflict/unknown metadata updates cannot leave the room status falsely saved',async()=>{
 const states:import('./wordSaveCoordinator.ts').WordSaveStatus[]=[],f=await fixture({broadcast:state=>states.push(state)})
 try{f.owner.model.document.getMap(imageDraftMap).set('upload',{assetHash:'a'.repeat(64)});assert.equal(states.at(-1)?.status,'failed');assert.equal(states.at(-1)?.problem,'word-model-invalid');assert.equal(states.at(-1)?.pending,true);assert.equal(f.api.posted.length,0)}finally{await f.close()}
})

test('definitive client/model rejections retain the prepared request without an automatic retry loop',async()=>{
 const f=await fixture();try{edit(f.owner,1,'Unsupported payload stays recoverable');f.api.rejectStatus=426;await assert.rejects(f.owner.save(),/word-save:426/);assert.equal(f.owner.state().status,'failed');assert.ok((await f.journal.load())!.capsule.pending);await f.owner.save();assert.equal(f.api.posted.length,1)}finally{await f.close()}
})

test('an older prepared capsule without an observation can settle its exact receipt and bind new authenticated edits',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{edit(f.owner,1,'Legacy prepared');f.api.drop=true;await assert.rejects(f.owner.save(),/network-lost/);const loaded=(await f.journal.load())!,legacy=structuredClone(loaded.capsule);delete legacy.observation;await f.journal.save(legacy,loaded.hash);f.owner.dispose();resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal((await resumed.save()).status,'saved');edit(resumed,1,'New authenticated edit');assert.equal(resumed.state().problem,undefined);assert.equal((await resumed.save()).status,'saved');assert.equal(f.api.head.revision,3)}finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})

function imageEdit(owner:WordSaveCoordinator,width:number,actor=alice){
 const store=new CollaborativeImageDraftStore(owner.model.document)
 owner.change(actor,()=>store.edit(sourceImage(),1,{...sourceImage().geometry,width},undefined,'width'));return store
}
test('regional image-only and text/image replacement saves keep scope and contributors without phantom text changes',async()=>{
 const f=await fixture();try{
  const store=imageEdit(f.owner,180,bob);const uploaded=store.prepareReplacement(sourceImage(),1);f.owner.change(bob,()=>uploaded.commit(hash('replacement')));uploaded.finish();edit(f.owner,1,'Joint body')
  assert.equal(f.owner.state().status,'editing');assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.posted[0].regions[0].images.length,0);assert.equal(f.api.posted[0].regions[1].images[0].geometry.width,180);assert.equal(f.api.posted[0].regions[1].images[0].assetHash,hash('replacement'));assert.deepEqual(f.api.posted[0].contributors.map((p:any)=>p.userId),['alice','bob']);assert.equal(imageIntents(f.owner.model.document).length,0)
  f.owner.change(bob,()=>store.edit(f.api.images.get(2)!,2,{...f.api.images.get(2)!.geometry,width:210},undefined,'width'));assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.head.revision,3);assert.deepEqual(f.api.posted[1].contributors.map((p:any)=>p.userId),['bob']);assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.posted.length,2)
 }finally{await f.close()}
})
test('an image response lost after commit restores the exact capture and preserves a later causal resize across restart',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{
  const store=imageEdit(f.owner,180,bob);edit(f.owner,1,'Captured text');const pending=gate();f.api.hold=pending.hold;f.api.drop=true;const saving=f.owner.save();await pending.entered
  f.owner.change(alice,()=>store.edit(sourceImage(),1,{...sourceImage().geometry,width:240},undefined,'width'));pending.release();await assert.rejects(saving,/network-lost/)
  const capsule=(await f.journal.load())!.capsule;assert.equal(capsule.pending!.images!.length,1);f.owner.dispose();resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request})
  assert.equal((await resumed.save()).status,'editing');assert.deepEqual(f.api.posted[1],f.api.posted[0]);const late=imageIntents(resumed.model.document);assert.equal(late.length,1);assert.equal(late[0].geometry.width,240);assert.equal(late[0].revision,2);assert.equal(late[0].base.visualHash,f.api.images.get(2)!.visualHash)
  assert.equal((await resumed.save()).status,'saved');assert.equal(f.api.images.get(3)!.geometry.width,240);assert.deepEqual(f.api.posted[2].contributors.map((p:any)=>p.userId),['alice'])
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('valid image updates without a trusted transaction cannot borrow the next text author',async()=>{
 const f=await fixture();try{const store=new CollaborativeImageDraftStore(f.owner.model.document);store.edit(sourceImage(),1,{...sourceImage().geometry,width:170});edit(f.owner,1,'Later legal text');assert.equal(f.owner.state().problem,'contributors-unbound');await assert.rejects(f.owner.save(),/contributors-unbound/);assert.equal(f.api.posted.length,0)}finally{await f.close()}
})
test('a claimed page never authorizes an image outside the canonical regional source catalog',async()=>{
 const f=await fixture();try{const store=new CollaborativeImageDraftStore(f.owner.model.document);f.owner.change(alice,()=>store.edit({...sourceImage(),nodeId:id(999)},1,{...sourceImage().geometry,width:170},1));await assert.rejects(f.owner.save(),/word-image-region-unknown/);assert.equal(f.api.posted.length,0);assert.equal(f.owner.state().pending,true)}finally{await f.close()}
})
test('an invalid immutable image receipt cannot rebind text sources or discard the captured intents',async()=>{
 const f=await fixture();try{imageEdit(f.owner,180);edit(f.owner,1,'Joint retained');const capture=f.owner.model.capture(),pending=gate();f.api.hold=pending.hold;const saving=f.owner.save();await pending.entered;f.api.badImageReceipt=true;pending.release();await assert.rejects(saving,/word-image-receipt-invalid/);assert.equal(f.owner.state().revision,1);assert.deepEqual(f.owner.model.capture().sources,capture.sources);assert.equal(imageIntents(f.owner.model.document).length,1);assert.ok((await f.journal.load())!.capsule.pending)}finally{await f.close()}
})
test('a stale offline image intent is verified against its immutable version before disjoint rebasing',async()=>{
 const f=await fixture();try{
  const store=imageEdit(f.owner,180);await f.owner.save()
  // A separate offline peer did not see the saved resize; its height edit is
  // admitted with a trusted identity but its old baseline still needs proof.
  const peer=new Y.Doc(),offline=new CollaborativeImageDraftStore(peer);offline.edit(sourceImage(),1,{...sourceImage().geometry,height:85},undefined,'height')
  const intent=imageIntents(peer)[0];f.owner.change(bob,()=>f.owner.model.document.getMap(imageDraftMap).set(intent.intentId,intent));peer.destroy()
  assert.equal((await f.owner.save()).status,'saved');assert.deepEqual(f.api.images.get(3)!.geometry,{...sourceImage().geometry,width:180,height:85});assert.deepEqual(f.api.posted[1].contributors.map((p:any)=>p.userId),['bob']);assert.equal(store.size,0)
 }finally{await f.close()}
})
test('overlapping offline image values require an explicit choice and a forged baseline cannot be rebased',async()=>{
 for(const forged of [false,true]){const f=await fixture();try{
  imageEdit(f.owner,180);await f.owner.save();const peer=new Y.Doc(),store=new CollaborativeImageDraftStore(peer);store.edit(sourceImage(),1,{...sourceImage().geometry,width:250});const intent=imageIntents(peer)[0];if(forged)intent.base.geometry.height=900
  f.owner.change(bob,()=>f.owner.model.document.getMap(imageDraftMap).set(intent.intentId,intent));peer.destroy();await assert.rejects(f.owner.save(),forged?/word-image-baseline-invalid/:/image-drafts-conflict/);assert.equal(f.api.head.revision,2);assert.equal(f.api.posted.length,1);assert.equal(f.owner.state().pending,true);assert.ok(imageIntents(f.owner.model.document).length)
 }finally{await f.close()}}
})
test('the image digest participates in manual-save synchronization checks',async()=>{
 const f=await fixture();try{const images=f.owner.state().imageDigest;imageEdit(f.owner,180);const result=await f.owner.save(f.owner.state().digest,images);assert.equal(result.problem,'sync-required');assert.equal(f.api.posted.length,0);assert.equal((await f.owner.save()).status,'saved')}finally{await f.close()}
})

test('save synchronization is checked again after asynchronous immutable image verification',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{
  imageEdit(f.owner,180);await f.owner.persist();f.owner.dispose();const pending=gate(),request=async(route:string,init?:RequestInit)=>{if(route.startsWith('/images/'))await pending.hold();return f.api.request(route,init)}
  resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request});const before=resumed.state(),saving=resumed.save(before.digest,before.imageDigest);await pending.entered;edit(resumed,1,'Arrived during immutable lookup');pending.release();assert.equal((await saving).problem,'sync-required');assert.equal(f.api.posted.length,0);assert.equal((await resumed.save()).status,'saved')
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('an owner closed during immutable image receipt reads leaves text and image captures unacknowledged',async()=>{
 const f=await fixture();let resumed:WordSaveCoordinator|undefined
 try{
  imageEdit(f.owner,180);edit(f.owner,1,'Retained');await f.owner.persist();f.owner.dispose();const pending=gate(),request=async(route:string,init?:RequestInit)=>{if(route.startsWith('/images/')&&route.endsWith('revision=2'))await pending.hold();return f.api.request(route,init)}
  resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request});const before=resumed.model.capture(),saving=resumed.save();await pending.entered;resumed.dispose();pending.release();await assert.rejects(saving,/word-owner-closed/);assert.equal(resumed.state().revision,1);assert.deepEqual(resumed.model.capture().sources,before.sources);assert.equal(imageIntents(resumed.model.document).length,1);assert.ok((await f.journal.load())!.capsule.pending)
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})

const uploadBytes=Buffer.from('controlled native staging bytes'),uploadHash=createHash('sha256').update(uploadBytes).digest('hex')
test('a durable upload reservation blocks new canonical saves until verified bytes become an authored intent',async()=>{
 const f=await fixture();try{
  const pending=gate();f.api.uploadGate=pending.hold;const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes});await pending.entered
  const record=(await f.journal.load())!.capsule.uploads![0];assert.equal(record.id,upload.id);assert.equal(record.assetHash,uploadHash);assert.equal(record.actor.userId,'bob');assert.ok(record.base);assert.equal(f.owner.state().pending,true);assert.equal(f.owner.state().uploads!.active,1)
  edit(f.owner,1,'Text while image uploads');assert.equal((await f.owner.save()).status,'editing');assert.equal(f.api.posted.length,0);pending.release();assert.equal((await upload.done).phase,'applied');assert.equal(imageIntents(f.owner.model.document)[0].assetHash,uploadHash);assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.head.revision,2);assert.deepEqual(f.api.posted[0].contributors.map((p:any)=>p.userId),['alice','bob'])
 }finally{await f.close()}
})
test('cancelling an upload releases pending durably and a transport ignoring abort cannot apply its late success',async()=>{
 const f=await fixture();try{
  const pending=gate();f.api.uploadGate=pending.hold;let staged!:()=>void;const committed=new Promise<void>(resolve=>{staged=resolve});f.api.afterStage=staged
  const upload=f.owner.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes}),done=assert.rejects(upload.done,/word-upload-cancelled/);await pending.entered;await upload.cancel();await done;assert.equal(f.owner.state().status,'saved');assert.equal((await f.journal.load())!.capsule.uploads![0].phase,'cancelled')
  pending.release();await committed;assert.equal(imageIntents(f.owner.model.document).length,0);assert.equal(f.api.staged.size,1);assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.posted.length,0)
 }finally{await f.close()}
})
test('a timed-out upload can be verified and explicitly resumed after reconstruction without repeating staging or applying twice',async()=>{
 const f=await fixture({uploadTimeoutMs:500});let resumed:WordSaveCoordinator|undefined
 try{
  const pending=gate();f.api.uploadGate=pending.hold;let staged!:()=>void;const committed=new Promise<void>(resolve=>{staged=resolve});f.api.afterStage=staged
  const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes}),done=assert.rejects(upload.done,/word-upload-timeout/);await pending.entered;await done;assert.equal(f.owner.state().problem,'word-upload-interrupted');f.owner.dispose();pending.release();await committed
  resumed=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request,uploadRequest:(_actor,route,init)=>f.api.request(route,init),uploadActorAuthorized:async()=>true});assert.equal(resumed.state().status,'failed');assert.equal((await resumed.save()).pending,true);assert.equal(f.api.posted.length,0)
  assert.throws(()=>resumed!.uploads.resume(alice,upload.id),/word-upload-owner-required/);assert.throws(()=>resumed!.uploads.resume(bob,upload.id,Buffer.from('different')),/word-upload-file-differs/)
  assert.equal((await resumed.uploads.resume(bob,upload.id)).phase,'applied');assert.equal((await resumed.uploads.resume(bob,upload.id)).phase,'applied');assert.equal(imageIntents(resumed.model.document).length,1);assert.equal(f.api.uploadPosts,1);assert.equal((await resumed.save()).status,'saved');assert.deepEqual(f.api.posted[0].contributors.map((p:any)=>p.userId),['bob'])
 }finally{resumed?.dispose();resumed?.model.document.destroy();await f.close()}
})
test('upload preparation failure writes no native bytes and remains a pending recovery choice',async()=>{
 const f=await fixture();const original=f.journal.save.bind(f.journal)
 try{f.journal.save=async()=>{throw new Error('disk-full')};const upload=f.owner.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes});await assert.rejects(upload.done,/disk-full/);assert.equal(f.api.uploadPosts,0);assert.equal(f.owner.state().pending,true);assert.equal(f.owner.state().status,'failed');f.journal.save=original;await f.owner.uploads.cancel(alice,upload.id);assert.equal(f.owner.state().status,'saved')}finally{f.journal.save=original;await f.close()}
})
test('post-application journal failure retries durability without duplicating the replacement intent',async()=>{
 const f=await fixture();const original=f.journal.save.bind(f.journal);let broken=true
 try{
  f.journal.save=async(capsule,tip)=>{if(broken&&capsule.uploads?.some(record=>record.phase==='applied'))throw new Error('applied-backup-failed');return original(capsule,tip)}
  const upload=f.owner.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes});await assert.rejects(upload.done,/applied-backup/);assert.equal(imageIntents(f.owner.model.document).length,1);assert.equal(f.owner.state().status,'failed');assert.equal(f.api.posted.length,0);broken=false
  await f.owner.uploads.resume(alice,upload.id);assert.equal(imageIntents(f.owner.model.document).length,1);assert.equal(f.api.uploadPosts,1);assert.equal((await f.owner.save()).status,'saved')
 }finally{f.journal.save=original;await f.close()}
})
test('two concurrent upload choices preserve both assets as a conflict instead of silently letting the last response win',async()=>{
 const f=await fixture();try{
  const pending=gate();f.api.uploadGate=async asset=>{if(asset===uploadHash)await pending.hold()};const earlier=f.owner.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes});await pending.entered
  const later=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:Buffer.from('other upload bytes')});await later.done;pending.release();await earlier.done;assert.equal(imageIntents(f.owner.model.document).length,2);assert.equal(f.owner.state().problem,'image-drafts-conflict');await assert.rejects(f.owner.save(),/image-drafts-conflict/);assert.equal(f.api.posted.length,0)
 }finally{await f.close()}
})
test('an actor revoked during native staging cannot apply the successful uploaded bytes',async()=>{
 const f=await fixture();try{const pending=gate();f.api.uploadGate=pending.hold;const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes}),done=assert.rejects(upload.done,/word-upload-authority-changed/);await pending.entered;f.api.deniedActors.add('bob');pending.release();await done;assert.equal(imageIntents(f.owner.model.document).length,0);assert.equal(f.owner.state().pending,true);assert.equal(f.api.posted.length,0)}finally{await f.close()}
})
test('draining aborts uploads that ignore the signal and journals the interrupted choice before unloading',async()=>{
 const f=await fixture();try{const pending=gate();f.api.uploadGate=pending.hold;const upload=f.owner.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes}),done=assert.rejects(upload.done,/word-upload-interrupted|word-upload-unavailable/);await pending.entered;await f.owner.drain();await done;assert.equal((await f.journal.load())!.capsule.uploads![0].phase,'interrupted');assert.equal(imageIntents(f.owner.model.document).length,0);pending.release()}finally{await f.close()}
})

test('a missing staged file requires the exact original bytes on resume rather than silently abandoning the choice',async()=>{
 const f=await fixture();try{
  f.api.uploadGate=async()=>{throw new Error('transport-never-delivered')};const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes});await assert.rejects(upload.done,/transport-never/);assert.equal(f.api.staged.size,0)
  await assert.rejects(f.owner.uploads.resume(bob,upload.id),/word-upload-file-required/);assert.equal(f.owner.state().pending,true);assert.equal(imageIntents(f.owner.model.document).length,0);f.api.uploadGate=undefined;await f.owner.uploads.resume(bob,upload.id,uploadBytes);assert.equal(imageIntents(f.owner.model.document).length,1);assert.equal((await f.owner.save()).status,'saved')
 }finally{await f.close()}
})
test('a save already in flight may acknowledge its capture while a later upload keeps the document pending',async()=>{
 const f=await fixture();try{
  edit(f.owner,1,'First save');const saveGate=gate(),uploadGate=gate();f.api.hold=saveGate.hold;f.api.uploadGate=uploadGate.hold;const saving=f.owner.save();await saveGate.entered;const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes});await uploadGate.entered
  saveGate.release();assert.equal((await saving).status,'editing');assert.equal(f.owner.state().revision,2);assert.equal(f.owner.state().pending,true);uploadGate.release();await upload.done;assert.equal((await f.owner.save()).status,'saved');assert.equal(f.api.head.revision,3);assert.deepEqual(f.api.posted[1].contributors.map((p:any)=>p.userId),['bob'])
 }finally{await f.close()}
})
test('server upload APIs require a current-actor verifier and a member-scoped transport',async()=>{
 const f=await fixture();let owner:WordSaveCoordinator|undefined
 try{f.owner.dispose();owner=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.throws(()=>owner!.uploads.start(alice,{nodeId:id(90),extension:'png',bytes:uploadBytes}),/word-upload-auth-required/);assert.equal(f.api.uploadPosts,0);assert.equal(owner.state().status,'saved')}finally{owner?.dispose();owner?.model.document.destroy();await f.close()}
})
test('disposing an upload leaves its durable reservation and ignores late transport results and broadcasts',async()=>{
 const states:unknown[]=[],f=await fixture({broadcast:state=>states.push(state)})
 try{const pending=gate();f.api.uploadGate=pending.hold;let commit!:()=>void;const committed=new Promise<void>(resolve=>{commit=resolve});f.api.afterStage=commit;const upload=f.owner.uploads.start(bob,{nodeId:id(90),extension:'png',bytes:uploadBytes}),done=assert.rejects(upload.done,/word-upload-unavailable/);await pending.entered;f.owner.dispose();const count=states.length;await done;pending.release();await committed;assert.equal(states.length,count);assert.equal(imageIntents(f.owner.model.document).length,0);assert.equal((await f.journal.load())!.capsule.uploads![0].phase,'reserved')}finally{await f.close()}
})

test('a Hocuspocus-owned document may bind only to the exact signed regional journal state',async()=>{
 const f=await fixture(),document=new Y.Doc();let rebound:WordSaveCoordinator|undefined
 try{edit(f.owner,1,'Durable hosted draft');await f.owner.persist();f.owner.dispose();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.owner.model.document));rebound=await WordSaveCoordinator.open({document,journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal(rebound.model.document,document);assert.equal((await rebound.save()).status,'saved');assert.match(rebound.model.project(id(1)).textContent,/Durable hosted/)}finally{rebound?.dispose();document.destroy();await f.close()}
})
test('foreign host state is rejected without destroying or overwriting the caller document',async()=>{
 const f=await fixture(),document=new Y.Doc()
 try{f.owner.dispose();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.owner.model.document));document.getText('foreign').insert(0,'Do not discard');const before=Y.encodeStateAsUpdate(document);await assert.rejects(WordSaveCoordinator.open({document,journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request}),/word-host-state-unbound/);assert.equal(document.isDestroyed,false);assert.deepEqual(Y.encodeStateAsUpdate(document),before)}finally{document.destroy();await f.close()}
})

test('loss of ownership fences late receipts/current-chain writes and preserves divergent input in a signed recovery',async()=>{
 const f=await fixture();let owner:WordSaveCoordinator|undefined;let live=true
 try{f.owner.dispose();owner=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request,assertOwnership:()=>{if(!live)throw new Error('word-owner-lost')}});edit(owner,1,'Captured before lease loss');const pending=gate();f.api.hold=pending.hold;const saving=owner.save();await pending.entered;const tip=(await f.journal.load())!.hash;edit(owner,1,'Late draft only in recovery');live=false;const recoveryId=await owner.archiveRecovery('word-owner-renew-failed');pending.release();await assert.rejects(saving,/word-owner-lost/);assert.equal((await f.journal.load())!.hash,tip);assert.equal(owner.state().status,'conflict');assert.throws(()=>edit(owner!,2,'After lost'),/word-owner-lost/)
  const snapshot=(await f.journal.recoverySnapshots()).find(value=>value.id===recoveryId)!;const document=new Y.Doc();Y.applyUpdate(document,Buffer.from(snapshot.capsule.document,'base64'));const restored=new WordRegionStore(document,owner.model.schema,'doc',f.api.projections.get(1)!.flowLayout,snapshot.capsule.base.layoutHash);assert.match(restored.project(id(1)).textContent,/Late draft/);document.destroy();await assert.rejects(WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request}),/word-owner-recovery-required/)
 }finally{owner?.dispose();owner?.model.document.destroy();await f.close()}
})
test('a fence lost after journal publication freezes the old coordinator even if the lease appears live again',async()=>{
 const f=await fixture();let owner:WordSaveCoordinator|undefined,live=true;const journal=new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),save=journal.save.bind(journal)
 try{
  f.owner.dispose();owner=await WordSaveCoordinator.open({journal,protocol:'hcd-default/1',request:f.api.request,assertOwnership:()=>{if(!live)throw Error('word-owner-lost')}})
  owner.assertAcceptingPackets();edit(owner,1,'Published before fence loss');let checks=0
  journal.save=(capsule,tip,guard)=>save(capsule,tip,()=>{if(++checks===3){edit(owner!,2,'Late input during publication');live=false}guard?.()})
  await assert.rejects(owner.persist(),/word-journal-published-fence-lost/)
  const reader=new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),published=await reader.load();assert.ok(published);const document=new Y.Doc();try{Y.applyUpdate(document,Buffer.from(published.capsule.document,'base64'));const draft=new WordRegionStore(document,owner.model.schema,'doc',f.api.projections.get(1)!.flowLayout,published.capsule.base.layoutHash);assert.match(draft.project(id(1)).textContent,/Published before fence loss/)}finally{document.destroy()}
  live=true;assert.equal(owner.state().problem,'word-owner-lost');assert.throws(()=>owner!.assertAcceptingPackets(),/word-owner-lost/);assert.throws(()=>edit(owner!,2,'must reject'),/word-change-unavailable/);await assert.rejects(owner.persist(),/word-owner-lost/);assert.equal((await reader.load())!.hash,published.hash);assert.equal(f.api.posted.length,0)
  const recoveryId=await owner.archiveRecovery(),archived=(await reader.recoverySnapshots()).find(value=>value.id===recoveryId);assert.ok(archived);const late=new Y.Doc();try{Y.applyUpdate(late,Buffer.from(archived.capsule.document,'base64'));const draft=new WordRegionStore(late,owner.model.schema,'doc',f.api.projections.get(1)!.flowLayout,archived.capsule.base.layoutHash);assert.match(draft.project(id(2)).textContent,/Late input during publication/)}finally{late.destroy()}
  await assert.rejects(WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request}),/word-owner-recovery-required/)
 }finally{journal.save=save;owner?.dispose();owner?.model.document.destroy();await f.close()}
})
test('identical owner-loss snapshots are acknowledged once and do not block later clean versions',async()=>{
 const f=await fixture();let owner:WordSaveCoordinator|undefined,again:WordSaveCoordinator|undefined
 try{const id=await f.owner.archiveRecovery();f.owner.dispose();owner=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.ok((await f.journal.load())!.capsule.recoveries!.includes(id));edit(owner,1,'Later new owner content');assert.equal((await owner.save()).status,'saved');owner.dispose();again=await WordSaveCoordinator.open({journal:new WordCheckpointJournal(f.root,apiUrl,'doc',0,lineage,secret),protocol:'hcd-default/1',request:f.api.request});assert.equal(again.state().status,'saved')}finally{owner?.dispose();owner?.model.document.destroy();again?.dispose();again?.model.document.destroy();await f.close()}
})

test('a private journal published without a native durable acknowledgement cannot submit the prepared checkpoint',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-record-')),api=new FakeApi(),journal=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret);let fail=false,owner:WordSaveCoordinator|undefined,recorded:string[]=[]
 try{owner=await WordSaveCoordinator.open({journal,protocol:'hcd-default/1',request:api.request,recordDurable:async(tip,ancestors)=>{assert.equal(ancestors.at(-1),tip);if(fail)throw new Error('native-record-response-lost');recorded=[...ancestors]}});edit(owner,1,'Prepared but not acknowledged');fail=true;await assert.rejects(owner.save(),/native-record-response-lost/);assert.equal(api.posted.length,0);assert.equal(owner.state().pending,true);const reopened=new WordCheckpointJournal(root,apiUrl,'doc',0,lineage,secret),saved=await reopened.load();assert.ok(saved!.capsule.pending);assert.equal(reopened.knownHashes().includes(recorded.at(-1)!),true);assert.ok(reopened.knownHashes().length>recorded.length)}finally{owner?.dispose();owner?.model.document.destroy();await fs.rm(root,{recursive:true,force:true})}
})

function selection(owner:WordSaveCoordinator,clientId=123){const image=sourceImage();return{id:crypto.randomUUID(),nodeId:id(90),extension:'png' as const,assetHash:uploadHash,byteLength:uploadBytes.length,revision:owner.state().revision,clientId,visualHash:image.visualHash,seen:imageIntents(owner.model.document).filter(entry=>entry.base.nodeId===id(90))}}
test('HTTP-style reserve persists the member choice before bytes, blocks saves, and exact retries do not duplicate the upload',async()=>{const f=await fixture();try{const input=selection(f.owner);const record=await f.owner.uploads.reserve(bob,input);assert.equal(record.phase,'reserved');assert.equal(record.clientId,123);assert.equal(f.api.uploadPosts,0);assert.equal((await f.journal.load())!.capsule.uploads![0].id,input.id);assert.equal(f.owner.state().pending,true);assert.equal((await f.owner.save()).status,'editing');assert.equal(f.api.posted.length,0);assert.deepEqual(await f.owner.uploads.reserve(bob,input),record);assert.throws(()=>f.owner.uploads.reserve(alice,input),/owner-required/);assert.throws(()=>f.owner.uploads.reserve(bob,{...input,seen:[...input.seen].reverse(),byteLength:input.byteLength+1}),/request-changed/);await f.owner.uploads.resume(bob,input.id,uploadBytes);const count=f.api.uploadPosts;await f.owner.uploads.resume(bob,input.id,uploadBytes);assert.equal(f.api.uploadPosts,count);assert.equal(imageIntents(f.owner.model.document).length,1);assert.equal(imageIntents(f.owner.model.document)[0].clientId,123);assert.equal((await f.owner.save()).status,'saved')}finally{await f.close()}})
test('a reserved visual baseline cannot be silently replaced and cancel preserves the unchanged image',async()=>{const f=await fixture();try{const input={...selection(f.owner),visualHash:hash('wrong-original')};await assert.rejects(f.owner.uploads.reserve(alice,input),/base-changed/);assert.equal(f.owner.state().pending,true);await assert.rejects(f.owner.uploads.resume(alice,input.id,uploadBytes),/base-changed/);assert.equal(f.api.uploadPosts,0);assert.equal(imageIntents(f.owner.model.document).length,0);await f.owner.uploads.cancel(alice,input.id);assert.equal(f.owner.state().pending,false)}finally{await f.close()}})
test('reserve retains the selecting window intent set instead of consuming a peer replacement that arrived during file hashing',async()=>{const f=await fixture();try{const input=selection(f.owner),image=f.api.images.get(1)!;f.owner.change(alice,()=>new CollaborativeImageDraftStore(f.owner.model.document).replace(image,1,hash('peer replacement')));await f.owner.uploads.reserve(bob,input);await f.owner.uploads.resume(bob,input.id,uploadBytes);assert.equal(imageIntents(f.owner.model.document).length,2);assert.equal(f.owner.state().pending,true);await assert.rejects(f.owner.save(),/image-drafts-conflict|word-image/)}finally{await f.close()}})

test('topology transitions require the authenticated writer to match the request actor',async()=>{
 const f=await fixture();try{
  const actor={userId:'alice',displayName:'Alice',generation:1},requestActor={userId:'alice',displayName:'Alice'},lease={assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},before=(await f.journal.load())!.capsule
  const story:any={actor,request:{actor:requestActor},intent:{},story:{},blocks:[]},layout:any={actor,request:{actor:requestActor}}
  for(const scenario of ['different-user','read-only','missing'] as const)for(const kind of ['story','layout'] as const){
   const gate=new RoomMigrationGate(),member=scenario==='different-user'?{userId:'bob',displayName:'Bob',scope:'write' as const}:scenario==='read-only'?{userId:'alice',displayName:'Alice',scope:'read' as const}:undefined
   const common={gate,room:f.owner,journal:f.journal,lease,request:f.api.request,protocol:'hcd-word-regions/2' as const,authorize:async()=>member as any}
   const operation=kind==='story'?transitionWordStory({...common,pending:story}):transitionWordLayout({...common,pending:layout})
   await assert.rejects(operation,/word-topology-actor-unauthorized/);assert.equal(gate.blocked('doc'),false);assert.equal(f.owner.isTopologyHeld(),false);const after=(await f.journal.load())!.capsule;assert.equal(after.base.revision,before.base.revision);assert.equal(after.pendingStory,undefined);assert.equal(after.pendingLayout,undefined)
  }
  edit(f.owner,1,'still editable after denied topology');assert.match(f.owner.model.project(id(1)).textContent,/still editable/)
 }finally{await f.close()}
})

async function heldLiveReplacement(){
 const f=await fixture({layoutAwareLive:true}),gate=new RoomMigrationGate(),pending={actor:{userId:'alice',displayName:'Alice 王',generation:1},request:{actor:{userId:'alice',displayName:'Alice 王'}}} as WordLayoutPending
 await gate.exclusive('doc',async()=>{await f.owner.drain();f.owner.holdForTopology();f.owner.sealTopologyHold()},undefined,'word-layout-change',true,JSON.stringify(pending),false)
 const candidates:WordSaveCoordinator[]=[];let installed:WordSaveCoordinator|undefined
 const options={gate,operation:'word-layout-change' as const,pending,authorize:async()=>alice,previous:f.owner,journal:f.journal,lease:{assert:()=>{}},request:f.api.request,
  create:async()=>{const owner=await WordSaveCoordinator.open({...f.settings,autoSave:false,idleMs:10});candidates.push(owner);return owner},install:async(owner:WordSaveCoordinator)=>{installed=owner},assertInstalled:(owner:WordSaveCoordinator)=>{assert.equal(installed,owner)},uninstall:async(owner:WordSaveCoordinator)=>{if(installed===owner)installed=undefined},assertUninstalled:(owner:WordSaveCoordinator)=>{assert.notEqual(installed,owner)}}
 return{...f,gate,pending,options,candidates,installed:()=>installed,close:async()=>{for(const owner of candidates){owner.dispose();owner.model.document.destroy()}await f.close()}}
}
test('live room replacement is explicit, remains staged while sealed and resumes native automatic saving after release',async()=>{
 const f=await heldLiveReplacement()
 try{
  await assert.rejects(installLayoutDraftRoom(f.options),/replacement-invalid/);assert.equal(f.gate.blocked('doc'),true);assert.equal(f.installed(),undefined)
  const next=await installLayoutDraftRoom({...f.options,mode:'layout-live',install:async owner=>{assert.equal(owner.isAutoSaveEnabled(),false);assert.throws(()=>owner.enableLayoutAutoSave(()=>{if(f.gate.blocked('doc'))throw Error('admission-held')}),/admission-held/);assert.equal(owner.isAutoSaveEnabled(),false);await f.options.install(owner)}})
  assert.equal(f.gate.blocked('doc'),false);assert.equal(next.isLayoutAwareLive(),true);assert.throws(()=>f.owner.assertAcceptingPackets())
  next.enableLayoutAutoSave(()=>{assert.equal(f.gate.blocked('doc'),false)});assert.equal(next.isAutoSaveEnabled(),true);edit(next,1,'After live room replacement',bob)
  for(let n=0;n<300&&next.state().status!=='saved';n++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(next.state().status,'saved');assert.equal(f.api.head.revision,2);assert.equal(f.api.posted.length,1);assert.equal(f.api.posted[0].coordinatorVersion,6)
 }finally{await f.close()}
})
test('a live replacement cannot start with automatic writes enabled or be requested from a legacy owner',async()=>{
 const f=await heldLiveReplacement(),legacy=await fixture()
 try{
  await assert.rejects(installLayoutDraftRoom({...f.options,mode:'layout-live',create:async()=>{const next=await WordSaveCoordinator.open({...f.settings,autoSave:true});f.candidates.push(next);return next}}),/replacement-invalid/);assert.equal(f.installed(),undefined);assert.equal(f.gate.blocked('doc'),true);assert.equal(f.api.posted.length,0)
  await assert.rejects(installLayoutDraftRoom({...f.options,mode:'layout-live',previous:legacy.owner}),/replacement-mode/)
 }finally{await f.close();await legacy.close()}
})
test('live activation requires a synchronous admission proof, current ownership and an unfrozen live coordinator',async()=>{
 const f=await fixture({layoutAwareLive:true}),legacy=await fixture()
 try{
  assert.throws(()=>f.owner.enableLayoutAutoSave(async()=>{throw Error('not released')}),/proof-must-be-synchronous/);assert.equal(f.owner.isAutoSaveEnabled(),false)
  assert.throws(()=>f.owner.enableLayoutAutoSave(()=>{throw Error('room held')}),/room held/);assert.equal(f.owner.isAutoSaveEnabled(),false)
  f.settings.assertOwnership=()=>{throw Error('owner lost')};assert.throws(()=>f.owner.enableLayoutAutoSave(()=>{}),/owner lost/);assert.equal(f.owner.isAutoSaveEnabled(),false)
  f.settings.assertOwnership=()=>{};f.owner.freeze();assert.throws(()=>f.owner.enableLayoutAutoSave(()=>{}),/activation-unavailable/)
  assert.throws(()=>legacy.owner.enableLayoutAutoSave(()=>{}),/activation-unavailable/)
 }finally{await f.close();await legacy.close()}
})
test('failed live attachment stays fenced through an uncertain rollback and retries cleanup before another candidate',async()=>{
 const f=await heldLiveReplacement();let cleanupCalls=0,failed:WordSaveCoordinator|undefined
 try{
  const uninstall=async(owner:WordSaveCoordinator)=>{if(++cleanupCalls===1)throw Error('cleanup delayed');await f.options.uninstall(owner)}
  await assert.rejects(installLayoutDraftRoom({...f.options,mode:'layout-live',install:async owner=>{failed=owner;await f.options.install(owner);throw Error('attach failed')},uninstall}),/rollback-uncertain/)
  assert.ok(failed);assert.equal(f.gate.blocked('doc'),true);assert.throws(()=>failed!.enableLayoutAutoSave(()=>{}),/activation-unavailable/);assert.equal(f.api.posted.length,0)
  const next=await installLayoutDraftRoom({...f.options,mode:'layout-live'});assert.equal(cleanupCalls,2);assert.equal(f.installed(),next);assert.equal(f.gate.blocked('doc'),false);assert.equal(next.isAutoSaveEnabled(),false)
 }finally{await f.close()}
})

test('a factory-hosted candidate is unloaded even when authority is lost before install starts',async()=>{
 const f=await heldLiveReplacement(),hosts=new Set<WordSaveCoordinator>();let authority=true,installs=0,removed=0
 const before=(await f.journal.load())!.capsule
 try{
  await assert.rejects(installLayoutDraftRoom({...f.options,mode:'layout-live',lease:{assert:()=>{if(!authority)throw Error('lease-lost-after-host-create')}},create:async()=>{const candidate=await f.options.create();hosts.add(candidate);authority=false;return candidate},install:async()=>{installs++},uninstall:async candidate=>{assert.equal(installs,0);assert.equal(candidate.isAutoSaveEnabled(),false);hosts.delete(candidate);removed++},assertUninstalled:candidate=>{assert.equal(hosts.has(candidate),false)}}),/lease-lost-after-host-create/)
  assert.equal(installs,0);assert.equal(removed,1);assert.equal(hosts.size,0);assert.equal(f.gate.blocked('doc'),true);assert.equal(f.api.posted.length,0)
  const retained=(await f.journal.load())!.capsule;assert.deepEqual(retained.base,before.base);assert.equal(retained.document,before.document);assert.deepEqual(retained.actors,before.actors)
 }finally{await f.close()}
})

test('uncertain cleanup before install retains the factory host and cleans it before any new creation',async()=>{
 const f=await heldLiveReplacement(),hosts=new Set<WordSaveCoordinator>();let authority=true,creations=0,cleanup=0,disposals=0,installs=0
 const create=async()=>{assert.equal(hosts.size,0);const candidate=await f.options.create();hosts.add(candidate);creations++;if(creations===1){const dispose=candidate.dispose.bind(candidate);candidate.dispose=()=>{disposals++;dispose()};authority=false}return candidate}
 const uninstall=async(candidate:WordSaveCoordinator)=>{cleanup++;assert.equal(disposals,0);if(cleanup===1)throw Error('host-unload-response-lost');hosts.delete(candidate)}
 const options={...f.options,mode:'layout-live' as const,lease:{assert:()=>{if(!authority)throw Error('lease-lost-after-host-create')}},create,uninstall,assertUninstalled:(candidate:WordSaveCoordinator)=>{assert.equal(hosts.has(candidate),false)},install:async(candidate:WordSaveCoordinator)=>{installs++;await f.options.install(candidate)}}
 try{
  await assert.rejects(installLayoutDraftRoom(options),/rollback-uncertain/);assert.equal(creations,1);assert.equal(installs,0);assert.equal(hosts.size,1);assert.equal(disposals,0);assert.equal(f.gate.blocked('doc'),true)
  authority=true;const candidate=await installLayoutDraftRoom(options)
  assert.equal(cleanup,2);assert.equal(disposals,1);assert.equal(creations,2);assert.equal(installs,1);assert.equal(hosts.size,1);assert.equal(hosts.has(candidate),true);assert.equal(candidate.isAutoSaveEnabled(),false);assert.equal(f.gate.blocked('doc'),false);assert.equal(f.api.posted.length,0)
 }finally{await f.close()}
})

test('a factory cannot return the previous sealed owner as a disposable replacement',async()=>{
 const f=await heldLiveReplacement();let cleanups=0,installs=0
 try{
  await assert.rejects(installLayoutDraftRoom({...f.options,mode:'layout-live',create:async()=>f.owner,install:async()=>{installs++},uninstall:async()=>{cleanups++}}),/replacement-is-previous/)
  assert.equal(cleanups,0);assert.equal(installs,0);assert.equal(f.owner.model.document.isDestroyed,false);f.owner.assertTopologyHeld();assert.equal(f.gate.blocked('doc'),true);assert.equal(f.api.posted.length,0)
 }finally{await f.close()}
})

test('host binding retains the exact journal, destroys only its seed and never activates a staged owner',async()=>{
 const f=await heldLiveReplacement(),binding=new WordRoomBinding(f.settings,()=>{assert.equal(f.gate.blocked('doc'),true)}),document=new Y.Doc()
 try{
  const seed=await binding.load();Y.applyUpdate(document,Y.encodeStateAsUpdate(seed));const owner=await binding.attach(document,{autoSave:false})
  assert.equal(binding.journal,f.journal);assert.equal(owner.ownsJournal(binding.journal),true);assert.equal(owner.model.document,document);assert.equal(owner.isAutoSaveEnabled(),false);assert.equal(seed.isDestroyed,true);assert.equal(document.isDestroyed,false)
  await assert.rejects(binding.attach(document,{autoSave:true}),/binding-phase/);assert.equal(owner.isAutoSaveEnabled(),false);owner.assertAcceptingPackets()
  binding.close();binding.close();assert.equal(document.isDestroyed,false);assert.throws(()=>owner.assertAcceptingPackets());assert.equal(f.gate.blocked('doc'),true);assert.equal(f.api.posted.length,0)
 }finally{binding.close();document.destroy();await f.close()}
})

test('host binding settles only the exact pending request before publishing and retains later private input',async()=>{
 const f=await fixture({layoutAwareLive:true}),document=new Y.Doc(),binding=new WordRoomBinding(f.settings)
 try{
  edit(f.owner,1,'Before binding response loss');f.api.drop=true;await assert.rejects(f.owner.save(),/network-lost-after-commit/)
  edit(f.owner,1,'Later private input survives binding',bob);await f.owner.persist();const pending=(await f.journal.load())!.capsule.pending!.request;f.owner.dispose()
  const seed=await binding.load();assert.equal(f.api.posted.length,1);assert.equal(f.api.saved.size,1);assert.equal((await f.journal.load())!.capsule.pending,undefined);assert.deepEqual(f.api.posted[0],pending)
  Y.applyUpdate(document,Y.encodeStateAsUpdate(seed));const owner=await binding.attach(document,{autoSave:false});assert.equal(owner.state().revision,2);assert.equal(owner.state().pending,true);assert.equal(owner.model.project(id(1)).textContent,'Later private input survives binding');assert.equal(f.api.head.blocks[0].content.inlines[0].text,'Before binding response loss');assert.equal(f.api.posted.length,1)
 }finally{binding.close();document.destroy();await f.close()}
})

test('failed host attachment cleans the seed but leaves the receiving document to its host',async()=>{
 const f=await heldLiveReplacement(),document=new Y.Doc();let admitted=true
 const binding=new WordRoomBinding(f.settings,()=>{if(!admitted)throw Error('admission-lost')})
 try{
  const seed=await binding.load();Y.applyUpdate(document,Y.encodeStateAsUpdate(seed));admitted=false
  await assert.rejects(binding.attach(document,{autoSave:true}),/admission-lost/);assert.equal(seed.isDestroyed,true);assert.equal(document.isDestroyed,false);await assert.rejects(binding.load(),/binding-phase/);assert.equal(f.api.posted.length,0)
 }finally{binding.close();document.destroy();await f.close()}
})

test('closing a binding during a stalled seed open fences the late continuation and releases its seed',async()=>{
 const f=await heldLiveReplacement();let resume!:(response:Response)=>void,started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve}),binding=new WordRoomBinding({...f.settings,request:async(route,init)=>{if(route==='/auth'){started();return new Promise<Response>(resolve=>{resume=resolve})}return f.settings.request(route,init)}})
 try{
  const loading=binding.load();await entered;binding.close();resume(Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'}));await assert.rejects(loading,/binding-closed/);await assert.rejects(binding.load(),/binding-phase/);assert.equal(f.api.posted.length,0)
 }finally{binding.close();await f.close()}
})

test('an asynchronous host admission proof cannot start a room load',async()=>{
 const f=await heldLiveReplacement();let requests=0
 const binding=new WordRoomBinding({...f.settings,request:async(route,init)=>{requests++;return f.settings.request(route,init)}},async()=>{throw Error('late-rejection')})
 try{await assert.rejects(binding.load(),/proof-must-be-synchronous/);assert.equal(requests,0);assert.equal(f.api.posted.length,0)}finally{binding.close();await f.close()}
})

test('layout transitions reject denied or asynchronous member readiness before saving or sealing',async()=>{
 for(const asynchronous of [false,true]){const f=await fixture({layoutAwareLive:true}),gate=new RoomMigrationGate()
  try{
   const pending:WordLayoutPending={actor:{userId:alice.userId,displayName:alice.displayName,generation:1},request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'a'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:alice.userId,displayName:alice.displayName},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash('layout-1'),changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:11906}]}}}
   const deny=()=>{throw Error('client-not-ready')}
   await assert.rejects(transitionWordLayout({gate,room:f.owner,journal:f.journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},pending,authorize:async()=>alice,request:f.api.request,protocol:'hcd-word-regions/2',assertClientsReady:asynchronous?async()=>deny():deny}),asynchronous?/proof-must-be-synchronous/:/client-not-ready/)
   assert.equal(gate.blocked('doc'),false);assert.equal(f.owner.isTopologyHeld(),false);assert.equal(f.api.posted.length,0);f.owner.assertAcceptingPackets()
  }finally{await f.close()}
 }
})

test('a member change during drain rejects layout preparation and leaves the old room editable',async()=>{
 const f=await fixture({layoutAwareLive:true}),gate=new RoomMigrationGate();let ready=true
 const drain=f.owner.drain.bind(f.owner);f.owner.drain=async()=>{await drain();ready=false}
 try{
  const pending:WordLayoutPending={actor:{userId:alice.userId,displayName:alice.displayName,generation:1},request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'a'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:alice.userId,displayName:alice.displayName},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash('layout-1'),changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:11906}]}}}
  await assert.rejects(transitionWordLayout({gate,room:f.owner,journal:f.journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},pending,authorize:async()=>alice,request:f.api.request,protocol:'hcd-word-regions/2',assertClientsReady:()=>{if(!ready)throw Error('member-changed-during-drain')}}),/member-changed-during-drain/)
  assert.equal(gate.blocked('doc'),false);assert.equal(f.owner.isTopologyHeld(),false);assert.equal((await f.journal.load())!.capsule.version,3);assert.equal(f.api.posted.length,0);f.owner.assertAcceptingPackets()
 }finally{await f.close()}
})
