/** Device-private image choices for the semantic room. These bytes and the
 * choice-time intent capture are recovery evidence, not permission to apply. */
import {validateFixedImageChoice,type FixedImageChoice} from './fixedImageFiles.ts'
import {validateImageReplacementCapture,type ImageReplacementCapture} from './collaborativeImages.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {resourceRequest,resourceTransaction} from './nodeResourceStorage.ts'
import {withDeviceFileLock} from './regionalFileBoundary.ts'

export type SemanticImageChoice=Omit<FixedImageChoice,'phase'> & {phase:FixedImageChoice['phase']|'applying';capture:ImageReplacementCapture}
const active=(value:SemanticImageChoice)=>value.phase==='chosen'||value.phase==='staged'||value.phase==='applying'
export function validateSemanticImageChoice(value:SemanticImageChoice){
 validateFixedImageChoice({...value,phase:value.phase==='applying'?'staged':value.phase});validateImageReplacementCapture(value.capture)
 const a=value.base,b=value.capture.base
 if(value.revision!==value.capture.revision||value.page!==value.capture.page||a.nodeId!==b.nodeId||a.visualHash!==b.visualHash||(a.assetHash??null)!==(b.assetHash??null)||JSON.stringify(a.geometry)!==JSON.stringify(b.geometry))throw new Error('semantic-image-choice-invalid')
}
function identity(value:SemanticImageChoice){return JSON.stringify({id:value.id,name:value.name,extension:value.extension,hash:value.hash,base:value.base,revision:value.revision,page:value.page,capture:value.capture})}

export class SemanticImageFiles{
 private closing:Promise<void>|undefined
 private closed=false
 private publications=new Set<Promise<unknown>>()
 private constructor(readonly scope:string,private db:IDBDatabase){}
 static async open(scope:string,factory:IDBFactory=indexedDB){
  if(!/^hcd-local-draft-v1-[a-f0-9]{64}-(0|[1-9][0-9]*)-(structure3|inlinecontainers1)-nodefiles1$/.test(scope))throw new Error('semantic-image-choice-scope')
  const request=factory.open(scope+'-imagefiles1',1);request.onupgradeneeded=()=>request.result.createObjectStore('meta')
  const db=await resourceRequest(request);db.onversionchange=()=>db.close();return new SemanticImageFiles(scope,db)
 }
 private live(){if(this.closed||this.closing)throw new Error('semantic-image-choice-closed')}
 private track<T>(work:()=>Promise<T>){
  this.live();const result=work();this.publications.add(result);void result.finally(()=>this.publications.delete(result)).catch(()=>{});return result
 }
 async list(){this.live();return resourceTransaction(this.db,'readonly',async store=>{
  const values=await resourceRequest(store.getAll()) as SemanticImageChoice[],keys=await resourceRequest(store.getAllKeys());if(values.length>144)throw new Error('semantic-image-choice-limit')
  values.forEach((value,i)=>{validateSemanticImageChoice(value);if(keys[i]!==value.id)throw new Error('semantic-image-choice-invalid')});const pending=values.filter(active)
  if(pending.length>16||pending.reduce((sum,value)=>sum+value.bytes.length,0)>64*1024*1024)throw new Error('semantic-image-choice-limit');return pending
 })}
 put(input:SemanticImageChoice){
  return this.track(async()=>{const copy=structuredClone(input);validateSemanticImageChoice(copy);if(copy.phase!=='chosen'||await imageFileHash(copy.bytes)!==copy.hash)throw new Error('semantic-image-choice-integrity')
  return withDeviceFileLock(this.scope,()=>resourceTransaction(this.db,'readwrite',async store=>{
   const entries=await resourceRequest(store.getAll()) as SemanticImageChoice[],keys=await resourceRequest(store.getAllKeys());entries.forEach((value,i)=>{validateSemanticImageChoice(value);if(keys[i]!==value.id)throw new Error('semantic-image-choice-invalid')})
   if(entries.some(value=>value.id===copy.id))throw new Error('semantic-image-choice-exists')
   const pending=entries.filter(active);if(entries.length>=144||pending.length>=16||pending.reduce((sum,value)=>sum+value.bytes.length,0)+copy.bytes.length>64*1024*1024)throw new Error('semantic-image-choice-limit')
   store.add(copy,copy.id)
  }))})
 }
 /** Import a reviewed private-file batch without applying it to the document.
  * The original ID is retained, and an uncertain applying state may never be
  * downgraded to a replayable state by an older copy. A previously unseen
  * task is uncertain because it may have completed after archive export. */
 importChoices(input:readonly SemanticImageChoice[]){
  return this.track(async()=>{
   if(!Array.isArray(input)||input.length>16)throw new Error('semantic-image-choice-limit')
   const copies=input.map(value=>{const copy=structuredClone(value);validateSemanticImageChoice(copy);if(!active(copy))throw new Error('semantic-image-choice-invalid');return copy})
   if(new Set(copies.map(value=>value.id)).size!==copies.length)throw new Error('semantic-image-choice-invalid')
   for(const value of copies)if(await imageFileHash(value.bytes)!==value.hash)throw new Error('semantic-image-choice-integrity')
   return withDeviceFileLock(this.scope,()=>resourceTransaction(this.db,'readwrite',async store=>{
    const entries=await resourceRequest(store.getAll()) as SemanticImageChoice[],keys=await resourceRequest(store.getAllKeys())
    entries.forEach((value,i)=>{validateSemanticImageChoice(value);if(keys[i]!==value.id)throw new Error('semantic-image-choice-invalid')})
    const existing=new Map(entries.map(value=>[value.id,value])),added:SemanticImageChoice[]=[],upgrades:SemanticImageChoice[]=[]
    const rank={chosen:0,staged:1,applying:2} as const
    for(const copy of copies){const old=existing.get(copy.id);if(!old){added.push({...copy,phase:'applying'});continue}
     if(identity(old)!==identity(copy))throw new Error('semantic-image-choice-changed')
     if(!active(old))continue
     if(old.bytes.length!==copy.bytes.length||old.bytes.some((byte,i)=>byte!==copy.bytes[i]))throw new Error('semantic-image-choice-integrity')
     if(rank[copy.phase as keyof typeof rank]>rank[old.phase as keyof typeof rank])upgrades.push({...old,phase:copy.phase})
    }
    const pending=entries.filter(active);if(entries.length+added.length>144||pending.length+added.length>16||pending.reduce((sum,value)=>sum+value.bytes.length,0)+added.reduce((sum,value)=>sum+value.bytes.length,0)>64*1024*1024)throw new Error('semantic-image-choice-limit')
    for(const value of added)store.add(value,value.id);for(const value of upgrades)store.put(value,value.id)
    return {added:added.length,upgraded:upgrades.length}
   }))
  })
 }
 stage(input:SemanticImageChoice){
  return this.track(async()=>{const expected=structuredClone(input);validateSemanticImageChoice(expected);if(!active(expected)||await imageFileHash(expected.bytes)!==expected.hash)throw new Error('semantic-image-choice-integrity')
  return resourceTransaction(this.db,'readwrite',async store=>{
   const value=await resourceRequest(store.get(expected.id)) as SemanticImageChoice|undefined;if(!value)throw new Error('semantic-image-choice-missing');validateSemanticImageChoice(value)
   if(identity(value)!==identity(expected))throw new Error('semantic-image-choice-changed')
   if(active(value)){if(value.phase==='applying')return value;if(value.bytes.length!==expected.bytes.length||value.bytes.some((byte,i)=>byte!==expected.bytes[i]))throw new Error('semantic-image-choice-integrity');const next={...value,phase:'staged' as const};store.put(next,next.id);return next}return value
  })})
 }
 /** Record uncertainty before touching the shared CRDT. Once applying, a
  * missing intent may mean it was already saved and acknowledged; callers
  * must not blindly apply it again. */
 beginApply(expected:SemanticImageChoice){
  return this.track(async()=>{const copy=structuredClone(expected);validateSemanticImageChoice(copy);if(copy.phase!=='staged')throw new Error('semantic-image-choice-invalid')
   return resourceTransaction(this.db,'readwrite',async store=>{
    const value=await resourceRequest(store.get(copy.id)) as SemanticImageChoice|undefined;if(!value)throw new Error('semantic-image-choice-missing');validateSemanticImageChoice(value)
    if(identity(value)!==identity(copy))throw new Error('semantic-image-choice-changed')
    if(value.phase!=='staged')throw new Error('semantic-image-choice-finished')
    if(value.bytes.length!==copy.bytes.length||value.bytes.some((byte,i)=>byte!==copy.bytes[i]))throw new Error('semantic-image-choice-integrity')
    const next={...value,phase:'applying' as const};store.put(next,next.id);return next
   })
  })
 }
 finish(id:string,phase:'linked'|'cancelled'){
  return this.track(async()=>{if(!/^[a-f0-9-]{36}$/.test(id)||!['linked','cancelled'].includes(phase))throw new Error('semantic-image-choice-invalid')
  return resourceTransaction(this.db,'readwrite',async store=>{
   const value=await resourceRequest(store.get(id)) as SemanticImageChoice|undefined;if(!value)throw new Error('semantic-image-choice-missing');validateSemanticImageChoice(value)
   const result=active(value)?phase:value.phase;if(active(value))store.put({...value,phase,bytes:new Uint8Array()},id)
   const values=await resourceRequest(store.getAll()) as SemanticImageChoice[];values.forEach(validateSemanticImageChoice);const finished=values.filter(value=>!active(value));for(const entry of finished.slice(0,Math.max(0,finished.length-128)))store.delete(entry.id);return result
  })})
 }
 close(){if(this.closing)return this.closing;if(this.closed)return Promise.resolve();this.closing=(async()=>{await Promise.allSettled([...this.publications]);this.closed=true;this.db.close()})();return this.closing}
}
