import * as Y from 'yjs'
import {applyImageReplacement,imageIntents,validateImageReplacementCapture,type ImageReplacementCapture} from './collaborativeImages.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {SemanticImageFiles,type SemanticImageChoice} from './semanticImageFiles.ts'
import {withDeviceFileLock} from './regionalFileBoundary.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** Explicit operations only. An applying record without its exact shared
 * intent is uncertain: a save may already have consumed it. Preserve bytes. */
export class SemanticImageFileClient{
 private closed=false
 private readonly lifetime=new AbortController()
 private running=false
 constructor(private files:SemanticImageFiles,private document:Y.Doc,private options:{ready:()=>boolean;readyAfterApply?:()=>boolean;verify:(choice:SemanticImageChoice,signal:AbortSignal)=>Promise<void>;stage:(choice:SemanticImageChoice,signal:AbortSignal)=>Promise<{hash:string}>;flush:()=>Promise<void>;apply?:(capture:ImageReplacementCapture,hash:string,id:string)=>void;synchronize:(signal:AbortSignal)=>Promise<boolean>}){}
 private live(signal?:AbortSignal,applied=false){signal?.throwIfAborted();if(this.closed||!(applied?(this.options.readyAfterApply??this.options.ready)():this.options.ready()))throw new Error('semantic-image-choice-unavailable')}
 private exact(choice:SemanticImageChoice){
  const found=imageIntents(this.document).find(value=>value.intentId===choice.id);if(!found)return false
  const capture=choice.capture,base=found.base,expected=capture.base,ancestors=[...new Set(capture.seen.flatMap(entry=>[entry.intentId,...entry.ancestors]))].slice(0,64)
  if(found.clientId!==capture.clientId||found.revision!==capture.revision||found.page!==capture.page||found.touched.length!==1||found.touched[0]!=='assetHash'||found.assetHash!==choice.hash||JSON.stringify(found.ancestors)!==JSON.stringify(ancestors)||JSON.stringify(found.geometry)!==JSON.stringify(expected.geometry)||base.nodeId!==expected.nodeId||base.visualHash!==expected.visualHash||(base.assetHash??null)!==(expected.assetHash??null)||JSON.stringify(base.geometry)!==JSON.stringify(expected.geometry))throw new Error('semantic-image-choice-changed')
  return true
 }
 async choose(file:File,capture:ImageReplacementCapture){
  this.live();validateImageReplacementCapture(capture);const captured=structuredClone(capture)
  const extension=file.name.split('.').pop()?.toLowerCase();if(!extension||!['png','jpg','jpeg','gif','webp'].includes(extension)||!file.size||file.size>8*1024*1024)throw new Error('semantic-image-choice-invalid')
  const bytes=new Uint8Array(await awaitRecoveryPreparation(()=>file.arrayBuffer(),this.lifetime.signal)),hash=await awaitRecoveryPreparation(()=>imageFileHash(bytes),this.lifetime.signal);this.live()
  const choice:SemanticImageChoice={version:1,id:crypto.randomUUID(),name:file.name,extension:extension as SemanticImageChoice['extension'],hash,bytes,base:captured.base,revision:captured.revision,...(captured.page!==undefined?{page:captured.page}:{}),phase:'chosen',capture:captured}
  await this.files.put(choice);return choice
 }
 private async exclusive<T>(work:(signal:AbortSignal)=>Promise<T>){
  if(this.running)throw new Error('semantic-image-choice-busy')
  if(typeof navigator==='undefined'||!navigator.locks)throw new Error('semantic-image-choice-lock-unavailable')
  this.running=true
  try{return await withDeviceFileLock(this.files.scope,()=>work(this.lifetime.signal),this.lifetime.signal)}finally{this.running=false}
 }
 async resume(id:string){return this.exclusive(async signal=>{
  this.live(signal);let choice=(await this.files.list()).find(value=>value.id===id);if(!choice)throw new Error('semantic-image-choice-missing')
  if(await imageFileHash(choice.bytes)!==choice.hash)throw new Error('semantic-image-choice-integrity');this.live(signal)
  if(choice.phase==='applying'&&!this.exact(choice))throw new Error('semantic-image-choice-uncertain')
  // Verification is read-only. Do not keep the device lock if a transport
  // ignores cancellation; a late verification result cannot authorize staging.
  const verifiedChoice=choice
  await awaitRecoveryPreparation(()=>this.options.verify(verifiedChoice,signal),signal);this.live(signal)
  const result=await this.options.stage(choice,signal);this.live(signal);if(result.hash!==choice.hash)throw new Error('semantic-image-choice-integrity')
  if(choice.phase!=='applying'){
   choice=await this.files.stage(choice);this.live(signal);if(choice.phase!=='staged')throw new Error('semantic-image-choice-finished')
   choice=await this.files.beginApply(choice);this.live(signal)
   if(this.options.apply)this.options.apply(choice.capture,choice.hash,choice.id);else applyImageReplacement(this.document,choice.capture,choice.hash,'hcd-image-edit',choice.id)
  }
  await this.options.flush();this.live(signal,true)
  if(!await this.options.synchronize(signal)||!this.exact(choice))throw new Error('semantic-image-choice-uncertain')
  this.live(signal,true);if(await this.files.finish(id,'linked')!=='linked')throw new Error('semantic-image-choice-finished')
 })}
 async cancel(id:string){return this.exclusive(async signal=>{
  this.live(signal);const choice=(await this.files.list()).find(value=>value.id===id);if(!choice)throw new Error('semantic-image-choice-missing')
  if(choice.phase==='applying')throw new Error('semantic-image-choice-uncertain')
  if(await this.files.finish(id,'cancelled')!=='cancelled')throw new Error('semantic-image-choice-finished')
 })}
 /** The user has reviewed an uncertain outcome; this only discards the local
  * retry record and never changes shared document content. */
 async discardUncertain(id:string){return this.exclusive(async signal=>{
  this.live(signal);const choice=(await this.files.list()).find(value=>value.id===id);if(!choice||choice.phase!=='applying')throw new Error('semantic-image-choice-changed')
  if(await this.files.finish(id,'cancelled')!=='cancelled')throw new Error('semantic-image-choice-finished')
 })}
 dispose(){this.closed=true;this.lifetime.abort(new Error('semantic-image-choice-unavailable'))}
}
