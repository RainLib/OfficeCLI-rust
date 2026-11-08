import {test} from 'node:test'
import assert from 'node:assert/strict'
import {semanticImageTaskBlocked} from './semanticImageTaskBoundary.ts'
test('a newer published task cannot be masked by an older empty boundary read',async()=>{
 const state={loading:false,problem:false,running:0,choices:[] as unknown[],alive:true};let finish!:(value:boolean)=>void
 const read=new Promise<boolean>(resolve=>{finish=resolve}),check=semanticImageTaskBlocked(state,()=>true,()=>read)
 state.choices=[{id:'newer'}];finish(false);assert.equal(await check,true)
})
test('a stale runtime or failing device read cannot authorize an action',async()=>{
 const state={loading:false,problem:false,running:0,choices:[],alive:true};let finish!:(value:boolean)=>void,current=true
 const read=new Promise<boolean>(resolve=>{finish=resolve}),check=semanticImageTaskBlocked(state,()=>current,()=>read);current=false;finish(false);assert.equal(await check,true)
 assert.equal(await semanticImageTaskBlocked(state,()=>true,async()=>{throw Error('storage')}),true)
 assert.equal(await semanticImageTaskBlocked(state,()=>true,async()=>false),false)
})
