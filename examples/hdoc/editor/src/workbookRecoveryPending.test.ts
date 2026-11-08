import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pendingWorkbookRecovery} from './workbookRecoveryPending.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {FixedDraftCopy} from './fixedDraftJournal.ts'

test('older single-cell input redirects to its durable unresolved request',()=>{
 const cell={nodeId:'node',sheetId:'sheet',sheetPart:'sheet.xml',row:1,column:2,text:'草稿😀'},blankInput={documentId:'doc',sourceSha256:'a'.repeat(64),baseRevision:3,cell},original:FixedDraftState={version:6,texts:[],images:[],attempt:null,blankInput},attempt={documentId:'doc',sourceSha256:blankInput.sourceSha256,baseRevision:3,patchId:'grid-1',cells:[cell]},copy:FixedDraftCopy={id:'new',updatedAt:2,retained:false,reviewGeneration:null,state:{...original,blankAttempt:attempt}}
 assert.equal(pendingWorkbookRecovery(original,'old',[copy]),copy)
 const later:FixedDraftCopy={...copy,state:{...copy.state,blankInput:{...blankInput,cell:{...cell,text:'after request'}}}}
 assert.equal(pendingWorkbookRecovery(original,'old',[later]),later)
 const legacy:FixedDraftCopy={...copy,state:{version:5,texts:[],images:[],attempt:null,blankAttempt:attempt}}
 assert.equal(pendingWorkbookRecovery(original,'old',[legacy]),legacy)
 assert.equal(pendingWorkbookRecovery(original,'old',[{...copy,state:{...copy.state,blankAttempt:{...attempt,baseRevision:4}}}])?.id,'new')
 assert.equal(pendingWorkbookRecovery({...original,blankAttempt:attempt},'old',[copy]),undefined)
 assert.equal(pendingWorkbookRecovery(original,'old',[{...copy,retained:true}]),undefined)
 assert.equal(pendingWorkbookRecovery({...original,blankInput:{...blankInput,cell:{...cell,text:'later'}}},'old',[copy]),undefined)
})
