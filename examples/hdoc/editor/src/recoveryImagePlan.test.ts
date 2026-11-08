import {test} from 'node:test'
import assert from 'node:assert/strict'
import {imageFileHash} from './imageFileIntegrity.ts'
import {compareRecoveryImageFields,type RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import {planRecoveryImage} from './recoveryImagePlan.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'

async function fixture(){
 const bytes=Uint8Array.of(1,2,3),hash=await imageFileHash(bytes),geometry={unit:'pt' as const,x:0,y:0,width:20,height:10},base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry}
 const draft:SharedImageDraft={intentId:'11111111-1111-4111-8111-111111111111',clientId:1,ancestors:[],base,revision:1,geometry:{...geometry,x:5,width:25},assetHash:hash,touched:['x','width','assetHash']}
 const saved={...base,visualHash:'d'.repeat(64),geometry:{...geometry,y:3,width:30},assetHash:'e'.repeat(64)}
 const report:RecoveryImageBaselineReport={headRevision:2,rootHash:'f'.repeat(64),items:[{intentId:draft.intentId,nodeId:base.nodeId,revision:1,baseline:'verified',current:'changed',saved,fields:compareRecoveryImageFields(draft,saved)}]}
 return{draft,report,bytes,hash,resources:new Map([[hash,bytes]])}
}
test('explicit conflict choices rebase the selected fields onto the saved image',async()=>{
 const f=await fixture();await assert.rejects(planRecoveryImage(f.draft,f.report,[],f.resources,{}),/choice-required/)
 const plan=await planRecoveryImage(f.draft,f.report,[],f.resources,{width:'saved',assetHash:'draft'})
 assert.deepEqual(plan.geometry,{unit:'pt',x:5,y:3,width:30,height:10});assert.deepEqual(plan.changed,['x','assetHash']);assert.equal(plan.base.visualHash,'d'.repeat(64));assert.equal(plan.revision,2);assert.equal(plan.assetHash,f.hash);assert.deepEqual(plan.assetBytes,f.bytes)
 f.bytes[0]=9;assert.deepEqual(plan.assetBytes,Uint8Array.of(1,2,3))
})
test('unverified baselines, active room drafts, bad selections and damaged assets are rejected',async()=>{
 const f=await fixture(),choices={width:'draft',assetHash:'draft'} as const
 await assert.rejects(planRecoveryImage(f.draft,{...f.report,items:[{...f.report.items[0],baseline:'missing'}]},[],f.resources,choices),/plan-invalid/)
 await assert.rejects(planRecoveryImage(f.draft,f.report,[f.draft],f.resources,choices),/room-draft/)
 await assert.rejects(planRecoveryImage(f.draft,f.report,[],f.resources,{...choices,x:'saved'}),/plan-invalid/)
 await assert.rejects(planRecoveryImage(f.draft,{...f.report,items:[{...f.report.items[0],fields:[]}]},[],f.resources,choices),/plan-invalid/)
 await assert.rejects(planRecoveryImage(f.draft,{...f.report,items:[f.report.items[0],f.report.items[0]]},[],f.resources,choices),/plan-invalid/)
 await assert.rejects(planRecoveryImage(f.draft,f.report,[],new Map([[f.hash,Uint8Array.of(7)]]),choices),/integrity/)
})
