/** Save a durable layout-aware draft while its room remains stopped. The host
 * serializes all calls and journal operations under the same exclusive gate.
 * Unknown outcomes retain the exact request for the next invocation. */
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {prepareStoppedWordCheckpoint} from './wordStoppedCheckpoint.ts'
import {recoverPreparedWordCheckpoint} from './wordCheckpointRecovery.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;initiator:{userId:string;displayName:string};authorizeMember?:()=>Promise<void>;checkpointId?:string}
export async function saveStoppedWordDraft(options:Options){
 if(options.checkpointId!==undefined&&!/^[a-f0-9]{32}$/.test(options.checkpointId))throw new Error('word-checkpoint-id-invalid')
 const initiator=structuredClone(options.initiator)
 const guard=()=>{options.assertStopped();options.lease.assert()}
 guard();const saved=await options.journal.load();guard()
 if(!saved||saved.capsule.version!==3)throw new Error('word-checkpoint-pending-unresolved')
 if(saved.capsule.pending&&options.checkpointId!==undefined&&saved.capsule.pending.request.checkpointId!==options.checkpointId)throw new Error('word-checkpoint-id-mismatch')
 if(saved.capsule.pending&&(!saved.capsule.pending.initiator||saved.capsule.pending.initiator.userId!==initiator.userId||saved.capsule.pending.initiator.displayName!==initiator.displayName))throw new Error('word-checkpoint-initiator-mismatch')
 if(!saved.capsule.pending){
  const prepared=await prepareStoppedWordCheckpoint({...options,initiator});guard()
  if(!prepared.prepared)return{saved:false as const,revision:saved.capsule.base.revision,tip:prepared.tip}
 }
 const result=await recoverPreparedWordCheckpoint(options);guard()
 if(result.headAdvanced)throw new Error('canonical-changed')
 return{saved:true as const,revision:result.capsule.base.revision,tip:result.tip}
}
