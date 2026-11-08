import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFixedViewport,fixedFollowCycle} from './fixedViewport.ts'
test('fixed viewport accepts only finite page-relative coordinates and bounded identities',()=>{
 const value={version:1,page:0,pageNumber:1,x:.2,y:.8,following:3}
 assert.deepEqual(readFixedViewport(value),value)
 for(const patch of [{page:-1},{page:1.5},{pageNumber:0},{x:NaN},{y:Infinity},{x:'0.2'},{y:1.1},{following:-1},{following:'3'},{version:2},{revision:-1},{revision:NaN},{revision:1.5}])assert.equal(readFixedViewport({...value,...patch}),null)
 assert.equal(readFixedViewport(null),null)
 assert.deepEqual(readFixedViewport({...value,untrusted:'discarded'}),value)
})
test('fixed follow rejects direct, indirect and existing cycles; missing peers end the chain',()=>{
 const peer=(clientId:number,following?:number)=>({clientId,viewport:{version:1 as const,page:0,pageNumber:1,x:0,y:0,following}})
 assert.equal(fixedFollowCycle([peer(2,1)],1,2),true)
 assert.equal(fixedFollowCycle([peer(2,3),peer(3,1)],1,2),true)
 assert.equal(fixedFollowCycle([peer(2,3),peer(3,2)],1,2),true)
 assert.equal(fixedFollowCycle([peer(2,3)],1,2),false)
 assert.equal(fixedFollowCycle([peer(2)],1,2),false)
})

test('fixed view locations bind to an optional immutable revision and retain old-client compatibility',()=>{const v={version:1,page:128,pageNumber:129,x:0,y:0};assert.deepEqual(readFixedViewport({...v,revision:7}),{...v,revision:7});assert.deepEqual(readFixedViewport(v),v)})

test('Word paper awareness carries a bounded physical page without changing native chunk identity',()=>{
 const viewport={version:1,page:8,pageNumber:3,x:0,y:0,wordPage:3,wordSection:129}
 assert.deepEqual(readFixedViewport(viewport),viewport)
 for(const wordPage of [0,-1,1.1,Infinity,1_000_001,'3'])assert.equal(readFixedViewport({...viewport,wordPage}),null)
 for(const wordSection of [0,-1,1.1,Infinity,4097,'3'])assert.equal(readFixedViewport({...viewport,wordSection}),null)
 const legacy={version:1,page:8,pageNumber:3,x:0,y:0,wordPage:3}
 assert.deepEqual(readFixedViewport(legacy),legacy)
})
