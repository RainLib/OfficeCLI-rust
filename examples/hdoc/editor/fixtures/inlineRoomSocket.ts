/** Real Hocuspocus/native fixture. No browser or user document automation. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHmac,timingSafeEqual} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState,NodeSelection,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import type {Node as PmNode} from '@tiptap/pm/model'
import {HocuspocusProvider} from '@hocuspocus/provider'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot,projectionToJson} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../src/semanticStructureBinding.ts'
import {inlineContainerFields} from '../src/semanticInlineContainers.ts'
import {inlineProtocol,inlineCollaborationUrl,nodeEditCollaborationUrl} from '../src/collaborationProtocol.ts'
import {checkpointDigest} from '../src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../src/semanticSaveClient.ts'
import {negotiateSession} from '../src/protocolClient.ts'
import {readServerDraft} from '../src/draftBootstrap.ts'
import {LocalDraftJournal,draftIdentity,restoreLocalDraft,localDraftPreview,localDocumentProtocol} from '../src/localDrafts.ts'
import {IDBFactory} from 'fake-indexeddb'
import {archiveNodeResource,readNodeResource,type Session} from '../src/api.ts'
import {NodeExtensionRegistry} from '../src/extensionRegistry.ts'
import {extensionPreservationPlugin} from '../src/extensionNode.ts'
import {NodeResourceJournal,nodeResourceJournalIdentity} from '../src/nodeResourceJournal.ts'
import {InlineNodeResourceClient,type WordNodeResourceDraft} from '../src/wordNodeResources.ts'
import type {ResourceNodePayload} from '../src/nodeResourceModel.ts'
import {InlineContainerRegistry,type InlineContainerDefinition} from '../src/inlineContainerRegistry.ts'
import {prepareInlineContainerTransaction,selectedInlineContainer} from '../src/inlineContainerCommands.ts'
import {materializeInlineContainerEdits} from '../src/inlineContainerEdits.ts'
import {inlineContainerPreservationPlugin,prepareInlineContainerHistoryGuard} from '../src/inlineContainerPreservation.ts'
import {inlineContainerNodes} from '../src/inlineContainerEdits.ts'
import {blockTarget,rootBlocks,prepareBlockTransaction} from '../src/commands/blocks.ts'
import {findMention,mentionPlugin,mentionTransaction,readMentionPage} from '../src/mentionSuggestion.ts'
import {captureAiTarget,resolveAiTarget,aiTextTransaction} from '../src/ai/semantic.ts'
import type {Editor} from '@tiptap/core'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),phase=process.argv[3],models={inlineContainers:true} as const,schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const headers={'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'},base=c.origin+'/v1/documents/inline-native',clients:Array<{document:Y.Doc;provider:HocuspocusProvider;close?:()=>void}>=[]
async function until(check:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
async function info(route:string){const r=await fetch(base+route,{headers:{...headers,Authorization:'Bearer '+c.alice}});assert.equal(r.status,200,await r.clone().text());return r.json()}
async function negotiate(ack=true){return fetch(c.collabOrigin+'/v1/documents/inline-native/collaboration/negotiate',{method:'POST',headers:{...(ack?headers:{}),Authorization:'Bearer '+c.alice}})}
const missing=await negotiate(false);assert.equal(missing.status,426)
const preflight=await fetch(c.collabOrigin+'/v1/documents/inline-native/collaboration/negotiate',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:12345','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,x-hcd-node-edits-version,x-hcd-inline-containers-version,x-hcd-extension-version,x-hcd-custom-marks-version'}})
assert.equal(preflight.status,204);for(const name of Object.keys(headers))assert.ok(preflight.headers.get('Access-Control-Allow-Headers')!.includes(name.toLowerCase()))
const nativeSession:Session={documentId:'inline-native',token:c.alice,format:'html',scope:'write',apiUrl:c.origin+'/v1/documents',collabUrl:c.collabUrl}
const auth=await negotiateSession(nativeSession,new AbortController().signal,models);assert.equal(auth.collaborationProtocol,inlineProtocol)
if(c.draftRecovery){
 const ordinary={...nativeSession,documentId:'ordinary',token:c.ordinary},before=await(await fetch(c.origin+'/v1/documents/ordinary/auth',{headers:{Authorization:'Bearer '+c.ordinary}})).json()
 await assert.rejects(negotiateSession(ordinary,new AbortController().signal,models),(error:unknown)=>error instanceof Error&&'status' in error&&error.status===426)
 const after=await(await fetch(c.origin+'/v1/documents/ordinary/auth',{headers:{Authorization:'Bearer '+c.ordinary}})).json();assert.equal(after.collaborationEpoch,before.collaborationEpoch);assert.equal(after.collaborationProtocol,before.collaborationProtocol)
 const untouched=await fetch(c.origin+'/v1/documents/ordinary/collaboration/state',{headers:{Authorization:'Bearer '+c.ordinary,'X-HCD-Collaboration-Epoch':String(after.collaborationEpoch)}});assert.equal(untouched.status,404)
}
const session={...nativeSession,...auth}
let deviceJournal:LocalDraftJournal|undefined
async function connect(user:'alice'|'bob'|'reader',ack=true,document=new Y.Doc({gc:false})){
 const store=new SemanticBlockStore(document,schema,undefined,models),errors:unknown[]=[],events:{authFailed:boolean;closed:boolean}={authFailed:false,closed:false}
 const provider=new HocuspocusProvider({url:(ack?inlineCollaborationUrl:nodeEditCollaborationUrl)(c.collabUrl),name:`inline-native:${auth.collaborationEpoch}:inlinecontainers1:save4`,document,token:c[user],onAuthenticationFailed:()=>{events.authFailed=true},onClose:()=>{events.closed=true}})
 const item={document,provider,close:undefined as (()=>void)|undefined};clients.push(item)
 if(!ack){await until(()=>events.authFailed,'missing model rejected');provider.disconnect();return{...item,store,events,errors,state:()=>{throw Error('unbound')},dispatch:(_tr:Transaction)=>{},installInteractions:(_registry:InlineContainerRegistry)=>{throw Error('unbound')}}}
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'sync '+user)
 const plugin=semanticStructureBinding(store,{canWrite:()=>user!=='reader',onError:error=>errors.push(error)})
 let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}}
 binding=plugin.spec.view!(view as unknown as EditorView);item.close=()=>binding.destroy?.()
 await until(()=>state.doc.eq(store.project()),'bind '+user)
 return{...item,store,events,errors,state:()=>state,dispatch:view.dispatch,installInteractions:(registry:InlineContainerRegistry)=>{const nodes=new NodeExtensionRegistry();state=state.reconfigure({plugins:[...state.plugins,extensionPreservationPlugin(()=>errors.push(Error('unsupportedPaste')),()=>nodes),inlineContainerPreservationPlugin(registry.resolve,error=>errors.push(error),()=>registry),mentionPlugin()]})}}
}
type Client=Awaited<ReturnType<typeof connect>>
function commandEditor(client:Client){return{get state(){return client.state()},schema,view:{composing:false,focus(){},dispatch:client.dispatch},isEditable:true,isDestroyed:false} as unknown as Editor}
function retainedItems(body:Y.XmlText){const values:string[]=[];for(let item=body._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)values.push(`${item.id.client}:${item.id.clock+i}`);return values}
function commandDefinition():InlineContainerDefinition{
 const adapter=({data}:{data:Readonly<Record<string,unknown>>})=>({support:'semantic' as const,includeContent:true as const,blocks:[{kind:'paragraph' as const,runs:[{text:String(data.title)+': '}]}]})
 return{type:'example.command_field',version:1,display:'inline',contentModel:'inline',label:'命令字段',defaultData:{title:'命令字段'},validate:data=>typeof data.title==='string'&&!!data.title,fallback:data=>String(data.title),exportAdapters:{docx:adapter,pdf:adapter,pptx:adapter,md:adapter}}
}
async function fileClient(){
 const factory=new IDBFactory(),cache=await NodeResourceJournal.openInline(await nodeResourceJournalIdentity(session,'alice','http://fixture.invalid'),factory);let uploads=0
 const transport=new NodeExtensionRegistry([],()=>{},{archive:input=>{uploads++;return archiveNodeResource(session,input)},read:(resource,revision,signal)=>readNodeResource(session,resource,revision,signal)}),release=transport.connect()
 const client=new InlineNodeResourceClient({cache,registry:transport,ready:()=>true});await client.initialize()
 return{cache,client,uploads:()=>uploads,close:async()=>{client.dispose();release();await cache.close()}}
}
async function exerciseCommands(client:Client){
 const definition=commandDefinition()
 const registry=new InlineContainerRegistry(),release=registry.connect();let remove=registry.register([definition])
 const editor=commandEditor(client),execute=(id:string,input:unknown)=>{const prepared=prepareInlineContainerTransaction(editor,registry,id,input);assert.ok(prepared,id);assert.ok(prepared.commit(),id);materializeInlineContainerEdits(client.document,registry);return prepared.value}
 const request=(extra:object={})=>{const current=selectedInlineContainer(client.state())!;return{instanceId:current.value.instanceId,expected:current.value,...extra}}
 try{
  if(c.blocks)client.store.insert([schema.nodes.paragraph.createChecked(null,schema.text('Block start '))],null)
  client.dispatch(client.state().tr.setSelection(TextSelection.atEnd(client.state().doc)))
  const inserted=execute('node.insert',{model:'inline',type:definition.type})!;let current=selectedInlineContainer(client.state())!;client.dispatch(client.state().tr.insertText('命令行内正文😀',current.position+1));client.dispatch(client.state().tr.setSelection(NodeSelection.create(client.state().doc,current.position)))
  const body=client.store.flow.containers!.bodies.get(inserted.instanceId)!,original=retainedItems(body)
  execute('node.update',request({data:{title:'命令字段更新'}}))
  let resources:import('../src/extensionPortable.ts').NodeResource[]=[];client.state().doc.descendants(node=>{if(!resources.length&&node.attrs.extension?.resources?.length)resources=structuredClone(node.attrs.extension.resources)})
  assert.ok(resources.length);execute('node.resources',request({resources}))
  remove();remove=registry.register([{...definition,version:2,migrations:[{fromVersion:1,validate:definition.validate,migrate:data=>({title:String(data.title)+' v2'})}]}])
  current=selectedInlineContainer(client.state())!;const preview=registry.previewMigration(current.value)!;assert.ok(preview);execute('node.migrate',request({after:preview.after}));assert.deepEqual(retainedItems(body),original);assert.equal(body.toString(),'命令行内正文😀')
  if(c.nodeFiles){const files=await fileClient();try{const draft=await files.client.start(new File(['行内容器原始附件😀'],'行内容器附件.txt',{type:'text/plain'}),selectedInlineContainer(client.state())!.value,'body');assert.equal(files.uploads(),1);assert.ok(files.client.state().pending);await writeFile(join(c.root,'node-file-choice.json'),JSON.stringify({...draft,bytes:Array.from(draft.bytes)}))}finally{await files.close()}}
  await saved(client)
  // A first successful checkpoint is insufficient: new bodies must accept the
  // recursive source receipt and remain valid on the next native checkpoint.
  const acknowledged=selectedInlineContainer(client.state())!;assert.equal(acknowledged.value.instanceId,inserted.instanceId);client.dispatch(client.state().tr.insertText('回执后 ',acknowledged.position+1));client.dispatch(client.state().tr.setSelection(NodeSelection.create(client.state().doc,acknowledged.position)))
  let head=await saved(client)
  if(c.interactions)head=await exerciseInlineInteractions(client,registry,inserted.instanceId)
  if(c.blocks)head=await exerciseInlineBlocks(client,registry,inserted.instanceId)
  await writeFile(join(c.root,'command-evidence.json'),JSON.stringify({head,instanceId:inserted.instanceId,version:2,title:'命令字段更新 v2',body:client.store.flow.containers!.readBody(inserted.instanceId).textContent,originalBodyItemsUnchangedBeforeSubsequentInput:true,bodyEditedAndSavedAfterFirstReceipt:true,existingArchivedResourcesLinked:resources.length,propertyAndMigrationThroughProductionCommands:true},null,2));return head
 }finally{remove();release()}
}
async function exerciseInlineInteractions(client:Client,registry:InlineContainerRegistry,instanceId:string){
 client.installInteractions(registry)
 const entry=()=>{let found:{position:number;node:PmNode}|undefined;client.state().doc.descendants((node,position)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===instanceId)found={node,position}});assert.ok(found);return found}
 let at=entry(),tr=client.state().tr.setSelection(TextSelection.create(client.state().doc,at.position+at.node.nodeSize-1)).insertText(' @Bob');client.dispatch(tr)
 const match=findMention(client.state());assert.ok(match);assert.equal(match.query,'Bob')
 const page=readMentionPage(await info('/mention-options?kind=person&q=Bob&limit=20')),candidate=page.items.find(item=>item.id==='bob');assert.ok(candidate)
 client.dispatch(mentionTransaction(client.state(),match,candidate));const mentionRevision=await saved(client),refs=await info('/references?locations=true'),occurrence=refs.items.find((item:any)=>item.reference.target.id==='bob')
 assert.ok(occurrence);assert.ok(occurrence.inlinePath.length);assert.equal(occurrence.reference.snapshot.label,'Bob 李');assert.equal(refs.reminders.enabled,false)
 const events=refs.transition.events.filter((event:any)=>event.mentionId===occurrence.reference.mentionId);assert.equal(events.length,1);assert.equal(events[0].context.actorId,'alice')
 at=entry();const from=at.position+1+at.node.textContent.indexOf('命令行内正文');client.dispatch(client.state().tr.setSelection(TextSelection.create(client.state().doc,from,from+'命令行内正文'.length)))
 const target=captureAiTarget(client.store,client.state(),'replace');assert.ok(target);assert.equal(target.parent,'extension:'+instanceId)
 const range=resolveAiTarget(client.store,client.state(),target);assert.ok(range);client.dispatch(aiTextTransaction(client.state(),range,'命令行内正文 AI采纳'))
 const head=await saved(client),after=await info('/references?locations=true');assert.equal(after.items.find((item:any)=>item.reference.mentionId===occurrence.reference.mentionId).reference.target.id,'bob');assert.equal(after.transition.events.length,0);assert.equal(after.reminders.enabled,false)
 await writeFile(join(c.root,'interaction-evidence.json'),JSON.stringify({scope:'Production PM helpers + real native HTTP/socket, no browser UI or external AI provider claim',mentionRevision,acceptedTextRevision:head,instanceId,mentionId:occurrence.reference.mentionId,serverCandidate:'bob',actualMentionActor:'alice',nestedReferenceIndexed:true,unchangedReferenceDidNotEmitEvent:true,remindersDisabled:true,body:entry().node.textContent},null,2))
 return head
}
async function exerciseInlineBlocks(client:Client,registry:InlineContainerRegistry,instanceId:string){
 const position=(owner:Client,id:string)=>{let found:{position:number;node:PmNode}|undefined;owner.state().doc.descendants((node,at)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===id)found={position:at,node}});assert.ok(found);return found}
 const target=(id:string)=>{const at=position(client,id);const entry=rootBlocks(client.state().doc).find(entry=>at.position>entry.from&&at.position<entry.to);assert.ok(entry);return blockTarget(client.state(),[entry])!}
 const run=(action:string,id:string,input?:unknown)=>{const prepared=prepareBlockTransaction(commandEditor(client),action,input,target(id));assert.ok(prepared,action);assert.ok(prepared(),action)}
 // Create a genuine nested body and share the already verified archived file.
 let at=position(client,instanceId);client.dispatch(client.state().tr.setSelection(TextSelection.create(client.state().doc,at.position+1)))
 const nested=prepareInlineContainerTransaction(commandEditor(client),registry,'node.insert',{model:'inline',type:commandDefinition().type,resources:at.node.attrs.extension.resources});assert.ok(nested?.commit());const inner=selectedInlineContainer(client.state())!;client.dispatch(client.state().tr.insertText('嵌套字段正文',inner.position+1))
 client.store.insert([schema.nodes.paragraph.createChecked(null,schema.text('Block neighbor'))],null)
 await saved(client)
 const original=client.store.flow.containers!.bodies.get(instanceId)!,originalItems=retainedItems(original),oldIds=new Set(inlineContainerNodes(client.state().doc).keys())
 run('block.duplicate',instanceId);const created=[...inlineContainerNodes(client.state().doc).keys()].filter(id=>!oldIds.has(id));assert.equal(created.length,2);const copyId=created.find(id=>client.store.flow.containers!.readBody(id).textContent.includes('AI采纳'));assert.ok(copyId);const copied=await saved(client)
 const originalKey=target(instanceId).from,originalCanonical=client.state().doc.nodeAt(originalKey)!.attrs.hcdBlockId
 run('block.move',instanceId,{destination:client.state().doc.content.size});const moved=await saved(client);assert.equal(client.state().doc.nodeAt(target(instanceId).from)!.attrs.hcdBlockId,originalCanonical)
 run('block.heading',instanceId);await saved(client);run('block.bulletList',copyId);await saved(client);run('block.quote',copyId);const converted=await saved(client)
 assert.equal(client.store.flow.containers!.bodies.get(instanceId),original);assert.deepEqual(retainedItems(original),originalItems)
 const peer=await connect('bob');peer.installInteractions(registry);peer.provider.disconnect();const peerAt=position(peer,copyId);peer.dispatch(peer.state().tr.insertText(' 同伴块保留',peerAt.position+peerAt.node.nodeSize-1))
 const history=client.store.undoManager(true,before=>prepareInlineContainerHistoryGuard(before,registry.resolve))
 let restored:number
 try{run('block.delete',copyId);await saved(client);peer.provider.connect();await until(()=>!peer.provider.hasUnsyncedChanges&&peer.store.project().eq(client.store.project()),'late copied-body input')
  assert.ok(history.undo());await until(()=>peer.store.project().eq(client.store.project()),'block undo restored peer body');assert.match(client.store.flow.containers!.readBody(copyId).textContent,/同伴块保留/);restored=await saved(client)
  const bytes=Y.encodeStateAsUpdate(client.document);assert.throws(()=>history.redo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(client.document),bytes)
 }finally{history.destroy()}
 const refs=await info('/references?locations=true');assert.equal(refs.reminders.enabled,false)
 await writeFile(join(c.root,'block-evidence.json'),JSON.stringify({scope:'Production block commands/PM binding with real native/socket checkpoints; no browser drag claim',copied,moved,converted,restored,instanceId,copyId,createdIds:created,newContainerIdentities:2,sharedArchivedResourcesPreserved:true,originalCarrierAndItemsRetained:true,peerBodyRetainedByOwnUndo:true,destructiveRedoRefused:true,remindersDisabled:true,body:client.store.flow.containers!.readBody(copyId).textContent},null,2))
 return restored
}
async function resumeNodeFile(client:Client){
 const raw=JSON.parse(await readFile(join(c.root,'node-file-choice.json'),'utf8')),draft:WordNodeResourceDraft<ResourceNodePayload>={...raw,bytes:Uint8Array.from(raw.bytes),phase:'chosen'},files=await fileClient(),registry=new InlineContainerRegistry([{...commandDefinition(),version:2}]),release=registry.connect()
 try{
  // Import private bytes into a fresh IndexedDB engine after process restart.
  // This tests the client, not browser persistence or recovery-package UI.
  await files.cache.importNodeResources([draft]);await files.client.refresh();assert.equal(files.uploads(),0);assert.ok(files.client.state().pending)
  let position:number|undefined;client.state().doc.descendants((node,pos)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===draft.expected.instanceId)position=pos});assert.ok(position!==undefined);client.dispatch(client.state().tr.setSelection(NodeSelection.create(client.state().doc,position)))
  const current=selectedInlineContainer(client.state())!,body=client.store.flow.containers!.bodies.get(current.value.instanceId)!,items=retainedItems(body)
  await files.client.attach(draft.id,async staged=>{const prepared=prepareInlineContainerTransaction(commandEditor(client),registry,'node.resources',{instanceId:current.value.instanceId,expected:current.value,resources:[...(current.value.resources??[]),staged.resource]});assert.ok(prepared);assert.ok(prepared.commit());materializeInlineContainerEdits(client.document,registry);return prepared.value!})
  assert.equal(files.client.state().pending,false);assert.deepEqual(await files.cache.pendingNodeResources(),[]);assert.deepEqual(retainedItems(body),items);const downloaded=await readNodeResource(session,draft.resource);assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()),draft.bytes)
  await writeFile(join(c.root,'node-files-evidence.json'),JSON.stringify({scope:'Actual native HTTP upload/read + fresh process + fake-indexeddb task import + normal PM command/Socket save; browser persistence not claimed',resource:draft.resource,bytes:Array.from(draft.bytes),model:draft.expected.schemaVersion,reloadDidNotUpload:true,explicitCommandLinked:true,bodyItemsUnchanged:true,devicePendingClearedAfterCommand:true},null,2))
 }finally{release();await files.close()}
}
function start(client:Client,id:string){let pos:number|undefined;client.state().doc.descendants((node,p)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===id)pos=p+1});assert.ok(pos!==undefined);return pos}
async function saved(client:Client){
 await until(()=>!client.provider.hasUnsyncedChanges,'all writes acknowledged')
 const reply=await requestCoordinatedSave(client.provider,await checkpointDigest(jsonToSnapshot(client.store.project().toJSON(),models)),undefined,45000,await imageDraftDigest(client.document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);assert.equal(reply.inlineContainers,1)
 await until(async()=>{const p=await info('/editor');return p.revision===reply.revision},'canonical saved')
 const projection=await info('/editor');assert.equal(await checkpointDigest(jsonToSnapshot(projectionToJson(projection,models),models)),await checkpointDigest(jsonToSnapshot(client.store.project().toJSON(),models)))
 const metadata=JSON.parse(await readFile(join(c.root,'collaboration/inline-native.epoch'),'utf8')),bytes=await readFile(join(c.root,`collaboration/inline-native.epoch-${metadata.epoch}.${metadata.migration.id}.bin`)),persisted=new Y.Doc({gc:false})
 try{Y.applyUpdate(persisted,bytes);const [body,signature]=String(persisted.getMap('hcdSave').get('receipt')).split('.'),raw=Buffer.from(body,'base64url'),mac=createHmac('sha256',c.secret).update(raw).digest(),actual=Buffer.from(signature,'base64url');assert.equal(mac.length,actual.length);assert.ok(timingSafeEqual(mac,actual));assert.equal(JSON.parse(raw.toString()).revision,reply.revision)}finally{persisted.destroy()}
 return reply.revision!
}
try{
 await connect('alice',false)
 let recovered:Y.Doc|undefined
 if(c.draftRecovery&&phase==='resume'){
  const cached=new Y.Doc({gc:false}),factory=new IDBFactory();Y.applyUpdate(cached,new Uint8Array(await readFile(join(c.root,'device-draft.yjs'))))
  try{deviceJournal=await LocalDraftJournal.open(await draftIdentity(session,'alice','http://fixture.invalid'),factory);await deviceJournal.bind(cached);await deviceJournal.flush();await deviceJournal.compact();const reloaded=await deviceJournal.load(),canonical=await readServerDraft(session,new AbortController().signal)
   assert.ok(canonical);try{recovered=restoreLocalDraft(reloaded,canonical);assert.equal(recovered.gc,false);assert.equal(localDocumentProtocol(recovered),inlineProtocol);assert.match(localDraftPreview(recovered),/Device离线/);assert.match(localDraftPreview(recovered),/Peer在线/)}finally{reloaded.destroy();canonical.destroy()}
  }finally{cached.destroy()}
 }
 const alice=await connect('alice',true,recovered)
 // A live inline room must not be mistaken for a legacy room blocking bootstrap.
 assert.equal((await negotiate()).status,200)
 const bob=await connect('bob'),reader=await connect('reader');let chosen:string|undefined
 alice.state().doc.descendants(node=>{if(!chosen&&node.type.name==='hcdExtensionInlineContainer')chosen=node.attrs.extension.instanceId});assert.ok(chosen)
 if(phase==='prepare'){
  const history=alice.store.undoManager(false),original=alice.store.flow.containers!.readBody(chosen).textContent
  try{
   bob.provider.disconnect();await until(()=>bob.provider.configuration.websocketProvider.status==='disconnected','Bob offline')
   alice.dispatch(alice.state().tr.insertText('Alice真实协同 ',start(alice,chosen)));history.stopCapturing()
   bob.dispatch(bob.state().tr.insertText('Bob迟到输入 ',start(bob,chosen)));await bob.provider.connect()
   await until(()=>alice.store.project().eq(bob.store.project())&&alice.store.flow.containers!.readBody(chosen!).textContent.includes('Bob迟到输入 '),'late input converged')
   assert.ok(history.undo());await until(()=>!alice.provider.hasUnsyncedChanges&&bob.store.flow.containers!.readBody(chosen!).textContent===`Bob迟到输入 ${original}`,'personal undo preserves Bob')
   assert.ok(history.redo());await until(()=>alice.store.project().eq(bob.store.project()),'redo convergence')
   let head=await saved(alice)
   if(c.commands)head=await exerciseCommands(alice)
   if(c.draftRecovery){
    await until(()=>!bob.provider.hasUnsyncedChanges&&bob.store.project().eq(alice.store.project()),'Bob has canonical baseline')
    const device=new Y.Doc({gc:false});Y.applyUpdate(device,Y.encodeStateAsUpdate(alice.document));const local=new SemanticBlockStore(device,schema,undefined,models),journal=await LocalDraftJournal.open(await draftIdentity(session,'alice','http://fixture.invalid'),new IDBFactory())
    try{await journal.bind(device);local.flow.containers!.bodies.get(chosen)!.insert(0,'Device离线 ');await journal.flush();await journal.compact();const durable=await journal.load();try{assert.equal(durable.gc,false);await writeFile(join(c.root,'device-draft.yjs'),Y.encodeStateAsUpdate(durable),{mode:0o600})}finally{durable.destroy()}}finally{journal.close();device.destroy()}
    bob.dispatch(bob.state().tr.insertText('Peer在线 ',start(bob,chosen)));head=await saved(bob)
   }
   const readonly=await requestCoordinatedSave(reader.provider,await checkpointDigest(jsonToSnapshot(reader.store.project().toJSON(),models)),undefined,45000,await imageDraftDigest(reader.document));assert.equal(readonly.status,'failed');assert.equal(readonly.conflict,'read-only')
   const attacker=await connect('bob'),before=alice.store.project().toJSON(),definitions=attacker.document.getMap<any>(inlineContainerFields.definitions),definition=definitions.get(chosen)
   definitions.set(chosen,{...definition,node:{...definition.node,attrs:{...definition.node.attrs,extension:{...definition.node.attrs.extension,data:{forged:true}}}}})
   await until(()=>attacker.events.closed,'invalid packet disconnected');attacker.provider.disconnect();assert.deepEqual(alice.store.project().toJSON(),before)
   await writeFile(join(c.root,'prepare-evidence.json'),JSON.stringify({scope:'Actual sidecar.ts Hocuspocus sockets + native HTTP + real PM binding; optional device storage uses fake-indexeddb, not browser UI',head,chosen,text:alice.store.flow.containers!.readBody(chosen).textContent,missingAckRejected:true,secondNegotiationWhileLive:true,offlineLateInput:true,personalUndoPreservedPeer:true,redoConverged:true,readOnlySaveDenied:true,forgedDefinitionRejected:true,persistedHmacVerified:true,offlineDeviceDraftRetained:!!c.draftRecovery,errors:[...alice.errors,...bob.errors,...reader.errors]},null,2));assert.deepEqual([...alice.errors,...bob.errors,...reader.errors],[])
  }finally{history.destroy()}
 }else{
  const previous=JSON.parse(await readFile(join(c.root,'prepare-evidence.json'),'utf8')),restoredText=alice.store.flow.containers!.readBody(chosen).textContent;assert.equal(c.draftRecovery?restoredText.replace('Device离线 ', ''):restoredText,previous.text)
  if(c.commands){const command=JSON.parse(await readFile(join(c.root,'command-evidence.json'),'utf8')),node=alice.store.flow.containers!.readBody(command.instanceId);assert.equal(node.attrs.extension.version,2);assert.equal(node.attrs.extension.data.title,command.title);assert.equal(node.textContent,command.body)}
  if(c.nodeFiles)await resumeNodeFile(alice)
  alice.dispatch(alice.state().tr.insertText('Restart后 ',start(alice,chosen)));await until(()=>alice.store.project().eq(bob.store.project()),'restart input');const head=await saved(alice);assert.ok(head>previous.head)
  await writeFile(join(c.root,'resume-evidence.json'),JSON.stringify({scope:'Actual sidecar process restart and canonical/durable reload; optional IndexedDB engine is simulated, UI not activated',head,chosen,text:alice.store.flow.containers!.readBody(chosen).textContent,restartedBaselineMatched:true,persistedHmacVerified:true,deviceRecoveryThroughSharedClient:!!c.draftRecovery,ordinaryModelRejectedBeforeMigration:!!c.draftRecovery,errors:[...alice.errors,...bob.errors]},null,2));assert.deepEqual([...alice.errors,...bob.errors],[])
 }
 console.log('PASS inline room '+phase)
}finally{deviceJournal?.close();for(const item of clients){item.close?.();item.provider.disconnect();item.provider.destroy();await item.provider.configuration.websocketProvider.destroy();item.document.destroy()}}
