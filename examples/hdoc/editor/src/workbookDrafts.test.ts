import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {IDBFactory} from 'fake-indexeddb'
import {workbookDraftPort} from './workbookDrafts.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {FixedSaveController} from './fixedSaveController.ts'
import {FixedDraftJournal,fixedDraftDatabase} from './fixedDraftJournal.ts'
import {ServiceGridClient} from './ServiceGridClient.ts'
import type {NodeLink} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import {ApiError,type Session} from './api.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const cell=(nodeId='cell-a',text='Original'):NodeLink=>({nodeId,nodeHash:hash(text),text,chunkId:'chunk',sheetId:'sheet',row:0,column:nodeId==='cell-a'?0:1,editable:true})
const session:Session={documentId:'book',scope:'write',format:'xlsx',token:'not-in-backup',apiUrl:'https://owned.test/v1/documents',collabUrl:'ws://owned.test',userId:'alice'}

test('a workbook paste preflights every cell and emits one complete snapshot, preserving canonical source links',()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),a=cell(),b=cell('cell-b','Second');let notifications=0
 texts.subscribe(()=>notifications++)
 assert.throws(()=>port.edit([{link:a,text:'Local'},{link:{...b,editable:false},text:'Forbidden'}],0),/draftsNotReady/)
 assert.equal(texts.size,0);assert.equal(notifications,0)
 port.edit([{link:a,text:'Local 中文😀'},{link:b,text:'Another'}],0)
 assert.equal(notifications,1);assert.equal(port.text(a),'Local 中文😀');assert.equal(port.text(b),'Another')
 assert.equal(a.text,'Original');assert.equal(texts.get(a.nodeId)?.base.nodeHash,a.nodeHash)
 assert.throws(()=>port.edit([{link:a,text:'x'},{link:a,text:'y'}],0),/draftsNotReady/);assert.equal(texts.get(a.nodeId)?.text,'Local 中文😀')
})
test('revocation blocks new cell drafts and remote conflicts retain the local value until explicit choice',()=>{
 let writable=true;const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>writable),a=cell()
 port.edit([{link:a,text:'Mine'}],0);const remote={...a,text:'Peer',nodeHash:hash('Peer')}
 texts.reconcile([remote],1);assert.equal(port.text(remote),'Mine');assert.equal(texts.get(a.nodeId)?.remote?.text,'Peer')
 writable=false;assert.throws(()=>port.edit([{link:a,text:'Unauthorized'}],1),/readOnlyMode/);assert.equal(port.text(a),'Mine')
 texts.resolve(remote,1,true);assert.equal(texts.get(a.nodeId)?.base.nodeHash,hash('Peer'));assert.equal(texts.get(a.nodeId)?.remote,undefined)
 texts.resolve(remote,1,false);assert.equal(texts.size,0)
})
test('Excel unknown submission survives reopening and token rotation, resolves the exact receipt and keeps later input',async()=>{
 const factory=new IDBFactory(),name=await fixedDraftDatabase(session,'alice',hash('source'),'https://editor.test'),journal=await FixedDraftJournal.open(name,factory)
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),controller=new FixedSaveController(session,texts,new ImageDraftStore(),journal)
 const old=globalThis.fetch;let exact='',posts=0
 try{
  await controller.connect();port.edit([{link:cell(),text:'Captured'}],0)
  globalThis.fetch=async(_url,init)=>{if(String(_url).endsWith('/edits')){exact=String(init?.body);posts++};throw new Error('lost response')}
  await assert.rejects(controller.save(0),/fixedSaveUnknown/)
  port.edit([{link:cell(),text:'Later typing'}],0);await journal.flush()
  const saved=(await journal.copies()).find(copy=>copy.id===journal.branch)!.state
  assert.ok(saved.attempt);assert.equal(saved.texts[0][1].text,'Later typing');assert.doesNotMatch(JSON.stringify(saved),/not-in-backup/)
  controller.dispose();const recovered=new TextDraftStore();recovered.restore(saved.texts)
  const reopened=await FixedDraftJournal.open(name,factory),next=new FixedSaveController({...session,token:'renewed'},recovered,new ImageDraftStore(),reopened,saved.attempt)
  try{
   await next.connect();globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('/edits/receipt'));assert.equal(String(init?.body),exact);return Response.json({status:'committed',patchId:saved.attempt!.id,revision:1,nodeHashes:{'cell-a':hash('Captured')},images:[]})}
   assert.equal(await next.save(8),1);assert.equal(posts,1);assert.equal(next.pending,false)
   assert.equal(recovered.get('cell-a')?.text,'Later typing');assert.equal(recovered.get('cell-a')?.base.text,'Captured')
   assert.equal(workbookDraftPort(recovered,()=>true).text(cell()),'Later typing')
   const peer=cell('cell-b','Peer');recovered.reconcile([peer],8);assert.equal(recovered.size,1)
  }finally{next.dispose();reopened.close()}
 }finally{globalThis.fetch=old;controller.dispose();journal.close()}
})
test('a saved cell can be edited back to the original value without losing its new canonical hash',()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),a=cell()
 port.edit([{link:a,text:'Saved'}],0);const sent=texts.entries();texts.beginSave(sent);texts.acknowledge(sent,1,{[a.nodeId]:hash('Saved')});texts.endSave(sent)
 assert.equal(port.text(a),'Saved');port.edit([{link:a,text:'Original'}],1)
 assert.equal(texts.get(a.nodeId)?.base.text,'Saved');assert.equal(texts.get(a.nodeId)?.base.nodeHash,hash('Saved'));assert.equal(texts.get(a.nodeId)?.text,'Original')
})
test('a new workbook request is never sent if the full draft cannot be persisted',async()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),controller=new FixedSaveController(session,texts,new ImageDraftStore(),{write:async()=>{throw Error('quota')},flush:async()=>{}}),old=globalThis.fetch;let requests=0
 port.edit([{link:cell(),text:'Retained'}],0);globalThis.fetch=async()=>{requests++;throw Error('must not send')}
 try{await assert.rejects(controller.save(0),/quota/);assert.equal(requests,0);assert.equal(controller.pending,false);assert.equal(texts.get('cell-a')?.text,'Retained')}
 finally{globalThis.fetch=old;controller.dispose()}
})
for(const code of ['XLSX_FORMULA_READ_ONLY','XLSX_FORMULA_PROOF_REQUIRED','XLSX_MERGED_CELL_READ_ONLY','XLSX_SHEET_PROTECTED'])test(`${code} keeps the draft but releases the request after receipt check`,async()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),controller=new FixedSaveController(session,texts,new ImageDraftStore()),original=globalThis.fetch,a=cell()
 port.edit([{link:a,text:'Local'}],0)
 globalThis.fetch=async(url,init)=>String(url).endsWith('/edits/receipt')?Response.json({status:'missing',patchId:JSON.parse(String(init?.body)).patchId}):Response.json({error:code},{status:422})
 try{
  await assert.rejects(controller.save(0),error=>error instanceof ApiError&&error.status===422&&error.code===code)
  assert.equal(controller.pending,false);assert.equal(texts.get(a.nodeId)?.text,'Local')
  port.edit([{link:a,text:'Original'}],0);assert.equal(texts.size,0)
 }finally{globalThis.fetch=original;controller.dispose()}
})
test('an older local receipt cannot mask or become the base of a newer remote canonical cell',()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),a={...cell(),revision:0}
 port.edit([{link:a,text:'Alice r1'}],0);const sent=texts.entries();texts.beginSave(sent);texts.acknowledge(sent,1,{[a.nodeId]:hash('Alice r1')});texts.endSave(sent)
 const peer={...a,text:'Bob r2',nodeHash:hash('Bob r2'),revision:2}
 assert.equal(port.text(peer),undefined)
 port.edit([{link:peer,text:'New local after Bob'}],4)
 assert.equal(texts.get(a.nodeId)?.base.text,'Bob r2');assert.equal(texts.get(a.nodeId)?.base.nodeHash,hash('Bob r2'))
})
test('a recovered draft cannot paint over a protected formula cell',()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),protectedCell={...cell(),editable:false}
 texts.restore([[protectedCell.nodeId,{base:{nodeId:protectedCell.nodeId,nodeHash:protectedCell.nodeHash,text:protectedCell.text},revision:0,text:'Recovered local text'}]])
 assert.equal(port.text(protectedCell),undefined);assert.equal(texts.get(protectedCell.nodeId)?.text,'Recovered local text')
 assert.throws(()=>port.edit([{link:protectedCell,text:'Overwrite'}],0),/draftsNotReady/)
})
test('a protection rejection can temporarily hide drafts even with an obsolete editable mapping',()=>{
 const texts=new TextDraftStore();let blocked=false;const port=workbookDraftPort(texts,()=>true,work=>work(),()=>!blocked),link=cell()
 port.edit([{link,text:'Pending text'}],0);assert.equal(port.text(link),'Pending text');blocked=true;assert.equal(port.text(link),undefined);assert.equal(texts.get(link.nodeId)?.text,'Pending text');blocked=false;assert.equal(port.text(link),'Pending text')
})
test('an unrelated head advance does not discard the confirmed base for an older loaded chunk',()=>{
 const texts=new TextDraftStore(),port=workbookDraftPort(texts,()=>true),a={...cell(),revision:0}
 port.edit([{link:a,text:'Confirmed r1'}],0);const sent=texts.entries();texts.beginSave(sent);texts.acknowledge(sent,1,{[a.nodeId]:hash('Confirmed r1')});texts.endSave(sent)
 port.edit([{link:a,text:'Second edit at head r5'}],5)
 assert.equal(texts.get(a.nodeId)?.base.text,'Confirmed r1');assert.equal(texts.get(a.nodeId)?.base.nodeHash,hash('Confirmed r1'))
})
test('grid index, styles and delayed chunk reads remain pinned to the opening revision',async()=>{
 const old=globalThis.fetch,windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window')
 Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'https://editor.test/'}}})
 const requests:string[]=[],grid=new ServiceGridClient(session,'en-US'),source=hash('source')
 globalThis.fetch=async(input)=>{
  const url=new URL(String(input));requests.push(url.pathname+url.search)
  if(url.pathname.endsWith('/book'))return Response.json({schemaVersion:'hcd/2',profile:'grid',documentId:'book',revision:2,indexPageCount:1,source:{sha256:source}})
  assert.equal(url.searchParams.get('revision'),'2')
  if(url.pathname.includes('/index/'))return Response.json({chunks:[{sequence:0,chunkId:'chunk',grid:{sheetId:'sheet'}}]})
  if(url.pathname.endsWith('/styles'))return new Response('styles')
  return Response.json({descriptor:{chunkId:'chunk'},html:'<table></table>'})
 }
 try{await grid.open();grid.manifest.revision=9;await grid.readStyles();await grid.readChunk(grid.descriptors[0]);assert.equal(grid.sourceHash,source);assert.equal(requests.length,4)}finally{globalThis.fetch=old;grid.dispose();if(windowDescriptor)Object.defineProperty(globalThis,'window',windowDescriptor);else Reflect.deleteProperty(globalThis,'window')}
})
