import {test} from 'node:test'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {Fragment} from '@tiptap/pm/model'
import {IDBFactory} from 'fake-indexeddb'
import {applyImageReplacement,CollaborativeImageDraftStore,imageIntents} from './collaborativeImages.ts'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {structuralProtocol,inlineProtocol} from './collaborationProtocol.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {createSemanticRecoveryArchive,semanticRecoveryResources} from './semanticRecoveryArchive.ts'
import {prepareRecoveryTransfer,applyRecoveryTransfer,commitReviewedRecoveryImage,importReviewedRecoveryFiles,importReviewedRecoveryImages,exportRecoveryArchive,readRecoveryCheck,recoveryHash,type RecoveryTransferReview} from './semanticRecoveryTransfer.ts'
import {SemanticImageFiles} from './semanticImageFiles.ts'
import {NodeResourceJournal} from './nodeResourceJournal.ts'
import {recoveryPlainText} from './recoveryPlainText.ts'
import {recoveryAttachmentFile} from './recoveryAttachmentFile.ts'
import {recoveryImageFile} from './recoveryImageFile.ts'
import type {Session} from './api.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'

const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),session:Session={documentId:'doc',scope:'write',format:'html',token:'owned-test',apiUrl:'https://owned.test/v1/documents',collaborationEpoch:0,collaborationProtocol:structuralProtocol},scope={documentId:'doc',epoch:0,model:'structure3' as const,revision:1,rootHash:'a'.repeat(64)},canonical=new TextEncoder().encode('Unit canonical verifier fixture'),signal=()=>new AbortController().signal
function replica(){const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema);return{document,store}}
function edit(store:SemanticBlockStore,text:string){const doc=store.project(),tr=EditorState.create({schema,doc}).tr.insertText(text,1);store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
async function fixture(){const a=replica(),file=replica();a.store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,schema.text('Original'))]));a.document.getMap('hcdSave').set('private','trusted-room');Y.applyUpdate(file.document,Y.encodeStateAsUpdate(a.document));edit(file.store,'File ');file.document.getMap('hcdSave').set('private','untrusted-file');const packet=await createSemanticRecoveryArchive({scope,document:file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>{throw Error('no resources')}});edit(a.store,'Live ');return{...a,file,packet,close(){a.document.destroy();file.document.destroy()}}}
function transport(protocol:Session['collaborationProtocol']=structuralProtocol){const old=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(String(input));if(url.pathname.endsWith('/auth'))return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:protocol});if(url.pathname.endsWith('/documents/doc'))return Response.json({revision:1,rootHash:scope.rootHash});if(url.pathname.includes('/images/'))return Response.json({revision:Number(url.searchParams.get('revision')),image:{nodeId:url.pathname.split('/').at(-1),visualHash:'b'.repeat(64),geometry:{unit:'pt',x:0,y:0,width:20,height:20}}});if(url.pathname.endsWith('/recovery/canonical/inspect'))return Response.json({schemaVersion:'hcd-recovery-canonical/1',verified:true,documentId:'doc',epoch:0,revision:Number(url.searchParams.get('revision')),rootHash:url.searchParams.get('rootHash'),sha256:await recoveryHash(new Uint8Array(await new Response(init?.body).arrayBuffer()))});throw Error('unexpected request '+url.pathname)};return()=>{globalThis.fetch=old}}
test('recovery checks stop waiting on stalled headers and close late responses',async()=>{
 const original=globalThis.fetch;let complete!:(value:Response)=>void,cancelled=false
 globalThis.fetch=()=>new Promise(resolve=>{complete=resolve})
 try{await assert.rejects(readRecoveryCheck(session,'/auth',signal(),{},1024,30),/recoveryArchiveTimeout/);complete(new Response(new ReadableStream({cancel(){cancelled=true}})));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true)}finally{globalThis.fetch=original}
})
test('recovery checks bound and cancel response bodies and retain external cancellation',async()=>{
 const original=globalThis.fetch;let cancelled=false
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(Uint8Array.of(1))},cancel(){cancelled=true}}))
  await assert.rejects(readRecoveryCheck(session,'/auth',signal(),{},1024,30),/recoveryArchiveTimeout/);assert.equal(cancelled,true)
  globalThis.fetch=async()=>new Response(new Uint8Array(1025))
  await assert.rejects(readRecoveryCheck(session,'/auth',signal(),{},1024,1000),/recoveryArchiveResponseLimit/)
  const stop=new AbortController();globalThis.fetch=()=>new Promise(()=>{});const pending=readRecoveryCheck(session,'/auth',stop.signal);await Promise.resolve();stop.abort(new Error('closed'));await assert.rejects(pending,/closed/)
 }finally{globalThis.fetch=original}
})
async function review(f:Awaited<ReturnType<typeof fixture>>){return prepareRecoveryTransfer({session,bytes:f.packet,current:f.document,schema,signal:signal()})}
test('cancelling a stalled comparison snapshot does not contact the server or modify the document',async()=>{
 const f=await fixture(),before=Y.encodeStateAsUpdate(f.document),subtle=crypto.subtle,original=subtle.digest.bind(subtle),oldFetch=globalThis.fetch,controller=new AbortController();let release!:()=>void,entered!:()=>void,requests=0
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{entered();await gate;return original(...args)}});globalThis.fetch=async()=>{requests++;throw Error('unexpected request')}
 try{const work=prepareRecoveryTransfer({session,bytes:f.packet,current:f.document,schema,signal:controller.signal});await held;controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests,0);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{release();delete (subtle as unknown as {digest?:unknown}).digest;globalThis.fetch=oldFetch;f.close()}
})
test('recovery comparison captures the reviewed packet and service identity before asynchronous work',async()=>{
 const restore=transport(),f=await fixture(),packet=Uint8Array.from(f.packet),expected=await recoveryHash(packet),mutableSession={...session},decode=TextDecoder.prototype.decode;let packetDecodes=0
 TextDecoder.prototype.decode=function(input,options){if(input instanceof Uint8Array&&input.byteLength===packet.byteLength)packetDecodes++;return decode.call(this,input,options)}
 try{
  const preparing=prepareRecoveryTransfer({session:mutableSession,bytes:packet,current:f.document,schema,signal:signal()})
  packet.fill(0);mutableSession.documentId='another';mutableSession.token='changed'
  const result=await preparing
  try{assert.equal(result.packetHash,expected);assert.equal(packetDecodes,1);assert.match(result.after.text,/File /);assert.match(result.after.text,/Live /)}finally{result.dispose()}
 }finally{TextDecoder.prototype.decode=decode;f.close();restore()}
})
test('a live edit while worker parsing is pending invalidates the comparison',async()=>{
 const restore=transport(),f=await fixture(),previous=globalThis.Worker;let complete!:()=>void
 class HeldWorker{onmessage:((event:{data:unknown})=>void)|null=null;onerror=null;onmessageerror=null;postMessage(buffer:ArrayBuffer){const value=JSON.parse(new TextDecoder().decode(buffer));complete=()=>this.onmessage?.({data:{ok:true,value}})}terminate(){}}
 try{globalThis.Worker=HeldWorker as unknown as typeof Worker;const work=prepareRecoveryTransfer({session,bytes:f.packet,current:f.document,schema,signal:signal()});edit(f.store,'Later ');const changed=Y.encodeStateAsUpdate(f.document);complete();await assert.rejects(work,/recoveryArchiveChanged/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),changed)}finally{globalThis.Worker=previous;f.close();restore()}
})
function apply(value:RecoveryTransferReview,f:Awaited<ReturnType<typeof fixture>>,history:Y.UndoManager,extra:Partial<Parameters<typeof applyRecoveryTransfer>[1]>={}){return applyRecoveryTransfer(value,{current:f.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},...extra})}

test('inline comparison uses model3 guards and a single personal merge; missing codecs preserve the live body',async()=>{
 const restore=transport(inlineProtocol),inlineSchema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode]),registry=new InlineContainerRegistry([{type:'test.recovery',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{},validate:()=>true,fallback:()=> 'Field'}]),document=new Y.Doc({gc:false}),file=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,inlineSchema,undefined,{inlineContainers:true}),value=registry.create('test.recovery')
 store.initialize(inlineSchema.nodes.doc.createChecked(null,inlineSchema.nodes.paragraph.createChecked(null,inlineSchema.nodes.hcdExtensionInlineContainer.createChecked({extension:value},inlineSchema.text('Original')))));document.getMap('hcdSchema').set('inlineContainers',1);Y.applyUpdate(file,Y.encodeStateAsUpdate(document))
 const copy=new SemanticBlockStore(file,inlineSchema,undefined,{inlineContainers:true});copy.flow.containers!.bodies.get(value.instanceId)!.insert(0,'File ')
 const history=store.undoManager()
 try{const packet=await createSemanticRecoveryArchive({scope:{...scope,model:'structure3-inline1'},document:file,schema:inlineSchema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>assert.fail('no resources')});store.flow.containers!.bodies.get(value.instanceId)!.insert(0,'Live ');history.clear();const before=Y.encodeStateAsUpdate(document),options={session:{...session,collaborationProtocol:inlineProtocol},bytes:packet,current:document,schema:inlineSchema,signal:signal()}
  await assert.rejects(prepareRecoveryTransfer(options),/historyExtensionUnavailable/);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  const review=await prepareRecoveryTransfer({...options,inlineRegistry:registry});try{assert.match(review.after.text,/File /);assert.match(review.after.text,/Live /);assert.match(review.after.business,/Field/);await applyRecoveryTransfer(review,{current:document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>assert.fail('no resources'),importFiles:async()=>{}});assert.equal(history.undoStack.length,1);assert.match(store.project().textContent,/File /);history.undo();assert.equal(store.project().textContent.includes('File '),false);assert.match(store.project().textContent,/Live /)}finally{review.dispose()}
 }finally{history.destroy();document.destroy();file.destroy();restore()}
})

test('file comparison is isolated, preserves live input, and replaces file authority with current room metadata',async()=>{const restore=transport(),f=await fixture();try{const before=Y.encodeStateAsUpdate(f.document),value=await review(f);try{assert.match(value.before.text,/Live Original/);assert.match(value.after.text,/File /);assert.match(value.after.text,/Live /);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(value.merged.getMap('hcdSave').get('private'),'trusted-room')}finally{value.dispose()}}finally{f.close();restore()}})

test('immutable recovery files retain byte-path identity, comparison, room metadata and confirmed personal undo',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager()
 try{
  const before=Y.encodeStateAsUpdate(f.document),options={session,current:f.document,schema,signal:signal()},fromBytes=await prepareRecoveryTransfer({...options,bytes:f.packet}),fromFile=await prepareRecoveryTransfer({...options,bytes:new Blob([Uint8Array.from(f.packet)])})
  try{assert.equal(fromFile.packetHash,fromBytes.packetHash);assert.deepEqual(fromFile.before,fromBytes.before);assert.deepEqual(fromFile.after,fromBytes.after);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(fromFile.merged.getMap('hcdSave').get('private'),'trusted-room')
   history.clear();await applyRecoveryTransfer(fromFile,{current:f.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>assert.fail('no resources'),importFiles:async()=>{}})
   assert.equal(history.undoStack.length,1);assert.match(f.store.project().textContent,/File /);history.undo();assert.equal(f.store.project().textContent.includes('File '),false);assert.match(f.store.project().textContent,/Live /)
  }finally{fromBytes.dispose();fromFile.dispose()}
 }finally{history.destroy();f.close();restore()}
})
test('confirmed merge is one personal undo action and preserves newer peer text',async()=>{const restore=transport(),f=await fixture(),history=f.store.undoManager();try{const value=await review(f);await apply(value,f,history);value.dispose();assert.match(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /);const peer=replica();try{Y.applyUpdate(peer.document,Y.encodeStateAsUpdate(f.document));edit(peer.store,'Peer ');Y.applyUpdate(f.document,Y.encodeStateAsUpdate(peer.document));assert.equal(history.undoStack.length,1);history.undo();assert.equal(f.store.project().textContent.includes('File '),false);assert.match(f.store.project().textContent,/Peer /);assert.match(f.store.project().textContent,/Live /);history.redo();assert.match(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Peer /)}finally{peer.document.destroy()}}finally{history.destroy();f.close();restore()}})
test('stale comparison and permission loss never mutate the current draft',async()=>{const restore=transport(),f=await fixture(),history=f.store.undoManager();try{const value=await review(f);edit(f.store,'Later ');const before=Y.encodeStateAsUpdate(f.document);await assert.rejects(apply(value,f,history),/recoveryArchiveChanged/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);value.dispose();const next=await review(f);const unchanged=Y.encodeStateAsUpdate(f.document);await assert.rejects(apply(next,f,history,{canWrite:()=>false}),/recoveryArchiveReadOnly/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),unchanged);next.dispose()}finally{history.destroy();f.close();restore()}})
test('permission is checked again after private work and cancellation cannot commit a late merge',async()=>{const restore=transport(),f=await fixture(),history=f.store.undoManager();try{const value=await review(f);let allowed=true,calls=0;const before=Y.encodeStateAsUpdate(f.document);await assert.rejects(apply(value,f,history,{canWrite:()=>allowed,authorize:async()=>{if(++calls===2)allowed=false}}),/recoveryArchiveReadOnly/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);const controller=new AbortController();await assert.rejects(apply(value,f,history,{signal:controller.signal,authorize:async()=>{controller.abort()}}));assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);value.dispose()}finally{history.destroy();f.close();restore()}})
test('a wrong file scope is rejected before sending canonical bytes to a server',async()=>{const f=await fixture(),old=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error('unexpected')};try{await assert.rejects(prepareRecoveryTransfer({session:{...session,documentId:'other'},bytes:f.packet,current:f.document,schema,signal:signal()}),/recoveryArchiveScope/);assert.equal(requests,0)}finally{globalThis.fetch=old;f.close()}})
test('a forged server verification receipt cannot make a file importable',async()=>{const restore=transport(),f=await fixture(),valid=globalThis.fetch;globalThis.fetch=async(input,init)=>{const result=await valid(input,init);if(String(input).includes('/inspect?'))return Response.json({...await result.json(),sha256:'b'.repeat(64)});return result};try{const before=Y.encodeStateAsUpdate(f.document);await assert.rejects(review(f),/recoveryArchiveInvalid/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{f.close();restore()}})
test('undo cannot hide peer input in a block created by an imported file',async()=>{const restore=transport(),f=await fixture(),history=f.store.undoManager();try{const doc=f.file.store.project();f.file.store.insert([schema.nodes.paragraph.createChecked(null,schema.text('Imported block'))],null);const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')}}),value=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});await apply(value,f,history);value.dispose();const peer=replica();try{Y.applyUpdate(peer.document,Y.encodeStateAsUpdate(f.document));const key=peer.store.keys().at(-1)!,node=peer.store.content(key);peer.store.update(key,node,node.copy(node.content.append(Fragment.from(schema.text(' Peer')))));Y.applyUpdate(f.document,Y.encodeStateAsUpdate(peer.document));const before=Y.encodeStateAsUpdate(f.document);assert.throws(()=>history.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{peer.document.destroy()}}finally{history.destroy();f.close();restore()}})
function file(n:number):WordNodeResourceDraft{const bytes=Uint8Array.of(n),hash=createHash('sha256').update(bytes).digest('hex');return{version:1,id:`00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`,regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'File'}},resource:{key:'r_file',hash,byteLength:1,name:'file.bin',mediaType:'application/octet-stream'},bytes}}
async function journal(){return NodeResourceJournal.open('hcd-local-draft-v1-'+ 'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory())}
test('private file import is atomic, idempotent and cannot revive a cancelled selection',async()=>{const cache=await journal();try{assert.equal(await cache.importNodeResources([file(1),file(2)]),2);assert.equal(await cache.importNodeResources([file(1),file(2)]),0);await cache.finishNodeResource(file(1).id,'cancelled');assert.equal(await cache.importNodeResources([file(1)]),0);assert.deepEqual((await cache.pendingNodeResources()).map(v=>v.id),[file(2).id]);await assert.rejects(cache.importNodeResources([file(3),{...file(2),resource:{...file(2).resource,name:'changed'}}]));assert.deepEqual((await cache.pendingNodeResources()).map(v=>v.id),[file(2).id])}finally{await cache.close()}})
test('private file import refuses a full batch before writing any later selection',async()=>{const cache=await journal();try{await cache.importNodeResources(Array.from({length:16},(_,i)=>file(i+1)));await assert.rejects(cache.importNodeResources([file(17)]),/limit/);assert.equal((await cache.pendingNodeResources()).length,16)}finally{await cache.close()}})

async function resourceReview(duplicate=false,imageOrder?:'image-first'|'file-first'){
 const live=replica(),candidate=replica(),merged=new Y.Doc({gc:false}),resources=new Map<string,Uint8Array>(),descriptors=[]
 for(let i=0;i<6;i++){const bytes=imageOrder&&i===0?Uint8Array.of(137,80,78,71,13,10,26,10,1):new TextEncoder().encode(`resource ${i}`),hash=await recoveryHash(bytes);resources.set(hash,bytes);descriptors.push({key:`file${i}`,hash,byteLength:bytes.length,name:`${i}.txt`,mediaType:imageOrder&&i===0?'image/png':'text/plain'})}
 const extension={schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'File'},resources:descriptors}
 const children=[schema.nodeFromJSON({type:'hcdExtensionInline',attrs:{extension}})]
 if(duplicate){const other=schema.nodeFromJSON({type:'hcdExtensionInline',attrs:{extension:{...extension,instanceId:'x_'+'b'.repeat(32),resources:[{...descriptors[0],key:'duplicate',name:'same-bytes.txt',...(imageOrder?{mediaType:'application/octet-stream'}:{})}]}}});if(imageOrder==='file-first')children.unshift(other);else children.push(other)}
 candidate.store.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,children)))
 live.store.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.text('Live'))));Y.applyUpdate(merged,Y.encodeStateAsUpdate(live.document))
 const preview={text:'',business:'',truncated:false},value:RecoveryTransferReview={candidate:{kind:'isolated-recovery-candidate',scope,canonical,document:candidate.document,store:candidate.store,resources,pendingFiles:[],pendingImages:[],dispose:()=>{}},merged,stamp:await recoveryHash(Y.encodeStateAsUpdate(live.document)),packetHash:'a'.repeat(64),deletions:0,before:preview,after:preview,currentImageDrafts:[],recoveredImageDrafts:[],imageBaselines:null,imageDraftsIntegrated:true,dispose:()=>{}}
 return{live,candidate,merged,value,close(){live.document.destroy();candidate.document.destroy();merged.destroy()}}
}
test('archived business-node resources can be downloaded without merging the candidate',async()=>{
 const f=await resourceReview(true),before=Y.encodeStateAsUpdate(f.live.document)
 try{
  const resources=semanticRecoveryResources(f.value.candidate.store);assert.equal(resources.length,6)
  const names=semanticRecoveryResources(f.value.candidate.store,true);assert.equal(names.length,7);const aliases=names.filter(item=>item.hash===names.find(item=>item.name==='same-bytes.txt')?.hash);assert.deepEqual(aliases.map(item=>item.name).sort(),['0.txt','same-bytes.txt'])
  for(const resource of resources){const bytes=f.value.candidate.resources.get(resource.hash);assert.ok(bytes);const file=await recoveryAttachmentFile(resource,bytes);assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()),bytes)}
  for(const resource of aliases){const bytes=f.value.candidate.resources.get(resource.hash)!;assert.equal((await recoveryAttachmentFile(resource,bytes)).name,resource.name)}
  assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)
 }finally{f.close()}
})
test('one recovery repins shared attachment bytes once without losing node metadata',async()=>{
 const f=await resourceReview(true),history=f.live.store.undoManager(),seen:string[]=[]
 try{Y.applyUpdate(f.merged,Y.encodeStateAsUpdate(f.candidate.document));await applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async resource=>{seen.push(resource.hash)},importFiles:async()=>assert.fail('no files')});assert.equal(seen.length,6);assert.equal(new Set(seen).size,6);const values=semanticRecoveryResources(f.candidate.store);assert.equal(values.length,6);const projected=f.live.store.project().toJSON();assert.match(JSON.stringify(projected),/same-bytes\.txt/);assert.match(JSON.stringify(projected),/0\.txt/)}finally{history.destroy();f.close()}
})
test('shared image bytes retain image staging type in either node order',async()=>{
 for(const order of ['image-first','file-first'] as const){
  const f=await resourceReview(true,order),history=f.live.store.undoManager(),seen:Array<{hash:string;mediaType:string}>=[]
  try{await applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async resource=>{seen.push({hash:resource.hash,mediaType:resource.mediaType})},importFiles:async()=>assert.fail('no files')});const png=[...f.value.candidate.resources].find(([,bytes])=>bytes[0]===137)![0];assert.equal(seen.filter(item=>item.hash===png).length,1);assert.equal(seen.find(item=>item.hash===png)?.mediaType,'image/png')}finally{history.destroy();f.close()}
 }
})
test('resource recovery stages at most four in parallel and rechecks a changed document before starting the next batch',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let started=0,release!:()=>void,ready!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),allStarted=new Promise<void>(resolve=>{ready=resolve}),stage=async()=>{if(++started===4)ready();await gate}
 try{const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:stage,importFiles:async()=>assert.fail('must not import')});await allStarted;assert.equal(started,4);edit(f.live.store,'Later ');const before=Y.encodeStateAsUpdate(f.live.document);release();await assert.rejects(operation,/recoveryArchiveChanged/);assert.equal(started,4);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{release();history.destroy();f.close()}
})
test('a slow resource does not block later recovery staging while concurrency remains bounded',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let started=0,active=0,peak=0,release!:()=>void,ready!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),fifth=new Promise<void>(resolve=>{ready=resolve})
 try{
  Y.applyUpdate(f.merged,Y.encodeStateAsUpdate(f.candidate.document))
  const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{const index=++started;peak=Math.max(peak,++active);if(index===5)ready();try{if(index===1)await gate}finally{active--}},importFiles:async()=>assert.fail('no files')})
  await fifth;assert.ok(started>=5);assert.ok(peak<=4);assert.equal(active,1);release();await operation
  assert.equal(started,6);assert.equal(semanticRecoveryResources(f.live.store).length,6)
 }finally{release();history.destroy();f.close()}
})
test('permission loss prevents further recovery staging and merging',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let allowed=true,started=0
 try{const before=Y.encodeStateAsUpdate(f.live.document);await assert.rejects(applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>allowed,authorize:async()=>{},stageResource:async()=>{started++;allowed=false},importFiles:async()=>assert.fail('must not import')}),/recoveryArchiveReadOnly/);assert.ok(started>=1&&started<=4);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{history.destroy();f.close()}
})
test('resource failure drains started work and prevents document merge',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let started=0,finished=0
 try{const before=Y.encodeStateAsUpdate(f.live.document);await assert.rejects(applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{const index=++started;await Promise.resolve();finished++;if(index===2)throw Error('resource failed')},importFiles:async()=>assert.fail('must not import')}),/resource failed/);assert.ok(started>=2&&started<=4);assert.equal(finished,started);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{history.destroy();f.close()}
})
test('a failed resource cancels sibling transfers while retaining the original error',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let started=0,aborted=0,ready!:()=>void
 const entered=new Promise<void>(resolve=>{ready=resolve}),before=Y.encodeStateAsUpdate(f.live.document)
 try{const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async(_resource,_bytes,requestSignal)=>{const index=++started;if(started===4)ready();await entered;if(index===2)throw Error('original resource failure');await new Promise<void>((_resolve,reject)=>{if(requestSignal.aborted){aborted++;reject(requestSignal.reason);return}requestSignal.addEventListener('abort',()=>{aborted++;reject(requestSignal.reason)},{once:true})})},importFiles:async()=>assert.fail('must not import')});await assert.rejects(operation,/original resource failure/);assert.equal(started,4);assert.equal(aborted,3);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{history.destroy();f.close()}
})
test('a failed resource stops waiting for another stalled snapshot check',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager(),subtle=crypto.subtle,original=subtle.digest.bind(subtle),before=Y.encodeStateAsUpdate(f.live.document)
 let calls=0,started=0,release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(++calls===3){entered();await gate}return original(...args)}})
 try{
  const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{await held;started++;throw Error('resource failed')},importFiles:async()=>assert.fail('must not import')})
  await held
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await assert.rejects(Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled cancellation')),1000)})]),/resource failed/)}finally{clearTimeout(timer)}
  const count=started;release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(started,count);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)
 }finally{release();delete (subtle as unknown as {digest?:unknown}).digest;history.destroy();f.close()}
})
test('cancelling a stalled initial snapshot check cannot stage resources later',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager(),subtle=crypto.subtle,original=subtle.digest.bind(subtle),controller=new AbortController(),before=Y.encodeStateAsUpdate(f.live.document)
 let started=0,release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{entered();await gate;return original(...args)}})
 try{const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:controller.signal,canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{started++},importFiles:async()=>assert.fail('must not import')});await held;controller.abort(Error('cancelled'));await assert.rejects(operation,/cancelled/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(started,0);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{release();delete (subtle as unknown as {digest?:unknown}).digest;history.destroy();f.close()}
})
test('a peer edit aborts in-flight attachment requests and never imports private files or merges',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let started=0,aborted=0,ready!:()=>void
 const entered=new Promise<void>(resolve=>{ready=resolve})
 try{const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async(_resource,_bytes,requestSignal)=>{if(++started===4)ready();await new Promise<void>((_resolve,reject)=>{requestSignal.addEventListener('abort',()=>{aborted++;reject(requestSignal.reason)},{once:true})})},importFiles:async()=>assert.fail('must not import')});await entered;edit(f.live.store,'Peer ');const before=Y.encodeStateAsUpdate(f.live.document);await assert.rejects(operation,/recoveryArchiveChanged/);assert.equal(started,4);assert.equal(aborted,4);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{history.destroy();f.close()}
})
test('a peer edit during private-file import prevents the merge but preserves the already committed recoverable task',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory());let release!:()=>void,ready!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{ready=resolve});f.value.candidate.pendingFiles=[file(1)]
 try{const operation=applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async files=>{await cache.importNodeResources(files);ready();await gate}});await entered;edit(f.live.store,'Peer ');const before=Y.encodeStateAsUpdate(f.live.document);release();await assert.rejects(operation,error=>error instanceof Error&&error.message==='recoveryArchiveFilesRetained'&&error.cause instanceof Error&&error.cause.message==='recoveryArchiveChanged');assert.equal((await cache.pendingNodeResources()).length,1);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{release();await cache.close();history.destroy();f.close()}
})
test('all resources finish before the confirmed recovery update',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager();let completed=0,authorizations=0,requestSignal:AbortSignal|undefined
 try{await applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{authorizations++;if(authorizations===2)assert.equal(completed,6)},stageResource:async(_resource,_bytes,signal)=>{requestSignal=signal;await Promise.resolve();completed++},importFiles:async()=>assert.fail('no private files')});assert.equal(completed,6);assert.equal(authorizations,2);edit(f.live.store,'After ');assert.equal(requestSignal?.aborted,false)}finally{history.destroy();f.close()}
})

test('export carries captured image choices and inspection leaves the current draft untouched',async()=>{
 const f=await fixture(),old=globalThis.fetch,bytes=new TextEncoder().encode('private image'),hash=await recoveryHash(bytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},image={version:1 as const,id:crypto.randomUUID(),name:'private.png',extension:'png' as const,hash,bytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input));if(url.pathname.endsWith('/auth'))return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:structuralProtocol});if(url.pathname.endsWith('/export/hcdz'))return new Response(canonical);if(url.pathname.endsWith('/recovery/canonical/inspect'))return Response.json({schemaVersion:'hcd-recovery-canonical/1',verified:true,documentId:'doc',epoch:0,revision:1,rootHash:scope.rootHash,sha256:await recoveryHash(new Uint8Array(await new Response(init?.body).arrayBuffer()))});if(url.pathname.endsWith('/documents/doc'))return Response.json({revision:1,rootHash:scope.rootHash});throw Error('unexpected request '+url.pathname)}
 try{const packet=await exportRecoveryArchive({session,document:f.file.document,schema,pendingFiles:[],pendingImages:[image],signal:signal()}),value=JSON.parse(new TextDecoder().decode(packet));assert.equal(value.schemaVersion,'hcd-semantic-recovery/2');assert.equal(value.pendingImages[0].id,image.id);const resource=value.resources.find((item:{sha256:string})=>item.sha256===hash);assert.deepEqual(new Uint8Array(Buffer.from(resource.base64,'base64')),bytes);const before=Y.encodeStateAsUpdate(f.document);const inspected=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{assert.equal(inspected.candidate.pendingImages.length,1);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);const history=f.store.undoManager();try{await assert.rejects(applyRecoveryTransfer(inspected,{current:f.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{}}),/image-tasks-unsupported/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{history.destroy()}}finally{inspected.dispose()}}finally{globalThis.fetch=old;f.close()}
})

test('recovery export rejects an oversized canonical response before verification or document mutation',async()=>{
 const f=await fixture(),old=globalThis.fetch,before=Y.encodeStateAsUpdate(f.file.document);let cancelled=false,verified=false
 globalThis.fetch=async input=>{const url=new URL(String(input));if(url.pathname.endsWith('/auth'))return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:structuralProtocol});if(url.pathname.endsWith('/documents/doc'))return Response.json({revision:1,rootHash:scope.rootHash});if(url.pathname.endsWith('/export/hcdz'))return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-length':String(49*1024*1024)}});if(url.pathname.endsWith('/recovery/canonical/inspect')){verified=true;return Response.json({})}throw Error('unexpected request '+url.pathname)}
 try{await assert.rejects(exportRecoveryArchive({session,document:f.file.document,schema,pendingFiles:[],signal:signal()}),/recoveryArchiveResponseLimit/);assert.equal(cancelled,true);assert.equal(verified,false);assert.deepEqual(Y.encodeStateAsUpdate(f.file.document),before)}finally{globalThis.fetch=old;f.close()}
})

test('confirmed recovery imports images conservatively before merging reviewed text',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),imageBytes=new TextEncoder().encode('image'),imageHash=await recoveryHash(imageBytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},image={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash:imageHash,bytes:imageBytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 try{const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[image],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')}}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{let imported=false;await applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>!imported,canWriteAfterImages:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},importImages:async choices=>{await journal.importChoices(choices);imported=true},pendingImages:()=>journal.list(),withFileLock:work=>work()});assert.match(f.store.project().textContent,/File/);const [stored]=await journal.list();assert.equal(stored.phase,'applying');assert.equal(stored.id,image.id);assert.deepEqual(stored.bytes,imageBytes)}finally{review.dispose()}}finally{await journal.close();history.destroy();f.close();restore()}
})
test('a peer edit during image import keeps the files but prevents the reviewed text merge',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),imageBytes=Uint8Array.of(1),imageHash=await recoveryHash(imageBytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},image={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash:imageHash,bytes:imageBytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 try{const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[image],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')}}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{await assert.rejects(applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>true,canWriteAfterImages:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},importImages:async choices=>{await journal.importChoices(choices);edit(f.store,'Peer ')},pendingImages:()=>journal.list(),withFileLock:work=>work()}),/recoveryArchiveImagesRetained/);assert.equal((await journal.list())[0].phase,'applying');assert.match(f.store.project().textContent,/Peer/);assert.doesNotMatch(f.store.project().textContent,/File/)}finally{review.dispose()}}finally{await journal.close();history.destroy();f.close();restore()}
})
test('a different device image task appearing during final review blocks document merge',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),imageBytes=Uint8Array.of(1),imageHash=await recoveryHash(imageBytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},image={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash:imageHash,bytes:imageBytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}},unrelated={...image,id:crypto.randomUUID(),name:'other.png'}
 try{const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[image],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')}}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{await assert.rejects(applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>true,canWriteAfterImages:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},importImages:async choices=>{await journal.importChoices(choices);await journal.put(unrelated)},pendingImages:()=>journal.list(),withFileLock:work=>work()}),/recoveryArchiveImagesRetained/);assert.equal((await journal.list()).length,2);assert.doesNotMatch(f.store.project().textContent,/File/)}finally{review.dispose()}}finally{await journal.close();history.destroy();f.close();restore()}
})
test('permission loss after image import preserves the device file and stops merging',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),imageBytes=Uint8Array.of(1),imageHash=await recoveryHash(imageBytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},image={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash:imageHash,bytes:imageBytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 try{const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[image],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')}}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{await assert.rejects(applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>true,canWriteAfterImages:()=>false,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},importImages:choices=>journal.importChoices(choices),pendingImages:()=>journal.list(),withFileLock:work=>work()}),/recoveryArchiveImagesRetained/);assert.equal((await journal.list())[0].phase,'applying');assert.doesNotMatch(f.store.project().textContent,/File/)}finally{review.dispose()}}finally{await journal.close();history.destroy();f.close();restore()}
})

test('a package containing collaborative image drafts cannot be silently merged',async()=>{
 const restore=transport(),f=await fixture(),data=Uint8Array.of(1,2),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}}
 try{applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash);const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')},readImageResource:async()=>data}),before=Y.encodeStateAsUpdate(f.document);const review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{assert.equal(review.currentImageDrafts.length,0);assert.equal(review.recoveredImageDrafts.length,1);assert.equal(review.recoveredImageDrafts[0].assetHash,hash);const history=f.store.undoManager();try{await assert.rejects(applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>true,authorize:async()=>{},stageResource:async()=>assert.fail('must not stage'),importFiles:async()=>assert.fail('must not import')}),/image-drafts-review-required/)}finally{history.destroy()}}finally{review.dispose()}assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{f.close();restore()}
})
test('a separately confirmed reviewed image is repinned and becomes a fresh local intent',async()=>{
 const f=await fixture(),old=globalThis.fetch,data=Uint8Array.of(137,80,78,71,13,10,26,10,1),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},imageStore=new CollaborativeImageDraftStore(f.document);let repins=0
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input));if(url.pathname.endsWith('/auth'))return Response.json({scope:'write',collaborationEpoch:0,collaborationProtocol:structuralProtocol});if(url.pathname.endsWith('/documents/doc'))return Response.json({revision:1,rootHash:scope.rootHash});if(url.pathname.includes('/images/'))return Response.json({revision:Number(url.searchParams.get('revision')),image:base});if(url.pathname.endsWith('/recovery/canonical/inspect'))return Response.json({schemaVersion:'hcd-recovery-canonical/1',verified:true,documentId:'doc',epoch:0,revision:1,rootHash:scope.rootHash,sha256:await recoveryHash(new Uint8Array(await new Response(init?.body).arrayBuffer()))});if(url.pathname.endsWith('/resources/reuse')){repins++;return Response.json({hash,byteLength:data.length})}throw Error('unexpected request '+url.pathname)}
 try{
  applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash)
  const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')},readImageResource:async()=>data})
  const review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{
   const oldId=review.recoveredImageDrafts[0].intentId,before=f.store.project().textContent
   assert.equal(await commitReviewedRecoveryImage(review,{session,current:f.document,store:imageStore,intentId:oldId,choices:{},signal:signal(),canWrite:()=>true}),true)
   const [image]=imageIntents(f.document);assert.equal(repins,1);assert.equal(image.assetHash,hash);assert.equal(image.clientId,f.document.clientID);assert.notEqual(image.intentId,oldId);assert.equal(f.store.project().textContent,before)
  }finally{review.dispose()}
 }finally{globalThis.fetch=old;f.close()}
})
test('comparison preserves current and file image alternatives without applying either',async()=>{
 const restore=transport(),f=await fixture(),data=Uint8Array.of(1,2),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}}
 try{applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash);applyImageReplacement(f.document,{base,revision:1,clientId:43,seen:[]},'c'.repeat(64));const original=Y.encodeStateAsUpdate(f.document),packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>{throw Error('none')},readImageResource:async()=>data}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{assert.equal(review.currentImageDrafts[0].assetHash,'c'.repeat(64));assert.equal(review.recoveredImageDrafts[0].assetHash,hash);assert.deepEqual(review.candidate.resources.get(hash),data);assert.deepEqual(Y.encodeStateAsUpdate(f.document),original)}finally{review.dispose()}}finally{f.close();restore()}
})


test('file-only recovery copies verified bytes without merging the packet and is idempotent',async()=>{
 const f=await resourceReview(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+ 'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory());const item=file(1);item.resource.hash=await recoveryHash(item.bytes);f.value.candidate.pendingFiles=[item];const before=Y.encodeStateAsUpdate(f.live.document)
 const run=()=>importReviewedRecoveryFiles(f.value,{current:f.live.document,signal:signal(),canWrite:()=>true,authorize:async()=>{},importFiles:files=>cache.importNodeResources(files)})
 try{assert.equal(await run(),1);assert.equal(await run(),0);const pending=await cache.pendingNodeResources();assert.equal(pending.length,1);assert.deepEqual(pending[0].bytes,item.bytes);assert.notEqual(pending[0].id,item.id);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before);await cache.finishNodeResource(pending[0].id,'cancelled');assert.equal(await run(),0)}finally{await cache.close();f.close()}
})
test('file-only recovery prevents stale or damaged imports and reports a possible committed copy on interruption',async()=>{
 const f=await resourceReview(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+ 'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory());const item=file(1);item.resource.hash=await recoveryHash(item.bytes);f.value.candidate.pendingFiles=[item];let writes=0,allowed=true
 const run=(importFiles:(files:readonly WordNodeResourceDraft<ResourceNodePayload>[])=>Promise<number>)=>importReviewedRecoveryFiles(f.value,{current:f.live.document,signal:signal(),canWrite:()=>allowed,authorize:async()=>{},importFiles})
 try{allowed=false;await assert.rejects(run(async()=>{writes++;return 1}),/recoveryArchiveReadOnly/);assert.equal(writes,0);allowed=true;item.bytes[0]=2;await assert.rejects(run(async()=>{writes++;return 1}),/recoveryArchiveInvalid/);assert.equal(writes,0);item.bytes[0]=1
  await assert.rejects(run(async files=>{const n=await cache.importNodeResources(files);edit(f.live.store,'Peer ');return n}),/recoveryArchiveFilesRetained/);assert.equal((await cache.pendingNodeResources()).length,1);assert.doesNotMatch(f.live.store.project().textContent,/resource 0/)
 }finally{await cache.close();f.close()}
})

test('a real image-and-attachment recovery packet permits file-only review without applying image or text',async()=>{
 const restore=transport(),f=await fixture(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+ 'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory()),imageBytes=Uint8Array.of(9,8),hash=await recoveryHash(imageBytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},attachment=file(1);attachment.resource.hash=await recoveryHash(attachment.bytes)
 try{applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash);const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[attachment],verifyCanonical:async()=>{},readResource:async()=>assert.fail('pending bytes are in packet'),readImageResource:async()=>imageBytes}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{
  assert.equal(review.recoveredImageDrafts.length,1);assert.equal(review.candidate.pendingFiles.length,1);const before=Y.encodeStateAsUpdate(f.document),choices={current:f.document,signal:signal(),canWrite:()=>true,authorize:async()=>{},importFiles:(files:readonly WordNodeResourceDraft<ResourceNodePayload>[])=>cache.importNodeResources(files)}
  assert.equal(await importReviewedRecoveryFiles(review,choices),1);assert.equal(await importReviewedRecoveryFiles(review,choices),0);assert.deepEqual((await cache.pendingNodeResources())[0].bytes,attachment.bytes);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(imageIntents(f.document).length,0);assert.doesNotMatch(f.store.project().textContent,/File /)
 }finally{review.dispose()}}finally{await cache.close();f.close();restore()}
})

test('cancel after storage starts reports that pending files may have been copied',async()=>{
 const f=await resourceReview(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+ 'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory()),controller=new AbortController(),item=file(1);item.resource.hash=await recoveryHash(item.bytes);f.value.candidate.pendingFiles=[item]
 try{await assert.rejects(importReviewedRecoveryFiles(f.value,{current:f.live.document,signal:controller.signal,canWrite:()=>true,authorize:async()=>{},importFiles:async files=>{const count=await cache.importNodeResources(files);controller.abort();return count}}),/recoveryArchiveFilesRetained/);assert.equal((await cache.pendingNodeResources()).length,1)}finally{await cache.close();f.close()}
})


test('mixed packet copies pending image choices without replaying image drafts or text',async()=>{
 const restore=transport(),f=await fixture(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},bytes=Uint8Array.of(9,8),hash=await recoveryHash(bytes),choice={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash,bytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 try{applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash);const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[choice],verifyCanonical:async()=>{},readResource:async()=>assert.fail('no resource'),readImageResource:async()=>bytes}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{
  const before=Y.encodeStateAsUpdate(f.document),run=()=>importReviewedRecoveryImages(review,{current:f.document,signal:signal(),canWrite:()=>true,authorize:async()=>{},importImages:items=>journal.importChoices(items)}),selected=review.candidate.pendingImages[0],download=await recoveryImageFile(selected.hash,selected.bytes)
  assert.deepEqual(new Uint8Array(await download.blob.arrayBuffer()),bytes);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal((await journal.list()).length,0)
  await run();await run();const choices=await journal.list();assert.equal(choices.length,1);assert.equal(choices[0].phase,'applying');assert.deepEqual(choices[0].bytes,bytes);assert.equal(imageIntents(f.document).length,0);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
 }finally{review.dispose()}}finally{await journal.close();f.close();restore()}
})
test('image choice copy retains committed work on cancellation and rejects damage or access loss before writing',async()=>{
 const f=await resourceReview(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},bytes=Uint8Array.of(1),hash=await recoveryHash(bytes),choice={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash,bytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}},controller=new AbortController();f.value.candidate.pendingImages=[choice];let allowed=false,writes=0
 const run=()=>importReviewedRecoveryImages(f.value,{current:f.live.document,signal:controller.signal,canWrite:()=>allowed,authorize:async()=>{},importImages:async items=>{writes++;const result=await journal.importChoices(items);controller.abort();return result}})
 try{await assert.rejects(run(),/recoveryArchiveReadOnly/);assert.equal(writes,0);allowed=true;choice.bytes[0]=2;await assert.rejects(run(),/recoveryArchiveInvalid/);assert.equal(writes,0);choice.bytes[0]=1;await assert.rejects(run(),/recoveryArchiveImageChoicesRetained/);const [saved]=await journal.list();assert.equal(saved.phase,'applying');assert.deepEqual(saved.bytes,bytes)}finally{await journal.close();f.close()}
})

test('mixed packet text can merge when all image operations and deletions are already in the room',async()=>{
 const restore=transport(),f=await fixture(),data=Uint8Array.of(1,2),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},history=f.store.undoManager()
 try{applyImageReplacement(f.document,{base,revision:1,clientId:42,seen:[]},hash);Y.applyUpdate(f.file.document,Y.encodeStateAsUpdate(f.document));const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>assert.fail('none'),readImageResource:async()=>data});f.document.getMap('hcdImageDrafts').clear();history.clear()
  const review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{assert.equal(review.imageDraftsIntegrated,true);assert.equal(review.recoveredImageDrafts.length,1);assert.equal(imageIntents(f.document).length,0);await apply(review,f,history);assert.match(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /);assert.equal(imageIntents(f.document).length,0);history.undo();assert.doesNotMatch(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /);assert.equal(imageIntents(f.document).length,0)}finally{review.dispose()}
 }finally{history.destroy();f.close();restore()}
})

test('a separately recreated and cleared image intent does not authorize replaying packet image history',async()=>{
 const restore=transport(),f=await fixture(),data=Uint8Array.of(1,2),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},history=f.store.undoManager()
 try{
  applyImageReplacement(f.file.document,{base,revision:1,clientId:42,seen:[]},hash)
  const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>assert.fail('none'),readImageResource:async()=>data})
  applyImageReplacement(f.document,{base,revision:1,clientId:43,seen:[]},hash)
  f.document.getMap('hcdImageDrafts').clear()
  const before=Y.encodeStateAsUpdate(f.document),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()})
  try{assert.equal(review.imageDraftsIntegrated,false);await assert.rejects(apply(review,f,history),/image-drafts-review-required/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(imageIntents(f.document).length,0)}finally{review.dispose()}
 }finally{history.destroy();f.close();restore()}
})

test('a packet with no visible image draft cannot delete a live room image intent',async()=>{
 const restore=transport(),f=await fixture(),data=Uint8Array.of(1,2),hash=await recoveryHash(data),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},history=f.store.undoManager()
 try{
  applyImageReplacement(f.document,{base,revision:1,clientId:42,seen:[]},hash)
  Y.applyUpdate(f.file.document,Y.encodeStateAsUpdate(f.document));f.file.document.getMap('hcdImageDrafts').clear()
  assert.equal(imageIntents(f.file.document).length,0)
  const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],verifyCanonical:async()=>{},readResource:async()=>assert.fail('none')})
  const before=Y.encodeStateAsUpdate(f.document),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()})
  try{assert.equal(review.recoveredImageDrafts.length,0);assert.equal(review.imageDraftsIntegrated,false);assert.match(recoveryPlainText(review.candidate.store.project()),/File /);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);await assert.rejects(apply(review,f,history),/image-drafts-review-required/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(imageIntents(f.document).length,1)}finally{review.dispose()}
 }finally{history.destroy();f.close();restore()}
})

test('a text-only packet can merge without changing a later room image draft',async()=>{
 const restore=transport(),f=await fixture(),hash=await recoveryHash(Uint8Array.of(1,2)),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},history=f.store.undoManager()
 try{
  applyImageReplacement(f.document,{base,revision:1,clientId:42,seen:[]},hash)
  const before=imageIntents(f.document),prepared=await review(f)
  try{
   assert.equal(prepared.recoveredImageDrafts.length,0);assert.equal(prepared.imageDraftsIntegrated,true)
   await apply(prepared,f,history);assert.match(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /);assert.deepEqual(imageIntents(f.document),before)
   history.undo();assert.doesNotMatch(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /);assert.deepEqual(imageIntents(f.document),before)
  }finally{prepared.dispose()}
 }finally{history.destroy();f.close();restore()}
})


test('full merge reports possible retained files when cancelled after device copy commits',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory()),controller=new AbortController();f.value.candidate.pendingFiles=[file(1)];const before=Y.encodeStateAsUpdate(f.live.document)
 try{await assert.rejects(applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:controller.signal,canWrite:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async files=>{await cache.importNodeResources(files);controller.abort()}}),/recoveryArchiveFilesRetained/);assert.equal((await cache.pendingNodeResources()).length,1);assert.deepEqual(Y.encodeStateAsUpdate(f.live.document),before)}finally{history.destroy();await cache.close();f.close()}
})
test('full merge reports possibly retained image choices when import fails after storage',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',new IDBFactory()),bytes=Uint8Array.of(2),hash=await recoveryHash(bytes),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:20}},choice={version:1 as const,id:crypto.randomUUID(),name:'image.png',extension:'png' as const,hash,bytes,base,revision:1,phase:'chosen' as const,capture:{base,revision:1,clientId:42,seen:[]}}
 try{const packet=await createSemanticRecoveryArchive({scope,document:f.file.document,schema,canonical,pendingFiles:[],pendingImages:[choice],verifyCanonical:async()=>{},readResource:async()=>assert.fail('no resources')}),review=await prepareRecoveryTransfer({session,bytes:packet,current:f.document,schema,signal:signal()});try{const before=Y.encodeStateAsUpdate(f.document);await assert.rejects(applyRecoveryTransfer(review,{current:f.document,history,signal:signal(),canWrite:()=>true,canWriteAfterImages:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:async()=>{},importImages:async items=>{await journal.importChoices(items);throw Error('notification failed')},pendingImages:()=>journal.list(),withFileLock:work=>work()}),/recoveryArchiveImagesRetained/);assert.equal((await journal.list()).length,1);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{review.dispose()}}finally{await journal.close();history.destroy();f.close();restore()}
})

test('full merge warns when a document observer throws after the merge transaction',async()=>{
 const restore=transport(),f=await fixture(),history=f.store.undoManager(),explode=()=>{throw Error('observer failed')}
 try{const value=await review(f);try{f.document.on('update',explode);await assert.rejects(apply(value,f,history),/recoveryArchiveImportUncertain/);f.document.off('update',explode);assert.match(f.store.project().textContent,/File /);assert.match(f.store.project().textContent,/Live /)}finally{f.document.off('update',explode);value.dispose()}}finally{history.destroy();f.close();restore()}
})

test('full merge warns about both task lists if image import fails after file copy',async()=>{
 const f=await resourceReview(),history=f.live.store.undoManager(),cache=await NodeResourceJournal.openEditor('hcd-local-draft-v1-'+'a'.repeat(64)+'-0-structure3-nodefiles1',structuralProtocol,new IDBFactory());f.value.candidate.pendingFiles=[file(1)];f.value.candidate.pendingImages=[{} as never];let imageAttempted=false
 try{await assert.rejects(applyRecoveryTransfer(f.value,{current:f.live.document,history,signal:signal(),canWrite:()=>true,canWriteAfterImages:()=>true,authorize:async()=>{},stageResource:async()=>{},importFiles:files=>cache.importNodeResources(files),importImages:async()=>{imageAttempted=true;throw Error('unknown outcome')},pendingImages:async()=>[],withFileLock:work=>work()}),/recoveryArchiveMixedTasksRetained/);assert.equal(imageAttempted,true);assert.equal((await cache.pendingNodeResources()).length,1)}finally{history.destroy();await cache.close();f.close()}
})
