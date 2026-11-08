import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {blockTarget,rootBlocks,transformBlocks} from './commands/blocks.ts'
import {deletionReviews} from './deletionReview.ts'
import {structureSourceTargets,reconcileStructureSources} from './semanticStructureSources.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function wrap(store:SemanticBlockStore,command:string,text:string){
 const state=EditorState.create({schema,doc:store.project()}),tr=state.tr;assert.ok(transformBlocks(tr,command,undefined,blockTarget(state,rootBlocks(state.doc))!));store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
 const block=store.blocks()[0],key=['bulletList','orderedList'].includes(block.node.type.name)?store.projectedChildren(block.key,block.node)[0].key:block.key,before=store.content(key);store.update(key,before,before.copy(before.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,schema.text(text))))));return block.key
}
function slots(store:SemanticBlockStore){return store.blocks().flatMap(block=>['bulletList','orderedList'].includes(block.node.type.name)?store.projectedChildren(block.key,block.node):[block])}
for(const kind of ['block.bulletList','block.orderedList'])for(const higher of ['alice','bob'])for(const reverse of [false,true])test(`concurrent quote/${kind} keeps both additions with unique canonical slots: higher=${higher}, reverse=${reverse}`,()=>{
 const a=new Y.Doc(),b=new Y.Doc();a.clientID=higher==='alice'?202:101;b.clientID=higher==='bob'?202:101;const sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{hcdBlockId:'original'},content:[{type:'text',text:'Original'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));wrap(sa,'block.quote','Alice addition');wrap(sb,kind,'Bob addition');const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b)
 try{
  if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}
  const before=Y.encodeStateAsUpdate(a),projected=sa.project(),visible=slots(sa);for(const value of ['Original','Alice addition','Bob addition'])assert.equal(projected.textContent.match(new RegExp(value,'g'))?.length,1)
  assert.deepEqual(projected.toJSON(),sb.project().toJSON());assert.equal(new Set(visible.map(slot=>slot.node.attrs.hcdCanonicalKey)).size,visible.length);assert.equal(visible.find(slot=>slot.node.textContent.includes('Original'))!.node.attrs.hcdBlockId,'original');assert.equal(structureSourceTargets(sa).length,jsonToSnapshot(projected.toJSON()).length);assert.deepEqual(Y.encodeStateAsUpdate(a),before)
  const fresh=new Y.Doc();try{Y.applyUpdate(fresh,before);assert.deepEqual(new SemanticBlockStore(fresh,schema).project().toJSON(),projected.toJSON())}finally{fresh.destroy()}
  // An ordinary edit may persist the resolved owner before the first source
  // receipt. It must not borrow the old hcdBlockId stored on that wrapper.
  const branch=visible.find(slot=>!slot.node.textContent.includes('Original'))!,branchOwner=branch.node.attrs.hcdCanonicalKey,branchId=branch.node.attrs.hcdBlockId,prior=sa.content(branch.key);sa.update(branch.key,prior,prior.copy(prior.content.append(Fragment.from(schema.nodes.paragraph.createChecked(null,schema.text(' Continued'))))));assert.equal(sa.content(branch.key).attrs.hcdCanonicalKey,branchOwner);assert.equal(sa.content(branch.key).attrs.hcdBlockId,branchId);assert.equal(new Set(slots(sa).map(slot=>slot.node.attrs.hcdBlockId)).size,2)
  const captured=structureSourceTargets(sa),canonical=jsonToSnapshot(sa.project().toJSON()).map((block,index)=>({blockId:`saved-${index}`,blockHash:'hash',region:'body',readOnly:false,content:block.content}));reconcileStructureSources(sa,captured,canonical,'canonical-receipt');Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual(sa.project().toJSON(),sb.project().toJSON());assert.equal(new Set(slots(sa).map(slot=>slot.node.attrs.hcdBlockId)).size,2);assert.equal(sa.content(branch.key).attrs.hcdCanonicalKey,branchOwner);assert.match(sa.content(branch.key).attrs.hcdBlockId,/^saved-/)
 }finally{a.destroy();b.destroy()}
})

test('projection cache invalidates on delete-only remote changes and bypasses active transactions',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Initial'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const peer=new SemanticBlockStore(b,schema),key=store.keys()[0];assert.equal(store.project().textContent,'Initial');const text=peer.contents.get(key)!.get(0) as Y.XmlText;text.delete(0,1);Y.applyUpdate(a,Y.encodeStateAsUpdate(b));assert.equal(store.project().textContent,'nitial')
 const own=store.contents.get(key)!.get(0) as Y.XmlText;a.transact(()=>{own.insert(0,'A');assert.equal(store.project().textContent,'Anitial');own.insert(0,'B');assert.equal(store.project().textContent,'BAnitial')});assert.equal(store.project().textContent,'BAnitial');a.destroy();b.destroy()
})

for(const higher of ['alice','bob'])test(`own wrapper undo after concurrent conversion retains all peer content: higher=${higher}`,()=>{
 const a=new Y.Doc(),b=new Y.Doc();a.clientID=higher==='alice'?202:101;b.clientID=higher==='bob'?202:101;const sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',attrs:{hcdBlockId:'original'},content:[{type:'text',text:'Original'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const original=sa.keys()[0],undo=sa.undoManager();wrap(sa,'block.quote','Alice addition');undo.stopCapturing();wrap(sb,'block.bulletList','Bob addition');const bobPlacement=structuredClone(sb.placement.get(original));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 try{for(let round=0;round<3;round++){assert.ok(undo.undo());assert.deepEqual(sa.placement.get(original),bobPlacement);assert.equal(undo.undoStack.length,0);assert.equal(undo.redoStack.length,1);assert.match(sa.project().textContent,/Original/);assert.match(sa.project().textContent,/Bob addition/);assert.doesNotMatch(sa.project().textContent,/Alice addition/);assert.equal(deletionReviews(sa).length,0);assert.ok(undo.redo());for(const text of ['Original','Alice addition','Bob addition'])assert.equal(sa.project().textContent.match(new RegExp(text,'g'))?.length,1);assert.equal(undo.undoStack.length,1);assert.equal(undo.redoStack.length,0)}}finally{undo.destroy();a.destroy();b.destroy()}
})
