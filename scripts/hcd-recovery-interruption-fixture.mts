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
import {exportRecoveryArchive,httpRecoveryVerifier,prepareRecoveryTransfer,applyRecoveryTransfer} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
const root=process.argv[2];if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),token=config.alice,base=config.origin+'/v1/documents/mentions-docx',input={documentId:'mentions-docx',token,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${config.ports[1]}`}
async function request(route:string,init:RequestInit={}){const response=await fetch(base+route,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,route);return response}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));async function until(check:()=>boolean,label:string){const end=Date.now()+30000;while(Date.now()<end){if(check())return;await pause(25)}throw Error('timeout '+label)}
const authority=await negotiateSession(input,AbortSignal.timeout(45000)),session={...input,...authority},schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(session.collabUrl),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document:doc,token,WebSocketPolyfill:WebSocket}),images=new CollaborativeImageDraftStore(doc),disconnect=images.connect()
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'room ready');const offline=new Y.Doc({gc:false});Y.applyUpdate(offline,Y.encodeStateAsUpdate(doc));const offlineStore=new SemanticBlockStore(offline,schema);offlineStore.insert([schema.nodes.paragraph.createChecked(null,schema.text('中断时不能合并正文'))],null);const signal=AbortSignal.timeout(45000),fileBytes=new TextEncoder().encode('中断恢复附件原始内容'),fileHash=await imageFileHash(fileBytes),file={version:1 as const,id:crypto.randomUUID(),regionId:'body',phase:'chosen' as const,expected:{schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline' as const,data:{},fallback:{text:'File'}},resource:{key:'r_file',hash:fileHash,byteLength:fileBytes.length,name:'中断恢复附件.txt',mediaType:'text/plain'},bytes:fileBytes},packet=await exportRecoveryArchive({session,document:offline,schema,pendingFiles:[file],signal});await writeFile(root+'/interrupted.hcd-recovery',packet,{mode:0o600});offline.destroy();console.log('created synthetic interrupted recovery packet')
}finally{disconnect();provider.destroy();doc.destroy()}
