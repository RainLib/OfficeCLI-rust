import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recoveryResourceBatch} from './recoveryResourceBatch.ts'

test('external cancellation wins while an already-started transfer drains',async()=>{
 const external=new AbortController();let release!:()=>void,entered!:()=>void,failed!:()=>void,settled=false
 const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),failureObserved=new Promise<void>(resolve=>failed=resolve)
 const work=recoveryResourceBatch([async signal=>{signal.addEventListener('abort',failed,{once:true});entered();await gate},async()=>{await started;throw Error('resource failed')}],external.signal).finally(()=>{settled=true})
 await failureObserved;external.abort(new Error('user cancelled'));await Promise.resolve()
 assert.equal(settled,false);release();await assert.rejects(work,/user cancelled/)
})

test('pre-cancelled batches do not start resource work',async()=>{
 const external=new AbortController();let started=0;external.abort(new Error('cancelled before start'))
 await assert.rejects(recoveryResourceBatch([async()=>{started++}],external.signal),/cancelled before start/);assert.equal(started,0)
})

test('rolling reads fill an available slot, stay bounded and return input order',async()=>{
 const {recoveryResourcePool}=await import('./recoveryResourceBatch.ts')
 let release!:()=>void,started=0,active=0,peak=0,completed=0,ready!:()=>void,initialReady!:()=>void
 const slow=new Promise<void>(resolve=>release=resolve),laterStarted=new Promise<void>(resolve=>ready=resolve),initial=new Promise<void>(resolve=>initialReady=resolve)
 const tasks=Array.from({length:7},(_,index)=>async(signal:AbortSignal)=>{started++;active++;peak=Math.max(peak,active);if(started===4)initialReady();try{if(index===0)await slow;else if(index<4)await initial;else if(index===4)ready();signal.throwIfAborted();completed++;return index}finally{active--}})
 const work=recoveryResourcePool(tasks,new AbortController().signal)
 await laterStarted;assert.ok(started>=5);assert.equal(peak,4);assert.ok(completed>0);release()
 assert.deepEqual(await work,[0,1,2,3,4,5,6]);assert.equal(active,0)
})

test('rolling reads stop launching after failure and drain started transfers',async()=>{
 const {recoveryResourcePool}=await import('./recoveryResourceBatch.ts')
 let release!:()=>void,ready!:()=>void,started=0,drained=false
 const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>ready=resolve)
 const tasks=Array.from({length:7},(_,index)=>async(signal:AbortSignal)=>{started++;if(started===4)ready();if(index===0){await entered;throw Error('read failed')}await gate;signal.throwIfAborted();return index})
 const work=recoveryResourcePool(tasks,new AbortController().signal).finally(()=>{drained=true})
 await entered;await new Promise(resolve=>setImmediate(resolve));assert.equal(started,4);assert.equal(drained,false);release();await assert.rejects(work,/read failed/);assert.equal(started,4)
})

test('rolling reads respect external cancellation and wait for started reads',async()=>{
 const {recoveryResourcePool}=await import('./recoveryResourceBatch.ts')
 const external=new AbortController();let release!:()=>void,ready!:()=>void,started=0,done=false
 const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>ready=resolve)
 const tasks=Array.from({length:8},()=>async()=>{started++;if(started===4)ready();await gate;return started})
 const work=recoveryResourcePool(tasks,external.signal).finally(()=>{done=true})
 await entered;external.abort(new Error('cancelled by user'));await Promise.resolve();assert.equal(done,false);release();await assert.rejects(work,/cancelled by user/);assert.equal(started,4)
})
