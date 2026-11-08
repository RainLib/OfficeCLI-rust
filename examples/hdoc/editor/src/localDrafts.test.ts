import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {LocalDraftJournal,draftIdentity,cacheAddsChanges,restoreLocalDraft,listDraftIdentities,forkDraftIdentity,localDraftPreview} from './localDrafts.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'never-persist-this-token',scope:'write',format:'docx',userId:'alice',collaborationEpoch:0}
const identity=()=>draftIdentity(session,'alice','https://editor.example/workspace')
function documentFor(){const doc=new Y.Doc(),p=new Y.XmlElement('paragraph'),text=new Y.XmlText();doc.getXmlFragment('default').push([p]);p.push([text]);text.insert(0,'Original 中文😀');doc.getMap('hcdSave').set('receipt','old-signed-receipt');return doc}
function leaf(doc:Y.Doc){return (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText}
const clone=(doc:Y.Doc)=>{const copy=new Y.Doc();Y.applyUpdate(copy,Y.encodeStateAsUpdate(doc));return copy}

test('disk keys isolate endpoints, documents, users and epochs without persisting tokens',async()=>{
 const key=await identity();assert.doesNotMatch(key.name,/alice|doc|never-persist/)
 assert.equal((await draftIdentity({...session,token:'rotated'},'alice','https://editor.example/workspace')).name,key.name)
 for(const changed of [{...session,documentId:'other'},{...session,apiUrl:'https://other.example/v1/documents'},{...session,collaborationEpoch:1}])assert.notEqual((await draftIdentity(changed,'alice','https://editor.example/workspace')).name,key.name)
 assert.notEqual((await draftIdentity(session,'bob','https://editor.example/workspace')).name,key.name)
 await assert.rejects(draftIdentity({...session,apiUrl:'https://api.example/v1?token=secret'},'alice','https://editor.example/workspace'),/endpoint/)
})
test('committed IndexedDB updates reopen with Unicode body, image intents and source metadata',async()=>{
 const factory=new IDBFactory(),key=await identity(),doc=documentFor(),journal=await LocalDraftJournal.open(key,factory)
 try{
  await journal.bind(doc);leaf(doc).insert(0,'离线 ');doc.getMap('hcdImageDrafts').set('intent',{assetHash:'a'.repeat(64),geometry:{width:55}});await journal.flush();assert.equal(journal.state,'stored')
  journal.close();const reopened=await LocalDraftJournal.open(key,factory),restored=await reopened.load()
  try{assert.equal(localDraftPreview(restored).trim(),'离线 Original 中文😀');assert.equal((restored.getMap('hcdImageDrafts').get('intent') as any).assetHash,'a'.repeat(64));assert.equal(restored.getMap('hcdSave').get('receipt'),'old-signed-receipt')}
  finally{restored.destroy();reopened.close()}
 }finally{journal.close();doc.destroy()}
})
test('atomic compaction includes concurrent windows instead of replacing them with a stale snapshot',async()=>{
 const factory=new IDBFactory(),key=await identity(),a=documentFor(),b=clone(a),left=await LocalDraftJournal.open(key,factory),right=await LocalDraftJournal.open(key,factory)
 try{
  await Promise.all([left.bind(a),right.bind(b)])
  leaf(a).insert(0,'A ');leaf(b).insert(0,'B ')
  await Promise.all([left.flush(),right.flush()]);await Promise.all([left.compact(),right.compact()])
  const restored=await left.load();try{const preview=localDraftPreview(restored);assert.match(preview,/A /);assert.match(preview,/B /);assert.match(preview,/Original 中文😀/)}finally{restored.destroy()}
 }finally{left.close();right.close();a.destroy();b.destroy()}
})
test('aborted or full storage reports failure without clearing an earlier durable copy',async()=>{
 const factory=new IDBFactory(),key=await identity(),doc=documentFor(),journal=await LocalDraftJournal.open(key,factory)
 await journal.bind(doc)
 const opening=factory.open(key.name),db=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
 try{
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({bytes:64*1024*1024,count:1},'usage');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})
  await assert.rejects(journal.append(Uint8Array.from([0,0])),/full/);assert.equal(journal.state,'failed');await assert.rejects(journal.flush(),/full/)
  const retained=await journal.load();try{assert.equal(localDraftPreview(retained).trim(),'Original 中文😀')}finally{retained.destroy()}
 }finally{db.close();journal.close();doc.destroy()}
})
test('restore merges CRDT input but authenticated server receipts and schema remain authoritative',()=>{
 const original=documentFor(),cached=clone(original),server=clone(original)
 try{
  assert.equal(cacheAddsChanges(cached,server),false);leaf(cached).insert(0,'local ');leaf(server).insert(0,'remote ');server.getMap('hcdSave').set('receipt','current-signed-receipt');server.getMap('hcdSchema').set('images',2)
  assert.equal(cacheAddsChanges(cached,server),true)
  const recovered=restoreLocalDraft(cached,server)
  try{assert.match(localDraftPreview(recovered),/local /);assert.match(localDraftPreview(recovered),/remote /);assert.equal(recovered.getMap('hcdSave').get('receipt'),'current-signed-receipt');assert.equal(recovered.getMap('hcdSchema').get('images'),2)}finally{recovered.destroy()}
  Y.applyUpdate(server,Y.encodeStateAsUpdate(cached));assert.equal(cacheAddsChanges(cached,server),false)
 }finally{original.destroy();cached.destroy();server.destroy()}
})
test('a later successful delta cannot hide an earlier missing disk update',async()=>{
 const factory=new IDBFactory(),key=await identity(),doc=documentFor(),journal=await LocalDraftJournal.open(key,factory)
 await journal.bind(doc)
 const opening=factory.open(key.name),db=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
 const usage=()=>new Promise<{bytes:number;count:number}>((resolve,reject)=>{const tx=db.transaction('meta','readonly'),value=tx.objectStore('meta').get('usage');value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error)})
 const setUsage=(value:unknown)=>new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(value,'usage');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})
 try{
  const committed=await usage()
  await setUsage({bytes:64*1024*1024,count:committed.count})
  leaf(doc).insert(0,'missing ')
  await assert.rejects(journal.flush(),/full/)
  const failure=journal.error
  await setUsage(committed)
  leaf(doc).insert(leaf(doc).length,' later')
  await assert.rejects(journal.flush(),/full/)
  assert.equal(journal.state,'failed');assert.equal(journal.error,failure)
  // Only a new journal seeded with the complete live state can safely recover.
  const recovered=await LocalDraftJournal.open(forkDraftIdentity(key),factory)
  try{await recovered.bind(doc);await recovered.flush();assert.equal(recovered.state,'stored');const reopened=await recovered.load();try{assert.equal(localDraftPreview(reopened).trim(),'missing Original 中文😀 later')}finally{reopened.destroy()}}
  finally{recovered.close()}
 }finally{db.close();journal.close();doc.destroy()}
})
test('archived and older-epoch copies remain discoverable; new input makes an active copy visible again',async()=>{
 const factory=new IDBFactory(),key=await identity(),fork=forkDraftIdentity(key),next=await draftIdentity({...session,collaborationEpoch:1},'alice','https://editor.example/workspace'),doc=documentFor()
 const first=await LocalDraftJournal.open(key,factory),second=await LocalDraftJournal.open(fork,factory),newEpoch=await LocalDraftJournal.open(next,factory)
 try{
  await first.bind(doc);await first.archive();assert.equal((await first.metadata()).archived,true)
  const identities=await listDraftIdentities(next,factory);assert.deepEqual(identities.map(value=>value.name).sort(),[key.name,fork.name,next.name].sort())
  leaf(doc).insert(0,'new ');await first.flush();assert.equal((await first.metadata()).archived,false)
 }finally{first.close();second.close();newEpoch.close();doc.destroy()}
})

test('structural and legacy device journals stay separately discoverable without cross-protocol merge',async()=>{
 const {structuralProtocol}=await import('./collaborationProtocol.ts'),factory=new IDBFactory(),legacy=await identity(),structural=await draftIdentity({...session,collaborationProtocol:structuralProtocol},'alice','https://editor.example/workspace')
 assert.equal(legacy.prefix,structural.prefix);assert.notEqual(legacy.name,structural.name)
 const a=await LocalDraftJournal.open(legacy,factory),b=await LocalDraftJournal.open(structural,factory),old=documentFor(),next=new Y.Doc()
 try{next.getMap('hcd-semantic-blocks/3/meta').set('version',3);assert.throws(()=>restoreLocalDraft(old,next),/protocol differs/);const keys=await listDraftIdentities(structural,factory);assert.deepEqual(keys.map(value=>value.name).sort(),[legacy.name,structural.name].sort())}
 finally{a.close();b.close();old.destroy();next.destroy()}
})
test('structural recovery preserves peer and device input while refusing cached canonical/source authority',async()=>{
 const {getSchema}=await import('@tiptap/core'),{schemaExtensions}=await import('./schema.ts'),{SemanticStructureIdentity}=await import('./semanticStructureIdentity.ts'),{SemanticBlockStore}=await import('./semanticBlockStore.ts')
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),original=new Y.Doc(),store=new SemanticBlockStore(original,schema)
 store.initialize(schema.node('doc',null,[schema.node('paragraph',{hcdBlockId:'native-original'},schema.text('Original'))]))
 const cached=clone(original),server=clone(original),local=new SemanticBlockStore(cached,schema),remote=new SemanticBlockStore(server,schema),key=store.blocks()[0].key
 try{
  local.update(key,local.content(key),schema.node('paragraph',local.content(key).attrs,schema.text('device Original')));remote.update(key,remote.content(key),schema.node('paragraph',remote.content(key).attrs,schema.text('peer Original')))
  const owner=local.owners.get(key)!;local.canonicalIds.set(owner,'forged-cached-native');remote.canonicalIds.set(owner,'current-native')
  local.attributes.get(key)!.set('hcdSourceId','retired-source');cached.getMap('hcdSave').set('receipt','stale');server.getMap('hcdSave').set('receipt','trusted')
  const restored=restoreLocalDraft(cached,server)
  try{const recovered=new SemanticBlockStore(restored,schema);assert.match(localDraftPreview(restored),/device /);assert.match(localDraftPreview(restored),/peer /);assert.equal(recovered.canonicalBlockId(key),'current-native');assert.equal(recovered.attributes.get(key)!.get('hcdSourceId'),null);assert.equal(restored.getMap('hcdSave').get('receipt'),'trusted')}
  finally{restored.destroy()}
 }finally{original.destroy();cached.destroy();server.destroy()}
})
test('device recovery preview retains forced line breaks and literal text',async()=>{
 const {getSchema}=await import('@tiptap/core'),{schemaExtensions}=await import('./schema.ts'),{SemanticStructureIdentity}=await import('./semanticStructureIdentity.ts'),{SemanticBlockStore}=await import('./semanticBlockStore.ts')
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 try{store.initialize(schema.node('doc',null,[schema.node('paragraph',{hcdBlockId:'native'},[schema.text('First'),schema.node('hardBreak'),schema.text('Second <b>literal</b>')])]))
  assert.equal(localDraftPreview(doc),'First\nSecond <b>literal</b>')
 }finally{doc.destroy()}
})
