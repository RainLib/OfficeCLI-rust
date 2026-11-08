import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Session} from './api.ts'
import {wordCheckpointRecovery,WordCheckpointClientError} from './wordCheckpointRecoveryClient.ts'
import {renderToStaticMarkup} from 'react-dom/server'
import {createElement} from 'react'
import {I18nProvider} from './i18n.tsx'
import {WordCheckpointRecovery} from './WordCheckpointRecovery.tsx'
const session:Session={documentId:'doc',token:'secret',userId:'alice',scope:'write',format:'docx',collabUrl:'wss://collab.example',collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2'}
const signal=()=>new AbortController().signal,id='a'.repeat(32),pending={checkpointId:id,baseRevision:4,revision:4,status:'pending'}
test('inspection and explicit resume use authenticated model and the same reviewed checkpoint',async()=>{
 const old=globalThis.fetch,calls:string[]=[]
 try{globalThis.fetch=async(url,init)=>{calls.push(String(init?.body));assert.match(String(url),/^https:\/\/collab.example\/v1\/documents\/doc\/collaboration\/word-checkpoint-recovery$/);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer secret');assert.equal(headers.get('x-hcd-word-regions-version'),'2');return Response.json(calls.length===1?pending:{...pending,revision:5,status:'confirmed'})};assert.deepEqual(await wordCheckpointRecovery(session,'inspect',signal()),pending);assert.equal((await wordCheckpointRecovery(session,'resume',signal(),id)).revision,5);assert.deepEqual(calls.map(value=>JSON.parse(value)),[{operation:'inspect',epoch:2},{operation:'resume',epoch:2,checkpointId:id}])}finally{globalThis.fetch=old}
})
test('invalid identity or reply fails closed and a dispatched save failure remains uncertain',async()=>{
 const old=globalThis.fetch;let calls=0
 try{globalThis.fetch=async()=>{calls++;return Response.json({...pending,checkpointId:'b'.repeat(32)})};await assert.rejects(wordCheckpointRecovery(session,'resume',signal(),id),error=>error instanceof WordCheckpointClientError&&error.uncertain);assert.equal(calls,1);await assert.rejects(wordCheckpointRecovery({...session,scope:'read'},'resume',signal(),id),error=>error instanceof WordCheckpointClientError&&!error.uncertain);assert.equal(calls,1);globalThis.fetch=async()=>new Response('',{status:409});await assert.rejects(wordCheckpointRecovery(session,'resume',signal(),id),error=>error instanceof WordCheckpointClientError&&error.uncertain)}finally{globalThis.fetch=old}
})
test('a confirmed historical save remains distinct from a current confirmation',async()=>{
 const old=globalThis.fetch
 try{globalThis.fetch=async()=>Response.json({...pending,status:'confirmed-stale'});assert.equal((await wordCheckpointRecovery(session,'resume',signal(),id)).status,'confirmed-stale');assert.equal((await wordCheckpointRecovery(session,'inspect',signal())).status,'confirmed-stale')}finally{globalThis.fetch=old}
})
test('rebased drafts are identified separately and may advance multiple revisions',async()=>{
 const old=globalThis.fetch
 try{globalThis.fetch=async()=>Response.json({...pending,revision:9,status:'rebased'});assert.equal((await wordCheckpointRecovery(session,'inspect',signal())).status,'rebased');globalThis.fetch=async()=>Response.json({...pending,revision:9,status:'rebased-stale'});assert.equal((await wordCheckpointRecovery(session,'resume',signal(),id)).status,'rebased-stale');globalThis.fetch=async()=>Response.json({...pending,status:'rebased'});await assert.rejects(wordCheckpointRecovery(session,'resume',signal(),id),WordCheckpointClientError)}finally{globalThis.fetch=old}
})
test('the compatibility screen requires an explicit inspection and explains editing remains unavailable',()=>{
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordCheckpointRecovery,{session})}));assert.match(html,/检查待确认的保存/);assert.match(html,/不会打开文档或创建新的保存请求/);assert.doesNotMatch(html,/确认并核对保存/)
})
