import * as Y from 'yjs'
import {wordDeviceBackupReadLimit,utf8Length} from './wordDeviceBackupFormat.ts'
export {wordDeviceBackupReadLimit} from './wordDeviceBackupFormat.ts'
import type {Session} from './api.ts'
import {wordDeviceIdentity} from './wordDeviceDraft.ts'
import {validateLocalUpload,type WordLocalUpload} from './wordUploadTypes.ts'
import {validateNodeResourceDraft,pendingNodeResource,nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'

const MiB=1024*1024
const bad=():never=>{throw Error('word-device-backup-invalid')}
function bytes(value:unknown,limit:number){if(!Array.isArray(value)||value.length>limit||value.some(item=>!Number.isInteger(item)||item<0||item>255))bad();return Uint8Array.from(value as number[])}
function base64(value:unknown,limit:number){
 if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||value.length%4!==0||/[^A-Za-z0-9+/=]/.test(value))bad()
 const text=value as string,padding=text.endsWith('==')?2:text.endsWith('=')?1:0,length=text.length/4*3-padding
 if(length>limit)bad()
 const output=new Uint8Array(length);let written=0
 for(let start=0;start<text.length;start+=32768){
  const part=text.slice(start,start+32768);let decoded:string
  try{decoded=atob(part)}catch{return bad()}
  if(btoa(decoded)!==part||(start+part.length<text.length&&part.includes('=')))bad()
  for(let i=0;i<decoded.length;i++)output[written++]=decoded.charCodeAt(i)
 }
 if(written!==length)bad()
 return output
}

/** Parse into isolated data only. Scope metadata and local flags are claims,
 * not proof of authorship or permission to submit updates. */
export async function readWordDeviceBackup(text:string,session:Session,base:string){
 if(typeof text!=='string'||text.length>wordDeviceBackupReadLimit||utf8Length(text)>wordDeviceBackupReadLimit)bad()
 let raw:any;try{raw=JSON.parse(text)}catch{return bad()}
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!['hcd-word-device/2','hcd-word-device/3','hcd-word-device/4','hcd-word-device/5','hcd-word-device/6'].includes(raw.schemaVersion))bad()
 const layout=raw.schemaVersion==='hcd-word-device/6',compact=layout||raw.schemaVersion==='hcd-word-device/5',modern=compact||raw.schemaVersion==='hcd-word-device/4',keys=modern?['schemaVersion','documentId','epoch','scopeHash',compact?'documentBase64':'document','localUpdates','uploads','nodeResources',...(layout?['collaborationProtocol']:[])]:['schemaVersion','documentId','epoch','document','uploads','nodeResources']
 if(Object.keys(raw).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(raw,key))||raw.documentId!==session.documentId||!Number.isSafeInteger(raw.epoch)||raw.epoch<0)bad()
 const userId=session.userId??[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.token)))].map(value=>value.toString(16).padStart(2,'0')).join(''),identity=await wordDeviceIdentity(session,userId,base),scopeHash=identity.prefix.slice('hcd-local-draft-v1-'.length,-1)
 if(modern&&(typeof raw.scopeHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.scopeHash)))bad()
 if(layout&&raw.collaborationProtocol!==wordLayoutProtocol)bad()
 const protocol=layout?wordLayoutProtocol:wordRegionalProtocol,sameScope=modern&&raw.scopeHash===scopeHash&&raw.epoch===identity.epoch&&protocol===session.collaborationProtocol
 const document=compact?base64(raw.documentBase64,64*MiB):bytes(raw.document,64*MiB),localUpdates:Uint8Array[]=[]
 if(modern){if(!Array.isArray(raw.localUpdates)||raw.localUpdates.length>100000)bad();let size=0;for(const entry of raw.localUpdates){const update=base64(entry,8*MiB);if(!update.length||(size+=update.length)>64*MiB)bad();try{Y.decodeUpdate(update)}catch{return bad()}localUpdates.push(update)}}
 const isolated=new Y.Doc();try{Y.applyUpdate(isolated,document);if(isolated.store.pendingDs||isolated.store.pendingStructs)bad()}catch{return bad()}finally{isolated.destroy()}
 if(!Array.isArray(raw.uploads)||raw.uploads.length>32||!Array.isArray(raw.nodeResources)||raw.nodeResources.length>16)bad()
 const uploads:WordLocalUpload[]=[],resources:WordNodeResourceDraft[]=[],ids=new Set<string>();let uploadBytes=0,resourceBytes=0
 for(const row of raw.uploads){if(!row||typeof row!=='object'||Array.isArray(row))bad();const {bytesBase64,...rest}=row;if(bytesBase64!==undefined&&raw.schemaVersion==='hcd-word-device/2')bad();const item={...rest,...(bytesBase64!==undefined?{bytes:base64(bytesBase64,8*MiB)}:{})};try{validateLocalUpload(item)}catch{return bad()}if(ids.has(item.selection.id))bad();ids.add(item.selection.id);if(item.bytes){uploadBytes+=item.bytes.length;if(uploadBytes>64*MiB||await imageFileHash(item.bytes)!==item.selection.assetHash)bad()}uploads.push(item)}
 ids.clear();for(const row of raw.nodeResources){if(!row||typeof row!=='object'||Array.isArray(row))bad();if(compact&&Object.hasOwn(row,'bytes'))bad();const {bytesBase64,...rest}=row;if(!compact&&bytesBase64!==undefined)bad();const item=compact?{...rest,bytes:base64(bytesBase64,8*MiB)}:{...row,bytes:bytes(row.bytes,8*MiB)};try{validateNodeResourceDraft(item)}catch{return bad()}if(!pendingNodeResource(item)||ids.has(item.id)||(resourceBytes+=item.bytes.length)>64*MiB||await nodeResourceHash(item.bytes)!==item.resource.hash)bad();ids.add(item.id);resources.push(item)}
 return{schemaVersion:raw.schemaVersion as 'hcd-word-device/2'|'hcd-word-device/3'|'hcd-word-device/4'|'hcd-word-device/5'|'hcd-word-device/6',epoch:raw.epoch as number,sameScope,document,localUpdates,uploads,nodeResources:resources}
}
