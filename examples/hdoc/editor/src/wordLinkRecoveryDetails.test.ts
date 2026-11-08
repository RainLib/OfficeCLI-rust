import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {wordLinkFixture,linkId} from './wordLinkTestFixture.ts'
import {wordLinkRecoveryDetails} from './wordLinkRecoveryDetails.ts'
import {WordTopologyChange} from './WordTopologyChange.tsx'
import {I18nProvider} from './i18n.tsx'

test('signed topology identity recognizes prepared, acknowledged and immediately promoted links only',async()=>{
 const f=await wordLinkFixture();try{
  await assert.rejects(f.journal.topologyRecoveryIdentity(),/pending-unresolved/)
  const prepared=await f.journal.prepareLink(f.pending,f.tip,()=>{}),pending=await f.journal.topologyRecoveryIdentity()
  assert.equal(pending.kind,'link');assert.equal(pending.status,'pending');assert.equal(pending.transactionId,f.pending.request.transactionId);assert.deepEqual(pending.initiator,f.pending.request.actor)
  assert.deepEqual(pending.details,{kind:'link',layoutHash:f.pending.request.link.baseLayoutHash,link:f.pending.request.link})
  await assert.rejects(f.journal.topologyRecoveryIdentity('0'.repeat(32)),/pending-unresolved/)
  const acknowledged=await f.journal.acknowledgeLink(f.record,{revision:1,rootHash:f.base.rootHash},f.previous,f.next,prepared.tip,()=>{},async update=>f.sign(update,prepared.tip))
  assert.equal((await f.journal.topologyRecoveryIdentity()).status,'confirmed')
  const promoted=await f.journal.promoteLinkAcknowledgement(acknowledged.tip,()=>{});assert.equal((await f.journal.topologyRecoveryIdentity(f.pending.request.transactionId)).status,'promoted')
  await f.journal.save(promoted.capsule,promoted.tip);await assert.rejects(f.journal.topologyRecoveryIdentity(f.pending.request.transactionId),/pending-unresolved/)
 }finally{await f.close()}
})
test('link review distinguishes inherited, empty and visually identical binding changes and pages every affected section',async()=>{
 const f=await wordLinkFixture();try{
  const link=f.pending.request.link,nonce=f.pending.request.transactionId,layout=structuredClone(f.previous.flowLayout),before=structuredClone(layout)
  const details=wordLinkRecoveryDetails(layout,link,nonce,0);assert.equal(details.total,2);assert.deepEqual(details.changes.map(row=>[row.section,row.sourceSection,row.contentChanged,row.retained]),[[2,1,true,true],[3,1,true,true]]);assert.deepEqual(layout,before)
  delete layout.sections[0].headers.default;assert.equal(wordLinkRecoveryDetails(layout,link,nonce,0).changes[0].sourceSection,null)
  layout.sections[0].headers.default=link.expectedDirectStoryId;const same=wordLinkRecoveryDetails(layout,link,nonce,0);assert.equal(same.total,1);assert.equal(same.changes[0].contentChanged,false)
  const many=structuredClone(before);many.sections=Array.from({length:45},(_,i)=>({...structuredClone(before.sections[Math.min(i,2)]),id:linkId(1000+i)}));const selection={...link,sectionId:many.sections[1].id}
  assert.equal(wordLinkRecoveryDetails(many,selection,nonce,0).total,44);assert.equal(wordLinkRecoveryDetails(many,selection,nonce,20).changes.length,20);assert.equal(wordLinkRecoveryDetails(many,selection,nonce,40).changes.length,4)
  for(const offset of [-1,1,60])assert.throws(()=>wordLinkRecoveryDetails(many,selection,nonce,offset),/offset-invalid/)
  assert.throws(()=>wordLinkRecoveryDetails(before,{...link,expectedDirectStoryId:linkId(4)},nonce,0),/review-changed/)
 }finally{await f.close()}
})
test('link review UI names the source and retained content rather than claiming an independent copy',()=>{
 const change={operation:'link' as const,section:2,kind:'header' as const,variant:'even' as const,sourceSection:1,contentChanged:true,retained:true as const}
 const render=(sourceSection:number|null)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordTopologyChange,{change:{...change,sourceSection}})}))
 const html=render(1);assert.match(html,/第 2 节/);assert.match(html,/第 1 节继承/);assert.match(html,/原独立内容仍保留/);assert.doesNotMatch(html,/复制继承|创建独立/)
 assert.match(render(null),/当前可见区域将为空/)
})
