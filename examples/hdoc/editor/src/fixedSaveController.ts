import {readFixedReceipt} from './fixedReceiptRead.ts'
import {FixedHistory} from './fixedHistory.ts'
import {api,ApiError,type Session} from './api.ts'
import {TextDraftStore,type TextDraft,type TextRun} from './textDrafts.ts'
import {ImageDraftStore,type ImageDraft} from './imageDrafts.ts'
import {captureFixedEdits,fixedEditPatch,submitFixedEdits,verifyFixedReceipt,type FixedEditAttempt,type FixedEditReceipt} from './saveEdits.ts'
import type {BlankCreateAttempt} from './workbookBlankSave.ts'
import type {WorkbookBlankInput} from './workbookBlankInput.ts'

export type WorkbookInputBuffer={base:TextRun;revision:number;initial:string;text:string;sheetId:string;sheetName?:string;row:number;column:number}
export type FixedDraftState={version:3|4|5|6;texts:Array<[string,TextDraft]>;images:Array<[string,ImageDraft]>;attempt:FixedEditAttempt|null;uploadInterrupted?:boolean;workbookBuffer?:WorkbookInputBuffer;blankAttempt?:BlankCreateAttempt;blankInput?:WorkbookBlankInput}
export type FixedPersistence={write:(state:FixedDraftState)=>Promise<void>;flush:()=>Promise<void>}

/** One owner per window. Pending request identity survives every network or
 * receipt failure. A retry reads its immutable receipt before resending it. */
export class FixedSaveController {
  readonly history:FixedHistory
  private attempt:FixedEditAttempt|null
  private inputBuffer:WorkbookInputBuffer|null=null
  private blankInputBuffer:WorkbookBlankInput|null=null
  private blankSaveAttempt:BlankCreateAttempt|null=null
  private blankInputGeneration=0
  private blankAttemptGeneration=0
  private blankStateWriting=false
  private blankWritePreviousAttempt:BlankCreateAttempt|null=null
  private work:Promise<number>|null=null
  private receiptWork:Promise<number|null>|null=null
  private historyReceipt:{id:string;confirm:()=>void}|null=null
  private closed=false
  private abort=new AbortController()
  private version=0
  private listeners=new Set<()=>void>()
  private detach:Array<()=>void>=[]
  constructor(readonly session:Session,readonly texts:TextDraftStore,readonly images:ImageDraftStore,private persistence:FixedPersistence|null=null,restored:FixedEditAttempt|null=null){
    this.history=new FixedHistory(session,texts,images,()=>this.pending||this.busy||images.saving||!!this.inputBuffer||!!this.blankInputBuffer||!!this.blankSaveAttempt)
    this.attempt=restored
    if(restored){texts.beginSave(restored.texts);images.beginSave(restored.images)}
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  snapshot=()=>this.version
  private changed(){this.version++;this.listeners.forEach(listener=>listener())}
  get pending(){return !!this.attempt}
  get busy(){return !!this.work||!!this.receiptWork}
  get hasBackup(){return this.persistence!==null}
  get workbookBuffer(){return this.inputBuffer}
  get workbookBlankInput(){return this.blankInputBuffer}
  get workbookBlankAttempt(){return this.blankSaveAttempt}
  /** Persist only the blank-specific fields against the latest complete
   * snapshot, so unrelated drafts cannot be overwritten by a slow request. */
  async writeWorkbookBlankState(value:FixedDraftState){
    if(this.closed||!this.persistence)throw new Error('localDraftUnavailable')
    if(this.blankStateWriting)throw new Error('workbookBlankStateBusy')
    this.blankStateWriting=true
    const oldInput=this.blankInputBuffer,oldAttempt=this.blankSaveAttempt
    this.blankWritePreviousAttempt=oldAttempt?structuredClone(oldAttempt):null
    this.blankInputBuffer=value.blankInput?structuredClone(value.blankInput):null
    this.blankSaveAttempt=value.blankAttempt?structuredClone(value.blankAttempt):null
    const inputGeneration=++this.blankInputGeneration,attemptGeneration=++this.blankAttemptGeneration
    this.changed()
    try{await this.persistence.write(this.state());this.live();if(this.blankInputGeneration!==inputGeneration||this.blankAttemptGeneration!==attemptGeneration)throw new Error('workbookBlankStateChanged')}
    catch(error){
      if(this.blankInputGeneration===inputGeneration){this.blankInputBuffer=oldInput;this.blankInputGeneration++}
      if(this.blankAttemptGeneration===attemptGeneration){this.blankSaveAttempt=oldAttempt;this.blankAttemptGeneration++}
      this.changed()
      // A late input may already have queued a snapshot containing this
      // failed transition. Reconcile the complete current state after it.
      if(!this.closed)try{await this.persistence.write(this.state())}catch{/* The journal exposes its failure; retain the in-memory state. */}
      throw error
    }finally{this.blankStateWriting=false;this.blankWritePreviousAttempt=null}
  }
  setWorkbookBlankInput(value:WorkbookBlankInput|null){
    if(this.closed)throw new Error('Fixed editor closed')
    if(JSON.stringify(this.blankInputBuffer)===JSON.stringify(value))return
    this.blankInputBuffer=value?structuredClone(value):null;this.blankInputGeneration++;this.changed()
    const snapshot=this.state()
    // A late input must not persist an unconfirmed transition's attempted
    // request. The transition will either finish or reconcile this snapshot.
    if(this.blankStateWriting){if(this.blankWritePreviousAttempt)snapshot.blankAttempt=structuredClone(this.blankWritePreviousAttempt);else delete snapshot.blankAttempt;snapshot.version=snapshot.blankInput?6:snapshot.blankAttempt?5:snapshot.workbookBuffer?4:3}
    void this.persistence?.write(snapshot).catch(()=>{/* Keep the in-memory input if the journal fails. */})
  }
  setWorkbookBuffer(value:WorkbookInputBuffer|null){
    if(this.closed)throw new Error('Fixed editor closed')
    if(JSON.stringify(this.inputBuffer)===JSON.stringify(value))return
    this.inputBuffer=value?structuredClone(value):null;this.changed()
    void this.persistence?.write(this.state()).catch(()=>{/* The journal exposes failure without discarding input. */})
  }
  continueWithoutBackup(){
    if(this.busy||this.blankStateWriting)throw new Error('Save is in progress')
    this.persistence=null;this.changed()
  }
  state():FixedDraftState{return structuredClone({version:this.blankInputBuffer?6:this.blankSaveAttempt?5:this.inputBuffer?4:3,texts:this.texts.entries(),images:this.images.entries(),attempt:this.attempt,uploadInterrupted:this.images.uploading,...(this.inputBuffer?{workbookBuffer:this.inputBuffer}:{}),...(this.blankInputBuffer?{blankInput:this.blankInputBuffer}:{}),...(this.blankSaveAttempt?{blankAttempt:this.blankSaveAttempt}:{})})}
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
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])
    const result=await readFixedReceipt(()=>api(this.session,'/edits/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixedEditPatch(this.session,sent)),signal}),signal) as FixedEditReceipt&{status:string}
    this.live()
    if(result.patchId!==sent.id)throw new Error('invalidSaveReceipt')
    if(result.status==='missing')return null
    if(result.status!=='committed')throw new Error('invalidSaveReceipt')
    await verifyFixedReceipt(sent,result,signal);return result
  }
  private async accept(sent:FixedEditAttempt,result:FixedEditReceipt){
    this.live()
    if(this.historyReceipt?.id===sent.id)this.historyReceipt.confirm()
    this.historyReceipt=null
    this.texts.acknowledge(sent.texts,result.revision,result.nodeHashes??{})
    this.images.acknowledge(sent.images,result.revision,result.images??[])
    this.attempt=null;this.historyReceipt=null;this.release(sent);this.changed()
    // A committed server receipt remains valid if the local acknowledgement
    // write fails. The retained disk attempt resolves to this same receipt.
    try{await this.persist()}catch{if(this.closed)throw new Error('Fixed editor closed')}
    return result.revision
  }
  save(revision:number,onlyImage?:string,receiptOnly=false):Promise<number>{
    if(this.history.busy)return Promise.reject(new Error('historyBusy'))
    if(this.receiptWork)return Promise.reject(new Error('historyBusy'))
    this.history.stopCapturing()
    if(this.work)return this.work
    const work=this.performSave(revision,onlyImage,receiptOnly).finally(()=>{if(this.work===work){this.work=null;this.changed()}})
    this.work=work;this.changed();return work
  }
  /** Query the immutable original request without resending it or consuming
   * unfinished workbook input. A missing receipt is not proof of failure. */
  checkPendingReceipt():Promise<number|null>{
    if(this.receiptWork)return this.receiptWork
    if(this.work||this.history.busy)return Promise.reject(new Error('historyBusy'))
    const sent=this.attempt
    if(!sent)return Promise.resolve(null)
    const work=(async()=>{this.live();const result=await this.receipt(sent);return result?this.accept(sent,result):null})().finally(()=>{if(this.receiptWork===work){this.receiptWork=null;this.changed()}})
    this.receiptWork=work;this.changed();return work
  }
  private async performSave(revision:number,onlyImage?:string,receiptOnly=false){
    this.live()
    receiptOnly ||= this.session.scope!=='write'
    if(this.session.scope!=='write'&&!this.attempt)throw new Error('readOnlyMode')
    if(this.images.uploading)throw new Error('imageUploadPending')
    if(this.inputBuffer||this.blankInputBuffer||this.blankSaveAttempt)throw new Error('workbookInputPending')
    let sent=this.attempt
    if(sent){const result=await this.receipt(sent);if(result)return this.accept(sent,result);if(receiptOnly)throw new Error('accessRevoked')}
    if(receiptOnly)throw new Error('accessRevoked')
    if(!sent){
      sent=captureFixedEdits(revision,this.texts,this.images,onlyImage)
      if(!sent)return revision
      this.historyReceipt={id:sent.id,confirm:this.history.captureSave(sent)}
      this.attempt=sent;this.texts.beginSave(sent.texts);this.images.beginSave(sent.images);this.changed()
      try{await this.persist()}catch(error){this.attempt=null;this.historyReceipt=null;this.release(sent);this.changed();throw error}
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
        this.attempt=null;this.historyReceipt=null;this.release(sent);this.changed();await this.persist();throw error
      }
      throw new Error('fixedSaveUnknown')
    }
  }
  async flush(){await this.persistence?.flush()}
  dispose(){this.history.dispose();this.closed=true;this.abort.abort();this.detach.forEach(detach=>detach());this.detach=[]}
}
