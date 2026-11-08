import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {WordUploadLedger} from './wordUploads.ts'

const nodeId='n_'+'1'.repeat(32),regionId='n_'+'2'.repeat(32),visualHash='a'.repeat(64)
const bytes=new TextEncoder().encode('image bytes'),hash=createHash('sha256').update(bytes).digest('hex')
const actor={userId:'alice',scope:'write' as const}
function fixture(stage:(attempt:number)=>Promise<Response>,authorize:()=>Promise<boolean>=async()=>true){
 let attempts=0,applied=0
 const ledger=new WordUploadLedger({request:async(_actor,_route,init)=>{
  if(init?.method==='POST'){assert.deepEqual(init.body,bytes);return stage(++attempts)}
  return new Response(bytes)
 },authorize,capture:()=>({regionId,revision:1,clientId:1,seen:[]}),imageAt:async()=>({nodeId,visualHash,geometry:{unit:'pt',x:0,y:0,width:1,height:1}}),apply:()=>{applied++},persist:async()=>{},changed:()=>{},available:()=>true})
 return {ledger,counts:()=>({attempts,applied}),start:()=>ledger.start(actor,{nodeId,extension:'png',bytes})}
}
test('regional image upload retries only explicit resource contention and applies once',async()=>{
 const f=fixture(async n=>n===1?Response.json({error:'HCD_RESOURCE_BUSY'},{status:409}):Response.json({hash}))
 try{await f.start().done;assert.deepEqual(f.counts(),{attempts:2,applied:1});assert.equal(f.ledger.pending,false)}finally{f.ledger.dispose()}
})
test('other conflicts retain the interrupted choice without retry or application',async()=>{
 const f=fixture(async()=>Response.json({error:'OTHER_CONFLICT'},{status:409}))
 try{await assert.rejects(f.start().done,/word-upload-stage:409/);assert.deepEqual(f.counts(),{attempts:1,applied:0});assert.equal(f.ledger.snapshot()[0].phase,'interrupted')}finally{f.ledger.dispose()}
})
test('cancellation and revoked authorization stop a pending retry',async()=>{
 let entered!:()=>void;const first=new Promise<void>(resolve=>entered=resolve)
 const f=fixture(async()=>{entered();return Response.json({error:'HCD_RESOURCE_BUSY'},{status:409})})
 try{const job=f.start();await first;await job.cancel();await assert.rejects(job.done);assert.deepEqual(f.counts(),{attempts:1,applied:0});assert.equal(f.ledger.snapshot()[0].phase,'cancelled')}finally{f.ledger.dispose()}
 let checks=0
 const g=fixture(async()=>Response.json({error:'HCD_RESOURCE_BUSY'},{status:409}),async()=>++checks<3)
 try{await assert.rejects(g.start().done,/word-upload-authority-changed/);assert.deepEqual(g.counts(),{attempts:1,applied:0});assert.equal(g.ledger.snapshot()[0].phase,'interrupted')}finally{g.ledger.dispose()}
})
