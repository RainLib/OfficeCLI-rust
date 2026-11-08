import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WordTopologyPause,wordTopologyWire} from './wordTopologyPause.ts'
import {WordTopologyRounds} from './wordTopologyRounds.ts'
const requestId='a'.repeat(32),message=(type='prepare',id=requestId)=>({type:`hcd-word-topology-${type}`,...wordTopologyWire,requestId:id})
const tick=()=>new Promise(resolve=>setTimeout(resolve,2))
async function until(check:()=>boolean){const end=Date.now()+1500;while(!check()){assert.ok(Date.now()<end);await tick()}}
test('ready waits for durable flush and provider drain, then only the matching release resumes input',async()=>{
 let flush!:()=>void,synced=false,resumed=0;const sent:any[]=[],pending=new Promise<void>(resolve=>{flush=resolve})
 const pause=new WordTopologyPause({send:value=>sent.push(value),ready:()=>true,pause:()=>()=>{resumed++},flush:()=>pending,synced:()=>synced,generation:()=>0,changed:()=>{}})
 try{
  pause.receive(message());assert.equal(pause.pending,true);assert.equal(sent.length,0);flush();await tick();assert.equal(sent.length,0);synced=true;await until(()=>sent.length===1);assert.equal(sent[0].ready,true)
  pause.receive(message('release','b'.repeat(32)));assert.equal(pause.pending,true);pause.receive(message('release'));assert.equal(pause.pending,false);assert.equal(resumed,1)
 }finally{pause.dispose()}
})
test('input changes after acknowledgement invalidate readiness without silently resuming',async()=>{
 const sent:any[]=[],pause=new WordTopologyPause({send:value=>sent.push(value),ready:()=>true,pause:()=>()=>{},flush:async()=>{},synced:()=>true,generation:()=>0,changed:()=>{}})
 try{pause.receive(message());await until(()=>sent.length===1);pause.invalidate();assert.deepEqual(sent.map(value=>value.ready),[true,false]);assert.equal(pause.pending,true)}finally{pause.dispose()}
})
test('release during a stalled flush prevents a late acknowledgement and does not consume another round',async()=>{
 let flush!:()=>void,resumed=0;const pending=new Promise<void>(resolve=>{flush=resolve}),sent:any[]=[]
 const pause=new WordTopologyPause({send:value=>sent.push(value),ready:()=>true,pause:()=>()=>{resumed++},flush:()=>pending,synced:()=>true,generation:()=>0,changed:()=>{}})
 try{pause.receive(message());pause.receive(message('release'));flush();await tick();assert.equal(sent.length,0);assert.equal(resumed,1);assert.equal(pause.pending,false)}finally{pause.dispose()}
})
test('composition refusal leaves input running; flush failure and timeout send a negative reply',async()=>{
 for(const mode of ['composition','storage','timeout']){
  const sent:any[]=[],pause=new WordTopologyPause({send:value=>sent.push(value),ready:()=>true,pause:()=>{if(mode==='composition')throw Error('composing');return()=>{}},flush:()=>mode==='timeout'?new Promise<void>(()=>{}):Promise.reject(Error('storage')),synced:()=>true,generation:()=>0,changed:()=>{},timeoutMs:15})
  try{pause.receive(message());await until(()=>sent.length===1);assert.equal(sent[0].ready,false);assert.equal(pause.pending,mode!=='composition')}finally{pause.dispose()}
 }
})
test('unknown model messages and disposed clients cannot produce an acknowledgement',async()=>{
 const sent:any[]=[],pause=new WordTopologyPause({send:value=>sent.push(value),ready:()=>true,pause:()=>()=>{},flush:async()=>{},synced:()=>true,generation:()=>0,changed:()=>{}})
 assert.equal(pause.receive({...message(),wordRegionVersion:1}),false);assert.equal(pause.receive({...message(),requestId:'not-an-id'}),false);pause.dispose();pause.receive(message());await tick();assert.equal(sent.length,0)
})
test('two clients pause before server freeze; late invalidation and newly joined clients reject the freeze',async()=>{
 const clients=new Map<string,WordTopologyPause>(),rounds=new WordTopologyRounds<string>((peer,value)=>clients.get(peer)!.receive(value),()=>true);let peers=['alice','bob'],resumed=0
 for(const peer of peers)clients.set(peer,new WordTopologyPause({send:value=>{rounds.accept('doc',peer,value)},ready:()=>true,pause:()=>()=>{resumed++},flush:async()=>{},synced:()=>true,generation:()=>0,changed:()=>{}}))
 try{
  await rounds.prepare('doc',requestId,()=>peers,()=>{});rounds.assertReady('doc',requestId,peers);assert.ok([...clients.values()].every(client=>client.pending))
  assert.equal(rounds.accept('doc','mallory',{...message('ready'),ready:true}),false);peers=[...peers,'new-member'];assert.throws(()=>rounds.assertReady('doc',requestId,peers),/online-clients/);peers=['alice','bob'];clients.get('bob')!.invalidate();assert.throws(()=>rounds.assertReady('doc',requestId,peers),/online-clients/)
  rounds.release('doc','b'.repeat(32));assert.equal(resumed,0);rounds.release('doc',requestId);assert.equal(resumed,2)
 }finally{for(const client of clients.values())client.dispose()}
})
test('unsupported peers and a refused acknowledgement cancel the round and release already paused clients',async()=>{
 for(const supported of [false,true]){
  const sent:any[]=[],rounds=new WordTopologyRounds<string>((peer,value)=>{sent.push(value);if((value as any).type==='hcd-word-topology-prepare')rounds.accept('doc',peer,{...message('ready'),ready:false})},()=>supported)
  await assert.rejects(rounds.prepare('doc',requestId,()=>['alice'],()=>{}),supported?/client-busy/:/upgrade-required/)
  assert.equal(sent.some(value=>value.type==='hcd-word-topology-release'),supported);assert.throws(()=>rounds.assertReady('doc',requestId,['alice']),/online-clients/)
 }
})
test('missing acknowledgements time out and release the exact round',async()=>{
 const sent:any[]=[],rounds=new WordTopologyRounds<string>((peer,value)=>{sent.push(value)},()=>true)
 await assert.rejects(rounds.prepare('doc',requestId,()=>['alice'],()=>{},15),/timeout/);assert.deepEqual(sent.map(value=>value.type),['hcd-word-topology-prepare','hcd-word-topology-release'])
})
