import * as Y from 'yjs'
import {CollaborativeImageDraftStore,imageIntents,type SharedImageDraft} from './collaborativeImages.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {planRecoveryImage,type RecoveryImageChoice} from './recoveryImagePlan.ts'
import type {RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** Stage and commit one explicit image choice. Dependencies must read the
 * authenticated service; the packet and old intent are never authority. */
export async function commitRecoveryImage(input:{document:Y.Doc;store:CollaborativeImageDraftStore;draft:SharedImageDraft;reviewed:RecoveryImageBaselineReport;choices:RecoveryImageChoice;resources:ReadonlyMap<string,Uint8Array>;stamp:string;signal:AbortSignal;canWrite:()=>boolean;authorize:(signal:AbortSignal)=>Promise<void>;loadBaseline:(draft:SharedImageDraft,signal:AbortSignal)=>Promise<RecoveryImageBaselineReport>;pin:(hash:string,bytes:Uint8Array,signal:AbortSignal)=>Promise<void>}){
 if(!input.store.ownsDocument(input.document))throw Error('recovery-image-plan-invalid')
 const draft=structuredClone(input.draft),reviewed=structuredClone(input.reviewed),choices=structuredClone(input.choices)
 const stop=new AbortController(),signal=AbortSignal.any([input.signal,stop.signal]),changed=()=>stop.abort(new Error('recoveryArchiveChanged'))
 input.document.on('update',changed)
 const current=async()=>{
  signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly')
  const before=Y.encodeStateAsUpdate(input.document);if(await awaitRecoveryPreparation(()=>imageFileHash(before),signal)!==input.stamp)throw Error('recoveryArchiveChanged')
  signal.throwIfAborted();const after=Y.encodeStateAsUpdate(input.document)
  if(before.length!==after.length||before.some((byte,index)=>byte!==after[index]))throw Error('recoveryArchiveChanged')
  if(!input.canWrite())throw Error('recoveryArchiveReadOnly')
 }
 const checkedPlan=async()=>{
  const fresh=await input.loadBaseline(draft,signal);signal.throwIfAborted()
  if(JSON.stringify(fresh)!==JSON.stringify(reviewed))throw Error('recoveryArchiveChanged')
  return awaitRecoveryPreparation(()=>planRecoveryImage(draft,fresh,imageIntents(input.document),input.resources,choices),signal)
 }
 try{
  await current();await input.authorize(signal);await current()
  const plan=await checkedPlan();await current()
  if(plan.assetHash&&plan.assetBytes)await input.pin(plan.assetHash,plan.assetBytes,signal)
  await current();await input.authorize(signal);await current()
  const final=await checkedPlan();await current();signal.throwIfAborted()
  if(JSON.stringify({...plan,assetBytes:undefined})!==JSON.stringify({...final,assetBytes:undefined}))throw Error('recoveryArchiveChanged')
  input.document.off('update',changed)
  return input.store.applyRecovery(final.base,final.revision,final.geometry,final.assetHash)
 }finally{input.document.off('update',changed)}
}
