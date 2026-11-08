import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import type {HocuspocusProvider} from '@hocuspocus/provider'
import {prepareWordLinkSessionProof} from './wordLinkSessionProof.ts'
import {wordLinkRequestHash} from './wordLinkProof.ts'
import type {WordLinkTransaction} from './wordLinkPlan.ts'
import {WordLiveSession} from './wordLiveSession.ts'
import {WordDeviceDraft} from './wordDeviceDraft.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {wordBrowserDigest} from './wordBrowserState.ts'
import {imageDraftDigest} from './collaborativeImages.ts'
import {wordTopologyWire} from './wordTopologyPause.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),nonce='b'.repeat(32)
const pause=()=>new Promise(resolve=>setTimeout(resolve,5)),until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'session settled');await pause()}}
function edit(model:WordRegionStore,text:string){const before=model.region(id(1)),block=before[0].node;model.reconcile(id(1),before,[{key:before[0].key,node:block.type.createChecked(block.attrs,model.schema.text(text,block.firstChild?.marks))}])}
async function fixture(scope:'read'|'write'='write',links=false){
 let projection:WordRegionProjection={documentId:'doc',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,heightTwips:15840},headers:{},footers:{}}],stories:[]},blocks:[{flowRegionId:id(1),blockId:id(2),blockHash:hash,region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Base',nodeId:id(3)}]}}]}
 if(links){
  projection.flowLayout.sections[0].headers.default=id(11);projection.flowLayout.sections.push({id:id(10),differentFirstPage:false,page:{},headers:{default:id(12)},footers:{}})
  projection.flowLayout.stories=[11,12].map(n=>({id:id(n),kind:'header' as const,sourcePart:`word/header${n}.xml`}))
  projection.blocks.push(...[10,11,12].map(n=>({flowRegionId:id(n),blockId:id(20+n),blockHash:hash,region:n===10?'body':'header',readOnly:false,content:{kind:'paragraph' as const,inlines:[{text:'Region '+n,nodeId:id(40+n)}]}})))
 }
 const versions=new Map([[1,structuredClone(projection)]]);let storyRound=false,linkRound=false,linkRecord:unknown

 let server=new Y.Doc(),model=new WordRegionStore(server,wordRegionSchema(),'doc',projection.flowLayout,hash);model.initialize(projection)
 const documents=[server],document=new Y.Doc(),cache=await WordDeviceDraft.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-1-wordregions2-device1',new IDBFactory()),providers:Provider[]=[];let apply=()=>{},status:'installed'|'pending'|'recovery-required'='installed',statusCalls=0,sequence=0,statusWait:Promise<void>|undefined
 class Provider extends EventEmitter{
  isSynced=true;hasUnsyncedChanges=false;destroyed=false;sent:any[]=[];readonly source=server;seedSize:number;private receive:(bytes:Uint8Array)=>void;private update:(bytes:Uint8Array,origin:unknown)=>void
  constructor(readonly document:Y.Doc){super();this.seedSize=document.share.size;Y.applyUpdate(document,Y.encodeStateAsUpdate(this.source),'wire');this.receive=bytes=>{if(!this.destroyed&&this.isSynced)Y.applyUpdate(document,bytes,'wire')};this.update=(bytes,origin)=>{if(origin!=='wire'&&this.isSynced&&!this.destroyed)Y.applyUpdate(this.source,bytes,this)};this.source.on('update',this.receive);document.on('update',this.update)}
  sendStateless(value:string){const request=JSON.parse(value);this.sent.push(request);if(request.type==='hcd-save-state')void(async()=>{const digest=await wordBrowserDigest(model),imageDigest=await imageDraftDigest(server);if(!this.destroyed&&this.isSynced)this.emit('stateless',{payload:JSON.stringify({type:'hcd-save-status',nodeEditVersion:7,wordRegionVersion:2,wordLayoutVersion:1,stateId:'c'.repeat(32),stateSequence:++sequence,revision:projection.revision,status:'saved',pending:false,digest,imageDigest})})})()}
  disconnect(){if(!this.isSynced)return;this.isSynced=false;this.emit('status',{status:'disconnected'})}
  destroy(){this.disconnect();this.destroyed=true;this.source.off('update',this.receive);this.document.off('update',this.update);this.removeAllListeners()}
 }
 const owner=new WordLiveSession({session:{documentId:'doc',token:'test',scope,format:'docx',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'},document,cache,provider:doc=>{const provider=new Provider(doc);providers.push(provider);return provider as unknown as HocuspocusProvider},projection:async()=>projection,storyProjection:async(_session,revision)=>{assert.ok(versions.has(revision));return versions.get(revision)!},linkProof:async(_session,requestId,revision)=>{assert.equal(revision,2);return prepareWordLinkSessionProof(requestId,versions.get(1)!,versions.get(2)!,linkRecord)},status:async()=>{statusCalls++;await statusWait;return{schemaVersion:linkRound?'hcd-word-active-link-status/1':storyRound?'hcd-word-active-story-status/1':'hcd-word-active-layout-status/1',documentId:'doc',epoch:1,transactionId:nonce,...(status==='installed'?{status,revision:2}:{status})}},beforeApply:()=>apply(),timeoutMs:5000})
 await owner.start();await until(()=>owner.connection!.controller.state().saved);owner.connection!.controller.setTopologyInputPause(()=>()=>{})
 async function change(story:boolean|'link'=false){
  storyRound=story===true;linkRound=story==='link'
  const old=providers[0];old.emit('stateless',{payload:JSON.stringify({type:'hcd-word-topology-prepare',...wordTopologyWire,requestId:nonce})});await until(()=>old.sent.some(message=>message.type==='hcd-word-topology-ready'&&message.ready))
  const next=new Y.Doc();Y.applyUpdate(next,Y.encodeStateAsUpdate(server));server=next;documents.push(next);model=new WordRegionStore(next,wordRegionSchema(),'doc',projection.flowLayout,projection.flowLayoutHash);const layout=structuredClone(projection.flowLayout);layout.sections[0].page.widthTwips=11906
  if(story==='link'){
   const base=structuredClone(projection),receipt=structuredClone(base);receipt.revision=2;receipt.flowLayoutHash='d'.repeat(64);delete receipt.flowLayout.sections[1].headers.default
   const request:WordLinkTransaction={schemaVersion:'hcd-word-story-link/1',documentId:'doc',transactionId:nonce,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},link:{baseLayoutHash:hash,sectionId:id(10),kind:'header',variant:'default',expectedDirectStoryId:id(12)}}
   linkRecord={documentId:'doc',revision:2,parentRevision:1,patchBaseRevision:1,patchId:'word-story-link-'+nonce,patchHash:wordLinkRequestHash(request),rootHash:'f'.repeat(64),structuralChange:true,wordLayoutChange:true,authorId:'alice',authorName:'Alice'}
   model.acceptLinkFields(hash,receipt.flowLayout,receipt.flowLayoutHash,request);projection=receipt
  }else if(story===true){
   const base=structuredClone(projection),receipt=structuredClone(base),storyId=`n_${nonce}`
   receipt.revision=2;receipt.flowLayoutHash='d'.repeat(64);receipt.flowLayout.sections[0].footers.default=storyId;receipt.flowLayout.stories.push({id:storyId,kind:'footer',sourcePart:`word/hcd-${nonce}.xml`})
   const blocks:WordRegionProjection['blocks']=[{flowRegionId:storyId,blockId:id(40),blockHash:hash,region:'footer',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Independent footer',nodeId:id(41)}]}}];receipt.blocks.push(...blocks)
   model.acceptStoryReceipt(base,receipt,{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},blocks);projection=receipt
  }else{
  model.acceptLayoutFields(hash,layout,'d'.repeat(64),{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:nonce,baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash,changes:[{sectionId:id(1),field:'widthTwips',expected:12240,value:11906}]}})
  projection={...projection,revision:2,flowLayout:layout,flowLayoutHash:'d'.repeat(64)}
  }
  versions.set(2,structuredClone(projection));old.disconnect()
 }
 return{owner,document,cache,providers,change,server:()=>model,onApply:(fn:()=>void)=>{apply=fn},status:(value:typeof status)=>{status=value},waitStatus:(wait:Promise<void>)=>{statusWait=wait},calls:()=>statusCalls,close:async()=>{await owner.dispose();document.destroy();for(const doc of documents)doc.destroy()}}
}
test('normal connection replacement retains the view, personal undo and journal; every transport starts empty',async()=>{
 const f=await fixture(),old=f.owner.connection!,manager=old.controller.model!.structure.undoManager(),order:string[]=[];let views=0
 try{
  manager.stopCapturing();edit(old.controller.model!,'Base own');manager.stopCapturing();await f.cache.flush();const clientId=f.document.clientID;f.onApply(()=>{views++;order.push('unmount')});f.owner.setBeforeRebind(()=>{order.push('snapshot');return()=>{order.push('destroy')}})
  await f.change();await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old)
  assert.equal(views,1);assert.deepEqual(order,['snapshot','unmount','destroy']);assert.equal(f.owner.connection!.document,old.document);assert.equal(f.document.clientID,clientId);assert.ok(f.providers.every(provider=>provider.seedSize===0));assert.equal(old.controller.state().readOnly,true)
  assert.equal(f.owner.connection!.controller.model!.layoutState().layout.sections[0].page.widthTwips,11906)
  edit(f.server(),'Base own peer');assert.ok(manager.undo());assert.equal(f.server().project(id(1)).textContent,'Base peer');assert.ok(manager.redo());assert.equal(f.server().project(id(1)).textContent,'Base own peer')
  await f.cache.flush();const restored=await f.cache.document();try{assert.equal(new WordRegionStore(restored,wordRegionSchema(),'doc',f.owner.connection!.controller.projection!.flowLayout,'d'.repeat(64)).project(id(1)).textContent,'Base own peer')}finally{restored.destroy()}
 }finally{manager.destroy();await f.close()}
})
test('unknown round status keeps the original draft and never creates a replacement transport',async()=>{
 const f=await fixture();try{f.status('recovery-required');const old=f.owner.connection;await f.change();await until(()=>f.owner.phase==='recovery-required');assert.equal(f.owner.connection,old);assert.equal(f.providers.length,1);assert.equal(f.owner.requestId,nonce);await f.owner.retry().catch(()=>{});assert.equal(f.calls(),2);assert.ok((await f.cache.records()).length>0)}finally{await f.close()}
})
test('late teardown input is rejected and remains in the live device journal',async()=>{
 const f=await fixture();try{const old=f.owner.connection!;f.onApply(()=>edit(old.controller.model!,'Late teardown input'));await f.change();await until(()=>f.owner.phase==='recovery-required');assert.match(f.owner.problem!,/review-required/);assert.equal(f.server().project(id(1)).textContent,'Base');await f.cache.flush();assert.ok((await f.cache.localUpdates()).length>0);const restored=await f.cache.document();try{assert.equal(new WordRegionStore(restored,wordRegionSchema(),'doc',old.controller.projection!.flowLayout,hash).project(id(1)).textContent,'Late teardown input')}finally{restored.destroy()}}finally{await f.close()}
})
test('read-only members reconnect without becoming writable and disposal cancels a pending round',async()=>{
 const f=await fixture('read');try{await f.change();await until(()=>f.owner.phase==='ready'&&f.providers.length===2);assert.equal(f.owner.connection!.controller.state().readOnly,true)}finally{await f.close()}
 const g=await fixture();g.status('pending');await g.change();await until(()=>g.owner.phase==='reconnecting');await g.owner.dispose();assert.equal(g.providers.length,1);await g.close()
})
test('a status backend ignoring cancellation cannot create another transport after unmount',async()=>{
 const f=await fixture();let release!:()=>void
 try{f.waitStatus(new Promise<void>(resolve=>{release=resolve}));await f.change();await until(()=>f.calls()===1);await f.owner.dispose();release();await pause();assert.equal(f.providers.length,1)}finally{release?.();await f.close()}
})

test('normal story replacement verifies immutable projections while retaining the journal and personal history',async()=>{
 const f=await fixture(),old=f.owner.connection!,manager=old.controller.model!.structure.undoManager()
 try{
  manager.stopCapturing();edit(old.controller.model!,'Base own');manager.stopCapturing();await f.cache.flush();const clientId=f.document.clientID
  await f.change(true);await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old)
  const current=f.owner.connection!.controller.model!,storyId=`n_${nonce}`;assert.equal(current.document.clientID,clientId);assert.ok(f.providers.every(provider=>provider.seedSize===0));assert.equal(current.project(storyId).textContent,'Independent footer')
  edit(f.server(),'Base own peer');assert.ok(manager.undo());assert.equal(f.server().project(id(1)).textContent,'Base peer');assert.equal(f.server().project(storyId).textContent,'Independent footer');assert.ok(manager.redo());assert.equal(f.server().project(id(1)).textContent,'Base own peer')
  await f.cache.flush();const restored=await f.cache.document();try{assert.equal(new WordRegionStore(restored,wordRegionSchema(),'doc',current.layoutState().layout,current.layoutState().layoutHash).project(storyId).textContent,'Independent footer')}finally{restored.destroy()}
 }finally{manager.destroy();await f.close()}
})
test('read-only normal story members reconnect without edit authority',async()=>{
 const f=await fixture('read');try{const old=f.owner.connection;await f.change(true);await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old);assert.equal(f.owner.connection!.controller.state().readOnly,true)}finally{await f.close()}
})

test('normal link replacement retains personal history, orphaned story content and the device journal',async()=>{
 const f=await fixture('write',true),old=f.owner.connection!,manager=old.controller.model!.structure.undoManager()
 try{
  manager.stopCapturing();edit(old.controller.model!,'Base own');manager.stopCapturing();await f.cache.flush();const clientId=f.document.clientID
  await f.change('link');await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old)
  const model=f.owner.connection!.controller.model!;assert.equal(f.document.clientID,clientId);assert.ok(f.providers.every(provider=>provider.seedSize===0));assert.equal(model.layoutState().layout.sections[1].headers.default,undefined);assert.equal(model.project(id(12)).textContent,'Region 12')
  edit(f.server(),'Base own peer');assert.ok(manager.undo());assert.equal(f.server().project(id(1)).textContent,'Base peer');assert.ok(manager.redo());assert.equal(f.server().project(id(1)).textContent,'Base own peer')
  assert.equal(model.layoutState().layout.sections[1].headers.default,undefined)
  await f.cache.flush();const restored=await f.cache.document();try{const copy=new WordRegionStore(restored,wordRegionSchema(),'doc',model.layoutState().layout,model.layoutState().layoutHash);assert.equal(copy.project(id(1)).textContent,'Base own peer');assert.equal(copy.project(id(12)).textContent,'Region 12')}finally{restored.destroy()}
 }finally{manager.destroy();await f.close()}
})
test('read-only link members stay read-only, and late teardown text never seeds a replacement',async()=>{
 const f=await fixture('read',true);try{const old=f.owner.connection;await f.change('link');await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old);assert.equal(f.owner.connection!.controller.state().readOnly,true)}finally{await f.close()}
 const g=await fixture('write',true);try{const old=g.owner.connection!;g.onApply(()=>edit(old.controller.model!,'Late after link'));await g.change('link');await until(()=>g.owner.phase==='recovery-required');assert.match(g.owner.problem!,/review-required/);assert.equal(g.server().project(id(1)).textContent,'Base');await g.cache.flush();assert.ok((await g.cache.localUpdates()).length>0)}finally{await g.close()}
})

for(const kind of [false,true,'link'] as const)test(`a later ordinary reconnect does not query a completed ${kind===false?'page':kind===true?'story':'link'} round and retains personal history`,async()=>{
 const f=await fixture('write',kind==='link'),old=f.owner.connection!,manager=old.controller.model!.structure.undoManager()
 try{
  manager.stopCapturing();edit(old.controller.model!,'Base own');manager.stopCapturing();await f.change(kind);await until(()=>f.owner.phase==='ready'&&f.owner.connection!==old)
  assert.equal(f.owner.requestId,undefined)
  const before=f.owner.connection!,calls=f.calls(),client=f.document.clientID;f.status('recovery-required');edit(f.server(),'Base own peer');f.providers.at(-1)!.disconnect()
  assert.equal(f.owner.phase,'failed');assert.equal(before.controller.state().readOnly,true);assert.equal(f.owner.canRetry,true);assert.equal(f.providers.length,2)
  await f.owner.retry();assert.equal(f.owner.phase,'ready');assert.notEqual(f.owner.connection,before);assert.equal(f.calls(),calls);assert.equal(f.document.clientID,client);assert.ok(f.providers.every(provider=>provider.seedSize===0))
  assert.equal(f.owner.canRetry,false);assert.ok(manager.undo());assert.equal(f.server().project(id(1)).textContent,'Base peer');assert.ok(manager.redo());assert.equal(f.server().project(id(1)).textContent,'Base own peer')
  await f.cache.flush();const restored=await f.cache.document();try{assert.equal(new WordRegionStore(restored,wordRegionSchema(),'doc',f.owner.connection!.controller.projection!.flowLayout,f.owner.connection!.controller.projection!.flowLayoutHash).project(id(1)).textContent,'Base own peer')}finally{restored.destroy()}
 }finally{manager.destroy();await f.close()}
})
test('ordinary reconnect before any structure operation requires explicit retry and starts with an empty transport',async()=>{
 const f=await fixture();try{const old=f.owner.connection!;edit(old.controller.model!,'Base own');await f.cache.flush();f.providers[0].disconnect();assert.equal(f.owner.phase,'failed');assert.equal(f.providers.length,1);assert.equal(f.owner.canRetry,true);await f.owner.retry();assert.notEqual(f.owner.connection,old);assert.equal(f.calls(),0);assert.equal(f.owner.connection!.controller.model!.project(id(1)).textContent,'Base own');assert.ok(f.providers.every(provider=>provider.seedSize===0))}finally{await f.close()}
})
test('unacknowledged old-view changes never seed a fresh connection and remain in the device journal',async()=>{
 const f=await fixture();try{const old=f.owner.connection!;f.providers[0].disconnect();edit(old.controller.model!,'Private late input');await f.cache.flush();await assert.rejects(f.owner.retry(),/word-session-review-required/);assert.equal(f.owner.connection,old);assert.equal(f.owner.phase,'recovery-required');assert.equal(f.server().project(id(1)).textContent,'Base');assert.equal(old.controller.state().readOnly,true);assert.equal(f.providers.at(-1)!.destroyed,true);assert.ok((await f.cache.localUpdates()).length>0);const restored=await f.cache.document();try{assert.equal(new WordRegionStore(restored,wordRegionSchema(),'doc',old.controller.projection!.flowLayout,hash).project(id(1)).textContent,'Private late input')}finally{restored.destroy()}}finally{await f.close()}
})
test('ordinary read-only reconnect retains read-only authority',async()=>{
 const f=await fixture('read');try{f.providers[0].disconnect();assert.equal(f.owner.canRetry,true);await f.owner.retry();assert.equal(f.owner.phase,'ready');assert.equal(f.owner.connection!.controller.state().readOnly,true);assert.ok(f.providers.every(provider=>provider.seedSize===0))}finally{await f.close()}
})
test('authentication failure cannot use ordinary reconnect to regain edit authority',async()=>{
 const f=await fixture();try{f.providers[0].emit('authenticationFailed',{});assert.equal(f.owner.phase,'failed');assert.equal(f.owner.canRetry,false);await assert.rejects(f.owner.retry(),/word-session-recovery-required/);assert.equal(f.providers.length,1);assert.equal(f.owner.connection!.controller.state().readOnly,true)}finally{await f.close()}
})
