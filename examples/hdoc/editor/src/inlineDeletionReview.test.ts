import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {deletionReviews,resolveDeletionReview,canConfirmDeletion} from './deletionReview.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'

const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function fixture(kind:'node'|'mention',withAtom=true){
 const registry=new NodeExtensionRegistry([{type:'example.inline',version:1,display:'inline',label:'Inline',defaultData:{title:'Old'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}]),payload=registry.create('example.inline'),reference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}},atom=kind==='node'?schema.nodes.hcdExtensionInline.createChecked({extension:payload}):schema.nodes.hcdMention.createChecked({reference}),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
 sa.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,withAtom?[schema.text('Before '),atom,schema.text(' after')]:schema.text('Before  after'))]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const key=sa.keys()[0]
 const remove=()=>{const node=sa.content(key);sa.update(key,node,node.copy(Fragment.fromArray([schema.text('Before '),schema.text(' after')])))}
 const edit=(store:SemanticBlockStore,label:string)=>{const node=store.content(key),child=node.child(1),next=kind==='node'?child.type.createChecked({...child.attrs,extension:registry.update(child.attrs.extension,{title:label})},null,child.marks):child.type.createChecked({...child.attrs,reference:{...child.attrs.reference,target:{kind:'person',id:label.toLowerCase()},snapshot:{label}}},null,child.marks);store.update(key,node,node.copy(node.content.replaceChild(1,next)))}
 const sync=()=>{Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))},close=()=>{a.destroy();b.destroy()}
 return{a,b,sa,sb,key,registry,atom,remove,edit,sync,close}
}
for(const kind of ['node','mention'] as const)test(`late ${kind} edit after inline deletion is reviewable and restores once at the retained text position`,()=>{
 const f=fixture(kind);try{f.remove();assert.equal(deletionReviews(f.sa).length,0);f.edit(f.sb,'Bob');f.sync();assert.equal(f.sa.project().firstChild!.childCount,1);const groups=deletionReviews(f.sa);assert.equal(groups.length,1);assert.match(JSON.stringify(groups[0].node.toJSON()),/Bob/);resolveDeletionReview(f.sa,groups[0],'restore');f.sync();assert.equal(f.sa.project().firstChild!.childCount,3);assert.equal(f.sa.project().firstChild!.child(0).text,'Before ');assert.equal(f.sa.project().firstChild!.child(2).text,' after');assert.deepEqual(f.sa.project().toJSON(),f.sb.project().toJSON());assert.equal(deletionReviews(f.sa).length,0)}finally{f.close()}
})
test('inline keep-deleted confirms only the reviewed intents and stale choices cannot erase a later edit',()=>{
 const f=fixture('node'),late=new Y.Doc();Y.applyUpdate(late,Y.encodeStateAsUpdate(f.b));const store=new SemanticBlockStore(late,schema)
 try{f.remove();f.edit(f.sb,'Bob');Y.applyUpdate(late,Y.encodeStateAsUpdate(f.b));f.sync();const old=deletionReviews(f.sa)[0];assert.ok(old);resolveDeletionReview(f.sa,old,'delete');assert.equal(deletionReviews(f.sa).length,0);f.edit(store,'Later');Y.applyUpdate(f.a,Y.encodeStateAsUpdate(late));assert.equal(deletionReviews(f.sa).length,1);const before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveDeletionReview(f.sa,old,'delete'),/changed/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);resolveDeletionReview(f.sa,deletionReviews(f.sa)[0],'restore');assert.match(JSON.stringify(f.sa.project().toJSON()),/Later/)}finally{late.destroy();f.close()}
})
test('inline deletion metadata survives fresh Y.Doc and unknown codec can restore but cannot confirm deletion',()=>{
 const f=fixture('node'),fresh=new Y.Doc();try{f.remove();f.edit(f.sb,'Bob');f.sync();Y.applyUpdate(fresh,Y.encodeStateAsUpdate(f.a));const store=new SemanticBlockStore(fresh,schema),group=deletionReviews(store)[0];assert.ok(group);assert.equal(canConfirmDeletion(store,group,new NodeExtensionRegistry()),false);assert.equal(canConfirmDeletion(store,group,f.registry),true);resolveDeletionReview(store,group,'restore');assert.equal(store.project().firstChild!.child(1).attrs.extension.instanceId,f.atom.attrs.extension.instanceId)}finally{fresh.destroy();f.close()}
})
for(const kind of ['node','mention'] as const)test(`late ${kind} property edit after undoing its insertion retains a reviewable occurrence`,()=>{
 const f=fixture(kind,false),undo=f.sa.undoManager();try{const before=f.sa.content(f.key);f.sa.update(f.key,before,before.copy(Fragment.fromArray([schema.text('Before '),f.atom,schema.text(' after')])));undo.stopCapturing();f.sync();assert.ok(undo.undo());assert.equal(deletionReviews(f.sa).length,0);f.edit(f.sb,'Bob');f.sync();assert.equal(deletionReviews(f.sa).length,1);resolveDeletionReview(f.sa,deletionReviews(f.sa)[0],'restore');assert.match(JSON.stringify(f.sa.project().toJSON()),/Bob/)}finally{undo.destroy();f.close()}
})
test('an inserted atom with already received peer properties cannot be undone; repeated untouched history stays one action',()=>{
 const f=fixture('node',false),undo=f.sa.undoManager();try{const before=f.sa.content(f.key);f.sa.update(f.key,before,before.copy(Fragment.fromArray([schema.text('Before '),f.atom,schema.text(' after')])));undo.stopCapturing();for(let i=0;i<3;i++){assert.ok(undo.undo());assert.equal(deletionReviews(f.sa).length,0);assert.equal(undo.undoStack.length,0);assert.equal(undo.redoStack.length,1);assert.ok(undo.redo());assert.equal(deletionReviews(f.sa).length,0);assert.equal(undo.undoStack.length,1)}f.sync();f.edit(f.sb,'Bob');f.sync();const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>undo.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)}finally{undo.destroy();f.close()}
})
test('a removed text location restores as an explicit new final paragraph and preserves unknown inline content',()=>{
 const f=fixture('node');try{f.remove();f.sa.remove([f.key]);f.edit(f.sb,'Bob');f.sync();const group=deletionReviews(f.sa).find(group=>group.inline)!;assert.equal(group.restoreAtEnd,true);resolveDeletionReview(f.sa,group,'restore');assert.equal(f.sa.project().lastChild!.childCount,1);assert.equal(f.sa.project().lastChild!.firstChild!.attrs.extension.instanceId,f.atom.attrs.extension.instanceId);assert.match(JSON.stringify(f.sa.project().toJSON()),/Bob/)}finally{f.close()}
})
test('invalid inline tombstones are rejected on a shadow document before a room changes',()=>{
 const f=fixture('node');try{f.remove();f.sync();const guard=new RoomProtocolGuard(f.a,structuralProtocol),key=[...f.b.getMap(inlineDeletionField).keys()][0],raw=f.b.getMap(inlineDeletionField).get(key) as Record<string,unknown>,bytes=Y.encodeStateAsUpdate(f.a);try{f.b.getMap(inlineDeletionField).set(key,{...raw,point:{carrier:f.key,relative:{type:{client:-1,clock:0}}}});assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(f.b)),/schema/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)}finally{guard.destroy()}}finally{f.close()}
})
test('deleting a complete block uses only its subtree receipt rather than duplicate inline reviews',()=>{
 const f=fixture('node');try{f.sa.remove([f.key]);assert.equal(f.a.getMap(inlineDeletionField).size,0);f.edit(f.sb,'Bob');f.sync();const groups=deletionReviews(f.sa);assert.equal(groups.length,1);assert.equal(groups[0].inline,undefined);resolveDeletionReview(f.sa,groups[0],'restore');assert.match(JSON.stringify(f.sa.project().toJSON()),/Bob/)}finally{f.close()}
})
for(const reverse of [false,true])test(`adjacent deleted atoms restore in original order regardless of review order: reverse=${reverse}`,()=>{
 const f=fixture('node'),second=f.registry.create('example.inline',{title:'Second'})
 try{let before=f.sa.content(f.key);f.sa.update(f.key,before,before.copy(Fragment.fromArray([schema.text('Before '),f.atom,schema.nodes.hcdExtensionInline.createChecked({extension:second}),schema.text(' after')])));f.sync();f.remove();for(const index of [1,2]){before=f.sb.content(f.key);const child=before.child(index),next=child.type.createChecked({...child.attrs,extension:f.registry.update(child.attrs.extension,{title:`Changed ${index}`})});f.sb.update(f.key,before,before.copy(before.content.replaceChild(index,next)))}f.sync();const groups=deletionReviews(f.sa);assert.equal(groups.length,2);for(const group of reverse?[...groups].reverse():groups)resolveDeletionReview(f.sa,group,'restore');assert.deepEqual(f.sa.project().firstChild!.content.content.filter(node=>node.attrs.extension).map(node=>node.attrs.extension.instanceId),[f.atom.attrs.extension.instanceId,second.instanceId])}finally{f.close()}
})
test('removing two atoms preserves the intervening text carrier so restoration stays on both sides of its separator',()=>{
 const f=fixture('node'),second=f.registry.create('example.inline',{title:'Second'})
 try{let before=f.sa.content(f.key);f.sa.update(f.key,before,before.copy(Fragment.fromArray([schema.text('Before 😀'),f.atom,schema.text('；'),schema.nodes.hcdExtensionInline.createChecked({extension:second}),schema.text('。after')])));f.sync();before=f.sa.content(f.key);f.sa.update(f.key,before,before.copy(Fragment.fromArray([schema.text('Before 😀；。after')])));for(const index of [1,3]){before=f.sb.content(f.key);const child=before.child(index);f.sb.update(f.key,before,before.copy(before.content.replaceChild(index,child.type.createChecked({...child.attrs,extension:f.registry.update(child.attrs.extension,{title:`Changed ${index}`})}))))}f.sync();for(const group of deletionReviews(f.sa))resolveDeletionReview(f.sa,group,'restore');const children=f.sa.project().firstChild!.content.content;assert.deepEqual(children.map(node=>node.isText?node.text:node.attrs.extension.instanceId),['Before 😀',f.atom.attrs.extension.instanceId,'；',second.instanceId,'。after'])}finally{f.close()}
})
