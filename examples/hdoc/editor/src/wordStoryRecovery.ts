/** Recover an already committed story while the room is stopped. The caller
 * must use the recovery-only native owner route and serialize journal access. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal,wordStoryPendingHash,type WordSaveCapsule,type WordPendingStory} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;protocol:'hcd-word-regions/1'|'hcd-word-regions/2';authorizeMember?:()=>Promise<void>}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
/** Submit only the durable, reviewed request. Unknown outcomes stay pending
 * and are reconciled by the native receipt on the next stopped owner. */
export async function submitPreparedWordStory(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped}=options
 const guard=()=>{assertStopped();lease.assert()}
 const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);if(!response.ok)throw new Error(`word-story-submit:${response.status}`);return response.json()}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==4)throw new Error('word-story-pending-unresolved')
 if(options.protocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 const pending=saved.capsule.pendingStory
 if(!pending)return recoverCommittedWordStory(options)
 if(!pending.copyChoices)throw new Error('word-story-copy-choices-required')
 await lease.renew();guard();const auth=await json('/auth');guard()
 if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!==options.protocol)throw new Error('word-authority-changed')
 await lease.recordJournal(journal.knownHashes());guard()
 const current=await json('/revisions?limit=1');guard()
 if(current.headRevision===pending.request.expectedRevision){
  const baseline=await json(`/revisions/${pending.request.expectedRevision}`);guard()
  if(baseline.revision!==saved.capsule.base.revision||baseline.rootHash!==saved.capsule.base.rootHash)throw new Error('word-story-baseline-invalid')
  await options.authorizeMember?.();guard()
  await json('/word/story-transactions',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,request:pending.request,intent:{baseLayoutHash:pending.request.baseLayoutHash,...pending.intent},story:pending.story,copyChoices:pending.copyChoices})});guard()
 }else if(current.headRevision!==pending.request.expectedRevision+1)throw new Error('canonical-changed')
 return recoverCommittedWordStory(options)
}
export async function recoverCommittedWordStory(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped,protocol}=options
 const guard=()=>{assertStopped();lease.assert()}
 const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);if(!response.ok)throw new Error(`word-story-recovery:${response.status}`);return response.json()}
 const maintain=async()=>{guard();await lease.renew();guard()}
 const authority=async()=>{const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!==protocol)throw new Error('word-authority-changed')}
 const head=async(revision:number)=>{const value=await json('/revisions?limit=1');guard();if(value.headRevision!==revision)throw new Error('canonical-changed')}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==4||(!saved.capsule.pendingStory&&!saved.capsule.storyAcknowledgement))throw new Error('word-story-pending-unresolved')
 await maintain();await authority();await lease.recordJournal(journal.knownHashes());guard()
 const pending=saved.capsule.pendingStory
 if(!pending){await head(saved.capsule.base.revision);return{capsule:saved.capsule,tip:saved.hash}}
 const target=pending.request.expectedRevision+1
 await head(target)
 const [previous,baseRecord,record]=await Promise.all([json(`/editor?revision=${pending.request.expectedRevision}`),json(`/revisions/${pending.request.expectedRevision}`),json(`/revisions/${target}`)])
 guard();if(baseRecord.revision!==saved.capsule.base.revision||baseRecord.rootHash!==saved.capsule.base.rootHash)throw new Error('word-story-baseline-invalid')
 const receipt=async(update:Uint8Array)=>{
  const response=await json('/word/story-receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiHash:journal.scope.apiHash,coordinatorId:journal.scope.lineage,pendingHash:wordStoryPendingHash(pending),initialUpdateHash:hash(update),request:pending.request})})
  guard();const {projection,...proof}=response as {projection:WordRegionProjection;[key:string]:unknown}
  if(!journal.verifyStoryReceipt(record,pending,proof,saved.hash,update))throw new Error('word-story-receipt-invalid')
  return{projection,proof}
 }
 // The first signed, fenced request obtains the native projection; its dummy
 // update is never published. The final receipt binds the actual Yjs baseline.
 const probe=new Uint8Array([0]);await maintain();await authority();await head(target)
 const first=await receipt(probe),doc=new Y.Doc()
 try{
  Y.applyUpdate(doc,Buffer.from(saved.capsule.document,'base64'))
  const model=new WordRegionStore(doc,wordRegionSchema(),journal.scope.documentId,previous.flowLayout,previous.flowLayoutHash)
  model.acceptStoryReceipt(previous,first.projection,pending.intent,pending.blocks)
  const update=Y.encodeStateAsUpdate(doc)
  await maintain();await authority();await head(target)
  const last=await receipt(update)
  await maintain();await authority();await head(target)
  await options.authorizeMember?.();guard()
  const result=await journal.acknowledgeStory(record,last.proof,baseRecord,previous,last.projection,update,saved.hash,guard)
  guard();await lease.recordJournal(journal.knownHashes());guard();await head(target)
  return result
 }finally{doc.destroy()}
}

/** Promotion for a stopped host already holding an exclusive admission gate.
 * The caller owns member authentication and must keep the room stopped. */
export async function promoteStoppedWordStory(options:Options):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped}=options,guard=()=>{assertStopped();lease.assert()}
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new Error(`word-story-promote:${response.status}`);return response.json()}
 guard();if(options.protocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 const saved=await journal.load();guard();if(!saved||saved.capsule.version===4&&!saved.capsule.storyAcknowledgement||saved.capsule.version===3&&saved.capsule.pending||![3,4].includes(saved.capsule.version))throw new Error('word-story-pending-unresolved')
 const authority=async()=>{const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!==options.protocol)throw new Error('word-authority-changed')}
 await lease.renew();guard();await authority();await lease.recordJournal(journal.knownHashes());guard()
 if((await json('/revisions?limit=1')).headRevision!==saved.capsule.base.revision)throw new Error('canonical-changed')
 await options.authorizeMember?.();await authority();guard()
 const result=saved.capsule.version===4?await journal.promoteStoryAcknowledgement(saved.hash,guard):{capsule:saved.capsule,tip:saved.hash}
 guard();await lease.recordJournal(journal.knownHashes());guard();if((await json('/revisions?limit=1')).headRevision!==result.capsule.base.revision)throw new Error('canonical-changed')
 await options.authorizeMember?.();guard();return result
}

/** Retain the original request and authenticated member through promotion.
 * A published tip whose lease acknowledgement was lost is retried in place. */
export async function promoteRecoveredWordStory(options:Options&{gate:RoomMigrationGate;pending:WordPendingStory;authorize:(pending:Readonly<WordPendingStory>)=>Promise<WordTopologyMember>}):Promise<{capsule:WordSaveCapsule;tip:string}>{
 const {journal,lease,request,assertStopped,gate,authorize}=options,pending=structuredClone(options.pending),identity=JSON.stringify(pending),id=journal.scope.documentId
 return gate.runHeld(id,'word-story-unlink',identity,async()=>{
 const guard=()=>{assertStopped();lease.assert();if(!gate.heldIdentity(id,'word-story-unlink',identity))throw Error('word-story-room-active')}
 const authorizeMember=async()=>{const member=await authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw Error(`word-story-promote:${response.status}`);return response.json()}
 guard();if(options.protocol!=='hcd-word-regions/2')throw Error('word-authority-changed');await authorizeMember()
 const saved=await journal.load();guard()
 if(!saved||saved.capsule.version===4&&(!saved.capsule.storyAcknowledgement||JSON.stringify(saved.capsule.storyAcknowledgement.pending)!==identity)||saved.capsule.version===3&&saved.capsule.pending||![3,4].includes(saved.capsule.version))throw Error('word-story-pending-unresolved')
 const authority=async()=>{const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw Error('word-authority-changed')}
 await lease.renew();guard();await authority();await lease.recordJournal(journal.knownHashes());guard()
 if((await json('/revisions?limit=1')).headRevision!==saved.capsule.base.revision)throw Error('canonical-changed')
 await authorizeMember();await authority();guard()
 const result=saved.capsule.version===4?await journal.promoteStoryAcknowledgement(saved.hash,guard):{capsule:saved.capsule,tip:saved.hash}
 guard();await lease.recordJournal(journal.knownHashes());guard()
 if((await json('/revisions?limit=1')).headRevision!==result.capsule.base.revision)throw Error('canonical-changed')
 await authorizeMember();guard();return result
 })
}
