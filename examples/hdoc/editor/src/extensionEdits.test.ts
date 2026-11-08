import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes} from './extensionNode.ts'
import {extensionEditIndex,materializeExtensionEdits,nodeEditStatus,resolveExtensionEdits,nodeEditFields} from './extensionEdits.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const definition:NodeExtensionDefinition={type:'example.task',version:1,display:'inline',label:'Task',defaultData:{title:'Initial',done:false,priority:1},validate:d=>typeof d.title==='string'&&typeof d.done==='boolean',fallback:d=>`${d.done?'☑':'☐'} ${d.title}`}
function fixture(display:'inline'|'block'='inline',business:NodeExtensionDefinition=definition){
 const registry=new NodeExtensionRegistry([{...business,display}]),value=registry.create(definition.type),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),atom={type:display==='inline'?'hcdExtensionInline':'hcdExtensionBlock',attrs:{extension:value}}
 sa.initialize(schema.nodeFromJSON({type:'doc',content:display==='inline'?[{type:'paragraph',content:[{type:'text',text:'before '},atom,{type:'text',text:' after'}]}]:[atom,{type:'paragraph',content:[{type:'text',text:'body'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 const edit=(store:SemanticBlockStore,data:Record<string,unknown>)=>{const blocks=store.blocks(),doc=store.project(),node=extensionNodes(doc).get(value.instanceId)!,next=registry.update(node.value,data),state=EditorState.create({schema,doc}),tr=state.tr.setNodeMarkup(node.position,undefined,{...doc.nodeAt(node.position)!.attrs,extension:next});store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));return next}
 const merge=()=>{Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))};const close=()=>{a.destroy();b.destroy()}
 return{registry,value,a,b,sa,sb,edit,merge,close}
}
for(const display of ['inline','block'] as const){
 test(`${display} offline disjoint data edits merge without duplicate atoms and wait for a matching readable materialization`,()=>{
  const f=fixture(display);f.edit(f.sa,{...f.value.data,title:'Alice'});f.edit(f.sb,{...f.value.data,done:true});f.merge();assert.equal(extensionNodes(f.sa.project()).size,1);assert.equal(extensionNodes(f.sb.project()).size,1);const group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.deepEqual(group.data,{title:'Alice',done:true,priority:1});assert.deepEqual(group.conflicts,{});assert.equal(nodeEditStatus(f.a,f.sa.project()).pending.length,1)
  materializeExtensionEdits(f.a,f.registry);f.merge();assert.equal(extensionNodes(f.sb.project()).get(f.value.instanceId)!.value.fallback.text,'☑ Alice');assert.equal(nodeEditStatus(f.b,f.sb.project()).pending.length,0)
  // Normal edits around the stable atom never copy the projected envelope back
  // over its immutable root or allocate a second embedded occurrence.
  const blocks=f.sa.blocks(),doc=f.sa.project(),tr=EditorState.create({schema,doc}).tr.insertText('Peer ',display==='inline'?1:doc.content.size-1);f.sa.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));f.merge();assert.equal(extensionNodes(f.sb.project()).size,1);assert.equal(extensionNodes(f.sb.project()).get(f.value.instanceId)!.value.fallback.text,'☑ Alice');f.close()
 })
 test(`${display} overlapping values remain candidates, explicit resolution is causal, undo restores the conflict`,()=>{
  const f=fixture(display),undo=f.sa.undoManager();undo.stopCapturing();f.edit(f.sa,{...f.value.data,title:'Alice'});undo.stopCapturing();f.edit(f.sb,{...f.value.data,title:'Bob'});f.merge();materializeExtensionEdits(f.a,f.registry);let group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.equal(group.conflicts.title.length,2);assert.equal(nodeEditStatus(f.a,f.sa.project()).conflicts.length,1)
  const oldIds=group.ids,bob=group.conflicts.title.find(v=>v.value==='Bob')!.intentId;undo.stopCapturing();resolveExtensionEdits(f.a,f.registry,f.value.instanceId,group.ids,{title:bob},semanticBlockOrigin);undo.stopCapturing();group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.deepEqual(group.conflicts,{});assert.equal(group.value.data.title,'Bob');assert.throws(()=>resolveExtensionEdits(f.a,f.registry,f.value.instanceId,oldIds,{title:bob},semanticBlockOrigin))
  undo.undo();assert.equal(extensionEditIndex(f.a).get(f.value.instanceId)!.conflicts.title.length,2);undo.redo();assert.deepEqual(extensionEditIndex(f.a).get(f.value.instanceId)!.conflicts,{});undo.destroy();f.close()
 })
 test(`${display} own undo removes only its data operation and keeps a peer property change`,()=>{
  const f=fixture(display),undo=f.sa.undoManager();undo.stopCapturing();f.edit(f.sa,{...f.value.data,title:'Alice'});f.edit(f.sb,{...f.value.data,done:true});f.merge();materializeExtensionEdits(f.a,f.registry);undo.undo();materializeExtensionEdits(f.a,f.registry);assert.deepEqual(extensionNodes(f.sa.project()).get(f.value.instanceId)!.value.data,{title:'Initial',done:true,priority:1});undo.redo();materializeExtensionEdits(f.a,f.registry);assert.deepEqual(extensionNodes(f.sa.project()).get(f.value.instanceId)!.value.data,{title:'Alice',done:true,priority:1});undo.destroy();f.close()
 })
}
test('equal concurrent values converge, field deletion merges with another field, and stale materialization cannot authorize changed data',()=>{
 const f=fixture();f.edit(f.sa,{...f.value.data,title:'Same'});f.edit(f.sb,{...f.value.data,title:'Same'});f.merge();assert.deepEqual(extensionEditIndex(f.a).get(f.value.instanceId)!.conflicts,{});materializeExtensionEdits(f.a,f.registry);const {priority:_priority,...data}=extensionNodes(f.sa.project()).get(f.value.instanceId)!.value.data;f.edit(f.sa,data);f.merge();assert.equal(Object.hasOwn(extensionNodes(f.sb.project()).get(f.value.instanceId)!.value.data,'priority'),false)
 const group=extensionEditIndex(f.a).get(f.value.instanceId)!;f.a.getMap(nodeEditFields.materialized).set(f.value.instanceId,{ids:group.ids,value:{...group.value,data:{title:'Forged',done:false}}});assert.throws(()=>f.sa.project(),/node-edit-materialization/);f.close()
})

test('invalid merged business data is retained pending, and an explicit valid branch can resolve it without losing candidates',()=>{
 const business={...definition,defaultData:{...definition.defaultData,a:1,b:1},validate:(d:Readonly<Record<string,unknown>>)=>typeof d.a==='number'&&typeof d.b==='number'&&d.a+d.b<=5},f=fixture('inline',business);f.edit(f.sa,{...f.value.data,a:4});f.edit(f.sb,{...f.value.data,b:4});f.merge();materializeExtensionEdits(f.a,f.registry);let group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.deepEqual(group.conflicts,{});assert.equal(group.ready,false);assert.equal(nodeEditStatus(f.a,f.sa.project()).pending.length,1);const candidate=group.intents.find(i=>i.after.data.a===4)!;resolveExtensionEdits(f.a,f.registry,f.value.instanceId,group.ids,{'#candidate':candidate.id},semanticBlockOrigin);group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.equal(group.ready,true);assert.equal(group.ids.length,3);assert.deepEqual([group.data.a,group.data.b],[4,1]);f.close()
})
test('an explicit equal-value branch choice works before materialization; user keys never collide with fallback metadata',()=>{
 const f=fixture();f.edit(f.sa,{...f.value.data,title:'Same'});f.edit(f.sb,{...f.value.data,title:'Same'});f.merge();let group=extensionEditIndex(f.a).get(f.value.instanceId)!;assert.equal(group.ready,false);resolveExtensionEdits(f.a,f.registry,f.value.instanceId,group.ids,{'#candidate':group.ids[0]},semanticBlockOrigin);assert.equal(extensionEditIndex(f.a).get(f.value.instanceId)!.ready,true);f.close()
 const g=fixture('inline',{...definition,defaultData:{...definition.defaultData,'#fallback':'original'}});g.edit(g.sa,{...g.value.data,'#fallback':'Alice key'});g.edit(g.sb,{...g.value.data,done:true});g.merge();materializeExtensionEdits(g.a,g.registry);group=extensionEditIndex(g.a).get(g.value.instanceId)!;assert.equal(group.data['#fallback'],'Alice key');assert.equal(group.value.fallback.text,'☑ Initial');assert.deepEqual(group.conflicts,{});g.close()
})

test('retained-history limit rejects before shared mutation while ordinary text remains editable',()=>{
 const f=fixture(),ids:string[]=[];for(let n=0;n<128;n++){const id='e_'+n.toString(16).padStart(32,'0');f.a.getMap(nodeEditFields.intents).set(id,{version:1,id,root:f.value,before:f.value,after:f.value,parents:[...ids],touched:['title']});ids.push(id)}materializeExtensionEdits(f.a,f.registry);const before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.edit(f.sa,{...f.value.data,title:'Over limit'}),/node-edit-limit/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);const blocks=f.sa.blocks(),doc=f.sa.project(),tr=EditorState.create({schema,doc}).tr.insertText('Still editable ',1);assert.doesNotThrow(()=>f.sa.validateReconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node}))));f.close()
})
