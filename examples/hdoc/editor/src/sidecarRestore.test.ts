import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SidecarRestore} from './sidecarRestore.ts'
import {RestoreJournal,validRestoreRequest,type RestoreJob} from './restoreJournal.ts'
import {RoomMigrationGate,MigrationUncertain} from './roomMigrationGate.ts'
import {MigrationRejected} from './sidecarMigration.ts'
const input={requestId:'a'.repeat(32),expectedRevision:4,target:0,fromEpoch:2,authorId:'alice',authorName:'Alice'}
const receipt=(job:RestoreJob)=>({requestId:job.request.requestId,revision:job.request.expectedRevision+1,restoredFrom:job.target,collaborationEpoch:job.request.fromEpoch+1,collaborationProtocol:'hcd-semantic-blocks/3'})
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'hcd-restore-test-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const gate=new RoomMigrationGate(),journal=new RestoreJournal(root,'http://core'),events:string[]=[],jobs:RestoreJob[]=[]
 const host={quiesce:async()=>{events.push('quiesce')},freeze:()=>{events.push('freeze')},prepare:async()=>{events.push('prepare');return'b'.repeat(64)},submit:async(job:RestoreJob)=>{events.push('submit');jobs.push(structuredClone(job));return Response.json(receipt(job))},release:async()=>{events.push('release')},committed:async()=>{events.push('committed')}}
 return{root,gate,journal,events,jobs,host,service:new SidecarRestore(gate,journal,host)}
}
test('restore drains an admitted packet before capturing the head and persists exact identity',{timeout:10000},async t=>{
 const f=await fixture(t),leave=f.gate.enter('doc');let frozen!:()=>void
 const freezing=new Promise<void>(resolve=>{frozen=resolve}),freeze=f.host.freeze;f.host.freeze=()=>{freeze();frozen()}
 const work=f.service.run('doc',input)
 await Promise.race([freezing,work.then(()=>{throw new Error('Restore finished before the admitted packet drained')})]);assert.deepEqual([...f.events],['quiesce','freeze']);assert.throws(()=>f.gate.enter('doc'));assert.equal(f.jobs.length,0)
 leave();const result=await work;assert.equal(result.revision,5);assert.deepEqual(f.events,['quiesce','freeze','prepare','submit','committed']);assert.equal(f.gate.blocked('doc'),false)
 assert.equal((await f.journal.load('doc'))?.status,'committed');assert.equal((await stat(f.journal.directory)).mode&0o777,0o700)
})
test('a busy private window prevents publication and releases every prepared peer',async t=>{
 const f=await fixture(t);f.host.quiesce=async()=>{throw new MigrationRejected(409,'restore-client-busy')}
 await assert.rejects(f.service.run('doc',input),/restore-client-busy/);assert.deepEqual(f.events,['release']);assert.equal(f.jobs.length,0);assert.equal(f.gate.blocked('doc'),false)
})
test('a changed head or dirty room rejects before journaling and resumes the room',async t=>{
 const f=await fixture(t);f.host.prepare=async()=>{throw new MigrationRejected(409,'restore-comparison-changed')}
 await assert.rejects(f.service.run('doc',input),/restore-comparison-changed/);assert.equal(await f.journal.load('doc'),undefined);assert.equal(f.events.at(-1),'release');assert.equal(f.gate.blocked('doc'),false)
})
test('unknown commit keeps packets fenced and restart resubmits the identical request',async t=>{
 const f=await fixture(t);f.host.submit=async job=>{f.jobs.push(structuredClone(job));throw new Error('response lost')}
 await assert.rejects(f.service.run('doc',input),MigrationUncertain);assert.equal(f.gate.blocked('doc'),true);assert.equal((await f.journal.load('doc'))?.status,'prepared');assert.equal(f.events.includes('release'),false)
 const restartGate=new RoomMigrationGate(),restartHost={...f.host,quiesce:async()=>{throw new Error('must not create a new intent')},submit:async(job:RestoreJob)=>{f.jobs.push(structuredClone(job));return Response.json(receipt(job))}}
 const restarted=new SidecarRestore(restartGate,new RestoreJournal(f.root,'http://core'),restartHost)
 assert.equal((await restarted.recover('doc'))?.revision,5);assert.deepEqual(f.jobs[0],f.jobs[1]);assert.equal(restartGate.blocked('doc'),false)
})
test('a prepared request cannot be replaced with a different target or author',async t=>{
 const f=await fixture(t);f.host.submit=async()=>{throw new Error('lost')};await assert.rejects(f.service.run('doc',input),MigrationUncertain)
 await assert.rejects(f.service.run('doc',{...input,authorId:'bob'}),/restore-pending/);await assert.rejects(f.service.run('doc',{...input,target:1}),/restore-pending/);assert.equal(f.gate.blocked('doc'),true)
})
test('invalid success receipts keep the original request pending',async t=>{
 const f=await fixture(t);f.host.submit=async job=>Response.json({...receipt(job),collaborationEpoch:99})
 await assert.rejects(f.service.run('doc',input),MigrationUncertain);assert.equal(f.gate.blocked('doc'),true);assert.equal((await f.journal.load('doc'))?.status,'prepared')
})
test('a definitive native CAS rejection archives the rejected intent and resumes peers',async t=>{
 const f=await fixture(t);f.host.submit=async()=>new Response('head changed',{status:409})
 await assert.rejects(f.service.run('doc',input),/restore-comparison-changed/);assert.equal(await f.journal.load('doc'),undefined);assert.equal(f.gate.blocked('doc'),false);assert.equal(f.events.at(-1),'release')
})
test('success with failed room cleanup can be reconciled without another native commit',async t=>{
 const f=await fixture(t);let first=true;f.host.committed=async()=>{if(first){first=false;throw new Error('closing room failed')}}
 await assert.rejects(f.service.run('doc',input),MigrationUncertain);assert.equal((await f.journal.load('doc'))?.status,'committed');assert.equal(f.gate.blocked('doc'),true)
 assert.equal((await f.service.run('doc',input))?.revision,5);assert.equal(f.jobs.length,1);assert.equal(f.gate.blocked('doc'),false)
})
test('concurrent submissions cannot borrow another restore result',{timeout:10000},async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve});f.host.quiesce=()=>new Promise<void>(resolve=>{release=resolve;started()})
 const first=f.service.run('doc',input);await Promise.race([ready,first.then(()=>{throw new Error('Restore completed before quiescence')})]);await assert.rejects(f.service.run('doc',{...input,requestId:'c'.repeat(32)}),/restore-busy/);release();await first
})
test('migration starting during restore quiescence cannot be mistaken for a restore receipt',{timeout:10000},async t=>{
 const f=await fixture(t);let ready!:()=>void,resume!:()=>void,finishMigration!:()=>void
 const quiesced=new Promise<void>(resolve=>{ready=resolve}),continueRestore=new Promise<void>(resolve=>{resume=resolve}),holdMigration=new Promise<void>(resolve=>{finishMigration=resolve})
 f.host.quiesce=async()=>{ready();await continueRestore}
 let releasedWhileFenced=false;f.host.release=async()=>{releasedWhileFenced=f.gate.blocked('doc')}
 const restoring=f.service.run('doc',input);await quiesced
 const migration=f.gate.exclusive('doc',async()=>{await holdMigration;throw new MigrationUncertain()},undefined,'migration:hcd-semantic-blocks/3')
 resume();await assert.rejects(restoring,/protocol-transition/);assert.equal(releasedWhileFenced,true)
 assert.equal(f.jobs.length,0);assert.equal(await f.journal.load('doc'),undefined)
 finishMigration();await assert.rejects(migration,MigrationUncertain);assert.equal(f.gate.blocked('doc'),true)
 await assert.rejects(f.service.run('doc',input),/protocol-transition/);assert.equal(f.jobs.length,0);assert.equal(f.gate.blocked('doc'),true)
})
test('a journal write with an unknown durability result cannot resume the old room',async t=>{
 const f=await fixture(t),save=f.journal.save.bind(f.journal)
 f.journal.save=async job=>{await save(job);throw new Error('fsync reply unavailable')}
 await assert.rejects(f.service.run('doc',input),MigrationUncertain);assert.equal(f.jobs.length,0);assert.equal(f.gate.blocked('doc'),true);assert.equal((await f.journal.load('doc'))?.status,'prepared')
 f.journal.save=save;assert.equal((await f.service.recover('doc'))?.revision,5);assert.equal(f.jobs.length,1)
})
test('a corrupt journal fences existing writers and refuses to invent a replacement intent',async t=>{
 const f=await fixture(t);await mkdir(f.journal.directory,{recursive:true});await writeFile(join(f.journal.directory,'doc.json'),'{broken')
 await assert.rejects(f.service.run('doc',input),MigrationUncertain);assert.equal(f.gate.blocked('doc'),true);assert.throws(()=>f.gate.enter('doc'));assert.equal(f.events.length,0)
})
test('inline restore pins its model through lost response, restart and committed replay',async t=>{
 const f=await fixture(t),inlineInput={...input,fromProtocol:'hcd-semantic-inline/1' as const}
 f.host.submit=async job=>{f.jobs.push(structuredClone(job));throw new Error('lost')}
 await assert.rejects(f.service.run('doc',inlineInput),MigrationUncertain)
 assert.equal((await f.journal.load('doc'))?.request.fromProtocol,inlineInput.fromProtocol)
 for(const changed of [{...inlineInput,fromProtocol:'hcd-semantic-blocks/3' as const},{...inlineInput,fromEpoch:3}])await assert.rejects(f.service.run('doc',changed),/restore-pending/)
 const restartGate=new RoomMigrationGate(),restarted=new SidecarRestore(restartGate,new RestoreJournal(f.root,'http://core'),{...f.host,submit:async job=>{f.jobs.push(structuredClone(job));return Response.json({...receipt(job),collaborationProtocol:inlineInput.fromProtocol})}})
 assert.equal((await restarted.recover('doc'))?.collaborationProtocol,inlineInput.fromProtocol);assert.deepEqual(f.jobs[0],f.jobs[1])
 assert.equal((await restarted.run('doc',inlineInput)).revision,5);assert.equal(f.jobs.length,2)
 await assert.rejects(restarted.run('doc',{...inlineInput,fromEpoch:3}),/restore-request-changed/)
})
test('inline restore refuses a structural success receipt and keeps the exact intent fenced',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.run('doc',{...input,fromProtocol:'hcd-semantic-inline/1'}),MigrationUncertain)
 assert.equal(f.gate.blocked('doc'),true);assert.equal((await f.journal.load('doc'))?.status,'prepared')
})
test('a journal with an unsupported restore model is never reinterpreted as the old protocol',async t=>{
 const f=await fixture(t);await mkdir(f.journal.directory,{recursive:true});await writeFile(join(f.journal.directory,'doc.json'),JSON.stringify({version:1,documentId:'doc',target:0,status:'prepared',request:{...input,sourceHash:'b'.repeat(64),fromProtocol:'hcd-word-regions/1'}}))
 await assert.rejects(f.service.recover('doc'),MigrationUncertain);assert.equal(f.jobs.length,0);assert.equal(f.gate.blocked('doc'),true)
})
test('layout restore journals the word-regions model and replays it after a lost response',async t=>{
 const f=await fixture(t),layoutInput={...input,fromProtocol:'hcd-word-regions/2' as const}
 f.host.submit=async job=>{f.jobs.push(structuredClone(job));throw new Error('response lost')}
 await assert.rejects(f.service.run('doc',layoutInput),MigrationUncertain)
 assert.equal((await f.journal.load('doc'))?.request.fromProtocol,layoutInput.fromProtocol)
 await assert.rejects(f.service.run('doc',{...layoutInput,fromProtocol:'hcd-semantic-blocks/3' as const}),/restore-pending/)
 const restartGate=new RoomMigrationGate(),restarted=new SidecarRestore(restartGate,new RestoreJournal(f.root,'http://core'),{...f.host,submit:async job=>{f.jobs.push(structuredClone(job));return Response.json({...receipt(job),collaborationProtocol:layoutInput.fromProtocol})}})
 assert.equal((await restarted.recover('doc'))?.collaborationProtocol,layoutInput.fromProtocol)
 await assert.rejects(restarted.run('doc',{...layoutInput,fromProtocol:'hcd-semantic-blocks/3' as const}),/restore-request-changed/)
})
test('layout restore refuses a structural success receipt and keeps the exact intent fenced',async t=>{
 const f=await fixture(t);f.host.submit=async job=>Response.json(receipt(job))
 await assert.rejects(f.service.run('doc',{...input,fromProtocol:'hcd-word-regions/2' as const}),MigrationUncertain)
 assert.equal(f.gate.blocked('doc'),true);assert.equal((await f.journal.load('doc'))?.status,'prepared')
})
test('the journal carries a none tip only for word-layout rooms',()=>{
 const base={requestId:'a'.repeat(32),expectedRevision:2,fromEpoch:0,sourceHash:'none',authorId:'alice',authorName:'Alice'}
 assert.ok(validRestoreRequest({...base,fromProtocol:'hcd-word-regions/2' as const}))
 assert.ok(!validRestoreRequest({...base,fromProtocol:'hcd-semantic-inline/1' as const}))
 assert.ok(!validRestoreRequest(base as never))
 assert.ok(validRestoreRequest({...base,sourceHash:'c'.repeat(64)}))
 assert.ok(!validRestoreRequest({...base,fromProtocol:'hcd-word-regions/2' as const,sourceHash:'none '}))
 assert.ok(!validRestoreRequest({...base,fromProtocol:'hcd-word-regions/2' as const,sourceHash:'NONE'}))
})
