import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import type {Session} from './api.ts'
import {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'
import {WorkbookBlankBatchJournal} from './workbookBlankBatchJournal.ts'
import {parseWorkbookCombinedBackup} from './workbookCombinedBackup.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),root='b'.repeat(64),sheet='s_'+'c'.repeat(32),cells=[{sheetId:sheet,row:2,column:1,text:'甲'},{sheetId:sheet,row:2,column:2,text:'乙'}]
test('batch capture is protected across windows and recoverable after reopening',async()=>{
 const originals=['window','navigator','indexedDB','BroadcastChannel','fetch'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const),factory=new IDBFactory(),events=new EventTarget(),held=new Set<string>()
 const locks={request:async(name:string,_options:any,work:(lock:object|null)=>Promise<unknown>)=>{if(held.has(name))return work(null);held.add(name);try{return await work({})}finally{held.delete(name)}}}
 Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(events,{location:{href:'https://owned.test/editor'}})})
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:factory});Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:undefined})
 let first:WorkbookBlankBatchClient|undefined,second:WorkbookBlankBatchClient|undefined
 try{
  first=new WorkbookBlankBatchClient(session,source,()=>true);await first.start();second=new WorkbookBlankBatchClient(session,source,()=>true);await second.start()
  assert.equal(first.capture(cells,2,root),true);await assert.rejects(first.withClear(async()=>{}),/pending/)
  for(let i=0;i<100&&first.working;i++)await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal(first.entries.length,1);await assert.rejects(second.withClear(async()=>{}),/pending/);assert.equal(second.entries.length,1)
  const copy=structuredClone(first.entries[0]);let staged=false;await assert.rejects(first.copyCell(copy.id,copy.state,cells[0],async()=>{staged=true;throw Error('interrupted')}),/interrupted/);assert.equal(staged,true);assert.deepEqual(first.entries[0].state,copy.state);await first.copyCell(copy.id,copy.state,cells[0],async()=>{});assert.deepEqual(first.entries[0].state,copy.state)
  const denied=new WorkbookBlankBatchClient(session,source,()=>true,()=>true,()=>false);await denied.start();try{assert.equal(denied.canRemove,false);await assert.rejects(denied.removeCell(denied.entries[0].id,denied.entries[0].state,cells[0]),/unavailable/);assert.deepEqual(denied.entries[0].state.input.cells,cells)}finally{denied.dispose()}
  // An overlapping newer refresh may suppress publication into `entries`;
  // the lock holder must use the result read under its own lock instead.
  const readList=WorkbookBlankBatchJournal.prototype.list;let releaseRead!:()=>void,startedRead!:()=>void,calls=0
  const readHeld=new Promise<void>(resolve=>releaseRead=resolve),readStarted=new Promise<void>(resolve=>startedRead=resolve)
  WorkbookBlankBatchJournal.prototype.list=async function(){const rows=await readList.call(this);if(++calls===1){startedRead();await readHeld;return rows}return []}
  try{const decision=second.withPendingResolution(async hasPending=>hasPending);await readStarted;await second.refresh();assert.equal(second.entries.length,0);releaseRead();assert.equal(await decision,true)}finally{releaseRead();WorkbookBlankBatchJournal.prototype.list=readList;await second.refresh()}
  let resume!:()=>void,enteredResolution!:()=>void;const running=new Promise<void>(resolve=>enteredResolution=resolve),finishResolution=new Promise<void>(resolve=>resume=resolve)
  const resolution=first.withPendingResolution(async()=>{enteredResolution();await finishResolution;return 'original receipt'})
  await running;await assert.rejects(second.withPendingResolution(async()=>{}),/busy/);await assert.rejects(second.discard(second.entries[0].id),/busy/);resume();assert.equal(await resolution,'original receipt');assert.equal(first.entries.length,1)
  const combined=await first.combinedBackup(()=>({version:4,texts:[],images:[],attempt:null,workbookBuffer:{base:{nodeId:'node',nodeHash:root,text:'old'},revision:0,text:'unfinished',initial:'old',sheetId:'sheet',row:0,column:0}})),review=parseWorkbookCombinedBackup(combined,session,source,'https://owned.test/editor')
  assert.equal(review.fixed.workbookBuffer?.text,'unfinished');assert.equal(review.batches.length,1);assert.deepEqual(first.entries[0].state.input.cells,cells)
  const list=WorkbookBlankBatchJournal.prototype.list;let release!:()=>void,started!:()=>void,inputActive=false;const waiting=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve)
  WorkbookBlankBatchJournal.prototype.list=async function(){const entries=await list.call(this);started();await waiting;return entries}
  try{const capture=first.combinedBackup(()=>{if(inputActive)throw Error('workbook-backup-input-active');return {version:3,texts:[],images:[],attempt:null}});await entered;inputActive=true;release();await assert.rejects(capture,/workbook-backup-input-active/);assert.equal(first.entries.length,1)}finally{WorkbookBlankBatchJournal.prototype.list=list}
  const id=first.entries[0].id;first.dispose();first=undefined
  const reopened=new WorkbookBlankBatchClient(session,source,()=>true);await reopened.start()
  try{assert.equal(reopened.entries[0].id,id);assert.deepEqual(reopened.entries[0].state.input.cells,cells);const old=structuredClone(reopened.entries[0].state);await reopened.removeCell(id,old,cells[0]);assert.deepEqual(reopened.entries[0].state.input.cells,[cells[1]]);await assert.rejects(reopened.removeCell(id,old,cells[1]),/changed/);assert.deepEqual(reopened.entries[0].state.input.cells,[cells[1]]);const backup=await reopened.backup(id);assert.equal(JSON.parse(backup).schemaVersion,'hcd-blank-batch-backup/2');assert.equal(JSON.parse(backup).state.input.cells.length,1);await reopened.discard(id);assert.equal(await second.refresh(),false);let closed=false;await second.withClear(async()=>{closed=true});assert.equal(closed,true)}finally{reopened.dispose()}
  const stage=WorkbookBlankBatchJournal.prototype.stage;let fail=true
  WorkbookBlankBatchJournal.prototype.stage=async function(input){if(fail)throw Error('device unavailable');return stage.call(this,input)}
  try{
   assert.equal(second.capture(cells,2,root),true)
   for(let i=0;i<100&&second.working;i++)await new Promise(resolve=>setTimeout(resolve,1))
   assert.deepEqual(second.transient?.cells,cells);assert.equal(second.entries.length,0);await assert.rejects(second.withClear(async()=>{}),/pending/)
   const combinedTransient=await second.combinedBackup(()=>({version:3,texts:[],images:[],attempt:null}));assert.equal(parseWorkbookCombinedBackup(combinedTransient,session,source,'https://owned.test/editor').batches.length,1)
   const backup=await second.backup(null);await second.discardTransient();assert.equal(second.transient,null)
   const file={size:new TextEncoder().encode(backup).byteLength,text:async()=>backup} as File
   await second.importBackup(file);await second.importBackup(file);assert.equal(second.entries.length,1)
   await second.discard(second.entries[0].id)
   const third=new WorkbookBlankBatchClient(session,source,()=>true);await third.start()
   const originalImport=WorkbookBlankBatchJournal.prototype.import
   WorkbookBlankBatchJournal.prototype.import=function(state,signal){const pending=originalImport.call(this,state,signal);third.dispose();return pending}
   try{await assert.rejects(third.importBackup(file));assert.equal(await second.refresh(),false)}finally{WorkbookBlankBatchJournal.prototype.import=originalImport;third.dispose()}
   fail=false;assert.equal(second.capture(cells,2,root),true)
   for(let i=0;i<100&&second.working;i++)await new Promise(resolve=>setTimeout(resolve,1))
   assert.equal(second.transient,null);assert.equal(second.entries.length,1)
   let head=3,occupied=false
   globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/head'))return Response.json({documentId:'doc',revision:head,sourceSha256:source})
    if(occupied)return new Response('occupied',{status:409})
    const request=JSON.parse(String(init?.body))
    return Response.json({revision:request.expectedRevision,sourceSha256:source,rootHash:root,cells:request.cells.map((cell:any,index:number)=>({...cell,address:index?'C3':'B3',sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet',sheetIndex:0,sheetState:'visible',nodeId:'n_'+(index?'e':'d').repeat(32)}))})
   }
   const batchId=second.entries[0].id,review=await second.reviewRebase(batchId)
   assert.equal(review.revision,3);assert.equal(second.entries[0].state.input.baseRevision,2)
   head=4;await assert.rejects(second.confirmRebase(review),/head changed/);assert.equal(second.entries[0].state.input.baseRevision,2)
   occupied=true;await assert.rejects(second.reviewRebase(batchId));assert.equal(second.entries[0].state.input.baseRevision,2)
   occupied=false;const latest=await second.reviewRebase(batchId);await second.confirmRebase(latest)
   assert.equal(second.entries[0].state.input.baseRevision,4);assert.deepEqual(second.entries[0].state.input.cells,cells)
  }finally{WorkbookBlankBatchJournal.prototype.stage=stage}
 }finally{first?.dispose();second?.dispose();for(const [name,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name)}}
})
