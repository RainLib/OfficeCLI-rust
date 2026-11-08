import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {Awareness,applyAwarenessUpdate,encodeAwarenessUpdate} from 'y-protocols/awareness'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection,type PluginView} from '@tiptap/pm/state'
import type {EditorView,DecorationSet} from '@tiptap/pm/view'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureCarets,structureCursorField,type StructureCursorContext} from './semanticStructureCarets.ts'
import {blockTarget,rootBlocks,transformBlocks} from './commands/blocks.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function peer(doc:Y.Doc,id:string,shared?:Awareness,regionId?:string,initialFocus=true,context?:()=>StructureCursorContext|undefined){
 const store=new SemanticBlockStore(doc,schema),awareness=shared??new Awareness(doc),plugin=semanticStructureCarets(store,awareness,{id,name:id,color:'#4488cc'},undefined,regionId,context)
 let focused=initialFocus,state=EditorState.create({schema,doc:store.project(),plugins:[plugin]}),binding:PluginView
 const view={get state(){return state},hasFocus:()=>focused,dispatch(tr:EditorState['tr']){const previous=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,previous)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 return{store,awareness,plugin,view,get:()=>state,decorations:()=>plugin.props.decorations!.call(plugin,state) as DecorationSet,focus(value:boolean){focused=value;binding.update?.(view as unknown as EditorView,state)},close(){binding.destroy?.();if(!shared)awareness.destroy()}}
}
function pair(){const a=new Y.Doc(),b=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdBlockId:'a'},schema.text('AB')),schema.nodes.paragraph.createChecked({hcdBlockId:'b'},schema.text('CD'))]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const pa=peer(a,'alice'),pb=peer(b,'bob');return{a,b,pa,pb,exchange(){applyAwarenessUpdate(pa.awareness,encodeAwarenessUpdate(pb.awareness,[b.clientID]),'test')},close(){pa.close();pb.close();a.destroy();b.destroy()}}}
test('awareness sends a bounded position and renders peer range/caret without changing document state',async()=>{
 const f=pair(),before=Y.encodeStateVector(f.a)
 try{
  await Promise.resolve();const state=f.pb.get();f.pb.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,1,2)));f.exchange()
  const decorations=f.pa.decorations().find();assert.equal(decorations.length,3);assert.equal(decorations.filter(decoration=>(decoration as any).type.attrs?.class==='hcd-peer-active').length,1);assert.ok(decorations.some(decoration=>decoration.from===2&&decoration.to===2));assert.deepEqual(Y.encodeStateVector(f.a),before)
  f.pb.focus(false);f.exchange();assert.equal(f.pa.decorations().find().length,0);assert.equal(f.pb.awareness.getLocalState()?.[structureCursorField],null)
 }finally{f.close()}
})
test('a remote caret follows the same permanent text through a quote conversion',async()=>{
 const f=pair()
 try{
  await Promise.resolve();f.pb.view.dispatch(f.pb.get().tr.setSelection(TextSelection.create(f.pb.get().doc,2)));f.exchange()
  const before=f.pa.store.blocks(),state=f.pa.get(),tr=state.tr;transformBlocks(tr,'block.quote',undefined,blockTarget(state,rootBlocks(state.doc).slice(0,1))!)
  const next:Array<{key?:string;node:typeof state.doc}>=[];tr.doc.forEach(node=>next.push({...(before.some(block=>block.key===node.attrs.hcdStructureKey)?{key:node.attrs.hcdStructureKey}:{}),node}));f.pa.store.reconcile(before,next)
  f.pa.view.dispatch(f.pa.get().tr.replaceWith(0,f.pa.get().doc.content.size,f.pa.store.project().content))
  assert.ok(f.pa.decorations().find().some(decoration=>decoration.from===3&&decoration.to===3))
 }finally{f.close()}
})
test('malformed or out-of-document awareness positions are ignored without touching content',async()=>{
 const f=pair()
 try{
  await Promise.resolve();const before=Y.encodeStateAsUpdate(f.a)
  for(const point of [{key:'missing',offset:2},{key:f.pb.store.keys()[0],offset:-1},{key:f.pb.store.keys()[0],offset:1,relative:{type:{client:'bad',clock:0}}}]){
   f.pb.awareness.setLocalStateField(structureCursorField,{version:1,owner:'test',selection:{kind:'text',anchor:point,head:point}});f.exchange();assert.equal(f.pa.decorations().find().length,0)
  }
  assert.deepEqual(Y.encodeStateAsUpdate(f.a),before)
 }finally{f.close()}
})

test('unfocused regional views cannot clear the active story caret or destroy its ownership',async()=>{
 const doc=new Y.Doc(),awareness=new Awareness(doc),store=new SemanticBlockStore(doc,schema);store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdBlockId:'a'},schema.text('AB'))]));const body=peer(doc,'alice',awareness,'body',true),header=peer(doc,'alice',awareness,'header',false);try{await Promise.resolve();assert.equal(awareness.getLocalState()?.[structureCursorField]?.regionId,'body');header.focus(false);assert.equal(awareness.getLocalState()?.[structureCursorField]?.regionId,'body');body.focus(false);header.focus(true);assert.equal(awareness.getLocalState()?.[structureCursorField]?.regionId,'header');body.close();assert.equal(awareness.getLocalState()?.[structureCursorField]?.regionId,'header')}finally{header.close();awareness.destroy();doc.destroy()}
})
test('a shared story caret carries its containing section and paper without changing the collaborative document',async()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema);store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdBlockId:'a'},schema.text('Shared'))]))
 let context:StructureCursorContext={sectionId:'n_'+'a'.repeat(32),variant:'default',paperIndex:2}
 const current=peer(document,'alice',undefined,'shared-header',true,()=>context)
 try{await Promise.resolve();const bytes=Y.encodeStateAsUpdate(document),selection=current.awareness.getLocalState()![structureCursorField].selection
  assert.deepEqual(current.awareness.getLocalState()![structureCursorField].context,context)
  context={sectionId:'n_'+'b'.repeat(32),variant:'even',paperIndex:1};current.view.dispatch(current.get().tr)
  assert.deepEqual(current.awareness.getLocalState()![structureCursorField].context,context);assert.deepEqual(current.awareness.getLocalState()![structureCursorField].selection,selection);assert.deepEqual(Y.encodeStateAsUpdate(document),bytes)
 }finally{current.close();document.destroy()}
})
