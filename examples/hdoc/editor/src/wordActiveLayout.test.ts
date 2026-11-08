import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {WordTopologyMember} from './wordTopologyAuthority.ts'
import {WordActiveLayout,activeWordLayoutPending,type WordActiveLayoutContext} from './wordActiveLayout.ts'
const member={userId:'alice',displayName:'Alice',scope:'write' as const}
const request=()=>({schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'a'.repeat(32),baseRevision:3,expectedRevision:3,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:'b'.repeat(64),changes:[{sectionId:'n_'+'1'.repeat(32),field:'widthTwips',expected:12240,value:11906}]}})
function fixture(){
 const active=new WordActiveLayout(),pending=activeWordLayoutPending(request(),'doc',member),calls:string[]=[];let held=false,retired=false
 const context:WordActiveLayoutContext={prepare:async()=>{calls.push('prepare')},transition:async authorize=>{await authorize();calls.push('transition');held=true},promote:async authorize=>{await authorize();calls.push('promote')},retire:async()=>{calls.push('retire');retired=true},isRetired:()=>retired,install:async authorize=>{await authorize();calls.push('install');held=false},activate:()=>{calls.push('activate')},release:()=>{calls.push('release')},held:()=>held}
 return{active,pending,calls,context,run:(authorize:()=>Promise<WordTopologyMember>=async()=>member)=>active.run(pending,authorize,()=>context),held:(value:boolean)=>{held=value},retired:(value:boolean)=>{retired=value}}
}
test('active layout preserves phase order and returns the same result without replaying a completed request',async()=>{
 const f=fixture(),first=await f.run();assert.deepEqual(first,{status:'installed',transactionId:'a'.repeat(32),revision:4});assert.deepEqual(f.calls,['prepare','transition','promote','retire','install','activate','release'])
 assert.deepEqual(await f.run(),first);assert.equal(f.calls.length,7)
 const changed=structuredClone(f.pending);changed.request.edits.changes[0].value=10000;await assert.rejects(f.active.run(changed,async()=>member,()=>f.context),/request-changed/)
})
test('a lost layout response retries the exact transition behind the retained gate',async()=>{
 const f=fixture(),transition=f.context.transition;let attempts=0
 f.context.transition=async authorize=>{await transition(authorize);if(++attempts===1)throw Error('native-response-lost')}
 await assert.rejects(f.run(),/response-lost/);assert.deepEqual(f.calls,['prepare','transition']);await f.run();assert.equal(attempts,2);assert.equal(f.calls.filter(x=>x==='prepare').length,1);assert.equal(f.calls.filter(x=>x==='promote').length,1)
})
test('promotion and installation retries do not repeat a confirmed native transition',async()=>{
 for(const phase of ['promote','install'] as const){const f=fixture(),action=f.context[phase];let attempts=0
  f.context[phase]=async authorize=>{if(++attempts===1)throw Error('unknown-'+phase);await action(authorize)}
  await assert.rejects(f.run(),/unknown/);await f.run();assert.equal(f.calls.filter(x=>x==='transition').length,1);assert.equal(f.calls.filter(x=>x==='prepare').length,1);assert.equal(attempts,2)
 }
})
test('retirement outcome is inspected before retrying an unload that may have completed',async()=>{
 const f=fixture();let unloads=0
 f.context.retire=async()=>{unloads++;f.retired(true);throw Error('unload-response-lost')}
 await assert.rejects(f.run(),/unload-response-lost/);await f.run();assert.equal(unloads,1);assert.ok(f.calls.includes('activate'))
})
test('activation failure after release retains the installed phase and never resubmits or reinstalls',async()=>{
 const f=fixture();let activations=0
 f.context.activate=()=>{if(++activations===1)throw Error('activation-failed')}
 await assert.rejects(f.run(),/activation-failed/);await f.run();assert.equal(activations,2);assert.equal(f.calls.filter(x=>x==='install').length,1);assert.equal(f.calls.filter(x=>x==='transition').length,1)
})
test('an unprepared rejection releases peers and allows a new review while an unknown request blocks another identity',async()=>{
 const f=fixture();f.context.transition=async()=>{throw Error('preflight-stale')};await assert.rejects(f.run(),/preflight-stale/);assert.deepEqual(f.calls,['prepare','release'])
 const g=fixture();g.context.transition=async()=>{g.held(true);throw Error('prepared-unknown')};await assert.rejects(g.run(),/prepared-unknown/)
 const other=structuredClone(g.pending);other.request.transactionId='c'.repeat(32);await assert.rejects(g.active.run(other,async()=>member,()=>g.context),/pending/);assert.equal(g.calls.includes('release'),false)
})
test('each retry uses its current authorization callback and a busy call cannot race the active job',async()=>{
 const f=fixture();let release!:()=>void,started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve}),wait=new Promise<void>(resolve=>{release=resolve}),original=f.context.prepare
 f.context.prepare=async()=>{await original();started();await wait}
 const first=f.run();await entered;await assert.rejects(f.run(),/busy/);release();await first
 await assert.rejects(f.run(async()=>({...member,scope:'read'})),/unauthorized/)
})
test('request parsing pins authenticated identity and canonical key order without silently rewriting the request',()=>{
 const original=request()
 const pending=activeWordLayoutPending(original,'doc',member);assert.equal(pending.actor.generation,1);assert.equal(pending.request.expectedRevision,3)
 const copy={edits:{changes:original.edits.changes.map(change=>({value:change.value,field:change.field,expected:change.expected,sectionId:change.sectionId})),baseLayoutHash:original.edits.baseLayoutHash,schemaVersion:original.edits.schemaVersion},actor:original.actor,expectedRevision:3,baseRevision:3,transactionId:original.transactionId,documentId:'doc',schemaVersion:original.schemaVersion}
 assert.equal(JSON.stringify(activeWordLayoutPending(copy,'doc',member)),JSON.stringify(pending))
 assert.throws(()=>activeWordLayoutPending({...original,actor:{userId:'bob',displayName:'Bob'}},'doc',member),/unauthorized/)
 for(const value of [{...original,documentId:'other'},{...original,transactionId:'invalid'},{...original,extra:true},{...original,expectedRevision:Infinity},{...original,edits:{...original.edits,changes:[]}}])assert.throws(()=>activeWordLayoutPending(value,'doc',member),/invalid/)
})

test('a completed result never impersonates installation in a different collaboration epoch',async()=>{
 const f=fixture();await f.run();await assert.rejects(f.active.run(f.pending,async()=>member,()=>{throw Error('new-epoch-context-required')},1),/new-epoch-context-required/)
 const g=fixture();g.context.transition=async()=>{g.held(true);throw Error('pending-old-epoch')};await assert.rejects(g.run(),/pending-old-epoch/);await assert.rejects(g.active.run(g.pending,async()=>member,()=>g.context,1),/epoch-changed/)
})

test('round status is scoped to its document, epoch and nonce, and never exposes request content',async()=>{
 const f=fixture(),identity={schemaVersion:'hcd-word-active-layout-status/1',documentId:'doc',epoch:0,transactionId:f.pending.request.transactionId}
 assert.deepEqual(f.active.status('doc',0,identity.transactionId),{...identity,status:'recovery-required'})
 let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 f.context.prepare=async()=>{entered();await wait};const task=f.run();await started
 assert.deepEqual(f.active.status('doc',0,identity.transactionId),{...identity,status:'pending'})
 for(const [doc,epoch,id] of [['other',0,identity.transactionId],['doc',1,identity.transactionId],['doc',0,'c'.repeat(32)]] as const)assert.equal(f.active.status(doc,epoch,id).status,'recovery-required')
 release();await task;assert.deepEqual(f.active.status('doc',0,identity.transactionId),{...identity,status:'installed',revision:4})
 for(const [doc,epoch,id] of [['doc',-1,identity.transactionId],['doc',0,'invalid'],['',0,identity.transactionId]] as const)assert.throws(()=>f.active.status(doc,epoch,id),/invalid/)
})
test('lost responses and activation errors remain pending; process loss cannot imply no commit',async()=>{
 const f=fixture();let attempts=0
 f.context.transition=async()=>{f.held(true);if(++attempts===1)throw Error('response-lost')}
 await assert.rejects(f.run(),/response-lost/);assert.equal(f.active.status('doc',0,f.pending.request.transactionId).status,'pending')
 f.context.activate=()=>{throw Error('activation-failed')};await assert.rejects(f.run(),/activation-failed/);assert.equal(f.active.status('doc',0,f.pending.request.transactionId).status,'pending')
 assert.equal(new WordActiveLayout().status('doc',0,f.pending.request.transactionId).status,'recovery-required')
})

test('exact cancellation blocks apply through an unknown result and seals only after successful retry',async()=>{
 const f=fixture();let attempts=0
 const cancel=()=>f.active.cancel(f.pending,async()=>member,async()=>{if(++attempts===1)throw Error('cancel-response-lost')})
 await assert.rejects(cancel(),/response-lost/);assert.equal(f.active.status('doc',0,f.pending.request.transactionId).status,'pending');await assert.rejects(f.run(),/cancel-pending/)
 assert.deepEqual(await cancel(),{transactionId:f.pending.request.transactionId,status:'not-prepared'});assert.equal(f.active.status('doc',0,f.pending.request.transactionId).status,'cancelled');await assert.rejects(f.run(),/cancelled/)
 await cancel();assert.equal(attempts,2)
})
test('a rejected later request cannot hide an installed round from members still rebinding',async()=>{
 const f=fixture(),result=await f.run(),other=structuredClone(f.pending);other.request.transactionId='c'.repeat(32)
 f.context.prepare=async()=>{throw Error('word-topology-cancelled')}
 await assert.rejects(f.active.run(other,async()=>member,()=>f.context),/cancelled/)
 assert.deepEqual(f.active.status('doc',0,f.pending.request.transactionId),{schemaVersion:'hcd-word-active-layout-status/1',documentId:'doc',epoch:0,...result})
 assert.deepEqual(await f.run(),result)
 await assert.rejects(f.active.cancel(f.pending,async()=>member,async()=>{}),/already-installed/)
})
test('older exact installed retries remain read-only after a newer completed round',async()=>{
 const f=fixture(),first=await f.run(),other=structuredClone(f.pending);other.request.transactionId='c'.repeat(32);other.request.expectedRevision=4;other.request.baseRevision=4
 await f.active.run(other,async()=>member,()=>f.context)
 const count=f.calls.length;assert.deepEqual(await f.run(),first);assert.equal(f.calls.length,count)
 assert.equal(f.active.status('doc',0,other.request.transactionId).status,'installed')
 const changed=structuredClone(f.pending);changed.request.edits.changes[0].value=10000;await assert.rejects(f.active.run(changed,async()=>member,()=>f.context),/request-changed/)
 assert.equal(f.active.status('doc',1,f.pending.request.transactionId).status,'recovery-required')
})
test('prepared and installed requests cannot be cancelled, while a new nonce can be sealed after prior success',async()=>{
 const f=fixture();f.context.transition=async()=>{f.held(true);throw Error('prepared-unknown')};await assert.rejects(f.run());await assert.rejects(f.active.cancel(f.pending,async()=>member,async()=>{}),/prepared/)
 const g=fixture();await g.run();await assert.rejects(g.active.cancel(g.pending,async()=>member,async()=>{}),/already-installed/)
 const other=structuredClone(g.pending);other.request.transactionId='d'.repeat(32);await g.active.cancel(other,async()=>member,async()=>{});assert.equal(g.active.status('doc',0,other.request.transactionId).status,'cancelled')
 const third=structuredClone(other);third.request.transactionId='e'.repeat(32);await g.active.cancel(third,async()=>member,async()=>{});assert.equal(g.active.status('doc',0,third.request.transactionId).status,'cancelled')
})
test('cancellation rechecks current actor and cannot race another apply or cancellation',async()=>{
 const f=fixture();await assert.rejects(f.active.cancel(f.pending,async()=>({...member,scope:'read'}),async()=>{}),/unauthorized/)
 let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 const task=f.active.cancel(f.pending,async()=>member,async()=>{entered();await wait});await started
 await assert.rejects(f.active.cancel(f.pending,async()=>member,async()=>{}),/busy/);await assert.rejects(f.run(),/cancel-pending/);release();await task
})
