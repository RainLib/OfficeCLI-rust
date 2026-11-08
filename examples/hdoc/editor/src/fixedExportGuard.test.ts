import test from 'node:test'
import assert from 'node:assert/strict'
import {fixedDocumentHead,verifyFixedDownload} from './fixedExportGuard.ts'

test('fixed layout download rejects changes made while the head is checked',async()=>{
 let blocked=false,release!:(value:number)=>void,started!:()=>void
 const checkingStarted=new Promise<void>(resolve=>{started=resolve})
 const checking=verifyFixedDownload(4,()=>4,()=>blocked,()=>{started();return new Promise(resolve=>{release=resolve})})
 await checkingStarted;blocked=true;release(4)
 await assert.rejects(checking,/fixed-export-changed/)
})

test('fixed layout download rejects a newer or unavailable server revision',async()=>{
 await assert.rejects(verifyFixedDownload(4,()=>4,()=>false,async()=>5),/fixed-export-changed/)
 await assert.rejects(verifyFixedDownload(4,()=>4,()=>false,async()=>{throw Error('offline')}),/offline/)
 await assert.rejects(verifyFixedDownload(4,()=>5,()=>false,async()=>4),/fixed-export-changed/)
 await verifyFixedDownload(4,()=>4,()=>false,async()=>4)
})

test('fixed layout head identifies the document and source without caching',async()=>{
 const original=globalThis.fetch,hash='a'.repeat(64),session={documentId:'deck',format:'pptx',scope:'write' as const,token:'test'}
 try{
  globalThis.fetch=async(_url,init)=>{assert.equal(init?.cache,'no-store');return Response.json({documentId:'deck',revision:2,sourceSha256:hash})}
  assert.equal(await fixedDocumentHead(session,hash,new AbortController().signal),2)
  globalThis.fetch=async()=>Response.json({documentId:'other',revision:2,sourceSha256:hash})
  await assert.rejects(fixedDocumentHead(session,hash,new AbortController().signal),/invalid-document-head/)
  globalThis.fetch=async()=>Response.json({documentId:'deck',revision:2,sourceSha256:'b'.repeat(64)})
  await assert.rejects(fixedDocumentHead(session,hash,new AbortController().signal),/invalid-document-head/)
 }finally{globalThis.fetch=original}
})
