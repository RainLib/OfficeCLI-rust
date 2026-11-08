import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {Fragment} from '../examples/hdoc/editor/node_modules/@tiptap/pm/model/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot,sourceIdentityPlugin} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {prepareExtensionHistoryGuard} from '../examples/hdoc/editor/src/extensionHistory.ts'
import {CollaborativeImageDraftStore,imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {SemanticHistory} from '../examples/hdoc/editor/src/semanticHistory.ts'
import {extensionNodes,extensionPreservationPlugin} from '../examples/hdoc/editor/src/extensionNode.ts'
import {rootBlocks,blockTarget,transformBlocks} from '../examples/hdoc/editor/src/commands/blocks.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),mode=process.argv[3]??'bare',schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),base=c.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+c.alice,'X-HCD-Node-Edits-Version':'4'},registry=new NodeExtensionRegistry(),disconnectRegistry=registry.connect();let unregister=registry.register(nodePortableFixture)
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
async function info(path=''){const r=await fetch(base+path,{headers});assert.equal(r.status,200);return r.json()}
const response=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers});assert.equal(response.status,200);const auth=await response.json(),name=`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,url=nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),a=new Y.Doc(),sa=new SemanticBlockStore(a,schema),pa=new HocuspocusProvider({url,name,document:a,token:c.alice,WebSocketPolyfill:WebSocket}),undo=sa.undoManager(true,before=>prepareExtensionHistoryGuard(before,registry)),history=new SemanticHistory(new CollaborativeImageDraftStore(a),undo,()=>false,async()=>{throw Error('unexpected image')});const disconnectHistory=history.connect(),records:any[]=[];let pb:HocuspocusProvider|undefined,b:Y.Doc|undefined
async function save(provider:HocuspocusProvider,store:SemanticBlockStore,label:string,revision:number){await until(()=>!provider.hasUnsyncedChanges,'ack '+label);const reply=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(store.document));records.push({label,at:new Date().toISOString(),reply,head:(await info()).revision});await writeFile(c.root+'/checkpoint-repro.json',JSON.stringify({mode,records},null,2)+'\n');assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.revision,revision);assert.equal(reply.pending,false)}
try{
 await until(()=>pa.isSynced&&sa.initialized&&!pa.hasUnsyncedChanges,'Alice synced');assert.equal((await info()).revision,6)
 const state=EditorState.create({schema,doc:sa.project()}),target=blockTarget(state,rootBlocks(state.doc).filter(entry=>entry.node.attrs.extension?.type==='example.rich_callout'&&entry.node.attrs.extension.data.title==='团队记录'))!,tr=state.tr;assert.equal(transformBlocks(tr,'block.duplicate',undefined,target,registry),true);history.stopCapturing();sa.reconcile(sa.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));history.stopCapturing();await save(pa,sa,'copy',7)
 unregister();await assert.rejects(history.step('undo'),/historyExtensionUnavailable/);unregister=registry.register(nodePortableFixture);await history.step('undo');await save(pa,sa,'undo after reload',8);await history.step('redo');await save(pa,sa,'redo',9);unregister();await assert.rejects(history.step('undo'),/historyExtensionUnavailable/);history.skip('undo',history.snapshot())
 b=new Y.Doc();const sb=new SemanticBlockStore(b,schema);pb=new HocuspocusProvider({url,name,document:b,token:c.bob,WebSocketPolyfill:WebSocket});await until(()=>pb!.isSynced&&sb.initialized&&!pb!.hasUnsyncedChanges,'late Bob synced');assert.equal(extensionNodes(sb.project()).size,9)
 const tail=sb.blocks().find(block=>block.node.textContent==='容器后段')!,label=' · Bob 在扩展卸载后继续协作';assert.ok(tail);const before=jsonToSnapshot(sb.project().toJSON()),canonical=await info('/editor');await writeFile(c.root+'/checkpoint-repro-before.json',JSON.stringify({live:before,canonical},null,2)+'\n')
 if(mode==='bare')sb.update(tail.key,tail.node,tail.node.copy(tail.node.content.append(Fragment.from(schema.text(label)))))
 else{assert.equal(mode,'pm');const state=EditorState.create({schema,doc:sb.project(),plugins:[extensionPreservationPlugin(()=>{},()=>registry),sourceIdentityPlugin()]}),entry=rootBlocks(state.doc).find(entry=>entry.node.attrs.hcdStructureKey===tail.key)!,next=state.applyTransaction(state.tr.insertText(label,entry.to-1)).state.doc;sb.reconcile(sb.blocks(),next.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 await save(pb,sb,'Bob '+mode,10);console.log('PASS reproduction sequence including first Bob save',mode)
}finally{disconnectHistory();undo.destroy();disconnectRegistry();pa.disconnect();pa.destroy();await pa.configuration.websocketProvider.destroy();if(pb){pb.disconnect();pb.destroy();await pb.configuration.websocketProvider.destroy()}a.destroy();b?.destroy()}
