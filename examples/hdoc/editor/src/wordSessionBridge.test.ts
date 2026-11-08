import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,sameWordSessionTopology,type WordRegionProjection} from './wordRegionStore.ts'
import type {WordLayoutPending} from './wordCheckpointJournal.ts'
import {SemanticHistory} from './semanticHistory.ts'
import {CollaborativeImageDraftStore} from './collaborativeImages.ts'
import {bridgeWordSession} from './wordSessionBridge.ts'
import type {WordStorySessionProof} from './wordStorySessionProof.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),nextHash='b'.repeat(64)
test('session compatibility permits receipt source rebinding but preserves unknown layout fields',()=>{
 const before=projection().flowLayout,after=structuredClone(before)
 Object.assign(before.sections[0],{canonicalEndBlockId:id(31)});Object.assign(after.sections[0],{canonicalEndBlockId:id(32)})
 after.sections[0].page.widthTwips=11906;after.sections[0].page.marginsTwips={top:1440};assert.equal(sameWordSessionTopology(before,after),true)
 Object.assign(after.sections[0].page,{futureColumns:2});assert.equal(sameWordSessionTopology(before,after),false)
 delete (after.sections[0].page as Record<string,unknown>).futureColumns;after.sections[0].headers.default=id(3);assert.equal(sameWordSessionTopology(before,after),false)
})
function projection():WordRegionProjection{return{documentId:'doc',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,heightTwips:15840},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(10+n),blockHash:hash,region:n===1?'body':'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Base':'Header',nodeId:id(20+n)}]}}))}}
function edit(model:WordRegionStore,text:string,region=id(1)){const before=model.region(region),block=before[0].node;model.reconcile(region,before,[{key:before[0].key,node:block.type.createChecked(block.attrs,model.schema.text(text,block.firstChild?.marks))}])}
function fixture(){
 const native=projection(),view=new Y.Doc(),wire=new Y.Doc(),model=new WordRegionStore(view,wordRegionSchema(),'doc',native.flowLayout,hash);model.initialize(native)
 const images=new CollaborativeImageDraftStore(view),manager=model.structure.undoManager(),history=new SemanticHistory(images,manager,()=>false,async()=>({revision:1,image:null}));const detachImages=images.connect(),detachHistory=history.connect()
 const prepare=()=>{Y.applyUpdate(wire,Y.encodeStateAsUpdate(view));const next=new WordRegionStore(wire,wordRegionSchema(),'doc',native.flowLayout,hash),layout=structuredClone(native.flowLayout);layout.sections[0].page.widthTwips=11906
  const request:WordLayoutPending['request']={schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'c'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash,changes:[{sectionId:id(1),field:'widthTwips',expected:12240,value:11906}]}}
  next.acceptLayoutFields(hash,layout,nextHash,request);return next
 }
 return{native,view,wire,model,images,manager,history,prepare,close:()=>{detachHistory();detachImages();manager.destroy();view.destroy();wire.destroy()}}
}
function story(f:ReturnType<typeof fixture>){
 const base=structuredClone(f.native),receipt=structuredClone(base),transactionId='c'.repeat(32),storyId=`n_${transactionId}`
 receipt.revision++;receipt.flowLayoutHash=nextHash;receipt.flowLayout.stories.push({id:storyId,kind:'header',sourcePart:`word/hcd-${transactionId}.xml`});receipt.flowLayout.sections[0].headers.first=storyId
 const blocks:WordRegionProjection['blocks']=[{flowRegionId:storyId,blockId:id(41),blockHash:hash,region:'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Independent header',nodeId:id(42)}]}}];receipt.blocks.push(...blocks)
 Y.applyUpdate(f.wire,Y.encodeStateAsUpdate(f.view));const next=new WordRegionStore(f.wire,wordRegionSchema(),'doc',base.flowLayout,hash)
 next.acceptStoryReceipt(base,receipt,{sectionId:id(1),kind:'header',variant:'first',expectedInheritedStoryId:null},blocks)
 return{next,proof:{transactionId,base,receipt} satisfies WordStorySessionProof,storyId}
}
test('an exact native story receipt preserves personal history, existing peers and the independent region',async()=>{
 const f=fixture();let updates=0
 try{
  f.history.stopCapturing();edit(f.model,'Base own');f.history.stopCapturing();const s=story(f),before=Y.encodeStateAsUpdate(f.wire)
  f.wire.on('update',()=>updates++);const bridge=bridgeWordSession({view:f.model,wire:s.next,storyProof:s.proof,assertFresh:()=>{},detachPreviousTransport:()=>{}})
  try{
   assert.equal(bridge.model.document,f.view);assert.equal(bridge.model.project(s.storyId).textContent,'Independent header');assert.deepEqual(Y.encodeStateAsUpdate(f.wire),before);assert.equal(updates,0)
   edit(s.next,'Independent peer',s.storyId);await f.history.step('undo');assert.equal(s.next.project(id(1)).textContent,'Base');assert.equal(s.next.project(s.storyId).textContent,'Independent peer')
   await f.history.step('redo');assert.equal(s.next.project(id(1)).textContent,'Base own');assert.equal(bridge.closed,false)
  }finally{bridge.dispose()}
 }finally{f.close()}
})
test('story proof rejects unrelated rounds, changed native originals and extra bindings before transport retirement',()=>{
 for(const mutate of [(p:WordStorySessionProof)=>{p.transactionId='d'.repeat(32)},(p:WordStorySessionProof)=>{p.receipt.blocks[0].content.inlines![0].text='Unreviewed original'},(p:WordStorySessionProof)=>{p.receipt.flowLayout.sections[0].footers.default=p.receipt.flowLayout.stories.at(-1)!.id},(p:WordStorySessionProof)=>{p.receipt.revision++}]){
  const f=fixture();let retired=false
  try{const s=story(f),before=Y.encodeStateAsUpdate(f.view);mutate(s.proof);assert.throws(()=>bridgeWordSession({view:f.model,wire:s.next,storyProof:s.proof,assertFresh:()=>{},detachPreviousTransport:()=>{retired=true}}));assert.equal(retired,false);assert.deepEqual(Y.encodeStateAsUpdate(f.view),before)}finally{f.close()}
 }
})
test('a native story proof cannot admit private old input or an unrelated live topology',()=>{
 const f=fixture()
 try{const s=story(f);edit(f.model,'Private after story');const before=Y.encodeStateAsUpdate(f.wire);assert.throws(()=>bridgeWordSession({view:f.model,wire:s.next,storyProof:s.proof,assertFresh:()=>{},detachPreviousTransport:()=>{}}),/review-required/);assert.deepEqual(Y.encodeStateAsUpdate(f.wire),before)}finally{f.close()}
 const g=fixture()
 try{const s=story(g);s.proof.receipt.flowLayout.sections[0].page.widthTwips=9000;assert.throws(()=>bridgeWordSession({view:g.model,wire:s.next,storyProof:s.proof,assertFresh:()=>{},detachPreviousTransport:()=>{}}));assert.equal(g.model.layoutState().layoutHash,hash)}finally{g.close()}
})
test('fresh transport retains the old document and own undo/redo without sending a cached state',async()=>{
 const f=fixture();let updates=0,detached=0,views=0
 try{
  f.history.stopCapturing();edit(f.model,'Base own');f.history.stopCapturing();const next=f.prepare(),wireBefore=Y.encodeStateAsUpdate(f.wire),clientId=f.view.clientID
  f.wire.on('update',()=>{updates++});const bridge=bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{detached++},beforeApply:()=>{views++}})
  try{
   assert.equal(detached,1);assert.equal(views,1);assert.equal(bridge.model.document,f.view);assert.equal(f.view.clientID,clientId);assert.equal(bridge.model.layoutState().layout.sections[0].page.widthTwips,11906);assert.deepEqual(Y.encodeStateAsUpdate(f.wire),wireBefore);assert.equal(updates,0)
   edit(next,'Header peer',id(2));await f.history.step('undo');assert.equal(bridge.model.project(id(1)).textContent,'Base');assert.equal(next.project(id(1)).textContent,'Base');assert.equal(next.project(id(2)).textContent,'Header peer')
   await f.history.step('redo');assert.equal(next.project(id(1)).textContent,'Base own');assert.equal(bridge.closed,false)
  }finally{bridge.dispose()}
 }finally{f.close()}
})
test('redo links and kept deleted content remain local while newer peer text survives',async()=>{
 const f=fixture()
 try{
  f.history.stopCapturing();edit(f.model,'Base first');f.history.stopCapturing();edit(f.model,'Base second');f.history.stopCapturing();await f.history.step('undo');const next=f.prepare(),bridge=bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{}})
  try{edit(next,'Base first peer');await f.history.step('redo');assert.match(next.project(id(1)).textContent,/second/);assert.match(next.project(id(1)).textContent,/peer/);await f.history.step('undo');assert.match(next.project(id(1)).textContent,/first/);assert.match(next.project(id(1)).textContent,/peer/)}finally{bridge.dispose()}
 }finally{f.close()}
})
test('unsubmitted local input requires review and is never used to seed the fresh transport',()=>{
 const f=fixture();let detached=false
 try{const next=f.prepare();edit(f.model,'Unsubmitted private text');const before=Y.encodeStateAsUpdate(f.wire);assert.throws(()=>bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{detached=true}}),/review-required/);assert.equal(detached,false);assert.deepEqual(Y.encodeStateAsUpdate(f.wire),before);assert.equal(f.history.canUndo,true)}finally{f.close()}
})
test('new private input during view teardown also blocks the bridge before any old state is forwarded',()=>{
 const f=fixture()
 try{const next=f.prepare(),before=Y.encodeStateAsUpdate(f.wire);assert.throws(()=>bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{},beforeApply:()=>edit(f.model,'Late teardown input')}),/review-required/);assert.deepEqual(Y.encodeStateAsUpdate(f.wire),before);assert.equal(f.model.project(id(1)).textContent,'Late teardown input')}finally{f.close()}
})
test('an obsolete transport update closes the bridge without sending that peer snapshot',()=>{
 const f=fixture(),obsolete=new Y.Doc();let failed=0
 try{
  Y.applyUpdate(obsolete,Y.encodeStateAsUpdate(f.view));const old=new WordRegionStore(obsolete,wordRegionSchema(),'doc',projection().flowLayout,hash),next=f.prepare(),bridge=bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{},onBroken:()=>{failed++}})
  let update!:Uint8Array;obsolete.on('update',value=>{update=value});edit(old,'Obsolete peer data');Y.applyUpdate(f.view,update,'obsolete-provider')
  assert.equal(bridge.closed,true);assert.match(bridge.error!.message,/unexpected-remote/);assert.equal(failed,1);assert.equal(next.project(id(1)).textContent,'Base');bridge.dispose()
 }finally{obsolete.destroy();f.close()}
})
test('local protected metadata cannot be forwarded into the new room',()=>{
 const f=fixture()
 try{const next=f.prepare(),bridge=bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{}});f.view.getMap(wordRegionStoreField).set('layoutHash','d'.repeat(64));assert.equal(bridge.closed,true);assert.match(bridge.error!.message,/protected-metadata/);assert.equal(f.wire.getMap(wordRegionStoreField).get('layoutHash'),nextHash)}finally{f.close()}
})
test('story topology changes and asynchronous authority assertions are rejected before view mutation',()=>{
 const f=fixture()
 try{
  const next=f.prepare(),before=Y.encodeStateAsUpdate(f.view);assert.throws(()=>bridgeWordSession({view:f.model,wire:next,assertFresh:async()=>{throw Error('late-denial')},detachPreviousTransport:()=>{}}),/proof-must-be-synchronous/);assert.deepEqual(Y.encodeStateAsUpdate(f.view),before)
  const other=new Y.Doc(),native=projection();native.flowLayout.sections[0].headers={};native.flowLayout.stories=[];native.blocks=native.blocks.slice(0,1);const foreign=new WordRegionStore(other,wordRegionSchema(),'doc',native.flowLayout,hash);foreign.initialize(native)
  try{assert.throws(()=>bridgeWordSession({view:f.model,wire:foreign,assertFresh:()=>{},detachPreviousTransport:()=>{}}),/topology-changed/)}finally{other.destroy()}
 }finally{f.close()}
})
test('disposal stops both directions without destroying either document or personal history',()=>{
 const f=fixture()
 try{edit(f.model,'Base own');const next=f.prepare(),bridge=bridgeWordSession({view:f.model,wire:next,assertFresh:()=>{},detachPreviousTransport:()=>{}});bridge.dispose();bridge.dispose();edit(bridge.model,'Private after dispose');assert.equal(next.project(id(1)).textContent,'Base own');assert.equal(f.view.isDestroyed,false);assert.equal(f.wire.isDestroyed,false);assert.equal(f.history.canUndo,true)}finally{f.close()}
})
