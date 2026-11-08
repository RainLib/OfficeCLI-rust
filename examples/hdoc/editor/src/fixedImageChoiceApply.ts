import {api,type Session} from './api.ts'
import {fixedRecoveryHead} from './fixedRecoveryPreview.ts'
import {ImageDraftStore,validGeometry,type PositionedImage} from './imageDrafts.ts'
import type {FixedImageChoice} from './fixedImageFiles.ts'

/** Recheck identity, permission, and the image at a pinned server revision before
 * attaching a staged file. The caller must persist the resulting draft before
 * acknowledging the choice. A changed target is deliberately left for review. */
export async function applyFixedImageChoice(session:Session,sourceHash:string,drafts:ImageDraftStore,choice:FixedImageChoice,signal:AbortSignal){
 const revision=await fixedRecoveryHead(session,sourceHash,signal,true)
 const result=await(await api(session,`/images/${encodeURIComponent(choice.base.nodeId)}?revision=${revision}`,{signal})).json() as {revision:number;image:PositionedImage|null}
 const image=result?.image
 if(result?.revision!==revision||image!==null&&(!image||image.nodeId!==choice.base.nodeId||typeof image.visualHash!=='string'||!/^[a-f0-9]{64}$/.test(image.visualHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry)||image.assetHash!=null&&(typeof image.assetHash!=='string'||!/^[a-f0-9]{64}$/.test(image.assetHash))))throw new Error('fixed-image-choice-invalid-target')
 signal.throwIfAborted()
 if(!image||image.visualHash!==choice.base.visualHash)throw new Error('fixed-image-choice-target-changed')
 const existing=drafts.get(image.nodeId)
 if(existing&&(existing.deleted||existing.remote||existing.collaborationConflict||existing.restoreSource||existing.assetHash!==undefined&&existing.assetHash!==choice.hash))throw new Error('fixed-image-choice-draft-conflict')
 drafts.reconcile([image],revision)
 const reconciled=drafts.get(image.nodeId)
 if(reconciled&&(reconciled.deleted||reconciled.remote||reconciled.collaborationConflict||reconciled.restoreSource||reconciled.assetHash!==undefined&&reconciled.assetHash!==choice.hash))throw new Error('fixed-image-choice-draft-conflict')
 // A previous attempt may have attached the file before persistence failed.
 if(reconciled?.assetHash===choice.hash)return
 const operation=drafts.prepareReplacement(image,revision,choice.page)
 try{operation.commit(choice.hash)}finally{operation.finish()}
}
