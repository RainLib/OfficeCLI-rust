/** Browser state/receipt boundary. The provider always joins with a fresh Y.Doc;
 * a cached peer snapshot is never sent as this member's authored recovery. */
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,type WordRegionProjection} from './wordRegionStore.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordRecoveryUpdateLimit} from './wordTransportLimits.ts'
import {wordRecoveryMaxBytes} from './wordRecoveryChunks.ts'
import {wordImageRegions} from './wordImages.ts'
import {imageDraftDigest} from './collaborativeImages.ts'
import {cacheAddsChanges} from './localDrafts.ts'
import {WordDeviceDraft,wordDeviceRestoreOrigin} from './wordDeviceDraft.ts'
import {requestCoordinatedSave} from './semanticSaveClient.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import {WordTopologyPause} from './wordTopologyPause.ts'
import {requireWordBrowserProtocol,wordBrowserModelMatches,type WordBrowserProtocol} from './wordBrowserProtocol.ts'
export type WordClientReceipt={type:'hcd-save-status';wordRegionVersion:1|2;wordLayoutVersion?:1;nodeEditVersion:7;stateId:string;stateSequence:number;revision:number;digest:string;imageDigest:string;pending:boolean;status:'editing'|'saving'|'saved'|'failed'|'conflict';uploads?:{active:number;interrupted:number;running:number};problem?:string}
type Provider={isSynced:boolean;hasUnsyncedChanges:boolean;on:(event:string,handler:(value:any)=>void)=>unknown;off:(event:string,handler:(value:any)=>void)=>unknown;sendStateless:(value:string)=>void}
export type WordBrowserDisconnect={reason:string;topologyRequestId?:string}
type Options={protocol?:WordBrowserProtocol;document:Y.Doc;provider:Provider;scope:'read'|'write';projection:(revision:number,signal:AbortSignal)=>Promise<WordRegionProjection>;cache?:WordDeviceDraft;onDisconnect?:(event:Readonly<WordBrowserDisconnect>)=>void;largeRecovery?:(update:Uint8Array,baseline:Uint8Array,signal:AbortSignal)=>Promise<void>}
const hex=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
export async function wordBrowserDigest(model:WordRegionStore){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(model.contents())))].map(n=>n.toString(16).padStart(2,'0')).join('')}
export class WordBrowserState{
 readonly protocol:WordBrowserProtocol
 model:WordRegionStore|null=null
 projection:WordRegionProjection|null=null
 receipt:WordClientReceipt|null=null
 recovery:{local:string;server:string;own:string;canRestore:boolean;problem?:string}|null=null
 problem:string|undefined
 private listeners=new Set<()=>void>()
 private version=0
 private controller=new AbortController()
 private generation=0
 private readonly topology:WordTopologyPause
 private pauseInput:(()=>()=>void)|undefined
 setTopologyInputPause(handler:()=>()=>void){this.pauseInput=handler;return()=>{if(this.pauseInput===handler){this.pauseInput=undefined;this.topology.invalidate()}}}
 private localUploads=false
 private localResources=false
 setLocalUploadPending(value:boolean){if(this.localUploads!==value){this.localUploads=value;if(value)this.topology.invalidate();this.emit()}}
 setResourcePending(value:boolean){if(this.localResources!==value){this.localResources=value;if(value)this.topology.invalidate();this.emit()}}
 private digest:string|undefined
 private images:string|undefined
 private ready=false
 private reviewed=false
 private processing=false
 private rerun=false
 private verifying=new Map<number,Promise<WordRegionProjection>>()
 private cacheWork:Promise<unknown>=Promise.resolve()
 private recoveryGeneration=0
 private recoveryCount=0
 private saving:Promise<number>|undefined
 private connected=false
 private everSynced=false
 private fenced=false
 private authorityLost=false
 private detachCache:(()=>void)|undefined
 constructor(readonly options:Options){this.protocol=requireWordBrowserProtocol(options.protocol??wordRegionalProtocol);if(options.cache&&options.cache.protocol!==this.protocol)throw new Error('word-device-protocol');this.topology=new WordTopologyPause({send:value=>options.provider.sendStateless(JSON.stringify(value)),ready:()=>{const state=this.state();return state.ready&&!state.problem&&!this.saving&&!this.localUploads&&!this.localResources&&!this.receipt?.uploads?.active&&options.cache?.snapshot()!=='failed'},pause:()=>{if(options.scope==='read')return()=>{};if(!this.pauseInput)throw Error('word-topology-input-unavailable');return this.pauseInput()},flush:()=>this.flush(),synced:()=>this.connected&&!this.fenced&&!this.authorityLost&&options.provider.isSynced&&!options.provider.hasUnsyncedChanges,generation:()=>this.generation,changed:()=>this.emit()});this.detachCache=options.cache?.subscribe(()=>this.emit());options.document.on('update',this.updated);options.provider.on('stateless',this.stateless);options.provider.on('synced',this.synced);options.provider.on('status',this.connection);options.provider.on('close',this.closed);options.provider.on('disconnect',this.closed);options.provider.on('authenticationFailed',this.authenticationFailed);if(options.provider.isSynced)this.synced({state:true})}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(this.controller.signal.aborted)return;this.version++;this.listeners.forEach(listener=>listener())}
 private closed=()=>this.connection({status:'disconnected'})
 private connection=({status}:{status:string})=>{this.connected=status==='connected';if(!this.connected){this.receipt=null;if(this.everSynced&&!this.controller.signal.aborted){this.fence('word-browser-reconnect-required');return}}this.emit();if(this.connected&&this.options.provider.isSynced)this.options.provider.sendStateless(JSON.stringify({type:'hcd-save-state'}))}
 unavailable(reason='word-browser-unavailable'){this.problem=reason;this.emit()}
 private fence(reason:string){if(this.fenced||this.controller.signal.aborted)return;this.fenced=true;this.problem=reason;const id=this.topology.requestId,event=Object.freeze({reason,...(id?{topologyRequestId:id}:{})});this.emit();this.options.onDisconnect?.(event)}
 private authenticationFailed=()=>{this.authorityLost=true;this.fence('word-browser-authority-unavailable')}
 private synced=({state}:{state:boolean})=>{if(!state&&this.everSynced){this.closed();return}if(state){this.everSynced=true;this.connected=true;this.options.provider.sendStateless(JSON.stringify({type:'hcd-save-state'}));this.emit()}}
 private stateless=({payload}:{payload:string})=>{let value:WordClientReceipt;try{value=JSON.parse(payload)}catch{return}if(this.connected&&!this.fenced&&this.protocol===wordLayoutProtocol&&this.topology.receive(value))return;if(!this.connected||this.fenced||!value||value.type!=='hcd-save-status'||!wordBrowserModelMatches(value,this.protocol)||typeof value.stateId!=='string'||!/^[a-f0-9]{32}$/.test(value.stateId)||!Number.isSafeInteger(value.stateSequence)||value.stateSequence<1||!Number.isSafeInteger(value.revision)||value.revision<0||!hex(value.digest)||!hex(value.imageDigest)||typeof value.pending!=='boolean'||!['editing','saving','saved','failed','conflict'].includes(value.status))return;if(this.receipt&&(value.revision<this.receipt.revision||value.stateId!==this.receipt.stateId||value.stateSequence<=this.receipt.stateSequence))return;this.receipt=value;if(this.projection?.revision!==value.revision){this.ready=false;this.digest=undefined;this.images=undefined}this.emit();void this.synchronize()}
 private updated=()=>{this.generation++;this.topology.invalidate();this.digest=undefined;this.images=undefined;if(this.model&&this.options.document.getMap(wordRegionStoreField).get('layoutHash')!==this.model.layoutState().layoutHash)this.ready=false;this.emit();void this.synchronize()}
 private async synchronize(){
  if(this.processing){this.rerun=true;return}if(this.controller.signal.aborted||this.authorityLost||this.fenced||!this.receipt||!this.options.provider.isSynced)return
  this.processing=true;const revision=this.receipt.revision
  try{
   let load=this.verifying.get(revision);if(!load){const pending=this.options.projection(revision,this.controller.signal);this.verifying.set(revision,pending);void pending.catch(()=>{if(this.verifying.get(revision)===pending)this.verifying.delete(revision)});load=pending}const projection=await load
   if(this.controller.signal.aborted||this.fenced||this.authorityLost||this.receipt?.revision!==revision)return
   if(projection.revision!==revision||this.options.document.getMap(wordRegionStoreField).get('layoutHash')!==projection.flowLayoutHash){this.ready=false;return}
   if(this.model)this.model.syncLayout(projection.flowLayout,projection.flowLayoutHash)
   else{this.model=new WordRegionStore(this.options.document,wordRegionSchema(),projection.documentId,projection.flowLayout,projection.flowLayoutHash);this.model.capture()}
   this.projection=projection;for(const previous of this.verifying.keys())if(previous<revision)this.verifying.delete(previous);this.ready=true;this.problem=undefined
   if(!this.reviewed){await this.inspectDevice();if(this.reviewed&&!this.recovery)await this.launchCache()}
   const generation=this.generation,[digest,images]=await Promise.all([wordBrowserDigest(this.model),imageDraftDigest(this.options.document)])
   if(!this.controller.signal.aborted&&!this.fenced&&!this.authorityLost&&generation===this.generation){this.digest=digest;this.images=images;this.emit()}
   // Notify scoped PM views after native layout verification, without writing
   // source metadata or placing an acknowledgement in personal history.
   if(!this.controller.signal.aborted&&!this.fenced&&!this.authorityLost)this.options.document.transact(()=>{},'hcd-word-verified-layout')
  }catch(error){if(!this.controller.signal.aborted&&!this.fenced&&!this.authorityLost){this.problem=error instanceof Error?error.message:'word-browser-unavailable';this.ready=false;this.emit()}}finally{this.processing=false;const again=this.rerun||this.receipt?.revision!==revision;this.rerun=false;if(!this.controller.signal.aborted&&again)void this.synchronize()}
 }
 private text(document:Y.Doc){try{const model=new WordRegionStore(document,wordRegionSchema(),this.projection!.documentId,this.projection!.flowLayout,this.projection!.flowLayoutHash);return model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n').slice(0,2000)}catch{return 'word-device-projection-unavailable'}}
 private async inspectDevice(){
  const cache=this.options.cache;if(!cache){this.reviewed=true;return}
  this.localUploads=(await cache.pendingUploads()).length>0;const pending=await cache.pendingRecords();if(this.controller.signal.aborted)return
  const cached=new Y.Doc();try{if(pending.records.length)Y.applyUpdate(cached,Y.mergeUpdates(pending.records.map(record=>record.bytes)));if(!pending.records.length||!cacheAddsChanges(cached,this.options.document)){
   // Presence in the live room is not a durable save. Keep the journal
   // discoverable after a server crash until a matching saved receipt exists.
   const generation=this.generation,receipt=this.receipt
   const [digest,images]=await Promise.all([wordBrowserDigest(this.model!),imageDraftDigest(this.options.document)])
   const current=()=>!this.controller.signal.aborted&&!this.fenced&&!this.authorityLost&&this.connected&&this.options.provider.isSynced&&!this.options.provider.hasUnsyncedChanges&&this.generation===generation&&this.receipt===receipt
   if(!current()){this.rerun=true;return}
   if(receipt?.status==='saved'&&!receipt.pending&&receipt.digest===digest&&receipt.imageDigest===images){
    const changed=new AbortController(),off=this.subscribe(()=>{if(!current())changed.abort(new Error('word-device-review-changed'))})
    try{await cache.markReviewed(pending.count,AbortSignal.any([changed.signal,this.controller.signal]))}
    catch(error){if(!current()){this.rerun=true;return}throw error}
    finally{off()}
    if(!current()){this.rerun=true;return}
   }
   this.reviewed=true;return
  }
   let problem:string|undefined,own='';try{const update=this.planDevice(pending.records.filter(record=>record.local).map(record=>record.bytes)),preview=new Y.Doc();try{Y.applyUpdate(preview,Y.encodeStateAsUpdate(this.options.document));Y.applyUpdate(preview,update);own=this.text(preview)}finally{preview.destroy()}}catch(error){problem=error instanceof Error?error.message:'word-device-recovery-unavailable'}
   this.recovery={local:this.text(cached),server:this.text(this.options.document),own,canRestore:!problem&&this.options.scope==='write',...(problem?{problem}:{})};this.recoveryGeneration=this.generation;this.recoveryCount=pending.count;this.emit()
  }finally{cached.destroy()}
 }
 private planDevice(updates:Uint8Array[]){
  if(!this.model||!updates.length)throw new Error('word-device-peer-only')
  const update=Y.mergeUpdates(updates),guard=wordRoomGuard(this.model,id=>wordImageRegions(this.projection!).get(id),undefined,this.protocol);try{guard.accept(update)}finally{guard.destroy()}
  const candidate=new Y.Doc();try{Y.applyUpdate(candidate,Y.encodeStateAsUpdate(this.options.document));const before=Y.snapshot(candidate);let emitted:Uint8Array|undefined;candidate.on('update',value=>{emitted=value});Y.applyUpdate(candidate,update);if(Y.equalSnapshots(before,Y.snapshot(candidate)))throw new Error('word-device-no-own-changes');if(!emitted||emitted.byteLength>wordRecoveryMaxBytes||emitted.byteLength>wordRecoveryUpdateLimit&&!this.options.largeRecovery)throw new Error('word-device-recovery-too-large');return emitted}finally{candidate.destroy()}
 }
 private async launchCache(alreadyRecordedOrigin?:unknown){if(this.options.cache){await this.options.cache.bind(this.options.document,{alreadyRecordedOrigin});this.cacheWork=this.options.cache.flush()}this.reviewed=true;this.emit()}
 async chooseDevice(action:'restore'|'keep'){
  const cache=this.options.cache;if(!cache||!this.recovery||!this.ready)throw new Error('word-device-review-changed')
  const review=this.recovery,generation=this.recoveryGeneration,count=this.recoveryCount
  const current=()=>!this.controller.signal.aborted&&!this.fenced&&!this.authorityLost&&this.connected&&this.options.provider.isSynced&&this.ready&&this.recovery===review&&this.generation===generation
  const pending=await cache.pendingRecords();if(!current()||pending.count!==count)throw new Error('word-device-review-changed')
  const update=action==='restore'?this.planDevice(pending.records.filter(record=>record.local).map(record=>record.bytes)):null
  const baseline=update&&update.byteLength>wordRecoveryUpdateLimit?Y.encodeSnapshot(Y.snapshot(this.options.document)):undefined
  if(update&&this.options.scope!=='write')throw new Error('word-device-read-only')
  // Persist before applying. If the room changes while storage is pending,
  // retain the journal and reconnect to re-review against the newer room.
  if(update)await cache.append(update,true)
  if(!current()){this.fence('word-device-review-changed');throw new Error('word-device-review-changed')}
  if(update&&baseline){
   try{await this.options.largeRecovery!(update,baseline,this.controller.signal)}catch{this.fence('word-device-large-uncertain');throw new Error('word-device-large-uncertain')}
   this.fence('word-device-large-reconnect');throw new Error('word-device-large-reconnect')
  }
  await this.launchCache(update?wordDeviceRestoreOrigin:undefined)
  if(!current()){this.fence('word-device-review-changed');throw new Error('word-device-review-changed')}
  if(update){
   Y.applyUpdate(this.options.document,update,wordDeviceRestoreOrigin)
   await cache.flush();await cache.markReviewed(pending.count)
  }else{
   // A keep decision is valid only for the reviewed room. Abort an uncommitted
   // review marker if a peer or connection changes while storage is pending.
   const changed=new AbortController(),off=this.subscribe(()=>{if(!current())changed.abort(new Error('word-device-review-changed'))})
   try{await cache.flush();if(!current())throw new Error('word-device-review-changed');await cache.markReviewed(pending.count,AbortSignal.any([changed.signal,this.controller.signal]))}
   catch(error){if(!current()){this.fence('word-device-review-changed');throw new Error('word-device-review-changed')}throw error}
   finally{off()}
  }
  this.recovery=null;this.emit();void this.synchronize()
 }
 state(){let businessProblem:string|undefined;try{if(this.model)businessProblem=businessDraftProblem(this.options.document,this.model.structure.project())}catch{businessProblem='word-business-schema-invalid'}const metadataReady=!!this.model&&this.ready&&this.options.document.getMap(wordRegionStoreField).get('layoutHash')===this.model.layoutState().layoutHash,available=!this.fenced&&!this.authorityLost&&this.connected&&this.options.provider.isSynced&&metadataReady&&this.reviewed&&!this.recovery&&!this.problem&&this.receipt?.status!=='conflict',covered=!this.localUploads&&!this.localResources&&!businessProblem&&available&&!!this.receipt&&!this.receipt.pending&&this.receipt.status==='saved'&&this.receipt.digest===this.digest&&this.receipt.imageDigest===this.images&&!this.options.provider.hasUnsyncedChanges&&this.options.provider.isSynced&&this.connected;return{ready:available,topologyPending:this.topology.pending,readOnly:this.topology.pending||!available||this.options.scope!=='write'||this.options.cache?.snapshot()==='failed',saved:covered&&!this.topology.pending,revision:this.receipt?.revision??this.projection?.revision??null,connected:this.connected,problem:this.options.cache?.snapshot()==='failed'?'word-device-storage':this.problem??businessProblem??this.receipt?.problem,resourcePending:this.localResources,pending:!covered,uploadPending:this.localUploads||!!this.receipt?.uploads?.active,saving:!!this.saving}}
 async flush(){await this.cacheWork;await this.options.cache?.flush()}
 save(){if(this.saving)return this.saving;const work=this.performSave().finally(()=>{this.saving=undefined;this.emit()});this.saving=work;this.emit();return work}
 private waitForModel(revision:number){
  const ready=()=>this.state().ready&&!!this.projection&&this.projection.revision>=revision
  if(ready())return Promise.resolve()
  return new Promise<void>((resolve,reject)=>{const finish=(error?:Error)=>{clearTimeout(timer);unsubscribe();this.controller.signal.removeEventListener('abort',abort);error?reject(error):resolve()},check=()=>{if(ready())finish()},abort=()=>finish(new Error('word-browser-closed')),unsubscribe=this.subscribe(check),timer=setTimeout(()=>finish(new Error('word-browser-receipt-timeout')),45000);this.controller.signal.addEventListener('abort',abort,{once:true});if(this.controller.signal.aborted)abort();else check()})
 }
 private async performSave(){
  if(this.topology.pending)throw new Error('word-topology-paused')
  if(this.localUploads||this.receipt?.uploads?.active)throw new Error('word-upload-pending')
  if(this.localResources)throw new Error('node-resource-pending')
  if(this.options.scope==='read'){if(this.state().saved)return this.receipt!.revision;throw new Error('word-browser-read-only')}
  if(!this.state().ready||!this.model||!this.connected||!this.options.provider.isSynced||this.options.provider.hasUnsyncedChanges)throw new Error('word-browser-sync-required')
  const businessProblem=this.model&&businessDraftProblem(this.options.document,this.model.structure.project());if(businessProblem)throw new Error(businessProblem)
  await this.flush();const generation=this.generation,[digest,images]=await Promise.all([wordBrowserDigest(this.model),imageDraftDigest(this.options.document)])
  if(this.generation!==generation)throw new Error('word-browser-sync-required')
  const reply=await requestCoordinatedSave(this.options.provider,digest,this.controller.signal,45000,images) as unknown as WordClientReceipt
  if(!wordBrowserModelMatches(reply,this.protocol)||!Number.isSafeInteger(reply.revision)||reply.revision<0||reply.status!=='saved'||reply.pending||reply.digest!==digest||!hex(reply.imageDigest)||reply.stateId!==this.receipt?.stateId)throw new Error(reply.problem??'word-browser-newer-changes')
  await this.waitForModel(reply.revision)
  for(let attempt=0;attempt<4;attempt++){const finalGeneration=this.generation,[current,currentImages]=await Promise.all([wordBrowserDigest(this.model),imageDraftDigest(this.options.document)]);if(finalGeneration!==this.generation)continue;if(this.localUploads||this.localResources||businessDraftProblem(this.options.document,this.model.structure.project())||current!==digest||currentImages!==reply.imageDigest||this.options.provider.hasUnsyncedChanges||!this.connected||!this.options.provider.isSynced||this.receipt?.pending)throw new Error('word-browser-newer-changes');return reply.revision}
  throw new Error('word-browser-newer-changes')
 }
 dispose(){this.topology.dispose();this.controller.abort();this.detachCache?.();this.options.document.off('update',this.updated);this.options.provider.off('stateless',this.stateless);this.options.provider.off('synced',this.synced);this.options.provider.off('status',this.connection);this.options.provider.off('close',this.closed);this.options.provider.off('disconnect',this.closed);this.options.provider.off('authenticationFailed',this.authenticationFailed);this.listeners.clear()}
}
