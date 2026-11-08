/** Test-only Hocuspocus binding for a staged live replacement. Native identity,
 * permissions and the signed journal are supplied by the isolated harness. */
import assert from 'node:assert/strict'
import {Server,isTransactionOrigin} from '../examples/hdoc/editor/node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js'
import {WordSaveCoordinator} from '../examples/hdoc/editor/src/wordSaveCoordinator.ts'
import {WordRoomBinding} from '../examples/hdoc/editor/src/wordRoomBinding.ts'
import {WordRoomStages} from '../examples/hdoc/editor/src/wordRoomStages.ts'
import {WordTopologyRounds} from '../examples/hdoc/editor/src/wordTopologyRounds.ts'
import {RoomMigrationGate} from '../examples/hdoc/editor/src/roomMigrationGate.ts'
import {wordRoomGuard} from '../examples/hdoc/editor/src/wordRoomGuard.ts'
import {requireWordRoomClient} from '../examples/hdoc/editor/src/wordRoomClient.ts'
import {wordLayoutProtocol} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {wordRoomStatus} from '../examples/hdoc/editor/src/wordRoomHost.ts'
type Settings=Parameters<typeof WordSaveCoordinator.open>[0]
export async function liveReplacementHost(input:{id:string;name:string;gate:RoomMigrationGate;options:Settings;operation:string;identity:string;assertSource:()=>void}){
 const stages=new WordRoomStages(),releases=new WeakMap<object,()=>void>();let internal:object,hostDocument:any,owner:WordSaveCoordinator|undefined,guard:ReturnType<typeof wordRoomGuard>|undefined,disposing=false
 const rounds=new WordTopologyRounds<any>((peer,value)=>peer.sendStateless(JSON.stringify(value)),peer=>peer.context.wordTopologyVersion===1)
 const binding=new WordRoomBinding({...input.options,layoutAwareLive:true},()=>{stages.binding(input.name,internal)})
 const server=new Server({address:'127.0.0.1',port:0,quiet:true,debounce:10,maxDebounce:50,
  async onAuthenticate({documentName,token,requestParameters}:any){const leave=input.gate.enter(input.id);try{
   if(documentName!==input.name||!['alice','bob'].includes(token))throw Error('fixture-member-required')
   const user={userId:token,displayName:token==='alice'?'Alice':'Bob',scope:'write' as const,collaborationEpoch:0,collaborationProtocol:wordLayoutProtocol,coordinatedRestore:true,expiresAt:Math.floor(Date.now()/1000)+300}
   requireWordRoomClient({documentId:input.id,epoch:0,fixed:false,protocol:wordLayoutProtocol},user,requestParameters,true);return{...user,...(requestParameters.get('hcdWordTopology')==='1'?{wordTopologyVersion:1}:{})}
  }finally{leave()}},
  async onLoadDocument({context,document}:any){hostDocument=document;return stages.load(input.name,context,document)},
  async afterLoadDocument({document,context}:any){stages.binding(input.name,context,document);owner=await binding.attach(document,{autoSave:false,
    actorForOrigin:(origin:any)=>isTransactionOrigin(origin)&&origin.source==='connection'&&!origin.connection.readOnly?origin.connection.context:undefined,
    broadcast:state=>document.broadcastStateless(JSON.stringify(wordRoomStatus(state,wordLayoutProtocol)))})
    stages.attached(input.name,context,document,owner);guard=wordRoomGuard(owner.model,id=>owner!.imageRegion(id),{block:id=>owner!.canonicalBlockRegion(id),text:id=>owner!.canonicalTextRegion(id)},wordLayoutProtocol)},
  async beforeHandleMessage({connection}:any){releases.set(connection,input.gate.enter(input.id))},
  async afterHandleMessage({connection}:any){releases.get(connection)?.();releases.delete(connection)},
  async beforeSync({connection,type,payload}:any){input.options.assertOwnership?.();owner!.assertAcceptingPackets();if(!connection.readOnly&&(type===1||type===2))guard!.accept(payload)},
  async onStateless({connection,payload}:any){let message:any;try{message=JSON.parse(payload)}catch{return}if(message.type==='hcd-word-topology-ready'){rounds.accept(input.id,connection,message);return}if(message.type==='hcd-save-state')connection.sendStateless(JSON.stringify(wordRoomStatus(owner!.state(),wordLayoutProtocol)))},
  async beforeUnloadDocument({document}:any){if(stages.beforeUnload(input.name,document,owner))return;if(!disposing&&input.gate.blocked(input.id))throw Error('fixture-room-held')},
  async afterUnloadDocument(){stages.afterUnload(input.name,owner)},
 })
 internal=stages.reserve({id:input.id,name:input.name,operation:input.operation,identity:input.identity,gate:input.gate,lease:{assert:()=>{input.options.assertOwnership?.()}},binding,assertSource:input.assertSource},server.hocuspocus)
 const shutdown=async()=>{
  disposing=true
  if(stages.has(input.name)){
   if(input.gate.blocked(input.id))await stages.rollback(input.name,server.hocuspocus,()=>{guard?.destroy();guard=undefined})
   else{assert.ok(owner);stages.activate(input.name,owner,server.hocuspocus,false)}
  }
  server.hocuspocus.closeConnections(input.name);server.hocuspocus.flushPendingStores();const deadline=Date.now()+15_000
  while(server.hocuspocus.documents.has(input.name)){
   const document=server.hocuspocus.documents.get(input.name)!
   if(server.hocuspocus.shouldUnloadDocument(document))await server.hocuspocus.unloadDocument(document)
   if(!server.hocuspocus.documents.has(input.name))break
   if(Date.now()>=deadline)throw Error('fixture-replacement-unload-timeout')
   await new Promise(resolve=>setTimeout(resolve,25))
  }
  if(hostDocument&&!hostDocument.isDestroyed)hostDocument.destroy()
  await server.destroy();guard?.destroy()
 }
 try{
  await server.listen();const document=await server.hocuspocus.createDocument(input.name,new Request('http://127.0.0.1/internal-install'),'fixture-internal-install',{readOnly:false,isAuthenticated:true},internal)
  assert.ok(owner);assert.equal(owner.model.document,document);assert.equal(owner.isAutoSaveEnabled(),false)
  stages.assertInstalled(input.name,owner,server.hocuspocus)
  return{server,owner,dispose:shutdown,activate:()=>stages.activate(input.name,owner!,server.hocuspocus),pauseMembers:async(requestId:string)=>{const peers=()=>server.hocuspocus.documents.get(input.name)!.getConnections();await rounds.prepare(input.id,requestId,peers,()=>{if(input.gate.blocked(input.id))throw Error('fixture-admission-blocked')});rounds.assertReady(input.id,requestId,peers())},releaseMembers:(requestId:string)=>rounds.release(input.id,requestId)}
 }catch(error){try{await shutdown()}finally{binding.close()}throw error}
}
