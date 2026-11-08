import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {wordActiveLinkHttp} from './wordActiveLinkHttp.ts'

async function fixture(){
 let scope='write',enabled=true,expired=false,enters=0,leaves=0,owners=0
 const server=createServer((request,response)=>{void wordActiveLinkHttp(request,response,{get enabled(){return enabled},access:async()=>({scope,userId:'alice',displayName:'Alice',expiresAt:Math.floor(Date.now()/1000)+(expired?-1:60),collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2',coordinatedRestore:true}) as any,enter:()=>{enters++;return()=>{leaves++}},owner:()=>{owners++;return undefined},submit:async()=>{throw Error('unexpected submit')},cancel:async()=>{throw Error('unexpected cancel')},status:()=>{throw Error('unexpected status')}}).then(handled=>{if(!handled){response.writeHead(404);response.end()}})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/documents/doc/collaboration/word-active-link-preview`,headers={'Authorization':'Bearer member','Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},body={epoch:1,selection:{sectionId:'n_'+'1'.repeat(32),kind:'header',variant:'default',transactionId:'a'.repeat(32)}}
 const send=async(value:unknown=body,changes:RequestInit={})=>{const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(value),...changes});return{status:response.status,data:await response.json()}}
 return{url,headers,body,send,counts:()=>({enters,leaves,owners}),scope:(value:string)=>{scope=value},disable:()=>{enabled=false},expire:()=>{expired=true},close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
test('link HTTP requires a current writer and explicit compatible client before looking up the owner',async()=>{
 const f=await fixture();try{
  const missing={...f.headers};delete(missing as Partial<typeof missing>)['X-HCD-Word-Link-Version'];assert.equal((await f.send(f.body,{headers:missing})).status,426)
  f.scope('read');assert.equal((await f.send()).status,403);f.scope('write');f.expire();assert.equal((await f.send()).status,403)
  assert.deepEqual(f.counts(),{enters:0,leaves:0,owners:0})
 }finally{await f.close()}
})
test('invalid epoch, extra keys and oversized input are rejected before entering a live room',async()=>{
 const f=await fixture();try{
  assert.equal((await f.send({...f.body,epoch:0})).status,409)
  assert.equal((await f.send({...f.body,extra:true})).status,409)
  assert.equal((await f.send({...f.body,selection:{...f.body.selection,transactionId:'bad'}})).status,409)
  assert.equal((await f.send('x'.repeat(8192))).status,413)
  assert.deepEqual(f.counts(),{enters:0,leaves:0,owners:0})
 }finally{await f.close()}
})
test('missing active owner releases admission, and feature-off cannot open or create a room',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.send(),{status:409,data:{code:'word-link-preview-owner'}});assert.deepEqual(f.counts(),{enters:1,leaves:1,owners:1})
  f.disable();assert.equal((await f.send()).status,426);assert.deepEqual(f.counts(),{enters:1,leaves:1,owners:1})
  const options=await fetch(f.url,{method:'OPTIONS'});assert.equal(options.status,204);assert.equal(options.headers.get('Cache-Control'),'no-store');assert.ok(options.headers.get('Access-Control-Allow-Headers')?.includes('x-hcd-word-link-version'))
 }finally{await f.close()}
})

test('link submit/cancel/status pin exact member and epoch before dispatch; reader status reveals no payload',async()=>{
 const {wordLinkFixture}=await import('./wordLinkTestFixture.ts'),f=await wordLinkFixture()
 let scope='write',epoch=1,late=false,submits=0,cancels=0,statuses=0;const received:unknown[]=[]
 const server=createServer((request,response)=>{void wordActiveLinkHttp(request,response,{
  enabled:true,access:async()=>({scope,userId:'alice',displayName:'Alice 王',expiresAt:Math.floor(Date.now()/1000)+60,collaborationEpoch:epoch,collaborationProtocol:'hcd-word-regions/2',coordinatedRestore:true}) as any,
  enter:()=>{throw Error('no room lookup for dispatch')},owner:()=>{throw Error('no room lookup for dispatch')},
  submit:async(_id,_epoch,pending,_review,authorize)=>{submits++;received.push(pending);if(late)scope='read';await authorize();return{transactionId:pending.request.transactionId,revision:2,status:'installed'}},
  cancel:async(_id,_epoch,pending,_review,authorize)=>{cancels++;await authorize();return{transactionId:pending.request.transactionId,status:'not-prepared'}},
  status:(_id,selectedEpoch,transactionId)=>{statuses++;return{schemaVersion:'hcd-word-active-link-status/1',documentId:'doc',epoch:selectedEpoch,transactionId,status:'recovery-required'}},
 }).then(handled=>{if(!handled){response.writeHead(404);response.end()}})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/documents/doc/collaboration/word-active-link-`,headers={'Authorization':'Bearer synthetic','Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},body={epoch:1,pending:f.pending,reviewHash:'e'.repeat(64)}
 const post=async(action:string,value:unknown)=>{const response=await fetch(origin+action,{method:'POST',headers,body:JSON.stringify(value)});return{status:response.status,data:await response.json()}}
 try{
  assert.equal((await post('submit',body)).status,200);assert.equal(submits,1)
  assert.equal((await post('cancel',body)).status,200);assert.equal(cancels,1)
  const forged=structuredClone(body);forged.pending.actor.userId='bob';forged.pending.request.actor.userId='bob';assert.equal((await post('submit',forged)).status,403);assert.equal(submits,1)
  assert.equal((await post('submit',{...body,extra:true})).status,400)
  assert.equal((await post('submit',{...body,pending:'x'.repeat(256*1024)})).status,413)
  epoch=2;assert.equal((await post('cancel',body)).status,409);epoch=1
  scope='read';assert.equal((await post('submit',body)).status,403)
  const status=await post('status',{epoch:1,transactionId:f.pending.request.transactionId});assert.equal(status.status,200);assert.deepEqual(Object.keys(status.data).sort(),['documentId','epoch','schemaVersion','status','transactionId']);assert.equal(statuses,1)
  scope='write';late=true;assert.equal((await post('submit',body)).status,403);assert.equal(submits,2);assert.equal(received.length,2)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close()}
})
