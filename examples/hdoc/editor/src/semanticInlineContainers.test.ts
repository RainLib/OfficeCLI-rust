import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,Node} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,projectionToJson,type Projection} from './schema.ts'
import {readExtensionNode} from './extensionNode.ts'
import {readSemanticInline,validateSemanticInline} from './semanticInlineContent.ts'
import {SemanticInlineContainers,inlineContainerNodeName,inlineContainerFields} from './semanticInlineContainers.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {structuralProtocol} from './collaborationProtocol.ts'

// Not registered by the active editor: the room protocol is deliberately not
// advertised until guards, property intents and deletion review integrate it.
const InlineContainer=Node.create({name:inlineContainerNodeName,inline:true,group:'inline',content:'inline*',marks:'_',isolating:true,defining:true,addAttributes(){return{extension:{default:null}}}})
const schema=getSchema([...schemaExtensions,InlineContainer])
const text=(value:string,marks:string[]=[])=>schema.text(value,marks.map(mark=>schema.mark(mark)))
const paragraph=(children:PmNode[]=[])=>schema.nodes.paragraph.createChecked(null,children)
const id=(number:number)=>`x_${number.toString(16).padStart(32,'0')}`
function container(number:number,children:PmNode[]=[],data:Record<string,unknown>={project:'P-27'}){
 return schema.nodes[inlineContainerNodeName].createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:id(number),type:'example.inline_field',version:77,display:'inline',contentModel:'inline',data,fallback:{text:'Field label'}}},children)
}
function replica(document=new Y.Doc({gc:false})){
 const root=document.get('parent',Y.XmlText),store=new SemanticInlineContainers(document,schema)
 return{document,root,store,read:()=>store.read(root),write:(node:PmNode)=>store.write(root,store.read(root),node)}
}
function fixture(node=paragraph([text('A'),container(1,[text('Shared中😀')]),text('Z')])){
 const a=replica(),b=replica();a.write(node);Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
 return{a,b,close(){a.document.destroy();b.document.destroy()}}
}
function exchange(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}
const visible=(fragment:Fragment)=>fragment.textBetween(0,fragment.size,'\n','\n')
const edit=(replica:ReturnType<typeof fixture>['a'],value:string,marks:string[]=[])=>replica.write(paragraph([text('A'),container(1,[text(value,marks)]),text('Z')]))

test('parent references never contain body JSON; nested and empty containers have permanent carriers',()=>{
 const node=paragraph([text('A'),container(1,[text('Outer'),container(2,[text('Nested😀')])]),container(3),text('Z')]),a=replica()
 try{
  a.write(node);assert.deepEqual(a.read().toJSON(),node.content.toJSON());assert.equal(a.root.length,4)
  assert.deepEqual(a.root.toDelta().filter((part:any)=>typeof part.insert==='object').map((part:any)=>part.insert),[1,3].map(number=>({hcdInlineContainer:{version:1,id:id(number)}})))
  assert.equal(a.store.bodies.size,3);assert.equal(a.store.bodies.get(id(3))!.length,0)
  const structural=JSON.stringify([...a.store.definitions]);assert.doesNotMatch(structural,/Outer|Nested|Shared/);assert.equal(a.store.readBody(id(1)).textContent,'OuterNested😀')
  assert.throws(()=>readExtensionNode(node.child(1).attrs.extension),/unsupportedExtensionNode/)
  assert.throws(()=>validateSemanticInline(node),/unsupportedInlineContent/)
  assert.throws(()=>readSemanticInline(a.root,schema),/unsupportedNodeContent/)
 }finally{a.document.destroy()}
})

test('active projection reader refuses native empty-text wrappers instead of dropping their bodies',()=>{
 const inline={text:'',content:{kind:'extension',extension:container(1).attrs.extension,inlines:[{text:'Must survive'}]}}
 for(const readOnly of [false,true])for(const nested of [false,true]){
  const content={kind:'paragraph',inlines:[inline]},projection={documentId:'doc',revision:1,blocks:[{blockId:'n_'+'a'.repeat(32),blockHash:'hash',region:'body',readOnly,content:nested?{kind:'blockquote',inlines:[],children:[content]}:content}]} as unknown as Projection
  const before=structuredClone(projection);assert.throws(()=>projectionToJson(projection),/unsupportedInlineContainerModel/);assert.deepEqual(projection,before)
 }
})

for(const reverse of [false,true]){
 test(`offline body input merges by permanent characters and own undo preserves peer text, reverse=${reverse}`,()=>{
  const f=fixture(),history=f.a.store.undoManager([f.a.root])
  try{
   const body=f.a.store.bodies.get(id(1)),parent=JSON.stringify(f.a.root.toDelta()),bookmark=f.b.store.capture(f.b.root,2+'Shared中😀'.length)
   edit(f.a,'Local Shared中😀');edit(f.b,'Shared中😀 Peer')
   exchange(f.a.document,f.b.document,reverse)
   assert.equal(visible(f.a.read()),'ALocal Shared中😀 PeerZ');assert.deepEqual(f.a.read().toJSON(),f.b.read().toJSON());assert.equal(f.a.store.bodies.get(id(1)),body);assert.equal(JSON.stringify(f.a.root.toDelta()),parent)
   assert.equal(bookmark.containerId,id(1));assert.equal(f.a.store.resolve(f.a.root,bookmark),2+'Local Shared中😀'.length)
   history.undo();exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.read()),'AShared中😀 PeerZ');assert.deepEqual(f.a.read().toJSON(),f.b.read().toJSON())
   history.redo();exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.read()),'ALocal Shared中😀 PeerZ');assert.equal(f.a.store.bodies.get(id(1)),body)
  }finally{history.destroy();f.close()}
 })
 test(`moving the parent reference preserves concurrent child edits and relative positions, reverse=${reverse}`,()=>{
  const f=fixture(),history=f.a.store.undoManager([f.a.root])
  try{
   const body=f.a.store.bodies.get(id(1)),bookmark=f.b.store.capture(f.b.root,4)
   f.a.write(paragraph([container(1,[text('Shared中😀')]),text('AZ')]));edit(f.b,'Shared中😀 Peer')
   exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.read()),'Shared中😀 PeerAZ');assert.deepEqual(f.a.read().toJSON(),f.b.read().toJSON());assert.equal(f.a.store.resolve(f.a.root,bookmark),3);assert.equal(f.a.store.bodies.get(id(1)),body)
   history.undo();exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.read()),'AShared中😀 PeerZ');assert.equal(f.a.store.resolve(f.a.root,bookmark),4)
   history.redo();exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.read()),'Shared中😀 PeerAZ')
  }finally{history.destroy();f.close()}
 })
}

test('independent concurrent body formats merge without republishing the unchanged other format',()=>{
 const f=fixture(),history=f.a.store.undoManager([f.a.root])
 try{
  edit(f.a,'Shared中😀',['bold']);edit(f.b,'Shared中😀',['italic']);exchange(f.a.document,f.b.document)
  assert.deepEqual(f.a.read().child(1).firstChild!.marks.map(mark=>mark.type.name).sort(),['bold','italic'])
  history.undo();exchange(f.a.document,f.b.document);assert.deepEqual(f.a.read().child(1).firstChild!.marks.map(mark=>mark.type.name),['italic'])
  assert.deepEqual(f.a.read().toJSON(),f.b.read().toJSON())
 }finally{history.destroy();f.close()}
})

test('all PM positions roundtrip across nested/empty wrappers, UTF16 text, atoms and soft breaks',()=>{
 const mention=schema.nodes.hcdMention.create({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'1'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}}})
 const node=paragraph([text('中😀'),container(1,[text('X'),container(2),mention,schema.nodes.hardBreak.create(),text('YZ')]),text('Tail')]),a=replica()
 try{
  a.write(node)
  for(let offset=0;offset<=node.content.size;offset++)for(const assoc of [-1,0,1])assert.equal(a.store.resolve(a.root,a.store.capture(a.root,offset,assoc)),offset,`offset=${offset},assoc=${assoc}`)
  const empty=a.store.capture(a.root,6);assert.equal(empty.containerId,id(2))
  const before=a.read();a.write(paragraph([text('中😀'),container(1,[text('X'),container(2,[text('Filled😀')]),mention,schema.nodes.hardBreak.create(),text('YZ')]),text('Tail')]))
  assert.equal(a.store.resolve(a.root,empty),6);assert.equal(a.store.bodies.get(id(2))!.toString(),'Filled😀');assert.notDeepEqual(a.read().toJSON(),before.toJSON())
  assert.throws(()=>a.store.capture(a.root,-1),/invalidInlineContainerPosition/);assert.throws(()=>a.store.capture(a.root,999),/invalidInlineContainerPosition/)
 }finally{a.document.destroy()}
})

test('hidden body accepts late peer input and undo restores the same reference without copying text',()=>{
 const f=fixture(paragraph([container(1)])),history=f.a.store.undoManager([f.a.root])
 try{
  const body=f.a.store.bodies.get(id(1)),bookmark=f.b.store.capture(f.b.root,1)
  f.a.write(paragraph());f.b.write(paragraph([container(1,[text('Late peer input')])]))
  exchange(f.a.document,f.b.document);assert.equal(f.a.read().size,0);assert.equal(f.a.store.readBody(id(1)).textContent,'Late peer input');assert.equal(f.a.store.resolve(f.a.root,bookmark),null)
  history.undo();exchange(f.a.document,f.b.document);assert.equal(visible(f.a.read()),'Late peer input');assert.equal(f.a.store.bodies.get(id(1)),body);assert.equal(f.a.store.resolve(f.a.root,bookmark),1)
  history.redo();exchange(f.a.document,f.b.document);assert.equal(f.a.read().size,0);assert.equal(f.a.store.readBody(id(1)).textContent,'Late peer input')
 }finally{history.destroy();f.close()}
})

test('removing separated container references retains the characters and anchors between them',()=>{
 const a=replica()
 try{
  a.write(paragraph([container(1),text('Middle😀'),container(2),text('Z')]))
  const bookmark=a.store.capture(a.root,5)
  assert.equal(bookmark.containerId,null)
  a.write(paragraph([text('Middle😀Z')]))
  assert.equal(a.store.resolve(a.root,bookmark),3);assert.equal(a.store.bodies.size,2)
 }finally{a.document.destroy()}
})

test('undoing creation retains the allocated body for a peer input arriving after the wrapper disappeared',()=>{
 const f=fixture(paragraph([text('Before')])),history=f.a.store.undoManager([f.a.root])
 try{
  f.a.write(paragraph([text('Before'),container(1,[text('Own')])]))
  Y.applyUpdate(f.b.document,Y.encodeStateAsUpdate(f.a.document))
  const body=f.a.store.bodies.get(id(1))
  history.undo();assert.equal(visible(f.a.read()),'Before');assert.equal(f.a.store.bodies.get(id(1)),body)
  f.b.write(paragraph([text('Before'),container(1,[text('Own Peer')])]))
  exchange(f.a.document,f.b.document)
  assert.equal(visible(f.a.read()),'Before');assert.equal(f.a.store.readBody(id(1)).textContent,' Peer')
  history.redo();exchange(f.a.document,f.b.document)
  assert.equal(visible(f.a.read()),'BeforeOwn Peer');assert.equal(f.a.store.bodies.get(id(1)),body);assert.deepEqual(f.a.read().toJSON(),f.b.read().toJSON())
 }finally{history.destroy();f.close()}
})

test('reloaded Yjs state preserves nested identities, base/custom marks, sources, data and anchors',()=>{
 const mark={schemaVersion:'hcd.mark/1',type:'example.review',version:17,data:{ticket:'T-27'},fallback:{label:'Review',style:{backgroundColor:'#fff2a8'}}}
 const marked=schema.text('Shared中😀',[schema.mark('bold'),schema.mark('hcdCustomMark',{value:mark}),schema.mark('hcdSource',{nodeId:'n_'+'a'.repeat(32)})])
 const a=replica(),b=replica()
 try{
  a.write(paragraph([container(1,[marked,container(2,[text('Nested')])])]))
  const bookmark=a.store.capture(a.root,4),update=Y.encodeStateAsUpdate(a.document)
  Y.applyUpdate(b.document,update);assert.deepEqual(b.read().toJSON(),a.read().toJSON());assert.equal(b.store.resolve(b.root,bookmark),4)
  assert.equal(b.read().firstChild!.firstChild!.marks.find(mark=>mark.type.name==='hcdSource')!.attrs.nodeId,'n_'+'a'.repeat(32))
  assert.deepEqual(b.read().firstChild!.attrs.extension.data,{project:'P-27'});assert.equal(b.store.bodies.size,2)
 }finally{a.document.destroy();b.document.destroy()}
})

test('duplicate IDs, invalid wrappers, stale projections and identity changes refuse without changing bytes',()=>{
 const a=replica();a.write(paragraph([container(1,[text('Original')])]))
 const assertUnchanged=(operation:()=>void)=>{const before=Y.encodeStateAsUpdate(a.document);assert.throws(operation);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)}
 try{
  assertUnchanged(()=>a.write(paragraph([container(2),container(2)])))
  const changed=container(1,[text('Changed')]);assertUnchanged(()=>a.write(paragraph([changed.type.create({...changed.attrs,extension:{...changed.attrs.extension,type:'example.changed'}},changed.content)])))
  assertUnchanged(()=>a.store.write(a.root,Fragment.empty,paragraph([container(2)])))
  assertUnchanged(()=>a.store.write(a.store.bodies.get(id(1))!,Fragment.empty,paragraph([container(1)])))
  assertUnchanged(()=>a.write(paragraph([container(2).mark([schema.mark('bold')])])))
  const bad=container(2);assertUnchanged(()=>a.write(paragraph([bad.type.create({...bad.attrs,extension:{...bad.attrs.extension,extra:true}},[text('bad')])])))
  assertUnchanged(()=>a.write(paragraph([bad.type.create({...bad.attrs,extension:{...bad.attrs.extension,fallback:{text:'bad\nlabel'}}},[text('bad')])])))
  assert.equal(a.store.bodies.size,1)
 }finally{a.document.destroy()}
})

test('wire7 shadow rejects internal body maps and parent references before they reach the active room',()=>{
 const activeSchema=getSchema([...schemaExtensions,SemanticStructureIdentity]),document=new Y.Doc(),store=new SemanticBlockStore(document,activeSchema)
 store.initialize(activeSchema.nodes.doc.createChecked(null,[activeSchema.nodes.paragraph.createChecked(null,activeSchema.text('Original'))]))
 const guard=new RoomProtocolGuard(document,structuralProtocol),seed=Y.encodeStateAsUpdate(document)
 try{
  for(const field of Object.values(inlineContainerFields)){
   const bad=new Y.Doc();Y.applyUpdate(bad,seed)
   bad.getMap(field).set(id(1),field===inlineContainerFields.bodies?new Y.XmlText():{version:1})
   const before=Y.encodeStateAsUpdate(document)
   assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(bad,Y.encodeStateVector(document))),/room-inline-container-model-unsupported/)
   assert.throws(()=>new RoomProtocolGuard(bad,structuralProtocol),/room-inline-container-model-unsupported/)
   assert.deepEqual(Y.encodeStateAsUpdate(document),before);bad.destroy()
  }
  const bad=new Y.Doc();Y.applyUpdate(bad,seed)
  const badStore=new SemanticBlockStore(bad,activeSchema),text=badStore.contents.get(badStore.keys()[0])!.get(0) as Y.XmlText
  text.insertEmbed(0,{hcdInlineContainer:{version:1,id:id(1)}})
  assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(bad,Y.encodeStateVector(document))),/room-inline-container-model-unsupported/)
  assert.deepEqual(Y.encodeStateAsUpdate(document),seed);bad.destroy()
  // A rejected future update must not poison the shadow for a normal peer.
  const peer=new Y.Doc();Y.applyUpdate(peer,seed)
  const peerStore=new SemanticBlockStore(peer,activeSchema),carrier=peerStore.contents.get(peerStore.keys()[0])!.get(0) as Y.XmlText
  carrier.insert(carrier.length,' Peer');const update=Y.encodeStateAsUpdate(peer,Y.encodeStateVector(document))
  guard.accept(update);Y.applyUpdate(document,update);assert.equal(store.project().textContent,'Original Peer');peer.destroy()
 }finally{guard.destroy();document.destroy()}
})

test('malformed references, absent definitions, cycles and unknown leaf attrs fail pure reads',()=>{
 const a=replica();a.write(paragraph([container(1)]))
 try{
  for(const value of [{hcdInlineContainer:{version:2,id:id(1)}},{hcdInlineContainer:{version:1,id:id(1)},content:[{type:'text',text:'hidden'}]},{hcdInlineContainer:{version:1,id:id(99)}},{type:'hardBreak',attrs:{future:'must retain'}}]){
   const root=a.document.get('invalid-'+JSON.stringify(value),Y.XmlText);root.insertEmbed(0,value)
   const before=Y.encodeStateAsUpdate(a.document);assert.throws(()=>a.store.read(root));assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)
  }
  a.store.bodies.get(id(1))!.insertEmbed(0,{hcdInlineContainer:{version:1,id:id(1)}})
  const before=Y.encodeStateAsUpdate(a.document);assert.throws(()=>a.read(),/duplicateInlineContainerIdentity/);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)
  assert.equal(a.document.getMap(inlineContainerFields.definitions).size,1)
 }finally{a.document.destroy()}
})

test('recursive depth and body budgets are checked before any allocation or text mutation',()=>{
 const a=replica(),before=Y.encodeStateAsUpdate(a.document)
 try{
  let deep=container(30,[text('Deep')]);for(let n=29;n>0;n--)deep=container(n,[deep])
  for(const proposed of [paragraph([deep]),paragraph([container(1,[text('界'.repeat(350000))])]),paragraph(Array.from({length:1001},()=>schema.nodes.hardBreak.create()))]){
   assert.throws(()=>a.write(proposed),/inlineContainer(Depth|Text|Span)Limit/);assert.deepEqual(Y.encodeStateAsUpdate(a.document),before)
  }
 }finally{a.document.destroy()}
})
