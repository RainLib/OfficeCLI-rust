import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import {WordRegionStore,wordRegionSchema,wordBoundaryName,type WordRegionProjection} from './wordRegionStore.ts'
import {wordOutline,wordOutlinePosition,wordOutlineTransaction,wordOutlineSnapshotTransaction} from './wordOutline.ts'
import {waitForWordNode} from './wordNodeLocation.ts'

const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),schema=wordRegionSchema()
function projection():WordRegionProjection{
 const body=(text:string,level=1)=>({kind:'heading' as const,level,inlines:[{text,nodeId:id(200+text.length)}]})
 return{documentId:'outline',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[1,2].map(n=>({id:id(n),differentFirstPage:false,page:{},headers:n===1?{default:id(3)}:{},footers:n===1?{default:id(4)}:{}})),stories:[{id:id(3),kind:'header',sourcePart:'word/header1.xml'},{id:id(4),kind:'footer',sourcePart:'word/footer1.xml'}]},blocks:[
  {flowRegionId:id(1),region:'body',blockId:id(11),blockHash:hash,readOnly:false,content:body('Same title')},
  {flowRegionId:id(1),region:'body',blockId:id(12),blockHash:hash,readOnly:false,content:{kind:'blockquote',inlines:[],children:[body('Nested heading',3)]}},
  {flowRegionId:id(2),region:'body',blockId:id(13),blockHash:hash,readOnly:false,content:body('Same title',2)},
  {flowRegionId:id(3),region:'header',blockId:id(14),blockHash:hash,readOnly:false,content:body('Header is not a body heading')},
  {flowRegionId:id(4),region:'footer',blockId:id(15),blockHash:hash,readOnly:false,content:body('Footer is not a body heading')},
 ]}
}
function fixture(){const value=projection(),document=new Y.Doc({gc:false}),store=new WordRegionStore(document,schema,value.documentId,value.flowLayout,hash);store.initialize(value);return{value,document,store,outline:()=>wordOutline(value.flowLayout,store.structure.project())}}

test('regional outline includes nested headings in document order across sections and excludes stories',()=>{
 const f=fixture();try{const before=Y.encodeStateAsUpdate(f.document),entries=f.outline();assert.deepEqual(entries.map(v=>[v.sectionId,v.level,v.text]),[[id(1),1,'Same title'],[id(1),3,'Nested heading'],[id(2),2,'Same title']]);assert.notEqual(entries[0].key,entries[2].key);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(wordOutlinePosition(f.store.project(id(1)),entries[2]),null)}finally{f.document.destroy()}
})
test('a stable heading target follows earlier insertion, movement and rename instead of stale offsets or duplicate titles',()=>{
 const f=fixture();try{const entry=f.outline()[2],before=f.store.region(id(2)),heading=before[0].node,renamed=heading.type.createChecked(heading.attrs,schema.text('Renamed 😀',heading.firstChild?.marks));f.store.reconcile(id(2),before,[{node:schema.nodes.paragraph.createChecked(null,schema.text('Inserted before'))},{key:before[0].key,node:renamed}]);const doc=f.store.project(id(2)),position=wordOutlinePosition(doc,entry);assert.ok(position!==null&&position>0);assert.equal(doc.nodeAt(position)!.textContent,'Renamed 😀');const current=f.outline().find(v=>v.key===entry.key)!;assert.equal(current.text,'Renamed 😀');assert.equal(current.sectionId,entry.sectionId)}finally{f.document.destroy()}
})
test('conversion and deletion invalidate the old heading target without jumping to a same-title replacement',()=>{
 const f=fixture();try{const entry=f.outline()[0],before=f.store.region(id(1)),first=before[0];f.store.reconcile(id(1),before,[{key:first.key,node:schema.nodes.paragraph.createChecked(first.node.attrs,first.node.content)},...before.slice(1)]);assert.equal(wordOutlinePosition(f.store.project(id(1)),entry),null);const next=f.store.region(id(1));f.store.reconcile(id(1),next,[...next.slice(1),{node:schema.nodes.heading.createChecked({level:1},schema.text(entry.text))}],{deletedKeys:[next[0].key]});assert.equal(wordOutlinePosition(f.store.project(id(1)),entry),null);assert.ok(f.outline().some(v=>v.text===entry.text&&v.key!==entry.key))}finally{f.document.destroy()}
})
test('peer deletion while a target editor is still mounting reports the missing heading immediately',()=>{
 const f=fixture(),peer=new Y.Doc({gc:false});try{
  const entry=f.outline()[2];Y.applyUpdate(peer,Y.encodeStateAsUpdate(f.document));const other=new WordRegionStore(peer,schema,f.value.documentId,f.value.flowLayout,hash),before=other.region(id(2));let missing=0,attempts=0
  const stop=waitForWordNode({exists:()=>wordOutlinePosition(f.store.project(entry.sectionId),entry)!==null,locate:()=>{attempts++;return false},subscribe:listener=>{f.document.on('update',listener);return()=>f.document.off('update',listener)},missing:()=>missing++})
  assert.equal(attempts,1);other.reconcile(id(2),before,[{node:schema.nodes.heading.createChecked({level:2},schema.text('Same title'))}],{deletedKeys:[before[0].key]});Y.applyUpdate(f.document,Y.encodeStateAsUpdate(peer,Y.encodeStateVector(f.document)))
  assert.equal(missing,1);assert.equal(wordOutlinePosition(f.store.project(entry.sectionId),entry),null);assert.ok(f.outline().some(item=>item.sectionId===id(2)&&item.text==='Same title'&&item.key!==entry.key));stop()
 }finally{peer.destroy();f.document.destroy()}
})
test('navigation is a selection-only transaction and does not create shared writes or personal history',()=>{
 const f=fixture(),history=f.store.structure.undoManager();try{const entry=f.outline()[1],state=EditorState.create({schema,doc:f.store.project(id(1))}),before=Y.encodeStateAsUpdate(f.document),transaction=wordOutlineTransaction(state,entry)!;assert.ok(transaction);assert.equal(transaction.docChanged,false);assert.equal(transaction.getMeta('addToHistory'),false);assert.equal(transaction.selection.$from.parent.type.name,'heading');assert.equal(transaction.selection.$from.parent.textContent,'Nested heading');assert.equal(state.apply(transaction).doc.eq(state.doc),true);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.equal(history.undoStack.length,0)}finally{history.destroy();f.document.destroy()}
})
test('save receipts may replace canonical block/source IDs without changing outline identity',()=>{
 const f=fixture();try{const before=f.outline(),capture=f.store.capture(),saved=projection();saved.revision=2;saved.flowLayoutHash='b'.repeat(64);saved.blocks.forEach((block,index)=>{block.blockId=id(500+index);const visit=(content:typeof block.content)=>{content.inlines.forEach(inline=>{inline.nodeId=id(600+index)});content.children?.forEach(visit)};visit(block.content)});f.store.acceptSources(capture,saved);assert.deepEqual(f.outline(),before);for(const entry of before)assert.notEqual(wordOutlinePosition(f.store.project(entry.sectionId),entry),null)}finally{f.document.destroy()}
})
test('peer heading changes refresh the outline without changing another region or its body identity',()=>{
 const a=fixture(),document=new Y.Doc({gc:false});Y.applyUpdate(document,Y.encodeStateAsUpdate(a.document));const b=new WordRegionStore(document,schema,a.value.documentId,a.value.flowLayout,hash)
 try{const entries=a.outline(),before=b.region(id(2)),heading=before[0];b.reconcile(id(2),before,[{key:heading.key,node:heading.node.type.createChecked(heading.node.attrs,schema.text('Peer heading',heading.node.firstChild?.marks))}]);Y.applyUpdate(a.document,Y.encodeStateAsUpdate(document));const after=a.outline();assert.deepEqual(after.slice(0,2),entries.slice(0,2));assert.equal(after[2].key,entries[2].key);assert.equal(after[2].text,'Peer heading')}finally{a.document.destroy();document.destroy()}
})
test('outline labels retain inline person names and emoji, while long lists are not silently truncated',()=>{
 const layout=projection().flowLayout,boundary=schema.nodes[wordBoundaryName].createChecked({regionId:id(1)}),reference={type:'hcd.mention',version:1,mentionId:'m_'+'1'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}},heading=schema.nodes.heading.createChecked({level:2,hcdStructureKey:'person-heading'},[schema.text('Review 😀 '),schema.nodes.hcdMention.createChecked({reference})]),many=Array.from({length:4000},(_,n)=>schema.nodes.heading.createChecked({level:1,hcdStructureKey:'heading-'+n},schema.text('Title '+n))),entries=wordOutline(layout,schema.nodes.doc.createChecked(null,[boundary,heading,...many]));assert.equal(entries.length,4001);assert.equal(entries[0].text,'Review 😀 @Alice 王');assert.equal(entries.at(-1)!.text,'Title 3999')
})
test('outline search matches beyond the shortened label and keeps empty-title lookup',()=>{
 const layout=projection().flowLayout,boundary=schema.nodes[wordBoundaryName].createChecked({regionId:id(1)}),long='😀'.repeat(300)+' Secret Tail',heading=schema.nodes.heading.createChecked({level:1,hcdStructureKey:'long'},schema.text(long)),empty=schema.nodes.heading.createChecked({level:2,hcdStructureKey:'empty'}),doc=schema.nodes.doc.createChecked(null,[boundary,heading,empty])
 let total=0;const result=wordOutline(layout,doc,{search:{term:'secret tail',locale:'en-US',untitled:'Untitled'},onHeading:()=>total++})
 assert.equal(total,2);assert.equal(result.length,1);assert.equal(result[0].key,'long');assert.match(result[0].text,/Secret Tail/);assert.ok(result[0].text.startsWith('…'));assert.ok(Array.from(result[0].text).length<=258)
 const emptyResult=wordOutline(layout,doc,{search:{term:'untitled',locale:'en-US',untitled:'Untitled'}});assert.deepEqual(emptyResult.map(item=>item.key),['empty'])
 assert.equal(wordOutline(layout,doc,{search:{term:'missing',locale:'en-US',untitled:'Untitled'}}).length,0)
})
test('outline excerpts include matches crossing the display boundary without splitting emoji',()=>{
 const layout=projection().flowLayout,boundary=schema.nodes[wordBoundaryName].createChecked({regionId:id(1)}),long='😀'.repeat(252)+'SeCrEt ending',heading=schema.nodes.heading.createChecked({level:1,hcdStructureKey:'crossing'},schema.text(long)),doc=schema.nodes.doc.createChecked(null,[boundary,heading])
 const [entry]=wordOutline(layout,doc,{search:{term:'secret',locale:'en-US',untitled:'Untitled'}})
 assert.match(entry.text,/SeCrEt/);assert.equal(entry.text.includes('\ufffd'),false);assert.ok(entry.text.startsWith('…'));assert.ok(Array.from(entry.text).length<=258)
})
test('outline search maps expanded Unicode lowercase offsets back to the original heading',()=>{
 const layout=projection().flowLayout,boundary=schema.nodes[wordBoundaryName].createChecked({regionId:id(1)}),long='İ'.repeat(400)+' FindMe '+'x'.repeat(1000),heading=schema.nodes.heading.createChecked({level:1,hcdStructureKey:'unicode'},schema.text(long)),doc=schema.nodes.doc.createChecked(null,[boundary,heading])
 const [entry]=wordOutline(layout,doc,{search:{term:'findme',locale:'en-US',untitled:'Untitled'}})
 assert.match(entry.text,/FindMe/);assert.ok(entry.text.startsWith('…'));assert.ok(Array.from(entry.text).length<=258)
})
test('missing fences and duplicated heading keys cannot identify an arbitrary navigation target',()=>{
 const layout=projection().flowLayout,heading=schema.nodes.heading.createChecked({level:1,hcdStructureKey:'duplicate'},schema.text('Same')),boundary=schema.nodes[wordBoundaryName].createChecked({regionId:id(1)}),doc=schema.nodes.doc.createChecked(null,[boundary,heading,heading]),entry={sectionId:id(1),key:'duplicate',level:1,text:'Same'};assert.deepEqual(wordOutline(layout,schema.nodes.doc.createChecked(null,heading)),[]);assert.throws(()=>wordOutline(layout,doc),/word-outline-identity/);assert.equal(wordOutlinePosition(doc,entry),null);assert.equal(wordOutlineTransaction(EditorState.create({schema,doc}),entry),null)
})
test('static outline inserts full body heading labels after the cursor block without replacing content',()=>{
 const f=fixture();try{
  const initial=f.store.region(id(1)),heading=initial[0],long='长😀'.repeat(180)
  f.store.reconcile(id(1),initial,[{key:heading.key,node:heading.node.type.createChecked(heading.node.attrs,schema.text(long))},...initial.slice(1)])
  const entries=wordOutline(f.value.flowLayout,f.store.structure.project(),{fullLabels:true});assert.equal(entries[0].text,long);assert.equal(entries.length,3)
  const doc=f.store.project(id(1)),state=EditorState.create({schema,doc}),transaction=wordOutlineSnapshotTransaction(state,entries,'Untitled')!
  const after=state.apply(transaction).doc;assert.equal(after.childCount,doc.childCount+3);assert.equal(after.child(0).textContent,long);assert.equal(after.child(1).textContent,'• '+long);assert.equal(after.child(2).textContent,'— — • Nested heading');assert.equal(after.child(3).textContent,'— • Same title');assert.equal(after.child(4).textContent,doc.child(1).textContent)
  const selected=state.apply(state.tr.setSelection(TextSelection.create(doc,1,2)));assert.equal(wordOutlineSnapshotTransaction(selected,entries,'Untitled'),null)
  assert.equal(wordOutlineSnapshotTransaction(state,[],'Untitled'),null)
  assert.throws(()=>wordOutlineSnapshotTransaction(state,[{...entries[0],text:'x'.repeat(1_000_001)}],'Untitled'),/too-large/)
 }finally{f.document.destroy()}
})
