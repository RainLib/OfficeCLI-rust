import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import type {Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from './extensionNode.ts'
import {InlineContainerRegistry,type InlineContainerDefinition} from './inlineContainerRegistry.ts'
import {inlineContainerNodes} from './inlineContainerEdits.ts'
import {inlineContainerPreservationPlugin,prepareInlineContainerHistoryGuard} from './inlineContainerPreservation.ts'
import {documentReferences} from './referenceEdits.ts'
import {blockTarget,rootBlocks,blockActionStates,prepareBlockTransaction,transformBlocks,protectedBlock,blockDestinations,operableBlockEntry,type BlockTarget} from './commands/blocks.ts'
import {deletionReviews,canConfirmDeletion} from './deletionReview.ts'

const schema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode])
const definition:InlineContainerDefinition={type:'example.block_field',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{title:'Field'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}
const atom={type:'example.atom',version:1,display:'inline' as const,label:'Atom',defaultData:{},validate:()=>true,fallback:()=> 'Badge'},rich={...atom,type:'example.rich',display:'block' as const,contentModel:'blocks' as const}
function engine(document=new Y.Doc({gc:false}),wrap=false,unknownNested=false){
 const nodes=new NodeExtensionRegistry([atom,rich]),closeNodes=nodes.connect(),inline=new InlineContainerRegistry(),closeInline=inline.connect(),detach=inline.register([definition]),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
 if(!store.initialized){
  const resource={key:'note',hash:'a'.repeat(64),byteLength:4,name:'note.txt',mediaType:'text/plain'},outer=inline.create(definition.type,{title:'Outer'},[resource]),inner=inline.create(definition.type,{title:'Inner'},[resource])
  const nested=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:unknownNested?{...inner,version:77}:inner,hcdSourceId:'n_'+'b'.repeat(32),hcdSourceTypography:{family:'Serif',sizePt:12}},schema.text('内层😀',[schema.marks.italic.create()]))
  const mention=schema.nodes.hcdMention.createChecked({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}}})
  const body=schema.nodes.hcdExtensionInlineContainer.createChecked({extension:outer,hcdSourceId:'n_'+'c'.repeat(32)},[schema.text('Outer text ',[schema.marks.bold.create()]),nested,mention,schema.nodes.hcdExtensionInline.createChecked({extension:nodes.create(atom.type)}),schema.nodes.hardBreak.create(),schema.text('End')])
  const paragraph=schema.nodes.paragraph.createChecked(null,[schema.text('Before '),body,schema.text(' after')]),middle=wrap?schema.nodes.hcdExtensionContainer.createChecked({extension:nodes.create(rich.type)},[paragraph]):paragraph
  store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,schema.text('First')),middle,schema.nodes.paragraph.createChecked(null,schema.text('Last'))]))
 }
 const errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>editable,onError:error=>errors.push(error)});let editable=true,binding:PluginView|undefined
 let state=EditorState.create({schema,doc:store.project(),plugins:[sourceIdentityPlugin(),extensionPreservationPlugin(()=>errors.push(Error('unsupportedPaste')),()=>nodes),inlineContainerPreservationPlugin(inline.resolve,error=>errors.push(error),()=>inline),plugin]})
 const view={get state(){return state},composing:false,focus(){},dispatch(tr:Transaction){const previous=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,previous)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 const editor={isDestroyed:false,get isEditable(){return editable},get state(){return state},view} as unknown as Editor
 const target=(index=1)=>blockTarget(state,rootBlocks(state.doc).slice(index,index+1))!
 return{nodes,inline,store,document,errors,editor,get:()=>state,dispatch:view.dispatch,target,detach,setEditable:(value:boolean)=>{editable=value},run:(id:string,at:BlockTarget=target())=>{const apply=prepareBlockTransaction(editor,id,undefined,at);assert.ok(apply,id);assert.ok(apply(),errors.map(String).join('; '));return state.doc},close(){binding?.destroy?.();detach();closeNodes();closeInline();document.destroy()}}
}
const sync=(a:ReturnType<typeof engine>,b:ReturnType<typeof engine>)=>{const x=Y.encodeStateAsUpdate(a.document),y=Y.encodeStateAsUpdate(b.document);Y.applyUpdate(a.document,y);Y.applyUpdate(b.document,x)}
function nodeAt(doc:PmNode,id:string){let entry:{node:PmNode;position:number}|undefined;doc.descendants((node,position)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===id)entry={node,position}});assert.ok(entry);return entry}

for(const wrap of [false,true])test(`whole ${wrap?'rich container':'paragraph'} duplication creates fresh recursive identities and source ranges without losing resources`,()=>{
 const e=engine(undefined,wrap)
 try{
  const before=e.get().doc.child(1),oldBodies=[...inlineContainerNodes(before).values()],oldAtoms=[...extensionNodes(before).keys()],oldMentions=[...documentReferences(before).keys()]
  const actions=blockActionStates(e.get(),e.target());assert.equal(actions['block.duplicate'].enabled,true);assert.equal(actions['block.code'].enabled,false)
  e.run('block.duplicate');const original=e.get().doc.child(1),copy=e.get().doc.child(2),newBodies=[...inlineContainerNodes(copy).values()]
  assert.equal(original.textContent,before.textContent);assert.equal(copy.textContent,before.textContent);assert.equal(newBodies.length,2)
  assert.equal(new Set([...oldBodies,...newBodies].map(value=>value.instanceId)).size,4)
  for(let i=0;i<2;i++){assert.deepEqual({...newBodies[i],instanceId:oldBodies[i].instanceId},oldBodies[i]);const node=nodeAt(e.get().doc,newBodies[i].instanceId).node;assert.equal(node.attrs.hcdSourceId,null);assert.ok(e.store.flow.containers!.bodies.has(newBodies[i].instanceId));assert.equal(e.store.flow.containers!.readBody(newBodies[i].instanceId).textContent,node.textContent)}
  for(const id of extensionNodes(copy).keys())assert.ok(!oldAtoms.includes(id));for(const id of documentReferences(copy).keys())assert.ok(!oldMentions.includes(id))
  copy.descendants(node=>{assert.ok(!node.marks.some(mark=>mark.type.name==='hcdSource'));if(node.isText&&node.text==='内层😀'){assert.ok(node.marks.some(mark=>mark.type.name==='italic'));assert.equal(node.marks.find(mark=>mark.type.name==='textTypography')?.attrs.sizePt,12)}})
  assert.equal(jsonToSnapshot(e.get().doc.toJSON(),{inlineContainers:true}).length,4);assert.deepEqual(e.errors,[])
 }finally{e.close()}
})
for(const action of ['block.heading','block.bulletList','block.orderedList','block.quote','block.paragraph'])test(`paragraph ${action} retains every live inline carrier and canonical identity`,()=>{
 const e=engine()
 try{const before=[...inlineContainerNodes(e.get().doc)].map(([id,value])=>[id,value]),body=e.store.flow.containers!.bodies,items=[...body].map(([id,text])=>[id,Y.createRelativePositionFromTypeIndex(text,0)])
  assert.equal(blockActionStates(e.get(),e.target())[action].enabled,true);e.run(action);assert.deepEqual([...inlineContainerNodes(e.get().doc)].map(([id,value])=>[id,value]),before)
  for(const[id,relative]of items as Array<[string,Y.RelativePosition]>){const resolved=Y.createAbsolutePositionFromRelativePosition(relative,e.document);assert.equal(resolved?.type,body.get(id))}
  assert.equal(documentReferences(e.get().doc).size,1);e.get().doc.check();jsonToSnapshot(e.get().doc.toJSON(),{inlineContainers:true});assert.deepEqual(e.errors,[])
 }finally{e.close()}
})
test('code and rule conversion cannot erase a nonempty inline body even when directly requested',()=>{
 const e=engine()
 try{for(const action of ['block.code','block.divider']){assert.equal(blockActionStates(e.get(),e.target())[action].enabled,false);assert.equal(prepareBlockTransaction(e.editor,action,undefined,e.target()),null)}assert.equal(e.get().doc.childCount,3);assert.deepEqual(e.errors,[])}finally{e.close()}
})
test('known inline blocks are valid drag neighbors, and unloading the target or a crossed neighbor revokes a staged move',()=>{
 const e=engine()
 try{const first=e.target(0),allowed=blockDestinations(e.get().doc,first,e.nodes,e.inline);assert.ok(allowed.includes(e.get().doc.content.size));assert.ok(operableBlockEntry(e.get().doc,rootBlocks(e.get().doc)[1],e.nodes,e.inline))
  const before=e.get().doc,apply=prepareBlockTransaction(e.editor,'block.down',undefined,first)!;assert.ok(apply);e.detach();assert.equal(protectedBlock(before.child(1),e.nodes,e.inline),true);assert.equal(apply(),false);assert.equal(e.get().doc,before);assert.deepEqual(blockDestinations(before,first,e.nodes,e.inline),[])
 }finally{e.close()}
})
test('read-only, moved selection and continued typing leave a staged block duplication untouched',()=>{
 for(const change of ['readonly','selection','typing'] as const){const e=engine()
  try{const before=e.get().doc,apply=prepareBlockTransaction(e.editor,'block.duplicate',undefined,e.target())!;assert.ok(apply);if(change==='readonly')e.setEditable(false);if(change==='selection')e.dispatch(e.get().tr.setSelection(TextSelection.create(e.get().doc,2)));if(change==='typing')e.dispatch(e.get().tr.insertText('New ',1));assert.equal(apply(),false);assert.equal(e.get().doc.childCount,3);if(change!=='typing')assert.equal(e.get().doc,before)}finally{e.close()}
 }
})
test('an unavailable nested codec protects the entire containing block and a late unload cancels staged copying',()=>{
 const unknown=engine(undefined,false,true)
 try{const bytes=Y.encodeStateAsUpdate(unknown.document),target=unknown.target();for(const action of ['block.duplicate','block.delete','block.heading','block.down']){assert.equal(blockActionStates(unknown.get(),target)[action].enabled,false);assert.equal(prepareBlockTransaction(unknown.editor,action,undefined,target),null)}assert.deepEqual(Y.encodeStateAsUpdate(unknown.document),bytes);assert.match(unknown.get().doc.textContent,/内层😀/)}finally{unknown.close()}
 const known=engine()
 try{const target=known.target(),apply=prepareBlockTransaction(known.editor,'block.duplicate',undefined,target)!;assert.ok(apply);known.detach();const bytes=Y.encodeStateAsUpdate(known.document);assert.equal(apply(),false);assert.deepEqual(Y.encodeStateAsUpdate(known.document),bytes)}finally{known.close()}
})
for(const action of ['block.down','block.delete'])test(`whole-block ${action} and peer nested typing preserve the peer through personal undo`,()=>{
 const a=engine(),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=engine(peer),history=a.store.undoManager(true,before=>prepareInlineContainerHistoryGuard(before,a.inline.resolve))
 try{const ids=[...inlineContainerNodes(a.get().doc).keys()],inner=ids[1];a.run(action);const at=nodeAt(b.get().doc,inner);b.dispatch(b.get().tr.insertText(' 同伴保留',at.position+at.node.nodeSize-1));sync(a,b)
  assert.ok(a.get().doc.eq(b.get().doc));if(action==='block.delete'){assert.equal(inlineContainerNodes(a.get().doc).size,0);const review=deletionReviews(a.store)[0];assert.ok(review);assert.equal(canConfirmDeletion(a.store,review,a.nodes,a.inline),true)}else assert.match(a.get().doc.textContent,/同伴保留/)
  assert.ok(history.undo());sync(a,b);assert.ok(a.get().doc.eq(b.get().doc));assert.match(a.get().doc.child(1).textContent,/同伴保留/);assert.deepEqual([...inlineContainerNodes(a.get().doc).keys()],ids)
  if(action==='block.delete'){const bytes=Y.encodeStateAsUpdate(a.document);assert.throws(()=>history.redo(),/historyPeerChanges/);assert.deepEqual(Y.encodeStateAsUpdate(a.document),bytes)}else{assert.ok(history.redo());sync(a,b);assert.ok(a.get().doc.eq(b.get().doc));assert.match(a.get().doc.textContent,/同伴保留/)}assert.deepEqual([...a.errors,...b.errors],[])
 }finally{history.destroy();a.close();b.close()}
})
