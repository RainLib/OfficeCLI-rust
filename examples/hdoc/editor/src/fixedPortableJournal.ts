import {resourceRequest,resourceTransaction} from './nodeResourceStorage.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
import {fixedPortableLimits} from './fixedPortableArchive.ts'

type Transfer={version:1;id:string;phase:'pending'|'complete';bytes:Uint8Array;createdAt:number}
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const pendingLimit=3,totalLimit=128*1024*1024,terminalLimit=128
function check(value:Transfer){
 if(!value||value.version!==1||!hex(value.id)||!['pending','complete'].includes(value.phase)||!(value.bytes instanceof Uint8Array)||!Number.isSafeInteger(value.createdAt)||value.createdAt<0||value.phase==='pending'&&(!value.bytes.length||value.bytes.length>fixedPortableLimits.file)||value.phase==='complete'&&value.bytes.length)throw new Error('fixed-portable-journal-invalid')
}
/** A private write-ahead copy of a reviewed import. It is never authority to
 * write or resume automatically; a user must review and retry after restart. */
export class FixedPortableJournal{
 private constructor(private db:IDBDatabase){}
 static async open(name:string,factory:IDBFactory=indexedDB){
  if(!/^hcd-fixed-draft-v1-[a-f0-9]{64}-[a-f0-9]{64}-portable1$/.test(name))throw new Error('fixed-portable-journal-scope')
  const request=factory.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('meta')
  const db=await resourceRequest(request);db.onversionchange=()=>db.close();return new FixedPortableJournal(db)
 }
 private async entries(store:IDBObjectStore){
  const values=await resourceRequest(store.getAll()) as Transfer[],keys=await resourceRequest(store.getAllKeys())
  if(values.length>pendingLimit+terminalLimit)throw new Error('fixed-portable-journal-limit')
  values.forEach((value,index)=>{check(value);if(keys[index]!==value.id)throw new Error('fixed-portable-journal-invalid')})
  const active=values.filter(value=>value.phase==='pending');if(active.length>pendingLimit||active.reduce((sum,value)=>sum+value.bytes.length,0)>totalLimit)throw new Error('fixed-portable-journal-limit')
  return values
 }
 async pending(){
  const entries=await resourceTransaction(this.db,'readonly',store=>this.entries(store)),active=entries.filter(value=>value.phase==='pending')
  for(const value of active)if(await fixedImageHash(value.bytes)!==value.id)throw new Error('fixed-portable-journal-integrity')
  return active.map(value=>({...value,bytes:Uint8Array.from(value.bytes)}))
 }
 async begin(input:Uint8Array){
  if(!(input instanceof Uint8Array)||!input.length||input.length>fixedPortableLimits.file)throw new Error('fixed-portable-journal-limit')
  const bytes=Uint8Array.from(input),id=await fixedImageHash(bytes)
  return resourceTransaction(this.db,'readwrite',async store=>{
   const values=await this.entries(store),current=values.find(value=>value.id===id)
   if(current){if(current.phase==='pending'&&(current.bytes.length!==bytes.length||current.bytes.some((byte,index)=>byte!==bytes[index])))throw new Error('fixed-portable-journal-integrity');return {id,phase:current.phase}}
   const active=values.filter(value=>value.phase==='pending');if(active.length>=pendingLimit||active.reduce((sum,value)=>sum+value.bytes.length,0)+bytes.length>totalLimit||values.length>=pendingLimit+terminalLimit)throw new Error('fixed-portable-journal-limit')
   store.add({version:1,id,phase:'pending',bytes,createdAt:Date.now()} satisfies Transfer,id);return {id,phase:'pending' as const}
  })
 }
 async complete(id:string){
  if(!hex(id))throw new Error('fixed-portable-journal-invalid')
  return resourceTransaction(this.db,'readwrite',async store=>{
   const values=await this.entries(store),entry=values.find(value=>value.id===id);if(!entry)throw new Error('fixed-portable-journal-missing')
   if(entry.phase==='pending')store.put({...entry,phase:'complete',bytes:new Uint8Array()},id)
   const terminal=values.filter(value=>value.phase==='complete').sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))
   for(const value of terminal.slice(0,Math.max(0,terminal.length+(entry.phase==='pending'?1:0)-terminalLimit)))store.delete(value.id)
  })
 }
 /** Discard only the retained recovery file, never any task or draft branch
  * that may already have been imported before an interruption. */
 async discard(id:string){
  if(!hex(id))throw new Error('fixed-portable-journal-invalid')
  await resourceTransaction(this.db,'readwrite',async store=>{const value=await resourceRequest(store.get(id)) as Transfer|undefined;if(!value||value.id!==id||value.phase!=='pending')throw new Error('fixed-portable-journal-missing');check(value);store.delete(id)})
 }
 close(){this.db.close()}
}
