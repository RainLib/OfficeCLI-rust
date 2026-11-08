import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {WordStoryTransaction,readWordStoryRecord,type WordStoryReview} from './wordStoryTransaction.ts'
import {openWordStoryRequestStore,type WordStoryStorage} from './wordStoryRequestStore.ts'
import type {Session} from './api.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),nonce='d'.repeat(32),session:Session={documentId:'doc',token:'SENSITIVE_TEST_TOKEN',userId:'alice',displayName:'Alice 王',scope:'write',format:'docx',collaborationEpoch:3,collaborationProtocol:'hcd-word-regions/2',apiUrl:'/v1/documents',collabUrl:'wss://collab.invalid'}
function review():WordStoryReview{return{schemaVersion:'hcd-word-story-preview/1',revision:1,reviewHash:'e'.repeat(64),selection:{sectionId:id(1),kind:'footer',variant:'default',transactionId:nonce},pending:{actor:{userId:'alice',displayName:'Alice 王',generation:1},request:{documentId:'doc',transactionId:nonce,expectedRevision:1,baseLayoutHash:'a'.repeat(64),candidateHash:'b'.repeat(64),actor:{userId:'alice',displayName:'Alice 王'}},intent:{sectionId:id(1),kind:'footer',variant:'default',expectedInheritedStoryId:null},story:{id:'n_'+nonce,kind:'footer',sourcePart:`word/hcd-${nonce}.xml`},blocks:[{flowRegionId:'n_'+nonce,region:'footer',readOnly:false,blockId:id(10),blockHash:'c'.repeat(64),content:{kind:'paragraph',inlines:[{text:'Independent',nodeId:id(11)}]}}],copyChoices:{referenceIds:[],extensions:[]}},summary:{section:1,inherited:false,affectedSections:1,blockCount:1}}}
const installed=()=>Response.json({transactionId:nonce,status:'installed',revision:2}),unknown=()=>Response.json({schemaVersion:'hcd-word-active-story-status/1',documentId:'doc',epoch:3,transactionId:nonce,status:'recovery-required'})
async function fixture(){const factory=new IDBFactory();return{open:async(change:Partial<Session>={})=>WordStoryTransaction.open({...session,...change},'https://editor.invalid/page',await openWordStoryRequestStore('story-record-test',factory)),read:async()=>{const store=await openWordStoryRequestStore('story-record-test',factory);try{return await store.read()}finally{store.close()}}}}
test('reviewed payload persists before dispatch and survives closing with an ambiguous success',async()=>{
 const f=await fixture(),first=await f.open(),original=globalThis.fetch
 try{
  await first.prepare(review());const before=first.record,raw=await f.read();assert.ok(raw&&!raw.includes(session.token))
  globalThis.fetch=async(_url,init)=>{assert.equal(await f.read(),raw);assert.deepEqual(JSON.parse(String(init?.body)),{epoch:3,pending:before!.review.pending,reviewHash:before!.review.reviewHash});throw Error('lost response')};await assert.rejects(first.retry());first.dispose()
  const next=await f.open({token:'new-token'});try{assert.deepEqual(next.record,before);globalThis.fetch=async(_url,init)=>{assert.deepEqual(JSON.parse(String(init?.body)),{epoch:3,pending:before!.review.pending,reviewHash:before!.review.reviewHash});return installed()};await next.retry();assert.equal(next.phase,'installed');await next.finish();assert.equal(await f.read(),null)}finally{next.dispose()}
 }finally{first.dispose();globalThis.fetch=original}
})
test('cache loss performs a signed read-only check without reapplying; cancellation keeps its durable intent',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch,paths:string[]=[]
 try{
  await tx.prepare(review());globalThis.fetch=async(url,init)=>{paths.push(String(url));if(String(url).endsWith('-status'))return unknown();assert.ok(String(url).endsWith('-check'));assert.equal(JSON.parse(String(init?.body)).pending.request.transactionId,nonce);return installed()};await tx.check();assert.equal(tx.phase,'installed');assert.equal(paths.length,2);assert.ok(paths.every(path=>!path.endsWith('-submit')));await tx.finish()
  await tx.prepare(review());globalThis.fetch=async url=>{assert.ok(String(url).endsWith('-cancel'));assert.equal(JSON.parse((await f.read())!).operation,'cancel');throw Error('lost cancel response')};await assert.rejects(tx.cancel());tx.dispose()
  const next=await f.open();try{globalThis.fetch=async url=>String(url).endsWith('-status')?Response.json({schemaVersion:'hcd-word-active-story-status/1',documentId:'doc',epoch:3,transactionId:nonce,status:'pending'}):Response.json({transactionId:nonce,status:'not-prepared'});await next.check();assert.equal(next.phase,'cancelled');await next.finish();assert.equal(await f.read(),null)}finally{next.dispose()}
 }finally{tx.dispose();globalThis.fetch=original}
})
test('wrong receipts and explicit refusals cannot clear an unknown request or allow discard',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch
 try{
  await tx.prepare(review());const raw=tx.backup
  for(const response of [()=>new Response('{}',{status:409}),()=>Response.json({transactionId:nonce,status:'installed',revision:3}),()=>Response.json({transactionId:'a'.repeat(32),status:'installed',revision:2})]){globalThis.fetch=async()=>response();await assert.rejects(tx.retry());assert.equal(tx.phase,'pending');assert.equal(tx.backup,raw);await assert.rejects(tx.finish())}
 }finally{tx.dispose();globalThis.fetch=original}
})
test('IDB compare-and-set prevents two windows from replacing each other before submission',async()=>{
 const f=await fixture(),a=await f.open(),b=await f.open()
 try{
  const results=await Promise.allSettled([a.prepare(review()),b.prepare({...review(),reviewHash:'f'.repeat(64)})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1)
  const saved=readWordStoryRecord(JSON.parse((await f.read())!),session);assert.ok(['e'.repeat(64),'f'.repeat(64)].includes(saved.review.reviewHash));await b.refresh();assert.deepEqual(b.record,saved)
 }finally{a.dispose();b.dispose()}
})
test('storage refusal prevents any submission; corrupted or foreign records stay available as backups',async()=>{
 const storage:WordStoryStorage={read:async()=>null,replace:async()=>{throw Error('quota')},close:()=>{}},tx=await WordStoryTransaction.open(session,'https://editor.invalid/page',storage),original=globalThis.fetch;let sends=0
 try{globalThis.fetch=async()=>{sends++;return installed()};await assert.rejects(tx.prepare(review()));assert.equal(sends,0);assert.equal(tx.record,null)}finally{tx.dispose();globalThis.fetch=original}
 const f=await fixture(),a=await f.open();await a.prepare(review());const raw=a.backup;a.dispose();const b=await f.open({collaborationEpoch:4});try{assert.equal(b.phase,'invalid');assert.equal(b.backup,raw);await assert.rejects(b.prepare(review()));await assert.rejects(b.finish())}finally{b.dispose()}
})
test('busy operations cannot switch an in-flight request to cancellation and late responses after disposal do not finish it',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch;let release!:(value:Response)=>void,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve})
 try{
  await tx.prepare(review());globalThis.fetch=()=>new Promise(resolve=>{release=resolve;started()});const a=tx.retry(),b=tx.retry();assert.equal(a,b);await assert.rejects(tx.cancel(),/busy/);await entered;tx.dispose();await assert.rejects(a);release(installed());const next=await f.open();try{assert.equal(next.phase,'pending');assert.equal(next.record!.operation,'apply')}finally{next.dispose()}
 }finally{tx.dispose();globalThis.fetch=original}
})
test('review parsing rejects changed target, candidate, actor, summary and unsupported resource choices',async()=>{
 const record={schemaVersion:'hcd-word-story-request/1',epoch:3,operation:'apply',review:review()}
 for(const mutate of [(v:any)=>{v.review.selection.variant='even'},(v:any)=>{v.review.pending.actor.userId='bob'},(v:any)=>{v.review.summary.blockCount=2},(v:any)=>{v.review.pending.copyChoices.extensions=[{}]},(v:any)=>{v.extra=true}]){const v=structuredClone(record);mutate(v);assert.throws(()=>readWordStoryRecord(v,session))}
 await assert.rejects(WordStoryTransaction.open({...session,scope:'read'},'https://editor.invalid/page'))
})

test('an aborted IDB read rejects cleanly and retains the exact device request',async()=>{
 const factory=new IDBFactory(),store=await openWordStoryRequestStore('read-fault',factory);await store.replace(null,'retained-original-request')
 const opening=factory.open('read-fault'),probe=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)}),prototype=Object.getPrototypeOf(probe),descriptor=Object.getOwnPropertyDescriptor(prototype,'transaction')!,original=descriptor.value
 try{
  Object.defineProperty(prototype,'transaction',{...descriptor,value:function(this:IDBDatabase,...args:unknown[]){const tx=original.apply(this,args);if(args[1]==='readonly')queueMicrotask(()=>tx.abort());return tx}})
  await assert.rejects(store.read(),error=>error instanceof Error&&error.name==='AbortError')
  await new Promise(resolve=>setImmediate(resolve))
 }finally{Object.defineProperty(prototype,'transaction',descriptor);probe.close()}
 try{assert.equal(await store.read(),'retained-original-request')}finally{store.close()}
})
