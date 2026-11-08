import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,jsonToSnapshot,type Projection} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from './semanticBlockStore.ts'
import {inlineContainerNodeName} from './semanticInlineContainers.ts'
import {structureSourceTargets,reconcileStructureSources} from './semanticStructureSources.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`,source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const text=(value:string)=>schema.text(value),p=(children:PmNode[]=[])=>schema.nodes.paragraph.createChecked(null,children)
function field(n:number,children:PmNode[]=[],attrs:Record<string,unknown>={}){
 return schema.nodes[inlineContainerNodeName].createChecked({...attrs,extension:{schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:7,display:'inline',contentModel:'inline',data:{project:'P-1'},fallback:{text:'Field'}}},children)
}
const documentNode=(nodes:PmNode[])=>schema.nodes.doc.createChecked(null,nodes)
function replica(document=new Y.Doc({gc:false})){const store=new SemanticBlockStore(document,schema,semanticBlockOrigin,{inlineContainers:true});return{document,store,containers:store.flow.containers!}}
function fixture(nodes=[p([text('A'),field(1,[text('Shared😀'),field(2,[text('Nested')])]),text('Z')]),p([text('Second')])]){const a=replica();a.store.initialize(documentNode(nodes));return a}
function rewrite(store:SemanticBlockStore,roots:PmNode[]){const before=store.blocks();return store.reconcile(before,roots.map((node,index)=>({...(before[index]?{key:before[index].key}:{}),node})))}
function exchange(a:Y.Doc,b:Y.Doc){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}
function retained(text:Y.XmlText){const result:string[]=[];for(let item=text._start;item;item=item.right)if(item.countable&&!item.deleted)for(let at=0;at<item.length;at++)result.push(`${item.id.client}:${item.id.clock+at}`);return result}

test('opt-in structure initialization projects nested and empty inline bodies without body JSON in parent carriers',()=>{
 const f=fixture([p([text('A'),field(1,[text('Nested'),field(2)]),text('Z')])]);try{
  assert.equal(f.store.initialized,true);assert.equal(f.store.metadata.get('inlineContainers'),1);assert.equal(f.containers.bodies.size,2);assert.equal(f.store.project().textContent,'ANestedZ');assert.equal(f.containers.bodies.get(id(2))!.length,0)
  const parent=f.store.contents.get(f.store.keys()[0])!.get(0) as Y.XmlText;assert.deepEqual(parent.toDelta().find((part:{insert:unknown})=>typeof part.insert==='object')!.insert,{hcdInlineContainer:{version:1,id:id(1)}})
  assert.doesNotMatch(JSON.stringify([...f.containers.definitions]),/Nested/)
 }finally{f.document.destroy()}
})

test('creating a body in a retained root keeps permanent allocation outside personal undo',()=>{
 const f=fixture([p([text('Before')])]),history=f.store.undoManager(false);try{
  rewrite(f.store,[p([text('Before'),field(1,[text('Own'),field(2,[text('Inner')])])])]);const body=f.containers.bodies.get(id(1)),nested=f.containers.bodies.get(id(2));assert.equal(history.undoStack.length,1)
  history.undo();assert.equal(f.store.project().textContent,'Before');assert.equal(f.containers.bodies.get(id(1)),body);assert.equal(f.containers.bodies.get(id(2)),nested);assert.equal(body!.length,0)
  history.redo();assert.equal(f.store.project().textContent,'BeforeOwnInner');assert.equal(f.containers.bodies.get(id(1)),body)
 }finally{history.destroy();f.document.destroy()}
})

test('a body moved to a newly allocated paragraph is edited in personal history, not allocation history',()=>{
 const f=fixture([p([text('A'),field(1,[text('Original')])])]),history=f.store.undoManager(false);try{
  const old=f.store.blocks(),body=f.containers.bodies.get(id(1));f.store.reconcile(old,[{key:old[0].key,node:p([text('A')])},{node:p([field(1,[text('Local Original')])])}]);assert.equal(body!.toString(),'Local Original')
  history.undo();assert.equal(f.store.project().textContent,'AOriginal');assert.equal(f.containers.bodies.get(id(1)),body)
  history.redo();assert.equal(f.store.project().textContent,'ALocal Original');assert.equal(f.store.blocks().length,2)
 }finally{history.destroy();f.document.destroy()}
})

for(const reverse of [false,true])test(`offline body edits through real structure stores merge and personal text undo preserves peers, reverse=${reverse}`,()=>{
 const a=fixture([p([text('A'),field(1,[text('Shared😀')]),text('Z')])]),b=replica();a.document.clientID=reverse?2:1;b.document.clientID=reverse?1:2;Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document));const history=a.store.undoManager(false)
 try{
  const original=retained(a.containers.bodies.get(id(1))!),point=b.store.flow.capture(b.store.keys()[0],4)
  rewrite(a.store,[p([text('A'),field(1,[text('Local Shared😀')]),text('Z')])]);rewrite(b.store,[p([text('A'),field(1,[text('Shared😀 Peer')]),text('Z')])]);exchange(a.document,b.document)
  assert.equal(a.store.project().textContent,'ALocal Shared😀 PeerZ');assert.ok(a.store.project().eq(b.store.project()));assert.equal(a.store.flow.resolve(point)?.offset,10);assert.deepEqual(retained(a.containers.bodies.get(id(1))!).filter(value=>original.includes(value)),original)
  history.undo();exchange(a.document,b.document);assert.equal(a.store.project().textContent,'AShared😀 PeerZ');history.redo();exchange(a.document,b.document);assert.equal(a.store.project().textContent,'ALocal Shared😀 PeerZ')
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})

test('a moved body keeps relative positions and independently arriving text across two roots',()=>{
 const a=fixture([p([text('A'),field(1,[text('Shared')])]),p([text('B')])]),b=replica();Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
 try{
  const [first,second]=a.store.keys(),point=b.store.flow.capture(first,4),body=a.containers.bodies.get(id(1));rewrite(a.store,[p([text('A')]),p([text('B'),field(1,[text('Shared')])])]);rewrite(b.store,[p([text('A'),field(1,[text('Shared Peer')])]),p([text('B')])]);exchange(a.document,b.document)
  assert.equal(a.store.project().textContent,'ABShared Peer');assert.ok(a.store.project().eq(b.store.project()));assert.deepEqual(a.store.flow.resolve(point),{root:second,offset:4});assert.equal(a.containers.bodies.get(id(1)),body)
 }finally{a.document.destroy();b.document.destroy()}
})

test('bad later root, duplicate occurrences and wrapper/atom collisions refuse without any shared allocation',()=>{
 const f=fixture([p([field(1,[text('Original')])]),p([text('Second')])]);try{
  const assertUnchanged=(roots:PmNode[])=>{const bytes=Y.encodeStateAsUpdate(f.document);assert.throws(()=>rewrite(f.store,roots));assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)}
  assertUnchanged([p([field(3)]),p([field(1,[text('Changed')],{hcdSourceId:source(2)}).type.create({extension:{...field(1).attrs.extension,type:'example.changed',data:{project:'Different'}}},[text('Changed')])])])
  assertUnchanged([p([field(3)]),p([field(3)])])
  const extension={...field(3).attrs.extension,schemaVersion:'hcd.extension/2',display:'block',contentModel:undefined};delete extension.contentModel
  assertUnchanged([p([field(3)]),schema.nodes.hcdExtensionBlock.createChecked({extension})])
  const inline={...field(3).attrs.extension,schemaVersion:'hcd.extension/2',contentModel:undefined};delete inline.contentModel
  assertUnchanged([p([field(3),schema.nodes.hcdExtensionInline.createChecked({extension:inline})]),p()])
  assert.equal(f.containers.bodies.size,1)
 }finally{f.document.destroy()}
})

test('prepared allocation revalidates definitions and refuses an outer personal transaction before changing any root',()=>{
 const f=fixture([p([field(1,[text('Original')])])]);try{
  const proposed=p([field(2),field(1,[text('Original')])]),prepared=f.containers.prepare([proposed]);const old=f.containers.definitions.get(id(1))!;f.containers.definitions.set(id(1),{...old,node:{...old.node,attrs:{...old.node.attrs,extension:{...old.node.attrs.extension,data:{project:'Peer'}}}}})
  let bytes=Y.encodeStateAsUpdate(f.document);assert.throws(()=>prepared.allocate(),/staleInlineContainerProperties/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes);assert.equal(f.containers.bodies.has(id(2)),false)
  f.containers.definitions.set(id(1),old);bytes=Y.encodeStateAsUpdate(f.document);f.document.transact(()=>{assert.throws(()=>f.containers.prepare([proposed]).allocate(),/inlineContainerAllocationRequiresPreparation/)},semanticBlockOrigin);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
 }finally{f.document.destroy()}
})

test('legacy and body-aware stores require their persisted model, with no implicit upgrade or downgrade',()=>{
 const f=fixture(),legacy=replica();try{
  const bytes=Y.encodeStateAsUpdate(f.document);assert.throws(()=>new SemanticBlockStore(f.document,schema).project(),/unsupportedInlineContainerModel/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
  const old=new SemanticBlockStore(legacy.document,schema);old.initialize(documentNode([p([text('Legacy')])]));const before=Y.encodeStateAsUpdate(legacy.document);assert.throws(()=>legacy.store.project(),/unsupportedInlineContainerModel/);assert.deepEqual(Y.encodeStateAsUpdate(legacy.document),before)
 }finally{f.document.destroy();legacy.document.destroy()}
})

test('wire7 rejects the future structural model flag even before any body is allocated',()=>{
 const document=new Y.Doc({gc:false}),old=new SemanticBlockStore(document,schema);old.initialize(documentNode([p([text('Original')])]));const guard=new RoomProtocolGuard(document,structuralProtocol),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(document))
 try{
  const fork=new SemanticBlockStore(peer,schema);fork.metadata.set('inlineContainers',1);const before=Y.encodeStateAsUpdate(document);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer,Y.encodeStateVector(document))),/room-inline-container-model-unsupported/);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  assert.throws(()=>new RoomProtocolGuard(peer,structuralProtocol),/room-inline-container-model-unsupported/)
  const clean=new Y.Doc({gc:false});try{Y.applyUpdate(clean,before);const cleanStore=new SemanticBlockStore(clean,schema),raw=cleanStore.contents.get(cleanStore.keys()[0])!.get(0) as Y.XmlText;raw.insert(raw.length,' Peer');const update=Y.encodeStateAsUpdate(clean,Y.encodeStateVector(document));guard.accept(update);Y.applyUpdate(document,update);assert.equal(old.project().textContent,'Original Peer')}finally{clean.destroy()}
 }finally{guard.destroy();document.destroy();peer.destroy()}
})

test('inline wrapper removal retains its body and prepares a subtree review receipt',()=>{
 const f=fixture();try{const before=f.containers.readBody(id(1)).toJSON();rewrite(f.store,[p([text('AZ')]),p([text('Second')])]);assert.deepEqual(f.containers.readBody(id(1)).toJSON(),before);assert.equal(f.document.getMap('hcd-semantic-inline-deletions/1').size,1)}finally{f.document.destroy()}
})

test('fresh Y.Doc reload preserves prepared bodies and can continue writing without the original store',()=>{
 const a=fixture(),bytes=Y.encodeStateAsUpdate(a.document),before=a.store.project().toJSON();a.document.destroy();const b=replica();try{Y.applyUpdate(b.document,bytes);assert.deepEqual(b.store.project().toJSON(),before);rewrite(b.store,[p([text('A'),field(1,[text('Reloaded Shared😀'),field(2,[text('Nested')])]),text('Z')]),p([text('Second')])]);assert.equal(b.store.project().textContent,'AReloaded Shared😀NestedZSecond')}finally{b.document.destroy()}
})

test('recursive structure receipts keep allowed nested sources, update empty defaults, and avoid marking late body input',()=>{
 const initial=p([schema.text('A',[schema.mark('hcdSource',{nodeId:source(1)})]),field(1,[schema.text('Shared',[schema.mark('hcdSource',{nodeId:source(2)})]),field(2,[],{hcdSourceId:source(3)})],{hcdSourceId:source(2)}),text('Z')]),f=fixture([initial]),origin={kind:'receipt'},history=f.store.undoManager(false)
 try{
  const captured=structureSourceTargets(f.store),target=captured[0];assert.ok(!(target instanceof Y.XmlElement));assert.deepEqual(new Set(target.sourceIds),new Set([source(1),source(2),source(3)]));assert.equal(target.bindings![0].version,2)
  const block={blockId:source(50),blockHash:'receipt',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'A',nodeId:source(11)},{text:'',content:{kind:'extension',extension:field(1).attrs.extension,inlines:[{text:'Shared',nodeId:source(12)},{text:'',content:{kind:'extension',extension:field(2).attrs.extension,inlines:[{text:'',nodeId:source(3)}]}}]}},{text:'Z',nodeId:source(14)}]}} as Projection['blocks'][number]
  const body=f.containers.bodies.get(id(1))!,definition=structuredClone(f.containers.definitions.get(id(1)));body.insert(0,'Late ',{});const stack=history.undoStack.length
  reconcileStructureSources(f.store,captured,[block],origin)
  assert.equal(history.undoStack.length,stack);assert.equal(f.store.canonicalBlockId(f.store.keys()[0]),source(50));assert.deepEqual(f.containers.definitions.get(id(1)),definition);assert.equal(body.getAttribute('hcdSourceId'),source(12));assert.equal(f.containers.bodies.get(id(2))!.getAttribute('hcdSourceId'),source(3))
  const output=jsonToSnapshot(f.store.project().toJSON(),{inlineContainers:true})[0].content.inlines[1].content!.inlines
  assert.deepEqual(output.filter(part=>part.text).map(part=>[part.text,part.nodeId]),[['Late ',undefined],['Shared',source(12)]]);assert.equal(output.at(-1)!.content!.inlines[0].nodeId,source(3))
 }finally{history.destroy();f.document.destroy()}
})

test('retired source IDs are cleared from retained hidden bodies and their defaults without affecting allowed nested IDs',()=>{
 const f=fixture([p([field(1,[schema.text('Old',[schema.mark('hcdSource',{nodeId:source(2)})]),field(2,[],{hcdSourceId:source(3)})],{hcdSourceId:source(2)})])]);try{
  // A permanent, currently unreferenced body can survive an earlier undo/deletion.
  f.containers.prepare([p([field(3,[],{hcdSourceId:source(2)})])]).allocate();const hidden=f.containers.bodies.get(id(3))!;hidden.insert(0,'Hidden',{hcdSource:{nodeId:source(2)}})
  const captured=structureSourceTargets(f.store),block={blockId:source(50),blockHash:'receipt',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'',content:{kind:'extension',extension:field(1).attrs.extension,inlines:[{text:'Old',nodeId:source(12)},{text:'',content:{kind:'extension',extension:field(2).attrs.extension,inlines:[{text:'',nodeId:source(3)}]}}]}}]}} as Projection['blocks'][number]
  reconcileStructureSources(f.store,captured,[block],{kind:'receipt'});assert.equal(hidden.getAttribute('hcdSourceId'),null);assert.equal(hidden.toDelta()[0].attributes?.hcdSource,undefined);assert.equal(hidden.toString(),'Hidden');assert.equal(f.containers.bodies.get(id(2))!.getAttribute('hcdSourceId'),source(3))
 }finally{f.document.destroy()}
})

test('all recursive source validation finishes before metadata is updated when a later receipt is invalid',()=>{
 const f=fixture();try{
  const captured=structureSourceTargets(f.store),snapshot=jsonToSnapshot(f.store.project().toJSON(),{inlineContainers:true}),blocks=snapshot.map((part,index)=>({blockId:source(70+index),blockHash:'receipt',region:'body',readOnly:false,content:part.content})) as Projection['blocks']
  const body=blocks[0].content.inlines[1].content!;body.inlines[0].text='Different captured content';const bytes=Y.encodeStateAsUpdate(f.document);assert.throws(()=>reconcileStructureSources(f.store,captured,blocks,{kind:'receipt'}),/Captured source content differs/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),bytes)
 }finally{f.document.destroy()}
})

test('guarded structural history does not hide foreign edits inside an inline body',()=>{
 const a=fixture([p([text('Before')])]),b=replica(),history=a.store.undoManager();try{
  rewrite(a.store,[p([text('Before'),field(1,[text('Own')])])]);history.stopCapturing();Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document));rewrite(b.store,[p([text('Before'),field(1,[text('Own Peer')])])]);exchange(a.document,b.document)
  const before=Y.encodeStateAsUpdate(a.document);assert.throws(()=>history.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before);assert.equal(a.store.project().textContent,'BeforeOwn Peer')
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})

test('guarded body-only text undo preserves peer input and does not report a structural conflict',()=>{
 const a=fixture([p([field(1,[text('Shared')])])]),b=replica();Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document));const history=a.store.undoManager();try{
  rewrite(a.store,[p([field(1,[text('Local Shared')])])]);history.stopCapturing();rewrite(b.store,[p([field(1,[text('Shared Peer')])])]);exchange(a.document,b.document);assert.ok(history.undo());assert.equal(a.store.project().textContent,'Shared Peer');assert.ok(history.redo());assert.equal(a.store.project().textContent,'Local Shared Peer')
 }finally{history.destroy();a.document.destroy();b.document.destroy()}
})
