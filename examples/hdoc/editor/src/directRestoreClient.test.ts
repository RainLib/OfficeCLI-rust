import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DirectRestoreError,committedRestoreAdvance,directRestoreSupported,submitDirectRestore} from './directRestoreClient.ts'
import {legacyProtocol,structuralProtocol} from './collaborationProtocol.ts'
import type {Session} from './api.ts'
const session={documentId:'doc',token:'t',scope:'write' as const,format:'pptx',apiUrl:'http://restore.test'}
async function withFetch<T>(handler:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>,body:()=>Promise<T>):Promise<T>{
 const previous=globalThis.fetch
 globalThis.fetch=handler as typeof fetch
 try{return await body()}
 finally{globalThis.fetch=previous}
}
test('the direct restore channel is only offered for plain-protocol documents',()=>{
 assert.equal(directRestoreSupported(session),true)
 assert.equal(directRestoreSupported({...session,collaborationProtocol:legacyProtocol}),true)
 assert.equal(directRestoreSupported({...session,collaborationProtocol:structuralProtocol}),false)
})
test('a direct restore posts the compare revision as the CAS fence and follows the new head',async()=>{
 const seen:{url:string;method?:string;body:string}[]=[]
 const result=await withFetch(async(input,init)=>{
  seen.push({url:String(input),method:init?.method,body:String(init?.body)})
  return new Response(JSON.stringify({documentId:'doc',patchId:'restore-2-6',revision:6}),{status:200,headers:{'content-type':'application/json'}})
 },()=>submitDirectRestore(session,3,5))
 assert.deepEqual(seen,[{url:'http://restore.test/doc/restore/3',method:'POST',body:'{"expectedRevision":5}'}])
 assert.equal(result.revision,6)
})
test('conflicts and coordinator documents surface as their own deterministic failures',async()=>{
 await assert.rejects(withFetch(async()=>new Response(JSON.stringify({error:'REVISION_CONFLICT'}),{status:409}),()=>submitDirectRestore(session,3,5)),(cause:unknown)=>cause instanceof DirectRestoreError&&cause.kind==='conflict'&&cause.status===409)
 await assert.rejects(withFetch(async()=>new Response(JSON.stringify({error:'restore requires the collaboration coordinator'}),{status:426}),()=>submitDirectRestore(session,3,5)),(cause:unknown)=>cause instanceof DirectRestoreError&&cause.kind==='coordinator'&&cause.status===426)
})
test('an unusable success response is an unknown outcome, never a safe retry',async()=>{
 for(const payload of [{documentId:'other',revision:6},{documentId:'doc',revision:5},{documentId:'doc',revision:'6'}]){
  await assert.rejects(withFetch(async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}}),()=>submitDirectRestore(session,3,5)),(cause:unknown)=>cause instanceof DirectRestoreError&&cause.kind==='outcome-unknown')
 }
})

test('a committed restore whose body cannot be parsed is outcome-unknown, not failed',async()=>{
 for(const body of ['<html><body>bad gateway</body></html>','{"documentId":"doc","revis','']){
  await assert.rejects(withFetch(async()=>new Response(body,{status:200,headers:{'content-type':'text/html'}}),()=>submitDirectRestore(session,3,5)),(cause:unknown)=>cause instanceof DirectRestoreError&&cause.kind==='outcome-unknown'&&cause.message==='restore-response-unparseable')
 }
})

test('an uncertain restore is adopted only when the head record carries this restore patch id',async()=>{
 const seen:string[]=[]
 // Matching branch: head 6 was produced by restoring to target 3.
 const adopt=await withFetch(async(input)=>{seen.push(String(input));return new Response(JSON.stringify({documentId:'doc',revision:6,patchId:'restore-3-6'}),{status:200,headers:{'content-type':'application/json'}})},()=>committedRestoreAdvance(session,3,6))
 assert.equal(adopt,true)
 assert.deepEqual(seen,['http://restore.test/doc/revisions/6'])
 // Mismatch branches: the same +1 head from a plain save, from a restore to
 // a different target, or under a foreign document id never reads as this
 // restore, so the caller still surfaces a comparison change.
 for(const record of [{documentId:'doc',revision:6,patchId:'grid-0f4e1c2a-7b31-4d55-9a2e-6c1f8d3b5a77'},{documentId:'doc',revision:6,patchId:'restore-2-6'},{documentId:'doc',revision:6},{documentId:'other',revision:6,patchId:'restore-3-6'},{documentId:'doc',revision:5,patchId:'restore-3-6'}]){
  assert.equal(await withFetch(async()=>new Response(JSON.stringify(record),{status:200,headers:{'content-type':'application/json'}}),()=>committedRestoreAdvance(session,3,6)),false)
 }
 // Unreadable records (404 revision, transport error, unparseable body)
 // close toward "not this restore" rather than adopting on hope.
 assert.equal(await withFetch(async()=>new Response(JSON.stringify({error:'revision not found'}),{status:404}),()=>committedRestoreAdvance(session,3,6)),false)
 assert.equal(await withFetch(async()=>{throw new Error('connection reset')},()=>committedRestoreAdvance(session,3,6)),false)
 assert.equal(await withFetch(async()=>new Response('<html>proxy stalled</html>',{status:200,headers:{'content-type':'text/html'}}),()=>committedRestoreAdvance(session,3,6)),false)
 // A recheck the user cancelled mid-flight propagates the abort instead of
 // pretending the comparison definitively changed.
 const stopped=new AbortController();stopped.abort()
 await assert.rejects(withFetch(async()=>{throw new Error('aborted')},()=>committedRestoreAdvance(session,3,6,stopped.signal)),/aborted/)
})
