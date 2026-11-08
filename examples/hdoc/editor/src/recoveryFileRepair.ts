import * as Y from 'yjs'
import {stableExtension} from './extensionRegistry.ts'
import {pendingNodeResource,nodeResourceHash,type NodeResourceRepair,type WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import {recoveryFiles,recoveryHash,type RecoveryTransferReview} from './semanticRecoveryTransfer.ts'

export type RecoveryFileRepair={review:RecoveryTransferReview;items:Array<NodeResourceRepair&{actualHash:string}>}
export function recoveryFileIntegrityError(error:unknown):boolean{
 const seen=new Set<unknown>();let value=error
 for(let n=0;n<5&&value instanceof Error&&!seen.has(value);n++){seen.add(value);if(value.message==='word-node-resource-integrity')return true;value=value.cause}
 return false
}
type Context={current:Y.Doc;signal:AbortSignal;canWrite:()=>boolean;authorize:(signal:AbortSignal)=>Promise<void>}
async function checked(review:RecoveryTransferReview,input:Context){input.signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly');if(await recoveryHash(Y.encodeStateAsUpdate(input.current))!==review.stamp)throw Error('recoveryArchiveChanged');input.signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly')}
/** A separate review, not an alternate import mode. Only exact same-identity
 * device tasks whose bytes fail the declared digest can be offered. */
export async function reviewRecoveryFileRepair(review:RecoveryTransferReview,input:Context&{pendingFiles:()=>Promise<WordNodeResourceDraft<ResourceNodePayload>[]>}):Promise<RecoveryFileRepair>{
 await checked(review,input);await input.authorize(input.signal);await checked(review,input)
 const incoming=await recoveryFiles(review),pending=await input.pendingFiles(),items:RecoveryFileRepair['items']=[]
 if(pending.length>16)throw Error('recoveryArchiveLimit')
 for(const replacement of incoming){
  const original=pending.find(value=>value.id===replacement.id);if(!original)continue
  if(!pendingNodeResource(original)||stableExtension({...original,bytes:[],phase:''})!==stableExtension({...replacement,bytes:[],phase:''}))throw Error('recoveryArchiveFileRepairChanged')
  const snapshot={...structuredClone(original),bytes:Uint8Array.from(original.bytes)}
  if(await nodeResourceHash(replacement.bytes)!==replacement.resource.hash)throw Error('recoveryArchiveInvalid')
  const actualHash=await nodeResourceHash(snapshot.bytes)
  if(actualHash!==snapshot.resource.hash)items.push({original:snapshot,replacement,actualHash})
 }
 await checked(review,input)
 if(!items.length)throw Error('recoveryArchiveFileRepairChanged')
 return{review,items}
}
/** Authorization and document observation precede a final synchronous guard
 * inside the device transaction. It never uploads or applies document state. */
export async function applyRecoveryFileRepair(plan:RecoveryFileRepair,input:Context&{repairFiles:(items:readonly NodeResourceRepair[],guard:()=>void)=>Promise<number>}){
 const invalidated=new AbortController(),signal=AbortSignal.any([input.signal,invalidated.signal]),changed=()=>invalidated.abort(Error('recoveryArchiveChanged')),context={...input,signal}
 input.current.on('update',changed);let attempted=false
 try{
  await checked(plan.review,context);await input.authorize(signal);await checked(plan.review,context)
  const guard=()=>{signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly')}
  guard();attempted=true;const count=await input.repairFiles(plan.items,guard);guard();return count
 }catch(cause){if(attempted)throw Error('recoveryArchiveFileRepairUncertain',{cause});throw cause}
 finally{input.current.off('update',changed)}
}
