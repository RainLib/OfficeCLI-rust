import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EditorState,type PluginView,type Transaction} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import * as Y from 'yjs'
import {history,undoDepth} from '@tiptap/pm/history'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {blockIdentityPlugin,sourceIdentityPlugin} from './schema.ts'
import {wordPageFlowPlugin,wordPageFlowKey,wordFlowLayoutTransaction,wordFlowPageCount,validWordFlowGeometry} from './wordPageFlow.ts'
const geometry={bodyHeight:800,pageHeight:1000,pageGap:24,scale:1}
test('page estimates distinguish unpaginated content from physical page stride',()=>{
 assert.equal(wordFlowPageCount(1600,geometry,false),2)
 assert.equal(wordFlowPageCount(1824,geometry,true),2)
 assert.equal(wordFlowPageCount(1824.25,geometry,true),2)
 assert.equal(wordFlowPageCount(1824.75,geometry,true),3)
 assert.equal(wordFlowPageCount(900,geometry,true),2)
 assert.equal(wordFlowPageCount(0,geometry,false),1)
 assert.equal(wordFlowPageCount(800.25,geometry,false),1)
 assert.equal(wordFlowPageCount(800.75,geometry,false),2)
 for(const invalid of [NaN,Infinity,-1])assert.throws(()=>wordFlowPageCount(invalid,geometry,false))
})
test('geometry rejects invalid scales, impossible body space and unbounded values',()=>{
 assert.equal(validWordFlowGeometry(geometry),true)
 for(const change of [{bodyHeight:0},{bodyHeight:1001},{pageHeight:Infinity},{pageGap:-1},{scale:NaN},{scale:0},{scale:20}])assert.equal(validWordFlowGeometry({...geometry,...change}),false)
})
test('layout metadata neither changes document content nor enters personal history',()=>{
 const schema=wordRegionSchema(),doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'正文 original'}]}]}),plugin=wordPageFlowPlugin({geometry:()=>geometry,onLayout:()=>{},maxPages:512,maxPasses:12})
 let state=EditorState.create({schema,doc,plugins:[history(),plugin]});const before=state.doc.toJSON(),transaction=wordFlowLayoutTransaction({state},geometry,8)
 assert.equal(transaction.docChanged,false);assert.equal(transaction.getMeta('addToHistory'),false);state=state.apply(transaction)
 assert.deepEqual(state.doc.toJSON(),before);assert.equal(undoDepth(state),0);assert.equal(wordPageFlowKey.getState(state)?.pages,8)
 state=state.apply(state.tr.insertText(' own',1));assert.equal(undoDepth(state),1)
 state=state.apply(wordFlowLayoutTransaction({state},geometry,9));assert.equal(undoDepth(state),1)
 state=state.apply(wordFlowLayoutTransaction({state},null,1));assert.equal(wordPageFlowKey.getState(state)?.decorations.find().length,0)
})
test('layout commands reject forged counts without editing state',()=>{
 const state=EditorState.create({schema:wordRegionSchema()})
 for(const count of [0,-1,1.1,513,Infinity])assert.throws(()=>wordFlowLayoutTransaction({state},geometry,count))
 assert.throws(()=>wordFlowLayoutTransaction({state},{...geometry,pageGap:-1},2))
})
test('page layout leaves real regional Yjs bytes, checkpoint and personal undo intact',async()=>{
 const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),schema=wordRegionSchema(),hash='a'.repeat(64)
 const projection:WordRegionProjection={documentId:'pages',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(n+10),blockHash:hash,region:n===1?'body':'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Body':'Header',nodeId:id(n+20)}]}}))}
 const document=new Y.Doc(),peer=new Y.Doc(),model=new WordRegionStore(document,schema,'pages',projection.flowLayout,hash);model.initialize(projection);Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));const remote=new WordRegionStore(peer,schema,'pages',projection.flowLayout,hash),errors:unknown[]=[]
 const binding=semanticStructureBinding(model.view(id(1)),{canWrite:()=>true,onError:error=>errors.push(error)}),flow=wordPageFlowPlugin({geometry:()=>geometry,onLayout:()=>{},maxPages:512,maxPasses:12})
 let state=EditorState.create({schema,plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),binding,flow]}),bound:PluginView|undefined
 const view={get state(){return state},dispatch(tr:Transaction){const previous=state;state=state.applyTransaction(tr).state;bound?.update?.(view as unknown as EditorView,previous)}}
 bound=binding.spec.view!(view as unknown as EditorView);await Promise.resolve();const manager=model.structure.undoManager()
 try{
  const bytes=Y.encodeStateAsUpdate(document),checkpoint=model.contents()
  for(const pages of [2,4,3,1])view.dispatch(wordFlowLayoutTransaction(view,geometry,pages))
  view.dispatch(wordFlowLayoutTransaction(view,null,1))
  assert.deepEqual(Y.encodeStateAsUpdate(document),bytes);assert.equal(model.contents(),checkpoint);assert.equal(manager.undoStack.length,0)
  manager.stopCapturing();view.dispatch(state.tr.insertText(' Own',1));manager.stopCapturing();assert.equal(manager.undoStack.length,1)
  const blocks=remote.region(id(2)),block=blocks[0];remote.reconcile(id(2),blocks,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Peer Header',block.node.firstChild?.marks))}]);Y.applyUpdate(document,Y.encodeStateAsUpdate(peer))
  view.dispatch(wordFlowLayoutTransaction(view,geometry,7));manager.undo()
  assert.equal(model.project(id(1)).textContent,'Body');assert.equal(model.project(id(2)).textContent,'Peer Header')
  manager.redo();assert.equal(model.project(id(1)).textContent,' OwnBody');assert.equal(model.project(id(2)).textContent,'Peer Header');assert.deepEqual(errors,[])
 }finally{bound.destroy?.();manager.destroy();document.destroy();peer.destroy()}
})
