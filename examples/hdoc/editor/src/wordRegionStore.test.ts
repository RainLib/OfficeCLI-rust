import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {EditorState} from '@tiptap/pm/state'
import {WordRegionStore,wordCheckpointContents,wordRegionSchema,wordRegionStoreField,wordBoundaryName,verifyWordStoryReceipt,type WordRegionProjection} from './wordRegionStore.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {wordDeviceBackupPreview,wordDeviceBackupTextFile} from './wordDeviceBackupPreview.ts'
import {transformBlocks,rootBlocks,blockTarget} from './commands/blocks.ts'
import type {WordLayoutPending} from './wordCheckpointJournal.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const schema=wordRegionSchema(),hash='a'.repeat(64)
export function fixture():WordRegionProjection{
 const flowLayout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:true,sections:[1,2].map(n=>({id:id(n),differentFirstPage:false,page:{widthTwips:11906,heightTwips:16838},headers:n===1?{default:id(3)}:{},footers:n===1?{default:id(4)}:{}})),stories:[{id:id(3),kind:'header' as const,sourcePart:'word/header1.xml'},{id:id(4),kind:'footer' as const,sourcePart:'word/footer1.xml'},{id:id(5),kind:'footer' as const,sourcePart:'word/unbound.xml'}]}
 return{documentId:'regional',revision:1,flowLayout,flowLayoutHash:hash,blocks:[1,1,2,3,4,5].map((region,index)=>({flowRegionId:id(region),region:region<3?'body':region===3?'header':'footer',readOnly:false,blockId:id(100+index),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(200+index),text:`Region ${region} text ${index} 😀`}]}}))}
}
function create(projection=fixture()){
 const document=new Y.Doc(),store=new WordRegionStore(document,schema,projection.documentId,projection.flowLayout,projection.flowLayoutHash);store.initialize(projection);return{document,store}
}
function clone(document:Y.Doc){const other=new Y.Doc();Y.applyUpdate(other,Y.encodeStateAsUpdate(document));const initial=fixture();return{document:other,store:new WordRegionStore(other,schema,initial.documentId,initial.flowLayout,hash)}}
function sync(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(reverse?b:a,reverse?au:bu);Y.applyUpdate(reverse?a:b,reverse?bu:au)}
function edit(store:WordRegionStore,region:number,text:string){const before=store.region(id(region)),node=before[0].node;store.reconcile(id(region),before,[{key:before[0].key,node:node.type.createChecked(node.attrs,schema.text(text,node.firstChild?.marks))},...before.slice(1)])}
const labels=(store:WordRegionStore,region:number)=>store.region(id(region)).map(block=>block.node.textContent)
const layoutRequest=():WordLayoutPending['request']=>({schemaVersion:'hcd-word-layout-transaction/1',documentId:'regional',transactionId:'e'.repeat(32),baseRevision:1,expectedRevision:1,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:hash,changes:[{sectionId:id(1),field:'widthTwips',expected:11906,value:12240},{sectionId:id(1),field:'differentFirstPage',expected:false,value:true},{field:'evenAndOddHeaders',expected:true,value:false}]}})
test('independent story receipt preserves all existing roots and matches the reviewed new content',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1))
 const verified=verifyWordStoryReceipt(base,next,intent,expected);assert.deepEqual(verified,next);assert.notEqual(verified,next)
 for(const change of [
  (value:WordRegionProjection)=>{value.blocks[0].content.inlines[0].text='lost peer input'},
  (value:WordRegionProjection)=>{value.blocks[0].blockId=id(400)},
  (value:WordRegionProjection)=>{value.blocks.at(-1)!.content.inlines[0].text='wrong copied content'},
  (value:WordRegionProjection)=>{value.blocks.at(-1)!.blockId=value.blocks[0].blockId},
  (value:WordRegionProjection)=>{value.blocks.at(-1)!.flowRegionId=id(3)},
  (value:WordRegionProjection)=>{value.revision=3},
  (value:WordRegionProjection)=>{value.comments=[{blockId:id(100),text:'unexpected'}]},
 ]){const bad=structuredClone(next);change(bad);assert.throws(()=>verifyWordStoryReceipt(base,bad,intent,expected))}
 assert.throws(()=>verifyWordStoryReceipt(base,next,{...intent,expectedInheritedStoryId:null},expected))
})
test('native assigned story text IDs are adopted without permitting collisions or changed content',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1));delete expected[0].content.inlines[0].nodeId
 const f=create(base);try{
  const duplicate=structuredClone(next);duplicate.blocks.at(-1)!.content.inlines[0].nodeId=id(200);assert.throws(()=>verifyWordStoryReceipt(base,duplicate,intent,expected))
  const changed=structuredClone(next);changed.blocks.at(-1)!.content.inlines[0].text='changed';assert.throws(()=>verifyWordStoryReceipt(base,changed,intent,expected))
  f.store.acceptStoryReceipt(base,next,intent,expected);assert.equal(f.store.capture().regions.at(-1)!.blocks[0].content.inlines[0].nodeId,id(206))
 }finally{f.document.destroy()}
})
test('staged story receipt adds one region while preserving peer input, carriers and personal undo',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1)),a=create(base),b=clone(a.document),history=a.store.structure.undoManager()
 try{
  edit(a.store,1,'My draft');history.stopCapturing();edit(b.store,3,'Peer draft');sync(a.document,b.document)
  const carrier=a.store.structure.contents.get(a.store.region(id(1))[0].key),before=a.store.capture(),bytes=Y.encodeStateAsUpdate(a.document)
  const bad=structuredClone(next);bad.blocks[0].content.inlines[0].text='tampered'
  assert.throws(()=>a.store.acceptStoryReceipt(base,bad,intent,expected));assert.deepEqual(Y.encodeStateAsUpdate(a.document),bytes)
  let coherent=false;a.document.on('afterTransaction',()=>{if(a.document.getMap(wordRegionStoreField).get('layoutHash')===next.flowLayoutHash){assert.equal(a.store.capture().regions.at(-1)?.regionId,id(6));coherent=true}})
  a.store.acceptStoryReceipt(base,next,intent,expected)
  assert.equal(coherent,true)
  assert.equal(a.store.structure.contents.get(a.store.region(id(1))[0].key),carrier)
  assert.equal(wordCheckpointContents({regions:a.store.capture().regions.slice(0,before.regions.length)}),wordCheckpointContents(before))
  assert.deepEqual(labels(a.store,3),['Peer draft']);assert.deepEqual(labels(a.store,6),['Copied header'])
  const added=a.store.capture().regions.at(-1)!.blocks[0];assert.equal(added.blockId,id(106));assert.equal(added.content.inlines[0].nodeId,id(206))
  edit(b.store,4,'Late peer footer');Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document));assert.deepEqual(labels(a.store,4),['Late peer footer'])
  history.undo();assert.notDeepEqual(labels(a.store,1),['My draft']);assert.deepEqual(labels(a.store,3),['Peer draft']);assert.deepEqual(labels(a.store,6),['Copied header'])
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})
test('observer failure after a committed story update does not roll back only local fence metadata',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const f=create(base),intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1)),fail=()=>{if(f.document.getMap(wordRegionStoreField).get('layoutHash')===next.flowLayoutHash)throw new Error('observer-failed')}
 try{f.document.on('afterTransaction',fail);assert.throws(()=>f.store.acceptStoryReceipt(base,next,intent,expected),/observer-failed/);f.document.off('afterTransaction',fail);assert.equal(f.store.capture().layoutHash,next.flowLayoutHash);assert.deepEqual(labels(f.store,6),['Copied header'])}finally{f.document.off('afterTransaction',fail);f.document.destroy()}
})
test('staging rejects a source identity change even when visible text stays identical',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const f=create(base),intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1)),original=SemanticBlockStore.prototype.insert,bytes=Y.encodeStateAsUpdate(f.document)
 try{
  SemanticBlockStore.prototype.insert=function(nodes,before){const result=original.call(this,nodes,before),body=this.blocks().find(block=>block.node.type.name!=='hcdWordRegionBoundary')!,owner=this.owners.get(body.key);assert.ok(owner);this.canonicalIds.set(owner,id(900));return result}
  assert.throws(()=>f.store.acceptStoryReceipt(base,next,intent,expected),/wordStoryMigrationChangedInput/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
 }finally{SemanticBlockStore.prototype.insert=original;f.document.destroy()}
})
test('a peer adopts verified new story metadata without replacing its unsaved edits',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1)),a=create(base),b=clone(a.document),history=b.store.structure.undoManager()
 try{
  edit(b.store,1,'Peer unsaved');history.stopCapturing();const carrier=b.store.structure.contents.get(b.store.region(id(1))[0].key)
  a.store.acceptStoryReceipt(base,next,intent,expected)
  assert.throws(()=>b.store.syncStoryReceipt(base,next,intent,expected),/wordRegionLayoutChanged/)
  Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document));assert.throws(()=>b.store.capture(),/invalidWordRegionMetadata/)
  b.store.syncStoryReceipt(base,next,intent,expected)
  assert.equal(b.store.structure.contents.get(b.store.region(id(1))[0].key),carrier);assert.equal(labels(b.store,1)[0],'Peer unsaved');assert.deepEqual(labels(b.store,6),['Copied header'])
  edit(b.store,6,'Peer updates new header');Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document));assert.deepEqual(labels(a.store,6),['Peer updates new header'])
  history.undo();assert.equal(labels(b.store,1)[0],'Peer unsaved');assert.deepEqual(labels(b.store,6),['Copied header'])
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})
test('a peer does not adopt a mismatched new story or discard it',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'header',sourcePart:'word/header2.xml'});next.flowLayout.sections[1].headers.default=id(6)
 next.blocks.push({flowRegionId:id(6),region:'header',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(206),text:'Copied header'}]}})
 const intent={sectionId:id(2),kind:'header' as const,variant:'default' as const,expectedInheritedStoryId:id(3)},expected=structuredClone(next.blocks.slice(-1)),a=create(base),b=clone(a.document)
 try{
  a.document.getMap('baseline-delete-test').set('item','value');Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
  a.store.acceptStoryReceipt(base,next,intent,expected);Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
  const newer=new WordRegionStore(b.document,schema,base.documentId,next.flowLayout,next.flowLayoutHash);edit(newer,6,'Later peer content')
  const bytes=Y.encodeStateAsUpdate(b.document);assert.throws(()=>b.store.syncStoryReceipt(base,next,intent,expected),/wordStoryMigrationChangedContent/);assert.deepEqual(Y.encodeStateAsUpdate(b.document),bytes);assert.deepEqual(labels(newer,6),['Later peer content'])
  assert.throws(()=>b.store.syncStoryReceipt(base,next,intent,expected,Y.encodeStateAsUpdate(b.document)),/wordStoryMigrationInvalidBaseline/);assert.deepEqual(Y.encodeStateAsUpdate(b.document),bytes)
  const incomplete=new Y.Doc();try{Y.applyUpdate(incomplete,Y.encodeStateAsUpdate(a.document));const other=new WordRegionStore(incomplete,schema,base.documentId,next.flowLayout,next.flowLayoutHash);edit(other,3,'A baseline operation not received');assert.throws(()=>b.store.syncStoryReceipt(base,next,intent,expected,Y.encodeStateAsUpdate(incomplete)),/wordStoryMigrationMissingBaseline/);assert.deepEqual(Y.encodeStateAsUpdate(b.document),bytes)}finally{incomplete.destroy()}
  const deleted=new Y.Doc();try{Y.applyUpdate(deleted,Y.encodeStateAsUpdate(a.document));deleted.getMap('baseline-delete-test').delete('item');assert.throws(()=>b.store.syncStoryReceipt(base,next,intent,expected,Y.encodeStateAsUpdate(deleted)),/wordStoryMigrationMissingBaseline/);assert.deepEqual(Y.encodeStateAsUpdate(b.document),bytes)}finally{deleted.destroy()}
  b.store.syncStoryReceipt(base,next,intent,expected,Y.encodeStateAsUpdate(a.document));assert.deepEqual(labels(b.store,6),['Later peer content']);assert.deepEqual(Y.encodeStateAsUpdate(b.document),bytes)
 }finally{a.document.destroy();b.document.destroy()}
})
test('explicit regional bootstrap keeps every body/story, including unbound ones, and never emits fences',()=>{
 const f=create();try{
  assert.equal(f.store.initialized,true);assert.deepEqual(f.store.capture().regions.map(region=>region.regionId),[1,2,3,4,5].map(id));assert.equal(f.store.capture().sources.length,6)
  assert.equal(f.store.capture().regions.flatMap(region=>region.blocks).some(block=>block.content.kind==='opaque'),false)
  assert.throws(()=>f.store.initialize(fixture()),/alreadyInitialized/)
  const b=clone(f.document);try{assert.equal(b.store.contents(),f.store.contents());assert.equal(b.store.project(id(3)).textContent,fixture().blocks[3].content.inlines[0].text)}finally{b.document.destroy()}
 }finally{f.document.destroy()}
})
for(const reverse of [false,true])test(`concurrent body movement and named header text retain permanent carriers; reverse=${reverse}`,()=>{
 const a=create(),b=clone(a.document);try{
  const before=a.store.region(id(1)),carrier=a.store.structure.contents.get(before[0].key)
  a.store.reconcile(id(1),before,[before[1],before[0]]);edit(b.store,3,'Peer header 😀');edit(b.store,1,'Peer body 😀');sync(a.document,b.document,reverse)
  assert.deepEqual(labels(a.store,1),['Region 1 text 1 😀','Peer body 😀']);assert.deepEqual(labels(a.store,3),['Peer header 😀']);assert.equal(a.store.contents(),b.store.contents());assert.equal(a.store.structure.contents.get(before[0].key),carrier)
 }finally{a.document.destroy();b.document.destroy()}
})
test('region edits cannot claim another region key/source or move a fence; rejected plans leave bytes unchanged',()=>{
 const f=create();try{
  const before=f.store.region(id(1)),foreign=f.store.region(id(3))[0],bytes=Y.encodeStateAsUpdate(f.document)
  for(const after of [[foreign],[{node:foreign.node}],[{node:schema.nodes.paragraph.createChecked({hcdSourceId:id(203)},schema.text('foreign'))}],[{node:schema.nodes[wordBoundaryName].createChecked({regionId:id(3)})}]]){
   assert.throws(()=>f.store.reconcile(id(1),before,after),/crossWordRegion|wordRegionBoundary/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
  }
  const changed=before.map(block=>({...block,node:block.node.type.createChecked(block.node.attrs,schema.text('stale'))}));assert.throws(()=>f.store.reconcile(id(1),changed,before),/staleWordRegion/)
 }finally{f.document.destroy()}
})
test('malformed scopes and missing stories fail before initialization; copied legacy rooms are not migrated',()=>{
 for(const change of [(p:WordRegionProjection)=>p.blocks.pop(),(p:WordRegionProjection)=>{p.blocks[0].flowRegionId=id(99)},(p:WordRegionProjection)=>{p.blocks[0].region='header'},(p:WordRegionProjection)=>{delete p.blocks[0].flowRegionId}]){
  const projection=fixture();change(projection);const document=new Y.Doc(),store=new WordRegionStore(document,schema,projection.documentId,projection.flowLayout,hash);try{const before=Y.encodeStateAsUpdate(document);assert.throws(()=>store.initialize(projection));assert.deepEqual(Y.encodeStateAsUpdate(document),before)}finally{document.destroy()}
 }
 const f=create();try{f.document.getMap(wordRegionStoreField).set('layoutHash','b'.repeat(64));assert.throws(()=>f.store.capture(),/invalidWordRegionMetadata/)}finally{f.document.destroy()}
})
test('deleting the last editable paragraph seeds an empty region while opaque field caches stay read-only',()=>{
 const f=create();try{const before=f.store.region(id(4));f.store.reconcile(id(4),before,[],{deletedKeys:before.map(block=>block.key)});assert.equal(f.store.capture().regions.find(region=>region.regionId===id(4))!.blocks.length,1);assert.deepEqual(labels(f.store,4),['']);assert.deepEqual(labels(f.store,3),['Region 3 text 3 😀'])}finally{f.document.destroy()}
 const projection=fixture();projection.blocks[3].readOnly=true;const g=create(projection);try{const before=g.store.region(id(3)),bytes=Y.encodeStateAsUpdate(g.document);assert.equal(before[0].node.type.name,'hcdOpaque');assert.throws(()=>g.store.reconcile(id(3),before,[]),/readOnlyWordBlock/);assert.deepEqual(Y.encodeStateAsUpdate(g.document),bytes)}finally{g.document.destroy()}
})
test('a saved receipt rebinds only captured sources and preserves typing that arrived during save',()=>{
 const f=create();try{
  const captured=f.store.capture();edit(f.store,3,'Typed while saving 😀');const canonical=fixture();canonical.revision=2;canonical.flowLayoutHash='b'.repeat(64);canonical.blocks.forEach((block,index)=>{block.blockId=id(300+index);block.content.inlines[0].nodeId=id(400+index)})
  let observed=false;f.document.on('afterTransaction',()=>{if(f.document.getMap(wordRegionStoreField).get('layoutHash')===canonical.flowLayoutHash){f.store.capture();observed=true}})
  f.store.acceptSources(captured,canonical);assert.equal(observed,true);assert.deepEqual(labels(f.store,3),['Typed while saving 😀']);assert.equal(f.store.capture().layoutHash,canonical.flowLayoutHash);assert.equal(f.store.capture().regions[2].blocks[0].blockId,id(303));assert.throws(()=>f.store.acceptSources(captured,canonical),/wordRegionLayoutChanged/)
 }finally{f.document.destroy()}
})
test('a regional receipt reads source claims before the mutation transaction and publishes one coherent layout',()=>{
 const initial=fixture();initial.blocks.push(...Array.from({length:80},(_,index)=>({flowRegionId:id(2),region:'body',blockId:id(1000+index),blockHash:hash,readOnly:false,content:{kind:'heading' as const,level:2,inlines:[{text:'Long heading '+index,nodeId:id(2000+index)}]}})))
 const f=create(initial);try{
  const captured=f.store.capture(),canonical=structuredClone(initial);canonical.revision=2;canonical.flowLayoutHash='b'.repeat(64);canonical.blocks.forEach((block,index)=>{block.blockId=id(3000+index);block.content.inlines[0].nodeId=id(4000+index)})
  const read=f.store.structure.content.bind(f.store.structure);let reads=0,updates=0
  f.store.structure.content=key=>{reads++;assert.equal(f.document._transaction,null,'source planning must reuse the immutable projection');return read(key)}
  f.document.on('update',()=>{updates++;assert.equal(f.store.layoutState().layoutHash,canonical.flowLayoutHash);assert.equal(f.store.capture().regions.flatMap(region=>region.blocks).length,canonical.blocks.length)})
  f.store.acceptSources(captured,canonical);assert.ok(reads>=canonical.blocks.length);assert.equal(updates,1);assert.deepEqual(f.store.capture().regions.flatMap(region=>region.blocks).map(block=>block.blockId).sort(),canonical.blocks.map(block=>block.blockId).sort())
 }finally{f.document.destroy()}
})
test('a malformed final source claim cannot partially rebind earlier regions or publish a new layout',()=>{
 const f=create();try{const captured=f.store.capture(),canonical=fixture();canonical.revision=2;canonical.flowLayoutHash='b'.repeat(64);canonical.blocks.forEach((block,index)=>{block.blockId=id(5000+index);block.content.inlines[0].nodeId=id(6000+index)})
  const last=captured.sources.at(-1)!;assert.ok(!(last instanceof Y.XmlElement));last.bindings![0].shape='corrupted';const before=Y.encodeStateAsUpdate(f.document),layout=f.store.layoutState()
  assert.throws(()=>f.store.acceptSources(captured,canonical),/Invalid structural source capture/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.deepEqual(f.store.layoutState(),layout)
 }finally{f.document.destroy()}
})
test('verified layout-only receipt advances the fence without rewriting concurrent text or undo history',()=>{
 const a=create(),b=clone(a.document),history=a.store.structure.undoManager();try{
  edit(a.store,1,'My body');history.stopCapturing();edit(b.store,3,'Peer header');sync(a.document,b.document)
  const before=a.store.capture(),carrier=a.store.structure.contents.get(a.store.region(id(1))[0].key),next=structuredClone(fixture().flowLayout)
  next.sections[0].page.widthTwips=12240;next.sections[0].differentFirstPage=true;next.evenAndOddHeaders=false
  let observed=false;a.document.on('afterTransaction',()=>{if(a.document.getMap(wordRegionStoreField).get('layoutHash')==='b'.repeat(64)){assert.equal(a.store.capture().layoutHash,'b'.repeat(64));observed=true}})
  a.store.acceptLayoutFields(hash,next,'b'.repeat(64),layoutRequest());assert.equal(observed,true);assert.equal(a.store.structure.contents.get(a.store.region(id(1))[0].key),carrier)
  assert.equal(wordCheckpointContents(a.store.capture()),wordCheckpointContents(before));assert.deepEqual(labels(a.store,3),['Peer header'])
  history.undo();assert.notDeepEqual(labels(a.store,1),['My body']);assert.deepEqual(labels(a.store,3),['Peer header']);assert.equal(a.store.layoutState().layout.sections[0].page.widthTwips,12240)
  assert.throws(()=>a.store.acceptLayoutFields(hash,next,'c'.repeat(64),layoutRequest()),/wordRegionLayoutChanged/)
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})
test('layout-only receipt rejects changed section and story topology without changing room bytes',()=>{
 const f=create();try{
  for(const change of [
   (p:WordLayoutForTest)=>{p.sections[0].headers.default=id(5)},
   (p:WordLayoutForTest)=>{p.stories[0].sourcePart='word/other.xml'},
   (p:WordLayoutForTest)=>{p.sections.reverse()},
   (p:WordLayoutForTest)=>{p.sections[0].page.heightTwips=9000},
   (p:WordLayoutForTest)=>{(p.sections[0].page as Record<string,unknown>).futureField=1},
   (p:WordLayoutForTest)=>{(p.sections[0].page as {marginsTwips?:Record<string,number>}).marginsTwips={future:1}},
  ]){
   const next=structuredClone(fixture().flowLayout);next.sections[0].page.widthTwips=12240;next.sections[0].differentFirstPage=true;next.evenAndOddHeaders=false;change(next);const bytes=Y.encodeStateAsUpdate(f.document),prior=f.store.layoutState()
   assert.throws(()=>f.store.acceptLayoutFields(hash,next,'b'.repeat(64),layoutRequest()));assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes);assert.deepEqual(f.store.layoutState(),prior)
  }
 }finally{f.document.destroy()}
})
type WordLayoutForTest=ReturnType<typeof fixture>['flowLayout']
test('Notion block conversion in a scoped editor keeps other regions and participates in local-only history',()=>{
 const a=create(),b=clone(a.document),history=a.store.structure.undoManager();try{
  const before=a.store.region(id(1)),doc=a.store.project(id(1)),state=EditorState.create({schema,doc}),target=blockTarget(state,rootBlocks(doc).slice(0,1))!,transaction=state.tr
  assert.equal(transformBlocks(transaction,'block.heading',undefined,target),true)
  const next=rootBlocks(transaction.doc).map(root=>({key:root.node.attrs.hcdStructureKey,node:root.node}));a.store.reconcile(id(1),before,next);history.stopCapturing();edit(b.store,3,'Peer header survives undo');sync(a.document,b.document)
  assert.equal(a.store.region(id(1))[0].node.type.name,'heading');history.undo();sync(a.document,b.document);assert.equal(a.store.region(id(1))[0].node.type.name,'paragraph');assert.deepEqual(labels(a.store,3),['Peer header survives undo'])
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})

test('the existing ProseMirror binding edits one region, merges remote region input, and rejects a foreign pasted source',async()=>{
 const {semanticStructureBinding}=await import('./semanticStructureBinding.ts')
 const {blockIdentityPlugin,sourceIdentityPlugin}=await import('./schema.ts')
 const a=create(),b=clone(a.document),errors:unknown[]=[]
 function engine(store:WordRegionStore,region:number,canWrite:()=>boolean){
  const plugin=semanticStructureBinding(store.view(id(region)),{canWrite,onError:error=>errors.push(error)})
  let state=EditorState.create({schema,doc:store.project(id(region)),plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),plugin]}),binding:ReturnType<NonNullable<typeof plugin.spec.view>>|undefined
  const view={get state(){return state},dispatch(transaction:import('@tiptap/pm/state').Transaction){const previous=state;state=state.applyTransaction(transaction).state;binding?.update?.(view as any,previous)}}
  binding=plugin.spec.view!(view as any)
  return{view,get:()=>state,dispatch:view.dispatch,destroy:()=>binding?.destroy?.()}
 }
 const body=engine(a.store,1,()=>true),header=engine(b.store,3,()=>true),reader=engine(b.store,4,()=>false)
 try{
  await Promise.resolve();body.dispatch(body.get().tr.insertText('本地正文 ',1));header.dispatch(header.get().tr.insertText('远端页眉 ',1));sync(a.document,b.document)
  assert.match(body.get().doc.textContent,/本地正文/);assert.match(header.get().doc.textContent,/远端页眉/);assert.match(a.store.project(id(3)).textContent,/远端页眉/)
  const before=Y.encodeStateAsUpdate(a.document),previous=body.get().doc
  body.dispatch(body.get().tr.replaceWith(0,body.get().doc.child(0).nodeSize,header.get().doc.child(0)))
  assert.ok(body.get().doc.eq(previous));assert.deepEqual(Y.encodeStateAsUpdate(a.document),before);assert.ok(errors.some(error=>String(error).includes('crossWordRegion')))
  const readerBefore=Y.encodeStateAsUpdate(b.document);reader.dispatch(reader.get().tr.insertText('denied',1));assert.deepEqual(Y.encodeStateAsUpdate(b.document),readerBefore)
  assert.equal(body.get().doc.content.content.some(node=>node.type.name===wordBoundaryName),false)
 }finally{body.destroy();header.destroy();reader.destroy();a.document.destroy();b.document.destroy()}
})

test('a legacy default fragment cannot be silently projected into the regional model',()=>{
 const document=new Y.Doc(),projection=fixture(),paragraph=new Y.XmlElement('paragraph'),text=new Y.XmlText();text.insert(0,'Legacy pending text');paragraph.insert(0,[text]);document.getXmlFragment('default').insert(0,[paragraph]);document.getMap('hcdSchema').set('typography',2)
 const store=new WordRegionStore(document,schema,projection.documentId,projection.flowLayout,projection.flowLayoutHash),before=Y.encodeStateAsUpdate(document)
 try{assert.throws(()=>store.initialize(projection),/alreadyInitialized/);assert.deepEqual(Y.encodeStateAsUpdate(document),before);assert.equal(document.getMap(wordRegionStoreField).size,0)}finally{document.destroy()}
})
test('a replicated fence reorder is quarantined rather than interpreted as a different regional topology',()=>{
 const f=create();try{const keys=f.store.structure.keys();f.store.structure.move([keys[0]],null);assert.throws(()=>f.store.capture(),/wordRegionBoundaryChanged|unscopedWordBlock/)}finally{f.document.destroy()}
})

test('unknown shared data and unsupported schema flags are retained rather than overwritten at bootstrap',()=>{
 for(const field of ['business', 'hcdSchema']){const document=new Y.Doc(),projection=fixture();document.getMap(field).set(field==='hcdSchema'?'typography':'opaque',99);const store=new WordRegionStore(document,schema,projection.documentId,projection.flowLayout,hash),before=Y.encodeStateAsUpdate(document);try{assert.throws(()=>store.initialize(projection),/alreadyInitialized|unsupportedWordRegionSchema/);assert.deepEqual(Y.encodeStateAsUpdate(document),before)}finally{document.destroy()}}
})

test('canonical ID/layout acknowledgements do not create phantom edits, and capture digests never read later input',()=>{
 const f=create();try{const captured=f.store.capture(),before=wordCheckpointContents(captured),canonical=fixture();canonical.revision=2;canonical.flowLayoutHash='c'.repeat(64);canonical.blocks.forEach((block,index)=>{block.blockId=id(600+index);block.content.inlines[0].nodeId=id(700+index)})
  f.store.acceptSources(captured,canonical);assert.equal(f.store.contents(),before);edit(f.store,3,'Later text');assert.equal(wordCheckpointContents(captured),before);assert.notEqual(f.store.contents(),before)
 }finally{f.document.destroy()}
})

test('device snapshot preview stays isolated and refuses a different layout',()=>{
 const saved=create(),live=create();try{
  edit(saved.store,1,'Private backup');edit(live.store,1,'Current document');const before=Y.encodeStateAsUpdate(live.document)
  const preview=wordDeviceBackupPreview(Y.encodeStateAsUpdate(saved.document),live.store);assert.match(preview.regions[0].text,/Private backup\nRegion 1 text 1/);assert.doesNotMatch(preview.regions[0].text,/Current document/);assert.deepEqual(preview.regions.map(region=>[region.kind,region.number]),[['body',1],['body',2],['header',1],['footer',1],['footer',2]]);assert.equal(preview.truncated,false);assert.deepEqual(Y.encodeStateAsUpdate(live.document),before)
  const short=wordDeviceBackupPreview(Y.encodeStateAsUpdate(saved.document),live.store,5);assert.equal(short.regions[0].text,'Priva');assert.equal(short.truncated,true)
  edit(saved.store,1,'😀tail');const unicode=wordDeviceBackupPreview(Y.encodeStateAsUpdate(saved.document),live.store,1);assert.equal(unicode.regions[0].text,'');assert.equal(unicode.truncated,true)
  saved.document.getMap(wordRegionStoreField).set('layoutHash','f'.repeat(64));assert.throws(()=>wordDeviceBackupPreview(Y.encodeStateAsUpdate(saved.document),live.store));assert.deepEqual(Y.encodeStateAsUpdate(live.document),before)
 }finally{saved.document.destroy();live.document.destroy()}
})

test('device text download includes all regions and refuses partial output',async()=>{
 const saved=create(),live=create();try{
  edit(saved.store,1,'长文😀'.repeat(1500));const update=Y.encodeStateAsUpdate(saved.document),before=Y.encodeStateAsUpdate(live.document)
  const result=wordDeviceBackupTextFile(update,live.store,region=>`${region.kind} ${region.number}`),text=await result.blob.text()
  assert.equal(result.name,'word-backup-text.txt');assert.match(text,/\[body 1\]\n长文😀/);assert.match(text,/\[header 1\]/);assert.match(text,/\[footer 2\]/);assert.ok(text.length>4000);assert.deepEqual(Y.encodeStateAsUpdate(live.document),before)
  assert.throws(()=>wordDeviceBackupTextFile(update,live.store,()=>'',10),/word-device-text-limit/)
 }finally{saved.document.destroy();live.document.destroy()}
})

test('device text export keeps hard breaks and person mentions readable',async()=>{
 const saved=create(),live=create();try{
  const blocks=saved.store.region(id(1)),original=blocks[0].node,reference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}}
  const content=original.type.createChecked(original.attrs,[schema.text('Before'),schema.nodes.hardBreak.create(),schema.nodes.hcdMention.createChecked({reference}),schema.text(' after')])
  saved.store.reconcile(id(1),blocks,[{key:blocks[0].key,node:content},...blocks.slice(1)])
  const file=wordDeviceBackupTextFile(Y.encodeStateAsUpdate(saved.document),live.store,region=>region.kind),text=await file.blob.text()
  assert.match(text,/Before\n@Alice 王 after/)
 }finally{saved.document.destroy();live.document.destroy()}
})
test('blank independent story accepts only the native empty placeholder',()=>{
 const base=fixture(),next=structuredClone(base);next.revision=2;next.flowLayoutHash='b'.repeat(64);next.flowLayout.stories.push({id:id(6),kind:'footer',sourcePart:'word/footer2.xml'});next.flowLayout.sections[1].footers.even=id(6)
 const block={flowRegionId:id(6),region:'footer',readOnly:false,blockId:id(106),blockHash:hash,content:{kind:'paragraph' as const,inlines:[{text:'',nodeId:id(206),bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false}]}}
 next.blocks.push(block);const expected=structuredClone([block]);expected[0].content.inlines=[]
 const intent={sectionId:id(2),kind:'footer' as const,variant:'even' as const,expectedInheritedStoryId:null};assert.deepEqual(verifyWordStoryReceipt(base,next,intent,expected),next)
 for(const change of [(b:any)=>{b.content.inlines[0].text='unreviewed'},(b:any)=>{b.content.inlines[0].bold=true},(b:any)=>{b.content.inlines[0].nodeId=id(200)}]){const bad=structuredClone(next);change(bad.blocks.at(-1));assert.throws(()=>verifyWordStoryReceipt(base,bad,intent,expected))}
})
