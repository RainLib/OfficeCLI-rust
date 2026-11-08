import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState,NodeSelection} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from './extensionNode.ts'
import {documentReferences} from './referenceEdits.ts'
import {blockTarget,rootBlocks,blockActionStates,transformBlocks,prepareBlockTransaction,targetBlockCount,blockEntryScope,siblingBlockEntries} from './commands/blocks.ts'
import {structureProjectionTransaction} from './semanticStructureBinding.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),inline:NodeExtensionDefinition={type:'example.badge',version:1,display:'inline',label:'Badge',defaultData:{title:'Badge'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)},block:NodeExtensionDefinition={...inline,type:'example.card',display:'block'},rich:NodeExtensionDefinition={...block,type:'example.notes',contentModel:'blocks'}
test('an open-slice projection fit cannot introduce duplicate business wrappers into the editor',()=>{
 const registry=new NodeExtensionRegistry([rich]),value=registry.create(rich.type),p=(text:string,bold=false)=>schema.nodes.paragraph.createChecked(null,[schema.text(text,bold?[schema.marks.bold.create()]:[])]),wrapped=(children:ReturnType<typeof p>[])=>schema.nodes.blockquote.createChecked(null,[schema.nodes.hcdExtensionContainer.createChecked({extension:value},children)])
 const before=schema.nodes.doc.createChecked(null,[wrapped([p('Tail'),p('Same',true)])]),next=schema.nodes.doc.createChecked(null,[wrapped([p('Other'),p('Prefix',true)]),p('Tail'),schema.nodes.bulletList.createChecked(null,[schema.nodes.listItem.createChecked(null,[p('Same',true)])])]),state=EditorState.create({schema,doc:before}),start=before.content.findDiffStart(next.content)!,end=before.content.findDiffEnd(next.content)!,overlap=start-Math.min(end.a,end.b),legacy=state.tr.replace(start,overlap>0?end.a+overlap:end.a,next.slice(start,overlap>0?end.b+overlap:end.b))
 assert.equal(legacy.doc.eq(next),false,'the fitter can produce a schema-valid but semantically different document')
 const projection=structureProjectionTransaction(state,next);assert.ok(projection);assert.ok(projection.doc.eq(next));assert.equal(extensionNodes(projection.doc).size,1);assert.equal(projection.doc.textContent,next.textContent)
})
function fixture(){
 const registry=new NodeExtensionRegistry([block,rich]),close=registry.connect(),detach=registry.register([inline]),resources=[{key:'notes',hash:'a'.repeat(64),byteLength:4,name:'notes.txt',mediaType:'text/plain'}],wrapper=registry.create(rich.type,undefined,resources),card=registry.create(block.type),badge=registry.create(inline.type,undefined,resources),nested=registry.create(rich.type)
 const doc=schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before'}]},{type:'hcdExtensionContainer',attrs:{extension:wrapper},content:[{type:'paragraph',content:[{type:'text',text:'Inner ',marks:[{type:'bold'}]},{type:'hcdExtensionInline',attrs:{extension:badge}},{type:'hcdMention',attrs:{reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}}}}]},{type:'hcdExtensionContainer',attrs:{extension:nested},content:[{type:'paragraph',content:[{type:'text',text:'Nested content'}]}]},{type:'hcdExtensionBlock',attrs:{extension:card,fallbackInline:{nodeId:'n_'+'b'.repeat(32),text:card.fallback.text,bold:true}}}]},{type:'paragraph',content:[{type:'text',text:'After'}]}]})
 let state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(()=>{},()=>registry)]});state=state.apply(state.tr.setSelection(NodeSelection.create(state.doc,doc.firstChild!.nodeSize)))
 const editor={isDestroyed:false,isEditable:true,get state(){return state},view:{composing:false,dispatch(tr:typeof state.tr){state=state.apply(tr)},focus(){}}} as unknown as Editor
 return{registry,wrapper,card,badge,nested,doc,editor,get:()=>state,detach,close,change:(tr:typeof state.tr)=>{state=state.apply(tr)}}
}
test('copying a complete known business subtree creates fresh nested occurrences and removes source receipts',()=>{
 const f=fixture()
 try{
  const target=blockTarget(f.get())!,actions=blockActionStates(f.get(),target);assert.equal(targetBlockCount(f.get().doc,target),1);const roots=rootBlocks(f.get().doc);assert.equal(siblingBlockEntries(f.get().doc,roots[1]).length,3);const child={node:f.doc.child(1).child(0),from:roots[1].from+1,to:roots[1].from+1+f.doc.child(1).child(0).nodeSize};assert.equal(blockEntryScope(f.doc,child)?.instanceId,f.wrapper.instanceId);assert.equal(siblingBlockEntries(f.doc,child).length,3);assert.equal(actions['block.duplicate'].enabled,true);assert.equal(actions['block.delete'].enabled,true);assert.equal(actions['block.down'].enabled,true);for(const action of ['block.paragraph','block.heading','block.code','block.quote'])assert.equal(actions[action].enabled,false)
  const commit=prepareBlockTransaction(f.editor,'block.duplicate',undefined,target);assert.ok(commit);assert.equal(commit(),true);const original=f.get().doc.child(1),copied=f.get().doc.child(2),old=extensionNodes(schema.nodes.doc.createChecked(null,[original])),next=extensionNodes(schema.nodes.doc.createChecked(null,[copied]));assert.equal(next.size,4);assert.equal(new Set([...old.keys(),...next.keys()]).size,8)
  for(const [index,entry]of [...next.values()].entries()){const expected=[...old.values()][index].value;assert.deepEqual({...entry.value,instanceId:expected.instanceId},expected)}
  assert.notEqual([...documentReferences(schema.nodes.doc.createChecked(null,[original])).keys()][0],[...documentReferences(schema.nodes.doc.createChecked(null,[copied])).keys()][0]);assert.equal(copied.child(0).firstChild!.marks[0].type.name,'bold');assert.equal(copied.child(2).attrs.fallbackInline.nodeId,undefined);assert.equal(original.child(2).attrs.fallbackInline.nodeId,'n_'+'b'.repeat(32));assert.equal(copied.textContent,original.textContent);assert.equal(jsonToSnapshot(f.get().doc.toJSON()).length,4)
 }finally{f.close()}
})
test('copying a known block atom allocates a new identity while preserving readable fallback styling',()=>{
 const f=fixture()
 try{const state=EditorState.create({schema,doc:schema.nodes.doc.createChecked(null,[f.doc.child(1).child(2)])}),target=blockTarget(state)!,tr=state.tr;assert.equal(transformBlocks(tr,'block.duplicate',undefined,target,f.registry),true);assert.notEqual(tr.doc.child(0).attrs.extension.instanceId,tr.doc.child(1).attrs.extension.instanceId);assert.equal(tr.doc.child(1).attrs.fallbackInline.bold,true);assert.equal(tr.doc.child(1).attrs.fallbackInline.nodeId,undefined)}finally{f.close()}
})
test('unknown descendants and codec unload prevent whole-container actions and staged commits',()=>{
 const f=fixture()
 try{const target=blockTarget(f.get())!,commit=prepareBlockTransaction(f.editor,'block.duplicate',undefined,target);assert.ok(commit);f.detach();for(const id of ['block.duplicate','block.delete','block.down'])assert.equal(blockActionStates(f.get(),target)[id].enabled,false);assert.equal(commit(),false);assert.equal(f.get().doc.childCount,3)}finally{f.close()}
})
test('a codec unloaded on a crossed neighbor invalidates a staged move without mutating either block',()=>{
 const f=fixture()
 try{const state=EditorState.create({schema,doc:f.doc,plugins:[extensionPreservationPlugin(()=>{},()=>f.registry)]});let current=state;const editor={isDestroyed:false,isEditable:true,get state(){return current},view:{composing:false,dispatch(tr:typeof state.tr){current=current.apply(tr)},focus(){}}} as unknown as Editor,target=blockTarget(state,rootBlocks(state.doc).slice(0,1))!,commit=prepareBlockTransaction(editor,'block.down',undefined,target);assert.ok(commit);f.detach();assert.equal(commit(),false);assert.equal(current.doc,state.doc)}finally{f.close()}
})
for(const action of ['block.down','block.delete'])test(`whole-container ${action} with concurrent child typing retains peer edits through own undo`,()=>{
 const f=fixture(),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(f.doc);Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager()
 const reconcile=(store:SemanticBlockStore,doc:typeof f.doc)=>store.reconcile(store.blocks(),doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node}))),exchange=()=>{const aa=Y.encodeStateAsUpdate(a),bb=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bb);Y.applyUpdate(b,aa)}
 try{
  const state=EditorState.create({schema,doc:sa.project()}),target=blockTarget(state,rootBlocks(state.doc).slice(1,2))!,tr=state.tr;assert.equal(transformBlocks(tr,action,undefined,target,f.registry),true);undo.stopCapturing();reconcile(sa,tr.doc);undo.stopCapturing()
  const peer=EditorState.create({schema,doc:sb.project()});let at=-1;peer.doc.descendants((node,pos)=>{if(node.isTextblock&&node.textContent==='Nested content')at=pos+1+node.content.size});assert.ok(at>0);reconcile(sb,peer.tr.insertText(' peer retained',at).doc);exchange();assert.ok(sa.project().eq(sb.project()));if(action==='block.delete')assert.equal(extensionNodes(sa.project()).size,0);else assert.match(sa.project().textContent,/peer retained/)
  undo.undo();exchange();assert.ok(sa.project().eq(sb.project()));assert.equal(sa.project().child(1).attrs.extension.instanceId,f.wrapper.instanceId);assert.match(sa.project().textContent,/peer retained/);assert.equal(extensionNodes(sa.project()).size,4)
  if(action==='block.delete'){const before=Y.encodeStateAsUpdate(a);assert.throws(()=>undo.redo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(a),before)}else undo.redo()
  exchange();assert.ok(sa.project().eq(sb.project()))
 }finally{undo.destroy();a.destroy();b.destroy();f.close()}
})
