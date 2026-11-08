import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {workbookDraftPort} from './workbookDrafts.ts'
import type {NodeLink} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import type {Session} from './api.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const session:Session={documentId:'book',scope:'write',format:'xlsx',token:'fixture',apiUrl:'https://owned.test/v1/documents'}
function cell(nodeId:string,text:string,column:number):NodeLink{return{nodeId,nodeHash:hash(text),text,revision:1,chunkId:'chunk',sheetId:'sheet',row:0,column,editable:true}}
function setup(){const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),port=workbookDraftPort(texts,()=>true,work=>controller.history.batch(work));return{texts,controller,port,history:controller.history}}
function server(){
 let revision=1,writes=0;const data=new Map([['a','A'],['b','B'],['peer','Peer before']])
 const fetch:typeof globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));if(url.pathname.endsWith('/book'))return Response.json({documentId:'book',revision})
  if(url.pathname.includes('/text/')){const id=url.pathname.split('/').at(-1)!,value=data.get(id);if(value===undefined)return new Response('missing',{status:404});assert.equal(Number(url.searchParams.get('revision')),revision);return Response.json({nodeId:id,text:value,nodeHash:hash(value),revision})}
  if(url.pathname.endsWith('/edits')){const patch=JSON.parse(String(init?.body));assert.equal(patch.baseRevision,revision);for(const op of patch.operations){assert.equal(op.precondition.nodeHash,hash(data.get(op.nodeId)!));data.set(op.nodeId,op.insertText)};revision++;writes++;return Response.json({revision,patchId:patch.patchId,nodeHashes:Object.fromEntries(patch.operations.map((op:{nodeId:string})=>[op.nodeId,hash(data.get(op.nodeId)!)])),images:[]})}
  throw new Error('unexpected '+url.pathname)
 }
 return{fetch,data,get revision(){return revision},get writes(){return writes},peer(id:string,text:string){data.set(id,text);revision++}}
}
test('a multi-cell paste is a single undo and redo, preserving a peer change to another cell',async()=>{
 const old=globalThis.fetch,s=server();globalThis.fetch=s.fetch
 const {texts,controller,port,history}=setup(),a=cell('a','A',0),b=cell('b','B',1)
 try{
  let notifications=0;texts.subscribe(()=>notifications++)
  port.edit([{link:a,text:'Alice A'},{link:b,text:'Alice B'}],1);assert.equal(notifications,1)
  await history.step('undo');assert.equal(texts.size,0);assert.equal(history.canUndo,false);assert.equal(history.canRedo,true)
  await history.step('redo');assert.equal(texts.get('a')?.text,'Alice A');assert.equal(texts.get('b')?.text,'Alice B')
  await controller.save(1);s.peer('peer','Peer after')
  const before=s.writes;await history.step('undo');assert.equal(texts.get('a')?.text,'A');assert.equal(texts.get('b')?.text,'B');assert.equal(s.data.get('peer'),'Peer after');assert.equal(s.writes,before)
  await controller.save(s.revision);assert.deepEqual([s.data.get('a'),s.data.get('b'),s.data.get('peer')],['A','B','Peer after'])
  await history.step('redo');await controller.save(s.revision);assert.deepEqual([s.data.get('a'),s.data.get('b'),s.data.get('peer')],['Alice A','Alice B','Peer after'])
 }finally{controller.dispose();globalThis.fetch=old}
})
test('a peer change to one cell rejects the entire batch undo without changing either cell',async()=>{
 const old=globalThis.fetch,s=server();globalThis.fetch=s.fetch
 const {texts,controller,port,history}=setup()
 try{port.edit([{link:cell('a','A',0),text:'Alice A'},{link:cell('b','B',1),text:'Alice B'}],1);await controller.save(1);s.peer('b','Peer B');const before=s.writes;await assert.rejects(history.step('undo'),/historyConflict/);assert.equal(texts.size,0);assert.equal(s.writes,before);assert.equal(history.canUndo,true);assert.deepEqual([s.data.get('a'),s.data.get('b')],['Alice A','Peer B'])}finally{controller.dispose();globalThis.fetch=old}
})
test('new input while a multi-cell history check is waiting prevents any partial inverse',async()=>{
 const old=globalThis.fetch,s=server(),{texts,controller,port,history}=setup();let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),seen=new Promise<void>(resolve=>{entered=resolve})
 globalThis.fetch=async(input,init)=>{if(String(input).includes('/text/')){entered();await gate}return s.fetch(input,init)}
 try{port.edit([{link:cell('a','A',0),text:'Alice A'},{link:cell('b','B',1),text:'Alice B'}],1);const pending=history.step('undo');await seen;texts.edit(cell('peer','Peer before',2),1,'New input');release();await assert.rejects(pending,/historyChanged/);assert.equal(texts.get('a')?.text,'Alice A');assert.equal(texts.get('b')?.text,'Alice B');assert.equal(texts.get('peer')?.text,'New input')}finally{release();controller.dispose();globalThis.fetch=old}
})
test('a new server revision during batch comparison leaves every local cell and history untouched',async()=>{
 const old=globalThis.fetch,s=server(),{texts,controller,port,history}=setup();let bumped=false
 globalThis.fetch=async(input,init)=>{const response=await s.fetch(input,init);if(String(input).includes('/text/b?')&&!bumped){bumped=true;s.peer('b','Peer arrives during comparison')}return response}
 try{port.edit([{link:cell('a','A',0),text:'Alice A'},{link:cell('b','B',1),text:'Alice B'}],1);await assert.rejects(history.step('undo'),/historyChanged/);assert.equal(texts.get('a')?.text,'Alice A');assert.equal(texts.get('b')?.text,'Alice B');assert.equal(s.data.get('b'),'Peer arrives during comparison');assert.equal(history.canUndo,true);assert.equal(s.writes,0)}finally{controller.dispose();globalThis.fetch=old}
})
test('an oversized paste is rejected before any draft or history action is created',()=>{
 const {texts,controller,port,history}=setup(),large='a'.repeat(1_000_000),replacement='b'.repeat(1_000_000)
 try{assert.throws(()=>port.edit([0,1,2].map(index=>({link:cell(String(index),large,index),text:replacement})),1),/workbookBatchTooLarge/);assert.equal(texts.size,0);assert.equal(history.canUndo,false)}finally{controller.dispose()}
})
