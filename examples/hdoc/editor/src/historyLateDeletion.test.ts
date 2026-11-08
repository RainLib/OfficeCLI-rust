import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {blockTarget,rootBlocks,transformBlocks} from './commands/blocks.ts'
import {Fragment} from '@tiptap/pm/model'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {structureSourceTargets} from './semanticStructureSources.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes} from './extensionNode.ts'
import {documentReferences} from './referenceEdits.ts'
import {deletionReviewField,deletionReviews,resolveDeletionReview} from './deletionReview.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function fixture(){
 const registry=new NodeExtensionRegistry([{type:'example.history_notes',display:'block',contentModel:'blocks',version:1,label:'Notes',defaultData:{title:'Team'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}]),a=new Y.Doc(),sa=new SemanticBlockStore(a,schema),b=new Y.Doc(),sb=new SemanticBlockStore(b,schema)
 const resource={key:'notes',hash:'a'.repeat(64),byteLength:5,name:'notes.bin',mediaType:'application/octet-stream'},value=registry.create('example.history_notes',undefined,[resource])
 sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Outside'}]},{type:'hcdExtensionContainer',attrs:{extension:value},content:[{type:'paragraph',content:[{type:'text',text:'Initial'}]},{type:'hcdExtensionContainer',attrs:{extension:registry.create('example.history_notes',{title:'Nested'})},content:[{type:'paragraph',content:[{type:'hcdMention',attrs:{reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}}}}]}]}]}]}))
 const undo=sa.undoManager();undo.stopCapturing();const clone=sa.duplicate([sa.keys()[1]],null)[0];undo.stopCapturing();Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 const edit=()=>{const key=sb.childKeys(clone)[0],before=sb.content(key);sb.update(key,before,before.copy(before.content.append(Fragment.from(schema.text(' late Bob')))))}
 return{a,b,sa,sb,undo,clone,resource,edit,close(){undo.destroy();a.destroy();b.destroy()}}
}
test('creation undo preserves a hidden permanent subtree and late offline text reopens deletion review',()=>{
 const f=fixture();try{
  const visible=f.sa.project(),ids=[...extensionNodes(visible).keys()],refs=[...documentReferences(visible).keys()]
  assert.ok(f.undo.undo());assert.equal(deletionReviews(f.sa).length,0);f.edit();Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));assert.doesNotMatch(f.sa.project().textContent,/late Bob/)
  const groups=deletionReviews(f.sa);assert.equal(groups.length,1);assert.equal(groups[0].key,f.clone);assert.match(groups[0].node.textContent,/late Bob/)
  resolveDeletionReview(f.sa,groups[0],'restore');assert.deepEqual([...extensionNodes(f.sa.project()).keys()],ids);assert.deepEqual([...documentReferences(f.sa.project()).keys()],refs);assert.deepEqual(f.sa.content(f.clone).attrs.extension.resources,[f.resource]);assert.match(f.sa.project().textContent,/late Bob/)
 }finally{f.close()}
})
test('untouched creation undo and redo keep exact identities and do not duplicate ordered references',()=>{
 const f=fixture();try{const expected=f.sa.project().toJSON();for(let n=0;n<5;n++){assert.ok(f.undo.undo());assert.equal(f.undo.undoStack.length,0);assert.equal(f.undo.redoStack.length,1);assert.equal(deletionReviews(f.sa).length,0);assert.ok(f.undo.redo());assert.deepEqual(f.sa.project().toJSON(),expected);assert.equal(f.undo.undoStack.length,1);assert.equal(f.undo.redoStack.length,0)}assert.ok(f.a.getMap(deletionReviewField).size<=1)}finally{f.close()}
})
test('an undone creation remains recoverable after serializing Yjs without any window history',()=>{
 const f=fixture();try{f.undo.undo();f.edit();Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));const fresh=new Y.Doc();try{Y.applyUpdate(fresh,Y.encodeStateAsUpdate(f.a));const store=new SemanticBlockStore(fresh,schema),group=deletionReviews(store)[0];assert.ok(group);resolveDeletionReview(store,group,'restore');assert.match(store.project().textContent,/late Bob/);assert.equal(store.content(f.clone).childCount,2)}finally{fresh.destroy()}}finally{f.close()}
})
test('redo can reveal late edits, but a subsequent undo cannot silently hide the newly received peer content',()=>{
 const f=fixture();try{f.undo.undo();f.edit();Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));assert.equal(deletionReviews(f.sa).length,1);assert.ok(f.undo.redo());assert.match(f.sa.project().textContent,/late Bob/);const before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.undo.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before)}finally{f.close()}
})


test('a newly inserted plain block keeps late formatting after creation undo',()=>{
 const a=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Original'}]}]}));const undo=store.undoManager(),key=store.insert([schema.nodes.paragraph.createChecked(null,schema.text('New'))],null)[0],b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const peer=new SemanticBlockStore(b,schema)
 try{undo.stopCapturing();undo.undo();const before=peer.content(key);peer.update(key,before,before.copy(Fragment.from(schema.text('New bold',[schema.marks.bold.create()]))));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));const group=deletionReviews(store)[0];assert.ok(group.node.firstChild!.marks.some(mark=>mark.type.name==='bold'));resolveDeletionReview(store,group,'restore');assert.match(store.project().textContent,/New bold/)}finally{undo.destroy();a.destroy();b.destroy()}
})
test('one inverse preserves multiple copied roots without changing unrelated moved order',()=>{
 const a=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodeFromJSON({type:'doc',content:['A','B','C'].map(text=>({type:'paragraph',content:[{type:'text',text}]}))}));const undo=store.undoManager(),original=store.keys(),copies=store.duplicate(original.slice(0,2),null);store.move([original[2]],original[0]);undo.stopCapturing()
 try{undo.undo();assert.deepEqual(store.blocks().map(block=>block.node.textContent),['A','B','C']);assert.equal(deletionReviews(store).length,0);assert.equal(a.getMap(deletionReviewField).size,2);undo.redo();assert.deepEqual(store.blocks().map(block=>block.node.textContent),['C','A','B','A','B']);assert.ok(copies.every(key=>store.keys().includes(key)))}finally{undo.destroy();a.destroy()}
})
test('an undone wrapper can recover a late new child without sharing the unwrapped paragraph canonical owner',()=>{
 const a=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{hcdBlockId:'original'},content:[{type:'text',text:'Original'}]}]}));const undo=store.undoManager(),state=EditorState.create({schema,doc:store.project()}),tr=state.tr,target=blockTarget(state,rootBlocks(state.doc))!;assert.ok(transformBlocks(tr,'block.quote',undefined,target));store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));undo.stopCapturing();const wrapper=store.keys()[0],b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const peer=new SemanticBlockStore(b,schema)
 try{undo.undo();assert.equal(store.project().firstChild!.type.name,'paragraph');const before=peer.content(wrapper);peer.update(wrapper,before,before.copy(before.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,schema.text('New offline child'))))));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));const group=deletionReviews(store)[0];assert.equal(group.node.textContent,'New offline child');resolveDeletionReview(store,group,'restore');assert.equal(store.blocks().length,2);assert.equal(store.project().textContent.match(/Original/g)?.length,1);assert.equal(store.project().textContent.match(/New offline child/g)?.length,1);assert.equal(new Set(store.blocks().map(block=>store.owners.get(block.key))).size,2)}finally{undo.destroy();a.destroy();b.destroy()}
})

for(const kind of ['bulletList','orderedList'])test(`a restored ${kind} excludes its pruned old item from canonical save targets`,()=>{
 const a=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{hcdBlockId:'original'},content:[{type:'text',text:'Original'}]}]}));const undo=store.undoManager(),state=EditorState.create({schema,doc:store.project()}),tr=state.tr,target=blockTarget(state,rootBlocks(state.doc))!;assert.ok(transformBlocks(tr,kind==='bulletList'?'block.bulletList':'block.orderedList',undefined,target));store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));undo.stopCapturing();const wrapper=store.keys()[0],oldItem=store.childKeys(wrapper)[0],b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const peer=new SemanticBlockStore(b,schema)
 try{
  undo.undo();const before=peer.content(wrapper),newItem=schema.nodes.listItem.createChecked(null,[schema.nodes.paragraph.createChecked(null,schema.text('New offline item'))]);peer.update(wrapper,before,before.copy(before.content.append(Fragment.from(newItem))));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));const group=deletionReviews(store)[0];assert.equal(group.node.childCount,1);assert.equal(group.node.textContent,'New offline item');resolveDeletionReview(store,group,'restore')
  const projected=store.project(),snapshot=jsonToSnapshot(projected.toJSON()),targets=structureSourceTargets(store);assert.equal(snapshot.length,2);assert.equal(targets.length,snapshot.length);assert.ok(targets.every(entry=>!('key'in entry)||entry.key!==oldItem));assert.equal(store.childKeys(wrapper).length,2);assert.equal(store.visibility.get(oldItem),true);assert.equal(projected.textContent.match(/Original/g)?.length,1);assert.equal(projected.textContent.match(/New offline item/g)?.length,1)
 }finally{undo.destroy();a.destroy();b.destroy()}
})
