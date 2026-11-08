import assert from 'node:assert/strict'
import {test} from 'node:test'
import {closeFixedIfSettled as closeWorkbookIfSettled} from './fixedCloseGuard.ts'

test('a new cell edit during device flush prevents closing',async()=>{
 let editing=false,closed=0,release!:()=>void,entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve})
 const flush=()=>{entered();return new Promise<void>(resolve=>{release=resolve})}
 const closing=closeWorkbookIfSettled(()=>editing,flush,()=>{closed++})
 await started;editing=true;release()
 assert.equal(await closing,'blocked');assert.equal(closed,0)
 editing=false;assert.equal(await closeWorkbookIfSettled(()=>editing,async()=>{},()=>{closed++}),'closed');assert.equal(closed,1)
})

test('an already active edit does not start a flush or close',async()=>{
 let flushed=false,closed=false
 assert.equal(await closeWorkbookIfSettled(()=>true,async()=>{flushed=true},()=>{closed=true}),'blocked')
 assert.equal(flushed,false);assert.equal(closed,false)
})

test('a failed device flush keeps the workbook open and remains retryable',async()=>{
 let closed=0
 assert.equal(await closeWorkbookIfSettled(()=>false,async()=>{throw Error('disk unavailable')},()=>{closed++}),'flush-failed')
 assert.equal(closed,0)
 assert.equal(await closeWorkbookIfSettled(()=>false,async()=>{},()=>{closed++}),'closed')
 assert.equal(closed,1)
})

test('new editing during a failed flush takes precedence over the backup error',async()=>{
 let editing=false,closed=0
 assert.equal(await closeWorkbookIfSettled(()=>editing,async()=>{editing=true;throw Error('disk unavailable')},()=>{closed++}),'blocked')
 assert.equal(closed,0)
})
