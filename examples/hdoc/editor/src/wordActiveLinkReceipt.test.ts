import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordLinkFixture} from './wordLinkTestFixture.ts'
import {inspectActiveWordLinkReceipt} from './wordActiveLinkReceipt.ts'
test('live link proof checks the fixed original and late authority without reloading the shared journal',async()=>{
 const f=await wordLinkFixture();try{
  const before=f.journal.knownHashes(),routes:string[]=[];let allowed=true,mutate=false
  const journal=new Proxy(f.journal,{get:(target,key)=>{if(key==='load')return()=>{throw Error('must not reload live journal')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const options={journal,pending:f.pending,guard:()=>{},authorize:async()=>({...f.pending.actor,scope:allowed?'write' as const:'read' as const}),request:async(route:string,init?:RequestInit)=>{
   routes.push(route);if(route.startsWith('/editor'))return Response.json(f.previous);if(route.startsWith('/revisions'))return Response.json(f.record)
   assert.equal(route,'/word/link-receipt');const body=JSON.parse(String(init?.body)),proof=f.signHash(body.initialUpdateHash,before.at(-1)!);assert.deepEqual(body.prepared.transaction,f.pending.request)
   if(mutate)allowed=false;return Response.json({...proof,projection:f.next})
  }}
  assert.equal((await inspectActiveWordLinkReceipt(options)).revision,2);assert.deepEqual(f.journal.knownHashes(),before);assert.deepEqual(routes,['/editor?revision=1','/revisions/2','/word/link-receipt'])
  const invalid=structuredClone(f.pending);invalid.reviewHash='0'.repeat(64);await assert.rejects(inspectActiveWordLinkReceipt({...options,pending:invalid}),/receipt-invalid/)
  mutate=true;await assert.rejects(inspectActiveWordLinkReceipt(options),/unauthorized/)
 }finally{await f.close()}
})
