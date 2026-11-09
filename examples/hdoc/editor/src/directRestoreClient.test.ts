import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DirectRestoreError,directRestoreSupported,submitDirectRestore} from './directRestoreClient.ts'
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
