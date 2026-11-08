import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {extensionEditIndex,materializeExtensionEdits} from '../examples/hdoc/editor/src/extensionEdits.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {nodeSdkFixture} from '../examples/hdoc/editor/fixtures/nodeSdk.ts'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),registry=new NodeExtensionRegistry(nodeSdkFixture),base=config.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+config.alice}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Timeout: '+label)}
const authority=await(await fetch(`http://127.0.0.1:${config.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers})).json();assert.equal(authority.nodeEditVersion,4)
const name=`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,url=nodeEditCollaborationUrl(`ws://127.0.0.1:${config.ports[1]}`),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),providers:HocuspocusProvider[]=[]
try{
 const pa=new HocuspocusProvider({url,name,document:a,token:config.alice,WebSocketPolyfill:WebSocket}),pb=new HocuspocusProvider({url,name,document:b,token:config.bob,WebSocketPolyfill:WebSocket});providers.push(pa,pb);await until(()=>pa.isSynced&&pb.isSynced&&sa.initialized&&sb.initialized&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges,'initial clients')
 const before=(await(await fetch(base,{headers})).json()).revision;assert.equal(before,3)
 pa.disconnect();pb.disconnect();await until(()=>pa.configuration.websocketProvider.status==='disconnected'&&pb.configuration.websocketProvider.status==='disconnected','both sockets offline')
 const edit=(store:SemanticBlockStore,type:string,data:Record<string,unknown>)=>{const blocks=store.blocks(),doc=store.project(),entry=[...extensionNodes(doc).values()].find(entry=>entry.value.type===type)!;assert.ok(entry);const value=registry.update(entry.value,{...entry.value.data,...data}),tr=EditorState.create({schema,doc}).tr.setNodeMarkup(entry.position,undefined,{...doc.nodeAt(entry.position)!.attrs,extension:value});store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 edit(sa,'example.task',{title:'Alice 并发候选'});edit(sb,'example.task',{title:'Bob 并发候选'});edit(sa,'example.notice',{title:'并发合并提示'});edit(sb,'example.notice',{done:true})
 pa.connect();pb.connect();await until(()=>pa.isSynced&&pb.isSynced&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges&&extensionEditIndex(a).size===2&&[...extensionEditIndex(a).values()].every(g=>g.ids.length===2),'offline merge');materializeExtensionEdits(a,registry);await until(()=>!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges,'materialization synchronized')
 const groups=[...extensionEditIndex(a).values()],task=groups.find(g=>g.root.type==='example.task')!,notice=groups.find(g=>g.root.type==='example.notice')!;assert.equal(task.conflicts.title.length,2);assert.deepEqual(new Set(task.conflicts.title.map(c=>c.value)),new Set(['Alice 并发候选','Bob 并发候选']));assert.deepEqual(notice.data,{title:'并发合并提示',done:true,priority:1});assert.equal(notice.value.fallback.text,'☑ 并发合并提示');assert.equal(extensionNodes(sa.project()).size,4);assert.equal(extensionNodes(sb.project()).size,4)
 const rejected=await requestCoordinatedSave(pa,await checkpointDigest(jsonToSnapshot(sa.project().toJSON())),undefined,30000,await imageDraftDigest(a));assert.equal(rejected.problem,'node-drafts-conflict');assert.equal((await(await fetch(base,{headers})).json()).revision,before)
 // An old wire client cannot join even if it has a valid write token.
 let denied=false;const old=new HocuspocusProvider({url:`ws://127.0.0.1:${config.ports[1]}`,name,document:new Y.Doc(),token:config.alice,WebSocketPolyfill:WebSocket,onAuthenticationFailed:()=>{denied=true}});providers.push(old);await until(()=>denied,'old-model denial');old.destroy()
 const evidence={schemaVersion:'hcd-node-conflict-socket/1',scope:'Two real local WebSocket clients disconnect, independently edit the same initial values, reconnect, and request canonical save. UI resolution is verified separately.',baselineRevision:before,validation:{offlineSameFieldCandidatesRetained:true,offlineDisjointFieldsMerged:true,matchingReadableFallbackMaterialized:true,fourUniqueOccurrencesNoInlineDuplication:true,canonicalSaveBlockedWhileConflicted:true,canonicalRevisionUnchanged:true,unawareWireClientRejected:true},taskId:task.root.instanceId,noticeId:notice.root.instanceId};await writeFile(config.root+'/node-conflict-socket.json',JSON.stringify(evidence,null,2));await writeFile(new URL('../docs/assets/hcd-extensions-2026-10-24/node-conflict-socket-evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log('PASS real offline field merging, retained conflicts, canonical save fence and old-client denial')
}finally{providers.forEach(p=>p.destroy());a.destroy();b.destroy()}
