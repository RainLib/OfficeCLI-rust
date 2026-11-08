import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFixedReceipt} from './fixedReceiptRead.ts'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {captureFixedEdits,verifyFixedReceipt} from './saveEdits.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'local',scope:'write',format:'xlsx'}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
function fixture(){const texts=new TextDraftStore(),images=new ImageDraftStore();texts.edit({nodeId:'node',nodeHash:'a'.repeat(64),text:'Original'},0,'Retained draft');const attempt=captureFixedEdits(0,texts,images)!;return {texts,images,attempt,controller:new FixedSaveController(session,texts,images,null,attempt)}}

test('invalid or oversized saved receipts retain the exact request without submitting edits',async()=>{
 const original=fetch
 try{for(const response of [new Response('{}',{headers:{'content-length':String(8*1024*1024+1)}}),new Response('null'),new Response(Uint8Array.of(255))]){
  const f=fixture(),routes:string[]=[];globalThis.fetch=async input=>{routes.push(String(input));return response}
  try{await assert.rejects(f.controller.save(0),/invalidSaveReceipt/);assert.equal(f.controller.state().attempt?.id,f.attempt.id);assert.equal(f.texts.get('node')?.text,'Retained draft');assert.equal(routes.length,1);assert.ok(routes[0].endsWith('/edits/receipt'))}finally{f.controller.dispose()}
 }}finally{globalThis.fetch=original}
})

test('closing a controller stops a stalled receipt and cannot acknowledge a late result',async()=>{
 const original=fetch,f=fixture();let deliver!:(response:Response)=>void,cancelled=false
 globalThis.fetch=()=>new Promise(resolve=>{deliver=resolve})
 try{const work=f.controller.save(0);await tick();f.controller.dispose();await assert.rejects(work)
  deliver(new Response(new ReadableStream({cancel(){cancelled=true}})));await tick();assert.equal(cancelled,true);assert.equal(f.controller.state().attempt?.id,f.attempt.id);assert.equal(f.texts.get('node')?.text,'Retained draft')
 }finally{f.controller.dispose();globalThis.fetch=original}
})

test('receipt body reads can be cancelled and later bytes cannot produce a result',async()=>{
 const abort=new AbortController();let cancelled=false
 const work=readFixedReceipt(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'))},cancel(){cancelled=true}})),abort.signal)
 await tick();abort.abort(new Error('stop receipt'));await assert.rejects(work,/stop receipt/);assert.equal(cancelled,true)
})

test('cancelling receipt digest validation cannot publish a late acknowledgement',async()=>{
 const f=fixture(),abort=new AbortController(),original=crypto.subtle.digest;let deliver!:(value:ArrayBuffer)=>void
 const hash=createHash('sha256').update('Retained draft').digest();crypto.subtle.digest=(()=>new Promise(resolve=>{deliver=resolve})) as typeof original
 try{const work=verifyFixedReceipt(f.attempt,{revision:1,patchId:f.attempt.id,nodeHashes:{node:hash.toString('hex')}},abort.signal);await tick();abort.abort(new Error('stop digest'));await assert.rejects(work,/stop digest/);deliver(Uint8Array.from(hash).buffer);await tick();assert.equal(f.texts.get('node')?.text,'Retained draft')
 }finally{crypto.subtle.digest=original;f.controller.dispose()}
})

test('an unreadable post-commit response keeps its identity and recovers by receipt without another edit',async()=>{
 const original=fetch,texts=new TextDraftStore(),images=new ImageDraftStore();texts.edit({nodeId:'node',nodeHash:'a'.repeat(64),text:'Original'},0,'Retained draft');const controller=new FixedSaveController(session,texts,images,null);let edits=0,receipts=0,patchId=''
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(String(init?.body));if(String(url).endsWith('/edits')){edits++;patchId=body.patchId;return new Response('{}',{headers:{'content-length':String(8*1024*1024+1)}})}
  receipts++;if(receipts===1)return new Response('',{status:503})
  return Response.json({status:'committed',revision:1,patchId,nodeHashes:{node:createHash('sha256').update('Retained draft').digest('hex')}})
 }
 try{await assert.rejects(controller.save(0),/fixedSaveUnknown/);assert.equal(controller.state().attempt?.id,patchId);assert.equal(texts.get('node')?.text,'Retained draft')
  assert.equal(await controller.save(0),1);assert.equal(edits,1);assert.equal(receipts,2);assert.equal(controller.pending,false);assert.equal(texts.size,0)
 }finally{controller.dispose();globalThis.fetch=original}
})
