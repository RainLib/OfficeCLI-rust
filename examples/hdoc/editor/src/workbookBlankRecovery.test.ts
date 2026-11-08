import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedDraftJournal,parseFixedDraftBackup,serializeFixedDraft,validateFixedDraft} from './fixedDraftJournal.ts'
import {resolveWorkbookBlankInput,resolveWorkbookBlankRecovery} from './workbookBlankRecovery.ts'
import {fixedRecoveryIds} from './fixedRecoveryPreview.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',format:'xlsx',token:'private',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),nodeId='n_'+'b'.repeat(32),root='c'.repeat(64)
const state:FixedDraftState={version:5,texts:[],images:[],attempt:null,blankAttempt:{documentId:'doc',patchId:'grid-original',baseRevision:4,sourceSha256:source,cells:[{sheetId:'s_'+'d'.repeat(32),sheetPart:'xl/worksheets/sheet1.xml',row:3,column:2,text:'待恢复😀',nodeId}]}}
const committed={status:'committed',patchId:'grid-original',baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:[nodeId]}

test('blank attempts survive journal reopening and portable backup identity checks',async()=>{
 const factory=new IDBFactory(),a=await FixedDraftJournal.open('blank-recovery',factory)
 try{
  await a.write(state);await a.flush();const saved=(await a.copies())[0].state
  assert.deepEqual(saved.blankAttempt,state.blankAttempt);assert.deepEqual(fixedRecoveryIds(saved),[nodeId]);assert.equal(saved.version,5)
  const raw=serializeFixedDraft(session,saved,source,'https://owned.test/')
  assert.doesNotMatch(raw,/private/);assert.deepEqual(parseFixedDraftBackup(raw,session,source,'https://owned.test/').blankAttempt,state.blankAttempt)
  assert.throws(()=>parseFixedDraftBackup(raw,{...session,userId:'bob'},source,'https://owned.test/'))
  const tampered=JSON.parse(raw);tampered.state.blankAttempt.sourceSha256='e'.repeat(64)
  assert.throws(()=>parseFixedDraftBackup(JSON.stringify(tampered),session,source,'https://owned.test/'))
  assert.throws(()=>validateFixedDraft({...saved,version:3}))
  const b=await FixedDraftJournal.open('blank-recovery',factory)
  try{assert.deepEqual((await b.copies())[0].state.blankAttempt,state.blankAttempt)}finally{b.close()}
 }finally{a.close()}
})
test('recovery retains the original branch on failure and resolves only the original receipt',async()=>{
 const factory=new IDBFactory(),original=await FixedDraftJournal.open('blank-resolve',factory),target=await FixedDraftJournal.open('blank-resolve',factory),old=globalThis.fetch
 const requests:string[]=[]
 try{
  await original.write(state)
  globalThis.fetch=async(input)=>{requests.push(String(input));throw Error('offline')}
  await assert.rejects(resolveWorkbookBlankRecovery(state,session,source,value=>target.write(value),new AbortController().signal),/offline/)
  assert.equal((await original.copies()).filter(copy=>copy.state.blankAttempt).length,2)
  globalThis.fetch=async(input)=>{requests.push(String(input));return Response.json(committed)}
  const resolved=await resolveWorkbookBlankRecovery(state,session,source,value=>target.write(value),new AbortController().signal)
  assert.equal(resolved.blankAttempt,undefined);assert.equal(resolved.version,3)
  const copies=await original.copies();assert.equal(copies.length,1);assert.deepEqual(copies[0].state.blankAttempt,state.blankAttempt)
  assert.ok(requests.every(path=>path.endsWith('/receipt')))
 }finally{globalThis.fetch=old;original.close();target.close()}
})
test('resolving an earlier request never clears later blank input',async()=>{
 const old=globalThis.fetch,attempt=state.blankAttempt!,later={documentId:'doc',baseRevision:4,sourceSha256:source,cell:{...attempt.cells[0],text:'later input'}}
 const value:FixedDraftState={...state,version:6,blankInput:later},writes:FixedDraftState[]=[]
 globalThis.fetch=async()=>Response.json(committed)
 try{
  const result=await resolveWorkbookBlankRecovery(value,session,source,async snapshot=>{writes.push(structuredClone(snapshot))},new AbortController().signal)
  assert.equal(result.version,6);assert.equal(result.blankAttempt,undefined);assert.equal(result.blankInput?.cell.text,'later input')
  assert.equal(validateFixedDraft(writes.at(-1)).blankInput?.cell.text,'later input')
 }finally{globalThis.fetch=old}
})
test('a superseded single-cell request becomes a durable input, preserving later text',async()=>{
 const old=globalThis.fetch,attempt=state.blankAttempt!,factory=new IDBFactory(),journal=await FixedDraftJournal.open('superseded-blank',factory)
 globalThis.fetch=async()=>Response.json({status:'superseded',patchId:attempt.patchId,baseRevision:4,observedRevision:5})
 try{
  await assert.rejects(resolveWorkbookBlankRecovery(state,session,source,value=>journal.write(value),new AbortController().signal),/superseded/)
  let saved=(await journal.copies())[0].state;assert.equal(saved.blankAttempt,undefined);assert.equal(saved.blankInput?.cell.text,'待恢复😀')
  const later={documentId:'doc',baseRevision:4,sourceSha256:source,cell:{...attempt.cells[0],text:'后续输入'}}
  await assert.rejects(resolveWorkbookBlankRecovery({...state,version:6,blankInput:later},session,source,value=>journal.write(value),new AbortController().signal),/superseded/)
  saved=(await journal.copies())[0].state;assert.equal(saved.blankAttempt,undefined);assert.equal(saved.blankInput?.cell.text,'后续输入')
 }finally{globalThis.fetch=old;journal.close()}
})
test('superseded recovery retains requests when another input or a device failure prevents safe transfer',async()=>{
 const old=globalThis.fetch,attempt=state.blankAttempt!,writes:FixedDraftState[]=[]
 globalThis.fetch=async()=>Response.json({status:'superseded',patchId:attempt.patchId,baseRevision:4,observedRevision:5})
 try{
  const different={documentId:'doc',baseRevision:4,sourceSha256:source,cell:{...attempt.cells[0],column:3,nodeId:'n_'+'e'.repeat(32),text:'其他输入'}}
  await assert.rejects(resolveWorkbookBlankRecovery({...state,version:6,blankInput:different},session,source,async value=>{writes.push(structuredClone(value))},new AbortController().signal),/requires review/)
  assert.ok(writes.at(-1)?.blankAttempt);assert.equal(writes.at(-1)?.blankInput?.cell.text,'其他输入')
  let count=0;await assert.rejects(resolveWorkbookBlankRecovery(state,session,source,async()=>{if(++count===2)throw Error('quota')},new AbortController().signal),/quota/)
 }finally{globalThis.fetch=old}
})
test('unsubmitted blank input is checked, written ahead, and resolves a lost response by receipt',async()=>{
 const old=globalThis.fetch,factory=new IDBFactory(),journal=await FixedDraftJournal.open('blank-input-submit',factory)
 const input={documentId:'doc',baseRevision:4,sourceSha256:source,cell:{...state.blankAttempt!.cells[0],text:'typed 😀'}}
 const local:FixedDraftState={version:6,texts:[],images:[],attempt:null,blankInput:input}
 let created:any=null,mutations=0
 globalThis.fetch=async(url,init)=>{
  const path=String(url),body=JSON.parse(String(init?.body))
  if(path.endsWith('/inspect'))return Response.json({revision:4,sourceSha256:source,rootHash:root,cells:[{...input.cell,address:'B3',sheetIndex:0,sheetState:'visible',sheetName:'Sheet'}]})
  if(path.endsWith('/receipt'))return Response.json({...committed,patchId:body.patchId})
  if(path.endsWith('/grid/cells')){mutations++;created=body;throw Error('response lost')}
  throw Error('unexpected request')
 }
 try{
  await assert.rejects(resolveWorkbookBlankInput(local,session,source,4,value=>journal.write(value),new AbortController().signal),/response lost/)
  const pending=(await journal.copies())[0].state
  assert.ok(pending.blankAttempt);assert.equal(pending.blankAttempt.patchId,created.patchId);assert.equal(pending.blankInput?.cell.text,'typed 😀')
  const restored=await resolveWorkbookBlankRecovery(pending,session,source,value=>journal.write(value),new AbortController().signal)
  assert.equal(restored.blankAttempt,undefined);assert.equal(restored.blankInput,undefined);assert.equal(mutations,1)
  assert.equal((await journal.copies()).length,0)
 }finally{globalThis.fetch=old;journal.close()}
})
test('blank recovery refuses a changed target and keeps the original input',async()=>{
 const old=globalThis.fetch,values:FixedDraftState[]=[]
 const input={documentId:'doc',baseRevision:4,sourceSha256:source,cell:{...state.blankAttempt!.cells[0],text:'local'}}
 const local:FixedDraftState={version:6,texts:[],images:[],attempt:null,blankInput:input}
 globalThis.fetch=async()=>Response.json({revision:4,sourceSha256:source,rootHash:root,cells:[{...input.cell,nodeId:'n_'+'f'.repeat(32),address:'B3',sheetIndex:0,sheetState:'visible',sheetName:'Sheet'}]})
 try{
  await assert.rejects(resolveWorkbookBlankInput(local,session,source,4,async value=>{values.push(structuredClone(value))},new AbortController().signal),/target changed/)
  assert.equal(values.at(-1)?.blankInput?.cell.text,'local');assert.equal(values.at(-1)?.blankAttempt,undefined)
 }finally{globalThis.fetch=old}
})
