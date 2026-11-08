import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import * as Y from 'yjs'
import {schemaExtensions,jsonToSnapshot,parseInlineColor} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {CustomMarkRegistry,readCustomMark,applyCustomMark,customMarkPreservationPlugin,customMarkHtmlScope,type CustomMarkDefinition} from './customMarks.ts'
import {prepareExtensionHistoryGuard} from './extensionHistory.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'
import {Fragment} from '@tiptap/pm/model'
import {SemanticHistory} from './semanticHistory.ts'
import {CollaborativeImageDraftStore} from './collaborativeImages.ts'
const definition:CustomMarkDefinition={type:'example.review',version:1,label:{'zh-CN':'需复核','en-US':'Review'},defaultData:{ticket:'T-1'},validate:data=>typeof data.ticket==='string',fallback:data=>({label:'Review '+data.ticket,style:{backgroundColor:'#fff2a8',bold:true}})}
const schema=()=>getSchema([...schemaExtensions,SemanticStructureIdentity])
test('editable mark DOM does not expose fallback CSS as ordinary formatting during browser reparsing',()=>{
 const s=schema(),value=new CustomMarkRegistry([definition]).create(definition.type),mark=s.marks.hcdCustomMark.create({value}),spec=s.marks.hcdCustomMark.spec.toDOM!(mark,true) as [string,Record<string,string>,number]
 assert.equal(spec[1].class,'hcd-custom-text-mark')
 assert.match(spec[1].style,/--hcd-mark-font-weight:700/)
 assert.doesNotMatch(spec[1].style,/(^|;)(font-weight|font-style|text-decoration|color|background-color):/)
 assert.deepEqual(JSON.parse(spec[1]['data-hcd-custom-mark']),value)
})
test('clipboard colors normalize CSSOM RGB and reject nonopaque or executable values',()=>{
 assert.equal(parseInlineColor('rgb(36, 106, 75)'),'#246a4b')
 assert.equal(parseInlineColor('#ABCDEF'),'#abcdef')
 assert.equal(parseInlineColor('#abc'),'#aabbcc')
 for(const value of ['rgb(256, 0, 0)','rgb(-1, 0, 0)','rgba(0,0,0,0.5)','url(bad)','var(--secret)',null])assert.equal(parseInlineColor(value),null)
})
test('HTML text metadata and nested wrappers agree, while plural-only marks remain recoverable',()=>{
 const registry=new CustomMarkRegistry([definition,{...definition,type:'example.legal'}]),a=registry.create('example.legal'),b=registry.create(definition.type),pair=[a,b]
 assert.deepEqual(customMarkHtmlScope('SPAN',{'data-hcd-custom-marks':JSON.stringify(pair)},[]).marks,pair)
 assert.deepEqual(customMarkHtmlScope('span',{'data-hcd-custom-marks':JSON.stringify(pair)},pair).marks,pair)
 assert.deepEqual(customMarkHtmlScope('span',{'data-hcd-custom-mark':JSON.stringify(b)},[a]).marks,pair)
 assert.throws(()=>customMarkHtmlScope('span',{'data-hcd-custom-marks':JSON.stringify([a])},pair),/unsupportedCustomMark/)
 assert.throws(()=>customMarkHtmlScope('span',{'data-hcd-custom-marks':JSON.stringify([b,a])},[]),/unsupportedCustomMark/)
 assert.throws(()=>customMarkHtmlScope('div',{'data-hcd-custom-mark':JSON.stringify(b)},[]),/unsupportedCustomMark/)
 assert.throws(()=>customMarkHtmlScope('span',{'data-hcd-custom-mark-style':'true'},[]),/unsupportedCustomMark/)
 assert.throws(()=>customMarkHtmlScope('span',{'data-hcd-custom-mark':JSON.stringify(b),'data-hcd-custom-marks':JSON.stringify([b])},[]),/unsupportedCustomMark/)
})
test('custom mark definitions freeze host data, reject executable styles and nondeterministic fallbacks',()=>{
 const registry=new CustomMarkRegistry([definition]),value=registry.create(definition.type);assert.equal(registry.resolve(value),true)
 assert.throws(()=>readCustomMark({...value,fallback:{label:'bad',style:{backgroundColor:'url(https://bad)'}}}));let call=0;assert.throws(()=>new CustomMarkRegistry([{...definition,fallback:()=>({label:String(++call),style:{}})}]),/NonDeterministic/)
 assert.throws(()=>registry.create(definition.type,{ticket:1}));const copy=structuredClone(value);copy.data.ticket='T-2';assert.equal(registry.resolve(copy),false)
})
test('two custom mark types survive permanent text, split formatting, new peer and canonical snapshots',()=>{
 const s=schema(),doc=new Y.Doc(),store=new SemanticBlockStore(doc,s),registry=new CustomMarkRegistry([definition,{...definition,type:'example.legal'}]),a=registry.create(definition.type),b=registry.create('example.legal'),paragraph=s.nodes.paragraph.createChecked(null,s.text('甲中😀乙'));store.initialize(s.nodes.doc.createChecked(null,paragraph));const key=store.keys()[0]
 let state=EditorState.create({schema:s,doc:store.project()});let tr=state.tr.setSelection(TextSelection.create(state.doc,2,5));assert.ok(applyCustomMark(tr,a));assert.ok(applyCustomMark(tr,b));state=state.apply(tr);store.reconcile(store.blocks(),state.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
 const peer=new Y.Doc();Y.applyUpdate(peer,Y.encodeStateAsUpdate(doc));const next=new SemanticBlockStore(peer,s),snap=jsonToSnapshot(next.project().toJSON());assert.equal(snap[0].content.inlines.find(inline=>inline.text==='中😀')!.customMarks?.length,2);assert.deepEqual(next.project().toJSON(),store.project().toJSON());doc.destroy();peer.destroy();assert.ok(key)
})
test('unavailable mark protects its text and attributes while allowing surrounding edits and source receipts',()=>{
 const s=schema(),value=new CustomMarkRegistry([definition]).create(definition.type),mark=s.marks.hcdCustomMark.create({value}),doc=s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,[s.text('left '),s.text('locked',[mark]),s.text(' right')])),state=EditorState.create({schema:s,doc,plugins:[customMarkPreservationPlugin(()=>undefined)]})
 assert.ok(state.applyTransaction(state.tr.insertText('!',1)).state.doc.textContent.startsWith('!left'))
 assert.equal(state.applyTransaction(state.tr.insertText('X',8)).state.doc.eq(doc),true);assert.equal(state.applyTransaction(state.tr.delete(6,12)).state.doc.eq(doc),true)
 assert.equal(state.applyTransaction(state.tr.addMark(6,12,s.marks.bold.create())).state.doc.eq(doc),true)
 assert.equal(state.applyTransaction(state.tr.addMark(6,12,s.marks.hcdSource.create({nodeId:'n_'+'a'.repeat(32)}))).transactions.length,1)
})
test('offline overlapping mark types merge and own undo keeps peer marks and new characters',()=>{
 const s=schema(),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,s),sb=new SemanticBlockStore(b,s),registry=new CustomMarkRegistry([definition,{...definition,type:'example.legal'}]);sa.initialize(s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,s.text('共同文本'))));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const undo=sa.undoManager()
 const edit=(store:SemanticBlockStore,value:ReturnType<CustomMarkRegistry['create']>)=>{const state=EditorState.create({schema:s,doc:store.project()}),tr=state.tr.setSelection(TextSelection.create(state.doc,1,5));assert.ok(applyCustomMark(tr,value));store.reconcile(store.blocks(),tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))}
 try{edit(sa,registry.create(definition.type));undo.stopCapturing();edit(sb,registry.create('example.legal'));const key=sb.keys()[0],old=sb.content(key);sb.update(key,old,old.copy(old.content.append(Fragment.from(s.text(' · Bob')))));Y.applyUpdate(a,Y.encodeStateAsUpdate(b));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual(sa.project().toJSON(),sb.project().toJSON());assert.equal(jsonToSnapshot(sa.project().toJSON())[0].content.inlines[0].customMarks?.length,2);assert.ok(undo.undo());assert.match(sa.project().textContent,/Bob/);assert.deepEqual(jsonToSnapshot(sa.project().toJSON())[0].content.inlines[0].customMarks?.map(mark=>mark.type),['example.legal']);assert.ok(undo.redo());assert.equal(jsonToSnapshot(sa.project().toJSON())[0].content.inlines[0].customMarks?.length,2)}finally{undo.destroy();a.destroy();b.destroy()}
})
test('unregistering a custom mark blocks destructive own undo and loading resumes the same record',()=>{
 const s=schema(),document=new Y.Doc(),registry=new NodeExtensionRegistry(),disconnect=registry.connect(),release=registry.registerMarks([definition]),store=new SemanticBlockStore(document,s),value=registry.createMark(definition.type),mark=s.marks.hcdCustomMark.create({value});store.initialize(s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,s.text('Text'))));const undo=store.undoManager(true,before=>prepareExtensionHistoryGuard(before,registry)),key=store.keys()[0],old=store.content(key)
 try{store.update(key,old,old.copy(Fragment.from(s.text('Text',[mark]))));undo.stopCapturing();release();const bytes=Y.encodeStateAsUpdate(document);assert.throws(()=>undo.undo(),/historyExtensionUnavailable/);assert.deepEqual(Y.encodeStateAsUpdate(document),bytes);const available=registry.registerMarks([definition]);try{assert.ok(undo.undo());assert.equal(jsonToSnapshot(store.project().toJSON())[0].content.inlines[0].customMarks,undefined)}finally{available()}}finally{release();disconnect();undo.destroy();document.destroy()}
})
test('skipping an unavailable mark action leaves its content and permits an older unrelated text undo',async()=>{
 const s=schema(),document=new Y.Doc(),registry=new NodeExtensionRegistry(),disconnect=registry.connect(),release=registry.registerMarks([definition]),store=new SemanticBlockStore(document,s);store.initialize(s.nodes.doc.createChecked(null,['Outside','Text'].map(text=>s.nodes.paragraph.createChecked(null,s.text(text)))));const undo=store.undoManager(true,before=>prepareExtensionHistoryGuard(before,registry)),images=new CollaborativeImageDraftStore(document),history=new SemanticHistory(images,undo,()=>false,async()=>{throw new Error('no image request')}),close=history.connect(),[outside,marked]=store.keys()
 try{const plain=store.content(outside);store.update(outside,plain,plain.copy(Fragment.from(s.text('Outside edited'))));history.stopCapturing();const old=store.content(marked);store.update(marked,old,old.copy(Fragment.from(s.text('Text',[s.marks.hcdCustomMark.create({value:registry.createMark(definition.type)})]))));history.stopCapturing();release();await assert.rejects(history.step('undo'),/historyExtensionUnavailable/);const bytes=Y.encodeStateAsUpdate(document);history.skip('undo',history.snapshot());assert.deepEqual(Y.encodeStateAsUpdate(document),bytes);await history.step('undo');assert.equal(store.project().firstChild!.textContent,'Outside');assert.equal(jsonToSnapshot(store.project().toJSON())[1].content.inlines[0].customMarks?.[0].type,definition.type)}finally{close();release();disconnect();undo.destroy();document.destroy()}
})
test('room shadow rejects malformed and incorrectly encoded custom marks without touching shared bytes',()=>{
 const s=schema(),document=new Y.Doc(),store=new SemanticBlockStore(document,s);store.initialize(s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,s.text('Text'))));const guard=new RoomProtocolGuard(document,structuralProtocol),value=new CustomMarkRegistry([definition]).create(definition.type)
 try{for(const [key,attrs]of [['hcdCustomMark:example.review',{value:{...value,fallback:{label:'bad',style:{backgroundColor:'url(bad)'}}}}],['hcdCustomMark',{value}],['hcdCustomMark:example.foreign',{value}]] as const){const peer=new Y.Doc();try{Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));const copy=new SemanticBlockStore(peer,s),text=copy.contents.get(copy.keys()[0])!.get(0) as Y.XmlText;text.format(0,4,{[key]:attrs});const before=Y.encodeStateAsUpdate(document);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer)));assert.deepEqual(Y.encodeStateAsUpdate(document),before)}finally{peer.destroy()}}}finally{guard.destroy();document.destroy()}
})
test('cursor mark affects only subsequent typing and creates no empty exported annotation',()=>{
 const s=schema(),value=new CustomMarkRegistry([definition]).create(definition.type),state=EditorState.create({schema:s,doc:s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,s.text('prefix ')))}),tr=state.tr.setSelection(TextSelection.create(state.doc,8));assert.ok(applyCustomMark(tr,value));assert.equal(tr.docChanged,false);assert.equal(jsonToSnapshot(tr.doc.toJSON())[0].content.inlines[0].customMarks,undefined);const marked=state.apply(tr),typed=marked.apply(marked.tr.insertText('新文字'));assert.deepEqual(jsonToSnapshot(typed.doc.toJSON())[0].content.inlines.map(inline=>[inline.text,inline.customMarks?.[0].type]),[['prefix ',undefined],['新文字','example.review']])
})
test('local formatting order matches canonical type order and repeated apply is a real no-op',()=>{
 const s=schema(),registry=new CustomMarkRegistry([{...definition,type:'example.z',fallback:()=>({label:'Z',style:{textColor:'#ff0000'}})},{...definition,type:'example.a',fallback:()=>({label:'A',style:{textColor:'#0000ff'}})}]),state=EditorState.create({schema:s,doc:s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,s.text('Text')))}),tr=state.tr.setSelection(TextSelection.create(state.doc,1,5));assert.ok(applyCustomMark(tr,registry.create('example.z')));assert.ok(applyCustomMark(tr,registry.create('example.a')));assert.deepEqual(tr.doc.firstChild!.firstChild!.marks.map(mark=>mark.attrs.value.type),['example.a','example.z']);const next=state.apply(tr),again=next.tr;assert.equal(applyCustomMark(again,registry.create('example.z')),false);assert.equal(again.docChanged,false)
})
test('overlap limits reject the complete mixed selection before changing its earlier plain text',()=>{
 const s=schema(),definitions=Array.from({length:9},(_,index)=>({...definition,type:`example.kind${index}`})),registry=new CustomMarkRegistry(definitions),marks=definitions.slice(0,8).map(def=>s.marks.hcdCustomMark.create({value:registry.create(def.type)})),doc=s.nodes.doc.createChecked(null,s.nodes.paragraph.createChecked(null,[s.text('plain '),s.text('covered',marks)])),state=EditorState.create({schema:s,doc}),tr=state.tr.setSelection(TextSelection.create(doc,1,doc.content.size-1));assert.throws(()=>applyCustomMark(tr,registry.create('example.kind8')),/customMarkLimit/);assert.equal(tr.docChanged,false);assert.ok(tr.doc.eq(doc))
})
