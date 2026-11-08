import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {previewActiveWordStory,readActiveStorySelection} from './wordActiveStoryPreview.ts'

const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash='a'.repeat(64),rootHash='b'.repeat(64),actor={userId:'alice',displayName:'Alice 王'}
function fixture(){
 const document=new Y.Doc(),schema=wordRegionSchema(),layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:true,sections:[1,2,3].map(n=>({id:id(n),differentFirstPage:true,page:{},headers:n===1?{default:id(5)}:{},footers:{}})),stories:[{id:id(5),kind:'header' as const,sourcePart:'word/header1.xml'}]}
 const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayout:layout,flowLayoutHash:hash,blocks:[1,2,3,5].map((n,index)=>({flowRegionId:id(n),region:n===5?'header':'body',readOnly:false,blockId:id(100+index),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(200+index),text:'Region '+n}]}}))}
 const model=new WordRegionStore(document,schema,'doc',layout,hash);model.initialize(projection)
 let revision=1,cancelled=false,authorized=true,afterPreflight=()=>{},nativeChange=(value:any)=>value;const calls:string[]=[]
 const journal={scope:{documentId:'doc',epoch:1,lineage:'c'.repeat(32)},load:()=>{throw Error('must not reload active journal')},topologyAbandoned:async()=>cancelled} as unknown as WordCheckpointJournal
 const room={model,uploads:{snapshot:()=>[]},state:()=>({revision}),assertAcceptingPackets:()=>{},isLayoutAwareLive:()=>true,ownsJournal:(value:unknown)=>value===journal} as unknown as WordSaveCoordinator
 const selection={sectionId:id(2),kind:'header' as const,variant:'default' as const,transactionId:'d'.repeat(32)}
 const options={room,journal,selection,actor,assertOwnership:()=>{},authorize:async()=>({...actor,scope:authorized?'write' as const:'read' as const}),request:async(route:string,init?:RequestInit)=>{
  calls.push(route)
  if(route.startsWith('/editor?'))return Response.json(projection)
  if(route.startsWith('/revisions/'))return Response.json({revision:1,rootHash})
  assert.equal(route,'/word/story-preflight');const body=JSON.parse(String(init?.body));assert.equal(body.coordinatorId,'c'.repeat(32));assert.deepEqual(body.actor,actor);assert.equal(body.intent.expectedInheritedStoryId,id(5))
  afterPreflight()
  return Response.json(nativeChange({revision:1,rootHash,baseLayoutHash:hash,candidateHash:'e'.repeat(64),blocks:[{flowRegionId:body.story.id,region:body.story.kind,blockId:id(300),blockHash:hash,readOnly:false,content:{kind:'paragraph',inlines:[]}}],copyChoices:{referenceIds:[],extensions:[]},impact:{inheritedStoryId:id(5),affectedSectionIds:[id(2),id(3)]}}))
 }}
 const edit=(region:number,text:string)=>{const blocks=model.region(id(region)),node=blocks[0].node;model.reconcile(id(region),blocks,[{key:blocks[0].key,node:node.type.createChecked(node.attrs,schema.text(text,node.firstChild?.marks))},...blocks.slice(1)])}
 return{document,model,options,calls,edit,revision:(n:number)=>{revision=n},cancelled:()=>{cancelled=true},deny:()=>{authorized=false},after:(fn:()=>void)=>{afterPreflight=fn},native:(fn:(v:any)=>any)=>{nativeChange=fn}}
}
test('live preflight preserves unrelated drafts and produces the same exact reviewed candidate without journal reload',async()=>{
 const f=fixture()
 try{
  f.edit(1,'Body draft');const before=Y.encodeStateAsUpdate(f.document),first=await previewActiveWordStory(f.options),second=await previewActiveWordStory(f.options)
  assert.deepEqual(first,second);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(first.summary.affectedSections,2);assert.equal(first.pending.intent.expectedInheritedStoryId,id(5));assert.equal(first.pending.request.actor.userId,'alice')
  assert.deepEqual(f.calls,['/editor?revision=1','/revisions/1','/word/story-preflight','/editor?revision=1','/revisions/1','/word/story-preflight'])
 }finally{f.document.destroy()}
})
test('unsaved inherited text is rejected before native copying and late source edits invalidate the review',async()=>{
 const f=fixture(),g=fixture()
 try{
  f.edit(5,'Unsaved header');await assert.rejects(previewActiveWordStory(f.options),/source-draft-pending/);assert.equal(f.calls.includes('/word/story-preflight'),false)
  g.after(()=>g.edit(5,'Late header'));await assert.rejects(previewActiveWordStory(g.options),/source-draft-pending/);assert.equal(g.model.project(id(5)).textContent,'Late header')
 }finally{f.document.destroy();g.document.destroy()}
})
test('unrelated late body edits survive review while canonical changes and revoked authority reject it',async()=>{
 for(const mode of ['body','revision','authority'] as const){const f=fixture();try{f.after(()=>{if(mode==='body')f.edit(1,'Late body');if(mode==='revision')f.revision(2);if(mode==='authority')f.deny()});if(mode==='body'){await previewActiveWordStory(f.options);assert.equal(f.model.project(id(1)).textContent,'Late body')}else await assert.rejects(previewActiveWordStory(f.options),mode==='revision'?/review-changed/:/unauthorized/)}finally{f.document.destroy()}}
})
test('cancelled identities and inconsistent native candidate scope never become an approved preview',async()=>{
 const cancelled=fixture();try{cancelled.cancelled();await assert.rejects(previewActiveWordStory(cancelled.options),/cancelled/);assert.deepEqual(cancelled.calls,[])}finally{cancelled.document.destroy()}
 for(const change of [(v:any)=>({...v,rootHash:'f'.repeat(64)}),(v:any)=>({...v,impact:{...v.impact,affectedSectionIds:[id(2)]}}),(v:any)=>({...v,blocks:[{...v.blocks[0],flowRegionId:id(5)}]}),(v:any)=>({...v,copyChoices:{referenceIds:[],extensions:[{}]}})]){const f=fixture();try{f.native(change);await assert.rejects(previewActiveWordStory(f.options),/preflight-invalid/)}finally{f.document.destroy()}}
})
test('selection is exact, direct bindings cannot be replaced, and unsafe source copies remain rejected',async()=>{
 assert.throws(()=>readActiveStorySelection({sectionId:id(2),kind:'header',variant:'default',transactionId:'d'.repeat(32),extra:true}),/selection-invalid/)
 const f=fixture(),g=fixture()
 try{f.options.selection.sectionId=id(1);await assert.rejects(previewActiveWordStory(f.options),/already-independent/);g.options.request=async()=>Response.json({error:'Word story contains content that cannot be copied safely'},{status:422});await assert.rejects(previewActiveWordStory(g.options),/source-unsupported/)}finally{f.document.destroy();g.document.destroy()}
})
