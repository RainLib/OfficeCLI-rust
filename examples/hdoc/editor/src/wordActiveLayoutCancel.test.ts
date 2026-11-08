import {test} from 'node:test'
import assert from 'node:assert/strict'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {activeWordLayoutPending} from './wordActiveLayout.ts'
import {cancelActiveWordLayout,confirmCancelledActiveWordLayout} from './wordActiveLayoutCancel.ts'
const member={scope:'write' as const,userId:'alice',displayName:'Alice'},pending=activeWordLayoutPending({schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'a'.repeat(32),baseRevision:3,expectedRevision:3,actor:{userId:'alice',displayName:'Alice'},edits:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:'b'.repeat(64),changes:[{sectionId:'n_'+'1'.repeat(32),field:'widthTwips',expected:12240,value:11906}]}},'doc',member)
function fixture(){
 const gate=new RoomMigrationGate(),calls:string[]=[];let held=false,sealed=false,ready=true,releaseFails=false,prepared=false
 const journal={topologyAbandoned:async()=>sealed,abandonUnpreparedTopology:async(_id:string,guard:()=>void)=>{guard();if(prepared)throw Error('word-topology-already-prepared');sealed=true;calls.push('journal');guard()}} as unknown as WordCheckpointJournal
 const room={ownsJournal:(value:unknown)=>value===journal,drain:async()=>{calls.push('drain')},holdForTopology:()=>{held=true;calls.push('hold')},assertTopologyHeld:()=>{assert.equal(held,true)},releaseTopologyHold:()=>{if(releaseFails)throw Error('changed-room');held=false;calls.push('release')}} as unknown as WordSaveCoordinator
 const options={gate,room,journal,pending,assertOwnership:()=>{},assertClientsReady:()=>{if(!ready)throw Error('not-ready')},authorize:async()=>member,request:async()=>{assert.equal(sealed,true);assert.equal(gate.blocked('doc'),true);calls.push('native');return Response.json({transactionId:pending.request.transactionId,status:'not-prepared'})}}
 return{gate,calls,options,ready:(v:boolean)=>{ready=v},seal:()=>{sealed=true},prepared:()=>{prepared=true},releaseFails:()=>{releaseFails=true},held:()=>held}
}
test('cancellation drains and freezes before signing, native sealing and safe release',async()=>{const f=fixture();await cancelActiveWordLayout(f.options);assert.deepEqual(f.calls,['drain','hold','journal','native','release']);assert.equal(f.gate.blocked('doc'),false);assert.equal(f.held(),false)})
test('failed preparation proof and prepared journal never reach native cancellation',async()=>{
 const f=fixture();f.ready(false);await assert.rejects(cancelActiveWordLayout(f.options),/not-ready/);assert.deepEqual(f.calls,[]);assert.equal(f.gate.blocked('doc'),false)
 const g=fixture();g.prepared();await assert.rejects(cancelActiveWordLayout(g.options),/already-prepared/);assert.equal(g.calls.includes('native'),false);assert.equal(g.gate.blocked('doc'),false);assert.equal(g.held(),false)
})
test('native unknown response releases a safe content room, while failed release retains its gate',async()=>{
 const f=fixture();f.options.request=async()=>{throw Error('network')};await assert.rejects(cancelActiveWordLayout(f.options),/network/);assert.equal(f.gate.blocked('doc'),false)
 const g=fixture();g.releaseFails();await assert.rejects(cancelActiveWordLayout(g.options),/migration-outcome-unknown/);assert.equal(g.gate.blocked('doc'),true)
})
test('a signed cancelled retry confirms only its native nonce without pausing live content',async()=>{
 const f=fixture();assert.equal(await confirmCancelledActiveWordLayout(f.options),false);assert.deepEqual(f.calls,[])
 f.seal();f.ready(false);f.options.request=async()=>{assert.equal(f.gate.blocked('doc'),false);f.calls.push('native');return Response.json({transactionId:pending.request.transactionId,status:'not-prepared'})}
 assert.equal(await confirmCancelledActiveWordLayout(f.options),true);assert.deepEqual(f.calls,['native']);assert.equal(f.held(),false)
})
test('cancelled confirmation still checks current actor, native receipt and admission',async()=>{
 const f=fixture();f.seal();f.options.authorize=async()=>({...member,userId:'bob'});await assert.rejects(confirmCancelledActiveWordLayout(f.options),/unauthorized/);assert.deepEqual(f.calls,[])
 const g=fixture();g.seal();g.options.request=async()=>Response.json({transactionId:'c'.repeat(32),status:'not-prepared'});await assert.rejects(confirmCancelledActiveWordLayout(g.options),/cancel-invalid/)
 await g.gate.exclusive('doc',async()=>{},undefined,'test',true,'test');await assert.rejects(confirmCancelledActiveWordLayout(g.options),/room-protocol-transition/)
})
