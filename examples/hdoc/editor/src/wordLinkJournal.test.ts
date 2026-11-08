import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {createHmac} from 'node:crypto'
import * as Y from 'yjs'
import {prepareLinkCapsule,promoteLinkCapsule} from './wordLinkJournalState.ts'
import {readWordPendingLink,verifyWordLinkReceipt} from './wordLinkProof.ts'
import {WordRegionStore,wordRegionSchema,verifyWordLinkReceipt as verifyProjection} from './wordRegionStore.ts'
import {wordLinkFixture,linkId} from './wordLinkTestFixture.ts'

test('link preparation has exact fields and cannot be manufactured through ordinary save',async()=>{
 const f=await wordLinkFixture();try{
  const saved=(await f.journal.load())!;await assert.rejects(f.journal.save(prepareLinkCapsule(saved.capsule,f.pending),saved.hash),/transition-invalid/)
  for(const value of [{...f.pending,extra:true},{...f.pending,actor:{...f.pending.actor,userId:'bob'}},{...f.pending,request:{...f.pending.request,link:{...f.pending.request.link,variant:'body'}}}])assert.throws(()=>readWordPendingLink(value,'doc'))
  const prepared=await f.journal.prepareLink(f.pending,saved.hash,()=>{});assert.equal(prepared.capsule.version,5);assert.deepEqual((await f.reopen().load())?.capsule.pendingLink,f.pending);await assert.rejects(f.reopen(false).load(),/journal-invalid/)
  const changed=structuredClone(prepared.capsule);changed.pendingLink!.request.transactionId='a'.repeat(32);await assert.rejects(f.journal.save(changed,prepared.tip),/transition-invalid/)
 }finally{await f.close()}
})
test('native proof binds the full request, contributor, journal tip and initial Yjs bytes',async()=>{
 const f=await wordLinkFixture();try{
  const update=Y.encodeStateAsUpdate(f.document),receipt=f.sign(update,f.tip),verify=(p:any=receipt,r:any=f.record,u=update)=>verifyWordLinkReceipt(f.journal.scope,f.secret,r,f.pending,p,f.tip,u)
  assert.equal(verify(),true)
  for(const [key,value] of Object.entries({reviewHash:'0'.repeat(64),pendingHash:'0'.repeat(64),journalHash:'0'.repeat(64),epoch:2,rootHash:'0'.repeat(64),layoutHash:'0'.repeat(64),signature:'a'.repeat(43)}))assert.equal(verify({...receipt,[key]:value}),false,key)
  assert.equal(verify({...receipt,extra:true}),false);assert.equal(verify(receipt,{...f.record,patchHash:'0'.repeat(64)}),false);assert.equal(verify(receipt,{...f.record,wordLayoutChange:false}),false);assert.equal(verify(receipt,f.record,Uint8Array.of(0)),false)
 }finally{await f.close()}
})
test('projection proof and staged link change preserve every existing region and user undo history',async()=>{
 const f=await wordLinkFixture();try{
  const changed=structuredClone(f.next);changed.blocks[0].content.inlines[0].text='Injected';assert.throws(()=>verifyProjection(f.previous,changed,f.pending.request),/ReceiptChanged/)
  f.edit(1,'Private draft');const before=f.model.capture(),undo=f.model.structure.undoManager();f.model.acceptLinkFields(f.previous.flowLayoutHash,f.next.flowLayout,f.next.flowLayoutHash,f.pending.request)
  assert.deepEqual(f.model.capture(),{...before,layoutHash:f.next.flowLayoutHash});assert.equal(undo.undoStack.length,0);assert.equal(f.model.project(linkId(5)).textContent,'Region 5');undo.destroy()
 }finally{await f.close()}
})
test('acknowledgement signs an isolated metadata change, preserves drafts and promotes only through the dedicated path',async()=>{
 const f=await wordLinkFixture();try{
  f.edit(1,'Unrelated body draft');await f.saveDraft();const original=Y.encodeStateAsUpdate(f.document),prepared=await f.journal.prepareLink(f.pending,f.tip,()=>{})
  const ack=await f.journal.acknowledgeLink(f.record,{revision:1,rootHash:f.base.rootHash},f.previous,f.next,prepared.tip,()=>{},async update=>f.sign(update,prepared.tip))
  assert.equal(ack.capsule.version,5);assert.deepEqual(ack.capsule.actors,prepared.capsule.actors);assert.deepEqual(Y.encodeStateAsUpdate(f.document),original)
  const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(ack.capsule.document,'base64'));const model=new WordRegionStore(doc,wordRegionSchema(),'doc',f.next.flowLayout,f.next.flowLayoutHash);assert.equal(model.project(linkId(1)).textContent,'Unrelated body draft');assert.equal(model.project(linkId(5)).textContent,'Region 5')}finally{doc.destroy()}
  const resumed=f.reopen();assert.equal((await resumed.load())?.hash,ack.tip);await assert.rejects(resumed.save(promoteLinkCapsule(ack.capsule),ack.tip),/transition-invalid/)
  const promoted=await resumed.promoteLinkAcknowledgement(ack.tip,()=>{});assert.equal(promoted.capsule.version,3);assert.equal((await f.reopen().load())?.hash,promoted.tip)
  await assert.rejects(resumed.abandonUnpreparedTopology(f.pending.request.transactionId,()=>{}),/already-prepared/)
 }finally{await f.close()}
})
test('missing native proof, corrupted content and late owner loss retain the exact prepared request',async()=>{
 for(const mode of ['network','signature','content','owner']){const f=await wordLinkFixture();try{
  const prepared=await f.journal.prepareLink(f.pending,f.tip,()=>{}),next=structuredClone(f.next);if(mode==='content')next.blocks[0].content.inlines[0].text='Changed'
  let owner=true;await assert.rejects(f.journal.acknowledgeLink(f.record,{revision:1,rootHash:f.base.rootHash},f.previous,next,prepared.tip,()=>{if(!owner)throw Error('owner lost')},async update=>{if(mode==='network')throw Error('lost response');if(mode==='owner')owner=false;const value=f.sign(update,prepared.tip);if(mode==='signature')value.signature='a'.repeat(43);return value}))
  assert.deepEqual((await f.reopen().load())?.capsule.pendingLink,f.pending)
 }finally{await f.close()}}
})
test('competing journal owners cannot overwrite a durable link identity',async()=>{
 const f=await wordLinkFixture();try{
  const other=f.reopen();await other.load();const changed=structuredClone(f.pending);changed.request.transactionId='a'.repeat(32)
  const results=await Promise.allSettled([f.journal.prepareLink(f.pending,f.tip,()=>{}),other.prepareLink(changed,f.tip,()=>{})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const saved=await f.reopen().load();assert.ok(['a'.repeat(32),'d'.repeat(32)].includes(saved!.capsule.pendingLink!.request.transactionId))
 }finally{await f.close()}
})
test('rewritten acknowledgement bytes cannot reuse a native signature even when the local chain envelope is signed',async()=>{
 const f=await wordLinkFixture();try{
  const prepared=await f.journal.prepareLink(f.pending,f.tip,()=>{});await f.journal.acknowledgeLink(f.record,{revision:1,rootHash:f.base.rootHash},f.previous,f.next,prepared.tip,()=>{},async update=>f.sign(update,prepared.tip))
  const path=join(f.journal.directory,prepared.tip+'.next'),envelope=JSON.parse(gunzipSync(await readFile(path)).toString()),capsule=JSON.parse(envelope.payload);capsule.linkAcknowledgement.pending.reviewHash='0'.repeat(64);envelope.payload=JSON.stringify(capsule);envelope.signature=createHmac('sha256',f.secret).update(prepared.tip+'\0'+envelope.payload).digest('hex');await writeFile(path,gzipSync(JSON.stringify(envelope)))
  await assert.rejects(f.reopen().load(),/journal-invalid/)
 }finally{await f.close()}
})
