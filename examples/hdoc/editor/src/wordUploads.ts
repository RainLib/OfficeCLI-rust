/** Private server upload reservations. Native staging descriptors pin bytes;
 * these records pin the user's pending choice, not an owner/cluster lease. */
import {createHash,randomUUID} from 'node:crypto'
import {actorName,validActorId} from './referenceAuthors.ts'
import {validateImageReplacementCapture,type ImageReplacementCapture,type SharedImageDraft} from './collaborativeImages.ts'
import type {PositionedImage} from './imageDrafts.ts'
export {validateWordUploads} from './wordUploadTypes.ts'
export type {WordUploadActor,WordUploadRecord} from './wordUploadTypes.ts'
import {validateWordUploads,validateWordSelection,type WordUploadActor,type WordUploadRecord,type WordUploadSelection} from './wordUploadTypes.ts'
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value)
const node=(value:unknown)=>typeof value==='string'&&/^n_[a-f0-9]{32}$/.test(value)
const integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0
const active=(record:WordUploadRecord)=>['reserved','staged','interrupted'].includes(record.phase)
type Options={
 request:(actor:WordUploadActor,route:string,init?:RequestInit)=>Promise<Response>
 authorize?:(actor:WordUploadActor)=>Promise<boolean>
 capture:(nodeId:string)=>{revision:number;regionId:string;clientId:number;seen:SharedImageDraft[]}
 imageAt:(nodeId:string,revision:number)=>Promise<PositionedImage>
 apply:(record:WordUploadRecord,capture:ImageReplacementCapture)=>void
 persist:()=>Promise<void>;changed:()=>void;available:()=>boolean;timeoutMs?:number
}
/** A promise whose transport may ignore abort still settles promptly. Its late
 * value is consumed, and the caller must pass live() before every side effect. */
function interruptible<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason??new Error('word-upload-interrupted'))},cleanup=()=>signal.removeEventListener('abort',abort)
  promise.then(value=>{cleanup();signal.aborted?abort():resolve(value)},error=>{cleanup();reject(error)})
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})
 })
}
function retryDelay(signal:AbortSignal,delay:number):Promise<void>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new Error('word-upload-interrupted'))}
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},delay)
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
 })
}
export class WordUploadLedger{
 private records=new Map<string,WordUploadRecord>()
 private running=new Map<string,AbortController>()
 private tasks=new Set<Promise<unknown>>()
 private preparing=new Map<string,Promise<WordUploadRecord>>()
 private closed=false
 constructor(private options:Options,restored:WordUploadRecord[]=[]){
  validateWordUploads(restored)
  for(const value of restored){const record=structuredClone(value);if(active(record)){record.phase='interrupted';record.problem='word-upload-interrupted'}this.records.set(record.id,record)}
 }
 snapshot(){return structuredClone([...this.records.values()])}
 get pending(){return this.running.size>0||[...this.records.values()].some(active)}
 get summary(){return{active:[...this.records.values()].filter(active).length,interrupted:[...this.records.values()].filter(record=>record.phase==='interrupted').length,running:this.running.size}}
 private owned(actor:WordUploadActor,id:string){
  if(this.closed||!this.options.available())throw new Error('word-upload-unavailable')
  const record=this.records.get(id);if(actor.scope!=='write'||!validActorId(actor.userId)||record?.actor.userId!==actor.userId)throw new Error('word-upload-owner-required')
  return record
 }
 private trim(){for(const [id,record]of this.records)if(this.records.size>=128&&!active(record)&&!this.running.has(id))this.records.delete(id)}
 start(actor:WordUploadActor,input:{nodeId:string;extension:WordUploadRecord['extension'];bytes:Uint8Array;signal?:AbortSignal}){
  if(this.closed||!this.options.available())throw new Error('word-upload-unavailable')
  if(!this.options.authorize)throw new Error('word-upload-auth-required')
  if(actor.scope!=='write'||!validActorId(actor.userId)||!node(input.nodeId)||!['png','jpg','jpeg','gif','webp'].includes(input.extension)||!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>8*1024*1024||this.summary.active>=16)throw new Error('word-upload-input-invalid')
  input.signal?.throwIfAborted();this.trim();if(this.records.size>=128)throw new Error('word-upload-limit')
  const captured=this.options.capture(input.nodeId),bytes=Uint8Array.from(input.bytes),id=randomUUID()
  // Seen intents are kept in the runtime until the immutable baseline is
  // verified; no native POST starts before the complete capture is durable.
  const record:WordUploadRecord={id,nodeId:input.nodeId,regionId:captured.regionId,revision:captured.revision,clientId:captured.clientId,seen:structuredClone(captured.seen),actor:{userId:actor.userId,displayName:actorName(actor.displayName??actor.userId)},extension:input.extension,assetHash:hash(bytes),byteLength:bytes.length,phase:'reserved'}
  this.records.set(id,record);this.options.changed()
  const done=this.launch(actor,record,bytes,input.signal)
  return{id,done,cancel:()=>this.cancel(actor,id)}
 }
 /** The browser reserves metadata durably before sending a potentially slow
  * binary body. Its ID is stable across lost responses and window restarts. */
 reserve(actor:WordUploadActor,input:WordUploadSelection,cancelOnly=false){
  validateWordSelection(input)
  if(this.closed||!this.options.available())throw new Error('word-upload-unavailable')
  if(!this.options.authorize)throw new Error('word-upload-auth-required')
  if(actor.scope!=='write'||!validActorId(actor.userId)||!uuid(input.id)||!node(input.nodeId)||!['png','jpg','jpeg','gif','webp'].includes(input.extension)||!integer(input.revision)||!integer(input.clientId)||input.clientId>0xffffffff||!Number.isSafeInteger(input.byteLength)||input.byteLength<1||input.byteLength>8*1024*1024||!['assetHash','visualHash'].every(key=>typeof input[key as 'assetHash']==='string'&&/^[a-f0-9]{64}$/.test(input[key as 'assetHash'])))throw new Error('word-upload-input-invalid')
  const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item),requestHash=hash(new TextEncoder().encode(stable(input)))
  const existing=this.records.get(input.id)
  if(existing){
   if(existing.actor.userId!==actor.userId)throw new Error('word-upload-owner-required')
   if(existing.nodeId!==input.nodeId||existing.assetHash!==input.assetHash||existing.byteLength!==input.byteLength||existing.extension!==input.extension||existing.revision!==input.revision||existing.clientId!==input.clientId||existing.expectedVisualHash!==input.visualHash||existing.requestHash!==requestHash)throw new Error('word-upload-request-changed')
   if(cancelOnly)return this.cancel(actor,input.id).then(()=>structuredClone(existing))
   const running=this.preparing.get(input.id);if(running)return running
   return this.options.persist().then(()=>structuredClone(existing))
  }
  if(!cancelOnly&&this.summary.active>=16)throw new Error('word-upload-limit');this.trim();if(this.records.size>=128)throw new Error('word-upload-limit')
  const captured=this.options.capture(input.nodeId)
  if(!cancelOnly&&captured.revision!==input.revision)throw new Error('word-upload-base-changed')
  // Only intents the selecting window actually saw may be superseded. Later
  // peer replacements remain independent choices, even if upload finishes last.
  if(!Array.isArray(input.seen)||input.seen.length>4000)throw new Error('word-upload-input-invalid')
  const record:WordUploadRecord={id:input.id,nodeId:input.nodeId,regionId:captured.regionId,revision:input.revision,clientId:input.clientId,seen:input.seen.filter(entry=>captured.seen.some(current=>current.intentId===entry?.intentId&&stable(current)===stable(entry))),actor:{userId:actor.userId,displayName:actorName(actor.displayName??actor.userId)},extension:input.extension,assetHash:input.assetHash,byteLength:input.byteLength,expectedVisualHash:input.visualHash,requestHash,phase:cancelOnly?'cancelled':'reserved'}
  validateWordUploads([record]);this.records.set(record.id,record);this.options.changed()
  const task=cancelOnly?(async()=>{if(!await this.options.authorize!(actor))throw new Error('word-upload-authority-changed');if(this.closed||!this.options.available())throw new Error('word-upload-unavailable');await this.options.persist();return structuredClone(record)})():this.launch(actor,record,undefined,undefined,true);this.preparing.set(record.id,task);void task.finally(()=>this.preparing.delete(record.id)).catch(()=>{});return task
 }
 cancelSelection(actor:WordUploadActor,input:WordUploadSelection){return this.reserve(actor,input,true)}
 resume(actor:WordUploadActor,id:string,bytes?:Uint8Array,signal?:AbortSignal){
  const record=this.owned(actor,id)
  signal?.throwIfAborted()
  if(bytes&&(bytes.length!==record.byteLength||hash(bytes)!==record.assetHash))throw new Error('word-upload-file-differs')
  if(record.phase==='cancelled')return Promise.reject(new Error('word-upload-cancelled'))
  return this.launch(actor,record,bytes?Uint8Array.from(bytes):undefined,signal)
 }
 async cancel(actor:WordUploadActor,id:string){
  const record=this.owned(actor,id);if(record.phase==='applied')throw new Error('word-upload-already-applied')
  record.phase='cancelled';delete record.problem;this.running.get(id)?.abort(new Error('word-upload-cancelled'));this.options.changed()
  await this.options.persist();this.options.changed()
 }
 private launch(actor:WordUploadActor,record:WordUploadRecord,bytes?:Uint8Array,signal?:AbortSignal,prepareOnly=false){
  if(this.running.has(record.id))return Promise.reject(new Error('word-upload-busy'))
  if(!this.options.authorize)return Promise.reject(new Error('word-upload-auth-required'))
  const controller=new AbortController();this.running.set(record.id,controller)
  const cancel=()=>{void this.cancel(actor,record.id).catch(()=>{})};signal?.addEventListener('abort',cancel,{once:true})
  const timer=setTimeout(()=>controller.abort(new Error('word-upload-timeout')),this.options.timeoutMs??45_000)
  const live=()=>{if(this.closed||!this.options.available())throw new Error('word-upload-unavailable');controller.signal.throwIfAborted();if(record.phase==='cancelled')throw new Error('word-upload-cancelled')}
  const wait=<T>(promise:Promise<T>)=>interruptible(promise,controller.signal)
  const authorize=async()=>{live();if(!await wait(this.options.authorize!(actor)))throw new Error('word-upload-authority-changed');live()}
  const run=async()=>{
   try{
    await authorize()
    if(record.phase==='applied'){await this.options.persist();return structuredClone(record)}
    if(!record.base){const base=await wait(this.options.imageAt(record.nodeId,record.revision));live();record.base=structuredClone(base)}
    if(record.expectedVisualHash&&record.base.visualHash!==record.expectedVisualHash)throw new Error('word-upload-base-changed')
    validateWordUploads([record]);record.phase='reserved';delete record.problem;await this.options.persist();live()
    if(prepareOnly)return structuredClone(record)
    if(bytes){
     let response:Response
     for(let attempt=0;;attempt++){
      await authorize()
      response=await wait(this.options.request(actor,`/staged-assets?extension=${record.extension}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes as BodyInit,signal:controller.signal}));live()
      if(response.status!==409||attempt>=31)break
      let error:unknown
      try{error=await wait(response.clone().json())}catch{live();break}
      live();if(!error||typeof error!=='object'||(error as {error?:unknown}).error!=='HCD_RESOURCE_BUSY')break
      await retryDelay(controller.signal,Math.min(250,25*2**Math.min(attempt,4))+Math.floor(Math.random()*25));live()
     }
     if(!response.ok)throw new Error(`word-upload-stage:${response.status}`)
     const staged=await wait(response.json());live();if(staged.hash!==record.assetHash)throw new Error('word-upload-bytes-differ')
    }
    const response=await wait(this.options.request(actor,`/staged-assets/${record.assetHash}`,{signal:controller.signal}));live()
    if(!response.ok)throw new Error(response.status===404?'word-upload-file-required':`word-upload-read:${response.status}`)
    const verified=new Uint8Array(await wait(response.arrayBuffer()));live();if(verified.length!==record.byteLength||hash(verified)!==record.assetHash)throw new Error('word-upload-bytes-differ')
    record.phase='staged';await this.options.persist();await authorize();live()
    this.options.apply(record,{base:record.base,revision:record.revision,clientId:record.clientId,seen:record.seen});record.phase='applied';delete record.problem
    await this.options.persist();live();return structuredClone(record)
   }catch(error){
    if(!this.closed){if(record.phase!=='applied'&&record.phase!=='cancelled'){record.phase='interrupted';const message=error instanceof Error?error.message:'';record.problem=/^word-upload-[a-z:-]{1,80}(?:\d{3})?$/.test(message)?message:'word-upload-interrupted'}try{await this.options.persist()}catch{/* Storage failure remains visible on the save owner. */}}
    throw error
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.running.delete(record.id);if(!this.closed)this.options.changed()}
  }
  const task=run();this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));return task
 }
 async drain(){for(const controller of this.running.values())controller.abort(new Error('word-upload-interrupted'));await Promise.allSettled([...this.tasks])}
 dispose(){this.closed=true;for(const controller of this.running.values())controller.abort(new Error('word-upload-unavailable'))}
}
