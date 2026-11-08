/** Shared bounded metadata operations. Neither a file choice nor its stored
 * node envelope is collaboration authority. No network request lives here. */
import {pendingNodeResource,validateResourceDraft,nodeResourceHash,type WordNodeResourceDraft,type NodeResourceRepair} from './wordNodeResources.ts'
import {stableExtension} from './extensionRegistry.ts'
import type {ResourceNodePayload,NodeResourceModel} from './nodeResourceModel.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
export type ResourceTransactions={read:<T>(work:(store:IDBObjectStore)=>Promise<T>)=>Promise<T>;write:<T>(work:(store:IDBObjectStore)=>Promise<T>)=>Promise<T>}
function sameBytes(left:Uint8Array,right:Uint8Array){if(left.byteLength!==right.byteLength)return false;for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;return true}
export function resourceRequest<T>(request:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
export async function resourceTransaction<T>(db:IDBDatabase,mode:IDBTransactionMode,work:(store:IDBObjectStore)=>Promise<T>){
 const tx=db.transaction('meta',mode),done=new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('word-node-resource-storage'));tx.onerror=()=>{}})
 try{const result=await work(tx.objectStore('meta'));await done;return result}catch(error){try{tx.abort()}catch{};await done.catch(()=>{});throw error}
}
export class NodeResourceMetadata<P extends ResourceNodePayload=ExtensionNodePayload>{
 constructor(private transactions:ResourceTransactions,private model:NodeResourceModel<P>){}
 private check(input:unknown):asserts input is WordNodeResourceDraft<P>{validateResourceDraft(input,this.model)}
 pendingNodeResources=()=>this.transactions.read(async store=>{
  const keys=await resourceRequest(store.getAllKeys()),values:WordNodeResourceDraft<P>[]=[]
  for(const key of keys.filter(key=>typeof key==='string'&&key.startsWith('node-resource:'))){const value=await resourceRequest(store.get(key));this.check(value);if(key!==`node-resource:${value.id}`)throw new Error('word-node-resource-invalid');if(pendingNodeResource(value))values.push(value)}
  if(values.length>16||values.reduce((sum,value)=>sum+value.bytes.byteLength,0)>64*1024*1024)throw new Error('word-node-resource-limit');return values
 })
 putNodeResource=(value:WordNodeResourceDraft<P>)=>{
  this.check(value);if(value.phase!=='chosen')return Promise.reject(new Error('word-node-resource-invalid'));const copy=structuredClone(value)
  return this.transactions.write(async store=>{
   const key=`node-resource:${copy.id}`;if(await resourceRequest(store.get(key)))throw new Error('word-node-resource-exists')
   const keys=await resourceRequest(store.getAllKeys());let count=0,size=0
   for(const key of keys.filter(key=>typeof key==='string'&&key.startsWith('node-resource:'))){const existing=await resourceRequest(store.get(key));this.check(existing);if(pendingNodeResource(existing)){count++;size+=existing.bytes.byteLength}}
   if(count>=16||size+copy.bytes.byteLength>64*1024*1024)throw new Error('word-node-resource-limit');store.add(copy,key)
  })
 }
 /** Explicit file import, in one private transaction. Existing terminal tasks
  * win over repeated imports; a retry cannot revive a cancelled selection. */
 importNodeResources=async(input:readonly WordNodeResourceDraft<P>[])=>{
  if(!Array.isArray(input)||input.length>16||new Set(input.map(value=>value?.id)).size!==input.length)throw new Error('word-node-resource-limit')
  let size=0
  for(const value of input){this.check(value);if(value.phase!=='chosen')throw new Error('word-node-resource-invalid');size+=value.bytes.byteLength;if(size>64*1024*1024)throw new Error('word-node-resource-limit')}
  // Capture all intent before the first await, including ordinary-buffer
  // snapshots of SharedArrayBuffer views. Hashing never keeps an IDB tx alive.
  const copies=input.map(value=>{const {bytes,...metadata}=value;return{...structuredClone(metadata),bytes:Uint8Array.from(bytes)}})
  for(const value of copies)if(await nodeResourceHash(value.bytes)!==value.resource.hash)throw new Error('word-node-resource-integrity')
  return this.transactions.write(async store=>{
   const keys=await resourceRequest(store.getAllKeys()),existing=new Map<string,WordNodeResourceDraft<P>>()
   for(const key of keys.filter(key=>typeof key==='string'&&key.startsWith('node-resource:'))){const value=await resourceRequest(store.get(key));this.check(value);existing.set(value.id,value)}
   const added:WordNodeResourceDraft<P>[]=[]
   for(const value of copies){const old=existing.get(value.id);if(old){if(stableExtension({...old,bytes:[],phase:''})!==stableExtension({...value,bytes:[],phase:''}))throw new Error('word-node-resource-changed');if(pendingNodeResource(old)&&!sameBytes(old.bytes,value.bytes))throw new Error('word-node-resource-integrity');continue}added.push(value)}
   const pending=[...existing.values()].filter(pendingNodeResource),size=[...pending,...added].reduce((sum,value)=>sum+value.bytes.length,0);if(pending.length+added.length>16||size>64*1024*1024)throw new Error('word-node-resource-limit')
   added.forEach(value=>store.add(value,`node-resource:${value.id}`));return added.length
  })
 }
 /** Explicit repair only: replace the exact reviewed corrupt bytes, never a
  * changed, removed, linked or cancelled task. The whole batch is atomic. */
 repairNodeResources=async(input:readonly NodeResourceRepair<P>[],guard:()=>void)=>{
  if(!Array.isArray(input)||!input.length||input.length>16||new Set(input.map(value=>value?.original?.id)).size!==input.length)throw Error('word-node-resource-limit')
  let size=0
  for(const {original,replacement}of input){this.check(original);this.check(replacement);size+=original.bytes.length;if(size>64*1024*1024)throw Error('word-node-resource-limit');if(!pendingNodeResource(original)||replacement.phase!=='chosen'||stableExtension({...original,bytes:[],phase:''})!==stableExtension({...replacement,bytes:[],phase:''}))throw Error('word-node-resource-repair-changed')}
  const copy=(value:WordNodeResourceDraft<P>)=>{const{bytes,...metadata}=value;return{...structuredClone(metadata),bytes:Uint8Array.from(bytes)}}
  const captured=input.map(({original,replacement})=>({original:copy(original),replacement:copy(replacement)}))
  for(const {original,replacement}of captured){if(await nodeResourceHash(replacement.bytes)!==replacement.resource.hash)throw Error('word-node-resource-integrity');if(await nodeResourceHash(original.bytes)===original.resource.hash)throw Error('word-node-resource-repair-changed')}
  guard()
  return this.transactions.write(async store=>{
   for(const {original}of captured){const current=await resourceRequest(store.get(`node-resource:${original.id}`));this.check(current);if(stableExtension({...current,bytes:[]})!==stableExtension({...original,bytes:[]})||!sameBytes(current.bytes,original.bytes))throw Error('word-node-resource-repair-changed')}
   guard();for(const {replacement}of captured)store.put(replacement,`node-resource:${replacement.id}`)
   return captured.length
  })
 }
 stageNodeResource=(expected:WordNodeResourceDraft<P>)=>{
  this.check(expected);const captured=structuredClone(expected)
  return this.transactions.write(async store=>{
   const key=`node-resource:${captured.id}`,value=await resourceRequest(store.get(key));this.check(value)
   if(stableExtension({...value,bytes:[],phase:''})!==stableExtension({...captured,bytes:[],phase:''}))throw new Error('word-node-resource-changed')
   const result:WordNodeResourceDraft<P>=pendingNodeResource(value)?{...value,phase:'archived'}:value;store.put(result,key);return result
  })
 }
 finishNodeResource=(id:string,phase:'linked'|'cancelled')=>{
  if(!/^[a-f0-9-]{36}$/.test(id)||!['linked','cancelled'].includes(phase))return Promise.reject(new Error('word-node-resource-invalid'))
  return this.transactions.write(async store=>{
   const key=`node-resource:${id}`,value=await resourceRequest(store.get(key));this.check(value);if(pendingNodeResource(value))store.put({...value,phase,bytes:new Uint8Array()},key)
   // Staging never recreates absent records; terminal pruning is safe against
   // a stale response from a different window.
   const keys=await resourceRequest(store.getAllKeys()),terminal:IDBValidKey[]=[]
   for(const key of keys.filter(key=>typeof key==='string'&&key.startsWith('node-resource:'))){const entry=await resourceRequest(store.get(key));this.check(entry);if(!pendingNodeResource(entry))terminal.push(key)}
   for(const key of terminal.slice(0,Math.max(0,terminal.length-128)))store.delete(key)
  })
 }
}
