/** Both stopped-request kinds share one transaction. A new content/structure
 * intent may reserve the empty peer slot; recovery never needs that reservation.
 * Version-2 legacy databases are frozen for old version-1 writers. Their bytes
 * stay untouched; an atomic digest ledger prevents completed requests returning. */
import {readDeviceRequestQueue,type DeviceRequestStorage,type DeviceQueueOptions} from './wordDeviceRequestQueue.ts'
export const stoppedDraftQueueOptions:DeviceQueueOptions={schemaVersion:'hcd-word-draft-device/1',errorPrefix:'word-draft',maxBytes:1024*1024,maxRequestBytes:64*1024,maxRequests:16}
export const stoppedTopologyQueueOptions:DeviceQueueOptions={schemaVersion:'hcd-word-stopped-topology-device/1',errorPrefix:'word-layout',maxBytes:8*1024*1024,maxRequestBytes:1024*1024,maxRequests:16}
type Kind='draft'|'topology'
const kinds:readonly Kind[]=['draft','topology']
const options=(kind:Kind)=>kind==='draft'?stoppedDraftQueueOptions:stoppedTopologyQueueOptions
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('word-stopped-storage'));tx.onerror=()=>{}})
const result=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
function open(factory:IDBFactory,name:string,version:number){
 return new Promise<IDBDatabase>((resolve,reject)=>{
  const request=factory.open(name,version);let rejected=false
  request.onupgradeneeded=event=>{if(event.oldVersion===0)request.result.createObjectStore('request');else if(!request.result.objectStoreNames.contains('request'))request.transaction!.abort()}
  request.onblocked=()=>{rejected=true;reject(Error('word-stopped-storage-blocked'))}
  request.onerror=()=>reject(request.error??Error('word-stopped-storage'))
  request.onsuccess=()=>{if(rejected){request.result.close();return}const db=request.result;if(!db.objectStoreNames.contains('request')){db.close();reject(Error('word-stopped-storage-invalid'));return}db.onversionchange=()=>db.close();resolve(db)}
 })
}
async function legacySnapshot(factory:IDBFactory,prefix:string,kind:Kind){
 const name=(kind==='draft'?'hcd-word-draft-attempt-v2-':'hcd-word-stopped-topology-v2-')+prefix,db=await open(factory,name,2)
 try{
  const tx=db.transaction('request','readonly'),finished=done(tx);void finished.catch(()=>{})
  const raw=await result(tx.objectStore('request').get('current'));await finished
  if(raw!==undefined&&typeof raw!=='string')throw Error(`${options(kind).errorPrefix}-record-invalid`)
  if(raw!==undefined&&new TextEncoder().encode(raw).byteLength>options(kind).maxBytes)throw Error(`${options(kind).errorPrefix}-device-limit`)
  const digest=raw===undefined?null:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),n=>n.toString(16).padStart(2,'0')).join('')
  return{raw:raw??null,digest}
 }finally{db.close()}
}
export async function openWordStoppedRequestStore(prefix:string,kind:Kind,factory:IDBFactory=indexedDB):Promise<DeviceRequestStorage>{
 // Freeze both old writers before any new slot becomes available to a caller.
 const legacy=await Promise.all(kinds.map(value=>legacySnapshot(factory,prefix,value)))
 const name='hcd-word-stopped-requests-v1-'+prefix,db=await open(factory,name,1),errorPrefix=options(kind).errorPrefix
 try{
  const tx=db.transaction('request','readwrite'),finished=done(tx);void finished.catch(()=>{});const store=tx.objectStore('request')
  try{
   for(let i=0;i<kinds.length;i++){
    const key=kinds[i],marker=await result(store.get('legacy-'+key))
    if(marker!==undefined){if(!marker||Object.keys(marker).join(',')!=='digest'||marker.digest!==legacy[i].digest)throw Error(`${errorPrefix}-legacy-changed`);continue}
    // A missing ledger must never overwrite a separately retained new request.
    if(await result(store.get(key))!==undefined)throw Error(`${errorPrefix}-record-changed`)
    if(legacy[i].raw!==null)store.put(legacy[i].raw,key)
    store.put({digest:legacy[i].digest},'legacy-'+key)
   }
  }catch(error){tx.abort();await finished.catch(()=>{});throw error}
  await finished
 }catch(error){db.close();throw error}
 const listeners=new Set<()=>void>(),channel=typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel(name):undefined
 channel?.addEventListener('message',()=>listeners.forEach(listener=>listener()));db.onversionchange=()=>{db.close();listeners.forEach(listener=>listener())}
 return{
  async read(){const tx=db.transaction('request','readonly'),finished=done(tx);void finished.catch(()=>{});const raw=await result(tx.objectStore('request').get(kind));await finished;if(raw!==undefined&&typeof raw!=='string')throw Error(`${errorPrefix}-record-invalid`);return raw??null},
  async replace(expected,next,exclusive=false){
   if(next!==null)readDeviceRequestQueue(next,options(kind))
   const tx=db.transaction('request','readwrite'),finished=done(tx);void finished.catch(()=>{});const store=tx.objectStore('request')
   try{
    if((await result(store.get(kind))??null)!==expected)throw Error(`${errorPrefix}-record-changed`)
    if(exclusive&&await result(store.get(kind==='draft'?'topology':'draft'))!==undefined)throw Error(`${errorPrefix}-other-request-pending`)
    if(next===null)store.delete(kind);else store.put(next,kind)
   }catch(error){tx.abort();await finished.catch(()=>{});throw error}
   await finished;channel?.postMessage(null)
  },
  subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener)}},
  close(){channel?.close();listeners.clear();db.close()},
 }
}
