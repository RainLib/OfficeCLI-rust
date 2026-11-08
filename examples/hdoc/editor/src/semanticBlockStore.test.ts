import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {schemaExtensions} from './schema.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {EditorState} from '@tiptap/pm/state'
import {blockMoveMeta,blockTarget,rootBlocks,transformBlocks} from './commands/blocks.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const p=(text:string,id:string)=>schema.nodes.paragraph.createChecked({hcdBlockId:id},text?schema.text(text):null)
function peers(){
 const a=new Y.Doc(),sa=new SemanticBlockStore(a,schema),keys=sa.initialize(schema.nodes.doc.createChecked(null,[p('A','a'),p('B','b'),p('C','c')]))
 const b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const sb=new SemanticBlockStore(b,schema)
 return{a,b,sa,sb,keys,close:()=>{a.destroy();b.destroy()}}
}
function sync(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}
const labels=(store:SemanticBlockStore)=>store.blocks().map(block=>block.node.textContent)
function edit(store:SemanticBlockStore,key:string,text:string){const before=store.content(key);store.update(key,before,before.type.createChecked(before.attrs,text?schema.text(text):null,before.marks))}
function leaf(store:SemanticBlockStore,key:string){return store.contents.get(key)!.get(0) as Y.XmlText}
test('room initialization is explicit and cannot silently run twice',()=>{
 const doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 assert.throws(()=>store.project(),/uninitialized/);store.initialize(schema.nodes.doc.createChecked(null,[p('A','a')]))
 assert.throws(()=>store.initialize(schema.nodes.doc.createChecked(null,[p('B','b')])));assert.deepEqual(labels(store),['A']);doc.destroy()
})
for(const reverse of [false,true])for(const edited of [0,1,2])test(`move retains concurrent text in block ${edited}; reverse exchange=${reverse}`,()=>{
 const f=peers()
 try{
  const physical=f.sa.contents.get(f.keys[0]),text=leaf(f.sa,f.keys[0])
  f.sa.move([f.keys[0]],f.keys[2]);edit(f.sb,f.keys[edited],['A','B','C'][edited]+' Peer!');sync(f.a,f.b,reverse)
  const expected=['B','A','C'];expected[[1,0,2][edited]]+=' Peer!'
  assert.deepEqual(labels(f.sa),expected);assert.deepEqual(labels(f.sb),expected)
  assert.equal(f.sa.contents.get(f.keys[0]),physical);assert.equal(leaf(f.sa,f.keys[0]),text);assert.ok(f.sa.project().eq(f.sb.project()))
 }finally{f.close()}
})
test('concurrent rich-text edits of a moved block merge and survive a later move',()=>{
 const f=peers()
 try{
  f.sa.move([f.keys[1]],f.keys[0]);const a=f.sa.content(f.keys[1]),b=f.sb.content(f.keys[1])
  f.sa.update(f.keys[1],a,a.type.createChecked(a.attrs,[schema.text('Own ',[schema.marks.bold.create()]),...a.content.content]))
  f.sb.update(f.keys[1],b,b.type.createChecked(b.attrs,[...b.content.content,schema.text(' Peer!',[schema.marks.italic.create()])]))
  sync(f.a,f.b)
  const node=f.sa.content(f.keys[1]);assert.equal(node.textContent,'Own B Peer!');assert.ok(node.firstChild?.marks.some(mark=>mark.type.name==='bold'));assert.ok(node.lastChild?.marks.some(mark=>mark.type.name==='italic'))
  f.sb.move([f.keys[1]],null);sync(f.a,f.b);assert.deepEqual(labels(f.sa),['A','C','Own B Peer!']);assert.ok(f.sa.project().eq(f.sb.project()))
 }finally{f.close()}
})
test('concurrent moves choose one placement without duplicating or losing edited content',()=>{
 const f=peers()
 try{
  f.sa.move([f.keys[1]],f.keys[0]);f.sb.move([f.keys[1]],null);edit(f.sa,f.keys[1],'Own B');edit(f.sb,f.keys[1],'B Peer!');sync(f.a,f.b)
  assert.deepEqual(f.sa.keys(),f.sb.keys());assert.equal(f.sa.keys().filter(key=>key===f.keys[1]).length,1);assert.equal(f.sa.contents.size,4)
  assert.match(f.sa.content(f.keys[1]).textContent,/Own/);assert.match(f.sa.content(f.keys[1]).textContent,/Peer/)
 }finally{f.close()}
})
test('move undo/redo keeps peer input and cannot roll back a later peer move',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  f.sa.move([f.keys[0]],f.keys[2]);edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b)
  history.undo();sync(f.a,f.b);assert.deepEqual(labels(f.sa),['A Peer!','B','C'])
  history.redo();sync(f.a,f.b);assert.deepEqual(labels(f.sa),['B','A Peer!','C'])
  f.sb.move([f.keys[0]],null);sync(f.a,f.b);history.undo();sync(f.a,f.b);assert.deepEqual(labels(f.sa),['B','C','A Peer!']);assert.deepEqual(labels(f.sb),labels(f.sa))
 }finally{history.destroy();f.close()}
})
test('a concurrent move cannot revive a deletion; undo restores the preserved peer input',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  f.sa.remove([f.keys[0]]);f.sb.move([f.keys[0]],null);edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b)
  assert.deepEqual(labels(f.sa),['B','C']);assert.equal(f.sa.content(f.keys[0]).textContent,'A Peer!')
  history.undo();sync(f.a,f.b);assert.deepEqual(labels(f.sa),['B','C','A Peer!'])
 }finally{history.destroy();f.close()}
})
test('duplicate has fresh content and canonical identities; undo cannot hide its peer edits',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  const [copy]=f.sa.duplicate([f.keys[0]],f.keys[1]);sync(f.a,f.b);assert.notEqual(copy,f.keys[0]);assert.notEqual(f.sa.content(copy).attrs.hcdBlockId,'a');assert.notEqual(leaf(f.sa,copy),leaf(f.sa,f.keys[0]))
  edit(f.sb,copy,'A Peer!');sync(f.a,f.b);const before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>history.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.equal(history.canRedo(),false);assert.deepEqual(labels(f.sa),['A','A Peer!','B','C']);assert.deepEqual(labels(f.sb),labels(f.sa))
 }finally{history.destroy();f.close()}
})
test('heading conversion changes kind metadata while concurrent typing retains its CRDT identity',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  const before=f.sa.content(f.keys[0]),text=leaf(f.sa,f.keys[0]);f.sa.update(f.keys[0],before,schema.nodes.heading.createChecked({...before.attrs,level:2},before.content))
  edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b);assert.equal(f.sa.content(f.keys[0]).type.name,'heading');assert.equal(f.sa.content(f.keys[0]).textContent,'A Peer!');assert.equal(leaf(f.sa,f.keys[0]),text)
  history.undo();sync(f.a,f.b);assert.equal(f.sa.content(f.keys[0]).type.name,'paragraph');assert.equal(f.sa.content(f.keys[0]).textContent,'A Peer!')
 }finally{history.destroy();f.close()}
})
test('receipt metadata does not replace text, enter history or clear redo',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  const before=f.sa.content(f.keys[0]),text=leaf(f.sa,f.keys[0]);f.sa.update(f.keys[0],before,before.type.createChecked({...before.attrs,hcdBlockId:'canonical'},before.content),false)
  assert.equal(history.canUndo(),false);assert.equal(leaf(f.sa,f.keys[0]),text);f.sa.move([f.keys[0]],null);history.undo();assert.equal(history.canRedo(),true)
  const current=f.sa.content(f.keys[0]);f.sa.update(f.keys[0],current,current.type.createChecked({...current.attrs,hcdBlockId:'newCanonical'},current.content),false);assert.equal(history.canRedo(),true)
 }finally{history.destroy();f.close()}
})
test('snapshot recovery retains block keys, order and concurrent text',()=>{
 const f=peers(),recovered=new Y.Doc()
 try{
  f.sa.move([f.keys[2],f.keys[1]],f.keys[0]);edit(f.sb,f.keys[1],'B Peer!');sync(f.a,f.b);Y.applyUpdate(recovered,Y.encodeStateAsUpdate(f.a));const store=new SemanticBlockStore(recovered,schema)
  assert.deepEqual(store.keys(),f.sa.keys());assert.deepEqual(labels(store),['B Peer!','C','A']);assert.ok(store.project().eq(f.sa.project()))
 }finally{recovered.destroy();f.close()}
})
test('stale edits and invalid destinations leave no partial writes or duplicate allocations',()=>{
 const f=peers()
 try{
  const before=f.sa.content(f.keys[0]);edit(f.sa,f.keys[0],'new');const vector=Y.encodeStateVector(f.a),size=f.sa.contents.size
  assert.throws(()=>f.sa.update(f.keys[0],before,p('old overwrite','a')),/staleContent/);assert.throws(()=>f.sa.move([f.keys[0]],f.keys[0]),/invalidMove/);assert.throws(()=>f.sa.duplicate([f.keys[0]],'missing'),/invalidMove/)
  assert.equal(f.sa.contents.size,size);assert.deepEqual(Y.encodeStateVector(f.a),vector);assert.equal(f.sa.move([f.keys[0]],f.keys[1]),false)
 }finally{f.close()}
})
test('a PM move intent owns the selected block placement rather than its shifted neighbor',()=>{
 const f=peers()
 try{
  const before=f.sa.blocks(),state=EditorState.create({schema,doc:f.sa.project()}),tr=state.tr,other=f.sa.placement.get(f.keys[1])
  assert.equal(transformBlocks(tr,'block.down',undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!),true)
  const intent=tr.getMeta(blockMoveMeta) as {first:number;count:number},nodes:ReturnType<typeof f.sa.blocks>=[]
  tr.doc.forEach(node=>nodes.push({key:before.find(block=>block.node.attrs.hcdBlockId===node.attrs.hcdBlockId)!.key,node}))
  f.sa.reconcile(before,nodes,{movedKeys:before.slice(intent.first,intent.first+intent.count).map(block=>block.key)})
  assert.deepEqual(labels(f.sa),['B','A','C']);assert.equal(f.sa.placement.get(f.keys[1]),other)
  edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b);assert.deepEqual(labels(f.sa),['B','A Peer!','C'])
 }finally{f.close()}
})
test('one editor transition can insert, edit, remove and reorder with one undo',()=>{
 const f=peers(),history=f.sa.undoManager()
 try{
  const before=f.sa.blocks(),changed=p('B Own','b'),after=f.sa.reconcile(before,[before[2],{key:before[1].key,node:changed},{node:p('new','temp')}],{deletedKeys:[before[0].key]})
  assert.deepEqual(labels(f.sa),['C','B Own','new']);assert.equal(after.length,3);assert.equal(history.undoStack.length,1)
  sync(f.a,f.b);edit(f.sb,f.keys[2],'C Peer!');sync(f.a,f.b);history.undo();sync(f.a,f.b)
  assert.deepEqual(labels(f.sa),['A','B','C Peer!']);history.redo();sync(f.a,f.b);assert.deepEqual(labels(f.sa),['C Peer!','B Own','new'])
 }finally{history.destroy();f.close()}
})
test('typing-only transitions do not write placements or reverse an unseen peer move',()=>{
 const f=peers()
 try{
  const before=f.sa.blocks(),placement=[...f.sa.placement];f.sa.reconcile(before,before.map((block,index)=>index===0?{...block,node:p('A Own','a')}:block))
  assert.deepEqual([...f.sa.placement],placement);f.sb.move([f.keys[0]],null);sync(f.a,f.b);assert.deepEqual(labels(f.sa),['B','C','A Own'])
  const vector=Y.encodeStateVector(f.a);assert.throws(()=>f.sa.reconcile(before,before),/staleContent/);assert.deepEqual(Y.encodeStateVector(f.a),vector)
 }finally{f.close()}
})
test('three offline replicas converge under shuffled and duplicated updates without losing append-only input',()=>{
 for(let seed=1;seed<=12;seed++){
  let random=seed;const choose=(limit:number)=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random%limit}
  const f=peers(),c=new Y.Doc();Y.applyUpdate(c,Y.encodeStateAsUpdate(f.a));const stores=[f.sa,f.sb,new SemanticBlockStore(c,schema)],docs=[f.a,f.b,c],tokens:string[]=[]
  try{
   for(let step=0;step<60;step++){
    const actor=choose(3),store=stores[actor],keys=store.keys(),key=keys[choose(keys.length)]
    if(choose(3)===0){const destinations=[...keys.filter(other=>other!==key),null];store.move([key],destinations[choose(destinations.length)])}
    else{
     const token=` [${seed}:${step}]`,before=store.content(key);tokens.push(token)
     store.update(key,before,before.type.createChecked(before.attrs,[...before.content.content,schema.text(token)]))
    }
    if(choose(4)===0){const target=(actor+1+choose(2))%3,update=Y.encodeStateAsUpdate(docs[actor],Y.encodeStateVector(docs[target]));Y.applyUpdate(docs[target],update);Y.applyUpdate(docs[target],update)}
   }
   for(let round=0;round<2;round++)for(let from=0;from<3;from++)for(let to=0;to<3;to++)if(from!==to)Y.applyUpdate(docs[to],Y.encodeStateAsUpdate(docs[from]))
   const result=stores[0].project();assert.ok(stores.every(store=>store.project().eq(result)))
   assert.ok(stores.every(store=>new Set(store.keys()).size===3));for(const token of tokens)assert.ok(result.textContent.includes(token),`lost ${token}`)
  }finally{c.destroy();f.close()}
 }
})
test('clearing text keeps the content type alive for late input and concurrent first typing',()=>{
 const f=peers()
 try{
  const text=leaf(f.sa,f.keys[0]);edit(f.sa,f.keys[0],'');edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b)
  assert.equal(f.sa.content(f.keys[0]).textContent,' Peer!');assert.equal(leaf(f.sa,f.keys[0]),text)
  edit(f.sa,f.keys[0],'');sync(f.a,f.b);edit(f.sa,f.keys[0],'Left');edit(f.sb,f.keys[0],'Right');sync(f.a,f.b)
  const merged=f.sa.content(f.keys[0]).textContent;assert.ok(merged.includes('Left')&&merged.includes('Right'));assert.ok(f.sa.project().eq(f.sb.project()));assert.equal(leaf(f.sa,f.keys[0]),text)
 }finally{f.close()}
})
test('formatting and concurrent typing do not re-publish unchanged marks',()=>{
 const f=peers()
 try{
  const a=f.sa.content(f.keys[0]);f.sa.update(f.keys[0],a,a.type.createChecked(a.attrs,schema.text('A',[schema.marks.bold.create()])));edit(f.sb,f.keys[0],'A Peer!');sync(f.a,f.b)
  const merged=f.sa.content(f.keys[0]);assert.equal(merged.textContent,'A Peer!');assert.ok(merged.firstChild?.marks.some(mark=>mark.type.name==='bold'));assert.ok(f.sa.project().eq(f.sb.project()))
 }finally{f.close()}
})
test('emoji replacement, inline hard breaks and source typography round-trip without splitting surrogate pairs',()=>{
 const f=peers()
 try{
  const before=f.sa.content(f.keys[0]),font=schema.marks.textTypography.create({eastAsia:'宋体',sizePt:18,explicitSize:true}),source=schema.marks.hcdSource.create({nodeId:'n_'+'1'.repeat(32)})
  const first=before.type.createChecked(before.attrs,[schema.text('😀 A',[font,source]),schema.nodes.hardBreak.create(),schema.text('尾部')]);f.sa.update(f.keys[0],before,first)
  const next=first.type.createChecked(first.attrs,[schema.text('😃 A',[font,source]),schema.nodes.hardBreak.create(),schema.text('尾部')]);f.sa.update(f.keys[0],first,next);sync(f.a,f.b)
  assert.ok(f.sa.content(f.keys[0]).eq(next));assert.ok(f.sb.content(f.keys[0]).eq(next));assert.ok(!f.sa.content(f.keys[0]).textContent.includes('\ufffd'))
 }finally{f.close()}
})
test('reading unknown inline nodes or marks preserves every raw Yjs byte',()=>{
 for(const kind of ['node','mark']){
  const f=peers()
  try{
   const text=leaf(f.sa,f.keys[0]);if(kind==='node')text.insertEmbed(text.length,{type:'futureInline',attrs:{version:9,label:'preserve'}});else text.format(0,1,{futureMark:{version:9}})
   const bytes=Y.encodeStateAsUpdate(f.a),vector=Y.encodeStateVector(f.a)
   assert.throws(()=>f.sa.project());assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.deepEqual(Y.encodeStateVector(f.a),vector)
  }finally{f.close()}
 }
})
test('reading an unknown nested container never invokes destructive schema recovery',()=>{
 const doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 try{
  const [key]=store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.blockquote.createChecked(null,p('keep','q'))]))
  const child=store.childKeys(key)[0];store.kinds.set(child,'futureContainer')
  const bytes=Y.encodeStateAsUpdate(doc);assert.throws(()=>store.project());assert.deepEqual(Y.encodeStateAsUpdate(doc),bytes)
 }finally{doc.destroy()}
})
test('concurrent bulk text inserts stay contiguous across different source metadata spans',()=>{
 for(const inverse of [false,true]){
  const f=peers()
  try{
   f.a.clientID=inverse?1001:1002;f.b.clientID=inverse?1002:1001
   const a=f.sa.content(f.keys[0]),b=f.sb.content(f.keys[0]),left=schema.marks.hcdSource.create({nodeId:'n_'+'1'.repeat(32)}),right=schema.marks.hcdSource.create({nodeId:'n_'+'2'.repeat(32)})
   f.sa.update(f.keys[0],a,a.type.createChecked(a.attrs,[...a.content.content,schema.text(' ',[left]),schema.text('Saved!',[right])]))
   f.sb.update(f.keys[0],b,b.type.createChecked(b.attrs,[...b.content.content,schema.text(' Late!',[left])]))
   sync(f.a,f.b);const text=f.sa.content(f.keys[0]).textContent
   assert.ok(['A Saved! Late!','A Late! Saved!'].includes(text),text);assert.ok(f.sa.project().eq(f.sb.project()))
  }finally{f.close()}
 }
})
test('an empty losing wrapper projects one shared fallback whose concurrent input is retained',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),[key]=sa.initialize(schema.nodes.doc.createChecked(null,[p('A','a')]))
 Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const sb=new SemanticBlockStore(b,schema)
 try{
  const original=sb.blocks(),wrapper=schema.nodes.blockquote.createChecked({...original[0].node.attrs,hcdStructureKey:null},[original[0].node.type.createChecked({...original[0].node.attrs,hcdBlockId:null,hcdCanonicalKey:null},original[0].node.content)])
  sb.reconcile(original,[{node:wrapper}]);sa.remove([key]);sync(a,b)
  assert.equal(sa.project().textContent,'');assert.deepEqual(sa.keys(),sb.keys());assert.equal(sa.keys().length,1)
  const fallback=sa.keys()[0];edit(sa,fallback,'Own');edit(sb,fallback,'Peer');sync(a,b)
  assert.ok(sa.project().textContent.includes('Own')&&sa.project().textContent.includes('Peer'));assert.ok(sa.project().eq(sb.project()))
 }finally{a.destroy();b.destroy()}
})
test('cyclic parent references fail without hiding the cycle behind an empty fallback',()=>{
 const doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 try{
  const [a,b]=store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.blockquote.createChecked(null,p('A','a')),schema.nodes.blockquote.createChecked(null,p('B','b'))]))
  doc.transact(()=>{store.children.get(a)!.insert(0,[{key:b,reference:'a-to-b'}]);store.children.get(b)!.insert(0,[{key:a,reference:'b-to-a'}]);store.placement.set(a,{parent:b,reference:'b-to-a'});store.placement.set(b,{parent:a,reference:'a-to-b'})})
  const bytes=Y.encodeStateAsUpdate(doc);assert.throws(()=>store.project(),/invalidStructure/);assert.deepEqual(Y.encodeStateAsUpdate(doc),bytes)
 }finally{doc.destroy()}
})
for(const previous of ['default','prototype-v1','prototype-v2'])test(`bootstrap refuses ${previous} content instead of hiding it behind a fresh tree`,()=>{
 const doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 try{
  if(previous==='default'){const paragraph=new Y.XmlElement('paragraph');doc.getXmlFragment('default').insert(0,[paragraph]);paragraph.insert(0,[new Y.XmlText('unsaved recovery')])}
  else if(previous==='prototype-v1')doc.getMap('hcd-semantic-blocks/1/meta').set('version',1)
  else doc.getMap('hcd-semantic-blocks/2/meta').set('version',2)
  const bytes=Y.encodeStateAsUpdate(doc);assert.throws(()=>store.initialize(schema.nodes.doc.createChecked(null,[p('replacement','new')])),/alreadyInitialized/);assert.deepEqual(Y.encodeStateAsUpdate(doc),bytes);assert.equal(store.initialized,false)
 }finally{doc.destroy()}
})
test('an original divider can become an empty paragraph and acquire a permanent text flow',()=>{
 const doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 try{
  const [key]=store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.horizontalRule.createChecked({hcdBlockId:'divider'})]))
  const original=store.content(key);store.update(key,original,schema.nodes.paragraph.createChecked({...original.attrs}))
  assert.equal(store.content(key).type.name,'paragraph');assert.equal(store.flow.rootFor(key),key)
  const empty=store.content(key);store.update(key,empty,empty.type.createChecked(empty.attrs,schema.text('Text')))
  assert.equal(store.content(key).textContent,'Text')
 }finally{doc.destroy()}
})

test('empty canonical identity is rejected before initialization instead of looping with temporary-ID repair',()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema)
 try{
  const before=Y.encodeStateAsUpdate(document)
  assert.throws(()=>store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdBlockId:''})])),/invalidStructure/)
  assert.equal(store.initialized,false);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
 }finally{document.destroy()}
})
