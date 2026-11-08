/** Server-only recovery of an already committed layout request. The caller
 * must have stopped the room and acquired the native owner for this epoch. */
import {WordCheckpointJournal,type WordSaveCapsule,type WordLayoutPending} from './wordCheckpointJournal.ts'
import type {WordRegionProjection} from './wordRegionStore.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
// The authenticated transport must attach the current lease headers to both
// layout routes; the stopped-room owner serializes journal operations.
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;protocol?:'hcd-word-regions/1'|'hcd-word-regions/2';authorizeMember?:()=>Promise<void>}
/** Submit only an already durable request while the room is stopped. A lost
 * response leaves the same pending request in the journal for the next owner;
 * a committed head is reconciled through the signed receipt, never guessed. */
export async function submitPreparedWordLayout(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped}=options
 const guard=()=>{assertStopped();lease.assert()}
 const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);if(!response.ok)throw new Error(`word-layout-submit:${response.status}`);return response.json()}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==2)throw new Error('word-layout-pending-unresolved')
 if(options.protocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 if(!saved.capsule.pendingLayout)return recoverCommittedWordLayout(options)
 const pending=saved.capsule.pendingLayout,base=pending.request.expectedRevision
 guard();await lease.renew();guard()
 const auth=await json('/auth');guard()
 if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 await lease.recordJournal(journal.knownHashes());guard()
 const current=await json('/revisions?limit=1');guard()
 if(current.headRevision===base){
  const baseline=await json(`/revisions/${base}`);guard()
  if(baseline.revision!==base||baseline.rootHash!==saved.capsule.base.rootHash)throw new Error('word-layout-baseline-invalid')
  await options.authorizeMember?.();guard()
  await json('/word/layout-transactions',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction:pending.request})});guard()
 }else if(current.headRevision!==base+1)throw new Error('canonical-changed')
 return recoverCommittedWordLayout(options)
}
export async function recoverCommittedWordLayout(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped}=options
 const guard=()=>{assertStopped();lease.assert()}
 const maintain=async()=>{guard();await lease.renew();guard()}
 const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);if(!response.ok)throw new Error(`word-layout-recovery:${response.status}`);return response.json()}
 const authority=async()=>{const auth=await json('/auth');if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!==(options.protocol??'hcd-word-regions/1'))throw new Error('word-authority-changed')}
 const head=async(revision:number)=>{const current=await json('/revisions?limit=1');if(current.headRevision!==revision)throw new Error('canonical-changed')}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==2||(!saved.capsule.pendingLayout&&!saved.capsule.layoutAcknowledgement))throw new Error('word-layout-pending-unresolved')
 // First re-establish the exact durable chain, including a previously
 // acknowledged tip if a prior owner-record response was lost.
 await maintain();await authority();guard();await lease.recordJournal(journal.knownHashes());guard()
 const pending=saved.capsule.pendingLayout
 if(!pending){await head(saved.capsule.base.revision);guard();return{capsule:saved.capsule,tip:saved.hash}}
 const target=pending.request.expectedRevision+1
 await head(target)
 const [previous,baseRecord,record]=await Promise.all([
  json(`/editor?revision=${pending.request.baseRevision}`),json(`/revisions/${pending.request.baseRevision}`),json(`/revisions/${target}`),
 ])
 if(baseRecord.revision!==pending.request.baseRevision||baseRecord.rootHash!==saved.capsule.base.rootHash)throw new Error('word-layout-baseline-invalid')
 await maintain();await authority();await head(target);guard()
 const response=await json('/word/layout-receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction:pending.request})})
 const {projection,...receipt}=response as {projection:WordRegionProjection;[key:string]:unknown}
 await maintain();await authority();await head(target);guard()
 await options.authorizeMember?.();guard()
 const result=await journal.acknowledgeLayout(record,receipt,previous as WordRegionProjection,projection,saved.hash,guard)
 // A failure here must leave the signed acknowledgement in the journal. The
 // next stopped owner retries recording its exact chain; it never resubmits.
 guard();await lease.recordJournal(journal.knownHashes());guard();await head(target);guard()
 return result
}

/** Promote only a verified layout acknowledgement while the old room remains
 * stopped. Replaying after a lost owner-record response re-registers the
 * durable tip, never creates another revision or publishes another request. */
export async function promoteRecoveredWordLayout(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped}=options
 const guard=()=>{assertStopped();lease.assert()}
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new Error(`word-layout-promote:${response.status}`);return response.json()}
 guard();if(options.protocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 const saved=await journal.load();guard()
 if(!saved||saved.capsule.version===2&&!saved.capsule.layoutAcknowledgement||saved.capsule.version===3&&saved.capsule.pending||![2,3].includes(saved.capsule.version))throw new Error('word-layout-pending-unresolved')
 const authority=async()=>{const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')}
 await lease.renew();guard();await authority()
 await lease.recordJournal(journal.knownHashes());guard()
 if((await json('/revisions?limit=1')).headRevision!==saved.capsule.base.revision)throw new Error('canonical-changed')
 await authority();guard();await options.authorizeMember?.();guard();const result=saved.capsule.version===2?await journal.promoteLayoutAcknowledgement(saved.hash,guard):{capsule:saved.capsule,tip:saved.hash}
 guard();await lease.recordJournal(journal.knownHashes());guard()
 if((await json('/revisions?limit=1')).headRevision!==result.capsule.base.revision)throw new Error('canonical-changed')
 guard();return result
}

/** Host entry point: serialize promotion under the original held request and
 * reauthenticate its member before and after the durable transition. The
 * low-level recovery above remains available to trusted stopped-room hosts. */
export async function promoteHeldWordLayout(options:Options&{gate:RoomMigrationGate;pending:WordLayoutPending;authorize:(pending:Readonly<WordLayoutPending>)=>Promise<WordTopologyMember>}):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {gate,journal,lease,authorize,assertStopped}=options,pending=structuredClone(options.pending),identity=JSON.stringify(pending),id=journal.scope.documentId
 return gate.runHeld(id,'word-layout-change',identity,async()=>{
  const guard=()=>{assertStopped();lease.assert();if(!gate.heldIdentity(id,'word-layout-change',identity))throw new Error('word-layout-room-active')}
  const authorizeMember=async()=>{const member=await authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}
  guard();await authorizeMember();const saved=await journal.load();guard()
  if(!saved||saved.capsule.version===2&&(!saved.capsule.layoutAcknowledgement||JSON.stringify(saved.capsule.layoutAcknowledgement.request)!==JSON.stringify(pending.request))||saved.capsule.version===3&&saved.capsule.pending||![2,3].includes(saved.capsule.version))throw new Error('word-layout-pending-unresolved')
  const result=await promoteRecoveredWordLayout({...options,assertStopped:guard,authorizeMember});guard();await authorizeMember();guard();return result
 })
}
