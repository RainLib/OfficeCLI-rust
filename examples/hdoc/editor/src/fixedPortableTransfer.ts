import {api,type Session} from './api.ts'
import {fixedPortableLimits,openFixedPortableArchive} from './fixedPortableArchive.ts'
import {fixedRecoveryHead,fixedRecoveryPreview} from './fixedRecoveryPreview.ts'
import {repinFixedPortableAsset} from './fixedPortableAssets.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
import {recoveryResourcePool} from './recoveryResourceBatch.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import {validGeometry,type PositionedImage} from './imageDrafts.ts'
import type {FixedDraftJournal} from './fixedDraftJournal.ts'
import type {FixedImageFileJournal} from './fixedImageFiles.ts'
import type {FixedPortableJournal} from './fixedPortableJournal.ts'

/** Stage up to four assets concurrently. A partial transfer only pins assets;
 * it never imports a draft. Drain every started request on failure. */
export async function repinFixedPortableAssets(session:Session,hashes:readonly string[],resources:ReadonlyMap<string,Uint8Array>,signal:AbortSignal,check:()=>Promise<void>){
 signal.throwIfAborted()
 const scope={...session},items=[...new Set(hashes)].sort().map(hash=>{const data=resources.get(hash);if(!data)throw new Error('fixed-portable-integrity');return{hash,data:Uint8Array.from(data)}})
 let checking:Promise<void>|undefined
 const checkOnce=()=>checking??(checking=Promise.resolve().then(check).finally(()=>{checking=undefined}))
 await recoveryResourcePool(items.map(({hash,data},index)=>async transferSignal=>{
  if(index>=4){await awaitRecoveryPreparation(checkOnce,transferSignal);transferSignal.throwIfAborted()}
  await repinFixedPortableAsset(scope,hash,data,transferSignal)
 }),signal)
 if(items.length){await awaitRecoveryPreparation(checkOnce,signal);signal.throwIfAborted()}
}

/** The candidate stays private until an explicit confirmation. Reopening a
 * write-ahead copy always prepares a new comparison; it never resumes work. */
export async function prepareFixedPortableTransfer(input:{bytes:Uint8Array;session:Session;sourceHash:string;base:string;signal:AbortSignal}){
 input.signal.throwIfAborted()
 if(!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>fixedPortableLimits.file)throw new Error('fixed-portable-limit')
 const bytes=Uint8Array.from(input.bytes),session={...input.session},sourceHash=input.sourceHash,base=input.base,signal=input.signal
 const candidate=await openFixedPortableArchive(bytes,{session,sourceHash,base});signal.throwIfAborted()
 if(!candidate.state.texts.length&&!candidate.state.images.length&&!candidate.state.attempt&&!candidate.state.workbookBuffer&&!candidate.state.blankAttempt&&!candidate.state.blankInput&&!candidate.choices.length)throw new Error('fixed-portable-empty')
 const first=await fixedRecoveryPreview(session,sourceHash,candidate.state,signal)
 const choices=await Promise.all(candidate.choices.map(async choice=>{
  const result=await(await api(session,`/images/${encodeURIComponent(choice.base.nodeId)}?revision=${first.revision}`,{signal})).json() as {revision:number;image:PositionedImage|null},image=result?.image
  if(result?.revision!==first.revision||image!==null&&(!image||image.nodeId!==choice.base.nodeId||typeof image.visualHash!=='string'||!/^[a-f0-9]{64}$/.test(image.visualHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry)||image.assetHash!=null&&(typeof image.assetHash!=='string'||!/^[a-f0-9]{64}$/.test(image.assetHash))))throw new Error('fixed-portable-invalid-target')
  return {id:choice.id,name:choice.name,hash:choice.hash,base:choice.base,current:image,changed:!image||image.visualHash!==choice.base.visualHash}
 }))
 const head=await fixedRecoveryHead(session,sourceHash,signal)
 if(head!==first.revision)throw new Error('fixed-portable-review-changed')
 const archiveHash=await fixedImageHash(bytes);signal.throwIfAborted()
 const review=structuredClone({revision:head,state:candidate.state,pages:[first],choices,resourceCount:candidate.resources.size})
 return {
  review,
  imageBytes:(hash:string)=>{const value=candidate.resources.get(hash);return value?Uint8Array.from(value):null},
  loadPage:async(offset:number,signal:AbortSignal)=>{const page=await fixedRecoveryPreview(session,sourceHash,candidate.state,signal,offset);if(page.revision!==head)throw new Error('fixed-portable-review-changed');return page},
  archiveBytes:()=>Uint8Array.from(bytes),
  /** Hold the same cross-window lock used by image tasks for the whole import.
   * Two journals cannot share an IDB transaction: the write-ahead archive is
   * retained until resource staging and both idempotent writes complete. */
  confirm:async(options:{signal:AbortSignal;transfers:FixedPortableJournal;drafts:FixedDraftJournal;images:FixedImageFileJournal;locked:<T>(work:()=>Promise<T>)=>Promise<T>;notify?:()=>void})=>options.locked(async()=>{
   const live=()=>options.signal.throwIfAborted();live()
   if(await fixedRecoveryHead(session,sourceHash,options.signal,true)!==head)throw new Error('fixed-portable-review-changed')
   live();const record=await options.transfers.begin(bytes);if(record.id!==archiveHash)throw new Error('fixed-portable-integrity')
   // Choices have their own original bytes and stay pending for explicit review.
   // Only draft/request assets need staging for the existing save coordinator.
   const hashes=new Set<string>();for(const [,draft]of [...candidate.state.images,...(candidate.state.attempt?.images??[])])if(draft.assetHash)hashes.add(draft.assetHash)
   await repinFixedPortableAssets(session,[...hashes],candidate.resources,options.signal,async()=>{if(await fixedRecoveryHead(session,sourceHash,options.signal,true)!==head)throw new Error('fixed-portable-review-changed')})
   live();if(await fixedRecoveryHead(session,sourceHash,options.signal,true)!==head)throw new Error('fixed-portable-review-changed')
   if(record.phase==='complete')return {alreadyComplete:true}
   try{live();await options.images.importChoices(candidate.choices);options.notify?.();live();await options.drafts.importCopy(archiveHash,candidate.state);live();await options.transfers.complete(archiveHash)}finally{options.notify?.()}
   return {alreadyComplete:false}
  })
 }
}
