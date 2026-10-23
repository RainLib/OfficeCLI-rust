import * as Y from 'yjs'
import type { Session } from './api.ts'

const prefix='hcd-local-draft-v1-'
const maxUpdate=8*1024*1024, maxJournal=64*1024*1024
const maxRows=100000
export type LocalDraftState='idle'|'writing'|'stored'|'failed'
export type DraftIdentity={prefix:string;name:string;epoch:number}
function endpoint(value:string,base:string){
  const url=new URL(value,base)
  // Credentials and routing query parameters must never become cache keys.
  // Ambiguous endpoints disable caching rather than sharing a cache by accident.
  if(url.username || url.password || url.search || url.hash)throw new Error('Unsupported local draft endpoint')
  return url.href.replace(/\/$/,'')
}
export async function draftIdentity(session:Session,userId:string,base:string):Promise<DraftIdentity>{
  const epoch=session.collaborationEpoch??0
  if(!Number.isSafeInteger(epoch)||epoch<0||!userId)throw new Error('Invalid local draft identity')
  const scope=JSON.stringify([endpoint(session.apiUrl||'/v1/documents',base),endpoint(session.collabUrl||'ws://127.0.0.1:8768',base),session.documentId,userId])
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope))
  const key=prefix+[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')+'-'
  return {prefix:key,name:key+epoch,epoch}
}
function transactionDone(tx:IDBTransaction):Promise<void>{
  return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Local draft transaction aborted'));tx.onerror=()=>{/* abort is authoritative */}})
}
function request<T>(value:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error)})}
function bytes(value:unknown):Uint8Array{
  if(!(value instanceof Uint8Array) || value.byteLength>maxUpdate)throw new Error('Invalid local draft update')
  return value
}
/** Append-only CRDT updates. All read/compact/delete operations share one IDB
 * transaction, so concurrent windows cannot erase each other's pending input.
 * No timer, canonical revision, token, or UI "saved" flag authorizes deletion. */
export class LocalDraftJournal {
  state:LocalDraftState='idle'
  error:unknown
  private listeners=new Set<()=>void>()
  private pending=0
  private closed=false
  private detach:(()=>void)|undefined
  private compacting:Promise<void>|null=null
  constructor(readonly identity:DraftIdentity,private db:IDBDatabase){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  snapshot=()=>this.state
  private changed(state:LocalDraftState,error?:unknown){
    // Later deltas may depend on an update that never reached disk. A successful
    // append cannot make this journal complete again; retain the first failure.
    if(this.state==='failed')return
    this.state=state;this.error=error;this.listeners.forEach(listener=>listener())
  }
  static async open(identity:DraftIdentity,factory:IDBFactory=indexedDB):Promise<LocalDraftJournal>{
    const opening=factory.open(identity.name,1)
    opening.onupgradeneeded=()=>{opening.result.createObjectStore('updates',{autoIncrement:true});opening.result.createObjectStore('meta')}
    const db=await request(opening)
    db.onversionchange=()=>db.close()
    return new LocalDraftJournal(identity,db)
  }
  async load():Promise<Y.Doc>{
    const tx=this.db.transaction('updates','readonly'),done=transactionDone(tx),store=tx.objectStore('updates')
    const count=await request(store.count())
    if(count>maxRows){await done;throw new Error('Local draft journal exceeds row limit')}
    const records=await request(store.getAll());await done
    const updates=records.map(bytes)
    if(updates.reduce((sum,value)=>sum+value.byteLength,0)>maxJournal)throw new Error('Local draft journal exceeds byte limit')
    const doc=new Y.Doc()
    try {if(updates.length)Y.applyUpdate(doc,Y.mergeUpdates(updates),'hcd-local-load');return doc}
    catch(error){doc.destroy();throw error}
  }
  async append(value:Uint8Array):Promise<void>{
    if(this.closed)throw new Error('Local draft journal is closed')
    if(value.byteLength>maxUpdate){this.changed('failed',new Error('Local draft update exceeds byte limit'));throw this.error}
    this.pending++;this.changed('writing')
    const tx=this.db.transaction(['updates','meta'],'readwrite'),done=transactionDone(tx),updates=tx.objectStore('updates'),meta=tx.objectStore('meta')
    let limit=false,count=0
    const current=meta.get('usage')
    current.onsuccess=()=>{
      const usage=current.result??{bytes:0,count:0}
      count=usage.count+1
      if(!Number.isSafeInteger(usage.bytes)||!Number.isSafeInteger(usage.count)||usage.bytes+value.byteLength>maxJournal || count>maxRows){limit=true;tx.abort();return}
      updates.add(Uint8Array.from(value));meta.put({bytes:usage.bytes+value.byteLength,count},'usage');meta.put(Date.now(),'updatedAt');meta.put(false,'archived')
    }
    try{await done;this.pending--;if(this.state!=='failed')this.changed(this.pending?'writing':'stored')}
    catch(error){this.pending--;this.changed('failed',limit?new Error('Local draft journal is full'):error);throw this.error}
    if(count>=128)void this.compact().catch(error=>this.changed('failed',error))
  }
  async compact():Promise<void>{
    if(this.compacting)return this.compacting
    const operation=(async()=>{
      const tx=this.db.transaction(['updates','meta'],'readwrite'),done=transactionDone(tx),store=tx.objectStore('updates'),all=store.getAll()
      let failure:unknown
      all.onsuccess=()=>{
        try{
          const updates=all.result.map(bytes)
          if(updates.reduce((sum,value)=>sum+value.byteLength,0)>maxJournal)throw new Error('Local draft journal is full')
          const merged=Y.mergeUpdates(updates)
          if(merged.byteLength>maxUpdate)throw new Error('Local draft snapshot exceeds byte limit')
          // Never replace the shared journal with this tab's possibly stale doc.
          store.clear();store.add(merged);tx.objectStore('meta').put({bytes:merged.byteLength,count:1},'usage')
        }catch(error){failure=error;tx.abort()}
      }
      try{await done}catch(error){throw failure??error}
    })()
    this.compacting=operation
    try{await operation}finally{if(this.compacting===operation)this.compacting=null}
  }
  bind(doc:Y.Doc){
    if(this.detach)throw new Error('Local draft journal is already bound')
    const update=(value:Uint8Array)=>{void this.append(value).catch(error=>this.changed('failed',error))}
    doc.on('update',update);this.detach=()=>doc.off('update',update)
    return this.append(Y.encodeStateAsUpdate(doc))
  }
  async flush(){
    if(this.closed)throw new Error('Local draft journal is closed')
    const tx=this.db.transaction('updates','readwrite'),done=transactionDone(tx);tx.objectStore('updates').count();await done
    if(this.state==='failed')throw this.error
  }
  async metadata():Promise<{updatedAt:number;archived:boolean}> {
    const tx=this.db.transaction('meta','readonly'),done=transactionDone(tx),store=tx.objectStore('meta')
    const [updatedAt,archived]=await Promise.all([request(store.get('updatedAt')),request(store.get('archived'))]);await done
    return {updatedAt:Number(updatedAt)||0,archived:archived===true}
  }
  async archive(){const tx=this.db.transaction('meta','readwrite'),done=transactionDone(tx);tx.objectStore('meta').put(true,'archived');await done}
  close(){this.detach?.();this.detach=undefined;this.closed=true;this.db.close()}
}
export function cacheAddsChanges(cached:Y.Doc,server:Y.Doc):boolean{
  const merged=new Y.Doc()
  try{Y.applyUpdate(merged,Y.encodeStateAsUpdate(server));const before=Y.snapshot(merged);Y.applyUpdate(merged,Y.encodeStateAsUpdate(cached));return !Y.equalSnapshots(before,Y.snapshot(merged))}
  finally{merged.destroy()}
}
export function restoreLocalDraft(cached:Y.Doc,server:Y.Doc):Y.Doc{
  const result=new Y.Doc()
  Y.applyUpdate(result,Y.encodeStateAsUpdate(server));Y.applyUpdate(result,Y.encodeStateAsUpdate(cached))
  // Disk is a draft, never authority for coordinator receipts or schema. Keep
  // source identities and image intents, but use the authenticated room metadata.
  for(const name of ['hcdSave','hcdSchema','hcdImageReceipts']){
    const target=result.getMap(name),canonical=server.getMap(name)
    result.transact(()=>{for(const key of target.keys())if(!canonical.has(key))target.delete(key);for(const[key,value]of canonical)target.set(key,value)},'hcd-local-restore')
  }
  return result
}

export function forkDraftIdentity(identity:DraftIdentity):DraftIdentity{return {...identity,name:identity.name+'-copy-'+crypto.randomUUID()}}
export async function listDraftIdentities(identity:DraftIdentity,factory:IDBFactory=indexedDB):Promise<DraftIdentity[]>{
  const databases=await factory.databases()
  return databases.flatMap(({name})=>{
    if(!name?.startsWith(identity.prefix))return []
    const suffix=name.slice(identity.prefix.length),match=/^(0|[1-9][0-9]*)(?:-copy-[a-f0-9-]{36})?$/.exec(suffix)
    if(!match || !Number.isSafeInteger(Number(match[1])))return []
    return [{prefix:identity.prefix,name,epoch:Number(match[1])}]
  })
}
/** A bounded plain-text preview. It never interprets cached XML as HTML. */
export function localDraftPreview(doc:Y.Doc):string{
  let result='',visited=0
  const walk=(node:Y.XmlFragment|Y.XmlElement|Y.XmlText)=>{
    if(result.length>=1500 || ++visited>2000)return
    if(node instanceof Y.XmlText){for(const part of node.toDelta())if(typeof part.insert==='string')result+=part.insert.slice(0,1500-result.length);result+='\n'}
    else for(const child of node.toArray()){if(result.length>=1500 || visited>2000)break;if(child instanceof Y.XmlElement || child instanceof Y.XmlText)walk(child)}
  }
  walk(doc.getXmlFragment('default'));return result.slice(0,1500)
}
