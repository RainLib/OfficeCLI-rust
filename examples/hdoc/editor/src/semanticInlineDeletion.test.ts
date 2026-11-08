import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import type {Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {inlineContainerNodeName,readInlineContainerPayload} from './inlineContainerPayload.ts'
import {structureTextEdits} from './semanticStructureBinding.ts'
import {inlineDeletionField,validateInlineDeletionReceipts} from './inlineDeletionReview.ts'
import {deletionReviews,resolveDeletionReview,canConfirmDeletion} from './deletionReview.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),models={inlineContainers:true} as const
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`,key=(n:number)=>`inline:node:${id(n)}`,source=`n_${'a'.repeat(32)}`
const txt=(v:string)=>schema.text(v),paragraph=(content:PmNode[]=[])=>schema.nodes.paragraph.createChecked(null,content)
function field(n:number,content:PmNode[]=[]){return schema.nodes[inlineContainerNodeName].createChecked({hcdSourceId:source,extension:{schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{title:'Original'},fallback:{text:'Field'},resources:[{key:'asset',hash:'b'.repeat(64),byteLength:4,name:'note.txt',mediaType:'text/plain'}]}},content)}
function mention(){return schema.nodes.hcdMention.createChecked({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}}})}
function store(document:Y.Doc){return new SemanticBlockStore(document,schema,undefined,models)}
function fixture(nodes=[paragraph([txt('Before '),field(1,[txt('Body😀'),field(2,[txt('Nested')])]),txt(' after')])]){const a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false}),sa=store(a),sb=store(b);sa.initialize(schema.nodes.doc.createChecked(null,nodes));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));return{a,b,sa,sb,merge(){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)},close(){a.destroy();b.destroy()}}}
function located(store:SemanticBlockStore,n:number){let pos=-1;const doc=store.project();doc.descendants((node,at)=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(n))pos=at});assert.ok(pos>=0);return{doc,pos,node:doc.nodeAt(pos)!}}
function apply(store:SemanticBlockStore,tr:import('@tiptap/pm/state').Transaction){store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})),{textEdits:structureTextEdits([tr],true)})}
function remove(store:SemanticBlockStore,n:number){const {doc,pos,node}=located(store,n);apply(store,EditorState.create({schema,doc}).tr.delete(pos,pos+node.nodeSize))}
function prefix(store:SemanticBlockStore,n:number,value='Peer '){const {doc,pos}=located(store,n);apply(store,EditorState.create({schema,doc}).tr.insertText(value,pos+1))}
function property(store:SemanticBlockStore,n:number,title:string){const {doc,pos,node}=located(store,n),extension=readInlineContainerPayload({...node.attrs.extension,data:{...node.attrs.extension.data,title},fallback:{text:title}});apply(store,EditorState.create({schema,doc}).tr.setNodeMarkup(pos,undefined,{...node.attrs,extension}))}
const review=(store:SemanticBlockStore,n:number)=>{const found=deletionReviews(store).find(value=>value.key===key(n));assert.ok(found);return found}
const body=(store:SemanticBlockStore,n:number)=>store.flow.containers!.readBody(id(n))

test('confirming an inline deletion requires every nested codec in the explicitly supplied inline registry',()=>{
 const f=fixture(),ordinary=new NodeExtensionRegistry(),inline=new InlineContainerRegistry([{type:'example.field',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{title:'Original'},validate:data=>typeof data.title==='string',fallback:()=> 'Field'}])
 try{remove(f.sa,1);prefix(f.sb,2,'Late ');f.merge();const group=review(f.sa,1);assert.equal(canConfirmDeletion(f.sa,group,ordinary),false);assert.equal(canConfirmDeletion(f.sa,group,ordinary,inline),true);const close=inline.connect();close();assert.equal(canConfirmDeletion(f.sa,group,ordinary,inline),false);assert.match(group.node.textContent,/Late Nested/)}finally{f.close()}
})

test('wrapper deletion retains body, source, resources and properties; late peer edits restore once at the original point',()=>{
 const f=fixture();try{const definitions=JSON.stringify([...f.sa.flow.containers!.definitions]),raw=f.sa.flow.containers!.bodies.get(id(1));remove(f.sa,1);assert.equal(f.sa.project().textContent,'Before  after');assert.equal(deletionReviews(f.sa).length,0);const receipt=f.a.getMap(inlineDeletionField).get(key(1)) as any;assert.equal(receipt.version,2);assert.equal(receipt.node.content,undefined);assert.equal(receipt.node.attrs.extension.fallback.text,'Field');prefix(f.sb,2);property(f.sb,1,'Peer property');f.merge();const current=review(f.sa,1);assert.equal(current.node.textContent,'Body😀Peer Nested');assert.equal(deletionReviews(f.sa).length,1);assert.equal(canConfirmDeletion(f.sa,current,new NodeExtensionRegistry()),false);resolveDeletionReview(f.sa,current,'restore');assert.equal(f.sa.project().textContent,'Before Body😀Peer Nested after');assert.equal(located(f.sa,1).node.attrs.extension.data.title,'Peer property');assert.equal(located(f.sa,1).node.attrs.hcdSourceId,source);assert.deepEqual(located(f.sa,1).node.attrs.extension.resources,receipt.node.attrs.extension.resources);assert.equal(f.sa.flow.containers!.bodies.get(id(1)),raw);assert.equal(JSON.stringify([...f.sa.flow.containers!.definitions]),definitions);assert.equal(deletionReviews(f.sa).length,0);resolveDeletionReview(f.sa,current,'restore');assert.equal(f.sa.project().textContent,'Before Body😀Peer Nested after')}finally{f.close()}
})
test('a nested wrapper returns to its own parent inline body rather than the root paragraph',()=>{
 const f=fixture();try{remove(f.sa,2);prefix(f.sb,2);f.merge();const current=review(f.sa,2);assert.equal(current.restoreAtEnd,false);resolveDeletionReview(f.sa,current,'restore');assert.equal(located(f.sa,1).node.child(1).attrs.extension.instanceId,id(2));assert.equal(located(f.sa,2).node.textContent,'Peer Nested');assert.equal(f.sa.project().firstChild!.childCount,3)}finally{f.close()}
})
test('a mention removed inside a live inline body has a review and restores inside that body',()=>{
 const f=fixture([paragraph([field(1,[txt('A'),mention(),txt('Z')])])]);try{const a=located(f.sa,1),tr=EditorState.create({schema,doc:a.doc}).tr.delete(a.pos+2,a.pos+3);apply(f.sa,tr);const b=located(f.sb,1),ref=b.node.child(1).attrs.reference;apply(f.sb,EditorState.create({schema,doc:b.doc}).tr.setNodeMarkup(b.pos+2,undefined,{reference:{...ref,target:{kind:'person',id:'bob'},snapshot:{label:'Bob'}}}));f.merge();const current=deletionReviews(f.sa)[0];assert.equal(current.inline,true);resolveDeletionReview(f.sa,current,'restore');assert.equal(located(f.sa,1).node.child(1).attrs.reference.target.id,'bob');assert.equal(f.sa.project().firstChild!.childCount,1)}finally{f.close()}
})
for(const reverse of [false,true])test(`different-size adjacent wrappers recover around the original separator, reverse=${reverse}`,()=>{
 const f=fixture([paragraph([txt('A😀'),field(1,[txt('One')]),txt('；'),field(2,[txt('Much longer')]),txt('Z')])]);try{remove(f.sa,1);remove(f.sa,2);prefix(f.sb,1,'First ');prefix(f.sb,2,'Second ');f.merge();const groups=deletionReviews(f.sa);assert.equal(groups.length,2);for(const current of reverse?[...groups].reverse():groups)resolveDeletionReview(f.sa,current,'restore');assert.deepEqual(f.sa.project().firstChild!.content.content.map(node=>node.isText?node.text:node.attrs.extension.instanceId),['A😀',id(1),'；',id(2),'Z']);assert.equal(located(f.sa,2).node.textContent,'Second Much longer')}finally{f.close()}
})
test('missing original parent uses a new final paragraph and keeps independent container identity',()=>{
 const f=fixture([paragraph([txt('Before '),field(1,[txt('Body')]),txt(' after')]),paragraph([txt('Other')])]);try{const owner=f.sa.keys()[0];remove(f.sa,1);f.sa.remove([owner]);prefix(f.sb,1);f.merge();const current=review(f.sa,1);assert.equal(current.restoreAtEnd,true);resolveDeletionReview(f.sa,current,'restore');assert.equal(f.sa.project().lastChild!.firstChild!.attrs.extension.instanceId,id(1));assert.equal(f.sa.project().lastChild!.textContent,'Peer Body');assert.equal(f.sa.keys().length,2)}finally{f.close()}
})
test('whole-block deletion covers an older inline receipt and late content is reviewed only once',()=>{
 const f=fixture();try{remove(f.sa,1);prefix(f.sb,1);f.merge();resolveDeletionReview(f.sa,review(f.sa,1),'restore');f.merge();f.sa.remove(f.sa.keys());prefix(f.sb,2,'Later ');f.merge();const reviews=deletionReviews(f.sa);assert.equal(reviews.length,1);assert.equal(reviews[0].inline,undefined);assert.match(reviews[0].node.textContent,/Later Nested/)}finally{f.close()}
})
test('an outer removed container covers prior child receipts only while it still contains those children',()=>{
 const f=fixture();try{remove(f.sa,2);prefix(f.sb,2);f.merge();resolveDeletionReview(f.sa,review(f.sa,2),'restore');f.merge();remove(f.sa,1);prefix(f.sb,2,'Later ');f.merge();const groups=deletionReviews(f.sa);assert.equal(groups.length,1);assert.equal(groups[0].key,key(1));resolveDeletionReview(f.sa,groups[0],'restore');assert.equal(located(f.sa,2).node.textContent,'Later Peer Nested')}finally{f.close()}
})
test('stale review cannot confirm deletion; a later edit reopens an explicitly confirmed review after reload',()=>{
 const f=fixture();try{remove(f.sa,1);prefix(f.sb,1);Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));const stale=review(f.sa,1);prefix(f.sb,2,'Later ');Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveDeletionReview(f.sa,stale,'delete'),/deletion-review-changed/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);resolveDeletionReview(f.sa,review(f.sa,1),'delete');assert.equal(deletionReviews(f.sa).length,0);prefix(f.sb,2,'Again ');Y.applyUpdate(f.a,Y.encodeStateAsUpdate(f.b));const copy=new Y.Doc({gc:false});try{Y.applyUpdate(copy,Y.encodeStateAsUpdate(f.a));const recovered=store(copy);assert.equal(deletionReviews(recovered).length,1);resolveDeletionReview(recovered,review(recovered,1),'restore');assert.match(located(recovered,2).node.textContent,/Again Later Nested/)}finally{copy.destroy()}}finally{f.close()}
})
test('own undo restores a deletion with peer body; redoing it cannot hide unreviewed peer input',()=>{
 const f=fixture(),history=f.sa.undoManager();try{remove(f.sa,1);history.stopCapturing();prefix(f.sb,2);f.merge();history.undo();assert.equal(located(f.sa,2).node.textContent,'Peer Nested');const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>history.redo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)}finally{history.destroy();f.close()}
})
test('undoing creation captures an empty inverse receipt before an offline peer body arrives',()=>{
 const f=fixture([paragraph([txt('Before after')])]),history=f.sa.undoManager();try{const doc=f.sa.project();apply(f.sa,EditorState.create({schema,doc}).tr.insert(7,field(1,[txt('Own')])));history.stopCapturing();f.merge();prefix(f.sb,1,'Offline ');history.undo();assert.equal(f.sa.project().textContent,'Before after');const receipt=f.a.getMap(inlineDeletionField).get(key(1)) as any;assert.equal(receipt.version,2);f.merge();const current=review(f.sa,1);assert.equal(current.node.textContent,'Offline ');resolveDeletionReview(f.sa,current,'restore');assert.equal(located(f.sa,1).node.textContent,'Offline ')}finally{history.destroy();f.close()}
})
test('structural undo also protects foreign property-only edits inside a newly created wrapper',()=>{
 const f=fixture([paragraph([txt('Before after')])]),history=f.sa.undoManager();try{const doc=f.sa.project();apply(f.sa,EditorState.create({schema,doc}).tr.insert(7,field(1,[txt('Own')])));history.stopCapturing();f.merge();property(f.sb,1,'Peer only');f.merge();const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>history.undo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.equal(located(f.sa,1).node.attrs.extension.data.title,'Peer only')}finally{history.destroy();f.close()}
})
test('malformed tombstones, body snapshots masquerading as definitions and wire7-only receipt injection are rejected',()=>{
 const f=fixture();try{remove(f.sa,1);const raw=f.a.getMap(inlineDeletionField).get(key(1)) as any;f.a.getMap(inlineDeletionField).set(key(1),{...raw,node:{...raw.node,content:[{type:'text',text:'Fake'}]}});assert.throws(()=>validateInlineDeletionReceipts(f.a),/schema/);f.a.getMap(inlineDeletionField).set(key(1),raw);const old=getSchema([...schemaExtensions,SemanticStructureIdentity]),live=new Y.Doc(),peer=new Y.Doc();new SemanticBlockStore(live,old).initialize(old.nodes.doc.createChecked(null,[old.nodes.paragraph.createChecked()]));Y.applyUpdate(peer,Y.encodeStateAsUpdate(live));const guard=new RoomProtocolGuard(live,structuralProtocol);try{peer.getMap(inlineDeletionField).set(key(1),raw);const bytes=Y.encodeStateAsUpdate(live);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer)),/inline-container-model-unsupported/);assert.deepEqual(Y.encodeStateAsUpdate(live),bytes)}finally{guard.destroy();live.destroy();peer.destroy()}}finally{f.close()}
})

test('canonical deletion retires hidden source bindings even though the body was absent from capture',async()=>{
 const {structureSourceTargets,reconcileStructureSources}=await import('./semanticStructureSources.ts')
 const f=fixture([paragraph([txt('Before '),field(1,[schema.text('Secret',[schema.mark('bold'),schema.mark('hcdSource',{nodeId:source})])]),txt(' after')])]);try{const raw=f.sa.flow.containers!.bodies.get(id(1))!,definitions=JSON.stringify([...f.sa.flow.containers!.definitions]);remove(f.sa,1);const captures=structureSourceTargets(f.sa);assert.ok(captures.every(entry=>'sourceIds' in entry&&!entry.sourceIds.includes(source)));reconcileStructureSources(f.sa,captures,[{blockId:'n_'+'b'.repeat(32),blockHash:'native',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Before  after',nodeId:'n_'+'c'.repeat(32)}]}}],{kind:'owned-source-receipt'});assert.equal(body(f.sa,1).attrs.hcdSourceId,null);assert.equal(body(f.sa,1).firstChild!.marks.some(mark=>mark.type.name==='hcdSource'),false);assert.equal(body(f.sa,1).firstChild!.marks.some(mark=>mark.type.name==='bold'),true);assert.equal(body(f.sa,1).textContent,'Secret');assert.equal(f.sa.flow.containers!.bodies.get(id(1)),raw);assert.equal(JSON.stringify([...f.sa.flow.containers!.definitions]),definitions);assert.equal(deletionReviews(f.sa).length,0)}finally{f.close()}
})
test('restoring an outer wrapper cannot duplicate a descendant already moved into visible content',()=>{
 const f=fixture();try{const outer=located(f.sa,1),nested=located(f.sa,2).node,tr=EditorState.create({schema,doc:outer.doc}).tr.delete(outer.pos,outer.pos+outer.node.nodeSize).insert(outer.pos,nested);apply(f.sa,tr);prefix(f.sb,1);f.merge();const current=review(f.sa,1),bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveDeletionReview(f.sa,current,'restore'),/duplicateInlineContainerIdentity/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.equal(deletionReviews(f.sa).length,1);assert.equal(located(f.sa,2).node.textContent,'Nested')}finally{f.close()}
})
