import {test} from 'node:test'
import assert from 'node:assert/strict'
import {confirmProtocolReady,negotiationURL,protocolDelay} from './protocolClient.ts'
const session={documentId:'doc',token:'secret-never-in-url',format:'docx',scope:'write' as const}
test('protocol negotiation follows the configured websocket path without putting credentials into URLs',()=>{
 assert.equal(negotiationURL({...session,collabUrl:'wss://collab.example/hcd/'}),'https://collab.example/hcd/v1/documents/doc/collaboration/negotiate')
 for(const collabUrl of ['file:///tmp/room','wss://user:password@collab.example','ws://collab.example/?token=secret','ws://collab.example/#secret'])assert.throws(()=>negotiationURL({...session,collabUrl}),/protocolUnavailable/)
})
function transport(){const listeners=new Set<(value:any)=>void>(),sent:string[]=[];return{listeners,sent,on:(_event:string,fn:(value:any)=>void)=>listeners.add(fn),off:(_event:string,fn:(value:any)=>void)=>listeners.delete(fn),sendStateless:(value:string)=>{sent.push(value)},receive:(value:object)=>listeners.forEach(fn=>fn({payload:JSON.stringify(value)}))}}
test('handoff requires the acknowledgement of this request and always detaches its listener',async()=>{
 const provider=transport(),controller=new AbortController(),pending=confirmProtocolReady(provider,controller.signal),request=JSON.parse(provider.sent[0]);let ready=false
 void pending.then(()=>{ready=true})
 provider.receive({...request,requestId:crypto.randomUUID(),ready:true});provider.receive({...request,version:2,ready:true});await Promise.resolve();assert.equal(ready,false)
 provider.receive({...request,ready:true});await pending;assert.equal(provider.listeners.size,0);controller.abort()
})
test('cancelled handoffs and polling release listeners without sending another request',async()=>{
 const provider=transport(),controller=new AbortController(),pending=confirmProtocolReady(provider,controller.signal)
 controller.abort();await assert.rejects(pending,/protocolUnavailable/);assert.equal(provider.listeners.size,0)
 await assert.rejects(protocolDelay(100,controller.signal),/protocolUnavailable/)
 const completed=new AbortController();await protocolDelay(1,completed.signal);completed.abort()
 const canceled=transport();await assert.rejects(confirmProtocolReady(canceled,controller.signal));assert.equal(canceled.sent.length,0);assert.equal(canceled.listeners.size,0)
})

test('structural negotiation rejects an unaware coordinator before a cached body can connect',async()=>{
 const {negotiateSession}=await import('./protocolClient.ts'),{structuralProtocol,nodeEditCollaborationUrl}=await import('./collaborationProtocol.ts'),original=globalThis.fetch
 try{for(const nodeEditVersion of [undefined,1,2,3,4,5,6,8]){globalThis.fetch=async()=>Response.json({collaborationEpoch:1,collaborationProtocol:structuralProtocol,nodeEditVersion});await assert.rejects(negotiateSession({...session,collabUrl:'ws://localhost:9999'},new AbortController().signal),/protocolUnavailable/)}globalThis.fetch=async()=>Response.json({collaborationEpoch:1,collaborationProtocol:structuralProtocol,nodeEditVersion:7});assert.equal((await negotiateSession({...session,collabUrl:'ws://localhost:9999'},new AbortController().signal)).collaborationEpoch,1);assert.equal(new URL(nodeEditCollaborationUrl('wss://collab.example/hcd')).searchParams.get('hcdNodeEdits'),'7')}finally{globalThis.fetch=original}
})
test('inline negotiation requires explicit host support, exact model and wire acknowledgement without downgrade',async()=>{
 const {negotiateSession}=await import('./protocolClient.ts'),{inlineProtocol,structuralProtocol}=await import('./collaborationProtocol.ts'),original=globalThis.fetch,current={...session,collabUrl:'ws://localhost:9999',collaborationProtocol:inlineProtocol}
 let calls=0
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const h=new Headers(init?.headers);assert.equal(h.get('X-HCD-Inline-Containers-Version'),'1');assert.equal(h.get('X-HCD-Node-Edits-Version'),'7');assert.equal(h.get('X-HCD-Extension-Version'),'3');return Response.json({collaborationEpoch:1,collaborationProtocol:inlineProtocol,nodeEditVersion:7,inlineContainers:1})}
  await assert.rejects(negotiateSession(current,new AbortController().signal),/protocolUnavailable/);assert.equal(calls,0)
  assert.equal((await negotiateSession(current,new AbortController().signal,{inlineContainers:true})).collaborationProtocol,inlineProtocol)
  for(const value of [{collaborationProtocol:structuralProtocol,nodeEditVersion:7},{collaborationProtocol:inlineProtocol,nodeEditVersion:7},{collaborationProtocol:inlineProtocol,nodeEditVersion:7,inlineContainers:2},{collaborationProtocol:inlineProtocol,nodeEditVersion:6,inlineContainers:1}]){globalThis.fetch=async()=>Response.json({collaborationEpoch:1,...value});await assert.rejects(negotiateSession(current,new AbortController().signal,{inlineContainers:true}),/protocolUnavailable/)}
  const aborted=new AbortController();aborted.abort();globalThis.fetch=async()=>{throw new Error('must not open')};await assert.rejects(negotiateSession(current,aborted.signal,{inlineContainers:true}),error=>error instanceof DOMException&&error.name==='AbortError')
 }finally{globalThis.fetch=original}
})

test('layout-aware Word negotiation requires explicit opt-in and exact server acknowledgements',async()=>{
 const {negotiateSession}=await import('./protocolClient.ts'),{wordLayoutProtocol,wordRegionalProtocol}=await import('./collaborationProtocol.ts'),original=globalThis.fetch,current={...session,collabUrl:'ws://localhost:9999',collaborationProtocol:wordLayoutProtocol};let calls=0
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Word-Regions-Version'),'2');assert.equal(headers.get('X-HCD-Word-Layout-Version'),'1');assert.equal(headers.get('X-HCD-Node-Edits-Version'),'7');return Response.json({collaborationEpoch:1,collaborationProtocol:wordLayoutProtocol,nodeEditVersion:7,wordRegionVersion:2,wordLayoutVersion:1})}
  await assert.rejects(negotiateSession(current,new AbortController().signal),/protocolUnavailable/);assert.equal(calls,0)
  await assert.rejects(negotiateSession(current,new AbortController().signal,{wordLayoutV2:true,inlineContainers:true}),/protocolUnavailable/);assert.equal(calls,0)
  assert.equal((await negotiateSession(current,new AbortController().signal,{wordLayoutV2:true})).collaborationProtocol,wordLayoutProtocol)
  for(const value of [{collaborationProtocol:wordRegionalProtocol,nodeEditVersion:7,wordRegionVersion:1,wordLayoutVersion:1},{collaborationProtocol:wordLayoutProtocol,nodeEditVersion:6,wordRegionVersion:2,wordLayoutVersion:1},{collaborationProtocol:wordLayoutProtocol,nodeEditVersion:7,wordRegionVersion:1,wordLayoutVersion:1},{collaborationProtocol:wordLayoutProtocol,nodeEditVersion:7,wordRegionVersion:2},{collaborationProtocol:wordLayoutProtocol,nodeEditVersion:7,wordRegionVersion:2,wordLayoutVersion:2}]){globalThis.fetch=async()=>Response.json({collaborationEpoch:1,...value});await assert.rejects(negotiateSession(current,new AbortController().signal,{wordLayoutV2:true}),/protocolUnavailable/)}
  globalThis.fetch=async()=>Response.json({code:'word-layout-room-unavailable'},{status:426});await assert.rejects(negotiateSession(current,new AbortController().signal,{wordLayoutV2:true}),/protocolUnavailable/)
 }finally{globalThis.fetch=original}
})
