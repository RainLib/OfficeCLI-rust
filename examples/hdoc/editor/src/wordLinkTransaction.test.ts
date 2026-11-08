import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {WordLinkTransaction,readWordLinkRecord,type WordLinkReview} from './wordLinkTransaction.ts'
import {openWordStoryRequestStore,type WordStoryStorage} from './wordStoryRequestStore.ts'
import type {Session} from './api.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),nonce='d'.repeat(32),session:Session={documentId:'doc',token:'SENSITIVE_TEST_TOKEN',userId:'alice',displayName:'Alice 王',scope:'write',format:'docx',collaborationEpoch:3,collaborationProtocol:'hcd-word-regions/2',apiUrl:'/v1/documents',collabUrl:'wss://collab.invalid'}
const layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:true,sections:[1,2,3].map(n=>({id:id(n),differentFirstPage:false,page:{},headers:n===1?{default:id(5)}:n===2?{default:id(6)}:{},footers:{}})),stories:[5,6].map(n=>({id:id(n),kind:'header' as const,sourcePart:`word/header${n}.xml`}))}
function review():WordLinkReview{
 const transaction={schemaVersion:'hcd-word-story-link/1' as const,documentId:'doc',transactionId:nonce,expectedRevision:1,actor:{userId:'alice',displayName:'Alice 王'},link:{baseLayoutHash:'a'.repeat(64),sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedDirectStoryId:id(6)}}
 return{schemaVersion:'hcd-word-link-preview/1',revision:1,reviewHash:'e'.repeat(64),nativeReviewHash:'f'.repeat(64),candidateLayoutHash:'b'.repeat(64),selection:{sectionId:id(2),kind:'header',variant:'default',transactionId:nonce},transaction,pending:{request:transaction,actor:{...transaction.actor,generation:1},candidateLayoutHash:'b'.repeat(64),reviewHash:'f'.repeat(64)},summary:{section:2,retainedStoryId:id(6),inheritedStoryId:id(5),inheritedSection:1,affectedSections:2,affectedSectionNumbers:[2,3],contentChanges:true}}
}
const installed=()=>Response.json({transactionId:nonce,status:'installed',revision:2}),unknown=()=>Response.json({schemaVersion:'hcd-word-active-link-status/1',documentId:'doc',epoch:3,transactionId:nonce,status:'recovery-required'})
async function fixture(){const factory=new IDBFactory();return{open:async(change:Partial<Session>={})=>WordLinkTransaction.open({...session,...change},'https://editor.invalid/page',await openWordStoryRequestStore('link-record-test',factory,'word-link')),read:async()=>{const store=await openWordStoryRequestStore('link-record-test',factory,'word-link');try{return await store.read()}finally{store.close()}}}}
test('full link request persists before dispatch, survives close and uses renewed credentials',async()=>{
 const f=await fixture(),first=await f.open(),original=globalThis.fetch
 try{
  await first.prepare(review());const before=first.record,raw=await f.read();assert.ok(raw&&!raw.includes(session.token))
  globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('-submit'));assert.equal(await f.read(),raw);assert.equal(new Headers(init?.headers).get('X-HCD-Word-Link-Version'),'1');assert.deepEqual(JSON.parse(String(init?.body)),{epoch:3,pending:before!.review.pending,reviewHash:before!.review.reviewHash});throw Error('lost response')};await assert.rejects(first.retry());first.dispose()
  const next=await f.open({token:'renewed-token'});try{assert.deepEqual(next.record,before);globalThis.fetch=async(_url,init)=>{assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer renewed-token');assert.deepEqual(JSON.parse(String(init?.body)),{epoch:3,pending:before!.review.pending,reviewHash:before!.review.reviewHash});return installed()};await next.retry();assert.equal(next.phase,'installed');await next.finish();assert.equal(await f.read(),null)}finally{next.dispose()}
 }finally{first.dispose();globalThis.fetch=original}
})
test('status cache loss only checks a native receipt; cancellation intent survives reopening',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch,paths:string[]=[]
 try{
  await tx.prepare(review());globalThis.fetch=async(url,init)=>{paths.push(String(url));if(String(url).endsWith('-status'))return unknown();assert.ok(String(url).endsWith('-check'));assert.equal(JSON.parse(String(init?.body)).pending.request.transactionId,nonce);return installed()};await tx.check();assert.equal(tx.phase,'installed');assert.equal(paths.length,2);assert.ok(paths.every(path=>!path.endsWith('-submit')));await tx.finish()
  await tx.prepare(review());globalThis.fetch=async url=>{assert.ok(String(url).endsWith('-cancel'));assert.equal(JSON.parse((await f.read())!).operation,'cancel');throw Error('lost cancel response')};await assert.rejects(tx.cancel());tx.dispose()
  const next=await f.open();try{globalThis.fetch=async url=>String(url).endsWith('-status')?unknown():Response.json({transactionId:nonce,status:'not-prepared'});await next.check();assert.equal(next.phase,'cancelled');assert.equal(next.record!.operation,'cancel');await next.finish();assert.equal(await f.read(),null)}finally{next.dispose()}
 }finally{tx.dispose();globalThis.fetch=original}
})
test('wrong or refused receipts cannot clear an unknown original request',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch
 try{
  await tx.prepare(review());const raw=tx.backup
  for(const response of [()=>new Response('{}',{status:409}),()=>Response.json({transactionId:nonce,status:'installed',revision:3}),()=>Response.json({transactionId:'a'.repeat(32),status:'installed',revision:2}),()=>Response.json({transactionId:nonce,status:'installed',revision:2,extra:true})]){globalThis.fetch=async()=>response();await assert.rejects(tx.retry());assert.equal(tx.phase,'pending');assert.equal(tx.backup,raw);await assert.rejects(tx.finish())}
  globalThis.fetch=async()=>Response.json({schemaVersion:'hcd-word-active-link-status/1',documentId:'other',epoch:3,transactionId:nonce,status:'installed',revision:2});await assert.rejects(tx.check());assert.equal(tx.backup,raw)
 }finally{tx.dispose();globalThis.fetch=original}
})
test('cross-window CAS prevents overwriting another reviewed link',async()=>{
 const f=await fixture(),a=await f.open(),b=await f.open()
 try{const results=await Promise.allSettled([a.prepare(review()),b.prepare({...review(),reviewHash:'0'.repeat(64)})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);const saved=readWordLinkRecord(JSON.parse((await f.read())!),session);await b.refresh();assert.deepEqual(b.record,saved)}finally{a.dispose();b.dispose()}
})
test('quota failure sends nothing and foreign records remain downloadable without enabling submission',async()=>{
 const storage:WordStoryStorage={read:async()=>null,replace:async()=>{throw Error('quota')},close:()=>{}},tx=await WordLinkTransaction.open(session,'https://editor.invalid/page',storage),original=globalThis.fetch;let sends=0
 try{globalThis.fetch=async()=>{sends++;return installed()};await assert.rejects(tx.prepare(review()));assert.equal(sends,0);assert.equal(tx.record,null)}finally{tx.dispose();globalThis.fetch=original}
 for(const change of [{collaborationEpoch:4},{displayName:'Renamed Alice'}]){const f=await fixture(),a=await f.open();await a.prepare(review());const raw=a.backup;a.dispose();const b=await f.open(change);try{assert.equal(b.phase,'invalid');assert.equal(b.backup,raw);await assert.rejects(b.prepare(review()));await assert.rejects(b.finish())}finally{b.dispose()}}
 await assert.rejects(WordLinkTransaction.open({...session,scope:'read'},'https://editor.invalid/page'))
})
test('busy operations cannot change intent and a late response after disposal cannot finish the request',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch;let release!:(value:Response)=>void,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve})
 try{await tx.prepare(review());globalThis.fetch=()=>new Promise(resolve=>{release=resolve;started()});const a=tx.retry(),b=tx.retry();assert.equal(a,b);await assert.rejects(tx.cancel(),/busy/);await entered;tx.dispose();await assert.rejects(a);release(installed());const next=await f.open();try{assert.equal(next.phase,'pending');assert.equal(next.record!.operation,'apply')}finally{next.dispose()}}finally{tx.dispose();globalThis.fetch=original}
})
test('review metadata is bound to the native target, author, version and candidate',()=>{
 const record={schemaVersion:'hcd-word-link-request/1',epoch:3,operation:'apply',review:review()}
 for(const mutate of [(v:any)=>{v.review.selection.variant='even'},(v:any)=>{v.review.pending.actor.userId='bob'},(v:any)=>{v.review.summary.retainedStoryId=id(5)},(v:any)=>{v.review.summary.inheritedSection=2},(v:any)=>{v.review.summary.affectedSectionNumbers=[3,2]},(v:any)=>{v.review.nativeReviewHash='0'.repeat(64)},(v:any)=>{v.review.transaction={...v.review.transaction,expectedRevision:5}},(v:any)=>{v.review.pending.candidateLayoutHash='0'.repeat(64)},(v:any)=>{v.review.summary.contentChanges=false},(v:any)=>{v.extra=true}]){const v=structuredClone(record);mutate(v);assert.throws(()=>readWordLinkRecord(v,session))}
 const empty=structuredClone(record);empty.review.summary.inheritedStoryId=null;empty.review.summary.inheritedSection=null;assert.ok(readWordLinkRecord(empty,session))
 const same=structuredClone(record);same.review.summary.inheritedStoryId=id(6);same.review.summary.affectedSectionNumbers=[];same.review.summary.affectedSections=0;same.review.summary.contentChanges=false;assert.ok(readWordLinkRecord(same,session))
})
test('preview verifies inherited source, effect list, pinned layout and cancellation without persisting',async()=>{
 const f=await fixture(),tx=await f.open(),original=globalThis.fetch;let calls=0
 try{globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('-preview'));const selection=JSON.parse(String(init?.body)).selection,v=review();v.selection=selection;v.transaction.transactionId=selection.transactionId;v.pending.request.transactionId=selection.transactionId;calls++;return Response.json(v)};const v=await tx.preview({layout,layoutHash:'a'.repeat(64),revision:1},id(2),'header','default',new AbortController().signal);assert.equal(v.summary.inheritedSection,1);assert.deepEqual(v.summary.affectedSectionNumbers,[2,3]);assert.equal(tx.backup,null);await assert.rejects(tx.preview({layout,layoutHash:'0'.repeat(64),revision:1},id(2),'header','default',new AbortController().signal),/review-changed/);const abort=new AbortController();abort.abort();await assert.rejects(tx.preview({layout,layoutHash:'a'.repeat(64),revision:1},id(2),'header','default',abort.signal));assert.equal(calls,2);assert.equal(tx.phase,'idle')}finally{tx.dispose();globalThis.fetch=original}
})
