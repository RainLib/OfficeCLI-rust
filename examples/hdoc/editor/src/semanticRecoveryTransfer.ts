import {recoveryDigest} from './recoveryDigest.ts'
import {CollaborativeImageDraftStore,imageIntents,type SharedImageDraft} from './collaborativeImages.ts'
import {recoveryImagesAlreadyIntegrated} from './recoveryImageCausality.ts'
import {imageDraftContents} from './collaborativeImages.ts'
import {compareRecoveryImageBaselines,type RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import {readImageAssetBackup} from './imageAssetBackup.ts'
import {repinFixedPortableAsset} from './fixedPortableAssets.ts'
import {recoveryResourcePool} from './recoveryResourceBatch.ts'
import {commitRecoveryImage} from './recoveryImageCommit.ts'
import type {RecoveryImageChoice} from './recoveryImagePlan.ts'
import {extensionNodes} from './extensionNode.ts'
import {deletionReviews} from './deletionReview.ts'
import * as Y from 'yjs'
import type {Node as PmNode,Schema} from '@tiptap/pm/model'
import {api,ApiError,type Session} from './api.ts'
import {inlineProtocol,structuralProtocol} from './collaborationProtocol.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {restoreLocalDraft} from './localDrafts.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import {readNodeResourceBytes,archiveNodeResourceBytes} from './api.ts'
import {createSemanticRecoveryArchive,parseSemanticRecoveryArchiveAsync,parseSemanticRecoveryFileAsync,semanticRecoveryResources,semanticRecoveryLimits,type RecoveryCandidate,type RecoveryScope} from './semanticRecoveryArchive.ts'
import {awaitRecoveryPreparation,awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {applyRecoveryUpdate} from './recoveryImportOrigin.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {prepareInlineContainerHistoryGuard} from './inlineContainerPreservation.ts'
import {inlineContainerNodes} from './inlineContainerEdits.ts'
import {inlineRoomGuard} from './inlineRoomGuard.ts'
import type {SemanticImageChoice} from './semanticImageFiles.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import {validateNodeResources} from './extensionPortable.ts'

export const recoveryHash=recoveryDigest
export const recoveryStamp=(document:Y.Doc)=>recoveryHash(Y.encodeStateAsUpdate(document))
async function unchanged(document:Y.Doc,stamp:string,signal:AbortSignal){const captured=Y.encodeStateAsUpdate(document);if(await awaitRecoveryPreparation(()=>recoveryHash(captured),signal)!==stamp)throw new Error('recoveryArchiveChanged');signal.throwIfAborted();const current=Y.encodeStateAsUpdate(document);if(current.length!==captured.length||current.some((byte,index)=>byte!==captured[index]))throw new Error('recoveryArchiveChanged')}

/** These are read-only checks even when the canonical verifier uses POST.
 * Cancelling the wait does not imply the server stopped its inspection. */
export async function readRecoveryCheck(session:Session,route:string,cancellation:AbortSignal,init:RequestInit={},maxBytes=64*1024,timeoutMs=45_000){
 const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error('recoveryArchiveTimeout')),timeoutMs),signal=AbortSignal.any([cancellation,timeout.signal])
 try{const response=await awaitRecoveryResponse(()=>api(session,route,{...init,signal}),signal);return await readBoundedResponse(response,maxBytes,signal,'recoveryArchiveResponseLimit')}
 finally{clearTimeout(timer)}
}
async function recoveryCheckJson(session:Session,route:string,signal:AbortSignal,init:RequestInit={},timeoutMs=45_000){const bytes=await readRecoveryCheck(session,route,signal,init,64*1024,timeoutMs);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
export async function recoveryAuthority(session:Session,signal:AbortSignal,write=false){const current=await recoveryCheckJson(session,'/auth',signal);if(current.collaborationEpoch!==(session.collaborationEpoch??0)||current.collaborationProtocol!==session.collaborationProtocol||![structuralProtocol,inlineProtocol].includes(session.collaborationProtocol as typeof structuralProtocol|typeof inlineProtocol))throw new Error('recoveryArchiveScope');if(write&&(session.scope!=='write'||current.scope!=='write'))throw new Error('recoveryArchiveReadOnly');signal.throwIfAborted()}
export function httpRecoveryVerifier(session:Session,signal:AbortSignal){return async(bytes:Uint8Array,scope:Readonly<RecoveryScope>)=>{
 const query=new URLSearchParams({revision:String(scope.revision),rootHash:scope.rootHash,epoch:String(scope.epoch)}),result=await recoveryCheckJson(session,`/recovery/canonical/inspect?${query}`,signal,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob([Uint8Array.from(bytes)])},120_000)
 if(result.schemaVersion!=='hcd-recovery-canonical/1'||result.verified!==true||result.documentId!==scope.documentId||result.revision!==scope.revision||result.rootHash!==scope.rootHash||result.epoch!==scope.epoch||result.sha256!==await recoveryHash(bytes))throw new Error('recoveryArchiveInvalid')
 signal.throwIfAborted()
}}
export async function exportRecoveryArchive(input:{session:Session;document:Y.Doc;schema:Schema;pendingFiles:readonly WordNodeResourceDraft<ResourceNodePayload>[];pendingImages?:readonly SemanticImageChoice[];signal:AbortSignal}){
 const captured=new Y.Doc({gc:false});Y.applyUpdate(captured,Y.encodeStateAsUpdate(input.document));try{
 await recoveryAuthority(input.session,input.signal);const manifest=await recoveryCheckJson(input.session,'',input.signal),scope:RecoveryScope={documentId:input.session.documentId,epoch:input.session.collaborationEpoch??0,model:input.session.collaborationProtocol===inlineProtocol?'structure3-inline1':'structure3',revision:manifest.revision,rootHash:manifest.rootHash}
 const archive=await readRecoveryCheck(input.session,`/export/hcdz?revision=${scope.revision}`,input.signal,{},semanticRecoveryLimits.canonical,120_000)
 return createSemanticRecoveryArchive({scope,document:captured,schema:input.schema,canonical:archive,pendingFiles:input.pendingFiles,pendingImages:input.pendingImages,signal:input.signal,readImageResource:async (hash,signal)=>{try{return(await readImageAssetBackup(input.session,hash,signal)).bytes}catch(error){if(error instanceof ApiError&&error.status===404)throw new Error('recoveryArchiveImageUnavailable');throw error}},verifyCanonical:httpRecoveryVerifier(input.session,input.signal),readResource:(resource,signal)=>readNodeResourceBytes(input.session,resource,undefined,signal)})
 }finally{captured.destroy()}
}
function preview(doc:PmNode){let text='';const walk=(node:PmNode)=>{if(text.length>6000)return;if(node.isText)text+=node.text;else if(node.isLeaf)text+=node.attrs.extension?.fallback?.text??node.attrs.reference?.snapshot?.label??(node.type.name==='hardBreak'?'\n':'');else{node.forEach(walk);if(node.isBlock)text+='\n'}};walk(doc);const business=[...[...extensionNodes(doc).values()].map(entry=>entry.value),...inlineContainerNodes(doc).values()].slice(0,30).map(value=>`${value.fallback.text}\n${JSON.stringify(value.data)}${value.resources?.length?'\n'+value.resources.map(resource=>resource.name).join(' · '):''}`).join('\n\n').slice(0,12000);return{text:text.slice(0,6000),business,truncated:text.length>6000}}
export type RecoveryTransferReview={candidate:RecoveryCandidate;merged:Y.Doc;stamp:string;packetHash:string;deletions:number;before:ReturnType<typeof preview>;after:ReturnType<typeof preview>;currentImageDrafts:SharedImageDraft[];recoveredImageDrafts:SharedImageDraft[];imageBaselines:RecoveryImageBaselineReport|null;imageDraftsIntegrated:boolean;dispose:()=>void}
/** Restore a single reviewed image as a fresh local intent, independently of
 * importing text. The resource is pinned and the authoritative baseline is
 * fetched again immediately before the transaction. */
export async function commitReviewedRecoveryImage(review:RecoveryTransferReview,input:{session:Session;current:Y.Doc;store:CollaborativeImageDraftStore;intentId:string;choices:RecoveryImageChoice;signal:AbortSignal;canWrite:()=>boolean}){
 const drafts=imageIntents(review.candidate.document).filter(draft=>draft.intentId===input.intentId),items=review.imageBaselines?.items.filter(item=>item.intentId===input.intentId)
 if(drafts.length!==1||items?.length!==1||!review.imageBaselines)throw Error('recovery-image-plan-invalid')
 const reviewed={...review.imageBaselines,items}
 return commitRecoveryImage({document:input.current,store:input.store,draft:drafts[0],reviewed,choices:input.choices,resources:review.candidate.resources,stamp:review.stamp,signal:input.signal,canWrite:input.canWrite,authorize:signal=>recoveryAuthority(input.session,signal,true),loadBaseline:(draft,signal)=>compareRecoveryImageBaselines(input.session,[draft],signal),pin:(hash,bytes,signal)=>repinFixedPortableAsset(input.session,hash,bytes,signal)})
}
export async function prepareRecoveryTransfer(input:{session:Session;bytes:Uint8Array|Blob;current:Y.Doc;schema:Schema;registry?:NodeExtensionRegistry;inlineRegistry?:InlineContainerRegistry;signal:AbortSignal}):Promise<RecoveryTransferReview>{
 input.signal.throwIfAborted();const size=input.bytes instanceof Uint8Array?input.bytes.length:input.bytes instanceof Blob?input.bytes.size:0;if(!size||size>semanticRecoveryLimits.file)throw Error('semantic-recovery-limit')
 const bytes=input.bytes instanceof Uint8Array?Uint8Array.from(input.bytes):input.bytes,baseline=Y.encodeStateAsUpdate(input.current),session={...input.session},archive=await (bytes instanceof Uint8Array?parseSemanticRecoveryArchiveAsync(bytes,input.signal):parseSemanticRecoveryFileAsync(bytes,input.signal)),scope=archive.scope;if(scope.documentId!==session.documentId||scope.epoch!==(session.collaborationEpoch??0)||scope.model!==(session.collaborationProtocol===inlineProtocol?'structure3-inline1':'structure3'))throw new Error('recoveryArchiveScope')
 const stamp=await awaitRecoveryPreparation(()=>recoveryHash(baseline),input.signal),base=new Y.Doc({gc:false});Y.applyUpdate(base,baseline)
 let candidate:RecoveryCandidate|undefined,merged:Y.Doc|undefined
 try{
  await recoveryAuthority(session,input.signal);candidate=await archive.open({scope,schema:input.schema,verifyCanonical:httpRecoveryVerifier(session,input.signal),signal:input.signal})
  const recoveredImageDrafts=imageIntents(candidate.document),currentImageDrafts=imageIntents(base),imageBaselines=recoveredImageDrafts.length?await compareRecoveryImageBaselines(session,recoveredImageDrafts,input.signal):null;merged=restoreLocalDraft(candidate.document,base);const before=new SemanticBlockStore(base,input.schema,undefined,scope.model==='structure3-inline1'?{inlineContainers:true}:{}).project(),after=new SemanticBlockStore(merged,input.schema,undefined,scope.model==='structure3-inline1'?{inlineContainers:true}:{}).project();prepareExtensionHistoryGuard(before,input.registry)?.(after);if(scope.model==='structure3-inline1')prepareInlineContainerHistoryGuard(before,value=>input.inlineRegistry?.resolve(value))?.(after)
  const guard=scope.model==='structure3-inline1'?inlineRoomGuard(base,input.schema):new RoomProtocolGuard(base,structuralProtocol,shadow=>new SemanticBlockStore(shadow,input.schema).project().check());try{guard.accept(Y.encodeStateAsUpdate(merged))}finally{guard.destroy()}
  const imageDraftsIntegrated=recoveryImagesAlreadyIntegrated(candidate.document,base)&&imageDraftContents(base)===imageDraftContents(merged)
  let packetHash:string
  if(bytes instanceof Uint8Array)packetHash=await awaitRecoveryPreparation(()=>recoveryHash(bytes),input.signal)
  else{if(!('packetHash' in archive)||typeof archive.packetHash!=='string')throw Error('recoveryArchiveInvalid');packetHash=archive.packetHash}
  await unchanged(input.current,stamp,input.signal)
  const owned=candidate,copy=merged;return{candidate,merged,stamp,packetHash,deletions:deletionReviews(new SemanticBlockStore(merged,input.schema,undefined,scope.model==='structure3-inline1'?{inlineContainers:true}:{})).length,before:preview(before),after:preview(after),currentImageDrafts,recoveredImageDrafts,imageBaselines,imageDraftsIntegrated,dispose:()=>{owned.dispose();copy.destroy()}}
 }catch(error){candidate?.dispose();merged?.destroy();throw error}finally{base.destroy()}
}
/** The same packet/file identity is shared by full and file-only recovery. */
export async function recoveryFiles(review:RecoveryTransferReview){
 return Promise.all(review.candidate.pendingFiles.map(async value=>{const hash=await recoveryHash(new TextEncoder().encode(`hcd-recovery-file/1:${review.packetHash}:${value.id}`)),raw=hash.slice(0,32),id=`${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;return{...structuredClone(value),id,phase:'chosen' as const}}))
}
/** Copy pending attachments without applying packet CRDT operations. A later
 * explicit attachment review is still required. A storage operation may have
 * committed even when its final notification or cancellation fails. */
export async function importReviewedRecoveryFiles(review:RecoveryTransferReview,input:{current:Y.Doc;signal:AbortSignal;canWrite:()=>boolean;authorize:(signal:AbortSignal)=>Promise<void>;importFiles:(files:readonly WordNodeResourceDraft<ResourceNodePayload>[])=>Promise<number>}){
 const invalidated=new AbortController(),signal=AbortSignal.any([input.signal,invalidated.signal]),changed=()=>invalidated.abort(new Error('recoveryArchiveChanged'))
 input.current.on('update',changed)
 const check=async()=>{signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly');await unchanged(input.current,review.stamp,signal);if(!input.canWrite())throw Error('recoveryArchiveReadOnly')}
 try{
  await check();await input.authorize(signal);await check();const files=await recoveryFiles(review);if(!files.length)throw Error('recoveryArchiveInvalid')
  for(const file of files)if(file.bytes.byteLength!==file.resource.byteLength||await recoveryHash(file.bytes)!==file.resource.hash)throw Error('recoveryArchiveInvalid')
  await check();await input.authorize(signal);await check()
  let count:number
  try{count=await input.importFiles(files)}catch(cause){throw new Error('recoveryArchiveFilesRetained',{cause})}
  if(signal.aborted)throw new Error('recoveryArchiveFilesRetained')
  return count
 }finally{input.current.off('update',changed)}
}
/** Preserve unresolved image selections independently from packet image
 * intents. The device journal imports unseen choices in uncertain state and
 * never applies or uploads them automatically. */
export async function importReviewedRecoveryImages(review:RecoveryTransferReview,input:{current:Y.Doc;signal:AbortSignal;canWrite:()=>boolean;authorize:(signal:AbortSignal)=>Promise<void>;importImages:(images:readonly SemanticImageChoice[])=>Promise<unknown>}){
 const invalidated=new AbortController(),signal=AbortSignal.any([input.signal,invalidated.signal]),changed=()=>invalidated.abort(new Error('recoveryArchiveChanged'))
 input.current.on('update',changed)
 const check=async()=>{signal.throwIfAborted();if(!input.canWrite())throw Error('recoveryArchiveReadOnly');await unchanged(input.current,review.stamp,signal);if(!input.canWrite())throw Error('recoveryArchiveReadOnly')}
 try{
  await check();await input.authorize(signal);await check();const choices=structuredClone(review.candidate.pendingImages);if(!choices.length)throw Error('recoveryArchiveInvalid')
  for(const choice of choices)if(await recoveryHash(choice.bytes)!==choice.hash)throw Error('recoveryArchiveInvalid')
  await check();await input.authorize(signal);await check()
  try{await input.importImages(choices)}catch(cause){throw new Error('recoveryArchiveImageChoicesRetained',{cause})}
  if(signal.aborted)throw new Error('recoveryArchiveImageChoicesRetained')
 }finally{input.current.off('update',changed)}
}
/** All asynchronous permission, resource and private-file work precedes one
 * user history action. A changed comparison cannot write the current Y.Doc. */
export async function applyRecoveryTransfer(review:RecoveryTransferReview,input:{current:Y.Doc;history:Y.UndoManager;signal:AbortSignal;canWrite:()=>boolean;authorize:(signal:AbortSignal)=>Promise<void>;stageResource:(resource:import('./extensionPortable.ts').NodeResource,bytes:Uint8Array,signal:AbortSignal)=>Promise<void>;importFiles:(files:readonly WordNodeResourceDraft<ResourceNodePayload>[])=>Promise<unknown>;importImages?:(images:readonly SemanticImageChoice[])=>Promise<unknown>;withFileLock?:<T>(work:()=>Promise<T>)=>Promise<T>;pendingImages?:()=>Promise<SemanticImageChoice[]>;canWriteAfterImages?:()=>boolean}){
 if(!review.imageDraftsIntegrated||!recoveryImagesAlreadyIntegrated(review.candidate.document,input.current)||imageDraftContents(input.current)!==imageDraftContents(review.merged))throw new Error('semantic-recovery-image-drafts-review-required')
 const invalidated=new AbortController(),signal=AbortSignal.any([input.signal,invalidated.signal]),changed=()=>invalidated.abort(new Error('recoveryArchiveChanged'))
 input.current.on('update',changed)
 let fileImportAttempted=false,imageImportAttempted=false,applying=false
 const current=async()=>{signal.throwIfAborted();if(!input.canWrite())throw new Error('recoveryArchiveReadOnly');await unchanged(input.current,review.stamp,signal);if(!input.canWrite())throw new Error('recoveryArchiveReadOnly')}
 try{
 await current();await input.authorize(signal);await current()
 const resources=semanticRecoveryResources(review.candidate.store)
 // Keep at most four in flight, but do not leave a slot idle while an
 // unrelated resource is slow. Snapshot bytes before any asynchronous work;
 // each new transfer rechecks the review and cancellation before staging.
 const staged=resources.map(resource=>{const bytes=review.candidate.resources.get(resource.hash);if(!bytes)throw new Error('recoveryArchiveInvalid');return{resource:structuredClone(resource),bytes:Uint8Array.from(bytes)}})
 await recoveryResourcePool(staged.map(({resource,bytes})=>async batchSignal=>{await awaitRecoveryPreparation(current,batchSignal);batchSignal.throwIfAborted();await input.stageResource(resource,bytes,batchSignal)}),signal)
 await current()
 const files=await recoveryFiles(review)
 if(files.length){fileImportAttempted=true;await input.importFiles(files)}
 await input.authorize(signal);await current();signal.throwIfAborted()
 const images=review.candidate.pendingImages
 if(images.length){
  if(!input.importImages||!input.withFileLock||!input.pendingImages||!input.canWriteAfterImages)throw new Error('semantic-recovery-image-tasks-unsupported')
  imageImportAttempted=true;await input.importImages(images)
  await input.withFileLock(async()=>{
   signal.throwIfAborted();if(!input.canWriteAfterImages!())throw new Error('recoveryArchiveReadOnly')
   const expected=new Set(images.map(image=>image.id)),pending=await input.pendingImages!();signal.throwIfAborted()
   if(pending.some(image=>!expected.has(image.id)))throw new Error('recoveryArchiveChanged')
   await unchanged(input.current,review.stamp,signal);signal.throwIfAborted();if(!input.canWriteAfterImages!())throw new Error('recoveryArchiveReadOnly')
   input.current.off('update',changed);applying=true;applyRecoveryUpdate(input.current,Y.encodeStateAsUpdate(review.merged),input.history)
  })
 }else{if(!input.canWrite())throw new Error('recoveryArchiveReadOnly');input.current.off('update',changed);applying=true;applyRecoveryUpdate(input.current,Y.encodeStateAsUpdate(review.merged),input.history)}
 }catch(cause){
  if(applying)throw new Error('recoveryArchiveImportUncertain',{cause})
  if(fileImportAttempted&&imageImportAttempted)throw new Error('recoveryArchiveMixedTasksRetained',{cause})
  if(imageImportAttempted)throw new Error('recoveryArchiveImagesRetained',{cause})
  if(fileImportAttempted)throw new Error('recoveryArchiveFilesRetained',{cause})
  throw cause
 }finally{input.current.off('update',changed)}
}
export async function stageRecoveryResource(session:Session,resource:import('./extensionPortable.ts').NodeResource,bytes:Uint8Array,signal:AbortSignal){
 signal.throwIfAborted()
 validateNodeResources([resource])
 if(bytes.byteLength!==resource.byteLength)throw new Error('recoveryArchiveInvalid')
 // A current canonical reference can disappear before this recovery is saved.
 // Re-pin under the server's document/GC lock; a mere read does not create a
 // durable staging record. Older servers safely fall back to the file upload.
 const result=await archiveNodeResourceBytes(session,{bytes,mediaType:resource.mediaType,name:resource.name,key:resource.key,signal,expectedHash:resource.hash})
 if(result.hash!==resource.hash||result.byteLength!==resource.byteLength)throw new Error('recoveryArchiveInvalid')
}
