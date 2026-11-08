import {test} from 'node:test'
import assert from 'node:assert/strict'
import {imageFileHash,verifyImageStage} from './imageFileIntegrity.ts'

test('a stage receipt must name the actual selected image bytes',async()=>{
 const hash=await imageFileHash(new TextEncoder().encode('abc'))
 assert.equal(hash,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
 assert.doesNotThrow(()=>verifyImageStage(hash,hash))
 for(const value of [null,undefined,'f'.repeat(64),hash.toUpperCase(),{hash}])assert.throws(()=>verifyImageStage(hash,value),/integrity/)
})
