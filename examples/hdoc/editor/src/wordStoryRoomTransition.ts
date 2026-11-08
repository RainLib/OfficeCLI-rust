/** Stopped-room coordinator for an explicitly upgraded regional protocol.
 * The host must keep the admission gate around every packet and connection. */
import {MigrationUncertain,RoomMigrationGate} from './roomMigrationGate.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordCheckpointJournal,wordStoryPendingHash,type WordPendingStory} from './wordCheckpointJournal.ts'
import {submitPreparedWordStory} from './wordStoryRecovery.ts'
import {previewActiveWordStory} from './wordActiveStoryPreview.ts'
type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={gate:RoomMigrationGate;room:WordSaveCoordinator;journal:WordCheckpointJournal;lease:Lease;pending:WordPendingStory;authorize:(pending:Readonly<WordPendingStory>)=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>;protocol:'hcd-word-regions/2';assertClientsReady?:()=>void;reviewHash?:string}
/** The host must authenticate the exact request actor, not just the room.
 * On success or an uncertain outcome the old room remains held. The host may
 * only release admission after installing an explicitly compatible room. */
export async function transitionWordStory(options:Options){
 const {gate,room,journal,lease,authorize,request,protocol}=options,pending=structuredClone(options.pending),id=journal.scope.documentId,operation='word-story-unlink'
 if(!room.ownsJournal(journal))throw new Error('word-story-journal-mismatch')
 const clientsReady=()=>{if(room.isLayoutAwareLive()&&!options.assertClientsReady)throw Error('word-story-client-proof-required');const proof=options.assertClientsReady?.() as unknown;if(proof&&typeof(proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw Error('word-story-client-proof-must-be-synchronous')}}
 return gate.exclusive(id,async()=>{
  let held=room.isTopologyHeld(),prepared=held
  const guard=()=>{lease.assert();if(!gate.blocked(id))throw new Error('word-story-room-active');if(held)room.assertTopologyHeld()}
  try{
   guard();if(!held){clientsReady();await room.drain();guard();clientsReady();room.holdForTopology();held=true;guard()}
   const authorizeMember=async()=>{const member=await authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}
   await authorizeMember();const saved=await journal.load();guard()
   if(!saved)throw new Error('word-story-journal-missing')
   if(await journal.topologyAbandoned(pending.request.transactionId))throw Error('word-topology-cancelled');guard()
   if(saved.capsule.version===4){
    const recorded=saved.capsule.pendingStory??saved.capsule.storyAcknowledgement?.pending
    if(JSON.stringify(recorded)!==JSON.stringify(pending))throw new Error('word-story-pending-unresolved')
    room.sealTopologyHold();prepared=true
   }else{
    if(room.isLayoutAwareLive()){
     if(saved.capsule.version!==3||saved.capsule.pending||saved.capsule.base.revision!==pending.request.expectedRevision||saved.capsule.base.layoutHash!==pending.request.baseLayoutHash||!options.reviewHash||!/^[a-f0-9]{64}$/.test(options.reviewHash))throw Error('word-story-review-changed')
     const preview=await previewActiveWordStory({room,journal,selection:{sectionId:pending.intent.sectionId,kind:pending.intent.kind,variant:pending.intent.variant,transactionId:pending.request.transactionId},actor:pending.request.actor,assertOwnership:guard,assertHeld:guard,authorize:()=>authorize(structuredClone(pending)),request})
     guard();if(preview.reviewHash!==options.reviewHash||wordStoryPendingHash(preview.pending)!==wordStoryPendingHash(pending))throw Error('word-story-review-changed')
     await authorizeMember();clientsReady();guard()
    }
    // Once preparation begins, an I/O error can mean the record was published.
    room.sealTopologyHold();prepared=true;await journal.prepareStory(pending,saved.hash,guard);guard()
   }
   return await submitPreparedWordStory({journal,lease,request,assertStopped:guard,protocol,authorizeMember})
  }catch(error){
   if(prepared)throw new MigrationUncertain(error)
   if(held){try{room.releaseTopologyHold()}catch{throw new MigrationUncertain(error)}}
   throw error
  }
 },clientsReady,operation,true,JSON.stringify(pending),false)
}
