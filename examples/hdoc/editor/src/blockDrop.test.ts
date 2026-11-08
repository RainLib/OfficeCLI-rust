import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {blockDropEntries,pickBlockDrop,blockEdgeScroll,type DropRow} from './commands/blockDrop.ts'
import {operableBlockEntry,editorBlockEntries,type BlockTarget} from './commands/blocks.ts'
const viewport={left:0,right:800,top:100,bottom:600},region={left:40,right:760,top:100,bottom:600},row:DropRow={from:10,to:20,name:'Paragraph',rect:{left:100,right:700,top:200,bottom:260}}
test('drag hover shows exactly the before/after boundary that will be submitted',()=>{
 for(const [y,edge,position,line]of [[210,'before',10,200],[250,'after',20,260]] as const){const result=pickBlockDrop([row],{x:150,y},viewport,region,[10,20])!;assert.equal(result.allowed,true);assert.equal(result.edge,edge);assert.equal(result.position,position);assert.equal(result.lineTop,line);assert.deepEqual(result.rect,row.rect)}
})
test('a no-op or protected boundary is visible but never becomes a valid drop',()=>{const result=pickBlockDrop([row],{x:150,y:210},viewport,region,[30])!;assert.equal(result.allowed,false);assert.equal(result.position,10)})
test('gutter hover and whitespace use the adjacent row rather than requiring a text glyph hit',()=>{const next={...row,from:20,to:30,rect:{...row.rect,top:280,bottom:330}};assert.equal(pickBlockDrop([row,next],{x:60,y:275},viewport,region,[20])?.position,20);assert.equal(pickBlockDrop([row],{x:42,y:220},viewport,region,[10]),null)})
test('viewport and nested parent bounds clear feedback outside the actual drop surface',()=>{assert.equal(pickBlockDrop([row],{x:150,y:80},viewport,region,[10]),null);assert.equal(pickBlockDrop([row],{x:150,y:350},viewport,{...region,bottom:300},[20]),null)})
test('zoomed and partially scrolled rows retain screen geometry and hide off-screen insertion lines',()=>{const scaled={...row,rect:{left:110,right:710,top:70,bottom:250}};const result=pickBlockDrop([scaled],{x:150,y:115},viewport,region,[10])!;assert.equal(result.allowed,true);assert.equal(result.lineTop,null);assert.equal(result.rect.top,100)})
test('edge scroll is bounded, stops away from edges and never scrolls a different panel',()=>{assert.equal(blockEdgeScroll({x:400,y:100},viewport),-18);assert.equal(blockEdgeScroll({x:400,y:600},viewport),18);assert.equal(blockEdgeScroll({x:400,y:300},viewport),0);assert.equal(blockEdgeScroll({x:810,y:599},viewport),0)})
test('nested rows resolve to siblings, while an unloaded ancestor cannot expose operative child handles',()=>{
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),registry=new NodeExtensionRegistry([{type:'example.drop',version:1,display:'block',contentModel:'blocks',label:'Drop',defaultData:{},validate:()=>true,fallback:()=> 'Wrapper'}]),payload=registry.create('example.drop'),doc=schema.nodeFromJSON({type:'doc',content:[{type:'hcdExtensionContainer',attrs:{extension:payload},content:[{type:'paragraph',content:[{type:'text',text:'One'}]},{type:'paragraph',content:[{type:'text',text:'Two'}]}]},{type:'paragraph',content:[{type:'text',text:'Outside'}]}]}),all=editorBlockEntries(doc),child=all.find(entry=>entry.node.textContent==='One')!,target={kind:'block',from:child.from,to:child.to,fingerprint:'',anchor:null,intent:'operate',scope:{from:0,instanceId:payload.instanceId}} as BlockTarget
 assert.deepEqual(blockDropEntries(doc,target).map(entry=>entry.node.textContent),['One','Two']);assert.deepEqual(blockDropEntries(doc,{...target,scope:undefined}).map(entry=>entry.node.textContent),['OneTwo','Outside']);assert.equal(operableBlockEntry(doc,child,registry),true);assert.equal(operableBlockEntry(doc,child,new NodeExtensionRegistry()),false)
})
