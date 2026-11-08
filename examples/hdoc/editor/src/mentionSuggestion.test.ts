import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection,NodeSelection} from '@tiptap/pm/state'
import {schemaExtensions,jsonToSnapshot} from './schema.ts'
import {findMention,mentionPlugin,mentionKey,mentionTransaction,readMentionPage,startMentionTransaction} from './mentionSuggestion.ts'
import {blockTarget,blockActionStates,transformBlocks} from './commands/blocks.ts'
const schema=getSchema(schemaExtensions),candidate={kind:'person' as const,id:'person:甲',label:'张三',detail:'产品组'}
function stateFor(text:string,type='paragraph',marks:string[]=[]){const doc=schema.node('doc',null,[schema.node(type,null,text?schema.text(text,marks.map(name=>schema.marks[name].create(name==='link'?{href:'https://example.com'}:undefined))):undefined)]);return EditorState.create({schema,doc,selection:TextSelection.create(doc,doc.content.size-1),plugins:[mentionPlugin()]})}
test('person trigger handles Unicode and spaced queries, and leaves email, code, links and existing atoms literal',()=>{
 for(const text of ['@','Hello @Alice Smith','你好，@张三']){const match=findMention(stateFor(text));assert.equal(match?.text,text.slice(text.lastIndexOf('@')))}
 for(const text of ['x@example.com','plain text','@@person','@'+'a'.repeat(81)])assert.equal(findMention(stateFor(text)),null)
 assert.equal(findMention(stateFor('@张','codeBlock')),null);assert.equal(findMention(stateFor('@张','paragraph',['link'])),null);assert.equal(findMention(stateFor('@张','paragraph',['code'])),null)
})
test('composition and Escape suppress suggestions without removing typed text',()=>{
 let state=stateFor('@张');state=state.apply(state.tr.setMeta(mentionKey,{composing:true}));assert.equal(mentionKey.getState(state)?.match,null)
 state=state.apply(state.tr.insertText('三'));assert.equal(mentionKey.getState(state)?.match,null);state=state.apply(state.tr.setMeta(mentionKey,{composing:false}));assert.equal(mentionKey.getState(state)?.match?.query,'张三')
 state=state.apply(state.tr.setMeta(mentionKey,{dismiss:true}));state=state.apply(state.tr.insertText('四'));assert.equal(mentionKey.getState(state)?.match,null);assert.equal(state.doc.textContent,'@张三四')
})
test('insertion replaces the precise live trigger with one readable atom and rejects stale selection',()=>{
 const state=stateFor('Hi @张'),match=findMention(state)!,tr=mentionTransaction(state,match,candidate),next=state.apply(tr),inline=jsonToSnapshot(next.doc.toJSON())[0].content.inlines
 assert.equal(next.doc.textContent,'Hi @张三 ');assert.equal(inline.find(v=>v.reference)?.reference?.target.id,'person:甲');assert.equal(next.selection.from,match.from+2)
 const changed=state.apply(state.tr.insertText('another'));assert.throws(()=>mentionTransaction(changed,match,candidate),/selection-changed/)
 const moved=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1)));assert.throws(()=>mentionTransaction(moved,match,candidate),/selection-changed/)
 const selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1,2)));assert.equal(findMention(selected),null)
})
test('menu payloads are bounded and person references cannot convert into a lossy code block',()=>{
 const page={schemaVersion:'hcd-mention-options/1',kind:'person',items:[candidate],nextCursor:null};assert.deepEqual(readMentionPage(page),page)
 for(const bad of [{...page,items:[candidate,candidate]},{...page,items:[{...candidate,kind:'team'}]},{...page,items:[{...candidate,label:''}]},{...page,nextCursor:2}])assert.throws(()=>readMentionPage(bad))
 const before=stateFor('@张'),state=before.apply(mentionTransaction(before,findMention(before)!,candidate)),target=blockTarget(state)!
 assert.equal(blockActionStates(state,target)['block.code'].enabled,false);assert.equal(transformBlocks(state.tr,'block.code',undefined,target),false)
 assert.equal(findMention(state.apply(state.tr.setSelection(NodeSelection.create(state.doc,1)))),null)
})

test('the shared mention command opens at a word boundary without overwriting neighboring text',()=>{
 const before=stateFor('正文'),tr=startMentionTransaction(before)!,after=before.apply(tr);assert.equal(after.doc.textContent,'正文 @');assert.equal(findMention(after)?.query,'')
 assert.equal(startMentionTransaction(stateFor('code','codeBlock')),null)
})
