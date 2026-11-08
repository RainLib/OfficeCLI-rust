import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as Y from 'yjs'
import {getSchema,Node} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainers,inlineContainerNodeName} from './semanticInlineContainers.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'

const InlineContainer=Node.create({name:inlineContainerNodeName,inline:true,group:'inline',content:'inline*',marks:'_',isolating:true,defining:true,addAttributes(){return{extension:{default:null}}}})
const schema=getSchema([...schemaExtensions,InlineContainer]),origin=Object.freeze({kind:'inline-flow-fixture'})
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`
const source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const text=(value:string)=>schema.text(value)
const paragraph=(children:PmNode[]=[])=>schema.nodes.paragraph.createChecked(null,children)
function field(number:number,value='',children:PmNode[]=[]){
 const marks=value?[schema.mark('bold'),schema.mark('hcdSource',{nodeId:source(number)}),schema.mark('hcdCustomMark',{value:{schemaVersion:'hcd.mark/1',type:'example.review',version:17,data:{ticket:'T-27'},fallback:{label:'Review',style:{backgroundColor:'#fff2a8'}}}})]:[]
 return schema.nodes[inlineContainerNodeName].createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:id(number),type:'example.inline_field',version:77,display:'inline',contentModel:'inline',data:{project:`P-${number}`},fallback:{text:'Field label'}}},[...(value?[schema.text(value,marks)]:[]),...children])
}
const first=(value='Shared中😀')=>paragraph([text('A'),field(1,value,[field(2)]),text('Z')])
const second=(value='Other')=>paragraph([text('B'),field(3,value),text('C')])
function replica(document=new Y.Doc({gc:false})){
 const carriers=document.getMap<Y.XmlFragment>('carriers'),containers=new SemanticInlineContainers(document,schema,origin),flow=new SemanticTextFlow(document,carriers,schema,origin,containers)
 return{document,carriers,containers,flow}
}
function fixture(){
 const a=replica(),b=replica()
 for(const [key,node]of [['a',first()],['b',second()]] as const){const fragment=new Y.XmlFragment();a.carriers.set(key,fragment);fragment.insert(0,[new Y.XmlText()]);const carrier=fragment.get(0) as Y.XmlText;a.containers.write(carrier,Fragment.empty,node)}
 a.flow.initialize(['a','b']);Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
 return{a,b,close(){a.document.destroy();b.document.destroy()}}
}
function exchange(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}
const visible=(content:Fragment)=>content.textBetween(0,content.size,'\n','\n')
function equal(a:ReturnType<typeof replica>,b:ReturnType<typeof replica>){assert.deepEqual(a.flow.roots().sort().map(key=>[key,a.flow.read(key).toJSON()]),b.flow.roots().sort().map(key=>[key,b.flow.read(key).toJSON()]))}

for(const reverse of [false,true]){
 test(`split before a container routes its nested caret and offline body input without copying, reverse=${reverse}`,()=>{
  const f=fixture(),history=f.a.flow.undoManager()
  try{
   const outer=f.a.containers.bodies.get(id(1)),inner=f.a.containers.bodies.get(id(2)),inside=f.b.flow.capture('a',4,-1),empty=f.b.flow.capture('a',12,-1),after=f.b.flow.capture('a',f.b.flow.read('a').size,-1)
   f.a.flow.split('a',1,'suffix');f.b.flow.write('a',first('Shared中😀 Peer'))
   exchange(f.a.document,f.b.document,reverse)
   assert.equal(visible(f.a.flow.read('a')),'A');assert.equal(visible(f.a.flow.read('suffix')),'Shared中😀 PeerZ')
   assert.deepEqual(f.a.flow.resolve(inside),{root:'suffix',offset:3});assert.deepEqual(f.a.flow.resolve(empty),{root:'suffix',offset:11+' Peer'.length})
   assert.deepEqual(f.a.flow.resolve(after),{root:'suffix',offset:f.a.flow.read('suffix').size});assert.equal(f.a.containers.bodies.get(id(1)),outer);assert.equal(f.a.containers.bodies.get(id(2)),inner);equal(f.a,f.b)
   history.undo();exchange(f.a.document,f.b.document,reverse)
   assert.equal(visible(f.a.flow.read('a')),'AShared中😀 PeerZ');assert.deepEqual(f.a.flow.resolve(inside),{root:'a',offset:4})
   history.redo();exchange(f.a.document,f.b.document,reverse);assert.deepEqual(f.a.flow.resolve(inside),{root:'suffix',offset:3});equal(f.a,f.b)
  }finally{history.destroy();f.close()}
 })
 test(`split after a container uses its one stored embed while retaining expanded PM positions, reverse=${reverse}`,()=>{
  const f=fixture()
  try{
   const boundary=f.a.flow.read('a').size-1,inside=f.b.flow.capture('a',4,-1),tail=f.b.flow.capture('a',boundary+1,-1)
   f.a.flow.split('a',boundary,'tail');f.b.flow.write('a',first('Shared中😀 Peer'))
   exchange(f.a.document,f.b.document,reverse)
   assert.equal(visible(f.a.flow.read('a')),'AShared中😀 Peer');assert.equal(visible(f.a.flow.read('tail')),'Z')
   assert.deepEqual(f.a.flow.resolve(inside),{root:'a',offset:4});assert.deepEqual(f.a.flow.resolve(tail),{root:'tail',offset:1});equal(f.a,f.b)
   f.a.flow.join('a','tail');assert.equal(visible(f.a.flow.read('a')),'AShared中😀 PeerZ')
  }finally{f.close()}
 })
 test(`joining parents preserves offline source-body edits, its own source ID and body caret, reverse=${reverse}`,()=>{
  const f=fixture(),history=f.a.flow.undoManager()
  try{
   const before=f.a.flow.read('a').size,body=f.a.containers.bodies.get(id(3)),inside=f.b.flow.capture('b',4,-1),tail=f.b.flow.capture('b',f.b.flow.read('b').size,-1)
   f.a.flow.join('a','b','\n');f.b.flow.write('b',second('Other Peer'))
   exchange(f.a.document,f.b.document,reverse)
   assert.equal(visible(f.a.flow.read('a')),'AShared中😀Z\nBOther PeerC');assert.deepEqual(f.a.flow.resolve(inside),{root:'a',offset:before+1+4});assert.deepEqual(f.a.flow.resolve(tail),{root:'a',offset:f.a.flow.read('a').size});equal(f.a,f.b)
   assert.equal(f.a.containers.readBody(id(3)).firstChild!.marks.find(mark=>mark.type.name==='hcdSource')!.attrs.nodeId,source(3));assert.equal(f.a.containers.bodies.get(id(3)),body)
   history.undo();exchange(f.a.document,f.b.document,reverse);assert.equal(visible(f.a.flow.read('b')),'BOther PeerC');assert.deepEqual(f.a.flow.resolve(inside),{root:'b',offset:4})
   history.redo();exchange(f.a.document,f.b.document,reverse);assert.deepEqual(f.a.flow.resolve(inside),{root:'a',offset:before+1+4});equal(f.a,f.b)
  }finally{history.destroy();f.close()}
 })
}

test('composite writes change several bodies while own undo retains another peer body edit',()=>{
 const f=fixture()
 f.a.flow.join('a','b');exchange(f.a.document,f.b.document)
 const history=f.a.flow.undoManager()
 try{
  const bodies=[1,2,3].map(n=>f.a.containers.bodies.get(id(n)))
  f.a.flow.write('a',paragraph([...first('Local Shared中😀').content.content,...second().content.content]))
  f.b.flow.write('a',paragraph([...first().content.content,...second('Other Peer').content.content]))
  exchange(f.a.document,f.b.document);assert.equal(visible(f.a.flow.read('a')),'ALocal Shared中😀ZBOther PeerC');equal(f.a,f.b)
  history.undo();exchange(f.a.document,f.b.document);assert.equal(visible(f.a.flow.read('a')),'AShared中😀ZBOther PeerC')
  history.redo();exchange(f.a.document,f.b.document);assert.equal(visible(f.a.flow.read('a')),'ALocal Shared中😀ZBOther PeerC');assert.deepEqual([1,2,3].map(n=>f.a.containers.bodies.get(id(n))),bodies)
 }finally{history.destroy();f.close()}
})

test('every expanded PM position roundtrips across several physical parent carriers and nested empty bodies',()=>{
 const f=fixture()
 try{
  f.a.flow.join('a','b','\n')
  const size=f.a.flow.read('a').size
  for(let offset=0;offset<=size;offset++)for(const assoc of [-1,0,1])assert.deepEqual(f.a.flow.resolve(f.a.flow.capture('a',offset,assoc)),{root:'a',offset},`offset=${offset},assoc=${assoc}`)
  f.a.flow.split('a',first().content.size+1,'b-again')
  for(const root of ['a','b-again'])for(let offset=0;offset<=f.a.flow.read(root).size;offset++)assert.deepEqual(f.a.flow.resolve(f.a.flow.capture(root,offset,-1)),{root,offset})
 }finally{f.close()}
})

test('a body at the beginning of a joined carrier keeps that physical parent in its bookmark',()=>{
 const f=fixture()
 try{
  f.a.flow.write('b',paragraph([field(3,'Other')]))
  const start=f.a.flow.read('a').size;f.a.flow.join('a','b')
  const point=f.a.flow.capture('a',start+1,-1)
  assert.equal(point.carrier,'b');assert.deepEqual(f.a.containers.relativeBody(point.relative),{containerId:id(3),offset:0});assert.deepEqual(f.a.flow.resolve(point),{root:'a',offset:start+1})
 }finally{f.close()}
})

test('internal paragraph splits refuse every interior container boundary without changing bytes',()=>{
 const f=fixture()
 try{
  const before=Y.encodeStateAsUpdate(f.a.document),node=f.a.flow.read('a').child(1)
  for(let offset=2;offset<1+node.nodeSize;offset++){assert.throws(()=>f.a.flow.split('a',offset,'illegal'),/cannotSplitInlineContainer/);assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)}
  assert.throws(()=>f.a.flow.split('a',-1,'illegal'),/invalidInlineContainerPosition/);assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)
 }finally{f.close()}
})

test('relative child resolution uses the supplied active roots and refuses an ambiguous alias',()=>{
 const f=fixture()
 try{
  const point=f.a.flow.capture('a',4,-1)
  assert.equal(f.a.flow.resolve(point,['b']),null)
  // A whole-document projection must forbid this alias. The flow never picks
  // an arbitrary parent when handed two active references to the same body.
  f.a.flow.write('b',paragraph([field(1,'Shared中😀',[field(2)])]))
  assert.throws(()=>f.a.flow.resolve(point),/duplicateInlineContainerIdentity/)
  assert.deepEqual(f.a.flow.resolve(point,['a']),{root:'a',offset:4});assert.deepEqual(f.a.flow.resolve(point,['b']),{root:'b',offset:3})
 }finally{f.close()}
})

test('all leaf storage transformations finish before any parent or existing body is mutated',()=>{
 const f=fixture()
 try{
  const root=f.a.carriers.get('a')!.get(0) as Y.XmlText,mention=schema.nodes.hcdMention.create({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'1'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}}})
  const proposed=paragraph([field(1,'Changed',[field(2)]),field(4,'',[mention])])
  for(const storage of [()=>{throw new Error('codec unavailable')},()=>({type:'hardBreak',attrs:{future:true}}),()=>({type:'hcdMention',attrs:mention.attrs,content:[{type:'text',text:'hidden'}]})]){
   const before=Y.encodeStateAsUpdate(f.a.document)
   assert.throws(()=>f.a.containers.writeText(root,f.a.containers.read(root),proposed,storage));assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)
  }
 }finally{f.close()}
})

test('permanent allocation cannot accidentally inherit a personal outer transaction origin',()=>{
 const f=fixture()
 try{
  const before=Y.encodeStateAsUpdate(f.a.document)
  f.a.document.transact(()=>assert.throws(()=>f.a.flow.write('a',paragraph([field(4,'New')])),/inlineContainerAllocationRequiresPreparation/),origin)
  assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)
  const history=f.a.flow.undoManager()
  f.a.flow.write('a',paragraph([...first().content.content,field(4,'Own')]))
  Y.applyUpdate(f.b.document,Y.encodeStateAsUpdate(f.a.document));const body=f.a.containers.bodies.get(id(4))
  history.undo();assert.equal(f.a.containers.bodies.get(id(4)),body)
  f.b.flow.write('a',paragraph([...first().content.content,field(4,'Own Peer')]))
  exchange(f.a.document,f.b.document);assert.equal(f.a.containers.readBody(id(4)).textContent,' Peer')
  history.redo();exchange(f.a.document,f.b.document);assert.equal(visible(f.a.flow.read('a')),'AShared中😀ZOwn Peer');equal(f.a,f.b);history.destroy()
 }finally{f.close()}
})

test('default flows remain closed to inline bodies, and explicit composition rejects a different owner/schema/origin',()=>{
 const f=fixture(),other=replica()
 try{
  const before=Y.encodeStateAsUpdate(f.a.document)
  const old=new SemanticTextFlow(f.a.document,f.a.carriers,schema,origin)
  assert.throws(()=>old.read('a'),/unsupportedNodeContent/)
  assert.throws(()=>new SemanticTextFlow(f.a.document,f.a.carriers,schema,origin,other.containers),/inlineContainerFlowMismatch/)
  assert.throws(()=>new SemanticTextFlow(f.a.document,other.carriers,schema,origin,f.a.containers),/inlineContainerFlowMismatch/)
  assert.throws(()=>new SemanticTextFlow(f.a.document,f.a.carriers,schema,{},f.a.containers),/inlineContainerFlowMismatch/)
  assert.throws(()=>new SemanticTextFlow(f.a.document,f.a.carriers,getSchema(schemaExtensions),origin,f.a.containers),/inlineContainerFlowMismatch/)
  assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)
 }finally{f.close();other.document.destroy()}
})

test('concurrent cuts on opposite sides of a container retain it once and merge independent body edits',()=>{
 const f=fixture()
 try{
  const point=f.a.flow.capture('a',4,-1),carrier=f.a.containers.bodies.get(id(1))
  f.a.flow.split('a',1,'before-field');f.a.flow.write('before-field',paragraph([field(1,'Local Shared中😀',[field(2)]),text('Z')]))
  f.b.flow.split('a',first().content.size-1,'after-field');f.b.flow.write('a',paragraph([text('A'),field(1,'Shared中😀 Peer',[field(2)])]))
  exchange(f.a.document,f.b.document)
  assert.equal(visible(f.a.flow.read('a')),'A');assert.equal(visible(f.a.flow.read('before-field')),'Local Shared中😀 Peer');assert.equal(visible(f.a.flow.read('after-field')),'Z');equal(f.a,f.b)
  assert.deepEqual(f.a.flow.resolve(point),{root:'before-field',offset:3+'Local '.length});assert.equal(f.a.containers.bodies.get(id(1)),carrier)
 }finally{f.close()}
})

test('three offline replicas retain each body character and identity through shuffled cuts and joins',()=>{
 for(const seed of [1,27,103]){
  const f=fixture(),c=replica(),peers=[f.a,f.b,c],inserted:string[]=[]
  Y.applyUpdate(c.document,Y.encodeStateAsUpdate(f.a.document))
  let state=seed,counter=0;const random=(max:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max}
  const snapshot=(peer:ReturnType<typeof replica>)=>peer.flow.roots().sort().map(root=>[root,peer.flow.read(root).toJSON()])
  try{
   for(let round=0;round<12;round++){
    for(const [index,peer]of peers.entries()){
     const roots=peer.flow.roots(),root=roots[random(roots.length)]
     if(random(3)===0&&roots.length>1){const target=roots.filter(key=>key!==root);peer.flow.join(root,target[random(target.length)]);continue}
     if(random(2)===0){
      const content=peer.flow.read(root),boundaries=[0];content.forEach((node,offset)=>boundaries.push(offset+node.nodeSize))
      peer.flow.split(root,boundaries[random(boundaries.length)],`cut-${seed}-${index}-${++counter}`);continue
     }
     const target=id(random(2)?1:3),character=String.fromCharCode(0xe000+seed*100+inserted.length)
     const owner=roots.find(key=>{let found=false;peer.flow.read(key).forEach(node=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===target)found=true});return found})
     assert.ok(owner)
     const rewrite=(node:PmNode):PmNode=>node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===target?node.copy(node.content.append(Fragment.from(schema.text(character)))):node.isLeaf?node:node.copy(Fragment.fromArray(node.content.content.map(rewrite)))
     peer.flow.write(owner,paragraph(peer.flow.read(owner).content.map(rewrite)));inserted.push(character)
    }
    if(round%3===2){exchange(peers[random(3)].document,peers[random(3)].document,true)}
   }
   // Disseminate every peer state in both orders without replacing documents.
   for(const a of peers)for(const b of [...peers].reverse())exchange(a.document,b.document,true)
   for(const peer of peers){
    assert.deepEqual(snapshot(peer),snapshot(f.a))
    const values=peer.flow.roots().map(key=>peer.flow.read(key)),body=values.map(visible).join(''),counts=new Map<string,number>()
    values.forEach(content=>content.forEach(node=>{const collect=(node:PmNode)=>{if(node.type.name===inlineContainerNodeName)counts.set(node.attrs.extension.instanceId,(counts.get(node.attrs.extension.instanceId)??0)+1);node.forEach(collect)};collect(node)}))
    for(const value of inserted)assert.equal(body.split(value).length-1,1,`seed=${seed},character=${value.codePointAt(0)}`)
    for(const number of [1,2,3])assert.equal(counts.get(id(number)),1)
    assert.equal(peer.containers.readBody(id(1)).firstChild!.marks.find(mark=>mark.type.name==='hcdSource')!.attrs.nodeId,source(1))
   }
  }finally{f.close();c.document.destroy()}
 }
})

test('an actual binary snapshot reloads composite roots and body bookmarks after all original documents are destroyed',()=>{
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'hcd-inline-flow-'));let closed=false,fresh:ReturnType<typeof replica>|undefined
 try{
  const point=f.a.flow.capture('b',4,-1)
  f.a.flow.split('a',1,'suffix');f.a.flow.join('suffix','b','\n');f.b.flow.write('b',second('Other Peer'));exchange(f.a.document,f.b.document)
  const expected=f.a.flow.roots().sort().map(root=>[root,f.a.flow.read(root).toJSON()]),resolved=f.a.flow.resolve(point)
  assert.ok(resolved)
  writeFileSync(join(directory,'state.yjs'),Y.encodeStateAsUpdate(f.a.document));writeFileSync(join(directory,'bookmark.json'),JSON.stringify(point))
  f.close();closed=true
  fresh=replica();Y.applyUpdate(fresh.document,readFileSync(join(directory,'state.yjs')))
  assert.deepEqual(fresh.flow.roots().sort().map(root=>[root,fresh!.flow.read(root).toJSON()]),expected)
  assert.deepEqual(fresh.flow.resolve(JSON.parse(readFileSync(join(directory,'bookmark.json'),'utf8'))),resolved)
  const body=fresh.containers.bodies.get(id(3)),rewrite=(node:PmNode):PmNode=>node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(3)?field(3,'Other Peer Continued'):node.isLeaf?node:node.copy(Fragment.fromArray(node.content.content.map(rewrite)))
  fresh.flow.write(resolved.root,paragraph(fresh.flow.read(resolved.root).content.map(rewrite)))
  assert.equal(fresh.containers.readBody(id(3)).textContent,'Other Peer Continued');assert.equal(fresh.containers.bodies.get(id(3)),body)
  assert.equal(fresh.containers.readBody(id(3)).firstChild!.marks.find(mark=>mark.type.name==='hcdSource')!.attrs.nodeId,source(3))
 }finally{if(!closed)f.close();fresh?.document.destroy();rmSync(directory,{recursive:true,force:true})}
})
