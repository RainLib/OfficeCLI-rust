/** In-process orchestration of an exact active topology request. Durable native
 * requests remain in WordCheckpointJournal. Cache loss requires signed native
 * proof or topology recovery, never synthesizing a fresh request. */
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'

export type ActiveTopologyPending={actor:{userId:string;displayName:string};request:{documentId:string;transactionId:string;expectedRevision:number;actor:{userId:string;displayName:string}}}
type Authorize=()=>Promise<WordTopologyMember>
export type WordActiveTopologyContext={prepare:()=>Promise<void>;transition:(authorize:Authorize)=>Promise<void>;promote:(authorize:Authorize)=>Promise<void>;retire:()=>Promise<void>;isRetired:()=>boolean;install:(authorize:Authorize)=>Promise<void>;activate:()=>void;release:()=>void;held:()=>boolean}
type Result={transactionId:string;revision:number;status:'installed'}
export type WordActiveTopologyStatus<K extends 'layout'|'story'|'link'>={schemaVersion:`hcd-word-active-${K}-status/1`;documentId:string;epoch:number;transactionId:string}&({status:'installed';revision:number}|{status:'pending'|'cancelled'|'recovery-required'})
type Job<P extends ActiveTopologyPending>={epoch:number;pending:P;phase:'new'|'quiesced'|'acknowledged'|'promoted'|'retired'|'installed';context?:WordActiveTopologyContext;result?:Result;busy:boolean}
export class WordActiveTopology<P extends ActiveTopologyPending,K extends 'layout'|'story'|'link'>{
 constructor(private readonly kind:K,private readonly identity:(pending:P)=>string=JSON.stringify){}
 private jobs=new Map<string,Job<P>>()
 private completed=new Map<string,{pending:P;result:Result}>()
 private cancellations=new Map<string,{epoch:number;pending:P;busy:boolean;done:boolean}>()
 private resultKey(documentId:string,epoch:number,transactionId:string){return JSON.stringify([documentId,epoch,transactionId])}
 private remember(pending:P,epoch:number,result:Result){
  const key=this.resultKey(pending.request.documentId,epoch,pending.request.transactionId)
  if(!this.completed.has(key)&&this.completed.size>=128)this.completed.delete(this.completed.keys().next().value!)
  this.completed.set(key,{pending:structuredClone(pending),result:structuredClone(result)})
 }
 /** A missing process-local job says nothing about native commit outcome.
  * Readers learn only this exact round's status, never its request or actor. */
 status(documentId:string,epoch:number,transactionId:string):WordActiveTopologyStatus<K>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId)||!Number.isSafeInteger(epoch)||epoch<0||!/^[a-f0-9]{32}$/.test(transactionId))throw Error(`word-active-${this.kind}-invalid`)
  const identity={schemaVersion:`hcd-word-active-${this.kind}-status/1` as `hcd-word-active-${K}-status/1`,documentId,epoch,transactionId},job=this.jobs.get(documentId),cancel=this.cancellations.get(documentId)
  if(cancel?.epoch===epoch&&cancel.pending.request.transactionId===transactionId)return{...identity,status:cancel.done?'cancelled':'pending'}
  const completed=this.completed.get(this.resultKey(documentId,epoch,transactionId))
  if(completed)return{...identity,status:'installed',revision:completed.result.revision}
  if(!job||job.epoch!==epoch||job.pending.request.transactionId!==transactionId)return{...identity,status:'recovery-required'}
  return job.result?{...identity,status:'installed',revision:job.result.revision}:{...identity,status:'pending'}
 }
 /** Only the host's signed journal + native cancellation receipt may seal a
  * nonce. An ambiguous cancellation blocks applying it until exact retry. */
 async cancel(pending:P,authorize:Authorize,work:()=>Promise<void>,epoch=0){
  if(!Number.isSafeInteger(epoch)||epoch<0)throw Error(`word-active-${this.kind}-invalid`)
  pending=structuredClone(pending);requireTopologyMember(await authorize(),pending.actor,pending.request.actor)
  const id=pending.request.documentId,identity=this.identity(pending),job=this.jobs.get(id)
  const completed=this.completed.get(this.resultKey(id,epoch,pending.request.transactionId))
  if(completed)throw Error(this.identity(completed.pending)===identity?`word-active-${this.kind}-already-installed`:`word-active-${this.kind}-request-changed`)
  if(job){if(job.epoch===epoch&&this.identity(job.pending)===identity){if(job.result)throw Error(`word-active-${this.kind}-already-installed`);throw Error(`word-active-${this.kind}-prepared`)}if(!job.result)throw Error(`word-active-${this.kind}-pending`)}
  let current=this.cancellations.get(id)
  if(current&&(current.epoch!==epoch||this.identity(current.pending)!==identity)){if(!current.done)throw Error(`word-active-${this.kind}-cancel-pending`);this.cancellations.delete(id);current=undefined}
  if(current?.busy)throw Error(`word-active-${this.kind}-busy`)
  if(current?.done)return{transactionId:pending.request.transactionId,status:'not-prepared' as const}
  if(!current){if(this.cancellations.size>=128){const completed=[...this.cancellations].find(([,v])=>v.done);if(!completed)throw Error(`word-active-${this.kind}-capacity`);this.cancellations.delete(completed[0])}current={epoch,pending,busy:false,done:false};this.cancellations.set(id,current)}
  current.busy=true
  try{requireTopologyMember(await authorize(),pending.actor,pending.request.actor);await work();requireTopologyMember(await authorize(),pending.actor,pending.request.actor);current.done=true;return{transactionId:pending.request.transactionId,status:'not-prepared' as const}}
  finally{current.busy=false}
 }
 async run(pending:P,authorize:Authorize,resolve:()=>WordActiveTopologyContext,epoch=0):Promise<Result>{
  if(!Number.isSafeInteger(epoch)||epoch<0)throw Error(`word-active-${this.kind}-invalid`)
  pending=structuredClone(pending)
  const member=await authorize();requireTopologyMember(member,pending.actor,pending.request.actor)
  const id=pending.request.documentId,identity=this.identity(pending),cancel=this.cancellations.get(id);let job=this.jobs.get(id)
  if(cancel){if(cancel.epoch===epoch&&cancel.pending.request.transactionId===pending.request.transactionId)throw Error(cancel.done?`word-active-${this.kind}-cancelled`:`word-active-${this.kind}-cancel-pending`);if(!cancel.done)throw Error(`word-active-${this.kind}-cancel-pending`);this.cancellations.delete(id)}
  const completed=this.completed.get(this.resultKey(id,epoch,pending.request.transactionId))
  if(completed){if(this.identity(completed.pending)!==identity)throw Error(`word-active-${this.kind}-request-changed`);return structuredClone(completed.result)}
  if(job&&job.epoch!==epoch){if(!job.result)throw Error(`word-active-${this.kind}-epoch-changed`);this.jobs.delete(id);job=undefined}
  if(job&&this.identity(job.pending)!==identity){if(job.pending.request.transactionId===pending.request.transactionId)throw Error(`word-active-${this.kind}-request-changed`);if(!job.result)throw Error(`word-active-${this.kind}-pending`);this.jobs.delete(id);job=undefined}
  if(job?.busy)throw Error(`word-active-${this.kind}-busy`)
  if(job?.result)return structuredClone(job.result)
  if(!job){
   if(this.jobs.size>=128){const completed=[...this.jobs].find(([,value])=>value.result);if(!completed)throw Error(`word-active-${this.kind}-capacity`);this.jobs.delete(completed[0])}
   job={epoch,pending:structuredClone(pending),phase:'new',context:resolve(),busy:false};this.jobs.set(id,job)
  }
  const current=job,context=current.context!;current.busy=true
  try{
   requireTopologyMember(await authorize(),pending.actor,pending.request.actor)
   if(current.phase==='new'){await context.prepare();current.phase='quiesced'}
   if(current.phase==='quiesced'){await context.transition(authorize);current.phase='acknowledged'}
   if(current.phase==='acknowledged'){await context.promote(authorize);current.phase='promoted'}
   if(current.phase==='promoted'){if(!context.isRetired())await context.retire();if(!context.isRetired())throw Error(`word-active-${this.kind}-retirement-uncertain`);current.phase='retired'}
   if(current.phase==='retired'){await context.install(authorize);current.phase='installed'}
   context.activate();current.result={transactionId:pending.request.transactionId,revision:pending.request.expectedRevision+1,status:'installed'}
   this.remember(pending,epoch,current.result)
   context.release();current.context=undefined;return structuredClone(current.result)
  }catch(error){
   if(!context.held()&&current.phase!=='installed'){context.release();if(this.jobs.get(id)===current)this.jobs.delete(id)}
   throw error
  }finally{current.busy=false}
 }
}
