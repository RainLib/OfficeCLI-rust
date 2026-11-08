import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {requireWordRoomClient} from './wordRoomClient.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField,type WordRegionProjection} from './wordRegionStore.ts'
import {wordLayoutProtocol,wordRegionalProtocol,structuralProtocol,parseCollaborationRoom,wordLayoutCollaborationUrl} from './collaborationProtocol.ts'
import {semanticBlockFields} from './semanticBlockStore.ts'
import {imageReceiptMap,CollaborativeImageDraftStore} from './collaborativeImages.ts'
import type {CollaborationAccess} from './collaborationAccess.ts'

const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash='a'.repeat(64),schema=wordRegionSchema()
const room=parseCollaborationRoom('layout:4:wordregions2:save6',{wordLayoutV2:true})
const authority:CollaborationAccess={scope:'write',expiresAt:2_000_000_000,collaborationEpoch:4,collaborationProtocol:wordLayoutProtocol,coordinatedRestore:true,userId:'alice'}
const parameters=()=>new URL(wordLayoutCollaborationUrl('ws://localhost')).searchParams
function fixture(){
 const projection:WordRegionProjection={documentId:'layout',revision:3,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:11906,heightTwips:16838},headers:{default:id(2)},footers:{default:id(3)}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'},{id:id(3),kind:'footer',sourcePart:'word/footer1.xml'}]},blocks:[1,2,3].map(n=>({flowRegionId:id(n),region:n===1?'body':n===2?'header':'footer',readOnly:false,blockId:id(10+n),blockHash:hash,content:{kind:'paragraph',inlines:[{nodeId:id(20+n),text:`Region ${n}`}]}}))}
 const document=new Y.Doc(),model=new WordRegionStore(document,schema,'layout',projection.flowLayout,hash);model.initialize(projection)
 return{document,model,projection}
}
function clone(f:ReturnType<typeof fixture>){const document=new Y.Doc();Y.applyUpdate(document,Y.encodeStateAsUpdate(f.document));const layout=f.model.layoutState();return{document,model:new WordRegionStore(document,schema,'layout',layout.layout,layout.layoutHash)}}
function edit(model:WordRegionStore,region:number,text:string){const before=model.region(id(region)),block=before[0];model.reconcile(id(region),before,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text(text,block.node.firstChild?.marks))}])}
const guardFor=(f:ReturnType<typeof fixture>)=>wordRoomGuard(f.model,()=>id(2),undefined,wordLayoutProtocol)

test('layout room admission requires exact authenticated protocol, epoch and explicit client models',()=>{
 assert.equal(requireWordRoomClient(room,authority,parameters(),true),wordLayoutProtocol)
 assert.equal(requireWordRoomClient(room,{...authority,scope:'read'},parameters(),true),wordLayoutProtocol)
 for(const change of [{collaborationEpoch:5},{collaborationProtocol:wordRegionalProtocol},{collaborationProtocol:structuralProtocol}])assert.throws(()=>requireWordRoomClient(room,{...authority,...change},parameters(),true),/authority-mismatch/)
 for(const enabled of [true,false])assert.throws(()=>requireWordRoomClient(room,{...authority,coordinatedRestore:false},parameters(),enabled),/disabled/)
 assert.throws(()=>requireWordRoomClient(room,authority,parameters(),false),/disabled/)
 assert.throws(()=>requireWordRoomClient({...room,fixed:true},authority,parameters(),true),/authority-mismatch/)
 for(const name of ['hcdWordRegions','hcdWordLayout','hcdNodeEdits']){
  const absent=parameters();absent.delete(name);assert.throws(()=>requireWordRoomClient(room,authority,absent,true),/upgrade-required/)
  const older=parameters();older.set(name,'0');assert.throws(()=>requireWordRoomClient(room,authority,older,true),/upgrade-required/)
  const duplicate=parameters();duplicate.append(name,duplicate.get(name)!);assert.throws(()=>requireWordRoomClient(room,authority,duplicate,true),/upgrade-required/)
 }
})

test('layout acknowledgement cannot be used to join or silently upgrade a legacy regional room',()=>{
 const legacy=parseCollaborationRoom('layout:4:wordregions1:save5'),access={...authority,collaborationProtocol:wordRegionalProtocol}
 assert.throws(()=>requireWordRoomClient(legacy,access,parameters(),true),/upgrade-required/)
 const old=new URLSearchParams({hcdNodeEdits:'7',hcdWordRegions:'1'})
 assert.equal(requireWordRoomClient(legacy,access,old,true),wordRegionalProtocol)
 old.set('hcdWordLayout','1');assert.throws(()=>requireWordRoomClient(legacy,access,old,true),/upgrade-required/)
 assert.throws(()=>parseCollaborationRoom('layout:4:wordregions2:save6'))
})

test('layout-aware packets admit body, header and footer edits without changing paper or story topology',()=>{
 const f=fixture(),peer=clone(f),guard=guardFor(f)
 try{
  const layout=f.model.layoutState()
  for(const region of [1,2,3])edit(peer.model,region,`Peer edited ${region}`)
  const update=Y.encodeStateAsUpdate(peer.document);guard.accept(update);Y.applyUpdate(f.document,update)
  for(const region of [1,2,3])assert.equal(f.model.project(id(region)).textContent,`Peer edited ${region}`)
  assert.deepEqual(f.model.layoutState(),layout)
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})

test('layout packets preserve supported custom text marks and reject the older aggregate encoding',()=>{
 const f=fixture(),peer=clone(f),guard=guardFor(f)
 try{
  const value={schemaVersion:'hcd.mark/1',type:'example.review',version:1,data:{},fallback:{label:'Review',style:{bold:true}}}
  const before=peer.model.region(id(1)),block=before[0],marks=[...(block.node.firstChild?.marks??[]),schema.marks.hcdCustomMark.create({value})]
  peer.model.reconcile(id(1),before,[{key:block.key,node:block.node.type.createChecked(block.node.attrs,schema.text('Marked body',marks))}])
  const update=Y.encodeStateAsUpdate(peer.document);guard.accept(update);Y.applyUpdate(f.document,update)
  assert.equal(f.model.project(id(1)).firstChild!.firstChild!.marks.find(mark=>mark.type.name==='hcdCustomMark')!.attrs.value.type,'example.review')
  const bad=clone(f);try{const text=bad.model.structure.contents.get(bad.model.region(id(1))[0].key)!.get(0) as Y.XmlText;text.format(0,1,{hcdCustomMark:value});assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(bad.document)),/unsupportedCustomMarkEncoding/)}finally{bad.document.destroy()}
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})

for(const field of [wordRegionStoreField,'hcdSchema',semanticBlockFields.metadata,imageReceiptMap])test(`layout packets cannot mutate coordinator-owned metadata: ${field}`,()=>{
 const f=fixture(),peer=clone(f),guard=guardFor(f)
 try{
  const before=Y.encodeStateAsUpdate(f.document)
  peer.document.getMap(field).set(field===wordRegionStoreField?'layoutHash':'forged','b'.repeat(64))
  assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer.document)),/protected-metadata|protocol-mismatch/)
  assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
  const valid=clone(f);try{edit(valid.model,3,'Valid footer after rejection');const update=Y.encodeStateAsUpdate(valid.document);guard.accept(update);Y.applyUpdate(f.document,update);assert.equal(f.model.project(id(3)).textContent,'Valid footer after rejection')}finally{valid.document.destroy()}
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})

for(const mode of ['default','move','source','canonical','image','unknown','incomplete'])test(`layout packet fence rejects ${mode} without modifying the authoritative document`,()=>{
 const f=fixture(),peer=clone(f),guard=guardFor(f)
 try{
  let update:Uint8Array
  if(mode==='default')peer.document.getXmlFragment('default').insert(0,[new Y.XmlElement('paragraph')])
  if(mode==='move'){const all=peer.model.structure.blocks(),body=peer.model.region(id(1))[0];peer.model.structure.reconcile(all,[...all.filter(block=>block.key!==body.key),body])}
  if(mode==='source'){const block=peer.model.region(id(3))[0],text=peer.model.structure.contents.get(block.key)!.get(0) as Y.XmlText;text.format(0,1,{hcdSource:{nodeId:id(21)}})}
  if(mode==='canonical')peer.document.getMap(semanticBlockFields.canonical).set(peer.model.region(id(1))[0].node.attrs.hcdCanonicalKey,id(999))
  if(mode==='image')new CollaborativeImageDraftStore(peer.document).edit({nodeId:id(900),visualHash:hash,geometry:{unit:'pt',x:0,y:0,width:100,height:50}},3,{unit:'pt',x:0,y:0,width:120,height:50})
  if(mode==='unknown')peer.document.getMap('unrecognized-layout-data').set('value',1)
  if(mode==='incomplete'){const detached=new Y.Doc();try{detached.getText('later').insert(0,'First');const vector=Y.encodeStateVector(detached);detached.getText('later').insert(0,'Second');update=Y.encodeStateAsUpdate(detached,vector)}finally{detached.destroy()}}
  else update=Y.encodeStateAsUpdate(peer.document)
  const before=Y.encodeStateAsUpdate(f.document)
  const rejecting=mode==='image'?wordRoomGuard(f.model,()=>undefined,undefined,wordLayoutProtocol):guard
  try{assert.throws(()=>rejecting.accept(update!));assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)}finally{if(rejecting!==guard)rejecting.destroy()}
 }finally{guard.destroy();peer.document.destroy();f.document.destroy()}
})
