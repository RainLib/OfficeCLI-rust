import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFixedPreviewAsset} from './fixedPreviewAsset.ts'

test('fixed page assets retain their verified bytes and MIME type',async()=>{
 const bytes=new TextEncoder().encode('synthetic preview'),hash=createHash('sha256').update(bytes).digest('hex')
 const blob=await readFixedPreviewAsset(new Response(bytes,{headers:{'content-type':'image/png'}}),hash,new AbortController().signal,'zh-CN')
 assert.equal(blob.type,'image/png');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes)
})

test('corrupt or oversized preview assets are rejected before display',async()=>{
 const signal=new AbortController().signal
 await assert.rejects(readFixedPreviewAsset(new Response('wrong'),'a'.repeat(64),signal,'zh-CN'),/校验值不一致/)
 let cancelled=false
 const response=new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-length':String(64*1024*1024+1)}})
 await assert.rejects(readFixedPreviewAsset(response,'a'.repeat(64),signal,'zh-CN'),/64 MiB/);assert.equal(cancelled,true)
 const controller=new AbortController();controller.abort();await assert.rejects(readFixedPreviewAsset(new Response('x'),'a'.repeat(64),controller.signal,'zh-CN'))
})
