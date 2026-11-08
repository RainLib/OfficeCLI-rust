import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {EditorState,TextSelection,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {schemaExtensions,sourceIdentityPlugin} from './schema.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from './semanticBlockStore.ts'
import {semanticStructureBinding,structureTextEdits} from './semanticStructureBinding.ts'
import {inlineContainerNodeName} from './semanticInlineContainers.ts'

const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`
const text=(value:string)=>schema.text(value)
const p=(children:PmNode[])=>schema.nodes.paragraph.createChecked(null,children)
function field(n:number,children:PmNode[]=[]){return schema.nodes[inlineContainerNodeName].createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'Field'}}},children)}
function store(document:Y.Doc){return new SemanticBlockStore(document,schema,semanticBlockOrigin,{inlineContainers:true})}
function engine(document:Y.Doc,editable=true){
 const structure=store(document),errors:unknown[]=[],plugin=semanticStructureBinding(structure,{canWrite:()=>editable,onError:cause=>errors.push(cause)})
 let state=EditorState.create({schema,plugins:[sourceIdentityPlugin(),plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}}
 binding=plugin.spec.view!(view as unknown as EditorView)
 return{store:structure,errors,get:()=>state,dispatch:view.dispatch,setEditable:(next:boolean)=>{editable=next},close:()=>binding.destroy?.()}
}
function bodyStart(doc:PmNode,n:number){let found:number|undefined;doc.descendants((node,pos)=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(n))found=pos+1});assert.notEqual(found,undefined);return found!}
function body(doc:PmNode,n:number){return doc.nodeAt(bodyStart(doc,n)-1)!}
function visible(raw:Y.XmlText){const values:string[]=[];for(let item=raw._start;item;item=item.right)if(!item.deleted&&item.countable)for(let n=0;n<item.length;n++)values.push(`${item.id.client}:${item.id.clock+n}`);return values}
function exchange(a:Y.Doc,b:Y.Doc,reverse=false){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);if(reverse){Y.applyUpdate(b,au);Y.applyUpdate(a,bu)}else{Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}}
async function pair(nodes=[p([text('A'),field(1,[text('AAA😀AAA'),field(2,[text('Nested')])]),text('Z')])],reverse=false){
 const a=new Y.Doc({gc:false}),b=new Y.Doc({gc:false});a.clientID=reverse?2:1;b.clientID=reverse?1:2
 store(a).initialize(schema.nodes.doc.createChecked(null,nodes));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 const ea=engine(a),eb=engine(b);await Promise.resolve()
 return{a,b,ea,eb,close(){ea.close();eb.close();a.destroy();b.destroy()}}
}

test('PM extraction uses independent parent/body coordinates after nested bodies grow',async()=>{
 const f=await pair();try{
  let tr=f.ea.get().tr
  tr.insertText('++',bodyStart(tr.doc,2));tr.insertText('AA',bodyStart(tr.doc,1));tr.insertText('!',tr.doc.firstChild!.nodeSize-1)
  assert.deepEqual(structureTextEdits([tr]),[])
  const batches=structureTextEdits([tr],true),key=f.ea.store.keys()[0]
  assert.deepEqual(batches.map(({key,containerId,edits})=>({key,containerId,ranges:edits.map(e=>[e.from,e.to,e.insert.textBetween(0,e.insert.size)])})),[
   {key,containerId:id(2),ranges:[[0,0,'++']]},{key,containerId:id(1),ranges:[[0,0,'AA']]},{key,containerId:undefined,ranges:[[3,3,'!']]},
  ])
  f.ea.dispatch(tr);assert.deepEqual(f.ea.errors,[]);assert.equal(f.ea.get().doc.textContent,'AAAAAA😀AAA++NestedZ!')
 }finally{f.close()}
})

for(const reverse of [false,true])test(`real structure binding preserves repeated body characters, caret and peer input, reverse=${reverse}`,async()=>{
 const f=await pair([p([text('A'),field(1,[text('AAA😀AAA')]),text('Z')])],reverse),history=f.ea.store.undoManager(false)
 try{
  const raw=f.ea.store.flow.containers!.bodies.get(id(1))!,original=visible(raw),point=f.eb.store.flow.capture(f.eb.store.keys()[0],2,1)
  const start=bodyStart(f.ea.get().doc,1);f.ea.dispatch(f.ea.get().tr.insertText('AA',start).insertText('AA',start+10))
  assert.deepEqual(visible(raw).slice(2,-2),original)
  const peerStart=bodyStart(f.eb.get().doc,1);f.eb.dispatch(f.eb.get().tr.insertText(' Peer',peerStart+8));exchange(f.a,f.b,reverse)
  assert.deepEqual(f.ea.errors,[]);assert.deepEqual(f.eb.errors,[]);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.equal(f.ea.store.flow.resolve(point)?.offset,4)
  const merged=body(f.ea.get().doc,1).textContent;assert.ok(['AAAAA😀AAAAA Peer','AAAAA😀AAA PeerAA'].includes(merged))
  history.undo();exchange(f.a,f.b,reverse);assert.equal(body(f.ea.get().doc,1).textContent,'AAA😀AAA Peer')
  history.redo();exchange(f.a,f.b,reverse);assert.equal(body(f.ea.get().doc,1).textContent,merged)
  assert.deepEqual(visible(raw).filter(value=>original.includes(value)),original)
 }finally{history.destroy();f.close()}
})

test('identical visible body after delete/reinsert retains untouched suffix identities',async()=>{
 const f=await pair([p([field(1,[text('AAAA')])])]);try{
  const raw=f.ea.store.flow.containers!.bodies.get(id(1))!,original=visible(raw),start=bodyStart(f.ea.get().doc,1)
  f.ea.dispatch(f.ea.get().tr.delete(start,start+1).insertText('A',start))
  assert.equal(body(f.ea.get().doc,1).textContent,'AAAA');assert.deepEqual(visible(raw).slice(1),original.slice(1));assert.notEqual(visible(raw)[0],original[0]);assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})

test('remote selection inside a nested body follows original characters across parent and child input',async()=>{
 const f=await pair();try{
  const start=bodyStart(f.eb.get().doc,2)
  f.eb.dispatch(f.eb.get().tr.setSelection(TextSelection.create(f.eb.get().doc,start+2)))
  let tr=f.ea.get().tr.insertText('++',bodyStart(f.ea.get().doc,1));tr.insertText('++',bodyStart(tr.doc,2));tr.insertText('Before ',1)
  f.ea.dispatch(tr);exchange(f.a,f.b)
  assert.equal(f.eb.get().selection.head,bodyStart(f.eb.get().doc,2)+4);assert.ok(f.ea.get().doc.eq(f.eb.get().doc));assert.deepEqual(f.eb.errors,[])
 }finally{f.close()}
})

test('composition-style nested replacements preserve original suffix and one personal history action',async()=>{
 const f=await pair([p([field(1,[field(2,[text('P😀')])])])]),history=f.ea.store.undoManager(false)
 try{
  const raw=f.ea.store.flow.containers!.bodies.get(id(2))!,original=visible(raw),start=bodyStart(f.ea.get().doc,2)
  f.ea.dispatch(f.ea.get().tr.insertText('n',start).insertText('ni',start,start+1).insertText('你😀',start,start+2))
  assert.equal(body(f.ea.get().doc,2).textContent,'你😀P😀');assert.deepEqual(visible(raw).slice(3),original);assert.equal(history.undoStack.length,1)
  history.undo();assert.equal(body(f.ea.get().doc,2).textContent,'P😀');history.redo();assert.equal(body(f.ea.get().doc,2).textContent,'你😀P😀');assert.deepEqual(f.ea.errors,[])
 }finally{history.destroy();f.close()}
})

test('one transaction updates independent roots and internal empty bodies without confusing their positions',async()=>{
 const f=await pair([p([text('Top')]),p([field(1),text('Tail')])]);try{
  let tr=f.ea.get().tr.insertText('++',1);tr.insertText('你😀',bodyStart(tr.doc,1));tr.insertText('!',tr.doc.content.size-1)
  f.ea.dispatch(tr);assert.equal(f.ea.get().doc.textContent,'++Top你😀Tail!');assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})

test('late invalid scope or unhinted body text refuses before any carrier changes',async()=>{
 const f=await pair();try{
  const before=f.ea.store.blocks(),key=before[0].key,node=before[0].node,next=node.copy(Fragment.fromArray([text('AA'),...Array.from({length:node.childCount},(_,i)=>node.child(i))])),bytes=Y.encodeStateAsUpdate(f.a)
  for(const containerId of [id(99),id(2)])assert.throws(()=>f.ea.store.reconcile(before,[{key,node:next}],{textEdits:[{key,edits:[{from:0,to:0,insert:Fragment.from(text('AA'))}]},{key,containerId,edits:[{from:100,to:100,insert:Fragment.from(text('bad'))}]}]}))
  assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
  const tr=f.ea.get().tr.insertText('Changed',bodyStart(f.ea.get().doc,2)),proposal=[{key,node:tr.doc.firstChild!}]
  assert.throws(()=>f.ea.store.reconcile(before,proposal,{textEdits:[{key,containerId:id(1),edits:[]}]}),/staleSemanticTextEdits/);assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
 }finally{f.close()}
})

test('read-only binding refuses internal input and a writable wrapper deletion retains the body',async()=>{
 const f=await pair();try{
  f.ea.setEditable(false);const bytes=Y.encodeStateAsUpdate(f.a),before=f.ea.get().doc
  f.ea.dispatch(f.ea.get().tr.insertText('Denied',bodyStart(before,2)));assert.ok(f.ea.get().doc.eq(before));assert.deepEqual(Y.encodeStateAsUpdate(f.a),bytes)
  f.ea.setEditable(true);const start=bodyStart(before,1)-1;f.ea.dispatch(f.ea.get().tr.delete(start,start+body(before,1).nodeSize));assert.equal(f.ea.get().doc.textContent,'AZ');assert.equal(f.ea.store.flow.containers!.readBody(id(1)).textContent,'AAA😀AAANested');assert.deepEqual(f.ea.errors,[]);assert.equal(f.a.getMap('hcd-semantic-inline-deletions/1').size,1)
 }finally{f.close()}
})

test('source identity repair and formatting in the same text batch do not replace original characters',async()=>{
 const f=await pair([p([field(1,[text('Original')])])]);try{
  const raw=f.ea.store.flow.containers!.bodies.get(id(1))!,original=visible(raw),start=bodyStart(f.ea.get().doc,1)
  f.ea.dispatch(f.ea.get().tr.insertText('New ',start).addMark(start,start+4,schema.marks.bold.create()))
  assert.equal(body(f.ea.get().doc,1).textContent,'New Original');assert.deepEqual(visible(raw).slice(4),original);assert.equal(body(f.ea.get().doc,1).firstChild!.marks.some(mark=>mark.type.name==='bold'),true);assert.deepEqual(f.ea.errors,[])
 }finally{f.close()}
})

test('a new Doc loaded from encoded state keeps the same permanent bodies and exact edits',async()=>{
 const f=await pair(),document=new Y.Doc({gc:false});try{
  Y.applyUpdate(document,Y.encodeStateAsUpdate(f.a));const next=engine(document);try{await Promise.resolve();const raw=next.store.flow.containers!.bodies.get(id(2))!,original=visible(raw),start=bodyStart(next.get().doc,2);next.dispatch(next.get().tr.insertText('++',start));assert.equal(body(next.get().doc,2).textContent,'++Nested');assert.deepEqual(visible(raw).slice(2),original);assert.deepEqual(next.errors,[])}finally{next.close()}
 }finally{document.destroy();f.close()}
})
