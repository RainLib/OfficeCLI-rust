import {FixedHistory} from './fixedHistory.ts'
import {api,ApiError,type Session} from './api.ts'
import {TextDraftStore,type TextDraft} from './textDrafts.ts'
import {ImageDraftStore,type ImageDraft} from './imageDrafts.ts'
import {captureFixedEdits,fixedEditPatch,submitFixedEdits,verifyFixedReceipt,type FixedEditAttempt,type FixedEditReceipt} from './saveEdits.ts'

export type FixedDraftState={version:3;texts:Array<[string,TextDraft]>;images:Array<[string,ImageDraft]>;attempt:FixedEditAttempt|null;uploadInterrupted?:boolean}
export type FixedPersistence={write:(state:FixedDraftState)=>Promise<void>;flush:()=>Promise<void>}

/** One owner per window. Pending request identity survives every network or
 * receipt failure. A retry reads its immutable receipt before resending it. */
export class FixedSaveController {
  readonly history:FixedHistory
  private attempt:FixedEditAttempt|null
  private work:Promise<number>|null=null
  private closed=false
  private abort=new AbortController()
  private version=0
  private listeners=new Set<()=>void>()
  private detach:Array<()=>void>=[]
  constructor(readonly session:Session,readonly texts:TextDraftStore,readonly images:ImageDraftStore,private persistence:FixedPersistence|null=null,restored:FixedEditAttempt|null=null){
    this.history=new FixedHistory(session,texts,images,()=>this.pending||this.busy||images.saving)
    this.attempt=restored
    if(restored){texts.beginSave(restored.texts);images.beginSave(restored.images)}
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  snapshot=()=>this.version
  private changed(){this.version++;this.listeners.forEach(listener=>listener())}
  get pending(){return !!this.attempt}
  get busy(){return !!this.work}
  continueWithoutBackup(){
    if(this.busy)throw new Error('Save is in progress')
    this.persistence=null;this.changed()
  }
  state():FixedDraftState{return structuredClone({version:3,texts:this.texts.entries(),images:this.images.entries(),attempt:this.attempt,uploadInterrupted:this.images.uploading})}
  async connect(){
    if(this.detach.length)throw new Error('Fixed controller already connected')
    const update=()=>{if(!this.closed)void this.persistence?.write(this.state()).catch(()=>{/* Journal exposes its persistent failure status. */})}
    this.detach=[this.texts.subscribe(update),this.images.subscribe(update)]
    await this.persistence?.write(this.state())
  }
  private live(){if(this.closed)throw new Error('Fixed editor closed')}
  private async persist(){await this.persistence?.write(this.state());this.live()}
  private release(sent:FixedEditAttempt){this.texts.endSave(sent.texts);this.images.endSave(sent.images)}
  private async receipt(sent:FixedEditAttempt):Promise<FixedEditReceipt|null>{
    const response=await api(this.session,'/edits/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixedEditPatch(this.session,sent)),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])})
    const result=await response.json() as FixedEditReceipt&{status:string}
    this.live()
    if(result.patchId!==sent.id)throw new Error('invalidSaveReceipt')
    if(result.status==='missing')return null
    if(result.status!=='committed')throw new Error('invalidSaveReceipt')
    await verifyFixedReceipt(sent,result);return result
  }
  private async accept(sent:FixedEditAttempt,result:FixedEditReceipt){
    this.live()
    this.texts.acknowledge(sent.texts,result.revision,result.nodeHashes??{})
    this.images.acknowledge(sent.images,result.revision,result.images??[])
    this.attempt=null;this.release(sent);this.changed()
    // A committed server receipt remains valid if the local acknowledgement
    // write fails. The retained disk attempt resolves to this same receipt.
    try{await this.persist()}catch{if(this.closed)throw new Error('Fixed editor closed')}
    return result.revision
  }
  save(revision:number,onlyImage?:string):Promise<number>{
    if(this.history.busy)return Promise.reject(new Error('historyBusy'))
    this.history.stopCapturing()
    if(this.work)return this.work
    const work=this.performSave(revision,onlyImage).finally(()=>{if(this.work===work){this.work=null;this.changed()}})
    this.work=work;this.changed();return work
  }
  private async performSave(revision:number,onlyImage?:string){
    this.live()
    if(this.session.scope!=='write')throw new Error('readOnlyMode')
    if(this.images.uploading)throw new Error('imageUploadPending')
    let sent=this.attempt
    if(sent){const result=await this.receipt(sent);if(result)return this.accept(sent,result)}
    else{
      sent=captureFixedEdits(revision,this.texts,this.images,onlyImage)
      if(!sent)return revision
      this.attempt=sent;this.texts.beginSave(sent.texts);this.images.beginSave(sent.images);this.changed()
      try{await this.persist()}catch(error){this.attempt=null;this.release(sent);this.changed();throw error}
    }
    this.live()
    try{
      const result=await submitFixedEdits(this.session,sent,AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)]))
      return await this.accept(sent,result)
    }catch(error){
      this.live()
      // A failure can happen after canonical commit (including invalid/missing
      // response bytes). Resolving first also handles an original in-flight
      // request racing with its retry, without allocating another patchId.
      const result=await this.receipt(sent).catch(()=>undefined)
      if(result)return this.accept(sent,result)
      if(result===null && error instanceof ApiError && error.status>=400 && error.status<500){
        this.attempt=null;this.release(sent);this.changed();await this.persist();throw error
      }
      throw new Error('fixedSaveUnknown')
    }
  }
  async flush(){await this.persistence?.flush()}
  dispose(){this.history.dispose();this.closed=true;this.abort.abort();this.detach.forEach(detach=>detach());this.detach=[]}
}
