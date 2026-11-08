import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {IDBFactory} from 'fake-indexeddb'
import {SemanticImageFiles} from './semanticImageFiles.ts'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {createSemanticRecoveryArchive,openSemanticRecoveryArchive,semanticRecoveryResources,type RecoveryScope,type CanonicalRecoveryVerifier} from './semanticRecoveryArchive.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
import {deletionReviews} from './deletionReview.ts'
import {applyImageReplacement,imageIntents,CollaborativeImageDraftStore} from './collaborativeImages.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),enc=new TextEncoder(),id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`,hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),asset=enc.encode('Original node resource 😀'),canonical=enc.encode('Owned unit verifier fixture, not a ZIP')
const scope:RecoveryScope={documentId:'recovery',epoch:2,model:'structure3-inline1',revision:4,rootHash:'a'.repeat(64)},resource={key:'file',hash:hash(asset),byteLength:asset.length,name:'资源.txt',mediaType:'text/plain'}
const verify:CanonicalRecoveryVerifier=async(bytes,value)=>{assert.deepEqual(bytes,canonical);assert.equal(value.revision,4)}
function fixture(inline=true){const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,inline?{inlineContainers:true}:{})
 const extension={schemaVersion:inline?'hcd.extension/3':'hcd.extension/2',instanceId:id(1),type:'example.file',version:1,display:'inline',...(inline?{contentModel:'inline'}:{}),data:{title:'Original'},fallback:{text:'Field'},resources:[resource]}
 const field=schema.nodeFromJSON({type:inline?'hcdExtensionInlineContainer':'hcdExtensionInline',attrs:{extension},...(inline?{content:[{type:'text',text:'Independent body'}]}:{})});store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('Before '),field,schema.text(' after')])]))
 return{document,store,scope:{...scope,model:inline?'structure3-inline1' as const:'structure3' as const},close:()=>document.destroy()}}
function options(f:ReturnType<typeof fixture>,extra:Partial<Parameters<typeof createSemanticRecoveryArchive>[0]>={}){return{scope:f.scope,document:f.document,schema,canonical,verifyCanonical:verify,readResource:async()=>asset,pendingFiles:[],...extra}}
const json=(bytes:Uint8Array)=>JSON.parse(new TextDecoder().decode(bytes)),bytes=(value:unknown)=>enc.encode(JSON.stringify(value))
function pendingFile():WordNodeResourceDraft{const value=enc.encode('Unfinished original bytes 😀');return{version:1,id:crypto.randomUUID(),regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/2',instanceId:id(9),type:'example.pending',version:1,display:'inline',data:{},fallback:{text:'Pending target'}},resource:{key:'pending',hash:hash(value),byteLength:value.length,name:'未完成.txt',mediaType:'text/plain'},bytes:value}}

test('chunked export preserves the canonical JSON bytes for unicode attachment metadata',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[pendingFile()]}));assert.deepEqual(packet,bytes(json(packet)))}finally{f.close()}
})

for(const heldDigest of [1,3])test(`cancelling stalled export digest ${heldDigest} rejects without creating an archive`,async()=>{
 const f=fixture(),subtle=crypto.subtle,original=subtle.digest.bind(subtle),controller=new AbortController(),before=Y.encodeStateAsUpdate(f.document)
 let calls=0,reads=0,release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(++calls===heldDigest){entered();await gate}return original(...args)}})
 try{const work=createSemanticRecoveryArchive(options(f,{signal:controller.signal,readResource:async()=>{reads++;return asset}}));await held;controller.abort(Error('cancelled'));let timer:ReturnType<typeof setTimeout>|undefined
  try{await assert.rejects(Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled cancellation')),1000)})]),/cancelled/)}finally{clearTimeout(timer)}
  const priorReads=reads;release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(reads,priorReads);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
 }finally{release();delete (subtle as unknown as {digest?:unknown}).digest;f.close()}
})

for(const heldDigest of [1,3])test(`cancelling stalled import digest ${heldDigest} stops opening the candidate`,async()=>{
 const f=fixture(),packet=await createSemanticRecoveryArchive(options(f)),before=Y.encodeStateAsUpdate(f.document),subtle=crypto.subtle,original=subtle.digest.bind(subtle),controller=new AbortController()
 let calls=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(++calls===heldDigest){entered();await gate}return original(...args)}})
 try{const work=openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify,signal:controller.signal});await held;controller.abort(Error('cancelled'));let timer:ReturnType<typeof setTimeout>|undefined
  try{await assert.rejects(Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled cancellation')),1000)})]),/cancelled/)}finally{clearTimeout(timer)}
  release();await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
 }finally{release();delete (subtle as unknown as {digest?:unknown}).digest;f.close()}
})

test('cancelling a stalled canonical verification does not publish an import candidate',async()=>{
 const f=fixture(),packet=await createSemanticRecoveryArchive(options(f)),controller=new AbortController();let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 try{const work=openSemanticRecoveryArchive(packet,{scope:f.scope,schema,signal:controller.signal,verifyCanonical:async()=>{entered();await gate}});await held;controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);release();await new Promise(resolve=>setTimeout(resolve,0))}finally{release();f.close()}
})

test('recovery export reads distinct resources concurrently with bounded ordered results',async()=>{
 const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true}),contents=Array.from({length:6},(_,i)=>enc.encode(`file ${i}`)),resources=contents.map((value,i)=>({key:'file',hash:hash(value),byteLength:value.length,name:`file-${i}.txt`,mediaType:'text/plain'}))
 const nodes=resources.map((item,i)=>schema.nodeFromJSON({type:'hcdExtensionInline',attrs:{extension:{schemaVersion:'hcd.extension/2',instanceId:id(100+i),type:'example.file',version:1,display:'inline',data:{},fallback:{text:'file'},resources:[item]}}}))
 store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,nodes)]))
 let active=0,peak=0,started=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),byHash=new Map(resources.map((item,i)=>[item.hash,contents[i]]))
 try{
  const packet=await createSemanticRecoveryArchive({scope,document,schema,canonical,verifyCanonical:verify,pendingFiles:[],readResource:async(item,signal)=>{active++;peak=Math.max(peak,active);started++;if(started===4)release();try{await Promise.race([gate,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('batch did not start')),3000))]);signal.throwIfAborted();return byHash.get(item.hash)!}finally{active--}}})
  assert.equal(peak,4);assert.equal(started,6);const rows=json(packet).resources;assert.deepEqual(rows.map((row:{sha256:string})=>row.sha256),resources.map(item=>item.hash).sort())
  const opened=await openSemanticRecoveryArchive(packet,{scope,schema,verifyCanonical:verify});try{for(const item of resources)assert.deepEqual(opened.resources.get(item.hash),byHash.get(item.hash))}finally{opened.dispose()}
  let failedStarted=0,cancelled=0,releaseFailure!:()=>void;const failureGate=new Promise<void>(resolve=>releaseFailure=resolve),first=resources.map(item=>item.hash).sort()[0]
  await assert.rejects(createSemanticRecoveryArchive({scope,document,schema,canonical,verifyCanonical:verify,pendingFiles:[],readResource:async(item,signal)=>{failedStarted++;if(failedStarted===4)releaseFailure();await failureGate;if(item.hash===first)throw Error('resource unavailable');await new Promise<void>((_,reject)=>{if(signal.aborted){cancelled++;reject(signal.reason);return}signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason)},{once:true})});return byHash.get(item.hash)!}}),/resource unavailable/)
  assert.equal(failedStarted,4);assert.equal(cancelled,3)
 }finally{release();document.destroy()}
})

test('inline recovery files retain model3 target metadata and private bytes while ordinary packages still reject them',async()=>{
 const inline=fixture(),ordinary=fixture(false),expected=readInlineContainerPayload(inline.store.flow.containers!.readBody(id(1)).attrs.extension),file={...pendingFile(),expected}
 try{const packet=await createSemanticRecoveryArchive(options(inline,{pendingFiles:[file]})),opened=await openSemanticRecoveryArchive(packet,{scope:inline.scope,schema,verifyCanonical:verify})
  try{assert.deepEqual(opened.pendingFiles,[file]);assert.deepEqual(opened.resources.get(file.resource.hash),file.bytes);assert.equal(opened.pendingFiles[0].expected.schemaVersion,'hcd.extension/3')}finally{opened.dispose()}
  await assert.rejects(createSemanticRecoveryArchive(options(ordinary,{pendingFiles:[file]})))
 }finally{inline.close();ordinary.close()}
})

test('ordinary and explicit inline stores roundtrip as isolated candidates with exact state and verified resource bytes',async()=>{
 for(const inline of [false,true]){const f=fixture(inline);try{let reads=0,verifications=0;const verifier:CanonicalRecoveryVerifier=async(b,s)=>{verifications++;await verify(b,s)},original=Y.encodeStateAsUpdate(f.document),packet=await createSemanticRecoveryArchive(options(f,{verifyCanonical:verifier,readResource:async descriptor=>{reads++;assert.equal(descriptor.hash,resource.hash);return asset}})),opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verifier});try{assert.deepEqual(opened.store.project().toJSON(),f.store.project().toJSON());assert.deepEqual(opened.resources.get(resource.hash),asset);assert.equal(reads,1);assert.equal(verifications,2);assert.notEqual(opened.document,f.document);assert.equal(opened.pendingFiles.length,0);assert.deepEqual(Y.encodeStateAsUpdate(f.document),original)}finally{opened.dispose()}}finally{f.close()}}
})
test('hidden bodies and deletion receipts travel even when canonical visible content no longer references their resources',async()=>{
 const f=fixture();try{const doc=f.store.project(),node=doc.firstChild!.child(1),tr=EditorState.create({schema,doc}).tr.delete(8,8+node.nodeSize);f.store.reconcile(f.store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));assert.equal(f.store.project().textContent,'Before  after');assert.equal(semanticRecoveryResources(f.store).length,1);const packet=await createSemanticRecoveryArchive(options(f)),opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.equal(opened.store.project().textContent,'Before  after');assert.equal(opened.store.flow.containers!.readBody(id(1)).textContent,'Independent body');assert.equal(opened.document.getMap('hcd-semantic-inline-deletions/1').size,1);assert.equal(deletionReviews(opened.store).length,0);assert.deepEqual(opened.resources.get(resource.hash),asset)}finally{opened.dispose()}}finally{f.close()}
})
test('uncompleted file choices carry exact private bytes once without becoming document nodes or attachment authority',async()=>{
 const f=fixture();try{const file=pendingFile(),packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[file]})),raw=json(packet);assert.equal(raw.pendingFiles[0].bytes,undefined);assert.equal(raw.resources.length,2);const opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.deepEqual(opened.pendingFiles,[file]);assert.equal(opened.store.project().textContent.includes('Unfinished'),false);assert.deepEqual(opened.resources.get(file.resource.hash),file.bytes)}finally{opened.dispose()}}finally{f.close()}
})
test('large unfinished attachments roundtrip without overflowing base64 validation',async()=>{
 const f=fixture(),content=new Uint8Array(6*1024*1024).fill(173),file=pendingFile();file.bytes=content;file.resource={...file.resource,hash:hash(content),byteLength:content.length}
 try{const packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[file]})),opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.deepEqual(opened.pendingFiles[0].bytes,content)}finally{opened.dispose()}
  const invalid=json(packet),entry=invalid.resources.find((row:{sha256:string})=>row.sha256===file.resource.hash);entry.base64=entry.base64.slice(0,4)+' '+entry.base64.slice(5);await assert.rejects(openSemanticRecoveryArchive(bytes(invalid),{scope:f.scope,schema,verifyCanonical:verify}))
 }finally{f.close()}
})
test('chunked export produces canonical base64 across segment and padding boundaries',async()=>{
 const f=fixture()
 try{for(const length of [192*1024-1,192*1024,192*1024+1,192*1024+2]){
  const content=Uint8Array.from({length},(_,index)=>index%251),file=pendingFile();file.bytes=content;file.resource={...file.resource,hash:hash(content),byteLength:length}
  const packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[file]})),entry=json(packet).resources.find((row:{sha256:string})=>row.sha256===file.resource.hash)
  assert.equal(entry.base64,Buffer.from(content).toString('base64'))
 }}finally{f.close()}
})
test('cancelling a large attachment export stops later encoding segments',async()=>{
 const f=fixture(),content=new Uint8Array(6*1024*1024).fill(173),file=pendingFile(),before=Y.encodeStateAsUpdate(f.document),controller=new AbortController(),original=globalThis.btoa;let chunks=0
 file.bytes=content;file.resource={...file.resource,hash:hash(content),byteLength:content.length}
 globalThis.btoa=(value:string)=>{if(value.length===192*1024&&++chunks===1)setTimeout(()=>controller.abort(Error('cancelled during encoding')),0);return original(value)}
 try{await assert.rejects(createSemanticRecoveryArchive(options(f,{pendingFiles:[file],signal:controller.signal})),/cancelled during encoding/);assert.equal(chunks,1);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{globalThis.btoa=original;f.close()}
})
test('cancelling during large attachment decoding stops subsequent chunks and leaves the document unchanged',async()=>{
 const f=fixture(),content=new Uint8Array(6*1024*1024).fill(173),file=pendingFile();file.bytes=content;file.resource={...file.resource,hash:hash(content),byteLength:content.length}
 const packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[file]})),before=Y.encodeStateAsUpdate(f.document),controller=new AbortController(),original=globalThis.atob;let chunks=0
 globalThis.atob=(value:string)=>{if(value.length===256*1024&&++chunks===1)setTimeout(()=>controller.abort(Error('cancelled during decoding')),0);return original(value)}
 try{await assert.rejects(openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify,signal:controller.signal}),/cancelled during decoding/);assert.equal(chunks,1);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{globalThis.atob=original;f.close()}
})
test('recovery input rejects noncanonical base64 even when it decodes to the original bytes',async()=>{
 const f=fixture()
 try{for(const [text,noncanonical] of [['a','YR=='],['ab','YWJ=']] as const){const content=enc.encode(text),file=pendingFile();file.bytes=content;file.resource={...file.resource,hash:hash(content),byteLength:content.length};const packet=await createSemanticRecoveryArchive(options(f,{pendingFiles:[file]})),raw=json(packet),entry=raw.resources.find((row:{sha256:string})=>row.sha256===file.resource.hash);assert.equal(atob(noncanonical),text);entry.base64=noncanonical;await assert.rejects(openSemanticRecoveryArchive(bytes(raw),{scope:f.scope,schema,verifyCanonical:verify}))}
 }finally{f.close()}
})
test('archive capture stays consistent while the source continues editing during asynchronous resource reads',async()=>{
 const f=fixture();try{const initial=f.store.project().toJSON(),packet=await createSemanticRecoveryArchive(options(f,{readResource:async()=>{const doc=f.store.project(),tr=EditorState.create({schema,doc}).tr.insertText('Later ',9);f.store.reconcile(f.store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));return asset}})),opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.deepEqual(opened.store.project().toJSON(),initial);assert.match(f.store.project().textContent,/Later Independent/)}finally{opened.dispose()}}finally{f.close()}
})
test('state, canonical and resource corruption fail checksums without mutating the source document',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f)),original=Y.encodeStateAsUpdate(f.document);for(const field of ['state','canonical','resource']){const value=json(packet),part=field==='resource'?value.resources[0]:value[field];part.base64=(part.base64[0]==='A'?'B':'A')+part.base64.slice(1);await assert.rejects(openSemanticRecoveryArchive(bytes(value),{scope:f.scope,schema,verifyCanonical:verify}),/integrity/)}assert.deepEqual(Y.encodeStateAsUpdate(f.document),original)}finally{f.close()}
})
test('missing, extra and duplicated resource rows fail closed; a bad resource read publishes no package',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f));for(const change of [(value:any)=>value.resources.pop(),(value:any)=>value.resources.push({...value.resources[0]}),(value:any)=>{value.resources[0]={byteLength:1,sha256:hash(enc.encode('x')),base64:btoa('x')}}]){const value=json(packet);change(value);await assert.rejects(openSemanticRecoveryArchive(bytes(value),{scope:f.scope,schema,verifyCanonical:verify}),/inventory/)}await assert.rejects(createSemanticRecoveryArchive(options(f,{readResource:async()=>enc.encode('bad bytes')})),/integrity/)}finally{f.close()}
})
test('scope is explicit and order-independent; another document, epoch, revision, root or model cannot open the candidate',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f)),reordered={rootHash:f.scope.rootHash,revision:4,model:f.scope.model,epoch:2,documentId:'recovery'},opened=await openSemanticRecoveryArchive(packet,{scope:reordered,schema,verifyCanonical:verify});opened.dispose();for(const patch of [{documentId:'other'},{epoch:3},{revision:5},{rootHash:'b'.repeat(64)},{model:'structure3' as const}])await assert.rejects(openSemanticRecoveryArchive(packet,{scope:{...f.scope,...patch},schema,verifyCanonical:verify}),/scope/)}finally{f.close()}
})
test('canonical verification is mandatory and can reject a relabelled archive even after header checksums are recomputed',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f));await assert.rejects(openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:undefined as unknown as CanonicalRecoveryVerifier}),/verifier-required/);let reads=0;await assert.rejects(createSemanticRecoveryArchive(options(f,{verifyCanonical:async()=>{throw Error('native verifier rejected archive')},readResource:async()=>{reads++;return asset}})),/native verifier rejected/);assert.equal(reads,0);const raw=json(packet);raw.scope.revision=5;await assert.rejects(openSemanticRecoveryArchive(bytes(raw),{scope:{...f.scope,revision:5},schema,verifyCanonical:verify}));}finally{f.close()}
})
test('unknown metadata, invalid base64, invalid UTF8 and oversized declared lengths are rejected before candidate publication',async()=>{
 const f=fixture();try{const packet=await createSemanticRecoveryArchive(options(f));for(const change of [(v:any)=>v.extra=true,(v:any)=>v.state.byteLength=9*1024*1024,(v:any)=>v.state.base64='*'.repeat(v.state.base64.length),(v:any)=>v.scope.token='forbidden']){const value=json(packet);change(value);await assert.rejects(openSemanticRecoveryArchive(bytes(value),{scope:f.scope,schema,verifyCanonical:verify}))}await assert.rejects(openSemanticRecoveryArchive(Uint8Array.of(255),{scope:f.scope,schema,verifyCanonical:verify}))}finally{f.close()}
})
test('terminal or duplicated file choices cannot revive as pending tasks and malformed model state is not guessed',async()=>{
 const f=fixture();try{const file=pendingFile();await assert.rejects(createSemanticRecoveryArchive(options(f,{pendingFiles:[file,{...file}]})),/pending-file/);await assert.rejects(createSemanticRecoveryArchive(options(f,{pendingFiles:[{...file,phase:'cancelled',bytes:new Uint8Array()}]})),/pending-file/);const packet=await createSemanticRecoveryArchive(options(f)),raw=json(packet),doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(raw.state.base64,'base64'));doc.getMap('hcd-semantic-blocks/3/meta').set('inlineContainers',2);const update=Y.encodeStateAsUpdate(doc);raw.state={byteLength:update.length,sha256:hash(update),base64:Buffer.from(update).toString('base64')};await assert.rejects(openSemanticRecoveryArchive(bytes(raw),{scope:f.scope,schema,verifyCanonical:verify}),/Model|model/)}finally{doc.destroy()}}finally{f.close()}
})

test('retained resource-envelope candidates carry bytes not present in the immutable definition or visible document',async()=>{
 const f=fixture();try{const extra=enc.encode('New uncommitted envelope resource'),descriptor={key:'extra',hash:hash(extra),byteLength:extra.length,name:'extra.txt',mediaType:'text/plain'},doc=f.store.project(),node=doc.firstChild!.child(1),extension={...node.attrs.extension,resources:[resource,descriptor]},tr=EditorState.create({schema,doc}).tr.setNodeMarkup(8,undefined,{...node.attrs,extension});f.store.reconcile(f.store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));const current=f.store.project(),remove=EditorState.create({schema,doc:current}).tr.delete(8,8+current.firstChild!.child(1).nodeSize);f.store.reconcile(f.store.blocks(),remove.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));assert.equal(f.store.flow.containers!.definitions.get(id(1))!.node.attrs.extension.resources?.length,1);const packet=await createSemanticRecoveryArchive(options(f,{readResource:async value=>value.hash===descriptor.hash?extra:asset})),opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.equal(opened.kind,'isolated-recovery-candidate');assert.deepEqual(opened.resources.get(descriptor.hash),extra);assert.equal(opened.store.flow.containers!.readBody(id(1)).attrs.extension.resources.length,2);assert.equal(opened.store.project().textContent,'Before  after')}finally{opened.dispose()}}finally{f.close()}
})


test('invalid image draft state is rejected rather than producing an apparently complete package',async()=>{
 const f=fixture();try{f.document.getMap('hcdImageDrafts').set('pending-image',{assetHash:'b'.repeat(64)});const original=Y.encodeStateAsUpdate(f.document);await assert.rejects(createSemanticRecoveryArchive(options(f)),/Invalid shared image draft/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),original)}finally{f.close()}
})

test('version 2 retains pending image bytes, identity and uncertain applying phase in an isolated candidate',async()=>{
 const f=fixture(),imageBytes=enc.encode('synthetic image bytes'),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:40,height:20}},choice={version:1 as const,id:crypto.randomUUID(),name:'pending.png',extension:'png' as const,hash:hash(imageBytes),bytes:imageBytes,base,revision:4,phase:'applying' as const,capture:{base,revision:4,clientId:42,seen:[]}}
 try{const packet=await createSemanticRecoveryArchive(options(f,{pendingImages:[choice]})),raw=json(packet);assert.equal(raw.schemaVersion,'hcd-semantic-recovery/2');assert.equal(raw.pendingImages[0].bytes,undefined)
  const opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.deepEqual(opened.pendingImages,[choice]);assert.deepEqual(opened.resources.get(choice.hash),imageBytes);assert.equal(opened.document.getMap('hcdImageDrafts').size,0)}finally{opened.dispose()}
  for(const mutate of [(value:any)=>{value.pendingImages[0].phase='linked'},(value:any)=>{value.pendingImages[0].capture.revision=9},(value:any)=>{value.pendingImages[0].token='secret'},(value:any)=>{value.pendingImages[0].capture.token='secret'},(value:any)=>value.pendingImages.push(value.pendingImages[0]),(value:any)=>{value.resources=value.resources.filter((item:any)=>item.sha256!==choice.hash)}]){const invalid=json(packet);mutate(invalid);await assert.rejects(openSemanticRecoveryArchive(bytes(invalid),{scope:f.scope,schema,verifyCanonical:verify}))}
  await assert.rejects(createSemanticRecoveryArchive(options(f,{pendingImages:[{...choice,bytes:enc.encode('changed')}]})),/integrity/)
 }finally{f.close()}
})

test('an exported image choice is imported into a new device as uncertain and keeps exact bytes',async()=>{
 const f=fixture(),imageBytes=enc.encode('portable image'),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:40,height:20}},choice={version:1 as const,id:crypto.randomUUID(),name:'pending.png',extension:'png' as const,hash:hash(imageBytes),bytes:imageBytes,base,revision:4,phase:'chosen' as const,capture:{base,revision:4,clientId:42,seen:[]}},journal=await SemanticImageFiles.open('hcd-local-draft-v1-'+'a'.repeat(64)+'-2-inlinecontainers1-nodefiles1',new IDBFactory())
 try{const packet=await createSemanticRecoveryArchive(options(f,{pendingImages:[choice]})),candidate=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.deepEqual(await journal.importChoices(candidate.pendingImages),{added:1,upgraded:0});const [stored]=await journal.list();assert.equal(stored.id,choice.id);assert.equal(stored.phase,'applying');assert.deepEqual(stored.bytes,imageBytes)}finally{candidate.dispose()}}finally{await journal.close();f.close()}
})

test('version 3 preserves collaborative image intents and exact bytes without applying them',async()=>{
 const f=fixture(),image=enc.encode('shared image bytes'),hashValue=hash(image),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),geometry:{unit:'pt' as const,x:1,y:2,width:30,height:20}}
 try{applyImageReplacement(f.document,{base,revision:4,clientId:42,seen:[]},hashValue);const before=Y.encodeStateAsUpdate(f.document);let reads=0
  const packet=await createSemanticRecoveryArchive(options(f,{readImageResource:async value=>{assert.equal(value,hashValue);reads++;return image}}));assert.equal(json(packet).schemaVersion,'hcd-semantic-recovery/3');const opened=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.equal(imageIntents(opened.document).length,1);assert.deepEqual(opened.resources.get(hashValue),image);assert.equal(reads,1);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{opened.dispose()}
  await assert.rejects(createSemanticRecoveryArchive(options(f)),/image-resource-required/);await assert.rejects(createSemanticRecoveryArchive(options(f,{readImageResource:async()=>enc.encode('wrong')})),/integrity/)
  const raw=json(packet);raw.resources=raw.resources.filter((v:any)=>v.sha256!==hashValue);await assert.rejects(openSemanticRecoveryArchive(bytes(raw),{scope:f.scope,schema,verifyCanonical:verify}),/inventory/)
 }finally{f.close()}
})

test('geometry-only image drafts carry their base resource and reject unavailable originals',async()=>{
 const f=fixture(),image=enc.encode('base image'),base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:hash(image),geometry:{unit:'pt' as const,x:1,y:2,width:30,height:20}},drafts=new CollaborativeImageDraftStore(f.document)
 try{drafts.edit(base,4,{...base.geometry,width:42});const packet=await createSemanticRecoveryArchive(options(f,{readImageResource:async()=>image})),candidate=await openSemanticRecoveryArchive(packet,{scope:f.scope,schema,verifyCanonical:verify});try{assert.equal(imageIntents(candidate.document)[0].geometry.width,42);assert.deepEqual(candidate.resources.get(base.assetHash),image)}finally{candidate.dispose()}await assert.rejects(createSemanticRecoveryArchive(options(f,{readImageResource:async()=>{throw Error('resource missing')}})),/resource missing/)}finally{f.close()}
})
