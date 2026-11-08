import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {NodeResourceJournal} from './nodeResourceJournal.ts'
import {nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {recoveryFiles,recoveryHash,type RecoveryTransferReview} from './semanticRecoveryTransfer.ts'
import {structuralProtocol,inlineProtocol} from './collaborationProtocol.ts'
import {reviewRecoveryFileRepair,applyRecoveryFileRepair,recoveryFileIntegrityError} from './recoveryFileRepair.ts'

async function file():Promise<WordNodeResourceDraft>{const bytes=Uint8Array.of(1,2,3);return{version:1,id:crypto.randomUUID(),regionId:'body',phase:'chosen',expected:{schemaVersion:'hcd.extension/1',instanceId:'x_'+'a'.repeat(32),type:'test.file',version:1,display:'inline',data:{},fallback:{text:'File'}},resource:{key:'file',name:'file.bin',mediaType:'application/octet-stream',hash:await nodeResourceHash(bytes),byteLength:3},bytes}}
const contexts=[{name:'semantic',open:()=>NodeResourceJournal.openEditor('hcd-local-draft-v1-'+'a'.repeat(64)+'-2-structure3-nodefiles1',structuralProtocol,new IDBFactory())},{name:'inline',open:()=>NodeResourceJournal.openEditor('hcd-local-draft-v1-'+'b'.repeat(64)+'-2-inlinecontainers1-nodefiles1',inlineProtocol,new IDBFactory())}]
for(const context of contexts){
 test(context.name+' explicit repair replaces only the reviewed corrupt bytes and normal import deduplicates',async()=>{
  const journal=await context.open(),replacement=await file(),original={...replacement,bytes:Uint8Array.of(4,5,6)}
  try{await journal.putNodeResource(original);assert.equal(await journal.repairNodeResources([{original,replacement}],()=>{}),1);assert.deepEqual(await journal.pendingNodeResources(),[replacement]);assert.equal(await journal.importNodeResources([replacement]),0);assert.deepEqual(await journal.pendingNodeResources(),[replacement])}finally{await journal.close()}
 })
 test(context.name+' repair rejects altered metadata, good originals and bad replacements without writing',async()=>{
  const journal=await context.open(),replacement=await file(),original={...replacement,bytes:Uint8Array.of(4,5,6)}
  try{await journal.putNodeResource(original)
   await assert.rejects(journal.repairNodeResources([{original,replacement:{...replacement,resource:{...replacement.resource,name:'other.bin'}}}],()=>{}),/repair-changed/)
   await assert.rejects(journal.repairNodeResources([{original:replacement,replacement}],()=>{}),/repair-changed/)
   await assert.rejects(journal.repairNodeResources([{original,replacement:{...replacement,bytes:Uint8Array.of(7,8,9)}}],()=>{}),/integrity/)
   assert.deepEqual(await journal.pendingNodeResources(),[original])
  }finally{await journal.close()}
 })
 test(context.name+' one changed task rejects the entire repair batch and cannot revive a cancelled selection',async()=>{
  const journal=await context.open(),one=await file(),two=await file(),first={...one,bytes:Uint8Array.of(4,5,6)},second={...two,bytes:Uint8Array.of(7,8,9)}
  try{await journal.putNodeResource(first);await journal.putNodeResource(second);await journal.finishNodeResource(second.id,'cancelled');await assert.rejects(journal.repairNodeResources([{original:first,replacement:one},{original:second,replacement:two}],()=>{}));assert.deepEqual(await journal.pendingNodeResources(),[first]);assert.equal(await journal.importNodeResources([two]),0)}finally{await journal.close()}
 })
}
test('a task phase change and a final transaction guard both prevent repair',async()=>{
 const journal=await contexts[0].open(),replacement=await file(),original={...replacement,bytes:Uint8Array.of(4,5,6)}
 try{await journal.putNodeResource(original);const staged=await journal.stageNodeResource(original);await assert.rejects(journal.repairNodeResources([{original,replacement}],()=>{}),/repair-changed/);let calls=0;await assert.rejects(journal.repairNodeResources([{original:staged,replacement}],()=>{if(++calls===2)throw Error('revoked at commit')}),/revoked/);assert.deepEqual(await journal.pendingNodeResources(),[staged])}finally{await journal.close()}
})
test('cancellation during digest verification wins over the reviewed repair',async()=>{
 const journal=await contexts[0].open(),replacement=await file(),original={...replacement,bytes:Uint8Array.of(4,5,6)},digest=crypto.subtle.digest.bind(crypto.subtle)
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve)
 try{await journal.putNodeResource(original);crypto.subtle.digest=async(...args)=>{const value=await digest(...args);entered();await gate;return value};const repairing=journal.repairNodeResources([{original,replacement}],()=>{});await started;await journal.finishNodeResource(original.id,'cancelled');release();await assert.rejects(repairing);assert.deepEqual(await journal.pendingNodeResources(),[])}finally{release();crypto.subtle.digest=digest;await journal.close()}
})
async function review(){const current=new Y.Doc(),pending=await file(),value={candidate:{pendingFiles:[pending]},packetHash:'c'.repeat(64),stamp:await recoveryHash(Y.encodeStateAsUpdate(current))} as unknown as RecoveryTransferReview;return{current,value}}
test('a verified recovery plan offers only damaged same-packet tasks and repairs without applying document state',async()=>{
 const journal=await contexts[0].open(),{current,value}=await review(),[replacement]=await recoveryFiles(value),original={...replacement,bytes:Uint8Array.of(4,5,6)},before=Y.encodeStateAsUpdate(current),context={current,signal:new AbortController().signal,canWrite:()=>true,authorize:async()=>{}}
 try{await journal.putNodeResource(original);const plan=await reviewRecoveryFileRepair(value,{...context,pendingFiles:()=>journal.pendingNodeResources()});assert.equal(plan.items.length,1);assert.equal(await applyRecoveryFileRepair(plan,{...context,repairFiles:(items,guard)=>journal.repairNodeResources(items,guard)}),1);assert.deepEqual(Y.encodeStateAsUpdate(current),before);assert.deepEqual(await journal.pendingNodeResources(),[replacement]);await assert.rejects(reviewRecoveryFileRepair(value,{...context,pendingFiles:()=>journal.pendingNodeResources()}),/RepairChanged/)}finally{current.destroy();await journal.close()}
})
test('permission loss or peer input during confirmed repair cannot change device bytes',async()=>{
 const journal=await contexts[0].open(),{current,value}=await review(),[replacement]=await recoveryFiles(value),original={...replacement,bytes:Uint8Array.of(4,5,6)},context={current,signal:new AbortController().signal,canWrite:()=>true,authorize:async()=>{}}
 try{await journal.putNodeResource(original);const plan=await reviewRecoveryFileRepair(value,{...context,pendingFiles:()=>journal.pendingNodeResources()});let allowed=true
  await assert.rejects(applyRecoveryFileRepair(plan,{...context,canWrite:()=>allowed,authorize:async()=>{allowed=false},repairFiles:async()=>assert.fail('must not reach storage')}),/ReadOnly/)
  await assert.rejects(applyRecoveryFileRepair(plan,{...context,repairFiles:async(items,guard)=>{current.getText('peer').insert(0,'new input');return journal.repairNodeResources(items,guard)}}),/RepairUncertain/)
  assert.deepEqual(await journal.pendingNodeResources(),[original]);assert.equal(current.getText('peer').toString(),'new input')
 }finally{current.destroy();await journal.close()}
})
test('a lost post-commit notification reports uncertainty while retaining the correct repaired task',async()=>{
 const journal=await contexts[0].open(),{current,value}=await review(),[replacement]=await recoveryFiles(value),original={...replacement,bytes:Uint8Array.of(4,5,6)},context={current,signal:new AbortController().signal,canWrite:()=>true,authorize:async()=>{}}
 try{await journal.putNodeResource(original);const plan=await reviewRecoveryFileRepair(value,{...context,pendingFiles:()=>journal.pendingNodeResources()});await assert.rejects(applyRecoveryFileRepair(plan,{...context,repairFiles:async(items,guard)=>{await journal.repairNodeResources(items,guard);throw Error('notification failed')}}),/RepairUncertain/);assert.deepEqual(await journal.pendingNodeResources(),[replacement]);assert.equal(await journal.importNodeResources([replacement]),0)}finally{current.destroy();await journal.close()}
})
test('integrity classification follows bounded causes without treating unknown errors as damage',()=>{
 assert.equal(recoveryFileIntegrityError(Error('recoveryArchiveFilesRetained',{cause:Error('word-node-resource-integrity')})),true)
 assert.equal(recoveryFileIntegrityError(Error('network')),false);const cyclic=Error('unknown');cyclic.cause=cyclic;assert.equal(recoveryFileIntegrityError(cyclic),false)
})
