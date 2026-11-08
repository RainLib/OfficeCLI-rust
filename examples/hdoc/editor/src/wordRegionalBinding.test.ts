import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {EditorState,TextSelection,type PluginView,type Transaction} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {WordRegionStore,wordRegionSchema,wordCheckpointContents,wordReceiptContents,type WordRegionProjection} from './wordRegionStore.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {blockIdentityPlugin,sourceIdentityPlugin} from './schema.ts'
import {captureAiTarget,resolveAiTarget,aiTextTransaction} from './ai/semantic.ts'
const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),schema=wordRegionSchema()
function fixture(){const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,2].map(n=>({flowRegionId:id(n),blockId:id(n+10),blockHash:hash,region:n===1?'body':'header',readOnly:false,content:{kind:'paragraph',inlines:[{text:n===1?'Body':'Header',nodeId:id(n+20)}]}}))};const server=new Y.Doc(),peer=new Y.Doc(),canonical=new WordRegionStore(server,schema,'doc',projection.flowLayout,hash);canonical.initialize(projection);Y.applyUpdate(peer,Y.encodeStateAsUpdate(server));const model=new WordRegionStore(peer,schema,'doc',projection.flowLayout,hash),guard=wordRoomGuard(canonical,()=>undefined),errors:unknown[]=[],send=(update:Uint8Array)=>{try{guard.accept(update);Y.applyUpdate(server,update)}catch(error){errors.push(error)}};peer.on('update',send);return{server,peer,canonical,model,errors,close(){peer.off('update',send);guard.destroy();server.destroy();peer.destroy()}}}
function engine(model:WordRegionStore,region:string){const errors:unknown[]=[],plugin=semanticStructureBinding(model.view(region),{canWrite:()=>true,onError:error=>errors.push(error)});let state=EditorState.create({schema,plugins:[blockIdentityPlugin(),sourceIdentityPlugin(),plugin]}),binding:PluginView;const view={get state(){return state},dispatch(tr:Transaction){const previous=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,previous)}};binding=plugin.spec.view!(view as unknown as EditorView);return{get:()=>state,dispatch:view.dispatch,errors,close:()=>binding.destroy?.()}}
test('actual PM split and source identity plugins produce admissible regional packets and preserve the peer header',async()=>{const f=fixture(),editor=engine(f.model,id(1)),history=f.model.structure.undoManager();try{await Promise.resolve();const state=editor.get();editor.dispatch(state.tr.setSelection(TextSelection.create(state.doc,3)).split(3));assert.equal(editor.get().doc.childCount,2);editor.dispatch(editor.get().tr.insertText('new'));assert.deepEqual(f.errors,[]);assert.deepEqual(editor.errors,[]);assert.equal(f.canonical.project(id(1)).childCount,2);const header=f.canonical.region(id(2)),block=header[0];f.canonical.reconcile(id(2),header,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Peer Header',block.node.firstChild?.marks))}]);Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.server));history.undo();assert.equal(f.model.project(id(2)).textContent,'Peer Header');assert.deepEqual(f.errors,[])}finally{editor.close();history.destroy();f.close()}})

test('regional AI accepts one header action without changing peer body and own undo preserves the peer',async()=>{
 const f=fixture(),header=engine(f.model,id(2)),history=f.model.structure.undoManager();try{
  await Promise.resolve();header.dispatch(header.get().tr.setSelection(TextSelection.create(header.get().doc,1,7)))
  const view=f.model.view(id(2)),target=captureAiTarget(view,header.get(),'replace')!;assert.equal(target.source,'Header')
  const body=f.canonical.region(id(1)),block=body[0];f.canonical.reconcile(id(1),body,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Peer Body 😀',block.node.firstChild?.marks))}]);Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.server))
  const range=resolveAiTarget(view,header.get(),target)!;assert.ok(range);assert.equal(resolveAiTarget(f.model.view(id(1)),EditorState.create({schema,doc:f.model.project(id(1))}),target),null)
  const before=JSON.stringify(f.model.contents());assert.ok(!before.includes('AI 新页眉'))
  history.stopCapturing();header.dispatch(aiTextTransaction(header.get(),range,'AI 新页眉 😀\n第二行'));history.stopCapturing()
  assert.equal(f.canonical.project(id(1)).textContent,'Peer Body 😀');assert.equal(f.canonical.project(id(2)).textContent,'AI 新页眉 😀第二行');assert.equal(history.undoStack.length,1)
  history.undo();assert.equal(f.model.project(id(2)).textContent,'Header');assert.equal(f.model.project(id(1)).textContent,'Peer Body 😀')
  history.redo();assert.equal(f.model.project(id(2)).textContent,'AI 新页眉 😀第二行');assert.deepEqual(f.errors,[]);assert.deepEqual(header.errors,[])
 }finally{header.close();history.destroy();f.close()}
})

test('regional AI rejects a changed target and cannot reuse a body target in a different story',async()=>{
 const f=fixture(),body=engine(f.model,id(1)),header=engine(f.model,id(2));try{
  await Promise.resolve();body.dispatch(body.get().tr.setSelection(TextSelection.create(body.get().doc,1,5)));const target=captureAiTarget(f.model.view(id(1)),body.get(),'replace')!
  assert.ok(target.from.relative);assert.equal(resolveAiTarget(f.model.view(id(2)),header.get(),target),null)
  const blocks=f.canonical.region(id(1)),block=blocks[0];f.canonical.reconcile(id(1),blocks,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('BoXdy',block.node.firstChild?.marks))}]);Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.server))
  assert.equal(resolveAiTarget(f.model.view(id(1)),body.get(),target),null);assert.equal(f.canonical.project(id(2)).textContent,'Header');assert.deepEqual(f.errors,[])
 }finally{body.close();header.close();f.close()}
})

test('regional typography packets preserve source identity, peer formatting and personal undo across stories',async()=>{
 const f=fixture(),header=engine(f.model,id(2)),history=f.model.structure.undoManager()
 const sizes=(model:WordRegionStore,region:string)=>model.project(region).firstChild!.firstChild!.marks.find(mark=>mark.type.name==='textTypography')?.attrs.sizePt
 try{
  await Promise.resolve();history.clear();history.stopCapturing()
  header.dispatch(header.get().tr.addMark(1,7,schema.marks.textTypography.create({family:'Times New Roman',eastAsia:'宋体',sizePt:24.5,explicitSize:true})));history.stopCapturing()
  assert.equal(history.undoStack.length,1);assert.equal(sizes(f.canonical,id(2)),24.5)
  const body=f.canonical.region(id(1)),block=body[0],mark=schema.marks.textTypography.create({family:'Arial',sizePt:16,explicitSize:true})
  f.canonical.reconcile(id(1),body,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Peer Body 😀',[...(block.node.firstChild?.marks.filter(item=>item.type!==mark.type)??[]),mark]))}]);Y.applyUpdate(f.peer,Y.encodeStateAsUpdate(f.server))
  const first=f.model.capture().regions.find(region=>region.regionId===id(2))!.blocks[0].content.inlines[0]
  assert.equal(first.typography?.sizePt,24.5);assert.equal(first.typography?.eastAsia,'宋体');assert.equal(first.fontSizeExplicit,true);assert.equal(first.nodeId,id(22))
  history.undo();assert.equal(sizes(f.model,id(2)),undefined);assert.equal(sizes(f.model,id(1)),16);assert.equal(f.model.project(id(1)).textContent,'Peer Body 😀')
  history.redo();assert.equal(sizes(f.model,id(2)),24.5);assert.equal(sizes(f.model,id(1)),16)
  const reopened=new Y.Doc();try{Y.applyUpdate(reopened,Y.encodeStateAsUpdate(f.peer));const copy=new WordRegionStore(reopened,schema,'doc',f.model.layoutState().layout,hash);assert.equal(sizes(copy,id(2)),24.5);assert.equal(sizes(copy,id(1)),16)}finally{reopened.destroy()}
  assert.deepEqual(header.errors,[]);assert.deepEqual(f.errors,[])
 }finally{header.close();history.destroy();f.close()}
})


test('regional receipt equivalence only fills false flags on block atom fallbacks, never business payload or true formatting',()=>{
 const value={schemaVersion:'hcd.extension/1' as const,instanceId:'x_'+'a'.repeat(32),type:'example.card',version:1,display:'block' as const,data:{title:'Keep'},fallback:{text:'Keep'}}
 const before={regions:[{regionId:id(1),blocks:[{blockId:null,content:{kind:'extension' as const,extension:value,inlines:[{text:'Keep'}]}}]}]},after=structuredClone(before)
 Object.assign(after.regions[0].blocks[0].content.inlines[0],{bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false})
 assert.notEqual(wordCheckpointContents(before),wordCheckpointContents(after));assert.equal(wordReceiptContents(before),wordReceiptContents(after))
 Object.assign(after.regions[0].blocks[0].content.inlines[0],{bold:true});assert.notEqual(wordReceiptContents(before),wordReceiptContents(after));Object.assign(after.regions[0].blocks[0].content.inlines[0],{bold:false});after.regions[0].blocks[0].content.extension.data.title='Changed';assert.notEqual(wordReceiptContents(before),wordReceiptContents(after))
})
