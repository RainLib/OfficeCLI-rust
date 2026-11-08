/** Isolated native service with actual semantic WebSocket, no browser input. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {negotiateSession} from '../examples/hdoc/editor/src/protocolClient.ts'
import {imageFileHash} from '../examples/hdoc/editor/src/imageFileIntegrity.ts'
import {CollaborativeImageDraftStore,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {semanticRecoveryArchiveScope,openSemanticRecoveryArchive} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {exportRecoveryArchive,httpRecoveryVerifier,prepareRecoveryTransfer,applyRecoveryTransfer,recoveryAuthority,stageRecoveryResource} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
const root=process.argv[2];if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),token=config.alice,base=config.origin+'/v1/documents/mentions-docx',input={documentId:'mentions-docx',token,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${config.ports[1]}`}
async function request(route:string,init:RequestInit={}){const response=await fetch(base+route,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,route);return response}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check:()=>boolean,label:string){const end=Date.now()+30000;while(Date.now()<end){if(check())return;await pause(25)}throw Error('timeout '+label)}
const authority=await negotiateSession(input,AbortSignal.timeout(45000)),session={...input,...authority},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document:doc,token,WebSocketPolyfill:WebSocket}),images=new CollaborativeImageDraftStore(doc),disconnect=images.connect()
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'room ready');const start=await(await request('')).json(),list=await(await request('/images')).json(),image=list.entries[0],bytes=new Uint8Array(await readFile(root+'/draft.png')),hash=await imageFileHash(bytes),response=await request('/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([bytes])});assert.equal((await response.json()).hash,hash)
 const upload=images.prepareReplacement(image,list.revision);upload.commit(hash);upload.finish();await until(()=>!provider.hasUnsyncedChanges,'image intent sent')
 const offline=new Y.Doc({gc:false});Y.applyUpdate(offline,Y.encodeStateAsUpdate(doc));const offlineStore=new SemanticBlockStore(offline,schema);offlineStore.insert([schema.nodes.paragraph.createChecked(null,schema.text('混合包恢复正文'))],null);const signal=AbortSignal.timeout(45000),packet=await exportRecoveryArchive({session,document:offline,schema,pendingFiles:[],signal}),scope=semanticRecoveryArchiveScope(packet),raw=JSON.parse(new TextDecoder().decode(packet));assert.equal(raw.schemaVersion,'hcd-semantic-recovery/3')
 await writeFile(root+'/image-draft.hcd-recovery',packet,{mode:0o600})
 const opened=await openSemanticRecoveryArchive(packet,{scope,schema,verifyCanonical:httpRecoveryVerifier(session,signal)});try{assert.equal(imageIntents(opened.document)[0].assetHash,hash);assert.deepEqual(opened.resources.get(hash),bytes)}finally{opened.dispose()}
 doc.getMap('hcdImageDrafts').clear();await until(()=>!provider.hasUnsyncedChanges,'room image deletion synchronized')
 const review=await prepareRecoveryTransfer({session,bytes:packet,current:doc,schema,signal}),history=store.undoManager();try{assert.equal(review.imageDraftsIntegrated,true);assert.equal(imageIntents(doc).length,0);await applyRecoveryTransfer(review,{current:doc,history,signal,canWrite:()=>provider.isSynced&&!provider.hasUnsyncedChanges,authorize:s=>recoveryAuthority(session,s,true),stageResource:(resource,bytes,s)=>stageRecoveryResource(session,resource,bytes,s),importFiles:async()=>assert.fail('no attachments')});assert.match(store.project().textContent,/混合包恢复正文/);assert.equal(imageIntents(doc).length,0);await until(()=>!provider.hasUnsyncedChanges,'merged text synchronized');const end=await(await request('')).json();assert.equal(end.revision,start.revision);console.log('PASS: mixed packet body merged over already integrated image history, no new image draft or save')}finally{history.destroy();review.dispose();offline.destroy()}
}finally{disconnect();provider.destroy();doc.destroy()}
