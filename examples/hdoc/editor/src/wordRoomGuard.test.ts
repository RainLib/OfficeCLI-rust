import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,type WordRegionProjection} from './wordRegionStore.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordCanonicalSources} from './wordCanonicalSources.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {legacyProtocol,structuralProtocol,wordRegionalProtocol,parseCollaborationRoom,roomMatches,requireCollaborationSession} from './collaborationProtocol.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {imageReceiptMap,CollaborativeImageDraftStore} from './collaborativeImages.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash='a'.repeat(64),schema=wordRegionSchema()
function fixture(){
 const projection:WordRegionProjection={documentId:'regional',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,2,2].map((region,index)=>({flowRegionId:id(region),region:region===1?'body':'header',readOnly:index===2,blockId:id(index+10),blockHash:hash,content:{kind:index===2?'opaque':'paragraph',inlines:[{text:index===2?'Field cache':'Text '+index,nodeId:id(index+20)}]}}))}
 const document=new Y.Doc(),model=new WordRegionStore(document,schema,'regional',projection.flowLayout,hash);model.initialize(projection)
 return{document,model,projection}
}
function clone(f:ReturnType<typeof fixture>){const document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.document));return{document,model:new WordRegionStore(document,schema,'regional',f.projection.flowLayout,f.projection.flowLayoutHash)}}
function edit(model:WordRegionStore,region:number,text:string){const before=model.region(id(region)),block=before[0];model.reconcile(id(region),before,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text(text,block.node.firstChild?.marks))},...before.slice(1)])}
test('regional room names require their own protocol and save generation',()=>{
 const room=parseCollaborationRoom('regional:2:wordregions1:save5');assert.equal(room.protocol,wordRegionalProtocol);assert.ok(roomMatches(room,requireCollaborationSession({collaborationEpoch:2,collaborationProtocol:wordRegionalProtocol})));assert.equal(roomMatches(room,{collaborationEpoch:2,collaborationProtocol:structuralProtocol}),false)
 for(const name of ['regional:2:wordregions1:save4','regional:2:structure3:save5','regional:02:wordregions1:save5','fixed:regional:2:wordregions1:save5'])assert.throws(()=>parseCollaborationRoom(name))
})
test('regional packets admit real body/header edits while ordinary rooms reject regional state',()=>{
 const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2));try{for(const protocol of [legacyProtocol,structuralProtocol])assert.throws(()=>new RoomProtocolGuard(f.document,protocol),/protocol-mismatch/);edit(peer.model,1,'Body peer');edit(peer.model,2,'Header peer');const update=Y.encodeStateAsUpdate(peer.document);guard.accept(update);Y.applyUpdate(f.document,update);assert.equal(f.model.project(id(1)).textContent,'Body peer');assert.match(f.model.project(id(2)).textContent,/Header peer/)}finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})
for(const field of [wordRegionStoreField,'hcdSchema',imageReceiptMap,semanticBlockFields.metadata])test(`regional packets cannot rewrite server metadata: ${field}`,()=>{
 const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2));try{peer.document.getMap(field).set('forged','value');const before=Y.encodeStateAsUpdate(f.document);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer.document)),/protected-metadata|protocol-mismatch/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);const valid=clone(f);edit(valid.model,1,'Legal after rejection');guard.accept(Y.encodeStateAsUpdate(valid.document));valid.document.destroy()}finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})
test('cross-region movement, foreign canonical IDs and opaque removal are rejected before application',()=>{
 for(const mode of ['move','canonical','readonly','unknown','source']){const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2));try{
  if(mode==='move'){const all=peer.model.structure.blocks(),body=peer.model.region(id(1))[0];peer.model.structure.reconcile(all,[...all.filter(block=>block.key!==body.key),body])}
  if(mode==='canonical')peer.document.getMap(semanticBlockFields.canonical).set(peer.model.region(id(1))[0].node.attrs.hcdCanonicalKey,id(999))
  if(mode==='readonly')peer.model.structure.visibility.set(peer.model.region(id(2))[1].key,false)
  if(mode==='unknown')peer.document.getMap('hiddenUnknown').set('data','must not be lost')
  if(mode==='source'){const block=peer.model.region(id(2))[0],text=peer.model.structure.contents.get(block.key)!.get(0) as Y.XmlText;text.format(0,1,{hcdSource:{nodeId:id(20)}})}
  const bytes=Y.encodeStateAsUpdate(f.document);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer.document)));assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}}
})
test('unknown image sources and dependency-only packets cannot wait invisibly for a later actor',()=>{
 const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>undefined);try{new CollaborativeImageDraftStore(peer.document).edit({nodeId:id(90),visualHash:hash,geometry:{unit:'emu',x:0,y:0,width:100,height:50}},1,{unit:'emu',x:0,y:0,width:120,height:50});assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer.document)),/image-source/)
  const detached=new Y.Doc(),text=detached.getText('orphan');text.insert(0,'First');const vector=Y.encodeStateVector(detached);text.insert(0,'Second');assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(detached,vector)),/incomplete-update/);detached.destroy()
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})

test('clients verify a native layout receipt after source rebinding before continuing legal regional edits',()=>{
 const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2));try{
  const captured=f.model.capture(),canonical=structuredClone(f.projection);canonical.revision=2;canonical.flowLayoutHash='b'.repeat(64);canonical.blocks.filter(block=>!block.readOnly).forEach((block,index)=>{block.blockId=id(300+index);block.content.inlines[0].nodeId=id(400+index)})
  f.model.acceptSources(captured,canonical);Y.applyUpdate(peer.document,Y.encodeStateAsUpdate(f.document));assert.throws(()=>peer.model.capture(),/invalidWordRegionMetadata/);assert.throws(()=>peer.model.syncLayout(canonical.flowLayout,'c'.repeat(64)),/wordRegionLayoutChanged/);peer.model.syncLayout(canonical.flowLayout,canonical.flowLayoutHash);edit(peer.model,1,'After native receipt');guard.accept(Y.encodeStateAsUpdate(peer.document));Y.applyUpdate(f.document,Y.encodeStateAsUpdate(peer.document));assert.equal(f.model.project(id(1)).textContent,'After native receipt')
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})

test('new paragraph provisional identities are accepted while native and malformed source claims stay rejected',()=>{
 for(const source of ['tmp_12345678-1234-1234-1234-123456789abc',id(900),'tmp_forged']){const f=fixture(),peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2));try{const before=peer.model.region(id(1));if(source===id(900)){const owner=crypto.randomUUID();peer.model.structure.canonicalIds.set(owner,source)}else peer.model.reconcile(id(1),before,[...before,{node:schema.nodes.paragraph.createChecked({hcdBlockId:source},schema.text('New paragraph'))}]);const update=Y.encodeStateAsUpdate(peer.document);if(source.startsWith('tmp_123')){guard.accept(update);Y.applyUpdate(f.document,update);assert.match(f.model.project(id(1)).textContent,/New paragraph/)}else assert.throws(()=>guard.accept(update),/canonical-source|foreign-source/)}finally{guard.destroy();peer.document.destroy();f.document.destroy()}}
})
test('a saved block hidden by undo may return in its original region, but not borrow a different region',()=>{
 const f=fixture(),before=f.model.region(id(1));f.model.reconcile(id(1),before,[...before,{node:schema.nodes.paragraph.createChecked()}]);const canonical=wordCanonicalSources(f.model),key=f.model.region(id(1))[0].key
 f.document.transact(()=>f.model.structure.visibility.set(key,false))
 const peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2),canonical)
 try{
  peer.document.transact(()=>peer.model.structure.visibility.set(key,true))
  const update=Y.encodeStateAsUpdate(peer.document);guard.accept(update);Y.applyUpdate(f.document,update)
  assert.match(f.model.project(id(1)).textContent,/Text 0/)
  const illegal=clone(f),header=illegal.model.region(id(2))[0],text=illegal.model.structure.contents.get(header.key)!.get(0) as Y.XmlText
  try{text.format(0,1,{hcdSource:{nodeId:id(20)}});assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(illegal.document)),/cross-region|foreign-source|invalidStructure/)}finally{illegal.document.destroy()}
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})
test('an incomplete hidden text carrier grants no source authority but does not block a legal repair',()=>{
 const f=fixture(),before=f.model.region(id(1));f.model.reconcile(id(1),before,[...before,{node:schema.nodes.paragraph.createChecked(null,schema.text('New'))}])
 const key=f.model.region(id(1))[1].key
 f.document.transact(()=>{f.model.structure.visibility.set(key,false);f.model.structure.flow.segments.delete(key)})
 const peer=clone(f),guard=wordRoomGuard(f.model,()=>id(2),wordCanonicalSources(f.model))
 try{
  peer.document.transact(()=>{peer.model.structure.flow.segments.set(key,{carrier:key});peer.model.structure.visibility.set(key,true)})
  const update=Y.encodeStateAsUpdate(peer.document);guard.accept(update);Y.applyUpdate(f.document,update);assert.match(f.model.project(id(1)).textContent,/New/)
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})
