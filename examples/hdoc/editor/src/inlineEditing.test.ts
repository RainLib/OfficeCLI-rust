import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {Editor} from '@tiptap/core'
import {EditorState,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import type {Node as PmNode,Schema} from '@tiptap/pm/model'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {InlineContainerRegistry,type InlineContainerDefinition} from './inlineContainerRegistry.ts'
import {inlineContainerPreservationPlugin} from './inlineContainerPreservation.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {findSlash,slashPlugin,slashKey} from './commands/slash.ts'
import {prepareSlashTransaction} from './commands/slashTransaction.ts'
import {semanticActionStates,semanticSelection} from './commands/semantic.ts'
import type {CommandContext} from './commands/types.ts'
import {canMentionAt,findMention,mentionTransaction,mentionPlugin,mentionKey} from './mentionSuggestion.ts'
import {canAiSelection,captureAiTarget,resolveAiTarget,aiTextTransaction} from './ai/semantic.ts'
import {inlineContainerNodeName} from './inlineContainerPayload.ts'

const definition:InlineContainerDefinition={type:'example.editable',version:1,display:'inline',contentModel:'inline',label:'业务字段',defaultData:{label:'字段'},validate:data=>typeof data.label==='string',fallback:data=>String(data.label)}
function engine(body='正文😀 /业务',document=new Y.Doc({gc:false}),initial?:(schema:Schema,registry:InlineContainerRegistry)=>PmNode){
 const registry=new InlineContainerRegistry([definition]),release=registry.connect(),editor=new Editor({element:null,content:{type:'doc',content:[{type:'paragraph'}]},extensions:[...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode]})
 const schema=editor.schema,store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
 if(!store.initialized)store.initialize(initial?.(schema,registry)??schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,[schema.text('前缀 '),schema.nodes[inlineContainerNodeName].createChecked({extension:registry.create(definition.type)},body?schema.text(body):undefined),schema.text(' 尾部')])))
 const errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>editor.isEditable,onError:error=>errors.push(error)})
 let state=EditorState.create({schema,doc:store.project(),plugins:[sourceIdentityPlugin(),inlineContainerPreservationPlugin(registry.resolve,error=>errors.push(error),()=>registry),slashPlugin(),mentionPlugin(),plugin]}),binding:PluginView|undefined
 const view={get state(){return state},composing:false,editable:true,focus(){},dispatch(tr:Transaction){const previous=state,result=state.applyTransaction(tr);state=result.state;binding?.update?.(view as unknown as EditorView,previous);if(result.transactions.includes(tr))editor.emit('transaction',{editor,transaction:tr,appendedTransactions:result.transactions.filter(item=>item!==tr)})}}
 Object.defineProperties(editor,{state:{get:()=>state},view:{get:()=>view},isDestroyed:{get:()=>false}})
 binding=plugin.spec.view!(view as unknown as EditorView)
 const entries=()=>{const result:Array<{node:PmNode;position:number}>=[];state.doc.descendants((node,position)=>{if(node.type.name===inlineContainerNodeName)result.push({node,position})});return result}
 const select=(from:number,to=from)=>view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,from,to)))
 return{editor,schema,registry,store,document,errors,get:()=>state,dispatch:view.dispatch,entries,select,atEnd(){const entry=entries().at(-1)!;select(entry.position+entry.node.nodeSize-1)},target(){return{...findSlash(state)!,anchor:'live'}},close(){binding?.destroy?.();release();document.destroy()}}
}
const exchange=(a:ReturnType<typeof engine>,b:ReturnType<typeof engine>)=>{const x=Y.encodeStateAsUpdate(a.document),y=Y.encodeStateAsUpdate(b.document);Y.applyUpdate(a.document,y);Y.applyUpdate(b.document,x)}

test('slash text insertion stays inside an inline body, preserves the wrapper and is one personal history action',()=>{
 const e=engine(),history=e.store.undoManager(false)
 try{e.atEnd();const before=e.entries()[0].node,match=findSlash(e.get())!;assert.equal(match.query,'业务')
  const apply=prepareSlashTransaction(e.editor,'text.insert',{text:'<b>新内容</b>\n下一行'},e.target())!;assert.ok(apply);assert.equal(e.entries()[0].node.textContent,'正文😀 /业务');assert.ok(apply())
  const after=e.entries()[0].node;assert.deepEqual(after.attrs.extension,before.attrs.extension);assert.equal(after.textBetween(0,after.content.size,'\n','\n'),'正文😀 <b>新内容</b>\n下一行');assert.equal(e.get().doc.firstChild!.firstChild!.text,'前缀 ')
  assert.equal(history.undoStack.length,1);history.undo();assert.equal(e.entries()[0].node.textContent,'正文😀 /业务');history.redo();assert.equal(e.entries()[0].node.textContent,'正文😀 <b>新内容</b>下一行');assert.deepEqual(e.errors,[])
 }finally{history.destroy();e.close()}
})
test('block conversions and block extensions cannot lift or split an inline wrapper; nested inline insertion retains its outer body',()=>{
 const e=engine(),blocks=new NodeExtensionRegistry([{type:'example.block',version:1,display:'block',label:'Block',defaultData:{},validate:()=>true,fallback:()=> 'Block'}])
 try{e.atEnd();const before=e.get().doc
  for(const id of ['block.paragraph','block.heading','block.bulletList','block.orderedList','block.quote','block.code','block.divider','block.insertParagraph']){assert.equal(semanticActionStates(e.editor)[id]?.enabled,false);assert.equal(prepareSlashTransaction(e.editor,id,undefined,e.target()),null)}
  assert.equal(prepareSlashTransaction(e.editor,'node.insert',{extension:blocks.create('example.block')},e.target()),null);assert.ok(e.get().doc.eq(before))
  const value=e.registry.create(definition.type),apply=prepareSlashTransaction(e.editor,'node.insert',{extension:value},e.target())!;assert.ok(apply());const [outer,inner]=e.entries();assert.equal(outer.node.textContent,'正文😀 ');assert.equal(inner.node.attrs.extension.instanceId,value.instanceId);assert.equal(e.store.flow.containers!.readBody(value.instanceId).content.size,0);assert.deepEqual(e.errors,[])
 }finally{e.close()}
})
test('unknown or disposed enclosing codecs disable suggestions and invalidate a staged insertion without consuming its query',()=>{
 const e=engine()
 try{e.atEnd();const apply=prepareSlashTransaction(e.editor,'text.insert',{text:'不得插入'},e.target())!;const dispose=e.registry.connect();dispose();assert.equal(findSlash(e.get()),null);assert.equal(canMentionAt(e.get()),false);assert.equal(apply(),false);assert.equal(e.entries()[0].node.textContent,'正文😀 /业务')}
 finally{e.close()}
 const nested=engine('',new Y.Doc({gc:false}),(schema,registry)=>{const unknown={...registry.create(definition.type),version:77};return schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.nodes[inlineContainerNodeName].createChecked({extension:unknown},schema.nodes[inlineContainerNodeName].createChecked({extension:registry.create(definition.type)},schema.text('@张')))))})
 try{nested.atEnd();assert.equal(findMention(nested.get()),null);assert.equal(canMentionAt(nested.get()),false);assert.equal(canAiSelection(nested.get(),'insert'),false)}finally{nested.close()}
})
test('registered menu descriptors disable block insertion inside inline bodies on every command surface',()=>{
 const e=engine(),nodes=new NodeExtensionRegistry([{type:'example.block',version:1,display:'block',label:'Block',defaultData:{},validate:()=>true,fallback:()=> 'Block'},{type:'example.atom',version:1,display:'inline',label:'Atom',defaultData:{},validate:()=>true,fallback:()=> 'Atom'}])
 try{e.atEnd();const context:CommandContext={instanceId:'fixture',documentId:'fixture',format:'html',profile:'flow',locale:'zh-CN',platform:'mac',ready:true,readOnly:false,historical:false,revision:1,selection:semanticSelection(e.editor,0,e.registry),capabilities:{customNodes:true,inlineContainers:true},actions:{'node.insert':{enabled:true}}}
  const block=nodes.commands().find(item=>item.id==='node.insert.example.block')!,atom=nodes.commands().find(item=>item.id==='node.insert.example.atom')!,inline=e.registry.commands()[0]
  assert.equal(block.canExecute!(context),false);assert.equal(atom.canExecute!(context),true);assert.equal(inline.canExecute!(context),true)
  for(const surface of ['ribbon','context','slash','block','palette'] as const)assert.ok(block.surfaces!.includes(surface)&&inline.surfaces!.includes(surface))
  context.selection={...context.selection,protected:true};assert.equal(atom.canExecute!(context),false);assert.equal(inline.canExecute!(context),false)
 }finally{e.close()}
})
test('nested mentions retain their own identity through peer prefix input, personal undo/redo and recursive snapshots',()=>{
 const a=engine('@张'),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=engine('',peer),history=a.store.undoManager(false)
 try{a.atEnd();const match=findMention(a.get())!;assert.equal(match.query,'张');a.dispatch(mentionTransaction(a.get(),match,{kind:'person',id:'bob',label:'Bob 李'}));const saved=jsonToSnapshot(a.get().doc.toJSON(),{inlineContainers:true})[0].content.inlines.find(part=>part.content)!.content!.inlines.find(part=>part.reference)!.reference!
  assert.equal(saved.target.id,'bob');assert.equal(saved.snapshot.label,'Bob 李');exchange(a,b);b.dispatch(b.get().tr.insertText('Peer ',1));exchange(a,b);assert.deepEqual(a.get().doc.toJSON(),b.get().doc.toJSON());assert.equal(a.entries()[0].node.textContent,'@Bob 李 ')
  history.undo();exchange(a,b);assert.equal(a.entries()[0].node.textContent,'@张');assert.ok(a.get().doc.textContent.startsWith('Peer 前缀 '));history.redo();exchange(a,b)
  const current=jsonToSnapshot(a.get().doc.toJSON(),{inlineContainers:true})[0].content.inlines.find(part=>part.content)!.content!.inlines.find(part=>part.reference)!.reference!;assert.equal(current.mentionId,saved.mentionId);assert.equal(current.target.id,'bob');assert.deepEqual(a.errors,[])
 }finally{history.destroy();a.close();b.close()}
})
test('inline slash and mention suggestions respect composition and code/link marks',()=>{
 const e=engine('/业务')
 try{e.atEnd();e.dispatch(e.get().tr.setMeta(slashKey,{composing:true}));assert.equal(slashKey.getState(e.get())?.match,null);e.dispatch(e.get().tr.setMeta(slashKey,{composing:false}));assert.equal(slashKey.getState(e.get())?.match?.query,'业务')
  const entry=e.entries()[0];e.dispatch(e.get().tr.insertText('@张',entry.position+1,entry.position+entry.node.nodeSize-1));e.atEnd();e.dispatch(e.get().tr.setMeta(mentionKey,{composing:true}));assert.equal(mentionKey.getState(e.get())?.match,null);e.dispatch(e.get().tr.setMeta(mentionKey,{composing:false}));assert.equal(mentionKey.getState(e.get())?.match?.query,'张')
  for(const name of ['code','link']){const at=e.entries()[0],mark=e.schema.marks[name].create(name==='link'?{href:'https://example.invalid'}:undefined);e.dispatch(e.get().tr.addMark(at.position+1,at.position+at.node.nodeSize-1,mark));assert.equal(findMention(e.get()),null);e.dispatch(e.get().tr.removeMark(at.position+1,at.position+at.node.nodeSize-1,mark))}
 }finally{e.close()}
})
test('AI targets the permanent inline body, maps peer prefixes and accepts one undoable literal replacement',()=>{
 const a=engine('Before target After'),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=engine('',peer),history=a.store.undoManager(false)
 try{const entry=a.entries()[0],from=entry.position+1+'Before '.length;a.select(from,from+6);assert.equal(canAiSelection(a.get(),'replace'),true);const target=captureAiTarget(a.store,a.get(),'replace')!;assert.equal(target.source,'target');assert.ok(target.from.relative);assert.equal(target.parent,'extension:'+entry.node.attrs.extension.instanceId)
  b.dispatch(b.get().tr.insertText('Peer ',1));exchange(a,b);const range=resolveAiTarget(a.store,a.get(),target)!;assert.ok(range);assert.equal(a.get().doc.textBetween(range.from,range.to),'target');a.dispatch(aiTextTransaction(a.get(),range,'<b>改写</b>\n新行'));exchange(a,b);assert.equal(a.entries()[0].node.textContent,'Before <b>改写</b>新行 After');assert.deepEqual(a.get().doc.toJSON(),b.get().doc.toJSON())
  assert.equal(history.undoStack.length,1);history.undo();exchange(a,b);assert.equal(a.entries()[0].node.textContent,'Before target After');assert.ok(a.get().doc.textContent.startsWith('Peer 前缀 '));history.redo();exchange(a,b);assert.equal(a.entries()[0].node.textContent,'Before <b>改写</b>新行 After');assert.deepEqual(a.errors,[])
 }finally{history.destroy();a.close();b.close()}
})
test('inline AI targets reject peer text/format edits, hidden wrappers and codec disposal; completion rejects a changed boundary',()=>{
 for(const change of ['text','format','delete','dispose','boundary'] as const){const a=engine('Before target After'),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(a.document));const b=engine('',peer)
  try{const entry=a.entries()[0],from=entry.position+1+7;a.select(from,change==='boundary'?from:from+6);const target=captureAiTarget(a.store,a.get(),change==='boundary'?'insert':'replace')!;assert.ok(target)
   if(change==='dispose'){const dispose=a.registry.connect();dispose()}else{const tr=b.get().tr;if(change==='text'||change==='boundary')tr.insertText('peer',from+ (change==='text'?2:0));if(change==='format')tr.addMark(from,from+6,b.schema.marks.bold.create());if(change==='delete')tr.delete(entry.position,entry.position+entry.node.nodeSize);b.dispatch(tr);exchange(a,b)}
   assert.equal(resolveAiTarget(a.store,a.get(),target),null,change)
  }finally{a.close();b.close()}
 }
})
