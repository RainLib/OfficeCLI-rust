import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {Fragment} from '../examples/hdoc/editor/node_modules/@tiptap/pm/model/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {documentReferences} from '../examples/hdoc/editor/src/referenceEdits.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
import {rootBlocks,blockTarget,transformBlocks} from '../examples/hdoc/editor/src/commands/blocks.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
import {structureSourceTargets} from '../examples/hdoc/editor/src/semanticStructureSources.ts'

const config=JSON.parse(await readFile(process.argv[2],'utf8')),mode=process.argv[3]??'prepare',schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),base=config.origin+'/v1/documents/mentions-docx',registry=new NodeExtensionRegistry(nodePortableFixture)
async function info(route=''){const response=await fetch(base+route,{headers:{Authorization:'Bearer '+config.alice,'X-HCD-Node-Edits-Version':'5'}});assert.equal(response.status,200);return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
const negotiated=await fetch(`http://127.0.0.1:${config.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers:{Authorization:'Bearer '+config.alice,'X-HCD-Node-Edits-Version':'5'}});assert.equal(negotiated.status,200);const auth=await negotiated.json();assert.equal(auth.nodeEditVersion,5)
const name=`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,url=nodeEditCollaborationUrl(`ws://127.0.0.1:${config.ports[1]}`),clients:Array<{document:Y.Doc;store:SemanticBlockStore;provider:HocuspocusProvider}>=[]
async function connect(user:'alice'|'bob',bytes?:Uint8Array){const document=new Y.Doc();if(bytes)Y.applyUpdate(document,bytes);const store=new SemanticBlockStore(document,schema),provider=new HocuspocusProvider({url,name,document,token:config[user],WebSocketPolyfill:WebSocket});clients.push({document,store,provider});await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'sync '+user);return{document,store,provider}}
async function save(client:Awaited<ReturnType<typeof connect>>){await until(()=>!client.provider.hasUnsyncedChanges,'ack');return requestCoordinatedSave(client.provider,await checkpointDigest(jsonToSnapshot(client.store.project().toJSON())),undefined,45000,await imageDraftDigest(client.document))}
async function persistEvidence(label:string,value:unknown){await writeFile(config.root+`/list-${label}.json`,JSON.stringify(value,null,2)+'\n');await writeFile(`docs/assets/hcd-list-recovery-2026-10-25/${label}.json`,JSON.stringify(value,null,2)+'\n')}
let undo:Y.UndoManager|undefined
try{
 if(mode==='prepare'){
  assert.equal((await info()).revision,1);const alice=await connect('alice');undo=alice.store.undoManager();const state=EditorState.create({schema,doc:alice.store.project()}),entry=rootBlocks(state.doc).find(entry=>entry.node.textContent==='Original')!,tr=state.tr;assert.ok(entry);assert.ok(transformBlocks(tr,'block.bulletList',undefined,blockTarget(state,[entry])!,registry));alice.store.reconcile(alice.store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));undo.stopCapturing();assert.equal((await save(alice)).revision,2)
  const wrapper=alice.store.blocks().find(block=>block.node.type.name==='bulletList')!.key,oldItem=alice.store.childKeys(wrapper)[0],bob=await connect('bob'),later=await connect('bob');bob.provider.disconnect();later.provider.disconnect();await until(()=>[bob,later].every(client=>client.provider.configuration.websocketProvider.status==='disconnected'),'offline')
  const bytes=await readFile(config.root+'/archived-image.png'),resource={key:'list-image',hash:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'image/png',name:'list-image.png'},extension=registry.create('example.resource_badge',{title:'列表资源'},[resource]),reference={type:'hcd.mention',version:1,mentionId:'m_'+crypto.randomUUID().replaceAll('-',''),target:{kind:'person',id:'bob'},snapshot:{label:'Bob 李'}}
  const before=bob.store.content(wrapper),item=schema.nodes.listItem.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('列表迟到新项 '),schema.nodes.hcdMention.createChecked({reference}),schema.text(' '),schema.nodes.hcdExtensionInline.createChecked({extension})])]);bob.store.update(wrapper,before,before.copy(before.content.append(Fragment.from(item))))
  const old=later.store.content(oldItem);later.store.update(oldItem,old,old.copy(old.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,schema.text('旧列表项迟到的新段'))))));await writeFile(config.root+'/list-later.bin',Y.encodeStateAsUpdate(later.document),{mode:0o600});await writeFile(config.root+'/list-identities.json',JSON.stringify({wrapper,oldItem,extension,reference,resource},null,2)+'\n',{mode:0o600})
  assert.ok(undo.undo());assert.equal((await save(alice)).revision,3);bob.provider.connect();await until(()=>bob.provider.isSynced&&!bob.provider.hasUnsyncedChanges&&deletionReviews(alice.store).length===1,'late review');const reply=await save(bob);assert.equal(reply.problem,'deletion-drafts-conflict');assert.equal((await info()).revision,3);const group=deletionReviews(alice.store)[0];assert.equal(group.node.childCount,1);assert.equal(extensionNodes(group.node).size,1);assert.equal(documentReferences(group.node).size,1)
  await persistEvidence('blocked-r3',{scope:'Real authenticated sockets/native sidecar; both offline edits originated after r2, no direct model replacement',revision:3,reply,wrapper,oldItem,review:group.node.toJSON(),extension,reference,resource,projectedTargets:structureSourceTargets(alice.store).length});console.log('PASS list2 undo3; late rich item retained and blocked before checkpoint. Restore in browser, then run later mode.')
 }else{
  assert.equal(mode,'later');assert.equal((await info()).revision,4);const identities=JSON.parse(await readFile(config.root+'/list-identities.json','utf8')),client=await connect('bob',new Uint8Array(await readFile(config.root+'/list-later.bin')));await until(()=>client.store.project().textContent.includes('旧列表项迟到的新段'),'old slot returns');assert.equal(deletionReviews(client.store).length,0);assert.equal(client.store.project().textContent.match(/Original/g)?.length,1);assert.equal(client.store.content(identities.wrapper).childCount,2);assert.equal(extensionNodes(client.store.project()).size,1);assert.equal(documentReferences(client.store.project()).size,1);const projected=jsonToSnapshot(client.store.project().toJSON());assert.equal(structureSourceTargets(client.store).length,projected.length);const reply=await save(client);assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);assert.equal(reply.revision,5);assert.equal((await info()).revision,5)
  const owners=client.store.projectedChildren(identities.wrapper,client.store.content(identities.wrapper)).map(item=>client.store.owners.get(item.key));assert.equal(new Set(owners).size,2);assert.deepEqual([...extensionNodes(client.store.project()).values()][0].value,identities.extension);assert.equal([...documentReferences(client.store.project()).keys()][0],identities.reference.mentionId)
  await persistEvidence('later-r5',{scope:'Real Bob offline updates from before undo, delivered after browser restoration/checkpoint4',revision:5,reply,stableBusinessAndMentionIdentity:true,listItems:2,originalTextCount:1,uniqueVisibleItemOwners:true,targets:structureSourceTargets(client.store),snapshot:projected});console.log('PASS late input into pruned old list item becomes an independent saved item5; rich node/mention/resource and original text retained')
 }
}finally{undo?.destroy();for(const client of clients){client.provider.disconnect();client.provider.destroy();await client.provider.configuration.websocketProvider.destroy();client.document.destroy()}}
