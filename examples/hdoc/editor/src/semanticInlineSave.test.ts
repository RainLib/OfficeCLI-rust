import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash,createHmac} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection,type Inline} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {SemanticSaveCoordinator} from './semanticSaveCoordinator.ts'
import {structureTextEdits} from './semanticStructureBinding.ts'
import {hasInlineReferences} from './inlineReference.ts'
import {snapshotReferences,ReferenceAuthorLedger} from './referenceAuthors.ts'

const secret='owned-inline-save-secret-at-least-32-bytes',schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),models={inlineContainers:true} as const
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex'),source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`
const ref=(n=1,target='alice')=>({type:'hcd.mention' as const,version:1 as const,mentionId:`m_${n.toString(16).padStart(32,'0')}`,target:{kind:'person',id:target},snapshot:{label:'Alice 王'}})
const field=(n:number,inlines:Inline[]):Inline=>({text:'',content:{kind:'extension',extension:{schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Field'}},inlines}})
const initial=():Projection=>({documentId:'inline',revision:1,blocks:[{blockId:source(1),blockHash:'hash',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Top',nodeId:source(2)},field(1,[{text:'AAA😀AAA',nodeId:source(3)},field(2,[{text:'@Alice 王',nodeId:source(4),reference:ref()}])]),{text:'Tail',nodeId:source(5)}]}}]})
function replica(projection?:Projection,bytes?:Uint8Array){const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,models);if(bytes)Y.applyUpdate(document,bytes);else{store.initialize(schema.nodeFromJSON(projectionToJson(projection!,models)));document.getMap('hcdSchema').set('sourceIdentity',1);document.getMap('hcdSchema').set('typography',2)}return{document,store}}
function bodyStart(doc:import('@tiptap/pm/model').Node,n:number){let result:number|undefined;doc.descendants((node,pos)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===id(n))result=pos+1});assert.ok(result!==undefined);return result}
function edit(store:SemanticBlockStore,n:number,value:string){const state=EditorState.create({schema,doc:store.project()}),tr=state.tr.insertText(value,bodyStart(state.doc,n)),next=[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node}));store.reconcile(store.blocks(),next,{textEdits:structureTextEdits([tr],true)})}
class Api{
 head=initial();stored=new Uint8Array();archives:Uint8Array[]=[];requests:any[]=[];records=new Map<number,object>([[1,{revision:1,rootHash:hash('root1')}]]);projections=new Map<number,Projection>([[1,initial()]]);lose=false;hold:(()=>Promise<void>)|undefined;failStore=false
 async request(route:string,init?:RequestInit):Promise<Response>{
  if(route.startsWith('/revisions/'))return Response.json(this.records.get(Number(route.split('/').at(-1))))
  if(route==='/revisions?limit=1')return Response.json({headRevision:this.head.revision})
  if(route.startsWith('/editor?revision=')){assert.equal(new Headers(init?.headers).get('X-HCD-Inline-Containers-Version'),'1');return Response.json(this.projections.get(Number(route.split('=').at(-1))))}
  if(route==='/collaboration/recovery'){this.archives.push(new Uint8Array(init!.body as Uint8Array));return Response.json({recoveryId:'owned-recovery'})}
  if(route==='/collaboration/state'){
   if(this.failStore)return new Response('',{status:503})
   const headers=new Headers(init?.headers);assert.equal(headers.get('X-HCD-Inline-Containers-Version'),'1');if(headers.get('X-HCD-State-Hash')!==(this.stored.length?hash(this.stored):'none'))return new Response('',{status:412});this.stored=new Uint8Array(init!.body as Uint8Array);return Response.json({stateHash:hash(this.stored)})
  }
  assert.equal(route,'/checkpoints');assert.equal(new Headers(init?.headers).get('X-HCD-Inline-Containers-Version'),'1');assert.equal(new Headers(init?.headers).get('X-HCD-Extension-Version'),'3')
  const request=JSON.parse(String(init!.body));this.requests.push(request);if(this.hold)await this.hold()
  if(request.expectedRevision!==this.head.revision)return new Response('',{status:409})
  const revision=this.head.revision+1;let index=100*revision
  const assign=(parts:Inline[]):Inline[]=>parts.map(part=>part.content?{...part,content:{...part.content,inlines:assign(part.content.inlines)}}:{...part,nodeId:part.nodeId??source(++index)})
  this.head={...this.head,revision,blocks:request.blocks.map((b:any)=>({blockId:b.blockId,blockHash:'hash'+revision,region:'body',readOnly:false,content:{...b.content,inlines:assign(b.content.inlines)}}))};this.projections.set(revision,structuredClone(this.head))
  const body=request.referenceAuthors?.length?{blocks:request.blocks,images:request.images??[],referenceAuthors:request.referenceAuthors}:request.blocks,unsigned=`hcdsave4:${request.coordinatorId}:${request.checkpointId}:${request.coordinatorDigest}:${hash(JSON.stringify(body))}`,mac=createHmac('sha256',secret).update(`inline:0:${request.expectedRevision}:${unsigned}`).digest('base64url');this.records.set(revision,{revision,rootHash:hash('root'+revision),patchBaseRevision:request.expectedRevision,patchId:unsigned+':'+mac})
  if(this.lose){this.lose=false;throw new Error('response lost after commit')}
  return Response.json({revision,rootHash:hash('root'+revision),projection:this.head,images:[],saveMode:'structure'})
 }
}
async function setup(api=new Api(),state=replica(api.head),initialize=true){const coordinator=new SemanticSaveCoordinator({documentId:'inline',epoch:0,...state,structure:state.store,inlineContainers:1,secret,stateHash:api.stored.length?hash(api.stored):'none',request:(route,init)=>api.request(route,init),broadcast:()=>{},autoSave:false});if(initialize)await coordinator.initialize(api.head);return{api,...state,coordinator}}

test('inline save requires an explicit matching store model and refuses old or tampered signed bases',async()=>{
 const state=replica(initial()),api=new Api(),options={documentId:'inline',epoch:0,...state,structure:state.store,secret,request:(r:string,i?:RequestInit)=>api.request(r,i),broadcast:()=>{}}
 try{
  const before=Y.encodeStateAsUpdate(state.document);assert.throws(()=>new SemanticSaveCoordinator(options),/model-not-negotiated/);assert.throws(()=>new SemanticSaveCoordinator({...options,inlineContainers:2 as 1}),/model-not-negotiated/);assert.deepEqual(Y.encodeStateAsUpdate(state.document),before)
  const f=await setup(api,state);f.coordinator.dispose();const token=state.document.getMap('hcdSave').get('receipt') as string,receipt=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());assert.equal(receipt.inlineContainers,1)
  delete receipt.inlineContainers;const raw=JSON.stringify(receipt);state.document.getMap('hcdSave').set('receipt',Buffer.from(raw).toString('base64url')+'.'+createHmac('sha256',secret).update(raw).digest('base64url'));assert.throws(()=>new SemanticSaveCoordinator({...options,inlineContainers:1}),/receipt-invalid/)
 }finally{state.document.destroy()}
})
test('fresh inline initialization preserves nested references and saves recursive source receipts',async()=>{
 const f=await setup();try{
  assert.equal(f.coordinator.state().status,'saved');edit(f.store,1,'AA');f.coordinator.changed({userId:'alice'});const result=await f.coordinator.save();assert.equal(result.status,'saved');assert.equal(result.revision,2);assert.equal(f.api.requests[0].referenceVersion,1);assert.equal(f.api.requests[0].extensionVersion,1)
  assert.deepEqual(jsonToSnapshot(f.store.project().toJSON(),models),jsonToSnapshot(projectionToJson(f.api.head,models),models));assert.equal(hasInlineReferences(f.api.head.blocks),true);assert.equal(snapshotReferences(f.api.head.blocks).size,1)
 }finally{f.coordinator.dispose();f.document.destroy()}
})
test('save acknowledges its captured body while later internal input remains pending with original sources',async()=>{
 const f=await setup();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 try{
  edit(f.store,1,'Captured ');f.coordinator.changed({userId:'alice'});f.api.hold=()=>{entered();return gate};const pending=f.coordinator.save();await started;edit(f.store,1,'Late ');f.coordinator.changed({userId:'bob'});release();const state=await pending
  assert.equal(state.revision,2);assert.equal(state.pending,true);assert.equal(f.store.flow.containers!.readBody(id(1)).textContent,'Late Captured AAA😀AAA@Alice 王');f.api.hold=undefined;assert.equal((await f.coordinator.save()).status,'saved');assert.equal(f.api.head.revision,3)
 }finally{release?.();f.coordinator.dispose();f.document.destroy()}
})
test('committed response loss recovers signed recursive captures in a fresh Doc and keeps later input',async()=>{
 const f=await setup();let next:Awaited<ReturnType<typeof setup>>|undefined
 try{
  edit(f.store,1,'Captured ');f.coordinator.changed({userId:'alice'});f.api.lose=true;await assert.rejects(f.coordinator.save(),/response lost/);edit(f.store,1,'Late ');f.coordinator.changed({userId:'bob'});await f.coordinator.persist();const bytes=f.api.stored.slice();f.coordinator.dispose();next=await setup(f.api,replica(undefined,bytes))
  assert.equal(next.coordinator.state().revision,2);assert.equal(next.coordinator.state().pending,true);assert.equal(next.coordinator.state().conflict,undefined);assert.equal(next.store.flow.containers!.readBody(id(1)).textContent,'Late Captured AAA😀AAA@Alice 王');assert.equal((await next.coordinator.save()).status,'saved');assert.equal(f.api.requests.length,2)
 }finally{f.coordinator.dispose();f.document.destroy();next?.coordinator.dispose();next?.document.destroy()}
})
test('draft persistence failure stops native submission and preserves body input',async()=>{
 const f=await setup();try{edit(f.store,1,'Keep ');f.coordinator.changed({userId:'alice'});f.api.failStore=true;await assert.rejects(f.coordinator.save(),/Draft persistence failed/);assert.equal(f.api.requests.length,0);assert.equal(f.coordinator.state().pending,true);assert.match(f.store.flow.containers!.readBody(id(1)).textContent,/^Keep /);f.api.failStore=false;assert.equal((await f.coordinator.save()).status,'saved')}finally{f.coordinator.dispose();f.document.destroy()}
})
test('nested occurrence authors follow their creator through a different saver and signed recovery proof',()=>{
 const first=initial(),empty=structuredClone(first);empty.blocks[0].content.inlines[1].content!.inlines[1].content!.inlines=[]
 const ledger=new ReferenceAuthorLedger(empty.blocks,empty.blocks);ledger.observe(first.blocks,{userId:'alice',displayName:'Alice',generation:1});const moved=structuredClone(first);moved.blocks[0].content.inlines.unshift({text:'Bob'});ledger.observe(moved.blocks,{userId:'bob',displayName:'Bob',generation:2});assert.deepEqual(ledger.capture(moved.blocks).referenceAuthors,[{mentionId:ref().mentionId,userId:'alice'}])
 const restored=new ReferenceAuthorLedger(moved.blocks,empty.blocks);restored.restore(ledger.proof());assert.deepEqual(restored.capture(moved.blocks).referenceAuthors,[{mentionId:ref().mentionId,userId:'alice'}]);assert.throws(()=>new ReferenceAuthorLedger(first.blocks,empty.blocks).capture(first.blocks),/unbound/)
 const duplicate=structuredClone(first);duplicate.blocks[0].content.inlines.push({text:'@Alice 王',reference:ref()});assert.throws(()=>snapshotReferences(duplicate.blocks),/duplicate-reference/)
})
test('an external native head is never adopted by a pending inline draft',async()=>{
 const f=await setup();try{edit(f.store,1,'Keep ');f.coordinator.changed({userId:'alice'});f.api.head={...f.api.head,revision:2};const state=await f.coordinator.save();assert.equal(state.conflict,'canonical-changed');assert.equal(state.revision,1);assert.equal(state.pending,true);assert.equal(f.api.requests.length,0);assert.ok(f.api.archives.length)}finally{f.coordinator.dispose();f.document.destroy()}
})
test('nested retarget checkpoints carry the authenticated target editor and later typing adds no relationship',async()=>{
 const f=await setup();try{
  const state=EditorState.create({schema,doc:f.store.project()});let position=0;state.doc.descendants((node,pos)=>{if(node.type.name==='hcdMention')position=pos})
  const node=state.doc.nodeAt(position)!,tr=state.tr.setNodeMarkup(position,undefined,{...node.attrs,reference:ref(1,'bob')});f.store.reconcile(f.store.blocks(),[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node})));f.coordinator.changed({userId:'bob',displayName:'Bob'})
  assert.equal((await f.coordinator.save()).status,'saved');assert.deepEqual(f.api.requests[0].referenceAuthors,[{mentionId:ref().mentionId,userId:'bob'}]);assert.deepEqual(f.api.requests[0].contributors,[{userId:'bob',displayName:'Bob'}])
  edit(f.store,1,'Other ');f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).status,'saved');assert.equal(f.api.requests[1].referenceAuthors,undefined)
 }finally{f.coordinator.dispose();f.document.destroy()}
})
test('an unrecoverable source capture is rejected before submitting a canonical attempt and can be corrected',async()=>{
 const f=await setup();try{
  const body=f.store.flow.containers!.bodies.get(id(1))!;f.document.transact(()=>{for(let n=0;n<850;n++)body.insert(n,'a',n%2?{bold:{}}:{})},'owned-large-capture');f.coordinator.changed({userId:'alice'})
  await assert.rejects(f.coordinator.save(),/Invalid image attempt/);assert.equal(f.api.requests.length,0);assert.equal(f.document.getMap('hcdSave').has('imageAttempt'),false)
  f.document.transact(()=>body.delete(0,850),'owned-large-capture');f.coordinator.changed({userId:'alice'});edit(f.store,1,'Small ');f.coordinator.changed({userId:'alice'});assert.equal((await f.coordinator.save()).status,'saved')
 }finally{f.coordinator.dispose();f.document.destroy()}
})
