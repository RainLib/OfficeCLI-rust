import type {Session} from './api.ts'
import {fixedDraftDatabase} from './fixedDraftJournal.ts'
import {saveBlankBatch,validateBlankBatchInput,type BlankBatchInput,type BlankBatchState} from './workbookBlankBatch.ts'
import {inspectWorkbookBlanks} from './workbookBlankInspection.ts'
import {WorkbookBlankBatchJournal} from './workbookBlankBatchJournal.ts'
import {blankBatchBackupLimit,parseBlankBatchBackup,serializeBlankBatchBackup} from './workbookBlankBatchBackup.ts'
import {workbookServerHead} from './workbookExportGuard.ts'
import {workbookBatchComparison} from './workbookBatchComparison.ts'
import {serializeWorkbookCombinedBackup} from './workbookCombinedBackup.ts'
import type {FixedDraftState} from './fixedSaveController.ts'

type Entry={id:string;state:BlankBatchState}
export type BatchRebaseReview={id:string;original:BlankBatchState;revision:number;rootHash:string}
/** Coordinates batch capture, recovery and file actions within one origin.
 * Unstored input stays in memory until explicitly retried or copied out. */
export class WorkbookBlankBatchClient{
 private journal:WorkbookBlankBatchJournal|null=null
 private name=''
 private channel:BroadcastChannel|null=null
 private closed=false
 private active=false
 private version=0
 private readGeneration=0
 private listeners=new Set<()=>void>()
 private abort=new AbortController()
 entries:Entry[]=[]
 transient:BlankBatchInput|null=null
 loading=true
 problem=false
 constructor(private session:Session,private source:string,private ready:()=>boolean,private saveReady:()=>boolean=ready,private acknowledgeReady:()=>boolean=saveReady,private newAttemptAllowed:()=>boolean=()=>true){}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)}
 snapshot=()=>this.version
 private changed(){this.version++;for(const fn of this.listeners)fn()}
 get pending(){return this.loading||this.problem||this.active||!!this.transient||this.entries.length>0}
 get working(){return this.active}
 get canReview(){return !this.closed&&!this.active&&!!this.journal&&this.saveReady()}
 get canRemove(){return !this.closed&&!this.active&&!!this.journal&&this.acknowledgeReady()}
 private announce(){this.channel?.postMessage('changed')}
 private onFocus=()=>{void this.refresh()}
 async start(){
  try{
   if(!this.session.userId)throw new Error('blank batch authority required')
   this.name=(await fixedDraftDatabase(this.session,this.session.userId,this.source,window.location.href))+'-blank-batch-v1'
   const journal=await WorkbookBlankBatchJournal.open(this.session,this.source,window.location.href)
   if(this.closed){journal.close();return}this.journal=journal
   if(typeof BroadcastChannel!=='undefined'){this.channel=new BroadcastChannel(this.name);this.channel.onmessage=()=>{void this.refresh()}}
   window.addEventListener('focus',this.onFocus);await this.refresh()
  }catch{if(!this.closed){this.loading=false;this.problem=true;this.changed()}}
 }
 async refresh(){
  if(this.closed||!this.journal)return true
  const generation=++this.readGeneration
  try{const entries=await this.journal.list();if(this.closed)return true;if(generation===this.readGeneration){this.entries=entries;this.loading=false;this.problem=false;this.changed()}return entries.length>0}
  catch{if(!this.closed&&generation===this.readGeneration){this.loading=false;this.problem=true;this.changed()}return true}
 }
 /** Retry the same storage owner. Replacing the client would drop an unstored
  * capture precisely when the device journal cannot be trusted to contain it. */
 async retryStorage():Promise<boolean>{
  if(this.closed||this.active||this.loading)return false
  this.active=true;this.loading=true;this.changed()
  try{if(this.journal)await this.refresh();else await this.start();return !this.closed&&!this.loading&&!this.problem}
  finally{this.active=false;if(!this.closed)this.changed()}
 }
 private async lock<T>(work:()=>Promise<T>):Promise<T>{
  if(!this.name||!navigator.locks)throw new Error('blank batch coordination unavailable')
  return navigator.locks.request(this.name,{ifAvailable:true},async lock=>{if(!lock)throw new Error('blank batch busy');return work()})
 }
 /** Take ownership synchronously before the adapter returns. */
 capture(cells:ReadonlyArray<BlankBatchInput['cells'][number]>,revision:number,rootHash:string):boolean{
  if(cells.length<2||this.closed||this.pending||!this.journal||!navigator.locks||!this.ready())return false
  let input:BlankBatchInput
  try{input=validateBlankBatchInput({documentId:this.session.documentId,sourceSha256:this.source,baseRevision:revision,rootHash,cells:[...cells]},this.session,this.source)}catch{return false}
  this.transient=input;this.changed();void this.persistTransient().catch(()=>{});return true
 }
 /** Explicitly discard one reviewed local value without touching the server.
  * The whole branch is compared under the device lock before replacement. */
 async removeCell(id:string,expected:BlankBatchState,cell:BlankBatchInput['cells'][number]){
  if(this.closed||this.active||!this.journal||!this.acknowledgeReady())throw new Error('blank batch unavailable')
  const original=structuredClone(expected),target=structuredClone(cell)
  if(original.attempt||original.input.cells.length<2)throw new Error('blank batch unavailable')
  const cells=original.input.cells.filter(value=>value.sheetId!==target.sheetId||value.row!==target.row||value.column!==target.column)
  if(cells.length!==original.input.cells.length-1||!original.input.cells.some(value=>JSON.stringify(value)===JSON.stringify(target)))throw new Error('blank batch changed')
  const next={input:validateBlankBatchInput({...original.input,cells},this.session,this.source),attempt:null}
  this.active=true;this.changed()
  try{await this.lock(async()=>{if(this.closed||!this.acknowledgeReady())throw new Error('blank batch unavailable');if(!await this.journal!.branch(id).replace(original,next))throw new Error('blank batch changed');this.announce()})}
  finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 /** Copy a reviewed value without removing the original batch entry. The two
  * journals are separate; retaining the source protects interrupted copies. */
 async copyCell(id:string,expected:BlankBatchState,cell:BlankBatchInput['cells'][number],stage:(signal:AbortSignal)=>Promise<void>){
  if(this.closed||this.active||!this.journal||!this.acknowledgeReady())throw new Error('blank batch unavailable')
  const original=structuredClone(expected),target=structuredClone(cell)
  if(original.attempt||!original.input.cells.some(value=>JSON.stringify(value)===JSON.stringify(target)))throw new Error('blank batch changed')
  this.active=true;this.changed()
  try{await this.lock(async()=>{
   const branch=this.journal!.branch(id),current=await branch.read()
   if(this.closed||!this.acknowledgeReady()||JSON.stringify(current)!==JSON.stringify(original))throw new Error('blank batch changed')
   await stage(this.abort.signal)
  })}finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 async persistTransient(){
  if(this.closed||this.active||!this.transient||!this.journal||!this.ready())throw new Error('blank batch unavailable')
  const input=structuredClone(this.transient);this.active=true;this.changed()
  try{await this.lock(async()=>{if(!this.ready()||this.closed)throw new Error('blank batch unavailable');if((await this.journal!.list()).length)throw new Error('blank batch pending');await this.journal!.stage(input);if(JSON.stringify(this.transient)===JSON.stringify(input))this.transient=null;this.announce()})}
  finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 async save(id:string){
  if(this.closed||this.active||!this.journal||!this.saveReady())throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{return await this.lock(async()=>{if(!this.saveReady()||this.closed)throw new Error('blank batch unavailable');const result=await saveBlankBatch(this.session,this.source,this.journal!.branch(id),this.abort.signal,inspectWorkbookBlanks,()=>!this.closed&&this.saveReady(),()=>!this.closed&&this.acknowledgeReady(),()=>!this.closed&&this.newAttemptAllowed());this.announce();return result})}
  finally{if(!this.closed){this.announce();await this.refresh()}this.active=false;if(!this.closed)this.changed()}
 }
 async discard(id:string){
  if(this.closed||this.active||!this.journal)throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{await this.lock(async()=>{const branch=this.journal!.branch(id),state=await branch.read();if(!state||state.attempt)throw new Error('blank batch outcome unknown');if(!await branch.replace(state,null))throw new Error('blank batch changed');this.announce()})}
  finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 async discardTransient(){
  if(this.closed||this.active||!this.transient)throw new Error('blank batch unavailable')
  this.transient=null;this.changed();await this.refresh()
 }
 async compare(id:string,offset:number){
  if(this.closed||this.active||!this.journal||!Number.isSafeInteger(offset)||offset<0||offset%20!==0)throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{return await this.lock(async()=>{
   const state=await this.journal!.branch(id).read();if(!state||offset>=state.input.cells.length)throw new Error('blank batch missing')
   const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)]),revision=await workbookServerHead(this.session,this.source,signal)
   const cells=await workbookBatchComparison(this.session,this.source,revision,state.input.cells.slice(offset,offset+20),signal)
   if(this.closed)throw new Error('blank batch unavailable')
   return {id,revision,offset,total:state.input.cells.length,cells}
  })}finally{this.active=false;if(!this.closed)this.changed()}
 }
 /** Check every target at one head. This observation does not reserve cells. */
 async reviewRebase(id:string):Promise<BatchRebaseReview>{
  if(this.closed||this.active||!this.journal||!this.saveReady())throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{return await this.lock(async()=>{
   const original=await this.journal!.branch(id).read();if(!original||original.attempt)throw new Error('blank batch outcome unknown')
   const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])
   const revision=await workbookServerHead(this.session,this.source,signal)
   const checked=await inspectWorkbookBlanks(this.session,revision,this.source,original.input.cells,signal)
   if(this.closed||!this.saveReady())throw new Error('blank batch unavailable')
   return{id,original,revision,rootHash:checked.rootHash}
  })}finally{this.active=false;if(!this.closed)this.changed()}
 }
 /** Confirmation repeats the observation and atomically updates only the same
  * unsent branch. A later server change will still be caught on save. */
 async confirmRebase(review:BatchRebaseReview){
  if(this.closed||this.active||!this.journal||!this.saveReady())throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{await this.lock(async()=>{
   const branch=this.journal!.branch(review.id),current=await branch.read()
   if(!current||current.attempt||JSON.stringify(current)!==JSON.stringify(review.original))throw new Error('blank batch changed')
   const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])
   const revision=await workbookServerHead(this.session,this.source,signal)
   if(revision!==review.revision)throw new Error('blank batch head changed')
   const checked=await inspectWorkbookBlanks(this.session,revision,this.source,current.input.cells,signal)
   if(this.closed||!this.saveReady()||checked.rootHash!==review.rootHash)throw new Error('blank batch head changed')
   const next={input:validateBlankBatchInput({...current.input,baseRevision:revision,rootHash:checked.rootHash},this.session,this.source),attempt:null}
   if(!await branch.replace(current,next))throw new Error('blank batch changed')
   this.announce()
  })}finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 async backup(id:string|null){
  const value=id?(await this.journal?.branch(id).read()):this.transient?{input:this.transient,attempt:null}:null
  if(!value)throw new Error('blank batch missing')
  return serializeBlankBatchBackup(value,this.session,this.source,window.location.href)
 }
 /** Capture the fixed state and every known batch while other same-origin
  * batch operations are excluded. An in-memory failed capture is included. */
 async combinedBackup(fixed:()=>FixedDraftState){
  if(this.closed||this.active||this.loading||this.problem||!this.journal)throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{return await this.lock(async()=>{const entries=await this.journal!.list();if(this.closed)throw new Error('blank batch unavailable');const batches=entries.map(entry=>entry.state);if(this.transient)batches.push({input:structuredClone(this.transient),attempt:null});return serializeWorkbookCombinedBackup(this.session,this.source,window.location.href,structuredClone(fixed()),batches)})}
  finally{this.active=false;if(!this.closed)this.changed()}
 }
 async importBackup(file:File){
  if(this.closed||this.active||!this.journal||!this.saveReady()||file.size>blankBatchBackupLimit)throw new Error('blank batch unavailable')
  this.active=true;this.changed()
  try{const raw=await file.text();if(this.closed||!this.saveReady())throw new Error('blank batch unavailable');const state=parseBlankBatchBackup(raw,this.session,this.source,window.location.href);await this.lock(async()=>{if(this.closed||!this.saveReady())throw new Error('blank batch unavailable');await this.journal!.import(state,this.abort.signal);this.announce()})}
  finally{if(!this.closed)await this.refresh();this.active=false;if(!this.closed)this.changed()}
 }
 async withClear<T>(work:()=>Promise<T>):Promise<T>{
  if(this.pending||this.closed||!this.journal)throw new Error('blank batch pending')
  if(!navigator.locks){const found=await this.refresh();if(found||this.pending)throw new Error('blank batch pending');return work()}
  return this.lock(async()=>{if(this.pending)throw new Error('blank batch pending');const found=await this.refresh();if(found||this.pending)throw new Error('blank batch pending');return work()})
 }
 /** A previously durable exact request may be reconciled while batch drafts
  * exist. Serialize it with batch saves; callers must not create a new save. */
 async withPendingResolution<T>(work:(hasPending:boolean)=>Promise<T>):Promise<T>{
  if(this.closed||this.loading||this.problem||this.active||this.transient||!this.journal)throw new Error('blank batch pending')
  return this.lock(async()=>{if(this.closed||this.active||this.transient)throw new Error('blank batch pending');const found=await this.refresh();if(this.closed||this.problem||this.loading||this.active||this.transient)throw new Error('blank batch pending');return work(found)})
 }
 dispose(){this.closed=true;this.abort.abort();this.channel?.close();this.journal?.close();window.removeEventListener('focus',this.onFocus);this.listeners.clear()}
}
