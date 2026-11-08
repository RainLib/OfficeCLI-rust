import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WordRoomLease,wordRecoveryStoreId} from './wordRoomLease.ts'
const storeId='a'.repeat(32),secret='word-lease-test-secret-at-least-thirty-two-bytes',api='http://qa.invalid/native'
function fixture(){let now=0,requests:any[]=[],failure=0,lost:string[]=[];const request=async(_route:string,init:RequestInit)=>{const body=JSON.parse(String(init.body));requests.push(body);if(failure)return new Response('',{status:failure});return Response.json(body.action==='release'?{version:1,released:true}:{version:1,epoch:body.epoch,ownerId:body.ownerId,storeId:body.storeId,leaseId:'b'.repeat(32),remainingMs:15000,journalHash:'none'})};const lease=new WordRoomLease({epoch:1,storeId,request,now:()=>now,autoRenew:false,onLost:reason=>{lost.push(reason)}});return{lease,lost,requests,advance:(ms:number)=>{now+=ms},fail:(status:number)=>{failure=status}}}
test('owner receipts bind scope and use an earlier monotonic deadline, never the response arrival time',async()=>{const f=fixture();await f.lease.acquire();assert.equal(f.lease.headers()['X-HCD-Word-Owner'],'b'.repeat(32));f.advance(14000);assert.throws(()=>f.lease.assert(),/word-owner-lost/);await assert.rejects(f.lease.renew(),/word-owner-lost/);assert.equal(f.requests.length,1);assert.equal(f.lost.length,1);await f.lease.close()})
test('a failed renewal freezes once and later operations cannot revive the owner',async()=>{const f=fixture();await f.lease.acquire();f.fail(409);await assert.rejects(f.lease.renew(),/word-owner:409/);assert.throws(()=>f.lease.headers(),/word-owner-lost/);assert.equal(f.lost.length,1);await f.lease.close()})
test('a lease reply delayed beyond the original local deadline cannot renew or acquire authority',async()=>{
 for(const action of ['acquire','renew']){let now=0,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve});let held:(()=>void)|undefined;const wait=new Promise<void>(resolve=>{held=resolve});const lease=new WordRoomLease({epoch:1,storeId,now:()=>now,autoRenew:false,request:async(_route,init)=>{const body=JSON.parse(String(init.body));if(body.action===action){started();await wait};return Response.json({version:1,...body,leaseId:'c'.repeat(32),remainingMs:15000,journalHash:'none'})}})
  if(action==='renew')await lease.acquire();const pending=action==='acquire'?lease.acquire():lease.renew();await entered;now=20000;held!();await assert.rejects(pending,/expired-receipt/);assert.throws(()=>lease.assert());await lease.close()
 }
})
test('native mismatched owner/store/epoch receipts are rejected before any header can be used',async()=>{
 for(const field of ['ownerId','storeId','epoch','leaseId']){const lease=new WordRoomLease({epoch:1,storeId,autoRenew:false,request:async(_route,init)=>{const body=JSON.parse(String(init.body));return Response.json({version:1,...body,leaseId:'c'.repeat(32),remainingMs:15000,journalHash:'none',[field]:field==='epoch'?2:'invalid'})}});await assert.rejects(lease.acquire(),/receipt-invalid/);assert.throws(()=>lease.headers());await lease.close()}
})
test('recovery store identity is atomic, durable, API-scoped and authenticated without storing its secret',async()=>{const root=await fs.mkdtemp(join(tmpdir(),'hcd-word-store-'));try{const ids=await Promise.all([wordRecoveryStoreId(root,api,secret),wordRecoveryStoreId(root,api,secret)]);assert.equal(ids[0],ids[1]);assert.equal(await wordRecoveryStoreId(root,api,secret),ids[0]);assert.notEqual(await wordRecoveryStoreId(root,api+'/other',secret),ids[0]);await assert.rejects(wordRecoveryStoreId(root,api,secret+'wrong'),/word-store-invalid/);const names=await fs.readdir(root);for(const name of names){const contents=await fs.readFile(join(root,name,'word-room-store/identity.json'),'utf8');assert.equal(contents.includes(secret),false)}}finally{await fs.rm(root,{recursive:true,force:true})}})

test('journal recording serializes with renewal and supplies only the acknowledged native hash to checkpoints',async()=>{
 let journalHash='none',release!:()=>void,arrive!:()=>void;const wait=new Promise<void>(r=>{release=r}),entered=new Promise<void>(r=>{arrive=r}),actions:string[]=[]
 const lease=new WordRoomLease({epoch:1,storeId,autoRenew:false,journalHashes:['none'],request:async(_route,init)=>{const body=JSON.parse(String(init.body));actions.push(body.action);if(body.action==='record'){arrive();await wait;journalHash=body.journalHashes.at(-1)}return Response.json({version:1,...body,leaseId:'c'.repeat(32),remainingMs:15000,journalHash})}})
 try{await lease.acquire();const next='d'.repeat(64),record=lease.recordJournal(['none',next]);await entered;const renewal=lease.renew();assert.equal(lease.headers()['X-HCD-Word-Journal-Hash'],'none');assert.deepEqual(actions,['acquire','record']);release();await Promise.all([record,renewal]);assert.deepEqual(actions,['acquire','record','renew']);assert.equal(lease.headers()['X-HCD-Word-Journal-Hash'],next)}finally{release();await lease.close()}
})
test('a failed or mismatched durable journal acknowledgement freezes the owner before checkpoint headers are issued',async()=>{
 for(const mismatch of [false,true]){let lost=0;const lease=new WordRoomLease({epoch:1,storeId,autoRenew:false,onLost:()=>{lost++},request:async(_route,init)=>{const body=JSON.parse(String(init.body));if(body.action==='record'&&!mismatch)return new Response('',{status:409});return Response.json({version:1,...body,leaseId:'c'.repeat(32),remainingMs:15000,journalHash:'none'})}})
  await lease.acquire();await assert.rejects(lease.recordJournal(['none','e'.repeat(64)]),/word-owner:409|receipt-invalid/);assert.throws(()=>lease.headers(),/word-owner-lost/);assert.equal(lost,1);await lease.close()
 }
})

test('a pinned projection retries a rejected old journal tip only after the same owner acknowledges its successor',async()=>{
 let journalHash='none',record:Promise<void>|undefined,calls=0
 const lease=new WordRoomLease({epoch:1,storeId,autoRenew:false,request:async(_route,init)=>{const body=JSON.parse(String(init.body));if(body.action==='record')journalHash=body.journalHashes.at(-1);return Response.json({version:1,...body,leaseId:'c'.repeat(32),remainingMs:15000,journalHash})}})
 try{
  await lease.acquire();const response=await lease.readProjection(async headers=>{calls++;if(calls===1){assert.equal(headers['X-HCD-Word-Journal-Hash'],'none');record=lease.recordJournal(['none','e'.repeat(64)]);await record;return new Response('',{status:409})}assert.equal(headers['X-HCD-Word-Journal-Hash'],'e'.repeat(64));return Response.json({revision:2})})
  assert.equal(response.status,200);assert.equal(calls,2);assert.deepEqual(await response.json(),{revision:2})
 }finally{await record;await lease.close()}
})
test('projection errors with an unchanged journal or denied authority are never retried',async()=>{
 const f=fixture();await f.lease.acquire()
 try{
  for(const status of [409,403,426,500]){let calls=0;const response=await f.lease.readProjection(async()=>{calls++;return new Response('',{status})});assert.equal(response.status,status);assert.equal(calls,1)}
  await assert.rejects(f.lease.readProjection(async()=>{f.advance(14000);return new Response('',{status:409})}),/owner-lost/)
 }finally{await f.lease.close()}
})
