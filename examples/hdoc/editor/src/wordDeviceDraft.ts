/** Browser-only regional device journal. Shared snapshots are for comparison;
 * only updates produced locally may be proposed for authored recovery. */
import * as Y from 'yjs'
import {NodeResourceMetadata,resourceTransaction} from './nodeResourceStorage.ts'
import {ordinaryNodeResourceModel} from './nodeResourceModel.ts'
import {validateLocalUpload,type WordLocalUpload} from './wordUploadTypes.ts'
import {pendingNodeResource,validateNodeResourceDraft,nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {stableExtension} from './extensionRegistry.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {draftNamespace} from './localDrafts.ts'
import type {Session} from './api.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import {requireWordBrowserProtocol,type WordBrowserProtocol} from './wordBrowserProtocol.ts'
import {withRegionalFileLock} from './regionalFileBoundary.ts'
const limit=64*1024*1024,maxUpdate=8*1024*1024
export const wordDeviceRestoreOrigin=Object.freeze({kind:'hcd-word-device-restore/1'})
function done(tx:IDBTransaction){return new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('word-device-storage'));tx.onerror=()=>{}})}
function read<T>(value:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error)})}
export type WordDeviceRecord={bytes:Uint8Array;local:boolean}
export function wordDeviceSuffix(protocol:Session['collaborationProtocol']){requireWordBrowserProtocol(protocol);return protocol===wordLayoutProtocol?'wordregions2-device1':'wordregions1-device2'}
export function wordDeviceName(name:string){const match=/^hcd-local-draft-v1-([a-f0-9]{64})-(0|[1-9][0-9]*)-(wordregions1-device2|wordregions2-device1)(?:-[a-f0-9-]{36})?$/.exec(name);if(!match||!Number.isSafeInteger(Number(match[2])))throw new Error('word-device-scope');return{scopeHash:match[1],epoch:Number(match[2]),protocol:(match[3]==='wordregions2-device1'?wordLayoutProtocol:wordRegionalProtocol) as WordBrowserProtocol}}
export async function wordDeviceIdentity(session:Session,userId:string,base:string){if(session.collaborationProtocol!==wordRegionalProtocol&&session.collaborationProtocol!==wordLayoutProtocol)throw new Error('word-device-protocol');const identity=await draftNamespace(session,userId,base);return{name:identity.name+'-'+wordDeviceSuffix(session.collaborationProtocol),prefix:identity.prefix,epoch:identity.epoch}}
export class WordDeviceDraft{
 private detach:(()=>void)|undefined
 private boundDocument:Y.Doc|undefined
 private pending:Promise<unknown>=Promise.resolve()
 private closed=false
 private closing:Promise<void>|undefined
 private publications=new Set<Promise<unknown>>()
 private failure:unknown
 private listeners=new Set<()=>void>()
 private status:'idle'|'writing'|'stored'|'failed'='idle'
 private constructor(readonly name:string,private db:IDBDatabase){}
 get protocol(){return wordDeviceName(this.name).protocol}
 static async open(name:string,factory:IDBFactory=indexedDB){wordDeviceName(name);const request=factory.open(name,1);request.onupgradeneeded=()=>{request.result.createObjectStore('records',{autoIncrement:true});request.result.createObjectStore('meta')};return new WordDeviceDraft(name,await read(request))}
 /** Read an existing device journal without creating an empty replacement. */
 static async openExisting(name:string,factory:IDBFactory=indexedDB){
  wordDeviceName(name)
  const request=factory.open(name,1);let missing=false
  request.onupgradeneeded=()=>{missing=true;request.transaction!.abort()}
  const db=await new Promise<IDBDatabase|null>((resolve,reject)=>{let blocked=false;request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result)};request.onerror=()=>missing?resolve(null):reject(request.error??new Error('word-device-storage'));request.onblocked=()=>{blocked=true;reject(new Error('word-device-blocked'))}})
  if(!db)return null
  if(!db.objectStoreNames.contains('records')||!db.objectStoreNames.contains('meta')){db.close();throw new Error('word-device-invalid')}
  return new WordDeviceDraft(name,db)
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.status
 private emit(value:typeof this.status){if(this.failure)return;this.status=value;this.listeners.forEach(listener=>listener())}
 private fail(error:unknown){this.failure??=error;this.status='failed';this.listeners.forEach(listener=>listener())}
 async records():Promise<WordDeviceRecord[]>{
  const tx=this.db.transaction('records','readonly'),complete=done(tx),store=tx.objectStore('records'),count=await read(store.count());if(count>100000){await complete;throw new Error('word-device-limit')}const values=await read(store.getAll());await complete;let length=0
  for(const value of values)if(!value||Object.keys(value).sort().join(',')!=='bytes,local'||!(value.bytes instanceof Uint8Array)||value.bytes.length>maxUpdate||typeof value.local!=='boolean'||(length+=value.bytes.length)>limit)throw new Error('word-device-invalid')
  return values
 }
 async document(){const document=new Y.Doc();try{const records=await this.records();if(records.length)Y.applyUpdate(document,Y.mergeUpdates(records.map(record=>record.bytes)));return document}catch(error){document.destroy();throw error}}
 async pendingRecords(){const records=await this.records(),tx=this.db.transaction('meta','readonly'),complete=done(tx),index=await read(tx.objectStore('meta').get('reviewedThrough'));await complete;const start=index??0;if(!Number.isSafeInteger(start)||start<0||start>records.length)throw new Error('word-device-invalid');return{records:records.slice(start),count:records.length}}
 async markReviewed(count:number,signal?:AbortSignal){
  signal?.throwIfAborted()
  const tx=this.db.transaction(['records','meta'],'readwrite'),complete=done(tx),meta=tx.objectStore('meta'),request=tx.objectStore('records').count()
  const stop=()=>{try{tx.abort()}catch{/* committed or already aborted */}}
  signal?.addEventListener('abort',stop,{once:true})
  request.onsuccess=()=>{if(!Number.isSafeInteger(count)||count<0||count>request.result){tx.abort();return}const previous=meta.get('reviewedThrough');previous.onsuccess=()=>{meta.put(Math.max(previous.result??0,count),'reviewedThrough')}}
  try{if(signal?.aborted)stop();await complete}catch(error){signal?.throwIfAborted();throw error}finally{signal?.removeEventListener('abort',stop)}
 }
 async pendingUploads():Promise<WordLocalUpload[]>{const tx=this.db.transaction('meta','readonly'),complete=done(tx),store=tx.objectStore('meta'),keys=await read(store.getAllKeys()),values:WordLocalUpload[]=[];for(const key of keys.filter(key=>typeof key==='string'&&key.startsWith('upload:'))){const value=await read(store.get(key));validateLocalUpload(value);if(key!==`upload:${value.selection.id}`)throw new Error('word-upload-local-invalid');values.push(value)}await complete;if(values.length>32||JSON.stringify(values.map(({bytes,...metadata})=>metadata)).length>4*1024*1024||values.reduce((sum,value)=>sum+(value.bytes?.length??0),0)>64*1024*1024)throw new Error('word-upload-local-limit');for(const value of values)if(value.bytes&&await imageFileHash(value.bytes)!==value.selection.assetHash)throw new Error('word-upload-local-integrity');return values}
 async putUpload(value:WordLocalUpload,signal?:AbortSignal){validateLocalUpload(value);const copy=structuredClone(value);signal?.throwIfAborted();if(copy.bytes&&await imageFileHash(copy.bytes)!==copy.selection.assetHash)throw new Error('word-upload-local-integrity');signal?.throwIfAborted();return this.publish(()=>this.uploadMetadata(async store=>{signal?.throwIfAborted();const keys=(await read(store.getAllKeys())).filter(key=>typeof key==='string'&&key.startsWith('upload:')),values:WordLocalUpload[]=[];for(const key of keys){const entry=await read(store.get(key));validateLocalUpload(entry);if(key!==`upload:${entry.selection.id}`)throw new Error('word-upload-local-invalid');values.push(entry)}const existing=values.find(entry=>entry.selection.id===copy.selection.id),metadata=(entry:WordLocalUpload)=>{const {bytes,...rest}=entry;return rest};if(existing&&(JSON.stringify(metadata(existing))!==JSON.stringify(metadata(copy))||(existing.bytes?.length??0)!==(copy.bytes?.length??0)||existing.bytes?.some((byte,index)=>byte!==copy.bytes?.[index])))throw new Error('word-upload-local-changed');const next=existing?values:[...values,copy];if(next.length>32||next.reduce((sum,entry)=>sum+(entry.bytes?.length??0),0)>64*1024*1024||JSON.stringify(next.map(metadata)).length>4*1024*1024)throw new Error('word-upload-local-limit');signal?.throwIfAborted();store.put(copy,`upload:${copy.selection.id}`)},signal))}
 removeUpload(id:string){if(!/^[a-f0-9-]{36}$/.test(id))return Promise.reject(new Error('word-upload-local-invalid'));return this.uploadMetadata(async store=>{store.delete(`upload:${id}`)})}
 private publish<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.closing||this.closed)return Promise.reject(new Error('word-device-closed'))
  const result=withRegionalFileLock(this.name,work,signal);this.publications.add(result);void result.finally(()=>this.publications.delete(result)).catch(()=>{});return result
 }
 private nodeResources=new NodeResourceMetadata({read:work=>resourceTransaction(this.db,'readonly',work),write:work=>this.resourceWrite(work)},ordinaryNodeResourceModel)
 pendingNodeResources=()=>this.nodeResources.pendingNodeResources()
 putNodeResource:NodeResourceMetadata['putNodeResource']=value=>this.publish(()=>this.nodeResources.putNodeResource(value))
 stageNodeResource:NodeResourceMetadata['stageNodeResource']=value=>this.nodeResources.stageNodeResource(value)
 finishNodeResource:NodeResourceMetadata['finishNodeResource']=(id,phase)=>this.nodeResources.finishNodeResource(id,phase)
 private async resourceWrite<T>(work:(store:IDBObjectStore)=>Promise<T>){let result!:T;await this.resourceMetadata(async store=>{result=await work(store)});return result}
 private resourceMetadata(change:(store:IDBObjectStore)=>Promise<void>){
  if(this.closed||this.failure)return Promise.reject(this.failure??new Error('word-device-closed'));this.emit('writing')
  const operation=this.pending.then(async()=>{const tx=this.db.transaction('meta','readwrite'),complete=done(tx);try{await change(tx.objectStore('meta'));await complete}catch(error){try{tx.abort()}catch{};await complete.catch(()=>{});throw error}})
  // A rejected resource choice did not lose a document update. Preserve the
  // caller's error without poisoning later text-journal writes or close().
  const settled=operation.catch(()=>{});this.pending=settled;void settled.then(()=>{if(this.pending===settled)this.emit('stored')});return operation
 }
 private uploadMetadata(change:(store:IDBObjectStore)=>Promise<void>,signal?:AbortSignal){if(this.closed||this.failure)return Promise.reject(this.failure??new Error('word-device-closed'));this.emit('writing');const operation=this.pending.then(async()=>{const tx=this.db.transaction('meta','readwrite'),complete=done(tx);try{await change(tx.objectStore('meta'));await complete}catch(error){try{tx.abort()}catch{};await complete.catch(()=>{});throw error}});const settled=operation.catch(error=>{if(!signal?.aborted||error!==signal.reason)this.fail(error)});this.pending=settled;void settled.then(()=>{if(this.pending===settled)this.emit('stored')});return operation}
 async localUpdates(){return(await this.pendingRecords()).records.filter(record=>record.local).map(record=>record.bytes)}
 /** Stage a verified file in one private transaction. This does not send any
  * update or file to the room; normal recovery and file review remain required. */
 async importBackup(input:{id:string;document:Uint8Array;localUpdates:Uint8Array[];uploads:WordLocalUpload[];nodeResources:WordNodeResourceDraft[]},signal?:AbortSignal){
  signal?.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(input.id))throw new Error('word-device-backup-invalid')
  const copy=structuredClone(input),records=[{bytes:copy.document,local:false},...copy.localUpdates.map(bytes=>({bytes,local:true}))]
  if(records.some(item=>!item.bytes.length||item.bytes.length>maxUpdate)||records.length>100000)throw new Error('word-device-limit')
  for(const item of copy.uploads){validateLocalUpload(item);if(item.bytes&&await imageFileHash(item.bytes)!==item.selection.assetHash)throw new Error('word-upload-local-integrity')}
  for(const item of copy.nodeResources){validateNodeResourceDraft(item);if(!pendingNodeResource(item)||await nodeResourceHash(item.bytes)!==item.resource.hash)throw new Error('word-node-resource-invalid')}
  if(new Set(copy.uploads.map(item=>item.selection.id)).size!==copy.uploads.length||new Set(copy.nodeResources.map(item=>item.id)).size!==copy.nodeResources.length)throw new Error('word-device-backup-invalid')
  signal?.throwIfAborted()
  return this.publish(()=>{
   const operation=this.pending.then(async()=>{
    signal?.throwIfAborted();if(this.closed||this.failure)throw this.failure??new Error('word-device-closed')
    const tx=this.db.transaction(['records','meta'],'readwrite'),complete=done(tx),meta=tx.objectStore('meta'),store=tx.objectStore('records'),stop=()=>{try{tx.abort()}catch{}}
    signal?.addEventListener('abort',stop,{once:true})
    try{
     if(await read(meta.get(`import:${copy.id}`))){await complete;return false}
     const usage=await read(meta.get('usage'))??{bytes:0,count:0},added=records.reduce((sum,item)=>sum+item.bytes.length,0)
     if(!Number.isSafeInteger(usage.bytes)||!Number.isSafeInteger(usage.count)||usage.bytes+added>limit||usage.count+records.length>100000)throw new Error('word-device-limit')
     const keys=await read(meta.getAllKeys()),uploads:WordLocalUpload[]=[],resources:WordNodeResourceDraft[]=[]
     if(keys.filter(key=>typeof key==='string'&&key.startsWith('import:')).length>=1024)throw new Error('word-device-limit')
     for(const key of keys){if(typeof key!=='string')continue;if(key.startsWith('upload:')){const value=await read(meta.get(key));validateLocalUpload(value);uploads.push(value)}else if(key.startsWith('node-resource:')){const value=await read(meta.get(key));validateNodeResourceDraft(value);resources.push(value)}}
     for(const item of copy.uploads){const old=uploads.find(value=>value.selection.id===item.selection.id);if(old){const {bytes:oldBytes,...oldMeta}=old,{bytes:newBytes,...newMeta}=item;if(stableExtension(oldMeta)!==stableExtension(newMeta)||(oldBytes?.length??0)!==(newBytes?.length??0)||oldBytes?.some((byte,index)=>byte!==newBytes?.[index]))throw new Error('word-upload-local-changed')}else uploads.push(item)}
     const addedResources:WordNodeResourceDraft[]=[]
     for(const item of copy.nodeResources){const old=resources.find(value=>value.id===item.id);if(old){if(stableExtension({...old,bytes:[],phase:''})!==stableExtension({...item,bytes:[],phase:''}))throw new Error('word-node-resource-changed')}else{const next={...item,phase:'chosen' as const};resources.push(next);addedResources.push(next)}}
     if(uploads.length>32||uploads.reduce((sum,item)=>sum+(item.bytes?.length??0),0)>limit||JSON.stringify(uploads.map(({bytes,...rest})=>rest)).length>4*1024*1024)throw new Error('word-upload-local-limit')
     const pending=resources.filter(pendingNodeResource);if(pending.length>16||pending.reduce((sum,item)=>sum+item.bytes.length,0)>limit)throw new Error('word-node-resource-limit')
     signal?.throwIfAborted();records.forEach(item=>store.add(item));for(const item of copy.uploads)meta.put(item,`upload:${item.selection.id}`);for(const item of addedResources)meta.add(item,`node-resource:${item.id}`)
     meta.put({bytes:usage.bytes+added,count:usage.count+records.length},'usage');meta.put(Date.now(),'updatedAt');meta.put(true,`import:${copy.id}`);await complete;return true
    }catch(error){stop();await complete.catch(()=>{});signal?.throwIfAborted();throw error}finally{signal?.removeEventListener('abort',stop)}
   });this.pending=operation.catch(()=>{});return operation
  },signal)
 }
 append(bytes:Uint8Array,local:boolean){
  if(this.closed||this.failure)return Promise.reject(this.failure??new Error('word-device-closed'))
  if(!bytes.length||bytes.length>maxUpdate){const error=new Error('word-device-limit');this.fail(error);return Promise.reject(error)}
  const copy=Uint8Array.from(bytes);this.emit('writing')
  const operation=this.pending.then(async()=>{
   if(this.failure)throw this.failure
   const tx=this.db.transaction(['records','meta'],'readwrite'),complete=done(tx),meta=tx.objectStore('meta'),get=meta.get('usage');let overflow=false
   get.onsuccess=()=>{const usage=get.result??{bytes:0,count:0};if(!Number.isSafeInteger(usage.bytes)||!Number.isSafeInteger(usage.count)||usage.bytes+copy.length>limit||usage.count>=100000){overflow=true;tx.abort();return}tx.objectStore('records').add({bytes:copy,local});meta.put({bytes:usage.bytes+copy.length,count:usage.count+1},'usage');meta.put(Date.now(),'updatedAt')}
   try{await complete}catch(error){throw overflow?new Error('word-device-limit'):error}
  });this.pending=operation;void operation.then(()=>{if(this.pending===operation)this.emit('stored')},error=>this.fail(error));return operation
 }
 async bind(document:Y.Doc,options?:{alreadyRecordedOrigin?:unknown}){if(this.detach||this.closed||this.closing)throw new Error('word-device-bound');const seed=Y.encodeStateAsUpdate(document);const update=(bytes:Uint8Array,origin:unknown,_document:Y.Doc,transaction:Y.Transaction)=>{if(options?.alreadyRecordedOrigin!==undefined&&origin===options.alreadyRecordedOrigin)return;void this.append(bytes,transaction.local||origin===wordDeviceRestoreOrigin).catch(()=>{})};document.on('update',update);this.boundDocument=document;this.detach=()=>document.off('update',update);await this.append(seed,false)}
 /** A paused, fenced session may rebind this same open journal. Never detach
  * another window's document or close the database needed for draft download. */
 async unbind(document:Y.Doc){if(this.closed||this.closing)throw Error('word-device-closed');if(this.boundDocument&&this.boundDocument!==document)throw Error('word-device-bound');this.detach?.();this.detach=undefined;this.boundDocument=undefined;await this.flush()}
 async flush(){await this.pending;if(this.failure)throw this.failure}
 close(){if(this.closing)return this.closing;if(this.closed)return Promise.resolve();this.detach?.();this.detach=undefined;this.boundDocument=undefined;this.closing=(async()=>{try{await Promise.allSettled([...this.publications]);await this.flush()}finally{this.closed=true;this.db.close()}})();return this.closing}
}
