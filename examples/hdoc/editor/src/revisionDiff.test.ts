import {test} from 'node:test'
import assert from 'node:assert/strict'
import {revisionDifferences,revisionTextDifference,revisionBlockText,semanticRevisionSelection} from './revisionDiff.ts'
import {revisionChangedRows} from './revisionSelection.ts'
import {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import type {Block,Projection} from './schema.ts'
const block=(id:string,text:string):Block=>({blockId:id,blockHash:'hash',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text}]}})
const projection=(blocks:Block[],revision=0):Projection=>({documentId:'doc',revision,blocks})
test('block comparison ignores canonical/source receipts and detects regenerated unchanged blocks',()=>{
 const a=block('old','相同'),b=block('new','相同');a.content.inlines[0].nodeId='old-run';b.content.inlines[0].nodeId='new-run'
 const changes=revisionDifferences(projection([a]),projection([b],1));assert.equal(changes.length,1);assert.equal(changes[0].kind,'same');assert.equal(changes[0].moved,false)
})
test('insertion does not mark all shifted blocks as moved; a true reordering does',()=>{
 const a=[block('a','A'),block('b','B'),block('c','C')],inserted=revisionDifferences(projection(a),projection([block('new','Added'),...a],1))
 assert.equal(inserted.filter(change=>change.moved).length,0);assert.equal(inserted[0].kind,'added')
 const moved=revisionDifferences(projection(a),projection([a[1],a[0],a[2]],1));assert.equal(moved.filter(change=>change.moved).length,1)
})
test('text, formatting and protected object changes remain separately visible',()=>{
 const a=block('a','Old'),b=block('a','New'),c=block('b','Same'),d=structuredClone(c);d.content.inlines[0].bold=true
 const image=block('image',''),replacement=structuredClone(image);image.readOnly=true;image.readOnlyHtml='<img src="asset://sha256/old">';replacement.readOnly=true;replacement.readOnlyHtml='<img src="asset://sha256/new">'
 const changed=revisionDifferences(projection([a,c,image]),projection([b,d,replacement],1));assert.equal(changed[0].textChanged,true);assert.equal(changed[1].formatChanged,true);assert.equal(changed[2].objectChanged,true)
})
test('deleted text and nested type changes do not disappear',()=>{
 const old=[block('a','Start'),block('b','Deleted'),block('c','End')],changed=revisionDifferences(projection(old),projection([old[0],old[2]],1))
 assert.equal(changed[1].kind,'removed');assert.equal(changed[1].before?.content.inlines[0].text,'Deleted')
 const quote=structuredClone(old[0]);quote.content={kind:'blockquote',inlines:[],children:[old[0].content]};assert.equal(revisionDifferences(projection([old[0]]),projection([quote],1))[0].kind,'modified')
})
test('Unicode text difference reconstructs both versions without losing emoji or Chinese characters',()=>{
 for(const [a,b]of [['你好，旧文字😀结束','你好，新文字😀结束'],['','新增'],['删除',''],['same','same'],['a '.repeat(1000)+'旧','a '.repeat(1000)+'新']]){
  const parts=revisionTextDifference(a,b);assert.equal(parts.filter(part=>part.kind!=='added').map(part=>part.text).join(''),a);assert.equal(parts.filter(part=>part.kind!=='removed').map(part=>part.text).join(''),b)
 }
})
test('large documents use stable block anchors rather than a document-wide matrix',()=>{
 const blocks=Array.from({length:10000},(_,index)=>block(String(index),'段落 '+index)),next=blocks.slice();next[5000]=block('5000','Changed')
 const changed=revisionDifferences(projection(blocks),projection(next,1));assert.equal(changed.filter(change=>change.kind!=='same').length,1)
})
test('revision text differences show nested inline bodies even when their retained fallback is unchanged',()=>{
 const registry=new InlineContainerRegistry([{type:'example.field',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{title:'Label'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}])
 const a=block('a','prefix '),nested={text:'Label',content:{kind:'extension' as const,extension:registry.create('example.field'),inlines:[{text:'旧😀'}]}}
 a.content.inlines.push({text:'Label',content:{kind:'extension',extension:registry.create('example.field'),inlines:[{text:'正文 '},nested,{text:'',hardBreak:true},{text:'结束'}]}},{text:' suffix'})
 const b=structuredClone(a);b.content.inlines[1].content!.inlines[1].content!.inlines[0].text='新😀'
 assert.equal(revisionBlockText(a.content),'prefix 正文 旧😀\n结束 suffix');assert.equal(revisionBlockText(b.content),'prefix 正文 新😀\n结束 suffix')
 const change=revisionDifferences(projection([a]),projection([b],1))[0]
 assert.equal(change.kind,'modified');assert.equal(change.textChanged,true);assert.equal(change.formatChanged,false)
 const parts=revisionTextDifference(revisionBlockText(a.content),revisionBlockText(b.content))
 assert.ok(parts.some(part=>part.kind==='removed'&&part.text==='旧'));assert.ok(parts.some(part=>part.kind==='added'&&part.text==='新'))
 const c=structuredClone(a);c.content.inlines[1].content!.inlines[1].content!.inlines[0].bold=true
 const format=revisionDifferences(projection([a]),projection([c],2))[0];assert.equal(format.textChanged,false);assert.equal(format.formatChanged,true)
 const receipt=structuredClone(a);receipt.content.inlines[1].content!.inlines[1].content!.inlines[0].nodeId='fresh-source'
 assert.equal(revisionDifferences(projection([a]),projection([receipt],3))[0].kind,'same')
})
test('the semantic adapter folds a Projection pair into the neutral review contract',()=>{
 const before=[block('a','旧内容'),block('b','保留'),block('c','未变')],after=[block('a','新内容'),block('b','保留'),block('c','未变')]
 const selection=semanticRevisionSelection(projection(before,2),projection(after,4),{author:'林',createdAt:1730000000000})
 assert.equal(selection.target,2);assert.equal(selection.comparedWith,4);assert.equal(selection.author,'林');assert.equal(selection.createdAt,1730000000000)
 assert.equal(selection.changes.length,3);assert.equal(selection.changes[1].kind,'same')
 const changed=revisionChangedRows(selection)
 assert.equal(changed.length,1);assert.equal(changed[0].kind,'modified');assert.equal(changed[0].oldIndex,0);assert.equal(changed[0].newIndex,0)
 assert.equal(changed[0].beforeText,'旧内容');assert.equal(changed[0].afterText,'新内容')
})
