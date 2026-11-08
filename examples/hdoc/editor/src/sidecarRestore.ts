import {RoomMigrationGate,MigrationUncertain} from './roomMigrationGate.ts'
import {MigrationRejected} from './sidecarMigration.ts'
import {RestoreJournal,type RestoreJob,type RestoreReceipt,type RestoreProtocol,restoreProtocol} from './restoreJournal.ts'
export type RestoreContext={fromEpoch:number;fromProtocol?:RestoreProtocol}
type Input=RestoreContext&{requestId:string;expectedRevision:number;target:number;authorId:string;authorName:string;fromEpoch:number}
type Host={
 quiesce:(id:string,requestId:string,context:RestoreContext)=>Promise<void>;freeze:(id:string)=>void
 prepare:(id:string,expectedRevision:number,context:RestoreContext)=>Promise<string>
 submit:(job:RestoreJob)=>Promise<Response>
 release:(id:string)=>Promise<void>;committed:(id:string,receipt:RestoreReceipt)=>Promise<void>
}
/** All admitted packets are drained before persisting the exact restore intent.
 * Unknown publication keeps the room fenced; retries reuse the original body. */
export class SidecarRestore{
 private operations=new Map<string,Promise<RestoreReceipt>>()
 constructor(private gate:RoomMigrationGate,readonly journal:RestoreJournal,private host:Host){}
 private async load(id:string){try{return await this.journal.load(id)}catch{return this.gate.exclusive(id,async()=>{throw new MigrationUncertain()},undefined,'restore')}}
 private finish(id:string,receipt:RestoreReceipt){return this.gate.exclusive(id,async()=>{try{await this.host.committed(id,receipt);return receipt}catch{throw new MigrationUncertain()}},undefined,'restore')}
 async recover(id:string):Promise<RestoreReceipt|undefined>{const job=await this.load(id);if(job?.status==='prepared')return this.run(id,undefined);if(job?.status==='committed'&&this.gate.blocked(id))return this.finish(id,this.receipt(job,job.receipt));return undefined}
 run(id:string,input:Input|undefined):Promise<RestoreReceipt>{
  if(this.operations.has(id))return Promise.reject(new MigrationRejected(409,'restore-busy'))
  const work=this.perform(id,input).finally(()=>{if(this.operations.get(id)===work)this.operations.delete(id)})
  this.operations.set(id,work);return work
 }
 private async perform(id:string,input:Input|undefined):Promise<RestoreReceipt>{
  let job=await this.load(id)
  if(job?.status==='prepared'&&input&&(job.request.requestId!==input.requestId||job.target!==input.target||job.request.expectedRevision!==input.expectedRevision||job.request.authorId!==input.authorId||job.request.fromEpoch!==input.fromEpoch||restoreProtocol(job.request)!==restoreProtocol(input)))throw new MigrationRejected(409,'restore-pending')
  if(job?.status==='committed'&&input?.requestId===job.request.requestId){if(job.target!==input.target||job.request.expectedRevision!==input.expectedRevision||job.request.authorId!==input.authorId||job.request.fromEpoch!==input.fromEpoch||restoreProtocol(job.request)!==restoreProtocol(input))throw new MigrationRejected(409,'restore-request-changed');const receipt=this.receipt(job,job.receipt);return this.gate.blocked(id)?this.finish(id,receipt):receipt}
  if(job?.status!=='prepared'){
   if(!input)throw new MigrationRejected(409,'restore-missing')
   // This phase still admits packets so clients can flush their last update.
   try{await this.host.quiesce(id,input.requestId,input)}catch(error){await this.host.release(id);throw error}
   job=undefined
  }
  let published=!!job
  try{return await this.gate.exclusive(id,async()=>{
   try{if(!job){
    const sourceHash=await this.host.prepare(id,input!.expectedRevision,input!)
    job={version:1,documentId:id,target:input!.target,request:{requestId:input!.requestId,expectedRevision:input!.expectedRevision,fromEpoch:input!.fromEpoch,...(input!.fromProtocol?{fromProtocol:input!.fromProtocol}:{}),sourceHash,authorId:input!.authorId,authorName:input!.authorName},status:'prepared'}
    // A failed fsync/rename can itself have an unknown outcome. Never resume
    // writes without checking the journal after a persistence error.
    try{await this.journal.save(job)}catch{try{if(await this.journal.load(id))throw new MigrationUncertain()}catch{throw new MigrationUncertain()}throw new MigrationRejected(503,'restore-journal-unavailable')}
    published=true
   }
   let response:Response
   try{response=await this.host.submit(job)}catch{throw new MigrationUncertain()}
   if(!response.ok){if(response.status>=500||[408,429].includes(response.status))throw new MigrationUncertain();await this.journal.reject(job);published=false;throw new MigrationRejected(response.status,'restore-comparison-changed')}
   let receipt:RestoreReceipt
   try{receipt=this.receipt(job,await response.json());await this.journal.save({...job,status:'committed',receipt});await this.host.committed(id,receipt)}catch{throw new MigrationUncertain()}
   return receipt
   }catch(error){if(published)throw new MigrationUncertain();throw error}
  },()=>this.host.freeze(id),'restore')}catch(error){
   if(published||error instanceof MigrationUncertain)throw new MigrationUncertain()
   await this.host.release(id);throw error
  }
 }
 private receipt(job:RestoreJob,value:unknown):RestoreReceipt{
  const receipt=value as RestoreReceipt
  if(!receipt||receipt.requestId!==job.request.requestId||receipt.revision!==job.request.expectedRevision+1||receipt.restoredFrom!==job.target||receipt.collaborationEpoch!==job.request.fromEpoch+1||receipt.collaborationProtocol!==restoreProtocol(job.request))throw new MigrationUncertain()
  return receipt
 }
}
