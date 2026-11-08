/** Exact stopped-draft actions retained across windows and restarts. The
 * browser records member intent; native journal/signatures remain authority. */
import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {draftNamespace} from './localDrafts.ts'
import {validContributor} from './referenceAuthors.ts'
import {openWordStoppedRequestStore,stoppedDraftQueueOptions} from './wordStoppedRequestStore.ts'
import {readDeviceRequestQueue,deviceRequestQueueJson,migrateDeviceRequestLegacy,type DeviceRequestStorage,type LegacyRequestStorage} from './wordDeviceRequestQueue.ts'
export type WordDraftAction=
 |{kind:'save';baseRevision:number;body:{epoch:number;operation:'save';checkpointId:string;reviewHash:string}}
 |{kind:'resume';body:{epoch:number;operation:'resume';checkpointId:string}}
 |{kind:'rebase-stale';baseRevision:number;body:{epoch:number;operation:'rebase-stale';checkpointId:string;reviewHash:string;headRevision:number}}
 |{kind:'cancel'|'legacy';body:{epoch:number;checkpointId:string}}
export type WordDraftAttemptRecord={schemaVersion:'hcd-word-draft-attempt/2';epoch:number;checkpointId:string;actor:{userId:string;displayName:string};actions:WordDraftAction[]}
const options=stoppedDraftQueueOptions
const keys=(value:unknown,expected:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected
const nonce=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0
export const legacyDraftAttemptKey=(session:Session)=>`hcd-word-draft-attempt/1:${JSON.stringify([session.apiUrl??'',session.collabUrl??'',session.documentId,session.collaborationEpoch,session.userId])}`
export function readWordDraftAction(value:unknown,session:Session):WordDraftAction{
 const a=value as WordDraftAction,b=a?.body,fail=()=>{throw Error('word-draft-record-invalid')}
 if(!a||!['save','resume','rebase-stale','cancel','legacy'].includes(a.kind)||!keys(a,['save','rebase-stale'].includes(a.kind)?'baseRevision,body,kind':'body,kind')||!b||b.epoch!==session.collaborationEpoch||!nonce(b.checkpointId))return fail()
 if(a.kind==='save'||a.kind==='rebase-stale'){
  if(!revision(a.baseRevision)||!hash(a.body.reviewHash)||a.body.operation!==a.kind||!keys(b,a.kind==='save'?'checkpointId,epoch,operation,reviewHash':'checkpointId,epoch,headRevision,operation,reviewHash')||a.kind==='rebase-stale'&&(!revision(a.body.headRevision)||a.body.headRevision<=a.baseRevision))return fail()
 }else if(a.kind==='resume'){if(!keys(b,'checkpointId,epoch,operation')||a.body.operation!=='resume')return fail()}
 else if(!keys(b,'checkpointId,epoch'))return fail()
 return structuredClone(a)
}
export function readWordDraftAttemptRecord(value:unknown,session:Session):WordDraftAttemptRecord{
 const v=value as WordDraftAttemptRecord
 if(!keys(v,'actions,actor,checkpointId,epoch,schemaVersion')||v.schemaVersion!=='hcd-word-draft-attempt/2'||v.epoch!==session.collaborationEpoch||!nonce(v.checkpointId)||!keys(v.actor,'displayName,userId')||!validContributor({...v.actor,generation:1})||v.actor.userId!==session.userId||v.actor.displayName!==session.displayName||!Array.isArray(v.actions)||!v.actions.length||v.actions.length>16||v.actions.some(a=>readWordDraftAction(a,session).body.checkpointId!==v.checkpointId)||new TextEncoder().encode(JSON.stringify(v)).byteLength>64*1024)throw Error('word-draft-record-invalid')
 return structuredClone(v)
}
export class WordDraftAttempts{
 private raw:string|null=null
 private requests:string[]=[]
 private value:WordDraftAttemptRecord|null=null
 private version=0
 private generation=0
 private work:Promise<void>|undefined
 private lifetime=new AbortController()
 private listeners=new Set<()=>void>()
 private unsubscribe:(()=>void)|undefined
 phase:'idle'|'pending'|'invalid'='idle'
 error:string|undefined
 private constructor(readonly session:Session,private storage:DeviceRequestStorage,private legacy:LegacyRequestStorage|undefined){this.unsubscribe=storage.subscribe?.(()=>{void this.refresh().catch(()=>{})})}
 static async open(session:Session,base:string,input:{storage?:DeviceRequestStorage;legacy?:LegacyRequestStorage}={}){
  if(session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol||!session.userId||!session.displayName)throw Error('word-draft-unavailable')
  const scope=await draftNamespace(session,session.userId,base),storage=input.storage??await openWordStoppedRequestStore(scope.prefix+'wordregions2','draft'),value=new WordDraftAttempts(session,storage,input.legacy)
  try{await value.refresh();return value}catch(error){value.dispose();throw error}
 }
 get record(){return this.value?structuredClone(this.value):null}
 get attemptId(){return this.phase==='invalid'?'invalid':this.value?.checkpointId??null}
 get backup(){return this.requests[0]??this.raw}
 get pendingCount(){return this.requests.length}
 get busy(){return !!this.work}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(!this.lifetime.signal.aborted){this.version++;this.listeners.forEach(fn=>fn())}}
 private actor(){return{userId:this.session.userId!,displayName:this.session.displayName!}}
 private legacyRecord(raw:string){return nonce(raw)?JSON.stringify({schemaVersion:'hcd-word-draft-attempt/2',epoch:this.session.collaborationEpoch,checkpointId:raw,actor:this.actor(),actions:[{kind:'legacy',body:{epoch:this.session.collaborationEpoch,checkpointId:raw}}]}):raw}
 async refresh(){
  if(this.busy)return
  const generation=++this.generation;this.lifetime.signal.throwIfAborted()
  await migrateDeviceRequestLegacy(this.storage,this.legacy,legacyDraftAttemptKey(this.session),this.lifetime.signal,options,raw=>this.legacyRecord(raw))
  const raw=await this.storage.read();this.lifetime.signal.throwIfAborted();if(this.busy||generation!==this.generation||raw===this.raw&&this.phase!=='invalid')return
  this.raw=raw;this.parse();this.emit()
 }
 private parse(){this.value=null;this.requests=[];try{this.requests=readDeviceRequestQueue(this.raw,options);this.value=this.requests.length?readWordDraftAttemptRecord(JSON.parse(this.requests[0]),this.session):null;this.phase=this.value?'pending':'idle';this.error=undefined}catch{this.phase='invalid';this.error='word-draft-record-invalid'}}
 private async same(){this.lifetime.signal.throwIfAborted();if(await this.storage.read()!==this.raw||this.legacy?.getItem(legacyDraftAttemptKey(this.session))!=null)throw Error('word-draft-record-changed');this.lifetime.signal.throwIfAborted()}
 private async persist(requests:readonly string[],exclusive=false){const next=deviceRequestQueueJson(requests,options);await this.storage.replace(this.raw,next,exclusive);this.raw=next;this.parse()}
 private run(action:()=>Promise<void>){
  if(this.work)return Promise.reject(Error('word-draft-busy'))
  const task=Promise.resolve().then(async()=>{try{await this.same();await action();this.lifetime.signal.throwIfAborted();this.error=undefined}catch(error){this.error=error instanceof Error&&error.message.startsWith('word-draft-')?error.message:'word-draft-storage';throw error}finally{if(this.work===task)this.work=undefined;if(this.error==='word-draft-record-changed')try{await this.refresh()}catch{}this.emit()}})
  this.generation++;this.work=task;this.emit();return task
 }
 async beginSave(reviewHash:string,baseRevision:number){
  const id=crypto.randomUUID().replaceAll('-',''),action:WordDraftAction={kind:'save',baseRevision,body:{epoch:this.session.collaborationEpoch!,operation:'save',checkpointId:id,reviewHash}}
  await this.prepare(action,true);return id
 }
 prepare(input:WordDraftAction,fresh=false){return this.run(async()=>{
  const action=readWordDraftAction(input,this.session)
  if(this.phase==='invalid'||fresh&&this.phase!=='idle'||this.value&&this.value.checkpointId!==action.body.checkpointId||action.kind==='legacy')throw Error('word-draft-request-pending')
  const record:WordDraftAttemptRecord=this.value?structuredClone(this.value):{schemaVersion:'hcd-word-draft-attempt/2',epoch:this.session.collaborationEpoch!,checkpointId:action.body.checkpointId,actor:this.actor(),actions:[]}
  if(JSON.stringify(record.actions.at(-1))!==JSON.stringify(action))record.actions.push(action)
  await this.persist([JSON.stringify(readWordDraftAttemptRecord(record,this.session)),...this.requests.slice(1)],action.kind==='save'||action.kind==='rebase-stale')
 })}
 complete(id:string){return this.run(async()=>{if(!this.value||this.value.checkpointId!==id)throw Error('word-draft-request-pending');await this.persist(this.requests.slice(1))})}
 dispose(){this.lifetime.abort();this.unsubscribe?.();this.storage.close();this.listeners.clear()}
}
