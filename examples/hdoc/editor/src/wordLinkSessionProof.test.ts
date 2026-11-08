import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {wordLinkFixture,linkId} from './wordLinkTestFixture.ts'
import {WordRegionStore,wordRegionSchema} from './wordRegionStore.ts'
import {prepareWordLinkSessionProof} from './wordLinkSessionProof.ts'
import {bridgeWordSession} from './wordSessionBridge.ts'
import {readWordLinkSessionProof} from './wordBrowserProjection.ts'

test('an exact native link proof retains the view and own history without seeding the new transport',async()=>{
 const f=await wordLinkFixture(),wire=new Y.Doc(),manager=f.model.structure.undoManager();let updates=0
 try{
  manager.stopCapturing();f.edit(1,'Region 1 own');manager.stopCapturing();Y.applyUpdate(wire,Y.encodeStateAsUpdate(f.document))
  const next=new WordRegionStore(wire,wordRegionSchema(),'doc',f.previous.flowLayout,f.previous.flowLayoutHash);next.acceptLinkFields(f.previous.flowLayoutHash,f.next.flowLayout,f.next.flowLayoutHash,f.pending.request)
  const proof=await prepareWordLinkSessionProof(f.pending.request.transactionId,f.previous,f.next,f.record),before=Y.encodeStateAsUpdate(wire),clientId=f.document.clientID
  wire.on('update',()=>updates++);const bridge=bridgeWordSession({view:f.model,wire:next,linkProof:proof,assertFresh:()=>{},detachPreviousTransport:()=>{}})
  try{
   assert.deepEqual(Y.encodeStateAsUpdate(wire),before);assert.equal(updates,0);assert.equal(bridge.model.document.clientID,clientId);assert.equal(bridge.model.layoutState().layout.sections[1].headers.default,undefined);assert.equal(bridge.model.project(linkId(5)).textContent,'Region 5')
   const blocks=next.region(linkId(1)),node=blocks[0].node;next.reconcile(linkId(1),blocks,[{key:blocks[0].key,node:node.type.createChecked(node.attrs,next.schema.text(node.textContent+' peer',node.firstChild?.marks))}])
   assert.ok(manager.undo());assert.equal(next.project(linkId(1)).textContent,'Region 1 peer');assert.equal(next.layoutState().layout.sections[1].headers.default,undefined)
   assert.ok(manager.redo());assert.equal(next.project(linkId(1)).textContent,'Region 1 own peer');assert.equal(bridge.closed,false)
  }finally{bridge.dispose()}
 }finally{manager.destroy();wire.destroy();await f.close()}
})
test('link proof rejects a different nonce, record, actor or native content; plain JSON is not a minted proof',async()=>{
 const f=await wordLinkFixture();try{
  for(const mutate of [(v:any)=>{v.record.patchId='word-story-link-'+'0'.repeat(32)},(v:any)=>{v.record.patchHash='0'.repeat(64)},(v:any)=>{v.record.authorId='bob'},(v:any)=>{v.record.parentRevision=0},(v:any)=>{v.record.layoutUpgrade=true},(v:any)=>{v.receipt.blocks[0].content.inlines[0].text='Unreviewed native text'},(v:any)=>{delete v.receipt.flowLayout.sections[0].headers.default}]){
   const input={record:structuredClone(f.record),receipt:structuredClone(f.next)};mutate(input);await assert.rejects(prepareWordLinkSessionProof(f.pending.request.transactionId,f.previous,input.receipt,input.record))
  }
  const proof=await prepareWordLinkSessionProof(f.pending.request.transactionId,f.previous,f.next,f.record),wire=new Y.Doc();let retired=false
  try{Y.applyUpdate(wire,Y.encodeStateAsUpdate(f.document));const next=new WordRegionStore(wire,wordRegionSchema(),'doc',f.previous.flowLayout,f.previous.flowLayoutHash);next.acceptLinkFields(f.previous.flowLayoutHash,f.next.flowLayout,f.next.flowLayoutHash,f.pending.request)
   const before=Y.encodeStateAsUpdate(f.document)
   assert.throws(()=>bridgeWordSession({view:f.model,wire:next,linkProof:JSON.parse(JSON.stringify(proof)),assertFresh:()=>{},detachPreviousTransport:()=>{retired=true}}),/link-proof-invalid/);assert.equal(retired,false);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before)
   f.edit(1,'Late private input');const untouched=Y.encodeStateAsUpdate(wire);assert.throws(()=>bridgeWordSession({view:f.model,wire:next,linkProof:proof,assertFresh:()=>{},detachPreviousTransport:()=>{retired=true}}),/review-required/);assert.equal(retired,false);assert.deepEqual(Y.encodeStateAsUpdate(wire),untouched)
  }finally{wire.destroy()}
 }finally{await f.close()}
})
test('proof minting keeps private projection copies and cannot authorize a different live topology',async()=>{
 const f=await wordLinkFixture(),wire=new Y.Doc();try{
  const before=structuredClone(f.previous),after=structuredClone(f.next),proof=await prepareWordLinkSessionProof(f.pending.request.transactionId,before,after,f.record)
  after.flowLayout.sections[1].headers.default=linkId(4);before.blocks[0].content.inlines![0].text='Mutated external input'
  Y.applyUpdate(wire,Y.encodeStateAsUpdate(f.document));const next=new WordRegionStore(wire,wordRegionSchema(),'doc',f.previous.flowLayout,f.previous.flowLayoutHash);next.acceptLinkFields(f.previous.flowLayoutHash,f.next.flowLayout,f.next.flowLayoutHash,f.pending.request)
  const bridge=bridgeWordSession({view:f.model,wire:next,linkProof:proof,assertFresh:()=>{},detachPreviousTransport:()=>{}});bridge.dispose()
  assert.throws(()=>bridgeWordSession({view:next,wire:f.model,linkProof:proof,assertFresh:()=>{},detachPreviousTransport:()=>{}}),/link-proof-invalid/)
 }finally{wire.destroy();await f.close()}
})
test('the member proof reader pins both projections and native record and respects authority and cancellation',async()=>{
 const f=await wordLinkFixture(),original=globalThis.fetch;let calls=0
 try{
  const session:any={documentId:'doc',token:'member-token',format:'docx',scope:'read',apiUrl:'https://native.example/v1/documents',collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1}
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer member-token');const route=String(url);return Response.json(route.endsWith('/revisions/2')?f.record:route.endsWith('revision=1')?f.previous:f.next)}
  const proof=await readWordLinkSessionProof(session,f.pending.request.transactionId,2,new AbortController().signal);assert.equal(proof.revision,2);assert.equal(calls,3)
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(readWordLinkSessionProof(session,f.pending.request.transactionId,2,cancelled.signal));assert.equal(calls,3)
  globalThis.fetch=async()=>new Response('denied',{status:403});await assert.rejects(readWordLinkSessionProof(session,f.pending.request.transactionId,2,new AbortController().signal))
 }finally{globalThis.fetch=original;await f.close()}
})
