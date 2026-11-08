import {test} from 'node:test'
import assert from 'node:assert/strict'
import {FixedIndex} from './fixedIndex.ts'
const manifest=(count=260,format='pptx')=>({chunkCount:count,indexPageCount:Math.ceil(count/128),revision:7,source:{format}})
function result(page:number,count=260,continuation=(sequence:number)=>false){return{page,revision:0,chunks:Array.from({length:Math.min(128,count-page*128)},(_,i)=>({sequence:page*128+i,region:'body',continuation:continuation(page*128+i)}))}}
test('remote page loads only necessary prefix metadata, shares requests and retains canonical ordinal',async()=>{
 const requests:number[]=[];let finish:((value:unknown)=>void)|undefined
 const index=new FixedIndex(manifest(),page=>{requests.push(page);return page===0?new Promise(resolve=>finish=resolve):Promise.resolve(result(page))})
 const initial=index.loadNext(),remote=index.ensurePage(200);assert.deepEqual(requests,[0]);finish!(result(0));await initial;const page=await remote;assert.deepEqual(page.sequences,[200]);assert.deepEqual(requests,[0,1]);assert.equal(index.groups().findIndex(group=>group.firstSequence===200),200);assert.equal(index.complete(),false);index.close()
})
test('continuation across an index boundary is completed before rendering a page body',async()=>{
 const calls:number[]=[];const index=new FixedIndex(manifest(132,'pdf'),async page=>{calls.push(page);return result(page,132,seq=>seq>0&&seq<130)})
 await index.loadNext();assert.equal(index.page(0),null);assert.deepEqual((await index.ensurePage(0)).sequences,Array.from({length:130},(_,i)=>i));assert.deepEqual(calls,[0,1]);assert.equal((await index.ensurePage(130)).firstSequence,130);await assert.rejects(index.ensurePage(128),/fixedLocationUnavailable/);index.close()
})
test('canceling one location stops future requests while another reader keeps the in-flight metadata',async()=>{
 const calls:number[]=[];let finish!:((value:unknown)=>void);const index=new FixedIndex(manifest(),page=>{calls.push(page);return new Promise(resolve=>finish=resolve)}),controller=new AbortController()
 const canceled=index.ensurePage(200,controller.signal),shared=index.loadNext();controller.abort();await assert.rejects(canceled);finish(result(0));await shared;assert.deepEqual(calls,[0]);assert.equal(index.entries().length,128);index.close()
})
test('invalid peer locations do not fetch; malformed metadata is not appended and can be retried',async()=>{
 const calls:number[]=[];let broken=true;const index=new FixedIndex(manifest(),async page=>{calls.push(page);return broken?{...result(page),page:9}:result(page)})
 for(const value of [-1,NaN,Infinity,260,1.5])await assert.rejects(index.ensurePage(value));assert.deepEqual(calls,[]);await assert.rejects(index.loadNext(),/fixedIndexInvalid/);assert.equal(index.entries().length,0);broken=false;await index.loadNext();assert.deepEqual(calls,[0,0]);index.close()
})
test('closing a replaced index aborts its transport and cannot publish a late response',async()=>{
 let finish!:((value:unknown)=>void),transport:AbortSignal|undefined;const index=new FixedIndex(manifest(),(_page,signal)=>{transport=signal;return new Promise(resolve=>finish=resolve)});const pending=index.loadNext();index.close();finish(result(0));await assert.rejects(pending,/fixedIndexClosed/);assert.equal(transport!.aborted,true);assert.equal(index.entries().length,0)
})

test('only a verified Word index supplies validated region identities',async()=>{
 const id='n_'+'a'.repeat(32),manifestValue=manifest(1,'docx'),valid={page:0,chunks:[{sequence:0,region:'header',continuation:false,wordRegionId:id}],wordRegionsVerified:true}
 const index=new FixedIndex(manifestValue,async()=>valid);await index.loadNext();assert.equal(index.groups()[0].wordRegionId,id);assert.equal(index.groups()[0].wordRegionsVerified,true)
 const legacy=new FixedIndex(manifestValue,async()=>({page:0,chunks:[{sequence:0,region:'header',continuation:false,wordRegionId:id}]}));await legacy.loadNext();assert.equal(legacy.groups()[0].wordRegionId,undefined)
 for(const corrupt of [{...valid,chunks:[{...valid.chunks[0],wordRegionId:'bad'}]},{...valid,chunks:[{sequence:0,region:'header',continuation:false}]},{...valid,wordRegionsVerified:false}]){const bad=new FixedIndex(manifestValue,async()=>corrupt);await assert.rejects(bad.loadNext(),/fixedIndexInvalid/)}
})

test('Word index reads every page independently of navigation, then retries a failed page',async()=>{
 const calls:number[]=[];let fail=true;const index=new FixedIndex(manifest(260,'docx'),async page=>{calls.push(page);if(page===1&&fail)throw Error('temporary outage');return result(page,260)})
 await assert.rejects(index.ensureComplete(),/temporary outage/);assert.deepEqual(calls,[0,1]);assert.equal(index.complete(),false);assert.equal(index.entries().length,128)
 fail=false;await index.ensureComplete();assert.deepEqual(calls,[0,1,1,2]);assert.equal(index.complete(),true);assert.equal(index.entries().length,260)
})

test('canceling complete-index reading does not start the following page',async()=>{
 let release!:((value:unknown)=>void);const calls:number[]=[],controller=new AbortController(),index=new FixedIndex(manifest(260,'docx'),page=>{calls.push(page);return new Promise(resolve=>release=resolve)})
 const work=index.ensureComplete(controller.signal);controller.abort(new Error('switched document'));await assert.rejects(work,/switched document/);release(result(0));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[0]);index.close()
})

test('next Word section reads only necessary pages and ignores non-body stories',async()=>{
 const calls:number[]=[];const index=new FixedIndex(manifest(390,'docx'),async page=>{
  calls.push(page);const value=result(page,390)
  if(page===1)for(const chunk of value.chunks)chunk.region='header'
  return value
 })
 await index.loadNext();assert.equal((await index.ensureNext(126,'body'))?.firstSequence,127);assert.deepEqual(calls,[0])
 assert.equal((await index.ensureNext(127,'body'))?.firstSequence,256);assert.deepEqual(calls,[0,1,2]);assert.equal(index.complete(),false)
 index.close()
})
test('canceling a next-section request does not fetch another page',async()=>{
 let release!:((value:unknown)=>void);const calls:number[]=[],index=new FixedIndex(manifest(260,'docx'),page=>{calls.push(page);return new Promise(resolve=>release=resolve)}),controller=new AbortController()
 const pending=index.ensureNext(0,'body',controller.signal);controller.abort();await assert.rejects(pending);release(result(0));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[0]);index.close()
})

test('verified Word chunks group by region across index pages and locate continuations',async()=>{
 const a='n_'+'a'.repeat(32),b='n_'+'b'.repeat(32),calls:number[]=[]
 const index=new FixedIndex(manifest(130,'docx'),async page=>{calls.push(page);return {...result(page,130),wordRegionsVerified:true,wordBodiesVerified:true,chunks:result(page,130).chunks.map(chunk=>({...chunk,wordRegionId:chunk.sequence<129?a:b}))}})
 await index.loadNext();assert.equal(index.page(0),null);assert.equal(index.page(127),null)
 const group=await index.ensurePage(127);assert.equal(group.firstSequence,0);assert.equal(group.sequences.length,129);assert.equal(index.page(128)?.firstSequence,0);assert.equal(index.page(129)?.firstSequence,129);assert.deepEqual(calls,[0,1]);index.close()
})
test('Word index rejects missing identity and a server changing verification mode',async()=>{
 const id='n_'+'a'.repeat(32);let invalid=true
 const index=new FixedIndex(manifest(129,'docx'),async page=>({...result(page,129),wordRegionsVerified:true,...(page===0||!invalid?{wordBodiesVerified:true}:{}),chunks:result(page,129).chunks.map(chunk=>({...chunk,wordRegionId:id}))}))
 await index.loadNext();await assert.rejects(index.loadNext(),/fixedIndexInvalid/);invalid=false;await index.loadNext();assert.equal(index.groups().length,1)
 const malformed=new FixedIndex(manifest(1,'docx'),async()=>({...result(0,1),wordRegionsVerified:true,wordBodiesVerified:true}))
 await assert.rejects(malformed.loadNext(),/fixedIndexInvalid/)
})
