import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes} from './extensionNode.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
import {CollaborativeImageDraftStore} from './collaborativeImages.ts'
import {SemanticHistory} from './semanticHistory.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function fixture(kind:'inline'|'block'|'container',guarded=true){
 const definition:NodeExtensionDefinition={type:'example.history',version:1,display:kind==='inline'?'inline':'block',...(kind==='container'?{contentModel:'blocks'}:{}),label:'History node',defaultData:{title:'Initial'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)},registry=new NodeExtensionRegistry(),disconnect=registry.connect();let release=registry.register([definition]),activeRegistry=registry
 const seed=new Y.Doc(),source=new SemanticBlockStore(seed,schema),node=schema.nodes[kind==='inline'?'hcdExtensionInline':kind==='block'?'hcdExtensionBlock':'hcdExtensionContainer'].createChecked({extension:registry.create(definition.type)},kind==='container'?[schema.nodes.paragraph.createChecked(null,[schema.text('Child text')])]:null),root=kind==='inline'?schema.nodes.paragraph.createChecked(null,[schema.text('Prefix '),node,schema.text(' suffix')]):node
 source.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('Outside')]),root,schema.nodes.paragraph.createChecked(null,[schema.text('Tail')])]))
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);Y.applyUpdate(a,Y.encodeStateAsUpdate(seed));Y.applyUpdate(b,Y.encodeStateAsUpdate(seed));const undo=sa.undoManager(true,guarded?before=>prepareExtensionHistoryGuard(before,activeRegistry):undefined),sync=()=>{const aa=Y.encodeStateAsUpdate(a),bb=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bb);Y.applyUpdate(b,aa)}
 const copy=()=>{undo.stopCapturing();const key=sa.duplicate([sa.keys()[1]],null)[0];undo.stopCapturing();sync();return key}
 return{definition,registry,a,b,sa,sb,undo,copy,sync,unload:()=>release(),reload:()=>{release=registry.register([definition])},replaceRegistry:(next:NodeExtensionRegistry)=>{activeRegistry=next},close(){undo.destroy();disconnect();a.destroy();b.destroy();seed.destroy()}}
}
function kept(f:ReturnType<typeof fixture>,direction:'undo'|'redo'){
 const before=Y.encodeStateAsUpdate(f.a),stack=direction==='undo'?f.undo.undoStack:f.undo.redoStack,item=stack.at(-1);assert.throws(()=>f.undo[direction](),/historyExtensionUnavailable/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.equal(stack.at(-1),item);f.sync();assert.ok(f.sa.project().eq(f.sb.project()))
}
test('the old structural-only history path can remove a copied node after its codec unloads',()=>{
 const f=fixture('container',false);try{f.copy();f.unload();f.undo.undo();assert.equal(extensionNodes(f.sa.project()).size,1)}finally{f.close()}
})
for(const kind of ['inline','block','container'] as const)test(`codec unloading protects ${kind} copy undo; loading the codec resumes the same history`,()=>{
 const f=fixture(kind);try{f.copy();const ids=[...extensionNodes(f.sa.project()).keys()];f.unload();kept(f,'undo');f.reload();assert.ok(f.undo.undo());assert.equal(extensionNodes(f.sa.project()).size,1);assert.ok(f.undo.redo());assert.deepEqual([...extensionNodes(f.sa.project()).keys()],ids)}finally{f.close()}
})
test('unknown nodes do not block undo of unrelated ordinary text',()=>{
 const f=fixture('inline');try{const key=f.sa.keys()[0],before=f.sa.content(key);f.sa.update(key,before,before.copy(before.content.append(Fragment.from(schema.text(' local')))));f.unload();assert.ok(f.undo.undo());assert.equal(f.sa.project().firstChild!.textContent,'Outside');assert.equal(extensionNodes(f.sa.project()).size,1)}finally{f.close()}
})
test('ordinary child typing history cannot alter an unavailable container after unload',()=>{
 const f=fixture('container');try{const child=f.sa.childKeys(f.sa.keys()[1])[0],before=f.sa.content(child);f.sa.update(child,before,before.copy(before.content.append(Fragment.from(schema.text(' own input')))));f.unload();kept(f,'undo');f.reload();assert.ok(f.undo.undo());assert.equal(f.sa.content(child).textContent,'Child text')}finally{f.close()}
})
for(const direction of ['undo','redo'] as const)test(`business property ${direction} rechecks current codec even without a structural history policy`,()=>{
 const f=fixture('inline');try{const key=f.sa.keys()[1],before=f.sa.content(key),next=before.copy(Fragment.fromArray(before.content.content.map(node=>node.type.name==='hcdExtensionInline'?node.type.createChecked({...node.attrs,extension:f.registry.update(node.attrs.extension,{title:'Own property'})},null,node.marks):node)));f.sa.update(key,before,next);f.undo.stopCapturing();if(direction==='redo')assert.ok(f.undo.undo());f.unload();kept(f,direction);f.reload();assert.ok(f.undo[direction]());assert.equal([...extensionNodes(f.sa.project()).values()][0].value.data.title,direction==='undo'?'Initial':'Own property')}finally{f.close()}
})
test('undo may restore an unavailable deleted occurrence; redo cannot silently remove it again',()=>{
 const f=fixture('block');try{const key=f.copy();f.sa.remove([key]);f.undo.stopCapturing();f.unload();assert.ok(f.undo.undo());assert.equal(extensionNodes(f.sa.project()).size,2);kept(f,'redo')}finally{f.close()}
})
test('a replaced or incompatible registry does not reuse a cached codec decision',()=>{
 const f=fixture('block');try{f.copy();f.replaceRegistry(new NodeExtensionRegistry([{...f.definition,version:2}]));kept(f,'undo');f.replaceRegistry(new NodeExtensionRegistry([f.definition]));assert.ok(f.undo.undo())}finally{f.close()}
})
test('a known outer container cannot hide a nested occurrence whose own codec disappeared',()=>{
 const f=fixture('container'),definition:NodeExtensionDefinition={type:'example.nested',version:1,display:'inline',label:'Nested',defaultData:{title:'Inner'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)},release=f.registry.register([definition])
 try{const key=f.sa.childKeys(f.sa.keys()[1])[0],before=f.sa.content(key);f.sa.update(key,before,before.copy(before.content.append(Fragment.from(schema.nodes.hcdExtensionInline.createChecked({extension:f.registry.create(definition.type)})))));f.undo.stopCapturing();f.copy();release();kept(f,'undo')}finally{release();f.close()}
})
test('review skip keeps unknown content and allows the older unrelated action to undo',async()=>{
 const f=fixture('container'),images=new CollaborativeImageDraftStore(f.a),history=new SemanticHistory(images,f.undo,()=>false,async()=>{throw new Error('no image read')}),disconnect=history.connect()
 try{const key=f.sa.keys()[0],before=f.sa.content(key);f.sa.update(key,before,before.copy(Fragment.from(schema.text('Outside edited'))));history.stopCapturing();f.copy();f.unload();await assert.rejects(history.step('undo'),/historyExtensionUnavailable/);const bytes=Y.encodeStateAsUpdate(f.a);history.skip('undo',history.snapshot());assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);await history.step('undo');assert.equal(f.sa.project().firstChild!.textContent,'Outside');assert.equal(extensionNodes(f.sa.project()).size,2)}finally{disconnect();f.close()}
})
