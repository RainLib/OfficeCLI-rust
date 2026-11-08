import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Editor,getSchema,type JSONContent} from '@tiptap/core'
import {EditorState,TextSelection,NodeSelection} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry,stableExtension} from './extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from './extensionNode.ts'
import {prepareNodeTransaction,selectedExtension} from './extensionCommands.ts'
import {prepareSlashTransaction} from './commands/slashTransaction.ts'
import {prepareBlockTransaction,blockTarget} from './commands/blocks.ts'
import {findSlash} from './commands/slash.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'
const definition:NodeExtensionDefinition={type:'example.task',version:1,display:'inline',label:{'en-US':'Task','zh-CN':'任务'},defaultData:{title:'Review',done:false},validate:data=>typeof data.title==='string'&&typeof data.done==='boolean',fallback:data=>`${data.done?'☑':'☐'} ${data.title}`,properties:[{key:'title',label:'Title',kind:'text',required:true,maxLength:40},{key:'done',label:'Done',kind:'boolean',required:true}]}
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function engine(registry:NodeExtensionRegistry,content:JSONContent[]=[{type:'paragraph',content:[{type:'text',text:'before '}]}]){
 const editor=new Editor({element:null,extensions:[...schemaExtensions,SemanticStructureIdentity],content:{type:'doc',content}})
 let current=EditorState.create({schema:editor.schema,doc:editor.schema.nodeFromJSON({type:'doc',content}),plugins:[extensionPreservationPlugin(()=>{},()=>registry)]}),editable=true,dispatches=0
 current=current.apply(current.tr.setSelection(TextSelection.atEnd(current.doc)))
 const view={get state(){return current},composing:false,get editable(){return editable},dispatch:(tr:EditorState['tr'])=>{dispatches++;current=current.applyTransaction(tr).state},focus:()=>{}}
 Object.defineProperties(editor,{view:{get:()=>view},state:{get:()=>current},isDestroyed:{get:()=>false},isEditable:{get:()=>editable}})
 return{editor,get:()=>current,change:(tr:EditorState['tr'])=>{current=current.applyTransaction(tr).state},readOnly:()=>{editable=false},dispatches:()=>dispatches,view}
}
test('node registration is atomic, copied and bounded, and duplicate ownership cannot detach another codec',()=>{
 const mutable={...definition,defaultData:{title:'Review',done:false},properties:[...definition.properties!]};const registry=new NodeExtensionRegistry([mutable]);mutable.defaultData.title='mutated';assert.equal(registry.create(definition.type).data.title,'Review');assert.ok(Object.isFrozen(registry.list()[0].label));const close=registry.connect()
 assert.throws(()=>registry.register([{...definition,type:'example.valid'},{...definition,type:'example.invalid',defaultData:{title:'',done:false}}]));assert.equal(registry.list().length,1)
 assert.throws(()=>registry.register([definition]));assert.equal(registry.list().length,1)
 const detach=registry.register([{...definition,type:'example.other'}]);assert.equal(registry.list().length,2);detach();detach();assert.equal(registry.list().length,1);close();assert.throws(()=>registry.register([{...definition,type:'example.late'}]))
})
test('business validation and deterministic fallback gate editing, unknown business versions remain readable',()=>{
 const registry=new NodeExtensionRegistry([definition]),node=registry.create(definition.type);assert.ok(registry.resolve(node));assert.equal(node.fallback.text,'☐ Review')
 for(const data of [{title:'',done:false},{title:'x'.repeat(41),done:false},{title:'Test',done:'yes'},{title:'Test',done:true,constructor:'invalid'}])assert.throws(()=>registry.update(node,data))
 assert.equal(registry.resolve({...node,version:2}),undefined);assert.equal(registry.resolve({...node,fallback:{text:'Unverified label'}}),undefined)
 const hostile={...definition,validate:(data:Readonly<Record<string,unknown>>)=>{(data as any).title='mutated';return true}};assert.throws(()=>new NodeExtensionRegistry([hostile]));assert.equal(node.data.title,'Review')
})
test('known atoms insert and update through checked single transactions; stale, revoked and invalid edits retain originals',()=>{
 for(const display of ['inline','block'] as const){
  const codec={...definition,display},registry=new NodeExtensionRegistry([codec]),f=engine(registry),insert=prepareNodeTransaction(f.editor,registry,'node.insert',{type:codec.type});assert.ok(insert);assert.equal(f.dispatches(),0);assert.equal(insert.commit(),true);assert.equal(f.dispatches(),1)
  const first=selectedExtension(f.get())!;assert.equal(first.value.display,display);assert.deepEqual(jsonToSnapshot(f.get().doc.toJSON()).flatMap(b=>[b.content.extension,...b.content.inlines.map(i=>i.extension)]).filter(Boolean),[first.value]);const expected=first.value
  const update=prepareNodeTransaction(f.editor,registry,'node.update',{instanceId:expected.instanceId,expected,data:{title:'Saved',done:true}})!;assert.equal(update.commit(),true);const next=selectedExtension(f.get())!;assert.equal(next.value.instanceId,expected.instanceId);assert.equal(next.value.fallback.text,'☑ Saved')
  assert.throws(()=>prepareNodeTransaction(f.editor,registry,'node.update',{instanceId:expected.instanceId,expected,data:{title:'Old form',done:false}}),/extensionChanged/)
  assert.throws(()=>prepareNodeTransaction(f.editor,registry,'node.update',{instanceId:next.value.instanceId,expected:next.value,data:{title:'',done:true}}));assert.equal(selectedExtension(f.get())!.value.fallback.text,'☑ Saved')
  f.readOnly();assert.equal(prepareNodeTransaction(f.editor,registry,'node.delete',{instanceId:next.value.instanceId,expected:next.value}),null)
 }
 const registry=new NodeExtensionRegistry(),close=registry.connect(),detach=registry.register([definition]),f=engine(registry);prepareNodeTransaction(f.editor,registry,'node.insert',{type:definition.type})!.commit();const node=selectedExtension(f.get())!.value,remove=prepareNodeTransaction(f.editor,registry,'node.delete',{instanceId:node.instanceId,expected:node})!;detach();assert.equal(remove.commit(),false);assert.equal(extensionNodes(f.get().doc).size,1);close()
})
test('missing codecs stay protected, known invalid payloads fail closed and unload immediately protects existing nodes',()=>{
 const registry=new NodeExtensionRegistry(),close=registry.connect(),detach=registry.register([definition]),f=engine(registry);prepareNodeTransaction(f.editor,registry,'node.insert',{type:definition.type})!.commit();const selected=selectedExtension(f.get())!,before=f.get().doc
 f.change(f.get().tr.setNodeMarkup(selected.position,undefined,{extension:{...selected.value,data:{title:'valid',done:'wrong'}}}));assert.equal(f.get().doc,before)
 f.change(f.get().tr.setNodeMarkup(selected.position,undefined,{extension:{...selected.value,version:99}}));assert.equal(f.get().doc,before)
 detach();f.change(f.get().tr.delete(selected.position,selected.position+selected.node.nodeSize));assert.equal(f.get().doc,before);close()
})
test('slash and block insertion stage a complete envelope without removing a trigger on stale content',()=>{
 for(const display of ['inline','block'] as const){
  const registry=new NodeExtensionRegistry([{...definition,display}]),f=engine(registry,[{type:'paragraph',content:[{type:'text',text:'before /task'}]}]),value=registry.create(definition.type),target={...findSlash(f.get())!,anchor:'current'},commit=prepareSlashTransaction(f.editor,'node.insert',{extension:value},target);assert.ok(commit);assert.equal(commit(),true);assert.equal(extensionNodes(f.get().doc).size,1);assert.doesNotMatch(f.get().doc.textContent,/\/task/)
  const g=engine(registry),block=blockTarget(g.get(),undefined,'after')!,insert=prepareBlockTransaction(g.editor,'node.insert',{extension:registry.create(definition.type)},block);assert.ok(insert);assert.equal(insert(),true);assert.equal(extensionNodes(g.get().doc).size,1)
  const h=engine(registry,[{type:'paragraph',content:[{type:'text',text:'/task'}]}]),staged=prepareSlashTransaction(h.editor,'node.insert',{extension:registry.create(definition.type)},{...findSlash(h.get())!,anchor:'x'})!;h.change(h.get().tr.insertText(' peer',1));assert.equal(staged(),false);assert.match(h.get().doc.textContent,/\/task/)
 }
})
test('custom payload updates converge through real Yjs and own undo preserves peer text',()=>{
 const registry=new NodeExtensionRegistry([definition]),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),value=registry.create(definition.type)
 sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'text '},{type:'hcdExtensionInline',attrs:{extension:value}}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager();undo.stopCapturing()
 const current=sa.blocks(),entry=extensionNodes(sa.project()).get(value.instanceId)!,updated=registry.update(entry.value,{title:'Collaborative',done:true}),tr=EditorState.create({doc:sa.project(),schema}).tr.setNodeMarkup(entry.position,undefined,{extension:updated});sa.reconcile(current,current.map((block,index)=>({key:block.key,node:tr.doc.child(index)})))
 Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.equal(extensionNodes(sb.project()).get(value.instanceId)!.value.fallback.text,'☑ Collaborative')
 const peer=sb.blocks(),p=sb.project(),pt=EditorState.create({doc:p,schema}).tr.insertText('Peer ',1);sb.reconcile(peer,peer.map((block,index)=>({key:block.key,node:pt.doc.child(index)})));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));undo.undo();assert.match(sa.project().textContent,/Peer/);assert.equal(stableExtension(extensionNodes(sa.project()).get(value.instanceId)!.value),stableExtension(value));undo.redo();assert.equal(stableExtension(extensionNodes(sa.project()).get(value.instanceId)!.value),stableExtension(updated));undo.destroy();a.destroy();b.destroy()
})

test('extension block structure identity survives peer edits and receipt normalization without duplicate roots',()=>{
 const registry=new NodeExtensionRegistry([{...definition,display:'block'}]),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema),payload=registry.create(definition.type)
 sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionBlock',attrs:{extension:payload}},{type:'paragraph',content:[{type:'text',text:'body'}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const original=sa.blocks()[0].key
 // Simulate older persisted atoms that had no schema identity attributes. The
 // authoritative map key/owner must repair the projection, never allocate again.
 a.transact(()=>{sa.attributes.get(original)!.delete('hcdStructureKey');sa.attributes.get(original)!.delete('hcdCanonicalKey')});Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 for(const [store,peer]of [[sa,sb],[sb,sa]] as const){const before=store.blocks(),doc=store.project();assert.equal(doc.child(0).attrs.hcdStructureKey,original);const tr=EditorState.create({schema,doc}).tr.insertText(' peer',doc.content.size-1);const proposed=tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node}));store.reconcile(before,proposed);Y.applyUpdate(peer.document,Y.encodeStateAsUpdate(store.document));assert.equal(store.blocks().length,2);assert.equal(peer.blocks().length,2);assert.equal(extensionNodes(peer.project()).size,1);assert.equal(peer.blocks()[0].key,original)}
 a.destroy();b.destroy()
})

test('duplicate extension occurrences are rejected before changing the shared document',()=>{
 const registry=new NodeExtensionRegistry([{...definition,display:'block'}]),document=new Y.Doc(),store=new SemanticBlockStore(document,schema),payload=registry.create(definition.type);store.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionBlock',attrs:{extension:payload}}]}));const before=Y.encodeStateAsUpdate(document),blocks=store.blocks();assert.throws(()=>store.reconcile(blocks,[{key:blocks[0].key,node:blocks[0].node},{node:blocks[0].node}]));assert.deepEqual(Y.encodeStateAsUpdate(document),before);assert.equal(store.blocks().length,1);document.destroy()
})

test('host menu receives a frozen selected envelope and updates through the shared command adapter',async()=>{
 const {CommandRegistry}=await import('./commands/registry.ts'),{semanticSelection}=await import('./commands/semantic.ts'),registry=new NodeExtensionRegistry([definition]),f=engine(registry);prepareNodeTransaction(f.editor,registry,'node.insert',{type:definition.type})!.commit()
 const service=new CommandRegistry(()=>({instanceId:'instance',documentId:'doc',format:'docx',profile:'flow',locale:'en-US',platform:'other',ready:true,readOnly:false,revision:1,historical:false,selection:semanticSelection(f.editor,0),capabilities:{customNodes:true},actions:{'node.update':{enabled:true}}}),(id,input)=>{const prepared=prepareNodeTransaction(f.editor,registry,id,input);return prepared?.commit()?prepared.value:false},[{id:'node.update',label:'Update',allowProtectedSelection:true,surfaces:[]}],{commands:[{id:'task.complete',label:'Complete',allowProtectedSelection:true,execute:({context,commands})=>{const node=context.selection.extension!;assert.ok(Object.isFrozen(node.data));assert.throws(()=>{node.data.title='mutated'});return commands.run('node.update',{instanceId:node.instanceId,expected:node,data:{...node.data,done:true}})}}]})
 const close=service.connect();assert.equal(service.capabilities().customNodes,'atomic-v1');assert.equal(service.context().selection.nodeId,selectedExtension(f.get())!.value.instanceId);await service.execute('task.complete');assert.equal(selectedExtension(f.get())!.value.fallback.text,'☑ Review');close()
})

test('known atom deletion is explicit, identity checked, and leaves unrelated content untouched',()=>{
 for(const display of ['inline','block'] as const){const registry=new NodeExtensionRegistry([{...definition,display}]),f=engine(registry);prepareNodeTransaction(f.editor,registry,'node.insert',{type:definition.type})!.commit();const value=selectedExtension(f.get())!.value;assert.throws(()=>prepareNodeTransaction(f.editor,registry,'node.delete',{instanceId:'x_'+'0'.repeat(32),expected:value}));const remove=prepareNodeTransaction(f.editor,registry,'node.delete',{instanceId:value.instanceId,expected:value})!;assert.equal(remove.commit(),true);assert.equal(extensionNodes(f.get().doc).size,0);assert.match(f.get().doc.textContent,/before/)}
 const registry=new NodeExtensionRegistry([],()=>{throw new Error('host logger failed')});assert.doesNotThrow(()=>registry.error(new Error('view failed')))
})

test('migration requires the explicit checked transaction; stale previews, readonly and unloaded codecs retain the original',()=>{
 for(const display of ['inline','block'] as const){
  const oldRegistry=new NodeExtensionRegistry([{...definition,display}]),source=oldRegistry.create(definition.type),codec={...definition,display,version:2,defaultData:{...definition.defaultData,priority:1},fallback:(data:Readonly<Record<string,unknown>>)=>`${data.title} · ${data.priority}`,migrations:[{fromVersion:1,validate:definition.validate,migrate:(data:Readonly<Record<string,unknown>>)=>({...data,priority:1})}]},registry=new NodeExtensionRegistry([codec])
  const content:JSONContent[]=display==='inline'?[{type:'paragraph',content:[{type:'hcdExtensionInline',attrs:{extension:source}}]},{type:'paragraph',content:[{type:'text',text:'Body'}]}]:[{type:'hcdExtensionBlock',attrs:{extension:source}},{type:'paragraph',content:[{type:'text',text:'Body'}]}]
  const select=(f:ReturnType<typeof engine>)=>{const entry=extensionNodes(f.get().doc).get(source.instanceId)!;f.change(f.get().tr.setSelection(NodeSelection.create(f.get().doc,entry.position)))}
  const f=engine(registry,content);select(f);const before=f.get().doc,preview=registry.previewMigration(source)!
  const position=selectedExtension(f.get())!.position
  f.change(f.get().tr.setNodeMarkup(position,undefined,{...f.get().doc.nodeAt(position)!.attrs,extension:preview.after}));assert.equal(f.get().doc,before)
  assert.throws(()=>prepareNodeTransaction(f.editor,registry,'node.migrate',{instanceId:source.instanceId,expected:source,after:{...preview.after,version:99}}),/extensionChanged/)
  const prepared=prepareNodeTransaction(f.editor,registry,'node.migrate',{instanceId:source.instanceId,expected:source,after:preview.after})!
  assert.equal(f.get().doc,before);assert.equal(prepared.commit(),true);assert.deepEqual(selectedExtension(f.get())!.value,preview.after)
  const g=engine(registry,content);select(g);const stale=prepareNodeTransaction(g.editor,registry,'node.migrate',{instanceId:source.instanceId,expected:source,after:preview.after})!;g.change(g.get().tr.insertText('Peer ',g.get().doc.content.size-1));assert.equal(stale.commit(),false);assert.equal(extensionNodes(g.get().doc).get(source.instanceId)!.value.version,1)
  const h=engine(registry,content);select(h);const revoked=prepareNodeTransaction(h.editor,registry,'node.migrate',{instanceId:source.instanceId,expected:source,after:preview.after})!;h.readOnly();assert.equal(revoked.commit(),false)
  const dynamic=new NodeExtensionRegistry(),close=dynamic.connect(),detach=dynamic.register([codec]),j=engine(dynamic,content);select(j);const unloaded=prepareNodeTransaction(j.editor,dynamic,'node.migrate',{instanceId:source.instanceId,expected:source,after:preview.after})!;detach();assert.equal(unloaded.commit(),false);close()
 }
})
