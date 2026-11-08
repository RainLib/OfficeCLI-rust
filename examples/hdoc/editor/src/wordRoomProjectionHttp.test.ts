import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {wordRoomProjectionHttp} from './wordRoomProjectionHttp.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
const id='n_'+'1'.repeat(32),hash='a'.repeat(64)
async function fixture(){
 const state={revision:1,active:0,reads:0,enabled:true,expired:false,replaced:false,hook:undefined as undefined|(()=>Promise<void>)}
 const owner={assertAcceptingPackets(){},state:()=>({stateId:'b'.repeat(32),stateSequence:1,status:'saved',revision:state.revision,pending:false,digest:hash,imageDigest:hash})} as unknown as WordSaveCoordinator,other={...owner} as WordSaveCoordinator
 const projection={documentId:'doc',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id,differentFirstPage:false,page:{},headers:{},footers:{}}],stories:[]},blocks:[]}
 const server=createServer((request,response)=>{void wordRoomProjectionHttp(request,response,{enabled:state.enabled,access:async(_id,token)=>({scope:token==='writer'?'write':'read',userId:token,expiresAt:Math.floor(Date.now()/1000)+(state.expired?-1:60),collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2',coordinatedRestore:true}),enter:()=>{state.active++;return()=>{state.active--}},owner:()=>state.replaced?other:owner,projection:async()=>{state.reads++;await state.hook?.();return Response.json(projection,{headers:{'X-HCD-Word-Owner':'private-owner-must-not-be-forwarded'}})}}).then(handled=>{if(!handled){response.writeHead(404);response.end()}})})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/documents/doc/collaboration/word-room-projection`
 const send=(token='reader',body:unknown={epoch:2,revision:1},ack=true)=>fetch(url,{method:'POST',headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7',...(ack?{'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}:{})},body:JSON.stringify(body)})
 return{state,send,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
test('layout baseline is member readable, model acknowledged and pinned without exposing native credentials',async()=>{
 const f=await fixture()
 try{
  assert.equal((await f.send('')).status,401);assert.equal((await f.send('reader',undefined,false)).status,426)
  assert.equal((await f.send('reader',{epoch:1,revision:1})).status,409);assert.equal((await f.send('reader',{epoch:2,revision:0})).status,409);assert.equal(f.state.reads,0)
  const response=await f.send();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-hcd-word-owner'),null)
  const body=await response.json();assert.equal(body.projection.revision,1);assert.equal(body.saveState.wordRegionVersion,2);assert.equal(body.saveState.wordLayoutVersion,1);assert.equal(f.state.active,0)
  f.state.expired=true;assert.equal((await f.send()).status,403);f.state.expired=false;f.state.enabled=false;assert.equal((await f.send()).status,426)
 }finally{await f.close()}
})
test('layout baseline publication rechecks revision, owner identity and current access after asynchronous reads',async()=>{
 const f=await fixture()
 try{
  for(const change of [()=>{f.state.revision=2},()=>{f.state.replaced=true},()=>{f.state.expired=true}]){
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve)
   f.state.hook=async()=>{entered();await held};const reading=f.send();await started;change();release();const result=await reading
   assert.ok([403,409].includes(result.status));assert.equal('projection' in await result.json(),false);assert.equal(f.state.active,0)
   f.state.revision=1;f.state.replaced=false;f.state.expired=false
  }
 }finally{await f.close()}
})
