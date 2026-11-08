/** Durable normal-editor story request. Preview is read-only; the complete
 * reviewed request is stored before its first submission and never rewritten. */
import type {Session} from './api.ts'
import type {WordPendingStory} from './wordCheckpointJournal.ts'
import {readActiveStoryPending} from './wordStoryRequest.ts'
import {draftNamespace} from './localDrafts.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {wordBrowserHeaders} from './wordBrowserProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {openWordStoryRequestStore,type WordStoryStorage} from './wordStoryRequestStore.ts'
export type WordStoryReview={schemaVersion:'hcd-word-story-preview/1';revision:number;reviewHash:string;selection:{sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string};pending:WordPendingStory;summary:{section:number;inherited:boolean;affectedSections:number;blockCount:number}}
export type WordStoryRecord={schemaVersion:'hcd-word-story-request/1';epoch:number;operation:'apply'|'cancel';review:WordStoryReview}
export function readWordStoryReview(value:unknown,session:Session):WordStoryReview{
 const v=value as WordStoryReview
 if(!v||Object.keys(v).sort().join(',')!=='pending,reviewHash,revision,schemaVersion,selection,summary'||v.schemaVersion!=='hcd-word-story-preview/1'||!/^[a-f0-9]{64}$/.test(v.reviewHash??'')||!Number.isSafeInteger(v.revision)||v.revision<0||!v.selection||Object.keys(v.selection).sort().join(',')!=='kind,sectionId,transactionId,variant'||!v.summary||Object.keys(v.summary).sort().join(',')!=='affectedSections,blockCount,inherited,section'||![v.summary.section,v.summary.affectedSections,v.summary.blockCount].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=10000)||typeof v.summary.inherited!=='boolean')throw Error('word-story-record-invalid')
 const pending=readActiveStoryPending(v.pending,session.documentId,{scope:session.scope,userId:session.userId!,displayName:session.displayName!})
 if(v.revision!==pending.request.expectedRevision||v.selection.transactionId!==pending.request.transactionId||['sectionId','kind','variant'].some(key=>(v.selection as any)[key]!== (pending.intent as any)[key])||v.summary.blockCount!==pending.blocks.length||v.summary.inherited!==(pending.intent.expectedInheritedStoryId!==null))throw Error('word-story-record-invalid')
 return structuredClone({...v,pending})
}
export function readWordStoryRecord(value:unknown,session:Session):WordStoryRecord{
 const v=value as WordStoryRecord
 if(!v||Object.keys(v).sort().join(',')!=='epoch,operation,review,schemaVersion'||v.schemaVersion!=='hcd-word-story-request/1'||v.epoch!==session.collaborationEpoch||!['apply','cancel'].includes(v.operation)||new TextEncoder().encode(JSON.stringify(v)).byteLength>950*1024)throw Error('word-story-record-invalid')
 return{schemaVersion:v.schemaVersion,epoch:v.epoch,operation:v.operation,review:readWordStoryReview(v.review,session)}
}
export class WordStoryTransaction{
 private raw:string|null=null
 private value:WordStoryRecord|null=null
 private version=0
 private listeners=new Set<()=>void>()
 private lifetime=new AbortController()
 private work:Promise<void>|undefined
 private operation:string|undefined
 private unsubscribe:(()=>void)|undefined
 phase:'idle'|'pending'|'installed'|'cancelled'|'invalid'='idle'
 error:string|undefined
 revision:number|undefined
 private constructor(readonly session:Session,private store:WordStoryStorage){this.unsubscribe=store.subscribe?.(()=>{void this.refresh().catch(()=>{})})}
 static async open(session:Session,base:string,storage?:WordStoryStorage){
  if(session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol||!session.userId||!session.displayName)throw Error('word-story-unavailable')
  const scope=await draftNamespace(session,session.userId,base),store=storage??await openWordStoryRequestStore('hcd-word-story-request-v1-'+scope.prefix+'wordregions2'),value=new WordStoryTransaction(session,store)
  try{await value.refresh();return value}catch(error){value.dispose();throw error}
 }
 get record(){return this.value?structuredClone(this.value):null}
 get busy(){return !!this.work}
 get backup(){return this.raw}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(!this.lifetime.signal.aborted){this.version++;this.listeners.forEach(listener=>listener())}}
 async refresh(){
  if(this.busy)return
  const raw=await this.store.read();this.lifetime.signal.throwIfAborted();if(raw===this.raw&&this.phase!=='invalid')return
  this.raw=raw;this.revision=undefined
  try{if(raw&&new TextEncoder().encode(raw).byteLength>950*1024)throw Error('word-story-record-invalid');this.value=raw?readWordStoryRecord(JSON.parse(raw),this.session):null;this.phase=this.value?'pending':'idle';this.error=undefined}catch{this.value=null;this.phase='invalid';this.error='word-story-record-invalid'}this.emit()
 }
 private async same(){this.lifetime.signal.throwIfAborted();if(await this.store.read()!==this.raw)throw Error('word-story-record-changed');this.lifetime.signal.throwIfAborted()}
 private async persist(record:WordStoryRecord|null){const raw=record?JSON.stringify(readWordStoryRecord(record,this.session)):null;await this.store.replace(this.raw,raw);this.raw=raw;this.value=record?JSON.parse(raw!):null}
 private run(operation:string,action:()=>Promise<void>){
  if(this.work)return this.operation===operation?this.work:Promise.reject(Error('word-story-busy'))
  const task=Promise.resolve().then(async()=>{try{await this.same();await action();this.error=undefined}catch(error){this.error=error instanceof Error&&/^(word-story-|word-active-story-)/.test(error.message)?error.message:'word-story-outcome-unknown';throw error}finally{if(this.work===task){this.work=undefined;this.operation=undefined}if(this.error==='word-story-record-changed')try{await this.refresh()}catch{}this.emit()}})
  this.operation=operation;this.work=task;this.emit();return task
 }
 async preview(sectionId:string,kind:'header'|'footer',variant:'default'|'first'|'even',cancellation:AbortSignal){
  await this.same();if(this.busy||this.phase!=='idle')throw Error('word-story-request-pending')
  const selection={sectionId,kind,variant,transactionId:crypto.randomUUID().replaceAll('-','')},value=readWordStoryReview(await this.call('preview',{selection},cancellation),this.session)
  if(Object.keys(selection).some(key=>(selection as any)[key]!== (value.selection as any)[key]))throw Error('word-story-record-invalid')
  await this.same();return value
 }
 prepare(review:WordStoryReview){return this.run('prepare',async()=>{if(this.phase!=='idle')throw Error('word-story-request-pending');await this.persist({schemaVersion:'hcd-word-story-request/1',epoch:this.session.collaborationEpoch!,operation:'apply',review:readWordStoryReview(review,this.session)});this.phase='pending'})}
 private async call(action:string,body:object,cancellation=this.lifetime.signal){
  const signal=AbortSignal.any([cancellation,this.lifetime.signal,AbortSignal.timeout(60000)]);signal.throwIfAborted()
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(this.session).replace(/\/negotiate$/,`/word-active-story-${action}`),{method:'POST',headers:{Authorization:`Bearer ${this.session.token}`,'Content-Type':'application/json',...wordBrowserHeaders(this.session),'X-HCD-Word-Story-Version':'1'},body:JSON.stringify({epoch:this.session.collaborationEpoch,...body}),redirect:'error',signal}),signal)
  if(!response.ok){let code='word-story-outcome-unknown';try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,signal,'word-story-response-limit')));if(['word-story-source-unsupported','word-story-source-draft-pending','word-story-review-changed','word-topology-client-busy','word-topology-client-upgrade-required'].includes(data.code))code=data.code}catch{signal.throwIfAborted()}throw Error(code)}
  const bytes=await readBoundedResponse(response,action==='preview'?1024*1024:16384,signal,'word-story-response-limit');signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }
 private async submit(action:'submit'|'cancel'|'check'){
  if(!this.value)throw Error('word-story-record-invalid');const review=this.value.review
  const result=await this.call(action,{pending:review.pending,reviewHash:review.reviewHash});await this.same()
  if(!result||result.transactionId!==review.selection.transactionId)throw Error('word-story-response-invalid')
  if(action==='cancel'){if(Object.keys(result).sort().join(',')!=='status,transactionId'||result.status!=='not-prepared')throw Error('word-story-response-invalid');this.phase='cancelled'}
  else{if(Object.keys(result).sort().join(',')!=='revision,status,transactionId'||result.status!=='installed'||result.revision!==review.revision+1)throw Error('word-story-response-invalid');this.revision=result.revision;this.phase='installed'}
 }
 retry(){return this.run('retry',()=>this.submit(this.value?.operation==='cancel'?'cancel':'submit'))}
 cancel(){return this.run('cancel',async()=>{if(!this.value||this.phase==='installed')throw Error('word-story-request-pending');if(this.value.operation!=='cancel')await this.persist({...this.value,operation:'cancel'});await this.submit('cancel')})}
 check(){return this.run('check',async()=>{
  if(!this.value)throw Error('word-story-record-invalid');const id=this.value.review.selection.transactionId,result=await this.call('status',{transactionId:id});await this.same()
  if(!result||result.schemaVersion!=='hcd-word-active-story-status/1'||result.documentId!==this.session.documentId||result.epoch!==this.session.collaborationEpoch||result.transactionId!==id||Object.keys(result).sort().join(',')!==(result.status==='installed'?'documentId,epoch,revision,schemaVersion,status,transactionId':'documentId,epoch,schemaVersion,status,transactionId'))throw Error('word-story-response-invalid')
  if(result.status==='installed'){if(result.revision!==this.value.review.revision+1)throw Error('word-story-response-invalid');this.revision=result.revision;this.phase='installed'}else if(result.status==='cancelled')this.phase='cancelled';else if(result.status==='recovery-required')await this.submit(this.value.operation==='cancel'?'cancel':'check');else if(result.status==='pending'&&this.value.operation==='cancel')await this.submit('cancel');else if(result.status!=='pending')throw Error('word-story-response-invalid')
 })}
 finish(){return this.run('finish',async()=>{if(!['installed','cancelled'].includes(this.phase))throw Error('word-story-outcome-unknown');await this.persist(null);this.phase='idle';this.revision=undefined})}
 dispose(){this.lifetime.abort();this.unsubscribe?.();this.store.close();this.listeners.clear()}
}
