import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Editor,getSchema,type JSONContent} from '@tiptap/core'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import {schemaExtensions,sourceIdentityPlugin,jsonToSnapshot,projectionToJson} from './schema.ts'
import {findSlash,slashKey,slashPlugin} from './commands/slash.ts'
import {prepareSlashTransaction} from './commands/slashTransaction.ts'
import type {SlashTarget} from './commands/insertion.ts'
import {initialEnabledIndex,moveEnabledIndex} from './commands/menuNavigation.ts'
import {SemanticInlineContainerNode} from './semanticInlineNode.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
const schema=getSchema(schemaExtensions)
const paragraph=(text:string,attrs?:Record<string,unknown>):JSONContent=>({type:'paragraph',attrs,content:text?[{type:'text',text}]:[]})
function state(content:JSONContent[],at?:number,ownSchema=schema){const doc=ownSchema.nodeFromJSON({type:'doc',content});return EditorState.create({schema:ownSchema,doc,selection:TextSelection.create(doc,at??doc.content.size-1),plugins:[sourceIdentityPlugin(),slashPlugin()]})}
function engine(content:JSONContent[],inline=false){
 const editor=new Editor({element:null,extensions:[...schemaExtensions,...(inline?[SemanticInlineContainerNode]:[])],content:{type:'doc',content}})
 let current=state(content,undefined,editor.schema),dispatches=0,focused=0
 const view={get state(){return current},composing:false,editable:true,dispatch:(tr:EditorState['tr'])=>{dispatches++;current=current.applyTransaction(tr).state},focus:()=>{focused++}}
 Object.defineProperties(editor,{view:{get:()=>view},state:{get:()=>current},isDestroyed:{get:()=>false}})
 return{editor,get:()=>current,change:(tr:EditorState['tr'])=>{current=current.apply(tr)},view,dispatches:()=>dispatches,focused:()=>focused,target:():SlashTarget=>({...findSlash(current)!,anchor:'current'})}
}
test('slash triggers at text boundaries with Chinese or multiword search, but not in URLs or protected contexts',()=>{
 for(const text of ['/','/标题','写作 /bullet list'])assert.ok(findSlash(state([paragraph(text)])),text)
 for(const text of ['https://example.com/path','name@example.com/a','a/b','/'+ 'a'.repeat(81)])assert.equal(findSlash(state([paragraph(text)])),null,text)
 for(const kind of ['codeBlock'])assert.equal(findSlash(state([{type:kind,content:[{type:'text',text:'/heading'}]}])),null)
 for(const type of ['link','code']){
  const marks=type==='link'?[{type,attrs:{href:'https://example.com'}}]:[{type}]
  assert.equal(findSlash(state([{type:'paragraph',content:[{type:'text',text:'/heading',marks}]}])),null)
 }
 const current=state([paragraph('/heading')]);assert.equal(findSlash(current.apply(current.tr.setSelection(TextSelection.create(current.doc,1,3)))),null)
})
test('Escape dismisses without changing content, maps through peer inserts and resets on a different trigger',()=>{
 let current=state([paragraph('before'),paragraph('/标题')])
 current=current.apply(current.tr.setMeta(slashKey,{dismiss:true}));assert.equal(slashKey.getState(current)?.match,null);assert.equal(current.doc.lastChild?.textContent,'/标题')
 current=current.apply(current.tr.insertText('Peer ',1));assert.equal(slashKey.getState(current)?.match,null)
 current=current.apply(current.tr.insertText('继续'));assert.equal(slashKey.getState(current)?.match,null)
 current=current.apply(current.tr.setSelection(TextSelection.create(current.doc,1)));assert.equal(slashKey.getState(current)?.dismissed,null)
 current=current.apply(current.tr.insertText('/'));assert.equal(slashKey.getState(current)?.match?.query,'')
})
test('composition state hides menus and resumes after the committed text transaction',()=>{
 let current=state([paragraph('/标题')]);current=current.apply(current.tr.setMeta(slashKey,{composing:true}));assert.equal(slashKey.getState(current)?.match,null)
 current=current.apply(current.tr.insertText('一'));assert.equal(slashKey.getState(current)?.match,null)
 current=current.apply(current.tr.setMeta(slashKey,{composing:false}));assert.equal(slashKey.getState(current)?.match?.query,'标题一')
})
for(const [id,type] of [['block.paragraph','paragraph'],['block.heading','heading'],['block.bulletList','bulletList'],['block.orderedList','orderedList'],['block.quote','blockquote'],['block.code','codeBlock'],['block.divider','horizontalRule']])test(`${id} removes the trigger only in one successful content transaction`,()=>{
 const fixture=engine([paragraph('/search')]),apply=prepareSlashTransaction(fixture.editor,id,undefined,fixture.target())
 assert.ok(apply);assert.equal(fixture.get().doc.textContent,'/search');assert.equal(fixture.dispatches(),0)
 assert.equal(apply(),true);assert.equal(fixture.get().doc.firstChild?.type.name,type);assert.equal(fixture.get().doc.textContent,'');assert.equal(fixture.dispatches(),1);assert.equal(fixture.focused(),1)
 fixture.get().doc.check()
 const saved=jsonToSnapshot(fixture.get().doc.toJSON()),reopened=projectionToJson({documentId:'doc',revision:1,blocks:saved.map((block,index)=>({blockId:`b${index}`,blockHash:'hash',region:'body',readOnly:false,content:block.content}))})
 schema.nodeFromJSON(reopened).check()
})
test('host literal insertion preserves surrounding text, marks and line breaks without interpreting HTML',()=>{
 const fixture=engine([paragraph('before /approval')]),apply=prepareSlashTransaction(fixture.editor,'text.insert',{text:'<b>审批</b>\n下一行'},fixture.target())
 assert.ok(apply);assert.equal(apply(),true);assert.equal(fixture.get().doc.textBetween(0,fixture.get().doc.content.size,'\n','\n'),'before <b>审批</b>\n下一行')
 assert.equal(fixture.get().doc.firstChild?.firstChild?.marks.length,0)
})
test('failed, unsupported or stale staged operations never delete a trigger',()=>{
 for(const [id,input] of [['unsupported',undefined],['text.insert',{text:''}],['text.insert',{text:'a'.repeat(1_000_001)}]]){
  const f=engine([paragraph('/token')]);assert.equal(prepareSlashTransaction(f.editor,id as string,input,f.target()),null);assert.equal(f.dispatches(),0);assert.equal(f.get().doc.textContent,'/token')
 }
 const f=engine([paragraph('/heading')]),apply=prepareSlashTransaction(f.editor,'block.heading',undefined,f.target());assert.ok(apply)
 f.change(f.get().tr.insertText('peer'));assert.equal(apply(),false);assert.equal(f.get().doc.textContent,'/headingpeer');assert.equal(f.dispatches(),0)
})
test('composition and read-only state prevent a staged transaction at both preparation and commit',()=>{
 for(const stage of ['prepare','commit']){
  const f=engine([paragraph('/heading')]),apply=stage==='commit'?prepareSlashTransaction(f.editor,'block.heading',undefined,f.target()):null
  f.view.composing=true
  if(apply)assert.equal(apply(),false);else assert.equal(prepareSlashTransaction(f.editor,'block.heading',undefined,f.target()),null)
  assert.equal(f.dispatches(),0)
 }
 const f=engine([paragraph('/heading')]);f.editor.setOptions({editable:false});assert.equal(prepareSlashTransaction(f.editor,'block.heading',undefined,f.target()),null)
})

test('harmless UI metadata may change state without invalidating the same content, selection and marks',()=>{
 const f=engine([paragraph('/标题')]),apply=prepareSlashTransaction(f.editor,'block.heading',undefined,f.target());assert.ok(apply)
 f.change(f.get().tr.setMeta('ui-only',true));assert.equal(apply(),true);assert.equal(f.get().doc.firstChild?.type.name,'heading')
})
test('stored-mark changes during an async host operation preserve the original trigger',()=>{
 const f=engine([paragraph('/审批')]),apply=prepareSlashTransaction(f.editor,'text.insert',{text:'内容'},f.target());assert.ok(apply)
 f.change(f.get().tr.setStoredMarks([f.get().schema.marks.bold.create()]));assert.equal(apply(),false);assert.equal(f.get().doc.textContent,'/审批')
})

test('AI entry consumes only the confirmed trigger and never inserts a suggestion',()=>{
 const f=engine([paragraph('Before /AI')]),apply=prepareSlashTransaction(f.editor,'ai.compose',undefined,f.target())
 assert.ok(apply);assert.equal(f.get().doc.textContent,'Before /AI');assert.equal(apply(),true);assert.equal(f.get().doc.textContent,'Before ');assert.equal(f.dispatches(),1)
 const stale=engine([paragraph('/AI')]),pending=prepareSlashTransaction(stale.editor,'ai.compose',undefined,stale.target())!
 stale.change(stale.get().tr.insertText('peer'));assert.equal(pending(),false);assert.equal(stale.get().doc.textContent,'/AIpeer')
})
test('menu keyboard navigation skips disabled items and safely handles no available commands',()=>{
 const items=[{enabled:false},{enabled:true},{enabled:false},{enabled:true}]
 assert.equal(initialEnabledIndex(items),1);assert.equal(moveEnabledIndex(items,1,1),3);assert.equal(moveEnabledIndex(items,3,1),1);assert.equal(moveEnabledIndex(items,1,-1),3)
 assert.equal(initialEnabledIndex([]),-1);assert.equal(moveEnabledIndex([{enabled:false}],0,1),-1);assert.equal(moveEnabledIndex(items,-1,-1),3)
})

test('inline container slash insertion consumes only the confirmed query in one dispatch and keeps surrounding text',()=>{
 const registry=new InlineContainerRegistry([{type:'example.slash',version:1,display:'inline',contentModel:'inline',label:'字段',defaultData:{},validate:()=>true,fallback:()=> '字段'}]),value=registry.create('example.slash')
 const f=engine([paragraph('保留😀 /字段')],true),commit=prepareSlashTransaction(f.editor,'node.insert',{extension:value},f.target())
 assert.ok(commit);assert.equal(f.get().doc.textContent,'保留😀 /字段');assert.equal(f.dispatches(),0)
 assert.ok(commit());assert.equal(f.dispatches(),1);assert.equal(f.get().doc.textContent,'保留😀 ')
 const wrapper=f.get().doc.firstChild!.lastChild!;assert.equal(wrapper.type.name,'hcdExtensionInlineContainer');assert.equal(wrapper.attrs.extension.instanceId,value.instanceId);assert.equal(wrapper.content.size,0);f.get().doc.check()
 const stale=engine([paragraph('/字段')],true),pending=prepareSlashTransaction(stale.editor,'node.insert',{extension:registry.create('example.slash')},stale.target())!
 stale.change(stale.get().tr.insertText('继续'));assert.equal(pending(),false);assert.equal(stale.get().doc.textContent,'/字段继续');assert.equal(stale.dispatches(),0)
 const legacy=engine([paragraph('/字段')]);assert.equal(prepareSlashTransaction(legacy.editor,'node.insert',{extension:value},legacy.target()),null);assert.equal(legacy.get().doc.textContent,'/字段');assert.equal(legacy.dispatches(),0)
})
