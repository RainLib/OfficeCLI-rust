import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import type {InlineReference} from './inlineReference.ts'
import {referenceEditField,referenceEditIndex,prepareReferenceEdits,publishReferenceEdits,projectReferenceEdits,storageReferenceNode,resolveReferenceEdit,documentReferences} from './referenceEdits.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),id='m_'+'a'.repeat(32),root:InlineReference={type:'hcd.mention',version:1,mentionId:id,target:{kind:'person',id:'original'},snapshot:{label:'Original'}}
const value=(target:string,label:string):InlineReference=>({...structuredClone(root),target:{kind:'person',id:target},snapshot:{label}})
const document=(reference:InlineReference=root)=>schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('Before '),schema.nodes.hcdMention.createChecked({reference}),schema.text(' after')])])
const exchange=(a:Y.Doc,b:Y.Doc)=>{const aa=Y.encodeStateAsUpdate(a),bb=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bb);Y.applyUpdate(b,aa)}
test('concurrent retargets retain whole target/name candidates and explicit resolution has its own undo boundary',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),origin={},undo=new Y.UndoManager(a.getMap(referenceEditField),{trackedOrigins:new Set([origin])})
 try{
  const before=document(),first=prepareReferenceEdits(a,before,document(value('alice','Alice snapshot'))),second=prepareReferenceEdits(b,before,document(value('bob','Bob snapshot')))
  a.transact(()=>publishReferenceEdits(a,first),origin);b.transact(()=>publishReferenceEdits(b,second),{});exchange(a,b)
  const index=referenceEditIndex(a),group=index.get(id)!;assert.equal(group.conflicted,true);assert.equal(group.candidates.length,2);assert.deepEqual(new Set(group.candidates.map(edit=>JSON.stringify([edit.after.target.id,edit.after.snapshot.label]))),new Set(['["alice","Alice snapshot"]','["bob","Bob snapshot"]']))
  assert.deepEqual(documentReferences(projectReferenceEdits(before,index)).get(id)!.reference,root)
  assert.deepEqual(storageReferenceNode({type:'hcdMention',attrs:{reference:first[0].after}},index),{type:'hcdMention',attrs:{reference:root}})
  undo.stopCapturing();resolveReferenceEdit(a,id,group.ids,first[0].id,origin);undo.stopCapturing();exchange(a,b)
  assert.equal(referenceEditIndex(b).get(id)!.conflicted,false);assert.deepEqual(referenceEditIndex(b).get(id)!.value,first[0].after)
  undo.undo();exchange(a,b);assert.equal(referenceEditIndex(b).get(id)!.conflicted,true);undo.redo();exchange(a,b);assert.deepEqual(referenceEditIndex(b).get(id)!.value,first[0].after)
 }finally{undo.destroy();a.destroy();b.destroy()}
})
test('two offline conflict resolutions remain candidates instead of erasing one another',()=>{
 const a=new Y.Doc(),b=new Y.Doc()
 try{
  const first=prepareReferenceEdits(a,document(),document(value('alice','A'))),second=prepareReferenceEdits(b,document(),document(value('bob','B')));publishReferenceEdits(a,first);publishReferenceEdits(b,second);exchange(a,b)
  const group=referenceEditIndex(a).get(id)!;resolveReferenceEdit(a,id,group.ids,first[0].id,{});resolveReferenceEdit(b,id,group.ids,second[0].id,{});exchange(a,b)
  const merged=referenceEditIndex(a).get(id)!;assert.equal(merged.conflicted,true);assert.equal(merged.candidates.length,2);assert.deepEqual(referenceEditIndex(b).get(id),merged)
  assert.throws(()=>resolveReferenceEdit(a,id,group.ids,first[0].id,{}),/reference-changed/)
  resolveReferenceEdit(a,id,merged.ids,merged.candidates[0].id,{});exchange(a,b);assert.equal(referenceEditIndex(b).get(id)!.conflicted,false)
 }finally{a.destroy();b.destroy()}
})
test('equal complete values converge; shared bytes and missing codecs do not lose the reference data',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),copy=new Y.Doc()
 try{
  for(const replica of [a,b])publishReferenceEdits(replica,prepareReferenceEdits(replica,document(),document(value('same','Same'))));exchange(a,b);assert.equal(referenceEditIndex(a).get(id)!.conflicted,false)
  Y.applyUpdate(copy,Y.encodeStateAsUpdate(a));assert.deepEqual(referenceEditIndex(copy).get(id),referenceEditIndex(a).get(id));assert.deepEqual(documentReferences(projectReferenceEdits(document(),referenceEditIndex(copy))).get(id)!.reference,value('same','Same'))
 }finally{a.destroy();b.destroy();copy.destroy()}
})

test('published and returned reference snapshots cannot mutate stored records by object alias',()=>{
 const a=new Y.Doc(),b=new Y.Doc()
 try{
  const first=prepareReferenceEdits(a,document(),document(value('alice','A'))),second=prepareReferenceEdits(b,document(),document(value('bob','B')));publishReferenceEdits(a,first);publishReferenceEdits(b,second)
  first[0].after.target.id='not the published target';assert.equal(referenceEditIndex(a).get(id)!.value.target.id,'alice');exchange(a,b)
  const group=referenceEditIndex(a).get(id)!,selected=group.candidates.find(edit=>edit.after.target.id==='alice')!,returned=resolveReferenceEdit(a,id,group.ids,selected.id,{})
  returned.snapshot.label='not the stored label';assert.equal(referenceEditIndex(a).get(id)!.value.snapshot.label,'A')
 }finally{a.destroy();b.destroy()}
})
test('reference history rejects cycles, mismatched occurrences, future versions and ambiguous live atoms',()=>{
 const a=new Y.Doc()
 try{
  const first=prepareReferenceEdits(a,document(),document(value('alice','A')))[0]
  for(const mutation of [{...first,version:2},{...first,extra:'discard me'},{...first,after:{...first.after,mentionId:'m_'+'b'.repeat(32)}},{...first,parents:[first.id]}]){a.getMap(referenceEditField).set(first.id,mutation);assert.throws(()=>referenceEditIndex(a));a.getMap(referenceEditField).clear()}
  const second={...first,id:'q_'+'b'.repeat(32),parents:[first.id]};a.getMap(referenceEditField).set(first.id,{...first,parents:[second.id]});a.getMap(referenceEditField).set(second.id,second);assert.throws(()=>referenceEditIndex(a),/cycle/)
  const atom=schema.nodes.hcdMention.createChecked({reference:root});assert.throws(()=>documentReferences(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[atom,atom])])),/duplicate-reference/)
 }finally{a.destroy()}
})

test('real structural replicas retain one permanent atom while retargets conflict and own undo preserves the peer target',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(document());Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager()
 const change=(store:SemanticBlockStore,reference:InlineReference)=>{const before=store.blocks(),doc=store.project(),at=documentReferences(doc).get(id)!.position;const replace=(node:typeof doc):typeof doc=>node.type.name==='hcdMention'?node.type.createChecked({...node.attrs,reference},null,node.marks):node.childCount?node.copy(Fragment.fromArray(node.content.content.map(replace))):node;const next=replace(doc);assert.ok(at>0);store.reconcile(before,next.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 try{
  undo.stopCapturing();change(sa,value('alice','A'));undo.stopCapturing();change(sb,value('bob','B'));exchange(a,b)
  assert.equal(documentReferences(sa.project()).size,1);assert.equal(documentReferences(sb.project()).size,1);assert.equal(referenceEditIndex(a).get(id)!.conflicted,true);assert.ok(sa.project().eq(sb.project()))
  undo.undo();exchange(a,b);assert.deepEqual(documentReferences(sb.project()).get(id)!.reference,value('bob','B'));assert.equal(referenceEditIndex(b).get(id)!.conflicted,false)
  undo.redo();exchange(a,b);assert.equal(referenceEditIndex(b).get(id)!.conflicted,true)
  const group=referenceEditIndex(a).get(id)!;undo.stopCapturing();resolveReferenceEdit(a,id,group.ids,group.candidates.find(edit=>edit.after.target.id==='alice')!.id,sa.origin);undo.stopCapturing();exchange(a,b)
  assert.deepEqual(documentReferences(sb.project()).get(id)!.reference,value('alice','A'));undo.undo();exchange(a,b);assert.equal(referenceEditIndex(b).get(id)!.conflicted,true)
 }finally{undo.destroy();a.destroy();b.destroy()}
})

test('undoing an own deletion revives the same occurrence with a concurrent peer target edit retained',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(document());Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager()
 try{
  const key=sa.keys()[0],before=sa.content(key);undo.stopCapturing();sa.update(key,before,before.type.createChecked(before.attrs,[schema.text('Before  after')]));undo.stopCapturing()
  const peer=sb.content(key);sb.update(key,peer,peer.type.createChecked(peer.attrs,[schema.text('Before '),schema.nodes.hcdMention.createChecked({reference:value('bob','Bob')}),schema.text(' after')]))
  exchange(a,b);assert.equal(documentReferences(sa.project()).size,0);assert.equal(referenceEditIndex(a).get(id)!.value.target.id,'bob')
  undo.undo();exchange(a,b);assert.equal(documentReferences(sa.project()).size,1);assert.deepEqual(documentReferences(sa.project()).get(id)!.reference,value('bob','Bob'));assert.ok(sa.project().eq(sb.project()))
 }finally{undo.destroy();a.destroy();b.destroy()}
})
