import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {NodeResourceJournal,nodeResourceJournalIdentity} from './nodeResourceJournal.ts'
import {draftIdentity,LocalDraftJournal,listDraftIdentities,forkDraftIdentity} from './localDrafts.ts'
import {WordNodeResourceClient,nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {listOlderNodeResources,readOlderNodeResource} from './olderNodeResources.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
const session={documentId:'doc',token:'never-cache-the-token',scope:'write' as const,format:'docx',apiUrl:'https://qa.invalid/v1/documents',collabUrl:'wss://qa.invalid',collaborationProtocol:'hcd-semantic-blocks/3' as const,collaborationEpoch:2}
const node:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:'x_'+'a'.repeat(32),type:'test.resource',version:1,display:'inline',data:{label:'Title'},fallback:{text:'Title'}}
const name='hcd-local-draft-v1-'+'a'.repeat(64)+'-2-structure3-nodefiles1'
async function choice():Promise<WordNodeResourceDraft>{const bytes=new Uint8Array([1,2,3]);return{version:1,id:crypto.randomUUID(),regionId:'body',expected:node,resource:{key:'file',name:'data.bin',mediaType:'application/octet-stream',byteLength:3,hash:await nodeResourceHash(bytes)},bytes,phase:'chosen'}}
test('earlier session file choices are scope-bound, explicitly copied and idempotent without deleting the original',async()=>{
 const factory=new IDBFactory(),oldSession={...session,collaborationEpoch:1},oldName=await nodeResourceJournalIdentity(oldSession,'alice','https://qa.invalid'),newName=await nodeResourceJournalIdentity(session,'alice','https://qa.invalid'),old=await NodeResourceJournal.open(oldName,factory),current=await NodeResourceJournal.openEditor(newName,session.collaborationProtocol,factory),draft=await choice()
 try{await old.putNodeResource(draft);assert.deepEqual(await listOlderNodeResources(session,'bob','https://qa.invalid',factory),[]);assert.deepEqual(await listOlderNodeResources({...session,documentId:'other'},'alice','https://qa.invalid',factory),[]);const items=await listOlderNodeResources(session,'alice','https://qa.invalid',factory);assert.equal(items.length,1);const copy=await readOlderNodeResource(session,'alice','https://qa.invalid',items[0],factory);assert.notEqual(copy.id,draft.id);assert.deepEqual(copy.bytes,draft.bytes);assert.deepEqual(copy.expected,draft.expected);assert.equal(await current.importNodeResources([copy]),1);assert.equal(await current.importNodeResources([copy]),0);assert.equal((await old.pendingNodeResources()).length,1);await old.finishNodeResource(draft.id,'cancelled');await assert.rejects(readOlderNodeResource(session,'alice','https://qa.invalid',items[0],factory),/changed/)}finally{await old.close();await current.close()}
})
test('an earlier choice with corrupt bytes or a forged session scope cannot be copied',async()=>{
 const factory=new IDBFactory(),oldName=await nodeResourceJournalIdentity({...session,collaborationEpoch:1},'alice','https://qa.invalid'),old=await NodeResourceJournal.open(oldName,factory),draft=await choice()
 try{await old.putNodeResource({...draft,bytes:new Uint8Array([4,5,6])});const [item]=await listOlderNodeResources(session,'alice','https://qa.invalid',factory);await assert.rejects(readOlderNodeResource(session,'alice','https://qa.invalid',item,factory),/changed/);await assert.rejects(readOlderNodeResource(session,'bob','https://qa.invalid',item,factory),/scope/);await assert.rejects(readOlderNodeResource(session,'alice','https://qa.invalid',{...item,epoch:2},factory),/scope/)}finally{await old.close()}
})
test('file journal scope includes endpoints member document epoch protocol and never a token or text-copy suffix',async()=>{
 const identity=await nodeResourceJournalIdentity(session,'alice','https://qa.invalid');assert.doesNotMatch(identity,/never-cache|copy/);assert.match(identity,/-2-structure3-nodefiles1$/)
 for(const changed of [{...session,collaborationEpoch:3},{...session,documentId:'other'},{...session,apiUrl:'https://other.invalid/v1/documents'}])assert.notEqual(await nodeResourceJournalIdentity(changed,'alice','https://qa.invalid'),identity)
 assert.notEqual(await nodeResourceJournalIdentity(session,'bob','https://qa.invalid'),identity);await assert.rejects(nodeResourceJournalIdentity({...session,collaborationProtocol:'hcd-word-regions/1' as any},'alice','https://qa.invalid'),/protocol/)
 const factory=new IDBFactory(),journal=await NodeResourceJournal.open(identity,factory);await journal.putNodeResource(await choice());const textIdentity=await draftIdentity(session,'alice','https://qa.invalid');assert.deepEqual(await listDraftIdentities(textIdentity,factory),[]);await journal.close()
})
test('a new text recovery copy still finds exact pending file bytes without restoring cached document content',async()=>{
 const factory=new IDBFactory(),identity=await draftIdentity(session,'alice','https://qa.invalid'),name=await nodeResourceJournalIdentity(session,'alice','https://qa.invalid'),files=await NodeResourceJournal.open(name,factory),text=await LocalDraftJournal.open(identity,factory),draft=await choice();await files.putNodeResource(draft);await files.close();text.close()
 const fresh=await LocalDraftJournal.open(forkDraftIdentity(identity),factory),reopened=await NodeResourceJournal.open(name,factory);try{assert.deepEqual(await reopened.pendingNodeResources(),[draft]);const doc=await fresh.load();assert.equal(doc.share.size,0);doc.destroy()}finally{fresh.close();await reopened.close()}
})
test('concurrent windows enforce the shared file count limit atomically and can still cancel after a rejected write',async()=>{
 const factory=new IDBFactory(),a=await NodeResourceJournal.open(name,factory),b=await NodeResourceJournal.open(name,factory);try{const drafts=await Promise.all(Array.from({length:17},()=>choice()));const results=await Promise.allSettled(drafts.map((draft,i)=>(i%2?a:b).putNodeResource(draft)));assert.equal(results.filter(value=>value.status==='fulfilled').length,16);assert.equal((await a.pendingNodeResources()).length,16);const first=(await a.pendingNodeResources())[0];await b.finishNodeResource(first.id,'cancelled');assert.equal((await a.pendingNodeResources()).length,15);await a.putNodeResource(await choice());assert.equal((await a.pendingNodeResources()).length,16)}finally{await a.close();await b.close()}
})
test('closing the file journal flushes accepted writes and a stale completion cannot undo another window cancellation',async()=>{
 const factory=new IDBFactory(),a=await NodeResourceJournal.open(name,factory),draft=await choice(),write=a.putNodeResource(draft);await a.close();await write;const b=await NodeResourceJournal.open(name,factory),c=await NodeResourceJournal.open(name,factory);try{await b.finishNodeResource(draft.id,'cancelled');assert.equal((await c.stageNodeResource(draft)).phase,'cancelled');assert.deepEqual(await c.pendingNodeResources(),[])}finally{await b.close();await c.close()}
})
test('failed document persistence retains an archived file choice even after the attachment command succeeded',async()=>{
 const journal=await NodeResourceJournal.open(name,new IDBFactory());let fail=true,commits=0;const registry=new NodeExtensionRegistry([],()=>{},{archive:async input=>({key:input.key,name:input.name,mediaType:input.file.type,byteLength:input.file.size,hash:await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()))}),read:async()=>new Blob()}),close=registry.connect(),cache={pendingNodeResources:journal.pendingNodeResources,putNodeResource:journal.putNodeResource,stageNodeResource:journal.stageNodeResource,finishNodeResource:journal.finishNodeResource,flush:async()=>{if(fail)throw new Error('text device failure');await journal.flush()}},client=new WordNodeResourceClient({cache,registry,ready:()=>true});await client.initialize();let applied:ExtensionNodePayload|undefined
 try{await assert.rejects(client.start(new File(['bytes'],'note.bin',{type:'application/octet-stream'}),node,'body',async draft=>{commits++;applied={...node,schemaVersion:'hcd.extension/2' as const,resources:[draft.resource]};return applied}),/text device failure/);assert.equal(client.state().pending,true);assert.equal((await journal.pendingNodeResources())[0].phase,'archived');fail=false;await client.attach(client.state().jobs[0].id,async()=>applied!);assert.equal(commits,1);assert.equal(client.state().pending,false)}finally{client.dispose();close();await journal.close()}
})

test('semantic file publication is ordered with device action boundaries across windows',async()=>{
 const previous=globalThis.navigator,tails=new Map<string,Promise<void>>()
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(key:string,work:()=>Promise<unknown>)=>{
  const before=tails.get(key)??Promise.resolve();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),tail=before.then(()=>hold);tails.set(key,tail);await before;try{return await work()}finally{release();if(tails.get(key)===tail)tails.delete(key)}
 }}}})
 const {withDeviceFileLock}=await import('./regionalFileBoundary.ts'),factory=new IDBFactory(),left=await NodeResourceJournal.open(name,factory),right=await NodeResourceJournal.open(name,factory)
 try{
  for(const kind of ['choice','import'] as const){
   const draft=await choice();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
   const action=withDeviceFileLock(name,async()=>{entered();await hold;assert.equal((await right.pendingNodeResources()).length,0)})
   await started;let published=false;const write=(kind==='choice'?left.putNodeResource(draft):left.importNodeResources([draft])).then(()=>{published=true})
   await Promise.resolve();assert.equal(published,false);release();await action;await write
   assert.equal((await right.pendingNodeResources())[0].id,draft.id);await left.finishNodeResource(draft.id,'cancelled')
  }
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve}),draft=await choice()
  const action=withDeviceFileLock(name,async()=>{entered();await hold});await started
  const write=left.putNodeResource(draft),closing=left.close();assert.equal(left.close(),closing);await assert.rejects(left.putNodeResource(draft),/closed/);release();await action;await write;await closing
  assert.equal((await right.pendingNodeResources())[0].id,draft.id)
 }finally{await left.close();await right.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:previous})}
})
