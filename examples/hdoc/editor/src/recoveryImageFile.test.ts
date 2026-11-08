import {test} from 'node:test'
import assert from 'node:assert/strict'
import {imageFileHash} from './imageFileIntegrity.ts'
import {recoveryImageFile} from './recoveryImageFile.ts'

test('recovered replacement downloads the exact verified bytes with a byte-derived extension',async()=>{
 const bytes=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]),hash=await imageFileHash(bytes)
 const result=await recoveryImageFile(hash,bytes)
 assert.equal(result.name,`recovered-image-${hash.slice(0,16)}.png`)
 bytes[8]=99
 assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]))
 await assert.rejects(recoveryImageFile(hash,bytes),/integrity/)
})
test('unknown verified bytes remain downloadable without inventing an image type',async()=>{
 const bytes=new Uint8Array([1,2,3]),file=await recoveryImageFile(await imageFileHash(bytes),bytes)
 assert.match(file.name,/\.bin$/)
 await assert.rejects(recoveryImageFile('invalid',bytes),/integrity/)
})
