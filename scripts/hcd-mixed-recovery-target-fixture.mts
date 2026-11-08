/** Isolated native service with actual semantic WebSocket, no browser input. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {negotiateSession} from '../examples/hdoc/editor/src/protocolClient.ts'
import {imageFileHash} from '../examples/hdoc/editor/src/imageFileIntegrity.ts'
import {CollaborativeImageDraftStore,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {semanticRecoveryArchiveScope,openSemanticRecoveryArchive} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {exportRecoveryArchive,httpRecoveryVerifier,prepareRecoveryTransfer,applyRecoveryTransfer} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
const root=process.argv[2];if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),token=config.alice,base=config.origin+'/v1/documents/mentions-docx',input={documentId:'mentions-docx',token,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${config.ports[1]}`}
async function request(route:string,init:RequestInit={}){const response=await fetch(base+route,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,route);return response}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check:()=>boolean,label:string){const end=Date.now()+30000;while(Date.now()<end){if(check())return;await pause(25)}throw Error('timeout '+label)}
const authority=await negotiateSession(input,AbortSignal.timeout(45000)),session={...input,...authority},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document:doc,token,WebSocketPolyfill:WebSocket}),images=new CollaborativeImageDraftStore(doc),disconnect=images.connect()
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'room ready');const registry=new NodeExtensionRegistry(nodePortableFixture),value=registry.create('example.resource_badge',{title:'混合恢复目标'});store.insert([schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdExtensionInline.createChecked({extension:value})])],null);await until(()=>!provider.hasUnsyncedChanges,'node synced');const result=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,45000,await imageDraftDigest(doc));assert.equal(result.status,'saved');await until(()=>!provider.hasUnsyncedChanges,'save synced');const target=[...extensionNodes(store.project()).values()].find(item=>item.value.instanceId===value.instanceId)?.value;assert.ok(target);const start=await(await request('')).json(),list=await(await request('/images')).json(),image=list.entries[0],bytes=new Uint8Array(await readFile(root+'/draft.png')),hash=await imageFileHash(bytes),response=await request('/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([bytes])});assert.equal((await response.json()).hash,hash)
 const offline=new Y.Doc({gc:false});Y.applyUpdate(offline,Y.encodeStateAsUpdate(doc));const offlineImages=new CollaborativeImageDraftStore(offline);const upload=offlineImages.prepareReplacement(image,list.revision);upload.commit(hash);upload.finish()
 const signal=AbortSignal.timeout(45000),fileBytes=new TextEncoder().encode('合成待恢复附件内容'),fileHash=await imageFileHash(fileBytes),file={version:1 as const,id:crypto.randomUUID(),regionId:'body',phase:'chosen' as const,expected:target,resource:{key:'r_file',hash:fileHash,byteLength:fileBytes.length,name:'待恢复附件.txt',mediaType:'text/plain'},bytes:fileBytes},packet=await exportRecoveryArchive({session,document:offline,schema,pendingFiles:[file],signal}),scope=semanticRecoveryArchiveScope(packet),raw=JSON.parse(new TextDecoder().decode(packet));assert.equal(raw.schemaVersion,'hcd-semantic-recovery/3')
 await writeFile(root+'/mixed-image-file.hcd-recovery',packet,{mode:0o600})
 const opened=await openSemanticRecoveryArchive(packet,{scope,schema,verifyCanonical:httpRecoveryVerifier(session,signal)});try{assert.equal(imageIntents(opened.document)[0].assetHash,hash);assert.deepEqual(opened.resources.get(hash),bytes)}finally{opened.dispose()}
 offline.destroy();console.log('created synthetic mixed image and attachment packet')
}finally{disconnect();provider.destroy();doc.destroy()}
