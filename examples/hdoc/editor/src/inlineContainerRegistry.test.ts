import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {InlineContainerRegistry,type InlineContainerDefinition} from './inlineContainerRegistry.ts'
import {inlineContainerPreservationPlugin,prepareInlineContainerHistoryGuard} from './inlineContainerPreservation.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'
import {materializeInlineContainerEdits} from './inlineContainerEdits.ts'
import {inlineContainerClipboardPlugin,inlineClipboardMime} from './inlineContainerClipboard.ts'

const definition:InlineContainerDefinition={type:'example.field',version:1,display:'inline',contentModel:'inline',label:{'en-US':'Field','zh-CN':'字段'},defaultData:{title:'Label'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title),properties:[{key:'title',label:'Title',kind:'text',required:true,maxLength:128}],exportAdapters:{docx:({data})=>({support:'semantic',includeContent:true,blocks:[{kind:'paragraph',runs:[{text:String(data.title)+': '}]}]})}}
const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const field=(registry:InlineContainerRegistry,body='AAA😀AAA')=>schema.nodes.hcdExtensionInlineContainer.createChecked({extension:registry.create('example.field')},schema.text(body))
const paragraph=(...nodes:import('@tiptap/pm/model').Node[])=>schema.nodes.paragraph.createChecked(null,nodes)
const doc=(...nodes:import('@tiptap/pm/model').Node[])=>schema.nodes.doc.createChecked(null,nodes)
function environment(){const registry=new InlineContainerRegistry(),disconnect=registry.connect(),unload=registry.register([definition]),node=field(registry),initial=doc(paragraph(schema.text('Before '),node,schema.text(' after'))),errors:unknown[]=[],plugin=inlineContainerPreservationPlugin(registry.resolve,error=>errors.push(error));return{registry,disconnect,unload,node,initial,errors,create:()=>EditorState.create({schema,doc:initial,plugins:[plugin]})}}

test('inline host registration produces strict envelope3 and immutable portable adapters without storing its body',()=>{
 const registry=new InlineContainerRegistry([definition]),value=registry.create('example.field');assert.equal(value.schemaVersion,'hcd.extension/3');assert.equal(value.display,'inline');assert.equal(value.contentModel,'inline');assert.deepEqual(value.data,{title:'Label'});assert.ok(registry.resolve(value));assert.equal(value.exports?.docx?.includeContent,true);assert.equal(registry.capabilities().requiresNegotiatedModel,true)
 const updated=registry.update(value,{title:'New'});assert.equal(updated.instanceId,value.instanceId);assert.equal(updated.fallback.text,'New');assert.equal(value.fallback.text,'Label');assert.equal(registry.resolve({...updated,fallback:{text:'Forged'}}),undefined);assert.throws(()=>registry.update(value,{title:''}),/InvalidData/)
})
test('inline registration is atomic and restricts export snapshots, fallback lines and DOM ownership',()=>{
 const registry=new InlineContainerRegistry(),close=registry.connect()
 try{for(const invalid of [
  {...definition,type:'example.bad',fallback:()=> 'Two\nlines'},
  {...definition,type:'example.bad',exportAdapters:{docx:()=>({support:'semantic',includeContent:true,blocks:[{kind:'heading',level:1,runs:[{text:'Heading'}]}]})}},
  {...definition,type:'example.bad',exportAdapters:{docx:()=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:'Body omitted'}]}]})}},
  {...definition,type:'example.bad',mountView:()=>{}},
 ]){assert.throws(()=>registry.register([definition,invalid as InlineContainerDefinition]));assert.equal(registry.list().length,0)}
 const mutable={...definition};const remove=registry.register([mutable]);mutable.fallback=()=> 'Mutated';assert.equal(registry.create('example.field').fallback.text,'Label');assert.throws(()=>registry.register([definition]));remove();remove();assert.equal(registry.list().length,0)
 }finally{close()}assert.throws(()=>registry.register([definition]),/Disposed/)
})
test('inline resources and explicit migration previews preserve occurrence identity and validate every export',()=>{
 const resource={key:'file',name:'attachment.txt',hash:'a'.repeat(64),byteLength:7,mediaType:'text/plain'},oldRegistry=new InlineContainerRegistry([definition]),old=oldRegistry.create('example.field',undefined,[resource]),registry=new InlineContainerRegistry([{...definition,version:2,migrations:[{fromVersion:1,validate:definition.validate,migrate:data=>({title:data.title+' v2'})}]}])
 assert.equal(registry.resolve(old),undefined);const preview=registry.previewMigration(old)!;assert.deepEqual(preview.versions,[1,2]);assert.equal(preview.after.instanceId,old.instanceId);assert.deepEqual(preview.after.resources,[resource]);assert.equal(preview.after.data.title,'Label v2');assert.equal(old.version,1);assert.ok(Object.isFrozen(preview.after));assert.equal(oldRegistry.updateResources(old,[]).resources?.length??0,0)
})
test('unknown inline bodies reject range deletion, text, formatting and forged properties but allow surrounding edits',()=>{
 const e=environment();try{e.unload();const state=e.create(),at=1+'Before '.length
 for(const tr of [state.tr.insertText('bad',at+1),state.tr.delete(at,at+e.node.nodeSize),state.tr.delete(1,state.doc.content.size-1),state.tr.addMark(at+1,at+3,schema.marks.bold.create()),state.tr.setNodeMarkup(at,undefined,{...e.node.attrs,extension:{...e.node.attrs.extension,data:{title:'Bad'}}})])assert.equal(state.applyTransaction(tr).transactions.length,0)
 const next=state.applyTransaction(state.tr.insertText('Allowed ',1)).state;assert.equal(next.doc.textContent,'Allowed Before AAA😀AAA after');assert.equal(e.errors.length,5)
 }finally{e.disconnect()}
})
test('current codec availability is checked for every transaction and history execution',()=>{
 const e=environment();try{let state=e.create();const at=1+'Before '.length;state=state.applyTransaction(state.tr.insertText('Own ',at+1)).state;assert.ok(state.doc.textContent.includes('Own '));e.unload();const guard=prepareInlineContainerHistoryGuard(state.doc,e.registry.resolve)!;assert.throws(()=>guard(e.initial),/historyExtensionUnavailable/);assert.doesNotThrow(()=>guard(state.tr.insertText('Outside ',1).doc));const source=e.node.attrs.hcdSourceId
 const repair=state.tr.setNodeMarkup(at,undefined,{...state.doc.nodeAt(at)!.attrs,hcdSourceId:'n_'+'a'.repeat(32)}).setMeta('hcd-source-defaults',true);assert.equal(state.applyTransaction(repair).transactions.length,1);assert.notEqual(repair.doc.nodeAt(at)!.attrs.hcdSourceId,source);assert.doesNotThrow(()=>guard(repair.doc));const register=e.registry.register([definition]);assert.equal(state.applyTransaction(state.tr.insertText('Reload ',at+1)).transactions.length,1);register()
 }finally{e.disconnect()}
})
test('malformed structured clipboard is rejected without mutation while ordinary rich text uses the normal path',()=>{
 const errors:unknown[]=[],plugin=inlineContainerClipboardPlugin(error=>errors.push(error)),paste=plugin.props.handlePaste!,state=EditorState.create({schema}),view={editable:true,state,dispatch(){assert.fail('invalid clipboard must not dispatch')}}
 const event=(json:string,html='')=>({clipboardData:{getData:(format:string)=>format===inlineClipboardMime?json:format==='text/html'?html:''}} as ClipboardEvent)
 assert.equal(paste.call(plugin,view as any,event('{"schemaVersion":"future"}'),{} as any),true);assert.equal((errors[0] as Error).message,'inlineContainerClipboardInvalid');assert.equal(paste.call(plugin,view as any,event('','<p>Plain rich text</p>'),{} as any),false);assert.equal(errors.length,1)
})
test('unavailable nested bodies remain protected inside a known parent; remote projection does not publish local edits',()=>{
 const e=environment();try{const inner={...e.node.attrs.extension,instanceId:'x_'+'f'.repeat(32),type:'example.missing'},child=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:inner},schema.text('Hidden 😀')),outer=e.node.type.createChecked(e.node.attrs,[schema.text('Outer '),child]),initial=doc(paragraph(outer)),state=EditorState.create({schema,doc:initial,plugins:[inlineContainerPreservationPlugin(e.registry.resolve)]}),at=2+'Outer '.length
 assert.equal(state.applyTransaction(state.tr.insertText('Allowed ',2)).transactions.length,1);assert.equal(state.applyTransaction(state.tr.insertText('Bad ',at+1)).transactions.length,0);assert.equal(state.applyTransaction(state.tr.delete(0,state.doc.content.size)).transactions.length,0)
 const remote=state.tr.insertText('Peer ',at+1).setMeta('hcd-structure-remote/1',true);assert.equal(state.applyTransaction(remote).transactions.length,1)
 }finally{e.disconnect()}
})
test('an unavailable codec blocks personal undo of new content while retaining permanent bodies, and wire7 still rejects the model',()=>{
 const e=environment(),document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
 try{store.initialize(doc(paragraph(schema.text('Existing'))));const history=store.undoManager(true,before=>prepareInlineContainerHistoryGuard(before,e.registry.resolve))
 try{store.insert([paragraph(e.node)],store.keys()[0]);assert.equal(store.project().textContent,'AAA😀AAAExisting');e.unload();const bytes=Y.encodeStateAsUpdate(document);assert.throws(()=>history.undo(),/historyExtensionUnavailable/);assert.deepEqual(Y.encodeStateAsUpdate(document),bytes);assert.equal(store.flow.containers!.bodies.size,1);assert.throws(()=>new RoomProtocolGuard(document,structuralProtocol),/inline-container-model-unsupported/)}finally{history.destroy()}
 }finally{document.destroy();e.disconnect()}
})
test('host codecs materialize concurrent properties without replacing the independent body, and personal undo preserves peer changes',()=>{
 const registry=new InlineContainerRegistry([{...definition,defaultData:{title:'Label',done:false},fallback:data=>String(data.title)+(data.done?' ✓':'')}]),a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false}),left=new SemanticBlockStore(a,schema,undefined,{inlineContainers:true}),right=new SemanticBlockStore(b,schema,undefined,{inlineContainers:true})
 left.initialize(doc(paragraph(field(registry))));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const history=left.undoManager()
 const edit=(store:SemanticBlockStore,data:Record<string,unknown>,text?:string)=>{const current=store.project(),node=current.firstChild!.firstChild!,value=registry.update(node.attrs.extension,{...node.attrs.extension.data,...data}),tr=EditorState.create({schema,doc:current}).tr.setNodeMarkup(1,undefined,{...node.attrs,extension:value});store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})));if(text){const before=store.project(),transaction=EditorState.create({schema,doc:before}).tr.insertText(text,2);store.reconcile(store.blocks(),transaction.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}}
 try{edit(left,{title:'Alice'});history.stopCapturing();edit(right,{done:true},'Peer ');Y.applyUpdate(a,Y.encodeStateAsUpdate(b));materializeInlineContainerEdits(a,registry);Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.ok(left.project().eq(right.project()));assert.equal(left.project().firstChild!.firstChild!.attrs.extension.fallback.text,'Alice ✓');assert.equal(left.project().textContent,'Peer AAA😀AAA');history.undo();materializeInlineContainerEdits(a,registry);assert.equal(left.project().firstChild!.firstChild!.attrs.extension.fallback.text,'Label ✓');assert.equal(left.project().textContent,'Peer AAA😀AAA')}finally{history.destroy();a.destroy();b.destroy()}
})
