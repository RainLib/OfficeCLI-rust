/** Device-only choices. Bytes and target envelopes are never collaboration
 * authority; attachment still requires a fresh ordinary editor command. */
import {validateNodeResources,type NodeResource} from './extensionPortable.ts'
import {stableExtension,type NodeExtensionRegistry} from './extensionRegistry.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {ordinaryNodeResourceModel,inlineNodeResourceModel,type ResourceNodePayload,type NodeResourceModel} from './nodeResourceModel.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import {recoveryDigest} from './recoveryDigest.ts'
export type WordNodeResourceDraft<P extends ResourceNodePayload=ExtensionNodePayload>={version:1;id:string;regionId:string;expected:P;resource:NodeResource;bytes:Uint8Array;phase:'chosen'|'archived'|'linked'|'cancelled'}
export type NodeResourceRepair<P extends ResourceNodePayload=ResourceNodePayload>={original:WordNodeResourceDraft<P>;replacement:WordNodeResourceDraft<P>}
export const pendingNodeResource=(value:WordNodeResourceDraft<ResourceNodePayload>)=>value.phase==='chosen'||value.phase==='archived'
export function validateNodeResourceDraft(input:unknown):asserts input is WordNodeResourceDraft{
 validateResourceDraft(input,ordinaryNodeResourceModel)
}
export function validateResourceDraft<P extends ResourceNodePayload>(input:unknown,model:NodeResourceModel<P>):asserts input is WordNodeResourceDraft<P>{
 const value=input as WordNodeResourceDraft<P>
 if(!value||Object.keys(value).sort().join(',')!=='bytes,expected,id,phase,regionId,resource,version'||value.version!==1||typeof value.id!=='string'||!/^[a-f0-9-]{36}$/.test(value.id)||typeof value.regionId!=='string'||!model.region(value.regionId)||!['chosen','archived','linked','cancelled'].includes(value.phase)||!(value.bytes instanceof Uint8Array))throw new Error('word-node-resource-invalid')
 model.read(value.expected);validateNodeResources([value.resource])
 if((value.expected.resources??[]).some(resource=>resource.key===value.resource.key)||(value.expected.resources?.length??0)>=16||value.bytes.byteLength!==(pendingNodeResource(value)?value.resource.byteLength:0))throw new Error('word-node-resource-invalid')
}
export const nodeResourceHash=recoveryDigest
export type WordNodeResourceJob<P extends ResourceNodePayload=ExtensionNodePayload>={id:string;name:string;phase:'preparing'|'uploading'|'linking'|'chosen'|'archived';draft?:WordNodeResourceDraft<P>;problem?:string}
export type NodeResourceCache<P extends ResourceNodePayload=ExtensionNodePayload>={pendingNodeResources:()=>Promise<WordNodeResourceDraft<P>[]>;putNodeResource:(value:WordNodeResourceDraft<P>)=>Promise<void>;stageNodeResource:(value:WordNodeResourceDraft<P>)=>Promise<WordNodeResourceDraft<P>>;finishNodeResource:(id:string,phase:'linked'|'cancelled')=>Promise<void>;flush:()=>Promise<void>;importNodeResources?:(input:readonly WordNodeResourceDraft<P>[])=>Promise<number>;repairNodeResources?:(input:readonly NodeResourceRepair<P>[],guard:()=>void)=>Promise<number>}
type Options<P extends ResourceNodePayload>={cache:NodeResourceCache<P>;registry:Pick<NodeExtensionRegistry,'archiveResource'>;ready:()=>boolean;available?:()=>boolean;notify?:()=>void}
export class NodeResourceClient<P extends ResourceNodePayload>{
 private jobs=new Map<string,WordNodeResourceJob<P>>()
 private runs=new Map<string,{abort:AbortController;done:Promise<unknown>}>()
 private listeners=new Set<()=>void>()
 private version=0
 private refreshVersion=0
 private imports=0
 private closed=false
 private loading=true
 private problem:string|undefined
 constructor(readonly options:Options<P>,private model:NodeResourceModel<P>){}
 private isAvailable(){return !this.closed&&this.options.available?.()!==false}
 private available(){if(!this.isAvailable())throw new Error('word-node-resource-unavailable')}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 state(){return{jobs:[...this.jobs.values()],loading:this.loading,problem:this.problem,busy:this.runs.size>0||this.imports>0,pending:this.loading||!!this.problem||this.jobs.size>0||this.runs.size>0||this.imports>0}}
 private emit(){if(!this.closed){this.version++;this.listeners.forEach(listener=>listener())}}
 private set(job:WordNodeResourceJob<P>){if(!this.closed){this.jobs.set(job.id,job);this.emit()}}
 private applyDrafts(drafts:WordNodeResourceDraft<P>[]){
  drafts.forEach(draft=>validateResourceDraft(draft,this.model))
  const next=new Map<string,WordNodeResourceJob<P>>(drafts.map(draft=>[draft.id,{id:draft.id,name:draft.resource.name,phase:draft.phase as 'chosen'|'archived',draft}]))
  for(const[id,job]of this.jobs)if(this.runs.has(id))next.set(id,job)
  this.jobs=next;this.problem=undefined
 }
 async refresh(){
  const version=++this.refreshVersion
  try{const drafts=await this.options.cache.pendingNodeResources();if(this.closed)return
   if(version!==this.refreshVersion)return
   this.applyDrafts(drafts)
  }catch{if(version===this.refreshVersion)this.problem='word-node-resource-storage'}finally{if(version===this.refreshVersion){this.loading=false;this.emit()}}
 }
 initialize(){return this.refresh()}
 /** Re-read shared device storage at an action boundary rather than relying
  * only on an asynchronous cross-window notification. Storage errors fail
  * closed through the existing pending/problem state. */
 async checkPending(){
  if(!this.isAvailable())return true
  try{
   await this.refresh();if(!this.isAvailable()||this.state().pending)return true
   const version=this.refreshVersion,drafts=await this.options.cache.pendingNodeResources();if(!this.isAvailable())return true
   drafts.forEach(draft=>validateResourceDraft(draft,this.model))
   if(drafts.length){if(version===this.refreshVersion){this.applyDrafts(drafts);this.emit()}return true}
   return version!==this.refreshVersion||!this.isAvailable()||this.state().pending
  }
  catch{this.problem='word-node-resource-storage';this.emit();return true}
 }
 /** Publish committed private-file imports to other windows before awaiting
  * slower flush/refresh work. No document or attachment is changed here. */
 async importFiles(files:readonly WordNodeResourceDraft<P>[]){
  this.available();if(!this.options.cache.importNodeResources)throw new Error('word-node-resource-unavailable')
  this.imports++;this.emit()
  try{const count=await this.options.cache.importNodeResources(files);try{this.options.notify?.();await this.options.cache.flush()}finally{await this.refresh()}this.available();return count}
  finally{this.imports--;this.emit()}
 }
 async repairFiles(files:readonly NodeResourceRepair<P>[],guard:()=>void){
  this.available();if(this.runs.size||this.imports||!this.options.cache.repairNodeResources)throw new Error('word-node-resource-busy')
  this.imports++;this.emit()
  try{const count=await this.options.cache.repairNodeResources(files,()=>{this.available();guard()});try{this.options.notify?.();await this.options.cache.flush()}finally{await this.refresh()}this.available();return count}
  finally{this.imports--;this.emit()}
 }
 private run<T>(id:string,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  try{this.available()}catch(error){return Promise.reject(error)}
  if(this.runs.has(id))return Promise.reject(new Error('word-node-resource-busy'))
  const abort=new AbortController(),done=Promise.resolve().then(()=>work(abort.signal)).finally(()=>{this.runs.delete(id);this.emit()});this.runs.set(id,{abort,done});this.emit();return done
 }
 async start(file:File,expected:P,regionId:string,commit?:(draft:WordNodeResourceDraft<P>)=>Promise<P>){
  this.available();if(this.loading||this.problem||!this.options.ready()||this.jobs.size>=16)throw new Error('word-node-resource-unavailable')
  if(!file.size||file.size>8*1024*1024)throw new Error('word-node-resource-invalid')
  expected=this.model.read(structuredClone(expected));if(!this.model.region(regionId))throw new Error('word-node-resource-invalid')
  const id=crypto.randomUUID(),key=`r_${id.replaceAll('-','').slice(0,16)}`,name=file.name,mediaType=file.type||'application/octet-stream'
  this.set({id,name,phase:'preparing'})
  return this.run(id,async signal=>{
   let stored=false,writeStarted=false
   try{
    const bytes=new Uint8Array(await awaitRecoveryPreparation(()=>file.arrayBuffer(),signal)),hash=await awaitRecoveryPreparation(()=>nodeResourceHash(bytes),signal),resource={key,name,mediaType,hash,byteLength:bytes.byteLength},draft:WordNodeResourceDraft<P>={version:1,id,regionId,expected,resource,bytes,phase:'chosen'};validateResourceDraft(draft,this.model);signal.throwIfAborted()
    writeStarted=true;await this.options.cache.putNodeResource(draft);stored=true;this.set({id,name,phase:'chosen',draft});this.options.notify?.();signal.throwIfAborted()
    const archived=await this.upload(draft,signal);if(commit)await this.commit(archived,signal,commit);return archived
   }catch(error){if(!stored){this.jobs.delete(id);this.emit();if(writeStarted&&!this.closed){try{this.options.notify?.()}catch{/* Other windows still recheck storage at their save boundary. */}await this.refresh()}}else if(!this.closed&&this.jobs.has(id)){const job=this.jobs.get(id)!;this.set({...job,phase:job.draft?.phase==='archived'?'archived':'chosen',problem:'word-node-resource-interrupted'})};throw error}
  })
 }
 private async upload(draft:WordNodeResourceDraft<P>,signal:AbortSignal){
  if(!this.options.ready())throw new Error('word-node-resource-authority')
  if(await awaitRecoveryPreparation(()=>nodeResourceHash(draft.bytes),signal)!==draft.resource.hash)throw new Error('word-node-resource-integrity')
  signal.throwIfAborted();this.set({id:draft.id,name:draft.resource.name,phase:'uploading',draft})
  const resource=await this.options.registry.archiveResource({file:new Blob([Uint8Array.from(draft.bytes)],{type:draft.resource.mediaType}),name:draft.resource.name,key:draft.resource.key,signal,reuseExisting:draft.phase==='archived'})
  signal.throwIfAborted();if(stableExtension(resource)!==stableExtension(draft.resource))throw new Error('word-node-resource-integrity')
  const next=await this.options.cache.stageNodeResource(draft);this.options.notify?.();signal.throwIfAborted()
  if(!pendingNodeResource(next))throw new Error('word-node-resource-finished')
  this.set({id:next.id,name:next.resource.name,phase:'archived',draft:next});return next
 }
 resume(id:string){return this.run(id,async signal=>{try{const draft=await this.current(id);return await this.upload(draft,signal)}catch(error){if(!this.closed){const previous=this.jobs.get(id);if(previous)this.set({...previous,phase:previous.draft?.phase==='archived'?'archived':'chosen',problem:'word-node-resource-interrupted'})}throw error}})}
 attach(id:string,commit:(draft:WordNodeResourceDraft<P>)=>Promise<P>){return this.run(id,async signal=>{
  try{const draft=await this.upload(await this.current(id),signal);await this.commit(draft,signal,commit)}catch(error){const job=this.jobs.get(id);if(job)this.set({...job,phase:job.draft?.phase==='archived'?'archived':'chosen',problem:'word-node-resource-interrupted'});throw error}
 })}
 private async commit(draft:WordNodeResourceDraft<P>,signal:AbortSignal,apply:(draft:WordNodeResourceDraft<P>)=>Promise<P>){
  signal.throwIfAborted();if(!this.options.ready())throw new Error('word-node-resource-authority')
  this.set({id:draft.id,name:draft.resource.name,phase:'linking',draft})
  const result=await apply(draft);await this.linked(draft.id,result)
 }
 async current(id:string){this.available();const value=(await this.options.cache.pendingNodeResources()).find(draft=>draft.id===id);this.available();if(!value)throw new Error('word-node-resource-finished');validateResourceDraft(value,this.model);return value}
 /** The pending bytes remain local and are not marked as linked by download. */
 async readPendingFile(id:string){const draft=await this.current(id);if(await nodeResourceHash(draft.bytes)!==draft.resource.hash)throw new Error('word-node-resource-integrity');const latest=await this.current(id);if(stableExtension(latest.resource)!==stableExtension(draft.resource)||await nodeResourceHash(latest.bytes)!==draft.resource.hash)throw new Error('word-node-resource-changed');this.available();return{name:draft.resource.name,blob:new Blob([Uint8Array.from(latest.bytes)],{type:draft.resource.mediaType})}}
 /** Called only after the normal node.resources command and locally journaled
  * model update. A resource upload response cannot acknowledge document save. */
 async linked(id:string,node:P){
  const draft=await this.current(id)
  this.model.read(node)
  if(draft.phase!=='archived'||(node.schemaVersion==='hcd.extension/3')!==(draft.expected.schemaVersion==='hcd.extension/3')||node.instanceId!==draft.expected.instanceId||node.type!==draft.expected.type||!node.resources?.some(resource=>stableExtension(resource)===stableExtension(draft.resource)))throw new Error('word-node-resource-target-changed')
  await this.options.cache.flush();this.available();await this.options.cache.finishNodeResource(id,'linked');this.options.notify?.();this.jobs.delete(id);this.emit()
 }
 async cancel(id:string){
  this.available()
  if(this.jobs.get(id)?.phase==='linking')throw new Error('word-node-resource-busy')
  const run=this.runs.get(id);run?.abort.abort(new Error('word-node-resource-cancelled'));await run?.done.catch(()=>{})
  this.available();const draft=(await this.options.cache.pendingNodeResources()).find(value=>value.id===id);this.available()
  if(draft)await this.options.cache.finishNodeResource(id,'cancelled')
  this.options.notify?.();this.jobs.delete(id);this.emit()
 }
 dispose(){this.closed=true;for(const run of this.runs.values())run.abort.abort(new Error('word-node-resource-interrupted'));this.listeners.clear()}
}
/** Existing callers retain their strict ordinary/regional model. */
export class WordNodeResourceClient extends NodeResourceClient<ExtensionNodePayload>{constructor(options:Options<ExtensionNodePayload>){super(options,ordinaryNodeResourceModel)}}
/** Only an explicitly negotiated inline1 host uses this mixed-node client. */
export class InlineNodeResourceClient extends NodeResourceClient<ResourceNodePayload>{constructor(options:Options<ResourceNodePayload>){super(options,inlineNodeResourceModel)}}
