import {test} from 'node:test'
import assert from 'node:assert/strict'
import {compareRecoveryImageBaselines} from './recoveryImageBaselines.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',token:'test',scope:'write',format:'docx',apiUrl:'https://owned.test/v1/documents'},node='n_'+'a'.repeat(32),base={nodeId:node,visualHash:'b'.repeat(64),assetHash:'d'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:10}},draft:SharedImageDraft={intentId:crypto.randomUUID(),clientId:42,ancestors:[],touched:['width'],base,geometry:{...base.geometry,width:25},revision:1}
const signal=()=>new AbortController().signal
function mock(handler:(url:URL)=>Response|Promise<Response>){const old=globalThis.fetch;globalThis.fetch=async input=>handler(new URL(String(input)));return()=>{globalThis.fetch=old}}
test('pinned saved image reports a verified baseline and a later changed image',async()=>{
 let headReads=0;const paths:string[]=[],restore=mock(url=>{if(url.pathname.endsWith('/documents/doc')){headReads++;return Response.json({revision:2,rootHash:'a'.repeat(64)})}paths.push(url.href);const revision=Number(url.searchParams.get('revision'));return Response.json({revision,image:revision===1?base:{...base,visualHash:'c'.repeat(64),geometry:{...base.geometry,width:35}}})})
 try{const report=await compareRecoveryImageBaselines(session,[draft,{...draft,intentId:crypto.randomUUID()}],signal());assert.equal(report.headRevision,2);assert.deepEqual(report.items.map(item=>[item.baseline,item.current]),[['verified','changed'],['verified','changed']]);assert.equal(paths.length,2);assert.equal(headReads,2)}finally{restore()}
})
test('missing or mismatched historical baseline and deleted current target stay explicit',async()=>{
 let historical:unknown=null;const restore=mock(url=>url.pathname.endsWith('/documents/doc')?Response.json({revision:2,rootHash:'a'.repeat(64)}):Response.json({revision:Number(url.searchParams.get('revision')),image:url.searchParams.get('revision')==='1'?historical:null}))
 try{let result=await compareRecoveryImageBaselines(session,[draft],signal());assert.equal(result.items[0].baseline,'missing');assert.equal(result.items[0].current,'deleted');historical={...base,geometry:{...base.geometry,width:30}};result=await compareRecoveryImageBaselines(session,[draft],signal());assert.equal(result.items[0].baseline,'mismatch');assert.equal(result.items[0].current,'deleted')}finally{restore()}
})
test('head changes, malformed replies and permission failures prevent comparison',async()=>{
 let reads=0;const restore=mock(url=>{if(url.pathname.endsWith('/documents/doc'))return Response.json({revision:2,rootHash:(++reads===1?'a':'b').repeat(64)});return Response.json({revision:Number(url.searchParams.get('revision')),image:base})})
 try{await assert.rejects(compareRecoveryImageBaselines(session,[draft],signal()),/recoveryArchiveChanged/)}finally{restore()}
 const bad=mock(url=>url.pathname.endsWith('/documents/doc')?Response.json({revision:2,rootHash:'a'.repeat(64)}):Response.json({revision:99,image:base}));try{await assert.rejects(compareRecoveryImageBaselines(session,[draft],signal()),/recoveryArchiveInvalid/)}finally{bad()}
 const denied=mock(url=>url.pathname.endsWith('/documents/doc')?Response.json({revision:2,rootHash:'a'.repeat(64)}):new Response('',{status:403}));try{await assert.rejects(compareRecoveryImageBaselines(session,[draft],signal()),/403/)}finally{denied()}
})
test('field comparison distinguishes disjoint, identical and conflicting changes only with a verified baseline',async()=>{
 const desired:SharedImageDraft={...draft,touched:['x','width','height','assetHash'],geometry:{...base.geometry,x:5,width:25,height:15},assetHash:'e'.repeat(64)}
 let historic=base
 const saved={...base,visualHash:'c'.repeat(64),geometry:{...base.geometry,y:3,width:25,height:30},assetHash:'f'.repeat(64)}
 const restore=mock(url=>url.pathname.endsWith('/documents/doc')?Response.json({revision:2,rootHash:'a'.repeat(64)}):Response.json({revision:Number(url.searchParams.get('revision')),image:url.searchParams.get('revision')==='1'?historic:saved}))
 try{
  let report=await compareRecoveryImageBaselines(session,[desired],signal())
  assert.deepEqual(report.items[0].fields,[{field:'x',status:'draftOnly'},{field:'y',status:'savedOnly'},{field:'width',status:'sameResult'},{field:'height',status:'conflict'},{field:'assetHash',status:'conflict'}])
  historic={...base,geometry:{...base.geometry,width:99}}
  report=await compareRecoveryImageBaselines(session,[desired],signal())
  assert.equal(report.items[0].baseline,'mismatch');assert.equal(report.items[0].fields,null)
 }finally{restore()}
})
