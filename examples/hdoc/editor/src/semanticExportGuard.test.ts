import assert from 'node:assert/strict'
import {test} from 'node:test'
import {semanticExportHead} from './semanticExportGuard.ts'

test('semantic export detects document changes during async resource or head checks',async()=>{
 const old=globalThis.fetch,session={documentId:'doc',format:'html',scope:'write' as const,token:'test'},hash='a'.repeat(64)
 let generation=4,release!:()=>void,entered!:()=>void
 try{
  globalThis.fetch=async()=>Response.json({documentId:'doc',revision:2,sourceSha256:hash})
  const started=new Promise<void>(resolve=>{entered=resolve})
  const pending=semanticExportHead(session,2,4,()=>generation,()=>false,()=>{entered();return new Promise<boolean>(resolve=>{release=()=>resolve(false)})},new AbortController().signal)
  await started;generation++;release();await assert.rejects(pending,/semantic-export-changed/)
  generation=4
  await assert.rejects(semanticExportHead(session,2,4,()=>generation,()=>false,async()=>false,new AbortController().signal,{revision:2,generation:4,sourceSha256:'b'.repeat(64)}),/semantic-export-changed/)
  assert.equal((await semanticExportHead(session,2,4,()=>generation,()=>false,async()=>false,new AbortController().signal)).revision,2)
 }finally{globalThis.fetch=old}
})
