import {test} from 'node:test'
import assert from 'node:assert/strict'
import {api,ApiError,type Session} from './api.ts'

const session:Session={documentId:'doc',token:'test',scope:'write',format:'xlsx',apiUrl:'http://fixture'}

test('bounded API errors preserve actionable server codes',async()=>{
 const original=globalThis.fetch
 try{
  globalThis.fetch=async()=>Response.json({error:'HCD_XLSX_FORMULA_PROTECTED'},{status:422})
  await assert.rejects(api(session,'/edits'),error=>error instanceof ApiError&&error.status===422&&error.code==='HCD_XLSX_FORMULA_PROTECTED')
  globalThis.fetch=async()=>new Response('x',{status:503,headers:{'content-length':'65537'}})
  await assert.rejects(api(session,'/edits'),error=>error instanceof ApiError&&error.status===503&&error.message.includes('details unavailable'))
 }finally{globalThis.fetch=original}
})

test('cancelling a stalled API error body releases its response',async()=>{
 const original=globalThis.fetch,controller=new AbortController();let started!:()=>void,cancelled=false
 const entered=new Promise<void>(resolve=>{started=resolve})
 try{
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(){started()},cancel(){cancelled=true}}),{status:503})
  const pending=api(session,'/edits',{signal:controller.signal});await entered;controller.abort(new Error('stop error body'))
  await assert.rejects(pending,/stop error body/);assert.equal(cancelled,true)
 }finally{globalThis.fetch=original}
})
