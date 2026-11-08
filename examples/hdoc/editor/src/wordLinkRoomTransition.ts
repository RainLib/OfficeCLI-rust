/** Active link preparation retains the old room behind an exact gate until
 * the signed result is promoted and its replacement has been installed. */
import {MigrationUncertain,RoomMigrationGate} from './roomMigrationGate.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {wordLinkPendingHash,readWordPendingLink,type WordPendingLink} from './wordLinkProof.ts'
import {submitPreparedWordLink,promoteRecoveredWordLink} from './wordLinkRecovery.ts'
import {previewActiveWordLink} from './wordActiveLinkPreview.ts'
type Options={gate:RoomMigrationGate;room:WordSaveCoordinator;journal:WordCheckpointJournal;lease:{assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>};pending:WordPendingLink;authorize:(pending:Readonly<WordPendingLink>)=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>;protocol:'hcd-word-regions/2';assertClientsReady:()=>void;reviewHash:string}
export async function transitionWordLink(options:Options){
 const {gate,room,journal,lease,authorize}=options,pending=readWordPendingLink(options.pending,journal.scope.documentId),id=journal.scope.documentId
 if(!room.isLayoutAwareLive()||!room.ownsJournal(journal))throw Error('word-link-journal-mismatch')
 const clientsReady=()=>{const proof=options.assertClientsReady() as unknown;if(proof&&typeof(proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw Error('word-link-client-proof-must-be-synchronous')}}
 return gate.exclusive(id,async()=>{
  let held=room.isTopologyHeld(),prepared=held
  const guard=()=>{lease.assert();if(!gate.blocked(id))throw Error('word-link-room-active');if(held)room.assertTopologyHeld()}
  const authorizeMember=async()=>{const member=await authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor);return member}
  try{
   guard();if(!held){clientsReady();await room.drain();guard();clientsReady();room.holdForTopology();held=true;guard()}
   await authorizeMember();const saved=await journal.load();guard();if(!saved)throw Error('word-link-journal-missing')
   if(await journal.topologyAbandoned(pending.request.transactionId))throw Error('word-topology-cancelled');guard()
   if(saved.capsule.version===5){
    const original=saved.capsule.pendingLink??saved.capsule.linkAcknowledgement?.pending
    if(!original||wordLinkPendingHash(original)!==wordLinkPendingHash(pending))throw Error('word-link-pending-unresolved')
    room.sealTopologyHold();prepared=true
   }else{
    if(saved.capsule.version!==3||saved.capsule.pending||saved.capsule.base.revision!==pending.request.expectedRevision||saved.capsule.base.layoutHash!==pending.request.link.baseLayoutHash||!/^[a-f0-9]{64}$/.test(options.reviewHash))throw Error('word-link-review-changed')
    const link=pending.request.link,preview=await previewActiveWordLink({room,journal,selection:{sectionId:link.sectionId,kind:link.kind,variant:link.variant,transactionId:pending.request.transactionId},actor:pending.request.actor,assertOwnership:guard,assertHeld:guard,authorize:authorizeMember,request:options.request})
    guard();if(preview.reviewHash!==options.reviewHash||wordLinkPendingHash(preview.pending)!==wordLinkPendingHash(pending))throw Error('word-link-review-changed')
    await authorizeMember();clientsReady();guard()
    // An append error can mean the immutable record was published. Keep held.
    room.sealTopologyHold();prepared=true;await journal.prepareLink(pending,saved.hash,guard);guard()
   }
   return await submitPreparedWordLink({journal,lease,request:options.request,protocol:options.protocol,assertStopped:guard,authorize:authorizeMember})
  }catch(error){if(prepared)throw new MigrationUncertain(error);if(held)try{room.releaseTopologyHold()}catch{throw new MigrationUncertain(error)}throw error}
 },clientsReady,'word-story-link',true,JSON.stringify(pending),false)
}
/** Serialize promotion with the same retained active request; the stopped
 * recovery helper still checks the original signature, author and current head. */
export async function promoteHeldWordLink(options:Omit<Options,'room'|'assertClientsReady'|'reviewHash'>&{assertStopped:()=>void}){
 const pending=readWordPendingLink(options.pending,options.journal.scope.documentId),identity=JSON.stringify(pending),id=options.journal.scope.documentId
 return options.gate.runHeld(id,'word-story-link',identity,()=>promoteRecoveredWordLink({...options,assertStopped:()=>{options.assertStopped();if(!options.gate.heldIdentity(id,'word-story-link',identity))throw Error('word-link-room-active')}},pending))
}
