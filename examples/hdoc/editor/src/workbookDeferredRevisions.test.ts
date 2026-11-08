import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WorkbookDeferredRevisions,workbookLatePeerNeedsReload} from './workbookDeferredRevisions.ts'

test('deferred remote events preserve ordering and fall back to reload on reset or overflow',()=>{
 const q=new WorkbookDeferredRevisions(),event=(revision:number)=>({revision,patchId:`p${revision}`,nodes:[{nodeId:'n',nodeHash:'h',text:`v${revision}`}]})
 q.push(event(1));q.push(event(2));assert.equal(q.pending,true);assert.deepEqual(q.take(),{reload:false,events:[event(1),event(2)]});assert.equal(q.pending,false)
 q.push({...event(3),reset:true});q.push(event(4));assert.deepEqual(q.take(),{reload:true,events:[]})
 for(let i=0;i<129;i++)q.push(event(i));assert.deepEqual(q.take(),{reload:true,events:[]})
 q.push({...event(1),nodeHashes:{['x'.repeat(2_000_001)]:'h'}});assert.deepEqual(q.take(),{reload:true,events:[]})
})
test('a delayed peer event after a newer receipt invalidates only an older opened grid',()=>{
 const event={revision:1,patchId:'peer',nodes:[{nodeId:'other-cell',nodeHash:'hash',text:'peer'}]}
 assert.equal(workbookLatePeerNeedsReload(event,2,0,false),true)
 assert.equal(workbookLatePeerNeedsReload(event,2,1,false),false)
 assert.equal(workbookLatePeerNeedsReload(event,2,0,true),false)
 assert.equal(workbookLatePeerNeedsReload(event,1,0,false),false)
 const q=new WorkbookDeferredRevisions();q.push({...event,reset:true});assert.equal(q.pending,true);assert.deepEqual(q.take(),{reload:true,events:[]})
})
