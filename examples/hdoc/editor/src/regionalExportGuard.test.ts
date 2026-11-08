import assert from 'node:assert/strict'
import {test} from 'node:test'
import {regionalExportHead} from './regionalExportGuard.ts'

test('regional export rejects edits during file or server checks and a changed source',async()=>{
 const original=globalThis.fetch,hash='a'.repeat(64),session={documentId:'doc',format:'docx',scope:'write' as const,token:'test'}
 let state={ready:true,saved:true,revision:3},release!:()=>void,entered!:()=>void
 try{
  globalThis.fetch=async()=>Response.json({documentId:'doc',revision:3,sourceSha256:hash})
  const wait=new Promise<void>(resolve=>{entered=resolve})
  const pending=regionalExportHead(session,3,()=>state,()=>{entered();return new Promise<void>(resolve=>{release=resolve})},new AbortController().signal)
  await wait;state={...state,saved:false};release();await assert.rejects(pending,/regional-export-changed/)
  state={...state,saved:true}
  await assert.rejects(regionalExportHead(session,3,()=>state,async()=>{},new AbortController().signal,{revision:3,sourceSha256:'b'.repeat(64)}),/regional-export-changed/)
  assert.equal((await regionalExportHead(session,3,()=>state,async()=>{},new AbortController().signal)).revision,3)
 }finally{globalThis.fetch=original}
})
