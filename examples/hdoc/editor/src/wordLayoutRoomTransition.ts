/** Exclusive-room layout submission. Online clients must quiesce before the
 * host gates packets and keeps the old room fenced through replacement. */
import {MigrationUncertain,RoomMigrationGate} from './roomMigrationGate.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordCheckpointJournal,type WordLayoutPending} from './wordCheckpointJournal.ts'
import {submitPreparedWordLayout} from './wordLayoutRecovery.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import {readWordLayout} from './wordRegions.ts'
import {readBoundedResponse} from './boundedResponse.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
/** The host must authenticate this exact layout actor independently of draft
 * contributors, who may be empty when the document has no text edits. */
type Options={gate:RoomMigrationGate;room:WordSaveCoordinator;journal:WordCheckpointJournal;lease:Lease;pending:WordLayoutPending;authorize:(pending:Readonly<WordLayoutPending>)=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>;protocol:'hcd-word-regions/2';assertClientsReady?:()=>void}
export async function transitionWordLayout(options:Options){
 const {gate,room,journal,lease,authorize,request,protocol}=options,pending=structuredClone(options.pending),id=journal.scope.documentId,operation='word-layout-change'
 if(!room.ownsJournal(journal))throw new Error('word-layout-journal-mismatch')
 const clientsReady=()=>{const proof=options.assertClientsReady?.() as unknown;if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw new Error('word-layout-client-proof-must-be-synchronous')}}
 return gate.exclusive(id,async()=>{
  let held=room.isTopologyHeld(),prepared=held
  const guard=()=>{lease.assert();if(!gate.blocked(id))throw new Error('word-layout-room-active');if(held)room.assertTopologyHeld()}
  try{
   guard();if(!held){clientsReady();await room.drain();guard();clientsReady();room.holdForTopology();held=true;guard()}
   const authorizeMember=async()=>{const member=await authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}
   await authorizeMember();const saved=await journal.load();guard()
   if(!saved)throw new Error('word-layout-journal-missing')
   if(await journal.topologyAbandoned(pending.request.transactionId))throw new Error('word-topology-cancelled');guard()
   if(saved.capsule.version===2){
    const recorded=saved.capsule.pendingLayout
    if(recorded?JSON.stringify(recorded)!==JSON.stringify(pending):!saved.capsule.layoutAcknowledgement||JSON.stringify(saved.capsule.layoutAcknowledgement.request)!==JSON.stringify(pending.request)||pending.actor.userId!==pending.request.actor.userId||pending.actor.displayName!==pending.request.actor.displayName)throw new Error('word-layout-pending-unresolved')
    room.sealTopologyHold();prepared=true
   }else{
    // A rejected proposal must not become an unrecoverable prepared journal.
    // Preflight is not a commit promise; the native transaction revalidates.
    if(saved.capsule.pending||saved.capsule.base.revision!==pending.request.expectedRevision||saved.capsule.base.layoutHash!==pending.request.edits.baseLayoutHash)throw new Error('word-layout-baseline-invalid')
    const response=await request('/word/layout-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction:pending.request})});guard()
    if(!response.ok)throw new Error(`word-layout-preflight:${response.status}`)
    const bytes=await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30_000),'word-layout-preflight-limit'),preview=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));guard()
    if(preview.revision!==saved.capsule.base.revision||preview.rootHash!==saved.capsule.base.rootHash||preview.baseLayoutHash!==saved.capsule.base.layoutHash)throw new Error('word-layout-preflight-invalid')
    const next=readWordLayout({layout:preview.layout,layoutHash:'0'.repeat(64),revision:preview.revision},preview.revision,2),current=room.model.layoutState()
    if(current.layoutHash!==saved.capsule.base.layoutHash||!matchesWordLayoutTransition(current.layout,next,pending.request))throw new Error('word-layout-preflight-invalid')
    await authorizeMember();guard();room.sealTopologyHold();prepared=true;await journal.prepareLayout(pending,saved.hash,guard);guard()
   }
   return await submitPreparedWordLayout({journal,lease,request,assertStopped:guard,protocol,authorizeMember})
  }catch(error){
   if(prepared)throw new MigrationUncertain(error)
   if(held){try{room.releaseTopologyHold()}catch{throw new MigrationUncertain(error)}}
   throw error
  }
 },clientsReady,operation,true,JSON.stringify(pending),false)
}
