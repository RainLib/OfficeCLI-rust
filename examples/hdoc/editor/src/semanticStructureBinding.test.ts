import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState,NodeSelection,TextSelection,Plugin,type Transaction,type PluginView} from '@tiptap/pm/state'
import {sinkListItem,liftListItem,splitListItem} from '@tiptap/pm/schema-list'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,blockIdentityPlugin,sourceIdentityPlugin} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {blockTarget,rootBlocks,transformBlocks,prepareBlockTransaction} from './commands/blocks.ts'
import type {Editor} from '@tiptap/core'
import {Fragment,Slice} from '@tiptap/pm/model'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const p=(text:string,id:string)=>schema.nodes.paragraph.createChecked({hcdBlockId:id},text?schema.text(text):null)
function engine(document:Y.Doc,editable=true){
 const store=new SemanticBlockStore(document,schema),errors:unknown[]=[]
 const plugin=semanticStructureBinding(store,{canWrite:()=>editable,onError:error=>errors.push(error)})
 const identity=blockIdentityPlugin();let identityRounds=0
 const boundedIdentity=new Plugin({...identity.spec,appendTransaction(...args){
  if(++identityRounds>32)throw new Error('identity append transactions did not converge')
  return identity.spec.appendTransaction!.call(this,...args)
 }})
 let current=EditorState.create({schema,plugins:[boundedIdentity,sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return current},dispatch(tr:Transaction){identityRounds=0;const previous=current;current=current.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,previous)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 return{store,errors,get:()=>current,dispatch:view.dispatch,close:()=>binding.destroy?.(),setEditable:(value:boolean)=>{editable=value}}
}
function pair(reverse?:boolean){
 const a=new Y.Doc(),b=new Y.Doc();if(reverse!==undefined){a.clientID=reverse?2:1;b.clientID=reverse?1:2}const sa=new SemanticBlockStore(a,schema)
 sa.initialize(schema.nodes.doc.createChecked(null,[p('AB','a'),p('CD','b'),p('EF','c')]))
 Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b)
 return{a,b,ea,eb,close(){ea.close();eb.close();a.destroy();b.destroy()}}
}
function exchange(a:Y.Doc,b:Y.Doc){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}
const labels=(state:EditorState)=>rootBlocks(state.doc).map(block=>block.node.textContent)
test('a startup placeholder transaction cannot allocate a shared root before canonical projection',async()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema);store.initialize(schema.nodes.doc.createChecked(null,[p('Canonical','stable')]))
 const before=Y.encodeStateAsUpdate(document),view=engine(document)
 try{view.dispatch(view.get().tr.insertText('Placeholder must not become content',1));assert.deepEqual(Y.encodeStateAsUpdate(document),before);await Promise.resolve();assert.equal(view.get().doc.textContent,'Canonical');assert.equal(store.keys().length,1);assert.deepEqual(view.errors,[])}finally{view.close();document.destroy()}
})
test('initialization is projection-only and inserts stable keys without an own history step',async()=>{
 const f=pair(),history=f.ea.store.undoManager(),bytes=Y.encodeStateAsUpdate(f.a)
 try{await Promise.resolve();assert.deepEqual(labels(f.ea.get()),['AB','CD','EF']);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.equal(history.canUndo(),false);assert.equal(f.ea.errors.length,0)}finally{history.destroy();f.close()}
})
test('local typing reaches shared content and preserves a caret inside a remotely moved block',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const middle=rootBlocks(f.eb.get().doc)[1];f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,middle.from+2)))
  const state=f.ea.get(),tr=state.tr;assert.equal(transformBlocks(tr,'block.up',undefined,blockTarget(state,rootBlocks(state.doc).slice(1,2))!),true);f.ea.dispatch(tr)
  f.eb.dispatch(f.eb.get().tr.insertText('!'));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['C!D','AB','EF']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(f.eb.get().selection.$from.parent.textContent,'C!D')
  assert.equal(f.eb.get().selection.$from.parentOffset,2);assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
 }finally{f.close()}
})
test('a moved NodeSelection follows its stable root key',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const middle=rootBlocks(f.eb.get().doc)[1];f.eb.dispatch(f.eb.get().tr.setSelection(NodeSelection.create(f.eb.get().doc,middle.from)))
  f.ea.store.move([f.ea.store.keys()[1]],f.ea.store.keys()[0]);exchange(f.a,f.b)
  assert.ok(f.eb.get().selection instanceof NodeSelection);assert.equal((f.eb.get().selection as NodeSelection).node.textContent,'CD');assert.equal(f.eb.get().selection.from,0)
 }finally{f.close()}
})
test('inline business and mention selections retain occurrence identity across peer typing and safely fall back on deletion',async()=>{
 for(const kind of ['extension','mention'] as const){
  const a=new Y.Doc(),b=new Y.Doc(),store=new SemanticBlockStore(a,schema),id=(kind==='extension'?'x_':'m_')+'7'.repeat(32)
  const atom=kind==='extension'?schema.nodes.hcdExtensionInline.createChecked({extension:{schemaVersion:'hcd.extension/1',instanceId:id,type:'example.badge',version:1,display:'inline',data:{title:'Resource'},fallback:{text:'Resource'}}}):schema.nodes.hcdMention.createChecked({reference:{type:'hcd.mention',version:1,mentionId:id,target:{kind:'person',id:'bob'},snapshot:{label:'Bob'}}})
  store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('Before '),atom,schema.text(' after')]),p('Peer','peer')]))
  Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b)
  try{
   await Promise.resolve();let at=-1;eb.get().doc.descendants((node,pos)=>{if(node.type===atom.type)at=pos});assert.ok(at>0);eb.dispatch(eb.get().tr.setSelection(NodeSelection.create(eb.get().doc,at)))
   ea.dispatch(ea.get().tr.insertText('remote prefix ',1));exchange(a,b)
   assert.ok(eb.get().selection instanceof NodeSelection);assert.equal((eb.get().selection as NodeSelection).node.type,atom.type);assert.equal(eb.get().selection.from,at+'remote prefix '.length)
   const peer=rootBlocks(ea.get().doc)[1];ea.dispatch(ea.get().tr.insertText(' different block ',peer.from+2));exchange(a,b)
   assert.ok(eb.get().selection instanceof NodeSelection);assert.equal((eb.get().selection as NodeSelection).node.attrs[kind==='extension'?'extension':'reference'][kind==='extension'?'instanceId':'mentionId'],id)
   ea.dispatch(ea.get().tr.delete(eb.get().selection.from,eb.get().selection.to));exchange(a,b);assert.ok(!(eb.get().selection instanceof NodeSelection));assert.deepEqual(ea.errors,[]);assert.deepEqual(eb.errors,[])
  }finally{ea.close();eb.close();a.destroy();b.destroy()}
 }
})
test('split allocates a new root key and one undo restores the document while retaining late peer input',async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const before=f.ea.get();f.ea.dispatch(before.tr.split(2));assert.deepEqual(labels(f.ea.get()),['A','B','CD','EF'])
  const keys=rootBlocks(f.ea.get().doc).map(block=>block.node.attrs.hcdStructureKey);assert.equal(new Set(keys).size,4);assert.ok(keys.every(key=>typeof key==='string'))
  f.eb.dispatch(f.eb.get().tr.insertText(' Peer',3));exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['A','B Peer','CD','EF']);history.undo();exchange(f.a,f.b)
  assert.equal(rootBlocks(f.ea.get().doc).length,3);assert.ok(f.ea.get().doc.textContent.includes('Peer'));assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[])
 }finally{history.destroy();f.close()}
})
test('copy has an independent structural key and content, with one undo/redo boundary',async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const state=f.ea.get(),tr=state.tr;transformBlocks(tr,'block.duplicate',undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!);f.ea.dispatch(tr)
  const blocks=rootBlocks(f.ea.get().doc);assert.notEqual(blocks[0].node.attrs.hcdStructureKey,blocks[1].node.attrs.hcdStructureKey);assert.deepEqual(labels(f.ea.get()),['AB','AB','CD','EF'])
  assert.equal(history.undoStack.length,1);history.undo();assert.deepEqual(labels(f.ea.get()),['AB','CD','EF']);history.redo();assert.deepEqual(labels(f.ea.get()),['AB','AB','CD','EF'])
 }finally{history.destroy();f.close()}
})
test('programmatic writes are blocked while read-only and selection remains usable',async()=>{
 const f=pair()
 try{await Promise.resolve();f.ea.setEditable(false);const before=f.ea.get().doc,vector=Y.encodeStateVector(f.a);f.ea.dispatch(f.ea.get().tr.insertText('forbidden',1));assert.ok(f.ea.get().doc.eq(before));assert.deepEqual(Y.encodeStateVector(f.a),vector);f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(before,2)));assert.equal(f.ea.get().selection.anchor,2)}finally{f.close()}
})
test('multi-paragraph code conversion joins permanent carriers and retains offline source input',async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const keys=f.ea.store.keys().slice(0,2),carriers=keys.map(key=>f.ea.store.contents.get(key)!.get(0))
  const before=f.ea.get(),tr=before.tr;transformBlocks(tr,'block.code',undefined,blockTarget(before,rootBlocks(before.doc).slice(0,2))!);f.ea.dispatch(tr)
  assert.deepEqual(labels(f.ea.get()),['AB\nCD','EF'])
  const peer=rootBlocks(f.eb.get().doc)[1];f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,peer.to-1)));f.eb.dispatch(f.eb.get().tr.insertText(' Peer!'));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AB\nCD Peer!','EF']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc))
  assert.equal(f.eb.get().selection.$from.parent.textContent,'AB\nCD Peer!')
  keys.forEach((key,index)=>assert.equal(f.ea.store.contents.get(key)!.get(0),carriers[index]))
  history.undo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['AB','CD Peer!','EF'])
  history.redo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['AB\nCD Peer!','EF']);assert.deepEqual(f.ea.errors,[])
 }finally{history.destroy();f.close()}
})
test('unknown remote content preserves the last rendered document and every incoming byte',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const before=f.ea.get().doc,text=f.eb.store.contents.get(f.eb.store.keys()[0])!.get(0) as Y.XmlText;text.format(0,1,{futureMark:{version:7}})
  const incoming=Y.encodeStateAsUpdate(f.b);Y.applyUpdate(f.a,incoming);const bytes=Y.encodeStateAsUpdate(f.a)
  assert.ok(f.ea.get().doc.eq(before));assert.ok(f.ea.errors.length>0);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
 }finally{f.close()}
})
test('a staged multi-block code command reports successful committed flow conversion',async()=>{
 const f=pair()
 try{
  await Promise.resolve();let focused=false
  const editor={get state(){return f.ea.get()},isDestroyed:false,isEditable:true,view:{composing:false,dispatch:f.ea.dispatch,focus:()=>{focused=true}}} as unknown as Editor
  const before=f.ea.get(),commit=prepareBlockTransaction(editor,'block.code',undefined,blockTarget(before,rootBlocks(before.doc).slice(0,2))!)
  assert.ok(commit);assert.equal(commit(),true);assert.equal(focused,true);assert.deepEqual(labels(f.ea.get()),['AB\nCD','EF']);assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})
for(const type of ['block.quote','block.bulletList','block.orderedList'])test(`${type} reuses both text carriers during concurrent typing and unwrap/undo`,async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const keys=f.ea.store.keys().slice(0,2),carriers=keys.map(key=>f.ea.store.contents.get(key)!.get(0))
  const middle=rootBlocks(f.eb.get().doc)[1];f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,middle.to-1)))
  const before=f.ea.get(),tr=before.tr;assert.equal(transformBlocks(tr,type,undefined,blockTarget(before,rootBlocks(before.doc).slice(0,2))!),true);f.ea.dispatch(tr)
  f.eb.dispatch(f.eb.get().tr.insertText(' Peer!'));exchange(f.a,f.b)
  assert.equal(f.ea.get().doc.firstChild!.type.name,type==='block.quote'?'blockquote':type==='block.bulletList'?'bulletList':'orderedList')
  assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(f.eb.get().selection.$from.parent.textContent,'CD Peer!')
  assert.equal(f.eb.get().selection.$from.parentOffset,'CD Peer!'.length)
  keys.forEach((key,index)=>assert.equal(f.ea.store.contents.get(key)!.get(0),carriers[index]))
  history.stopCapturing();const wrapped=f.ea.get(),plain=wrapped.tr;assert.equal(transformBlocks(plain,'block.paragraph',undefined,blockTarget(wrapped,rootBlocks(wrapped.doc).slice(0,1))!),true);f.ea.dispatch(plain);exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AB','CD Peer!','EF']);assert.deepEqual(f.ea.store.keys().slice(0,2),keys)
  history.undo();exchange(f.a,f.b);assert.equal(f.ea.get().doc.firstChild!.type.name,type==='block.quote'?'blockquote':type==='block.bulletList'?'bulletList':'orderedList');assert.ok(f.ea.get().doc.textContent.includes('Peer!'))
  assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
 }finally{history.destroy();f.close()}
})
test('concurrent alternative wrappers choose one parent without cloning or hiding the edited paragraph',async()=>{
 const f=pair()
 try{
  await Promise.resolve();for(const [engine,type] of [[f.ea,'block.quote'],[f.eb,'block.bulletList']] as const){const state=engine.get(),tr=state.tr;transformBlocks(tr,type,undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!);engine.dispatch(tr)}
  const paragraph=f.eb.get().doc.firstChild!.firstChild!.firstChild!;assert.equal(paragraph.textContent,'AB')
  f.eb.dispatch(f.eb.get().tr.insertText(' Peer!',5));exchange(f.a,f.b)
  assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(f.ea.get().doc.textContent.split('Peer!').length-1,1);assert.equal(f.ea.errors.length,0);assert.equal(f.eb.errors.length,0)
 }finally{f.close()}
})

test('paragraph join and a later split retain an offline caret and exact text ownership',async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const peer=rootBlocks(f.eb.get().doc)[1];f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,peer.to-1)))
  f.ea.dispatch(f.ea.get().tr.join(rootBlocks(f.ea.get().doc)[1].from));f.eb.dispatch(f.eb.get().tr.insertText(' Peer!'));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['ABCD Peer!','EF']);assert.equal(f.eb.get().selection.$from.parentOffset,'ABCD Peer!'.length)
  history.stopCapturing();f.ea.dispatch(f.ea.get().tr.split(4));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['ABC','D Peer!','EF']);assert.equal(f.eb.get().selection.$from.parent.textContent,'D Peer!')
  history.undo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['ABCD Peer!','EF'])
  history.undo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['AB','CD Peer!','EF']);assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
 }finally{history.destroy();f.close()}
})
test('duplicating an empty block allocates independent text rather than a split boundary',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const first=rootBlocks(f.ea.get().doc)[0];f.ea.dispatch(f.ea.get().tr.delete(first.from+1,first.to-1))
  const state=f.ea.get(),tr=state.tr;transformBlocks(tr,'block.duplicate',undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!);f.ea.dispatch(tr)
  const roots=f.ea.store.keys();assert.notEqual(f.ea.store.flow.parts(roots[0])[0].carrier,f.ea.store.flow.parts(roots[1])[0].carrier)
 }finally{f.close()}
})
for(const reverse of [false,true])test(`overlapping editor joins retain all three carriers and undo only one's own link, reverse=${reverse}`,async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();f.ea.dispatch(f.ea.get().tr.join(rootBlocks(f.ea.get().doc)[1].from));f.eb.dispatch(f.eb.get().tr.join(rootBlocks(f.eb.get().doc)[2].from))
  const au=Y.encodeStateAsUpdate(f.a),bu=Y.encodeStateAsUpdate(f.b);if(reverse){Y.applyUpdate(f.b,au);Y.applyUpdate(f.a,bu)}else{Y.applyUpdate(f.a,bu);Y.applyUpdate(f.b,au)}
  assert.deepEqual(labels(f.ea.get()),['ABCDEF']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc))
  history.undo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['AB','CDEF'])
  history.redo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['ABCDEF']);assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
 }finally{history.destroy();f.close()}
})
test('concurrent Enter splits retain the original text order and all offline input',async()=>{
 const f=pair()
 try{
  await Promise.resolve();f.ea.dispatch(f.ea.get().tr.insertText('CDEFGH',3));exchange(f.a,f.b)
  f.ea.dispatch(f.ea.get().tr.split(3));f.eb.dispatch(f.eb.get().tr.split(6));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()).slice(0,3),['AB','CDE','FGH']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})
test('joining an empty trailing paragraph retains offline first typing in its carrier',async()=>{
 const f=pair(),history=f.ea.store.undoManager()
 try{
  await Promise.resolve();const middle=rootBlocks(f.ea.get().doc)[1];f.ea.dispatch(f.ea.get().tr.delete(middle.from+1,middle.to-1));exchange(f.a,f.b);history.clear()
  f.ea.dispatch(f.ea.get().tr.join(rootBlocks(f.ea.get().doc)[1].from));f.eb.dispatch(f.eb.get().tr.insertText(' Peer!',rootBlocks(f.eb.get().doc)[1].from+1));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AB Peer!','EF']);history.undo();exchange(f.a,f.b);assert.deepEqual(labels(f.ea.get()),['AB',' Peer!','EF']);assert.deepEqual(f.ea.errors,[])
 }finally{history.destroy();f.close()}
})
test('a cross-paragraph selection replacement keeps peer characters beyond the deleted selection',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const roots=rootBlocks(f.ea.get().doc);f.ea.dispatch(f.ea.get().tr.insertText('X',roots[0].from+2,roots[1].from+2))
  f.eb.dispatch(f.eb.get().tr.insertText(' Peer!',rootBlocks(f.eb.get().doc)[1].to-1));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AXD Peer!','EF']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})
test('pasting several paragraphs splits the shared text while an offline peer types in the suffix',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const slice=new Slice(Fragment.fromArray([p('X','x'),p('Y','y')]),1,1)
  f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,2)).replaceSelection(slice))
  f.eb.dispatch(f.eb.get().tr.insertText(' Peer!',3));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AX','YB Peer!','CD','EF']);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})
for(const reverse of [false,true])test(`manual moves and insertion honor logical boundaries after concurrent splits, reverse=${reverse}`,async()=>{
 const f=pair(reverse)
 try{
  await Promise.resolve();f.ea.dispatch(f.ea.get().tr.insertText('CDEFGH',3));exchange(f.a,f.b)
  f.ea.dispatch(f.ea.get().tr.split(3));f.eb.dispatch(f.eb.get().tr.split(6));exchange(f.a,f.b)
  assert.deepEqual(labels(f.ea.get()),['AB','CDE','FGH','CD','EF'])
  const keys=f.ea.store.keys();f.ea.store.move([keys[4]],keys[2]);assert.deepEqual(labels(f.ea.get()),['AB','CDE','EF','FGH','CD'])
  f.ea.store.move([keys[0]],null);assert.deepEqual(labels(f.ea.get()),['CDE','EF','FGH','CD','AB'])
  f.ea.store.move([keys[2]],keys[1]);assert.deepEqual(labels(f.ea.get()),['FGH','CDE','EF','CD','AB'])
  f.ea.store.insert([p('Inserted','inserted')],keys[1]);assert.deepEqual(labels(f.ea.get()),['FGH','Inserted','CDE','EF','CD','AB'])
  exchange(f.a,f.b);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
 }finally{f.close()}
})
test('empty paragraph/divider conversion round-trips and late text is retained as an explicit projection conflict',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const carrierKey=f.ea.store.keys()[0],first=rootBlocks(f.ea.get().doc)[0];f.ea.dispatch(f.ea.get().tr.delete(first.from+1,first.to-1));exchange(f.a,f.b)
  const state=f.ea.get(),tr=state.tr;transformBlocks(tr,'block.divider',undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!);f.ea.dispatch(tr)
  assert.equal(f.ea.get().doc.firstChild!.type.name,'horizontalRule')
  const divider=f.ea.get();f.ea.dispatch(divider.tr.setNodeMarkup(0,schema.nodes.paragraph,{...divider.doc.firstChild!.attrs}));assert.equal(f.ea.get().doc.firstChild!.type.name,'paragraph')
  const empty=f.ea.get(),again=empty.tr;transformBlocks(again,'block.divider',undefined,blockTarget(empty,rootBlocks(empty.doc).slice(0,1))!);f.ea.dispatch(again)
  f.eb.dispatch(f.eb.get().tr.insertText(' Offline!',1));const incoming=Y.encodeStateAsUpdate(f.b);Y.applyUpdate(f.a,incoming)
  const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.ea.store.project(),/ownershipTransition/);assert.ok(f.ea.errors.length>0,'the binding must report the incompatible late text')
  assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
  const preserved=f.ea.store.flow.read(carrierKey);assert.equal(preserved.textBetween(0,preserved.size),' Offline!')
 }finally{f.close()}
})

test('redo after a canonical commit persists source repair without adding a new undo action',async()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema);store.initialize(schema.nodes.doc.createChecked(null,[p('','tmp_new-block')]))
 const editor=engine(document),history=store.undoManager(),source='n_'+'a'.repeat(32),block='n_'+'b'.repeat(32)
 try{
  await Promise.resolve();editor.dispatch(editor.get().tr.insertText('Own text',1));history.stopCapturing()
  const key=store.keys()[0],owner=store.owners.get(key)!
  document.transact(()=>{store.canonicalIds.set(owner,block);store.attributes.get(key)!.set('hcdSourceId',source)},'server-receipt')
  history.undo();assert.equal(store.project().textContent,'');history.redo()
  assert.equal(store.project().textContent,'Own text');assert.equal(store.content(key).firstChild?.marks.find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId,source)
  assert.equal(history.undoStack.length,1);assert.equal(history.redoStack.length,0);assert.deepEqual(editor.errors,[])
  history.undo();assert.equal(store.project().textContent,'')
 }finally{history.destroy();editor.close();document.destroy()}
})

for(const kind of ['bulletList','orderedList'])test(`${kind}: nested typing, Enter, indent/outdent and own undo converge without identity repair loops`,async()=>{
 const a=new Y.Doc(),b=new Y.Doc(),store=new SemanticBlockStore(a,schema)
 const item=(text:string)=>schema.nodes.listItem.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.text(text)))
 store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes[kind].createChecked(null,[item('First'),item('Second')]),p('Peer paragraph','peer')]))
 Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const left=engine(a),right=engine(b),history=left.store.undoManager()
 const cursor=(text:string)=>{let at=-1;left.get().doc.descendants((node,pos)=>{if(node.isTextblock&&node.textContent===text)at=pos+node.nodeSize-1});assert.ok(at>0);left.dispatch(left.get().tr.setSelection(TextSelection.create(left.get().doc,at)))}
 const nested=()=>{const nodes:import('@tiptap/pm/model').Node[]=[];left.get().doc.descendants(node=>{if(node.type.name==='listItem'&&node.attrs.hcdCanonicalKey===null)nodes.push(node)});return nodes}
 try{
  await Promise.resolve();cursor('Second');assert.equal(sinkListItem(schema.nodes.listItem)(left.get(),left.dispatch),true)
  assert.equal(nested().length,1);assert.equal(nested()[0].attrs.hcdBlockId,null,'nested item has a structural key, not an invented canonical save ID')
  const key=nested()[0].attrs.hcdStructureKey;left.dispatch(left.get().tr.insertText('!'));assert.equal(nested()[0].attrs.hcdStructureKey,key)
  assert.equal(splitListItem(schema.nodes.listItem)(left.get(),left.dispatch),true);left.dispatch(left.get().tr.insertText('Third'))
  assert.equal(nested().length,2);assert.ok(nested().every(node=>node.attrs.hcdBlockId===null));assert.ok(left.store.project().eq(left.get().doc))
  history.stopCapturing();assert.equal(liftListItem(schema.nodes.listItem)(left.get(),left.dispatch),true);history.stopCapturing()
  exchange(a,b);const peer=right.get().doc.content.size-1;right.dispatch(right.get().tr.insertText(' remains',peer));exchange(a,b)
  history.undo();exchange(a,b);assert.equal(nested().length,2);assert.ok(left.get().doc.textContent.includes('Peer paragraph remains'))
  history.redo();exchange(a,b);assert.equal(nested().length,1);assert.ok(left.get().doc.eq(right.get().doc));assert.ok(left.store.project().eq(left.get().doc))
  assert.deepEqual(left.errors,[]);assert.deepEqual(right.errors,[])
 }finally{history.destroy();left.close();right.close();a.destroy();b.destroy()}
})
