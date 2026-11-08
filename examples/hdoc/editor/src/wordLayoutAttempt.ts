/** Durable stopped layout/story intent. Native receipts remain authority. */
import type {Session} from './api.ts'
import type {WordPageSetupSubmit} from './WordPageSetup.tsx'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {draftNamespace} from './localDrafts.ts'
import {validContributor} from './referenceAuthors.ts'
import {activeWordLayoutPending} from './wordActiveLayout.ts'
import {openWordStoppedRequestStore,stoppedTopologyQueueOptions} from './wordStoppedRequestStore.ts'
import {readDeviceRequestQueue,deviceRequestQueueJson,migrateDeviceRequestLegacy,type DeviceRequestStorage,type LegacyRequestStorage} from './wordDeviceRequestQueue.ts'
import {sendStoppedLayout} from './wordStoppedLayoutClient.ts'
import {sendStoppedStory} from './wordStoppedStoryClient.ts'
import {validWordNumberingValue} from './wordNumberingIntent.ts'
import {cancelUnpreparedTopology,wordTopologyRecovery,type WordTopologyReview} from './wordTopologyRecoveryClient.ts'
type Intent=Parameters<WordPageSetupSubmit>[0]['intent']
export type StoppedLayoutAction={kind:'layout';sections:{id:string;number:number}[];body:{epoch:number;operation:'apply';revision:number;reviewHash:string;transactionId:string;edits:Intent}}
export type StoppedStoryAction={kind:'story';section:number;baseRevision:number;body:{epoch:number;operation:'apply';sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';reviewHash:string;transactionId:string}}
export type WordLayoutAction=StoppedLayoutAction|StoppedStoryAction
 |{kind:'resume';baseRevision:number;topologyKind:WordTopologyReview['kind'];body:{epoch:number;operation:'resume';transactionId:string}}
 |{kind:'cancel'|'legacy';body:{epoch:number;transactionId:string}}
export type WordLayoutAttemptRecord={schemaVersion:'hcd-word-stopped-topology/2';epoch:number;transactionId:string;actor:{userId:string;displayName:string};actions:WordLayoutAction[]}
const options=stoppedTopologyQueueOptions
const keys=(value:unknown,expected:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected
const nonce=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0&&Number.isSafeInteger((value as number)+1)
export const legacyLayoutAttemptKey=(session:Session)=>`hcd-word-layout-attempt/1:${JSON.stringify([session.apiUrl??'',session.collabUrl??'',session.documentId,session.collaborationEpoch,session.userId])}`
export function readWordLayoutAction(value:unknown,session:Session):WordLayoutAction{
 const a=value as WordLayoutAction,b=a?.body,fail=()=>{throw Error('word-layout-record-invalid')}
 if(!a||!['layout','story','resume','cancel','legacy'].includes(a.kind)||!b||b.epoch!==session.collaborationEpoch||!nonce(b.transactionId))return fail()
 if(a.kind==='layout'){
  if(!keys(a,'body,kind,sections')||!keys(b,'edits,epoch,operation,reviewHash,revision,transactionId')||a.body.operation!=='apply'||!revision(a.body.revision)||!hash(a.body.reviewHash))return fail()
  try{activeWordLayoutPending({schemaVersion:'hcd-word-layout-transaction/1',documentId:session.documentId,transactionId:b.transactionId,baseRevision:a.body.revision,expectedRevision:a.body.revision,actor:{userId:session.userId,displayName:session.displayName},edits:a.body.edits},session.documentId,{scope:session.scope,userId:session.userId!,displayName:session.displayName!})}catch{return fail()}
  const fields=new Set(['widthTwips','heightTwips','orientation','marginTop','marginRight','marginBottom','marginLeft','marginHeader','marginFooter','marginGutter','numberStart','numberFormat'])
  if(a.body.edits.changes.length>1024||a.body.edits.changes.some(c=>!c.sectionId||!fields.has(c.field)||['numberStart','numberFormat'].includes(c.field)&&(!validWordNumberingValue(c.field,c.expected)||!validWordNumberingValue(c.field,c.value)))||new TextEncoder().encode(JSON.stringify(b)).length>270*1024)return fail()
  const targets=new Set(a.body.edits.changes.map(c=>c.sectionId)),ids=new Set<string>(),numbers=new Set<number>()
  if(!Array.isArray(a.sections)||a.sections.length!==targets.size)return fail()
  for(const s of a.sections){if(!keys(s,'id,number')||!targets.has(s.id)||!Number.isSafeInteger(s.number)||s.number<1||s.number>4096||ids.has(s.id)||numbers.has(s.number))return fail();ids.add(s.id);numbers.add(s.number)}
 }else if(a.kind==='story'){
  if(!keys(a,'baseRevision,body,kind,section')||!Number.isSafeInteger(a.section)||a.section<1||a.section>4096||!revision(a.baseRevision)||!keys(b,'epoch,kind,operation,reviewHash,sectionId,transactionId,variant')||a.body.operation!=='apply'||!/^n_[a-f0-9]{32}$/.test(a.body.sectionId)||!['header','footer'].includes(a.body.kind)||!['default','first','even'].includes(a.body.variant)||!hash(a.body.reviewHash))return fail()
 }else if(a.kind==='resume'){
  if(!keys(a,'baseRevision,body,kind,topologyKind')||!revision(a.baseRevision)||!['layout','story','link'].includes(a.topologyKind)||!keys(b,'epoch,operation,transactionId')||a.body.operation!=='resume')return fail()
 }else if(!keys(a,'body,kind')||!keys(b,'epoch,transactionId'))return fail()
 return structuredClone(a)
}
export function readWordLayoutAttemptRecord(value:unknown,session:Session):WordLayoutAttemptRecord{
 const v=value as WordLayoutAttemptRecord
 if(!keys(v,'actions,actor,epoch,schemaVersion,transactionId')||v.schemaVersion!=='hcd-word-stopped-topology/2'||v.epoch!==session.collaborationEpoch||!nonce(v.transactionId)||!keys(v.actor,'displayName,userId')||!validContributor({...v.actor,generation:1})||v.actor.userId!==session.userId||v.actor.displayName!==session.displayName||!Array.isArray(v.actions)||!v.actions.length||v.actions.length>16||v.actions.some(a=>readWordLayoutAction(a,session).body.transactionId!==v.transactionId)||new TextEncoder().encode(JSON.stringify(v)).byteLength>options.maxRequestBytes)throw Error('word-layout-record-invalid')
 const original=v.actions[0]
 if(v.actions.some((a,i)=>i>0&&(a.kind==='layout'||a.kind==='story')||a.kind==='resume'&&(original.kind==='layout'||original.kind==='story')&&(a.topologyKind!==original.kind||a.baseRevision!==(original.kind==='layout'?original.body.revision:original.baseRevision))))throw Error('word-layout-record-invalid')
 return structuredClone(v)
}
export class WordLayoutAttempts{
 private raw:string|null=null
 private requests:string[]=[]
 private value:WordLayoutAttemptRecord|null=null
 private version=0
 private generation=0
 private work:Promise<void>|undefined
 private lifetime=new AbortController()
 private listeners=new Set<()=>void>()
 private unsubscribe:(()=>void)|undefined
 phase:'idle'|'pending'|'invalid'='idle'
 error:string|undefined
 revision:number|undefined
 private constructor(readonly session:Session,private storage:DeviceRequestStorage,private legacy:LegacyRequestStorage|undefined){this.unsubscribe=storage.subscribe?.(()=>{void this.refresh().catch(()=>{})})}
 static async open(session:Session,base:string,input:{storage?:DeviceRequestStorage;legacy?:LegacyRequestStorage}={}){
  if(session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol||!session.userId||!session.displayName)throw Error('word-layout-unavailable')
  const scope=await draftNamespace(session,session.userId,base),storage=input.storage??await openWordStoppedRequestStore(scope.prefix+'wordregions2','topology'),value=new WordLayoutAttempts(session,storage,input.legacy)
  try{await value.refresh();return value}catch(error){value.dispose();throw error}
 }
 get record(){return this.value?structuredClone(this.value):null}
 get attemptId(){return this.phase==='invalid'?'invalid':this.value?.transactionId??null}
 get backup(){return this.requests[0]??this.raw}
 get pendingCount(){return this.requests.length}
 get busy(){return !!this.work}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(!this.lifetime.signal.aborted){this.version++;this.listeners.forEach(fn=>fn())}}
 private actor(){return{userId:this.session.userId!,displayName:this.session.displayName!}}
 private legacyRecord(raw:string){return nonce(raw)?JSON.stringify({schemaVersion:'hcd-word-stopped-topology/2',epoch:this.session.collaborationEpoch,transactionId:raw,actor:this.actor(),actions:[{kind:'legacy',body:{epoch:this.session.collaborationEpoch,transactionId:raw}}]}):raw}
 async refresh(){
  if(this.busy)return
  const generation=++this.generation;this.lifetime.signal.throwIfAborted()
  await migrateDeviceRequestLegacy(this.storage,this.legacy,legacyLayoutAttemptKey(this.session),this.lifetime.signal,options,raw=>this.legacyRecord(raw))
  const raw=await this.storage.read();this.lifetime.signal.throwIfAborted();if(this.busy||generation!==this.generation||raw===this.raw&&this.phase!=='invalid')return
  this.raw=raw;this.revision=undefined;this.parse();this.emit()
 }
 private parse(){this.value=null;this.requests=[];try{this.requests=readDeviceRequestQueue(this.raw,options);this.value=this.requests.length?readWordLayoutAttemptRecord(JSON.parse(this.requests[0]),this.session):null;this.phase=this.value?'pending':'idle';this.error=undefined}catch{this.phase='invalid';this.error='word-layout-record-invalid'}}
 private async same(){this.lifetime.signal.throwIfAborted();if(await this.storage.read()!==this.raw||this.legacy?.getItem(legacyLayoutAttemptKey(this.session))!=null)throw Error('word-layout-record-changed');this.lifetime.signal.throwIfAborted()}
 private async persist(requests:readonly string[],exclusive=false){const next=deviceRequestQueueJson(requests,options);await this.storage.replace(this.raw,next,exclusive);this.raw=next;this.parse()}
 private run(action:()=>Promise<void>){
  if(this.work)return Promise.reject(Error('word-layout-busy'))
  const task=Promise.resolve().then(async()=>{try{await this.same();await action();this.lifetime.signal.throwIfAborted();this.error=undefined}catch(error){this.error=error instanceof Error&&error.message.startsWith('word-layout-')?error.message:'word-layout-outcome-unknown';throw error}finally{if(this.work===task)this.work=undefined;if(this.error==='word-layout-record-changed')try{await this.refresh()}catch{}this.emit()}})
  this.generation++;this.work=task;this.emit();return task
 }
 prepare(input:WordLayoutAction,fresh=false){const captured=structuredClone(input);return this.run(async()=>{
  const action=readWordLayoutAction(captured,this.session)
  if(this.phase==='invalid'||fresh&&this.phase!=='idle'||this.value&&this.value.transactionId!==action.body.transactionId||action.kind==='legacy')throw Error('word-layout-request-pending')
  const record:WordLayoutAttemptRecord=this.value?structuredClone(this.value):{schemaVersion:'hcd-word-stopped-topology/2',epoch:this.session.collaborationEpoch!,transactionId:action.body.transactionId,actor:this.actor(),actions:[]}
  if(JSON.stringify(record.actions.at(-1))!==JSON.stringify(action))record.actions.push(action)
  await this.persist([JSON.stringify(readWordLayoutAttemptRecord(record,this.session)),...this.requests.slice(1)],action.kind==='layout'||action.kind==='story');this.revision=undefined
 })}
 complete(id:string){return this.run(async()=>{if(!this.value||this.value.transactionId!==id)throw Error('word-layout-request-pending');await this.persist(this.requests.slice(1))})}
 retry(expected:string){return this.run(async()=>{
  if(this.backup!==expected)throw Error('word-layout-record-changed')
  const action=this.value?.actions.at(-1);if(!action||action.kind==='legacy'||this.phase!=='pending')throw Error('word-layout-request-pending')
  const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(60_000)])
  let revision:number|undefined
  if(action.kind==='layout')revision=(await sendStoppedLayout(this.session,action.body,signal)).revision
  else if(action.kind==='story')revision=(await sendStoppedStory(this.session,action,signal)).revision
  else if(action.kind==='cancel')await cancelUnpreparedTopology(this.session,action.body.transactionId,signal)
  else if(action.kind==='resume'){const result=await wordTopologyRecovery(this.session,'resume',signal,action.body.transactionId);if(result.kind!==action.topologyKind||result.baseRevision!==action.baseRevision||result.status!=='confirmed')throw Error('word-layout-review-required');revision=result.revision}
  else throw Error('word-layout-request-pending')
  await this.same();signal.throwIfAborted();await this.persist(this.requests.slice(1));this.revision=revision
 })}
 dispose(){this.lifetime.abort();this.unsubscribe?.();this.storage.close();this.listeners.clear()}
}
