import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {schemaExtensions,sourceIdentityPlugin} from './schema.ts'
import {semanticUndoManager} from './semanticHistory.ts'
const schema=getSchema(schemaExtensions),id='n_'+'1'.repeat(32)
function state(){return EditorState.create({schema,plugins:[sourceIdentityPlugin()],doc:schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{hcdBlockId:'block',hcdSourceId:id},content:[{type:'text',text:'Original',marks:[{type:'hcdSource',attrs:{nodeId:id}}]}]}]})})}
for(const undo of [false,true])test(`source repair after ${undo?'undo':'remote sync'} is excluded from user history`,()=>{
 const before=state(),result=before.applyTransaction(before.tr.removeMark(1,9,schema.marks.hcdSource).setMeta(ySyncPluginKey,{isChangeOrigin:true,isUndoRedoOperation:undo}))
 assert.equal(result.transactions.length,2);assert.equal(result.transactions[1].getMeta('addToHistory'),false)
 assert.equal(result.state.doc.firstChild?.firstChild?.marks.find(mark=>mark.type===schema.marks.hcdSource)?.attrs.nodeId,id)
})
test('source defaults added to ordinary typing stay in the user transaction',()=>{
 const before=state(),result=before.applyTransaction(before.tr.insert(1,schema.text('Own ')))
 assert.equal(result.transactions.length,2);assert.notEqual(result.transactions[1].getMeta('addToHistory'),false)
})
test('the production undo manager ignores system repair without clearing redo',()=>{
 const doc=new Y.Doc(),fragment=doc.getXmlFragment('default'),manager=semanticUndoManager(doc)
 try{
  doc.transact(()=>fragment.insert(0,[new Y.XmlElement('paragraph')]),ySyncPluginKey)
  manager.undo();assert.equal(manager.canRedo(),true)
  doc.transact(transaction=>{transaction.meta.set('addToHistory',false);fragment.insert(0,[new Y.XmlElement('paragraph')])},ySyncPluginKey)
  assert.equal(manager.canRedo(),true);assert.equal(manager.canUndo(),false)
 }finally{manager.destroy();doc.destroy()}
})
