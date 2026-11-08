import {test} from 'node:test'
import assert from 'node:assert/strict'
import {imageFileHash} from './imageFileIntegrity.ts'
import {recoveryAttachmentFile} from './recoveryAttachmentFile.ts'
import {recoveryImageFile} from './recoveryImageFile.ts'

test('pending recovery attachment downloads exact verified bytes without trusting its MIME',async()=>{
 const bytes=new TextEncoder().encode('待恢复附件😀'),resource={key:'file',name:'附件.txt',mediaType:'text/plain',byteLength:bytes.length,hash:await imageFileHash(bytes)},file=await recoveryAttachmentFile(resource,bytes),expected=Uint8Array.from(bytes)
 bytes[0]^=1;assert.equal(file.name,'附件.txt');assert.equal(file.blob.type,'application/octet-stream');assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()),expected)
 await assert.rejects(recoveryAttachmentFile(resource,bytes),/integrity/)
 await assert.rejects(recoveryAttachmentFile({...resource,byteLength:1},expected),/integrity/)
 await assert.rejects(recoveryAttachmentFile({...resource,name:'../bad'},expected),/nodeResourceInvalid/)
})

test('canceling a stalled recovery download stops waiting and discards the late hash',async()=>{
 const bytes=new Uint8Array([1,2,3]),hash=await imageFileHash(bytes),resource={key:'file',name:'a.txt',mediaType:'text/plain',byteLength:bytes.length,hash}
 const subtle=crypto.subtle,original=Object.getOwnPropertyDescriptor(subtle,'digest');let release!:(value:ArrayBuffer)=>void,started!:()=>void
 try{
  for(const work of [(signal:AbortSignal)=>recoveryAttachmentFile(resource,bytes,signal),(signal:AbortSignal)=>recoveryImageFile(hash,bytes,signal)]){
   const entered=new Promise<void>(resolve=>{started=resolve})
   Object.defineProperty(subtle,'digest',{configurable:true,value:()=>{started();return new Promise<ArrayBuffer>(resolve=>{release=resolve})}})
   const controller=new AbortController(),pending=work(controller.signal);await entered;controller.abort(new Error('cancelled'))
   await assert.rejects(pending,/cancelled/);release(new ArrayBuffer(32));await Promise.resolve()
  }
 }finally{if(original)Object.defineProperty(subtle,'digest',original);else delete (subtle as {digest?:unknown}).digest}
})
