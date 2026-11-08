import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import assert from 'node:assert/strict'
import {readFile,writeFile,open} from 'node:fs/promises'
import {createServer,request as httpRequest} from 'node:http'
import {spawn,type ChildProcess} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {TiptapTransformer} from '../examples/hdoc/editor/node_modules/@hocuspocus/transformer/dist/hocuspocus-transformer.esm.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {EditorState,TextSelection} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,blockIdentityPlugin,sourceIdentityPlugin,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../examples/hdoc/editor/src/semanticStructureBinding.ts'
import {CollaborativeImageDraftStore,imageDraftDigest,imageDraftContents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {checkpointDigest,checkpointContents} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {confirmProtocolReady} from '../examples/hdoc/editor/src/protocolClient.ts'
import {MigrationJournal} from '../examples/hdoc/editor/src/migrationJournal.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+20_000;while(Date.now()<end){if(await check())return;await pause(25)}throw new Error('Timeout: '+label)}
async function request(route:string,init:RequestInit={},token=config.alice){return fetch(config.apiUrl+route,{...init,signal:init.signal??AbortSignal.timeout(30_000),headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${token}`,...init.headers}})}
async function json(route:string){const response=await request(route);assert.equal(response.status,200,route);return response.json()}
const native=new URL(config.apiUrl),sidecarURL=`http://127.0.0.1:${config.collabPort}`
let holdAuth:{arrive:()=>void;wait:Promise<void>}|undefined,dropMigrationReply=true,lostReplies=0,migrationRequests:string[]=[],checkpointRequests:Array<{id:string;documentId:string}>=[],dropCanonicalReply=false,lostCanonicalReplies=0,sidecar:ChildProcess|undefined
const proxy=createServer((incoming,outgoing)=>{
 const chunks:Buffer[]=[]
 if(incoming.url?.endsWith('/checkpoints')){incoming.on('data',chunk=>chunks.push(Buffer.from(chunk)));incoming.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));checkpointRequests.push({id:body.checkpointId,documentId:incoming.url!.split('/')[3]})})}
 const forward=()=>{
  const migration=incoming.url?.endsWith('/collaboration/migrate')
  if(migration)migrationRequests.push(String(incoming.headers['x-hcd-migration-id']))
  const upstream=httpRequest(new URL(incoming.url||'/',native.origin),{method:incoming.method,headers:{...incoming.headers,host:native.host}},response=>{
   if(migration&&dropMigrationReply&&response.statusCode===200){dropMigrationReply=false;response.resume();response.on('end',()=>{lostReplies++;outgoing.socket?.destroy()});return}
   if(dropCanonicalReply&&incoming.url?.includes('/unknown/checkpoints')&&response.statusCode===200){dropCanonicalReply=false;response.resume();response.on('end',()=>{lostCanonicalReplies++;outgoing.socket?.destroy()});return}
   outgoing.writeHead(response.statusCode||502,response.headers);response.pipe(outgoing)
  });upstream.on('error',()=>{outgoing.writeHead(502);outgoing.end()});incoming.pipe(upstream)
 }
 if(holdAuth&&incoming.url?.endsWith('/auth')&&incoming.headers.authorization===`Bearer ${config.alice}`){const gate=holdAuth;holdAuth=undefined;gate.arrive();void gate.wait.then(forward)}else forward()
})
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve))
const proxyURL=`http://127.0.0.1:${(proxy.address() as any).port}`,journal=new MigrationJournal(config.root+'/journal',proxyURL),log=await open(config.root+'/sidecar.log','a')
async function startSidecar(){
 sidecar=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_API_URL:proxyURL,HCD_COLLAB_PORT:String(config.collabPort),HCD_TOKEN_SECRET:config.secret,HCD_SIDECAR_STATE_DIR:config.root+'/journal'},stdio:['ignore',log.fd,log.fd]})
 await until(async()=>{try{return(await fetch(sidecarURL,{signal:AbortSignal.timeout(500)})).status===200}catch{return false}},'sidecar listens')
}
async function stopSidecar(){if(!sidecar)return;const child=sidecar;sidecar=undefined;child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},3000).unref()})}
const providers:HocuspocusProvider[]=[],docs:Y.Doc[]=[],detach:Array<()=>void>=[]
function client(name:string,token:string,document=new Y.Doc()){
 docs.push(document);const provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(config.collabUrl),name,document,token,WebSocketPolyfill:WebSocket});providers.push(provider);return{document,provider}
}
function legacyText(document:Y.Doc){let text:Y.XmlText|undefined;const walk=(node:any)=>{if(text)return;if(node instanceof Y.XmlText){text=node;return}for(const child of node.toArray?.()??[])walk(child)};walk(document.getXmlFragment('default'));assert.ok(text,'legacy text carrier must exist');return text}
function engine(document:Y.Doc){
 const store=new SemanticBlockStore(document,schema),errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)})
 let current=EditorState.create({schema,plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),plugin]}),binding:any
 const view={get state(){return current},dispatch(tr:any){const previous=current;current=current.applyTransaction(tr).state;binding?.update?.(view,previous)}}
 binding=plugin.spec.view!(view as any);return{store,errors,get:()=>current,dispatch:view.dispatch,close:()=>binding.destroy?.()}
}
const evidence:any={version:'hcd-sidecar-migration-api/1',scope:'Real native API and Hocuspocus socket peers; PM views are headless. No browser, IME, remote database or default App acceptance.',files:[],validation:{browser:false,ime:false,remoteDatabase:false,defaultAppMigrated:false}}
let releaseAuth:(()=>void)|undefined
try{
 await startSidecar()
 const a=client('doc:0:typography2:save4',config.alice),b=client('doc:0:typography2:save4',config.bob)
 await until(()=>a.provider.isSynced&&b.provider.isSynced&&!a.provider.hasUnsyncedChanges&&!b.provider.hasUnsyncedChanges,'legacy peers ready')
 const original=(await json('/images')).entries[0],sa=new CollaborativeImageDraftStore(a.document),sb=new CollaborativeImageDraftStore(b.document);detach.push(sa.connect(),sb.connect())
 const assetResponse=await request('/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(config.root+'/red.png')});assert.equal(assetResponse.status,200);const asset=await assetResponse.json();evidence.replacementAsset=asset.hash
 sa.replace(original,1,asset.hash);sa.edit(original,1,{...original.geometry,x:11},undefined,'x');sb.edit(original,1,{...original.geometry,x:22},undefined,'x')
 await until(()=>!!sa.get(original.nodeId)?.collaborationConflict&&!a.provider.hasUnsyncedChanges&&!b.provider.hasUnsyncedChanges,'both image alternatives synchronized')
 const imagesBefore=imageDraftContents(a.document)
 const notReady=await fetch(sidecarURL+'/v1/documents/doc/collaboration/negotiate',{method:'POST',headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.bob}`}})
 assert.equal(notReady.status,409,'private in-flight work in unaware windows must block upgrade');assert.equal((await notReady.json()).code,'migration-online-clients')
 assert.equal(migrationRequests.length,0);evidence.onlineLegacyPreflight=true
 await Promise.all([confirmProtocolReady(a.provider,AbortSignal.timeout(5000)),confirmProtocolReady(b.provider,AbortSignal.timeout(5000))])

 let arrived!:()=>void;const arrivedPromise=new Promise<void>(resolve=>{arrived=resolve}),releasePromise=new Promise<void>(resolve=>{releaseAuth=resolve});holdAuth={arrive:arrived,wait:releasePromise}
 const text=legacyText(a.document);a.document.transact(()=>text.insert(text.length,' Held input!',text.toDelta().at(-1)?.attributes))
 await arrivedPromise
 const negotiate=()=>fetch(sidecarURL+'/v1/documents/doc/collaboration/negotiate',{method:'POST',headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.bob}`},signal:AbortSignal.timeout(60_000)})
 const first=negotiate(),second=negotiate();await pause(150)
 assert.equal(migrationRequests.length,0,'migration must wait until admitted auth + packet application completes');assert.equal((await json('/auth')).collaborationEpoch,0)
 releaseAuth();releaseAuth=undefined
 const replies=await Promise.all([first,second]);replies.forEach(response=>assert.equal(response.status,503,'lost publication reply must leave a retryable pending job'))
 assert.equal(lostReplies,1);assert.equal(migrationRequests.length,1,'one owner must publish both concurrent negotiation requests')
 const prepared=(await journal.load('doc'))!;assert.equal(prepared.status,'prepared');assert.equal((await json('/auth')).collaborationEpoch,1)
 evidence.packetDrainedBeforeMigration=true;evidence.concurrentNegotiationOneOwner=true;evidence.lostReplyKeptPreparedJob=true
 await stopSidecar();await startSidecar()
 const resumed=await negotiate();assert.equal(resumed.status,200,'a restarted sidecar must reconcile the prepared job');const selected=await resumed.json()
 assert.equal(selected.collaborationEpoch,1);assert.equal(selected.collaborationProtocol,'hcd-semantic-blocks/3');assert.equal((await journal.load('doc'))!.status,'committed')
 assert.deepEqual(migrationRequests,[prepared.id,prepared.id]);evidence.restartRetriedExactMigrationId=true
 a.provider.destroy();b.provider.destroy()
 const aa=client('doc:1:structure3:save4',config.alice),bb=client('doc:1:structure3:save4',config.bob)
 await until(()=>aa.provider.isSynced&&bb.provider.isSynced,'structural peers ready')
 const ea=engine(aa.document),eb=engine(bb.document);detach.push(ea.close,eb.close)
 await Promise.resolve();assert.ok(ea.get().doc.textContent.includes('Held input!'),'the admitted in-flight text must survive protocol migration')
 assert.equal(imageDraftContents(aa.document),imagesBefore,'all image alternatives and replacement bytes must survive without committing')
 assert.equal((await json('')).revision,1,'protocol migration must retain unsaved status')
 evidence.unsavedBodyPreserved=true;evidence.imageCandidatesPreserved=true;evidence.canonicalHeadUnchanged=true
 const bad=new Y.Doc(),paragraph=new Y.XmlElement('paragraph');bad.getXmlFragment('default').insert(0,[paragraph]);paragraph.insert(0,[new Y.XmlText('Wrong protocol')]);const wrong=client('doc:1:structure3:save4',config.alice,bad)
 await pause(250);assert.equal(aa.document.getXmlFragment('default').length,0);wrong.provider.destroy();evidence.mixedBodyRejected=true
 const images=new CollaborativeImageDraftStore(aa.document);detach.push(images.connect());const option=images.get(original.nodeId)!.alternatives!.find(value=>value.geometry.x===22)!;assert.ok(option,'peer geometry choice must remain selectable');images.resolveVariant(original.nodeId,option.intentId)
 bb.provider.disconnect();await until(()=>!bb.provider.configuration.websocketProvider.webSocket,'peer offline')
 let root=-1;ea.get().doc.descendants((node,pos)=>{if(root<0&&node.isTextblock)root=pos})
 let peerEnd=-1;eb.get().doc.descendants((node,pos)=>{if(peerEnd<0&&node.isTextblock)peerEnd=pos+1+node.content.size})
 eb.dispatch(eb.get().tr.setSelection(TextSelection.create(eb.get().doc,peerEnd)).insertText(' Peer!'));ea.dispatch(ea.get().tr.split(root+4));await bb.provider.connect()
 await until(()=>bb.provider.isSynced&&ea.get().doc.eq(eb.get().doc)&&ea.get().doc.textContent.includes('Peer!')&&!aa.provider.hasUnsyncedChanges&&!bb.provider.hasUnsyncedChanges,'split and offline input converge')
 assert.deepEqual(ea.errors,[]);assert.deepEqual(eb.errors,[])
 let saved=await requestCoordinatedSave(aa.provider,await checkpointDigest(jsonToSnapshot(ea.store.project().toJSON())),undefined,30_000,await imageDraftDigest(aa.document));assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.pending,false)

 ea.store.insert([schema.node('paragraph')],null)
 const history=ea.store.undoManager();detach.push(()=>history.destroy())
 let lastRoot=0;ea.get().doc.forEach((_node,pos)=>{lastRoot=pos})
 ea.dispatch(ea.get().tr.insertText(' Own history!',lastRoot+1));history.stopCapturing()
 const saveBody=async()=>{await until(()=>!aa.provider.hasUnsyncedChanges&&!bb.provider.hasUnsyncedChanges,'history body and source repairs synchronized');const result=await requestCoordinatedSave(aa.provider,await checkpointDigest(jsonToSnapshot(ea.store.project().toJSON())),undefined,30_000,await imageDraftDigest(aa.document));assert.equal(result.status,'saved',JSON.stringify(result));assert.equal(result.pending,false);return result}
 const exportHistory=async(name:string,revision:number,own:boolean)=>{const response=await request(`/export/docx?revision=${revision}`);assert.equal(response.status,200);await writeFile(config.root+'/'+name,Buffer.from(await response.arrayBuffer()));evidence.files.push({name,revision,requiredText:['Held input!','Peer!',...(own?['Own history!']:[])],forbiddenText:own?[]:['Own history!']})}
 const typed=await saveBody();await exportHistory('structural-history-typed.docx',typed.revision!,true)
 history.undo();assert.equal(ea.store.project().textContent.includes('Own history!'),false);const undone=await saveBody();await exportHistory('structural-history-undo.docx',undone.revision!,false)
 history.redo();assert.ok(ea.store.project().textContent.includes('Own history!'),'redo must restore own text');saved=await saveBody();await exportHistory('structural-history-redo.docx',saved.revision!,true)
 assert.deepEqual(ea.errors,[]);assert.deepEqual(eb.errors,[]);evidence.committedOwnHistoryVerified=true
 for(const format of ['docx','md','pdf']){const response=await request(`/export/${format}?revision=${saved.revision}`);assert.equal(response.status,200);const name=`migrated-and-saved.${format}`;await writeFile(config.root+'/'+name,Buffer.from(await response.arrayBuffer()));evidence.files.push({name,revision:saved.revision})}
 const image=(await json('/images')).entries[0];assert.equal(image.assetHash,asset.hash);assert.equal(image.geometry.x,22)
 evidence.splitOfflineInputVerified=true;evidence.replacementSaved=true
 const semantic=checkpointContents(jsonToSnapshot(ea.store.project().toJSON()))
 aa.provider.destroy();bb.provider.destroy();await stopSidecar();await startSidecar()
 const last=client('doc:1:structure3:save4',config.alice);await until(()=>last.provider.isSynced,'published room restart')
 assert.equal(checkpointContents(jsonToSnapshot(new SemanticBlockStore(last.document,schema).project().toJSON())),semantic)
 evidence.publishedRoomRestartVerified=true
 const record=await json('/revisions/'+saved.revision);evidence.savedAuthorName=record.authorName
 const unknownURL=native.origin+'/v1/documents/unknown'
 const unknownRequest=(route:string)=>fetch(unknownURL+route,{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.unknownToken}`},signal:AbortSignal.timeout(30_000)})
 const source=client('unknown:0:typography2:save4',config.unknownToken);await until(()=>source.provider.isSynced&&!source.provider.hasUnsyncedChanges,'unknown-outcome legacy peer ready')
 const originalUnknown=(await(await unknownRequest('/images')).json()).entries[0]
 const unknownText=legacyText(source.document);source.document.transact(()=>unknownText.insert(unknownText.length,' Confirmed once!',unknownText.toDelta().at(-1)?.attributes))
 await until(()=>!source.provider.hasUnsyncedChanges,'unknown-outcome body sent');dropCanonicalReply=true
 const failed=await requestCoordinatedSave(source.provider,await checkpointDigest(jsonToSnapshot(TiptapTransformer.fromYdoc(source.document,'default'))),undefined,30_000,await imageDraftDigest(source.document));assert.equal(failed.status,'failed');assert.equal(lostCanonicalReplies,1)
 assert.equal((await(await unknownRequest('')).json()).revision,2,'the canonical save already committed before its reply was lost')
 await confirmProtocolReady(source.provider,AbortSignal.timeout(5000))
 const settled=await fetch(sidecarURL+'/v1/documents/unknown/collaboration/negotiate',{method:'POST',headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.unknownToken}`},signal:AbortSignal.timeout(60_000)});assert.equal(settled.status,200,'migration must settle the original checkpoint attempt');assert.equal((await settled.json()).collaborationEpoch,1)
 assert.equal((await(await unknownRequest('')).json()).revision,2,'settling a lost reply must not create a duplicate canonical revision')
 const attempts=checkpointRequests.filter(value=>value.documentId==='unknown');assert.equal(attempts.length,2);assert.equal(attempts[0].id,attempts[1].id,'the durable checkpoint ID must be reused')
 source.provider.destroy();const recovered=client('unknown:1:structure3:save4',config.unknownToken);await until(()=>recovered.provider.isSynced,'unknown-outcome migrated room ready')
 const recoveredText=new SemanticBlockStore(recovered.document,schema).project().textContent;assert.equal(recoveredText,'Original Confirmed once!')
 const unknownExport=await unknownRequest('/export/docx?revision=2');assert.equal(unknownExport.status,200);await writeFile(config.root+'/unknown-commit.docx',Buffer.from(await unknownExport.arrayBuffer()));evidence.files.push({name:'unknown-commit.docx',revision:2,requiredText:['Original Confirmed once!'],onceText:'Confirmed once!',expectedAsset:originalUnknown.assetHash})
 evidence.unknownCanonicalCommitSettled=true;evidence.unknownCanonicalCommitNotDuplicated=true
 await writeFile(config.root+'/sidecar-migration-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS actual sidecar migration: packet drain, durable unknown reply, restart, dirty body/images and structural sockets')
}finally{
 releaseAuth?.();providers.forEach(provider=>provider.destroy());detach.reverse().forEach(close=>close());docs.forEach(doc=>doc.destroy());await stopSidecar();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await log.close()
}
