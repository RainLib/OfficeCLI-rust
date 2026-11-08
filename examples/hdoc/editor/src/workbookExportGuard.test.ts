import assert from 'node:assert/strict'
import {test} from 'node:test'
import {verifyWorkbookDownload,workbookServerHead} from './workbookExportGuard.ts'

test('a new cell edit during the asynchronous resource check blocks download',async()=>{
 let editing=false,release!:(pending:boolean)=>void,started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve})
 const checking=verifyWorkbookDownload(4,()=>4,()=>editing,()=>{started();return new Promise(resolve=>{release=resolve})},async()=>4)
 await entered;editing=true;release(false)
 await assert.rejects(checking,/workbook-export-changed/)
})

test('a newer revision or pending image blocks download while an unchanged revision passes',async()=>{
 await assert.rejects(verifyWorkbookDownload(4,()=>5,()=>false,async()=>false,async()=>4),/workbook-export-changed/)
 await assert.rejects(verifyWorkbookDownload(4,()=>4,()=>false,async()=>true,async()=>4),/workbook-export-changed/)
 await assert.rejects(verifyWorkbookDownload(4,()=>4,()=>false,async()=>false,async()=>5),/workbook-export-changed/)
 await assert.rejects(verifyWorkbookDownload(4,()=>4,()=>false,async()=>false,async()=>{throw Error('offline')}),/offline/)
 await verifyWorkbookDownload(4,()=>4,()=>false,async()=>false,async()=>4)
})

test('an edit that starts while the server head is being read blocks download',async()=>{
 let editing=false,release!:(revision:number)=>void,started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve})
 const checking=verifyWorkbookDownload(4,()=>4,()=>editing,async()=>false,()=>{started();return new Promise(resolve=>{release=resolve})})
 await entered;editing=true;release(4);await assert.rejects(checking,/workbook-export-changed/)
})

test('head read is non-cacheable and validates document and source identity',async()=>{
 const original=globalThis.fetch,hash='a'.repeat(64),session={documentId:'book',format:'xlsx',scope:'write' as const,token:'test'}
 try{
  globalThis.fetch=async(_url,init)=>{assert.equal(init?.cache,'no-store');return Response.json({documentId:'book',revision:4,sourceSha256:hash})}
  assert.equal(await workbookServerHead(session,hash,new AbortController().signal),4)
  globalThis.fetch=async()=>Response.json({documentId:'other',revision:4,sourceSha256:hash})
  await assert.rejects(workbookServerHead(session,hash,new AbortController().signal),/invalid-workbook-head/)
  globalThis.fetch=async()=>Response.json({documentId:'book',revision:4,sourceSha256:'b'.repeat(64)})
  await assert.rejects(workbookServerHead(session,hash,new AbortController().signal),/invalid-workbook-head/)
 }finally{globalThis.fetch=original}
})
