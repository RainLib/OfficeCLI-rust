import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {regionalExampleNodes} from '../examples/hdoc/editor/src/examples/regionalNodes.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {extensionEditIndex,materializeExtensionEdits} from '../examples/hdoc/editor/src/extensionEdits.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'

const c=JSON.parse(await readFile(process.argv[2],'utf8'));assert.equal(c.nodesFixture,true)
const schema=wordRegionSchema(),registry=new NodeExtensionRegistry(regionalExampleNodes),disconnectRegistry=registry.connect(),clients:Array<{document:Y.Doc;provider:HocuspocusProvider;model:WordRegionStore}>=[]
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,35))}throw new Error('Timeout: '+label)}
async function native(route:string){const response=await fetch(c.apiUrl+route,{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'}});assert.equal(response.status,200);return response.json()}
const initial=await native('/editor'),body=initial.flowLayout.sections[0].id
async function refresh(client:typeof clients[number]){const hash=client.document.getMap(wordRegionStoreField).get('layoutHash');if(hash!==client.model.layoutState().layoutHash){const projection=await native('/editor');if(projection.flowLayoutHash!==hash)return false;client.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)}return true}
async function connect(person:'alice'|'bob'){
 const document=new Y.Doc(),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${c.collabPort}?hcdNodeEdits=7&hcdWordRegions=1`,name:'rich:1:wordregions1:save5',token:c[person],document,WebSocketPolyfill:WebSocket}),model=new WordRegionStore(document,schema,'rich',initial.flowLayout,initial.flowLayoutHash),client={document,provider,model};clients.push(client)
 await until(async()=>provider.isSynced&&!provider.hasUnsyncedChanges&&document.getMap(wordRegionStoreField).size>0&&await refresh(client),'regional member');return client
}
async function sync(){
 await until(async()=>{if(!clients.every(client=>client.provider.isSynced&&!client.provider.hasUnsyncedChanges))return false;if(!(await Promise.all(clients.map(refresh))).every(Boolean))return false;for(const client of clients)materializeExtensionEdits(client.document,registry);return clients.every(client=>client.model.contents()===clients[0].model.contents()&&!client.provider.hasUnsyncedChanges)},'business intents and fallback')
}
function update(client:typeof clients[number],id:string,data:Record<string,unknown>){
 const doc=client.model.project(body),entry=extensionNodes(doc).get(id)!;assert.ok(entry)
 const value=registry.update(entry.value,{...entry.value.data,...data}),node=doc.nodeAt(entry.position)!,tr=EditorState.create({schema,doc}).tr.setNodeMarkup(entry.position,undefined,{...node.attrs,extension:value})
 const before=client.model.region(body);client.model.reconcile(body,before,tr.doc.content.content.map((node,index)=>({key:before[index].key,node})))
}
async function request(client:typeof clients[number]){return requestCoordinatedSave(client.provider,createHash('sha256').update(client.model.contents()).digest('hex'),undefined,30000,await imageDraftDigest(client.document))}
async function save(client:typeof clients[number]){await sync();const result=await request(client);assert.equal(result.status,'saved',JSON.stringify(result));assert.equal(result.pending,false);await sync();return result.revision!}
try{
 const alice=await connect('alice'),bob=await connect('bob'),node=[...extensionNodes(alice.model.project(body)).values()].find(entry=>entry.value.type==='example.status')!.value,id=node.instanceId,history=alice.model.structure.undoManager();assert.ok(id)
 history.stopCapturing();update(alice,id,{label:'协同标签'});history.stopCapturing();update(bob,id,{owner:'Bob 李'});await sync()
 let value=extensionNodes(alice.model.project(body)).get(id)!.value;assert.equal(value.data.label,'协同标签');assert.equal(value.data.owner,'Bob 李');assert.equal(Object.keys(extensionEditIndex(alice.document).get(id)!.conflicts).length,0)
 const merged=await save(alice);assert.ok(history.undo());await sync();value=extensionNodes(alice.model.project(body)).get(id)!.value;assert.equal(value.data.label,node.data.label);assert.equal(value.data.owner,'Bob 李');const undone=await save(alice)
 assert.ok(history.redo());await sync();value=extensionNodes(alice.model.project(body)).get(id)!.value;assert.equal(value.data.label,'协同标签');assert.equal(value.data.owner,'Bob 李');const redone=await save(alice);history.destroy()
 // Both calls run before either member can receive the other's packet.
 update(alice,id,{label:'候选 A'});update(bob,id,{label:'候选 B'});await sync();const group=extensionEditIndex(alice.document).get(id)!;assert.equal(group.conflicts.label.length,2)
 const blocked=await request(alice);assert.equal(blocked.pending,true);assert.equal(blocked.problem,'node-drafts-conflict');assert.equal((await native('')).revision,redone)
 const evidence={scope:'Two actual local WebSocket members, production sidecar/native checkpoint; no browser or remote-store claim for the concurrent scheduling.',initialRevision:initial.revision,fieldMergeRevision:merged,ownUndoRevision:undone,ownRedoRevision:redone,ownUndoRetainedPeerOwner:true,sameFieldCandidatesRetained:true,conflictBlockedCheckpoint:true,head:redone,instanceId:id,candidates:group.conflicts.label.map(choice=>choice.value)}
 await writeFile(c.root+'/nodes-socket-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{disconnectRegistry();for(const client of clients){client.provider.destroy();client.document.destroy()}}
