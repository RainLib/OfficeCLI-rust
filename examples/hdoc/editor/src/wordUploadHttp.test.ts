import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request as httpRequest} from 'node:http'
import {createHash} from 'node:crypto'
import {WordUploadLedger} from './wordUploads.ts'
import {wordUploadHttp} from './wordUploadHttp.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
const nodeId='n_'+'1'.repeat(32),regionId='n_'+'2'.repeat(32),hash='a'.repeat(64),bytes=Buffer.from('fixture image'),assetHash=createHash('sha256').update(bytes).digest('hex'),image={nodeId,visualHash:hash,assetHash:hash,geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}
async function fixture(bodyTimeoutMs?:number){let posted=0,applied=0,persisted=0,active=0;const stages=new Map<string,Uint8Array>(),ledger=new WordUploadLedger({request:async(actor,route,init)=>{assert.equal(actor.userId,'alice');if(init?.method==='POST'){posted++;stages.set(assetHash,Uint8Array.from(init.body as Uint8Array));return Response.json({hash:assetHash})}return stages.has(assetHash)?new Response(Uint8Array.from(stages.get(assetHash)!)):new Response('',{status:404})},authorize:async()=>true,capture:()=>({regionId,revision:1,clientId:42,seen:[]}),imageAt:async()=>image,apply:()=>{applied++},persist:async()=>{persisted++},changed:()=>{},available:()=>true}),server=createServer((request,response)=>{void wordUploadHttp(request,response,{enabled:true,access:async(_id,token)=>({scope:token==='reader'?'read':'write',userId:token==='bob'?'bob':'alice',displayName:token,expiresAt:Date.now()/1000+600,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/1'}),owner:()=>({uploads:ledger} as unknown as WordSaveCoordinator),enter:()=>{active++;return()=>{active--}},remember:()=>{},bodyTimeoutMs}).then(handled=>{if(!handled){response.writeHead(404);response.end()}}).catch(()=>{response.writeHead(500);response.end()})});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}/v1/documents/doc/collaboration/word-uploads`,request=(body:unknown,token='alice',id?:string,epoch=1)=>fetch(url+(id?`/${id}`:''),{method:id?'PUT':'POST',headers:{Authorization:`Bearer ${token}`,'X-HCD-Node-Edits-Version':'7','X-HCD-Collaboration-Epoch':String(epoch),'Content-Type':id?'application/octet-stream':'application/json'},body:id?body as BodyInit:JSON.stringify(body)});return{ledger,request,url,active:()=>active,counts:()=>({posted,applied,persisted}),selection:()=>({id:crypto.randomUUID(),nodeId,extension:'png',assetHash,byteLength:bytes.length,revision:1,clientId:123,visualHash:hash,seen:[]}),close:async()=>{ledger.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()))}}}
test('HTTP member transport reserves before bytes, scopes list/cancel, rejects stale epochs/read writes and applies exact replay once',async()=>{const f=await fixture();try{const selection=f.selection();assert.equal((await f.request({operation:'reserve',selection})).status,200);assert.equal(f.counts().posted,0);assert.equal(f.ledger.pending,true);assert.equal((await f.request({operation:'cancel',id:selection.id},'bob')).status,404);assert.deepEqual((await(await f.request({operation:'list'},'bob')).json()).records,[]);assert.equal((await f.request(bytes,'reader',selection.id)).status,403);assert.equal((await f.request(bytes,'alice',selection.id,0)).status,409);assert.equal((await f.request(Buffer.alloc(bytes.length),'alice',selection.id)).status,409);assert.equal(f.counts().posted,0);assert.equal((await f.request(bytes,'alice',selection.id)).status,200);assert.equal((await f.request({operation:'resume',id:selection.id})).status,200);assert.equal(f.counts().posted,1);assert.equal(f.counts().applied,1);assert.deepEqual((await(await f.request({operation:'list'})).json()).records,[]);assert.equal((await(await f.request({operation:'list',ids:[selection.id]})).json()).records[0].phase,'applied')}finally{await f.close()}})
test('cancel-before-reserve tombstones the exact selection and prevents a late metadata or binary request from reviving it',async()=>{const f=await fixture();try{const selection=f.selection();assert.equal((await f.request({operation:'cancel-selection',selection})).status,200);const replay=await(await f.request({operation:'reserve',selection})).json();assert.equal(replay.record.phase,'cancelled');assert.equal((await f.request(bytes,'alice',selection.id)).status,409);assert.equal(f.counts().posted,0);assert.equal(f.counts().applied,0);assert.equal(f.ledger.pending,false)}finally{await f.close()}})
test('stalled upload releases the room gate and retains its reserved selection for retry',async()=>{
 const f=await fixture(100);try{
  const selection=f.selection();assert.equal((await f.request({operation:'reserve',selection})).status,200)
  await new Promise<void>((resolve,reject)=>{
   const request=httpRequest(`${f.url}/${selection.id}`,{method:'PUT',headers:{Authorization:'Bearer alice','X-HCD-Node-Edits-Version':'7','X-HCD-Collaboration-Epoch':'1','Content-Length':bytes.length}})
   const timer=setTimeout(()=>{request.destroy();reject(new Error('stalled upload was not closed'))},2000)
   request.on('error',()=>{clearTimeout(timer);resolve()});request.write(bytes.subarray(0,1))
  })
  const deadline=Date.now()+1000;while(f.active()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.active(),0);assert.equal(f.ledger.pending,true);assert.equal(f.counts().applied,0)
  assert.equal((await f.request(bytes,'alice',selection.id)).status,200);assert.equal(f.counts().applied,1)
 }finally{await f.close()}
})
test('stalled upload metadata does not hold the room gate indefinitely',async()=>{
 const f=await fixture(100);try{
  await new Promise<void>((resolve,reject)=>{
   const request=httpRequest(f.url,{method:'POST',headers:{Authorization:'Bearer alice','X-HCD-Node-Edits-Version':'7','X-HCD-Collaboration-Epoch':'1','Content-Length':100}})
   const timer=setTimeout(()=>{request.destroy();reject(new Error('stalled metadata was not closed'))},2000)
   request.on('error',()=>{clearTimeout(timer);resolve()});request.write('{')
  })
  const deadline=Date.now()+1000;while(f.active()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.active(),0);assert.equal(f.ledger.pending,false);assert.equal((await f.request({operation:'list'})).status,200)
 }finally{await f.close()}
})
