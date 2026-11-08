/** Owned recovery packet and localhost API/sidecar; IndexedDB/locks simulated. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {IDBFactory} from '../examples/hdoc/editor/node_modules/fake-indexeddb/build/esm/index.js'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {negotiateSession} from '../examples/hdoc/editor/src/protocolClient.ts'
import {createSemanticRecoveryArchive,openSemanticRecoveryArchive,semanticRecoveryArchiveScope} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {prepareRecoveryTransfer,applyRecoveryTransfer,httpRecoveryVerifier,recoveryAuthority,stageRecoveryResource} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
import {SemanticImageFiles} from '../examples/hdoc/editor/src/semanticImageFiles.ts'
import {SemanticImageFileClient} from '../examples/hdoc/editor/src/semanticImageFileClient.ts'
const root=process.argv[2],packetPath=process.argv[3];if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),token=config.alice,base=config.origin+'/v1/documents/mentions-docx',input={documentId:'mentions-docx',token,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${config.ports[1]}`}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check:()=>boolean,label:string){const end=Date.now()+30000;while(Date.now()<end){if(check())return;await pause(25)}throw Error('timeout '+label)}
async function json(route:string){const res=await fetch(base+route,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});assert.equal(res.status,200);return res.json()}
const authority=await negotiateSession(input,AbortSignal.timeout(45000)),session={...input,...authority},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=new Y.Doc(),peerDoc=new Y.Doc(),store=new SemanticBlockStore(doc,schema),peerStore=new SemanticBlockStore(peerDoc,schema),room=`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,connect=(document:Y.Doc,credential:string)=>new HocuspocusProvider({url:nodeEditCollaborationUrl(input.collabUrl),name:room,document,token:credential,WebSocketPolyfill:WebSocket}),provider=connect(doc,token),peer=connect(peerDoc,config.bob),history=store.undoManager()
const prior=globalThis.navigator;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,work:()=>Promise<unknown>)=>work()}}})
const files=await SemanticImageFiles.open('hcd-local-draft-v1-'+'d'.repeat(64)+`-${authority.collaborationEpoch}-structure3-nodefiles1`,new IDBFactory())
let candidate:Awaited<ReturnType<typeof openSemanticRecoveryArchive>>|undefined,review:Awaited<ReturnType<typeof prepareRecoveryTransfer>>|undefined
try{
 await until(()=>provider.isSynced&&peer.isSynced&&store.initialized&&peerStore.initialized&&!provider.hasUnsyncedChanges&&!peer.hasUnsyncedChanges,'two peers')
 const original=new Uint8Array(await readFile(packetPath)),scope=semanticRecoveryArchiveScope(original),signal=AbortSignal.timeout(45000);assert.equal(scope.epoch,authority.collaborationEpoch)
 candidate=await openSemanticRecoveryArchive(original,{scope,schema,verifyCanonical:httpRecoveryVerifier(session,signal)});assert.equal(candidate.pendingImages.length,1)
 candidate.store.insert([schema.nodes.paragraph.createChecked(null,schema.text('Recovered packet text'))],null)
 const packet=await createSemanticRecoveryArchive({scope,document:candidate.document,schema,canonical:candidate.canonical,pendingFiles:candidate.pendingFiles,pendingImages:candidate.pendingImages,verifyCanonical:httpRecoveryVerifier(session,signal),readResource:async resource=>{const bytes=candidate!.resources.get(resource.hash);if(!bytes)throw Error('missing resource');return bytes}})
 peerStore.insert([schema.nodes.paragraph.createChecked(null,schema.text('Peer preserved text'))],null);await until(()=>store.project().textContent.includes('Peer preserved text')&&!peer.hasUnsyncedChanges&&!provider.hasUnsyncedChanges,'peer text synced')
 const before=await json('');review=await prepareRecoveryTransfer({session,bytes:packet,current:doc,schema,signal});assert.equal(review.candidate.pendingImages.length,1);assert.match(review.after.text,/Peer preserved text/);assert.match(review.after.text,/Recovered packet text/)
 let imported=false;await applyRecoveryTransfer(review,{current:doc,history,signal,canWrite:()=>!imported&&provider.isSynced&&!provider.hasUnsyncedChanges,canWriteAfterImages:()=>provider.isSynced&&!provider.hasUnsyncedChanges,authorize:s=>recoveryAuthority(session,s,true),stageResource:(resource,bytes,s)=>stageRecoveryResource(session,resource,bytes,s),importFiles:async()=>{},importImages:async values=>{await files.importChoices(values);imported=true},pendingImages:()=>files.list(),withFileLock:work=>work()})
 await until(()=>peerStore.project().textContent.includes('Recovered packet text')&&!provider.hasUnsyncedChanges,'merged text on peer')
 assert.match(store.project().textContent,/Peer preserved text/);const [choice]=await files.list();assert.equal(choice.phase,'applying');assert.deepEqual(choice.bytes,new TextEncoder().encode('Synthetic offline image bytes'))
 let stages=0;const client=new SemanticImageFileClient(files,doc,{ready:()=>true,verify:async()=>{},stage:async value=>{stages++;return{hash:value.hash}},flush:async()=>{},synchronize:async()=>true});await assert.rejects(client.resume(choice.id),/uncertain/);assert.equal(stages,0);client.dispose()
 const after=await json('');assert.equal(after.revision,before.revision)
 const evidence={scope:'Local native HTTP and two actual WebSocket clients; IndexedDB and locks simulated. Browser import and real device recovery not tested.',revision:after.revision,packetImages:1,peerTextPreserved:true,recoveredTextOnPeer:true,exactFileBytesPreserved:true,uncertainChoiceNotReplayed:true};await writeFile(root+'/semantic-image-recovery-service-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{review?.dispose();candidate?.dispose();history.destroy();provider.destroy();peer.destroy();doc.destroy();peerDoc.destroy();await files.close();Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:prior})}
