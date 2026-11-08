/** Durable normal-editor link request. Preview is read-only; the complete
 * reviewed request is stored before its first submission and never rewritten. */
import type {Session} from './api.ts'
import type {WordPendingLink} from './wordLinkRequest.ts'
import {readActiveLinkPending} from './wordLinkRequest.ts'
import {planWordStoryLink,wordLinkRequestIdentity,readWordLinkSelection,type WordLinkTransaction as NativeLinkRequest} from './wordLinkPlan.ts'
import type {WordLayout} from './wordRegions.ts'
import {draftNamespace} from './localDrafts.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {wordBrowserHeaders} from './wordBrowserProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {openWordStoryRequestStore,type WordStoryStorage} from './wordStoryRequestStore.ts'
export type WordLinkReview={schemaVersion:'hcd-word-link-preview/1';revision:number;reviewHash:string;selection:{sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string};transaction:NativeLinkRequest;pending:WordPendingLink;nativeReviewHash:string;candidateLayoutHash:string;summary:{section:number;retainedStoryId:string;inheritedStoryId:string|null;inheritedSection:number|null;affectedSections:number;affectedSectionNumbers:number[];contentChanges:boolean}}
export type WordLinkRecord={schemaVersion:'hcd-word-link-request/1';epoch:number;operation:'apply'|'cancel';review:WordLinkReview}
const keys=(value:unknown,expected:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const nodeId=(value:unknown)=>typeof value==='string'&&/^n_[a-f0-9]{32}$/.test(value)
export function readWordLinkReview(value:unknown,session:Session):WordLinkReview{
 const v=value as WordLinkReview,invalid=()=>{throw Error('word-link-record-invalid')}
 if(!keys(v,'candidateLayoutHash,nativeReviewHash,pending,reviewHash,revision,schemaVersion,selection,summary,transaction')||v.schemaVersion!=='hcd-word-link-preview/1'||!hash(v.reviewHash))return invalid()
 const pending=readActiveLinkPending(v.pending,session.documentId,{scope:session.scope,userId:session.userId!,displayName:session.displayName!}),selection=readWordLinkSelection(v.selection),s=v.summary
 const transaction=readActiveLinkPending({...pending,request:v.transaction},session.documentId,{scope:session.scope,userId:session.userId!,displayName:session.displayName!}).request
 if(wordLinkRequestIdentity(transaction)!==wordLinkRequestIdentity(pending.request)||v.revision!==pending.request.expectedRevision||v.nativeReviewHash!==pending.reviewHash||v.candidateLayoutHash!==pending.candidateLayoutHash||selection.transactionId!==transaction.transactionId||['sectionId','kind','variant'].some(key=>(selection as any)[key]!==(transaction.link as any)[key]))return invalid()
 if(!keys(s,'affectedSectionNumbers,affectedSections,contentChanges,inheritedSection,inheritedStoryId,retainedStoryId,section')||!Number.isSafeInteger(s.section)||s.section<2||s.section>10000||s.retainedStoryId!==pending.request.link.expectedDirectStoryId||s.inheritedStoryId!==null&&!nodeId(s.inheritedStoryId)||s.inheritedStoryId===null&&s.inheritedSection!==null||s.inheritedStoryId!==null&&(!Number.isSafeInteger(s.inheritedSection)||s.inheritedSection!<1||s.inheritedSection!>=s.section)||!Array.isArray(s.affectedSectionNumbers)||s.affectedSectionNumbers.length>10000||s.affectedSections!==s.affectedSectionNumbers.length||s.affectedSectionNumbers.some((n,index)=>!Number.isSafeInteger(n)||n!==s.section+index||n>10000)||s.contentChanges!==(s.affectedSections>0))return invalid()
 return structuredClone({...v,pending})
}
export function readWordLinkRecord(value:unknown,session:Session):WordLinkRecord{
 const v=value as WordLinkRecord
 if(!keys(v,'epoch,operation,review,schemaVersion')||v.schemaVersion!=='hcd-word-link-request/1'||v.epoch!==session.collaborationEpoch||!['apply','cancel'].includes(v.operation)||new TextEncoder().encode(JSON.stringify(v)).byteLength>512*1024)throw Error('word-link-record-invalid')
 return{schemaVersion:v.schemaVersion,epoch:v.epoch,operation:v.operation,review:readWordLinkReview(v.review,session)}
}
export class WordLinkTransaction{
 private raw:string|null=null
 private value:WordLinkRecord|null=null
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
  if(session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol||!session.userId||!session.displayName)throw Error('word-link-unavailable')
  const scope=await draftNamespace(session,session.userId,base),store=storage??await openWordStoryRequestStore('hcd-word-link-request-v1-'+scope.prefix+'wordregions2',indexedDB,'word-link'),value=new WordLinkTransaction(session,store)
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
  try{if(raw&&new TextEncoder().encode(raw).byteLength>512*1024)throw Error('word-link-record-invalid');this.value=raw?readWordLinkRecord(JSON.parse(raw),this.session):null;this.phase=this.value?'pending':'idle';this.error=undefined}catch{this.value=null;this.phase='invalid';this.error='word-link-record-invalid'}this.emit()
 }
 private async same(){this.lifetime.signal.throwIfAborted();if(await this.store.read()!==this.raw)throw Error('word-link-record-changed');this.lifetime.signal.throwIfAborted()}
 private async persist(record:WordLinkRecord|null){const raw=record?JSON.stringify(readWordLinkRecord(record,this.session)):null;await this.store.replace(this.raw,raw);this.raw=raw;this.value=record?JSON.parse(raw!):null}
 private run(operation:string,action:()=>Promise<void>){
  if(this.work)return this.operation===operation?this.work:Promise.reject(Error('word-link-busy'))
  const task=Promise.resolve().then(async()=>{try{await this.same();await action();this.error=undefined}catch(error){this.error=error instanceof Error&&/^(word-link-|word-active-link-|word-story-source-|word-topology-)/.test(error.message)?error.message:'word-link-outcome-unknown';throw error}finally{if(this.work===task){this.work=undefined;this.operation=undefined}if(this.error==='word-link-record-changed')try{await this.refresh()}catch{}this.emit()}})
  this.operation=operation;this.work=task;this.emit();return task
 }
 async preview(base:{layout:WordLayout;layoutHash:string;revision:number},sectionId:string,kind:'header'|'footer',variant:'default'|'first'|'even',cancellation:AbortSignal){
  await this.same();if(this.busy||this.phase!=='idle')throw Error('word-link-request-pending')
  const selection={sectionId,kind,variant,transactionId:crypto.randomUUID().replaceAll('-','')},plan=planWordStoryLink(base.layout,selection),value=readWordLinkReview(await this.call('preview',{selection},cancellation),this.session)
  const key=kind==='header'?'headers':'footers',source=base.layout.sections.slice(0,plan.section-1).map((section,index)=>section[key][variant]!==undefined?index+1:null).filter(n=>n!==null).at(-1)??null
  if(Object.keys(selection).some(key=>(selection as any)[key]!==(value.selection as any)[key])||value.revision!==base.revision||value.pending.request.link.baseLayoutHash!==base.layoutHash||value.summary.section!==plan.section||value.summary.retainedStoryId!==plan.retainedStoryId||value.summary.inheritedStoryId!==plan.inheritedStoryId||value.summary.inheritedSection!==source||JSON.stringify(value.summary.affectedSectionNumbers)!==JSON.stringify(plan.affected.map((_item,index)=>plan.section+index)))throw Error('word-link-review-changed')
  await this.same();return value
 }
 prepare(review:WordLinkReview){return this.run('prepare',async()=>{if(this.phase!=='idle')throw Error('word-link-request-pending');await this.persist({schemaVersion:'hcd-word-link-request/1',epoch:this.session.collaborationEpoch!,operation:'apply',review:readWordLinkReview(review,this.session)});this.phase='pending'})}
 private async call(action:string,body:object,cancellation=this.lifetime.signal){
  const signal=AbortSignal.any([cancellation,this.lifetime.signal,AbortSignal.timeout(60000)]);signal.throwIfAborted()
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(this.session).replace(/\/negotiate$/,`/word-active-link-${action}`),{method:'POST',headers:{Authorization:`Bearer ${this.session.token}`,'Content-Type':'application/json',...wordBrowserHeaders(this.session),'X-HCD-Word-Link-Version':'1'},body:JSON.stringify({epoch:this.session.collaborationEpoch,...body}),redirect:'error',signal}),signal)
  if(!response.ok){let code='word-link-outcome-unknown';try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,signal,'word-link-response-limit')));if(['word-link-first-section','word-link-already-inherited','word-story-source-draft-pending','word-link-review-changed','word-link-preflight-unavailable','word-topology-client-busy','word-topology-client-upgrade-required'].includes(data.code))code=data.code}catch{signal.throwIfAborted()}throw Error(code)}
  const bytes=await readBoundedResponse(response,action==='preview'?512*1024:16384,signal,'word-link-response-limit');signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }
 private async submit(action:'submit'|'cancel'|'check'){
  if(!this.value)throw Error('word-link-record-invalid');const review=this.value.review
  const result=await this.call(action,{pending:review.pending,reviewHash:review.reviewHash});await this.same()
  if(!result||result.transactionId!==review.selection.transactionId)throw Error('word-link-response-invalid')
  if(action==='cancel'){if(Object.keys(result).sort().join(',')!=='status,transactionId'||result.status!=='not-prepared')throw Error('word-link-response-invalid');this.phase='cancelled'}
  else{if(Object.keys(result).sort().join(',')!=='revision,status,transactionId'||result.status!=='installed'||result.revision!==review.revision+1)throw Error('word-link-response-invalid');this.revision=result.revision;this.phase='installed'}
 }
 retry(){return this.run('retry',()=>this.submit(this.value?.operation==='cancel'?'cancel':'submit'))}
 cancel(){return this.run('cancel',async()=>{if(!this.value||this.phase==='installed')throw Error('word-link-request-pending');if(this.value.operation!=='cancel')await this.persist({...this.value,operation:'cancel'});await this.submit('cancel')})}
 check(){return this.run('check',async()=>{
  if(!this.value)throw Error('word-link-record-invalid');const id=this.value.review.selection.transactionId,result=await this.call('status',{transactionId:id});await this.same()
  if(!result||result.schemaVersion!=='hcd-word-active-link-status/1'||result.documentId!==this.session.documentId||result.epoch!==this.session.collaborationEpoch||result.transactionId!==id||Object.keys(result).sort().join(',')!==(result.status==='installed'?'documentId,epoch,revision,schemaVersion,status,transactionId':'documentId,epoch,schemaVersion,status,transactionId'))throw Error('word-link-response-invalid')
  if(result.status==='installed'){if(result.revision!==this.value.review.revision+1)throw Error('word-link-response-invalid');this.revision=result.revision;this.phase='installed'}else if(result.status==='cancelled')this.phase='cancelled';else if(result.status==='recovery-required')await this.submit(this.value.operation==='cancel'?'cancel':'check');else if(result.status==='pending'&&this.value.operation==='cancel')await this.submit('cancel');else if(result.status!=='pending')throw Error('word-link-response-invalid')
 })}
 finish(){return this.run('finish',async()=>{if(!['installed','cancelled'].includes(this.phase))throw Error('word-link-outcome-unknown');await this.persist(null);this.phase='idle';this.revision=undefined})}
 dispose(){this.lifetime.abort();this.unsubscribe?.();this.store.close();this.listeners.clear()}
}
