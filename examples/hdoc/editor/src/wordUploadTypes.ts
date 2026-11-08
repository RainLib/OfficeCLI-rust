import {actorName,validActorId} from './referenceAuthors.ts'
import {validateImageReplacementCapture,type SharedImageDraft} from './collaborativeImages.ts'
import type {PositionedImage} from './imageDrafts.ts'
export type WordUploadActor={userId:string;displayName?:string;scope:'write'}
export type WordUploadRecord={id:string;nodeId:string;regionId:string;revision:number;clientId:number;actor:{userId:string;displayName:string};extension:'png'|'jpg'|'jpeg'|'gif'|'webp';assetHash:string;byteLength:number;seen:SharedImageDraft[];base?:PositionedImage;expectedVisualHash?:string;requestHash?:string;phase:'reserved'|'staged'|'interrupted'|'applied'|'cancelled';problem?:string}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value)
const node=(value:unknown)=>typeof value==='string'&&/^n_[a-f0-9]{32}$/.test(value)
const integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0
function fail():never{throw new Error('word-upload-record-invalid')}
export function validateWordUploads(value:unknown):asserts value is WordUploadRecord[]{
 if(!Array.isArray(value)||value.length>128||new Set(value.map(entry=>entry?.id)).size!==value.length)fail()
 let active=0
 for(const entry of value){
  if(!entry||Object.keys(entry).some(key=>!['id','nodeId','regionId','revision','clientId','actor','extension','assetHash','byteLength','seen','base','expectedVisualHash','requestHash','phase','problem'].includes(key))||!uuid(entry.id)||!node(entry.nodeId)||!node(entry.regionId)||!integer(entry.revision)||!integer(entry.clientId)||entry.clientId>0xffffffff||!entry.actor||Object.keys(entry.actor).some(key=>!['userId','displayName'].includes(key))||!validActorId(entry.actor.userId)||typeof entry.actor.displayName!=='string'||actorName(entry.actor.displayName)!==entry.actor.displayName||!['png','jpg','jpeg','gif','webp'].includes(entry.extension)||typeof entry.assetHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.assetHash)||!integer(entry.byteLength)||entry.byteLength<1||entry.byteLength>8*1024*1024||!['reserved','staged','interrupted','applied','cancelled'].includes(entry.phase)||entry.requestHash!==undefined&&(typeof entry.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.requestHash))||entry.expectedVisualHash!==undefined&&(typeof entry.expectedVisualHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.expectedVisualHash))||entry.problem!==undefined&&(typeof entry.problem!=='string'||!/^word-upload-[a-z:-]{1,80}(?:\d{3})?$/.test(entry.problem)))fail()
  if(['reserved','staged','interrupted'].includes(entry.phase)&&++active>16)fail()
  if(entry.base){try{validateImageReplacementCapture({base:entry.base,revision:entry.revision,clientId:entry.clientId,seen:entry.seen})}catch{fail()}if(entry.base.nodeId!==entry.nodeId)fail()}
  else{
   if(!Array.isArray(entry.seen)||['staged','applied'].includes(entry.phase))fail()
   if(entry.seen.length){try{validateImageReplacementCapture({base:entry.seen[0]?.base,revision:entry.revision,clientId:entry.clientId,seen:entry.seen})}catch{fail()}if(entry.seen[0].base.nodeId!==entry.nodeId)fail()}
  }
 }
}

export type WordUploadSelection={id:string;nodeId:string;extension:WordUploadRecord['extension'];assetHash:string;byteLength:number;revision:number;clientId:number;visualHash:string;seen:SharedImageDraft[]}
export type WordLocalUpload={selection:WordUploadSelection;before:PositionedImage;name:string;bytes?:Uint8Array}
export function validateWordSelection(input:unknown):asserts input is WordUploadSelection{
 const value=input as WordUploadSelection
 if(!value||Object.keys(value).sort().join(',')!=='assetHash,byteLength,clientId,extension,id,nodeId,revision,seen,visualHash'||!uuid(value.id)||!node(value.nodeId)||!['png','jpg','jpeg','gif','webp'].includes(value.extension)||!integer(value.revision)||!integer(value.clientId)||value.clientId>0xffffffff||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>8*1024*1024||!['assetHash','visualHash'].every(key=>typeof value[key as 'assetHash']==='string'&&/^[a-f0-9]{64}$/.test(value[key as 'assetHash']))||!Array.isArray(value.seen)||value.seen.length>4000)throw new Error('word-upload-input-invalid')
 if(value.seen.length)validateImageReplacementCapture({base:value.seen[0].base,revision:value.revision,clientId:value.clientId,seen:value.seen})
 if(value.seen.some(entry=>entry.base.nodeId!==value.nodeId))throw new Error('word-upload-input-invalid')
}
export function validateLocalUpload(input:unknown):asserts input is WordLocalUpload{
 const value=input as WordLocalUpload;if(!value||Object.keys(value).some(key=>!['before','name','selection','bytes'].includes(key))||!Object.hasOwn(value,'before')||!Object.hasOwn(value,'selection')||typeof value.name!=='string'||value.name.length>256)throw new Error('word-upload-local-invalid')
 validateWordSelection(value.selection);validateImageReplacementCapture({base:value.before,revision:value.selection.revision,clientId:value.selection.clientId,seen:[]})
 if(value.bytes!==undefined&&(!(value.bytes instanceof Uint8Array)||value.bytes.length!==value.selection.byteLength))throw new Error('word-upload-local-invalid')
 if(value.before.nodeId!==value.selection.nodeId||value.before.visualHash!==value.selection.visualHash)throw new Error('word-upload-local-invalid')
}
