import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ApiError,type Session} from './api.ts'
import {BlankBatchInspectionError,saveBlankBatch,validateBlankBatchInput,type BlankBatchState,type BlankBatchStore} from './workbookBlankBatch.ts'
import {batchReviewError} from './workbookBlankBatchReviewError.ts'
import {WorkbookBlankBatchJournal} from './workbookBlankBatchJournal.ts'
import {IDBFactory} from 'fake-indexeddb'
import {parseBlankBatchBackup,serializeBlankBatchBackup} from './workbookBlankBatchBackup.ts'
import {parseWorkbookCombinedBackup,serializeWorkbookCombinedBackup} from './workbookCombinedBackup.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),root='b'.repeat(64),sheet='s_'+'c'.repeat(32),nodes=['n_'+'d'.repeat(32),'n_'+'e'.repeat(32)]
const input={documentId:'doc',sourceSha256:source,baseRevision:4,rootHash:root,cells:[{sheetId:sheet,row:2,column:1,text:'甲😀'},{sheetId:sheet,row:2,column:2,text:'乙'}]}
function fixture(){let state:BlankBatchState|null={input:structuredClone(input),attempt:null};const writes:Array<BlankBatchState|null>=[];const store:BlankBatchStore={read:async()=>structuredClone(state),replace:async(expected,next)=>{if(JSON.stringify(state)!==JSON.stringify(expected))return false;state=structuredClone(next);writes.push(structuredClone(next));return true}};return{store,writes,get:()=>structuredClone(state),set:(value:BlankBatchState|null)=>{state=structuredClone(value)}}}
const inspect=async(_session:Session,revision:number,_source:string,targets:ReadonlyArray<{sheetId:string;row:number;column:number}>,_signal:AbortSignal)=>({revision,rootHash:root,cells:targets.map((target,index)=>({...target,sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet',sheetIndex:0,sheetState:'visible',address:index?'C3':'B3',nodeId:nodes[index]}))})
test('a reviewed batch reduced to one value still saves through the same guarded transaction',async()=>{
 const f=fixture(),old=globalThis.fetch;f.set({input:{...input,cells:[input.cells[1]]},attempt:null})
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));assert.equal(request.cells.length,1);assert.equal(request.cells[0].text,'乙');return Response.json({patchId:request.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:[nodes[0]]})}
 try{assert.equal((await saveBlankBatch(session,source,f.store,new AbortController().signal,inspect)).revision,5);assert.equal(f.get(),null)}finally{globalThis.fetch=old}
})
test('a single remaining value uses a distinct portable backup version',()=>{
 const state:BlankBatchState={input:{...input,cells:[input.cells[1]]},attempt:null},base='https://owned.test/editor'
 const encoded=serializeBlankBatchBackup(state,session,source,base),value=JSON.parse(encoded)
 assert.equal(value.schemaVersion,'hcd-blank-batch-backup/2');assert.deepEqual(parseBlankBatchBackup(encoded,session,source,base),state)
 value.schemaVersion='hcd-blank-batch-backup/1';assert.throws(()=>parseBlankBatchBackup(JSON.stringify(value),session,source,base))
})
test('whole batch is durable before submission and an unknown outcome reuses its exact request',async()=>{
 const f=fixture(),old=globalThis.fetch,requests:Array<{url:string;body:string}>=[];let posted=false
 globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:String(init?.body)});posted=true;assert.ok(f.get()?.attempt);throw Error('response lost')}
 try{
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/response lost/)
  const saved=f.get();assert.ok(posted&&saved?.attempt);assert.equal(saved.attempt.cells.length,2)
  const base='https://owned.test/editor',bundle=serializeWorkbookCombinedBackup(session,source,base,{version:3,texts:[],images:[],attempt:null},[saved]);const parsed=parseWorkbookCombinedBackup(bundle,session,source,base);assert.deepEqual(parseBlankBatchBackup(parsed.batches[0],session,source,base),saved)
  globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:String(init?.body)});return Response.json({status:'committed',patchId:saved.attempt!.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})}
  assert.deepEqual(await saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),{revision:5,rootHash:root})
  assert.equal(f.get(),null);assert.equal(requests[0].body,requests[1].body);assert.match(requests[1].url,/receipt$/)
 }finally{globalThis.fetch=old}
})
test('changed baseline or concurrent replacement never submits a batch',async()=>{
 const f=fixture(),old=globalThis.fetch;let sent=0;globalThis.fetch=async()=>{sent++;throw Error('unexpected')}
 try{
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,async(...args)=>({...await inspect(...args),rootHash:'f'.repeat(64)})),/baseline changed/)
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,async(...args)=>{const result=await inspect(...args);f.set({input:{...input,cells:[input.cells[0],{...input.cells[1],text:'new'}]},attempt:null});return result}),/blank batch changed/)
  assert.equal(sent,0);assert.equal(f.get()?.input.cells[1].text,'new')
 }finally{globalThis.fetch=old}
})
test('preflight conflicts are actionable without treating a submitted request as unsent',async()=>{
 const f=fixture(),old=globalThis.fetch;let submissions=0
 try{
  globalThis.fetch=async()=>{submissions++;return new Response(JSON.stringify({error:'XLSX_GRID_HEAD_CHANGED'}),{status:409})}
  const issue=new ApiError(409,JSON.stringify({error:'XLSX_GRID_HEAD_CHANGED'}))
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,async()=>{throw issue}),error=>{assert.ok(error instanceof BlankBatchInspectionError);assert.equal(batchReviewError(error.cause),'workbookBatchReviewChanged');return true})
  assert.equal(submissions,0);assert.deepEqual(f.get(),{input,attempt:null});assert.equal(f.writes.length,0)
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),error=>{assert.ok(!(error instanceof BlankBatchInspectionError));return true})
  assert.equal(submissions,1);assert.ok(f.get()?.attempt)
 }finally{globalThis.fetch=old}
})
test('revocation during inspection or durable preparation prevents submission and retains input',async()=>{
 const f=fixture(),old=globalThis.fetch;let allowed=true,sent=0;globalThis.fetch=async()=>{sent++;throw Error('unexpected')}
 try{
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,async(...args)=>{const result=await inspect(...args);allowed=false;return result},()=>allowed),/readOnlyMode/)
  assert.equal(f.get()?.attempt,null);allowed=true
  const store:BlankBatchStore={read:f.store.read,replace:async(expected,next)=>{const result=await f.store.replace(expected,next);allowed=false;return result}}
  await assert.rejects(saveBlankBatch(session,source,store,new AbortController().signal,inspect,()=>allowed),/readOnlyMode/)
  assert.ok(f.get()?.attempt);assert.deepEqual(f.get()?.input,input);assert.equal(sent,0)
 }finally{globalThis.fetch=old}
})
test('a separate unresolved save blocks new batch requests but not recovery of an existing one',async()=>{
 const old=globalThis.fetch,f=fixture();let sent=0,allowed=false
 try{
  globalThis.fetch=async()=>{sent++;throw Error('response lost')}
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect,()=>true,()=>true,()=>allowed),/other request pending/);assert.equal(sent,0);assert.equal(f.get()?.attempt,null)
  allowed=true
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,async(...args)=>{const result=await inspect(...args);allowed=false;return result},()=>true,()=>true,()=>allowed),/other request pending/);assert.equal(sent,0);assert.equal(f.get()?.attempt,null)
  allowed=true;await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect,()=>true,()=>true,()=>allowed),/response lost/);const pending=f.get()!;assert.ok(pending.attempt);allowed=false
  globalThis.fetch=async(url,init)=>{sent++;assert.match(String(url),/receipt$/);const request=JSON.parse(String(init?.body));return Response.json({status:'missing',patchId:request.patchId})}
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect,()=>true,()=>true,()=>allowed),/other request pending/);assert.deepEqual(f.get(),pending);assert.equal(sent,2)
  globalThis.fetch=async(_url,init)=>{sent++;const request=JSON.parse(String(init?.body));assert.equal(request.patchId,pending.attempt!.patchId);return Response.json({status:'committed',patchId:request.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})}
  assert.equal((await saveBlankBatch(session,source,f.store,new AbortController().signal,inspect,()=>true,()=>true,()=>allowed)).revision,5);assert.equal(f.get(),null);assert.equal(sent,3)
 }finally{globalThis.fetch=old}
})
test('a refresh after clearing a verified receipt does not report a successful save as failed',async()=>{
 const f=fixture(),old=globalThis.fetch;let allowed=true
 const store:BlankBatchStore={read:f.store.read,replace:async(expected,next)=>{const result=await f.store.replace(expected,next);if(next===null)allowed=false;return result}}
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));return Response.json({patchId:request.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})}
 try{assert.deepEqual(await saveBlankBatch(session,source,store,new AbortController().signal,inspect,()=>allowed),{revision:5,rootHash:root});assert.equal(f.get(),null)}finally{globalThis.fetch=old}
})
test('a grid reload during the verified receipt does not prevent acknowledgement, but revocation does',async()=>{
 const old=globalThis.fetch;let gridReady=true,authorized=true
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));gridReady=false;return Response.json({patchId:request.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})}
 try{
  const f=fixture();assert.deepEqual(await saveBlankBatch(session,source,f.store,new AbortController().signal,inspect,()=>gridReady,()=>authorized),{revision:5,rootHash:root});assert.equal(f.get(),null)
  gridReady=true;authorized=true;const revoked=fixture();globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));gridReady=false;authorized=false;return Response.json({patchId:request.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})}
  await assert.rejects(saveBlankBatch(session,source,revoked.store,new AbortController().signal,inspect,()=>gridReady,()=>authorized),/readOnlyMode/);assert.ok(revoked.get()?.attempt)
 }finally{globalThis.fetch=old}
})
test('a definitive superseded receipt releases only the request and retains the entire batch',async()=>{
 const f=fixture(),old=globalThis.fetch
 try{
  globalThis.fetch=async()=>{throw Error('response lost')}
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/response lost/)
  const pending=f.get()!;assert.ok(pending.attempt)
  globalThis.fetch=async()=>Response.json({status:'superseded',patchId:pending.attempt!.patchId,baseRevision:4,observedRevision:5})
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/superseded/)
  assert.deepEqual(f.get(),{input,attempt:null})
 }finally{globalThis.fetch=old}
})
test('malformed superseded receipts retain the exact pending request',async()=>{
 const f=fixture(),old=globalThis.fetch
 try{
  globalThis.fetch=async()=>{throw Error('response lost')};await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect))
  const pending=f.get()!
  globalThis.fetch=async()=>Response.json({status:'superseded',patchId:pending.attempt!.patchId,baseRevision:4,observedRevision:4})
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/invalid blank receipt/);assert.deepEqual(f.get(),pending)
 }finally{globalThis.fetch=old}
})
test('a failed journal transition keeps the superseded request available for another receipt lookup',async()=>{
 const f=fixture(),old=globalThis.fetch
 try{
  globalThis.fetch=async()=>{throw Error('response lost')};await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect))
  const pending=f.get()!
  globalThis.fetch=async()=>Response.json({status:'superseded',patchId:pending.attempt!.patchId,baseRevision:4,observedRevision:5})
  const failing:BlankBatchStore={read:f.store.read,replace:async()=>false}
  await assert.rejects(saveBlankBatch(session,source,failing,new AbortController().signal,inspect),/blank batch changed/)
  assert.deepEqual(f.get(),pending)
  await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/superseded/)
  assert.deepEqual(f.get(),{input,attempt:null})
 }finally{globalThis.fetch=old}
})
test('invalid target duplicates, formulas and mismatched saved attempts are refused',async()=>{
 assert.throws(()=>validateBlankBatchInput({...input,cells:[input.cells[0],input.cells[0]]},session,source),/invalid/)
 assert.throws(()=>validateBlankBatchInput({...input,cells:[input.cells[0],{...input.cells[1],text:'=1+1'}]},session,source),/invalid/)
 const f=fixture();f.set({input,attempt:{documentId:'doc',sourceSha256:source,baseRevision:4,patchId:'grid-test',cells:input.cells.map((cell,i)=>({sheetId:sheet,sheetPart:'xl/worksheets/sheet1.xml',row:cell.row+1,column:cell.column+1,nodeId:nodes[i],text:i?'different':cell.text}))}})
 await assert.rejects(saveBlankBatch(session,source,f.store,new AbortController().signal,inspect),/attempt changed/)
})
test('device journal reopens the exact batch request and isolates users',async()=>{
 const factory=new IDBFactory(),journal=await WorkbookBlankBatchJournal.open(session,source,'https://owned.test/',factory),old=globalThis.fetch
 try{
  const id=await journal.stage(input),branch=journal.branch(id);globalThis.fetch=async()=>{throw Error('response lost')}
  await assert.rejects(saveBlankBatch(session,source,branch,new AbortController().signal,inspect),/response lost/)
  const pending=await branch.read();assert.ok(pending?.attempt);journal.close()
  const reopened=await WorkbookBlankBatchJournal.open(session,source,'https://owned.test/',factory),other=await WorkbookBlankBatchJournal.open({...session,userId:'bob'},source,'https://owned.test/',factory)
  try{
   assert.equal((await other.list()).length,0);assert.deepEqual((await reopened.list())[0].state,pending)
   const current=reopened.branch(id);assert.equal(await current.replace({...pending,input:{...input,rootHash:'f'.repeat(64)}},null),false)
   globalThis.fetch=async()=>Response.json({status:'committed',patchId:pending.attempt!.patchId,baseRevision:4,revision:5,rootHash:root,dirtyNodeIds:nodes})
   await saveBlankBatch(session,source,current,new AbortController().signal,inspect);assert.equal((await reopened.list()).length,0)
  }finally{reopened.close();other.close()}
 }finally{globalThis.fetch=old;journal.close()}
})
test('cancelled batch imports cannot publish an uncommitted recovery copy',async()=>{
 const factory=new IDBFactory(),journal=await WorkbookBlankBatchJournal.open(session,source,'https://owned.test/',factory),state:BlankBatchState={input,attempt:null}
 try{
  const already=new AbortController();already.abort();await assert.rejects(journal.import(state,already.signal));assert.deepEqual(await journal.list(),[])
  const pending=new AbortController(),importing=journal.import(state,pending.signal);pending.abort();await assert.rejects(importing);assert.deepEqual(await journal.list(),[])
  const completed=new AbortController(),id=await journal.import(state,completed.signal);completed.abort();assert.equal((await journal.list())[0].id,id)
 }finally{journal.close()}
})
test('portable batch backup preserves the exact pending request and rejects mismatched identity or document',async()=>{
 const factory=new IDBFactory(),journal=await WorkbookBlankBatchJournal.open(session,source,'https://owned.test/',factory),old=globalThis.fetch
 try{
  const id=await journal.stage(input);globalThis.fetch=async()=>{throw Error('response lost')}
  await assert.rejects(saveBlankBatch(session,source,journal.branch(id),new AbortController().signal,inspect),/response lost/)
  const state=(await journal.branch(id).read())!,raw=serializeBlankBatchBackup(state,session,source,'https://owned.test/')
  assert.ok(!raw.includes('secret'));assert.deepEqual(parseBlankBatchBackup(raw,session,source,'https://owned.test/'),state)
  assert.throws(()=>parseBlankBatchBackup(raw,{...session,userId:'bob'},source,'https://owned.test/'))
  assert.throws(()=>parseBlankBatchBackup(raw,session,'f'.repeat(64),'https://owned.test/'))
  assert.throws(()=>parseBlankBatchBackup(raw,{...session,apiUrl:'https://other.test/v1/documents'},source,'https://owned.test/'))
  const imported=await journal.import(parseBlankBatchBackup(raw,session,source,'https://owned.test/'));assert.equal(imported,id);assert.equal((await journal.list()).length,1)
  const altered=structuredClone(state);altered.input.cells[0].text='changed';assert.throws(()=>serializeBlankBatchBackup(altered,session,source,'https://owned.test/'))
 }finally{globalThis.fetch=old;journal.close()}
})
