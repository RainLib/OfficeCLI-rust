import * as Y from 'yjs'
import type {Session} from './api.ts'
import {WordDeviceDraft,wordDeviceIdentity,wordDeviceName} from './wordDeviceDraft.ts'
import {wordDeviceBackupReadLimit,utf8Length} from './wordDeviceBackupFormat.ts'
import {nodeResourceHash} from './wordNodeResources.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
const identityFor=async(session:Session,base:string)=>{const userId=session.userId??[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.token)))].map(value=>value.toString(16).padStart(2,'0')).join('');return wordDeviceIdentity(session,userId,base)}
function base64(bytes:Uint8Array){const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=24576)chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset,offset+24576))));return chunks.join('')}

/** This file is a read-only escape hatch, not an automatic merge or upload. */
export async function wordDeviceBackup(cache:WordDeviceDraft,session:Session){
 await cache.flush()
 const identity=wordDeviceName(cache.name)
 if(identity.epoch!==(session.collaborationEpoch??0)||identity.protocol!==session.collaborationProtocol)throw new Error('word-device-scope')
 let records:Awaited<ReturnType<WordDeviceDraft['records']>>|undefined,pending:Awaited<ReturnType<WordDeviceDraft['pendingRecords']>>|undefined
 for(let attempt=0;attempt<3;attempt++){const all=await cache.records(),unreviewed=await cache.pendingRecords();if(all.length===unreviewed.count){records=all;pending=unreviewed;break}}
 if(!records||!pending)throw new Error('word-device-backup-changed')
 const cached=new Y.Doc()
 try{
  if(records.length)Y.applyUpdate(cached,Y.mergeUpdates(records.map(item=>item.bytes)))
  const resources=await cache.pendingNodeResources()
  for(const item of resources)if(await nodeResourceHash(item.bytes)!==item.resource.hash)throw new Error('word-node-resource-integrity')
  const document=Y.encodeStateAsUpdate(cached)
  if(document.length>64*1024*1024)throw new Error('word-device-backup-limit')
  const uploads=await cache.pendingUploads(),value={schemaVersion:identity.protocol===wordLayoutProtocol?'hcd-word-device/6':'hcd-word-device/5',...(identity.protocol===wordLayoutProtocol?{collaborationProtocol:wordLayoutProtocol}:{}),documentId:session.documentId,epoch:session.collaborationEpoch??0,scopeHash:identity.scopeHash,documentBase64:base64(document),localUpdates:pending.records.filter(item=>item.local).map(item=>base64(item.bytes)),uploads:uploads.map(({bytes,...item})=>bytes?{...item,bytesBase64:base64(bytes)}:item),nodeResources:resources.map(({bytes,...item})=>({...item,bytesBase64:base64(bytes)}))}
  const body=JSON.stringify(value)
  if(utf8Length(body)>wordDeviceBackupReadLimit)throw new Error('word-device-backup-limit')
  return body
 }finally{cached.destroy()}
}
export async function openExistingWordDevice(session:Session,base:string,factory?:IDBFactory){
 const identity=await identityFor(session,base)
 return WordDeviceDraft.openExisting(identity.name,factory)
}
export type WordDeviceBackupCopy={name:string;epoch:number}
/** Only enumerate the same authenticated user, document and endpoint scope.
 * A future epoch is never assumed to belong to this authorization. */
export async function listWordDeviceBackups(session:Session,base:string,factory:IDBFactory=indexedDB,after?:WordDeviceBackupCopy){
 const identity=await identityFor(session,base),names=new Set<string>([identity.name]);let olderDiscovery=true,unavailable=false
 try{if(typeof factory.databases!=='function')olderDiscovery=false;else for(const item of await factory.databases())if(item.name?.startsWith(identity.prefix))names.add(item.name)}catch{olderDiscovery=false}
 const candidates=[...names].flatMap(name=>{
  if(!name.startsWith(identity.prefix))return []
  let metadata:ReturnType<typeof wordDeviceName>;try{metadata=wordDeviceName(name)}catch{return []}
  if(metadata.protocol!==session.collaborationProtocol)return []
  const epoch=metadata.epoch;return Number.isSafeInteger(epoch)&&epoch<=identity.epoch?[{name,epoch}]:[]
 }).sort((a,b)=>b.epoch-a.epoch||(a.name===identity.name?-1:b.name===identity.name?1:a.name.localeCompare(b.name)))
 const start=after?candidates.findIndex(item=>item.name===after.name&&item.epoch===after.epoch)+1:0
 if(after&&start===0)throw Error('word-device-list-changed')
 const page=candidates.slice(start,start+64),next=start+page.length<candidates.length?page[page.length-1]:undefined
 const copies:WordDeviceBackupCopy[]=[]
 for(const candidate of page){try{const cache=await WordDeviceDraft.openExisting(candidate.name,factory);if(!cache)continue;try{if(await hasWordDeviceBackup(cache))copies.push(candidate)}finally{await cache.close()}}catch{unavailable=true}}
 return{copies,olderDiscovery,unavailable,truncated:!!next,next}
}
export async function openWordDeviceCopy(session:Session,base:string,copy:WordDeviceBackupCopy,factory:IDBFactory=indexedDB){
 const identity=await identityFor(session,base),suffix=copy.name.startsWith(identity.prefix)?copy.name.slice(identity.prefix.length):''
 if(!suffix)throw Error('word-device-scope')
 const metadata=wordDeviceName(copy.name)
 if(metadata.protocol!==session.collaborationProtocol||metadata.epoch!==copy.epoch||!Number.isSafeInteger(copy.epoch)||copy.epoch>identity.epoch)throw Error('word-device-scope')
 return WordDeviceDraft.openExisting(copy.name,factory)
}
export async function hasWordDeviceBackup(cache:WordDeviceDraft){
 const [records,uploads,resources]=await Promise.all([cache.pendingRecords(),cache.pendingUploads(),cache.pendingNodeResources()])
 return records.records.some(item=>item.local)||uploads.length>0||resources.length>0
}
export async function downloadWordDeviceBackup(cache:WordDeviceDraft,session:Session,stillAuthorized:()=>boolean=()=>true){
 const body=await wordDeviceBackup(cache,session)
 if(!stillAuthorized())throw Error('word-device-scope-changed')
 const url=URL.createObjectURL(new Blob([body],{type:'application/json'})),link=window.document.createElement('a')
 try{link.href=url;link.download=`${session.documentId}-device-e${session.collaborationEpoch??0}.hcd-word-draft`;link.click()}finally{setTimeout(()=>URL.revokeObjectURL(url),60000)}
}
