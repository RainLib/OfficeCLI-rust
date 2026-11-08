import {request as httpRequest} from 'node:http'
import assert from 'node:assert/strict'
import {spawn,type ChildProcess} from 'node:child_process'
import {readFile,writeFile,open} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash,createHmac} from 'node:crypto'
import {nativeCheckpointProxy} from './hcd-word-sidecar-proxy.mts'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {imageDraftDigest,CollaborativeImageDraftStore,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {WordBrowserState} from '../examples/hdoc/editor/src/wordBrowserState.ts'
import {readWordBrowserProjection} from '../examples/hdoc/editor/src/wordBrowserProjection.ts'
import {SemanticHistory} from '../examples/hdoc/editor/src/semanticHistory.ts'
import {bridgeWordSession} from '../examples/hdoc/editor/src/wordSessionBridge.ts'
import {readWordActiveLayoutStatus} from '../examples/hdoc/editor/src/wordActiveLayoutClient.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),schema=wordRegionSchema(),protocol=c.layout?'hcd-word-regions/2':'hcd-word-regions/1',name=c.layout?'rich:1:wordregions2:save6':'rich:1:wordregions1:save5',url=`ws://127.0.0.1:${c.collabPort}?hcdNodeEdits=7&hcdWordRegions=${c.layout?'2&hcdWordLayout=1'+(c.activeLayout?'&hcdWordTopology=1':''):'1'}`,log=await open(c.root+'/sidecar.log','a')
const fault=c.layout?await nativeCheckpointProxy(c.origin):undefined,sidecarOrigin=fault?.origin??c.origin
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms)),until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const deadline=Date.now()+20_000;while(Date.now()<deadline){if(await check())return;await pause(30)}throw new Error('Timeout: '+label)}
async function api(route:string,token=c.alice,init:RequestInit={}){return fetch(c.apiUrl+route,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Collaboration-Epoch':'1','X-HCD-Collaboration-Protocol':protocol,...init.headers},signal:AbortSignal.timeout(30_000)})}
async function json(route:string,token=c.alice){const response=await api(route,token);assert.equal(response.status,200,await response.clone().text());return response.json()}
const initial=c.layout?c.initialProjection:await json('/editor?revision=1'),body=initial.flowLayout.sections[0].id,header=initial.flowLayout.stories.find((story:any)=>story.sourcePart==='word/header1.xml').id,footer=initial.flowLayout.stories.find((story:any)=>story.sourcePart==='word/footer2.xml').id
async function refresh(client:{document:Y.Doc;model:WordRegionStore;provider?:HocuspocusProvider;receipt?:any;baselineVerified?:boolean;token?:string;controller?:WordBrowserState}){
 const hash=client.document.getMap(wordRegionStoreField).get('layoutHash');if(!hash)return false
 if(client.controller){const projection=client.controller.projection;if(!client.controller.state().ready||!projection||projection.flowLayoutHash!==hash)return false;client.model=client.controller.model!;return true}
 if(c.layout&&(hash!==client.model.layoutState().layoutHash||!client.baselineVerified)){
  if(!client.receipt){client.provider!.sendStateless(JSON.stringify({type:'hcd-save-state'}));return false}
  const response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/word-room-projection`,{method:'POST',headers:{Authorization:`Bearer ${client.token??c.alice}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:1,revision:client.receipt.revision})})
  if(response.status===409){client.provider!.sendStateless(JSON.stringify({type:'hcd-save-state'}));return false}
  assert.equal(response.status,200,await response.clone().text());const value=await response.json();assert.equal(value.wordRegionVersion,2);assert.equal(value.saveState.wordLayoutVersion,1);if(value.projection.flowLayoutHash!==hash)return false;client.model.syncLayout(value.projection.flowLayout,value.projection.flowLayoutHash);client.baselineVerified=true
 }else if(hash!==client.model.layoutState().layoutHash){const projection=await json('/editor');if(projection.flowLayoutHash!==hash)return false;client.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)}return true
}
let child:ChildProcess|undefined,starts:number[]=[],clients:Array<{document:Y.Doc;provider:HocuspocusProvider;model:WordRegionStore;receipt?:any;baselineVerified?:boolean;token?:string;controller?:WordBrowserState}>=[]
async function start(layoutEnabled=!!c.layout){child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_API_URL:sidecarOrigin,HCD_COLLAB_PORT:String(c.collabPort),HCD_TOKEN_SECRET:c.secret,HCD_SIDECAR_STATE_DIR:c.root+'/sidecar',HCD_WORD_ROOMS:'1',HCD_WORD_LAYOUT_ROOMS:layoutEnabled?'1':'0'},stdio:['ignore',log.fd,log.fd]});starts.push(child.pid!);await until(async()=>{if(child!.exitCode!==null)throw new Error('sidecar exited');try{return(await fetch(`http://127.0.0.1:${c.collabPort}`,{signal:AbortSignal.timeout(500)})).ok}catch{return false}},'sidecar listening')}
async function stop(){if(!child)return;const old=child;child=undefined;old.kill('SIGTERM');await new Promise<void>(resolve=>{if(old.exitCode!==null)return resolve();old.once('exit',()=>resolve());setTimeout(()=>{if(old.exitCode===null)old.kill('SIGKILL')},2000).unref()})}
async function connect(token:string,room=name,endpoint=url){const document=new Y.Doc(),provider=new HocuspocusProvider({url:endpoint,name:room,document,token,WebSocketPolyfill:WebSocket}),model=new WordRegionStore(document,schema,'rich',initial.flowLayout,initial.flowLayoutHash);const client:typeof clients[number]={document,provider,model,token};if(c.layout)provider.on('stateless',({payload}:any)=>{let value:any;try{value=JSON.parse(payload)}catch{return}if(value.type==='hcd-save-status'&&value.wordRegionVersion===2&&(!client.receipt||value.stateSequence>client.receipt.stateSequence))client.receipt=value});if(c.layout){const session={documentId:'rich',token,scope:token===c.reader?'read' as const:'write' as const,format:'docx',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const,flowLayoutVersion:2 as const,apiUrl:c.origin+'/v1/documents',collabUrl:`ws://127.0.0.1:${c.collabPort}`};client.controller=new WordBrowserState({protocol:'hcd-word-regions/2',document,provider,scope:session.scope,projection:(revision,signal)=>readWordBrowserProjection(session,revision,signal)})}clients.push(client);await until(async()=>provider.isSynced&&document.getMap(wordRegionStoreField).size>0&&!provider.hasUnsyncedChanges&&await refresh(client),'regional client synchronized');return client}
function edit(client:typeof clients[number],region:string,text:string){const before=client.model.region(region),block=before.find(value=>value.node.isTextblock)!;client.model.reconcile(region,before,before.map(value=>value===block?{key:value.key,node:value.node.type.createChecked(value.node.attrs,client.model.schema.text(text,block.node.firstChild?.marks))}:value))}
const firstText=(model:WordRegionStore,region:string)=>model.region(region).find(value=>value.node.isTextblock)!.node.textContent
async function synced(...peers:typeof clients){await until(async()=>{if(!peers.every(peer=>!peer.provider.hasUnsyncedChanges))return false;if(!(await Promise.all(peers.map(refresh))).every(Boolean))return false;return peers.every(peer=>peer.model.contents()===peers[0].model.contents())},'all content and receipts synced')}
async function save(client:typeof clients[number]){if(client.controller){await until(()=>client.controller!.state().ready&&!client.provider.hasUnsyncedChanges,'browser model ready before save');const revision=await client.controller.save();assert.equal(client.controller.state().saved,true);return revision}const digest=createHash('sha256').update(client.model.contents()).digest('hex'),result=await requestCoordinatedSave(client.provider,digest,undefined,30_000,await imageDraftDigest(client.document));const wire=result as unknown as {nodeEditVersion:number;wordRegionVersion:number;stateId:string;stateSequence:number};assert.equal(wire.nodeEditVersion,7);assert.equal(wire.wordRegionVersion,c.layout?2:1);assert.match(wire.stateId,/^[a-f0-9]{32}$/);assert.ok(Number.isSafeInteger(wire.stateSequence)&&wire.stateSequence>0);assert.equal(result.status,'saved',JSON.stringify(result));assert.equal(result.pending,false);return result.revision!}
function closeClients(retain?:Y.Doc){for(const client of clients){client.controller?.dispose();client.provider.destroy();if(client.document!==retain)client.document.destroy()}clients=[]}
let activeEvidence:Record<string,unknown>={}
let retainedCleanup:(()=>void)|undefined
try{
 if(c.layout){
  await start(false)
  const rejected=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/negotiate`,{method:'POST',headers:{Authorization:`Bearer ${c.alice}`,'X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}});assert.equal(rejected.status,426)
  let denied=false;const doc=new Y.Doc(),blocked=new HocuspocusProvider({url,name,document:doc,token:c.alice,WebSocketPolyfill:WebSocket,onAuthenticationFailed:()=>{denied=true},onClose:()=>{denied=true}})
  try{await until(()=>denied,'layout switch off rejects room');assert.equal((await json('/revisions?limit=1')).headRevision,1)}finally{blocked.destroy();doc.destroy()}
  await stop()
 }
 await start();
 if(c.layout){
  const endpoint=`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/negotiate`,send=(headers:Record<string,string>)=>fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${c.alice}`,'X-HCD-Node-Edits-Version':'7',...headers}})
  assert.equal((await send({})).status,426);const accepted=await send({'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'});assert.equal(accepted.status,200);assert.equal((await accepted.json()).wordLayoutVersion,1)
 }
 const a=await connect(c.alice),b=await connect(c.bob);const before=a.model.region(body);a.model.reconcile(body,before,[before[1],before[0]]);edit(b,body,'Bob regional body 😀');edit(a,header,'Alice regional header 😀');edit(b,footer,'Bob regional footer 😀')
 const image=(await json('/images')).entries[0],images=new CollaborativeImageDraftStore(b.document);images.edit(image,1,{...image.geometry,width:Math.round(image.geometry.width*.9)},undefined,'width');await synced(a,b);const joint=await save(a);assert.equal(joint,2);await synced(a,b)
 let replacementAssetHash:string|undefined
 if(c.layout){
  const bytes=await readFile(c.root+'/replacement.png'),image=(await json('/images?revision=2')).entries[0],selection={id:randomUUID(),nodeId:image.nodeId,revision:2,visualHash:image.visualHash,clientId:b.document.clientID,seen:[],extension:'png',assetHash:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length},endpoint=`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/word-uploads`
  const send=(member:string,body:object|Uint8Array,id?:string,ack=true)=>fetch(endpoint+(id?`/${id}`:''),{method:id?'PUT':'POST',headers:{Authorization:`Bearer ${member}`,'Content-Type':id?'application/octet-stream':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Collaboration-Epoch':'1',...(ack?{'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}:{})},body:id?Uint8Array.from(body as Uint8Array):JSON.stringify(body)})
  assert.equal((await send(c.bob,{operation:'reserve',selection},undefined,false)).status,426)
  const reserved=await send(c.bob,{operation:'reserve',selection});assert.equal(reserved.status,200,await reserved.clone().text());assert.equal((await reserved.json()).record.actor.userId,'bob')
  assert.equal((await send(c.alice,bytes,selection.id)).status,404);assert.equal((await send(c.reader,bytes,selection.id)).status,403)
  const uploaded=await send(c.bob,bytes,selection.id);assert.equal(uploaded.status,200,await uploaded.clone().text());assert.equal((await uploaded.json()).record.phase,'applied');replacementAssetHash=selection.assetHash
  await until(()=>imageIntents(b.document).some(entry=>entry.assetHash===replacementAssetHash),'layout image upload applied');await synced(a,b)
 }
 // A saved projection rebinds source IDs. The guard must accept the next legal
 // edit and an author's own undo while retaining the other person's input.
 const history=b.model.structure.undoManager();history.stopCapturing();edit(b,header,'Bob temporary header');history.stopCapturing();edit(a,body,'Alice retained body 😀');await synced(a,b);assert.ok(history.undo());await synced(a,b);assert.match(a.model.project(header).textContent,/Alice regional header/);assert.match(b.model.project(body).textContent,/Alice retained body/);assert.equal(await save(a),3);history.destroy();await synced(a,b)
 // A poisoned client is disconnected before its default fragment or metadata
 // reaches the real room. Healthy peers must continue to use the same owner.
 let rejectedPackets=0
 for(const mode of ['legacy','metadata']){const bad=await connect(c.alice);bad.provider.on('close',()=>{rejectedPackets++});if(mode==='legacy')bad.document.getXmlFragment('default').insert(0,[new Y.XmlElement('paragraph')]);else bad.document.getMap('hcdSchema').set('typography',99);await until(()=>rejectedPackets>=(mode==='legacy'?1:2),'bad packet closed');bad.provider.destroy();assert.equal(a.document.getXmlFragment('default').length,0);assert.equal(a.document.getMap('hcdSchema').get('typography'),2)}
 let postsBeforeRestart:number|undefined
 if(c.layout){
  edit(a,header,'Header committed before a lost response');await synced(a,b);fault!.arm()
  const reply=await requestCoordinatedSave(a.provider,createHash('sha256').update(a.model.contents()).digest('hex'),undefined,30_000,await imageDraftDigest(a.document));assert.equal(reply.status,'failed');assert.equal(fault!.dropped(),true);assert.equal((await json('/revisions?limit=1')).headRevision,4)
  edit(a,body,'Alice retained body 😀 · Late after unknown response');await synced(a,b);postsBeforeRestart=fault!.posts()
 }
 closeClients();await stop();
 if(c.layout){
  const lineage=createHmac('sha256',c.secret).update(`word-room/1:${sidecarOrigin}:rich:1`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(c.root+'/sidecar',sidecarOrigin,'rich',1,lineage,c.secret,true,true),saved=await journal.load();assert.ok(saved?.capsule.pending);assert.equal(saved.capsule.pending.request.expectedRevision,3)
 }
 await start();let resumed=await connect(c.alice),peer=await connect(c.bob);assert.match(resumed.model.project(body).textContent,/Alice retained body/);if(c.layout){assert.match(resumed.model.project(body).textContent,/Late after unknown response/);assert.equal(fault!.posts(),postsBeforeRestart)}assert.match(resumed.model.project(footer).textContent,/Bob regional footer/);edit(resumed,header,'Header after room restart 😀');await synced(resumed,peer);assert.equal(await save(resumed),c.layout?5:4);await synced(resumed,peer)
 if(c.activeLayout){
  // The view/history survives, but its old controller and provider never
  // reconnect. The replacement transport must join with a fresh empty Doc.
  const retained=resumed,retainedImages=new CollaborativeImageDraftStore(retained.document),retainedManager=retained.model.structure.undoManager();let writableController=resumed.controller!
  const retainedHistory=new SemanticHistory(retainedImages,retainedManager,()=>writableController.state().readOnly,async(id,signal)=>(await api(`/images/${id}`,c.alice,{signal})).json(),Date.now,()=>!writableController.state().readOnly),detachImages=retainedImages.connect(),detachHistory=retainedHistory.connect()
  let bridge:ReturnType<typeof bridgeWordSession>|undefined,viewController:WordBrowserState|undefined
  retainedCleanup=()=>{viewController?.dispose();bridge?.dispose();detachHistory();detachImages();retainedManager.destroy();retained.document.destroy()}
  const ownBefore=firstText(retained.model,body),ownMarker=' · Own before page',peerMarker=' · Peer after page'
  retainedHistory.stopCapturing();edit(retained,body,ownBefore+ownMarker);retainedHistory.stopCapturing();await synced(resumed,peer);assert.equal(await save(resumed),6);await synced(resumed,peer)
  const disconnectedRounds:string[]=[]
  for(const client of [resumed,peer]){client.controller!.setTopologyInputPause(()=>()=>{});client.controller!.options.onDisconnect=event=>{assert.equal(event.reason,'word-browser-reconnect-required');if(event.topologyRequestId)disconnectedRounds.push(event.topologyRequestId)}}
  const projection=resumed.controller!.projection!,page=projection.flowLayout.sections[0].page,width=page.widthTwips===11906?12240:11906,transactionId='e'.repeat(32)
  const request={schemaVersion:'hcd-word-layout-transaction/1',documentId:'rich',transactionId,baseRevision:projection.revision,expectedRevision:projection.revision,actor:{userId:'alice',displayName:c.activeDisplayName??'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:projection.flowLayoutHash,changes:[{sectionId:body,field:'widthTwips',expected:page.widthTwips??null,value:width}]}}
  const status=(token=c.reader,id=transactionId)=>readWordActiveLayoutStatus({documentId:'rich',token,scope:token===c.reader?'read':'write',format:'docx',collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1,collabUrl:`ws://127.0.0.1:${c.collabPort}`},id,new AbortController().signal)
  assert.equal((await status()).status,'recovery-required')
  const send=(value:unknown,token=c.alice)=>fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/word-active-layout`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:1,request:value}),signal:AbortSignal.timeout(60000)})
  assert.equal((await send(request,c.reader)).status,403)
  const endpoint=`http://127.0.0.1:${c.collabPort}/v1/documents/rich/collaboration/word-active-layout`,headers={Authorization:`Bearer ${c.alice}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}
  const statusEndpoint=endpoint+'-status',statusBody=JSON.stringify({epoch:1,transactionId})
  assert.equal((await fetch(statusEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:statusBody})).status,401)
  assert.equal((await fetch(statusEndpoint,{method:'POST',headers:{Authorization:`Bearer ${c.reader}`},body:statusBody})).status,426)
  for(const body of [{epoch:2,transactionId},{epoch:1,transactionId:'invalid'},{epoch:1,transactionId,extra:true}])assert.equal((await fetch(statusEndpoint,{method:'POST',headers,body:JSON.stringify(body)})).status,400)
  assert.equal((await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${c.alice}`},body:'{}'})).status,426);for(const body of ['invalid-json','{}'])assert.equal((await fetch(endpoint,{method:'POST',headers,body})).status,400)
  const sendSplit=async()=>{const bytes=Buffer.from(JSON.stringify({epoch:1,request})),split=bytes.indexOf(Buffer.from('王'))+1;assert.ok(split>0);return new Promise<{status:number}>(resolve=>{const req=httpRequest(endpoint,{method:'POST',headers},response=>{response.resume();response.on('end',()=>resolve({status:response.statusCode!}))});req.on('error',()=>resolve({status:0}));req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),200)})}
  peer.controller!.setTopologyInputPause(()=>{throw Error('fixture-composition-busy')});const refused=await sendSplit();assert.equal(refused.status,409);await until(()=>![resumed,peer].some(client=>client.controller!.state().topologyPending),'refused round released')
  peer.controller!.setTopologyInputPause(()=>()=>{});fault!.armLayout();const lost=await send(request);assert.equal(lost.status,409);assert.equal(fault!.layoutDropped(),true);assert.equal((await json('/revisions?limit=1')).headRevision,7);assert.equal((await status()).status,'pending');assert.equal((await send(request,c.bob)).status,403);const applied=await send(request);assert.equal(applied.status,200,await applied.clone().text());const result=await applied.json();assert.equal(result.status,'installed');assert.equal(result.revision,7);assert.equal(fault!.layoutPosts(),1)
  assert.deepEqual(await status(),{schemaVersion:'hcd-word-active-layout-status/1',documentId:'rich',epoch:1,transactionId,status:'installed',revision:7});assert.equal((await status(c.reader,'f'.repeat(32))).status,'recovery-required')
  const repeated=await send(request);assert.equal(repeated.status,200,await repeated.clone().text());assert.deepEqual(await repeated.json(),result);assert.equal((await json('/revisions?limit=1')).headRevision,7)
  await until(()=>disconnectedRounds.length===2,'both paused old clients identify the completed round');assert.deepEqual(disconnectedRounds,[transactionId,transactionId])
  const changed=structuredClone(request);changed.edits.changes[0].value++;assert.equal((await send(changed)).status,409);assert.equal((await send(request,c.bob)).status,403)
  closeClients(retained.document);resumed=await connect(c.alice);peer=await connect(c.bob);writableController=resumed.controller!;assert.equal(resumed.controller!.projection!.flowLayout.sections[0].page.widthTwips,width);assert.match(resumed.model.project(body).textContent,/Late after unknown response/)
  const freshBytes=Y.encodeStateAsUpdate(resumed.document),originalClientId=retained.document.clientID;let seedUpdates=0;const onSeed=()=>{seedUpdates++};resumed.document.on('update',onSeed)
  bridge=bridgeWordSession({view:retained.model,wire:resumed.model,assertFresh:()=>{assert.equal(writableController.state().readOnly,false);assert.equal(resumed.provider.isSynced,true);assert.equal(resumed.provider.hasUnsyncedChanges,false)},detachPreviousTransport:()=>retained.provider.destroy(),assertWritable:()=>{assert.equal(writableController.state().readOnly,false)}})
  resumed.document.off('update',onSeed);assert.equal(seedUpdates,0);assert.deepEqual(Y.encodeStateAsUpdate(resumed.document),freshBytes);assert.equal(bridge.model.document.clientID,originalClientId)
  const viewSession={documentId:'rich',token:c.alice,scope:'write' as const,format:'docx',collaborationProtocol:'hcd-word-regions/2' as const,collaborationEpoch:1,collabUrl:`ws://127.0.0.1:${c.collabPort}`}
  viewController=new WordBrowserState({protocol:'hcd-word-regions/2',document:retained.document,provider:resumed.provider,scope:'write',projection:(revision,signal)=>readWordBrowserProjection(viewSession,revision,signal)});await until(()=>!!viewController?.state().ready&&!viewController.state().readOnly,'retained browser controller verified');writableController=viewController
  const saveView=()=>save({...resumed,document:retained.document,model:viewController!.model!,controller:viewController})
  const refreshView=()=>{const state=resumed.model.layoutState();bridge!.model.syncLayout(state.layout,state.layoutHash);assert.equal(bridge!.closed,false,bridge!.error?.message);assert.equal(bridge!.model.contents(),resumed.model.contents())}
  edit(peer,body,ownBefore+ownMarker+peerMarker);await synced(resumed,peer);assert.equal(await save(peer),8);await synced(resumed,peer);refreshView()
  await retainedHistory.step('undo');await synced(resumed,peer);assert.equal(await saveView(),9);await synced(resumed,peer);refreshView();assert.equal(firstText(bridge.model,body),ownBefore+peerMarker)
  await retainedHistory.step('redo');await synced(resumed,peer);assert.equal(await saveView(),10);await synced(resumed,peer);refreshView();assert.equal(firstText(bridge.model,body),ownBefore+ownMarker+peerMarker)
  edit({...resumed,model:bridge.model},body,firstText(bridge.model,body)+' · After active page change');await synced(resumed,peer);assert.equal(await saveView(),11);await synced(resumed,peer);refreshView()
  activeEvidence={unicodeActorSplitRequestVerified:true,actualSidecarActiveLayout:true,activeNativeTcpResponseLost:true,layoutSubmissions:fault!.layoutPosts(),activePageWidthTwips:width,compositionRefusalBeforeCommit:true,exactActiveRequestReplay:true,changedRequestAndWrongActorRejected:true,retiredRoomReplacedInSameSidecar:true,newClientsSavedAfterActiveLayout:true,oldControllersIdentifyExactRound:true,retainedSessionOwnHistory:true,retainedBrowserControllerSaves:true,freshTransportReceivedNoCachedSeed:true,retainedClientIdentity:true,readOnlyRoundStatusChecked:true,unknownRoundRequiresRecovery:true,pendingAndInstalledStatusChecked:true,statusAuthenticationAndModelAndEpochChecked:true,ownHistoryPeerRevision:8,ownHistoryUndoRevision:9,ownHistoryRedoRevision:10,activeFinalRevision:11,ownHistoryMarkers:{own:ownMarker,peer:peerMarker}}
 }
 const reader=await connect(c.reader);edit(reader,body,'READ ONLY MUST NOT REACH ROOM');const readResult=await requestCoordinatedSave(reader.provider,createHash('sha256').update(reader.model.contents()).digest('hex'),undefined,30_000,await imageDraftDigest(reader.document));assert.equal(readResult.status,'failed');assert.doesNotMatch(resumed.model.project(body).textContent,/READ ONLY/)
 const denied=[]
 for(const [room,endpoint]of [['rich:1:structure3:save4',url],[name,`ws://127.0.0.1:${c.collabPort}?hcdNodeEdits=7`]]){let failed=false;const doc=new Y.Doc(),provider=new HocuspocusProvider({url:endpoint,name:room,document:doc,token:c.alice,WebSocketPolyfill:WebSocket,onAuthenticationFailed:()=>{failed=true}});await until(()=>failed,'incompatible room rejected');provider.destroy();doc.destroy();denied.push(room)}
 const auth=await json('/auth'),access=await json('/access',c.manager);let revokedClosed=0;resumed.provider.on('close',()=>{revokedClosed++})
 const change=await api('/access',c.manager,{method:'POST',body:JSON.stringify({expectedGeneration:access.policy.generation,readers:['alice','bob','reader'],writers:['bob']})});assert.equal(change.status,200);await until(()=>revokedClosed>0,'revoked old writer disconnected')
 const current=await json('/auth',c.bob);assert.equal(current.collaborationEpoch,2);assert.equal(current.collaborationProtocol,protocol)
 const oldEpoch=await api('/collaboration/state',c['hcd-collaboration']);assert.equal(oldEpoch.status,409)
 const head=(await json('/revisions?limit=1',c.bob)).headRevision;assert.equal(head,c.activeLayout?activeEvidence.activeFinalRevision:c.layout?5:4)
 const evidence={...activeEvidence,scope:'Actual native API, production sidecar and real WebSocket clients; explicit synthetic native identity, no migration/browser/multi-instance claim',...(c.layout?{layoutRoomEnabled:true,pinnedProjectionViaMemberApi:true,browserControllerUsesActualSidecar:true,hostSwitchOffRejected:true,explicitNegotiationChecked:true,layoutReplacementUploaded:true,replacementAssetHash,tcpLostCheckpointRecoveredAfterRestart:true,lateAfterUnknownRetained:true,noResubmissionOnBootstrap:true,checkpointSubmissions:fault!.posts()}:{}),head,jointRevision:joint,bodyAndHeaderFooterAndImageSavedTogether:true,ownUndoPreservesPeerText:true,packetRejections:rejectedPackets,readOnlyWriteRejected:true,oldProtocolAndMissingClientAckRejected:true,sidecarRestart:{first:starts.at(-2),second:starts.at(-1),signedJournalRecovered:true},revocationClosesOldWriter:true,epochResetPreservesRegionalProtocol:true,oldEpochReadStatus:oldEpoch.status,initialEpoch:auth.collaborationEpoch,finalEpoch:current.collaborationEpoch,expected:{body:'Alice retained body 😀',header:'Header after room restart 😀',footer:'Bob regional footer 😀'}}
 await writeFile(c.root+'/socket-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{retainedCleanup?.();closeClients();await stop();await fault?.close();await log.close()}
