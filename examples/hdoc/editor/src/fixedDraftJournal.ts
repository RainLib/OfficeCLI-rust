import {draftNamespace,type LocalDraftState} from './localDrafts.ts'
import type {Session} from './api.ts'
import {validGeometry,type ImageDraft,type ImageField} from './imageDrafts.ts'
import type {TextDraft,TextRun} from './textDrafts.ts'
import type {FixedDraftState,WorkbookInputBuffer} from './fixedSaveController.ts'
import type {FixedEditAttempt} from './saveEdits.ts'
import {validateBlankCreateAttempt} from './workbookBlankSave.ts'
import {validateWorkbookBlankInput} from './workbookBlankInput.ts'

const maxBytes=8*1024*1024,maxCopies=64
// A portable file includes identity and source metadata in addition to the journal.
export const fixedDraftBackupLimit=16*1024*1024
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
  if(!object(value)||(value.version!==1&&value.version!==2&&value.version!==3&&value.version!==4&&value.version!==5&&value.version!==6)||JSON.stringify(value).length>maxBytes)return invalid()
  let workbookBuffer:WorkbookInputBuffer|undefined
  if(value.version===4||(value.version===5||value.version===6)&&value.workbookBuffer!==undefined){
    const buffer=value.workbookBuffer
    if(!object(buffer)||!revision(buffer.revision)||!string(buffer.sheetId)||(buffer.sheetName!==undefined&&!string(buffer.sheetName))||!revision(buffer.row)||Number(buffer.row)>1_048_575||!revision(buffer.column)||Number(buffer.column)>16_383||typeof buffer.initial!=='string'||typeof buffer.text!=='string'||buffer.initial.length>1_000_000||buffer.text.length>1_000_000)return invalid()
    workbookBuffer={base:textRun(buffer.base),revision:buffer.revision,initial:buffer.initial,text:buffer.text,sheetId:buffer.sheetId,...(typeof buffer.sheetName==='string'?{sheetName:buffer.sheetName}:{}),row:buffer.row,column:buffer.column}
  }else if(value.workbookBuffer!==undefined)return invalid()
  let blankAttempt:FixedDraftState['blankAttempt']
  if(value.version===5||value.version===6&&value.blankAttempt!==undefined){
    const blank=value.blankAttempt
    if(!object(blank)||typeof blank.documentId!=='string'||!string(blank.documentId,128)||typeof blank.sourceSha256!=='string')return invalid()
    try{blankAttempt=validateBlankCreateAttempt(blank,{documentId:blank.documentId,format:'xlsx',scope:'write',token:''},blank.sourceSha256)}catch{return invalid()}
  }else if(value.blankAttempt!==undefined)return invalid()
  let blankInput:FixedDraftState['blankInput']
  if(value.version===6){
    const blank=value.blankInput
    if(!object(blank)||typeof blank.documentId!=='string'||!string(blank.documentId,128)||typeof blank.sourceSha256!=='string')return invalid()
    try{blankInput=validateWorkbookBlankInput(blank,{documentId:blank.documentId,format:'xlsx',scope:'write',token:''},blank.sourceSha256)}catch{return invalid()}
  }else if(value.blankInput!==undefined)return invalid()
  if(value.version===1 && [value.images,object(value.attempt)?value.attempt.images:null].some(entries=>Array.isArray(entries)&&entries.some(entry=>Array.isArray(entry)&&object(entry[1])&&entry[1].restoreSource===true)))return invalid()
  let attempt:FixedEditAttempt|null=null
  if(value.attempt!==null){
    const sent=value.attempt
    if(!object(sent)||!string(sent.id,256)||!sent.id.startsWith('edits-')||!revision(sent.baseRevision))return invalid()
    attempt={id:sent.id,baseRevision:sent.baseRevision,texts:texts(sent.texts),images:images(sent.images)}
    if(!attempt.texts.length&&!attempt.images.length||attempt.texts.some(([,draft])=>draft.remote||draft.stale)||attempt.images.some(([,draft])=>draft.remote||draft.deleted||!validGeometry(draft.geometry)))return invalid()
  }
  return {version:blankInput?6:blankAttempt?5:workbookBuffer?4:3,texts:texts(value.texts),images:images(value.images),attempt,uploadInterrupted:value.uploadInterrupted===true,...(workbookBuffer?{workbookBuffer}:{}),...(blankAttempt?{blankAttempt}:{}),...(blankInput?{blankInput}:{})}
}
export type FixedDraftCopy={id:string;updatedAt:number;retained:boolean;state:FixedDraftState;reviewGeneration:string|null}
/** File rescue is not subject to the IndexedDB quota. Transient rendering and
 * credential fields must not accompany a live in-memory image snapshot. */
function backupService(session:Session,base:string){const url=new URL(session.apiUrl||'/v1/documents',base);if(url.username||url.password||url.search||url.hash)throw new Error('Invalid backup service');return url.href.replace(/\/$/,'')}
export function serializeFixedDraft(session:Session,state:FixedDraftState,sourceHash:string,base=globalThis.location?.href??'http://localhost/'){
  return JSON.stringify({schemaVersion:session.userId?'hcd-fixed-recovery/2':'hcd-fixed-recovery/1',documentId:session.documentId,source:{format:session.format,sha256:sourceHash},...(session.userId?{owner:session.userId,service:backupService(session,base)}:{}),state},(key,value)=>{
    if(key==='preview'||key==='token'||key==='authorization')return undefined
    return typeof value==='number'&&!Number.isFinite(value)?{nonFinite:String(value)}:value
  })
}
/** Importing a backup does not authenticate its contents. Only the current
 * authorized document may review it, and the normal receipt/CAS path remains
 * responsible for any later submission. Legacy files with unknown attempts
 * cannot establish their original member and service. */
export function parseFixedDraftBackup(raw:string,session:Session,sourceHash:string,base:string){
 if(raw.length>fixedDraftBackupLimit||new TextEncoder().encode(raw).byteLength>fixedDraftBackupLimit)throw new Error('Invalid fixed draft backup')
 let value:unknown;try{value=JSON.parse(raw)}catch{return invalid()}
 if(!object(value)||!object(value.source)||value.documentId!==session.documentId||value.source.format!==session.format||value.source.sha256!==sourceHash||!session.userId)return invalid()
 if(value.schemaVersion==='hcd-fixed-recovery/2'){if(value.owner!==session.userId||value.service!==backupService(session,base))return invalid()}
 else if(value.schemaVersion!=='hcd-fixed-recovery/1')return invalid()
 const state=validateFixedDraft(value.state)
 if(value.schemaVersion==='hcd-fixed-recovery/1'&&(state.attempt||state.blankAttempt||state.blankInput))return invalid()
 if((state.workbookBuffer||state.blankAttempt||state.blankInput)&&session.format!=='xlsx')return invalid()
 if(state.blankAttempt)try{validateBlankCreateAttempt(state.blankAttempt,session,sourceHash)}catch{return invalid()}
 if(state.blankInput)try{validateWorkbookBlankInput(state.blankInput,session,sourceHash)}catch{return invalid()}
 if(session.format==='xlsx'&&(state.images.length||state.attempt?.images.length||state.uploadInterrupted))return invalid()
 return state
}
function done(tx:IDBTransaction){return new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('Device backup transaction aborted'));tx.onerror=()=>{}})}
function request<T>(req:IDBRequest<T>){return new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
/** Cancel an uncommitted import transaction when its editor session ends. */
async function importTransaction<T>(tx:IDBTransaction,signal:AbortSignal|undefined,work:()=>Promise<T>){
 const completion=done(tx),stop=()=>{try{tx.abort()}catch{/* already committed */}}
 signal?.addEventListener('abort',stop,{once:true})
 try{signal?.throwIfAborted();const result=await work();signal?.throwIfAborted();await completion;return result}
 catch(error){stop();await completion.catch(()=>{});signal?.throwIfAborted();throw error}
 finally{signal?.removeEventListener('abort',stop)}
}

/** A remote refresh is not new local input. Keep an explicitly reviewed copy
 * retained until its owning window changes its actual intent or request. */
function localIntent(state:FixedDraftState){return JSON.stringify({
 texts:state.texts.map(([id,draft])=>[id,{base:draft.base,text:draft.text}]).sort(([a],[b])=>String(a).localeCompare(String(b))),
 images:state.images.map(([id,draft])=>[id,{base:draft.base,geometry:draft.geometry,assetHash:draft.assetHash,restoreSource:draft.restoreSource,touched:draft.touched}]).sort(([a],[b])=>String(a).localeCompare(String(b))),
 attempt:state.attempt,uploadInterrupted:state.uploadInterrupted===true,workbookBuffer:state.workbookBuffer,blankAttempt:state.blankAttempt,blankInput:state.blankInput,
})}
async function intentHash(state:FixedDraftState){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(localIntent(state)))),byte=>byte.toString(16).padStart(2,'0')).join('')}

/** Fixed edits do not join a semantic Yjs epoch. Their journal is isolated by
 * authenticated user, endpoints, document and immutable source hash instead.
 * Each window writes only its own branch, including the exact pending attempt. */
export async function fixedDraftDatabase(session:Session,userId:string,sourceHash:string,base:string){
  if(!hash.test(sourceHash))throw new Error('Invalid source identity')
  const identity=await draftNamespace({...session,collaborationEpoch:0},userId,base)
  return identity.prefix.replace('hcd-local-draft-v1-','hcd-fixed-draft-v1-')+sourceHash
}
export class FixedDraftJournal {
  state:LocalDraftState='idle'
  error:unknown
  private sequence=0
  private writes:Promise<void>=Promise.resolve()
  private listeners=new Set<()=>void>()
  private closed=false
  readonly branch=crypto.randomUUID()
  private constructor(private db:IDBDatabase){}
  static async open(name:string,factory:IDBFactory=indexedDB){
    const opening=factory.open(name,2);opening.onupgradeneeded=()=>{if(!opening.result.objectStoreNames.contains('branches'))opening.result.createObjectStore('branches');if(!opening.result.objectStoreNames.contains('reviews'))opening.result.createObjectStore('reviews')}
    const db=await request(opening),journal=new FixedDraftJournal(db)
    db.onversionchange=()=>{journal.changed('failed',new Error('Device backup storage changed'));journal.close()}
    return journal
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  snapshot=()=>this.state
  private changed(state:LocalDraftState,error?:unknown){this.state=state;this.error=error;this.listeners.forEach(listener=>listener())}
  async copies():Promise<FixedDraftCopy[]>{
    const tx=this.db.transaction(['branches','reviews'],'readonly'),completion=done(tx),store=tx.objectStore('branches'),reviews=await request(tx.objectStore('reviews').getAll()) as Array<{id:string;hash:string}>
    if(reviews.length>maxCopies||reviews.some(value=>!object(value)||!string(value.id)||typeof value.hash!=='string'||!hash.test(value.hash))){await completion;throw new Error('Invalid device copy review')}
    if(await request(store.count())>maxCopies){await completion;throw new Error('Too many device copies')}
    const records:FixedDraftCopy[]=[],cursor=store.openCursor();let total=0,failure:unknown
    cursor.onsuccess=()=>{
      try{
        const next=cursor.result;if(!next)return
        const record=next.value
        if(!object(record)||!string(record.id)||!revision(record.updatedAt)||(record.reviewGeneration!==undefined&&!string(record.reviewGeneration,128)))return invalid()
        total+=new TextEncoder().encode(JSON.stringify(record)).byteLength;if(total>64*1024*1024)return invalid()
        records.push({id:record.id,updatedAt:record.updatedAt,retained:record.retained===true,state:validateFixedDraft(record.state),reviewGeneration:typeof record.reviewGeneration==='string'?record.reviewGeneration:null})
        next.continue()
      }catch(error){failure=error;tx.abort()}
    }
    try{await completion}catch(error){throw failure??error}
    const reviewed=new Map(reviews.map(value=>[value.id,value.hash]))
    for(const record of records)if(reviewed.has(record.id))record.retained=reviewed.get(record.id)===await intentHash(record.state)
    return records.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
  }
  async retain(id:string,expected?:FixedDraftState,expectedGeneration?:string|null){
    const read=this.db.transaction('branches','readonly'),readDone=done(read),captured=await request(read.objectStore('branches').get(id));await readDone
    if(!captured||(expectedGeneration!==undefined&&(captured.reviewGeneration??null)!==expectedGeneration))return
    const generation=captured.reviewGeneration??null
    const state=validateFixedDraft(expected??captured.state),signature=localIntent(state),digest=await intentHash(state)
    const tx=this.db.transaction(['branches','reviews'],'readwrite'),completion=done(tx),store=tx.objectStore('branches'),record=store.get(id)
    record.onsuccess=()=>{if(record.result&&(record.result.reviewGeneration??null)===generation&&localIntent(validateFixedDraft(record.result.state))===signature){store.put({...record.result,retained:true},id);tx.objectStore('reviews').put({id,hash:digest},id)}}
    await completion
  }
  /** Deduplicate a standalone backup by its validated content, independent of
   * JSON whitespace and token rotation. The domain separates portable archives. */
  async importBackupCopy(value:FixedDraftState,reopen=false,signal?:AbortSignal){
    signal?.throwIfAborted()
    const state=validateFixedDraft(structuredClone(value)),serialized=JSON.stringify(state)
    const bytes=new TextEncoder().encode('hcd-fixed-backup-import/1\0'+serialized)
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('')
    signal?.throwIfAborted()
    const created=await this.importCopy(digest,state,signal)
    if(!reopen||created)return created
    // Explicitly request a new comparison; never replace another branch or
    // clear a review marker if the saved contents changed after import.
    signal?.throwIfAborted()
    const id=`portable-${digest}`,tx=this.db.transaction(['branches','reviews'],'readwrite'),store=tx.objectStore('branches')
    return importTransaction(tx,signal,async()=>{
      const existing=await request(store.get(id));signal?.throwIfAborted()
      if(!object(existing)||existing.id!==id||JSON.stringify(validateFixedDraft(existing.state))!==serialized)throw new Error('Portable import branch changed')
      store.put({...existing,retained:false,reviewGeneration:crypto.randomUUID()},id);tx.objectStore('reviews').delete(id);return true
    })
  }
  /** A portable import has a stable branch identity. Replaying an interrupted
   * import cannot create duplicates, replace a different branch, or undo a
   * user's retain/review decision. */
  async importCopy(archiveHash:string,value:FixedDraftState,signal?:AbortSignal){
    signal?.throwIfAborted()
    if(!hash.test(archiveHash))throw new Error('Invalid portable import identity')
    const state=validateFixedDraft(structuredClone(value)),serialized=JSON.stringify(state)
    if(new TextEncoder().encode(serialized).byteLength>maxBytes)throw new Error('Device backup exceeds byte limit')
    if(!state.attempt&&!state.texts.length&&!state.images.length&&!state.uploadInterrupted&&!state.workbookBuffer&&!state.blankAttempt&&!state.blankInput)return false
    const id=`portable-${archiveHash}`,tx=this.db.transaction('branches','readwrite'),store=tx.objectStore('branches')
    return importTransaction(tx,signal,async()=>{
      const count=await request(store.count()),existing=await request(store.get(id));signal?.throwIfAborted()
      if(existing){
        if(!object(existing)||existing.id!==id||JSON.stringify(validateFixedDraft(existing.state))!==serialized)throw new Error('Portable import branch changed')
        return false
      }
      if(count>=maxCopies)throw new Error('Too many device copies')
      store.add({id,updatedAt:Date.now(),state,retained:false},id);return true
    })
  }
  write(value:FixedDraftState){
    const sequence=++this.sequence
    this.changed('writing')
    let captured:FixedDraftState
    try{captured=structuredClone(value)}catch(error){this.changed('failed',error);return Promise.reject(error)}
    const work=this.writes.then(async()=>{
    try{
      if(this.closed)throw new Error('Device journal closed')
      const state=validateFixedDraft(captured)
      // Use UTF-8 bytes for the actual limit, not JS UTF-16 code-unit count.
      if(new TextEncoder().encode(JSON.stringify(state)).byteLength>maxBytes)throw new Error('Device backup exceeds byte limit')
      const digest=await intentHash(state)
      const tx=this.db.transaction(['branches','reviews'],'readwrite'),completion=done(tx),store=tx.objectStore('branches')
      const empty=!state.attempt&&!state.texts.length&&!state.images.length&&!state.uploadInterrupted&&!state.workbookBuffer&&!state.blankAttempt&&!state.blankInput
      const count=store.count(),review=tx.objectStore('reviews').get(this.branch),own=store.get(this.branch)
      let failure:unknown
      own.onsuccess=()=>{
        try{
          if(empty){store.delete(this.branch);tx.objectStore('reviews').delete(this.branch);return}
          if(count.result>=maxCopies&&!own.result){tx.abort();return}
          const retained=review.result?review.result.hash===digest:own.result?.retained===true&&localIntent(validateFixedDraft(own.result.state))===localIntent(state)
          store.put({id:this.branch,updatedAt:Date.now(),state,retained},this.branch)
        }catch(error){failure=error;tx.abort()}
      }
      try{await completion}catch(error){throw failure??error}
      if(sequence===this.sequence)this.changed('stored')
    }catch(error){if(sequence===this.sequence)this.changed('failed',error);throw error}
    })
    this.writes=work.catch(()=>{});return work
  }
  async flush(){await this.writes;const tx=this.db.transaction('branches','readwrite'),completion=done(tx);tx.objectStore('branches').count();await completion;if(this.state==='failed')throw this.error}
  close(){this.closed=true;this.db.close()}
}
