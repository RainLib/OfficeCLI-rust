import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,Node} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions} from './schema.ts'
import {SemanticInlineContainers,inlineContainerNodeName} from './semanticInlineContainers.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {captureSourceLeaf,sourceLeafActions,validateSourceLeaf,type SourceBindingStore,type SourceLeafBinding} from './semanticSourceBindings.ts'

const InlineContainer=Node.create({name:inlineContainerNodeName,inline:true,group:'inline',content:'inline*',marks:'_',isolating:true,defining:true,addAttributes(){return{extension:{default:null}}}})
const schema=getSchema([...schemaExtensions,InlineContainer]),origin=Object.freeze({kind:'inline-source-user'}),receiptOrigin=Object.freeze({kind:'inline-source-receipt'})
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`,source=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const text=(value:string)=>schema.text(value),paragraph=(children:readonly PmNode[]=[])=>schema.nodes.paragraph.createChecked(null,children)
const mark=schema.mark('hcdCustomMark',{value:{schemaVersion:'hcd.mark/1',type:'example.review',version:17,data:{ticket:'T-27'},fallback:{label:'Review',style:{backgroundColor:'#fff2a8'}}}})
function field(number:number,children:PmNode[]=[]){return schema.nodes[inlineContainerNodeName].createChecked({extension:{schemaVersion:'hcd.extension/3',instanceId:id(number),type:'example.inline_field',version:77,display:'inline',contentModel:'inline',data:{project:`P-${number}`},fallback:{text:'Field label'}}},children)}
const mention=()=>schema.nodes.hcdMention.createChecked({reference:{type:'hcd.mention',version:1,mentionId:'m_'+'1'.repeat(32),target:{kind:'person',id:'alice'},snapshot:{label:'Alice 王'}}})
const initial=()=>paragraph([text('P😀'),field(1,[schema.text('Outer',[schema.mark('bold'),mark]),field(2,[text('Inner😀')]),mention(),schema.nodes.hardBreak.create(),text('After')]),field(3),text('Tail')])
function replica(document=new Y.Doc({gc:false})){
 const contents=document.getMap<Y.XmlFragment>('carriers'),containers=new SemanticInlineContainers(document,schema,origin),flow=new SemanticTextFlow(document,contents,schema,origin,containers)
 const store:SourceBindingStore={flow,contents,content:key=>paragraph(flow.read(key).content)}
 return{document,contents,containers,flow,store}
}
function fixture(node=initial()){
 const a=replica(),b=replica(),fragment=new Y.XmlFragment();a.contents.set('root',fragment);fragment.insert(0,[new Y.XmlText()]);a.containers.write(fragment.get(0) as Y.XmlText,Fragment.empty,node);a.flow.initialize(['root']);Y.applyUpdate(b.document,Y.encodeStateAsUpdate(a.document))
 return{a,b,close(){a.document.destroy();b.document.destroy()}}
}
function sourced(node:PmNode){let next=100;const walk=(node:PmNode):PmNode=>{if(node.isLeaf)return node.mark([...node.marks.filter(mark=>mark.type.name!=='hcdSource'),schema.mark('hcdSource',{nodeId:source(++next)})]);return node.copy(Fragment.fromArray(node.content.content.map(walk)))};return walk(node)}
function nodes(node:PmNode){const result:PmNode[]=[];node.descendants(child=>{result.push(child)});return result}
const sourceOf=(node:PmNode)=>node.marks.find(mark=>mark.type.name==='hcdSource')?.attrs.nodeId
function apply(a:ReturnType<typeof replica>,expected:PmNode,captured?:SourceLeafBinding,key='root'){
 const actions=sourceLeafActions(a.store,key,expected,captured)
 a.document.transact(transaction=>{transaction.meta.set('addToHistory',false);actions.forEach(action=>action())},receiptOrigin)
}
function rewrite(node:PmNode,idToChange:number,change:(node:PmNode)=>PmNode):PmNode{return node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id(idToChange)?change(node):node.isLeaf?node:node.copy(Fragment.fromArray(node.content.content.map(child=>rewrite(child,idToChange,change))))}

test('hierarchical source capture retains stored parent offsets and independent nested/empty body ranges',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))
 try{
  assert.equal(captured.version,2);assert.equal(captured.storedSize,'P😀'.length+2+'Tail'.length);assert.equal(captured.size,expected.content.size)
  assert.deepEqual(captured.containers!.map(child=>[child.id,child.offset]),[[id(1),3],[id(3),4]])
  assert.equal(captured.containers![0].binding.version,2);assert.equal(captured.containers![0].binding.containers![0].id,id(2));assert.deepEqual(captured.containers![1].binding.pieces,[])
  assert.doesNotMatch(JSON.stringify(captured),/Outer|Inner|Alice|T-27|project/)
  apply(f.a,expected,captured);assert.deepEqual(f.a.store.content('root').toJSON(),expected.toJSON())
  assert.equal(nodes(f.a.store.content('root')).filter(node=>node.type.name===inlineContainerNodeName).some(node=>node.marks.length),false)
 }finally{f.close()}
})

test('a receipt marks only captured characters after peer insertions inside the body and before the parent reference',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root')),history=f.a.flow.undoManager()
 try{
  // Exact insertion operations establish which Yjs characters are genuinely
  // new, even when a pasted prefix repeats the original first character.
  f.b.document.transact(()=>{f.b.containers.bodies.get(id(1))!.insert(2,'LATE',{});(f.b.contents.get('root')!.get(0) as Y.XmlText).insert(0,'PREFIX',{})},origin)
  Y.applyUpdate(f.a.document,Y.encodeStateAsUpdate(f.b.document));const before=f.a.store.content('root').textContent,count=history.undoStack.length
  apply(f.a,expected,captured)
  assert.equal(f.a.store.content('root').textContent,before);assert.equal(history.undoStack.length,count)
  const leaves=nodes(f.a.store.content('root')).filter(node=>node.isText)
  assert.equal(sourceOf(leaves.find(node=>node.text==='LATE')!),undefined);assert.equal(sourceOf(leaves.find(node=>node.text==='PREFIX')!),undefined)
  const outer=sourceOf(nodes(expected).find(node=>node.text==='Outer')!)
  assert.equal(sourceOf(leaves.find(node=>node.text==='Ou')!),outer);assert.equal(sourceOf(leaves.find(node=>node.text==='ter')!),outer)
  assert.equal(sourceOf(leaves.find(node=>node.text==='Inner😀')!),sourceOf(nodes(expected).find(node=>node.text==='Inner😀')!))
 }finally{history.destroy();f.close()}
})

test('removing an old child and copying visible content to a fresh identity never redirects its source receipt',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))
 try{
  const old=f.a.containers.bodies.get(id(2)),changed=rewrite(f.a.store.content('root'),1,node=>node.copy(Fragment.fromArray(node.content.content.map(child=>child.type.name===inlineContainerNodeName&&child.attrs.extension.instanceId===id(2)?field(4,[text('Inner😀')]):child))))
  f.a.flow.write('root',changed);apply(f.a,expected,captured)
  assert.equal(sourceOf(f.a.containers.readBody(id(4)).firstChild!),undefined)
  assert.equal(sourceOf(f.a.containers.readBody(id(2)).firstChild!),sourceOf(nodes(expected).find(node=>node.text==='Inner😀')!));assert.equal(f.a.containers.bodies.get(id(2)),old)
  assert.equal(sourceOf(nodes(f.a.store.content('root')).find(node=>node.text==='After')!),sourceOf(nodes(expected).find(node=>node.text==='After')!))
 }finally{f.close()}
})

test('an in-flight hierarchical receipt follows parent splits and preserves later child input',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))
 try{
  f.a.flow.split('root',3,'suffix')
  f.b.flow.write('root',rewrite(f.b.store.content('root'),2,node=>node.copy(node.content.append(Fragment.from(text(' PEER'))))))
  Y.applyUpdate(f.a.document,Y.encodeStateAsUpdate(f.b.document));apply(f.a,expected,captured)
  assert.equal(f.a.store.content('root').textContent,'P😀')
  const child=f.a.containers.readBody(id(2));assert.equal(child.textContent,'Inner😀 PEER');assert.equal(sourceOf(child.child(0)),sourceOf(nodes(expected).find(node=>node.text==='Inner😀')!));assert.equal(sourceOf(child.child(1)),undefined)
  assert.equal(sourceOf(nodes(f.a.store.content('suffix')).find(node=>node.text==='Tail')!),sourceOf(nodes(expected).find(node=>node.text==='Tail')!))
 }finally{f.close()}
})

test('a joined-away parent still binds the exact old parent and body carriers independently',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))
 try{
  f.a.flow.split('root',0,'all');f.a.flow.join('all','root');assert.notEqual(f.a.flow.rootFor('root'),'root')
  apply(f.a,expected,captured)
  assert.deepEqual(f.a.store.content('all').content.toJSON(),expected.content.toJSON())
 }finally{f.close()}
})

test('exact child content is recaptured after undo revives items even when an unrelated parent insertion prevents root recapture',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root')),history=f.a.flow.undoManager()
 try{
  f.a.flow.write('root',rewrite(f.a.store.content('root'),2,node=>node.copy(Fragment.from(text('Replaced')))))
  history.undo();f.a.document.transact(()=>(f.a.contents.get('root')!.get(0) as Y.XmlText).insert(0,'PREFIX',{}),origin)
  apply(f.a,expected,captured)
  assert.equal(sourceOf(f.a.containers.readBody(id(2)).firstChild!),sourceOf(nodes(expected).find(node=>node.text==='Inner😀')!))
  assert.equal(sourceOf(f.a.store.content('root').firstChild!),undefined)
 }finally{history.destroy();f.close()}
})

test('JSON captures and a fresh Y.Doc preserve independent claims and do not create a personal undo item',()=>{
 const f=fixture(),fresh=replica(),expected=sourced(f.a.store.content('root')),captured=JSON.parse(JSON.stringify(captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))))
 try{
  Y.applyUpdate(fresh.document,Y.encodeStateAsUpdate(f.a.document));const history=fresh.flow.undoManager()
  apply(fresh,expected,captured);assert.deepEqual(fresh.store.content('root').toJSON(),expected.toJSON());assert.equal(history.undoStack.length,0);history.destroy()
 }finally{fresh.document.destroy();f.close()}
})

test('malformed nested identities, geometry, carrier ranges and future models refuse without changing bytes',()=>{
 const f=fixture(),expected=sourced(f.a.store.content('root')),captured=captureSourceLeaf(f.a.store,'root',f.a.store.content('root'))
 try{
  const mutations:Array<(binding:SourceLeafBinding)=>void>=[v=>{v.version=3 as 2},v=>{v.storedSize!++},v=>{v.containers![0].offset++},v=>{v.containers![0].binding.key=id(99)},v=>{v.containers![0].binding.pieces[0].carrier=id(99)},v=>{v.containers![0].binding.containers![0].id=id(1)},v=>{v.containers![0].binding.pieces[0].offset=99},v=>{v.containers![0].binding.shape='0'.repeat(64)},v=>{v.containers![0].binding.containers![0].binding.size++}]
  for(const mutate of mutations){const bad=structuredClone(captured),before=Y.encodeStateAsUpdate(f.a.document);mutate(bad);assert.throws(()=>apply(f.a,expected,bad));assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)}
 }finally{f.close()}
})

test('flat v1 capture serialization stays unchanged and an unaware source consumer rejects v2',()=>{
 const f=fixture(paragraph([text('Plain😀')]))
 try{
  const oldFlow=new SemanticTextFlow(f.a.document,f.a.contents,schema,origin),old:SourceBindingStore={...f.a.store,flow:oldFlow}
  assert.deepEqual(captureSourceLeaf(f.a.store,'root',f.a.store.content('root')),captureSourceLeaf(old,'root',f.a.store.content('root')))
  assert.deepEqual(Object.keys(captureSourceLeaf(old,'root',f.a.store.content('root'))).sort(),['key','pieces','shape','size'])
  const modern=fixture();try{const captured=captureSourceLeaf(modern.a.store,'root',modern.a.store.content('root')),before=Y.encodeStateAsUpdate(f.a.document);validateSourceLeaf(captured,true);assert.throws(()=>validateSourceLeaf(captured),/Unsupported inline source capture/);assert.throws(()=>sourceLeafActions(old,'root',sourced(f.a.store.content('root')),captured),/Unsupported inline source capture/);assert.deepEqual(Y.encodeStateAsUpdate(f.a.document),before)}finally{modern.close()}
 }finally{f.close()}
})
