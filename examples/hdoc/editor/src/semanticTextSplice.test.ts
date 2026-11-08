import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {writeSemanticInline,validateSemanticSplice,type SemanticInlineSplice} from './semanticInlineContent.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding,structureTextSplices} from './semanticStructureBinding.ts'
import {sourceLeafActions} from './semanticSourceBindings.ts'
import {structureSourceTargets,reconcileStructureSources} from './semanticStructureSources.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const p=(text:string)=>schema.nodes.paragraph.createChecked({hcdBlockId:source(1)},text?schema.text(text):null)
const visible=(text:Y.XmlText)=>{const ids:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let index=0;index<item.length;index++)ids.push(`${item.id.client}:${item.id.clock+index}`);return ids}
function flowFixture(values=['P😀']){
 const document=new Y.Doc({gc:false}),carriers=document.getMap<Y.XmlFragment>('carriers'),flow=new SemanticTextFlow(document,carriers,schema)
 values.forEach((value,index)=>{const fragment=new Y.XmlFragment();carriers.set(String(index),fragment);fragment.insert(0,[new Y.XmlText()]);writeSemanticInline(fragment.get(0) as Y.XmlText,p(value))});flow.initialize([...carriers.keys()])
 return{document,carriers,flow,text:(key='0')=>carriers.get(key)!.get(0) as Y.XmlText}
}
function engine(document:Y.Doc){
 const store=new SemanticBlockStore(document,schema),errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)})
 let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 return{store,get:()=>state,dispatch:view.dispatch,errors,close:()=>binding.destroy?.()}
}
function pair(text='P😀',reverse=false){
 const a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false});a.clientID=reverse?2:1;b.clientID=reverse?1:2
 const store=new SemanticBlockStore(a,schema);store.initialize(schema.nodes.doc.createChecked(null,[p(text)]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b)
 return{a,b,ea,eb,close(){ea.close();eb.close();a.destroy();b.destroy()}}
}
function exchange(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}

test('the legacy whole-text diff reproduces the repeated-prefix anchor ambiguity',()=>{
 const f=flowFixture();try{const ids=visible(f.text());f.flow.write('0',p('PREFIXP😀'));assert.equal(visible(f.text())[0],ids[0]);assert.notEqual(visible(f.text())[6],ids[0])}finally{f.document.destroy()}
})
test('an exact insertion keeps the original repeated character at the real transaction position',()=>{
 const f=flowFixture();try{const ids=visible(f.text()),bookmark=f.flow.capture('0',0,1);f.flow.write('0',p('PREFIXP😀'),{from:0,to:0,insertedSize:6});assert.deepEqual(visible(f.text()).slice(6),ids);assert.equal(f.flow.resolve(bookmark)?.offset,6)}finally{f.document.destroy()}
})
test('exact repeated deletion and replacement retain the intended surviving suffix item identities',()=>{
 for(const [before,after,splice,kept]of [['AAA😀','AA😀',{from:0,to:1,insertedSize:0},1],['ABAB😀','ABABAB😀',{from:0,to:2,insertedSize:4},2]] as const){
  const f=flowFixture([before]);try{const ids=visible(f.text());f.flow.write('0',p(after),splice);assert.deepEqual(visible(f.text()).slice(splice.from+splice.insertedSize),ids.slice(kept))}finally{f.document.destroy()}
 }
})
test('splice hints retain exact carrier identities and bookmarks across an already joined flow',()=>{
 const f=flowFixture(['AAA','AAA']);try{const sourceIds=visible(f.text('1')),bookmark=f.flow.capture('1',0,1);f.flow.join('0','1');f.flow.write('0',p('AAAAAAAA'),{from:3,to:3,insertedSize:2});assert.deepEqual(visible(f.text('1')),sourceIds);assert.equal(f.flow.resolve(bookmark)?.root,'0');assert.equal(f.flow.resolve(bookmark)?.offset,5)}finally{f.document.destroy()}
})
test('malformed, stale and mid-surrogate splice boundaries refuse before changing shared bytes',()=>{
 const f=flowFixture();try{
  const bytes=Y.encodeStateAsUpdate(f.document)
  for(const splice of [{from:-1,to:0,insertedSize:6},{from:0,to:0,insertedSize:5},{from:2,to:2,insertedSize:6},{from:0,to:9,insertedSize:1},{from:0,to:0,insertedSize:NaN}]){assert.throws(()=>f.flow.write('0',p('PREFIXP😀'),splice),/SemanticTextSplice/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)}
  assert.throws(()=>validateSemanticSplice(f.text(),p('PREFIXP😀'),{from:3,to:3,insertedSize:6}),/staleSemanticTextSplice/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
 }finally{f.document.destroy()}
})
test('exact splices preserve independent unchanged formatting outside the replacement',()=>{
 const f=flowFixture(['AAA']);try{
  f.text().format(2,1,{bold:{}})
  const next=schema.nodes.paragraph.createChecked(null,[schema.text('AA'),schema.text('A',[schema.mark('italic')]),schema.text('A',[schema.mark('bold')])])
  f.flow.write('0',next,{from:1,to:1,insertedSize:1});const body=f.flow.read('0');assert.equal(body.textBetween(0,body.size),'AAAA');assert.equal(body.lastChild!.marks.some(mark=>mark.type.name==='bold'),true)
 }finally{f.document.destroy()}
})
for(const reverse of [false,true]){
 test(`real structure binding places offline peer input after the original repeated character, reverse=${reverse}`,async()=>{
  const f=pair('P😀',reverse)
  try{
   await Promise.resolve();const key=f.ea.store.keys()[0],carrier=f.ea.store.contents.get(key)!.get(0) as Y.XmlText,ids=visible(carrier),bookmark=f.eb.store.flow.capture(key,1,-1),history=f.ea.store.undoManager()
   f.ea.dispatch(f.ea.get().tr.insertText('PREFIX',1));f.eb.dispatch(f.eb.get().tr.insertText('Peer',2));assert.deepEqual(visible(carrier).slice(6),ids)
   exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'PREFIXPPeer😀');assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(f.ea.store.flow.resolve(bookmark)?.offset,7)
   history.undo();exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'PPeer😀');history.redo();exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'PREFIXPPeer😀');assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[]);history.destroy()
  }finally{f.close()}
 })
 test(`repeated deletion through the binding leaves the intended original character for offline edits, reverse=${reverse}`,async()=>{
  const f=pair('AA😀',reverse)
  try{await Promise.resolve();const key=f.ea.store.keys()[0],text=f.ea.store.contents.get(key)!.get(0) as Y.XmlText,ids=visible(text);f.ea.dispatch(f.ea.get().tr.delete(1,2));assert.equal(visible(text)[0],ids[1]);f.eb.dispatch(f.eb.get().tr.insertText('Peer',3));exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'APeer😀');assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[])}finally{f.close()}
 })
}
test('source receipt arriving after a repeated-prefix edit binds only the captured old characters',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const captured=structureSourceTargets(f.ea.store)[0];assert.ok(!(captured instanceof Y.XmlElement));const expected=schema.nodes.paragraph.createChecked(null,[schema.text('P😀',[schema.mark('hcdSource',{nodeId:source(20)})])])
  f.ea.dispatch(f.ea.get().tr.insertText('PREFIX',1));const actions=sourceLeafActions(f.ea.store,captured.texts[0],expected,captured.bindings![0]);f.a.transact(()=>actions.forEach(action=>action()),'receipt')
  const parts=jsonToSnapshot(f.ea.store.project().toJSON())[0].content.inlines
  assert.equal(parts[0].text,'PREFIX');assert.equal(parts[0].nodeId,undefined);assert.equal(parts[1].text,'P😀');assert.equal(parts[1].nodeId,source(20));assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})
test('structure preflight rejects wrong/duplicate splice hints before allocating another proposed block',async()=>{
 const f=pair();try{await Promise.resolve();const before=f.ea.store.blocks(),bytes=Y.encodeStateAsUpdate(f.a),after=[{key:before[0].key,node:p('PREFIXP😀')},{node:p('New')}],bad={key:before[0].key,from:3,to:3,insertedSize:6}
  assert.throws(()=>f.ea.store.validateReconcile(before,after,{textSplices:[bad]}),/SemanticTextSplice/);assert.throws(()=>f.ea.store.reconcile(before,after,{textSplices:[bad]}),/SemanticTextSplice/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
  const valid={...bad,from:0,to:0};assert.throws(()=>f.ea.store.reconcile(before,after,{textSplices:[valid,valid]}),/SemanticTextSplice/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
 }finally{f.close()}
})
test('hint extraction accepts a closed inline edit plus mark repairs and leaves multi-step/structural edits alone',()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema);store.initialize(schema.nodes.doc.createChecked(null,[p('AAA')]))
 try{
  const state=EditorState.create({schema,doc:store.project()}),insert=state.tr.insertText('AA',1)
  insert.addMark(1,3,schema.mark('bold'));assert.deepEqual(structureTextSplices([insert]),[{key:store.keys()[0],from:0,to:0,insertedSize:2}])
  const many=state.tr.insertText('AA',1).insertText('Z',3);assert.deepEqual(structureTextSplices([many]),[]);assert.deepEqual(structureTextSplices([state.tr.split(2)]),[])
  const emoji=EditorState.create({schema,doc:schema.nodes.doc.createChecked(null,[p('😀')])});assert.deepEqual(structureTextSplices([emoji.tr.setNodeMarkup(0,schema.nodes.heading,{level:1})]),[])
 }finally{document.destroy()}
})
