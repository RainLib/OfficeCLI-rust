import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Session} from './api.ts'
import {readWordActiveLayoutStatus,readWordActiveTopologyStatus} from './wordActiveLayoutClient.ts'
const nonce='a'.repeat(32),session:Session={documentId:'doc',token:'test-token',scope:'read',format:'docx',collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:3,collabUrl:'wss://collab.example.test'}
const response=()=>({schemaVersion:'hcd-word-active-layout-status/1',documentId:'doc',epoch:3,transactionId:nonce,status:'installed',revision:8})
test('a page cache miss looks up the same story round with its independent schema and capability',async()=>{
 const original=globalThis.fetch;const calls:string[]=[]
 try{
  globalThis.fetch=async(url,init)=>{calls.push(String(url));if(String(url).endsWith('layout-status')){const {revision:_,...value}=response();return Response.json({...value,status:'recovery-required'})}assert.equal(new Headers(init?.headers).get('X-HCD-Word-Story-Version'),'1');assert.equal(JSON.parse(String(init?.body)).transactionId,nonce);return Response.json({...response(),schemaVersion:'hcd-word-active-story-status/1'})}
  assert.equal((await readWordActiveTopologyStatus(session,nonce,new AbortController().signal)).schemaVersion,'hcd-word-active-story-status/1');assert.equal(calls.length,2)
  globalThis.fetch=async()=>Response.json(response());assert.equal((await readWordActiveTopologyStatus(session,nonce,new AbortController().signal)).schemaVersion,'hcd-word-active-layout-status/1')
  globalThis.fetch=async url=>String(url).endsWith('layout-status')?Response.json({...response(),status:'recovery-required',revision:undefined}):Response.json(response());await assert.rejects(readWordActiveTopologyStatus(session,nonce,new AbortController().signal),/status-invalid/)
 }finally{globalThis.fetch=original}
})
test('read-only members query an exact round with model headers, never resubmitting a page request',async()=>{
 const original=globalThis.fetch;let calls=0
 try{
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://collab.example.test/v1/documents/doc/collaboration/word-active-layout-status');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{epoch:3,transactionId:nonce});const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Word-Regions-Version'),'2');assert.equal(headers.get('X-HCD-Word-Layout-Version'),'1');return Response.json(response())}
  assert.deepEqual(await readWordActiveLayoutStatus(session,nonce,new AbortController().signal),response());assert.equal(calls,1)
 }finally{globalThis.fetch=original}
})
test('wrong round, epoch, document, unsupported outcome and extra content cannot authorize a rebind',async()=>{
 const original=globalThis.fetch
 try{
  for(const value of [{...response(),transactionId:'b'.repeat(32)},{...response(),epoch:4},{...response(),documentId:'other'},{...response(),status:'not-committed'},{...response(),revision:NaN},{...response(),actor:{userId:'alice'}},{...response(),schemaVersion:'hcd-word-active-layout-status/2'}]){
   globalThis.fetch=async()=>Response.json(value);await assert.rejects(readWordActiveLayoutStatus(session,nonce,new AbortController().signal),/status-invalid/)
  }
  for(const status of ['pending','recovery-required']){const {revision:_,...value}=response();globalThis.fetch=async()=>Response.json({...value,status});assert.equal((await readWordActiveLayoutStatus(session,nonce,new AbortController().signal)).status,status)}
 }finally{globalThis.fetch=original}
})
test('invalid sessions and cancellation do not dispatch; failure and oversized status never imply success',async()=>{
 const original=globalThis.fetch;let calls=0
 try{
  globalThis.fetch=async()=>{calls++;return new Response('unavailable',{status:503})}
  for(const value of [{...session,collaborationProtocol:'hcd-word-regions/1' as const},{...session,collaborationEpoch:-1}])await assert.rejects(readWordActiveLayoutStatus(value,nonce,new AbortController().signal),/status-invalid/)
  await assert.rejects(readWordActiveLayoutStatus(session,'invalid',new AbortController().signal),/status-invalid/)
  const abort=new AbortController();abort.abort();await assert.rejects(readWordActiveLayoutStatus(session,nonce,abort.signal));assert.equal(calls,0)
  await assert.rejects(readWordActiveLayoutStatus(session,nonce,new AbortController().signal),/status-unavailable/)
  globalThis.fetch=async()=>new Response(' '.repeat(16*1024+1));await assert.rejects(readWordActiveLayoutStatus(session,nonce,new AbortController().signal),/status-limit/)
  globalThis.fetch=async()=>new Response(new Uint8Array([0xff]));await assert.rejects(readWordActiveLayoutStatus(session,nonce,new AbortController().signal),/status-invalid/)
 }finally{globalThis.fetch=original}
})

test('only exact page and story cache misses can look up the independent link round',async()=>{
 const original=globalThis.fetch,calls:string[]=[]
 try{
  globalThis.fetch=async(url,init)=>{const route=String(url);calls.push(route);const kind=route.endsWith('layout-status')?'layout':route.endsWith('story-status')?'story':'link',value={...response(),schemaVersion:`hcd-word-active-${kind}-status/1`};if(kind!=='link'){const {revision:_,...pending}=value;return Response.json({...pending,status:'recovery-required'})}assert.equal(new Headers(init?.headers).get('X-HCD-Word-Link-Version'),'1');assert.equal(JSON.parse(String(init?.body)).transactionId,nonce);return Response.json(value)}
  assert.equal((await readWordActiveTopologyStatus(session,nonce,new AbortController().signal)).schemaVersion,'hcd-word-active-link-status/1');assert.equal(calls.length,3)
  globalThis.fetch=async url=>{assert.ok(String(url).endsWith('layout-status'));const {revision:_,...value}=response();return Response.json({...value,status:'pending'})};assert.equal((await readWordActiveTopologyStatus(session,nonce,new AbortController().signal)).status,'pending')
 }finally{globalThis.fetch=original}
})
