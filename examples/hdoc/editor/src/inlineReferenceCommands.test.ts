import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {inlineContainerPreservationPlugin} from './inlineContainerPreservation.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {canEditReference,retargetReference,chooseReferenceCandidate} from './referenceCommands.ts'
import {keepSavedReference} from './referenceSaved.ts'
import {documentReferences,referenceEditIndex} from './referenceEdits.ts'
import type {InlineReference} from './inlineReference.ts'

const definition=(type:string)=>({type,version:1,display:'inline' as const,contentModel:'inline' as const,label:type,defaultData:{},validate:()=>true,fallback:()=>type})
const definitions=[definition('test.outer'),definition('test.inner')]
const original:InlineReference={type:'hcd.mention',version:1,mentionId:'m_'+'b'.repeat(32),target:{kind:'person',id:'initial'},snapshot:{label:'Initial'}}
const people={alice:{kind:'person' as const,id:'alice',label:'Alice 王'},bob:{kind:'person' as const,id:'bob',label:'Bob 李'}}
function environment(document=new Y.Doc({gc:false})){
 const registry=new InlineContainerRegistry(definitions),ordinary=new NodeExtensionRegistry(),release=registry.connect(),schema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode]),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
 if(!store.initialized){
  const inner=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:registry.create('test.inner')},[schema.text('Inner 😀 '),schema.nodes.hcdMention.createChecked({reference:original}),schema.text(' tail')])
  const outer=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:registry.create('test.outer')},[schema.text('Outer '),inner])
  store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,outer),schema.nodes.paragraph.createChecked(null,schema.text('Other paragraph'))]))
 }
 let editable=true,state=EditorState.create({schema}),binding:PluginView|undefined
 const errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>editable,onError:error=>errors.push(error)})
 state=EditorState.create({schema,doc:store.project(),plugins:[sourceIdentityPlugin(),inlineContainerPreservationPlugin(registry.resolve,error=>errors.push(error),()=>registry),plugin]})
 const view={get state(){return state},composing:false,dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 const editor={isDestroyed:false,get isEditable(){return editable},get state(){return state},view} as unknown as Editor
 return{document,store,registry,ordinary,editor,errors,release,ready:new Promise<void>(resolve=>queueMicrotask(resolve)),setEditable:(value:boolean)=>{editable=value},reference:()=>documentReferences(state.doc).get(original.mentionId)!.reference,close(){binding?.destroy?.();release();document.destroy()}}
}
function fork(a:ReturnType<typeof environment>){const document=new Y.Doc({gc:false});Y.applyUpdate(document,Y.encodeStateAsUpdate(a.document));return environment(document)}
function change(e:ReturnType<typeof environment>,person:keyof typeof people){return retargetReference(e.editor,e.store,e.ordinary,e.reference(),people[person],e.registry)}
function bodies(e:ReturnType<typeof environment>){return [...e.store.flow.containers!.bodies].map(([id,body])=>[id,body.toDelta()])}

test('nested inline retarget keeps the occurrence, body carriers and peer text through personal undo and redo',async()=>{
 const a=environment();await a.ready;const b=fork(a);await b.ready;const history=a.store.undoManager(false)
 try{
  const initial=bodies(a),bodyIds=[...a.store.flow.containers!.bodies.keys()]
  assert.ok(change(a,'alice'));assert.equal(a.reference().mentionId,original.mentionId);assert.equal(a.reference().target.id,'alice')
  assert.deepEqual(bodies(a),initial,'The immutable mention root stays in its original body carrier')
  const inner=[...b.store.flow.containers!.bodies].find(([,body])=>body.toString().startsWith('Inner'))![1];inner.insert(0,'Peer ')
  Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document));assert.match(a.store.project().textContent,/Peer Inner/)
  assert.equal(history.undoStack.length,1);history.undo();assert.equal(a.reference().target.id,'initial');assert.match(a.store.project().textContent,/Peer Inner/)
  history.redo();assert.equal(a.reference().target.id,'alice');assert.deepEqual([...a.store.flow.containers!.bodies.keys()],bodyIds);assert.deepEqual(a.errors,[])
 }finally{history.destroy();a.close();b.close()}
})

test('every enclosing inline codec is required, including direct candidate commands and stale retarget snapshots',async()=>{
 const a=environment();await a.ready;const b=fork(a);await b.ready
 try{
  change(a,'alice');change(b,'bob');Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document))
  const group=referenceEditIndex(a.document).get(original.mentionId)!,input={mentionId:original.mentionId,ids:group.ids,candidateId:group.candidates[0].id},before=Y.encodeStateAsUpdate(a.document)
  assert.equal(group.conflicted,true)
  for(const registry of [undefined,new InlineContainerRegistry(),new InlineContainerRegistry([definitions[0]]),new InlineContainerRegistry([definitions[1]])]){
   assert.equal(canEditReference(a.editor,a.ordinary,original.mentionId,registry),false)
   assert.equal(chooseReferenceCandidate(a.editor,a.store,a.ordinary,input,registry),false)
   assert.equal(retargetReference(a.editor,a.store,a.ordinary,original,people.bob,registry),false)
   assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)
  }
  a.setEditable(false);assert.equal(chooseReferenceCandidate(a.editor,a.store,a.ordinary,input,a.registry),false);a.setEditable(true)
  assert.ok(chooseReferenceCandidate(a.editor,a.store,a.ordinary,input,a.registry));assert.equal(referenceEditIndex(a.document).get(original.mentionId)!.conflicted,false)
  const settled=Y.encodeStateAsUpdate(a.document)
  assert.throws(()=>retargetReference(a.editor,a.store,a.ordinary,original,people.alice,a.registry),/reference-changed/)
  assert.deepEqual(Y.encodeStateAsUpdate(a.document),settled)
  a.release();assert.equal(canEditReference(a.editor,a.ordinary,original.mentionId,a.registry),false)
 }finally{a.close();b.close()}
})

test('nested reference conflicts retain complete causal candidates and undo only the local resolution',async()=>{
 const a=environment();await a.ready;const b=fork(a);await b.ready
 try{
  change(a,'alice');change(b,'bob');Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document));Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
  const group=referenceEditIndex(a.document).get(original.mentionId)!,history=a.store.undoManager(false)
  try{
   assert.deepEqual(group.candidates.map(v=>[v.after.target.id,v.after.snapshot.label]).sort(),[['alice','Alice 王'],['bob','Bob 李']])
   const candidate=group.candidates.find(v=>v.after.target.id==='bob')!,input={mentionId:original.mentionId,ids:group.ids,candidateId:candidate.id}
   assert.ok(chooseReferenceCandidate(a.editor,a.store,a.ordinary,input,a.registry));assert.equal(a.reference().target.id,'bob')
   assert.equal(history.undoStack.length,1);history.undo();assert.equal(referenceEditIndex(a.document).get(original.mentionId)!.conflicted,true)
   history.redo();assert.equal(a.reference().target.id,'bob');assert.equal(a.reference().snapshot.label,'Bob 李')
   const settled=Y.encodeStateAsUpdate(a.document)
   assert.equal(chooseReferenceCandidate(a.editor,a.store,a.ordinary,input,a.registry),false)
   assert.deepEqual(Y.encodeStateAsUpdate(a.document),settled)
  }finally{history.destroy()}
 }finally{a.close();b.close()}
})

test('saved target recovery rechecks enclosing inline codecs after each asynchronous read',async()=>{
 const a=environment();await a.ready;const b=fork(a);await b.ready
 try{
  change(a,'alice');change(b,'bob');Y.applyUpdate(a.document,Y.encodeStateAsUpdate(b.document))
  const group=referenceEditIndex(a.document).get(original.mentionId)!,input={mentionId:original.mentionId,ids:group.ids,revision:4},before=Y.encodeStateAsUpdate(a.document)
  let reads=0
  await assert.rejects(keepSavedReference(a.editor,a.store,a.ordinary,input,{documentId:'doc',signal:new AbortController().signal,ready:()=>true,stopCapturing:()=>{},inlineRegistry:a.registry,read:async()=>{reads++;a.release();return{headRevision:4}}}),/reference-changed/)
  assert.equal(reads,1);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)
 }finally{a.close();b.close()}
})
