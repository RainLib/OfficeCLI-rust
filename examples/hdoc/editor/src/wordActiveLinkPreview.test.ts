import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {previewActiveWordLink} from './wordActiveLinkPreview.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash='a'.repeat(64),rootHash='b'.repeat(64),actor={userId:'alice',displayName:'Alice 王'}
function fixture(){
 const document=new Y.Doc(),schema=wordRegionSchema(),layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:true,sections:[1,2,3].map(n=>({id:id(n),differentFirstPage:false,page:{},headers:n===1?{default:id(5)}:n===2?{default:id(6)}:{},footers:{}})),stories:[5,6].map(n=>({id:id(n),kind:'header' as const,sourcePart:`word/header${n}.xml`}))}
 const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayout:layout,flowLayoutHash:hash,blocks:[1,2,3,5,6].map((n,index)=>({flowRegionId:id(n),region:n>=5?'header':'body',readOnly:false,blockId:id(100+index),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(200+index),text:'Region '+n}]}}))}
 const model=new WordRegionStore(document,schema,'doc',layout,hash);model.initialize(projection)
 let revision=1,authorized=true,cancelled=false,after=()=>{},change=(value:any)=>value;const calls:string[]=[],uploads:Array<{regionId:string;phase:string}>=[]
 const journal={scope:{documentId:'doc',epoch:1,lineage:'c'.repeat(32)},load:()=>{throw Error('must not reload active journal')},topologyAbandoned:async()=>cancelled} as unknown as WordCheckpointJournal
 const room={model,uploads:{snapshot:()=>uploads},state:()=>({revision}),assertAcceptingPackets:()=>{},isLayoutAwareLive:()=>true,ownsJournal:(value:unknown)=>value===journal} as unknown as WordSaveCoordinator
 const options={room,journal,selection:{sectionId:id(2),kind:'header' as const,variant:'default' as const,transactionId:'d'.repeat(32)},actor,assertOwnership:()=>{},authorize:async()=>({...actor,scope:authorized?'write' as const:'read' as const}),request:async(route:string,init?:RequestInit)=>{
  calls.push(route);if(route.startsWith('/editor?'))return Response.json(projection);if(route.startsWith('/revisions/'))return Response.json({revision:1,rootHash})
  assert.equal(route,'/word/link-preflight');const body=JSON.parse(String(init?.body));assert.equal(body.coordinatorId,'c'.repeat(32));assert.deepEqual(body.transaction.actor,actor);assert.equal(body.transaction.link.expectedDirectStoryId,id(6));assert.equal(new Headers(init?.headers).get('X-HCD-Word-Link-Version'),'1');after()
  return Response.json(change({schemaVersion:'hcd-word-link-preflight/1',documentId:'doc',transactionId:'d'.repeat(32),revision:1,rootHash,baseLayoutHash:hash,candidateLayoutHash:'e'.repeat(64),reviewHash:'f'.repeat(64),retainedStoryId:id(6),inheritedStoryId:id(5),affected:[2,3].map(n=>({sectionId:id(n),beforeStoryId:id(6),afterStoryId:id(5)}))}))
 }}
 const edit=(region:number,text:string)=>{const blocks=model.region(id(region)),node=blocks[0].node;model.reconcile(id(region),blocks,[{key:blocks[0].key,node:node.type.createChecked(node.attrs,schema.text(text,node.firstChild?.marks))},...blocks.slice(1)])}
 return{document,model,options,calls,edit,uploads,setRevision:()=>{revision++},deny:()=>{authorized=false},cancel:()=>{cancelled=true},after:(fn:()=>void)=>{after=fn},change:(fn:(v:any)=>any)=>{change=fn}}
}
test('link review is repeatable, retains both stories and preserves unrelated live drafts',async()=>{
 const f=fixture();try{f.edit(1,'Private body draft');const before=Y.encodeStateAsUpdate(f.document),first=await previewActiveWordLink(f.options),second=await previewActiveWordLink(f.options);assert.deepEqual(first,second);assert.equal(first.summary.affectedSections,2);assert.equal(first.summary.retainedStoryId,id(6));assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(f.model.project(id(1)).textContent,'Private body draft');assert.equal(f.model.layoutState().layout.sections[1].headers.default,id(6))}finally{f.document.destroy()}
})
test('both displaced and inherited live content are protected before and after the native read',async()=>{
 for(const region of [5,6])for(const late of [false,true]){const f=fixture();try{if(late)f.after(()=>f.edit(region,'Do not discard'));else f.edit(region,'Do not discard');await assert.rejects(previewActiveWordLink(f.options),/source-draft-pending/);assert.equal(f.calls.includes('/word/link-preflight'),late);assert.equal(f.model.project(id(region)).textContent,'Do not discard')}finally{f.document.destroy()}}
})
test('image upload work in either affected story blocks review but unrelated body work is retained',async()=>{
 for(const region of [1,5,6])for(const phase of ['reserved','staged','interrupted']){const f=fixture();try{f.uploads.push({regionId:id(region),phase});if(region===1)await previewActiveWordLink(f.options);else await assert.rejects(previewActiveWordLink(f.options),/source-draft-pending/);assert.equal(f.uploads.length,1)}finally{f.document.destroy()}}
})
test('late version changes or revoked authority invalidate review while unrelated late body text survives',async()=>{
 for(const mode of ['revision','authority','body']){const f=fixture();try{f.after(()=>mode==='revision'?f.setRevision():mode==='authority'?f.deny():f.edit(1,'Late body'));if(mode==='body'){await previewActiveWordLink(f.options);assert.equal(f.model.project(id(1)).textContent,'Late body')}else await assert.rejects(previewActiveWordLink(f.options),mode==='revision'?/review-changed/:/unauthorized/)}finally{f.document.destroy()}}
})
test('cancelled identity and forged native effects are never presented as reviewed candidates',async()=>{
 const f=fixture();try{f.cancel();await assert.rejects(previewActiveWordLink(f.options),/cancelled/);assert.deepEqual(f.calls,[])}finally{f.document.destroy()}
 for(const change of [(v:any)=>({...v,rootHash:'0'.repeat(64)}),(v:any)=>({...v,candidateLayoutHash:hash}),(v:any)=>({...v,inheritedStoryId:null}),(v:any)=>({...v,retainedStoryId:id(5)}),(v:any)=>({...v,affected:v.affected.slice(0,1)}),(v:any)=>({...v,affected:v.affected.map((a:any)=>({...a,afterStoryId:null}))}),(v:any)=>({...v,extra:true})]){const g=fixture();try{g.change(change);await assert.rejects(previewActiveWordLink(g.options),/preflight-invalid/)}finally{g.document.destroy()}}
})
