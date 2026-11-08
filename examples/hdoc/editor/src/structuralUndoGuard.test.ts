import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes} from './extensionNode.ts'
import {documentReferences} from './referenceEdits.ts'
import {SemanticHistory} from './semanticHistory.ts'
import {CollaborativeImageDraftStore} from './collaborativeImages.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function fixture(guarded=true){
 const registry=new NodeExtensionRegistry([{type:'example.notes',version:1,display:'block',contentModel:'blocks',label:'Notes',defaultData:{title:'Notes'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)},{type:'example.badge',version:1,display:'inline',label:'Badge',defaultData:{title:'Badge'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}]),seed=new Y.Doc(),source=new SemanticBlockStore(seed,schema),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
 source.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Outside'}]},{type:'hcdExtensionContainer',attrs:{extension:registry.create('example.notes')},content:[{type:'paragraph',content:[{type:'text',text:'Initial text '},{type:'hcdExtensionInline',attrs:{extension:registry.create('example.badge')}},{type:'hcdMention',attrs:{reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}}}}]}]}]}));Y.applyUpdate(a,Y.encodeStateAsUpdate(seed));Y.applyUpdate(b,Y.encodeStateAsUpdate(seed));const undo=sa.undoManager(guarded)
 const sync=()=>{const aa=Y.encodeStateAsUpdate(a),bb=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bb);Y.applyUpdate(b,aa)}
 let clone='';const copy=()=>{undo.stopCapturing();clone=sa.duplicate([sa.keys()[1]],null)[0];undo.stopCapturing();sync();return clone}
 const peer=(kind:string)=>{const key=sb.childKeys(clone)[0],before=sb.content(key);let next=before
  if(kind==='text')next=before.copy(before.content.append(Fragment.from(schema.text(' peer text'))))
  if(kind==='format')next=before.copy(Fragment.fromArray(before.content.content.map((node,index)=>index===0?node.mark([schema.marks.bold.create()]):node)))
  if(kind==='heading')next=schema.nodes.heading.createChecked({...before.attrs,level:2},before.content)
  if(kind==='property')next=before.copy(Fragment.fromArray(before.content.content.map(node=>node.type.name==='hcdExtensionInline'?node.type.createChecked({...node.attrs,extension:registry.update(node.attrs.extension,{title:'Peer badge'})},null,node.marks):node)))
  if(kind==='reference')next=before.copy(Fragment.fromArray(before.content.content.map(node=>node.type.name==='hcdMention'?node.type.createChecked({...node.attrs,reference:{...node.attrs.reference,target:{kind:'person',id:'bob'},snapshot:{label:'Bob'}}},null,node.marks):node)))
  if(kind==='child'){const wrapper=sb.content(clone);sb.update(clone,wrapper,wrapper.copy(wrapper.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,[schema.text('New peer child')])))))}
  else if(kind==='source'){const part=sb.flow.parts(key)[0],text=sb.contents.get(part.carrier)!.get(0) as Y.XmlText;b.transact(()=>{text.format(part.from,part.to-part.from,{hcdSource:{nodeId:'n_'+'b'.repeat(32)}});sb.attributes.get(key)!.set('hcdSourceId','n_'+'b'.repeat(32));sb.attributes.get(key)!.set('hcdSourceTypography',{fontFamily:'Arial'})},{})}
  else sb.update(key,before,next)
  sync()
 }
 return{a,b,sa,sb,undo,registry,sync,copy,peer,get clone(){return clone},close(){undo.destroy();a.destroy();b.destroy();seed.destroy()}}
}
test('raw Yjs creation undo hides a peer-edited copied subtree, establishing the missing review boundary',()=>{
 const f=fixture(false)
 try{f.copy();f.peer('text');assert.match(f.sa.project().textContent,/peer text/);f.undo.undo();assert.doesNotMatch(f.sa.project().textContent,/peer text/)}finally{f.close()}
})
for(const kind of ['text','format','heading','property','reference','child'])test(`guarded copy undo preserves foreign ${kind} and the original history item`,()=>{
 const f=fixture()
 try{f.copy();f.peer(kind);const before=Y.encodeStateAsUpdate(f.a),item=f.undo.undoStack.at(-1);assert.throws(()=>f.undo.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.equal(f.undo.undoStack.at(-1),item);assert.equal(f.undo.redoStack.length,0);assert.ok(f.sa.project().eq(f.sb.project()))}finally{f.close()}
})
test('untouched copies still undo/redo, and source-binding receipts do not masquerade as peer content',()=>{
 const f=fixture()
 try{f.copy();const ids=[...extensionNodes(f.sa.project()).keys()],refs=[...documentReferences(f.sa.project()).keys()];f.peer('source');assert.ok(f.undo.undo());f.sync();assert.equal(extensionNodes(f.sa.project()).size,2);assert.ok(f.undo.redo());f.sync();assert.deepEqual([...extensionNodes(f.sa.project()).keys()],ids);assert.deepEqual([...documentReferences(f.sa.project()).keys()],refs);assert.ok(f.sa.project().eq(f.sb.project()))}finally{f.close()}
})
test('redo of an explicit deletion is allowed for reviewed content, but later peer text requires a new review',()=>{
 for(const laterPeer of [false,true]){const f=fixture();try{f.copy();const before=f.sb.content(f.sb.childKeys(f.clone)[0]);f.undo.stopCapturing();f.sa.remove([f.clone]);f.undo.stopCapturing();if(laterPeer){const key=f.sb.childKeys(f.clone)[0];f.sb.update(key,before,before.copy(before.content.append(Fragment.from(schema.text(' late peer')))))}f.sync();assert.ok(f.undo.undo());f.sync();if(laterPeer){const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.undo.redo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.match(f.sa.project().textContent,/late peer/)}else{assert.ok(f.undo.redo());f.sync();assert.equal(extensionNodes(f.sa.project()).size,2)}}finally{f.close()}}
})
test('history review can skip only the exact current text action without touching content or older chronology',async()=>{
 const f=fixture(),images=new CollaborativeImageDraftStore(f.a),history=new SemanticHistory(images,f.undo,()=>false,async()=>{throw new Error('no image read')});const disconnect=history.connect()
 try{const first=f.sa.keys()[0],outside=f.sa.content(first);f.sa.update(first,outside,outside.copy(Fragment.from(schema.text('Outside own change'))));history.stopCapturing();f.copy();f.peer('text');await assert.rejects(history.step('undo'),/historyPeerChanges/);const before=Y.encodeStateAsUpdate(f.a),version=history.snapshot();assert.throws(()=>history.skip('undo',version-1),/historyChanged/);history.skip('undo',version);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.equal(history.canUndo,true);await history.step('undo');f.sync();assert.equal(f.sa.project().firstChild!.textContent,'Outside');assert.match(f.sa.project().textContent,/peer text/);assert.ok(f.sa.project().eq(f.sb.project()))}finally{disconnect();f.close()}
})
test('skipping a reviewed redo preserves the opposite undo branch and cannot authorize a different structural action',async()=>{
 const f=fixture(),images=new CollaborativeImageDraftStore(f.a),history=new SemanticHistory(images,f.undo,()=>false,async()=>{throw new Error('no image read')}),disconnect=history.connect()
 try{f.copy();history.stopCapturing();f.sa.remove([f.clone]);history.stopCapturing();f.peer('text');await history.step('undo');f.sync();assert.match(f.sa.project().textContent,/peer text/);await assert.rejects(history.step('redo'),/historyPeerChanges/);const before=Y.encodeStateAsUpdate(f.a);history.skip('redo',history.snapshot());assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.equal(history.canRedo,false);assert.equal(history.canUndo,true);await assert.rejects(history.step('undo'),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before)}finally{disconnect();f.close()}
})
test('older creation history follows local redone identities through repeated deletion undo and redo',()=>{
 const f=fixture()
 try{f.copy();const ids=[...extensionNodes(f.sa.project()).keys()];f.undo.stopCapturing();f.sa.remove([f.clone]);f.undo.stopCapturing();assert.ok(f.undo.undo());assert.deepEqual([...extensionNodes(f.sa.project()).keys()],ids);assert.ok(f.undo.undo());assert.equal(extensionNodes(f.sa.project()).size,2);assert.ok(f.undo.redo());assert.deepEqual([...extensionNodes(f.sa.project()).keys()],ids);assert.ok(f.undo.redo());assert.equal(extensionNodes(f.sa.project()).size,2)}finally{f.close()}
})
