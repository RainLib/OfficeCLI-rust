import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import {parseFixedDraftBackup,serializeFixedDraft} from './fixedDraftJournal.ts'
import {fixedImageHash,validateFixedImageChoice,type FixedImageChoice} from './fixedImageFiles.ts'

/** A portable recovery file is an untrusted copy, never authority to upload or
 * alter a document. File choices return to the explicit-review state. */
const MiB=1024*1024
export const fixedPortableLimits=Object.freeze({file:96*MiB,resource:8*MiB,total:64*MiB,resources:64,choices:16})
type Binary={hash:string;length:number;base64:string}
type Choice=Omit<FixedImageChoice,'bytes'|'phase'>
type Archive={schemaVersion:'hcd-fixed-portable/1';draft:string;choices:Choice[];resources:Binary[]}
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',')
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
function fail(code='fixed-portable-invalid'):never{throw new Error(code)}
function encode(bytes:Uint8Array){const parts:string[]=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));return btoa(parts.join(''))}
async function decode(value:unknown){
 const binary=value as Binary
 if(!exact(binary,['hash','length','base64'])||!hex(binary.hash)||!Number.isSafeInteger(binary.length)||binary.length<1||binary.length>fixedPortableLimits.resource||typeof binary.base64!=='string'||binary.base64.length!==4*Math.ceil(binary.length/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(binary.base64))return fail()
 let decoded:string;try{decoded=atob(binary.base64)}catch{return fail()}
 const bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));if(bytes.length!==binary.length||encode(bytes)!==binary.base64||await fixedImageHash(bytes)!==binary.hash)return fail('fixed-portable-integrity')
 return bytes
}
function metadata(choice:FixedImageChoice):Choice{
 validateFixedImageChoice(choice);if(choice.phase!=='chosen'&&choice.phase!=='staged')return fail()
 const base=choice.base
 return {version:1,id:choice.id,name:choice.name,extension:choice.extension,hash:choice.hash,base:{nodeId:base.nodeId,visualHash:base.visualHash,...(base.assetHash!=null?{assetHash:base.assetHash}:{}),...(base.label!==undefined?{label:base.label}:{}),geometry:{x:base.geometry.x,y:base.geometry.y,width:base.geometry.width,height:base.geometry.height,unit:base.geometry.unit}},revision:choice.revision,...(choice.page!==undefined?{page:choice.page}:{})}
}
function inventory(state:FixedDraftState,choices:Choice[]){
 const hashes=new Set<string>()
 for(const [,draft] of [...state.images,...(state.attempt?.images??[])])if(draft.assetHash)hashes.add(draft.assetHash)
 for(const choice of choices)hashes.add(choice.hash)
 if(hashes.size>fixedPortableLimits.resources)fail('fixed-portable-limit')
 return hashes
}
function checkPortableState(value:unknown){
 if(!value||typeof value!=='object')return fail()
 const state=value as FixedDraftState
 if(state.uploadInterrupted===true)fail('fixed-portable-interrupted')
 for(const entries of [state.images,state.attempt?.images??[]]){
  if(!Array.isArray(entries))return fail()
  for(const entry of entries){const draft=entry?.[1];if(draft&&typeof draft==='object'&&(draft.collaborationConflict!==undefined||draft.alternatives!==undefined))fail('fixed-portable-conflict')}
 }
}
export async function createFixedPortableArchive(input:{session:Session;sourceHash:string;base:string;state:FixedDraftState;choices:readonly FixedImageChoice[];readAsset:(hash:string)=>Promise<Uint8Array>}):Promise<Uint8Array>{
 if(!input.session.userId||!hex(input.sourceHash))fail('fixed-portable-scope')
 if(!Array.isArray(input.choices)||input.choices.length>fixedPortableLimits.choices)fail('fixed-portable-limit')
 // Capture all local intent before awaiting any resource, so subsequent edits
 // cannot silently alter this file's meaning.
 const state=structuredClone(input.state),files=input.choices.map(value=>structuredClone(value));checkPortableState(state)
 const initial=serializeFixedDraft(input.session,state,input.sourceHash,input.base)
 const normalized=parseFixedDraftBackup(initial,input.session,input.sourceHash,input.base),draft=serializeFixedDraft(input.session,normalized,input.sourceHash,input.base),choices=files.map(metadata)
 if(input.session.format==='xlsx'&&(choices.length||normalized.images.length||normalized.attempt?.images.length))fail('fixed-portable-unsupported-images')
 if(new Set(choices.map(choice=>choice.id)).size!==choices.length)fail()
 for(const file of files)if(await fixedImageHash(file.bytes)!==file.hash)fail('fixed-portable-integrity')
 const needed=inventory(normalized,choices),resources:Binary[]=[],local=new Map(files.map(file=>[file.hash,file.bytes]));let total=0
 for(const hash of [...needed].sort()){
  const supplied=local.get(hash)??await input.readAsset(hash);if(!(supplied instanceof Uint8Array))fail()
  const bytes=Uint8Array.from(supplied);if(!bytes.length||bytes.length>fixedPortableLimits.resource||(total+=bytes.length)>fixedPortableLimits.total)fail('fixed-portable-limit')
  if(await fixedImageHash(bytes)!==hash)fail('fixed-portable-integrity')
  resources.push({hash,length:bytes.length,base64:encode(bytes)})
 }
 const archive:Archive={schemaVersion:'hcd-fixed-portable/1',draft,choices,resources},result=new TextEncoder().encode(JSON.stringify(archive));if(result.length>fixedPortableLimits.file)fail('fixed-portable-limit');return result
}
export async function openFixedPortableArchive(bytes:Uint8Array,options:{session:Session;sourceHash:string;base:string}){
 if(!options.session.userId||!hex(options.sourceHash))fail('fixed-portable-scope')
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>fixedPortableLimits.file)fail('fixed-portable-limit')
 let value:Archive;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return fail()}
 if(!exact(value,['schemaVersion','draft','choices','resources'])||value.schemaVersion!=='hcd-fixed-portable/1'||typeof value.draft!=='string'||!Array.isArray(value.choices)||value.choices.length>fixedPortableLimits.choices||!Array.isArray(value.resources)||value.resources.length>fixedPortableLimits.resources)fail()
 let rawDraft:unknown;try{rawDraft=JSON.parse(value.draft)}catch{return fail()}
 if(!rawDraft||typeof rawDraft!=='object'||!('state' in rawDraft))return fail();checkPortableState(rawDraft.state)
 const state=parseFixedDraftBackup(value.draft,options.session,options.sourceHash,options.base),resources=new Map<string,Uint8Array>();let total=0
 if(options.session.format==='xlsx'&&(value.choices.length||state.images.length||state.attempt?.images.length))fail('fixed-portable-unsupported-images')
 for(const item of value.resources){const data=await decode(item);if(resources.has(item.hash)||(total+=data.length)>fixedPortableLimits.total)fail('fixed-portable-integrity');resources.set(item.hash,data)}
 const ids=new Set<string>(),choices:FixedImageChoice[]=value.choices.map(item=>{
  if(!exact(item,['version','id','name','extension','hash','base','revision',...(Object.prototype.hasOwnProperty.call(item,'page')?['page']:[])]))return fail()
  const data=resources.get(item.hash);if(!data||ids.has(item.id))return fail('fixed-portable-integrity');ids.add(item.id)
  const choice={...item,bytes:Uint8Array.from(data),phase:'chosen' as const};return {...metadata(choice),bytes:choice.bytes,phase:'chosen' as const}
 })
 const needed=inventory(state,choices.map(metadata));if(needed.size!==resources.size||[...needed].some(hash=>!resources.has(hash)))fail('fixed-portable-integrity')
 return {state,choices,resources}
}
