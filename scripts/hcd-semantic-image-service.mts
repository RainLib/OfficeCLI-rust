/** Isolated native HTTP + real semantic sidecar; device IDB and locks simulated. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {IDBFactory} from '../examples/hdoc/editor/node_modules/fake-indexeddb/build/esm/index.js'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {negotiateSession} from '../examples/hdoc/editor/src/protocolClient.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {CollaborativeImageDraftStore,imageDraftDigest,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {waitRestoreSync} from '../examples/hdoc/editor/src/restoreClient.ts'
import {SemanticImageFiles} from '../examples/hdoc/editor/src/semanticImageFiles.ts'
import {SemanticImageFileClient} from '../examples/hdoc/editor/src/semanticImageFileClient.ts'
const root=process.argv[2],config=JSON.parse(await readFile(root+'/private.json','utf8'))
if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const token=config.alice,base=config.origin+'/v1/documents/mentions-docx',session={documentId:'mentions-docx',token,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${config.ports[1]}`}
const request=async(route:string,init:RequestInit={})=>fetch(base+route,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(30000)})
const json=async(route:string)=>{const response=await request(route);assert.equal(response.status,200,route);return response.json()}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean,label:string){const deadline=Date.now()+30000;while(Date.now()<deadline){if(check())return;await pause(25)}throw Error('timeout: '+label)}
const authority=await negotiateSession(session,AbortSignal.timeout(45000));assert.equal(authority.collaborationProtocol,'hcd-semantic-blocks/3')
const doc=new Y.Doc(),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),store=new SemanticBlockStore(doc,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document:doc,token,WebSocketPolyfill:WebSocket})
const peerDoc=new Y.Doc(),peerStore=new SemanticBlockStore(peerDoc,schema),peer=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document:peerDoc,token:config.bob,WebSocketPolyfill:WebSocket})
const prior=globalThis.navigator;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,work:()=>Promise<unknown>)=>work()}}})
const scope='hcd-local-draft-v1-'+'d'.repeat(64)+`-${authority.collaborationEpoch}-structure3-nodefiles1`,factory=new IDBFactory();let files=await SemanticImageFiles.open(scope,factory);const images=new CollaborativeImageDraftStore(doc),disconnect=images.connect()
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges&&peer.isSynced&&peerStore.initialized&&!peer.hasUnsyncedChanges,'two rooms initialized')
 const response=await json('/images'),baseImage=response.entries[0];assert.ok(baseImage?.geometry)
 let posts=0,offline=true;const makeClient=()=>new SemanticImageFileClient(files,doc,{ready:()=>provider.isSynced&&!provider.hasUnsyncedChanges,readyAfterApply:()=>true,verify:async choice=>{const current=await json(`/images/${encodeURIComponent(choice.base.nodeId)}`);assert.equal(current.image.visualHash,choice.base.visualHash)},stage:async choice=>{if(offline)throw Error('simulated-offline');posts++;const response=await request(`/staged-assets?extension=${choice.extension}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([Uint8Array.from(choice.bytes)])});assert.equal(response.status,200);return response.json()},flush:async()=>{},synchronize:signal=>waitRestoreSync(provider,signal),apply:(capture,hash,id)=>images.applyCapturedReplacement(capture,hash,id)})
 let client=makeClient();const before=await json(''),bytes=await readFile(root+'/replacement.png'),choice=await client.choose(new File([bytes],'replacement.png',{type:'image/png'}),images.captureReplacement(baseImage,response.revision))
 await assert.rejects(client.resume(choice.id),/simulated-offline/);assert.equal((await files.list())[0].phase,'chosen');assert.equal(posts,0);client.dispose();await files.close();files=await SemanticImageFiles.open(scope,factory);assert.deepEqual((await files.list())[0].bytes,new Uint8Array(bytes));offline=false;client=makeClient();await client.resume(choice.id);assert.equal(posts,1);assert.equal((await files.list()).length,0);assert.equal(imageIntents(doc).some(intent=>intent.intentId===choice.id),true);await until(()=>imageIntents(peerDoc).some(intent=>intent.intentId===choice.id&&intent.assetHash===choice.hash),'peer receives image intent')
 await until(()=>!provider.hasUnsyncedChanges,'image sent');const result=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(doc))
 assert.equal(result.status,'saved',JSON.stringify(result));assert.equal(result.pending,false);assert.ok(Number.isSafeInteger(result.revision))
 const saved=await json(`/images/${baseImage.nodeId}?revision=${result.revision}`);assert.equal(saved.image.assetHash,choice.hash)
 const asset=await request(`/assets/${choice.hash}?revision=${result.revision}`);assert.equal(asset.status,200);assert.deepEqual(new Uint8Array(await asset.arrayBuffer()),new Uint8Array(bytes))
 const evidence={scope:'Local native API and sidecar with real websocket; IndexedDB and Web Locks simulated. No browser upload or production acceptance.',beforeRevision:before.revision,savedRevision:result.revision,stageRequests:posts,reopenedAfterFailure:true,peerReceivedExactIntent:true,assetHash:choice.hash,bytes:bytes.length,exactSavedBytes:true,choiceCleared:true}
 await writeFile(root+'/semantic-image-service-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));client.dispose()
}finally{disconnect();provider.destroy();peer.destroy();doc.destroy();peerDoc.destroy();await files.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:prior})}
