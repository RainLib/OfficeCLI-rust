/** Stopped-room recovery for a durable layout-aware Word checkpoint.
 * The authenticated transport must attach the live owner headers to editor
 * and checkpoint calls; journal operations are serialized by the caller. */
import {WordCheckpointJournal,type WordSaveCapsule} from './wordCheckpointJournal.ts'
import type {WordRegionProjection} from './wordRegionStore.ts'
import type {ImageNode} from './ImagePanel.tsx'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;authorizeMember?:()=>Promise<void>;receiptFirst?:boolean}
type ConfirmationOptions=Omit<Options,'assertStopped'>&{assertJournalExclusive:()=>void}
export type WordCheckpointConfirmation={capsule:WordSaveCapsule;tip:string;headAdvanced?:boolean;projection?:WordRegionProjection}
const modelHeaders={'X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'}

export function recoverPreparedWordCheckpoint({assertStopped,...options}:Options):Promise<WordCheckpointConfirmation>{return confirmPreparedWordCheckpoint({...options,assertJournalExclusive:assertStopped})}

/** The live owner may keep accepting edits while confirming a previously
 * submitted capture. It must serialize journal writes for this phase, then
 * merge the acknowledged replica into its live Y.Doc before writing again. */
export async function confirmPreparedWordCheckpoint({journal,lease,request,assertJournalExclusive,authorizeMember,receiptFirst=false}:ConfirmationOptions):Promise<WordCheckpointConfirmation>{
 const guard=()=>{assertJournalExclusive();lease.assert()}
 const maintain=async()=>{guard();await lease.renew();guard()}
 const json=async(route:string,init?:RequestInit)=>{const response=await request(route,init);if(!response.ok)throw new Error(`word-checkpoint-recovery:${response.status}`);return response.json()}
 const authority=async()=>{const auth=await json('/auth');if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')}
 const head=async()=>{const value=await json('/revisions?limit=1');if(!Number.isSafeInteger(value.headRevision)||value.headRevision<0)throw new Error('word-checkpoint-head-invalid');return value.headRevision as number}
 guard();const saved=await journal.load();guard()
 if(!saved||saved.capsule.version!==3)throw new Error('word-checkpoint-pending-unresolved')
 await maintain();await authority();guard();await lease.recordJournal(journal.knownHashes());guard()
 const pending=saved.capsule.pending
 if(!pending){if(!saved.capsule.checkpointAcknowledgement&&!saved.capsule.unchangedAcknowledgement)throw new Error('word-checkpoint-pending-unresolved');const current=await head();if(current<saved.capsule.base.revision)throw new Error('canonical-changed');guard();return{capsule:saved.capsule,tip:saved.hash,headAdvanced:current!==saved.capsule.base.revision}}
 const base=pending.request.expectedRevision,target=base+1,current=await head();guard()
 if(current<base)throw new Error('canonical-changed')
 const baseRecord=await json(`/revisions/${base}`);guard()
 if(baseRecord.revision!==base||baseRecord.rootHash!==saved.capsule.base.rootHash)throw new Error('word-checkpoint-baseline-invalid')
 // Replaying the exact signed request also rechecks all contributors. A
 // network failure leaves the immutable pending request untouched.
 await maintain();await authority();guard();await authorizeMember?.();guard()
 const init={method:'POST',headers:{...modelHeaders,'Content-Type':'application/json'},body:JSON.stringify(pending.request)}
 let response:any,knownProof:any
 if(receiptFirst){
  const lookup=await request('/word/checkpoint-receipt',init);guard()
  if(!lookup.ok&&lookup.status!==404)throw new Error(`word-checkpoint-recovery:${lookup.status}`)
  if(lookup.ok){
   knownProof=await lookup.json();guard()
   if(knownProof.schemaVersion==='hcd-word-checkpoint-unchanged/2')response={saved:true,saveMode:'word-regions-unchanged',revision:knownProof.revision,rootHash:knownProof.rootHash,projection:await json(`/editor?revision=${base}`,{headers:modelHeaders}),unchangedReceipt:knownProof}
   else if(knownProof.schemaVersion==='hcd-word-checkpoint-receipt/1')response={saved:true,revision:knownProof.revision,rootHash:knownProof.rootHash,projection:await json(`/editor?revision=${target}`,{headers:modelHeaders})}
   else throw new Error('word-checkpoint-receipt-invalid')
   guard()
  }
 }
 // An absent receipt permits the exact original request, never a new identity.
 response??=await json('/word/checkpoints',init);guard()
 if(response.saved===true&&response.saveMode==='word-regions-unchanged'&&response.revision===base&&response.rootHash===saved.capsule.base.rootHash&&response.projection?.revision===base){
  await maintain();await authority();if(await head()<base)throw new Error('canonical-changed');guard();await authorizeMember?.();guard()
  const result=await journal.acknowledgeUnchanged(response.unchangedReceipt,baseRecord,response.projection,saved.hash,guard)
  guard();await lease.recordJournal(journal.knownHashes());guard();const latest=await head();if(latest<base)throw new Error('canonical-changed');guard();return {...result,headAdvanced:latest!==base,projection:response.projection}
 }
 if(response.saved!==true||response.revision!==target||!response.projection||response.projection.revision!==target)throw new Error('word-checkpoint-receipt-invalid')
 if(await head()!==target)throw new Error('canonical-changed')
 const [previous,record]=await Promise.all([json(`/editor?revision=${base}`,{headers:modelHeaders}),json(`/revisions/${target}`)])
 if(record.rootHash!==response.rootHash||!journal.verifyCheckpointRecord(record,pending.request))throw new Error('word-checkpoint-receipt-invalid')
 await maintain();await authority();guard()
 const proof=knownProof??await json('/word/checkpoint-receipt',init);guard()
 if(!journal.verifyCheckpointReceipt(proof,record,pending.request,saved.hash))throw new Error('word-checkpoint-receipt-invalid')
 const images:ImageNode[]=[]
 for(const item of pending.images??[]){
  await maintain();const result=await json(`/images/${encodeURIComponent(item.change.nodeId)}?revision=${target}`);guard()
  if(result.revision!==target||result.image?.nodeId!==item.change.nodeId)throw new Error('word-image-receipt-invalid')
  images.push(result.image)
 }
 await maintain();await authority();if(await head()!==target)throw new Error('canonical-changed');guard();await authorizeMember?.();guard()
 const result=await journal.acknowledgeCheckpoint(record,proof,baseRecord,previous as WordRegionProjection,response.projection as WordRegionProjection,images,saved.hash,guard)
 guard();await lease.recordJournal(journal.knownHashes());guard();if(await head()!==target)throw new Error('canonical-changed');guard()
 return {...result,projection:response.projection}
}
