import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {documentReferences,referenceEditIndex,resolveReferenceEdit} from './referenceEdits.ts'
import {keepSavedReference} from './referenceSaved.ts'
import type {InlineReference} from './inlineReference.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),id='m_'+'a'.repeat(32),root:InlineReference={type:'hcd.mention',version:1,mentionId:id,target:{kind:'person',id:'root'},snapshot:{label:'Root'}}
function fixture(){
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),registry=new NodeExtensionRegistry(),abort=new AbortController()
 const value=(target:string)=>({...root,target:{kind:'person',id:target},snapshot:{label:target}})
 sa.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdMention.createChecked({reference:root}),schema.text(' peer body')])]))
 const change=(store:SemanticBlockStore,target:string)=>{const key=store.keys()[0],old=store.content(key);store.update(key,old,old.type.createChecked(old.attrs,[schema.nodes.hcdMention.createChecked({reference:value(target)}),schema.text(' peer body')]))}
 change(sa,'canonical');Y.applyUpdate(b,Y.encodeStateAsUpdate(a));change(sa,'alice');change(sb,'bob');Y.applyUpdate(a,Y.encodeStateAsUpdate(b))
 let editable=true,ready=true,captures=0
 const editor={isDestroyed:false,get isEditable(){return editable},get state(){return EditorState.create({schema,doc:sa.project()})},view:{composing:false}} as unknown as Editor
 const input={mentionId:id,ids:referenceEditIndex(a).get(id)!.ids,revision:3},snapshot={schemaVersion:'hcd-references/1',documentId:'doc',revision:3,items:[{reference:value('canonical'),blockId:'saved-block',childPath:[],inlineIndex:0}]}
 const routes:string[]=[],options={documentId:'doc',signal:abort.signal,ready:()=>ready,stopCapturing:()=>{captures++},read:async(route:string,_signal:AbortSignal):Promise<unknown>=>{routes.push(route);return route.startsWith('/revisions')?{headRevision:3}:structuredClone(snapshot)}}
 return {a,b,sa,registry,abort,editor,input,snapshot,options,routes,get captures(){return captures},setEditable:(v:boolean)=>{editable=v},setReady:(v:boolean)=>{ready=v},destroy:()=>{a.destroy();b.destroy()}}
}
test('saved recovery uses the reviewed canonical value, not the old conflict root, and has its own undo boundary',async()=>{
 const f=fixture(),undo=f.sa.undoManager()
 try{
  assert.equal(documentReferences(f.sa.project()).get(id)!.reference.target.id,'root')
  const chosen=await keepSavedReference(f.editor,f.sa,f.registry,f.input,f.options)
  assert.equal(chosen.target.id,'canonical');assert.equal(chosen.snapshot.label,'canonical');assert.equal(chosen.mentionId,id);assert.equal(referenceEditIndex(f.a).get(id)!.conflicted,false);assert.equal(f.captures,2)
  assert.deepEqual(f.routes,['/revisions?limit=1','/references?revision=3','/revisions?limit=1']);assert.ok(f.sa.project().textContent.includes('peer body'))
  undo.undo();assert.equal(referenceEditIndex(f.a).get(id)!.conflicted,true);undo.redo();assert.equal(documentReferences(f.sa.project()).get(id)!.reference.target.id,'canonical')
  Y.applyUpdate(f.b,Y.encodeStateAsUpdate(f.a));const copied=new SemanticBlockStore(f.b,schema);assert.ok(copied.project().eq(f.sa.project()))
 }finally{undo.destroy();f.destroy()}
})
for(const scenario of ['head-before','head-after','missing','wrong-revision','wrong-document','readonly','not-ready','cancelled','new-choice'] as const)test(`saved recovery refuses ${scenario} without publishing a stale local choice`,async()=>{
 const f=fixture();let reads=0,afterPeer:Uint8Array|undefined
 const original=f.options.read
 f.options.read=async(route,signal)=>{
  reads++
  if(scenario==='head-before'&&reads===1)return {headRevision:4}
  if(scenario==='head-after'&&reads===3)return {headRevision:4}
  if(reads===2){
   if(scenario==='readonly')f.setEditable(false)
   if(scenario==='not-ready')f.setReady(false)
   if(scenario==='cancelled')f.abort.abort()
   if(scenario==='new-choice'){const group=referenceEditIndex(f.a).get(id)!;resolveReferenceEdit(f.a,id,group.ids,group.candidates[0].id,{});afterPeer=Y.encodeStateAsUpdate(f.a)}
   if(scenario==='missing')return {...f.snapshot,items:[]}
   if(scenario==='wrong-revision')return {...f.snapshot,revision:2}
   if(scenario==='wrong-document')return {...f.snapshot,documentId:'other'}
  }
  return original(route,signal)
 }
 const before=Y.encodeStateAsUpdate(f.a)
 try{await assert.rejects(keepSavedReference(f.editor,f.sa,f.registry,f.input,f.options));assert.deepEqual(Y.encodeStateAsUpdate(f.a),afterPeer??before);assert.equal(f.captures,0)}finally{f.destroy()}
})
