import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import type {Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from './semanticBlockStore.ts'
import {structureTextEdits} from './semanticStructureBinding.ts'
import {inlineContainerNodeName,readInlineContainerPayload} from './inlineContainerPayload.ts'
import {inlineContainerEditFields,inlineContainerEditIndex,inlineContainerNodes,materializeInlineContainerEdits,resolveInlineContainerEdits,type InlineContainerPropertyCodec} from './inlineContainerEdits.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {deletionReviews} from './deletionReview.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'
import {readExtensionNode} from './extensionNode.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),models={inlineContainers:true} as const
const id=(n=1)=>`x_${n.toString(16).padStart(32,'0')}`,source=`n_${'a'.repeat(32)}`
const codec:InlineContainerPropertyCodec={resolve:()=>true,update:(base,data)=>{if(typeof data.title!=='string'||typeof data.done!=='boolean'||typeof data.a!=='number'||typeof data.b!=='number'||data.a+data.b>5)throw new Error('invalid business data');return readInlineContainerPayload({...base,data,fallback:{text:`${data.done?'☑':'☐'} ${data.title}`}})}}
function field(n:number,body:PmNode[]=[]){return schema.nodes[inlineContainerNodeName].createChecked({hcdSourceId:source,extension:{schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{title:'Initial',done:false,a:1,b:1,optional:'retained'},fallback:{text:'☐ Initial'}}},body)}
function store(document:Y.Doc){return new SemanticBlockStore(document,schema,semanticBlockOrigin,models)}
function pair(){const a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false}),sa=store(a),sb=store(b);sa.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.text('Before '),field(1,[schema.text('AAA😀AAA',[schema.mark('hcdSource',{nodeId:source})]),field(2,[schema.text('Nested')])]),schema.text(' After')])]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));return{a,b,sa,sb,merge(){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)},close(){a.destroy();b.destroy()}}}
function located(store:SemanticBlockStore,n=1){const doc=store.project();let pos=-1;doc.descendants((node,at)=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(n))pos=at});assert.ok(pos>=0);return{doc,pos,node:doc.nodeAt(pos)!}}
function payload(store:SemanticBlockStore,n=1){return readInlineContainerPayload(located(store,n).node.attrs.extension)}
function edit(store:SemanticBlockStore,patch:Record<string,unknown>,n=1){const {doc,pos,node}=located(store,n),before=payload(store,n),next=codec.update(before,{...before.data,...patch}),tr=EditorState.create({schema,doc}).tr.setNodeMarkup(pos,undefined,{...node.attrs,extension:next});store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));return next}
function type(store:SemanticBlockStore,value:string,n=1){const {doc,pos}=located(store,n),tr=EditorState.create({schema,doc}).tr.insertText(value,pos+1);store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})),{textEdits:structureTextEdits([tr],true)})}
function visible(raw:Y.XmlText){const values:string[]=[];for(let item=raw._start;item;item=item.right)if(!item.deleted&&item.countable)for(let n=0;n<item.length;n++)values.push(`${item.id.client}:${item.id.clock+n}`);return values}
const group=(document:Y.Doc)=>inlineContainerEditIndex(document).get(id())!

test('inline properties retain immutable definitions, body item identities and recursive sources',()=>{
 const f=pair();try{const definitions=JSON.stringify([...f.sa.flow.containers!.definitions]),body=f.sa.flow.containers!.bodies.get(id())!,ids=visible(body);edit(f.sa,{title:'Alice'});assert.equal(payload(f.sa).data.title,'Alice');assert.equal(located(f.sa).node.textContent,'AAA😀AAANested');assert.equal(located(f.sa).node.attrs.hcdSourceId,source);assert.equal(located(f.sa).node.firstChild!.marks[0].attrs.nodeId,source);assert.equal(JSON.stringify([...f.sa.flow.containers!.definitions]),definitions);assert.deepEqual(visible(body),ids);assert.equal(group(f.a).ready,true);assert.throws(()=>readExtensionNode(payload(f.sa)));}finally{f.close()}
})
for(const reverse of [false,true])test(`disjoint property candidates merge, require codec receipt and retain peer body through own undo, reverse=${reverse}`,()=>{
 const f=pair(),history=f.sa.undoManager();try{edit(f.sa,{title:'Alice'});history.stopCapturing();edit(f.sb,{done:true});type(f.sb,'Peer ',2);const au=Y.encodeStateAsUpdate(f.a),bu=Y.encodeStateAsUpdate(f.b);if(reverse){Y.applyUpdate(f.b,au);Y.applyUpdate(f.a,bu)}else{Y.applyUpdate(f.a,bu);Y.applyUpdate(f.b,au)}assert.deepEqual(group(f.a).conflicts,{});assert.equal(group(f.a).ready,false);assert.equal(businessDraftProblem(f.a,f.sa.project(),f.sa),'node-drafts-not-ready');materializeInlineContainerEdits(f.a,codec);f.merge();assert.equal(payload(f.sa).fallback.text,'☑ Alice');assert.equal(businessDraftProblem(f.a,f.sa.project(),f.sa),undefined);assert.ok(f.sa.project().eq(f.sb.project()));history.undo();materializeInlineContainerEdits(f.a,codec);assert.equal(payload(f.sa).data.title,'Initial');assert.equal(payload(f.sa).data.done,true);assert.equal(located(f.sa,2).node.textContent,'Peer Nested');history.redo();materializeInlineContainerEdits(f.a,codec);assert.equal(payload(f.sa).fallback.text,'☑ Alice');assert.equal(located(f.sa,2).node.textContent,'Peer Nested')}finally{history.destroy();f.close()}
})
test('same-field conflicts keep both candidates; stale resolve fails atomically and undo restores review',()=>{
 const f=pair(),history=f.sa.undoManager();try{edit(f.sa,{title:'Alice'});history.stopCapturing();edit(f.sb,{title:'Bob'});f.merge();assert.equal(group(f.a).conflicts.title.length,2);assert.equal(businessDraftProblem(f.a,f.sa.project(),f.sa),'node-drafts-conflict');const ids=group(f.a).ids,bob=group(f.a).conflicts.title.find(option=>option.value==='Bob')!.intentId;resolveInlineContainerEdits(f.a,codec,id(),ids,{title:bob},semanticBlockOrigin);history.stopCapturing();assert.equal(payload(f.sa).fallback.text,'☐ Bob');const bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveInlineContainerEdits(f.a,codec,id(),ids,{title:bob},semanticBlockOrigin),/extensionChanged/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);history.undo();assert.equal(group(f.a).conflicts.title.length,2);history.redo();assert.deepEqual(group(f.a).conflicts,{});assert.equal(located(f.sa).node.textContent,'AAA😀AAANested')}finally{history.destroy();f.close()}
})
test('invalid merged business data and missing codec stay pending, explicit candidate keeps all history',()=>{
 const f=pair();try{edit(f.sa,{a:4});edit(f.sb,{b:4});f.merge();materializeInlineContainerEdits(f.a,codec);assert.equal(group(f.a).ready,false);assert.equal(businessDraftProblem(f.a,f.sa.project(),f.sa),'node-drafts-not-ready');const candidate=group(f.a).intents.find(intent=>intent.after.data.a===4)!;resolveInlineContainerEdits(f.a,codec,id(),group(f.a).ids,{'#candidate':candidate.id},semanticBlockOrigin);assert.equal(group(f.a).ids.length,3);assert.deepEqual([payload(f.sa).data.a,payload(f.sa).data.b],[4,1]);assert.equal(group(f.a).ready,true)}finally{f.close()}
 const g=pair();try{edit(g.sa,{title:'Alice'});edit(g.sb,{done:true});g.merge();const bytes=Y.encodeStateAsUpdate(g.a);materializeInlineContainerEdits(g.a,{...codec,resolve:()=>undefined});assert.equal(group(g.a).ready,false);assert.deepEqual(Y.encodeStateAsUpdate(g.a),bytes)}finally{g.close()}
})
test('equal values converge and field deletion keeps another concurrent property',()=>{
 const f=pair();try{edit(f.sa,{title:'Same'});edit(f.sb,{title:'Same'});f.merge();assert.deepEqual(group(f.a).conflicts,{});materializeInlineContainerEdits(f.a,codec);f.merge();const {optional:_optional,...data}=payload(f.sa).data,{doc,pos,node}=located(f.sa),tr=EditorState.create({schema,doc}).tr.setNodeMarkup(pos,undefined,{...node.attrs,extension:codec.update(payload(f.sa),data)});f.sa.reconcile(f.sa.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));edit(f.sb,{done:true});f.merge();materializeInlineContainerEdits(f.a,codec);assert.equal(Object.hasOwn(payload(f.sa).data,'optional'),false);assert.equal(payload(f.sa).fallback.text,'☑ Same')}finally{f.close()}
})
test('fresh Doc recovers candidates and bodies without codecs or source rewriting',()=>{
 const f=pair();try{edit(f.sa,{title:'Alice'});edit(f.sb,{title:'Bob'});type(f.sb,'Late ',2);f.merge();const copy=new Y.Doc({gc:false});try{Y.applyUpdate(copy,Y.encodeStateAsUpdate(f.a));const recovered=store(copy);assert.deepEqual(recovered.project().toJSON(),f.sa.project().toJSON());assert.equal(group(copy).conflicts.title.length,2);assert.equal(businessDraftProblem(copy,recovered.project(),recovered),'node-drafts-conflict');assert.equal(located(recovered,2).node.textContent,'Late Nested')}finally{copy.destroy()}}finally{f.close()}
})
test('late invalid text scope preflights a property and new container without publishing or allocating',()=>{
 const f=pair();try{const before=f.sa.blocks(),{doc,pos,node}=located(f.sa),next=codec.update(payload(f.sa),{...payload(f.sa).data,title:'Never committed'}),tr=EditorState.create({schema,doc}).tr.setNodeMarkup(pos,undefined,{...node.attrs,extension:next}).insert(doc.content.size-1,field(3)),bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.sa.reconcile(before,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})),{textEdits:[{key:before[0].key,containerId:id(99),edits:[]}]}));assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.equal(f.sa.flow.containers!.bodies.size,2);assert.equal(inlineContainerEditIndex(f.a).size,0)}finally{f.close()}
})
test('forged materialization and codec identity rewrites cannot authorize a save',()=>{
 const f=pair();try{edit(f.sa,{title:'Alice'});edit(f.sb,{title:'Bob'});f.merge();const g=group(f.a),bob=g.conflicts.title.find(option=>option.value==='Bob')!.intentId,bytes=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveInlineContainerEdits(f.a,{...codec,update:(base,data)=>({...codec.update(base,data),instanceId:id(99)})},id(),g.ids,{title:bob},semanticBlockOrigin),/nodeExtensionInvalidData/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);f.a.getMap(inlineContainerEditFields.materialized).set(id(),{ids:g.ids,value:{...g.value,data:{...g.data,title:'Forged'}}});assert.throws(()=>f.sa.project(),/node-edit-materialization/)}finally{f.close()}
})
test('active wire7 refuses property-only maps before any definitions arrive',()=>{
 const old=getSchema([...schemaExtensions,SemanticStructureIdentity]);for(const field of Object.values(inlineContainerEditFields)){const live=new Y.Doc(),peer=new Y.Doc();new SemanticBlockStore(live,old).initialize(old.nodes.doc.createChecked(null,[old.nodes.paragraph.createChecked()]));const guard=new RoomProtocolGuard(live,structuralProtocol);try{Y.applyUpdate(peer,Y.encodeStateAsUpdate(live));peer.getMap(field).set('unknown',{value:'model3'});const bytes=Y.encodeStateAsUpdate(live);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer)),/inline-container-model-unsupported/);assert.deepEqual(Y.encodeStateAsUpdate(live),bytes)}finally{guard.destroy();live.destroy();peer.destroy()}}
})
test('hidden root retains property history and equal-looking late candidates reopen deletion review',()=>{
 const f=pair();try{edit(f.sa,{title:'Same'});edit(f.sb,{title:'Same'});const key=f.sa.keys()[0];f.sa.remove([key]);assert.equal(deletionReviews(f.sa).length,0);f.merge();assert.equal(deletionReviews(f.sa).length,1);assert.equal(deletionReviews(f.sa)[0].key,key);assert.equal(inlineContainerNodes(deletionReviews(f.sa)[0].node).size,2);assert.equal(group(f.a).intents.length,2)}finally{f.close()}
})

test('resource envelope and field branches stay full candidates; choosing either preserves independent body input',()=>{
 const f=pair();try{
  const {doc,pos,node}=located(f.sa),base=payload(f.sa),resource={key:'attachment',hash:'b'.repeat(64),byteLength:4,name:'note.txt',mediaType:'text/plain'},next=readInlineContainerPayload({...base,resources:[resource]}),tr=EditorState.create({schema,doc}).tr.setNodeMarkup(pos,undefined,{...node.attrs,extension:next});f.sa.reconcile(f.sa.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));edit(f.sb,{title:'Peer'});type(f.sb,'Peer body ',2);f.merge()
  const g=group(f.a),field='\u0000envelope';assert.equal(g.conflicts[field].length,2);assert.equal(businessDraftProblem(f.a,f.sa.project(),f.sa),'node-drafts-conflict');const candidate=g.conflicts[field].find(choice=>(choice.value as typeof base).resources?.length===1)!;resolveInlineContainerEdits(f.a,codec,id(),g.ids,{[field]:candidate.intentId},semanticBlockOrigin);assert.deepEqual(payload(f.sa).resources,[resource]);assert.equal(located(f.sa,2).node.textContent,'Peer body Nested');assert.equal(f.sa.flow.containers!.definitions.get(id())!.node.attrs.extension.resources,undefined)
 }finally{f.close()}
})
