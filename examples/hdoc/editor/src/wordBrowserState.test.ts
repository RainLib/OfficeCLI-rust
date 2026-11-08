import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,type WordRegionProjection} from './wordRegionStore.ts'
import {WordBrowserState,wordBrowserDigest,type WordClientReceipt,type WordBrowserDisconnect} from './wordBrowserState.ts'
import {WordDeviceDraft} from './wordDeviceDraft.ts'
import {splitWordRecoveryUpdate,WordRecoveryChunkAssembly} from './wordRecoveryChunks.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordDeviceBackup} from './wordDeviceBackup.ts'
import {readWordDeviceBackup} from './wordDeviceBackupReader.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import type {WordBrowserProtocol} from './wordBrowserProtocol.ts'
import {wordDeviceIdentity} from './wordDeviceDraft.ts'
import type {Session} from './api.ts'
import {wordTopologyWire} from './wordTopologyPause.ts'

test('layout controller pauses synchronous input and save until the matching topology round releases',async()=>{
 const f=await fixture(undefined,wordLayoutProtocol);let paused=0,resumed=0
 try{
  await until(()=>f.controller.state().saved);f.controller.setTopologyInputPause(()=>{paused++;return()=>{resumed++}})
  const prepare={type:'hcd-word-topology-prepare',...wordTopologyWire,requestId:'a'.repeat(32)};f.provider.emit('stateless',{payload:JSON.stringify(prepare)})
  assert.equal(paused,1);assert.equal(f.controller.state().topologyPending,true);assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().saved,false);await assert.rejects(f.controller.save(),/topology-paused/)
  await until(()=>f.provider.sent.some(value=>value.type==='hcd-word-topology-ready'&&value.ready))
  f.provider.emit('stateless',{payload:JSON.stringify({...prepare,type:'hcd-word-topology-release',requestId:'b'.repeat(32)})});assert.equal(resumed,0)
  f.provider.emit('stateless',{payload:JSON.stringify({...prepare,type:'hcd-word-topology-release'})});assert.equal(resumed,1);assert.equal(f.controller.state().readOnly,false);assert.equal(f.controller.state().saved,true)
 }finally{await f.close()}
})

test('missing or composing input adapters refuse a topology pause; legacy controllers ignore the new model',async()=>{
 for(const protocol of [wordRegionalProtocol,wordLayoutProtocol]){const f=await fixture(undefined,protocol);try{
  await until(()=>f.controller.state().saved);const prepare={type:'hcd-word-topology-prepare',...wordTopologyWire,requestId:'a'.repeat(32)}
  for(const adapter of [false,true]){if(adapter)f.controller.setTopologyInputPause(()=>{throw Error('composition-active')});f.provider.emit('stateless',{payload:JSON.stringify(prepare)});await pause();assert.equal(f.controller.state().readOnly,false)}
  const replies=f.provider.sent.filter(value=>value.type==='hcd-word-topology-ready');assert.equal(replies.length,protocol===wordLayoutProtocol?2:0);assert.ok(replies.every(value=>value.ready===false))
 }finally{await f.close()}}
})

test('a paused disconnect reports its exact round once while the old controller stays permanently fenced',async()=>{
 const f=await fixture(undefined,wordLayoutProtocol),events:Readonly<WordBrowserDisconnect>[]=[]
 try{
  await until(()=>f.controller.state().saved);f.controller.setTopologyInputPause(()=>()=>{});f.controller.options.onDisconnect=event=>{events.push(event)}
  const prepare={type:'hcd-word-topology-prepare',...wordTopologyWire,requestId:'a'.repeat(32)};f.provider.emit('stateless',{payload:JSON.stringify(prepare)});await until(()=>f.provider.sent.some(value=>value.type==='hcd-word-topology-ready'&&value.ready))
  f.provider.emit('close',{});assert.deepEqual(events,[{reason:'word-browser-reconnect-required',topologyRequestId:prepare.requestId}]);assert.equal(Object.isFrozen(events[0]),true)
  f.provider.emit('stateless',{payload:JSON.stringify({...prepare,type:'hcd-word-topology-release'})});f.provider.emit('status',{status:'connected'});f.provider.emit('synced',{state:true});f.emit({...f.receipt,stateSequence:2});await pause()
  assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().saved,false);assert.equal(events.length,1)
 }finally{await f.close()}
})

test('resource preparation prevents saved/close/export without making editable text read-only',async()=>{
 const f=await fixture();try{await until(()=>f.controller.state().saved);f.controller.setResourcePending(true);assert.equal(f.controller.state().saved,false);assert.equal(f.controller.state().readOnly,false);await assert.rejects(f.controller.save(),/node-resource-pending/);f.controller.setResourcePending(false);assert.equal(f.controller.state().saved,true)}finally{await f.close()}
})
test('a resource or image choice started during save prevents its old receipt from authorizing close',async()=>{
 for(const resource of [false,true]){const f=await fixture();try{await until(()=>f.controller.state().saved);let request:any;f.provider.onSave=value=>{request=value};const saving=f.controller.save();await until(()=>!!request);if(resource)f.controller.setResourcePending(true);else f.controller.setLocalUploadPending(true);f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,stateSequence:2,requestId:request.requestId})});await assert.rejects(saving,/newer-changes/);assert.equal(f.controller.state().saved,false)}finally{await f.close()}}
})
import {imageDraftDigest,CollaborativeImageDraftStore,imageDraftMap} from './collaborativeImages.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),name='hcd-local-draft-v1-'+'a'.repeat(64)+'-1-wordregions1-device2'
const projection=():WordRegionProjection=>({documentId:'doc',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{default:id(3)}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'},{id:id(3),kind:'footer',sourcePart:'word/footer1.xml'}]},blocks:[1,2,3].map(n=>({flowRegionId:id(n),blockId:id(10+n),blockHash:hash,region:n===1?'body':n===2?'header':'footer',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Base text':n===2?'Header':'Footer',nodeId:id(20+n)}]}}))})
const pause=()=>new Promise(resolve=>setTimeout(resolve,1))
async function until(check:()=>boolean){const limit=Date.now()+3000;while(!check()){assert.ok(Date.now()<limit,'controller settled');await pause()}}
class Provider extends EventEmitter{isSynced=true;hasUnsyncedChanges=false;sent:any[]=[];onSave:((request:any)=>void)|undefined;sendStateless(value:string){const request=JSON.parse(value);this.sent.push(request);if(request.type==='hcd-save')this.onSave?.(request)}}
async function fixture(cache?:WordDeviceDraft,protocol:WordBrowserProtocol=wordRegionalProtocol){const native=projection(),seed=new Y.Doc(),document=new Y.Doc(),canonical=new WordRegionStore(seed,wordRegionSchema(),'doc',native.flowLayout,hash);canonical.initialize(native);Y.applyUpdate(document,Y.encodeStateAsUpdate(seed));const provider=new Provider(),receipt:WordClientReceipt={type:'hcd-save-status',wordRegionVersion:protocol===wordLayoutProtocol?2:1,...(protocol===wordLayoutProtocol?{wordLayoutVersion:1 as const}:{}),nodeEditVersion:7,stateId:'c'.repeat(32),stateSequence:1,status:'saved',revision:1,pending:false,digest:await wordBrowserDigest(canonical),imageDigest:await imageDraftDigest(seed)},controller=new WordBrowserState({document,provider,scope:'write',cache,protocol,projection:async()=>native}),emit=(value=receipt)=>provider.emit('stateless',{payload:JSON.stringify(value)});emit();return{native,seed,canonical,document,provider,controller,receipt,emit,close:async()=>{controller.dispose();document.destroy();seed.destroy();await cache?.close()}}}
function edit(model:WordRegionStore,text:string,region=id(1)){const before=model.region(region),node=before[0].node;model.reconcile(region,before,[{key:before[0].key,node:node.type.createChecked(node.attrs,model.schema.text(text,node.firstChild?.marks))}])}
test('a staged device file reopens for comparison and restores only its local update',async()=>{
 const f=await fixture(),sourceFactory=new IDBFactory(),targetFactory=new IDBFactory(),base='https://example.test/editor',session:Session={documentId:'doc',token:'secret',scope:'write',format:'docx',apiUrl:'https://example.test/v1/documents',collabUrl:'wss://example.test/collab',userId:'alice',collaborationEpoch:1,collaborationProtocol:wordRegionalProtocol},identity=await wordDeviceIdentity(session,'alice',base),source=await WordDeviceDraft.open(identity.name,sourceFactory),target=await WordDeviceDraft.open(identity.name,targetFactory),mine=new Y.Doc(),peer=new Y.Doc(),document=new Y.Doc();let controller:WordBrowserState|undefined
 try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash),other=new WordRegionStore(peer,wordRegionSchema(),'doc',f.native.flowLayout,hash)
  await source.bind(mine);edit(local,'Imported local text');let peerUpdate!:Uint8Array;peer.on('update',value=>{peerUpdate=value});edit(other,'Private peer header',id(2));Y.applyUpdate(mine,peerUpdate,'peer');await source.flush()
  const parsed=await readWordDeviceBackup(await wordDeviceBackup(source,session),session,base);await target.importBackup({...parsed,id:'a'.repeat(64)});Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed));const provider=new Provider();controller=new WordBrowserState({document,provider,scope:'write',cache:target,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify(f.receipt)});await until(()=>!!controller!.recovery)
  assert.match(controller.recovery!.local,/Private peer header/);assert.match(controller.recovery!.own,/Imported local text/);await controller.chooseDevice('restore');assert.equal(controller.model!.project(id(1)).textContent,'Imported local text');assert.equal(controller.model!.project(id(2)).textContent,'Header')
 }finally{controller?.dispose();await source.close();await target.close();mine.destroy();peer.destroy();document.destroy();await f.close()}
})
test('native projection plus matching shared metadata is required before editing; stale or legacy receipts do not admit a model',async()=>{const f=await fixture();try{await until(()=>f.controller.state().saved);assert.equal(f.controller.state().ready,true);f.document.getMap(wordRegionStoreField).set('layoutHash','b'.repeat(64));await pause();assert.equal(f.controller.state().ready,false);f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,wordRegionVersion:undefined,revision:99})});assert.equal(f.controller.receipt!.revision,1)}finally{await f.close()}})
test('save cannot close/export across newer input and never reports an unsynchronized provider as saved',async()=>{const f=await fixture();try{await until(()=>f.controller.state().ready);edit(f.controller.model!,'Captured');let request:any;f.provider.onSave=value=>{request=value};const pending=f.controller.save();await until(()=>!!request);edit(f.controller.model!,'Newer input');f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,stateSequence:2,status:'saved',pending:false,digest:request.digest,imageDigest:request.imageDigest,requestId:request.requestId})});await assert.rejects(pending,/newer-changes/);assert.equal(f.controller.state().saved,false);f.provider.hasUnsyncedChanges=true;await assert.rejects(f.controller.save(),/sync-required/)}finally{await f.close()}})
test('an authentication failure permanently fences this controller even when a delayed valid receipt arrives',async()=>{const f=await fixture();try{await until(()=>f.controller.state().ready);f.provider.emit('authenticationFailed',{});f.emit();await pause();assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().saved,false);assert.equal(f.controller.state().problem,'word-browser-authority-unavailable')}finally{await f.close()}})
test('device recovery replays only this member local updates and retains missing peer data in the comparison copy',async()=>{const factory=new IDBFactory(),cache=await WordDeviceDraft.open(name,factory),f=await fixture();try{await until(()=>f.controller.state().ready);const mine=new Y.Doc(),peer=new Y.Doc();Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.seed));const mm=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash),pm=new WordRegionStore(peer,wordRegionSchema(),'doc',f.native.flowLayout,hash);await cache.bind(mine);edit(mm,'Base text Own');let update!:Uint8Array;peer.on('update',value=>{update=value});edit(pm,'Peer Header',id(2));Y.applyUpdate(mine,update);await cache.flush();await cache.close();const reopened=await WordDeviceDraft.open(name,factory),provider=new Provider(),document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed));const controller=new WordBrowserState({document,provider,scope:'write',cache:reopened,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify(f.receipt)});await until(()=>!!controller.recovery);assert.equal(controller.state().readOnly,true);assert.match(controller.recovery!.local,/Peer Header/);await controller.chooseDevice('restore');await until(()=>controller.state().ready);assert.equal(controller.model!.project(id(1)).textContent,'Base text Own');assert.equal(controller.model!.project(id(2)).textContent,'Header');assert.equal((await reopened.pendingRecords()).records.filter(record=>record.local).length,1,'the pre-recorded recovery must not be appended a second time');const preserved=await reopened.document();assert.ok(preserved.store.clients.size>document.store.clients.size||preserved.store.clients.size>0);preserved.destroy();controller.dispose();await reopened.close();document.destroy();mine.destroy();peer.destroy()}finally{await f.close();await cache.close()}})

test('a matching but unsaved room does not consume the device recovery journal',async()=>{
 const factory=new IDBFactory(),f=await fixture(),initial=await WordDeviceDraft.open(name,factory),mine=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined,document:Y.Doc|undefined
 try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const model=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);await initial.bind(mine);edit(model,'Uncommitted local text');await initial.flush();await initial.close()
  cache=await WordDeviceDraft.open(name,factory);document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(mine));let provider=new Provider();controller=new WordBrowserState({document,provider,scope:'write',cache,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify({...f.receipt,status:'editing',pending:true,digest:await wordBrowserDigest(model)})});await until(()=>controller!.state().ready)
  assert.ok((await cache.pendingRecords()).records.some(record=>record.local));controller.dispose();controller=undefined;await cache.close();document.destroy()
  cache=await WordDeviceDraft.open(name,factory);document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed));provider=new Provider();controller=new WordBrowserState({document,provider,scope:'write',cache,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify(f.receipt)});await until(()=>!!controller!.recovery);assert.match(controller.recovery!.own,/Uncommitted local text/)
 }finally{controller?.dispose();await cache?.close();document?.destroy();mine.destroy();await initial.close();await f.close()}
})

test('a newer unsaved receipt cancels an automatic device review marker',async()=>{
 const factory=new IDBFactory(),f=await fixture(),initial=await WordDeviceDraft.open(name,factory),mine=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined,document:Y.Doc|undefined,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve});let reached!:()=>void;const entered=new Promise<void>(resolve=>{reached=resolve})
 try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const model=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);await initial.bind(mine);edit(model,'Retain this local text');await initial.flush();await initial.close()
  cache=await WordDeviceDraft.open(name,factory);const mark=cache.markReviewed.bind(cache);cache.markReviewed=async(count,signal)=>{reached();await gate;return mark(count,signal)}
  document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(mine));const provider=new Provider(),digest=await wordBrowserDigest(model);controller=new WordBrowserState({document,provider,scope:'write',cache,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify({...f.receipt,digest})});await entered
  provider.emit('stateless',{payload:JSON.stringify({...f.receipt,stateSequence:2,status:'editing',pending:true,digest})});release();await until(()=>controller!.state().ready)
  assert.ok((await cache.pendingRecords()).records.some(record=>record.local));assert.equal(controller.state().saved,false)
 }finally{release();controller?.dispose();await cache?.close();document?.destroy();mine.destroy();await initial.close();await f.close()}
})

test('same-version delayed status cannot undo a newer saved acknowledgement',async()=>{
 const f=await fixture();try{await until(()=>f.controller.state().saved);f.emit({...f.receipt,stateSequence:4});await until(()=>f.controller.receipt?.stateSequence===4);f.emit({...f.receipt,stateSequence:3,pending:true,status:'editing'});f.emit({...f.receipt,stateSequence:9,stateId:'d'.repeat(32),pending:true,status:'editing'});await pause();assert.equal(f.controller.receipt?.stateSequence,4);assert.equal(f.controller.state().saved,true)}finally{await f.close()}
})
test('new-version receipt immediately fences editing and saved state until immutable native verification finishes',async()=>{
 const f=await fixture();try{await until(()=>f.controller.state().saved);let release!:(value:WordRegionProjection)=>void;f.controller.options.projection=()=>new Promise(resolve=>{release=resolve});f.emit({...f.receipt,revision:2,stateSequence:2});assert.equal(f.controller.state().ready,false);assert.equal(f.controller.state().saved,false);await until(()=>!!release);release({...f.native,revision:2});await until(()=>f.controller.state().saved);assert.equal(f.controller.projection?.revision,2)}finally{await f.close()}
})
test('disconnect freezes the old document instead of allowing warm reconnect to replay cached peer updates',async()=>{
 const f=await fixture();try{await until(()=>f.controller.state().saved);let stopped=0;f.controller.options.onDisconnect=()=>{stopped++};f.provider.emit('status',{status:'disconnected'});assert.equal(stopped,1);assert.equal(f.controller.state().readOnly,true);f.provider.emit('status',{status:'connected'});f.provider.emit('synced',{state:true});f.emit({...f.receipt,stateSequence:2});await pause();assert.equal(f.controller.state().saved,false);assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().problem,'word-browser-reconnect-required');await assert.rejects(f.controller.save(),/sync-required/)}finally{await f.close()}
})
test('authority failure during native verification cannot be cleared by its late successful response',async()=>{
 const f=await fixture();try{await until(()=>f.controller.state().saved);let release!:(value:WordRegionProjection)=>void;f.controller.options.projection=()=>new Promise(resolve=>{release=resolve});f.emit({...f.receipt,revision:2,stateSequence:2});await until(()=>!!release);f.provider.emit('authenticationFailed',{});release({...f.native,revision:2});await pause();await pause();assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().saved,false);assert.equal(f.controller.state().problem,'word-browser-authority-unavailable')}finally{await f.close()}
})

test('per-document CLOSE is fenced even when its websocket stays open',async()=>{const f=await fixture();try{await until(()=>f.controller.state().saved);f.provider.isSynced=false;f.provider.emit('close',{event:{code:1000,reason:'word-room-canonical-source'}});assert.equal(f.controller.state().problem,'word-browser-reconnect-required');assert.equal(f.controller.state().readOnly,true);assert.equal(f.controller.state().saved,false)}finally{await f.close()}})

test('image save verifies the acknowledged remaining-intent digest after captured intents are consumed',async()=>{
 for(const late of [false,true]){const f=await fixture();try{await until(()=>f.controller.state().saved);const images=new CollaborativeImageDraftStore(f.document),geometry={unit:'pt' as const,x:0,y:0,width:72,height:36},base={nodeId:id(90),visualHash:hash,geometry};images.edit(base,1,{...geometry,width:80});await until(()=>!f.controller.state().saved);f.provider.onSave=request=>{void(async()=>{f.document.getMap(imageDraftMap).clear();const imageDigest=await imageDraftDigest(f.document);assert.notEqual(imageDigest,request.imageDigest);f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,stateSequence:2,status:'saved',pending:false,requestId:request.requestId,imageDigest})});if(late)images.edit(base,1,{...geometry,width:100})})()};if(late){await assert.rejects(f.controller.save(),/newer-changes/);assert.equal(f.controller.state().saved,false)}else{assert.equal(await f.controller.save(),1);await until(()=>f.controller.state().saved)}}finally{await f.close()}}
})
test('a peer edit during asynchronous device recovery preserves the journal and requires a fresh comparison',async()=>{
 for(const [phase,action] of [['append','restore'],['bind','restore'],['bind','keep'],['mark','keep']] as const){
  const factory=new IDBFactory(),seedFixture=await fixture(),initial=await WordDeviceDraft.open(name,factory),mine=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined,doc:Y.Doc|undefined,release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve});let reached!:()=>void;const entered=new Promise<void>(resolve=>{reached=resolve})
  try{
   await until(()=>seedFixture.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(seedFixture.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',seedFixture.native.flowLayout,hash)
   await initial.bind(mine);edit(local,'Base text Own');await initial.flush();await initial.close()
   cache=await WordDeviceDraft.open(name,factory);doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(seedFixture.seed));const provider=new Provider()
   controller=new WordBrowserState({document:doc,provider,scope:'write',cache,projection:async()=>seedFixture.native});provider.emit('stateless',{payload:JSON.stringify(seedFixture.receipt)});await until(()=>!!controller!.recovery)
   if(phase==='append'){const append=cache.append.bind(cache);cache.append=async(bytes,local)=>{reached();await gate;return append(bytes,local)}}
   else if(phase==='bind'){const bind=cache.bind.bind(cache);cache.bind=async(document,options)=>{reached();await gate;return bind(document,options)}}
   else{const mark=cache.markReviewed.bind(cache);cache.markReviewed=async(count,signal)=>{reached();await gate;return mark(count,signal)}}
   const choice=controller.chooseDevice(action);await entered;edit(controller.model!,'Peer Header',id(2));release()
   await assert.rejects(choice,/word-device-review-changed/);assert.equal(controller.model!.project(id(1)).textContent,'Base text');assert.equal(controller.model!.project(id(2)).textContent,'Peer Header');assert.equal(controller.state().readOnly,true);assert.equal(controller.state().problem,'word-device-review-changed');assert.ok((await cache.pendingRecords()).records.some(record=>record.local))
   const latest=Y.encodeStateAsUpdate(doc);controller.dispose();controller=undefined;await cache.close();cache=await WordDeviceDraft.open(name,factory);doc.destroy();doc=new Y.Doc();Y.applyUpdate(doc,latest);const retryProvider=new Provider();controller=new WordBrowserState({document:doc,provider:retryProvider,scope:'write',cache,projection:async()=>seedFixture.native});retryProvider.emit('stateless',{payload:JSON.stringify(seedFixture.receipt)});await until(()=>!!controller!.recovery);assert.equal(controller.recovery!.canRestore,true);assert.match(controller.recovery!.server,/Peer Header/);assert.match(controller.recovery!.own,/Base text Own/)
  }finally{release();controller?.dispose();await cache?.close();doc?.destroy();mine.destroy();await initial.close();await seedFixture.close()}
 }
})
test('oversized device recovery is rejected before the room changes and keeps its local journal',async()=>{
 const factory=new IDBFactory(),seedFixture=await fixture(),initial=await WordDeviceDraft.open(name,factory),mine=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined,doc:Y.Doc|undefined
 try{
  await until(()=>seedFixture.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(seedFixture.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',seedFixture.native.flowLayout,hash)
  await initial.bind(mine);edit(local,'X'.repeat(1024*1024));await initial.flush();await initial.close()
  cache=await WordDeviceDraft.open(name,factory);doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(seedFixture.seed));const provider=new Provider()
  controller=new WordBrowserState({document:doc,provider,scope:'write',cache,projection:async()=>seedFixture.native});provider.emit('stateless',{payload:JSON.stringify(seedFixture.receipt)});await until(()=>!!controller!.recovery)
  assert.equal(controller.recovery!.problem,'word-device-recovery-too-large');assert.equal(controller.recovery!.canRestore,false)
  const before=Y.encodeStateAsUpdate(doc),pending=(await cache.pendingRecords()).count;await assert.rejects(controller.chooseDevice('restore'),/word-device-recovery-too-large/);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);assert.equal((await cache.pendingRecords()).count,pending);assert.ok((await cache.localUpdates()).length)
 }finally{controller?.dispose();await cache?.close();doc?.destroy();mine.destroy();await initial.close();await seedFixture.close()}
})
test('large device recovery keeps its journal and forces comparison after success or unknown transport outcome',async()=>{
 for(const fail of [false,true]){
  const factory=new IDBFactory(),f=await fixture(),initial=await WordDeviceDraft.open(name,factory),mine=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined,doc:Y.Doc|undefined
  try{
   await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const model=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);await initial.bind(mine);edit(model,'X'.repeat(1024*1024));await initial.flush();await initial.close();cache=await WordDeviceDraft.open(name,factory);doc=new Y.Doc();Y.applyUpdate(doc,Y.encodeStateAsUpdate(f.seed));const provider=new Provider();let calls=0,baseline!:Uint8Array
   controller=new WordBrowserState({document:doc,provider,scope:'write',cache,projection:async()=>f.native,largeRecovery:async(_update,snapshot)=>{calls++;baseline=snapshot;if(fail)throw Error('response lost')}});provider.emit('stateless',{payload:JSON.stringify(f.receipt)});await until(()=>!!controller!.recovery);assert.equal(controller.recovery!.canRestore,true)
   await assert.rejects(controller.chooseDevice('restore'),fail?/word-device-large-uncertain/:/word-device-large-reconnect/);assert.equal(calls,1);assert.deepEqual(baseline,Y.encodeSnapshot(Y.snapshot(doc)));assert.equal(controller.state().readOnly,true);assert.ok((await cache.pendingRecords()).records.some(record=>record.local));assert.equal(controller.model!.project(id(1)).textContent,'Base text')
  }finally{controller?.dispose();await cache?.close();doc?.destroy();mine.destroy();await initial.close();await f.close()}
 }
})
test('device recovery records only the delta not already present in the room',async()=>{
 const f=await fixture(),mine=new Y.Doc(),copy=new Y.Doc();try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash),updates:Uint8Array[]=[];mine.on('update',value=>updates.push(value))
  edit(local,'Long text '+'x'.repeat(100000));Y.applyUpdate(f.document,updates[0]);await until(()=>!!f.controller.model);edit(local,'Long text '+'x'.repeat(100000)+'!')
  const planned=(f.controller as any).planDevice(updates) as Uint8Array;assert.ok(planned.length<Y.mergeUpdates(updates).length/10)
  Y.applyUpdate(copy,Y.encodeStateAsUpdate(f.document));Y.applyUpdate(copy,planned);const result=new WordRegionStore(copy,wordRegionSchema(),'doc',f.native.flowLayout,hash);assert.equal(result.project(id(1)).textContent,'Long text '+'x'.repeat(100000)+'!')
 }finally{mine.destroy();copy.destroy();await f.close()}
})
test('device recovery delta preserves deletion-only edits',async()=>{
 const f=await fixture(),mine=new Y.Doc(),copy=new Y.Doc();try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);let deletion!:Uint8Array;mine.on('update',value=>{deletion=value});edit(local,'Base tex')
  const planned=(f.controller as any).planDevice([deletion]) as Uint8Array;Y.applyUpdate(copy,Y.encodeStateAsUpdate(f.document));Y.applyUpdate(copy,planned)
  assert.equal(new WordRegionStore(copy,wordRegionSchema(),'doc',f.native.flowLayout,hash).project(id(1)).textContent,'Base tex')
 }finally{mine.destroy();copy.destroy();await f.close()}
})

test('a reassembled large recovery passes the region guard before one atomic room update',async()=>{
 const f=await fixture(),mine=new Y.Doc();try{
  await until(()=>f.controller.state().ready);Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const local=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);const updates:Uint8Array[]=[];mine.on('update',value=>updates.push(value));edit(local,'A'.repeat(600000));edit(local,'B'.repeat(600000),id(2));const update=Y.mergeUpdates(updates)
  const packet=await splitWordRecoveryUpdate(update),assembly=new WordRecoveryChunkAssembly(packet.manifest);for(const [index,chunk] of packet.chunks.entries())assembly.add(index,chunk)
  const complete=await assembly.finish(),guard=wordRoomGuard(f.controller.model!,()=>undefined);try{guard.accept(complete)}finally{guard.destroy()}
  let events=0;f.document.on('update',()=>events++);Y.applyUpdate(f.document,complete);assert.equal(events,1);assert.equal(f.controller.model!.project(id(1)).textContent.length,600000);assert.equal(f.controller.model!.project(id(2)).textContent.length,600000)
 }finally{mine.destroy();await f.close()}
})

test('layout browser admits only model 2 receipts and rejects a downgrade even when request and digest match',async()=>{
 const f=await fixture(undefined,wordLayoutProtocol)
 try{
  await until(()=>f.controller.state().saved)
  for(const wrong of [{wordRegionVersion:1,wordLayoutVersion:undefined},{wordRegionVersion:2,wordLayoutVersion:undefined},{wordRegionVersion:2,wordLayoutVersion:2}]){
   f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,...wrong,stateSequence:99,revision:99})});assert.equal(f.controller.receipt!.revision,1)
  }
  f.provider.onSave=request=>f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,wordRegionVersion:1,wordLayoutVersion:undefined,requestId:request.requestId,stateSequence:2})})
  await assert.rejects(f.controller.save(),/newer-changes/)
  f.provider.onSave=request=>f.provider.emit('stateless',{payload:JSON.stringify({...f.receipt,requestId:request.requestId,stateSequence:3})})
  assert.equal(await f.controller.save(),1);assert.equal(f.controller.state().saved,true)
 }finally{await f.close()}
})
test('a controller cannot attach a device journal from the other Word wire model',async()=>{
 const f=await fixture(),factory=new IDBFactory(),cache=await WordDeviceDraft.open(name,factory)
 try{assert.throws(()=>new WordBrowserState({document:f.document,provider:f.provider,scope:'write',protocol:wordLayoutProtocol,cache,projection:async()=>f.native}),/word-device-protocol/)}finally{await cache.close();await f.close()}
})
test('layout device recovery restores authored content while preserving peer data only in the comparison copy',async()=>{
 const factory=new IDBFactory(),f=await fixture(undefined,wordLayoutProtocol),cache=await WordDeviceDraft.open(name.replace('wordregions1-device2','wordregions2-device1'),factory),mine=new Y.Doc(),peer=new Y.Doc(),document=new Y.Doc();let controller:WordBrowserState|undefined
 try{
  Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.seed));Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed))
  const own=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash),other=new WordRegionStore(peer,wordRegionSchema(),'doc',f.native.flowLayout,hash)
  await cache.bind(mine);edit(own,'Layout authored text');let update!:Uint8Array;peer.on('update',value=>{update=value});edit(other,'Peer private header',id(2));Y.applyUpdate(mine,update,'peer');await cache.flush();await cache.close()
  const reopened=await WordDeviceDraft.open(cache.name,factory),provider=new Provider()
  try{
   controller=new WordBrowserState({protocol:wordLayoutProtocol,document,provider,scope:'write',cache:reopened,projection:async()=>f.native});provider.emit('stateless',{payload:JSON.stringify(f.receipt)})
   await until(()=>!!controller!.recovery);assert.match(controller.recovery!.local,/Peer private header/);assert.match(controller.recovery!.own,/Layout authored text/)
   await controller.chooseDevice('restore');await until(()=>controller!.state().ready);assert.equal(controller.model!.project(id(1)).textContent,'Layout authored text');assert.equal(controller.model!.project(id(2)).textContent,'Header')
  }finally{controller?.dispose();await reopened.close()}
 }finally{await cache.close();mine.destroy();peer.destroy();document.destroy();await f.close()}
})

test('a transient pinned baseline failure can recover on a newer receipt for the same revision',async()=>{
 const f=await fixture(undefined,wordLayoutProtocol),document=new Y.Doc(),provider=new Provider();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed));let failed=true,calls=0
 const controller=new WordBrowserState({document,provider,scope:'write',protocol:wordLayoutProtocol,projection:async()=>{calls++;if(failed)throw new Error('word-browser-baseline-unavailable');return f.native}})
 try{provider.emit('stateless',{payload:JSON.stringify(f.receipt)});await until(()=>!!controller.problem);assert.equal(controller.state().ready,false);failed=false;provider.emit('stateless',{payload:JSON.stringify({...f.receipt,stateSequence:2})});await until(()=>controller.state().saved);assert.equal(calls,2)}finally{controller.dispose();document.destroy();await f.close()}
})

test('authored device text from before a page transition restores without regressing the new layout metadata',async()=>{
 const f=await fixture(undefined,wordLayoutProtocol),factory=new IDBFactory(),cacheName=name.replace('wordregions1-device2','wordregions2-device1'),initial=await WordDeviceDraft.open(cacheName,factory),mine=new Y.Doc(),document=new Y.Doc();let cache:WordDeviceDraft|undefined,controller:WordBrowserState|undefined
 try{
  Y.applyUpdate(mine,Y.encodeStateAsUpdate(f.seed));const own=new WordRegionStore(mine,wordRegionSchema(),'doc',f.native.flowLayout,hash);await initial.bind(mine);edit(own,'Private text typed before page switch');await initial.flush();await initial.close()
  const native=structuredClone(f.native);native.revision=2;native.flowLayoutHash='e'.repeat(64);native.flowLayout.sections[0].page.widthTwips=11906
  const request={schemaVersion:'hcd-word-layout-transaction/1' as const,documentId:'doc',transactionId:'f'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:hash,changes:[{sectionId:id(1),field:'widthTwips',expected:null,value:11906}]}}
  f.canonical.acceptLayoutFields(hash,native.flowLayout,native.flowLayoutHash,request);Y.applyUpdate(document,Y.encodeStateAsUpdate(f.seed));cache=await WordDeviceDraft.open(cacheName,factory);const provider=new Provider()
  controller=new WordBrowserState({protocol:wordLayoutProtocol,document,provider,scope:'write',cache,projection:async()=>native});provider.emit('stateless',{payload:JSON.stringify({...f.receipt,revision:2,digest:await wordBrowserDigest(f.canonical),imageDigest:await imageDraftDigest(f.seed)})})
  await until(()=>!!controller!.recovery);assert.equal(controller.recovery!.canRestore,true,controller.recovery!.problem);assert.match(controller.recovery!.own,/Private text typed before page switch/);await controller.chooseDevice('restore');await until(()=>controller!.state().ready)
  assert.equal(controller.model!.project(id(1)).textContent,'Private text typed before page switch');assert.equal(controller.model!.layoutState().layout.sections[0].page.widthTwips,11906);assert.equal(document.getMap(wordRegionStoreField).get('layoutHash'),native.flowLayoutHash);assert.equal(controller.state().saved,false)
 }finally{controller?.dispose();await cache?.close();await initial.close();mine.destroy();document.destroy();await f.close()}
})
