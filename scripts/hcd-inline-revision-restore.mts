import {inlineCollaborationUrl as nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import assert from 'node:assert/strict'
import {readFile,writeFile,open} from 'node:fs/promises'
import {createServer,request as httpRequest} from 'node:http'
import {spawn,type ChildProcess} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {SemanticInlineContainerNode} from '../examples/hdoc/editor/src/semanticInlineNode.ts'
import {schemaExtensions,jsonToSnapshot,projectionToJson} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {installRestoreHandoff,waitRestoreSync} from '../examples/hdoc/editor/src/restoreClient.ts'
import {RestoreJournal} from '../examples/hdoc/editor/src/restoreJournal.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),native=new URL(config.apiUrl),sidecarURL=`http://127.0.0.1:${config.collabPort}`
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await check())return;await pause(25)}throw new Error('Timeout: '+label)}
async function request(route:string,init:RequestInit={},token=config.alice){return fetch(config.apiUrl+route,{...init,signal:AbortSignal.timeout(30000),headers:{'X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1',Authorization:`Bearer ${token}`,...init.headers}})}
async function json(route:string){const response=await request(route);assert.equal(response.status,200,route);return response.json()}
let dropReply=false,lostReplies=0,sidecar:ChildProcess|undefined
const nativeRequests:string[]=[],proxy=createServer((incoming,outgoing)=>{
 const restoring=incoming.url?.includes('/collaboration/restore/'),chunks:Buffer[]=[]
 if(restoring){incoming.on('data',chunk=>chunks.push(Buffer.from(chunk)));incoming.on('end',()=>nativeRequests.push(Buffer.concat(chunks).toString('utf8')))}
 const upstream=httpRequest(new URL(incoming.url||'/',native.origin),{method:incoming.method,headers:{...incoming.headers,host:native.host}},response=>{
  if(restoring&&dropReply&&response.statusCode===200){dropReply=false;response.resume();response.on('end',()=>{lostReplies++;outgoing.socket?.destroy()});return}
  outgoing.writeHead(response.statusCode||502,response.headers);response.pipe(outgoing)
 });upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end()});incoming.pipe(upstream)
})
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve))
const proxyURL=`http://127.0.0.1:${(proxy.address() as any).port}`,journal=new RestoreJournal(config.root+'/journal',proxyURL),log=await open(config.root+'/sidecar.log','a')
async function start(){sidecar=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_INLINE_ROOMS:'1',HCD_API_URL:proxyURL,HCD_COLLAB_PORT:String(config.collabPort),HCD_TOKEN_SECRET:config.secret,HCD_SIDECAR_STATE_DIR:config.root+'/journal'},stdio:['ignore',log.fd,log.fd]});await until(async()=>{try{return(await fetch(sidecarURL,{signal:AbortSignal.timeout(500)})).status===200}catch{return false}},'sidecar listening')}
async function stop(){const child=sidecar;sidecar=undefined;if(!child)return;child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},3000).unref()})}
const providers:HocuspocusProvider[]=[],documents:Y.Doc[]=[],cleanups:Array<()=>void>=[]
let busy=false,injectPeer=false,locked=0,released=0
function client(epoch:number,token:string,peer=false){
 const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true}),provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(config.collabUrl),name:`inline-native:${epoch}:inlinecontainers1:save4`,document,token,WebSocketPolyfill:WebSocket});providers.push(provider);documents.push(document)
 cleanups.push(installRestoreHandoff(provider,{freeze:()=>{locked++},ready:async()=>{if(peer&&busy)return false;if(peer&&injectPeer){injectPeer=false;store.insert([schema.node('paragraph',null,schema.text('Peer changed after review'))],null)}return waitRestoreSync(provider,AbortSignal.timeout(10000))},release:()=>{released++},committed:()=>{}}))
 return{provider,document,store}
}
const evidence:any={version:'hcd-inline-revision-restore/1',scope:'Real local native API, two WebSocket peers, sidecar restart and exports. Not browser, remote DB or multiple sidecars.',files:[],validation:{remoteDatabase:false,multipleSidecars:false}}
const negotiate=()=>fetch(sidecarURL+'/v1/documents/inline-native/collaboration/negotiate',{method:'POST',headers:{'X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1',Authorization:`Bearer ${config.alice}`},signal:AbortSignal.timeout(45000)})
const restore=(expectedRevision:number,requestId=crypto.randomUUID().replaceAll('-',''))=>fetch(sidecarURL+'/v1/documents/inline-native/collaboration/restore/8',{method:'POST',headers:{'X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1',Authorization:`Bearer ${config.alice}`,'Content-Type':'application/json'},body:JSON.stringify({requestId,expectedRevision,fromEpoch:1}),signal:AbortSignal.timeout(45000)})
async function exportFile(name:string,revision:number,requiredText:string[],forbiddenText:string[]=[]){const response=await request(`/export/${name.split('.').at(-1)}?revision=${revision}`);assert.equal(response.status,200,name);await writeFile(config.root+'/'+name,Buffer.from(await response.arrayBuffer()));evidence.files.push({name,revision,requiredText,forbiddenText})}
try{
 await start();assert.equal((await negotiate()).status,200);assert.equal((await json('/auth')).coordinatedRestore,true)
 const a=client(1,config.alice),b=client(1,config.bob,true)
 await until(()=>a.provider.isSynced&&b.provider.isSynced&&a.store.initialized&&b.store.initialized&&!a.provider.hasUnsyncedChanges&&!b.provider.hasUnsyncedChanges,'two structural peers')
 a.store.insert([schema.node('paragraph',null,schema.text('Saved before restore'))],null)
 let inlineId='';a.store.project().descendants(node=>{if(!inlineId&&node.type.name==='hcdExtensionInlineContainer')inlineId=node.attrs.extension.instanceId});assert.ok(inlineId);const inlineBody=a.store.flow.containers!.bodies.get(inlineId)!;inlineBody.insert(inlineBody.length,' Inline restore changed😀')
 await until(()=>b.store.project().textContent.includes('Saved before restore')&&!a.provider.hasUnsyncedChanges&&!b.provider.hasUnsyncedChanges,'peer receives saved content')
 const targetProjection=await json('/editor?revision=8');
 const saveCurrent=async()=>{await until(()=>!a.provider.hasUnsyncedChanges&&!b.provider.hasUnsyncedChanges,'packets flushed');const state=await requestCoordinatedSave(a.provider,await checkpointDigest(jsonToSnapshot(a.store.project().toJSON(),{inlineContainers:true})),undefined,30000,await imageDraftDigest(a.document));assert.equal(state.status,'saved',JSON.stringify(state));assert.equal(state.pending,false);return state.revision!}
 let head=await saveCurrent();await exportFile('before-restore.docx',head,['Nested😀','Saved before restore','Inline restore changed😀'])
 const missing=await fetch(sidecarURL+'/v1/documents/inline-native/collaboration/restore/8',{method:'POST',headers:{Authorization:'Bearer '+config.alice,'Content-Type':'application/json'},body:JSON.stringify({requestId:'d'.repeat(32),expectedRevision:head,fromEpoch:1})});assert.equal(missing.status,426);evidence.validation.missingModelAcknowledgementRejected=true
 busy=true;const denied=await restore(head);assert.equal(denied.status,409);assert.equal((await denied.json()).code,'restore-client-busy');assert.equal((await json('')).revision,head);busy=false;evidence.validation.privateBusyWindowPreventsRestore=true
 injectPeer=true;const changed=await restore(head);assert.equal(changed.status,409,'a late peer edit must invalidate the confirmed snapshot');assert.equal((await json('/auth')).collaborationEpoch,1);head=await saveCurrent();assert.equal(a.store.project().textContent.includes('Peer changed after review'),true);evidence.validation.latePeerEditPreserved=true
 await exportFile('latest-before-restore.docx',head,['Saved before restore','Peer changed after review'])
 const id=crypto.randomUUID().replaceAll('-','');dropReply=true;const uncertain=await restore(head,id);assert.equal(uncertain.status,503);assert.equal(lostReplies,1);const prepared=await journal.load('inline-native');assert.equal(prepared?.status,'prepared');assert.equal((await json('')).revision,head+1);assert.equal((await json('/auth')).collaborationEpoch,2);assert.equal((await json('/auth')).collaborationProtocol,'hcd-semantic-inline/1');assert.equal(prepared?.request.fromProtocol,'hcd-semantic-inline/1');evidence.validation.lostReplyRetainsExactPreparedIntent=true
 a.provider.destroy();b.provider.destroy();await stop();await start();const recovered=await negotiate();assert.equal(recovered.status,200);assert.equal((await recovered.json()).collaborationEpoch,2);assert.equal((await journal.load('inline-native'))?.status,'committed');assert.equal(nativeRequests.length,2);assert.equal(nativeRequests[0],nativeRequests[1]);assert.equal(JSON.parse(nativeRequests[0]).fromProtocol,'hcd-semantic-inline/1');assert.equal((await json('')).revision,head+1);evidence.validation.restartReplaysWithoutExtraRevision=true
 const oldState=await request('/collaboration/state',{headers:{'X-HCD-Collaboration-Epoch':'1','X-HCD-Collaboration-Protocol':'hcd-semantic-inline/1'}});assert.equal(oldState.status,409);evidence.validation.oldEpochRejected=true
 const c=client(2,config.alice);await until(()=>c.provider.isSynced&&c.store.initialized,'restored room');assert.equal(c.store.project().textContent.includes('Nested😀'),true);assert.equal(c.store.project().textContent.includes('Saved before restore'),false);assert.equal(c.store.project().textContent.includes('Peer changed'),false)
 assert.deepEqual(jsonToSnapshot(c.store.project().toJSON(),{inlineContainers:true}),jsonToSnapshot(projectionToJson(targetProjection,{inlineContainers:true}),{inlineContainers:true}));assert.equal(c.store.project().textContent.includes('Inline restore changed'),false);evidence.validation.exactTargetBodyAndNestedNodes=true
 await exportFile('restored.pptx',head+1,['Nested😀'],['Saved before restore','Inline restore changed']);await exportFile('restored.md',head+1,['Nested😀'],['Saved before restore','Inline restore changed']);
 await exportFile('restored.docx',head+1,['Nested😀'],['Saved before restore','Peer changed']);await exportFile('restored.pdf',head+1,['Nested😀'],['Saved before restore','Peer changed']);await exportFile('original-r8.docx',8,['Nested😀'],['Saved before restore','Peer changed']);await exportFile('history-before-restore.docx',head,['Saved before restore','Peer changed after review']);evidence.validation.newEpochBootstrapsRestoredBody=true
 c.store.insert([schema.node('paragraph',null,schema.text('Editing after restore'))],null);await until(()=>!c.provider.hasUnsyncedChanges,'new epoch edit sent');const current=await requestCoordinatedSave(c.provider,await checkpointDigest(jsonToSnapshot(c.store.project().toJSON(),{inlineContainers:true})),undefined,30000,await imageDraftDigest(c.document));assert.equal(current.status,'saved',JSON.stringify(current));assert.equal(current.revision,head+2);await exportFile('edited-after-restore.docx',current.revision!,['Nested😀','Editing after restore'],['Saved before restore','Peer changed']);evidence.validation.editingResumesInNewEpoch=true
 evidence.validation.clientsLockedAndReleased=locked>=4&&released>=2;evidence.validation.exactNativeRequests=true
 await writeFile(config.root+'/revision-restore-evidence.json',JSON.stringify(evidence,null,2));console.log('PASS real native restore, peer barriers, lost reply/restart and inline model, nested content and exports')
}finally{for(const clean of cleanups)clean();for(const provider of providers)provider.destroy();for(const document of documents)document.destroy();await stop();await log.close();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()))}
