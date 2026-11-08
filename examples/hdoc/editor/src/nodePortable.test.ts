import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {schemaExtensions,jsonToSnapshot,projectionToJson} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {extensionNodes,extensionPreservationPlugin,readExtensionNode} from './extensionNode.ts'
import {extensionEditIndex,nodeEnvelopeField,materializeExtensionEdits} from './extensionEdits.ts'
import type {NodeExtensionDefinition,NodeResource} from './extensionTypes.ts'

test('resource re-pinning avoids retransmitting file bytes and does not bypass failures',async()=>{
 const {archiveNodeResource}=await import('./api.ts'),original=globalThis.fetch,blob=new Blob(['retained attachment'],{type:'application/octet-stream'}),hash=Buffer.from(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex'),session={documentId:'doc',token:'owned',scope:'write' as const,format:'docx'},calls:string[]=[]
 try{
  globalThis.fetch=async(url,init)=>{calls.push(String(url));assert.equal(String(url).endsWith('/resources/reuse'),true);assert.deepEqual(JSON.parse(String(init?.body)),{hash,extension:'bin',byteLength:blob.size});return Response.json({hash,byteLength:blob.size})}
  assert.equal((await archiveNodeResource(session,{file:blob,name:'file.bin',key:'file',reuseExisting:true})).hash,hash);assert.equal(calls.length,1)
  let retries=0;globalThis.fetch=async()=>++retries===1?Response.json({error:'HCD_RESOURCE_BUSY'},{status:409}):Response.json({hash,byteLength:blob.size})
  assert.equal((await archiveNodeResource(session,{file:blob,name:'file.bin',key:'file',reuseExisting:true})).hash,hash);assert.equal(retries,2)
  const cancelled=new AbortController();globalThis.fetch=async()=>{cancelled.abort(new Error('cancelled'));return Response.json({hash,byteLength:blob.size})}
  await assert.rejects(archiveNodeResource(session,{file:blob,name:'file.bin',key:'file',reuseExisting:true,signal:cancelled.signal}),/cancelled/)
  let upload=0;globalThis.fetch=async(url)=>{if(String(url).endsWith('/resources/reuse'))return new Response('denied',{status:403});upload++;return new Response('unexpected')}
  await assert.rejects(archiveNodeResource(session,{file:blob,name:'file.bin',key:'file',reuseExisting:true}));assert.equal(upload,0)
  globalThis.fetch=async()=>Response.json({hash:'f'.repeat(64),byteLength:blob.size});await assert.rejects(archiveNodeResource(session,{file:blob,name:'file.bin',key:'file',reuseExisting:true}),/nodeResourceIntegrity/)
 }finally{globalThis.fetch=original}
})
function textRun(run:import('./extensionTypes.ts').NodeExportRun){assert.ok('text'in run);return run.text}
const resource:NodeResource={key:'photo',hash:'a'.repeat(64),byteLength:4,name:'说明.png',mediaType:'image/png'}
const badge:NodeExtensionDefinition={type:'example.badge',version:1,display:'inline',label:'Badge',defaultData:{title:'Review'},validate:d=>typeof d.title==='string',fallback:d=>String(d.title),exportAdapters:{docx:({data})=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:String(data.title),bold:true}]}]}),pdf:()=>({support:'unsupported',blocks:[]})}}
const rich:NodeExtensionDefinition={...badge,type:'example.callout',display:'block',contentModel:'blocks',exportAdapters:undefined}
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function shared(definition=rich){const registry=new NodeExtensionRegistry([definition]),value=registry.create(definition.type),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{extension:value},content:[{type:'paragraph',content:[{type:'text',text:'First'}]},{type:'paragraph',content:[{type:'text',text:'Second'}]}]},{type:'paragraph',content:[{type:'text',text:'Outside'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));return{registry,value,a,b,sa,sb,merge(){Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))},close(){a.destroy();b.destroy()}}}
function reconcile(store:SemanticBlockStore,doc:ReturnType<typeof schema.node>){store.reconcile(store.blocks(),doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
test('portable snapshots are deterministic, copied, validated and retain source resources on property edits',()=>{
 const registry=new NodeExtensionRegistry([badge]),value=registry.create(badge.type,undefined,[resource]);assert.equal(value.schemaVersion,'hcd.extension/2');assert.equal(textRun(value.exports!.docx!.blocks[0].runs[0]),'Review');assert.deepEqual(registry.update(value,{title:'Changed'}).resources,[resource]);assert.equal(textRun(registry.update(value,{title:'Changed'}).exports!.docx!.blocks[0].runs[0]),'Changed');assert.ok(registry.resolve(value));assert.throws(()=>readExtensionNode({...value,resources:[{...resource,hash:'../outside'}]}));assert.throws(()=>readExtensionNode({...value,exports:{docx:{support:'semantic',blocks:[{kind:'paragraph',runs:[{resource:'missing',alt:'x',widthPt:10,heightPt:10}]}]}}}));assert.throws(()=>new NodeExtensionRegistry([{...badge,exportAdapters:{docx:(()=>Promise.resolve({})) as any}}]));let n=0;assert.throws(()=>new NodeExtensionRegistry([{...badge,exportAdapters:{docx:()=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:String(++n)}]}]})}}]))
})
test('rich container maps through canonical snapshots without duplicating its rich text in business JSON',()=>{
 const f=shared();const snapshot=jsonToSnapshot(f.sa.project().toJSON());assert.equal(snapshot[0].content.kind,'extension');assert.equal(snapshot[0].content.children!.length,2);assert.deepEqual(snapshot[0].content.inlines,[]);const json=projectionToJson({documentId:'doc',revision:1,blocks:snapshot.map((b,i)=>({...b,blockId:`block${i}`,blockHash:'h',region:'body',readOnly:false}))});assert.equal(schema.nodeFromJSON(json).textContent,'FirstSecondOutside');assert.deepEqual(f.value.data,{title:'Review'});f.close()
})
test('two offline rich subtree edits converge; own undo preserves the peer paragraph and survives readback',()=>{
 const f=shared(),undo=f.sa.undoManager();undo.stopCapturing();let state=EditorState.create({schema,doc:f.sa.project()});reconcile(f.sa,state.tr.insertText(' Alice',7).doc);undo.stopCapturing();state=EditorState.create({schema,doc:f.sb.project()});reconcile(f.sb,state.tr.insertText(' Bob',15).doc);f.merge();assert.match(f.sa.project().textContent,/Alice/);assert.match(f.sa.project().textContent,/Bob/);assert.deepEqual(f.sa.project().toJSON(),f.sb.project().toJSON());undo.undo();assert.doesNotMatch(f.sa.project().textContent,/Alice/);assert.match(f.sa.project().textContent,/Bob/);undo.redo();assert.match(f.sa.project().textContent,/Alice/);const c=new Y.Doc();Y.applyUpdate(c,Y.encodeStateAsUpdate(f.a));assert.deepEqual(new SemanticBlockStore(c,schema).project().toJSON(),f.sa.project().toJSON());assert.equal(extensionNodes(f.sa.project()).size,1);undo.destroy();c.destroy();f.close()
})
test('unknown rich container remains readable and rejects local inner edits without discarding its children',()=>{
 const f=shared(),doc=f.sa.project(),state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin()]});const tr=state.tr.insertText('discard me',3);assert.equal(state.applyTransaction(tr).transactions.length,0);assert.equal(state.doc.textContent,'FirstSecondOutside');const registry=f.registry;const known=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(()=>{},()=>registry)]});assert.equal(known.applyTransaction(known.tr.insertText(' allowed ',3)).transactions.length,1);f.close()
})
test('concurrent resource changes preserve complete candidates rather than merge dangling file references',()=>{
 const f=shared(),a=f.sa.project(),b=f.sb.project();reconcile(f.sa,a.copy(a.content.replaceChild(0,a.child(0).type.createChecked({...a.child(0).attrs,extension:f.registry.updateResources(f.value,[resource])},a.child(0).content))));reconcile(f.sb,b.copy(b.content.replaceChild(0,b.child(0).type.createChecked({...b.child(0).attrs,extension:f.registry.updateResources(f.value,[{...resource,key:'other',hash:'b'.repeat(64)}])},b.child(0).content))));f.merge();const group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.equal(group.conflicts[nodeEnvelopeField].length,2);assert.equal(group.conflicts[nodeEnvelopeField].every(c=>(c.value as any).resources.length===1),true);f.close()
})
test('same-schema field merges regenerate portable snapshots for the exact merged intent set',()=>{
 const def={...badge,display:'block' as const,defaultData:{title:'Review',done:false},validate:(d:Readonly<Record<string,unknown>>)=>typeof d.title==='string'&&typeof d.done==='boolean',fallback:(d:Readonly<Record<string,unknown>>)=>`${d.title}:${d.done}`,exportAdapters:{docx:({data}:any)=>({support:'semantic' as const,blocks:[{kind:'paragraph' as const,runs:[{text:`${data.title}:${data.done}`}]}]})}},registry=new NodeExtensionRegistry([def]),value=registry.create(def.type),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionBlock',attrs:{extension:value}}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));for(const[store,data]of [[sa,{title:'Alice',done:false}],[sb,{title:'Review',done:true}]] as const){const doc=store.project();reconcile(store,schema.nodes.doc.createChecked(null,[doc.child(0).type.createChecked({...doc.child(0).attrs,extension:registry.update(value,data)})]))}Y.applyUpdate(a,Y.encodeStateAsUpdate(b));materializeExtensionEdits(a,registry);const merged=extensionNodes(sa.project()).get(value.instanceId)!.value;assert.deepEqual(merged.data,{title:'Alice',done:true});assert.equal(textRun(merged.exports!.docx!.blocks[0].runs[0]),'Alice:true');assert.equal(extensionEditIndex(a).get(value.instanceId)!.ready,true);a.destroy();b.destroy()
})
test('resource archive/read authenticates hashes, size and committed offline fallback before returning bytes',async()=>{
 const {archiveNodeResource,readNodeResource}=await import('./api.ts'),saved=globalThis.fetch,blob=new Blob(['archived opaque attachment'],{type:'application/octet-stream'}),hash=Buffer.from(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())).toString('hex'),session={documentId:'doc',token:'local-test-token',scope:'write' as const,format:'docx',apiUrl:'http://localhost/v1/documents'},calls:string[]=[]
 try{globalThis.fetch=async(url,init)=>{calls.push(String(url));assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer local-test-token');if(String(url).includes('/resources'))return Response.json({hash,byteLength:blob.size});if(String(url).includes('staged-assets'))return new Response('missing',{status:404});return new Response(blob)};const r=await archiveNodeResource(session,{file:blob,key:'document',name:'notes.bin'});assert.equal(r.hash,hash);assert.equal(await(await readNodeResource(session,r)).text(),'archived opaque attachment');assert.equal(calls.some(url=>url.endsWith('/assets/'+hash)),true);globalThis.fetch=async()=>new Response('corrupt');await assert.rejects(readNodeResource(session,r),/nodeResourceIntegrity/);globalThis.fetch=async()=>new Response('denied',{status:403});await assert.rejects(archiveNodeResource(session,{file:blob,key:'document',name:'notes.bin'}),/403/)}finally{globalThis.fetch=saved}
})
test('recovery byte reads verify resources and use the requested revision',async()=>{
 const {readNodeResourceBytes}=await import('./api.ts'),old=globalThis.fetch,bytes=new TextEncoder().encode('recovery attachment'),hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),session={documentId:'doc',token:'test',scope:'write' as const,format:'docx',apiUrl:'http://localhost/v1/documents'},resource={key:'file',name:'file.bin',mediaType:'application/octet-stream',hash,byteLength:bytes.length},calls:string[]=[]
 try{
  globalThis.fetch=async url=>{calls.push(String(url));return new Response(bytes)}
  assert.deepEqual(await readNodeResourceBytes(session,resource,7),bytes)
  assert.match(calls[0],/\/assets\/.*\?revision=7$/)
  globalThis.fetch=async()=>new Response(new Uint8Array(bytes.length))
  await assert.rejects(readNodeResourceBytes(session,resource),/nodeResourceIntegrity/)
  const cancelled=new AbortController();cancelled.abort(new Error('cancelled'))
  await assert.rejects(readNodeResourceBytes(session,resource,undefined,cancelled.signal),/cancelled/)
 }finally{globalThis.fetch=old}
})
test('node resource download stops if the response exceeds its declared resource size',async()=>{
 const {readNodeResource}=await import('./api.ts'),old=globalThis.fetch,session={documentId:'doc',token:'test',scope:'write' as const,format:'docx',apiUrl:'http://localhost/v1/documents'}
 let cancelled=false
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(1,2,3,4))},cancel(){cancelled=true}}))
 try{await assert.rejects(readNodeResource(session,{key:'file',name:'file.bin',mediaType:'application/octet-stream',hash:'a'.repeat(64),byteLength:3}),/nodeResourceIntegrity/);assert.equal(cancelled,true)}finally{globalThis.fetch=old}
})
test('node resource recovery stops waiting for response headers after cancellation',async()=>{
 const {readNodeResourceBytes}=await import('./api.ts'),old=globalThis.fetch,controller=new AbortController(),bytes=new TextEncoder().encode('attachment'),hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),session={documentId:'doc',token:'test',scope:'write' as const,format:'docx'},resource={key:'file',name:'file.bin',mediaType:'application/octet-stream',hash,byteLength:bytes.length};let started!:()=>void,calls=0
 const reached=new Promise<void>(resolve=>{started=resolve})
 try{globalThis.fetch=async()=>{calls++;started();return new Promise<Response>(()=>{})};const pending=readNodeResourceBytes(session,resource,undefined,controller.signal);await reached;controller.abort(new Error('cancel headers'));await assert.rejects(pending,/cancel headers/);assert.equal(calls,1)}finally{globalThis.fetch=old}
})
test('rich child block operations preserve the wrapper and target only sibling children',async()=>{
 const {blockTarget,transformBlocks,blockActionStates,blockMoveMeta}=await import('./commands/blocks.ts'),f=shared();let state=EditorState.create({schema,doc:f.sa.project(),plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]});state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,3)));let target=blockTarget(state)!;assert.ok(target.scope);assert.equal(blockActionStates(state,target)['block.heading'].enabled,true);let tr=state.tr;assert.equal(transformBlocks(tr,'block.heading',undefined,target,f.registry),true);assert.equal(tr.doc.child(0).type.name,'hcdExtensionContainer');assert.equal(tr.doc.child(0).child(0).type.name,'heading');reconcile(f.sa,tr.doc);state=EditorState.create({schema,doc:f.sa.project(),plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]});state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,3)));target=blockTarget(state)!;tr=state.tr;assert.equal(transformBlocks(tr,'block.down',undefined,target,f.registry),true);assert.deepEqual(tr.getMeta(blockMoveMeta).keys,[f.sa.project().child(0).child(0).attrs.hcdStructureKey]);assert.equal(tr.doc.child(0).child(1).textContent,'First');assert.equal(tr.doc.child(1).textContent,'Outside');assert.equal(transformBlocks(state.tr,'block.move',{destination:state.doc.content.size},target,f.registry),false);f.close()
})

test('container portable decorations explicitly retain the live collaborative children',()=>{const registry=new NodeExtensionRegistry([{...rich,exportAdapters:{docx:({data})=>({support:'semantic',includeContent:true,blocks:[{kind:'heading',level:2,runs:[{text:String(data.title)}]}]})}}]);const value=registry.create(rich.type);assert.equal(value.exports!.docx!.includeContent,true);assert.throws(()=>new NodeExtensionRegistry([{...rich,exportAdapters:badge.exportAdapters}]))})

test('portable false mark defaults canonicalize exactly like native serialization without changing business data',()=>{const def={...badge,exportAdapters:{docx:()=>({support:'semantic' as const,blocks:[{kind:'paragraph' as const,runs:[{text:'same',bold:false,italic:false}]}]})}},registry=new NodeExtensionRegistry([def]),value=registry.create(def.type);assert.deepEqual(value.exports!.docx!.blocks[0].runs[0],{text:'same'});const native=JSON.parse(JSON.stringify(value));assert.ok(registry.resolve(native));assert.throws(()=>readExtensionNode({...value,resources:[{...resource,mediaType:new String('image/png')}]}))})
test('container property commands preserve live children and merge with offline peer text edits',async()=>{
 const {prepareNodeTransaction}=await import('./extensionCommands.ts'),{NodeSelection}=await import('@tiptap/pm/state'),f=shared(),undo=f.sa.undoManager();let state=EditorState.create({schema,doc:f.sa.project(),plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]});state=state.apply(state.tr.setSelection(NodeSelection.create(state.doc,0)));const fake={isDestroyed:false,isEditable:true,get state(){return state},view:{composing:false,dispatch(tr:import('@tiptap/pm/state').Transaction){state=state.apply(tr)},focus(){}}} as unknown as import('@tiptap/core').Editor;const prepared=prepareNodeTransaction(fake,f.registry,'node.update',{instanceId:f.value.instanceId,expected:f.value,data:{title:'Renamed'}})!;assert.equal(prepared.commit(),true);assert.equal(state.doc.child(0).childCount,2);assert.equal(state.doc.child(0).attrs.extension.fallback.text,'Renamed');assert.equal('fallbackInline'in state.doc.child(0).attrs,false);undo.stopCapturing();reconcile(f.sa,state.doc);undo.stopCapturing();const peer=EditorState.create({schema,doc:f.sb.project()});reconcile(f.sb,peer.tr.insertText(' peer retained ',3).doc);f.merge();assert.equal(f.sa.project().child(0).attrs.extension.data.title,'Renamed');assert.match(f.sa.project().textContent,/peer retained/);undo.undo();assert.equal(f.sa.project().child(0).attrs.extension.data.title,'Review');assert.match(f.sa.project().textContent,/peer retained/);undo.redo();assert.equal(f.sa.project().child(0).attrs.extension.data.title,'Renamed');undo.destroy();f.close()
})

test('pending resource archives notify lifecycle guards, bound concurrency and release on failure or disposal',async()=>{
 let finish:((value:NodeResource)=>void)[]=[];const registry=new NodeExtensionRegistry([],()=>{},{archive:()=>new Promise(resolve=>finish.push(resolve)),read:async()=>new Blob()});const disconnect=registry.connect();let changes=0;registry.subscribe(()=>changes++);
 const input={file:new Blob(['data']),name:'说明.png',key:'photo'},a=registry.archiveResource(input),b=registry.archiveResource(input);assert.equal(registry.resourceStatus().pending,2);await assert.rejects(registry.archiveResource(input),/nodeResourceBusy/);finish[0](resource);await a;assert.equal(registry.resourceStatus().pending,1);disconnect();finish[1](resource);await assert.rejects(b,/nodeExtensionDisposed/);assert.equal(registry.resourceStatus().pending,0);assert.equal(changes,4);
 const invalid=new NodeExtensionRegistry([],()=>{},{archive:async()=>({...resource,hash:'bad'}),read:async()=>new Blob()});invalid.connect();await assert.rejects(invalid.archiveResource(input));assert.equal(invalid.resourceStatus().pending,0)
})

test('resource cancellation settles without transport cooperation and an old lifetime cannot revive on reconnect',async()=>{
 const calls:{signal:AbortSignal;resolve:(value:NodeResource)=>void;reject:(error:Error)=>void}[]=[]
 const registry=new NodeExtensionRegistry([],()=>{},{archive:input=>new Promise((resolve,reject)=>calls.push({signal:input.signal!,resolve,reject})),read:async()=>new Blob()})
 const oldCleanup=registry.connect(),input={file:new Blob(['data']),name:'original.png',key:'original'}
 const old=registry.archiveResource(input),oldFailure=assert.rejects(old,/nodeExtensionDisposed/)
 input.key='mutated'
 oldCleanup();const currentCleanup=registry.connect();oldCleanup()
 await oldFailure;assert.equal(calls[0].signal.aborted,true);assert.equal(registry.resourceStatus().pending,0)
 const abort=new AbortController(),cancelled=registry.archiveResource({...input,signal:abort.signal}),cancelFailure=assert.rejects(cancelled,/manual cancellation/)
 abort.abort(new Error('manual cancellation'));await cancelFailure;assert.equal(calls[1].signal.aborted,true);assert.equal(registry.resourceStatus().pending,0)
 const fresh=registry.archiveResource(input);calls[0].resolve(resource);calls[1].reject(new Error('late rejected response'));calls[2].resolve(resource)
 assert.deepEqual(await fresh,resource);assert.equal(registry.resourceStatus().pending,0)
 currentCleanup()
})

test('resource requests snapshot metadata and an aborted body read cannot return after reconnect',async()=>{
 let finish:((value:NodeResource)=>void)|undefined,readFinish:((value:Blob)=>void)|undefined,captured:{key:string;name:string}|undefined,readSignal:AbortSignal|undefined
 const registry=new NodeExtensionRegistry([],()=>{},{archive:input=>{captured=input;return new Promise(resolve=>{finish=resolve})},read:(_resource,_revision,signal)=>{readSignal=signal;return new Promise(resolve=>{readFinish=resolve})}})
 let close=registry.connect();const input={file:new Blob(['data']),name:'original.png',key:'original'},upload=registry.archiveResource(input);input.name='changed.png';input.key='changed';assert.equal(captured!.name,'original.png');assert.equal(captured!.key,'original');finish!(resource);await upload
 const read=registry.readResource(resource),failure=assert.rejects(read,/nodeExtensionDisposed/);close();close=registry.connect();await failure;assert.equal(readSignal!.aborted,true);readFinish!(new Blob(['late']));close()
})

test('resource timeout releases the save gate and ignores an unknown late outcome',async context=>{
 const deadline=new AbortController();context.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{assert.equal(milliseconds,45_000);return deadline.signal})
 let finish:((value:NodeResource)=>void)|undefined
 const registry=new NodeExtensionRegistry([],()=>{},{archive:()=>new Promise(resolve=>{finish=resolve}),read:async()=>new Blob()});const close=registry.connect()
 const request=registry.archiveResource({file:new Blob(['data']),name:'file.png',key:'photo'}),failure=assert.rejects(request,error=>error instanceof DOMException&&error.name==='TimeoutError')
 deadline.abort(new DOMException('Resource deadline exceeded','TimeoutError'));await failure;assert.equal(registry.resourceStatus().pending,0);finish!(resource);close()
})

test('resource progress does not invalidate command registrations needed by the pending binding',async()=>{
 let finish:((value:NodeResource)=>void)|undefined
 const registry=new NodeExtensionRegistry([],()=>{},{archive:()=>new Promise(resolve=>{finish=resolve}),read:async()=>new Blob()}),close=registry.connect(),remove=registry.register([badge]),generation=registry.commandSnapshot(),snapshot=registry.snapshot()
 const upload=registry.archiveResource({file:new Blob(['data']),name:'file.png',key:'photo'});assert.equal(registry.commandSnapshot(),generation);assert.ok(registry.snapshot()>snapshot);finish!(resource);await upload;assert.equal(registry.commandSnapshot(),generation);assert.equal(registry.commands().length,1);remove();assert.ok(registry.commandSnapshot()>generation);assert.equal(registry.commands().length,0);close()
})
