import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readImageAssetBackup} from './imageAssetBackup.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'test-only',scope:'write',format:'docx',apiUrl:'https://owned.test/v1/documents'}
const png=Uint8Array.of(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3)
test('a staged draft image is read once, hash verified and returned with its detected type',async()=>{
 const old=globalThis.fetch,hash=await imageFileHash(png),paths:string[]=[]
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input));paths.push(url.pathname);assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-only');return url.pathname.includes('/staged-assets/')?new Response(png):new Response('',{status:404})}
 try{const result=await readImageAssetBackup(session,hash);assert.deepEqual(result.bytes,png);assert.equal(result.extension,'png');assert.deepEqual(paths,[`/v1/documents/doc/assets/${hash}`,`/v1/documents/doc/staged-assets/${hash}`])}finally{globalThis.fetch=old}
})
test('canonical access failures do not fall back; corrupted or oversized images never become backups',async()=>{
 const old=globalThis.fetch,hash=await imageFileHash(png);let calls=0
 try{globalThis.fetch=async()=>{calls++;return new Response('',{status:403})};await assert.rejects(readImageAssetBackup(session,hash),/403/);assert.equal(calls,1)
  globalThis.fetch=async()=>new Response(Uint8Array.of(1,2,3));await assert.rejects(readImageAssetBackup(session,hash),/integrity/)
  globalThis.fetch=async()=>new Response(png,{headers:{'content-length':String(8*1024*1024+1)}});await assert.rejects(readImageAssetBackup(session,hash),/limit/)
  const large=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));controller.close()}});globalThis.fetch=async()=>new Response(large);await assert.rejects(readImageAssetBackup(session,hash),/limit/)
  await assert.rejects(readImageAssetBackup(session,'../bad'),/invalid/)
 }finally{globalThis.fetch=old}
})
test('image backup cancels a stalled response at its deadline and preserves cancellation',async context=>{
 const old=globalThis.fetch,hash=await imageFileHash(png);let deadline=new AbortController(),cancelled=false,started!:()=>void
 const reached=new Promise<void>(resolve=>{started=resolve})
 context.mock.method(AbortSignal,'timeout',(ms:number)=>{assert.equal(ms,45_000);return deadline.signal})
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(){started()},cancel(){cancelled=true}}))
  const pending=readImageAssetBackup(session,hash);await reached;deadline.abort(new Error('backup deadline'))
  await assert.rejects(pending,/backup deadline/);assert.equal(cancelled,true)
  let calls=0;const user=new AbortController();deadline=new AbortController()
  globalThis.fetch=async()=>{calls++;user.abort(new Error('user cancelled'));return new Response('',{status:404})}
  await assert.rejects(readImageAssetBackup(session,hash,user.signal),/user cancelled/);assert.equal(calls,1)
 }finally{globalThis.fetch=old}
})
test('image backup stops waiting for response headers when the transport ignores cancellation',async()=>{
 const old=globalThis.fetch,hash=await imageFileHash(png),controller=new AbortController();let calls=0,started!:()=>void
 const reached=new Promise<void>(resolve=>{started=resolve})
 try{globalThis.fetch=async()=>{calls++;started();return new Promise<Response>(()=>{})};const pending=readImageAssetBackup(session,hash,controller.signal);await reached;controller.abort(new Error('cancel headers'));await assert.rejects(pending,/cancel headers/);assert.equal(calls,1)}finally{globalThis.fetch=old}
})
