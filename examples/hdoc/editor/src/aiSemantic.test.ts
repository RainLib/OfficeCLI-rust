import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin,blockIdentityPlugin} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {captureAiTarget,resolveAiTarget,aiTextTransaction} from './ai/semantic.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function engine(document:Y.Doc){
 const store=new SemanticBlockStore(document,schema),errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>true,onError:error=>errors.push(error)})
 let state=EditorState.create({schema,plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const previous=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,previous)}};binding=plugin.spec.view!(view as unknown as EditorView)
 return{store,get:()=>state,dispatch:view.dispatch,errors,close:()=>binding.destroy?.()}
}
function pair(){const a=new Y.Doc(),b=new Y.Doc(),store=new SemanticBlockStore(a,schema);store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdBlockId:'a'},schema.text('Before target After')),schema.nodes.paragraph.createChecked({hcdBlockId:'b'},schema.text('Other paragraph'))]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b);return{a,b,ea,eb,exchange(){const x=Y.encodeStateAsUpdate(a),y=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,y);Y.applyUpdate(b,x)},close(){ea.close();eb.close();a.destroy();b.destroy()}}}
test('target maps unrelated peer input; one own undo retains the peer and redo restores literal text',async()=>{
 const f=pair(),history=f.ea.store.undoManager();try{await Promise.resolve();f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,8,14)));const target=captureAiTarget(f.ea.store,f.ea.get(),'replace')!;assert.equal(target.source,'target');assert.ok(target.from.relative)
 f.eb.dispatch(f.eb.get().tr.insertText('Peer ',1));f.exchange();const range=resolveAiTarget(f.ea.store,f.ea.get(),target)!;assert.equal(f.ea.get().doc.textBetween(range.from,range.to),'target');history.stopCapturing();f.ea.dispatch(aiTextTransaction(f.ea.get(),range,'<b>新内容</b>\n第二行'));history.stopCapturing();f.exchange();assert.equal(f.ea.get().doc.firstChild!.textContent,'Peer Before <b>新内容</b>第二行 After');assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(history.undoStack.length,1);history.undo();f.exchange();assert.equal(f.ea.get().doc.firstChild!.textContent,'Peer Before target After');history.redo();f.exchange();assert.ok(f.ea.get().doc.firstChild!.textContent.includes('<b>新内容</b>'));assert.deepEqual(f.ea.errors,[])
 }finally{history.destroy();f.close()}
})
test('peer text/format changes, deletion and splits invalidate the original target',async()=>{
 for(const change of ['text','format','delete','split']as const){const f=pair();try{await Promise.resolve();f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,8,14)));const target=captureAiTarget(f.ea.store,f.ea.get(),'replace')!,tr=f.eb.get().tr;if(change==='text')tr.insertText('X',10);if(change==='format')tr.addMark(8,14,schema.marks.bold.create());if(change==='delete')tr.delete(8,14);if(change==='split')tr.split(10);f.eb.dispatch(tr);f.exchange();assert.equal(resolveAiTarget(f.ea.store,f.ea.get(),target),null,change)}finally{f.close()}}
})
test('continuation rejects peer typing at its cursor, permits changes elsewhere',async()=>{
 const f=pair();try{await Promise.resolve();f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,14)));const target=captureAiTarget(f.ea.store,f.ea.get(),'insert')!;f.eb.dispatch(f.eb.get().tr.insertText(' elsewhere',f.eb.get().doc.content.size-1));f.exchange();assert.ok(resolveAiTarget(f.ea.store,f.ea.get(),target));f.eb.dispatch(f.eb.get().tr.insertText('peer at cursor',14));f.exchange();assert.equal(resolveAiTarget(f.ea.store,f.ea.get(),target),null)}finally{f.close()}
})
test('multi-paragraph, linked, code and protected atom selections cannot be rewritten',async()=>{
 const f=pair();try{await Promise.resolve();f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,2,f.ea.get().doc.content.size-1)));assert.equal(captureAiTarget(f.ea.store,f.ea.get(),'replace'),null)
 for(const mark of [schema.marks.code.create(),schema.marks.link.create({href:'https://example.com'})]){const tr=f.ea.get().tr.addMark(8,14,mark);f.ea.dispatch(tr.setSelection(TextSelection.create(tr.doc,8,14)));assert.equal(captureAiTarget(f.ea.store,f.ea.get(),'replace'),null);f.ea.dispatch(f.ea.get().tr.removeMark(8,14,mark))}
 const tr=f.ea.get().tr.replaceWith(8,14,schema.nodes.hcdMention.create({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'person'},snapshot:{label:'Private atom'}}}));f.ea.dispatch(tr.setSelection(TextSelection.create(tr.doc,8,9)));assert.equal(captureAiTarget(f.ea.store,f.ea.get(),'replace'),null)
 }finally{f.close()}
})

test('auto completion requires its captured caret while explicit suggestions may keep their target',async()=>{
 const f=pair();try{
  await Promise.resolve();f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,f.ea.get().doc.content.size-1)))
  const target=captureAiTarget(f.ea.store,f.ea.get(),'insert')!,editor={isDestroyed:false,isEditable:true,view:{composing:false},get state(){return f.ea.get()}} as unknown as import('@tiptap/core').Editor
  const {createSemanticAiAdapter}=await import('./ai/semantic.ts'),options={session:{documentId:'fixture',format:'docx',token:'fixture',scope:'write',collaborationEpoch:0} as import('./api.ts').Session,editor:()=>editor,store:()=>f.ea.store,canWrite:()=>true,revision:()=>0,locale:()=> 'en-US',history:{stopCapturing(){}}}
  const automatic=createSemanticAiAdapter({...options,requireCaret:true}),manual=createSemanticAiAdapter(options)
  assert.equal(automatic.valid(target),true);f.eb.dispatch(f.eb.get().tr.insertText('Peer ',1));f.exchange();assert.equal(automatic.valid(target),true,'unrelated earlier paragraph maps the caret')
  f.ea.dispatch(f.ea.get().tr.setSelection(TextSelection.create(f.ea.get().doc,2)));assert.equal(automatic.valid(target),false);assert.equal(manual.valid(target),true)
 }finally{f.close()}
})
test('Tab remains reserved for list indentation and private ghost metadata does not alter semantic content/history',async()=>{
 const {completionTabReserved}=await import('./ai/semantic.ts'),{aiGhostPlugin,aiGhostKey}=await import('./ai/ghost.ts')
 const doc=schema.nodes.doc.createChecked(null,[schema.nodes.bulletList.createChecked(null,[schema.nodes.listItem.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.text('A list item')))])])
 let state=EditorState.create({schema,doc,selection:TextSelection.create(doc,5),plugins:[aiGhostPlugin({accept(){},dismiss(){},labels:()=>({accept:'Accept',dismiss:'Dismiss'}),mounted(){},unmounted(){}})]})
 assert.equal(completionTabReserved(state),true);const before=state.doc.toJSON();state=state.apply(state.tr.setMeta(aiGhostKey,{requestId:'private',position:5,text:'UNACCEPTED PRIVATE TEXT',ready:true,applying:false}).setMeta('addToHistory',false))
 assert.ok(aiGhostKey.getState(state));assert.deepEqual(state.doc.toJSON(),before);assert.ok(!JSON.stringify(state.doc.toJSON()).includes('UNACCEPTED'));state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,6)));assert.equal(aiGhostKey.getState(state),null)
})
