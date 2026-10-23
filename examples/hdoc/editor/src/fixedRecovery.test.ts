import {createHash} from 'node:crypto'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {FixedDraftJournal,fixedDraftDatabase,validateFixedDraft,serializeFixedDraft} from './fixedDraftJournal.ts'
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
