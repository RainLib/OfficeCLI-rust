/** Durable exact page requests with cross-window CAS and lossless legacy-tab
 * migration. No token, document text or resources enter these records. */
import type {Session} from './api.ts'
import type {WordLayout} from './wordRegions.ts'
import type {WordLayoutPending} from './wordCheckpointJournal.ts'
import {activeWordLayoutPending} from './wordActiveLayout.ts'
import {readWordActiveLayoutStatus} from './wordActiveLayoutClient.ts'
import {draftNamespace} from './localDrafts.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {wordBrowserHeaders} from './wordBrowserProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {openWordStoryRequestStore} from './wordStoryRequestStore.ts'
import {validWordNumberingValue} from './wordNumberingIntent.ts'
import {migrateWordPageLegacy,readWordPageQueue,wordPageQueueJson,type WordPageStorage,type WordPageLegacyStorage} from './wordPageDeviceQueue.ts'
export type WordPageOpenOptions={storage?:WordPageStorage;legacy?:WordPageLegacyStorage}
type Request=WordLayoutPending['request']
export type WordPageRecord={schemaVersion:'hcd-word-page-request/1';epoch:number;operation:'apply'|'cancel';request:Request;sections:Array<{id:string;number:number}>}
const fields=new Set(['widthTwips','heightTwips','orientation','marginTop','marginRight','marginBottom','marginLeft','marginHeader','marginFooter','marginGutter','numberStart','numberFormat'])
export class WordPageSetupError extends Error{constructor(readonly code:string){super(code)}}
export function readWordPageRecord(value:unknown,session:Session):WordPageRecord{
 const v=value as WordPageRecord
 if(!v||Object.keys(v).sort().join(',')!=='epoch,operation,request,schemaVersion,sections'||v.schemaVersion!=='hcd-word-page-request/1'||v.epoch!==session.collaborationEpoch||!['apply','cancel'].includes(v.operation)||!Array.isArray(v.sections)||!v.sections.length||v.sections.length>4096||!session.userId||!session.displayName)throw Error('word-page-record-invalid')
 const pending=activeWordLayoutPending(v.request,session.documentId,{userId:session.userId,displayName:session.displayName,scope:session.scope})
 if(pending.request.baseRevision!==pending.request.expectedRevision||pending.request.edits.changes.some(c=>!c.sectionId||!fields.has(c.field)||['numberStart','numberFormat'].includes(c.field)&&(!validWordNumberingValue(c.field,c.expected)||!validWordNumberingValue(c.field,c.value))))throw Error('word-page-record-invalid')
 const ids=new Set<string>(),numbers=new Set<number>()
 for(const section of v.sections){if(!section||Object.keys(section).sort().join(',')!=='id,number'||!/^n_[a-f0-9]{32}$/.test(section.id)||!Number.isSafeInteger(section.number)||section.number<1||ids.has(section.id)||numbers.has(section.number))throw Error('word-page-record-invalid');ids.add(section.id);numbers.add(section.number)}
 const targets=new Set(pending.request.edits.changes.map(c=>c.sectionId!));if(ids.size!==targets.size||[...targets].some(id=>!ids.has(id)))throw Error('word-page-record-invalid')
 const record={schemaVersion:v.schemaVersion,epoch:v.epoch,operation:v.operation,request:pending.request,sections:v.sections.map(s=>({...s}))}
 if(new TextEncoder().encode(JSON.stringify(record)).byteLength>512*1024||new TextEncoder().encode(JSON.stringify({epoch:v.epoch,request:pending.request})).byteLength>270*1024)throw Error('word-page-record-limit')
 return record
}
export class WordPageTransaction{
 private value:WordPageRecord|null=null
 private raw:string|null=null
 private version=0
 private listeners=new Set<()=>void>()
 private lifetime=new AbortController()
 private work:Promise<void>|undefined
 private workKind:'prepare'|'apply'|'cancel'|'check'|'finish'|undefined
 private unsubscribe:(()=>void)|undefined
 private requests:string[]=[]
 private refreshGeneration=0
 private recoveryRequest:string|null=null
 phase:'idle'|'pending'|'installed'|'cancelled'|'invalid'='idle'
 error:string|undefined
 revision:number|undefined
 private constructor(readonly session:Session,private storage:WordPageStorage,private legacy:WordPageLegacyStorage|undefined,private key:string){this.unsubscribe=storage.subscribe?.(()=>{void this.refresh().catch(()=>{})})}
 static async open(session:Session,base:string,options:WordPageOpenOptions={}){
  if(session.scope!=='write'||session.collaborationProtocol!==wordLayoutProtocol||!session.userId||!session.displayName)throw Error('word-page-unavailable')
  const scope=await draftNamespace(session,session.userId,base),storage=options.storage??await openWordStoryRequestStore('hcd-word-page-request-v2-'+scope.prefix+'wordregions2',indexedDB,'word-page'),value=new WordPageTransaction(session,storage,options.legacy,'hcd-word-page-request/1:'+scope.name)
  try{await value.refresh();return value}catch(error){value.dispose();throw error}
 }
 async refresh(){
  if(this.busy)return
  this.lifetime.signal.throwIfAborted();const generation=++this.refreshGeneration
  await migrateWordPageLegacy(this.storage,this.legacy,this.key,this.lifetime.signal)
  const raw=await this.storage.read();this.lifetime.signal.throwIfAborted();if(this.busy||generation!==this.refreshGeneration)return;if(raw===this.raw&&this.phase!=='invalid')return
  this.raw=raw;this.value=null;this.requests=[];this.revision=undefined;this.recoveryRequest=null
  try{this.requests=readWordPageQueue(raw);this.value=this.requests.length?readWordPageRecord(JSON.parse(this.requests[0]),this.session):null;this.phase=this.value?'pending':'idle';this.recoveryRequest=this.value?.request.transactionId??null;this.error=undefined}catch{this.phase='invalid';this.error='word-page-record-invalid'}this.emit()
 }
 get resumeId(){return this.recoveryRequest}
 get backup(){return this.requests[0]??this.raw}
 get pendingCount(){return this.requests.length}
 get record(){return this.value?structuredClone(this.value):null}
 get busy(){return !!this.work}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(!this.lifetime.signal.aborted){this.version++;this.listeners.forEach(fn=>fn())}}
 private async same(){this.lifetime.signal.throwIfAborted();if(await this.storage.read()!==this.raw||this.legacy?.getItem(this.key)!=null)throw Error('word-page-record-changed');this.lifetime.signal.throwIfAborted()}
 private async persist(requests:readonly string[]){
  const next=wordPageQueueJson(requests);await this.storage.replace(this.raw,next);this.raw=next;this.requests=[...requests];this.value=requests.length?readWordPageRecord(JSON.parse(requests[0]),this.session):null
 }
 prepare(revision:number,edits:Request['edits'],layout:WordLayout){return this.run('prepare',async()=>{
  if(this.phase!=='idle')throw new WordPageSetupError('word-page-request-pending')
  const ids=new Set(edits.changes.map(c=>c.sectionId)),record:WordPageRecord={schemaVersion:'hcd-word-page-request/1',epoch:this.session.collaborationEpoch!,operation:'apply',request:{schemaVersion:'hcd-word-layout-transaction/1',documentId:this.session.documentId,transactionId:crypto.randomUUID().replaceAll('-',''),baseRevision:revision,expectedRevision:revision,actor:{userId:this.session.userId!,displayName:this.session.displayName!},edits:structuredClone(edits)},sections:layout.sections.flatMap((s,i)=>ids.has(s.id)?[{id:s.id,number:i+1}]:[])}
  try{await this.persist([JSON.stringify(readWordPageRecord(record,this.session))]);this.phase='pending';this.recoveryRequest=null}catch(error){if(error instanceof Error&&error.message==='word-page-record-changed')throw error;throw new WordPageSetupError('word-page-storage')}
 })}
 private run(kind:NonNullable<WordPageTransaction['workKind']>,action:()=>Promise<void>){
  if(this.work)return this.workKind===kind?this.work:Promise.reject(Error('word-page-busy'))
  const task=Promise.resolve().then(async()=>{try{await this.same();if(kind!=='prepare'&&(!this.value||this.phase==='invalid'))throw Error('word-page-record-invalid');await action();this.error=undefined}catch(error){this.error=error instanceof Error&&/^(word-page-|word-active-layout-)/.test(error.message)?error.message:'word-page-unavailable';throw error}finally{if(this.work===task){this.work=undefined;this.workKind=undefined}if(this.error==='word-page-record-changed')try{await this.refresh()}catch{}this.emit()}})
  this.refreshGeneration++;this.workKind=kind;this.work=task;this.emit();return task
 }
 private async call(operation:'apply'|'cancel'|'check'){
  const record=this.value!,signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(60000)]);signal.throwIfAborted()
  const response=await awaitRecoveryResponse(()=>fetch(negotiationURL(this.session).replace(/\/negotiate$/,operation==='apply'?'/word-active-layout':operation==='cancel'?'/word-active-layout-cancel':'/word-active-layout-check'),{method:'POST',headers:{Authorization:`Bearer ${this.session.token}`,'Content-Type':'application/json',...wordBrowserHeaders(this.session)},body:JSON.stringify({epoch:record.epoch,request:record.request}),redirect:'error',signal}),signal)
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('word-page-outcome-unknown')}
  const bytes=await readBoundedResponse(response,16384,signal,'word-page-response-limit');let result:any;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('word-page-response-invalid')}
  await this.same();signal.throwIfAborted()
  if(operation!=='cancel'){if(!result||Object.keys(result).sort().join(',')!=='revision,status,transactionId'||result.status!=='installed'||result.transactionId!==record.request.transactionId||result.revision!==record.request.expectedRevision+1)throw Error('word-page-response-invalid');this.revision=result.revision;this.phase='installed'}
  else{if(!result||Object.keys(result).sort().join(',')!=='status,transactionId'||result.status!=='not-prepared'||result.transactionId!==record.request.transactionId)throw Error('word-page-response-invalid');this.phase='cancelled'}
 }
 retry(){return this.run(this.value?.operation??'apply',()=>this.call(this.value!.operation))}
 cancel(){return this.run('cancel',async()=>{if(this.phase==='installed')throw Error('word-page-already-installed');if(this.value!.operation!=='cancel'){const record=readWordPageRecord({...this.value!,operation:'cancel'},this.session);await this.persist([JSON.stringify(record),...this.requests.slice(1)])}await this.call('cancel')})}
 check(){return this.run('check',async()=>{
  const result=await readWordActiveLayoutStatus(this.session,this.value!.request.transactionId,this.lifetime.signal);await this.same()
  if(result.status==='installed'){if(result.revision!==this.value!.request.expectedRevision+1)throw Error('word-page-response-invalid');this.phase='installed';this.revision=result.revision}
  else if(result.status==='cancelled')this.phase='cancelled'
  else{this.phase='pending';if(this.value!.operation==='cancel')await this.call('cancel');else if(result.status==='recovery-required')await this.call('check')}
 })}
 finish(){return this.run('finish',async()=>{
  if(!['installed','cancelled'].includes(this.phase))throw Error('word-page-outcome-unknown')
  // Advancing the queue is the same CAS as deletion: another window's new
  // request cannot be erased. A malformed next request remains downloadable.
  const remaining=this.requests.slice(1),next=wordPageQueueJson(remaining);await this.storage.replace(this.raw,next);this.raw=next;this.requests=remaining;this.value=null;this.revision=undefined
  try{this.value=remaining.length?readWordPageRecord(JSON.parse(remaining[0]),this.session):null;this.phase=this.value?'pending':'idle';this.recoveryRequest=this.value?.request.transactionId??null}catch{this.phase='invalid';this.recoveryRequest=null}
 })}
 dispose(){this.lifetime.abort();this.unsubscribe?.();this.storage.close();this.listeners.clear()}
}
