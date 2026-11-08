import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {WorkbookBlankInputCapture,validateWorkbookBlankInput,workbookBatchAvoidsBlank,workbookBatchSnapshotAllowed,type WorkbookBlankInput} from './workbookBlankInput.ts'
import {FixedDraftJournal,parseFixedDraftBackup,serializeFixedDraft} from './fixedDraftJournal.ts'
import {FixedSaveController} from './fixedSaveController.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {fixedRecoveryIds} from './fixedRecoveryPreview.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',format:'xlsx',scope:'write',userId:'alice',token:'secret',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),sheetId='s_'+'b'.repeat(32),nodeId='n_'+'c'.repeat(32)
const input:WorkbookBlankInput={documentId:'doc',baseRevision:2,sourceSha256:source,cell:{sheetId,nodeId,sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet',row:3,column:2,text:''}}

test('batch capture excludes both the retained input and exact unresolved request',()=>{
 const request={cells:[{...input.cell,row:5,column:3}]}
 assert.equal(workbookBatchAvoidsBlank([{sheetId,row:2,column:1}],input,request),false)
 assert.equal(workbookBatchAvoidsBlank([{sheetId,row:4,column:2}],input,request),false)
 assert.equal(workbookBatchAvoidsBlank([{sheetId,row:3,column:1},{sheetId,row:3,column:2}],input,request),true)
 assert.equal(workbookBatchAvoidsBlank([{sheetId:'other',row:2,column:1}],input,request),true)
})
test('an older grid snapshot is accepted only while a request remains unresolved',()=>{
 assert.equal(workbookBatchSnapshotAllowed(1,1,false),true)
 assert.equal(workbookBatchSnapshotAllowed(0,1,true),true)
 assert.equal(workbookBatchSnapshotAllowed(0,1,false),false)
 assert.equal(workbookBatchSnapshotAllowed(2,1,true),false)
 assert.equal(workbookBatchSnapshotAllowed(0,null,true),false)
})

test('unsubmitted blank input survives the journal and blocks ordinary saves',async()=>{
 const factory=new IDBFactory(),journal=await FixedDraftJournal.open('blank-input',factory),controller=new FixedSaveController(session,new TextDraftStore(),new ImageDraftStore(),journal)
 try{
  await controller.connect()
  const capture=new WorkbookBlankInputCapture(value=>controller.setWorkbookBlankInput(value));capture.start(input)
  capture.change(sheetId,2,1,'未完成😀\r\n');await controller.flush()
  const stored=(await journal.copies())[0].state
  assert.equal(stored.version,6);assert.equal(stored.blankInput?.cell.text,'未完成😀');assert.deepEqual(fixedRecoveryIds(stored),[nodeId])
  await assert.rejects(controller.save(2),/workbookInputPending/)
  const raw=serializeFixedDraft(session,stored,source,'https://owned.test/')
  assert.equal(parseFixedDraftBackup(raw,session,source,'https://owned.test/').blankInput?.cell.text,'未完成😀')
  assert.throws(()=>parseFixedDraftBackup(raw,{...session,userId:'bob'},source,'https://owned.test/'))
  capture.end(true);assert.equal(controller.workbookBlankInput?.cell.text,'未完成😀')
  const reopened=await FixedDraftJournal.open('blank-input',factory)
  try{assert.equal((await reopened.copies())[0].state.blankInput?.cell.text,'未完成😀')}finally{reopened.close()}
 }finally{controller.dispose();journal.close()}
})
test('cancel and unrelated events cannot accidentally replace another cell input',async()=>{
 const saved:Array<WorkbookBlankInput|null>=[],capture=new WorkbookBlankInputCapture(value=>saved.push(value))
 capture.start(input);capture.change(sheetId,2,1,'first\r\n');capture.change(sheetId,2,2,'wrong\r\n')
 assert.equal(saved.at(-1)?.cell.text,'first');capture.end(false);assert.equal(saved.at(-1),null)
 capture.start(input);capture.change(sheetId,2,1,'retained\r\n');capture.abandon();assert.equal(saved.at(-1)?.cell.text,'retained')
 assert.throws(()=>validateWorkbookBlankInput({...input,sourceSha256:'f'.repeat(64)},session,source),/invalid/)
})
test('observed blank edits are accepted once and remain separate from later paste',()=>{
 const saved:Array<WorkbookBlankInput|null>=[],capture=new WorkbookBlankInputCapture(value=>saved.push(value))
 capture.start(input);capture.change(sheetId,2,1,'first\r\n');assert.equal(capture.acceptsObservation(sheetId,2,1),true)
 capture.observed(sheetId,2,1,'first');capture.end(true);assert.equal(capture.acceptsObservation(sheetId,2,1),false)
 capture.observed(sheetId,2,1,'later paste');assert.equal(saved.at(-1)?.cell.text,'first')
})
test('blank transaction writes preserve other drafts and restore prior state on persistence failure',async()=>{
 const texts=new TextDraftStore();texts.edit({nodeId:'other',nodeHash:'f'.repeat(64),text:'old'},2,'other draft')
 let fail=false;const writes:any[]=[]
 const controller=new FixedSaveController(session,texts,new ImageDraftStore(),{write:async value=>{if(fail)throw Error('quota');writes.push(structuredClone(value))},flush:async()=>{}})
 const draft={...input,cell:{...input.cell,text:'blank'}};controller.setWorkbookBlankInput(draft)
 const pending={documentId:'doc',patchId:'grid-test',baseRevision:2,sourceSha256:source,cells:[draft.cell]}
 try{
  await controller.writeWorkbookBlankState({...controller.state(),version:6,blankAttempt:pending})
  assert.equal(writes.at(-1).texts[0][1].text,'other draft');assert.deepEqual(controller.workbookBlankAttempt,pending)
  fail=true;await assert.rejects(controller.writeWorkbookBlankState({...controller.state(),blankAttempt:undefined,blankInput:undefined}),/quota/)
  assert.deepEqual(controller.workbookBlankAttempt,pending);assert.equal(controller.workbookBlankInput?.cell.text,'blank')
 }finally{controller.dispose()}
})

test('a failed blank transition does not discard later input or leave its failed attempt in the device snapshot',async()=>{
 const writes:any[]=[];let rejectWrite!:(error:Error)=>void,started!:()=>void,delay=false
 const entered=new Promise<void>(resolve=>{started=resolve})
 const persistence={write:async(value:any)=>{writes.push(structuredClone(value));if(delay){delay=false;started();await new Promise<void>((_,reject)=>{rejectWrite=reject})}},flush:async()=>{}}
 const controller=new FixedSaveController(session,new TextDraftStore(),new ImageDraftStore(),persistence)
 const first={...input,cell:{...input.cell,text:'first'}},later={...input,cell:{...input.cell,text:'later'}}
 const pending={documentId:'doc',patchId:'grid-test',baseRevision:2,sourceSha256:source,cells:[first.cell]}
 try{
  controller.setWorkbookBlankInput(first);delay=true
  const writing=controller.writeWorkbookBlankState({...controller.state(),blankInput:undefined,blankAttempt:pending});await entered
  await assert.rejects(controller.writeWorkbookBlankState(controller.state()),/workbookBlankStateBusy/)
  assert.throws(()=>controller.continueWithoutBackup(),/Save is in progress/)
  controller.setWorkbookBlankInput(later);rejectWrite(Error('quota'));await assert.rejects(writing,/quota/)
  assert.equal(controller.workbookBlankInput?.cell.text,'later');assert.equal(controller.workbookBlankAttempt,null)
  assert.equal(writes.at(-2).blankAttempt,undefined)
  assert.equal(writes.at(-1).blankInput.cell.text,'later');assert.equal(writes.at(-1).blankAttempt,undefined)
 }finally{controller.dispose()}
})

test('later blank input and the rollback survive reopening the actual device journal',async()=>{
 const factory=new IDBFactory(),journal=await FixedDraftJournal.open('blank-late-input',factory)
 let rejectWrite!:(error:Error)=>void,started!:()=>void,delay=false
 const entered=new Promise<void>(resolve=>{started=resolve})
 const controller=new FixedSaveController(session,new TextDraftStore(),new ImageDraftStore(),{write:async value=>{if(delay){delay=false;started();await new Promise<void>((_,reject)=>{rejectWrite=reject})}await journal.write(value)},flush:()=>journal.flush()})
 const first={...input,cell:{...input.cell,text:'first'}},later={...input,cell:{...input.cell,text:'later'}}
 const pending={documentId:'doc',patchId:'grid-test',baseRevision:2,sourceSha256:source,cells:[first.cell]}
 try{
  await controller.connect();controller.setWorkbookBlankInput(first);await controller.flush();delay=true
  const writing=controller.writeWorkbookBlankState({...controller.state(),blankInput:undefined,blankAttempt:pending});await entered
  controller.setWorkbookBlankInput(later);rejectWrite(Error('injected failure'));await assert.rejects(writing,/injected failure/);await controller.flush()
  const reopened=await FixedDraftJournal.open('blank-late-input',factory)
  try{const saved=(await reopened.copies()).find(copy=>copy.state.blankInput?.cell.text==='later');assert.ok(saved);assert.equal(saved.state.blankAttempt,undefined)}finally{reopened.close()}
 }finally{controller.dispose();journal.close()}
})

test('a late input also cancels a successfully persisted but now stale blank attempt',async()=>{
 let release!:()=>void,started!:()=>void,delay=false;const writes:any[]=[]
 const entered=new Promise<void>(resolve=>{started=resolve})
 const controller=new FixedSaveController(session,new TextDraftStore(),new ImageDraftStore(),{write:async value=>{writes.push(structuredClone(value));if(delay){delay=false;started();await new Promise<void>(resolve=>{release=resolve})}},flush:async()=>{}})
 const first={...input,cell:{...input.cell,text:'first'}},later={...input,cell:{...input.cell,text:'later'}}
 const pending={documentId:'doc',patchId:'grid-test',baseRevision:2,sourceSha256:source,cells:[first.cell]}
 try{
  controller.setWorkbookBlankInput(first);delay=true
  const writing=controller.writeWorkbookBlankState({...controller.state(),blankInput:undefined,blankAttempt:pending});await entered
  controller.setWorkbookBlankInput(later);release();await assert.rejects(writing,/workbookBlankStateChanged/)
  assert.equal(controller.workbookBlankInput?.cell.text,'later');assert.equal(controller.workbookBlankAttempt,null)
  assert.equal(writes.at(-1).blankInput.cell.text,'later');assert.equal(writes.at(-1).blankAttempt,undefined)
 }finally{controller.dispose()}
})
