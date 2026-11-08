import {test} from 'node:test'
import assert from 'node:assert/strict'
import {canPrepareStoppedAction} from './wordStoppedRecoveryGate.ts'
test('two unknown local queues cannot deadlock signed recovery or authorize fresh edits',()=>{
 for(const otherSaving of [false,true]){
  // One server-prepared request may need resuming before it becomes safe to
  // cancel the other, unprepared attempt. Neither local queue proves outcome.
  assert.equal(canPrepareStoppedAction('resume',true,otherSaving),true)
  assert.equal(canPrepareStoppedAction('cancel',true,otherSaving),true)
  for(const kind of ['save','layout','story','rebase-stale'] as const)assert.equal(canPrepareStoppedAction(kind,true,otherSaving),false)
 }
 assert.equal(canPrepareStoppedAction('layout',false,true),false)
 assert.equal(canPrepareStoppedAction('save',false,false),true)
 assert.equal(canPrepareStoppedAction('legacy',false,false),false)
 assert.equal(canPrepareStoppedAction('legacy',true,true),false)
})
