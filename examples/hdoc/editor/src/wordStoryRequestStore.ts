/** One durable request per member/document/endpoint. IDB transactions provide
 * compare-and-set across windows without holding a lock across network I/O. */
export type WordStoryStorage={read:()=>Promise<string|null>;replace:(expected:string|null,next:string|null)=>Promise<void>;close:()=>void;subscribe?:(listener:()=>void)=>()=>void}
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('word-story-storage'));tx.onerror=()=>{}})
const result=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
export async function openWordStoryRequestStore(name:string,factory:IDBFactory=indexedDB,errorPrefix='word-story'):Promise<WordStoryStorage>{
 const opening=factory.open(name,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('request')
 const db=await result(opening),listeners=new Set<()=>void>(),channel=typeof window!=='undefined'&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel(name):undefined
 channel?.addEventListener('message',()=>listeners.forEach(listener=>listener()));db.onversionchange=()=>{db.close();listeners.forEach(listener=>listener())}
 return{
  async read(){const tx=db.transaction('request','readonly'),finished=done(tx);void finished.catch(()=>{});const value=await result(tx.objectStore('request').get('current'));await finished;if(value!==undefined&&typeof value!=='string')throw Error(`${errorPrefix}-record-invalid`);return value??null},
  async replace(expected,next){
   const tx=db.transaction('request','readwrite'),finished=done(tx);void finished.catch(()=>{});const store=tx.objectStore('request')
   const value=await result(store.get('current'));if((value??null)!==expected){tx.abort();await finished.catch(()=>{});throw Error(`${errorPrefix}-record-changed`)}
   if(next===null)store.delete('current');else store.put(next,'current');await finished;channel?.postMessage(null)
  },
  subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener)}},
  close(){channel?.close();listeners.clear();db.close()},
 }
}
