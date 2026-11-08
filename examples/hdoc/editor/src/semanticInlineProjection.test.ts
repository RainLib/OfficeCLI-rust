import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {Editor,getSchema,type JSONContent} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection,type Inline} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticInlineContainers,inlineContainerNodeName,type InlineContainerPayload} from './semanticInlineContainers.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {captureSourceLeaf,sourceLeafActions,type SourceBindingStore} from './semanticSourceBindings.ts'
import {checkpointContents} from './checkpointSnapshot.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
const registry=new InlineContainerRegistry([{type:'example.inline_field',version:77,display:'inline',contentModel:'inline',label:'Field',defaultData:{project:'P-1'},validate:data=>typeof data.project==='string'&&/^P-\d+$/.test(data.project),fallback:()=> 'Field label'}])
const editableInlineNode=SemanticInlineContainerNode.configure({registry:()=>registry})
const models={inlineContainers:true} as const,schema=getSchema([...schemaExtensions,SemanticInlineContainerNode]),origin=Object.freeze({kind:'inline-projection-user'}),receiptOrigin=Object.freeze({kind:'inline-projection-receipt'})
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`,source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const payload=(n:number):InlineContainerPayload=>({schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.inline_field',version:77,display:'inline',contentModel:'inline',data:{project:`P-${n}`},fallback:{text:'Field label'}})
const field=(n:number,inlines:Inline[]=[]):Inline=>({text:'',content:{kind:'extension',extension:payload(n),inlines}})
const projection=(inlines:Inline[]):Projection=>({documentId:'inline-projection',revision:1,blocks:[{blockId:source(1),blockHash:'fixture',region:'body',readOnly:false,content:{kind:'paragraph',inlines}}]})
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,item])=>item!==null&&item!==undefined&&!(item===false&&['bold','italic','underline','strike','code','hardBreak','fontSizeExplicit'].includes(key))&&!(Array.isArray(item)&&!item.length&&['children','customMarks'].includes(key))).map(([key,item])=>[key,canonical(item)]))
 return value
}
const mark={schemaVersion:'hcd.mark/1' as const,type:'example.review',version:19,data:{ticket:'R-9'},fallback:{label:'Review',style:{backgroundColor:'#fff2a8'}}}
const mention={type:'hcd.mention' as const,version:1 as const,mentionId:'m_'+'a'.repeat(32),target:{kind:'person' as const,id:'alice'},snapshot:{label:'Alice 王'}}
function rich(){return projection([{text:'Before',nodeId:source(2)},field(1,[{text:'中文😀',nodeId:source(3),bold:true,underline:true,customMarks:[mark],typography:{family:'Arial',sizePt:14},fontSizeExplicit:true},field(2,[{text:'@Alice 王',nodeId:source(4),reference:mention}]),{text:'\n',hardBreak:true,nodeId:source(5),customMarks:[mark],bold:true,typography:{sizePt:13}},{text:'After',nodeId:source(6),textColor:'#123456',backgroundColor:'#fff2a8',border:{color:'#123456',widthPt:1,style:'solid'}}]),field(3,[{text:'',nodeId:source(7),typography:{family:'Arial',sizePt:12},fontSizeExplicit:true}]),{text:'Tail',nodeId:source(8)}])}
const first=(json:JSONContent)=>schema.nodeFromJSON(json).firstChild!
function replica(document=new Y.Doc({gc:false})){
 const contents=document.getMap<Y.XmlFragment>('carriers'),containers=new SemanticInlineContainers(document,schema,origin),flow=new SemanticTextFlow(document,contents,schema,origin,containers)
 const store:SourceBindingStore={flow,contents,content:key=>schema.nodes.paragraph.create(null,flow.read(key).content)}
 return{document,contents,containers,flow,store}
}
function install(r:ReturnType<typeof replica>,node:PmNode){const fragment=new Y.XmlFragment();r.contents.set('root',fragment);fragment.insert(0,[new Y.XmlText()]);r.containers.write(fragment.get(0) as Y.XmlText,Fragment.empty,node);r.flow.initialize(['root'])}

test('explicit native/PM codec preserves nested bodies, empty sources, custom marks, mentions and formatted breaks',()=>{
 const input=rich(),json=projectionToJson(input,models),pm=schema.nodeFromJSON(json);pm.check()
 const after=jsonToSnapshot(pm.toJSON(),models)
 assert.deepEqual(canonical(after.map(block=>block.content)),canonical(input.blocks.map(block=>block.content)))
 assert.equal(pm.firstChild!.child(1).attrs.extension.instanceId,id(1));assert.equal(pm.firstChild!.child(2).content.size,0);assert.equal(pm.firstChild!.child(2).attrs.hcdSourceId,source(7))
 assert.equal(checkpointContents(canonical(after) as typeof after),checkpointContents(canonical(input.blocks) as typeof after));assert.deepEqual(input,rich())
})
test('native false wrapper fields are accepted but text, styles, hidden metadata and block children refuse',()=>{
 const native=field(1,[{text:'Body'}]);Object.assign(native,{bold:false,italic:false,underline:false,strike:false,code:false,hardBreak:false})
 assert.equal(first(projectionToJson(projection([native]),models)).textContent,'Body')
 for(const extra of [{text:'fallback'},{bold:true},{nodeId:source(9)},{typography:{sizePt:14}},{reference:mention},{unknown:null},{content:null}])assert.throws(()=>projectionToJson(projection([{...native,...extra} as Inline]),models),/InlineContainer|inlineContainer/)
 const invalid=field(1);(invalid.content as any).children=[{kind:'paragraph',inlines:[{text:'Hidden'}]}];assert.throws(()=>projectionToJson(projection([invalid]),models),/InlineContainer/)
})
test('default projection and snapshot still refuse the new model, including opaque wrappers',()=>{
 const input=rich();assert.throws(()=>projectionToJson(input),/unsupportedInlineContainerModel/)
 const json=projectionToJson(input,models);assert.throws(()=>jsonToSnapshot(json),/unsupportedInlineContainerModel/)
 const opaque=rich();opaque.blocks[0].readOnly=true;assert.throws(()=>projectionToJson(opaque),/unsupportedInlineContainerModel/)
 assert.deepEqual(jsonToSnapshot(projectionToJson(opaque,models),models)[0].content,opaque.blocks[0].content)
})
test('duplicate container/atom identities across roots, code bodies and excessive depth reject',()=>{
 const value=projection([field(1)]);value.blocks.push({...value.blocks[0],blockId:source(9)});assert.throws(()=>projectionToJson(value,models),/duplicateInlineContainerIdentity/)
 const atom={schemaVersion:'hcd.extension/1' as const,instanceId:id(1),type:'example.atom',version:1,display:'inline' as const,data:{},fallback:{text:'Atom'}}
 assert.throws(()=>projectionToJson(projection([field(1),{text:'Atom',extension:atom}]),models),/duplicateInlineContainerIdentity/)
 const code=projection([field(1)]);code.blocks[0].content.kind='code_block';assert.throws(()=>projectionToJson(code,models),/invalidInlineContainerProjection/)
 let nested=field(30);for(let i=29;i>0;i--)nested=field(i,[nested]);assert.throws(()=>projectionToJson(projection([nested]),models),/inlineContainerSpanLimit/)
 let json:JSONContent={type:'text',text:'Deep'};for(let i=30;i>0;i--)json={type:inlineContainerNodeName,attrs:{extension:payload(i)},content:[json]};assert.throws(()=>jsonToSnapshot({type:'doc',content:[{type:'paragraph',content:[json]}]},models),/inlineContainerDepthLimit/)
})
test('snapshot refuses source/style marks or undeclared metadata on the wrapper itself',()=>{
 for(const change of [{marks:[{type:'bold'}]},{attrs:{extension:payload(1),hidden:'do not drop'}}]){const json=projectionToJson(projection([field(1)]),models);Object.assign(json.content![0].content![0],change);assert.throws(()=>jsonToSnapshot(json,models),/invalidInlineContainerProjection/)}
})
test('permanent bodies store source defaults separately from immutable business definitions and reload them',()=>{
 const input=rich(),r=replica(),next=replica()
 try{
  install(r,first(projectionToJson(input,models)))
  const definition=structuredClone(r.containers.definitions.get(id(3))),body=r.containers.bodies.get(id(3))!
  assert.equal(body.length,0);assert.equal(body.getAttribute('hcdSourceId'),source(7));assert.equal(definition!.node.attrs.hcdSourceId,null)
  const history=r.flow.undoManager(),count=history.undoStack.length,actions=r.containers.sourceDefaultActions(id(3),{hcdSourceId:source(10),hcdSourceTypography:{family:'Arial',sizePt:16},hcdSourceSizeExplicit:true})
  r.document.transact(transaction=>{transaction.meta.set('addToHistory',false);actions.forEach(action=>action())},receiptOrigin)
  assert.equal(history.undoStack.length,count);assert.deepEqual(r.containers.definitions.get(id(3)),definition);assert.equal(r.containers.readBody(id(3)).attrs.hcdSourceId,source(10));history.destroy()
  Y.applyUpdate(next.document,Y.encodeStateAsUpdate(r.document));assert.deepEqual(next.containers.readBody(id(3)).toJSON(),r.containers.readBody(id(3)).toJSON())
 }finally{r.document.destroy();next.document.destroy()}
})
test('recursive receipt binds empty body defaults without stamping late peer input or changing undo',()=>{
 const r=replica(),peer=replica(),initial=projection([field(1)]),expected=first(projectionToJson(projection([field(1,[{text:'',nodeId:source(11),typography:{family:'Arial',sizePt:14},fontSizeExplicit:true}])]),models))
 try{
  install(r,first(projectionToJson(initial,models)));Y.applyUpdate(peer.document,Y.encodeStateAsUpdate(r.document))
  const binding=captureSourceLeaf(r.store,'root',r.store.content('root')),history=r.flow.undoManager(),definition=structuredClone(r.containers.definitions.get(id(1)))
  peer.containers.bodies.get(id(1))!.insert(0,'Late peer input',{});Y.applyUpdate(r.document,Y.encodeStateAsUpdate(peer.document))
  const actions=sourceLeafActions(r.store,'root',expected,binding),size=history.undoStack.length
  r.document.transact(transaction=>{transaction.meta.set('addToHistory',false);actions.forEach(action=>action())},receiptOrigin)
  const actual=r.containers.readBody(id(1));assert.equal(actual.textContent,'Late peer input');assert.equal(actual.attrs.hcdSourceId,source(11));assert.equal(actual.firstChild!.marks.some(mark=>mark.type.name==='hcdSource'),false);assert.equal(history.undoStack.length,size);assert.deepEqual(r.containers.definitions.get(id(1)),definition);history.destroy()
 }finally{r.document.destroy();peer.document.destroy()}
})
test('typing in a nested empty body inherits its own canonical font/source',()=>{
 const input=projection([{text:'Outer',nodeId:source(2),typography:{sizePt:20}},field(1,[field(2,[{text:'',nodeId:source(3),typography:{family:'Arial',sizePt:12},fontSizeExplicit:true}])])])
 const editor=new Editor({element:null,extensions:[...schemaExtensions,editableInlineNode],content:projectionToJson(input,models)})
 editor.view.updateState(editor.state.reconfigure({plugins:editor.extensionManager.plugins}))
 try{
  let position=-1;editor.state.doc.descendants((node,pos)=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(2))position=pos})
  editor.view.dispatch(editor.state.tr.insertText('新😀',position+1));const body=editor.state.doc.nodeAt(position)!,run=body.firstChild!
  assert.equal(run.text,'新😀');assert.equal(run.marks.find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId,source(3));assert.equal(run.marks.find(mark=>mark.type.name==='textTypography')?.attrs.sizePt,12);assert.equal(run.marks.find(mark=>mark.type.name==='textTypography')?.attrs.explicitSize,true)
  const result=jsonToSnapshot(editor.getJSON(),models)[0].content.inlines[1].content!.inlines[0].content!.inlines[0];assert.equal(result.nodeId,source(3));assert.equal(result.typography?.sizePt,12)
 }finally{editor.destroy()}
})
test('an unmapped empty body never borrows its enclosing paragraph source or font',()=>{
 const editor=new Editor({element:null,extensions:[...schemaExtensions,editableInlineNode],content:projectionToJson(projection([{text:'Outer',nodeId:source(2),typography:{sizePt:20}},field(1)]),models)})
 editor.view.updateState(editor.state.reconfigure({plugins:editor.extensionManager.plugins}))
 try{const position=editor.state.doc.firstChild!.firstChild!.nodeSize+1;editor.view.dispatch(editor.state.tr.insertText('New',position+1));const run=editor.state.doc.nodeAt(position)!.firstChild!;assert.equal(run.text,'New');assert.equal(run.marks.some(mark=>['hcdSource','textTypography'].includes(mark.type.name)),false)}finally{editor.destroy()}
})
test('invalid defaults refuse before allocation and malformed stored defaults never silently disappear',()=>{
 const r=replica(),fragment=new Y.XmlFragment();r.contents.set('root',fragment);fragment.insert(0,[new Y.XmlText()]);const text=fragment.get(0) as Y.XmlText
 try{
  const before=Y.encodeStateAsUpdate(r.document)
  assert.throws(()=>{const child=schema.nodes[inlineContainerNodeName].create({extension:payload(1),hcdSourceId:'other-source'});r.containers.write(text,Fragment.empty,schema.nodes.paragraph.create(null,[child]))},/invalidInlineSourceDefaults/);assert.deepEqual(Y.encodeStateAsUpdate(r.document),before);assert.equal(r.containers.bodies.size,0)
  const invalid=schema.nodes[inlineContainerNodeName].create({extension:payload(1),hcdSourceId:source(2),hcdSourceTypography:{sizePt:12.3},hcdSourceSizeExplicit:true})
  assert.throws(()=>r.containers.write(text,Fragment.empty,schema.nodes.paragraph.create(null,[invalid])),/invalidInlineSourceDefaults/);assert.deepEqual(Y.encodeStateAsUpdate(r.document),before)
  r.containers.write(text,Fragment.empty,first(projectionToJson(projection([field(1)]),models)))
  assert.throws(()=>r.containers.sourceDefaultActions(id(1),{hcdSourceId:source(2),hcdSourceTypography:{sizePt:12.3},hcdSourceSizeExplicit:true}),/invalidInlineSourceDefaults/)
  r.containers.bodies.get(id(1))!.setAttribute('hidden','unknown');assert.throws(()=>r.containers.readBody(id(1)),/invalidInlineSourceDefaults/)
 }finally{r.document.destroy()}
})
test('plain legacy projections keep their default serialization and the new schema is not active',()=>{
 const value=projection([{text:'Same',nodeId:source(2),bold:true}]),json=projectionToJson(value)
 assert.deepEqual(projectionToJson(value,models),json);assert.deepEqual(jsonToSnapshot(json,models),jsonToSnapshot(json));assert.equal(schemaExtensions.some(extension=>extension.name===inlineContainerNodeName),false)
})
