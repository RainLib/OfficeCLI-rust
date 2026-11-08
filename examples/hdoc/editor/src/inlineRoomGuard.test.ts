import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {inlineContainerFields,inlineContainerNodeName} from './semanticInlineContainers.ts'
import {inlineRoomGuard} from './inlineRoomGuard.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {Fragment} from '@tiptap/pm/model'
import {materializeInlineContainerEdits} from './inlineContainerEdits.ts'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
import {inlineProtocol,structuralProtocol,legacyProtocol} from './collaborationProtocol.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const id='x_'+ '1'.repeat(32)
const field=(value='Original')=>schema.nodes[inlineContainerNodeName].createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:id,type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Field'}}},schema.text(value))
function store(doc:Y.Doc){return new SemanticBlockStore(doc,schema,undefined,{inlineContainers:true})}
function fixture(){
 const document=new Y.Doc({gc:false}),structure=store(document)
 structure.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,[schema.text('Before '),field(),schema.text(' After')])))
 document.getMap('hcdSchema').set('inlineContainers',1)
 const guard=inlineRoomGuard(document,schema)
 return{document,structure,guard,peer(){const peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));return peer},accept(peer:Y.Doc){const update=Y.encodeStateAsUpdate(peer,Y.encodeStateVector(document));guard.accept(update);Y.applyUpdate(document,update)},close(){guard.destroy();document.destroy()}}
}
test('inline room accepts independent body edits, peer input, personal undo and coordinator receipts',()=>{
 const f=fixture(),a=f.peer(),b=f.peer(),as=store(a),bs=store(b),history=as.undoManager(false)
 try{
  const body=as.flow.containers!.bodies.get(id)!
  a.transact(()=>body.insert(0,'Alice '),as.origin)
  bs.flow.containers!.bodies.get(id)!.insert(8,' Bob')
  f.accept(a);f.accept(b);Y.applyUpdate(a,Y.encodeStateAsUpdate(f.document));Y.applyUpdate(b,Y.encodeStateAsUpdate(f.document))
  assert.equal(f.structure.project().textContent,'Before Alice Original Bob After')
  history.undo();f.accept(a);assert.equal(f.structure.project().textContent,'Before Original Bob After')
  history.redo();f.accept(a);assert.equal(f.structure.project().textContent,'Before Alice Original Bob After')
  // Trusted saves mirror into the shadow and become the next immutable base.
  f.document.getMap('hcdSave').set('revision',9)
  Y.applyUpdate(b,Y.encodeStateAsUpdate(f.document));bs.flow.containers!.bodies.get(id)!.insert(0,'!');f.accept(b)
  assert.equal(f.document.getMap('hcdSave').get('revision'),9)
 }finally{history.destroy();a.destroy();b.destroy();f.close()}
})
const attacks:Array<[string,(doc:Y.Doc)=>void,RegExp]>=[
 ['definition',doc=>{const map=doc.getMap<any>(inlineContainerFields.definitions),value=map.get(id);map.set(id,{...value,node:{...value.node,attrs:{...value.node.attrs,extension:{...value.node.attrs.extension,data:{forged:true}}}}})},/definition-replaced/],
 ['body identity',doc=>{const next=new Y.XmlText();next.insert(0,'Replacement');doc.getMap(inlineContainerFields.bodies).set(id,next)},/body-replaced/],
 ['body type',doc=>doc.getMap(inlineContainerFields.bodies).set(id,'forged'),/body-replaced/],
 ['body source',doc=>store(doc).flow.containers!.bodies.get(id)!.setAttribute('hcdSourceId','n_'+'a'.repeat(32)),/body-replaced/],
 ['save receipt',doc=>doc.getMap('hcdSave').set('revision',999),/protected-metadata/],
 ['schema',doc=>doc.getMap('hcdSchema').set('inlineContainers',2),/model-required|protected-metadata/],
 ['foreign map',doc=>doc.getMap('unrecognized').set('hidden','payload'),/unknown-data/],
 ['default fragment',doc=>doc.getXmlFragment('default').insert(0,[new Y.XmlElement('paragraph')]),/protocol-mismatch/],
 ['unsupported hidden body',doc=>store(doc).flow.containers!.bodies.get(id)!.insertEmbed(0,{hcdInlineContainer:{version:1,id:'x_'+'2'.repeat(32)}}),/missingInlineContainer/],
]
for(const[name,attack,error]of attacks)test(`inline room refuses ${name} before changing authoritative state, then still accepts valid input`,()=>{
 const f=fixture(),bad=f.peer(),good=f.peer(),before=Y.encodeStateAsUpdate(f.document)
 try{attack(bad);assert.throws(()=>f.accept(bad),error);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);store(good).flow.containers!.bodies.get(id)!.insert(0,'Valid ');f.accept(good);assert.equal(f.structure.project().textContent,'Before Valid Original After')}
 finally{bad.destroy();good.destroy();f.close()}
})
test('inline bodies cannot join structural/default rooms or a room without explicit model metadata',()=>{
 const f=fixture()
 try{for(const protocol of [structuralProtocol,legacyProtocol])assert.throws(()=>new RoomProtocolGuard(f.document,protocol),/model-unsupported/);const peer=f.peer();try{peer.getMap('hcdSchema').delete('inlineContainers');assert.throws(()=>new RoomProtocolGuard(peer,inlineProtocol),/model-required/)}finally{peer.destroy()}}
 finally{f.close()}
})
test('allocation, property materialization, deletion and personal undo retain permanent inline bodies',()=>{
 const f=fixture(),peer=f.peer(),ps=store(peer),history=ps.undoManager(false)
 try{
  const key=ps.keys()[0],before=ps.content(key),original=field(),copy=schema.nodes[inlineContainerNodeName].createChecked({...original.attrs,extension:{...original.attrs.extension,instanceId:'x_'+'2'.repeat(32)}},schema.text('New body'))
  ps.update(key,before,before.copy(before.content.append(Fragment.from(copy))));f.accept(peer)
  assert.equal(f.structure.flow.containers!.bodies.size,2);assert.ok(f.structure.project().textContent.endsWith('New body'))
  history.stopCapturing()
  const current=ps.content(key),children=current.content.content.map(node=>node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id?node.type.createChecked({...node.attrs,extension:{...node.attrs.extension,data:{title:'Updated'},fallback:{text:'Updated'}}},node.content):node)
  ps.update(key,current,current.copy(Fragment.fromArray(children)))
  materializeInlineContainerEdits(peer,{resolve:()=>true,update:(base,data)=>readInlineContainerPayload({...base,data,fallback:{text:String(data.title)}})})
  f.accept(peer);assert.equal(f.structure.flow.containers!.readBody(id).attrs.extension.data.title,'Updated')
  history.stopCapturing();ps.remove([key]);f.accept(peer);assert.equal(f.structure.visibility.get(key),false);assert.equal(f.structure.project().textContent,'');assert.equal(f.structure.flow.containers!.bodies.size,2)
  history.undo();f.accept(peer);assert.equal(f.structure.keys().length,1);assert.ok(f.structure.project().textContent.includes('New body'))
  history.redo();f.accept(peer);assert.equal(f.structure.visibility.get(key),false);assert.equal(f.structure.project().textContent,'')
  const hidden=ps.flow.containers!.bodies.get(id)!;hidden.insertEmbed(0,{hcdInlineContainer:{version:1,id:'x_'+'f'.repeat(32)}})
  assert.throws(()=>f.accept(peer),/missingInlineContainer/)
 }finally{history.destroy();peer.destroy();f.close()}
})
