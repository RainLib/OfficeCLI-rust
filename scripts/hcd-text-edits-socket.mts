/** Owned real socket/native regression. No browser automation in this script. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHmac,timingSafeEqual} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState,TextSelection,type Transaction,type PluginView} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import type {EditorView} from '../examples/hdoc/editor/node_modules/@tiptap/pm/view/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot,projectionToJson} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../examples/hdoc/editor/src/semanticStructureBinding.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),assets='docs/assets/hcd-text-edits-2026-10-26',schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),clients:any[]=[],evidence:any[]=[],headers={'X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'}
async function info(route=''){const response=await fetch(c.origin+'/v1/documents/mentions-docx'+route,{headers:{...headers,Authorization:'Bearer '+c.alice}});assert.equal(response.status,200);return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
const initialProjection=await info('/editor');assert.equal(initialProjection.revision,1);assert.deepEqual(initialProjection.blocks.map((b:any)=>b.content.inlines.map((i:any)=>i.text).join('')),['AAA😀AAA','BBB']);const blockIds=initialProjection.blocks.map((b:any)=>b.blockId)
const negotiated=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers:{...headers,Authorization:'Bearer '+c.alice}});assert.equal(negotiated.status,200);const auth=await negotiated.json();assert.equal(auth.nodeEditVersion,7)
async function connect(user:'alice'|'bob'){
 const document=new Y.Doc({gc:false});document.clientID=user==='alice'?4000000001:4000000000;const store=new SemanticBlockStore(document,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name:`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,document,token:c[user],WebSocketPolyfill:WebSocket}),errors:unknown[]=[]
 const item:any={document,store,provider,user,errors};clients.push(item);await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'sync '+user)
 const plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)});let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}};binding=plugin.spec.view!(view as unknown as EditorView)
 Object.assign(item,{state:()=>state,dispatch:view.dispatch,close:()=>binding.destroy?.()});await until(()=>state.doc.eq(store.project()),'projection '+user);return item
}
function ids(text:Y.XmlText){const values:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)values.push(`${item.id.client}:${item.id.clock+i}`);return values}

let rootKeys:string[],original:string[][],aliceHistory:Y.UndoManager|undefined,bobHistory:Y.UndoManager|undefined
function currentIds(store:SemanticBlockStore,key:string){return ids(store.contents.get(key)!.get(0) as Y.XmlText)}
function rows(client:any){return client.store.blocks().map((block:any)=>block.node.textContent)}
function secondStart(tr:Transaction){return tr.doc.firstChild!.nodeSize+1}
async function saved(client:any,revision:number,expected:string[],label:string,offsets:number[],identityOnly=false){
 await until(()=>!client.provider.hasUnsyncedChanges,'ack '+label)
 const snapshot=jsonToSnapshot(client.store.project().toJSON()),reply=await requestCoordinatedSave(client.provider,await checkpointDigest(snapshot),undefined,45000,await imageDraftDigest(client.document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);assert.equal(reply.revision,revision)
 const canonical=await info('/editor');assert.equal(canonical.revision,revision);assert.deepEqual(canonical.blocks.map((b:any)=>b.blockId),blockIds);assert.deepEqual(canonical.blocks.map((b:any)=>b.content.inlines.map((i:any)=>i.text).join('')),expected);assert.deepEqual(rows(client),expected);assert.deepEqual(client.store.keys(),rootKeys)
 rootKeys.forEach((key,index)=>{const now=currentIds(client.store,key);assert.equal(now.indexOf(original[index][0]),offsets[index]);assert.deepEqual(now.filter(id=>original[index].includes(id)),original[index])})
 const meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`
 let bytes:Uint8Array
 await until(async()=>{
  bytes=new Uint8Array(await readFile(path));const loaded=new Y.Doc({gc:false});Y.applyUpdate(loaded,bytes)
  try{const persisted=new SemanticBlockStore(loaded,schema);return rootKeys.every((key,index)=>currentIds(persisted,key).indexOf(original[index][0])===offsets[index])}finally{loaded.destroy()}
 },'persist exact identity '+label)
 const loaded=new Y.Doc({gc:false});Y.applyUpdate(loaded,bytes!)
 try{
  const persisted=new SemanticBlockStore(loaded,schema),[body,signature]=String(loaded.getMap('hcdSave').get('receipt')).split('.'),raw=Buffer.from(body,'base64url'),actual=Buffer.from(signature,'base64url'),mac=createHmac('sha256',c.secret).update(raw).digest();assert.equal(mac.length,actual.length);assert.ok(timingSafeEqual(mac,actual));const receipt=JSON.parse(raw.toString('utf8'));assert.equal(receipt.revision,revision);assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(persisted.project().toJSON())));assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(projectionToJson(canonical))))
  assert.deepEqual(persisted.blocks().map(block=>block.node.textContent),expected)
  rootKeys.forEach((key,index)=>{const now=currentIds(persisted,key);assert.equal(now.indexOf(original[index][0]),offsets[index]);assert.deepEqual(now.filter(id=>original[index].includes(id)),original[index])})
 }finally{loaded.destroy()}
 await writeFile(c.root+`/text-edits-${evidence.length}-r${revision}.yjs`,bytes!,{mode:0o600});evidence.push({label,revision,rows:expected,originalOffsets:offsets,rootCount:2,identityOnly,canonicalOrderUnchanged:true,originalItemsRetainedExactly:true,signedPersistedReceiptAndCanonicalMatch:true});await writeFile(assets+'/socket-evidence.json',JSON.stringify({scope:'Real authenticated Hocuspocus sockets and production PM binding in a headless view; native signed checkpoints and fresh document reloads from actual persisted files. Composition metadata is programmatic, not a physical OS IME test.',wire:7,rootKeys,original,evidence},null,2)+'\n')
}
try{
 const alice=await connect('alice'),bob=await connect('bob');rootKeys=alice.store.keys();assert.equal(rootKeys.length,2);original=rootKeys.map(key=>currentIds(alice.store,key));await writeFile(c.root+'/text-edits-before.yjs',Y.encodeStateAsUpdate(alice.document),{mode:0o600});aliceHistory=alice.store.undoManager();bobHistory=bob.store.undoManager();bob.provider.disconnect();await until(()=>bob.provider.configuration.websocketProvider.status==='disconnected','Bob offline')
 const tr=alice.state().tr.insertText('AA',1);tr.insertText('AA',tr.doc.firstChild!.content.size+1);tr.insertText('BB',secondStart(tr));alice.dispatch(tr);aliceHistory.stopCapturing();await saved(alice,2,['AAAAA😀AAAAA','BBBBB'],'Alice multi-step edits in two roots; Bob offline',[2,2])
 const bt=bob.state().tr.insertText('Peer',2),at=secondStart(bt);bt.insertText('n',at).insertText('ni',at,at+1).insertText('你😀',at,at+2).setMeta('composition',9);bob.dispatch(bt);bobHistory.stopCapturing();await bob.provider.connect();await until(()=>bob.provider.isSynced&&!bob.provider.hasUnsyncedChanges&&alice.state().doc.textContent.includes('Peer'),'late Bob');await saved(bob,3,['AAAPeerAA😀AAAAA','你😀BBBBB'],'Late offline input and programmatic composition replacement',[2,5])
 assert.ok(aliceHistory.undo());await saved(alice,4,['APeerAA😀AAA','你😀BBB'],'Alice undo retains both Bob edits',[0,3]);assert.ok(aliceHistory.redo());await saved(alice,5,['AAAPeerAA😀AAAAA','你😀BBBBB'],'Alice redo retains both roots and Bob input',[2,5])
 await until(()=>rows(bob)[0]==='AAAPeerAA😀AAAAA','Bob sees redo');assert.ok(bobHistory.undo());await saved(bob,6,['AAAAA😀AAAAA','BBBBB'],'Bob undo retains all Alice edits',[2,2]);assert.ok(bobHistory.redo());await saved(bob,7,['AAAPeerAA😀AAAAA','你😀BBBBB'],'Bob redo restores only his input',[2,5])
 await until(()=>rows(alice)[1]==='你😀BBBBB','Alice sees redo')
 const selection=secondStart(bob.state().tr)+4;bob.dispatch(bob.state().tr.setSelection(TextSelection.create(bob.state().doc,selection)));assert.equal(bob.state().selection.$from.parentOffset,4)
 const same=alice.state().tr,start=secondStart(same);same.delete(start+3,start+4);same.insertText('B',secondStart(same)+same.doc.child(1).content.size);alice.dispatch(same);aliceHistory.stopCapturing()
 await until(()=>bob.state().selection.$from.parentOffset===3,'same-visible remote caret');await saved(alice,7,['AAAPeerAA😀AAAAA','你😀BBBBB'],'Delete one inserted B and append B: identical visible content, new identity and moved peer caret',[2,4],true)
 bob.dispatch(bob.state().tr.insertText('C'));bobHistory.stopCapturing();await saved(bob,8,['AAAPeerAA😀AAAAA','你😀CBBBBB'],'Next peer input uses restored relative caret, not stale visible offset',[2,5]);await until(()=>rows(alice)[1]==='你😀CBBBBB','Alice final')
 assert.deepEqual(alice.errors,[]);assert.deepEqual(bob.errors,[]);console.log('PASS real sockets r2-r8, multi-step two-root/composition edits, exact originals, own undo/redo, identical-visible identity persistence and peer caret, signed native reloads')
}finally{aliceHistory?.destroy();bobHistory?.destroy();for(const item of clients){item.close?.();item.provider.disconnect();item.provider.destroy();await item.provider.configuration.websocketProvider.destroy();item.document.destroy()}}
