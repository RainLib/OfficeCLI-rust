import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {IDBFactory} from 'fake-indexeddb'
import {FixedDraftJournal,validateFixedDraft} from './fixedDraftJournal.ts'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {WorkbookInputCapture,restoreWorkbookInput,workbookInputDiverged,workbookInputLocation} from './workbookInputBuffer.ts'
import type {NodeLink} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import type {Session} from './api.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const link:NodeLink={nodeId:'cell',nodeHash:hash('Original'),text:'Original',revision:1,chunkId:'chunk',sheetId:'sheet',row:4,column:2,editable:true}
const session:Session={documentId:'book',format:'xlsx',scope:'write',token:'private-token',apiUrl:'https://owned.test/v1/documents'}

test('settled notification waits until confirmed input is actually observed in either event order',()=>{
 for(const endFirst of [false,true]){
  const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller);let notified=0
  const off=input.subscribeSettled(()=>notified++)
  try{input.start(link,1);input.change('cell','new input\r\n');if(endFirst)input.end('cell',true);else input.observed('cell','new input');assert.equal(notified,0);if(endFirst)input.observed('cell','new input');else input.end('cell',true);assert.equal(notified,1);assert.equal(input.isActive(),false);assert.equal(controller.workbookBuffer,null)}finally{off();controller.dispose()}
 }
})

test('unfinished input is durable without becoming a saved cell, and explicit recovery preserves Unicode and the original base',async()=>{
 const db=new IDBFactory(),journal=await FixedDraftJournal.open('input-before-enter',db),texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore(),journal),input=new WorkbookInputCapture(texts,controller)
 try{
  await controller.connect();input.start(link,1);input.change(link.nodeId,'未确认😀\r\n第二行\r\n');await controller.flush()
  assert.equal(texts.size,0);assert.equal(controller.state().version,4);assert.equal(controller.workbookBuffer?.text,'未确认😀\r\n第二行')
  await assert.rejects(controller.save(1),/workbookInputPending/)
  const copy=(await journal.copies())[0].state;assert.doesNotMatch(JSON.stringify(copy),/private-token/)
  const next=new TextDraftStore(),restored=new FixedSaveController(session,next,new ImageDraftStore(),null,copy.attempt)
  try{next.restore(copy.texts);restoreWorkbookInput(next,copy.workbookBuffer!);assert.equal(next.get('cell')?.text,'未确认😀\r\n第二行');assert.equal(next.get('cell')?.base.nodeHash,link.nodeHash);assert.equal(restored.state().version,3)}finally{restored.dispose()}
 }finally{controller.dispose();journal.close()}
})
test('cancel removes the private buffer without changing a pre-existing draft; returning to the initial value clears it',async()=>{
 const texts=new TextDraftStore();texts.edit(link,1,'Earlier draft');const controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
 try{input.start(link,1);input.change('cell','New typing\r\n');assert.equal(controller.workbookBuffer?.text,'New typing');input.change('cell','Earlier draft\r\n');assert.equal(controller.workbookBuffer,null);input.change('cell','Temporary\r\n');input.end('cell',false);assert.equal(controller.workbookBuffer,null);assert.equal(texts.get('cell')?.text,'Earlier draft')}finally{controller.dispose()}
})
test('confirmation retains the buffer until the normal cell change is actually observed, in either event order',()=>{
 for(const observedFirst of [true,false]){
  const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
  try{input.start(link,1);input.change('cell','Confirmed\r\n');if(observedFirst)input.observed('cell','Confirmed');input.end('cell',true);if(!observedFirst){assert.equal(controller.workbookBuffer?.text,'Confirmed');input.observed('other','Confirmed');assert.ok(controller.workbookBuffer);input.observed('cell','Confirmed')}assert.equal(controller.workbookBuffer,null)}finally{controller.dispose()}
 }
})
test('a stale value event cannot clear newer input in either event order',()=>{
 for(const endFirst of [false,true]){
  const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
  try{input.start(link,1);input.change('cell','Newer input\r\n');if(endFirst)input.end('cell',true);input.observed('cell','Old value');if(!endFirst)input.end('cell',true);assert.equal(input.isActive(),false);assert.equal(controller.workbookBuffer?.text,'Newer input');assert.equal(input.canStart(),false);restoreWorkbookInput(texts,controller.workbookBuffer!);assert.equal(texts.get('cell')?.text,'Newer input')}finally{controller.dispose()}
 }
})
test('an original-base value restored over a remote conflict remains available for explicit resolution',()=>{
 const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
 try{texts.edit(link,1,'Old local');input.start(link,1);input.change('cell','Original\r\n');texts.reconcile([{nodeId:'cell',nodeHash:hash('Peer'),text:'Peer'}],2);restoreWorkbookInput(texts,controller.workbookBuffer!);assert.equal(texts.get('cell')?.text,'Original');assert.equal(texts.get('cell')?.remote?.text,'Peer')}finally{controller.dispose()}
})
test('divergent unfinished input and local draft survive recovery as separate intents',async()=>{
 const db=new IDBFactory(),journal=await FixedDraftJournal.open('divergent-input',db),texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore(),journal)
 const buffer={base:link,revision:1,initial:'Earlier draft',text:'Unfinished input',sheetId:'sheet',row:4,column:2}
 try{
  texts.edit(link,1,'Later draft');assert.equal(workbookInputDiverged(texts,buffer),true)
  controller.setWorkbookBuffer(buffer);await controller.connect();await controller.flush()
  const copy=(await journal.copies())[0].state;assert.equal(copy.texts[0][1].text,'Later draft');assert.equal(copy.workbookBuffer?.text,'Unfinished input')
  texts.edit(link,1,'Earlier draft');assert.equal(workbookInputDiverged(texts,buffer),false)
  texts.edit(link,1,'Unfinished input');assert.equal(workbookInputDiverged(texts,buffer),false)
 }finally{controller.dispose();journal.close()}
})
test('input buffer format rejects downgrades and malformed or oversized coordinates',()=>{
 const base={version:4,texts:[],images:[],attempt:null,workbookBuffer:{base:link,revision:1,initial:'Original',text:'x',sheetId:'sheet',row:4,column:2}}
 assert.equal(validateFixedDraft(base).workbookBuffer?.text,'x')
 for(const value of [{...base,version:3},{...base,workbookBuffer:{...base.workbookBuffer,row:1_048_576}},{...base,workbookBuffer:{...base.workbookBuffer,text:'x'.repeat(1_000_001)}},{...base,workbookBuffer:{...base.workbookBuffer,base:{...link,nodeHash:'bad'}}}])assert.throws(()=>validateFixedDraft(value))
})
test('an interrupted editor keeps its private input and blocks starting a new cell until reviewed',()=>{
 const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
 try{input.start(link,1);input.change('cell','Pending after switch\r\n');assert.equal(input.isActive(),true);assert.equal(input.canStart(),false);input.abandon();assert.equal(input.isActive(),false);assert.equal(input.canStart(),false);assert.equal(controller.workbookBuffer?.text,'Pending after switch');restoreWorkbookInput(texts,controller.workbookBuffer!);controller.setWorkbookBuffer(null);assert.equal(input.canStart(),true);assert.equal(texts.get('cell')?.text,'Pending after switch')}finally{controller.dispose()}
})
test('late edit-start events cannot replace a retained input buffer',()=>{
 const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller),other={...link,nodeId:'other',row:5}
 try{
  input.start(link,1);input.change('cell','Keep this text\r\n')
  input.start(other,1);input.change('other','Late cell text\r\n');assert.equal(controller.workbookBuffer?.text,'Keep this text');assert.equal(controller.workbookBuffer?.base.nodeId,'cell')
  input.abandon();input.start(other,1);input.change('other','After interruption\r\n');assert.equal(input.isActive(),false);assert.equal(controller.workbookBuffer?.text,'Keep this text');assert.equal(controller.workbookBuffer?.base.nodeId,'cell')
  restoreWorkbookInput(texts,controller.workbookBuffer!);controller.setWorkbookBuffer(null);input.start(other,1);input.change('other','Next input\r\n');assert.equal(controller.workbookBuffer?.base.nodeId,'other');assert.equal(controller.workbookBuffer?.text,'Next input')
 }finally{controller.dispose()}
})
test('an active capture cannot be replaced before typing or after returning to its initial value',()=>{
 for(const revert of [false,true]){
  const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller),other={...link,nodeId:'other',row:5}
  try{
   input.start(link,1);if(revert){input.change('cell','Temporary\r\n');input.change('cell','Original\r\n')}
   assert.equal(controller.state().workbookBuffer,undefined);assert.equal(input.canStart(),false)
   input.start(other,1);input.change('other','Wrong cell\r\n');input.change('cell','Keep original cell\r\n')
   assert.equal(controller.workbookBuffer?.base.nodeId,'cell');assert.equal(controller.workbookBuffer?.text,'Keep original cell')
   input.end('cell',false);assert.equal(input.canStart(),true);input.start(other,1);input.change('other','Next cell\r\n');assert.equal(controller.workbookBuffer?.base.nodeId,'other')
  }finally{controller.dispose()}
 }
})
test('rejected confirmed input remains available for explicit review in either event order',()=>{
 for(const endFirst of [false,true]){
  const texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
  try{input.start(link,1);input.change('cell','=8+7\r\n');if(endFirst)input.end('cell',true);input.reject('cell');if(!endFirst)input.end('cell',true);assert.equal(input.isActive(),false);assert.equal(input.canStart(),false);assert.equal(controller.workbookBuffer?.text,'=8+7');assert.equal(texts.size,0)}finally{controller.dispose()}
 }
})

test('unfinished input retains its recorded sheet and cell address, including legacy backups',async()=>{
 const journal=await FixedDraftJournal.open('input-location',new IDBFactory()),texts=new TextDraftStore(),controller=new FixedSaveController(session,texts,new ImageDraftStore(),journal),input=new WorkbookInputCapture(texts,controller)
 try{
  await controller.connect();input.start(link,1,'第二张表');input.change('cell','Review me\r\n');await controller.flush()
  const buffer=(await journal.copies())[0].state.workbookBuffer!;assert.equal(workbookInputLocation(buffer),'第二张表!C5')
  assert.equal(workbookInputLocation({...buffer,sheetName:undefined,row:1048575,column:16383}),'sheet!XFD1048576')
  assert.throws(()=>validateFixedDraft({...controller.state(),workbookBuffer:{...buffer,sheetName:'x\nunsafe'}}))
 }finally{controller.dispose();journal.close()}
})
