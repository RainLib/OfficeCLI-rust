/** Owned real socket/native regression. No browser automation in this script. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHmac,timingSafeEqual} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState,type Transaction,type PluginView} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
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
const c=JSON.parse(await readFile(process.argv[2],'utf8')),assets='docs/assets/hcd-text-splice-2026-10-26',schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),clients:any[]=[],evidence:any[]=[],headers={'X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'}
async function info(route=''){const response=await fetch(c.origin+'/v1/documents/mentions-docx'+route,{headers:{...headers,Authorization:'Bearer '+c.alice}});assert.equal(response.status,200);return response.json()}
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('Timeout '+label)}
const initialProjection=await info('/editor');assert.equal(initialProjection.revision,1);assert.deepEqual(initialProjection.blocks.map((b:any)=>b.content.inlines.map((i:any)=>i.text).join('')),['P😀','协同位置验证']);const blockIds=initialProjection.blocks.map((b:any)=>b.blockId)
const negotiated=await fetch(`http://127.0.0.1:${c.ports[1]}/v1/documents/mentions-docx/collaboration/negotiate`,{method:'POST',headers:{...headers,Authorization:'Bearer '+c.alice}});assert.equal(negotiated.status,200);const auth=await negotiated.json();assert.equal(auth.nodeEditVersion,7)
async function connect(user:'alice'|'bob'){
 const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name:`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,document,token:c[user],WebSocketPolyfill:WebSocket}),errors:unknown[]=[]
 const item:any={document,store,provider,user,errors};clients.push(item);await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'sync '+user)
 const plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)});let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}};binding=plugin.spec.view!(view as unknown as EditorView)
 Object.assign(item,{state:()=>state,dispatch:view.dispatch,close:()=>binding.destroy?.()});await until(()=>state.doc.eq(store.project()),'projection '+user);return item
}
function ids(text:Y.XmlText){const values:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)values.push(`${item.id.client}:${item.id.clock+i}`);return values}
async function saved(client:any,revision:number,text:string,label:string,offset:number){
 await until(()=>!client.provider.hasUnsyncedChanges,'ack '+label)
 const snapshot=jsonToSnapshot(client.store.project().toJSON()),reply=await requestCoordinatedSave(client.provider,await checkpointDigest(snapshot),undefined,45000,await imageDraftDigest(client.document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);assert.equal(reply.revision,revision)
 await until(async()=>{const p=await info('/editor');return p.revision===revision},'native '+label)
 const canonical=await info('/editor');assert.deepEqual(canonical.blocks.map((b:any)=>b.blockId),blockIds);assert.equal(canonical.blocks[0].content.inlines.map((i:any)=>i.text).join(''),text);assert.equal(client.state().doc.childCount,2);assert.equal(client.state().doc.firstChild!.textContent,text)
 const now=ids(client.store.contents.get(rootKey)!.get(0) as Y.XmlText);assert.equal(now.indexOf(original[0]),offset);assert.deepEqual(now.filter(id=>original.includes(id)),original)
 const meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,bytes=new Uint8Array(await readFile(path)),loaded=new Y.Doc({gc:false});Y.applyUpdate(loaded,bytes)
 try{
  const persisted=new SemanticBlockStore(loaded,schema),[body,signature]=String(loaded.getMap('hcdSave').get('receipt')).split('.'),raw=Buffer.from(body,'base64url'),actual=Buffer.from(signature,'base64url'),mac=createHmac('sha256',c.secret).update(raw).digest();assert.equal(mac.length,actual.length);assert.ok(timingSafeEqual(mac,actual));const receipt=JSON.parse(raw.toString('utf8'));assert.equal(receipt.revision,revision);assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(persisted.project().toJSON())));assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(projectionToJson(canonical))))
  assert.equal(ids(persisted.contents.get(rootKey)!.get(0) as Y.XmlText).indexOf(original[0]),offset)
 }finally{loaded.destroy()}
 await writeFile(c.root+`/splice-r${revision}.yjs`,bytes,{mode:0o600});evidence.push({label,revision,text,originalPCurrentOffset:offset,rootCount:2,canonicalOrderUnchanged:true,originalItemsRetainedExactly:true,signedPersistedReceiptAndCanonicalMatch:true});await writeFile(assets+'/socket-evidence.json',JSON.stringify({scope:'Real authenticated Hocuspocus sockets + production PM binding in a headless view; actual native coordinator saves and committed file reloads. Not a browser IME test.',wire:7,rootKey,original,evidence},null,2)+'\n')
}
let rootKey:string,original:string[],aliceHistory:Y.UndoManager|undefined,bobHistory:Y.UndoManager|undefined
try{
 const alice=await connect('alice'),bob=await connect('bob');rootKey=alice.store.keys()[0];original=ids(alice.store.contents.get(rootKey)!.get(0) as Y.XmlText);await writeFile(c.root+'/splice-before.yjs',Y.encodeStateAsUpdate(alice.document),{mode:0o600});aliceHistory=alice.store.undoManager();bobHistory=bob.store.undoManager();bob.provider.disconnect();await until(()=>bob.provider.configuration.websocketProvider.status==='disconnected','Bob offline')
 alice.dispatch(alice.state().tr.insertText('PREFIX',1));aliceHistory.stopCapturing();await saved(alice,2,'PREFIXP😀','Alice actual PM prefix; Bob remains offline',6)
 bob.dispatch(bob.state().tr.insertText('Peer',2));bobHistory.stopCapturing();await bob.provider.connect();await until(()=>bob.provider.isSynced&&!bob.provider.hasUnsyncedChanges&&alice.state().doc.textContent.includes('Peer'),'late Bob');await saved(bob,3,'PREFIXPPeer😀','Late Bob input attaches to original P, not pasted P',6)
 assert.ok(aliceHistory.undo());await saved(alice,4,'PPeer😀','Alice undo preserves Bob input',0);assert.ok(aliceHistory.redo());await saved(alice,5,'PREFIXPPeer😀','Alice redo preserves original and Bob input',6)
 await until(()=>bob.state().doc.firstChild!.textContent==='PREFIXPPeer😀','Bob sees redo');assert.ok(bobHistory.undo());await saved(bob,6,'PREFIXP😀','Bob undo preserves Alice prefix',6);assert.ok(bobHistory.redo());await saved(bob,7,'PREFIXPPeer😀','Bob redo restores only his input',6)
 assert.deepEqual(alice.errors,[]);assert.deepEqual(bob.errors,[]);console.log('PASS real socket PM binding r2-r7, original item identities, late peer input, own undo/redo and signed native state; exactly two roots throughout')
}finally{aliceHistory?.destroy();bobHistory?.destroy();for(const item of clients){item.close?.();item.provider.disconnect();item.provider.destroy();await item.provider.configuration.websocketProvider.destroy();item.document.destroy()}}
