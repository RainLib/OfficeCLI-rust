/** Browser upload choices use stable IDs and a device metadata journal. The
 * provider's document is never seeded with a cached image/upload snapshot. */
import * as Y from 'yjs'
import {negotiationURL} from './protocolClient.ts'
import {validateWordUploads,validateLocalUpload,type WordUploadRecord,type WordLocalUpload} from './wordUploadTypes.ts'
import {imageIntents,imageReceiptMap,type CollaborativeImageDraftStore} from './collaborativeImages.ts'
import type {WordDeviceDraft} from './wordDeviceDraft.ts'
import type {WordBrowserState} from './wordBrowserState.ts'
import type {Session} from './api.ts'
import type {PositionedImage} from './imageDrafts.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {wordBrowserHeaders,requireWordBrowserProtocol} from './wordBrowserProtocol.ts'
export class WordUploadClientError extends Error{constructor(readonly code:string,readonly uncertain=false){super(code)}}
export type WordUploadJob={id:string;name:string;nodeId:string;phase:'preparing'|'uploading'|'reserved'|'interrupted'|'applied'|'cancelled';problem?:string;record?:WordUploadRecord;choice?:WordLocalUpload}
type Options={session:Session;document:Y.Doc;cache:WordDeviceDraft;controller:WordBrowserState;images:CollaborativeImageDraftStore;ready:()=>boolean;fetch?:typeof fetch;timeoutMs?:number}
const unfinished=(job:WordUploadJob)=>!['applied','cancelled'].includes(job.phase)
async function readUploadFile(file:File,signal:AbortSignal){
 const bytes=new Uint8Array(await awaitRecoveryPreparation(()=>file.arrayBuffer(),signal))
 const digest=await awaitRecoveryPreparation(()=>crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)),signal)
 signal.throwIfAborted();return{bytes,hash:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')}
}
export class WordUploadClient{
 private jobs=new Map<string,WordUploadJob>()
 private runs=new Map<string,AbortController>()
 private cancelling=new Map<string,Promise<void>>()
 private listeners=new Set<()=>void>()
 private version=0
 private closed=false
 private abort=new AbortController()
 private recorded=new Set<string>()
 private loading=true
 private problem:string|undefined
 private storageProblem=false
 constructor(readonly options:Options){if(options.cache.protocol!==requireWordBrowserProtocol(options.session.collaborationProtocol))throw new WordUploadClientError('word-device-protocol');options.controller.setLocalUploadPending(true)}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 state(){return{jobs:[...this.jobs.values()],loading:this.loading,problem:this.storageProblem?'word-upload-local-invalid':this.problem,busy:this.runs.size>0||this.cancelling.size>0,pending:this.loading||!!this.problem||this.storageProblem||this.cancelling.size>0||[...this.jobs.values()].some(unfinished)}}
 private emit(){if(this.closed)return;this.version++;this.options.controller.setLocalUploadPending(this.state().pending);this.listeners.forEach(listener=>listener())}
 private set(job:WordUploadJob){this.jobs.set(job.id,job);for(const[id,entry]of this.jobs)if(this.jobs.size>48&&id!==job.id&&!unfinished(entry)&&!this.runs.has(id)&&!this.cancelling.has(id))this.jobs.delete(id);this.emit()}
 private async request(body:object|Uint8Array,id?:string,signal=this.abort.signal){
  const session=this.options.session,url=negotiationURL(session).replace(/negotiate$/,'word-uploads')+(id?`/${id}`:'');let response:Response
  try{response=await (this.options.fetch??fetch)(url,{method:id?'PUT':'POST',headers:{Authorization:`Bearer ${session.token}`,...wordBrowserHeaders(session),'X-HCD-Collaboration-Epoch':String(session.collaborationEpoch),'Content-Type':id?'application/octet-stream':'application/json'},body:id?body as BodyInit:JSON.stringify(body),signal:AbortSignal.any([signal,this.abort.signal,AbortSignal.timeout(this.options.timeoutMs??55000)])})}catch{throw new WordUploadClientError('word-upload-unavailable',true)}
  if(!response.ok){let code='word-upload-unavailable';try{const value=await response.json();if(typeof value.code==='string'&&/^word-upload-[a-z:-]{1,80}(?:\d{3})?$/.test(value.code))code=value.code}catch{};throw new WordUploadClientError(code,response.status>=500)}
  let value:any;try{value=await response.json();if(value.version!==1)throw new Error();if('records'in value)validateWordUploads(value.records);else{validateWordUploads([value.record]);const action=body as any,expected=id??action.id??action.selection?.id;if(value.record.id!==expected)throw new Error();if(action.selection&&['nodeId','assetHash','byteLength','revision','clientId','extension'].some(key=>value.record[key]!==action.selection[key]))throw new Error();if(['resume'].includes(action.operation)||id){if(value.record.phase!=='applied')throw new Error()}if(['cancel','cancel-selection'].includes(action.operation)&&value.record.phase!=='cancelled')throw new Error()}if(this.options.session.userId&&('records'in value?value.records:[value.record]).some((record:WordUploadRecord)=>record.actor.userId!==this.options.session.userId))throw new Error();return value}catch{throw new WordUploadClientError('word-upload-invalid-response',true)}
 }
 async initialize(){
  try{for(const choice of await this.options.cache.pendingUploads()){validateLocalUpload(choice);this.set({id:choice.selection.id,name:choice.name,nodeId:choice.selection.nodeId,phase:'interrupted',choice,problem:'word-upload-interrupted'})}await this.refresh()}catch(error){this.problem=error instanceof Error?error.message:'word-upload-unavailable'}finally{this.loading=false;this.emit()}
 }
 /** Check the shared device journal even if a cross-window notification was missed. */
 async checkPending(){
  if(this.closed)return true
  try{
   const choices=await this.options.cache.pendingUploads();if(this.closed)return true
   for(const choice of choices){validateLocalUpload(choice);if(!this.jobs.has(choice.selection.id))this.set({id:choice.selection.id,name:choice.name,nodeId:choice.selection.nodeId,phase:'interrupted',choice,problem:'word-upload-interrupted'})}
   this.storageProblem=false;this.emit();return this.state().pending
  }catch{this.storageProblem=true;this.emit();return true}
 }
 async refresh(){
  const result=await this.request({operation:'list',ids:[...this.jobs.values()].filter(unfinished).map(job=>job.id)});if(this.closed)return
  this.problem=undefined
  for(const record of result.records as WordUploadRecord[]){const previous=this.jobs.get(record.id);if(!previous&&!['reserved','staged','interrupted'].includes(record.phase))continue
   if(record.phase==='applied'||record.phase==='cancelled'){if(previous)await this.finish(record,record.phase==='applied'&&record.clientId===this.options.document.clientID);continue}
   this.set({id:record.id,name:previous?.name??record.extension,nodeId:record.nodeId,phase:record.phase==='staged'?'reserved':record.phase,record,choice:previous?.choice,problem:record.problem})
  }
  this.emit()
 }
 private async waitApplied(record:WordUploadRecord){
  const seen=()=>imageIntents(this.options.document).some(entry=>(entry.intentId===record.id&&entry.assetHash===record.assetHash)||entry.ancestors.includes(record.id))||((this.options.document.getMap(imageReceiptMap).get(record.nodeId) as any)?.image?.assetHash===record.assetHash)
  if(seen())return
  await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);this.options.document.off('update',check);this.abort.signal.removeEventListener('abort',abort)},check=()=>{if(seen()){cleanup();resolve()}},abort=()=>{cleanup();reject(new WordUploadClientError('word-upload-unavailable',true))},timer=setTimeout(()=>{cleanup();reject(new WordUploadClientError('word-upload-sync-required',true))},15000);this.options.document.on('update',check);this.abort.signal.addEventListener('abort',abort,{once:true});if(this.abort.signal.aborted)abort();else check()})
 }
 private async finish(record:WordUploadRecord,history=true){
  if(this.closed)return
  const previous=this.jobs.get(record.id)
  if(record.phase==='applied'){
   await this.waitApplied(record);if(this.closed)return
   if(history&&!this.recorded.has(record.id)&&record.base){const before=previous?.choice?.before??{...record.base,assetHash:record.seen.find(entry=>entry.touched.includes('assetHash'))?.assetHash??record.base.assetHash};this.options.images.acceptServerReplacement(record.id,record.nodeId,record.assetHash,record.clientId);this.options.images.actions.emit({kind:'replace',before,after:{...before,assetHash:record.assetHash},revision:record.revision});this.recorded.add(record.id)}
  }
  await this.options.cache.removeUpload(record.id);if(this.closed)return
  this.set({id:record.id,name:previous?.name??record.extension,nodeId:record.nodeId,phase:record.phase==='cancelled'?'cancelled':'applied',record})
 }
 async start(file:File,image:PositionedImage){
  if([...this.jobs.values()].filter(unfinished).length>=16)throw new WordUploadClientError('word-upload-limit')
  if(this.closed||!this.options.ready())throw new WordUploadClientError('word-upload-sync-required')
  const extension=file.name.split('.').pop()?.toLowerCase();if(!extension||!['png','jpg','jpeg','gif','webp'].includes(extension)||!file.size||file.size>8*1024*1024)throw new WordUploadClientError('word-upload-input-invalid')
  const id=crypto.randomUUID(),cancel=new AbortController(),revision=this.options.controller.state().revision,current=this.options.images.currentImage(image,revision??0),draft=this.options.images.get(image.nodeId)
  if(revision===null||draft?.collaborationConflict)throw new WordUploadClientError('word-upload-sync-required')
  const before={...current,geometry:{...(draft?.geometry??current.geometry)},assetHash:draft?.assetHash??current.assetHash},seen=imageIntents(this.options.document).filter(entry=>entry.base.nodeId===image.nodeId)
  this.runs.set(id,cancel);this.set({id,name:file.name.slice(0,256),nodeId:image.nodeId,phase:'preparing'})
  try{
   const {bytes,hash:assetHash}=await readUploadFile(file,AbortSignal.any([cancel.signal,this.abort.signal]));cancel.signal.throwIfAborted();this.abort.signal.throwIfAborted()
   const choice:WordLocalUpload={name:file.name.slice(0,256),before,bytes:Uint8Array.from(bytes),selection:{id,nodeId:image.nodeId,extension:extension as WordUploadRecord['extension'],assetHash,byteLength:bytes.length,revision,clientId:this.options.document.clientID,visualHash:current.visualHash,seen}};this.set({...this.jobs.get(id)!,choice});await this.options.cache.putUpload(choice,AbortSignal.any([cancel.signal,this.abort.signal]));cancel.signal.throwIfAborted()
   await this.request({operation:'reserve',selection:choice.selection},undefined,cancel.signal);cancel.signal.throwIfAborted();this.set({...this.jobs.get(id)!,phase:'uploading'})
   const result=await this.request(bytes,id,cancel.signal);cancel.signal.throwIfAborted();await this.finish(result.record)
  }catch(error){if(this.cancelling.has(id)||this.jobs.get(id)?.phase==='cancelled')return;if(!this.closed)this.set({...this.jobs.get(id)!,phase:'interrupted',problem:error instanceof Error?error.message:'word-upload-unavailable'});throw error}finally{this.runs.delete(id);this.emit()}
 }
 async resume(id:string,file?:File){
  const job=this.jobs.get(id);if(this.closed||!job||this.runs.has(id))throw new WordUploadClientError('word-upload-busy')
  const cancel=new AbortController();this.runs.set(id,cancel);this.set({...job,phase:'uploading',problem:undefined})
  try{
   let bytes:Uint8Array|undefined
   if(file){const captured=await readUploadFile(file,AbortSignal.any([cancel.signal,this.abort.signal]));bytes=captured.bytes;const expected=job.choice?.selection??job.record;if(!expected||bytes.length!==expected.byteLength||captured.hash!==expected.assetHash)throw new WordUploadClientError('word-upload-file-differs')}
   else if(job.choice?.bytes){bytes=Uint8Array.from(job.choice.bytes);if(bytes.length!==job.choice.selection.byteLength||await imageFileHash(bytes)!==job.choice.selection.assetHash)throw new WordUploadClientError('word-upload-file-differs')}
   cancel.signal.throwIfAborted();if(job.choice)await this.request({operation:'reserve',selection:job.choice.selection},undefined,cancel.signal)
   let result:any;try{result=await this.request({operation:'resume',id},undefined,cancel.signal)}catch(error){if(!(error instanceof WordUploadClientError)||error.code!=='word-upload-file-required'||!bytes)throw error;result=await this.request(bytes,id,cancel.signal)}
   cancel.signal.throwIfAborted();await this.finish(result.record)
  }catch(error){if(this.cancelling.has(id)||this.jobs.get(id)?.phase==='cancelled')return;if(!this.closed)this.set({...this.jobs.get(id)!,phase:'interrupted',problem:error instanceof Error?error.message:'word-upload-unavailable'});throw error}finally{this.runs.delete(id);this.emit()}
 }
 cancel(id:string){const existing=this.cancelling.get(id);if(existing)return existing;const work=this.performCancel(id);this.cancelling.set(id,work);this.emit();void work.finally(()=>{this.cancelling.delete(id);this.emit()}).catch(()=>{});return work}
 private async performCancel(id:string){
  const job=this.jobs.get(id);if(!job||this.closed)throw new WordUploadClientError('word-upload-not-found')
  this.runs.get(id)?.abort();if(!job.choice&&!job.record){this.set({...job,phase:'cancelled',problem:undefined});return}
  try{const result=await this.request(job.choice?{operation:'cancel-selection',selection:job.choice.selection}:{operation:'cancel',id});await this.finish(result.record,false)}catch(error){if(!this.closed)this.set({...this.jobs.get(id)!,phase:'interrupted',problem:error instanceof Error?error.message:'word-upload-unavailable'});throw error}
 }
 dispose(){this.closed=true;this.abort.abort();for(const controller of this.runs.values())controller.abort();this.listeners.clear()}
}
