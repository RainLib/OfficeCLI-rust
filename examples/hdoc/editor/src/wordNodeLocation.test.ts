import assert from 'node:assert/strict'
import {test} from 'node:test'
import {waitForWordNode} from './wordNodeLocation.ts'

test('location waits for the regional projection and does not recurse on its own selection transaction',()=>{
 let exists=true,ready=false,located=0,missing=0
 const listeners=new Set<()=>void>(),emit=()=>{for(const listener of listeners)listener()}
 const stop=waitForWordNode({exists:()=>exists,locate:()=>{if(!ready)return false;located++;emit();return true},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},missing:()=>missing++})
 for(let i=0;i<30;i++)emit()
 assert.equal(located,0);assert.equal(listeners.size,1)
 ready=true;emit();assert.equal(located,1);assert.equal(missing,0);assert.equal(listeners.size,0)
 exists=false;emit();stop();assert.equal(missing,0)
})

test('deleted target is reported once and cancellation removes the listener',()=>{
 let exists=true,missing=0
 const listeners=new Set<()=>void>(),emit=()=>{for(const listener of listeners)listener()}
 const create=()=>waitForWordNode({exists:()=>exists,locate:()=>false,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},missing:()=>missing++})
 const stop=create();exists=false;emit();emit();assert.equal(missing,1);assert.equal(listeners.size,0);stop()
 exists=true;const cancel=create();cancel();exists=false;emit();assert.equal(missing,1);assert.equal(listeners.size,0)
})

test('synchronous subscription completion removes its listener',()=>{
 let removed=0
 waitForWordNode({exists:()=>false,locate:()=>false,subscribe:listener=>{listener();return()=>removed++},missing:()=>{}})
 assert.equal(removed,1)
})
