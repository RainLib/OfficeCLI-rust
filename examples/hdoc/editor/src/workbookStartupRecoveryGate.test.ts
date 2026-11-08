import {test} from 'node:test'
import assert from 'node:assert/strict'
import {withWorkbookStartupRecovery} from './workbookStartupRecoveryGate.ts'

test('startup recovery uses the locked observation and defers without locks',async()=>{
 let disposed=0,recovered=0,deferred=0
 const options={signal:new AbortController().signal,start:async()=>{},ready:()=>true,hasLocks:true,locked:async(work:(pending:boolean)=>Promise<string>)=>work(true),defer:async()=>{deferred++;return 'deferred'},recover:async()=>{recovered++;return 'recovered'},dispose:()=>{disposed++}}
 assert.equal(await withWorkbookStartupRecovery(options),'deferred');assert.equal(await withWorkbookStartupRecovery({...options,hasLocks:false}),'deferred')
 assert.equal(await withWorkbookStartupRecovery({...options,locked:async work=>work(false)}),'recovered');assert.equal(disposed,3);assert.equal(deferred,2);assert.equal(recovered,1)
})
for(const stage of ['start','lock'] as const)test(`cancelled ${stage} cannot start late startup recovery`,async()=>{
 const abort=new AbortController();let release!:()=>void,entered!:()=>void,disposed=false,sideEffects=0
 const hold=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>entered=resolve)
 const work=withWorkbookStartupRecovery({signal:abort.signal,start:async()=>{if(stage==='start'){entered();await hold}},ready:()=>true,hasLocks:true,locked:async callback=>{if(stage==='lock'){entered();await hold}return callback(false)},defer:async()=>{sideEffects++;return 'deferred'},recover:async()=>{sideEffects++;return 'recovered'},dispose:()=>{disposed=true}})
 await waiting;abort.abort(Error('cancelled'));await assert.rejects(work,/cancelled/);assert.equal(disposed,true);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sideEffects,0)
})
