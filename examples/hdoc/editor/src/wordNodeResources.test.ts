import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {WordDeviceDraft} from './wordDeviceDraft.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {WordNodeResourceClient,nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
const name='hcd-local-draft-v1-'+'b'.repeat(64)+'-1-wordregions1-device2',regionId='n_'+'1'.repeat(32)
const node:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block',data:{title:'Original'},fallback:{text:'Original'}}
const file=()=>new File(['archived bytes'],'original.png',{type:'image/png'})
const defer=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return{promise,resolve}}
async function fixture(){
 const factory=new IDBFactory(),cache=await WordDeviceDraft.open(name,factory);let calls=0,ready=true,hold:ReturnType<typeof defer>|undefined,arrive:ReturnType<typeof defer>|undefined
 const registry=new NodeExtensionRegistry([],()=>{},{archive:async input=>{calls++;const observed=await WordDeviceDraft.open(name,factory);try{assert.equal((await observed.pendingNodeResources()).length,1)}finally{await observed.close()}arrive?.resolve();await hold?.promise;return{key:input.key,name:input.name,mediaType:input.file.type,byteLength:input.file.size,hash:await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()))}},read:async()=>new Blob()});const closeRegistry=registry.connect(),options={cache,registry,ready:()=>ready},client=new WordNodeResourceClient(options);await client.initialize()
 return{factory,cache,registry,options,client,calls:()=>calls,deny:()=>{ready=false},delay:()=>{hold=defer();arrive=defer();return{hold,arrive}},close:async()=>{hold?.resolve();client.dispose();closeRegistry();await cache.close()}}
}
test('pending files need one journal read and files found by the final check appear without a third read',async()=>{
 const f=await fixture(),read=f.cache.pendingNodeResources.bind(f.cache);let reads=0
 try{
  const draft=await f.client.start(file(),node,regionId)
  f.cache.pendingNodeResources=async()=>{reads++;return read()}
  assert.equal(await f.client.checkPending(),true);assert.equal(reads,1)
  await f.client.cancel(draft.id);reads=0
  f.cache.pendingNodeResources=async()=>{reads++;if(reads===2)await f.cache.putNodeResource({...draft,id:crypto.randomUUID(),phase:'chosen'});return read()}
  assert.equal(await f.client.checkPending(),true);assert.equal(reads,2);assert.equal(f.client.state().jobs.length,1)
 }finally{f.cache.pendingNodeResources=read;await f.close()}
})
test('a concurrent newer refresh prevents an older empty check from authorizing an action',async()=>{
 const f=await fixture(),read=f.cache.pendingNodeResources.bind(f.cache),entered=defer(),release=defer();let reads=0
 try{
  f.cache.pendingNodeResources=async()=>{reads++;if(reads===2){const result=await read();entered.resolve();await release.promise;return result}return read()}
  const checking=f.client.checkPending();await entered.promise;await f.client.refresh();release.resolve()
  assert.equal(await checking,true)
 }finally{release.resolve();f.cache.pendingNodeResources=read;await f.close()}
})
test('file bytes are durable before transport and reopening never uploads or mutates a document automatically',async()=>{const f=await fixture();try{const draft=await f.client.start(file(),node,regionId);assert.equal(f.client.state().pending,true);assert.equal(f.calls(),1);f.client.dispose();await f.cache.close();const cache=await WordDeviceDraft.open(name,f.factory),client=new WordNodeResourceClient({...f.options,cache});try{await client.initialize();assert.equal(f.calls(),1);assert.deepEqual(client.state().jobs[0].draft,draft);assert.equal(client.state().pending,true);const changed={...node,data:{title:'Peer value'},fallback:{text:'Peer value'}};await client.attach(draft.id,async value=>({...changed,schemaVersion:'hcd.extension/2' as const,resources:[value.resource]}));assert.equal(client.state().pending,false);assert.deepEqual(await cache.pendingNodeResources(),[])}finally{client.dispose();await cache.close()}}finally{await f.close()}})
test('relinking an archived file re-pins it without a second body upload',async()=>{
 const {archiveNodeResource}=await import('./api.ts'),f=await fixture(),old=globalThis.fetch,session={documentId:'doc',token:'owned',scope:'write' as const,format:'docx'};let stored=false,uploads=0,reuses=0
 const registry=new NodeExtensionRegistry([],()=>{},{archive:input=>archiveNodeResource(session,input),read:async()=>new Blob()}),disconnect=registry.connect(),client=new WordNodeResourceClient({cache:f.cache,registry,ready:()=>true})
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/resources/reuse')){reuses++;const request=JSON.parse(String(init?.body));return stored?Response.json({hash:request.hash,byteLength:request.byteLength}):new Response('missing',{status:404})}uploads++;const body=new Uint8Array(await new Response(init?.body).arrayBuffer());stored=true;return Response.json({hash:await nodeResourceHash(body),byteLength:body.length})}
 try{await client.initialize();const original=new File(['attachment bytes'],'notes.bin');const draft=await client.start(original,node,regionId);await client.attach(draft.id,async value=>({...node,schemaVersion:'hcd.extension/2',resources:[value.resource]}));assert.equal(uploads,1);assert.equal(reuses,1);assert.equal(client.state().pending,false)}finally{globalThis.fetch=old;client.dispose();disconnect();await f.close()}
})
test('explicit cancellation beats a late resource response and its disk tombstone cannot be staged again',async()=>{const f=await fixture(),{hold,arrive}=f.delay();try{const pending=f.client.start(file(),node,regionId),failure=assert.rejects(pending);await arrive.promise;const draft=(await f.cache.pendingNodeResources())[0];await f.client.cancel(draft.id);assert.equal(f.client.state().pending,false);hold.resolve();await failure;assert.deepEqual(await f.cache.pendingNodeResources(),[]);const staged=await f.cache.stageNodeResource(draft);assert.equal(staged.phase,'cancelled');assert.equal(staged.bytes.byteLength,0)}finally{hold.resolve();await f.close()}})
test('disposing during upload retains exact bytes for an explicit later retry',async()=>{const f=await fixture(),{hold,arrive}=f.delay();try{const task=f.client.start(file(),node,regionId),failure=assert.rejects(task);await arrive.promise;f.client.dispose();await failure;hold.resolve();const client=new WordNodeResourceClient(f.options);try{await client.initialize();assert.equal(client.state().jobs.length,1);const id=client.state().jobs[0].id;await client.resume(id);assert.equal(f.calls(),2);assert.equal(client.state().jobs[0].phase,'archived');assert.equal(client.state().pending,true);await client.cancel(id)}finally{client.dispose()}}finally{await f.close()}})
test('a stale or denied attachment preserves the archived choice and does not claim document completion',async()=>{const f=await fixture();try{const draft=await f.client.start(file(),node,regionId);await assert.rejects(f.client.attach(draft.id,async()=>{throw new Error('selection changed')}),/selection changed/);assert.equal(f.client.state().pending,true);assert.equal((await f.cache.pendingNodeResources())[0].phase,'archived');await assert.rejects(f.client.linked(draft.id,{...node,schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'3'.repeat(32),resources:[draft.resource]}),/target-changed/);f.deny();const calls=f.calls();await assert.rejects(f.client.attach(draft.id,async()=>{throw new Error('must not run')}),/authority/);assert.equal(f.calls(),calls);assert.equal(f.client.state().pending,true)}finally{await f.close()}})
test('device resource write failures leave ordinary text journal usable and never start network work',async()=>{const f=await fixture(),doc=new Y.Doc();try{const one=await f.client.start(file(),node,regionId);await assert.rejects(f.cache.putNodeResource({...one,phase:'chosen'}),/exists/);await f.cache.bind(doc);doc.getText('text').insert(0,'Own text still recorded');await f.cache.flush();const copy=await f.cache.document();assert.equal(copy.getText('text').toString(),'Own text still recorded');copy.destroy();const put=f.cache.putNodeResource;f.cache.putNodeResource=()=>Promise.reject(new Error('quota'));const calls=f.calls();await assert.rejects(f.client.start(file(),node,regionId),/quota/);assert.equal(f.calls(),calls);assert.equal(f.client.state().jobs.length,1);f.cache.putNodeResource=put}finally{doc.destroy();await f.close()}})
test('a committed device choice is rediscovered when its write reports an unknown result',async()=>{
 const f=await fixture(),put=f.cache.putNodeResource.bind(f.cache);let notifications=0
 const client=new WordNodeResourceClient({...f.options,notify:()=>notifications++})
 try{await client.initialize();f.cache.putNodeResource=async value=>{await put(value);throw new Error('write outcome unknown')}
  await assert.rejects(client.start(file(),node,regionId),/write outcome unknown/)
  assert.equal(f.calls(),0);assert.equal(notifications,1);assert.equal(client.state().pending,true)
  const [job]=client.state().jobs;assert.equal(job.phase,'chosen');assert.ok(job.draft)
  assert.deepEqual(new Uint8Array(await (await client.readPendingFile(job.id)).blob.arrayBuffer()),new Uint8Array(await file().arrayBuffer()))
  assert.equal(await client.checkPending(),true)
 }finally{f.cache.putNodeResource=put;client.dispose();await f.close()}
})
test('an uncertain device write with unavailable readback blocks saving until storage can be checked',async()=>{
 const f=await fixture(),put=f.cache.putNodeResource.bind(f.cache),read=f.cache.pendingNodeResources.bind(f.cache)
 const client=new WordNodeResourceClient(f.options)
 try{await client.initialize();f.cache.putNodeResource=async value=>{await put(value);throw new Error('write outcome unknown')};f.cache.pendingNodeResources=async()=>{throw new Error('device unavailable')}
  await assert.rejects(client.start(file(),node,regionId),/write outcome unknown/)
  assert.equal(f.calls(),0);assert.equal(client.state().problem,'word-node-resource-storage');assert.equal(client.state().pending,true);assert.equal(await client.checkPending(),true)
  f.cache.pendingNodeResources=read;await client.refresh();assert.equal(client.state().jobs.length,1);assert.equal(client.state().pending,true)
 }finally{f.cache.putNodeResource=put;f.cache.pendingNodeResources=read;client.dispose();await f.close()}
})
test('a failed notification leaves the persisted choice immediately downloadable',async()=>{
 const f=await fixture(),client=new WordNodeResourceClient({...f.options,notify:()=>{throw new Error('notification failed')}})
 try{await client.initialize();await assert.rejects(client.start(file(),node,regionId),/notification failed/)
  const [job]=client.state().jobs;assert.equal(job.phase,'chosen');assert.ok(job.draft);assert.equal(client.state().pending,true);assert.equal(f.calls(),0)
  assert.deepEqual(new Uint8Array(await (await client.readPendingFile(job.id)).blob.arrayBuffer()),new Uint8Array(await file().arrayBuffer()))
 }finally{client.dispose();await f.close()}
})
test('another window cancelling prevents stale upload completion from recreating the choice',async()=>{const f=await fixture(),{hold,arrive}=f.delay();try{const pending=f.client.start(file(),node,regionId),failure=assert.rejects(pending,/finished/);await arrive.promise;const draft=(await f.cache.pendingNodeResources())[0],other=await WordDeviceDraft.open(name,f.factory);await other.finishNodeResource(draft.id,'cancelled');await other.close();hold.resolve();await failure;await f.client.refresh();assert.equal(f.client.state().pending,false);assert.deepEqual(await f.cache.pendingNodeResources(),[])}finally{hold.resolve();await f.close()}})
test('corrupted persisted bytes cannot be uploaded or passed to an attachment callback',async()=>{const f=await fixture();try{const original=await f.client.start(file(),node,regionId);await f.client.cancel(original.id);const corrupted:WordNodeResourceDraft={...original,id:crypto.randomUUID(),phase:'chosen',bytes:new Uint8Array(original.bytes.length)};await f.cache.putNodeResource(corrupted);await f.client.refresh();const calls=f.calls();await assert.rejects(f.client.attach(corrupted.id,async()=>{assert.fail('corrupt attachment')}),/integrity/);assert.equal(f.calls(),calls);assert.equal(f.client.state().pending,true)}finally{await f.close()}})
test('pending original file is verified for local download without changing its task or uploading again',async()=>{const f=await fixture();try{const draft=await f.client.start(file(),node,regionId),before=await f.cache.pendingNodeResources(),calls=f.calls(),result=await f.client.readPendingFile(draft.id);assert.equal(result.name,'original.png');assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),draft.bytes);assert.equal(f.calls(),calls);assert.deepEqual(await f.cache.pendingNodeResources(),before);assert.equal(f.client.state().pending,true);await f.client.cancel(draft.id);await assert.rejects(f.client.readPendingFile(draft.id),/finished/)}finally{await f.close()}})
test('corrupted pending bytes cannot be downloaded as the original',async()=>{const f=await fixture();try{const draft=await f.client.start(file(),node,regionId);await f.client.cancel(draft.id);const corrupt={...draft,id:crypto.randomUUID(),phase:'chosen' as const,bytes:new Uint8Array(draft.bytes.length)};await f.cache.putNodeResource(corrupt);await assert.rejects(f.client.readPendingFile(corrupt.id),/integrity/);assert.equal((await f.cache.pendingNodeResources()).length,1)}finally{await f.close()}})
test('a file cancelled by another window between download reads is not returned',async()=>{const f=await fixture(),read=f.cache.pendingNodeResources.bind(f.cache);let calls=0;try{const draft=await f.client.start(file(),node,regionId);f.cache.pendingNodeResources=async()=>{const values=await read();if(++calls===1)await f.cache.finishNodeResource(draft.id,'cancelled');return values};await assert.rejects(f.client.readPendingFile(draft.id),/finished/);assert.deepEqual(await read(),[])}finally{f.cache.pendingNodeResources=read;await f.close()}})

test('a scope change during cancellation preserves the original pending bytes',async()=>{
 const f=await fixture(),entered=defer(),release=defer(),read=f.cache.pendingNodeResources.bind(f.cache);let available=true
 const client=new WordNodeResourceClient({...f.options,available:()=>available})
 try{await client.initialize();const draft=await client.start(file(),node,regionId)
  f.cache.pendingNodeResources=async()=>{const result=await read();entered.resolve();await release.promise;return result}
  const cancellation=client.cancel(draft.id),failure=assert.rejects(cancellation,/unavailable/);await entered.promise;available=false;release.resolve();await failure
  assert.deepEqual(await read(),[draft]);await assert.rejects(client.readPendingFile(draft.id),/unavailable/)
 }finally{release.resolve();f.cache.pendingNodeResources=read;client.dispose();await f.close()}
})
test('a scope change after attachment flush preserves the record for review',async()=>{
 const f=await fixture(),entered=defer(),release=defer(),flush=f.cache.flush.bind(f.cache);let available=true
 const client=new WordNodeResourceClient({...f.options,available:()=>available})
 try{await client.initialize();const draft=await client.start(file(),node,regionId)
  f.cache.flush=async()=>{await flush();entered.resolve();await release.promise}
  const linking=client.linked(draft.id,{...node,schemaVersion:'hcd.extension/2',resources:[draft.resource]}),failure=assert.rejects(linking,/unavailable/)
  await entered.promise;available=false;release.resolve();await failure;assert.deepEqual(await f.cache.pendingNodeResources(),[draft])
 }finally{release.resolve();f.cache.flush=flush;client.dispose();await f.close()}
})

test('cancellation during the durable choice write prevents any upload after the write finishes',async()=>{const f=await fixture(),entered=defer(),release=defer(),put=f.cache.putNodeResource.bind(f.cache);try{f.cache.putNodeResource=async value=>{await put(value);entered.resolve();await release.promise};const task=f.client.start(file(),node,regionId),failure=assert.rejects(task);await entered.promise;const id=f.client.state().jobs[0].id,cancelling=f.client.cancel(id);release.resolve();await cancelling;await failure;assert.equal(f.calls(),0);assert.equal(f.client.state().pending,false);assert.deepEqual(await f.cache.pendingNodeResources(),[])}finally{release.resolve();await f.close()}})
test('cancelling a stalled local file read releases the job without creating a draft or upload',async()=>{
 const f=await fixture(),entered=defer(),release=defer()
 class SlowFile extends File{override arrayBuffer():Promise<ArrayBuffer>{entered.resolve();return release.promise}}
 try{
  const task=f.client.start(new SlowFile(['file'],'slow.bin'),node,regionId),failure=assert.rejects(task,/cancelled/)
  await entered.promise;const id=f.client.state().jobs[0].id
  await f.client.cancel(id);await failure
  assert.equal(f.calls(),0);assert.equal(f.client.state().pending,false);assert.deepEqual(await f.cache.pendingNodeResources(),[])
  release.resolve(new TextEncoder().encode('file').buffer);await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(f.calls(),0);assert.deepEqual(await f.cache.pendingNodeResources(),[])
 }finally{release.resolve(new ArrayBuffer(0));await f.close()}
})
test('attachment is one guarded commit and cancellation cannot report success while that commit settles',async()=>{const f=await fixture(),entered=defer(),release=defer();try{const task=f.client.start(file(),node,regionId,async draft=>{entered.resolve();await release.promise;return {...node,schemaVersion:'hcd.extension/2' as const,resources:[draft.resource]}});await entered.promise;const id=f.client.state().jobs[0].id;assert.equal(f.client.state().jobs[0].phase,'linking');await assert.rejects(f.client.cancel(id),/busy/);assert.equal(f.client.state().pending,true);release.resolve();await task;assert.equal(f.client.state().pending,false);assert.deepEqual(await f.cache.pendingNodeResources(),[])}finally{release.resolve();await f.close()}})
