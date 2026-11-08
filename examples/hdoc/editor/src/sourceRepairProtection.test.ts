import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot} from './schema.ts'
import {extensionPreservationPlugin,extensionNodes} from './extensionNode.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),id=(n:number)=>'n_'+String(n).repeat(32),payload={schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.future',version:77,display:'block',contentModel:'blocks',data:{unavailable:['retain',42]},fallback:{text:'Unknown'}}
const document=()=>schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{hcdBlockId:id(1),extension:payload},content:[{type:'paragraph',attrs:{hcdSourceId:id(2)},content:[{type:'text',text:'Protected text'}]}]},{type:'paragraph',attrs:{hcdBlockId:id(3),hcdSourceId:id(4)},content:[{type:'text',text:'Outside'}]}]})
test('source repair across an unknown container does not leave unrelated typing without its canonical identity',()=>{
 const doc=document(),state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(),sourceIdentityPlugin()]}),after=state.applyTransaction(state.tr.insertText(' typed',doc.content.size-1))
 assert.equal(after.transactions.length,2);assert.equal(after.transactions[1].getMeta('hcd-source-defaults'),true);const snapshot=jsonToSnapshot(after.state.doc.toJSON());assert.deepEqual(snapshot[0].content.extension,payload);assert.equal(snapshot[0].content.children![0].inlines[0].nodeId,id(2));assert.equal(snapshot[1].content.inlines[0].nodeId,id(4));assert.equal(snapshot[1].content.inlines.map(part=>part.text).join(''),'Outside typed')
})
test('a source-repair marker cannot authorize unknown text, formatting or business changes',()=>{
 const doc=document(),state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin()]})
 for(const change of [state.tr.insertText('damage',2),state.tr.addMark(2,3,schema.marks.bold.create()),state.tr.setNodeMarkup(0,undefined,{...doc.firstChild!.attrs,extension:{...payload,data:{changed:true}}})]){const after=state.apply(change.setMeta('hcd-source-defaults',true));assert.equal(after.doc,doc)}
})
test('ordinary local source-mark edits on unknown content still require the core repair transaction',()=>{
 const doc=document(),state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin()]});assert.equal(state.apply(state.tr.addMark(2,3,schema.marks.hcdSource.create({nodeId:id(2)}))).doc,doc)
})
test('undo of unrelated typing plus global source repair preserves unknown text and business payload',()=>{
 const seed=new Y.Doc(),source=new SemanticBlockStore(seed,schema);source.initialize(document());const a=new Y.Doc();Y.applyUpdate(a,Y.encodeStateAsUpdate(seed));const store=new SemanticBlockStore(a,schema),undo=store.undoManager(true,before=>prepareExtensionHistoryGuard(before)),doc=store.project(),state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin(),sourceIdentityPlugin()]}),after=state.applyTransaction(state.tr.insertText(' local',doc.content.size-1)).state.doc
 try{store.reconcile(store.blocks(),after.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));assert.ok(undo.undo());assert.equal(store.project().lastChild!.textContent,'Outside');assert.equal(store.project().firstChild!.textContent,'Protected text');assert.deepEqual([...extensionNodes(store.project()).values()][0].value,payload)}finally{undo.destroy();a.destroy();seed.destroy()}
})
