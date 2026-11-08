import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Editor,getSchema,type JSONContent} from '@tiptap/core'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import {schemaExtensions,jsonToSnapshot,blockIdentityPlugin} from './schema.ts'
import {rootBlocks,blockTarget,transformBlocks,duplicateBlock,blockActionStates,blockDestinations} from './commands/blocks.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
const schema=getSchema(schemaExtensions)
const p=(text:string,id:string):JSONContent=>({type:'paragraph',attrs:{hcdBlockId:id,hcdSourceId:'n_'+'1'.repeat(32)},content:text?[{type:'text',text,marks:[{type:'hcdSource',attrs:{nodeId:'n_'+'1'.repeat(32)}},{type:'bold'}]}]:[]})
const make=(content:JSONContent[])=>EditorState.create({schema,doc:schema.nodeFromJSON({type:'doc',content})})

test('before/after insertion creates a separate inline container paragraph without changing its reference block',()=>{
 const inlineSchema=getSchema([...schemaExtensions,SemanticInlineContainerNode]),registry=new InlineContainerRegistry([{type:'example.block_insert',version:1,display:'inline',contentModel:'inline',label:'字段',defaultData:{},validate:()=>true,fallback:()=> '字段'}])
 const state=EditorState.create({schema:inlineSchema,doc:inlineSchema.nodeFromJSON({type:'doc',content:[p('保留正文😀','stable')]})})
 for(const intent of ['before','after'] as const){
  const value=registry.create('example.block_insert'),tr=state.tr,selected=blockTarget(state,rootBlocks(state.doc),intent)!
  assert.ok(transformBlocks(tr,'node.insert',{extension:value},selected));tr.doc.check()
  const roots=rootBlocks(tr.doc),inserted=roots[intent==='before'?0:1].node
  assert.ok(roots[intent==='before'?1:0].node.eq(state.doc.firstChild!));assert.equal(inserted.type.name,'paragraph');assert.equal(inserted.childCount,1);assert.equal(inserted.firstChild!.type.name,'hcdExtensionInlineContainer');assert.equal(inserted.firstChild!.attrs.extension.instanceId,value.instanceId);assert.equal(inserted.firstChild!.content.size,0)
 }
 const legacy=make([p('保留','stable')]),tr=legacy.tr
 assert.equal(transformBlocks(tr,'node.insert',{extension:registry.create('example.block_insert')},blockTarget(legacy,rootBlocks(legacy.doc),'after')!),false);assert.ok(tr.doc.eq(legacy.doc))
 const stale=state.apply(state.tr.insertText('同伴',1));assert.equal(transformBlocks(stale.tr,'node.insert',{extension:registry.create('example.block_insert')},blockTarget(state,rootBlocks(state.doc),'after')!),false)
})
function target(state:EditorState,start:number,end=start,intent:'operate'|'before'|'after'='operate'){return blockTarget(state,rootBlocks(state.doc).slice(start,end+1),intent,'a')!}
test('duplicate gives every cloned identity a fresh value and clears sources while retaining text, formatting and typography',()=>{
 const state=make([p('中文😀','canonical')]),node=state.doc.firstChild!;let index=0
 const copy=duplicateBlock(node,()=>`tmp_copy${++index}`)
 assert.equal(copy.attrs.hcdBlockId,'tmp_copy1');assert.equal(copy.attrs.hcdSourceId,null);assert.equal(copy.textContent,'中文😀');assert.ok(copy.firstChild?.marks.some(mark=>mark.type.name==='bold'));assert.ok(!copy.firstChild?.marks.some(mark=>mark.type.name==='hcdSource'))
 const inherited=schema.nodeFromJSON({...p('size','source'),attrs:{hcdBlockId:'source',hcdSourceTypography:{sizePt:18,eastAsia:'宋体'}}})
 const font=duplicateBlock(inherited).firstChild?.marks.find(mark=>mark.type.name==='textTypography')
 assert.equal(font?.attrs.sizePt,18);assert.equal(font?.attrs.explicitSize,true)
})
test('duplicate a selected range inserts one atomic group after it without reusing canonical/source IDs',()=>{
 const state=make([p('A','a'),p('B','b'),p('C','c')]),tr=state.tr
 assert.equal(transformBlocks(tr,'block.duplicate',undefined,target(state,0,1)),true)
 const next=state.apply(tr),nodes=rootBlocks(next.doc)
 assert.deepEqual(nodes.map(block=>block.node.textContent),['A','B','A','B','C'])
 assert.deepEqual(nodes.slice(0,2).map(block=>block.node.attrs.hcdBlockId),['a','b'])
 assert.ok(nodes[2].node.attrs.hcdBlockId.startsWith('tmp_'));assert.notEqual(nodes[2].node.attrs.hcdBlockId,nodes[3].node.attrs.hcdBlockId)
 assert.equal(jsonToSnapshot(next.doc.toJSON()).length,5)
})
test('move a group preserves IDs, text and marks, and provides the same result as a direct destination',()=>{
 const state=make([p('A','a'),p('B','b'),p('C','c'),p('D','d')]),tr=state.tr
 assert.equal(transformBlocks(tr,'block.down',undefined,target(state,0,1)),true)
 assert.deepEqual(rootBlocks(tr.doc).map(block=>block.node.attrs.hcdBlockId),['c','a','b','d'])
 assert.ok(rootBlocks(tr.doc)[1].node.eq(state.doc.firstChild!))
 const direct=state.tr;assert.equal(transformBlocks(direct,'block.move',undefined,{...target(state,0,1),destination:rootBlocks(state.doc)[2].to}),true);assert.ok(direct.doc.eq(tr.doc))
})
test('delete a range preserves other content and deleting the entire document leaves a valid paragraph',()=>{
 const state=make([p('A','a'),p('B','b'),p('C','c')]),tr=state.tr
 assert.equal(transformBlocks(tr,'block.delete',undefined,target(state,1,2)),true);assert.equal(tr.doc.textContent,'A');tr.doc.check()
 const empty=state.tr;assert.equal(transformBlocks(empty,'block.delete',undefined,target(state,0,2)),true);assert.equal(empty.doc.textContent,'');empty.doc.check()
})
test('protected blocks cannot be changed, cloned or crossed and stale fingerprints never edit new content',()=>{
 const opaque:JSONContent={type:'hcdOpaque',attrs:{hcdBlockId:'image',hcdRegion:'body',hcdContent:{kind:'opaque',inlines:[]}}}
 const state=make([p('A','a'),opaque,p('B','b')])
 for(const id of ['block.duplicate','block.delete','block.quote'])assert.equal(transformBlocks(state.tr,id,undefined,target(state,0,2)),false)
 assert.equal(transformBlocks(state.tr,'block.move',undefined,{...target(state,0),destination:state.doc.content.size}),false)
 const changed=state.apply(state.tr.insertText('peer',1));assert.equal(transformBlocks(changed.tr,'block.delete',undefined,target(state,0)),false)
})
for(const id of ['block.paragraph','block.heading','block.bulletList','block.orderedList','block.quote','block.code','block.divider'])test(`before/after ${id} leaves its reference block intact`,()=>{
 const state=make([p('Original','stable')])
 for(const intent of ['before','after'] as const){const tr=state.tr;assert.equal(transformBlocks(tr,id,undefined,target(state,0,0,intent)),true);const roots=rootBlocks(tr.doc);assert.ok(roots[intent==='before'?1:0].node.eq(state.doc.firstChild!));tr.doc.check()}
})
test('bulk type conversion keeps content and canonical identities where the structure retains them',()=>{
 const state=make([p('One','one'),p('Two','two')]),tr=state.tr
 assert.equal(transformBlocks(tr,'block.heading',undefined,target(state,0,1)),true);assert.deepEqual(tr.doc.content.content.map(node=>[node.type.name,node.attrs.hcdBlockId]),[['heading','one'],['heading','two']])
 const list=state.tr;assert.equal(transformBlocks(list,'block.orderedList',undefined,target(state,0,1)),true)
 assert.deepEqual(jsonToSnapshot(list.doc.toJSON()).map(block=>block.blockId),['one','two'])
 const listState=make(list.doc.toJSON().content!);const plain=listState.tr;assert.equal(transformBlocks(plain,'block.paragraph',undefined,target(listState,0)),true);assert.deepEqual(rootBlocks(plain.doc).map(block=>block.node.attrs.hcdBlockId),['one','two'])
})
test('code conversion handles hard breaks and paragraph conversion restores them without invalid code inlines',()=>{
 const state=make([{...p('','id'),content:[{type:'text',text:'first'},{type:'hardBreak'},{type:'text',text:'second'}]}]),tr=state.tr
 assert.equal(transformBlocks(tr,'block.code',undefined,target(state,0)),true);tr.doc.check();const snapshot=jsonToSnapshot(tr.doc.toJSON());assert.equal(snapshot[0].content.kind,'code_block');assert.ok(snapshot[0].content.inlines.every(part=>!part.hardBreak))
 const code=make(tr.doc.toJSON().content!),back=code.tr;assert.equal(transformBlocks(back,'block.paragraph',undefined,target(code,0)),true);assert.equal(back.doc.firstChild?.child(1).type.name,'hardBreak')
})
test('unsupported nested conversion and destructive divider conversion are disabled without partial changes',()=>{
 const state=make([{type:'bulletList',content:[{type:'listItem',content:[p('parent','item'),{type:'bulletList',content:[{type:'listItem',content:[p('child','child')]}]}]}]}])
 assert.equal(blockActionStates(state)['block.heading'].enabled,false);assert.equal(transformBlocks(state.tr,'block.heading',undefined,target(state,0)),false)
 const text=make([p('keep','id')]);assert.equal(transformBlocks(text.tr,'block.divider',undefined,target(text,0)),false)
 const selected=text.apply(text.tr.setSelection(TextSelection.create(text.doc,1,3)));assert.equal(blockActionStates(selected)['block.duplicate'].enabled,true)
})

test('Enter splits preserve the old identity and allocate a new local identity without rewriting peers',()=>{
 const editor=new Editor({element:null,extensions:schemaExtensions,content:{type:'doc',content:[p('AB','original')]}})
 let current=EditorState.create({schema:editor.schema,doc:editor.schema.nodeFromJSON({type:'doc',content:[p('AB','original')]}),plugins:[blockIdentityPlugin()]})
 current=current.apply(current.tr.setSelection(TextSelection.create(current.doc,2)))
 const view={get state(){return current},composing:false,editable:true,dispatch:(tr:EditorState['tr'])=>{current=current.applyTransaction(tr).state},focus:()=>{}}
 Object.defineProperties(editor,{view:{get:()=>view},state:{get:()=>current},isDestroyed:{get:()=>false}})
 assert.equal(editor.commands.splitBlock(),true)
 assert.equal(current.doc.firstChild?.attrs.hcdBlockId,'original')
 assert.match(current.doc.lastChild?.attrs.hcdBlockId,/^tmp_/)
 const second=current.doc.lastChild?.attrs.hcdBlockId
 assert.notEqual(second,'original');assert.equal(current.doc.textContent,'AB')
 assert.equal(editor.commands.splitBlock(),true)
 assert.notEqual(current.doc.lastChild?.attrs.hcdBlockId,second)
})

test('identity repair never creates random competing identities during remote sync',()=>{
 const doc=schema.nodeFromJSON({type:'doc',content:[p('A','same'),p('B','same')]}),state=EditorState.create({schema,doc,plugins:[blockIdentityPlugin()]})
 const remote=state.applyTransaction(state.tr.insertText('peer',1).setMeta(ySyncPluginKey,{isChangeOrigin:true}))
 assert.equal(remote.transactions.length,1)
 assert.deepEqual(rootBlocks(remote.state.doc).map(block=>block.node.attrs.hcdBlockId),['same','same'])
 const local=remote.state.applyTransaction(remote.state.tr.insertText('own',1))
 const ids=rootBlocks(local.state.doc).map(block=>block.node.attrs.hcdBlockId)
 assert.equal(ids[0],'same');assert.notEqual(ids[1],'same');assert.equal(new Set(ids).size,2)
})

test('identity repair following system metadata remains outside user history',()=>{
 const doc=schema.nodeFromJSON({type:'doc',content:[p('A','same'),p('B','same')]}),state=EditorState.create({schema,doc,plugins:[blockIdentityPlugin()]})
 const result=state.applyTransaction(state.tr.setNodeMarkup(0,undefined,{...doc.firstChild!.attrs,hcdSourceId:null}).setMeta('addToHistory',false))
 assert.equal(result.transactions.length,2);assert.equal(result.transactions[1].getMeta('addToHistory'),false)
})

test('move destinations stay within protected barriers for every contiguous selection',()=>{
 const opaque:JSONContent={type:'hcdOpaque',attrs:{hcdBlockId:'image',hcdRegion:'body',hcdContent:{kind:'opaque',inlines:[]}}}
 const state=make([p('A','a'),opaque,p('B','b'),p('C','c'),p('D','d'),opaque,p('E','e')]),roots=rootBlocks(state.doc)
 for(let first=0;first<roots.length;first++)for(let last=first;last<roots.length;last++){
  const selected=target(state,first,last),protectedIndices=[1,5]
  const expected=protectedIndices.some(index=>index>=first&&index<=last)?[]:[0,...roots.map(root=>root.to)].filter(position=>{if(position>=selected.from&&position<=selected.to)return false;return !protectedIndices.some(index=>position<selected.from?roots[index].from>=position&&roots[index].to<=selected.from:roots[index].from>=selected.to&&roots[index].to<=position)})
  assert.deepEqual(blockDestinations(state.doc,selected),expected)
 }

})
