import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type {Document} from '@hocuspocus/server'
import type {WordRoomBinding} from './wordRoomBinding.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {WordRoomStages} from './wordRoomStages.ts'

async function fixture(){
 const gate=new RoomMigrationGate(),stages=new WordRoomStages(),seed=new Y.Doc(),doc=new Y.Doc(),other=new Y.Doc(),journal={scope:{documentId:'doc'}}
 let valid=true,connections=0,automatic=false,frozen=0,closed=0,source=true,unloads=0,stalled=false
 const document=Object.assign(doc,{getConnectionsCount:()=>connections}) as unknown as Document
 const owner={model:{document},ownsJournal:(value:unknown)=>value===journal,isLayoutAwareLive:()=>true,isAutoSaveEnabled:()=>automatic,freeze:()=>{frozen++},enableLayoutAutoSave:(proof:()=>void)=>{proof();automatic=true}} as unknown as WordSaveCoordinator
 const binding={journal,load:async()=>seed,close:()=>{closed++;seed.destroy()}} as unknown as WordRoomBinding
 const spec={name:'room',id:'doc',operation:'word-layout-change',identity:'exact-request',gate,lease:{assert:()=>{if(!valid)throw Error('lease-lost')}},binding,assertSource:()=>{if(!source)throw Error('source-changed')}}
 const host={documents:new Map<string,Document>(),loadingDocuments:new Map<string,Promise<Document>>(),unloadingDocuments:new Map<string,Promise<void>>(),shouldUnloadDocument:()=>connections===0,unloadDocument:async(value:Document)=>{unloads++;if(stalled)return;stages.beforeUnload('room',value,owner);host.documents.delete('room');value.destroy();stages.afterUnload('room',owner)}}
 await gate.exclusive('doc',async()=>{},undefined,spec.operation,true,spec.identity,false)
 const loaded=async()=>{const context=stages.reserve(spec,host);await stages.load('room',context,document);stages.attached('room',context,document,owner);host.documents.set('room',document);return context}
 return{gate,stages,seed,document,other,owner,binding,journal,spec,host,loaded,state:()=>({automatic,frozen,closed,unloads}),authority:(value:boolean)=>{valid=value},source:(value:boolean)=>{source=value},connections:(value:number)=>{connections=value},stall:(value:boolean)=>{stalled=value},close:()=>{seed.destroy();doc.destroy();other.destroy()}}
}

test('staging requires the exact held transaction, empty host slot and correct document journal',async()=>{
 const f=await fixture()
 try{
  assert.throws(()=>f.stages.reserve({...f.spec,identity:'other'},f.host),/not-held/)
  assert.throws(()=>f.stages.reserve({...f.spec,id:'other'},f.host),/scope/)
  f.host.loadingDocuments.set('room',Promise.resolve(f.document));assert.throws(()=>f.stages.reserve(f.spec,f.host),/occupied/);f.host.loadingDocuments.clear()
  f.stages.reserve(f.spec,f.host);assert.throws(()=>f.stages.reserve(f.spec,f.host),/busy/);assert.throws(()=>f.stages.reserve({...f.spec,name:'alias'},f.host),/busy/)
  assert.equal(f.gate.blocked('doc'),true)
 }finally{f.close()}
})

test('private context cannot be reconstructed or reused for a different host document',async()=>{
 const f=await fixture()
 try{
  const context=f.stages.reserve(f.spec,f.host)
  await assert.rejects(f.stages.load('room',{},f.document),/context/);assert.throws(()=>f.stages.binding('room',JSON.parse(JSON.stringify(context))),/context/)
  await f.stages.load('room',context,f.document);await assert.rejects(f.stages.load('room',context,f.document),/already-loaded/)
  assert.throws(()=>f.stages.attached('room',context,f.other as Document,f.owner),/context/)
  assert.throws(()=>f.stages.attached('room',context,f.document,{...f.owner,isAutoSaveEnabled:()=>true} as WordSaveCoordinator),/owner/)
  f.stages.attached('room',context,f.document,f.owner);assert.throws(()=>f.stages.assertInstalled('room',f.owner,f.host),/not-installed/)
  f.host.documents.set('room',f.document);f.stages.assertInstalled('room',f.owner,f.host)
  assert.throws(()=>f.stages.activate('room',f.owner,f.host),/not-released/);assert.equal(f.state().automatic,false)
  f.gate.release('doc',f.spec.operation);f.stages.activate('room',f.owner,f.host);assert.equal(f.state().automatic,true);assert.equal(f.stages.has('room'),false)
 }finally{f.close()}
})

test('staged documents cannot unload without rollback permission, exact owner and zero connections',async()=>{
 const f=await fixture()
 try{
  await f.loaded();assert.throws(()=>f.stages.beforeUnload('room',f.document,f.owner),/unload-denied/);assert.throws(()=>f.stages.afterUnload('room',f.owner),/unload-denied/)
  f.connections(1);await assert.rejects(f.stages.rollback('room',f.host,()=>{}),/unload-denied/);assert.equal(f.state().unloads,0);assert.equal(f.stages.has('room'),true)
  f.connections(0);let removed=0;await f.stages.rollback('room',f.host,()=>{removed++});assert.equal(removed,1);assert.equal(f.host.documents.size,0);assert.equal(f.document.isDestroyed,true);assert.equal(f.state().automatic,false);assert.equal(f.stages.has('room'),false);assert.equal(f.gate.blocked('doc'),true)
 }finally{f.close()}
})

test('an incomplete unload retains its permit and is retried before a new stage can reserve the slot',async()=>{
 const f=await fixture()
 try{
  await f.loaded();f.stall(true);let removed=0
  await assert.rejects(f.stages.rollback('room',f.host,()=>{removed++}),/uncertain/);assert.equal(removed,0);assert.equal(f.stages.has('room'),true);assert.throws(()=>f.stages.reserve(f.spec,f.host),/busy/)
  f.stall(false);await f.stages.rollback('room',f.host,()=>{removed++});assert.equal(f.state().unloads,2);assert.equal(removed,1);assert.equal(f.stages.has('room'),false);assert.equal(f.gate.blocked('doc'),true)
 }finally{f.close()}
})

test('unload timeout retains the permit and retries observe the same in-flight host operation',async()=>{
 const f=await fixture();let finish!:()=>void,calls=0
 const waiting=new Promise<void>(resolve=>{finish=resolve}),keepAlive=setTimeout(()=>{},1000)
 try{
  await f.loaded()
  f.host.unloadDocument=async document=>{
   const active=f.host.unloadingDocuments.get('room');if(active)return active
   calls++;f.stages.beforeUnload('room',document,f.owner)
   const work=waiting.then(()=>{f.host.documents.delete('room');document.destroy();f.stages.afterUnload('room',f.owner)}).finally(()=>{f.host.unloadingDocuments.delete('room')})
   f.host.unloadingDocuments.set('room',work);return work
  }
  await assert.rejects(f.stages.rollback('room',f.host,()=>{},20),/timeout/i);assert.equal(f.stages.has('room'),true);assert.equal(f.document.isDestroyed,false);assert.equal(f.gate.blocked('doc'),true)
  const retry=f.stages.rollback('room',f.host,()=>{});finish();await retry
  assert.equal(calls,1);assert.equal(f.document.isDestroyed,true);assert.equal(f.stages.has('room'),false);assert.equal(f.gate.blocked('doc'),true)
 }finally{clearTimeout(keepAlive);finish();f.close()}
})

test('a partial load is cleaned only after the host loading promise has settled',async()=>{
 const f=await fixture()
 try{
  const context=f.stages.reserve(f.spec,f.host);await f.stages.load('room',context,f.document);f.host.loadingDocuments.set('room',Promise.resolve(f.document))
  await assert.rejects(f.stages.rollback('room',f.host,()=>{}),/loading/);assert.equal(f.document.isDestroyed,false);assert.equal(f.state().closed,0)
  f.host.loadingDocuments.clear();await f.stages.rollback('room',f.host,()=>{});assert.equal(f.document.isDestroyed,true);assert.equal(f.state().closed,1);assert.equal(f.state().unloads,0)
 }finally{f.close()}
})

test('registry cleanup failures preserve the exact stage even after its document was removed',async()=>{
 const f=await fixture()
 try{
  await f.loaded();await assert.rejects(f.stages.rollback('room',f.host,()=>{throw Error('registry-cleanup-failed')}),/registry-cleanup-failed/)
  assert.equal(f.document.isDestroyed,true);assert.equal(f.stages.has('room'),true);let removed=0
  await f.stages.rollback('room',f.host,()=>{removed++});assert.equal(removed,1);assert.equal(f.state().unloads,1);assert.equal(f.stages.has('room'),false)
 }finally{f.close()}
})

test('lease and source changes fence staged load, installation and cleanup without releasing admission',async()=>{
 const f=await fixture()
 try{
  const context=await f.loaded();f.authority(false);assert.throws(()=>f.stages.binding('room',context),/lease-lost/);await assert.rejects(f.stages.rollback('room',f.host,()=>{}),/lease-lost/)
  f.authority(true);f.source(false);assert.throws(()=>f.stages.assertInstalled('room',f.owner,f.host),/source-changed/)
  assert.equal(f.stages.has('room'),true);assert.equal(f.document.isDestroyed,false);assert.equal(f.gate.blocked('doc'),true);assert.equal(f.state().automatic,false)
  f.source(true);await f.stages.rollback('room',f.host,()=>{})
 }finally{f.close()}
})

test('asynchronous source assertions cannot reserve a stage or acknowledge registry removal',async()=>{
 const f=await fixture()
 try{
  assert.throws(()=>f.stages.reserve({...f.spec,assertSource:async()=>{throw Error('later-denial')}},f.host),/proof-must-be-synchronous/);assert.equal(f.stages.has('room'),false)
  await f.loaded();await assert.rejects(f.stages.rollback('room',f.host,async()=>{}),/proof-must-be-synchronous/);assert.equal(f.stages.has('room'),true)
  await f.stages.rollback('room',f.host,()=>{});assert.equal(f.stages.has('room'),false)
 }finally{f.close()}
})
