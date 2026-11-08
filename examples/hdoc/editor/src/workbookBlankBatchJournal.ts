import type {Session} from './api.ts'
import {fixedDraftDatabase} from './fixedDraftJournal.ts'
import {sameBlankBatchAttempt,validateBlankBatchInput,type BlankBatchInput,type BlankBatchState,type BlankBatchStore} from './workbookBlankBatch.ts'
import {validateBlankCreateAttempt} from './workbookBlankSave.ts'

type RecordValue={id:string;state:BlankBatchState}
const done=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('blank batch journal aborted'));tx.onerror=()=>{}})
const result=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})

/** Separate per-window durable branches; no batch is merged automatically. */
export class WorkbookBlankBatchJournal{
 private constructor(private db:IDBDatabase,private session:Session,private source:string){}
 static async open(session:Session,source:string,base:string,factory:IDBFactory=indexedDB){
  if(session.format!=='xlsx'||session.scope!=='write'||!session.userId)throw new Error('blank batch authority required')
  const name=await fixedDraftDatabase(session,session.userId,source,base)+'-blank-batch-v1'
  const opening=factory.open(name,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('batches',{keyPath:'id'})
  return new WorkbookBlankBatchJournal(await result(opening),session,source)
 }
 private validate(value:unknown):BlankBatchState{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid blank batch journal')
  const state=value as BlankBatchState,input=validateBlankBatchInput(state.input,this.session,this.source),attempt=state.attempt===null?null:validateBlankCreateAttempt(state.attempt,this.session,this.source)
  if(attempt&&!sameBlankBatchAttempt(input,attempt))throw new Error('invalid blank batch journal')
  return {input,attempt}
 }
 async stage(input:BlankBatchInput):Promise<string>{
  const state:BlankBatchState={input:validateBlankBatchInput(input,this.session,this.source),attempt:null},id=crypto.randomUUID(),tx=this.db.transaction('batches','readwrite'),completion=done(tx),store=tx.objectStore('batches'),count=store.count()
  count.onsuccess=()=>{if(count.result>=64){tx.abort();return}store.add({id,state})}
  await completion;return id
 }
 async list():Promise<RecordValue[]>{
  const tx=this.db.transaction('batches','readonly'),completion=done(tx),records=await result(tx.objectStore('batches').getAll()) as RecordValue[];await completion
  if(records.length>64)throw new Error('invalid blank batch journal')
  return records.map(record=>{if(!record||typeof record.id!=='string'||!/^[a-f0-9-]{36}$/i.test(record.id))throw new Error('invalid blank batch journal');return{id:record.id,state:this.validate(record.state)}})
 }
 async import(value:BlankBatchState,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted()
  const state=this.validate(value),tx=this.db.transaction('batches','readwrite'),completion=done(tx),store=tx.objectStore('batches'),request=store.getAll();let id=''
  const abort=()=>{try{tx.abort()}catch{/* A completed transaction cannot be rolled back. */}}
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
  request.onsuccess=()=>{try{const records=request.result as RecordValue[];for(const record of records){const existing=this.validate(record.state);if(JSON.stringify(existing)===JSON.stringify(state)){id=record.id;return}if(state.attempt&&existing.attempt?.patchId===state.attempt.patchId)throw new Error('conflicting batch request')};if(records.length>=64)throw new Error('blank batch limit');id=crypto.randomUUID();store.add({id,state})}catch{tx.abort()}}
  try{await completion;return id}finally{signal?.removeEventListener('abort',abort)}
 }
 branch(id:string):BlankBatchStore{
  if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('invalid blank batch branch')
  return {
   read:async()=>{const tx=this.db.transaction('batches','readonly'),completion=done(tx),record=await result(tx.objectStore('batches').get(id)) as RecordValue|undefined;await completion;return record?this.validate(record.state):null},
   replace:async(expected,next)=>{
    const before=this.validate(expected),after=next?this.validate(next):null,tx=this.db.transaction('batches','readwrite'),completion=done(tx),store=tx.objectStore('batches'),request=store.get(id);let matched=false
    request.onsuccess=()=>{try{const record=request.result as RecordValue|undefined;if(record&&JSON.stringify(this.validate(record.state))===JSON.stringify(before)){matched=true;if(after)store.put({id,state:after});else store.delete(id)}}catch{tx.abort()}}
    await completion;return matched
   },
  }
 }
 close(){this.db.close()}
}
