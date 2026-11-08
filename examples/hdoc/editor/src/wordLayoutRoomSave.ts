/** Drain a version-3 room before saving it. The caller must fence every
 * packet/connection with the same gate and install a new coordinator before
 * releasing it. A successful save retires this room rather than mutating its
 * live Y.Doc with an offline receipt. */
import {MigrationUncertain,RoomMigrationGate} from './roomMigrationGate.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {saveStoppedWordDraft} from './wordStoppedSave.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type SaveActor={userId:string;displayName:string}
type Options={gate:RoomMigrationGate;room:WordSaveCoordinator;journal:WordCheckpointJournal;lease:Lease;actor:SaveActor;authorize:(actor:Readonly<SaveActor>)=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>}
export async function saveLayoutDraftRoom({gate,room,journal,lease,actor:inputActor,authorize,request}:Options){
 const id=journal.scope.documentId,operation='word-layout-room-save'
 const actor=structuredClone(inputActor)
 if(!room.ownsJournal(journal)||!room.isExperimentalLayoutDraftOnly())throw new Error('word-layout-coordinator-required')
 return gate.exclusive(id,async()=>{
  let held=room.isTopologyHeld(),sealed=held
  const guard=()=>{lease.assert();if(!gate.blocked(id))throw new Error('word-layout-room-active');if(held)room.assertTopologyHeld()}
  try{
   guard();if(!held){await room.drain();guard();room.holdForTopology();held=true;guard()}
   const authorizeMember=async()=>{const member=await authorize(structuredClone(actor));guard();requireTopologyMember(member,actor,actor)}
   await authorizeMember();room.sealTopologyHold();sealed=true
   return await saveStoppedWordDraft({journal,lease,request,assertStopped:guard,initiator:actor,authorizeMember})
  }catch(error){
   if(sealed)throw new MigrationUncertain(error)
   if(held){try{room.releaseTopologyHold()}catch{throw new MigrationUncertain(error)}}
   throw error
  }
 // Every caller must be separately authenticated; a concurrent request must
 // not inherit the first caller's result without running its own authorization.
 },undefined,operation,true,JSON.stringify([actor?.userId,actor?.displayName]),false)
}
