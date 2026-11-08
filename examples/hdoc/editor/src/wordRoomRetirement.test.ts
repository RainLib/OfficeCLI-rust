import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type {Document} from '@hocuspocus/server'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {RoomMigrationGate,MigrationUncertain} from './roomMigrationGate.ts'
import {retireWordRoom,WordRoomRetirements} from './wordRoomRetirement.ts'

test('only the exact fenced, disconnected Word owner can retain its lease through retirement',async()=>{
 const doc=new Y.Doc(),other=new Y.Doc(),gate=new RoomMigrationGate(),registry=new WordRoomRetirements();let connections=1,validLease=true
 const document=Object.assign(doc,{getConnectionsCount:()=>connections}) as unknown as Document,otherDocument=Object.assign(other,{getConnectionsCount:()=>0}) as unknown as Document
 let durable=true,tip='a'.repeat(64),hashes=['none',tip];const journal={load:async()=>({hash:tip}),knownHashes:()=>hashes} as unknown as WordCheckpointJournal
 const owner={model:{document},isTopologySealed:()=>true,ownsJournal:(value:unknown)=>value===journal,heldSnapshotRecorded:()=>durable,assertTopologyHeld:()=>{}} as unknown as WordSaveCoordinator,lease={assert:()=>{if(!validLease)throw Error('lease-lost')},headers:()=>({'X-HCD-Word-Journal-Hash':tip})}
 try{
  await assert.rejects(registry.reserve('room','doc','word-layout-change',document,owner,gate,lease,journal),/not-ready/)
  await assert.rejects(gate.exclusive('doc',async()=>{throw new MigrationUncertain()},undefined,'word-layout-change'),/outcome-unknown/)
  await assert.rejects(registry.reserve('room','doc','word-layout-change',document,owner,gate,lease,journal),/not-ready/);connections=0;durable=false;await assert.rejects(registry.reserve('room','doc','word-layout-change',document,owner,gate,lease,journal),/not-durable/);durable=true;await registry.reserve('room','doc','word-layout-change',document,owner,gate,lease,journal)
  await assert.rejects(registry.reserve('room','doc','word-layout-change',document,owner,gate,lease,journal),/busy/);assert.throws(()=>registry.before('room',otherDocument,owner),/changed/);assert.throws(()=>registry.finish('room',owner),/changed/)
  tip='b'.repeat(64);assert.throws(()=>registry.before('room',document,owner),/changed/);tip='a'.repeat(64)
  assert.equal(registry.before('room',document,owner),true);assert.throws(()=>registry.cancel('room'),/in-progress/);validLease=false;assert.throws(()=>registry.finish('room',owner),/lease-lost/);validLease=true
  assert.equal(registry.finish('room',owner),true);assert.equal(registry.retired('room',owner,gate,journal),true);tip='c'.repeat(64);hashes=['none','a'.repeat(64),tip];assert.equal(registry.retired('room',owner,gate,journal),true);hashes=['none',tip];assert.throws(()=>registry.retired('room',owner,gate,journal),/changed/);assert.equal(registry.finish('room',owner),false);assert.equal(gate.blocked('doc'),true);registry.forgetRetired('room',owner,gate,journal);assert.equal(registry.retired('room',owner,gate,journal),false)
 }finally{doc.destroy();other.destroy()}
})

test('retirement timeout never reopens admission or forgets an uncertain unload permit',async()=>{
 const doc=new Y.Doc(),gate=new RoomMigrationGate(),registry=new WordRoomRetirements(),tip='a'.repeat(64)
 const document=Object.assign(doc,{getConnectionsCount:()=>0}) as unknown as Document,journal={load:async()=>({hash:tip})} as unknown as WordCheckpointJournal
 const owner={model:{document},isTopologySealed:()=>true,ownsJournal:(value:unknown)=>value===journal,heldSnapshotRecorded:()=>true,assertTopologyHeld:()=>{}} as unknown as WordSaveCoordinator
 const lease={assert:()=>{},headers:()=>({'X-HCD-Word-Journal-Hash':tip})};let closed=0
 const host={documents:new Map([['room',document]]),closeConnections:()=>{closed++},shouldUnloadDocument:()=>true,unloadDocument:async()=>new Promise<void>(()=>{})}
 try{
  await assert.rejects(gate.exclusive('doc',async()=>{throw new MigrationUncertain()},undefined,'word-layout-change'),/outcome-unknown/)
  const keepAlive=setTimeout(()=>{},1000)
  try{await assert.rejects(retireWordRoom({host,registry,name:'room',id:'doc',operation:'word-layout-change',owner,gate,lease,journal,timeoutMs:20}),/outcome-unknown/)}finally{clearTimeout(keepAlive)}
  assert.equal(closed,1);assert.equal(registry.has('room'),true);assert.equal(gate.blocked('doc'),true);assert.throws(()=>gate.enter('doc'))
 }finally{doc.destroy()}
})

test('a stalled journal read respects the retirement deadline and cannot create a late unload permit',async()=>{
 const doc=new Y.Doc(),gate=new RoomMigrationGate(),registry=new WordRoomRetirements(),tip='a'.repeat(64)
 const document=Object.assign(doc,{getConnectionsCount:()=>0}) as unknown as Document
 let complete!:(value:{hash:string})=>void,started!:()=>void,unloads=0
 const entered=new Promise<void>(resolve=>{started=resolve}),journal={load:()=>{started();return new Promise<{hash:string}>(resolve=>{complete=resolve})}} as unknown as WordCheckpointJournal
 const owner={model:{document},isTopologySealed:()=>true,ownsJournal:(value:unknown)=>value===journal,heldSnapshotRecorded:()=>true,assertTopologyHeld:()=>{}} as unknown as WordSaveCoordinator
 const lease={assert:()=>{},headers:()=>({'X-HCD-Word-Journal-Hash':tip})},host={documents:new Map([['room',document]]),closeConnections:()=>{},shouldUnloadDocument:()=>true,unloadDocument:async()=>{unloads++}}
 try{
  await assert.rejects(gate.exclusive('doc',async()=>{throw new MigrationUncertain()},undefined,'word-layout-change'),/outcome-unknown/)
  const operation=retireWordRoom({host,registry,name:'room',id:'doc',operation:'word-layout-change',owner,gate,lease,journal,timeoutMs:20});await entered
  await assert.rejects(operation,/word-retirement-timeout/);complete({hash:tip});await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(registry.has('room'),false);assert.equal(unloads,0);assert.equal(gate.blocked('doc'),true)
 }finally{doc.destroy()}
})
