import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {IDBFactory} from 'fake-indexeddb'
import {DraftBootstrapError,draftBootstrapProblem,draftStorage,readServerDraft,requireDraftAuthority} from './draftBootstrap.ts'
import {legacyProtocol,structuralProtocol} from './collaborationProtocol.ts'
import {LocalDraftJournal,draftIdentity} from './localDrafts.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'private-token',scope:'write',format:'docx',collaborationEpoch:0,collaborationProtocol:legacyProtocol}
const signal=()=>new AbortController().signal

test('a state-conflict response refreshes authority once and leaves the existing disk draft intact',async()=>{
 const original=globalThis.fetch,factory=new IDBFactory(),identity=await draftIdentity(session,'alice','https://editor.example'),journal=await LocalDraftJournal.open(identity,factory),cached=new Y.Doc(),calls:string[]=[]
 cached.getMap('private-draft').set('unsaved','device input');await journal.bind(cached)
 try{
  globalThis.fetch=async(url,init)=>{calls.push(String(url));assert.equal(new Headers(init?.headers).get('X-HCD-Collaboration-Epoch'),'0');return String(url).endsWith('/auth')?Response.json({collaborationEpoch:1,collaborationProtocol:structuralProtocol}):new Response('collaboration generation changed',{status:409})}
  await assert.rejects(readServerDraft(session,signal()),error=>error instanceof DraftBootstrapError&&error.key==='localDraftAuthorityChanged'&&error.authority?.collaborationEpoch===1)
  assert.equal(calls.length,2);assert.match(calls[0],/state$/);assert.match(calls[1],/auth$/)
  const restored=await journal.load();assert.equal(restored.getMap('private-draft').get('unsaved'),'device input');restored.destroy()
 }finally{globalThis.fetch=original;journal.close();cached.destroy()}
})
test('server/auth failures do not claim device storage failed or start an unbounded room retry',async()=>{
 const original=globalThis.fetch
 try{
  for(const [status,expected]of [[401,'localDraftAccessDenied'],[403,'localDraftAccessDenied'],[503,'localDraftServerUnavailable']] as const){let calls=0;globalThis.fetch=async()=>{calls++;return new Response('unavailable',{status})};await assert.rejects(readServerDraft(session,signal()),error=>draftBootstrapProblem(error)===expected);assert.equal(calls,1)}
  let calls=0;globalThis.fetch=async(url)=>{calls++;return String(url).endsWith('/auth')?Response.json({collaborationEpoch:0,collaborationProtocol:legacyProtocol}):new Response('unsupported',{status:426})}
  await assert.rejects(readServerDraft(session,signal()),error=>draftBootstrapProblem(error)==='localDraftProtocolUnavailable');assert.equal(calls,2)
  globalThis.fetch=async()=>{throw new TypeError('network error containing private details')}
  await assert.rejects(readServerDraft(session,signal()),error=>error instanceof DraftBootstrapError&&error.message==='localDraftServerUnavailable')
 }finally{globalThis.fetch=original}
})
test('a stale body protocol also refreshes authority, while a valid current body is returned unchanged',async()=>{
 const original=globalThis.fetch,doc=new Y.Doc();doc.getMap(semanticBlockFields.metadata).set('version',3)
 const bytes=Y.encodeStateAsUpdate(doc)
 try{
  globalThis.fetch=async(url)=>String(url).endsWith('/auth')?Response.json({collaborationEpoch:0,collaborationProtocol:structuralProtocol}):new Response(Uint8Array.from(bytes).buffer)
  await assert.rejects(readServerDraft(session,signal()),error=>error instanceof DraftBootstrapError&&error.key==='localDraftAuthorityChanged'&&error.authority?.collaborationProtocol===structuralProtocol)
  const restored=await readServerDraft({...session,collaborationProtocol:structuralProtocol},signal());assert.equal(restored?.getMap(semanticBlockFields.metadata).get('version'),3);restored?.destroy()
 }finally{globalThis.fetch=original;doc.destroy()}
})
test('missing server state stays distinct from unreadable state and cancellation never probes authority',async()=>{
 const original=globalThis.fetch
 try{
  globalThis.fetch=async()=>new Response('missing',{status:404});assert.equal(await readServerDraft(session,signal()),null)
  let calls=0;const controller=new AbortController();controller.abort()
  globalThis.fetch=async()=>{calls++;throw controller.signal.reason}
  await assert.rejects(readServerDraft(session,controller.signal));assert.equal(calls,1)
 }finally{globalThis.fetch=original}
})
test('only a disk operation is classified as unavailable backup; continuing must still recheck current authority',async()=>{
 await assert.rejects(draftStorage(async()=>{throw new DOMException('blocked','QuotaExceededError')}),error=>draftBootstrapProblem(error)==='localDraftUnavailable')
 const original=globalThis.fetch
 try{
  globalThis.fetch=async()=>Response.json({collaborationEpoch:2,collaborationProtocol:structuralProtocol})
  await assert.rejects(requireDraftAuthority(session,signal()),error=>error instanceof DraftBootstrapError&&error.authority?.collaborationEpoch===2)
  globalThis.fetch=async()=>Response.json({collaborationEpoch:0});assert.equal((await requireDraftAuthority(session,signal())).collaborationProtocol,legacyProtocol)
 }finally{globalThis.fetch=original}
})
