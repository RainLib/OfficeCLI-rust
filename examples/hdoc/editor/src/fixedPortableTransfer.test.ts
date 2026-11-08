import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {FixedImageChoice} from './fixedImageFiles.ts'
import {fixedImageHash,FixedImageFileJournal} from './fixedImageFiles.ts'
import {FixedDraftJournal} from './fixedDraftJournal.ts'
import {FixedPortableJournal} from './fixedPortableJournal.ts'
import {createFixedPortableArchive} from './fixedPortableArchive.ts'
import {prepareFixedPortableTransfer,repinFixedPortableAssets} from './fixedPortableTransfer.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'pptx',apiUrl:'http://test/v1/documents'},source='a'.repeat(64),base='http://test/',name='hcd-fixed-draft-v1-'+'a'.repeat(64)+'-'+'b'.repeat(64)
const geometry={x:1,y:2,width:3,height:4,unit:'pt' as const},image={nodeId:'image',visualHash:'b'.repeat(64),geometry},png=new Uint8Array([137,80,78,71,13,10,26,10,1,2])
async function setup(){
 const factory=new IDBFactory(),drafts=await FixedDraftJournal.open(name,factory),images=await FixedImageFileJournal.open(name+'-imagefiles1',factory),transfers=await FixedPortableJournal.open(name+'-portable1',factory),hash=await fixedImageHash(png)
 const choice:FixedImageChoice={version:1,id:'00000000-0000-4000-8000-000000000000',name:'original.png',extension:'png',hash,bytes:png,base:image,revision:0,phase:'chosen'}
 const state:FixedDraftState={version:3,texts:[],images:[['image',{base:image,revision:0,geometry,assetHash:hash}]],attempt:null}
 const bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>png})
 const original=globalThis.fetch,server={revision:0,scope:'write',posts:0,repins:0,fail:false,advance:false,assets:false}
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes('/auth'))return Response.json({scope:server.scope,userId:'alice'});if(url.endsWith('/resources/reuse')){server.repins++;return server.assets?Response.json({hash,byteLength:png.length}):new Response('',{status:404})}if(url.includes('/staged-assets')){if(init?.method!=='POST')return server.assets?new Response(png):new Response('',{status:404});server.posts++;if(server.fail)return new Response('offline',{status:503});if(server.advance)server.revision++;server.assets=true;return Response.json({hash,byteLength:png.length})}if(url.includes('/assets/'))return new Response('',{status:404});if(url.includes('/images/'))return Response.json({revision:Number(new URL(url).searchParams.get('revision')),image});return Response.json({revision:server.revision,source:{sha256:source}})}
 const prepare=(data=bytes)=>prepareFixedPortableTransfer({bytes:data,session,sourceHash:source,base,signal:new AbortController().signal})
 const confirm=(prepared:Awaited<ReturnType<typeof prepare>>,override:Partial<{drafts:FixedDraftJournal;images:FixedImageFileJournal;transfers:FixedPortableJournal;signal:AbortSignal}>={})=>prepared.confirm({drafts,images,transfers,signal:new AbortController().signal,locked:async work=>work(),...override})
 return {factory,drafts,images,transfers,bytes,server,prepare,confirm,close:()=>{drafts.close();images.close();transfers.close();globalThis.fetch=original}}
}

test('review is read-only and confirmation imports one durable branch and task',async()=>{
 const f=await setup();try{const prepared=await f.prepare();assert.equal(prepared.review.revision,0);assert.equal(prepared.review.choices[0].changed,false);assert.equal(f.server.posts,0);assert.deepEqual(await f.transfers.pending(),[]);assert.deepEqual(await f.drafts.copies(),[])
  assert.equal((await f.confirm(prepared)).alreadyComplete,false);assert.equal(f.server.posts,1);assert.equal((await f.drafts.copies()).length,1);assert.equal((await f.images.list()).length,1);assert.deepEqual(await f.transfers.pending(),[])
  assert.equal((await f.confirm(prepared)).alreadyComplete,true);assert.equal(f.server.posts,1);assert.equal((await f.drafts.copies()).length,1)
 }finally{f.close()}
})
test('review and confirmation retain the original source identity when caller input changes',async()=>{
 const f=await setup(),bytes=Uint8Array.from(f.bytes),original=Uint8Array.from(bytes),mutableSession={...session},input={bytes,session:mutableSession,sourceHash:source,base,signal:new AbortController().signal}
 try{
  const preparing=prepareFixedPortableTransfer(input)
  bytes.fill(0);input.sourceHash='f'.repeat(64);input.base='http://changed/';mutableSession.documentId='other'
  const prepared=await preparing
  assert.deepEqual(prepared.archiveBytes(),original);assert.equal((await f.confirm(prepared)).alreadyComplete,false)
  assert.equal((await f.drafts.copies()).length,1);assert.equal((await f.images.list()).length,1)
 }finally{f.close()}
})
test('a failed transfer retains the archive and retries the partially imported work without duplication',async()=>{
 const f=await setup();try{const prepared=await f.prepare();let fail=true;const drafts={importCopy:async(...args:Parameters<FixedDraftJournal['importCopy']>)=>{if(fail)throw Error('disk');return f.drafts.importCopy(...args)}} as FixedDraftJournal
  await assert.rejects(f.confirm(prepared,{drafts}),/disk/);assert.equal((await f.transfers.pending()).length,1);assert.equal((await f.images.list()).length,1);assert.equal((await f.drafts.copies()).length,0)
  const pending=(await f.transfers.pending())[0],reopened=await f.prepare(pending.bytes);fail=false;await f.confirm(reopened,{drafts});assert.equal((await f.images.list()).length,1);assert.equal((await f.drafts.copies()).length,1);assert.deepEqual(await f.transfers.pending(),[])
 }finally{f.close()}
})
test('peer changes and revoked access invalidate confirmation without losing the review',async()=>{
 const f=await setup();try{const prepared=await f.prepare();f.server.revision=1;await assert.rejects(f.confirm(prepared),/review-changed/);assert.equal(f.server.posts,0);assert.deepEqual(await f.transfers.pending(),[])
  f.server.revision=0;f.server.advance=true;await assert.rejects(f.confirm(prepared),/review-changed/);assert.equal((await f.transfers.pending()).length,1);assert.deepEqual(await f.images.list(),[]);assert.deepEqual(await f.drafts.copies(),[])
  f.server.advance=false;f.server.revision=0;f.server.scope='read';await assert.rejects(f.confirm(prepared));assert.equal((await f.transfers.pending()).length,1)
 }finally{f.close()}
})
test('wrong account is rejected before any network or storage operation',async()=>{
 const f=await setup();try{const altered={...session,userId:'bob'};let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected')};await assert.rejects(prepareFixedPortableTransfer({bytes:f.bytes,session:altered,sourceHash:source,base,signal:new AbortController().signal}));assert.equal(calls,0);assert.deepEqual(await f.transfers.pending(),[])}finally{f.close()}
})
test('large comparisons load only the requested page and reject a changed revision',async()=>{
 const old=globalThis.fetch;let revision=0,textReads=0
 const texts=Array.from({length:13},(_,index)=>{const id=`node-${index}`;return [id,{base:{nodeId:id,nodeHash:'c'.repeat(64),text:'before'},revision:0,text:`draft-${index}`}]}) as FixedDraftState['texts']
 const state:FixedDraftState={version:3,texts,images:[],attempt:null},bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[],readAsset:async()=>{throw Error('unexpected')}})
 globalThis.fetch=async input=>{const url=String(input);if(url.endsWith('/auth'))return Response.json({scope:'write',userId:'alice'});if(url.includes('/text/')){textReads++;const parsed=new URL(url);return Response.json({nodeId:decodeURIComponent(parsed.pathname.split('/').at(-1)!),revision:Number(parsed.searchParams.get('revision')),text:'server'})}return Response.json({revision,source:{sha256:source}})}
 try{const candidate=await prepareFixedPortableTransfer({bytes,session,sourceHash:source,base,signal:new AbortController().signal});assert.equal(candidate.review.pages.length,1);assert.equal(candidate.review.pages[0].total,13);assert.equal(textReads,12);assert.equal((await candidate.loadPage(12,new AbortController().signal)).nodes.length,1);assert.equal(textReads,13);revision=1;await assert.rejects(candidate.loadPage(12,new AbortController().signal),/review-changed/)}finally{globalThis.fetch=old}
})
test('cancelling while staging leaves the write-ahead file for explicit review',async()=>{
 const f=await setup();try{const prepared=await f.prepare(),prior=globalThis.fetch,controller=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve)
  globalThis.fetch=async(input,init)=>{if(String(input).includes('/staged-assets')&&init?.method==='POST'){entered();return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}))}return prior(input,init)}
  const run=f.confirm(prepared,{signal:controller.signal});await started;controller.abort(new Error('stop'));await assert.rejects(run,/stop/);assert.equal((await f.transfers.pending()).length,1);assert.deepEqual(await f.drafts.copies(),[]);assert.deepEqual(await f.images.list(),[])
 }finally{f.close()}
})
test('repeated import reuses verified images and replenishes missing ones without duplicating tasks',async()=>{
 const f=await setup();try{const prepared=await f.prepare();await f.confirm(prepared);assert.equal(f.server.posts,1);await f.confirm(prepared);assert.equal(f.server.posts,1);assert.equal(f.server.repins,2)
  f.server.assets=false;assert.equal((await f.confirm(prepared)).alreadyComplete,true);assert.equal(f.server.posts,2);assert.equal((await f.drafts.copies()).length,1);assert.equal((await f.images.list()).length,1)
 }finally{f.close()}
})
test('resource re-pinning is bounded and stops before the next batch when the reviewed head changes',async()=>{
 const resources=new Map<string,Uint8Array>()
 for(let i=0;i<7;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch;let started=0,finished=0,checks=0,release!:()=>void,ready!:()=>void
 const gate=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>ready=resolve)
 globalThis.fetch=async(_input,init)=>{started++;if(started===4)ready();await gate;finished++;const body=JSON.parse(String(init!.body));return Response.json({hash:body.hash,byteLength:body.byteLength})}
 try{
  const work=repinFixedPortableAssets(session,[...resources.keys()],resources,new AbortController().signal,async()=>{checks++;throw Error('fixed-portable-review-changed')})
  await entered;assert.equal(started,4);release();await assert.rejects(work,/review-changed/)
  assert.equal(finished,4);assert.equal(started,4);assert.ok(checks>=1&&checks<=3)
 }finally{release();globalThis.fetch=old}
})
test('a failed resource waits for the whole started batch and never checks or starts later resources',async()=>{
 const resources=new Map<string,Uint8Array>()
 for(let i=0;i<6;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch;let started=0,finished=0,checks=0,ready!:()=>void
 const entered=new Promise<void>(resolve=>ready=resolve)
 globalThis.fetch=async(_input,init)=>{const index=++started;if(started===4)ready();await entered;finished++;if(index===2)return new Response('',{status:403});const body=JSON.parse(String(init!.body));return Response.json({hash:body.hash,byteLength:body.byteLength})}
 try{await assert.rejects(repinFixedPortableAssets(session,[...resources.keys()],resources,new AbortController().signal,async()=>{checks++}),/403/);assert.equal(started,4);assert.equal(finished,4);assert.equal(checks,0)}finally{globalThis.fetch=old}
})
test('a fixed portable resource failure cancels sibling requests and preserves the failure',async()=>{
 const resources=new Map<string,Uint8Array>()
 for(let i=0;i<6;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch;let started=0,aborted=0,checks=0,ready!:()=>void
 const entered=new Promise<void>(resolve=>ready=resolve)
 globalThis.fetch=async(_input,init)=>{const index=++started;if(started===4)ready();await entered;if(index===2)return new Response('',{status:403});return new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;if(signal.aborted){aborted++;reject(signal.reason);return}signal.addEventListener('abort',()=>{aborted++;reject(signal.reason)},{once:true})})}
 try{await assert.rejects(repinFixedPortableAssets(session,[...resources.keys()],resources,new AbortController().signal,async()=>{checks++}),/403/);assert.equal(started,4);assert.equal(aborted,3);assert.equal(checks,0)}finally{globalThis.fetch=old}
})
test('successful distinct resources are deduplicated and recheck the head',async()=>{
 const resources=new Map<string,Uint8Array>()
 for(let i=0;i<6;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch;let active=0,max=0,checks=0,posts=0
 globalThis.fetch=async(_input,init)=>{posts++;active++;max=Math.max(active,max);await new Promise(resolve=>setTimeout(resolve,5));active--;const body=JSON.parse(String(init!.body));return Response.json({hash:body.hash,byteLength:body.byteLength})}
 try{const hashes=[...resources.keys()];await repinFixedPortableAssets(session,[...hashes,hashes[0]],resources,new AbortController().signal,async()=>{checks++});assert.equal(posts,6);assert.equal(max,4);assert.ok(checks>=2&&checks<=3)}finally{globalThis.fetch=old}
})
test('fixed recovery starts later resources while a slow asset remains in flight',async()=>{
 const resources=new Map<string,Uint8Array>();for(let i=0;i<6;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch;let active=0,peak=0,started=0,checks=0,release!:()=>void,ready!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),fifth=new Promise<void>(resolve=>{ready=resolve})
 globalThis.fetch=async(_input,init)=>{const index=++started;peak=Math.max(peak,++active);if(index===5)ready();try{if(index===1)await gate;const body=JSON.parse(String(init!.body));return Response.json({hash:body.hash,byteLength:body.byteLength})}finally{active--}}
 try{const work=repinFixedPortableAssets(session,[...resources.keys()],resources,new AbortController().signal,async()=>{checks++});await fifth;assert.ok(started>=5);assert.ok(peak<=4);assert.equal(active,1);assert.ok(checks>=1);release();await work;assert.equal(started,6)}finally{release();globalThis.fetch=old}
})
test('missing recovery bytes reject the whole set before any request',async()=>{
 const hash=await fixedImageHash(png),missing='f'.repeat(64),old=globalThis.fetch;let requests=0
 globalThis.fetch=async()=>{requests++;throw Error('unexpected request')}
 try{await assert.rejects(repinFixedPortableAssets(session,[hash,missing],new Map([[hash,png]]),new AbortController().signal,async()=>{}),/fixed-portable-integrity/);assert.equal(requests,0)}finally{globalThis.fetch=old}
})
test('resource staging captures session and bytes before asynchronous work',async()=>{
 const bytes=Uint8Array.from(png),expected=Uint8Array.from(bytes),hash=await fixedImageHash(bytes),resources=new Map([[hash,bytes]]),mutableSession={...session},hashes=[hash],old=globalThis.fetch;let uploaded:Uint8Array|undefined,paths:string[]=[]
 globalThis.fetch=async(input,init)=>{paths.push(String(input));if(String(input).endsWith('/resources/reuse'))return new Response('',{status:404});uploaded=new Uint8Array(await (init!.body as Blob).arrayBuffer());return Response.json({hash,byteLength:expected.length})}
 try{const work=repinFixedPortableAssets(mutableSession,hashes,resources,new AbortController().signal,async()=>{});mutableSession.documentId='other';bytes.fill(0);resources.clear();hashes.length=0;await work;assert.deepEqual(uploaded,expected);assert.ok(paths.every(path=>path.includes('/documents/doc/')))}finally{globalThis.fetch=old}
})
test('cancellation stops waiting for a stalled review check and never stages late work',async()=>{
 const resources=new Map<string,Uint8Array>();for(let i=0;i<6;i++){const bytes=Uint8Array.from([...png,i]);resources.set(await fixedImageHash(bytes),bytes)}
 const old=globalThis.fetch,controller=new AbortController();let started=0,entered!:()=>void,release!:()=>void,ready!:()=>void
 const checking=new Promise<void>(resolve=>{entered=resolve}),blocked=new Promise<void>(resolve=>{release=resolve}),allStarted=new Promise<void>(resolve=>{ready=resolve})
 globalThis.fetch=async(_input,init)=>{if(++started===4)ready();await allStarted;const body=JSON.parse(String(init!.body));return Response.json({hash:body.hash,byteLength:body.byteLength})}
 try{const work=repinFixedPortableAssets(session,[...resources.keys()],resources,controller.signal,async()=>{entered();await blocked});await checking;assert.equal(started,4);controller.abort(new Error('stop review'));await assert.rejects(work,/stop review/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(started,4)}finally{release();globalThis.fetch=old}
})
