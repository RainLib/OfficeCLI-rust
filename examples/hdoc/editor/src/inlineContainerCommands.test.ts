import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState,NodeSelection,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {InlineContainerRegistry,type InlineContainerDefinition} from './inlineContainerRegistry.ts'
import {prepareInlineContainerTransaction,selectedInlineContainer} from './inlineContainerCommands.ts'
import {inlineContainerPreservationPlugin,authorizeInlineContainerMigration} from './inlineContainerPreservation.ts'
import {inlineContainerEditIndex,materializeInlineContainerEdits} from './inlineContainerEdits.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {prepareNodeTransaction} from './extensionCommands.ts'
import {CommandRegistry,CommandError} from './commands/registry.ts'
import {builtinCommands} from './commands/builtins.ts'
import type {CommandContext} from './commands/types.ts'
import {semanticSelection} from './commands/semantic.ts'
import {IDBFactory} from 'fake-indexeddb'
import {NodeResourceJournal} from './nodeResourceJournal.ts'
import {InlineNodeResourceClient,nodeResourceHash} from './wordNodeResources.ts'

const definition:InlineContainerDefinition={type:'example.field',version:1,display:'inline',contentModel:'inline',label:{'zh-CN':'业务字段','en-US':'Business field'},defaultData:{title:'Initial'},validate:data=>typeof data.title==='string'&&!!data.title,fallback:data=>String(data.title),properties:[{key:'title',label:'Title',kind:'text',required:true}]}
function environment(document=new Y.Doc({gc:false}),registry=new InlineContainerRegistry([definition])){
 const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),structure=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true}),release=registry.connect()
 if(!structure.initialized)structure.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.text('Outside'))))
 let editable=true,composing=false,destroyed=false,state=EditorState.create({schema}),binding:PluginView|undefined
 const errors:unknown[]=[],plugin=semanticStructureBinding(structure,{canWrite:()=>editable,onError:error=>errors.push(error)})
 state=EditorState.create({schema,doc:structure.project(),plugins:[sourceIdentityPlugin(),inlineContainerPreservationPlugin(registry.resolve,error=>errors.push(error),()=>registry),plugin]})
 const view={get state(){return state},get composing(){return composing},focus(){},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 const editor={get state(){return state},get schema(){return schema},get view(){return view},get isEditable(){return editable},get isDestroyed(){return destroyed}} as unknown as Editor
 const prepare=(id:string,input:unknown)=>prepareInlineContainerTransaction(editor,registry,id,input)
 return{document,registry,structure,editor,errors,prepare,ready:new Promise<void>(resolve=>queueMicrotask(resolve)),get:()=>state,dispatch:view.dispatch,flags:(next:{editable?:boolean;composing?:boolean;destroyed?:boolean})=>{editable=next.editable??editable;composing=next.composing??composing;destroyed=next.destroyed??destroyed},select:(pos:number)=>view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc,pos))),close(){binding?.destroy?.();release();document.destroy()}}
}
function insert(e:ReturnType<typeof environment>){const prepared=e.prepare('node.insert',{model:'inline',type:'example.field'})!;assert.ok(prepared?.commit(),e.errors.map(String).join('; '));return selectedInlineContainer(e.get())!}
function request(e:ReturnType<typeof environment>,extra:object={}){const selected=selectedInlineContainer(e.get())!;return{instanceId:selected.value.instanceId,expected:selected.value,...extra}}
function bodyItems(body:Y.XmlText){const ids:string[]=[];for(let item=body._start;item;item=item.right)if(!item.deleted&&item.countable)for(let n=0;n<item.length;n++)ids.push(`${item.id.client}:${item.id.clock+n}`);return ids}

test('inline registrations supply every command surface but cannot execute without explicit model capability',async()=>{
 const e=environment();let enabled=false,readOnly=false
 const context=():CommandContext=>({instanceId:'one',documentId:'doc',format:'html',profile:'flow',locale:'zh-CN',platform:'mac',ready:true,readOnly,historical:false,revision:8,selection:{kind:'text',empty:e.get().selection.empty,anchor:String(e.get().selection.from),protected:false,text:'',parentTypes:['paragraph']},actions:{'node.insert':{enabled:true}},capabilities:{customNodes:true,inlineContainers:enabled}})
 const service=new CommandRegistry(context,(id,input)=>{const p=e.prepare(id,input);return p?.commit()?p.value:true},builtinCommands,{commands:e.registry.commands()}),close=service.connect(),id='node.inline.insert.example.field'
 try{for(const surface of ['ribbon','context','slash','block','palette'] as const){const item=service.list(surface,'业务')[0];assert.equal(item?.id,id);assert.equal(item.enabled,false)}
  await assert.rejects(service.execute(id),error=>error instanceof CommandError&&error.code==='unavailable');enabled=true;service.refresh();assert.equal(service.item(id)?.enabled,true);assert.equal((await service.execute(id) as {schemaVersion:string}).schemaVersion,'hcd.extension/3');assert.ok(selectedInlineContainer(e.get()));readOnly=true;service.refresh();await assert.rejects(service.execute(id),error=>error instanceof CommandError&&error.code==='readOnly')
 }finally{close();e.close()}
})
test('property and resource commands keep real body items and canonical wrapper attributes unchanged',async()=>{
 const e=environment();await e.ready;try{const selected=insert(e),id=selected.value.instanceId,pos=selected.position;e.dispatch(e.get().tr.insertText('AAA😀AAA',pos+1));e.select(pos)
  const body=e.structure.flow.containers!.bodies.get(id)!,original=bodyItems(body),attrs={...selected.node.attrs},update=e.prepare('node.update',request(e,{data:{title:'Updated'}}))!;assert.ok(update.commit());assert.equal(selectedInlineContainer(e.get())!.value.fallback.text,'Updated');assert.deepEqual(bodyItems(body),original);assert.equal(body.toString(),'AAA😀AAA')
  const resource={key:'file',hash:'a'.repeat(64),byteLength:3,name:'note.txt',mediaType:'text/plain'},resources=e.prepare('node.resources',request(e,{resources:[resource]}))!;assert.ok(resources.commit());assert.deepEqual(selectedInlineContainer(e.get())!.value.resources,[resource]);assert.deepEqual(bodyItems(body),original)
  const next=selectedInlineContainer(e.get())!.node;for(const[key,value]of Object.entries(attrs))if(key!=='extension')assert.deepEqual(next.attrs[key],value);assert.deepEqual(e.errors,[])
 }finally{e.close()}
})
test('stale selection, continued body input, composing and revoked write permission never commit a staged envelope',async()=>{
 const e=environment();await e.ready;try{const at=insert(e).position,stage=()=>e.prepare('node.update',request(e,{data:{title:'Never'}}))!
  let prepared=stage();e.dispatch(e.get().tr.setSelection(TextSelection.create(e.get().doc,at+1)));assert.equal(prepared.commit(),false);e.select(at)
  prepared=stage();e.dispatch(e.get().tr.insertText('Peer-like input',at+1));assert.equal(prepared.commit(),false);e.select(at)
  prepared=stage();e.flags({composing:true});assert.equal(prepared.commit(),false);assert.equal(e.prepare('node.update',request(e,{data:{title:'Never'}})),null);e.flags({composing:false})
  prepared=stage();e.flags({editable:false});assert.equal(prepared.commit(),false);assert.equal(selectedInlineContainer(e.get())!.value.data.title,'Initial')
 }finally{e.close()}
})
test('registry disposal cancels staged commits; a prior effect cleanup cannot dispose a newer connection',async()=>{
 const e=environment();await e.ready;try{insert(e);const prepared=e.prepare('node.update',request(e,{data:{title:'Never'}}))!,old=e.registry.connect(),current=e.registry.connect();old();assert.ok(e.registry.resolve(selectedInlineContainer(e.get())!.value));current();assert.equal(prepared.commit(),false);assert.equal(e.registry.resolve(selectedInlineContainer(e.get())!.value),undefined);assert.throws(()=>e.registry.create('example.field'),/Disposed/)}finally{e.close()}
})
test('deletion hides a permanent body and personal undo/redo retains independent text',async()=>{
 const e=environment();await e.ready;try{const selected=insert(e),id=selected.value.instanceId;e.dispatch(e.get().tr.insertText('Retained',selected.position+1));e.select(selected.position);const history=e.structure.undoManager(false)
  try{assert.ok(e.prepare('node.delete',request(e))!.commit());assert.equal(e.structure.flow.containers!.readBody(id).textContent,'Retained');assert.equal(e.structure.project().textContent,'Outside');history.undo();assert.equal(e.structure.project().textContent,'RetainedOutside');history.redo();assert.equal(e.structure.project().textContent,'Outside')}finally{history.destroy()}
 }finally{e.close()}
})
test('an explicit migration changes only the envelope; forged migration metadata or combined body edits are refused',async()=>{
 const old=new InlineContainerRegistry([definition]),value=old.create('example.field'),registry=new InlineContainerRegistry([{...definition,version:2,migrations:[{fromVersion:1,validate:definition.validate,migrate:data=>({title:data.title+' v2'})}]}]),e=environment(undefined,registry)
 await e.ready;try{const node=e.editor.schema.nodes.hcdExtensionInlineContainer.createChecked({extension:value},e.editor.schema.text('Permanent 😀'));e.structure.insert([e.editor.schema.nodes.paragraph.createChecked(null,node)],e.structure.keys()[0]);e.select(1)
  const preview=registry.previewMigration(value)!,before=e.get().doc,body=e.structure.flow.containers!.bodies.get(value.instanceId)!,original=bodyItems(body),forged=e.get().tr.setNodeMarkup(1,undefined,{...node.attrs,extension:preview.after}).setMeta('hcd-inline-migration',{before:value,after:preview.after});e.dispatch(forged);assert.ok(e.get().doc.eq(before))
  const combined=e.get().tr.setNodeMarkup(1,undefined,{...node.attrs,extension:preview.after}).insertText('Unauthorized ',2);authorizeInlineContainerMigration(combined,registry,value,preview.after);e.dispatch(combined);assert.ok(e.get().doc.eq(before))
  const command=e.prepare('node.migrate',request(e,{after:preview.after}))!;assert.ok(command.commit());assert.equal(selectedInlineContainer(e.get())!.value.version,2);assert.equal(selectedInlineContainer(e.get())!.node.textContent,'Permanent 😀');assert.deepEqual(bodyItems(body),original);assert.equal(e.structure.flow.containers!.definitions.get(value.instanceId)!.node.attrs.extension.version,1);assert.equal(inlineContainerEditIndex(e.document).get(value.instanceId)!.value.version,2)
 }finally{e.close()}
})
test('concurrent command properties and peer typing merge while personal undo preserves peer content',async()=>{
 const a=environment();await a.ready;insert(a);const value=selectedInlineContainer(a.get())!,position=value.position;a.dispatch(a.get().tr.insertText('Original',position+1));a.select(position)
 const peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=environment(peer),history=a.structure.undoManager(false)
 await b.ready;try{b.select(position);assert.ok(a.prepare('node.update',request(a,{data:{title:'Alice'}}))!.commit());b.dispatch(b.get().tr.insertText('Peer ',position+1));Y.applyUpdate(a.document,Y.encodeStateAsUpdate(peer));materializeInlineContainerEdits(a.document,a.registry);assert.equal(a.structure.flow.containers!.readBody(value.value.instanceId).textContent,'Peer Original');history.undo();materializeInlineContainerEdits(a.document,a.registry);assert.equal(a.structure.flow.containers!.readBody(value.value.instanceId).attrs.extension.data.title,'Initial');assert.equal(a.structure.flow.containers!.readBody(value.value.instanceId).textContent,'Peer Original')}
 finally{history.destroy();a.close();b.close()}
})
test('the ordinary node adapter refuses the inline model and two registries stay isolated',async()=>{
 const e=environment(),other=new InlineContainerRegistry(),normal=new NodeExtensionRegistry([{...definition,display:'inline',contentModel:undefined}])
 await e.ready;try{assert.equal(prepareNodeTransaction(e.editor,normal,'node.insert',{model:'inline',type:'example.field'}),null);assert.equal(other.list().length,0);assert.equal(e.registry.list().length,1);assert.equal(e.prepare('node.insert',{type:'example.field'}),null)}finally{e.close()}
})
test('an inline wrapper selection survives remote property projection and body/prefix edits, then falls back only when removed',async()=>{
 const a=environment();await a.ready;const selected=insert(a);a.dispatch(a.get().tr.insertText('正文😀',selected.position+1));a.select(selected.position)
 const doc=new Y.Doc({gc:false});Y.applyUpdate(doc,Y.encodeStateAsUpdate(a.document));const b=environment(doc);await b.ready
 try{
  b.select(selected.position);assert.ok(b.prepare('node.update',request(b,{data:{title:'Peer label'}}))!.commit());Y.applyUpdate(a.document,Y.encodeStateAsUpdate(doc));materializeInlineContainerEdits(a.document,a.registry)
  assert.equal(selectedInlineContainer(a.get())?.value.instanceId,selected.value.instanceId);assert.equal(selectedInlineContainer(a.get())?.value.data.title,'Peer label')
  b.dispatch(b.get().tr.insertText('同伴',selected.position+1));Y.applyUpdate(a.document,Y.encodeStateAsUpdate(doc));assert.equal(selectedInlineContainer(a.get())?.node.textContent,'同伴正文😀')
  b.dispatch(b.get().tr.insertText('前缀 ',1));Y.applyUpdate(a.document,Y.encodeStateAsUpdate(doc));assert.equal(selectedInlineContainer(a.get())?.value.instanceId,selected.value.instanceId);assert.ok(selectedInlineContainer(a.get())!.position>selected.position)
  const at=selectedInlineContainer(a.get())!.position;b.select(at);assert.ok(b.prepare('node.delete',request(b))!.commit());Y.applyUpdate(a.document,Y.encodeStateAsUpdate(doc));assert.equal(selectedInlineContainer(a.get()),null);assert.deepEqual(a.errors,[])
 }finally{a.close();b.close()}
})

test('recovered file attachment uses the fresh normal command and personal undo retains peer metadata and body',async()=>{
 const a=environment();await a.ready
 const selected=insert(a),id=selected.value.instanceId,position=selected.position
 a.dispatch(a.get().tr.insertText('Permanent 😀',position+1));a.select(position)
 const factory=new IDBFactory(),name='hcd-local-draft-v1-'+'c'.repeat(64)+'-0-inlinecontainers1-nodefiles1',cache=await NodeResourceJournal.openInline(name,factory)
 let fail=true,uploads=0
 const resources=new NodeExtensionRegistry([],()=>{},{archive:async input=>{uploads++;if(fail)throw Error('transport interrupted');return{key:input.key,name:input.name,mediaType:input.file.type,byteLength:input.file.size,hash:await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()))}},read:async()=>new Blob()}),release=resources.connect()
 let client=new InlineNodeResourceClient({cache,registry:resources,ready:()=>true});await client.initialize()
 const peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=environment(peer);await b.ready
 let history:ReturnType<typeof a.structure.undoManager>|undefined
 try{
  const originalBytes=new TextEncoder().encode('Original private file 😀')
  await assert.rejects(client.start(new File([originalBytes],'recovery.txt',{type:'text/plain'}),selected.value,'body'),/transport interrupted/)
  const pending=(await cache.pendingNodeResources())[0];assert.equal(pending.phase,'chosen');assert.deepEqual(pending.bytes,originalBytes)
  client.dispose();client=new InlineNodeResourceClient({cache,registry:resources,ready:()=>true});await client.initialize();assert.equal(uploads,1,'Reopening must not upload')
  // A portable import has a deterministic new local choice ID. The original
  // cancelled choice stays terminal, independently of this explicit import.
  await client.cancel(pending.id)
  const imported={...structuredClone(pending),id:'11111111-2222-3333-4444-555555555555'}
  assert.equal(await cache.importNodeResources([imported]),1);await client.refresh();assert.equal(uploads,1)
  b.select(position);assert.ok(b.prepare('node.update',request(b,{data:{title:'Peer property'}}))!.commit())
  b.dispatch(b.get().tr.insertText('Peer ',position+1));Y.applyUpdate(a.document,Y.encodeStateAsUpdate(peer));materializeInlineContainerEdits(a.document,a.registry);a.select(position)
  const body=a.structure.flow.containers!.bodies.get(id)!,bodyIdentity=bodyItems(body),fresh=selectedInlineContainer(a.get())!.value
  assert.equal(fresh.data.title,'Peer property');assert.equal(body.toString(),'Peer Permanent 😀');assert.equal(imported.expected.data.title,'Initial')
  history=a.structure.undoManager(false);fail=false
  const commit=async()=>{
   await client.attach(imported.id,async staged=>{
    const prepared=a.prepare('node.resources',{instanceId:id,expected:fresh,resources:[staged.resource]})
    if(!prepared?.commit())throw Error('normal command refused')
    return selectedInlineContainer(a.get())!.value
   })
  }
  // A stale file snapshot is not permission to overwrite the peer envelope.
  assert.throws(()=>a.prepare('node.resources',{instanceId:id,expected:imported.expected,resources:[imported.resource]}),/extensionChanged/)
  await commit();assert.equal(client.state().pending,false);assert.deepEqual(await cache.pendingNodeResources(),[])
  assert.equal(selectedInlineContainer(a.get())!.value.data.title,'Peer property');assert.deepEqual(bodyItems(body),bodyIdentity)
  assert.equal(history.undoStack.length,1);history.undo();materializeInlineContainerEdits(a.document,a.registry)
  assert.deepEqual(selectedInlineContainer(a.get())!.value.resources??[],[]);assert.equal(selectedInlineContainer(a.get())!.value.data.title,'Peer property');assert.equal(body.toString(),'Peer Permanent 😀')
  history.redo();materializeInlineContainerEdits(a.document,a.registry)
  assert.deepEqual(selectedInlineContainer(a.get())!.value.resources,[imported.resource]);assert.deepEqual(bodyItems(body),bodyIdentity)
  assert.equal(await cache.importNodeResources([imported]),0,'A linked import must not become pending again')
  assert.equal(await cache.importNodeResources([pending]),0,'The original cancelled choice stays cancelled')
  assert.deepEqual(a.errors,[])
 }finally{history?.destroy();client.dispose();release();await cache.close();a.close();b.close()}
})
test('command selection protects unloaded inline codecs, including caret ancestors and ranges across wrappers',async()=>{
 const e=environment(),missing=new InlineContainerRegistry();await e.ready
 try{
  const selected=insert(e);e.dispatch(e.get().tr.insertText('内容😀',selected.position+1));e.select(selected.position)
  const known=semanticSelection(e.editor,0,e.registry)
  assert.equal(known.protected,false);assert.equal(known.extension?.schemaVersion,'hcd.extension/3');assert.equal(known.nodeId,selected.value.instanceId)
  assert.equal(semanticSelection(e.editor,0).protected,true);assert.equal(semanticSelection(e.editor,0,missing).protected,true)
  e.dispatch(e.get().tr.setSelection(TextSelection.create(e.get().doc,selected.position+2)))
  assert.equal(semanticSelection(e.editor,0,e.registry).protected,false);assert.equal(semanticSelection(e.editor,0,missing).protected,true)
  e.dispatch(e.get().tr.setSelection(TextSelection.create(e.get().doc,1,e.get().doc.content.size-1)))
  assert.equal(semanticSelection(e.editor,0,e.registry).protected,false);assert.equal(semanticSelection(e.editor,0,missing).protected,true)
  e.select(selected.position);const dispose=e.registry.connect();dispose();assert.equal(semanticSelection(e.editor,0,e.registry).protected,true)
 }finally{e.close()}
})
