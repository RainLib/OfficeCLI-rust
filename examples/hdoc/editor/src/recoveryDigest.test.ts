import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {recoveryDigest} from './recoveryDigest.ts'

const expected=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
test('hashes only the requested view and snapshots before asynchronous completion',async()=>{
 const backing=Uint8Array.from([9,1,2,3,8]),view=backing.subarray(1,4),hash=expected(view)
 const pending=recoveryDigest(view);backing.fill(0)
 assert.equal(await pending,hash)
})
test('handles shared buffers without passing them to WebCrypto',async()=>{
 const shared=new Uint8Array(new SharedArrayBuffer(6));shared.set([9,1,2,3,8,7]);const view=shared.subarray(1,4),hash=expected(view)
 const pending=recoveryDigest(view);shared.fill(0)
 assert.equal(await pending,hash)
})
