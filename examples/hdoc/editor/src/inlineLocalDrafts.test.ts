import assert from 'node:assert/strict'
import {test} from 'node:test'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment} from '@tiptap/pm/model'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockFields} from './semanticBlockStore.ts'
import {inlineContainerFields} from './semanticInlineContainers.ts'
import {inlineContainerEditFields} from './inlineContainerEdits.ts'
import {inlineRoomGuard} from './inlineRoomGuard.ts'
import {inlineProtocol,structuralProtocol,legacyProtocol} from './collaborationProtocol.ts'
import {createDraftDocument,LocalDraftJournal,draftIdentity,listDraftIdentities,cacheAddsChanges,restoreLocalDraft,localDocumentProtocol,localDraftPreview,localDraftBackup} from './localDrafts.ts'
import {readServerDraft,DraftBootstrapError,restoreDraftCandidate} from './draftBootstrap.ts'
import type {Session} from './api.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),id='x_'+'1'.repeat(32),source='n_'+'1'.repeat(32),nextSource='n_'+'2'.repeat(32)
const session:Session={documentId:'doc',token:'private-never-in-cache-key',scope:'write',format:'docx',collaborationEpoch:1,collaborationProtocol:inlineProtocol}
function store(doc:Y.Doc){return new SemanticBlockStore(doc,schema,undefined,{inlineContainers:true})}
function fixture(){
 const document=createDraftDocument(session),structure=store(document),field=schema.nodes.hcdExtensionInlineContainer.createChecked({hcdSourceId:source,extension:{schemaVersion:'hcd.extension/3',instanceId:id,type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Field'}}},schema.text('AAAA😀AA',[schema.marks.hcdSource.create({nodeId:source})]))
 structure.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,[schema.text('Before '),field,schema.text(' After')])));document.getMap('hcdSchema').set('inlineContainers',1);document.getMap('hcdSave').set('receipt','canonical')
 return document
}
const clone=(source:Y.Doc)=>{const doc=createDraftDocument(session);Y.applyUpdate(doc,Y.encodeStateAsUpdate(source));return doc}
const body=(doc:Y.Doc)=>store(doc).flow.containers!.bodies.get(id)!
function items(text:Y.XmlText){const values:Array<{client:number;clock:number;deleted:boolean;content:unknown[]}>=[];for(let item=text._start;item;item=item.right)values.push({client:item.id.client,clock:item.id.clock,deleted:item.deleted,content:item.content.getContent()});return values}

test('three protocol namespaces remain discoverable without allowing cross-model recovery',async()=>{
 const factory=new IDBFactory(),identities=await Promise.all([legacyProtocol,structuralProtocol,inlineProtocol].map(protocol=>draftIdentity({...session,collaborationProtocol:protocol},'alice','https://editor.example'))),journals:LocalDraftJournal[]=[]
 try{assert.equal(new Set(identities.map(i=>i.name)).size,3);assert.ok(identities[2].name.endsWith('-inlinecontainers1'));assert.doesNotMatch(identities[2].name,/private|alice|doc/)
  for(const identity of identities)journals.push(await LocalDraftJournal.open(identity,factory))
  assert.deepEqual((await listDraftIdentities(identities[2],factory)).map(i=>i.protocol??legacyProtocol).sort(),[legacyProtocol,structuralProtocol,inlineProtocol].sort())
  const legacy=new Y.Doc(),current=fixture();legacy.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);try{assert.throws(()=>restoreLocalDraft(legacy,current),/protocol differs/)}finally{legacy.destroy();current.destroy()}
 }finally{journals.forEach(j=>j.close())}
})
test('IndexedDB compaction and fresh load keep permanent body characters including deletion tombstones',async()=>{
 const factory=new IDBFactory(),identity=await draftIdentity(session,'alice','https://editor.example'),journal=await LocalDraftJournal.open(identity,factory),document=fixture()
 try{await journal.bind(document);body(document).delete(1,1);body(document).insert(0,'Device ');await journal.flush();await journal.compact();const restored=await journal.load()
  try{assert.equal(restored.gc,false);assert.equal(localDocumentProtocol(restored),inlineProtocol);assert.equal(localDraftPreview(restored),'Before Device AAA😀AA After');assert.deepEqual(items(body(restored)),items(body(document)));assert.equal(items(body(restored)).some(item=>item.deleted&&item.content.includes('A')),true)}finally{restored.destroy()}
 }finally{journal.close();document.destroy()}
})
test('restoring a stale inline draft retains peer text, source identities and trusted metadata, then passes the actual room guard',()=>{
 const original=fixture(),cached=clone(original),server=clone(original)
 try{
  cached.transact(()=>{body(cached).insert(0,'Device ',{hcdSource:{nodeId:source}});cached.getMap('hcdSave').set('receipt','stale');cached.getMap('hcdSchema').set('images',999)})
  server.transact(()=>{body(server).insert(body(server).length,' Peer');body(server).setAttribute('hcdSourceId',nextSource);body(server).format(0,body(server).length,{hcdSource:{nodeId:nextSource}});server.getMap('hcdSave').set('receipt','new canonical');server.getMap('hcdSchema').set('images',2)})
  const before=Y.encodeStateAsUpdate(server),restored=restoreLocalDraft(cached,server)
  try{assert.equal(restored.gc,false);assert.equal(localDraftPreview(restored),'Before Device AAAA😀AA Peer After');assert.equal(body(restored).getAttribute('hcdSourceId'),nextSource);assert.equal(restored.getMap('hcdSave').get('receipt'),'new canonical');assert.equal(restored.getMap('hcdSchema').get('images'),2);assert.equal(body(restored).toDelta().some((part:{attributes?:{hcdSource?:{nodeId:string}}})=>part.attributes?.hcdSource?.nodeId===source),false);assert.equal(cacheAddsChanges(restored,server),true)
   const guard=inlineRoomGuard(server,schema);try{const update=Y.encodeStateAsUpdate(restored,Y.encodeStateVector(server));guard.accept(update);Y.applyUpdate(server,update);assert.equal(localDraftPreview(server),localDraftPreview(restored))}finally{guard.destroy()}
  }finally{restored.destroy()}
  // Only the explicit application above changed the authority.
  assert.notDeepEqual(Y.encodeStateAsUpdate(server),before)
 }finally{original.destroy();cached.destroy();server.destroy()}
})
test('cached body replacement is rejected without mutating the server or durable private copy',async()=>{
 const original=fixture(),cached=clone(original),server=clone(original),factory=new IDBFactory(),journal=await LocalDraftJournal.open(await draftIdentity(session,'alice','https://editor.example'),factory)
 try{const replacement=new Y.XmlText();replacement.insert(0,'forged');cached.getMap(inlineContainerFields.bodies).set(id,replacement);await journal.bind(cached);await journal.flush();const before=Y.encodeStateAsUpdate(server)
  assert.throws(()=>restoreLocalDraft(cached,server),/body-replaced/);assert.throws(()=>restoreDraftCandidate(cached,server),error=>error instanceof DraftBootstrapError&&error.key==='localDraftProtocolUnavailable');assert.deepEqual(Y.encodeStateAsUpdate(server),before)
  const saved=await journal.load();try{assert.equal(body(saved).toString(),'forged')}finally{saved.destroy()}
 }finally{journal.close();original.destroy();cached.destroy();server.destroy()}
})
test('future carriers and partial inline acknowledgements are never mislabeled as ordinary structural drafts',()=>{
 for(const name of Object.values(inlineContainerEditFields)){const doc=new Y.Doc();doc.getMap(semanticBlockFields.metadata).set('version',3);doc.getMap(name).set('future',{});try{assert.throws(()=>localDocumentProtocol(doc),/Unsupported local inline/)}finally{doc.destroy()}}
 const doc=fixture();try{doc.getMap('hcdSchema').delete('inlineContainers');assert.throws(()=>localDocumentProtocol(doc),/Unsupported local inline/)}finally{doc.destroy()}
 const deleted=new Y.Doc();try{deleted.getMap(semanticBlockFields.metadata).set('version',3);deleted.getMap(inlineDeletionField).set('retained',{version:2});assert.throws(()=>localDocumentProtocol(deleted),/Unsupported local inline/)}finally{deleted.destroy()}
})
test('new bodies created offline retain their independent allocation and join after recovery',()=>{
 const original=fixture(),cached=clone(original),server=clone(original),newId='x_'+'3'.repeat(32)
 try{const local=store(cached),key=local.keys()[0],before=local.content(key),newBody=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:newId,type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Offline field'}}},schema.text('Created offline'))
  local.update(key,before,before.copy(before.content.append(Fragment.from(newBody))));const restored=restoreLocalDraft(cached,server)
  try{assert.equal(store(restored).flow.containers!.readBody(newId).textContent,'Created offline');assert.equal(store(restored).flow.containers!.bodies.size,2);const guard=inlineRoomGuard(server,schema);try{const update=Y.encodeStateAsUpdate(restored,Y.encodeStateVector(server));guard.accept(update);Y.applyUpdate(server,update);assert.equal(store(server).flow.containers!.readBody(newId).textContent,'Created offline')}finally{guard.destroy()}}
  finally{restored.destroy()}
 }finally{original.destroy();cached.destroy();server.destroy()}
})
test('authenticated inline state bootstrap acknowledges the exact protocol and loads without garbage collection',async()=>{
 const original=globalThis.fetch,doc=fixture(),bytes=Y.encodeStateAsUpdate(doc)
 try{globalThis.fetch=async(_url,init)=>{const h=new Headers(init?.headers);assert.equal(h.get('X-HCD-Inline-Containers-Version'),'1');assert.equal(h.get('X-HCD-Extension-Version'),'3');assert.equal(h.get('X-HCD-Collaboration-Protocol'),inlineProtocol);return new Response(Uint8Array.from(bytes).buffer)}
  const restored=await readServerDraft(session,new AbortController().signal);try{assert.equal(restored?.gc,false);assert.equal(localDocumentProtocol(restored!),inlineProtocol);assert.equal(localDraftPreview(restored!),localDraftPreview(doc))}finally{restored?.destroy()}
  globalThis.fetch=async(url)=>String(url).endsWith('/auth')?Response.json({collaborationEpoch:1,collaborationProtocol:inlineProtocol}):new Response(Uint8Array.from(bytes).buffer)
  await assert.rejects(readServerDraft({...session,collaborationProtocol:structuralProtocol},new AbortController().signal),error=>error instanceof DraftBootstrapError&&error.authority?.collaborationProtocol===inlineProtocol)
 }finally{globalThis.fetch=original;doc.destroy()}
})
test('recovery downloads retain exact bytes even when the body model is unsupported',()=>{
 const doc=fixture()
 try{assert.equal(localDraftBackup('doc',doc,1).collaborationProtocol,inlineProtocol);doc.getMap('hcdSchema').set('inlineContainers',999);assert.throws(()=>localDocumentProtocol(doc))
  const before=Y.encodeStateAsUpdate(doc),backup=localDraftBackup('doc',doc,1);assert.equal(backup.collaborationProtocol,undefined);assert.deepEqual(new Uint8Array(Buffer.from(backup.crdt,'base64')),before);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);assert.equal(backup.schemaVersion,'hcd-recovery/1');assert.equal(backup.collaborationEpoch,1);assert.doesNotMatch(JSON.stringify(backup),/private-never-in-cache-key/)
 }finally{doc.destroy()}
})
