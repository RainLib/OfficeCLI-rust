import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions,sourceIdentityPlugin} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {deletionReviews,canConfirmDeletion,deletionReviewField,resolveDeletionReview,validateDeletionReceipts} from './deletionReview.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function fixture(){
 const seed=new Y.Doc(),initial=new SemanticBlockStore(seed,schema),p=(text:string)=>schema.nodes.paragraph.createChecked(null,schema.text(text))
 initial.initialize(schema.nodes.doc.createChecked(null,[p('Target'),p('Keep')]));const a=new Y.Doc(),b=new Y.Doc();Y.applyUpdate(a,Y.encodeStateAsUpdate(seed));Y.applyUpdate(b,Y.encodeStateAsUpdate(seed));const sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),[key]=sa.keys()
 const type=(store:SemanticBlockStore,text:string)=>{const doc=store.project(),state=EditorState.create({schema,doc,plugins:[sourceIdentityPlugin()]}),next=state.applyTransaction(state.tr.insertText(text,doc.firstChild!.nodeSize-1)).state.doc;store.reconcile(store.blocks(),next.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 const sync=()=>{Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))},close=()=>[seed,a,b].forEach(doc=>doc.destroy())
 return{a,b,sa,sb,key,type,sync,close,p}
}
test('late offline input into a deleted block reopens review on both peers; restore keeps latest content',()=>{
 const f=fixture();try{f.sa.remove([f.key]);assert.equal(deletionReviews(f.sa).length,0);f.type(f.sb,' Bob');f.sync();assert.equal(f.sa.project().textContent,'Keep');assert.equal(deletionReviews(f.sa).length,1);assert.match(deletionReviews(f.sa)[0].node.textContent,/Target Bob/);resolveDeletionReview(f.sa,deletionReviews(f.sa)[0],'restore');f.sync();assert.equal(f.sa.project().textContent,'Target BobKeep');assert.equal(f.sb.project().textContent,f.sa.project().textContent);assert.equal(deletionReviews(f.sa).length,0)}finally{f.close()}
})
test('keep deleted acknowledges only the exact reviewed content; later input reopens and stale review cannot commit',()=>{
 const f=fixture(),offline=new Y.Doc();Y.applyUpdate(offline,Y.encodeStateAsUpdate(f.b));const late=new SemanticBlockStore(offline,schema)
 try{
  f.sa.remove([f.key]);f.type(f.sb,' Bob');f.sync();const old=deletionReviews(f.sa)[0]
  resolveDeletionReview(f.sa,old,'delete');assert.equal(f.sa.visibility.get(f.key),false);assert.equal(deletionReviews(f.sa).length,0)
  f.type(late,' later');Y.applyUpdate(f.a,Y.encodeStateAsUpdate(offline));f.sync();assert.equal(deletionReviews(f.sa).length,1)
  const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveDeletionReview(f.sa,old,'delete'),/changed/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.match(deletionReviews(f.sa)[0].node.textContent,/later/)
 }finally{offline.destroy();f.close()}
})
test('concurrent restoration wins over keep-deleted without a re-hide write',()=>{
 const f=fixture();try{f.sa.remove([f.key]);f.type(f.sb,' Bob');f.sync();const a=deletionReviews(f.sa)[0],b=deletionReviews(f.sb)[0];resolveDeletionReview(f.sa,a,'delete');resolveDeletionReview(f.sb,b,'restore');f.sync();assert.equal(f.sa.visibility.get(f.key),true);assert.equal(f.sb.visibility.get(f.key),true);assert.equal(deletionReviews(f.sa).length,0)}finally{f.close()}
})
test('peer removal of characters or formatting also requires review, while canonical source receipts do not',()=>{
 const f=fixture();try{f.sa.remove([f.key]);const before=f.sb.content(f.key);f.sb.update(f.key,before,before.copy(schema.nodes.paragraph.createChecked(null,schema.text('Targe')).content));f.sync();assert.equal(deletionReviews(f.sa).length,1);resolveDeletionReview(f.sa,deletionReviews(f.sa)[0],'delete');f.a.transact(()=>f.sa.attributes.get(f.key)!.set('hcdSourceId','receipt'));assert.equal(deletionReviews(f.sa).length,0);const content=f.sa.contents.get(f.key)!.get(0) as Y.XmlText;f.a.transact(()=>content.format(0,1,{bold:{}}));assert.equal(deletionReviews(f.sa).length,1)}finally{f.close()}
})
test('deletion review survives persistent Yjs reload and deleting undo/redo retains its baseline',()=>{
 const f=fixture();try{const undo=f.sa.undoManager();f.sa.remove([f.key]);undo.stopCapturing();undo.undo();assert.equal(f.sa.visibility.get(f.key),true);undo.redo();f.type(f.sb,' Bob');f.sync();const copy=new Y.Doc();Y.applyUpdate(copy,Y.encodeStateAsUpdate(f.a));assert.equal(deletionReviews(new SemanticBlockStore(copy,schema)).length,1);copy.destroy();undo.destroy()}finally{f.close()}
})
test('old hidden blocks without receipts require review and empty placeholder never does',()=>{
 const f=fixture();try{f.a.transact(()=>f.sa.visibility.set(f.key,false));const groups=deletionReviews(f.sa);assert.equal(groups.length,1);assert.equal(groups[0].receipt,null);resolveDeletionReview(f.sa,groups[0],'delete');assert.equal(deletionReviews(f.sa).length,0)}finally{f.close()}
})
test('invalid review records are rejected before a shared room admits the update',()=>{
 const f=fixture(),guard=new RoomProtocolGuard(f.a,structuralProtocol);try{f.b.getMap(deletionReviewField).set(f.key,{version:77});assert.throws(()=>validateDeletionReceipts(f.b),/schema/);const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(f.b)),/schema/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)}finally{guard.destroy();f.close()}
})


test('deleted rich container detects business-only root changes and new child blocks and retains resource identity on restoration',()=>{
 const registry=new NodeExtensionRegistry([{type:'example.rich',version:1,display:'block',contentModel:'blocks',label:'Rich',defaultData:{title:'Old'},validate:d=>typeof d.title==='string',fallback:()=> 'Constant title'}]),resource={key:'attachment',hash:'a'.repeat(64),byteLength:3,name:'notes.bin',mediaType:'application/octet-stream'},payload=registry.create('example.rich',undefined,[resource]),a=new Y.Doc(),sa=new SemanticBlockStore(a,schema),b=new Y.Doc(),sb=new SemanticBlockStore(b,schema)
 sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{extension:payload},content:[{type:'paragraph',content:[{type:'text',text:'Child'}]}]},{type:'paragraph',content:[{type:'text',text:'Outside'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const key=sa.keys()[0]
 try{
  sa.remove([key]);const doc=sb.project(),next=doc.child(0).type.createChecked({...doc.child(0).attrs,extension:registry.update(payload,{title:'Changed with same fallback'})},[...doc.child(0).content.content,schema.nodes.paragraph.createChecked(null,schema.text('New child'))]);sb.reconcile(sb.blocks(),[{key,node:next},sb.blocks()[1]])
  Y.applyUpdate(a,Y.encodeStateAsUpdate(b));const group=deletionReviews(sa)[0];assert.equal(group.node.attrs.extension.data.title,'Changed with same fallback');assert.match(group.node.textContent,/New child/);resolveDeletionReview(sa,group,'restore');assert.deepEqual(sa.project().child(0).attrs.extension.resources,[resource]);assert.equal(sa.project().child(0).attrs.extension.instanceId,payload.instanceId)
 }finally{a.destroy();b.destroy()}
})
test('a large local deletion fails before changing shared bytes, while oversized late content can always be restored',()=>{
 const f=fixture();try{const node=f.sa.content(f.key),large=node.copy(schema.nodes.paragraph.createChecked(null,schema.text('x'.repeat(1_050_000))).content);f.sa.update(f.key,node,large);const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.sa.remove([f.key]),/limit/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
  f.a.transact(()=>f.sa.visibility.set(f.key,false));const group=deletionReviews(f.sa)[0];assert.ok(group.snapshot.length>1_048_576);resolveDeletionReview(f.sa,group,'restore');assert.equal(f.sa.visibility.get(f.key),true)
 }finally{f.close()}
})


test('an unloaded ancestor codec blocks confirming deletion of a plain child but never blocks restoration',()=>{
 const registry=new NodeExtensionRegistry(),value={schemaVersion:'hcd.extension/2',instanceId:'x_'+'b'.repeat(32),type:'example.outer',version:1,display:'block',contentModel:'blocks',data:{},fallback:{text:'Outer'}},doc=new Y.Doc(),store=new SemanticBlockStore(doc,schema)
 store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{extension:value},content:[{type:'paragraph',content:[{type:'text',text:'First'}]},{type:'paragraph',content:[{type:'text',text:'Second'}]}]}]}))
 try{const root=store.project().child(0),first=root.child(0),second=root.child(1),before=store.blocks();store.reconcile(before,[{key:before[0].key,node:root.copy(root.content.replaceChild(0,second).cut(0,second.nodeSize))}],{deletedKeys:[first.attrs.hcdStructureKey]});const key=first.attrs.hcdStructureKey;doc.transact(()=>{const text=store.contents.get(key)!.get(0) as Y.XmlText;text.insert(text.length,' late')});const group=deletionReviews(store)[0];assert.equal(canConfirmDeletion(store,group,registry),false);resolveDeletionReview(store,group,'restore');assert.match(store.project().textContent,/late/)}finally{doc.destroy()}
})
