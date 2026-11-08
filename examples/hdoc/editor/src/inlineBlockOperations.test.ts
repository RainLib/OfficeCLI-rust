import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from './extensionNode.ts'
import {blockTarget,rootBlocks,blockActionStates,transformBlocks,prepareBlockTransaction,protectedBlock} from './commands/blocks.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),definition:NodeExtensionDefinition={type:'example.inline_note',version:1,display:'inline',label:'Inline note',defaultData:{title:'Keep'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title),exportAdapters:{docx:({data})=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:'Export '+data.title,bold:true}]}]})}}
function fixture(){
 const registry=new NodeExtensionRegistry(),close=registry.connect(),detach=registry.register([definition]),value=registry.create(definition.type,undefined,[{key:'notes',hash:'a'.repeat(64),byteLength:4,name:'notes.txt',mediaType:'text/plain'}])
 const doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before '},{type:'hcdExtensionInline',attrs:{extension:value}},{type:'text',text:' after'}]},{type:'paragraph',content:[{type:'text',text:'Peer paragraph'}]}]})
 let state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(()=>{},()=>registry)]})
 const editor={isDestroyed:false,isEditable:true,get state(){return state},view:{composing:false,dispatch(tr:typeof state.tr){state=state.apply(tr)},focus(){}}} as unknown as Editor
 return{registry,value,doc,editor,get:()=>state,change:(tr:typeof state.tr)=>{state=state.apply(tr)},detach,close}
}
test('known inline paragraph block operations clone occurrence identity and preserve portable data/resources',()=>{
 const f=fixture()
 try{
  const target=blockTarget(f.get(),rootBlocks(f.get().doc).slice(0,1))!,actions=blockActionStates(f.get(),target)
  assert.equal(actions['block.duplicate'].enabled,true);assert.equal(actions['block.heading'].enabled,true);assert.equal(actions['block.code'].enabled,false)
  assert.equal(transformBlocks(f.get().tr,'block.code',undefined,target,f.registry),false)
  const commit=prepareBlockTransaction(f.editor,'block.duplicate',undefined,target);assert.ok(commit);assert.equal(commit(),true)
  const nodes=[...extensionNodes(f.get().doc).values()].map(entry=>entry.value);assert.equal(nodes.length,2);assert.notEqual(nodes[0].instanceId,nodes[1].instanceId);assert.deepEqual({...nodes[1],instanceId:nodes[0].instanceId},nodes[0]);assert.deepEqual(nodes[0],f.value)
  assert.equal(jsonToSnapshot(f.get().doc.toJSON()).flatMap(block=>block.content.inlines).filter(inline=>inline.extension).length,2)
 }finally{f.close()}
})
test('heading list and quote conversions retain the original inline object instead of flattening it',()=>{
 for(const id of ['block.heading','block.bulletList','block.orderedList','block.quote','block.paragraph']){
  const f=fixture()
  try{const commit=prepareBlockTransaction(f.editor,id,undefined,blockTarget(f.get())!);assert.ok(commit,id);assert.equal(commit(),true);assert.deepEqual([...extensionNodes(f.get().doc).values()].map(entry=>entry.value),[f.value]);assert.match(f.get().doc.textContent,/Before Keep after/)}finally{f.close()}
 }
})
test('unloading a codec after staging rejects the write and protection is not cached as a grant',()=>{
 const f=fixture()
 try{const target=blockTarget(f.get())!,commit=prepareBlockTransaction(f.editor,'block.duplicate',undefined,target);assert.ok(commit);assert.equal(protectedBlock(f.get().doc.firstChild!,f.registry),false);f.detach();assert.equal(protectedBlock(f.get().doc.firstChild!,f.registry),true);assert.equal(blockActionStates(f.get(),target)['block.duplicate'].enabled,false);assert.equal(commit(),false);assert.equal(extensionNodes(f.get().doc).size,1)}finally{f.close()}
})
test('unknown payloads and unknown enclosing rich containers remain protected',()=>{
 const f=fixture()
 try{
  const unknown={...f.value,version:77},paragraph=schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdExtensionInline.createChecked({extension:unknown})]);let state=EditorState.create({schema,doc:schema.nodes.doc.createChecked(null,[paragraph]),plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]});assert.equal(blockActionStates(state)['block.duplicate'].enabled,false)
  const rich=new NodeExtensionRegistry([{...definition,type:'example.rich',display:'block',contentModel:'blocks',exportAdapters:undefined}]),outer={...rich.create('example.rich'),version:77},inner=rich.create('example.rich')
  const doc=schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{extension:outer},content:[{type:'hcdExtensionContainer',attrs:{extension:inner},content:[{type:'paragraph',content:[{type:'text',text:'Protected child'}]}]}]}]})
  state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(()=>{},()=>rich)]});state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,3)));const target=blockTarget(state)!;assert.ok(target.scope);assert.equal(blockActionStates(state,target)['block.heading'].enabled,false);assert.equal(transformBlocks(state.tr,'block.heading',undefined,target,rich),false)
 }finally{f.close()}
})
test('moving a known inline paragraph preserves peer typing and own undo restores its position',()=>{
 const f=fixture(),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(f.doc);Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager()
 const reconcile=(store:SemanticBlockStore,doc:typeof f.doc)=>store.reconcile(store.blocks(),doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
 try{
  let state=EditorState.create({schema,doc:sa.project(),plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]}),tr=state.tr;assert.equal(transformBlocks(tr,'block.down',undefined,blockTarget(state)!,f.registry),true);undo.stopCapturing();reconcile(sa,tr.doc);undo.stopCapturing()
  state=EditorState.create({schema,doc:sb.project()});reconcile(sb,state.tr.insertText(' peer input',3).doc)
  const exchange=()=>{const aa=Y.encodeStateAsUpdate(a),bb=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bb);Y.applyUpdate(b,aa)};exchange();assert.ok(sa.project().eq(sb.project()));assert.equal(sa.project().firstChild!.textContent,'Peer paragraph');assert.match(sa.project().textContent,/peer input/);assert.deepEqual([...extensionNodes(sa.project()).keys()],[f.value.instanceId])
  undo.undo();exchange();assert.match(sa.project().firstChild!.textContent,/peer input/);assert.ok(sa.project().eq(sb.project()));assert.deepEqual([...extensionNodes(sa.project()).keys()],[f.value.instanceId])
 }finally{undo.destroy();a.destroy();b.destroy();f.close()}
})
