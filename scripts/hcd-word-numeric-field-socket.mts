/** Actual sidecar/native checks; deliberately makes no browser interaction claim. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {wordBrowserConnection} from '../examples/hdoc/editor/src/wordBrowserProtocol.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {wordNumericFieldDefinition,wordNumericFieldType} from '../examples/hdoc/editor/src/wordNumericField.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {materializeExtensionEdits} from '../examples/hdoc/editor/src/extensionEdits.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import type {Session} from '../examples/hdoc/editor/src/api.ts'

const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);assert.equal(c.clean,true)
const schema=wordRegionSchema(),registry=new NodeExtensionRegistry([wordNumericFieldDefinition]),release=registry.connect(),clients:Array<{document:Y.Doc;provider:HocuspocusProvider;model:WordRegionStore}>=[]
const wait=async(check:()=>boolean|Promise<boolean>,label:string)=>{const deadline=Date.now()+30_000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Timed out: '+label)}
async function native(route:string){const response=await fetch(`${c.origin}/v1/documents/${c.documentId}${route}`,{headers:{Authorization:`Bearer ${c.reader}`,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'},signal:AbortSignal.timeout(30_000)});assert.equal(response.status,200);return response.json()}
const initial=await native('/editor'),body=initial.flowLayout.sections[0].id,header=initial.blocks.find((block:any)=>block.region==='header'&&!block.readOnly&&block.content.kind==='paragraph').flowRegionId,resume=process.argv[4]==='--resume-header'
async function connect(person:'alice'|'bob'){
 const session={documentId:c.documentId,token:c[person],scope:'write',format:'docx',collabUrl:`ws://127.0.0.1:${c.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'} as Session,connection=wordBrowserConnection(session),document=new Y.Doc(),provider=new HocuspocusProvider({...connection,document,token:session.token,WebSocketPolyfill:WebSocket}),model=new WordRegionStore(document,schema,c.documentId,initial.flowLayout,initial.flowLayoutHash),client={document,provider,model};clients.push(client)
 await wait(()=>provider.isSynced&&!provider.hasUnsyncedChanges&&document.getMap(wordRegionStoreField).size>0,'member sync');return client
}
async function sync(){await wait(()=>{for(const client of clients)materializeExtensionEdits(client.document,registry);return clients.every(client=>client.provider.isSynced&&!client.provider.hasUnsyncedChanges&&client.model.contents()===clients[0].model.contents())},'joint content')}
function edit(client:typeof clients[number],regionId:string,transform:(state:EditorState)=>any){const before=client.model.region(regionId),state=EditorState.create({schema,doc:client.model.project(regionId)}),tr=transform(state);client.model.reconcile(regionId,before,tr.doc.content.content.map((node:any,index:number)=>({key:before[index]?.key,node})))}
function update(client:typeof clients[number],id:string,data:Record<string,unknown>){edit(client,body,state=>{const entry=extensionNodes(state.doc).get(id)!;assert.ok(entry);return state.tr.setNodeMarkup(entry.position,undefined,{...state.doc.nodeAt(entry.position)!.attrs,extension:registry.update(entry.value,{...entry.value.data,...data})})})}
async function save(client:typeof clients[number]){await sync();const reply=await requestCoordinatedSave(client.provider,createHash('sha256').update(client.model.contents()).digest('hex'),undefined,30_000,await imageDraftDigest(client.document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);await sync();return reply.revision!}
try{
 const alice=await connect('alice'),bob=await connect('bob'),entry=[...extensionNodes(alice.model.project(body)).values()].find(item=>item.value.type===wordNumericFieldType)!,id=entry.value.instanceId,history=alice.model.structure.undoManager()
 assert.ok(entry);let merged:number,undone:number,redone:number
 if(resume){
  assert.equal(initial.revision,7);merged=5;undone=6;redone=7
  for(const [revision,kind]of [[merged,'NUMPAGES'],[undone,'PAGE'],[redone,'NUMPAGES']] as const){const state=await native(`/editor?revision=${revision}`),inlines=state.blocks.flatMap((block:any)=>block.content.inlines);assert.equal(inlines.find((inline:any)=>inline.extension?.instanceId===id).extension.data.kind,kind);assert.match(inlines.map((inline:any)=>inline.text).join(''),/Bob 页码协同/)}
 }else{
  assert.deepEqual(entry.value.data,{kind:'PAGE',format:'upperRoman'})
  history.stopCapturing();update(alice,id,{kind:'NUMPAGES'});history.stopCapturing();await sync()
  edit(bob,body,state=>state.tr.insertText('Bob 页码协同 ',1));await sync();merged=await save(alice)
  assert.ok(history.undo());await sync();assert.match(alice.model.project(body).textContent,/Bob 页码协同/);assert.equal(extensionNodes(alice.model.project(body)).get(id)!.value.data.kind,'PAGE');undone=await save(alice)
  assert.ok(history.redo());await sync();assert.match(alice.model.project(body).textContent,/Bob 页码协同/);assert.equal(extensionNodes(alice.model.project(body)).get(id)!.value.data.kind,'NUMPAGES');redone=await save(alice)
 }
 const sectionNode=registry.create(wordNumericFieldType,{kind:'SECTIONPAGES',format:'arabic'});history.stopCapturing();edit(alice,header,state=>{assert.equal(state.doc.firstChild!.type.name,'paragraph');return state.tr.insert(state.doc.firstChild!.nodeSize-1,schema.nodes.hcdExtensionInline.create({extension:sectionNode}))});await sync();const withHeader=await save(alice)
 const final=await native('/editor');assert.equal(final.revision,withHeader);const values=final.blocks.flatMap((block:any)=>block.content.inlines.filter((inline:any)=>inline.extension).map((inline:any)=>({region:block.region,id:inline.extension.instanceId,data:inline.extension.data})));assert.equal(values.length,2);assert.ok(values.some((value:any)=>value.region==='header'&&value.data.kind==='SECTIONPAGES'))
 await writeFile(out+'/socket-final-projection.json',JSON.stringify(final,null,2)+'\n');const evidence={scope:'Actual two-member WebSocket service/native save; no browser, device backup or cross-device claim',initialRevision:resume?4:initial.revision,resumedAfterReadonlyTargetFixtureFailure:resume,merged,undone,redone,withHeader,ownUndoPreservedPeer:true,ownRedoPreservedPeer:true,fields:values};await writeFile(out+'/socket.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));history.destroy()
}finally{release();for(const client of clients){client.provider.destroy();client.document.destroy()}}
