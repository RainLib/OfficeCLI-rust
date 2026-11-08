import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import type {Session} from './api.ts'
import {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'
import {WorkbookBlankBatchJournal} from './workbookBlankBatchJournal.ts'
import {parseBlankBatchBackup} from './workbookBlankBatchBackup.ts'

const session:Session={documentId:'retry',userId:'alice',scope:'write',token:'owned-test',format:'xlsx',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),root='b'.repeat(64),sheetId='s_'+'c'.repeat(32)
const cells=[{sheetId,row:2,column:1,text:'保留甲😀'},{sheetId,row:2,column:2,text:'保留乙'}]
async function environment(work:()=>Promise<void>){
 const names=['window','navigator','indexedDB','BroadcastChannel','fetch'],originals=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const),events=new EventTarget(),held=new Set<string>()
 Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(events,{location:{href:'https://owned.test/editor'}})})
 const locks={request:async(name:string,_options:unknown,run:(lock:object|null)=>Promise<unknown>)=>{if(held.has(name))return run(null);held.add(name);try{return await run({})}finally{held.delete(name)}}}
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}})
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()})
 Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:undefined})
 globalThis.fetch=async()=>{throw Error('storage retry must never submit a server request')}
 try{await work()}finally{for(const[name,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name)}}
}
async function idle(client:WorkbookBlankBatchClient){
 if(!client.working)return
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{unsubscribe();reject(Error('batch did not settle'))},2000),unsubscribe=client.subscribe(()=>{if(!client.working){clearTimeout(timeout);unsubscribe();resolve()}})})
}

test('storage retry preserves an unstored paste after both its write and subsequent read fail',()=>environment(async()=>{
 const client=new WorkbookBlankBatchClient(session,source,()=>true),stage=WorkbookBlankBatchJournal.prototype.stage,list=WorkbookBlankBatchJournal.prototype.list
 let failRead=false,failWrite=true
 WorkbookBlankBatchJournal.prototype.stage=async function(input){if(failWrite){failRead=true;throw Error('owned device write failed')}return stage.call(this,input)}
 WorkbookBlankBatchJournal.prototype.list=async function(){if(failRead)throw Error('owned device read failed');return list.call(this)}
 try{
  await client.start();assert.equal(client.capture(cells,0,root),true);await idle(client)
  assert.equal(client.problem,true);assert.deepEqual(client.transient?.cells,cells);assert.equal(client.entries.length,0)
  const before=await client.backup(null)
  assert.equal(await client.retryStorage(),false);assert.equal(client.problem,true);assert.equal(await client.backup(null),before)
  failRead=false
  assert.equal(await client.retryStorage(),true);assert.equal(client.problem,false);assert.equal(client.loading,false)
  assert.equal(await client.backup(null),before);assert.equal(client.pending,true)
  assert.deepEqual(parseBlankBatchBackup(before,session,source,'https://owned.test/editor').input.cells,cells)
  await assert.rejects(client.withClear(async()=>{}),/pending/)
  failWrite=false;await client.persistTransient();assert.equal(client.transient,null);assert.equal(client.entries.length,1)
  const id=client.entries[0].id;client.dispose()
  const reopened=new WorkbookBlankBatchClient(session,source,()=>true)
  try{await reopened.start();assert.equal(reopened.entries[0].id,id);assert.deepEqual(reopened.entries[0].state.input.cells,cells)}finally{reopened.dispose()}
 }finally{client.dispose();WorkbookBlankBatchJournal.prototype.stage=stage;WorkbookBlankBatchJournal.prototype.list=list}
}))

test('failed initial storage open can retry in the same client without publishing an available empty state',()=>environment(async()=>{
 const client=new WorkbookBlankBatchClient(session,source,()=>true),open=WorkbookBlankBatchJournal.open;let fail=true
 WorkbookBlankBatchJournal.open=async(...args)=>{if(fail)throw Error('owned open failed');return open(...args)}
 try{
  await client.start();assert.equal(client.problem,true);assert.equal(client.pending,true)
  assert.equal(await client.retryStorage(),false);assert.equal(client.problem,true);assert.equal(client.pending,true)
  fail=false;assert.equal(await client.retryStorage(),true);assert.equal(client.problem,false);assert.equal(client.pending,false)
  assert.equal(client.capture(cells,0,root),true);await idle(client);assert.deepEqual(client.entries[0].state.input.cells,cells)
 }finally{WorkbookBlankBatchJournal.open=open;client.dispose()}
}))

test('storage retry cannot interrupt an in-flight write or recreate a disposed client',()=>environment(async()=>{
 const client=new WorkbookBlankBatchClient(session,source,()=>true),stage=WorkbookBlankBatchJournal.prototype.stage
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve)
 WorkbookBlankBatchJournal.prototype.stage=async function(input){entered();await gate;return stage.call(this,input)}
 try{
  await client.start();assert.equal(client.capture(cells,0,root),true);await started
  assert.equal(await client.retryStorage(),false);assert.deepEqual(client.transient?.cells,cells)
  release();await idle(client);assert.equal(client.entries.length,1)
  client.dispose();assert.equal(await client.retryStorage(),false)
 }finally{release();WorkbookBlankBatchJournal.prototype.stage=stage;client.dispose()}
}))
