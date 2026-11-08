import {test} from 'node:test'
import assert from 'node:assert/strict'
import {NodeExtensionRegistry,stableExtension} from './extensionRegistry.ts'
import type {ExtensionNodePayload,NodeExtensionDefinition} from './extensionTypes.ts'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from './semanticBlockStore.ts'
import {extensionNodes} from './extensionNode.ts'
import {extensionEditIndex,nodeEnvelopeField,nodeEditStatus,materializeExtensionEdits,resolveExtensionEdits} from './extensionEdits.ts'

const old:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:'x_'+'a'.repeat(32),type:'example.task',version:1,display:'inline',data:{label:'Review',done:false,extra:{retained:true}},fallback:{text:'Old Review'}}
const current:NodeExtensionDefinition={type:'example.task',version:3,display:'inline',label:'Task',defaultData:{title:'New',done:false,priority:1},validate:d=>typeof d.title==='string'&&typeof d.done==='boolean'&&typeof d.priority==='number',fallback:d=>`${d.done?'☑':'☐'} ${d.title} (${d.priority})`,migrations:[{fromVersion:1,validate:d=>typeof d.label==='string'&&typeof d.done==='boolean',migrate:({label,...rest})=>({...rest,title:label})},{fromVersion:2,validate:d=>typeof d.title==='string'&&typeof d.done==='boolean',migrate:d=>({...d,priority:1})}]}

test('explicit chained migration preserves occurrence identity, unknown data and immutable source without rewriting on read',()=>{
 for(const display of ['inline','block'] as const){
  const registry=new NodeExtensionRegistry([{...current,display}]),before={...old,display},original=stableExtension(before)
  assert.equal(registry.resolve(before),undefined)
  const preview=registry.previewMigration(before)!
  assert.deepEqual(preview.versions,[1,2,3]);assert.equal(stableExtension(before),original)
  assert.equal(preview.after.instanceId,before.instanceId);assert.equal(preview.after.display,display);assert.equal(preview.after.type,before.type)
  assert.deepEqual(preview.after.data,{done:false,extra:{retained:true},title:'Review',priority:1});assert.equal(preview.after.fallback.text,'☐ Review (1)')
  assert.ok(registry.resolve(preview.after));assert.ok(Object.isFrozen(preview.after.data.extra))
  assert.throws(()=>{(preview.after.data.extra as any).retained=false})
  assert.equal(registry.previewMigration(preview.after),null)
 }
})
test('missing steps, future versions and wrong display keep the original unknown node readable',()=>{
 const registry=new NodeExtensionRegistry([{...current,migrations:[current.migrations![1]]}])
 for(const value of [old,{...old,version:99},{...old,display:'block' as const}])assert.equal(registry.previewMigration(value),null)
 assert.equal(stableExtension(old.fallback),'{"text":"Old Review"}')
})
test('invalid, asynchronous, mutating or non-deterministic migration outputs cannot produce a committed payload',()=>{
 const cases=[()=>null,()=>Promise.resolve({}),()=>({constructor:'invalid'}),()=>({text:'x'.repeat(70000)}),()=>({done:'invalid',title:'Invalid'})]
 for(const migrate of cases){const registry=new NodeExtensionRegistry([{...current,version:2,defaultData:{title:'New',done:false,priority:1},migrations:[{fromVersion:1,validate:()=>true,migrate:migrate as any}]}]);assert.throws(()=>registry.previewMigration(old))}
 let number=0
 const nondeterministic=new NodeExtensionRegistry([{...current,version:2,migrations:[{fromVersion:1,validate:()=>true,migrate:d=>({...d,title:`Run ${++number}`,priority:1})}]}])
 assert.throws(()=>nondeterministic.previewMigration(old),/NonDeterministic/)
 const mutating=new NodeExtensionRegistry([{...current,migrations:[{...current.migrations![0],migrate:d=>{(d.extra as any).retained=false;return{...d}}},current.migrations![1]]}])
 assert.throws(()=>mutating.previewMigration(old));assert.deepEqual(old.data.extra,{retained:true})
 const invalidSource=new NodeExtensionRegistry([{...current,migrations:[{...current.migrations![0],validate:()=>false},current.migrations![1]]}])
 assert.throws(()=>invalidSource.previewMigration(old),/InvalidSource/)
})
test('migration registration is bounded, copied and removed with its owner',()=>{
 const steps=[...current.migrations!],registry=new NodeExtensionRegistry(),close=registry.connect(),unregister=registry.register([{...current,migrations:steps}])
 steps.length=0;assert.ok(registry.previewMigration(old));unregister();assert.equal(registry.previewMigration(old),null)
 for(const migrations of [[current.migrations![0],current.migrations![0]],[{...current.migrations![0],fromVersion:0}],[{...current.migrations![0],fromVersion:3}],Array(17).fill(current.migrations![0])])assert.throws(()=>registry.register([{...current,migrations}]))
 assert.equal(registry.list().length,0);close()
})

const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function shared(display:'inline'|'block'){
 const registry=new NodeExtensionRegistry([{...current,display}]),source={...old,display},a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
 const atom={type:display==='inline'?'hcdExtensionInline':'hcdExtensionBlock',attrs:{extension:source}}
 sa.initialize(schema.nodeFromJSON({type:'doc',content:display==='inline'?[{type:'paragraph',content:[{type:'text',text:'Before '},atom]}]:[atom,{type:'paragraph',content:[{type:'text',text:'After'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 const value=(store:SemanticBlockStore)=>extensionNodes(store.project()).get(source.instanceId)!.value
 const write=(store:SemanticBlockStore,payload:ExtensionNodePayload)=>{const blocks=store.blocks(),doc=store.project(),entry=extensionNodes(doc).get(source.instanceId)!,tr=EditorState.create({schema,doc}).tr.setNodeMarkup(entry.position,undefined,{...doc.nodeAt(entry.position)!.attrs,extension:payload});store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 const merge=()=>{Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))}
 return{registry,source,a,b,sa,sb,value,write,merge,close:()=>{a.destroy();b.destroy()}}
}
for(const display of ['inline','block'] as const){
 test(`${display} migration is a schema barrier; later same-version disjoint fields still merge`,()=>{
  const f=shared(display);f.write(f.sa,f.registry.previewMigration(f.source)!.after);f.merge()
  assert.equal(f.value(f.sb).version,3);assert.equal(f.value(f.sb).instanceId,f.source.instanceId)
  f.write(f.sa,f.registry.update(f.value(f.sa),{...f.value(f.sa).data,title:'Alice'}));f.write(f.sb,f.registry.update(f.value(f.sb),{...f.value(f.sb).data,done:true}));f.merge();materializeExtensionEdits(f.a,f.registry);f.merge()
  const group=extensionEditIndex(f.a).get(f.source.instanceId)!
  assert.equal(group.base.version,3);assert.deepEqual(group.conflicts,{});assert.equal(group.ready,true)
  assert.equal(f.value(f.sa).fallback.text,'☑ Alice (1)');assert.deepEqual(f.value(f.sa),f.value(f.sb));assert.deepEqual(f.value(f.sa).data.extra,{retained:true});f.close()
 })
 test(`${display} concurrent old-schema edits and migration retain full candidates, explicit choice and undo`,()=>{
  const f=shared(display),undo=f.sa.undoManager();undo.stopCapturing()
  f.write(f.sa,f.registry.previewMigration(f.source)!.after);undo.stopCapturing()
  f.write(f.sb,{...f.source,data:{...f.source.data,label:'Bob'},fallback:{text:'Old Bob'}});f.merge()
  let group=extensionEditIndex(f.a).get(f.source.instanceId)!
  assert.equal(nodeEditStatus(f.a,f.sa.project()).conflicts.length,1);assert.deepEqual(new Set(group.conflicts[nodeEnvelopeField].map(option=>(option.value as ExtensionNodePayload).version)),new Set([1,3]))
  const upgraded=group.conflicts[nodeEnvelopeField].find(option=>(option.value as ExtensionNodePayload).version===3)!
  resolveExtensionEdits(f.a,f.registry,f.source.instanceId,group.ids,{[nodeEnvelopeField]:upgraded.intentId},semanticBlockOrigin);undo.stopCapturing();assert.equal(f.value(f.sa).version,3)
  undo.undo();group=extensionEditIndex(f.a).get(f.source.instanceId)!;assert.ok(group.conflicts[nodeEnvelopeField]);undo.redo();assert.equal(f.value(f.sa).version,3);undo.undo()
  group=extensionEditIndex(f.a).get(f.source.instanceId)!;const previous=group.conflicts[nodeEnvelopeField].find(option=>(option.value as ExtensionNodePayload).version===1)!
  resolveExtensionEdits(f.a,f.registry,f.source.instanceId,group.ids,{[nodeEnvelopeField]:previous.intentId},semanticBlockOrigin)
  assert.equal(f.value(f.sa).version,1);assert.equal(f.value(f.sa).data.label,'Bob')
  f.write(f.sa,f.registry.previewMigration(f.value(f.sa))!.after);f.merge();assert.equal(f.value(f.sb).data.title,'Bob');assert.equal(f.value(f.sb).version,3)
  undo.destroy();f.close()
 })
 test(`${display} own migration undo keeps peer text and restores the original payload`,()=>{
  const f=shared(display),undo=f.sa.undoManager();undo.stopCapturing();f.write(f.sa,f.registry.previewMigration(f.source)!.after);undo.stopCapturing();f.merge()
  const blocks=f.sb.blocks(),doc=f.sb.project(),position=display==='inline'?1:doc.content.size-1,tr=EditorState.create({schema,doc}).tr.insertText('Peer text ',position)
  f.sb.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));f.merge();undo.undo();assert.deepEqual(f.value(f.sa),f.source);assert.match(f.sa.project().textContent,/Peer text/);undo.redo();assert.equal(f.value(f.sa).version,3);assert.match(f.sa.project().textContent,/Peer text/);undo.destroy();f.close()
 })
}
test('equal concurrent migrations converge but different target data remains a whole-node dispute',()=>{
 for(const equal of [true,false]){
  const f=shared('inline'),alternative=new NodeExtensionRegistry([{...current,migrations:[current.migrations![0],{...current.migrations![1],migrate:d=>({...d,priority:2})}]}])
  f.write(f.sa,f.registry.previewMigration(f.source)!.after);f.write(f.sb,(equal?f.registry:alternative).previewMigration(f.source)!.after);f.merge()
  const group=extensionEditIndex(f.a).get(f.source.instanceId)!
  assert.equal(!!group.conflicts[nodeEnvelopeField],!equal);assert.equal(extensionNodes(f.sa.project()).size,1);f.close()
 }
})
