/** Active-room cancellation seals a never-prepared nonce in both durable
 * stores. It never discards a prepared/unknown content transaction. */
import type {WordPendingLink} from './wordLinkProof.ts'
import {MigrationUncertain,type RoomMigrationGate} from './roomMigrationGate.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal,WordLayoutPending,WordPendingStory} from './wordCheckpointJournal.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {readBoundedResponse} from './boundedResponse.ts'
type Options={gate:RoomMigrationGate;room:WordSaveCoordinator;journal:WordCheckpointJournal;pending:WordLayoutPending|WordPendingStory|WordPendingLink;assertOwnership:()=>void;assertClientsReady:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>}
async function confirmNativeCancellation(options:Options,guard:()=>void){
 const {pending}=options
 const response=await options.request('/word/topology-cancel',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({transactionId:pending.request.transactionId,actor:pending.request.actor})});guard()
 if(!response.ok)throw Error('word-active-layout-cancel-unavailable')
 const bytes=await readBoundedResponse(response,16384,AbortSignal.timeout(30000),'word-active-layout-cancel-limit'),receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));guard()
 if(!receipt||Object.keys(receipt).sort().join(',')!=='status,transactionId'||receipt.status!=='not-prepared'||receipt.transactionId!==pending.request.transactionId)throw Error('word-active-layout-cancel-invalid')
}
/** A signed cancellation already prevents preparation. Confirm its native seal
 * under packet admission without pausing or changing the live content room. */
export async function confirmCancelledActiveWordLayout(options:Options){
 const {gate,room,journal,pending}=options,release=gate.enter(pending.request.documentId)
 const guard=()=>{options.assertOwnership();if(!room.ownsJournal(journal))throw Error('word-layout-journal-mismatch')}
 const authorize=async()=>{requireTopologyMember(await options.authorize(),pending.actor,pending.request.actor);guard()}
 try{
  await authorize();const cancelled=await journal.topologyAbandoned(pending.request.transactionId);guard()
  if(!cancelled)return false
  await authorize();await confirmNativeCancellation(options,guard);await authorize();return true
 }finally{release()}
}
export async function cancelActiveWordLayout(options:Options){
 const {gate,room,journal,pending}=options,id=pending.request.documentId
 if(!room.ownsJournal(journal))throw Error('word-layout-journal-mismatch')
 const ready=()=>{const result=options.assertClientsReady() as unknown;if(result&&typeof(result as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});throw Error('word-layout-client-proof-must-be-synchronous')}}
 return gate.exclusive(id,async()=>{
  let held=false
  const guard=()=>{options.assertOwnership();if(!gate.blocked(id))throw Error('word-layout-room-active');if(held)room.assertTopologyHeld()}
  const authorize=async()=>{requireTopologyMember(await options.authorize(),pending.actor,pending.request.actor);guard()}
  try{
   guard();ready();await room.drain();guard();ready();room.holdForTopology();held=true;guard();await authorize()
   await journal.abandonUnpreparedTopology(pending.request.transactionId,guard);await authorize()
   await confirmNativeCancellation(options,guard)
   await authorize()
  }finally{if(held)try{room.releaseTopologyHold()}catch(error){throw new MigrationUncertain(error)}}
 },ready,'word-layout-cancel',false,JSON.stringify(pending),false)
}
