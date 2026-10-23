import {draftIdentity,type LocalDraftState} from './localDrafts.ts'
import type {Session} from './api.ts'
import {validGeometry,type ImageDraft,type ImageField} from './imageDrafts.ts'
import type {TextDraft,TextRun} from './textDrafts.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {FixedEditAttempt} from './saveEdits.ts'

const maxBytes=8*1024*1024,maxCopies=64
const hash=/^[0-9a-f]{64}$/
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const string=(value:unknown,max=160):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value)
const revision=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
function invalid():never{throw new Error('Invalid fixed draft backup')}
function textRun(value:unknown):TextRun{
  if(!object(value)||!string(value.nodeId)||typeof value.nodeHash!=='string'||!hash.test(value.nodeHash)||typeof value.text!=='string')return invalid()
  return {nodeId:value.nodeId,nodeHash:value.nodeHash,text:value.text}
}
function geometry(value:unknown):ImageDraft['geometry']{
  if(!object(value)||(value.unit!=='pt'&&value.unit!=='emu')||!['x','y','width','height'].every(key=>typeof value[key]==='number'))return invalid()
  return {x:value.x as number,y:value.y as number,width:value.width as number,height:value.height as number,unit:value.unit}
}
function image(value:unknown):ImageDraft['base']{
  if(!object(value)||!string(value.nodeId)||typeof value.visualHash!=='string'||!hash.test(value.visualHash)
    ||(value.assetHash!=null&&(typeof value.assetHash!=='string'||!hash.test(value.assetHash))))return invalid()
  const rect=geometry(value.geometry);if(!validGeometry(rect))return invalid()
  return {nodeId:value.nodeId,visualHash:value.visualHash,geometry:rect,...(value.assetHash!=null?{assetHash:value.assetHash as string}:{}),...(string(value.label,512)?{label:value.label}:{})}
}
function texts(value:unknown):Array<[string,TextDraft]>{
  if(!Array.isArray(value)||value.length>4000)return invalid()
  const ids=new Set<string>()
  return value.map(entry=>{
    if(!Array.isArray(entry)||entry.length!==2||!string(entry[0])||ids.has(entry[0])||!object(entry[1]))return invalid()
    ids.add(entry[0]);const [id,draft]=entry,base=textRun(draft.base)
    if(base.nodeId!==id||!revision(draft.revision)||typeof draft.text!=='string'||(draft.stale!==undefined&&draft.stale!=='refresh'&&draft.stale!=='deleted')||(draft.page!==undefined&&!revision(draft.page)))return invalid()
    const remote=draft.remote?textRun(draft.remote):undefined;if(remote&&remote.nodeId!==id)return invalid()
    return [id,{base,revision:draft.revision,text:draft.text,...(remote?{remote}:{}),...(draft.stale?{stale:draft.stale as 'refresh'|'deleted'}:{}),...(draft.page!==undefined?{page:draft.page as number}:{})}]
  })
}
function imageFields(value:unknown):ImageField[]|undefined{
  if(value===undefined)return undefined
  if(!Array.isArray(value)||value.length>5||new Set(value).size!==value.length||value.some(field=>!['x','y','width','height','assetHash'].includes(field)))return invalid()
  return [...value] as ImageField[]
}
function images(value:unknown):Array<[string,ImageDraft]>{
  if(!Array.isArray(value)||value.length>1000)return invalid()
  const ids=new Set<string>()
  return value.map(entry=>{
    if(!Array.isArray(entry)||entry.length!==2||!string(entry[0])||ids.has(entry[0])||!object(entry[1]))return invalid()
    ids.add(entry[0]);const [id,draft]=entry,base=image(draft.base)
    if((draft.restoreSource!==undefined&&typeof draft.restoreSource!=='boolean')||(draft.restoreSource===true&&draft.assetHash!==undefined)||base.nodeId!==id||!revision(draft.revision)||(draft.assetHash!==undefined&&(typeof draft.assetHash!=='string'||!hash.test(draft.assetHash)))||(draft.page!==undefined&&!revision(draft.page))||(draft.observedRevision!==undefined&&!revision(draft.observedRevision)))return invalid()
    const touched=imageFields(draft.touched),conflictingFields=imageFields(draft.conflictingFields)
    let remote:ImageDraft['remote']
    if(draft.remote!==undefined){if(!object(draft.remote)||!revision(draft.remote.revision))return invalid();remote={image:image(draft.remote.image),revision:draft.remote.revision};if(remote.image.nodeId!==id)return invalid()}
    return [id,{base,revision:draft.revision,geometry:geometry(draft.geometry),...(touched?{touched}:{}),...(conflictingFields?{conflictingFields}:{}),...(draft.assetHash?{assetHash:draft.assetHash as string}:{}),...(draft.restoreSource===true?{restoreSource:true}:{}),...(draft.page!==undefined?{page:draft.page as number}:{}),...(draft.observedRevision!==undefined?{observedRevision:draft.observedRevision as number}:{}),...(draft.deleted===true?{deleted:true}:{}),...(remote?{remote}:{})}]
  })
}
export function validateFixedDraft(value:unknown):FixedDraftState{
  if(!object(value)||(value.version!==1&&value.version!==2&&value.version!==3)||JSON.stringify(value).length>maxBytes)return invalid()
  if(value.version===1 && [value.images,object(value.attempt)?value.attempt.images:null].some(entries=>Array.isArray(entries)&&entries.some(entry=>Array.isArray(entry)&&object(entry[1])&&entry[1].restoreSource===true)))return invalid()
  let attempt:FixedEditAttempt|null=null
  if(value.attempt!==null){
    const sent=value.attempt
    if(!object(sent)||!string(sent.id,256)||!sent.id.startsWith('edits-')||!revision(sent.baseRevision))return invalid()
    attempt={id:sent.id,baseRevision:sent.baseRevision,texts:texts(sent.texts),images:images(sent.images)}
    if(!attempt.texts.length&&!attempt.images.length||attempt.texts.some(([,draft])=>draft.remote||draft.stale)||attempt.images.some(([,draft])=>draft.remote||draft.deleted||!validGeometry(draft.geometry)))return invalid()
  }
  return {version:3,texts:texts(value.texts),images:images(value.images),attempt,uploadInterrupted:value.uploadInterrupted===true}
}
export type FixedDraftCopy={id:string;updatedAt:number;retained:boolean;state:FixedDraftState}
/** File rescue is not subject to the IndexedDB quota. Transient rendering and
 * credential fields must not accompany a live in-memory image snapshot. */
export function serializeFixedDraft(session:Session,state:FixedDraftState,sourceHash:string){
  return JSON.stringify({schemaVersion:'hcd-fixed-recovery/1',documentId:session.documentId,source:{format:session.format,sha256:sourceHash},state},(key,value)=>{
    if(key==='preview'||key==='token'||key==='authorization')return undefined
    return typeof value==='number'&&!Number.isFinite(value)?{nonFinite:String(value)}:value
  })
}
function done(tx:IDBTransaction){return new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Device backup transaction aborted'));tx.onerror=()=>{}})}
function request<T>(req:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}

/** Fixed edits do not join a semantic Yjs epoch. Their journal is isolated by
 * authenticated user, endpoints, document and immutable source hash instead.
 * Each window writes only its own branch, including the exact pending attempt. */
export async function fixedDraftDatabase(session:Session,userId:string,sourceHash:string,base:string){
  if(!hash.test(sourceHash))throw new Error('Invalid source identity')
  const identity=await draftIdentity({...session,collaborationEpoch:0},userId,base)
  return identity.prefix.replace('hcd-local-draft-v1-','hcd-fixed-draft-v1-')+sourceHash
}
export class FixedDraftJournal {
  state:LocalDraftState='idle'
  error:unknown
  private sequence=0
  private listeners=new Set<()=>void>()
  private closed=false
  readonly branch=crypto.randomUUID()
  private constructor(private db:IDBDatabase){}
  static async open(name:string,factory:IDBFactory=indexedDB){
    const opening=factory.open(name,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('branches')
    const db=await request(opening),journal=new FixedDraftJournal(db)
    db.onversionchange=()=>{journal.changed('failed',new Error('Device backup storage changed'));journal.close()}
    return journal
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  snapshot=()=>this.state
  private changed(state:LocalDraftState,error?:unknown){this.state=state;this.error=error;this.listeners.forEach(listener=>listener())}
  async copies():Promise<FixedDraftCopy[]>{
    const tx=this.db.transaction('branches','readonly'),completion=done(tx),store=tx.objectStore('branches')
    if(await request(store.count())>maxCopies){await completion;throw new Error('Too many device copies')}
    const records:FixedDraftCopy[]=[],cursor=store.openCursor();let total=0,failure:unknown
    cursor.onsuccess=()=>{
      try{
        const next=cursor.result;if(!next)return
        const record=next.value
        if(!object(record)||!string(record.id)||!revision(record.updatedAt))return invalid()
        total+=new TextEncoder().encode(JSON.stringify(record)).byteLength;if(total>64*1024*1024)return invalid()
        records.push({id:record.id,updatedAt:record.updatedAt,retained:record.retained===true,state:validateFixedDraft(record.state)})
        next.continue()
      }catch(error){failure=error;tx.abort()}
    }
    try{await completion}catch(error){throw failure??error}
    return records.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
  }
  async retain(id:string){
    const tx=this.db.transaction('branches','readwrite'),completion=done(tx),store=tx.objectStore('branches'),record=store.get(id)
    record.onsuccess=()=>{if(record.result)store.put({...record.result,retained:true},id)}
    await completion
  }
  async write(value:FixedDraftState){
    const sequence=++this.sequence
    this.changed('writing')
    try{
      if(this.closed)throw new Error('Device journal closed')
      const state=validateFixedDraft(value)
      // Use UTF-8 bytes for the actual limit, not JS UTF-16 code-unit count.
      if(new TextEncoder().encode(JSON.stringify(state)).byteLength>maxBytes)throw new Error('Device backup exceeds byte limit')
      const tx=this.db.transaction('branches','readwrite'),completion=done(tx),store=tx.objectStore('branches')
      const empty=!state.attempt&&!state.texts.length&&!state.images.length&&!state.uploadInterrupted
      const count=store.count(),own=store.get(this.branch)
      own.onsuccess=()=>{
        if(empty){store.delete(this.branch);return}
        if(count.result>=maxCopies&&!own.result){tx.abort();return}
        store.put({id:this.branch,updatedAt:Date.now(),state},this.branch)
      }
      await completion
      if(sequence===this.sequence)this.changed('stored')
    }catch(error){if(sequence===this.sequence)this.changed('failed',error);throw error}
  }
  async flush(){const tx=this.db.transaction('branches','readwrite'),completion=done(tx);tx.objectStore('branches').count();await completion;if(this.state==='failed')throw this.error}
  close(){this.closed=true;this.db.close()}
}
