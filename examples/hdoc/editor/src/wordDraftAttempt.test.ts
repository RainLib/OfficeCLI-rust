import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import {WordDraftAttempts,readWordDraftAttemptRecord,legacyDraftAttemptKey,type WordDraftAction} from './wordDraftAttempt.ts'
import {openWordStoryRequestStore} from './wordStoryRequestStore.ts'
import {readDeviceRequestQueue} from './wordDeviceRequestQueue.ts'
import {draftNamespace} from './localDrafts.ts'
import type {Session} from './api.ts'
const session:Session={documentId:'doc',scope:'write',format:'docx',token:'SENSITIVE_TEST_TOKEN',userId:'alice',displayName:'Alice 王',collaborationEpoch:3,collaborationProtocol:'hcd-word-regions/2',apiUrl:'/v1/documents',collabUrl:'wss://collab.invalid'},base='https://editor.invalid/page',hash='a'.repeat(64),id='d'.repeat(32)
class Legacy{values=new Map<string,string>();getItem(key:string){return this.values.get(key)??null}setItem(key:string,value:string){this.values.set(key,value)}removeItem(key:string){this.values.delete(key)}}
async function fixture(){const factory=new IDBFactory(),store=async(change:Partial<Session>={})=>{const s={...session,...change},scope=await draftNamespace(s,s.userId!,base);return openWordStoryRequestStore('hcd-word-draft-attempt-v2-'+scope.prefix+'wordregions2',factory,'word-draft')};return{store,open:async(change:Partial<Session>={},legacy?:Legacy)=>WordDraftAttempts.open({...session,...change},base,{storage:await store(change),legacy}),raw:async()=>{const s=await store();try{return await s.read()}finally{s.close()}}}}
const save=(checkpointId=id):WordDraftAction=>({kind:'save',baseRevision:4,body:{epoch:3,operation:'save',checkpointId,reviewHash:hash}})
test('complete stopped-save parameters persist before returning an identity and survive close and token renewal',async()=>{
 const f=await fixture(),first=await f.open();let original
 try{const checkpointId=await first.beginSave(hash,4);original=first.record!;assert.equal(original.checkpointId,checkpointId);assert.deepEqual(original.actions,[save(checkpointId)]);assert.ok(!(await f.raw())!.includes(session.token));const copy=first.record!;copy.actions.length=0;assert.equal(first.record!.actions.length,1)}finally{first.dispose()}
 const next=await f.open({token:'renewed-token'});try{assert.deepEqual(next.record,original);assert.equal(next.attemptId,original.checkpointId)}finally{next.dispose()}
})
test('save, explicit resume, cancellation and rebase keep an immutable action history with exact bodies',async()=>{
 const f=await fixture(),tx=await f.open()
 try{await tx.prepare(save());const original=tx.record!.actions[0];const cancel:WordDraftAction={kind:'cancel',body:{epoch:3,checkpointId:id}},resume:WordDraftAction={kind:'resume',body:{epoch:3,operation:'resume',checkpointId:id}},rebase:WordDraftAction={kind:'rebase-stale',baseRevision:4,body:{epoch:3,operation:'rebase-stale',checkpointId:id,reviewHash:'b'.repeat(64),headRevision:6}};await tx.prepare(cancel);await tx.prepare(cancel);assert.equal(tx.record!.actions.length,2);await tx.prepare(resume);await tx.prepare(rebase);assert.deepEqual(tx.record!.actions,[original,cancel,resume,rebase]);await assert.rejects(tx.prepare(save('f'.repeat(32))));await assert.rejects(tx.beginSave(hash,4));assert.equal(tx.record!.actions.length,4)}finally{tx.dispose()}
})
test('unknown cancellation remains the latest durable action when the tab closes',async()=>{
 const f=await fixture(),a=await f.open();await a.prepare(save());await a.prepare({kind:'cancel',body:{epoch:3,checkpointId:id}});const original=a.backup;a.dispose();const b=await f.open();try{assert.equal(b.backup,original);assert.equal(b.record!.actions.at(-1)!.kind,'cancel');await assert.rejects(b.complete('f'.repeat(32)));assert.equal(b.backup,original)}finally{b.dispose()}
})
test('concurrent windows cannot replace the first unknown save',async()=>{
 const f=await fixture(),a=await f.open(),b=await f.open()
 try{const result=await Promise.allSettled([a.beginSave(hash,4),b.beginSave('b'.repeat(64),4)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);await a.refresh();await b.refresh();assert.deepEqual(a.record,b.record);assert.equal(a.pendingCount,1)}finally{a.dispose();b.dispose()}
})
test('different legacy IDs queue separately and matching old copies deduplicate without inventing review parameters',async()=>{
 const f=await fixture(),left=new Legacy(),right=new Legacy(),key=legacyDraftAttemptKey(session);left.setItem(key,id);right.setItem(key,'e'.repeat(32));const a=await f.open({},left),b=await f.open({},right)
 try{await a.refresh();assert.equal(a.pendingCount,2);assert.equal(left.getItem(key),null);assert.equal(right.getItem(key),null);assert.deepEqual(a.record!.actions,[{kind:'legacy',body:{epoch:3,checkpointId:id}}]);const clone=new Legacy();clone.setItem(key,id);const c=await f.open({},clone);try{assert.equal(c.pendingCount,2)}finally{c.dispose()};await a.complete(id);assert.equal(a.attemptId,'e'.repeat(32));await a.complete('e'.repeat(32));await b.refresh();assert.equal(b.phase,'idle')}finally{a.dispose();b.dispose()}
})
test('legacy migration quota failure never removes the only old request',async()=>{
 const f=await fixture(),s=await f.store(),legacy=new Legacy();legacy.setItem(legacyDraftAttemptKey(session),id);s.replace=async()=>{throw Error('quota')};await assert.rejects(WordDraftAttempts.open(session,base,{storage:s,legacy}),/quota/);assert.equal(legacy.getItem(legacyDraftAttemptKey(session)),id);assert.equal(await f.raw(),null)
})
test('a legacy ID changing during commit is imported as another request',async()=>{
 const f=await fixture(),s=await f.store(),replace=s.replace,legacy=new Legacy(),key=legacyDraftAttemptKey(session);legacy.setItem(key,id);let changed=false;s.replace=async(before,next)=>{await replace(before,next);if(!changed){changed=true;legacy.setItem(key,'e'.repeat(32))}};const tx=await WordDraftAttempts.open(session,base,{storage:s,legacy});try{assert.equal(tx.pendingCount,2);assert.equal(legacy.getItem(key),null);await tx.complete(id);assert.equal(tx.attemptId,'e'.repeat(32))}finally{tx.dispose()}
})
test('malformed legacy evidence cannot authorize save or completion and stays downloadable',async()=>{
 const f=await fixture(),legacy=new Legacy();legacy.setItem(legacyDraftAttemptKey(session),'corrupt old identity');const tx=await f.open({},legacy);try{assert.equal(tx.phase,'invalid');assert.equal(tx.attemptId,'invalid');assert.equal(tx.backup,'corrupt old identity');await assert.rejects(tx.prepare(save()));await assert.rejects(tx.complete(id));assert.equal(legacy.getItem(legacyDraftAttemptKey(session)),null)}finally{tx.dispose()}
})
test('storage failure returns no identity and disposal during a committed prepare keeps the complete record',async()=>{
 const f=await fixture(),s=await f.store(),replace=s.replace;s.replace=async()=>{throw Error('quota')};const tx=await WordDraftAttempts.open(session,base,{storage:s});try{await assert.rejects(tx.beginSave(hash,4));assert.equal(tx.record,null);s.replace=replace;let release!:()=>void,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve}),wait=new Promise<void>(resolve=>{release=resolve});s.replace=async(a,b)=>{await replace(a,b);started();await wait};const preparing=tx.prepare(save());await entered;tx.dispose();release();await assert.rejects(preparing);const reopened=await f.open();try{assert.deepEqual(reopened.record!.actions,[save()])}finally{reopened.dispose()}}finally{tx.dispose()}
})
test('a delayed device observation cannot replace a locally committed request',async()=>{
 const f=await fixture(),s=await f.store(),tx=await WordDraftAttempts.open(session,base,{storage:s}),read=s.read;let release!:(value:string|null)=>void,started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve});let first=true
 try{s.read=async()=>{const raw=await read();if(first){first=false;started();return new Promise(resolve=>{release=resolve})}return raw};const refreshing=tx.refresh();await entered;await tx.prepare(save());release(null);await refreshing;assert.equal(tx.attemptId,id);assert.equal(tx.phase,'pending')}finally{tx.dispose()}
})
test('foreign epochs, renamed actors and member endpoints cannot adopt an unknown request',async()=>{
 const f=await fixture(),a=await f.open();await a.prepare(save());const raw=a.backup;a.dispose()
 for(const change of [{collaborationEpoch:4},{displayName:'Renamed Alice'}]){const b=await f.open(change);try{assert.equal(b.phase,'invalid');assert.equal(b.backup,raw);await assert.rejects(b.beginSave(hash,4));await assert.rejects(b.complete(id))}finally{b.dispose()}}
 for(const change of [{userId:'bob',displayName:'Bob'},{documentId:'other'},{collabUrl:'wss://another.invalid'}]){const b=await f.open(change);try{assert.equal(b.phase,'idle')}finally{b.dispose()}}
 await assert.rejects(f.open({scope:'read'}))
})
test('action metadata must match the actor, exact checkpoint, epoch and body schema',async()=>{
 const f=await fixture(),tx=await f.open();try{await tx.prepare(save());const record=tx.record!;for(const mutate of [(v:any)=>{v.actor.userId='bob'},(v:any)=>{v.actions[0].body.checkpointId='f'.repeat(32)},(v:any)=>{v.actions[0].body.epoch=4},(v:any)=>{v.actions[0].body.extra=true},(v:any)=>{v.actions[0].body.reviewHash='bad'},(v:any)=>{v.actions.push({kind:'rebase-stale',baseRevision:4,body:{epoch:3,operation:'rebase-stale',checkpointId:id,reviewHash:hash,headRevision:4}})},(v:any)=>{v.extra=true}]){const value=structuredClone(record);mutate(value);assert.throws(()=>readWordDraftAttemptRecord(value,session))};await assert.rejects(tx.prepare({kind:'legacy',body:{epoch:3,checkpointId:id}}));assert.equal(tx.record!.actions.length,1)}finally{tx.dispose()}
})
test('bounded action history rejects overflow without replacing any original action',async()=>{
 const f=await fixture(),tx=await f.open();try{await tx.prepare(save());for(let i=1;i<16;i++)await tx.prepare(i%2?{kind:'cancel',body:{epoch:3,checkpointId:id}}:{kind:'resume',body:{epoch:3,operation:'resume',checkpointId:id}});const raw=tx.backup;await assert.rejects(tx.prepare({kind:'resume',body:{epoch:3,operation:'resume',checkpointId:id}}));assert.equal(tx.backup,raw);assert.equal(tx.record!.actions.length,16)}finally{tx.dispose()}
})
