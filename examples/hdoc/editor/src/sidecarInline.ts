import * as Y from 'yjs'
import type {Schema} from '@tiptap/pm/model'
import {MigrationJournal} from './migrationJournal.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {SidecarMigration,MigrationRejected} from './sidecarMigration.ts'
import {legacyProtocol,inlineProtocol,type CollaborationSession} from './collaborationProtocol.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {projectionToJson,type Projection} from './schema.ts'
import {inlineRoomGuard} from './inlineRoomGuard.ts'
type Host={session:(id:string)=>Promise<CollaborationSession>;canonical:(id:string,session:CollaborationSession)=>Promise<Projection>;stateAbsent:(id:string,session:CollaborationSession)=>Promise<boolean>;active:(id:string)=>boolean;request:(id:string,route:string,init:RequestInit,session:CollaborationSession)=>Promise<Response>}
/** First initialization only. Existing durable or live rooms need a separate
 * reviewed conversion; they cannot be discarded by a schema registration. */
export function inlineRoomBootstrap(gate:RoomMigrationGate,journal:MigrationJournal,schema:Schema,host:Host){
 return new SidecarMigration(gate,journal,{
  session:host.session,request:host.request,
  freeze:id=>{if(host.active(id))throw new MigrationRejected(409,'inline-room-active')},
  async prepare(id,session){
   if(session.collaborationProtocol!==legacyProtocol||host.active(id)||!await host.stateAbsent(id,session))throw new MigrationRejected(409,'inline-state-exists')
   const projection=await host.canonical(id,session)
   if(projection.flowLayout)throw new MigrationRejected(426,'inline-regional-unsupported')
   const document=new Y.Doc({gc:false})
   try{
    const structure=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true});structure.initialize(schema.nodeFromJSON(projectionToJson(projection,{inlineContainers:true})))
    const metadata=document.getMap('hcdSchema');metadata.set('typography',2);metadata.set('sourceIdentity',1);metadata.set('inlineContainers',1)
    const guard=inlineRoomGuard(document,schema);guard.destroy()
    return{document,structure,sourceHash:'none',sourceBytes:new Uint8Array(),baseRevision:projection.revision,targetEpoch:session.collaborationEpoch+1}
   }catch(error){document.destroy();throw error}
  },committed:async()=>{},rollback:async()=>{},
 },inlineProtocol)
}
