import assert from 'node:assert/strict'
import {test} from 'node:test'
import {IDBFactory} from 'fake-indexeddb'
import {NodeResourceJournal,nodeResourceJournalIdentity} from './nodeResourceJournal.ts'
import {InlineNodeResourceClient,WordNodeResourceClient,nodeResourceHash,validateNodeResourceDraft,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {inlineProtocol,structuralProtocol} from './collaborationProtocol.ts'
import {restoreHandoffReady,followCommittedRestore} from './restoreClient.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
const session={documentId:'owned',token:'do-not-store',scope:'write' as const,format:'html',apiUrl:'https://qa.invalid/v1/documents',collabUrl:'wss://qa.invalid',collaborationProtocol:inlineProtocol,collaborationEpoch:3}
const codecs=new InlineContainerRegistry([{type:'test.file',version:1,display:'inline',contentModel:'inline',label:'字段',defaultData:{title:'字段'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}])
const ordinary={schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'test.atom',version:1,display:'inline' as const,data:{},fallback:{text:'Atom'}}
const file=()=>new File(['原始文件😀'],'原始.txt',{type:'text/plain'})
const defer=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
async function fixture(){
 const factory=new IDBFactory(),name=await nodeResourceJournalIdentity(session,'alice','https://qa.invalid'),cache=await NodeResourceJournal.openInline(name,factory)
 let writes=0,allowed=true
 const resources=new NodeExtensionRegistry([],()=>{},{archive:async input=>{writes++;const observed=await NodeResourceJournal.openInline(name,factory);try{assert.ok((await observed.pendingNodeResources()).length)}finally{await observed.close()}return{key:input.key,name:input.name,mediaType:input.file.type,byteLength:input.file.size,hash:await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()))}},read:async()=>new Blob()}),close=resources.connect()
 const options={cache,registry:resources,ready:()=>allowed},client=new InlineNodeResourceClient(options);await client.initialize()
 return{factory,name,cache,client,options,writes:()=>writes,deny:()=>{allowed=false},close:async()=>{client.dispose();close();await cache.close()}}
}
test('inline file journals are isolated by model member epoch and endpoints; ordinary open never adopts inline bytes',async()=>{
 const name=await nodeResourceJournalIdentity(session,'alice','https://qa.invalid'),old=await nodeResourceJournalIdentity({...session,collaborationProtocol:structuralProtocol},'alice','https://qa.invalid')
 assert.match(name,/-3-inlinecontainers1-nodefiles1$/);assert.notEqual(name,old);assert.doesNotMatch(name,/do-not-store/)
 for(const change of [{...session,collaborationEpoch:4},{...session,apiUrl:'https://other.invalid/v1/documents'}])assert.notEqual(await nodeResourceJournalIdentity(change,'alice','https://qa.invalid'),name)
 assert.notEqual(await nodeResourceJournalIdentity(session,'bob','https://qa.invalid'),name)
 const factory=new IDBFactory();await assert.rejects(NodeResourceJournal.open(name,factory),/scope/);await assert.rejects(NodeResourceJournal.openInline(old,factory),/scope/)
})
test('inline choices retain strict model3 metadata and exact original bytes across close and reopen without automatic uploads',async()=>{
 const f=await fixture();try{const target=codecs.create('test.file'),draft=await f.client.start(file(),target,'body');assert.equal(draft.expected.schemaVersion,'hcd.extension/3');assert.equal(draft.expected.instanceId,target.instanceId);assert.equal(f.writes(),1)
  f.client.dispose();await f.cache.close();const reopened=await NodeResourceJournal.openInline(f.name,f.factory),next=new InlineNodeResourceClient({...f.options,cache:reopened});try{await next.initialize();assert.equal(f.writes(),1);assert.deepEqual(next.state().jobs[0].draft,draft);assert.deepEqual((await reopened.pendingNodeResources())[0].bytes,new Uint8Array(await file().arrayBuffer()));assert.ok(next.state().pending)}finally{next.dispose();await reopened.close()}
 }finally{await f.close()}
})
test('imported recovery file tasks notify another window as soon as the private transaction commits',async()=>{
 const f=await fixture(),otherCache=await NodeResourceJournal.openInline(f.name,f.factory),other=new InlineNodeResourceClient({...f.options,cache:otherCache}),entered=defer(),release=defer();let notified!:Promise<void>
 try{await other.initialize();const original=await f.client.start(file(),codecs.create('test.file'),'body');await f.client.cancel(original.id);await other.refresh();const draft={...original,id:crypto.randomUUID(),phase:'chosen' as const},cache={...f.options.cache,importNodeResources:f.cache.importNodeResources,pendingNodeResources:f.cache.pendingNodeResources,putNodeResource:f.cache.putNodeResource,stageNodeResource:f.cache.stageNodeResource,finishNodeResource:f.cache.finishNodeResource,flush:async()=>{entered.resolve();await release.promise}},importer=new InlineNodeResourceClient({...f.options,cache,notify:()=>{notified=other.refresh()}})
  try{await importer.initialize();const task=importer.importFiles([draft]);await entered.promise;await notified;assert.equal(importer.state().pending,true);assert.equal(other.state().pending,true);assert.equal(other.state().jobs[0].id,draft.id);release.resolve();assert.equal(await task,1);assert.equal(importer.state().jobs[0].id,draft.id);assert.equal(f.writes(),1)}finally{release.resolve();importer.dispose()}
 }finally{other.dispose();await otherCache.close();await f.close()}
})
test('an older delayed resource refresh cannot overwrite a newer view of imported tasks',async()=>{
 const f=await fixture(),old=defer(),started=defer(),read=f.cache.pendingNodeResources.bind(f.cache);let calls=0
 try{const draft=await f.client.start(file(),codecs.create('test.file'),'body');f.cache.pendingNodeResources=async()=>{if(++calls===1){started.resolve();await old.promise;return []}return read()};const first=f.client.refresh();await started.promise;await f.client.refresh();assert.equal(f.client.state().jobs[0].id,draft.id);old.resolve();await first;assert.equal(f.client.state().jobs[0].id,draft.id);assert.equal(f.client.state().pending,true)}finally{old.resolve();f.cache.pendingNodeResources=read;await f.close()}
})
test('action-boundary read finds a file written by another window even if notification was missed',async()=>{
 const f=await fixture(),otherCache=await NodeResourceJournal.openInline(f.name,f.factory),other=new InlineNodeResourceClient({...f.options,cache:otherCache})
 try{await other.initialize();assert.equal(other.state().pending,false);const draft=await f.client.start(file(),codecs.create('test.file'),'body');assert.equal(other.state().pending,false);assert.equal(await other.checkPending(),true);assert.equal(other.state().jobs[0].id,draft.id)}finally{other.dispose();await otherCache.close();await f.close()}
})
test('a scope change during the final device read blocks the pending-file gate',async()=>{
 const f=await fixture(),entered=defer(),release=defer(),read=f.cache.pendingNodeResources.bind(f.cache);let available=true,calls=0
 const client=new InlineNodeResourceClient({...f.options,available:()=>available})
 try{await client.initialize();f.cache.pendingNodeResources=async()=>{const items=await read();if(++calls===2){entered.resolve();await release.promise}return items}
  const check=client.checkPending();await entered.promise;available=false;release.resolve();assert.equal(await check,true)
 }finally{release.resolve();f.cache.pendingNodeResources=read;client.dispose();await f.close()}
})
test('scope loss after a recovery file import reports interruption while retaining the imported bytes',async()=>{
 const f=await fixture(),entered=defer(),release=defer();let available=true
 try{const original=await f.client.start(file(),codecs.create('test.file'),'body');await f.client.cancel(original.id)
  const draft={...original,id:crypto.randomUUID(),phase:'chosen' as const},cache={...f.options.cache,importNodeResources:f.cache.importNodeResources,pendingNodeResources:f.cache.pendingNodeResources,putNodeResource:f.cache.putNodeResource,stageNodeResource:f.cache.stageNodeResource,finishNodeResource:f.cache.finishNodeResource,flush:async()=>{entered.resolve();await release.promise}},client=new InlineNodeResourceClient({...f.options,cache,available:()=>available})
  try{await client.initialize();const importing=client.importFiles([draft]),failure=assert.rejects(importing,/unavailable/);await entered.promise;available=false;release.resolve();await failure;assert.deepEqual((await f.cache.pendingNodeResources())[0],draft)}finally{release.resolve();client.dispose()}
 }finally{release.resolve();await f.close()}
})
test('a device storage read failure blocks the action and surfaces the resource problem',async()=>{
 const f=await fixture(),read=f.cache.pendingNodeResources.bind(f.cache)
 try{f.cache.pendingNodeResources=async()=>{throw Error('device storage unavailable')};assert.equal(await f.client.checkPending(),true);assert.equal(f.client.state().problem,'word-node-resource-storage');assert.equal(f.client.state().pending,true)}finally{f.cache.pendingNodeResources=read;await f.close()}
})
test('handoff cannot attest ready when another window writes a file during drain or synchronization',async()=>{
 for(const phase of ['drain','sync'] as const){const f=await fixture(),otherCache=await NodeResourceJournal.openInline(f.name,f.factory),other=new InlineNodeResourceClient({...f.options,cache:otherCache});try{await other.initialize();let wrote=false;const write=async()=>{await f.client.start(file(),codecs.create('test.file'),'body');wrote=true};const ready=await restoreHandoffReady({blocked:()=>other.state().pending,devicePending:()=>other.checkPending(),drain:async()=>{if(phase==='drain')await write()},sync:async()=>{if(phase==='sync')await write();return true}});assert.equal(wrote,true);assert.equal(ready,false);assert.equal(other.state().jobs.length,1)}finally{other.dispose();await otherCache.close();await f.close()}}
})
test('committed restore retains the old window when a file arrives after readiness and follows only after resolution',async()=>{
 const f=await fixture(),otherCache=await NodeResourceJournal.openInline(f.name,f.factory),other=new InlineNodeResourceClient({...f.options,cache:otherCache});let transitions=0
 try{await other.initialize();assert.equal(await restoreHandoffReady({blocked:()=>false,devicePending:()=>other.checkPending(),drain:async()=>{},sync:async()=>true}),true);const draft=await f.client.start(file(),codecs.create('test.file'),'body');const follow=()=>followCommittedRestore({flush:()=>otherCache.flush(),devicePending:()=>other.checkPending(),blocked:()=>false,alive:()=>true,commit:()=>{transitions++}});assert.equal(await follow(),false);assert.equal(transitions,0);assert.equal(other.state().jobs[0].id,draft.id);await f.client.cancel(draft.id);assert.equal(await follow(),true);assert.equal(transitions,1)}finally{other.dispose();await otherCache.close();await f.close()}
})
test('an inline journal supports ordinary nodes too, while old storage and clients reject editable inline targets',async()=>{
 const f=await fixture();try{const inline=await f.client.start(file(),codecs.create('test.file'),'body'),atom=await f.client.start(file(),ordinary,'body');assert.equal(atom.expected.schemaVersion,'hcd.extension/2');assert.equal((await f.cache.pendingNodeResources()).length,2)
  assert.throws(()=>validateNodeResourceDraft(inline));const old=await NodeResourceJournal.open(f.name.replace('inlinecontainers1','structure3'),f.factory)
  try{await assert.rejects(async()=>old.putNodeResource(inline as never));assert.deepEqual(await old.pendingNodeResources(),[])}finally{await old.close()}
  const oldClient=new WordNodeResourceClient({...f.options,cache:{pendingNodeResources:async()=>[inline] as never,putNodeResource:async()=>assert.fail('must not write'),stageNodeResource:async()=>assert.fail('must not stage'),finishNodeResource:async()=>assert.fail('must not finish'),flush:async()=>assert.fail('must not flush')}});try{await oldClient.initialize();assert.ok(oldClient.state().problem);assert.ok(oldClient.state().pending)}finally{oldClient.dispose()}
 }finally{await f.close()}
})
test('inline model refuses Word story addresses and malformed bodies before disk or network work',async()=>{
 const f=await fixture();try{await assert.rejects(f.client.start(file(),codecs.create('test.file'),'n_'+'1'.repeat(32)),/invalid/)
  const invalid={...codecs.create('test.file'),contentModel:'blocks'};await assert.rejects(f.client.start(file(),invalid as never,'body'));assert.equal(f.writes(),0);assert.deepEqual(await f.cache.pendingNodeResources(),[])
 }finally{await f.close()}
})
test('wrong-model attachment cannot acknowledge completion even if instance type and resource match',async()=>{
 const f=await fixture();try{const target=codecs.create('test.file'),draft=await f.client.start(file(),target,'body'),wrong={...ordinary,instanceId:target.instanceId,type:target.type,resources:[draft.resource]};await assert.rejects(f.client.linked(draft.id,wrong),/target-changed/);assert.ok(f.client.state().pending)
  const changed=codecs.update(target,{title:'同伴的新属性'});await f.client.attach(draft.id,async saved=>codecs.updateResources(changed,[saved.resource]));assert.deepEqual(await f.cache.pendingNodeResources(),[]);assert.equal(f.client.state().pending,false)
 }finally{await f.close()}
})
test('stale normal-command failure and lost permission preserve archived inline file bytes for review',async()=>{
 const f=await fixture();try{const draft=await f.client.start(file(),codecs.create('test.file'),'body');await assert.rejects(f.client.attach(draft.id,async()=>{throw new Error('selection changed')}),/selection changed/);assert.deepEqual((await f.cache.pendingNodeResources())[0].bytes,draft.bytes)
  f.deny();const before=f.writes();await assert.rejects(f.client.attach(draft.id,async()=>assert.fail('must not commit')),/authority/);assert.equal(f.writes(),before);assert.ok(f.client.state().pending)
 }finally{await f.close()}
})
test('cancellation in another inline window wins over staging and repeated imports',async()=>{
 const f=await fixture();try{const draft=await f.client.start(file(),codecs.create('test.file'),'body'),other=await NodeResourceJournal.openInline(f.name,f.factory);try{await other.finishNodeResource(draft.id,'cancelled');const staged=await f.cache.stageNodeResource(draft);assert.equal(staged.phase,'cancelled');assert.equal(staged.bytes.length,0);assert.equal(await f.cache.importNodeResources([{...draft,phase:'chosen'}]),0);await f.client.refresh();assert.equal(f.client.state().pending,false);await assert.rejects(f.client.attach(draft.id,async()=>assert.fail('cancelled')),/finished/)}finally{await other.close()}
 }finally{await f.close()}
})
test('an inline pending file remains archived when the model command succeeds but device persistence fails',async()=>{
 const f=await fixture();let failed=true,applied:ResourceNodePayload|undefined
 const client=new InlineNodeResourceClient({...f.options,cache:{...f.options.cache,flush:async()=>{if(failed)throw new Error('device write failed');await f.cache.flush()}}});await client.initialize()
 try{await assert.rejects(client.start(file(),codecs.create('test.file'),'body',async draft=>{const value=draft.expected;assert.equal(value.schemaVersion,'hcd.extension/3');applied={...value,resources:[draft.resource]};return applied}),/device write failed/);assert.ok(client.state().pending);assert.equal((await f.cache.pendingNodeResources())[0].phase,'archived');failed=false;await client.attach(client.state().jobs[0].id,async()=>applied!);assert.equal(client.state().pending,false)}finally{client.dispose();await f.close()}
})
