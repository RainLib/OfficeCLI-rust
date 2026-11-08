import {readFixedReceipt} from './fixedReceiptRead.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import { api,ApiError, type Session } from './api.ts'
import { ImageDraftStore, validGeometry, matchesImageDraft } from './imageDrafts.ts'
import type { ImageNode } from './ImagePanel.tsx'
import { TextDraftStore } from './textDrafts.ts'

export type FixedEditAttempt={id:string;baseRevision:number;texts:Array<[string,import('./textDrafts.ts').TextDraft]>;images:Array<[string,import('./imageDrafts.ts').ImageDraft]>}
export type FixedEditReceipt={revision:number;patchId?:string;nodeHashes?:Record<string,string>;images?:ImageNode[]}
export function captureFixedEdits(revision:number,texts:TextDraftStore,images:ImageDraftStore,onlyImage?:string):FixedEditAttempt|null{
  if(images.uploading)throw new Error('imageUploadPending')
  const sentText=onlyImage?[]:texts.entries(),sentImages=images.entries().filter(([id])=>!onlyImage||id===onlyImage)
  if(sentText.some(([,draft])=>draft.remote||draft.stale)||sentImages.some(([,draft])=>draft.remote||draft.deleted||!validGeometry(draft.geometry)))throw new Error('draftsNotReady')
  if(!sentText.length&&!sentImages.length)return null
  return structuredClone({id:`edits-${crypto.randomUUID()}`,baseRevision:revision,texts:sentText,images:sentImages})
}
export function fixedEditPatch(session:Session,sent:FixedEditAttempt){
  return {schemaVersion:'hcd-patch/3',documentId:session.documentId,patchId:sent.id,baseRevision:sent.baseRevision,operations:[
    ...sent.texts.map(([nodeId,draft])=>({op:'text.splice',nodeId,start:0,deleteCount:[...draft.base.text].length,insertText:draft.text,precondition:{nodeHash:draft.base.nodeHash}})),
    ...sent.images.flatMap(([nodeId,draft])=>[
      ...(draft.restoreSource?[{op:'image.restoreSource',nodeId,precondition:{visualHash:draft.base.visualHash}}]:draft.assetHash?[{op:'image.replace',nodeId,assetHash:draft.assetHash,precondition:{visualHash:draft.base.visualHash}}]:[]),
      {op:'image.geometry',nodeId,geometry:draft.geometry,precondition:{visualHash:draft.base.visualHash}},
    ]),
  ]}
}
export async function verifyFixedReceipt(sent:FixedEditAttempt,result:FixedEditReceipt,signal?:AbortSignal){
  signal?.throwIfAborted()
  if(!Number.isSafeInteger(result.revision)||result.revision<=sent.baseRevision||(result.patchId!==undefined&&result.patchId!==sent.id)
    ||sent.texts.some(([id])=>!result.nodeHashes?.[id])||sent.images.some(([id,draft])=>!result.images?.some(image=>image.nodeId===id&&matchesImageDraft(image,draft))))throw new Error('invalidSaveReceipt')
  await Promise.all(sent.texts.map(async([id,draft])=>{
    const digest=()=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(draft.text))
    const bytes=await (signal?awaitRecoveryPreparation(digest,signal):digest())
    const hash=[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('')
    signal?.throwIfAborted();if(result.nodeHashes?.[id]!==hash)throw new Error('invalidSaveReceipt')
  }))
}
export async function submitFixedEdits(session:Session,sent:FixedEditAttempt,signal?:AbortSignal):Promise<FixedEditReceipt>{
  const wait=signal??AbortSignal.timeout(30_000)
  const result=await readFixedReceipt(()=>api(session,'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixedEditPatch(session,sent)),signal:wait}),wait) as FixedEditReceipt
  await verifyFixedReceipt(sent,result,wait);return result
}
/** One CAS transaction. Workspace controllers additionally persist and resolve attempts. */
export async function saveEdits(session:Session,revision:number,texts:TextDraftStore,images:ImageDraftStore,onlyImage?:string){
  const sent=captureFixedEdits(revision,texts,images,onlyImage)
  if(!sent)return revision
  texts.beginSave(sent.texts)
  try{images.beginSave(sent.images)
    try{const result=await submitFixedEdits(session,sent);texts.acknowledge(sent.texts,result.revision,result.nodeHashes??{});images.acknowledge(sent.images,result.revision,result.images??[]);return result.revision}
    finally{images.endSave(sent.images)}
  }finally{texts.endSave(sent.texts)}
}

/** Fetch only dirty text targets after reopening, including off-screen drafts. */
export async function refreshTextDrafts(session:Session,texts:TextDraftStore,onRevision:(revision:number)=>void,signal?:AbortSignal){
  const ids=texts.entries().map(([id])=>id)
  for(let start=0;start<ids.length;start+=4)await Promise.all(ids.slice(start,start+4).map(async id=>{
    try{
      const result=await(await api(session,`/text/${encodeURIComponent(id)}`,{signal})).json() as import('./textDrafts.ts').TextRun&{revision:number}
      if(signal?.aborted)return
      texts.reconcile([result],result.revision);onRevision(result.revision)
    }catch(error){if(error instanceof ApiError && error.status===404){const draft=texts.get(id);if(draft)texts.reconcileHashes({[id]:null},draft.revision)}else throw error}
  }))
}

export async function refreshImageDrafts(session: Session, images: ImageDraftStore, onRevision: (revision: number) => void, signal?: AbortSignal) {
  const ids = images.trackingIds
  for (let start = 0; start < ids.length; start += 4) {
    await Promise.all(ids.slice(start, start + 4).map(async id => {
      const response = await api(session, `/images/${encodeURIComponent(id)}`, { signal })
      const result = await response.json() as { revision: number; image: ImageNode | null }
      if (signal?.aborted) return
      if (result.image?.geometry) images.reconcile([result.image], result.revision)
      else images.markDeleted(id, result.revision)
      onRevision(result.revision)
    }))
  }
}
