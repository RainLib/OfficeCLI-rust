import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {EditorState,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {validateSemanticInline,writeSemanticInline,writeSemanticEdits,type SemanticInlineEdit} from './semanticInlineContent.ts'
import {semanticStructureBinding,structureTextEdits,structureTextSplices} from './semanticStructureBinding.ts'
import {captureSourceLeaf,sourceLeafActions} from './semanticSourceBindings.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const p=(text:string,id=1)=>schema.nodes.paragraph.createChecked({hcdBlockId:source(id)},text?schema.text(text):null)
const insert=(text:string)=>text?Fragment.from(schema.text(text)):Fragment.empty
const visible=(text:Y.XmlText)=>{const ids:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)ids.push(`${item.id.client}:${item.id.clock+i}`);return ids}
function engine(document:Y.Doc,editable=true){
 const store=new SemanticBlockStore(document,schema),errors:unknown[]=[],plugin=semanticStructureBinding(store,{canWrite:()=>editable,onError:error=>errors.push(error)})
 let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}};binding=plugin.spec.view!(view as unknown as EditorView)
 return{store,errors,get:()=>state,dispatch:view.dispatch,close:()=>binding.destroy?.(),setEditable:(value:boolean)=>{editable=value}}
}
function pair(text='AAA😀AAA',reverse=false,second?:string){const a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false});a.clientID=reverse?2:1;b.clientID=reverse?1:2;const store=new SemanticBlockStore(a,schema);store.initialize(schema.nodes.doc.createChecked(null,[p(text),...(second===undefined?[]:[p(second,2)])]));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const ea=engine(a),eb=engine(b);return{a,b,ea,eb,close(){ea.close();eb.close();a.destroy();b.destroy()}}}
function exchange(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}
function carrier(store:SemanticBlockStore,key=store.keys()[0]){return store.contents.get(key)!.get(0) as Y.XmlText}
function flowFixture(text='AAA😀AAA'){const document=new Y.Doc({gc:false}),carriers=document.getMap<Y.XmlFragment>('carriers'),flow=new SemanticTextFlow(document,carriers,schema),fragment=new Y.XmlFragment();carriers.set('root',fragment);fragment.insert(0,[new Y.XmlText()]);const raw=fragment.get(0) as Y.XmlText;writeSemanticInline(raw,p(text));flow.initialize(['root']);return{document,flow,raw}}

test('initial carrier writes long formatted runs and refuses invalid later content atomically',()=>{
 const document=new Y.Doc(),text=document.get('initial',Y.XmlText),long='A'.repeat(600_000)+'😀',bold=schema.mark('bold')
 try{
  const invalid=schema.nodes.paragraph.create(null,[schema.text('valid'),p('invalid')])
  assert.throws(()=>validateSemanticInline(invalid),/unsupportedInlineContent/)
  assert.throws(()=>writeSemanticInline(text,invalid),/unsupportedInlineContent/);assert.deepEqual(text.toDelta(),[])
  const content=schema.nodes.paragraph.createChecked(null,[schema.text(long,[bold]),schema.text('tail')]);validateSemanticInline(content);writeSemanticInline(text,content)
  assert.deepEqual(text.toDelta(),[{insert:long,attributes:{bold:{}}},{insert:'tail'}])
  const peer=new Y.Doc();try{Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));assert.deepEqual(peer.get('initial',Y.XmlText).toDelta(),text.toDelta())}finally{peer.destroy()}
 }finally{document.destroy()}
})

test('two disjoint replacements preserve every original character between them',()=>{
 const f=flowFixture();try{const ids=visible(f.raw),point=f.flow.capture('root',3,1),edits=[{from:0,to:0,insert:insert('AA')},{from:10,to:10,insert:insert('AA')}];f.flow.writeEdits('root',p('AAAAA😀AAAAA'),edits);assert.deepEqual(visible(f.raw).slice(2,-2),ids);assert.equal(f.flow.resolve(point)?.offset,5)}finally{f.document.destroy()}
})
test('composition-style provisional replacements keep only the final text and original suffix IDs through undo/redo',()=>{
 const f=flowFixture('P😀'),history=f.flow.undoManager();try{
  const ids=visible(f.raw),edits=[{from:0,to:0,insert:insert('n')},{from:0,to:1,insert:insert('ni')},{from:0,to:2,insert:insert('你😀')}]
  f.flow.writeEdits('root',p('你😀P😀'),edits);assert.deepEqual(visible(f.raw).slice(3),ids);assert.equal(history.undoStack.length,1);history.undo();assert.equal(f.flow.read('root').textBetween(0,3),'P😀');history.redo();const read=f.flow.read('root');assert.equal(read.textBetween(0,read.size),'你😀P😀');assert.equal(history.undoStack.length,1)
 }finally{history.destroy();f.document.destroy()}
})
test('a stale final value or invalid later operation refuses before the first operation changes Yjs',()=>{
 const f=flowFixture('P😀');try{const before=Y.encodeStateAsUpdate(f.document)
  const candidates:SemanticInlineEdit[][]=[
   [{from:0,to:0,insert:insert('A')},{from:3,to:3,insert:insert('Z')}],
   [{from:0,to:0,insert:insert('A')},{from:99,to:99,insert:insert('Z')}],
   [{from:0,to:0,insert:insert('A')},{from:1,to:1,insert:Fragment.from(p('block'))}],
   [{from:0,to:0,insert:insert('A')},{from:1,to:1,insert:insert('B')}],
  ]
  for(const edits of candidates){assert.throws(()=>f.flow.writeEdits('root',p('Wrong final'),edits),/SemanticTextEdits/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}
  assert.throws(()=>f.flow.writeEdits('root',p('P😀'),Array.from({length:257},()=>({from:0,to:0,insert:Fragment.empty}))),/semanticTextEditsLimit/);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
 }finally{f.document.destroy()}
})
test('multi-step writes operate on already joined permanent carriers without moving their originals',()=>{
 const f=flowFixture('AAA'),fragment=new Y.XmlFragment();f.document.getMap<Y.XmlFragment>('carriers').set('second',fragment);fragment.insert(0,[new Y.XmlText()]);const second=fragment.get(0) as Y.XmlText;writeSemanticInline(second,p('BBB'));f.flow.register('second')
 try{const a=visible(f.raw),b=visible(second),point=f.flow.capture('second',0,1);f.flow.join('root','second');f.flow.writeEdits('root',p('AAAAABBBBB'),[{from:0,to:0,insert:insert('AA')},{from:8,to:8,insert:insert('BB')}]);assert.deepEqual(visible(f.raw).filter(id=>a.includes(id)),a);assert.deepEqual(visible(second).filter(id=>b.includes(id)),b);assert.equal(f.flow.resolve(point)?.offset,5)}finally{f.document.destroy()}
})
for(const reverse of [false,true]){
 test(`real PM batch preserves late peer input and caret between unchanged original characters, reverse=${reverse}`,async()=>{
  const f=pair('AAA😀AAA',reverse),history=f.ea.store.undoManager();try{
   await Promise.resolve();const ids=visible(carrier(f.ea.store));f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,2)))
   const tr=f.ea.get().tr.insertText('AA',1);tr.insertText('AA',tr.doc.firstChild!.content.size+1);f.ea.dispatch(tr);f.eb.dispatch(f.eb.get().tr.insertText('Peer'))
   exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'AAAPeerAA😀AAAAA');assert.equal(f.eb.get().selection.$from.parentOffset,7);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(visible(carrier(f.ea.store)).filter(id=>ids.includes(id)),ids)
   history.undo();exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'APeerAA😀AAA');history.redo();exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'AAAPeerAA😀AAAAA');assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
  }finally{history.destroy();f.close()}
 })
 test(`identical final text still applies deletion intent and repositions the peer selection, reverse=${reverse}`,async()=>{
  const f=pair('AAA',reverse);try{
   await Promise.resolve();const ids=visible(carrier(f.ea.store)),before=f.ea.get().doc;f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,2)))
   f.ea.dispatch(f.ea.get().tr.delete(1,2).insertText('A',3));assert.ok(f.ea.get().doc.eq(before));assert.equal(visible(carrier(f.ea.store)).includes(ids[0]),false);assert.deepEqual(visible(carrier(f.ea.store)).slice(0,2),ids.slice(1))
   exchange(f.a,f.b,reverse);assert.ok(f.eb.get().doc.eq(before));assert.equal(f.eb.get().selection.from,1)
   f.eb.dispatch(f.eb.get().tr.insertText('Peer'));exchange(f.a,f.b,reverse);assert.equal(f.ea.get().doc.textContent,'PeerAAA');assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[])
  }finally{f.close()}
 })
}
test('a composed Chinese/emoji batch through the real binding is one own undo action',async()=>{
 const f=pair('P😀'),history=f.ea.store.undoManager();try{await Promise.resolve();const ids=visible(carrier(f.ea.store)),tr=f.ea.get().tr.insertText('n',1).insertText('ni',1,2).insertText('你😀',1,3).setMeta('composition',7);f.ea.dispatch(tr);assert.equal(f.ea.get().doc.textContent,'你😀P😀');assert.deepEqual(visible(carrier(f.ea.store)).slice(3),ids);assert.equal(history.undoStack.length,1);history.undo();assert.equal(f.ea.get().doc.textContent,'P😀');history.redo();assert.equal(f.ea.get().doc.textContent,'你😀P😀');assert.deepEqual(f.ea.errors,[])}finally{history.destroy();f.close()}
})
test('several composition-tagged transactions retain the original suffix and one history group',async()=>{
 const f=pair('P😀'),history=f.ea.store.undoManager();try{await Promise.resolve();const ids=visible(carrier(f.ea.store));f.ea.dispatch(f.ea.get().tr.insertText('n',1).setMeta('composition',3));f.ea.dispatch(f.ea.get().tr.insertText('ni',1,2).setMeta('composition',3));f.ea.dispatch(f.ea.get().tr.insertText('你😀',1,3).setMeta('composition',3));assert.equal(f.ea.get().doc.textContent,'你😀P😀');assert.deepEqual(visible(carrier(f.ea.store)).slice(3),ids);assert.equal(history.undoStack.length,1);history.undo();assert.equal(f.ea.get().doc.textContent,'P😀');history.redo();assert.equal(f.ea.get().doc.textContent,'你😀P😀')}finally{history.destroy();f.close()}
})
test('one transaction can edit two distinct paragraphs while preserving both sets of original item IDs',async()=>{
 const f=pair('AAA',false,'BBB');try{await Promise.resolve();const keys=f.ea.store.keys(),ids=keys.map(key=>visible(carrier(f.ea.store,key))),tr=f.ea.get().tr.insertText('AA',1),at=tr.doc.firstChild!.nodeSize+1;tr.insertText('BB',at);f.ea.dispatch(tr);exchange(f.a,f.b);assert.deepEqual(f.ea.store.blocks().map(block=>block.node.textContent),['AAAAA','BBBBB']);keys.forEach((key,index)=>assert.deepEqual(visible(carrier(f.ea.store,key)).slice(2),ids[index]));assert.deepEqual(f.ea.errors,[])}finally{f.close()}
})
test('invalid later-root batch preflight is atomic even with an additional new proposed block',async()=>{
 const f=pair('AAA',false,'BBB');try{await Promise.resolve();const old=f.ea.store.blocks(),tr=f.ea.get().tr.insertText('AA',1);tr.insertText('BB',tr.doc.firstChild!.nodeSize+1);const edits=structureTextEdits([tr]);assert.equal(edits.length,2);const bad=[edits[0],{...edits[1],edits:[{from:999,to:999,insert:insert('B')}]}],next=[...tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})),{node:p('New',3)}],before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>f.ea.store.validateReconcile(old,next,{textEdits:bad}),/SemanticTextEdits/);assert.throws(()=>f.ea.store.reconcile(old,next,{textEdits:bad}),/SemanticTextEdits/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before);assert.throws(()=>f.ea.store.reconcile(old,next,{textEdits:[edits[0],edits[0]]}),/SemanticTextEdits/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),before)}finally{f.close()}
})
test('captured source receipt after disjoint prefix/suffix input still binds exactly the old characters',async()=>{
 const f=pair();try{await Promise.resolve();const key=f.ea.store.keys()[0],captured=captureSourceLeaf(f.ea.store,key,f.ea.store.content(key)),expected=schema.nodes.paragraph.createChecked(null,[schema.text('AAA😀AAA',[schema.mark('hcdSource',{nodeId:source(9)})])]),tr=f.ea.get().tr.insertText('AA',1);tr.insertText('AA',tr.doc.firstChild!.content.size+1);f.ea.dispatch(tr);const actions=sourceLeafActions(f.ea.store,key,expected,captured);f.a.transact(()=>actions.forEach(action=>action()),'source-receipt');assert.deepEqual(jsonToSnapshot(f.ea.store.project().toJSON())[0].content.inlines.map(part=>[part.text,part.nodeId]),[['AA',undefined],['AAA😀AAA',source(9)],['AA',undefined]]);assert.deepEqual(f.ea.errors,[])}finally{f.close()}
})
test('text-only batch extraction leaves structural and atom-removal transactions on the existing path',async()=>{
 const f=pair('AAA');try{await Promise.resolve();const state=f.ea.get(),tr=state.tr.insertText('AA',1).insertText('B',4).addMark(1,3,schema.mark('bold'));assert.equal(structureTextSplices([tr]).length,0);assert.equal(structureTextEdits([tr])[0].edits.length,2);assert.deepEqual(structureTextEdits([state.tr.split(2)]),[]);assert.deepEqual(structureTextEdits([state.tr.insertText('AA',1).split(2)]),[])
  const reference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}},atom=schema.nodes.hcdMention.createChecked({reference}),doc=schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked({hcdStructureKey:'atom-root'},[schema.text('A'),atom,schema.text('A')])]),s=EditorState.create({schema,doc});assert.deepEqual(structureTextEdits([s.tr.delete(2,3).insertText('Z',1)]),[])
 }finally{f.close()}
})
test('capacity refusal preserves the document and the next smaller edit remains usable',async()=>{
 const f=pair('AAA');try{await Promise.resolve();const bytes=Y.encodeStateAsUpdate(f.a),before=f.ea.get().doc,tr=f.ea.get().tr;for(let i=0;i<257;i++)tr.insertText('A',1);f.ea.dispatch(tr);assert.ok(f.ea.get().doc.eq(before));assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes);assert.equal((f.ea.errors[0] as Error).message,'semanticTextEditsLimit');f.ea.dispatch(f.ea.get().tr.insertText('Z',1));assert.equal(f.ea.get().doc.textContent,'ZAAA')}finally{f.close()}
})
test('read-only filtering refuses multi-step typing without moving shared state',async()=>{
 const f=pair('AAA');try{await Promise.resolve();f.ea.setEditable(false);const bytes=Y.encodeStateAsUpdate(f.a),doc=f.ea.get().doc;f.ea.dispatch(f.ea.get().tr.insertText('AA',1).insertText('AA',4));assert.ok(f.ea.get().doc.eq(doc));assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)}finally{f.close()}
})


test('multi-step final formatting preserves custom marks and does not overwrite an unseen peer format',()=>{
 const a=flowFixture('AAA'),bDoc=new Y.Doc({gc:false}),bCarriers=bDoc.getMap<Y.XmlFragment>('carriers'),bFlow=new SemanticTextFlow(bDoc,bCarriers,schema)
 const value={schemaVersion:'hcd.mark/1',type:'example.review',version:9,data:{ticket:'R-1'},fallback:{label:'Review',style:{backgroundColor:'#fff2a8'}}}
 try{
  a.raw.format(1,1,{'hcdCustomMark:example.review':{value}});Y.applyUpdate(bDoc,Y.encodeStateAsUpdate(a.document));const bRaw=bCarriers.get('root')!.get(0) as Y.XmlText;bDoc.transact(()=>bRaw.format(1,1,{italic:{}}),bFlow.origin)
  const before=a.flow.read('root'),body=schema.nodes.paragraph.createChecked(null,[schema.text('AA',[schema.mark('bold')]),...before.content,schema.text('AA',[schema.mark('underline')])])
  a.flow.writeEdits('root',body,[{from:0,to:0,insert:insert('AA')},{from:5,to:5,insert:insert('AA')}]);exchange(a.document,bDoc)
  const result=a.flow.read('root');assert.equal(result.textBetween(0,result.size),'AAAAAAA');let middle:PmNode|undefined;result.forEach((node,from)=>{if(from<=3&&from+node.nodeSize>3)middle=node})
  assert.ok(middle!.marks.some(mark=>mark.type.name==='italic'));assert.deepEqual(middle!.marks.find(mark=>mark.type.name==='hcdCustomMark')?.attrs.value,value);assert.ok(result.firstChild!.marks.some(mark=>mark.type.name==='bold'));assert.ok(result.lastChild!.marks.some(mark=>mark.type.name==='underline'))
 }finally{a.document.destroy();bDoc.destroy()}
})
