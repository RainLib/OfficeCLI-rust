import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MigrationUncertain,RoomMigrationGate} from './roomMigrationGate.ts'
test('a migration waits for the entire already admitted async packet and refuses later writers',async()=>{
 const gate=new RoomMigrationGate(),release=gate.enter('doc');let ran=false
 const work=gate.exclusive('doc',async()=>{ran=true;return 1},undefined,'migration')
 await Promise.resolve();assert.equal(ran,false);assert.throws(()=>gate.enter('doc'),/protocol-transition/)
 const duplicate=gate.exclusive('doc',async()=>{throw new Error('must not create a second owner')},undefined,'migration');assert.equal(work,duplicate)
 release();release();assert.equal(await work,1);assert.equal(gate.blocked('doc'),false);gate.enter('doc')()
})
test('an unknown result keeps the room frozen until the same durable job has been reconciled',async()=>{
 const gate=new RoomMigrationGate()
 await assert.rejects(gate.exclusive('doc',async()=>{throw new MigrationUncertain()},undefined,'migration'),/outcome-unknown/)
 assert.equal(gate.blocked('doc'),true);assert.throws(()=>gate.enter('doc'))
 assert.equal(await gate.exclusive('doc',async()=>2,undefined,'migration'),2);gate.enter('doc')()
})
test('a known preparation failure releases the old room without blocking a different document',async()=>{
 const gate=new RoomMigrationGate();await assert.rejects(gate.exclusive('doc',async()=>{gate.enter('other')();throw new Error('invalid source')},undefined,'migration'))
 assert.equal(gate.blocked('doc'),false);gate.enter('doc')()
})

test('a refused freeze restores admission without starting migration or thawing an uncertain job',async()=>{
 const gate=new RoomMigrationGate();let ran=false
 await assert.rejects(gate.exclusive('doc',async()=>{ran=true},()=>{throw new Error('online clients')},'migration'),/online clients/)
 assert.equal(ran,false);assert.equal(gate.blocked('doc'),false);gate.enter('doc')()
 await assert.rejects(gate.exclusive('doc',async()=>{throw new MigrationUncertain()},undefined,'migration'))
 await assert.rejects(gate.exclusive('doc',async()=>{},()=>{throw new Error('not ready')},'migration'))
 assert.equal(gate.blocked('doc'),true)
})
test('different transitions cannot borrow an active operation result or thaw its unknown outcome',async()=>{
 const gate=new RoomMigrationGate();let release!:()=>void,started!:()=>void,otherRan=false
 const hold=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve)
 const migration=gate.exclusive('doc',async()=>{started();await hold;throw new MigrationUncertain()},undefined,'migration:structure')
 await entered
 await assert.rejects(gate.exclusive('doc',async()=>{otherRan=true;return {restored:true}},undefined,'restore'),/protocol-transition/)
 assert.equal(otherRan,false);release();await assert.rejects(migration,/outcome-unknown/);assert.equal(gate.blocked('doc'),true)
 await assert.rejects(gate.exclusive('doc',async()=>{otherRan=true},undefined,'word-recovery'),/protocol-transition/);assert.equal(gate.blocked('doc'),true);assert.equal(otherRan,false)
 assert.equal(await gate.exclusive('doc',async()=>42,undefined,'migration:structure'),42);assert.equal(gate.blocked('doc'),false)
})
test('different migration targets are separate jobs even for the same document',async()=>{
 const gate=new RoomMigrationGate();let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve)
 const first=gate.exclusive('doc',async()=>{await hold;return 'structural'},undefined,'migration:structure')
 await assert.rejects(gate.exclusive('doc',async()=>'inline',undefined,'migration:inline'),/protocol-transition/)
 release();assert.equal(await first,'structural');assert.equal(await gate.exclusive('doc',async()=>'inline',undefined,'migration:inline'),'inline')
})
test('a successful topology transition holds admission until its exact owner releases it',async()=>{
 const gate=new RoomMigrationGate(),packet=gate.enter('doc');let ran=false
 const result=gate.exclusive('doc',async()=>{ran=true;return 7},undefined,'word-story-unlink',true)
 await Promise.resolve();assert.equal(ran,false);assert.equal(gate.readyToRelease('doc','word-story-unlink'),false);assert.throws(()=>gate.enter('doc'));packet();assert.equal(await result,7)
 assert.equal(gate.blocked('doc'),true);assert.equal(gate.readyToRelease('doc','word-story-unlink'),true);assert.equal(gate.readyToRelease('doc','restore'),false);assert.throws(()=>gate.enter('doc'));assert.throws(()=>gate.release('doc','restore'))
 await assert.rejects(gate.exclusive('doc',async()=>0,undefined,'restore'),/protocol-transition/)
 gate.release('doc','word-story-unlink');assert.equal(gate.blocked('doc'),false);gate.enter('doc')()
})

test('keyed topology requests reject concurrent callers and only retry the exact uncertain request',async()=>{
 const gate=new RoomMigrationGate();let start!:()=>void,finish!:()=>void,secondRan=false
 const entered=new Promise<void>(resolve=>start=resolve),hold=new Promise<void>(resolve=>finish=resolve)
 const first=gate.exclusive('doc',async()=>{start();await hold;throw new MigrationUncertain()},undefined,'word-layout-change',true,'request-A',false)
 await entered
 await assert.rejects(gate.exclusive('doc',async()=>{secondRan=true},undefined,'word-layout-change',true,'request-A',false),/protocol-transition/)
 await assert.rejects(gate.exclusive('doc',async()=>{secondRan=true},undefined,'word-layout-change',true,'request-B',false),/protocol-transition/)
 assert.equal(secondRan,false);finish();await assert.rejects(first,/outcome-unknown/)
 await assert.rejects(gate.exclusive('doc',async()=>{secondRan=true},undefined,'word-layout-change',true,'request-B',false),/protocol-transition/)
 assert.equal(gate.blocked('doc'),true);assert.equal(await gate.exclusive('doc',async()=>42,undefined,'word-layout-change',true,'request-A',false),42)
 assert.equal(gate.readyToReleaseIdentity('doc','word-layout-change','request-A'),true);assert.equal(gate.readyToReleaseIdentity('doc','word-layout-change','request-B'),false);assert.equal(gate.readyToReleaseIdentity('doc','word-layout-room-save','request-A'),false)
 gate.release('doc','word-layout-change');assert.equal(gate.blocked('doc'),false)
})
