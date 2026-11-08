import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordBrowserConnection,wordBrowserHeaders,wordBrowserModelMatches} from './wordBrowserProtocol.ts'
import {readWordBrowserProjection,readWordStorySessionProjection} from './wordBrowserProjection.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import {sendWordLargeRecovery} from './wordLargeRecoveryClient.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',format:'docx',scope:'write',token:'member-private',collaborationEpoch:2,collaborationProtocol:wordLayoutProtocol,apiUrl:'https://qa.invalid/v1/documents',collabUrl:'wss://qa.invalid/collab'}
const projection={documentId:'doc',revision:3,flowLayoutHash:'a'.repeat(64),flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:'n_'+'1'.repeat(32),differentFirstPage:false,page:{},headers:{},footers:{}}],stories:[]},blocks:[]}
const envelope=()=>({wordRegionVersion:2,wordLayoutVersion:1,projection,saveState:{type:'hcd-save-status',revision:3,nodeEditVersion:7,wordRegionVersion:2,wordLayoutVersion:1}})
test('browser room and HTTP declarations bind each protocol without accepting an implicit model or contaminated endpoint',()=>{
 for(const protocol of [wordRegionalProtocol,wordLayoutProtocol]){
  const connection=wordBrowserConnection({...session,collaborationProtocol:protocol}),url=new URL(connection.url),layout=protocol===wordLayoutProtocol
  assert.equal(connection.name,`doc:2:wordregions${layout?'2:save6':'1:save5'}`);assert.equal(url.searchParams.get('hcdWordRegions'),layout?'2':'1');assert.equal(url.searchParams.get('hcdWordLayout'),layout?'1':null)
  assert.equal(url.searchParams.get('hcdWordStory'),layout?'1':null);assert.equal(url.searchParams.get('hcdWordLink'),layout?'1':null)
  const headers=wordBrowserHeaders({collaborationProtocol:protocol});assert.equal(headers['X-HCD-Node-Edits-Version'],'7');assert.equal(headers['X-HCD-Word-Regions-Version'],layout?'2':'1')
  assert.equal(wordBrowserModelMatches({nodeEditVersion:7,wordRegionVersion:layout?2:1,...(layout?{wordLayoutVersion:1}:{})},protocol),true)
 }
 for(const collabUrl of ['https://qa.invalid','ws://user:pass@qa.invalid','ws://qa.invalid?token=private','ws://qa.invalid#private'])assert.throws(()=>wordBrowserConnection({...session,collabUrl}))
 for(const collaborationEpoch of [undefined,-1,1.1,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>wordBrowserConnection({...session,collaborationEpoch}))
 assert.throws(()=>wordBrowserConnection({...session,collaborationProtocol:undefined}));assert.equal(wordBrowserModelMatches({nodeEditVersion:7,wordRegionVersion:1,wordLayoutVersion:1},wordRegionalProtocol),false)
})
test('story proof reads immutable history directly and uses the fenced member baseline only for current-head refusal',async()=>{
 const original=globalThis.fetch;const calls:string[]=[]
 try{
  globalThis.fetch=async(url,init)=>{calls.push(String(url));assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer member-private');return Response.json(projection)}
  assert.deepEqual(await readWordStorySessionProjection(session,3,new AbortController().signal),projection);assert.equal(calls.length,1)
  globalThis.fetch=async url=>{calls.push(String(url));return String(url).includes('/editor?')?new Response('coordinator required',{status:426}):Response.json(envelope())}
  assert.deepEqual(await readWordStorySessionProjection(session,3,new AbortController().signal),projection);assert.equal(calls.length,3)
  let denied=0;globalThis.fetch=async()=>{denied++;return new Response('denied',{status:403})};await assert.rejects(readWordStorySessionProjection(session,3,new AbortController().signal));assert.equal(denied,1)
  globalThis.fetch=async()=>Response.json({...projection,revision:2});await assert.rejects(readWordStorySessionProjection(session,3,new AbortController().signal),/baseline-invalid/)
  globalThis.fetch=async()=>new Response(' '.repeat(16*1024*1024+1));await assert.rejects(readWordStorySessionProjection(session,3,new AbortController().signal),/baseline-limit/)
 }finally{globalThis.fetch=original}
})
test('layout browser reads only the member pinned baseline with exact model and version checks',async()=>{
 const original=globalThis.fetch;let body=envelope(),calls=0
 try{
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://qa.invalid/collab/v1/documents/doc/collaboration/word-room-projection');assert.equal(init?.method,'POST');assert.deepEqual(JSON.parse(String(init?.body)),{epoch:2,revision:3});assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer member-private');assert.equal(new Headers(init?.headers).get('X-HCD-Word-Layout-Version'),'1');return Response.json(body)}
  assert.deepEqual(await readWordBrowserProjection(session,3,new AbortController().signal),projection)
  for(const patch of [{wordRegionVersion:1},{wordLayoutVersion:undefined},{projection:{...projection,documentId:'other'}},{projection:{...projection,revision:2}},{saveState:{...envelope().saveState,revision:4}},{saveState:{...envelope().saveState,wordLayoutVersion:undefined}}]){
   body={...envelope(),...patch} as ReturnType<typeof envelope>;await assert.rejects(readWordBrowserProjection(session,3,new AbortController().signal))
  }
  assert.equal(calls,7)
 }finally{globalThis.fetch=original}
})
test('baseline failures, body limits and cancellation never publish a late native response',async()=>{
 const original=globalThis.fetch
 try{
  globalThis.fetch=async()=>new Response('',{status:409});await assert.rejects(readWordBrowserProjection(session,3,new AbortController().signal),/unavailable/)
  globalThis.fetch=async()=>new Response('{}',{headers:{'Content-Length':String(16*1024*1024+1)}});await assert.rejects(readWordBrowserProjection(session,3,new AbortController().signal),/limit/)
  let begin!:()=>void,release!:(value:Response)=>void;const started=new Promise<void>(resolve=>begin=resolve),held=new Promise<Response>(resolve=>release=resolve),controller=new AbortController()
  globalThis.fetch=async()=>{begin();return held};const reading=readWordBrowserProjection(session,3,controller.signal);await started;controller.abort(new Error('closed'));await assert.rejects(reading,/closed/);release(Response.json(envelope()))
 }finally{globalThis.fetch=original}
})
test('legacy baseline still uses its authenticated fixed revision native API',async()=>{
 const original=globalThis.fetch
 try{globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://qa.invalid/v1/documents/doc/editor?revision=3');assert.equal(new Headers(init?.headers).get('X-HCD-Collaboration-Protocol'),wordRegionalProtocol);return Response.json(projection)};assert.deepEqual(await readWordBrowserProjection({...session,collaborationProtocol:wordRegionalProtocol},3,new AbortController().signal),projection)}finally{globalThis.fetch=original}
})
test('large authored recovery carries layout declarations and preserves its original update digest',async()=>{
 const original=globalThis.fetch,bytes=Uint8Array.of(1,2,3),baseline=Uint8Array.of(4,5)
 try{for(const protocol of [wordRegionalProtocol,wordLayoutProtocol]){
  globalThis.fetch=async(url,init)=>{assert.match(String(url),/\/word-large-recovery$/);const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Word-Regions-Version'),protocol===wordLayoutProtocol?'2':'1');assert.equal(headers.get('X-HCD-Word-Layout-Version'),protocol===wordLayoutProtocol?'1':null);assert.deepEqual(init?.body,bytes);return Response.json({version:1,hash:headers.get('X-HCD-Recovery-Hash')})}
  await sendWordLargeRecovery({...session,collaborationProtocol:protocol},bytes,baseline,new AbortController().signal)
 }}finally{globalThis.fetch=original}
})
