import {FixedImageFileJournal,fixedImageHash,type FixedImageChoice} from './fixedImageFiles.ts'
import type {PositionedImage} from './imageDrafts.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** Explicit retries only. A successful stage is not a document change, and
 * completion is recorded only after the caller persists its draft update. */
export class FixedImageFileClient{
 private runs=new Map<string,{abort:AbortController;linking:boolean}>()
 private closed=false
 private readonly lifetime=new AbortController()
 constructor(private journal:FixedImageFileJournal,private options:{ready:()=>boolean;stage:(choice:FixedImageChoice,signal:AbortSignal)=>Promise<{hash:string}>;flush:()=>Promise<void>}){}
 async choose(file:File,base:PositionedImage,revision:number,page?:number){
  if(this.closed||!this.options.ready())throw new Error('fixed-image-choice-unavailable')
  const extension=file.name.split('.').pop()?.toLowerCase()
  if(!extension||!['png','jpg','jpeg','gif','webp'].includes(extension)||!file.size||file.size>8*1024*1024)throw new Error('fixed-image-choice-invalid')
  const captured=structuredClone(base),name=file.name
  const bytes=new Uint8Array(await awaitRecoveryPreparation(()=>file.arrayBuffer(),this.lifetime.signal)),hash=await awaitRecoveryPreparation(()=>fixedImageHash(bytes),this.lifetime.signal),choice:FixedImageChoice={version:1,id:crypto.randomUUID(),name,extension:extension as FixedImageChoice['extension'],hash,bytes,base:captured,revision,...(page===undefined?{}:{page}),phase:'chosen'}
  if(this.closed||!this.options.ready())throw new Error('fixed-image-choice-unavailable')
  await this.journal.put(choice);return choice
 }
 async resume(id:string,apply:(choice:FixedImageChoice,signal:AbortSignal)=>Promise<void>){
  if(this.closed||this.runs.has(id))throw new Error('fixed-image-choice-busy')
  const controller=new AbortController(),run={abort:controller,linking:false};this.runs.set(id,run)
  const live=()=>{controller.signal.throwIfAborted();if(this.closed||!this.options.ready())throw new Error('fixed-image-choice-unavailable')}
  try{
   live();const choice=(await this.journal.list()).find(value=>value.id===id);if(!choice)throw new Error('fixed-image-choice-missing')
   if(await fixedImageHash(choice.bytes)!==choice.hash)throw new Error('fixed-image-choice-integrity')
   live();const result=await this.options.stage(choice,controller.signal);live();if(result.hash!==choice.hash)throw new Error('fixed-image-choice-integrity')
   const staged=await this.journal.stage(choice);live();if(staged.phase!=='staged')throw new Error('fixed-image-choice-finished')
   // A second read sees cancellations which arrived after staging. The normal
   // document command must still check target, current permission and conflict.
   const latest=(await this.journal.list()).find(value=>value.id===id);live();if(!latest||latest.phase!=='staged'||await fixedImageHash(latest.bytes)!==choice.hash)throw new Error('fixed-image-choice-finished')
   live();run.linking=true;await apply(latest,controller.signal);live();await this.options.flush();live();if(await this.journal.finish(id,'linked')!=='linked')throw new Error('fixed-image-choice-finished')
  }finally{this.runs.delete(id)}
 }
 async cancel(id:string){const run=this.runs.get(id);if(run?.linking)throw new Error('fixed-image-choice-busy');run?.abort.abort(new Error('fixed-image-choice-cancelled'));if(await this.journal.finish(id,'cancelled')!=='cancelled')throw new Error('fixed-image-choice-finished')}
 dispose(){this.closed=true;this.lifetime.abort(new Error('fixed-image-choice-unavailable'));for(const run of this.runs.values())run.abort.abort(new Error('fixed-image-choice-unavailable'))}
}
