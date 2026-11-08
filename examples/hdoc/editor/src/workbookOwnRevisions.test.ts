import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WorkbookOwnRevisions} from './workbookOwnRevisions.ts'

test('delayed own receipts remain recognizable without masking remote or reset events',()=>{
 const revisions=new WorkbookOwnRevisions();revisions.remember('local')
 assert.equal(revisions.isOwn({patchId:'local'}),true)
 assert.equal(revisions.isOwn({patchId:'pending'},'pending'),true)
 assert.equal(revisions.isOwn({patchId:'remote'}),false)
 assert.equal(revisions.isOwn({patchId:'local',reset:true}),false)
 for(let i=0;i<128;i++)revisions.remember(`later-${i}`)
 assert.equal(revisions.isOwn({patchId:'local'}),false)
})
