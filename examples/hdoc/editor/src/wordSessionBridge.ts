/** Preserve a window's local Yjs history while its transport joins a new room
 * with a FRESH document. Old state is compared locally, never sent as a seed.
 * Only later local deltas cross from the retained view into that transport. */
import * as Y from 'yjs'
import {WordRegionStore,wordRegionStoreField,sameWordSessionTopology} from './wordRegionStore.ts'
import {wordDeviceRestoreOrigin} from './wordDeviceDraft.ts'
import {imageReceiptMap} from './collaborativeImages.ts'
import {verifyWordLinkSessionProof,type WordLinkSessionProof} from './wordLinkSessionProof.ts'
import {verifyWordStorySessionProof,type WordStorySessionProof} from './wordStorySessionProof.ts'

type Options={view:WordRegionStore;wire:WordRegionStore;storyProof?:WordStorySessionProof;linkProof?:WordLinkSessionProof;assertFresh:()=>void;detachPreviousTransport:()=>void;beforeApply?:()=>void;assertWritable?:()=>void;onBroken?:(error:Error)=>void}
const remote=Object.freeze({kind:'hcd-word-session-remote/1'}),local=Object.freeze({kind:'hcd-word-session-local/1'})
const stable=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
function synchronous(check:()=>void){const proof=check() as unknown;if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw Error('word-session-proof-must-be-synchronous')}}
function contains(view:Uint8Array,wire:Uint8Array){
 const document=new Y.Doc({gc:false})
 try{Y.applyUpdate(document,wire);const before=Y.snapshot(document);Y.applyUpdate(document,view);return Y.equalSnapshots(before,Y.snapshot(document))}finally{document.destroy()}
}
export function bridgeWordSession(options:Options){
 const view=options.view.document,wire=options.wire.document
 if(view===wire||view.isDestroyed||wire.isDestroyed||options.view.documentId!==options.wire.documentId)throw Error('word-session-topology-changed')
 if(options.storyProof&&options.linkProof)throw Error('word-session-topology-changed')
 if(options.linkProof)verifyWordLinkSessionProof(options.view,options.wire,options.linkProof)
 else if(options.storyProof)verifyWordStorySessionProof(options.view,options.wire,options.storyProof)
 else if(!sameWordSessionTopology(options.view.layoutState().layout,options.wire.layoutState().layout))throw Error('word-session-topology-changed')
 options.view.capture();options.wire.capture();synchronous(options.assertFresh)
 const complete=()=>{if(view.isDestroyed||wire.isDestroyed||view.store.pendingStructs||view.store.pendingDs||wire.store.pendingStructs||wire.store.pendingDs)throw Error('word-session-incomplete')}
 const proof=()=>{complete();const previous=Y.encodeStateAsUpdate(view),current=Y.encodeStateAsUpdate(wire);if(previous.byteLength>8*1024*1024||current.byteLength>8*1024*1024)throw Error('word-session-size-limit');if(!contains(previous,current))throw Error('word-session-review-required');return current}
 proof();synchronous(options.detachPreviousTransport);if(options.beforeApply)synchronous(options.beforeApply);synchronous(options.assertFresh)
 // PM views bound to the old layout must have been detached before this
 // merge. Their structural undo manager can remain on this exact Y.Doc.
 Y.applyUpdate(view,proof(),remote);complete()
 const layout=options.wire.layoutState(),model=new WordRegionStore(view,options.view.schema,options.view.documentId,layout.layout,layout.layoutHash,options.view.origin);model.capture()
 let closed=false,error:Error|undefined
 const dispose=()=>{if(closed)return;closed=true;view.off('update',toWire);wire.off('update',toView);view.off('destroy',dispose);wire.off('destroy',dispose)}
 const fail=(cause:unknown)=>{error=cause instanceof Error?cause:Error('word-session-unavailable');dispose();try{options.onBroken?.(error)}catch{/* The bridge stays closed even if the host's error UI fails. */}}
 const toView=(update:Uint8Array,origin:unknown)=>{if(closed||origin===local)return;try{complete();Y.applyUpdate(view,update,remote)}catch(cause){fail(cause)}}
 const toWire=(update:Uint8Array,origin:unknown,_document:Y.Doc,transaction:Y.Transaction)=>{
  if(closed||origin===remote)return
  try{
   complete();if(!transaction.local&&origin!==wordDeviceRestoreOrigin)throw Error('word-session-unexpected-remote')
   if(options.assertWritable)synchronous(options.assertWritable)
   for(const key of [wordRegionStoreField,'hcdSchema',imageReceiptMap])if(stable(view.getMap(key).toJSON())!==stable(wire.getMap(key).toJSON()))throw Error('word-session-protected-metadata')
   Y.applyUpdate(wire,update,local)
  }catch(cause){fail(cause)}
 }
 view.on('update',toWire);wire.on('update',toView);view.on('destroy',dispose);wire.on('destroy',dispose)
 return{model,dispose,get closed(){return closed},get error(){return error}}
}
