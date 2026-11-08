import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readDocumentSession,WordCompatibilityError} from './documentSession.ts'
import {classifyDocumentProblem} from './documentProblems.ts'
import {legacyProtocol} from './collaborationProtocol.ts'
const input={documentId:'qa-doc',token:'private-token',apiUrl:'https://qa.invalid/v1/documents',collabUrl:'ws://127.0.0.1:8768'}
const auth={scope:'write',collaborationEpoch:2,collaborationProtocol:legacyProtocol,userId:'alice',displayName:'Alice 王'}
const info={source:{format:'docx'}}
const signal=()=>new AbortController().signal

test('open requests start in parallel and use authenticated API; successful metadata preserves identity',async()=>{
 const fetch=globalThis.fetch,started:string[]=[],release:Array<()=>void>=[]
 try{
  globalThis.fetch=async(url,init)=>{assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer private-token');started.push(String(url));await new Promise<void>(resolve=>release.push(resolve));return Response.json(String(url).endsWith('/auth')?auth:info)}
  const pending=readDocumentSession(input,signal());assert.equal(started.length,2);release.forEach(done=>done());const result=await pending
  assert.equal(result.format,'docx');assert.equal(result.scope,'write');assert.equal(result.userId,'alice');assert.equal(result.displayName,'Alice 王');assert.equal(result.collaborationEpoch,2)
 }finally{globalThis.fetch=fetch}
})
test('invalid opening parameters fail before contacting service',async()=>{
 const fetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected')}
 try{for(const bad of [{...input,documentId:'../private'},{...input,token:'   '}])await assert.rejects(readDocumentSession(bad,signal()),error=>classifyDocumentProblem(error).code==='HCD-DOC-1000');assert.equal(calls,0)}finally{globalThis.fetch=fetch}
})
test('malformed metadata and unsupported format/model return distinct errors',async()=>{
 const fetch=globalThis.fetch
 try{
  for(const [access,manifest,expected]of [[null,info,'3001'],[{...auth,scope:'admin'},info,'3001'],[{...auth,collaborationEpoch:-1},info,'3001'],[auth,null,'3001'],[auth,{source:{format:'unknown'}},'3002'],[{...auth,collaborationProtocol:'future/99'},info,'1026']] as const){globalThis.fetch=async(url)=>Response.json(String(url).endsWith('/auth')?access:manifest);await assert.rejects(readDocumentSession(input,signal()),error=>classifyDocumentProblem(error).code===`HCD-DOC-${expected}`)}
  globalThis.fetch=async()=>new Response('{invalid json');await assert.rejects(readDocumentSession(input,signal()),error=>classifyDocumentProblem(error).code==='HCD-DOC-3001')
 }finally{globalThis.fetch=fetch}
})
test('canceled opens reject before starting and after metadata even if transport ignores abort',async()=>{
 const fetch=globalThis.fetch,controller=new AbortController();let calls=0
 try{
  globalThis.fetch=async(url)=>{calls++;controller.abort();return Response.json(String(url).endsWith('/auth')?auth:info)}
  await assert.rejects(readDocumentSession(input,controller.signal),error=>error instanceof DOMException&&error.name==='AbortError');assert.equal(calls,2)
  calls=0;await assert.rejects(readDocumentSession(input,controller.signal));assert.equal(calls,0)
 }finally{globalThis.fetch=fetch}
})
test('incompatible regional Word exposes only the authenticated old device scope for download',async()=>{
 const fetch=globalThis.fetch
 try{
  for(const protocol of ['hcd-word-regions/1','hcd-word-regions/2']){
   globalThis.fetch=async(url)=>Response.json(String(url).endsWith('/auth')?{...auth,collaborationProtocol:protocol}:{source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:3}})
   await assert.rejects(readDocumentSession(input,signal()),error=>error instanceof WordCompatibilityError&&error.recoverySession.userId==='alice'&&error.recoverySession.collaborationEpoch===2&&error.recoverySession.collaborationProtocol==='hcd-word-regions/1'&&(protocol==='hcd-word-regions/2'?error.checkpointSession?.collaborationProtocol===protocol&&error.checkpointSession?.displayName==='Alice 王':error.checkpointSession===undefined)&&classifyDocumentProblem(error).code==='HCD-DOC-1026')
  }
  globalThis.fetch=async(url)=>Response.json(String(url).endsWith('/auth')?{...auth,collaborationProtocol:'other'}:{source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:3}})
  await assert.rejects(readDocumentSession(input,signal()),error=>!(error instanceof WordCompatibilityError))
  globalThis.fetch=async(url)=>String(url).endsWith('/auth')?new Response('',{status:403}):Response.json({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:3}})
  await assert.rejects(readDocumentSession(input,signal()),error=>!(error instanceof WordCompatibilityError)&&classifyDocumentProblem(error).code==='HCD-DOC-1003')
 }finally{globalThis.fetch=fetch}
})

test('layout session opening requires stable native metadata and explicit sidecar negotiation',async()=>{
 const original=globalThis.fetch,access={...auth,coordinatedRestore:true,collaborationProtocol:'hcd-word-regions/2'},manifest={source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:3}};let status=200,epoch=2,calls=0
 try{
  globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/auth'))return Response.json(access);if(!String(url).endsWith('/negotiate'))return Response.json(manifest);calls++;const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Word-Regions-Version'),'2');assert.equal(headers.get('X-HCD-Word-Layout-Version'),'1');return Response.json({collaborationEpoch:epoch,collaborationProtocol:'hcd-word-regions/2',wordRegionVersion:2,wordLayoutVersion:1,nodeEditVersion:7},{status})}
  const session=await readDocumentSession(input,signal());assert.equal(session.collaborationProtocol,'hcd-word-regions/2');assert.equal(session.flowLayoutVersion,2);assert.equal(session.displayName,'Alice 王');assert.equal(calls,1)
  for(const problem of ['disabled','changed']){status=problem==='disabled'?426:200;epoch=problem==='changed'?3:2;await assert.rejects(readDocumentSession(input,signal()),error=>error instanceof WordCompatibilityError&&error.checkpointSession?.collaborationProtocol==='hcd-word-regions/2')}
 }finally{globalThis.fetch=original}
})
test('cancelled layout negotiation cannot publish a session even when transport ignores abort',async()=>{
 const original=globalThis.fetch,controller=new AbortController()
 try{globalThis.fetch=async(url)=>{if(String(url).endsWith('/auth'))return Response.json({...auth,coordinatedRestore:true,collaborationProtocol:'hcd-word-regions/2'});if(String(url).endsWith('/negotiate')){controller.abort();return Response.json({collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2',wordRegionVersion:2,wordLayoutVersion:1,nodeEditVersion:7})}return Response.json({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:1}})};await assert.rejects(readDocumentSession(input,controller.signal),error=>error instanceof DOMException&&error.name==='AbortError')}finally{globalThis.fetch=original}
})
test('only the exact native field capability is published on a negotiated Word layout session',async()=>{
 const original=globalThis.fetch
 try{
  for(const declaration of [undefined,null,'future-v2',true,'inline-v1']){
   globalThis.fetch=async(url)=>String(url).endsWith('/auth')?Response.json({...auth,coordinatedRestore:true,collaborationProtocol:'hcd-word-regions/2',wordNumericFields:declaration}):String(url).endsWith('/negotiate')?Response.json({collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2',wordRegionVersion:2,wordLayoutVersion:1,nodeEditVersion:7}):Response.json({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:3}})
   assert.equal((await readDocumentSession(input,signal())).wordNumericFields,declaration==='inline-v1'?'inline-v1':undefined)
  }
 }finally{globalThis.fetch=original}
})
