/** Stopped-owner recovery. No live room is loaded, no request is replaced,
 * and historical confirmation never installs a stale room as today's head. */
import {createHash} from 'node:crypto'
import {WordCheckpointJournal,type WordSaveCapsule} from './wordCheckpointJournal.ts'
import {readWordPendingLink,wordLinkPendingHash,matchesWordLinkRecord,type WordPendingLink} from './wordLinkProof.ts'
import {verifyWordLinkReceipt,type WordRegionProjection} from './wordRegionStore.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;protocol:'hcd-word-regions/2';authorize:(pending:Readonly<WordPendingLink>)=>Promise<WordTopologyMember>}
type Result={capsule:WordSaveCapsule;tip:string;headRevision:number;historical:boolean}
const headers={'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1','X-HCD-Word-Link-Version':'1'}
const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
function context(options:Options){
 const guard=()=>{options.assertStopped();options.lease.assert()}
 const json=async(route:string,init?:RequestInit)=>{
  guard();const signal=AbortSignal.timeout(30000),response=await awaitRecoveryResponse(()=>options.request(route,{...init,headers:{...headers,...init?.headers},signal}),signal);guard()
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error(`word-link-recovery:${response.status}`)}
  const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-link-response-limit');guard();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }
 const authority=async(pending:WordPendingLink)=>{
  const auth=await json('/auth');if(options.protocol!=='hcd-word-regions/2'||auth.scope!=='write'||auth.collaborationProtocol!==options.protocol||auth.collaborationEpoch!==options.journal.scope.epoch)throw Error('word-authority-changed')
  requireTopologyMember(await options.authorize(structuredClone(pending)),pending.actor,pending.request.actor);guard()
 }
 const maintain=async()=>{guard();await options.lease.renew();guard()}
 const head=async(expected?:number)=>{const response=await json('/revisions?limit=1'),revision=response?.headRevision;if(!Number.isSafeInteger(revision)||revision<0||expected!==undefined&&revision!==expected)throw Error('canonical-changed');return revision as number}
 const prepared=(pending:WordPendingLink)=>({coordinatorId:options.journal.scope.lineage,transaction:pending.request,candidateLayoutHash:pending.candidateLayoutHash,reviewHash:pending.reviewHash})
 return{guard,json,authority,maintain,head,prepared}
}

/** Dispatch only an already durable request. A failed response leaves its
 * identity unchanged; retry first observes the native history, not a new ID. */
export async function submitPreparedWordLink(options:Options):Promise<Result>{
 const c=context(options),{journal,lease}=options;c.guard();const saved=await journal.load();c.guard()
 if(saved?.capsule.version!==5)throw Error('word-link-pending-unresolved')
 const pending=saved.capsule.pendingLink??saved.capsule.linkAcknowledgement?.pending;if(!pending)throw Error('word-link-pending-unresolved')
 await c.maintain();await c.authority(pending);await lease.recordJournal(journal.knownHashes());c.guard()
 if(saved.capsule.pendingLink){
  const head=await c.head(),base=pending.request.expectedRevision
  if(head===base){
   const record=await c.json(`/revisions/${base}`);if(record.revision!==base||record.rootHash!==saved.capsule.base.rootHash)throw Error('word-link-baseline-invalid')
   if(await journal.topologyAbandoned(pending.request.transactionId))throw Error('word-topology-cancelled');c.guard();await c.authority(pending)
   await c.json('/word/link-transactions',{method:'POST',body:JSON.stringify(c.prepared(pending))});c.guard()
  }else if(head<base+1)throw Error('canonical-changed')
 }
 return recoverCommittedWordLink(options)
}

/** Confirmation may record an older committed target while preserving drafts.
 * Installation/promotion remains forbidden when canonical head has advanced. */
export async function recoverCommittedWordLink(options:Options):Promise<Result>{
 const c=context(options),{journal,lease}=options;c.guard();const saved=await journal.load();c.guard()
 if(saved?.capsule.version!==5)throw Error('word-link-pending-unresolved')
 const pending=readWordPendingLink(saved.capsule.pendingLink??saved.capsule.linkAcknowledgement?.pending,journal.scope.documentId),target=pending.request.expectedRevision+1
 await c.maintain();await c.authority(pending);await lease.recordJournal(journal.knownHashes());c.guard();const head=await c.head();if(head<target)throw Error('canonical-changed')
 if(saved.capsule.linkAcknowledgement){
  const record=await c.json(`/revisions/${target}`)
  if(!matchesWordLinkRecord(record,pending.request)||record.rootHash!==saved.capsule.base.rootHash)throw Error('word-link-receipt-invalid')
  await c.authority(pending);await c.head(head);return{capsule:saved.capsule,tip:saved.hash,headRevision:head,historical:head!==target}
 }
 const [previous,baseRecord,record]=await Promise.all([c.json(`/editor?revision=${pending.request.expectedRevision}`),c.json(`/revisions/${pending.request.expectedRevision}`),c.json(`/revisions/${target}`)])
 const issue=async(update:Uint8Array)=>{
  await c.maintain();await c.authority(pending);await c.head(head)
  const response=await c.json('/word/link-receipt',{method:'POST',body:JSON.stringify({apiHash:journal.scope.apiHash,pendingHash:wordLinkPendingHash(pending),initialUpdateHash:createHash('sha256').update(update).digest('hex'),prepared:c.prepared(pending)})}),{projection,...proof}=response as {projection:WordRegionProjection;[key:string]:unknown}
  if(!journal.verifyLinkReceipt(record,pending,proof,saved.hash,update))throw Error('word-link-receipt-invalid')
  verifyWordLinkReceipt(previous,projection,pending.request);await c.authority(pending);await c.head(head)
  return{projection,proof}
 }
 const first=await issue(Uint8Array.of(0));await c.authority(pending);await c.head(head)
 const result=await journal.acknowledgeLink(record,baseRecord,previous,first.projection,saved.hash,c.guard,async update=>{
  const last=await issue(update);if(ordered(last.projection)!==ordered(first.projection))throw Error('word-link-projection-invalid');return last.proof
 })
 c.guard();await lease.recordJournal(journal.knownHashes());c.guard();await c.authority(pending);await c.head(head)
 return{...result,headRevision:head,historical:head!==target}
}

/** The caller retains the stopped-room fence until a new host is installed.
 * A historical confirmation cannot advance into a stale editable baseline. */
export async function promoteRecoveredWordLink(options:Options,pendingInput:WordPendingLink):Promise<Result>{
 const c=context(options),{journal,lease}=options,pending=readWordPendingLink(pendingInput,journal.scope.documentId)
 c.guard();const identity=await journal.linkRecoveryIdentity(pending.request.transactionId);c.guard();if(ordered(identity.pending)!==ordered(pending)||!identity.acknowledged)throw Error('word-link-pending-unresolved')
 await c.maintain();await c.authority(pending);await lease.recordJournal(journal.knownHashes());c.guard()
 const head=await c.head();if(head!==identity.revision)throw Error('word-link-historical-review-required')
 const saved=await journal.load();c.guard();if(!saved||saved.capsule.base.revision!==head)throw Error('canonical-changed')
 await c.authority(pending);const result=identity.promoted?{capsule:saved.capsule,tip:saved.hash}:await journal.promoteLinkAcknowledgement(saved.hash,c.guard)
 c.guard();await lease.recordJournal(journal.knownHashes());c.guard();await c.authority(pending);await c.head(head)
 return{...result,headRevision:head,historical:false}
}
