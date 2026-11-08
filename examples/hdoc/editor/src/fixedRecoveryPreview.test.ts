import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fixedRecoveryHead,fixedRecoveryPreview,fixedRecoveryIds,fixedRecoveryImageIds} from './fixedRecoveryPreview.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',format:'xlsx',scope:'write',userId:'alice',token:'private',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),base={nodeId:'node',nodeHash:'b'.repeat(64),text:'old'},state:FixedDraftState={version:4,texts:[],images:[],attempt:null,workbookBuffer:{base,revision:0,text:'local',initial:'old',sheetId:'sheet',row:0,column:0}}
test('recovery compares the buffered cell at one explicit saved revision and rechecks current authority',async()=>{
 const old=globalThis.fetch,paths:string[]=[];let head=3,scope='write'
 globalThis.fetch=async(input)=>{const url=new URL(String(input));paths.push(url.pathname+url.search);if(url.pathname.endsWith('/auth'))return Response.json({userId:'alice',scope});if(url.pathname.endsWith('/doc'))return Response.json({revision:head,source:{sha256:source}});return Response.json({nodeId:'node',revision:Number(url.searchParams.get('revision')),text:'peer'})}
 try{const preview=await fixedRecoveryPreview(session,source,state,new AbortController().signal);assert.deepEqual(preview,{revision:3,nodes:[{id:'node',text:'peer',deleted:false,editable:null}],images:[],total:1,offset:0});assert.ok(paths.some(path=>path.endsWith('/text/node?revision=3')));head=4;assert.equal(await fixedRecoveryHead(session,source,new AbortController().signal,true),4);scope='read';await assert.rejects(fixedRecoveryHead(session,source,new AbortController().signal,true))}finally{globalThis.fetch=old}
})
test('image drafts compare every page with pinned current geometry and reject invalid or stale responses',async()=>{
 const old=globalThis.fetch,geometry={x:10,y:20,width:30,height:40,unit:'pt' as const},image={nodeId:'picture',visualHash:'c'.repeat(64),assetHash:'d'.repeat(64),geometry},drafts:FixedDraftState={version:3,texts:[],attempt:null,images:Array.from({length:13},(_,i)=>{const id=`picture${i}`;return[id,{base:{...image,nodeId:id},revision:0,geometry}]})}
 let bad=false,deleted=false,invalid=false
 globalThis.fetch=async(input)=>{const url=new URL(String(input));if(url.pathname.endsWith('/auth'))return Response.json({userId:'alice',scope:'write'});if(url.pathname.endsWith('/doc'))return Response.json({revision:8,source:{sha256:source}});const id=decodeURIComponent(url.pathname.split('/').at(-1)!);return Response.json({revision:bad?7:8,image:deleted?null:{...image,nodeId:id,...(invalid?{geometry:{...geometry,width:-1}}:{})}})}
 try{
  const first=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal),last=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal,12)
  assert.equal(first.total,13);assert.equal(first.images.length,12);assert.equal(last.images[0].id,'picture12');assert.deepEqual(last.images[0].image?.geometry,geometry)
  bad=true;await assert.rejects(fixedRecoveryPreview(session,source,drafts,new AbortController().signal));bad=false;invalid=true;await assert.rejects(fixedRecoveryPreview(session,source,drafts,new AbortController().signal));invalid=false;deleted=true;assert.equal((await fixedRecoveryPreview(session,source,drafts,new AbortController().signal,12)).images[0].image,null)
 }finally{globalThis.fetch=old}
})
test('unavailable or inconsistent preview cannot be treated as a verified comparison',async()=>{
 const old=globalThis.fetch
 try{
  for(const response of [new Response('unavailable',{status:503}),Response.json({nodeId:'wrong',revision:1,text:'forged'}),Response.json({nodeId:'node',revision:0,text:'stale'})]){
   globalThis.fetch=async(input)=>String(input).endsWith('/auth')?Response.json({userId:'alice',scope:'write'}):String(input).endsWith('/doc')?Response.json({revision:1,source:{sha256:source}}):response
   await assert.rejects(fixedRecoveryPreview(session,source,state,new AbortController().signal))
  }
  globalThis.fetch=async(input)=>String(input).endsWith('/auth')?Response.json({userId:'alice',scope:'write'}):String(input).endsWith('/doc')?Response.json({revision:1,source:{sha256:source}}):new Response('gone',{status:404})
  assert.deepEqual((await fixedRecoveryPreview(session,source,state,new AbortController().signal)).nodes,[{id:'node',text:'',deleted:true,editable:null}])
 }finally{globalThis.fetch=old}
})
test('same visible text does not hide a protected target or an unknown editability',async()=>{
 const old=globalThis.fetch;let editable:unknown=false
 globalThis.fetch=async(input)=>String(input).endsWith('/auth')?Response.json({userId:'alice',scope:'write'}):String(input).endsWith('/doc')?Response.json({revision:1,source:{sha256:source}}):Response.json({nodeId:'node',revision:1,text:'old',...(editable===null?{}:{source:{editable}})})
 try{assert.equal((await fixedRecoveryPreview(session,source,state,new AbortController().signal)).nodes[0].editable,false);editable=true;assert.equal((await fixedRecoveryPreview(session,source,state,new AbortController().signal)).nodes[0].editable,true);editable=null;assert.equal((await fixedRecoveryPreview(session,source,state,new AbortController().signal)).nodes[0].editable,null);editable='false';await assert.rejects(fixedRecoveryPreview(session,source,state,new AbortController().signal),/Invalid recovery preview/)}finally{globalThis.fetch=old}
})
test('all draft targets can be reviewed in bounded pages at an explicit version',async()=>{
 const old=globalThis.fetch,paths:string[]=[],drafts:FixedDraftState={version:3,images:[],attempt:null,texts:Array.from({length:25},(_,i)=>{const id=`node${i}`;return[id,{base:{...base,nodeId:id},revision:0,text:`local${i}`} ]})}
 globalThis.fetch=async(input)=>{const url=new URL(String(input));paths.push(url.pathname+url.search);if(url.pathname.endsWith('/auth'))return Response.json({userId:'alice',scope:'write'});if(url.pathname.endsWith('/doc'))return Response.json({revision:7,source:{sha256:source}});return Response.json({nodeId:decodeURIComponent(url.pathname.split('/').at(-1)!),revision:7,text:'peer'})}
 try{
  const first=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal),last=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal,24)
  assert.equal(first.total,25);assert.equal(first.nodes.length,12);assert.deepEqual(last.nodes.map(node=>node.id),['node24']);assert.equal(last.revision,7);assert.equal(paths.filter(path=>path.includes('/text/')).length,13)
  await assert.rejects(fixedRecoveryPreview(session,source,drafts,new AbortController().signal,25))
 }finally{globalThis.fetch=old}
})
test('pending request-only text and images are compared at the pinned revision and paginated',async()=>{
 const old=globalThis.fetch,seen:string[]=[],geometry={x:1,y:2,width:10,height:20,unit:'pt' as const},image={nodeId:'picture',visualHash:'c'.repeat(64),assetHash:'d'.repeat(64),geometry},drafts:FixedDraftState={version:3,texts:[['node',{base,revision:0,text:'later'}]],images:[],attempt:{id:'edits-test',baseRevision:0,texts:Array.from({length:13},(_,i)=>{const id=i===0?'node':`pending${i}`;return[id,{base:{...base,nodeId:id},revision:0,text:`captured${i}`}]}),images:[['picture',{base:image,revision:0,geometry}]]}}
 globalThis.fetch=async(input)=>{const url=new URL(String(input));seen.push(url.pathname+url.search);if(url.pathname.endsWith('/auth'))return Response.json({userId:'alice',scope:'write'});if(url.pathname.endsWith('/doc'))return Response.json({revision:5,source:{sha256:source}});const id=decodeURIComponent(url.pathname.split('/').at(-1)!);return url.pathname.includes('/images/')?Response.json({revision:5,image}):Response.json({nodeId:id,revision:5,text:'server'})}
 try{assert.equal(fixedRecoveryIds(drafts).length,13);assert.deepEqual(fixedRecoveryImageIds(drafts),['picture']);const first=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal),last=await fixedRecoveryPreview(session,source,drafts,new AbortController().signal,12);assert.equal(first.total,13);assert.equal(first.nodes.length,12);assert.equal(first.images[0].id,'picture');assert.equal(last.nodes[0].id,'pending12');assert.ok(seen.includes('/v1/documents/doc/images/picture?revision=5'));assert.ok(seen.includes('/v1/documents/doc/text/pending12?revision=5'))}finally{globalThis.fetch=old}
})
