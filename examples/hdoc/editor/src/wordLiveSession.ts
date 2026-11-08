/** Normal regional editor connection lifetime. Topology replacements retain the
 * local view/history; each replacement transport starts with an empty Doc. */
import * as Y from 'yjs'
import type {HocuspocusProvider} from '@hocuspocus/provider'
import type {Session} from './api.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {WordBrowserState,type WordBrowserDisconnect} from './wordBrowserState.ts'
import type {WordDeviceDraft} from './wordDeviceDraft.ts'
import type {WordRegionStore,WordRegionProjection} from './wordRegionStore.ts'
import {readWordBrowserProjection,readWordStorySessionProjection,readWordLinkSessionProof} from './wordBrowserProjection.ts'
import {readWordActiveTopologyStatus} from './wordActiveLayoutClient.ts'
import type {WordLinkSessionProof} from './wordLinkSessionProof.ts'
import type {WordStorySessionProof} from './wordStorySessionProof.ts'
import {sendWordLargeRecovery} from './wordLargeRecoveryClient.ts'
import {bridgeWordSession} from './wordSessionBridge.ts'
import {protocolDelay} from './protocolClient.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import {requireWordBrowserProtocol} from './wordBrowserProtocol.ts'

export type WordLiveBinding={document:Y.Doc;provider:HocuspocusProvider;controller:WordBrowserState;cache:WordDeviceDraft}
type Options={session:Session;document:Y.Doc;cache:WordDeviceDraft;provider:(document:Y.Doc)=>HocuspocusProvider;beforeApply:()=>void;projection?:typeof readWordBrowserProjection;storyProjection?:typeof readWordStorySessionProjection;linkProof?:typeof readWordLinkSessionProof;status?:typeof readWordActiveTopologyStatus;timeoutMs?:number}
export class WordLiveSession{
 private lifetime=new AbortController()
 private listeners=new Set<()=>void>()
 private version=0
 private running:Promise<void>|undefined
 private wire:Y.Doc|undefined
 private bridge:ReturnType<typeof bridgeWordSession>|undefined
 private beforeViews:(()=>void|(()=>void))|undefined
 private viewModel:WordRegionStore|undefined
 private round:string|undefined
 private connectionRetry=false
 private disposed=false
 private closing:Promise<void>|undefined
 connection:WordLiveBinding|undefined
 phase:'opening'|'ready'|'reconnecting'|'failed'|'recovery-required'='opening'
 problem:string|undefined
 constructor(private readonly options:Options){}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private emit(){if(!this.disposed){this.version++;this.listeners.forEach(listener=>listener())}}
 setBeforeRebind(handler:()=>void|(()=>void)){this.beforeViews=handler;return()=>{if(this.beforeViews===handler)this.beforeViews=undefined}}
 get requestId(){return this.round}
 get canRetry(){return !this.disposed&&!!this.connection&&(!!this.round||this.connectionRetry)}
 private projectionReader(){
  const verified=new Map<number,WordRegionProjection>()
  return async(revision:number,signal:AbortSignal)=>{signal.throwIfAborted();const saved=verified.get(revision);if(saved)return saved;const result=await(this.options.projection??readWordBrowserProjection)(this.options.session,revision,signal);signal.throwIfAborted();verified.set(revision,result);for(const key of [...verified.keys()].sort((a,b)=>b-a).slice(2))verified.delete(key);return result}
 }
 private controller(document:Y.Doc,provider:HocuspocusProvider,projection:ReturnType<WordLiveSession['projectionReader']>,cache?:WordDeviceDraft){
  let controller!:WordBrowserState
  controller=new WordBrowserState({document,provider,scope:this.options.session.scope,protocol:requireWordBrowserProtocol(this.options.session.collaborationProtocol),cache,projection,largeRecovery:(update,baseline,signal)=>sendWordLargeRecovery(this.options.session,update,baseline,signal),onDisconnect:event=>{provider.disconnect();if(this.connection?.controller===controller)this.disconnected(event)}})
  return controller
 }
 private wait(controller:WordBrowserState,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
   let off=()=>{};const finish=(error?:unknown)=>{off();signal.removeEventListener('abort',abort);error?reject(error):resolve()},abort=()=>finish(signal.reason??Error('word-session-closed'))
   const check=()=>{if(signal.aborted){abort();return}if(controller.problem){finish(Error(controller.problem));return}if(controller.state().ready&&controller.model&&controller.projection)finish()}
   off=controller.subscribe(check);signal.addEventListener('abort',abort,{once:true});check()
  })
 }
 async start(){
  if(this.connection||this.disposed)throw Error('word-session-already-started')
  const provider=this.options.provider(this.options.document),controller=this.controller(this.options.document,provider,this.projectionReader(),this.options.cache)
  this.wire=this.options.document;this.connection={document:this.options.document,provider,controller,cache:this.options.cache}
  try{await this.wait(controller,AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(this.options.timeoutMs??60000)]));this.viewModel=controller.model!;this.phase='ready';this.emit()}
  catch(error){if(!this.disposed){provider.disconnect();this.phase='failed';this.problem=error instanceof Error?error.message:'word-session-unavailable';this.emit()}throw error}
 }
 private disconnected(event:Readonly<WordBrowserDisconnect>){
  if(this.disposed||this.running)return
  if(event.reason==='word-browser-reconnect-required'&&this.options.session.collaborationProtocol===wordLayoutProtocol&&event.topologyRequestId){this.round=event.topologyRequestId;void this.retry().catch(()=>{});return}
  this.round=undefined;this.connectionRetry=event.reason==='word-browser-reconnect-required'&&this.options.session.collaborationProtocol===wordLayoutProtocol
  this.problem=event.reason;this.phase='failed';this.emit()
 }
 retry(){
  if(this.running)return this.running
  if(!this.canRetry) return Promise.reject(Error('word-session-recovery-required'))
  const task=this.rebind(this.round).finally(()=>{if(this.running===task)this.running=undefined});this.running=task;return task
 }
 private async rebind(requestId?:string){
  const old=this.connection!,previousWire=this.wire!,session=this.options.session,signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(this.options.timeoutMs??60000)])
  this.phase='reconnecting';this.problem=undefined;this.emit()
  let provider:HocuspocusProvider|undefined,wire:Y.Doc|undefined,wireController:WordBrowserState|undefined,viewController:WordBrowserState|undefined,nextBridge:ReturnType<typeof bridgeWordSession>|undefined,adopted=false
  try{
   let revision=old.controller.projection?.revision??-1,story=false,link=false
   if(revision<0)throw Error('word-session-recovery-required')
   // A normal disconnect has no outstanding topology operation. Verify the
   // new empty transport against native state and the retained view instead
   // of querying an already completed round from a previous server lifetime.
   if(requestId)for(;;){signal.throwIfAborted();const result=await(this.options.status??readWordActiveTopologyStatus)(session,requestId,signal);if(result.status==='recovery-required'||result.status==='cancelled')throw Error('word-session-recovery-required');if(result.status==='installed'){revision=result.revision;story=result.schemaVersion==='hcd-word-active-story-status/1';link=result.schemaVersion==='hcd-word-active-link-status/1';break}await protocolDelay(250,signal)}
   signal.throwIfAborted();if(revision<(old.controller.projection?.revision??0))throw Error('word-session-recovery-required')
   wire=new Y.Doc();provider=this.options.provider(wire);const projection=this.projectionReader();wireController=this.controller(wire,provider,projection)
   await this.wait(wireController,signal)
   const fresh=()=>{signal.throwIfAborted();const state=wireController!.state();if(this.disposed||this.connection!==old||!state.ready||state.problem||wireController!.recovery||!provider!.isSynced||provider!.hasUnsyncedChanges||(wireController!.projection?.revision??-1)<revision)throw Error('word-session-baseline-changed')}
   fresh();await awaitRecoveryPreparation(()=>old.controller.flush(),signal);fresh()
   const previous=this.viewModel??old.controller.model;if(!previous)throw Error('word-session-recovery-required')
   let storyProof:WordStorySessionProof|undefined,linkProof:WordLinkSessionProof|undefined
   if(story&&requestId){if(revision<1)throw Error('word-session-recovery-required');const read=this.options.storyProjection??readWordStorySessionProjection,base=await read(session,revision-1,signal),receipt=await read(session,revision,signal);fresh();storyProof={transactionId:requestId,base,receipt}}
   if(link&&requestId){linkProof=await(this.options.linkProof??readWordLinkSessionProof)(session,requestId,revision,signal);fresh();if(linkProof.transactionId!==requestId||linkProof.revision!==revision)throw Error('word-session-link-proof-invalid')}
   nextBridge=bridgeWordSession({view:previous,wire:wireController.model!,storyProof,linkProof,assertFresh:fresh,detachPreviousTransport:()=>{old.controller.dispose();old.provider.destroy();this.bridge?.dispose()},beforeApply:()=>{const finish=this.beforeViews?.();if(finish!==undefined&&typeof finish!=='function')throw Error('word-session-view-unavailable');this.options.beforeApply();finish?.()},assertWritable:()=>{if(this.phase!=='ready'||!viewController||this.connection?.controller!==viewController||viewController.state().readOnly)throw Error('word-session-not-writable')},onBroken:error=>{if(!this.disposed){provider?.disconnect();this.problem=error.message;this.phase='recovery-required';this.emit()}}})
   this.viewModel=nextBridge.model
   // Preserve the verified native delta even if subsequent device inspection
   // fails; draft download remains available on this same open database.
   await awaitRecoveryPreparation(()=>this.options.cache.unbind(this.options.document),signal)
   await awaitRecoveryPreparation(()=>this.options.cache.append(Y.encodeStateAsUpdate(this.options.document),false),signal)
   viewController=this.controller(this.options.document,provider,projection,this.options.cache)
   this.bridge=nextBridge;this.wire=wire;this.connection={document:this.options.document,provider,controller:viewController,cache:this.options.cache};adopted=true
   await this.wait(viewController,signal);signal.throwIfAborted()
   wireController.dispose();this.viewModel=viewController.model!;if(previousWire!==this.options.document)previousWire.destroy()
   this.round=undefined;this.connectionRetry=false;this.phase='ready';this.problem=undefined;this.emit()
  }catch(error){
   wireController?.dispose();viewController?.dispose();nextBridge?.dispose();provider?.destroy();wire?.destroy()
   if(previousWire!==this.options.document&&adopted)previousWire.destroy()
   if(!this.disposed){this.phase='recovery-required';this.problem=error instanceof Error?error.message:'word-session-unavailable';this.emit()}
   throw error
  }
 }
 dispose(){
  if(this.closing)return this.closing
  this.disposed=true;this.lifetime.abort();this.listeners.clear();this.connection?.provider.disconnect();this.connection?.controller.dispose();this.connection?.provider.destroy();this.bridge?.dispose();if(this.wire!==this.options.document)this.wire?.destroy()
  this.closing=this.options.cache.close();return this.closing
 }
}
