import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {activeWordLayoutPending} from './wordActiveLayout.ts'
import {inspectActiveWordLayoutReceipt} from './wordActiveLayoutReceipt.ts'
const member={userId:'alice',displayName:'Alice',scope:'write' as const},hash='b'.repeat(64),pending=activeWordLayoutPending({schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'a'.repeat(32),baseRevision:3,expectedRevision:3,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash,changes:[{sectionId:'n_'+'1'.repeat(32),field:'widthTwips',expected:12240,value:11906}]}},'doc',member)
function fixture(){
 let accepted=true,known=true,authorized=true,loads=0;const routes:string[]=[]
 const journal={scope:{lineage:'c'.repeat(32)},load:async()=>{loads++},knownHashes:()=>known?[hash]:[],verifyLayoutReceipt:(record:any,request:any,receipt:any,journalHash:string)=>accepted&&record.revision===4&&request.transactionId===pending.request.transactionId&&receipt.transactionId===request.transactionId&&journalHash===hash} as unknown as WordCheckpointJournal
 const options={journal,pending,guard:()=>{},authorize:async()=>({...member,scope:authorized?'write' as const:'read' as const}),request:async(route:string,init?:RequestInit)=>{routes.push(route);if(route.startsWith('/revisions/'))return Response.json({revision:4});assert.equal(route,'/word/layout-receipt');assert.deepEqual(JSON.parse(String(init?.body)),{coordinatorId:'c'.repeat(32),transaction:pending.request});return Response.json({journalHash:hash,transactionId:pending.request.transactionId,projection:{private:'not returned'}})}}
 return{options,routes,loads:()=>loads,accepted:(v:boolean)=>{accepted=v},known:(v:boolean)=>{known=v},authorized:(v:boolean)=>{authorized=v}}
}
test('read-only result lookup verifies immutable receipt and journal ancestry without resubmitting a transaction',async()=>{
 const f=fixture();assert.deepEqual(await inspectActiveWordLayoutReceipt(f.options),{transactionId:pending.request.transactionId,status:'installed',revision:4});assert.deepEqual(f.routes,['/revisions/4','/word/layout-receipt']);assert.equal(f.loads(),0,'read-only checks must not change the active journal generation')
})
test('unknown ancestry, invalid signature and authority loss cannot complete the local request',async()=>{
 for(const mode of ['known','accepted','authorized'] as const){const f=fixture();f[mode](false);await assert.rejects(inspectActiveWordLayoutReceipt(f.options),mode==='authorized'?/unauthorized/:/receipt-invalid/)}
 const f=fixture(),original=f.options.request;f.options.request=async(route,init)=>{const response=await original(route,init);if(route==='/word/layout-receipt')f.authorized(false);return response};await assert.rejects(inspectActiveWordLayoutReceipt(f.options),/unauthorized/)
})
