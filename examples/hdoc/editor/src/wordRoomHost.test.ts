import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordLayoutHostEnabled,wordRoomStatus,requireWordHttpModel} from './wordRoomHost.ts'
import {wordRegionalProtocol,wordLayoutProtocol,structuralProtocol} from './collaborationProtocol.ts'
import type {WordSaveStatus} from './wordSaveCoordinator.ts'

test('layout rooms require both independent explicit host switches',()=>{
 for(const regional of [undefined,'','0','true','1'])for(const layout of [undefined,'','0','true','1'])assert.equal(wordLayoutHostEnabled({HCD_WORD_ROOMS:regional,HCD_WORD_LAYOUT_ROOMS:layout}),regional==='1'&&layout==='1')
})
test('save status identifies the exact regional protocol while preserving the native acknowledgement',()=>{
 const state:WordSaveStatus={stateId:'a'.repeat(32),stateSequence:4,status:'editing',revision:3,pending:true,digest:'b'.repeat(64),imageDigest:'c'.repeat(64)}
 const legacy=wordRoomStatus(state,wordRegionalProtocol),layout=wordRoomStatus(state,wordLayoutProtocol)
 assert.equal(legacy.wordRegionVersion,1);assert.equal('wordLayoutVersion' in legacy,false);assert.equal(layout.wordRegionVersion,2);assert.equal(layout.wordLayoutVersion,1)
 for(const wire of [legacy,layout]){assert.equal(wire.nodeEditVersion,7);assert.equal(wire.type,'hcd-save-status');assert.equal(wire.revision,3);assert.equal(wire.digest,state.digest);assert.equal(wire.pending,true)}
})
test('layout HTTP operations bind explicit headers to the authenticated model and cannot downgrade to legacy owners',()=>{
 const headers={'x-hcd-node-edits-version':'7','x-hcd-word-regions-version':'2','x-hcd-word-layout-version':'1'}
 assert.equal(requireWordHttpModel(wordLayoutProtocol,headers,true),wordLayoutProtocol)
 assert.throws(()=>requireWordHttpModel(wordLayoutProtocol,headers,false),/disabled/)
 assert.throws(()=>requireWordHttpModel(wordRegionalProtocol,headers,true),/upgrade-required/)
 assert.throws(()=>requireWordHttpModel(structuralProtocol,headers,true),/disabled/)
 for(const name of Object.keys(headers)){
  const missing={...headers};delete missing[name as keyof typeof headers];assert.throws(()=>requireWordHttpModel(wordLayoutProtocol,missing,true),/upgrade-required/)
  assert.throws(()=>requireWordHttpModel(wordLayoutProtocol,{...headers,[name]:[headers[name as keyof typeof headers]]},true),/upgrade-required/)
 }
 assert.equal(requireWordHttpModel(wordRegionalProtocol,{'x-hcd-node-edits-version':'7'},false),wordRegionalProtocol)
})
