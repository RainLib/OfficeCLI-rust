import {stageImageAsset,type Session} from './api.ts'
import {fixedDraftDatabase} from './fixedDraftJournal.ts'
import {FixedImageFileClient} from './fixedImageFileClient.ts'
import {FixedImageFileJournal,fixedImageHash,type FixedImageChoice} from './fixedImageFiles.ts'
import {applyFixedImageChoice} from './fixedImageChoiceApply.ts'
import type {FixedSaveController} from './fixedSaveController.ts'
import type {ImageDraftStore,PositionedImage} from './imageDrafts.ts'

/** Per-document device queue. Web Locks serialize the final association and
 * cancellation across tabs; absence of locks fails closed, leaving bytes intact. */
export class FixedImageTasks {
 private journal:FixedImageFileJournal|null=null
 private client:FixedImageFileClient|null=null
 private channel:BroadcastChannel|null=null
 private closed=false
 private running=0
 private generation=0
 private readGeneration=0
 private listeners=new Set<()=>void>()
 private name=''
 choices:FixedImageChoice[]=[]
 loading=true
 problem=false
 constructor(private session:Session,private sourceHash:string,private drafts:ImageDraftStore,private save:FixedSaveController,private ready:()=>boolean){}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
 snapshot=()=>this.generation
 private changed(){this.generation++;this.listeners.forEach(fn=>fn())}
 get pending(){return this.loading||this.problem||this.running>0||this.choices.length>0}
 get working(){return this.running>0}
 get canCoordinate(){return !!navigator.locks}
 private available(){return !this.closed&&this.ready()&&this.save.hasBackup&&!this.save.busy&&!this.save.pending&&!this.save.history.busy}
 async start(){
  try{
   if(!this.session.userId)throw new Error('fixed-image-choice-unavailable')
   this.name=(await fixedDraftDatabase(this.session,this.session.userId,this.sourceHash,window.location.href))+'-imagefiles1'
   const journal=await FixedImageFileJournal.open(this.name)
   if(this.closed){journal.close();return}
   this.journal=journal
   this.client=new FixedImageFileClient(journal,{ready:()=>this.available(),stage:async(choice,signal)=>{
    return stageImageAsset(this.session,choice.extension,new Blob([Uint8Array.from(choice.bytes)]),signal,choice.hash)
   },flush:async()=>{if(!this.save.hasBackup)throw new Error('fixed-image-choice-unavailable');await this.save.flush()}})
   if(typeof BroadcastChannel!=='undefined'){this.channel=new BroadcastChannel(this.name);this.channel.onmessage=()=>{void this.refresh()}}
   window.addEventListener('focus',this.onFocus)
   await this.refresh()
  }catch{if(!this.closed){this.loading=false;this.problem=true;this.changed()}}
 }
 private onFocus=()=>{void this.refresh()}
 async refresh(){
  if(!this.journal||this.closed)return true
  const generation=++this.readGeneration
  try{const choices=await this.journal.list();if(this.closed)return true;if(generation===this.readGeneration){this.choices=choices;this.problem=false;this.loading=false;this.changed()}return choices.length>0}
  catch{if(!this.closed&&generation===this.readGeneration){this.problem=true;this.loading=false;this.changed()}return true}
 }
 private announce(){if(!this.closed)this.channel?.postMessage('changed')}
 async checkPending(){
  if(this.loading||this.problem||this.running||!this.journal)return true
  if(!navigator.locks){const found=await this.refresh();return found||this.pending}
  try{return await this.locked(async()=>{const found=await this.refresh();return found||this.pending})}catch{return true}
 }
 async withClear<T>(action:()=>Promise<T>):Promise<T>{
  if(this.loading||this.problem||this.running||!this.journal)throw new Error('imageUploadPending')
  if(!navigator.locks){const found=await this.refresh();if(found||this.pending)throw new Error('imageUploadPending');return action()}
  try{return await this.locked(async()=>{const found=await this.refresh();if(found||this.pending)throw new Error('imageUploadPending');return action()})}
  catch(error){if(error instanceof Error&&error.message==='fixed-image-choice-busy')throw new Error('imageUploadPending');throw error}
 }
 private async locked<T>(action:()=>Promise<T>):Promise<T>{
  if(!navigator.locks||!this.name)throw new Error('fixed-image-choice-unavailable')
  return navigator.locks.request(this.name,{ifAvailable:true},async lock=>{if(!lock)throw new Error('fixed-image-choice-busy');return action()})
 }
 /** Portable recovery shares this lock with saves and image choices. */
 async exclusive<T>(action:()=>Promise<T>):Promise<T>{if(this.closed||!this.journal||this.loading||this.problem)throw new Error('fixed-image-choice-unavailable');return this.locked(action)}
 async captureChoices(){if(!this.journal||this.closed)throw new Error('fixed-image-choice-unavailable');return this.journal.list()}
 invalidate(){this.announce();void this.refresh()}
 async choose(file:File,base:PositionedImage,revision:number,page?:number){
  if(!this.client||!this.available())throw new Error('fixed-image-choice-not-recorded')
  this.running++;this.changed()
  let recorded=false
  try{await this.locked(async()=>{const choice=await this.client!.choose(file,base,revision,page);recorded=true;this.announce();await this.refresh();await this.client!.resume(choice.id,(value,signal)=>applyFixedImageChoice(this.session,this.sourceHash,this.drafts,value,signal));this.announce()})}
  catch(error){if(!recorded)throw new Error('fixed-image-choice-not-recorded',{cause:error});throw error}
  finally{this.running--;await this.refresh();this.announce();this.changed()}
 }
 async resume(id:string){
  if(!this.client||!this.available())throw new Error('fixed-image-choice-unavailable')
  this.running++;this.changed()
  try{await this.locked(()=>this.client!.resume(id,(value,signal)=>applyFixedImageChoice(this.session,this.sourceHash,this.drafts,value,signal)));this.announce()}
  finally{this.running--;await this.refresh();this.announce();this.changed()}
 }
 async cancel(id:string){
  if(!this.client)throw new Error('fixed-image-choice-unavailable')
  this.running++;this.changed()
  try{await this.locked(()=>this.client!.cancel(id));this.announce()}
  finally{this.running--;await this.refresh();this.announce();this.changed()}
 }
 async download(id:string){
  const choice=(await this.journal?.list())?.find(item=>item.id===id)
  if(!choice||await fixedImageHash(choice.bytes)!==choice.hash)throw new Error('fixed-image-choice-integrity')
  const url=URL.createObjectURL(new Blob([Uint8Array.from(choice.bytes)]));const link=document.createElement('a');link.href=url;link.download=choice.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000)
 }
 dispose(){this.closed=true;this.client?.dispose();this.journal?.close();this.channel?.close();this.channel=null;this.listeners.clear();window.removeEventListener('focus',this.onFocus)}
}
