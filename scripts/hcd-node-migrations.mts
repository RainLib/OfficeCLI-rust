import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry,stableExtension} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {extensionEditIndex,nodeEditStatus,nodeEnvelopeField,resolveExtensionEdits} from '../examples/hdoc/editor/src/extensionEdits.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {nodeMigrationsFixture} from '../examples/hdoc/editor/fixtures/nodeMigrations.ts'
import {nodeSdkFixture} from '../examples/hdoc/editor/fixtures/nodeSdk.ts'
import type {ExtensionNodePayload} from '../examples/hdoc/editor/src/extensionTypes.ts'

const config=JSON.parse(await readFile(process.argv[2],'utf8')),base=config.origin+'/v1/documents/mentions-docx',headers={'X-HCD-Node-Edits-Version':'4',Authorization:'Bearer '+config.alice},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),registry=new NodeExtensionRegistry(nodeMigrationsFixture),older=new NodeExtensionRegistry(nodeSdkFixture)
async function request(path:string){const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,await response.clone().text());return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Timeout: '+label)}
const negotiation=await fetch(`http://127.0.0.1:${config.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers,signal:AbortSignal.timeout(45000)});assert.equal(negotiation.status,200,await negotiation.clone().text());const authority=await negotiation.json();assert.equal(authority.nodeEditVersion,4)
const name=`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,url=nodeEditCollaborationUrl(`ws://127.0.0.1:${config.ports[1]}`),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),providers:HocuspocusProvider[]=[]
const evidence:any={scope:'Isolated local native API + actual WebSocket. Deterministic trusted migration fixtures; not a production/multi-instance/real-device acceptance.',checks:{},revisions:[]}
const value=(store:SemanticBlockStore,type:string)=>[...extensionNodes(store.project()).values()].find(entry=>entry.value.type===type)!.value
function write(store:SemanticBlockStore,payload:ExtensionNodePayload){
 const blocks=store.blocks(),doc=store.project(),entry=extensionNodes(doc).get(payload.instanceId)!,node=doc.nodeAt(entry.position)!,{nodeId:_receipt,...fallback}=node.attrs.fallbackInline??{},tr=EditorState.create({schema,doc}).tr.setNodeMarkup(entry.position,undefined,{...node.attrs,extension:payload,...(payload.display==='block'?{fallbackInline:{...fallback,text:payload.fallback.text}}:{})})
 store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
}
try{
 const pa=new HocuspocusProvider({url,name,document:a,token:config.alice,WebSocketPolyfill:WebSocket}),pb=new HocuspocusProvider({url,name,document:b,token:config.bob,WebSocketPolyfill:WebSocket});providers.push(pa,pb)
 await until(()=>pa.isSynced&&pb.isSynced&&sa.initialized&&sb.initialized&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges,'two initial clients')
 if(process.argv[3]==='--read-only'){
  const expected=JSON.parse(await readFile(config.root+'/node-migration-socket-evidence.json','utf8')),last=expected.revisions.at(-1),head=(await request('')).revision
  assert.equal(head,expected.finalRevision)
  for(const store of [sa,sb]){assert.deepEqual(value(store,'example.task'),last.task);assert.deepEqual(value(store,'example.notice'),last.notice);assert.match(store.project().textContent,/Bob 普通正文保留/);assert.equal(nodeEditStatus(store.document,store.project()).conflicts.length,0);assert.equal(nodeEditStatus(store.document,store.project()).pending.length,0)}
  assert.equal((await request('')).revision,head)
  await writeFile('docs/assets/hcd-extensions-2026-10-24/node-migration-restart-evidence.json',JSON.stringify({scope:'Intentional restart of owned native API, sidecar and Vite, followed by two fresh real WebSocket clients. No browser or live PostgreSQL claim.',revision:head,checks:{bothMigratedPayloadsRestored:true,peerTextRestored:true,noPendingOrConflict:true,readbackDidNotPublish:true}},null,2)+'\n')
  console.log('PASS owned service restart and two fresh read-only socket clients')
 }else{
 const before=(await request('')).revision;assert.equal(before,3)
 const original=[...extensionNodes(sa.project()).values()].map(entry=>entry.value),task=value(sa,'example.task'),notice=value(sa,'example.notice'),unchanged=Y.encodeStateAsUpdate(a)
 const preview=registry.previewMigration(task)!
 assert.deepEqual(Y.encodeStateAsUpdate(a),unchanged);assert.equal(preview.before.version,1);assert.equal(preview.after.version,2);assert.equal((await request('')).revision,before)
 const undo=sa.undoManager();undo.stopCapturing()
 pa.disconnect();pb.disconnect();await until(()=>pa.configuration.websocketProvider.status==='disconnected'&&pb.configuration.websocketProvider.status==='disconnected','both disconnected')
 write(sa,preview.after);undo.stopCapturing();write(sa,registry.previewMigration(notice)!.after);undo.stopCapturing()
 write(sb,older.update(task,{...task.data,title:'Bob 迁移前修改'}))
 const blocks=sb.blocks(),doc=sb.project(),tr=EditorState.create({schema,doc}).tr.insertText('Bob 普通正文保留 · ',1);sb.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
 pa.connect();pb.connect();await until(()=>pa.isSynced&&pb.isSynced&&!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges&&nodeEditStatus(a,sa.project()).conflicts.length===1&&nodeEditStatus(b,sb.project()).conflicts.length===1,'schema conflict replicated')
 const save=async()=>{await until(()=>!pa.hasUnsyncedChanges&&!pb.hasUnsyncedChanges,'all edits acknowledged');const reply=await requestCoordinatedSave(pa,await checkpointDigest(jsonToSnapshot(sa.project().toJSON())),undefined,45000,await imageDraftDigest(a));assert.equal(reply.nodeEditVersion,4);return reply}
 const blocked=await save();assert.equal(blocked.status,'failed');assert.equal(blocked.problem,'node-drafts-conflict');assert.equal((await request('')).revision,before);evidence.checks.conflictingMigrationCannotSave=true
 const group=extensionEditIndex(a).get(task.instanceId)!,previous=group.conflicts[nodeEnvelopeField].find(option=>(option.value as ExtensionNodePayload).version===1)!
 assert.equal(group.conflicts[nodeEnvelopeField].length,2)
 resolveExtensionEdits(a,registry,task.instanceId,group.ids,{[nodeEnvelopeField]:previous.intentId},semanticBlockOrigin);undo.stopCapturing();assert.equal(value(sa,'example.task').data.title,'Bob 迁移前修改')
 write(sa,registry.previewMigration(value(sa,'example.task'))!.after);undo.stopCapturing()
 await until(()=>value(sb,'example.task').version===2&&value(sb,'example.task').data.caption==='Bob 迁移前修改','explicit re-migration replicated')
 const publish=async(label:string)=>{const reply=await save();assert.equal(reply.status,'saved');assert.equal(reply.pending,false);evidence.revisions.push({label,revision:reply.revision,task:value(sa,'example.task'),notice:value(sa,'example.notice')});return reply.revision}
 await publish('upgraded');undo.undo();await until(()=>value(sb,'example.task').version===1,'own undo replicated');assert.match(sa.project().textContent,/Bob 普通正文保留/);await publish('undo')
 undo.redo();await until(()=>value(sb,'example.task').version===2,'own redo replicated');await publish('redo');undo.destroy()
 const final=[...extensionNodes(sa.project()).values()].map(entry=>entry.value);assert.equal(final.length,4);assert.equal(new Set(final.map(node=>node.instanceId)).size,4)
 for(const old of original){const next=final.find(node=>node.instanceId===old.instanceId)!;if(old.type==='example.future_card')assert.deepEqual(next,old);else{assert.equal(next.type,old.type);assert.equal(next.display,old.display);assert.equal(next.version,2)}}
 await until(async()=>{
  const response=await fetch(base+'/collaboration/state',{headers:{...headers,'X-HCD-Collaboration-Epoch':String(authority.collaborationEpoch),'X-HCD-Collaboration-Protocol':authority.collaborationProtocol},signal:AbortSignal.timeout(15000)})
  if(!response.ok)return false
  const restored=new Y.Doc();try{Y.applyUpdate(restored,new Uint8Array(await response.arrayBuffer()));const store=new SemanticBlockStore(restored,schema);return stableExtension(value(store,'example.task'))===stableExtension(value(sa,'example.task'))&&store.project().textContent.includes('Bob 普通正文保留')}finally{restored.destroy()}
 },'durable v2 shared state')
 evidence.checks={...evidence.checks,previewDoesNotMutate:true,stableIdsAcrossBothDisplays:true,unknownPayloadsUnchanged:true,oldSchemaEditPreservedByExplicitChoice:true,undoRedoPreservesPeerText:true,durableSharedStateReadback:true};evidence.finalRevision=(await request('')).revision;evidence.root=config.root
 await writeFile(config.root+'/node-migration-socket-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS schema migration, old-version conflict, explicit choice, own undo/redo, durable shared readback')
 }
}finally{providers.forEach(provider=>provider.destroy());a.destroy();b.destroy()}
