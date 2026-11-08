import {test} from 'node:test'
import assert from 'node:assert/strict'
import {watchSemanticOutline} from './semanticOutlineWatch.ts'

test('visible outline coalesces changes and refreshes from the latest state',()=>{
 let listener:(()=>void)|undefined,next=0,reads=0,doc='initial',display='',frames=new Map<number,()=>void>()
 const source={on:(_:'update',fn:()=>void)=>{listener=fn},off:(_:'update',fn:()=>void)=>{if(listener===fn)listener=undefined}},schedule=(fn:()=>void)=>{const id=++next;frames.set(id,fn);return id},cancel=(id:number)=>{frames.delete(id)},flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn())}
 const stop=watchSemanticOutline(source,()=>{reads++;display=doc},schedule,cancel)
 doc='first';listener!();doc='latest';listener!();assert.equal(frames.size,1);flush();assert.equal(reads,1);assert.equal(display,'latest')
 listener!();stop();assert.equal(frames.size,0);assert.equal(listener,undefined);flush();assert.equal(reads,1)
 doc='reopened';const stopAgain=watchSemanticOutline(source,()=>{reads++;display=doc},schedule,cancel);flush();assert.equal(display,'reopened');assert.equal(reads,2);stopAgain()
})
