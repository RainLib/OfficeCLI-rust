import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readStructureViewport,viewportFollowCycle,selectViewportConnections,structureViewportField,ViewportFollowIntent} from './collaborationViewport.ts'
test('viewport awareness accepts only bounded positions and finite progress',()=>{
 const value={version:1,owner:'one-window',progress:0.4,anchor:{key:'block',offset:2,relative:{type:{client:1,clock:2},item:null,assoc:0}}}
 assert.deepEqual(readStructureViewport(value),value)
 for(const progress of [-1,2,NaN,Infinity,'0.5'])assert.equal(readStructureViewport({...value,progress}),null)
 for(const anchor of [{key:'',offset:0},{key:'x',offset:-1},{key:'x',offset:1,relative:{tname:'arbitrary-map'}},{key:'x',offset:1,relative:{type:{client:'1',clock:0}}}])assert.equal(readStructureViewport({...value,anchor}),null)
 assert.equal(readStructureViewport({...value,owner:'x'.repeat(65)}),null);assert.equal(readStructureViewport({...value,anchor:null})?.anchor,null)
 const cyclic:any={};cyclic.anchor=cyclic;assert.equal(readStructureViewport(cyclic),null)
})

test('mutual and indirect follow loops are refused while a departed peer ends the chain',()=>{
 const viewport=(following?:number)=>({[structureViewportField]:{version:1,owner:'window',progress:0,anchor:null,...(following===undefined?{}:{following})}})
 assert.equal(viewportFollowCycle(new Map([[2,viewport(1)]]),1,2),true)
 assert.equal(viewportFollowCycle(new Map([[2,viewport(3)],[3,viewport(1)]]),1,2),true)
 assert.equal(viewportFollowCycle(new Map([[2,viewport(3)],[3,viewport(2)]]),1,2),true)
 assert.equal(viewportFollowCycle(new Map([[2,viewport(3)]]),1,2),false)
 assert.equal(viewportFollowCycle(new Map([[2,viewport()]]),1,2),false)
 assert.equal(readStructureViewport({...viewport()[structureViewportField],following:'2'}),null)
})

test('a member with multiple windows keeps the followed connection when another window appears',()=>{
 const existing={client:50,id:'bob',viewport:'reading later pages'},other={client:2,id:'bob',viewport:'at the beginning'},alice={client:9,id:'alice'}
 assert.deepEqual(selectViewportConnections([existing,alice],50),[existing,alice])
 assert.deepEqual(selectViewportConnections([other,alice,existing],50),[existing,alice])
 assert.deepEqual(selectViewportConnections([existing,other,alice],50),[existing,alice])
 // Without a follow session, retain the first available window. If the exact
 // followed window leaves, the caller sees it missing and stops following.
 assert.deepEqual(selectViewportConnections([other,existing,alice],null),[other,alice])
 assert.equal(selectViewportConnections([other,alice],50).some(peer=>peer.client===50),false)
 assert.deepEqual(selectViewportConnections([],50),[])
})

test('manual navigation invalidates late follow work before a React subscription can be replaced',async()=>{
 const intent=new ViewportFollowIntent(),moves:number[]=[];intent.set(7);const old=intent.capture(7)!
 const delayed=Promise.resolve().then(()=>{if(intent.current(old))moves.push(old.client)})
 intent.set(null);assert.equal(intent.capture(7),null);await delayed;assert.deepEqual(moves,[])
 intent.set(7);assert.equal(intent.current(old),false,'restarting the same member is a new follow intent')
 const current=intent.capture(7)!;assert.equal(intent.current(current),true);intent.set(8);assert.equal(intent.current(current),false);assert.ok(intent.capture(8))
})
test('follow intent rejects invalid connection identities and permits client zero',()=>{
 const intent=new ViewportFollowIntent();for(const value of [-1,NaN,Infinity,1.5])assert.throws(()=>intent.set(value))
 intent.set(0);assert.ok(intent.capture(0));intent.set(null);assert.equal(intent.capture(0),null)
})
