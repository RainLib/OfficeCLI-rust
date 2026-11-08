import type {Descriptor,Manifest,PageGroup} from './fixedPages.ts'
import {groupPages} from './fixedPages.ts'
const pageSize=128
/** Prefix metadata only. Canvas bodies/assets remain in the bounded page loader.
 * A page ending at the index boundary is incomplete until its next descriptor
 * or EOF is known. Shared requests survive a caller cancel; no further index
 * pages are requested for that canceled location operation. */
export class FixedIndex {
 private descriptors:Descriptor[]=[]
 private grouped:PageGroup[]|null=null
 private bySequence=new Map<number,PageGroup>()
 private next=0
 private generation=0
 private listeners=new Set<()=>void>()
 private pending:Promise<void>|null=null
 private closed=false
 private controller=new AbortController()
 private bodyVerification:boolean|null=null
 constructor(readonly manifest:Manifest,private read:(page:number,signal:AbortSignal)=>Promise<unknown>){
  if(!Number.isSafeInteger(manifest.chunkCount)||manifest.chunkCount<0||!Number.isSafeInteger(manifest.indexPageCount)||manifest.indexPageCount!==Math.ceil(manifest.chunkCount/pageSize))throw new Error('fixedIndexInvalid')
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.generation
 entries=()=>this.descriptors
 complete=()=>this.next===this.manifest.indexPageCount
 validSequence=(sequence:number)=>Number.isSafeInteger(sequence)&&sequence>=0&&sequence<this.manifest.chunkCount
 groups=()=>{if(!this.grouped){
  if(['pptx','pdf'].includes(this.manifest.source.format))this.grouped=groupPages(this.descriptors)
  else {this.grouped=[];for(const chunk of this.descriptors){const previous=this.grouped.at(-1);if(chunk.wordRegionId&&chunk.wordRegionsVerified&&previous?.wordRegionsVerified&&previous.wordRegionId===chunk.wordRegionId&&previous.region===chunk.region&&previous.sequences.at(-1)===chunk.sequence-1)previous.sequences.push(chunk.sequence);else this.grouped.push({firstSequence:chunk.sequence,region:chunk.region,sequences:[chunk.sequence],...(chunk.wordRegionsVerified?{wordRegionsVerified:true,wordRegionId:chunk.wordRegionId}: {})})}}
  this.bySequence=new Map();for(const group of this.grouped)for(const sequence of (this.manifest.source.format==='docx'&&group.wordRegionId?group.sequences:[group.firstSequence]))this.bySequence.set(sequence,group)
 }return this.grouped}
 page(sequence:number):PageGroup|null{
  this.groups();const group=this.bySequence.get(sequence)
  if(!group)return null
  return this.complete()||(group.sequences.at(-1)??-1)<this.descriptors.length-1||!['pptx','pdf'].includes(this.manifest.source.format)&&!group.wordRegionId?group:null
 }
 loadNext():Promise<void>{
  if(this.closed)return Promise.reject(new Error('fixedIndexClosed'))
  if(this.pending)return this.pending
  if(this.complete())return Promise.resolve()
  const page=this.next
  const operation=(async()=>{
   const result=await this.read(page,this.controller.signal) as {page?:unknown;chunks?:unknown;wordRegionsVerified?:unknown;wordBodiesVerified?:unknown}
   if(this.closed)throw new Error('fixedIndexClosed')
   if(result?.page!==page||!Array.isArray(result.chunks)||result.chunks.length!==Math.min(pageSize,this.manifest.chunkCount-page*pageSize))throw new Error('fixedIndexInvalid')
   if(result.wordRegionsVerified!==undefined&&result.wordRegionsVerified!==true)throw new Error('fixedIndexInvalid')
   if(result.wordBodiesVerified!==undefined&&(result.wordBodiesVerified!==true||result.wordRegionsVerified!==true))throw new Error('fixedIndexInvalid')
   const verified=result.wordRegionsVerified===true
   const bodyVerified=result.wordBodiesVerified===true
   if(this.bodyVerification!==null&&this.bodyVerification!==bodyVerified)throw new Error('fixedIndexInvalid')
   const entries=result.chunks.map((item,index)=>{
    const value=item as Descriptor
    if(!value||value.sequence!==page*pageSize+index||typeof value.region!=='string'||!value.region||value.region.length>64||typeof value.continuation!=='boolean')throw new Error('fixedIndexInvalid')
    if(verified&&(['header','footer'].includes(value.region)||bodyVerified&&value.region==='body')&&(typeof value.wordRegionId!=='string'||!/^n_[0-9a-f]{32}$/.test(value.wordRegionId)))throw new Error('fixedIndexInvalid')
    if(verified&&!['header','footer'].includes(value.region)&&!(bodyVerified&&value.region==='body')&&value.wordRegionId!==undefined)throw new Error('fixedIndexInvalid')
    return Object.freeze({sequence:value.sequence,region:value.region,continuation:value.continuation,...(verified?{wordRegionsVerified:true,wordRegionId:value.wordRegionId}: {})})
   })
   this.bodyVerification=bodyVerified;this.descriptors=[...this.descriptors,...entries];this.grouped=null;this.next++;this.generation++;this.listeners.forEach(listener=>listener())
  })().finally(()=>{if(this.pending===operation)this.pending=null})
  this.pending=operation;return operation
 }
 async loadNextFor(signal?:AbortSignal):Promise<void>{await waitIndex(this.loadNext(),signal)}
 /** Word paper preview needs all story locations before declaring a variant
  * absent. Read only index pages, and stop requesting later pages on cancel. */
 async ensureComplete(signal?:AbortSignal):Promise<void>{
  while(!this.complete()){signal?.throwIfAborted();if(this.closed)throw new Error('fixedIndexClosed');await waitIndex(this.loadNext(),signal)}
  signal?.throwIfAborted();if(this.closed)throw new Error('fixedIndexClosed')
 }
 async ensurePage(sequence:number,signal?:AbortSignal):Promise<PageGroup>{
  if(!this.validSequence(sequence))throw new Error('fixedLocationUnavailable')
  while(true){
   signal?.throwIfAborted();if(this.closed)throw new Error('fixedIndexClosed')
   const page=this.page(sequence);if(page)return page
   // An existing continuation is not a new page address from a peer.
   if(this.descriptors[sequence]?.continuation&&!this.bySequence.has(sequence)||this.complete())throw new Error('fixedLocationUnavailable')
   await waitIndex(this.loadNext(),signal)
  }
 }
 /** Find the next visible group, fetching only as much prefix as necessary. */
 async ensureNext(sequence:number,region:string|undefined,signal?:AbortSignal):Promise<PageGroup|null>{
  if(!this.validSequence(sequence))throw new Error('fixedLocationUnavailable')
  while(true){
   signal?.throwIfAborted();if(this.closed)throw new Error('fixedIndexClosed')
   const next=this.groups().find(group=>group.firstSequence>sequence&&group.region!=='note'&&(!region||group.region===region))
   if(next)return next
   if(this.complete())return null
   await waitIndex(this.loadNext(),signal)
  }
 }
 close(){this.closed=true;this.controller.abort();this.listeners.clear()}
}
function waitIndex(operation:Promise<void>,signal?:AbortSignal):Promise<void>{
 if(!signal)return operation
 return new Promise((resolve,reject)=>{
  const cancel=()=>{signal.removeEventListener('abort',cancel);reject(signal.reason??new DOMException('Canceled','AbortError'))}
  if(signal.aborted){cancel();return}
  signal.addEventListener('abort',cancel,{once:true})
  operation.then(()=>{signal.removeEventListener('abort',cancel);signal.aborted?cancel():resolve()},error=>{signal.removeEventListener('abort',cancel);reject(error)})
 })
}
