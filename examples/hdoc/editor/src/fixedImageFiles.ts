/** Private, durable image choices for fixed-layout editors. A stored file is
 * never authority to upload, mutate a document, or acknowledge a save. */
import {validGeometry,type PositionedImage} from './imageDrafts.ts'
import {resourceRequest,resourceTransaction} from './nodeResourceStorage.ts'
import {imageFileHash} from './imageFileIntegrity.ts'

export type FixedImageChoice={version:1;id:string;name:string;extension:'png'|'jpg'|'jpeg'|'gif'|'webp';hash:string;bytes:Uint8Array;base:PositionedImage;revision:number;page?:number;phase:'chosen'|'staged'|'linked'|'cancelled'}
const hash=/^[a-f0-9]{64}$/,idPattern=/^[a-f0-9-]{36}$/
const pending=(choice:FixedImageChoice)=>choice.phase==='chosen'||choice.phase==='staged'
const safeInt=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0
export function validateFixedImageChoice(value:FixedImageChoice){
 if(!value||value.version!==1||typeof value.id!=='string'||!idPattern.test(value.id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>256||/[\x00-\x1f/\\]/.test(value.name)||!['png','jpg','jpeg','gif','webp'].includes(value.extension)||typeof value.hash!=='string'||!hash.test(value.hash)||!(value.bytes instanceof Uint8Array)||!['chosen','staged','linked','cancelled'].includes(value.phase)||!safeInt(value.revision)||value.page!==undefined&&!safeInt(value.page))throw new Error('fixed-image-choice-invalid')
 const base=value.base
 if(!base||typeof base.nodeId!=='string'||!base.nodeId||base.nodeId.length>160||/[\x00-\x1f]/.test(base.nodeId)||typeof base.visualHash!=='string'||!hash.test(base.visualHash)||base.assetHash!=null&&(typeof base.assetHash!=='string'||!hash.test(base.assetHash))||!base.geometry||!['pt','emu'].includes(base.geometry.unit)||!validGeometry(base.geometry)||base.label!==undefined&&(typeof base.label!=='string'||base.label.length>512))throw new Error('fixed-image-choice-invalid')
 if(pending(value)?!value.bytes.length||value.bytes.length>8*1024*1024:value.bytes.length!==0)throw new Error('fixed-image-choice-invalid')
}
const validate=validateFixedImageChoice
const identity=(value:FixedImageChoice)=>JSON.stringify({id:value.id,name:value.name,extension:value.extension,hash:value.hash,base:{nodeId:value.base.nodeId,visualHash:value.base.visualHash,assetHash:value.base.assetHash??null,label:value.base.label,geometry:{x:value.base.geometry.x,y:value.base.geometry.y,width:value.base.geometry.width,height:value.base.geometry.height,unit:value.base.geometry.unit}},revision:value.revision,page:value.page})
function clean(choice:FixedImageChoice):FixedImageChoice{
 const base=choice.base
 return {version:1,id:choice.id,name:choice.name,extension:choice.extension,hash:choice.hash,bytes:Uint8Array.from(choice.bytes),base:{nodeId:base.nodeId,visualHash:base.visualHash,...(base.assetHash!=null?{assetHash:base.assetHash}:{}),...(base.label!==undefined?{label:base.label}:{}),geometry:{x:base.geometry.x,y:base.geometry.y,width:base.geometry.width,height:base.geometry.height,unit:base.geometry.unit}},revision:choice.revision,...(choice.page!==undefined?{page:choice.page}:{}),phase:'chosen'}
}
export const fixedImageHash=imageFileHash

export class FixedImageFileJournal{
 private constructor(private db:IDBDatabase){}
 static async open(name:string,factory:IDBFactory=indexedDB){
  if(!/^hcd-fixed-draft-v1-[a-f0-9]{64}-[a-f0-9]{64}-imagefiles1$/.test(name))throw new Error('fixed-image-choice-scope')
  const request=factory.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('meta')
  const db=await resourceRequest(request);db.onversionchange=()=>db.close();return new FixedImageFileJournal(db)
 }
 async list(){return resourceTransaction(this.db,'readonly',async store=>{
  const entries=await resourceRequest(store.getAll()) as FixedImageChoice[],keys=await resourceRequest(store.getAllKeys());if(entries.length>144)throw new Error('fixed-image-choice-limit')
  for(let index=0;index<entries.length;index++){validate(entries[index]);if(keys[index]!==entries[index].id)throw new Error('fixed-image-choice-invalid')}
  const values=entries.filter(pending);if(values.length>16||values.reduce((n,v)=>n+v.bytes.length,0)>64*1024*1024)throw new Error('fixed-image-choice-limit')
  return values
 })}
 async put(choice:FixedImageChoice){
  validate(choice);const copy=clean(choice)
  if(copy.phase!=='chosen'||await fixedImageHash(copy.bytes)!==copy.hash)throw new Error('fixed-image-choice-integrity')
  await resourceTransaction(this.db,'readwrite',async store=>{
   const existing=await resourceRequest(store.get(copy.id));if(existing)throw new Error('fixed-image-choice-exists')
   const entries=await resourceRequest(store.getAll()) as FixedImageChoice[],keys=await resourceRequest(store.getAllKeys());entries.forEach((entry,index)=>{validate(entry);if(keys[index]!==entry.id)throw new Error('fixed-image-choice-invalid')})
   const active=entries.filter(pending);if(active.length>=16||active.reduce((n,v)=>n+v.bytes.length,0)+copy.bytes.length>64*1024*1024||entries.length>=144)throw new Error('fixed-image-choice-limit')
   store.add(copy,copy.id)
  })
 }
 /** All imported choices are committed together. Existing completed choices
  * are never revived, and repeat imports cannot overwrite a different task. */
 async importChoices(choices:readonly FixedImageChoice[]){
  if(!Array.isArray(choices)||choices.length>16)throw new Error('fixed-image-choice-limit')
  const copies=choices.map(choice=>{validate(choice);if(choice.phase!=='chosen')throw new Error('fixed-image-choice-invalid');return clean(choice)})
  if(new Set(copies.map(choice=>choice.id)).size!==copies.length)throw new Error('fixed-image-choice-invalid')
  for(const choice of copies)if(await fixedImageHash(choice.bytes)!==choice.hash)throw new Error('fixed-image-choice-integrity')
  return resourceTransaction(this.db,'readwrite',async store=>{
   const entries=await resourceRequest(store.getAll()) as FixedImageChoice[],keys=await resourceRequest(store.getAllKeys());entries.forEach((entry,index)=>{validate(entry);if(keys[index]!==entry.id)throw new Error('fixed-image-choice-invalid')})
   const existing=new Map(entries.map(entry=>[entry.id,entry])),added:FixedImageChoice[]=[]
   for(const copy of copies){const current=existing.get(copy.id);if(current){if(identity(current)!==identity(copy)||(pending(current)&&(current.bytes.length!==copy.bytes.length||current.bytes.some((byte,i)=>byte!==copy.bytes[i]))))throw new Error('fixed-image-choice-changed')}else added.push(copy)}
   const active=entries.filter(pending);if(active.length+added.length>16||active.reduce((sum,value)=>sum+value.bytes.length,0)+added.reduce((sum,value)=>sum+value.bytes.length,0)>64*1024*1024||entries.length+added.length>144)throw new Error('fixed-image-choice-limit')
   for(const choice of added)store.add(choice,choice.id)
   return added.length
  })
 }
 async stage(expected:FixedImageChoice){
  validate(expected);const copy=clean(expected)
  if(!pending(copy)||await fixedImageHash(copy.bytes)!==copy.hash)throw new Error('fixed-image-choice-integrity')
  return resourceTransaction(this.db,'readwrite',async store=>{
   const existing=await resourceRequest(store.get(copy.id)) as FixedImageChoice|undefined;if(!existing)throw new Error('fixed-image-choice-missing');validate(existing)
   if(identity(existing)!==identity(copy))throw new Error('fixed-image-choice-changed')
   if(pending(existing)){if(existing.bytes.length!==copy.bytes.length||existing.bytes.some((byte,index)=>byte!==copy.bytes[index]))throw new Error('fixed-image-choice-integrity');const next={...existing,phase:'staged' as const};store.put(next,next.id);return next}
   return existing
  })
 }
 async finish(id:string,phase:'linked'|'cancelled'){
  if(!idPattern.test(id)||!['linked','cancelled'].includes(phase))throw new Error('fixed-image-choice-invalid')
  return resourceTransaction(this.db,'readwrite',async store=>{const value=await resourceRequest(store.get(id)) as FixedImageChoice|undefined;if(!value)throw new Error('fixed-image-choice-missing');validate(value);const result=pending(value)?phase:value.phase;if(pending(value))store.put({...value,phase,bytes:new Uint8Array()},id);const entries=await resourceRequest(store.getAll()) as FixedImageChoice[];entries.forEach(validate);const terminal=entries.filter(entry=>!pending(entry));for(const entry of terminal.slice(0,Math.max(0,terminal.length-128)))store.delete(entry.id);return result})
 }
 close(){this.db.close()}
}
