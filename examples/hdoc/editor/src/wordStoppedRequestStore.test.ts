import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb'
import type {Session} from './api.ts'
import {draftNamespace} from './localDrafts.ts'
import {openWordStoryRequestStore} from './wordStoryRequestStore.ts'
import {openWordStoppedRequestStore,stoppedDraftQueueOptions,stoppedTopologyQueueOptions} from './wordStoppedRequestStore.ts'
import {deviceRequestQueueJson} from './wordDeviceRequestQueue.ts'
import {WordDraftAttempts,type WordDraftAttemptRecord} from './wordDraftAttempt.ts'
import {WordLayoutAttempts,type WordLayoutAttemptRecord,type StoppedStoryAction} from './wordLayoutAttempt.ts'
const session:Session={documentId:'doc',scope:'write',format:'docx',token:'private-test-token',userId:'alice',displayName:'Alice',collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2',apiUrl:'/v1/documents',collabUrl:'wss://collab.invalid'},base='https://editor.invalid/doc',id='a'.repeat(32),hash='b'.repeat(64)
const story:StoppedStoryAction={kind:'story',section:1,baseRevision:4,body:{epoch:2,operation:'apply',transactionId:id,sectionId:'n_'+'c'.repeat(32),kind:'footer',variant:'even',reviewHash:hash}}
const actor={userId:'alice',displayName:'Alice'}
const draft:WordDraftAttemptRecord={schemaVersion:'hcd-word-draft-attempt/2',epoch:2,checkpointId:'d'.repeat(32),actor,actions:[{kind:'save',baseRevision:4,body:{epoch:2,operation:'save',checkpointId:'d'.repeat(32),reviewHash:hash}}]}
const topology:WordLayoutAttemptRecord={schemaVersion:'hcd-word-stopped-topology/2',epoch:2,transactionId:id,actor,actions:[story]}
const rawDraft=deviceRequestQueueJson([JSON.stringify(draft)],stoppedDraftQueueOptions)!,rawTopology=deviceRequestQueueJson([JSON.stringify(topology)],stoppedTopologyQueueOptions)!
async function fixture(){
 const factory=new IDBFactory(),scope=await draftNamespace(session,session.userId!,base),prefix=scope.prefix+'wordregions2'
 const storage=(kind:'draft'|'topology')=>openWordStoppedRequestStore(prefix,kind,factory)
 return{factory,prefix,storage,draft:async()=>WordDraftAttempts.open(session,base,{storage:await storage('draft')}),topology:async()=>WordLayoutAttempts.open(session,base,{storage:await storage('topology')}),seed:async(kind:'draft'|'topology',raw:string)=>{const old=await openWordStoryRequestStore((kind==='draft'?'hcd-word-draft-attempt-v2-':'hcd-word-stopped-topology-v2-')+prefix,factory);try{await old.replace(null,raw)}finally{old.close()}}}
}
test('different stopped-request kinds atomically compete for one fresh reservation',async()=>{
 for(let run=0;run<6;run++){
  const f=await fixture(),[d,t]=await Promise.all([f.draft(),f.topology()])
  try{
   const results=await Promise.allSettled(run%2?[t.prepare(story,true),d.beginSave(hash,4)]:[d.beginSave(hash,4),t.prepare(story,true)])
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
   await d.refresh();await t.refresh();assert.equal(Number(!!d.attemptId)+Number(!!t.attemptId),1)
   assert.doesNotMatch((d.backup??'')+(t.backup??''),/private-test-token/)
   if(d.attemptId){await d.complete(d.attemptId);await t.prepare(story,true);assert.equal(t.attemptId,id)}
   else{await t.complete(id);await d.beginSave(hash,4);assert.ok(d.attemptId)}
  }finally{d.dispose();t.dispose()}
 }
})
test('both legacy queues migrate intact and remain recoverable without admitting fresh edits',async()=>{
 const f=await fixture();await f.seed('draft',rawDraft);await f.seed('topology',rawTopology)
 const [d,t]=await Promise.all([f.draft(),f.topology()])
 try{
  assert.deepEqual(d.record,draft);assert.deepEqual(t.record,topology)
  await assert.rejects(d.prepare({kind:'rebase-stale',baseRevision:4,body:{epoch:2,operation:'rebase-stale',checkpointId:draft.checkpointId,reviewHash:hash,headRevision:6}}),/other-request-pending/)
  await assert.rejects(t.prepare(story),/other-request-pending/)
  await d.prepare({kind:'resume',body:{epoch:2,operation:'resume',checkpointId:draft.checkpointId}})
  await t.prepare({kind:'resume',baseRevision:4,topologyKind:'story',body:{epoch:2,operation:'resume',transactionId:id}})
  await d.prepare({kind:'cancel',body:{epoch:2,checkpointId:draft.checkpointId}})
  await t.prepare({kind:'cancel',body:{epoch:2,transactionId:id}})
  await d.complete(draft.checkpointId);await t.complete(id)
 }finally{d.dispose();t.dispose()}
 const [againD,againT]=await Promise.all([f.draft(),f.topology()]);try{assert.equal(againD.phase,'idle');assert.equal(againT.phase,'idle')}finally{againD.dispose();againT.dispose()}
})
test('migration fences old version-one writers and new old-version openings fail closed',async()=>{
 const f=await fixture(),oldName='hcd-word-draft-attempt-v2-'+f.prefix,old=await openWordStoryRequestStore(oldName,f.factory)
 await old.replace(null,rawDraft)
 const next=await f.storage('draft')
 try{assert.equal(await next.read(),rawDraft);await assert.rejects(old.read());await assert.rejects(openWordStoryRequestStore(oldName,f.factory),error=>error instanceof Error&&error.name==='VersionError')}finally{old.close();next.close()}
})
test('migration quota refusal retains the only old bytes and a later open can retry',async()=>{
 const f=await fixture();await f.seed('draft',rawDraft);await f.seed('topology',rawTopology)
 const put=IDBObjectStore.prototype.put
 try{
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){if(this.transaction.db.name.startsWith('hcd-word-stopped-requests-v1-'))throw new DOMException('quota','QuotaExceededError');return put.apply(this,args)}
  await assert.rejects(f.storage('draft'),/quota/)
 }finally{IDBObjectStore.prototype.put=put}
 const d=await f.draft(),t=await f.topology();try{assert.deepEqual(d.record,draft);assert.deepEqual(t.record,topology)}finally{d.dispose();t.dispose()}
})
test('an aborted fresh write cannot leave a reservation that blocks the other kind',async()=>{
 const f=await fixture(),d=await f.draft(),t=await f.topology(),put=IDBObjectStore.prototype.put
 try{
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof put>){if(args[1]==='draft')throw new DOMException('quota','QuotaExceededError');return put.apply(this,args)}
  await assert.rejects(d.beginSave(hash,4));assert.equal(d.attemptId,null)
 }finally{IDBObjectStore.prototype.put=put}
 try{await t.prepare(story,true);assert.equal(t.attemptId,id);assert.equal(d.attemptId,null)}finally{d.dispose();t.dispose()}
})
test('corrupt old evidence stays downloadable and blocks a fresh peer request',async()=>{
 const f=await fixture();await f.seed('draft','damaged original evidence');const d=await f.draft(),t=await f.topology()
 try{assert.equal(d.phase,'invalid');assert.equal(d.backup,'damaged original evidence');await assert.rejects(t.prepare(story,true),/other-request-pending/);assert.equal(t.attemptId,null)}finally{d.dispose();t.dispose()}
})
test('same-kind CAS still rejects a late request completion after another window changes it',async()=>{
 const f=await fixture(),a=await f.draft(),b=await f.draft()
 try{await a.prepare(draft.actions[0]);await b.refresh();await a.prepare({kind:'cancel',body:{epoch:2,checkpointId:draft.checkpointId}});await assert.rejects(b.complete(draft.checkpointId),/record-changed/);await b.refresh();assert.equal(b.record!.actions.at(-1)!.kind,'cancel')}finally{a.dispose();b.dispose()}
})
test('a changed frozen legacy database cannot replace the migrated canonical queue',async()=>{
 const f=await fixture();await f.seed('draft',rawDraft);const current=await f.storage('draft');assert.equal(await current.read(),rawDraft);current.close()
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const opening=f.factory.open('hcd-word-draft-attempt-v2-'+f.prefix,2);opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('request','readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);tx.objectStore('request').put('tampered legacy','current')});db.close()
 await assert.rejects(f.storage('draft'),/legacy-changed/)
})
test('an old client that refuses to close blocks migration without publishing a new queue',async()=>{
 const f=await fixture(),db=await new Promise<IDBDatabase>((resolve,reject)=>{const opening=f.factory.open('hcd-word-draft-attempt-v2-'+f.prefix,1);opening.onupgradeneeded=()=>opening.result.createObjectStore('request');opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error)})
 try{await assert.rejects(f.storage('draft'),/storage-blocked/)}finally{db.close()}
 const store=await f.storage('draft');try{assert.equal(await store.read(),null)}finally{store.close()}
})
