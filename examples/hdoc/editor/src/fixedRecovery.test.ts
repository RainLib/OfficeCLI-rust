import {createHash} from 'node:crypto'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedDraftJournal,fixedDraftDatabase,validateFixedDraft,serializeFixedDraft,parseFixedDraftBackup,fixedDraftBackupLimit} from './fixedDraftJournal.ts'
import {FixedSaveController,type FixedDraftState} from './fixedSaveController.ts'
import {fixedEditPatch} from './saveEdits.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore,type PositionedImage} from './imageDrafts.ts'
import type {Session} from './api.ts'

const session:Session={documentId:'doc',userId:'alice',token:'never-cache-token',apiUrl:'http://test/v1/documents',collabUrl:'ws://test/collab',scope:'write',format:'pptx'}
const before='1'.repeat(64),after=createHash('sha256').update('Saved 中文😀').digest('hex'),replacement='a'.repeat(64),later='b'.repeat(64)
const image:PositionedImage={nodeId:'picture',visualHash:before,assetHash:'3'.repeat(64),geometry:{x:1,y:2,width:30,height:40,unit:'pt'}}
const run={nodeId:'text',nodeHash:before,text:'Original 中文😀'}
function stores(){const texts=new TextDraftStore(),images=new ImageDraftStore();texts.edit(run,1,'Saved 中文😀',4);const upload=images.prepareReplacement(image,1,4);upload.commit(replacement);upload.finish();return{texts,images}}
function state():FixedDraftState{const{texts,images}=stores();return{version:3,texts:texts.entries(),images:images.entries(),attempt:null}}
const receipt=(id:string)=>({status:'committed',patchId:id,revision:2,nodeHashes:{text:after},images:[{...image,assetHash:replacement,visualHash:after}]})

test('fixed device scopes isolate sources, users and endpoints while token/semantic epoch rotation is stable',async()=>{
 const key=await fixedDraftDatabase(session,'alice',before,'http://editor.test')
 assert.doesNotMatch(key,/alice|doc|never-cache-token/)
 assert.equal(await fixedDraftDatabase({...session,token:'rotated',collaborationEpoch:9},'alice',before,'http://editor.test'),key)
 for(const[other,user,source]of [[session,'bob',before],[session,'alice',after],[{...session,documentId:'other'},'alice',before],[{...session,apiUrl:'http://other/v1'},'alice',before]] as const)assert.notEqual(await fixedDraftDatabase(other,user,source,'http://editor.test'),key)
})
test('portable backup checks document, source, account and service without losing a pending request',async()=>{
 const value=state(),attempt={id:'edits-123',baseRevision:1,texts:value.texts,images:value.images};value.attempt=attempt
 const raw=serializeFixedDraft(session,value,before,'https://editor.test/')
 assert.doesNotMatch(raw,/never-cache-token/);assert.deepEqual(parseFixedDraftBackup(raw,{...session,token:'rotated'},before,'https://editor.test/').attempt,attempt)
 for(const modified of [{...session,userId:'bob'},{...session,documentId:'different'},{...session,format:'xlsx'},{...session,apiUrl:'http://other/v1/documents'}])assert.throws(()=>parseFixedDraftBackup(raw,modified,before,'https://editor.test/'))
 assert.throws(()=>parseFixedDraftBackup(raw,session,after,'https://editor.test/'))
 const old=JSON.parse(raw);old.schemaVersion='hcd-fixed-recovery/1';delete old.owner;delete old.service
 assert.throws(()=>parseFixedDraftBackup(JSON.stringify(old),session,before,'https://editor.test/'))
 old.state.attempt=null;assert.equal(parseFixedDraftBackup(JSON.stringify(old),session,before,'https://editor.test/').texts[0][1].text,'Saved 中文😀')
 assert.throws(()=>parseFixedDraftBackup('{',session,before,'https://editor.test/'))
 assert.throws(()=>parseFixedDraftBackup('x'.repeat(fixedDraftBackupLimit+1),session,before,'https://editor.test/'))
 const journal=await FixedDraftJournal.open('portable-import',new IDBFactory());try{await journal.write(parseFixedDraftBackup(raw,session,before,'https://editor.test/'));await journal.flush();assert.equal((await journal.copies())[0].state.attempt?.id,'edits-123')}finally{journal.close()}
})

test('separate window journals retain all branches and clear only their own empty state',async()=>{
 const factory=new IDBFactory(),a=await FixedDraftJournal.open('fixed-test',factory),b=await FixedDraftJournal.open('fixed-test',factory)
 try{
  const left=state(),right=state();right.texts[0][1].text='Another window'
  await Promise.all([a.write(left),b.write(right)])
  assert.equal((await a.copies()).length,2)
  const restored=await FixedDraftJournal.open('fixed-test',factory)
  try{
   await restored.write(left);await restored.retain(a.branch)
   assert.equal((await restored.copies()).find(copy=>copy.id===a.branch)?.retained,true)
   assert.equal((await restored.copies()).find(copy=>copy.id===b.branch)?.state.texts[0][1].text,'Another window')
   await restored.write({version:3,texts:[],images:[],attempt:null})
   assert.equal((await a.copies()).length,2)
  }finally{restored.close()}
 }finally{a.close();b.close()}
})

test('invalid or oversized snapshots preserve the earlier copy; a complete successful snapshot can recover storage status',async()=>{
 const journal=await FixedDraftJournal.open('fixed-limits',new IDBFactory()),saved=state()
 try{
  await journal.write(saved)
  const oversized=state();oversized.texts[0][1].text='x'.repeat(9*1024*1024)
  await assert.rejects(journal.write(oversized),/backup/i);assert.equal(journal.state,'failed');await assert.rejects(journal.flush())
  assert.equal(JSON.parse(serializeFixedDraft(session,oversized,before)).state.texts[0][1].text.length,9*1024*1024)
  assert.equal((await journal.copies())[0].state.texts[0][1].text,saved.texts[0][1].text)
  const invalid=state();invalid.images[0][1].geometry.width=NaN
  await journal.write(invalid);assert.equal(journal.state,'stored');assert.ok(Number.isNaN((await journal.copies())[0].state.images[0][1].geometry.width))
  assert.throws(()=>validateFixedDraft({...saved,attempt:{id:'edits-bad',baseRevision:1,texts:[],images:[]}}),/Invalid/)
  const hostile=state();(hostile.images[0][1].base as any).preview='https://private.example/token'
  ;(hostile.images[0][1].base as any).token='credential-only'
  assert.doesNotMatch(JSON.stringify(validateFixedDraft(hostile)),/private|token/)
  const downloaded=serializeFixedDraft(session,hostile,before)
  assert.doesNotMatch(downloaded,/private|credential-only|never-cache-token/)
  assert.equal(JSON.parse(downloaded).source.sha256,before)
 }finally{journal.close()}
})

test('a live reviewed branch stays retained on remote refresh, while genuinely new local input becomes discoverable',async()=>{
 const journal=await FixedDraftJournal.open('fixed-retained-refresh',new IDBFactory())
 try{
  const saved=state();await journal.write(saved);await journal.retain(journal.branch)
  const refreshed=structuredClone(saved);refreshed.texts[0][1].remote={...run,text:'Peer newer',nodeHash:'9'.repeat(64)};refreshed.texts[0][1].stale='refresh';refreshed.images[0][1].observedRevision=9;refreshed.images[0][1].remote={image:{...image,visualHash:'9'.repeat(64)},revision:9}
  await journal.write(refreshed);assert.equal((await journal.copies())[0].retained,true)
  refreshed.texts[0][1].text='New local input after review';await journal.write(refreshed);assert.equal((await journal.copies())[0].retained,false)
  await journal.retain(journal.branch);refreshed.images[0][1].geometry.width+=1;await journal.write(refreshed);assert.equal((await journal.copies())[0].retained,false)
 }finally{journal.close()}
})
test('review markers survive a legacy branch rewrite and cannot hide new input arriving after comparison',async()=>{
 const factory=new IDBFactory(),journal=await FixedDraftJournal.open('fixed-independent-review',factory),saved=state()
 try{
  await journal.write(saved);await journal.retain(journal.branch,saved)
  const opening=factory.open('fixed-independent-review',2),legacy=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
  try{
   const tx=legacy.transaction('branches','readwrite');tx.objectStore('branches').put({id:journal.branch,updatedAt:Date.now(),state:saved},journal.branch);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)})
  }finally{legacy.close()}
  assert.equal((await journal.copies())[0].retained,true)
  const newer=structuredClone(saved);newer.texts[0][1].text='New input during comparison';await journal.write(newer)
  await journal.retain(journal.branch,saved);assert.equal((await journal.copies())[0].retained,false)
 }finally{journal.close()}
})
test('asynchronous intent hashing preserves write order and flush waits for the last durable snapshot',async()=>{
 const journal=await FixedDraftJournal.open('fixed-ordered-review',new IDBFactory()),original=crypto.subtle.digest.bind(crypto.subtle)
 let release!:()=>void,reached!:()=>void,calls=0,flushed=false
 const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{reached=resolve})
 crypto.subtle.digest=async(...args)=>{if(++calls===1){reached();await gate};return original(...args)}
 try{
  const first=state(),second=state();second.texts[0][1].text='Latest complete snapshot'
  const a=journal.write(first),b=journal.write(second),flush=journal.flush().then(()=>{flushed=true})
  second.texts[0][1].text='Caller mutated after enqueue'
  await entered;assert.equal(flushed,false);release();await Promise.all([a,b,flush])
  assert.equal((await journal.copies())[0].state.texts[0][1].text,'Latest complete snapshot');assert.equal(flushed,true)
 }finally{release();crypto.subtle.digest=original;journal.close()}
})
test('snapshot storage upgrades v1 branches without losing content and fences old version writers',async()=>{
 const factory=new IDBFactory(),opening=factory.open('fixed-upgrade',1)
 opening.onupgradeneeded=()=>opening.result.createObjectStore('branches')
 const legacy=await new Promise<IDBDatabase>((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
 const tx=legacy.transaction('branches','readwrite');tx.objectStore('branches').put({id:'old-window',updatedAt:1,state:state(),retained:true},'old-window');await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});legacy.close()
 const journal=await FixedDraftJournal.open('fixed-upgrade',factory)
 try{
  const copies=await journal.copies();assert.equal(copies[0].retained,true);assert.equal(copies[0].state.texts[0][1].text,state().texts[0][1].text)
  const older=factory.open('fixed-upgrade',1);await assert.rejects(new Promise((resolve,reject)=>{older.onsuccess=()=>{older.result.close();resolve(null)};older.onerror=()=>reject(older.error)}),/version/i)
 }finally{journal.close()}
})

test('the exact attempt is durable before submission; a lost response resolves without a second write',async()=>{
 const{texts,images}=stores(),journal=await FixedDraftJournal.open('fixed-commit',new IDBFactory())
 const controller=new FixedSaveController(session,texts,images,journal),original=globalThis.fetch,paths:string[]=[]
 await controller.connect()
 globalThis.fetch=async(url,init)=>{
  paths.push(String(url));const patch=JSON.parse(String(init?.body)),copies=await journal.copies()
  assert.equal(copies[0].state.attempt?.id,patch.patchId)
  if(String(url).endsWith('/receipt'))return Response.json(receipt(patch.patchId))
  throw new Error('Response lost after commit')
 }
 try{
  assert.equal(await controller.save(1),2);assert.deepEqual(paths.map(path=>path.endsWith('/receipt')), [false,true])
  assert.equal(controller.pending,false);assert.equal(texts.size,0);assert.equal(images.size,0)
  await journal.flush();assert.equal((await journal.copies()).length,0)
 }finally{controller.dispose();journal.close();globalThis.fetch=original}
})

test('unknown attempts reopen with later input and query the original receipt before any new write',async()=>{
 const factory=new IDBFactory(),journal=await FixedDraftJournal.open('fixed-restart',factory),{texts,images}=stores()
 const original=globalThis.fetch,controller=new FixedSaveController(session,texts,images,journal)
 await controller.connect();let exact=''
 globalThis.fetch=async(url,init)=>{if(!String(url).endsWith('/receipt'))exact=String(init?.body);throw new Error('offline')}
 try{
  await assert.rejects(controller.save(1),/fixedSaveUnknown/);assert.equal(controller.pending,true)
  texts.edit(run,1,'Newer input 中文😀')
  const upload=images.prepareReplacement(image,1);upload.commit(later);upload.finish()
  await journal.flush();const saved=(await journal.copies())[0].state
  assert.equal(JSON.stringify(fixedEditPatch(session,saved.attempt!)),exact)
  controller.dispose()
  const reopened=await FixedDraftJournal.open('fixed-restart',factory),nextText=new TextDraftStore(),nextImages=new ImageDraftStore()
  nextText.restore(saved.texts);nextImages.restore(saved.images)
  const next=new FixedSaveController({...session,token:'rotated'},nextText,nextImages,reopened,saved.attempt)
  try{
   await next.connect();let queries=0
   globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('/receipt'));assert.equal(String(init?.body),exact);queries++;return Response.json(receipt(saved.attempt!.id))}
   assert.equal(await next.save(9),2);assert.equal(queries,1)
   assert.equal(nextText.get('text')?.text,'Newer input 中文😀');assert.equal(nextText.get('text')?.base.nodeHash,after)
   assert.equal(nextImages.get('picture')?.assetHash,later);assert.equal(nextImages.get('picture')?.base.assetHash,replacement)
   assert.equal(nextImages.saving,false);assert.equal(next.pending,false)
   assert.equal((await reopened.copies()).find(copy=>copy.id===reopened.branch)?.state.attempt,null)
  }finally{next.dispose();reopened.close()}
 }finally{controller.dispose();journal.close();globalThis.fetch=original}
})

test('checking an unknown receipt preserves unfinished workbook input and never resends',async()=>{
 const workbook={...session,format:'xlsx'},texts=new TextDraftStore(),images=new ImageDraftStore(),journal=await FixedDraftJournal.open('workbook-receipt-buffer',new IDBFactory()),controller=new FixedSaveController(workbook,texts,images,journal),old=globalThis.fetch
 texts.edit(run,1,'Saved 中文😀');await controller.connect()
 try{
  globalThis.fetch=async()=>{throw new Error('offline')}
  await assert.rejects(controller.save(1),/fixedSaveUnknown/);const sent=controller.state().attempt!
  const buffer={base:run,revision:1,initial:'Saved 中文😀',text:'Later unfinished input',sheetId:'s',row:0,column:0};controller.setWorkbookBuffer(buffer)
  let queries=0;globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('/receipt'));assert.equal(JSON.parse(String(init?.body)).patchId,sent.id);queries++;return Response.json({status:'missing',patchId:sent.id})}
  assert.equal(await controller.checkPendingReceipt(),null);assert.equal(controller.pending,true);assert.equal(controller.workbookBuffer?.text,buffer.text);assert.equal(texts.get(run.nodeId)?.text,'Saved 中文😀')
  globalThis.fetch=async(url,init)=>{assert.ok(String(url).endsWith('/receipt'));assert.equal(JSON.parse(String(init?.body)).patchId,sent.id);queries++;return Response.json({status:'committed',patchId:sent.id,revision:2,nodeHashes:{text:after},images:[]})}
  assert.equal(await controller.checkPendingReceipt(),2);assert.equal(queries,2);assert.equal(controller.pending,false);assert.equal(controller.workbookBuffer?.text,buffer.text);assert.equal(texts.size,0)
  await controller.flush();const durable=(await journal.copies())[0].state;assert.equal(durable.attempt,null);assert.equal(durable.workbookBuffer?.text,buffer.text)
  await assert.rejects(controller.save(2),/workbookInputPending/)
 }finally{controller.dispose();journal.close();globalThis.fetch=old}
})

test('a missing receipt resends the exact original request even after the visible revision advances',async()=>{
 const{texts,images}=stores(),initial=new FixedSaveController(session,texts,images),original=globalThis.fetch
 globalThis.fetch=async()=>{throw new Error('offline')}
 try{
  await assert.rejects(initial.save(1),/fixedSaveUnknown/);const saved=initial.state();initial.dispose()
  const nextText=new TextDraftStore(),nextImages=new ImageDraftStore();nextText.restore(saved.texts);nextImages.restore(saved.images)
  const next=new FixedSaveController(session,nextText,nextImages,null,saved.attempt);let queries=0,writes=0
  try{
   globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.patchId,saved.attempt!.id);assert.equal(body.baseRevision,1)
    if(String(url).endsWith('/receipt')){queries++;return Response.json({status:'missing',patchId:body.patchId})}
    writes++;return new Response('head advanced',{status:409})
   }
   await assert.rejects(next.save(8),/409/);assert.equal(queries,2);assert.equal(writes,1)
   assert.equal(next.pending,false);assert.equal(nextText.size,1);assert.equal(nextImages.size,1);assert.equal(nextImages.saving,false)
  }finally{next.dispose()}
 }finally{initial.dispose();globalThis.fetch=original}
})

test('an unavailable journal prevents an unrecorded new request and keeps both draft subsets',async()=>{
 const{texts,images}=stores(),controller=new FixedSaveController(session,texts,images,{write:async()=>{throw new Error('quota')},flush:async()=>{}}),original=globalThis.fetch
 globalThis.fetch=async()=>{throw new Error('must not submit without durable intent')}
 try{
  await assert.rejects(controller.save(1),/quota/);assert.equal(controller.pending,false);assert.equal(texts.size,1);assert.equal(images.size,1);assert.equal(images.saving,false)
  controller.continueWithoutBackup()
  globalThis.fetch=async(_url,init)=>Response.json(receipt(JSON.parse(String(init?.body)).patchId))
  assert.equal(await controller.save(1),2);assert.equal(texts.size,0);assert.equal(images.size,0)
 }
 finally{controller.dispose();globalThis.fetch=original}
})

test('immutable receipts never clear a later remote edit or deletion',async()=>{
 const{texts,images}=stores(),controller=new FixedSaveController(session,texts,images),original=globalThis.fetch
 globalThis.fetch=async()=>{throw new Error('offline')}
 try{
  await assert.rejects(controller.save(1),/fixedSaveUnknown/)
  texts.reconcile([{...run,text:'Peer update',nodeHash:'4'.repeat(64)}],3);images.markDeleted('picture',3)
  const id=controller.state().attempt!.id
  globalThis.fetch=async()=>Response.json(receipt(id))
  await controller.save(3)
  assert.equal(texts.get('text')?.remote?.text,'Peer update');assert.equal(images.get('picture')?.deleted,true)
 }finally{controller.dispose();globalThis.fetch=original}
})

test('a receipt with the wrong text digest cannot clear either half of a joint save',async()=>{
 const{texts,images}=stores(),controller=new FixedSaveController(session,texts,images),original=globalThis.fetch
 globalThis.fetch=async(_url,init)=>{const patch=JSON.parse(String(init?.body));return Response.json({...receipt(patch.patchId),nodeHashes:{text:'f'.repeat(64)}})}
 try{await assert.rejects(controller.save(1),/fixedSaveUnknown/);assert.equal(texts.size,1);assert.equal(images.size,1);assert.equal(controller.pending,true)}
 finally{controller.dispose();globalThis.fetch=original}
})


test('fixed backup v3 preserves source-image restoration and safely migrates legacy v1 copies',()=>{
 const saved=state();saved.images[0][1].assetHash=undefined;saved.images[0][1].restoreSource=true
 const recovered=validateFixedDraft(saved)
 assert.equal(recovered.version,3);assert.equal(recovered.images[0][1].restoreSource,true)
 assert.throws(()=>validateFixedDraft({...saved,version:1}),/Invalid/)
 assert.equal(validateFixedDraft({...state(),version:1}).version,3)
 const wrong=state();wrong.images[0][1].restoreSource=true
 assert.throws(()=>validateFixedDraft(wrong),/Invalid/)
})
test('portable branches import once and never replace a reviewed or changed branch',async()=>{
 const journal=await FixedDraftJournal.open('portable-stable-branch',new IDBFactory()),saved=state(),id='e'.repeat(64)
 try{assert.equal(await journal.importCopy(id,saved),true);assert.equal(await journal.importCopy(id,saved),false);await journal.retain(`portable-${id}`,saved);assert.equal(await journal.importCopy(id,saved),false);assert.equal((await journal.copies())[0].retained,true);const other=structuredClone(saved);other.texts[0][1].text='different';await assert.rejects(journal.importCopy(id,other),/changed/);assert.equal((await journal.copies())[0].state.texts[0][1].text,saved.texts[0][1].text)}finally{journal.close()}
})
test('workbook backup refuses unsupported image drafts and interrupted image uploads',()=>{
 const workbook={...session,format:'xlsx'},imageState=state(),raw=serializeFixedDraft(workbook,imageState,before,'https://editor.test/')
 assert.throws(()=>parseFixedDraftBackup(raw,workbook,before,'https://editor.test/'))
 const interrupted:FixedDraftState={version:3,texts:[],images:[],attempt:null,uploadInterrupted:true}
 assert.throws(()=>parseFixedDraftBackup(serializeFixedDraft(workbook,interrupted,before,'https://editor.test/'),workbook,before,'https://editor.test/'))
})

test('a near-limit Excel journal remains importable when backup metadata crosses 8 MiB',async()=>{
 const workbook={...session,format:'xlsx'},value:FixedDraftState={version:3,texts:[],images:[],attempt:null}
 for(let i=0;i<10;i++){const id=`cell-${i}`;value.texts.push([id,{base:{nodeId:id,nodeHash:before,text:''},revision:1,text:i<9?'x'.repeat(900000):''}])}
 const target=8*1024*1024-40,baseSize=new TextEncoder().encode(JSON.stringify(value)).length
 value.texts[9][1].text='x'.repeat(target-baseSize)
 const factory=new IDBFactory(),original=await FixedDraftJournal.open('boundary-original',factory),imported=await FixedDraftJournal.open('boundary-import',factory)
 try{
  await original.write(value);await original.flush()
  const raw=serializeFixedDraft(workbook,value,before,'https://editor.test/')
  assert.ok(new TextEncoder().encode(raw).length>8*1024*1024)
  await imported.write(parseFixedDraftBackup(raw,workbook,before,'https://editor.test/'));await imported.flush()
  assert.equal((await imported.copies())[0].state.texts[9][1].text,value.texts[9][1].text)
 }finally{original.close();imported.close()}
})
test('standalone backup reimport deduplicates across windows and preserves review decisions',async()=>{
 const factory=new IDBFactory(),one=await FixedDraftJournal.open('standalone-import',factory),two=await FixedDraftJournal.open('standalone-import',factory),saved=state()
 try{
  const results=await Promise.all([one.importBackupCopy(saved),two.importBackupCopy(structuredClone(saved))]);assert.deepEqual(results.sort(),[false,true])
  const first=(await one.copies())[0];assert.equal((await one.copies()).length,1)
  await one.retain(first.id,first.state);assert.equal(await two.importBackupCopy(saved),false)
  assert.equal((await two.copies())[0].retained,true)
  const changed=structuredClone(saved);changed.texts[0][1].text='Newer separate intent'
  assert.equal(await two.importBackupCopy(changed),true);const copies=await one.copies();assert.equal(copies.length,2);assert.equal(copies.find(copy=>copy.id===first.id)?.retained,true)
  assert.equal(await two.importBackupCopy(saved,true),true);const reopened=await one.copies();assert.equal(reopened.length,2);assert.equal(reopened.find(copy=>copy.id===first.id)?.retained,false);assert.equal(reopened.find(copy=>copy.id===first.id)?.state.texts[0][1].text,saved.texts[0][1].text)
 }finally{one.close();two.close()}
})
test('a stale concurrent review cannot hide an explicitly reopened backup',async()=>{
 const factory=new IDBFactory(),review=await FixedDraftJournal.open('fixed-reopen-race',factory),reopen=await FixedDraftJournal.open('fixed-reopen-race',factory),saved=state(),original=crypto.subtle.digest.bind(crypto.subtle)
 let release!:()=>void,reached!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{reached=resolve})
 try{
  await review.importBackupCopy(saved);const first=(await review.copies())[0]
  crypto.subtle.digest=async(...args)=>{if(++calls===1){reached();await gate}return original(...args)}
  const delayed=review.retain(first.id,first.state,first.reviewGeneration);await entered
  await reopen.importBackupCopy(saved,true);release();await delayed
  let latest=(await reopen.copies())[0];assert.equal(latest.retained,false);assert.notEqual(latest.reviewGeneration,first.reviewGeneration)
  await review.retain(first.id,first.state,first.reviewGeneration);latest=(await reopen.copies())[0];assert.equal(latest.retained,false)
  await reopen.retain(latest.id,latest.state,latest.reviewGeneration);assert.equal((await review.copies())[0].retained,true)
 }finally{release();crypto.subtle.digest=original;review.close();reopen.close()}
})
test('closing a session during backup hashing cannot create or reopen a branch',async()=>{
 const journal=await FixedDraftJournal.open('fixed-import-abort',new IDBFactory()),original=crypto.subtle.digest.bind(crypto.subtle),saved=state()
 let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{reached=resolve}),controller=new AbortController()
 try{
  crypto.subtle.digest=async(...args)=>{reached();await gate;return original(...args)}
  const operation=journal.importBackupCopy(saved,false,controller.signal);await entered;controller.abort(new Error('session closed'));release();await assert.rejects(operation,/session closed/);assert.equal((await journal.copies()).length,0)
  crypto.subtle.digest=original;await journal.importBackupCopy(saved);const first=(await journal.copies())[0];await journal.retain(first.id,first.state,first.reviewGeneration)
  controller.abort();await assert.rejects(journal.importBackupCopy(saved,true,controller.signal),/session closed/);assert.equal((await journal.copies())[0].retained,true)
 }finally{release();crypto.subtle.digest=original;journal.close()}
})
